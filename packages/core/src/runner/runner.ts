import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import { JSONPath } from "jsonpath-plus";
import { monotonicFactory } from "ulid";

/** runs 落盘文件名 ID：进程内单调递增，同毫秒多次运行不重名。 */
const nextRunFileId = monotonicFactory();
import { envChain, mergedEnvVars } from "../domain/envChain.js";
import type { ApiDefinition, Collection, Environment, Project, TestCase, Workspace } from "../domain/model.js";
import { createVariableResolver, type VariableResolver } from "../variables/resolver.js";
import type { EventBus } from "../events/bus.js";
import type { PluginRegistry } from "../plugin/registry.js";
import type { ExecutableRequest, ExecutionResponse, PmApi, ScriptEngine } from "../plugin/types.js";
import type { CaseOutcome, RunResult } from "../report/types.js";

export interface RunnerOptions {
  runsDir?: string;
  runtimeBridge?: {
    /** 读取外部携带的运行时变量（进入本 run 前注入 persisted 层）。 */
    get(): Record<string, string>;
    /** 本 run 结束后接收本次累计提取的运行时变量（仅脚本 pm.variables.set 写过的键）；外部携带者应做加法式合并。 */
    set(vars: Record<string, string>): void;
  };
}

export class CollectionRunner {
  constructor(private deps: {
    registry: PluginRegistry;
    bus: EventBus;
    timeouts: { connectTimeoutMs: number; totalTimeoutMs: number };
    failFast: boolean;
  }) {}

  async run(collection: Collection, env: Environment | undefined, project: Project, workspace: Workspace, opts: RunnerOptions): Promise<RunResult> {
    const startedAt = new Date();
    const chain = env ? envChain(env, project) : [];
    // 环境变量继承（规格 §3.1/§6）：按继承链从根到叶合并各环境变量为一层，子环境同名变量覆盖父环境。
    // 经 mergedEnvVars 统一口径，与工作流条件求值上下文 env 同源。
    const envVars = mergedEnvVars(env, project);
    const resolver = createVariableResolver({
      layers: [envVars, collection.variables, project.variables, workspace.variables],
    });
    const engine = this.deps.registry.getScriptEngine("javascript");
    if (!engine) throw new Error("缺少 javascript 脚本引擎插件");
    // 预留：报告与运行历史可经 this.deps.registry.getStorage() 适配，本任务不消费。

    // 运行级钩子失败极性（规格 §5.2）：beforeRun/afterRun 处理器抛错记入 warnings，不中断运行。
    const warnings: string[] = [];
    try {
      await this.deps.bus.emit("beforeRun", { collectionName: collection.name, envName: env?.name });
    } catch (e) {
      warnings.push(`beforeRun 钩子失败: ${e instanceof Error ? e.message : String(e)}`);
    }

    const outcomes: CaseOutcome[] = [];
    const apis = [...collection.apis, ...collection.folders.flatMap((f) => f.apis)];
    // 脚本经 pm.variables.set 写入的变量跨用例持久（整个 run 生命周期），如「登录→取 token→调业务接口」流转。
    const persisted = new Map<string, string>();
    // 桥回写快照：只在 pm.variables.set 时增长（语义 =「本次运行累计提取的变量」），run 结束整体写回外部桥。
    const persistedSnapshot: Record<string, string> = {};
    // 运行时桥（工作流节点间传值基座）：进入本 run 前把外部携带变量注入持久层与运行时层——
    // 注入 persisted 使其与脚本提取值同语义：经每用例 clearRuntime 重放存活，不被运行时层清空冲掉。
    const carried = opts.runtimeBridge?.get() ?? {};
    for (const [k, v] of Object.entries(carried)) {
      persisted.set(k, v);
      resolver.setRuntime(k, v);
    }
    if (collection.scripts?.pre) engine.run(collection.scripts.pre, this.buildContext(resolver, envVars, undefined, undefined, persisted, persistedSnapshot));

    outer:
    for (const api of apis) {
      const applicable = api.cases.filter((c) => c.scope === "base" || chain.includes(c.scope));
      // 规格 §6：同 ID 用例仅执行环境版本（覆盖而非重复执行）；
      // 同 ID 出现多个环境版本时继承链更近者优先（chain 靠前者更具体），base 视为最远。
      const scopeRank = (scope: string): number => {
        const i = chain.indexOf(scope);
        return i === -1 ? Number.MAX_SAFE_INTEGER : i;
      };
      const byId = new Map<string, TestCase>();
      for (const c of applicable) {
        const prev = byId.get(c.id);
        if (!prev || scopeRank(c.scope) < scopeRank(prev.scope)) byId.set(c.id, c);
      }
      for (const tc of byId.values()) {
        // 数据源读取/解析失败折进当用例 outcome，不中断整轮（与单用例隔离语义一致）。
        let rows: Array<Record<string, string> | undefined>;
        try {
          rows = this.expandDataRows(tc);
        } catch (e) {
          outcomes.push({
            apiId: api.id, apiName: api.name, caseId: tc.id, caseName: tc.name,
            passed: false, durationMs: 0, assertions: [],
            error: `数据源读取失败: ${e instanceof Error ? e.message : String(e)}`,
          });
          if (this.deps.failFast) break outer;
          continue;
        }
        for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
          const outcome = await this.runCase(api, tc, rows[rowIndex], rowIndex, rows.length > 1, resolver, envVars, engine, persisted, persistedSnapshot);
          outcomes.push(outcome);
          if (!outcome.passed && this.deps.failFast) break outer;
        }
      }
    }

    const result: RunResult = {
      collectionId: collection.id, collectionName: collection.name, envName: env?.name,
      startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
      total: outcomes.length, passed: outcomes.filter((o) => o.passed).length,
      failed: outcomes.filter((o) => !o.passed).length, cases: outcomes,
    };
    if (warnings.length > 0) result.warnings = warnings;
    // afterRun 先于落盘触发：钩子失败折进的 warnings 一并写入落盘 JSON（报告渲染仍在 run() 返回后，原始 JSON 先行落盘的顺序不变）。
    try {
      await this.deps.bus.emit("afterRun", { total: result.total, passed: result.passed, failed: result.failed, result });
    } catch (e) {
      (result.warnings ??= []).push(`afterRun 钩子失败: ${e instanceof Error ? e.message : String(e)}`);
    }
    // 运行时桥回写（写盘之前）：本次累计提取的变量交还外部携带者，下一节点 run 经 get() 取用。
    opts.runtimeBridge?.set({ ...persistedSnapshot });
    // 原始结果 JSON 先行落盘（规格 §8：报告失败不影响结果保存）；
    // 落盘失败降级为告警，不中断 run() 返回，调用方仍拿到完整 RunResult。
    if (opts.runsDir) {
      try {
        mkdirSync(opts.runsDir, { recursive: true });
        writeFileSync(join(opts.runsDir, `run-${nextRunFileId()}.json`), JSON.stringify(result, null, 2));
      } catch (e) {
        console.warn(`运行结果落盘失败（${opts.runsDir}）: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return result;
  }

  /** 数据驱动逐行展开；无数据源或空数据按单行处理。 */
  private expandDataRows(tc: TestCase): Array<Record<string, string> | undefined> {
    if (!tc.dataDriver) return [undefined];
    const raw = readFileSync(tc.dataDriver.sourcePath, "utf8");
    const records: Array<Record<string, string>> =
      tc.dataDriver.format === "csv"
        ? parseCsv(raw, { columns: true, skip_empty_lines: true })
        : JSON.parse(raw);
    return records.length > 0 ? records : [undefined];
  }

  private async runCase(
    api: ApiDefinition, tc: TestCase,
    row: Record<string, string> | undefined, rowIndex: number, isDataDriven: boolean,
    resolver: VariableResolver, envVars: Record<string, string>,
    engine: ScriptEngine, persisted: Map<string, string>,
    persistedSnapshot: Record<string, string>,
  ): Promise<CaseOutcome> {
    const started = performance.now();
    // 每个用例行先清空运行时层，再按 persisted → tc.parameters → 行值 的顺序重放/注入：
    // - persisted：脚本 pm.variables.set 写入的值，跨用例持久（整个 run 生命周期）；
    // - parameters 与行值：仅限当用例/当行，且可遮蔽同名持久值（注入在后）。
    resolver.clearRuntime();
    for (const [k, v] of persisted) resolver.setRuntime(k, v);
    for (const [k, v] of Object.entries(tc.parameters)) resolver.setRuntime(k, v);
    if (row) {
      for (const [k, v] of Object.entries(row)) resolver.setRuntime(k, v);
    }

    const request: ExecutableRequest = {
      method: api.method,
      url: resolver.resolve(api.url),
      headers: Object.fromEntries(api.headers.filter((h) => h.enabled).map((h) => [h.key, resolver.resolve(h.value)])),
      query: api.query.map((q) => ({ ...q, value: resolver.resolve(q.value) })),
      // form 请求体逐项解析变量值（JSON/xml/raw/graphql 走 content 字符串；form 可省略 content）。
      body: api.body
        ? {
            ...api.body,
            content: resolver.resolve(api.body.content ?? ""),
            form: api.body.form?.map((kv) => ({ ...kv, value: resolver.resolve(kv.value) })),
          }
        : undefined,
      auth: api.auth,
      // M5 D5/D7：协议分发键与 ws 消息模板随请求透传（message 变量解析与 url/body 同管线）；
      // 旧 yaml 无 protocol/message → 请求形状不变（protocolOf 缺省 http），零破坏。
      protocol: api.protocol,
      message: api.message === undefined ? undefined : resolver.resolve(api.message),
    };

    const pmAsserts: Array<{ pass: boolean; message: string }> = [];
    const ctx = this.buildContext(resolver, envVars, request, pmAsserts, persisted, persistedSnapshot);

    // 脚本超时/异常只捕获为 error 字段，让单个用例失败而不中断集合。
    // 用例级事件（beforeCase/beforeRequest/afterResponse）失败极性相同：归当用例失败（规格 §5.2）。
    let error: string | undefined;
    try {
      await this.deps.bus.emit("beforeCase", {
        apiName: api.name, caseName: tc.name, apiId: api.id, caseId: tc.id,
        row: isDataDriven ? rowIndex : undefined,
      });
      if (tc.preScript) engine.run(tc.preScript, ctx);
      await this.deps.bus.emit("beforeRequest", { request });

      if (request.auth) {
        const provider = this.deps.registry.getAuth(request.auth.type);
        provider?.apply(request, request.auth, (n) => resolver.get(n));
      }
      const client = this.deps.registry.getProtocol(request);
      if (!client) throw new Error(`无可用协议客户端处理 ${request.url}`);
      const response = await client.execute(request, this.deps.timeouts);
      // 响应快照随事件外发（可选增量）：desktop 调试视图直接取用，无需二次协议调用。
      await this.deps.bus.emit("afterResponse", {
        status: response.status, timeMs: response.timeMs,
        headers: response.headers, bodyText: response.bodyText,
      });

      // 响应回填同一 pm 对象：后置脚本与断言评估共享（含 json 缓存）。
      ctx.pm.response = this.responseView(response);
      if (tc.postScript) engine.run(tc.postScript, ctx);
    } catch (e) {
      // 归一非 Error 抛出物（如脚本裸 throw 'boom'）：error 字段必须留痕，否则用例可能假通过。
      error = e instanceof Error ? e.message : String(e);
    }

    const assertions = [...this.evaluateAssertions(tc, ctx), ...pmAsserts];
    const passed = error === undefined && assertions.every((a) => a.pass);
    const outcome: CaseOutcome = {
      apiId: api.id, apiName: api.name, caseId: tc.id, caseName: tc.name,
      row: isDataDriven ? rowIndex : undefined,
      passed, durationMs: performance.now() - started,
      assertions, error,
    };
    // afterCase 失败同样归当用例：钩子抛错时把该用例改判失败并留痕。
    try {
      await this.deps.bus.emit("afterCase", {
        apiName: api.name, caseName: tc.name, apiId: api.id, caseId: tc.id,
        passed, row: outcome.row, durationMs: outcome.durationMs, error,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      outcome.passed = false;
      outcome.error = outcome.error ? `${outcome.error}; afterCase 钩子失败: ${msg}` : `afterCase 钩子失败: ${msg}`;
    }
    return outcome;
  }

  private evaluateAssertions(tc: TestCase, ctx: { pm: PmApi }) {
    const response = ctx.pm.response;
    const registry = this.deps.registry;
    return tc.assertions.map((a) => {
      const op = registry.getAssert(a.op);
      if (!op) return { pass: false, message: `未知断言操作符: ${a.op}` };
      let actual: unknown;
      switch (a.target) {
        case "status": actual = response?.status; break;
        case "header": actual = response?.headers[(a.headerName ?? "").toLowerCase()]; break;
        case "responseTime": actual = response?.time; break;
        case "bodyJson": {
          try {
            // pm.response.json() 返回 unknown，收窄为 jsonpath-plus 接受的对象类型；JSON 原始标量运行时同样兼容。
            actual = response
              ? JSONPath({ path: a.path ?? "$", json: response.json() as object })[0]
              : undefined;
          } catch {
            actual = undefined;
          }
          break;
        }
      }
      return op.evaluate(actual, a.expected);
    });
  }

  private responseView(response: ExecutionResponse): NonNullable<PmApi["response"]> {
    let cachedJson: unknown;
    return {
      status: response.status,
      headers: response.headers,
      time: response.timeMs,
      text: () => response.bodyText,
      json: () => (cachedJson ??= JSON.parse(response.bodyText)),
    };
  }

  private buildContext(
    resolver: VariableResolver, envVars: Record<string, string>,
    request?: ExecutableRequest,
    pmAsserts?: Array<{ pass: boolean; message: string }>,
    persisted?: Map<string, string>,
    persistedSnapshot?: Record<string, string>,
  ): { pm: PmApi } {
    const pm: PmApi = {
      variables: {
        get: (n) => resolver.get(n),
        // 脚本写入同时进运行时层与持久表：本用例立即可见，后续用例经 persisted 重放仍可见。
        // 同步写快照（只增不减）：run 结束整体写回 runtimeBridge，供工作流下一节点跨 run 取用。
        set: (n, v) => {
          persisted?.set(n, v);
          if (persistedSnapshot) persistedSnapshot[n] = v;
          resolver.setRuntime(n, v);
        },
      },
      // 环境层读合并后的继承变量（规格 §3.1），而非仅选中环境自身。
      environment: { get: (n) => envVars[n] },
      request: request ?? { method: "GET", url: "", headers: {}, query: [] },
      response: undefined,
      assert: (condition, message) => {
        pmAsserts?.push({ pass: Boolean(condition), message });
      },
    };
    return { pm };
  }
}

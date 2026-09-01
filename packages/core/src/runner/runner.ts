import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import { JSONPath } from "jsonpath-plus";
import { monotonicFactory } from "ulid";

/** runs 落盘文件名 ID：进程内单调递增，同毫秒多次运行不重名。 */
const nextRunFileId = monotonicFactory();
import { envChain } from "../domain/envChain.js";
import type { ApiDefinition, Collection, Environment, Project, TestCase, Workspace } from "../domain/model.js";
import { createVariableResolver, type VariableResolver } from "../variables/resolver.js";
import type { EventBus } from "../events/bus.js";
import type { PluginRegistry } from "../plugin/registry.js";
import type { ExecutableRequest, ExecutionResponse, PmApi, ScriptEngine } from "../plugin/types.js";
import type { CaseOutcome, RunResult } from "../report/types.js";

export interface RunnerOptions { runsDir?: string }

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
    const resolver = createVariableResolver({
      layers: [env?.variables ?? {}, collection.variables, project.variables, workspace.variables],
    });
    const engine = this.deps.registry.getScriptEngine("javascript");
    if (!engine) throw new Error("缺少 javascript 脚本引擎插件");
    // 预留：报告与运行历史可经 this.deps.registry.getStorage() 适配，本任务不消费。

    await this.deps.bus.emit("beforeRun", { collectionName: collection.name, envName: env?.name });

    const outcomes: CaseOutcome[] = [];
    const apis = [...collection.apis, ...collection.folders.flatMap((f) => f.apis)];
    // 脚本经 pm.variables.set 写入的变量跨用例持久（整个 run 生命周期），如「登录→取 token→调业务接口」流转。
    const persisted = new Map<string, string>();
    if (collection.scripts?.pre) engine.run(collection.scripts.pre, this.buildContext(resolver, env, undefined, undefined, persisted));

    outer:
    for (const api of apis) {
      for (const tc of api.cases.filter((c) => c.scope === "base" || chain.includes(c.scope))) {
        const rows = this.expandDataRows(tc);
        for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
          const outcome = await this.runCase(api, tc, rows[rowIndex], rowIndex, rows.length > 1, resolver, env, engine, persisted);
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
    // 原始结果 JSON 先行落盘（规格 §8：报告失败不影响结果保存）
    if (opts.runsDir) {
      mkdirSync(opts.runsDir, { recursive: true });
      writeFileSync(join(opts.runsDir, `run-${nextRunFileId()}.json`), JSON.stringify(result, null, 2));
    }
    await this.deps.bus.emit("afterRun", { total: result.total, passed: result.passed, failed: result.failed });
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
    resolver: VariableResolver, env: Environment | undefined,
    engine: ScriptEngine, persisted: Map<string, string>,
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

    await this.deps.bus.emit("beforeCase", { apiName: api.name, caseName: tc.name, row: isDataDriven ? rowIndex : undefined });

    const request: ExecutableRequest = {
      method: api.method,
      url: resolver.resolve(api.url),
      headers: Object.fromEntries(api.headers.filter((h) => h.enabled).map((h) => [h.key, resolver.resolve(h.value)])),
      query: api.query.map((q) => ({ ...q, value: resolver.resolve(q.value) })),
      body: api.body ? { ...api.body, content: resolver.resolve(api.body.content) } : undefined,
      auth: api.auth,
    };

    const pmAsserts: Array<{ pass: boolean; message: string }> = [];
    const ctx = this.buildContext(resolver, env, request, pmAsserts, persisted);

    // 脚本超时/异常只捕获为 error 字段，让单个用例失败而不中断集合。
    let error: string | undefined;
    try {
      if (tc.preScript) engine.run(tc.preScript, ctx);
      await this.deps.bus.emit("beforeRequest", { request });

      if (request.auth) {
        const provider = this.deps.registry.getAuth(request.auth.type);
        provider?.apply(request, request.auth, (n) => resolver.get(n));
      }
      const client = this.deps.registry.getProtocol(request);
      if (!client) throw new Error(`无可用协议客户端处理 ${request.url}`);
      const response = await client.execute(request, this.deps.timeouts);
      await this.deps.bus.emit("afterResponse", { status: response.status, timeMs: response.timeMs });

      // 响应回填同一 pm 对象：后置脚本与断言评估共享（含 json 缓存）。
      ctx.pm.response = this.responseView(response);
      if (tc.postScript) engine.run(tc.postScript, ctx);
    } catch (e) {
      error = (e as Error).message;
    }

    const assertions = [...this.evaluateAssertions(tc, ctx), ...pmAsserts];
    const passed = error === undefined && assertions.every((a) => a.pass);
    const outcome: CaseOutcome = {
      apiId: api.id, apiName: api.name, caseId: tc.id, caseName: tc.name,
      row: isDataDriven ? rowIndex : undefined,
      passed, durationMs: performance.now() - started,
      assertions, error,
    };
    await this.deps.bus.emit("afterCase", { apiName: api.name, caseName: tc.name, passed });
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
    resolver: VariableResolver, env: Environment | undefined,
    request?: ExecutableRequest,
    pmAsserts?: Array<{ pass: boolean; message: string }>,
    persisted?: Map<string, string>,
  ): { pm: PmApi } {
    const pm: PmApi = {
      variables: {
        get: (n) => resolver.get(n),
        // 脚本写入同时进运行时层与持久表：本用例立即可见，后续用例经 persisted 重放仍可见。
        set: (n, v) => {
          persisted?.set(n, v);
          resolver.setRuntime(n, v);
        },
      },
      environment: { get: (n) => env?.variables[n] },
      request: request ?? { method: "GET", url: "", headers: {}, query: [] },
      response: undefined,
      assert: (condition, message) => {
        pmAsserts?.push({ pass: Boolean(condition), message });
      },
    };
    return { pm };
  }
}

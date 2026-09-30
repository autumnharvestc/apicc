import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import { monotonicFactory } from "ulid";

/** runs 落盘文件名 ID：进程内单调递增，同毫秒多次运行不重名。 */
const nextRunFileId = monotonicFactory();
import { envChain, mergedEnvVars } from "../domain/envChain.js";
import type { ApiDefinition, Collection, Environment, Folder, Operation, Project, TestCase, Workspace } from "../domain/model.js";
import { createVariableResolver, type VariableResolver } from "../variables/resolver.js";
import type { EventBus } from "../events/bus.js";
import type { PluginRegistry } from "../plugin/registry.js";
import type { PmApi, ScriptEngine } from "../plugin/types.js";
import type { CaseOutcome, RunResult } from "../report/types.js";
import { executeCase } from "./caseExecutor.js";

/** Container-level failure that preserves all case rows completed before the throw. */
export class CollectionRunError extends Error {
  constructor(
    message: string,
    public readonly partialResult: RunResult,
    public readonly failureKind: CaseOutcome["failureKind"] = "script",
  ) {
    super(message);
    this.name = "CollectionRunError";
  }
}

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
    // M9-B：环境按模块设置的前置 URL 注入为内置变量 baseUrl（{{baseUrl}} 模板可用；
    // 相对 URL 自动拼接由 runCase 内 withBaseUrl 完成）。
    // M10：变量链收敛为 环境 > 模块 > 全局变量（= project.variables，两层来源合一）；
    // workspace 级变量层与 globals.variables 弃用。全局参数（query/header/cookie/body）
    // 归属 project.globals，由 runCase 合并（请求同名项优先）。
    const globals = project.globals ?? { query: [], headers: [], cookies: [], body: [] };
    const baseUrl = env?.baseUrls?.[collection.id];
    const envVars = { ...mergedEnvVars(env, project), ...(baseUrl ? { baseUrl } : {}) };
    const resolver = createVariableResolver({
      layers: [envVars, collection.variables, project.variables],
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
    // M10 操作执行：run 级上下文（无请求）；容器前置操作自上而下、后置操作自下而上。
    const runLevelCtx = () => this.buildContext(resolver, envVars, undefined, undefined, persisted, persistedSnapshot);
    // 旧 scripts 字段为读兼容遗留（loader 归一后内存模型不再携带；直接构造容器直调 run 的
    // 调用方仍可能携带——legacy 优先于操作列表执行，顺序确定）。
    const runLegacyOrOps = (legacy: string | undefined, ops: Operation[] | undefined): void => {
      if (legacy) engine.run(legacy, runLevelCtx());
      for (const op of ops ?? []) {
        if (op.type === "script") engine.run(op.content, runLevelCtx());
      }
    };

    // failFast 停止标记：递归遍历中处处检查（替代原 label break，文件夹嵌套后无法单层 break）。
    const state = { stopped: false };

    const partialResult = (): RunResult => ({
      collectionId: collection.id, collectionName: collection.name, envName: env?.name,
      startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(),
      total: outcomes.length, passed: outcomes.filter((o) => o.passed).length,
      failed: outcomes.filter((o) => !o.passed).length, cases: [...outcomes],
      ...(warnings.length > 0 ? { warnings: [...warnings] } : {}),
    });

    /** 单接口的用例去重/数据驱动/failFast（原 apis 平铺循环体，逻辑不变）。 */
    const runApi = async (api: ApiDefinition): Promise<void> => {
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
        if (state.stopped) return;
        // 数据源读取/解析失败折进当用例 outcome，不中断整轮（与单用例隔离语义一致）。
        let rows: Array<Record<string, string> | undefined>;
        try {
          rows = this.expandDataRows(tc);
        } catch (e) {
          outcomes.push({
            apiId: api.id, apiName: api.name, caseId: tc.id, caseName: tc.name,
            passed: false, durationMs: 0, assertions: [],
            error: `数据源读取失败: ${e instanceof Error ? e.message : String(e)}`,
            failureKind: "config",
          });
          if (this.deps.failFast) state.stopped = true;
          continue;
        }
        for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
          const execution = await executeCase({
            api, testCase: tc, row: rows[rowIndex], rowIndex, isDataDriven: rows.length > 1,
            resolver, envVars, globals, persisted, persistedSnapshot,
          }, {
            resolveProtocol: (request) => this.deps.registry.getProtocol(request),
            resolveAuth: (type) => this.deps.registry.getAuth(type),
            resolveAssert: (op) => this.deps.registry.getAssert(op),
            scriptEngine: engine,
            timeouts: this.deps.timeouts,
            bus: this.deps.bus,
          });
          outcomes.push(execution.outcome);
          if (!execution.outcome.passed && this.deps.failFast) {
            state.stopped = true;
            return;
          }
        }
      }
    };

    /** 容器遍历：直属接口 → 子文件夹递归（前置自上而下、后置自下而上）。 */
    const processFolder = async (folder: Folder): Promise<void> => {
      runLegacyOrOps(undefined, folder.preOperations);
      for (const api of folder.apis) {
        if (state.stopped) return;
        await runApi(api);
      }
      for (const sub of folder.folders ?? []) {
        if (state.stopped) return;
        await processFolder(sub);
      }
      runLegacyOrOps(undefined, folder.postOperations);
    };

    try {
      // 模块级前置（legacy scripts.pre → preOperations）
      runLegacyOrOps(collection.scripts?.pre, collection.preOperations);
      for (const api of collection.apis) {
        if (state.stopped) break;
        await runApi(api);
      }
      for (const folder of collection.folders) {
        if (state.stopped) break;
        await processFolder(folder);
      }
      // 模块级后置（postOperations → legacy scripts.post）
      runLegacyOrOps(collection.scripts?.post, collection.postOperations);
    } catch (e) {
      if (e instanceof CollectionRunError) throw e;
      throw new CollectionRunError(e instanceof Error ? e.message : String(e), partialResult(), "script");
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

  private buildContext(
    resolver: VariableResolver, envVars: Record<string, string>,
    request?: { method: "GET"; url: string; headers: Record<string, string>; query: never[] },
    pmAsserts?: Array<{ pass: boolean; message: string }>,
    persisted?: Map<string, string>, persistedSnapshot?: Record<string, string>,
  ): { pm: PmApi } {
    const pm: PmApi = {
      variables: {
        get: (name) => resolver.get(name),
        set: (name, value) => { persisted?.set(name, value); if (persistedSnapshot) persistedSnapshot[name] = value; resolver.setRuntime(name, value); },
      },
      environment: { get: (name) => envVars[name] },
      request: request ?? { method: "GET", url: "", headers: {}, query: [] },
      response: undefined,
      assert: (condition, message) => pmAsserts?.push({ pass: Boolean(condition), message }),
    };
    return { pm };
  }

}

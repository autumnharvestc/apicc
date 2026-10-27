import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { monotonicFactory } from "ulid";

/** runs 落盘文件名 ID：进程内单调递增，同毫秒多次运行不重名。 */
const nextRunFileId = monotonicFactory();
import type { ApiAsset } from "../contract/model.js";
import type { ContractCollection, ContractFolder } from "../contract/workspace.js";
import type { Operation, ProjectGlobals, TestCase } from "../domain/common.js";
import { resolveRequestSettings, type RequestSettings, type RequestSettingsOverride } from "../request/settings.js";
import type { ProjectSnapshot } from "../assets/snapshot.js";
import type { CredentialBindings } from "../credentials/types.js";
import type { PreparedNetworkRun } from "../network/prepare.js";
import type { DeepReadonly } from "../assets/context.js";
import { resolveExecutionEnvironment, selectEffectiveCases } from "../domain/executionSelection.js";
import { createVariableResolver, type VariableResolver } from "../variables/resolver.js";
import type { EventBus } from "../events/bus.js";
import type { PluginRegistry } from "../plugin/registry.js";
import type { ExecutableRequest, HttpHopObservation, PmApi, ScriptEngine } from "../plugin/types.js";
import type { HttpSession } from "../http/session.js";
import type { CaseOutcome, RunResult } from "../report/types.js";
import { executeCase, prepareCaseExecution, type CaseExecutionResult, type CaseExecutionDeps } from "./caseExecutor.js";
import { createExtractionRuntimeState, type ExtractionRuntimeState } from "../testing/extraction.js";
import { bindPreparedTestData, readPreparedCaseData } from "../testing/data.js";
import type { PreparedTestData } from "../testing/dataModel.js";
import { assertScriptRequirements, collectionScriptRequirements } from "./scriptRequirements.js";

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
  beforeSend?: CaseExecutionDeps["beforeSend"];
  requestGate?: CaseExecutionDeps["requestGate"];
  resolveProtocol?: CaseExecutionDeps["resolveProtocol"];
  resolveSdkProtocol?: CaseExecutionDeps["resolveSdkProtocol"];
  runsDir?: string;
  environmentId?: string;
  /** Restrict a workflow request node to its selected snapshot case and real ancestor path. */
  caseSelection?: { apiId: string; caseId: string; folderIds: readonly string[]; scope?: string };
  /** Execute exactly one row from the captured source, preserving its original index. */
  preparedRowIndex?: number;
  /** Host-owned root for resolving explicit local request file references. */
  workspaceRoot?: string;
  /** Explicit run/session cookie scope; CollectionRunner never creates a process-global jar. */
  httpSession?: HttpSession;
  observeHttp?: (event: HttpHopObservation, identity: {
    caseId: string;
    scope: string;
    rowIndex: number;
    settings: RequestSettings;
    parameters: Readonly<Record<string, string>>;
  }) => void | Promise<void>;
  /** Actual executeCase response and real row context for consumers that need legacy protocol observations. */
  observeCaseExecution?: (execution: CaseExecutionResult, identity: {
    apiId: string;
    apiName: string;
    caseId: string;
    caseName: string;
    scope: string;
    rowIndex: number;
    settings: RequestSettings;
    parameters: Readonly<Record<string, string>>;
  }) => void | Promise<void>;
  runtimeBridge?: {
    /** 读取外部携带的运行时变量（进入本 run 前注入 persisted 层）。 */
    get(): Record<string, string>;
    /** 本 run 结束后接收本次累计提取的运行时变量（仅脚本 pm.variables.set 写过的键）；外部携带者应做加法式合并。 */
    set(vars: Record<string, string>): void;
    /** Workflow-owned extraction layer, including deletions, shared only within this entry. */
    extractions?: ExtractionRuntimeState;
  };
}

export interface ProjectExecutionRun {
  readonly snapshot: ProjectSnapshot;
  readonly credentialBindings: CredentialBindings;
  /** Host-only network state prepared once for this immutable execution. */
  readonly network?: PreparedNetworkRun;
  /** Serializable, immutable source rows captured before dispatch. */
  readonly preparedTestData?: PreparedTestData;
}

/** Pin one caller-selected run wrapper so later wrapper replacement cannot mix revisions. */
export function captureProjectExecutionRun(run: ProjectExecutionRun): ProjectExecutionRun {
  const selectedSnapshot = run.snapshot;
  const snapshot: ProjectSnapshot = Object.freeze({
    project: selectedSnapshot.project,
    context: selectedSnapshot.context,
    definitionRevision: selectedSnapshot.definitionRevision,
  });
  return Object.freeze({
    snapshot,
    credentialBindings: run.credentialBindings,
    ...(run.network === undefined ? {} : { network: run.network }),
    ...(run.preparedTestData === undefined ? {} : { preparedTestData: bindPreparedTestData(snapshot, run.preparedTestData) }),
  });
}

export class CollectionRunner {
  constructor(private deps: {
    registry: PluginRegistry;
    bus: EventBus;
    timeouts: { connectTimeoutMs: number; totalTimeoutMs: number; signal?: AbortSignal };
    requestSettings?: RequestSettingsOverride;
    failFast: boolean;
  }) {}

  async run(run: ProjectExecutionRun, collectionId: string, opts: RunnerOptions = {}): Promise<RunResult> {
    return this.runPrepared(captureProjectExecutionRun(run), collectionId, opts);
  }

  /** Host-owned fixed run: preserves prepared snapshot/data ownership without recapture. */
  async runPrepared(selectedRun: ProjectExecutionRun, collectionId: string, opts: RunnerOptions = {}): Promise<RunResult> {
    const project = selectedRun.snapshot.project;
    const collection = project.collections.find((candidate) => candidate.id === collectionId);
    if (!collection) throw new Error(`配置错误: 项目快照中不存在集合 ${collectionId}`);
    const executionEnvironment = resolveExecutionEnvironment(project, collection.id, opts.environmentId);
    const env = executionEnvironment.environment;
    const startedAt = new Date();
    const chain = executionEnvironment.chain;
    // 环境变量继承（规格 §3.1/§6）：按继承链从根到叶合并各环境变量为一层，子环境同名变量覆盖父环境。
    // 经 mergedEnvVars 统一口径，与工作流条件求值上下文 env 同源。
    // M9-B：环境按模块设置的前置 URL 注入为内置变量 baseUrl（{{baseUrl}} 模板可用；
    // 相对 URL 自动拼接由 runCase 内 withBaseUrl 完成）。
    // M10：变量链收敛为 环境 > 模块 > 全局变量（= project.variables，两层来源合一）；
    // workspace 级变量层与 globals.variables 弃用。全局参数（query/header/cookie/body）
    // 归属 project.globals，由 runCase 合并（请求同名项优先）。
    const globals = mutableGlobals(project.globals);
    const envVars = executionEnvironment.variables;
    const baseUrl = executionEnvironment.baseUrl;
    const resolver = createResolver(envVars, collection.variables, project.variables);
    const engine = this.deps.registry.getScriptEngine("javascript");
    assertScriptRequirements(this.deps.registry, collectionScriptRequirements(selectedRun.snapshot, collectionId, opts));
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
    const extractionState = opts.runtimeBridge?.extractions ?? createExtractionRuntimeState();
    // 运行时桥（工作流节点间传值基座）：进入本 run 前把外部携带变量注入持久层与运行时层——
    // 注入 persisted 使其与脚本提取值同语义：经每用例 clearRuntime 重放存活，不被运行时层清空冲掉。
    const carried = opts.runtimeBridge?.get() ?? {};
    for (const [k, v] of Object.entries(carried)) {
      persisted.set(k, v);
      resolver.setRuntime(k, v);
    }
    // M10 操作执行：run 级上下文（无请求）；容器前置操作自上而下、后置操作自下而上。
    const runOperations = (folders: readonly DeepReadonly<ContractFolder>[], ops: readonly DeepReadonly<Operation>[]): void => {
      const operationResolver = createResolver(envVars, collection.variables, project.variables);
      restorePersisted(operationResolver, persisted);
      for (const operation of ops) {
        for (const [name, binding] of extractionState.bindings) operationResolver.setRuntime(name, binding.text);
        if (operation.type === "script") engine!.run(operation.content, this.buildContext(operationResolver, envVars, undefined, undefined, persisted, persistedSnapshot, extractionState));
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
    const runApi = async (asset: DeepReadonly<ApiAsset>, folders: readonly DeepReadonly<ContractFolder>[]): Promise<void> => {
      const api = asset.contract;
      if (opts.caseSelection && api.id !== opts.caseSelection.apiId) return;
      if (opts.caseSelection && JSON.stringify(folders.map((folder) => folder.id)) !== JSON.stringify(opts.caseSelection.folderIds)) return;
      const applicable = selectEffectiveCases(asset.cases, chain, opts.caseSelection?.caseId).filter((tc) => opts.caseSelection?.scope === undefined || tc.scope === opts.caseSelection.scope);
      for (const tc of applicable) {
        if (state.stopped || this.deps.timeouts.signal?.aborted) return;
        // 数据源读取/解析失败折进当用例 outcome，不中断整轮（与单用例隔离语义一致）。
        let rows: Array<Record<string, string> | undefined>;
        const locator = { collectionId: collection.id, folderIds: folders.map((folder) => folder.id), apiId: api.id, caseId: tc.id, scope: tc.scope };
        let isDataDriven = tc.dataDriver !== undefined;
        try {
          const source = readPreparedCaseData(selectedRun.snapshot, selectedRun.preparedTestData, locator);
          rows = source && source.rows.length > 0 ? source.rows.map((row) => row.values) : [undefined];
          if (opts.preparedRowIndex !== undefined && (!source || !Number.isSafeInteger(opts.preparedRowIndex) || opts.preparedRowIndex < 0 || opts.preparedRowIndex >= source.rows.length)) throw new Error("所选 prepared 数据行不存在");
          isDataDriven ||= source !== undefined;
          for (const warning of source?.diagnostics ?? []) if (!warnings.includes(warning.message)) warnings.push(warning.message);
        } catch (e) {
          outcomes.push({
            apiId: api.id, apiName: api.metadata.name, caseId: tc.id, caseName: tc.name,
            passed: false, durationMs: 0, assertions: [],
            error: `数据源读取失败: ${e instanceof Error ? e.message : String(e)}`,
            failureKind: "config",
            locator, scope: tc.scope,
          });
          if (this.deps.failFast) state.stopped = true;
          continue;
        }
        const caseResolver = createResolver(envVars, collection.variables, project.variables);
        const prepared = prepareCaseExecution(tc, selectedRun.snapshot.context, api.id, (op) => this.deps.registry.getAssert(op));
        const observationSettings = resolveRequestSettings(tc.requestSettingsOverride, this.deps.requestSettings, {
          connectTimeoutMs: this.deps.timeouts.connectTimeoutMs,
          totalTimeoutMs: this.deps.timeouts.totalTimeoutMs,
        });
        const rowIndexes = opts.preparedRowIndex === undefined ? rows.map((_, index) => index) : [opts.preparedRowIndex];
        for (const rowIndex of rowIndexes) {
          if (this.deps.timeouts.signal?.aborted) return;
          const rowParameters = Object.freeze({ ...tc.parameters, ...(rows[rowIndex] ?? {}) });
          const execution = await executeCase({
            asset, assetContext: selectedRun.snapshot.context, credentialBindings: selectedRun.credentialBindings,
          ...(selectedRun.network === undefined ? {} : { network: selectedRun.network }),
            testCase: tc, prepared, extractionState,
            locator,
            row: rows[rowIndex], rowIndex, isDataDriven,
            resolver: caseResolver, envVars, envBaseUrl: baseUrl, globals: mutableGlobals(globals), persisted, persistedSnapshot,
          }, {
            resolveProtocol: opts.resolveProtocol ?? ((request) => this.deps.registry.getProtocol(request)),
            resolveSdkProtocol: opts.resolveSdkProtocol ?? (opts.resolveProtocol ? undefined : (request) => this.deps.registry.getSdkProtocol(request)),
            beforeSend: opts.beforeSend,
            requestGate: opts.requestGate,
            resolveAuth: (type) => this.deps.registry.getAuth(type),
            resolveAssert: (op) => this.deps.registry.getAssert(op),
            scriptEngine: engine,
            timeouts: this.deps.timeouts,
            requestSettings: this.deps.requestSettings,
            workspaceRoot: opts.workspaceRoot,
            httpSession: opts.httpSession,
            observeHttp: opts.observeHttp === undefined ? undefined : (event) => opts.observeHttp!(event, {
              caseId: tc.id,
              scope: tc.scope,
              rowIndex,
              settings: observationSettings,
              parameters: rowParameters,
            }),
            bus: this.deps.bus,
          });
          await opts.observeCaseExecution?.(execution, {
            apiId: api.id,
            apiName: api.metadata.name,
            caseId: tc.id,
            caseName: tc.name,
            scope: tc.scope,
            rowIndex,
            settings: observationSettings,
            parameters: rowParameters,
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
    const processFolder = async (folder: DeepReadonly<ContractFolder>, ancestors: readonly DeepReadonly<ContractFolder>[]): Promise<void> => {
      const chain = [...ancestors, folder];
      if (opts.caseSelection && (
        chain.length > opts.caseSelection.folderIds.length
        || chain.some((item, index) => item.id !== opts.caseSelection!.folderIds[index])
      )) return;
      runOperations(chain, folder.preOperations);
      for (const asset of folder.apis) {
        if (state.stopped) return;
        await runApi(asset, chain);
      }
      for (const sub of folder.folders) {
        if (state.stopped) return;
        await processFolder(sub, chain);
      }
      runOperations(chain, folder.postOperations);
    };

    try {
      // Module preOperations run once before any asset; module postOperations run after descendants.
      runOperations([], collection.preOperations);
      for (const asset of collection.apis) {
        if (state.stopped) break;
        await runApi(asset, []);
      }
      for (const folder of collection.folders) {
        if (state.stopped) break;
        await processFolder(folder, []);
      }
      runOperations([], collection.postOperations);
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

  private buildContext(
    resolver: VariableResolver, envVars: Record<string, string>,
    request?: ExecutableRequest,
    pmAsserts?: Array<{ pass: boolean; message: string }>,
    persisted?: Map<string, string>, persistedSnapshot?: Record<string, string>,
    extractionState?: ExtractionRuntimeState,
  ): { pm: PmApi } {
    const pm: PmApi = {
      variables: {
        get: (name) => resolver.get(name),
        set: (name, value) => { persisted?.set(name, value); if (persistedSnapshot) persistedSnapshot[name] = value; resolver.setRuntime(name, value); extractionState?.bindings.delete(name); },
      },
      environment: { get: (name) => envVars[name] },
      request: request ?? { protocol: "http", method: "GET", url: "", headers: {}, query: [], auth: { kind: "none" } },
      response: undefined,
      assert: (condition, message) => pmAsserts?.push({ pass: Boolean(condition), message }),
    };
    return { pm };
  }

}

function createResolver(
  envVars: Record<string, string>,
  collectionVariables: Readonly<Record<string, string>>,
  projectVariables: Readonly<Record<string, string>>,
): VariableResolver {
  return createVariableResolver({ layers: [envVars, { ...collectionVariables }, { ...projectVariables }] });
}

function restorePersisted(resolver: VariableResolver, persisted: ReadonlyMap<string, string>): void {
  resolver.clearRuntime();
  for (const [name, value] of persisted) resolver.setRuntime(name, value);
}

function mutableGlobals(globals: DeepReadonly<ProjectGlobals>): ProjectGlobals {
  return {
    query: globals.query.map((entry) => ({ ...entry })),
    headers: globals.headers.map((entry) => ({ ...entry })),
    cookies: globals.cookies.map((entry) => ({ ...entry })),
    body: globals.body.map((entry) => ({ ...entry })),
  };
}

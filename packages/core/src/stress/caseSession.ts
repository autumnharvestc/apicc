import type { DeepReadonly, ProjectSnapshot } from "../assets/snapshot.js";
import type { ApiAsset } from "../contract/model.js";
import type { ContractCollection, ContractFolder, ContractProject } from "../contract/workspace.js";
import type { Operation, ProjectGlobals, StressPolicy } from "../domain/common.js";
import type { CredentialBindings } from "../credentials/types.js";
import type { CaseExecutionDeps, CaseExecutionResult } from "../runner/caseExecutor.js";
import { executeCase, prepareCaseExecution } from "../runner/caseExecutor.js";
import { createExtractionRuntimeState, type ExtractionRuntimeState } from "../testing/extraction.js";
import { readPreparedCaseData } from "../testing/data.js";
import { captureProjectExecutionRun, type ProjectExecutionRun } from "../runner/runner.js";
import { resolveExecutionEnvironment, selectEffectiveCases } from "../domain/executionSelection.js";
import type { ManagedProtocolClient } from "../http/client.js";
import type { ExecutableRequest, PmApi } from "../plugin/types.js";
import { createVariableResolver, type VariableResolver } from "../variables/resolver.js";
import { assertStressTargetAllowed, isLoopbackStressOrigin, normalizeStressPolicy, StressSafetyError } from "./safety.js";
import { createHttpSession } from "../http/session.js";
import type { StressIterationContext, StressMetricEvent, StressVuHostContext, StressVuSession } from "./execution.js";
import type { createExecutionEvidenceCollector } from "../report/evidence.js";
import type { JsonValue } from "../contract/schemaNode.js";

export interface StressWorkerSession {
  /** True only when executeCase uses the supplied run gate for every actual hop. */
  readonly gateManaged?: boolean;
  execute(signal?: AbortSignal): Promise<CaseExecutionResult>;
  close(): Promise<void>;
}

/** A selected case within one immutable project snapshot and its prepared credentials. */
export interface StressCaseTarget {
  run: ProjectExecutionRun;
  collectionId: string;
  apiId: string;
  caseId: string;
  environmentId?: string;
  /** Trusted host has already pinned and validated this run for the whole plan. */
  fixedRun?: true;
}

export interface StressCaseSessionDeps extends Omit<CaseExecutionDeps, "beforeSend"> {
  /** Creates the protocol client owned by this virtual-user session. */
  createManagedClient?: (workerId: number) => ManagedProtocolClient | Promise<ManagedProtocolClient>;
  /** Borrowed from a run/VU owner; this session never closes it. */
  managedClient?: ManagedProtocolClient;
}

type SnapshotContainer = DeepReadonly<ContractCollection | ContractFolder>;
interface LocatedApi {
  asset: DeepReadonly<ApiAsset>;
  collection: DeepReadonly<ContractCollection>;
  containers: SnapshotContainer[];
}

function locateApi(project: DeepReadonly<ContractProject>, collectionId: string, apiId: string): LocatedApi {
  const collection = project.collections.find((candidate) => candidate.id === collectionId);
  if (!collection) throw new Error(`配置错误: 项目快照中不存在集合 ${collectionId}`);
  const matches: LocatedApi[] = [];
  const visit = (folder: DeepReadonly<ContractFolder>, path: SnapshotContainer[]): void => {
    const next = [...path, folder];
    for (const asset of folder.apis) {
      if (asset.contract.id === apiId) matches.push({ asset, collection, containers: [collection, ...next] });
    }
    for (const child of folder.folders) visit(child, next);
  };
  for (const asset of collection.apis) {
    if (asset.contract.id === apiId) matches.push({ asset, collection, containers: [collection] });
  }
  for (const folder of collection.folders) visit(folder, []);
  if (matches.length === 0) throw new Error(`配置错误: 项目快照中未找到接口 ${apiId} 的容器路径`);
  if (matches.length > 1) throw new Error(`配置错误: 项目快照中接口 ${apiId} 匹配多个容器路径`);
  return matches[0]!;
}

function operationContext(
  resolver: VariableResolver,
  envVars: Record<string, string>,
  persisted: Map<string, string>,
  persistedSnapshot: Record<string, string>,
  extractionState: ExtractionRuntimeState,
): { pm: PmApi } {
  const pm: PmApi = {
    variables: {
      get: (name) => resolver.get(name),
      set: (name, value) => { persisted.set(name, value); persistedSnapshot[name] = value; resolver.setRuntime(name, value); extractionState.bindings.delete(name); },
    },
    environment: { get: (name) => envVars[name] },
    request: { protocol: "http", method: "GET", url: "", headers: {}, query: [], auth: { kind: "none" } },
    response: undefined,
    assert: () => {},
  };
  return { pm };
}

function runContainerOperations(
  containers: readonly SnapshotContainer[], phase: "pre" | "post", deps: StressCaseSessionDeps,
  resolver: VariableResolver, envVars: Record<string, string>, persisted: Map<string, string>, persistedSnapshot: Record<string, string>,
  extractionState: ExtractionRuntimeState,
): void {
  const ordered = phase === "pre" ? containers : [...containers].reverse();
  let firstError: unknown;
  let hasError = false;
  const runHook = (hook: () => void): void => {
    if (phase === "pre") { hook(); return; }
    try { hook(); }
    catch (error) { if (!hasError) { hasError = true; firstError = error; } }
  };
  for (const container of ordered) {
    const operations: readonly DeepReadonly<Operation>[] = phase === "pre" ? container.preOperations : container.postOperations;
    for (const operation of operations) {
      if (operation.type === "script") runHook(() => deps.scriptEngine.run(operation.content, operationContext(resolver, envVars, persisted, persistedSnapshot, extractionState)));
    }
  }
  if (hasError) throw firstError;
}

function mutableGlobals(globals: DeepReadonly<ProjectGlobals>): ProjectGlobals {
  return {
    query: globals.query.map((entry) => ({ ...entry })),
    headers: globals.headers.map((entry) => ({ ...entry })),
    cookies: globals.cookies.map((entry) => ({ ...entry })),
    body: globals.body.map((entry) => ({ ...entry })),
  };
}

function mutableStressPolicy(policy: DeepReadonly<StressPolicy>): StressPolicy {
  return {
    ...(policy.trustedOrigins === undefined ? {} : { trustedOrigins: [...policy.trustedOrigins] }),
    ...(policy.deniedOrigins === undefined ? {} : { deniedOrigins: [...policy.deniedOrigins] }),
    ...(policy.maxConcurrency === undefined ? {} : { maxConcurrency: policy.maxConcurrency }),
    ...(policy.maxRps === undefined ? {} : { maxRps: policy.maxRps }),
  };
}

/** Parse the final HTTP(S) URL after scripts/auth and before protocol I/O. */
function parseFinalUrl(url: string, protocol: string): URL | undefined {
  if (protocol === "websocket") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw Object.assign(new Error("HTTP(S) 请求 URL 必须是绝对 HTTP(S) URL"), { caseFailureKind: "config" as const });
  }
  const normalizedProtocol = parsed.protocol.toLowerCase();
  if (normalizedProtocol !== "http:" && normalizedProtocol !== "https:") {
    throw Object.assign(new Error("HTTP(S) 请求 URL 必须是绝对 HTTP(S) URL"), { caseFailureKind: "config" as const });
  }
  return parsed;
}

/**
 * Create one independent virtual-user session over a shared immutable run snapshot.
 * Each call owns resolver, request/plugin objects, persistence, and managed connection.
 */
export function createStressCaseSession(
  target: StressCaseTarget,
  deps: StressCaseSessionDeps,
  options: {
    workerId: number;
    concurrency?: number;
    maxRps?: number;
    confirmedTargetOrigins?: string[];
    authorizeRequest?(request: ExecutableRequest): void | Promise<void>;
    initialInputs?: Readonly<Record<string, string>>;
  },
): StressWorkerSession {
  if (!deps.managedClient && !deps.createManagedClient) throw new Error("Stress session requires a managed client or factory");
  const selectedRun = target.fixedRun ? target.run : captureProjectExecutionRun(target.run);
  const project = selectedRun.snapshot.project;
  const stressPolicy = mutableStressPolicy(project.stressPolicy);
  const location = locateApi(project, target.collectionId, target.apiId);
  const environment = resolveExecutionEnvironment(project, target.collectionId, target.environmentId);
  const testCase = selectEffectiveCases(location.asset.cases, environment.chain, target.caseId)[0];
  if (!testCase) {
    if (!location.asset.cases.some((candidate) => candidate.id === target.caseId)) {
      throw new Error(`配置错误: 接口 ${target.apiId} 中不存在用例 ${target.caseId}`);
    }
    throw new Error(`配置错误: 接口 ${target.apiId} 的用例 ${target.caseId} 不适用于当前环境`);
  }
  const envVars = environment.variables;
  const baseUrl = environment.baseUrl;
  const resolver = createVariableResolver({ layers: [envVars, location.collection.variables, project.variables] });
  const persisted = new Map<string, string>(Object.entries(options.initialInputs ?? {}));
  const persistedSnapshot: Record<string, string> = { ...(options.initialInputs ?? {}) };
  for (const [key, value] of persisted) resolver.setRuntime(key, value);
  const httpSession = deps.httpSession ?? createHttpSession();
  const extractionState = createExtractionRuntimeState();
  const prepared = prepareCaseExecution(testCase, selectedRun.snapshot.context, location.asset.contract.id, deps.resolveAssert);
  const locator = { collectionId: location.collection.id, folderIds: location.containers.slice(1).map((container) => container.id), apiId: location.asset.contract.id, caseId: testCase.id, scope: testCase.scope };
  const source = readPreparedCaseData(selectedRun.snapshot, selectedRun.preparedTestData, locator);
  const rows = source && source.rows.length > 0 ? source.rows.map((row) => row.values) : [undefined];
  let cursor = 0;
  runContainerOperations(location.containers, "pre", deps, resolver, envVars, persisted, persistedSnapshot, extractionState);
  let client: ManagedProtocolClient | undefined;
  const clientPromise = Promise.resolve(deps.managedClient ?? deps.createManagedClient!(options.workerId));
  let closePromise: Promise<void> | undefined;

  const resolveProtocol = (request: ExecutableRequest) => {
    if (request.protocol !== "http") return deps.resolveProtocol(request);
    if (client && client.canHandle(request)) return client;
    return undefined;
  };

  return {
    gateManaged: deps.requestGate !== undefined,
    async execute(signal) {
      client ??= await clientPromise;
      const rowIndex = cursor++ % rows.length;
      let safety: CaseExecutionResult["safety"];
      const executionDeps: CaseExecutionDeps = {
        ...deps,
        httpSession,
        resolveProtocol,
        timeouts: { ...(deps.timeouts ?? { connectTimeoutMs: 10_000, totalTimeoutMs: 30_000 }), signal },
        beforeSend: async (request) => {
          await options.authorizeRequest?.(request);
          const parsedUrl = parseFinalUrl(request.url, request.protocol);
          if (!parsedUrl) return;
          try {
            request.url = parsedUrl.href;
            const decision = assertStressTargetAllowed({
              url: parsedUrl.href,
              confirmedTargetOrigins: options.confirmedTargetOrigins,
              policy: stressPolicy,
              concurrency: options.concurrency ?? 1,
              maxRps: options.maxRps,
            });
            safety = {
              origin: decision.targetOrigin,
              confirmation: decision.confirmation,
              policy: decision.confirmation === "project-policy"
                ? "trusted"
                : (decision.appliedPolicy.maxConcurrency !== undefined || decision.appliedPolicy.maxRps !== undefined ? "explicit-limited" : "none"),
              loopback: decision.loopback,
              appliedPolicy: decision.appliedPolicy,
            };
            deps.requestGate?.recordTarget?.(safety);
          } catch (error) {
            if (error instanceof StressSafetyError && error.targetOrigin) {
              let appliedPolicy: ReturnType<typeof normalizeStressPolicy> | undefined;
              try { appliedPolicy = normalizeStressPolicy(stressPolicy); } catch { /* keep the primary policy error */ }
              safety = {
                origin: error.targetOrigin,
                confirmation: "rejected",
                policy: error.code,
                loopback: isLoopbackStressOrigin(error.targetOrigin),
                ...(appliedPolicy ? { appliedPolicy } : {}),
              };
              deps.requestGate?.recordTarget?.(safety);
            }
            throw error;
          }
        },
      };
      const result = await executeCase({
        asset: location.asset,
        assetContext: selectedRun.snapshot.context,
        credentialBindings: selectedRun.credentialBindings,
        ...(selectedRun.network === undefined ? {} : { network: selectedRun.network }),
        testCase,
        prepared,
        extractionState,
        locator,
        row: rows[rowIndex],
        rowIndex,
        isDataDriven: source !== undefined,
        resolver,
        envVars,
        envBaseUrl: baseUrl,
        globals: mutableGlobals(project.globals),
        persisted,
        persistedSnapshot,
      }, executionDeps);
      if (safety) result.safety = safety;
      return result;
    },
    async close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        let firstError: unknown;
        let hasError = false;
        try { runContainerOperations(location.containers, "post", deps, resolver, envVars, persisted, persistedSnapshot, extractionState); }
        catch (error) { hasError = true; firstError = error; }
        try {
          client ??= await clientPromise;
          if (!deps.managedClient) await client.close();
        } catch (error) { if (!hasError) firstError = error; hasError = true; }
        if (!deps.httpSession) {
          try { await httpSession.close(); }
          catch (error) { if (!hasError) firstError = error; hasError = true; }
        }
        if (hasError) throw firstError;
      })();
      return closePromise;
    },
  };
}

/** Planned case adapter; lifecycle composition remains with the owning host/VU. */
export function createStressCaseVuSession(target: StressCaseTarget, deps: StressCaseSessionDeps,
  options: Omit<Parameters<typeof createStressCaseSession>[2], "initialInputs"> & { host: StressVuHostContext; evidence: ReturnType<typeof createExecutionEvidenceCollector>; initialInputs: Readonly<Record<string, JsonValue>> }): StressVuSession {
  const initialInputs: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.initialInputs)) { if (typeof value !== "string") throw new Error("Case initial inputs must be strings"); initialInputs[key] = value; }
  let current: StressIterationContext | undefined;
  const pendingHops = new Set<number>();
  const observe = (event: StressMetricEvent) => (current?.observe ?? options.host.observe)(event);
  const identity = () => ({ ...(current?.observation ?? options.host.observation)(), stageId: current?.stageId ?? null, vuId: options.host.vuId, ...(current ? { iterationId: current.iterationId } : {}) });
  const session = createStressCaseSession(target, { ...deps, requestGate: options.host.gate,
    async observeHttp(event) {
      if (event.type === "request") { pendingHops.add(event.hopIndex); observe({ kind: "http", ...identity(), started: 1, completed: 0, nodeKey: null }); }
      else if (pendingHops.delete(event.hopIndex)) observe({ kind: "http", ...identity(), started: 0, completed: 1, nodeKey: null });
      await deps.observeHttp?.(event);
    },
  }, { ...options, initialInputs });
  return {
    async execute(context) {
      if (current) throw new Error("Stress case VU cannot execute concurrently");
      current = context;
      try {
        const result = await session.execute(context.signal);
        options.evidence.observe(result, { stressRunId: context.runId, vuId: context.vuId, iterationId: context.iterationId, stageId: context.stageId, rowIndex: result.outcome.row });
        const failureKind = result.outcome.passed ? null : result.failureKind ?? result.outcome.failureKind ?? "config";
        observe({ kind: "case", ...identity(), ok: result.outcome.passed, status: result.response?.status ?? 0,
          requestStarted: result.requestStarted === true, requestCompleted: result.requestCompleted === true, failureKind,
          requestTimeMs: result.requestTimeMs, scriptTimeMs: result.scriptTimeMs, iterationTimeMs: result.iterationTimeMs,
          locator: result.outcome.locator!, nodeKey: null });
        return { state: failureKind === "aborted" ? "aborted" : result.outcome.passed ? "passed" : "failed", durationMs: result.iterationTimeMs };
      } finally { current = undefined; pendingHops.clear(); }
    },
    async close() { await session.close(); },
  };
}

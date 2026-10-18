import { readFileSync } from "node:fs";
import { parse as parseCsv } from "csv-parse/sync";
import type { DeepReadonly, ProjectSnapshot } from "../assets/snapshot.js";
import type { ApiAsset } from "../contract/model.js";
import type { ContractCollection, ContractFolder, ContractProject } from "../contract/workspace.js";
import type { Operation, ProjectGlobals, StressPolicy } from "../domain/common.js";
import type { CredentialBindings } from "../credentials/types.js";
import type { CaseExecutionDeps, CaseExecutionResult } from "../runner/caseExecutor.js";
import { executeCase } from "../runner/caseExecutor.js";
import { captureProjectExecutionRun, type ProjectExecutionRun } from "../runner/runner.js";
import { resolveExecutionEnvironment, selectEffectiveCases } from "../domain/executionSelection.js";
import type { ManagedProtocolClient } from "../http/client.js";
import type { ExecutableRequest, PmApi } from "../plugin/types.js";
import { createVariableResolver, type VariableResolver } from "../variables/resolver.js";
import { assertStressTargetAllowed, isLoopbackStressOrigin, normalizeStressPolicy, StressSafetyError } from "./safety.js";

export interface StressWorkerSession {
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
}

export interface StressCaseSessionDeps extends Omit<CaseExecutionDeps, "beforeSend"> {
  /** Creates the protocol client owned by this virtual-user session. */
  createManagedClient: (workerId: number) => ManagedProtocolClient | Promise<ManagedProtocolClient>;
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
): { pm: PmApi } {
  const pm: PmApi = {
    variables: {
      get: (name) => resolver.get(name),
      set: (name, value) => { persisted.set(name, value); persistedSnapshot[name] = value; resolver.setRuntime(name, value); },
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
      if (operation.type === "script") runHook(() => deps.scriptEngine.run(operation.content, operationContext(resolver, envVars, persisted, persistedSnapshot)));
    }
  }
  if (hasError) throw firstError;
}

function parseDataRows(sourcePath: string, format: "csv" | "json"): Array<Record<string, string> | undefined> {
  const raw = readFileSync(sourcePath, "utf8");
  const records: unknown = format === "csv"
    ? parseCsv(raw, { columns: true, skip_empty_lines: true })
    : JSON.parse(raw);
  if (!Array.isArray(records)) throw new Error("数据源必须是记录数组");
  const rows = records.map((record, index) => {
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      throw new Error(`数据源第 ${index + 1} 行必须是对象`);
    }
    const row: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
      if (typeof value !== "string") throw new Error(`数据源第 ${index + 1} 行字段 ${key} 必须是字符串`);
      row[key] = value;
    }
    return row;
  });
  return rows.length > 0 ? rows : [undefined];
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
  },
): StressWorkerSession {
  const selectedRun = captureProjectExecutionRun(target.run);
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
  const persisted = new Map<string, string>();
  const persistedSnapshot: Record<string, string> = {};
  const rows = testCase.dataDriver
    ? parseDataRows(testCase.dataDriver.sourcePath, testCase.dataDriver.format)
    : [undefined];
  let cursor = 0;
  runContainerOperations(location.containers, "pre", deps, resolver, envVars, persisted, persistedSnapshot);
  let client: ManagedProtocolClient | undefined;
  const clientPromise = Promise.resolve(deps.createManagedClient(options.workerId));
  let closePromise: Promise<void> | undefined;

  const resolveProtocol = (request: ExecutableRequest) => {
    if (request.protocol !== "http") return deps.resolveProtocol(request);
    if (client && client.canHandle(request)) return client;
    return undefined;
  };

  return {
    async execute(signal) {
      client ??= await clientPromise;
      const rowIndex = cursor++ % rows.length;
      let safety: CaseExecutionResult["safety"];
      const executionDeps: CaseExecutionDeps = {
        ...deps,
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
        row: rows[rowIndex],
        rowIndex,
        isDataDriven: rows.length > 1,
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
        try { runContainerOperations(location.containers, "post", deps, resolver, envVars, persisted, persistedSnapshot); }
        catch (error) { hasError = true; firstError = error; }
        try {
          client ??= await clientPromise;
          await client.close();
        } catch (error) { if (!hasError) firstError = error; hasError = true; }
        if (hasError) throw firstError;
      })();
      return closePromise;
    },
  };
}

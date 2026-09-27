import { readFileSync } from "node:fs";
import { parse as parseCsv } from "csv-parse/sync";
import { mergedEnvVars } from "../domain/envChain.js";
import type { ApiDefinition, Collection, Environment, Folder, Project, TestCase, Workspace } from "../domain/model.js";
import type { CaseExecutionDeps, CaseExecutionResult } from "../runner/caseExecutor.js";
import { executeCase } from "../runner/caseExecutor.js";
import type { ManagedProtocolClient } from "../http/client.js";
import type { ExecutableRequest, PmApi } from "../plugin/types.js";
import { createVariableResolver, type VariableResolver } from "../variables/resolver.js";

export interface StressWorkerSession {
  execute(signal?: AbortSignal): Promise<CaseExecutionResult>;
  close(): Promise<void>;
}
export interface StressCaseTarget {
  api: ApiDefinition;
  testCase: TestCase;
  env?: Environment;
  project: Project;
  collection: Collection;
  workspace: Workspace;
  /** Optional outer-to-inner container path; otherwise it is resolved from collection folders. */
  containerChain?: StressCaseContainer[];
}

export type StressCaseContainer = (Collection | Folder) & { variables?: Record<string, string> };

export interface StressCaseSessionDeps extends Omit<CaseExecutionDeps, "beforeSend"> {
  /** Creates the protocol client owned by this virtual-user session. */
  createManagedClient: (workerId: number) => ManagedProtocolClient | Promise<ManagedProtocolClient>;
}

function findContainerChain(collection: Collection, api: ApiDefinition): StressCaseContainer[] {
  const visit = (folders: Folder[], path: StressCaseContainer[]): StressCaseContainer[] | undefined => {
    for (const folder of folders) {
      const next = [...path, folder];
      if (folder.apis.some((candidate) => candidate === api || candidate.id === api.id)) return next;
      const nested = visit(folder.folders ?? [], next);
      if (nested) return nested;
    }
    return undefined;
  };
  return [collection, ...(visit(collection.folders ?? [], []) ?? [])];
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
    request: { method: "GET", url: "", headers: {}, query: [] },
    response: undefined,
    assert: () => {},
  };
  return { pm };
}

function runContainerOperations(
  containers: StressCaseContainer[], phase: "pre" | "post", deps: StressCaseSessionDeps,
  resolver: VariableResolver, envVars: Record<string, string>, persisted: Map<string, string>, persistedSnapshot: Record<string, string>,
): void {
  const ordered = phase === "pre" ? containers : [...containers].reverse();
  for (const container of ordered) {
    const scripts = container === containers[0] && "scripts" in container ? container.scripts : undefined;
    if (phase === "pre" && scripts?.pre) deps.scriptEngine.run(scripts.pre, operationContext(resolver, envVars, persisted, persistedSnapshot));
    for (const operation of phase === "pre" ? container.preOperations ?? [] : container.postOperations ?? []) {
      if (operation.type === "script") deps.scriptEngine.run(operation.content, operationContext(resolver, envVars, persisted, persistedSnapshot));
    }
    if (phase === "post" && scripts?.post) deps.scriptEngine.run(scripts.post, operationContext(resolver, envVars, persisted, persistedSnapshot));
  }
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

function sessionEnv(target: StressCaseTarget): Record<string, string> {
  const envVars = target.env ? mergedEnvVars(target.env, target.project) : {};
  const baseUrl = target.env?.baseUrls?.[target.collection.id];
  return baseUrl ? { ...envVars, baseUrl } : envVars;
}

/**
 * Creates all mutable state used by one stress virtual user. The returned object
 * is deliberately independent from every other session and from CollectionRunner.
 */
export function createStressCaseSession(
  target: StressCaseTarget,
  deps: StressCaseSessionDeps,
  options: { workerId: number; authorizeRequest?(request: ExecutableRequest): void | Promise<void> },
): StressWorkerSession {
  const envVars = sessionEnv(target);
  const suppliedContainers = target.containerChain;
  const containers = suppliedContainers
    ? (suppliedContainers[0]?.id === target.collection.id ? suppliedContainers : [target.collection, ...suppliedContainers])
    : findContainerChain(target.collection, target.api);
  const folderLayers = containers.slice(1).reverse().map((container) => container.variables ?? {});
  const resolver: VariableResolver = createVariableResolver({
    layers: [envVars, ...folderLayers, target.collection.variables, target.project.variables],
  });
  const persisted = new Map<string, string>();
  const persistedSnapshot: Record<string, string> = {};
  // Read and validate at construction time so workers do not discover malformed
  // data half-way through a run.
  const rows = target.testCase.dataDriver
    ? parseDataRows(target.testCase.dataDriver.sourcePath, target.testCase.dataDriver.format)
    : [undefined];
  let cursor = 0;
  runContainerOperations(containers, "pre", deps, resolver, envVars, persisted, persistedSnapshot);
  let client: ManagedProtocolClient | undefined;
  const clientPromise = Promise.resolve(deps.createManagedClient(options.workerId));
  let closePromise: Promise<void> | undefined;

  const resolveProtocol = (request: ExecutableRequest) => {
    if (client && client.canHandle(request)) return client;
    // HTTP is always session-owned. A registry fallback is reserved for WS,
    // SOAP, and explicitly plugin-defined protocol requests.
    if ((request.protocol ?? "http") === "http" || /^https?:\/\//i.test(request.url)) return undefined;
    return deps.resolveProtocol(request);
  };

  return {
    async execute(signal) {
      client ??= await clientPromise;
      const rowIndex = cursor++ % rows.length;
      const executionDeps: CaseExecutionDeps = {
        ...deps,
        resolveProtocol,
        timeouts: { ...(deps.timeouts ?? { connectTimeoutMs: 10_000, totalTimeoutMs: 30_000 }), signal },
        beforeSend: options.authorizeRequest,
      };
      return executeCase({
        api: target.api,
        testCase: target.testCase,
        row: rows[rowIndex],
        rowIndex,
        isDataDriven: rows.length > 1,
        resolver,
        envVars,
        globals: target.project.globals,
        persisted,
        persistedSnapshot,
      }, executionDeps);
    },
    async close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        let firstError: unknown;
        try { runContainerOperations(containers, "post", deps, resolver, envVars, persisted, persistedSnapshot); }
        catch (error) { firstError = error; }
        try {
          client ??= await clientPromise;
          await client.close();
        } catch (error) { firstError ??= error; }
        if (firstError !== undefined) throw firstError;
      })();
      return closePromise;
    },
  };
}

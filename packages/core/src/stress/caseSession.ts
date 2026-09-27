import { readFileSync } from "node:fs";
import { parse as parseCsv } from "csv-parse/sync";
import { mergedEnvVars } from "../domain/envChain.js";
import type { ApiDefinition, Collection, Environment, Project, TestCase, Workspace } from "../domain/model.js";
import type { CaseExecutionDeps, CaseExecutionResult } from "../runner/caseExecutor.js";
import { executeCase } from "../runner/caseExecutor.js";
import type { ManagedProtocolClient } from "../http/client.js";
import type { ExecutableRequest } from "../plugin/types.js";
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
}

export interface StressCaseSessionDeps extends Omit<CaseExecutionDeps, "beforeSend"> {
  /** Creates the protocol client owned by this virtual-user session. */
  createManagedClient?: (workerId: number) => ManagedProtocolClient | Promise<ManagedProtocolClient>;
  /** Alias accepted by integrations that call the factory a protocol client factory. */
  createProtocolClient?: (workerId: number) => ManagedProtocolClient | Promise<ManagedProtocolClient>;
  /** Optional pre-created client, useful for non-HTTP protocol adapters. */
  managedClient?: ManagedProtocolClient;
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
  const resolver: VariableResolver = createVariableResolver({
    layers: [envVars, target.collection.variables, target.project.variables],
  });
  const persisted = new Map<string, string>();
  const persistedSnapshot: Record<string, string> = {};
  // Read and validate at construction time so workers do not discover malformed
  // data half-way through a run.
  const rows = target.testCase.dataDriver
    ? parseDataRows(target.testCase.dataDriver.sourcePath, target.testCase.dataDriver.format)
    : [undefined];
  let cursor = 0;
  let client: ManagedProtocolClient | undefined = deps.managedClient;
  const createClient = deps.createManagedClient ?? deps.createProtocolClient;
  const clientPromise = client
    ? Promise.resolve(client)
    : createClient
      ? Promise.resolve(createClient(options.workerId))
      : Promise.resolve(undefined);
  let closePromise: Promise<void> | undefined;

  const resolveProtocol = (request: ExecutableRequest) => {
    if (client && client.canHandle(request)) return client;
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
        client ??= await clientPromise;
        await client?.close();
      })();
      return closePromise;
    },
  };
}


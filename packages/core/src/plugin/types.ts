import type { KeyValuePair, HttpMethod } from "../domain/common.js";
import type { Workspace } from "../domain/model.js";
import type { RunResult } from "../report/types.js";
import type { WorkspaceLoadState } from "../storage/contractFiles.js";
import type { RuntimeBody } from "../request/body.js";
import type { RuntimeAuth } from "../request/materialize.js";

interface ExecutableRequestCommon {
  url: string;
  headers: Record<string, string>;
  query: KeyValuePair[];
  auth: RuntimeAuth;
}

/** Mutable per-attempt DTO; its protocol-specific fields match the materialized contract union. */
export type ExecutableRequest =
  | (ExecutableRequestCommon & { protocol: "http"; method: HttpMethod; body?: RuntimeBody })
  | (ExecutableRequestCommon & { protocol: "websocket"; message?: string })
  | (ExecutableRequestCommon & { protocol: "soap"; method: "POST"; envelope: string; soapAction?: string });

export interface ExecutionResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  timeMs: number;
}

export interface HttpExecuteOptions {
  connectTimeoutMs: number; // 默认 10000
  totalTimeoutMs: number;   // 默认 30000
  signal?: AbortSignal;
}

export interface ProtocolClient {
  name: string;
  canHandle(request: ExecutableRequest): boolean;
  execute(request: ExecutableRequest, opts: HttpExecuteOptions): Promise<ExecutionResponse>;
}

export interface AuthProvider {
  type: Exclude<RuntimeAuth, { kind: "none" }>["kind"];
  apply(request: ExecutableRequest, auth: Exclude<RuntimeAuth, { kind: "none" }>): void;
}

export interface AssertResult { pass: boolean; message: string }

export interface AssertOperator {
  op: string;
  evaluate(actual: unknown, expected: string | undefined): AssertResult;
}

export interface PmVariables { get(name: string): string | undefined; set(name: string, value: string): void }

export interface PmApi {
  variables: PmVariables;
  environment: { get(name: string): string | undefined };
  request: ExecutableRequest;
  response?: {
    status: number;
    headers: Record<string, string>;
    time: number;
    text(): string;
    json(): unknown;
  };
  assert(condition: boolean, message: string): void;
}

export interface ScriptContext { pm: PmApi }

export interface ScriptEngine {
  language: string;
  /** 同步执行；超时或异常抛错（含 ScriptTimeoutError）。 */
  run(code: string, ctx: ScriptContext): void;
}

export interface Reporter {
  format: string;
  /** 写出报告文件并返回绝对路径。 */
  render(result: RunResult, outDir: string): Promise<string>;
}

export interface ImportedProject {
  project: import("../domain/model.js").Project;
  diagnostics: ImportDiagnostic[];
  warnings: string[];
}

export interface ImportDiagnostic {
  code: string;
  ownerId: string;
  path: string;
  reason: string;
  targetId?: string;
}

export interface Importer {
  name: string;
  detect(fileName: string, content: string): boolean;
  parse(content: string): ImportedProject;
}

export interface LoadProblem { file: string; message: string }

export interface StorageSaveOptions {
  expectedRevision: string;
  deletions: readonly string[];
}

export interface StorageAdapter {
  load(root: string): Promise<WorkspaceLoadState<Workspace>>;
  save(root: string, workspace: Workspace, options: StorageSaveOptions): Promise<{ revision: string }>;
}

export interface PluginContext { registry: PluginRegistryApi }

export interface PluginRegistryApi {
  registerProtocol(client: ProtocolClient): void;
  registerAuth(provider: AuthProvider): void;
  registerAssert(operator: AssertOperator): void;
  registerScriptEngine(engine: ScriptEngine): void;
  registerReporter(reporter: Reporter): void;
  registerImporter(importer: Importer): void;
  registerStorage(adapter: StorageAdapter): void;
}

export interface PluginDefinition {
  name: string;
  version: string;
  setup(ctx: PluginContext): void;
}

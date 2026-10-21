import type { KeyValuePair, HttpMethod } from "../domain/common.js";
import type { Workspace } from "../domain/model.js";
import type { RunResult } from "../report/types.js";
import type { WorkspaceLoadState } from "../storage/contractFiles.js";
import type { RuntimeBody } from "../request/body.js";
import type { RuntimeAuth } from "../request/materialize.js";
import type { CapturedRequestFiles } from "../http/files.js";
import type { HttpSession } from "../http/session.js";
import type { PreparedNetworkRun } from "../network/prepare.js";

interface ExecutableRequestCommon {
  url: string;
  headers: Record<string, string>;
  query: KeyValuePair[];
  auth: RuntimeAuth;
  /** Distinguishes a literal Cookie header from cookie parameters that can merge with the run jar. */
  cookieHeaderMode?: "none" | "explicit" | "parameters";
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
  /** Fully received, decoded bytes. Absent for older protocol plugins. */
  bodyBytes?: Uint8Array;
  textAvailable?: boolean;
  jsonAvailable?: boolean;
  /** Reliable duplicate-preserving header pairs from the HTTP parser. */
  rawHeaders?: readonly (readonly [name: string, value: string])[];
  encodedBytes?: number;
  decodedBytes?: number;
  declaredLength?: number;
}

export interface HttpRequestBodyObservation {
  /** File-content bytes consumed from captured sources, not static file size. */
  fileBytesRead: number;
  /** Encoded body bytes observed by Undici's per-request write callback, not socket-delivery confirmation. */
  transportEncodedBytesWritten: number;
  /** True when Undici reports the request body fully consumed for this hop or chain. */
  complete: boolean;
}

export interface HttpIncompleteResponseObservation {
  status: number;
  headers: Record<string, string>;
  rawHeaders: readonly (readonly [name: string, value: string])[];
  encodedBytes: number;
  decodedBytes: number;
  declaredLength?: number;
  bodyComplete: false;
}

export interface HttpCompleteResponseObservation extends Omit<HttpIncompleteResponseObservation, "bodyComplete"> {
  bodyComplete: true;
  bodyBytes: Uint8Array;
  textAvailable: boolean;
  jsonAvailable: boolean;
  bodyText?: string;
}

/** Metadata captured from the request-scoped file binding; never contains a path or file bytes. */
export interface HttpCapturedFileMetadata {
  entryIndex: number;
  available: boolean;
  capturedFilename?: string;
  capturedSizeBytes?: number;
  effectiveFilename?: string;
}

export type HttpHopObservation =
  | { type: "request"; hopIndex: number; request: ExecutableRequest; url: string; method: string; sessionCookieUsed?: boolean; capturedFiles?: readonly HttpCapturedFileMetadata[] }
  | ({ type: "response"; hopIndex: number; url: string; requestBody: HttpRequestBodyObservation; requestBodyChain: HttpRequestBodyObservation } & HttpCompleteResponseObservation)
  | { type: "failure"; hopIndex: number; url: string; stage: string; code: string; networkStarted: boolean; encodedBytes?: number; decodedBytes?: number; response?: HttpIncompleteResponseObservation; requestBody: HttpRequestBodyObservation; requestBodyChain: HttpRequestBodyObservation };

export interface HttpRuntimeOptions {
  files?: CapturedRequestFiles;
  session?: HttpSession;
  /** Host-only immutable network state prepared once for this run. */
  network?: PreparedNetworkRun;
  /** Called after redirect policy has transformed the next request, before that hop is sent. */
  beforeRedirect?: (request: ExecutableRequest, context: { status: number; from: string; to: string; originChanged: boolean }) => void | Promise<void>;
  /** Receives internal request observations; consumers must sanitize before persistence or IPC. */
  observe?: (event: HttpHopObservation) => void | Promise<void>;
}

export interface HttpExecuteOptions {
  connectTimeoutMs: number; // 默认 10000
  totalTimeoutMs: number;   // 默认 30000
  headersTimeoutMs?: number;
  bodyTimeoutMs?: number;
  followRedirects?: boolean;
  maxRedirects?: number;
  uploadLimitBytes?: number;
  responseLimitBytes?: number;
  signal?: AbortSignal;
  /** Runtime resources and callbacks are separate from pure JSON request settings. */
  runtime?: HttpRuntimeOptions;
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

export interface AssertResult {
  pass: boolean; message: string;
  kind?: "config" | "assertion";
  code?: string;
  differencePath?: string;
  schemaPath?: string;
}
export interface AssertOperatorDescriptor {
  targets?: readonly import("../testing/model.js").ResponseSelector["target"][];
  expectedFormat?: "text" | "pattern" | "integer" | "json" | "jsonArray" | "xpath" | "none";
  expectedRequired?: boolean;
}
export interface AssertEvaluationContext {
  found?: boolean;
  options?: Record<string, import("../contract/schemaNode.js").JsonValue>;
  assets?: import("../assets/context.js").ProjectAssetContextReadView;
  schema?: import("../assets/context.js").DeepReadonly<import("../contract/schemaNode.js").SchemaNode>;
  regex?: import("../assert/regex.js").CompiledRegex;
}

export interface AssertOperator {
  op: string;
  descriptor?: AssertOperatorDescriptor;
  evaluate(actual: unknown, expected: string | undefined, context?: AssertEvaluationContext): AssertResult;
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
    textAvailable?: boolean;
    jsonAvailable?: boolean;
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

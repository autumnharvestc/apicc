import type { AuthSpec, BodyContent, KeyValuePair, HttpMethod, Protocol } from "../domain/model.js";
import type { Workspace } from "../domain/model.js";
import type { RunResult } from "../report/types.js";

export interface ExecutableRequest {
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  query: KeyValuePair[];
  body?: BodyContent;
  auth?: AuthSpec;
  /** 协议显式分发键（M5 D5）：缺省视为 http（旧形状请求零破坏）。 */
  protocol?: Protocol;
  /** websocket 连接后发送的文本帧（变量已解析，D7）；缺省仅连接不等待帧。 */
  message?: string;
}

export interface ExecutionResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  timeMs: number;
}

export interface HttpExecuteOptions {
  connectTimeoutMs: number; // 默认 10000
  totalTimeoutMs: number;   // 默认 30000
}

export interface ProtocolClient {
  name: string;
  canHandle(request: ExecutableRequest): boolean;
  execute(request: ExecutableRequest, opts: HttpExecuteOptions): Promise<ExecutionResponse>;
}

export interface AuthProvider {
  type: AuthSpec["type"];
  apply(request: ExecutableRequest, auth: AuthSpec, getVar: (name: string) => string | undefined): void;
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
  warnings: string[];
}

export interface Importer {
  name: string;
  detect(fileName: string, content: string): boolean;
  parse(content: string): ImportedProject;
}

export interface LoadProblem { file: string; message: string }

export interface StorageAdapter {
  load(root: string): Promise<{ workspace: Workspace; problems: LoadProblem[] }>;
  save(root: string, workspace: Workspace): Promise<void>;
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

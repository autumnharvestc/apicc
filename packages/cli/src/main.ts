import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createExecutionEvidenceCollector, redactExecutionOutput, type EvidenceOutputBoundary } from "@apicc/core";
import { homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePluginPackage } from "./create-plugin.js";
import { createPrivateStressWorkerFactory, createWorkerEvidenceFinalizer } from "./stressWorkerTransport.js";
import {
  ShardOutcomeSchema,
  PreparedTestDataSchema,
  type PreparedTestData,
  CredentialError,
  CurrentStressReportSchema,
  CollectionRunError,
  createAiProvider,
  createProjectSnapshot,
  compileProjectMock,
  startMockServer,
  createHttpSession,
  createFileOAuthProfileStore,
  withOAuthBearerRefLock,
  defaultOAuthPrivateRoot,
  defaultNetworkPrivateRoot,
  createNetworkProfileHost,
  createOAuthProfileHost,
  createOAuthProfileCoordinator,
  createDebugHistoryStore,
  createDebugHistoryOwnerKey,
  defaultDebugHistoryRoot,
  DebugHistoryStoreError,
  DebugInvocationSchema,
  abortedDebugResult,
  failedDebugResult,
  RequestSettingsOverrideSchema,
  ApiRequestSchema,
  prepareDebugExecution,
  runDebugExecution,
  buildDocumentProjection,
  exportOpenapi,
  buildImportMergePlan,
  projectAssetImportDiagnostics,
  normalizeImportDiagnostics,
  ContractProjectSchema,
  DocumentScopeSchema,
  renderDocumentHtml,
  renderDocumentMarkdown,
  renderContractMarkdown,
  loadUserPlugins,
  findProjectApi,
  type AiProviderConfig,
  type ApiAsset,
  type Collection,
  type Environment,
  type ProjectExecutionRun,
  type LoadProblem,
  type PluginLoadEntry,
  type PluginRegistry,
  type Project,
  type OAuthProfileSummary,
  type OAuthPublicResult,
  type SecretRef,
  type ShardFailure,
  type ShardOutcome,
  type ShardResult,
  type SpawnWorker,
  type StressReport,
  type StressThresholds,
  type StressRunner,
  type StressSample,
  type StressWorkerSpecBase,
  type Workspace,
  type Workflow,
  type DocumentScope,
  type ImportMergeAction,
  type ImportMergeItemDecision,
  createHttpClient,
  createSoapClient,
  createStressCaseSession,
  normalizeStressOrigin,
  resolveExecutionEnvironment,
  envChain,
  selectEffectiveCases,
  validateStressRunOptions as validateCoreStressRunOptions,
  StressSafetyError,
  withBaseUrl,
} from "@apicc/core";
import {
  apiAssetsInCollection,
  apiAssetsWithExecutableCases,
  createCredentialHostStore,
  findProjectCredentialRef,
  prepareExecutionRun,
  prepareExecutionRunFromSnapshot,
  credentialScope,
  stableCredentialError,
  type CredentialHostOptions,
} from "./credentials.js";
import type { ExecutionCredentialSelection } from "./credentials.js";
import { createOutputSanitizer } from "./output.js";
import { registerTestingCommands } from "./testing.js";
import {
  assertWorkspaceUsable,
  listApiLocations,
  loadWorkspace,
  locateApi,
  locateCollection,
  locateProject,
  locateWorkflow,
} from "./workspace.js";

function collectOption(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function redactImportOutput(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/(?:[A-Za-z]:\\|\/(?:Users|home|tmp|var|etc)\/)[^\s"'<>]*/g, "[local path]");
}

function projectApis(project: Project, collectionIds: ReadonlySet<string>): Array<Project["collections"][number]["apis"][number]> {
  const result: Array<Project["collections"][number]["apis"][number]> = [];
  const visit = (folder: Project["collections"][number]["folders"][number]): void => {
    result.push(...folder.apis);
    folder.folders.forEach(visit);
  };
  for (const collection of project.collections) {
    if (!collectionIds.has(collection.id)) continue;
    result.push(...collection.apis);
    collection.folders.forEach(visit);
  }
  return result;
}

function sameImportRoute(left: Project["collections"][number]["apis"][number], right: Project["collections"][number]["apis"][number]): boolean {
  const a = left.contract.request;
  const b = right.contract.request;
  if (a.protocol !== b.protocol) return false;
  const methodA = a.protocol === "websocket" ? "WS" : a.method;
  const methodB = b.protocol === "websocket" ? "WS" : b.method;
  const canonical = (path: string) => path.split(/[?#]/, 1)[0]!.replace(/\{[^/{}]+\}/g, "{}").replace(/\/+$/, "") || "/";
  return methodA === methodB && canonical(a.path) === canonical(b.path);
}

function validateStressOriginOption(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error(`allow-target 必须是 HTTP(S) origin: ${value}`); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`allow-target 必须是 HTTP(S) origin: ${value}`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== "" && parsed.pathname !== "/")) {
    throw new Error(`allow-target 必须是无路径/查询/片段/用户信息的 HTTP(S) origin: ${value}`);
  }
  return normalizeStressOrigin(value);
}

function validateStressRunOptions(opts: {
  maxErrorRate?: number;
  maxAssertionFailureRate?: number;
  maxP95Ms?: number;
  minRps?: number;
  maxRps?: number;
  connectionMode?: string;
}): void {
  for (const [name, value] of [["max-error-rate", opts.maxErrorRate], ["max-assertion-failure-rate", opts.maxAssertionFailureRate]] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1)) {
      throw new Error(`${name} 必须是 0 到 1 之间的比例，收到 ${value}`);
    }
  }
  for (const [name, value] of [["max-p95-ms", opts.maxP95Ms], ["min-rps", opts.minRps], ["max-rps", opts.maxRps]] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new Error(`${name} 必须为正数，收到 ${value}`);
    }
  }
  if (opts.connectionMode !== undefined && opts.connectionMode !== "pooled" && opts.connectionMode !== "fresh") {
    throw new Error(`connection-mode 必须为 pooled 或 fresh，收到 ${opts.connectionMode}`);
  }
}

const MAX_SAFE_DURATION_MS = Number.MAX_SAFE_INTEGER;

/** CLI-side termination validation runs before workspace lookup, target resolution, or worker spawn. */
function validateCliStressTermination(opts: {
  concurrency: number;
  iterations?: number;
  duration?: number;
}): number | undefined {
  if (!Number.isSafeInteger(opts.concurrency) || opts.concurrency < 1) {
    throw new Error(`concurrency 必须为正 safe integer，收到 ${opts.concurrency}`);
  }
  if (opts.iterations !== undefined && (!Number.isSafeInteger(opts.iterations) || opts.iterations <= 0)) {
    throw new Error(`iterations 必须为正 safe integer，收到 ${opts.iterations}`);
  }
  if (opts.iterations === undefined && opts.duration === undefined) {
    throw new Error("需要 --iterations 或 --duration");
  }
  if (opts.duration === undefined) return undefined;
  if (!Number.isFinite(opts.duration) || opts.duration <= 0) {
    throw new Error(`duration 必须为有限正数，收到 ${opts.duration}`);
  }
  const durationMs = opts.duration * 1000;
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_SAFE_DURATION_MS) {
    throw new Error(`duration 换算后的毫秒数溢出，收到 ${opts.duration}`);
  }
  return durationMs;
}

/**
 * Resolve the static HTTP(S) target used by run-stress's client probe and
 * policy preflight. WHATWG parsing is deliberately limited to the protocols
 * whose transport is HTTP-owned: explicit websocket/plugin requests retain
 * their URL text, while SOAP still uses the HTTP(S) safety gate but keeps its
 * SOAP protocol selection.
 */
function resolveStaticStressTarget(url: string, protocol?: string): { url: string; origin?: string } {
  if (protocol !== undefined && protocol !== "http" && protocol !== "soap") return { url };
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { url };
    return { url: parsed.href, origin: parsed.origin };
  } catch {
    // Relative/malformed URLs remain visible to the protocol resolver so it
    // can reject them; they must not be misclassified as HTTP(S) targets.
    return { url };
  }
}

/** 从起始目录向上查找 apicc.workspace.yaml。 */
export function findWorkspaceRoot(start: string): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "apicc.workspace.yaml"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * AI 配置解析（M6 D2，裁定⑤）：env 三件套 APICC_AI_BASE_URL/API_KEY/MODEL 齐全时优先，
 * 否则回落用户级 ~/.apicc/ai.json（{"baseUrl","apiKey","model"}）；两者皆缺 → 可读错误指引两种方式。
 * core 只认显式传入的 config；密钥只进 config，永不进日志（裁定⑦，测试断言）。
 */
export function resolveAiConfig(input: { env?: Record<string, string | undefined>; homeDir?: string }): AiProviderConfig {
  const env = input.env ?? process.env;
  const baseUrl = env.APICC_AI_BASE_URL;
  const apiKey = env.APICC_AI_API_KEY;
  const model = env.APICC_AI_MODEL;
  if (baseUrl && apiKey && model) return { baseUrl, apiKey, model };

  const file = join(input.homeDir ?? homedir(), ".apicc", "ai.json");
  if (existsSync(file)) {
    let raw: { baseUrl?: unknown; apiKey?: unknown; model?: unknown };
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as { baseUrl?: unknown; apiKey?: unknown; model?: unknown };
    } catch {
      throw new Error(`AI 配置文件不是合法 JSON: ${file}`);
    }
    if (typeof raw.baseUrl === "string" && raw.baseUrl && typeof raw.apiKey === "string" && raw.apiKey
      && typeof raw.model === "string" && raw.model) {
      return { baseUrl: raw.baseUrl, apiKey: raw.apiKey, model: raw.model };
    }
    throw new Error(`AI 配置文件不完整: ${file}（须含 baseUrl/apiKey/model 字符串字段）`);
  }
  if (baseUrl || apiKey || model) {
    throw new Error("AI 配置不完整：env 三件套须同时设置 APICC_AI_BASE_URL、APICC_AI_API_KEY、APICC_AI_MODEL");
  }
  throw new Error(
    "未找到 AI 配置：可设置环境变量 APICC_AI_BASE_URL、APICC_AI_API_KEY、APICC_AI_MODEL，"
    + '或在 ~/.apicc/ai.json 写入 {"baseUrl":"...","apiKey":"...","model":"..."}',
  );
}

/** Load once, preserve storage diagnostics, and locate solely within the returned UUID tree. */
async function locateApiTarget(registry: PluginRegistry, root: string, apiPath: string) {
  const state = await loadWorkspace(registry, root);
  assertWorkspaceUsable(state);
  return { ...locateApi(state.workspace, apiPath), workspace: state.workspace, loadState: state };
}

/** runCli 可注入依赖：worker 协议/日志通道与默认 SpawnWorker 工厂（测试注入替身即可进程内闭环）。 */
export interface RunCliDeps {
  /** stress-worker 协议行输出通道（默认真实 stdout——协调器按行解析的契约通道，裁定 B）。 */
  workerOut?: (line: string) => void;
  /** stress-worker 人类日志通道（默认 console.error → stderr；stdout 只许末行 JSON）。 */
  workerErr?: (line: string) => void;
  /** Run-private completion seam for injected worker fixtures; never part of a public result. */
  workerFinalizeEvidence?: (markers: readonly string[]) => Promise<readonly string[]>;
  /** 默认 SpawnWorker 工厂（默认本地子进程实现；入参为 shard 超时毫秒，与协调器同值）。 */
  spawnWorkerFactory?: (shardTimeoutMs: number) => SpawnWorker;
  /** AI 配置解析注入：env 快照（裁定⑤；缺省 process.env，测试显式注入保证确定性）。 */
  aiEnv?: Record<string, string | undefined>;
  /** AI 配置解析注入：用户级配置根目录（裁定⑤；缺省 os.homedir()，测试指向临时目录）。 */
  aiHomeDir?: string;
  /** 插件加载注入：用户级目录（清单 <dir>/.apicc/plugins.json；缺省 os.homedir()，测试指向临时目录）。 */
  pluginsHomeDir?: string;
  /** 插件加载注入：false 关闭加载（--no-plugins 之外的编程关闭通道，供嵌入方与测试零扰动）。 */
  loadPlugins?: boolean;
  /** CLI 凭据宿主注入：测试可提供合成值 store；不暴露系统后端装载缝。 */
  secretStore?: import("@apicc/core").SecretStore;
  /** CLI 凭据宿主注入：指定独立 privateRoot，默认 Core 提供的用户级 privateRoot。 */
  credentialPrivateRoot?: string;
  /** CLI OAuth profile/coordinator root; tests and embedded hosts should own this path. */
  oauthPrivateRoot?: string;
  /** CLI network-profile host injection for deterministic tests and embedded hosts. */
  networkPrivateRoot?: string;
  /** Debug history host-root override; tests must point this at a controlled temporary directory. */
  debugHistoryAppDataDirectory?: string;
  /** CLI 凭据保存注入：默认仅从 stdin 读取，永不接受 argv 明文。 */
  secretInput?: () => Promise<string>;
}

export function formatOAuthActionFailure(action: "acquire" | "refresh", result: OAuthPublicResult): string {
  const safeResult = {
    status: result.status,
    ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
    ...(result.expiresAt === undefined ? {} : { expiresAt: result.expiresAt }),
  };
  const guidance = result.status === "reauthorization_required"
    ? "刷新链不可继续，请在桌面端重新授权；不要盲目重试。"
    : result.status === "partial_success"
      ? "部分操作已生效，请检查 OAuth profile 状态后再继续。"
      : "操作失败。";
  return `[${result.errorCode ?? "OAUTH_TOKEN_REQUEST_FAILED"}] OAuth ${action} ${guidance} result=${JSON.stringify(safeResult)}`;
}

function credentialHostOptions(deps: RunCliDeps): CredentialHostOptions {
  return {
    ...(deps.secretStore ? { secretStore: deps.secretStore } : {}),
    ...(deps.credentialPrivateRoot ? { credentialPrivateRoot: deps.credentialPrivateRoot } : {}),
    ...(deps.networkPrivateRoot ? { networkPrivateRoot: deps.networkPrivateRoot } : {}),
    ...(deps.oauthPrivateRoot ? { oauthPrivateRoot: deps.oauthPrivateRoot } : {}),
  };
}

async function withCredentialMutationGuard<T>(
  deps: RunCliDeps,
  scope: ReturnType<typeof credentialScope>,
  ref: SecretRef,
  operation: () => Promise<T>,
): Promise<T> {
  // Injected SecretStores stay isolated unless paired with an explicitly owned OAuth root.
  if (deps.secretStore !== undefined && deps.oauthPrivateRoot === undefined) return operation();
  const privateRoot = deps.oauthPrivateRoot ?? defaultOAuthPrivateRoot();
  const profileStore = createFileOAuthProfileStore({ privateRoot });
  return withOAuthBearerRefLock(privateRoot, scope, ref.id, async () => {
    if (await profileStore.findBearerRegistration(scope, ref.id)) {
      throw new CredentialError("CREDENTIAL_VERSION_CONFLICT", ref.id);
    }
    return operation();
  });
}

function cliAppDataDirectory(): string {
  if (platform() === "win32") return process.env.APPDATA || join(homedir(), "AppData", "Roaming");
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support");
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

function resolveWorkspaceFile(root: string, inputPath: string): string {
  if (!inputPath || isAbsolute(inputPath)) throw new Error("--request 文件必须使用工作区根内的相对路径");
  const candidate = resolve(root, inputPath);
  const canonicalRoot = realpathSync(root);
  const canonicalFile = realpathSync(candidate);
  const rel = relative(canonicalRoot, canonicalFile);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("--request 文件必须位于工作区根目录内");
  }
  return canonicalFile;
}

function parseJsonOption(input: string, label: string): unknown {
  try { return JSON.parse(input) as unknown; }
  catch { throw new Error(`${label} 必须是有效 JSON`); }
}

function parseBooleanOption(input: string): boolean {
  if (input === "true") return true;
  if (input === "false") return false;
  throw new Error("--enabled 只能是 true 或 false");
}

function parsePositiveIntegerOption(input: string, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  const value = Number(input);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} 必须是 1 到 ${maximum} 之间的正整数`);
  }
  return value;
}

function parseExpectedCredentialVersions(input: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("worker 凭据版本描述无效：必须是 JSON 字符串字典");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("worker 凭据版本描述无效：必须是 JSON 字符串字典");
  }
  const versions = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(parsed)) {
    const version = (parsed as Record<string, unknown>)[key];
    if (typeof version !== "string") {
      throw new Error("worker 凭据版本描述无效：每个 own ref 版本都必须是字符串");
    }
    Object.defineProperty(versions, key, {
      value: version, enumerable: true, configurable: true, writable: true,
    });
  }
  return versions;
}

async function readSecretFromStdin(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  }
  return chunks.join("").replace(/\r?\n$/, "");
}

let lastRunFileTime = 0;
let runFileSequence = 0;
function nextRunFileId(): string {
  const now = Date.now();
  if (now > lastRunFileTime) {
    lastRunFileTime = now;
    runFileSequence = 0;
  } else {
    runFileSequence += 1;
  }
  return `${lastRunFileTime.toString(36).padStart(10, "0")}${runFileSequence.toString(36).padStart(4, "0")}`;
}

/** CLI 入口绝对路径（dist/bin.js）：由本模块编译产物位置推导，子进程 worker 与父进程同一份安装。 */
function cliEntryPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "bin.js");
}

/**
 * 从 worker stdout 全文按行从末解析 ShardOutcome（裁定 B①：可导出纯函数，供单测直测）。
 * 末条 JSON 是协议载荷：此前的非 JSON 人类日志可跳过，但协议载荷后的 JSON 日志/非法协议必须严格拒绝。
 */
export function parseShardOutcomeStdout(
  stdout: string,
  ctx: { shardId: string; exitCode?: number | null },
): ShardOutcome {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let value: unknown;
    try {
      value = JSON.parse(lines[i]!);
    } catch {
      // 仅跳过非 JSON 人类日志；一旦遇到 JSON，必须严格验证它。
      continue;
    }
    const parsed = ShardOutcomeSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(`shard ${ctx.shardId} 协议输出无效[protocol_invalid]`);
    }
    const integerExitCode = Number.isInteger(ctx.exitCode) && Number.isFinite(ctx.exitCode);
    if (parsed.data.ok && ctx.exitCode !== 0) {
      throw new Error(`shard ${ctx.shardId} 结果与退出码不一致[protocol_exit_mismatch]：ShardResult 需要退出码 0，实际 ${ctx.exitCode}`);
    }
    if (!parsed.data.ok && (!integerExitCode || ctx.exitCode === 0)) {
      throw new Error(`shard ${ctx.shardId} 结果与退出码不一致[protocol_exit_mismatch]：ShardFailure 需要有限整数非零退出码，实际 ${String(ctx.exitCode)}`);
    }
    return parsed.data;
  }
  throw new Error(
    `shard ${ctx.shardId} 协议输出无效：stdout 末行不是合法 ShardOutcome（退出码 ${ctx.exitCode}）`,
  );
}

/**
 * 默认 SpawnWorker 工厂（D2 MVP 本地子进程 stdio 传输）：spawn node + [bin.js, stress-worker, …]。
 * 裁定 A：自带与协调器同值的超时并 child.kill()——协调器放弃后真实子进程不得残留；kill 后仍按失败 shard 计。
 * 裁定 B：按行从末解析 stdout（parseShardOutcomeStdout 纯函数，防 worker 日志污染 stdout 致协议崩坏）；
 * 私有 IPC 在所有 worker 完成后汇合敏感标记；stderr 仅宿主消耗，不透传未经全局投影的诊断。
 */
const defaultSpawnWorkerFactory = (shardTimeoutMs: number): SpawnWorker => createPrivateStressWorkerFactory(shardTimeoutMs, (spec) => {
    const args = [
      cliEntryPath(), "stress-worker", spec.apiPath,
      "--case", spec.caseId,
      "--concurrency", String(spec.concurrency),
      "--shard-id", spec.shardId,
      "--workspace", spec.workspaceRoot,
      ...(spec.envName !== undefined ? ["--env", spec.envName] : []),
      ...(spec.maxIterations !== undefined ? ["--iterations", String(spec.maxIterations)] : []),
      ...(spec.durationMs !== undefined ? ["--duration", String(spec.durationMs / 1000)] : []),
      ...(spec.maxRps !== undefined ? ["--max-rps", String(spec.maxRps)] : []),
      ...(spec.maxErrorRate !== undefined ? ["--max-error-rate", String(spec.maxErrorRate)] : []),
      ...(spec.maxAssertionFailureRate !== undefined ? ["--max-assertion-failure-rate", String(spec.maxAssertionFailureRate)] : []),
      ...(spec.maxP95Ms !== undefined ? ["--max-p95-ms", String(spec.maxP95Ms)] : []),
      ...(spec.minRps !== undefined ? ["--min-rps", String(spec.minRps)] : []),
      ...(spec.connectionMode !== undefined ? ["--connection-mode", spec.connectionMode] : []),
      ...((spec.confirmedTargetOrigins ?? []).flatMap((origin) => ["--allow-target", origin])),
      "--definition-revision", spec.definitionRevision,
      "--credential-versions", JSON.stringify(spec.credentialVersions),
      "--network-identity", spec.networkIdentity,
    ];
    if (spec.preparedTestData !== undefined) args.push("--prepared-data-stdin");
    return args;
  }, parseShardOutcomeStdout);

/** Prepare one immutable snapshot and the selected API's credentials for stress or its worker. */
async function resolveStressTarget(
  registry: PluginRegistry,
  root: string,
  apiPath: string,
  caseId: string,
  envName: string | undefined,
  credentialOptions: CredentialHostOptions = {},
  expected?: { definitionRevision: string; credentialVersions: Readonly<Record<string, string>>; networkIdentity?: string; preparedTestData?: PreparedTestData },
): Promise<{
  apiPath: string;
  apiId: string;
  api: NonNullable<ReturnType<typeof findProjectApi>>["api"];
  testCase: NonNullable<ReturnType<typeof findProjectApi>>["api"]["cases"][number];
  collection: NonNullable<ReturnType<typeof findProjectApi>>["collection"];
  project: ProjectExecutionRun["snapshot"]["project"];
  workspace: Workspace;
  prepared: Awaited<ReturnType<typeof prepareExecutionRun>>;
  targetOrigin?: string;
  createRunner: (options?: {
    concurrency?: number;
    maxRps?: number;
    confirmedTargetOrigins?: string[];
    connectionMode?: "pooled" | "fresh";
    onSample?: (sample: StressSample) => void;
    finalizeEvidence?: (markers: readonly string[]) => Promise<readonly string[]>;
    onEvidenceMarkers?: (markers: readonly string[]) => void;
    onEvidenceOutputBoundary?: (boundary: EvidenceOutputBoundary) => void;
  }) => StressRunner;
}> {
  const location = await locateApiTarget(registry, root, apiPath);
  const { api, group, project, collection, workspace } = location;
  const env = envName === undefined ? undefined : project.environments.find((candidate) => candidate.name === envName);
  if (envName !== undefined && !env) throw new Error(`未找到环境: ${envName}`);
  const preflightEnvironment = resolveExecutionEnvironment(project, collection.id, env?.id);
  const preflightCase = selectEffectiveCases(api.cases, preflightEnvironment.chain, caseId)[0];
  if (!preflightCase) {
    if (!api.cases.some((candidate) => candidate.id === caseId)) throw new Error(`未找到用例: ${caseId}`);
    throw new Error(`配置错误: 用例 ${caseId} 不适用于当前环境${env ? ` ${env.name}` : ""}`);
  }
  const apiId = api.contract.id;
  const collectionId = collection.id;
  const environmentId = env?.id;
  const prepared = await prepareExecutionRun(workspace, group.id, project, [api], credentialOptions,
    expected?.credentialVersions, expected?.definitionRevision, [{
      collectionId,
      apiId,
      caseId: preflightCase.id,
      scope: preflightCase.scope,
    }], {
      workspaceRoot: root,
      ...(environmentId === undefined ? {} : { environmentId }),
      ...(expected?.networkIdentity === undefined ? {} : { expectedNetworkIdentity: expected.networkIdentity }),
      ...(expected === undefined ? {} : { preparedTestData: expected.preparedTestData ?? null }),
    });
  const preparedProject = prepared.snapshot.project;
  const preparedLocation = findProjectApi(preparedProject, apiId);
  if (!preparedLocation || preparedLocation.collection.id !== collectionId) {
    throw new Error(`配置错误: 项目快照中未找到接口 ${apiId} 的原集合资产`);
  }
  const preparedEnvironment = resolveExecutionEnvironment(preparedProject, collectionId, environmentId);
  const testCase = selectEffectiveCases(preparedLocation.api.cases, preparedEnvironment.chain, caseId)[0];
  if (!testCase) throw new Error(`配置错误: 项目快照中接口 ${apiId} 不存在适用于当前环境的用例 ${caseId}`);
  const preparedApi = preparedLocation.api;
  const preparedCollection = preparedLocation.collection;
  const { StressRunner, createVariableResolver } = await import("@apicc/core");
  const envVars = preparedEnvironment.variables;
  const resolver = createVariableResolver({ layers: [envVars, preparedCollection.variables, preparedProject.variables] });
  const request = preparedApi.contract.request;
  const requestBaseUrl = resolver.resolve(request.baseUrl);
  const selectedBaseUrl = requestBaseUrl !== "" ? requestBaseUrl : preparedEnvironment.baseUrl;
  const resolvedBaseUrl = selectedBaseUrl === undefined ? undefined : resolver.resolve(selectedBaseUrl);
  const rawProbeUrl = withBaseUrl(resolver.resolve(request.path), resolvedBaseUrl);
  const staticTarget = resolveStaticStressTarget(rawProbeUrl, request.protocol);
  const probe = {
    method: request.protocol === "http" ? request.method : "POST",
    url: staticTarget.url,
    headers: {}, query: [], protocol: request.protocol, auth: { kind: "none" as const },
  } as import("@apicc/core").ExecutableRequest;
  const defaultClient = registry.getProtocol(probe);
  if (!defaultClient) throw new Error(`未找到可处理该接口的协议客户端（protocol: ${probe.protocol ?? "http"}）`);
  const target = {
    run: prepared.run,
    collectionId: preparedCollection.id,
    apiId: preparedApi.contract.id,
    caseId,
    ...(preparedEnvironment.environment ? { environmentId: preparedEnvironment.environment.id } : {}),
  };
  const targetOrigin = staticTarget.origin;
  return {
    apiPath: location.apiPath,
    apiId: preparedApi.contract.id,
    api: preparedApi,
    testCase,
    collection: preparedCollection,
    project: preparedProject,
    workspace,
    prepared,
    ...(targetOrigin !== undefined ? { targetOrigin } : {}),
    createRunner: (options = {}) => {
      const maxRps = options.maxRps ?? project.stressPolicy?.maxRps;
      return new StressRunner({
        evidenceIdentity: { projectId: prepared.snapshot.project.id, definitionRevision: prepared.snapshot.definitionRevision, environmentId: env?.id, dataDigest: prepared.run.preparedTestData?.digest },
        evidenceMarkers: prepared.secrets,
        onSample: options.onSample,
        finalizeEvidence: options.finalizeEvidence,
        onEvidenceMarkers: options.onEvidenceMarkers,
        onEvidenceOutputBoundary: options.onEvidenceOutputBoundary,
        createWorker: (workerId) => {
          let ownedHttp: ReturnType<typeof createHttpClient> | undefined;
          let ownedSoap: ReturnType<typeof createSoapClient> | undefined;
          const httpSession = createHttpSession();
          const createOwnedHttp = () => ownedHttp ??= createHttpClient({ connectionMode: options.connectionMode });
          try {
            const session = createStressCaseSession(target, {
              resolveProtocol: (candidate) => {
                if (candidate.protocol === "soap" && defaultClient.name === "soap") {
                  ownedSoap ??= createSoapClient(createOwnedHttp());
                  return ownedSoap;
                }
                return registry.getProtocol(candidate);
              },
              resolveAuth: (kind) => registry.getAuth(kind),
              resolveAssert: (operator) => registry.getAssert(operator),
              scriptEngine: registry.getScriptEngine("javascript")!,
              workspaceRoot: root,
              httpSession,
              createManagedClient: () => defaultClient.name === "http" || defaultClient.name === "soap"
                ? createOwnedHttp()
                : { ...defaultClient, close: async () => {} },
            }, {
              workerId,
              concurrency: options.concurrency,
              maxRps,
              confirmedTargetOrigins: options.confirmedTargetOrigins,
            });
            return {
              execute: (signal) => session.execute(signal),
              async close() {
                try { await session.close(); }
                finally { await httpSession.close(); }
              },
            };
          } catch (error) {
            void httpSession.close();
            throw error;
          }
        },
      });
    },
  };
}

export async function runCli(
  argv: string[],
  registry: PluginRegistry,
  log: (line: string) => void = console.log,
  deps: RunCliDeps = {},
): Promise<number> {
  const hostLog = log;
  // 进入时重置进程退出码：同进程多次调用 runCli（编程/测试场景）互不串扰，
  // 各命令只反映本次调用的结果（bin.ts 执行完毕后会把返回值写回 process.exitCode）。
  process.exitCode = 0;
  const { Command, Option } = await import("commander");
  const program = new Command();
  program.name("apicc").description("apicc 命令行——接口定义与测试驱动开发").version("0.1.0");
  registerTestingCommands(program, { registry, log, workspaceRoot: () => findWorkspaceRoot(process.cwd()), credentialOptions: credentialHostOptions(deps) });

  // M7-A D4：命令分发前加载用户级插件（~/.apicc/plugins.json）。--no-plugins 逃生开关（commander
  // 布尔取反：缺省 opts.plugins === true，传旗标即 false）；deps.loadPlugins=false 为编程关闭通道
  // （嵌入方/既有测试零扰动，裁定①）。加载失败已隔离为 problems，不阻断启动；摘要供 plugins list 展示。
  let pluginLoad: { loaded: PluginLoadEntry[]; problems: LoadProblem[] } | undefined;
  let pluginsDisabled = false;
  program.option("--no-plugins", "跳过用户级插件加载（逃生开关）");
  program.hook("preAction", async () => {
    const enabled = (program.opts() as { plugins?: boolean }).plugins !== false && deps.loadPlugins !== false;
    pluginsDisabled = !enabled;
    if (!enabled) return;
    pluginLoad = await loadUserPlugins(registry, { homeDir: deps.pluginsHomeDir });
  });

  program
    .command("validate")
    .argument("<root>", "工作区根目录")
    .action(async (root: string) => {
      const storage = registry.getStorage();
      if (!storage) throw new Error("未注册存储适配器");
      const { problems } = await storage.load(root);
      if (problems.length === 0) {
        log("工作区校验通过，未发现问题文件");
      } else {
        for (const p of problems) log(`[问题] ${p.file}: ${p.message}`);
        process.exitCode = 1;
        throw Object.assign(new Error(`发现 ${problems.length} 个问题文件`), { handled: true });
      }
    });

  const credentials = program.command("credentials").description("绑定、检查或移除项目凭据（值仅从标准输入读取）");
  credentials
    .command("save")
    .argument("<projectPath>", "项目完整 UUID 路径（groups/<groupId>/projects/<projectId>）")
    .argument("<refId>", "项目接口认证中引用的 opaque ref ID")
    .description("从标准输入绑定 test-auto 凭据，不接受 argv 明文且不回显")
    .action(async (projectPath: string, refId: string) => {
      const root = findWorkspaceRoot(process.cwd());
      if (!root) throw new Error("未找到 apicc.workspace.yaml——请在工作区内执行");
      const state = await loadWorkspace(registry, root);
      assertWorkspaceUsable(state);
      const { group, project } = locateProject(state.workspace, projectPath);
      const ref = findProjectCredentialRef(project, refId);
      const value = deps.secretInput ? await deps.secretInput() : await readSecretFromStdin();
      if (value.length === 0) throw new Error("标准输入未提供凭据值；请通过管道传入非空值");
      const store = createCredentialHostStore(credentialHostOptions(deps));
      const scope = credentialScope(state.workspace, group.id, project);
      try {
        await withCredentialMutationGuard(deps, scope, ref, () => store.put(scope, ref, value));
      } catch (error) {
        throw stableCredentialError(error);
      }
      log(`凭据已保存：${projectPath} ${ref.id}（值未显示）`);
    });
  credentials
    .command("status")
    .argument("<projectPath>", "项目完整 UUID 路径（groups/<groupId>/projects/<projectId>）")
    .argument("<refId>", "项目接口认证中引用的 opaque ref ID")
    .action(async (projectPath: string, refId: string) => {
      const root = findWorkspaceRoot(process.cwd());
      if (!root) throw new Error("未找到 apicc.workspace.yaml——请在工作区内执行");
      const state = await loadWorkspace(registry, root);
      assertWorkspaceUsable(state);
      const { group, project } = locateProject(state.workspace, projectPath);
      const ref = findProjectCredentialRef(project, refId);
      try {
        const status = await createCredentialHostStore(credentialHostOptions(deps))
          .status(credentialScope(state.workspace, group.id, project), ref);
        log(`凭据状态：${status}`);
      } catch (error) {
        throw stableCredentialError(error);
      }
    });
  credentials
    .command("remove")
    .argument("<projectPath>", "项目完整 UUID 路径（groups/<groupId>/projects/<projectId>）")
    .argument("<refId>", "项目接口认证中引用的 opaque ref ID")
    .action(async (projectPath: string, refId: string) => {
      const root = findWorkspaceRoot(process.cwd());
      if (!root) throw new Error("未找到 apicc.workspace.yaml——请在工作区内执行");
      const state = await loadWorkspace(registry, root);
      assertWorkspaceUsable(state);
      const { group, project } = locateProject(state.workspace, projectPath);
      const ref = findProjectCredentialRef(project, refId);
      const scope = credentialScope(state.workspace, group.id, project);
      try {
        const store = createCredentialHostStore(credentialHostOptions(deps));
        await withCredentialMutationGuard(deps, scope, ref, () => store.remove(scope, ref));
      } catch (error) {
        throw stableCredentialError(error);
      }
      log(`凭据已移除：${projectPath} ${ref.id}`);
    });

  const oauth = program.command("oauth").description("查看或操作项目 OAuth profile（授权码首次授权请使用桌面端）");
  async function resolveOAuthContext(projectPath: string, environmentId?: string) {
    const root = findWorkspaceRoot(process.cwd());
    if (!root) throw new Error("未找到 apicc.workspace.yaml——请在工作区内执行");
    const state = await loadWorkspace(registry, root);
    assertWorkspaceUsable(state);
    const { group, project } = locateProject(state.workspace, projectPath);
    if (environmentId !== undefined && !project.environments.some((environment) => environment.id === environmentId)) {
      throw new Error(`未找到环境 ID: ${environmentId}`);
    }
    const secretStore = createCredentialHostStore(credentialHostOptions(deps));
    const host = await createOAuthProfileHost({
      workspaceRoot: root,
      project: { workspaceId: state.workspace.id, groupId: group.id, projectId: project.id },
      ...(environmentId === undefined ? {} : { environmentId }),
      privateRoot: deps.oauthPrivateRoot ?? defaultOAuthPrivateRoot(),
      secretStore,
    });
    return { root, state, group, project, environmentId, secretStore, host };
  }
  async function prepareOAuthNetwork(context: Awaited<ReturnType<typeof resolveOAuthContext>>) {
    const networkHost = await createNetworkProfileHost({
      workspaceRoot: context.root,
      project: {
        workspaceId: context.state.workspace.id,
        groupId: context.group.id,
        projectId: context.project.id,
      },
      ...(context.environmentId === undefined ? {} : { environmentId: context.environmentId }),
      privateRoot: deps.networkPrivateRoot ?? defaultNetworkPrivateRoot(),
      secretStore: context.secretStore,
    });
    return await networkHost.prepare();
  }
  const publicOAuthStatus = (summary: OAuthProfileSummary) => ({
    profileId: summary.profile.profileId,
    flow: summary.profile.flow,
    status: summary.status,
    ...(summary.expiresAt === undefined ? {} : { expiresAt: summary.expiresAt }),
    ...(summary.grantedScope === undefined ? {} : { grantedScope: summary.grantedScope }),
    ...(summary.errorCode === undefined ? {} : { errorCode: summary.errorCode }),
  });
  oauth.command("list")
    .argument("<projectPath>", "项目完整 UUID 路径")
    .option("--env <environmentId>", "环境 UUID；省略表示项目级 profile")
    .action(async (projectPath: string, opts: { env?: string }) => {
      const { host } = await resolveOAuthContext(projectPath, opts.env);
      const summaries = await host.listProfiles();
      for (const summary of summaries) log(JSON.stringify(publicOAuthStatus(summary)));
    });
  oauth.command("status")
    .argument("<projectPath>", "项目完整 UUID 路径")
    .argument("<profileId>", "OAuth profile ID")
    .option("--env <environmentId>", "环境 UUID；省略表示项目级 profile")
    .action(async (projectPath: string, profileId: string, opts: { env?: string }) => {
      const { host } = await resolveOAuthContext(projectPath, opts.env);
      const summary = (await host.listProfiles()).find((item) => item.profile.profileId === profileId);
      if (summary === undefined) throw new Error("[OAUTH_PROFILE_NOT_FOUND] 未找到指定 profile");
      log(JSON.stringify(publicOAuthStatus(summary)));
    });
  oauth.command("acquire")
    .argument("<projectPath>", "项目完整 UUID 路径")
    .argument("<profileId>", "client-credentials profile ID")
    .option("--env <environmentId>", "环境 UUID；省略表示项目级 profile")
    .action(async (projectPath: string, profileId: string, opts: { env?: string }) => {
      const context = await resolveOAuthContext(projectPath, opts.env);
      const { host } = context;
      const summary = (await host.listProfiles()).find((item) => item.profile.profileId === profileId);
      if (summary === undefined) throw new Error("[OAUTH_PROFILE_NOT_FOUND] 未找到指定 profile");
      if (summary.profile.flow !== "client_credentials") {
        throw new Error("[OAUTH_AUTHORIZATION_REQUIRED] CLI acquire 仅支持 client_credentials；授权码首次授权请使用桌面端");
      }
      const network = await prepareOAuthNetwork(context);
      const coordinator = createOAuthProfileCoordinator({
        workspaceRoot: context.root,
        project: { workspaceId: context.state.workspace.id, groupId: context.group.id, projectId: context.project.id },
        ...(context.environmentId === undefined ? {} : { environmentId: context.environmentId }),
        privateRoot: deps.oauthPrivateRoot ?? defaultOAuthPrivateRoot(),
        secretStore: context.secretStore,
        network,
      });
      const result = await coordinator.exchangeOAuthProfile({
        profileId,
        grant: { type: "client_credentials" },
        expectedConfigurationFingerprint: summary.configurationFingerprint,
      });
      if (result.status !== "success") throw new Error(formatOAuthActionFailure("acquire", result));
      log("OAuth acquire succeeded (token value withheld)");
    });
  oauth.command("refresh")
    .argument("<projectPath>", "项目完整 UUID 路径")
    .argument("<profileId>", "OAuth profile ID")
    .option("--env <environmentId>", "环境 UUID；省略表示项目级 profile")
    .action(async (projectPath: string, profileId: string, opts: { env?: string }) => {
      const context = await resolveOAuthContext(projectPath, opts.env);
      const { host } = context;
      const summary = (await host.listProfiles()).find((item) => item.profile.profileId === profileId);
      if (summary === undefined) throw new Error("[OAUTH_PROFILE_NOT_FOUND] 未找到指定 profile");
      if (summary.profile.refreshTokenRef === undefined) {
        throw new Error("[OAUTH_REFRESH_TOKEN_MISSING] profile 未绑定 refresh token");
      }
      const network = await prepareOAuthNetwork(context);
      const coordinator = createOAuthProfileCoordinator({
        workspaceRoot: context.root,
        project: { workspaceId: context.state.workspace.id, groupId: context.group.id, projectId: context.project.id },
        ...(context.environmentId === undefined ? {} : { environmentId: context.environmentId }),
        privateRoot: deps.oauthPrivateRoot ?? defaultOAuthPrivateRoot(),
        secretStore: context.secretStore,
        network,
      });
      const result = await coordinator.exchangeOAuthProfile({
        profileId,
        grant: { type: "refresh_token" },
        expectedConfigurationFingerprint: summary.configurationFingerprint,
      });
      if (result.status !== "success") throw new Error(formatOAuthActionFailure("refresh", result));
      log("OAuth refresh succeeded (token value withheld)");
    });
  oauth.command("unlink")
    .argument("<projectPath>", "项目完整 UUID 路径")
    .argument("<profileId>", "OAuth profile ID")
    .option("--env <environmentId>", "环境 UUID；省略表示项目级 profile")
    .action(async (projectPath: string, profileId: string, opts: { env?: string }) => {
      const { host } = await resolveOAuthContext(projectPath, opts.env);
      const loaded = await host.store.load(host.scope);
      const result = await host.unlinkProfile(profileId, loaded.revision);
      if (result.status !== "success") throw new Error(`[${result.errorCode ?? "OAUTH_PROFILE_STORAGE_FAILED"}] OAuth unlink failed`);
      log("OAuth profile unlinked; credential values were not removed");
    });

  program
    .command("run")
    .argument("<collectionPath>", "集合完整 UUID 路径（groups/<groupId>/projects/<projectId>/collections/<collectionId>）")
    .requiredOption("--env <name>", "环境名称")
    .option("--reporters <list>", "报告格式，逗号分隔", "html")
    .option("--runs-dir <dir>", "运行历史输出目录")
    .option("--fail-fast", "首个失败后停止", false)
    .option("--evidence <mode>", "证据正文 none,failures,all", "failures")
    .action(async (collectionPath: string, opts: { env: string; reporters: string; runsDir?: string; failFast: boolean; evidence: "none" | "failures" | "all" }) => {
      if (!["none", "failures", "all"].includes(opts.evidence)) throw new Error("证据模式仅支持 none,failures,all");
      const root = findWorkspaceRoot(process.cwd());
      if (!root) throw new Error("未找到 apicc.workspace.yaml——请在工作区内执行");
      const state = await loadWorkspace(registry, root);
      assertWorkspaceUsable(state);
      const location = locateCollection(state.workspace, collectionPath);
      const { collection, project } = location;
      const env = project.environments.find((candidate) => candidate.name === opts.env);
      if (!env) throw new Error(`未找到环境: ${opts.env}`);

      const executableAssets = apiAssetsWithExecutableCases(project, apiAssetsInCollection(collection), env);
      const credentialSelections: ExecutionCredentialSelection[] = executableAssets.flatMap((asset) =>
        selectEffectiveCases(asset.cases, envChain(env, project)).map((testCase) => ({
          collectionId: collection.id,
          apiId: asset.contract.id,
          caseId: testCase.id,
          scope: testCase.scope,
        })),
      );
      const prepared = await prepareExecutionRun(
        state.workspace,
        location.group.id,
        project,
        executableAssets,
        credentialHostOptions(deps),
        undefined,
        undefined,
        credentialSelections,
        { workspaceRoot: root, environmentId: env.id },
      );
      const runPrepared = prepared;
      const sanitizer = createOutputSanitizer(runPrepared.secrets);
      const safeLog = (line: string): void => log(sanitizer.redactText(line));

      const { CollectionRunner } = await import("@apicc/core");
      const runner = new CollectionRunner({
        registry, bus: (await import("@apicc/core")).createEventBus(),
        timeouts: { connectTimeoutMs: 10_000, totalTimeoutMs: 30_000 },
        failFast: opts.failFast,
      });
      // Host persists only the projected result; do not let Core write an unredacted raw result.
      const runsOutDir = opts.runsDir ?? join(root, ".apicc", "runs");
      let result: import("@apicc/core").RunResult;
      const evidence = createExecutionEvidenceCollector({ projectId: runPrepared.snapshot.project.id, definitionRevision: runPrepared.snapshot.definitionRevision, environmentId: env.id, dataDigest: runPrepared.run.preparedTestData?.digest }, runPrepared.secrets, { mode: opts.evidence });
      let runFailure = false;
      let runError: string | undefined;
      const httpSession = createHttpSession();
      try {
        result = await runner.run(runPrepared.run, collection.id, { environmentId: env.id, workspaceRoot: root, httpSession, observeCaseExecution: evidence.observe });
      } catch (error) {
        if (!(error instanceof CollectionRunError)) throw error;
        result = error.partialResult;
        runFailure = true;
        runError = error.message;
      } finally {
        await httpSession.close();
      }
      const safeResult = evidence.projectRun(result);
      if (runError) safeLog(evidence.boundary().redactText(runError).slice(0, 4096));
      mkdirSync(runsOutDir, { recursive: true });
      writeFileSync(join(runsOutDir, `run-${nextRunFileId()}.json`), JSON.stringify(safeResult, null, 2));
      for (const format of opts.reporters.split(",")) {
        const reporter = registry.getReporter(format.trim());
        if (!reporter) throw new Error(`未注册报告格式: ${format}`);
        try { const file = await reporter.render(safeResult, runsOutDir); safeLog(`报告已生成: ${file}`); }
        catch { runFailure = true; safeLog(`${format} 报告渲染失败；安全 JSON 已保留`); }
      }
      safeLog(`总计 ${safeResult.total} · 通过 ${safeResult.passed} · 失败 ${safeResult.failed}`);
      process.exitCode = runFailure || safeResult.failed > 0 ? 1 : 0;
    });

  // 工作流运行（任务 8）：复用 run 命令的加载/定位/报告模式；结构校验（含环拒绝）由 WorkflowRunner
  // 内部执行，CLI 只负责目录定位、env 解析与草稿状态门。
  program
    .command("run-workflow")
    .argument("<workflowPath>", "工作流完整 UUID 路径（groups/<groupId>/projects/<projectId>/workflows/<workflowId>）")
    .option("--env <name>", "环境名称")
    .option("--force-draft", "允许运行草稿（跳过生命周期与启用校验，仅结构校验）", false)
    .option("--no-strict", "缺失引用不中断独立节点诊断（本次结果仍失败）")
    .option("--reporters <list>", "报告格式，逗号分隔", "html")
    .option("--runs-dir <dir>", "运行历史输出目录")
    .option("--evidence <mode>", "证据正文 none,failures,all", "failures")
    .action(async (workflowPath: string, opts: { env?: string; forceDraft: boolean; strict: boolean; reporters: string; runsDir?: string; evidence: "none" | "failures" | "all" }) => {
      if (!["none", "failures", "all"].includes(opts.evidence)) throw new Error("证据模式仅支持 none,failures,all");
      const root = findWorkspaceRoot(process.cwd());
      if (!root) throw new Error("未找到 apicc.workspace.yaml——请在工作区内执行");
      const state = await loadWorkspace(registry, root);
      assertWorkspaceUsable(state);
      const location = locateWorkflow(state.workspace, workflowPath);
      const { workflow, project } = location;
      // env 解析：未指定则不启用环境（执行器侧为空快照）；指定但未命中显式报错。
      const env = opts.env ? project.environments.find((e) => e.name === opts.env) : undefined;
      if (opts.env && !env) throw new Error(`未找到环境: ${opts.env}`);
      // 状态门：草稿默认拒绝，--force-draft 放行（生命周期与启用校验跳过，仅剩结构校验）。
      if (workflow.status === "draft" && !opts.forceDraft) {
        throw new Error("工作流为草稿，请先发布启用或加 --force-draft");
      }
      const { WorkflowRunner, workflowToRunResult } = await import("@apicc/core");
      const workflowAssets = workflow.nodes.flatMap((node) => {
        if (node.kind !== "request" || !node.apiId) return [];
        const api = findProjectApi(project, node.apiId)?.api;
        return api ? [api as ApiAsset] : [];
      });
      const chain = env ? envChain(env, project) : [];
      const credentialSelections: ExecutionCredentialSelection[] = workflow.nodes.flatMap((node) => {
        if (node.kind !== "request" || !node.apiId || !node.caseId) return [];
        const apiLocation = findProjectApi(project, node.apiId);
        if (!apiLocation) return [];
        const testCase = selectEffectiveCases(apiLocation.api.cases, chain, node.caseId)[0];
        if (!testCase) return [];
        return [{
          collectionId: apiLocation.collection.id,
          apiId: apiLocation.api.contract.id,
          caseId: testCase.id,
          scope: testCase.scope,
        }];
      });
      const prepared = await prepareExecutionRun(
        state.workspace,
        location.group.id,
        project,
        workflowAssets,
        credentialHostOptions(deps),
        undefined,
        undefined,
        credentialSelections,
        { workspaceRoot: root, ...(env === undefined ? {} : { environmentId: env.id }) },
      );
      const runPrepared = prepared;
      const sanitizer = createOutputSanitizer(runPrepared.secrets);
      const safeLog = (line: string): void => log(sanitizer.redactText(line));
      const runner = new WorkflowRunner({ registry, environmentId: env?.id, failFast: false, strict: opts.strict });
      const httpSession = createHttpSession();
      let wfr: import("@apicc/core").WorkflowRunResult;
      const evidence = createExecutionEvidenceCollector({ projectId: runPrepared.snapshot.project.id, definitionRevision: runPrepared.snapshot.definitionRevision, workflowId: workflow.id, environmentId: env?.id, dataDigest: runPrepared.run.preparedTestData?.digest }, runPrepared.secrets, { mode: opts.evidence });
      try {
        wfr = evidence.projectWorkflow(await runner.run(runPrepared.run, workflow.id, {
          environmentId: env?.id,
          workspaceRoot: root,
          httpSession,
          observeCaseExecution: (execution, identity) => evidence.observe(execution, { ...identity, entryId: identity.nodeId }),
        }));
      } finally {
        await httpSession.close();
      }
      const result = wfr.report!;
      // The projected raw result is durable before any reporter is invoked.
      const runsOutDir = opts.runsDir ?? join(root, ".apicc", "runs");
      mkdirSync(runsOutDir, { recursive: true });
      writeFileSync(join(runsOutDir, `workflow-${wfr.workflowId}-${randomUUID()}.json`), JSON.stringify(result, null, 2));
      let reportFailure = false;
      for (const format of opts.reporters.split(",")) {
        const reporter = registry.getReporter(format.trim());
        if (!reporter) throw new Error(`未注册报告格式: ${format}`);
        try { const file = await reporter.render(result, runsOutDir); safeLog(`报告已生成: ${file}`); }
        catch { reportFailure = true; safeLog(`${format} 报告渲染失败；安全 JSON 已保留`); }
      }
      for (const w of wfr.warnings) safeLog(`[警告] ${w}`);
      for (const node of wfr.nodeResults) {
        if (node.state === "skipped") {
          safeLog(`[跳过] 节点 ${node.nodeId}：${node.skipReason === "condition-pruned" ? "条件不满足" : node.skipReason ?? "未知原因"}`);
        }
      }
      safeLog(`节点统计：总计 ${wfr.total} · 通过 ${wfr.passed} · 失败 ${wfr.failed} · 跳过 ${wfr.skipped}`);
      process.exitCode = reportFailure || wfr.verdict === "failed" || wfr.failed > 0 ? 1 : 0;
    });

  program
    .command("debug")
    .argument("<apiPath>", "接口完整 UUID 路径（groups/.../collections/.../apis/...）")
    .option("--root <root>", "工作区根目录；缺省从当前目录向上查找")
    .option("--env <name>", "环境名称")
    .option("--request <json-file>", "工作区根内、已绑定到该 API 的 ApiRequest JSON 文件")
    .option("--case <caseId>", "显式执行的用例 ID")
    .option("--scope <scope>", "用例身份 scope；必须是当前环境的最近有效 scope")
    .option("--settings <json>", "本次请求设置覆盖 JSON")
    .option("--no-history", "不把本次投影结果追加到调试历史")
    .action(async (apiPath: string, opts: {
      root?: string;
      env?: string;
      request?: string;
      case?: string;
      scope?: string;
      settings?: string;
      history: boolean;
    }) => {
      const hasRequest = opts.request !== undefined;
      const hasCaseInput = opts.case !== undefined || opts.scope !== undefined;
      if (hasRequest === hasCaseInput) throw new Error("debug 必须且只能指定 --request <json-file> 或 --case <id> --scope <scope>");
      if (!hasRequest && (!opts.case || !opts.scope)) throw new Error("--case 与 --scope 必须同时提供");

      const workspaceRoot = opts.root === undefined ? findWorkspaceRoot(process.cwd()) : resolve(opts.root);
      if (!workspaceRoot) throw new Error("未找到 apicc.workspace.yaml——请在工作区内执行或指定 --root");
      if (!existsSync(join(workspaceRoot, "apicc.workspace.yaml"))) throw new Error(`未找到 apicc.workspace.yaml: ${workspaceRoot}`);
      const root = realpathSync(workspaceRoot);
      const state = await loadWorkspace(registry, root);
      assertWorkspaceUsable(state);
      const location = locateApi(state.workspace, apiPath);
      const env = opts.env === undefined ? undefined : location.project.environments.find((candidate) => candidate.name === opts.env);
      if (opts.env !== undefined && !env) throw new Error(`未找到环境: ${opts.env}`);
      const locator = {
        workspaceId: state.workspace.id,
        groupId: location.group.id,
        projectId: location.project.id,
        collectionId: location.collection.id,
        folderIds: [...location.folderIds],
        apiId: location.api.contract.id,
      };
      const settings = opts.settings === undefined
        ? undefined
        : RequestSettingsOverrideSchema.parse(parseJsonOption(opts.settings, "--settings"));
      const commonInvocation = {
        locator,
        ...(env === undefined ? {} : { environmentId: env.id }),
        ...(settings === undefined ? {} : { settings }),
      };
      const invocation = DebugInvocationSchema.parse(hasRequest
        ? {
          ...commonInvocation,
          mode: "request",
          request: ApiRequestSchema.parse(JSON.parse(readFileSync(resolveWorkspaceFile(root, opts.request!), "utf8")) as unknown),
          parameters: {},
          fields: [],
        }
        : {
          ...commonInvocation,
          mode: "case",
          case: { ...locator, caseId: opts.case!, scope: opts.scope! },
        });
      if (invocation.mode === "free") throw new Error("CLI debug requires a saved API or case identity.");
      const plan = prepareDebugExecution(createProjectSnapshot(location.project), invocation);
      const runId = randomUUID();
      const startedAt = new Date().toISOString();
      const controller = new AbortController();
      const cancel = (): void => controller.abort();
      process.on("SIGINT", cancel);
      process.on("SIGTERM", cancel);
      let httpSession: ReturnType<typeof createHttpSession> | undefined;
      let result: import("@apicc/core").DebugResult;
      let preparedSecrets: string[] = [];
      let projectionReliable = false;
      try {
        result = await (async (): Promise<import("@apicc/core").DebugResult> => {
          if (controller.signal.aborted) return abortedDebugResult(plan, runId, startedAt);
          let prepared: Awaited<ReturnType<typeof prepareExecutionRunFromSnapshot>>;
          try {
            prepared = await prepareExecutionRunFromSnapshot(
              state.workspace,
              location.group.id,
              location.project,
              plan.snapshot,
              plan.credentialSelections,
              credentialHostOptions(deps),
              undefined,
              undefined,
              { workspaceRoot: root, ...(env === undefined ? {} : { environmentId: env.id }), signal: controller.signal },
            );
          } catch (error) {
            return controller.signal.aborted
              ? abortedDebugResult(plan, runId, startedAt)
              : failedDebugResult(plan, runId, startedAt, error, { failureKind: "config" });
          }
          preparedSecrets = prepared.secrets;
          projectionReliable = true;
          if (controller.signal.aborted) {
            return abortedDebugResult(plan, runId, startedAt, { markers: preparedSecrets, projectionReliable });
          }
          httpSession = createHttpSession();
          return runDebugExecution(plan, prepared.run, {
            registry,
            workspaceRoot: root,
            httpSession,
            signal: controller.signal,
            credentialMarkers: prepared.secrets,
          }, runId);
        })();
      } finally {
        process.removeListener("SIGINT", cancel);
        process.removeListener("SIGTERM", cancel);
        await httpSession?.close();
      }

      const safeResult = result; // DebugResultSchema already finalized the typed, marker-safe DTO.
      if (opts.history) {
        const store = createDebugHistoryStore({
          root: defaultDebugHistoryRoot(deps.debugHistoryAppDataDirectory ?? cliAppDataDirectory()),
        });
        const ownerIdentity = invocation.mode === "case"
          ? { sourceKind: "asset" as const, mode: "case" as const, case: invocation.case }
          : { sourceKind: "asset" as const, mode: "request" as const, locator: invocation.locator };
        try {
          await store.append(safeResult, {
            ownerKey: createDebugHistoryOwnerKey(realpathSync(root), ownerIdentity),
          });
        } catch (error) {
          // History is best-effort after the network outcome; it must not rewrite a completed run.
          const diagnostic = error instanceof DebugHistoryStoreError ? error.diagnostic.code : "storage-failure";
          process.stderr.write(`[debug] 历史写入失败（${diagnostic}）；本次网络结果已保留\n`);
        }
      }

      log(JSON.stringify(safeResult, null, 2));
      process.exitCode = result.failureKind !== undefined || result.run.failed > 0 ? 1 : 0;
    });

  const debugHistory = program.command("debug-history").description("查询或配置本机调试历史");
  debugHistory
    .command("config")
    .option("--enabled <boolean>", "是否启用持久调试历史", parseBooleanOption)
    .option("--days <days>", "保留天数", (value: string) => parsePositiveIntegerOption(value, "--days"))
    .option("--max-records <count>", "最多保留条数（1..10000）", (value: string) => parsePositiveIntegerOption(value, "--max-records", 10_000))
    .action(async (opts: { enabled?: boolean; days?: number; maxRecords?: number }) => {
      const store = createDebugHistoryStore({
        root: defaultDebugHistoryRoot(deps.debugHistoryAppDataDirectory ?? cliAppDataDirectory()),
      });
      if (opts.enabled === undefined && opts.days === undefined && opts.maxRecords === undefined) {
        log(JSON.stringify(await store.getPreferences(), null, 2));
        return;
      }
      const current = await store.getPreferences();
      await store.updatePreferences({
        enabled: opts.enabled ?? current.preferences.enabled,
        retentionDays: opts.days ?? current.preferences.retentionDays,
        maxRecords: opts.maxRecords ?? current.preferences.maxRecords,
      });
      log(JSON.stringify(await store.getPreferences(), null, 2));
    });

  // 压测运行（任务 4）：把 core 压测引擎（并发池执行 + 聚合报告）暴露为 CLI 命令；
  // 工作区定位、路径匹配、环境解析、产物目录均沿用 run/run-workflow 模式。
  // M2-D：--shards >1 走多 shard 协调（本地子进程 worker，spawn 实现可注入）；=1 保持既有进程内路径零行为变化。
  program
    .command("run-stress")
    .argument("<apiPath>", "接口目录（相对工作区根）")
    .requiredOption("--case <caseId>", "用例 ID")
    .option("--env <name>", "环境名称")
    .requiredOption("--concurrency <n>", "并发数", Number)
    .option("--iterations <n>", "总迭代数", Number)
    .option("--duration <s>", "持续秒数", Number)
    .option("--max-rps <n>", "单 shard 每秒请求启动安全上限（多 shard 不支持）", Number)
    .option("--max-error-rate <ratio>", "最大错误率阈值", Number)
    .option("--max-assertion-failure-rate <ratio>", "最大断言失败率阈值", Number)
    .option("--max-p95-ms <ms>", "最大 p95 时延阈值", Number)
    .option("--min-rps <n>", "最低 RPS 阈值", Number)
    .option("--connection-mode <mode>", "连接模式 pooled 或 fresh", "pooled")
    .option("--allow-target <origin>", "本次运行确认的 HTTP(S) origin（可重复）", collectOption, [])
    .option("--shards <n>", "分片数（必须 <= concurrency；>1 走多 shard 协调）", Number, 1)
    .option("--shard-timeout <s>", "单 shard 超时秒数", Number, 300)
    .option("--runs-dir <dir>", "报告输出目录")
    .action(async (apiPath: string, opts: {
      case: string; env?: string; concurrency: number; iterations?: number; duration?: number; maxRps?: number;
      maxErrorRate?: number; maxAssertionFailureRate?: number; maxP95Ms?: number; minRps?: number;
      connectionMode: "pooled" | "fresh"; allowTarget: string[]; shards: number; shardTimeout: number; runsDir?: string;
    }) => {
      // 所有终止/分片守卫都在工作区读取、目标解析和 worker spawn 之前执行。
      if (!Number.isSafeInteger(opts.shards) || opts.shards < 1) {
        throw new Error(`shards 必须为正整数，收到 ${opts.shards}`);
      }
      if (!Number.isFinite(opts.shardTimeout) || opts.shardTimeout <= 0) {
        throw new Error(`shard-timeout 必须为正数，收到 ${opts.shardTimeout}`);
      }
      if (!Number.isFinite(opts.shardTimeout * 1000) || opts.shardTimeout * 1000 > MAX_SAFE_DURATION_MS) {
        throw new Error(`shard-timeout 换算后的毫秒数溢出，收到 ${opts.shardTimeout}`);
      }
      validateStressRunOptions(opts);
      const confirmedTargetOrigins = [...new Set((opts.allowTarget ?? []).map(validateStressOriginOption))];
      const durationMs = validateCliStressTermination(opts);
      validateCoreStressRunOptions({
        concurrency: opts.concurrency,
        ...(opts.iterations !== undefined ? { maxIterations: opts.iterations } : {}),
        ...(durationMs !== undefined ? { durationMs } : {}),
        ...(opts.maxRps !== undefined ? { maxRps: opts.maxRps } : {}),
      });
      if (opts.shards > opts.concurrency) {
        throw new Error(`shards 不能大于 concurrency（${opts.concurrency}）`);
      }
      if (opts.shards > 1 && opts.maxRps !== undefined) {
        throw new Error("多 shard + maxRps 不受支持：无法证明全局滑动窗口上限");
      }
      const root = findWorkspaceRoot(process.cwd());
      if (!root) throw new Error("未找到 apicc.workspace.yaml——请在工作区内执行");
      // 定位/env/resolver 与 stress-worker 共享 helper（不复制）；校验通过才落协调或进程内执行。
      const targetInfo = await resolveStressTarget(registry, root, apiPath, opts.case, opts.env, credentialHostOptions(deps));
      const { apiId, createRunner } = targetInfo;
      const sanitizer = createOutputSanitizer(targetInfo.prepared.secrets);
      const log = (line: string): void => hostLog(sanitizer.redactText(line));
      const projectMaxRps = targetInfo.project.stressPolicy?.maxRps;
      const effectiveMaxRps = opts.maxRps === undefined
        ? projectMaxRps
        : projectMaxRps === undefined ? opts.maxRps : Math.min(opts.maxRps, projectMaxRps);
      if (opts.shards > 1 && effectiveMaxRps !== undefined) {
        throw new Error("多 shard + maxRps 不受支持：项目安全策略也不能拆成可证明的全局滑动窗口");
      }
      if (targetInfo.project.stressPolicy?.maxConcurrency !== undefined
        && opts.concurrency > targetInfo.project.stressPolicy.maxConcurrency) {
        throw new StressSafetyError(
          "concurrency_policy_exceeded",
          `并发数 ${opts.concurrency} 超过项目上限 ${targetInfo.project.stressPolicy.maxConcurrency}`,
          targetInfo.targetOrigin,
        );
      }
      const thresholds: StressThresholds = {
        ...(opts.maxErrorRate !== undefined ? { maxErrorRate: opts.maxErrorRate } : {}),
        ...(opts.maxAssertionFailureRate !== undefined ? { maxAssertionFailureRate: opts.maxAssertionFailureRate } : {}),
        ...(opts.maxP95Ms !== undefined ? { maxP95Ms: opts.maxP95Ms } : {}),
        ...(opts.minRps !== undefined ? { minRps: opts.minRps } : {}),
      };
      const hasThresholds = Object.keys(thresholds).length > 0;
      // 产物隔离（规格 §6，对齐 run-workflow）：StressReport JSON 落 runs 目录，默认 .apicc/runs。
      const runsOutDir = opts.runsDir ?? join(root, ".apicc", "runs");
      mkdirSync(runsOutDir, { recursive: true });

      let report: StressReport;
      let shardFailureCount = 0;
      if (opts.shards === 1) {
        // 单 shard：既有进程内路径，零行为变化（裁定 C：不挂 distributed 段，保持 M2-C 报告原样）。
        report = await createRunner({
          concurrency: opts.concurrency, maxRps: effectiveMaxRps, confirmedTargetOrigins,
          connectionMode: opts.connectionMode,
        }).run({
          concurrency: opts.concurrency, maxIterations: opts.iterations, durationMs,
          maxRps: effectiveMaxRps, ...(hasThresholds ? { thresholds } : {}),
          connectionMode: opts.connectionMode,
          safetyRun: {
            requestedConcurrency: opts.concurrency,
            effectiveConcurrency: opts.concurrency,
            requestedMaxRps: opts.maxRps ?? null,
            effectiveMaxRps: effectiveMaxRps ?? null,
            connectionMode: opts.connectionMode,
          },
        });
      } else {
        // 多 shard：构造 specBase（workspaceRoot 显式传给子进程 worker），协调器拆分/并发/汇聚。
        const { DistributedStressCoordinator } = await import("@apicc/core");
        const specBase: StressWorkerSpecBase = {
          apiPath: targetInfo.apiPath,
          caseId: opts.case,
          definitionRevision: targetInfo.prepared.snapshot.definitionRevision,
          credentialVersions: Object.fromEntries(Object.keys(targetInfo.prepared.run.credentialBindings.versions)
            .map((refId) => [refId, targetInfo.prepared.run.credentialBindings.versions[refId]!])),
          networkIdentity: targetInfo.prepared.network!.identity,
          preparedTestData: targetInfo.prepared.run.preparedTestData,
          envName: opts.env,
          concurrency: opts.concurrency,
          workspaceRoot: root,
          ...(opts.iterations !== undefined ? { maxIterations: opts.iterations } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(effectiveMaxRps !== undefined ? { maxRps: effectiveMaxRps } : {}),
          ...(opts.maxErrorRate !== undefined ? { maxErrorRate: opts.maxErrorRate } : {}),
          ...(opts.maxAssertionFailureRate !== undefined ? { maxAssertionFailureRate: opts.maxAssertionFailureRate } : {}),
          ...(opts.maxP95Ms !== undefined ? { maxP95Ms: opts.maxP95Ms } : {}),
          ...(opts.minRps !== undefined ? { minRps: opts.minRps } : {}),
          ...(opts.connectionMode !== undefined ? { connectionMode: opts.connectionMode } : {}),
          ...(confirmedTargetOrigins.length > 0 ? { confirmedTargetOrigins } : {}),
        };
        const shardTimeoutMs = opts.shardTimeout * 1000;
        const coordinator = new DistributedStressCoordinator();
        ({ report, shardFailureCount } = await coordinator.run(specBase, {
          shards: opts.shards,
          shardTimeoutMs,
          // 默认本地子进程 spawn（同值超时 kill，裁定 A）；测试注入进程内替身。
          spawnWorker: (deps.spawnWorkerFactory ?? defaultSpawnWorkerFactory)(shardTimeoutMs),
          safetyRun: {
            requestedConcurrency: opts.concurrency,
            effectiveConcurrency: opts.concurrency,
            requestedMaxRps: opts.maxRps ?? null,
            effectiveMaxRps: effectiveMaxRps ?? null,
            connectionMode: opts.connectionMode,
          },
        }));
      }
      const currentReport = CurrentStressReportSchema.safeParse(report);
      if (!currentReport.success) {
        const detail = currentReport.error.issues
          .map((issue) => `${issue.path.join(".") || "(根字段)"}: ${issue.message}`)
          .join("; ");
        throw new Error(`压测报告契约校验失败[current_report_invalid]：${detail}`);
      }
      report = currentReport.data;
      report.projectId = targetInfo.project.id;
      report.definitionRevision = targetInfo.prepared.snapshot.definitionRevision;
      report = redactExecutionOutput(report, sanitizer);
      writeFileSync(join(runsOutDir, `stress-${apiId}-${Date.now()}.json`), JSON.stringify(report, null, 2));
      const l = report.latency;
      log(`压测完成：总计 ${report.totalRequests} · 成功 ${report.ok} · 失败 ${report.failed} · RPS ${report.rps.toFixed(1)}`);
      log(
        `时延 ms：min ${l.min.toFixed(1)} / avg ${l.avg.toFixed(1)} / p50 ${l.p50.toFixed(1)} / p90 ${l.p90.toFixed(1)}`
          + ` / p95 ${l.p95.toFixed(1)} / p99 ${l.p99.toFixed(1)} / max ${l.max.toFixed(1)}`,
      );
      if (report.distributed) {
        // 分布式摘要：各 shard 行 + 失败 shard 明细（计划步骤 2：摘要日志含各 shard 行）。
        for (const p of report.distributed.perShard) {
          log(`shard ${p.shardId}：总计 ${p.totalRequests} · 成功 ${p.ok} · 失败 ${p.failed} · RPS ${p.rps.toFixed(1)}`);
        }
        for (const e of report.distributed.shardErrors ?? []) {
          log(`[shard 失败] ${e.shardId}: ${e.error}`);
        }
      }
      if (report.verdict) {
        log(`verdict: ${report.verdict.passed ? "passed" : "failed"}`);
        for (const violation of report.verdict.violations) log(`[阈值失败] ${violation.message}`);
      }
      const failureCategories = Object.entries(report.failures ?? {}).filter(([, count]) => count > 0);
      if (failureCategories.length > 0) {
        log(`失败分类: ${failureCategories.map(([kind, count]) => `${kind}=${count}`).join(", ")}`);
      }
      const errorKinds = Object.entries(report.errorKinds).filter(([, count]) => count > 0);
      if (errorKinds.length > 0) {
        log(`错误明细: ${errorKinds.map(([kind, count]) => `${kind}=${count}`).join(", ")}`);
      }
      if (report.safety?.targetOrigins.length) {
        log(`target origins: ${report.safety.targetOrigins.map((target) => target.origin).join(", ")}`);
        for (const target of report.safety.targetOrigins) {
          if (target.confirmation === "rejected") log(`[安全拒绝][${target.policy}] ${target.origin}`);
          const policy = target.appliedPolicy;
          log(`[安全审计] ${target.origin} confirmation=${target.confirmation} loopback=${target.loopback === true ? "true" : "false"} policy=${target.policy}`
            + (policy ? ` trusted=${(policy.trustedOrigins ?? []).join(",")} denied=${(policy.deniedOrigins ?? []).join(",")}`
              + (policy.maxConcurrency === undefined ? "" : ` maxConcurrency=${policy.maxConcurrency}`)
              + (policy.maxRps === undefined ? "" : ` maxRps=${policy.maxRps}`) : ""));
        }
      }
      if (report.safety?.run) {
        log(`[安全审计] run requestedConcurrency=${report.safety.run.requestedConcurrency} effectiveConcurrency=${report.safety.run.effectiveConcurrency}`
          + ` requestedMaxRps=${report.safety.run.requestedMaxRps ?? "none"} effectiveMaxRps=${report.safety.run.effectiveMaxRps ?? "none"}`
          + ` connectionMode=${report.safety.run.connectionMode}`);
      }
      if (report.generator?.availability === "unavailable") {
        log(`[generator] 未采集/不可用${report.generator.unavailableReason ? `：${report.generator.unavailableReason}` : ""}`);
      } else if (report.generator?.availability === "partial") {
        log(`[generator] 部分采集/不可用：部分 shard 未返回 generator 指标`);
      } else if (report.generator?.saturated) {
        log(`[警告] generator saturation: ${(report.generator.reasons ?? []).join(", ") || "unknown"}`);
      }
      // 退出码：任一 shard 失败 → 1；否则沿用「全部请求失败且 total>0 → 1」
      // （压测关注面是性能画像而非断言成败）。
      process.exitCode = shardFailureCount > 0 || report.verdict?.passed === false ? 1 : 0;
    });

  // 分布式压测 worker（M2-D 任务 2）：由 run-stress --shards 协调端以子进程方式调起，也可手工单独运行。
  // stdout 契约（裁定 B）：只许末行一行协议 JSON（ShardResult/ShardFailure），人类日志一律 stderr——
  // 协调端按行从末解析 stdout。定位/env/resolver 与 run-stress 共享 helper（不复制）。
  program
    .command("stress-worker")
    .argument("<apiPath>", "接口目录（相对工作区根）")
    .requiredOption("--case <caseId>", "用例 ID")
    .option("--env <name>", "环境名称")
    .requiredOption("--concurrency <n>", "并发数", Number)
    .option("--iterations <n>", "迭代数", Number)
    .option("--duration <s>", "持续秒数", Number)
    .option("--max-rps <n>", "本 shard 每秒请求启动安全上限", Number)
    .option("--max-error-rate <ratio>", "最大错误率阈值", Number)
    .option("--max-assertion-failure-rate <ratio>", "最大断言失败率阈值", Number)
    .option("--max-p95-ms <ms>", "最大 p95 时延阈值", Number)
    .option("--min-rps <n>", "最低 RPS 阈值", Number)
    .option("--connection-mode <mode>", "连接模式 pooled 或 fresh", "pooled")
    .option("--allow-target <origin>", "本次运行确认的 HTTP(S) origin（可重复）", collectOption, [])
    .requiredOption("--shard-id <id>", "shard 标识（由协调端分配）")
    .requiredOption("--workspace <root>", "工作区根目录（由协调端传入）")
    .requiredOption("--definition-revision <revision>", "协调端固定的项目定义版本描述符")
    .requiredOption("--credential-versions <json>", "协调端固定的凭据版本 JSON 字典（不含凭据值）")
    .option("--network-identity <digest>", "协调端固定的非秘密网络配置与公开证书材料身份摘要")
    .option("--prepared-data-stdin", "从协调端标准输入接收固定数据快照", false)
    .option("--private-evidence-ipc", "协调端专用运行完成控制通道", false)
    .action(async (apiPath: string, opts: {
      case: string; env?: string; concurrency: number; iterations?: number; duration?: number; maxRps?: number;
      maxErrorRate?: number; maxAssertionFailureRate?: number; maxP95Ms?: number; minRps?: number;
      connectionMode: "pooled" | "fresh"; allowTarget: string[]; shardId: string; workspace: string;
      definitionRevision: string; credentialVersions: string;
      networkIdentity?: string;
      preparedDataStdin: boolean;
      privateEvidenceIpc: boolean;
    }) => {
      const out = deps.workerOut ?? ((line: string) => { process.stdout.write(`${line}\n`); });
      const err = deps.workerErr ?? ((line: string) => { console.error(line); });
      let redactText = (line: string): string => line;
      const privateFinalize = deps.workerFinalizeEvidence ?? (opts.privateEvidenceIpc ? createWorkerEvidenceFinalizer(opts.shardId) : undefined);
      let workerMarkers: readonly string[] = []; let finalized = false; let executionStarted = false;
      let workerBoundary: EvidenceOutputBoundary | undefined;
      const acceptBoundary = (boundary: EvidenceOutputBoundary) => { workerBoundary = boundary; redactText = boundary.redactText; };
      const acceptMarkers = (markers: readonly string[]) => {
        workerMarkers = markers;
        acceptBoundary(createExecutionEvidenceCollector({ projectId: "", definitionRevision: opts.definitionRevision }, workerMarkers).boundary());
      };
      const finalize = async (markers: readonly string[]) => {
        finalized = true;
        acceptMarkers(await privateFinalize!(markers));
        return workerMarkers;
      };
      const fail = (message: string): void => {
        const safeMessage = redactText(message);
        if (!opts.privateEvidenceIpc) err(`[stress-worker ${opts.shardId}] ${safeMessage}`);
        const failure: ShardFailure = { protocolVersion: 2, ok: false, shardId: opts.shardId, error: safeMessage };
        out(JSON.stringify(failure));
        process.exitCode = 1;
      };
      try {
        const durationMs = validateCliStressTermination(opts);
        validateStressRunOptions(opts);
        validateCoreStressRunOptions({
          concurrency: opts.concurrency,
          ...(opts.iterations !== undefined ? { maxIterations: opts.iterations } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          ...(opts.maxRps !== undefined ? { maxRps: opts.maxRps } : {}),
        });
        const workerDurationMs = durationMs;
        if (!existsSync(join(opts.workspace, "apicc.workspace.yaml"))) {
          throw new Error(`未找到 apicc.workspace.yaml: ${opts.workspace}`);
        }
        const confirmedTargetOrigins = [...new Set((opts.allowTarget ?? []).map(validateStressOriginOption))];
        const credentialVersions = parseExpectedCredentialVersions(opts.credentialVersions);
        let preparedTestData: PreparedTestData | undefined;
        if (opts.preparedDataStdin) {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of process.stdin) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.length;
            if (size > 128 * 1024 * 1024) throw new Error("worker 准备数据消息超过容量限制");
            chunks.push(buffer);
          }
          try { preparedTestData = PreparedTestDataSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch { throw new Error("worker 准备数据消息无效"); }
        }
        const targetInfo = await resolveStressTarget(
          registry,
          opts.workspace,
          apiPath,
          opts.case,
          opts.env,
          credentialHostOptions(deps),
          { definitionRevision: opts.definitionRevision, credentialVersions, networkIdentity: opts.networkIdentity, ...(preparedTestData === undefined ? {} : { preparedTestData }) },
        );
        const sanitizer = createOutputSanitizer(targetInfo.prepared.secrets);
        workerMarkers = targetInfo.prepared.secrets;
        redactText = sanitizer.redactText;
        const effectiveMaxRps = opts.maxRps === undefined
          ? targetInfo.project.stressPolicy?.maxRps
          : targetInfo.project.stressPolicy?.maxRps === undefined
            ? opts.maxRps : Math.min(opts.maxRps, targetInfo.project.stressPolicy.maxRps);
        if (targetInfo.project.stressPolicy?.maxConcurrency !== undefined && opts.concurrency > targetInfo.project.stressPolicy.maxConcurrency) {
          throw new StressSafetyError(
            "concurrency_policy_exceeded",
            `并发数 ${opts.concurrency} 超过项目上限 ${targetInfo.project.stressPolicy.maxConcurrency}`,
            targetInfo.targetOrigin,
          );
        }
        const samples: ShardResult["samples"] = [];
        const thresholds: StressThresholds = {
          ...(opts.maxErrorRate !== undefined ? { maxErrorRate: opts.maxErrorRate } : {}),
          ...(opts.maxAssertionFailureRate !== undefined ? { maxAssertionFailureRate: opts.maxAssertionFailureRate } : {}),
          ...(opts.maxP95Ms !== undefined ? { maxP95Ms: opts.maxP95Ms } : {}),
          ...(opts.minRps !== undefined ? { minRps: opts.minRps } : {}),
        };
        executionStarted = true;
        const report = await targetInfo.createRunner({
          ...(privateFinalize ? { finalizeEvidence: finalize } : { onEvidenceOutputBoundary: acceptBoundary }),
          onSample: (sample) => samples.push({
          requestTimeMs: sample.requestTimeMs ?? sample.timeMs ?? 0,
          scriptTimeMs: sample.scriptTimeMs ?? 0,
          iterationTimeMs: sample.iterationTimeMs ?? sample.requestTimeMs ?? sample.timeMs ?? 0,
          status: sample.status,
          ok: sample.ok,
          ...(sample.timeMs !== undefined ? { timeMs: sample.timeMs } : {}),
          ...(sample.error !== undefined ? { error: sample.failureKind ?? "execution-failed" } : {}),
          ...(sample.requestStarted !== undefined ? { requestStarted: sample.requestStarted } : {}),
          ...(sample.requestCompleted !== undefined ? { requestCompleted: sample.requestCompleted } : {}),
          ...(sample.failureKind !== undefined ? { failureKind: sample.failureKind } : {}),
          ...(sample.safety !== undefined ? { safety: sample.safety } : {}),
        }), concurrency: opts.concurrency, maxRps: effectiveMaxRps,
        confirmedTargetOrigins, connectionMode: opts.connectionMode,
        }).run({
          concurrency: opts.concurrency,
          maxIterations: opts.iterations,
          ...(workerDurationMs !== undefined ? { durationMs: workerDurationMs } : {}),
          maxRps: effectiveMaxRps,
          ...(Object.keys(thresholds).length > 0 ? { thresholds } : {}),
          connectionMode: opts.connectionMode,
          safetyRun: {
            requestedConcurrency: opts.concurrency,
            effectiveConcurrency: opts.concurrency,
            requestedMaxRps: opts.maxRps ?? null,
            effectiveMaxRps: effectiveMaxRps ?? null,
            connectionMode: opts.connectionMode,
          },
        });
        if (!report.generator) throw new Error("worker 未生成 generator 指标");
        if (!report.measurementWindow) throw new Error("worker 未生成 pressure measurement window");
        const result: ShardResult = redactExecutionOutput({
          protocolVersion: 2, ok: true, shardId: opts.shardId, samples, generator: report.generator,
          failureEvidence: report.failureEvidence,
          measurementWindow: report.measurementWindow,
        }, workerBoundary ?? createExecutionEvidenceCollector({ projectId: "", definitionRevision: opts.definitionRevision }, workerMarkers).boundary());
        out(JSON.stringify(ShardOutcomeSchema.parse(result)));
        process.exitCode = 0;
      } catch (e) {
        if (privateFinalize && !finalized && !executionStarted) {
          try { await finalize(workerMarkers); }
          catch { fail("Private evidence completion failed; worker output withheld"); return; }
        }
        fail(e instanceof Error ? e.message : String(e));
      } finally {
        if (opts.privateEvidenceIpc && process.connected) process.disconnect?.();
      }
    });

  program
    .command("mock")
    .description("在前台为已保存项目提供本机 Mock HTTP 服务")
    .argument("<projectPath>", "项目完整 UUID 路径（groups/<groupId>/projects/<projectId>）")
    .option("--port <port>", "监听端口（0 表示自动选择）", (value: string) => {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("--port 必须是 0 到 65535 之间的整数");
      return port;
    }, 0)
    .option("--seed <seed>", "仅本次进程覆盖已保存的 Mock seed；不会写回项目")
    .action(async (projectPath: string, opts: { port: number; seed?: string }) => {
      if (opts.seed !== undefined && opts.seed.length === 0) throw new Error("--seed 必须是非空字符串");
      const root = findWorkspaceRoot(process.cwd());
      if (!root) throw new Error("未找到 apicc.workspace.yaml——请在工作区内执行");
      const state = await loadWorkspace(registry, root);
      assertWorkspaceUsable(state);
      const { project } = locateProject(state.workspace, projectPath);
      if (!project.mock) throw new Error(`项目没有已保存的 Mock 配置: ${projectPath}`);
      const snapshot = createProjectSnapshot({
        ...project,
        mock: opts.seed === undefined ? project.mock : { ...project.mock, seed: opts.seed },
      });
      const compiled = compileProjectMock(snapshot);
      if (!compiled.ok) {
        const summary = compiled.diagnostics.filter((item) => item.severity === "error").map((item) => `${item.path}: ${item.message}`).join("; ");
        throw new Error(summary || "Mock 项目编译失败");
      }
      const handle = await startMockServer(compiled.plan, { port: opts.port });
      const { address, port } = handle.address;
      const host = address.includes(":") ? `[${address}]` : address;
      log(`MOCK_READY http://${host}:${port} revision=${compiled.plan.sourceProjectRevision}`);

      let stopPromise: Promise<void> | undefined;
      let finish!: () => void;
      const terminated = new Promise<void>((resolve) => { finish = resolve; });
      const stop = () => {
        if (stopPromise) return;
        stopPromise = handle.stop();
        void stopPromise.then(finish, (error: unknown) => {
          process.exitCode = 1;
          log(`Mock server stop failed: ${error instanceof Error ? error.message : String(error)}`);
          finish();
        });
      };
      const signals: NodeJS.Signals[] = process.platform === "win32"
        ? ["SIGINT", "SIGTERM", "SIGBREAK"]
        : ["SIGINT", "SIGTERM"];
      for (const signal of signals) process.once(signal, stop);
      try {
        await terminated;
      } finally {
        for (const signal of signals) process.off(signal, stop);
        if (stopPromise) await stopPromise;
        else await handle.stop();
      }
    });

  program
    .command("export")
    .description("导出当前项目的 Markdown、HTML 或 OpenAPI 文档")
    .argument("<projectPath>", "项目完整 UUID 路径（groups/<groupId>/projects/<projectId>）")
    .requiredOption("--format <format>", "导出格式：markdown、html、openapi-3.0 或 openapi-3.1")
    .requiredOption("--output <path>", "输出文件路径")
    .option("--encoding <encoding>", "OpenAPI 编码：json 或 yaml", "json")
    .option("--info-version <version>", "OpenAPI info.version（不影响 OpenAPI 规范版本）")
    .option("--allow-lossy", "确认接受诊断中列出的 OpenAPI 语义损失", false)
    .option("--collection <id...>", "仅导出所选模块中的接口")
    .option("--api <id...>", "仅导出所选接口")
    .option("--tag <tag...>", "导出任一命中所选标签的接口")
    .action(async (projectPath: string, opts: {
      format: string;
      output: string;
      encoding: string;
      infoVersion?: string;
      allowLossy: boolean;
      collection?: string[];
      api?: string[];
      tag?: string[];
    }) => {
      const openapiFormat = opts.format === "openapi-3.0" || opts.format === "openapi-3.1";
      if (opts.format !== "markdown" && opts.format !== "html" && !openapiFormat) {
        throw new Error("--format 只支持 markdown、html、openapi-3.0 或 openapi-3.1");
      }
      if (openapiFormat && opts.encoding !== "json" && opts.encoding !== "yaml") {
        throw new Error("--encoding 只支持 json 或 yaml");
      }
      if (!opts.output.trim()) throw new Error("--output 必须提供文件路径");
      const filters = [opts.collection, opts.api, opts.tag].filter((filter) => filter !== undefined);
      if (filters.length > 1) throw new Error("--collection、--api、--tag 只能选择一种范围");
      const scope: DocumentScope = opts.collection !== undefined
        ? { kind: "collections", collectionIds: opts.collection }
        : opts.api !== undefined
          ? { kind: "apis", contractIds: opts.api }
          : opts.tag !== undefined
            ? { kind: "tags", tags: opts.tag }
            : { kind: "project" };
      const parsedScope = DocumentScopeSchema.safeParse(scope);
      if (!parsedScope.success) throw new Error("文档导出范围无效");
      const root = findWorkspaceRoot(process.cwd());
      if (!root) throw new Error("未找到 apicc.workspace.yaml——请在工作区内执行");
      const state = await loadWorkspace(registry, root);
      assertWorkspaceUsable(state);
      const { project } = locateProject(state.workspace, projectPath);
      const snapshot = createProjectSnapshot(project);
      let content: string;
      let count: number;
      if (openapiFormat) {
        const result = exportOpenapi(snapshot, parsedScope.data, {
          version: opts.format === "openapi-3.0" ? "3.0" : "3.1",
          ...(opts.infoVersion === undefined ? {} : { infoVersion: opts.infoVersion }),
          allowLossy: opts.allowLossy,
        });
        for (const diagnostic of result.diagnostics) {
          log(`${diagnostic.severity.toUpperCase()} ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`);
        }
        if (result.blocked) throw new Error("OpenAPI 导出包含结构错误或未确认的语义损失；未写入输出文件");
        if (opts.encoding === "yaml") {
          const { stringify: stringifyYaml } = await import("yaml");
          content = stringifyYaml(result.document);
        } else {
          content = `${JSON.stringify(result.document, null, 2)}\n`;
        }
        count = Object.keys(result.document.paths as Record<string, unknown>).length;
      } else {
        const projection = buildDocumentProjection(snapshot, parsedScope.data);
        if (projection.apis.length === 0 || projection.diagnostics.some((diagnostic) => diagnostic.severity === "error" && diagnostic.path.startsWith("scope."))) {
          throw new Error("文档范围没有匹配的接口或包含无效目标；未写入输出文件");
        }
        content = opts.format === "html" ? renderDocumentHtml(projection) : renderDocumentMarkdown(projection);
        count = projection.apis.length;
      }
      try {
        writeDocumentAtomically(opts.output, content);
      } catch {
        throw new Error("文档导出失败：无法写入目标文件");
      }
      log(`文档已导出：${count} 个接口路径（${opts.format}${openapiFormat ? `/${opts.encoding}` : ""}）`);
    });

  program
    .command("export-design")
    .argument("<apiPath>", "接口完整 UUID 路径（groups/<groupId>/projects/<projectId>/collections/<collectionId>/.../apis/<apiId>）")
    .action(async (apiPath: string) => {
      const root = findWorkspaceRoot(process.cwd());
      if (!root) throw new Error("未找到 apicc.workspace.yaml");
      const { api, project } = await locateApiTarget(registry, root, apiPath);
      const snapshot = createProjectSnapshot(project);
      log(renderContractMarkdown(api, snapshot.context));
    });

  // stdio MCP 服务器（M6 规格 D5/D6）：把工作区能力暴露为 MCP 工具供 agent 客户端消费。
  // stdout 是 MCP 协议通道——命令自身零 stdout 输出，日志一律 stderr（裁定⑤，server.ts 内实现）；
  // run-case 执行类工具默认不注册，--allow-run 显式开启（裁定⑥）。连接前 fail-fast 校验工作区。
  program
    .command("mcp")
    .description("启动 stdio MCP 服务器（list-apis/get-api-design 只读 + run-case 需 --allow-run）")
    .requiredOption("--workspace <root>", "工作区根目录")
    .option("--allow-run", "注册执行类工具 run-case（默认只读）", false)
    .action(async (opts: { workspace: string; allowRun: boolean }) => {
      if (!existsSync(join(opts.workspace, "apicc.workspace.yaml"))) {
        throw new Error(`未找到 apicc.workspace.yaml: ${opts.workspace}`);
      }
      const { createMcpServer } = await import("./mcp/server.js");
      const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
      const server = createMcpServer(opts.workspace, { allowRun: opts.allowRun });
      const transport = new StdioServerTransport();
      await server.connect(transport);
      // 挂起至客户端断开：包装 SDK 的 onclose——先保留其内部清理，再放行命令返回（退出码 0）。
      await new Promise<void>((resolve) => {
        const priorOnClose = transport.onclose?.bind(transport);
        transport.onclose = () => {
          priorOnClose?.();
          resolve();
        };
      });
    });

  // AI 用例建议（M6-A D8）：基于接口定义经用户自备的 OpenAI 兼容端点生成候选用例，
  // YAML 输出供人工审阅后并入——绝不自动写回接口（D2 人审采用硬边界）；密钥只进 config 不进日志。
  const ai = program.command("ai").description("AI 能力命令组");
  ai
    .command("suggest-cases")
    .argument("<apiPath>", "接口完整 UUID 路径（直接使用工作区存储树路径）")
    .option("--instruction <text>", "用户补充指令（如「补充边界用例」）")
    .option("--limit <n>", "候选用例条数上限", Number)
    .option("--out <file>", "候选用例 YAML 输出文件（缺省打印 stdout）")
    .action(async (apiPath: string, opts: { instruction?: string; limit?: number; out?: string }) => {
      const root = findWorkspaceRoot(process.cwd());
      if (!root) throw new Error("未找到 apicc.workspace.yaml——请在工作区内执行");
      // 裁定⑥：--limit 传给 core 前 clamp（正整数门，可读报错）。
      if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
        throw new Error(`limit 必须为正整数，收到 ${opts.limit}`);
      }
      const { api, project } = await locateApiTarget(registry, root, apiPath);
      const provider = createAiProvider(resolveAiConfig({ env: deps.aiEnv, homeDir: deps.aiHomeDir }));
      const { suggestCases } = await import("@apicc/core");
      const snapshot = createProjectSnapshot(project);
      const cases = await suggestCases(api, snapshot.context, { provider, instruction: opts.instruction, limit: opts.limit });
      const { stringify: stringifyYaml } = await import("yaml");
      const yamlText = stringifyYaml({ cases });
      if (opts.out) {
        writeFileSync(opts.out, yamlText);
        log(`已生成 ${cases.length} 条 AI 候选用例（未写入接口，供人工审阅采用）→ ${opts.out}`);
      } else {
        log(`已生成 ${cases.length} 条 AI 候选用例（未写入接口，供人工审阅采用）：`);
        log(yamlText);
      }
    });

  // Import: preview by default; project creation and explicit single-module merge share the Core plan.
  program
    .command("import")
    .argument("<file>", "导入文件路径")
    .option("--group <name>", "新增项目的目标分组名")
    .option("--target-collection <path>", "显式合并目标集合 locator，例如 groups/<group>/projects/<project>/collections/<collection>")
    .addOption(new Option("--policy <action>", "冲突策略：skip|rename|overwrite|cancel").choices(["skip", "rename", "overwrite", "cancel"]))
    .option("--target-api <id>", "歧义覆盖时显式选择稳定的目标 API ID（可重复）", collectOption, [])
    .option("--yes", "跳过预览直接写入", false)
    .option("--allow-lossy", "确认接受导入语义损失；与 --yes 分开", false)
    .action(async (file: string, opts: {
      group?: string;
      targetCollection?: string;
      policy?: ImportMergeAction;
      targetApi: string[];
      yes: boolean;
      allowLossy: boolean;
    }) => {
      const root = findWorkspaceRoot(process.cwd());
      if (!root) throw new Error("未找到 apicc.workspace.yaml");
      const content = readFileSync(file, "utf8");
      const importer = registry.listImporters().find((i) => i.detect(file, content));
      if (!importer) throw new Error("无法识别的导入格式");
      const imported = importer.parse(content);
      const project = ContractProjectSchema.parse(imported.project);
      const merging = opts.targetCollection !== undefined;
      const diagnostics = merging
        ? normalizeImportDiagnostics(imported)
        : [...normalizeImportDiagnostics(imported), ...projectAssetImportDiagnostics(project)];
      let conflictPolicy: ImportMergeAction | undefined;
      if (merging) {
        if (opts.group !== undefined) throw new Error("--target-collection 合并模式不能同时指定 --group。");
        if (opts.policy === undefined) throw new Error("合并模式必须显式指定 --policy。");
        conflictPolicy = opts.policy;
      } else {
        if (!opts.group) throw new Error("新增项目模式必须指定 --group。");
        if (opts.policy !== undefined || opts.targetApi.length > 0) {
          throw new Error("--policy 和 --target-api 仅用于 --target-collection 合并模式。");
        }
      }
      const storage = registry.getStorage()!;
      const loaded = await storage.load(root);
      assertWorkspaceUsable(loaded);
      const workspace = structuredClone(loaded.workspace);
      let mergePlan: ReturnType<typeof buildImportMergePlan> | undefined;
      if (merging) {
        const target = locateCollection(workspace, opts.targetCollection!);
        const sourceIds = project.collections.map((collection) => collection.id);
        const sourceApis = projectApis(project, new Set(sourceIds));
        const targetApis = projectApis(target.project, new Set([target.collection.id]));
        if (opts.targetApi.length > 0 && conflictPolicy !== "overwrite") throw new Error("--target-api 仅适用于 --policy overwrite。");
        const decisions: Record<string, ImportMergeItemDecision> = {};
        const usedTargetIds = new Set<string>();
        for (const source of sourceApis) {
          const matches = targetApis.filter((candidate) => sameImportRoute(candidate, source));
          if (matches.length === 0) continue;
          const selections = opts.targetApi.filter((id) => matches.some((candidate) => candidate.contract.id === id));
          if (selections.length > 1) throw new Error(`API ${redactImportOutput(source.contract.metadata.name)} 有多个 --target-api 选择，请只保留一个目标 ID。`);
          const targetApiId = selections[0];
          if (targetApiId) usedTargetIds.add(targetApiId);
          decisions[source.contract.id] = {
            action: conflictPolicy!,
            ...(targetApiId === undefined ? {} : { targetApiId }),
          };
        }
        if (opts.targetApi.some((id) => !usedTargetIds.has(id))) throw new Error("--target-api 必须是预览中该冲突路由列出的目标 API ID。");
        mergePlan = buildImportMergePlan(target.project, project, {
          targetCollectionId: target.collection.id,
          sourceCollectionIds: sourceIds,
          decisions,
        });
        diagnostics.push(...mergePlan.diagnostics.map((item) => ({
          severity: item.severity,
          code: item.code,
          path: redactImportOutput(item.path),
          message: redactImportOutput(item.message),
          lossy: item.lossy,
        })));
        if (!mergePlan.cancelled && !mergePlan.diagnostics.some((item) => item.severity === "error")) {
          const group = workspace.groups.find((candidate) => candidate.id === target.group.id)!;
          const targetIndex = group.projects.findIndex((candidate) => candidate.id === target.project.id);
          group.projects[targetIndex] = mergePlan.project;
        }
        log(`预览：合并「${redactImportOutput(project.name)}」到显式目标集合「${redactImportOutput(target.collection.name)}」`);
        log(`计划：新增 ${mergePlan.summary.added} · 覆盖 ${mergePlan.summary.overwritten} · 跳过 ${mergePlan.summary.skipped}`);
        for (const entry of mergePlan.entries) {
          log(`  [${entry.status}] ${redactImportOutput(`${entry.method} ${entry.path} · ${entry.sourceName}`)}`);
          const targetChoices = entry.targetApiIds.flatMap((id) => {
            const candidate = targetApis.find((api) => api.contract.id === id);
            return candidate ? [`${redactImportOutput(candidate.contract.metadata.name)} (${id})`] : [];
          });
          if (targetChoices.length > 1) log(`    覆盖目标候选：${targetChoices.join(" · ")}；再次调用时用 --target-api <id> 显式选择。`);
        }
      } else {
        const group = workspace.groups.find((candidate) => candidate.name === opts.group);
        const newProjectGroup = group ?? { id: randomUUID(), name: opts.group!, projects: [] };
        if (!group) workspace.groups.push(newProjectGroup);
        // Keep the legacy behavior: same-name projects coexist by identity.
        newProjectGroup.projects.push(project);
        log(`预览：将导入项目「${redactImportOutput(project.name)}」（集合 ${project.collections.length} 个）到分组「${redactImportOutput(opts.group!)}」`);
        log(`计划：新增项目 1`);
      }
      for (const diagnostic of diagnostics) {
        log(`[${diagnostic.severity === "error" ? "错误" : "警告"}${diagnostic.lossy ? " · 有损" : ""}] ${diagnostic.code}: ${diagnostic.message}`);
      }
      if (!opts.yes) {
        log("预览未写入工作区；确认写入请加 --yes。若计划包含有损诊断，还须单独加 --allow-lossy。");
        return;
      }
      if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) throw new Error("导入包含结构、引用或冲突错误，不能写入。");
      if (diagnostics.some((diagnostic) => diagnostic.lossy) && !opts.allowLossy) throw new Error("导入包含语义损失；请显式加 --allow-lossy 确认后再应用。");
      if (mergePlan?.cancelled) {
        log("合并已取消；工作区未更改。");
        return;
      }
      if (mergePlan && mergePlan.summary.added + mergePlan.summary.overwritten === 0) {
        log("合并计划没有变更；工作区未更改。");
        return;
      }
      await storage.save(root, workspace, { expectedRevision: loaded.revision, deletions: [] });
      if (merging) log(`已原子合并到集合「${redactImportOutput(locateCollection(workspace, opts.targetCollection!).collection.name)}」`);
      else log(`已导入项目「${redactImportOutput(project.name)}」到分组「${redactImportOutput(opts.group!)}」`);
    });

  // M7-A：插件管理命令组——list 展示已加载（name/version/贡献计数）与失败项原因（D3/D5 展示口径）。
  // 加载摘要来自命令分发前的 preAction 钩子；启用/停用 = 编辑用户级清单或 --no-plugins。
  const pluginsCmd = program.command("plugins").description("插件管理命令组");
  pluginsCmd
    .command("list")
    .description("列出用户级清单加载的插件与失败项")
    .action(async () => {
      if (pluginsDisabled) log("插件加载已关闭（--no-plugins 或注入关闭）");
      const loaded = pluginLoad?.loaded ?? [];
      const problems = pluginLoad?.problems ?? [];
      if (loaded.length === 0) {
        log("未加载任何插件");
      } else {
        log(`已加载 ${loaded.length} 个插件：`);
        for (const p of loaded) {
          const c = p.contributions;
          log(
            `  ${p.name}@${p.version}（协议 ${c.protocols} · 认证 ${c.auths} · 断言 ${c.asserts}`
              + ` · 脚本 ${c.scriptEngines} · 报告 ${c.reporters} · 导入器 ${c.importers}）`,
          );
        }
      }
      for (const pr of problems) log(`[加载失败] ${pr.file}: ${pr.message}`);
    });

  // M7-A D6：插件脚手架——生成本地目录（模板内联字符串，裁定①），名称前缀警告不阻断（约定非强制）。
  program
    .command("create-plugin")
    .description("生成 apicc 插件包脚手架（package.json/src/test/tsconfig/README）")
    .argument("<name>", "插件包名（约定 apicc-plugin- 前缀）")
    .option("--dir <path>", "生成目标目录（缺省当前目录）", process.cwd())
    .action(async (name: string, opts: { dir: string }) => {
      const result = generatePluginPackage(name, opts.dir);
      for (const w of result.warnings) log(`[警告] ${w}`);
      log(`已生成插件脚手架: ${result.dir}`);
      log("下一步：进入该目录 pnpm install → pnpm build → pnpm test（契约自检），详见目录内 README.md");
    });

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (e) {
    if (!(e as { handled?: boolean }).handled) throw e;
  }
  return process.exitCode ?? 0;
}

function writeDocumentAtomically(outputPath: string, content: string): void {
  const target = resolve(outputPath);
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
    renameSync(temporary, target);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* The temporary file was not created or was already moved. */ }
    throw error;
  }
}

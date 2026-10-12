import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePluginPackage } from "./create-plugin.js";
import {
  ShardOutcomeSchema,
  CurrentStressReportSchema,
  CollectionRunError,
  createAiProvider,
  createProjectSnapshot,
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
  createHttpClient,
  createSoapClient,
  createStressCaseSession,
  normalizeStressOrigin,
  resolveExecutionEnvironment,
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
  credentialScope,
  stableCredentialError,
  type CredentialHostOptions,
} from "./credentials.js";
import { createOutputSanitizer } from "./output.js";
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
  /** CLI 凭据保存注入：默认仅从 stdin 读取，永不接受 argv 明文。 */
  secretInput?: () => Promise<string>;
}

function credentialHostOptions(deps: RunCliDeps): CredentialHostOptions {
  return {
    ...(deps.secretStore ? { secretStore: deps.secretStore } : {}),
    ...(deps.credentialPrivateRoot ? { credentialPrivateRoot: deps.credentialPrivateRoot } : {}),
  };
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
      const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
      throw new Error(`shard ${ctx.shardId} 协议输出无效[protocol_invalid]：${detail}`);
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
 * 子进程 stderr 透传父进程 stderr。
 */
const defaultSpawnWorkerFactory = (shardTimeoutMs: number): SpawnWorker => (spec) =>
  new Promise<ShardOutcome>((resolve, reject) => {
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
    ];
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stderr?.pipe(process.stderr);
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      fn();
    };
    timer = setTimeout(() => {
      child.kill();
      settle(() => reject(new Error(`shard ${spec.shardId} 超时：${shardTimeoutMs}ms 内未完成，已终止子进程`)));
    }, shardTimeoutMs);
    child.on("error", (e: Error) => settle(() => reject(e)));
    child.on("close", (code) => settle(() => {
      try {
        resolve(parseShardOutcomeStdout(stdout, { shardId: spec.shardId, exitCode: code }));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    }));
  });

/** Prepare one immutable snapshot and the selected API's credentials for stress or its worker. */
async function resolveStressTarget(
  registry: PluginRegistry,
  root: string,
  apiPath: string,
  caseId: string,
  envName: string | undefined,
  credentialOptions: CredentialHostOptions = {},
  expected?: { definitionRevision: string; credentialVersions: Readonly<Record<string, string>> },
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
    expected?.credentialVersions, expected?.definitionRevision);
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
        onSample: options.onSample,
        createWorker: (workerId) => {
          let ownedHttp: ReturnType<typeof createHttpClient> | undefined;
          let ownedSoap: ReturnType<typeof createSoapClient> | undefined;
          const createOwnedHttp = () => ownedHttp ??= createHttpClient({ connectionMode: options.connectionMode });
          return createStressCaseSession(target, {
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
            createManagedClient: () => defaultClient.name === "http" || defaultClient.name === "soap"
              ? createOwnedHttp()
              : { ...defaultClient, close: async () => {} },
          }, {
            workerId,
            concurrency: options.concurrency,
            maxRps,
            confirmedTargetOrigins: options.confirmedTargetOrigins,
          });
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
  const { Command } = await import("commander");
  const program = new Command();
  program.name("apicc").description("apicc 命令行——接口定义与测试驱动开发").version("0.1.0");

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
      try {
        await store.put(credentialScope(state.workspace, group.id, project), ref, value);
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
      try {
        await createCredentialHostStore(credentialHostOptions(deps))
          .remove(credentialScope(state.workspace, group.id, project), ref);
      } catch (error) {
        throw stableCredentialError(error);
      }
      log(`凭据已移除：${projectPath} ${ref.id}`);
    });

  program
    .command("run")
    .argument("<collectionPath>", "集合完整 UUID 路径（groups/<groupId>/projects/<projectId>/collections/<collectionId>）")
    .requiredOption("--env <name>", "环境名称")
    .option("--reporters <list>", "报告格式，逗号分隔", "html")
    .option("--runs-dir <dir>", "运行历史输出目录")
    .option("--fail-fast", "首个失败后停止", false)
    .action(async (collectionPath: string, opts: { env: string; reporters: string; runsDir?: string; failFast: boolean }) => {
      const root = findWorkspaceRoot(process.cwd());
      if (!root) throw new Error("未找到 apicc.workspace.yaml——请在工作区内执行");
      const state = await loadWorkspace(registry, root);
      assertWorkspaceUsable(state);
      const location = locateCollection(state.workspace, collectionPath);
      const { collection, project } = location;
      const env = project.environments.find((candidate) => candidate.name === opts.env);
      if (!env) throw new Error(`未找到环境: ${opts.env}`);

      const prepared = await prepareExecutionRun(
        state.workspace,
        location.group.id,
        project,
        apiAssetsWithExecutableCases(project, apiAssetsInCollection(collection), env),
        credentialHostOptions(deps),
      );
      const sanitizer = createOutputSanitizer(prepared.secrets);
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
      let runFailure = false;
      try {
        result = await runner.run(prepared.run, collection.id, { environmentId: env.id });
      } catch (error) {
        if (!(error instanceof CollectionRunError)) throw error;
        result = error.partialResult;
        runFailure = true;
        safeLog(sanitizer.redactText(error.message));
      }
      const safeResult = sanitizer.redactValue(result);
      mkdirSync(runsOutDir, { recursive: true });
      writeFileSync(join(runsOutDir, `run-${nextRunFileId()}.json`), JSON.stringify(safeResult, null, 2));
      for (const format of opts.reporters.split(",")) {
        const reporter = registry.getReporter(format.trim());
        if (!reporter) throw new Error(`未注册报告格式: ${format}`);
        const file = await reporter.render(safeResult, runsOutDir);
        safeLog(`报告已生成: ${file}`);
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
    .action(async (workflowPath: string, opts: { env?: string; forceDraft: boolean; strict: boolean; reporters: string; runsDir?: string }) => {
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
      const prepared = await prepareExecutionRun(state.workspace, location.group.id, project, workflowAssets, credentialHostOptions(deps));
      const sanitizer = createOutputSanitizer(prepared.secrets);
      const safeLog = (line: string): void => log(sanitizer.redactText(line));
      const runner = new WorkflowRunner({ registry, environmentId: env?.id, failFast: false, strict: opts.strict });
      const wfr = sanitizer.redactValue(await runner.run(prepared.run, workflow.id, { environmentId: env?.id }));
      const result = sanitizer.redactValue(workflowToRunResult(wfr));
      // The projected raw result is durable before any reporter is invoked.
      const runsOutDir = opts.runsDir ?? join(root, ".apicc", "runs");
      mkdirSync(runsOutDir, { recursive: true });
      writeFileSync(join(runsOutDir, `workflow-${wfr.workflowId}-${randomUUID()}.json`), JSON.stringify(wfr, null, 2));
      for (const format of opts.reporters.split(",")) {
        const reporter = registry.getReporter(format.trim());
        if (!reporter) throw new Error(`未注册报告格式: ${format}`);
        const file = await reporter.render(result, runsOutDir);
        safeLog(`报告已生成: ${file}`);
      }
      for (const w of wfr.warnings) safeLog(`[警告] ${w}`);
      for (const node of wfr.nodeResults) {
        if (node.state === "skipped") {
          safeLog(`[跳过] 节点 ${node.nodeId}：${node.skipReason === "condition-pruned" ? "条件不满足" : node.skipReason ?? "未知原因"}`);
        }
      }
      safeLog(`节点统计：总计 ${wfr.total} · 通过 ${wfr.passed} · 失败 ${wfr.failed} · 跳过 ${wfr.skipped}`);
      process.exitCode = wfr.verdict === "failed" || wfr.failed > 0 ? 1 : 0;
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
      report = sanitizer.redactValue(report);
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
    .action(async (apiPath: string, opts: {
      case: string; env?: string; concurrency: number; iterations?: number; duration?: number; maxRps?: number;
      maxErrorRate?: number; maxAssertionFailureRate?: number; maxP95Ms?: number; minRps?: number;
      connectionMode: "pooled" | "fresh"; allowTarget: string[]; shardId: string; workspace: string;
      definitionRevision: string; credentialVersions: string;
    }) => {
      const out = deps.workerOut ?? ((line: string) => { process.stdout.write(`${line}\n`); });
      const err = deps.workerErr ?? ((line: string) => { console.error(line); });
      let redactText = (line: string): string => line;
      const fail = (message: string): void => {
        const safeMessage = redactText(message);
        err(`[stress-worker ${opts.shardId}] ${safeMessage}`);
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
        const targetInfo = await resolveStressTarget(
          registry,
          opts.workspace,
          apiPath,
          opts.case,
          opts.env,
          credentialHostOptions(deps),
          { definitionRevision: opts.definitionRevision, credentialVersions },
        );
        const sanitizer = createOutputSanitizer(targetInfo.prepared.secrets);
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
        const report = await targetInfo.createRunner({
          onSample: (sample) => samples.push(sanitizer.redactValue({
          requestTimeMs: sample.requestTimeMs ?? sample.timeMs ?? 0,
          scriptTimeMs: sample.scriptTimeMs ?? 0,
          iterationTimeMs: sample.iterationTimeMs ?? sample.requestTimeMs ?? sample.timeMs ?? 0,
          status: sample.status,
          ok: sample.ok,
          ...(sample.timeMs !== undefined ? { timeMs: sample.timeMs } : {}),
          ...(sample.error !== undefined ? { error: sample.error } : {}),
          ...(sample.requestStarted !== undefined ? { requestStarted: sample.requestStarted } : {}),
          ...(sample.requestCompleted !== undefined ? { requestCompleted: sample.requestCompleted } : {}),
          ...(sample.failureKind !== undefined ? { failureKind: sample.failureKind } : {}),
          ...(sample.safety !== undefined ? { safety: sample.safety } : {}),
        })), concurrency: opts.concurrency, maxRps: effectiveMaxRps,
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
        const result: ShardResult = sanitizer.redactValue({
          protocolVersion: 2, ok: true, shardId: opts.shardId, samples, generator: report.generator,
          measurementWindow: report.measurementWindow,
        });
        out(JSON.stringify(ShardOutcomeSchema.parse(result)));
        process.exitCode = 0;
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
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

  // 非交互导入（任务 7）：默认只预览，--yes 确认写入；分组不存在则创建，同名项目并存（轨一同名放开）。
  program
    .command("import")
    .argument("<file>", "导入文件路径")
    .requiredOption("--group <name>", "目标分组名")
    .option("--yes", "跳过预览直接写入", false)
    .action(async (file: string, opts: { group: string; yes: boolean }) => {
      const root = findWorkspaceRoot(process.cwd());
      if (!root) throw new Error("未找到 apicc.workspace.yaml");
      const content = readFileSync(file, "utf8");
      const importer = registry.listImporters().find((i) => i.detect(file, content));
      if (!importer) throw new Error("无法识别的导入格式");
      const { project, warnings } = importer.parse(content);
      if (!opts.yes) {
        log(`预览：将导入项目「${project.name}」（集合 ${project.collections.length} 个）`);
        for (const w of warnings) log(`[警告] ${w}`);
        log("非交互模式请加 --yes 确认写入");
        return;
      }
      const storage = registry.getStorage()!;
      const { workspace, revision } = await storage.load(root);
      let group = workspace.groups.find((x) => x.name === opts.group);
      if (!group) { group = { id: crypto.randomUUID(), name: opts.group, projects: [] }; workspace.groups.push(group); }
      // 同名放开（轨一）：同名项目直接并存（id 为身份），不再拒绝
      group.projects.push(project);
      await storage.save(root, workspace, { expectedRevision: revision, deletions: [] });
      for (const w of warnings) log(`[警告] ${w}`);
      log(`已导入项目「${project.name}」到分组「${opts.group}」`);
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

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ShardOutcomeSchema,
  createAiProvider,
  type AiProviderConfig,
  type ApiDefinition,
  type Collection,
  type PluginRegistry,
  type Project,
  type ProtocolClient,
  type ShardFailure,
  type ShardOutcome,
  type ShardResult,
  type SpawnWorker,
  type StressReport,
  type StressRunner,
  type StressSample,
  type StressWorkerSpecBase,
  type Workspace,
} from "@apicc/core";

/** 路径分隔符归一为 "/"，使集合目录匹配与用户输入的正/反斜杠形态无关（Windows 兼容）。 */
function toSlash(p: string): string {
  return p.split("\\").join("/");
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

/**
 * 工作区接口定位（run-stress/stress-worker/ai suggest-cases 共享，不复制）：全树目录
 * （含 folders 内接口）按「全等或分隔符边界后缀」匹配，首个命中即止；design.md 存在时
 * 读入 api.design（与 export-design 同口径——api.yaml 不含设计正文，规格 §6/§8）。
 */
async function locateApiTarget(
  registry: PluginRegistry,
  root: string,
  apiPath: string,
): Promise<{ api: ApiDefinition; dir: string; project: Project; collection: Collection; workspace: Workspace }> {
  const storage = registry.getStorage();
  if (!storage) throw new Error("未注册存储适配器");
  const { workspace } = await storage.load(root);
  let hit: { api: ApiDefinition; dir: string; project: Project; collection: Collection } | undefined;
  const target = toSlash(apiPath);
  search:
  for (const g of workspace.groups) {
    for (const p of g.projects) {
      for (const c of p.collections) {
        const cDir = join(root, "groups", g.name, "projects", p.name, "collections", c.name);
        const candidates = [
          ...c.apis.map((a) => ({ api: a, dir: join(cDir, "apis", a.name) })),
          ...c.folders.flatMap((f) => f.apis.map((a) => ({ api: a, dir: join(cDir, "folders", f.name, "apis", a.name) }))),
        ];
        for (const cand of candidates) {
          const normalized = toSlash(cand.dir);
          if (normalized === target || normalized.endsWith(`/${target}`)) {
            hit = { ...cand, project: p, collection: c };
            break search;
          }
        }
      }
    }
  }
  if (!hit) throw new Error(`未找到接口: ${apiPath}`);
  if (existsSync(join(hit.dir, "design.md"))) hit.api.design = readFileSync(join(hit.dir, "design.md"), "utf8");
  return { ...hit, workspace };
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
}

/** CLI 入口绝对路径（dist/bin.js）：由本模块编译产物位置推导，子进程 worker 与父进程同一份安装。 */
function cliEntryPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "bin.js");
}

/**
 * 从 worker stdout 全文按行从末解析 ShardOutcome（裁定 B①：可导出纯函数，供单测直测）。
 * 日志污染行（非 JSON 或不过 schema）跳过，取末条合法协议行；全部非法时抛「协议输出无效」。
 */
export function parseShardOutcomeStdout(
  stdout: string,
  ctx: { shardId: string; exitCode?: number | null },
): ShardOutcome {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim() !== "");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = ShardOutcomeSchema.safeParse(JSON.parse(lines[i]!));
      if (parsed.success) return parsed.data;
    } catch {
      // 非 JSON 行（日志污染）跳过，继续向前找末条可解析协议行。
    }
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

/**
 * 采样记录客户端：委托内部客户端执行并按 StressRunner 同口径记录样本。
 * StressReport 不含原始样本（aggregate 只出聚合），worker 回传 ShardResult 需在客户端层拦截采集。
 */
function recordingClient(inner: ProtocolClient, samples: StressSample[]): ProtocolClient {
  return {
    name: `${inner.name}-recording`,
    canHandle: (request) => inner.canHandle(request),
    async execute(request, opts) {
      const t0 = performance.now();
      try {
        const res = await inner.execute(request, opts);
        samples.push({ timeMs: performance.now() - t0, status: res.status, ok: res.status >= 200 && res.status < 300 });
        return res;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        samples.push({ timeMs: performance.now() - t0, status: 0, ok: false, error: message });
        throw e;
      }
    },
  };
}

/**
 * 压测目标解析（run-stress 与 stress-worker 共享，不复制）：工作区加载、接口定位（与 run 命令
 * 同款分隔符边界后缀匹配）、用例门、env 解析、变量层组装与 StressRunner 工厂。
 * createRunner 可注入客户端——worker 模式传采样记录客户端以回传 ShardResult 样本。
 */
async function resolveStressTarget(
  registry: PluginRegistry,
  root: string,
  apiPath: string,
  caseId: string,
  envName: string | undefined,
): Promise<{ apiId: string; defaultClient: ProtocolClient; createRunner: (client?: ProtocolClient) => StressRunner }> {
  // 定位/env/resolver 与 ai suggest-cases 共享 helper（不复制）。
  const { api: stressedApi, project, collection, workspace } = await locateApiTarget(registry, root, apiPath);
  // 用例门：压测请求构造只依赖接口定义（case 参数/断言不参与采样），但目标用例必须存在。
  if (!stressedApi.cases.some((tc) => tc.id === caseId)) throw new Error(`未找到用例: ${caseId}`);
  // env 解析：未指定则不启用环境；指定但未命中显式报错（与 run-workflow 同款）。
  const env = envName ? project.environments.find((e) => e.name === envName) : undefined;
  if (envName && !env) throw new Error(`未找到环境: ${envName}`);
  const { StressRunner, buildStressRequest, builtinAuthProviders, mergedEnvVars, createVariableResolver } =
    await import("@apicc/core");
  // 变量层与 CollectionRunner 同源：[环境(继承链经 mergedEnvVars 合并), 集合, 项目, 全局]。
  const resolver = createVariableResolver({
    layers: [mergedEnvVars(env, project), collection.variables, project.variables, workspace.variables],
  });
  // M5 D5：默认客户端按接口协议从注册中心解析（probe = 已解析变量的可执行请求）——
  // WS/SOAP 接口压测由对应客户端承接，杜绝「SOAP 被静默按 HTTP 执行」；未知协议 fail-fast。
  const probe = buildStressRequest(stressedApi, resolver, builtinAuthProviders);
  const defaultClient = registry.getProtocol(probe);
  if (!defaultClient) {
    throw new Error(`未找到可处理该接口的协议客户端（protocol: ${probe.protocol ?? "http"}）`);
  }
  return {
    apiId: stressedApi.id,
    defaultClient,
    createRunner: (client = defaultClient) => new StressRunner({
      client,
      // 每次采样重跑工厂：动态变量（如 {{$uuid}}）逐请求变化，不做跨请求复用。
      buildRequest: () => buildStressRequest(stressedApi, resolver, builtinAuthProviders),
    }),
  };
}

export async function runCli(
  argv: string[],
  registry: PluginRegistry,
  log: (line: string) => void = console.log,
  deps: RunCliDeps = {},
): Promise<number> {
  // 进入时重置进程退出码：同进程多次调用 runCli（编程/测试场景）互不串扰，
  // 各命令只反映本次调用的结果（bin.ts 执行完毕后会把返回值写回 process.exitCode）。
  process.exitCode = 0;
  const { Command } = await import("commander");
  const program = new Command();
  program.name("apicc").description("apicc 命令行——接口定义与测试驱动开发").version("0.1.0");

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

  program
    .command("run")
    .argument("<collectionPath>", "集合目录（相对工作区根）")
    .requiredOption("--env <name>", "环境名称")
    .option("--reporters <list>", "报告格式，逗号分隔", "html")
    .option("--runs-dir <dir>", "运行历史输出目录")
    .option("--fail-fast", "首个失败后停止", false)
    .action(async (collectionPath: string, opts: { env: string; reporters: string; runsDir?: string; failFast: boolean }) => {
      const root = findWorkspaceRoot(process.cwd());
      if (!root) throw new Error("未找到 apicc.workspace.yaml——请在工作区内执行");
      const storage = registry.getStorage();
      if (!storage) throw new Error("未注册存储适配器");
      const { workspace } = await storage.load(root);
      let collectionDir: string | undefined;
      let collection: import("@apicc/core").Collection | undefined;
      let project: import("@apicc/core").Project | undefined;
      const target = toSlash(collectionPath);
      search:
      for (const g of workspace.groups) {
        for (const p of g.projects) {
          for (const c of p.collections) {
            const dir = join(root, "groups", g.name, "projects", p.name, "collections", c.name);
            const normalized = toSlash(dir);
            // 全等或按分隔符边界后缀匹配：避免 "api" 误命中 "xapi"；首个命中即止，重名集合取确定性首个。
            if (normalized === target || normalized.endsWith(`/${target}`)) {
              collection = c; project = p; collectionDir = dir;
              break search;
            }
          }
        }
      }
      if (!collection || !project) throw new Error(`未找到集合: ${collectionPath}`);
      const env = project.environments.find((e) => e.name === opts.env);
      if (!env) throw new Error(`未找到环境: ${opts.env}`);

      const { CollectionRunner } = await import("@apicc/core");
      const runner = new CollectionRunner({
        registry, bus: (await import("@apicc/core")).createEventBus(),
        timeouts: { connectTimeoutMs: 10_000, totalTimeoutMs: 30_000 },
        failFast: opts.failFast,
      });
      // 生成物隔离（规格 §6）：运行历史与报告默认写工作区根 .apicc/runs，不污染 Git 友好的数据树；
      // --runs-dir 仍可覆盖。原始结果 JSON 与报告同目录，run 后 validate 不会报假问题。
      const runsOutDir = opts.runsDir ?? join(root, ".apicc", "runs");
      const result = await runner.run(collection, env, project, workspace, { runsDir: runsOutDir });
      for (const format of opts.reporters.split(",")) {
        const reporter = registry.getReporter(format.trim());
        if (!reporter) throw new Error(`未注册报告格式: ${format}`);
        const file = await reporter.render(result, runsOutDir);
        log(`报告已生成: ${file}`);
      }
      log(`总计 ${result.total} · 通过 ${result.passed} · 失败 ${result.failed}`);
      process.exitCode = result.failed > 0 ? 1 : 0;
    });

  // 工作流运行（任务 8）：复用 run 命令的加载/定位/报告模式；结构校验（含环拒绝）由 WorkflowRunner
  // 内部执行，CLI 只负责目录定位、env 解析与草稿状态门。
  program
    .command("run-workflow")
    .argument("<workflowPath>", "工作流目录（相对工作区根，如 groups/g/projects/p/workflows/名）")
    .option("--env <name>", "环境名称")
    .option("--force-draft", "允许运行草稿（跳过生命周期与启用校验，仅结构校验）", false)
    .option("--reporters <list>", "报告格式，逗号分隔", "html")
    .option("--runs-dir <dir>", "运行历史输出目录")
    .action(async (workflowPath: string, opts: { env?: string; forceDraft: boolean; reporters: string; runsDir?: string }) => {
      const root = findWorkspaceRoot(process.cwd());
      if (!root) throw new Error("未找到 apicc.workspace.yaml——请在工作区内执行");
      const storage = registry.getStorage();
      if (!storage) throw new Error("未注册存储适配器");
      const { workspace } = await storage.load(root);
      let workflow: import("@apicc/core").Workflow | undefined;
      let project: import("@apicc/core").Project | undefined;
      const target = toSlash(workflowPath);
      search:
      for (const g of workspace.groups) {
        for (const p of g.projects) {
          for (const w of p.workflows) {
            const dir = join(root, "groups", g.name, "projects", p.name, "workflows", w.name);
            const normalized = toSlash(dir);
            // 与 run 同款匹配：全等或按分隔符边界后缀（避免误命中同名前缀）；首个命中即止。
            if (normalized === target || normalized.endsWith(`/${target}`)) {
              workflow = w; project = p;
              break search;
            }
          }
        }
      }
      if (!workflow || !project) throw new Error(`未找到工作流: ${workflowPath}`);
      // env 解析：未指定则不启用环境（执行器侧为空快照）；指定但未命中显式报错。
      const env = opts.env ? project.environments.find((e) => e.name === opts.env) : undefined;
      if (opts.env && !env) throw new Error(`未找到环境: ${opts.env}`);
      // 状态门：草稿默认拒绝，--force-draft 放行（生命周期与启用校验跳过，仅剩结构校验）。
      if (workflow.status === "draft" && !opts.forceDraft) {
        throw new Error("工作流为草稿，请先发布启用或加 --force-draft");
      }
      const { WorkflowRunner, workflowToRunResult } = await import("@apicc/core");
      // resolve：workspace 全树查找接口定义（含文件夹内接口）。
      const findApi = (apiId: string) => {
        for (const g of workspace.groups) for (const p of g.projects) for (const c of p.collections) {
          const api = c.apis.find((a) => a.id === apiId);
          if (api) return api;
          for (const f of c.folders) { const fa = f.apis.find((a) => a.id === apiId); if (fa) return fa; }
        }
        return undefined;
      };
      const runner = new WorkflowRunner({ registry, resolve: findApi, envName: env?.name, failFast: false });
      const wfr = await runner.run(workflow, { project, workspace });
      // 生成物隔离（规格 §6）：原始结果 JSON 与报告同目录（对齐 run 命令产物口径），默认 .apicc/runs。
      const runsOutDir = opts.runsDir ?? join(root, ".apicc", "runs");
      mkdirSync(runsOutDir, { recursive: true });
      writeFileSync(join(runsOutDir, `workflow-${wfr.workflowId}-${Date.now()}.json`), JSON.stringify(wfr, null, 2));
      const result = workflowToRunResult(wfr);
      for (const format of opts.reporters.split(",")) {
        const reporter = registry.getReporter(format.trim());
        if (!reporter) throw new Error(`未注册报告格式: ${format}`);
        const file = await reporter.render(result, runsOutDir);
        log(`报告已生成: ${file}`);
      }
      for (const w of wfr.warnings) log(`[警告] ${w}`);
      log(`总计 ${wfr.total} · 通过 ${wfr.passed} · 失败 ${wfr.failed} · 跳过 ${wfr.skipped}`);
      process.exitCode = wfr.failed > 0 ? 1 : 0;
    });

  // 压测运行（任务 4）：把 core 压测引擎（并发池执行 + 聚合报告）暴露为 CLI 命令；
  // 工作区定位、路径匹配、环境解析、产物目录均沿用 run/run-workflow 模式。断言不参与采样（M2-C 明确推迟）。
  // M2-D：--shards >1 走多 shard 协调（本地子进程 worker，spawn 实现可注入）；=1 保持既有进程内路径零行为变化。
  program
    .command("run-stress")
    .argument("<apiPath>", "接口目录（相对工作区根）")
    .requiredOption("--case <caseId>", "用例 ID")
    .option("--env <name>", "环境名称")
    .requiredOption("--concurrency <n>", "并发数", Number)
    .option("--iterations <n>", "总迭代数", Number)
    .option("--duration <s>", "持续秒数", Number)
    .option("--shards <n>", "分片数（>1 走多 shard 协调）", Number, 1)
    .option("--shard-timeout <s>", "单 shard 超时秒数", Number, 300)
    .option("--runs-dir <dir>", "报告输出目录")
    .action(async (apiPath: string, opts: { case: string; env?: string; concurrency: number; iterations?: number; duration?: number; shards: number; shardTimeout: number; runsDir?: string }) => {
      // 分片参数校验（正整数/正数）；maxIterations < shards 的 fail-fast 由 core planShards 中文报错，直接透传不拦截。
      if (!Number.isInteger(opts.shards) || opts.shards < 1) {
        throw new Error(`shards 必须为正整数，收到 ${opts.shards}`);
      }
      if (!Number.isFinite(opts.shardTimeout) || opts.shardTimeout <= 0) {
        throw new Error(`shard-timeout 必须为正数，收到 ${opts.shardTimeout}`);
      }
      // 数值参数守卫（终审顺修）：单/多 shard 路径口径必须一致——否则 concurrency 0 在多 shard 下被
      // planShards 静默升为每 shard 1（单机路径是 StressRunner 中文报错），NaN 类值会漏到
      // StressWorkerSpecSchema.parse 抛裸英文 ZodError。文案镜像 runner.ts 同款。
      if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
        throw new Error(`concurrency 必须为正整数，收到 ${opts.concurrency}`);
      }
      if (opts.iterations !== undefined && (!Number.isInteger(opts.iterations) || opts.iterations < 1)) {
        throw new Error(`iterations 必须为正整数，收到 ${opts.iterations}`);
      }
      const root = findWorkspaceRoot(process.cwd());
      if (!root) throw new Error("未找到 apicc.workspace.yaml——请在工作区内执行");
      // 终止条件二选一校验（与 StressRunner 约束一致，前置到 CLI 以面向用户的文案报错）。
      if (opts.iterations === undefined && opts.duration === undefined) {
        throw new Error("需要 --iterations 或 --duration");
      }
      // 定位/env/resolver 与 stress-worker 共享 helper（不复制）；校验通过才落协调或进程内执行。
      const { apiId, createRunner } = await resolveStressTarget(registry, root, apiPath, opts.case, opts.env);
      const durationMs = opts.duration === undefined ? undefined : opts.duration * 1000;
      // 产物隔离（规格 §6，对齐 run-workflow）：StressReport JSON 落 runs 目录，默认 .apicc/runs。
      const runsOutDir = opts.runsDir ?? join(root, ".apicc", "runs");
      mkdirSync(runsOutDir, { recursive: true });

      let report: StressReport;
      let shardFailureCount = 0;
      if (opts.shards === 1) {
        // 单 shard：既有进程内路径，零行为变化（裁定 C：不挂 distributed 段，保持 M2-C 报告原样）。
        report = await createRunner().run({ concurrency: opts.concurrency, maxIterations: opts.iterations, durationMs });
      } else {
        // 多 shard：构造 specBase（workspaceRoot 显式传给子进程 worker），协调器拆分/并发/汇聚。
        const { DistributedStressCoordinator } = await import("@apicc/core");
        const specBase: StressWorkerSpecBase = {
          apiPath,
          caseId: opts.case,
          envName: opts.env,
          concurrency: opts.concurrency,
          workspaceRoot: root,
          ...(opts.iterations !== undefined ? { maxIterations: opts.iterations } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
        };
        const shardTimeoutMs = opts.shardTimeout * 1000;
        const coordinator = new DistributedStressCoordinator();
        ({ report, shardFailureCount } = await coordinator.run(specBase, {
          shards: opts.shards,
          shardTimeoutMs,
          // 默认本地子进程 spawn（同值超时 kill，裁定 A）；测试注入进程内替身。
          spawnWorker: (deps.spawnWorkerFactory ?? defaultSpawnWorkerFactory)(shardTimeoutMs),
        }));
      }
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
      // 退出码：任一 shard 失败 → 1；否则沿用「全部请求失败且 total>0 → 1」
      // （压测关注面是性能画像而非断言成败）。
      process.exitCode = shardFailureCount > 0
        || (report.failed === report.totalRequests && report.totalRequests > 0) ? 1 : 0;
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
    .requiredOption("--shard-id <id>", "shard 标识（由协调端分配）")
    .requiredOption("--workspace <root>", "工作区根目录（由协调端传入）")
    .action(async (apiPath: string, opts: { case: string; env?: string; concurrency: number; iterations?: number; duration?: number; shardId: string; workspace: string }) => {
      const out = deps.workerOut ?? ((line: string) => { process.stdout.write(`${line}\n`); });
      const err = deps.workerErr ?? ((line: string) => { console.error(line); });
      const fail = (message: string): void => {
        err(`[stress-worker ${opts.shardId}] ${message}`);
        const failure: ShardFailure = { protocolVersion: 1, ok: false, shardId: opts.shardId, error: message };
        out(JSON.stringify(failure));
        process.exitCode = 1;
      };
      try {
        if (!existsSync(join(opts.workspace, "apicc.workspace.yaml"))) {
          throw new Error(`未找到 apicc.workspace.yaml: ${opts.workspace}`);
        }
        if (opts.iterations === undefined && opts.duration === undefined) {
          throw new Error("需要 --iterations 或 --duration");
        }
        const { defaultClient, createRunner } = await resolveStressTarget(registry, opts.workspace, apiPath, opts.case, opts.env);
        // 样本经记录客户端拦截采集（报告不含原始样本），跑完回传 ShardResult。
        // 记录客户端委托协议感知的默认客户端（M5 D5：WS/SOAP 压测由对应客户端承接）。
        const samples: StressSample[] = [];
        const runner = createRunner(recordingClient(defaultClient, samples));
        await runner.run({
          concurrency: opts.concurrency,
          maxIterations: opts.iterations,
          durationMs: opts.duration === undefined ? undefined : opts.duration * 1000,
        });
        const result: ShardResult = { protocolVersion: 1, ok: true, shardId: opts.shardId, samples };
        out(JSON.stringify(result));
        process.exitCode = 0;
      } catch (e) {
        fail(e instanceof Error ? e.message : String(e));
      }
    });

  program
    .command("export-design")
    .argument("<apiPath>", "接口目录（相对工作区根）")
    .action(async (apiPath: string) => {
      const root = findWorkspaceRoot(process.cwd());
      if (!root) throw new Error("未找到 apicc.workspace.yaml");
      const dir = join(root, apiPath);
      const { parse: parseYaml } = await import("yaml");
      const { ApiDefinitionSchema, renderDesignMarkdown } = await import("@apicc/core");
      const api = ApiDefinitionSchema.parse(parseYaml(readFileSync(join(dir, "api.yaml"), "utf8")));
      // 注：详细设计存于 design.md（api.yaml 不含 design 字段，规格 §6/§8），
      // 与 fileStorage.loadApiDir 的读取口径一致；简报测试要求导出内容包含设计正文。
      const designFile = join(dir, "design.md");
      if (existsSync(designFile)) api.design = readFileSync(designFile, "utf8");
      log(renderDesignMarkdown(api));
    });

  // AI 用例建议（M6-A D8）：基于接口定义经用户自备的 OpenAI 兼容端点生成候选用例，
  // YAML 输出供人工审阅后并入——绝不自动写回接口（D2 人审采用硬边界）；密钥只进 config 不进日志。
  const ai = program.command("ai").description("AI 能力命令组");
  ai
    .command("suggest-cases")
    .argument("<apiPath>", "接口目录（相对工作区根）")
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
      const { api } = await locateApiTarget(registry, root, apiPath);
      const provider = createAiProvider(resolveAiConfig({ env: deps.aiEnv, homeDir: deps.aiHomeDir }));
      const { suggestCases } = await import("@apicc/core");
      const cases = await suggestCases(api, { provider, instruction: opts.instruction, limit: opts.limit });
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

  // 非交互导入（任务 7）：默认只预览，--yes 确认写入；分组不存在则创建，同名项目拒绝。
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
      const { workspace } = await storage.load(root);
      let group = workspace.groups.find((x) => x.name === opts.group);
      if (!group) { group = { id: crypto.randomUUID(), name: opts.group, projects: [] }; workspace.groups.push(group); }
      if (group.projects.some((x) => x.name === project.name)) throw new Error(`项目已存在: ${project.name}`);
      group.projects.push(project);
      await storage.save(root, workspace);
      for (const w of warnings) log(`[警告] ${w}`);
      log(`已导入项目「${project.name}」到分组「${opts.group}」`);
    });

  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (e) {
    if (!(e as { handled?: boolean }).handled) throw e;
  }
  return process.exitCode ?? 0;
}

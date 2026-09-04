import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ShardOutcomeSchema,
  type PluginRegistry,
  type ProtocolClient,
  type ShardFailure,
  type ShardOutcome,
  type ShardResult,
  type SpawnWorker,
  type StressReport,
  type StressRunner,
  type StressSample,
  type StressWorkerSpecBase,
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

/** runCli 可注入依赖：worker 协议/日志通道与默认 SpawnWorker 工厂（测试注入替身即可进程内闭环）。 */
export interface RunCliDeps {
  /** stress-worker 协议行输出通道（默认真实 stdout——协调器按行解析的契约通道，裁定 B）。 */
  workerOut?: (line: string) => void;
  /** stress-worker 人类日志通道（默认 console.error → stderr；stdout 只许末行 JSON）。 */
  workerErr?: (line: string) => void;
  /** 默认 SpawnWorker 工厂（默认本地子进程实现；入参为 shard 超时毫秒，与协调器同值）。 */
  spawnWorkerFactory?: (shardTimeoutMs: number) => SpawnWorker;
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
): Promise<{ apiId: string; createRunner: (client?: ProtocolClient) => StressRunner }> {
  const storage = registry.getStorage();
  if (!storage) throw new Error("未注册存储适配器");
  const { workspace } = await storage.load(root);
  // 全树定位接口（含 folders 内接口）：目录形态 groups/g/projects/p/collections/c[/folders/f]/apis/<名>；
  // 匹配口径与 run 同款：全等或分隔符边界后缀（避免 "ok" 误命中 "xok"），首个命中即止。
  let api: import("@apicc/core").ApiDefinition | undefined;
  let project: import("@apicc/core").Project | undefined;
  let collection: import("@apicc/core").Collection | undefined;
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
            api = cand.api; project = p; collection = c;
            break search;
          }
        }
      }
    }
  }
  if (!api || !project || !collection) throw new Error(`未找到接口: ${apiPath}`);
  const stressedApi = api; // const 别名：供工厂闭包捕获（let 的收窄不跨闭包生效）。
  // 用例门：压测请求构造只依赖接口定义（case 参数/断言不参与采样），但目标用例必须存在。
  if (!stressedApi.cases.some((tc) => tc.id === caseId)) throw new Error(`未找到用例: ${caseId}`);
  // env 解析：未指定则不启用环境；指定但未命中显式报错（与 run-workflow 同款）。
  const env = envName ? project.environments.find((e) => e.name === envName) : undefined;
  if (envName && !env) throw new Error(`未找到环境: ${envName}`);
  const { StressRunner, buildStressRequest, httpClient, builtinAuthProviders, mergedEnvVars, createVariableResolver } =
    await import("@apicc/core");
  // 变量层与 CollectionRunner 同源：[环境(继承链经 mergedEnvVars 合并), 集合, 项目, 全局]。
  const resolver = createVariableResolver({
    layers: [mergedEnvVars(env, project), collection.variables, project.variables, workspace.variables],
  });
  return {
    apiId: stressedApi.id,
    createRunner: (client = httpClient) => new StressRunner({
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
        const { createRunner } = await resolveStressTarget(registry, opts.workspace, apiPath, opts.case, opts.env);
        const { httpClient } = await import("@apicc/core");
        // 样本经记录客户端拦截采集（报告不含原始样本），跑完回传 ShardResult。
        const samples: StressSample[] = [];
        const runner = createRunner(recordingClient(httpClient, samples));
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

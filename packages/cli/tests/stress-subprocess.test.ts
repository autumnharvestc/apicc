import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOAuthProfileHost, createProjectSnapshot, createUserPluginHost, fileStorage, ShardFailureSchema, ShardResultSchema, type OAuthProfileRecord, type SecretStore, type Workspace } from "@apicc/core";
import { createLocalStressWorkerDeps, runStressSchedule, createStressAccumulator, createStressRequestGate, createExecutionEvidenceCollector, legacyStressMetricPlan, createNetworkProfileHost, prepareTestData } from "@apicc/core";
import { localStressClock } from "../src/stressPlanCommand.js";
import { spawnLocalStressWorker } from "../src/stressWorkerTransport.js";
import * as stressTransport from "../src/stressWorkerTransport.js";
import { captureStressSubprocessEvidence } from "./helpers/stressSubprocessEvidence.js";

// 本文件覆盖 M2-D1 任务 3：defaultSpawnWorkerFactory 真实子进程端到端（任务 2 审查移交的覆盖缺口）。
// Windows 约束：spawn process.execPath + [dist/bin.js]，禁 shell:true。

const BIN_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");
const GROUP_ID = "00000000-0000-4000-8000-000000000002";
const PROJECT_ID = "00000000-0000-4000-8000-000000000004";
const COLLECTION_ID = "00000000-0000-4000-8000-000000000008";
const OK_API_ID = "00000000-0000-4000-8000-000000000011";
const BAD_API_ID = "00000000-0000-4000-8000-000000000012";
const SLOW_API_ID = "00000000-0000-4000-8000-000000000013";
const ASSERT_BAD_API_ID = "00000000-0000-4000-8000-000000000014";
const OK_CASE_ID = "00000000-0000-4000-8000-000000000015";
const BAD_CASE_ID = "00000000-0000-4000-8000-000000000016";
const SLOW_CASE_ID = "00000000-0000-4000-8000-000000000017";
const ASSERT_BAD_CASE_ID = "00000000-0000-4000-8000-000000000018";
const API_PATH = (apiId: string) => `groups/${GROUP_ID}/projects/${PROJECT_ID}/collections/${COLLECTION_ID}/apis/${apiId}`;

interface SpawnResult { code: number; signal: string | null; stdout: string; stderr: string }

/** 真实子进程执行 CLI（与 defaultSpawnWorkerFactory 同款传输：node 直接调 bin.js）。 */
function spawnCli(args: string[], cwd: string, diagnostics?: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const privateHome = mkdtempSync(join(tmpdir(), "apicc-stress-worker-home-"));
    const env = { ...process.env, HOME: privateHome, USERPROFILE: privateHome, APPDATA: join(privateHome, "Roaming"), LOCALAPPDATA: join(privateHome, "Local"), XDG_CONFIG_HOME: join(privateHome, "config") };
    const entry = diagnostics ? fileURLToPath(new URL("./fixtures/stress-diagnostic-cli.mjs", import.meta.url)) : BIN_PATH;
    const child = spawn(process.execPath, [entry, ...args], { cwd, env: { ...env, ...(diagnostics ? { APICC_TEST_STRESS_DIAGNOSTICS: diagnostics } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      rmSync(privateHome, { recursive: true, force: true });
      resolve({ code: code ?? -1, signal, stdout, stderr });
    });
    child.on("error", (error) => {
      rmSync(privateHome, { recursive: true, force: true });
      reject(error);
    });
  });
}

/** 读 runs 目录下最新的 stress-*.json 报告（文件名排序取末位，不依赖 readdir 目录序假设）。 */
function readLastReport(runsDir: string): Record<string, unknown> {
  const files = readdirSync(runsDir).filter((f) => f.startsWith("stress-") && f.endsWith(".json")).sort();
  expect(files.length).toBeGreaterThan(0);
  return JSON.parse(readFileSync(join(runsDir, files[files.length - 1]!), "utf8")) as Record<string, unknown>;
}

function apiAsset(id: string, name: string, path: string, caseId: string, caseName: string, assertions: Workspace["groups"][number]["projects"][number]["collections"][number]["apis"][number]["cases"][number]["assertions"] = []) {
  return {
    contract: {
      formatVersion: 1 as const, id,
      metadata: { name, description: "", tags: [], version: "1", status: "published" as const },
      request: {
        protocol: "http" as const, method: "GET" as const, baseUrl, path,
        pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" as const }, body: { kind: "none" as const },
      },
      responses: [],
    },
    documentation: "",
    cases: [{ id: caseId, name: caseName, scope: "base", parameters: {}, preOperations: [], postOperations: [], assertions }],
  };
}

let server: Server;
let baseUrl = "";
let receivedRequests = 0;
let lastAuthorization: string | undefined;
const soapConnections: number[] = [];
/** 本文件各用例创建的临时工作区根（afterAll 统一清理）。 */
const tempRoots: string[] = [];
const retainedRoots = new Set<string>();

beforeAll(async () => {
  // 裁定 A：e2e 依赖构建产物先于测试存在；缺失时给可读修复指引（pnpm test 已自动前置构建）。
  if (!existsSync(BIN_PATH)) {
    throw new Error(`未找到构建产物 ${BIN_PATH}——请先执行 pnpm build（pnpm test 脚本已自动前置构建）`);
  }
  // /x → 200（成功路径）；/boom → 500（全失败口径）；/slow → 8s 后才响应（触发 shard 超时崩溃）。
  // 端口动态，故每用例独立建工作区。
  server = createServer((req, res) => {
    receivedRequests += 1;
    lastAuthorization = req.headers.authorization;
    if (req.url === "/soap") { soapConnections.push(req.socket.remotePort!); res.setHeader("content-type", "text/xml"); res.end("<Envelope><Body>ok</Body></Envelope>"); return; }
    res.setHeader("content-type", "application/json");
    if (req.url === "/boom") {
      res.statusCode = 500;
      res.end(JSON.stringify({ ok: false }));
      return;
    }
    if (req.url === "/slow") {
      // worker 被超时 kill 后连接已销毁，延迟回写需容错；unref 避免拖住测试进程退出。
      res.on("error", () => {});
      const t = setTimeout(() => { res.end(JSON.stringify({ ok: true })); }, 8000);
      t.unref?.();
      return;
    }
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

/** Spawn an OS child running the CLI's real stress-worker command with synthetic injected SecretStore data. */
async function runV3PrivateWorker(args: string[], cwd: string, roots?: { oauth: string; network: string; pluginHome: string }, versions?: { access: string; refresh: string }) {
    const privateHome = mkdtempSync(join(tmpdir(), "apicc-oauth-worker-home-"));
    tempRoots.push(privateHome);
    const env = {
      ...process.env,
      HOME: privateHome,
      USERPROFILE: privateHome,
      APPDATA: join(privateHome, "Roaming"),
      LOCALAPPDATA: join(privateHome, "Local"),
      XDG_CONFIG_HOME: join(privateHome, "config"),
      APICC_TEST_OAUTH_ROOT: roots?.oauth,
      APICC_TEST_NETWORK_ROOT: roots?.network,
      APICC_TEST_PLUGIN_HOME: roots?.pluginHome,
      APICC_TEST_ACCESS_VERSION: versions?.access,
      APICC_TEST_REFRESH_VERSION: versions?.refresh,
      APICC_TEST_ACCESS_TOKEN: "synthetic-child-access-token",
    };
    const option = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
    const state = await fileStorage.load(cwd), project = state.workspace.groups[0]!.projects[0]!, snapshot = createProjectSnapshot(project);
    const networkHost = await createNetworkProfileHost({ workspaceRoot: cwd, project: { workspaceId: state.workspace.id, groupId: GROUP_ID, projectId: PROJECT_ID },
      secretStore: { async put() {}, async remove() {}, async resolve() { throw new Error("No network credentials in this fixture"); }, async version() { throw new Error("No network credentials in this fixture"); }, async status() { return "missing"; } },
      environmentId: option("--env") ? project.environments.find((env) => env.name === option("--env"))?.id : undefined, privateRoot: roots?.network ?? join(privateHome, "network") });
    const network = await networkHost.prepare();
    const preparedTestData = await prepareTestData(snapshot, [{ locator: { collectionId: COLLECTION_ID, folderIds: [], apiId: args[1]!.split("/").at(-1)!, caseId: option("--case")!, scope: "base" } }], { workspaceRoot: cwd });
    const runId = globalThis.crypto.randomUUID(), metricPlan = legacyStressMetricPlan;
    const hostVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
    const pluginRuntimeSnapshot = await createUserPluginHost({ hostVersion, homeDir: roots?.pluginHome ?? privateHome, enabled: roots === undefined }).snapshot();
    const schedule = { load: { kind: "constant-vus" as const, vus: 1 }, durationMs: null, maxIterations: 1, maxVus: 1, warmupMs: 0, thinkTimeMs: 0, pacingMs: 0, gracefulStopMs: 30000, metricPlan,
      requested: { maxRequestConcurrency: 1, maxRps: null }, effective: { maxRequestConcurrency: 1, maxRps: null } };
    const entry = roots ? fileURLToPath(new URL("./fixtures/oauth-worker-child.mjs", import.meta.url)) : BIN_PATH;
    let channel: ReturnType<typeof spawnLocalStressWorker> | undefined;
    const local = await createLocalStressWorkerDeps(schedule, { runId, clock: localStressClock, shards: 1, allowNumericFailure: true,
      signal: new AbortController().signal, metrics: createStressAccumulator(metricPlan, runId), gate: createStressRequestGate({ clock: localStressClock, maxConcurrency: 1, authorizeRequest() {} }),
      evidence: createExecutionEvidenceCollector({ projectId: project.id, definitionRevision: snapshot.definitionRevision }, [], { maxSamples: 20, privateMarkers: true }),
      createVu: async () => { throw new Error("Coordinator must use remote VUs"); },
      configuration: { kind: "legacy", apiPath: args[1], caseId: option("--case"), workspaceRoot: cwd, envName: option("--env"), concurrency: 1, maxIterations: 1,
        definitionRevision: option("--definition-revision"), credentialVersions: JSON.parse(option("--credential-versions") ?? "{}"), networkIdentity: network.identity, preparedTestData,
        pluginRuntimeVersion: 1, pluginRuntimeSnapshot },
      spawnWorker: async (identity) => channel = spawnLocalStressWorker([entry, "stress-plan-worker", "--run-id", identity.runId, "--worker-id", identity.workerId], 300000, { cwd, env }),
    });
    try {
      const summary = await runStressSchedule(schedule, local.deps); await local.close();
      const exit = await channel!.waitForExit!();
      return { code: exit.code, signal: exit.signal, summary, dataComplete: local.distributed(summary).dataComplete };
    }
    finally { await local.close(); }
}
afterAll(() => {
  // 临时工作区清理（best effort：单个删除失败不阻塞其余清理，也不致测试失败）。
  for (const dir of tempRoots) {
    if (retainedRoots.has(dir)) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 残留临时目录留给操作系统清理，不影响测试结论。
    }
  }
  return new Promise<void>((r) => server.close(() => r()));
});

/** 每用例独立临时工作区：ok 接口打 /x（200），bad 接口打 /boom（500），slow 接口打 /slow（挂起）。 */
async function makeWorkspace(name: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), `apicc-subproc-${name}-`));
  tempRoots.push(root);
  const ws: Workspace = {
    formatVersion: 1, id: "00000000-0000-4000-8000-000000000001", name: `subproc-${name}`, variables: {},
    groups: [{
      id: GROUP_ID, name: "demo", projects: [{
        id: PROJECT_ID, name: "svc", variables: {}, globals: { query: [], headers: [], cookies: [], body: [] }, components: [], models: [],
        stressPolicy: { trustedOrigins: [baseUrl] },
        workflows: [],
        environments: [{ id: "00000000-0000-4000-8000-000000000006", name: "dev", variables: { baseUrl }, baseUrls: {} }],
        collections: [{
          id: COLLECTION_ID, name: "api", variables: {}, preOperations: [], postOperations: [], folders: [],
          apis: [
            apiAsset(OK_API_ID, "ok", "/x", OK_CASE_ID, "passes"),
            apiAsset(BAD_API_ID, "bad", "/boom", BAD_CASE_ID, "fails"),
            apiAsset(ASSERT_BAD_API_ID, "assert-bad", "/x", ASSERT_BAD_CASE_ID, "assertion-fails", [{ id: "status", target: "status", op: "eq", expected: "201" }]),
            apiAsset(SLOW_API_ID, "slow", "/slow", SLOW_CASE_ID, "hangs"),
          ],
        }],
      }],
    }],
  };
  const initial = await fileStorage.load(root);
  await fileStorage.save(root, ws, { expectedRevision: initial.revision, deletions: [] });
  return root;
}

describe("run-stress 真实子进程多 shard 端到端", () => {
  it.each(["native", "injected-worker", "injected-parent", "cloned-channel"] as const)("native clock negotiation with delayed read-only tap: %s", async (mode) => {
    // A deliberate 40ms clock-response delay must widen only the injected clock's IPC mapping.
    const injected = mode === "injected-worker", runId = `native-${mode}`, metricPlan = legacyStressMetricPlan;
    const clock = mode === "injected-parent" ? { ...localStressClock } : localStressClock;
    const schedule = { load: { kind: "constant-vus" as const, vus: 1 }, durationMs: null, maxIterations: 1, maxVus: 1,
      warmupMs: 0, thinkTimeMs: 0, pacingMs: 0, gracefulStopMs: 30000, metricPlan,
      requested: { maxRequestConcurrency: 1, maxRps: null }, effective: { maxRequestConcurrency: 1, maxRps: null } };
    const binding = Reflect.get(stressTransport, "localStressClockDomain");
    const local = await createLocalStressWorkerDeps(schedule, { runId, clock, shards: 1, configuration: {},
      ...(binding ? { clockDomain: binding } : {}), signal: new AbortController().signal,
      metrics: createStressAccumulator(metricPlan, runId), gate: createStressRequestGate({ clock, maxConcurrency: 1, authorizeRequest() {} }),
      evidence: createExecutionEvidenceCollector({ projectId: "p", definitionRevision: "r" }, [], { privateMarkers: true }),
      createVu: async () => { throw new Error("Remote only"); },
      async spawnWorker(identity) {
        const channel = spawnLocalStressWorker([fileURLToPath(new URL("./fixtures/v3-native-clock-worker.mjs", import.meta.url)), identity.runId, identity.workerId, injected ? "injected" : "native"], 300000);
        const subscribe = channel.subscribe.bind(channel);
        channel.subscribe = listener => subscribe(raw => {
          const chunk = raw as { data: string }, frame = JSON.parse(chunk.data);
          if (frame.kind === "response" && typeof frame.value?.workerNow === "number" && !frame.value?.type) setTimeout(() => listener(raw), 40);
          else listener(raw);
        });
        return mode === "cloned-channel" ? { ...channel } : channel;
      },
    });
    try {
      await runStressSchedule(schedule, local.deps);
      const uncertainty = local.deps.timelineUncertaintyMs!();
      expect(uncertainty).toBeGreaterThan(0);
      if (mode !== "native") expect(uncertainty).toBeGreaterThanOrEqual(20);
      else expect(uncertainty).toBeLessThan(20);
    } finally { await local.close(); }
  });
  it.each(["early-zero", "early-seven", "fenced"])("checks actual OS completion, independently of verdict: %s", async (mode) => {
    const metricPlan = legacyStressMetricPlan, runId = "exit-run";
    const schedule = { load: { kind: "constant-vus" as const, vus: 1 }, durationMs: null, maxIterations: 1, maxVus: 1, warmupMs: 0, thinkTimeMs: 0, pacingMs: 0, gracefulStopMs: 30000, metricPlan,
      requested: { maxRequestConcurrency: 1, maxRps: null }, effective: { maxRequestConcurrency: 1, maxRps: null } };
    let channel: ReturnType<typeof spawnLocalStressWorker> | undefined;
    let acknowledged!: () => void, finished = false;
    const shutdownAck = new Promise<void>((resolve) => { acknowledged = resolve; });
    const local = await createLocalStressWorkerDeps(schedule, { runId, clock: localStressClock, shards: 1, configuration: {}, signal: new AbortController().signal,
      metrics: createStressAccumulator(metricPlan, runId), gate: createStressRequestGate({ clock: localStressClock, maxConcurrency: 1, authorizeRequest() {} }),
      evidence: createExecutionEvidenceCollector({ projectId: "p", definitionRevision: "r" }, [], { privateMarkers: true }), createVu: async () => { throw new Error("remote only"); },
      onProgress(progress) { if (progress.state === "finished") finished = true; },
      spawnWorker: async () => {
        channel = spawnLocalStressWorker([fileURLToPath(new URL("./fixtures/v3-exit-worker.mjs", import.meta.url)), mode], 300000);
        if (mode === "fenced") channel.subscribe((raw) => { const chunk = raw as { data: string }; const frame = JSON.parse(chunk.data); if (frame.value?.type === "shutdown") acknowledged(); });
        return channel;
      },
    });
    try {
      const running = runStressSchedule(schedule, local.deps);
      if (mode === "fenced") {
        await shutdownAck; expect(finished).toBe(false); expect(local.richOutputComplete()).toBe(false);
        await channel!.send({ kind: "release-exit" });
        const summary = await running; expect(finished).toBe(true); expect(local.richOutputComplete()).toBe(true); expect(summary.verdict.passed).toBe(false); // no-data business verdict is not an OS code.
      } else { await expect(running).rejects.toThrow(); expect(local.richOutputComplete()).toBe(false); }
    }
    finally { await local.close(); }
    await expect(channel!.waitForExit!()).resolves.toEqual({ code: mode === "early-seven" ? 7 : 0, signal: null });
  });
  it("keeps SOAP fresh connections VU-owned in the legacy multi-worker path", async () => {
    const root = await makeWorkspace("soap-fresh"), state = await fileStorage.load(root);
    const api = state.workspace.groups[0]!.projects[0]!.collections[0]!.apis[0]!;
    api.contract.request = { protocol: "soap", method: "POST", baseUrl, path: "/soap", pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, envelope: "<Envelope/>" };
    await fileStorage.save(root, state.workspace, { expectedRevision: state.revision, deletions: [] });
    soapConnections.length = 0;
    const result = await spawnCli(["run-stress", API_PATH(OK_API_ID), "--case", OK_CASE_ID, "--env", "dev", "--concurrency", "2", "--iterations", "8", "--shards", "2", "--connection-mode", "fresh", "--runs-dir", join(root, ".apicc", "runs")], root);
    expect(result.code, result.stderr).toBe(0); expect(soapConnections).toHaveLength(8); expect(new Set(soapConnections).size).toBe(8);
    expect(readLastReport(join(root, ".apicc", "runs"))).toMatchObject({ totalRequests: 8, ok: 8, connectionMode: "fresh" });
  });
  it("runs strict saved/raw plans with one or two local workers without multiplying the iteration budget", async () => {
    const root = await makeWorkspace("plan"), planDir = mkdtempSync(join(tmpdir(), "apicc-plan-input-")), planFile = join(planDir, "stress-plan.json"); tempRoots.push(planDir);
    const plan = { formatVersion: 1, target: { kind: "case", collectionId: COLLECTION_ID, apiId: OK_API_ID, caseId: OK_CASE_ID }, maxVus: 2,
      maxRequestConcurrency: 1, load: { kind: "constant-vus", vus: 2 }, termination: { maxIterations: 3 } };
    let baselineFile: string | undefined;
    for (const shards of [1, 2]) {
      writeFileSync(planFile, JSON.stringify(shards === 1 ? plan : { formatVersion: 1, id: "saved-plan", name: "local", updatedAt: Date.now(), plan }));
      const dir = join(root, ".apicc", `runs-plan-${shards}`);
      const htmlFile = join(planDir, `report-${shards}.html`);
      const result = await spawnCli(["run-stress-plan", `groups/${GROUP_ID}/projects/${PROJECT_ID}`, "--plan", planFile, "--shards", String(shards), "--runs-dir", dir, "--html", htmlFile, ...(baselineFile ? ["--baseline", baselineFile] : [])], root);
      expect(result.code, result.stderr).toBe(0);
      const report = readLastReport(dir);
      expect(report.formatVersion).toBe(2); expect(report.iterations).toMatchObject({ planned: 3, started: 3, completed: 3, dropped: 0 });
      expect(report.requests).toMatchObject({ started: 3, completed: 3, eligibleCompleted: 3, failed: 0 });
      expect(report.latency).toMatchObject({ availability: "available" });
      expect(report.verdict).toMatchObject({ passed: true });
      const html = readFileSync(htmlFile, "utf8"); expect(html).toContain("Stress report"); expect(html).toContain("passed");
      if (baselineFile) { expect(result.stdout).toContain("基线比较"); expect(html).toContain("Comparable recorded configuration"); }
      baselineFile = join(dir, readdirSync(dir).find((f) => f.endsWith(".json"))!);
    }
  });
  it("成功合并：--shards 2 → exit 0，total=8、distributed.shards=2、perShard 各 4，p50 落在 [min,max]", async () => {
    const root = await makeWorkspace("ok");
    const runsDir = join(root, ".apicc", "runs");
    const diagnosticFile = join(root, ".apicc", "o1-diagnostics.json");
    // Retain the sole source report if capture or any original assertion fails.
    retainedRoots.add(root);
    const res = await spawnCli(
      ["run-stress", API_PATH(OK_API_ID), "--case", OK_CASE_ID, "--env", "dev", "--concurrency", "2",
        "--iterations", "8", "--shards", "2", "--runs-dir", runsDir],
      root, diagnosticFile,
    );
    const captured = captureStressSubprocessEvidence({ root, runsDir, diagnosticFile, result: res,
      evidenceRoot: process.env.APICC_STRESS_DIAGNOSTICS_DIR ?? join(dirname(BIN_PATH), "../../..", "local", "f6-cli-diagnostics") });
    const report = captured.report!;
    expect(res.code, captured.summary).toBe(0);
    expect(res.stdout).toContain("压测完成");
    // 摘要含各 shard 行（真实子进程产出，非注入替身）。
    expect(res.stdout).toContain("worker-1");
    expect(res.stdout).toContain("worker-2");
    expect(report, captured.directory).not.toBeNull();
    expect(report.totalRequests).toBe(8);
    expect(report.ok).toBe(8);
    const distributed = report.distributed as {
      shards: number;
      perShard: Array<{ shardId: string; totalRequests: number; ok: number; failed: number }>;
    };
    expect(distributed.shards).toBe(2);
    expect(distributed.perShard.reduce((sum, p) => sum + p.totalRequests, 0)).toBe(8);
    expect(distributed.perShard.every((p) => p.ok === p.totalRequests && p.failed === 0)).toBe(true);
    // 报告不含原始样本（无法手工 computeReport 对账），按计划口径以 p50∈[min,max] 代偿校验分位面。
    const l = report.latency as { min: number; max: number; p50: number };
    expect(l.p50).toBeGreaterThanOrEqual(l.min);
    expect(l.p50).toBeLessThanOrEqual(l.max);
    const diagnostics = JSON.parse(readFileSync(diagnosticFile, "utf8")) as { runs: Array<{ runId: string; completeness: unknown; timeline: unknown;
      trace: Array<{ type: string; direction: string; worker: number; requestSeq: number; parentNowMs: number; uncertaintyMs?: number; runStart?: number }> }>;
      workers: Array<{ runId: string; workerId: string; code: number | null; signal: string | null }> };
    expect(diagnostics.runs).toHaveLength(1);
    expect(diagnostics.runs[0]).toMatchObject({ completeness: { execution: { complete: true, reasons: [] }, metrics: { complete: true, reasons: [] }, load: { complete: true, reasons: [] } }, timeline: { aligned: true, uncertaintyMs: expect.any(Number) } });
    expect(diagnostics.workers).toHaveLength(2);
    expect(diagnostics.workers.map((worker) => worker.workerId).sort()).toEqual(["worker-1", "worker-2"]);
    expect(diagnostics.workers.every((worker) => worker.runId === diagnostics.runs[0]!.runId && worker.code === 0 && worker.signal === null)).toBe(true);
    // The original diagnostic wrapper must preserve native qualification, rather than happen
    // to pass this short workload with a fallback interval that will fail at a later phase edge.
    const trace = diagnostics.runs[0]!.trace;
    for (const sent of trace.filter(row => row.type === "clock" && row.direction === "send")) {
      const received = trace.find(row => row.type === "clock" && row.direction === "receive" && row.worker === sent.worker && row.requestSeq === sent.requestSeq)!;
      const start = trace.find(row => row.type === "start" && row.direction === "send" && row.worker === sent.worker)!;
      expect(start.uncertaintyMs).toBeGreaterThan(0);
      expect(start.uncertaintyMs).toBeLessThan((received.parentNowMs - sent.parentNowMs) / 2);
    }
    const origins = trace.filter(row => row.type === "create" && row.direction === "send").map(row => row.runStart);
    expect(origins).toHaveLength(2);
    expect(origins[0]).toBeTypeOf("number");
    expect(origins[1]).toBe(origins[0]);
    retainedRoots.delete(root);
  }, 60000);

  it("全失败传播：server 500 且 iterations=4/shards=2 → exit 1（全部失败口径），perShard 各 2 全败", async () => {
    const root = await makeWorkspace("bad");
    const runsDir = join(root, ".apicc", "runs");
    const res = await spawnCli(
      ["run-stress", API_PATH(BAD_API_ID), "--case", BAD_CASE_ID, "--env", "dev",
        "--concurrency", "2", "--iterations", "4", "--shards", "2", "--runs-dir", runsDir],
      root,
    );
    expect(res.code).toBe(1);
    const report = readLastReport(runsDir);
    expect(report.totalRequests).toBe(4);
    expect(report.ok).toBe(0);
    expect(report.failed).toBe(4);
    expect(report.errorKinds).toEqual({ HTTP_500: 4 });
    expect(res.stdout).toContain("错误明细");
    expect(res.stdout).toContain("HTTP_500");
    const singleDir = join(root, ".apicc", "runs-single-failed");
    const single = await spawnCli(["run-stress", API_PATH(BAD_API_ID), "--case", BAD_CASE_ID, "--env", "dev", "--concurrency", "2", "--iterations", "4", "--runs-dir", singleDir], root);
    expect(single.code).toBe(1); expect(readLastReport(singleDir).errorKinds).toEqual({ HTTP_500: 4 });
    const snapshot = createProjectSnapshot((await fileStorage.load(root)).workspace.groups[0]!.projects[0]!);
    const failedWorker = await runV3PrivateWorker(["stress-worker", API_PATH(BAD_API_ID), "--case", BAD_CASE_ID, "--env", "dev", "--definition-revision", snapshot.definitionRevision, "--credential-versions", "{}"], root);
    expect(failedWorker.code).toBe(0); expect(failedWorker.signal).toBe(null); expect(failedWorker.summary.verdict.passed).toBe(false); expect(failedWorker.dataComplete).toBe(true);
    const distributed = report.distributed as {
      shards: number;
      perShard: Array<{ totalRequests: number; ok: number; failed: number }>;
      shardErrors?: unknown;
    };
    expect(distributed.shards).toBe(2);
    expect(distributed.perShard.reduce((sum, p) => sum + p.totalRequests, 0)).toBe(4);
    expect(distributed.perShard.every((p) => p.ok === 0 && p.failed === p.totalRequests)).toBe(true);
    // worker 本身成功回传（ShardResult），不算 shard 失败。
    expect(distributed.shardErrors).toBeUndefined();
  }, 60000);

  it("HTTP 200 但断言失败：多 shard 合并 assertion 计数、verdict=false、CLI exit 1", async () => {
    const root = await makeWorkspace("assertion-failure");
    const runsDir = join(root, ".apicc", "runs");
    const res = await spawnCli(
      ["run-stress", API_PATH(ASSERT_BAD_API_ID), "--case", ASSERT_BAD_CASE_ID, "--env", "dev",
        "--concurrency", "2", "--iterations", "4", "--shards", "2", "--runs-dir", runsDir],
      root,
    );
    expect(res.code).toBe(1);
    const report = readLastReport(runsDir) as { failures: { assertion: number }; verdict?: { passed: boolean }; distributed?: { dataComplete: boolean } };
    expect(report.failures.assertion).toBe(4);
    expect(report.verdict?.passed).toBe(false);
    expect(report.distributed?.dataComplete).toBe(true);
  }, 60000);

  it("坏 caseId：run-stress 前置用例门拒绝（不 spawn worker、不落报告），exit 1 且错误走 stderr", async () => {
    // 计划原案「不存在 caseId 触发 worker 失败」与实际设计不符：run-stress 与 worker 共享
    // resolveStressTarget 用例门，父进程在协调前即拒绝。此处按真实契约断言。
    const root = await makeWorkspace("crash");
    const runsDir = join(root, ".apicc", "runs");
    const res = await spawnCli(
      ["run-stress", API_PATH(OK_API_ID), "--case", "不存在", "--env", "dev", "--concurrency", "2",
        "--iterations", "4", "--shards", "2", "--runs-dir", runsDir],
      root,
    );
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("未找到用例: 不存在");
    expect(res.stdout).not.toContain("shard 失败");
    expect(existsSync(runsDir)).toBe(false);
  }, 60000);

  it("fresh stress-worker 子进程重载定义版本不匹配时 config/零发送", async () => {
    const root = await makeWorkspace("definition-changed");
    const before = await fileStorage.load(root);
    const originalProject = before.workspace.groups[0]!.projects[0]!;
    const definitionRevision = createProjectSnapshot(originalProject).definitionRevision;
    const afterWorkspace = structuredClone(before.workspace);
    afterWorkspace.groups[0]!.projects[0]!.variables = { changedWhileWaiting: "yes" };
    await fileStorage.save(root, afterWorkspace, { expectedRevision: before.revision, deletions: [] });
    const requestsBefore = receivedRequests;

    const result = await runV3PrivateWorker([
      "stress-worker", API_PATH(OK_API_ID), "--case", OK_CASE_ID, "--concurrency", "1", "--iterations", "1",
      "--shard-id", "late-worker", "--workspace", root,
      "--definition-revision", definitionRevision, "--credential-versions", "{}",
    ], root);

    expect(result.code).toBe(null); expect(result.signal).toBe("SIGTERM");
    expect(result.dataComplete).toBe(false);
    expect(result.summary.completeness.metrics.reasons).toContain("worker-missing");
    expect(receivedRequests).toBe(requestsBefore);
  }, 60000);

  it("fresh no-auth worker accepts an empty credential-version table and exits cleanly", async () => {
    const root = await makeWorkspace("no-auth-empty-versions");
    const state = await fileStorage.load(root);
    const project = state.workspace.groups[0]!.projects[0]!;
    const definitionRevision = createProjectSnapshot(project).definitionRevision;
    const requestsBefore = receivedRequests;

    const result = await runV3PrivateWorker([
      "stress-worker", API_PATH(OK_API_ID), "--case", OK_CASE_ID, "--concurrency", "1", "--iterations", "1",
      "--shard-id", "no-auth-empty-versions", "--workspace", root,
      "--definition-revision", definitionRevision, "--credential-versions", "{}",
    ], root);

    expect(result.code).toBe(0); expect(result.signal).toBe(null);
    expect(result.dataComplete).toBe(true);
    expect(result.summary.requests.eligibleCompleted).toBe(1);
    expect(receivedRequests).toBe(requestsBefore + 1);
  }, 60000);

  it("OAuth worker child keeps the parent bearer version near expiry and rejects version drift before sending", async () => {
    const root = await makeWorkspace("oauth-pinned-token");
    const loadedWorkspace = await fileStorage.load(root);
    const nextWorkspace = structuredClone(loadedWorkspace.workspace);
    const project = nextWorkspace.groups[0]!.projects[0]!;
    const api = project.collections[0]!.apis.find((item) => item.contract.id === OK_API_ID)!;
    api.contract.request.auth = { kind: "bearer", token: { id: "synthetic-oauth-access", policy: "test-auto" } };
    const workspaceSave = await fileStorage.save(root, nextWorkspace, { expectedRevision: loadedWorkspace.revision, deletions: [] });
    expect(workspaceSave.revision).toEqual(expect.any(String));

    const privateRoots = {
      oauth: join(root, ".apicc", "synthetic-oauth"),
      network: join(root, ".apicc", "synthetic-network"),
      pluginHome: join(root, ".apicc", "synthetic-plugin-home"),
    };
    const parentStore: SecretStore = {
      async put() {},
      async resolve() { throw new Error("parent store unused"); },
      async version() { throw new Error("parent store unused"); },
      async remove() {},
      async status() { return "missing"; },
    };
    const environmentId = project.environments[0]!.id;
    const host = await createOAuthProfileHost({
      workspaceRoot: root,
      project: { workspaceId: nextWorkspace.id, groupId: GROUP_ID, projectId: PROJECT_ID },
      environmentId,
      privateRoot: privateRoots.oauth,
      secretStore: parentStore,
    });
    let tokenExchangeRequests = 0;
    const tokenServer = createServer(async (request, response) => {
      tokenExchangeRequests += 1;
      for await (const _chunk of request) { /* consume the synthetic form body */ }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ access_token: "unexpected-refreshed-token", token_type: "Bearer", expires_in: 300 }));
    });
    await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
    const tokenPort = (tokenServer.address() as { port: number }).port;
    const profile = {
      profileId: "synthetic-refresh-profile",
      environmentId,
      flow: "refresh_token" as const,
      tokenEndpoint: `http://127.0.0.1:${tokenPort}/token`,
      clientId: "synthetic-cli-client",
      clientAuthentication: "none" as const,
      bearerRef: { id: "synthetic-oauth-access", policy: "test-auto" as const },
      refreshTokenRef: { id: "synthetic-oauth-refresh", policy: "test-auto" as const },
    };
    const record: OAuthProfileRecord = {
      canonicalRoot: host.scope.canonicalRoot,
      profile,
      state: { status: "connected", expiresAt: Date.now() + 1_000 },
      credentialVersions: { accessToken: "synthetic-access-v1", refreshToken: "synthetic-refresh-v1" },
    };
    await host.store.save(host.scope, [record], "missing");

    const snapshot = createProjectSnapshot(project);
    const workerArgs = [
      "stress-worker", API_PATH(OK_API_ID), "--case", OK_CASE_ID,
      "--concurrency", "1", "--iterations", "1", "--shard-id", "oauth-parent-version",
      "--workspace", root, "--env", "dev", "--definition-revision", snapshot.definitionRevision,
      "--credential-versions", JSON.stringify({ "synthetic-oauth-access": "synthetic-access-v1" }),
    ];
    const requestsBefore = receivedRequests;
    try {
      const stable = await runV3PrivateWorker(workerArgs, root, privateRoots, {
        access: "synthetic-access-v1", refresh: "synthetic-refresh-v1",
      });
      expect(stable.code).toBe(0);
      expect(stable.dataComplete).toBe(true); expect(stable.summary.requests.eligibleCompleted).toBe(1);
      expect(receivedRequests).toBe(requestsBefore + 1);
      expect(lastAuthorization).toBe("Bearer synthetic-child-access-token");
      expect(tokenExchangeRequests).toBe(0);

      const beforeDrift = receivedRequests;
      const drifted = await runV3PrivateWorker(workerArgs, root, privateRoots, {
        access: "synthetic-access-v2", refresh: "synthetic-refresh-v1",
      });
      expect(drifted.code).toBe(null); expect(drifted.signal).toBe("SIGTERM");
      expect(drifted.dataComplete).toBe(false); expect(drifted.summary.requests.started).toBe(0);
      expect(receivedRequests).toBe(beforeDrift);
      expect(tokenExchangeRequests).toBe(0);
    } finally {
      await new Promise<void>((resolve) => tokenServer.close(() => resolve()));
    }
  }, 60000);

  it("shard 崩溃传播：/slow 挂起 + --shard-timeout 1 → 两 worker 超时判失败，exit 1 且不伪造缺 generator 报告", async () => {
    // 走专用 /slow 接口（8s 才响应），确保 1s shard 超时必然先到——不依赖进程启动快慢的偶然时序。
    const root = await makeWorkspace("timeout");
    const runsDir = join(root, ".apicc", "runs");
    const res = await spawnCli(
      ["run-stress", API_PATH(SLOW_API_ID), "--case", SLOW_CASE_ID, "--env", "dev",
        "--concurrency", "2", "--iterations", "4", "--shards", "2", "--shard-timeout", "1", "--runs-dir", runsDir],
      root,
    );
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("压测完成");
    expect(res.stdout).toContain("未采集/不可用");
    expect(res.stderr).not.toContain("current_report_invalid");
    expect(existsSync(runsDir)).toBe(true);
    const report = readLastReport(runsDir) as {
      distributed?: { dataComplete: boolean; shardErrors?: Array<{ shardId: string }> };
      generator?: { availability?: string };
      verdict?: { passed: boolean; violations: Array<{ metric: string }> };
    };
    expect(report.distributed?.dataComplete).toBe(false);
    expect(report.distributed?.shardErrors).toHaveLength(2);
    expect(report.generator?.availability).toBe("unavailable");
    expect(report.verdict?.passed).toBe(false);
    expect(report.verdict?.violations.some((violation) => violation.metric === "noData")).toBe(true);
  }, 60000);
});

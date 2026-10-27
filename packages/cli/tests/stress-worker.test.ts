import { createServer, type Server } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync, cpSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { PassThrough } from "node:stream";
import { EventEmitter, getEventListeners } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDefaultRegistry,
  createProjectSnapshot,
  StressRunner,
  type StressRunnerOptions,
  fileStorage,
  type ShardFailure,
  ShardFailureSchema,
  type ShardResult,
  ShardResultSchema,
  type StressWorkerSpec,
  type Workspace,
} from "@apicc/core";
import { parseShardOutcomeStdout, runCli as runCliActual, registerLegacyStressWorkerAdapter, type RunCliDeps } from "../src/main.js";
import { createPrivateStressWorkerFactory, createWorkerEvidenceFinalizer, spawnLocalStressWorker } from "../src/stressWorkerTransport.js";
import { localStressWorker } from "./helpers/localStressWorker.js";

// 本文件覆盖 M2-D1 任务 2：stress-worker 子命令（stdout 末行 JSON 契约）与 run-stress --shards
// 协调分支（spawn 实现可注入——真实子进程端到端留任务 3）。

let server: Server;
let baseUrl = "";
let root: string;
let prevCwd = "";
let definitionRevision = "";
let networkPrivateRoot = "";
const seenPaths: string[] = [];
let interruptRequest: (() => void) | undefined;
const redirectHops: number[] = [];
/** 本文件创建的临时工作区根（afterAll 统一清理，模式与姊妹文件 stress-subprocess.test.ts 一致）。 */
const tempRoots: string[] = [];

function runCli(argv: string[], registry: Parameters<typeof runCliActual>[1], log: (line: string) => void = () => {}, deps: RunCliDeps = {}): Promise<number> {
  return runCliActual(argv, registry, log, { networkPrivateRoot, ...(argv[0] === "stress-worker" ? { legacyStressWorkerAdapter: registerLegacyStressWorkerAdapter } : {}), ...deps });
}

const GROUP_ID = "00000000-0000-4000-8000-000000000002";
const PROJECT_ID = "00000000-0000-4000-8000-000000000004";
const COLLECTION_ID = "00000000-0000-4000-8000-000000000008";
const API_ID = "00000000-0000-4000-8000-000000000011";
const CASE_ID = "00000000-0000-4000-8000-000000000015";
const API_PATH = `groups/${GROUP_ID}/projects/${PROJECT_ID}/collections/${COLLECTION_ID}/apis/${API_ID}`;

const generator = () => ({
  availability: "available" as const,
  cpuUserMs: 1, cpuSystemMs: 2, cpuPercent: 3, rssStartBytes: 10, rssPeakBytes: 20,
  eventLoopDelayP95Ms: 4, schedulerBacklogMax: 0, saturated: false, reasons: [] as [],
  limits: { cpuPercent: 90, eventLoopDelayP95Ms: 100, schedulerBacklog: 0 },
});
const sample = (timeMs: number) => ({ timeMs, requestTimeMs: timeMs, scriptTimeMs: 0, iterationTimeMs: timeMs, requestStarted: true, requestCompleted: true, status: 200, ok: true });
const measurementWindow = (eligibleCompletedAttempts: number) => ({
  startWallMs: 1_000, endWallMs: 1_100, monotonicDurationMs: 100, eligibleCompletedAttempts,
});

/** 读 runs 目录下最新的 stress-*.json 报告（文件名排序取末位，不依赖 readdir 目录序假设）。 */
function readLastReport(runsDir: string): Record<string, unknown> {
  const files = readdirSync(runsDir).filter((f) => f.startsWith("stress-") && f.endsWith(".json")).sort();
  expect(files.length).toBeGreaterThan(0);
  return JSON.parse(readFileSync(join(runsDir, files[files.length - 1]!), "utf8")) as Record<string, unknown>;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    seenPaths.push(req.url ?? "");
    if (req.url === "/f6-redirect" || req.url === "/f6-final") {
      redirectHops.push(performance.now());
      if (req.url === "/f6-redirect") { res.writeHead(302, { location: "/f6-final" }); res.end(); return; }
    }
    interruptRequest?.();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  root = mkdtempSync(join(tmpdir(), "apicc-worker-"));
  tempRoots.push(root);
  networkPrivateRoot = mkdtempSync(join(tmpdir(), "apicc-worker-network-private-"));
  tempRoots.push(networkPrivateRoot);
  const ws: Workspace = {
    formatVersion: 1, id: "00000000-0000-4000-8000-000000000001", name: "worker-e2e", variables: {},
    groups: [{
      id: GROUP_ID, name: "demo", projects: [{
        id: PROJECT_ID, name: "svc", variables: {}, globals: { query: [], headers: [], cookies: [], body: [] }, components: [], models: [],
        stressPolicy: { trustedOrigins: [baseUrl] },
        workflows: [],
        environments: [{ id: "00000000-0000-4000-8000-000000000006", name: "dev", variables: { baseUrl }, baseUrls: {} }],
        collections: [{
          id: COLLECTION_ID, name: "api", variables: {}, preOperations: [], postOperations: [], folders: [],
          apis: [{
            contract: {
              formatVersion: 1, id: API_ID,
              metadata: { name: "ok", description: "", tags: [], version: "1", status: "published" },
              request: { protocol: "http", method: "GET", baseUrl, path: "/x", pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, body: { kind: "none" } },
              responses: [],
            },
            documentation: "",
            cases: [{ id: CASE_ID, name: "passes", scope: "base", parameters: {}, preOperations: [], postOperations: [], assertions: [] }],
          }],
        }],
      }],
    }],
  };
  const initial = await fileStorage.load(root);
  await fileStorage.save(root, ws, { expectedRevision: initial.revision, deletions: [] });
  const loaded = await fileStorage.load(root);
  definitionRevision = createProjectSnapshot(loaded.workspace.groups[0]!.projects[0]!).definitionRevision;
  // run-stress 按“从 cwd 向上查找 apicc.workspace.yaml”定位工作区（与既有 e2e 同款模拟）。
  prevCwd = process.cwd();
  process.chdir(root);
});
afterAll(() => {
  process.chdir(prevCwd);
  // 临时工作区清理（best effort：单个删除失败不阻塞其余清理，也不致测试失败）。
  for (const dir of tempRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 残留临时目录留给操作系统清理，不影响测试结论。
    }
  }
  return new Promise<void>((r) => server.close(() => r()));
});

describe("stress-worker 子命令", () => {
  it("C1 Fix3 actual normal worker retains projection billing and complete local markers while private completion stays outside", async () => {
    const original = StressRunner.prototype.run;
    let projected = false; let stopped = false; let projectedAtStop = false; let failGenerator = false;
    let unavailableCookies = false; let failClose = false; let thrownMessage = "";
    const cookieSecret = "unavailable-cookie-private";
    const probe = vi.spyOn(StressRunner.prototype, "run").mockImplementation(function (this: StressRunner, options) {
      const runnerOptions = (this as unknown as { opts: StressRunnerOptions }).opts;
      const createWorker = runnerOptions.createWorker;
      runnerOptions.createWorker = async (id) => {
        const session = await createWorker(id);
        return { ...session, close: async () => { await session.close(); if (failClose) throw new Error(`${cookieSecret} close fault`); }, execute: async (signal) => {
          const execution = await session.execute(signal);
          return { ...execution, outcome: { ...execution.outcome, passed: false, failureKind: "assertion" }, failureKind: "assertion",
            extractionOutcomes: [{ id: "learned", name: "token", selector: { target: "bodyText", match: "first" }, status: "extracted", code: "OK", pass: true, sensitive: true, published: true, message: "learned", value: "local-learned-secret" }],
            response: { ...execution.response!, ...(unavailableCookies ? { headers: { "set-cookie": `first=first-private; Path=/, second=${cookieSecret}; Path=/` }, rawHeaders: undefined } : {}), get bodyText() { projected = true; return "local-learned-secret public detail"; } },
            safety: { ...execution.safety!, origin: "https://local-learned-secret.test" },
          };
        } };
      };
      runnerOptions.createGeneratorCollector = () => ({ recordSchedulerBacklog() {}, stop() {
        projectedAtStop = projected; stopped = true;
        if (failGenerator) throw new Error("local-learned-secret generator fault");
        return { availability: "unavailable", unavailableReason: "fixture" };
      } });
      return original.call(this, options).catch(error => { thrownMessage = error.message; throw error; });
    });
    try {
      for (const privateCompletion of [false, true]) {
        projected = false; stopped = false; projectedAtStop = false;
        const out: string[] = [];
        const code = await runCli(["stress-worker", API_PATH, "--case", CASE_ID, "--env", "dev", "--concurrency", "1", "--iterations", "1", "--shard-id", "normal-billing", "--workspace", root, "--definition-revision", definitionRevision, "--credential-versions", "{}"], createDefaultRegistry(), () => {}, {
          workerOut: (line) => out.push(line), workerErr: () => {},
          ...(privateCompletion ? { workerFinalizeEvidence: async (markers: readonly string[]) => { expect(stopped).toBe(true); expect(projected).toBe(false); expect(markers).toContain("local-learned-secret"); return markers; } } : {}),
        });
        expect(code, JSON.stringify(out)).toBe(0); expect(projectedAtStop).toBe(!privateCompletion);
        const result = ShardResultSchema.parse(JSON.parse(out[0]!));
        expect(result.samples).toMatchObject([{ ok: false, failureKind: "assertion", safety: { origin: "https://[REDACTED].test" } }]);
        expect(result.failureEvidence![0]!.response!.body.text).toContain("public detail");
        expect(out[0]).not.toContain("local-learned-secret");
      }
      failGenerator = true;
      const failedOut: string[] = []; const failedErr: string[] = [];
      const failedCode = await runCli(["stress-worker", API_PATH, "--case", CASE_ID, "--env", "dev", "--concurrency", "1", "--iterations", "1", "--shard-id", "normal-error", "--workspace", root, "--definition-revision", definitionRevision, "--credential-versions", "{}"], createDefaultRegistry(), () => {}, { workerOut: (line) => failedOut.push(line), workerErr: (line) => failedErr.push(line) });
      expect(failedCode).toBe(1); expect(ShardFailureSchema.parse(JSON.parse(failedOut[0]!)).error).toBe("[REDACTED] generator fault");
      expect(failedErr.join(" ")).not.toContain("local-learned-secret");
      unavailableCookies = true; failGenerator = false; projected = false; stopped = false;
      const fallbackOut: string[] = [];
      const fallbackArgs = ["stress-worker", API_PATH, "--case", CASE_ID, "--env", "dev", "--concurrency", "1", "--iterations", "1", "--shard-id", "cookie-fallback", "--workspace", root, "--definition-revision", definitionRevision, "--credential-versions", "{}"];
      expect(await runCli(fallbackArgs, createDefaultRegistry(), () => {}, { workerOut: line => fallbackOut.push(line), workerErr: () => {} })).toBe(0);
      const fallback = ShardResultSchema.parse(JSON.parse(fallbackOut[0]!));
      expect(fallback).toMatchObject({ ok: true, shardId: "cookie-fallback", samples: [{ ok: false, failureKind: "assertion", status: 200, safety: { origin: "[omitted: unavailable Set-Cookie boundaries]" } }] });
      expect(fallback.failureEvidence![0]!.response!.body.omitted).toBe(true);
      expect(projectedAtStop).toBe(true);
      failClose = true; failGenerator = true; const unsafeErrorOut: string[] = []; const unsafeErrorErr: string[] = [];
      expect(await runCli(fallbackArgs, createDefaultRegistry(), () => {}, { workerOut: line => unsafeErrorOut.push(line), workerErr: line => unsafeErrorErr.push(line) })).toBe(1);
      expect(thrownMessage).toBe(`${cookieSecret} close fault`); // Preserve the original higher-priority cleanup failure in the host.
      expect(ShardFailureSchema.parse(JSON.parse(unsafeErrorOut[0]!))).toMatchObject({ ok: false, shardId: "cookie-fallback", error: "[omitted: unavailable Set-Cookie boundaries]" });
      expect(JSON.stringify([fallbackOut, unsafeErrorOut, unsafeErrorErr])).not.toContain(cookieSecret);
      expect(JSON.stringify([fallbackOut, unsafeErrorOut, unsafeErrorErr])).not.toContain("local-learned-secret");
    } finally { probe.mockRestore(); }
  });
  it("B1 coordinator captures once and stdin worker consumes old rows after file replacement", async () => {
    const isolatedRoot = mkdtempSync(join(tmpdir(), "apicc-b1-worker-"));
    tempRoots.push(isolatedRoot);
    const dataRoot = mkdtempSync(join(tmpdir(), "apicc-b1-worker-data-"));
    tempRoots.push(dataRoot);
    const dataPath = join(dataRoot, "rows.csv");
    const workspace = (await fileStorage.load(root)).workspace;
    const project = workspace.groups[0]!.projects[0]!;
    const api = project.collections[0]!.apis[0]!;
    api.contract.request.path = "/{{row}}";
    api.cases[0]!.dataDriver = { sourcePath: relative(isolatedRoot, dataPath), format: "csv" };
    const initial = await fileStorage.load(isolatedRoot);
    await fileStorage.save(isolatedRoot, workspace, { expectedRevision: initial.revision, deletions: [] });
    writeFileSync(dataPath, "row\nOLD\n");
    const specs: import("@apicc/core").StressWorkerSpecBase[] = [];
    process.chdir(isolatedRoot);
    try {
      const coordinatorCode = await runCli(["run-stress", API_PATH, "--case", CASE_ID, "--env", "dev", "--concurrency", "2", "--iterations", "2", "--shards", "2"], createDefaultRegistry(), () => {}, {
        spawnLocalStressWorker: (identity, timeout, prepare) => localStressWorker(identity, timeout, async (value) => {
          specs.push(value as import("@apicc/core").StressWorkerSpecBase); writeFileSync(dataPath, "row\nNEW\n"); return prepare(value);
        }),
      });
      expect(coordinatorCode).toBe(0);
      expect(specs).toHaveLength(2);
      expect(specs[0]!.preparedTestData!.digest).toBe(specs[1]!.preparedTestData!.digest);
      expect(specs[0]!.preparedTestData!.sources[0]!.rows[0]!.values.row).toBe("OLD");
      const spec = specs[0]!;
      const input = Readable.from([JSON.stringify(spec.preparedTestData)]);
      const stdin = vi.spyOn(process, "stdin", "get").mockReturnValue(input as typeof process.stdin);
      const out: string[] = [];
      const before = seenPaths.length;
      try {
        const workerCode = await runCli(["stress-worker", API_PATH, "--case", CASE_ID, "--env", "dev", "--concurrency", "1", "--iterations", "1", "--shard-id", "b1", "--workspace", isolatedRoot, "--definition-revision", spec.definitionRevision, "--credential-versions", "{}", "--network-identity", spec.networkIdentity, "--prepared-data-stdin"], createDefaultRegistry(), () => {}, { workerOut: (line) => out.push(line), workerErr: () => {} });
        expect(workerCode).toBe(0);
      } finally { stdin.mockRestore(); }
      expect(ShardResultSchema.parse(JSON.parse(out[0]!)).samples[0]!.ok).toBe(true);
      expect(seenPaths.slice(before)).toEqual(["/OLD"]);
      const next = await runCli(["run-stress", API_PATH, "--case", CASE_ID, "--env", "dev", "--concurrency", "1", "--iterations", "1"], createDefaultRegistry());
      expect(next).toBe(0);
      expect(seenPaths.at(-1)).toBe("/NEW");
    } finally { process.chdir(root); }
  });

  it("成功：stdout 仅末行 JSON 且通过 ShardResultSchema，样本数等于迭代数，退出码 0", async () => {
    const out: string[] = [];
    const err: string[] = [];
    let completions = 0;
    const deps: RunCliDeps = { workerOut: (l) => out.push(l), workerErr: (l) => err.push(l), workerFinalizeEvidence: async (markers) => {
      expect(out).toHaveLength(0); completions++; return [...markers, "ok"];
    } };
    const code = await runCli(
      ["stress-worker", API_PATH, "--case", CASE_ID, "--env", "dev", "--concurrency", "2",
        "--iterations", "4", "--shard-id", "s0", "--workspace", root, "--definition-revision", definitionRevision, "--credential-versions", "{}"],
      createDefaultRegistry(),
      () => {},
      deps,
    );
    expect(code).toBe(0);
    // 裁定 B：worker 模式 stdout 只许末行协议 JSON，人类日志一律 stderr。
    expect(out).toHaveLength(1);
    expect(err.join("\n")).not.toContain("压测");
    const outcome = ShardResultSchema.parse(JSON.parse(out[0]!));
    expect(outcome.ok).toBe(true);
    expect(outcome.shardId).toBe("s0");
    expect(outcome.protocolVersion).toBe(2);
    // totalRequests 以 samples.length 验证（计划步骤 1 测试 1 的口径）。
    expect(outcome.samples).toHaveLength(4);
    expect(outcome.samples.every((s) => s.ok && s.status === 200)).toBe(true);
    expect(completions).toBe(1); expect(out[0]).not.toContain("markers");
  });

  it("用例不存在：末行通过 ShardFailureSchema、错误信息走 stderr、退出码 1", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const deps: RunCliDeps = { workerOut: (l) => out.push(l), workerErr: (l) => err.push(l) };
    const code = await runCli(
      ["stress-worker", API_PATH, "--case", "不存在", "--env", "dev", "--concurrency", "2",
        "--iterations", "4", "--shard-id", "s1", "--workspace", root, "--definition-revision", definitionRevision, "--credential-versions", "{}"],
      createDefaultRegistry(),
      () => {},
      deps,
    );
    expect(code).toBe(1);
    expect(out).toHaveLength(1);
    const outcome = ShardFailureSchema.parse(JSON.parse(out[0]!));
    expect(outcome.ok).toBe(false);
    expect(outcome.shardId).toBe("s1");
    expect(outcome.error).toContain("未找到用例");
    expect(err.join("\n")).toContain("未找到用例");
  });
});

describe("run-stress --shards", () => {
  it("delegates SDK SOAP stress and ordinary requests through the owned HTTP transport", async () => {
    const isolated = mkdtempSync(join(tmpdir(), "apicc-plugin-soap-")); tempRoots.push(isolated);
    const home = join(isolated, "home"), source = join(isolated, "plugin"), workspaceRoot = join(isolated, "workspace");
    mkdirSync(join(home, ".apicc"), { recursive: true }); mkdirSync(source); mkdirSync(workspaceRoot);
    const manifest = { manifestVersion: 1, id: "example.soap", name: "soap-plugin", version: "0.1.0", apiVersion: 1, engines: { apicc: ">=0.1.0 <0.2.0" }, entry: "./index.mjs", capabilities: ["protocol"], contributions: [{ kind: "protocol", id: "example.soap/protocol.soap" }] };
    writeFileSync(join(source, "package.json"), JSON.stringify({ name: manifest.name, version: manifest.version, type: "module" }));
    writeFileSync(join(source, "apicc-plugin.json"), JSON.stringify(manifest));
    writeFileSync(join(source, "index.mjs"), `export default {manifest:${JSON.stringify(manifest)},setup(ctx){ctx.register({kind:'protocol',id:'example.soap/protocol.soap',supports:['soap'],execute(request,context){return context.transport.execute(request)}})}}`);
    writeFileSync(join(home, ".apicc", "plugins.json"), JSON.stringify({ plugins: [source], bindings: { protocols: { soap: "example.soap/protocol.soap" } } }));
    const workspace = structuredClone((await fileStorage.load(root)).workspace), api = workspace.groups[0]!.projects[0]!.collections[0]!.apis[0]!;
    api.contract.request = { protocol: "soap", method: "POST", baseUrl, path: "/sdk-soap", pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, envelope: "<Envelope/>" };
    const initial = await fileStorage.load(workspaceRoot); await fileStorage.save(workspaceRoot, workspace, { expectedRevision: initial.revision, deletions: [] });
    const previous = process.cwd(); process.chdir(workspaceRoot);
    try {
      const before = seenPaths.length;
      const registry = createDefaultRegistry();
      const code = await runCli(["run-stress", API_PATH, "--case", CASE_ID, "--concurrency", "1", "--iterations", "1", "--runs-dir", join(isolated, "stress")], registry, () => {}, { pluginsHomeDir: home });
      expect(registry.getProtocol({ protocol: "soap", method: "POST", url: baseUrl, envelope: "<Envelope/>", headers: {}, query: [], auth: { kind: "none" } })?.sdkProtocol).toBe(true);
      expect(JSON.stringify(readLastReport(join(isolated, "stress")))).not.toContain("SDK managed transport cannot handle this request");
      expect(code).toBe(0); expect(seenPaths.length - before).toBe(1);
      const normal = await runCli(["run", `groups/${GROUP_ID}/projects/${PROJECT_ID}/collections/${COLLECTION_ID}`, "--env", "dev", "--reporters", "html", "--runs-dir", join(isolated, "normal")], createDefaultRegistry(), () => {}, { pluginsHomeDir: home });
      expect(normal).toBe(0); expect(seenPaths.length - before).toBe(2);
    } finally { process.chdir(previous); }
  });
  it("replays the coordinator plugin in real plan and legacy children without reading child HOME", async () => {
    const isolated = mkdtempSync(join(tmpdir(), "apicc-plugin-child-")); tempRoots.push(isolated);
    const workspaceRoot = join(isolated, "workspace"), home = join(isolated, "home"), childHome = join(isolated, "child-home");
    mkdirSync(workspaceRoot); mkdirSync(join(home, ".apicc"), { recursive: true }); mkdirSync(join(childHome, ".apicc"), { recursive: true });
    const source = join(isolated, "sample"); cpSync(fileURLToPath(new URL("./fixtures/sample-plugin", import.meta.url)), source, { recursive: true });
    const evil = join(isolated, "evil"); cpSync(source, evil, { recursive: true });
    const marker = join(isolated, "child-home-was-read");
    writeFileSync(join(evil, "index.js"), `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'read');\n` + readFileSync(join(evil, "index.js"), "utf8"));
    writeFileSync(join(home, ".apicc", "plugins.json"), JSON.stringify({ plugins: [source] }));
    writeFileSync(join(childHome, ".apicc", "plugins.json"), JSON.stringify({ plugins: [evil] }));
    const state = await fileStorage.load(root), workspace = structuredClone(state.workspace);
    workspace.groups[0]!.projects[0]!.collections[0]!.apis[0]!.cases[0]!.assertions = [{ id: "field", target: "bodyJson", op: "example.demo/assert.has-field", expected: "missingField" }];
    const initial = await fileStorage.load(workspaceRoot); await fileStorage.save(workspaceRoot, workspace, { expectedRevision: initial.revision, deletions: [] });
    const planFile = join(isolated, "plan.json"); writeFileSync(planFile, JSON.stringify({ formatVersion: 1, maxVus: 2, target: { kind: "case", collectionId: COLLECTION_ID, apiId: API_ID, caseId: CASE_ID }, load: { kind: "constant-vus", vus: 2 }, termination: { maxIterations: 2 } }));
    const previous = process.cwd(); process.chdir(workspaceRoot);
    try {
      for (const kind of ["legacy", "plan"] as const) {
        const runsDir = join(isolated, kind), logs: string[] = [], before = seenPaths.length;
        const args = kind === "legacy" ? ["run-stress", API_PATH, "--case", CASE_ID, "--concurrency", "2", "--iterations", "2"]
          : ["run-stress-plan", `groups/${GROUP_ID}/projects/${PROJECT_ID}`, "--plan", planFile];
        const code = await runCli([...args, "--shards", "2", "--runs-dir", runsDir], createDefaultRegistry(), line => logs.push(line), {
          pluginsHomeDir: home,
          spawnLocalStressWorker: async (identity, timeout) => spawnLocalStressWorker([fileURLToPath(new URL("../dist/bin.js", import.meta.url)), "stress-plan-worker", "--run-id", identity.runId, "--worker-id", identity.workerId], timeout,
            { env: { ...process.env, USERPROFILE: childHome, HOME: childHome } }),
        });
        expect(code, logs.join("\n")).toBe(1);
        const files = readdirSync(runsDir).filter(f => f.endsWith(".json")); expect(files).toHaveLength(1);
        const reportText = readFileSync(join(runsDir, files[0]!), "utf8");
        expect(reportText).toContain("缺少字段"); expect(reportText).not.toContain("OPERATOR_UNKNOWN");
        expect(seenPaths.length - before).toBe(2);
        expect(existsSync(marker)).toBe(false);
      }
    } finally { process.chdir(previous); }
  });

  it("preserves plugin_runtime_mismatch from prepare before any VU or HTTP request", async () => {
    let captured = "", prepared = 0;
    const before = seenPaths.length;
    const running = runCli(["run-stress", API_PATH, "--case", CASE_ID, "--concurrency", "2", "--iterations", "2", "--shards", "2", "--runs-dir", join(root, ".apicc", "plugin-mismatch")], createDefaultRegistry(), () => {}, {
      loadPlugins: false,
      spawnLocalStressWorker: (identity, timeout, prepare) => localStressWorker(identity, timeout, async value => {
        const corrupted = structuredClone(value) as { pluginRuntimeSnapshot: { digest: string } };
        corrupted.pluginRuntimeSnapshot.digest = "0".repeat(64); prepared++;
        try { return await prepare(corrupted); } catch (error) { captured = (error as { code: string }).code; throw error; }
      }),
    });
    expect(await running).toBe(1);
    expect(captured).toBe("plugin_runtime_mismatch"); expect(prepared).toBeGreaterThan(0);
    expect(seenPaths.length).toBe(before);
    expect(JSON.stringify(readLastReport(join(root, ".apicc", "plugin-mismatch")))).toContain("plugin_runtime_mismatch");
  });
  it("prepare cancellation completes before an unrelated next event-loop turn and sends no requests", async () => {
    let entered!: () => void, release!: () => void;
    const preparing = new Promise<void>((resolve) => { entered = resolve; }), before = seenPaths.length;
    const running = runCli(["run-stress", API_PATH, "--case", CASE_ID, "--concurrency", "2", "--iterations", "2", "--shards", "2", "--runs-dir", join(root, ".apicc", "runs-prepare-cancel")], createDefaultRegistry(), () => {}, {
      spawnLocalStressWorker: (identity, timeout) => localStressWorker(identity, timeout, async (_configuration, signal) => new Promise<never>((_resolve, reject) => {
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        signal?.addEventListener("abort", abort, { once: true }); release = () => { signal?.removeEventListener("abort", abort); reject(new Error("fixture released")); }; entered();
      })),
    });
    await preparing; process.emit("SIGINT");
    try {
      const outcome = await Promise.race([running.then(() => "finished"), new Promise<string>((resolve) => setImmediate(() => resolve("still-preparing")))]);
      expect(outcome).toBe("finished"); expect(await running).toBe(1); expect(seenPaths.length).toBe(before);
    } finally { release(); await running; }
  });
  it("SIGINT stops the single-process legacy entry and returns a nonzero incomplete report", async () => {
    const runsDir = join(root, ".apicc", "runs-interrupt");
    interruptRequest = () => { interruptRequest = undefined; process.emit("SIGINT"); };
    try {
      const code = await runCli(["run-stress", API_PATH, "--case", CASE_ID, "--concurrency", "1", "--iterations", "100", "--runs-dir", runsDir], createDefaultRegistry());
      expect(code).toBe(1); expect(readLastReport(runsDir)).toMatchObject({ incomplete: true, verdict: { passed: false } });
    } finally { interruptRequest = undefined; }
  });
  it("--shards 1 零行为变化：不 spawn 子进程、报告不挂 distributed 段", async () => {
    const factoryCalls: number[] = [];
    const deps: RunCliDeps = {
      spawnWorkerFactory: (ms) => {
        factoryCalls.push(ms);
        return async () => { throw new Error("shards=1 不应 spawn worker"); };
      },
    };
    const runsDir = join(root, ".apicc", "runs-single");
    const logs: string[] = [];
    const code = await runCli(
      ["run-stress", API_PATH, "--case", "00000000-0000-4000-8000-000000000015", "--env", "dev", "--concurrency", "2",
        "--iterations", "4", "--runs-dir", runsDir, "--shards", "1"],
      createDefaultRegistry(),
      (l) => logs.push(l),
      deps,
    );
    expect(code).toBe(0);
    expect(factoryCalls).toHaveLength(0);
    const report = readLastReport(runsDir);
    expect(report.totalRequests).toBe(4);
    expect(report.concurrency).toBe(2);
    // 裁定 C：shards=1 保持 M2-C 报告原样，不新增 distributed 段。
    expect("distributed" in report).toBe(false);
    expect(logs.join("\n")).toContain("压测完成");
  });

  it("gates each redirect hop in the real legacy CLI factory at concurrency one", async () => {
    const state = await fileStorage.load(root), project = state.workspace.groups[0]!.projects[0]!;
    const asset = project.collections[0]!.apis[0]!, originalPath = asset.contract.request.path, originalSettings = asset.cases[0]!.requestSettingsOverride;
    asset.contract.request.path = "/f6-redirect";
    asset.cases[0]!.requestSettingsOverride = { followRedirects: true };
    await fileStorage.save(root, state.workspace, { expectedRevision: state.revision, deletions: [] });
    redirectHops.length = 0;
    try {
      const code = await runCli(["run-stress", API_PATH, "--case", CASE_ID, "--concurrency", "1", "--iterations", "1", "--max-rps", "1", "--runs-dir", join(root, ".apicc", "redirect-run")], createDefaultRegistry());
      expect(code).toBe(0); expect(redirectHops).toHaveLength(2);
      expect(redirectHops[1]! - redirectHops[0]!).toBeGreaterThanOrEqual(950);
      expect(readLastReport(join(root, ".apicc", "redirect-run"))).toMatchObject({ totalRequests: 1, ok: 1 });
      const planFile = join(root, '.apicc', 'short-arrival.json'), logs: string[] = [];
      writeFileSync(planFile, JSON.stringify({ formatVersion: 1, target: { kind: 'case', collectionId: COLLECTION_ID, apiId: API_ID, caseId: CASE_ID },
        load: { kind: 'constant-arrival', rate: 0.6 }, maxVus: 1, termination: { durationMs: 1000 } }));
      await runCli(['run-stress-plan', `groups/${GROUP_ID}/projects/${PROJECT_ID}`, '--plan', planFile, '--runs-dir', join(root, '.apicc', 'short-arrival-run')], createDefaultRegistry(), line => logs.push(line));
      expect(logs.join('\n')).toContain('fewer than 20 planned slots');
      expect(logs.join('\n')).toContain('cannot verify 5%');
    } finally {
      const current = await fileStorage.load(root);
      current.workspace.groups[0]!.projects[0]!.collections[0]!.apis[0]!.contract.request.path = originalPath;
      current.workspace.groups[0]!.projects[0]!.collections[0]!.apis[0]!.cases[0]!.requestSettingsOverride = originalSettings;
      await fileStorage.save(root, current.workspace, { expectedRevision: current.revision, deletions: [] });
    }
  });

  it("--shards 2 uses v3 remote sessions with a single shared budget and preserves distributed diagnostics", async () => {
    const specs: import("@apicc/core").StressWorkerSpecBase[] = [];
    const workerIds: string[] = [];
    let factoryTimeoutMs = -1;
    const deps: RunCliDeps = {
      spawnLocalStressWorker: (identity, ms, prepare) => {
        factoryTimeoutMs = ms; workerIds.push(identity.workerId);
        return localStressWorker(identity, ms, async (value) => { specs.push(value as import("@apicc/core").StressWorkerSpecBase); return prepare(value); });
      },
    };
    const runsDir = join(root, ".apicc", "runs-shards");
    const logs: string[] = [];
    const code = await runCli(
      ["run-stress", API_PATH, "--case", "00000000-0000-4000-8000-000000000015", "--env", "dev", "--concurrency", "4",
        "--iterations", "8", "--shards", "2", "--runs-dir", runsDir],
      createDefaultRegistry(),
      (l) => logs.push(l),
      deps,
    );
    expect(code).toBe(0);
    // spawnWorkerFactory 收到默认 shard 超时（300s，毫秒口径）。
    expect(factoryTimeoutMs).toBe(300_000);
    // specBase 组装正确：8 次迭代/并发 4 拆成两份（planShards D3），锚点字段齐备。
    expect(specs).toHaveLength(2);
    expect(specs.map((s) => s.maxIterations)).toEqual([8, 8]); // Descriptors are global; workers never schedule them.
    expect(specs.map((s) => s.concurrency)).toEqual([4, 4]);
    expect(workerIds).toEqual(["worker-1", "worker-2"]);
    for (const s of specs) {
      expect("protocolVersion" in s).toBe(false);
      expect(s.apiPath).toBe(API_PATH);
      expect(s.caseId).toBe(CASE_ID);
      expect(s.envName).toBe("dev");
      expect(s.workspaceRoot).toBe(root);
    }
    const report = readLastReport(runsDir);
    expect(report.totalRequests).toBe(8);
    const distributed = report.distributed as {
      shards: number;
      perShard: Array<{ shardId: string; totalRequests: number; ok: number; failed: number; rps: number }>;
      shardErrors?: unknown;
    };
    expect(distributed.shards).toBe(2);
    expect(distributed.perShard.reduce((sum, p) => sum + p.totalRequests, 0)).toBe(8);
    expect(distributed.perShard.every((p) => p.ok === p.totalRequests && p.failed === 0)).toBe(true);
    expect(distributed.shardErrors).toBeUndefined();
    // 摘要日志含各 shard 行（计划步骤 2：摘要日志含各 shard 行）。
    expect(logs.join("\n")).toContain("worker-1");
    expect(logs.join("\n")).toContain("worker-2");
  });

  it("部分 shard 失败：退出码 1、打「shard 失败」摘要、报告留成功样本与 shardErrors；--shard-timeout 透传工厂", async () => {
    let factoryTimeoutMs = -1;
    const deps: RunCliDeps = {
      spawnLocalStressWorker: (identity, ms, prepare) => {
        factoryTimeoutMs = ms;
        return localStressWorker(identity, ms, async (value) => { if (identity.workerId === "worker-2") throw new Error("private worker failure text"); return prepare(value); });
      },
    };
    const runsDir = join(root, ".apicc", "runs-partial");
    const logs: string[] = [];
    const code = await runCli(
      ["run-stress", API_PATH, "--case", "00000000-0000-4000-8000-000000000015", "--env", "dev", "--concurrency", "4",
        "--iterations", "8", "--shards", "2", "--shard-timeout", "7", "--runs-dir", runsDir],
      createDefaultRegistry(),
      (l) => logs.push(l),
      deps,
    );
    expect(code).toBe(1);
    // --shard-timeout 秒 → 毫秒透传 spawnWorkerFactory（裁定 A 同值超时口径）。
    expect(factoryTimeoutMs).toBe(7_000);
    expect(logs.join("\n")).toContain("shard 失败");
    expect(logs.join("\n")).toContain("worker_incomplete_rich_output_withheld");
    expect(logs.join("\n")).not.toContain("private worker failure text");
    const report = readLastReport(runsDir);
    expect(report.totalRequests).toBe(0); // Preparation failed before the shared start barrier.
    const distributed = report.distributed as {
      perShard: Array<{ shardId: string }>;
      shardErrors: Array<{ shardId: string; error: string }>;
    };
    expect(distributed.perShard).toMatchObject([{ shardId: "worker-1", totalRequests: 0 }]);
    expect(distributed.shardErrors).toEqual(["worker-1", "worker-2"].map((shardId) => ({ shardId, error: "worker_incomplete_rich_output_withheld" })));
  });

  it("--shards 0 / --shards 2.5 非法值：前置校验拒绝（shards 必须为正整数）", async () => {
    await expect(runCli(
      ["run-stress", API_PATH, "--case", CASE_ID, "--env", "dev", "--concurrency", "2",
        "--iterations", "4", "--shards", "0", "--runs-dir", join(root, ".apicc", "runs-invalid-0")],
      createDefaultRegistry(),
      () => {},
    )).rejects.toThrow(/shards 必须为正整数，收到 0/);
    await expect(runCli(
      ["run-stress", API_PATH, "--case", CASE_ID, "--env", "dev", "--concurrency", "2",
        "--iterations", "4", "--shards", "2.5", "--runs-dir", join(root, ".apicc", "runs-invalid-2.5")],
      createDefaultRegistry(),
      () => {},
    )).rejects.toThrow(/shards 必须为正整数，收到 2\.5/);
  });

  it("--shards 2 非法数值参数：concurrency 0/NaN、iterations 3.5 前置守卫干净中文报错（不经 planShards 静默升级/ZodError）", async () => {
    // 多 shard 路径历史分歧：concurrency 0 被 planShards 静默升为 [1,1]（单机路径是 StressRunner 中文报错）；
    // concurrency/iterations 为 NaN 时在 StressWorkerSpecSchema.parse 抛裸英文 ZodError。
    const base = ["run-stress", API_PATH, "--case", CASE_ID, "--env", "dev", "--shards", "2",
      "--runs-dir", join(root, ".apicc", "runs-invalid-numeric")];
    await expect(runCli([...base, "--concurrency", "0", "--iterations", "4"],
      createDefaultRegistry(), () => {})).rejects.toThrow(/concurrency 必须为正 safe integer，收到 0/);
    await expect(runCli([...base, "--concurrency", "abc", "--iterations", "4"],
      createDefaultRegistry(), () => {})).rejects.toThrow(/concurrency 必须为正 safe integer，收到 NaN/);
    await expect(runCli([...base, "--concurrency", "2", "--iterations", "3.5"],
      createDefaultRegistry(), () => {})).rejects.toThrow(/iterations 必须为正 safe integer，收到 3\.5/);
  });

  it("keeps the VU capacity guard and supports a single global maxRps with multiple workers", async () => {
    let spawned = 0;
    const deps: RunCliDeps = { spawnLocalStressWorker: (...args) => { spawned++; return localStressWorker(...args); } };
    const common = ["run-stress", API_PATH, "--case", CASE_ID, "--env", "dev", "--iterations", "4", "--runs-dir", join(root, ".apicc", "runs-safety")];
    await expect(runCli([...common, "--concurrency", "1", "--shards", "2"], createDefaultRegistry(), () => {}, deps))
      .rejects.toThrow(/shards 不能大于 concurrency/);
    expect(spawned).toBe(0);
    expect(await runCli([...common, "--concurrency", "4", "--shards", "2", "--max-rps", "10"], createDefaultRegistry(), () => {}, deps)).toBe(0);
    expect(spawned).toBe(2);
  });

  it("CLI 在任何目标解析前拒绝 NaN/Infinity duration、fractional/overflow iterations", async () => {
    const common = ["run-stress", API_PATH, "--case", CASE_ID, "--concurrency", "1"];
    await expect(runCli([...common, "--duration", "abc"], createDefaultRegistry(), () => {}))
      .rejects.toThrow(/duration 必须为有限正数/);
    await expect(runCli([...common, "--duration", "Infinity"], createDefaultRegistry(), () => {}))
      .rejects.toThrow(/duration 必须为有限正数/);
    await expect(runCli([...common, "--iterations", "1.5"], createDefaultRegistry(), () => {}))
      .rejects.toThrow(/iterations 必须为正 safe integer/);
    await expect(runCli([...common, "--iterations", "9007199254740992"], createDefaultRegistry(), () => {}))
      .rejects.toThrow(/iterations 必须为正 safe integer/);
  });
});

describe("C1 Fix2 dedicated private worker IPC", () => {
  function ownedChild() {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), connected: true,
      send: vi.fn((_frame: unknown, callback: (error: Error | null) => void) => { callback(null); return true; }),
      disconnect: vi.fn(() => { child.connected = false; child.emit("disconnect"); }),
      kill: vi.fn(() => { child.emit("close", null); return true; }),
    });
    return child;
  }
  const spec: StressWorkerSpec = { protocolVersion: 2, shardId: "s0", apiPath: "/api", caseId: "c", definitionRevision: "r", credentialVersions: {}, networkIdentity: `sha256:${"0".repeat(64)}`, concurrency: 1, maxIterations: 1, workspaceRoot: "/ws" };

  it("exchanges markers only over IPC, drains raw diagnostics and removes owned listeners on completion", async () => {
    const child = ownedChild(); const abort = new AbortController();
    const channel = Object.assign(new EventEmitter(), { connected: true, send: (frame: unknown, callback: (error: Error | null) => void) => { child.emit("message", frame); callback(null); return true; } });
    child.send.mockImplementation((frame, callback) => { callback(null); channel.emit("message", frame); return true; });
    const spawnFake = vi.fn(() => child as unknown as ChildProcess);
    const pipe = vi.spyOn(child.stderr, "pipe");
    const result = createPrivateStressWorkerFactory(1000, () => ["synthetic-cli", "stress-worker"], parseShardOutcomeStdout, spawnFake as unknown as typeof spawn)(spec, {
      signal: abort.signal, finalizeEvidence: async (markers) => { expect(markers).toEqual(["private-ipc-token"]); return [...markers, "other-worker-token"]; },
    });
    child.stderr.emit("data", Buffer.from("raw private-ipc-token must never reach human stderr"));
    const union = await createWorkerEvidenceFinalizer("s0", channel as unknown as NodeJS.Process)(["private-ipc-token"]);
    expect(union).toEqual(["private-ipc-token", "other-worker-token"]);
    expect(JSON.stringify(spawnFake.mock.calls)).not.toContain("private-ipc-token");
    const publicResult: ShardResult = { protocolVersion: 2, ok: true, shardId: "s0", samples: [sample(1)], generator: generator(), measurementWindow: measurementWindow(1) };
    child.stdout.emit("data", Buffer.from(JSON.stringify(publicResult)));
    child.disconnect(); child.emit("close", 0);
    expect(await result).toEqual(publicResult); expect(pipe).not.toHaveBeenCalled();
    expect(JSON.stringify(await result)).not.toContain("markers");
    for (const event of ["message", "disconnect", "error", "close"]) expect(child.listenerCount(event)).toBe(0);
    expect(channel.listenerCount("message")).toBe(0); expect(channel.listenerCount("disconnect")).toBe(0);
    expect(child.stdout.listenerCount("data")).toBe(0); expect(child.stderr.listenerCount("data")).toBe(0);
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("disconnect and timeout settle private waiters, kill only the owned child and never echo a malformed payload", async () => {
    const channel = Object.assign(new EventEmitter(), { connected: true, send: (_value: unknown, callback: (error: Error | null) => void) => { callback(null); return true; } });
    const waiting = createWorkerEvidenceFinalizer("s0", channel as unknown as NodeJS.Process)(["private-before-disconnect"]);
    channel.emit("disconnect"); await expect(waiting).rejects.toThrow("Private evidence exchange failed");
    expect(channel.listenerCount("message")).toBe(0); expect(channel.listenerCount("disconnect")).toBe(0);
    const child = ownedChild(); const abort = new AbortController();
    const result = createPrivateStressWorkerFactory(1000, () => [], parseShardOutcomeStdout, (() => child) as unknown as typeof spawn)(spec, { signal: abort.signal, finalizeEvidence: async () => [] });
    child.emit("message", { kind: "bad", "private-invalid-value": "raw" });
    await expect(result).rejects.toThrow("private_protocol_invalid");
    expect(child.kill).toHaveBeenCalledTimes(1); expect(child.listenerCount("error")).toBe(0); expect(child.listenerCount("close")).toBe(0);
    expect(getEventListeners(abort.signal, "abort")).toHaveLength(0);
    const timedChild = ownedChild();
    await expect(createPrivateStressWorkerFactory(10, () => [], parseShardOutcomeStdout, (() => timedChild) as unknown as typeof spawn)(spec, { signal: new AbortController().signal, finalizeEvidence: async () => [] })).rejects.toThrow("timeout");
    expect(timedChild.kill).toHaveBeenCalledTimes(1); expect(timedChild.listenerCount("error")).toBe(0); expect(timedChild.listenerCount("close")).toBe(0);
  });
});

describe("parseShardOutcomeStdout（裁定 B①：协调端 stdout 从末按行解析纯函数）", () => {
  it("C1 Fix2 malformed worker output never echoes private or unvalidated business keys", () => {
    let message = "";
    try { parseShardOutcomeStdout(JSON.stringify({ protocolVersion: 2, ok: false, shardId: "s0", error: "normal", "unvalidated-private-value": "raw" }), { shardId: "s0", exitCode: 1 }); }
    catch (error) { message = (error as Error).message; }
    expect(message).toContain("protocol_invalid");
    expect(message).not.toContain("unvalidated-private-value");
  });
  const ctx = { shardId: "s0", exitCode: 0 } as const;

  it("污染行 + 末行 JSON：跳过日志行取末条合法 ShardOutcome", () => {
    const result: ShardResult = {
      protocolVersion: 2, ok: true, shardId: "s0",
      samples: [sample(1)], generator: generator(), measurementWindow: measurementWindow(1),
    };
    const stdout = [
      "[INFO] worker 启动",
      "压测完成：总计 1 · 成功 1 · 失败 0", // 人类日志意外串入 stdout 的污染行
      JSON.stringify(result),
    ].join("\n");
    const outcome = parseShardOutcomeStdout(stdout, ctx);
    expect(outcome).toEqual(result);
  });

  it("末 v1 failure 不会回退到更早的 v2 success", () => {
    const success: ShardResult = { protocolVersion: 2, ok: true, shardId: "s0", samples: [sample(1)], generator: generator(), measurementWindow: measurementWindow(1) };
    const legacy = { protocolVersion: 1, ok: false, shardId: "s0", error: "legacy" };
    expect(() => parseShardOutcomeStdout(`${JSON.stringify(success)}\n${JSON.stringify(legacy)}`, { shardId: "s0", exitCode: 1 }))
      .toThrow(/协议|protocolVersion/);
  });

  it("末 JSON object 结构无效时不回退更早成功结果", () => {
    const success: ShardResult = { protocolVersion: 2, ok: true, shardId: "s0", samples: [sample(1)], generator: generator(), measurementWindow: measurementWindow(1) };
    expect(() => parseShardOutcomeStdout(`${JSON.stringify(success)}\n${JSON.stringify({ protocolVersion: 2, ok: true })}`, { shardId: "s0", exitCode: 0 }))
      .toThrow(/协议|protocol/);
  });

  it("非零 exit 携带 ShardResult 时拒绝伪装成功", () => {
    const success: ShardResult = { protocolVersion: 2, ok: true, shardId: "s0", samples: [sample(1)], generator: generator(), measurementWindow: measurementWindow(1) };
    expect(() => parseShardOutcomeStdout(JSON.stringify(success), { shardId: "s0", exitCode: 1 }))
      .toThrow(/exit|退出|protocol/);
  });

  it.each([
    [null, "null"], [undefined, "undefined"], [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "Infinity"], [1.5, "1.5"],
  ])("ShardFailure 拒绝非法退出状态 %s", (exitCode, _label) => {
    const failure: ShardFailure = { protocolVersion: 2, ok: false, shardId: "s0", error: "原始失败" };
    expect(() => parseShardOutcomeStdout(JSON.stringify(failure), { shardId: "s0", exitCode }))
      .toThrow(/protocol_exit_mismatch/);
  });

  it("合法整数非零退出状态的 ShardFailure 仍可解析", () => {
    const failure: ShardFailure = { protocolVersion: 2, ok: false, shardId: "s0", error: "原始失败" };
    expect(parseShardOutcomeStdout(JSON.stringify(failure), { shardId: "s0", exitCode: 7 })).toEqual(failure);
  });

  it("末行 ShardFailure 同样可解析（失败路径协议行）", () => {
    const failure: ShardFailure = { protocolVersion: 2, ok: false, shardId: "s7", error: "未找到用例" };
    const stdout = `noise\n${JSON.stringify(failure)}\n`;
    const outcome = parseShardOutcomeStdout(stdout, { shardId: "s7", exitCode: 1 });
    expect(outcome.ok).toBe(false);
    expect(outcome).toEqual(failure);
  });

  it("全部行非法：抛「协议输出无效」，文案含 shard 标识与退出码", () => {
    const garbage = "不是 JSON\n{\"ok\":true 但非法}\n";
    expect(() => parseShardOutcomeStdout(garbage, { shardId: "s9", exitCode: 3 }))
      .toThrow(/s9 协议输出无效.*退出码 3/s);
    expect(() => parseShardOutcomeStdout("", { shardId: "s9", exitCode: null }))
      .toThrow(/协议输出无效/);
  });

  it("非末行历史协议行不被回取：仅取从末第一条合法行（旧结果行被末行覆盖）", () => {
    const stale: ShardFailure = { protocolVersion: 2, ok: false, shardId: "s0", error: "旧" };
    const fresh: ShardResult = { protocolVersion: 2, ok: true, shardId: "s0", samples: [], generator: generator(), measurementWindow: measurementWindow(0) };
    const stdout = `${JSON.stringify(stale)}\n${JSON.stringify(fresh)}`;
    expect(parseShardOutcomeStdout(stdout, ctx)).toEqual(fresh);
  });
});

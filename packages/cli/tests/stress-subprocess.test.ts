import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileStorage, type Workspace } from "@apicc/core";

// 本文件覆盖 M2-D1 任务 3：defaultSpawnWorkerFactory 真实子进程端到端（任务 2 审查移交的覆盖缺口）。
// Windows 约束：spawn process.execPath + [dist/bin.js]，禁 shell:true。

const BIN_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "bin.js");
const API_PATH = "groups/demo/projects/svc/collections/api/apis/ok";

interface SpawnResult { code: number; stdout: string; stderr: string }

/** 真实子进程执行 CLI（与 defaultSpawnWorkerFactory 同款传输：node 直接调 bin.js）。 */
function spawnCli(args: string[], cwd: string): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN_PATH, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
    child.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** 读 runs 目录下最新的 stress-*.json 报告。 */
function readLastReport(runsDir: string): Record<string, unknown> {
  const files = readdirSync(runsDir).filter((f) => f.startsWith("stress-") && f.endsWith(".json"));
  expect(files.length).toBeGreaterThan(0);
  return JSON.parse(readFileSync(join(runsDir, files[files.length - 1]!), "utf8")) as Record<string, unknown>;
}

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  // 裁定 A：e2e 依赖构建产物先于测试存在；缺失时给可读修复指引（pnpm test 已自动前置构建）。
  if (!existsSync(BIN_PATH)) {
    throw new Error(`未找到构建产物 ${BIN_PATH}——请先执行 pnpm build（pnpm test 脚本已自动前置构建）`);
  }
  // /x → 200（成功路径）；/boom → 500（全失败口径）；/slow → 8s 后才响应（触发 shard 超时崩溃）。
  // 端口动态，故每用例独立建工作区。
  server = createServer((req, res) => {
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
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** 每用例独立临时工作区：ok 接口打 /x（200），bad 接口打 /boom（500）。 */
async function makeWorkspace(name: string): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), `apicc-subproc-${name}-`));
  const ws: Workspace = {
    id: "w1", name: `subproc-${name}`, variables: {},
    groups: [{
      id: "g1", name: "demo", projects: [{
        id: "p1", name: "svc", variables: {},
        workflows: [],
        environments: [{ id: "e1", name: "dev", variables: { baseUrl } }],
        collections: [{
          id: "c1", name: "api", variables: {}, folders: [],
          apis: [
            {
              id: "a1", name: "ok", version: "1", deprecated: false, method: "GET",
              url: "{{baseUrl}}/x", headers: [], query: [],
              cases: [{ id: "t1", name: "passes", scope: "base", parameters: {}, assertions: [] }],
            },
            {
              id: "a2", name: "bad", version: "1", deprecated: false, method: "GET",
              url: "{{baseUrl}}/boom", headers: [], query: [],
              cases: [{ id: "t2", name: "fails", scope: "base", parameters: {}, assertions: [] }],
            },
            {
              id: "a3", name: "slow", version: "1", deprecated: false, method: "GET",
              url: "{{baseUrl}}/slow", headers: [], query: [],
              cases: [{ id: "t3", name: "hangs", scope: "base", parameters: {}, assertions: [] }],
            },
          ],
        }],
      }],
    }],
  };
  await fileStorage.save(root, ws);
  return root;
}

describe("run-stress 真实子进程多 shard 端到端", () => {
  it("成功合并：--shards 2 → exit 0，total=8、distributed.shards=2、perShard 各 4，p50 落在 [min,max]", async () => {
    const root = await makeWorkspace("ok");
    const runsDir = join(root, "runs");
    const res = await spawnCli(
      ["run-stress", API_PATH, "--case", "t1", "--env", "dev", "--concurrency", "2",
        "--iterations", "8", "--shards", "2", "--runs-dir", runsDir],
      root,
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain("压测完成");
    // 摘要含各 shard 行（真实子进程产出，非注入替身）。
    expect(res.stdout).toContain("shard-0");
    expect(res.stdout).toContain("shard-1");
    const report = readLastReport(runsDir);
    expect(report.totalRequests).toBe(8);
    expect(report.ok).toBe(8);
    const distributed = report.distributed as {
      shards: number;
      perShard: Array<{ shardId: string; totalRequests: number; ok: number; failed: number }>;
    };
    expect(distributed.shards).toBe(2);
    expect(distributed.perShard.map((p) => p.totalRequests).sort()).toEqual([4, 4]);
    expect(distributed.perShard.every((p) => p.ok === 4 && p.failed === 0)).toBe(true);
    // 报告不含原始样本（无法手工 computeReport 对账），按计划口径以 p50∈[min,max] 代偿校验分位面。
    const l = report.latency as { min: number; max: number; p50: number };
    expect(l.p50).toBeGreaterThanOrEqual(l.min);
    expect(l.p50).toBeLessThanOrEqual(l.max);
  }, 60000);

  it("全失败传播：server 500 且 iterations=4/shards=2 → exit 1（全部失败口径），perShard 各 2 全败", async () => {
    const root = await makeWorkspace("bad");
    const runsDir = join(root, "runs");
    const res = await spawnCli(
      ["run-stress", "groups/demo/projects/svc/collections/api/apis/bad", "--case", "t2", "--env", "dev",
        "--concurrency", "2", "--iterations", "4", "--shards", "2", "--runs-dir", runsDir],
      root,
    );
    expect(res.code).toBe(1);
    const report = readLastReport(runsDir);
    expect(report.totalRequests).toBe(4);
    expect(report.ok).toBe(0);
    expect(report.failed).toBe(4);
    const distributed = report.distributed as {
      shards: number;
      perShard: Array<{ totalRequests: number; ok: number; failed: number }>;
      shardErrors?: unknown;
    };
    expect(distributed.shards).toBe(2);
    expect(distributed.perShard.map((p) => p.totalRequests).sort()).toEqual([2, 2]);
    expect(distributed.perShard.every((p) => p.ok === 0 && p.failed === 2)).toBe(true);
    // worker 本身成功回传（ShardResult），不算 shard 失败。
    expect(distributed.shardErrors).toBeUndefined();
  }, 60000);

  it("坏 caseId：run-stress 前置用例门拒绝（不 spawn worker、不落报告），exit 1 且错误走 stderr", async () => {
    // 计划原案「不存在 caseId 触发 worker 失败」与实际设计不符：run-stress 与 worker 共享
    // resolveStressTarget 用例门，父进程在协调前即拒绝。此处按真实契约断言。
    const root = await makeWorkspace("crash");
    const runsDir = join(root, "runs");
    const res = await spawnCli(
      ["run-stress", API_PATH, "--case", "不存在", "--env", "dev", "--concurrency", "2",
        "--iterations", "4", "--shards", "2", "--runs-dir", runsDir],
      root,
    );
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("未找到用例: 不存在");
    expect(res.stdout).not.toContain("shard 失败");
    expect(existsSync(runsDir)).toBe(false);
  }, 60000);

  it("shard 崩溃传播：/slow 挂起 + --shard-timeout 1 → 两 worker 超时判失败，exit 1 且报告 shardErrors 有条目", async () => {
    // 走专用 /slow 接口（8s 才响应），确保 1s shard 超时必然先到——不依赖进程启动快慢的偶然时序。
    const root = await makeWorkspace("timeout");
    const runsDir = join(root, "runs");
    const res = await spawnCli(
      ["run-stress", "groups/demo/projects/svc/collections/api/apis/slow", "--case", "t3", "--env", "dev",
        "--concurrency", "2", "--iterations", "4", "--shards", "2", "--shard-timeout", "1", "--runs-dir", runsDir],
      root,
    );
    expect(res.code).toBe(1);
    expect(res.stdout).toContain("shard 失败");
    const report = readLastReport(runsDir);
    expect(report.totalRequests).toBe(0);
    const distributed = report.distributed as {
      shardErrors: Array<{ shardId: string; error: string }>;
    };
    expect(distributed.shardErrors).toHaveLength(2);
    expect(distributed.shardErrors.map((e) => e.shardId)).toEqual(["shard-0", "shard-1"]);
    expect(distributed.shardErrors.every((e) => e.error.includes("超时"))).toBe(true);
  }, 60000);
});

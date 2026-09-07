import { createServer, type Server } from "node:http";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDefaultRegistry,
  fileStorage,
  type ShardFailure,
  ShardFailureSchema,
  type ShardResult,
  ShardResultSchema,
  type StressWorkerSpec,
  type Workspace,
} from "@apicc/core";
import { parseShardOutcomeStdout, runCli, type RunCliDeps } from "../src/main.js";

// 本文件覆盖 M2-D1 任务 2：stress-worker 子命令（stdout 末行 JSON 契约）与 run-stress --shards
// 协调分支（spawn 实现可注入——真实子进程端到端留任务 3）。

let server: Server;
let baseUrl = "";
let root: string;
let prevCwd = "";
/** 本文件创建的临时工作区根（afterAll 统一清理，模式与姊妹文件 stress-subprocess.test.ts 一致）。 */
const tempRoots: string[] = [];

const API_PATH = "groups/demo/projects/svc/collections/api/apis/ok";

/** 读 runs 目录下最新的 stress-*.json 报告（文件名排序取末位，不依赖 readdir 目录序假设）。 */
function readLastReport(runsDir: string): Record<string, unknown> {
  const files = readdirSync(runsDir).filter((f) => f.startsWith("stress-") && f.endsWith(".json")).sort();
  expect(files.length).toBeGreaterThan(0);
  return JSON.parse(readFileSync(join(runsDir, files[files.length - 1]!), "utf8")) as Record<string, unknown>;
}

beforeAll(async () => {
  server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  root = mkdtempSync(join(tmpdir(), "apicc-worker-"));
  tempRoots.push(root);
  const ws: Workspace = {
    id: "00000000-0000-4000-8000-000000000001", name: "worker-e2e", variables: {},
    groups: [{
      id: "00000000-0000-4000-8000-000000000002", name: "demo", projects: [{
        id: "00000000-0000-4000-8000-000000000004", name: "svc", variables: {},
        workflows: [],
        environments: [{ id: "00000000-0000-4000-8000-000000000006", name: "dev", variables: { baseUrl } }],
        collections: [{
          id: "00000000-0000-4000-8000-000000000008", name: "api", variables: {}, folders: [],
          apis: [{
            id: "00000000-0000-4000-8000-000000000011", name: "ok", version: "1", deprecated: false, method: "GET",
            url: "{{baseUrl}}/x", headers: [], query: [],
            cases: [{ id: "00000000-0000-4000-8000-000000000015", name: "passes", scope: "base", parameters: {}, assertions: [] }],
          }],
        }],
      }],
    }],
  };
  await fileStorage.save(root, ws);
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
  it("成功：stdout 仅末行 JSON 且通过 ShardResultSchema，样本数等于迭代数，退出码 0", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const deps: RunCliDeps = { workerOut: (l) => out.push(l), workerErr: (l) => err.push(l) };
    const code = await runCli(
      ["stress-worker", API_PATH, "--case", "00000000-0000-4000-8000-000000000015", "--env", "dev", "--concurrency", "2",
        "--iterations", "4", "--shard-id", "s0", "--workspace", root],
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
    expect(outcome.protocolVersion).toBe(1);
    // totalRequests 以 samples.length 验证（计划步骤 1 测试 1 的口径）。
    expect(outcome.samples).toHaveLength(4);
    expect(outcome.samples.every((s) => s.ok && s.status === 200)).toBe(true);
  });

  it("用例不存在：末行通过 ShardFailureSchema、错误信息走 stderr、退出码 1", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const deps: RunCliDeps = { workerOut: (l) => out.push(l), workerErr: (l) => err.push(l) };
    const code = await runCli(
      ["stress-worker", API_PATH, "--case", "不存在", "--env", "dev", "--concurrency", "2",
        "--iterations", "4", "--shard-id", "s1", "--workspace", root],
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
  it("--shards 1 零行为变化：不 spawn 子进程、报告不挂 distributed 段", async () => {
    const factoryCalls: number[] = [];
    const deps: RunCliDeps = {
      spawnWorkerFactory: (ms) => {
        factoryCalls.push(ms);
        return async () => { throw new Error("shards=1 不应 spawn worker"); };
      },
    };
    const runsDir = join(root, "runs-single");
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

  it("--shards 2 走协调分支（注入进程内替身）：spec 正确拆分、报告合并并挂 distributed 段", async () => {
    const specs: StressWorkerSpec[] = [];
    let factoryTimeoutMs = -1;
    const deps: RunCliDeps = {
      spawnWorkerFactory: (ms) => {
        factoryTimeoutMs = ms;
        return async (spec) => {
          specs.push(spec);
          const samples = Array.from({ length: spec.maxIterations ?? 0 }, (_, i) => ({
            timeMs: 5 + i, status: 200, ok: true,
          }));
          return { protocolVersion: 1, ok: true as const, shardId: spec.shardId, samples };
        };
      },
    };
    const runsDir = join(root, "runs-shards");
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
    expect(specs.map((s) => s.maxIterations).sort()).toEqual([4, 4]);
    expect(specs.map((s) => s.concurrency).sort()).toEqual([2, 2]);
    expect(specs.map((s) => s.shardId)).toEqual(["shard-0", "shard-1"]);
    for (const s of specs) {
      expect(s.protocolVersion).toBe(1);
      expect(s.apiPath).toBe(API_PATH);
      expect(s.caseId).toBe("00000000-0000-4000-8000-000000000015");
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
    expect(distributed.perShard.map((p) => p.totalRequests).sort()).toEqual([4, 4]);
    expect(distributed.perShard.every((p) => p.ok === 4 && p.failed === 0)).toBe(true);
    expect(distributed.shardErrors).toBeUndefined();
    // 摘要日志含各 shard 行（计划步骤 2：摘要日志含各 shard 行）。
    expect(logs.join("\n")).toContain("shard-0");
    expect(logs.join("\n")).toContain("shard-1");
  });

  it("部分 shard 失败：退出码 1、打「shard 失败」摘要、报告留成功样本与 shardErrors；--shard-timeout 透传工厂", async () => {
    let factoryTimeoutMs = -1;
    const deps: RunCliDeps = {
      spawnWorkerFactory: (ms) => {
        factoryTimeoutMs = ms;
        return async (spec) => {
          if (spec.shardId === "shard-1") {
            return { protocolVersion: 1, ok: false as const, shardId: spec.shardId, error: "注入的 shard 失败" };
          }
          const samples = Array.from({ length: spec.maxIterations ?? 0 }, (_, i) => ({
            timeMs: 3 + i, status: 200, ok: true,
          }));
          return { protocolVersion: 1, ok: true as const, shardId: spec.shardId, samples };
        };
      },
    };
    const runsDir = join(root, "runs-partial");
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
    expect(logs.join("\n")).toContain("注入的 shard 失败");
    const report = readLastReport(runsDir);
    expect(report.totalRequests).toBe(4); // 仅成功 shard 样本
    const distributed = report.distributed as {
      perShard: Array<{ shardId: string }>;
      shardErrors: Array<{ shardId: string; error: string }>;
    };
    expect(distributed.perShard.map((p) => p.shardId)).toEqual(["shard-0"]);
    expect(distributed.shardErrors).toEqual([{ shardId: "shard-1", error: "注入的 shard 失败" }]);
  });

  it("--shards 0 / --shards 2.5 非法值：前置校验拒绝（shards 必须为正整数）", async () => {
    await expect(runCli(
      ["run-stress", API_PATH, "--case", "00000000-0000-4000-8000-000000000015", "--env", "dev", "--concurrency", "2",
        "--iterations", "4", "--shards", "0", "--runs-dir", join(root, "runs-invalid-0")],
      createDefaultRegistry(),
      () => {},
    )).rejects.toThrow(/shards 必须为正整数，收到 0/);
    await expect(runCli(
      ["run-stress", API_PATH, "--case", "00000000-0000-4000-8000-000000000015", "--env", "dev", "--concurrency", "2",
        "--iterations", "4", "--shards", "2.5", "--runs-dir", join(root, "runs-invalid-2.5")],
      createDefaultRegistry(),
      () => {},
    )).rejects.toThrow(/shards 必须为正整数，收到 2\.5/);
  });

  it("--shards 2 非法数值参数：concurrency 0/NaN、iterations 3.5 前置守卫干净中文报错（不经 planShards 静默升级/ZodError）", async () => {
    // 多 shard 路径历史分歧：concurrency 0 被 planShards 静默升为 [1,1]（单机路径是 StressRunner 中文报错）；
    // concurrency/iterations 为 NaN 时在 StressWorkerSpecSchema.parse 抛裸英文 ZodError。
    const base = ["run-stress", API_PATH, "--case", "00000000-0000-4000-8000-000000000015", "--env", "dev", "--shards", "2",
      "--runs-dir", join(root, "runs-invalid-numeric")];
    await expect(runCli([...base, "--concurrency", "0", "--iterations", "4"],
      createDefaultRegistry(), () => {})).rejects.toThrow(/concurrency 必须为正整数，收到 0/);
    await expect(runCli([...base, "--concurrency", "abc", "--iterations", "4"],
      createDefaultRegistry(), () => {})).rejects.toThrow(/concurrency 必须为正整数，收到 NaN/);
    await expect(runCli([...base, "--concurrency", "2", "--iterations", "3.5"],
      createDefaultRegistry(), () => {})).rejects.toThrow(/iterations 必须为正整数，收到 3\.5/);
  });
});

describe("parseShardOutcomeStdout（裁定 B①：协调端 stdout 从末按行解析纯函数）", () => {
  const ctx = { shardId: "s0", exitCode: 0 } as const;

  it("污染行 + 末行 JSON：跳过日志行取末条合法 ShardOutcome", () => {
    const result: ShardResult = {
      protocolVersion: 1, ok: true, shardId: "s0",
      samples: [{ timeMs: 1, status: 200, ok: true }],
    };
    const stdout = [
      "[INFO] worker 启动",
      "压测完成：总计 1 · 成功 1 · 失败 0", // 人类日志意外串入 stdout 的污染行
      JSON.stringify(result),
    ].join("\n");
    const outcome = parseShardOutcomeStdout(stdout, ctx);
    expect(outcome).toEqual(result);
  });

  it("末行 ShardFailure 同样可解析（失败路径协议行）", () => {
    const failure: ShardFailure = { protocolVersion: 1, ok: false, shardId: "s7", error: "未找到用例" };
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
    const stale: ShardFailure = { protocolVersion: 1, ok: false, shardId: "s0", error: "旧" };
    const fresh: ShardResult = { protocolVersion: 1, ok: true, shardId: "s0", samples: [] };
    const stdout = `${JSON.stringify(stale)}\n${JSON.stringify(fresh)}`;
    expect(parseShardOutcomeStdout(stdout, ctx)).toEqual(fresh);
  });
});

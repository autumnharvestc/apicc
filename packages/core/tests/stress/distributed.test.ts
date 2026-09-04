import { describe, expect, it } from "vitest";
import { computeReport } from "../../src/stress/aggregate.js";
import {
  DistributedStressCoordinator,
  planShards,
} from "../../src/stress/distributed.js";
import type {
  ShardFailure,
  ShardOutcome,
  ShardResult,
  StressWorkerSpec,
} from "../../src/stress/distributed.js";
import { StressReportSchema } from "../../src/stress/model.js";
import type { StressSample } from "../../src/stress/model.js";

/** 成功 shard 替身回传：固定样本批。 */
const shardResult = (shardId: string, timeMsList: number[]): ShardResult => ({
  protocolVersion: 1,
  ok: true,
  shardId,
  samples: timeMsList.map((t) => ({ timeMs: t, status: 200, ok: true })),
});

/** 失败 shard 替身回传。 */
const shardFailure = (shardId: string, error: string): ShardFailure => ({
  protocolVersion: 1,
  ok: false,
  shardId,
  error,
});

describe("planShards", () => {
  it("iterations 均分：12/3 → [4,4,4]", () => {
    const plans = planShards({ concurrency: 3, maxIterations: 12 }, 3);
    expect(plans.map((p) => p.maxIterations)).toEqual([4, 4, 4]);
  });

  it("iterations 余数给前 r 个：13/3 → [5,4,4]，总数守恒", () => {
    const plans = planShards({ concurrency: 3, maxIterations: 13 }, 3);
    expect(plans.map((p) => p.maxIterations)).toEqual([5, 4, 4]);
    expect(plans.reduce((sum, p) => sum + (p.maxIterations ?? 0), 0)).toBe(13);
  });

  it("并发 max(1,floor) + 余数给前 r：4/3 → [2,1,1]", () => {
    const plans = planShards({ concurrency: 4, maxIterations: 3 }, 3);
    expect(plans.map((p) => p.concurrency)).toEqual([2, 1, 1]);
  });

  it("并发每 shard 至少 1：2/4 → [1,1,1,1]", () => {
    const plans = planShards({ concurrency: 2, maxIterations: 4 }, 4);
    expect(plans.map((p) => p.concurrency)).toEqual([1, 1, 1, 1]);
  });

  it("duration 模式：各 shard durationMs 相同且 iterations 均为 undefined", () => {
    const plans = planShards({ concurrency: 2, durationMs: 5_000 }, 3);
    expect(plans.map((p) => p.durationMs)).toEqual([5_000, 5_000, 5_000]);
    for (const p of plans) expect(p.maxIterations).toBeUndefined();
  });

  it("非法入参：终止条件缺失抛错（与 StressRunner 同口径）；shards 非正整数抛错", () => {
    expect(() => planShards({ concurrency: 1 }, 2)).toThrow("maxIterations");
    expect(() => planShards({ concurrency: 1, maxIterations: 4 }, 0)).toThrow("shards");
  });

  it("iterations 少于 shards：fail-fast 抛中文错误（不产 0 迭代 shard）；duration 模式不受影响", () => {
    expect(() => planShards({ concurrency: 3, maxIterations: 2 }, 3)).toThrow(
      "shards 不能大于总迭代数（2）",
    );
    expect(() => planShards({ concurrency: 3, durationMs: 1_000 }, 3)).not.toThrow();
  });
});

describe("DistributedStressCoordinator", () => {
  // 定位/份额基础规格：concurrency 3 → 两 shard 分得 [2,1]；iterations 8 → [4,4]。
  const specBase = {
    apiPath: "/api/pet",
    caseId: "c1",
    workspaceRoot: "/ws",
    concurrency: 3,
    maxIterations: 8,
  };
  const coordinator = new DistributedStressCoordinator();

  it("2 shard 成功：总数合并、perShard 计数/rps、分位为合并样本精确值（非分位数的分位数）", async () => {
    const shardTimes: Record<string, number[]> = {
      "shard-0": [10, 20, 30, 40],
      "shard-1": [50, 60, 70, 80],
    };
    const seen: StressWorkerSpec[] = [];
    const { report, shardFailureCount } = await coordinator.run(specBase, {
      shards: 2,
      spawnWorker: async (spec) => {
        seen.push(spec);
        await new Promise((r) => setTimeout(r, 25)); // 留出协调窗口，rps 断言才有意义
        return shardResult(spec.shardId, shardTimes[spec.shardId] ?? []);
      },
    });

    expect(shardFailureCount).toBe(0);
    // 下发规格：协议版本锚点 + 定位透传 + D3 份额分配
    expect(seen.map((s) => s.shardId)).toEqual(["shard-0", "shard-1"]);
    expect(seen.map((s) => [s.maxIterations, s.concurrency])).toEqual([
      [4, 2],
      [4, 1],
    ]);
    expect(
      seen.every(
        (s) =>
          s.protocolVersion === 1 &&
          s.apiPath === "/api/pet" &&
          s.caseId === "c1" &&
          s.workspaceRoot === "/ws",
      ),
    ).toBe(true);

    expect(report.totalRequests).toBe(8);
    expect(report.concurrency).toBe(3); // 各成功 shard 分得并发之和
    expect(report.distributed?.shards).toBe(2);
    expect(report.distributed?.perShard).toEqual([
      { shardId: "shard-0", totalRequests: 4, ok: 4, failed: 0, rps: expect.any(Number) },
      { shardId: "shard-1", totalRequests: 4, ok: 4, failed: 0, rps: expect.any(Number) },
    ]);
    // perShard rps 口径 = shard 请求数 ÷ 协调窗口秒（与整体 rps 同窗）
    for (const s of report.distributed?.perShard ?? []) {
      expect(s.rps).toBeCloseTo(s.totalRequests / (report.durationMs / 1000), 5);
    }
    expect(report.rps).toBeCloseTo(8 / (report.durationMs / 1000), 5);
    expect(report.distributed?.shardErrors).toBeUndefined(); // 无失败时省略字段

    // 分位钉值：合并 [10..80] n=8 → p50=第4个=40、p90=第8个=80；
    // 若误走「分位数的分位数」（各 shard p50=25/55 再合成）则此断言必失败。
    expect(report.latency.p50).toBe(40);
    expect(report.latency.p90).toBe(80);
    expect(report.latency.min).toBe(10);
    expect(report.latency.max).toBe(80);
    // 与「合并样本直接 computeReport」逐字段一致
    const merged: StressSample[] = [...shardTimes["shard-0"], ...shardTimes["shard-1"]].map(
      (t) => ({ timeMs: t, status: 200, ok: true }),
    );
    const direct = computeReport(merged, {
      concurrency: report.concurrency,
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
    });
    expect(report.latency).toEqual(direct.latency);
    // 含 distributed 段的报告整体可被 schema 校验
    expect(() => StressReportSchema.parse(report)).not.toThrow();
  });

  it("部分失败：成功样本入报告、shardErrors 恰 1 条、run 不抛、并发只计成功 shard", async () => {
    const { report, shardFailureCount } = await coordinator.run(
      { ...specBase, concurrency: 5 }, // 分得 [3,2]，成功 shard-0 → 报告并发 3
      {
        shards: 2,
        spawnWorker: async (spec) =>
          spec.shardId === "shard-0"
            ? shardResult("shard-0", [10, 20])
            : shardFailure(spec.shardId, "worker 进程崩溃"),
      },
    );

    expect(shardFailureCount).toBe(1);
    expect(report.totalRequests).toBe(2);
    expect(report.ok).toBe(2);
    expect(report.concurrency).toBe(3);
    expect(report.distributed?.perShard).toEqual([
      { shardId: "shard-0", totalRequests: 2, ok: 2, failed: 0, rps: expect.any(Number) },
    ]);
    expect(report.distributed?.shardErrors).toEqual([
      { shardId: "shard-1", error: "worker 进程崩溃" },
    ]);
  });

  it("全部失败：空样本报告落盘形状（totalRequests=0、shardErrors=2 条）且不抛", async () => {
    const { report, shardFailureCount } = await coordinator.run(specBase, {
      shards: 2,
      spawnWorker: async (spec) => shardFailure(spec.shardId, `case ${spec.caseId} 不存在`),
    });

    expect(shardFailureCount).toBe(2);
    expect(report.totalRequests).toBe(0);
    expect(report.ok).toBe(0);
    expect(report.rps).toBe(0);
    expect(report.distributed?.perShard).toEqual([]);
    expect(report.distributed?.shardErrors).toHaveLength(2);
    // 无成功 shard 时 concurrency 回退为分配总额（3），保证报告满足正整数约束、可落盘可回读
    expect(report.concurrency).toBe(3);
    expect(() => StressReportSchema.parse(report)).not.toThrow();
  });

  it("iterations 少于 shards：coordinator.run 同样 fail-fast 抛中文错误（planShards 闸口）", async () => {
    await expect(
      coordinator.run({ ...specBase, maxIterations: 2 }, { shards: 3, spawnWorker: async () => shardResult("shard-0", []) }),
    ).rejects.toThrow("shards 不能大于总迭代数（2）");
  });

  it("对称失败：shard-0 失败、shard-1 成功——perShard/shardErrors 按 shard 下标序稳定输出（非完成序）", async () => {
    const { report, shardFailureCount } = await coordinator.run(specBase, {
      shards: 2,
      spawnWorker: async (spec) => {
        // shard-1 先完成、shard-0 后失败：证明结果顺序与完成时序无关
        await new Promise((r) => setTimeout(r, spec.shardId === "shard-0" ? 30 : 1));
        return spec.shardId === "shard-0"
          ? shardFailure("shard-0", "shard-0 启动失败")
          : shardResult("shard-1", [10, 20]);
      },
    });

    expect(shardFailureCount).toBe(1);
    expect(report.totalRequests).toBe(2);
    // 分得 [2,1]，仅成功 shard-1 分得 1
    expect(report.concurrency).toBe(1);
    expect(report.distributed?.perShard).toEqual([
      { shardId: "shard-1", totalRequests: 2, ok: 2, failed: 0, rps: expect.any(Number) },
    ]);
    expect(report.distributed?.shardErrors).toEqual([
      { shardId: "shard-0", error: "shard-0 启动失败" },
    ]);
  });

  it("超时：shardTimeoutMs 到期判 shard 失败（20ms 极短值 + 永不 resolve 替身，不真实长等）", async () => {
    const t0 = Date.now();
    const { report, shardFailureCount } = await coordinator.run(specBase, {
      shards: 2,
      shardTimeoutMs: 20,
      spawnWorker: () => new Promise<ShardOutcome>(() => undefined),
    });
    const elapsed = Date.now() - t0;

    expect(shardFailureCount).toBe(2);
    expect(report.distributed?.shardErrors).toHaveLength(2);
    for (const e of report.distributed?.shardErrors ?? []) {
      expect(e.error).toContain("超时");
    }
    expect(elapsed).toBeLessThan(5_000);
  });

  it("协议坏输出：载荷未通过 ShardOutcomeSchema → 判失败且 error 含「协议」", async () => {
    const { report, shardFailureCount } = await coordinator.run(specBase, {
      shards: 1,
      spawnWorker: async () => ({ junk: true }) as unknown as ShardOutcome,
    });

    expect(shardFailureCount).toBe(1);
    expect(report.distributed?.shardErrors?.[0]?.shardId).toBe("shard-0");
    expect(report.distributed?.shardErrors?.[0]?.error).toContain("协议");
  });
});

describe("StressReportSchema 旧报告兼容（D6）", () => {
  it("M2-C 形态（无 distributed）parse 成功且 distributed 为 undefined", () => {
    const legacy = {
      concurrency: 2,
      totalRequests: 4,
      ok: 3,
      failed: 1,
      durationMs: 20,
      rps: 200,
      latency: { min: 1, avg: 5, max: 9, p50: 5, p90: 9, p95: 9, p99: 9 },
      statusDist: { "200": 3, "404": 1 },
      errorKinds: { HTTP_404: 1 },
      startedAt: 1_000,
      finishedAt: 1_020,
    };
    const parsed = StressReportSchema.parse(legacy);
    expect(parsed.distributed).toBeUndefined();
  });
});

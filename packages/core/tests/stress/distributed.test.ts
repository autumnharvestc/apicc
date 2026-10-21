import { describe, expect, it } from "vitest";
import { computeReport } from "../../src/stress/aggregate.js";
import {
  DistributedStressCoordinator,
  planShards,
  ShardResultSchema,
  StressWorkerSpecSchema,
} from "../../src/stress/distributed.js";
import type {
  ShardFailure,
  ShardOutcome,
  ShardResult,
  StressWorkerSpec,
} from "../../src/stress/distributed.js";
import { CurrentStressReportSchema, StressGeneratorSchema, StressMeasurementWindowSchema, StressReportSchema, StressSampleSchema } from "../../src/stress/model.js";
import type { StressSample } from "../../src/stress/model.js";
import { StressRunner } from "../../src/stress/runner.js";
import type { CaseExecutionResult } from "../../src/runner/caseExecutor.js";
import { createExecutionEvidenceCollector, redactExecutionOutput } from "../../src/report/evidence.js";
import { createCredentialOutputSanitizer } from "../../src/credentials/output.js";

/** 成功 shard 替身回传：固定样本批。 */
const shardResult = (
  shardId: string,
  timeMsList: number[],
  metrics?: Partial<ShardResult["generator"]>,
  window?: Partial<ShardResult["measurementWindow"]>,
): ShardResult => ({
  protocolVersion: 2,
  ok: true,
  shardId,
  samples: timeMsList.map((t) => ({ timeMs: t, requestTimeMs: t, scriptTimeMs: 0, iterationTimeMs: t, requestStarted: true, requestCompleted: true, status: 200, ok: true })),
  measurementWindow: {
    startWallMs: 1_000, endWallMs: 1_100, monotonicDurationMs: 100, eligibleCompletedAttempts: timeMsList.length,
    ...window,
  },
  generator: {
    cpuUserMs: 1, cpuSystemMs: 2, cpuPercent: 3, rssStartBytes: 10, rssPeakBytes: 20,
    eventLoopDelayP95Ms: 4, schedulerBacklogMax: 0, saturated: false, reasons: [],
    limits: { cpuPercent: 90, eventLoopDelayP95Ms: 100, schedulerBacklog: 0 },
    ...metrics,
  },
});

/** 失败 shard 替身回传。 */
const shardFailure = (shardId: string, error: string): ShardFailure => ({
  protocolVersion: 2,
  ok: false,
  shardId,
  error,
});

describe("planShards", () => {
  it("拒绝 shards 大于全局 concurrency，且不尝试伪造每 shard 并发", () => {
    expect(() => planShards({ concurrency: 2, maxIterations: 8 }, 3)).toThrow(/shards.*concurrency|concurrency.*shards/);
  });

  it("多 shard 请求 maxRps 时在 spawn 前稳定拒绝全局不可证明的组合", async () => {
    let spawned = 0;
    await expect(new DistributedStressCoordinator().run(
      { apiPath: "/api/pet", caseId: "c1", definitionRevision: "rev-1", credentialVersions: {}, networkIdentity: `sha256:${"0".repeat(64)}`, workspaceRoot: "/ws", concurrency: 4, maxIterations: 8, maxRps: 10 },
      { shards: 2, spawnWorker: async () => { spawned += 1; return shardFailure("shard-0", "unexpected"); } },
    )).rejects.toThrow(/shard.*maxRps|maxRps.*shard|全局/);
    expect(spawned).toBe(0);
  });
  it("多 shard 不再拆分 maxRps 配额", () => {
    expect(() => planShards({ concurrency: 3, maxIterations: 8, maxRps: 1 }, 3)).toThrow(/shard.*maxRps|maxRps.*shard|全局/);
  });

  it("single shard 保留 maxRps 上限，不拆分独立 limiter", () => {
    expect(planShards({ concurrency: 1, maxIterations: 2, maxRps: Number.MIN_VALUE }, 1)[0]?.maxRps)
      .toBe(Number.MIN_VALUE);
  });
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
    const plans = planShards({ concurrency: 4, maxIterations: 4 }, 4);
    expect(plans.map((p) => p.concurrency)).toEqual([1, 1, 1, 1]);
  });

  it("duration 模式：各 shard durationMs 相同且 iterations 均为 undefined", () => {
    const plans = planShards({ concurrency: 3, durationMs: 5_000 }, 3);
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

describe("StressWorkerSpec contract revision descriptors", () => {
  it("requires the selected definition revision and credential version descriptors", () => {
    const base = {
      protocolVersion: 2,
      shardId: "shard-0",
      apiPath: "/api/pet",
      caseId: "case-1",
      concurrency: 1,
      maxIterations: 1,
      workspaceRoot: "C:/workspace",
    };

    expect(() => StressWorkerSpecSchema.parse(base)).toThrow();
    expect(StressWorkerSpecSchema.parse({
      ...base,
      definitionRevision: "sha256:project-revision",
      credentialVersions: { "ref-1": "version-3" },
      networkIdentity: `sha256:${"0".repeat(64)}`,
    })).toMatchObject({
      definitionRevision: "sha256:project-revision",
      credentialVersions: { "ref-1": "version-3" },
      networkIdentity: `sha256:${"0".repeat(64)}`,
    });
    expect(() => StressWorkerSpecSchema.parse({
      ...base,
      definitionRevision: "sha256:project-revision",
      credentialVersions: { "ref-1": "version-3" },
      credentialValues: { "ref-1": "must-not-cross-worker-boundary" },
    })).toThrow();
  });

  it("preserves every own string credential-version key through strict parsing and JSON round trips", () => {
    const versions = JSON.parse('{"__proto__":"v-proto","constructor":"v-constructor","toString":"v-toString"}') as Record<string, string>;
    const wire = JSON.stringify({
      protocolVersion: 2,
      shardId: "shard-0",
      apiPath: "groups/g/projects/p/collections/c/apis/a",
      caseId: "case-1",
      definitionRevision: "sha256:project-revision",
      credentialVersions: versions,
      networkIdentity: `sha256:${"0".repeat(64)}`,
      concurrency: 1,
      maxIterations: 1,
      workspaceRoot: "C:/workspace",
    });
    const parsed = StressWorkerSpecSchema.parse(JSON.parse(wire));
    const roundTripped = JSON.parse(JSON.stringify(parsed)) as { credentialVersions: Record<string, string> };

    expect(Object.keys(roundTripped.credentialVersions).sort()).toEqual(["__proto__", "constructor", "toString"]);
    expect(Object.hasOwn(roundTripped.credentialVersions, "__proto__")).toBe(true);
    expect(roundTripped.credentialVersions["__proto__"]).toBe("v-proto");
    expect(roundTripped.credentialVersions.constructor).toBe("v-constructor");
    expect(roundTripped.credentialVersions.toString).toBe("v-toString");
  });
});

describe("DistributedStressCoordinator", () => {
  it("C1 Fix2 private completion failure releases waiting peers and aborts owned transports without partial output", async () => {
    const signals: AbortSignal[] = [];
    await expect(new DistributedStressCoordinator().run({ apiPath: "/api", caseId: "c", definitionRevision: "r", credentialVersions: {}, networkIdentity: `sha256:${"0".repeat(64)}`, workspaceRoot: "/ws", concurrency: 2, maxIterations: 2 }, {
      shards: 2, shardTimeoutMs: 30,
      spawnWorker: async (spec, control) => {
        signals.push(control.signal);
        if (spec.shardId === "shard-1") return new Promise<ShardOutcome>(() => {});
        await control.finalizeEvidence(["private-marker"]);
        return shardResult(spec.shardId, [1]);
      },
    })).rejects.toThrow("completion incomplete");
    expect(signals).toHaveLength(2); expect(signals.every((signal) => signal.aborted)).toBe(true);
    await expect(new DistributedStressCoordinator().run({ apiPath: "/api", caseId: "c", definitionRevision: "r", credentialVersions: {}, networkIdentity: `sha256:${"0".repeat(64)}`, workspaceRoot: "/ws", concurrency: 1, maxIterations: 1 }, {
      shards: 1, spawnWorker: async (spec, control) => {
        await control.finalizeEvidence(["x".repeat(16 * 1024 * 1024)]);
        return shardResult(spec.shardId, [1]);
      },
    })).rejects.toThrow("completion incomplete");
    let partialHandshake = false;
    await expect(new DistributedStressCoordinator().run({ apiPath: "/api", caseId: "c", definitionRevision: "r", credentialVersions: {}, networkIdentity: `sha256:${"0".repeat(64)}`, workspaceRoot: "/ws", concurrency: 2, maxIterations: 2 }, {
      shards: 2, spawnWorker: async (spec, control) => {
        if (spec.shardId === "shard-0") { await control.finalizeEvidence([]); return shardResult(spec.shardId, [1]); }
        await new StressRunner({ finalizeEvidence: async (markers) => { partialHandshake = true; return control.finalizeEvidence(markers); },
          createWorker: () => ({ close: async () => {}, execute: async () => ({
            request: { protocol: "http", method: "GET", url: "https://example.test", headers: {}, query: [], auth: { kind: "none" } },
            outcome: { apiId: "a", apiName: "a", caseId: "c", caseName: "c", passed: true, durationMs: 1, assertions: [] },
            requestTimeMs: 1, scriptTimeMs: 0, iterationTimeMs: 1,
            extractionOutcomes: [{ id: "e", name: "secret", selector: { target: "bodyText", match: "first" }, status: "extracted", code: "OK", pass: true, sensitive: true, published: true, message: "capacity", value: "z".repeat(16 * 1024 * 1024) }],
          }) }),
        }).run({ concurrency: 1, maxIterations: 1 });
        return shardResult(spec.shardId, [1]);
      },
    })).rejects.toThrow("completion incomplete");
    expect(partialHandshake).toBe(false);
  });
  it("C1 Fix2 unions successful and unsampled worker markers before complete rich content is clipped", async () => {
    const cutoff = "cutoff-hidden-secret"; const nested = "nested-private-key";
    const encoded = "private/encoded value";
    const identity = { projectId: "project-passed", definitionRevision: "revision-passed" };
    const { report } = await new DistributedStressCoordinator().run({ apiPath: "/api", caseId: "case", definitionRevision: "r", credentialVersions: {}, networkIdentity: `sha256:${"0".repeat(64)}`, workspaceRoot: "/ws", concurrency: 2, maxIterations: 44 }, {
      shards: 2,
      spawnWorker: async (spec, control) => {
        let index = 0; const samples: ShardResult["samples"] = [];
        const result = await new StressRunner({ evidenceIdentity: identity,
          finalizeEvidence: async (markers) => { const union = await control.finalizeEvidence(markers); expect([...union]).toEqual([...union].sort()); return union; },
          onSample: (sample) => samples.push({ requestTimeMs: 1, scriptTimeMs: 0, iterationTimeMs: 1, requestStarted: true, requestCompleted: true, status: sample.status, ok: sample.ok, failureKind: sample.failureKind, error: sample.error, safety: sample.safety }),
          createWorker: () => ({ execute: async () => {
            const row = index++; const learns = spec.shardId === "shard-1";
            const passed = learns && row === 21;
            return { request: { protocol: "http", method: "GET", url: `https://example.test/${nested}`, query: [], headers: { business: encoded }, auth: { kind: "none" } },
              response: { status: 200, headers: {}, bodyText: "rich detail " + "x".repeat(65536 - 6 - 12) + cutoff + ` ${nested} ${encodeURIComponent(encoded)}`, timeMs: 1 },
              outcome: { apiId: "api-passed", caseId: "case-passed", apiName: "public API", caseName: "public case", passed, row, durationMs: 1, assertions: [], error: passed ? undefined : nested, failureKind: passed ? undefined : "assertion" },
              assertionOutcomes: [{ id: "assertion-passed", op: "eq", selector: { target: "bodyText", match: "first", path: nested }, pass: false, code: "ASSERTION_FAILED", message: nested, actual: encoded, expected: "public expected" }],
              extractionOutcomes: learns && row >= 20 ? [{ id: "extract", name: "token", selector: { target: "bodyText", match: "first" }, pass: true, status: "extracted", code: "OK", message: "learned", sensitive: true, published: true, value: passed ? cutoff : { [nested]: [encoded, "passed"] } }] : [],
              safety: { origin: `https://${nested}.test`, confirmation: "confirmed", policy: "allowed", appliedPolicy: { trustedOrigins: [], deniedOrigins: [] } },
              requestTimeMs: 1, scriptTimeMs: 0, iterationTimeMs: 1, requestStarted: true, requestCompleted: true, failureKind: passed ? undefined : "assertion" } as CaseExecutionResult;
          }, close: async () => {} }),
        }).run({ concurrency: 1, maxIterations: 22 });
        return { protocolVersion: 2, ok: true, shardId: spec.shardId, samples, generator: result.generator!, measurementWindow: result.measurementWindow!, failureEvidence: result.failureEvidence };
      },
    });
    expect(report).toMatchObject({ totalRequests: 44, ok: 1, failed: 43, distributed: { dataComplete: true } });
    expect(report.failureEvidence).toHaveLength(20);
    expect(report.failureEvidence![0]!.identity).toMatchObject(identity);
    expect(report.failureEvidence![0]!.request?.protocol).toBe("http");
    const body = report.failureEvidence![0]!.response!.body;
    expect(body.text).toContain("rich detail"); expect(body.text).not.toContain("cutoff"); expect(body.truncated).toBe(true);
    expect(report.failureEvidence![0]!.assertions![0]!.expected?.text).toBe("public expected");
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(nested); expect(serialized).not.toContain(encoded); expect(serialized).not.toContain(encodeURIComponent(encoded));
    expect(serialized).not.toContain("markers"); expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(16 * 1024 * 1024);
    // The final merged boundary shares its value/report budget across every business diagnostic channel.
    const longDiagnostic = "D".repeat(4068) + cutoff + "z".repeat(8192);
    const diagnostics = createExecutionEvidenceCollector(identity, [cutoff, nested, encoded]).projectStressReport({ ...report,
      generator: { availability: "unavailable", unavailableReason: longDiagnostic },
      distributed: { ...report.distributed!, perShard: report.distributed!.perShard.map((shard) => ({ ...shard, generator: { availability: "unavailable", unavailableReason: longDiagnostic } })), shardErrors: [{ shardId: "shard-0", error: longDiagnostic }] },
      safety: { ...report.safety!, unavailableReason: longDiagnostic, targetOrigins: [{ ...report.safety!.targetOrigins[0]!, origin: longDiagnostic, appliedPolicy: { trustedOrigins: Array(150_000).fill("https://public.test"), deniedOrigins: [longDiagnostic] } }] },
    }, true);
    const values = [diagnostics.generator!.unavailableReason!, diagnostics.distributed!.perShard[0]!.generator.unavailableReason!, diagnostics.distributed!.shardErrors![0]!.error,
      diagnostics.safety!.unavailableReason!, diagnostics.safety!.targetOrigins[0]!.origin, diagnostics.safety!.targetOrigins[0]!.appliedPolicy!.deniedOrigins![0]!];
    for (const value of values) { expect(Buffer.byteLength(value)).toBeLessThanOrEqual(4096); expect(value).toMatch(/truncated|omitted/); expect(value).not.toContain("cuto"); }
    const origins = diagnostics.safety!.targetOrigins[0]!.appliedPolicy!.trustedOrigins!;
    expect(origins.length).toBeLessThan(150_000); expect(origins.at(-1)).toContain("omitted");
    expect(diagnostics).toMatchObject({ totalRequests: 44, ok: 1, failed: 43 });
    expect(diagnostics.failureEvidence).toHaveLength(20); expect(Buffer.byteLength(JSON.stringify(diagnostics))).toBeLessThanOrEqual(16 * 1024 * 1024);
    const finalSink = redactExecutionOutput({ ...report, generator: { availability: "unavailable" as const, unavailableReason: longDiagnostic } }, createCredentialOutputSanitizer([cutoff, "D"]));
    expect(Buffer.byteLength(finalSink.generator!.unavailableReason!)).toBeLessThanOrEqual(4096);
    expect(finalSink.generator!.unavailableReason).toContain("truncated/omitted");
  });
  // 定位/份额基础规格：concurrency 3 → 两 shard 分得 [2,1]；iterations 8 → [4,4]。
  const specBase = {
    apiPath: "/api/pet",
    caseId: "c1",
    definitionRevision: "rev-1",
    credentialVersions: {},
    networkIdentity: `sha256:${"0".repeat(64)}`,
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
          s.protocolVersion === 2 &&
          s.apiPath === "/api/pet" &&
          s.caseId === "c1" &&
          s.workspaceRoot === "/ws",
      ),
    ).toBe(true);

    expect(report.totalRequests).toBe(8);
    expect(report.concurrency).toBe(3); // 各成功 shard 分得并发之和
    expect(report.distributed?.shards).toBe(2);
    expect(report.distributed?.perShard).toEqual([
      expect.objectContaining({ shardId: "shard-0", totalRequests: 4, ok: 4, failed: 0, rps: expect.any(Number) }),
      expect.objectContaining({ shardId: "shard-1", totalRequests: 4, ok: 4, failed: 0, rps: expect.any(Number) }),
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

  it("顶层与 per-shard RPS 都使用 startWall + monotonicDuration，minRps 不被 raw endWall 覆盖", async () => {
    const { report } = await coordinator.run(
      { ...specBase, concurrency: 1, maxIterations: 1, minRps: 8 },
      {
        shards: 1,
        spawnWorker: async (spec) => shardResult(spec.shardId, [10], undefined, {
          startWallMs: 1_000, endWallMs: 1_100, monotonicDurationMs: 200,
        }),
      },
    );

    expect(report.distributed?.perShard[0]?.rps).toBe(5);
    expect(report.measurementWindow).toMatchObject({ startWallMs: 1_000, endWallMs: 1_200, monotonicDurationMs: 200 });
    expect(report.rps).toBe(5);
    expect(report.verdict?.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "rps", actual: 5, expected: 8 }),
    ]));
  });

  it("联合窗口按 worker 压力区间计算，分别覆盖重叠与非重叠 shard", async () => {
    const runWithWindows = async (windows: Array<[number, number, number]>) => coordinator.run(
      { ...specBase, concurrency: 2, maxIterations: 2 },
      {
        shards: 2,
        spawnWorker: async (spec) => {
          const [startWallMs, endWallMs, monotonicDurationMs] = windows[Number(spec.shardId.slice(-1))]!;
          return shardResult(spec.shardId, [10], undefined, { startWallMs, endWallMs, monotonicDurationMs });
        },
      },
    );

    const overlapping = await runWithWindows([[1_000, 1_100, 200], [1_100, 1_200, 200]]);
    expect(overlapping.report.measurementWindow).toMatchObject({ startWallMs: 1_000, endWallMs: 1_300, monotonicDurationMs: 300 });
    expect(overlapping.report.rps).toBeCloseTo(2 / 0.3, 8);

    const nonOverlapping = await runWithWindows([[2_000, 2_100, 200], [2_300, 2_400, 200]]);
    expect(nonOverlapping.report.measurementWindow).toMatchObject({ startWallMs: 2_000, endWallMs: 2_500, monotonicDurationMs: 500 });
    expect(nonOverlapping.report.rps).toBe(4);
  });

  it("墙钟倒退时使用 monotonic fallback，缺少窗口字段则严格拒绝", async () => {
    expect(StressMeasurementWindowSchema.safeParse({
      startWallMs: 2_000, endWallMs: 1_000, monotonicDurationMs: 200, eligibleCompletedAttempts: 1,
    }).success).toBe(true);
    expect(StressMeasurementWindowSchema.safeParse({
      endWallMs: 1_000, monotonicDurationMs: 200, eligibleCompletedAttempts: 1,
    }).success).toBe(false);

    const { report } = await coordinator.run(
      { ...specBase, concurrency: 1, maxIterations: 1 },
      {
        shards: 1,
        spawnWorker: async (spec) => shardResult(spec.shardId, [10], undefined, {
          startWallMs: 2_000, endWallMs: 1_000, monotonicDurationMs: 200,
        }),
      },
    );
    expect(report.rps).toBe(5);
    expect(report.measurementWindow).toMatchObject({ startWallMs: 2_000, endWallMs: 2_200, monotonicDurationMs: 200 });
  });

  it("跨 shard 合并 pre-I/O config/safety rejection 与成功样本时 verdict 仍失败", async () => {
    const rejected: ShardResult = {
      ...shardResult("shard-0", [0]),
      samples: [{
        requestTimeMs: 0, scriptTimeMs: 0, iterationTimeMs: 1, requestStarted: false, requestCompleted: false,
        status: 0, ok: false, failureKind: "config", error: "target_confirmation_required",
        safety: {
          origin: "https://example.com", confirmation: "rejected", policy: "target_confirmation_required",
          loopback: false, appliedPolicy: { trustedOrigins: [], deniedOrigins: [] },
        },
      }],
      measurementWindow: { startWallMs: 1_000, endWallMs: 1_100, monotonicDurationMs: 100, eligibleCompletedAttempts: 0 },
    };
    const { report } = await coordinator.run(
      { ...specBase, concurrency: 2, maxIterations: 2 },
      {
        shards: 2,
        spawnWorker: async (spec) => spec.shardId === "shard-0" ? rejected : shardResult(spec.shardId, [10]),
      },
    );

    expect(report.totalRequests).toBe(2);
    expect(report.ok).toBe(1);
    expect(report.failures.config).toBe(1);
    expect(report.eligibleFailureCounts?.config).toBe(0);
    expect(report.verdict?.passed).toBe(false);
    expect(report.verdict?.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "businessFailures", actual: 1 }),
    ]));
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
      expect.objectContaining({ shardId: "shard-0", totalRequests: 2, ok: 2, failed: 0, rps: expect.any(Number) }),
    ]);
    expect(report.distributed?.shardErrors).toEqual([
      { shardId: "shard-1", error: "worker 进程崩溃" },
    ]);
  });

  it("全部 shard 失败：输出 strict failed report，generator/safety 明确不可用并保留诊断", async () => {
    const { report, shardFailureCount } = await coordinator.run(specBase, {
      shards: 2,
      spawnWorker: async (spec) => shardFailure(spec.shardId, `case ${spec.caseId} 不存在`),
    });
    expect(shardFailureCount).toBe(2);
    expect(report.distributed?.dataComplete).toBe(false);
    expect(report.distributed?.shardErrors).toHaveLength(2);
    expect(report.verdict?.passed).toBe(false);
    expect(report.verdict?.violations.map((v) => v.metric)).toContain("noData");
    expect(report.generator).toMatchObject({ availability: "unavailable" });
    expect(report.safety).toMatchObject({ availability: "unavailable", targetOrigins: [] });
    expect(() => CurrentStressReportSchema.parse(report)).not.toThrow();
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
      expect.objectContaining({ shardId: "shard-1", totalRequests: 2, ok: 2, failed: 0, rps: expect.any(Number) }),
    ]);
    expect(report.distributed?.shardErrors).toEqual([
      { shardId: "shard-0", error: "shard-0 启动失败" },
    ]);
  });

  it("超时：shardTimeoutMs 到期判 shard 失败（20ms 极短值 + 永不 resolve 替身，不真实长等）", async () => {
    const t0 = Date.now();
    await expect(coordinator.run(specBase, {
      shards: 2,
      shardTimeoutMs: 20,
      spawnWorker: () => new Promise<ShardOutcome>(() => undefined),
    })).resolves.toMatchObject({ shardFailureCount: 2, report: { verdict: { passed: false } } });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(5_000);
  });

  it("协议坏输出：载荷未通过 ShardOutcomeSchema → 判失败且 error 含「协议」", async () => {
    await expect(coordinator.run(specBase, {
      shards: 1,
      spawnWorker: async () => ({ junk: true }) as unknown as ShardOutcome,
    })).resolves.toMatchObject({ shardFailureCount: 1, report: { verdict: { passed: false } } });
  });

  it("v1 输出被明确拒绝，且失败使 dataComplete=false、verdict=false", async () => {
    await expect(coordinator.run(specBase, {
      shards: 1,
      spawnWorker: async () => ({ protocolVersion: 1, ok: false, shardId: "shard-0", error: "legacy" } as unknown as ShardOutcome),
    })).resolves.toMatchObject({ shardFailureCount: 1, report: { verdict: { passed: false } } });
  });

  it("跨 shard 合并 assertion failure 并聚合 generator 指标", async () => {
    const result = (id: string, user: number, rss: number): ShardResult => ({
      ...shardResult(id, [10]),
      samples: [{ requestTimeMs: 10, scriptTimeMs: 0, iterationTimeMs: 10, requestStarted: true, requestCompleted: true, status: 200, ok: false, failureKind: "assertion" }],
      generator: { ...shardResult(id, [10]).generator, cpuUserMs: user, rssPeakBytes: rss, reasons: ["cpu"], saturated: true },
    });
    const { report } = await coordinator.run({ ...specBase, maxIterations: 2 }, {
      shards: 2,
      spawnWorker: async (spec) => result(spec.shardId, spec.shardId === "shard-0" ? 3 : 5, spec.shardId === "shard-0" ? 20 : 30),
    });
    expect(report.failures.assertion).toBe(2);
    expect(report.verdict?.passed).toBe(false);
    expect(report.generator?.cpuUserMs).toBe(8);
    expect(report.generator?.rssPeakBytes).toBe(30);
    expect(report.generator?.reasons).toEqual(["cpu"]);
    expect(report.generator?.saturated).toBe(true);
  });

  it("顶层 CPU 采用各 shard 最大值而非求和，并按 90% limit 正确判断饱和", async () => {
    const result = (id: string, cpuPercent: number): ShardResult => ({
      ...shardResult(id, [10]),
      generator: { ...shardResult(id, [10]).generator, cpuPercent, saturated: false },
      measurementWindow: { startWallMs: 1_000, endWallMs: 1_100, monotonicDurationMs: 100, eligibleCompletedAttempts: 1 },
    });
    const { report } = await coordinator.run({ ...specBase, maxIterations: 2 }, {
      shards: 2,
      spawnWorker: async (spec) => result(spec.shardId, 60),
    });
    expect(report.generator?.cpuPercent).toBe(60);
    expect(report.generator?.limits?.cpuPercent).toBe(90);
    expect(report.generator?.saturated).toBe(false);
  });

  it("任一 shard generator 明确 partial 时顶层保留 partial 可用性", async () => {
    const result = (id: string): ShardResult => ({
      ...shardResult(id, [10]),
      generator: { ...shardResult(id, [10]).generator, availability: "partial", unavailableReason: "event-loop probe unavailable" },
    });
    const { report } = await coordinator.run({ ...specBase, maxIterations: 2 }, {
      shards: 2,
      spawnWorker: async (spec) => result(spec.shardId),
    });
    expect(report.generator?.availability).toBe("partial");
  });

  it("两个 worker 都回 shard-0：重复/错配路由作为 protocol error，不合并第二份样本", async () => {
    const { report, shardFailureCount } = await coordinator.run(specBase, {
      shards: 2,
      spawnWorker: async () => shardResult("shard-0", [99]),
    });
    expect(shardFailureCount).toBe(1);
    expect(report.totalRequests).toBe(1);
    expect(report.distributed?.perShard.map((item) => item.shardId)).toEqual(["shard-0"]);
    expect(report.distributed?.shardErrors?.[0]?.error).toMatch(/protocol|协议|shardId/i);
    expect(report.distributed?.dataComplete).toBe(false);
    expect(report.verdict?.passed).toBe(false);
  });

  it.each(["iterations", "duration"])("%s 模式成功协议但空样本：no_data 门禁失败且不产生通过报告", async (mode) => {
    const runSpec = mode === "iterations"
      ? { ...specBase, durationMs: undefined }
      : { ...specBase, maxIterations: undefined, durationMs: 10 };
    const { report, shardFailureCount } = await coordinator.run(runSpec, {
      shards: 2,
      spawnWorker: async (spec) => ({ ...shardResult(spec.shardId, []), samples: [] }),
    });
    expect(shardFailureCount).toBe(2);
    expect(report.totalRequests).toBe(0);
    expect(report.distributed?.dataComplete).toBe(false);
    expect(report.verdict?.passed).toBe(false);
    expect(report.distributed?.shardErrors?.every((error) => error.error.includes("NO_DATA"))).toBe(true);
    expect(report.verdict?.violations.some((violation) => violation.metric === "noData")).toBe(true);
  });
});

describe("StressReportSchema 旧报告兼容（D6）", () => {
  it("generator availability=unavailable 不允许用零值伪造指标，legacy 数值形状仍可读", () => {
    expect(StressGeneratorSchema.safeParse({ availability: "unavailable", unavailableReason: "worker failed" }).success).toBe(true);
    expect(StressGeneratorSchema.safeParse({ availability: "unavailable", cpuPercent: 0 }).success).toBe(false);
    expect(StressGeneratorSchema.safeParse({
      cpuUserMs: 0, cpuSystemMs: 0, cpuPercent: 0, rssStartBytes: 0, rssPeakBytes: 0,
      eventLoopDelayP95Ms: 0, schedulerBacklogMax: 0, saturated: false, reasons: [],
      limits: { cpuPercent: 90, eventLoopDelayP95Ms: 100, schedulerBacklog: 0 },
    }).success).toBe(true);
  });

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

  it("当前报告契约要求 verdict/generator/safety，但旧报告仍可读", () => {
    const legacy = {
      concurrency: 2, totalRequests: 0, ok: 0, failed: 0, durationMs: 0, rps: 0,
      latency: { min: 0, avg: 0, max: 0, p50: 0, p90: 0, p95: 0, p99: 0 },
      statusDist: {}, errorKinds: {}, startedAt: 1_000, finishedAt: 1_000,
    };
    expect(CurrentStressReportSchema.safeParse(legacy).success).toBe(false);
    const current = {
      ...legacy,
      failures: { transport: 0, http: 0, script: 0, assertion: 0, extraction: 0, config: 0, aborted: 0 },
      eligibleFailureCounts: { transport: 0, http: 0, script: 0, assertion: 0, extraction: 0, config: 0, aborted: 0 },
      scriptLatency: legacy.latency, iterationLatency: legacy.latency,
      verdict: { passed: false, violations: [{ metric: "noData", actual: 0, expected: 1, message: "NO_DATA" }] },
      generator: {
        availability: "available",
        cpuUserMs: 0, cpuSystemMs: 0, cpuPercent: 0, rssStartBytes: 0, rssPeakBytes: 0,
        eventLoopDelayP95Ms: 0, schedulerBacklogMax: 0, saturated: false, reasons: [],
        limits: { cpuPercent: 90, eventLoopDelayP95Ms: 100, schedulerBacklog: 0 },
      },
      safety: {
        targetOrigins: [],
        run: { requestedConcurrency: 2, effectiveConcurrency: 2, requestedMaxRps: null, effectiveMaxRps: null, connectionMode: "pooled" },
      },
      eligibleCompletedAttempts: 0,
      measurementWindow: { startWallMs: 1_000, endWallMs: 1_000, monotonicDurationMs: 0, eligibleCompletedAttempts: 0 },
    };
    expect(CurrentStressReportSchema.safeParse(current).success).toBe(true);
    const { extraction: _extraction, ...oldCounts } = current.failures;
    const historical = { ...current, failures: oldCounts, eligibleFailureCounts: oldCounts };
    expect(StressReportSchema.parse(historical).failures?.extraction).toBe(0);
    expect(CurrentStressReportSchema.safeParse(historical).success).toBe(false);
  });
});

describe("StressSampleSchema v2 wire invariants", () => {
  const base = { requestTimeMs: 1, scriptTimeMs: 0, iterationTimeMs: 1, status: 200, ok: true };

  it("rejects successful assertion samples and invalid outcome fields", () => {
    expect(StressSampleSchema.safeParse({ ...base, failureKind: "assertion" }).success).toBe(false);
    expect(StressSampleSchema.safeParse({ ...base, outcome: { passed: "yes" } }).success).toBe(false);
  });

  it("rejects contradictory request start/completion and fabricated latency", () => {
    expect(StressSampleSchema.safeParse({ ...base, requestStarted: false, requestCompleted: true }).success).toBe(false);
    expect(StressSampleSchema.safeParse({ ...base, requestStarted: false, requestTimeMs: 1 }).success).toBe(false);
  });

  it("requires stable failureKind on failed samples", () => {
    expect(StressSampleSchema.safeParse({ ...base, ok: false }).success).toBe(false);
    expect(StressSampleSchema.safeParse({ ...base, ok: false, failureKind: "assertion" }).success).toBe(true);
  });
});

describe("ShardResultSchema v2 qualification contract", () => {
  it("requires both requestStarted and requestCompleted on every v2 wire sample", () => {
    const valid = shardResult("s0", [1]);
    const legacySample = { ...valid.samples[0]! };
    delete legacySample.requestStarted;
    delete legacySample.requestCompleted;
    const result = { ...valid, samples: [legacySample] };
    expect(ShardResultSchema.safeParse(result).success).toBe(false);
  });
});

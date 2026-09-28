import { describe, expect, it } from "vitest";
import { computeReport } from "../../src/stress/aggregate.js";
import { evaluateStressThresholds } from "../../src/stress/thresholds.js";
import type { StressSample } from "../../src/stress/model.js";

const sample = (timeMs: number, status = 200, error?: string): StressSample =>
  ({ timeMs, status, ok: status >= 200 && status < 400 && !error, error });

const classifiedSample = (requestTimeMs: number, failureKind?: StressSample["failureKind"], status = 200): StressSample => ({
  requestTimeMs,
  scriptTimeMs: 3,
  iterationTimeMs: requestTimeMs + 3,
  status,
  ok: failureKind === undefined,
  failureKind,
  error: failureKind === undefined ? undefined : `${failureKind} failed`,
});

describe("computeReport", () => {
  it("聚合计数/RPS/时长", () => {
    const r = computeReport(
      [sample(10), sample(20), sample(30)],
      { concurrency: 3, startedAt: 0, finishedAt: 3_000 },
    );
    expect(r.totalRequests).toBe(3);
    expect(r.ok).toBe(3);
    expect(r.failed).toBe(0);
    expect(r.durationMs).toBe(3_000);
    expect(r.rps).toBeCloseTo(1, 5);
  });

  it("nearest-rank 分位：p50/p95/p99/max", () => {
    const samples = Array.from({ length: 100 }, (_, i) => sample(i + 1));
    const r = computeReport(samples, { concurrency: 1, startedAt: 0, finishedAt: 1_000 });
    expect(r.latency.p50).toBe(50);
    expect(r.latency.p95).toBe(95);
    expect(r.latency.p99).toBe(99);
    expect(r.latency.max).toBe(100);
    expect(r.latency.min).toBe(1);
    expect(r.latency.avg).toBeCloseTo(50.5, 1);
  });

  it("失败与状态分布、错误分类计数", () => {
    const r = computeReport(
      [sample(10, 500), sample(10, 404), sample(10, 200, "ECONNREFUSED"), sample(10)],
      { concurrency: 2, startedAt: 0, finishedAt: 1_000 },
    );
    expect(r.ok).toBe(1);
    expect(r.failed).toBe(3);
    expect(r.statusDist).toEqual({ "200": 2, "404": 1, "500": 1 });
    expect(r.errorKinds).toEqual({ ECONNREFUSED: 1, "HTTP_404": 1, "HTTP_500": 1 });
  });

  it("空样本不抛（除法防护）", () => {
    const r = computeReport([], { concurrency: 4, startedAt: 0, finishedAt: 0 });
    expect(r.totalRequests).toBe(0);
    expect(r.rps).toBe(0);
    expect(r.latency.p50).toBe(0);
  });

  it("按业务失败分类并分别聚合请求、脚本和完整迭代耗时", () => {
    const r = computeReport([
      classifiedSample(10),
      classifiedSample(20, "assertion"),
      classifiedSample(30, "http", 500),
      classifiedSample(40, "script"),
      classifiedSample(50, "transport"),
      classifiedSample(60, "config"),
      classifiedSample(70, "aborted"),
    ], { concurrency: 1, startedAt: 0, finishedAt: 1_000 });

    expect(r.failures).toEqual({ transport: 1, http: 1, script: 1, assertion: 1, config: 1, aborted: 1 });
    expect(r.latency.p95).toBe(60);
    expect(r.scriptLatency.avg).toBe(3);
    expect(r.iterationLatency.p95).toBe(73);
    expect(r.incomplete).toBe(true);
  });

  it("HTTP 200 断言失败不计业务成功，且主动停止未发请求不产生样本", () => {
    const r = computeReport([classifiedSample(10, "assertion")], { concurrency: 1, startedAt: 0, finishedAt: 100 });
    expect(r.ok).toBe(0);
    expect(r.failures.assertion).toBe(1);
    expect(r.totalRequests).toBe(1);
  });

  it("未实际发包的 request latency 不进入 p95，95 个 pre-I/O 失败加 5 个请求时 p95 为请求耗时", () => {
    const preIoFailures = Array.from({ length: 95 }, () => ({
      requestTimeMs: 0, scriptTimeMs: 5, iterationTimeMs: 5, requestStarted: false,
      status: 0, ok: false, failureKind: "script" as const, error: "preflight",
    }));
    const requests = Array.from({ length: 5 }, () => ({
      requestTimeMs: 1_000, scriptTimeMs: 0, iterationTimeMs: 1_000, requestStarted: true, requestCompleted: true,
      status: 200, ok: true,
    }));
    const r = computeReport([...preIoFailures, ...requests], { concurrency: 1, startedAt: 0, finishedAt: 1_000 });
    expect(r.latency.p95).toBe(1_000);
    expect(r.latency.max).toBe(1_000);
    expect(r.scriptLatency.p95).toBe(5);
    expect(r.eligibleFailureCounts?.script).toBe(0);
    expect(evaluateStressThresholds(r, { maxErrorRate: 0 }).passed).toBe(false);
    expect(evaluateStressThresholds(r, { maxErrorRate: 0 }).violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "errorRate", actual: 19 }),
    ]));
    expect(evaluateStressThresholds(r, { maxP95Ms: 500 }).violations.map((v) => v.metric)).toContain("p95");
  });

  it("target confirmation rejection remains a correctness failure beside a successful request", () => {
    const r = computeReport([
      {
        requestTimeMs: 0, scriptTimeMs: 0, iterationTimeMs: 1, requestStarted: false, requestCompleted: false,
        status: 0, ok: false, failureKind: "config", error: "target_confirmation_required",
        safety: {
          origin: "https://example.com", confirmation: "rejected", policy: "target_confirmation_required",
          loopback: false, appliedPolicy: { trustedOrigins: [], deniedOrigins: [] },
        },
      },
      { requestTimeMs: 10, scriptTimeMs: 0, iterationTimeMs: 10, requestStarted: true, requestCompleted: true, status: 200, ok: true },
    ], { concurrency: 1, startedAt: 0, finishedAt: 1_000 });

    const verdict = evaluateStressThresholds(r, {});
    expect(r.failures.config).toBe(1);
    expect(r.eligibleFailureCounts?.config).toBe(0);
    expect(verdict.passed).toBe(false);
    expect(verdict.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "businessFailures", actual: 1 }),
    ]));
  });

  it.each(["script", "config"] as const)("pre-I/O %s failure stays in correctness verdict, while explicit error-rate tolerance governs it", (failureKind) => {
    const r = computeReport([
      {
        requestTimeMs: 0, scriptTimeMs: 5, iterationTimeMs: 5, requestStarted: false, requestCompleted: false,
        status: 0, ok: false, failureKind, error: `${failureKind} failed before I/O`,
      },
      { requestTimeMs: 10, scriptTimeMs: 0, iterationTimeMs: 10, requestStarted: true, requestCompleted: true, status: 200, ok: true },
    ], { concurrency: 1, startedAt: 0, finishedAt: 1_000 });

    expect(evaluateStressThresholds(r, {}).passed).toBe(false);
    expect(evaluateStressThresholds(r, { maxErrorRate: 1 }).passed).toBe(true);
    expect(evaluateStressThresholds(r, { maxErrorRate: 0.5 }).violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "errorRate", actual: 1, expected: 0.5 }),
    ]));
  });

  it("RPS 只计算实际发出且非 aborted 的完成尝试", () => {
    const samples: StressSample[] = [
      { requestStarted: false, requestCompleted: false, requestTimeMs: 0, scriptTimeMs: 10, iterationTimeMs: 10, status: 0, ok: false, failureKind: "config" },
      { requestStarted: true, requestCompleted: false, requestTimeMs: 100, scriptTimeMs: 0, iterationTimeMs: 100, status: 0, ok: false, failureKind: "aborted" },
      { requestStarted: true, requestCompleted: true, requestTimeMs: 100, scriptTimeMs: 0, iterationTimeMs: 100, status: 0, ok: false, failureKind: "transport" },
      { requestStarted: true, requestCompleted: true, requestTimeMs: 100, scriptTimeMs: 0, iterationTimeMs: 100, status: 500, ok: false, failureKind: "http" },
      { requestStarted: true, requestCompleted: true, requestTimeMs: 100, scriptTimeMs: 0, iterationTimeMs: 100, status: 200, ok: true },
      { requestStarted: true, requestCompleted: true, requestTimeMs: 100, scriptTimeMs: 0, iterationTimeMs: 100, status: 200, ok: false, failureKind: "assertion" },
    ];
    const r = computeReport(samples, { concurrency: 1, startedAt: 0, finishedAt: 1_000 });
    expect(r.rps).toBe(4);
  });

  it("v2 只接受 requestStarted 与 requestCompleted 同时为 true；缺一的尝试不进入资格分母", () => {
    const r = computeReport([
      { requestStarted: true, requestTimeMs: 10, status: 200, ok: true },
      { requestCompleted: true, requestTimeMs: 10, status: 200, ok: true },
      { requestStarted: true, requestCompleted: true, requestTimeMs: 10, status: 200, ok: true },
    ], { concurrency: 1, startedAt: 0, finishedAt: 1_000 });
    expect(r.eligibleCompletedAttempts).toBe(1);
    expect(r.latency.min).toBe(10);
  });

  it("all-aborted/incomplete 以 eligible=0 触发 noData，混合样本按 eligible 计算", () => {
    const aborted: StressSample = {
      requestStarted: true, requestCompleted: true, requestTimeMs: 10, scriptTimeMs: 0, iterationTimeMs: 10,
      status: 0, ok: false, failureKind: "aborted",
    };
    const allAborted = computeReport([aborted], { concurrency: 1, startedAt: 0, finishedAt: 1_000 });
    expect(allAborted.eligibleCompletedAttempts).toBe(0);
    expect(evaluateStressThresholds(allAborted, {}).violations.map((v) => v.metric)).toContain("noData");
    const mixed = computeReport([aborted, { ...sample(10), requestStarted: true, requestCompleted: true }], {
      concurrency: 1, startedAt: 0, finishedAt: 1_000,
    });
    expect(mixed.eligibleCompletedAttempts).toBe(1);
    expect(evaluateStressThresholds(mixed, {}).violations.map((v) => v.metric)).not.toContain("noData");
  });

  it("worker pressure measurement window 驱动 RPS，排除 coordinator/setup/teardown 时间", () => {
    const r = computeReport(
      [{ ...sample(1), requestStarted: true, requestCompleted: true }],
      {
        concurrency: 1, startedAt: 10_000, finishedAt: 20_000,
        measurementWindow: { startWallMs: 15_000, endWallMs: 16_000, monotonicDurationMs: 100, eligibleCompletedAttempts: 1 },
      },
    );
    expect(r.startedAt).toBe(15_000);
    expect(r.finishedAt).toBe(16_000);
    // monotonic pressure time is authoritative even when comparable wall
    // timestamps span a different amount of time.
    expect(r.durationMs).toBe(100);
    expect(r.rps).toBe(10);
    expect(r.measurementWindow?.eligibleCompletedAttempts).toBe(1);
  });
});

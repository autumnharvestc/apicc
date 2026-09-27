import { describe, expect, it } from "vitest";
import { computeReport } from "../../src/stress/aggregate.js";
import { evaluateStressThresholds } from "../../src/stress/thresholds.js";
import { StressReportSchema } from "../../src/stress/model.js";
import type { StressSample } from "../../src/stress/model.js";

const s = (requestTimeMs: number, failureKind?: StressSample["failureKind"], status = 200): StressSample => ({
  requestTimeMs,
  scriptTimeMs: 0,
  iterationTimeMs: requestTimeMs,
  status,
  ok: failureKind === undefined,
  failureKind,
  error: failureKind ? `${failureKind} failed` : undefined,
});

describe("evaluateStressThresholds", () => {
  it("识别 p95、错误率、断言失败率和最低 RPS 超限", () => {
    const report = computeReport([
      s(600), s(700, "assertion"), s(10, "http", 500), s(10, "transport"),
    ], { concurrency: 1, startedAt: 0, finishedAt: 1_000 });
    const verdict = evaluateStressThresholds(report, {
      maxErrorRate: 0.01,
      maxAssertionFailureRate: 0,
      maxP95Ms: 500,
      minRps: 100,
    });
    expect(verdict.passed).toBe(false);
    expect(verdict.violations.map((v) => v.metric)).toEqual(expect.arrayContaining(["p95", "errorRate", "assertionFailureRate", "rps"]));
  });

  it("aborted 样本不进入业务错误率和断言失败率分母", () => {
    const report = computeReport([s(10), s(20, "aborted")], { concurrency: 1, startedAt: 0, finishedAt: 1_000 });
    const verdict = evaluateStressThresholds(report, { maxErrorRate: 0, maxAssertionFailureRate: 0 });
    expect(verdict.passed).toBe(true);
    expect(verdict.violations).toEqual([]);
  });

  it("未提供阈值但有非 aborted 业务失败仍产生 businessFailures", () => {
    const report = computeReport([s(10), s(20, "script")], { concurrency: 1, startedAt: 0, finishedAt: 1_000 });
    const verdict = evaluateStressThresholds(report, {});
    expect(verdict.passed).toBe(false);
    expect(verdict.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "businessFailures", actual: 1, expected: 0 }),
    ]));
  });

  it("旧报告仍可解析，且没有 verdict 时保持未评估", () => {
    const legacy = {
      concurrency: 1, totalRequests: 1, ok: 1, failed: 0, durationMs: 1000, rps: 1,
      latency: { min: 1, avg: 1, max: 1, p50: 1, p90: 1, p95: 1, p99: 1 },
      statusDist: { "200": 1 }, errorKinds: {}, startedAt: 0, finishedAt: 1000,
    };
    const parsed = StressReportSchema.parse(legacy);
    expect(parsed.verdict).toBeUndefined();
  });

  it("拒绝负数/小数 latency 与计数，避免报告伪造", () => {
    const base = {
      concurrency: 1, totalRequests: 1, ok: 1, failed: 0, durationMs: 1000, rps: 1,
      latency: { min: 1, avg: 1, max: 1, p50: 1, p90: 1, p95: 1, p99: 1 },
      statusDist: { "200": 1 }, errorKinds: {}, startedAt: 0, finishedAt: 1000,
      failures: { transport: 0, http: 0, script: 0, assertion: 0, config: 0, aborted: 0 },
      scriptLatency: { min: 0, avg: 0, max: 0, p50: 0, p90: 0, p95: 0, p99: 0 },
      iterationLatency: { min: 1, avg: 1, max: 1, p50: 1, p90: 1, p95: 1, p99: 1 },
    };
    expect(() => StressReportSchema.parse({ ...base, latency: { ...base.latency, p95: -1 } })).toThrow();
    expect(() => StressReportSchema.parse({ ...base, statusDist: { "200": 0.5 } })).toThrow();
    expect(() => StressReportSchema.parse({ ...base, failures: { ...base.failures, http: -1 } })).toThrow();
  });
});

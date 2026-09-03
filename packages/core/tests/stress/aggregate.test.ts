import { describe, expect, it } from "vitest";
import { computeReport } from "../../src/stress/aggregate.js";
import type { StressSample } from "../../src/stress/model.js";

const sample = (timeMs: number, status = 200, error?: string): StressSample =>
  ({ timeMs, status, ok: status >= 200 && status < 400 && !error, error });

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
    expect(r.statusDist).toEqual({ "200": 1, "404": 1, "500": 1 });
    expect(r.errorKinds).toEqual({ ECONNREFUSED: 1, "HTTP_404": 1, "HTTP_500": 1 });
  });

  it("空样本不抛（除法防护）", () => {
    const r = computeReport([], { concurrency: 4, startedAt: 0, finishedAt: 0 });
    expect(r.totalRequests).toBe(0);
    expect(r.rps).toBe(0);
    expect(r.latency.p50).toBe(0);
  });
});

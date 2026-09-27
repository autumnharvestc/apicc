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
    expect(r.statusDist).toEqual({ "200": 1, "404": 1, "500": 1 });
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
    expect(r.latency.p95).toBe(70);
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
    expect(evaluateStressThresholds(r, { maxP95Ms: 500 }).violations.map((v) => v.metric)).toContain("p95");
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
});

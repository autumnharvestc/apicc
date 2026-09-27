import { describe, expect, it, vi } from "vitest";
import { StressRunner } from "../../src/stress/runner.js";
import type { GeneratorMetricsCollector } from "../../src/stress/generatorMetrics.js";
import type { StressGeneratorMetrics } from "../../src/stress/model.js";

function result() {
  return {
    request: { method: "GET" as const, url: "http://fake/", headers: {}, query: [] },
    response: { status: 200, headers: {}, bodyText: "", timeMs: 0 },
    requestTimeMs: 0, scriptTimeMs: 0, iterationTimeMs: 0,
    outcome: { apiId: "a", apiName: "a", caseId: "c", caseName: "c", passed: true, durationMs: 0, assertions: [] },
  };
}

function collector(stop: () => StressGeneratorMetrics): GeneratorMetricsCollector {
  return { recordSchedulerBacklog: vi.fn(), stop };
}

describe("StressRunner generator lifecycle and safety rate", () => {
  it.each(["normal", "abort", "error"])("stops collector exactly once on %s path", async (path) => {
    const stop = vi.fn<() => StressGeneratorMetrics>(() => ({
      cpuUserMs: 0, cpuSystemMs: 0, cpuPercent: 0, rssStartBytes: 0, rssPeakBytes: 0,
      eventLoopDelayP95Ms: 0, schedulerBacklogMax: 0, saturated: false,
      reasons: [], limits: { cpuPercent: 90, eventLoopDelayP95Ms: 100, schedulerBacklog: 0 },
    }));
    const controller = new AbortController();
    let calls = 0;
    const runner = new StressRunner({
      createGeneratorCollector: () => collector(stop),
      createWorker: () => ({
        execute: async () => {
          calls += 1;
          if (path === "abort") controller.abort();
          if (path === "error") throw new Error("execute failed");
          return result();
        },
        close: async () => {},
      }),
    });
    if (path === "error") await expect(runner.run({ concurrency: 1, maxIterations: 1 })).rejects.toThrow("execute failed");
    else {
      const report = await runner.run({ concurrency: 1, maxIterations: 2, signal: path === "abort" ? controller.signal : undefined });
      expect(report.generator).toBeDefined();
    }
    expect(stop).toHaveBeenCalledTimes(1);
    expect(calls).toBeLessThanOrEqual(2);
  });

  it("limits all workers to maxRps over a sliding one-second window", async () => {
    const starts: number[] = [];
    const runner = new StressRunner({
      createWorker: () => ({
        execute: async () => {
          starts.push(Date.now());
          return result();
        },
        close: async () => {},
      }),
    });
    await runner.run({ concurrency: 3, maxIterations: 10, maxRps: 5 });
    for (let i = 0; i < starts.length; i += 1) {
      const windowStart = starts[i]!;
      const count = starts.filter((at) => at >= windowStart && at < windowStart + 1_000).length;
      expect(count).toBeLessThanOrEqual(5);
    }
  });

  it("rejects a non-positive maxRps before starting workers", async () => {
    const createWorker = vi.fn(() => ({ execute: async () => result(), close: async () => {} }));
    const runner = new StressRunner({ createWorker });
    await expect(runner.run({ concurrency: 1, maxIterations: 1, maxRps: 0 })).rejects.toThrow("maxRps");
    expect(createWorker).not.toHaveBeenCalled();
  });
});

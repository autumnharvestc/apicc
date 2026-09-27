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

class FakeScheduler {
  nowValue = 0;
  lastDelay = 0;
  private nextId = 0;
  protected readonly timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.nowValue;
  setTimeout = (callback: () => void, delay: number): NodeJS.Timeout => {
    this.lastDelay = delay;
    const id = ++this.nextId;
    this.timers.set(id, { at: this.nowValue + delay, callback });
    return { unref: vi.fn(), id } as unknown as NodeJS.Timeout;
  };
  clearTimeout = (timer: NodeJS.Timeout): void => {
    this.timers.delete((timer as unknown as { id: number }).id);
  };
  hasTimers(): boolean { return this.timers.size > 0; }
  advanceToNextTimer(): void {
    const next = [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (!next) throw new Error("no scheduled timer");
    this.nowValue = next[1].at;
    this.timers.delete(next[0]);
    next[1].callback();
  }
}

class ThrowingClearScheduler extends FakeScheduler {
  private clearCalls = 0;
  clearTimeout = (timer: NodeJS.Timeout): void => {
    this.clearCalls += 1;
    if (this.clearCalls > 1) throw new Error("clear failed");
  };
}

class AcquireClearFailureScheduler extends FakeScheduler {
  private clearCalls = 0;
  clearTimeout = (timer: NodeJS.Timeout): void => {
    this.clearCalls += 1;
    this.timers.delete((timer as unknown as { id: number }).id);
    if (this.clearCalls === 1) throw new Error("clear during acquire");
  };
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
    const scheduler = new FakeScheduler();
    const starts: number[] = [];
    const runner = new StressRunner({
      now: scheduler.now, setTimeout: scheduler.setTimeout, clearTimeout: scheduler.clearTimeout,
      createWorker: () => ({
        execute: async () => {
          starts.push(scheduler.nowValue);
          return result();
        },
        close: async () => {},
      }),
    });
    let settled = false;
    const pending = runner.run({ concurrency: 3, maxIterations: 10, maxRps: 5 }).finally(() => { settled = true; });
    for (let i = 0; i < 8 && !settled; i += 1) {
      for (let microtask = 0; microtask < 8; microtask += 1) await Promise.resolve();
      if (!settled && scheduler.hasTimers()) scheduler.advanceToNextTimer();
    }
    await pending;
    for (let i = 0; i < starts.length; i += 1) {
      const windowStart = starts[i]!;
      const count = starts.filter((at) => at >= windowStart && at < windowStart + 1_000).length;
      expect(count, JSON.stringify(starts)).toBeLessThanOrEqual(5);
    }
  });

  it("keeps reciprocal spacing after a long iteration for maxRps below one", async () => {
    const scheduler = new FakeScheduler();
    const starts: number[] = [];
    const runner = new StressRunner({
      now: scheduler.now, setTimeout: scheduler.setTimeout, clearTimeout: scheduler.clearTimeout,
      createWorker: () => ({
        execute: async () => { starts.push(scheduler.nowValue); scheduler.nowValue += 1_100; return result(); },
        close: async () => {},
      }),
    });
    let settled = false;
    const pending = runner.run({ concurrency: 1, maxIterations: 2, maxRps: 0.5 }).finally(() => { settled = true; });
    for (let i = 0; i < 8 && !settled; i += 1) {
      await Promise.resolve();
      if (!settled && scheduler.hasTimers()) scheduler.advanceToNextTimer();
    }
    await pending;
    expect(starts).toEqual([0, 2_000]);
  });

  it("uses ref'd control timers and still completes a fake-clock maxRps run", async () => {
    const scheduler = new FakeScheduler();
    const unrefs: ReturnType<typeof vi.fn>[] = [];
    const setTimeout = (callback: () => void, delay: number): NodeJS.Timeout => {
      const timer = scheduler.setTimeout(callback, delay);
      const unref = vi.fn();
      unrefs.push(unref);
      return { ...(timer as unknown as object), unref, id: (timer as unknown as { id: number }).id } as unknown as NodeJS.Timeout;
    };
    const runner = new StressRunner({
      now: scheduler.now, setTimeout, clearTimeout: scheduler.clearTimeout,
      createWorker: () => ({ execute: async () => result(), close: async () => {} }),
    });
    let settled = false;
    const pending = runner.run({ concurrency: 1, maxIterations: 2, maxRps: 1 }).finally(() => { settled = true; });
    for (let i = 0; i < 8 && !settled; i += 1) {
      await Promise.resolve();
      if (!settled && scheduler.hasTimers()) scheduler.advanceToNextTimer();
    }
    const report = await pending;
    expect(report.totalRequests).toBe(2);
    expect(unrefs.every((unref) => unref.mock.calls.length === 0)).toBe(true);
  });

  it("creates a fresh collector on every run", async () => {
    const collectors: GeneratorMetricsCollector[] = [];
    const runner = new StressRunner({
      createGeneratorCollector: () => {
        const stop = vi.fn(() => ({ cpuUserMs: 0, cpuSystemMs: 0, cpuPercent: 0, rssStartBytes: 0, rssPeakBytes: 0, eventLoopDelayP95Ms: 0, schedulerBacklogMax: 0, saturated: false, reasons: [], limits: { cpuPercent: 90, eventLoopDelayP95Ms: 100, schedulerBacklog: 0 } }));
        const value = collector(stop);
        collectors.push(value);
        return value;
      },
      createWorker: () => ({ execute: async () => result(), close: async () => {} }),
    });
    await runner.run({ concurrency: 1, maxIterations: 1 });
    await runner.run({ concurrency: 1, maxIterations: 1 });
    expect(collectors).toHaveLength(2);
    expect(collectors[0]).not.toBe(collectors[1]);
  });

  it("aborts waiting workers promptly without starting another iteration", async () => {
    const controller = new AbortController();
    let calls = 0;
    const runner = new StressRunner({
      createWorker: () => ({
        execute: async () => { calls += 1; controller.abort(); return result(); },
        close: async () => {},
      }),
    });
    const report = await runner.run({ concurrency: 3, maxIterations: 10, maxRps: 1, signal: controller.signal });
    expect(calls).toBe(1);
    expect(report.totalRequests).toBe(1);
  });

  it("keeps FIFO worker fairness with a fake monotonic clock", async () => {
    const scheduler = new FakeScheduler();
    const order: number[] = [];
    let workerId = 0;
    const runner = new StressRunner({
      now: scheduler.now, setTimeout: scheduler.setTimeout, clearTimeout: scheduler.clearTimeout,
      createWorker: () => {
        const id = workerId++;
        return { execute: async () => { order.push(id); return result(); }, close: async () => {} };
      },
    });
    let settled = false;
    const pending = runner.run({ concurrency: 3, maxIterations: 3, maxRps: 1 }).finally(() => { settled = true; });
    for (let i = 0; i < 8 && !settled; i += 1) {
      await Promise.resolve();
      if (!settled && scheduler.hasTimers()) scheduler.advanceToNextTimer();
    }
    await pending;
    expect(order).toEqual([0, 1, 2]);
  });

  it("clamps a backwards injected clock instead of releasing early", async () => {
    const scheduler = new FakeScheduler();
    const starts: number[] = [];
    const runner = new StressRunner({
      now: scheduler.now, setTimeout: scheduler.setTimeout, clearTimeout: scheduler.clearTimeout,
      createWorker: () => ({
        execute: async () => { starts.push(scheduler.nowValue); if (starts.length === 1) scheduler.nowValue = -500; return result(); },
        close: async () => {},
      }),
    });
    let settled = false;
    const pending = runner.run({ concurrency: 1, maxIterations: 2, maxRps: 1 }).finally(() => { settled = true; });
    for (let i = 0; i < 8 && !settled; i += 1) {
      await Promise.resolve();
      if (!settled && scheduler.hasTimers()) scheduler.advanceToNextTimer();
    }
    await pending;
    expect(starts).toEqual([0, 1_000]);
  });

  it("reports acquire-phase timer clear failure as primary after a clock jump", async () => {
    const scheduler = new AcquireClearFailureScheduler();
    let jumped = false;
    let closed = 0;
    const stop = vi.fn(() => ({ cpuUserMs: 0, cpuSystemMs: 0, cpuPercent: 0, rssStartBytes: 0, rssPeakBytes: 0, eventLoopDelayP95Ms: 0, schedulerBacklogMax: 0, saturated: false, reasons: [], limits: { cpuPercent: 90, eventLoopDelayP95Ms: 100, schedulerBacklog: 0 } }));
    const runner = new StressRunner({
      now: scheduler.now, setTimeout: scheduler.setTimeout, clearTimeout: scheduler.clearTimeout,
      createGeneratorCollector: () => collector(stop),
      createWorker: () => ({
        execute: async () => { if (!jumped) { await Promise.resolve(); jumped = true; scheduler.nowValue = 1_000; } return result(); },
        close: async () => { closed += 1; },
      }),
    });
    await expect(runner.run({ concurrency: 3, maxIterations: 4, maxRps: 2 })).rejects.toThrow("clear during acquire");
    expect(closed).toBe(3);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(scheduler.hasTimers()).toBe(false);
  });

  it("handles a large forward clock jump without releasing a stale permit", async () => {
    const scheduler = new FakeScheduler();
    const starts: number[] = [];
    const runner = new StressRunner({
      now: scheduler.now, setTimeout: scheduler.setTimeout, clearTimeout: scheduler.clearTimeout,
      createWorker: () => ({
        execute: async () => { starts.push(scheduler.nowValue); if (starts.length === 1) scheduler.nowValue = 5_000; return result(); },
        close: async () => {},
      }),
    });
    await runner.run({ concurrency: 1, maxIterations: 2, maxRps: 1 });
    expect(starts).toEqual([0, 5_000]);
  });

  it("clamps a finite tiny-rate delay instead of scheduling Infinity or a 1ms spin", async () => {
    const scheduler = new FakeScheduler();
    const controller = new AbortController();
    const runner = new StressRunner({
      now: scheduler.now, setTimeout: scheduler.setTimeout, clearTimeout: scheduler.clearTimeout,
      createWorker: () => ({ execute: async () => result(), close: async () => {} }),
    });
    const pending = runner.run({ concurrency: 1, maxIterations: 2, maxRps: Number.MIN_VALUE, signal: controller.signal });
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
      if (scheduler.hasTimers()) { controller.abort(); break; }
    }
    await pending;
    expect(scheduler.lastDelay).toBeGreaterThan(1);
    expect(scheduler.lastDelay).toBeLessThanOrEqual(2_147_000_000);
  });

  it("drives multiple long-delay chunks until a tiny finite rate grants the next permit", async () => {
    const scheduler = new FakeScheduler();
    const starts: number[] = [];
    const runner = new StressRunner({
      now: scheduler.now, setTimeout: scheduler.setTimeout, clearTimeout: scheduler.clearTimeout,
      createWorker: () => ({ execute: async () => { starts.push(scheduler.nowValue); return result(); }, close: async () => {} }),
    });
    let settled = false;
    const pending = runner.run({ concurrency: 1, maxIterations: 2, maxRps: 1e-9 }).finally(() => { settled = true; });
    for (let i = 0; i < 600 && !settled; i += 1) {
      for (let microtask = 0; microtask < 4; microtask += 1) await Promise.resolve();
      if (!settled && scheduler.hasTimers()) scheduler.advanceToNextTimer();
    }
    await pending;
    expect(starts).toHaveLength(2);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(1e12 - 1);
  });

  it("preserves a limiter stop error while settling every pending waiter", async () => {
    const scheduler = new ThrowingClearScheduler();
    let closed = 0;
    const runner = new StressRunner({
      now: scheduler.now, setTimeout: scheduler.setTimeout, clearTimeout: scheduler.clearTimeout,
      createWorker: () => ({
        execute: async () => { throw new Error("body failed"); },
        close: async () => { closed += 1; },
      }),
    });
    await expect(runner.run({ concurrency: 3, maxIterations: 10, maxRps: 1 })).rejects.toThrow("body failed");
    expect(closed).toBe(3);
  });

  it("preserves a limiter schedule error over collector stop cleanup", async () => {
    const stop = vi.fn(() => { throw new Error("collector stop failed"); });
    let closed = 0;
    const runner = new StressRunner({
      createGeneratorCollector: () => collector(stop as unknown as () => StressGeneratorMetrics),
      setTimeout: () => { throw new Error("schedule failed"); },
      createWorker: () => ({ execute: async () => result(), close: async () => { closed += 1; } }),
    });
    await expect(runner.run({ concurrency: 2, maxIterations: 4, maxRps: 1 })).rejects.toThrow("schedule failed");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(closed).toBe(2);
  });

  it("cleans sessions when collector initialization fails", async () => {
    const createWorker = vi.fn(() => ({ execute: async () => result(), close: async () => {} }));
    const runner = new StressRunner({ createWorker, createGeneratorCollector: () => { throw new Error("collector init failed"); } });
    await expect(runner.run({ concurrency: 1, maxIterations: 1 })).rejects.toThrow("collector init failed");
    expect(createWorker).not.toHaveBeenCalled();
  });

  it("preserves session close error over collector stop error", async () => {
    const stop = vi.fn(() => { throw new Error("collector stop failed"); });
    const runner = new StressRunner({
      createGeneratorCollector: () => collector(stop as unknown as () => StressGeneratorMetrics),
      createWorker: () => ({ execute: async () => result(), close: async () => { throw new Error("close failed"); } }),
    });
    await expect(runner.run({ concurrency: 1, maxIterations: 1 })).rejects.toThrow("close failed");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("preserves body error over session close and collector stop errors", async () => {
    const stop = vi.fn(() => { throw new Error("collector stop failed"); });
    const runner = new StressRunner({
      createGeneratorCollector: () => collector(stop as unknown as () => StressGeneratorMetrics),
      createWorker: () => ({ execute: async () => { throw new Error("body failed"); }, close: async () => { throw new Error("close failed"); } }),
    });
    await expect(runner.run({ concurrency: 1, maxIterations: 1 })).rejects.toThrow("body failed");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-positive maxRps before starting workers", async () => {
    const createWorker = vi.fn(() => ({ execute: async () => result(), close: async () => {} }));
    const runner = new StressRunner({ createWorker });
    await expect(runner.run({ concurrency: 1, maxIterations: 1, maxRps: 0 })).rejects.toThrow("maxRps");
    expect(createWorker).not.toHaveBeenCalled();
  });
});

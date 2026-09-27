import { describe, expect, it, vi } from "vitest";
import {
  createGeneratorMetricsCollector,
  type GeneratorMetricsCollector,
} from "../../src/stress/generatorMetrics.js";

describe("generator metrics collector", () => {
  it("samples RSS on the injected interval and keeps the observed peak", () => {
    let sample: (() => void) | undefined;
    let rss = 10;
    const collector = createGeneratorMetricsCollector({
      cpuUsage: () => ({ user: 0, system: 0 }), rss: () => rss,
      eventLoopDelayP95Ms: () => 0,
      setInterval: (callback) => { sample = callback; return { unref: vi.fn() } as unknown as NodeJS.Timeout; },
      clearInterval: vi.fn(),
    });
    rss = 50;
    sample?.();
    rss = 20;
    expect(collector.stop().rssPeakBytes).toBe(50);
  });

  it("computes raw CPU time and allows cpuPercent above 100", () => {
    let now = 100;
    let rss = 10;
    let cpu = 0;
    const collector = createGeneratorMetricsCollector({
      now: () => now,
      cpuUsage: () => cpu++ === 0 ? ({ user: 0, system: 0 }) : ({ user: 1_500_000, system: 500_000 }),
      rss: () => rss,
      eventLoopDelayP95Ms: () => 0,
      setInterval: () => ({ unref: vi.fn() } as unknown as NodeJS.Timeout),
      clearInterval: vi.fn(),
    });
    now = 1_100;
    rss = 30;
    const metrics = collector.stop();

    expect(metrics.cpuUserMs).toBe(1_500);
    expect(metrics.cpuSystemMs).toBe(500);
    expect(metrics.cpuPercent).toBe(200);
    expect(metrics.rssStartBytes).toBe(10);
    expect(metrics.rssPeakBytes).toBe(30);
  });

  it("retains stable saturation reasons and limits", () => {
    const collector = createGeneratorMetricsCollector({
      now: (() => { let value = 0; return () => value += 1_000; })(),
      cpuUsage: (() => { let first = true; return () => first ? (first = false, { user: 0, system: 0 }) : ({ user: 900_000, system: 0 }); })(),
      rss: () => 1,
      eventLoopDelayP95Ms: () => 101,
      schedulerBacklogMax: () => 2,
      setInterval: () => ({ unref: vi.fn() } as unknown as NodeJS.Timeout),
      clearInterval: vi.fn(),
    });
    const metrics = collector.stop();

    expect(metrics).toMatchObject({
      saturated: true,
      reasons: ["cpu", "event-loop-delay", "scheduler-backlog"],
      limits: { cpuPercent: 90, eventLoopDelayP95Ms: 100, schedulerBacklog: 0 },
    });
  });

  it("stop is idempotent and clears the sampling timer", () => {
    const clearInterval = vi.fn();
    const timer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const collector = createGeneratorMetricsCollector({
      cpuUsage: () => ({ user: 0, system: 0 }), rss: () => 1,
      eventLoopDelayP95Ms: () => 0,
      setInterval: () => timer,
      clearInterval,
    });

    const first = collector.stop();
    const second = collector.stop();
    expect(second).toBe(first);
    expect(clearInterval).toHaveBeenCalledTimes(1);
  });

  it("exposes backlog recording without treating rate-limit waiters as backlog", () => {
    const collector = createGeneratorMetricsCollector({
      cpuUsage: () => ({ user: 0, system: 0 }), rss: () => 1,
      eventLoopDelayP95Ms: () => 0,
      setInterval: () => ({ unref: vi.fn() } as unknown as NodeJS.Timeout),
      clearInterval: vi.fn(),
    });
    collector.recordSchedulerBacklog(0);
    expect(collector.stop().schedulerBacklogMax).toBe(0);
  });

  it("cleans timer and disables histogram once when a stop probe throws", () => {
    const clearInterval = vi.fn();
    const disable = vi.fn();
    const histogram = { percentile: vi.fn(() => { throw new Error("percentile failed"); }), disable };
    const collector = createGeneratorMetricsCollector({
      cpuUsage: () => ({ user: 0, system: 0 }), rss: () => 1,
      eventLoopHistogram: histogram,
      setInterval: () => ({ unref: vi.fn() } as unknown as NodeJS.Timeout), clearInterval,
    });
    expect(() => collector.stop()).toThrow("percentile failed");
    expect(() => collector.stop()).toThrow("percentile failed");
    expect(clearInterval).toHaveBeenCalledTimes(1);
    expect(disable).toHaveBeenCalledTimes(1);
  });
});

export type { GeneratorMetricsCollector };

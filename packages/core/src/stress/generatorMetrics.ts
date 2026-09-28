import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";
import type { StressGeneratorMetrics } from "./model.js";
export type { StressGeneratorMetrics } from "./model.js";

export const DEFAULT_GENERATOR_LIMITS = {
  cpuPercent: 90,
  eventLoopDelayP95Ms: 100,
  schedulerBacklog: 0,
} as const;

export interface GeneratorCpuUsage {
  /** Node's process.cpuUsage units (microseconds). */
  user: number;
  system: number;
}

export interface GeneratorCpuUsageMs {
  userMs: number;
  systemMs: number;
}

export interface GeneratorMetricsProbe {
  now?: () => number;
  clock?: { now: () => number };
  cpuUsage?: () => GeneratorCpuUsage | GeneratorCpuUsageMs;
  cpu?: () => GeneratorCpuUsage | GeneratorCpuUsageMs;
  cpuUnit?: "microseconds" | "milliseconds";
  rss?: () => number;
  rssBytes?: () => number;
  eventLoopDelayP95Ms?: () => number;
  eventLoopDelayP95?: () => number;
  schedulerBacklogMax?: () => number;
  schedulerBacklog?: () => number;
  setInterval?: (handler: () => void, timeout: number) => NodeJS.Timeout;
  clearInterval?: (timer: NodeJS.Timeout) => void;
  sampleIntervalMs?: number;
  /** Inject a histogram-like object when testing the default event-loop probe. */
  eventLoopHistogram?: Pick<IntervalHistogram, "percentile" | "disable">;
}

export interface GeneratorMetricsCollector {
  /** Record a scheduler queue depth observed by the execution scheduler. */
  recordSchedulerBacklog(depth: number): void;
  /** Stop sampling and return a stable snapshot. Repeated calls return the same object. */
  stop(): StressGeneratorMetrics;
}

function defaultCpuUsage(): GeneratorCpuUsage {
  return process.cpuUsage();
}

function defaultRss(): number {
  return process.memoryUsage().rss;
}

function cpuMilliseconds(value: GeneratorCpuUsage | GeneratorCpuUsageMs, unit: "microseconds" | "milliseconds"): [number, number] {
  if ("userMs" in value) return [asFiniteNonNegative(value.userMs), asFiniteNonNegative(value.systemMs)];
  const scale = unit === "milliseconds" ? 1 : 1_000;
  return [asFiniteNonNegative(value.user) / scale, asFiniteNonNegative(value.system) / scale];
}

function asFiniteNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Creates an independent sampler for the local stress generator.
 *
 * Every operating-system probe is injectable so tests can describe CPU, RSS and
 * event-loop behavior without burning CPU or depending on transient host load.
 */
export function createGeneratorMetricsCollector(probe: GeneratorMetricsProbe = {}): GeneratorMetricsCollector {
  const now = probe.now ?? probe.clock?.now ?? Date.now;
  const cpuUsage = probe.cpuUsage ?? probe.cpu ?? defaultCpuUsage;
  const rss = probe.rss ?? probe.rssBytes ?? defaultRss;
  const cpuUnit = probe.cpuUnit ?? "microseconds";
  const intervalMs = probe.sampleIntervalMs ?? 250;
  const setIntervalFn: (handler: () => void, timeout: number) => NodeJS.Timeout = probe.setInterval
    ?? ((handler, timeout) => setInterval(handler, timeout));
  const clearIntervalFn: (timer: NodeJS.Timeout) => void = probe.clearInterval
    ?? ((timer) => clearInterval(timer));
  const initialCpu = cpuUsage();
  const initialNow = now();
  const initialRss = asFiniteNonNegative(rss());
  let peakRss = initialRss;
  let backlogMax = 0;
  let stopped = false;
  let snapshot: StressGeneratorMetrics | undefined;
  let stopError: unknown;
  let hasStopError = false;
  let samplingProbeError: unknown;
  let hasSamplingProbeError = false;

  let histogram: Pick<IntervalHistogram, "percentile" | "disable"> & Partial<Pick<IntervalHistogram, "enable">> | undefined = probe.eventLoopHistogram;
  if (!histogram && !probe.eventLoopDelayP95Ms) {
    histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable?.();
  }

  const sampleRss = (): void => {
    try {
      peakRss = Math.max(peakRss, asFiniteNonNegative(rss()));
    } catch (error) {
      if (!hasSamplingProbeError) { hasSamplingProbeError = true; samplingProbeError = error; }
    }
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    timer = setIntervalFn(sampleRss, intervalMs);
    // Sampling must not keep a CLI process alive after all work has completed.
    timer.unref?.();
  } catch (error) {
    try { if (timer !== undefined) clearIntervalFn(timer); } catch { /* preserve initialization error */ }
    try { histogram?.disable(); } catch { /* preserve initialization error */ }
    throw error;
  }
  const samplingTimer = timer;

  const recordSchedulerBacklog = (depth: number): void => {
    if (!stopped && Number.isFinite(depth) && depth > backlogMax) backlogMax = depth;
  };

  const stop = (): StressGeneratorMetrics => {
    if (snapshot) return snapshot;
    if (hasStopError) throw stopError;
    stopped = true;
    let firstError: unknown;
    let hasFirstError = false;
    const attempt = (operation: () => void): void => {
      try { operation(); }
      catch (error) { if (!hasFirstError) { hasFirstError = true; firstError = error; } }
    };
    attempt(() => clearIntervalFn(samplingTimer));
    attempt(sampleRss);
    if (hasSamplingProbeError && !hasFirstError) {
      hasFirstError = true;
      firstError = samplingProbeError;
    }
    let elapsedMs = 0;
    attempt(() => { elapsedMs = Math.max(0, now() - initialNow); });
    let finalCpu = initialCpu;
    attempt(() => { finalCpu = cpuUsage(); });
    const [initialUserMs, initialSystemMs] = cpuMilliseconds(initialCpu, cpuUnit);
    const [finalUserMs, finalSystemMs] = cpuMilliseconds(finalCpu, cpuUnit);
    const cpuUserMs = Math.max(0, finalUserMs - initialUserMs);
    const cpuSystemMs = Math.max(0, finalSystemMs - initialSystemMs);
    const cpuPercent = elapsedMs > 0 ? ((cpuUserMs + cpuSystemMs) / elapsedMs) * 100 : 0;
    const eventLoopProbe = probe.eventLoopDelayP95Ms ?? probe.eventLoopDelayP95;
    let eventLoopDelayP95Ms = 0;
    if (eventLoopProbe) attempt(() => { eventLoopDelayP95Ms = asFiniteNonNegative(eventLoopProbe()); });
    else if (histogram) attempt(() => { eventLoopDelayP95Ms = asFiniteNonNegative(histogram!.percentile(95) / 1_000_000); });
    if (histogram) attempt(() => histogram!.disable());
    const backlogProbe = probe.schedulerBacklogMax ?? probe.schedulerBacklog;
    if (backlogProbe) {
      attempt(() => { backlogMax = Math.max(backlogMax, asFiniteNonNegative(backlogProbe())); });
    }

    const reasons: StressGeneratorMetrics["reasons"] = [];
    if (cpuPercent >= DEFAULT_GENERATOR_LIMITS.cpuPercent) reasons.push("cpu");
    if (eventLoopDelayP95Ms > DEFAULT_GENERATOR_LIMITS.eventLoopDelayP95Ms) reasons.push("event-loop-delay");
    if (backlogMax > DEFAULT_GENERATOR_LIMITS.schedulerBacklog) reasons.push("scheduler-backlog");
    if (hasFirstError) {
      stopError = firstError;
      hasStopError = true;
      throw firstError;
    }
    snapshot = {
      availability: "available",
      cpuUserMs,
      cpuSystemMs,
      cpuPercent,
      rssStartBytes: initialRss,
      rssPeakBytes: peakRss,
      eventLoopDelayP95Ms,
      schedulerBacklogMax: Math.max(0, Math.ceil(backlogMax)),
      saturated: reasons.length > 0,
      reasons,
      limits: { ...DEFAULT_GENERATOR_LIMITS },
    };
    return snapshot;
  };

  return { recordSchedulerBacklog, stop };
}

export { createGeneratorMetricsCollector as createStressGeneratorMetricsCollector };
export { createGeneratorMetricsCollector as createGeneratorCollector };

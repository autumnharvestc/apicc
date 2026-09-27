import type { CaseExecutionResult } from "../runner/caseExecutor.js";
import { computeReport } from "./aggregate.js";
import { createGeneratorMetricsCollector, type GeneratorMetricsCollector, type GeneratorMetricsProbe } from "./generatorMetrics.js";
import type { StressReport, StressSample, StressThresholds } from "./model.js";
import type { StressWorkerSession } from "./caseSession.js";

export interface StressRunnerOptions {
  /** Creates one isolated virtual-user session for each concurrent worker. */
  createWorker: (workerId: number) => Promise<StressWorkerSession> | StressWorkerSession;
  /** Optional injectable generator collector used by deterministic tests. */
  createGeneratorCollector?: () => GeneratorMetricsCollector;
  /** Alias retained for callers that use the concrete collector name. */
  createGeneratorMetricsCollector?: () => GeneratorMetricsCollector;
  generatorMetricsProbe?: GeneratorMetricsProbe;
  now?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  generatorCollector?: GeneratorMetricsCollector | (() => GeneratorMetricsCollector);
}
export interface StressRunOptions {
  concurrency: number;
  maxIterations?: number;
  durationMs?: number;
  /** Stops starting new iterations; the same signal is forwarded to the session. */
  signal?: AbortSignal;
  thresholds?: StressThresholds;
  /** Safety upper bound shared by all workers. It is not an arrival-rate target. */
  maxRps?: number;
}

interface PermitWaiter {
  resolve: (granted: boolean) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** A shared sliding-window limiter. Waiting for a permit is not scheduler backlog. */
class SlidingWindowPermitLimiter {
  private readonly timestamps: number[] = [];
  private readonly waiters: PermitWaiter[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private readonly capacity: number;

  constructor(
    private readonly maxRps: number,
    private readonly now: () => number,
    private readonly setTimeoutFn: typeof setTimeout,
    private readonly clearTimeoutFn: typeof clearTimeout,
  ) {
    this.capacity = Math.max(1, Math.floor(maxRps));
  }

  acquire(signal?: AbortSignal): Promise<boolean> {
    if (this.stopped || signal?.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const waiter: PermitWaiter = { resolve, signal };
      waiter.onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(false);
        this.process();
      };
      if (signal) signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
      this.process();
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer !== undefined) this.clearTimeoutFn(this.timer);
    this.timer = undefined;
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(false);
    }
  }

  private process(): void {
    if (this.stopped) return;
    const current = this.now();
    while (this.timestamps.length > 0 && current - this.timestamps[0]! >= 1_000) this.timestamps.shift();
    // For rates below one request per second, a single permit is spaced by the
    // reciprocal rate. For ordinary rates, the timestamp window is the bound.
    while (this.waiters.length > 0) {
      const next = this.waiters[0]!;
      if (next.signal?.aborted) {
        this.waiters.shift();
        next.resolve(false);
        continue;
      }
      const earliest = this.maxRps < 1 && this.timestamps.length > 0
        ? this.timestamps[this.timestamps.length - 1]! + (1_000 / this.maxRps)
        : undefined;
      if (earliest !== undefined && current < earliest) break;
      if (this.maxRps >= 1 && this.timestamps.length >= this.capacity) break;
      this.waiters.shift();
      if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
      this.timestamps.push(current);
      next.resolve(true);
    }
    if (this.waiters.length === 0) {
      if (this.timer !== undefined) this.clearTimeoutFn(this.timer);
      this.timer = undefined;
      return;
    }
    const oldest = this.maxRps < 1
      ? (this.timestamps[this.timestamps.length - 1] ?? current) + (1_000 / this.maxRps)
      : (this.timestamps[0] ?? current) + 1_000;
    const delay = Math.max(0, oldest - current);
    if (this.timer !== undefined) this.clearTimeoutFn(this.timer);
    this.timer = this.setTimeoutFn(() => { this.timer = undefined; this.process(); }, delay);
    this.timer.unref?.();
  }
}

function sampleFromResult(result: CaseExecutionResult): StressSample {
  const status = result.response?.status ?? 0;
  const error = result.outcome.error;
  const failureKind = result.failureKind ?? result.outcome.failureKind;
  return {
    timeMs: result.requestTimeMs,
    requestTimeMs: result.requestTimeMs,
    scriptTimeMs: result.scriptTimeMs,
    iterationTimeMs: result.iterationTimeMs,
    requestStarted: result.requestStarted,
    requestCompleted: result.requestCompleted,
    status,
    ok: result.outcome.passed,
    error,
    failureKind,
    outcome: result.outcome,
  };
}

/** Runs a bounded pool of virtual-user sessions with deterministic cleanup. */
export class StressRunner {
  constructor(private readonly opts: StressRunnerOptions) {}

  async run(runOpts: StressRunOptions): Promise<StressReport> {
    const { concurrency, maxIterations, durationMs, signal, maxRps } = runOpts;
    if (maxIterations === undefined && durationMs === undefined) {
      throw new Error("压测终止条件缺失：maxIterations 与 durationMs 必须给其一");
    }
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error(`concurrency 必须为正整数，收到 ${concurrency}`);
    }
    if (maxRps !== undefined && (!Number.isFinite(maxRps) || maxRps <= 0)) {
      throw new Error(`maxRps 必须为正数，收到 ${maxRps}`);
    }

    let createCollector: () => GeneratorMetricsCollector = this.opts.createGeneratorCollector
      ?? this.opts.createGeneratorMetricsCollector
      ?? (() => createGeneratorMetricsCollector(this.opts.generatorMetricsProbe));
    if (!this.opts.createGeneratorCollector && !this.opts.createGeneratorMetricsCollector && this.opts.generatorCollector !== undefined) {
      createCollector = typeof this.opts.generatorCollector === "function"
        ? this.opts.generatorCollector
        : () => this.opts.generatorCollector as GeneratorMetricsCollector;
    }
    const collector = createCollector();
    const limiter = maxRps === undefined
      ? undefined
      : new SlidingWindowPermitLimiter(
        maxRps,
        this.opts.now ?? Date.now,
        this.opts.setTimeout ?? setTimeout,
        this.opts.clearTimeout ?? clearTimeout,
      );

    const samples: StressSample[] = [];
    let stopped = false;
    let hasPrimaryError = false;
    let primaryError: unknown;
    let hasCleanupError = false;
    let cleanupError: unknown;
    const stopPrimary = (error: unknown): void => {
      stopped = true;
      limiter?.stop();
      if (!hasPrimaryError) { hasPrimaryError = true; primaryError = error; }
    };
    const stopCleanup = (error: unknown): void => {
      stopped = true;
      if (!hasCleanupError) { hasCleanupError = true; cleanupError = error; }
    };

    const sessions: StressWorkerSession[] = [];
    let sessionsClosed = false;
    let report: StressReport | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;

    const closeSessions = async (): Promise<void> => {
      if (sessionsClosed) return;
      sessionsClosed = true;
      for (const session of sessions) {
        try { await session.close(); }
        catch (error) { stopCleanup(error); }
      }
    };

    try {
      for (let workerId = 0; workerId < concurrency; workerId += 1) {
        if (stopped) break;
        try {
          sessions.push(await this.opts.createWorker(workerId));
        } catch (error) {
          stopPrimary(error);
          break;
        }
      }

      if (hasPrimaryError) {
        await closeSessions();
        throw primaryError;
      }

      // Only the interval between all sessions being ready and all worker loops ending
      // is the measurement window. Setup and teardown must not distort RPS.
      const startedAt = Date.now();
      const deadline = durationMs === undefined ? Number.POSITIVE_INFINITY : startedAt + durationMs;
      if (limiter && durationMs !== undefined) {
        const setDeadline: (handler: () => void, timeout: number) => NodeJS.Timeout = this.opts.setTimeout
          ? ((handler, timeout) => this.opts.setTimeout!(handler, timeout) as unknown as NodeJS.Timeout)
          : ((handler, timeout) => setTimeout(handler, timeout));
        deadlineTimer = setDeadline(() => limiter.stop(), Math.max(0, durationMs));
        deadlineTimer.unref?.();
      }
      let remaining = maxIterations;
      const worker = async (session: StressWorkerSession): Promise<void> => {
        while (!signal?.aborted && !stopped) {
          if (remaining !== undefined) {
            if (remaining <= 0) break;
            remaining -= 1;
          }
          if (Date.now() >= deadline) break;
          if (limiter && !await limiter.acquire(signal)) break;
          if (signal?.aborted || stopped) break;
          try {
            samples.push(sampleFromResult(await session.execute(signal)));
          } catch (error) {
            stopPrimary(error);
            break;
          }
        }
      };

      await Promise.all(sessions.map((session) => worker(session)));
      const finishedAt = Date.now();
      if (deadlineTimer !== undefined) {
        if (this.opts.clearTimeout) this.opts.clearTimeout(deadlineTimer);
        else clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
      await closeSessions();
      if (hasPrimaryError) throw primaryError;
      if (hasCleanupError) throw cleanupError;
      report = computeReport(samples, { concurrency, startedAt, finishedAt, thresholds: runOpts.thresholds });
      return report;
    } finally {
      limiter?.stop();
      if (deadlineTimer !== undefined) {
        if (this.opts.clearTimeout) this.opts.clearTimeout(deadlineTimer);
        else clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
      if (!sessionsClosed) await closeSessions();
      const generator = collector.stop();
      if (report) report.generator = generator;
    }
  }
}

import type { CaseExecutionResult } from "../runner/caseExecutor.js";
import { computeReport } from "./aggregate.js";
import { createGeneratorMetricsCollector, type GeneratorMetricsCollector, type GeneratorMetricsProbe } from "./generatorMetrics.js";
import type { StressReport, StressSample, StressThresholds } from "./model.js";
import type { StressWorkerSession } from "./caseSession.js";

type StressSetTimeout = (handler: () => void, timeout: number) => NodeJS.Timeout;
type StressClearTimeout = (timer: NodeJS.Timeout) => void;

export interface StressRunnerOptions {
  /** Creates one isolated virtual-user session for each concurrent worker. */
  createWorker: (workerId: number) => Promise<StressWorkerSession> | StressWorkerSession;
  /** Optional injectable generator collector used by deterministic tests. */
  createGeneratorCollector?: () => GeneratorMetricsCollector;
  /** Alias retained for callers that use the concrete collector name. */
  createGeneratorMetricsCollector?: () => GeneratorMetricsCollector;
  generatorMetricsProbe?: GeneratorMetricsProbe;
  now?: () => number;
  setTimeout?: StressSetTimeout;
  clearTimeout?: StressClearTimeout;
  /** Optional wire-protocol hook receiving each complete Task 4 sample. */
  onSample?: (sample: StressSample) => void;
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
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const MAX_TIMER_DELAY_MS = 2_147_000_000;

/** A shared sliding-window limiter. Waiting for a permit is not scheduler backlog. */
class SlidingWindowPermitLimiter {
  private readonly timestamps: number[] = [];
  private readonly waiters: PermitWaiter[] = [];
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private readonly capacity: number;
  private timerVersion = 0;
  private nextPermitAt: number | undefined;
  private lastClock = Number.NEGATIVE_INFINITY;
  private readonly reciprocalIntervalMs: number | undefined;
  private runtimeError: unknown;
  private hasRuntimeError = false;
  private stopError: unknown;
  private hasStopError = false;

  constructor(
    private readonly maxRps: number,
    private readonly now: () => number,
    private readonly setTimeoutFn: StressSetTimeout,
    private readonly clearTimeoutFn: StressClearTimeout,
  ) {
    this.capacity = Math.max(1, Math.floor(maxRps));
    if (maxRps < 1) {
      const interval = 1_000 / maxRps;
      this.reciprocalIntervalMs = Number.isFinite(interval) ? interval : Number.MAX_VALUE;
    }
  }

  private monotonicNow(): number {
    const observed = this.now();
    if (!Number.isFinite(observed)) return this.lastClock === Number.NEGATIVE_INFINITY ? 0 : this.lastClock;
    if (observed < this.lastClock) return this.lastClock;
    this.lastClock = observed;
    return observed;
  }

  acquire(signal?: AbortSignal): Promise<boolean> {
    if (this.hasRuntimeError) return Promise.reject(this.runtimeError);
    if (this.stopped || signal?.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve, reject) => {
      const waiter: PermitWaiter = { resolve, reject, signal };
      waiter.onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(false);
        try { this.process(); }
        catch (error) { this.failRuntime(error); }
      };
      if (signal) signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
      this.process();
    });
  }

  stop(): void {
    if (this.stopped) {
      if (this.hasStopError) throw this.stopError;
      if (this.hasRuntimeError) throw this.runtimeError;
      return;
    }
    this.stopped = true;
    let firstError: unknown;
    let hasError = false;
    if (this.timer !== undefined) {
      this.timerVersion += 1;
      try { this.clearTimeoutFn(this.timer); }
      catch (error) { hasError = true; firstError = error; }
    }
    this.timer = undefined;
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(false);
    }
    if (hasError) {
      this.stopError = firstError;
      this.hasStopError = true;
      throw firstError;
    }
  }

  private failRuntime(error: unknown): void {
    if (this.hasRuntimeError) return;
    this.runtimeError = error;
    this.hasRuntimeError = true;
    this.stopped = true;
    if (this.timer !== undefined) {
      this.timerVersion += 1;
      try { this.clearTimeoutFn(this.timer); } catch { /* preserve runtime error */ }
    }
    this.timer = undefined;
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(error);
    }
  }

  private process(): void {
    if (this.stopped) return;
    // Cancel the old wake-up before resolving any permit. A stale callback may
    // still be queued, but it cannot retain a live timer reference or race a
    // newly scheduled wake-up after this point.
    if (this.timer !== undefined) {
      const scheduledTimer = this.timer;
      this.timer = undefined;
      this.timerVersion += 1;
      try { this.clearTimeoutFn(scheduledTimer); }
      catch (error) {
        // A failed clear is retried once for hosts whose first clear reports an
        // error after releasing the native handle. The first error remains the
        // primary runtime failure either way.
        try { this.clearTimeoutFn(scheduledTimer); } catch { /* preserve first error */ }
        this.failRuntime(error);
        return;
      }
    }
    const current = this.monotonicNow();
    if (this.maxRps >= 1) {
      while (this.timestamps.length > 0 && current - this.timestamps[0]! >= 1_000) this.timestamps.shift();
    }
    // For rates below one request per second, a single permit is spaced by the
    // reciprocal rate. For ordinary rates, the timestamp window is the bound.
    while (this.waiters.length > 0) {
      const next = this.waiters[0]!;
      if (next.signal?.aborted) {
        this.waiters.shift();
        next.resolve(false);
        continue;
      }
      if (this.maxRps < 1 && this.nextPermitAt !== undefined && current < this.nextPermitAt) break;
      if (this.maxRps >= 1 && this.timestamps.length >= this.capacity) break;
      this.waiters.shift();
      if (next.signal && next.onAbort) next.signal.removeEventListener("abort", next.onAbort);
      if (this.maxRps < 1) this.nextPermitAt = current + this.reciprocalIntervalMs!;
      else this.timestamps.push(current);
      next.resolve(true);
    }
    if (this.waiters.length === 0) {
      if (this.timer !== undefined) this.clearTimeoutFn(this.timer);
      this.timer = undefined;
      return;
    }
    const oldest = this.maxRps < 1
      ? (this.nextPermitAt ?? current + this.reciprocalIntervalMs!)
      : (this.timestamps[0] ?? current) + 1_000;
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(1, oldest - current));
    const version = ++this.timerVersion;
    this.timer = this.setTimeoutFn(() => {
      if (version !== this.timerVersion) return;
      this.timer = undefined;
      try { this.process(); }
      catch (error) { this.failRuntime(error); }
    }, delay);
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

    const createCollector: () => GeneratorMetricsCollector = this.opts.createGeneratorCollector
      ?? this.opts.createGeneratorMetricsCollector
      ?? (() => createGeneratorMetricsCollector(this.opts.generatorMetricsProbe));
    const collector = createCollector();
    const limiter = maxRps === undefined
      ? undefined
      : new SlidingWindowPermitLimiter(
        maxRps,
        this.opts.now ?? (() => performance.now()),
        this.opts.setTimeout ?? ((handler, timeout) => setTimeout(handler, timeout)),
        this.opts.clearTimeout ?? ((timer) => clearTimeout(timer)),
      );

    const samples: StressSample[] = [];
    let stopped = false;
    let hasPrimaryError = false;
    let primaryError: unknown;
    let hasCleanupError = false;
    let cleanupError: unknown;
    let cleanupPriority = 0;
    const stopCleanup = (error: unknown, priority = 1): void => {
      stopped = true;
      if (!hasCleanupError || priority > cleanupPriority) {
        hasCleanupError = true;
        cleanupError = error;
        cleanupPriority = priority;
      }
    };
    const stopLimiter = (): void => {
      try { limiter?.stop(); }
      catch (error) { stopCleanup(error); }
    };
    const stopPrimary = (error: unknown): void => {
      stopped = true;
      stopLimiter();
      if (!hasPrimaryError) { hasPrimaryError = true; primaryError = error; }
    };

    const sessions: StressWorkerSession[] = [];
    let sessionsClosed = false;
    let report: StressReport | undefined;
    let deadlineTimer: NodeJS.Timeout | undefined;

    const clearDeadlineTimer = (): void => {
      if (deadlineTimer === undefined) return;
      const timer = deadlineTimer;
      deadlineTimer = undefined;
      try {
        if (this.opts.clearTimeout) this.opts.clearTimeout(timer);
        else clearTimeout(timer);
      } catch (error) { stopCleanup(error); }
    };

    const closeSessions = async (): Promise<void> => {
      if (sessionsClosed) return;
      sessionsClosed = true;
      for (const session of sessions) {
        try { await session.close(); }
        catch (error) { stopCleanup(error, 2); }
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
        const setDeadline: StressSetTimeout = this.opts.setTimeout
          ? ((handler, timeout) => this.opts.setTimeout!(handler, timeout))
          : ((handler, timeout) => setTimeout(handler, timeout));
        deadlineTimer = setDeadline(() => stopLimiter(), Math.max(0, durationMs));
      }
      let remaining = maxIterations;
      const worker = async (session: StressWorkerSession): Promise<void> => {
        while (!signal?.aborted && !stopped) {
          if (remaining !== undefined) {
            if (remaining <= 0) break;
            remaining -= 1;
          }
          if (Date.now() >= deadline) break;
          if (limiter) {
            try {
              if (!await limiter.acquire(signal)) break;
            } catch (error) {
              stopPrimary(error);
              break;
            }
          }
          if (signal?.aborted || stopped) break;
          try {
            const sample = sampleFromResult(await session.execute(signal));
            samples.push(sample);
            this.opts.onSample?.(sample);
          } catch (error) {
            stopPrimary(error);
            break;
          }
        }
      };

      await Promise.all(sessions.map((session) => worker(session)));
      const finishedAt = Date.now();
      await closeSessions();
      clearDeadlineTimer();
      if (hasPrimaryError) throw primaryError;
      if (hasCleanupError) throw cleanupError;
      report = computeReport(samples, { concurrency, startedAt, finishedAt, thresholds: runOpts.thresholds });
      if (samples.length === 0) {
        report.verdict = {
          passed: false,
          violations: [
            ...(report.verdict?.violations ?? []),
            { metric: "noData", actual: 0, expected: 1, message: "NO_DATA: 没有可评估的压测样本" },
          ],
        };
      }
      return report;
    } finally {
      if (!sessionsClosed) await closeSessions();
      stopLimiter();
      clearDeadlineTimer();
      try {
        const generator = collector.stop();
        if (report) report.generator = generator;
      } catch (error) { stopCleanup(error); }
      if (hasPrimaryError) throw primaryError;
      if (hasCleanupError) throw cleanupError;
    }
  }
}

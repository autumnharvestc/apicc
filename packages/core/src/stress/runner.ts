import type { CaseExecutionResult } from "../runner/caseExecutor.js";
import { computeReport } from "./aggregate.js";
import type { StressReport, StressSample } from "./model.js";
import type { StressWorkerSession } from "./caseSession.js";

export interface StressRunnerOptions {
  /** Creates one isolated virtual-user session for each concurrent worker. */
  createWorker: (workerId: number) => Promise<StressWorkerSession> | StressWorkerSession;
}
export interface StressRunOptions {
  concurrency: number;
  maxIterations?: number;
  durationMs?: number;
  /** Stops starting new iterations; the same signal is forwarded to the session. */
  signal?: AbortSignal;
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
    const { concurrency, maxIterations, durationMs, signal } = runOpts;
    if (maxIterations === undefined && durationMs === undefined) {
      throw new Error("压测终止条件缺失：maxIterations 与 durationMs 必须给其一");
    }
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error(`concurrency 必须为正整数，收到 ${concurrency}`);
    }

    const startedAt = Date.now();
    const deadline = durationMs === undefined ? Number.POSITIVE_INFINITY : startedAt + durationMs;
    let remaining = maxIterations;
    const samples: StressSample[] = [];
    let stopped = false;
    let hasPrimaryError = false;
    let primaryError: unknown;
    let hasCleanupError = false;
    let cleanupError: unknown;
    const stopPrimary = (error: unknown): void => {
      stopped = true;
      if (!hasPrimaryError) { hasPrimaryError = true; primaryError = error; }
    };
    const stopCleanup = (error: unknown): void => {
      stopped = true;
      if (!hasCleanupError) { hasCleanupError = true; cleanupError = error; }
    };

    const worker = async (workerId: number): Promise<void> => {
      let session: StressWorkerSession | undefined;
      try {
        if (stopped) return;
        session = await this.opts.createWorker(workerId);
        for (;;) {
          if (signal?.aborted || stopped) break;
          if (remaining !== undefined) {
            if (remaining <= 0) break;
            remaining -= 1;
          }
          if (Date.now() >= deadline) break;
          try {
            samples.push(sampleFromResult(await session.execute(signal)));
          } catch (error) {
            stopPrimary(error);
            break;
          }
        }
      } catch (error) {
        stopPrimary(error);
      } finally {
        if (session) {
          try { await session.close(); }
          catch (error) { stopCleanup(error); }
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, (_, workerId) => worker(workerId)));
    if (hasPrimaryError) throw primaryError;
    if (hasCleanupError) throw cleanupError;
    return computeReport(samples, { concurrency, startedAt, finishedAt: Date.now() });
  }
}

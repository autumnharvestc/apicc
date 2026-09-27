import type { CaseExecutionResult } from "../runner/caseExecutor.js";
import { computeReport } from "./aggregate.js";
import type { StressReport, StressSample } from "./model.js";
import type { StressWorkerSession } from "./caseSession.js";
import type { ExecutableRequest, ProtocolClient } from "../plugin/types.js";

export interface StressRunnerOptions {
  /** Creates one isolated virtual-user session for each concurrent worker. */
  createWorker?: (workerId: number) => Promise<StressWorkerSession> | StressWorkerSession;
  /** @deprecated Transitional adapter for callers not yet migrated to case sessions. */
  client?: ProtocolClient;
  /** @deprecated Transitional adapter for callers not yet migrated to case sessions. */
  buildRequest?: () => ExecutableRequest;
}
export interface StressRunOptions {
  concurrency: number;
  maxIterations?: number;
  durationMs?: number;
  /** Stops starting new iterations; the same signal is forwarded to the session. */
  signal?: AbortSignal;
}

const EXECUTE_OPTS = { connectTimeoutMs: 10_000, totalTimeoutMs: 30_000 };

function legacySession(client: ProtocolClient, buildRequest: () => ExecutableRequest): StressWorkerSession {
  return {
    async execute(signal) {
      const request = buildRequest();
      const started = performance.now();
      try {
        const response = await client.execute(request, { ...EXECUTE_OPTS, signal });
        const passed = (response.status >= 200 && response.status < 300) || response.status === 101;
        return {
          request, response, requestTimeMs: performance.now() - started, scriptTimeMs: 0,
          iterationTimeMs: performance.now() - started,
          outcome: { apiId: "", apiName: "", caseId: "", caseName: "", passed, durationMs: performance.now() - started, assertions: [], failureKind: passed ? undefined : "http" },
          failureKind: passed ? undefined : "http",
        };
      } catch (error) {
        return {
          request, requestTimeMs: performance.now() - started, scriptTimeMs: 0, iterationTimeMs: performance.now() - started,
          outcome: { apiId: "", apiName: "", caseId: "", caseName: "", passed: false, durationMs: performance.now() - started, assertions: [], error: errorMessage(error), failureKind: "transport" },
          failureKind: "transport",
        };
      }
    },
    async close() {},
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    outcome: { passed: result.outcome.passed, error, failureKind },
  };
}

function sampleFromError(error: unknown): StressSample {
  const message = errorMessage(error);
  return { timeMs: 0, requestTimeMs: 0, scriptTimeMs: 0, iterationTimeMs: 0, status: 0, ok: false, error: message, failureKind: "transport" };
}

/** Runs a bounded pool of virtual-user sessions with deterministic cleanup. */
export class StressRunner {
  private readonly createWorker: (workerId: number) => Promise<StressWorkerSession> | StressWorkerSession;

  constructor(private readonly opts: StressRunnerOptions) {
    if (opts.createWorker) this.createWorker = opts.createWorker;
    else if (opts.client && opts.buildRequest) this.createWorker = () => legacySession(opts.client!, opts.buildRequest!);
    else throw new Error("StressRunner 需要 createWorker session 工厂");
  }

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

    const worker = async (workerId: number): Promise<void> => {
      const session = await this.createWorker(workerId);
      try {
        for (;;) {
          if (signal?.aborted) break;
          if (remaining !== undefined) {
            if (remaining <= 0) break;
            remaining -= 1;
          }
          if (Date.now() >= deadline) break;
          try {
            samples.push(sampleFromResult(await session.execute(signal)));
          } catch (error) {
            samples.push(sampleFromError(error));
          }
        }
      } finally {
        await session.close();
      }
    };

    await Promise.all(Array.from({ length: concurrency }, (_, workerId) => worker(workerId)));
    return computeReport(samples, { concurrency, startedAt, finishedAt: Date.now() });
  }
}

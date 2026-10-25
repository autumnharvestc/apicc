import type { CaseExecutionResult } from "../runner/caseExecutor.js";
import { createGeneratorMetricsCollector, type GeneratorMetricsCollector, type GeneratorMetricsProbe } from "./generatorMetrics.js";
import type { StressReport, StressSafetyRun, StressSample, StressThresholds } from "./model.js";
import type { StressWorkerSession } from "./caseSession.js";
import { createExecutionEvidenceCollector, type EvidenceOutputBoundary } from "../report/evidence.js";
import type { EvidenceIdentity } from "../report/types.js";
import type { StressClock, StressRequestGate, StressExecutionDeps, StressMetricsSummary } from "./execution.js";
import type { StressMetricPlan, StressSchedule } from "./plan.js";
import { createStressAccumulator } from "./metrics.js";
import { createStressOriginAudit, createStressRequestGateWithAdmission } from "./requestGate.js";
import { runStressSchedule } from "./loadScheduler.js";
import { evaluateStressThresholds } from "./thresholds.js";

type StressSetTimeout = (handler: () => void, timeout: number) => NodeJS.Timeout;
type StressClearTimeout = (timer: NodeJS.Timeout) => void;
export interface StressRunnerOptions {
  runId?: string;
  onProgress?: StressExecutionDeps["onProgress"];
  evidenceIdentity?: EvidenceIdentity;
  evidenceMarkers?: readonly string[];
  createWorker: (workerId: number, context?: { readonly requestGate: StressRequestGate }) => Promise<StressWorkerSession> | StressWorkerSession;
  createGeneratorCollector?: () => GeneratorMetricsCollector;
  createGeneratorMetricsCollector?: () => GeneratorMetricsCollector;
  generatorMetricsProbe?: GeneratorMetricsProbe;
  now?: () => number;
  /** Native host clock shared by scheduler, request gate and local worker transport. */
  clock?: StressClock;
  setTimeout?: StressSetTimeout;
  clearTimeout?: StressClearTimeout;
  onSample?: (sample: StressSample) => void;
  onEvidenceMarkers?: (markers: readonly string[]) => void;
  onEvidenceOutputBoundary?: (boundary: EvidenceOutputBoundary) => void;
  finalizeEvidence?: (markers: readonly string[]) => Promise<readonly string[]>;
  /** Host-only v3 session substitution; legacy calls retain their original numeric range. */
  runSchedule?: (schedule: StressSchedule, deps: StressExecutionDeps) => Promise<StressMetricsSummary>;
  additionalFailureEvidence?: () => readonly import("../report/types.js").SafeExecutionEvidence[];
  distributed?: (summary: StressMetricsSummary) => import("./model.js").StressDistributed;
  richOutputComplete?: () => boolean;
  generatorOverride?: (coordinator: import("./model.js").StressGeneratorMetrics) => import("./model.js").StressGeneratorMetrics;
}
export interface StressRunOptions {
  concurrency: number; maxIterations?: number; durationMs?: number; signal?: AbortSignal;
  thresholds?: StressThresholds; maxRps?: number; connectionMode?: "pooled" | "fresh"; safetyRun?: Partial<StressSafetyRun>;
}
export function validateStressRunOptions(input: { concurrency: number; maxIterations?: number; durationMs?: number; maxRps?: number }): void {
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1) throw new Error(`concurrency 必须为正 safe integer，收到 ${input.concurrency}`);
  if (input.maxIterations !== undefined && (!Number.isSafeInteger(input.maxIterations) || input.maxIterations <= 0)) throw new Error(`maxIterations 必须为正 safe integer，收到 ${input.maxIterations}`);
  if (input.durationMs !== undefined && (!Number.isFinite(input.durationMs) || input.durationMs <= 0 || input.durationMs > Number.MAX_SAFE_INTEGER)) throw new Error(`durationMs 必须为有限正数且不可溢出，收到 ${input.durationMs}`);
  if (input.maxRps !== undefined && (!Number.isFinite(input.maxRps) || input.maxRps <= 0)) throw new Error(`maxRps 必须为正数，收到 ${input.maxRps}`);
}
/** Legacy parameters intentionally bypass the saved-plan UI limits. */
export const legacyStressMetricPlan: StressMetricPlan = {
  stableNodeKeys: [], histogram: { minValueMs: .001, gamma: 1.01, bucketCount: 4608, exactLimit: 256 },
  timeline: { initialBucketWidthMs: 1000, maxBuckets: 120 }, node: { maxKeys: 512, otherKey: "other" }, error: { maxKeys: 128, otherKey: "other" },
  evidence: { maxSamples: 20, bodyBytes: 65536, valueBytes: 4096, caseBytes: 262144, reportBytes: 16777216 }, memory: { maxNumericBytes: 67108864 },
};
function sampleFromResult(result: CaseExecutionResult): StressSample {
  return { timeMs: result.requestTimeMs, requestTimeMs: result.requestTimeMs, scriptTimeMs: result.scriptTimeMs, iterationTimeMs: result.iterationTimeMs,
    requestStarted: result.requestStarted, requestCompleted: result.requestCompleted, status: result.response?.status ?? 0, ok: result.outcome.passed,
    error: result.outcome.error, failureKind: result.failureKind ?? result.outcome.failureKind, outcome: result.outcome, safety: result.safety };
}
/** Separate whitelist: a missing marker participant forbids projecting any rich record. */
function numericFailureReport(report: StressReport): StressReport {
  const distributed = report.distributed;
  return { concurrency: report.concurrency, totalRequests: report.totalRequests, ok: report.ok, failed: report.failed, durationMs: report.durationMs,
    rps: report.rps, latency: { ...report.latency }, scriptLatency: report.scriptLatency && { ...report.scriptLatency }, iterationLatency: report.iterationLatency && { ...report.iterationLatency },
    statusDist: Object.fromEntries(Object.entries(report.statusDist).filter(([key]) => /^(0|[1-9][0-9]*)$/.test(key))), errorKinds: {},
    startedAt: report.startedAt, finishedAt: report.finishedAt, eligibleCompletedAttempts: report.eligibleCompletedAttempts, measurementWindow: report.measurementWindow && { ...report.measurementWindow },
    failures: report.failures && { ...report.failures }, eligibleFailureCounts: report.eligibleFailureCounts && { ...report.eligibleFailureCounts }, statistics: report.statistics && { ...report.statistics },
    incomplete: true, failureEvidence: [], verdict: { passed: false, violations: [
      { metric: "incomplete", actual: 1, expected: 0, message: "worker_incomplete_rich_output_withheld" },
      ...(!report.eligibleCompletedAttempts ? [{ metric: "noData" as const, actual: 0, expected: 1, message: "NO_DATA" }] : []),
    ] },
    generator: { availability: "unavailable", unavailableReason: "worker_incomplete_rich_output_withheld" },
    safety: { targetOrigins: [], availability: "unavailable", unavailableReason: "worker_incomplete_rich_output_withheld", run: report.safety?.run && { ...report.safety.run } },
    ...(distributed ? { distributed: { protocolVersion: 3, shards: distributed.shards, dataComplete: false, perShard: distributed.perShard.map((worker, i) => ({
      shardId: `worker-${i + 1}`, totalRequests: worker.totalRequests, ok: worker.ok, failed: worker.failed, rps: worker.rps,
      generator: { availability: "unavailable" as const, unavailableReason: "worker_incomplete_rich_output_withheld" }, measurementWindow: { ...worker.measurementWindow },
    })), shardErrors: Array.from({ length: distributed.shards }, (_, i) => ({ shardId: `worker-${i + 1}`, error: distributed.shardErrors?.some(e => e.shardId === `worker-${i + 1}` && e.error === "plugin_runtime_mismatch") ? "plugin_runtime_mismatch" : "worker_incomplete_rich_output_withheld" })) } } : {}),
  };
}
export class StressRunner {
  constructor(private readonly opts: StressRunnerOptions) {}
  async run(runOpts: StressRunOptions): Promise<StressReport> {
    if (runOpts.maxIterations === undefined && runOpts.durationMs === undefined) throw new Error("压测终止条件缺失：maxIterations 与 durationMs 必须给其一");
    validateStressRunOptions(runOpts);
    const collector = (this.opts.createGeneratorCollector ?? this.opts.createGeneratorMetricsCollector ?? (() => createGeneratorMetricsCollector(this.opts.generatorMetricsProbe)))();
    const evidence = createExecutionEvidenceCollector(this.opts.evidenceIdentity ?? { projectId: "", definitionRevision: "" }, this.opts.evidenceMarkers ?? [], { maxSamples: 20, privateMarkers: !!this.opts.finalizeEvidence });
    let primary: unknown, hasPrimary = false, cleanup: unknown, hasCleanup = false, cleanupPriority = 0;
    const primaryError = (error: unknown) => { if (!hasPrimary) { primary = error; hasPrimary = true; } };
    const cleanupError = (error: unknown, priority = 1) => { if (!hasCleanup || priority > cleanupPriority) { cleanup = error; hasCleanup = true; cleanupPriority = priority; } };
    const setTimer: StressSetTimeout = this.opts.setTimeout ?? ((handler, delay) => setTimeout(handler, delay));
    const clearTimer: StressClearTimeout = this.opts.clearTimeout ?? ((timer) => clearTimeout(timer));
    let lastNow = -Infinity;
    const clock: StressClock = this.opts.clock ?? { now: () => { const value = (this.opts.now ?? (() => performance.now()))(); if (Number.isFinite(value)) lastNow = Math.max(lastNow, value); return lastNow === -Infinity ? 0 : lastNow; }, wallNow: () => Date.now(),
      sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
        if (signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
        let timer: NodeJS.Timeout;
        const abort = () => { try { clearTimer(timer); } catch (error) { primaryError(error); try { clearTimer(timer); } catch {} reject(error); return; } reject(new DOMException("Aborted", "AbortError")); };
        try { timer = setTimer(() => { signal?.removeEventListener("abort", abort); resolve(); }, Math.min(2_147_000_000, Math.max(1, ms))); signal?.addEventListener("abort", abort, { once: true }); }
        catch (error) { primaryError(error); reject(error); }
      }) };
    const { gate, admission: opaqueAdmission } = createStressRequestGateWithAdmission({ clock, maxConcurrency: runOpts.concurrency, maxRps: runOpts.maxRps, authorizeRequest() {} });
    const audit = createStressOriginAudit(), errorKinds: Record<string, number> = {};
    const runId = this.opts.runId ?? globalThis.crypto.randomUUID();
    const metrics = createStressAccumulator(legacyStressMetricPlan, runId);
    const schedule: StressSchedule = { load: { kind: "constant-vus", vus: runOpts.concurrency }, durationMs: runOpts.durationMs ?? null, maxIterations: runOpts.maxIterations ?? null,
      // Legacy callbacks historically wait for all reserved iterations, including tiny-rate admission.
      maxVus: runOpts.concurrency, warmupMs: 0, thinkTimeMs: 0, pacingMs: 0, gracefulStopMs: Infinity, metricPlan: legacyStressMetricPlan,
      requested: { maxRequestConcurrency: runOpts.concurrency, maxRps: runOpts.maxRps ?? null }, effective: { maxRequestConcurrency: runOpts.concurrency, maxRps: runOpts.maxRps ?? null } };
    let report: StressReport | undefined; const thisRunner = this;
    try {
      const summary = await (this.opts.runSchedule ?? runStressSchedule)(schedule, { runId, clock, gate, metrics, evidence, onProgress: this.opts.onProgress, signal: runOpts.signal ?? new AbortController().signal, execution: { thresholds: runOpts.thresholds },
        createVu: async (id) => {
          let session: StressWorkerSession;
          try { session = await this.opts.createWorker(Number(id) - 1, { requestGate: gate }); } catch (error) { primaryError(error); throw error; }
          return { async execute(context) {
            let release: (() => void) | undefined;
            try {
              if (!session.gateManaged) {
                try { release = await opaqueAdmission.enter(context.admissionSignal ? AbortSignal.any([context.admissionSignal, context.signal]) : context.signal); }
                catch (error) { if (context.admissionSignal?.aborted || context.signal.aborted) return { state: "aborted", durationMs: 0 }; throw error; }
                if (context.admissionSignal?.aborted || context.signal.aborted) return { state: "aborted", durationMs: 0 };
              }
              const execution = await session.execute(session.gateManaged ? context.signal : runOpts.signal ?? context.signal);
              evidence.observe(execution, { rowIndex: execution.outcome.row, stressRunId: context.runId, vuId: context.vuId, iterationId: context.iterationId, stageId: context.stageId });
              const sample = sampleFromResult(execution);
              if (sample.safety) audit.recordTarget(sample.safety);
              const legacy = sample.requestStarted === undefined && sample.requestCompleted === undefined;
              const started = legacy || sample.requestStarted === true, completed = legacy || sample.requestCompleted === true;
              const kind = sample.ok ? null : sample.failureKind ?? (sample.status >= 400 ? "http" : sample.error ? "transport" : "assertion");
              context.observe?.({ kind: "case", ...context.observation!(), stageId: context.stageId, ok: sample.ok, status: sample.status,
                requestStarted: started, requestCompleted: completed, failureKind: kind, requestTimeMs: started ? sample.requestTimeMs ?? 0 : 0, scriptTimeMs: sample.scriptTimeMs ?? 0, iterationTimeMs: sample.iterationTimeMs ?? 0,
                locator: execution.outcome.locator ?? { collectionId: "", folderIds: [], apiId: execution.outcome.apiId ?? "", caseId: execution.outcome.caseId ?? "", scope: execution.outcome.scope ?? "base" }, nodeKey: null });
              const errorKey = sample.error ? sample.failureKind === "http" && sample.status !== 0 ? `HTTP_${sample.status}` : sample.failureKind ?? (sample.error.split(":", 1)[0]!.trim() || "unknown") : sample.status !== 101 && (sample.status < 200 || sample.status >= 300) ? `HTTP_${sample.status}` : undefined;
              if (errorKey) { const key = Object.hasOwn(errorKinds, errorKey) || Object.keys(errorKinds).length < 128 ? errorKey : "other"; errorKinds[key] = (errorKinds[key] ?? 0) + 1; }
              thisRunner.opts.onSample?.(sample);
              return { state: kind === "aborted" ? "aborted" : sample.ok ? "passed" : "failed", durationMs: execution.iterationTimeMs };
            } catch (error) { primaryError(error); throw error; } finally { release?.(); }
          }, async close() { try { await session.close(); } catch (error) { cleanupError(error, 2); throw error; } } };
        },
      });
      if (hasPrimary) throw primary; if (hasCleanup) throw cleanup;
      if (!summary.eligibleFailureCounts) throw new Error("Stress accumulator omitted eligible failure counts");
      const zero = { min: 0, avg: 0, max: 0, p50: 0, p90: 0, p95: 0, p99: 0 };
      const safety = audit.snapshot(); const gateAudit = gate.audit!();
      const uniqueTargets = [...safety.targetOrigins, ...gateAudit.targetOrigins].filter((target, index, all) => all.findIndex((candidate) => candidate.origin === target.origin) === index);
      const originOverflow = uniqueTargets.length > 256, targets = uniqueTargets.slice(0, 256);
      report = { concurrency: runOpts.concurrency, totalRequests: summary.totalRequests, ok: summary.ok, failed: summary.failed, durationMs: summary.durationMs,
        rps: summary.rps.availability === "available" ? summary.rps.value : 0, latency: summary.latency.availability === "available" ? { ...summary.latency.value } : zero,
        scriptLatency: summary.scriptLatency.availability === "available" ? { ...summary.scriptLatency.value } : zero, iterationLatency: summary.iterationLatency.availability === "available" ? { ...summary.iterationLatency.value } : zero,
        statusDist: { ...summary.statusDist }, errorKinds: this.opts.runSchedule ? { ...summary.errorKinds } : errorKinds, startedAt: summary.startedAt, finishedAt: summary.finishedAt, eligibleCompletedAttempts: summary.requests.eligibleCompleted,
        eligibleFailureCounts: { ...summary.eligibleFailureCounts }, failures: { ...summary.caseRows.failures }, statistics: { ...summary.statistics },
        measurementWindow: { startWallMs: summary.startedAt, endWallMs: summary.finishedAt, monotonicDurationMs: summary.durationMs, eligibleCompletedAttempts: summary.requests.eligibleCompleted },
        thresholds: runOpts.thresholds, connectionMode: runOpts.connectionMode,
        incomplete: originOverflow || safety.incomplete || gateAudit.incomplete || Object.values(summary.completeness).some((part) => !part.complete),
        safety: { targetOrigins: targets, availability: targets.length ? originOverflow || safety.incomplete || gateAudit.incomplete ? "partial" : "available" : "unavailable",
          ...(!targets.length ? { unavailableReason: "没有样本携带目标安全采集" } : {}), run: { requestedConcurrency: runOpts.safetyRun?.requestedConcurrency ?? runOpts.concurrency,
            effectiveConcurrency: runOpts.safetyRun?.effectiveConcurrency ?? runOpts.concurrency, requestedMaxRps: runOpts.safetyRun?.requestedMaxRps ?? runOpts.maxRps ?? null,
            effectiveMaxRps: runOpts.safetyRun?.effectiveMaxRps ?? runOpts.maxRps ?? null, connectionMode: runOpts.safetyRun?.connectionMode ?? runOpts.connectionMode ?? "pooled" } } };
      report.verdict = evaluateStressThresholds(report, runOpts.thresholds);
      if (this.opts.distributed) report.distributed = this.opts.distributed(summary);
      if (!this.opts.finalizeEvidence) {
        if (this.opts.richOutputComplete?.() === false) {
          report = numericFailureReport(report);
          return report;
        }
        report = evidence.projectStressReport(report);
        if (this.opts.additionalFailureEvidence) report = evidence.projectStressReport({ ...report, failureEvidence: [...(report.failureEvidence ?? []), ...this.opts.additionalFailureEvidence()].slice(0, 20) }, true);
        return report;
      }
    } finally {
      try { if (!this.opts.finalizeEvidence) this.opts.onEvidenceOutputBoundary?.(evidence.boundary()); this.opts.onEvidenceMarkers?.(evidence.markers()); } catch (error) { cleanupError(error); }
      try { const generator = collector.stop(); if (report) report.generator = this.opts.richOutputComplete?.() === false ? { availability: "unavailable", unavailableReason: "worker_incomplete_rich_output_withheld" } : this.opts.generatorOverride?.(generator) ?? generator; } catch (error) { cleanupError(error); }
      if (this.opts.finalizeEvidence) evidence.addMarkers(await this.opts.finalizeEvidence(evidence.markers()));
      if (hasPrimary) throw primary; if (hasCleanup) throw cleanup;
    }
    return evidence.projectStressReport(report!);
  }
}

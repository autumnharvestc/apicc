import { computeReport } from "@apicc/core";
import { StressPlanSchema, StressReportV2Schema } from "@apicc/core/schema";
export function stressV2Report() {
  const old = computeReport([{ requestStarted: true, requestCompleted: true, requestTimeMs: 10, status: 200, ok: true }], { concurrency: 1, startedAt: 0, finishedAt: 1000 });
  const target = { kind: "workflow", workflowId: "workflow" };
  const latency = { availability: "available", value: old.latency }, complete = { complete: true, reasons: [] };
  const caseRows = { total: 1, ok: 1, failed: 0, failures: old.failures }, requests = { started: 1, completed: 1, eligibleCompleted: 1, failed: 0 }, httpExchanges = { started: 1, completed: 1 };
  const rps = { availability: "available", value: 1 };
  return StressReportV2Schema.parse({ ...old, formatVersion: 2, runId: "10000000-0000-4000-8000-000000000001", projectId: "project", definitionRevision: "revision",
    plan: StressPlanSchema.parse({ formatVersion: 1, target, load: { kind: "constant-vus", vus: 1 }, termination: { maxIterations: 1 } }), target, environmentId: null,
    dataIdentity: { digest: null, datasetIds: [] }, rps, latency, scriptLatency: latency, iterationLatency: latency,
    verdict: { status: "passed", passed: true, violations: [] }, iterations: { planned: 1, started: 1, completed: 1, passed: 1, failed: 0, aborted: 0, dropped: 0, latency, startDelay: latency },
    caseRows, requests, httpExchanges, phases: [{ phase: "measurement", stageId: "rise", startOffsetMs: 0, endOffsetMs: 1000, durationMs: 1000, rps, latency, caseRows, requests, httpExchanges }], nodes: [], lifecycle: [],
    timeline: { bucketWidthMs: 1000, aligned: true, uncertaintyMs: 0, buckets: [{ startOffsetMs: 0, endOffsetMs: 1000, rps, latency, caseRows, requests, httpExchanges, sources: [{ phase: "measurement", stageId: "rise", caseRows, requests, httpExchanges }] }] },
    load: { plannedDurationMs: null, measurementDurationMs: 1000, drainDurationMs: 0, policyLimitedMs: 0, saturated: false, maxVus: 1, maxRequestConcurrency: 1, effectiveMaxRps: null },
    statistics: { method: "exact-nearest-rank", exact: true, relativeError: 0, minValueMs: 0.001, gamma: 1.01, bucketCount: 4608, exactLimit: 256, underflow: 0, overflow: 0 }, completeness: { execution: complete, metrics: complete, load: complete } });
}

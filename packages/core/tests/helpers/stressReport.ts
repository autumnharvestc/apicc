import { computeReport } from "../../src/stress/aggregate.js";
import { StressPlanSchema } from "../../src/stress/plan.js";
import { StressReportV2Schema } from "../../src/stress/reportV2.js";

export function stressReportFixture() {
  const old = computeReport([{ requestStarted: true, requestCompleted: true, requestTimeMs: 10, status: 200, ok: true }], { concurrency: 1, startedAt: 0, finishedAt: 1000 });
  const target = { kind: "workflow", workflowId: "flow<script>alert(1)</script>" };
  const latency = { availability: "available", value: old.latency };
  const complete = { complete: true, reasons: [] };
  return StressReportV2Schema.parse({ ...old, formatVersion: 2, runId: "run", projectId: "project", definitionRevision: "rev1",
    plan: StressPlanSchema.parse({ formatVersion: 1, target, load: { kind: "constant-vus", vus: 1 }, termination: { maxIterations: 1 } }),
    target, environmentId: null, dataIdentity: { digest: "data", datasetIds: [] }, rps: { availability: "available", value: 1 },
    latency, scriptLatency: latency, iterationLatency: latency, verdict: { status: "passed", passed: true, violations: [] },
    iterations: { planned: 1, started: 1, completed: 1, passed: 1, failed: 0, aborted: 0, dropped: 0, latency, startDelay: latency },
    caseRows: { total: 1, ok: 1, failed: 0, failures: old.failures }, requests: { started: 1, completed: 1, eligibleCompleted: 1, failed: 0 },
    httpExchanges: { started: 1, completed: 1 }, phases: [], nodes: [], lifecycle: [],
    timeline: { bucketWidthMs: 1000, aligned: true, uncertaintyMs: 0, buckets: [] },
    load: { plannedDurationMs: null, measurementDurationMs: 1000, drainDurationMs: 0, policyLimitedMs: 0, saturated: false, maxVus: 1, maxRequestConcurrency: 1, effectiveMaxRps: null },
    statistics: { method: "exact-nearest-rank", exact: true, relativeError: 0, minValueMs: 0.001, gamma: 1.01, bucketCount: 4608, exactLimit: 256, underflow: 0, overflow: 0 },
    completeness: { execution: complete, metrics: complete, load: complete } });
}

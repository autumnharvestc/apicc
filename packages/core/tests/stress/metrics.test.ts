import { describe, expect, it } from "vitest";
import { createStressAccumulator } from "../../src/stress/metrics.js";
import { StressHistogram } from "../../src/stress/histogram.js";
import type { StressFinishContext, StressMetricEvent } from "../../src/stress/execution.js";
import type { StressMetricPlan } from "../../src/stress/plan.js";
import { createExecutionEvidenceCollector } from "../../src/report/evidence.js";
import type { CaseExecutionResult } from "../../src/runner/caseExecutor.js";
import { StressPlanSchema } from "../../src/stress/plan.js";
import { StressPhaseSummarySchema, StressReportV2Schema } from "../../src/stress/reportV2.js";
import { createCredentialOutputSanitizer } from "../../src/credentials/output.js";
import { redactExecutionOutput } from "../../src/report/evidence.js";

const plan: StressMetricPlan = {
  stableNodeKeys: Array.from({ length: 512 }, (_, i) => ({ workflowId: "w", nodeId: `n${i}`, key: JSON.stringify(["w", `n${i}`]) })),
  histogram: { minValueMs: .001, gamma: 1.01, bucketCount: 4608, exactLimit: 256 }, timeline: { initialBucketWidthMs: 1000, maxBuckets: 120 },
  node: { maxKeys: 512, otherKey: "other" }, error: { maxKeys: 128, otherKey: "other" },
  evidence: { maxSamples: 20, bodyBytes: 65536, valueBytes: 4096, caseBytes: 262144, reportBytes: 16777216 }, memory: { maxNumericBytes: 67108864 },
};
const event = (extra: Partial<Extract<StressMetricEvent, { kind: "case" }>> = {}): StressMetricEvent => ({ kind: "case", phase: "measurement", stageId: null, atMs: 10,
  ok: true, status: 200, requestStarted: true, requestCompleted: true, failureKind: null, requestTimeMs: 10, scriptTimeMs: 3, iterationTimeMs: 13,
  locator: { collectionId: "c", folderIds: [], apiId: "a", caseId: "x", scope: "base" }, nodeKey: null, ...extra });
const ctx = (extra: Partial<StressFinishContext> = {}): StressFinishContext => ({ startedAt: 100, finishedAt: 999999, measurementStartOffsetMs: 0, measurementEndOffsetMs: 1000,
  stopReason: "duration", plannedIterations: 1, load: { plannedDurationMs: 1000, measurementDurationMs: 1000, drainDurationMs: 0, policyLimitedMs: 0, saturated: false, maxVus: 1, maxRequestConcurrency: 1 }, lifecycle: [],
  completeness: { execution: { complete: true, reasons: [] }, metrics: { complete: true, reasons: [] }, load: { complete: true, reasons: [] } },
  phaseWindows: [{ phase: "measurement", stageId: null, startOffsetMs: 0, endOffsetMs: 1000 }], ...extra });
const iteration = (acc: ReturnType<typeof createStressAccumulator>, phase: "measurement" | "warmup" = "measurement") => acc.observe({ kind: "iteration", phase, stageId: null, atMs: 20, started: 1, passed: 1, failed: 0, aborted: 0, dropped: 0, durationMs: 90, startDelayMs: 2 });

describe("bounded numeric stress metrics", () => {
  it("keeps exact nearest ranks at 256 and merges one million numbers without retaining them", () => {
    const tiny = new StressHistogram(); for (let i = 1; i <= 256; i++) tiny.add(i);
    expect(tiny.values().p95).toBe(244); expect(tiny.snapshot().exact).toHaveLength(256);
    const whole = new StressHistogram(), left = new StressHistogram(), right = new StressHistogram();
    for (let i = 0; i < 1_000_000; i++) { const value = i % 1000 + 1; whole.add(value); (i % 2 ? left : right).add(value); }
    left.merge(right.snapshot());
    expect(left.snapshot()).toEqual(whole.snapshot());
    expect(whole.snapshot().count).toBe(1_000_000); expect(whole.snapshot().exact).toBeNull(); expect(whole.snapshot().buckets).toHaveLength(4608);
    expect(whole.values().p95).toBeGreaterThanOrEqual(950); expect(whole.values().p95).toBeLessThanOrEqual(959.5);
    expect(whole.numericBytes).toBeLessThan(40000);
    const edges = new StressHistogram(); [0, .0001, 1e30].forEach((n) => edges.add(n));
    expect(edges.snapshot()).toMatchObject({ zero: 1, underflow: 1, overflow: 1 }); expect(edges.metric()).toEqual({ availability: "unavailable", reason: "overflow" });
    expect(() => edges.add(NaN)).toThrow();
  });
  it("keeps request qualification, case failures, hops, root iteration and warmup separate", () => {
    const acc = createStressAccumulator(plan, "run");
    acc.observe(event({ phase: "warmup", requestTimeMs: 999 })); iteration(acc, "warmup");
    acc.observe(event({ ok: false, status: 500, failureKind: "http" }));
    acc.observe(event({ ok: false, status: 0, failureKind: "config", requestStarted: false, requestCompleted: false, requestTimeMs: 0 }));
    acc.observe(event({ ok: false, status: 0, failureKind: "aborted", requestStarted: true, requestCompleted: false }));
    acc.observe(event({ phase: "drain", atMs: 1100 }));
    acc.observe({ kind: "http", phase: "measurement", stageId: null, atMs: 10, started: 3, completed: 2, nodeKey: null }); iteration(acc);
    expect(acc.snapshot().observations.caseRows.total).toBe(4);
    const summary = acc.finish(ctx({ measurementEndOffsetMs: 1200, phaseWindows: [...ctx().phaseWindows!, { phase: "warmup", stageId: null, startOffsetMs: 0, endOffsetMs: 100 }, { phase: "drain", stageId: null, startOffsetMs: 1000, endOffsetMs: 1200 }] }));
    expect(summary.requests).toEqual({ started: 3, completed: 2, eligibleCompleted: 2, failed: 1 });
    expect(summary.caseRows).toMatchObject({ total: 4, failed: 3, failures: { config: 1, http: 1, aborted: 1 } });
    expect(summary.httpExchanges).toEqual({ started: 3, completed: 2 }); expect(summary.iterations).toMatchObject({ started: 1, completed: 1, passed: 1 });
    expect(summary.rps).toEqual({ availability: "available", value: 2 / 1.2 }); expect(summary.latency).toMatchObject({ value: { p95: 10 } });
    expect(summary.iterationLatency).toMatchObject({ value: { p95: 13 } }); expect(summary.iterations.latency).toMatchObject({ value: { p95: 90 } });
    expect(summary.verdict.passed).toBe(false); // aborted request never becomes a normal pass
  });
  it("compacts 121 timeline slots, preselected 512 nodes and 129 statuses without dropping failures", () => {
    const acc = createStressAccumulator(plan, "run");
    for (let i = 0; i < 513; i++) { const key = JSON.stringify(["w", `n${i}`]); acc.observe(event({ atMs: i < 121 ? i * 1000 : 120000, status: 400 + i % 129, ok: false, failureKind: "http", nodeKey: key }));
      acc.observe({ kind: "node", phase: "measurement", stageId: null, atMs: 120000, nodeKey: key, state: "failed", durationMs: 20 }); }
    const snap = acc.snapshot(); expect(snap.observations.caseRows.total).toBe(513);
    expect(snap.timeline.bucketWidthMs).toBe(2000); expect(snap.timeline.buckets).toHaveLength(61); expect(snap.nodes).toHaveLength(513);
    expect(snap.nodes.find((n) => n.key === "other")).toMatchObject({ visits: 1, failed: 1 });
    expect(snap.observations.statusCounts).toHaveLength(129); expect(snap.observations.statusCounts.find((n) => n.key === "other")?.count).toBe(3);
    expect(snap.numericBytes).toBeLessThanOrEqual(67108864);
    const summary = acc.finish(ctx({ measurementEndOffsetMs: 120100, phaseWindows: [{ phase: "measurement", stageId: null, startOffsetMs: 0, endOffsetMs: 120100 }] }));
    expect(summary.timeline.buckets.at(-1)).toMatchObject({ startOffsetMs: 120000, endOffsetMs: 120100, rps: { availability: "available", value: 3930 } });
    expect(JSON.stringify(summary)).not.toContain('"buckets":[0'); expect(summary.nodes[0]).not.toHaveProperty("requestLatency.buckets");
  });
  it("merges only final observation snapshots once and preserves histogram ranks", () => {
    const worker = createStressAccumulator(plan, "run", { sourceId: "worker", scope: "observations" });
    for (let i = 0; i < 300; i++) worker.observe(event({ requestTimeMs: i + 1 }));
    const final = worker.snapshot(); expect(final.observations.caseRows.total).toBe(300); expect(final.iterations).toBeNull();
    const root = createStressAccumulator(plan, "run"); root.merge(final); iteration(root);
    expect(root.snapshot().observations.requestLatency).toEqual(final.observations.requestLatency);
    expect(() => root.merge(worker.snapshot())).toThrow(/snapshot-duplicate/);
    expect(root.snapshot().observations.caseRows.total).toBe(300); expect(root.finish(ctx()).completeness.metrics.reasons).toContain("snapshot-duplicate");
  });
  it("fails closed on invalid observations rather than silently losing numeric data", () => {
    const acc = createStressAccumulator(plan, "run"); acc.observe(event());
    expect(acc.snapshot().observations.caseRows.total).toBe(1);
    expect(() => acc.observe(event({ requestTimeMs: Infinity }))).toThrow(/snapshot-invalid/);
    expect(acc.snapshot().observations.caseRows.total).toBe(1); expect(acc.finish(ctx()).completeness.metrics.reasons).toContain("snapshot-invalid");
  });
  it("accepts recovered request failures but applies explicit request thresholds across worker merge", () => {
    const worker = createStressAccumulator(plan, "run", { sourceId: "worker", scope: "observations" });
    worker.observe(event({ ok: false, failureKind: "assertion" }));
    worker.observe(event({ ok: false, status: 0, failureKind: "config", requestStarted: false, requestCompleted: false, requestTimeMs: 0 }));
    const root = createStressAccumulator(plan, "run"); root.merge(worker.snapshot()); iteration(root);
    expect(root.finish(ctx()).verdict).toMatchObject({ passed: true, status: "passed" });
    for (let i = 0; i < 257; i++) root.observe({ kind: "node", phase: "measurement", stageId: null, atMs: 20, nodeKey: plan.stableNodeKeys[0]!.key, state: "passed", durationMs: i + 1 });
    expect(root.finish(ctx()).statistics.exact).toBe(false); // The only approximate series is a node latency.
    const evaluated = root.finish(ctx({ thresholds: { maxErrorRate: 0, maxAssertionFailureRate: 0 } }));
    expect(evaluated.verdict.violations.map((v) => [v.metric, v.actual])).toEqual([["errorRate", 1], ["assertionFailureRate", 1]]);
    expect(evaluated.eligibleFailureCounts).toMatchObject({ assertion: 1, config: 0, aborted: 0 });
    expect(() => worker.observe({ kind: "iteration", phase: "measurement", stageId: null, atMs: 20, started: 1, passed: 1, failed: 0, aborted: 0, dropped: 0, durationMs: 1, startDelayMs: 0 })).toThrow(/snapshot-invalid/);
  });
  it("rejects incompatible or corrupt final snapshots without accepting their counts", () => {
    const worker = createStressAccumulator(plan, "run", { sourceId: "worker", scope: "observations" }); worker.observe(event()); const valid = worker.snapshot();
    const root = createStressAccumulator(plan, "run");
    const wrongPlan = { ...valid, metricPlan: { ...plan, timeline: { ...plan.timeline, maxBuckets: 119 } } };
    expect(() => root.merge(wrongPlan as typeof valid)).toThrow(/snapshot-invalid/);
    const corrupt = structuredClone(valid); (corrupt.observations.eligibleFailureCounts as number[])[3] = 1;
    expect(() => root.merge(corrupt)).toThrow(/snapshot-invalid/);
    expect(root.snapshot().observations.caseRows.total).toBe(0);
    const extra = { ...valid, histogramVersion: 2 }; expect(() => root.merge(extra as unknown as typeof valid)).toThrow(/snapshot-invalid/);
  });
  it("merges different timeline resolutions and preserves all phase sources", () => {
    const a = createStressAccumulator(plan, "run", { sourceId: "a", scope: "observations" }), b = createStressAccumulator(plan, "run", { sourceId: "b", scope: "observations" });
    a.observe(event({ phase: "warmup", atMs: 0 })); a.observe(event({ atMs: 1000 })); b.observe(event({ phase: "drain", atMs: 120000 }));
    const root = createStressAccumulator(plan, "run"); root.merge(a.snapshot()); root.merge(b.snapshot());
    const s = root.snapshot(); expect(s.timeline.bucketWidthMs).toBe(2000); expect(s.observations.caseRows.total).toBe(2);
    expect(s.timeline.buckets[0]!.sources.map((v) => [v.phase, v.observations.caseRows.total])).toEqual([["warmup", 1], ["measurement", 1]]);
    expect(s.timeline.buckets[0]!.observations.caseRows.total).toBe(2);
  });
  it("preserves hop starts and completions when a live request crosses into drain", () => {
    const worker = createStressAccumulator(plan, "run", { sourceId: "worker", scope: "observations" });
    worker.observe({ kind: "http", phase: "measurement", stageId: null, atMs: 900, started: 1, completed: 0, nodeKey: null });
    worker.observe({ kind: "http", phase: "drain", stageId: null, atMs: 1100, started: 0, completed: 1, nodeKey: null }); worker.observe(event({ phase: "drain", atMs: 1100 }));
    const root = createStressAccumulator(plan, "run"); let mergeFailure: unknown; try { root.merge(worker.snapshot()); } catch (error) { mergeFailure = error; }
    expect(mergeFailure).toBeUndefined(); expect(root.snapshot().observations.httpExchanges).toEqual({ started: 1, completed: 1 });
    expect(root.snapshot().phases.find((p) => p.phase === "drain")?.observations.httpExchanges).toEqual({ started: 0, completed: 1 });
  });
  it("cannot pass with a missing measurement denominator", () => {
    const acc = createStressAccumulator(plan, "run"); acc.observe(event()); iteration(acc);
    const result = acc.finish(ctx({ measurementStartOffsetMs: null, measurementEndOffsetMs: null }));
    expect(result.verdict.passed).toBe(false); expect(result.completeness.metrics.complete).toBe(false);
  });
  it("rejects an iteration conclusion without an admitted iteration", () => {
    const invalid = createStressAccumulator(plan, "run");
    expect(() => invalid.observe({ kind: "iteration", phase: "measurement", stageId: null, atMs: 10, started: 0, passed: 1, failed: 0, aborted: 0, dropped: 0, durationMs: 1, startDelayMs: null })).toThrow(/snapshot-invalid/);
  });
  it("marks missing coverage, dropped slots and no data honestly and stops on dimension exhaustion", () => {
    const acc = createStressAccumulator(plan, "run"); acc.observe(event()); iteration(acc);
    const summary = acc.finish(ctx({ phaseWindows: undefined }));
    expect(summary.phases[0]).toMatchObject({ startOffsetMs: null, endOffsetMs: null, durationMs: null, rps: { availability: "unavailable", reason: "not-collected" } });
    expect(summary.completeness.metrics.reasons).toContain("phase-window-missing");
    expect(StressPhaseSummarySchema.safeParse({ ...summary.phases[0], startOffsetMs: 0 }).success).toBe(false);
    const dropped = createStressAccumulator(plan, "run"); dropped.observe(event()); iteration(dropped); dropped.observe({ kind: "iteration", phase: "measurement", stageId: null, atMs: 1, started: 0, passed: 0, failed: 0, aborted: 0, dropped: 1, durationMs: null, startDelayMs: null });
    expect(dropped.finish(ctx({ plannedIterations: 2 })).completeness.load).toEqual({ complete: false, reasons: ["dropped"] });
    expect(createStressAccumulator(plan, "run").finish(ctx()).verdict.status).toBe("no-data");
    const capacity = createStressAccumulator(plan, "run"); for (let i = 0; i < 69; i++) capacity.observe(event({ stageId: `stage-${i}` }));
    expect(() => capacity.observe(event({ stageId: "stage-70" }))).toThrow(/metrics-budget-exhausted/);
    const exhausted = capacity.finish(ctx({ phaseWindows: undefined }));
    expect(exhausted.latency).toEqual({ availability: "unavailable", reason: "budget-exhausted" });
    expect(exhausted.phases[0]!.latency).toEqual({ availability: "unavailable", reason: "budget-exhausted" });
    expect(exhausted.rps).toEqual({ availability: "unavailable", reason: "budget-exhausted" });
  });
  it("preserves known clock uncertainty and unaligned integrity through coarsening", () => {
    const acc = createStressAccumulator(plan, "run"); acc.observe(event()); iteration(acc);
    const result = acc.finish({ ...ctx(), timelineUncertaintyMs: 501 });
    expect(result.timeline).toMatchObject({ aligned: false, uncertaintyMs: 501 }); expect(result.completeness.metrics.reasons).toContain("timeline-unaligned");
    acc.observe(event({ atMs: 120000 }));
    expect(acc.finish({ ...ctx(), timelineUncertaintyMs: 501 }).timeline.aligned).toBe(false);
  });
  it("projects a valid v2 report through the safe boundary while preserving typed metadata", () => {
    const acc = createStressAccumulator(plan, "run"); acc.observe(event()); iteration(acc);
    const stressPlan = StressPlanSchema.parse({ formatVersion: 1, target: { kind: "workflow", workflowId: "http", inputs: { shared: "private-token" } }, load: { kind: "constant-vus", vus: 1 }, maxVus: 1, termination: { durationMs: 1000 } });
    const raw = { ...acc.finish(ctx()), formatVersion: 2, runId: "run", projectId: "p", definitionRevision: "r", concurrency: 1, plan: stressPlan, target: stressPlan.target, environmentId: null, dataIdentity: { digest: null, datasetIds: [] }, errorKinds: { "private-token": 1, http: 2, other: 3 }, safety: { targetOrigins: [{ origin: "https://private-token.test", confirmation: "confirmed", policy: "allowed" }] } };
    const report = StressReportV2Schema.parse(raw);
    // This assertion exercises the real projection before any reparse can hide a field loss.
    let safe: typeof report | undefined; let projectionFailure: unknown;
    try { safe = redactExecutionOutput(report, createCredentialOutputSanitizer(["private-token", "http", "run"])); } catch (error) { projectionFailure = error; }
    expect(projectionFailure).toBeUndefined(); expect(safe).toMatchObject({ formatVersion: 2, runId: "run", requests: { eligibleCompleted: 1 }, verdict: { passed: true }, target: { workflowId: "http" } });
    expect(JSON.stringify(safe)).not.toContain("private-token"); expect(StressReportV2Schema.safeParse(safe).success).toBe(true);
    const collector = createExecutionEvidenceCollector({ projectId: "p", definitionRevision: "r" }, ["private-token"]);
    let projected: unknown; try { projected = collector.projectStressReport(report); } catch { projected = null; }
    expect(projected).toMatchObject({ formatVersion: 2, runId: "run", errorKinds: { "[REDACTED]": 1, http: 2, other: 3 } });
  });
  it("omits optional v2 inputs when business text is unavailable", () => {
    const acc = createStressAccumulator(plan, "run"); acc.observe(event()); iteration(acc);
    const input = { shared: "not-registered-input" };
    const stressPlan = StressPlanSchema.parse({ formatVersion: 1, target: { kind: "workflow", workflowId: "w", inputs: input }, load: { kind: "constant-vus", vus: 1 }, maxVus: 1, termination: { durationMs: 1000 }, lifecycle: { setup: { workflowId: "s", inputs: input }, vuSetup: { workflowId: "vs", inputs: input }, vuTeardown: { workflowId: "vt", inputs: input }, teardown: { workflowId: "t", inputs: input } } });
    const report = StressReportV2Schema.parse({ ...acc.finish(ctx()), formatVersion: 2, runId: "run", projectId: "p", definitionRevision: "r", concurrency: 1, plan: stressPlan, target: stressPlan.target, environmentId: null, dataIdentity: { digest: null, datasetIds: [] } });
    const unavailable = { ...createCredentialOutputSanitizer([]), businessUnavailable: true, redactText: () => "[unavailable]" };
    const safe = redactExecutionOutput(report, unavailable);
    expect(safe.target).not.toHaveProperty("inputs"); expect(safe.plan.target).not.toHaveProperty("inputs");
    for (const step of Object.values(safe.plan.lifecycle!)) expect(step).not.toHaveProperty("inputs");
    expect(safe.target).toMatchObject({ kind: "workflow", workflowId: "w" }); expect(JSON.stringify(safe)).not.toContain("not-registered-input");
    expect(StressReportV2Schema.safeParse(safe).success).toBe(true);
  });
  it("rejects a final snapshot missing a nonempty timeline bucket before adding observations", () => {
    const worker = createStressAccumulator(plan, "run", { sourceId: "worker", scope: "observations" });
    worker.observe(event()); worker.observe(event({ phase: "warmup", atMs: 1100, requestTimeMs: 20 }));
    const snapshot = worker.snapshot(); const corrupt = { ...snapshot, timeline: { ...snapshot.timeline, buckets: snapshot.timeline.buckets.slice(1) } };
    const root = createStressAccumulator(plan, "run");
    expect(() => root.merge(corrupt)).toThrow(/snapshot-invalid/); expect(root.snapshot().observations.caseRows.total).toBe(0);
    expect(root.snapshot().incompleteReasons).toContain("snapshot-invalid");
  });
  it("rejects impossible approximate histogram scalars while accepting fractional edge distributions", () => {
    const worker = createStressAccumulator(plan, "run", { sourceId: "worker", scope: "observations" }); for (let i = 0; i < 300; i++) worker.observe(event());
    const snapshot = worker.snapshot(); const corrupt = { ...snapshot, observations: { ...snapshot.observations, requestLatency: { ...snapshot.observations.requestLatency, sum: 0 } } };
    const root = createStressAccumulator(plan, "run");
    expect(() => root.merge(corrupt)).toThrow(/snapshot-invalid/); expect(root.snapshot().observations.caseRows.total).toBe(0);
    const fractional = new StressHistogram(); for (let i = 0; i < 300; i++) fractional.add([0, .0001, .1, .2, 1e18][i % 5]!);
    expect(StressHistogram.valid(fractional.snapshot())).toBe(true);
    const oneOutlier = new StressHistogram(); for (let i = 0; i < 300; i++) oneOutlier.add(i === 299 ? 1e18 : 0);
    expect(StressHistogram.valid({ ...oneOutlier.snapshot(), sum: 1e17 })).toBe(false); // The observed max must contribute at least once.
  });
  it("matches duplicate case rows by VU and iteration identity when projections reorder rows", () => {
    const base = { projectId: "p", definitionRevision: "r", stressRunId: "run" }, collector = createExecutionEvidenceCollector(base, [], { mode: "all" });
    const raw: CaseExecutionResult = { outcome: { apiId: "a", apiName: "a", caseId: "c", caseName: "c", passed: false, durationMs: 1, assertions: [] }, request: { protocol: "http", method: "GET", url: "https://example.test", headers: {}, query: [], auth: { kind: "none" } }, response: { status: 500, headers: {}, bodyText: "first", timeMs: 1 }, requestTimeMs: 1, scriptTimeMs: 0, iterationTimeMs: 1 };
    const first = { ...base, vuId: "v1", iterationId: "i1" }, second = { ...base, vuId: "v2", iterationId: "i2" };
    collector.observe(raw, first); collector.observe({ ...raw, response: { ...raw.response!, bodyText: "second" } }, second);
    const rows = [second, first].map((identity) => ({ ...raw.outcome, evidence: { identity, state: "not-collected" as const, truncated: false, scriptDiagnostics: "not-collected" as const } }));
    const safe = collector.projectRun({ collectionId: "c", collectionName: "c", startedAt: "", finishedAt: "", total: 2, passed: 0, failed: 2, cases: rows });
    expect(safe.cases.map((row) => row.evidence?.response?.body.text)).toEqual(["second", "first"]);
    expect(safe.cases[0]!.evidence!.identity).toMatchObject(second);
  });
});

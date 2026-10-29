import { z } from "zod";
import type { StressAccumulator, StressAggregateSnapshot, StressFinishContext, StressMetricEvent, StressObservationCounts, StressMetricsSummary, StressHistogramSnapshot } from "./execution.js";
import type { StressMetricPlan, StressPhase } from "./plan.js";
import { StressMetricBudgetsSchema } from "./plan.js";
import { StressHistogram, summarizeStressHistogramStatistics } from "./histogram.js";
import { STRESS_FAILURE_KINDS, type StressFailureCounts } from "./model.js";
import { evaluateStressMetricsThresholds } from "./thresholds.js";
import { StressCompletenessReasonSchema, StressPhaseSchema, type StressCompletenessReason, type StressLatencyMetric } from "./reportV2.js";

export interface StressAccumulatorOptions { sourceId: string; scope?: "all" | "observations"; reservedNumericBytes?: number }
/** Catch on the metrics side channel: this must never change a business assertion. */
export class StressMetricsError extends Error {
  constructor(readonly code: StressCompletenessReason) { super(code); this.name = "StressMetricsError"; }
}
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), ms = z.number().finite().nonnegative();
const distribution = z.array(z.object({ key: z.string(), count }).strict()).max(129).refine((v) => new Set(v.map((n) => n.key)).size === v.length);
const httpErrorKey = (key: string) => /^HTTP_[1-9][0-9]*$/.test(key) && Number.isSafeInteger(Number(key.slice(5)));
const countsSchema = z.object({ caseRows: z.object({ total: count, ok: count, failed: count, failures: z.array(count).length(7) }).strict(), eligibleFailureCounts: z.array(count).length(7),
  requests: z.object({ started: count, completed: count, eligibleCompleted: count, failed: count }).strict(), httpExchanges: z.object({ started: count, completed: count }).strict(), statusCounts: distribution, errorCounts: distribution,
}).strict().refine((v) => v.caseRows.total === v.caseRows.ok + v.caseRows.failed && v.caseRows.failures.reduce((a, b) => a + b, 0) === v.caseRows.failed
  && v.requests.completed <= v.requests.started && v.requests.eligibleCompleted <= v.requests.completed && v.requests.failed <= v.requests.eligibleCompleted
  && v.eligibleFailureCounts.reduce((a, b) => a + b, 0) === v.requests.failed && v.eligibleFailureCounts[6] === 0 && v.eligibleFailureCounts.every((n, i) => n <= v.caseRows.failures[i])
  && v.statusCounts.filter((entry) => entry.key !== "other").length <= 128 && v.statusCounts.every((entry) => entry.key === "other" || /^(0|[1-9][0-9]*)$/.test(entry.key))
  && v.errorCounts.filter((entry) => entry.key !== "other").length <= 128 && v.errorCounts.every((entry) => entry.key === "other" || STRESS_FAILURE_KINDS.some((kind) => kind === entry.key) || httpErrorKey(entry.key)));
const histogramSchema = z.object({ count, sum: ms, min: ms.nullable(), max: ms.nullable(), zero: count, underflow: count, overflow: count,
  exact: z.array(ms).max(256).nullable(), buckets: z.array(count).max(4608) }).strict().refine(StressHistogram.valid);
const observationSchema = countsSchema.safeExtend({ requestLatency: histogramSchema, scriptLatency: histogramSchema, caseLatency: histogramSchema });
const sourceSchema = z.object({ phase: StressPhaseSchema, stageId: z.string().nullable(), observations: countsSchema }).strict();
const phaseSchema = sourceSchema.extend({ requestLatency: histogramSchema, firstObservedOffsetMs: ms.nullable(), lastObservedOffsetMs: ms.nullable() });
const bucketSchema = z.object({ startOffsetMs: ms, observations: countsSchema, requestLatency: histogramSchema, sources: z.array(sourceSchema).max(69) }).strict();
const nodeSchema = z.object({ key: z.string(), visits: count, passed: count, failed: count, aborted: count, skipped: count, observations: countsSchema, requestLatency: histogramSchema, nodeLatency: histogramSchema }).strict();
const iterationSchema = z.object({ planned: count, started: count, passed: count, failed: count, aborted: count, dropped: count, latency: histogramSchema, startDelay: histogramSchema }).strict();
const snapshotSchema = z.object({ formatVersion: z.literal(1), histogramVersion: z.literal(1), runId: z.string().min(1), sourceId: z.string().min(1), sequence: count.positive(), scope: z.enum(["all", "observations"]),
  metricPlan: z.unknown(), observations: observationSchema, iterations: iterationSchema.nullable(), phases: z.array(phaseSchema).max(69), timeline: z.object({ bucketWidthMs: ms.min(1000), buckets: z.array(bucketSchema).max(120) }).strict(),
  nodes: z.array(nodeSchema).max(513), numericBytes: count, incompleteReasons: z.array(StressCompletenessReasonSchema).max(32) }).strict();
type Counts = { caseRows: { total: number; ok: number; failed: number; failures: number[] }; eligibleFailureCounts: number[]; requests: { started: number; completed: number; eligibleCompleted: number; failed: number }; httpExchanges: { started: number; completed: number }; statusCounts: Map<string, number>; errorCounts: Map<string, number> };
type Phase = { phase: StressPhase; stageId: string | null; observations: Counts; requestLatency: StressHistogram; firstObservedOffsetMs: number | null; lastObservedOffsetMs: number | null };
type Bucket = { startOffsetMs: number; observations: Counts; requestLatency: StressHistogram; sources: Map<string, { phase: StressPhase; stageId: string | null; observations: Counts }> };
type Node = { key: string; visits: number; passed: number; failed: number; aborted: number; skipped: number; observations: Counts; requestLatency: StressHistogram; nodeLatency: StressHistogram };
const formal = (phase: StressPhase) => phase === "measurement" || phase === "drain";
const keyFor = (phase: StressPhase, stageId: string | null) => JSON.stringify([phase, stageId]);
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
const failureObject = (values: readonly number[]): Required<StressFailureCounts> => Object.fromEntries(STRESS_FAILURE_KINDS.map((kind, i) => [kind, values[i]])) as Required<StressFailureCounts>;
const publicCounts = (v: Counts) => ({ caseRows: { total: v.caseRows.total, ok: v.caseRows.ok, failed: v.caseRows.failed, failures: failureObject(v.caseRows.failures) }, requests: { ...v.requests }, httpExchanges: { ...v.httpExchanges } });
const rate = (n: number, durationMs: number) => n > 0 && durationMs > 0 ? { availability: "available" as const, value: n * 1000 / durationMs } : { availability: "unavailable" as const, reason: "no-data" as const };

export function createStressAccumulator(input: StressMetricPlan, runId: string, options?: StressAccumulatorOptions): StressAccumulator {
  const plan = structuredClone(input), sourceId = options?.sourceId ?? "coordinator", scope = options?.scope ?? "all", config = canonical(plan);
  if (!runId || !sourceId || !["all", "observations"].includes(scope) || plan.stableNodeKeys.length > 512 || new Set(plan.stableNodeKeys.map((n) => n.key)).size !== plan.stableNodeKeys.length || plan.stableNodeKeys.some((n) => n.key !== JSON.stringify([n.workflowId, n.nodeId]))
    || canonical(plan.histogram) !== canonical({ minValueMs: .001, gamma: 1.01, bucketCount: 4608, exactLimit: 256 }) || canonical(plan.timeline) !== canonical({ initialBucketWidthMs: 1000, maxBuckets: 120 }) || canonical(plan.node) !== canonical({ maxKeys: 512, otherKey: "other" }) || canonical(plan.error) !== canonical({ maxKeys: 128, otherKey: "other" })
    || !StressMetricBudgetsSchema.safeParse({ memory: plan.memory, evidence: plan.evidence }).success) throw new StressMetricsError("snapshot-invalid");
  const reserved = options?.reservedNumericBytes ?? 0;
  if (!Number.isSafeInteger(reserved) || reserved < 0 || reserved >= plan.memory.maxNumericBytes) throw new StressMetricsError("metrics-budget-exhausted");
  const reasons = new Set<StressCompletenessReason>(); let bytes = 256 + reserved, sequence = 0;
  const fail = (code: StressCompletenessReason): never => { reasons.add(code); throw new StressMetricsError(code); };
  const reserve = (n: number) => { if (!Number.isSafeInteger(bytes + n) || bytes + n > plan.memory.maxNumericBytes) fail("metrics-budget-exhausted"); bytes += n; };
  const liveHistograms = new Set<StressHistogram>();
  const hist = () => { reserve(64); const value = new StressHistogram(); liveHistograms.add(value); return value; };
  const freshCounts = (): Counts => { reserve(184); return { caseRows: { total: 0, ok: 0, failed: 0, failures: [0, 0, 0, 0, 0, 0, 0] }, eligibleFailureCounts: [0, 0, 0, 0, 0, 0, 0], requests: { started: 0, completed: 0, eligibleCompleted: 0, failed: 0 }, httpExchanges: { started: 0, completed: 0 }, statusCounts: new Map(), errorCounts: new Map() }; };
  const observation = { ...freshCounts(), requestLatency: hist(), scriptLatency: hist(), caseLatency: hist() };
  const iterations = { planned: 0, started: 0, passed: 0, failed: 0, aborted: 0, dropped: 0, latency: hist(), startDelay: hist() };
  const phases = new Map<string, Phase>(), buckets = new Map<number, Bucket>(), nodes = new Map<string, Node>();
  const nodeKeys = new Map(plan.stableNodeKeys.map((n) => [n.key, n])); const sources = new Set<string>(); let width = 1000;
  const safeAdd = (a: number, b: number) => { const n = a + b; if (!Number.isSafeInteger(n) || n < 0) fail("snapshot-invalid"); return n; };
  const histogramChange = (h: StressHistogram, change: () => void) => {
    reserve(4608 * 8); const before = h.numericBytes;
    try { change(); } catch { bytes -= 4608 * 8; fail("snapshot-invalid"); }
    bytes += h.numericBytes - before - 4608 * 8;
    if (h.statistics().overflow) reasons.add("histogram-overflow");
  };
  const add = (h: StressHistogram, n: number) => histogramChange(h, () => h.add(n));
  const mergeHist = (h: StressHistogram, s: StressHistogramSnapshot) => histogramChange(h, () => h.merge(s));
  const bump = (map: Map<string, number>, key: string, n = 1) => {
    const selected = map.has(key) || (key !== "other" && map.size - Number(map.has("other")) < 128) ? key : "other";
    if (!map.has(selected)) reserve(8); map.set(selected, safeAdd(map.get(selected) ?? 0, n));
  };
  const snapCounts = (v: Counts): StressObservationCounts => ({ caseRows: { ...v.caseRows, failures: [...v.caseRows.failures] }, eligibleFailureCounts: [...v.eligibleFailureCounts], requests: { ...v.requests }, httpExchanges: { ...v.httpExchanges }, statusCounts: [...v.statusCounts].map(([key, count]) => ({ key, count })), errorCounts: [...v.errorCounts].map(([key, count]) => ({ key, count })) });
  const mergeCounts = (to: Counts, from: StressObservationCounts) => {
    for (const k of ["total", "ok", "failed"] as const) to.caseRows[k] = safeAdd(to.caseRows[k], from.caseRows[k]);
    from.caseRows.failures.forEach((n, i) => { to.caseRows.failures[i] = safeAdd(to.caseRows.failures[i], n); to.eligibleFailureCounts[i] = safeAdd(to.eligibleFailureCounts[i], from.eligibleFailureCounts[i]); });
    for (const k of ["started", "completed", "eligibleCompleted", "failed"] as const) to.requests[k] = safeAdd(to.requests[k], from.requests[k]);
    for (const k of ["started", "completed"] as const) to.httpExchanges[k] = safeAdd(to.httpExchanges[k], from.httpExchanges[k]);
    from.statusCounts.forEach((v) => bump(to.statusCounts, v.key, v.count)); from.errorCounts.forEach((v) => bump(to.errorCounts, v.key, v.count));
  };
  const freshPhase = (phase: StressPhase, stageId: string | null): Phase => {
    const key = keyFor(phase, stageId); let value = phases.get(key);
    if (!value) { if (phases.size >= 69) fail("metrics-budget-exhausted"); reserve(16); value = { phase, stageId, observations: freshCounts(), requestLatency: hist(), firstObservedOffsetMs: null, lastObservedOffsetMs: null }; phases.set(key, value); } return value;
  };
  const freshBucket = (startOffsetMs: number): Bucket => {
    let value = buckets.get(startOffsetMs); if (!value) { reserve(8); value = { startOffsetMs, observations: freshCounts(), requestLatency: hist(), sources: new Map() }; buckets.set(startOffsetMs, value); } return value;
  };
  const source = (b: Bucket, phase: StressPhase, stageId: string | null) => {
    const key = keyFor(phase, stageId); let value = b.sources.get(key); if (!value) { if (b.sources.size >= 69) fail("metrics-budget-exhausted"); value = { phase, stageId, observations: freshCounts() }; b.sources.set(key, value); } return value;
  };
  const countsBytes = (v: StressObservationCounts) => 184 + 8 * (v.statusCounts.length + v.errorCounts.length);
  const coarsen = () => {
    width *= 2; const old = [...buckets.values()]; buckets.clear();
    for (const b of old) { const start = Math.floor(b.startOffsetMs / width) * width, existing = buckets.get(start);
      if (!existing) { b.startOffsetMs = start; buckets.set(start, b); continue; }
      mergeCounts(existing.observations, snapCounts(b.observations)); mergeHist(existing.requestLatency, b.requestLatency.snapshot());
      for (const s of b.sources.values()) { mergeCounts(source(existing, s.phase, s.stageId).observations, snapCounts(s.observations)); bytes -= countsBytes(snapCounts(s.observations)); }
      bytes -= 8 + countsBytes(snapCounts(b.observations)) + b.requestLatency.numericBytes;
      liveHistograms.delete(b.requestLatency);
    }
  };
  const timelineAt = (atMs: number): Bucket => { while (Math.floor(atMs / width) >= 120) coarsen(); return freshBucket(Math.floor(atMs / width) * width); };
  const node = (key: string): Node => {
    key = nodeKeys.has(key) ? key : "other"; let value = nodes.get(key);
    if (!value) { reserve(40); value = { key, visits: 0, passed: 0, failed: 0, aborted: 0, skipped: 0, observations: freshCounts(), requestLatency: hist(), nodeLatency: hist() }; nodes.set(key, value); } return value;
  };
  const eligible = (e: StressMetricEvent): e is Extract<StressMetricEvent, { kind: "case" }> => e.kind === "case" && e.requestStarted && e.requestCompleted && e.failureKind !== "aborted";
  const applyCounts = (v: Counts, event: StressMetricEvent, distributions = false) => {
    if (event.kind === "case") {
      const row = v.caseRows; row.total = safeAdd(row.total, 1); row[event.ok ? "ok" : "failed"] = safeAdd(row[event.ok ? "ok" : "failed"], 1);
      if (event.failureKind) row.failures[STRESS_FAILURE_KINDS.indexOf(event.failureKind)]++;
      if (event.requestStarted) v.requests.started = safeAdd(v.requests.started, 1); if (event.requestCompleted) v.requests.completed = safeAdd(v.requests.completed, 1);
      if (eligible(event)) { v.requests.eligibleCompleted = safeAdd(v.requests.eligibleCompleted, 1); if (!event.ok) { v.requests.failed = safeAdd(v.requests.failed, 1); v.eligibleFailureCounts[STRESS_FAILURE_KINDS.indexOf(event.failureKind!)]++; } if (distributions && event.status !== 0) bump(v.statusCounts, String(event.status)); }
      if (distributions && event.failureKind) bump(v.errorCounts, event.failureKind === "http" && event.status !== 0 ? `HTTP_${event.status}` : event.failureKind);
    } else if (event.kind === "http") { v.httpExchanges.started = safeAdd(v.httpExchanges.started, event.started); v.httpExchanges.completed = safeAdd(v.httpExchanges.completed, event.completed); }
  };
  const observe = (event: StressMetricEvent): void => {
    if (reasons.has("snapshot-invalid") || reasons.has("metrics-budget-exhausted")) fail("snapshot-invalid");
    if (!event || !StressPhaseSchema.safeParse(event.phase).success || !Number.isFinite(event.atMs) || event.atMs < 0 || (event.stageId !== null && typeof event.stageId !== "string") || (!formal(event.phase) && event.stageId !== null)) fail("snapshot-invalid");
    const validNumber = (n: number) => Number.isFinite(n) && n >= 0;
    if (event.kind === "case") {
      if (![event.requestTimeMs, event.scriptTimeMs, event.iterationTimeMs].every(validNumber) || !Number.isSafeInteger(event.status) || event.status < 0 || typeof event.ok !== "boolean" || typeof event.requestStarted !== "boolean" || typeof event.requestCompleted !== "boolean"
        || (event.ok ? event.failureKind !== null : !STRESS_FAILURE_KINDS.includes(event.failureKind!)) || (event.requestCompleted && !event.requestStarted) || (!event.requestStarted && event.requestTimeMs !== 0) || (event.nodeKey !== null && typeof event.nodeKey !== "string")) fail("snapshot-invalid");
    } else if (event.kind === "http") {
      if (![event.started, event.completed].every((n) => Number.isSafeInteger(n) && n >= 0) || (event.nodeKey !== null && typeof event.nodeKey !== "string")) fail("snapshot-invalid");
    } else if (event.kind === "node") {
      if (!validNumber(event.durationMs) || typeof event.nodeKey !== "string" || !["passed", "failed", "aborted", "skipped", "noop"].includes(event.state)) fail("snapshot-invalid");
    } else if (event.kind === "iteration") {
      if (scope === "observations" || ![event.started, event.passed, event.failed, event.aborted, event.dropped].every((n) => Number.isSafeInteger(n) && n >= 0) || (event.durationMs !== null && !validNumber(event.durationMs)) || (event.startDelayMs !== null && !validNumber(event.startDelayMs))) fail("snapshot-invalid");
      if (formal(event.phase)) {
        const terminal = event.passed + event.failed + event.aborted;
        if (terminal > 1 || event.started > 1 || (event.durationMs !== null && terminal !== 1) || (event.startDelayMs !== null && event.started !== 1) || iterations.passed + iterations.failed + iterations.aborted + terminal > iterations.started + event.started) fail("snapshot-invalid");
        for (const k of ["started", "passed", "failed", "aborted", "dropped"] as const) iterations[k] = safeAdd(iterations[k], event[k]);
        iterations.planned = safeAdd(iterations.started, iterations.dropped); if (event.durationMs !== null) add(iterations.latency, event.durationMs); if (event.startDelayMs !== null) add(iterations.startDelay, event.startDelayMs);
      } return;
    } else fail("snapshot-invalid");
    const phase = freshPhase(event.phase, event.stageId); phase.firstObservedOffsetMs = Math.min(phase.firstObservedOffsetMs ?? event.atMs, event.atMs); phase.lastObservedOffsetMs = Math.max(phase.lastObservedOffsetMs ?? event.atMs, event.atMs);
    applyCounts(phase.observations, event); if (eligible(event)) add(phase.requestLatency, event.requestTimeMs);
    if (event.kind !== "node") { const bucket = timelineAt(event.atMs); applyCounts(bucket.observations, event); applyCounts(source(bucket, event.phase, event.stageId).observations, event); if (eligible(event)) add(bucket.requestLatency, event.requestTimeMs); }
    if (!formal(event.phase)) return;
    applyCounts(observation, event, true);
    if (event.kind === "case") { if (eligible(event)) add(observation.requestLatency, event.requestTimeMs); add(observation.scriptLatency, event.scriptTimeMs); add(observation.caseLatency, event.iterationTimeMs); }
    if (event.kind === "node" || event.nodeKey !== null) { const item = node(event.nodeKey!); applyCounts(item.observations, event); if (eligible(event)) add(item.requestLatency, event.requestTimeMs); if (event.kind === "node") { item.visits = safeAdd(item.visits, 1); if (event.state !== "noop") item[event.state] = safeAdd(item[event.state], 1); add(item.nodeLatency, event.durationMs); } }
  };
  const snapshot = (): StressAggregateSnapshot => ({ formatVersion: 1, histogramVersion: 1, metricPlan: structuredClone(plan), runId, sourceId, sequence: ++sequence, scope,
    observations: { ...snapCounts(observation), requestLatency: observation.requestLatency.snapshot(), scriptLatency: observation.scriptLatency.snapshot(), caseLatency: observation.caseLatency.snapshot() },
    iterations: scope === "observations" ? null : { ...iterations, latency: iterations.latency.snapshot(), startDelay: iterations.startDelay.snapshot() }, phases: [...phases.values()].map((p) => ({ ...p, observations: snapCounts(p.observations), requestLatency: p.requestLatency.snapshot() })),
    timeline: { bucketWidthMs: width, buckets: [...buckets.values()].sort((a, b) => a.startOffsetMs - b.startOffsetMs).map((b) => ({ ...b, observations: snapCounts(b.observations), requestLatency: b.requestLatency.snapshot(), sources: [...b.sources.values()].map((s) => ({ ...s, observations: snapCounts(s.observations) })) })) },
    nodes: [...nodes.values()].map((n) => ({ ...n, observations: snapCounts(n.observations), requestLatency: n.requestLatency.snapshot(), nodeLatency: n.nodeLatency.snapshot() })), numericBytes: bytes, incompleteReasons: [...reasons] });
  const merge = (s: StressAggregateSnapshot): void => {
    if (!snapshotSchema.safeParse(s).success) fail("snapshot-invalid");
    if (s.runId !== runId || s.sourceId === sourceId || canonical(s.metricPlan) !== config || (s.scope === "observations") !== (s.iterations === null) || (scope === "observations" && s.iterations)) fail("snapshot-invalid");
    if (sources.has(s.sourceId)) fail("snapshot-duplicate");
    const unique = <T>(v: readonly T[], key: (v: T) => string | number) => new Set(v.map(key)).size === v.length;
    if (!Number.isInteger(Math.log2(s.timeline.bucketWidthMs / 1000)) || !unique(s.phases, (p) => keyFor(p.phase, p.stageId)) || !unique(s.nodes, (n) => n.key) || !unique(s.timeline.buckets, (b) => b.startOffsetMs)
      || s.nodes.some((n) => n.key !== "other" && !nodeKeys.has(n.key)) || s.phases.some((p) => (!formal(p.phase) && p.stageId !== null) || p.firstObservedOffsetMs === null || p.lastObservedOffsetMs === null || p.firstObservedOffsetMs > p.lastObservedOffsetMs)
      || s.timeline.buckets.some((b) => b.startOffsetMs % s.timeline.bucketWidthMs !== 0 || b.startOffsetMs / s.timeline.bucketWidthMs >= 120 || !unique(b.sources, (v) => keyFor(v.phase, v.stageId)) || b.sources.some((v) => !s.phases.some((p) => p.phase === v.phase && p.stageId === v.stageId)))
      || s.observations.requestLatency.count !== s.observations.requests.eligibleCompleted || s.observations.scriptLatency.count !== s.observations.caseRows.total || s.observations.caseLatency.count !== s.observations.caseRows.total
      || s.phases.some((p) => p.requestLatency.count !== p.observations.requests.eligibleCompleted) || s.nodes.some((n) => n.passed + n.failed + n.aborted + n.skipped > n.visits || n.requestLatency.count !== n.observations.requests.eligibleCompleted || n.nodeLatency.count !== n.visits)
      || (s.iterations && (s.iterations.started + s.iterations.dropped !== s.iterations.planned || s.iterations.passed + s.iterations.failed + s.iterations.aborted > s.iterations.started))) fail("snapshot-invalid");
    const histogramBytes = (h: StressHistogramSnapshot) => 64 + 8 * ((h.exact?.length ?? 0) + h.buckets.length);
    let incoming = 256 + countsBytes(s.observations) + histogramBytes(s.observations.requestLatency) + histogramBytes(s.observations.scriptLatency) + histogramBytes(s.observations.caseLatency);
    if (s.iterations) incoming += histogramBytes(s.iterations.latency) + histogramBytes(s.iterations.startDelay);
    incoming += s.phases.reduce((n, p) => n + 16 + countsBytes(p.observations) + histogramBytes(p.requestLatency), 0) + s.nodes.reduce((n, v) => n + 40 + countsBytes(v.observations) + histogramBytes(v.requestLatency) + histogramBytes(v.nodeLatency), 0)
      + s.timeline.buckets.reduce((n, b) => n + 8 + countsBytes(b.observations) + histogramBytes(b.requestLatency) + b.sources.reduce((v, src) => v + countsBytes(src.observations), 0), 0);
    if (incoming > plan.memory.maxNumericBytes) fail("metrics-budget-exhausted");
    const sumCounts = (items: readonly StressObservationCounts[]) => {
      const values = Array.from({ length: 23 }, () => 0);
      for (const v of items) { const row = [v.caseRows.total, v.caseRows.ok, v.caseRows.failed, ...v.caseRows.failures, ...v.eligibleFailureCounts, v.requests.started, v.requests.completed, v.requests.eligibleCompleted, v.requests.failed, v.httpExchanges.started, v.httpExchanges.completed]; row.forEach((n, i) => { values[i] = safeAdd(values[i], n); }); } return values;
    };
    if (canonical(sumCounts(s.phases.filter((p) => formal(p.phase)).map((p) => p.observations))) !== canonical(sumCounts([s.observations])) || s.timeline.buckets.some((b) => b.requestLatency.count !== b.observations.requests.eligibleCompleted || canonical(sumCounts(b.sources.map((v) => v.observations))) !== canonical(sumCounts([b.observations])))) fail("snapshot-invalid");
    // A missing nonempty bucket must not disappear through an empty-array check.
    // Sources deliberately contain counts only, so verify each phase/stage's facts
    // and compare request distributions at the representable aggregate levels.
    for (const phase of s.phases) {
      const fromTimeline = s.timeline.buckets.flatMap((b) => b.sources.filter((src) => src.phase === phase.phase && src.stageId === phase.stageId).map((src) => src.observations));
      if (canonical(sumCounts(fromTimeline)) !== canonical(sumCounts([phase.observations]))) fail("snapshot-invalid");
    }
    const requestDistributionsMatch = (left: readonly StressHistogramSnapshot[], right: readonly StressHistogramSnapshot[]) => {
      // Two histograms plus two copied snapshot arrays, bounded scratch capacity.
      const scratchBytes = 4 * (64 + 4608 * 8); reserve(scratchBytes);
      try {
        const a = new StressHistogram(), b = new StressHistogram(); left.forEach((h) => a.merge(h)); right.forEach((h) => b.merge(h));
        const x = a.snapshot(), y = b.snapshot();
        const sameSum = x.sum === y.sum || Math.abs(x.sum - y.sum) <= Math.max(Math.abs(x.sum), Math.abs(y.sum)) * 1e-9;
        if (x.count !== y.count || !sameSum || x.min !== y.min || x.max !== y.max || x.zero !== y.zero || x.underflow !== y.underflow || x.overflow !== y.overflow) return false;
        if (x.exact !== null && y.exact !== null) return canonical([...x.exact].sort((a, b) => a - b)) === canonical([...y.exact].sort((a, b) => a - b));
        return x.buckets.length === y.buckets.length && x.buckets.every((n, i) => n === y.buckets[i]);
      } catch { fail("snapshot-invalid"); }
      finally { bytes -= scratchBytes; }
    };
    if (!requestDistributionsMatch(s.timeline.buckets.map((b) => b.requestLatency), s.phases.map((p) => p.requestLatency))
      || !requestDistributionsMatch(s.phases.filter((p) => formal(p.phase)).map((p) => p.requestLatency), [s.observations.requestLatency])) fail("snapshot-invalid");
    if (s.observations.httpExchanges.completed > s.observations.httpExchanges.started || s.observations.caseRows.total > Number.MAX_SAFE_INTEGER - observation.caseRows.total || s.observations.httpExchanges.started > Number.MAX_SAFE_INTEGER - observation.httpExchanges.started) fail("snapshot-invalid");
    sources.add(s.sourceId); reserve(8); s.incompleteReasons.forEach((r) => reasons.add(r));
    mergeCounts(observation, s.observations); mergeHist(observation.requestLatency, s.observations.requestLatency); mergeHist(observation.scriptLatency, s.observations.scriptLatency); mergeHist(observation.caseLatency, s.observations.caseLatency);
    if (s.iterations) { for (const k of ["planned", "started", "passed", "failed", "aborted", "dropped"] as const) iterations[k] = safeAdd(iterations[k], s.iterations[k]); mergeHist(iterations.latency, s.iterations.latency); mergeHist(iterations.startDelay, s.iterations.startDelay); }
    for (const p of s.phases) { const target = freshPhase(p.phase, p.stageId); mergeCounts(target.observations, p.observations); mergeHist(target.requestLatency, p.requestLatency); target.firstObservedOffsetMs = Math.min(target.firstObservedOffsetMs ?? p.firstObservedOffsetMs!, p.firstObservedOffsetMs!); target.lastObservedOffsetMs = Math.max(target.lastObservedOffsetMs ?? p.lastObservedOffsetMs!, p.lastObservedOffsetMs!); }
    while (width < s.timeline.bucketWidthMs) coarsen();
    for (const b of s.timeline.buckets) { const target = timelineAt(b.startOffsetMs); mergeCounts(target.observations, b.observations); mergeHist(target.requestLatency, b.requestLatency); for (const src of b.sources) mergeCounts(source(target, src.phase, src.stageId).observations, src.observations); }
    for (const n of s.nodes) { const target = node(n.key); for (const k of ["visits", "passed", "failed", "aborted", "skipped"] as const) target[k] = safeAdd(target[k], n[k]); mergeCounts(target.observations, n.observations); mergeHist(target.requestLatency, n.requestLatency); mergeHist(target.nodeLatency, n.nodeLatency); }
  };
  const finish = (context: StressFinishContext): StressMetricsSummary => {
    const uncertaintyMs = context.timelineUncertaintyMs ?? 0;
    if (!Number.isFinite(uncertaintyMs) || uncertaintyMs < 0) fail("snapshot-invalid");
    if (uncertaintyMs > width / 2 || context.completeness.metrics.reasons.includes("timeline-unaligned")) reasons.add("timeline-unaligned");
    const windows = context.phaseWindows ?? [], windowKeys = new Set(windows.map((w) => keyFor(w.phase, w.stageId)));
    if (windows.length > 69 || windowKeys.size !== windows.length || windows.some((w) => !Number.isFinite(w.startOffsetMs) || !Number.isFinite(w.endOffsetMs) || w.startOffsetMs < 0 || w.endOffsetMs < w.startOffsetMs || !StressPhaseSchema.safeParse(w.phase).success || (!formal(w.phase) && w.stageId !== null))) fail("snapshot-invalid");
    if (![context.startedAt, context.finishedAt, context.load.measurementDurationMs, context.load.drainDurationMs].every(Number.isFinite) || !Number.isSafeInteger(context.plannedIterations) || context.plannedIterations < iterations.started + iterations.dropped || (context.measurementStartOffsetMs !== null && (!Number.isFinite(context.measurementStartOffsetMs) || context.measurementStartOffsetMs < 0)) || (context.measurementEndOffsetMs !== null && (!Number.isFinite(context.measurementEndOffsetMs) || context.measurementEndOffsetMs < (context.measurementStartOffsetMs ?? 0)))) fail("snapshot-invalid");
    const completeness = structuredClone(context.completeness) as { -readonly [K in keyof typeof context.completeness]: { complete: boolean; reasons: StressCompletenessReason[] } };
    const incomplete = (part: keyof typeof completeness, reason: StressCompletenessReason) => { completeness[part].complete = false; if (!completeness[part].reasons.includes(reason)) completeness[part].reasons.push(reason); };
    if (context.stopReason === "user" || context.stopReason === "root-abort") incomplete("execution", "cancelled");
    if (context.stopReason === "drain-timeout" || context.stopReason === "setup-failed" || context.stopReason === "execution-failed") incomplete("execution", context.stopReason);
    if (iterations.aborted || observation.caseRows.failures[6] || iterations.passed + iterations.failed + iterations.aborted < iterations.started) incomplete("execution", "execution-failed");
    if (iterations.dropped) incomplete("load", "dropped");
    const durationMs = context.measurementStartOffsetMs === null || context.measurementEndOffsetMs === null ? 0 : context.measurementEndOffsetMs - context.measurementStartOffsetMs;
    if (!durationMs && observation.requests.eligibleCompleted) incomplete("metrics", "phase-window-missing");
    const unavailable = reasons.has("metrics-budget-exhausted") ? "budget-exhausted" as const : reasons.has("snapshot-invalid") ? "incomplete" as const : null;
    const metric = (h: StressHistogram): StressLatencyMetric => unavailable ? { availability: "unavailable", reason: unavailable } : h.metric();
    const measuredRate = (n: number, duration: number) => unavailable ? { availability: "unavailable" as const, reason: unavailable } : rate(n, duration);
    const phaseSummary = [...new Set([...phases.keys(), ...windowKeys])].map((key) => {
      const known = windows.find((w) => keyFor(w.phase, w.stageId) === key), p = phases.get(key); if (!known) reasons.add("phase-window-missing");
      const counts = p ? publicCounts(p.observations) : { caseRows: { total: 0, ok: 0, failed: 0, failures: failureObject([0, 0, 0, 0, 0, 0, 0]) }, requests: { started: 0, completed: 0, eligibleCompleted: 0, failed: 0 }, httpExchanges: { started: 0, completed: 0 } };
      return { phase: known?.phase ?? p!.phase, stageId: known ? known.stageId : p!.stageId, startOffsetMs: known?.startOffsetMs ?? null, endOffsetMs: known?.endOffsetMs ?? null, durationMs: known ? known.endOffsetMs - known.startOffsetMs : null,
        rps: known ? measuredRate(counts.requests.eligibleCompleted, known.endOffsetMs - known.startOffsetMs) : { availability: "unavailable" as const, reason: "not-collected" as const }, ...counts, latency: p ? metric(p.requestLatency) : { availability: "unavailable" as const, reason: "no-data" as const } };
    });
    if (phaseSummary.length > 69) fail("metrics-budget-exhausted"); reasons.forEach((reason) => incomplete("metrics", reason)); if (!observation.requests.eligibleCompleted) incomplete("metrics", "no-data");
    const latency = metric(observation.requestLatency), rps = measuredRate(observation.requests.eligibleCompleted, durationMs);
    const { violations } = evaluateStressMetricsThresholds({ requests: observation.requests, eligibleFailureCounts: failureObject(observation.eligibleFailureCounts), latency, rps, failedIterations: iterations.failed }, context.thresholds);
    context.lifecycle.forEach((step) => { if (step.state === "failed" || step.state === "aborted") incomplete("execution", step.role === "vuSetup" ? "vu-setup-failed" : step.role === "vuTeardown" ? "vu-teardown-failed" : step.role === "setup" ? "setup-failed" : "teardown-failed"); });
    const isIncomplete = Object.values(completeness).some((p) => !p.complete), status = completeness.execution.reasons.includes("cancelled") ? "aborted" : !observation.requests.eligibleCompleted ? "no-data" : isIncomplete ? "incomplete" : violations.length ? "failed" : "passed";
    const lastCovered = Math.max(context.measurementEndOffsetMs ?? 0, ...windows.map((w) => w.endOffsetMs));
    return { ...publicCounts(observation), totalRequests: observation.caseRows.total, ok: observation.caseRows.ok, failed: observation.caseRows.failed, durationMs, rps, latency, scriptLatency: metric(observation.scriptLatency), iterationLatency: metric(observation.caseLatency), failures: failureObject(observation.caseRows.failures), eligibleFailureCounts: failureObject(observation.eligibleFailureCounts), statusDist: Object.fromEntries(observation.statusCounts), errorKinds: Object.fromEntries(observation.errorCounts), startedAt: context.startedAt, finishedAt: context.finishedAt,
      verdict: { passed: status === "passed", status, violations }, iterations: { planned: context.plannedIterations, started: iterations.started, completed: iterations.passed + iterations.failed, passed: iterations.passed, failed: iterations.failed, aborted: iterations.aborted, dropped: iterations.dropped, latency: metric(iterations.latency), startDelay: metric(iterations.startDelay) }, phases: phaseSummary,
      timeline: { bucketWidthMs: width, aligned: !reasons.has("timeline-unaligned"), uncertaintyMs, buckets: [...buckets.values()].sort((a, b) => a.startOffsetMs - b.startOffsetMs).map((b) => { const endOffsetMs = Math.max(b.startOffsetMs, Math.min(b.startOffsetMs + width, lastCovered)); return { startOffsetMs: b.startOffsetMs, endOffsetMs, rps: measuredRate(b.observations.requests.eligibleCompleted, endOffsetMs - b.startOffsetMs), ...publicCounts(b.observations), latency: metric(b.requestLatency), sources: [...b.sources.values()].map((s) => ({ phase: s.phase, stageId: s.stageId, ...publicCounts(s.observations) })) }; }) },
      nodes: [...nodes.values()].map((n) => ({ key: n.key, workflowId: nodeKeys.get(n.key)?.workflowId ?? null, nodeId: nodeKeys.get(n.key)?.nodeId ?? null, other: n.key === "other", visits: n.visits, passed: n.passed, failed: n.failed, aborted: n.aborted, skipped: n.skipped, requests: { ...n.observations.requests }, requestLatency: metric(n.requestLatency), nodeLatency: metric(n.nodeLatency) })), load: structuredClone(context.load), statistics: summarizeStressHistogramStatistics(liveHistograms), lifecycle: structuredClone(context.lifecycle), completeness };
  };
  return { observe, snapshot, merge, finish, readProgress: () => ({ requests: { ...observation.requests }, incompleteReasons: [...reasons] }) };
}

import { z } from "zod";
import { StressFailureCountsSchema, StressReportSchema, StressStatisticsSchema } from "./model.js";
import { StressPlanSchema, StressTargetSchema } from "./plan.js";

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ms = z.number().finite().nonnegative();
export const StressPhaseSchema = z.enum(["setup", "vu-setup", "warmup", "measurement", "drain", "vu-teardown", "teardown"]);
export const StressUnavailableReasonSchema = z.enum(["no-data", "incomplete", "budget-exhausted", "overflow", "unaligned", "not-collected", "legacy"]);
export const StressCompletenessReasonSchema = z.enum([
  "cancelled", "drain-timeout", "warmup-drain-timeout", "setup-failed", "vu-setup-failed", "teardown-failed", "vu-teardown-failed",
  "worker-missing", "worker-failed", "worker-incompatible", "snapshot-missing", "snapshot-duplicate", "snapshot-invalid",
  "metrics-budget-exhausted", "histogram-overflow", "timeline-unaligned", "phase-window-missing", "dropped", "no-data", "policy-limited", "resource-saturated", "execution-failed",
]);
const unavailable = z.object({ availability: z.literal("unavailable"), reason: StressUnavailableReasonSchema }).strict();
export const StressNumericMetricSchema = z.discriminatedUnion("availability", [
  z.object({ availability: z.literal("available"), value: ms }).strict(), unavailable,
]);
export const StressLatencyMetricSchema = z.discriminatedUnion("availability", [
  z.object({ availability: z.literal("available"), value: StressReportSchema.shape.latency }).strict(), unavailable,
]);
export const StressRequestsSchema = z.object({ started: count, completed: count, eligibleCompleted: count, failed: count }).strict();
export const StressHttpExchangesSchema = z.object({ started: count, completed: count }).strict();
export const StressCaseRowsSchema = z.object({ total: count, ok: count, failed: count, failures: StressFailureCountsSchema }).strict();
export const StressIterationsSchema = z.object({ planned: count, started: count, completed: count, passed: count, failed: count, aborted: count, dropped: count,
  latency: StressLatencyMetricSchema, startDelay: StressLatencyMetricSchema }).strict();
const completenessPart = z.object({ complete: z.boolean(), reasons: z.array(StressCompletenessReasonSchema).max(32) }).strict().superRefine((part, ctx) => {
  if (part.complete === (part.reasons.length > 0)) ctx.addIssue({ code: "custom", message: "Complete components have no reasons; incomplete components require a reason" });
});
export const StressCompletenessSchema = z.object({ execution: completenessPart, metrics: completenessPart, load: completenessPart }).strict();
const observationSummary = { caseRows: StressCaseRowsSchema, requests: StressRequestsSchema, httpExchanges: StressHttpExchangesSchema, latency: StressLatencyMetricSchema };
export const StressPhaseSummarySchema = z.object({ phase: StressPhaseSchema, stageId: z.string().nullable(), startOffsetMs: ms.nullable(), endOffsetMs: ms.nullable(),
  durationMs: ms.nullable(), rps: StressNumericMetricSchema, ...observationSummary }).strict().superRefine((phase, ctx) => {
  const known = phase.startOffsetMs !== null && phase.endOffsetMs !== null && phase.durationMs !== null;
  const unknown = phase.startOffsetMs === null && phase.endOffsetMs === null && phase.durationMs === null;
  if ((!known && !unknown) || (known && (phase.endOffsetMs! < phase.startOffsetMs! || phase.durationMs !== phase.endOffsetMs! - phase.startOffsetMs!)) || (unknown && (phase.rps.availability !== "unavailable" || phase.rps.reason !== "not-collected"))) ctx.addIssue({ code: "custom", message: "Phase coverage must be complete or explicitly not collected" });
});
export const StressTimelineSourceSchema = z.object({ phase: StressPhaseSchema, stageId: z.string().nullable(),
  caseRows: StressCaseRowsSchema, requests: StressRequestsSchema, httpExchanges: StressHttpExchangesSchema }).strict();
export const StressTimelineBucketSchema = z.object({ startOffsetMs: ms, endOffsetMs: ms,
  rps: StressNumericMetricSchema, ...observationSummary, sources: z.array(StressTimelineSourceSchema).max(69) }).strict();
export const StressNodeSummarySchema = z.object({ key: z.string(), workflowId: z.string().nullable(), nodeId: z.string().nullable(), other: z.boolean(),
  visits: count, passed: count, failed: count, aborted: count, skipped: count, requests: StressRequestsSchema,
  requestLatency: StressLatencyMetricSchema, nodeLatency: StressLatencyMetricSchema }).strict();
export const StressLoadSummarySchema = z.object({ plannedDurationMs: ms.nullable(), measurementDurationMs: ms, drainDurationMs: ms,
  policyLimitedMs: ms, saturated: z.boolean(), maxVus: count.min(1), maxRequestConcurrency: count.min(1),
  targetArrivalRate: StressNumericMetricSchema.optional(), actualStartRate: StressNumericMetricSchema.optional(),
  requestedMaxRequestConcurrency: count.min(1).nullable().optional(), requestedMaxRps: ms.positive().nullable().optional(), effectiveMaxRps: ms.positive().nullable().optional(),
}).strict();
export const StressLifecycleSummarySchema = z.object({ role: z.enum(["setup", "vuSetup", "vuTeardown", "teardown"]), vuId: z.string().nullable(),
  state: z.enum(["passed", "failed", "aborted", "skipped"]), durationMs: ms,
  failureKind: z.enum(["transport", "http", "script", "assertion", "extraction", "config", "aborted"]).optional(),
}).strict();
export const StressVerdictV2Schema = StressReportSchema.shape.verdict.unwrap().extend({ status: z.enum(["passed", "failed", "incomplete", "aborted", "no-data"]) });
/** Producer schema: every F6 count and integrity dimension is explicit, never synthesized for history. */
export const StressReportV2Schema = StressReportSchema.omit({ latency: true, rps: true, scriptLatency: true, iterationLatency: true, verdict: true, distributed: true }).extend({
  formatVersion: z.literal(2), runId: z.string().min(1), projectId: z.string().min(1), definitionRevision: z.string().min(1),
  plan: StressPlanSchema, target: StressTargetSchema, environmentId: z.string().nullable(),
  dataIdentity: z.object({ digest: z.string().nullable(), datasetIds: z.array(z.string()) }).strict(),
  rps: StressNumericMetricSchema, latency: StressLatencyMetricSchema, scriptLatency: StressLatencyMetricSchema, iterationLatency: StressLatencyMetricSchema,
  verdict: StressVerdictV2Schema, iterations: StressIterationsSchema, caseRows: StressCaseRowsSchema,
  requests: StressRequestsSchema, httpExchanges: StressHttpExchangesSchema,
  phases: z.array(StressPhaseSummarySchema).max(69),
  timeline: z.object({ bucketWidthMs: ms.min(1000), aligned: z.boolean(), uncertaintyMs: ms, buckets: z.array(StressTimelineBucketSchema).max(120) }).strict(),
  nodes: z.array(StressNodeSummarySchema).max(513), load: StressLoadSummarySchema, statistics: StressStatisticsSchema,
  lifecycle: z.array(StressLifecycleSummarySchema).max(2002), completeness: StressCompletenessSchema,
  distributed: z.object({ protocolVersion: z.literal(3), workers: count.min(1), dataComplete: z.boolean(), timeAligned: z.boolean() }).strict().optional(),
}).strict().superRefine((report, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  if (report.totalRequests !== report.caseRows.total || report.ok !== report.caseRows.ok || report.failed !== report.caseRows.failed || report.caseRows.total !== report.caseRows.ok + report.caseRows.failed) issue(["caseRows"], "Legacy totals are case-row counts");
  if (report.requests.completed > report.requests.started || report.requests.eligibleCompleted > report.requests.completed || report.requests.failed > report.requests.eligibleCompleted) issue(["requests"], "Invalid protocol attempt qualification counts");
  if (report.httpExchanges.completed > report.httpExchanges.started) issue(["httpExchanges"], "Completed hops exceed started hops");
  const iterations = report.iterations;
  if (iterations.completed !== iterations.passed + iterations.failed || iterations.completed + iterations.aborted > iterations.started || iterations.started + iterations.dropped > iterations.planned) issue(["iterations"], "Invalid iteration count conservation");
  if (iterations.completed + iterations.aborted < iterations.started && (report.completeness.execution.complete || report.verdict.passed)) issue(["completeness", "execution"], "Complete execution requires a conclusion for every started iteration");
  if (report.requests.eligibleCompleted === 0 && (report.rps.availability !== "unavailable" || report.latency.availability !== "unavailable")) issue(["requests"], "No eligible requests requires unavailable request metrics");
  if (report.verdict.passed !== (report.verdict.status === "passed")) issue(["verdict"], "Verdict status and passed disagree");
  const incomplete = Object.values(report.completeness).some((part) => !part.complete);
  if (report.phases.some((phase) => phase.durationMs === null) && (report.completeness.metrics.complete || !report.completeness.metrics.reasons.includes("phase-window-missing"))) issue(["phases"], "Missing phase coverage requires phase-window-missing metrics reason");
  const lifecycleFailed = report.lifecycle.some((step) => step.state === "failed" || step.state === "aborted");
  // Formal totals cover measurement/drain only; workflow recovery may retain failed attempts.
  const failedCase = report.plan.target.kind === "case" && report.caseRows.failed > 0;
  const distributedUnaligned = report.distributed?.timeAligned === false;
  if (distributedUnaligned && (report.timeline.aligned || report.completeness.metrics.complete || !report.completeness.metrics.reasons.includes("timeline-unaligned"))) issue(["distributed", "timeAligned"], "Unaligned workers require an unaligned timeline and incomplete metrics with timeline-unaligned reason");
  if (report.verdict.passed && (incomplete || lifecycleFailed || failedCase || iterations.failed > 0 || iterations.aborted > 0 || iterations.dropped > 0 || report.requests.eligibleCompleted === 0 || report.incomplete || report.verdict.violations.length > 0 || report.distributed?.dataComplete === false || distributedUnaligned || report.latency.availability !== "available" || report.rps.availability !== "available" || !report.timeline.aligned)) issue(["verdict"], "Incomplete, failed, dropped, aborted, or no-data runs cannot pass");
});
export type StressReportV2 = z.infer<typeof StressReportV2Schema>;
export type StressNumericMetric = z.infer<typeof StressNumericMetricSchema>;
export type StressLatencyMetric = z.infer<typeof StressLatencyMetricSchema>;
export type StressCompleteness = z.infer<typeof StressCompletenessSchema>;
export type StressCompletenessReason = z.infer<typeof StressCompletenessReasonSchema>;
export type StressCaseRows = z.infer<typeof StressCaseRowsSchema>;
export type StressRequests = z.infer<typeof StressRequestsSchema>;
export type StressHttpExchanges = z.infer<typeof StressHttpExchangesSchema>;
export type StressIterations = z.infer<typeof StressIterationsSchema>;
export type StressPhaseSummary = z.infer<typeof StressPhaseSummarySchema>;
export type StressTimelineBucket = z.infer<typeof StressTimelineBucketSchema>;
export type StressTimelineSource = z.infer<typeof StressTimelineSourceSchema>;
export type StressNodeSummary = z.infer<typeof StressNodeSummarySchema>;
export type StressLoadSummary = z.infer<typeof StressLoadSummarySchema>;
export type StressLifecycleSummary = z.infer<typeof StressLifecycleSummarySchema>;
export type ReadableStressReport = z.infer<typeof StressReportSchema> | StressReportV2;
/** Select by version first: invalid v2 never falls back to permissive legacy parsing. */
export const ReadableStressReportSchema = z.unknown().transform((value, ctx): ReadableStressReport => {
  const version = value && typeof value === "object" && Object.hasOwn(value, "formatVersion") ? (value as { formatVersion: unknown }).formatVersion : undefined;
  if (version !== undefined && version !== 2) { ctx.addIssue({ code: "custom", path: ["formatVersion"], message: "Unsupported stress report formatVersion" }); return z.NEVER; }
  const result = version === 2 ? StressReportV2Schema.safeParse(value) : StressReportSchema.safeParse(value);
  if (!result.success) { for (const issue of result.error.issues) ctx.addIssue({ code: "custom", path: issue.path, message: issue.message }); return z.NEVER; }
  return result.data;
});
export function parseStressReport(value: unknown): ReadableStressReport { return ReadableStressReportSchema.parse(value); }

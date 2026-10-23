import { z } from "zod";
import type { ReadableStressReport, StressReportV2 } from "./reportV2.js";
const nullableNumber = z.number().finite().nullable();
const delta = z.object({ base: nullableNumber, candidate: nullableNumber, absolute: nullableNumber, relative: nullableNumber }).strict();
export const StressComparisonSchema = z.object({ directlyComparable: z.boolean(),
  mismatches: z.array(z.enum(["project-identity", "target", "environment", "load", "connection", "data", "statistics", "report-version"])),
  notices: z.array(z.enum(["revision-changed", "legacy-metadata-unavailable", "incomplete-run", "environment-definition-not-compared"])),
  metrics: z.object({ rps: delta, p95Ms: delta, errorRate: delta, iterationsCompleted: delta, iterationP95Ms: delta, dropped: delta }).strict(),
}).strict();
export type StressComparison = z.infer<typeof StressComparisonSchema>;
export function isStressReportV2(report: ReadableStressReport): report is StressReportV2 { return "formatVersion" in report && report.formatVersion === 2; }
const stable = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
function difference(base: number | null, candidate: number | null): z.infer<typeof delta> {
  const absolute = base !== null && candidate !== null ? candidate - base : null;
  const relative = absolute !== null && base !== null && base !== 0 ? absolute / base : null;
  return { base, candidate, absolute: absolute !== null && Number.isFinite(absolute) ? absolute : null, relative: relative !== null && Number.isFinite(relative) ? relative : null };
}
function values(report: ReadableStressReport) {
  const v2 = isStressReportV2(report);
  const eligible = v2 ? report.requests.eligibleCompleted : report.eligibleCompletedAttempts
    ?? report.measurementWindow?.eligibleCompletedAttempts ?? (report.totalRequests === 0 ? 0 : undefined);
  const failed = v2 ? report.requests.failed : report.eligibleFailureCounts ? Object.entries(report.eligibleFailureCounts).reduce((sum, [kind, count]) => sum + (kind === "aborted" ? 0 : count), 0) : null;
  return { rps: v2 ? report.rps.availability === "available" ? report.rps.value : null : eligible === 0 ? null : report.rps,
    p95Ms: v2 ? report.latency.availability === "available" ? report.latency.value.p95 : null : eligible === 0 ? null : report.latency.p95,
    errorRate: eligible !== undefined && eligible > 0 && failed !== null ? failed / eligible : null,
    iterationsCompleted: v2 ? report.iterations.completed : null,
    iterationP95Ms: v2 && report.iterations.latency.availability === "available" ? report.iterations.latency.value.p95 : null,
    dropped: v2 ? report.iterations.dropped : null };
}
/** Differences describe candidate minus baseline. Relative differences are fractions, never invented for zero/missing baselines. */
export function compareStressReports(base: ReadableStressReport, candidate: ReadableStressReport): StressComparison {
  if (base.projectId && candidate.projectId && base.projectId !== candidate.projectId) throw new Error("Cannot compare different projects");
  const mismatches: StressComparison["mismatches"] = [], notices: StressComparison["notices"] = ["environment-definition-not-compared"];
  if (!base.projectId || !candidate.projectId) mismatches.push("project-identity");
  if (base.definitionRevision !== candidate.definitionRevision) notices.push("revision-changed");
  if (base.incomplete || candidate.incomplete || [base, candidate].some((r) => isStressReportV2(r) && Object.values(r.completeness).some((p) => !p.complete))) notices.push("incomplete-run");
  if (isStressReportV2(base) && isStressReportV2(candidate)) {
    const loadConfig = (r: StressReportV2) => ({ load: r.plan.load, maxVus: r.plan.maxVus, termination: r.plan.termination,
      warmupMs: r.plan.warmupMs, thinkTimeMs: r.plan.thinkTimeMs, pacingMs: r.plan.pacingMs, gracefulStopMs: r.plan.gracefulStopMs,
      maxRequestConcurrency: r.plan.maxRequestConcurrency ?? null, maxRps: r.plan.maxRps ?? null,
      effectiveConcurrency: r.load.maxRequestConcurrency, effectiveMaxRps: r.load.effectiveMaxRps ?? null, lifecycle: r.plan.lifecycle ?? null, thresholds: r.plan.thresholds ?? null });
    if (stable(base.target) !== stable(candidate.target)) mismatches.push("target");
    if (base.environmentId !== candidate.environmentId) mismatches.push("environment");
    if (stable(loadConfig(base)) !== stable(loadConfig(candidate))) mismatches.push("load");
    if ((base.connectionMode ?? base.plan.connectionMode) !== (candidate.connectionMode ?? candidate.plan.connectionMode)) mismatches.push("connection");
    if (stable({ ...base.dataIdentity, datasetIds: [...base.dataIdentity.datasetIds].sort(), policy: base.plan.dataPolicy }) !== stable({ ...candidate.dataIdentity, datasetIds: [...candidate.dataIdentity.datasetIds].sort(), policy: candidate.plan.dataPolicy })) mismatches.push("data");
    const precision = (r: StressReportV2) => ({ ...r.statistics, underflow: undefined, overflow: undefined });
    if (stable(precision(base)) !== stable(precision(candidate))) mismatches.push("statistics");
  } else {
    notices.push("legacy-metadata-unavailable"); mismatches.push("report-version");
    if (base.connectionMode !== candidate.connectionMode) mismatches.push("connection");
  }
  const a = values(base), b = values(candidate);
  return { directlyComparable: mismatches.length === 0, mismatches, notices, metrics: {
    rps: difference(a.rps, b.rps), p95Ms: difference(a.p95Ms, b.p95Ms), errorRate: difference(a.errorRate, b.errorRate),
    iterationsCompleted: difference(a.iterationsCompleted, b.iterationsCompleted), iterationP95Ms: difference(a.iterationP95Ms, b.iterationP95Ms), dropped: difference(a.dropped, b.dropped) } };
}

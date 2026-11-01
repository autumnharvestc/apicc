import type { AiEvidence } from "./context.js";
import type { AiContextInput, AiSourceSummary, AiReadableReport } from "./context.js";
import type { DebugResult } from "../debug/model.js";
import { z } from "zod";
import { boundedAiText } from "./context.js";
import { redactAiText, safeAiValue } from "./contractView.js";
import { reportingUnits } from "../report/units.js";
import type { SafeExecutionEvidence, EvidencePreview } from "../report/types.js";
import { compareStressReports, isStressReportV2 } from "../stress/compare.js";
import { stripCodeFence } from "./suggest.js";

const references = z.array(z.string()).min(1);
const observation = z.object({ evidenceIds: references }).strict();
const explanation = z.object({ text: z.string(), evidenceIds: references }).strict();
export const AiAnalysisOutputSchema = z.object({
  conclusion: z.string(), observedFacts: z.array(observation),
  possibleCauses: z.array(explanation.extend({ confidence: z.literal("possible") }).strict()),
  checks: z.array(explanation), limitations: z.array(z.string()),
}).strict();
export type AiAnalysisDraft = z.infer<typeof AiAnalysisOutputSchema>;

export function parseAnalysisOutput(text: string, evidence: readonly AiEvidence[]): AiAnalysisDraft {
  const parsed = AiAnalysisOutputSchema.safeParse(JSON.parse(stripCodeFence(text)));
  if (!parsed.success) throw new Error("analysis-output-invalid");
  const output = parsed.data;
  const known = new Set(evidence.map(item => item.id));
  for (const fact of [...output.observedFacts, ...output.possibleCauses, ...output.checks]) {
    if (fact.evidenceIds.some(id => !known.has(id))) throw new Error("unknown-evidence");
  }
  return output;
}

function isDebug(report: AiReadableReport): report is DebugResult { return "sourceProjectRevision" in report && "outcomes" in report && "run" in report; }
/** Same native ownership gate for trusted source adapters and the shared AI projection. */
export function assertAiReportOwnership(report: AiReadableReport, projectId: string): void {
  if (isDebug(report)) {
    const owner = report.source.sourceKind === "asset" ? report.source.locator : report.source.sourceKind === "free" ? report.source.project : undefined;
    if (!owner || owner.projectId !== projectId) throw new Error("report-source-mismatch: native debug unowned");
    const replayOwner = report.replay.mode === "case" ? report.replay.case : report.replay.mode === "request" ? report.replay.locator : report.replay.project;
    if (replayOwner && replayOwner.projectId !== projectId) throw new Error("report-source-mismatch: replay unowned");
    for (const exchange of report.exchanges) {
      const exchangeOwner = exchange.source.sourceKind === "asset" ? exchange.source.case : exchange.source.sourceKind === "free" ? exchange.source.project : undefined;
      if (exchangeOwner && exchangeOwner.projectId !== projectId) throw new Error("report-source-mismatch: exchange unowned");
    }
  } else if (report.projectId && report.projectId !== projectId) throw new Error("report-source-mismatch");
}

function reportSource(reportId: string, report: AiReadableReport): NonNullable<AiSourceSummary["report"]> {
  const summary = isDebug(report) ? { total: report.run.total, passed: report.run.passed, failed: report.run.failed, ...(report.run.skipped === undefined ? {} : { skipped: report.run.skipped }) } : "cases" in report ? reportingUnits(report).summary : isStressReportV2(report) ? report.iterations : {
    totalRequests: report.totalRequests, ok: report.ok, failed: report.failed, rps: report.rps, latency: report.latency, incomplete: report.incomplete,
  };
  return safeAiValue({ reportId, definitionRevision: isDebug(report) ? report.sourceProjectRevision : report.definitionRevision ?? null,
    formatVersion: "formatVersion" in report ? report.formatVersion : null,
    startedAt: report.startedAt, finishedAt: report.finishedAt, summary }) as NonNullable<AiSourceSummary["report"]>;
}

/** Read already-loaded reports only. Numbers are copied from Core, never requested from AI. */
export function projectAiReport(input: Extract<AiContextInput, { purpose: "report-analysis" }>) {
  const { report } = input;
  assertAiReportOwnership(report, input.source.projectId);
  const definitionRevision = isDebug(report) ? report.sourceProjectRevision : report.definitionRevision;
  const evidence: AiEvidence[] = [];
  const included: string[] = [];
  const omitted: Array<{ item: string; reason: string }> = [];
  const source = reportSource(input.reportId, report);
  let comparisonSource: AiSourceSummary["comparison"];
  const selected = new Set(input.bodySelection);
  const available = new Set<string>();
  const add = (kind: string, location: string, value: unknown, state: AiEvidence["state"] = "collected", truncated?: boolean) => {
    evidence.push({ purpose: "report-analysis", id: `${input.reportId}:e${evidence.length + 1}`, kind, location, state, value: safeAiValue(value), ...(truncated === undefined ? {} : { truncated }) });
  };
  const body = (location: string, preview: EvidencePreview | undefined, state: SafeExecutionEvidence["state"]) => {
    if (preview && state === "collected" && !preview.omitted) available.add(location);
    if (!selected.has(location)) { omitted.push({ item: location, reason: preview ? "default-omitted" : "not-collected" }); return; }
    if (!available.has(location)) throw new Error("body-selection-unavailable");
    let safe: string;
    try { safe = JSON.stringify(safeAiValue(JSON.parse(preview!.text))); } catch { safe = redactAiText(preview!.text); }
    const bounded = boundedAiText(safe);
    add("body", location, bounded.text, "collected", Boolean(preview!.truncated || bounded.truncated));
    included.push(location);
    if (preview!.truncated || bounded.truncated) omitted.push({ item: location, reason: "truncated" });
  };
  const executionEvidence = (value: SafeExecutionEvidence | undefined, location: string) => {
    if (value && (value.identity.projectId !== input.source.projectId || (definitionRevision && value.identity.definitionRevision !== definitionRevision))) throw new Error("evidence-source-mismatch");
    add("evidence-state", location, { state: value?.state ?? "not-collected", truncated: value?.truncated ?? false, scriptDiagnostics: value?.scriptDiagnostics ?? "not-collected", bodyUnavailable: value?.bodyUnavailable }, value?.state ?? "not-collected");
    if (value?.state === "collected") {
      add("execution-identity", `${location}.identity`, value.identity);
      if (value.timings) add("timings", `${location}.timings`, value.timings);
      if (value.request) add("request", `${location}.request`, { protocol: value.request.protocol, method: value.request.method, url: value.request.url, headers: value.request.headers });
      if (value.response) add("response-status", `${location}.response.status`, value.response.status);
    }
    body(`${location}.request.body`, value?.request?.body, value?.state ?? "not-collected");
    body(`${location}.response.body`, value?.response?.body, value?.state ?? "not-collected");
  };
  if (isDebug(report)) {
    if (input.comparison) throw new Error("comparison-unavailable");
    add("logical-summary", "run", source.summary);
    add("request-summary", "requestFacts", null, "not-collected"); omitted.push({ item: "requestFacts", reason: "not-collected" });
    add("debug-revisions", "revisions", { sourceProjectRevision: report.sourceProjectRevision, executionSnapshotRevision: report.executionSnapshotRevision, ...(report.source.sourceKind === "asset" ? { sourceApiRevision: report.source.sourceApiRevision } : {}) });
    const failure = Object.fromEntries((["failureKind", "error", "errorName"] as const).filter(key => report[key] !== undefined).map(key => [key, report[key]]));
    if (Object.keys(failure).length) add("debug-failure", "failure", failure);
    if (report.warnings.length) add("debug-warnings", "warnings", report.warnings);
    report.outcomes.forEach((outcome, index) => {
      const fields = ["apiId", "apiName", "caseId", "caseName", "identityAvailable", "row", "passed", "skipped", "skipReason", "durationMs", "error", "failureKind"] as const;
      add("debug-outcome", `outcomes[${index}]`, { ...Object.fromEntries(fields.filter(key => Object.hasOwn(outcome, key)).map(key => [key, outcome[key]])), assertions: outcome.assertions.map(item => ({ pass: item.pass, message: item.message })) });
      executionEvidence(outcome.evidence, `outcomes[${index}].evidence`);
    });
    const headers = (pairs: readonly [string, string][]) => pairs.map(([name, value]) => [redactAiText(name), safeAiValue(value, name)]);
    report.exchanges.forEach((exchange, index) => {
      const location = `exchanges[${index}]`;
      add("debug-exchange", location, { source: exchange.source, identityAvailable: exchange.identityAvailable, rowIndex: exchange.rowIndex, hopIndex: exchange.hopIndex, order: exchange.order, transportState: exchange.transportState, startedAt: exchange.startedAt, finishedAt: exchange.finishedAt, durationMs: exchange.durationMs, failureStage: exchange.failureStage, failureCode: exchange.failureCode });
      if (exchange.request) add("request", `${location}.request`, { method: exchange.request.method, url: redactAiText(exchange.request.url), headers: headers(exchange.request.headers) });
      if (exchange.response) { add("response-status", `${location}.response.status`, exchange.response.status); add("response-headers", `${location}.response.headers`, headers(exchange.response.headers)); }
      const requestBody = exchange.request?.body; const responseBody = exchange.response?.body;
      body(`${location}.request.body`, requestBody?.kind === "text" ? { text: requestBody.text, truncated: requestBody.truncated } : undefined, requestBody?.kind === "text" ? "collected" : "not-collected");
      body(`${location}.response.body`, responseBody?.kind === "text" ? { text: responseBody.text, truncated: responseBody.truncated } : undefined, responseBody?.kind === "text" ? "collected" : "not-collected");
    });
    add("debug-completeness", "exchanges", { exchangeTotal: report.exchangeTotal, shown: report.exchanges.length, omittedExchangeCount: report.omittedExchangeCount });
  } else if ("cases" in report) {
    if (input.comparison) throw new Error("comparison-unavailable");
    add("logical-summary", "reportingUnits", reportingUnits(report).summary);
    add("request-summary", "requestFacts", report.requestFacts ?? null, report.requestFacts ? "collected" : "legacy");
    if (!report.requestFacts) omitted.push({ item: "requestFacts", reason: "legacy-not-collected" });
    report.cases.forEach((outcome, index) => {
      const fields = ["apiId", "apiName", "caseId", "caseName", "passed", "skipped", "skipReason", "durationMs", "error", "failureKind", "locator", "row", "scope", "nodeId", "workflowId", "entryId", "suiteRow", "invocationId", "parentInvocationId", "invocationPath", "nodeVisitId", "attempt"] as const;
      const row = Object.fromEntries(fields.filter(key => Object.hasOwn(outcome, key)).map(key => [key, outcome[key as keyof typeof outcome]]));
      row.assertions = outcome.assertions.map(assertion => ({ pass: assertion.pass, code: assertion.code, kind: assertion.kind, message: assertion.message }));
      add("case-outcome", `cases[${index}]`, row);
      executionEvidence(outcome.evidence, `cases[${index}].evidence`);
    });
    if (report.workflowUnits) add("workflow-units", "workflowUnits", report.workflowUnits);
    if (report.suite) add("suite", "suite", report.suite);
    if (report.workflow) add("workflow", "workflow", report.workflow);
    if (report.trace) {
      add("trace-summary", "trace", { totalEvents: report.trace.totalEvents, truncated: report.trace.truncated });
      report.trace.events.forEach((event, index) => add("trace-event", `trace.events[${index}]`, event));
    } else { add("trace-summary", "trace", null, "not-collected"); omitted.push({ item: "trace", reason: "not-collected" }); }
  } else {
    add("stress-verdict", "verdict", report.verdict ?? null);
    if (isStressReportV2(report)) {
      const fields = [
        ["stress-load", "load"], ["stress-completeness", "completeness"], ["stress-statistics", "statistics"],
        ["stress-phases", "phases"], ["stress-timeline", "timeline"], ["stress-nodes", "nodes"],
        ["stress-lifecycle", "lifecycle"], ["stress-iterations", "iterations"], ["stress-case-rows", "caseRows"],
        ["stress-requests", "requests"], ["stress-http-exchanges", "httpExchanges"],
      ] as const;
      for (const [kind, field] of fields) add(kind, field, report[field]);
      add("stress-metrics", "metrics", { rps: report.rps, latency: report.latency, scriptLatency: report.scriptLatency, iterationLatency: report.iterationLatency });
      add("stress-plan", "plan", report.plan);
    } else {
      add("stress-completeness", "completeness", null, "legacy");
      omitted.push({ item: "completeness", reason: "legacy-not-collected" });
      add("stress-legacy", "legacy", { totalRequests: report.totalRequests, ok: report.ok, failed: report.failed, rps: report.rps, latency: report.latency, incomplete: report.incomplete });
    }
    report.failureEvidence?.forEach((item, index) => executionEvidence(item, `failureEvidence[${index}]`));
    if (input.comparison) {
      const calculated = compareStressReports(input.comparison.baseline, report);
      if (!input.comparison.judgment.directlyComparable || !calculated.directlyComparable) throw new Error("comparison-unavailable");
      comparisonSource = { baseline: reportSource(input.comparison.baselineReportId, input.comparison.baseline), candidate: source };
      add("comparison", "comparison", { ...calculated,
        baseline: { ...comparisonSource.baseline, location: "iterations" },
        candidate: { ...comparisonSource.candidate, location: "iterations" },
      });
    }
  }
  for (const selection of selected) if (!available.has(selection)) throw new Error("body-selection-unavailable");
  return { evidence, included, omitted, source, comparisonSource, availableBodies: [...available] };
}

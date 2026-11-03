import { createCredentialOutputSanitizer } from "../credentials/output.js";
import { redactExecutionOutput } from "../report/evidence.js";
import { reportingUnits } from "../report/units.js";
import type { RunResult, SafeExecutionEvidence } from "../report/types.js";
import { parseStressReport } from "../stress/reportV2.js";
import { compareStressReports, isStressReportV2 } from "../stress/compare.js";
import { DebugHistoryRecordSchema, DebugResultSchema } from "../debug/model.js";
import { RunReportInputWireSchema } from "./shared.js";
import type { ArchivePublicationInput, Limitation, ProjectionPolicy, PublicArtifactDto, ReportViewDto } from "./types.js";
import { isCredentialFieldName } from '../import/schemaMapping.js';
import type { NormalizedArchivedExecution, NormalizedArchiveReport } from './archive.js';

type NormalizedArchiveInput = Omit<ArchivePublicationInput, 'report'> & { report: NormalizedArchiveReport };

/** Known structured header values from this selected report only; never serialize raw source as a scan target. */
export function archiveHeaderMarkers(input: NormalizedArchiveInput, policy: ProjectionPolicy): string[] {
  const names = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', ...policy.extraSensitiveHeaders].map(name => name.toLowerCase()));
  const markers = new Set<string>();
  const add = (value: string) => { if (value) markers.add(value); };
  const header = (name: string, value: unknown): void => {
    name = name.toLowerCase();
    if (!names.has(name) && !isCredentialFieldName(name)) return;
    if (Array.isArray(value)) { value.forEach(item => header(name, item)); return; }
    if (typeof value !== 'string') return;
    add(value); if (name === 'authorization' || name === 'proxy-authorization') add(value.replace(/^Bearer\s+/i, ''));
    if (name === 'cookie' || name === 'set-cookie') {
      for (const pair of name === 'cookie' ? value.split(';') : [value.split(';')[0]!]) { const equals = pair.indexOf('='); if (equals >= 0) add(pair.slice(equals + 1).trim()); }
    }
  };
  const headers = (text: string): void => {
    try { const value: unknown = JSON.parse(text); if (value && typeof value === 'object' && !Array.isArray(value)) { Object.entries(value).forEach(([name, item]) => header(name, item)); return; } } catch { /* Older evidence stores retain named header lines. */ }
    for (const line of text.split(/\r?\n/)) { const colon = line.indexOf(':'); if (colon > 0) header(line.slice(0, colon).trim(), line.slice(colon + 1).trim()); }
  };
  const evidence = (value: SafeExecutionEvidence | undefined): void => { if (value?.request) headers(value.request.headers.text); if (value?.response) headers(value.response.headers.text); };
  const report = input.report;
  if (report.format === 'run') report.body.cases.forEach(row => evidence(row.evidence));
  else if (report.format === 'debug') ('result' in report.body ? report.body.result : report.body).outcomes.forEach(row => evidence(row.evidence));
  else report.body.failureEvidence?.forEach(evidence);
  return [...markers];
}

export function projectReport(input: NormalizedArchiveInput, policy: ProjectionPolicy,
  execution?: Omit<NormalizedArchivedExecution, 'report'>): PublicArtifactDto {
  const limitations: Limitation[] = [];
  const limitation = (code: string, path?: string): void => { limitations.push({ code, ...(path ? { path } : {}) }); };
  const blank = (sourceCategory: ReportViewDto["sourceCategory"], startedAt: string, finishedAt: string, verdict: string): ReportViewDto => ({
    sourceCategory, startedAt, finishedAt, verdict, counts: [], failures: [], nodes: [], trace: [], evidence: [],
  });
  const boundary = createCredentialOutputSanitizer(input.privateMarkers);
  const limits = { valueBytes: policy.maxFieldBytes, bodyBytes: policy.maxFieldBytes, caseBytes: policy.maxArtifactBytes, reportBytes: policy.maxArtifactBytes };
  type Row = { apiName: string; caseName: string; passed: boolean; skipped?: boolean; durationMs: number; failureKind?: string; evidence?: SafeExecutionEvidence; nodeId?: string; error?: string; assertions?: { pass: boolean; message: string }[] };
  const rows = (report: ReportViewDto, raw: readonly Row[], safe: readonly Row[]): Map<string, string> => {
    const nodeIds = new Map<string, string>();
    raw.forEach((item, index) => {
      const id = `node-${index + 1}`;
      if (item.nodeId && !nodeIds.has(item.nodeId)) nodeIds.set(item.nodeId, id);
      const message = item.error ?? item.assertions?.filter((entry) => !entry.pass).map((entry) => entry.message).join("; ");
      report.nodes.push({ id, name: item.caseName || item.apiName, state: item.skipped ? "skipped" : item.passed ? "passed" : "failed", durationMs: item.durationMs,
        ...(item.failureKind ? { failureKind: item.failureKind } : {}), ...(message ? { message } : {}) });
      if (!item.passed && !item.skipped) {
        const category = item.failureKind ?? "unclassified";
        const found = report.failures.find((entry) => entry.category === category);
        if (found) found.count += 1; else report.failures.push({ category, count: 1 });
      }
      if (policy.includeEvidence) report.evidence.push(evidence(item.evidence, safe[index]?.evidence, id, index));
    });
    return nodeIds;
  };
  const evidence = (raw: SafeExecutionEvidence | undefined, safe: SafeExecutionEvidence | undefined, nodeId: string, index: number): ReportViewDto["evidence"][number] => {
    const path = `report.evidence[${index}]`;
    if (input.redaction === "unavailable") { limitation("unsupported", path); return { nodeId, status: "unsupported" }; }
    if (!raw) { limitation("missing", path); return { nodeId, status: "missing" }; }
    if (raw.state !== "collected" || !safe) { limitation("not-collected", path); return { nodeId, status: "not-collected" }; }
    let status: ReportViewDto["evidence"][number]["status"] = "available";
    if (raw.request?.body.text !== safe.request?.body.text || raw.response?.body.text !== safe.response?.body.text) status = "masked";
    if (safe.truncated || safe.request?.body.truncated || safe.response?.body.truncated) status = "truncated";
    if (status !== "available") limitation(status, path);
    return { nodeId, status, ...(safe.request && !safe.request.body.omitted ? { requestBody: safe.request.body.text } : {}),
      ...(safe.response && !safe.response.body.omitted ? { responseBody: safe.response.body.text } : {}) };
  };
  let report: ReportViewDto;
  const diagnostics: { labelCode: string; value: string }[] = [];
  try {
    if (input.report.format === "run") {
      const raw = RunReportInputWireSchema.parse(input.report.body) as RunResult;
      const safe = redactExecutionOutput(raw, boundary, limits);
      const logical = reportingUnits(raw).summary;
      const verdict = raw.suite?.verdict ?? raw.workflow?.verdict ?? (logical.failed > 0 ? "failed" : "passed");
      report = blank("run", raw.startedAt, raw.finishedAt, verdict);
      report.counts = [{ labelCode: "logical.units", total: logical.total, passed: logical.passed, failed: logical.failed, skipped: logical.skipped }, { labelCode: "case.rows", total: raw.total, passed: raw.passed, failed: raw.failed, skipped: raw.skipped ?? 0 }];
      // Do not invent request populations for old formats which did not collect them.
      if (raw.requestFacts) report.counts.push({ labelCode: "request.started", total: raw.requestFacts.requestStarted }, { labelCode: "request.completed", total: raw.requestFacts.requestCompleted }, { labelCode: "http.exchanges", total: raw.requestFacts.httpExchanges });
      else limitation("not-collected", "report.requestFacts");
      const nodes = rows(report, raw.cases, safe.cases);
      report.trace = (safe.trace?.events ?? []).map((event) => ({ type: event.type, ...(event.nodeId && nodes.has(event.nodeId) ? { nodeId: nodes.get(event.nodeId) } : {}),
        ...(event.state === undefined ? {} : { state: event.state }), ...(event.message === undefined ? {} : { message: event.message }),
        ...(event.delayMs === undefined ? {} : { delayMs: event.delayMs }), ...(event.attempt === undefined ? {} : { attempt: event.attempt }) }));
      if (raw.trace?.truncated || raw.evidenceOmitted) limitation("truncated", "report.trace");
    } else if (input.report.format === "debug") {
      const record = DebugHistoryRecordSchema.safeParse(input.report.body);
      const raw = record.success ? record.data.result : DebugResultSchema.parse(input.report.body);
      const verdict = raw.failureKind === 'aborted' || raw.outcomes.some(row => row.failureKind === 'aborted') ? 'aborted'
        : raw.failureKind !== undefined || raw.run.failed > 0 || raw.outcomes.some(row => !row.passed && !row.skipped) ? 'failed' : 'passed';
      report = blank("debug", raw.startedAt, raw.finishedAt, verdict);
      report.counts = [{ labelCode: "case.rows", total: raw.run.total, passed: raw.run.passed, failed: raw.run.failed, skipped: raw.run.skipped ?? 0 }, { labelCode: "http.exchanges", total: raw.exchangeTotal }];
      const safe = boundary.redactValue(raw.outcomes);
      rows(report, raw.outcomes, safe);
      // A top-level post-script failure is not a failed request or a new node.
      // The producer can derive the top kind from an outcome, not an extra occurrence.
      if (raw.failureKind !== undefined && !report.failures.some(row => row.category === raw.failureKind)) report.failures.push({ category: raw.failureKind, count: 1 });
      if (raw.error) diagnostics.push({ labelCode: 'report.failure', value: raw.error });
      if (record.success && record.data.formatVersion === 1 && policy.includeEvidence) {
        report.evidence = raw.outcomes.map((_, index) => ({ nodeId: `node-${index + 1}`, status: "unsupported" })); limitation("unsupported", "report.evidence");
      }
      if (raw.omittedExchangeCount > 0) limitation("not-collected", "report.exchanges");
    } else {
      const raw = parseStressReport(input.report.body);
      const baseline = input.report.baseline === undefined ? undefined : parseStressReport(input.report.baseline);
      report = blank("stress", new Date(raw.startedAt).toISOString(), new Date(raw.finishedAt).toISOString(), isStressReportV2(raw) ? raw.verdict.status : raw.verdict ? raw.verdict.passed ? "passed" : "failed" : "unknown");
      report.counts = [{ labelCode: "case.rows", total: raw.totalRequests, passed: raw.ok, failed: raw.failed }];
      report.failures = Object.entries(raw.failures ?? {}).filter(([, count]) => count > 0).map(([category, count]) => ({ category, count }));
      if (baseline) report.comparison = compareStressReports(baseline, raw);
      if (isStressReportV2(raw)) {
        const { iterations, requests, httpExchanges, caseRows, phases, timeline, nodes, lifecycle, load, statistics, completeness, rps, latency, scriptLatency, iterationLatency } = raw;
        report.stress = structuredClone({ iterations, requests, httpExchanges, caseRows, phases, timeline, nodes, lifecycle, load, statistics, completeness, rps, latency, scriptLatency, iterationLatency });
        const identities = new Map<string, string>();
        const local = (kind: string, id: string | null): string | null => { if (id === null) return null; const key = `${kind}:${id}`; let value = identities.get(key); if (!value) { value = `${kind}-${identities.size + 1}`; identities.set(key, value); } return value; };
        report.stress.phases.forEach((phase) => { phase.stageId = local("stage", phase.stageId); });
        report.stress.timeline.buckets.forEach((bucket) => bucket.sources.forEach((source) => { source.stageId = local("stage", source.stageId); }));
        report.stress.nodes.forEach((node, index) => {
          node.key = `summary-${index + 1}`; node.nodeId = local("node", node.nodeId); node.workflowId = local("workflow", node.workflowId);
          report.nodes.push({ id: `node-${index + 1}`, name: `节点 ${index + 1}`, state: node.failed > 0 ? "failed" : node.aborted > 0 ? "aborted" : "passed" });
        });
        report.stress.lifecycle.forEach((step) => { step.vuId = local("vu", step.vuId); });
        report.counts.push({ labelCode: "iterations", total: iterations.started, passed: iterations.passed, failed: iterations.failed }, { labelCode: "request.started", total: requests.started }, { labelCode: "request.completed", total: requests.completed });
      } else limitation("unsupported", "report.stress");
      if (policy.includeEvidence) {
        const safe = redactExecutionOutput(raw, boundary, limits);
        report.evidence = (raw.failureEvidence ?? []).map((item, index) => evidence(item, safe.failureEvidence?.[index], `evidence-${index + 1}`, index));
        if (!isStressReportV2(raw) && input.redaction === "unavailable") limitation("unsupported", "report.evidence");
      }
    }
  } catch { throw new Error("PUBLICATION_SOURCE_INVALID"); }
  const summary: { labelCode: string; value: string }[] = [{ labelCode: "report.verdict", value: report.verdict }, ...diagnostics];
  if (execution?.executionVerdict !== undefined) {
    summary.unshift({ labelCode: 'execution.verdict', value: execution.executionVerdict });
    // Keep the inner statistical/report conclusion untouched in its own summary
    // row; a completed inner sample cannot revive a non-passed execution.
    if (execution.executionVerdict !== 'passed') report.verdict = execution.executionVerdict;
  }
  if (execution?.executionFact !== undefined) summary.push({ labelCode: 'execution.fact', value: execution.executionFact });
  if (execution?.executionReasonUnavailable) limitation('unsupported', 'report.executionReason');
  // Agent debug is still the source-bound server-report publication. Only a
  // bare local debug history retains its existing debug-history artifact tag.
  return { formatVersion: 1, kind: input.report.format === "debug" && execution?.executionVerdict === undefined ? "debug-history" : "report", title: input.title,
    source: { trust: "server-archive", ...input.source }, summary, limitations, report };
}

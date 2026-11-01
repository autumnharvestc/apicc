import { describe, expect, it } from "vitest";

import { parseAnalysisOutput } from "../../src/ai/analysis.js";
import { prepareAiContext, type AiEvidence, type AiContextInput } from "../../src/ai/context.js";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import type { RunResult } from "../../src/report/types.js";
import { contractExecutionIds as ids, createContractExecutionProject } from "../helpers/contractExecutionFixtures.js";
import { stressReportFixture } from "../helpers/stressReport.js";
import { computeReport } from "../../src/stress/aggregate.js";
import { parseStressReport } from "../../src/stress/reportV2.js";
import { compareStressReports } from "../../src/stress/compare.js";

describe("AI report evidence", () => {
  // Must catch accepting invented evidence even when the narrative JSON is valid.
  it("unknown_evidence_id_rejected", () => {
    const evidence: AiEvidence[] = [{
      purpose: "report-analysis", id: "request-failure", kind: "case-outcome", location: "cases[0]",
      state: "collected", value: { passed: false, failureKind: "transport" },
    }];
    const output = JSON.stringify({
      conclusion: "请求失败需核查",
      observedFacts: [{ evidenceIds: ["invented-evidence"] }],
      possibleCauses: [], checks: [], limitations: [],
    });
    expect(() => parseAnalysisOutput(output, evidence)).toThrow(/unknown-evidence/);
  });

  // Must catch replacing real attempt outcomes with the recovered logical verdict.
  it("raw_request_failures_remain_distinct_from_logical_passes", () => {
    const snapshot = createProjectSnapshot(createContractExecutionProject("https://api.example.com"));
    const report: RunResult = {
      kind: "workflow", reportingMode: "workflow-invocation-v2",
      projectId: ids.project, definitionRevision: snapshot.definitionRevision,
      collectionId: ids.collection, collectionName: "snapshot-collection",
      startedAt: "2026-10-30T01:00:00.000Z", finishedAt: "2026-10-30T01:00:01.000Z",
      total: 1, passed: 1, failed: 0,
      reportingUnits: { total: 1, passed: 1, failed: 0, skipped: 0, entryDiagnostics: 0 },
      workflowUnits: [{ entryId: "flow", workflowId: ids.workflow, invocationId: "inv", verdict: "passed" }],
      requestFacts: { requestStarted: 1, requestCompleted: 1, httpExchanges: 0 },
      cases: [{
        apiId: ids.contract, apiName: "snapshot-request", caseId: ids.case, caseName: "snapshot-case",
        nodeId: ids.requestNode, passed: false, failureKind: "transport", error: "connection reset",
        durationMs: 10, assertions: [],
      }],
      trace: { events: [{ type: "recovered", nodeId: ids.requestNode }], truncated: false, totalEvents: 1 },
    };
    const before = JSON.stringify(report);
    const preview = prepareAiContext({
      purpose: "report-analysis", snapshot, context: snapshot.context,
      source: {
        kind: "local", bindingId: "opaque-report", rootIdentity: "host-root", editRevision: 0,
        projectId: ids.project, definitionRevision: snapshot.definitionRevision,
      },
      bodySelection: [], reportId: "report-1", report,
    });

    expect(preview.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "logical-summary", value: { total: 1, passed: 1, failed: 0, skipped: 0, entryDiagnostics: 0 } }),
      expect.objectContaining({ kind: "case-outcome", location: "cases[0]", value: expect.objectContaining({ passed: false, failureKind: "transport" }) }),
      expect.objectContaining({ kind: "request-summary", value: { requestStarted: 1, requestCompleted: 1, httpExchanges: 0 } }),
      expect.objectContaining({ kind: "trace-event", location: "trace.events[0]", value: expect.objectContaining({ type: "recovered" }) }),
    ]));
    expect(JSON.stringify(report)).toBe(before);
  });
});

const knownEvidence: AiEvidence[] = [{ purpose: "report-analysis", id: "known", kind: "case-outcome", location: "cases[0]", state: "collected", value: { passed: false } }];
const validAnalysis = { conclusion: "存在失败请求，需核查", observedFacts: [{ evidenceIds: ["known"] }], possibleCauses: [{ text: "可能是网络异常", evidenceIds: ["known"], confidence: "possible" }], checks: [{ text: "核查网络", evidenceIds: ["known"] }], limitations: ["单次观测无法确定根因"] };

describe("strict AI analysis output", () => {
  it.each([
    ["model_statistics", { ...validAnalysis, statistics: { total: 999 } }],
    ["fact_numbers", { ...validAnalysis, observedFacts: [{ evidenceIds: ["known"], total: 999 }] }],
    ["missing_conclusion", { observedFacts: [], possibleCauses: [], checks: [], limitations: [] }],
    ["definite_root_cause", { ...validAnalysis, possibleCauses: [{ text: "根因已确定", evidenceIds: ["known"], confidence: "certain" }] }],
  ])("rejects_invalid_analysis_structure: %s", (_name, output) => {
    expect(() => parseAnalysisOutput(JSON.stringify(output), knownEvidence)).toThrow(/analysis-output-invalid/);
  });
  it.each(["possibleCauses", "checks"] as const)("rejects_unknown_reference_outside_observed_facts: %s", field => {
    const output = { ...validAnalysis, [field]: [{ text: "参考不存在证据", evidenceIds: ["invented"], ...(field === "possibleCauses" ? { confidence: "possible" } : {}) }] };
    expect(() => parseAnalysisOutput(JSON.stringify(output), knownEvidence)).toThrow(/unknown-evidence/);
  });
  it("rejects_empty_fact_evidence_list", () => {
    expect(() => parseAnalysisOutput(JSON.stringify({ ...validAnalysis, observedFacts: [{ evidenceIds: [] }] }), knownEvidence)).toThrow(/analysis-output-invalid/);
  });
});

function reportInput(): Extract<AiContextInput, { purpose: "report-analysis" }> {
  const snapshot = createProjectSnapshot(createContractExecutionProject("https://api.example.com"));
  const report: RunResult = {
    collectionId: ids.collection, collectionName: "report", projectId: ids.project, definitionRevision: snapshot.definitionRevision,
    startedAt: "2026-10-30T01:00:00Z", finishedAt: "2026-10-30T01:00:01Z", total: 1, passed: 0, failed: 1,
    cases: [{ apiId: ids.contract, apiName: "request", caseId: ids.case, caseName: "case", passed: false, durationMs: 10, assertions: [],
      evidence: { identity: { projectId: ids.project, definitionRevision: snapshot.definitionRevision }, state: "collected", scriptDiagnostics: "not-collected", truncated: false,
        request: { protocol: "http", method: "POST", url: { text: "https://example.com?token=report-secret", truncated: false }, headers: { text: "Authorization: Bearer header-secret", truncated: false }, body: { text: "request-body-private", truncated: false } },
        response: { status: 503, headers: { text: "content-type: application/json", truncated: false }, body: { text: '{"password":"response-secret","data":"' + "汉".repeat(5000) + '"}', truncated: false } },
      },
    }],
  };
  return { purpose: "report-analysis", snapshot, context: snapshot.context, reportId: "functional-report", report, bodySelection: [], source: { kind: "local", bindingId: "report-binding", rootIdentity: "opaque-root", projectId: ids.project, definitionRevision: snapshot.definitionRevision, editRevision: 0 } };
}

describe("safe functional report projection", () => {
  it("default_projection_omits_bodies_and_does_not_expose_nested_raw_evidence", () => {
    const preview = prepareAiContext(reportInput());
    expect(JSON.stringify(preview)).not.toMatch(/request-body-private|response-secret|report-secret|header-secret/);
    expect(preview.omitted).toEqual(expect.arrayContaining([expect.objectContaining({ item: "cases[0].evidence.response.body" })]));
    expect(preview.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "response-status", value: 503 })]));
  });
  it("explicit_existing_safe_body_selection_is_redacted_bounded_and_labeled", () => {
    const input = reportInput(); input.bodySelection = ["cases[0].evidence.response.body"];
    const preview = prepareAiContext(input);
    const body = preview.evidence.find(item => item.location === "cases[0].evidence.response.body");
    expect(body).toMatchObject({ kind: "body", state: "collected", truncated: true });
    expect(new TextEncoder().encode(JSON.stringify(body?.value)).byteLength).toBeLessThan(4200);
    expect(JSON.stringify(preview)).not.toContain("response-secret");
    expect(preview.included).toContain("cases[0].evidence.response.body");
  });
  it.each(["not-collected", "omitted"] as const)("rejects_body_selection_when_evidence_unavailable: %s", state => {
    const input = reportInput(); (input.report as RunResult).cases[0]!.evidence!.state = state;
    input.bodySelection = ["cases[0].evidence.response.body"];
    expect(() => prepareAiContext(input)).toThrow(/body-selection-unavailable/);
  });
  it("rejects_already_omitted_body_preview", () => {
    const input = reportInput(); (input.report as RunResult).cases[0]!.evidence!.response!.body.omitted = true;
    input.bodySelection = ["cases[0].evidence.response.body"];
    expect(() => prepareAiContext(input)).toThrow(/body-selection-unavailable/);
  });
  it("marks_legacy_missing_request_facts_without_invented_zero", () => {
    const preview = prepareAiContext(reportInput());
    expect(preview.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "request-summary", state: "legacy", value: null })]));
    expect(preview.omitted).toEqual(expect.arrayContaining([expect.objectContaining({ item: "requestFacts", reason: "legacy-not-collected" })]));
  });
  it("preserves_trace_truncation_and_safe_evidence_states", () => {
    const input = reportInput(); const report = input.report as RunResult;
    report.trace = { events: [{ type: "cleanup-end", state: "failed", nodeId: "cleanup" }], totalEvents: 100, truncated: true };
    report.cases[0]!.evidence!.truncated = true;
    const preview = prepareAiContext(input);
    expect(preview.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "trace-summary", value: { totalEvents: 100, truncated: true } }),
      expect.objectContaining({ kind: "evidence-state", value: expect.objectContaining({ state: "collected", truncated: true }) }),
    ]));
  });
  it("rejects_report_from_another_project", () => {
    const input = reportInput(); (input.report as RunResult).projectId = "another-project";
    expect(() => prepareAiContext(input)).toThrow(/report-source-mismatch/);
  });
  it("preview_is_detached_and_immutable_for_confirmation", () => {
    const input = reportInput(); const preview = prepareAiContext(input);
    const before = JSON.stringify(preview);
    (input.report as RunResult).cases[0]!.caseName = "changed after preview";
    expect(Object.isFrozen(preview)).toBe(true);
    expect(Object.isFrozen(preview.evidence)).toBe(true);
    expect(JSON.stringify(preview)).toBe(before);
  });
});

describe("stress report facts and approved comparability", () => {
  it("fix1_comparison_preview_distinguishes_equal_metric_baselines_and_locates_both_reports", () => {
    const input = reportInput(); const baseline = stressReportFixture(); baseline.projectId = ids.project;
    const candidate = structuredClone(baseline); candidate.definitionRevision = "candidate-revision"; candidate.startedAt = 2000; candidate.finishedAt = 3000;
    Object.assign(baseline, { privatePath: "C:/private/baseline.json", requestBody: "baseline-private-body" });
    const before = JSON.stringify({ baseline, candidate });
    input.report = candidate; input.reportId = "candidate-report";
    input.comparison = { baselineReportId: "baseline-A", baseline, judgment: compareStressReports(baseline, candidate) };
    const a = prepareAiContext(input);
    input.comparison.baselineReportId = "baseline-B";
    const b = prepareAiContext(input);
    expect(a.source).toMatchObject({ comparison: {
      baseline: { reportId: "baseline-A", formatVersion: 2, definitionRevision: "rev1", startedAt: 0, finishedAt: 1000, summary: { completed: 1, failed: 0 } },
      candidate: { reportId: "candidate-report", formatVersion: 2, definitionRevision: "candidate-revision", startedAt: 2000, finishedAt: 3000, summary: { completed: 1, failed: 0 } },
    } });
    expect(b.source).toMatchObject({ comparison: { baseline: { reportId: "baseline-B" } } });
    const comparison = a.evidence.find(item => item.kind === "comparison");
    expect(comparison?.value).toMatchObject({ baseline: { reportId: "baseline-A", location: "iterations" }, candidate: { reportId: "candidate-report", location: "iterations" }, directlyComparable: true });
    expect(JSON.stringify(a)).not.toMatch(/privatePath|C:\/private|baseline-private-body/);
    expect(JSON.stringify({ baseline, candidate })).toBe(before);
  });
  // Catches string-only credential masking on formally valid JSON-valued lifecycle inputs.
  it.each([123456, [123456], { value: "object-private" }])("fix1_masks_entire_known_credential_input_value: %j", secret => {
    const input = reportInput(); const report = stressReportFixture(); report.projectId = ids.project;
    report.plan.lifecycle = { setup: { workflowId: "setup", inputs: { password: secret, qty: 7 } } };
    input.report = report;
    const before = JSON.stringify(report);
    const preview = prepareAiContext(input);
    expect(preview.evidence.find(item => item.kind === "stress-plan")?.value).toMatchObject({ lifecycle: { setup: { inputs: { password: "[REDACTED]", qty: 7 } } } });
    expect(JSON.stringify(preview)).not.toMatch(/123456|object-private/);
    expect(JSON.stringify(report)).toBe(before);
  });
  it("preserves_v2_load_integrity_phases_statistics_and_unavailable_metrics", () => {
    const input = reportInput(); const report = stressReportFixture();
    report.projectId = ids.project; report.load.saturated = true;
    report.rps = { availability: "unavailable", reason: "incomplete" };
    report.completeness.load = { complete: false, reasons: ["resource-saturated"] };
    input.report = report;
    const before = JSON.stringify(report);
    const preview = prepareAiContext(input);
    expect(preview.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "stress-load", value: expect.objectContaining({ saturated: true }) }),
      expect.objectContaining({ kind: "stress-metrics", value: expect.objectContaining({ rps: { availability: "unavailable", reason: "incomplete" } }) }),
      expect.objectContaining({ kind: "stress-completeness", value: report.completeness }),
      expect.objectContaining({ kind: "stress-statistics", value: report.statistics }),
      expect.objectContaining({ kind: "stress-phases", value: report.phases }),
    ]));
    expect(JSON.stringify(report)).toBe(before);
  });
  it("legacy_stress_does_not_invent_modern_integrity", () => {
    const input = reportInput(); input.report = parseStressReport(computeReport([], { concurrency: 1, startedAt: 0, finishedAt: 1000 }));
    const preview = prepareAiContext(input);
    expect(preview.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "stress-completeness", state: "legacy", value: null })]));
  });
  it("accepted_comparison_preserves_existing_notices_and_program_deltas", () => {
    const input = reportInput(); const base = stressReportFixture(); base.projectId = ids.project;
    const candidate = structuredClone(base); candidate.definitionRevision = "new-revision"; candidate.rps = { availability: "available", value: 1.5 };
    input.report = candidate; input.comparison = { baselineReportId: "baseline", baseline: base, judgment: compareStressReports(base, candidate) };
    const preview = prepareAiContext(input);
    expect(preview.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "comparison", value: expect.objectContaining({ directlyComparable: true, notices: expect.arrayContaining(["revision-changed", "environment-definition-not-compared"]), metrics: expect.objectContaining({ rps: { base: 1, candidate: 1.5, absolute: 0.5, relative: 0.5 } }) }) })]));
  });
  it("rejects_noncomparable_pair_even_when_caller_claims_approved", () => {
    const input = reportInput(); const base = stressReportFixture(); base.projectId = ids.project;
    const candidate = structuredClone(base); candidate.environmentId = "another-env";
    input.report = candidate; input.comparison = { baselineReportId: "baseline", baseline: base, judgment: { ...compareStressReports(base, candidate), directlyComparable: true } };
    expect(() => prepareAiContext(input)).toThrow(/comparison-unavailable/);
  });
});

describe("final report projection defenses", () => {
  it("whitelists_case_facts_instead_of_spreading_unknown_report_fields", () => {
    const value = reportInput();
    Object.assign((value.report as RunResult).cases[0]!, { requestBody: "raw-unknown-body", dataRows: [{ secretBusiness: "private-row-value" }], script: "private-script-source" });
    const text = JSON.stringify(prepareAiContext(value));
    expect(text).not.toMatch(/raw-unknown-body|private-row-value|private-script-source/);
  });
  it("absent_trace_is_explicitly_not_collected", () => {
    const preview = prepareAiContext(reportInput());
    expect(preview.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "trace-summary", state: "not-collected", value: null })]));
  });
  it("omitted_evidence_is_not_relabelled_as_collected_response_facts", () => {
    const value = reportInput(); (value.report as RunResult).cases[0]!.evidence!.state = "omitted";
    expect(prepareAiContext(value).evidence.some(item => item.kind === "response-status" && item.state === "collected")).toBe(false);
  });
  it("selected_body_rejects_another_source_identity_in_safe_evidence", () => {
    const value = reportInput(); (value.report as RunResult).cases[0]!.evidence!.identity.projectId = "another-project";
    value.bodySelection = ["cases[0].evidence.response.body"];
    expect(() => prepareAiContext(value)).toThrow(/evidence-source-mismatch/);
  });
  it("functional_reports_cannot_silently_accept_stress_comparison", () => {
    const value = reportInput(); const base = stressReportFixture();
    value.comparison = { baselineReportId: "base", baseline: base, judgment: compareStressReports(base, base) };
    expect(() => prepareAiContext(value)).toThrow(/comparison-unavailable/);
  });
  it("analysis_reuses_single_markdown_fence_handling", () => {
    const outcome = (() => { try { return { result: parseAnalysisOutput("```json\n" + JSON.stringify(validAnalysis) + "\n```", knownEvidence) }; } catch (error) { return { error }; } })();
    expect(outcome).toMatchObject({ result: { conclusion: validAnalysis.conclusion } });
  });
});

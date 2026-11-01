import { describe, expect, it } from "vitest";
import { prepareAiContext, type AiContextInput } from "../../src/ai/context.js";
import { parseAiCaseOutput } from "../../src/ai/suggest.js";
import { parseAiAssertionWireOutput } from "../../src/ai/assertions.js";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import { TestCaseSchema } from "../../src/domain/common.js";
import { contractExecutionIds as ids, createContractExecutionProject } from "../helpers/contractExecutionFixtures.js";
import { runAiAssistance } from "../../src/ai/assistance.js";
import { createAiInvocationHost } from "../../src/ai/invocation.js";
import { AiInvocationError, type AiInvocationHost, type AiPurpose } from "../../src/ai/types.js";
import { resolveAiInvocation } from "../../src/ai/config.js";
import { fixture } from "./config.fixture.js";
import { credentials, payload } from "./invocation.fixture.js";
import type { CaseExecutionLocator } from "../../src/runner/caseExecutor.js";
import { stressReportFixture } from "../helpers/stressReport.js";
import { compareStressReports } from "../../src/stress/compare.js";

function input(): Extract<AiContextInput, { purpose: "case-suggestion" }> & { target: CaseExecutionLocator } {
  const snapshot = createProjectSnapshot(createContractExecutionProject("https://api.example.com"));
  return { purpose: "case-suggestion", snapshot, context: snapshot.context, source: { kind: "local", bindingId: "stable-assistance-project", rootIdentity: "opaque-root", projectId: ids.project, definitionRevision: snapshot.definitionRevision, editRevision: 0 }, bodySelection: [], target: { collectionId: ids.collection, folderIds: [ids.outerFolder, ids.innerFolder], apiId: ids.contract, caseId: ids.case, scope: "base" } };
}

function strictNativeObjects(schema: unknown): void {
  if (!schema || typeof schema !== "object") return;
  const object = schema as Record<string, unknown>;
  if (object.type === "object") {
    expect(object.additionalProperties).toBe(false);
    expect([...(object.required as string[] ?? [])].sort()).toEqual(Object.keys(object.properties as object ?? {}).sort());
  }
  expect(Object.keys(object)).not.toContain("apiccJsonWireSchema");
  Object.values(object).forEach(value => {
    if (Array.isArray(value)) value.forEach(strictNativeObjects); else strictNativeObjects(value);
  });
}

const wireAssertion = { target: "bodyJson", op: "eq", expected: "1", path: "$.code", headerName: null, cookieName: null, namespaces: null, match: null, optionsJson: null };
const wireCase = { name: "new case", scope: "base", parameters: [{ name: "qty", value: "1" }], preOperations: [{ type: "script", content: "console.log('before')" }], postOperations: [{ type: "script", content: "console.log('after')" }], assertions: [wireAssertion], reason: "覆盖契约成功分支", evidenceIds: [] };

describe("native structured output wire contract", () => {
  it.each(["case-suggestion", "assertion-suggestion", "report-analysis"] as const)("evidence_contract_is_discriminated_by_purpose: %s", purpose => {
    const base = input();
    const request: AiContextInput = purpose === "case-suggestion" ? base : purpose === "assertion-suggestion" ? { ...base, purpose, basis: { kind: "contract" } } : { ...base, purpose, reportId: "report", report: { collectionId: ids.collection, collectionName: "existing", startedAt: "2026-10-30T00:00:00Z", finishedAt: "2026-10-30T00:00:01Z", total: 0, passed: 0, failed: 0, cases: [] } };
    const preview = prepareAiContext(request);
    expect(preview.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ purpose })]));
  });
  it.each(["case-suggestion", "assertion-suggestion", "report-analysis"] as const)("actual_preview_schema_is_native_strict_compatible: %s", purpose => {
    const base = input();
    const request: AiContextInput = purpose === "case-suggestion" ? base : purpose === "assertion-suggestion" ? { ...base, purpose, basis: { kind: "contract" } } : { ...base, purpose, reportId: "report", report: { collectionId: ids.collection, collectionName: "existing", startedAt: "2026-10-30T00:00:00Z", finishedAt: "2026-10-30T00:00:01Z", total: 0, passed: 0, failed: 0, cases: [] } };
    strictNativeObjects(prepareAiContext(request).outputSchema);
  });
  it("decodes_formal_case_parameters_operations_and_assertions_with_local_identities", () => {
    const preview = prepareAiContext(input());
    const decoded = parseAiCaseOutput(JSON.stringify({ cases: [wireCase] }), preview);
    expect(decoded.cases).toHaveLength(1);
    expect(TestCaseSchema.safeParse(decoded.cases[0]).success).toBe(true);
    expect(decoded.cases[0]).toMatchObject({ parameters: { qty: "1" }, assertions: [expect.objectContaining({ target: "bodyJson", op: "eq", expected: "1", path: "$.code" })], preOperations: [expect.objectContaining({ type: "script", content: "console.log('before')" })], postOperations: [expect.objectContaining({ type: "script", content: "console.log('after')" })] });
    expect(new Set([decoded.cases[0]!.id, decoded.cases[0]!.assertions[0]!.id, decoded.cases[0]!.preOperations[0]!.id, decoded.cases[0]!.postOperations[0]!.id]).size).toBe(4);
    expect(decoded.explanations).toEqual([{ caseId: decoded.cases[0]!.id, reason: "覆盖契约成功分支", evidenceIds: [] }]);
  });
  it.each([
    ["invalid_options_json", { ...wireAssertion, optionsJson: "{invalid" }],
    ["options_json_null_is_not_missing_options", { ...wireAssertion, optionsJson: "null" }],
    ["duplicate_namespace_keys", { ...wireAssertion, target: "bodyXml", path: "//x:code", namespaces: [{ name: "x", value: "urn:one" }, { name: "x", value: "urn:two" }] }],
    ["required_field_null", { ...wireAssertion, op: null }],
  ])("rejects_invalid_case_wire_values: %s", (_name, assertion) => {
    expect(() => parseAiCaseOutput(JSON.stringify({ cases: [{ ...wireCase, assertions: [assertion] }] }), prepareAiContext(input()))).toThrow(/case-output-invalid/);
  });
  it("rejects_duplicate_parameter_keys", () => {
    expect(() => parseAiCaseOutput(JSON.stringify({ cases: [{ ...wireCase, parameters: [{ name: "qty", value: "1" }, { name: "qty", value: "2" }] }] }), prepareAiContext(input()))).toThrow(/case-output-invalid/);
  });
  it("decodes_complex_assertion_options_without_losing_native_business_structure", () => {
    const base = input(); const preview = prepareAiContext({ ...base, purpose: "assertion-suggestion", basis: { kind: "contract" } });
    const output = { assertions: [{ assertion: { ...wireAssertion, op: "deepEqual", expected: '{"code":1}', optionsJson: "{}" }, basis: "contract", reason: "核对结构", evidenceIds: [preview.evidence[0]!.id], requiresUserJudgment: false }] };
    const candidates = parseAiAssertionWireOutput(JSON.stringify(output), preview);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.assertion).toMatchObject({ op: "deepEqual", expected: '{"code":1}', options: {} });
  });
  it("fix1_wire_case_overproduction_is_invalid_instead_of_silently_sliced", () => {
    const preview = prepareAiContext({ ...input(), limit: 1 });
    expect(() => parseAiCaseOutput(JSON.stringify({ cases: [wireCase, { ...wireCase, name: "second" }] }), preview)).toThrow(/case-output-invalid/);
  });
  it("wire_case_output_cannot_exceed_the_existing_50_candidate_bound", () => {
    expect(() => parseAiCaseOutput(JSON.stringify({ cases: Array.from({ length: 51 }, () => wireCase) }), prepareAiContext(input()))).toThrow(/case-output-invalid/);
  });
});

function invocation(purpose: AiPurpose = "case-suggestion") {
  const document = fixture(); document.models = document.models.slice(0, 1);
  document.models[0]!.streaming = false;
  document.bindings = [{ purpose, modelProfileId: "a", budgets: {} }];
  return resolveAiInvocation({ document, purpose });
}
function hostWith(...outputs: Array<string | Error>) {
  let calls = 0; let operations = 0;
  const bodies: Array<Record<string, any>> = [];
  const real = createAiInvocationHost({ credentials, fetch: async (_url, init) => {
    bodies.push(JSON.parse(init!.body as string));
    const next = outputs[calls++];
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error("unexpected extra paid call");
    const response = payload("openai-responses", next); delete response.usage;
    return Response.json(response);
  } });
  const host: AiInvocationHost = { run(request, work) { operations++; return real.run(request, work); } };
  return { host, bodies, calls: () => calls, operations: () => operations };
}

function reportRequest(): Extract<AiContextInput, { purpose: "report-analysis" }> {
  return { ...input(), purpose: "report-analysis", reportId: "report", report: { collectionId: ids.collection, collectionName: "existing", startedAt: "2026-10-30T00:00:00Z", finishedAt: "2026-10-30T00:00:01Z", total: 0, passed: 0, failed: 0, cases: [] } };
}

describe("fix1 effective business budgets", () => {
  it("report_result_preserves_explicit_selection_totals_for_readable_handoff", async () => {
    const preview = prepareAiContext({ ...reportRequest(), evidenceSelection: ["report:e2"] });
    const h = hostWith(JSON.stringify({ conclusion: "未采集请求统计", observedFacts: [], possibleCauses: [], checks: [], limitations: [] }));
    await expect(runAiAssistance(preview, invocation("report-analysis"), h.host, { signal: new AbortController().signal })).resolves.toMatchObject({ evidenceSelection: { selected: 1, total: 3, omitted: 2 } });
  });
  it("comparison_result_retains_selected_baseline_identity_even_with_equal_metrics", async () => {
    const base = stressReportFixture(); base.projectId = ids.project;
    const candidate = structuredClone(base); candidate.definitionRevision = "candidate-revision";
    const previews = ["baseline-A", "baseline-B"].map(baselineReportId => prepareAiContext({ ...reportRequest(), reportId: "candidate-report", report: candidate, comparison: { baselineReportId, baseline: base, judgment: compareStressReports(base, candidate) } }));
    const results = [];
    for (const preview of previews) {
      const id = preview.evidence.find(item => item.kind === "comparison")!.id;
      const h = hostWith(JSON.stringify({ conclusion: "指标相同", observedFacts: [{ evidenceIds: [id] }], possibleCauses: [], checks: [], limitations: [] }));
      results.push(await runAiAssistance(preview, invocation("report-analysis"), h.host, { signal: new AbortController().signal }));
    }
    expect(results[0]).toMatchObject({ source: { comparison: { baseline: { reportId: "baseline-A", definitionRevision: "rev1", formatVersion: 2 }, candidate: { reportId: "candidate-report", definitionRevision: "candidate-revision" } } }, analysis: { observedFacts: [expect.objectContaining({ value: expect.objectContaining({ baseline: expect.objectContaining({ reportId: "baseline-A", location: "iterations" }), candidate: expect.objectContaining({ reportId: "candidate-report", location: "iterations" }) }) })] } });
    expect(results[1]).toMatchObject({ source: { comparison: { baseline: { reportId: "baseline-B" } } } });
  });
  it.each([
    ["case-suggestion", undefined, undefined, 5], ["assertion-suggestion", undefined, undefined, 10],
    ["case-suggestion", 2, undefined, 2], ["assertion-suggestion", 3, undefined, 3],
    ["case-suggestion", 2, 7, 2], ["assertion-suggestion", 3, 1, 1],
  ] as const)("candidate_count_matches_message_schema_and_preview: %s %s %s", (purpose, candidateCount, limit, expected) => {
    const base = { ...input(), candidateCount, limit };
    const preview = prepareAiContext(purpose === "case-suggestion" ? base : { ...base, purpose, basis: { kind: "contract" } });
    expect(preview.limit).toBe(expected);
    expect(JSON.parse(preview.messages[1]!.content).limit).toBe(expected);
    expect(preview.outputSchema).toMatchObject({ properties: { [purpose === "case-suggestion" ? "cases" : "assertions"]: { maxItems: expected } } });
    if (candidateCount && limit && limit > candidateCount) expect(preview.omitted).toContainEqual({ item: "candidate-limit", reason: "candidate-count-budget" });
  });
  it.each([0, 51, 1.5])("rejects_invalid_pure_candidate_count: %s", candidateCount => {
    expect(() => prepareAiContext({ ...input(), candidateCount } as AiContextInput)).toThrow(/candidate-count/);
  });
  it.each(["case-suggestion", "assertion-suggestion"] as const)("requires_reprepare_before_sending_overpromising_preview: %s", async purpose => {
    const base = input(); const preview = prepareAiContext(purpose === "case-suggestion" ? base : { ...base, purpose, basis: { kind: "contract" } });
    const response = purpose === "case-suggestion" ? { cases: [wireCase] } : { assertions: [{ assertion: wireAssertion, basis: "contract", reason: "核对code", evidenceIds: [preview.evidence[0]!.id], requiresUserJudgment: false }] };
    const h = hostWith(JSON.stringify(response)); const resolved = invocation(purpose); resolved.budgets.candidateCount = 1;
    const before = JSON.stringify(preview);
    await expect(runAiAssistance(preview, resolved, h.host, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "preview-reprepare-required" });
    expect(h.calls()).toBe(0); expect(JSON.stringify(preview)).toBe(before);
  });
  it("counts_actual_supplemental_instruction_before_network_not_stale_preview_bytes", async () => {
    const preview = structuredClone(prepareAiContext(input()));
    const data = JSON.parse(preview.messages[1]!.content); data.instruction = "汉".repeat(3000);
    (preview.messages as Array<{ role: "user"; content: string }>)[1]!.content = JSON.stringify(data);
    const h = hostWith(JSON.stringify({ cases: [wireCase] }));
    await expect(runAiAssistance(preview, invocation(), h.host, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "instruction-budget" });
    expect(h.calls()).toBe(0);
  });
  it.each(["not JSON", JSON.stringify({ instruction: { untyped: "value" } })])("rejects_invalid_supplemental_instruction_carrier_before_network: %s", content => {
    const preview = structuredClone(prepareAiContext(input()));
    (preview.messages as Array<{ role: "user"; content: string }>)[1]!.content = content;
    const h = hostWith(JSON.stringify({ cases: [wireCase] }));
    return expect(runAiAssistance(preview, invocation(), h.host, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "preview-reprepare-required" });
  });
  it("uses_redacted_instruction_content_not_the_unredacted_original_byte_count", async () => {
    const preview = prepareAiContext({ ...input(), instruction: `password=${"x".repeat(9000)}` });
    const h = hostWith(JSON.stringify({ cases: [wireCase] }));
    expect(JSON.stringify(preview)).not.toContain("x".repeat(100));
    await expect(runAiAssistance(preview, invocation(), h.host, { signal: new AbortController().signal })).resolves.toMatchObject({ purpose: "case-suggestion" });
    expect(h.calls()).toBe(1);
  });
  it.each(["case-suggestion", "assertion-suggestion"] as const)("overproduction_repairs_within_one_existing_operation: %s", async purpose => {
    const base = { ...input(), limit: 1 }; const preview = prepareAiContext(purpose === "case-suggestion" ? base : { ...base, purpose, basis: { kind: "contract" } });
    const assertion = { assertion: wireAssertion, basis: "contract", reason: "核对code", evidenceIds: [preview.evidence[0]!.id], requiresUserJudgment: false };
    const many = purpose === "case-suggestion" ? { cases: [wireCase, wireCase] } : { assertions: [assertion, assertion] };
    const one = purpose === "case-suggestion" ? { cases: [wireCase] } : { assertions: [assertion] };
    const h = hostWith(JSON.stringify(many), JSON.stringify(one));
    await expect(runAiAssistance(preview, invocation(purpose), h.host, { signal: new AbortController().signal })).resolves.toMatchObject({ purpose });
    expect(h.calls()).toBe(2); expect(h.operations()).toBe(1);
  });
  it("assertion_wire_parser_rejects_overproduction", () => {
    const preview = prepareAiContext({ ...input(), purpose: "assertion-suggestion", basis: { kind: "contract" }, limit: 1 });
    const assertion = { assertion: wireAssertion, basis: "contract", reason: "核对code", evidenceIds: [preview.evidence[0]!.id], requiresUserJudgment: false };
    expect(() => parseAiAssertionWireOutput(JSON.stringify({ assertions: [assertion, assertion] }), preview)).toThrow(/assertion-output-invalid/);
  });
  it("rejects_report_evidence_over_budget_before_network", async () => {
    const preview = prepareAiContext(reportRequest()); const resolved = invocation("report-analysis"); resolved.budgets.evidenceCount = 1;
    const h = hostWith(JSON.stringify({ conclusion: "无请求", observedFacts: [], possibleCauses: [], checks: [], limitations: [] }));
    await expect(runAiAssistance(preview, resolved, h.host, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "evidence-selection-too-large" });
    expect(h.calls()).toBe(0);
  });
  it("explicit_authorized_evidence_selection_keeps_counts_omissions_and_independent_source", async () => {
    const request = reportRequest(); const full = prepareAiContext(request);
    const preview = prepareAiContext({ ...request, evidenceSelection: ["report:e2"] } as AiContextInput);
    expect(preview.evidence.map(item => item.id)).toEqual(["report:e2"]);
    expect(preview).toMatchObject({ evidenceSelection: { selected: 1, total: 3, omitted: 2 } });
    expect(preview.omitted).toContainEqual({ item: "report:e1", reason: "not-selected" });
    expect(preview.source.report).toEqual(full.source.report);
    expect(JSON.parse(preview.messages[1]!.content).evidence).toHaveLength(1);
    const h = hostWith(JSON.stringify({ conclusion: "缺少请求统计", observedFacts: [{ evidenceIds: ["report:e2"] }], possibleCauses: [], checks: [], limitations: [] }));
    const resolved = invocation("report-analysis"); resolved.budgets.evidenceCount = 1;
    await expect(runAiAssistance(preview, resolved, h.host, { signal: new AbortController().signal })).resolves.toMatchObject({ source: full.source, evidence: [expect.objectContaining({ id: "report:e2" })] });
    expect(h.calls()).toBe(1);
  });
  it("rejects_unknown_authorized_evidence_selection_id", () => {
    expect(() => prepareAiContext({ ...reportRequest(), evidenceSelection: ["another-report:e1"] } as AiContextInput)).toThrow(/evidence-selection-unavailable/);
  });
});

describe("single-operation AI business assistance", () => {
  it("case_result_contains_formal_candidates_source_and_honest_missing_usage", async () => {
    const preview = prepareAiContext(input()); const h = hostWith(JSON.stringify({ cases: [wireCase] }));
    const result = await runAiAssistance(preview, invocation(), h.host, { signal: new AbortController().signal });
    expect(result).toMatchObject({ purpose: "case-suggestion", source: preview.source, label: "AI 辅助", model: { profileId: "a", modelId: "real-a", connectionId: "c" }, timeZone: "UTC", generatedAt: expect.stringMatching(/Z$/), cases: [expect.objectContaining({ name: "new case" })] });
    expect(result?.usage).toBeUndefined();
    expect(h.calls()).toBe(1); expect(h.operations()).toBe(1);
  });
  it("structural_repair_reuses_one_operation_with_full_history_and_schema", async () => {
    const preview = prepareAiContext(input()); const h = hostWith("not valid JSON", JSON.stringify({ cases: [wireCase] }));
    const result = await runAiAssistance(preview, invocation(), h.host, { signal: new AbortController().signal });
    expect(result).toMatchObject({ purpose: "case-suggestion", cases: [expect.objectContaining({ name: "new case" })] });
    expect(h.operations()).toBe(1); expect(h.calls()).toBe(2);
    expect(h.bodies[1]!.input).toHaveLength(4);
    expect(h.bodies[1]!.input[2]).toMatchObject({ role: "assistant", content: "not valid JSON" });
    expect(h.bodies[1]!.text.format.schema).toEqual(preview.outputSchema);
  });
  it("repair_cannot_escape_shared_request_budget", async () => {
    const h = hostWith("not valid JSON", JSON.stringify({ cases: [wireCase] })); const resolved = invocation(); resolved.budgets.maxRequests = 1;
    await expect(runAiAssistance(prepareAiContext(input()), resolved, h.host, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "request-budget" });
    expect(h.calls()).toBe(1); expect(h.operations()).toBe(1);
  });
  it("two_invalid_business_outputs_stop_at_repair_limit_without_raw_output_in_error", async () => {
    const h = hostWith("private-model-output", "still private-model-output");
    const error = await runAiAssistance(prepareAiContext(input()), invocation(), h.host, { signal: new AbortController().signal }).catch(error => error);
    expect(error).toMatchObject({ code: "business-output-invalid" });
    expect(String(error)).not.toContain("private-model-output"); expect(h.calls()).toBe(2); expect(h.operations()).toBe(1);
  });
  it("transport_failure_does_not_start_structural_repair", async () => {
    const h = hostWith(new Error("upstream-private-network-error"), JSON.stringify({ cases: [wireCase] }));
    await expect(runAiAssistance(prepareAiContext(input()), invocation(), h.host, { signal: new AbortController().signal })).rejects.toBeInstanceOf(AiInvocationError);
    expect(h.calls()).toBe(1); expect(h.operations()).toBe(1);
  });
  it("cancelled_operation_never_calls_model", async () => {
    const h = hostWith(JSON.stringify({ cases: [wireCase] })); const controller = new AbortController(); controller.abort();
    await expect(runAiAssistance(prepareAiContext(input()), invocation(), h.host, { signal: controller.signal })).rejects.toMatchObject({ code: "cancelled" });
    expect(h.calls()).toBe(0);
  });
  it("purpose_mismatch_is_rejected_before_invocation", async () => {
    const h = hostWith(JSON.stringify({ cases: [wireCase] }));
    await expect(runAiAssistance(prepareAiContext(input()), invocation("report-analysis"), h.host, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "purpose-mismatch" });
    expect(h.operations()).toBe(0);
  });
  it("runtime_options_cannot_replace_the_explicit_resolved_invocation", async () => {
    const selected = invocation(); const unselected = invocation(); unselected.model.modelId = "unselected-model";
    const h = hostWith(JSON.stringify({ cases: [wireCase] }));
    await runAiAssistance(prepareAiContext(input()), selected, h.host, { signal: new AbortController().signal, resolved: unselected } as unknown as Parameters<typeof runAiAssistance>[3]);
    expect(h.bodies[0]!.model).toBe("real-a");
  });
  it("assertion_result_preserves_contract_basis_and_explicit_target", async () => {
    const preview = prepareAiContext({ ...input(), purpose: "assertion-suggestion", basis: { kind: "contract" } });
    const h = hostWith(JSON.stringify({ assertions: [{ assertion: wireAssertion, basis: "contract", reason: "核对业务code", evidenceIds: [preview.evidence[0]!.id], requiresUserJudgment: false }] }));
    const result = await runAiAssistance(preview, invocation("assertion-suggestion"), h.host, { signal: new AbortController().signal });
    expect(result).toMatchObject({ purpose: "assertion-suggestion", source: { target: input().target }, assertions: [expect.objectContaining({ basis: "contract", assertion: expect.objectContaining({ op: "eq", path: "$.code" }) })] });
  });
  it("observation_result_keeps_selected_evidence_and_report_source_identity", async () => {
    const base = input();
    const preview = prepareAiContext({ ...base, purpose: "assertion-suggestion", target: { ...base.target, caseId: ids.case, scope: "base" }, basis: { kind: "observation", reportId: "selected-report", caseIndex: 0, report: {
      projectId: ids.project, definitionRevision: base.snapshot.definitionRevision, collectionId: ids.collection, collectionName: "existing", startedAt: "2026-10-30T00:00:00Z", finishedAt: "2026-10-30T00:00:01Z", total: 1, passed: 0, failed: 1,
      cases: [{ apiId: ids.contract, apiName: "api", caseId: ids.case, caseName: "case", passed: false, durationMs: 1, assertions: [], evidence: { identity: { projectId: ids.project, definitionRevision: base.snapshot.definitionRevision, locator: structuredClone(base.target) }, state: "collected", scriptDiagnostics: "not-collected", truncated: false, response: { status: 503, headers: { text: "", truncated: false }, body: { text: "not-selected-private-body", truncated: false } } } }],
    } } });
    const status = preview.evidence.find(item => item.kind === "response-status")!;
    const h = hostWith(JSON.stringify({ assertions: [{ assertion: { ...wireAssertion, target: "status", path: null, expected: "503" }, basis: "observation", reason: "一次观测，需判断业务期望", evidenceIds: [status.id], requiresUserJudgment: true }] }));
    const result = await runAiAssistance(preview, invocation("assertion-suggestion"), h.host, { signal: new AbortController().signal });
    expect(result).toMatchObject({ source: { observation: { reportId: "selected-report", caseIndex: 0, definitionRevision: base.snapshot.definitionRevision } }, evidence: expect.arrayContaining([expect.objectContaining({ kind: "response-status", value: 503 })]) });
    expect(JSON.stringify(result)).not.toContain("not-selected-private-body");
  });
  it("observation_evidence_keeps_assertion_purpose_after_report_projection", async () => {
    const base = input();
    const preview = prepareAiContext({ ...base, purpose: "assertion-suggestion", basis: { kind: "observation", reportId: "observed", caseIndex: 0, report: {
      collectionId: ids.collection, collectionName: "existing", startedAt: "2026-10-30T00:00:00Z", finishedAt: "2026-10-30T00:00:01Z", total: 1, passed: 1, failed: 0,
      cases: [{ apiId: ids.contract, apiName: "api", caseId: ids.case, caseName: "case", passed: true, durationMs: 1, assertions: [], evidence: { identity: { projectId: ids.project, definitionRevision: base.snapshot.definitionRevision, locator: structuredClone(base.target) }, state: "collected", scriptDiagnostics: "not-collected", truncated: false, response: { status: 200, headers: { text: "", truncated: false }, body: { text: "", truncated: false } } } }],
    } } });
    expect(preview.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ purpose: "assertion-suggestion", kind: "response-status" })]));
  });
  it("analysis_materializes_program_facts_and_preserves_report_and_limitations", async () => {
    const base = input();
    const report = { collectionId: ids.collection, collectionName: "legacy", startedAt: "2026-10-30T00:00:00Z", finishedAt: "2026-10-30T00:00:01Z", total: 0, passed: 0, failed: 0, cases: [] };
    const before = JSON.stringify(report);
    const preview = prepareAiContext({ ...base, purpose: "report-analysis", reportId: "read-report", report });
    const h = hostWith(JSON.stringify({ conclusion: "没有可用于判断失败原因的请求证据", observedFacts: [{ evidenceIds: [preview.evidence[0]!.id] }], possibleCauses: [], checks: [], limitations: [] }));
    const result = await runAiAssistance(preview, invocation("report-analysis"), h.host, { signal: new AbortController().signal });
    expect(result).toMatchObject({ purpose: "report-analysis", analysis: { observedFacts: [expect.objectContaining({ kind: "logical-summary", value: { total: 0, passed: 0, failed: 0, skipped: 0, entryDiagnostics: 0 } })], limitations: expect.arrayContaining([expect.stringMatching(/legacy-not-collected/)]) }, source: { report: { reportId: "read-report", startedAt: report.startedAt, finishedAt: report.finishedAt } } });
    expect(JSON.stringify(report)).toBe(before);
  });
  it("known_usage_is_aggregated_across_initial_and_repair", async () => {
    let calls = 0;
    const host = createAiInvocationHost({ credentials, fetch: async () => Response.json(payload("openai-responses", calls++ === 0 ? "invalid JSON" : JSON.stringify({ cases: [wireCase] }))) });
    const result = await runAiAssistance(prepareAiContext(input()), invocation(), host, { signal: new AbortController().signal });
    expect(result).toMatchObject({ usage: { inputTokens: 20, outputTokens: 40 } });
  });
  it("progress_callback_receives_the_real_host_events", async () => {
    const phases: string[] = []; const h = hostWith(JSON.stringify({ cases: [wireCase] }));
    await runAiAssistance(prepareAiContext(input()), invocation(), h.host, { signal: new AbortController().signal, onProgress: event => phases.push(event.phase) });
    expect(phases).toEqual(expect.arrayContaining(["request", "completed"]));
  });
  it("zero_repair_budget_stops_after_initial_invalid_output", async () => {
    const h = hostWith("invalid JSON", JSON.stringify({ cases: [wireCase] })); const resolved = invocation(); resolved.budgets.repairAttempts = 0;
    await expect(runAiAssistance(prepareAiContext(input()), resolved, h.host, { signal: new AbortController().signal })).rejects.toMatchObject({ code: "business-output-invalid" });
    expect(h.calls()).toBe(1);
  });
});

describe("context and wire defensive requests", () => {
  it.each([0, 51, 1.5])("rejects_invalid_new_entrypoint_limit: %s", limit => {
    expect(() => prepareAiContext({ ...input(), limit })).toThrow(/limit/);
  });
  it("wire_case_explanation_cannot_reference_unknown_evidence", () => {
    expect(() => parseAiCaseOutput(JSON.stringify({ cases: [{ ...wireCase, evidenceIds: ["invented"] }] }), prepareAiContext(input()))).toThrow(/case-output-invalid/);
  });
  it("business_prompt_matches_wire_maps_and_omits_asset_id_instructions", () => {
    const preview = prepareAiContext(input());
    expect(preview.messages[0]!.content).toContain("optionsJson");
    expect(preview.messages[0]!.content).toMatch(/parameters.*数组/);
    expect(preview.messages[0]!.content).not.toContain("元素为 {id");
  });
});

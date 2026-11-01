import { describe, expect, it } from "vitest";
import { prepareAiContext, type AiContextInput } from "../../src/ai/context.js";
import { parseAssertionOutput, parseAiAssertionWireOutput } from "../../src/ai/assertions.js";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import { contractExecutionIds as ids, createContractExecutionProject } from "../helpers/contractExecutionFixtures.js";
import type { Assertion } from "../../src/domain/common.js";

function input(): Extract<AiContextInput, { purpose: "assertion-suggestion" }> {
  const project = createContractExecutionProject("https://api.example.com");
  project.collections[0]!.folders[0]!.folders[0]!.apis[0]!.contract.responses = [{ kind: "inline", id: "10000000-0000-4000-8000-000000000020", status: "200", description: "contract success", headers: {}, content: { "application/json": { examples: [], schema: { kind: "object", properties: { code: { kind: "scalar", type: "integer" } }, required: ["code"], additionalProperties: false } } } }];
  const snapshot = createProjectSnapshot(project);
  return { purpose: "assertion-suggestion", snapshot, context: snapshot.context, source: { kind: "local", bindingId: "assertion-binding", rootIdentity: "opaque-root", projectId: ids.project, definitionRevision: snapshot.definitionRevision, editRevision: 0 }, target: { collectionId: ids.collection, folderIds: [ids.outerFolder, ids.innerFolder], apiId: ids.contract, caseId: ids.case, scope: "base" }, bodySelection: [], basis: { kind: "contract" } };
}

function observationInput() {
  const value = input();
  value.basis = { kind: "observation", reportId: "existing-report", caseIndex: 0, report: {
    projectId: ids.project, definitionRevision: value.snapshot.definitionRevision, collectionId: ids.collection, collectionName: "existing", startedAt: "2026-10-30T00:00:00Z", finishedAt: "2026-10-30T00:00:01Z", total: 1, passed: 0, failed: 1,
    cases: [{ apiId: ids.contract, apiName: "request", caseId: ids.case, caseName: "current-case", passed: false, durationMs: 10, assertions: [], locator: value.target,
      evidence: { identity: { projectId: ids.project, definitionRevision: value.snapshot.definitionRevision, locator: value.target }, state: "collected", scriptDiagnostics: "not-collected", truncated: false, response: { status: 503, headers: { text: "", truncated: false }, body: { text: "observed-body-private", truncated: false } } },
    }],
  } };
  return value;
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
function output(assertion: Partial<Assertion>, evidenceId: string, overrides = {}) {
  return JSON.stringify({ assertions: [{ assertion: { id: "model-id", target: "status", op: "eq", expected: "200", ...assertion }, basis: "contract", reason: "契约声明成功状态", evidenceIds: [evidenceId], requiresUserJudgment: false, ...overrides }] });
}

it.each(['contract', 'observation'] as const)('final C fixture calibration local acceptance payload matches formal %s preview without inventing evidence', async basis => {
  // Importing the guarded pure helper never starts the fixture HTTP service.
  const { f7eBusinessPayload } = await import(new URL('../../../../scripts/f7e-acceptance.mjs', import.meta.url).href);
  const preview = prepareAiContext(basis === 'contract' ? input() : observationInput());
  expect(preview.assertionContext!.basis).toBe(basis);
  const payload = f7eBusinessPayload({ messages: preview.messages });
  const outcome = (() => { try { return { value: parseAiAssertionWireOutput(JSON.stringify(payload), preview) }; } catch (error) { return { error }; } })();
  expect(outcome, 'error' in outcome ? String(outcome.error) : 'accepted formal output').toHaveProperty('value');
  if (!outcome.value) return;
  const status = preview.evidence.find(item => item.kind === 'response-status' && item.state === 'collected');
  expect(outcome.value[0]).toMatchObject({ basis, requiresUserJudgment: basis === 'observation', assertion: { expected: basis === 'observation' ? String(status!.value) : '200' } });
  if (basis === 'observation') expect(outcome.value[0]!.evidenceIds).toEqual([status!.id]);
});

describe("standalone assertion context", () => {
  // Final B I3: source identity must prove the exact case/scope, not just names.
  it.each(["missing locator", "foreign identity scope", "conflicting identity scope"] as const)("final B I3 refuses observation with %s", kind => {
    const value = observationInput(); if (value.basis.kind !== "observation") throw new Error("observation fixture");
    const row = value.basis.report.cases[0]!;
    if (kind !== "conflicting identity scope") delete row.locator;
    if (kind === "missing locator") delete row.evidence!.identity.locator;
    else row.evidence!.identity.locator = { ...value.target, scope: "other-scope" };
    const outcome = (() => { try { return { preview: prepareAiContext(value) }; } catch (error) { return { error }; } })();
    expect(outcome).toHaveProperty("error");
  });
  it("final B I3 accepts a complete formal execution identity without guessing a missing row scope", () => {
    const value = observationInput(); if (value.basis.kind !== "observation") throw new Error("observation fixture");
    delete value.basis.report.cases[0]!.locator;
    expect(prepareAiContext(value).source.observation).toMatchObject({ reportId: "existing-report", caseIndex: 0 });
  });
  it.each(['missing-folderIds', 'invalid-folderIds'] as const)('final B I3 partial observation locator has readable rejection: %s', kind => {
    const value = observationInput(); if (value.basis.kind !== 'observation') throw new Error('observation fixture');
    const row = value.basis.report.cases[0]!;
    delete row.evidence!.identity.locator;
    row.locator = structuredClone(row.locator!); // Do not mutate the fixture's shared current target.
    const locator = row.locator as unknown as Record<string, unknown>;
    if (kind === 'missing-folderIds') delete locator.folderIds; else locator.folderIds = '';
    const outcome = (() => { try { return { value: prepareAiContext(value) }; } catch (error) { return { error: error as Error }; } })();
    expect(outcome).toMatchObject({ error: { message: 'evidence-target-mismatch' } });
  });
  // Catches treating JSON strings as opaque text or trusting their self-declared schema shape.
  it.each(["parameter", "expected"] as const)("fix1_structurally_redacts_current_case_json_strings: %s", field => {
    const project = createContractExecutionProject("https://api.example.com");
    const current = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!.cases[0]!;
    const json = JSON.stringify({ kind: "object", properties: { password: { value: "json-private" } }, token: [234567], qty: 7 });
    if (field === "parameter") current.parameters = { payload: json };
    else current.assertions = [{ id: "existing", target: "bodyText", op: "eq", expected: json }];
    const before = JSON.stringify(project);
    const snapshot = createProjectSnapshot(project); const value = input();
    value.snapshot = snapshot; value.context = snapshot.context; value.source.definitionRevision = snapshot.definitionRevision;
    const text = JSON.stringify(prepareAiContext(value));
    expect(text).not.toMatch(/json-private|234567/);
    expect(text).toContain("qty");
    expect(JSON.stringify(project)).toBe(before);
  });
  // Guards the trusted schema projection when generic business values become fully masked.
  it("fix1_keeps_real_credential_named_schema_properties_compilable_and_annotations_safe", () => {
    const project = createContractExecutionProject("https://api.example.com");
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.contract.responses = [{ kind: "inline", id: "10000000-0000-4000-8000-000000000020", status: "200", description: "password=response-description-private", headers: {}, content: { "application/json": { examples: [], schema: {
      kind: "object", description: "token=schema-description-private", properties: { password: { kind: "scalar", type: "string", default: "schema-default-private", examples: ["schema-example-private"] }, token: { kind: "array", items: { kind: "scalar", type: "string" } } }, required: ["password"], additionalProperties: false,
    } } } }];
    const snapshot = createProjectSnapshot(project); const value = input();
    value.snapshot = snapshot; value.context = snapshot.context; value.source.definitionRevision = snapshot.definitionRevision;
    const preview = prepareAiContext(value);
    expect(JSON.stringify(preview)).not.toMatch(/response-description-private|schema-description-private|schema-default-private|schema-example-private/);
    const schema = preview.assertionContext!.responses[0]!.content["application/json"]!.schema;
    expect(schema).toMatchObject({ kind: "object", properties: { password: { kind: "scalar", type: "string" }, token: { kind: "array", items: { kind: "scalar", type: "string" } } }, required: ["password"] });
    expect(parseAssertionOutput(output({ op: "schema", target: "bodyJson", expected: undefined, options: { useContractResponse: true } }, preview.evidence[0]!.id), preview)).toHaveLength(1);
  });
  it("observation_body_selection_uses_existing_safe_preview_for_the_selected_row", () => {
    const value = observationInput(); value.bodySelection = ["cases[0].evidence.response.body"];
    const outcome = (() => { try { return { preview: prepareAiContext(value) }; } catch (error) { return { error }; } })();
    expect(outcome).toMatchObject({ preview: { evidence: expect.arrayContaining([expect.objectContaining({ kind: "body", location: "cases[0].evidence.response.body", value: "observed-body-private" })]) } });
  });
  it("observation_body_selection_cannot_include_another_report_row", () => {
    const value = observationInput(); if (value.basis.kind !== "observation") throw new Error("observation fixture");
    value.basis.report.cases.push(structuredClone(value.basis.report.cases[0]!));
    value.bodySelection = ["cases[1].evidence.response.body"];
    expect(() => prepareAiContext(value)).toThrow(/body-selection-unavailable/);
  });
  it("includes_current_case_parameters_and_assertion_intent_without_script_source", () => {
    const project = createContractExecutionProject("https://api.example.com");
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.cases[0]!.parameters = { qty: "7", password: "case-private" };
    asset.cases[0]!.assertions = [{ id: "existing", target: "bodyJson", op: "eq", path: "$.businessCode", expected: "OK" }];
    const snapshot = createProjectSnapshot(project); const value = input();
    value.snapshot = snapshot; value.context = snapshot.context; value.source.definitionRevision = snapshot.definitionRevision;
    const text = prepareAiContext(value).messages.map(message => message.content).join("\n");
    expect(text).toContain("businessCode"); expect(text).toContain('"qty":"7"');
    expect(text).not.toContain("case-private"); expect(text).not.toContain("pm.request.headers");
  });
  it("binds_contract_evidence_to_the_explicit_current_case", () => {
    const value = input(); const preview = prepareAiContext(value);
    expect(preview.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "contract", value: expect.objectContaining({ responses: expect.arrayContaining([expect.objectContaining({ status: "200" })]) }) })]));
    expect(preview.source.target).toEqual(value.target);
  });
  it("observation_basis_retains_503_and_never_promotes_it_to_contract_permission", () => {
    const preview = prepareAiContext(observationInput());
    expect(preview.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "response-status", value: 503 })]));
    expect(preview.messages.map(m => m.content).join("\n")).toMatch(/观测.*契约/);
    expect(JSON.stringify(preview)).not.toContain("observed-body-private");
  });
  it("rejects_observation_from_another_selected_case", () => {
    const value = observationInput(); if (value.basis.kind !== "observation") throw new Error("observation fixture");
    value.basis.report.cases[0]!.caseId = "other-case";
    expect(() => prepareAiContext(value)).toThrow(/evidence-target-mismatch/);
  });
  it.each(["not-collected", "omitted", "missing-response"] as const)("rejects_unavailable_observation_basis: %s", state => {
    const value = observationInput(); if (value.basis.kind !== "observation") throw new Error("observation fixture");
    const evidence = value.basis.report.cases[0]!.evidence!;
    if (state === "missing-response") delete evidence.response; else evidence.state = state;
    expect(() => prepareAiContext(value)).toThrow(/evidence-unavailable/);
  });
});

describe("standalone assertion candidates", () => {
  it("valid_declarative_assertion_uses_local_identity_preserving_intent_and_evidence", () => {
    const preview = prepareAiContext(input()); const evidenceId = preview.evidence[0]?.id ?? "contract-missing";
    const candidates = parseAssertionOutput(output({}, evidenceId), preview);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ assertion: { id: expect.stringMatching(ULID), target: "status", op: "eq", expected: "200" }, basis: "contract", reason: "契约声明成功状态", evidenceIds: [evidenceId], requiresUserJudgment: false });
  });
  it.each([
    ["plugin_name_without_capability", { op: "plugin-secret" }],
    ["operator_wrong_target", { op: "xpath", target: "status", expected: "//code" }],
    ["required_expected_absent", { expected: undefined }],
    ["numeric_model_identity", { id: 42 }],
    ["invalid_regex", { op: "regex", target: "bodyText", expected: "[" }],
    ["invalid_membership", { op: "in", expected: "{}" }],
    ["invalid_length", { op: "length", expected: "-1" }],
    ["unknown_schema_reference", { op: "schema", target: "bodyJson", options: { schema: { kind: "modelRef", modelId: "missing" } } }],
  ])("rejects_unsupported_or_invalid_declarative_assertion: %s", (_name, assertion) => {
    const preview = prepareAiContext(input());
    expect(() => parseAssertionOutput(output(assertion as Partial<Assertion>, preview.evidence[0]?.id ?? "contract-missing"), preview)).toThrow(/assertion-output-invalid/);
  });
  it("rejects_unknown_assertion_evidence", () => {
    expect(() => parseAssertionOutput(output({}, "invented"), prepareAiContext(input()))).toThrow(/unknown-evidence/);
  });
  it("contract_status_candidate_cannot_claim_undeclared_503_permission", () => {
    const preview = prepareAiContext(input());
    expect(() => parseAssertionOutput(output({ expected: "503" }, preview.evidence[0]?.id ?? "missing"), preview)).toThrow(/contract-expectation-unsupported/);
  });
  it("observation_candidate_requires_explicit_user_judgment", () => {
    const preview = prepareAiContext(observationInput());
    expect(() => parseAssertionOutput(output({ expected: "503" }, preview.evidence[0]?.id ?? "missing", { basis: "observation", requiresUserJudgment: false }), preview)).toThrow(/observation-requires-judgment/);
  });
  it("observation_cannot_be_relabelled_contract", () => {
    const preview = prepareAiContext(observationInput());
    expect(() => parseAssertionOutput(output({}, preview.evidence[0]?.id ?? "missing"), preview)).toThrow(/assertion-basis-mismatch/);
  });
  it("supports_current_core_contract_response_schema_operator", () => {
    const preview = prepareAiContext(input());
    const candidates = parseAssertionOutput(output({ op: "schema", target: "bodyJson", expected: undefined, options: { useContractResponse: true } }, preview.evidence[0]?.id ?? "missing"), preview);
    expect(candidates).toEqual([expect.objectContaining({ assertion: expect.objectContaining({ op: "schema", target: "bodyJson", options: { useContractResponse: true } }) })]);
  });
  it("valid_schema_model_reference_is_limited_to_projected_closure_without_rereading_original_context", () => {
    const project = createContractExecutionProject("https://api.example.com");
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    const modelId = "10000000-0000-4000-8000-000000000025";
    project.models.push({ formatVersion: 1, id: modelId, name: "Response", description: "", schema: { kind: "scalar", type: "string" } });
    asset.contract.responses = [{ kind: "inline", id: "10000000-0000-4000-8000-000000000026", status: "200", description: "", headers: {}, content: { "application/json": { schema: { kind: "modelRef", modelId }, examples: [] } } }];
    const snapshot = createProjectSnapshot(project); const value = input();
    value.snapshot = snapshot; value.context = snapshot.context; value.source.definitionRevision = snapshot.definitionRevision;
    const preview = prepareAiContext(value);
    for (const key of ["getContract", "getModel", "getComponent", "dependencyClosure"] as const) snapshot.context[key] = (() => { throw new Error("original context reread forbidden"); }) as never;
    const candidates = parseAssertionOutput(output({ op: "schema", target: "bodyJson", expected: undefined, options: { schema: { kind: "modelRef", modelId } } }, preview.evidence[0]?.id ?? "missing"), preview);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.assertion.options).toEqual({ schema: { kind: "modelRef", modelId } });
  });
  it("schema_operator_rejects_ambiguous_models_in_the_projected_closure", () => {
    const project = createContractExecutionProject("https://api.example.com");
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    const modelId = "10000000-0000-4000-8000-000000000025";
    for (const name of ["first", "second"]) project.models.push({ formatVersion: 1, id: modelId, name, description: "", schema: { kind: "scalar", type: "string" } });
    asset.contract.responses = [{ kind: "inline", id: "10000000-0000-4000-8000-000000000026", status: "200", description: "", headers: {}, content: { "application/json": { schema: { kind: "modelRef", modelId }, examples: [] } } }];
    const snapshot = createProjectSnapshot(project); const value = input();
    value.snapshot = snapshot; value.context = snapshot.context; value.source.definitionRevision = snapshot.definitionRevision;
    const preview = prepareAiContext(value);
    expect(() => parseAssertionOutput(output({ op: "schema", target: "bodyJson", expected: undefined, options: { schema: { kind: "modelRef", modelId } } }, preview.evidence[0]!.id), preview)).toThrow(/assertion-output-invalid/);
  });
  it("use_contract_response_rejects_a_missing_response_component", () => {
    const project = createContractExecutionProject("https://api.example.com");
    project.collections[0]!.folders[0]!.folders[0]!.apis[0]!.contract.responses = [{ kind: "componentRef", id: "10000000-0000-4000-8000-000000000026", componentId: "10000000-0000-4000-8000-000000000027", expectedKind: "response" }];
    const snapshot = createProjectSnapshot(project); const value = input();
    value.snapshot = snapshot; value.context = snapshot.context; value.source.definitionRevision = snapshot.definitionRevision;
    const preview = prepareAiContext(value);
    expect(() => parseAssertionOutput(output({ op: "schema", target: "bodyJson", expected: undefined, options: { useContractResponse: true } }, preview.evidence[0]!.id), preview)).toThrow(/assertion-output-invalid/);
  });
});

import { describe, expect, it } from "vitest";

import { prepareAiContext, sameAiSourceBinding, inspectAiContextChoices, type AiContextInput, type AiSourceBinding } from "../../src/ai/context.js";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import { contractExecutionIds as ids, createContractExecutionProject } from "../helpers/contractExecutionFixtures.js";
import { contractAiView, redactAiText } from "../../src/ai/contractView.js";
import { ApiContractSchema, type RequestBody } from "../../src/contract/model.js";

// The secondary common-text regex must not consume the next safe URL query field.
it.each([
  ["https://user:private@example.test/items?password=private&visible=yes", "https://[REDACTED]@example.test/items?password=[REDACTED]&visible=yes"],
  ["/items?access_token=private&visible=yes&password=private&tail=ok", "/items?access_token=[REDACTED]&visible=yes&password=[REDACTED]&tail=ok"],
  ["Authorization: Bearer https://example.test/?password=private&visible=yes", "Authorization: Bearer [REDACTED]"],
  ["password=private&private-suffix", "password=[REDACTED]"],
])("preserves query boundaries without weakening credential text protection: %s", (input, want) => {
  expect(redactAiText(input)).toBe(want);
});

describe("AI context source binding", () => {
  // Must catch a projection that trusts matching names/asset IDs over project identity.
  it("same_name_different_project_is_not_same_binding", () => {
    const original = createProjectSnapshot(createContractExecutionProject("https://api.example.com"));
    const anotherProject = createContractExecutionProject("https://api.example.com");
    anotherProject.id = "20000000-0000-4000-8000-000000000001";
    const another = createProjectSnapshot(anotherProject);

    expect(another.project.name).toBe(original.project.name);
    expect(() => prepareAiContext({
      purpose: "case-suggestion",
      snapshot: another,
      context: another.context,
      source: {
        kind: "local", bindingId: "opaque-original", rootIdentity: "host-root-original", editRevision: 0,
        projectId: original.project.id, definitionRevision: original.definitionRevision,
      },
      target: {
        collectionId: ids.collection, folderIds: [ids.outerFolder, ids.innerFolder],
        apiId: ids.contract, caseId: ids.case, scope: "base",
      },
      bodySelection: [],
    })).toThrow(/source-binding-mismatch/);
  });
});

describe("body omission recovery from independent behavior tests", () => {
  it.each(["soap", "websocket"] as const)("omits_unselected_protocol_message: %s", protocol => {
    const project = createContractExecutionProject("https://api.example.com");
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    if (asset.contract.request.protocol !== "http") throw new Error("HTTP fixture required");
    const { method: _method, body: _body, protocol: _protocol, ...common } = asset.contract.request;
    asset.contract.request = protocol === "soap" ? { ...common, protocol, method: "POST", envelope: "private-protocol-payload" } : { ...common, protocol, message: "private-protocol-payload" };
    const snapshot = createProjectSnapshot(project);
    const view = contractAiView(asset, snapshot.context, { includeBodies: false });
    expect(view.request.protocol).toBe(protocol);
    expect(JSON.stringify(view)).not.toContain("private-protocol-payload");
  });
  const requestBodies: Array<[string, RequestBody]> = [
    ["graphql", { kind: "graphql", query: "private-graphql-query", variables: "private-graphql-variables" }],
    ["urlencoded", { kind: "urlencoded", fields: [{ id: "10000000-0000-4000-8000-000000000020", name: "comment", value: "private-form-value", enabled: true }] }],
    ["multipart", { kind: "multipart", entries: [{ kind: "text", id: "10000000-0000-4000-8000-000000000020", name: "comment", value: "private-part-value", enabled: true }] }],
  ];
  it.each(requestBodies)("omits_unselected_http_body_values: %s", (_name, body) => {
    const project = createContractExecutionProject("https://api.example.com");
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    if (asset.contract.request.protocol !== "http") throw new Error("HTTP fixture required");
    asset.contract.request.body = body;
    const snapshot = createProjectSnapshot(project);
    const view = contractAiView(asset, snapshot.context, { includeBodies: false });
    expect(view.request.body).toMatchObject({ kind: body.kind });
    expect(JSON.stringify(view)).not.toContain("private-");
  });
  it.each(["inline", "componentRef"] as const)("omits_unselected_response_example_values: %s", kind => {
    const project = createContractExecutionProject("https://api.example.com");
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    const exampleId = "10000000-0000-4000-8000-000000000021";
    const componentId = "10000000-0000-4000-8000-000000000022";
    if (kind === "componentRef") project.components.push({ formatVersion: 1, id: componentId, name: "Related example", description: "", kind: "example", definition: { name: "safe example name", value: { order: "private-example-value" } } });
    asset.contract.responses = [{ kind: "inline", id: "10000000-0000-4000-8000-000000000023", status: "200", description: "ok", headers: {}, content: { "application/json": { examples: [kind === "inline" ? { kind, id: exampleId, name: "safe example name", value: { order: "private-example-value" } } : { kind, id: exampleId, componentId, expectedKind: "example" }] } } }];
    const snapshot = createProjectSnapshot(project);
    const view = contractAiView(asset, snapshot.context, { includeBodies: false });
    expect(JSON.stringify(view)).toContain("safe example name");
    expect(JSON.stringify(view)).not.toContain("private-example-value");
  });
});

function contractInput(): Extract<AiContextInput, { purpose: "case-suggestion" }> {
  const snapshot = createProjectSnapshot(createContractExecutionProject("https://api.example.com"));
  return {
    purpose: "case-suggestion", snapshot, context: snapshot.context,
    source: { kind: "local", bindingId: "stable-local-project-key", rootIdentity: "opaque-canonical-root", projectId: ids.project, definitionRevision: snapshot.definitionRevision, editRevision: 0 },
    bodySelection: [],
    target: { collectionId: ids.collection, folderIds: [ids.outerFolder, ids.innerFolder], apiId: ids.contract, caseId: ids.case, scope: "base" },
  };
}

describe("AI snapshot and source identity", () => {
  it("rejects_context_from_another_snapshot_even_with_identical_definition", () => {
    const input = contractInput();
    input.context = createProjectSnapshot(createContractExecutionProject("https://api.example.com")).context;
    expect(() => prepareAiContext(input)).toThrow(/snapshot-context-mismatch/);
  });
  it("rejects_stale_definition_revision", () => {
    const input = contractInput(); input.source.definitionRevision = "old";
    expect(() => prepareAiContext(input)).toThrow(/source-binding-mismatch/);
  });
  it.each(["collectionId", "folderIds", "apiId", "caseId", "scope"] as const)("rejects_noncurrent_complete_locator: %s", field => {
    const input = contractInput();
    input.target = { ...input.target, [field]: field === "folderIds" ? [] : "not-current" };
    expect(() => prepareAiContext(input)).toThrow(/target-not-found/);
  });
  it.each(["serverIdentity", "memberIdentity", "workspaceId", "groupId", "serverProjectId", "projectVersion", "editRevision", "definitionRevision"] as const)("online_source_comparison_distinguishes_same_core_uuid: %s", field => {
    const source: AiSourceBinding = {
      kind: "online", bindingId: "stable-online-scope", projectId: ids.project, definitionRevision: "revision", editRevision: 0,
      serverIdentity: "opaque-server", memberIdentity: "opaque-member", workspaceId: "workspace-1", groupId: "group-1", serverProjectId: "server-project-1", projectVersion: "v1",
    };
    const other = { ...source, [field]: field === "editRevision" ? 1 : "changed" };
    expect(sameAiSourceBinding(source, other)).toBe(false);
  });
  it("local_source_comparison_distinguishes_roots", () => {
    const source = contractInput().source as Extract<AiSourceBinding, { kind: "local" }>;
    expect(sameAiSourceBinding(source, { ...source, rootIdentity: "another-root" })).toBe(false);
  });
  it("preview_contains_safe_stable_source_summary_and_complete_messages", () => {
    const input = contractInput();
    const preview = prepareAiContext(input);
    expect(preview.source).toEqual({ bindingId: "stable-local-project-key", kind: "local", projectId: ids.project, definitionRevision: input.snapshot.definitionRevision, editRevision: 0, target: input.target, unsaved: false });
    expect(JSON.stringify(preview)).not.toContain("opaque-canonical-root");
    expect(preview.messages.map(m => m.role)).toEqual(["system", "user"]);
    expect(preview.bytes).toBe(new TextEncoder().encode(JSON.stringify({ messages: preview.messages, outputSchema: preview.outputSchema, instruction: preview.messages.filter(m => m.role === "system").map(m => m.content).join("\n") })).byteLength);
  });
  it("online_preview_never_returns_member_or_server_identity", () => {
    const input = contractInput();
    input.source = { ...input.source, kind: "online", serverIdentity: "private-server-id", memberIdentity: "private-member-id", workspaceId: "ws", groupId: "group", serverProjectId: "remote-project", projectVersion: "v3" };
    const preview = prepareAiContext(input);
    expect(preview.source).toMatchObject({ kind: "online", projectVersion: "v3" });
    expect(JSON.stringify(preview)).not.toMatch(/private-server-id|private-member-id|rootIdentity/);
  });
});

describe("AI contract safety projection", () => {
  it("omits_body_scripts_and_dataset_rows_by_default_but_keeps_contract_shape", () => {
    const input = contractInput();
    const preview = prepareAiContext(input);
    const text = JSON.stringify(preview);
    expect(text).toContain("snapshot-request");
    expect(text).toContain("snapshot-case");
    expect(text).not.toContain("ancestorValue");
    expect(preview.omitted).toEqual(expect.arrayContaining([expect.objectContaining({ item: "contract:request-body" }), expect.objectContaining({ item: "scripts" }), expect.objectContaining({ item: "dataset-rows" })]));
  });
  it("explicit_contract_body_is_redacted_and_bounded", () => {
    const project = createContractExecutionProject("https://api.example.com");
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    if (asset.contract.request.protocol !== "http") throw new Error("HTTP fixture required");
    asset.contract.request.body = { kind: "json", content: JSON.stringify({ password: "body-private", description: "汉".repeat(5000) }) };
    const snapshot = createProjectSnapshot(project);
    const input = contractInput(); input.snapshot = snapshot; input.context = snapshot.context; input.source.definitionRevision = snapshot.definitionRevision; input.bodySelection = ["contract:request-body"];
    const preview = prepareAiContext(input);
    const text = preview.messages.map(m => m.content).join("\n");
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("body-private");
    expect(new TextEncoder().encode(text).byteLength).toBeLessThan(12000);
    expect(preview.omitted).toEqual(expect.arrayContaining([expect.objectContaining({ item: "contract:request-body", reason: "truncated" })]));
  });
  it("redacts_documentation_parameter_text_url_credentials_and_absolute_paths", () => {
    const project = createContractExecutionProject("https://api.example.com");
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.contract.request.baseUrl = "https://user:url-private@example.com?token=query-private";
    asset.documentation = 'Authorization: Bearer docs-private\nC:\\Users\\private\\keys.pem\n/home/private/keys.pem\n-----BEGIN PRIVATE KEY-----\nkey-private\n-----END PRIVATE KEY-----';
    asset.contract.request.query[0] = { kind: "inline", id: "10000000-0000-4000-8000-000000000006", name: "memo", schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "", value: "password=parameter-private" };
    const snapshot = createProjectSnapshot(project);
    const input = contractInput(); input.snapshot = snapshot; input.context = snapshot.context; input.source.definitionRevision = snapshot.definitionRevision;
    const preview = prepareAiContext(input);
    expect(preview.messages.map(m => m.content).join("\n")).toContain("[REDACTED]");
    expect(JSON.stringify(preview)).not.toMatch(/url-private|query-private|docs-private|keys.pem|key-private|parameter-private/);
    expect(preview.redaction).toMatchObject({ strategy: "heuristic", limitations: expect.arrayContaining([expect.stringMatching(/自定义秘密/)]) });
  });
  it("uses_only_reachable_models_and_retains_missing_and_cycle_diagnostics", () => {
    const project = createContractExecutionProject("https://api.example.com");
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    if (asset.contract.request.protocol !== "http" || asset.contract.request.body.kind !== "json") throw new Error("JSON fixture required");
    asset.contract.request.body.schema = { kind: "modelRef", modelId: "10000000-0000-4000-8000-000000000010" };
    project.models.push(
      { formatVersion: 1, id: "10000000-0000-4000-8000-000000000010", name: "Reachable", description: "", schema: { kind: "object", properties: { self: { kind: "modelRef", modelId: "10000000-0000-4000-8000-000000000010" }, missing: { kind: "modelRef", modelId: "10000000-0000-4000-8000-000000000011" } }, required: [], additionalProperties: false } },
      { formatVersion: 1, id: "10000000-0000-4000-8000-000000000012", name: "Unrelated-private-model", description: "", schema: { kind: "scalar", type: "string" } },
    );
    const snapshot = createProjectSnapshot(project);
    const input = contractInput(); input.snapshot = snapshot; input.context = snapshot.context; input.source.definitionRevision = snapshot.definitionRevision;
    const text = JSON.stringify(prepareAiContext(input));
    expect(text).toContain("Reachable"); expect(text).toContain("unresolved"); expect(text).toContain("modelRef");
    expect(text).not.toContain("Unrelated-private-model");
  });
  it("rejects_unknown_body_selection_instead_of_fetching_data", () => {
    const input = contractInput(); input.bodySelection = ["C:/private/request.json"];
    expect(() => prepareAiContext(input)).toThrow(/body-selection-unavailable/);
  });
  it("rejects_context_exceeding_explicit_byte_budget", () => {
    const input = contractInput(); input.maxContextBytes = 32;
    expect(() => prepareAiContext(input)).toThrow(/context-budget/);
  });
  it.each([0, -1, 1.5, NaN])("rejects_invalid_context_budget: %s", maxContextBytes => {
    expect(() => prepareAiContext({ ...contractInput(), maxContextBytes })).toThrow(/context-budget-invalid/);
  });
  it("uses_valid_current_contract_draft_only_and_marks_edit_revision_unsaved", () => {
    const input = contractInput(); input.source.editRevision = 2;
    const contract = ApiContractSchema.parse(structuredClone(input.snapshot.project.collections[0]!.folders[0]!.folders[0]!.apis[0]!.contract));
    contract.metadata.name = "Unsaved current contract";
    input.currentDraft = { locator: input.target, contract, editRevision: 2 };
    const preview = prepareAiContext(input);
    expect(preview.messages.map(m => m.content).join("\n")).toContain("Unsaved current contract");
    expect(preview.source).toMatchObject({ unsaved: true, editRevision: 2 });
    expect(input.snapshot.project.collections[0]!.folders[0]!.folders[0]!.apis[0]!.contract.metadata.name).toBe("snapshot-request");
  });
  it.each(["locator", "contract-id", "edit-revision", "schema"] as const)("rejects_noncurrent_or_invalid_draft: %s", kind => {
    const input = contractInput();
    const contract = ApiContractSchema.parse(structuredClone(input.snapshot.project.collections[0]!.folders[0]!.folders[0]!.apis[0]!.contract));
    input.currentDraft = { locator: { ...input.target }, contract, editRevision: 0 };
    if (kind === "locator") input.currentDraft.locator.scope = "other";
    if (kind === "contract-id") contract.id = "10000000-0000-4000-8000-000000000099";
    if (kind === "edit-revision") input.currentDraft.editRevision = 1;
    if (kind === "schema") Object.assign(contract.request, { method: "INVALID" });
    expect(() => prepareAiContext(input)).toThrow(/draft-invalid/);
  });
});

describe("final context boundary cases", () => {
  it("final B I4 valid context yields selectable metadata without values or default-off body content", () => {
    const input = contractInput();
    const prepared = prepareAiContext(input); // Same real snapshot/locator already works.
    expect(prepared.source.target).toEqual(input.target);
    const outcome = (() => { try { return { value: inspectAiContextChoices(input) }; } catch (error) { return { error }; } })();
    expect(outcome).toMatchObject({ value: { source: { projectId: ids.project, target: input.target }, bodies: [{ location: "contract:request-body", kind: "contract-request", available: true }] } });
    if ("value" in outcome) {
      expect(Object.keys(outcome.value!.bodies[0]!).sort()).toEqual(["available", "kind", "location"]);
      expect(JSON.stringify(outcome.value)).not.toContain("request.body.content");
    }
  });
  it("final B M1 describes only the final selected body evidence as included", () => {
    const value = contractInput(), location = "cases[0].evidence.response.body";
    const report = { projectId: value.snapshot.project.id, definitionRevision: value.snapshot.definitionRevision, collectionId: ids.collection, collectionName: "saved report", startedAt: "2026-11-01T00:00:00Z", finishedAt: "2026-11-01T00:00:01Z", total: 1, passed: 0, failed: 1,
      cases: [{ apiId: ids.contract, apiName: "api", caseId: ids.case, caseName: "saved", passed: false, durationMs: 1, assertions: [],
        evidence: { identity: { projectId: value.snapshot.project.id, definitionRevision: value.snapshot.definitionRevision, locator: { ...value.target, caseId: ids.case, scope: "base" } }, state: "collected" as const, scriptDiagnostics: "not-collected" as const, truncated: false,
          response: { status: 503, headers: { text: "", truncated: false }, body: { text: "FINAL_B_UNSELECTED_BODY", truncated: false } } } }] };
    const before = JSON.stringify(report);
    const input = { ...value, purpose: "report-analysis" as const, reportId: "final-b-report", report, bodySelection: [location] };
    const full = prepareAiContext(input), summary = full.evidence.find(item => item.kind === "logical-summary")!;
    const selected = prepareAiContext({ ...input, evidenceSelection: [summary.id] });
    expect.soft(selected.included).not.toContain(location);
    expect.soft(selected.evidence.some(item => item.kind === "body")).toBe(false);
    expect.soft(JSON.stringify(selected.messages)).not.toContain("FINAL_B_UNSELECTED_BODY");
    expect(JSON.stringify(report)).toBe(before);
  });
  // I3: generic text can contain several URLs; a single-URL helper must not leave later credentials.
  it("fix1_redacts_every_url_userinfo_in_documentation_and_keeps_query_protection", () => {
    const project = createContractExecutionProject("https://api.example.com");
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.documentation = "https://alpha:first-private@example.com/a?token=query-private&mode=keep https://beta:second-private@example.org/b";
    const before = JSON.stringify(project);
    const snapshot = createProjectSnapshot(project); const value = contractInput();
    value.snapshot = snapshot; value.context = snapshot.context; value.source.definitionRevision = snapshot.definitionRevision;
    const text = JSON.stringify(prepareAiContext(value));
    expect(text).not.toMatch(/alpha|first-private|beta|second-private|query-private/);
    expect(text).toContain("example.com/a"); expect(text).toContain("example.org/b");
    expect(JSON.stringify(project)).toBe(before);
  });
  it("case_suggestion_supports_a_current_api_without_existing_cases", () => {
    const project = createContractExecutionProject("https://api.example.com");
    project.collections[0]!.folders[0]!.folders[0]!.apis[0]!.cases = [];
    const snapshot = createProjectSnapshot(project); const value = contractInput();
    value.snapshot = snapshot; value.context = snapshot.context; value.source.definitionRevision = snapshot.definitionRevision;
    // The case-suggestion target is the API; it need not invent an existing case identity.
    const target = { collectionId: ids.collection, folderIds: [ids.outerFolder, ids.innerFolder], apiId: ids.contract };
    const outcome = (() => { try { return { preview: prepareAiContext({ ...value, target } as unknown as AiContextInput) }; } catch (error) { return { error }; } })();
    expect(outcome).toMatchObject({ preview: { purpose: "case-suggestion", source: { target } } });
  });
  it("redacts_unc_paths_and_file_uris_in_selected_documentation", () => {
    const project = createContractExecutionProject("https://api.example.com");
    project.collections[0]!.folders[0]!.folders[0]!.apis[0]!.documentation = "\\\\server\\share\\unc-private.key file:///srv/local/file-private.key";
    const snapshot = createProjectSnapshot(project); const value = contractInput();
    value.snapshot = snapshot; value.context = snapshot.context; value.source.definitionRevision = snapshot.definitionRevision;
    expect(JSON.stringify(prepareAiContext(value))).not.toMatch(/unc-private.key|file-private.key/);
  });
  it.each(["none", "binary", "websocket-empty"] as const)("cannot_select_nonexistent_or_file_body: %s", kind => {
    const project = createContractExecutionProject("https://api.example.com");
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    if (asset.contract.request.protocol !== "http") throw new Error("HTTP fixture required");
    if (kind === "websocket-empty") {
      const { protocol: _protocol, method: _method, body: _body, ...rest } = asset.contract.request;
      asset.contract.request = { ...rest, protocol: "websocket" };
    } else asset.contract.request.body = kind === "none" ? { kind } : { kind, file: { path: "C:/private/file.bin" }, contentType: "application/octet-stream" };
    const snapshot = createProjectSnapshot(project); const value = contractInput();
    value.snapshot = snapshot; value.context = snapshot.context; value.source.definitionRevision = snapshot.definitionRevision; value.bodySelection = ["contract:request-body"];
    expect(() => prepareAiContext(value)).toThrow(/body-selection-unavailable/);
  });
});

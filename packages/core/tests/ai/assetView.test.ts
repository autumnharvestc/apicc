import { expect, it } from "vitest";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import { projectAiAsset } from "../../src/ai/assetView.js";
import { prepareAiContext } from "../../src/ai/context.js";
import { ContractProjectSchema } from "../../src/contract/workspace.js";
import { ResponseSelectorSchema } from "../../src/testing/model.js";
import { selectResponseValue } from "../../src/assert/selection.js";
import { compileCaseAssertions } from "../../src/assert/evaluate.js";
import { builtinAssertOperators } from "../../src/assert/operators.js";
import { createPluginRegistry } from "../../src/plugin/registry.js";
import { projectionProject, designDocumentIds as ids } from "../helpers/designDocumentFixture.js";

function fixture() {
  const project = projectionProject();
  project.collections[0]!.apis[0]!.cases = [{ id: "saved", name: "saved", scope: "base", parameters: { password: "OPAQUE_PARAMETER", limit: "5" }, preOperations: [{ id: "source", type: "script", content: "PRIVATE_SCRIPT" }], postOperations: [], assertions: [{ id: "assert", target: "header", headerName: "x-api-key", op: "eq", expected: "OPAQUE_ASSERTION" }] }];
  project.components.push({ formatVersion: 1, id: "10000000-0000-4000-8000-000000000020", name: "response", description: "", kind: "response", definition: { status: "200", description: "", headers: { "x-api-key": "OPAQUE_HEADER", "X-Business": "visible" }, content: {} } });
  const snapshot = createProjectSnapshot(project);
  const locator = { collectionId: project.collections[0]!.id, folderIds: [], apiId: ids.contract, caseId: "saved", scope: "base" };
  return { project, snapshot, locator };
}

// Final C1: losing the typed selector must fail at the actual outbound messages,
// while MCP and builtin AI retain the same saved assertion and do not mutate it.
it.each([
  { name: "sensitive header", selector: { target: "header" as const, headerName: "x-api-key" }, expected: "OPAQUE_A1", want: "[REDACTED]" },
  { name: "sensitive cookie", selector: { target: "cookie" as const, cookieName: "session_id" }, expected: "OPAQUE_A2", want: "[REDACTED]" },
  { name: "normalized saved JSONPath", selector: { target: "bodyJson" as const, path: '$.users[0]["pass\\u0077ord"]' }, expected: "OPAQUE_A3", want: "[REDACTED]" },
  { name: "ordinary assertion", selector: { target: "bodyJson" as const, path: "$.state" }, expected: "ready", want: "ready" },
])("final C1 projects $name consistently across builtin AI and MCP", ({ selector, expected, want }) => {
  const f = fixture();
  f.project.collections[0]!.apis[0]!.cases[0]!.assertions = [{ id: "typed", ...selector, op: "eq", expected }];
  const project = ContractProjectSchema.parse(f.project), before = JSON.stringify(project), snapshot = createProjectSnapshot(project);
  const preview = prepareAiContext({ purpose: "assertion-suggestion", target: f.locator, basis: { kind: "contract" }, snapshot, context: snapshot.context,
    source: { kind: "local", bindingId: "final-c1", rootIdentity: "owned-root", projectId: project.id, definitionRevision: snapshot.definitionRevision, editRevision: 0 }, bodySelection: [] });
  const message = JSON.parse(preview.messages.find(item => item.role === "user")!.content);
  const asset = projectAiAsset(snapshot, { kind: "case", locator: f.locator });
  expect.soft(message.view.currentCase.assertions).toMatchObject([{ id: "typed", ...selector, expected: want }]);
  expect.soft(asset.asset.assertions).toMatchObject([{ id: "typed", ...selector, expected: want }]);
  if (want === "[REDACTED]") { expect.soft(JSON.stringify(preview.messages)).not.toContain(expected); expect.soft(JSON.stringify(asset)).not.toContain(expected); }
  expect(JSON.stringify(project)).toBe(before); expect(JSON.stringify(snapshot.project)).toBe(before);
});

it("projectAiAsset retains model declarations and typed masked schema defaults", () => {
  const f = fixture(); const output = projectAiAsset(f.snapshot, { kind: "models", id: ids.model });
  expect(output.asset).toMatchObject({ id: ids.model, schema: { kind: "object", properties: { password: { kind: "scalar", type: "string", default: "[REDACTED]" }, related: { kind: "modelRef", modelId: ids.model } } } });
  expect(f.snapshot.project.models[0]!.schema).toMatchObject({ properties: { password: { default: "synthetic-import-token" } } });
});
it("projectAiAsset selects a saved case and protects parameter values by their typed names", () => {
  const f = fixture(); const output = projectAiAsset(f.snapshot, { kind: "case", locator: f.locator });
  expect(output.asset).toMatchObject({ id: "saved", locator: f.locator, parameters: { password: "[REDACTED]", limit: "5" } });
  expect(JSON.stringify(output)).not.toContain("OPAQUE_PARAMETER"); expect(JSON.stringify(output)).not.toContain("PRIVATE_SCRIPT");
});
it("projectAiAsset protects assertion expected values using their typed header selector", () => {
  const f = fixture(); const output = projectAiAsset(f.snapshot, { kind: "case", locator: f.locator });
  expect(output.asset.assertions).toMatchObject([{ target: "header", headerName: "x-api-key", op: "eq", expected: "[REDACTED]" }]);
  expect(JSON.stringify(output)).not.toContain("OPAQUE_ASSERTION");
});
it("projectAiAsset protects response component headers by their typed names", () => {
  const f = fixture(); const output = projectAiAsset(f.snapshot, { kind: "components", id: "10000000-0000-4000-8000-000000000020" });
  expect(output.asset).toMatchObject({ kind: "response", definition: { status: "200", headers: { "x-api-key": "[REDACTED]", "X-Business": "visible" } } });
  expect(JSON.stringify(output)).not.toContain("OPAQUE_HEADER");
});
it("projectAiAsset refuses a saved case selection from an unrelated locator", () => {
  const f = fixture();
  expect(() => projectAiAsset(f.snapshot, { kind: "case", locator: { ...f.locator, scope: "other" } })).toThrow(/asset|target|selection/);
});
it("projectAiAsset masks a workflow comparison literal using the referenced sensitive field", () => {
  const f = fixture(); f.project.workflows.push({ id: "workflow", name: "workflow", status: "published", executionVersion: 2, nodes: [{ id: "condition", kind: "condition", predicate: { op: "eq", left: { kind: "ref", source: "inputs", path: ["password"] }, right: { kind: "literal", value: "OPAQUE_WORKFLOW_EXPECTED" } } }], edges: [], inputs: {}, outputs: {}, limits: { maxConcurrency: 1, timeoutMs: 1000 } });
  const output = projectAiAsset(createProjectSnapshot(f.project), { kind: "workflows", id: "workflow" });
  expect(output.asset.nodes).toMatchObject([{ predicate: { right: { kind: "literal", value: "[REDACTED]" } } }]);
  expect(JSON.stringify(output)).not.toContain("OPAQUE_WORKFLOW_EXPECTED");
});

// Passing a raw selector as a field name leaks quoted/escaped credential keys.
it.each([
  { name: "single-quoted child", path: "$['password']", body: { password: "OPAQUE_SELECTOR_EXPECTED" } },
  { name: "escaped double-quoted child after an index", path: '$.users[0]["pass\\u0077ord"]', body: { users: [{ password: "OPAQUE_SELECTOR_EXPECTED" }] } },
  { name: "recursive and wildcard child", path: "$..users[*]['password']", body: { nested: { users: [{ password: "OPAQUE_SELECTOR_EXPECTED" }] } } },
])("N1 projectAiAsset protects expected for $name using accepted selector semantics", ({ path, body }) => {
  const f = fixture();
  f.project.collections[0]!.apis[0]!.cases[0]!.assertions = [
    { id: "sensitive", target: "bodyJson", path, op: "eq", expected: "OPAQUE_SELECTOR_EXPECTED" },
    { id: "ordinary", target: "bodyJson", path: "$['state']", op: "eq", expected: "ready" },
  ];
  const project = ContractProjectSchema.parse(f.project); const before = JSON.stringify(project);
  const selector = ResponseSelectorSchema.parse({ target: "bodyJson", path });
  expect(selectResponseValue(selector, { status: 200, headers: {}, bodyText: JSON.stringify(body), timeMs: 1 })).toMatchObject({ found: true, value: "OPAQUE_SELECTOR_EXPECTED" });
  const snapshot = createProjectSnapshot(project); const output = projectAiAsset(snapshot, { kind: "case", locator: f.locator });
  expect(output.asset.assertions).toMatchObject([{ id: "sensitive", path, expected: "[REDACTED]" }, { id: "ordinary", path: "$['state']", expected: "ready" }]);
  expect(output.asset.locator).toEqual(f.locator); expect(JSON.stringify(output)).not.toContain("OPAQUE_SELECTOR_EXPECTED");
  expect(JSON.stringify(project)).toBe(before); expect(JSON.stringify(snapshot.project)).toBe(before);
});

// A strict standalone parser cannot replace the saved-assertion compatibility boundary.
it.each([
  { name: "ordinary property", path: "state", normalized: "$.state", expected: "ready", want: "ready", body: { state: "ready" } },
  { name: "sensitive indexed property", path: "users[0].password", normalized: "$.users[0].password", expected: "OPAQUE_ROOTLESS_EXPECTED", want: "[REDACTED]", body: { users: [{ password: "OPAQUE_ROOTLESS_EXPECTED" }] } },
])("N3 projectAiAsset reads a compiler-valid legacy $name without changing its saved path", ({ path, normalized, expected, want, body }) => {
  const f = fixture(); f.project.collections[0]!.apis[0]!.cases[0]!.assertions = [{ id: "legacy", target: "bodyJson", op: "eq", path, expected }];
  const project = ContractProjectSchema.parse(f.project); const before = JSON.stringify(project); const snapshot = createProjectSnapshot(project);
  const registry = createPluginRegistry(); for (const operator of builtinAssertOperators) registry.registerAssert(operator);
  const saved = project.collections[0]!.apis[0]!.cases[0]!; const compiled = compileCaseAssertions(saved, snapshot.context, registry);
  expect(compiled.diagnostics).toEqual([]); expect(compiled.assertions[0]!.selector.path).toBe(normalized);
  const response = { status: 200, headers: {}, timeMs: 1, bodyText: JSON.stringify(body) };
  expect(selectResponseValue(compiled.assertions[0]!.selector, response)).toMatchObject({ found: true, value: expected });
  expect(() => selectResponseValue({ target: "bodyJson", path, match: "first" }, response)).toThrow(/begin with/);
  const output = projectAiAsset(snapshot, { kind: "case", locator: f.locator });
  expect(output.asset.assertions).toMatchObject([{ id: "legacy", path, expected: want }]); expect(output.asset.locator).toEqual(f.locator);
  if (want === "[REDACTED]") expect(JSON.stringify(output)).not.toContain("OPAQUE_ROOTLESS_EXPECTED");
  expect(JSON.stringify(project)).toBe(before); expect(JSON.stringify(snapshot.project)).toBe(before);
});

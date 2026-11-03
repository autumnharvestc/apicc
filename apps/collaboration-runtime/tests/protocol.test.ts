import { expect, it } from "vitest";
import { CompiledMockPlanSchema, CompileMockInputWireSchema, CompileMockResultSchema, MockEvaluationResultWireSchema, SharedMockPolicySchema, PublicationInputSchema, ProjectionPolicySchema } from "@apicc/core/collaboration/shared";
import { evaluateMock } from "@apicc/core/collaboration";
import { handleOperation } from "../src/handlers.js";
import { PlanCache } from "../src/cache.js";
import { digestJson } from "../src/protocol.js";
import { encodeContractProjectFiles, decodeContractProjectFiles } from "../../../packages/core/src/storage/contractFiles.js";
import { createMockConfiguredProject } from "../../../packages/core/tests/helpers/mockFixtures.js";
import { archiveInput, policy, stressReport, safeDocument } from "../../../packages/core/tests/collaboration/fixtures.js";

const mockPolicy = { maxResponseBytes: 1024, maxDelayMs: 30000, requestDeadlineMs: 35000,
  extraSensitiveHeaders: [], extraSensitiveQuery: [], extraSensitiveFields: [], extraSensitivePointers: [] };
function savedFiles(forbiddenHeader = false, large = false) {
  const project = createMockConfiguredProject();
  const response = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!.contract.responses[0]!;
  if (response.kind !== "inline") throw new Error("inline required");
  if (!forbiddenHeader) delete response.headers["Content-Length"];
  if (large) response.content["application/json"]!.examples[0] = { kind: "inline", id: "10000000-0000-4000-8000-000000000014", name: "large", value: "x".repeat(1024) };
  return [...encodeContractProjectFiles(project).files].map(([path, content]) => ({ path, content }));
}
it("compiles actual validated fixed files through the narrow Core seam", async () => {
  const files = savedFiles();
  const loaded = await decodeContractProjectFiles(new Map(files.map(file => [file.path, file.content])));
  expect(loaded.problems).toEqual([]); expect(loaded.readOnly).toBe(false);
  expect(CompileMockInputWireSchema.safeParse({ files }).success).toBe(true);
  expect(SharedMockPolicySchema.safeParse(mockPolicy).success).toBe(true);
  expect(await handleOperation("compile-mock", { input: { files }, policy: mockPolicy })).toMatchObject({ ok: true, plan: { routes: [{ pathTemplate: "/items/{id}", rules: [{ body: Array.from(Buffer.from('{"id":"item-7"}')) }] }] } });
});
it("shared compile refuses original filtered response headers with location", async () => {
  expect(await handleOperation("compile-mock", { input: { files: savedFiles(true) }, policy: mockPolicy })).toMatchObject({ ok: false, diagnostics: [{ code: "SHARED_MOCK_RESPONSE_HEADER_FORBIDDEN", path: "routes[0].rules[0].headers.Content-Length" }] });
});
it("shared compile passes effective response cap explicitly", async () => {
  expect(await handleOperation("compile-mock", { input: { files: savedFiles(false, true) }, policy: mockPolicy })).toMatchObject({ ok: false, diagnostics: [{ code: "MOCK_RESPONSE_TOO_LARGE" }] });
});
it.each([
  ["missing policy", () => ({ input: { files: savedFiles() } })],
  ["unknown field", () => ({ input: { files: savedFiles() }, policy: mockPolicy, raw: "private" })],
])("strict compile wrapper rejects %s", async (_name, payload) => {
  await expect(handleOperation("compile-mock", payload())).rejects.toThrow("RPC_INVALID_REQUEST");
});
it("rejects duplicate mutation file paths before Map overwrite", async () => {
  const files = savedFiles();
  await expect(handleOperation("classify-asset-mutation", { beforeFiles: [...files, files[0]], afterFiles: files })).rejects.toThrow("RPC_DUPLICATE_PATH");
});
it("dispatches mutation script changes through real Core classifier", async () => {
  const before = savedFiles(); const after = savedFiles();
  const project = createMockConfiguredProject();
  project.collections[0]!.preOperations.push({ id: "10000000-0000-4000-8000-000000000099", type: "script", content: "synthetic script" });
  const changed = [...encodeContractProjectFiles(project).files].map(([path, content]) => ({ path, content }));
  expect(await handleOperation("classify-asset-mutation", { beforeFiles: before, afterFiles: changed })).toMatchObject({ scriptChanged: true });
  expect(await handleOperation("classify-asset-mutation", { beforeFiles: after, afterFiles: after })).toEqual({ scriptChanged: false, locations: [] });
});
it("posthoc accepted fixture correction proves both wire byte conversion boundaries", async () => {
  // Original handwritten segments omitted Core's leading empty path segment.
  // This corrected proof is postimplementation, explicitly accepted by the user.
  const project = createMockConfiguredProject();
  const api = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
  if (api.contract.request.protocol !== "http" || api.contract.responses[0]!.kind !== "inline") throw new Error("HTTP inline fixture required");
  api.contract.request.method = "POST"; delete api.contract.responses[0]!.headers["Content-Length"];
  project.mock.rules[0]!.status = 201;
  project.mock.rules[0]!.conditions = [{ source: "body", pointer: "/name", op: "equals", value: "item" }];
  const files = [...encodeContractProjectFiles(project).files].map(([path, content]) => ({ path, content }));
  const compiled = CompileMockResultSchema.parse(await handleOperation("compile-mock", { input: { files }, policy: mockPolicy }));
  if (!compiled.ok) throw new Error("Valid fixture must compile");
  const input = { method: "POST", target: "/items/7", headers: {}, body: new TextEncoder().encode('{"name":"item"}') };
  const direct = evaluateMock(compiled.plan, input);
  expect.soft(direct).toMatchObject({ status: 201 }); expect.soft(direct.body).toBeInstanceOf(Uint8Array);
  expect(evaluateMock(compiled.plan, { ...input, body: new Uint8Array() }).status).toBe(501);
  const wire = MockEvaluationResultWireSchema.parse(await handleOperation("respond-mock", { plan: compiled.plan, policy: mockPolicy, input: { ...input, body: Array.from(input.body) } }));
  expect.soft(wire.status).toBe(201); expect.soft(Array.isArray(wire.body)).toBe(true);
  expect(wire.body).toEqual(Array.from(Buffer.from('{"id":"item-7"}')));
});
it.each([[-1], [256], [1.5]])("rejects non-byte wire body %j before conversion", async body => {
  expect(SharedMockPolicySchema.safeParse(mockPolicy).success).toBe(true);
  await expect(handleOperation("respond-mock", { plan: { sourceProjectRevision: "r1", routes: [] }, policy: mockPolicy, input: { method: "GET", target: "/", headers: {}, body: [body] } })).rejects.toThrow("RPC_INVALID_REQUEST");
});
it("rejects structurally valid but Core arithmetic-invalid stress report", async () => {
  const body = stressReport(); body.requests.completed = 3;
  const input = { ...archiveInput(), report: { format: "stress", body } };
  expect(PublicationInputSchema.safeParse(input).success).toBe(true);
  expect(ProjectionPolicySchema.safeParse(policy).success).toBe(true);
  await expect(handleOperation("project-report", { input, policy })).rejects.toThrow("PUBLICATION_SOURCE_INVALID");
});
it("projects fully valid report and member document through Core", async () => {
  const report = { ...archiveInput(), report: { format: "stress", body: stressReport() } };
  expect(PublicationInputSchema.safeParse(report).success).toBe(true);
  expect(await handleOperation("project-report", { input: report, policy })).toMatchObject({ kind: "report", report: { sourceCategory: "stress" } });
  expect(await handleOperation("project-document", { input: { sourceKind: "member-upload", artifact: safeDocument() }, policy })).toMatchObject({ kind: "document" });
});
it("strict operation distinguishes document from report inputs", async () => {
  await expect(handleOperation("project-document", { input: archiveInput(), policy })).rejects.toThrow("RPC_INVALID_REQUEST");
});
it("rejects conflicting pure compile cap rather than silently overriding", async () => {
  await expect(handleOperation("compile-mock", { input: { files: savedFiles(), maxResponseBytes: 2048 }, policy: mockPolicy })).rejects.toThrow("RPC_POLICY_MISMATCH");
});
it("requires effective policy on reloaded respond plans", async () => {
  await expect(handleOperation("respond-mock", { plan: { sourceProjectRevision: "r1", routes: [] }, input: { method: "GET", target: "/", headers: {}, body: [] } })).rejects.toThrow("RPC_INVALID_REQUEST");
});
it("rejects unsafe reloaded plans before caching or evaluation", async () => {
  const plan = { sourceProjectRevision: "r1", routes: [{ contractId: "api", method: "GET", pathTemplate: "/", segments: [], rules: [{ id: "rule", contractId: "api", responseBindingId: "response", conditions: [], status: 200, mediaType: "text/plain", headers: { "Set-Cookie": "synthetic" }, body: [], delayMs: 0 }] }] };
  expect(CompiledMockPlanSchema.safeParse(plan).success).toBe(true);
  await expect(handleOperation("respond-mock", { plan, policy: mockPolicy, input: { method: "GET", target: "/", headers: {}, body: [] } })).rejects.toThrow("RPC_PLAN_UNSAFE");
});
it("reloads a fixed safe plan after cache loss and never substitutes mismatched digest", async () => {
  const plan = { sourceProjectRevision: "r1", routes: [] }; const input = { method: "GET", target: "/", headers: {}, body: [] };
  const planDigest = digestJson(plan); const cache = new PlanCache(4096, "test-core");
  await expect.soft(handleOperation("respond-mock", { planDigest, policy: mockPolicy, input }, { cache })).rejects.toThrow("RPC_PLAN_UNAVAILABLE");
  expect.soft(await handleOperation("respond-mock", { plan, planDigest, policy: mockPolicy, input }, { cache })).toMatchObject({ status: 404 });
  expect.soft(await handleOperation("respond-mock", { planDigest, policy: mockPolicy, input }, { cache })).toMatchObject({ status: 404 });
  await expect.soft(handleOperation("respond-mock", { plan, planDigest: "0".repeat(64), policy: mockPolicy, input }, { cache })).rejects.toThrow("RPC_PLAN_DIGEST_MISMATCH");
});
it("rejects duplicate compile source paths before decoder assembly", async () => {
  const files = savedFiles();
  await expect(handleOperation("compile-mock", { input: { files: [...files, files[0]] }, policy: mockPolicy })).rejects.toThrow("RPC_DUPLICATE_PATH");
});

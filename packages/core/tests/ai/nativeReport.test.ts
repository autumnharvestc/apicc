import { expect, it } from "vitest";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import { prepareAiContext, type AiContextInput } from "../../src/ai/context.js";
import { DebugResultSchema } from "../../src/debug/model.js";
import { failedDebugResult, prepareDebugExecution } from "../../src/debug/service.js";
import { projectionProject, designDocumentIds as ids } from "../helpers/designDocumentFixture.js";

function fixture() {
  const snapshot = createProjectSnapshot(projectionProject());
  const locator = { workspaceId: "workspace", groupId: "group", projectId: snapshot.project.id, collectionId: snapshot.project.collections[0]!.id, folderIds: [], apiId: ids.contract };
  const savedCase = { ...locator, caseId: "saved", scope: "base" };
  const report = DebugResultSchema.parse({ runId: "native-run", source: { sourceKind: "asset", locator, sourceApiRevision: "api-revision" }, sourceProjectRevision: "archived-source-revision", executionSnapshotRevision: "different-materialized-revision", mode: "case",
    startedAt: "2026-10-30T00:00:00.000Z", finishedAt: "2026-10-30T00:00:01.000Z", run: { collectionName: "native", startedAt: "2026-10-30T00:00:00.000Z", finishedAt: "2026-10-30T00:00:01.000Z", total: 1, passed: 0, failed: 1 },
    outcomes: [{ apiName: "native-api", caseName: "native-case", identityAvailable: false, passed: false, durationMs: 12, assertions: [{ pass: false, message: "503 != 200" }] }],
    exchanges: [{ source: { sourceKind: "asset", case: savedCase }, rowIndex: 0, hopIndex: 0, order: 1, transportState: "responded", settings: { connectTimeoutMs: 1000, headersTimeoutMs: 1000, bodyTimeoutMs: 1000, totalTimeoutMs: 1000, followRedirects: false, maxRedirects: 0, uploadLimitBytes: 4096, responseLimitBytes: 4096 }, startedAt: "2026-10-30T00:00:00.000Z",
      request: { method: "GET", url: "https://user:PRIVATE_URL@example.test/?password=PRIVATE_QUERY&visible=yes", query: [], headers: [["x-api-key", "OPAQUE_REQUEST_HEADER"]], cookies: [], body: { kind: "text", text: '{"password":"PRIVATE_BODY","state":"visible"}', contentBytes: 50, truncated: false } },
      response: { status: 503, headers: [["Set-Cookie", "OPAQUE_RESPONSE_COOKIE"]], cookies: [], body: { kind: "text", text: "visible response body", contentBytes: 21, truncated: false } },
    }], exchangeTotal: 1, omittedExchangeCount: 0, replay: { mode: "case", sourceKind: "asset", case: savedCase, parameters: {}, fields: [], available: true }, console: [], warnings: [] });
  const input = { purpose: "report-analysis", reportId: "opaque-report", snapshot, context: snapshot.context, source: { kind: "local", bindingId: "binding", rootIdentity: "root-hash", projectId: snapshot.project.id, definitionRevision: snapshot.definitionRevision, editRevision: 0 }, bodySelection: [], report } as unknown as Extract<AiContextInput, { purpose: "report-analysis" }>;
  return { snapshot, report, input };
}

it("native debug projection copies real logical counters without fabricating outcome identities", () => {
  const f = fixture(); const original = JSON.stringify(f.report); const output = prepareAiContext(f.input);
  expect(output.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "logical-summary", value: expect.objectContaining({ total: 1, passed: 0, failed: 1 }) })]));
  const outcome = output.evidence.find(item => item.kind === "debug-outcome")!.value;
  expect(outcome).toMatchObject({ apiName: "native-api", identityAvailable: false }); expect(outcome).not.toHaveProperty("apiId");
  expect(JSON.stringify(f.report)).toBe(original);
});
it("native debug projection keeps missing request facts unknown rather than counting exchanges", () => {
  const f = fixture(); const output = prepareAiContext(f.input);
  expect(output.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "request-summary", state: "not-collected", value: null })]));
});
it("native debug projection distinguishes source revision from materialized execution revision", () => {
  const f = fixture(); const output = prepareAiContext(f.input);
  expect(output.source.report?.definitionRevision).toBe("archived-source-revision");
  expect(output.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "debug-revisions", value: { sourceProjectRevision: "archived-source-revision", executionSnapshotRevision: "different-materialized-revision", sourceApiRevision: "api-revision" } })]));
});
it("native debug projection masks typed exchange headers while retaining observed response status", () => {
  const f = fixture(); const output = prepareAiContext(f.input);
  expect(output.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "response-status", value: 503 })]));
  const request = output.evidence.find(item => item.location === "exchanges[0].request")?.value;
  expect(request).toMatchObject({ headers: [["x-api-key", "[REDACTED]"]] });
  const json = JSON.stringify(output); expect(json).not.toContain("OPAQUE_REQUEST_HEADER"); expect(json).not.toContain("OPAQUE_RESPONSE_COOKIE"); expect(json).not.toContain("PRIVATE_URL"); expect(json).toContain("visible=yes");
});
it("native debug projection records body omissions without exposing unselected text", () => {
  const f = fixture(); const output = prepareAiContext(f.input);
  expect(output.omitted).toEqual(expect.arrayContaining([expect.objectContaining({ item: "exchanges[0].response.body", reason: "default-omitted" })]));
  expect(JSON.stringify(output)).not.toContain("visible response body"); expect(JSON.stringify(output)).not.toContain("PRIVATE_BODY");
});
it("native debug projection selects only an available bounded body through the shared evidence path", () => {
  const f = fixture(); const output = prepareAiContext({ ...f.input, bodySelection: ["exchanges[0].request.body"] });
  expect(output.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "body", location: "exchanges[0].request.body", value: '{"password":"[REDACTED]","state":"visible"}' })]));
  expect(JSON.stringify(output)).not.toContain("visible response body"); expect(JSON.stringify(output)).not.toContain("PRIVATE_BODY");
});
it.each(["source", "replay", "exchange"] as const)("native debug projection refuses conflicting %s project ownership", kind => {
  const f = fixture();
  if (kind === "source" && f.report.source.sourceKind === "asset") f.report.source.locator.projectId = "other-project";
  if (kind === "replay" && f.report.replay.mode === "case" && f.report.replay.case) f.report.replay.case.projectId = "other-project";
  if (kind === "exchange" && f.report.exchanges[0]!.source.sourceKind === "asset") f.report.exchanges[0]!.source.case.projectId = "other-project";
  expect(() => prepareAiContext(f.input)).toThrow(/source-mismatch|unowned/);
});

function hostFailureFixture() {
  const project = projectionProject(); const snapshot = createProjectSnapshot(project);
  const locator = { workspaceId: "workspace", groupId: "group", projectId: project.id, collectionId: project.collections[0]!.id, folderIds: [], apiId: ids.contract };
  const plan = prepareDebugExecution(snapshot, { mode: "request", locator, request: project.collections[0]!.apis[0]!.contract.request, parameters: {}, fields: [] });
  const error = new Error("Proxy configuration unavailable; password=PRIVATE_NATIVE_ERROR"); error.name = "HostConfigurationError";
  // This is the real zero-outcome producer, not an invented failing RunResult.
  const failed = failedDebugResult(plan, "native-host-failure", "2026-10-30T00:00:00.000Z", error, { failureKind: "config", projectionReliable: true });
  const report = DebugResultSchema.parse({ ...failed, warnings: ["Host fallback unavailable; password=PRIVATE_NATIVE_WARNING"] });
  const input = { purpose: "report-analysis", reportId: "host-report", snapshot, context: snapshot.context, source: { kind: "local", bindingId: "binding", rootIdentity: "root-hash", projectId: project.id, definitionRevision: snapshot.definitionRevision, editRevision: 0 }, bodySelection: [], report } as Extract<AiContextInput, { purpose: "report-analysis" }>;
  return { input, report };
}

// Losing any top-level fact must fail independently even when no outcome exists.
it.each([
  { name: "failure kind", want: { failureKind: "config" } },
  { name: "error name", want: { errorName: "HostConfigurationError" } },
  { name: "meaningful root error", want: { error: expect.stringContaining("Proxy configuration unavailable") } },
])("N2 native host failure retains its $name as safe evidence", ({ want }) => {
  const f = hostFailureFixture(); const before = JSON.stringify(f.report); const output = prepareAiContext(f.input);
  expect(output.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ value: expect.objectContaining(want) })]));
  expect(JSON.stringify(output)).not.toContain("PRIVATE_NATIVE_ERROR"); expect(JSON.stringify(output)).not.toContain("PRIVATE_NATIVE_WARNING");
  expect(JSON.stringify(f.report)).toBe(before);
});
it("N2 native host failure retains known warnings as safe evidence", () => {
  const f = hostFailureFixture(); const before = JSON.stringify(f.report); const output = prepareAiContext(f.input);
  expect(output.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ value: expect.arrayContaining([expect.stringContaining("Host fallback unavailable")]) })]));
  expect(JSON.stringify(output)).not.toContain("PRIVATE_NATIVE_WARNING"); expect(JSON.stringify(f.report)).toBe(before);
});
it("N2 native host failure preserves real zeros and unknown request facts without fabricated outcomes", () => {
  const f = hostFailureFixture(); const output = prepareAiContext(f.input);
  expect(f.report).toMatchObject({ outcomes: [], exchanges: [], exchangeTotal: 0, run: { total: 0, passed: 0, failed: 0 } });
  expect(output.evidence).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "logical-summary", value: expect.objectContaining({ total: 0, passed: 0, failed: 0 }) }),
    expect.objectContaining({ kind: "request-summary", state: "not-collected", value: null }),
    expect.objectContaining({ kind: "debug-revisions", value: expect.objectContaining({ sourceProjectRevision: f.report.sourceProjectRevision, executionSnapshotRevision: f.report.executionSnapshotRevision }) }),
  ]));
  expect(output.evidence.some(item => item.kind === "debug-outcome" || item.kind === "debug-exchange")).toBe(false);
});

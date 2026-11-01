import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { compileCaseAssertions, createDefaultRegistry, createProjectSnapshot, fileStorage, type ContractProject, type Workspace } from "@apicc/core";
import { ContractProjectSchema, DebugResultSchema } from "@apicc/core/schema";
import { OnlineJobSchema, OnlineReportSchema } from "@apicc/execution/client";
import { createMcpServer, createScopedMcpServer } from "../src/mcp/server.js";
import { createMcpSource, type McpSource } from "../src/mcp/source.js";
import { runCli } from "../src/main.js";
import { onlineFixture, oid } from "./mcp-online.fixture.js";

const roots: string[] = [];
const originalCwd = process.cwd();
afterEach(() => { process.chdir(originalCwd); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const signal = () => new AbortController().signal;
const apiPath = `groups/${oid(2)}/projects/${oid(3)}/collections/${oid(4)}/apis/${oid(5)}`;
const caseAssetId = `case:${oid(5)}:${oid(6)}:base`;

function projectFixture(): ContractProject {
  return ContractProjectSchema.parse({
    id: oid(3), name: "project-A", variables: {}, globals: { query: [], headers: [], cookies: [], body: [] }, stressPolicy: {}, environments: [],
    collections: [{ id: oid(4), name: "collection", variables: {}, preOperations: [], postOperations: [], folders: [], apis: [{
      contract: { formatVersion: 1, id: oid(5), metadata: { name: "orders", description: "", tags: [], version: "1", status: "published" },
        request: { protocol: "http", method: "GET", baseUrl: "https://business.example", path: "/orders", pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, body: { kind: "json", content: "PRIVATE_DEFAULT_BODY" } }, responses: [] },
      documentation: "", cases: [{ id: oid(6), name: "saved case", scope: "base", parameters: { limit: "5", password: "PRIVATE_PARAMETER" },
        preOperations: [{ id: "private-script", type: "script", content: "PRIVATE_SCRIPT_SOURCE" }], postOperations: [], assertions: [{ id: "status", target: "status", op: "eq", expected: "200" }] }],
    }] }],
    models: [{ formatVersion: 1, id: oid(10), name: "Order", description: "Order structure", schema: { kind: "object", properties: { id: { kind: "scalar", type: "integer" }, password: { kind: "scalar", type: "string", default: "PRIVATE_SCHEMA_DEFAULT" } }, required: ["id"], additionalProperties: false } }],
    components: [
      { formatVersion: 1, id: oid(11), name: "Order ID", description: "", kind: "parameter", definition: { location: "path", name: "id", schema: { kind: "scalar", type: "integer" }, required: true, description: "Order identifier" } },
      { formatVersion: 1, id: oid(12), name: "Auth", description: "", kind: "auth", definition: { kind: "bearer", token: { id: "PRIVATE_SECRET_REF", policy: "test-auto" } } },
      { formatVersion: 1, id: oid(13), name: "Response", description: "", kind: "response", definition: { status: "200", description: "Order response", headers: {}, content: { "application/json": { schema: { kind: "modelRef", modelId: oid(10) }, examples: [] } } } },
      { formatVersion: 1, id: oid(14), name: "Example", description: "", kind: "example", definition: { name: "public example", value: { state: "ready", password: "PRIVATE_EXAMPLE_SECRET" } } },
    ],
    workflows: [{ id: oid(15), name: "Order flow", status: "published", executionVersion: 2,
      nodes: [{ id: "check", kind: "condition", predicate: { op: "eq", left: { kind: "ref", source: "inputs", path: ["state"] }, right: { kind: "literal", value: "ready" } } }, { id: "send", kind: "request", apiId: oid(5), caseId: oid(6), policy: { retry: { maxAttempts: 2, retryOn: ["transport"], delayMs: 0, backoff: "fixed", allowRepeatSideEffects: false } } }],
      edges: [{ id: "edge", from: "check", to: "send", port: "true" }], inputs: { state: { required: true, default: "ready" } }, outputs: { state: { kind: "ref", source: "vars", path: ["state"] } }, limits: { maxConcurrency: 1, timeoutMs: 1000 } }],
    suites: [{ formatVersion: 1, id: oid(16), name: "Order suite", tags: [], selection: { kind: "explicit", entries: [{ id: oid(17), kind: "case", collectionId: oid(4), folderIds: [], apiId: oid(5), caseId: oid(6) }, { id: oid(18), kind: "workflow", workflowId: oid(15) }] }, failFast: true, reporters: ["json"] }],
    datasets: [{ formatVersion: 1, id: oid(19), name: "Order rows", columns: ["state"], rows: [{ state: "PRIVATE_DATA_ROW" }] }],
  });
}

async function workspaceFixture(project = projectFixture()) {
  const root = mkdtempSync(join(tmpdir(), "apicc-mcp-fix1-")); roots.push(root);
  const workspace: Workspace = { formatVersion: 1, id: oid(1), name: "workspace", variables: {}, groups: [{ id: oid(2), name: "group", projects: [project] }] };
  const save = async () => { const current = await fileStorage.load(root); await fileStorage.save(root, workspace, { expectedRevision: current.revision, deletions: [] }); };
  await save();
  return { root, workspace, project, save };
}

async function connect(source: McpSource, maxOutputBytes = 131072) {
  const mcp = createScopedMcpServer(source, { maxOutputBytes });
  const client = new Client({ name: "fix1-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([client.connect(a), mcp.connect(b)]);
  return { client, async close() { await client.close(); await mcp.close(); } };
}

function text(result: CallToolResult) { return result.content.filter(item => item.type === "text").map(item => item.text).join("\n"); }
// Current and proposed result formats are both readable here; this is test transport plumbing, not a projection.
function data(result: CallToolResult): any {
  if (result.structuredContent) return result.structuredContent.data;
  try { return JSON.parse(text(result)); } catch { return { error: text(result) }; }
}
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<CallToolResult> { return await client.callTool({ name, arguments: args }) as CallToolResult; }

describe("fix1 I1 presentation privacy", () => {
  // A missing text projection on project presentation would return this exact synthetic password.
  it("I1 redacts project-directory names through the actual SDK without losing safe URL suffixes", async () => {
    const project = projectFixture(); project.name = "https://project-user:PROJECT_PRIVATE@example.test/orders?password=PROJECT_QUERY_PRIVATE&visible=yes";
    const f = await workspaceFixture(project); const sdk = await connect(await createMcpSource({ workspace: f.root }));
    try {
      const result = await call(sdk.client, "list-assets", {}); const output = JSON.stringify(result);
      expect(output).not.toContain("PROJECT_PRIVATE"); expect(output).not.toContain("PROJECT_QUERY_PRIVATE"); expect(output).not.toContain("project-user");
      expect(output).toContain("visible=yes"); expect(f.project.name).toContain("PROJECT_PRIVATE");
    } finally { await sdk.close(); }
  });
  it("I1 redacts saved-case names through actual SDK Markdown", async () => {
    const project = projectFixture(); project.collections[0]!.apis[0]!.cases[0]!.name = "https://case-user:CASE_PRIVATE@example.test/?password=CASE_QUERY_PRIVATE&visible=yes";
    const f = await workspaceFixture(project); const sdk = await connect(await createMcpSource({ workspace: f.root }));
    try {
      const result = await call(sdk.client, "get-api-design", { apiPath });
      expect(text(result)).not.toContain("CASE_PRIVATE"); expect(text(result)).not.toContain("CASE_QUERY_PRIVATE"); expect(text(result)).not.toContain("case-user");
      expect(text(result)).toContain("visible=yes"); expect(f.project.collections[0]!.apis[0]!.cases[0]!.name).toContain("CASE_PRIVATE");
    } finally { await sdk.close(); }
  });
});

describe("fix1 I2 useful closed asset projections", () => {
  const scenarios = [
    { name: "model schema", assetId: `models:${oid(10)}`, want: { id: oid(10), schema: { kind: "object", properties: { id: { kind: "scalar", type: "integer" }, password: { kind: "scalar", type: "string" } }, required: ["id"] } } },
    { name: "parameter component", assetId: `components:${oid(11)}`, want: { kind: "parameter", definition: { location: "path", name: "id", schema: { kind: "scalar", type: "integer" }, required: true } } },
    { name: "auth component type and reference presence", assetId: `components:${oid(12)}`, want: { kind: "auth", definition: { kind: "bearer", referenced: true } } },
    { name: "response component schema", assetId: `components:${oid(13)}`, want: { kind: "response", definition: { status: "200", content: { "application/json": { schema: { kind: "modelRef", modelId: oid(10) } } } } } },
    { name: "example component definition metadata with default body omission", assetId: `components:${oid(14)}`, want: { kind: "example", definition: { name: "public example" } } },
    { name: "saved case selection parameters and assertions", assetId: caseAssetId, want: { id: oid(6), scope: "base", locator: { collectionId: oid(4), folderIds: [], apiId: oid(5), caseId: oid(6), scope: "base" }, parameters: { limit: "5" }, assertions: [{ target: "status", op: "eq", expected: "200" }] } },
    { name: "suite entries and targets", assetId: `suites:${oid(16)}`, want: { id: oid(16), failFast: true, selection: { kind: "explicit", entries: [{ id: oid(17), kind: "case", collectionId: oid(4), folderIds: [], apiId: oid(5), caseId: oid(6) }, { id: oid(18), kind: "workflow", workflowId: oid(15) }] } } },
    { name: "workflow graph control and bindings", assetId: `workflows:${oid(15)}`, want: { id: oid(15), executionVersion: 2, nodes: [{ id: "check", kind: "condition", predicate: { op: "eq", left: { kind: "ref", source: "inputs", path: ["state"] }, right: { kind: "literal", value: "ready" } } }, { id: "send", kind: "request", apiId: oid(5), caseId: oid(6), policy: { retry: { maxAttempts: 2, retryOn: ["transport"] } } }], edges: [{ id: "edge", from: "check", to: "send", port: "true" }], inputs: { state: { required: true, default: "ready" } }, outputs: { state: { kind: "ref", source: "vars", path: ["state"] } } } },
  ];
  // Returning only a list summary cannot satisfy each independently selected business structure.
  it.each(scenarios)("I2 reads $name through get-asset while omitting secrets/scripts/bodies", async ({ assetId, want }) => {
    const f = await workspaceFixture(); const before = JSON.stringify(f.project); const sdk = await connect(await createMcpSource({ workspace: f.root }));
    try {
      const result = await call(sdk.client, "get-asset", { projectId: oid(3), assetId });
      expect(data(result).asset).toMatchObject(want);
      expect(result.isError).toBeFalsy();
      const output = JSON.stringify(result);
      for (const secret of ["PRIVATE_DEFAULT_BODY", "PRIVATE_PARAMETER", "PRIVATE_SCRIPT_SOURCE", "PRIVATE_SECRET_REF", "PRIVATE_DATA_ROW", "PRIVATE_SCHEMA_DEFAULT", "PRIVATE_EXAMPLE_SECRET"]) expect(output).not.toContain(secret);
      expect(JSON.stringify(f.project)).toBe(before);
    } finally { await sdk.close(); }
  });
  it("I2 lists saved cases with stable independent source locators", async () => {
    const f = await workspaceFixture(); const sdk = await connect(await createMcpSource({ workspace: f.root }));
    try {
      const result = await call(sdk.client, "list-assets", { projectId: oid(3) });
      expect(data(result).items).toEqual(expect.arrayContaining([expect.objectContaining({ assetId: caseAssetId, kind: "case", apiPath, locator: { collectionId: oid(4), folderIds: [], apiId: oid(5), caseId: oid(6), scope: "base" } })]));
    } finally { await sdk.close(); }
  });
});

async function nativeFixture(kind: "debug" | "workflow") {
  const f = await onlineFixture(); roots.push(f.home);
  const revision = createProjectSnapshot(f.project).definitionRevision;
  const locator = { workspaceId: oid(1), groupId: oid(2), projectId: oid(3), collectionId: oid(4), folderIds: [], apiId: oid(5) };
  const nativeCase = { ...locator, caseId: oid(6), scope: "base" };
  const debug = DebugResultSchema.parse({
    runId: oid(25), source: { sourceKind: "asset", locator, sourceApiRevision: "native-api-revision" }, sourceProjectRevision: revision, executionSnapshotRevision: revision, mode: "case",
    startedAt: "2026-10-30T00:00:00.000Z", finishedAt: "2026-10-30T00:00:01.000Z",
    run: { collectionId: oid(4), collectionName: "native collection", startedAt: "2026-10-30T00:00:00.000Z", finishedAt: "2026-10-30T00:00:01.000Z", total: 1, passed: 0, failed: 1 },
    outcomes: [{ apiId: oid(5), apiName: "online-api", caseId: oid(6), caseName: "online-case", passed: false, durationMs: 12, assertions: [{ pass: false, message: "expected 200, received 503" }], failureKind: "assertion" }],
    exchanges: [{ source: { sourceKind: "asset", case: nativeCase }, rowIndex: 0, hopIndex: 0, order: 1, transportState: "responded", settings: { connectTimeoutMs: 1000, headersTimeoutMs: 1000, bodyTimeoutMs: 1000, totalTimeoutMs: 1000, followRedirects: false, maxRedirects: 0, uploadLimitBytes: 4096, responseLimitBytes: 4096 }, startedAt: "2026-10-30T00:00:00.000Z", response: { status: 503, headers: [], cookies: [], body: { kind: "text", text: "PRIVATE_NATIVE_RESPONSE_BODY", contentBytes: 28, truncated: false } } }],
    exchangeTotal: 1, omittedExchangeCount: 0,
    replay: { mode: "case", sourceKind: "asset", case: nativeCase, parameters: {}, fields: [], available: true }, console: [], warnings: [],
  });
  const workflow = { workflowId: oid(15), workflowName: "native workflow", status: "failed", verdict: "failed", startedAt: "2026-10-30T00:00:00.000Z", finishedAt: "2026-10-30T00:00:01.000Z", total: 1, passed: 0, failed: 1, warnings: [], nodeResults: [],
    report: { ...structuredClone(f.report.output.result), total: 1, passed: 0, failed: 1, cases: [{ apiId: oid(5), apiName: "online-api", caseId: oid(6), caseName: "online-case", passed: false, durationMs: 12, assertions: [{ pass: false, message: "expected 200, received 503" }],
      evidence: { identity: { projectId: oid(3), definitionRevision: revision }, state: "collected", truncated: false, scriptDiagnostics: "not-collected", response: { status: 503, headers: { text: "{}", truncated: false }, body: { text: "PRIVATE_NATIVE_RESPONSE_BODY", truncated: false } } },
    }] } };
  const envelope: any = { executionId: "100", verdict: "failed", output: kind === "debug" ? { kind, result: debug } : { kind, result: workflow } };
  Object.assign(f.job.task, { target: kind === "debug" ? { kind, invocation: { mode: "case", locator, case: nativeCase } } : { kind, workflowId: oid(15) } });
  // Assert complete real native schemas before exercising source/SDK, so malformed fixtures cannot supply the RED.
  expect(OnlineJobSchema.safeParse(f.job).success).toBe(true); expect(OnlineReportSchema.safeParse(envelope).success).toBe(true);
  const originalFetch = f.deps.mcpFetch!;
  f.deps.mcpFetch = async (url, init) => String(url).endsWith("/jobs/99/report") ? Response.json(envelope) : originalFetch(url, init);
  const source = await createMcpSource({ onlineProfile: "online-member", ...f.deps });
  const page = await source.listRuns("3", {}, signal());
  return { ...f, source, runId: page.items[0]!.runId, envelope, debug, workflow };
}

describe("fix1 I3 native archived reports", () => {
  it.each(["debug", "workflow"] as const)("I3 reads a schema-valid native %s archive without fabricating or mutating results", async kind => {
    const f = await nativeFixture(kind); const original = JSON.stringify(f.envelope);
    try {
      const selected = await f.source.getReport(f.runId, {}, signal());
      expect(selected.report).toEqual(kind === "debug" ? f.debug : f.workflow.report);
      expect(JSON.stringify(f.envelope)).toBe(original); expect(f.envelope.verdict).toBe("failed");
    } finally { await f.source.close(); }
  });
  it.each(["debug", "workflow"] as const)("I3 exposes safe %s summary evidence through SDK without inventing request facts", async kind => {
    const f = await nativeFixture(kind); const sdk = await connect(f.source);
    try {
      const result = await call(sdk.client, "get-report", { runId: f.runId });
      const projected = data(result);
      expect(projected.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "logical-summary", state: "collected", value: expect.objectContaining({ total: 1, failed: 1 }) })]));
      // These native shapes contain no requestFacts; unknown is not silently synthesized as zero/success.
      expect(projected.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "request-summary", value: null, state: expect.stringMatching(/not-collected|legacy/) })]));
    } finally { await sdk.close(); }
  });
  // This is a separately named body-selection contract, not an assertion hidden behind summary acceptance.
  it.each(["debug", "workflow"] as const)("I3 explicitly records the unselected native %s body omission through SDK", async kind => {
    const f = await nativeFixture(kind); const sdk = await connect(f.source);
    try {
      const result = await call(sdk.client, "get-report", { runId: f.runId }); const projected = data(result);
      expect(projected.omitted).toEqual(expect.arrayContaining([expect.objectContaining({ item: kind === "debug" ? "exchanges[0].response.body" : "cases[0].evidence.response.body", reason: "default-omitted" })]));
      expect(JSON.stringify(result)).not.toContain("PRIVATE_NATIVE_RESPONSE_BODY");
    } finally { await sdk.close(); }
  });
  it("I3 rejects native debug ownership conflicting with the captured project", async () => {
    const f = await nativeFixture("debug"); f.envelope.output.result.source.locator.projectId = oid(99);
    expect(OnlineReportSchema.safeParse(f.envelope).success).toBe(true);
    try { await expect(f.source.getReport(f.runId, {}, signal())).rejects.toThrow(/unowned|source-mismatch|scope-mismatch/); }
    finally { await f.source.close(); }
  });
  it("I3 rejects workflow embedded report with conflicting execution definition", async () => {
    const f = await nativeFixture("workflow"); f.envelope.output.result.report.executionIdentity.definitionRevision = "other-definition";
    expect(OnlineReportSchema.safeParse(f.envelope).success).toBe(true);
    try { await expect(f.source.getReport(f.runId, {}, signal())).rejects.toThrow(/unowned|source-mismatch|scope-mismatch/); }
    finally { await f.source.close(); }
  });
});

describe("fix2 N1/N2 affected SDK consumption", () => {
  it("N1 SDK get-asset does not expose expected behind a bracket-quoted credential selector", async () => {
    const project = projectFixture();
    project.collections[0]!.apis[0]!.cases[0]!.assertions = [{ id: "credential", target: "bodyJson", path: "$['password']", op: "eq", expected: "PRIVATE_SDK_SELECTOR_EXPECTED" }];
    expect(ContractProjectSchema.safeParse(project).success).toBe(true);
    const f = await workspaceFixture(project); const before = JSON.stringify(f.project); const sdk = await connect(await createMcpSource({ workspace: f.root }));
    try {
      const result = await call(sdk.client, "get-asset", { projectId: oid(3), assetId: caseAssetId });
      expect(JSON.stringify(result)).not.toContain("PRIVATE_SDK_SELECTOR_EXPECTED");
      expect(data(result).asset.assertions).toMatchObject([{ id: "credential", path: "$['password']", expected: "[REDACTED]" }]);
      expect(JSON.stringify(f.project)).toBe(before);
    } finally { await sdk.close(); }
  });
  it("N2 SDK get-report exposes the sanitized root reason for a zero-outcome native host failure", async () => {
    const f = await nativeFixture("debug");
    Object.assign(f.debug, { run: { ...f.debug.run, total: 0, passed: 0, failed: 0 }, outcomes: [], exchanges: [], exchangeTotal: 0, omittedExchangeCount: 0,
      failureKind: "config", errorName: "HostConfigurationError", error: "Proxy configuration unavailable; password=PRIVATE_SDK_HOST_ERROR", warnings: ["Host fallback unavailable; password=PRIVATE_SDK_HOST_WARNING"] });
    expect(DebugResultSchema.safeParse(f.debug).success).toBe(true); expect(OnlineReportSchema.safeParse(f.envelope).success).toBe(true);
    const before = JSON.stringify(f.envelope); const sdk = await connect(f.source, 8192);
    try {
      const result = await call(sdk.client, "get-report", { runId: f.runId }); const output = data(result);
      expect(output.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ value: expect.objectContaining({ error: expect.stringContaining("Proxy configuration unavailable") }) })]));
      expect(output.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "logical-summary", value: expect.objectContaining({ total: 0, passed: 0, failed: 0 }) }), expect.objectContaining({ kind: "request-summary", state: "not-collected", value: null })]));
      expect(JSON.stringify(result)).not.toContain("PRIVATE_SDK_HOST_ERROR"); expect(JSON.stringify(result)).not.toContain("PRIVATE_SDK_HOST_WARNING");
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(8192); expect(JSON.stringify(f.envelope)).toBe(before);
    } finally { await sdk.close(); }
  });
});

it.each([
  { name: "ordinary rootless property", path: "state", expected: "ready", want: "ready" },
  { name: "sensitive rootless indexed property", path: "users[0].password", expected: "PRIVATE_SDK_ROOTLESS_EXPECTED", want: "[REDACTED]" },
])("N3 SDK get-asset reads a valid saved $name", async ({ path, expected, want }) => {
  const project = projectFixture(); project.collections[0]!.apis[0]!.cases[0]!.assertions = [{ id: "legacy", target: "bodyJson", op: "eq", path, expected }];
  expect(ContractProjectSchema.safeParse(project).success).toBe(true);
  const snapshot = createProjectSnapshot(project);
  expect(compileCaseAssertions(project.collections[0]!.apis[0]!.cases[0]!, snapshot.context, createDefaultRegistry()).diagnostics).toEqual([]);
  const f = await workspaceFixture(project); const before = JSON.stringify(project); const sdk = await connect(await createMcpSource({ workspace: f.root }));
  try {
    const result = await call(sdk.client, "get-asset", { projectId: oid(3), assetId: caseAssetId });
    expect(result.isError).not.toBe(true);
    expect(data(result).asset.assertions).toMatchObject([{ id: "legacy", path, expected: want }]);
    if (want === "[REDACTED]") expect(JSON.stringify(result)).not.toContain("PRIVATE_SDK_ROOTLESS_EXPECTED");
    expect(JSON.stringify(project)).toBe(before);
  } finally { await sdk.close(); }
});

describe("fix1 I4 project directory cursors", () => {
  it("I4 rejects a project-directory cursor after an actual ordered directory insertion", async () => {
    const f = await workspaceFixture(); const second = { ...structuredClone(f.project), id: oid(30), name: "project-B", collections: [], components: [], models: [], suites: [], workflows: [], datasets: [] };
    f.workspace.groups[0]!.projects.push(second); await f.save();
    const sdk = await connect(await createMcpSource({ workspace: f.root }));
    try {
      const first = data(await call(sdk.client, "list-assets", { limit: 1 })); expect(first.items[0].projectId).toBe(oid(3)); expect(first.nextCursor).toBeTruthy();
      f.workspace.groups[0]!.projects.unshift({ ...structuredClone(second), id: oid(29), name: "project-X" }); await f.save();
      const next = await call(sdk.client, "list-assets", { limit: 1, cursor: first.nextCursor });
      expect(next.isError).toBe(true); expect(text(next)).toMatch(/cursor|游标/);
    } finally { await sdk.close(); }
  });
});

describe("fix1 I5 legacy execution output bounds", () => {
  it("I5 bounds an already-executed successful run-case result and truthfully warns not to retry", async () => {
    let requests = 0; const server = createServer((_req, res) => { requests++; res.end("ok"); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const project = projectFixture(); const api = project.collections[0]!.apis[0]!;
    api.cases[0]!.name = "large-result-" + "x".repeat(6000); api.cases[0]!.preOperations = []; api.cases[0]!.assertions = []; api.cases[0]!.parameters = {};
    if (api.contract.request.protocol !== "http") throw new Error("HTTP fixture required");
    api.contract.request.baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`; api.contract.request.body = { kind: "none" };
    const f = await workspaceFixture(project); const mcp = createMcpServer(f.root, { allowRun: true, maxOutputBytes: 4096, log: () => {} });
    const client = new Client({ name: "fix1-run-budget", version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([client.connect(a), mcp.connect(b)]);
    try {
      const result = await call(client, "run-case", { apiPath, caseId: oid(6) });
      expect(requests).toBe(1); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096);
      expect(result.isError).toBe(true); expect(text(result)).toMatch(/已执行|已经执行/); expect(text(result)).toMatch(/勿重试|不要重试|不可重试/);
    } finally { await client.close(); await mcp.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  });
  it("I5 bounds and sanitizes the non-base run-case error branch", async () => {
    const project = projectFixture(); project.collections[0]!.apis[0]!.cases[0]!.scope = "dev";
    project.collections[0]!.apis[0]!.cases[0]!.name = "https://error-user:ERROR_PRIVATE@example.test/?password=ERROR_QUERY_PRIVATE&visible=yes " + "x".repeat(6000);
    const f = await workspaceFixture(project); const mcp = createMcpServer(f.root, { allowRun: true, maxOutputBytes: 4096, log: () => {} });
    const client = new Client({ name: "fix1-error-budget", version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([client.connect(a), mcp.connect(b)]);
    try {
      const result = await call(client, "run-case", { apiPath, caseId: oid(6) });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096); expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain("ERROR_PRIVATE"); expect(JSON.stringify(result)).not.toContain("ERROR_QUERY_PRIVATE");
    } finally { await client.close(); await mcp.close(); }
  });
  it("I5 sanitizes a small non-base error independently of the output-size guard", async () => {
    const project = projectFixture(); const savedCase = project.collections[0]!.apis[0]!.cases[0]!;
    savedCase.scope = "dev"; savedCase.name = "https://error-user:ERROR_PRIVATE@example.test/?password=ERROR_QUERY_PRIVATE&visible=yes";
    const f = await workspaceFixture(project); const mcp = createMcpServer(f.root, { allowRun: true, maxOutputBytes: 4096, log: () => {} });
    const client = new Client({ name: "fix1-small-error", version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([client.connect(a), mcp.connect(b)]);
    try {
      const result = await call(client, "run-case", { apiPath, caseId: oid(6) });
      expect(JSON.stringify(result)).not.toContain("ERROR_PRIVATE"); expect(JSON.stringify(result)).not.toContain("ERROR_QUERY_PRIVATE");
      expect(text(result)).toContain("visible=yes"); expect(result.isError).toBe(true);
    } finally { await client.close(); await mcp.close(); }
  });
  it("I5 bounds the nonexistent-case error branch rather than echoing an oversized caller ID", async () => {
    const f = await workspaceFixture(); const mcp = createMcpServer(f.root, { allowRun: true, maxOutputBytes: 4096, log: () => {} });
    const client = new Client({ name: "fix1-missing-error", version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([client.connect(a), mcp.connect(b)]);
    try {
      const result = await call(client, "run-case", { apiPath, caseId: "missing-" + "x".repeat(6000) });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096); expect(result.isError).toBe(true);
    } finally { await client.close(); await mcp.close(); }
  });
  it("I5 bounds the caught execution-preparation error branch", async () => {
    const project = projectFixture(); project.collections[0]!.preOperations = [{ id: "preparation-error", type: "script", content: `throw new Error(${JSON.stringify("x".repeat(6000))});` }];
    const f = await workspaceFixture(project); const mcp = createMcpServer(f.root, { allowRun: true, maxOutputBytes: 4096, log: () => {} });
    const client = new Client({ name: "fix1-caught-error", version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([client.connect(a), mcp.connect(b)]);
    try {
      const result = await call(client, "run-case", { apiPath, caseId: oid(6) });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096); expect(result.isError).toBe(true);
    } finally { await client.close(); await mcp.close(); }
  });
});

function saveReport(root: string, project: ContractProject) {
  const directory = join(root, ".apicc", "runs"); mkdirSync(directory, { recursive: true });
  const definitionRevision = createProjectSnapshot(project).definitionRevision;
  const report = { projectId: project.id, definitionRevision, executionIdentity: { projectId: project.id, definitionRevision }, collectionId: oid(4), collectionName: "report", startedAt: "2026-10-30T00:00:00.000Z", finishedAt: "2026-10-30T00:00:01.000Z", total: 0, passed: 0, failed: 0, cases: [] };
  writeFileSync(join(directory, "valid.json"), JSON.stringify(report)); return { directory, report };
}

describe("fix1 I6 new read result envelopes", () => {
  it("I6 summarizes the actual run and archive state in readable SDK text", async () => {
    const f = await workspaceFixture(); saveReport(f.root, f.project); const source = await createMcpSource({ workspace: f.root });
    const page = await source.listRuns(oid(3), {}, signal()); const sdk = await connect(source);
    try {
      const result = await call(sdk.client, "get-run", { runId: page.items[0]!.runId });
      expect(text(result)).toContain("已结束"); expect(text(result)).toContain("已归档");
    } finally { await sdk.close(); }
  });
  it("I6 summarizes observed logical report counts without inventing unknown request facts", async () => {
    const f = await workspaceFixture(); saveReport(f.root, f.project); const source = await createMcpSource({ workspace: f.root });
    const page = await source.listRuns(oid(3), {}, signal()); const sdk = await connect(source);
    try {
      const result = await call(sdk.client, "get-report", { runId: page.items[0]!.runId });
      expect(text(result)).toMatch(/总计\s*0/); expect(text(result)).toMatch(/通过\s*0/); expect(text(result)).toMatch(/失败\s*0/);
      expect(text(result)).toContain("请求事实未采集");
    } finally { await sdk.close(); }
  });
  it("I6 includes escaped legacy Markdown text in the same complete result byte limit", async () => {
    const project = projectFixture(); project.collections[0]!.apis[0]!.cases[0]!.name = '"'.repeat(3100);
    const f = await workspaceFixture(project); const sdk = await connect(await createMcpSource({ workspace: f.root }), 4096);
    try {
      const result = await call(sdk.client, "get-api-design", { apiPath });
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096);
      expect(result.isError).toBe(true); expect(text(result)).toMatch(/预算/);
    } finally { await sdk.close(); }
  });
  it("I6 retains a known selection revision when the complete result exceeds its byte budget", async () => {
    const project = projectFixture(); project.models[0]!.description = "x".repeat(6000);
    const f = await workspaceFixture(project); const source = await createMcpSource({ workspace: f.root });
    const read = await source.readProject(oid(3), signal()); const sdk = await connect(source, 4096);
    try {
      const result = await call(sdk.client, "get-asset", { projectId: oid(3), assetId: `models:${oid(10)}` });
      expect(result.isError).toBe(true); expect(result.structuredContent?.revision).toBe(read.revision);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096);
    } finally { await sdk.close(); }
  });
  it.each(["list-assets", "get-asset", "list-runs", "get-run", "get-report"])("I6 returns source, revision, completeness and human summary in actual SDK %s", async name => {
    const f = await workspaceFixture(); saveReport(f.root, f.project); const source = await createMcpSource({ workspace: f.root });
    const read = await source.readProject(oid(3), signal()); const runs = await source.listRuns(oid(3), {}, signal()); const runId = runs.items[0]!.runId;
    const sdk = await connect(source, 4096);
    try {
      const args = name === "get-run" || name === "get-report" ? { runId } : name === "get-asset" ? { projectId: oid(3), assetId: `datasets:${oid(19)}` } : { projectId: oid(3), limit: 1 };
      const result = await call(sdk.client, name, args);
      expect(result.structuredContent).toMatchObject({ source: { kind: "local", bindingId: source.identity.bindingId, rootIdentity: source.identity.rootIdentity }, revision: read.revision, completeness: { complete: expect.any(Boolean) }, limitations: expect.any(Array), data: expect.any(Object) });
      expect(text(result)).toMatch(/资产|报告|运行|读取/); expect(text(result).trim().startsWith("{")).toBe(false);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(4096); expect(JSON.stringify(result)).not.toContain(f.root); expect(JSON.stringify(result)).not.toContain("PRIVATE_DATA_ROW");
    } finally { await sdk.close(); }
  });
});

describe("fix1 I7 local archive diagnostics", () => {
  it.each(["unreadable", "unattributable"] as const)("I7 surfaces source-level %s counts instead of a silent successful empty history", async kind => {
    const f = await workspaceFixture(); const { directory, report } = saveReport(f.root, f.project); rmSync(join(directory, "valid.json"));
    writeFileSync(join(directory, "PRIVATE_ARCHIVE_NAME.json"), kind === "unreadable" ? "PRIVATE_CORRUPT_CONTENT{" : JSON.stringify({ ...report, projectId: undefined, executionIdentity: undefined }));
    const source = await createMcpSource({ workspace: f.root });
    try {
      const page = await source.listRuns(oid(3), {}, signal());
      expect((page as unknown as { diagnostics?: unknown }).diagnostics).toEqual([{ code: kind, count: 1, scope: "source" }]);
      expect(page.items).toEqual([]); expect(JSON.stringify(page)).not.toContain("PRIVATE_ARCHIVE_NAME"); expect(JSON.stringify(page)).not.toContain("PRIVATE_CORRUPT_CONTENT"); expect(JSON.stringify(page)).not.toContain(f.root);
    } finally { await source.close(); }
  });
  it("I7 does not misclassify a valid known other-project report as corrupt", async () => {
    const f = await workspaceFixture(); const { directory, report } = saveReport(f.root, f.project);
    writeFileSync(join(directory, "valid.json"), JSON.stringify({ ...report, projectId: oid(99), executionIdentity: { ...report.executionIdentity, projectId: oid(99) } }));
    const source = await createMcpSource({ workspace: f.root });
    try { const page = await source.listRuns(oid(3), {}, signal()); expect(page.items).toEqual([]); expect((page as unknown as { diagnostics?: unknown }).diagnostics ?? []).toEqual([]); }
    finally { await source.close(); }
  });
  it("I7 exposes unreadable source counts through actual SDK history without filenames", async () => {
    const f = await workspaceFixture(); const { directory } = saveReport(f.root, f.project); writeFileSync(join(directory, "PRIVATE_ARCHIVE_NAME.json"), "PRIVATE_CORRUPT_CONTENT{");
    const sdk = await connect(await createMcpSource({ workspace: f.root }));
    try {
      const result = await call(sdk.client, "list-runs", { projectId: oid(3) });
      expect(data(result).diagnostics).toEqual([{ code: "unreadable", count: 1, scope: "source" }]);
      expect(JSON.stringify(result)).not.toContain("PRIVATE_ARCHIVE_NAME"); expect(JSON.stringify(result)).not.toContain("PRIVATE_CORRUPT_CONTENT");
    } finally { await sdk.close(); }
  });
  it("I7 tells CLI readers the actual omitted unreadable count without exposing archive names", async () => {
    const f = await workspaceFixture(); const { directory } = saveReport(f.root, f.project); writeFileSync(join(directory, "PRIVATE_ARCHIVE_NAME.json"), "PRIVATE_CORRUPT_CONTENT{");
    const home = mkdtempSync(join(tmpdir(), "apicc-fix1-cli-home-")); roots.push(home); const lines: string[] = [];
    process.chdir(f.root);
    await runCli(["ai", "reports", `groups/${oid(2)}/projects/${oid(3)}`], createDefaultRegistry(), line => lines.push(line), { aiHomeDir: home, aiEnv: {}, pluginsHomeDir: home, loadPlugins: false });
    expect(lines.join("\n")).toMatch(/不可读[^\n]*1|1[^\n]*不可读/); expect(lines.join("\n")).not.toContain("PRIVATE_ARCHIVE_NAME"); expect(lines.join("\n")).not.toContain("PRIVATE_CORRUPT_CONTENT");
  });
});

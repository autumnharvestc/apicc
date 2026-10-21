import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import { prepareTestData, testDataSelectionsForRequests } from "../../src/testing/data.js";
import { createHttpSession } from "../../src/http/session.js";
import { createDefaultRegistry } from "../../src/shared.js";
import type { ApiRequest } from "../../src/contract/model.js";
import type { ContractProject } from "../../src/contract/workspace.js";
import type { ProjectExecutionRun } from "../../src/runner/runner.js";
import type { RunResult as ProjectRunResult } from "../../src/report/types.js";
import type { DebugInvocation } from "../../src/debug/model.js";
import type { DebugExecutionIdentity } from "../../src/debug/model.js";
import { abortedDebugResult, prepareDebugExecution, runDebugExecution } from "../../src/debug/service.js";
import { createDebugExchangeCollector, projectDebugResult } from "../../src/debug/projection.js";
import { resolveRequestSettings } from "../../src/request/settings.js";
import { createDebugReplayInvocation } from "../../src/debug/replay.js";
import { createContractExecutionProject, contractExecutionIds } from "../helpers/contractExecutionFixtures.js";
import type { ExecutableRequest } from "../../src/plugin/types.js";

const ids = {
  workspaceId: "10000000-0000-4000-8000-000000000010",
  groupId: "10000000-0000-4000-8000-000000000011",
  projectId: contractExecutionIds.project,
  collectionId: contractExecutionIds.collection,
  folderIds: [contractExecutionIds.outerFolder, contractExecutionIds.innerFolder],
  apiId: contractExecutionIds.contract,
};
const observedSessionCookie = "synthetic-session-secret";

let server: Server;
let baseUrl = "";
let hits: string[] = [];
let observedDebugHeaders: Array<{ freeScope?: string; moduleOperation?: string }> = [];
const tempDirs: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? "";
    hits.push(path);
    observedDebugHeaders.push({
      ...(typeof request.headers["x-free-scope"] === "string" ? { freeScope: request.headers["x-free-scope"] } : {}),
      ...(typeof request.headers["x-module-operation"] === "string" ? { moduleOperation: request.headers["x-module-operation"] } : {}),
    });
    response.setHeader("content-type", "application/octet-stream");
    response.setHeader("set-cookie", `sid=${observedSessionCookie}; HttpOnly; SameSite=Lax`);
    response.end(Buffer.from(path.startsWith("/rows/one")
      ? "c3ludGhldGljLW1hcmtlcg== in a binary response"
      : path.startsWith("/rows/two")
        ? `echo: ${observedSessionCookie}`
        : "synthetic-marker in a binary response"));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function requestAt(path: string): Extract<ApiRequest, { protocol: "http" }> {
  return {
    protocol: "http",
    method: "GET",
    baseUrl,
    path,
    pathParams: [],
    query: [],
    headers: [],
    cookies: [],
    auth: { kind: "none" },
    body: { kind: "none" },
  };
}

function execution(project: ContractProject) {
  const snapshot = createProjectSnapshot(project);
  const plan = prepareDebugExecution(snapshot, {
    mode: "request",
    locator: ids,
    environmentId: contractExecutionIds.environment,
    request: requestAt("/dirty-request"),
    parameters: {},
    fields: [],
  });
  const run: ProjectExecutionRun = {
    snapshot: plan.snapshot,
    credentialBindings: { resolve: () => { throw new Error("No credentials are used by this test."); }, versions: {} },
  };
  return { snapshot, plan, run };
}

describe("Core debug service", () => {
  it("removes template auth provenance when a cross-origin redirect observation has no auth", () => {
    const collector = createDebugExchangeCollector([]);
    const identity: DebugExecutionIdentity = {
      rowIndex: 0,
      settings: resolveRequestSettings(),
      source: { sourceKind: "asset", case: { ...ids, caseId: "redirect-auth-case", scope: "base" } },
      sourceCategories: ["project", "environment", "request-override", "module", "auth"],
    };
    const firstUrl = "https://first.synthetic.test/redirect";
    const redirectedUrl = "https://second.synthetic.test/inspect";
    const firstRequest: ExecutableRequest = {
      protocol: "http", method: "GET", url: firstUrl,
      headers: { authorization: "Bearer synthetic" }, query: [],
      auth: { kind: "bearer", token: "synthetic" },
    };
    const redirectedRequest: ExecutableRequest = {
      ...firstRequest, url: redirectedUrl, headers: {}, auth: { kind: "none" },
    };

    collector.observe({
      type: "request", hopIndex: 0, request: firstRequest, url: firstUrl, method: "GET",
    }, identity);
    collector.observe({
      type: "request", hopIndex: 1, request: redirectedRequest, url: redirectedUrl, method: "GET", sessionCookieUsed: true,
    }, identity);

    const exchanges = collector.exchanges();
    expect(exchanges[0]?.request?.sourceCategories).toEqual(["project", "environment", "request-override", "module", "auth", "unknown"]);
    expect(exchanges[1]?.request?.sourceCategories).toEqual(["project", "environment", "request-override", "module", "session"]);
  });

  it("prepares a free request for a project with no modules without changing its source snapshot", () => {
    const project = createContractExecutionProject(baseUrl);
    project.collections = [];
    const snapshot = createProjectSnapshot(project);
    const before = JSON.stringify(snapshot);
    const invocation: DebugInvocation = {
      mode: "free",
      project: { workspaceId: ids.workspaceId, groupId: ids.groupId, projectId: ids.projectId },
      draftId: "10000000-0000-4000-8000-000000000027",
      environmentId: contractExecutionIds.environment,
      request: requestAt("/free-plan"),
      parameters: {},
      fields: [],
    };

    const plan = prepareDebugExecution(snapshot, invocation);

    expect(plan.invocation.mode).toBe("free");
    expect(JSON.stringify(snapshot)).toBe(before);
    expect("sourceApiRevision" in plan).toBe(false);
    expect(plan.snapshot.project.collections).toHaveLength(1);
    expect(plan.snapshot.project.collections[0]!.apis).toHaveLength(1);
  });

  it("runs a free request with project context and no module headers, operations, variables, or base URL mapping", async () => {
    hits = [];
    observedDebugHeaders = [];
    const project = createContractExecutionProject(baseUrl);
    project.variables.scope = "project-value";
    project.environments[0]!.variables.scope = "environment-value";
    project.environments[0]!.variables.baseUrl = baseUrl;
    project.environments[0]!.baseUrls[contractExecutionIds.collection] = "http://127.0.0.1:1";
    project.collections[0]!.variables.scope = "module-value";
    project.collections[0]!.preOperations = [{
      id: "10000000-0000-4000-8000-000000000028",
      type: "script",
      content: 'pm.request.headers["X-Module-Operation"] = "ran";',
    }];
    const projectBefore = JSON.stringify(project);
    const snapshot = createProjectSnapshot(project);
    const request = requestAt("/free/{{scope}}");
    request.baseUrl = "{{baseUrl}}";
    request.query = [{
      kind: "inline",
      id: "10000000-0000-4000-8000-000000000029",
      name: "scope",
      schema: { kind: "scalar", type: "string" },
      required: false,
      enabled: true,
      description: "",
      value: "{{scope}}",
    }];
    request.headers = [{
      kind: "inline",
      id: "10000000-0000-4000-8000-000000000030",
      name: "X-Free-Scope",
      schema: { kind: "scalar", type: "string" },
      required: false,
      enabled: true,
      description: "",
      value: "{{scope}}",
    }];
    const invocation: DebugInvocation = {
      mode: "free",
      project: { workspaceId: ids.workspaceId, groupId: ids.groupId, projectId: ids.projectId },
      draftId: "10000000-0000-4000-8000-000000000031",
      environmentId: contractExecutionIds.environment,
      request,
      parameters: {},
      fields: [],
    };

    const plan = prepareDebugExecution(snapshot, invocation);
    const run: ProjectExecutionRun = {
      snapshot: plan.snapshot,
      credentialBindings: { resolve: () => { throw new Error("No credentials are used by this test."); }, versions: {} },
    };
    const result = await runDebugExecution(plan, run, { registry: createDefaultRegistry(), credentialMarkers: [] });

    const freeUrl = new URL(hits[0] ?? "", baseUrl);
    expect(freeUrl.pathname).toBe("/free/environment-value");
    expect([...freeUrl.searchParams.entries()].sort()).toEqual([["global", "global-value"], ["scope", "environment-value"]]);
    expect(observedDebugHeaders).toEqual([{ freeScope: "environment-value" }]);
    expect(JSON.stringify(project)).toBe(projectBefore);
    expect(JSON.stringify(snapshot.project)).toBe(projectBefore);
    expect(result.mode).toBe("free");
    expect(result.run.total).toBe(1);
  });

  it("sends a dirty request against an API with no formal cases without changing the source project", async () => {
    hits = [];
    const project = createContractExecutionProject(baseUrl);
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.contract.request = requestAt("/formal-request");
    asset.cases = [];
    const sourceBefore = JSON.stringify(project);
    const workspaceRoot = mkdtempSync(join(tmpdir(), "apicc-debug-captured-file-"));
    tempDirs.push(workspaceRoot);
    const capturedBytes = Buffer.from("captured file bytes");
    writeFileSync(join(workspaceRoot, `captured-${observedSessionCookie}.bin`), capturedBytes);
    const dirtyRequest = requestAt("/dirty-request");
    dirtyRequest.method = "POST";
    dirtyRequest.body = { kind: "multipart", entries: [{
      kind: "file", id: "10000000-0000-4000-8000-000000000023", name: "payload", file: { path: `captured-${observedSessionCookie}.bin` }, filename: `sent-as-${observedSessionCookie}.bin`,
      contentType: "application/octet-stream", enabled: true,
    }] };
    const snapshot = createProjectSnapshot(project);
    const plan = prepareDebugExecution(snapshot, {
      mode: "request",
      locator: ids,
      environmentId: contractExecutionIds.environment,
      request: dirtyRequest,
      parameters: {},
      fields: [],
    });
    const run: ProjectExecutionRun = {
      snapshot: plan.snapshot,
      credentialBindings: { resolve: () => { throw new Error("No credentials are used by this test."); }, versions: {} },
    };

    const result = await runDebugExecution(plan, run, {
      registry: createDefaultRegistry(), workspaceRoot, credentialMarkers: ["synthetic-marker"],
    });

    expect(hits).toEqual(["/dirty-request?global=global-value"]);
    expect(snapshot.project.collections[0]!.folders[0]!.folders[0]!.apis[0]!.cases).toEqual([]);
    expect(JSON.stringify(project)).toBe(sourceBefore);
    expect(result.mode).toBe("request");
    expect(result.run.total).toBe(1);
    expect(result.sourceProjectRevision).toBe(snapshot.definitionRevision);
    expect(result.executionSnapshotRevision).not.toBe(result.sourceProjectRevision);
    expect(result.exchanges[0]?.request?.sourceCategories).toEqual(["project", "environment", "request-override"]);
    expect(result.exchanges[0]?.request?.body).toMatchObject({ kind: "multipart", entries: [{
      kind: "file", metadataAvailable: true, capturedFilename: "captured-[REDACTED].bin", capturedSizeBytes: capturedBytes.byteLength,
      filename: "sent-as-[REDACTED].bin", effectiveFilename: "sent-as-[REDACTED].bin",
    }] });
    expect(JSON.stringify(result.exchanges[0]?.request)).not.toContain(workspaceRoot);

    const binaryPath = `binary-${observedSessionCookie}.bin`;
    writeFileSync(join(workspaceRoot, binaryPath), capturedBytes);
    const binaryRequest = requestAt("/dirty-binary");
    binaryRequest.method = "POST";
    binaryRequest.body = { kind: "binary", file: { path: binaryPath }, contentType: "application/octet-stream" };
    const binaryPlan = prepareDebugExecution(snapshot, {
      mode: "request",
      locator: ids,
      environmentId: contractExecutionIds.environment,
      request: binaryRequest,
      parameters: {},
      fields: [],
    });
    const binaryRun: ProjectExecutionRun = {
      snapshot: binaryPlan.snapshot,
      credentialBindings: { resolve: () => { throw new Error("No credentials are used by this test."); }, versions: {} },
    };
    const binaryResult = await runDebugExecution(binaryPlan, binaryRun, {
      registry: createDefaultRegistry(), workspaceRoot, credentialMarkers: ["synthetic-marker"],
    });
    expect(hits).toEqual(["/dirty-request?global=global-value", "/dirty-binary?global=global-value"]);
    expect(binaryResult.exchanges[0]?.request?.body).toMatchObject({
      kind: "binary", metadataAvailable: true, capturedFilename: "binary-[REDACTED].bin", effectiveFilename: "binary-[REDACTED].bin",
      capturedSizeBytes: capturedBytes.byteLength,
    });
    expect(JSON.stringify(binaryResult.exchanges[0]?.request)).not.toContain(workspaceRoot);
    const provenanceProject = createContractExecutionProject(baseUrl);
    provenanceProject.components = [
      { formatVersion: 1, id: "10000000-0000-4000-8000-000000000024", name: "parameter", description: "", kind: "parameter", definition: {
        location: "query", name: "module-value", schema: { kind: "scalar", type: "string" }, required: false, description: "",
      } },
      { formatVersion: 1, id: "10000000-0000-4000-8000-000000000025", name: "auth", description: "", kind: "auth", definition: {
        kind: "bearer", token: { id: "module-token", policy: "test" },
      } },
    ];
    const referencedRequest = requestAt("/module-request");
    referencedRequest.query = [{ kind: "componentRef", id: "10000000-0000-4000-8000-000000000026", componentId: "10000000-0000-4000-8000-000000000024", expectedKind: "parameter", enabled: true }];
    referencedRequest.auth = { kind: "componentRef", componentId: "10000000-0000-4000-8000-000000000025", expectedKind: "auth" };
    const provenancePlan = prepareDebugExecution(createProjectSnapshot(provenanceProject), {
      mode: "request", locator: ids, environmentId: contractExecutionIds.environment,
      request: referencedRequest, parameters: {}, fields: [],
    });
    expect(provenancePlan.sourceCategories).toEqual(["project", "environment", "request-override", "module", "auth"]);
  });

  it("collects each data row from Runner identity and withholds binary bytes containing a known marker", async () => {
    hits = [];
    const dir = mkdtempSync(join(tmpdir(), "apicc-debug-rows-"));
    tempDirs.push(dir);
    const dataPath = join(dir, "rows.json");
    const rows = Array.from({ length: 101 }, (_, index) => ({ item: index === 0 ? `one-${observedSessionCookie}` : index === 1 ? "two" : `row-${index}` }));
    writeFileSync(dataPath, JSON.stringify(rows), "utf8");
    const project = createContractExecutionProject(baseUrl);
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.contract.request = requestAt("/rows/{{item}}");
    asset.cases = [{
      id: "rows-case",
      name: "rows",
      scope: "base",
      parameters: {},
      dataDriver: { sourcePath: dataPath, format: "json" },
      preOperations: [],
      postOperations: [],
      assertions: [],
    }];
    const snapshot = createProjectSnapshot(project);
    const plan = prepareDebugExecution(snapshot, {
      mode: "case",
      locator: ids,
      environmentId: contractExecutionIds.environment,
      settings: { connectTimeoutMs: 1234 },
      case: { ...ids, caseId: "rows-case", scope: "base" },
    });
    const run: ProjectExecutionRun = {
      snapshot: plan.snapshot,
      credentialBindings: { resolve: () => { throw new Error("No credentials are used by this test."); }, versions: {} },
    };

    const preparedTestData = await prepareTestData(plan.snapshot, testDataSelectionsForRequests(plan.snapshot, plan.credentialSelections), { workspaceRoot: dir });
    const result = await runDebugExecution(plan, { ...run, preparedTestData }, {
      registry: createDefaultRegistry(),
      httpSession: createHttpSession(),
      credentialMarkers: ["synthetic-marker"],
    });

    const replayInvocation = createDebugReplayInvocation({
      formatVersion: 2,
      historyId: "10000000-0000-4000-8000-000000000099",
      createdAt: "2026-10-13T00:00:00.000Z",
      result,
    });
    const replayPlan = prepareDebugExecution(snapshot, replayInvocation);
    const replayRun: ProjectExecutionRun = {
      snapshot: replayPlan.snapshot,
      credentialBindings: { resolve: () => { throw new Error("No credentials are used by this test."); }, versions: {} },
    };
    const replayData = await prepareTestData(replayPlan.snapshot, testDataSelectionsForRequests(replayPlan.snapshot, replayPlan.credentialSelections), { workspaceRoot: dir });
    const replayResult = await runDebugExecution(replayPlan, { ...replayRun, preparedTestData: replayData }, {
      registry: createDefaultRegistry(),
      httpSession: createHttpSession(),
      credentialMarkers: ["synthetic-marker"],
    });

    expect(hits).toHaveLength(202);
    expect(hits.slice(0, 2)).toEqual([`/rows/one-${observedSessionCookie}?global=global-value`, "/rows/two?global=global-value"]);
    expect(result.run.total).toBe(101);
    expect(result.exchangeTotal).toBe(101);
    expect(result.exchanges).toHaveLength(100);
    expect(result.omittedExchangeCount).toBe(1);
    expect(result.exchanges.slice(0, 2).map((exchange) => [exchange.source.sourceKind === "asset" ? exchange.source.case.caseId : undefined, exchange.rowIndex, exchange.hopIndex])).toEqual([
      ["rows-case", 0, 0],
      ["rows-case", 1, 0],
    ]);
    expect(result.exchanges.every((exchange) => exchange.response?.body.kind === "binary"
      && exchange.response.body.previewHex === undefined)).toBe(true);
    expect(result.exchanges[1]?.response?.body).toMatchObject({ kind: "binary", omittedReason: "credential-match" });
    const serialized = JSON.stringify(result);
    expect(serialized.includes(observedSessionCookie)).toBe(false);
    expect(serialized.includes(Buffer.from(observedSessionCookie, "utf8").toString("hex"))).toBe(false);
    expect(result.exchanges[0]?.response?.cookies[0]).toBe("sid=[REDACTED]; HttpOnly; SameSite=Lax");
    expect(result.exchanges[1]?.request?.headers).toContainEqual(["cookie", "sid=[REDACTED]"]);
    expect(result.exchanges[0]?.request?.sourceCategories).not.toContain("session");
    expect(result.exchanges[1]?.request?.sourceCategories).toContain("session");
    expect(result.exchanges[0]?.request?.url).not.toContain(observedSessionCookie);
    expect(result.replay).toMatchObject({ mode: "case", settings: { connectTimeoutMs: 1234 }, requestTemplate: { protocol: "http", path: "/rows/{{item}}" } });
    expect(result.exchanges[0]?.intent?.parameters.item).toBe(`one-[REDACTED]`);
    expect(result.exchanges[0]?.intent?.fields).toContainEqual({ path: "parameters.item", status: "redacted", needsInput: true });
    expect(replayInvocation).toMatchObject({ mode: "case", case: { caseId: "rows-case", scope: "base" }, settings: { connectTimeoutMs: 1234 } });
    expect(replayResult.run.total).toBe(101);
    expect(replayResult.exchangeTotal).toBe(101);
  });

  it("reapplies one-MiB body and two-MiB call budgets after late marker projection", () => {
    const { plan } = execution(createContractExecutionProject(baseUrl));
    const collector = createDebugExchangeCollector([]);
    const identity = (rowIndex: number) => ({
      rowIndex, settings: resolveRequestSettings(),
      source: { sourceKind: "asset" as const, case: { ...ids, caseId: "budget-case", scope: "base" } },
    });
    const transfer = { fileBytesRead: 0, transportEncodedBytesWritten: 0, complete: true };
    const bodyText = "k".repeat(600 * 1024);
    const observeText = (rowIndex: number, text: string, rawHeaders: Array<[string, string]> = []) => {
      const bodyBytes = Buffer.from(text, "utf8");
      collector.observe({
        type: "response", hopIndex: 0, url: `http://127.0.0.1/${rowIndex}`, status: 200,
        headers: Object.fromEntries(rawHeaders), rawHeaders, encodedBytes: bodyBytes.byteLength,
        decodedBytes: bodyBytes.byteLength, bodyComplete: true, bodyBytes,
        textAvailable: true, jsonAvailable: false, bodyText: text,
        requestBody: transfer, requestBodyChain: transfer,
      }, identity(rowIndex));
    };
    observeText(0, bodyText);
    observeText(1, bodyText);
    observeText(2, bodyText);
    observeText(3, "ok", [["set-cookie", "sid=k"]]);
    const run: ProjectRunResult = {
      collectionId: ids.collectionId, collectionName: "collection", startedAt: "start", finishedAt: "finish",
      total: 4, passed: 4, failed: 0, cases: [],
    };

    const result = projectDebugResult({
      plan, runId: "budget-run", run, collector, markers: collector.markers(),
      projectionReliable: collector.projectionReliable(), startedAt: "start", finishedAt: "finish",
    });

    const summaries = result.exchanges.map((exchange) => exchange.response?.body)
      .filter((body): body is Extract<NonNullable<typeof body>, { kind: "text" }> => body?.kind === "text");
    expect(summaries[0]?.truncated).toBe(true);
    expect(Buffer.byteLength(summaries[0]?.text ?? "", "utf8")).toBeLessThanOrEqual(1024 * 1024);
    expect(summaries[2]?.text).toBe("");
    expect(summaries[2]?.truncated).toBe(true);
    expect(summaries.reduce((sum, body) => sum + Buffer.byteLength(body.text, "utf8"), 0)).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it("omits captured and effective filenames when their initial summaries are truncated", () => {
    const { plan } = execution(createContractExecutionProject(baseUrl));
    const collector = createDebugExchangeCollector([]);
    const identityAt = (rowIndex: number) => ({
      rowIndex, settings: resolveRequestSettings(),
      source: { sourceKind: "asset" as const, case: { ...ids, caseId: "filename-budget-case", scope: "base" } },
    });
    const oversizedFilename = "f".repeat(1024 * 1024 + 1);
    const observeFileRequest = (rowIndex: number, body: { kind: "binary"; file: { path: string }; contentType: string } | {
      kind: "multipart"; entries: Array<{ kind: "file"; name: string; file: { path: string }; filename: string; contentType: string }>;
    }) => {
      collector.observe({
        type: "request", hopIndex: 0, url: `${baseUrl}/filename-${rowIndex}`, method: "POST",
        request: { protocol: "http", url: `${baseUrl}/filename-${rowIndex}`, method: "POST", headers: {}, query: [], auth: { kind: "none" }, body },
        capturedFiles: [{ entryIndex: 0, available: true, capturedFilename: oversizedFilename, capturedSizeBytes: 4, effectiveFilename: oversizedFilename }],
      }, identityAt(rowIndex));
    };
    observeFileRequest(0, { kind: "binary", file: { path: "private/binary.bin" }, contentType: "application/octet-stream" });
    observeFileRequest(1, { kind: "multipart", entries: [{ kind: "file", name: "upload", file: { path: "private/multipart.bin" }, filename: oversizedFilename, contentType: "application/octet-stream" }] });
    const run: ProjectRunResult = {
      collectionId: ids.collectionId, collectionName: "collection", startedAt: "start", finishedAt: "finish",
      total: 2, passed: 2, failed: 0, cases: [],
    };

    const result = projectDebugResult({
      plan, runId: "filename-budget-run", run, collector, markers: collector.markers(),
      startedAt: "start", finishedAt: "finish",
    });

    const binaryBody = result.exchanges[0]?.request?.body;
    expect(binaryBody).toMatchObject({ kind: "binary", metadataAvailable: true, capturedSizeBytes: 4 });
    expect(binaryBody).not.toHaveProperty("capturedFilename");
    expect(binaryBody).not.toHaveProperty("effectiveFilename");
    const multipartBody = result.exchanges[1]?.request?.body;
    expect(multipartBody).toMatchObject({ kind: "multipart", entries: [{ kind: "file", metadataAvailable: true, capturedSizeBytes: 4 }] });
    expect(multipartBody?.kind === "multipart" ? multipartBody.entries[0] : undefined).not.toHaveProperty("filename");
    expect(multipartBody?.kind === "multipart" ? multipartBody.entries[0] : undefined).not.toHaveProperty("capturedFilename");
    expect(multipartBody?.kind === "multipart" ? multipartBody.entries[0] : undefined).not.toHaveProperty("effectiveFilename");
  });

  it("withholds an unsafe replay parameter key and case identity instead of emitting a masked locator", async () => {
    const project = createContractExecutionProject(baseUrl);
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.contract.request = requestAt("/identity");
    asset.cases[0]!.requestOverride = requestAt("/effective-case-template");
    const snapshot = createProjectSnapshot(project);
    const requestPlan = prepareDebugExecution(snapshot, {
      mode: "request", locator: ids, request: requestAt("/identity"),
      parameters: { "synthetic-marker": "synthetic-marker" }, fields: [],
    });
    const unsafeLocatorPlan = {
      ...requestPlan,
      invocation: { ...requestPlan.invocation, locator: { ...ids, folderIds: ["synthetic-marker"] } },
    };
    const casePlan = prepareDebugExecution(snapshot, {
      mode: "case", locator: ids,
      case: { ...ids, caseId: contractExecutionIds.case, scope: "base" },
    });
    expect(casePlan.requestTemplate.path).toBe("/effective-case-template");
    const run: ProjectRunResult = {
      collectionId: ids.collectionId, collectionName: "collection", startedAt: "start", finishedAt: "finish",
      total: 1, passed: 1, failed: 0,
      cases: [{ apiId: "synthetic-marker", apiName: "api", caseId: "safe-case", caseName: "case", passed: true, durationMs: 1, assertions: [] }],
    };
    const collector = createDebugExchangeCollector(["synthetic-marker"]);
    const requestResult = projectDebugResult({
      plan: unsafeLocatorPlan, runId: "run", run, collector, markers: ["synthetic-marker"],
      startedAt: "start", finishedAt: "finish",
    });
    expect(requestResult.replay.available).toBe(false);
    expect(JSON.stringify(requestResult).includes("synthetic-marker")).toBe(false);
    expect(requestResult.source).toMatchObject({ sourceKind: "asset", locator: ids });
    expect(requestResult.outcomes[0]?.apiId).toBeUndefined();
    expect(requestResult.outcomes[0]?.identityAvailable).toBe(false);

    const caseInvocation = {
      mode: "case" as const,
      locator: ids,
      case: { ...ids, caseId: contractExecutionIds.case, scope: "synthetic-marker" },
    };
    const caseResult = projectDebugResult({
      plan: { ...casePlan, invocation: caseInvocation }, runId: "run", run, collector,
      markers: ["synthetic-marker"], startedAt: "start", finishedAt: "finish",
    });
    expect(caseResult.replay.available).toBe(false);
    expect(JSON.stringify(caseResult).includes("synthetic-marker")).toBe(false);
    if (caseResult.replay.mode !== "case") throw new Error("Expected a case replay descriptor.");
    expect(caseResult.replay.case).toBeUndefined();
    expect(caseResult.replay.identityAvailable).toBe(false);
  });

  it("withholds free text and identity when observed credential markers exceed the bounded projection set", () => {
    const { plan } = execution(createContractExecutionProject(baseUrl));
    const oversizedCookie = "synthetic-overflow-cookie-".repeat(1000);
    const collector = createDebugExchangeCollector([]);
    const identity = {
      rowIndex: 0,
      settings: resolveRequestSettings(),
      source: { sourceKind: "asset" as const, case: { ...ids, caseId: contractExecutionIds.case, scope: "base" } },
    };
    const rawCookie = `sid=${oversizedCookie}; HttpOnly`;
    collector.observe({
      type: "response",
      hopIndex: 0,
      url: `${baseUrl}/overflow`,
      status: 200,
      headers: { "content-type": "text/plain", "set-cookie": rawCookie },
      rawHeaders: [["content-type", "text/plain"], ["set-cookie", rawCookie]],
      encodedBytes: 2,
      decodedBytes: 2,
      bodyComplete: true,
      bodyBytes: Buffer.from("ok"),
      textAvailable: true,
      jsonAvailable: false,
      bodyText: "ok",
      requestBody: { fileBytesRead: 0, transportEncodedBytesWritten: 0, complete: true },
      requestBodyChain: { fileBytesRead: 0, transportEncodedBytesWritten: 0, complete: true },
    }, identity);
    const run: ProjectRunResult = {
      collectionId: ids.collectionId,
      collectionName: oversizedCookie,
      startedAt: "start",
      finishedAt: "finish",
      total: 1,
      passed: 0,
      failed: 1,
      cases: [{
        apiId: contractExecutionIds.contract,
        apiName: oversizedCookie,
        caseId: contractExecutionIds.case,
        caseName: oversizedCookie,
        passed: false,
        durationMs: 1,
        assertions: [{ pass: false, message: oversizedCookie }],
        error: oversizedCookie,
      }],
    };

    const result = projectDebugResult({
      plan,
      runId: "run",
      run,
      collector,
      markers: collector.markers(),
      projectionReliable: collector.projectionReliable(),
      startedAt: "start",
      finishedAt: "finish",
    });

    expect(collector.projectionReliable()).toBe(false);
    expect(result.run.collectionName).toBe("[REDACTED]");
    expect(result.outcomes[0]?.apiName).toBe("[REDACTED]");
    expect(result.outcomes[0]?.error).toBe("[REDACTED]");
    expect(JSON.stringify(result).includes("synthetic-overflow-cookie-")).toBe(false);
  });

  it("downgrades a truncated text body when a later marker may straddle its retained boundary", () => {
    const { plan } = execution(createContractExecutionProject(baseUrl));
    const marker = "synthetic-late-cookie-value";
    const retainedPrefix = marker.slice(0, 8);
    const firstBodyText = `${"x".repeat(1024 * 1024 - retainedPrefix.length)}${retainedPrefix}unretained-tail`;
    const collector = createDebugExchangeCollector([]);
    const observeResponse = (rowIndex: number, bodyText: string, headers: Array<[string, string]>) => {
      const rawHeaders = [["content-type", "text/plain"], ...headers] as Array<[string, string]>;
      collector.observe({
        type: "response",
        hopIndex: 0,
        url: `${baseUrl}/late-marker/${rowIndex}`,
        status: 200,
        headers: Object.fromEntries(rawHeaders),
        rawHeaders,
        encodedBytes: Buffer.byteLength(bodyText),
        decodedBytes: Buffer.byteLength(bodyText),
        bodyComplete: true,
        bodyBytes: Buffer.from(bodyText),
        textAvailable: true,
        jsonAvailable: false,
        bodyText,
        requestBody: { fileBytesRead: 0, transportEncodedBytesWritten: 0, complete: true },
        requestBodyChain: { fileBytesRead: 0, transportEncodedBytesWritten: 0, complete: true },
      }, {
        rowIndex,
        settings: resolveRequestSettings(),
        source: { sourceKind: "asset" as const, case: { ...ids, caseId: contractExecutionIds.case, scope: "base" } },
      });
    };

    observeResponse(0, firstBodyText, []);
    const firstBody = collector.exchanges()[0]?.response?.body;
    if (firstBody?.kind !== "text") throw new Error("Expected the initial body to have a text preview.");
    expect(firstBody.truncated).toBe(true);
    expect(firstBody.text.endsWith(retainedPrefix)).toBe(true);

    observeResponse(1, "ok", [["set-cookie", `sid=${marker}; HttpOnly`]]);
    const result = projectDebugResult({
      plan,
      runId: "run",
      run: {
        collectionId: ids.collectionId, collectionName: "collection", startedAt: "start", finishedAt: "finish",
        total: 2, passed: 2, failed: 0, cases: [],
      },
      collector,
      markers: collector.markers(),
      projectionReliable: collector.projectionReliable(),
      startedAt: "start",
      finishedAt: "finish",
    });

    expect(result.exchanges[0]?.response?.body).toMatchObject({ kind: "metadata", omittedReason: "unreliable" });
    expect(JSON.stringify(result).includes(retainedPrefix)).toBe(false);
  });

  it("projects a known request literal safely when cancellation occurs before any network observation", async () => {
    const project = createContractExecutionProject(baseUrl);
    const snapshot = createProjectSnapshot(project);
    const request = requestAt("/abort");
    request.body = { kind: "text", content: "synthetic-marker" };
    const plan = prepareDebugExecution(snapshot, {
      mode: "request", locator: ids, settings: { connectTimeoutMs: 1234 }, request, parameters: {}, fields: [],
    });

    const aborted = abortedDebugResult(plan, "run", "start");

    expect(JSON.stringify(aborted).includes("synthetic-marker")).toBe(false);
    expect(aborted.replay.available).toBe(false);
    expect(aborted.replay.fields).toContainEqual({ path: "request", status: "redacted", needsInput: true });
    expect(aborted.replay.settings).toEqual({ connectTimeoutMs: 1234 });
  });

  it("preserves collection script failure kind and error even without completed rows", async () => {
    const project = createContractExecutionProject(baseUrl);
    project.collections[0]!.preOperations = [{ id: "container-fail", type: "script", content: 'throw new Error("synthetic-container-failure")' }];
    const { snapshot, plan, run } = execution(project);

    const result = await runDebugExecution(plan, run, { registry: createDefaultRegistry(), credentialMarkers: [] });

    expect(result.run.total).toBe(0);
    expect(result.failureKind).toBe("script");
    expect(result.error).toContain("synthetic-container-failure");
  });

  it("preserves completed outcomes when a collection post-operation fails", async () => {
    const project = createContractExecutionProject(baseUrl);
    project.collections[0]!.postOperations = [{ id: "container-post-fail", type: "script", content: 'throw new Error("synthetic-post-failure")' }];
    const { plan, run } = execution(project);

    const result = await runDebugExecution(plan, run, { registry: createDefaultRegistry(), credentialMarkers: [] });

    expect(result.run.total).toBe(1);
    expect(result.outcomes[0]?.passed).toBe(true);
    expect(result.failureKind).toBe("script");
    expect(result.error).toContain("synthetic-post-failure");
  });

  it("collects a legacy HTTP plugin response without inventing final request bytes or headers", async () => {
    const project = createContractExecutionProject(baseUrl);
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.contract.request = requestAt("/legacy-plugin");
    const snapshot = createProjectSnapshot(project);
    const plan = prepareDebugExecution(snapshot, {
      mode: "case", locator: ids, case: { ...ids, caseId: contractExecutionIds.case, scope: "base" },
    });
    const registry = createDefaultRegistry();
    const defaultGetProtocol = registry.getProtocol.bind(registry);
    let legacyCalls = 0;
    const legacyClient = {
      name: "legacy-http",
      canHandle: (request: { protocol: string }) => request.protocol === "http",
      execute: async () => {
        legacyCalls += 1;
        return { status: 200, headers: { "content-type": "text/xml" }, bodyText: "<Envelope>legacy</Envelope>", timeMs: 4 };
      },
    };
    registry.getProtocol = (request) => request.protocol === "http" ? legacyClient : defaultGetProtocol(request);
    const run: ProjectExecutionRun = {
      snapshot: plan.snapshot,
      credentialBindings: { resolve: () => { throw new Error("No credentials are used by this test."); }, versions: {} },
    };

    const result = await runDebugExecution(plan, run, { registry });

    expect(legacyCalls).toBe(1);
    expect(result.exchangeTotal).toBe(1);
    expect(result.exchanges[0]).toMatchObject({ observation: "legacy-text", transportState: "responded" });
    expect(result.exchanges[0]?.request).toBeUndefined();
    expect(result.exchanges[0]?.response).toMatchObject({ status: 200, body: { kind: "text", text: "<Envelope>legacy</Envelope>" } });
    expect(result.exchanges[0]?.response?.rawHeaders).toBeUndefined();
    expect(result.exchanges[0]?.response?.encodedReceivedBytes).toBeUndefined();
    expect(result.exchanges[0]?.durationMs).toBe(4);
  });

  it("collects credentials from legacy responses after the 100-exchange display cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-debug-legacy-rows-"));
    tempDirs.push(dir);
    const dataPath = join(dir, "legacy-rows.json");
    writeFileSync(dataPath, JSON.stringify(Array.from({ length: 101 }, (_, index) => ({ item: `row-${index}` }))), "utf8");
    const lateCookie = "sid=synthetic-late-legacy-cookie-secret";
    const project = createContractExecutionProject(baseUrl);
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.contract.request = requestAt("/legacy-{{item}}");
    asset.cases = [{
      id: "legacy-rows-case", name: "legacy rows", scope: "base", parameters: {},
      dataDriver: { sourcePath: dataPath, format: "json" },
      preOperations: [],
      postOperations: [{ id: "echo-cookie-into-assertion", type: "script", content: 'pm.assert(false, pm.response?.headers["set-cookie"] ?? "missing-cookie")' }],
      assertions: [],
    }];
    const snapshot = createProjectSnapshot(project);
    const plan = prepareDebugExecution(snapshot, {
      mode: "case", locator: ids, case: { ...ids, caseId: "legacy-rows-case", scope: "base" },
    });
    const registry = createDefaultRegistry();
    const defaultGetProtocol = registry.getProtocol.bind(registry);
    let legacyCalls = 0;
    const legacyClient = {
      name: "legacy-http",
      canHandle: (request: { protocol: string }) => request.protocol === "http",
      execute: async () => {
        const rowIndex = legacyCalls++;
        const headers: Record<string, string> = rowIndex === 100 ? { "set-cookie": lateCookie } : { "content-type": "text/plain" };
        return {
          status: 200,
          headers,
          bodyText: "ok",
          timeMs: 4,
        };
      },
    };
    registry.getProtocol = (request) => request.protocol === "http" ? legacyClient : defaultGetProtocol(request);
    const run: ProjectExecutionRun = {
      snapshot: plan.snapshot,
      credentialBindings: { resolve: () => { throw new Error("No credentials are used by this test."); }, versions: {} },
    };

    const preparedTestData = await prepareTestData(plan.snapshot, testDataSelectionsForRequests(plan.snapshot, plan.credentialSelections), { workspaceRoot: dir });
    const result = await runDebugExecution(plan, { ...run, preparedTestData }, { registry });

    expect(legacyCalls).toBe(101);
    expect(result.exchanges).toHaveLength(100);
    expect(result.exchangeTotal).toBe(101);
    expect(result.outcomes[100]?.assertions).toContainEqual({ pass: false, message: "[REDACTED]" });
    expect(JSON.stringify(result).includes(lateCookie)).toBe(false);
  });

  it("keeps a combined form body summary within one MiB", () => {
    const collector = createDebugExchangeCollector([]);
    const request = {
      protocol: "http" as const, method: "POST" as const, url: `${baseUrl}/form`, query: [], headers: {}, auth: { kind: "none" as const },
      body: { kind: "form" as const, content: "", form: [{ key: "a", value: "X".repeat(800 * 1024), enabled: true }, { key: "b", value: "Y".repeat(800 * 1024), enabled: true }] },
    };
    collector.observe({ type: "request", hopIndex: 0, request, url: request.url, method: request.method }, {
      rowIndex: 0, settings: resolveRequestSettings(),
      source: { sourceKind: "asset" as const, case: { ...ids, caseId: "case", scope: "base" } },
    });

    const body = collector.exchanges()[0]!.request!.body;
    if (body.kind !== "form") throw new Error("Expected a form body summary.");
    const summaryBytes = body.fields.reduce((sum, field) => sum + Buffer.byteLength(field.key) + Buffer.byteLength(field.value), 0);
    expect(summaryBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(body.fields[1]?.truncated).toBe(true);
  });
});

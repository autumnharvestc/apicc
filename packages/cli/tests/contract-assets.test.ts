import { createServer, request as httpRequest } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CredentialError, createDefaultRegistry, createProjectSnapshot, createNetworkProfileHost, createOAuthProfileHost, fileStorage, type AuthBinding, type PluginRegistry, type RunResult, type SecretStore, type Workspace } from "@apicc/core";
import { createMcpServer } from "../src/mcp/server.js";
import { prepareExecutionRun, stableCredentialError } from "../src/credentials.js";
import { formatOAuthActionFailure, runCli as runCliActual, type RunCliDeps } from "../src/main.js";
import { spawnOwnedCliProcess } from "./helpers/ownedCliProcess.js";
import { workflowReportScenarios } from "../../core/tests/helpers/contractExecutionFixtures.js";

const groupA = "00000000-0000-4000-8000-000000000002";
const groupB = "00000000-0000-4000-8000-000000000003";
const projectId = "00000000-0000-4000-8000-000000000004";
const collectionId = "00000000-0000-4000-8000-000000000008";
const outerFolderId = "00000000-0000-4000-8000-000000000031";
const innerFolderId = "00000000-0000-4000-8000-000000000032";
const deepApiId = "00000000-0000-4000-8000-000000000033";
const otherApiId = "00000000-0000-4000-8000-000000000034";
const caseId = "00000000-0000-4000-8000-000000000035";
const workerCaseId = "00000000-0000-4000-8000-000000000036";
const basicApiId = "00000000-0000-4000-8000-000000000037";
const queryApiId = "00000000-0000-4000-8000-000000000038";
const basicRefId = "basic-password";
const queryRefId = "query-key";

let server: ReturnType<typeof createServer>;
let baseUrl = "";
let root = "";
let networkPrivateRoot = "";
let workerNetworkIdentity = "";
let requestPath = "";
let authorizationHeader = "";
const observedRequests: Array<{ url: string; authorization: string; cookie?: string; body?: string }> = [];

function runCli(argv: string[], registry: PluginRegistry, log: (line: string) => void = () => {}, deps: RunCliDeps = {}): Promise<number> {
  return runCliActual(argv, registry, log, { networkPrivateRoot, ...deps });
}

const deepApiPath = [
  "groups", groupA, "projects", projectId, "collections", collectionId,
  "folders", outerFolderId, "folders", innerFolderId, "apis", deepApiId,
].join("/");

function api(
  id: string,
  name: string,
  documentation: string,
  cases: Workspace["groups"][number]["projects"][number]["collections"][number]["apis"][number]["cases"] = [],
  path = "/contract-assets",
  auth: AuthBinding = { kind: "none" },
) {
  return {
    contract: {
      formatVersion: 1 as const,
      id,
      metadata: { name, description: "", tags: [], version: "1", status: "published" as const },
      request: {
        protocol: "http" as const,
        method: "GET" as const,
        baseUrl,
        path,
        pathParams: [], query: [], headers: [], cookies: [],
        auth,
        body: { kind: "none" as const },
      },
      responses: [],
    },
    cases,
    documentation,
  };
}

function workspace(): Workspace {
  const deep = api(deepApiId, "deep", "来自指定 group 的设计正文", [{
    id: caseId, name: "base", scope: "base", parameters: {}, preOperations: [], postOperations: [], assertions: [],
  }], "/{{outer}}/{{inner}}");
  return {
    formatVersion: 1,
    id: "00000000-0000-4000-8000-000000000001",
    name: "contract-assets",
    variables: {},
    groups: [
      {
        id: groupA,
        name: "same",
        projects: [{
          id: projectId,
          name: "same-project",
          variables: {},
          globals: {},
        environments: [{ id: "00000000-0000-4000-8000-000000000039", name: "dev", variables: {} }],
          workflows: [],
          stressPolicy: { trustedOrigins: [baseUrl], deniedOrigins: [] },
          models: [],
          components: [],
          collections: [{
            id: collectionId,
            name: "same-collection",
            variables: {},
            preOperations: [],
            postOperations: [],
            apis: [],
            folders: [{
              id: outerFolderId,
              name: "outer",
              preOperations: [{ id: "outer-pre", type: "script", content: 'pm.variables.set("outer", "preserved");' }],
              postOperations: [],
              apis: [],
              folders: [{
                id: innerFolderId,
                name: "inner",
                preOperations: [{ id: "inner-pre", type: "script", content: 'pm.variables.set("inner", "preserved");' }],
                postOperations: [],
                apis: [deep],
                folders: [],
              }],
            }],
          }],
        }],
      },
      {
        id: groupB,
        name: "same",
        projects: [{
          id: projectId,
          name: "same-project",
          variables: {},
          globals: {},
          environments: [{ id: "00000000-0000-4000-8000-000000000040", name: "dev", variables: {} }],
          workflows: [],
        stressPolicy: { trustedOrigins: [baseUrl], deniedOrigins: [] },
          models: [],
          components: [],
          collections: [{
            id: collectionId,
            name: "same-collection",
            variables: {},
            preOperations: [],
            postOperations: [],
            apis: [api(otherApiId, "other", "来自另一个 group 的设计正文", [{
              id: workerCaseId, name: "worker", scope: "base", parameters: {}, preOperations: [], postOperations: [], assertions: [],
            }], "/worker", { kind: "bearer", token: { id: "__proto__", policy: "test-auto" } }),
            api(basicApiId, "basic", "Basic auth echo", [{
              id: workerCaseId, name: "basic", scope: "base", parameters: {}, preOperations: [], postOperations: [], assertions: [
                { id: "basic-echo", target: "bodyJson", path: "$.authorization", op: "contains", expected: "Basic" },
              ],
            }], "/basic", { kind: "basic", username: "alice", password: { id: basicRefId, policy: "test-auto" } }),
            api(queryApiId, "query", "API key query echo", [{
              id: workerCaseId, name: "query", scope: "base", parameters: {}, preOperations: [], postOperations: [], assertions: [
                { id: "query-echo", target: "bodyJson", path: "$.url", op: "contains", expected: "api%20key" },
              ],
            }], "/query", { kind: "apikey", name: "api key", placement: "query", value: { id: queryRefId, policy: "test-auto" } })],
            folders: [],
          }],
        }],
      },
    ],
  };
}

async function connectMcp(allowRun = false) {
  const mcp = createMcpServer(root, { allowRun, registry: createDefaultRegistry(), log: () => {} });
  const client = new Client({ name: "contract-assets-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function resultText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content.map((entry) => entry.text).join("\n");
}

function protoWorkerArgs(definitionRevision: string, credentialVersionsJson: string, networkIdentity = workerNetworkIdentity): string[] {
  return [
    "stress-worker", `groups/${groupB}/projects/${projectId}/collections/${collectionId}/apis/${otherApiId}`,
    "--case", workerCaseId, "--concurrency", "1", "--iterations", "1", "--shard-id", "proto-worker",
    "--workspace", root, "--definition-revision", definitionRevision, "--credential-versions", credentialVersionsJson,
    "--network-identity", networkIdentity,
  ];
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    request.on("end", () => {
      requestPath = request.url ?? "";
      authorizationHeader = request.headers.authorization ?? "";
      const captureUpload = requestPath === "/child-override/child-parameter" || requestPath === "/cli-settings";
      observedRequests.push({
        url: requestPath,
        authorization: authorizationHeader,
        ...(captureUpload && request.headers.cookie ? { cookie: request.headers.cookie } : {}),
        ...(captureUpload && chunks.length > 0 ? { body: Buffer.concat(chunks).toString("utf8") } : {}),
      });
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      if (requestPath === "/cli-login") {
        response.setHeader("set-cookie", "cli-run=ready; Path=/");
        response.end(JSON.stringify({ url: requestPath, authorization: authorizationHeader }));
      } else if (requestPath === "/cli-settings") {
        setTimeout(() => {
          if (!response.destroyed) response.end(JSON.stringify({ url: requestPath, authorization: authorizationHeader }));
        }, 250);
      } else {
        if (captureUpload && !request.headers.cookie) response.setHeader("set-cookie", "cli-vu=ready; Path=/");
        response.end(JSON.stringify({ url: requestPath, authorization: authorizationHeader }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  root = mkdtempSync(join(tmpdir(), "apicc-contract-assets-"));
  const initial = await fileStorage.load(root);
  await fileStorage.save(root, workspace(), { expectedRevision: initial.revision, deletions: [] });
  networkPrivateRoot = mkdtempSync(join(tmpdir(), "apicc-network-private-"));
  const identityHost = await createNetworkProfileHost({
    workspaceRoot: root,
    project: { workspaceId: workspace().id, groupId: groupB, projectId },
    privateRoot: networkPrivateRoot,
    secretStore: { async put() {}, async resolve() { throw new Error("unexpected network secret"); }, async version() { return "unused"; }, async remove() {}, async status() { return "missing"; } },
  });
  workerNetworkIdentity = (await identityHost.prepare()).identity;
});

afterAll(async () => {
  if (networkPrivateRoot) rmSync(networkPrivateRoot, { recursive: true, force: true });
  if (root) rmSync(root, { recursive: true, force: true });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("contract workspace CLI/MCP consumption", () => {
  it("keeps retry OR and recover CLI exits and JSON HTML JUnit verdicts consistent", async () => {
    const ws = workspace(); const project = ws.groups[0]!.projects[0]!; project.workflows = workflowReportScenarios(deepApiId, caseId);
    const fixtureRoot = mkdtempSync(join(tmpdir(), "apicc-c1-report-cli-")); const initial = await fileStorage.load(fixtureRoot);
    await fileStorage.save(fixtureRoot, ws, { expectedRevision: initial.revision, deletions: [] });
    const previousCwd = process.cwd(); const selected = createDefaultRegistry(); let calls = 0;
    selected.registerProtocol({ name: "http", canHandle: () => true, execute: async () => { if (++calls !== 2) throw new Error("transport failure"); return { status: 200, headers: {}, bodyText: "", timeMs: 0 }; } });
    try {
      process.chdir(fixtureRoot);
      for (const flow of project.workflows.slice(0, 3)) {
        const out = join(fixtureRoot, ".apicc", flow.name);
        expect(await runCli(["run-workflow", `groups/${groupA}/projects/${projectId}/workflows/${flow.id}`, "--runs-dir", out, "--reporters", "html,junit"], selected, () => {}, { loadPlugins: false })).toBe(0);
        const files = readdirSync(out); const report = JSON.parse(readFileSync(join(out, files.find((file) => file.endsWith(".json"))!), "utf8")) as RunResult;
        expect(report.workflow?.verdict).toBe("passed"); expect(report.reportingUnits).toMatchObject({ total: 1, passed: 1, failed: 0 });
        if (flow.name !== "or") expect(report.cases.some((row) => !row.passed)).toBe(true);
        expect(readFileSync(join(out, files.find((file) => file.endsWith(".xml"))!), "utf8")).toContain('tests="1" failures="0"');
        expect(readFileSync(join(out, files.find((file) => file.endsWith(".html"))!), "utf8")).toContain("workflow-invocation-v2");
      }
      selected.registerReporter({ format: "broken", render: async () => { throw new Error("private renderer error"); } });
      const out = join(fixtureRoot, ".apicc", "broken");
      expect(await runCli(["run-workflow", `groups/${groupA}/projects/${projectId}/workflows/${project.workflows[1]!.id}`, "--runs-dir", out, "--reporters", "broken"], selected, () => {}, { loadPlugins: false })).toBe(1);
      expect(readdirSync(out).some((file) => file.endsWith(".json"))).toBe(true);
    } finally { process.exitCode = 0; process.chdir(previousCwd); rmSync(fixtureRoot, { recursive: true, force: true }); }
  });
  it("validates workflow run inputs before credentials and cancels through signals with safe partial JSON", async () => {
    const core = await import("@apicc/core"); const ws = workspace(); const project = ws.groups[0]!.projects[0]!;
    project.collections[0]!.folders[0]!.folders[0]!.apis[0]!.contract.request.auth = { kind: "bearer", token: { id: "cancel-prepare", policy: "test-auto" } };
    const id = "00000000-0000-4000-8000-000000000096";
    project.workflows = [core.WorkflowSchema.parse({ id, name: "C1", status: "enabled", executionVersion: 2, inputs: { required: { required: true } },
      nodes: [{ id: "request", kind: "request", apiId: deepApiId, caseId }], edges: [] })];
    const fixtureRoot = mkdtempSync(join(tmpdir(), "apicc-c1-cli-")); const initial = await fileStorage.load(fixtureRoot);
    await fileStorage.save(fixtureRoot, ws, { expectedRevision: initial.revision, deletions: [] });
    const previousCwd = process.cwd(); const out = join(fixtureRoot, ".apicc", "runs");
    const args = ["run-workflow", `groups/${groupA}/projects/${projectId}/workflows/${id}`, "--runs-dir", out];
    const selected = createDefaultRegistry(); let calls = 0; let release!: () => void; let entered!: () => void;
    let preparationAbort = false; let preparationReject = false;
    const secretStore: SecretStore = { async put() {}, async remove() {}, async status() { return "available"; }, async resolve() { return "safe-preparation-secret"; }, async version() { if (preparationAbort) { preparationAbort = false; process.emit("SIGTERM"); } if (preparationReject) throw new Error("private-preparation-failure"); return "one"; } };
    const started = new Promise<void>((resolve) => { entered = resolve; }); const pending = new Promise<void>((resolve) => { release = resolve; });
    selected.registerProtocol({ name: "http", canHandle: () => true, execute: async () => { calls++; entered(); await pending; return { status: 200, headers: {}, bodyText: "", timeMs: 0 }; } });
    try {
      process.chdir(fixtureRoot);
      await expect(runCli([...args, "--inputs", "{}"], selected, () => {}, { loadPlugins: false })).rejects.toThrow(/input/);
      await expect(runCli([...args, "--inputs", '{"required":1}', "--concurrency", "33"], selected, () => {}, { loadPlugins: false })).rejects.toThrow();
      expect(calls).toBe(0);
      preparationAbort = true; const beforeRequestOut = join(fixtureRoot, ".apicc", "preparation-abort");
      expect(await runCli([...args, "--inputs", '{"required":1}', "--runs-dir", beforeRequestOut], selected, () => {}, { loadPlugins: false, secretStore })).toBe(1);
      const beforeRequestReport = JSON.parse(readFileSync(join(beforeRequestOut, readdirSync(beforeRequestOut).find((file) => file.endsWith(".json"))!), "utf8")) as RunResult;
      expect(beforeRequestReport.workflow?.verdict).toBe("aborted"); expect(beforeRequestReport.cases).toEqual([]); expect(calls).toBe(0);
      const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
      preparationAbort = preparationReject = true;
      const rejectedOut = join(fixtureRoot, ".apicc", "rejected-preparation-abort");
      expect(await runCli([...args, "--inputs", '{"required":1}', "--runs-dir", rejectedOut], selected, () => {}, { loadPlugins: false, secretStore })).toBe(1);
      const rejectedJson = readFileSync(join(rejectedOut, readdirSync(rejectedOut).find((file) => file.endsWith(".json"))!), "utf8");
      const rejectedReport = JSON.parse(rejectedJson) as RunResult;
      expect(rejectedReport).toMatchObject({ reportingMode: "workflow-invocation-v2", total: 0, failed: 0, cases: [], requestFacts: { requestStarted: 0, requestCompleted: 0, httpExchanges: 0 }, workflow: { verdict: "aborted" } });
      expect(rejectedReport.executionIdentity?.invocationId).toBeTruthy();
      expect(rejectedJson).not.toContain("private-preparation-failure"); expect(rejectedJson).not.toContain("safe-preparation-secret");
      expect(calls).toBe(0); expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
      await expect(runCli([...args, "--inputs", '{"required":1}'], selected, () => {}, { loadPlugins: false, secretStore })).rejects.toMatchObject({ name: "StableCredentialError", code: "CREDENTIAL_UNAVAILABLE" });
      expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before); preparationReject = false;
      let settled = false;
      const running = runCli([...args, "--inputs", '{"required":1}', "--concurrency", "1", "--timeout-ms", "2000", "--reporters", "json"], selected, () => {}, { loadPlugins: false, secretStore });
      running.then(() => { settled = true; }, () => { settled = true; });
      await started; process.emit("SIGINT"); await Promise.resolve(); expect(settled).toBe(false); release();
      expect(await running).toBe(1);
      expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
      const report = JSON.parse(readFileSync(join(out, readdirSync(out).find((file) => file.startsWith("workflow-"))!), "utf8")) as RunResult;
      expect(report.workflow?.verdict).toBe("aborted"); expect(report.reportingMode).toBe("workflow-invocation-v2"); expect(report.cases).toHaveLength(1);
      expect((await fileStorage.load(fixtureRoot)).workspace.groups[0]!.projects[0]!.workflows[0]).toEqual(project.workflows[0]);
    } finally { release?.(); process.exitCode = 0; process.chdir(previousCwd); rmSync(fixtureRoot, { recursive: true, force: true }); }
  });
  it("returns nonzero for a stopped standalone v1 root while preserving the late passed row and drain", async () => {
    const ws = workspace(); const project = ws.groups[0]!.projects[0]!;
    const id = "00000000-0000-4000-8000-000000000097";
    project.workflows = [{ id, name: "v1 stop", status: "enabled", nodes: [{ id: "request", kind: "request", apiId: deepApiId, caseId }], edges: [] }];
    const fixtureRoot = mkdtempSync(join(tmpdir(), "apicc-v1-stop-cli-")); const initial = await fileStorage.load(fixtureRoot);
    await fileStorage.save(fixtureRoot, ws, { expectedRevision: initial.revision, deletions: [] });
    const previousCwd = process.cwd(); const out = join(fixtureRoot, ".apicc", "runs");
    const selected = createDefaultRegistry(); let release!: () => void; let entered!: () => void; let active = 0; let calls = 0;
    const started = new Promise<void>((resolve) => { entered = resolve; }); const pending = new Promise<void>((resolve) => { release = resolve; });
    selected.registerProtocol({ name: "http", canHandle: () => true, execute: async () => {
      calls++; active++; entered(); await pending; active--; return { status: 200, headers: {}, bodyText: "", timeMs: 0 };
    } });
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    let running: Promise<number> | undefined;
    try {
      process.chdir(fixtureRoot); let settled = false;
      running = runCli(["run-workflow", `groups/${groupA}/projects/${projectId}/workflows/${id}`, "--runs-dir", out, "--reporters", "json"], selected, () => {}, { loadPlugins: false });
      running.then(() => { settled = true; }, () => { settled = true; });
      await started; process.emit("SIGINT"); await Promise.resolve();
      expect(settled).toBe(false); expect(active).toBe(1);
      release(); const code = await running;
      expect(active).toBe(0); expect(calls).toBe(1);
      const report = JSON.parse(readFileSync(join(out, readdirSync(out).find((file) => file.startsWith("workflow-"))!), "utf8")) as RunResult;
      expect(report.workflow?.verdict).toBe("aborted"); expect(code).toBe(1);
      expect(report.reportingMode).toBeUndefined(); expect(report.cases).toHaveLength(1);
      expect(report.cases[0]).toMatchObject({ passed: true }); expect(report.cases[0]!.failureKind).toBeUndefined();
      expect(report).toMatchObject({ total: 1, passed: 1, failed: 0 });
      expect(report.workflow?.entries).toMatchObject([{ entryId: "request", status: "failed", failureKind: "aborted" }]);
      expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
    } finally { release(); await running; process.exitCode = 0; process.chdir(previousCwd); rmSync(fixtureRoot, { recursive: true, force: true }); }
  });
  it("prepares the full workflow closure once and rejects a missing child reference before credentials", async () => {
    const fixtureWorkspace = workspace(); const project = fixtureWorkspace.groups[0]!.projects[0]!;
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.contract.request.path = "/b1-child";
    asset.contract.request.auth = { kind: "bearer", token: { id: "child-token", policy: "test-auto" } };
    const childId = "00000000-0000-4000-8000-000000000094"; const parentId = "00000000-0000-4000-8000-000000000095";
    const core = await import("@apicc/core");
    project.workflows = [{ id: childId, name: "child", status: "enabled", nodes: [{ id: "request", kind: "request", apiId: deepApiId, caseId }], edges: [] }, core.WorkflowSchema.parse({ id: parentId, name: "parent", status: "enabled", executionVersion: 2, nodes: [{ id: "loop", kind: "loop", workflowId: childId, count: 2, inputs: {}, outputs: {} }], edges: [] })];
    const fixtureRoot = mkdtempSync(join(tmpdir(), "apicc-b1-cli-"));
    const initial = await fileStorage.load(fixtureRoot); await fileStorage.save(fixtureRoot, fixtureWorkspace, { expectedRevision: initial.revision, deletions: [] });
    const previousCwd = process.cwd(); let resolves = 0;
    const store: SecretStore = { async put() {}, async resolve() { resolves++; return "synthetic-child-secret"; }, async version() { return "one"; }, async remove() {}, async status() { return "available"; } };
    try {
      process.chdir(fixtureRoot); observedRequests.length = 0;
      const args = ["run-workflow", `groups/${groupA}/projects/${projectId}/workflows/${parentId}`, "--runs-dir", join(fixtureRoot, ".apicc", "reports")];
      expect(await runCli(args, createDefaultRegistry(), () => {}, { loadPlugins: false, secretStore: store })).toBe(0);
      expect(observedRequests.map((item) => [item.url, item.authorization])).toEqual([["/b1-child", "Bearer synthetic-child-secret"], ["/b1-child", "Bearer synthetic-child-secret"]]);
      expect(resolves).toBe(1);
      const stored = await fileStorage.load(fixtureRoot);
      project.workflows[0]!.nodes = [{ id: "missing", kind: "request", apiId: deepApiId, caseId: "missing" }];
      await fileStorage.save(fixtureRoot, fixtureWorkspace, { expectedRevision: stored.revision, deletions: [] });
      observedRequests.length = 0;
      await expect(runCli(args, createDefaultRegistry(), () => {}, { loadPlugins: false, secretStore: store })).rejects.toThrow(/case-reference/);
      expect(resolves).toBe(1); expect(observedRequests).toEqual([]);
    } finally { process.exitCode = 0; process.chdir(previousCwd); rmSync(fixtureRoot, { recursive: true, force: true }); }
  });
  it("B2 test preview matches the core plan without reading credentials; run preserves suite rows and invocation-only overrides", async () => {
    const suiteId = "00000000-0000-4000-8000-000000000091";
    const datasetId = "00000000-0000-4000-8000-000000000090";
    const fixtureWorkspace = workspace(); const project = fixtureWorkspace.groups[0]!.projects[0]!;
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.contract.request.path = "/b2/{{value}}";
    asset.contract.request.auth = { kind: "bearer", token: { id: "suite-secret", policy: "test-auto" } };
    asset.cases.push({ ...asset.cases[0]!, scope: "dev", assertions: [{ id: "fail-status", target: "status", op: "eq", expected: "201" }] });
    project.datasets = [{ formatVersion: 1, id: datasetId, name: "suite data", columns: ["value"], rows: [{ value: "a" }, { value: "b" }] }];
    project.suites = [{ formatVersion: 1, id: suiteId, name: "CLI suite", tags: [], failFast: false, reporters: ["json"], datasetId,
      selection: { kind: "explicit", entries: [{ id: "00000000-0000-4000-8000-000000000092", kind: "case", collectionId, folderIds: [outerFolderId, innerFolderId], apiId: deepApiId, caseId }] } }];
    const fixtureRoot = mkdtempSync(join(tmpdir(), "apicc-b2-cli-"));
    const initial = await fileStorage.load(fixtureRoot); await fileStorage.save(fixtureRoot, fixtureWorkspace, { expectedRevision: initial.revision, deletions: [] });
    const stored = await fileStorage.load(fixtureRoot); const previousCwd = process.cwd();
    let credentialReads = 0;
    const store: SecretStore = { async put() {}, async resolve() { credentialReads++; return "synthetic-suite-secret"; }, async version() { credentialReads++; return "one"; }, async remove() {}, async status() { credentialReads++; return "available"; } };
    try {
      process.chdir(fixtureRoot); observedRequests.length = 0;
      const lines: string[] = []; const projectPath = `groups/${groupA}/projects/${projectId}`;
      const code = await runCli(["test", "preview", suiteId, "--project", projectPath, "--fail-fast"], createDefaultRegistry(), (line) => lines.push(line), { loadPlugins: false, secretStore: store });
      expect(code).toBe(0); expect(credentialReads).toBe(0); expect(observedRequests).toEqual([]);
      const core = await import("@apicc/core"); const snapshot = createProjectSnapshot(stored.workspace.groups[0]!.projects[0]!);
      const plan = core.resolveSuitePlan(snapshot, suiteId, { failFast: true });
      const data = await core.prepareTestData(snapshot, plan.selections, { workspaceRoot: fixtureRoot });
      expect(JSON.parse(lines[0]!)).toEqual(core.validateSuiteData(plan, data));
      const list: string[] = [];
      expect(await runCli(["test", "list", "--project", projectPath], createDefaultRegistry(), (line) => list.push(line), { loadPlugins: false, secretStore: store })).toBe(0);
      expect(JSON.parse(list[0]!).map((suite: { id: string }) => suite.id)).toEqual([suiteId]);
      const runsDir = join(fixtureRoot, ".apicc", "reports");
      expect(await runCli(["test", "run", suiteId, "--project", projectPath, "--reporters", "json", "--runs-dir", runsDir], createDefaultRegistry(), () => {}, { loadPlugins: false, secretStore: store })).toBe(0);
      expect(observedRequests.map((r) => r.url)).toEqual(["/b2/a", "/b2/b"]);
      expect(credentialReads).toBeGreaterThan(0);
      expect((await fileStorage.load(fixtureRoot)).revision).toBe(stored.revision);
      const output = readdirSync(runsDir).filter((file) => file.endsWith(".json")).map((file) => JSON.parse(readFileSync(join(runsDir, file), "utf8")));
      expect(output.some((result) => result.suite?.total === 2 && result.total === 2)).toBe(true);
      expect(JSON.stringify(output)).not.toContain("synthetic-suite-secret");
      observedRequests.length = 0; const readsBefore = credentialReads;
      expect(await runCli(["test", "run", suiteId, "--project", projectPath, "--dataset", "00000000-0000-4000-8000-000000000099"], createDefaultRegistry(), () => {}, { loadPlugins: false, secretStore: store })).toBe(1);
      expect(credentialReads).toBe(readsBefore); expect(observedRequests).toEqual([]);
      expect(await runCli(["test", "run", suiteId, "--project", projectPath, "--env", "dev", "--fail-fast", "--runs-dir", runsDir], createDefaultRegistry(), () => {}, { loadPlugins: false, secretStore: store })).toBe(1);
      expect(observedRequests.map((r) => r.url)).toEqual(["/b2/a"]);
      expect((await fileStorage.load(fixtureRoot)).revision).toBe(stored.revision);
    } finally { process.exitCode = 0; process.chdir(previousCwd); rmSync(fixtureRoot, { recursive: true, force: true }); }
  });

  it("preserves safe partial and reauthorization OAuth results in CLI failures", () => {
    const partial = formatOAuthActionFailure("acquire", {
      status: "partial_success",
      errorCode: "OAUTH_METADATA_SAVE_FAILED",
      expiresAt: 1_800_000_123_000,
    });
    const reauthorization = formatOAuthActionFailure("refresh", {
      status: "reauthorization_required",
      errorCode: "OAUTH_METADATA_SAVE_FAILED",
      expiresAt: 1_800_000_456_000,
    });

    expect(partial).toContain('"status":"partial_success"');
    expect(partial).toContain('"errorCode":"OAUTH_METADATA_SAVE_FAILED"');
    expect(partial).toContain('"expiresAt":1800000123000');
    expect(reauthorization).toContain('"status":"reauthorization_required"');
    expect(reauthorization).toContain("重新授权");
    expect(partial).not.toMatch(/access_token|refresh_token|synthetic-client-secret/i);
    expect(reauthorization).not.toMatch(/access_token|refresh_token|synthetic-client-secret/i);
  });

  it("routes a CLI collection run through the selected project/environment proxy profile", async () => {
    const proxyRequests: string[] = [];
    const tokenRequests: Array<{ method: string; body: string }> = [];
    const tokenServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      request.on("end", () => {
        tokenRequests.push({ method: request.method ?? "GET", body: Buffer.concat(chunks).toString("utf8") });
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ access_token: "synthetic-cli-oauth-access", token_type: "Bearer", expires_in: 3600 }));
      });
    });
    await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
    const tokenEndpoint = `http://127.0.0.1:${(tokenServer.address() as { port: number }).port}/token`;
    const oauthPrivateRoot = mkdtempSync(join(tmpdir(), "apicc-cli-oauth-private-"));
    const proxy = createServer((request, response) => {
      const target = new URL(request.url ?? "", baseUrl);
      proxyRequests.push(`${request.method ?? "GET"} ${target.href}`);
      const headers = { ...request.headers, host: target.host };
      delete headers["proxy-authorization"];
      const upstream = httpRequest(target, { method: request.method, headers }, (upstreamResponse) => {
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.pipe(response);
      });
      request.pipe(upstream);
      upstream.on("error", () => { response.writeHead(502); response.end(); });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const state = await fileStorage.load(root);
    const project = state.workspace.groups[0]!.projects[0]!;
    const dev = project.environments.find((environment) => environment.name === "dev")!;
    const host = await createNetworkProfileHost({
      workspaceRoot: root,
      project: { workspaceId: state.workspace.id, groupId: groupA, projectId },
      environmentId: dev.id,
      privateRoot: networkPrivateRoot,
      secretStore: { async put() {}, async resolve() { throw new Error("unexpected network secret"); }, async version() { return "unused"; }, async remove() {}, async status() { return "missing"; } },
    });
    const proxyPasswordRef = { id: "cli-network-proxy-password", policy: "test-auto" as const };
    const current = await host.store.load(host.scope);
    await host.store.save(host.scope, {
      formatVersion: 1,
      profiles: [{ id: "cli-proxy", name: "CLI proxy", kind: "proxy", proxyUrl, username: "proxy-user", passwordRef: proxyPasswordRef, targetTlsBindings: [] }],
      projectSelection: { kind: "direct" },
      environmentSelections: [{ environmentId: dev.id, selection: { kind: "profile", profileId: "cli-proxy" } }],
    }, current.revision);
    const previousCwd = process.cwd();
    observedRequests.length = 0;
    let proxyPasswordResolveCount = 0;
    const oauthClientSecretRef = { id: "cli-explicit-acquire-client-secret", policy: "test-auto" as const };
    const secretStore: SecretStore = {
      async put() {},
      async resolve(_scope, ref) {
        if (ref.id === proxyPasswordRef.id) proxyPasswordResolveCount += 1;
        if (ref.id === oauthClientSecretRef.id) return "synthetic-cli-client-secret";
        return "synthetic-cli-proxy-secret";
      },
      async version() { return "cli-proxy-generation-1"; },
      async remove() {},
      async status() { return "available"; },
    };
    try {
      const oauthHost = await createOAuthProfileHost({
        workspaceRoot: root,
        project: { workspaceId: state.workspace.id, groupId: groupA, projectId },
        environmentId: dev.id,
        privateRoot: oauthPrivateRoot,
        secretStore,
      });
      const profileId = "cli-explicit-acquire-proxy-profile";
      expect(await oauthHost.saveProfile({
        profileId,
        environmentId: dev.id,
        flow: "client_credentials",
        tokenEndpoint,
        clientId: "synthetic-cli-client",
        clientAuthentication: "client_secret_post",
        bearerRef: { id: "cli-explicit-acquire-bearer", policy: "test-auto" },
        clientSecretRef: oauthClientSecretRef,
      }, { clientSecret: "synthetic-cli-client-secret" })).toEqual({ status: "success" });
      process.chdir(root);
      const code = await runCli([
        "run", `groups/${groupA}/projects/${projectId}/collections/${collectionId}`,
        "--env", "dev", "--runs-dir", join(root, ".apicc", "cli-proxy-run"),
      ], createDefaultRegistry(), () => {}, {
        loadPlugins: false,
        secretStore,
        credentialPrivateRoot: networkPrivateRoot,
        networkPrivateRoot,
      });
      expect(code).toBe(0);
      const acquireCode = await runCli([
        "oauth", "acquire", `groups/${groupA}/projects/${projectId}`, profileId, "--env", dev.id,
      ], createDefaultRegistry(), () => {}, {
        loadPlugins: false,
        secretStore,
        credentialPrivateRoot: networkPrivateRoot,
        networkPrivateRoot,
        oauthPrivateRoot,
      });
      expect(acquireCode).toBe(0);
      expect(proxyPasswordResolveCount).toBe(2);
      expect(proxyRequests).toEqual([
        `GET ${baseUrl}/preserved/preserved`,
        `POST ${tokenEndpoint}`,
      ]);
      expect(tokenRequests).toEqual([{
        method: "POST",
        body: "grant_type=client_credentials&client_id=synthetic-cli-client&client_secret=synthetic-cli-client-secret",
      }]);
      expect(observedRequests.map((request) => request.url)).toEqual(["/preserved/preserved"]);
    } finally {
      process.chdir(previousCwd);
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await new Promise<void>((resolve) => tokenServer.close(() => resolve()));
      rmSync(oauthPrivateRoot, { recursive: true, force: true });
    }
  });

  it("runs the child version and then an ancestor-only version through fileStorage and runCli", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "apicc-effective-case-cli-"));
    const fixtureWorkspace = workspace();
    const project = fixtureWorkspace.groups[0]!.projects[0]!;
    project.environments = [
      { id: "00000000-0000-4000-8000-000000000051", name: "parent", variables: {}, baseUrls: { [collectionId]: baseUrl } },
      { id: "00000000-0000-4000-8000-000000000052", name: "child", extends: "parent", variables: {}, baseUrls: {} },
    ];
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.contract.request.path = "/{{caseValue}}";
    const childRequestOverride = structuredClone(asset.contract.request);
    childRequestOverride.method = "POST";
    childRequestOverride.path = "/child-override/{{caseValue}}";
    childRequestOverride.auth = { kind: "bearer", token: { id: "effective-case-token", policy: "test-auto" } };
    childRequestOverride.body = { kind: "binary", file: { path: ".apicc/fixture.bin" }, contentType: "application/octet-stream" };
    asset.cases = [
      { id: caseId, name: "base-version", scope: "base", parameters: { caseValue: "base-parameter" }, preOperations: [], postOperations: [], assertions: [] },
      { id: caseId, name: "parent-version", scope: "parent", parameters: { caseValue: "parent-parameter" }, preOperations: [], postOperations: [], assertions: [] },
      {
        id: caseId, name: "child-version", scope: "child", parameters: { caseValue: "child-parameter" },
        requestOverride: childRequestOverride,
        requestSettingsOverride: { headersTimeoutMs: 500 },
        preOperations: [], postOperations: [], assertions: [],
      },
    ];
    const loginCaseId = "cli-login-case";
    const loginApiId = "00000000-0000-4000-8000-000000000092";
    const loginApi = api(loginApiId, "login", "fixture run cookie", [{
      id: loginCaseId, name: "login", scope: "base", parameters: {}, preOperations: [], postOperations: [], assertions: [],
    }], "/cli-login");
    loginApi.contract.request.baseUrl = baseUrl;
    const settingsCaseId = "cli-settings-case";
    const settingsApiId = "00000000-0000-4000-8000-000000000093";
    const settingsApi = api(settingsApiId, "settings", "fixture selected timeout", [{
      id: settingsCaseId, name: "selected timeout", scope: "base", parameters: {}, preOperations: [], postOperations: [], assertions: [],
    }], "/default-settings");
    settingsApi.contract.request.baseUrl = baseUrl;
    const settingsOverride = structuredClone(settingsApi.contract.request);
    settingsOverride.path = "/cli-settings";
    settingsOverride.auth = { kind: "bearer", token: { id: "effective-case-token", policy: "test-auto" } };
    settingsOverride.body = { kind: "binary", file: { path: ".apicc/fixture.bin" }, contentType: "application/octet-stream" };
    settingsApi.cases[0]!.requestOverride = settingsOverride;
    settingsApi.cases[0]!.requestSettingsOverride = { headersTimeoutMs: 80 };
    project.collections[0]!.apis = [loginApi, settingsApi];
    project.workflows = [{
      id: "00000000-0000-4000-8000-000000000091",
      name: "consume-effective-case",
      status: "enabled",
      nodes: [
        { id: "login-node", kind: "request", apiId: loginApiId, caseId: loginCaseId },
        { id: "effective-case-node", kind: "request", apiId: deepApiId, caseId },
        { id: "settings-node", kind: "request", apiId: settingsApiId, caseId: settingsCaseId },
      ],
      edges: [
        { id: "login-to-upload", from: "login-node", to: "effective-case-node" },
        { id: "upload-to-settings", from: "effective-case-node", to: "settings-node" },
      ],
    }];
    const initial = await fileStorage.load(fixtureRoot);
    await fileStorage.save(fixtureRoot, fixtureWorkspace, { expectedRevision: initial.revision, deletions: [] });
    mkdirSync(join(fixtureRoot, ".apicc"), { recursive: true });
    const payload = "synthetic-cli-binary-payload";
    writeFileSync(join(fixtureRoot, ".apicc", "fixture.bin"), payload);
    const runsDir = join(fixtureRoot, ".apicc", "runs");
    const collectionPath = `groups/${groupA}/projects/${projectId}/collections/${collectionId}`;
    const workflowPath = `groups/${groupA}/projects/${projectId}/workflows/00000000-0000-4000-8000-000000000091`;
    const secretStore: SecretStore = {
      async put() {},
      async resolve(_scope, ref) { expect(ref.id).toBe("effective-case-token"); return "synthetic-effective-case-token"; },
      async version() { return "effective-case-token-v1"; },
      async remove() {},
      async status() { return "available"; },
    };
    const previousCwd = process.cwd();
    let ancestorRoot: string | undefined;
    observedRequests.length = 0;
    try {
      process.chdir(fixtureRoot);
      const collectionCode = await runCli([
        "run", collectionPath, "--env", "child", "--runs-dir", runsDir,
      ], createDefaultRegistry(), () => {}, { loadPlugins: false, secretStore });
      expect(collectionCode).toBe(1);
      const runFiles = readdirSync(runsDir).filter((file) => file.startsWith("run-") && file.endsWith(".json"));
      expect(runFiles).toHaveLength(1);
      const runReport = JSON.parse(readFileSync(join(runsDir, runFiles[0]!), "utf8")) as { cases: Array<{ apiId: string; caseName: string; passed: boolean }> };
      expect(runReport.cases.some((outcome) => outcome.caseName === "child-version" && outcome.passed)).toBe(true);
      expect(runReport.cases.find((outcome) => outcome.apiId === settingsApiId)?.passed).toBe(false);
      expect(observedRequests.map((request) => request.url)).toContain("/cli-settings");
      expect(observedRequests.map((request) => request.url)).not.toContain("/default-settings");
      expect(observedRequests.find((request) => request.url === "/cli-settings")).toMatchObject({
        authorization: "Bearer synthetic-effective-case-token", body: payload,
      });
      expect(observedRequests.find((request) => request.url === "/child-override/child-parameter")).toMatchObject({
        authorization: "Bearer synthetic-effective-case-token", cookie: "cli-run=ready", body: payload,
      });

      observedRequests.length = 0;
      const workflowCode = await runCli([
        "run-workflow", workflowPath, "--env", "child", "--runs-dir", runsDir,
      ], createDefaultRegistry(), () => {}, { loadPlugins: false, secretStore });
      expect(workflowCode).toBe(1);
      const workflowFile = readdirSync(runsDir).find((file) => file.startsWith("workflow-") && file.endsWith(".json"));
      if (!workflowFile) throw new Error("workflow consumer report was not written");
      const workflowReport = JSON.parse(readFileSync(join(runsDir, workflowFile), "utf8")) as RunResult;
      expect(workflowReport.workflow!.entries.find(entry => entry.entryId === "settings-node")?.state).toBe("failed");
      expect(workflowReport.cases.filter(item => item.nodeId === "settings-node").some(item => !item.passed)).toBe(true);
      expect(observedRequests.map((request) => request.url)).toContain("/cli-settings");
      expect(observedRequests.map((request) => request.url)).not.toContain("/default-settings");
      expect(observedRequests.find((request) => request.url === "/cli-settings")).toMatchObject({
        authorization: "Bearer synthetic-effective-case-token", body: payload,
      });
      expect(observedRequests.find((request) => request.url === "/child-override/child-parameter")).toMatchObject({
        authorization: "Bearer synthetic-effective-case-token", cookie: "cli-run=ready", body: payload,
      });

      observedRequests.length = 0;
      const stressCode = await runCli([
        "run-stress", deepApiPath, "--case", caseId, "--env", "child", "--concurrency", "1", "--iterations", "2",
        "--runs-dir", runsDir,
      ], createDefaultRegistry(), () => {}, { loadPlugins: false, secretStore });
      expect(stressCode).toBe(0);
      const stressUploads = observedRequests.filter((request) => request.url === "/child-override/child-parameter");
      expect(stressUploads).toHaveLength(2);
      expect(stressUploads[0]).toMatchObject({ authorization: "Bearer synthetic-effective-case-token", body: payload });
      expect(stressUploads[0]?.cookie).toBeUndefined();
      expect(stressUploads[1]?.cookie).toContain("cli-vu=ready");

      observedRequests.length = 0;
      const settingsApiPath = `groups/${groupA}/projects/${projectId}/collections/${collectionId}/apis/${settingsApiId}`;
      const settingsStressCode = await runCli([
        "run-stress", settingsApiPath, "--case", settingsCaseId, "--env", "child", "--concurrency", "1", "--iterations", "1",
        "--runs-dir", runsDir,
      ], createDefaultRegistry(), () => {}, { loadPlugins: false, secretStore });
      const settingsStressFile = readdirSync(runsDir).find((file) => file.startsWith(`stress-${settingsApiId}-`) && file.endsWith(".json"));
      if (!settingsStressFile) throw new Error("single-iteration settings stress report was not written");
      const settingsStressReport = JSON.parse(readFileSync(join(runsDir, settingsStressFile), "utf8")) as { totalRequests: number; failed: number };
      expect(settingsStressCode).toBe(1);
      expect(observedRequests.map((request) => request.url)).toContain("/cli-settings");
      expect(observedRequests.find((request) => request.url === "/cli-settings")).toMatchObject({
        authorization: "Bearer synthetic-effective-case-token", body: payload,
      });
      expect(settingsStressReport).toMatchObject({ totalRequests: 1, failed: 1 });

      ancestorRoot = mkdtempSync(join(tmpdir(), "apicc-effective-case-ancestor-cli-"));
      const ancestorWorkspace = workspace();
      const ancestorProject = ancestorWorkspace.groups[0]!.projects[0]!;
      ancestorProject.environments = [
        { id: "00000000-0000-4000-8000-000000000071", name: "parent", variables: {}, baseUrls: { [collectionId]: baseUrl } },
        { id: "00000000-0000-4000-8000-000000000072", name: "child", extends: "parent", variables: {}, baseUrls: {} },
      ];
      const ancestorAsset = ancestorProject.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
      ancestorAsset.contract.request.path = "/{{caseValue}}";
      ancestorAsset.cases = [
        { id: caseId, name: "parent-ancestor-only", scope: "parent", parameters: { caseValue: "parent-ancestor-parameter" }, preOperations: [], postOperations: [], assertions: [] },
      ];
      const ancestorInitial = await fileStorage.load(ancestorRoot);
      await fileStorage.save(ancestorRoot, ancestorWorkspace, { expectedRevision: ancestorInitial.revision, deletions: [] });
      const ancestorRunsDir = join(ancestorRoot, ".apicc", "runs");
      observedRequests.length = 0;
      process.chdir(ancestorRoot);
      const ancestorCode = await runCli([
        "run", collectionPath, "--env", "child", "--runs-dir", ancestorRunsDir,
      ], createDefaultRegistry(), () => {}, { loadPlugins: false });
      expect(ancestorCode).toBe(0);
      expect(observedRequests.map((request) => request.url)).toEqual(["/parent-ancestor-parameter"]);
      const ancestorRunFiles = readdirSync(ancestorRunsDir).filter((file) => file.startsWith("run-") && file.endsWith(".json"));
      const ancestorRunReports = ancestorRunFiles.map((file) =>
        JSON.parse(readFileSync(join(ancestorRunsDir, file), "utf8")) as { cases: Array<{ caseName: string }> },
      );
      expect(ancestorRunReports.some((report) => report.cases.map((outcome) => outcome.caseName).includes("parent-ancestor-only"))).toBe(true);
    } finally {
      process.chdir(previousCwd);
      observedRequests.length = 0;
      if (ancestorRoot) rmSync(ancestorRoot, { recursive: true, force: true });
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("runs a stored request override through the real CLI subprocess without changing the contract default", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "apicc-debug-case-cli-"));
    const fixtureWorkspace = workspace();
    const fixtureProject = fixtureWorkspace.groups[0]!.projects[0]!;
    const asset = fixtureProject.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.contract.request.path = "/default";
    const requestOverride = structuredClone(asset.contract.request);
    requestOverride.path = "/override";
    asset.cases = [{
      id: caseId,
      name: "stored-override",
      scope: "base",
      parameters: {},
      requestOverride,
      requestSettingsOverride: { headersTimeoutMs: 500 },
      preOperations: [],
      postOperations: [],
      assertions: [],
    }];
    const initial = await fileStorage.load(fixtureRoot);
    await fileStorage.save(fixtureRoot, fixtureWorkspace, { expectedRevision: initial.revision, deletions: [] });
    const previousRequests = observedRequests.splice(0);
    const entry = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
    const privateHome = mkdtempSync(join(tmpdir(), "apicc-cli-private-home-"));
    const appData = process.platform === "darwin"
      ? join(privateHome, "Library", "Application Support")
      : join(privateHome, "app-data");
    const childEnv = {
      ...process.env,
      APPDATA: appData,
      LOCALAPPDATA: appData,
      XDG_CONFIG_HOME: appData,
      HOME: privateHome,
      USERPROFILE: privateHome,
    };
    try {
      const child = spawnOwnedCliProcess({
        command: process.execPath,
        args: [
        entry,
        "--no-plugins",
        "debug",
        deepApiPath,
        "--root",
        fixtureRoot,
        "--case",
        caseId,
        "--scope",
        "base",
        ],
        cwd: tmpdir(),
        env: childEnv,
      });
      const childResult = await child.result;
      expect(childResult.termination).toBe("exit");
      expect(childResult.exitCode, childResult.stderr || childResult.stdout).toBe(0);
      expect(childResult.stderr).toBe("");
      const result = JSON.parse(childResult.stdout) as {
        run: { failed: number; passed: number };
        exchanges: Array<{ request?: { url?: string }; settings: { headersTimeoutMs: number } }>;
      };
      expect(result.run).toMatchObject({ passed: 1, failed: 0 });
      expect(result.exchanges[0]?.request?.url).toBe(`${baseUrl}/override`);
      expect(result.exchanges[0]?.settings.headersTimeoutMs).toBe(500);
      expect(observedRequests.map((request) => request.url)).toEqual(["/override"]);
      const recordsDirectory = join(appData, "apicc", "debug-history", "records");
      const historyRecordCount = (): number => !existsSync(recordsDirectory) ? 0 : readdirSync(recordsDirectory)
        .reduce((total, owner) => total + readdirSync(join(recordsDirectory, owner)).filter((file) => file.endsWith(".json")).length, 0);
      expect(historyRecordCount()).toBe(1);

      const reloaded = await fileStorage.load(fixtureRoot);
      const reloadedApi = reloaded.workspace.groups[0]!.projects[0]!.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
      expect(reloadedApi.contract.request.path).toBe("/default");

      mkdirSync(join(fixtureRoot, ".apicc"), { recursive: true });
      const requestFile = join(fixtureRoot, ".apicc", "debug-request.json");
      const request = structuredClone(reloadedApi.contract.request);
      request.path = "/request-file";
      writeFileSync(requestFile, JSON.stringify(request), "utf8");
      observedRequests.length = 0;
      const requestChild = spawnOwnedCliProcess({
        command: process.execPath,
        args: [
          entry,
          "--no-plugins",
          "debug",
          deepApiPath,
          "--root",
          fixtureRoot,
          "--request",
          ".apicc/debug-request.json",
          "--settings",
          JSON.stringify({ headersTimeoutMs: 500 }),
          "--no-history",
        ],
        cwd: tmpdir(),
        env: childEnv,
      });
      const requestResult = await requestChild.result;
      expect(requestResult.termination).toBe("exit");
      expect(requestResult.exitCode, requestResult.stderr || requestResult.stdout).toBe(0);
      expect(requestResult.stderr).toBe("");
      const requestDebug = JSON.parse(requestResult.stdout) as {
        run: { failed: number; passed: number };
        exchanges: Array<{ request?: { url?: string }; settings: { headersTimeoutMs: number } }>;
      };
      expect(requestDebug.run).toMatchObject({ passed: 1, failed: 0 });
      expect(requestDebug.exchanges[0]?.request?.url).toBe(`${baseUrl}/request-file`);
      expect(requestDebug.exchanges[0]?.settings.headersTimeoutMs).toBe(500);
      expect(observedRequests.map((request) => request.url)).toEqual(["/request-file"]);
      expect(historyRecordCount()).toBe(1);
    } finally {
      observedRequests.splice(0);
      observedRequests.push(...previousRequests);
      rmSync(privateHome, { recursive: true, force: true });
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("manages an override-only credential ref without binding an unselected case", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "apicc-override-management-cli-"));
    const fixtureWorkspace = workspace();
    const fixtureProject = fixtureWorkspace.groups[0]!.projects[0]!;
    const asset = fixtureProject.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.contract.request.path = "/default-management";
    asset.contract.request.auth = { kind: "none" };
    const override = structuredClone(asset.contract.request);
    override.path = "/inactive-override";
    override.auth = { kind: "bearer", token: { id: "management-override-only-ref", policy: "test-auto" } };
    asset.cases = [
      { id: caseId, name: "base selected", scope: "base", parameters: {}, preOperations: [], postOperations: [], assertions: [] },
      { id: caseId, name: "inactive override", scope: "inactive", parameters: {}, requestOverride: override, preOperations: [], postOperations: [], assertions: [] },
    ];
    const initial = await fileStorage.load(fixtureRoot);
    await fileStorage.save(fixtureRoot, fixtureWorkspace, { expectedRevision: initial.revision, deletions: [] });
    const projectPath = `groups/${groupA}/projects/${projectId}`;
    const collectionPath = `groups/${groupA}/projects/${projectId}/collections/${collectionId}`;
    const values = new Map<string, string>();
    const calls: string[] = [];
    const secretStore: SecretStore = {
      async put(_scope, ref, value) { calls.push(`put:${ref.id}`); values.set(ref.id, value); },
      async resolve(_scope, ref) { calls.push(`resolve:${ref.id}`); return values.get(ref.id) ?? null; },
      async version(_scope, ref) { calls.push(`version:${ref.id}`); return values.has(ref.id) ? "v1" : "missing"; },
      async remove(_scope, ref) { calls.push(`remove:${ref.id}`); values.delete(ref.id); },
      async status(_scope, ref) { calls.push(`status:${ref.id}`); return values.has(ref.id) ? "available" : "missing"; },
    };
    const previousCwd = process.cwd();
    try {
      process.chdir(fixtureRoot);
      const saved = await runCli(["credentials", "save", projectPath, "management-override-only-ref"], createDefaultRegistry(), () => {}, {
        loadPlugins: false, secretStore, secretInput: async () => "synthetic-override-management-secret",
      });
      const status = await runCli(["credentials", "status", projectPath, "management-override-only-ref"], createDefaultRegistry(), () => {}, {
        loadPlugins: false, secretStore,
      });
      expect(saved).toBe(0);
      expect(status).toBe(0);
      expect(calls).toEqual(["put:management-override-only-ref", "status:management-override-only-ref"]);

      calls.length = 0;
      observedRequests.length = 0;
      const runCode = await runCli(["run", collectionPath, "--env", "dev", "--runs-dir", join(fixtureRoot, ".apicc", "runs")], createDefaultRegistry(), () => {}, {
        loadPlugins: false, secretStore,
      });
      expect(runCode).toBe(0);
      expect(calls).toEqual([]);
      expect(observedRequests.map((request) => request.url)).toEqual(["/default-management"]);
      expect(observedRequests[0]?.authorization).toBe("");
    } finally {
      process.chdir(previousCwd);
      observedRequests.length = 0;
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("returns and records a failed debug terminal result when selected credentials are missing", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "apicc-debug-preparation-failure-"));
    const fixtureWorkspace = workspace();
    const fixtureProject = fixtureWorkspace.groups[0]!.projects[0]!;
    const asset = fixtureProject.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.contract.request.path = "/default-unbound";
    asset.contract.request.auth = { kind: "none" };
    const override = structuredClone(asset.contract.request);
    override.path = "/must-not-send-missing-credential";
    override.auth = { kind: "bearer", token: { id: "selected-but-missing-ref", policy: "test-auto" } };
    asset.cases = [{ id: caseId, name: "selected override", scope: "base", parameters: {}, requestOverride: override, preOperations: [], postOperations: [], assertions: [] }];
    const initial = await fileStorage.load(fixtureRoot);
    await fileStorage.save(fixtureRoot, fixtureWorkspace, { expectedRevision: initial.revision, deletions: [] });
    const logs: string[] = [];
    const appData = join(fixtureRoot, ".apicc", "app-data");
    const secretStore: SecretStore = {
      async put() {},
      async resolve(_scope, ref) { throw new CredentialError("CREDENTIAL_MISSING", ref.id); },
      async version(_scope, ref) { throw new CredentialError("CREDENTIAL_MISSING", ref.id); },
      async remove() {},
      async status() { return "missing"; },
    };
    const previousCwd = process.cwd();
    const previousExitCode = process.exitCode;
    try {
      process.chdir(fixtureRoot);
      observedRequests.length = 0;
      let thrown: unknown;
      let code: number | undefined;
      try {
        code = await runCli(["debug", deepApiPath, "--case", caseId, "--scope", "base"], createDefaultRegistry(), (line) => logs.push(line), {
          loadPlugins: false, secretStore, debugHistoryAppDataDirectory: appData,
        });
      } catch (error) { thrown = error; }
      expect(thrown).toBeUndefined();
      expect(code).toBe(1);
      expect(logs).toHaveLength(1);
      const result = JSON.parse(logs[0]!) as { failureKind?: string; run: { total: number; failed: number } };
      expect(result).toMatchObject({ failureKind: "config", run: { total: 0, failed: 0 } });
      expect(JSON.stringify(result)).not.toContain("selected-but-missing-ref");
      expect(observedRequests).toEqual([]);
      const recordsDirectory = join(appData, "apicc", "debug-history", "records");
      const records = !existsSync(recordsDirectory) ? [] : readdirSync(recordsDirectory)
        .flatMap((owner) => readdirSync(join(recordsDirectory, owner)).filter((file) => file.endsWith(".json")));
      expect(records).toHaveLength(1);
    } finally {
      process.chdir(previousCwd);
      process.exitCode = previousExitCode;
      observedRequests.length = 0;
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("returns an aborted debug terminal result when cancellation wins during credential preparation", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "apicc-debug-preparation-abort-"));
    const fixtureWorkspace = workspace();
    const fixtureProject = fixtureWorkspace.groups[0]!.projects[0]!;
    const asset = fixtureProject.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.contract.request.path = "/default-abort";
    asset.contract.request.auth = { kind: "none" };
    const override = structuredClone(asset.contract.request);
    override.path = "/must-not-send-aborted-preparation";
    override.auth = { kind: "bearer", token: { id: "selected-abort-ref", policy: "test-auto" } };
    asset.cases = [{ id: caseId, name: "selected override", scope: "base", parameters: {}, requestOverride: override, preOperations: [], postOperations: [], assertions: [] }];
    const initial = await fileStorage.load(fixtureRoot);
    await fileStorage.save(fixtureRoot, fixtureWorkspace, { expectedRevision: initial.revision, deletions: [] });
    const logs: string[] = [];
    const appData = join(fixtureRoot, ".apicc", "app-data");
    let markPreparationStarted: () => void = () => {};
    const preparationStarted = new Promise<void>((resolve) => { markPreparationStarted = resolve; });
    let finishVersion: ((version: string) => void) | undefined;
    let firstVersion = true;
    const secretStore: SecretStore = {
      async put() {},
      async resolve() { return "synthetic-aborted-secret"; },
      async version() {
        if (firstVersion) {
          firstVersion = false;
          markPreparationStarted();
          return new Promise<string>((resolve) => { finishVersion = resolve; });
        }
        return "synthetic-version";
      },
      async remove() {},
      async status() { return "available"; },
    };
    const previousCwd = process.cwd();
    const previousExitCode = process.exitCode;
    try {
      process.chdir(fixtureRoot);
      observedRequests.length = 0;
      const pending = runCli(["debug", deepApiPath, "--case", caseId, "--scope", "base"], createDefaultRegistry(), (line) => logs.push(line), {
        loadPlugins: false, secretStore, debugHistoryAppDataDirectory: appData,
      });
      await preparationStarted;
      process.emit("SIGINT");
      if (!finishVersion) throw new Error("credential preparation did not block in version lookup");
      finishVersion("synthetic-version");
      const code = await pending;
      expect(code).toBe(1);
      expect(logs).toHaveLength(1);
      const result = JSON.parse(logs[0]!) as { failureKind?: string; run: { total: number } };
      expect(result).toMatchObject({ failureKind: "aborted", run: { total: 0 } });
      expect(observedRequests).toEqual([]);
      const recordsDirectory = join(appData, "apicc", "debug-history", "records");
      const records = !existsSync(recordsDirectory) ? [] : readdirSync(recordsDirectory)
        .flatMap((owner) => readdirSync(join(recordsDirectory, owner)).filter((file) => file.endsWith(".json")));
      expect(records).toHaveLength(1);
    } finally {
      process.chdir(previousCwd);
      process.exitCode = previousExitCode;
      observedRequests.length = 0;
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("debug-history config reads and updates the shared host preferences using an injected app-data root", async () => {
    const appData = mkdtempSync(join(tmpdir(), "apicc-debug-history-cli-"));
    const logs: string[] = [];
    try {
      const initialCode = await runCli(["debug-history", "config"], createDefaultRegistry(), (line) => logs.push(line), {
        loadPlugins: false,
        debugHistoryAppDataDirectory: appData,
      });
      expect(initialCode).toBe(0);
      expect(JSON.parse(logs.pop()!)).toMatchObject({
        preferences: { enabled: true, retentionDays: 30, maxRecords: 1000 },
        diagnostics: [],
      });

      const updateCode = await runCli([
        "debug-history", "config", "--enabled", "false", "--days", "7", "--max-records", "50",
      ], createDefaultRegistry(), (line) => logs.push(line), {
        loadPlugins: false,
        debugHistoryAppDataDirectory: appData,
      });
      expect(updateCode).toBe(0);
      expect(JSON.parse(logs.pop()!)).toMatchObject({
        preferences: { enabled: false, retentionDays: 7, maxRecords: 50 },
        diagnostics: [],
      });
    } finally {
      rmSync(appData, { recursive: true, force: true });
    }
  });

  it.each(["api", "collection", "environment"] as const)(
    "keeps the prepared snapshot locator when the active %s identity changes during credential preparation",
    async (identity) => {
      const fixtureRoot = mkdtempSync(join(tmpdir(), "apicc-snapshot-identity-"));
      const fixtureWorkspace = workspace();
      const project = fixtureWorkspace.groups[0]!.projects[0]!;
      const parentEnvironmentId = "00000000-0000-4000-8000-000000000061";
      const childEnvironmentId = "00000000-0000-4000-8000-000000000062";
      const targetRequests = {
        parent: [] as Array<{ path: string; selectedCase: string | undefined }>,
        child: [] as Array<{ path: string; selectedCase: string | undefined }>,
      };
      const parentServer = createServer((request, response) => {
        targetRequests.parent.push({ path: request.url ?? "", selectedCase: request.headers["x-selected-case"] as string | undefined });
        response.statusCode = 200;
        response.end("{}");
      });
      const childServer = createServer((request, response) => {
        targetRequests.child.push({ path: request.url ?? "", selectedCase: request.headers["x-selected-case"] as string | undefined });
        response.statusCode = 200;
        response.end("{}");
      });
      await Promise.all([
        new Promise<void>((resolve) => parentServer.listen(0, "127.0.0.1", resolve)),
        new Promise<void>((resolve) => childServer.listen(0, "127.0.0.1", resolve)),
      ]);
      const parentUrl = `http://127.0.0.1:${(parentServer.address() as { port: number }).port}`;
      const childUrl = `http://127.0.0.1:${(childServer.address() as { port: number }).port}`;
      project.environments = [
        { id: parentEnvironmentId, name: "parent", variables: {}, baseUrls: { [collectionId]: parentUrl } },
        { id: childEnvironmentId, name: "child", extends: "parent", variables: {}, baseUrls: { [collectionId]: childUrl } },
      ];
      project.stressPolicy = { trustedOrigins: [parentUrl, childUrl], deniedOrigins: [] };
      const selectedApi = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
      selectedApi.contract.request.auth = { kind: "bearer", token: { id: "identity-window-secret", policy: "test-auto" } };
      selectedApi.contract.request.baseUrl = "";
      selectedApi.contract.request.path = "/{{caseValue}}";
      selectedApi.cases = [
        { id: caseId, name: "parent-version", scope: "parent", parameters: { caseValue: "parent-parameter" }, preOperations: [{ id: "parent-marker", type: "script", content: 'pm.request.headers["X-Selected-Case"] = "parent-version";' }], postOperations: [], assertions: [] },
        { id: caseId, name: "child-version", scope: "child", parameters: { caseValue: "child-parameter" }, preOperations: [{ id: "child-marker", type: "script", content: 'pm.request.headers["X-Selected-Case"] = "child-version";' }], postOperations: [], assertions: [] },
      ];
      const initial = await fileStorage.load(fixtureRoot);
      await fileStorage.save(fixtureRoot, fixtureWorkspace, { expectedRevision: initial.revision, deletions: [] });

      let activeWorkspace: Workspace | undefined;
      let mutationCount = 0;
      const registry = createDefaultRegistry();
      registry.registerStorage({
        async load(storageRoot) {
          const state = await fileStorage.load(storageRoot);
          activeWorkspace = state.workspace;
          return state;
        },
        save(storageRoot, storedWorkspace, options) {
          return fileStorage.save(storageRoot, storedWorkspace, options);
        },
      });
      const secretStore: SecretStore = {
        async put() {},
        async resolve() { return "synthetic-identity-window-secret"; },
        async version() {
          if (mutationCount++ === 0) {
            const activeProject = activeWorkspace!.groups[0]!.projects[0]!;
            if (identity === "api") activeProject.collections[0]!.folders[0]!.folders[0]!.apis[0]!.contract.id = "changed-active-api-id";
            if (identity === "collection") activeProject.collections[0]!.id = "changed-active-collection-id";
            if (identity === "environment") activeProject.environments.find((environment) => environment.name === "child")!.id = parentEnvironmentId;
          }
          return "identity-window-version";
        },
        async remove() {},
        async status() { return "available"; },
      };
      const previousCwd = process.cwd();
      try {
        process.chdir(fixtureRoot);
        const code = await runCli([
          "run-stress", deepApiPath, "--case", caseId, "--env", "child", "--concurrency", "1", "--iterations", "1",
          "--allow-target", parentUrl, "--allow-target", childUrl,
          "--runs-dir", join(fixtureRoot, ".apicc", "runs"),
        ], registry, () => {}, { secretStore, loadPlugins: false });

        expect(code).toBe(0);
        expect(mutationCount).toBeGreaterThan(0);
        expect(targetRequests.parent).toEqual([]);
        expect(targetRequests.child).toEqual([{ path: "/child-parameter", selectedCase: "child-version" }]);
      } finally {
        process.chdir(previousCwd);
        await Promise.all([
          new Promise<void>((resolve) => parentServer.close(() => resolve())),
          new Promise<void>((resolve) => childServer.close(() => resolve())),
        ]);
        rmSync(fixtureRoot, { recursive: true, force: true });
      }
    },
  );

  it("rejects non-applicable cases and an unknown environment before reading credentials or sending", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "apicc-effective-case-invalid-"));
    const fixtureWorkspace = workspace();
    const project = fixtureWorkspace.groups[0]!.projects[0]!;
    project.environments = [
      { id: "00000000-0000-4000-8000-000000000053", name: "parent", variables: {}, baseUrls: { [collectionId]: baseUrl } },
      { id: "00000000-0000-4000-8000-000000000054", name: "child", extends: "parent", variables: {}, baseUrls: {} },
    ];
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.contract.request.auth = { kind: "bearer", token: { id: "preflight-secret", policy: "test-auto" } };
    asset.cases = [
      { id: caseId, name: "base-applicable", scope: "base", parameters: {}, preOperations: [], postOperations: [], assertions: [] },
      { id: "not-applicable", name: "other-environment", scope: "other", parameters: {}, preOperations: [], postOperations: [], assertions: [] },
    ];
    const initial = await fileStorage.load(fixtureRoot);
    await fileStorage.save(fixtureRoot, fixtureWorkspace, { expectedRevision: initial.revision, deletions: [] });
    let secretStoreCalls = 0;
    const secretStore: SecretStore = {
      async put() { secretStoreCalls += 1; },
      async resolve() { secretStoreCalls += 1; return "synthetic-preflight-secret"; },
      async version() { secretStoreCalls += 1; return "synthetic-version"; },
      async remove() { secretStoreCalls += 1; },
      async status() { secretStoreCalls += 1; return "available"; },
    };
    const previousCwd = process.cwd();
    observedRequests.length = 0;
    try {
      process.chdir(fixtureRoot);
      await expect(runCli([
        "run-stress", deepApiPath, "--case", "not-applicable", "--env", "child", "--concurrency", "1", "--iterations", "1",
        "--runs-dir", join(fixtureRoot, ".apicc", "runs"),
      ], createDefaultRegistry(), () => {}, { secretStore, loadPlugins: false }))
        .rejects.toThrow("不适用于当前环境");
      expect(secretStoreCalls).toBe(0);
      expect(observedRequests).toEqual([]);

      await expect(runCli([
        "run-stress", deepApiPath, "--case", caseId, "--env", "missing", "--concurrency", "1", "--iterations", "1",
        "--runs-dir", join(fixtureRoot, ".apicc", "runs"),
      ], createDefaultRegistry(), () => {}, { secretStore, loadPlugins: false }))
        .rejects.toThrow("未找到环境: missing");
      expect(secretStoreCalls).toBe(0);
      expect(observedRequests).toEqual([]);
    } finally {
      process.chdir(previousCwd);
      observedRequests.length = 0;
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("export-design resolves a full UUID path through nested folders and the selected group", async () => {
    const previousCwd = process.cwd();
    const output: string[] = [];
    try {
      process.chdir(root);
      const code = await runCli(["export-design", deepApiPath.replaceAll("/", "\\")], createDefaultRegistry(), (line) => output.push(line), { loadPlugins: false });
      expect(code).toBe(0);
      expect(output.join("\n")).toContain("来自指定 group 的设计正文");
      expect(output.join("\n")).not.toContain("来自另一个 group 的设计正文");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("list-apis returns complete UUID paths including every folder ancestor", async () => {
    const client = await connectMcp();
    try {
      const result = await client.callTool({ name: "list-apis", arguments: {} });
      const rows = JSON.parse(resultText(result as never)) as Array<{ id: string; apiPath: string }>;
      expect(rows.find((row) => row.id === deepApiId)?.apiPath).toBe(deepApiPath);
    } finally {
      await client.close();
    }
  });

  it("run-case preserves operations from every ancestor folder in the full collection context", async () => {
    const client = await connectMcp(true);
    requestPath = "";
    try {
      const result = await client.callTool({ name: "run-case", arguments: { apiPath: deepApiPath, caseId } });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(resultText(result as never))).toMatchObject({ apiId: deepApiId, passed: true });
      expect(requestPath).toBe("/preserved/preserved");
    } finally {
      await client.close();
    }
  });

  it("redacts Basic Authorization and URL-encoded API-key query echoes from persisted run JSON and CLI output", async () => {
    const basicSecret = "basic secret /+";
    const querySecret = "query secret /+";
    const basicAuthorization = `Basic ${Buffer.from(`alice:${basicSecret}`).toString("base64")}`;
    const encodedQuerySecret = encodeURIComponent(querySecret);
    const values = new Map([
      ["__proto__", { value: "bearer worker secret", version: "version-own-proto" }],
      [basicRefId, { value: basicSecret, version: "version-basic" }],
      [queryRefId, { value: querySecret, version: "version-query" }],
    ]);
    const secretStore: SecretStore = {
      async put() {},
      async resolve(_scope, ref) { return values.get(ref.id)!.value; },
      async version(_scope, ref) { return values.get(ref.id)!.version; },
      async remove() {},
      async status() { return "available"; },
    };
    const runsDir = join(root, ".apicc", "runs-redaction");
    const logs: string[] = [];
    observedRequests.length = 0;
    const previousCwd = process.cwd();
    let code: number;
    try {
      process.chdir(root);
      code = await runCli([
        "run", `groups/${groupB}/projects/${projectId}/collections/${collectionId}`, "--env", "dev", "--runs-dir", runsDir,
      ], createDefaultRegistry(), (line) => logs.push(line), { secretStore, loadPlugins: false });
    } finally {
      process.chdir(previousCwd);
    }

    expect(code).toBe(0);
    expect(observedRequests.some((request) => request.authorization === basicAuthorization)).toBe(true);
    expect(observedRequests.some((request) => request.url.includes(`api%20key=${encodedQuerySecret}`))).toBe(true);
    const resultFiles = readdirSync(runsDir).filter((file) => file.startsWith("run-") && file.endsWith(".json"));
    expect(resultFiles).toHaveLength(1);
    const persisted = readFileSync(join(runsDir, resultFiles[0]!), "utf8");
    for (const forbidden of [basicSecret, basicAuthorization, querySecret, encodedQuerySecret, "bearer worker secret"]) {
      expect(persisted).not.toContain(forbidden);
      expect(logs.join("\n")).not.toContain(forbidden);
    }
  });

  it("redacts an actual Basic Authorization header when the username comes from an environment variable", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "apicc-contract-basic-variable-"));
    const password = "synthetic-basic-password-variable";
    const actualAuthorization = `Basic ${Buffer.from(`alice:${password}`, "utf8").toString("base64")}`;
    const fixtureWorkspace = workspace();
    const project = fixtureWorkspace.groups[1]!.projects[0]!;
    project.environments = [{
      id: "00000000-0000-4000-8000-000000000041",
      name: "dev",
      variables: { username: "alice" },
      baseUrls: {},
    }];
    project.collections[0]!.apis = [api(basicApiId, "basic-variable", "Basic auth variable echo", [{
      id: workerCaseId,
      name: "basic-variable",
      scope: "base",
      parameters: {},
      preOperations: [],
      postOperations: [],
      assertions: [{ id: "basic-echo", target: "bodyJson", path: "$.authorization", op: "contains", expected: "Basic" }],
    }], "/basic", { kind: "basic", username: "{{username}}", password: { id: basicRefId, policy: "test-auto" } })];
    const initial = await fileStorage.load(fixtureRoot);
    await fileStorage.save(fixtureRoot, fixtureWorkspace, { expectedRevision: initial.revision, deletions: [] });

    const secretStore: SecretStore = {
      async put() {},
      async resolve(_scope, ref) { expect(ref.id).toBe(basicRefId); return password; },
      async version() { return "version-basic-variable"; },
      async remove() {},
      async status() { return "available"; },
    };
    const runsDir = join(fixtureRoot, ".apicc", "runs");
    const logs: string[] = [];
    const previousCwd = process.cwd();
    observedRequests.length = 0;
    try {
      process.chdir(fixtureRoot);
      const code = await runCli([
        "run", `groups/${groupB}/projects/${projectId}/collections/${collectionId}`,
        "--env", "dev", "--runs-dir", runsDir,
      ], createDefaultRegistry(), (line) => logs.push(line), { secretStore, loadPlugins: false });

      expect(code).toBe(0);
      expect(observedRequests).toEqual([{ url: "/basic", authorization: actualAuthorization }]);
      const resultFiles = readdirSync(runsDir).filter((file) => file.startsWith("run-") && file.endsWith(".json"));
      expect(resultFiles).toHaveLength(1);
      const persisted = readFileSync(join(runsDir, resultFiles[0]!), "utf8");
      expect(persisted).not.toContain(actualAuthorization);
      expect(persisted).not.toContain(password);
      expect(logs.join("\n")).not.toContain(actualAuthorization);
      expect(logs.join("\n")).not.toContain(password);
    } finally {
      process.chdir(previousCwd);
      observedRequests.length = 0;
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("redacts actual Basic Authorization when a runtime username contains a colon", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "apicc-contract-basic-colon-"));
    const password = "synthetic-basic-password-colon";
    const actualAuthorization = `Basic ${Buffer.from(`alice:team:${password}`, "utf8").toString("base64")}`;
    const fixtureWorkspace = workspace();
    const project = fixtureWorkspace.groups[1]!.projects[0]!;
    project.environments = [{
      id: "00000000-0000-4000-8000-000000000043",
      name: "dev",
      variables: { username: "alice:team" },
      baseUrls: {},
    }];
    project.collections[0]!.apis = [api(basicApiId, "basic-colon", "Basic auth colon username echo", [{
      id: workerCaseId,
      name: "basic-colon",
      scope: "base",
      parameters: {},
      preOperations: [],
      postOperations: [],
      assertions: [{ id: "basic-echo", target: "bodyJson", path: "$.authorization", op: "contains", expected: "Basic" }],
    }], "/basic-colon", { kind: "basic", username: "{{username}}", password: { id: basicRefId, policy: "test-auto" } })];
    const initial = await fileStorage.load(fixtureRoot);
    await fileStorage.save(fixtureRoot, fixtureWorkspace, { expectedRevision: initial.revision, deletions: [] });

    const secretStore: SecretStore = {
      async put() {},
      async resolve(_scope, ref) { expect(ref.id).toBe(basicRefId); return password; },
      async version() { return "version-basic-colon"; },
      async remove() {},
      async status() { return "available"; },
    };
    const runsDir = join(fixtureRoot, ".apicc", "runs");
    const logs: string[] = [];
    const previousCwd = process.cwd();
    observedRequests.length = 0;
    try {
      process.chdir(fixtureRoot);
      const code = await runCli([
        "run", `groups/${groupB}/projects/${projectId}/collections/${collectionId}`,
        "--env", "dev", "--runs-dir", runsDir,
      ], createDefaultRegistry(), (line) => logs.push(line), { secretStore, loadPlugins: false });

      expect(code).toBe(0);
      expect(observedRequests).toEqual([{ url: "/basic-colon", authorization: actualAuthorization }]);
      const resultFiles = readdirSync(runsDir).filter((file) => file.startsWith("run-") && file.endsWith(".json"));
      expect(resultFiles).toHaveLength(1);
      const persisted = readFileSync(join(runsDir, resultFiles[0]!), "utf8");
      expect(persisted).not.toContain(actualAuthorization);
      expect(persisted).not.toContain(password);
      expect(logs.join("\n")).not.toContain(actualAuthorization);
      expect(logs.join("\n")).not.toContain(password);
    } finally {
      process.chdir(previousCwd);
      observedRequests.length = 0;
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("redacts actual Basic Authorization when a bound password contains an unpaired surrogate", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "apicc-contract-basic-surrogate-"));
    const password = `synthetic-${String.fromCharCode(0xd800)}`;
    const utf8Password = Buffer.from(password, "utf8").toString("utf8");
    const actualAuthorization = `Basic ${Buffer.from(`alice:${password}`, "utf8").toString("base64")}`;
    const fixtureWorkspace = workspace();
    const project = fixtureWorkspace.groups[1]!.projects[0]!;
    project.environments = [{
      id: "00000000-0000-4000-8000-000000000044",
      name: "dev",
      variables: { username: "alice" },
      baseUrls: {},
    }];
    project.collections[0]!.apis = [api(basicApiId, "basic-surrogate", "Basic auth surrogate echo", [{
      id: workerCaseId,
      name: "basic-surrogate",
      scope: "base",
      parameters: {},
      preOperations: [],
      postOperations: [],
      assertions: [{ id: "basic-echo", target: "bodyJson", path: "$.authorization", op: "contains", expected: "Basic" }],
    }], "/basic-surrogate", { kind: "basic", username: "{{username}}", password: { id: basicRefId, policy: "test-auto" } })];
    const initial = await fileStorage.load(fixtureRoot);
    await fileStorage.save(fixtureRoot, fixtureWorkspace, { expectedRevision: initial.revision, deletions: [] });

    const secretStore: SecretStore = {
      async put() {},
      async resolve(_scope, ref) { expect(ref.id).toBe(basicRefId); return password; },
      async version() { return "version-basic-surrogate"; },
      async remove() {},
      async status() { return "available"; },
    };
    const runsDir = join(fixtureRoot, ".apicc", "runs");
    const logs: string[] = [];
    const previousCwd = process.cwd();
    observedRequests.length = 0;
    try {
      process.chdir(fixtureRoot);
      const code = await runCli([
        "run", `groups/${groupB}/projects/${projectId}/collections/${collectionId}`,
        "--env", "dev", "--runs-dir", runsDir,
      ], createDefaultRegistry(), (line) => logs.push(line), { secretStore, loadPlugins: false });

      expect(code).toBe(0);
      expect(observedRequests.some((request) => request.url === "/basic-surrogate" && request.authorization === actualAuthorization)).toBe(true);
      const resultFiles = readdirSync(runsDir).filter((file) => file.startsWith("run-") && file.endsWith(".json"));
      expect(resultFiles).toHaveLength(1);
      const persisted = readFileSync(join(runsDir, resultFiles[0]!), "utf8");
      for (const output of [persisted, logs.join("\n")]) {
        expect(output.includes(actualAuthorization)).toBe(false);
        expect(output.includes(password)).toBe(false);
        expect(output.includes(utf8Password)).toBe(false);
      }
    } finally {
      process.chdir(previousCwd);
      observedRequests.length = 0;
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it.each([
    {
      source: "case parameters overriding an environment value",
      initialUsername: "{{username}}",
      environmentUsername: "environment-user",
      parameters: { username: "alice" },
      preOperations: [],
    },
    {
      source: "an ordinary pre-request script rewriting the materialized username",
      initialUsername: "initial-user",
      environmentUsername: undefined,
      parameters: {},
      preOperations: [{ id: "rewrite-username", type: "script" as const, content: 'pm.request.auth.username = "alice";' }],
    },
  ])("redacts actual Basic output when the username comes from $source", async ({ initialUsername, environmentUsername, parameters, preOperations }) => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "apicc-contract-basic-source-"));
    const password = "synthetic-basic-password-source";
    const actualAuthorization = `Basic ${Buffer.from(`alice:${password}`, "utf8").toString("base64")}`;
    const fixtureWorkspace = workspace();
    const project = fixtureWorkspace.groups[1]!.projects[0]!;
    project.environments = [{
      id: "00000000-0000-4000-8000-000000000042",
      name: "dev",
      variables: environmentUsername ? { username: environmentUsername } : {},
      baseUrls: {},
    }];
    project.collections[0]!.apis = [api(basicApiId, "basic-source", "Basic auth source echo", [{
      id: workerCaseId,
      name: "basic-source",
      scope: "base",
      parameters,
      preOperations,
      postOperations: [],
      assertions: [{ id: "basic-echo", target: "bodyJson", path: "$.authorization", op: "contains", expected: "Basic" }],
    }], "/basic", { kind: "basic", username: initialUsername, password: { id: basicRefId, policy: "test-auto" } })];
    const initial = await fileStorage.load(fixtureRoot);
    await fileStorage.save(fixtureRoot, fixtureWorkspace, { expectedRevision: initial.revision, deletions: [] });

    const secretStore: SecretStore = {
      async put() {},
      async resolve(_scope, ref) { expect(ref.id).toBe(basicRefId); return password; },
      async version() { return "version-basic-source"; },
      async remove() {},
      async status() { return "available"; },
    };
    const runsDir = join(fixtureRoot, ".apicc", "runs");
    const logs: string[] = [];
    const previousCwd = process.cwd();
    observedRequests.length = 0;
    try {
      process.chdir(fixtureRoot);
      const code = await runCli([
        "run", `groups/${groupB}/projects/${projectId}/collections/${collectionId}`,
        "--env", "dev", "--runs-dir", runsDir,
      ], createDefaultRegistry(), (line) => logs.push(line), { secretStore, loadPlugins: false });

      expect(code).toBe(0);
      expect(observedRequests).toEqual([{ url: "/basic", authorization: actualAuthorization }]);
      const resultFiles = readdirSync(runsDir).filter((file) => file.startsWith("run-") && file.endsWith(".json"));
      expect(resultFiles).toHaveLength(1);
      const persisted = readFileSync(join(runsDir, resultFiles[0]!), "utf8");
      for (const forbidden of [actualAuthorization, password]) {
        expect(persisted).not.toContain(forbidden);
        expect(logs.join("\n")).not.toContain(forbidden);
      }
    } finally {
      process.chdir(previousCwd);
      observedRequests.length = 0;
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("credentials save/status/remove use the selected full project scope and never print the value", async () => {
    const calls: string[] = [];
    const values = new Map<string, string>();
    const secretStore: SecretStore = {
      async put(scope, ref, value) {
        calls.push(`put:${scope.workspaceId}:${scope.groupId}:${scope.projectId}:${ref.id}`);
        values.set(ref.id, value);
      },
      async resolve(_scope, ref) { return values.get(ref.id) ?? ""; },
      async version(_scope, ref) { return values.has(ref.id) ? "version-1" : ""; },
      async remove(scope, ref) {
        calls.push(`remove:${scope.workspaceId}:${scope.groupId}:${scope.projectId}:${ref.id}`);
        values.delete(ref.id);
      },
      async status(_scope, ref) { return values.has(ref.id) ? "available" : "missing"; },
    };
    const projectPath = `groups/${groupB}/projects/${projectId}`;
    const previousCwd = process.cwd();
    const logs: string[] = [];
    try {
      process.chdir(root);
      const saveCode = await runCli(["credentials", "save", projectPath, "__proto__"], createDefaultRegistry(), (line) => logs.push(line), {
        secretStore, secretInput: async () => "synthetic-cli-save-value", loadPlugins: false,
      });
      const statusCode = await runCli(["credentials", "status", projectPath, "__proto__"], createDefaultRegistry(), (line) => logs.push(line), {
        secretStore, loadPlugins: false,
      });
      const removeCode = await runCli(["credentials", "remove", projectPath, "__proto__"], createDefaultRegistry(), (line) => logs.push(line), {
        secretStore, loadPlugins: false,
      });
      expect([saveCode, statusCode, removeCode]).toEqual([0, 0, 0]);
    } finally {
      process.chdir(previousCwd);
    }

    expect(calls).toEqual([
      `put:00000000-0000-4000-8000-000000000001:${groupB}:${projectId}:__proto__`,
      `remove:00000000-0000-4000-8000-000000000001:${groupB}:${projectId}:__proto__`,
    ]);
    expect(logs.join("\n")).toContain("凭据状态：available");
    expect(logs.join("\n")).not.toContain("synthetic-cli-save-value");
  });

  it("stable credential errors preserve each code/ref and map all eight categories to distinct safe messages", () => {
    const codes = [
      "CREDENTIAL_MISSING",
      "CREDENTIAL_UNAVAILABLE",
      "CREDENTIAL_FORMAT_UNSUPPORTED",
      "CREDENTIAL_POLICY_UNSUPPORTED",
      "CREDENTIAL_READ_FAILED",
      "CREDENTIAL_SAVE_FAILED",
      "CREDENTIAL_REMOVE_FAILED",
      "CREDENTIAL_VERSION_CONFLICT",
    ] as const;
    const mapped = codes.map((code) => {
      const source = new CredentialError(code, "synthetic-ref-id");
      source.cause = new Error("private-native-backend-detail");
      const stable = stableCredentialError(source) as Error & { code?: string; refId?: string };
      expect(stable).toMatchObject({ code, refId: "synthetic-ref-id" });
      expect(stable.message).toContain(code);
      expect(stable.message).toContain("synthetic-ref-id");
      expect(stable.message).not.toContain("private-native-backend-detail");
      return stable.message;
    });

    expect(new Set(mapped).size).toBe(codes.length);
  });

  it.each([
    ["save", "CREDENTIAL_SAVE_FAILED"],
    ["status", "CREDENTIAL_UNAVAILABLE"],
    ["remove", "CREDENTIAL_REMOVE_FAILED"],
  ] as const)("credentials %s preserves safe error code/ref from the host store", async (operation, code) => {
    const nativeDetail = "private-native-backend-detail";
    const fail = (refId: string): never => {
      const error = new CredentialError(code, refId);
      error.cause = new Error(nativeDetail);
      throw error;
    };
    const secretStore: SecretStore = {
      async put(_scope, ref) { if (operation === "save") fail(ref.id); },
      async resolve() { return "unused"; },
      async version() { return "version"; },
      async remove(_scope, ref) { if (operation === "remove") fail(ref.id); },
      async status(_scope, ref) { if (operation === "status") fail(ref.id); return "available"; },
    };
    const projectPath = `groups/${groupB}/projects/${projectId}`;
    const args = operation === "save"
      ? ["credentials", operation, projectPath, "__proto__"]
      : ["credentials", operation, projectPath, "__proto__"];
    const previousCwd = process.cwd();
    let caught: unknown;
    try {
      process.chdir(root);
      await runCli(args, createDefaultRegistry(), () => {}, {
        secretStore,
        ...(operation === "save" ? { secretInput: async () => "synthetic-cli-input" } : {}),
        loadPlugins: false,
      });
    } catch (error) {
      caught = error;
    } finally {
      process.chdir(previousCwd);
    }

    expect(caught).toMatchObject({ code, refId: "__proto__" });
    expect((caught as Error).message).toContain(code);
    expect((caught as Error).message).not.toContain(nativeDetail);
  });

  it("collection run maps a credential read failure to its stable category before sending", async () => {
    const secretStore: SecretStore = {
      async put() {},
      async resolve() { throw new Error("unexpected credential resolution"); },
      async version(_scope, ref) {
        if (ref.id === "__proto__") {
          const error = new CredentialError("CREDENTIAL_READ_FAILED", ref.id);
          error.cause = new Error("private-native-backend-detail");
          throw error;
        }
        return "version-unused";
      },
      async remove() {},
      async status() { return "available"; },
    };
    const previousCwd = process.cwd();
    let caught: unknown;
    try {
      process.chdir(root);
      await runCli([
        "run", `groups/${groupB}/projects/${projectId}/collections/${collectionId}`, "--env", "dev",
      ], createDefaultRegistry(), () => {}, { secretStore, loadPlugins: false });
    } catch (error) {
      caught = error;
    } finally {
      process.chdir(previousCwd);
    }

    expect(caught).toMatchObject({ code: "CREDENTIAL_READ_FAILED", refId: "__proto__" });
    expect((caught as Error).message).toContain("CREDENTIAL_READ_FAILED");
    expect((caught as Error).message).not.toContain("private-native-backend-detail");
    expect(observedRequests).toHaveLength(0);
  });

  it("no-auth run with an empty ref table does not touch the credential store", async () => {
    const state = await fileStorage.load(root);
    const group = state.workspace.groups[0]!;
    const project = group.projects[0]!;
    const noAuthApi = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    let storeCalls = 0;
    const neverStore: SecretStore = {
      async put() { storeCalls += 1; throw new Error("unexpected credential store access"); },
      async resolve() { storeCalls += 1; throw new Error("unexpected credential store access"); },
      async version() { storeCalls += 1; throw new Error("unexpected credential store access"); },
      async remove() { storeCalls += 1; throw new Error("unexpected credential store access"); },
      async status() { storeCalls += 1; throw new Error("unexpected credential store access"); },
    };

    const prepared = await prepareExecutionRun(state.workspace, group.id, project, [noAuthApi], { secretStore: neverStore });

    expect(prepared.refs).toEqual([]);
    expect(prepared.run.credentialBindings.versions).toEqual({});
    expect(storeCalls).toBe(0);
  });

  it("run prepares only refs for APIs with base or inherited cases in the selected environment", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "apicc-contract-selected-case-"));
    const fixtureWorkspace = workspace();
    const project = fixtureWorkspace.groups[1]!.projects[0]!;
    project.environments = [
      { id: "00000000-0000-4000-8000-000000000042", name: "dev", extends: "staging", variables: {}, baseUrls: {} },
      { id: "00000000-0000-4000-8000-000000000043", name: "staging", variables: {}, baseUrls: {} },
    ];
    const scopedCase = (id: string, scope: string) => ({
      id, name: scope, scope, parameters: {}, preOperations: [], postOperations: [], assertions: [],
    });
    project.collections[0]!.apis = [
      api("00000000-0000-4000-8000-000000000044", "base-no-auth", "", [scopedCase("00000000-0000-4000-8000-000000000045", "base")], "/base"),
      api("00000000-0000-4000-8000-000000000046", "inherited-auth", "", [scopedCase("00000000-0000-4000-8000-000000000047", "staging")], "/inherited", {
        kind: "bearer", token: { id: "inherited-active-ref", policy: "test-auto" },
      }),
      api("00000000-0000-4000-8000-000000000048", "empty-case-auth", "", [], "/empty-case", {
        kind: "bearer", token: { id: "unused-empty-ref", policy: "test-auto" },
      }),
      api("00000000-0000-4000-8000-000000000049", "other-scope-auth", "", [scopedCase("00000000-0000-4000-8000-000000000050", "prod")], "/other-scope", {
        kind: "bearer", token: { id: "unused-other-scope-ref", policy: "test-auto" },
      }),
    ];
    const initial = await fileStorage.load(fixtureRoot);
    await fileStorage.save(fixtureRoot, fixtureWorkspace, { expectedRevision: initial.revision, deletions: [] });

    const touchedRefs = new Set<string>();
    const secretStore: SecretStore = {
      async put(_scope, ref) { touchedRefs.add(ref.id); throw new Error("unexpected credential write"); },
      async resolve(_scope, ref) {
        touchedRefs.add(ref.id);
        if (ref.id !== "inherited-active-ref") throw new Error(`unexpected ref ${ref.id}`);
        return "synthetic-inherited-run-token";
      },
      async version(_scope, ref) {
        touchedRefs.add(ref.id);
        if (ref.id !== "inherited-active-ref") throw new Error(`unexpected ref ${ref.id}`);
        return "version-inherited-active";
      },
      async remove(_scope, ref) { touchedRefs.add(ref.id); throw new Error("unexpected credential remove"); },
      async status(_scope, ref) {
        touchedRefs.add(ref.id);
        if (ref.id !== "inherited-active-ref") throw new Error(`unexpected ref ${ref.id}`);
        return "available";
      },
    };
    const previousCwd = process.cwd();
    observedRequests.length = 0;
    try {
      process.chdir(fixtureRoot);
      const code = await runCli([
        "run", `groups/${groupB}/projects/${projectId}/collections/${collectionId}`,
        "--env", "dev", "--runs-dir", join(fixtureRoot, ".apicc", "runs"),
      ], createDefaultRegistry(), () => {}, { secretStore, loadPlugins: false });

      expect(code).toBe(0);
      expect(touchedRefs).toEqual(new Set(["inherited-active-ref"]));
      expect(observedRequests).toEqual([
        { url: "/base", authorization: "" },
        { url: "/inherited", authorization: "Bearer synthetic-inherited-run-token" },
      ]);
    } finally {
      process.chdir(previousCwd);
      observedRequests.length = 0;
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("an already prepared run keeps its credential binding; a later run sees the replacement", async () => {
    const state = await fileStorage.load(root);
    const group = state.workspace.groups[1]!;
    const project = group.projects[0]!;
    const apiAsset = project.collections[0]!.apis[0]!;
    const ref = { id: "__proto__", policy: "test-auto" };
    let currentValue = "synthetic-old-worker-secret";
    let currentVersion = "version-before-replacement";
    const secretStore: SecretStore = {
      async put() {},
      async resolve(_scope, requested, expectedVersion) {
        expect(requested.id).toBe(ref.id);
        expect(expectedVersion).toBe(currentVersion);
        return currentValue;
      },
      async version(_scope, requested) {
        expect(requested.id).toBe(ref.id);
        return currentVersion;
      },
      async remove() {},
      async status() { return "available"; },
    };

    const first = await prepareExecutionRun(state.workspace, group.id, project, [apiAsset], { secretStore });
    expect(first.run.credentialBindings.resolve(ref)).toBe("synthetic-old-worker-secret");
    expect(Object.hasOwn(first.run.credentialBindings.versions, ref.id)).toBe(true);
    expect(first.run.credentialBindings.versions[ref.id]).toBe("version-before-replacement");

    currentValue = "synthetic-new-worker-secret";
    currentVersion = "version-after-replacement";
    expect(first.run.credentialBindings.resolve(ref)).toBe("synthetic-old-worker-secret");

    const nextRun = await prepareExecutionRun(state.workspace, group.id, project, [apiAsset], { secretStore });
    expect(nextRun.run.credentialBindings.resolve(ref)).toBe("synthetic-new-worker-secret");
    expect(nextRun.run.credentialBindings.versions[ref.id]).toBe("version-after-replacement");
  });

  it("stress-worker retains and checks an own __proto__ credential version before sending", async () => {
    const state = await fileStorage.load(root);
    const project = state.workspace.groups[1]!.projects[0]!;
    const revision = createProjectSnapshot(project).definitionRevision;
    let versionReads = 0;
    const secretStore: SecretStore = {
      async put() {},
      async resolve(_scope, ref, expectedVersion) {
        expect(ref.id).toBe("__proto__");
        expect(expectedVersion).toBe("version-own-proto");
        return "synthetic-worker-secret";
      },
      async version(_scope, ref) {
        expect(ref.id).toBe("__proto__");
        versionReads += 1;
        return "version-own-proto";
      },
      async remove() {},
      async status() { return "available"; },
    };
    const versionWire = '{"__proto__":"version-own-proto"}';
    const out: string[] = [];
    const err: string[] = [];
    requestPath = "";
    authorizationHeader = "";
    const code = await runCli(protoWorkerArgs(revision, versionWire), createDefaultRegistry(), () => {}, {
      workerOut: (line) => out.push(line), workerErr: (line) => err.push(line), secretStore, networkPrivateRoot,
    });

    expect(code).toBe(0);
    expect(versionReads).toBe(2);
    expect(authorizationHeader).toBe("Bearer synthetic-worker-secret");
    expect(out).toHaveLength(1);
    expect(err.join("\n")).not.toContain("synthetic-worker-secret");
    expect(out.join("\n")).not.toContain("synthetic-worker-secret");
  });

  it("拒绝缺失 own ref 版本的 worker 描述符，且读取凭据前零请求", async () => {
    const state = await fileStorage.load(root);
    const project = state.workspace.groups[1]!.projects[0]!;
    let storeCalls = 0;
    const secretStore: SecretStore = {
      async put() {},
      async resolve() { storeCalls += 1; return "synthetic-worker-secret"; },
      async version() { storeCalls += 1; return "version-own-proto"; },
      async remove() {},
      async status() { storeCalls += 1; return "available"; },
    };
    const out: string[] = [];
    const err: string[] = [];
    requestPath = "";
    const code = await runCli(protoWorkerArgs(createProjectSnapshot(project).definitionRevision, "{}"), createDefaultRegistry(), () => {}, {
      workerOut: (line) => out.push(line), workerErr: (line) => err.push(line), secretStore, networkPrivateRoot,
    });

    expect(code).toBe(1);
    expect(storeCalls).toBe(0);
    expect(requestPath).toBe("");
    expect(err.join("\n")).toContain("缺少 own expected version");
    expect(out.join("\n")).not.toContain("synthetic-worker-secret");
  });

  it("定义版本已变化时在读取凭据和发送前失败", async () => {
    const state = await fileStorage.load(root);
    const project = state.workspace.groups[1]!.projects[0]!;
    let storeCalls = 0;
    const secretStore: SecretStore = {
      async put() {},
      async resolve() { storeCalls += 1; return "synthetic-worker-secret"; },
      async version() { storeCalls += 1; return "version-own-proto"; },
      async remove() {},
      async status() { storeCalls += 1; return "available"; },
    };
    const out: string[] = [];
    const err: string[] = [];
    requestPath = "";
    const code = await runCli(protoWorkerArgs("stale-definition-revision", '{"__proto__":"version-own-proto"}'), createDefaultRegistry(), () => {}, {
      workerOut: (line) => out.push(line), workerErr: (line) => err.push(line), secretStore, networkPrivateRoot,
    });

    expect(code).toBe(1);
    expect(storeCalls).toBe(0);
    expect(requestPath).toBe("");
    expect(err.join("\n")).toContain("定义在压测 worker 启动前发生变化");
    expect(out.join("\n")).not.toContain("synthetic-worker-secret");
  });

  it("network identity mismatch fails before a worker request is sent", async () => {
    const state = await fileStorage.load(root);
    const project = state.workspace.groups[1]!.projects[0]!;
    const out: string[] = [];
    const err: string[] = [];
    requestPath = "";
    const wrongIdentity = `sha256:${"f".repeat(64)}`;
    const code = await runCli(protoWorkerArgs(
      createProjectSnapshot(project).definitionRevision,
      '{"__proto__":"version-own-proto"}',
      wrongIdentity,
    ), createDefaultRegistry(), () => {}, {
      workerOut: (line) => out.push(line), workerErr: (line) => err.push(line), networkPrivateRoot,
      secretStore: {
        async put() {}, async resolve() { return "synthetic-worker-secret"; }, async version() { return "version-own-proto"; },
        async remove() {}, async status() { return "available"; },
      },
    });

    expect(code).toBe(1);
    expect(requestPath).toBe("");
    expect(err.join("\n")).toContain("网络配置或公开证书材料");
    expect(out.join("\n")).not.toContain("synthetic-worker-secret");
  });

  it.each(["replace", "delete"] as const)("worker 启动期间凭据 %s 时 config/零发送", async (mutation) => {
    const state = await fileStorage.load(root);
    const project = state.workspace.groups[1]!.projects[0]!;
    let versionReads = 0;
    const secretStore: SecretStore = {
      async put() {},
      async resolve(_scope, ref) {
        if (mutation === "delete") throw new CredentialError("CREDENTIAL_MISSING", ref.id);
        return "synthetic-worker-secret";
      },
      async version() {
        versionReads += 1;
        return mutation === "replace" && versionReads > 1 ? "version-replaced" : "version-own-proto";
      },
      async remove() {},
      async status() { return "available"; },
    };
    const out: string[] = [];
    const err: string[] = [];
    requestPath = "";
    const code = await runCli(protoWorkerArgs(createProjectSnapshot(project).definitionRevision, '{"__proto__":"version-own-proto"}'), createDefaultRegistry(), () => {}, {
      workerOut: (line) => out.push(line), workerErr: (line) => err.push(line), secretStore, networkPrivateRoot,
    });

    expect(code).toBe(1);
    expect(requestPath).toBe("");
    expect(err.join("\n")).toContain("发生变化");
    expect(out.join("\n")).not.toContain("synthetic-worker-secret");
  });
});

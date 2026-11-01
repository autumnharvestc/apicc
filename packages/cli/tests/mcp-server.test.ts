import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CredentialError,
  createDefaultRegistry,
  createProjectSnapshot,
  fileStorage,
  renderContractMarkdown,
  type Workspace,
  type SecretStore,
} from "@apicc/core";
import { createMcpServer, createScopedMcpServer } from "../src/mcp/server.js";
import { createMcpSource } from "../src/mcp/source.js";
import { onlineFixture } from "./mcp-online.fixture.js";
import { runCli } from "../src/main.js";

// SDK InMemoryTransport covers focused behavior; the built-child test also verifies actual stdio.
// 安全红线：工具只暴露 --workspace 指定的工作区；工具无文件系统路径类参数（apiPath 仅是
// 与既有 CLI 同口径的工作区相对定位符，只与内存树匹配，不落任何 FS 访问）。

const GROUP_A = "00000000-0000-4000-8000-000000000002";
const PROJECT_A = "00000000-0000-4000-8000-000000000004";
const COLLECTION_A = "00000000-0000-4000-8000-000000000008";
const FOLDER_A = "00000000-0000-4000-8000-000000000031";
const DEEP_API = "00000000-0000-4000-8000-000000000032";
const DEEP_CASE = "00000000-0000-4000-8000-000000000033";
const OK_API = "00000000-0000-4000-8000-000000000034";
const OK_CASE = "00000000-0000-4000-8000-000000000015";
const DEV_CASE = "00000000-0000-4000-8000-000000000016";
const XOK_API = "00000000-0000-4000-8000-000000000037";
const XOK_CASE = "00000000-0000-4000-8000-000000000038";
const OK_PATH = `groups/${GROUP_A}/projects/${PROJECT_A}/collections/${COLLECTION_A}/apis/${OK_API}`;
const DEEP_PATH = `groups/${GROUP_A}/projects/${PROJECT_A}/collections/${COLLECTION_A}/folders/${FOLDER_A}/apis/${DEEP_API}`;

let server: Server;
let baseUrl = "";
let rootA: string;
let rootB: string;
const tempRoots: string[] = [];

/** 建 SDK 内存对测的已连接 client（裁定②），返回 client 供 listTools/callTool。 */
async function connectClient(root: string, opts: { allowRun?: boolean; log?: (l: string) => void } = {}) {
  const mcp = createMcpServer(root, opts);
  const client = new Client({ name: "mcp-server-test", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
  return { mcp, client };
}

function textOf(res: { content: Array<{ type: string; text: string }> }): string {
  return res.content.map((c) => c.text).join("\n");
}
function sourceData(res: unknown): any { return (res as { structuredContent: { data: unknown } }).structuredContent.data; }

function testCase(id: string, name: string, scope: string, assertions: Workspace["groups"][number]["projects"][number]["collections"][number]["apis"][number]["cases"][number]["assertions"] = []) {
  return { id, name, scope, parameters: {}, preOperations: [], postOperations: [], assertions };
}

function apiAsset(
  id: string,
  name: string,
  path: string,
  cases: ReturnType<typeof testCase>[],
  documentation = "",
  method: "GET" | "POST" = "GET",
  body: { kind: "none" } | { kind: "json"; content: string } = { kind: "none" },
) {
  return {
    contract: {
      formatVersion: 1 as const, id,
      metadata: { name, description: "", tags: [], version: "1", status: "published" as const },
      request: {
        protocol: "http" as const, method, baseUrl, path, pathParams: [], query: [], headers: [], cookies: [],
        auth: { kind: "none" as const }, body,
      },
      responses: [],
    },
    documentation,
    cases,
  };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/deep" ? { deep: true } : { ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  // 工作区 A：集合顶层接口 ok + xok（边界匹配钉子）、folder 内接口 deep、dev-scope 用例。
  rootA = mkdtempSync(join(tmpdir(), "apicc-mcp-a-"));
  tempRoots.push(rootA);
  const wsA: Workspace = {
    formatVersion: 1, id: "00000000-0000-4000-8000-000000000001", name: "mcp-a", variables: {},
    groups: [{
      id: GROUP_A, name: "demo", projects: [{
        id: PROJECT_A, name: "svc", variables: {}, globals: { query: [], headers: [], cookies: [], body: [] }, components: [], models: [], workflows: [], environments: [],
        stressPolicy: {},
        collections: [{
          id: COLLECTION_A, name: "api", variables: {}, preOperations: [], postOperations: [],
          folders: [{
            id: FOLDER_A, name: "sub", preOperations: [], postOperations: [], folders: [],
            apis: [apiAsset(DEEP_API, "deep", "/deep", [testCase(DEEP_CASE, "deep-ok", "base")], "", "POST", { kind: "json", content: "{\"n\":1}" })],
          }],
          apis: [
            apiAsset(OK_API, "ok", "/x", [
                testCase(OK_CASE, "passes", "base", [
                  { id: "as1", target: "status", op: "eq", expected: "200" },
                  { id: "as2", target: "bodyJson", path: "$.ok", op: "eq", expected: "true" },
                ]),
                testCase(DEV_CASE, "dev-only", "dev"),
              ], "ok 接口的业务规则说明（documentation）。"),
            apiAsset(XOK_API, "xok", "/y", [testCase(XOK_CASE, "x-passes", "base")]),
          ],
        }],
      }],
    }],
  };
  const initialA = await fileStorage.load(rootA);
  await fileStorage.save(rootA, wsA, { expectedRevision: initialA.revision, deletions: [] });

  // 工作区 B：不同接口——钉住「工具只暴露 --workspace 指定的工作区」。
  rootB = mkdtempSync(join(tmpdir(), "apicc-mcp-b-"));
  tempRoots.push(rootB);
  const wsB: Workspace = {
    formatVersion: 1, id: "00000000-0000-4000-8000-000000000011", name: "mcp-b", variables: {},
    groups: [{
      id: "00000000-0000-4000-8000-000000000003", name: "other", projects: [{
        id: "00000000-0000-4000-8000-000000000005", name: "bee", variables: {}, globals: { query: [], headers: [], cookies: [], body: [] }, components: [], models: [], workflows: [], environments: [], stressPolicy: {},
        collections: [{
          id: "00000000-0000-4000-8000-000000000009", name: "col", variables: {}, preOperations: [], postOperations: [], folders: [],
          apis: [apiAsset("00000000-0000-4000-8000-000000000035", "bee", "/", [testCase("00000000-0000-4000-8000-000000000036", "bee-passes", "base")], "", "GET")],
        }],
      }],
    }],
  };
  const initialB = await fileStorage.load(rootB);
  await fileStorage.save(rootB, wsB, { expectedRevision: initialB.revision, deletions: [] });
});

afterAll(() => {
  for (const dir of tempRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 残留临时目录留给操作系统清理，不影响测试结论。
    }
  }
  return new Promise<void>((r) => server.close(() => r()));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("只读工具（list-apis / get-api-design）", () => {
  it.each(["userinfo", "safe-query"] as const)("protects a documentation URL in actual SDK Markdown: %s", async behavior => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "apicc-mcp-doc-url-")); tempRoots.push(fixtureRoot);
    const { workspace } = await fileStorage.load(rootA); workspace.groups[0]!.projects[0]!.collections[0]!.apis[0]!.documentation = "https://doc-user:doc-private@example.test/items?password=doc-query-private&visible=yes";
    const initial = await fileStorage.load(fixtureRoot); await fileStorage.save(fixtureRoot, workspace, { expectedRevision: initial.revision, deletions: [] });
    const { client } = await connectClient(fixtureRoot, { log: () => {} });
    try {
      const result = await client.callTool({ name: "get-api-design", arguments: { apiPath: OK_PATH } }); expect(result.isError).toBeFalsy(); const output = textOf(result as never);
      if (behavior === "userinfo") { expect(output).not.toContain("doc-user"); expect(output).not.toContain("doc-private"); }
      else expect(output).toContain("visible=yes");
    } finally { await client.close(); }
  });
  it("legacy synchronous wrapper exposes the new read tools without registering execution", async () => {
    const { mcp, client } = await connectClient(rootA, { log: () => {} });
    try { expect(mcp).not.toHaveProperty("then"); expect((await client.listTools()).tools.map(tool => tool.name)).toContain("list-assets"); }
    finally { await client.close(); }
  });
  it("legacy list-apis returns an explicit page envelope when limit is selected", async () => {
    const { client } = await connectClient(rootA, { log: () => {} });
    try {
      const result = await client.callTool({ name: "list-apis", arguments: { limit: 1 } });
      expect(result.isError).toBeFalsy(); const page = JSON.parse(textOf(result as never));
      expect(page.items).toHaveLength(1); expect(page.items[0].id).toBe(OK_API); expect(page.nextCursor).toBeTruthy();
      const next = await client.callTool({ name: "list-apis", arguments: { limit: 1, cursor: page.nextCursor } });
      expect(JSON.parse(textOf(next as never)).items[0].id).toBe(XOK_API);
    } finally { await client.close(); }
  });
  it("enforces a selected smaller output budget on an actual scoped asset result", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "apicc-mcp-small-budget-")); tempRoots.push(fixtureRoot);
    const { workspace } = await fileStorage.load(rootA); workspace.groups[0]!.projects[0]!.collections[0]!.apis[0]!.contract.metadata.name = "x".repeat(5000);
    const initial = await fileStorage.load(fixtureRoot); await fileStorage.save(fixtureRoot, workspace, { expectedRevision: initial.revision, deletions: [] });
    const source = await createMcpSource({ workspace: fixtureRoot }); const mcp = createScopedMcpServer(source, { maxOutputBytes: 4096 });
    const client = new Client({ name: "small-budget", version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([client.connect(a), mcp.connect(b)]);
    try { const result = await client.callTool({ name: "get-asset", arguments: { projectId: PROJECT_A, assetId: `api:${OK_API}` } }); expect(result.isError).toBe(true); expect(Buffer.byteLength(textOf(result as never))).toBeLessThanOrEqual(4096); }
    finally { await client.close(); await source.close(); }
  });
  it.each([4095, 1048577])("rejects a configured output budget outside the public range: %s", async maxOutputBytes => {
    const source = await createMcpSource({ workspace: rootA });
    try { expect(() => createScopedMcpServer(source, { maxOutputBytes })).toThrow(/预算|budget/); }
    finally { await source.close(); }
  });
  // Fixed-source tools must expose projected assets, not the raw project snapshot.
  it("scoped server lists and reads the selected API asset with native IDs and default omissions", async () => {
    const source = await createMcpSource({ workspace: rootA }); const mcp = createScopedMcpServer(source);
    const client = new Client({ name: "scoped-source-test", version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), mcp.connect(b)]);
    try {
      const listed = await client.callTool({ name: "list-assets", arguments: { projectId: PROJECT_A } });
      expect(listed.isError).toBeFalsy();
      const page = sourceData(listed);
      expect(page.items).toEqual(expect.arrayContaining([expect.objectContaining({ assetId: `api:${DEEP_API}`, kind: "api", name: "deep" })]));
      const read = await client.callTool({ name: "get-asset", arguments: { projectId: PROJECT_A, assetId: `api:${DEEP_API}` } });
      expect(read.isError).toBeFalsy();
      const output = sourceData(read);
      expect(output.asset).toMatchObject({ contractId: DEEP_API, request: { protocol: "http", body: { kind: "json" } } });
      expect(output.asset.request.body).not.toHaveProperty("content");
      expect(output.omitted).toContain("scripts");
      expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain("run-case");
    } finally { await client.close(); await source.close(); }
  });
  // Default read tools must not opt the model into an existing request body.
  it("get-api-design omits the unselected request body through the real SDK", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "apicc-mcp-design-body-")); tempRoots.push(fixtureRoot);
    const { workspace } = await fileStorage.load(rootA);
    const request = workspace.groups[0]!.projects[0]!.collections[0]!.folders[0]!.apis[0]!.contract.request;
    if (request.protocol !== "http") throw new Error("HTTP fixture required");
    request.body = { kind: "json", content: '{"business":"MCP_UNSELECTED_BODY"}' };
    const initial = await fileStorage.load(fixtureRoot); await fileStorage.save(fixtureRoot, workspace, { expectedRevision: initial.revision, deletions: [] });
    const { client } = await connectClient(fixtureRoot, { log: () => {} });
    try {
      const result = await client.callTool({ name: "get-api-design", arguments: { apiPath: DEEP_PATH } });
      expect(result.isError).toBeFalsy(); expect(textOf(result as never)).not.toContain("MCP_UNSELECTED_BODY");
      expect(textOf(result as never)).toContain("Contract ID:");
    } finally { await client.close(); }
  });
  it("list-apis 返回工作区全部接口摘要（id/name/protocol/url/apiPath，含 folder 内接口）", async () => {
    const { client } = await connectClient(rootA);
    const res = await client.callTool({ name: "list-apis", arguments: {} });
    expect(res.isError).toBeFalsy();
    const rows = JSON.parse(textOf(res as never)) as Array<Record<string, string>>;
    expect(rows).toHaveLength(3);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(OK_API)).toMatchObject({ name: "ok", protocol: "http", url: `${baseUrl}/x`, apiPath: OK_PATH });
    // folder 内接口在列，apiPath 含 folders 段。
    expect(byId.get(DEEP_API)).toMatchObject({ name: "deep", protocol: "http", url: `${baseUrl}/deep`, apiPath: DEEP_PATH });
    expect(byId.get(XOK_API)).toMatchObject({ name: "xok", url: `${baseUrl}/y` });
    await client.close();
  });

  it("get-api-design 按 apiPath 全路径定位，返回 renderDesignMarkdown 产物（含 design.md 正文）", async () => {
    const { client } = await connectClient(rootA);
    const res = await client.callTool({ name: "get-api-design", arguments: { apiPath: OK_PATH } });
    expect(res.isError).toBeFalsy();
    // 期望值取自同一工作区加载产物（fileStorage 会把 design.md 读回 api.design）。
    const { workspace } = await fileStorage.load(rootA);
    const project = workspace.groups[0]!.projects[0]!;
    const api = project.collections[0]!.apis.find((a) => a.contract.id === OK_API)!;
    expect(textOf(res as never)).toBe(renderContractMarkdown(api, createProjectSnapshot(project).context));
    await client.close();
  });

  it("get-api-design 拒绝不完整名称路径，只接受工作区完整 UUID 路径", async () => {
    const { client } = await connectClient(rootA);
    const res = await client.callTool({ name: "get-api-design", arguments: { apiPath: "collections/api/apis/ok" } });
    expect(res.isError).toBe(true);
    expect(textOf(res as never)).toContain("未找到接口");
    await client.close();
  });

  it("get-api-design 未知 apiPath → isError 且文案含 未找到接口", async () => {
    const { client } = await connectClient(rootA);
    const res = await client.callTool({ name: "get-api-design", arguments: { apiPath: "groups/g/projects/p/collections/c/apis/ghost" } });
    expect(res.isError).toBe(true);
    expect(textOf(res as never)).toContain("未找到接口");
    await client.close();
  });
});

describe("run-case（opt-in 执行类工具）", () => {
  it("默认（未开 --allow-run）：run-case 不出现在 tools/list，调用报 Tool not found（裁定⑥：不是调用时拒绝而是不注册）", async () => {
    const { client } = await connectClient(rootA);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(["list-assets", "get-asset", "list-runs", "get-run", "get-report", "list-apis", "get-api-design"]);
    // SDK 1.30 未知工具返回 isError 结果（协议层 -32602），而非 reject。
    const res = await client.callTool({ name: "run-case", arguments: { apiPath: OK_PATH, caseId: "00000000-0000-4000-8000-000000000015" } });
    expect(res.isError).toBe(true);
    expect(textOf(res as never)).toContain("Tool run-case not found");
    await client.close();
  });

  it("--allow-run 开启：run-case 注册并可执行，返回 CaseOutcome 摘要（passed/assertions/error）", async () => {
    const { client } = await connectClient(rootA, { allowRun: true });
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("run-case");
    const res = await client.callTool({ name: "run-case", arguments: { apiPath: OK_PATH, caseId: "00000000-0000-4000-8000-000000000015" } });
    expect(res.isError).toBeFalsy();
    const outcome = JSON.parse(textOf(res as never)) as {
      apiId: string; caseId: string; passed: boolean; error?: string;
      assertions: Array<{ pass: boolean }>;
    };
    expect(outcome.apiId).toBe("00000000-0000-4000-8000-000000000034");
    expect(outcome.caseId).toBe("00000000-0000-4000-8000-000000000015");
    expect(outcome.passed).toBe(true);
    expect(outcome.error).toBeUndefined();
    expect(outcome.assertions).toHaveLength(2);
    expect(outcome.assertions.every((a) => a.pass)).toBe(true);
    await client.close();
  });

  it("run-case 执行 folder 内接口用例（本地 http 夹具真实往返）", async () => {
    const { client } = await connectClient(rootA, { allowRun: true });
    const res = await client.callTool({ name: "run-case", arguments: { apiPath: DEEP_PATH, caseId: "00000000-0000-4000-8000-000000000033" } });
    expect(res.isError).toBeFalsy();
    const outcome = JSON.parse(textOf(res as never)) as { apiId: string; passed: boolean };
    expect(outcome.apiId).toBe("00000000-0000-4000-8000-000000000032");
    expect(outcome.passed).toBe(true);
    await client.close();
  });

  it("run-case 用例不存在 → isError 且文案含 用例不存在", async () => {
    const { client } = await connectClient(rootA, { allowRun: true });
    const res = await client.callTool({ name: "run-case", arguments: { apiPath: OK_PATH, caseId: "ghost" } });
    expect(res.isError).toBe(true);
    expect(textOf(res as never)).toContain("用例不存在");
    await client.close();
  });

  it("run-case 非 base scope 用例显式报错（run-case 未选环境，env 链不含该 scope，不静默空跑）", async () => {
    const { client } = await connectClient(rootA, { allowRun: true });
    const res = await client.callTool({ name: "run-case", arguments: { apiPath: OK_PATH, caseId: "00000000-0000-4000-8000-000000000016" } });
    expect(res.isError).toBe(true);
    expect(textOf(res as never)).toContain("scope");
    await client.close();
  });

  it.each(["environment-first", "base-first"] as const)("run-case selects the exact base case when a same-id environment version is %s", async (order) => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "apicc-mcp-base-selection-"));
    tempRoots.push(fixtureRoot);
    const { workspace } = await fileStorage.load(rootA);
    const targetApi = workspace.groups[0]!.projects[0]!.collections[0]!.apis.find((candidate) => candidate.contract.id === OK_API)!;
    const baseCase = targetApi.cases.find((candidate) => candidate.id === OK_CASE)!;
    const environmentCase = { ...baseCase, name: "dev-version", scope: "dev" };
    targetApi.cases = order === "environment-first" ? [environmentCase, baseCase] : [baseCase, environmentCase];
    const initial = await fileStorage.load(fixtureRoot);
    await fileStorage.save(fixtureRoot, workspace, { expectedRevision: initial.revision, deletions: [] });

    const mcp = createMcpServer(fixtureRoot, { allowRun: true, log: () => {} });
    const client = new Client({ name: "mcp-base-selection-test", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "run-case", arguments: { apiPath: OK_PATH, caseId: OK_CASE } });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(textOf(result as never))).toMatchObject({ caseId: OK_CASE, caseName: baseCase.name, passed: true });
    } finally {
      await client.close();
    }
  });

  it("run-case redacts a bound credential echoed by a collection script error", async () => {
    const marker = "synthetic-mcp-bound-bearer-error";
    const fixtureRoot = mkdtempSync(join(tmpdir(), "apicc-mcp-secret-error-"));
    tempRoots.push(fixtureRoot);
    const { workspace } = await fileStorage.load(rootA);
    const project = workspace.groups[0]!.projects[0]!;
    const collection = project.collections[0]!;
    const targetApi = collection.apis.find((candidate) => candidate.contract.id === OK_API)!;
    targetApi.contract.request.auth = { kind: "bearer", token: { id: "mcp-error-token", policy: "test-auto" } };
    collection.preOperations = [{
      id: "throw-bound-value",
      type: "script",
      content: `throw new Error(${JSON.stringify(marker)});`,
    }];
    const initial = await fileStorage.load(fixtureRoot);
    await fileStorage.save(fixtureRoot, workspace, { expectedRevision: initial.revision, deletions: [] });

    const secretStore: SecretStore = {
      async put() {},
      async resolve(_scope, ref) { expect(ref.id).toBe("mcp-error-token"); return marker; },
      async version() { return "version-mcp-error-token"; },
      async remove() {},
      async status() { return "available"; },
    };
    const hostLogs: string[] = [];
    const mcp = createMcpServer(fixtureRoot, {
      allowRun: true,
      registry: createDefaultRegistry(),
      secretStore,
      log: (line) => hostLogs.push(line),
    });
    const client = new Client({ name: "mcp-secret-error-test", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "run-case", arguments: { apiPath: OK_PATH, caseId: OK_CASE } });
      const text = textOf(result as never);
      expect(result.isError).toBe(true);
      expect(text).toContain("[REDACTED]");
      expect(text).not.toContain(marker);
      expect(hostLogs.join("\n")).not.toContain(marker);
    } finally {
      await client.close();
    }
  });

  it("run-case preserves credential host failure code/ref without native backend details", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "apicc-mcp-credential-failure-"));
    tempRoots.push(fixtureRoot);
    const { workspace } = await fileStorage.load(rootA);
    const project = workspace.groups[0]!.projects[0]!;
    const targetApi = project.collections[0]!.apis.find((candidate) => candidate.contract.id === OK_API)!;
    targetApi.contract.request.auth = { kind: "bearer", token: { id: "mcp-read-failure-ref", policy: "test-auto" } };
    const initial = await fileStorage.load(fixtureRoot);
    await fileStorage.save(fixtureRoot, workspace, { expectedRevision: initial.revision, deletions: [] });

    const secretStore: SecretStore = {
      async put() {},
      async resolve() { throw new Error("unexpected resolution"); },
      async version(_scope, ref) {
        const error = new CredentialError("CREDENTIAL_UNAVAILABLE", ref.id);
        error.cause = new Error("private-native-backend-detail");
        throw error;
      },
      async remove() {},
      async status() { return "available"; },
    };
    const mcp = createMcpServer(fixtureRoot, { allowRun: true, secretStore, log: () => {} });
    const client = new Client({ name: "mcp-credential-failure-test", version: "0.0.1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([mcp.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "run-case", arguments: { apiPath: OK_PATH, caseId: OK_CASE } });
      const text = textOf(result as never);
      expect(result.isError).toBe(true);
      expect(text).toContain("CREDENTIAL_UNAVAILABLE");
      expect(text).toContain("mcp-read-failure-ref");
      expect(text).not.toContain("private-native-backend-detail");
    } finally {
      await client.close();
    }
  });
});

describe("安全边界与日志通道", () => {
  it("explains an expired online report in the actual SDK error result", async () => {
    const f = await onlineFixture(); tempRoots.push(f.home); f.job.reportState = "expired";
    const source = await createMcpSource({ onlineProfile: "online-member", ...f.deps }); const mcp = createScopedMcpServer(source);
    const client = new Client({ name: "expired-report", version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([client.connect(a), mcp.connect(b)]);
    try {
      const listed = await client.callTool({ name: "list-runs", arguments: { projectId: "3" } }); const runId = sourceData(listed).items[0].runId;
      const result = await client.callTool({ name: "get-report", arguments: { runId } });
      expect(result.isError).toBe(true); expect(textOf(result as never)).toMatch(/report-expired|已到期/);
    } finally { await client.close(); await source.close(); }
  });
  it.each([
    ["none", /尚未归档/], ["pending", /尚未归档/], ["empty", /为空|损坏/], ["unowned", /报告归属/], ["cursor", /cursor.*失效/],
  ] as const)("explains the actual online %s read failure without raw data or secrets", async (state, expected) => {
    const f = await onlineFixture(); tempRoots.push(f.home);
    const source = await createMcpSource({ onlineProfile: "online-member", ...f.deps }); const mcp = createScopedMcpServer(source);
    const client = new Client({ name: "report-state", version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([client.connect(a), mcp.connect(b)]);
    try {
      const listed = await client.callTool({ name: "list-runs", arguments: { projectId: "3" } }); const runId = sourceData(listed).items[0].runId;
      if (state === "none" || state === "pending") f.job.reportState = state;
      if (state === "empty") f.emptyReport();
      if (state === "unowned") f.report.output.result.executionIdentity.definitionRevision = "other";
      const result = await client.callTool(state === "cursor" ? { name: "list-runs", arguments: { projectId: "3", cursor: "unissued" } } : { name: "get-report", arguments: { runId } });
      expect(result.isError).toBe(true); expect(textOf(result as never)).toMatch(expected); expect(textOf(result as never)).not.toContain("ONLINE_SYNTHETIC_MEMBER");
    } finally { await client.close(); await source.close(); }
  });
  // Removing safe URL projection must expose these synthetic credentials through the real SDK result.
  it("list-apis redacts URL user information and password query values before SDK output", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "apicc-mcp-url-redaction-"));
    tempRoots.push(fixtureRoot);
    const { workspace } = await fileStorage.load(rootA);
    const api = workspace.groups[0]!.projects[0]!.collections[0]!.apis[0]!;
    api.contract.request.baseUrl = "https://synthetic-user:synthetic-url-secret@example.test";
    api.contract.request.path = "/items?password=synthetic-query-secret&visible=yes";
    const initial = await fileStorage.load(fixtureRoot);
    await fileStorage.save(fixtureRoot, workspace, { expectedRevision: initial.revision, deletions: [] });
    const { client } = await connectClient(fixtureRoot, { log: () => {} });
    try {
      const result = await client.callTool({ name: "list-apis", arguments: {} });
      expect(result.isError).toBeFalsy();
      const output = textOf(result as never);
      expect(output).not.toContain("synthetic-user");
      expect(output).not.toContain("synthetic-url-secret");
      expect(output).not.toContain("synthetic-query-secret");
      expect(output).toContain("visible=yes");
    } finally { await client.close(); }
  });

  // Unbounded legacy serialization would return a success larger than the public output budget.
  it("list-apis refuses an over-budget legacy array with explicit pagination guidance", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "apicc-mcp-output-budget-"));
    tempRoots.push(fixtureRoot);
    const { workspace } = await fileStorage.load(rootA);
    workspace.groups[0]!.projects[0]!.collections[0]!.apis[0]!.contract.metadata.name = "x".repeat(140 * 1024);
    const initial = await fileStorage.load(fixtureRoot);
    await fileStorage.save(fixtureRoot, workspace, { expectedRevision: initial.revision, deletions: [] });
    const { client } = await connectClient(fixtureRoot, { log: () => {} });
    try {
      const result = await client.callTool({ name: "list-apis", arguments: {} });
      expect(result.isError).toBe(true);
      expect(textOf(result as never)).toMatch(/分页|paginat/i);
      expect(Buffer.byteLength(textOf(result as never))).toBeLessThanOrEqual(128 * 1024);
    } finally { await client.close(); }
  });

  it("工具只见 --workspace 指定的工作区：rootA 的服务器列不出 rootB 的接口", async () => {
    const { client } = await connectClient(rootA);
    const res = await client.callTool({ name: "list-apis", arguments: {} });
    const rows = JSON.parse(textOf(res as never)) as Array<Record<string, string>>;
    expect(rows.map((r) => r.id)).not.toContain("00000000-0000-4000-8000-000000000035");
    expect(rows.map((r) => r.apiPath)).not.toContain("groups/00000000-0000-4000-8000-000000000003/projects/00000000-0000-4000-8000-000000000005/collections/00000000-0000-4000-8000-000000000009/apis/00000000-0000-4000-8000-000000000035");
    await client.close();
    // 反向：rootB 服务器同样只见自己的接口。
    const { client: clientB } = await connectClient(rootB);
    const resB = await clientB.callTool({ name: "list-apis", arguments: {} });
    const rowsB = JSON.parse(textOf(resB as never)) as Array<Record<string, string>>;
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]!.id).toBe("00000000-0000-4000-8000-000000000035");
    await clientB.close();
  });

  it("默认日志走 stderr（console.error），不写 console.log；注入 log 时不经 console", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const lines: string[] = [];
    const { client } = await connectClient(rootA, { log: (l) => lines.push(l) });
    expect(lines.join("\n")).toContain(rootA);
    expect(errSpy).not.toHaveBeenCalled();
    await client.close();
    // 默认通道：省略 log 选项时走 console.error（stderr），绝不 console.log。
    const { client: client2 } = await connectClient(rootA);
    await client2.close();
    expect(errSpy).toHaveBeenCalled();
    expect(errSpy.mock.calls.some((args) => String(args[0]).includes(rootA))).toBe(true);
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("协议通道纯净：整轮 listTools/callTool 往返期间 console.log 零调用（裁定⑤内存对测口径）", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { client } = await connectClient(rootA, { allowRun: true, log: () => {} });
    await client.listTools();
    await client.callTool({ name: "list-apis", arguments: {} });
    await client.callTool({ name: "get-api-design", arguments: { apiPath: OK_PATH } });
    await client.callTool({ name: "run-case", arguments: { apiPath: OK_PATH, caseId: "00000000-0000-4000-8000-000000000015" } });
    expect(logSpy).not.toHaveBeenCalled();
    await client.close();
  });
});

describe("apicc mcp 命令注册", () => {
  it("handshakes and calls the built CLI over real SDK stdio with protocol-only stdout and safe stderr", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "apicc-mcp-stdio-source-")); tempRoots.push(fixtureRoot);
    const home = mkdtempSync(join(tmpdir(), "apicc-mcp-stdio-home-")); tempRoots.push(home);
    const { workspace } = await fileStorage.load(rootA); const request = workspace.groups[0]!.projects[0]!.collections[0]!.apis[0]!.contract.request;
    request.baseUrl = "https://stdio-user:STDIO_PRIVATE_PASSWORD@example.test"; request.path = "/items?password=STDIO_PRIVATE_QUERY&visible=yes";
    const initial = await fileStorage.load(fixtureRoot); await fileStorage.save(fixtureRoot, workspace, { expectedRevision: initial.revision, deletions: [] });
    const stdoutPath = join(home, "stdout-protocol.jsonl"); const exitPath = join(home, "exit.txt");
    const bin = new URL("../dist/bin.js", import.meta.url).href;
    // Test-only tee observes every actual stdout write while leaving SDK transport/protocol intact.
    const bootstrap = `import {appendFileSync,writeFileSync} from 'node:fs';
      const original=process.stdout.write.bind(process.stdout);
      process.stdout.write=function(chunk,encoding,callback){appendFileSync(${JSON.stringify(stdoutPath)},chunk);return original(chunk,encoding,callback);};
      process.on('exit',code=>writeFileSync(${JSON.stringify(exitPath)},String(code)));
      process.argv=['node','apicc','--no-plugins','mcp','--workspace',${JSON.stringify(fixtureRoot)}];
      await import(${JSON.stringify(bin)});`;
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--input-type=module", "-e", bootstrap], cwd: fixtureRoot, env: { HOME: home, USERPROFILE: home }, stderr: "pipe" });
    let stderr = ""; transport.stderr?.on("data", chunk => { stderr += String(chunk); });
    const client = new Client({ name: "real-stdio-evidence", version: "1" }); const errors: string[] = []; client.onerror = error => errors.push(error.message);
    try {
      await client.connect(transport);
      const tools = await client.listTools(); expect(tools.tools.map(tool => tool.name)).toContain("get-report"); expect(tools.tools.map(tool => tool.name)).not.toContain("run-case");
      const result = await client.callTool({ name: "list-apis", arguments: {} }); expect(result.isError).toBeFalsy(); expect(textOf(result as never)).toContain("visible=yes");
      const design = await client.callTool({ name: "get-api-design", arguments: { apiPath: OK_PATH } }); expect(design.isError).toBeFalsy(); expect(textOf(design as never)).toContain("Contract ID:");
      const assets = await client.callTool({ name: "list-assets", arguments: { projectId: PROJECT_A, limit: 1 } });
      expect(assets.structuredContent).toMatchObject({ source: { kind: "local" }, revision: expect.any(String), completeness: { pageComplete: false }, limitations: expect.any(Array) });
      expect(sourceData(assets).items[0].assetId).toBe(`api:${OK_API}`); expect(textOf(assets as never)).toContain("资产");
      expect(Buffer.byteLength(JSON.stringify(assets))).toBeLessThanOrEqual(131072);
    } finally { await client.close(); }
    const stdout = readFileSync(stdoutPath, "utf8"); const lines = stdout.trim().split(/\r?\n/);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const line of lines) expect(JSONRPCMessageSchema.safeParse(JSON.parse(line)).success).toBe(true);
    expect(errors).toEqual([]); expect(readFileSync(exitPath, "utf8")).toBe("0");
    expect(stdout + stderr).not.toContain("STDIO_PRIVATE_PASSWORD"); expect(stdout + stderr).not.toContain("STDIO_PRIVATE_QUERY"); expect(stdout + stderr).not.toContain("stdio-user");
    console.error(`MCP stdio evidence: protocolLines=${lines.length}; childExit=0; parserErrors=${errors.length}; stderrBytes=${Buffer.byteLength(stderr)}; secrets=absent`);
  }, 15000);
  it("resolves an explicit online member profile before connecting protocol stdin", async () => {
    const home = mkdtempSync(join(tmpdir(), "apicc-mcp-launch-profile-")); tempRoots.push(home);
    await expect(runCli(["mcp", "--online-profile", "missing"], createDefaultRegistry(), () => {}, { mcpHomeDir: home, loadPlugins: false })).rejects.toThrow(/profile.*不存在/);
  });
  it("--workspace 缺失：commander 前置拒绝（usage 错误走 stderr，不进入连接流程）", async () => {
    // commander 对缺 required option 走 error()+process.exit（vitest 对 exit 打桩使其抛错），
    // 故断言「拒绝发生 + usage 文案落 stderr」，不钉 vitest 特定的 exit 桩错误文案。
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(runCli(["mcp"], createDefaultRegistry(), () => {})).rejects.toThrow();
    expect(writeSpy.mock.calls.some((args) => String(args[0]).includes("--workspace"))).toBe(true);
  });

  it("--workspace 指向非工作区目录：连接前 fail-fast 报错（不吞进 stdio 静默）", async () => {
    const missing = join(tempRoots[0]!, "does-not-exist");
    await expect(runCli(["mcp", "--workspace", missing], createDefaultRegistry(), () => {}))
      .rejects.toThrow(/未找到 apicc\.workspace\.yaml/);
  });
});

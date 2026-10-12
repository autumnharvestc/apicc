import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CredentialError,
  createDefaultRegistry,
  createProjectSnapshot,
  fileStorage,
  renderContractMarkdown,
  type Workspace,
} from "@apicc/core";
import { createMcpServer } from "../src/mcp/server.js";
import { runCli } from "../src/main.js";

// 本文件覆盖 M6-B 任务 1：apicc mcp——stdio MCP 服务器（裁定②：SDK InMemoryTransport
// client+server 内存对测为主，stdio spawn e2e 免做）与只读工具集 + opt-in run-case。
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
        id: PROJECT_A, name: "svc", variables: {}, globals: {}, components: [], models: [], workflows: [], environments: [],
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
        id: "00000000-0000-4000-8000-000000000005", name: "bee", variables: {}, globals: {}, components: [], models: [], workflows: [], environments: [], stressPolicy: {},
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
    expect(tools.tools.map((t) => t.name)).toEqual(["list-apis", "get-api-design"]);
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

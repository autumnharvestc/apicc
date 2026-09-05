import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createDefaultRegistry,
  fileStorage,
  renderDesignMarkdown,
  type Workspace,
} from "@apicc/core";
import { createMcpServer } from "../src/mcp/server.js";
import { runCli } from "../src/main.js";

// 本文件覆盖 M6-B 任务 1：apicc mcp——stdio MCP 服务器（裁定②：SDK InMemoryTransport
// client+server 内存对测为主，stdio spawn e2e 免做）与只读工具集 + opt-in run-case。
// 安全红线：工具只暴露 --workspace 指定的工作区；工具无文件系统路径类参数（apiPath 仅是
// 与既有 CLI 同口径的工作区相对定位符，只与内存树匹配，不落任何 FS 访问）。

const OK_PATH = "groups/demo/projects/svc/collections/api/apis/ok";
const DEEP_PATH = "groups/demo/projects/svc/collections/api/folders/sub/apis/deep";

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
    id: "wa", name: "mcp-a", variables: {},
    groups: [{
      id: "g1", name: "demo", projects: [{
        id: "p1", name: "svc", variables: { baseUrl }, workflows: [], environments: [],
        collections: [{
          id: "c1", name: "api", variables: {},
          folders: [{
            id: "f1", name: "sub", apis: [{
              id: "a-deep", name: "deep", version: "1", deprecated: false, method: "POST",
              url: "{{baseUrl}}/deep", headers: [], query: [],
              body: { kind: "json", content: "{\"n\":1}" },
              cases: [{ id: "tdeep", name: "deep-ok", scope: "base", parameters: {}, assertions: [] }],
            }],
          }],
          apis: [
            {
              id: "a-ok", name: "ok", version: "1", deprecated: false, method: "GET",
              url: "{{baseUrl}}/x", headers: [], query: [],
              design: "ok 接口的业务规则说明（design.md 正文）。",
              cases: [
                { id: "t1", name: "passes", scope: "base", parameters: {}, assertions: [
                  { id: "as1", target: "status", op: "eq", expected: "200" },
                  { id: "as2", target: "bodyJson", path: "$.ok", op: "eq", expected: "true" },
                ] },
                { id: "t2", name: "dev-only", scope: "dev", parameters: {}, assertions: [] },
              ],
            },
            {
              id: "a-xok", name: "xok", version: "1", deprecated: false, method: "GET",
              url: "{{baseUrl}}/y", headers: [], query: [],
              cases: [{ id: "tx", name: "x-passes", scope: "base", parameters: {}, assertions: [] }],
            },
          ],
        }],
      }],
    }],
  };
  await fileStorage.save(rootA, wsA);

  // 工作区 B：不同接口——钉住「工具只暴露 --workspace 指定的工作区」。
  rootB = mkdtempSync(join(tmpdir(), "apicc-mcp-b-"));
  tempRoots.push(rootB);
  const wsB: Workspace = {
    id: "wb", name: "mcp-b", variables: {},
    groups: [{
      id: "g2", name: "other", projects: [{
        id: "p2", name: "bee", variables: {}, workflows: [], environments: [],
        collections: [{
          id: "c2", name: "col", variables: {}, folders: [],
          apis: [{
            id: "a-bee", name: "bee", version: "1", deprecated: false, method: "GET",
            url: "http://bee.example", headers: [], query: [],
            cases: [{ id: "tb", name: "bee-passes", scope: "base", parameters: {}, assertions: [] }],
          }],
        }],
      }],
    }],
  };
  await fileStorage.save(rootB, wsB);
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
    expect(byId.get("a-ok")).toMatchObject({ name: "ok", protocol: "http", url: "{{baseUrl}}/x", apiPath: OK_PATH });
    // folder 内接口在列，apiPath 含 folders 段。
    expect(byId.get("a-deep")).toMatchObject({ name: "deep", protocol: "http", url: "{{baseUrl}}/deep", apiPath: DEEP_PATH });
    expect(byId.get("a-xok")).toMatchObject({ name: "xok", url: "{{baseUrl}}/y" });
    await client.close();
  });

  it("get-api-design 按 apiPath 全路径定位，返回 renderDesignMarkdown 产物（含 design.md 正文）", async () => {
    const { client } = await connectClient(rootA);
    const res = await client.callTool({ name: "get-api-design", arguments: { apiPath: OK_PATH } });
    expect(res.isError).toBeFalsy();
    // 期望值取自同一工作区加载产物（fileStorage 会把 design.md 读回 api.design）。
    const { workspace } = await fileStorage.load(rootA);
    const api = workspace.groups[0]!.projects[0]!.collections[0]!.apis.find((a) => a.id === "a-ok")!;
    expect(textOf(res as never)).toBe(renderDesignMarkdown(api));
    await client.close();
  });

  it("get-api-design 分隔符边界后缀匹配（与 run-stress/run 同口径）：apis/ok 命中 ok 而非 xok", async () => {
    const { client } = await connectClient(rootA);
    const res = await client.callTool({ name: "get-api-design", arguments: { apiPath: "collections/api/apis/ok" } });
    expect(res.isError).toBeFalsy();
    const text = textOf(res as never);
    expect(text).toContain("# 接口详细设计：ok\n");
    expect(text).not.toContain("xok");
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
    const res = await client.callTool({ name: "run-case", arguments: { apiPath: OK_PATH, caseId: "t1" } });
    expect(res.isError).toBe(true);
    expect(textOf(res as never)).toContain("Tool run-case not found");
    await client.close();
  });

  it("--allow-run 开启：run-case 注册并可执行，返回 CaseOutcome 摘要（passed/assertions/error）", async () => {
    const { client } = await connectClient(rootA, { allowRun: true });
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("run-case");
    const res = await client.callTool({ name: "run-case", arguments: { apiPath: OK_PATH, caseId: "t1" } });
    expect(res.isError).toBeFalsy();
    const outcome = JSON.parse(textOf(res as never)) as {
      apiId: string; caseId: string; passed: boolean; error?: string;
      assertions: Array<{ pass: boolean }>;
    };
    expect(outcome.apiId).toBe("a-ok");
    expect(outcome.caseId).toBe("t1");
    expect(outcome.passed).toBe(true);
    expect(outcome.error).toBeUndefined();
    expect(outcome.assertions).toHaveLength(2);
    expect(outcome.assertions.every((a) => a.pass)).toBe(true);
    await client.close();
  });

  it("run-case 执行 folder 内接口用例（本地 http 夹具真实往返）", async () => {
    const { client } = await connectClient(rootA, { allowRun: true });
    const res = await client.callTool({ name: "run-case", arguments: { apiPath: DEEP_PATH, caseId: "tdeep" } });
    expect(res.isError).toBeFalsy();
    const outcome = JSON.parse(textOf(res as never)) as { apiId: string; passed: boolean };
    expect(outcome.apiId).toBe("a-deep");
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
    const res = await client.callTool({ name: "run-case", arguments: { apiPath: OK_PATH, caseId: "t2" } });
    expect(res.isError).toBe(true);
    expect(textOf(res as never)).toContain("scope");
    await client.close();
  });
});

describe("安全边界与日志通道", () => {
  it("工具只见 --workspace 指定的工作区：rootA 的服务器列不出 rootB 的接口", async () => {
    const { client } = await connectClient(rootA);
    const res = await client.callTool({ name: "list-apis", arguments: {} });
    const rows = JSON.parse(textOf(res as never)) as Array<Record<string, string>>;
    expect(rows.map((r) => r.id)).not.toContain("a-bee");
    expect(rows.map((r) => r.apiPath)).not.toContain("groups/other/projects/bee/collections/col/apis/bee");
    await client.close();
    // 反向：rootB 服务器同样只见自己的接口。
    const { client: clientB } = await connectClient(rootB);
    const resB = await clientB.callTool({ name: "list-apis", arguments: {} });
    const rowsB = JSON.parse(textOf(resB as never)) as Array<Record<string, string>>;
    expect(rowsB).toHaveLength(1);
    expect(rowsB[0]!.id).toBe("a-bee");
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
    await client.callTool({ name: "run-case", arguments: { apiPath: OK_PATH, caseId: "t1" } });
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

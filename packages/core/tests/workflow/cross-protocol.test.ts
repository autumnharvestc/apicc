import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { WorkflowRunner } from "../../src/workflow/runner.js";
import type { Workflow } from "../../src/workflow/model.js";
import type { Workspace, Project, ApiDefinition } from "../../src/domain/model.js";
import { createDefaultRegistry } from "../../src/index.js";

/**
 * 终审 Important 3 补钉（计划任务 3 步骤 1.3 原口径）：WorkflowRunner 双节点——
 * WS 节点首帧（JSON）经后置脚本提取变量 → 条件边 → HTTP 节点经 prev/vars 引用。
 * 协议字段随 workflowToRunResult 的整体 api 携带进 CollectionRunner（不可能丢失），
 * 本测试钉住该口径。
 */
describe("WorkflowRunner 跨协议（WS → 条件边 → HTTP）", () => {
  let httpServer: Server;
  let httpBaseUrl = "";
  let wss: WebSocketServer;
  let wssUrl = "";
  let seenAuth: string | undefined;

  beforeAll(async () => {
    httpServer = createServer((req, res) => {
      seenAuth = req.headers.authorization;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ auth: seenAuth ?? "" }));
    });
    await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
    httpBaseUrl = `http://127.0.0.1:${(httpServer.address() as { port: number }).port}`;
    wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((r) => wss.on("listening", r));
    const addr = wss.address() as { port: number };
    wssUrl = `ws://127.0.0.1:${addr.port}/rt`;
    wss.on("connection", (socket: WsSocket) => {
      socket.on("message", (data) => {
        socket.send(JSON.stringify({ token: `tk-${JSON.parse(data.toString()).user}` }));
        socket.close(1000);
      });
    });
  });
  afterAll(async () => {
    await new Promise<void>((r) => wss.close(() => r()));
    await new Promise<void>((r) => httpServer.close(() => r()));
  });

  it("WS 节点提取 token → 条件边 → HTTP 节点引用 carried 变量", async () => {
    // 夹具在服务端就绪后构造（模块顶层求值会把空串快照进 env.variables——runner.test.ts 先例）。
    const ws: Workspace = { id: "w", name: "w", variables: {}, groups: [] };
    const project: Project = {
      id: "p", name: "p", variables: {},
      environments: [{ id: "e", name: "dev", variables: { wsUrl: wssUrl, httpUrl: httpBaseUrl } }],
      collections: [], workflows: [],
    };
    const wsApi: ApiDefinition = {
      id: "n-ws", name: "n-ws", version: "1", deprecated: false, method: "GET",
      protocol: "websocket", url: "{{wsUrl}}", message: '{"user":"m5"}', headers: [], query: [],
      cases: [{
        id: "case-ws", name: "ws-用例", scope: "base", parameters: {}, assertions: [],
        postScript: 'pm.variables.set("token", JSON.parse(pm.response.text()).token);',
      }],
    };
    const httpApi: ApiDefinition = {
      id: "n-http", name: "n-http", version: "1", deprecated: false, method: "GET",
      url: "{{httpUrl}}/who", headers: [{ key: "authorization", value: "{{token}}", enabled: true }], query: [],
      cases: [{
        id: "case-http", name: "http-用例", scope: "base", parameters: {},
        assertions: [{ id: "as-http", target: "bodyJson", op: "eq", expected: "tk-m5", path: "auth" }],
      }],
    };
    const workflow: Workflow = {
      id: "wf", name: "跨协议流", status: "enabled",
      nodes: [
        { id: "s", kind: "request", apiId: "n-ws", caseId: "case-ws", label: "ws" },
        { id: "h", kind: "request", apiId: "n-http", caseId: "case-http", label: "http" },
      ],
      edges: [{ id: "e1", from: "s", to: "h", condition: "prev.passed" }],
    };
    const result = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve: (id) => (id === "n-ws" ? wsApi : httpApi), envName: "dev", failFast: false })
      .run(workflow, { project, workspace: ws });
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
    expect(seenAuth).toBe("tk-m5");
  });
});

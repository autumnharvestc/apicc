import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { CollectionRunner, createDefaultRegistry, createEventBus } from "../../src/index.js";
import type { Collection, Environment, Project, Workspace } from "../../src/domain/model.js";

/**
 * M5 D9：工作流跨协议变量携带——WS 节点首帧（JSON）经后置脚本提取变量，
 * 后续 HTTP 节点引用该变量（bearer 头）——多协议混合链路照常工作。
 */
describe("跨协议变量携带（WS → HTTP）", () => {
  let httpServer: Server;
  let httpBaseUrl = "";
  let wss: WebSocketServer;
  let wssUrl = "";
  /** http 服务端视角：收到的 authorization 头。 */
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
        const msg = JSON.parse(data.toString());
        socket.send(JSON.stringify({ token: `Bearer ${msg.user}` }));
        socket.close(1000);
      });
    });
  });
  afterAll(async () => {
    await new Promise<void>((r) => wss.close(() => r()));
    await new Promise<void>((r) => httpServer.close(() => r()));
  });

  it("WS 首帧经后置脚本提取变量，HTTP 节点以 {{token}} 引用", async () => {
    // 夹具在服务端就绪后的测试体内构造（模块顶层求值会把空串快照进 env.variables——runner.test.ts 先例注释）。
    const ws: Workspace = { id: "w", name: "w", variables: {}, globals: { variables: {}, query: [], headers: [] }, groups: [] };
    const env: Environment = { id: "e", name: "dev", variables: { wsUrl: wssUrl, httpUrl: httpBaseUrl }, baseUrls: {} };
    const project: Project = { id: "p", name: "p", variables: {}, environments: [env], collections: [], workflows: [] };
    const collection: Collection = {
      id: "c", name: "mixed", variables: {}, folders: [],
      apis: [
        {
          id: "ws-login", name: "ws-login", version: "1", deprecated: false, method: "GET",
          protocol: "websocket", url: "{{wsUrl}}", message: '{"user":"m5"}',
          headers: [], query: [],
          cases: [{
            id: "t-ws", name: "ws-用例", scope: "base", parameters: {},
            assertions: [{ id: "as-ws", target: "bodyJson", op: "eq", expected: "Bearer m5", path: "token" }],
            postScript: 'pm.variables.set("token", JSON.parse(pm.response.text()).token);',
          }],
        },
        {
          id: "http-who", name: "http-who", version: "1", deprecated: false, method: "GET",
          url: "{{httpUrl}}/who", headers: [{ key: "authorization", value: "{{token}}", enabled: true }], query: [],
          cases: [{
            id: "t-http", name: "http-用例", scope: "base", parameters: {},
            assertions: [{ id: "as-http", target: "bodyJson", op: "eq", expected: "Bearer m5", path: "auth" }],
          }],
        },
      ],
    };

    const runner = new CollectionRunner({
      registry: createDefaultRegistry(), bus: createEventBus(),
      timeouts: { connectTimeoutMs: 2000, totalTimeoutMs: 4000 }, failFast: false,
    });
    const result = await runner.run(collection, env, project, ws, {});
    expect(result.failed).toBe(0);
    expect(result.passed).toBe(2);
    expect(seenAuth).toBe("Bearer m5");
  });
});

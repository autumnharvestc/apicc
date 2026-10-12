import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import { createEventBus } from "../../src/events/bus.js";
import { createDefaultRegistry } from "../../src/index.js";
import { CollectionRunner as SnapshotCollectionRunner } from "../../src/runner/runner.js";
import type { ApiAsset } from "../../src/contract/model.js";
import { createContractExecutionProject, contractExecutionIds } from "../helpers/contractExecutionFixtures.js";

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
    const uuid = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const api = (id: string, name: string, request: ApiAsset["contract"]["request"], cases: ApiAsset["cases"]): ApiAsset => ({
      contract: {
        formatVersion: 1,
        id,
        metadata: { name, description: "", tags: [], version: "1", status: "draft" },
        request,
        responses: [],
      },
      cases,
      documentation: "",
    });
    const empty = { pathParams: [], query: [], cookies: [] };
    const wsAsset = api(uuid(11), "ws-login", {
      protocol: "websocket", baseUrl: "{{wsUrl}}", path: "/rt", ...empty, headers: [],
      auth: { kind: "none" }, message: '{"user":"m5"}',
    }, [{
      id: "t-ws", name: "ws-用例", scope: "base", parameters: {}, preOperations: [],
      postOperations: [{ id: "extract-token", type: "script", content: 'pm.variables.set("token", JSON.parse(pm.response.text()).token);' }],
      assertions: [{ id: "as-ws", target: "bodyJson", op: "eq", expected: "Bearer m5", path: "token" }],
    }]);
    const httpAsset = api(uuid(12), "http-who", {
      protocol: "http", method: "GET", baseUrl: "{{httpUrl}}", path: "/who",
      ...empty, query: [],
      headers: [{ kind: "inline", id: uuid(13), name: "authorization", schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "", value: "{{token}}" }],
      auth: { kind: "none" }, body: { kind: "none" },
    }, [{
      id: "t-http", name: "http-用例", scope: "base", parameters: {}, preOperations: [], postOperations: [],
      assertions: [{ id: "as-http", target: "bodyJson", op: "eq", expected: "Bearer m5", path: "auth" }],
    }]);
    const project = createContractExecutionProject(httpBaseUrl);
    project.variables = { wsUrl: wssUrl, httpUrl: httpBaseUrl };
    project.environments[0]!.baseUrls = {};
    const collection = project.collections[0]!;
    collection.folders = [];
    collection.apis = [wsAsset, httpAsset];
    const run = {
      snapshot: createProjectSnapshot(project),
      credentialBindings: { resolve: () => { throw new Error("no credential expected"); }, versions: {} },
    };

    const runner = new SnapshotCollectionRunner({
      registry: createDefaultRegistry(), bus: createEventBus(),
      timeouts: { connectTimeoutMs: 2000, totalTimeoutMs: 4000 }, failFast: false,
    });
    const result = await runner.run(run, contractExecutionIds.collection);
    expect(result.failed).toBe(0);
    expect(result.passed).toBe(2);
    expect(seenAuth).toBe("Bearer m5");
  });
});

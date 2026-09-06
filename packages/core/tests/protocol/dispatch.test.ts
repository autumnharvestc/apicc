import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { createDefaultRegistry, CollectionRunner, createEventBus } from "../../src/index.js";
import { httpClient } from "../../src/http/client.js";
import { soapClient } from "../../src/protocol/soap.js";
import { wsClient } from "../../src/protocol/websocket.js";
import { canHandleProtocol, protocolOf, resolveProtocolClient } from "../../src/protocol/index.js";
import type { Collection, Environment, Project, Workspace } from "../../src/domain/model.js";
import type { ExecutableRequest } from "../../src/plugin/types.js";

const opts = { connectTimeoutMs: 2000, totalTimeoutMs: 3000 };

describe("协议显式分发（M5 D5）", () => {
  it("canHandle 按 protocol 显式匹配：ws 请求不再由 http 客户端承接", () => {
    const wsReq: ExecutableRequest = { method: "GET", url: "ws://x", headers: {}, query: [], protocol: "websocket" };
    const httpReq: ExecutableRequest = { method: "GET", url: "http://x", headers: {}, query: [], protocol: "http" };
    const legacyReq: ExecutableRequest = { method: "GET", url: "http://x", headers: {}, query: [] };

    expect(wsClient.canHandle(wsReq)).toBe(true);
    expect(httpClient.canHandle(wsReq)).toBe(false);
    expect(httpClient.canHandle(httpReq)).toBe(true);
    expect(wsClient.canHandle(httpReq)).toBe(false);
    // 旧形状（无 protocol 字段）按 http 处理——零破坏口径。
    expect(protocolOf(legacyReq)).toBe("http");
    expect(httpClient.canHandle(legacyReq)).toBe(true);
    expect(wsClient.canHandle(legacyReq)).toBe(false);
  });

  it("createDefaultRegistry 注册 wsClient：websocket 请求由其承接", () => {
    const registry = createDefaultRegistry();
    const client = registry.getProtocol({ method: "GET", url: "ws://x", headers: {}, query: [], protocol: "websocket" });
    expect(client).toBe(wsClient);
    const legacy = registry.getProtocol({ method: "GET", url: "http://x", headers: {}, query: [] });
    expect(legacy?.name).toBe("http");
  });

  it("canHandle 按 protocol 显式匹配：soap 请求由 soapClient 承接、http 客户端不再接", () => {
    const soapReq: ExecutableRequest = { method: "POST", url: "http://x", headers: {}, query: [], protocol: "soap", envelope: "<e/>" };
    expect(soapClient.canHandle(soapReq)).toBe(true);
    expect(httpClient.canHandle(soapReq)).toBe(false);
    expect(wsClient.canHandle(soapReq)).toBe(false);
    // 旧形状 http 请求不受影响（回归口径）。
    expect(soapClient.canHandle({ method: "POST", url: "http://x", headers: {}, query: [] })).toBe(false);
  });

  it("createDefaultRegistry 注册 soapClient：soap 请求由其承接（resolveProtocolClient 命中）", () => {
    const registry = createDefaultRegistry();
    const soapReq: ExecutableRequest = { method: "POST", url: "http://x", headers: {}, query: [], protocol: "soap", envelope: "<e/>" };
    expect(registry.getProtocol(soapReq)).toBe(soapClient);
    expect(resolveProtocolClient(registry, soapReq)).toBe(soapClient);
  });

  it("未知协议 → 明确错误（fail-fast）", () => {
    const registry = createDefaultRegistry();
    const grpcReq = { method: "GET", url: "grpc://x", headers: {}, query: [], protocol: "grpc" } as unknown as ExecutableRequest;
    expect(() => resolveProtocolClient(registry, grpcReq)).toThrow(/grpc/);
  });

  it("resolveProtocolClient 命中注册客户端", () => {
    const registry = createDefaultRegistry();
    const client = resolveProtocolClient(registry, { method: "GET", url: "ws://x", headers: {}, query: [], protocol: "websocket" });
    expect(client).toBe(wsClient);
  });

  it("canHandleProtocol/protocolOf 助手口径", () => {
    expect(canHandleProtocol({ protocol: "soap" } as ExecutableRequest, "soap")).toBe(true);
    expect(canHandleProtocol({ protocol: "soap" } as ExecutableRequest, "http")).toBe(false);
    expect(canHandleProtocol({} as ExecutableRequest, "http")).toBe(true);
  });
});

describe("runner 分发与 message 变量解析（M5 D5+D7）", () => {
  let wss: WebSocketServer;
  let wsUrl = "";
  const frames: string[] = [];

  beforeAll(async () => {
    wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    wss.on("connection", (socket: WsSocket) => {
      socket.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        if (!isBinary) {
          frames.push(data.toString());
          socket.send(`echo:${data.toString()}`);
        }
      });
    });
    await new Promise<void>((r) => wss.once("listening", r));
    const addr = wss.address() as { address: string; port: number };
    wsUrl = `ws://${addr.address}:${addr.port}`;
  });
  afterAll(() => new Promise<void>((r) => {
    for (const c of wss.clients) c.terminate();
    wss.close(() => r());
  }));

  it("CollectionRunner：ws 接口走 wsClient，message 模板经变量解析，首帧经 pm.response.text()", async () => {
    const env: Environment = { id: "e1", name: "dev", variables: { who: "m5" }, baseUrls: {} };
    const project: Project = { id: "p1", name: "p", variables: {}, environments: [env], collections: [], workflows: [] };
    const workspace: Workspace = { id: "w1", name: "ws", variables: {}, globals: { variables: {}, query: [], headers: [] }, groups: [] };
    const collection: Collection = {
      id: "c1", name: "c", variables: {}, folders: [],
      apis: [{
        id: "a1", name: "ws-echo", version: "1", deprecated: false,
        method: "GET", protocol: "websocket", url: wsUrl,
        message: "hi-{{who}}",
        headers: [], query: [], cases: [{
          id: "t1", name: "echo", scope: "base", parameters: {}, assertions: [],
          postScript: 'pm.assert(pm.response.text() === "echo:hi-m5", "首帧应为回显内容");',
        }],
      }],
    };

    const runner = new CollectionRunner({
      registry: createDefaultRegistry(), bus: createEventBus(),
      timeouts: opts, failFast: false,
    });
    const result = await runner.run(collection, env, project, workspace, {});
    expect(result.failed).toBe(0);
    expect(result.passed).toBe(1);
    expect(frames[0]).toBe("hi-m5");
  });
});

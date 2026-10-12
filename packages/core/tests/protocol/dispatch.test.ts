import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { createDefaultRegistry, CollectionRunner, createEventBus } from "../../src/index.js";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import type { ContractProject } from "../../src/contract/workspace.js";
import { httpClient } from "../../src/http/client.js";
import { soapClient } from "../../src/protocol/soap.js";
import { wsClient } from "../../src/protocol/websocket.js";
import { canHandleProtocol, protocolOf, resolveProtocolClient } from "../../src/protocol/index.js";
import type { ProjectExecutionRun } from "../../src/runner/runner.js";
import type { ExecutableRequest } from "../../src/plugin/types.js";

const opts = { connectTimeoutMs: 2000, totalTimeoutMs: 3000 };

describe("协议显式分发（M5 D5）", () => {
  it("严格协议执行请求拒绝缺失 protocol 的旧形状", () => {
    const registry = createDefaultRegistry();
    const request = { method: "GET", url: "http://127.0.0.1/", headers: {}, query: [] } as unknown as ExecutableRequest;

    expect(() => protocolOf(request)).toThrow(/protocol/i);
    expect(() => resolveProtocolClient(registry, request)).toThrow(/protocol/i);
    expect(httpClient.canHandle(request)).toBe(false);
  });

  it("canHandle 按 protocol 显式匹配：ws 请求不再由 http 客户端承接", () => {
    const wsReq: ExecutableRequest = { protocol: "websocket", url: "ws://x", headers: {}, query: [], auth: { kind: "none" } };
    const httpReq: ExecutableRequest = { protocol: "http", method: "GET", url: "http://x", headers: {}, query: [], auth: { kind: "none" } };
    const legacyReq = { method: "GET", url: "http://x", headers: {}, query: [], auth: { kind: "none" } } as unknown as ExecutableRequest;

    expect(wsClient.canHandle(wsReq)).toBe(true);
    expect(httpClient.canHandle(wsReq)).toBe(false);
    expect(httpClient.canHandle(httpReq)).toBe(true);
    expect(wsClient.canHandle(httpReq)).toBe(false);
    // 旧形状（无 protocol 字段）不再隐式映射到 HTTP。
    expect(() => protocolOf(legacyReq)).toThrow(/protocol/i);
    expect(httpClient.canHandle(legacyReq)).toBe(false);
    expect(wsClient.canHandle(legacyReq)).toBe(false);
  });

  it("createDefaultRegistry 注册 wsClient：websocket 请求由其承接", () => {
    const registry = createDefaultRegistry();
    const client = registry.getProtocol({ protocol: "websocket", url: "ws://x", headers: {}, query: [], auth: { kind: "none" } });
    expect(client).toBe(wsClient);
    const legacy = { method: "GET", url: "http://x", headers: {}, query: [], auth: { kind: "none" } } as unknown as ExecutableRequest;
    expect(registry.getProtocol(legacy)).toBeUndefined();
  });

  it("canHandle 按 protocol 显式匹配：soap 请求由 soapClient 承接、http 客户端不再接", () => {
    const soapReq: ExecutableRequest = { protocol: "soap", method: "POST", url: "http://x", headers: {}, query: [], auth: { kind: "none" }, envelope: "<e/>" };
    expect(soapClient.canHandle(soapReq)).toBe(true);
    expect(httpClient.canHandle(soapReq)).toBe(false);
    expect(wsClient.canHandle(soapReq)).toBe(false);
    // 旧形状 http 请求不受影响（回归口径）。
    expect(soapClient.canHandle({ protocol: "http", method: "POST", url: "http://x", headers: {}, query: [], auth: { kind: "none" } })).toBe(false);
  });

  it("createDefaultRegistry 注册 soapClient：soap 请求由其承接（resolveProtocolClient 命中）", () => {
    const registry = createDefaultRegistry();
    const soapReq: ExecutableRequest = { protocol: "soap", method: "POST", url: "http://x", headers: {}, query: [], auth: { kind: "none" }, envelope: "<e/>" };
    expect(registry.getProtocol(soapReq)).toBe(soapClient);
    expect(resolveProtocolClient(registry, soapReq)).toBe(soapClient);
  });

  it("未知协议 → 明确错误（fail-fast）", () => {
    const registry = createDefaultRegistry();
    const grpcReq = { method: "GET", url: "grpc://x", headers: {}, query: [], auth: { kind: "none" }, protocol: "grpc" } as unknown as ExecutableRequest;
    expect(() => resolveProtocolClient(registry, grpcReq)).toThrow(/protocol/i);
  });

  it("resolveProtocolClient 命中注册客户端", () => {
    const registry = createDefaultRegistry();
    const client = resolveProtocolClient(registry, { protocol: "websocket", url: "ws://x", headers: {}, query: [], auth: { kind: "none" } });
    expect(client).toBe(wsClient);
  });

  it("canHandleProtocol/protocolOf 助手口径", () => {
    expect(canHandleProtocol({ protocol: "soap" } as ExecutableRequest, "soap")).toBe(true);
    expect(canHandleProtocol({ protocol: "soap" } as ExecutableRequest, "http")).toBe(false);
    expect(canHandleProtocol({} as ExecutableRequest, "http")).toBe(false);
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
    const project: ContractProject = {
      id: "10000000-0000-4000-8000-000000000010", name: "p", variables: {},
      globals: { query: [], headers: [], cookies: [], body: [] },
      environments: [{ id: "10000000-0000-4000-8000-000000000011", name: "dev", variables: { who: "m5" }, baseUrls: {} }],
      collections: [{
        id: "10000000-0000-4000-8000-000000000012", name: "c", variables: {}, preOperations: [], postOperations: [], folders: [],
        apis: [{
          contract: {
            formatVersion: 1, id: "10000000-0000-4000-8000-000000000013",
            metadata: { name: "ws-echo", description: "", tags: [], version: "1", status: "draft" },
            request: {
              protocol: "websocket", baseUrl: wsUrl, path: "/", pathParams: [], query: [], headers: [], cookies: [],
              auth: { kind: "none" }, message: "hi-{{who}}",
            },
            responses: [],
          },
          cases: [{
            id: "t1", name: "echo", scope: "base", parameters: {}, preOperations: [],
            postOperations: [{ id: "check-response", type: "script", content: 'pm.assert(pm.response.text() === "echo:hi-m5", "首帧应为回显内容");' }],
            assertions: [],
          }],
          documentation: "",
        }],
      }],
      workflows: [], stressPolicy: { trustedOrigins: [], deniedOrigins: [] }, models: [], components: [],
    };
    const snapshot = createProjectSnapshot(project);
    const run: ProjectExecutionRun = {
      snapshot,
      credentialBindings: { resolve() { throw new Error("none auth must not resolve credentials"); }, versions: Object.freeze({}) },
    };

    const runner = new CollectionRunner({
      registry: createDefaultRegistry(), bus: createEventBus(),
      timeouts: opts, failFast: false,
    });
    const result = await runner.run(run, "10000000-0000-4000-8000-000000000012", { environmentId: "10000000-0000-4000-8000-000000000011" });
    expect(result.failed).toBe(0);
    expect(result.passed).toBe(1);
    expect(frames[0]).toBe("hi-m5");
  });
});

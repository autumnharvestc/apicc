import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createNetServer, type Server as NetServer, type Socket as NetSocket } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { wsClient } from "../../src/protocol/websocket.js";
import type { ExecutableRequest } from "../../src/plugin/types.js";

/**
 * 本地 ws server 夹具（风格对照 tests/http/client.test.ts 的 http server 夹具）：
 * behavior 控制连接后动作（回显/发二进制再发文本/即断），
 * connections 记录服务端视角的收帧与关闭事件；
 * 另设两个裸 server：404 拒绝 upgrade 的 http server 与不响应 upgrade 的 TCP server。
 */
const behavior = {
  echo: false as boolean,
  binaryThenText: false as boolean,
  closeImmediately: false as boolean,
};
const received: Array<{ socket: WsSocket; text: string }> = [];
const closed: Array<{ code: number }> = [];
let wss: WebSocketServer;
let wsUrl = "";
let reject404: HttpServer;
let reject404Url = "";
let hangingTcp: NetServer;
let hangingTcpUrl = "";
const trackedSockets = new Set<NetSocket>();

function resetFixture() {
  behavior.echo = false;
  behavior.binaryThenText = false;
  behavior.closeImmediately = false;
  received.length = 0;
  closed.length = 0;
}

beforeAll(async () => {
  wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  wss.on("connection", (socket: WsSocket) => {
    socket.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (isBinary) return;
      const text = data.toString();
      received.push({ socket, text });
      if (behavior.echo) socket.send(`echo:${text}`);
      if (behavior.binaryThenText) {
        socket.send(Buffer.from([0, 1, 2])); // 先二进制
        socket.send("after-binary"); // 再文本
      }
    });
    socket.on("close", (code: number) => closed.push({ code }));
    if (behavior.closeImmediately) socket.close(1011, "server-closed");
  });
  await new Promise<void>((r) => wss.once("listening", r));
  const addr = wss.address() as { address: string; port: number };
  wsUrl = `ws://${addr.address}:${addr.port}`;

  // upgrade 一律回 404 的裸 http server：握手拒绝（非 101）路径夹具。
  reject404 = createHttpServer((_req, res) => res.writeHead(404).end());
  reject404.on("upgrade", (_req, socket) => {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
  });
  await new Promise<void>((r) => reject404.listen(0, "127.0.0.1", r));
  const httpAddr = reject404.address() as { address: string; port: number };
  reject404Url = `ws://${httpAddr.address}:${httpAddr.port}/gone`;

  // 接受 TCP 连接但不响应 upgrade 的裸 server：拖住 CONNECTING 态以覆盖总超时先于建连路径。
  // 连接套接字显式登记，afterAll 统一销毁——否则半开连接令 server.close() 悬挂。
  hangingTcp = createNetServer((socket) => {
    trackedSockets.add(socket);
    socket.on("close", () => trackedSockets.delete(socket));
  });
  await new Promise<void>((r) => hangingTcp.listen(0, "127.0.0.1", r));
  const netAddr = hangingTcp.address() as { address: string; port: number };
  hangingTcpUrl = `ws://${netAddr.address}:${netAddr.port}/hang`;
});
afterAll(() => new Promise<void>((r) => {
  for (const c of wss.clients) c.terminate(); // 清理沉默夹具留下的半开连接
  for (const s of trackedSockets) s.destroy();
  wss.close(() => reject404.close(() => hangingTcp.close(() => r())));
}));

const opts = { connectTimeoutMs: 2000, totalTimeoutMs: 3000 };

/** 夹具请求：headers 透传握手、message 为「已解析」文本（变量解析在 runner，D7）。 */
function wsReq(overrides: Partial<ExecutableRequest> = {}): ExecutableRequest {
  return { method: "GET", url: wsUrl, headers: {}, query: [], protocol: "websocket", ...overrides };
}

/** 轮询等待服务端记录满足条件（连接正常关闭是异步握手，不 pin 时序）。 */
async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor 超时");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("wsClient（M5 D3 响应映射）", () => {
  beforeEach(resetFixture);

  it("握手成功：status=101、headers=握手响应头、bodyText=首帧文本、timeMs≥0", async () => {
    behavior.echo = true;
    const res = await wsClient.execute(wsReq({ headers: { "x-probe": "m5" }, message: "ping" }), opts);
    expect(res.status).toBe(101);
    expect(res.headers["upgrade"]).toBe("websocket");
    expect(res.bodyText).toBe("echo:ping");
    expect(res.timeMs).toBeGreaterThanOrEqual(0);
    expect(received[0]?.text).toBe("ping");
  });

  it("带 message 模板：服务端收到帧内容（已解析文本原样发出）", async () => {
    behavior.echo = true;
    await wsClient.execute(wsReq({ message: "hello-{{name}}" }), opts);
    expect(received[0]?.text).toBe("hello-{{name}}");
  });

  it("不发送 message：仅连接即正常关闭（服务端见 close 1000），bodyText 为空且不等待", async () => {
    const res = await wsClient.execute(wsReq(), opts);
    expect(res.status).toBe(101);
    expect(res.bodyText).toBe("");
    expect(received).toHaveLength(0);
    await waitFor(() => closed.length > 0);
    expect(closed[0]?.code).toBe(1000);
  });

  it("总超时内未收到帧 → 执行错误（错误信息含 websocket），非悬挂", async () => {
    try {
      await wsClient.execute(wsReq({ message: "ping" }), { connectTimeoutMs: 500, totalTimeoutMs: 400 });
      expect.unreachable("应当抛错");
    } catch (e) {
      const err = e as Error & { kind?: string };
      expect(err.message).toContain("websocket");
      expect(err.kind).toBe("timeout");
    }
  });

  it("服务端 upgrade 回非 101（404）→ 执行错误（handshake），非崩溃非悬挂", async () => {
    try {
      await wsClient.execute(wsReq({ url: reject404Url, message: "ping" }), opts);
      expect.unreachable("应当抛错");
    } catch (e) {
      const err = e as Error & { kind?: string };
      expect(err.message).toContain("websocket");
      expect(err.message).toContain("404");
      expect(err.kind).toBe("handshake");
    }
  });

  it("总超时先于连接建立（服务端不响应 upgrade）→ 执行错误（timeout），非崩溃非悬挂", async () => {
    try {
      await wsClient.execute(wsReq({ url: hangingTcpUrl, message: "ping" }), { connectTimeoutMs: 5000, totalTimeoutMs: 400 });
      expect.unreachable("应当抛错");
    } catch (e) {
      const err = e as Error & { kind?: string };
      expect(err.message).toContain("websocket");
      expect(err.kind).toBe("timeout");
    }
  });

  it("非文本帧（二进制）→ 忽略并继续等待首个文本帧（裁定②口径钉住）", async () => {
    behavior.binaryThenText = true;
    const res = await wsClient.execute(wsReq({ message: "give-me-frames" }), opts);
    expect(res.bodyText).toBe("after-binary");
  });

  it("服务端拒绝（无 ws 服务的 http 端点 404 / 端口拒绝）→ 执行错误非悬挂", async () => {
    try {
      await wsClient.execute(wsReq({ url: "ws://127.0.0.1:1/refused" }), { connectTimeoutMs: 1000, totalTimeoutMs: 2000 });
      expect.unreachable("应当抛错");
    } catch (e) {
      const err = e as Error & { kind?: string };
      expect(err.message).toContain("websocket");
      expect(["refused", "unknown", "timeout"]).toContain(err.kind);
    }
  });

  it("URL 非 ws(s):// → 即时执行错误", async () => {
    try {
      await wsClient.execute(wsReq({ url: "http://127.0.0.1:1/not-ws" }), opts);
      expect.unreachable("应当抛错");
    } catch (e) {
      expect((e as Error).message).toContain("websocket");
    }
  });
});

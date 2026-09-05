import { WebSocket, type RawData } from "ws";
import { classifyNetworkError, type HttpErrorKind } from "../http/client.js";
import type { ExecutableRequest, ExecutionResponse, HttpExecuteOptions, ProtocolClient } from "../plugin/types.js";
import { canHandleProtocol } from "./index.js";

export type WebSocketErrorKind = HttpErrorKind | "handshake";

/** WS 执行错误：message 恒含 "websocket"（跨协议执行错误的统一识别口径，D3）。 */
export class WebSocketExecutionError extends Error {
  constructor(public kind: WebSocketErrorKind, detail: string, cause?: unknown) {
    super(`websocket 执行错误（${kind}）: ${detail}`, { cause });
    this.name = "WebSocketExecutionError";
  }
}

function handshakeHeaders(res: { headers: Record<string, string | string[] | undefined> }): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers)) {
    if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return headers;
}

/**
 * WebSocket 协议客户端（M5 D3/D4，`ws` 包实现）。
 *
 * 响应映射契约（D3）：status=握手 HTTP 状态（101 成功）、headers=握手响应头、
 * bodyText=连接后收到的首个文本帧（发送 message 后等待；未发送 message → 仅连接即
 * 正常关闭，bodyText 为空且不等待）、timeMs=连接+发送+接收总时长。
 *
 * 超时口径（对齐 httpClient）：连接超时=connectTimeoutMs（ws handshakeTimeout），
 * 连接+发送+收帧总时长受 totalTimeoutMs 约束，超限抛执行错误（fail-fast 不悬挂）。
 *
 * 二进制帧口径（裁定②，测试钉住）：忽略二进制帧继续等待首个文本帧；文本帧分片由
 * ws 库自行重组，到达 message 事件时已是完整消息。
 */
export const wsClient: ProtocolClient = {
  name: "websocket",
  canHandle: (req) => canHandleProtocol(req, "websocket"),
  async execute(req: ExecutableRequest, opts: HttpExecuteOptions): Promise<ExecutionResponse> {
    const started = performance.now();
    if (!/^wss?:\/\//i.test(req.url)) {
      throw new WebSocketExecutionError("unknown", `端点须为 ws:// 或 wss://，实际: ${req.url}`);
    }

    const handshake: { status: number; headers: Record<string, string> } = { status: 0, headers: {} };
    const ws = new WebSocket(req.url, {
      headers: req.headers,
      handshakeTimeout: opts.connectTimeoutMs,
    });

    return await new Promise<ExecutionResponse>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        fail(new WebSocketExecutionError("timeout", `${opts.totalTimeoutMs}ms 内未完成连接/发送/收帧`));
      }, Math.max(0, opts.totalTimeoutMs - (performance.now() - started)));

      // 成功路径优雅关闭（close 握手，不阻塞返回），失败路径立即断开；均不悬挂。
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.removeAllListeners();
          ws.terminate();
        } else if (ws.readyState === WebSocket.OPEN) {
          const grace = setTimeout(() => ws.terminate(), 500);
          ws.once("close", () => clearTimeout(grace));
          ws.close(1000); // 正常关闭：显式 1000（无参 close 发空 close 帧，对端见 1005）
        }
        fn();
      };
      const succeed = (bodyText: string) =>
        finish(() => resolve({ status: handshake.status, headers: handshake.headers, bodyText, timeMs: performance.now() - started }));
      const fail = (e: WebSocketExecutionError) => finish(() => reject(e));

      ws.on("upgrade", (res) => {
        handshake.status = res.statusCode ?? 0;
        handshake.headers = handshakeHeaders(res);
      });

      ws.on("open", () => {
        if (req.message === undefined) {
          succeed(""); // 缺省仅连接：正常关闭并立即返回空响应体
          return;
        }
        ws.send(req.message, (err) => {
          if (err) fail(new WebSocketExecutionError("unknown", `发送 message 失败: ${err.message}`, err));
        });
      });

      ws.on("message", (data: RawData, isBinary: boolean) => {
        if (req.message === undefined) return; // 未发送 message 不等待帧
        if (isBinary) return; // 裁定②：忽略二进制帧，继续等待首个文本帧
        succeed(data.toString());
      });

      ws.on("unexpected-response", (_request, res) => {
        fail(new WebSocketExecutionError("handshake", `握手被服务端拒绝（HTTP ${res.statusCode}）`));
      });

      ws.on("error", (e) => {
        fail(new WebSocketExecutionError(classifyNetworkError(e), (e as Error)?.message ?? String(e), e));
      });

      ws.on("close", (code) => {
        if (!settled) fail(new WebSocketExecutionError("unknown", `连接在完成交换前被关闭（close code ${code}）`));
      });
    });
  },
};

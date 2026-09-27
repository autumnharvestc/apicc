import { Agent, request } from "undici";
import type { BodyContent } from "../domain/model.js";
import type { ExecutableRequest, ExecutionResponse, HttpExecuteOptions, ProtocolClient } from "../plugin/types.js";
import { canHandleProtocol } from "../protocol/index.js";

export type HttpErrorKind = "dns" | "refused" | "timeout" | "tls" | "unknown";

export class HttpExecutionError extends Error {
  constructor(public kind: HttpErrorKind, cause: unknown) {
    super(`请求失败（${kind}）: ${(cause as Error)?.message ?? String(cause)}`, { cause });
  }
}

export function classifyNetworkError(e: unknown): HttpErrorKind {
  const err = e as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  const codes = [String(err.code ?? ""), String(err.cause?.code ?? "")];
  const msg = `${err.message ?? ""} ${err.cause?.message ?? ""}`;
  // 顶层与 cause 的 code 都扫描：undici 包装错误顶层恒为 UND_ERR_*，会遮蔽 cause 里更具体的 errno。
  const precise = codes.find((c) => ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(c) || c.includes("TIMEOUT"));
  if (precise === "ECONNREFUSED") return "refused";
  if (precise === "ENOTFOUND" || precise === "EAI_AGAIN") return "dns";
  if (precise) return "timeout";
  if (/ECONNREFUSED/.test(msg)) return "refused";
  if (/timed?\s?out|timeout/i.test(msg)) return "timeout";
  if (/TLS|CERT/i.test(codes.join(" ")) || /tls|certificate/i.test(msg)) return "tls";
  return "unknown";
}

export interface HttpClientOptions {
  connectionMode?: "pooled" | "fresh";
}

export interface ManagedProtocolClient extends ProtocolClient {
  close(): Promise<void>;
}

function buildUrl(req: ExecutableRequest): string {
  const qs = req.query
    .filter((kv) => kv.enabled && kv.key !== "")
    .map((kv) => `${encodeURIComponent(kv.key)}=${encodeURIComponent(kv.value)}`)
    .join("&");
  return qs ? `${req.url}${req.url.includes("?") ? "&" : "?"}${qs}` : req.url;
}

/** form 请求体的 enabled 项编码为 application/x-www-form-urlencoded。 */
function urlencodedBody(form: BodyContent["form"]): string {
  const params = new URLSearchParams();
  for (const kv of form ?? []) {
    if (kv.enabled) params.append(kv.key, kv.value);
  }
  return params.toString();
}

export function createHttpClient(options: HttpClientOptions = {}): ManagedProtocolClient {
  const connectionMode = options.connectionMode ?? "pooled";
  const agents = new Map<string, Agent>();

  function createAgent(opts: HttpExecuteOptions): Agent {
    return new Agent({
      connect: { timeout: opts.connectTimeoutMs },
      headersTimeout: opts.totalTimeoutMs,
      bodyTimeout: opts.totalTimeoutMs,
      connections: 1,
    });
  }

  return {
    name: "http",
    // D5：按 protocol 显式分发（缺省视为 http），URL 前缀仍作兜底约束——旧形状行为不变。
    canHandle: (req) => canHandleProtocol(req, "http") && (req.url.startsWith("http://") || req.url.startsWith("https://")),
    async execute(req, opts) {
      const started = performance.now();
      // form 走 urlencoded 编码；其余 kind 发送 content 字符串。
      let body: string | undefined;
      const sendHeaders = { ...req.headers };
      if (req.body?.kind === "form") {
        body = urlencodedBody(req.body.form);
        if (!Object.keys(sendHeaders).some((k) => k.toLowerCase() === "content-type")) {
          sendHeaders["content-type"] = "application/x-www-form-urlencoded";
        }
      } else if (req.body) {
        body = req.body.content;
      }
      try {
        const key = `${opts.connectTimeoutMs}:${opts.totalTimeoutMs}`;
        const agent = connectionMode === "pooled"
          ? (agents.get(key) ?? (() => {
            const created = createAgent(opts);
            agents.set(key, created);
            return created;
          })())
          : createAgent(opts);
        try {
          const res = await request(buildUrl(req), {
            method: req.method,
            headers: sendHeaders,
            body,
            dispatcher: agent,
            signal: opts.signal,
          });
          const bodyText = await res.body.text();
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) headers[k] = String(v);
          return { status: res.statusCode, headers, bodyText, timeMs: performance.now() - started };
        } finally {
          if (connectionMode === "fresh") await agent.close();
        }
      } catch (e) {
        throw new HttpExecutionError(classifyNetworkError(e), e);
      }
    },
    async close() {
      const active = [...agents.values()];
      agents.clear();
      await Promise.all(active.map((agent) => agent.close()));
    },
  };
}

export const httpClient = createHttpClient();

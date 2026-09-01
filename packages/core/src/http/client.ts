import { Agent, request } from "undici";
import type { ExecutableRequest, ExecutionResponse, HttpExecuteOptions, ProtocolClient } from "../plugin/types.js";

export type HttpErrorKind = "dns" | "refused" | "timeout" | "tls" | "unknown";

export class HttpExecutionError extends Error {
  constructor(public kind: HttpErrorKind, cause: unknown) {
    super(`请求失败（${kind}）: ${(cause as Error)?.message ?? String(cause)}`);
  }
}

export function classifyNetworkError(e: unknown): HttpErrorKind {
  const err = e as { code?: string; message?: string; cause?: { code?: string; message?: string } };
  const code = err.code ?? err.cause?.code ?? "";
  const msg = err.message ?? err.cause?.message ?? "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  if (code === "ECONNREFUSED") return "refused";
  if (code.includes("TIMEOUT") || /timed?\s?out|timeout/i.test(msg)) return "timeout";
  if (/TLS|CERT/i.test(code) || /tls|certificate/i.test(msg)) return "tls";
  return "unknown";
}

const defaultAgent = new Agent({
  connect: { timeout: 10_000 },
  headersTimeout: 30_000,
  bodyTimeout: 30_000,
});

function buildUrl(req: ExecutableRequest): string {
  const qs = req.query
    .filter((kv) => kv.enabled && kv.key !== "")
    .map((kv) => `${encodeURIComponent(kv.key)}=${encodeURIComponent(kv.value)}`)
    .join("&");
  return qs ? `${req.url}${req.url.includes("?") ? "&" : "?"}${qs}` : req.url;
}

export const httpClient: ProtocolClient & { close(): void } = {
  name: "http",
  canHandle: (req) => req.url.startsWith("http://") || req.url.startsWith("https://"),
  async execute(req, opts) {
    const started = performance.now();
    try {
      const agent = new Agent({
        connect: { timeout: opts.connectTimeoutMs },
        headersTimeout: opts.totalTimeoutMs,
        bodyTimeout: opts.totalTimeoutMs,
      });
      try {
        const res = await request(buildUrl(req), {
          method: req.method,
          headers: req.headers,
          body: req.body && req.body.kind !== "form" ? req.body.content : undefined,
          dispatcher: agent,
        });
        const bodyText = await res.body.text();
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) headers[k] = String(v);
        return { status: res.statusCode, headers, bodyText, timeMs: performance.now() - started };
      } finally {
        await agent.close();
      }
    } catch (e) {
      throw new HttpExecutionError(classifyNetworkError(e), e);
    }
  },
  async close() {
    await defaultAgent.close();
  },
};

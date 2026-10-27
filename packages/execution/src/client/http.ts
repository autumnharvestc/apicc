import { z } from "zod";
import { AgentMessageV1Schema, ControlBatchV1Schema, ControlExchangeSchema, MessageAcknowledgementSchema, type AgentControlTransport } from "../contract/index.js";
export type HttpClientOptions = { baseUrl: string; fetch: typeof fetch; token: () => string | Promise<string>; timeoutMs?: number };
export class ExecutionHttpError extends Error {
  constructor(public readonly status: number, public readonly code?: string) { super(`execution control request failed: HTTP ${status}`); this.name = "ExecutionHttpError"; }
}
/** No implicit retries: message identity and caller supervision determine whether a retry is safe. */
export function createAgentControlTransport(options: HttpClientOptions): AgentControlTransport {
  const base = new URL(options.baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("control service requires an HTTPS URL without embedded credentials, query or fragment");
  const timeoutMs = z.number().int().positive().max(2147483647).parse(options.timeoutMs ?? 45000);
  const post = async <T>(path: string, body: unknown, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> => {
    signal.throwIfAborted();
    const token = await options.token();
    if (!token || /[\r\n]/.test(token)) throw new Error("missing or invalid agent token");
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timeout = setTimeout(() => controller.abort(new Error("control request timeout")), timeoutMs);
    try {
      const response = await options.fetch(`${base.href.replace(/\/$/, "")}/${path}`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(body), signal: controller.signal, redirect: "error",
      });
      if (!response.ok) { let code: string | undefined; try { const body = await response.json(); if (typeof body?.code === 'string' && /^[a-z][a-z0-9_-]{0,95}$/.test(body.code)) code = body.code; } catch { /* No raw body or implicit retry crosses this boundary. */ } throw new ExecutionHttpError(response.status, code); }
      return schema.parse(await response.json());
    } finally { clearTimeout(timeout); signal.removeEventListener("abort", abort); }
  };
  return {
    async exchange(input, signal) { return post("runner/poll", ControlExchangeSchema.parse(input), ControlBatchV1Schema, signal); },
    async send(messages, signal) { return post("runner/messages", z.array(AgentMessageV1Schema).parse(messages), MessageAcknowledgementSchema, signal); },
  };
}

import { AgentMessageV1Schema, ControlExchangeSchema, MessageAcknowledgementSchema, TaskDeliveryV1Schema, AgentCommandV1Schema, validateAgentConfig, type AgentConfig, type AgentControlTransport, type ControlExchange, type ControlBatchV1 } from "@apicc/execution/contract";
import { ExecutionHttpError } from "@apicc/execution/client";
export interface LongPollingOptions { baseUrl: string; token: () => string | Promise<string>; fetch: typeof fetch; config: () => AgentConfig; onInvalidEntry?: (kind: "delivery" | "command", index: number, entry: unknown) => void }
export function createLongPollingTransport(options: LongPollingOptions): AgentControlTransport & { heartbeat(input: ControlExchange, signal: AbortSignal): ReturnType<AgentControlTransport["exchange"]> } {
  const base = new URL(options.baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("Control requires HTTPS without embedded credentials");
  const post = async (path: string, body: unknown, signal: AbortSignal): Promise<unknown> => {
    signal.throwIfAborted(); const config = validateAgentConfig(options.config());
    const token = await options.token(); if (!token || /[\r\n]/.test(token)) throw new Error("Missing control identity");
    const controller = new AbortController(); const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    const timer = setTimeout(() => controller.abort(new Error("Control request deadline")), config.controlRequestTimeoutMs);
    try {
      const response = await options.fetch(`${base.href.replace(/\/$/, "")}/${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: controller.signal, redirect: "error", cache: "no-store" });
      if (!response.ok) { let code: string | undefined; try { const body = await response.json(); if (typeof body?.code === 'string' && /^[a-z][a-z0-9_-]{0,95}$/.test(body.code)) code = body.code; } catch { /* Unknown errors retain retry/identity semantics. */ } throw new ExecutionHttpError(response.status, code); }
      return await response.json();
    } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
  };
  const batch = (raw: unknown): ControlBatchV1 => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => key !== "deliveries" && key !== "commands") || !("deliveries" in raw) || !("commands" in raw) || !Array.isArray(raw.deliveries) || !Array.isArray(raw.commands)) throw new Error("Invalid control batch envelope");
    const deliveries = raw.deliveries.flatMap((entry, index) => { const checked = TaskDeliveryV1Schema.safeParse(entry); if (!checked.success) { options.onInvalidEntry?.("delivery", index, entry); return []; } return [checked.data]; });
    const commands = raw.commands.flatMap((entry, index) => { const checked = AgentCommandV1Schema.safeParse(entry); if (!checked.success) { options.onInvalidEntry?.("command", index, entry); return []; } return [checked.data]; });
    return { deliveries, commands };
  };
  return { exchange: async (input, signal) => batch(await post("runner/poll", ControlExchangeSchema.parse(input), signal)), heartbeat: async (input, signal) => batch(await post("runner/heartbeat", ControlExchangeSchema.parse(input), signal)), send: async (messages, signal) => MessageAcknowledgementSchema.parse(await post("runner/messages", messages.map(message => AgentMessageV1Schema.parse(message)), signal)) };
}

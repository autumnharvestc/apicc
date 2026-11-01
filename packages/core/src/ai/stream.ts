import { AiInvocationError, type AiCallResult } from "./types.js";

export interface AiStreamAssembler { accept(value: any): void; finish(): AiCallResult }
export interface AiPayloadAccount { retain(bytes: number): void; release(bytes: number): void }
export interface AiReadLimits { maxStreamBytes: number; maxEventBytes: number; onBytes?(bytes: number): void }
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
export function throwIfAiAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof AiInvocationError ? signal.reason : new AiInvocationError("cancelled");
}

/** Error bodies are counted and discarded, never materialized as error details. */
export async function readAiBody(response: Response, limits: AiReadLimits, account: AiPayloadAccount, signal: AbortSignal, collect: boolean | number = true): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0, held = 0, text = "";
  let capturing = collect !== false;
  const captureLimit = typeof collect === "number" ? collect : Infinity;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      throwIfAiAborted(signal);
      const { done, value } = await reader.read();
      throwIfAiAborted(signal);
      if (done) break;
      total += value.byteLength;
      limits.onBytes?.(value.byteLength);
      if (total > limits.maxStreamBytes) throw new AiInvocationError("stream-limit");
      account.retain(value.byteLength); held += value.byteLength;
      if (capturing && total <= captureLimit) text += decoder.decode(value, { stream: true });
      else { capturing = false; text = ""; account.release(held); held = 0; }
    }
    return text + (capturing ? decoder.decode() : "");
  } finally { signal.removeEventListener("abort", cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); account.release(held); }
}

/** Keeps only the current SSE frame and the adapter's business text, never an event history. */
export async function readAiSse(response: Response, assembler: AiStreamAssembler, limits: AiReadLimits, account: AiPayloadAccount, signal: AbortSignal): Promise<AiCallResult> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "", data: string[] = [], frameBytes = 0, total = 0, held = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const line = (value: string, separator: string) => {
    frameBytes += bytes(value) + separator.length;
    if (frameBytes > limits.maxEventBytes) throw new AiInvocationError("event-limit");
    if (!value) {
      if (data.length) {
        const text = data.join("\n");
        let value: unknown;
        if (text === "[DONE]") value = text;
        else { try { value = JSON.parse(text); } catch { throw new AiInvocationError("response-invalid"); } }
        assembler.accept(value); data = [];
      }
      account.release(frameBytes); held -= frameBytes; frameBytes = 0;
    } else if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /, ""));
  };
  const drain = (final: boolean) => {
    for (;;) {
      const match = /\r\n|\r|\n/.exec(pending);
      if (!match || (!final && match[0] === "\r" && match.index === pending.length - 1)) break;
      line(pending.slice(0, match.index), match[0]); pending = pending.slice(match.index + match[0].length);
    }
    if (held > limits.maxEventBytes) throw new AiInvocationError("event-limit");
  };
  try {
    for (;;) {
      throwIfAiAborted(signal);
      const { done, value } = await reader.read();
      throwIfAiAborted(signal);
      if (done) break;
      total += value.byteLength;
      limits.onBytes?.(value.byteLength);
      if (total > limits.maxStreamBytes) throw new AiInvocationError("stream-limit");
      account.retain(value.byteLength); held += value.byteLength;
      pending += decoder.decode(value, { stream: true }); drain(false);
    }
    pending += decoder.decode(); drain(true);
    return assembler.finish();
  } finally { signal.removeEventListener("abort", cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); account.release(held); }
}

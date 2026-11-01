import { AiInvocationError, type AiAttemptInput, type AiCredentialResolver, type AiInvocationHost, type AiResolvedCredentials } from "./types.js";
import { aiCredentialAudience, AiConfigurationError, type AiApplicationProtection } from "./config.js";
import { chatCompletionsBody, chatCompletionsStream, parseChatCompletions } from "./protocols/chatCompletions.js";
import { responsesBody, responsesStream, parseResponses } from "./protocols/responses.js";
import { messagesBody, messagesStream, parseMessages } from "./protocols/messages.js";
import { readAiBody, readAiSse, throwIfAiAborted, type AiPayloadAccount } from "./stream.js";
import { validateAiInputBudget, type AiLocalTokenCounter } from "./budgets.js";
import { classifyNetworkError } from "../http/client.js";

export interface AiInvocationDependencies { credentials: AiCredentialResolver; fetch?: typeof fetch; localCounter?: AiLocalTokenCounter }

function snapshot<T>(value: T): T {
  const clone = structuredClone(value);
  const freeze = (item: unknown): void => { if (item && typeof item === "object") { Object.values(item).forEach(freeze); Object.freeze(item); } };
  freeze(clone); return clone;
}

/** The loser is observed and discarded; late fetch responses also have their body cancelled. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal, late?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(value => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) late?.(value); else resolve(value);
    }, error => { signal.removeEventListener("abort", abort); reject(signal.aborted ? signal.reason : error); });
  });
}

function retryDelay(value: string | null): number {
  let ms = 1000;
  if (value && /^\d+$/.test(value)) ms = Number(value) * 1000;
  else if (value && /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) {
    const parsed = Date.parse(value); if (Number.isFinite(parsed)) ms = Math.max(0, parsed - Date.now());
  }
  return ms;
}
async function delay(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await abortable(new Promise<void>(resolve => { timer = setTimeout(resolve, ms); }), signal); }
  finally { clearTimeout(timer); }
}

export interface AiAuxiliaryInput { connection: import("./config.js").AiConnection; protection: AiApplicationProtection; signal: AbortSignal; timeoutMs: number }
export interface AiAuxiliarySession { signal: AbortSignal; request(): Promise<string> }
export interface AiAuxiliaryHost extends AiInvocationHost { runAuxiliary<T>(input: AiAuxiliaryInput, work: (session: AiAuxiliarySession) => Promise<T>): Promise<T> }
export function createAiInvocationHost(deps: AiInvocationDependencies): AiAuxiliaryHost {
  let bufferedBytes = 0;
  const buffers = new Map<symbol, number>();
  const retryable = new WeakMap<AiInvocationError, number>();
  const active = new Map<symbol, AiApplicationProtection>();
  const queue: Array<{ owner: symbol; protection: AiApplicationProtection; start(): void }> = [];
  const concurrency = (protection: AiApplicationProtection) => Math.min(protection.hostConcurrency, ...Array.from(active.values(), p => p.hostConcurrency));
  const drain = () => {
    while (queue.length && active.size < concurrency(queue[0]!.protection)) queue.shift()!.start();
  };
  // One admission/account implementation for business operations and trusted auxiliary reads.
  async function admit(protection: AiApplicationProtection, signal: AbortSignal) {
    const owner = Symbol(); let retained = 0, open = true;
    const release = () => {
      if (!open) return; open = false; bufferedBytes -= retained; retained = 0;
      buffers.delete(owner); active.delete(owner);
      const position = queue.findIndex(item => item.owner === owner);
      if (position >= 0) queue.splice(position, 1); drain();
    };
    try {
      throwIfAiAborted(signal);
      await abortable(new Promise<void>((resolve, reject) => {
        const start = () => { active.set(owner, protection); buffers.set(owner, protection.hostPayloadBufferBytes); resolve(); };
        if (!queue.length && active.size < concurrency(protection)) start();
        else if (queue.length >= Math.min(protection.hostQueueSize, ...Array.from(active.values(), p => p.hostQueueSize))) reject(new AiInvocationError("queue-full"));
        else queue.push({ owner, protection, start });
      }), signal);
      throwIfAiAborted(signal);
      return { release, account: {
        retain(bytes: number) { throwIfAiAborted(signal); if (bufferedBytes + bytes > Math.min(...buffers.values())) throw new AiInvocationError("payload-limit"); retained += bytes; bufferedBytes += bytes; },
        release(bytes: number) { if (open) { retained -= bytes; bufferedBytes -= bytes; } },
      } };
    } catch (error) { release(); throw error; }
  }
  async function authenticate(connection: import("./config.js").AiConnection, signal: AbortSignal) {
    let auth: AiResolvedCredentials;
    try { auth = await abortable(deps.credentials.resolve(connection), signal); }
    catch { throwIfAiAborted(signal); throw new AiInvocationError("credentials"); }
    throwIfAiAborted(signal);
    const expectedHeader = connection.auth.kind === "bearer" ? "authorization" : connection.auth.kind === "api-key" ? connection.auth.header.toLowerCase() : undefined;
    const entries = Object.entries(auth.headers);
    if (auth.audience !== aiCredentialAudience(connection) || entries.length !== (expectedHeader ? 1 : 0) || entries.some(([name, value]) => name.toLowerCase() !== expectedHeader || !value.trim() || /[\r\n]/.test(value) || (connection.auth.kind === "bearer" && !/^Bearer \S+$/.test(value)))) throw new AiInvocationError("credentials");
    return auth;
  }
  return { async runAuxiliary(input, work) {
    const connection = snapshot(input.connection), protection = snapshot(input.protection);
    const abort = new AbortController();
    const cancel = () => abort.abort(new AiInvocationError("cancelled"));
    input.signal.addEventListener("abort", cancel, { once: true }); if (input.signal.aborted) cancel();
    const timer = setTimeout(() => abort.abort(new AiInvocationError("deadline")), Math.min(input.timeoutMs, protection.modelDiscoveryTimeoutMs));
    let lease: Awaited<ReturnType<typeof admit>> | undefined; let sent = false;
    try {
      lease = await admit(protection, abort.signal);
      return await abortable(work({ signal: abort.signal, async request() {
        throwIfAiAborted(abort.signal); if (sent) throw new AiInvocationError("request-budget"); sent = true;
        const auth = await authenticate(connection, abort.signal);
        const response = await abortable((deps.fetch ?? globalThis.fetch)(`${connection.baseUrl}/models`, { method: "GET", headers: { ...connection.headers, ...auth.headers }, redirect: "error", signal: abort.signal }), abort.signal, late => { void late.body?.cancel().catch(() => {}); });
        const text = await readAiBody(response, { maxStreamBytes: Math.min(protection.maxStreamBytes, protection.maxEventBytes), maxEventBytes: protection.maxEventBytes }, lease!.account, abort.signal, response.ok);
        if (!response.ok) throw new AiInvocationError("http", response.status);
        return text;
      } }), abort.signal);
    } finally { clearTimeout(timer); input.signal.removeEventListener("abort", cancel); abort.abort(new AiInvocationError("operation-ended")); lease?.release(); }
  }, async run(input, work) {
    const resolved = snapshot(input.resolved);
    const operation = new AbortController();
    const cancel = () => operation.abort(new AiInvocationError("cancelled"));
    input.signal.addEventListener("abort", cancel, { once: true });
    if (input.signal.aborted) cancel();
    const deadlineAt = Date.now() + resolved.budgets.deadlineMs;
    const deadlineTimer = setTimeout(() => operation.abort(new AiInvocationError("deadline")), resolved.budgets.deadlineMs);
    let lease: Awaited<ReturnType<typeof admit>> | undefined;
    let requests = 0, repairs = 0, retries = 0, reservedTokens = 0, invoking = false;
    let lastComplete = false;
    let streamBytes = 0;
    const observer = input.onProgress;
    const emit = (phase: "queued" | "request" | "receiving" | "retrying" | "completed") => {
      if (operation.signal.aborted) return;
      try { observer?.({ phase, attempt: requests, ...(phase === "receiving" ? { receivedBytes: streamBytes } : {}) }); } catch { /* Observers do not control the operation. */ }
    };
    const readLimits = { ...resolved.budgets, onBytes(bytes: number) {
      streamBytes += bytes;
      if (streamBytes > resolved.budgets.maxStreamBytes) throw new AiInvocationError("stream-limit");
      emit("receiving");
    } };
    const account: AiPayloadAccount = {
      retain(bytes) { lease!.account.retain(bytes); },
      release(bytes) { lease?.account.release(bytes); },
    };
    try {
      throwIfAiAborted(operation.signal);
      if (queue.length || active.size >= concurrency(resolved.protection)) emit("queued");
      lease = await admit(resolved.protection, operation.signal);
      throwIfAiAborted(operation.signal);
      return await abortable(work({ async invoke(attempt) {
        throwIfAiAborted(operation.signal);
        if (invoking) throw new AiInvocationError("attempt-in-progress");
        if (attempt.kind === "repair" && repairs >= resolved.budgets.repairAttempts) throw new AiInvocationError("repair-budget");
        if (attempt.kind === "repair" && !lastComplete) throw new AiInvocationError("repair-unavailable");
        if (attempt.kind === "repair") repairs++;
        lastComplete = false;
        invoking = true;
        try { for (;;) {
        const request = new AbortController();
        const abortRequest = () => request.abort(operation.signal.reason);
        operation.signal.addEventListener("abort", abortRequest, { once: true });
        const requestTimer = setTimeout(() => request.abort(new AiInvocationError("request-timeout")), resolved.budgets.requestTimeoutMs);
        try { const result = await abortable(send(attempt, request.signal), request.signal); lastComplete = true; return result; }
        catch (error) {
          throwIfAiAborted(operation.signal);
          if (!(error instanceof AiInvocationError) && !(error instanceof AiConfigurationError)) throw new AiInvocationError("response-invalid");
          if (!(error instanceof AiInvocationError) || !retryable.has(error) || retries >= resolved.budgets.transportRetries) throw error;
          const waitMs = retryable.get(error)!;
          if (waitMs >= deadlineAt - Date.now()) throw error;
          retries++;
          emit("retrying");
          await delay(waitMs, operation.signal);
        }
        finally { clearTimeout(requestTimer); operation.signal.removeEventListener("abort", abortRequest); }
        } } finally { invoking = false; }
      } }), operation.signal);
    } finally {
      clearTimeout(deadlineTimer); input.signal.removeEventListener("abort", cancel);
      operation.abort(new AiInvocationError("operation-ended"));
      lease?.release();
    }

    async function send(attempt: AiAttemptInput, signal: AbortSignal) {
      const protocol = resolved.model.protocol;
      if (protocol === "anthropic-messages" && resolved.model.structuredOutput === "json-object") throw new AiInvocationError("unsupported-structured-output");
      if (resolved.model.structuredOutput === "prompt-json") attempt = { ...attempt, messages: [...attempt.messages, { role: "system", content: `Return only JSON matching this schema: ${JSON.stringify(attempt.outputSchema)}` }] };
      const auth = await authenticate(resolved.connection, signal);
      const headers = { ...resolved.connection.headers, ...auth.headers, "content-type": "application/json",
        ...(protocol === "anthropic-messages" ? { "anthropic-version": "2023-06-01" } : {}) };
      const body = protocol === "openai-chat-completions" ? chatCompletionsBody(resolved, attempt) : protocol === "openai-responses" ? responsesBody(resolved, attempt) : messagesBody(resolved, attempt);
      const path = protocol === "openai-chat-completions" ? "chat/completions" : protocol === "openai-responses" ? "responses" : "messages";
      validateAiInputBudget(resolved, { messages: attempt.messages, outputSchema: attempt.outputSchema, instruction: attempt.messages.filter(m => m.role === "system").map(m => m.content).join("\n") }, deps.localCounter);
      if (requests >= resolved.budgets.maxRequests) throw new AiInvocationError("request-budget");
      if (reservedTokens + resolved.budgets.maxOutputTokens > resolved.budgets.totalOutputTokens) throw new AiInvocationError("token-budget");
      requests++; reservedTokens += resolved.budgets.maxOutputTokens;
      emit("request");
      throwIfAiAborted(signal);
      let response: Response;
      try { response = await abortable((deps.fetch ?? globalThis.fetch)(`${resolved.connection.baseUrl}/${path}`, { method: "POST", headers, body: JSON.stringify(body), redirect: "error", signal }), signal, late => { void late.body?.cancel().catch(() => {}); }); }
      catch (error) { throwIfAiAborted(signal); throw new AiInvocationError("network", undefined, undefined, classifyNetworkError(error)); }
      const rawId = response.headers.get("x-request-id") ?? response.headers.get("request-id");
      const requestId = rawId && /^[A-Za-z0-9_.:-]{1,128}$/.test(rawId) ? rawId : undefined;
      if (!response.ok) {
        const rawError = await readAiBody(response, readLimits, account, signal, resolved.budgets.maxEventBytes);
        const error = new AiInvocationError("http", response.status, requestId);
        let details: any;
        try { details = JSON.parse(rawError)?.error; } catch { /* Unknown errors are not retryable. */ }
        if ((response.status === 429 && (details?.code === "rate_limit_exceeded" || (details?.code === undefined && details?.type === "rate_limit_error"))) || (response.status === 529 && details?.type === "overloaded_error")) retryable.set(error, retryDelay(response.headers.get("retry-after")));
        throw error;
      }
      let outputBytes = 0;
      const onText = (text: string) => {
        if (typeof text !== "string") throw new AiInvocationError("response-invalid");
        const size = new TextEncoder().encode(text).byteLength;
        outputBytes += size;
        if (outputBytes > resolved.budgets.maxOutputBytes) throw new AiInvocationError("output-limit");
        account.retain(size);
      };
      if (resolved.model.streaming) {
        const assembler = protocol === "openai-chat-completions" ? chatCompletionsStream(onText) : protocol === "openai-responses" ? responsesStream(onText) : messagesStream(onText);
        const result = await readAiSse(response, assembler, readLimits, account, signal);
        if (!outputBytes) onText(result.text);
        else if (new TextEncoder().encode(result.text).byteLength > resolved.budgets.maxOutputBytes) throw new AiInvocationError("output-limit");
        settle(result.usage);
        emit("completed");
        return { ...result, requestId };
      }
      let value: unknown;
      const raw = await readAiBody(response, readLimits, account, signal);
      try { value = JSON.parse(raw); }
      catch { throw new AiInvocationError("response-invalid"); }
      const result = protocol === "openai-chat-completions" ? parseChatCompletions(value) : protocol === "openai-responses" ? parseResponses(value) : parseMessages(value);
      onText(result.text);
      settle(result.usage);
      emit("completed");
      return { ...result, requestId };
    }

    function settle(usage: { inputTokens?: number; outputTokens?: number } | undefined): void {
      for (const value of [usage?.inputTokens, usage?.outputTokens]) {
        if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new AiInvocationError("usage-invalid");
      }
      if (usage?.outputTokens !== undefined) {
        if (usage.outputTokens > resolved.budgets.maxOutputTokens) throw new AiInvocationError("usage-exceeded");
        reservedTokens -= resolved.budgets.maxOutputTokens - usage.outputTokens;
      }
    }
  } };
}

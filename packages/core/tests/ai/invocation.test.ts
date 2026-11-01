import { describe, expect, it, vi } from "vitest";
import { aiCredentialAudience } from "../../src/ai/config.js";
import { createAiInvocationHost } from "../../src/ai/invocation.js";
import { attempt, credentials, payload, resolved } from "./invocation.fixture.js";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const input = () => ({ resolved: resolved(), signal: new AbortController().signal });

describe("credential audience binding", () => {
  // Catch credentials surviving a changed connection ID, real API root, auth scheme or key header.
  it.each(["id", "address", "prefix", "auth-kind", "key-header"])("audience changes with %s", change => {
    const connection = resolved().connection;
    if (change === "key-header") connection.auth = { kind: "api-key", header: "X-Key-A" };
    const before = aiCredentialAudience(connection);
    if (change === "id") connection.id = "other";
    if (change === "address") connection.baseUrl = "https://other.example/v1";
    if (change === "prefix") connection.baseUrl += "/other";
    if (change === "auth-kind") connection.auth = { kind: "api-key", header: "x-api-key" };
    if (change === "key-header") connection.auth = { kind: "api-key", header: "x-key-b" };
    expect(aiCredentialAudience(connection)).not.toBe(before);
  });
  it("audience encoding is versioned, ignores rename/revision, and normalizes trailing slash/header case", () => {
    const connection = resolved().connection;
    expect(aiCredentialAudience(connection)).toBe('[1,"c","https://example.com/gateway/v1","bearer",""]');
    connection.name = "renamed"; connection.revision++;
    connection.baseUrl += "/";
    expect(aiCredentialAudience(connection)).toBe('[1,"c","https://example.com/gateway/v1","bearer",""]');
    connection.auth = { kind: "api-key", header: "X-API-Key" };
    expect(aiCredentialAudience(connection)).toBe('[1,"c","https://example.com/gateway/v1","api-key","x-api-key"]');
  });
  it.each(["audience", "extra-header", "wrong-header", "newline", "empty", "resolver-failure"])("rejects %s before sending and hides secret cause", async scenario => {
    let sent = 0;
    const config = resolved();
    const host = createAiInvocationHost({ credentials: { async resolve(connection) {
      if (scenario === "resolver-failure") throw new Error("private-secret");
      const auth = await credentials.resolve(connection);
      if (scenario === "audience") auth.audience = "old-connection";
      if (scenario === "extra-header") auth.headers["x-unrelated"] = "private-secret";
      if (scenario === "wrong-header") auth.headers = { "x-api-key": "private-secret" };
      if (scenario === "newline") auth.headers.authorization = "Bearer private-secret\r\nx: y";
      if (scenario === "empty") auth.headers = {};
      return auth;
    } }, fetch: async () => { sent++; return Response.json(payload("openai-chat-completions")); } });
    const error = await host.run({ resolved: config, signal: new AbortController().signal }, s => s.invoke(attempt)).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "credentials" });
    expect(String(error)).not.toContain("private-secret");
    expect((error as Error).cause).toBeUndefined();
    expect(sent).toBe(0);
  });
});

describe("confirmed transient retries share the operation", () => {
  // Catch blanket retries on 429/status/network, a fresh retry counter per invoke, or budget resets.
  const transient = () => new Response('{"error":{"type":"rate_limit_error","code":"rate_limit_exceeded","message":"private-secret"}}', { status: 429, headers: { "retry-after": "1" } });
  it("retries a confirmed Messages overloaded rejection", async () => {
    vi.useFakeTimers();
    try {
      let sent = 0;
      const host = createAiInvocationHost({ credentials, fetch: async () => ++sent === 1 ? Response.json({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, { status: 529 }) : Response.json(payload("anthropic-messages")) });
      const operation = host.run({ resolved: resolved("anthropic-messages"), signal: new AbortController().signal }, s => s.invoke(attempt)).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await operation).toMatchObject({ terminal: "completed" }); expect(sent).toBe(2);
    } finally { vi.useRealTimers(); }
  });
  it("retries only a confirmed temporary rate rejection and revalidates the complete input", async () => {
    vi.useFakeTimers();
    try {
      let sent = 0, validated = 0; const requests: string[] = [];
      const host = createAiInvocationHost({ credentials, localCounter: () => { validated++; return 100; }, fetch: async (_url, init) => { requests.push(String(init!.body)); return ++sent === 1 ? transient() : Response.json(payload("openai-chat-completions")); } });
      const operation = host.run(input(), s => s.invoke(attempt)).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(999); expect(sent).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(await operation).toMatchObject({ terminal: "completed" }); expect(sent).toBe(2); expect(validated).toBe(2);
      expect(requests[0]).toBe(requests[1]);
    } finally { vi.useRealTimers(); }
  });
  it("transport retry allowance is shared with a later repair", async () => {
    vi.useFakeTimers();
    try {
      let sent = 0;
      const host = createAiInvocationHost({ credentials, fetch: async () => ++sent === 2 ? Response.json(payload("openai-chat-completions")) : transient() });
      const operation = host.run(input(), async s => { await s.invoke(attempt); return s.invoke({ ...attempt, kind: "repair" }); }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await operation).toMatchObject({ code: "http", status: 429 }); expect(sent).toBe(3);
    } finally { vi.useRealTimers(); }
  });
  it("a retry consumes the actual-send budget before repair", async () => {
    vi.useFakeTimers();
    try {
      const config = resolved(); config.budgets.maxRequests = 2; let sent = 0;
      const host = createAiInvocationHost({ credentials, fetch: async () => ++sent === 1 ? transient() : Response.json(payload("openai-chat-completions")) });
      const operation = host.run({ resolved: config, signal: new AbortController().signal }, async s => { await s.invoke(attempt); return s.invoke({ ...attempt, kind: "repair" }); }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await operation).toMatchObject({ code: "request-budget" }); expect(sent).toBe(2);
    } finally { vi.useRealTimers(); }
  });
  it("a retry requires another full token reservation", async () => {
    vi.useFakeTimers();
    try {
      const config = resolved(); config.budgets.totalOutputTokens = 8192; let sent = 0;
      const host = createAiInvocationHost({ credentials, fetch: async () => { sent++; return transient(); } });
      const operation = host.run({ resolved: config, signal: new AbortController().signal }, s => s.invoke(attempt)).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await operation).toMatchObject({ code: "token-budget" }); expect(sent).toBe(1);
    } finally { vi.useRealTimers(); }
  });
  it.each([
    { status: 429, error: { type: "insufficient_quota", code: "insufficient_quota" } },
    { status: 429, error: { type: "unknown" } },
    { status: 401, error: { type: "authentication_error" } },
    { status: 400, error: { code: "invalid_request_error" } },
    { status: 503, error: { code: "unknown" } },
  ])("does not retry unconfirmed/permanent HTTP $status $error", async ({ status, error }) => {
    let sent = 0;
    const host = createAiInvocationHost({ credentials, fetch: async () => { sent++; return Response.json({ error }, { status }); } });
    await expect(host.run(input(), s => s.invoke(attempt))).rejects.toMatchObject({ code: "http", status }); expect(sent).toBe(1);
  });
  it.each(["long", "date", "invalid"])("Retry-After %s uses a bounded wait", async kind => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-30T10:00:00Z"));
      let sent = 0;
      const delay = kind === "long" ? 30000 : kind === "date" ? 2000 : 1000;
      const host = createAiInvocationHost({ credentials, fetch: async () => {
        if (++sent > 1) return Response.json(payload("openai-chat-completions"));
        const response = transient(); response.headers.set("retry-after", kind === "long" ? "999999999999999999999999999999999999" : kind === "date" ? "Fri, 30 Oct 2026 10:00:02 GMT" : "-1"); return response;
      } });
      const operation = host.run(input(), s => s.invoke(attempt)).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(delay - 1); expect(sent).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      if (kind === "long") { expect(await operation).toMatchObject({ code: "http", status: 429 }); expect(sent).toBe(1); }
      else { expect(await operation).toMatchObject({ terminal: "completed" }); expect(sent).toBe(2); }
    } finally { vi.useRealTimers(); }
  });
  it.each(["cancelled", "deadline"])("backoff cannot outlive operation %s", async code => {
    vi.useFakeTimers();
    try {
      const ctrl = new AbortController(); const config = resolved(); config.budgets.deadlineMs = 10000; let sent = 0;
      const host = createAiInvocationHost({ credentials, fetch: async () => { sent++; const response = transient(); response.headers.set("retry-after", code === "cancelled" ? "1" : "30"); return response; } });
      const operation = host.run({ resolved: config, signal: ctrl.signal }, s => s.invoke(attempt)).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(0);
      if (code === "cancelled") ctrl.abort();
      await vi.advanceTimersByTimeAsync(10000);
      expect(await operation).toMatchObject({ code: code === "deadline" ? "http" : code }); expect(sent).toBe(1);
    } finally { vi.useRealTimers(); }
  });

  // R12: catch shortening a valid server wait and using the original rather than remaining deadline.
  it.each(["seconds", "http-date"])("Retry-After 60s %s is respected in full when the operation can wait", async kind => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-30T10:00:00Z"));
      const config = resolved(); config.budgets.deadlineMs = 120000;
      let sent = 0;
      const host = createAiInvocationHost({ credentials, fetch: async () => {
        if (++sent > 1) return Response.json(payload("openai-chat-completions"));
        const response = transient(); response.headers.set("retry-after", kind === "seconds" ? "60" : "Fri, 30 Oct 2026 10:01:00 GMT"); return response;
      } });
      const operation = host.run({ resolved: config, signal: new AbortController().signal }, s => s.invoke(attempt)).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(59999); expect(sent).toBe(1);
      await vi.advanceTimersByTimeAsync(1); expect(await operation).toMatchObject({ terminal: "completed" }); expect(sent).toBe(2);
    } finally { vi.useRealTimers(); }
  });
  it.each([
    { name: "seconds beyond remaining deadline", header: "60", spent: 70000 },
    { name: "HTTP-date beyond remaining deadline", header: "Fri, 30 Oct 2026 10:02:10 GMT", spent: 70000 },
    { name: "huge finite seconds", header: "999999999999999999999999999999999999", spent: 0 },
    { name: "overflowing seconds", header: "9".repeat(400), spent: 0 },
  ])("Retry-After $name stops without sending an earlier retry", async ({ header, spent }) => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-30T10:00:00Z"));
      const config = resolved(); config.budgets.deadlineMs = 120000;
      let sent = 0;
      const host = createAiInvocationHost({ credentials, fetch: async () => {
        if (++sent > 1) return Response.json(payload("openai-chat-completions"));
        const response = transient(); response.headers.set("retry-after", header); return response;
      } });
      const operation = host.run({ resolved: config, signal: new AbortController().signal }, async s => { if (spent) await new Promise(resolve => setTimeout(resolve, spent)); return s.invoke(attempt); }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(spent);
      const outcome = await Promise.race([operation, Promise.resolve({ code: "still-waiting" })]);
      expect(outcome).toMatchObject({ code: "http", status: 429 });
      await vi.advanceTimersByTimeAsync(120000); expect(sent).toBe(1);
    } finally { vi.useRealTimers(); }
  });
});

describe("persistent operation budgets and immutable input", () => {
  // Catch resetting counters/reservations on invoke, zero-refunding unknown usage, or reading live config.
  it("three actual sends are shared by all calls in one run", async () => {
    const config = resolved(); config.budgets.totalOutputTokens = 81920;
    let sent = 0;
    const host = createAiInvocationHost({ credentials, fetch: async () => { sent++; return Response.json(payload("openai-chat-completions")); } });
    const result = await host.run({ resolved: config, signal: new AbortController().signal }, async s => {
      await s.invoke(attempt); await s.invoke(attempt); await s.invoke(attempt);
      return s.invoke(attempt);
    }).catch((e: unknown) => e);
    expect(result).toMatchObject({ code: "request-budget" }); expect(sent).toBe(3);
  });
  it("unknown usage keeps its entire output-token reservation", async () => {
    const config = resolved(); config.budgets.totalOutputTokens = 16384;
    let sent = 0;
    const value = payload("openai-chat-completions"); delete value.usage;
    const host = createAiInvocationHost({ credentials, fetch: async () => { sent++; return Response.json(value); } });
    const result = await host.run({ resolved: config, signal: new AbortController().signal }, async s => { const first = await s.invoke(attempt); expect(first.usage).toBeUndefined(); await s.invoke(attempt); return s.invoke(attempt); }).catch((e: unknown) => e);
    expect(result).toMatchObject({ code: "token-budget" }); expect(sent).toBe(2);
  });
  it("known output usage refunds only the unused reservation", async () => {
    const config = resolved(); config.budgets.totalOutputTokens = 8192;
    let sent = 0;
    const host = createAiInvocationHost({ credentials, fetch: async () => { sent++; return Response.json(payload("openai-chat-completions")); } });
    const result = await host.run({ resolved: config, signal: new AbortController().signal }, async s => { await s.invoke(attempt); return s.invoke(attempt); }).catch((e: unknown) => e);
    // 20 known tokens leave 8172, less than the next full 8192 reservation.
    expect(result).toMatchObject({ code: "token-budget" }); expect(sent).toBe(1);
  });
  it.each([-1, 1.5, "20", 9000])("rejects invalid or over-reservation output usage %s", async usage => {
    const value = payload("openai-chat-completions"); value.usage.completion_tokens = usage;
    const host = createAiInvocationHost({ credentials, fetch: async () => Response.json(value) });
    await expect(host.run(input(), s => s.invoke(attempt))).rejects.toMatchObject({ code: usage === 9000 ? "usage-exceeded" : "usage-invalid" });
  });
  it.each([-1, 0.5, "10", null])("rejects invalid input usage %s", async usage => {
    const value = payload("openai-chat-completions"); value.usage.prompt_tokens = usage;
    const host = createAiInvocationHost({ credentials, fetch: async () => Response.json(value) });
    await expect(host.run(input(), s => s.invoke(attempt))).rejects.toMatchObject({ code: "usage-invalid" });
  });
  it("uses an injected model-specific local counter before sending", async () => {
    let sent = 0;
    const host = createAiInvocationHost({ credentials, localCounter: () => 60000, fetch: async () => { sent++; return Response.json(payload("openai-chat-completions")); } });
    await expect(host.run(input(), s => s.invoke(attempt))).rejects.toMatchObject({ code: "budget-exceeded", field: "contextWindowTokens" });
    expect(sent).toBe(0);
  });
  it("repair count is shared across calls and cannot consume a second repair", async () => {
    let sent = 0;
    const host = createAiInvocationHost({ credentials, fetch: async () => { sent++; return Response.json(payload("openai-chat-completions")); } });
    const result = await host.run(input(), async s => { await s.invoke(attempt); await s.invoke({ ...attempt, kind: "repair" }); return s.invoke({ ...attempt, kind: "repair" }); }).catch((e: unknown) => e);
    expect(result).toMatchObject({ code: "repair-budget" }); expect(sent).toBe(2);
  });
  it("validates full repair history before its fetch", async () => {
    let sent = 0;
    const host = createAiInvocationHost({ credentials, fetch: async () => { sent++; return Response.json(payload("openai-chat-completions")); } });
    const result = await host.run(input(), async s => { await s.invoke(attempt); return s.invoke({ ...attempt, kind: "repair", messages: [...attempt.messages, { role: "assistant", content: "x".repeat(256 * 1024) }, { role: "user", content: "修复" }] }); }).catch((e: unknown) => e);
    expect(result).toMatchObject({ code: "budget-exceeded", field: "maxInputBytes" }); expect(sent).toBe(1);
  });
  it("system instructions consume the explicit instruction limit", async () => {
    let sent = 0;
    const host = createAiInvocationHost({ credentials, fetch: async () => { sent++; return Response.json(payload("openai-chat-completions")); } });
    await expect(host.run(input(), s => s.invoke({ ...attempt, messages: [{ role: "system", content: "x".repeat(8193) }] }))).rejects.toMatchObject({ code: "budget-exceeded", field: "maxInstructionBytes" });
    expect(sent).toBe(0);
  });
  it("run snapshots connection, protocol and model before waiting work", async () => {
    const config = resolved(); const gate = deferred<void>(); const ready = deferred<void>();
    const requests: Array<{ url: string; headers: Headers; body: any }> = [];
    const host = createAiInvocationHost({ credentials, fetch: async (url, init) => { requests.push({ url: String(url), headers: new Headers(init!.headers), body: JSON.parse(String(init!.body)) }); return Response.json(payload("openai-chat-completions")); } });
    const result = host.run({ resolved: config, signal: new AbortController().signal }, async s => { ready.resolve(); await gate.promise; return s.invoke(attempt); });
    await ready.promise;
    config.connection.baseUrl = "https://other.example/evil"; config.connection.auth = { kind: "api-key", header: "x-api-key" };
    config.model.protocol = "openai-responses"; config.model.modelId = "changed-model";
    gate.resolve(); await result;
    expect(requests[0]!.url).toBe("https://example.com/gateway/v1/chat/completions");
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer test-secret");
    expect(requests[0]!.body.model).toBe("real-a");
  });
  it("external mutations cannot expand an active operation budget", async () => {
    const config = resolved(); config.budgets.maxRequests = 1;
    let sent = 0;
    const host = createAiInvocationHost({ credentials, fetch: async () => { sent++; return Response.json(payload("openai-chat-completions")); } });
    const result = await host.run({ resolved: config, signal: new AbortController().signal }, async s => { await s.invoke(attempt); config.budgets.maxRequests = 10; config.budgets.totalOutputTokens = 81920; return s.invoke(attempt); }).catch((e: unknown) => e);
    expect(result).toMatchObject({ code: "request-budget" }); expect(sent).toBe(1);
  });
  it("concurrent invokes cannot bypass host request concurrency", async () => {
    const gate = deferred<Response>(); let sent = 0;
    const host = createAiInvocationHost({ credentials, fetch: async () => { sent++; return sent === 1 ? gate.promise : Response.json(payload("openai-chat-completions")); } });
    const result = await host.run(input(), async s => {
      const first = s.invoke(attempt); await Promise.resolve(); await Promise.resolve();
      const second = await s.invoke(attempt).catch((e: unknown) => e);
      gate.resolve(Response.json(payload("openai-chat-completions"))); await first; return second;
    });
    expect(result).toMatchObject({ code: "attempt-in-progress" }); expect(sent).toBe(1);
  });
  it.each(["address", "id", "auth"])("stale bound credentials are never sent after a connection %s change", async change => {
    const config = resolved(); const bound = await credentials.resolve(config.connection);
    if (change === "address") config.connection.baseUrl = "https://other.example/v1";
    if (change === "id") config.connection.id = "other";
    if (change === "auth") config.connection.auth = { kind: "api-key", header: "x-api-key" };
    let sent = 0;
    const host = createAiInvocationHost({ credentials: { async resolve() { return bound; } }, fetch: async () => { sent++; return Response.json(payload("openai-chat-completions")); } });
    await expect(host.run({ resolved: config, signal: new AbortController().signal }, s => s.invoke(attempt))).rejects.toMatchObject({ code: "credentials" });
    expect(sent).toBe(0);
  });
});

describe("one operation owns queue, cancellation and deadlines", () => {
  // Catch a host running work outside admission, resetting time after queue, or accepting late work.
  it("serializes work at default concurrency one", async () => {
    const gate = deferred<void>(), admitted = deferred<void>(); let entered = 0;
    const host = createAiInvocationHost({ credentials });
    const first = host.run(input(), async () => { entered++; admitted.resolve(); await gate.promise; return 1; });
    const second = host.run(input(), async () => { entered++; return 2; });
    await admitted.promise;
    expect(entered).toBe(1);
    gate.resolve();
    expect(await first).toBe(1); expect(await second).toBe(2);
  });
  it("allows eight queued operations and rejects the ninth", async () => {
    const gate = deferred<void>();
    const host = createAiInvocationHost({ credentials });
    const first = host.run(input(), async () => gate.promise);
    const queued = Array.from({ length: 8 }, (_, i) => host.run(input(), async () => i));
    const overflow = await host.run(input(), async () => "must not enter").catch((e: unknown) => e);
    gate.resolve(); await first;
    expect(overflow).toMatchObject({ code: "queue-full" });
    expect(await Promise.all(queued)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
  it("cancelled queued work never starts or resolves credentials", async () => {
    const gate = deferred<void>(); let entered = false;
    const host = createAiInvocationHost({ credentials });
    const first = host.run(input(), async () => gate.promise);
    const ctrl = new AbortController();
    const queued = host.run({ resolved: resolved(), signal: ctrl.signal }, async () => { entered = true; return 1; }).catch((e: unknown) => e);
    ctrl.abort("private-user-reason"); gate.resolve(); await first;
    expect(await queued).toMatchObject({ code: "cancelled" }); expect(entered).toBe(false);
  });
  it("pre-cancelled operations never send", async () => {
    const ctrl = new AbortController(); ctrl.abort(); let sent = 0;
    const host = createAiInvocationHost({ credentials, fetch: async () => { sent++; return Response.json(payload("openai-chat-completions")); } });
    await expect(host.run({ resolved: resolved(), signal: ctrl.signal }, s => s.invoke(attempt))).rejects.toMatchObject({ code: "cancelled" });
    expect(sent).toBe(0);
  });
  it("queue waiting consumes the total deadline", async () => {
    vi.useFakeTimers();
    try {
      const gate = deferred<void>(); let entered = false;
      const host = createAiInvocationHost({ credentials });
      const first = host.run(input(), async () => gate.promise);
      const config = resolved(); config.budgets.deadlineMs = 10000;
      const queued = host.run({ resolved: config, signal: new AbortController().signal }, async () => { entered = true; return 1; }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10000);
      gate.resolve(); await first;
      expect(await queued).toMatchObject({ code: "deadline" }); expect(entered).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it("cancellation during repair discards callback results and prevents later fetch", async () => {
    const gate = deferred<void>(); const ctrl = new AbortController(); let sent = 0;
    const host = createAiInvocationHost({ credentials, fetch: async () => { sent++; return Response.json(payload("openai-chat-completions")); } });
    const ready = deferred<void>();
    const operation = host.run({ resolved: resolved(), signal: ctrl.signal }, async s => {
      await s.invoke(attempt); ready.resolve(); await gate.promise;
      await s.invoke({ ...attempt, kind: "repair" }); return "late-candidate";
    }).catch((e: unknown) => e);
    await ready.promise; ctrl.abort(); gate.resolve();
    expect(await operation).toMatchObject({ code: "cancelled" });
    await Promise.resolve(); expect(sent).toBe(1);
  });
  it("late fetch results after single-request timeout are cancelled without resend", async () => {
    vi.useFakeTimers();
    try {
      const config = resolved(); config.budgets.requestTimeoutMs = 10000; config.budgets.deadlineMs = 20000;
      const late = deferred<Response>(); let sent = 0, bodyCancelled = false;
      const host = createAiInvocationHost({ credentials, fetch: async () => { sent++; return late.promise; } });
      const operation = host.run({ resolved: config, signal: new AbortController().signal }, s => s.invoke(attempt)).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10000);
      const outcome = await Promise.race([operation, Promise.resolve({ code: "still-running" })]);
      late.resolve(new Response(new ReadableStream({ cancel() { bodyCancelled = true; } })));
      await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toMatchObject({ code: "request-timeout" }); expect(sent).toBe(1); expect(bodyCancelled).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it.each(["streaming", "non-streaming"])("user cancellation interrupts %s body reads", async mode => {
    vi.useFakeTimers();
    try {
      const ctrl = new AbortController(); let cancelled = false;
      const host = createAiInvocationHost({ credentials, fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { "content-type": mode === "streaming" ? "text/event-stream" : "application/json" } }) });
      const operation = host.run({ resolved: resolved("openai-chat-completions", mode === "streaming"), signal: ctrl.signal }, s => s.invoke(attempt)).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(0); ctrl.abort("private-secret"); await vi.advanceTimersByTimeAsync(0);
      const outcome = await Promise.race([operation, Promise.resolve({ code: "still-reading" })]);
      expect(outcome).toMatchObject({ code: "cancelled" }); expect(cancelled).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it("the same total deadline covers time between initial and repair calls", async () => {
    vi.useFakeTimers();
    try {
      const config = resolved(); config.budgets.deadlineMs = 10000;
      const gate = deferred<void>(); let sent = 0;
      const host = createAiInvocationHost({ credentials, fetch: async () => { sent++; return Response.json(payload("openai-chat-completions")); } });
      const operation = host.run({ resolved: config, signal: new AbortController().signal }, async s => { await s.invoke(attempt); await gate.promise; return s.invoke({ ...attempt, kind: "repair" }); }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10000);
      const outcome = await Promise.race([operation, Promise.resolve({ code: "deadline-was-reset" })]);
      gate.resolve(); await vi.advanceTimersByTimeAsync(0);
      expect(outcome).toMatchObject({ code: "deadline" }); expect(sent).toBe(1);
    } finally { vi.useRealTimers(); }
  });
});

describe("safe response failures", () => {
  it("repair without any complete initial result never sends", async () => {
    let sent = 0;
    const host = createAiInvocationHost({ credentials, fetch: async () => { sent++; return Response.json(payload("openai-chat-completions")); } });
    await expect(host.run(input(), s => s.invoke({ ...attempt, kind: "repair" }))).rejects.toMatchObject({ code: "repair-unavailable" });
    expect(sent).toBe(0);
  });
  it("a later truncated call revokes repair eligibility from an earlier success", async () => {
    let sent = 0;
    const host = createAiInvocationHost({ credentials, fetch: async () => { const value = payload("openai-chat-completions"); if (++sent > 1) value.choices[0].finish_reason = "length"; return Response.json(value); } });
    const result = await host.run(input(), async s => { await s.invoke(attempt); await s.invoke(attempt).catch(() => {}); return s.invoke({ ...attempt, kind: "repair" }); }).catch((e: unknown) => e);
    expect(result).toMatchObject({ code: "repair-unavailable" }); expect(sent).toBe(2);
  });
  it("a complete result remains repairable even when its business JSON is malformed", async () => {
    let sent = 0;
    const host = createAiInvocationHost({ credentials, fetch: async () => Response.json(payload("openai-chat-completions", ++sent === 1 ? "{invalid JSON" : '{"cases":[]}')) });
    const result = await host.run(input(), async s => { const first = await s.invoke(attempt); expect(first.text).toBe("{invalid JSON"); return s.invoke({ ...attempt, kind: "repair" }); });
    expect(result.text).toBe('{"cases":[]}'); expect(sent).toBe(2);
  });
  it("cancelling from request progress prevents the actual fetch", async () => {
    const ctrl = new AbortController(); let sent = 0;
    const host = createAiInvocationHost({ credentials, fetch: async () => { sent++; return Response.json(payload("openai-chat-completions")); } });
    await expect(host.run({ resolved: resolved(), signal: ctrl.signal, onProgress: value => { if (value.phase === "request") ctrl.abort(); } }, s => s.invoke(attempt))).rejects.toMatchObject({ code: "cancelled" });
    expect(sent).toBe(0);
  });
  it.each(["interrupted", "refused", "truncated"])("%s result cannot enter structural repair", async scenario => {
    let sent = 0;
    const host = createAiInvocationHost({ credentials, fetch: async () => {
      sent++;
      if (scenario === "interrupted") throw new TypeError("connection lost");
      const value = payload("openai-chat-completions");
      if (scenario === "refused") value.choices[0].message.refusal = "refused";
      else value.choices[0].finish_reason = "length";
      return Response.json(value);
    } });
    const result = await host.run(input(), async s => { await s.invoke(attempt).catch(() => {}); return s.invoke({ ...attempt, kind: "repair" }); }).catch((e: unknown) => e);
    expect(result).toMatchObject({ code: "repair-unavailable" }); expect(sent).toBe(1);
  });
  it("progress reports safe phases and cumulative bytes without partial business text", async () => {
    const progress: unknown[] = [];
    const host = createAiInvocationHost({ credentials, fetch: async () => Response.json(payload("openai-chat-completions")) });
    await host.run({ ...input(), onProgress: value => progress.push(value) }, s => s.invoke(attempt));
    expect(progress).toEqual(expect.arrayContaining([expect.objectContaining({ phase: "request", attempt: 1 }), expect.objectContaining({ phase: "receiving", attempt: 1, receivedBytes: expect.any(Number) }), expect.objectContaining({ phase: "completed", attempt: 1 })]));
    expect(JSON.stringify(progress)).not.toContain("中文用例"); expect(JSON.stringify(progress)).not.toContain("test-secret");
  });
  it("a failing progress observer cannot break an invocation", async () => {
    let observed = 0;
    const host = createAiInvocationHost({ credentials, fetch: async () => Response.json(payload("openai-chat-completions")) });
    const result = await host.run({ ...input(), onProgress: () => { observed++; throw new Error("private-observer-error"); } }, s => s.invoke(attempt));
    expect(result.terminal).toBe("completed"); expect(observed).toBeGreaterThan(0);
  });
  it("stream bytes accumulate across multiple readers within one operation", async () => {
    const config = resolved(); config.budgets.maxStreamBytes = 1024 * 1024;
    const value = payload("openai-chat-completions"); value.padding = "x".repeat(600000);
    let sent = 0;
    const host = createAiInvocationHost({ credentials, fetch: async () => { sent++; return Response.json(value); } });
    const result = await host.run({ resolved: config, signal: new AbortController().signal }, async s => { await s.invoke(attempt); return s.invoke({ ...attempt, kind: "repair" }); }).catch((e: unknown) => e);
    expect(result).toMatchObject({ code: "stream-limit" }); expect(sent).toBe(2);
  });
  it.each(["openai-responses", "anthropic-messages"] as const)("%s rejects non-string text blocks without coercing objects", async protocol => {
    const value = payload(protocol);
    if (protocol === "openai-responses") value.output[0].content[0].text = { secret: "private-prompt" };
    else value.content[0].text = { secret: "private-prompt" };
    const host = createAiInvocationHost({ credentials, fetch: async () => Response.json(value) });
    await expect(host.run({ resolved: resolved(protocol), signal: new AbortController().signal }, s => s.invoke(attempt))).rejects.toMatchObject({ code: "response-invalid" });
  });
  it.each([null, { output: {} }, { choices: {} }])("malformed response shape %j produces a stable safe invocation error", async value => {
    const host = createAiInvocationHost({ credentials, fetch: async () => Response.json(value) });
    const error = await host.run(input(), s => s.invoke(attempt)).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "response-invalid" }); expect((error as Error).cause).toBeUndefined();
  });
  it.each([401, 500])("HTTP %s keeps status and a safe request ID only", async status => {
    const host = createAiInvocationHost({ credentials, fetch: async () => new Response("private-secret", { status, headers: { "x-request-id": "req_safe" } }) });
    const error = await host.run({ resolved: resolved(), signal: new AbortController().signal }, s => s.invoke(attempt)).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "http", status, requestId: "req_safe" });
    expect(String(error)).not.toContain("private-secret");
    expect(JSON.stringify(error)).not.toContain("private-secret");
  });
  it("unsafe request ID is not exposed", async () => {
    const host = createAiInvocationHost({ credentials, fetch: async () => new Response("private-secret", { status: 401, headers: { "x-request-id": "private-secret /?" } }) });
    const error = await host.run({ resolved: resolved(), signal: new AbortController().signal }, s => s.invoke(attempt)).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "http", status: 401 });
    expect((error as any).requestId).toBeUndefined();
  });
  it("network errors discard the unsafe message/cause and do not resend", async () => {
    let sent = 0;
    const host = createAiInvocationHost({ credentials, fetch: async () => { sent++; throw new TypeError("private-secret", { cause: new Error("private-prompt") }); } });
    const error = await host.run({ resolved: resolved(), signal: new AbortController().signal }, s => s.invoke(attempt)).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "network" });
    expect((error as Error).cause).toBeUndefined();
    expect(String(error)).not.toContain("private-secret");
    expect(sent).toBe(1);
  });
  it("connection-refused classification is preserved as safe metadata", async () => {
    const host = createAiInvocationHost({ credentials, fetch: async () => { throw Object.assign(new Error("private-secret"), { code: "ECONNREFUSED" }); } });
    await expect(host.run(input(), s => s.invoke(attempt))).rejects.toMatchObject({ code: "network", networkKind: "refused" });
  });
});

import { describe, expect, it } from "vitest";
import { createAiInvocationHost } from "../../src/ai/invocation.js";
import { attempt, businessText, credentials, protocols, resolved, sse, streamEvents, streamResponse } from "./invocation.fixture.js";

describe("complete-only protocol streaming", () => {
  it.each([
    { type: "server_tool_use", id: "srvtoolu_test", name: "web_search", input: { query: "test" } },
    { type: "web_search_tool_result", tool_use_id: "srvtoolu_test", content: [] },
    { type: "future_content", data: "unsupported-content" },
  ])("Messages stream rejects $type alongside valid text and final end_turn/message_stop", async block => {
    const events = streamEvents("anthropic-messages");
    events.splice(1, 0, { type: "content_block_start", index: 1, content_block: block }, { type: "content_block_stop", index: 1 });
    const host = createAiInvocationHost({ credentials, fetch: async () => streamResponse(sse(events)) });
    await expect(host.run({ resolved: resolved("anthropic-messages", true), signal: new AbortController().signal }, s => s.invoke(attempt))).rejects.toMatchObject({ code: "tool-output" });
  });
  it.each([
    { type: "thinking", thinking: "private reasoning", signature: "test-signature" },
    { type: "redacted_thinking", data: "redacted-data" },
  ])("Messages stream permits $type and bounded unknown outer events without adopting reasoning", async block => {
    const events = streamEvents("anthropic-messages");
    events.splice(1, 0, { type: "content_block_start", index: 1, content_block: block }, { type: "content_block_stop", index: 1 }, { type: "future_outer_event", data: "ignored" });
    const host = createAiInvocationHost({ credentials, fetch: async () => streamResponse(sse(events)) });
    const result = await host.run({ resolved: resolved("anthropic-messages", true), signal: new AbortController().signal }, s => s.invoke(attempt));
    expect(result.text).toBe(businessText); expect(result.terminal).toBe("completed");
  });
  // Catch UTF-8/SSE framing corruption, JSON-body fallback, and missing stream request flags.
  it.each(protocols)("%s assembles Chinese text across single-byte chunks", async protocol => {
    let body: any;
    const host = createAiInvocationHost({ credentials, fetch: async (_url, init) => { body = JSON.parse(String(init!.body)); return streamResponse(sse(streamEvents(protocol)), 1); } });
    const result = await host.run({ resolved: resolved(protocol, true), signal: new AbortController().signal }, s => s.invoke(attempt));
    expect(result).toMatchObject({ text: businessText, terminal: "completed", requestId: "req_stream", usage: { inputTokens: 10, outputTokens: 20 } });
    expect(body.stream).toBe(true);
    if (protocol === "openai-chat-completions") expect(body.stream_options).toEqual({ include_usage: true });
  });

  const cases = protocols.flatMap(protocol => ["error-after-text", "eof-without-terminal", "truncated", "refusal", "tool-output"].map(scenario => ({ protocol, scenario })));
  it.each(cases)("$protocol rejects $scenario even after complete-looking business JSON", async ({ protocol, scenario }) => {
    const events = streamEvents(protocol);
    const code = scenario === "error-after-text" ? "upstream-error" : scenario === "refusal" ? "refusal" : scenario === "tool-output" ? "tool-output" : "incomplete";
    if (scenario === "error-after-text") events.splice(protocol === "openai-responses" ? 4 : protocol === "anthropic-messages" ? 3 : 2, 0, { type: "error", error: { type: "overloaded_error", message: "private-secret" } });
    if (scenario === "eof-without-terminal") events.splice(protocol === "openai-chat-completions" ? 2 : protocol === "openai-responses" ? 4 : 4);
    if (scenario === "truncated") {
      if (protocol === "openai-chat-completions") (events[2] as any).choices[0].finish_reason = "length";
      else if (protocol === "openai-responses") { const last = events.at(-1) as any; last.type = "response.incomplete"; last.response.status = "incomplete"; last.response.incomplete_details = { reason: "max_output_tokens" }; }
      else (events[4] as any).delta.stop_reason = "max_tokens";
    }
    if (scenario === "refusal") {
      if (protocol === "openai-chat-completions") (events[1] as any).choices[0].delta.refusal = "refused";
      else if (protocol === "openai-responses") events.splice(4, 0, { type: "response.refusal.delta", delta: "refused", item_id: "msg_1", output_index: 0, content_index: 0, sequence_number: 4 });
      else (events[4] as any).delta.stop_reason = "refusal";
    }
    if (scenario === "tool-output") {
      if (protocol === "openai-chat-completions") (events[1] as any).choices[0].delta.tool_calls = [{ index: 0, id: "t", type: "function", function: { name: "x", arguments: "{}" } }];
      else if (protocol === "openai-responses") (events[1] as any).item = { type: "function_call", id: "t", name: "x", arguments: "{}", call_id: "t", status: "in_progress" };
      else (events[1] as any).content_block = { type: "tool_use", id: "t", name: "x", input: {} };
    }
    const host = createAiInvocationHost({ credentials, fetch: async () => streamResponse(sse(events)) });
    const error = await host.run({ resolved: resolved(protocol, true), signal: new AbortController().signal }, s => s.invoke(attempt)).catch((e: unknown) => e);
    expect(error).toMatchObject({ code });
    expect(String(error)).not.toContain("private-secret");
  });

  it("Messages content_block_stop alone never completes a message", async () => {
    const host = createAiInvocationHost({ credentials, fetch: async () => streamResponse(sse(streamEvents("anthropic-messages").slice(0, 4))) });
    await expect(host.run({ resolved: resolved("anthropic-messages", true), signal: new AbortController().signal }, s => s.invoke(attempt))).rejects.toMatchObject({ code: "incomplete" });
  });
  it("Chat DONE without finish_reason stop is incomplete", async () => {
    const events = streamEvents("openai-chat-completions"); events.splice(2, 1);
    const host = createAiInvocationHost({ credentials, fetch: async () => streamResponse(sse(events)) });
    await expect(host.run({ resolved: resolved("openai-chat-completions", true), signal: new AbortController().signal }, s => s.invoke(attempt))).rejects.toMatchObject({ code: "incomplete" });
  });
});

describe("bounded stream and response bodies", () => {
  it.each(["openai-responses", "anthropic-messages"] as const)("%s rejects non-string text deltas", async protocol => {
    const events = streamEvents(protocol);
    if (protocol === "openai-responses") (events[3] as any).delta = { private: "prompt" };
    else (events[2] as any).delta.text = { private: "prompt" };
    const host = createAiInvocationHost({ credentials, fetch: async () => streamResponse(sse(events)) });
    await expect(host.run({ resolved: resolved(protocol, true), signal: new AbortController().signal }, s => s.invoke(attempt))).rejects.toMatchObject({ code: "response-invalid" });
  });
  it("invalid UTF-8 is rejected even inside an ignored comment", async () => {
    const bytes = new TextEncoder().encode(": x\n\n" + sse(streamEvents("openai-chat-completions"))); bytes[2] = 255;
    const host = createAiInvocationHost({ credentials, fetch: async () => new Response(bytes, { headers: { "content-type": "text/event-stream" } }) });
    await expect(host.run({ resolved: resolved("openai-chat-completions", true), signal: new AbortController().signal }, s => s.invoke(attempt))).rejects.toMatchObject({ code: "response-invalid" });
  });
  // Catch omitted raw-byte accounting on ignored/unfinished/heartbeat/error data paths.
  it.each(["data", "unknown-event", "unfinished-line", "comment"])("bounds each %s frame", async scenario => {
    const config = resolved("openai-chat-completions", true); config.budgets.maxEventBytes = 16 * 1024;
    const raw = scenario === "data" ? sse([{ choices: [], padding: "x".repeat(17000) }]) : scenario === "unknown-event" ? sse([{ type: "future_event", padding: "x".repeat(17000) }]) : scenario === "unfinished-line" ? `data: ${"x".repeat(17000)}` : `: ${"x".repeat(17000)}\n\n`;
    let cancelled = false;
    let finish!: () => void;
    const bytes = new TextEncoder().encode(raw);
    const response = new Response(new ReadableStream({ start(c) { c.enqueue(bytes); finish = () => c.close(); }, cancel() { cancelled = true; } }), { headers: { "content-type": "text/event-stream" } });
    const host = createAiInvocationHost({ credentials, fetch: async () => response });
    // End the fixture only if the missing bound did not cancel it; avoids a test timeout as RED.
    const result = host.run({ resolved: config, signal: new AbortController().signal }, s => s.invoke(attempt));
    const settled = result.catch((e: unknown) => e);
    // Reader cancellation is part of the observable resource contract.
    const timer = setTimeout(finish, 25);
    try {
      const winner = await settled;
      expect(winner).toMatchObject({ code: "event-limit" });
      expect(cancelled).toBe(true);
    } finally { clearTimeout(timer); }
  });
  it("cumulative heartbeat traffic is limited even though each event is tiny", async () => {
    const config = resolved("openai-chat-completions", true); config.budgets.maxStreamBytes = 1024 * 1024;
    const host = createAiInvocationHost({ credentials, fetch: async () => streamResponse(": ping\n\n".repeat(140000) + sse(streamEvents("openai-chat-completions")), 16384) });
    await expect(host.run({ resolved: config, signal: new AbortController().signal }, s => s.invoke(attempt))).rejects.toMatchObject({ code: "stream-limit" });
  });
  it.each(protocols)("%s bounds assembled text before terminal delivery", async protocol => {
    const config = resolved(protocol, true); config.budgets.maxOutputBytes = 64 * 1024;
    const host = createAiInvocationHost({ credentials, fetch: async () => streamResponse(sse(streamEvents(protocol, "中".repeat(22000))), 4096) });
    await expect(host.run({ resolved: config, signal: new AbortController().signal }, s => s.invoke(attempt))).rejects.toMatchObject({ code: "output-limit" });
  });
  it("non-streaming text uses the same output limit", async () => {
    const config = resolved(); config.budgets.maxOutputBytes = 64 * 1024;
    const { payload } = await import("./invocation.fixture.js");
    const host = createAiInvocationHost({ credentials, fetch: async () => Response.json(payload("openai-chat-completions", "x".repeat(65537))) });
    await expect(host.run({ resolved: config, signal: new AbortController().signal }, s => s.invoke(attempt))).rejects.toMatchObject({ code: "output-limit" });
  });
  it("error bodies consume stream bytes without being echoed", async () => {
    const config = resolved(); config.budgets.maxStreamBytes = 1024 * 1024;
    const host = createAiInvocationHost({ credentials, fetch: async () => new Response("private-secret".repeat(100000), { status: 500 }) });
    const error = await host.run({ resolved: config, signal: new AbortController().signal }, s => s.invoke(attempt)).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "stream-limit" });
    expect(String(error)).not.toContain("private-secret");
  });
  it("host payload buffer rejects a body larger than the configured capacity", async () => {
    const config = resolved(); config.protection.hostPayloadBufferBytes = 16 * 1024 * 1024;
    const host = createAiInvocationHost({ credentials, fetch: async () => new Response("x".repeat(17 * 1024 * 1024)) });
    await expect(host.run({ resolved: config, signal: new AbortController().signal }, s => s.invoke(attempt))).rejects.toMatchObject({ code: "payload-limit" });
  });
});

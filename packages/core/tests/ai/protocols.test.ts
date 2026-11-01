import { describe, expect, it } from "vitest";
import { createAiInvocationHost } from "../../src/ai/invocation.js";
import { AiInvocationError } from "../../src/ai/types.js";
import { AiModelProfileSchema } from "../../src/ai/config.js";
import { attempt, businessText, credentials, outputSchema, payload, protocols, resolved } from "./invocation.fixture.js";

describe("protocol non-streaming requests", () => {
  // Catches protocol-switch/body-reuse bugs; complete hand-built fixtures share only business text.
  it.each(protocols)("%s sends its own schema/budget/auth fields and returns complete text", async (protocol) => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const host = createAiInvocationHost({ credentials, fetch: async (url, init) => {
      requests.push({ url: String(url), init: init! });
      return Response.json(payload(protocol), { headers: { "x-request-id": "req_123" } });
    } });
    const result = await host.run({ resolved: resolved(protocol), signal: new AbortController().signal }, session => session.invoke(attempt));
    expect(result).toEqual({ text: businessText, terminal: "completed", requestId: "req_123", usage: { inputTokens: 10, outputTokens: 20 } });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`https://example.com/gateway/v1/${protocol === "openai-chat-completions" ? "chat/completions" : protocol === "openai-responses" ? "responses" : "messages"}`);
    expect(requests[0]!.init.redirect).toBe("error");
    const headers = new Headers(requests[0]!.init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    const body = JSON.parse(String(requests[0]!.init.body));
    if (protocol === "openai-chat-completions") {
      expect(headers.get("authorization")).toBe("Bearer test-secret");
      expect(body).toEqual({ model: "real-a", messages: attempt.messages, stream: false, store: false, max_completion_tokens: 8192, response_format: { type: "json_schema", json_schema: { name: "result", strict: true, schema: outputSchema } } });
    } else if (protocol === "openai-responses") {
      expect(headers.get("authorization")).toBe("Bearer test-secret");
      expect(body).toEqual({ model: "real-a", input: attempt.messages, stream: false, store: false, max_output_tokens: 8192, text: { format: { type: "json_schema", name: "result", strict: true, schema: outputSchema } } });
    } else {
      expect(headers.get("x-api-key")).toBe("test-secret");
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
      expect(body).toEqual({ model: "real-a", system: "仅输出符合 schema 的 JSON", messages: [{ role: "user", content: "给出用例" }], stream: false, max_tokens: 8192, output_config: { format: { type: "json_schema", schema: outputSchema } } });
    }
    expect(body.temperature).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
    expect(body.previous_response_id).toBeUndefined();
  });
});

describe("explicit structured-output and compatibility settings", () => {
  it.each(["openai-chat-completions", "openai-responses"] as const)("%s supports explicitly selected json-object", async protocol => {
    const config = resolved(protocol);
    config.model.structuredOutput = "json-object";
    let body: any;
    const host = createAiInvocationHost({ credentials, fetch: async (_url, init) => { body = JSON.parse(String(init!.body)); return Response.json(payload(protocol)); } });
    await host.run({ resolved: config, signal: new AbortController().signal }, s => s.invoke(attempt));
    expect(protocol === "openai-chat-completions" ? body.response_format : body.text.format).toEqual({ type: "json_object" });
  });
  it.each(protocols)("%s prompt-json includes schema instruction without native schema parameter", async protocol => {
    const config = resolved(protocol);
    config.model.structuredOutput = "prompt-json";
    let body: any;
    const host = createAiInvocationHost({ credentials, fetch: async (_url, init) => { body = JSON.parse(String(init!.body)); return Response.json(payload(protocol)); } });
    await host.run({ resolved: config, signal: new AbortController().signal }, s => s.invoke(attempt));
    expect(body.response_format).toBeUndefined();
    expect(body.output_config).toBeUndefined();
    expect(body.text).toBeUndefined();
    expect(JSON.stringify(protocol === "anthropic-messages" ? body.system : body.messages ?? body.input)).toContain("Return only JSON matching this schema:");
    expect(JSON.stringify(body)).toContain(JSON.stringify(outputSchema).replaceAll('"', '\\"'));
  });
  it("Messages rejects unsupported json-object explicitly without sending", async () => {
    const config = resolved("anthropic-messages"); config.model.structuredOutput = "json-object";
    let sent = 0;
    const host = createAiInvocationHost({ credentials, fetch: async () => { sent++; return Response.json(payload("anthropic-messages")); } });
    await expect(host.run({ resolved: config, signal: new AbortController().signal }, s => s.invoke(attempt))).rejects.toMatchObject({ code: "unsupported-structured-output" });
    expect(sent).toBe(0);
  });
  it("Chat legacy token parameter is an explicit validated named setting", async () => {
    const config = resolved();
    const parsed = AiModelProfileSchema.safeParse({ ...config.model, chatCompletionTokenParameter: "max_tokens" });
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw parsed.error;
    config.model = parsed.data;
    let body: any;
    const host = createAiInvocationHost({ credentials, fetch: async (_url, init) => { body = JSON.parse(String(init!.body)); return Response.json(payload("openai-chat-completions")); } });
    await host.run({ resolved: config, signal: new AbortController().signal }, s => s.invoke(attempt));
    expect(body.max_tokens).toBe(8192);
    expect(body.max_completion_tokens).toBeUndefined();
  });
});

describe("non-streaming terminal validation", () => {
  // I2: retain valid text/end_turn so only the missing content-type gate can reject these.
  it.each([
    { type: "server_tool_use", id: "srvtoolu_test", name: "web_search", input: { query: "test" } },
    { type: "web_search_tool_result", tool_use_id: "srvtoolu_test", content: [] },
    { type: "future_content", data: "unsupported-content" },
  ])("Messages non-stream rejects $type alongside valid business text and end_turn", async block => {
    const value = payload("anthropic-messages"); value.content.unshift(block);
    const host = createAiInvocationHost({ credentials, fetch: async () => Response.json(value) });
    await expect(host.run({ resolved: resolved("anthropic-messages"), signal: new AbortController().signal }, s => s.invoke(attempt))).rejects.toMatchObject({ code: "tool-output" });
  });
  it.each([
    { type: "thinking", thinking: "private reasoning", signature: "test-signature" },
    { type: "redacted_thinking", data: "redacted-data" },
  ])("Messages non-stream permits $type without adopting it as business text", async block => {
    const value = payload("anthropic-messages"); value.content.unshift(block);
    const host = createAiInvocationHost({ credentials, fetch: async () => Response.json(value) });
    const result = await host.run({ resolved: resolved("anthropic-messages"), signal: new AbortController().signal }, s => s.invoke(attempt));
    expect(result.text).toBe(businessText); expect(result.terminal).toBe("completed");
  });
  // Catch accepting valid-looking JSON despite failed/refused/truncated/tool/wrong-speaker results.
  const invalidCases = protocols.flatMap(protocol => ["incomplete", "refusal", "tool-output", "missing-text", "wrong-role", "upstream-error"].map(scenario => ({ protocol, scenario })));
  it.each(invalidCases)("$protocol rejects $scenario instead of returning candidates", async ({ protocol, scenario }) => {
    const value = payload(protocol);
    const reason = scenario === "incomplete" ? "incomplete" : scenario === "refusal" ? "refusal" : scenario === "tool-output" ? "tool-output" : scenario === "upstream-error" ? "upstream-error" : "response-invalid";
    if (scenario === "upstream-error") value.error = { type: "server_error", message: "private body" };
    else if (protocol === "openai-chat-completions") {
      const choice = value.choices[0];
      if (scenario === "incomplete") choice.finish_reason = "length";
      if (scenario === "refusal") choice.message.refusal = "refused";
      if (scenario === "tool-output") { choice.finish_reason = "tool_calls"; choice.message.tool_calls = [{ id: "t", type: "function", function: { name: "x", arguments: "{}" } }]; }
      if (scenario === "missing-text") choice.message.content = null;
      if (scenario === "wrong-role") choice.message.role = "user";
    } else if (protocol === "openai-responses") {
      if (scenario === "incomplete") { value.status = "incomplete"; value.incomplete_details = { reason: "max_output_tokens" }; }
      if (scenario === "refusal") value.output[0].content.push({ type: "refusal", refusal: "refused" });
      if (scenario === "tool-output") value.output.push({ id: "t", type: "function_call", name: "x", arguments: "{}", call_id: "t", status: "completed" });
      if (scenario === "missing-text") value.output[0].content = [];
      if (scenario === "wrong-role") value.output[0].role = "user";
    } else {
      if (scenario === "incomplete") value.stop_reason = "max_tokens";
      if (scenario === "refusal") value.stop_reason = "refusal";
      if (scenario === "tool-output") { value.stop_reason = "tool_use"; value.content.push({ type: "tool_use", id: "t", name: "x", input: {} }); }
      if (scenario === "missing-text") value.content = [];
      if (scenario === "wrong-role") value.role = "user";
    }
    const host = createAiInvocationHost({ credentials, fetch: async () => Response.json(value) });
    const error = await host.run({ resolved: resolved(protocol), signal: new AbortController().signal }, session => session.invoke(attempt)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiInvocationError);
    expect(error).toMatchObject({ code: reason });
    expect(String(error)).not.toContain("private body");
  });

  it("Chat selects choice index zero rather than the first array entry", async () => {
    const value = payload("openai-chat-completions");
    value.choices.unshift({ index: 1, message: { role: "assistant", content: "wrong-choice" }, finish_reason: "stop" });
    const host = createAiInvocationHost({ credentials, fetch: async () => Response.json(value) });
    const result = await host.run({ resolved: resolved(), signal: new AbortController().signal }, session => session.invoke(attempt));
    expect(result.text).toBe(businessText);
  });

  it.each(protocols)("%s rejects a missing successful terminal", async protocol => {
    const value = payload(protocol);
    if (protocol === "openai-chat-completions") delete value.choices[0].finish_reason;
    else if (protocol === "openai-responses") delete value.status;
    else delete value.stop_reason;
    const host = createAiInvocationHost({ credentials, fetch: async () => Response.json(value) });
    await expect(host.run({ resolved: resolved(protocol), signal: new AbortController().signal }, session => session.invoke(attempt))).rejects.toMatchObject({ code: "incomplete" });
  });

  it("malformed JSON is normalized without carrying the body or parse cause", async () => {
    const host = createAiInvocationHost({ credentials, fetch: async () => new Response("private-prompt-not-json") });
    const error = await host.run({ resolved: resolved(), signal: new AbortController().signal }, session => session.invoke(attempt)).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "response-invalid" });
    expect((error as Error).cause).toBeUndefined();
    expect(String(error)).not.toContain("private-prompt");
  });
});

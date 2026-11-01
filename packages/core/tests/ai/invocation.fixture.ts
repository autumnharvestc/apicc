import { aiCredentialAudience, resolveAiInvocation, type AiProtocol } from "../../src/ai/config.js";
import type { AiAttemptInput, AiCredentialResolver, AiResolvedInvocation } from "../../src/ai/types.js";
import { fixture } from "./config.fixture.js";

export const businessText = '{"cases":[{"name":"中文用例"}]}';
export const outputSchema = { type: "object", properties: { cases: { type: "array", items: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false } } }, required: ["cases"], additionalProperties: false };
export const attempt: AiAttemptInput = { kind: "initial", outputSchema, messages: [{ role: "system", content: "仅输出符合 schema 的 JSON" }, { role: "user", content: "给出用例" }] };
export const credentials: AiCredentialResolver = { async resolve(connection) { return { audience: aiCredentialAudience(connection), headers: connection.auth.kind === "api-key" ? { [connection.auth.header]: "test-secret" } : { authorization: "Bearer test-secret" } }; } };
export function resolved(protocol: AiProtocol = "openai-chat-completions", streaming = false): AiResolvedInvocation {
  const document = fixture();
  document.models = document.models.slice(0, 1);
  document.connections[0]!.protocols = [protocol];
  document.connections[0]!.auth = protocol === "anthropic-messages" ? { kind: "api-key", header: "x-api-key" } : { kind: "bearer" };
  document.models[0]!.protocol = protocol;
  document.models[0]!.streaming = streaming;
  return resolveAiInvocation({ document, purpose: "case-suggestion" });
}
export function payload(protocol: AiProtocol, text = businessText): Record<string, any> {
  if (protocol === "openai-chat-completions") return { id: "chat_1", object: "chat.completion", created: 1, model: "real-a", choices: [{ index: 0, message: { role: "assistant", content: text, refusal: null, annotations: [] }, logprobs: null, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } };
  if (protocol === "openai-responses") return { id: "resp_1", object: "response", created_at: 1, status: "completed", model: "real-a", error: null, incomplete_details: null, output: [{ id: "msg_1", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text, annotations: [], logprobs: [] }] }], usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } };
  return { id: "msg_1", type: "message", role: "assistant", model: "real-a", content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 20 } };
}
export const protocols = ["openai-chat-completions", "openai-responses", "anthropic-messages"] as const;

export function streamEvents(protocol: AiProtocol, text = businessText): Array<Record<string, any> | "[DONE]"> {
  if (protocol === "openai-chat-completions") return [
    { id: "chat_1", object: "chat.completion.chunk", created: 1, model: "real-a", choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null, logprobs: null }] },
    { id: "chat_1", object: "chat.completion.chunk", created: 1, model: "real-a", choices: [{ index: 0, delta: { content: text }, finish_reason: null, logprobs: null }] },
    { id: "chat_1", object: "chat.completion.chunk", created: 1, model: "real-a", choices: [{ index: 0, delta: {}, finish_reason: "stop", logprobs: null }] },
    { id: "chat_1", object: "chat.completion.chunk", created: 1, model: "real-a", choices: [], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }, "[DONE]",
  ];
  if (protocol === "openai-responses") return [
    { type: "response.created", sequence_number: 0, response: { ...payload(protocol, ""), status: "in_progress", output: [] } },
    { type: "response.output_item.added", sequence_number: 1, output_index: 0, item: { id: "msg_1", type: "message", role: "assistant", status: "in_progress", content: [] } },
    { type: "response.content_part.added", sequence_number: 2, output_index: 0, content_index: 0, item_id: "msg_1", part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", sequence_number: 3, output_index: 0, content_index: 0, item_id: "msg_1", delta: text },
    { type: "response.output_text.done", sequence_number: 4, output_index: 0, content_index: 0, item_id: "msg_1", text },
    { type: "response.output_item.done", sequence_number: 5, output_index: 0, item: payload(protocol, text).output[0] },
    { type: "response.completed", sequence_number: 6, response: payload(protocol, text) },
  ];
  return [
    { type: "message_start", message: { ...payload(protocol, ""), content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } },
    { type: "message_stop" },
  ];
}
export function sse(events: Array<Record<string, any> | "[DONE]">): string {
  return events.map(event => `${event === "[DONE]" || !event.type ? "" : `event: ${event.type}\n`}data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`).join("");
}
export function streamResponse(text: string, chunkSize = 47): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (offset >= bytes.length) { controller.close(); return; }
    controller.enqueue(bytes.slice(offset, offset + chunkSize)); offset += chunkSize;
  } }), { headers: { "content-type": "text/event-stream", "x-request-id": "req_stream" } });
}

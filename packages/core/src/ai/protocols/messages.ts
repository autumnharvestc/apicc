import type { AiResolvedInvocation } from "../config.js";
import { AiInvocationError, type AiAttemptInput, type AiCallResult } from "../types.js";
import type { AiStreamAssembler } from "../stream.js";

/** Only these content kinds belong to the pure-text invocation contract. */
function messageBlockKind(type: unknown): "text" | "thinking" {
  if (type === "text") return "text";
  if (type === "thinking" || type === "redacted_thinking") return "thinking";
  throw new AiInvocationError("tool-output");
}

export function messagesBody(resolved: AiResolvedInvocation, input: AiAttemptInput): object {
  return { model: resolved.model.modelId, system: input.messages.filter(m => m.role === "system").map(m => m.content).join("\n"),
    messages: input.messages.filter(m => m.role !== "system"), stream: resolved.model.streaming, max_tokens: resolved.budgets.maxOutputTokens,
    ...(resolved.model.structuredOutput === "prompt-json" ? {} : { output_config: { format: { type: "json_schema", schema: input.outputSchema } } }) };
}

export function messagesStream(onText: (text: string) => void): AiStreamAssembler {
  let message: any, content = "", stopped = false;
  const textBlocks = new Set<number>();
  return { accept(value) {
    if (value?.type === "error" || value?.error) throw new AiInvocationError("upstream-error");
    if (value?.type === "message_start") message = { ...value.message, content: [] };
    if (value?.type === "content_block_start") {
      if (messageBlockKind(value.content_block.type) === "text") { textBlocks.add(value.index); onText(value.content_block.text); content += value.content_block.text; }
    }
    if (value?.type === "content_block_delta" && textBlocks.has(value.index) && value.delta?.type === "text_delta") { onText(value.delta.text); content += value.delta.text; }
    if (value?.type === "content_block_stop") textBlocks.delete(value.index);
    if (value?.type === "message_delta" && message) { Object.assign(message, value.delta); message.usage = { ...message.usage, ...value.usage }; }
    if (value?.type === "message_stop") stopped = true;
  }, finish() {
    if (!message || !stopped) throw new AiInvocationError("incomplete");
    return parseMessages({ ...message, content: [{ type: "text", text: content }] });
  } };
}
export function parseMessages(value: any): AiCallResult {
  if (value?.error) throw new AiInvocationError("upstream-error");
  if (value?.stop_reason === "refusal") throw new AiInvocationError("refusal");
  if (value?.stop_reason === "tool_use") throw new AiInvocationError("tool-output");
  value.content.forEach((part: any) => messageBlockKind(part.type));
  if (value?.stop_reason !== "end_turn") throw new AiInvocationError("incomplete");
  const parts = value.content.filter((part: any) => part.type === "text");
  if (parts.some((part: any) => typeof part.text !== "string")) throw new AiInvocationError("response-invalid");
  const text = parts.map((part: any) => part.text).join("");
  if (value.role !== "assistant" || !text) throw new AiInvocationError("response-invalid");
  return { text, terminal: "completed", usage: value.usage ? { inputTokens: value.usage.input_tokens, outputTokens: value.usage.output_tokens } : undefined };
}

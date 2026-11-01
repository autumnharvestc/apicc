import type { AiResolvedInvocation } from "../config.js";
import { AiInvocationError, type AiAttemptInput, type AiCallResult } from "../types.js";
import type { AiStreamAssembler } from "../stream.js";

export function chatCompletionsBody(resolved: AiResolvedInvocation, input: AiAttemptInput): object {
  return { model: resolved.model.modelId, messages: input.messages, stream: resolved.model.streaming, store: false,
    [resolved.model.chatCompletionTokenParameter ?? "max_completion_tokens"]: resolved.budgets.maxOutputTokens,
    ...(resolved.model.streaming ? { stream_options: { include_usage: true } } : {}),
    ...(resolved.model.structuredOutput === "prompt-json" ? {} : { response_format: resolved.model.structuredOutput === "json-object" ? { type: "json_object" } : { type: "json_schema", json_schema: { name: "result", strict: true, schema: input.outputSchema } } }) };
}

export function chatCompletionsStream(onText: (text: string) => void): AiStreamAssembler {
  let content = "", role: string | undefined, reason: string | undefined, usage: unknown, done = false;
  return { accept(value) {
    if (value === "[DONE]") { done = true; return; }
    if (value?.error) throw new AiInvocationError("upstream-error");
    if (value.usage) usage = value.usage;
    const choice = value.choices?.find((item: any) => item.index === 0);
    if (!choice) return;
    const delta = choice.delta ?? {};
    if (delta.refusal || choice.finish_reason === "content_filter") throw new AiInvocationError("refusal");
    if (delta.tool_calls || delta.function_call) throw new AiInvocationError("tool-output");
    if (delta.role) role = delta.role;
    if (typeof delta.content === "string") { onText(delta.content); content += delta.content; }
    if (choice.finish_reason) reason = choice.finish_reason;
  }, finish() {
    if (!done) throw new AiInvocationError("incomplete");
    return parseChatCompletions({ choices: [{ index: 0, message: { role, content }, finish_reason: reason }], usage });
  } };
}
export function parseChatCompletions(value: any): AiCallResult {
  if (value?.error) throw new AiInvocationError("upstream-error");
  if (!Array.isArray(value?.choices) || !value.choices.length) throw new AiInvocationError("response-invalid");
  const choice = value?.choices?.find((item: any) => item.index === 0);
  if (choice?.message?.refusal || choice?.finish_reason === "content_filter") throw new AiInvocationError("refusal");
  if (choice?.message?.tool_calls || choice?.message?.function_call || ["tool_calls", "function_call"].includes(choice?.finish_reason)) throw new AiInvocationError("tool-output");
  if (choice?.finish_reason !== "stop") throw new AiInvocationError("incomplete");
  if (choice.message?.role !== "assistant" || typeof choice.message?.content !== "string" || !choice.message.content) throw new AiInvocationError("response-invalid");
  return { text: choice.message.content, terminal: "completed", usage: value.usage ? { inputTokens: value.usage.prompt_tokens, outputTokens: value.usage.completion_tokens } : undefined };
}

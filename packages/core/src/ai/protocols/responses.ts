import type { AiResolvedInvocation } from "../config.js";
import { AiInvocationError, type AiAttemptInput, type AiCallResult } from "../types.js";
import type { AiStreamAssembler } from "../stream.js";

export function responsesBody(resolved: AiResolvedInvocation, input: AiAttemptInput): object {
  return { model: resolved.model.modelId, input: input.messages, stream: resolved.model.streaming, store: false,
    max_output_tokens: resolved.budgets.maxOutputTokens,
    ...(resolved.model.structuredOutput === "prompt-json" ? {} : { text: { format: resolved.model.structuredOutput === "json-object" ? { type: "json_object" } : { type: "json_schema", name: "result", strict: true, schema: input.outputSchema } } }) };
}

export function responsesStream(onText: (text: string) => void): AiStreamAssembler {
  let result: AiCallResult | undefined;
  return { accept(value) {
    if (value?.type === "error" || value?.error || value?.type === "response.failed") throw new AiInvocationError("upstream-error");
    if (value?.type === "response.incomplete") throw new AiInvocationError("incomplete");
    if (value?.type === "response.refusal.delta" || value?.type === "response.refusal.done") throw new AiInvocationError("refusal");
    if (value?.type === "response.output_item.added" && !["message", "reasoning"].includes(value.item?.type)) throw new AiInvocationError("tool-output");
    if (value?.type === "response.output_text.delta") onText(value.delta);
    if (value?.type === "response.completed") result = parseResponses(value.response);
  }, finish() {
    if (!result) throw new AiInvocationError("incomplete");
    return result;
  } };
}
export function parseResponses(value: any): AiCallResult {
  if (value?.error) throw new AiInvocationError("upstream-error");
  if (value?.status !== "completed") throw new AiInvocationError("incomplete");
  if (value.output.some((item: any) => item.type !== "message" && item.type !== "reasoning")) throw new AiInvocationError("tool-output");
  const messages = value.output.filter((item: any) => item.type === "message");
  if (messages.some((item: any) => item.content.some((part: any) => part.type === "refusal"))) throw new AiInvocationError("refusal");
  if (messages.some((item: any) => item.role !== "assistant" || item.status !== "completed")) throw new AiInvocationError("response-invalid");
  const parts = messages.flatMap((item: any) => item.content.filter((part: any) => part.type === "output_text"));
  if (parts.some((part: any) => typeof part.text !== "string")) throw new AiInvocationError("response-invalid");
  const text = parts.map((part: any) => part.text).join("");
  if (!text) throw new AiInvocationError("response-invalid");
  return { text, terminal: "completed", usage: value.usage ? { inputTokens: value.usage.input_tokens, outputTokens: value.usage.output_tokens } : undefined };
}

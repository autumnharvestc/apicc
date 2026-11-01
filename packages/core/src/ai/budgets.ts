import { AiConfigurationError, type AiResolvedInvocation } from "./config.js";
import type { AiChatMessage } from "./types.js";

/** All serialized material, including system, schema and repair history. */
export interface AiCompleteInput { messages: readonly AiChatMessage[]; outputSchema?: unknown; instruction?: string }
/** Local counter must match this model/protocol and include its framing overhead. */
export type AiLocalTokenCounter = (input: AiCompleteInput, invocation: AiResolvedInvocation) => number;
export interface AiInputBudgetResult { inputBytes: number; inputTokens?: number; tokenStatus: "exact" | "unconfirmed"; windowStatus: "confirmed" | "unconfirmed" }
const utf8 = (value: string) => new TextEncoder().encode(value).byteLength;
export function validateAiInputBudget(invocation: AiResolvedInvocation, input: AiCompleteInput, countTokens?: AiLocalTokenCounter): AiInputBudgetResult {
  const { budgets, model } = invocation;
  if (utf8(input.instruction ?? "") > budgets.maxInstructionBytes) throw new AiConfigurationError("budget-exceeded", "maxInstructionBytes", "input", budgets.maxInstructionBytes);
  const inputBytes = utf8(JSON.stringify(input));
  if (inputBytes > budgets.maxInputBytes) throw new AiConfigurationError("budget-exceeded", "maxInputBytes", "input", budgets.maxInputBytes);
  if (!countTokens) return { inputBytes, tokenStatus: "unconfirmed", windowStatus: "unconfirmed" };
  const inputTokens = countTokens(input, invocation);
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0) throw new AiConfigurationError("invalid-token-count", "inputTokens", "local-counter");
  if (budgets.maxInputTokens !== undefined && inputTokens > budgets.maxInputTokens) throw new AiConfigurationError("budget-exceeded", "maxInputTokens", "input", budgets.maxInputTokens);
  const capability = model.capabilities;
  if (capability.status === "confirmed") {
    if (capability.maxInputTokens !== undefined && inputTokens > capability.maxInputTokens) throw new AiConfigurationError("budget-exceeded", "maxInputTokens", "model", capability.maxInputTokens);
    if (capability.sharedContextWindow === true && capability.contextWindowTokens !== undefined && inputTokens + budgets.maxOutputTokens > capability.contextWindowTokens) throw new AiConfigurationError("budget-exceeded", "contextWindowTokens", "model", capability.contextWindowTokens);
  }
  const windowConfirmed = capability.status === "confirmed" && (capability.sharedContextWindow === true ? capability.contextWindowTokens !== undefined : capability.sharedContextWindow === false && capability.maxInputTokens !== undefined);
  return { inputBytes, inputTokens, tokenStatus: "exact", windowStatus: windowConfirmed ? "confirmed" : "unconfirmed" };
}

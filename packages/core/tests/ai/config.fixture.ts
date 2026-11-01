import { createDefaultAiConfigDocument, type AiConfigDocument } from "../../src/ai/config.js";

export function fixture(): AiConfigDocument {
  const document = createDefaultAiConfigDocument();
  document.connections = [{ id: "c", revision: 1, name: "gateway", owner: { kind: "personal" }, baseUrl: "https://example.com/gateway/v1/", protocols: ["openai-responses"], auth: { kind: "bearer" }, headers: {}, credentialRef: "secret:c" }];
  document.models = [
    { id: "a", revision: 1, connectionId: "c", modelId: "real-a", protocol: "openai-responses", structuredOutput: "json-schema", streaming: true, supportedParameters: [], capabilities: { status: "confirmed", source: "manual", maxOutputTokens: 8192, sharedContextWindow: true, contextWindowTokens: 65536, outputIncludesReasoning: false }, budgets: {}, purposeBudgets: {} },
    // Synthetic capacity declaration for the independent 1 MiB usage regression, not a vendor capability claim.
    { id: "b", revision: 1, connectionId: "c", modelId: "real-b", protocol: "openai-responses", structuredOutput: "json-schema", streaming: true, supportedParameters: [], capabilities: { status: "confirmed", source: "synthetic fixture", maxOutputTokens: 65536, maxInputTokens: 131072, sharedContextWindow: false, outputIncludesReasoning: false }, budgets: { maxOutputTokens: 32768, maxInputBytes: 1048576, totalOutputTokens: 98304 }, purposeBudgets: {} },
  ];
  document.bindings = [{ purpose: "case-suggestion", modelProfileId: "a", budgets: {} }];
  return document;
}

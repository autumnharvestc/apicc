import type { HttpErrorKind } from "../http/client.js";
import { aiCredentialAudience, createDefaultAiConfigDocument, resolveAiInvocation } from "./config.js";
import { createAiInvocationHost } from "./invocation.js";
import { AiInvocationError, DEFAULT_AI_TIMEOUT_MS, type AiChatMessage, type AiProvider, type AiProviderConfig } from "./types.js";

export type AiProviderErrorKind = HttpErrorKind | "http" | "response";

/** Compatibility error: classification/status remain available; upstream text and causes do not. */
export class AiProviderError extends Error {
  readonly kind: AiProviderErrorKind;
  readonly status?: number;
  readonly requestId?: string;
  /** @deprecated Upstream error bodies are never exposed. */
  readonly bodySnippet?: string;
  constructor(kind: AiProviderErrorKind, detail: string, opts?: { status?: number; requestId?: string; bodySnippet?: string; cause?: unknown }) {
    super(`AI provider 请求失败（${kind}）: ${detail}`);
    this.name = "AiProviderError"; this.kind = kind; this.status = opts?.status; this.requestId = opts?.requestId;
  }
}
export interface AiProviderDeps { fetch?: typeof fetch }

/** Legacy Chat/json-object adapter; all transport and reading use the bounded invocation host. */
export function createAiProvider(config: AiProviderConfig, deps: AiProviderDeps = {}): AiProvider {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  if (!baseUrl) throw new Error("AI provider 配置缺 baseUrl");
  if (!config.apiKey) throw new Error("AI provider 配置缺 apiKey");
  if (!config.model) throw new Error("AI provider 配置缺 model");
  const timeoutMs = config.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
  const apiKey = config.apiKey;
  const document = createDefaultAiConfigDocument();
  document.connections = [{ id: "legacy", revision: 1, name: "legacy", owner: { kind: "personal" }, baseUrl, auth: { kind: "bearer" }, headers: {}, protocols: ["openai-chat-completions"] }];
  document.models = [{ id: "legacy", revision: 1, connectionId: "legacy", modelId: config.model, protocol: "openai-chat-completions", structuredOutput: "json-object", streaming: false, supportedParameters: [], capabilities: { status: "unconfirmed", source: "legacy-config" }, budgets: { maxRequests: 1, transportRetries: 0, repairAttempts: 0 }, purposeBudgets: {} }];
  document.bindings = [{ purpose: "case-suggestion", modelProfileId: "legacy", budgets: {} }];
  const resolved = resolveAiInvocation({ document, purpose: "case-suggestion" });
  // Preserve the legacy 25ms/60s programmatic contract without relaxing the new-user 10s schema.
  resolved.budgets.requestTimeoutMs = timeoutMs; resolved.budgets.deadlineMs = timeoutMs;
  const host = createAiInvocationHost({ fetch: deps.fetch, credentials: { async resolve(connection) {
    return { audience: aiCredentialAudience(connection), headers: { authorization: `Bearer ${apiKey}` } };
  } } });
  return async (messages: AiChatMessage[]): Promise<string> => {
    try {
      return await host.run({ resolved, signal: new AbortController().signal }, async session => (await session.invoke({ messages, outputSchema: { type: "object" }, kind: "initial" })).text);
    } catch (error) {
      if (error instanceof AiInvocationError) {
        if (error.code === "deadline" || error.code === "request-timeout") throw new AiProviderError("timeout", `请求超时：${timeoutMs}ms 内未完成`);
        if (error.code === "http") throw new AiProviderError("http", `HTTP ${error.status}`, { status: error.status, requestId: error.requestId });
        if (error.code === "network") throw new AiProviderError(error.networkKind ?? "unknown", error.networkKind === "refused" ? "连接失败 ECONNREFUSED" : "网络连接失败");
      }
      throw new AiProviderError("response", "响应缺少有效 choices[0].message.content 或成功终态，或超出调用预算");
    }
  };
}

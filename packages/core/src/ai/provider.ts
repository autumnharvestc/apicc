import { classifyNetworkError, type HttpErrorKind } from "../http/client.js";
import { DEFAULT_AI_TIMEOUT_MS, type AiChatMessage, type AiProvider, type AiProviderConfig } from "./types.js";

export type AiProviderErrorKind = HttpErrorKind | "http" | "response";

/** provider 错误归一化：message 恒含 "AI provider 请求失败"与 kind；http 类携带状态码与响应片段。 */
export class AiProviderError extends Error {
  readonly kind: AiProviderErrorKind;
  readonly status?: number;
  readonly bodySnippet?: string;

  constructor(
    kind: AiProviderErrorKind,
    detail: string,
    opts?: { status?: number; bodySnippet?: string; cause?: unknown },
  ) {
    super(`AI provider 请求失败（${kind}）: ${detail}`, { cause: opts?.cause });
    this.name = "AiProviderError";
    this.kind = kind;
    this.status = opts?.status;
    this.bodySnippet = opts?.bodySnippet;
  }
}

/** 响应片段截断长度（错误信息里只带片段，不整段回显）。 */
const SNIPPET_MAX = 200;

function snippet(text: string): string {
  return text.slice(0, SNIPPET_MAX);
}

export interface AiProviderDeps {
  /** 注入 fetch（测试替身；缺省用全局 fetch，CI 零真实网络）。 */
  fetch?: typeof fetch;
}

/**
 * OpenAI 兼容 provider（D1）：POST {baseUrl}/chat/completions，Bearer apiKey，
 * response_format: {type:"json_object"}，超时经 AbortSignal（缺省 60s，裁定①）。
 * baseUrl 末尾斜杠归一（裁定②）；缺 apiKey/baseUrl/model 构造时即报错（fail-fast）。
 */
export function createAiProvider(config: AiProviderConfig, deps: AiProviderDeps = {}): AiProvider {
  const baseUrl = config.baseUrl.replace(/\/+$/, ""); // 裁定②
  if (!baseUrl) throw new Error("AI provider 配置缺 baseUrl");
  if (!config.apiKey) throw new Error("AI provider 配置缺 apiKey");
  if (!config.model) throw new Error("AI provider 配置缺 model");
  const timeoutMs = config.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
  const doFetch = deps.fetch ?? globalThis.fetch;

  return async function chat(messages: AiChatMessage[]): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model,
            messages,
            response_format: { type: "json_object" },
          }),
          signal: ctrl.signal,
        });
      } catch (e) {
        if (ctrl.signal.aborted || (e as Error)?.name === "AbortError") {
          throw new AiProviderError("timeout", `请求超时：${timeoutMs}ms 内未完成`);
        }
        throw new AiProviderError(classifyNetworkError(e), (e as Error)?.message ?? String(e), { cause: e });
      }

      const text = await res.text();
      if (!res.ok) {
        // 归一化错误：含状态码与响应片段
        throw new AiProviderError("http", `HTTP ${res.status}，响应片段: ${snippet(text)}`, {
          status: res.status,
          bodySnippet: snippet(text),
        });
      }

      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch (e) {
        throw new AiProviderError("response", `响应体不是合法 JSON，片段: ${snippet(text)}`, { cause: e });
      }
      const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.length === 0) {
        throw new AiProviderError("response", `响应缺少 choices[0].message.content 字符串，片段: ${snippet(text)}`);
      }
      return content;
    } finally {
      clearTimeout(timer); // 不给事件循环留悬挂定时器
    }
  };
}

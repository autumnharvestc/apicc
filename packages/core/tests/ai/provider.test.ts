import { describe, expect, it, vi } from "vitest";

import { AiProviderError, createAiProvider } from "../../src/ai/provider.js";
import { DEFAULT_AI_TIMEOUT_MS, type AiChatMessage } from "../../src/ai/types.js";

const messages: AiChatMessage[] = [{ role: "user", content: "请给出一些建议" }];

/** 捕获请求并返回 OpenAI 兼容 chat completions 形状的替身（零真实网络）。 */
function captureFetch(status = 200, body = JSON.stringify({ choices: [{ message: { content: "{}" } }] })) {
  const captured: Array<{ url: string; init: RequestInit }> = [];
  const impl: typeof fetch = async (input, init) => {
    captured.push({ url: String(input), init: init ?? {} });
    return new Response(body, { status });
  };
  return { impl, captured };
}

describe("createAiProvider（D1 provider 抽象）", () => {
  it("请求拼装：URL = baseUrl + /chat/completions、Bearer 头、model、messages、response_format json_object、超时 AbortSignal", async () => {
    const { impl, captured } = captureFetch();
    const provider = createAiProvider(
      { baseUrl: "https://ai.example.com/v1/", apiKey: "sk-test", model: "test-model" },
      { fetch: impl },
    );

    await provider(messages);

    expect(captured).toHaveLength(1);
    // 裁定②：baseUrl 末尾斜杠归一
    expect(captured[0]!.url).toBe("https://ai.example.com/v1/chat/completions");
    const headers = captured[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test");
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(captured[0]!.init.body as string) as {
      model: string;
      messages: AiChatMessage[];
      response_format: { type: string };
    };
    expect(body.model).toBe("test-model");
    expect(body.messages).toEqual(messages);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(captured[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("多级末尾斜杠同样归一", async () => {
    const { impl, captured } = captureFetch();
    const provider = createAiProvider(
      { baseUrl: "https://ai.example.com/v1///", apiKey: "k", model: "m" },
      { fetch: impl },
    );
    await provider(messages);
    expect(captured[0]!.url).toBe("https://ai.example.com/v1/chat/completions");
  });

  it("timeoutMs 缺省 60_000（裁定①）", () => {
    expect(DEFAULT_AI_TIMEOUT_MS).toBe(60_000);
  });

  it("超时经 AbortSignal 中断并归一化为 timeout 错误", async () => {
    const impl: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
        );
      });
    const provider = createAiProvider(
      { baseUrl: "https://ai.example.com", apiKey: "k", model: "m", timeoutMs: 25 },
      { fetch: impl },
    );
    const err = await provider(messages).then(
      () => { throw new Error("应当超时"); },
      (e: unknown) => e as AiProviderError,
    );
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.kind).toBe("timeout");
    expect(err.message).toMatch(/超时/);
  });

  it("非 200 → 归一化错误含状态码与响应片段", async () => {
    const { impl } = captureFetch(401, '{"error":{"message":"Invalid API key"}}');
    const provider = createAiProvider({ baseUrl: "https://ai.example.com", apiKey: "bad", model: "m" }, { fetch: impl });
    const err = await provider(messages).then(
      () => { throw new Error("应当失败"); },
      (e: unknown) => e as AiProviderError,
    );
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.kind).toBe("http");
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/401/);
    expect(err.message).toMatch(/Invalid API key/);
  });

  it("非 200 且响应体非 JSON 时仍携带响应片段", async () => {
    const { impl } = captureFetch(500, "Internal Server Error");
    const provider = createAiProvider({ baseUrl: "https://ai.example.com", apiKey: "k", model: "m" }, { fetch: impl });
    const err = await provider(messages).then(
      () => { throw new Error("应当失败"); },
      (e: unknown) => e as AiProviderError,
    );
    expect(err.kind).toBe("http");
    expect(err.message).toMatch(/500/);
    expect(err.message).toMatch(/Internal Server Error/);
  });

  it("网络错误归一化（携带分类 kind 与原始消息）", async () => {
    const impl: typeof fetch = async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
    };
    const provider = createAiProvider({ baseUrl: "https://ai.example.com", apiKey: "k", model: "m" }, { fetch: impl });
    const err = await provider(messages).then(
      () => { throw new Error("应当失败"); },
      (e: unknown) => e as AiProviderError,
    );
    expect(err).toBeInstanceOf(AiProviderError);
    expect(err.kind).toBe("refused");
    expect(err.message).toMatch(/ECONNREFUSED/);
  });

  it("200 但响应体形状非法（缺 choices/content、content 非字符串或为空）→ 归一化 response 错误", async () => {
    const cases: Array<{ body: string; fragment: string }> = [
      { body: "{}", fragment: "choices" },
      { body: '{"choices":[{"message":{"content":123}}]}', fragment: "content" },
      { body: '{"choices":[{"message":{"content":""}}]}', fragment: "content" },
    ];
    for (const c of cases) {
      const { impl } = captureFetch(200, c.body);
      const provider = createAiProvider({ baseUrl: "https://ai.example.com", apiKey: "k", model: "m" }, { fetch: impl });
      const err = await provider(messages).then(
        () => { throw new Error("应当失败"); },
        (e: unknown) => e as AiProviderError,
      );
      expect(err.kind).toBe("response");
      expect(err.message).toMatch(new RegExp(c.fragment));
    }
  });

  it("缺省 timeoutMs 接线（顺修④）：不传 timeoutMs 时 DEFAULT_AI_TIMEOUT_MS 生效——假定时器推进 60s 触发超时", async () => {
    vi.useFakeTimers();
    try {
      const impl: typeof fetch = (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })),
          );
        });
      const provider = createAiProvider({ baseUrl: "https://ai.example.com", apiKey: "k", model: "m" }, { fetch: impl });
      const settled = provider(messages).then(
        () => { throw new Error("应当超时"); },
        (e: unknown) => e as AiProviderError,
      );
      await vi.advanceTimersByTimeAsync(DEFAULT_AI_TIMEOUT_MS);
      const err = await settled;
      expect(err).toBeInstanceOf(AiProviderError);
      expect(err.kind).toBe("timeout");
      expect(err.message).toMatch(/60000/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("缺 apiKey → 构造时即报错（fail-fast）", () => {
    expect(() => createAiProvider({ baseUrl: "https://ai.example.com", apiKey: "", model: "m" })).toThrow(/apiKey/);
  });

  it("缺 baseUrl / 缺 model 同样构造即报错", () => {
    expect(() => createAiProvider({ baseUrl: "", apiKey: "k", model: "m" })).toThrow(/baseUrl/);
    expect(() => createAiProvider({ baseUrl: "https://ai.example.com", apiKey: "k", model: "" })).toThrow(/model/);
  });

  it("成功时返回 choices[0].message.content 字符串", async () => {
    const { impl } = captureFetch(200, JSON.stringify({ choices: [{ message: { content: '{"cases":[]}' } }] }));
    const provider = createAiProvider({ baseUrl: "https://ai.example.com", apiKey: "k", model: "m" }, { fetch: impl });
    await expect(provider(messages)).resolves.toBe('{"cases":[]}');
  });
});

describe("index 导出面（裁定⑦）", () => {
  it("createAiProvider / suggestCases 从 core index 可用", async () => {
    const mod = await import("../../src/index.js");
    expect(typeof mod.createAiProvider).toBe("function");
    expect(typeof mod.suggestCases).toBe("function");
  });
});

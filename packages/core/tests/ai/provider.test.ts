import { describe, expect, it, vi } from "vitest";

import { AiProviderError, createAiProvider } from "../../src/ai/provider.js";
import { DEFAULT_AI_TIMEOUT_MS, type AiChatMessage } from "../../src/ai/types.js";
import { payload } from "./invocation.fixture.js";

const messages: AiChatMessage[] = [{ role: "user", content: "请给出一些建议" }];

/** 捕获请求并返回 OpenAI 兼容 chat completions 形状的替身（零真实网络）。 */
function captureFetch(status = 200, body = JSON.stringify(payload("openai-chat-completions", "{}"))) {
  const captured: Array<{ url: string; init: RequestInit }> = [];
  const impl: typeof fetch = async (input, init) => {
    captured.push({ url: String(input), init: init ?? {} });
    return new Response(body, { status });
  };
  return { impl, captured };
}

describe("createAiProvider（D1 provider 抽象）", () => {
  // Catch missing redirect:error and accidental propagation of a redirect response body.
  // Only the external HTTP transport is replaced; provider request/error handling stays real.
  it("redirect_is_rejected_and_error_body_not_echoed", async () => {
    const secret = "redirect-body-private-prompt-and-sk-secret";
    const { impl, captured } = captureFetch(302, secret);
    const provider = createAiProvider(
      { baseUrl: "https://ai.example.com/v1", apiKey: "sk-secret", model: "test-model" },
      { fetch: impl },
    );

    const error = await provider(messages).catch((value: unknown) => value);

    expect(captured[0]!.init.redirect).toBe("error");
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

  // Catch error-body disclosure independently, so the redirect assertion cannot hide it.
  it.each([
    { status: 401, body: '{"error":{"message":"private-prompt sk-secret-401"}}', secret: "private-prompt sk-secret-401" },
    { status: 500, body: "<html>private-prompt sk-secret-500</html>", secret: "private-prompt sk-secret-500" },
  ])("HTTP $status exposes status without echoing the upstream body", async ({ status, body, secret }) => {
    const { impl } = captureFetch(status, body);
    const provider = createAiProvider(
      { baseUrl: "https://ai.example.com/v1", apiKey: "sk-secret", model: "test-model" },
      { fetch: impl },
    );

    const error = await provider(messages).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(AiProviderError);
    expect(error).toMatchObject({ kind: "http", status });
    expect(String(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(secret);
  });

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

  it("非 200 → 归一化错误保留状态码且隐藏响应正文", async () => {
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
    expect(err.message).not.toMatch(/Invalid API key/);
  });

  it("非 200 且响应体非 JSON 时保留状态码且隐藏响应正文", async () => {
    const { impl } = captureFetch(500, "Internal Server Error");
    const provider = createAiProvider({ baseUrl: "https://ai.example.com", apiKey: "k", model: "m" }, { fetch: impl });
    const err = await provider(messages).then(
      () => { throw new Error("应当失败"); },
      (e: unknown) => e as AiProviderError,
    );
    expect(err.kind).toBe("http");
    expect(err.message).toMatch(/500/);
    expect(err.message).not.toMatch(/Internal Server Error/);
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
    const { impl } = captureFetch(200, JSON.stringify(payload("openai-chat-completions", '{"cases":[]}')));
    const provider = createAiProvider({ baseUrl: "https://ai.example.com", apiKey: "k", model: "m" }, { fetch: impl });
    await expect(provider(messages)).resolves.toBe('{"cases":[]}');
  });
});

describe("legacy provider uses the bounded invocation host", () => {
  it("complete-looking content without a success terminal is rejected", async () => {
    const { impl } = captureFetch(200, JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: '{"cases":[]}' } }] }));
    const provider = createAiProvider({ baseUrl: "https://ai.example.com/v1", apiKey: "test", model: "m" }, { fetch: impl });
    await expect(provider(messages)).rejects.toMatchObject({ kind: "response" });
  });
  it("malformed JSON never exposes response text or a parse cause", async () => {
    const { impl } = captureFetch(200, "private-prompt-secret");
    const provider = createAiProvider({ baseUrl: "https://ai.example.com/v1", apiKey: "test", model: "m" }, { fetch: impl });
    const error = await provider(messages).catch((e: unknown) => e) as Error;
    expect(String(error)).not.toContain("private-prompt-secret"); expect(error.cause).toBeUndefined();
  });
  it("network classification does not expose the original message or cause", async () => {
    const provider = createAiProvider({ baseUrl: "https://ai.example.com/v1", apiKey: "test", model: "m" }, { fetch: async () => { throw Object.assign(new Error("private-secret ECONNREFUSED"), { code: "ECONNREFUSED", cause: new Error("private-prompt") }); } });
    const error = await provider(messages).catch((e: unknown) => e) as Error;
    expect(error).toMatchObject({ kind: "refused" }); expect(String(error)).not.toContain("private-secret"); expect(error.cause).toBeUndefined();
  });
  it("legacy output cannot exceed the same 4 MiB business-text limit", async () => {
    const { impl } = captureFetch(200, JSON.stringify(payload("openai-chat-completions", "x".repeat(4 * 1024 * 1024 + 1))));
    const provider = createAiProvider({ baseUrl: "https://ai.example.com/v1", apiKey: "test", model: "m" }, { fetch: impl });
    const error = await provider(messages).then(() => ({ kind: "unexpected-success" }), (e: unknown) => e);
    expect(error).toMatchObject({ kind: "response" });
  });
  it("legacy 25ms timeout interrupts body reading as well as fetch", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = false;
      const provider = createAiProvider({ baseUrl: "https://ai.example.com/v1", apiKey: "test", model: "m", timeoutMs: 25 }, { fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
      const operation = provider(messages).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(25);
      const outcome = await Promise.race([operation, Promise.resolve({ kind: "still-reading" })]);
      expect(outcome).toMatchObject({ kind: "timeout" }); expect(cancelled).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

describe("index 导出面（裁定⑦）", () => {
  // 全量 barrel 动态 import 在整仓并行负载下 Windows 冷加载可超默认 5s（既有备案，
  // 与桌面端 antd barrel 同因）——单用例放宽至 30s，只影响本用例超时上限。
  it("createAiProvider / suggestCases 从 core index 可用", async () => {
    const mod = await import("../../src/index.js");
    expect(typeof mod.createAiProvider).toBe("function");
    expect(typeof mod.suggestCases).toBe("function");
  }, 30000);
});

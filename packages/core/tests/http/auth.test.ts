import { describe, expect, it } from "vitest";
import { builtinAuthProviders } from "../../src/http/auth.js";
import type { ExecutableRequest } from "../../src/plugin/types.js";

function req(): ExecutableRequest {
  return { protocol: "http", method: "GET", url: "http://x/", headers: {}, query: [], auth: { kind: "none" } };
}

describe("内置认证器", () => {
  it("运行时 apikey 使用已物化的 name 字段，不再读取旧 key 别名", () => {
    const provider = builtinAuthProviders.find((candidate) => candidate.type === "apikey");
    expect(provider).toBeDefined();
    if (!provider) return;
    const r = req();
    provider.apply(r, { kind: "apikey", name: "X-Key", placement: "header", value: "bound-value" });

    expect(r.headers["X-Key"]).toBe("bound-value");
  });

  it("bearer 写入由唯一物化器解析好的 Authorization 值", () => {
    const provider = builtinAuthProviders.find((p) => p.type === "bearer")!;
    const r = req();
    provider.apply(r, { kind: "bearer", token: "secret" });
    expect(r.headers["Authorization"]).toBe("Bearer secret");
  });

  it("bearer provider 不再二次解析或劫持已物化的普通值", () => {
    const provider = builtinAuthProviders.find((p) => p.type === "bearer")!;
    const r = req();
    provider.apply(r, { kind: "bearer", token: "plain-token" });
    expect(r.headers["Authorization"]).toBe("Bearer plain-token");
  });

  it("basic 写入 base64 凭证", () => {
    const provider = builtinAuthProviders.find((p) => p.type === "basic")!;
    const r = req();
    provider.apply(r, { kind: "basic", username: "u", password: "p" });
    expect(r.headers["Authorization"]).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
  });

  it("apikey 支持 header 与 query 两种位置", () => {
    const provider = builtinAuthProviders.find((p) => p.type === "apikey")!;
    const r1 = req();
    provider.apply(r1, { kind: "apikey", name: "X-Key", value: "v", placement: "header" });
    expect(r1.headers["X-Key"]).toBe("v");
    const r2 = req();
    provider.apply(r2, { kind: "apikey", name: "key", value: "v", placement: "query" });
    expect(r2.query).toContainEqual({ key: "key", value: "v", enabled: true });
  });
});

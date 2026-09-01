import { describe, expect, it } from "vitest";
import { builtinAuthProviders } from "../../src/http/auth.js";
import type { ExecutableRequest } from "../../src/plugin/types.js";

function req(): ExecutableRequest {
  return { method: "GET", url: "http://x/", headers: {}, query: [] };
}

describe("内置认证器", () => {
  it("bearer 写入 Authorization 头，值经变量解析", () => {
    const provider = builtinAuthProviders.find((p) => p.type === "bearer")!;
    const r = req();
    provider.apply(r, { type: "bearer", token: "{{tok}}", placement: "header" }, (n) => (n === "tok" ? "secret" : undefined));
    expect(r.headers["Authorization"]).toBe("Bearer secret");
  });

  it("basic 写入 base64 凭证", () => {
    const provider = builtinAuthProviders.find((p) => p.type === "basic")!;
    const r = req();
    provider.apply(r, { type: "basic", username: "u", password: "p", placement: "header" }, () => undefined);
    expect(r.headers["Authorization"]).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
  });

  it("apikey 支持 header 与 query 两种位置", () => {
    const provider = builtinAuthProviders.find((p) => p.type === "apikey")!;
    const r1 = req();
    provider.apply(r1, { type: "apikey", key: "X-Key", value: "v", placement: "header" }, () => undefined);
    expect(r1.headers["X-Key"]).toBe("v");
    const r2 = req();
    provider.apply(r2, { type: "apikey", key: "key", value: "v", placement: "query" }, () => undefined);
    expect(r2.query).toContainEqual({ key: "key", value: "v", enabled: true });
  });
});

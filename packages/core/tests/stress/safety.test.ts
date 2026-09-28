import { describe, expect, it } from "vitest";
import { assertStressTargetAllowed, normalizeStressOrigin } from "../../src/stress/safety.js";

describe("压测目标安全裁定", () => {
  it("规范化 HTTP(S) origin，处理大小写、默认端口和 IPv6", () => {
    expect(normalizeStressOrigin("HTTPS://Example.COM:443/path?q=1#x")).toBe("https://example.com");
    expect(normalizeStressOrigin("http://[2001:DB8::1]:80/v1")).toBe("http://[2001:db8::1]");
    expect(normalizeStressOrigin("https://[::1]:8443/x")).toBe("https://[::1]:8443");
  });

  it.each(["ftp://example.com/x", "//example.com/x", "not-a-url"])("拒绝非 HTTP(S) 目标 %s", (url) => {
    expect(() => normalizeStressOrigin(url)).toThrow(/HTTP\(S\)|origin/);
  });

  it("loopback 也必须显式确认，确认 origin 必须精确匹配规范化结果", () => {
    expect(() => assertStressTargetAllowed({ url: "http://127.0.0.1:80/x", concurrency: 1 }))
      .toThrow(expect.objectContaining({ code: "target_confirmation_required", targetOrigin: "http://127.0.0.1" }));
    expect(assertStressTargetAllowed({
      url: "HTTP://127.0.0.1/x", confirmedTargetOrigins: ["http://127.0.0.1:80"], concurrency: 1,
    })).toMatchObject({ targetOrigin: "http://127.0.0.1", loopback: true, confirmation: "explicit" });
  });

  it("trusted 放行但 denied 永远优先", () => {
    const policy = { trustedOrigins: ["https://example.com"], deniedOrigins: ["HTTPS://EXAMPLE.COM:443/blocked"] };
    expect(() => assertStressTargetAllowed({ url: "https://example.com/x", policy, concurrency: 1 }))
      .toThrow(expect.objectContaining({ code: "target_denied", targetOrigin: "https://example.com" }));
    expect(assertStressTargetAllowed({ url: "https://example.com/x", policy: { trustedOrigins: ["https://example.com"] }, concurrency: 1 }))
      .toMatchObject({ confirmation: "project-policy" });
  });

  it("强制执行并发和项目 RPS 上限", () => {
    expect(() => assertStressTargetAllowed({ url: "https://example.com/x", policy: { trustedOrigins: ["https://example.com"], maxConcurrency: 2 }, concurrency: 3 }))
      .toThrow(expect.objectContaining({ code: "concurrency_policy_exceeded" }));
    expect(() => assertStressTargetAllowed({ url: "https://example.com/x", policy: { trustedOrigins: ["https://example.com"], maxRps: 5 }, maxRps: 6, concurrency: 1 }))
      .toThrow(expect.objectContaining({ code: "max_rps_policy_exceeded" }));
  });
});

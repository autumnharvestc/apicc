import { describe, expect, it } from "vitest";
import { createPluginRegistry } from "../../src/plugin/registry.js";
import type { ProtocolClient } from "../../src/plugin/types.js";

const fakeAssert = {
  op: "eq",
  evaluate: (actual: unknown, expected?: string) => ({
    pass: String(actual) === expected,
    message: "eq",
  }),
};

describe("PluginRegistry", () => {
  it("注册、获取、注销断言操作符", () => {
    const reg = createPluginRegistry();
    reg.registerAssert(fakeAssert);
    expect(reg.getAssert("eq")).toBe(fakeAssert);
    reg.registerAssert({ ...fakeAssert, op: "neq" });
    expect(reg.listAsserts()).toHaveLength(2);
  });

  it("同名覆盖时保留最后注册者", () => {
    const reg = createPluginRegistry();
    reg.registerScriptEngine({ language: "javascript", run: () => {} });
    const second = { language: "javascript", run: () => { /* v2 */ } };
    reg.registerScriptEngine(second);
    expect(reg.getScriptEngine("javascript")).toBe(second);
  });

  it("不同 name 的协议客户端互不覆盖", () => {
    const reg = createPluginRegistry();
    const first: ProtocolClient = {
      name: "first",
      canHandle: () => true,
      execute: async () => ({ status: 200, headers: {}, bodyText: "", timeMs: 0 }),
    };
    reg.registerProtocol(first);
    reg.registerProtocol({ name: "second", canHandle: () => false, execute: async () => ({ status: 200, headers: {}, bodyText: "", timeMs: 0 }) });
    expect(reg.getProtocol({ method: "GET", url: "https://example.com", headers: {}, query: [] })).toBe(first);
  });

  it("plugin(def) 执行 setup 完成自注册", () => {
    const reg = createPluginRegistry();
    reg.plugin({
      name: "my-assert", version: "1.0.0",
      setup(ctx) { ctx.registry.registerAssert(fakeAssert); },
    });
    expect(reg.getAssert("eq")).toBeDefined();
  });
});

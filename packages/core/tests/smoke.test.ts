import { describe, expect, it } from "vitest";
import { version } from "../src/index.js";
import { createDefaultRegistry } from "../src/index.js";

describe("smoke", () => {
  it("exports version", () => {
    expect(version).toBe("0.1.0");
  });

  it("默认注册中心已装配全部内置插件", () => {
    const reg = createDefaultRegistry();
    expect(reg.getStorage()).toBeDefined();
    expect(reg.getScriptEngine("javascript")).toBeDefined();
    expect(reg.getReporter("html")).toBeDefined();
    expect(reg.getReporter("junit")).toBeDefined();
    expect(reg.listImporters()).toHaveLength(2);
    expect(reg.listAsserts().length).toBeGreaterThanOrEqual(7);
  });
});

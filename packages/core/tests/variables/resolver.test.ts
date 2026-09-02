import { describe, expect, it } from "vitest";
import { CyclicVariableError, createVariableResolver } from "../../src/variables/resolver.js";

describe("createVariableResolver", () => {
  it("优先级：运行时 > 环境 > 集合 > 项目 > 全局", () => {
    const r = createVariableResolver({
      layers: [
        { host: "env.example" },
        { host: "collection.example" },
        { host: "project.example", onlyProject: "p" },
        { onlyGlobal: "g" },
      ],
    });
    expect(r.get("host")).toBe("env.example");
    r.setRuntime("host", "runtime.example");
    expect(r.get("host")).toBe("runtime.example");
    expect(r.get("onlyProject")).toBe("p");
    expect(r.get("onlyGlobal")).toBe("g");
    expect(r.get("missing")).toBeUndefined();
  });

  it("resolve 替换全部占位符，未知变量保留原文", () => {
    const r = createVariableResolver({ layers: [{ host: "api.example" }] });
    expect(r.resolve("https://{{host}}/x/{{unknownVar}}")).toBe("https://api.example/x/{{unknownVar}}");
  });

  it("嵌套引用递归解析", () => {
    const r = createVariableResolver({ layers: [{ a: "{{b}}/x", b: "root" }] });
    expect(r.resolve("{{a}}")).toBe("root/x");
  });

  it("循环引用抛 CyclicVariableError 并含链路", () => {
    const r = createVariableResolver({ layers: [{ a: "{{b}}", b: "{{a}}" }] });
    expect(() => r.resolve("{{a}}")).toThrow(CyclicVariableError);
    expect(() => r.resolve("{{a}}")).toThrow(/a → b → a/);
  });

  it("内置动态变量可用", () => {
    const r = createVariableResolver({ layers: [] });
    expect(Number(r.get("$timestamp"))).toBeGreaterThan(0);
    expect(r.get("$uuid")).toMatch(/^[0-9a-f-]{36}$/);
    expect(r.get("$isoTimestamp")).toMatch(/^20\d{2}-/);
    const n = Number(r.get("$randomInt"));
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThanOrEqual(1000);
  });

  it("动态变量可经 {{ }} 占位符使用", () => {
    const r = createVariableResolver({ layers: [] });
    expect(r.resolve("{{$timestamp}}")).toMatch(/^\d+$/);
    expect(r.resolve("{{$uuid}}")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("Object.prototype 属性名不参与解析", () => {
    const r = createVariableResolver({ layers: [] });
    expect(r.resolve("{{toString}}")).toBe("{{toString}}");
    expect(r.get("constructor")).toBeUndefined();
  });

  it("占位符允许两侧空白", () => {
    const r = createVariableResolver({ layers: [{ host: "api.example" }] });
    expect(r.resolve("{{ host }}")).toBe("api.example");
  });

  it("clearRuntime 后回落低层", () => {
    const r = createVariableResolver({ layers: [{ host: "env.example" }] });
    r.setRuntime("host", "runtime.example");
    expect(r.get("host")).toBe("runtime.example");
    r.clearRuntime();
    expect(r.get("host")).toBe("env.example");
  });
});

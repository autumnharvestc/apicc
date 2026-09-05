import { describe, expect, it } from "vitest";
import { builtinAssertOperators } from "../../src/assert/operators.js";
import { createDefaultRegistry } from "../../src/index.js";

const xpathOp = builtinAssertOperators.find((o) => o.op === "xpath");

describe("xpath 断言操作符（M5 D6，裁定 B）", () => {
  it("注册进 builtinAssertOperators 并可经 createDefaultRegistry 取用", () => {
    expect(xpathOp).toBeDefined();
    expect(createDefaultRegistry().getAssert("xpath")).toBe(xpathOp);
  });

  it("表达式[==期望值]：提取节点文本并比较相等（字符串化）", () => {
    const xml = '<User><id>42</id><id>43</id><name>m5</name></User>';
    expect(xpathOp!.evaluate(xml, "//id[==42]").pass).toBe(true);
    expect(xpathOp!.evaluate(xml, "//name[==m5]").pass).toBe(true);
    expect(xpathOp!.evaluate(xml, "//id[==43]").pass).toBe(false);
    // 数字结果同样字符串化比较：count() 返回 number（此处 2 个 id 节点）
    expect(xpathOp!.evaluate(xml, "count(//id)[==2]").pass).toBe(true);
  });

  it("仅表达式（无期望值）→ 存在性断言", () => {
    const xml = '<User><id>42</id></User>';
    expect(xpathOp!.evaluate(xml, "//id").pass).toBe(true);
    expect(xpathOp!.evaluate(xml, "//missing").pass).toBe(false);
    // 布尔结果按真值口径
    expect(xpathOp!.evaluate(xml, "count(//id) > 0").pass).toBe(true);
    expect(xpathOp!.evaluate(xml, "count(//id) > 9").pass).toBe(false);
  });

  it("多节点取首个（口径钉住）", () => {
    const xml = '<Users><id>1</id><id>2</id></Users>';
    expect(xpathOp!.evaluate(xml, "//id[==1]").pass).toBe(true);
    expect(xpathOp!.evaluate(xml, "//id[==2]").pass).toBe(false);
  });

  it("XML 解析失败 → 断言失败带原因，不抛", () => {
    const r = xpathOp!.evaluate("<User><id>42</id>", "//id[==42]");
    expect(r.pass).toBe(false);
    expect(r.message).toContain("解析失败");
  });

  it("表达式语法错误 → 断言失败带原因，不抛", () => {
    const r = xpathOp!.evaluate("<User><id>42</id></User>", "//id[");
    expect(r.pass).toBe(false);
    expect(r.message).toContain("表达式");
  });

  it("命名空间前缀 MVP 不处理（字面表达式）→ 断言失败带原因，不抛", () => {
    const r = xpathOp!.evaluate('<ns:User xmlns:ns="urn:x"><id>42</id></ns:User>', "//ns:id[==42]");
    expect(r.pass).toBe(false);
    expect(typeof r.message).toBe("string");
  });

  it("actual 非文本（undefined/数字/对象）→ 失败带原因不抛", () => {
    for (const bad of [undefined, 42, { id: 42 }, null]) {
      const r = xpathOp!.evaluate(bad, "//id[==42]");
      expect(r.pass, String(bad)).toBe(false);
      expect(r.message.length).toBeGreaterThan(0);
    }
  });

  it("expected 缺失（无表达式）→ 失败不抛", () => {
    const r = xpathOp!.evaluate("<User><id>42</id></User>", undefined);
    expect(r.pass).toBe(false);
    expect(r.message.length).toBeGreaterThan(0);
  });

  it("属性节点提取（textContent 口径）", () => {
    const r = xpathOp!.evaluate('<User id="9"/>', "//User/@id[==9]");
    expect(r.pass).toBe(true);
  });

  it("表达式内含谓词（方括号）且带期望值 → 取最后一个 [== 分隔", () => {
    const xml = '<Users><User id="1"><id>10</id></User><User id="2"><id>20</id></User></Users>';
    expect(xpathOp!.evaluate(xml, "//User[@id='2']/id[==20]").pass).toBe(true);
    expect(xpathOp!.evaluate(xml, "//User[@id='2']/id[==10]").pass).toBe(false);
  });
});

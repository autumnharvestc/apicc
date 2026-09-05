import { describe, expect, it } from "vitest";
import type { AssertOperator } from "../../src/plugin/types.js";
import { builtinAssertOperators } from "../../src/assert/operators.js";
import { itCompliesWithAssertOperatorContract } from "../contracts/assertOperator.contract.js";

const eq = builtinAssertOperators.find((o) => o.op === "eq")!;

// 契约正向探针固定调用 evaluate("a", "a")；对「实参与期望相同时语义上必须判 false」的操作符
// （neq 及数值比较类），按任务 4 修复轮裁定，在本测试内以该操作符的合规匹配输入包装后接入契约：
// 仅将探针输入映射为本操作符的合规匹配对，其余输入直通原操作符。
// xpath 同类：actual 须为 XML 文本、"a" 非法 → 以合法 XML+表达式接入探针。
const compliantProbe: Record<string, [actual: unknown, expected: string]> = {
  neq: ["a", "b"],
  lt: ["9", "10"],
  gt: ["10", "9"],
  lte: ["9", "10"],
  gte: ["10", "10"],
  xpath: ["<User><id>42</id></User>", "//id[==42]"],
};

function toContractView(op: AssertOperator): AssertOperator {
  const probe = compliantProbe[op.op];
  if (!probe) return op;
  return {
    op: op.op,
    evaluate: (actual, expected) =>
      actual === "a" && expected === "a" ? op.evaluate(probe[0], probe[1]) : op.evaluate(actual, expected),
  };
}

describe("内置断言操作符", () => {
  it("eq 数值与字符串", () => {
    expect(eq.evaluate(200, "200").pass).toBe(true);
    expect(eq.evaluate("abc", "abd").pass).toBe(false);
  });

  it("contains 适用于字符串与数组", () => {
    const contains = builtinAssertOperators.find((o) => o.op === "contains")!;
    expect(contains.evaluate("hello world", "world").pass).toBe(true);
    expect(contains.evaluate([1, 2], "2").pass).toBe(true);
    expect(contains.evaluate("hello", "x").pass).toBe(false);
  });

  it("lt/gte 数值比较", () => {
    const lt = builtinAssertOperators.find((o) => o.op === "lt")!;
    const gte = builtinAssertOperators.find((o) => o.op === "gte")!;
    expect(lt.evaluate(99, "100").pass).toBe(true);
    expect(gte.evaluate(100, "100").pass).toBe(true);
  });

  it("neq 不等成立", () => {
    const neq = builtinAssertOperators.find((o) => o.op === "neq")!;
    expect(neq.evaluate("a", "b").pass).toBe(true);
  });

  it("expected 缺失时全部操作符 fail", () => {
    for (const op of builtinAssertOperators) {
      expect(op.evaluate("hello", undefined).pass, op.op).toBe(false);
    }
  });

  for (const op of builtinAssertOperators) {
    itCompliesWithAssertOperatorContract(toContractView(op));
  }
});

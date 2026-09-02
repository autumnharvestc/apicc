import { expect, it } from "vitest";
import type { AssertOperator } from "../../src/plugin/types.js";

/** 断言操作符契约：任何内置/第三方 AssertOperator 都必须通过。 */
export function itCompliesWithAssertOperatorContract(op: AssertOperator) {
  it(`契约: ${op.op} 对 undefined actual 返回 fail 且不抛错`, () => {
    const r = op.evaluate(undefined, "1");
    expect(r.pass).toBe(false);
    expect(typeof r.message).toBe("string");
  });
  it(`契约: ${op.op} 以匹配输入调用时 pass === true`, () => {
    expect(op.evaluate("a", "a").pass).toBe(true);
  });
  it(`契约: ${op.op} 的 message 非空`, () => {
    expect(op.evaluate("a", "a").message.length).toBeGreaterThan(0);
  });
}

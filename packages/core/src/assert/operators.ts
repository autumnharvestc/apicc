import type { AssertOperator } from "../plugin/types.js";

function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

function make(op: string, test: (actual: unknown, expected: string | undefined) => boolean): AssertOperator {
  return {
    op,
    evaluate(actual, expected) {
      // fail-closed：actual 或 expected 缺失一律 fail（neq/contains 等若不拦截会把缺值误判为通过）
      if (actual === undefined || expected === undefined) {
        const missing = actual === undefined ? "缺少实际值" : "缺少期望值";
        return { pass: false, message: `${op} 断言失败: ${missing}` };
      }
      const pass = test(actual, expected);
      return { pass, message: `${op} 断言${pass ? "通过" : "失败"}: actual=${JSON.stringify(actual)}, expected=${expected}` };
    },
  };
}

export const builtinAssertOperators: AssertOperator[] = [
  make("eq", (a, e) => (typeof a === "number" ? a === num(e) : String(a) === e)),
  make("neq", (a, e) => (typeof a === "number" ? a !== num(e) : String(a) !== e)),
  make("contains", (a, e) => Array.isArray(a) ? a.map(String).includes(e ?? "") : String(a).includes(e ?? "")),
  make("lt", (a, e) => num(a) < num(e)),
  make("gt", (a, e) => num(a) > num(e)),
  make("lte", (a, e) => num(a) <= num(e)),
  make("gte", (a, e) => num(a) >= num(e)),
];

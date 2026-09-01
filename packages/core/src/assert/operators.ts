import type { AssertOperator } from "../plugin/types.js";

function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}

function make(op: string, test: (actual: unknown, expected: string | undefined) => boolean): AssertOperator {
  return {
    op,
    evaluate(actual, expected) {
      // 契约：actual 为 undefined 一律 fail（neq 等不等式操作符若不拦截会误判 pass）
      const pass = actual !== undefined && test(actual, expected);
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

import { DOMParser } from "@xmldom/xmldom";
// xpath 包为 CommonJS 且具名导出不可被 cjs-module-lexer 静态探测——Node 原生 ESM（core dist
// 被桌面端/子进程加载）下具名导入会 SyntaxError，必须经默认导出解构（vitest interop 会掩盖此问题）。
import xpathDefault from "xpath";
import type { AssertOperator, AssertResult } from "../plugin/types.js";
import type { SelectedValue, SelectReturnType } from "xpath";

const { select, isArrayOfNodes } = xpathDefault as typeof import("xpath");

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

/**
 * xpath 断言操作符（M5 D6，裁定 B）：
 * - actual 为 XML 文本；expected 语法 `表达式` 或 `表达式[==期望值]`（相等比较字符串化）。
 *   分隔取最后一个 `[==`（表达式自身可含谓词方括号），期望值末尾 `]` 若存在剥离一枚。
 * - 仅表达式 → 存在性断言：节点集非空；标量按真值口径（布尔 false / 0 / NaN / 空串判失败）。
 * - 带 `==期望值` → 结果取首个值字符串化比较；节点集多节点取首个（口径钉住），
 *   节点取 textContent（元素/文本/属性统一口径）。
 * - XML 解析失败 / 表达式语法错误 / actual 非文本 / 期望值缺失 → 断言失败带原因，不抛。
 * - 命名空间 MVP 不处理：字面表达式，未绑定前缀走「表达式错误」失败路径（按需引入 useNamespaces）。
 */
const XPATH_EQ_SEP = "[==";

function stringifyXPathValue(v: NonNullable<SelectedValue>): string {
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  return v.textContent ?? "";
}

function xpathEvaluate(actual: unknown, expected: string | undefined): AssertResult {
  const fail = (reason: string): AssertResult => ({ pass: false, message: `xpath 断言失败: ${reason}` });
  if (typeof actual !== "string") {
    return fail(`actual 须为 XML 文本，实际为 ${actual === undefined ? "undefined" : typeof actual === "object" ? JSON.stringify(actual) : String(actual)}`);
  }
  if (expected === undefined) {
    return fail("缺少期望值（语法: 表达式[==期望值]）");
  }

  const sep = expected.lastIndexOf(XPATH_EQ_SEP);
  const expression = sep >= 0 ? expected.slice(0, sep) : expected;
  const expectedValue = sep >= 0 ? expected.slice(sep + XPATH_EQ_SEP.length).replace(/\]$/, "") : undefined;

  let doc: Node;
  try {
    // @xmldom/xmldom 与 xpath 包的 DOM 类型体系不同（后者引用 lib.dom），运行时兼容，此处桥接。
    doc = new DOMParser().parseFromString(actual, "text/xml") as unknown as Node;
  } catch (e) {
    return fail(`XML 解析失败: ${(e as Error)?.message ?? String(e)}`);
  }

  let result: SelectReturnType;
  try {
    result = select(expression, doc);
  } catch (e) {
    return fail(`xpath 表达式错误「${expression}」: ${(e as Error)?.message ?? String(e)}`);
  }

  const first: SelectedValue = isArrayOfNodes(result) ? result[0] : result;
  if (first === undefined || first === null) {
    return fail(`表达式「${expression}」无结果`);
  }

  if (expectedValue === undefined) {
    // 存在性：节点集非空（节点对象恒真值）即通过；标量按真值口径。
    const pass = typeof first === "boolean" ? first : Boolean(first);
    return { pass, message: `xpath 断言${pass ? "通过" : "失败"}: 表达式「${expression}」${pass ? "命中" : "未命中（标量真值为假）"}` };
  }

  const actualText = stringifyXPathValue(first);
  const pass = actualText === expectedValue;
  return {
    pass,
    message: `xpath 断言${pass ? "通过" : "失败"}: 表达式「${expression}」→ ${JSON.stringify(actualText)}, 期望 ${JSON.stringify(expectedValue)}`,
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
  { op: "xpath", evaluate: xpathEvaluate },
];

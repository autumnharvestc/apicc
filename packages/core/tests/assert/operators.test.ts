import { describe, expect, it } from "vitest";
import type { AssertOperator } from "../../src/plugin/types.js";
import { builtinAssertOperators } from "../../src/assert/operators.js";
import { itCompliesWithAssertOperatorContract } from "../contracts/assertOperator.contract.js";
import { selectResponseValue } from "../../src/assert/selection.js";
import { compileCaseAssertions, evaluateCaseAssertions } from "../../src/assert/evaluate.js";
import { compileRegex } from "../../src/assert/regex.js";
import { createProjectAssetContext } from "../../src/assets/context.js";
import { createPluginRegistry } from "../../src/plugin/registry.js";
import { createVariableResolver } from "../../src/variables/resolver.js";
import { TestCaseSchema, type Assertion } from "../../src/domain/common.js";
import type { ExecutionResponse } from "../../src/plugin/types.js";

const eq = builtinAssertOperators.find((o) => o.op === "eq")!;
const legacyOperators = builtinAssertOperators.filter((operator) => ["eq", "neq", "contains", "lt", "gt", "lte", "gte", "xpath"].includes(operator.op));

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
  it.each([
    ["exists", null, undefined, true], ["exists", false, undefined, true],
    ["exists", 0, undefined, true], ["exists", "", undefined, true],
    ["notExists", undefined, undefined, true], ["notExists", null, undefined, false],
    ["length", "😀a", "2", true], ["in", { a: 1 }, '[{"a":1}]', true],
    ["notIn", 1, '["1"]', true], ["deepEqual", { a: 1, b: [2] }, '{"b":[2],"a":1}', true],
    ["regex", "prefix HELLO suffix", "hello", false],
  ])("F4 typed %s preserves actual %j", (name, actual, expected, pass) => {
    const operator = builtinAssertOperators.find((item) => item.op === name);
    expect(operator, name).toBeDefined();
    expect(operator!.evaluate(actual, expected as string | undefined).pass).toBe(pass);
  });
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
    for (const op of legacyOperators) {
      expect(op.evaluate("hello", undefined).pass, op.op).toBe(false);
    }
  });

  for (const op of legacyOperators) {
    itCompliesWithAssertOperatorContract(toContractView(op));
  }
});

const response: ExecutionResponse = {
  status: 201, timeMs: 25, headers: { "x-result": "fallback", "set-cookie": "wrong=jar" },
  rawHeaders: [["X-Result", "one"], ["x-result", "two"], ["Set-Cookie", "sid=final; Expires=Wed, 21 Oct 2026 07:28:00 GMT"], ["Set-Cookie", "empty=; Path=/"]],
  bodyText: '{"values":[null,false,0,""],"nested":{"id":2},"id":1}',
};
const context = createProjectAssetContext({ projectId: "p", assets: [], models: [], components: [] });
const registry = createPluginRegistry();
for (const operator of builtinAssertOperators) registry.registerAssert(operator);
function compile(assertions: Assertion[]) {
  return compileCaseAssertions({ ...TestCaseSchema.parse({ id: "case", name: "case" }), assertions }, context, registry);
}
const resolver = () => createVariableResolver({ layers: [] });
describe("F4 response selection and prepared evaluation", () => {
  it("adapts legacy rootless property/index assertions without loosening new selectors", () => {
    const prepared = compile([{ id: "legacy", target: "bodyJson", op: "eq", path: "nested.id", expected: "2" },
      { id: "legacy-index", target: "bodyJson", op: "eq", path: "values[2]", expected: "0" }]);
    expect(prepared.diagnostics).toEqual([]);
    expect(evaluateCaseAssertions(prepared, response, resolver()).map(outcome => outcome.pass)).toEqual([true, true]);
    expect(() => selectResponseValue({ target: "bodyJson", path: "nested.id", match: "first" }, response)).toThrow(/begin with/);
    expect(compile([{ id: "new", target: "bodyJson", op: "exists", path: "nested.id" }]).diagnostics[0]).toMatchObject({ kind: "config", code: "SELECTOR_SYNTAX" });
  });
  it.each([[0, null], [1, false], [2, 0], [3, ""]])("keeps explicit JSON value at %s", (index, value) => {
    expect(selectResponseValue({ target: "bodyJson", path: `$.values[${index}]`, match: "first" }, response)).toMatchObject({ found: true, value });
  });
  it("keeps first/all order and missing distinct, selects headers case-insensitively and final response cookies", () => {
    expect(selectResponseValue({ target: "bodyJson", path: "$.values[*]", match: "all" }, response).value).toEqual([null, false, 0, ""]);
    expect(selectResponseValue({ target: "bodyJson", path: "$..id", match: "all" }, response).value).toEqual([1, 2]);
    expect(selectResponseValue({ target: "bodyJson", path: "$.absent", match: "all" }, response)).toEqual({ found: false });
    expect(selectResponseValue({ target: "header", headerName: "X-RESULT", match: "all" }, response).value).toEqual(["one", "two"]);
    expect(selectResponseValue({ target: "cookie", cookieName: "sid", match: "first" }, response).value).toBe("final");
    expect(selectResponseValue({ target: "cookie", cookieName: "empty", match: "first" }, response)).toMatchObject({ found: true, value: "" });
    expect(selectResponseValue({ target: "cookie", cookieName: "wrong", match: "first" }, response)).toEqual({ found: false });
    expect(selectResponseValue({ target: "status", match: "first" }, response).value).toBe(201);
    expect(selectResponseValue({ target: "responseTime", match: "first" }, response).value).toBe(25);
  });
  it.each(["eq", "neq", "contains", "notIn", "exists", "notExists"])("handles missing safely for %s", (op) => {
    const prepared = compile([{ id: op, target: "bodyJson", path: "$.absent", op, expected: op === "notIn" ? "[]" : "x" }]);
    expect(evaluateCaseAssertions(prepared, response, resolver())[0]).toMatchObject({ pass: op === "notExists", code: op === "notExists" ? "ASSERTION_PASSED" : "ASSERTION_MISSING" });
  });
  it.each(["$[?(@.x)]", "$[(process.exit())]", "$.values[", "$foo", "$.[0]"])("rejects unsupported or invalid path %s at compile", (path) => {
    expect(compile([{ id: "bad", target: "bodyJson", path, op: "notExists" }]).diagnostics[0]).toMatchObject({ kind: "config", code: "SELECTOR_SYNTAX" });
  });
  it("does not turn malformed or unavailable JSON into absence", () => {
    const prepared = compile([{ id: "bad", target: "bodyJson", op: "notExists" }]);
    expect(evaluateCaseAssertions(prepared, { ...response, bodyText: "{" }, resolver())[0]).toMatchObject({ pass: false, kind: "assertion", code: "RESPONSE_PARSE" });
    expect(evaluateCaseAssertions(prepared, { ...response, jsonAvailable: false }, resolver())[0]).toMatchObject({ pass: false, code: "RESPONSE_UNAVAILABLE" });
    expect(evaluateCaseAssertions(prepared, undefined, resolver())[0]).toMatchObject({ pass: false, code: "RESPONSE_MISSING" });
  });
  it.each([
    { op: "length", expected: "-1" }, { op: "deepEqual", expected: "{" }, { op: "in", expected: "{}" },
    { op: "regex", expected: "(?=a)" }, { op: "regex", expected: "(a)\\1" }, { op: "regex", expected: "x", options: { flags: "g" } },
    { op: "regex", expected: "x", options: { flags: "ii" } }, { op: "eq", expected: "1", options: { ignored: true } },
  ])("distinguishes invalid expected/options config for $op", (input) => {
    const prepared = compile([{ id: "bad", target: "bodyText", ...input } as Assertion]);
    expect(prepared.diagnostics[0]).toMatchObject({ pass: false, kind: "config" });
  });
  it("resolves expected for each evaluation and preserves first deep difference", () => {
    const prepared = compile([{ id: "deep", target: "bodyJson", path: "$.values", op: "deepEqual", expected: "{{values}}" }]);
    expect(prepared.diagnostics).toEqual([]);
    const variables = resolver();
    variables.setRuntime("values", '[null,false,0,""]');
    expect(evaluateCaseAssertions(prepared, response, variables)[0]).toMatchObject({ pass: true });
    variables.setRuntime("values", '[null,false,1,""]');
    expect(evaluateCaseAssertions(prepared, response, variables)[0]).toMatchObject({ pass: false, kind: "assertion", differencePath: "$[2]", actual: [null, false, 0, ""] });
  });
  it("uses complete response beyond preview budgets and rejects cap overflow", () => {
    const full = { ...response, bodyText: "x".repeat(70000) + "MATCH" };
    expect(evaluateCaseAssertions(compile([{ id: "full", op: "regex", target: "bodyText", expected: "MATCH$" }]), full, resolver())[0]?.pass).toBe(true);
    const overflow = { ...response, bodyText: JSON.stringify(Array.from({ length: 1001 }, (_, index) => index)) };
    expect(evaluateCaseAssertions(compile([{ id: "limit", op: "exists", target: "bodyJson", path: "$[*]" }]), overflow, resolver())[0]).toMatchObject({ pass: false, code: "SELECTOR_LIMIT" });
    expect(compile(Array.from({ length: 257 }, (_, index) => ({ id: String(index), op: "exists", target: "status" })) ).diagnostics[0]).toMatchObject({ code: "ASSERTION_LIMIT" });
  });
  it("maps i/m/s and capture groups without native regex fallback", () => {
    expect(compileRegex("^a.(b)$", "ims").capture("prefix\nA\nB\nsuffix", 1)).toBe("B");
    expect(compileRegex("(a)?b").capture("b", 1)).toBeUndefined();
    expect(compileRegex("(a)").capture("a a", 1, "all")).toEqual(["a", "a"]);
    expect(compileRegex("a").capture("a", 1)).toBeUndefined();
  });
  it("Fix1 first capture stops when the first pattern match has no participating group", () => {
    const regex = compileRegex("(a)?b");
    expect(regex.capture("b ab", 1, "first")).toBeUndefined();
    expect(regex.capture("b ab", 1, "all")).toEqual(["a"]);
  });
  it.each([
    { op: "length", expected: "1", bodyText: '"😀a"' },
    { op: "in", expected: "[2]", bodyText: "1" },
    { op: "notIn", expected: "[1]", bodyText: "1" },
  ])("Fix1 valid ordinary mismatch is assertion for $op", ({ op, expected, bodyText }) => {
    const prepared = compile([{ id: op, target: "bodyJson", op, expected }]);
    expect(prepared.diagnostics).toEqual([]);
    expect(evaluateCaseAssertions(prepared, { ...response, bodyText }, resolver())[0]).toMatchObject({ pass: false, kind: "assertion", code: "ASSERTION_FAILED" });
  });
  it("supports old two-parameter custom operators and honors descriptor requiredness", () => {
    registry.registerAssert({ op: "custom", descriptor: { expectedRequired: false }, evaluate: (actual) => ({ pass: actual === 201, message: "custom" }) });
    const prepared = compile([{ id: "custom", target: "status", op: "custom", options: { pluginKey: true } }]);
    expect(evaluateCaseAssertions(prepared, response, resolver())[0]?.pass).toBe(true);
    registry.registerAssert({ op: "custom-no-descriptor", evaluate: (actual, expected) => ({ pass: actual === 201 && expected === undefined, message: "custom" }) });
    expect(evaluateCaseAssertions(compile([{ id: "custom-old", target: "status", op: "custom-no-descriptor" }]), response, resolver())[0]?.pass).toBe(true);
  });
  it("keeps prepared assertion options independent of caller edits", () => {
    const options = { flags: "i" };
    const prepared = compile([{ id: "regex", target: "bodyText", op: "regex", expected: "{{pattern}}", options }]);
    options.flags = "g";
    const variables = resolver(); variables.setRuntime("pattern", "VALUES");
    expect(evaluateCaseAssertions(prepared, response, variables)[0]?.pass).toBe(true);
  });
  it("rejects invalid namespace configuration before response evaluation", () => {
    expect(compile([{ id: "bad", target: "bodyXml", path: "//missing:id", op: "exists" }]).diagnostics[0]).toMatchObject({ kind: "config", code: "SELECTOR_CONFIG" });
  });
});

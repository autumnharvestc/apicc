import type { DeepReadonly, ProjectAssetContextReadView } from "../assets/context.js";
import type { TestCase } from "../domain/common.js";
import type { SchemaNode } from "../contract/schemaNode.js";
import type { PluginRegistry } from "../plugin/registry.js";
import type { AssertOperator, AssertResult, ExecutionResponse } from "../plugin/types.js";
import { NormalizedAssertionSchema, ResponseSelectorSchema, type NormalizedAssertion, type ResponseSelector } from "../testing/model.js";
import type { VariableResolver } from "../variables/resolver.js";
import { AssertionValueError, selectResponseValue, validateResponseSelector } from "./selection.js";
import { compileRegex, type CompiledRegex } from "./regex.js";
import { prepareValueSchema, selectContractResponseSchema } from "./schemaValue.js";
import { parseExpected } from "./operators.js";

export interface AssertionOutcome extends AssertResult {
  id: string; op: string; selector: ResponseSelector;
  code: string;
  actual?: import("../contract/schemaNode.js").JsonValue;
  expected?: string;
}
export interface CompiledAssertion {
  assertion: NormalizedAssertion; selector: ResponseSelector; operator?: AssertOperator;
  diagnostic?: AssertResult; schema?: DeepReadonly<SchemaNode>; regex?: CompiledRegex;
}
export interface CompiledCaseAssertions {
  assertions: CompiledAssertion[];
  diagnostics: AssertionOutcome[];
  context: ProjectAssetContextReadView;
  owner?: { contractId: string };
}
const builtins = new Set(["eq", "neq", "contains", "lt", "gt", "lte", "gte", "xpath", "exists", "notExists", "regex", "length", "in", "notIn", "deepEqual", "schema"]);
function diagnostic(error: unknown): AssertResult {
  return error instanceof AssertionValueError ? { pass: false, message: error.message, kind: error.kind, code: error.code }
    : { pass: false, message: String(error), kind: "config", code: "ASSERTION_CONFIG" };
}
function validateExpected(assertion: NormalizedAssertion, expected: string | undefined, operator: AssertOperator): CompiledRegex | undefined {
  const required = operator.descriptor?.expectedRequired ?? (builtins.has(assertion.op) && !["exists", "notExists", "schema"].includes(assertion.op));
  if (required && expected === undefined) throw new AssertionValueError("EXPECTED_CONFIG", "Expected value is required");
  if (expected === undefined) return;
  if (assertion.op === "regex") return compileRegex(expected, assertion.options?.flags as string | undefined);
  if (assertion.op === "length" && (!/^(0|[1-9]\d*)$/.test(expected) || !Number.isSafeInteger(Number(expected)))) throw new AssertionValueError("EXPECTED_CONFIG", "Length expected must be a nonnegative safe integer");
  if (["in", "notIn", "deepEqual"].includes(assertion.op)) {
    const value = parseExpected(expected);
    if (assertion.op !== "deepEqual" && !Array.isArray(value)) throw new AssertionValueError("EXPECTED_CONFIG", "Membership expected must be a JSON array");
  }
  if (assertion.op === "xpath") {
    const split = expected.lastIndexOf("[==");
    validateResponseSelector({ target: "bodyXml", match: "first", path: split >= 0 ? expected.slice(0, split) : expected });
  }
}
export function compileCaseAssertions(testCase: TestCase, context: ProjectAssetContextReadView, registry: PluginRegistry, owner?: { contractId: string }): CompiledCaseAssertions {
  const compiled: CompiledCaseAssertions = { assertions: [], diagnostics: [], context, ...(owner ? { owner: { ...owner } } : {}) };
  const assertions = testCase.assertions;
  for (const input of assertions.slice(0, 256)) {
    const fallback = { target: input.target, match: input.match ?? "first", ...(input.path !== undefined ? { path: input.path } : {}), ...(input.headerName !== undefined ? { headerName: input.headerName } : {}), ...(input.cookieName !== undefined ? { cookieName: input.cookieName } : {}), ...(input.namespaces !== undefined ? { namespaces: input.namespaces } : {}) } as ResponseSelector;
    const entry: CompiledAssertion = { assertion: { ...input, match: input.match ?? "first" }, selector: fallback };
    try {
      if (assertions.length > 256 || (testCase.extractors?.length ?? 0) > 64) throw new AssertionValueError("ASSERTION_LIMIT", "Case exceeds 256 assertions or 64 extractors");
      const parsed = NormalizedAssertionSchema.safeParse(structuredClone(input));
      if (!parsed.success) throw new AssertionValueError("ASSERTION_CONFIG", parsed.error.message);
      entry.assertion = parsed.data;
      entry.selector = ResponseSelectorSchema.parse(fallback);
      validateResponseSelector(entry.selector);
      const operator = registry.getAssert(input.op);
      if (!operator) throw new AssertionValueError("OPERATOR_UNKNOWN", `Operator is not registered: ${input.op}`);
      entry.operator = operator;
      const options = entry.assertion.options ?? {};
      const allowed = input.op === "regex" ? ["flags"] : input.op === "schema" ? ["schema", "useContractResponse"] : [];
      if (builtins.has(input.op) && Object.keys(options).some((key) => !allowed.includes(key))) throw new AssertionValueError("OPTIONS_CONFIG", `Unsupported ${input.op} option`);
      if (input.op === "regex" && options.flags !== undefined && typeof options.flags !== "string") throw new AssertionValueError("REGEX_CONFIG", "Regex flags must be text");
      if (input.op === "regex") compileRegex("", options.flags as string | undefined);
      if (input.op === "xpath" && input.target !== "bodyText") throw new AssertionValueError("SELECTOR_CONFIG", "Legacy xpath assertions require bodyText");
      if (operator.descriptor?.targets && !operator.descriptor.targets.includes(input.target)) throw new AssertionValueError("SELECTOR_CONFIG", "Operator does not support this target");
      if (input.op === "schema") {
        const inline = options.schema !== undefined;
        if ((options.useContractResponse !== undefined && options.useContractResponse !== true) || inline === (options.useContractResponse === true)) throw new AssertionValueError("SCHEMA_CONFIG", "Choose schema XOR useContractResponse=true");
        if (inline) entry.schema = prepareValueSchema(options.schema, context);
        else {
          if (!owner || !context.getContract(owner.contractId)) throw new AssertionValueError("SCHEMA_REFERENCE", "Contract response schema requires the owning contract");
          if (input.target !== "bodyJson" || (input.path !== undefined && input.path !== "$") || (input.match ?? "first") !== "first") throw new AssertionValueError("SCHEMA_CONFIG", "Contract response validation requires bodyJson root with first match");
          const contract = context.getContract(owner.contractId)!;
          for (const binding of contract.responses) {
            const component = binding.kind === "componentRef" ? context.getComponent(binding.componentId) : undefined;
            const response = binding.kind === "inline" ? binding : component?.kind === "response" ? component.definition : undefined;
            if (!response) throw new AssertionValueError("SCHEMA_REFERENCE", "Response component is missing or has wrong kind");
            for (const content of Object.values(response.content)) if (content.schema) prepareValueSchema(content.schema, context);
          }
        }
      }
      // Runtime templates are deliberately left for each invocation, after extraction.
      if (!input.expected?.includes("{{")) entry.regex = validateExpected(entry.assertion, input.expected, operator);
    } catch (error) { entry.diagnostic = diagnostic(error); }
    compiled.assertions.push(entry);
    if (entry.diagnostic) compiled.diagnostics.push({ ...entry.diagnostic, id: input.id, op: input.op, selector: entry.selector, code: entry.diagnostic.code ?? "ASSERTION_CONFIG" });
  }
  if (assertions.length === 0 && (testCase.extractors?.length ?? 0) > 64) compiled.diagnostics.push({ id: "", op: "", selector: { target: "status", match: "first" }, pass: false, message: "Case exceeds 64 extractors", kind: "config", code: "ASSERTION_LIMIT" });
  return compiled;
}
export function evaluateCaseAssertions(compiled: CompiledCaseAssertions, response: ExecutionResponse | undefined, resolver: VariableResolver): AssertionOutcome[] {
  if (compiled.assertions.length === 0) return [...compiled.diagnostics];
  return compiled.assertions.map((entry) => {
    const { assertion, selector, operator } = entry;
    const base = { id: assertion.id, op: assertion.op, selector };
    if (entry.diagnostic) return { ...base, ...entry.diagnostic, code: entry.diagnostic.code ?? "ASSERTION_CONFIG" };
    let actual: import("../contract/schemaNode.js").JsonValue | undefined;
    let expected: string | undefined;
    try {
      expected = assertion.expected === undefined ? undefined : resolver.resolve(assertion.expected);
      const regex = entry.regex ?? validateExpected(assertion, expected, operator!);
      if (!response) throw new AssertionValueError("RESPONSE_MISSING", "Response is unavailable", "assertion");
      const selection = selectResponseValue(selector, response);
      actual = selection.value;
      if (!selection.found && assertion.op !== "notExists") throw new AssertionValueError("ASSERTION_MISSING", "Actual value is missing", "assertion");
      const schema = assertion.op === "schema" && assertion.options?.useContractResponse === true ? selectContractResponseSchema(compiled.context, compiled.owner!.contractId, response) : entry.schema;
      const result = operator!.evaluate(actual, expected, { found: selection.found, options: assertion.options, assets: compiled.context, ...(schema ? { schema } : {}), ...(regex ? { regex } : {}) });
      return { ...base, ...result, code: result.code ?? (result.pass ? "ASSERTION_PASSED" : "ASSERTION_FAILED"), ...(actual !== undefined ? { actual } : {}), ...(expected !== undefined ? { expected } : {}), ...(!result.pass && !result.kind ? { kind: "assertion" as const } : {}) };
    } catch (error) {
      const result = diagnostic(error);
      return { ...base, ...result, code: result.code!, ...(actual !== undefined ? { actual } : {}), ...(expected !== undefined ? { expected } : {}) };
    }
  });
}

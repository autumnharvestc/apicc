import { describe, expect, it } from "vitest";
import { createProjectAssetContext } from "../../src/assets/context.js";
import { ApiAssetSchema, ComponentAssetSchema, ModelAssetSchema, type ApiAsset, type ComponentAsset } from "../../src/contract/model.js";
import { SchemaNodeSchema, type JsonValue, type SchemaNode } from "../../src/contract/schemaNode.js";
import { TestCaseSchema } from "../../src/domain/common.js";
import { compileCaseAssertions, evaluateCaseAssertions } from "../../src/assert/evaluate.js";
import { builtinAssertOperators } from "../../src/assert/operators.js";
import { createPluginRegistry } from "../../src/plugin/registry.js";
import { createVariableResolver } from "../../src/variables/resolver.js";
import { componentFixtures, contractFixture, modelAssetFixture, nestedSchemaFixture, responseReference } from "../helpers/contractFixtures.js";

const registry = createPluginRegistry();
for (const operator of builtinAssertOperators) registry.registerAssert(operator);
const model = ModelAssetSchema.parse({ ...modelAssetFixture(), schema: { kind: "scalar", type: "integer" } });
function assets(apis: ApiAsset[] = [], components: ComponentAsset[] = []) {
  return createProjectAssetContext({ projectId: "p", assets: apis, models: [model], components });
}
function evaluate(value: unknown, schema: SchemaNode, context = assets()) {
  const testCase = TestCaseSchema.parse({ id: "case", name: "case", assertions: [{ id: "schema", target: "bodyJson", op: "schema", options: { schema } }] });
  const prepared = compileCaseAssertions(testCase, context, registry);
  const response = { status: 201, timeMs: 1, headers: { "Content-Type": "application/json" }, bodyText: JSON.stringify(value) };
  return { prepared, outcome: evaluateCaseAssertions(prepared, response, createVariableResolver({ layers: [] }))[0]! };
}
describe("F4 supported SchemaNode value validation", () => {
  it.each([["x", false, "oneOf matched 0 branches"], [1.5, true, "Schema matched"], [1, false, "oneOf matched 2 branches"]])("oneOf exact one for %j", (value, pass, message) => {
    const schema: SchemaNode = { kind: "oneOf", variants: [{ kind: "scalar", type: "number" }, { kind: "scalar", type: "integer" }] };
    expect(evaluate(value, schema).outcome).toMatchObject({ pass, message });
  });
  it("reuses nested model fixture for required, enum, arrays, additionalProperties and first difference", () => {
    const schema = SchemaNodeSchema.parse(nestedSchemaFixture());
    expect(evaluate({ profile: { name: "Ada" }, scores: [1, 2], extra: 3 }, schema).outcome.pass).toBe(true);
    expect(evaluate({ profile: {} }, schema).outcome).toMatchObject({ pass: false, kind: "assertion", differencePath: '$["profile"]["name"]', schemaPath: '$schema.properties["profile"].required' });
    expect(evaluate({ profile: { name: "Ada", unexpected: 1 } }, schema).outcome).toMatchObject({ differencePath: '$["profile"]["unexpected"]', schemaPath: '$schema.properties["profile"].additionalProperties' });
    expect(evaluate({ profile: { name: "Other" } }, schema).outcome).toMatchObject({ differencePath: '$["profile"]["name"]', schemaPath: '$schema.properties["profile"].properties["name"].enum' });
    expect(evaluate({ profile: { name: "Ada" }, scores: [1, "2"] }, schema).outcome).toMatchObject({ differencePath: '$["scores"][1]' });
    expect(evaluate({ profile: { name: "Ada" }, extra: "3" }, schema).outcome).toMatchObject({ differencePath: '$["extra"]', kind: "assertion" });
  });
  it("allOf/anyOf and annotations do not coerce or mutate values", () => {
    const schema: SchemaNode = { kind: "allOf", variants: [{ kind: "anyOf", variants: [{ kind: "scalar", type: "null" }, { kind: "scalar", type: "integer" }] }, { kind: "scalar", type: "integer", enum: [1, 2], default: 1, examples: [2] }] };
    expect(evaluate(1, schema).outcome.pass).toBe(true);
    expect(evaluate(null, schema).outcome.pass).toBe(false);
    expect(evaluate("1", schema).outcome.pass).toBe(false);
  });
  it("missing refs and malformed schema are config; recursive depth and node overflow never pass", () => {
    expect(evaluate(1, { kind: "modelRef", modelId: "00000000-0000-4000-8000-000000009999" }).outcome).toMatchObject({ kind: "config", code: "SCHEMA_REFERENCE" });
    expect(evaluate(1, { kind: "scalar", type: "unknown" } as unknown as SchemaNode).outcome).toMatchObject({ kind: "config", code: "SCHEMA_CONFIG" });
    const recursive = ModelAssetSchema.parse({ ...model, schema: { kind: "object", properties: { next: { kind: "modelRef", modelId: model.id } }, required: [], additionalProperties: false } });
    const context = createProjectAssetContext({ projectId: "p", assets: [], models: [recursive], components: [] });
    let value: JsonValue = {};
    for (let index = 0; index < 66; index++) value = { next: value };
    expect(evaluate(value, { kind: "modelRef", modelId: model.id }, context).outcome).toMatchObject({ pass: false, code: "SCHEMA_LIMIT" });
    expect(evaluate(Array.from({ length: 100001 }, () => 1), { kind: "array", items: { kind: "scalar", type: "integer" } }).outcome).toMatchObject({ pass: false, code: "SCHEMA_LIMIT" });
  });
  it("uses owner, actual status precedence and normalized Content-Type including referenced responses", () => {
    const api = ApiAssetSchema.parse(contractFixture());
    const definition = (status: string, type: "integer" | "string") => ({ kind: "inline" as const, id: crypto.randomUUID(), status, description: "", headers: {}, content: { "Application/JSON": { schema: { kind: "scalar" as const, type }, examples: [] } } });
    api.contract.responses = [definition("201", "integer"), definition("2XX", "string"), definition("default", "integer")];
    const testCase = TestCaseSchema.parse({ id: "case", name: "case", assertions: [{ id: "schema", target: "bodyJson", op: "schema", options: { useContractResponse: true } }] });
    const prepare = (current = api, components: ComponentAsset[] = []) => compileCaseAssertions(testCase, assets([current], components), registry, { contractId: current.contract.id });
    const variables = createVariableResolver({ layers: [] });
    const response = { status: 201, timeMs: 1, headers: { "CONTENT-TYPE": "APPLICATION/JSON; charset=utf-8" }, bodyText: "1" };
    expect(compileCaseAssertions(testCase, assets([api]), registry).diagnostics[0]).toMatchObject({ code: "SCHEMA_REFERENCE", kind: "config" });
    expect(evaluateCaseAssertions(prepare(), response, variables)[0]?.pass).toBe(true);
    expect(evaluateCaseAssertions(prepare(), { ...response, status: 202 }, variables)[0]?.pass).toBe(false);
    expect(evaluateCaseAssertions(prepare(), { ...response, status: 500 }, variables)[0]?.pass).toBe(true);
    expect(evaluateCaseAssertions(prepare(), { ...response, headers: { "Content-Type": "text/plain" } }, variables)[0]).toMatchObject({ kind: "config", code: "SCHEMA_RESPONSE" });
    api.contract.responses.push(definition("201", "integer"));
    expect(evaluateCaseAssertions(prepare(), response, variables)[0]).toMatchObject({ kind: "config", code: "SCHEMA_RESPONSE" });
    const component = ComponentAssetSchema.parse(componentFixtures().find((input) => input.kind === "response"));
    if (component.kind !== "response") throw new Error("Expected response fixture");
    component.definition = definition("201", "integer");
    api.contract.responses = [responseReference() as unknown as ApiAsset["contract"]["responses"][number]];
    expect(evaluateCaseAssertions(prepare(api, [component]), response, variables)[0]?.pass).toBe(true);
  });
  it.each([
    { schema: { kind: "scalar", type: "string" }, useContractResponse: true },
    { useContractResponse: false }, {},
  ])("rejects invalid schema option combination %j", (options) => {
    const testCase = TestCaseSchema.parse({ id: "case", name: "case", assertions: [{ id: "schema", target: "bodyJson", op: "schema", options }] });
    expect(compileCaseAssertions(testCase, assets(), registry).diagnostics[0]).toMatchObject({ kind: "config", code: "SCHEMA_CONFIG" });
  });
});

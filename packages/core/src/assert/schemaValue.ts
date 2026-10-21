import type { DeepReadonly, ProjectAssetContextReadView } from "../assets/context.js";
import type { ResponseDefinition } from "../contract/model.js";
import { SchemaNodeSchema, type SchemaNode } from "../contract/schemaNode.js";
import type { AssertResult, ExecutionResponse } from "../plugin/types.js";
import { AssertionValueError } from "./selection.js";

export function firstDifference(actual: unknown, expected: unknown, path = "$"): string | undefined {
  const stack = [{ actual, expected, path }];
  let visited = 0;
  while (stack.length) {
    if (++visited > 100000) throw new AssertionValueError("VALUE_LIMIT", "Value comparison exceeds 100000 nodes");
    const item = stack.pop()!;
    if (Object.is(item.actual, item.expected)) continue;
    if (item.actual === null || item.expected === null || typeof item.actual !== "object" || typeof item.expected !== "object") return item.path;
    if (Array.isArray(item.actual) !== Array.isArray(item.expected)) return item.path;
    if (Array.isArray(item.actual) && Array.isArray(item.expected) && item.actual.length !== item.expected.length) return `${item.path}.length`;
    const left = item.actual as Record<string, unknown>; const right = item.expected as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])];
    for (let index = keys.length - 1; index >= 0; index--) {
      const key = keys[index]!;
      const childPath = Array.isArray(left) ? `${item.path}[${key}]` : `${item.path}[${JSON.stringify(key)}]`;
      if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) stack.push({ actual: undefined, expected: null, path: childPath });
      else stack.push({ actual: left[key], expected: right[key], path: childPath });
    }
  }
  return undefined;
}
export function prepareValueSchema(input: unknown, context: ProjectAssetContextReadView): SchemaNode {
  const inspect = (node: unknown, depth: number, seenModels: Set<string>, state: { visited: number }): void => {
    if (depth > 64 || ++state.visited > 100000) throw new AssertionValueError("SCHEMA_LIMIT", "Schema exceeds depth 64 or 100000 nodes");
    if (!node || typeof node !== "object") return;
    const object = node as Record<string, unknown>;
    if (object.kind === "modelRef" && typeof object.modelId === "string") {
      const model = context.getModel(object.modelId);
      if (!model) throw new AssertionValueError("SCHEMA_REFERENCE", `Model not found: ${object.modelId}`);
      if (!seenModels.has(object.modelId)) inspect(model.schema, depth + 1, new Set([...seenModels, object.modelId]), state);
    }
    const children: unknown[] = object.kind === "object"
      ? [...Object.values(object.properties && typeof object.properties === "object" ? object.properties : {}), ...(typeof object.additionalProperties === "object" && object.additionalProperties !== null ? [object.additionalProperties] : [])]
      : object.kind === "array" ? [object.items]
      : ["allOf", "oneOf", "anyOf"].includes(String(object.kind)) && Array.isArray(object.variants) ? object.variants : [];
    for (const child of children) inspect(child, depth + 1, seenModels, state);
  };
  inspect(input, 0, new Set(), { visited: 0 });
  const parsed = SchemaNodeSchema.safeParse(input);
  if (!parsed.success) throw new AssertionValueError("SCHEMA_CONFIG", parsed.error.message);
  return parsed.data;
}
export function validateSchemaValue(actual: unknown, schema: DeepReadonly<SchemaNode>, context: ProjectAssetContextReadView): AssertResult {
  let visited = 0;
  const mismatch = (path: string, schemaPath: string, message: string): AssertResult => ({ pass: false, message, kind: "assertion", code: "SCHEMA_MISMATCH", differencePath: path, schemaPath });
  const visit = (value: unknown, node: DeepReadonly<SchemaNode>, path: string, schemaPath: string, depth: number): AssertResult => {
    if (depth > 64 || ++visited > 100000) throw new AssertionValueError("SCHEMA_LIMIT", "Schema evaluation exceeds depth 64 or 100000 nodes");
    if (node.enum && !node.enum.some((candidate) => firstDifference(value, candidate) === undefined)) return mismatch(path, `${schemaPath}.enum`, "Value is outside enum");
    switch (node.kind) {
      case "modelRef": {
        const model = context.getModel(node.modelId);
        if (!model) throw new AssertionValueError("SCHEMA_REFERENCE", `Model not found: ${node.modelId}`);
        return visit(value, model.schema, path, `${schemaPath}.modelRef(${node.modelId})`, depth + 1);
      }
      case "scalar": {
        const pass = node.type === "null" ? value === null : node.type === "integer" ? typeof value === "number" && Number.isInteger(value)
          : node.type === "number" ? typeof value === "number" && Number.isFinite(value) : typeof value === node.type;
        return pass ? { pass: true, message: "Schema matched" } : mismatch(path, `${schemaPath}.type`, `Expected ${node.type}`);
      }
      case "array": {
        if (!Array.isArray(value)) return mismatch(path, `${schemaPath}.kind`, "Expected array");
        for (let index = 0; index < value.length; index++) {
          const result = visit(value[index], node.items, `${path}[${index}]`, `${schemaPath}.items`, depth + 1);
          if (!result.pass) return result;
        }
        break;
      }
      case "object": {
        if (!value || typeof value !== "object" || Array.isArray(value)) return mismatch(path, `${schemaPath}.kind`, "Expected object");
        const object = value as Record<string, unknown>;
        for (const key of node.required) if (!Object.hasOwn(object, key)) return mismatch(`${path}[${JSON.stringify(key)}]`, `${schemaPath}.required`, `Missing required property ${key}`);
        for (const [key, child] of Object.entries(object)) {
          const childPath = `${path}[${JSON.stringify(key)}]`;
          const property = Object.hasOwn(node.properties, key) ? node.properties[key] : undefined;
          if (!property && node.additionalProperties === false) return mismatch(childPath, `${schemaPath}.additionalProperties`, "Additional property is forbidden");
          const childSchema = property ?? (typeof node.additionalProperties === "object" ? node.additionalProperties : undefined);
          if (childSchema) {
            const result = visit(child, childSchema, childPath, property ? `${schemaPath}.properties[${JSON.stringify(key)}]` : `${schemaPath}.additionalProperties`, depth + 1);
            if (!result.pass) return result;
          }
        }
        break;
      }
      default: {
        const results = node.variants.map((variant, index) => visit(value, variant, path, `${schemaPath}.variants[${index}]`, depth + 1));
        const count = results.filter((result) => result.pass).length;
        if (node.kind === "allOf") return results.find((result) => !result.pass) ?? { pass: true, message: "Schema matched" };
        if (node.kind === "anyOf" ? count === 0 : count !== 1) return mismatch(path, `${schemaPath}.${node.kind}`, `${node.kind} matched ${count} branches`);
      }
    }
    return { pass: true, message: "Schema matched" };
  };
  return visit(actual, schema, "$", "$schema", 0);
}
export function selectContractResponseSchema(context: ProjectAssetContextReadView, contractId: string, response: ExecutionResponse): DeepReadonly<SchemaNode> {
  const contract = context.getContract(contractId);
  if (!contract) throw new AssertionValueError("SCHEMA_REFERENCE", `Contract not found: ${contractId}`);
  const definitions: DeepReadonly<ResponseDefinition>[] = contract.responses.map((binding) => {
    if (binding.kind === "inline") return binding;
    const component = context.getComponent(binding.componentId);
    if (component?.kind !== "response") throw new AssertionValueError("SCHEMA_REFERENCE", `Response component not found: ${binding.componentId}`);
    return component.definition;
  });
  const status = [String(response.status), `${Math.floor(response.status / 100)}XX`, "default"].find((candidate) => definitions.some((definition) => definition.status === candidate));
  const pairs = response.rawHeaders ?? Object.entries(response.headers);
  const contentTypes = pairs.filter(([name]) => name.toLowerCase() === "content-type").map(([, value]) => value.split(";", 1)[0]!.trim().toLowerCase());
  if (contentTypes.length !== 1) throw new AssertionValueError("SCHEMA_RESPONSE", "Response needs one unambiguous Content-Type");
  const matches = definitions.filter((definition) => definition.status === status).flatMap((definition) => Object.entries(definition.content).filter(([media]) => media.split(";", 1)[0]!.trim().toLowerCase() === contentTypes[0]).map(([, content]) => content));
  if (matches.length !== 1 || !matches[0]!.schema) throw new AssertionValueError("SCHEMA_RESPONSE", "Contract response schema has zero or ambiguous matches");
  return matches[0]!.schema;
}

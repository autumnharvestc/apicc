import { describe, expect, it } from "vitest";

import type { ModelAsset } from "../../src/contract/model.js";
import type { JsonValue, SchemaNode } from "../../src/contract/schemaNode.js";
import * as core from "../../src/index.js";

const generator = core as unknown as {
  generateMockJsonValue?: (schema: SchemaNode, options: {
    models: readonly ModelAsset[];
    seed: string;
    contractId: string;
    ruleId: string;
    path: string;
  }) => { ok: true; value: unknown } | { ok: false; diagnostics: Array<{ code: string; path: string; lossy: boolean }> };
};

const contractId = "10000000-0000-4000-8000-000000000005";
const ruleId = "10000000-0000-4000-8000-000000000015";
const modelId = "10000000-0000-4000-8000-000000000031";

function generationOptions(models: readonly ModelAsset[] = []) {
  return { models, seed: "b1-fixed-seed", contractId, ruleId, path: "mock.rules[0].source" };
}

function nestedJson(depth: number): JsonValue {
  let value: JsonValue = "leaf";
  for (let index = 0; index < depth; index += 1) value = { child: value };
  return value;
}

describe("bounded Mock Schema generation", () => {
  it("chooses bounded enum, default, example, scalar, object, and array candidates deterministically", () => {
    const schema: SchemaNode = {
      kind: "object",
      properties: {
        state: { kind: "scalar", type: "string", enum: ["ready"] },
        label: { kind: "scalar", type: "string", examples: ["fixture"] },
        count: { kind: "scalar", type: "integer", default: 7 },
        enabled: { kind: "scalar", type: "boolean" },
        tags: { kind: "array", items: { kind: "scalar", type: "string" } },
      },
      required: ["state", "label", "count", "enabled", "tags"],
      additionalProperties: false,
    };

    const first = generator.generateMockJsonValue?.(schema, generationOptions());
    const second = generator.generateMockJsonValue?.(schema, generationOptions());
    expect(first).toEqual({
      ok: true,
      value: { state: "ready", label: "fixture", count: 7, enabled: false, tags: [] },
    });
    expect(second).toEqual(first);
  });

  it.each([
    ["allOf", { kind: "allOf", variants: [
      { kind: "scalar", type: "string", enum: ["shared"] },
      { kind: "scalar", type: "string" },
    ] }, "shared"],
    ["anyOf", { kind: "anyOf", variants: [
      { kind: "scalar", type: "string", enum: ["either"] },
      { kind: "scalar", type: "integer", enum: [3] },
    ] }, "either"],
    ["oneOf", { kind: "oneOf", variants: [
      { kind: "scalar", type: "string", enum: ["only-string"] },
      { kind: "scalar", type: "integer", enum: [3] },
    ] }, "only-string"],
  ] as const)("honors %s branch validation", (_label, schema, expected) => {
    expect(generator.generateMockJsonValue?.(schema as unknown as SchemaNode, generationOptions())).toEqual({ ok: true, value: expected });
  });

  it("omits optional recursive fields but diagnoses required recursion and contradictory branches", () => {
    const optionalRecursiveModel: ModelAsset = {
      formatVersion: 1,
      id: modelId,
      name: "Recursive",
      description: "",
      schema: {
        kind: "object",
        properties: { child: { kind: "modelRef", modelId } },
        required: [],
        additionalProperties: false,
      },
    };
    const optional = generator.generateMockJsonValue?.(
      { kind: "modelRef", modelId },
      generationOptions([optionalRecursiveModel]),
    );
    expect(optional).toEqual({ ok: true, value: {} });

    const requiredRecursiveModel: ModelAsset = {
      ...optionalRecursiveModel,
      schema: {
        kind: "object",
        properties: { child: { kind: "modelRef", modelId } },
        required: ["child"],
        additionalProperties: false,
      },
    };
    const required = generator.generateMockJsonValue?.(
      { kind: "modelRef", modelId },
      generationOptions([requiredRecursiveModel]),
    );
    expect(required).toMatchObject({
      ok: false,
      diagnostics: [{
        code: "MOCK_SCHEMA_RECURSION_REQUIRED",
        path: "mock.rules[0].source.model(10000000-0000-4000-8000-000000000031).properties.child",
        lossy: false,
      }],
    });

    const contradictory: SchemaNode = {
      kind: "allOf",
      variants: [
        { kind: "scalar", type: "string", enum: ["left"] },
        { kind: "scalar", type: "string", enum: ["right"] },
      ],
    };
    expect(generator.generateMockJsonValue?.(contradictory, generationOptions())).toMatchObject({
      ok: false,
      diagnostics: [{ code: "MOCK_SCHEMA_UNGENERATABLE", path: "mock.rules[0].source", lossy: false }],
    });
  });

  it.each([
    ["default", "mock.rules[0].source.default", nestedJson(17)],
    ["enum", "mock.rules[0].source.enum[0]", { ...Object.fromEntries(Array.from({ length: 1_000 }, (_, index) => [`field${index}`, 1])) }],
  ] as const)("rejects an over-budget %s JSON annotation before candidate ordering", (annotation, path, value) => {
    const schema: SchemaNode = { kind: "object", properties: {}, required: [], additionalProperties: true };
    if (annotation === "default") schema.default = value;
    else schema.enum = [value];

    expect(generator.generateMockJsonValue?.(schema, generationOptions())).toMatchObject({
      ok: false,
      diagnostics: [{ code: "MOCK_SCHEMA_LIMIT", path: expect.stringContaining(path), lossy: false }],
    });
  });

  it.each(["default", "enum", "examples"] as const)("tries a valid %s annotation when fallback construction is unsupported", (annotation) => {
    const value: JsonValue = { x: "ok" };
    const schema: SchemaNode = { kind: "object", properties: {}, required: ["x"], additionalProperties: true };
    if (annotation === "default") schema.default = value;
    else if (annotation === "enum") schema.enum = [value];
    else schema.examples = [value];

    expect(generator.generateMockJsonValue?.(schema, generationOptions())).toEqual({ ok: true, value });
  });
});

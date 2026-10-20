import { createHash } from "node:crypto";

import type { ModelAsset } from "../contract/model.js";
import type { JsonValue, SchemaNode } from "../contract/schemaNode.js";
import type { MockDiagnostic } from "./config.js";

const MAX_DEPTH = 16;
const MAX_NODES = 1_000;
const MAX_CANDIDATES = 64;
const MAX_COMBINATIONS = 256;

export interface GenerateMockJsonOptions {
  models: readonly ModelAsset[];
  seed: string;
  contractId: string;
  ruleId: string;
  path: string;
}

export type GenerateMockJsonResult =
  | { ok: true; value: JsonValue }
  | { ok: false; diagnostics: MockDiagnostic[] };

class GenerationFailure extends Error {
  constructor(readonly code: string, readonly path: string, message: string) {
    super(message);
    this.name = "GenerationFailure";
  }
}

interface GenerationState {
  options: GenerateMockJsonOptions;
  models: Map<string, ModelAsset>;
  nodes: number;
}

export function generateMockJsonValue(schema: SchemaNode, options: GenerateMockJsonOptions): GenerateMockJsonResult {
  const state: GenerationState = {
    options,
    models: new Map(options.models.map((model) => [model.id, model])),
    nodes: 0,
  };

  try {
    const candidates = buildCandidates(schema, options.path, 0, new Set(), state);
    for (const candidate of candidates) {
      if (matchesSchema(schema, candidate, options.path, 0, new Set(), state)) return { ok: true, value: candidate };
    }
    throw new GenerationFailure("MOCK_SCHEMA_UNGENERATABLE", options.path, "No bounded candidate satisfies this response schema.");
  } catch (error) {
    const failure = error instanceof GenerationFailure
      ? error
      : new GenerationFailure("MOCK_SCHEMA_UNGENERATABLE", options.path, "The response schema could not be generated.");
    return {
      ok: false,
      diagnostics: [{
        severity: "error",
        code: failure.code,
        path: failure.path,
        message: failure.message,
        lossy: false,
        ownerId: options.contractId,
      }],
    };
  }
}

function buildCandidates(
  schema: SchemaNode,
  path: string,
  depth: number,
  activeModels: Set<string>,
  state: GenerationState,
): JsonValue[] {
  visitNode(path, depth, state);
  if (schema.default !== undefined) validateCandidateBudget(schema.default, path + ".default", depth);
  const annotated = [
    ...(schema.enum === undefined ? [] : orderCandidates(schema.enum, state.options, path + ".enum", depth)),
    ...(schema.default === undefined ? [] : [schema.default]),
    ...(schema.examples === undefined ? [] : orderCandidates(schema.examples, state.options, path + ".examples", depth)),
  ];
  let fallbackFailure: GenerationFailure | undefined;
  let generated: JsonValue[] = [];

  try {
    if (schema.kind === "scalar") {
      generated = [scalarCandidate(schema)];
    } else if (schema.kind === "array") {
      generated = [[]];
    } else if (schema.kind === "object") {
      generated = buildObjectCandidates(schema, path, depth, activeModels, state);
    } else if (schema.kind === "modelRef") {
      if (activeModels.has(schema.modelId)) {
        throw new GenerationFailure("MOCK_SCHEMA_RECURSION_REQUIRED", path, "A required recursive model value cannot be generated within the depth limit.");
      }
      const model = state.models.get(schema.modelId);
      if (!model) throw new GenerationFailure("MOCK_SCHEMA_MODEL_MISSING", path, "The response schema references a missing model.");
      activeModels.add(schema.modelId);
      try {
        generated = buildCandidates(model.schema, path + ".model(" + schema.modelId + ")", depth + 1, activeModels, state);
      } finally {
        activeModels.delete(schema.modelId);
      }
    } else if (schema.kind === "allOf") {
      const variantCandidates = schema.variants.map((variant, index) =>
        buildCandidates(variant, path + ".variants[" + index + "]", depth + 1, activeModels, state));
      generated = combineAllOfCandidates(variantCandidates, path, depth);
      if (schema.variants.length === 0) generated = [null];
    } else if (schema.kind === "anyOf" || schema.kind === "oneOf") {
      const branchFailures: GenerationFailure[] = [];
      for (const [index, variant] of schema.variants.entries()) {
        try {
          generated.push(...buildCandidates(variant, path + ".variants[" + index + "]", depth + 1, activeModels, state));
        } catch (error) {
          if (!(error instanceof GenerationFailure)) throw error;
          branchFailures.push(error);
        }
      }
      if (generated.length === 0 && branchFailures.length > 0) throw branchFailures[0];
    }
  } catch (error) {
    if (!(error instanceof GenerationFailure)) throw error;
    fallbackFailure = error;
  }

  if (fallbackFailure) {
    const boundedAnnotations = uniqueCandidates(annotated, path + ".annotations", depth);
    const validAnnotations = boundedAnnotations.filter((candidate) =>
      matchesSchema(schema, candidate, path, depth, new Set(activeModels), state));
    if (validAnnotations.length > 0) return validAnnotations;
    throw fallbackFailure;
  }

  return uniqueCandidates([...annotated, ...generated], path, depth).slice(0, MAX_CANDIDATES);
}

function buildObjectCandidates(
  schema: Extract<SchemaNode, { kind: "object" }>,
  path: string,
  depth: number,
  activeModels: Set<string>,
  state: GenerationState,
): JsonValue[] {
  let partials: Array<Record<string, JsonValue>> = [{}];
  for (const name of schema.required) {
    const childSchema = schema.properties[name]
      ?? (typeof schema.additionalProperties === "object" ? schema.additionalProperties : undefined);
    if (!childSchema) {
      throw new GenerationFailure("MOCK_SCHEMA_UNGENERATABLE", path + ".properties." + name, "A required property has no generatable schema.");
    }
    const children = buildCandidates(childSchema, path + ".properties." + name, depth + 1, activeModels, state);
    const next: Array<Record<string, JsonValue>> = [];
    for (const partial of partials) {
      for (const child of children) {
        if (next.length >= MAX_COMBINATIONS) break;
        const copy: Record<string, JsonValue> = {};
        for (const [key, value] of Object.entries(partial)) defineJsonProperty(copy, key, value);
        defineJsonProperty(copy, name, child);
        next.push(copy);
      }
      if (next.length >= MAX_COMBINATIONS) break;
    }
    partials = next;
  }
  return partials;
}

function scalarCandidate(schema: Extract<SchemaNode, { kind: "scalar" }>): JsonValue {
  if (schema.type === "string") return "";
  if (schema.type === "number" || schema.type === "integer") return 0;
  if (schema.type === "boolean") return false;
  return null;
}

function combineAllOfCandidates(candidateSets: JsonValue[][], path: string, depth: number): JsonValue[] {
  if (candidateSets.length === 0) return [];
  let combined = candidateSets[0] ?? [];
  for (const candidates of candidateSets.slice(1)) {
    const next: JsonValue[] = [...combined, ...candidates];
    for (const left of combined) {
      for (const right of candidates) {
        const merged = mergeJsonValues(left, right);
        if (merged.ok) next.push(merged.value);
        if (next.length >= MAX_COMBINATIONS) break;
      }
      if (next.length >= MAX_COMBINATIONS) break;
    }
    combined = uniqueCandidates(next, path, depth);
  }
  return combined;
}

function mergeJsonValues(left: JsonValue, right: JsonValue): { ok: true; value: JsonValue } | { ok: false } {
  if (jsonEqual(left, right)) return { ok: true, value: left };
  if (!isPlainRecord(left) || !isPlainRecord(right)) return { ok: false };
  const output: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(left)) defineJsonProperty(output, key, value);
  for (const [key, value] of Object.entries(right)) {
    if (!Object.hasOwn(output, key)) defineJsonProperty(output, key, value);
    else {
      const nested = mergeJsonValues(output[key]!, value);
      if (!nested.ok) return nested;
      defineJsonProperty(output, key, nested.value);
    }
  }
  return { ok: true, value: output };
}

function matchesSchema(
  schema: SchemaNode,
  value: JsonValue,
  path: string,
  depth: number,
  activeModels: Set<string>,
  state: GenerationState,
): boolean {
  visitNode(path, depth, state);
  if (schema.enum && !schema.enum.some((candidate, index) => {
    validateCandidateBudget(candidate, path + ".enum[" + index + "]", depth);
    return jsonEqual(candidate, value);
  })) return false;

  if (schema.kind === "scalar") {
    if (schema.type === "string") return typeof value === "string";
    if (schema.type === "number") return typeof value === "number";
    if (schema.type === "integer") return typeof value === "number" && Number.isInteger(value);
    if (schema.type === "boolean") return typeof value === "boolean";
    return value === null;
  }
  if (schema.kind === "array") {
    return Array.isArray(value)
      && value.every((item, index) => matchesSchema(schema.items, item, path + "[" + index + "]", depth + 1, activeModels, state));
  }
  if (schema.kind === "object") {
    if (!isPlainRecord(value)) return false;
    for (const required of schema.required) if (!Object.hasOwn(value, required)) return false;
    for (const [key, child] of Object.entries(value)) {
      const propertySchema = schema.properties[key];
      if (propertySchema) {
        if (!matchesSchema(propertySchema, child, path + ".properties." + key, depth + 1, activeModels, state)) return false;
      } else if (schema.additionalProperties === false) return false;
      else if (typeof schema.additionalProperties === "object"
        && !matchesSchema(schema.additionalProperties, child, path + ".additionalProperties", depth + 1, activeModels, state)) return false;
    }
    return true;
  }
  if (schema.kind === "modelRef") {
    if (activeModels.has(schema.modelId)) return false;
    const model = state.models.get(schema.modelId);
    if (!model) return false;
    activeModels.add(schema.modelId);
    try {
      return matchesSchema(model.schema, value, path + ".model(" + schema.modelId + ")", depth + 1, activeModels, state);
    } finally {
      activeModels.delete(schema.modelId);
    }
  }
  if (schema.kind === "allOf") {
    return schema.variants.every((variant, index) =>
      matchesSchema(variant, value, path + ".variants[" + index + "]", depth + 1, activeModels, state));
  }
  const matches = schema.variants.map((variant, index) =>
    matchesSchema(variant, value, path + ".variants[" + index + "]", depth + 1, activeModels, state));
  return schema.kind === "anyOf" ? matches.some(Boolean) : matches.filter(Boolean).length === 1;
}

function orderCandidates(candidates: JsonValue[], options: GenerateMockJsonOptions, path: string, depth: number): JsonValue[] {
  candidates.forEach((candidate, index) => validateCandidateBudget(candidate, path + "[" + index + "]", depth));
  return uniqueCandidates(candidates, path, depth).sort((left, right) => {
    const leftJson = canonicalJson(left);
    const rightJson = canonicalJson(right);
    const salt = options.seed + "\0" + options.contractId + "\0" + options.ruleId + "\0" + path + "\0";
    const leftHash = createHash("sha256").update(salt).update(leftJson).digest("hex");
    const rightHash = createHash("sha256").update(salt).update(rightJson).digest("hex");
    return leftHash.localeCompare(rightHash) || leftJson.localeCompare(rightJson);
  });
}

function uniqueCandidates(candidates: JsonValue[], path: string, depth: number): JsonValue[] {
  const seen = new Set<string>();
  const output: JsonValue[] = [];
  for (const [index, candidate] of candidates.entries()) {
    validateCandidateBudget(candidate, path + ".candidate[" + index + "]", depth);
    const key = canonicalJson(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(candidate);
    if (output.length >= MAX_CANDIDATES) break;
  }
  return output;
}

function validateCandidateBudget(value: JsonValue, path: string, baseDepth: number): void {
  const pending: Array<{ value: JsonValue; path: string; depth: number }> = [{ value, path, depth: baseDepth }];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > MAX_DEPTH) {
      throw new GenerationFailure("MOCK_SCHEMA_LIMIT", current.path, "A response candidate exceeded the approved depth limit.");
    }
    nodes += 1;
    if (nodes > MAX_NODES) {
      throw new GenerationFailure("MOCK_SCHEMA_LIMIT", path, "A response candidate exceeded the approved node limit.");
    }
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        pending.push({ value: current.value[index]!, path: current.path + "[" + index + "]", depth: current.depth + 1 });
      }
    } else if (isPlainRecord(current.value)) {
      for (const [key, child] of Object.entries(current.value)) {
        pending.push({ value: child, path: current.path + "." + key, depth: current.depth + 1 });
      }
    }
  }
}

function visitNode(path: string, depth: number, state: GenerationState): void {
  if (depth > MAX_DEPTH) throw new GenerationFailure("MOCK_SCHEMA_LIMIT", path, "Response schema generation exceeded the approved depth limit.");
  state.nodes += 1;
  if (state.nodes > MAX_NODES) throw new GenerationFailure("MOCK_SCHEMA_LIMIT", path, "Response schema generation exceeded the approved node limit.");
}

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalJson(value[key]!)).join(",") + "}";
}

function isPlainRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defineJsonProperty(target: Record<string, JsonValue>, key: string, value: JsonValue): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

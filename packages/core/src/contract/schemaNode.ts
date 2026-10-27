import { z } from "zod";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.custom<JsonValue>(
  (value) => isJsonValue(value, new Set<object>()),
  { message: "Expected a JSON value" },
).meta({ apiccJsonWireSchema: z.json() });

export function StringRecordSchema<Value>(valueSchema: z.ZodType<Value>): z.ZodType<Record<string, Value>> {
  return z.custom<Record<string, unknown>>(isPlainStringRecord, { message: "Expected a plain string-keyed object" })
    .transform((record, context) => {
      const output: Record<string, Value> = {};
      let keys: PropertyKey[];
      try {
        keys = Reflect.ownKeys(record);
      } catch {
        context.addIssue({ code: "custom", path: [], message: "Dictionary entries could not be inspected" });
        return output;
      }

      for (const key of keys) {
        if (typeof key !== "string") {
          context.addIssue({ code: "custom", path: [String(key)], message: "Dictionary keys must be strings" });
          continue;
        }

        let descriptor: PropertyDescriptor | undefined;
        try {
          descriptor = Object.getOwnPropertyDescriptor(record, key);
        } catch {
          context.addIssue({ code: "custom", path: [key], message: "Dictionary entry could not be inspected" });
          continue;
        }
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          context.addIssue({ code: "custom", path: [key], message: "Dictionary entries must be enumerable data properties" });
          continue;
        }

        const parsed = valueSchema.safeParse(descriptor.value);
        if (!parsed.success) {
          for (const issue of parsed.error.issues) {
            context.addIssue({ ...issue, path: [key, ...issue.path] });
          }
          continue;
        }

        Object.defineProperty(output, key, {
          value: parsed.data,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return output;
    }).meta({ apiccJsonWireSchema: z.record(z.string(), valueSchema) });
}

export interface SchemaAnnotations {
  description?: string;
  default?: JsonValue;
  examples?: JsonValue[];
  enum?: JsonValue[];
}

export type SchemaNode = SchemaAnnotations & (
  | { kind: "scalar"; type: "string" | "number" | "integer" | "boolean" | "null" }
  | { kind: "object"; properties: Record<string, SchemaNode>; required: string[]; additionalProperties: boolean | SchemaNode }
  | { kind: "array"; items: SchemaNode }
  | { kind: "allOf" | "oneOf" | "anyOf"; variants: SchemaNode[] }
  | { kind: "modelRef"; modelId: string }
);

const annotationsShape = {
  description: z.string().optional(),
  default: JsonValueSchema.optional(),
  examples: z.array(JsonValueSchema).optional(),
  enum: z.array(JsonValueSchema).optional(),
};

const scalarNodeSchema = z.object({
  ...annotationsShape,
  kind: z.literal("scalar"),
  type: z.enum(["string", "number", "integer", "boolean", "null"]),
}).strict();

let schemaNodeShapeSchema!: z.ZodType<SchemaNode>;
const recursiveSchemaNodeShape = z.lazy(() => schemaNodeShapeSchema);

const objectNodeSchema = z.object({
  ...annotationsShape,
  kind: z.literal("object"),
  properties: StringRecordSchema(recursiveSchemaNodeShape),
  required: z.array(z.string()),
  additionalProperties: z.union([z.boolean(), z.lazy(() => SchemaNodeSchema)]),
}).strict();

const arrayNodeSchema = z.object({
  ...annotationsShape,
  kind: z.literal("array"),
  items: z.lazy(() => SchemaNodeSchema),
}).strict();

const combinatorNodeSchema = z.object({
  ...annotationsShape,
  kind: z.enum(["allOf", "oneOf", "anyOf"]),
  variants: z.array(z.lazy(() => SchemaNodeSchema)),
}).strict();

const modelReferenceNodeSchema = z.object({
  ...annotationsShape,
  kind: z.literal("modelRef"),
  modelId: z.string().uuid(),
}).strict();

schemaNodeShapeSchema = z.lazy(() =>
  z.discriminatedUnion("kind", [
    scalarNodeSchema,
    objectNodeSchema,
    arrayNodeSchema,
    combinatorNodeSchema,
    modelReferenceNodeSchema,
  ]),
);

export const SchemaNodeSchema: z.ZodType<SchemaNode> = z.unknown()
  .superRefine((input, context) => {
    if (containsObjectCycle(input, new Set<object>())) {
      context.addIssue({ code: "custom", path: [], message: "SchemaNode must be a finite object tree" });
    }
  })
  .pipe(schemaNodeShapeSchema)
  // HTTP JSON has finite plain data trees: this exposes the same structural boundary
  // for build-time schema generation without weakening the in-memory cycle checks.
  .meta({ apiccJsonWireSchema: schemaNodeShapeSchema });

function isJsonValue(value: unknown, ancestors: Set<object>): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;

  if (ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return false;
      const ownKeys = Reflect.ownKeys(value);
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (!lengthDescriptor || !("value" in lengthDescriptor) || lengthDescriptor.value !== value.length
        || lengthDescriptor.enumerable !== false || lengthDescriptor.configurable !== false) {
        return false;
      }
      for (const key of ownKeys) {
        if (typeof key === "symbol") return false;
        if (key === "length") continue;
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
      }

      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || !isJsonValue(descriptor.value, ancestors)) {
          return false;
        }
      }
      return true;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) return false;

    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || !isJsonValue(descriptor.value, ancestors)) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    ancestors.delete(value);
  }
}

function isPlainStringRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function containsObjectCycle(value: unknown, ancestors: Set<object>): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (ancestors.has(value)) return true;

  ancestors.add(value);
  try {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && "value" in descriptor && containsObjectCycle(descriptor.value, ancestors)) return true;
    }
    return false;
  } catch {
    return true;
  } finally {
    ancestors.delete(value);
  }
}

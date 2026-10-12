import type { JsonValue, SchemaNode } from "../contract/schemaNode.js";
import type { ContractImportDiagnostic } from "./contractOpenapi.js";

export interface SchemaMappingContext {
  ownerId: string;
  sourcePath: string;
  modelIds: ReadonlyMap<string, string>;
  diagnostics: ContractImportDiagnostic[];
}

const schemaKeywords = new Set([
  "$ref", "$schema", "$id", "$anchor", "$comment", "$defs", "definitions",
  "type", "format", "title", "description", "default", "enum", "example", "examples",
  "items", "properties", "required", "additionalProperties", "allOf", "anyOf", "oneOf",
  "nullable", "readOnly", "writeOnly", "deprecated", "discriminator", "xml", "externalDocs",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength",
  "maxLength", "pattern", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties",
  "propertyNames", "contains", "not", "if", "then", "else", "dependentRequired", "dependentSchemas",
  "unevaluatedItems", "unevaluatedProperties", "contentEncoding", "contentMediaType", "contentSchema",
  "const", "enumNames", "propertyOrder",
]);

const supportedKeys = new Set([
  "$ref", "type", "description", "default", "enum", "examples", "example", "items", "properties",
  "required", "additionalProperties", "allOf", "anyOf", "oneOf",
]);

export const MASKED_SECRET_PLACEHOLDER = "****";

const credentialFieldPattern = /(?:^|[-_.])(authorization|proxy-authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|password|passwd|secret|token|set-cookie|cookie|session[-_]?id|csrf[-_]?token)(?:$|[-_.])/i;

export function isCredentialFieldName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return credentialFieldPattern.test(`.${normalized}.`)
    || ["authorization", "password", "passwd", "secret", "token", "apikey", "api_key", "access_token", "refresh_token", "client_secret", "cookie", "set-cookie", "sessionid", "session_id", "csrftoken", "csrf_token"].includes(normalized);
}

export function redactCredentialValue(value: JsonValue, key?: string): JsonValue {
  if (key && isCredentialFieldName(key)) return MASKED_SECRET_PLACEHOLDER;
  if (typeof value === "string") return redactCommonCredentialText(value);
  if (Array.isArray(value)) return value.map((item) => redactCredentialValue(item));
  if (value !== null && typeof value === "object") {
    const redacted: Record<string, JsonValue> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      Object.defineProperty(redacted, childKey, {
        value: redactCredentialValue(childValue, childKey),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return redacted;
  }
  return value;
}

export function redactCommonCredentialText(value: string): string {
  const headerMasked = value.replace(/(^|[\r\n])([ \t]*(?:authorization|proxy-authorization)\s*:\s*)([^\r\n]*)/gi, (match, linePrefix: string, header: string, headerValue: string) => {
    const leading = /^\s*/.exec(headerValue)?.[0] ?? "";
    const trimmed = headerValue.trimStart();
    if (!trimmed) return match;
    const scheme = /^(?:bearer|basic)\s+/i.exec(trimmed)?.[0];
    return `${linePrefix}${header}${leading}${scheme ?? ""}${MASKED_SECRET_PLACEHOLDER}`;
  });
  return headerMasked.replace(
    /(\b(?:api[-_]?key|access[-_]?token|refresh[-_]?token|id[-_]?token|client[-_]?secret|password|passwd|secret|token)\b\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
    `$1${MASKED_SECRET_PLACEHOLDER}`,
  );
}

export function stripCredentialValues(value: JsonValue): { value: JsonValue; removedPaths: string[] } {
  const removedPaths: string[] = [];
  const visit = (current: JsonValue, path: string): JsonValue => {
    if (Array.isArray(current)) return current.map((item, index) => visit(item, `${path}[${index}]`));
    if (typeof current === "string") {
      const redacted = redactCommonCredentialText(current);
      if (redacted !== current) removedPaths.push(path);
      return redacted;
    }
    if (current !== null && typeof current === "object") {
      const output: Record<string, JsonValue> = {};
      for (const [key, child] of Object.entries(current)) {
        const childPath = path ? `${path}.${key}` : key;
        if (isCredentialFieldName(key) && child !== "") {
          removedPaths.push(childPath);
          Object.defineProperty(output, key, { value: "", enumerable: true, configurable: true, writable: true });
        } else {
          Object.defineProperty(output, key, { value: visit(child, childPath), enumerable: true, configurable: true, writable: true });
        }
      }
      return output;
    }
    return current;
  };
  return { value: visit(value, ""), removedPaths };
}

export function mapContractSchema(input: unknown, context: SchemaMappingContext): SchemaNode {
  const source = asRecord(input);
  if (!source) {
    addDiagnostic(context, "SCHEMA_VALUE_UNSUPPORTED", context.sourcePath, "The source schema is not an object and was represented as a string.");
    return { kind: "scalar", type: "string" };
  }

  if (typeof source.$ref === "string") {
    const modelId = context.modelIds.get(source.$ref);
    for (const key of Object.keys(source)) {
      if (["$ref", "description", "default", "enum", "example", "examples"].includes(key)) continue;
      const code = schemaKeywords.has(key) ? "SCHEMA_KEYWORD_UNSUPPORTED" : "SCHEMA_KEYWORD_UNKNOWN";
      addDiagnostic(context, code, `${context.sourcePath}/${key}`, "This keyword beside a schema reference is not represented by the contract schema model.");
    }
    const annotations = mapAnnotations(source, context);
    if (modelId) return { ...annotations, kind: "modelRef", modelId };
    const code = source.$ref.startsWith("#/") ? "SCHEMA_INTERNAL_REFERENCE_UNRESOLVED" : "SCHEMA_EXTERNAL_REFERENCE_UNSUPPORTED";
    addDiagnostic(context, code, `${context.sourcePath}/$ref`, source.$ref.startsWith("#/")
      ? "The local schema reference was not found and was represented as a string."
      : "External schema references are not fetched and were represented as a string.");
    return { ...annotations, kind: "scalar", type: "string" };
  }

  for (const key of Object.keys(source)) {
    if (supportedKeys.has(key)) continue;
    if (schemaKeywords.has(key)) {
      addDiagnostic(context, "SCHEMA_KEYWORD_UNSUPPORTED", `${context.sourcePath}/${key}`, "This schema keyword is not represented by the contract schema model.");
    } else {
      addDiagnostic(context, "SCHEMA_KEYWORD_UNKNOWN", `${context.sourcePath}/${key}`, "This unrecognized schema keyword was not imported.");
    }
  }

  const annotations = mapAnnotations(source, context);
  const compositionKinds = (["allOf", "oneOf", "anyOf"] as const).filter((kind) => source[kind] !== undefined);
  if (compositionKinds.length > 0) {
    const hasBaseShape = source.type !== undefined
      || source.properties !== undefined
      || source.items !== undefined;
    let baseShape: SchemaNode | undefined;
    if (hasBaseShape) {
      const baseSource = { ...source };
      for (const kind of compositionKinds) delete baseSource[kind];
      for (const annotation of ["description", "default", "enum", "example", "examples"]) delete baseSource[annotation];
      baseShape = mapContractSchema(baseSource, context);
    } else {
      if (source.required !== undefined) {
        addDiagnostic(context, "SCHEMA_KEYWORD_UNSUPPORTED", `${context.sourcePath}/required`, "This object-only constraint has no explicit object shape at this level; it was omitted without inferring a type.");
      }
      if (source.additionalProperties !== undefined) {
        addDiagnostic(context, "SCHEMA_KEYWORD_UNSUPPORTED", `${context.sourcePath}/additionalProperties`, "This object-only constraint has no explicit object shape at this level; it was omitted without inferring a type.");
      }
    }
    const compositions = compositionKinds.map((kind): SchemaNode => {
      const sourceVariants = source[kind];
      if (!Array.isArray(sourceVariants)) {
        addDiagnostic(context, "SCHEMA_COMBINATOR_UNSUPPORTED", `${context.sourcePath}/${kind}`, "The schema composition value is not an array and was represented as a string.");
        return { kind: "scalar", type: "string" };
      }
      return {
        kind,
        variants: sourceVariants.map((variant, index) => mapContractSchema(variant, { ...context, sourcePath: `${context.sourcePath}/${kind}/${index}` })),
      };
    });
    const variants = [...(baseShape ? [baseShape] : []), ...compositions.flatMap((composition) =>
      composition.kind === "allOf" ? composition.variants : [composition])];
    if (baseShape || compositions.length > 1) return { ...annotations, kind: "allOf", variants };
    const [onlyComposition] = compositions;
    if (onlyComposition) return { ...annotations, ...onlyComposition };
  }

  const type = source.type;
  if (type === "object" || (type === undefined && isRecord(source.properties))) {
    const properties: Record<string, SchemaNode> = {};
    if (isRecord(source.properties)) {
      for (const [name, propertySchema] of Object.entries(source.properties)) {
        const propertyPath = `${context.sourcePath}/properties/${name}`;
        Object.defineProperty(properties, name, {
          value: mapContractSchema(propertySchema, { ...context, sourcePath: propertyPath }),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    } else if (source.properties !== undefined) {
      addDiagnostic(context, "SCHEMA_PROPERTIES_UNSUPPORTED", `${context.sourcePath}/properties`, "The properties value is not an object and was omitted.");
    }
    const required = Array.isArray(source.required)
      ? source.required.filter((item): item is string => typeof item === "string")
      : [];
    if (source.required !== undefined && !Array.isArray(source.required)) {
      addDiagnostic(context, "SCHEMA_REQUIRED_UNSUPPORTED", `${context.sourcePath}/required`, "The required value is not an array and was omitted.");
    }
    const additionalProperties = typeof source.additionalProperties === "boolean"
      ? source.additionalProperties
      : source.additionalProperties === undefined
        ? true
        : mapContractSchema(source.additionalProperties, { ...context, sourcePath: `${context.sourcePath}/additionalProperties` });
    return { ...annotations, kind: "object", properties, required, additionalProperties };
  }

  if (type === "array" || (type === undefined && source.items !== undefined)) {
    const items = source.items === undefined
      ? { kind: "scalar" as const, type: "string" as const }
      : mapContractSchema(source.items, { ...context, sourcePath: `${context.sourcePath}/items` });
    return { ...annotations, kind: "array", items };
  }

  for (const kind of ["allOf", "oneOf", "anyOf"] as const) {
    if (source[kind] !== undefined) {
      const variants = source[kind];
      if (!Array.isArray(variants)) {
        addDiagnostic(context, "SCHEMA_COMBINATOR_UNSUPPORTED", `${context.sourcePath}/${kind}`, "The schema composition value is not an array and was represented as a string.");
        return { ...annotations, kind: "scalar", type: "string" };
      }
      return {
        ...annotations,
        kind,
        variants: variants.map((variant, index) => mapContractSchema(variant, { ...context, sourcePath: `${context.sourcePath}/${kind}/${index}` })),
      };
    }
  }

  const scalarTypes: Record<string, "string" | "number" | "integer" | "boolean" | "null"> = {
    string: "string",
    number: "number",
    integer: "integer",
    boolean: "boolean",
    null: "null",
  };
  if (typeof type === "string" && scalarTypes[type]) return { ...annotations, kind: "scalar", type: scalarTypes[type] };
  if (Array.isArray(type)) {
    const variants = type.flatMap((item) => {
      const mapped = typeof item === "string" ? scalarTypes[item] : undefined;
      return mapped ? [{ kind: "scalar" as const, type: mapped }] : [];
    });
    if (variants.length === type.length) return { ...annotations, kind: "oneOf", variants };
  }

  if (type !== undefined) addDiagnostic(context, "SCHEMA_TYPE_UNSUPPORTED", `${context.sourcePath}/type`, "The source type is not supported and was represented as a string.");
  return { ...annotations, kind: "scalar", type: "string" };
}

function mapAnnotations(source: Record<string, unknown>, context: SchemaMappingContext): Pick<SchemaNode, "description" | "default" | "examples" | "enum"> {
  const annotationPath = context.sourcePath;
  const lastSegment = annotationPath.split("/").at(-1) ?? "";
  const sensitive = isCredentialFieldName(lastSegment);
  const description = typeof source.description === "string" ? source.description : undefined;
  const annotations: Pick<SchemaNode, "description" | "default" | "examples" | "enum"> = {};

  if (source.default !== undefined) {
    if (isJsonValue(source.default)) {
      annotations.default = sanitizeAnnotation(source.default, "default", context, sensitive);
    } else {
      addDiagnostic(context, "SCHEMA_ANNOTATION_UNSUPPORTED", `${annotationPath}/default`, "The default value is not JSON-compatible and was omitted.");
    }
  }
  if (source.examples !== undefined) {
    const examples = jsonArray(source.examples);
    if (examples) {
      annotations.examples = examples.map((value, index) => sanitizeAnnotation(value, `examples/${index}`, context, sensitive));
    } else {
      addDiagnostic(context, "SCHEMA_ANNOTATION_UNSUPPORTED", `${annotationPath}/examples`, "The examples value is not a JSON array and was omitted.");
    }
  } else if (source.example !== undefined) {
    if (isJsonValue(source.example)) {
      annotations.examples = [sanitizeAnnotation(source.example, "example", context, sensitive)];
    } else {
      addDiagnostic(context, "SCHEMA_ANNOTATION_UNSUPPORTED", `${annotationPath}/example`, "The example value is not JSON-compatible and was omitted.");
    }
  }
  if (source.enum !== undefined) {
    const values = jsonArray(source.enum);
    if (values) {
      annotations.enum = values.map((_value, index) => sanitizeAnnotation(_value, `enum/${index}`, context, sensitive));
    } else {
      addDiagnostic(context, "SCHEMA_ANNOTATION_UNSUPPORTED", `${annotationPath}/enum`, "The enum value is not a JSON array and was omitted.");
    }
  }
  if (description !== undefined) annotations.description = description;
  return annotations;
}

function sanitizeAnnotation(value: JsonValue, path: string, context: SchemaMappingContext, sensitiveNode: boolean): JsonValue {
  if (sensitiveNode) {
    addDiagnostic(context, "AUTH_VALUE_REMOVED", `${context.sourcePath}/${path}`, "A common credential Schema annotation was masked; fill it again in the local credential entry.");
    return MASKED_SECRET_PLACEHOLDER;
  }
  const stripped = stripCredentialValues(value);
  for (const removedPath of stripped.removedPaths) {
    addDiagnostic(context, "AUTH_VALUE_REMOVED", `${context.sourcePath}/${path}/${removedPath}`, "A common credential value was removed from the Schema annotation.");
  }
  return stripped.value;
}

function addDiagnostic(context: SchemaMappingContext, code: string, path: string, reason: string): void {
  context.diagnostics.push({ code, ownerId: context.ownerId, path, reason });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors))
    : Object.values(value).every((item) => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}

function jsonArray(value: unknown): JsonValue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const output: JsonValue[] = [];
  for (const item of value) {
    if (!isJsonValue(item)) return undefined;
    output.push(item);
  }
  return output;
}

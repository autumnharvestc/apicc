import { createHash } from "node:crypto";
import { isAlias, isMap, isPair, isScalar, isSeq, parseDocument, stringify, type Document } from "yaml";
import { parseContractOpenapi } from "../import/contractOpenapi.js";
import { encodeContractProjectFiles } from "../storage/contractFiles.js";
import { SyncNormalizeInputSchema, type SyncDiagnostic, type SyncNormalizeInput, type SyncNormalizedSource } from "./types.js";
import { createSyncIdentity } from "./identity.js";

export function normalizeSyncSource(input: SyncNormalizeInput): SyncNormalizedSource {
  input = SyncNormalizeInputSchema.parse(input);
  const maxBytes = input.budget.maxCompareInputBytes;
  const assertBytes = (value: unknown) => {
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxBytes) throw new NormalizeOutputBudgetError();
  };
  assertBytes(input.mapping);
  const diagnostics: SyncDiagnostic[] = [];
  const fail = (code: string, message: string): SyncNormalizedSource => {
    const result: SyncNormalizedSource = {
      files: [], mapping: input.mapping, entityIds: [], manifestDigest: manifestDigest([]),
      diagnostics: [{ code, severity: "error", ownerId: input.source.moduleId, path: "", message }],
    };
    assertBytes(result);
    return { ...result, mapping: structuredClone(input.mapping) };
  };
  if (Buffer.byteLength(input.rawText, "utf8") > input.budget.maxSourceBytes) return fail("SYNC_SOURCE_BYTES_EXCEEDED", "Source UTF-8 bytes exceed maxSourceBytes.");
  let root: unknown;
  try {
    const document = parseDocument(input.rawText, { prettyErrors: false });
    if (document.errors.length) return fail("SYNC_SOURCE_PARSE_FAILED", "Source is not a valid single YAML/JSON document.");
    checkDocumentBudget(document, input.budget);
    // The AST has already bounded the complete expanded graph. The library's
    // fixed alias-count default is not the configurable normalization budget.
    root = document.toJS({ maxAliasCount: -1 });
  } catch (error) {
    if (error instanceof NormalizeOutputBudgetError) throw error;
    if (error instanceof NormalizeLimit) return fail(error.code, error.message);
    return fail("SYNC_SOURCE_PARSE_FAILED", "Source could not be parsed within the supported YAML/JSON representation.");
  }
  if (!root || typeof root !== "object" || Array.isArray(root)) return fail("SYNC_SOURCE_PARSE_FAILED", "An OpenAPI document object is required.");
  const source = root as Record<string, unknown>;
  if (!(source.swagger === "2.0" && source.openapi === undefined)
    && !(source.swagger === undefined && typeof source.openapi === "string" && /^3\.[01]\.[0-9]+$/.test(source.openapi))) {
    return fail("SYNC_OPENAPI_VERSION_UNSUPPORTED", "Supported versions are Swagger 2.0 and OpenAPI 3.0.x/3.1.x.");
  }
  const identities = createSyncIdentity(input.source.id, input.source.moduleId, input.mapping, diagnostics);
  reportReferences(source, input.source.moduleId, diagnostics);
  const imported = parseContractOpenapi(source, identities.identity);
  diagnostics.push(...imported.diagnostics.map(d=>({ code: d.code, severity: "warning" as const, ownerId: d.ownerId, path: d.path, message: d.reason })));
  const files = [...encodeContractProjectFiles(imported.project).files].map(([path, content]) => ({ path, content })).sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const result = { files, ...identities.result(), manifestDigest: manifestDigest(files), diagnostics };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > input.budget.maxCompareInputBytes) return fail("SYNC_NORMALIZED_BYTES_EXCEEDED", "Normalized files, mapping and diagnostics exceed maxCompareInputBytes.");
  return result;
}

/** Project-relative contract-files-v1; the synthetic project.yaml root is a
 * normalization container, not authority to replace a target project's ID. */
function manifestDigest(files: SyncNormalizedSource["files"]): string {
  return createHash("sha256").update(JSON.stringify(["apicc-sync-manifest-v1", files.map(f=>[f.path,f.content])]), "utf8").digest("hex");
}

class NormalizeLimit extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
/** Fixed-size failure when returning the complete historical map would itself
 * exceed the result budget. Never echo or silently truncate that map. */
class NormalizeOutputBudgetError extends RangeError {
  constructor() { super("SYNC_NORMALIZED_BYTES_EXCEEDED"); }
}
type Budget = SyncNormalizeInput["budget"];
type Cost = { nodes: number; depth: number; bytes: number };
function children(value: unknown): unknown[] {
  if (isMap(value) || isSeq(value)) return value.items;
  if (isPair(value)) return [value.key, value.value];
  return [];
}
/** Count YAML keys and values as nodes, with document root at depth 1.
 * Alias occurrences charge the full target's cost; no JS graph is expanded here.
 * Two iterative passes also avoid recursing through an unchecked AST. */
function checkDocumentBudget(document: Document, budget: Budget): void {
  const anchors = new Map<string, unknown>();
  const aliases = new Map<object, unknown>();
  const stack = [{ value: document.contents as unknown, depth: 1 }];
  let astNodes = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (++astNodes > budget.maxNormalizeNodes) throw new NormalizeLimit("SYNC_NORMALIZE_NODES_EXCEEDED", "Source nodes exceed maxNormalizeNodes.");
    if (depth > budget.maxNormalizeDepth) throw new NormalizeLimit("SYNC_NORMALIZE_DEPTH_EXCEEDED", "Source depth exceeds maxNormalizeDepth.");
    if (isAlias(value)) {
      if (!anchors.has(value.source)) throw new NormalizeLimit("SYNC_SOURCE_PARSE_FAILED", "YAML alias has no preceding anchor.");
      aliases.set(value, anchors.get(value.source));
    } else if (value && typeof value === "object" && "anchor" in value && typeof value.anchor === "string") anchors.set(value.anchor, value);
    const items = children(value);
    for (let i = items.length - 1; i >= 0; i--) stack.push({ value: items[i], depth: depth + 1 });
  }
  const memo = new Map<unknown, Cost>();
  const visiting = new Set<unknown>();
  const pending = [{ value: document.contents as unknown, exit: false }];
  while (pending.length) {
    const { value, exit } = pending.pop()!;
    if (memo.has(value)) continue;
    const items = isAlias(value) ? [aliases.get(value)] : children(value);
    if (!exit) {
      if (visiting.has(value)) throw new NormalizeLimit("SYNC_YAML_ALIAS_CYCLE", "Cyclic YAML aliases cannot be normalized.");
      visiting.add(value);
      pending.push({ value, exit: true });
      for (let i = items.length - 1; i >= 0; i--) pending.push({ value: items[i], exit: false });
      continue;
    }
    let cost: Cost;
    if (isAlias(value)) cost = memo.get(items[0])!;
    else {
      const scalar = isScalar(value) ? value.value : value == null ? null : undefined;
      const scalarBytes = scalar === undefined ? 0 : Buffer.byteLength(JSON.stringify(scalar) ?? "null", "utf8");
      // Empty containers still cost two bytes. Maps/sequences charge separators;
      // each pair charges its colon. A pair's scalar key is a JSON string even
      // when YAML parsed it as a number or boolean.
      let overhead = isMap(value) || isSeq(value) ? 2 + Math.max(0, items.length - 1) : isPair(value) ? 1 : 0;
      if (isPair(value)) {
        let key = value.key;
        while (isAlias(key)) key = aliases.get(key);
        if (isScalar(key)) {
          const keyBytes = Buffer.byteLength(JSON.stringify(key.value === null ? "" : String(key.value)), "utf8");
          overhead += Math.max(0, keyBytes - memo.get(value.key)!.bytes);
        } else if (isMap(key) || isSeq(key)) {
          // YAML stringifies a collection-valued key as flow YAML, then uses
          // that text as a JSON object key. Render only the bounded AST (aliases
          // stay alias tokens); allow six bytes per byte for JSON escaping.
          const rendered = stringify(value.key, { collectionStyle: "flow", verifyAliasOrder: false });
          const keyBytes = 2 + 6 * Buffer.byteLength(rendered, "utf8");
          overhead += Math.max(0, keyBytes - memo.get(value.key)!.bytes);
        }
      }
      cost = { nodes: 1, depth: 1, bytes: scalarBytes + overhead };
      for (const item of items) {
        const child = memo.get(item)!;
        cost.nodes += child.nodes; cost.depth = Math.max(cost.depth, child.depth + 1); cost.bytes += child.bytes;
      }
    }
    if (cost.nodes > budget.maxNormalizeNodes) throw new NormalizeLimit("SYNC_NORMALIZE_NODES_EXCEEDED", "Expanded YAML nodes exceed maxNormalizeNodes.");
    if (cost.depth > budget.maxNormalizeDepth) throw new NormalizeLimit("SYNC_NORMALIZE_DEPTH_EXCEEDED", "Expanded YAML depth exceeds maxNormalizeDepth.");
    if (cost.bytes > budget.maxCompareInputBytes) throw new NormalizeLimit("SYNC_NORMALIZED_BYTES_EXCEEDED", "Expanded YAML bytes exceed maxCompareInputBytes.");
    memo.set(value, cost); visiting.delete(value);
  }
}

const pointerPart = (value: string) => value.replaceAll("~", "~0").replaceAll("/", "~1");
/** Follow OpenAPI/JSON Schema roles, not arbitrary business JSON objects.
 * Annotation payloads, example values and extensions are deliberately opaque;
 * dictionary entries (including properties called example/default/value/x-*)
 * still inherit their dictionary's semantic role. */
function reportReferences(root: Record<string, unknown>, ownerId: string, diagnostics: SyncDiagnostic[]): void {
  type Role = "root" | "components" | "path" | "operation" | "parameter" | "header" | "body" | "response" | "media" | "encoding" | "example" | "schema" | "callback" | "reference";
  const pending: Array<{ value: unknown; path: string; role: Role }> = [{ value: root, path: "", role: "root" }];
  const referenceRoles = new Set<Role>(["path", "parameter", "header", "body", "response", "example", "schema", "callback", "reference"]);
  const visited = new WeakMap<object, Set<Role>>();
  while (pending.length) {
    const { value, path, role } = pending.pop()!;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const object = value as Record<string, unknown>;
    const roles = visited.get(object) ?? new Set<Role>();
    if (roles.has(role)) continue;
    roles.add(role); visited.set(object, roles);
    if (referenceRoles.has(role) && typeof object.$ref === "string") {
      const ref = object.$ref;
      let code: string | undefined;
      if (!ref.startsWith("#")) code = "SYNC_EXTERNAL_REFERENCE_UNSUPPORTED";
      else {
        let target: unknown = root;
        let targetPath = "";
        try {
          const pointer = decodeURIComponent(ref.slice(1));
          if (pointer !== "" && !pointer.startsWith("/")) target = undefined;
          else for (const token of pointer === "" ? [] : pointer.slice(1).split("/")) {
            if (/~(?![01])/.test(token)) { target = undefined; break; }
            const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
            target = target && typeof target === "object" && Object.hasOwn(target, key) ? (target as Record<string, unknown>)[key] : undefined;
            targetPath += `/${pointerPart(key)}`;
          }
        } catch { target = undefined; }
        if (target === undefined) code = "SYNC_INTERNAL_REFERENCE_UNRESOLVED";
        // A semantic reference gives its target the same role, even when that
        // object lives in an otherwise opaque extension. Keep its real source
        // pointer; object+role visitation bounds recursive reference graphs.
        else pending.push({ value: target, path: targetPath, role });
      }
      if (code) diagnostics.push({ code, severity: "error", ownerId, path: `${path}/$ref`, message: code === "SYNC_EXTERNAL_REFERENCE_UNSUPPORTED" ? "Only single-document internal references are supported; external references are not fetched." : "Internal reference does not resolve in this source document." });
    }
    const child = (key: string, nextRole: Role) => pending.push({ value: object[key], path: `${path}/${pointerPart(key)}`, role: nextRole });
    const dictionary = (key: string, nextRole: Role) => {
      const members = object[key];
      if (members && typeof members === "object" && !Array.isArray(members)) {
        for (const [name, member] of Object.entries(members)) {
          // These two maps have explicit extension fields. Named component and
          // schema-property dictionaries may legitimately have x-* entry names.
          if (name.startsWith("x-") && ((role === "root" && key === "paths") || (role === "operation" && key === "responses"))) continue;
          pending.push({ value: member, path: `${path}/${pointerPart(key)}/${pointerPart(name)}`, role: nextRole });
        }
      }
    };
    const array = (key: string, nextRole: Role) => {
      const members = object[key];
      if (Array.isArray(members)) members.forEach((member,index)=>pending.push({ value: member, path: `${path}/${pointerPart(key)}/${index}`, role: nextRole }));
    };
    switch (role) {
      case "root":
        dictionary("paths", "path"); dictionary("webhooks", "path"); child("components", "components");
        dictionary("definitions", "schema"); dictionary("parameters", "parameter"); dictionary("responses", "response"); dictionary("securityDefinitions", "reference");
        break;
      case "components":
        dictionary("schemas", "schema"); dictionary("parameters", "parameter"); dictionary("headers", "header"); dictionary("requestBodies", "body");
        dictionary("responses", "response"); dictionary("examples", "example"); dictionary("callbacks", "callback"); dictionary("pathItems", "path"); dictionary("securitySchemes", "reference"); dictionary("links", "reference");
        break;
      case "path":
        array("parameters", "parameter");
        for (const method of ["get", "put", "post", "delete", "options", "head", "patch", "trace"]) child(method, "operation");
        break;
      case "operation":
        array("parameters", "parameter"); child("requestBody", "body"); dictionary("responses", "response"); dictionary("callbacks", "callback");
        break;
      case "parameter": case "header":
        child("schema", "schema"); child("items", "schema"); dictionary("content", "media"); dictionary("examples", "example");
        break;
      case "body": dictionary("content", "media"); break;
      case "response":
        child("schema", "schema"); dictionary("headers", "header"); dictionary("content", "media"); dictionary("links", "reference");
        break;
      case "media": child("schema", "schema"); dictionary("examples", "example"); dictionary("encoding", "encoding"); break;
      case "encoding": dictionary("headers", "header"); break;
      case "callback":
        for (const [name, member] of Object.entries(object)) if (name !== "$ref" && !name.startsWith("x-")) pending.push({ value: member, path: `${path}/${pointerPart(name)}`, role: "path" });
        break;
      case "schema":
        for (const key of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"]) dictionary(key, "schema");
        for (const key of ["additionalProperties", "additionalItems", "contains", "not", "if", "then", "else", "propertyNames", "unevaluatedProperties", "unevaluatedItems", "contentSchema"]) child(key, "schema");
        if (Array.isArray(object.items)) array("items", "schema"); else child("items", "schema");
        for (const key of ["allOf", "oneOf", "anyOf", "prefixItems"]) array(key, "schema");
        break;
      case "example": case "reference": break;
    }
  }
}

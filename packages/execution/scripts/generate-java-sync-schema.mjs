import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const descriptiveMetadata = new Set(["title", "description", "deprecated", "examples", "$comment"]);

/** Only expressible strict wire schemas cross into Java. No refinement substitutions. */
function requireExpressible(schema, path, seen) {
  if (seen.has(schema)) return;
  seen.add(schema);
  const def = schema._zod.def;
  if ((def.checks ?? []).some(check => ["custom", "overwrite"].includes(check._zod?.def.check))
    || ["custom", "transform", "pipe", "unknown", "any"].includes(def.type)) {
    throw new Error(`Unrepresented ${def.type}/refinement at ${path}`);
  }
  for (const [key, value] of Object.entries(schema.meta() ?? {})) {
    if (descriptiveMetadata.has(key)) continue;
    if (["$ref", "$dynamicRef", "$recursiveRef"].includes(key) && (typeof value !== "string" || !value.startsWith("#"))) throw new Error(`Nonlocal generated ${key} metadata at ${path}`);
    throw new Error(`Unrepresented validation metadata '${key}' at ${path}`);
  }
  if (def.type === "object" && def.catchall?._zod?.def.type !== "never") throw new Error(`Expected strict wire object at ${path}`);
  if (def.type === "lazy") requireExpressible(def.getter(), `${path}.lazy`, seen);
  const inspect = (value, location) => {
    if (value?._zod) requireExpressible(value, location, seen);
    else if (Array.isArray(value)) value.forEach((child, index) => inspect(child, `${location}[${index}]`));
    else if (value && typeof value === "object") Object.entries(value).forEach(([key, child]) => inspect(child, `${location}.${key}`));
  };
  for (const [key, value] of Object.entries(def)) if (key !== "checks") inspect(value, `${path}.${key}`);
}

function hasFinitePropertyNames(schema, root, refs = new Set()) {
  if (!schema || typeof schema !== "object") return false;
  if (Array.isArray(schema.enum)) return schema.enum.every(value => typeof value === "string");
  if (typeof schema.const === "string") return true;
  if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/") && !refs.has(schema.$ref)) {
    const next = new Set(refs).add(schema.$ref);
    const target = schema.$ref.slice(2).split("/").map(part => part.replace(/~1/g, "/").replace(/~0/g, "~")).reduce((value, key) => value?.[key], root);
    return hasFinitePropertyNames(target, root, next);
  }
  return false;
}

/** Inspect schema locations, not annotation/default payloads containing ordinary objects. */
function requireGeneratedStrictObjects(schema, root = schema, path = "root") {
  if (!schema || typeof schema !== "object") return;
  const isObject = schema.type === "object" || (Array.isArray(schema.type) && schema.type.includes("object")) || "properties" in schema || "additionalProperties" in schema;
  if (isObject && schema.additionalProperties !== false && !hasFinitePropertyNames(schema.propertyNames, root)) throw new Error(`Expected strict generated wire object at ${path}`);
  for (const key of ["$defs", "definitions", "properties", "patternProperties", "dependentSchemas"]) {
    for (const [name, child] of Object.entries(schema[key] ?? {})) requireGeneratedStrictObjects(child, root, `${path}.${key}.${name}`);
  }
  for (const key of ["items", "additionalProperties", "unevaluatedProperties", "propertyNames", "contains", "if", "then", "else", "not"]) requireGeneratedStrictObjects(schema[key], root, `${path}.${key}`);
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) (schema[key] ?? []).forEach((child, index) => requireGeneratedStrictObjects(child, root, `${path}.${key}[${index}]`));
}

function requireLocalRefs(value) {
  if (!value || typeof value !== "object") return;
  for (const key of ["$ref", "$dynamicRef", "$recursiveRef"]) {
    if (key in value && (typeof value[key] !== "string" || !value[key].startsWith("#"))) throw new Error(`Nonlocal generated ${key}`);
  }
  Object.values(value).forEach(requireLocalRefs);
}

export function buildSyncBoundary(schemas) {
  const document = {};
  for (const [name, schema] of Object.entries(schemas)) {
    requireExpressible(schema, name, new WeakSet());
    document[name] = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input", reused: "ref" });
    requireGeneratedStrictObjects(document[name]);
  }
  requireLocalRefs(document);
  return document;
}

export function checkSyncBoundaryBytes(actual, expected) {
  if (actual !== expected) throw new Error("SYNC_SCHEMA_DRIFT: regenerate the Java sync boundary from the current Core/execution build");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { syncWireSchemas } = await import("../dist/contract/synchronization.js");
  const document = { formatVersion: 1, effectivePolicyValidation: "resolveSyncPolicy", ...buildSyncBoundary(syncWireSchemas) };
  const bytes = JSON.stringify(document, null, 2) + "\n";
  const output = new URL("../../../server/src/main/resources/sync-input-boundary.json", import.meta.url);
  if (process.argv.includes("--check")) {
    checkSyncBoundaryBytes(await readFile(output, "utf8"), bytes);
    console.log("Java sync boundary matches strict wire schemas; effective-policy cross-field validation remains explicit.");
  } else {
    await writeFile(output, bytes);
    console.log(`Generated Java sync boundary (${Buffer.byteLength(bytes)} bytes).`);
  }
}

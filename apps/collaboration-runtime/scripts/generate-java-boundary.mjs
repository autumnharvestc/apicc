import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { RequestSchema, ResponseSchema, ErrorSchema } from "../dist/protocol.js";
import { coreBuildIdentity } from "../dist/core-identity.js";

// Same fail-closed conversion pattern as execution's networknt boundary.
function wireBoundary(root) {
  const converted = new WeakMap();
  function convert(schema, path) {
    if (converted.has(schema)) return converted.get(schema);
    const def = schema._zod.def;
    const explicit = schema.meta()?.apiccJsonWireSchema;
    if (explicit !== undefined) {
      if (!explicit?._zod) throw new Error(`Invalid JSON wire metadata at ${path}`);
      const result = convert(explicit, `${path}.wire`); converted.set(schema, result); return result;
    }
    if ((def.checks ?? []).some(check => ["custom", "overwrite"].includes(check._zod?.def.check))) throw new Error(`Unrepresented refinement at ${path}`);
    if (["custom", "transform", "pipe", "unknown", "any"].includes(def.type)) throw new Error(`Unrepresented ${def.type} at ${path}`);
    if (def.type === "lazy") { const result = z.lazy(() => convert(def.getter(), `${path}.lazy`)); converted.set(schema, result); return result; }
    const mapped = { ...def };
    for (const [key, value] of Object.entries(def)) {
      if (key === "checks") continue;
      const map = (entry, label) => entry?._zod ? convert(entry, label) : entry;
      if (value?._zod) mapped[key] = convert(value, `${path}.${key}`);
      else if (Array.isArray(value)) mapped[key] = value.map((entry, index) => map(entry, `${path}.${key}[${index}]`));
      else if (value && typeof value === "object") mapped[key] = Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, map(entry, `${path}.${key}.${name}`)]));
    }
    const result = schema.clone(mapped); converted.set(schema, result); return result;
  }
  return convert(root, "root");
}
const document = { formatVersion: 1, coreBuildIdentity: await coreBuildIdentity() };
for (const [name, schema] of Object.entries({ request: RequestSchema, response: ResponseSchema, error: ErrorSchema })) document[name] = z.toJSONSchema(wireBoundary(schema), { target: "draft-2020-12", io: "input", reused: "ref" });
function requireLocalRefs(value) {
  if (!value || typeof value !== "object") return;
  for (const key of ["$ref", "$dynamicRef", "$recursiveRef"]) if (key in value && (typeof value[key] !== "string" || !value[key].startsWith("#"))) throw new Error("Nonlocal generated reference");
  for (const child of Object.values(value)) requireLocalRefs(child);
}
requireLocalRefs(document);
const bytes = JSON.stringify(document, null, 2) + "\n";
const output = new URL("../../../server/src/main/resources/collaboration-runtime-boundary.json", import.meta.url);
if (process.argv.includes("--check")) {
  if (await readFile(output, "utf8") !== bytes) throw new Error("Collaboration generated boundary/Core identity drift");
  console.log("Collaboration strict boundary and actual Core build match.");
} else { await writeFile(output, bytes); console.log(`Generated collaboration boundary: ${Buffer.byteLength(bytes)} bytes`); }

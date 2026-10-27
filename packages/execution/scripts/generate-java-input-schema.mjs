import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { TaskTargetSchema } from "../dist/contract/task.js";
import { RunConfigSchema } from "../dist/contract/config.js";

/** Convert only Core's explicitly declared HTTP-JSON-domain substitutions.
 * Unsupported future checks fail generation rather than silently exporting `any`.
 */
function jsonWireBoundary(root) {
  const converted = new WeakMap();
  function convert(schema, path) {
    if (converted.has(schema)) return converted.get(schema);
    const def = schema._zod.def;
    if ((def.checks ?? []).some(check => ["custom", "overwrite"].includes(check._zod?.def.check))) {
      throw new Error(`Unrepresented custom refinement at ${path}`);
    }
    const explicit = schema.meta()?.apiccJsonWireSchema;
    if (explicit !== undefined) {
      if (!explicit?._zod) throw new Error(`Invalid JSON wire metadata at ${path}`);
      const result = convert(explicit, `${path}.jsonWire`);
      converted.set(schema, result);
      return result;
    }
    if (["custom", "transform", "pipe", "unknown", "any"].includes(def.type)) {
      throw new Error(`Unrepresented ${def.type}/custom check at ${path}`);
    }
    if (def.type === "lazy") {
      const result = z.lazy(() => convert(def.getter(), `${path}.lazy`));
      converted.set(schema, result);
      return result;
    }
    const mapped = { ...def };
    for (const [key, value] of Object.entries(def)) {
      if (key === "checks") continue;
      if (value?._zod) mapped[key] = convert(value, `${path}.${key}`);
      else if (Array.isArray(value)) mapped[key] = value.map((entry, index) => entry?._zod ? convert(entry, `${path}.${key}[${index}]`) : entry);
      else if (value && typeof value === "object") mapped[key] = Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, entry?._zod ? convert(entry, `${path}.${key}.${name}`) : entry]));
    }
    const result = schema.clone(mapped);
    converted.set(schema, result);
    return result;
  }
  return convert(root, "root");
}

const document = {};
for (const [name, schema] of Object.entries({ target: TaskTargetSchema, runConfig: RunConfigSchema })) {
  document[name] = z.toJSONSchema(jsonWireBoundary(schema), { target: "draft-2020-12", io: "input", reused: "ref" });
}
// This resource can use only local fragments. It cannot instruct Java to retrieve URLs.
function requireLocalRefs(value) {
  if (!value || typeof value !== "object") return;
  if (typeof value.$ref === "string" && !value.$ref.startsWith("#")) throw new Error(`Nonlocal generated reference: ${value.$ref}`);
  for (const child of Object.values(value)) requireLocalRefs(child);
}
requireLocalRefs(document);
const bytes = JSON.stringify(document, null, 2) + "\n";
const output = new URL("../../../server/src/main/resources/execution-input-boundary.json", import.meta.url);
if (process.argv.includes("--check")) {
  if (await readFile(output, "utf8") !== bytes) throw new Error("Java input boundary drift: regenerate from the current Core/execution build");
  console.log("Java input boundary matches current public Core schemas; no unrepresented custom checks.");
} else {
  await writeFile(output, bytes);
  console.log(`Generated Java input boundary (${Buffer.byteLength(bytes)} bytes) from public Core schemas.`);
}

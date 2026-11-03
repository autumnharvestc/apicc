// Explicit fixture maintenance only. Java tests consume the checked-in output without Node.
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";
const root = new URL("../../../../", import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(root + "packages/core/") && specifier.startsWith(".") && specifier.endsWith(".js")) return next(specifier.slice(0, -3) + ".ts", context);
  return next(specifier, context);
} });
const { createContractExecutionProject } = await import(new URL("packages/core/tests/helpers/contractExecutionFixtures.ts", root));
const { encodeContractProjectFiles, decodeContractProjectFiles } = await import(new URL("packages/core/src/storage/contractFiles.ts", root));
const { classifyAssetMutation } = await import(new URL("packages/core/src/collaboration/mutation.ts", root));
const before = createContractExecutionProject("https://synthetic.invalid");
const childId = "child-a\nline\\tail\rend";
before.workflows = [{ id: "root", name: "root", status: "enabled", executionVersion: 2,
  nodes: [{ id: "call", kind: "subflow", workflowId: childId, inputs: {}, outputs: {} }], edges: [], inputs: {}, outputs: {}, limits: { maxConcurrency: 4, timeoutMs: 300000 } },
  ...[childId, "child-b"].map(id => ({ id, name: "child", status: "enabled", nodes: [{ id: "a", kind: "noop" }, { id: "b", kind: "noop" }], edges: [{ id: "condition", from: "a", to: "b", condition: "true" }] }))];
const entries = files => [...files].sort(([a], [b]) => a.localeCompare(b)).map(([path, content]) => ({ path, content }));
const identity = files => createHash("sha256").update(JSON.stringify(entries(files))).digest("hex");
const beforeFiles = encodeContractProjectFiles(before).files;
const manifest = files => createHash("sha256").update([...files].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, content]) => `${path}\0${beforeFiles.has(path) && beforeFiles.get(path) !== content ? 2 : 1}\0${createHash("sha256").update(content).digest("hex")}\0${Buffer.byteLength(content)}\n`).join("")).digest("hex");
const cases = [];
for (const name of ["collection-script", "ancestor-script", "case-script", "child-condition", "delete-ancestor", "delete-collection", "metadata", "subflow-reference"]) {
  const after = structuredClone(before);
  const collection = after.collections[0], folder = collection.folders[0].folders[0];
  if (name === "collection-script") collection.preOperations.push({ id: "new-script", type: "script", content: "pm.test('changed',()=>true)" });
  if (name === "ancestor-script") folder.preOperations[0].content += "\npm.test('changed',()=>true)";
  if (name === "case-script") folder.apis[0].cases[0].postOperations.push({ id: "case-hook", type: "script", content: "pm.test('changed',()=>true)" });
  if (name === "child-condition") after.workflows[1].edges[0].condition = "false";
  if (name === "delete-ancestor") collection.folders = [];
  if (name === "delete-collection") after.collections = [];
  if (name === "metadata") after.name = "script is ordinary metadata";
  if (name === "subflow-reference") after.workflows[0].nodes[0].workflowId = "child-b";
  const afterFiles = encodeContractProjectFiles(after).files;
  for (const files of [beforeFiles, afterFiles]) {
    const decoded = await decodeContractProjectFiles(files);
    if (!decoded.project || decoded.readOnly || decoded.problems.length) throw new Error(`Invalid fixed fixture: ${name}`);
  }
  const result = await classifyAssetMutation(beforeFiles, afterFiles);
  if (result.scriptChanged !== !["metadata", "subflow-reference"].includes(name)) throw new Error(`Wrong Core classification: ${name}`);
  cases.push({ name, afterFiles: entries(afterFiles), afterDigest: identity(afterFiles), afterManifest: manifest(afterFiles), result });
}
const missingProject = new Map(beforeFiles); missingProject.delete("project.yaml");
let invalidFailure;
try { await classifyAssetMutation(beforeFiles, missingProject); throw new Error("Invalid fixture unexpectedly classified"); }
catch (error) { if (error.message !== "PUBLICATION_SOURCE_INVALID") throw error; invalidFailure = error.message; }
process.stdout.write(JSON.stringify({ source: "createContractExecutionProject + real classifyAssetMutation; no execution/target request", beforeFiles: entries(beforeFiles), beforeDigest: identity(beforeFiles), beforeManifest: manifest(beforeFiles), cases, invalidCases: [{ name: "missing-project", afterFiles: entries(missingProject), failure: invalidFailure }] }));

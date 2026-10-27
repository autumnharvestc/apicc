// Test-only real-host probe. Never substitutes a compatibility ID or registers product capabilities.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createProjectSnapshot, workflowToRunResult } from "@apicc/core";
import { prepareExecution, invokeExecution } from "@apicc/execution/host";
import { readBuildIdentity } from "@apicc/execution/buildIdentity";

export const semanticIds = Object.fromEntries(["project", "collection", "api", "suite", "workflow", "dataset", "entry", "environment"].map((name, i) => [name, `10000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`]));
const field = (name, value, i) => ({ kind: "inline", id: `10000000-0000-4000-8000-${String(i + 30).padStart(12, "0")}`, name, schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "synthetic", value });
export function semanticProject(baseUrl, scripts = true, failing = false) {
  const id = semanticIds;
  const pre = "pm.variables.set('path','fresh'); pm.request.headers['X-Direct']='kept'; pm.request.headers['X-Extracted']=pm.variables.get('extracted')??'unset'; pm.request.url+='?direct=yes';";
  const post = "pm.variables.set('extracted',pm.response.json().token); pm.assert(pm.variables.get('extracted')==='fixed-token','post extraction'); pm.assert(pm.response.status===200,'status');" + (failing ? "pm.assert(false,'synthetic failure');" : "");
  return {
    id: id.project, name: "T11 synthetic execution", variables: { path: "plain", value: "row-one" },
    globals: { query: [], headers: [], cookies: [], body: [] },
    environments: [{ id: id.environment, name: "explicit environment", variables: { envValue: "environment-one" }, baseUrls: { [id.collection]: baseUrl } }],
    collections: [{ id: id.collection, name: "synthetic", variables: {}, preOperations: [], postOperations: [], folders: [], apis: [{
      contract: { formatVersion: 1, id: id.api, metadata: { name: "fixed response", description: "", tags: [], version: "1", status: "draft" }, request: { protocol: "http", method: "POST", baseUrl, path: "/{{path}}", pathParams: [], query: [], headers: [field("X-Data", "{{value}}", 0), field("X-Environment", "{{envValue}}", 1)], cookies: [], auth: { kind: "bearer", token: { id: "synthetic-credential", policy: "test-auto" } }, body: { kind: "json", content: '{"value":"{{value}}"}' } }, responses: [] },
      cases: [{ id: "synthetic-case", name: "controlled", scope: "base", parameters: {}, preOperations: scripts ? [{ id: "pre", type: "script", content: pre }] : [], postOperations: scripts ? [{ id: "post", type: "script", content: post }] : [], assertions: [] }], documentation: "",
    }] }],
    workflows: [{ id: id.workflow, name: "sequential extraction", executionVersion: 2, status: "enabled", nodes: [{ id: "first", kind: "request", apiId: id.api, caseId: "synthetic-case" }, { id: "second", kind: "request", apiId: id.api, caseId: "synthetic-case" }], edges: [{ id: "next", from: "first", to: "second" }] }],
    datasets: [{ formatVersion: 1, id: id.dataset, name: "fixed data", columns: ["value"], rows: [{ value: "dataset-one" }] }],
    suites: [{ formatVersion: 1, id: id.suite, name: "fixed suite", tags: [], failFast: false, reporters: ["json"], datasetId: id.dataset, selection: { kind: "explicit", entries: [{ id: id.entry, kind: "case", collectionId: id.collection, folderIds: [], apiId: id.api, caseId: "synthetic-case" }] } }], models: [], components: [],
  };
}
export function semanticTarget(kind) {
  if (kind === "suite") return { kind, suiteId: semanticIds.suite, allowDraft: false };
  if (kind === "workflow") return { kind, workflowId: semanticIds.workflow };
  const locator = { workspaceId: "synthetic-workspace", groupId: "synthetic-group", projectId: semanticIds.project, collectionId: semanticIds.collection, folderIds: [], apiId: semanticIds.api };
  return { kind: "debug", invocation: { mode: "case", locator, case: { ...locator, caseId: "synthetic-case", scope: "base" }, environmentId: semanticIds.environment } };
}
export function semanticSummary(output) {
  const run = output.kind === "debug" ? output.result.run : output.kind === "workflow" ? workflowToRunResult(output.result) : output.result;
  const cases = output.kind === "debug" ? output.result.outcomes : run.cases;
  return { kind: output.kind, passed: run.passed, failed: run.failed, facts: run.requestFacts ?? (output.kind === "debug" ? { httpExchanges: output.result.exchanges.length } : null), failureKind: output.result.failureKind ?? null, cases: cases.map(row => ({ passed: row.passed, failureKind: row.failureKind ?? null, assertions: row.assertions.map(assertion => ({ pass: assertion.pass })) })) };
}
export async function collectRuntimeSemantics() {
  const seen = [];
  const target = createServer((request, response) => {
    let body = ""; request.on("data", chunk => { body += chunk; }); request.on("end", () => {
      assert.equal(request.headers.authorization, "Bearer t11-synthetic-secret");
      seen.push({ path: request.url, data: request.headers["x-data"], environment: request.headers["x-environment"], direct: request.headers["x-direct"] ?? null, extracted: request.headers["x-extracted"] ?? null, body: JSON.parse(body) });
      response.setHeader("content-type", "application/json"); response.end('{"token":"fixed-token"}');
    });
  });
  await new Promise(resolve => target.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${target.address().port}`;
  const summaries = [];
  try {
    for (const [name, kind, scripts, failing] of [["plain", "debug", false, false], ["trusted", "debug", true, false], ["suite", "suite", true, false], ["workflow-v2", "workflow", true, false], ["failure", "debug", true, true]]) {
      const before = seen.length;
      const prepared = prepareExecution({ snapshot: createProjectSnapshot(semanticProject(origin, scripts, failing)), target: semanticTarget(kind), environmentId: semanticIds.environment, profile: scripts ? "trusted-core-script" : "no-script" });
      const output = await invokeExecution(prepared, { credentialBindings: { versions: { "synthetic-credential": "1" }, resolve: () => "t11-synthetic-secret" } });
      const summary = semanticSummary(output);
      assert.equal(summary.passed, failing ? 0 : kind === "workflow" ? 2 : 1);
      assert.equal(summary.failed, failing ? 1 : 0);
      const requests = seen.slice(before);
      for (const request of requests) {
        assert.equal(request.path, scripts ? "/fresh?direct=yes" : "/plain");
        const value = kind === "suite" ? "dataset-one" : "row-one";
        assert.equal(request.environment, "environment-one"); assert.equal(request.data, value); assert.deepEqual(request.body, { value });
        assert.equal(request.direct, scripts ? "kept" : null);
      }
      if (kind === "workflow") assert.deepEqual(requests.map(row => row.extracted), ["unset", "fixed-token"]);
      if (failing) assert.equal(summary.cases[0].failureKind, "assertion");
      summaries.push({ name, summary, requests });
    }
    const identity = await readBuildIdentity();
    return { runtime: { node: process.versions.node, v8: process.versions.v8, electron: process.versions.electron ?? null, platform: process.platform, arch: process.arch }, coreBuildId: identity.coreBuildId, scriptApiId: identity.scriptApiId, summaries };
  } finally { target.closeAllConnections(); await new Promise(resolve => target.close(resolve)); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await collectRuntimeSemantics();
    const output = process.argv[2]; if (output) await writeFile(output, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result));
    if (process.versions.electron) { const { app } = await import("electron"); app.quit(); }
  } catch (error) { console.error(error); process.exitCode = 1; if (process.versions.electron) { const { app } = await import("electron"); app.exit(1); } }
}

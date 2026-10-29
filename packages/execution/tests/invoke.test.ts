import { afterAll, beforeAll, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { createProjectSnapshot, createHttpSession, WorkflowSchema, StressPlanSchema, createBuiltinExecutionRegistry, runDebugExecution, collectionScriptRequirements, type DebugInvocation } from "@apicc/core";
import { createContractExecutionProject, contractExecutionIds as ids } from "../../core/tests/helpers/contractExecutionFixtures.js";
import { prepareExecution, invokeExecution, createExecutionRegistry, type PrepareExecutionInput } from "../src/host/index.js";
import { resolveEffectiveConfig } from "../src/contract/index.js";

let server: Server; let baseUrl = ""; let hits = 0;
const seen: Array<{ url: string; cookie?: string; direct?: string; template?: string }> = [];
beforeAll(async () => {
  server = createServer((request, response) => {
    hits++; seen.push({ url: request.url!, cookie: request.headers.cookie, direct: request.headers["x-direct"] as string, template: request.headers["x-template"] as string });
    response.setHeader("content-type", "text/plain"); response.setHeader("set-cookie", "session=private-cookie; Path=/");
    const send = () => response.end("body-value ".repeat(50));
    if (request.url?.includes("slow")) setTimeout(send, 80); else send();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));
const credentials = { versions: { [ids.credential]: "1" }, resolve: () => "private-token" };
const suiteId = "10000000-0000-4000-8000-000000000091";
const workflowId = "10000000-0000-4000-8000-000000000092";
it("rejects a fabricated stress prepared handle before material access or requests", async () => {
  const { project, collection, asset } = fixture(); const before = hits;
  const prepared = prepareExecution({ snapshot: createProjectSnapshot(project), profile: "no-script", target: { kind: "stress", plan: StressPlanSchema.parse({ formatVersion: 1,
    target: { kind: "case", collectionId: collection.id, apiId: asset.contract.id, caseId: ids.case }, load: { kind: "constant-vus", vus: 1 }, termination: { maxIterations: 1 } }) } });
  await expect(invokeExecution({ ...prepared }, { credentialBindings: { versions: {}, resolve() { throw new Error("Material access must not occur"); } } })).rejects.toThrow(/Unknown prepared/);
  expect(hits).toBe(before);
});
it("independently recompiles fixed limits and rejects a lower submitted binding before any request", () => {
  const { project, collection, asset } = fixture(); const before = hits;
  const plan = StressPlanSchema.parse({ formatVersion: 1, target: { kind: "case", collectionId: collection.id, apiId: asset.contract.id, caseId: ids.case }, load: { kind: "constant-vus", vus: 2 }, maxVus: 2, termination: { maxIterations: 2 } });
  const input = { snapshot: createProjectSnapshot(project), target: { kind: "stress" as const, plan }, profile: "no-script" as const, stressConfig: { configuration: resolveEffectiveConfig() } };
  const fixed = prepareExecution(input).stressBinding!;
  expect(() => prepareExecution({ ...input, expectedStressBinding: fixed })).not.toThrow();
  const lower = { ...fixed, admissionLimits: { ...fixed.admissionLimits, maxRequestConcurrency: 1 }, reservation: { ...fixed.reservation, requestConcurrency: 1 } };
  expect(() => prepareExecution({ ...input, expectedStressBinding: lower })).toThrow(/binding|reservation/i);
  expect(hits).toBe(before);
});
it("invokes real stress requests and retains the v2 report and private evidence", async () => {
  const { project, collection, asset } = fixture(); const before = hits;
  const plan = StressPlanSchema.parse({ formatVersion: 1, target: { kind: "case", collectionId: collection.id, apiId: asset.contract.id, caseId: ids.case }, load: { kind: "constant-vus", vus: 1 }, termination: { maxIterations: 2 } });
  const prepared = prepareExecution({ snapshot: createProjectSnapshot(project), target: { kind: "stress", plan }, profile: "no-script" });
  expect(prepared.requiredCapabilities).toEqual(["protocol:http", "stress:local-workers-v1", "task:stress"]);
  const value = await invokeExecution(prepared, { credentialBindings: credentials });
  expect(value).toMatchObject({ kind: "stress", result: { formatVersion: 2, requests: { started: 2, completed: 2, eligibleCompleted: 2 }, iterations: { completed: 2 }, verdict: { passed: true } } });
  expect(hits - before).toBe(2);
  expect(JSON.stringify(value)).not.toContain("private-token"); expect(JSON.stringify(value)).not.toContain("private-cookie");
});
function fixture() {
  const project = createContractExecutionProject(baseUrl); const collection = project.collections[0]!; const folder = collection.folders[0]!.folders[0]!; const asset = folder.apis[0]!;
  folder.preOperations = []; folder.postOperations = []; asset.cases[0]!.preOperations = [];
  asset.contract.request.baseUrl = baseUrl; asset.contract.request.path = "/plain";
  project.workflows[0]!.id = workflowId;
  project.suites = [{ formatVersion: 1, id: suiteId, name: "suite", tags: [], failFast: false, reporters: ["json"], selection: { kind: "explicit", entries: [{ id: "10000000-0000-4000-8000-000000000093", kind: "workflow", workflowId }] } }];
  const locator = { workspaceId: "workspace", groupId: "group", projectId: project.id, collectionId: collection.id, folderIds: [ids.outerFolder, ids.innerFolder], apiId: asset.contract.id };
  const invocation: DebugInvocation = { mode: "case", locator, case: { ...locator, caseId: ids.case, scope: "base" } };
  return { project, collection, folder, asset, invocation };
}

it("runs the three existing Core entries with a genuinely engine-free registry", async () => {
  const registry = createExecutionRegistry({ profile: "no-script" }); expect(registry.getScriptEngine("javascript")).toBeUndefined(); await registry.close();
  const { project, invocation, asset } = fixture();
  asset.cases.push({ ...asset.cases[0]!, id: "unselected", preOperations: [{ id: "unused", type: "script", content: "throw new Error('must not execute')" }] });
  const snapshot = createProjectSnapshot(project);
  for (const target of [{ kind: "debug" as const, invocation }, { kind: "suite" as const, suiteId, allowDraft: false }, { kind: "workflow" as const, workflowId }]) {
    const prepared = prepareExecution({ snapshot, target, profile: "no-script" });
    expect(prepared.requiredCapabilities).toEqual(["protocol:http", `task:${target.kind}`]);
    const result = await invokeExecution(prepared, { credentialBindings: credentials });
    expect(result.result).toMatchObject(result.kind === "debug" ? { run: { passed: 1 } } : result.kind === "suite" ? { passed: 1 } : { verdict: "passed" });
    expect(JSON.stringify(result)).not.toContain("private-token"); expect(JSON.stringify(result)).not.toContain("private-cookie");
  }
});

it("rejects actual ancestor, selected case, handler and v1-condition scripts in preparation before target requests", () => {
  const start = hits;
  for (const kind of ["ancestor", "case", "onError", "finally", "condition"] as const) {
    const { project, collection, asset, invocation } = fixture(); let target: PrepareExecutionInput["target"] = { kind: "debug", invocation };
    if (kind === "ancestor") collection.postOperations = [{ id: "post", type: "script", content: "pm.assert(true, 'ok')" }];
    if (kind === "case") asset.cases[0]!.postOperations = [{ id: "post", type: "script", content: "pm.assert(true, 'ok')" }];
    if (kind === "onError" || kind === "finally") {
      project.workflows.push(WorkflowSchema.parse({ id: "handler", name: "handler", status: "enabled", nodes: [{ id: "a", kind: "noop" }, { id: "b", kind: "noop" }], edges: [{ id: "cond", from: "a", to: "b", condition: "true" }] }));
      project.workflows[0] = WorkflowSchema.parse({ id: workflowId, name: "root", status: "enabled", executionVersion: 2, nodes: [{ id: "request", kind: "request", apiId: asset.contract.id, caseId: ids.case, policy: { [kind]: { workflowId: "handler", ...(kind === "onError" ? { mode: "recover" } : {}) } } }], edges: [] });
      target = { kind: "workflow", workflowId };
    }
    if (kind === "condition") { project.workflows[0]!.nodes.push({ id: "end", kind: "noop" }); project.workflows[0]!.edges.push({ id: "cond", from: ids.requestNode, to: "end", condition: "true" }); target = { kind: "workflow", workflowId }; }
    expect(() => prepareExecution({ snapshot: createProjectSnapshot(project), target, profile: "no-script" })).toThrow(/script|javascript/);
  }
  expect(hits).toBe(start);
});

it("applies invocation settings to real suite leaves and configured evidence body previews", async () => {
  const { project, asset } = fixture(); asset.contract.request.path = "/slow";
  project.workflows[0] = WorkflowSchema.parse({ ...project.workflows[0], executionVersion: 2 });
  const prepared = prepareExecution({ snapshot: createProjectSnapshot(project), target: { kind: "suite", suiteId, allowDraft: false }, profile: "no-script", requestSettings: { totalTimeoutMs: 10 } });
  const result = await invokeExecution(prepared, { credentialBindings: credentials });
  expect(result.result).toMatchObject({ failed: 1, cases: [{ passed: false }] });
  asset.contract.request.path = "/plain";
  const limited = prepareExecution({ snapshot: createProjectSnapshot(project), target: { kind: "suite", suiteId, allowDraft: false }, profile: "no-script", evidenceLimits: { bodyBytes: 8, valueBytes: 32, caseBytes: 3000, reportBytes: 16000 } });
  const limitedResult = await invokeExecution(limited, { credentialBindings: credentials });
  if (limitedResult.kind !== "suite") throw new Error("Expected suite");
  expect(limitedResult.result.cases[0]!.evidence!.response!.body.text).toBe("body-val");
  expect(limitedResult.result.cases[0]!.evidence!.response!.body.truncated).toBe(true);
});

it("uses the same trusted Core pm semantics in direct and hosted debug calls", async () => {
  const { project, asset, invocation } = fixture();
  asset.contract.request.path = "/{{path}}"; project.variables.path = "old"; project.globals.headers.push({ key: "X-Template", value: "{{path}}", enabled: true });
  asset.cases[0]!.preOperations = [{ id: "pre", type: "script", content: "pm.request.headers['X-Direct']='kept'; pm.variables.set('path','fresh'); pm.request.url += '?direct=yes';" }];
  const prepared = prepareExecution({ snapshot: createProjectSnapshot(project), target: { kind: "debug", invocation }, profile: "trusted-core-script", scriptTimeoutMs: 100 });
  const directRegistry = createBuiltinExecutionRegistry({ profile: "trusted-core-script", scriptTimeoutMs: 100 });
  try {
    const direct = await runDebugExecution(prepared.debugPlan!, { snapshot: prepared.snapshot, credentialBindings: credentials }, { registry: directRegistry, credentialMarkers: ["private-token"] });
    const hosted = await invokeExecution(prepared, { credentialBindings: credentials });
    expect(hosted.result).toMatchObject({ run: { passed: direct.run.passed } });
    expect(seen.slice(-2).map(value => [new URL(value.url, baseUrl).pathname, new URL(value.url, baseUrl).searchParams.get("direct"), value.direct, value.template])).toEqual([["/fresh", "yes", "kept", "fresh"], ["/fresh", "yes", "kept", "fresh"]]);
  } finally { await directRegistry.close(); }
});

it("rejects administrator request ceilings after final case/run selection", () => {
  const { project, asset, invocation } = fixture(); asset.cases[0]!.requestSettingsOverride = { totalTimeoutMs: 700 };
  expect(() => prepareExecution({ snapshot: createProjectSnapshot(project), target: { kind: "debug", invocation }, profile: "no-script", requestSettingsLimits: { totalTimeoutMs: 500 } })).toThrow(/totalTimeoutMs/);
});

it("R1 I-1 rejects conflicting declarations with the same stable script identity before requests", () => {
  const { project, collection, invocation } = fixture(); const before = hits;
  collection.preOperations = [{ id: "shared", type: "script", content: "pm.variables.set('shared','runs')" }];
  project.workflows[0]!.nodes.push({ id: "end", kind: "noop" });
  project.workflows[0]!.edges.push({ id: "shared-condition", from: ids.requestNode, to: "end", condition: "true" });
  const callers = ["10000000-0000-4000-8000-000000000094", "10000000-0000-4000-8000-000000000095"];
  for (const id of callers) project.workflows.push(WorkflowSchema.parse({ id, name: "caller", executionVersion: 2, status: "enabled", nodes: [{ id: "child", kind: "subflow", workflowId }], edges: [] }));
  project.suites![0]!.selection = { kind: "explicit", entries: callers.map((id, index) => ({ id: `10000000-0000-4000-8000-00000000009${index + 6}`, kind: "workflow", workflowId: id })) };
  const shared = prepareExecution({ snapshot: createProjectSnapshot(project), target: { kind: "suite", suiteId, allowDraft: false }, profile: "trusted-core-script" });
  expect(shared.scriptRequirements).toHaveLength(2);
  collection.preOperations = [
    { id: "duplicate", type: "script", content: "pm.variables.set('first','runs')" },
    { id: "duplicate", type: "script", content: "pm.variables.set('second','runs')" },
  ];
  const snapshot = createProjectSnapshot(project);
  expect.soft(() => collectionScriptRequirements(snapshot, collection.id)).toThrow(/duplicate|conflict|冲突/);
  expect.soft(() => prepareExecution({ snapshot, target: { kind: "debug", invocation }, profile: "trusted-core-script" })).toThrow(/duplicate|conflict|冲突/);
  expect(hits).toBe(before);
});

it("R1 I-3 preserves logical workflow failure and zero request facts after terminal projection failure", async () => {
  const { project } = fixture(); const before = hits;
  project.workflows = [WorkflowSchema.parse({ id: workflowId, name: "failed assertion", status: "enabled", executionVersion: 2, nodes: [{ id: "assert", kind: "assert", predicate: { op: "eq", left: { kind: "literal", value: 1 }, right: { kind: "literal", value: 2 } } }], edges: [] })];
  const prepared = prepareExecution({ snapshot: createProjectSnapshot(project), target: { kind: "workflow", workflowId }, profile: "no-script", evidenceLimits: { bodyBytes: 8, valueBytes: 128, caseBytes: 3000, reportBytes: 16000, workflowMetadataBytes: 500 } });
  const value = await invokeExecution(prepared, { credentialBindings: credentials });
  expect(value).toMatchObject({ kind: "failure", result: { workflowId, reportFailure: true, cases: [], requestFacts: { requestStarted: 0, requestCompleted: 0, httpExchanges: 0 }, workflow: { verdict: "failed", total: 1, failed: 1, entries: [{ nodeKind: "assert", state: "failed", failureKind: "assertion", error: expect.stringContaining("Workflow assertion failed") }] } } });
  expect(hits).toBe(before);
});

it("applies configured body budgets to debug exchanges as well as evidence", async () => {
  const { project, invocation } = fixture();
  const prepared = prepareExecution({ snapshot: createProjectSnapshot(project), target: { kind: "debug", invocation }, profile: "no-script", evidenceLimits: { bodyBytes: 8, valueBytes: 128, caseBytes: 5000, reportBytes: 18000 } });
  const result = await invokeExecution(prepared, { credentialBindings: credentials });
  if (result.kind !== "debug") throw new Error("Expected debug");
  expect(result.result.exchanges[0]!.response!.body).toMatchObject({ kind: "text", text: "body-val", truncated: true });
  expect(Buffer.byteLength(JSON.stringify(result.result))).toBeLessThanOrEqual(18000);
});

it("keeps explicit debug sessions scoped and projects partial results after container script failure", async () => {
  const { project, invocation, collection } = fixture();
  const scope = { serverId: "server", scope: { workspaceId: "1", groupId: "2", projectId: "3" }, submittedByUserId: "4", debugSessionId: "session" };
  const session = createHttpSession();
  const prepared = prepareExecution({ snapshot: createProjectSnapshot(project), target: { kind: "debug", invocation }, profile: "no-script", debugSessionScope: scope });
  try {
    await invokeExecution(prepared, { credentialBindings: credentials, debugSession: { scope, session } });
    const result = await invokeExecution(prepared, { credentialBindings: credentials, debugSession: { scope, session } });
    expect(seen.at(-1)!.cookie).toBe("session=private-cookie"); expect(JSON.stringify(result)).not.toContain("private-cookie");
    const before = hits;
    await expect(invokeExecution(prepared, { credentialBindings: credentials, debugSession: { scope: { ...scope, submittedByUserId: "5" }, session } })).rejects.toThrow(/scope/);
    expect(hits).toBe(before);
  } finally { await session.close(); }
  collection.postOperations = [{ id: "post", type: "script", content: "throw new Error('actual failure private-token')" }];
  const failed = prepareExecution({ snapshot: createProjectSnapshot(project), target: { kind: "debug", invocation }, profile: "trusted-core-script" });
  const value = await invokeExecution(failed, { credentialBindings: credentials });
  expect(value).toMatchObject({ kind: "debug", result: { run: { total: 1, passed: 1 }, failureKind: "script", error: expect.stringContaining("actual failure [REDACTED]") } });
  expect(JSON.stringify(value)).not.toContain("private-token");
});

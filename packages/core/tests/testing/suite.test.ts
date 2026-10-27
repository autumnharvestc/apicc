import { describe, expect, it } from "vitest";
import * as core from "../../src/index.js";
import { createContractExecutionProject, contractExecutionIds as ids, workflowReportScenarios } from "../helpers/contractExecutionFixtures.js";
import { jsScriptEngine } from "../../src/sandbox/jsEngine.js";

const suiteId = "10000000-0000-4000-8000-000000000091";
const datasetId = "10000000-0000-4000-8000-000000000090";
const entryId = "10000000-0000-4000-8000-000000000092";
const workflowEntryId = "10000000-0000-4000-8000-000000000093";
function fixture() {
  const project = createContractExecutionProject("http://suite.test");
  const folder = project.collections[0]!.folders[0]!.folders[0]!;
  folder.preOperations = []; folder.postOperations = [];
  const asset = folder.apis[0]!;
  asset.contract.request = { protocol: "http", method: "GET", baseUrl: "http://suite.test", path: "/{{value}}", pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, body: { kind: "none" } };
  asset.cases[0]!.preOperations = [];
  asset.cases[0]!.tags = ["smoke"];
  project.datasets = [{ formatVersion: 1, id: datasetId, name: "rows", columns: ["value"], rows: [{ value: "one" }, { value: "two" }] }];
  project.suites = [{ formatVersion: 1, id: suiteId, name: "suite", tags: [], failFast: false, reporters: ["json"], datasetId,
    selection: { kind: "explicit", entries: [
      { id: entryId, kind: "case", collectionId: ids.collection, folderIds: [ids.outerFolder, ids.innerFolder], apiId: ids.contract, caseId: ids.case },
      { id: workflowEntryId, kind: "workflow", workflowId: ids.workflow },
    ] } }];
  return { project, asset, testCase: asset.cases[0]! };
}
const credentials = { versions: {}, resolve: () => { throw new Error("No credentials"); } };
function registry(seen: string[], callback?: (index: number) => void) {
  const registry = core.createPluginRegistry(); registry.registerScriptEngine(jsScriptEngine);
  registry.registerProtocol({ name: "suite-observer", canHandle: () => true, async execute(request, options) {
    const previous = await options.runtime?.session?.getCookieHeader(request.url);
    seen.push(`${request.url}|${previous ?? "empty"}|${request.headers["X-Carried"] ?? "none"}`);
    await options.runtime?.session?.storeResponseCookies(request.url, [["set-cookie", "session=seen; Path=/"]]);
    callback?.(seen.length);
    return { status: 200, headers: {}, bodyText: "", timeMs: 0 };
  } }); return registry;
}

describe("B2 suite selection and orchestration", () => {
  it("F7b runs no-script suite selection without requiring an engine", async () => {
    const { project } = fixture();
    const snapshot = core.createProjectSnapshot(project); const plan = core.resolveSuitePlan(snapshot, suiteId);
    const data = await core.prepareTestData(snapshot, plan.selections, { workspaceRoot: process.cwd() });
    const selected = core.createPluginRegistry();
    selected.registerProtocol({ name: "plain", canHandle: () => true, execute: async () => ({ status: 200, headers: {}, bodyText: "", timeMs: 1 }) });
    expect((await new core.SuiteRunner({ registry: selected }).run({ snapshot, credentialBindings: credentials, preparedTestData: data }, plan)).verdict).toBe("passed");
  });
  it("F7b propagates run request settings to suite and workflow leaves", async () => {
    const { project } = fixture();
    const snapshot = core.createProjectSnapshot(project); const plan = core.resolveSuitePlan(snapshot, suiteId);
    const data = await core.prepareTestData(snapshot, plan.selections, { workspaceRoot: process.cwd() });
    const timeouts: number[] = []; const selected = registry([]);
    selected.registerProtocol({ name: "suite-observer", canHandle: () => true, execute: async (_request, options) => { timeouts.push(options.totalTimeoutMs); return { status: 200, headers: {}, bodyText: "", timeMs: 1 }; } });
    await new core.SuiteRunner({ registry: selected }).run({ snapshot, credentialBindings: credentials, preparedTestData: data }, plan, { requestSettings: { totalTimeoutMs: 1234 } } as core.SuiteRunnerOptions);
    expect(timeouts).toEqual([1234, 1234, 1234, 1234]);
  });
  it("keeps retry OR and recover success as logical suite units with original failed rows", async () => {
    const { project, asset } = fixture(); delete project.suites![0]!.datasetId;
    project.workflows = workflowReportScenarios(asset.contract.id, asset.cases[0]!.id);
    project.suites![0]!.selection = { kind: "explicit", entries: project.workflows.slice(0, 3).map((flow, index) => ({ id: `10000000-0000-4000-8000-00000000010${index}`, kind: "workflow" as const, workflowId: flow.id })) };
    project.workflows.push(core.WorkflowSchema.parse({ id: "legacy", name: "legacy", status: "enabled", nodes: [{ id: "legacy-request", kind: "request", apiId: asset.contract.id, caseId: asset.cases[0]!.id }], edges: [] }));
    project.suites![0]!.selection.entries.push({ id: entryId, kind: "case", collectionId: ids.collection, folderIds: [ids.outerFolder, ids.innerFolder], apiId: asset.contract.id, caseId: asset.cases[0]!.id }, { id: workflowEntryId, kind: "workflow", workflowId: "legacy" });
    const snapshot = core.createProjectSnapshot(project); const plan = core.resolveSuitePlan(snapshot, suiteId);
    const data = await core.prepareTestData(snapshot, plan.selections, { workspaceRoot: process.cwd() });
    const selected = registry([]); let calls = 0;
    selected.registerProtocol({ name: "suite-observer", canHandle: () => true, execute: async () => { if ([1, 3].includes(++calls)) throw new Error("transport failure"); return { status: 200, headers: {}, bodyText: "", timeMs: 0 }; } });
    const result = await new core.SuiteRunner({ registry: selected }).run({ snapshot, credentialBindings: credentials, preparedTestData: data }, plan);
    expect(result.verdict).toBe("passed"); expect(result.entries.map((entry) => entry.status)).toEqual(["passed", "passed", "passed", "passed", "passed"]);
    expect(result.cases.filter((row) => !row.passed)).toHaveLength(2);
    const report = core.suiteToRunResult(result); expect(report.reportingMode).toBe("mixed-suite-v2");
    expect(core.reportingUnits(report).summary).toMatchObject({ total: 5, passed: 5, failed: 0 });
    expect(report.workflowUnits).toHaveLength(3); expect(report.failed).toBe(2);
    expect(report.requestFacts).toEqual({ requestStarted: 5, requestCompleted: 5, httpExchanges: 0 });
    expect(report.trace?.events.filter((event) => event.type === "branch-winner").map((event) => event.branchId)).toEqual(["good"]);
    expect(report.trace?.events.filter((event) => event.type === "branch-end")).toHaveLength(2);
    const handler = report.trace!.events.find((event) => event.type === "handler-start")!;
    expect(handler.childInvocation!.invocationId).not.toBe(handler.invocationId);
    expect(handler.childInvocation!.parentInvocationId).toBe(handler.invocationId);
    expect(handler.childInvocation!.invocationPath.at(-1)?.handler).toBe("onError");
    const abort = new AbortController(); abort.abort();
    const stopped = await new core.SuiteRunner({ registry: selected }).run({ snapshot, credentialBindings: credentials, preparedTestData: data }, plan, { signal: abort.signal });
    expect(core.reportingUnits(core.suiteToRunResult(stopped)).summary).toMatchObject({ total: 3, failed: 0, skipped: 3 });
  });
  it("does not treat an internally cancelled OR loser as a user-aborted suite", async () => {
    const { project, asset } = fixture(); delete project.suites![0]!.datasetId;
    project.workflows = [core.WorkflowSchema.parse({ id: "root", name: "root", status: "enabled", executionVersion: 2, nodes: [{ id: "or", kind: "parallel", join: "any-success", branches: ["fast", "slow"].map((who) => ({ id: who, workflowId: "leaf", inputs: { who: { kind: "literal", value: who } }, outputs: {} })) }], edges: [] }),
      core.WorkflowSchema.parse({ id: "leaf", name: "leaf", status: "enabled", executionVersion: 2, inputs: { who: { required: true } }, nodes: [{ id: "copy", kind: "assign", assignments: { value: { kind: "ref", source: "inputs", path: ["who"] } } }, { id: "request", kind: "request", apiId: asset.contract.id, caseId: asset.cases[0]!.id }], edges: [{ id: "e", from: "copy", to: "request" }] })];
    project.suites![0]!.selection = { kind: "explicit", entries: [{ id: workflowEntryId, kind: "workflow", workflowId: "root" }] };
    const snapshot = core.createProjectSnapshot(project); const plan = core.resolveSuitePlan(snapshot, suiteId);
    const data = await core.prepareTestData(snapshot, plan.selections, { workspaceRoot: process.cwd() });
    const selected = registry([]); let entered!: () => void; const barrier = new Promise<void>((resolve) => { entered = resolve; }); let active = 0;
    selected.registerProtocol({ name: "suite-observer", canHandle: () => true, execute: async (request, options) => { if (++active === 2) entered(); await barrier; if (new URL(request.url).pathname === "/slow") await new Promise<void>((_resolve, reject) => options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true })); return { status: 200, headers: {}, bodyText: "", timeMs: 0 }; } });
    const result = await new core.SuiteRunner({ registry: selected }).run({ snapshot, credentialBindings: credentials, preparedTestData: data }, plan);
    expect(result.cases.some((row) => row.failureKind === "aborted")).toBe(true);
    expect(result.verdict).toBe("passed"); expect(result.entries[0]!.status).toBe("passed");
  });
  it("prepares a child closure once, preserves suite row selection through loops, and bounds logical executions", async () => {
    const { project } = fixture();
    const child = project.workflows[0]!;
    project.workflows = [child, core.WorkflowSchema.parse({ id: "parent", name: "parent", status: "enabled", executionVersion: 2, nodes: [{ id: "loop", kind: "loop", workflowId: ids.workflow, count: 2, inputs: {}, outputs: {} }], edges: [] })];
    project.suites![0]!.selection = { kind: "explicit", entries: [{ id: workflowEntryId, kind: "workflow", workflowId: "parent" }] };
    const snapshot = core.createProjectSnapshot(project);
    const plan = core.resolveSuitePlan(snapshot, suiteId);
    expect(core.suiteCaseRequests(snapshot, plan)).toHaveLength(1);
    const data = await core.prepareTestData(snapshot, plan.selections, { workspaceRoot: process.cwd() });
    expect(core.validateSuiteData(plan, data).plannedExecutions).toBe(4);
    const seen: string[] = [];
    const result = await new core.SuiteRunner({ registry: registry(seen) }).run({ snapshot, credentialBindings: credentials, preparedTestData: data }, plan);
    expect(result.verdict).toBe("passed");
    expect(result.cases.map((row) => [row.suiteRow, row.row])).toEqual([[0, 0], [0, 0], [1, 1], [1, 1]]);
    expect(seen.map((url) => url.split("|")[0])).toEqual(["http://suite.test/one", "http://suite.test/one", "http://suite.test/two", "http://suite.test/two"]);
    const loop = project.workflows[1]!.nodes[0]!;
    if (loop.kind !== "loop") throw new Error("Expected loop");
    loop.count = 10000; loop.maxIterations = 10000;
    child.nodes.push({ id: "repeat", kind: "request", apiId: ids.contract, caseId: ids.case }); child.edges.push({ id: "repeat", from: ids.requestNode, to: "repeat" });
    project.datasets![0]!.rows.push({ value: "three" });
    const large = core.createProjectSnapshot(project);
    const largePlan = core.resolveSuitePlan(large, suiteId);
    expect(largePlan.selections).toHaveLength(1);
    const largeData = await core.prepareTestData(large, largePlan.selections, { workspaceRoot: process.cwd() });
    expect(() => core.validateSuiteData(largePlan, largeData)).toThrow(/50000/);
  });
  it("resolves ordered physical locators and runs each outer row exactly once with isolated entry sessions", async () => {
    const { project, testCase } = fixture();
    testCase.preOperations = [{ id: "carry", type: "script", content: 'pm.request.headers["X-Carried"] = pm.variables.get("carried") ?? "none"; pm.variables.set("carried", "set");' }];
    project.workflows[0]!.nodes.push({ id: "second", kind: "request", apiId: ids.contract, caseId: ids.case });
    project.workflows[0]!.edges.push({ id: "edge", from: ids.requestNode, to: "second" });
    const snapshot = core.createProjectSnapshot(project);
    expect(typeof core.resolveSuitePlan).toBe("function");
    const plan = core.resolveSuitePlan(snapshot, suiteId);
    expect(plan.entries.map((e) => e.id)).toEqual([entryId, workflowEntryId]);
    const data = await core.prepareTestData(snapshot, plan.selections, { workspaceRoot: process.cwd() });
    const preview = core.validateSuiteData(plan, data);
    expect([preview.outerRows, preview.plannedExecutions]).toEqual([2, 6]);
    expect(JSON.stringify(preview)).not.toContain('"values"');
    const seen: string[] = [];
    const observedNodes: Array<string | undefined> = [];
    const result = await new core.SuiteRunner({ registry: registry(seen) }).run({ snapshot, credentialBindings: credentials, preparedTestData: data }, plan, { observeCaseExecution: (_, identity) => { observedNodes.push(identity.nodeId); } });
    expect(seen).toEqual([
      "http://suite.test/one|empty|none", "http://suite.test/one|empty|none", "http://suite.test/one|session=seen|set",
      "http://suite.test/two|empty|none", "http://suite.test/two|empty|none", "http://suite.test/two|session=seen|set",
    ]);
    expect([result.total, result.passed, result.failed, result.skipped, result.cases.length]).toEqual([4, 4, 0, 0, 6]);
    expect(result.cases.map((c) => [c.entryId, c.suiteRow, c.row, c.scope])).toEqual([
      [entryId, 0, 0, "base"], [workflowEntryId, 0, 0, "base"], [workflowEntryId, 0, 0, "base"],
      [entryId, 1, 1, "base"], [workflowEntryId, 1, 1, "base"], [workflowEntryId, 1, 1, "base"],
    ]);
    expect(core.suiteToRunResult(result).total).toBe(6);
    expect(observedNodes).toEqual([undefined, ids.requestNode, "second", undefined, ids.requestNode, "second"]);
  });

  it("resolves inherited scope before AND module/tag query and preserves hierarchy order", () => {
    const { project, asset } = fixture();
    project.environments.push({ id: "env-child", name: "child", extends: "local", variables: {}, baseUrls: {} });
    asset.cases.push({ ...asset.cases[0]!, scope: "local", tags: ["inherited"] }, { ...asset.cases[0]!, id: "second", tags: ["smoke"] });
    project.suites![0]!.selection = { kind: "query", collectionIds: [ids.collection], caseTags: ["smoke", "other"] };
    const plan = core.resolveSuitePlan(core.createProjectSnapshot(project), suiteId, { environmentId: "env-child" });
    expect(plan.entries.flatMap((entry) => entry.cases.map((c) => [c.locator.caseId, c.locator.scope]))).toEqual([["second", "base"]]);
    project.suites![0]!.selection = { kind: "query", collectionIds: [ids.collection], caseTags: [] };
    expect(core.resolveSuitePlan(core.createProjectSnapshot(project), suiteId).entries).toHaveLength(2);
    project.suites![0]!.selection = { kind: "query", collectionIds: [], caseTags: ["smoke"] };
    expect(core.resolveSuitePlan(core.createProjectSnapshot(project), suiteId).entries).toHaveLength(2);
  });

  it.each(["empty", "dangling", "conflict", "draft", "duplicate"])("rejects %s before protocols", async (kind) => {
    const { project, testCase } = fixture();
    if (kind === "empty") project.suites![0]!.selection = { kind: "query", caseTags: ["absent"] };
    if (kind === "dangling") {
      const node = project.workflows[0]!.nodes[0]!;
      if (node.kind !== "request") throw new Error("Expected request fixture");
      node.apiId = "another-project";
    }
    if (kind === "conflict") testCase.dataDriver = { kind: "dataset", datasetId };
    if (kind === "draft") project.workflows[0]!.status = "draft";
    // Snapshot schema rejects duplicates too; the resolver must reject handoff objects independently.
    const snapshot = core.createProjectSnapshot(project);
    const changed = kind === "duplicate" ? { ...snapshot, project: { ...snapshot.project, suites: [{ ...snapshot.project.suites![0]!, selection: { kind: "explicit", entries: [snapshot.project.suites![0]!.selection.kind === "explicit" ? snapshot.project.suites![0]!.selection.entries[0]! : undefined, snapshot.project.suites![0]!.selection.kind === "explicit" ? snapshot.project.suites![0]!.selection.entries[0]! : undefined] } }] } } : snapshot;
    const seen: string[] = [];
    await expect(async () => {
      const plan = core.resolveSuitePlan(changed as core.ProjectSnapshot, suiteId);
      const data = await core.prepareTestData(snapshot, plan.selections, { workspaceRoot: process.cwd() });
      await new core.SuiteRunner({ registry: registry(seen) }).run({ snapshot, credentialBindings: credentials, preparedTestData: data }, plan);
    }).rejects.toThrow(kind === "duplicate" ? /Duplicate suite entry/ : /套件配置错误/);
    expect(seen).toEqual([]);
  });

  it.each(["fail-fast", "cancel"])("keeps actual partial rows and skips remaining entries on %s", async (kind) => {
    const { project, testCase } = fixture();
    if (kind === "fail-fast") testCase.postOperations = [{ id: "fail", type: "script", content: 'pm.assert(false, "failed");' }];
    const snapshot = core.createProjectSnapshot(project);
    const plan = core.resolveSuitePlan(snapshot, suiteId, { failFast: true });
    const data = await core.prepareTestData(snapshot, plan.selections, { workspaceRoot: process.cwd() });
    const controller = new AbortController(); const seen: string[] = [];
    const result = await new core.SuiteRunner({ registry: registry(seen, () => { if (kind === "cancel") controller.abort(); }) }).run({ snapshot, credentialBindings: credentials, preparedTestData: data }, plan, { signal: controller.signal });
    expect(seen).toHaveLength(1);
    expect(result.cases).toHaveLength(1);
    expect(result.entries.filter((e) => e.status === "skipped")).toHaveLength(3);
    expect(result.verdict).toBe(kind === "cancel" ? "aborted" : "failed");
  });

  it("preflights later assertions before any request", async () => {
    const { project, asset, testCase } = fixture();
    delete project.suites![0]!.datasetId;
    asset.cases.push({ ...testCase, id: "bad", assertions: [{ id: "bad", target: "status", op: "unregistered" }] });
    const node = project.workflows[0]!.nodes[0]!;
    if (node.kind !== "request") throw new Error("Expected request fixture");
    node.caseId = "bad";
    const snapshot = core.createProjectSnapshot(project); const plan = core.resolveSuitePlan(snapshot, suiteId);
    const data = await core.prepareTestData(snapshot, plan.selections, { workspaceRoot: process.cwd() });
    const seen: string[] = [];
    await expect(new core.SuiteRunner({ registry: registry(seen) }).run({ snapshot, credentialBindings: credentials, preparedTestData: data }, plan)).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  it("preserves a workflow container failure and actual rows when session cleanup also fails", async () => {
    const { project } = fixture();
    project.suites![0]!.selection = { kind: "explicit", entries: [{ id: workflowEntryId, kind: "workflow", workflowId: ids.workflow }] };
    project.collections[0]!.postOperations = [{ id: "container-failure", type: "script", content: 'throw new Error("primary container failure");' }];
    const snapshot = core.createProjectSnapshot(project); const plan = core.resolveSuitePlan(snapshot, suiteId, { failFast: true });
    const data = await core.prepareTestData(snapshot, plan.selections, { workspaceRoot: process.cwd() });
    const result = await new core.SuiteRunner({ registry: registry([]), createSession: () => {
      const session = core.createHttpSession(); return { ...session, async close() { await session.close(); throw new Error("secondary cleanup failure"); } };
    } }).run({ snapshot, credentialBindings: credentials, preparedTestData: data }, plan);
    expect(result.entries[0]!.error).toContain("primary container failure");
    expect(core.suiteToRunResult(result).suite?.entries?.[0]!.error).toContain("primary container failure");
    expect(result.cases).toHaveLength(1); expect(result.cases[0]!.passed).toBe(true);
    expect([result.verdict, result.failed, result.skipped]).toEqual(["failed", 1, 1]);
    expect(result.warnings).toContain("套件条目会话关闭失败");
  });

  it("rejects actual prepared row counts over 50000 and binds source integrity before protocols", async () => {
    const { project } = fixture();
    project.suites![0]!.selection = { kind: "explicit", entries: [{ id: workflowEntryId, kind: "workflow", workflowId: ids.workflow }] };
    project.workflows[0]!.nodes = Array.from({ length: 6 }, (_, index) => ({ id: `node-${index}`, kind: "request", apiId: ids.contract, caseId: ids.case }));
    project.datasets![0]!.rows = Array.from({ length: 10000 }, () => ({ value: "one" }));
    const snapshot = core.createProjectSnapshot(project); const plan = core.resolveSuitePlan(snapshot, suiteId);
    const data = await core.prepareTestData(snapshot, plan.selections, { workspaceRoot: process.cwd() });
    expect(() => core.validateSuiteData(plan, data)).toThrow(/50000/);
    const seen: string[] = [];
    await expect(new core.SuiteRunner({ registry: registry(seen) }).run({ snapshot, credentialBindings: credentials, preparedTestData: data }, plan)).rejects.toThrow(/50000/);
    const changed = JSON.parse(JSON.stringify(data)); changed.sources[0].rows[0].values.value = "modified";
    await expect(new core.SuiteRunner({ registry: registry(seen) }).run({ snapshot, credentialBindings: credentials, preparedTestData: changed }, plan)).rejects.toThrow();
    expect(seen).toEqual([]);
  });
});

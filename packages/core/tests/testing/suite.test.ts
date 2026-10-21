import { describe, expect, it } from "vitest";
import * as core from "../../src/index.js";
import { createContractExecutionProject, contractExecutionIds as ids } from "../helpers/contractExecutionFixtures.js";
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
    if (kind === "dangling") project.workflows[0]!.nodes[0]!.apiId = "another-project";
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
    project.workflows[0]!.nodes[0]!.caseId = "bad";
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

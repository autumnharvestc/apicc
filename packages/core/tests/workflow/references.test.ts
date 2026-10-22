import { describe, expect, it } from "vitest";
import type { ApiAsset } from "../../src/contract/model.js";
import type { ContractCollection, ContractProject } from "../../src/contract/workspace.js";
import type { TestCase } from "../../src/domain/common.js";
import { findProjectApi, selectWorkflowCollection } from "../../src/workflow/references.js";
import { compileWorkflowPlan, workflowPlanRequests } from "../../src/workflow/plan.js";
import { WorkflowSchema } from "../../src/workflow/model.js";
import { ContractWorkspaceSchema } from "../../src/contract/workspace.js";
import { workspaceFixture } from "../helpers/contractFixtures.js";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import { WorkflowRunner } from "../../src/workflow/runner.js";
import { createDefaultRegistry } from "../../src/index.js";
import { validateEnablement } from "../../src/workflow/validate.js";

const testCase = (id: string): TestCase => ({ id, name: id, scope: "base", parameters: {}, preOperations: [], postOperations: [], assertions: [] });
const api = (id: string): ApiAsset => ({
  contract: {
    formatVersion: 1, id, metadata: { name: id, description: "", tags: [], version: "1", status: "draft" },
    request: { protocol: "http", method: "GET", baseUrl: "https://example.test", path: "/", pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, body: { kind: "none" } },
    responses: [],
  },
  cases: [testCase(`case-${id}`)], documentation: "",
});

function project(collections: ContractCollection[]): ContractProject {
  return {
    id: "project", name: "project", variables: {}, globals: { query: [], headers: [], cookies: [], body: [] },
    environments: [], collections, workflows: [], stressPolicy: { trustedOrigins: [], deniedOrigins: [] }, models: [], components: [],
  };
}

describe("workflow project references", () => {
  it("reports legacy root logical and physical reference gaps while v2 closures remain strict", () => {
    const owner = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
    const asset = owner.collections[0]!.apis[0]!;
    asset.cases = [testCase("valid"), { ...testCase("scoped"), scope: "prod" }];
    owner.workflows = [WorkflowSchema.parse({ id: "legacy", name: "legacy", status: "enabled", nodes: [
      { id: "valid", kind: "request", apiId: asset.contract.id, caseId: "valid" },
      { id: "logical", kind: "request", apiId: asset.contract.id, caseId: "missing" },
      { id: "physical", kind: "request", apiId: asset.contract.id, caseId: "scoped" },
    ], edges: [] })];
    const snapshot = createProjectSnapshot(owner);
    expect(() => compileWorkflowPlan(snapshot, "legacy")).toThrow(/case-reference/);
    const plan = compileWorkflowPlan(snapshot, "legacy", { legacyRootReferenceMode: "report" });
    expect(plan.referenceDiagnostics).toEqual([{ nodeId: "logical", code: "case-reference", logicalMissing: true }, { nodeId: "physical", code: "case-reference", logicalMissing: false }]);
    expect(workflowPlanRequests(snapshot, plan).map((item) => item.testCase?.id)).toEqual(["valid"]);
    owner.workflows.unshift(WorkflowSchema.parse({ id: "root", name: "root", status: "enabled", executionVersion: 2, nodes: [{ id: "call", kind: "subflow", workflowId: "legacy" }] }));
    expect(() => compileWorkflowPlan(createProjectSnapshot(owner), "root", { strict: false, legacyRootReferenceMode: "report" })).toThrow(/case-reference/);
  });
  it("checks logical references for enablement while compiling physical cases only for the selected environment", () => {
    const workspace = ContractWorkspaceSchema.parse(workspaceFixture());
    const owner = workspace.groups[0]!.projects[0]!;
    const asset = owner.collections[0]!.apis[0]!;
    const prodId = "00000000-0000-4000-8000-000000000997";
    owner.environments = [{ id: prodId, name: "prod", variables: {}, baseUrls: {} }];
    asset.cases = [{ ...testCase("scoped"), scope: "prod" }];
    const request = { id: "request", kind: "request" as const, apiId: asset.contract.id, caseId: "scoped" };
    let root = WorkflowSchema.parse({ id: "root", name: "root", status: "published", executionVersion: 2, nodes: [request] });
    owner.workflows = [root];
    let snapshot = createProjectSnapshot(owner);
    expect(compileWorkflowPlan(snapshot, "root", { environmentId: prodId }).selections.map((selection) => selection.scope)).toEqual(["prod"]);
    expect(() => compileWorkflowPlan(snapshot, "root")).toThrow(/case-reference/);
    expect(validateEnablement(root, workspace, owner).errors).toEqual([]);
    const legacy = WorkflowSchema.parse({ id: "legacy", name: "legacy", status: "published", nodes: [request] });
    root = WorkflowSchema.parse({ ...root, nodes: [{ id: "call", kind: "subflow", workflowId: "legacy" }] });
    owner.workflows = [root, legacy];
    snapshot = createProjectSnapshot(owner);
    expect(compileWorkflowPlan(snapshot, "root", { environmentId: prodId }).selections.map((selection) => selection.scope)).toEqual(["prod"]);
    expect(validateEnablement(root, workspace, owner).errors).toEqual([]);
    asset.cases = [];
    expect(validateEnablement(root, workspace, owner).ok).toBe(false);
  });
  it("compiles the fixed closure, sums shared branch/loop/handler execution multipliers and keeps file rows unknown", () => {
    const owner = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
    const asset = owner.collections[0]!.apis[0]!;
    asset.cases = [testCase("selected")];
    asset.cases[0]!.dataDriver = { kind: "dataset", datasetId: "00000000-0000-4000-8000-000000000999" };
    owner.datasets = [{ formatVersion: 1, id: "00000000-0000-4000-8000-000000000999", name: "rows", columns: [], rows: [{}, {}, {}] }];
    const leaf = WorkflowSchema.parse({ id: "leaf", name: "leaf", executionVersion: 2, nodes: [{ id: "request", kind: "request", apiId: asset.contract.id, caseId: "selected", policy: { retry: { maxAttempts: 2, allowRepeatSideEffects: true } } }] });
    const loop = WorkflowSchema.parse({ id: "loop", name: "loop", executionVersion: 2, nodes: [{ id: "loop", kind: "loop", workflowId: "leaf", count: 3 }] });
    const root = WorkflowSchema.parse({ id: "root", name: "root", executionVersion: 2, nodes: [{ id: "fork", kind: "parallel", join: "all", branches: [{ id: "a", workflowId: "loop" }, { id: "b", workflowId: "leaf" }], policy: { onError: { workflowId: "leaf", mode: "recover" }, finally: { workflowId: "leaf" } } }] });
    owner.workflows = [root, loop, leaf];
    const snapshot = createProjectSnapshot(owner);
    const plan = compileWorkflowPlan(snapshot, "root", { allowDraft: true });
    expect(plan.workflowIds).toEqual(["root", "loop", "leaf"]);
    expect(plan.calls.map((call) => call.kind).sort()).toEqual(["branch", "branch", "finally", "loop", "onError"]);
    expect(plan.selections).toHaveLength(1);
    expect(plan.conservativeExecutions.upperBound).toBe(36);
    expect(plan.conservativeExecutions.exact).toBe(false);
    expect(workflowPlanRequests(snapshot, plan)[0]!.testCase).toBe(snapshot.project.collections[0]!.apis[0]!.cases[0]);
    expect(() => workflowPlanRequests(createProjectSnapshot(owner), plan)).toThrow(/快照|snapshot/i);
    expect(Object.isFrozen(plan.selections)).toBe(true);
    asset.cases[0]!.dataDriver = { sourcePath: "private.csv", format: "csv" };
    expect(compileWorkflowPlan(createProjectSnapshot(owner), "root", { allowDraft: true }).conservativeExecutions).toMatchObject({ upperBound: null, requiresPreparedData: true });
    leaf.nodes = [{ id: "missing", kind: "subflow", workflowId: "missing", inputs: {}, outputs: {} }];
    expect(() => compileWorkflowPlan(createProjectSnapshot(owner), "root", { allowDraft: true })).toThrow(/不存在/);
  });

  it("rejects a missing parallel child before execution or secret access", async () => {
    const owner = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
    owner.workflows = [WorkflowSchema.parse({ id: "v2", name: "v2", executionVersion: 2, nodes: [{ id: "parallel", kind: "parallel", join: "all", branches: [{ id: "a", workflowId: "child" }, { id: "b", workflowId: "missing" }] }] }),
      WorkflowSchema.parse({ id: "child", name: "child", nodes: [{ id: "end", kind: "noop" }] })];
    const snapshot = createProjectSnapshot(owner);
    let secretAccesses = 0;
    await expect(new WorkflowRunner({ registry: createDefaultRegistry() }).run({ snapshot, credentialBindings: { resolve: () => { secretAccesses++; throw new Error("Unexpected secret access"); }, versions: {} } }, "v2")).rejects.toThrow(/missing.*不存在|不存在.*missing/);
    expect(secretAccesses).toBe(0);
  });
  it("递归定位目标 API 并保留从集合到两层文件夹的祖先链", () => {
    const target = api("target");
    const inner = { id: "inner", name: "inner", apis: [target], folders: [], preOperations: [{ id: "inner-pre", type: "script" as const, content: "" }], postOperations: [{ id: "inner-post", type: "script" as const, content: "" }] };
    const outer = { id: "outer", name: "outer", apis: [], folders: [inner], preOperations: [{ id: "outer-pre", type: "script" as const, content: "" }], postOperations: [{ id: "outer-post", type: "script" as const, content: "" }] };
    const collection: ContractCollection = {
      id: "module", name: "module", variables: { moduleVar: "yes" }, preOperations: [{ id: "module-pre", type: "script", content: "" }], postOperations: [{ id: "module-post", type: "script", content: "" }],
      apis: [], folders: [outer],
    };
    const location = findProjectApi(project([collection]), "target");
    expect(location?.api).toBe(target);
    expect(location?.collection).toBe(collection);
    expect(location?.folders.map((folder) => folder.id)).toEqual(["outer", "inner"]);
  });

  it("裁剪为唯一目标 API/用例而不原地修改源模块，并保留容器操作与模块 ID", () => {
    const target = api("target");
    const other = api("other");
    const inner = { id: "inner", name: "inner", apis: [target, other], folders: [], preOperations: [{ id: "inner-pre", type: "script" as const, content: "" }], postOperations: [{ id: "inner-post", type: "script" as const, content: "" }] };
    const collection: ContractCollection = {
      id: "module", name: "module", variables: { moduleVar: "yes" }, preOperations: [{ id: "module-pre", type: "script", content: "" }], postOperations: [{ id: "module-post", type: "script", content: "" }],
      apis: [api("top")], folders: [{ id: "outer", name: "outer", apis: [], folders: [inner], preOperations: [{ id: "outer-pre", type: "script", content: "" }], postOperations: [{ id: "outer-post", type: "script", content: "" }] }],
    };
    const location = findProjectApi(project([collection]), "target")!;
    const selected = selectWorkflowCollection(location, target.cases[0]!);
    expect(selected.id).toBe("module");
    expect(selected.variables).toEqual(collection.variables);
    expect(selected.preOperations).toEqual(collection.preOperations);
    expect(selected.postOperations).toEqual(collection.postOperations);
    expect(selected.apis).toHaveLength(0);
    expect(selected.folders).toHaveLength(1);
    expect(selected.folders[0]!.preOperations).toEqual(collection.folders[0]!.preOperations);
    expect(selected.folders[0]!.folders?.[0]!.postOperations).toEqual(inner.postOperations);
    expect(selected.folders[0]!.folders[0]!.apis.map((candidate) => candidate.contract.id)).toEqual(["target"]);
    expect(selected.folders[0]!.folders?.[0]!.apis[0]!.cases).toEqual([target.cases[0]]);
    expect(collection.folders[0]!.folders[0]!.apis.map((candidate) => candidate.contract.id)).toEqual(["target", "other"]);
  });
});

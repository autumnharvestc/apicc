// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ContractWorkspace, DatasetAsset, SuiteAsset } from "@apicc/core";
import type { ApiDetail, ApiccApi, WorkspaceRefreshResult } from "../../../src/shared/types.js";
import type { ApiLocator } from "../../../src/shared/locations.js";
import type { TestingAssets } from "../../../src/shared/testing.js";
import { localWorkspaceError } from "../../../src/shared/workspace-refresh.js";
import { toTreeNode } from "../../../src/main/tree.js";
import { IDS, makeWorkspace, projectOne, uuid } from "../../main/helpers/contract-assets.js";
import { useCasesStore } from "../../../src/renderer/src/stores/cases.js";
import { useDesignStore } from "../../../src/renderer/src/stores/design.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";
import { useEnvsStore } from "../../../src/renderer/src/stores/envs.js";
import { environmentDraftsFor, reconcileEnvironmentDrafts, type SaveFeedback } from "../../../src/renderer/src/stores/environmentDrafts.js";
import { projectSessionKey } from "../../../src/renderer/src/stores/localIdentity.js";
import { caseUnit } from "../../../src/renderer/src/stores/editorDiskRefresh.js";
import { createTestingStore } from "../../../src/renderer/src/stores/testing.js";
import { useWorkflowDesignStore } from "../../../src/renderer/src/stores/workflowDesign.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";

const root = "/actual-workspace";
const project = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
const locator: ApiLocator = { ...project, collectionId: IDS.collectionOne, apiId: IDS.sharedApi, folderIds: [] };
const localContext = () => ({ root, readOnly: false });
const asset = (workspace: ContractWorkspace) => projectOne(workspace).collections[0]!.apis[0]!;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function receipt(before: ContractWorkspace, after: ContractWorkspace, revision = "r2"): WorkspaceRefreshResult {
  return { root, workspace: after, previousWorkspace: before, tree: toTreeNode(after), revision, readOnly: false, problems: [] };
}
function editorFixture(before = makeWorkspace()) {
  let disk = before;
  let revision = "r1";
  const detail = (): ApiDetail => ({ api: copy(asset(disk)), locator, sourceApiRevision: revision, sourceProjectRevision: revision, envs: [] });
  const apiSave = vi.fn(async (_location, value) => ({ ...detail(), api: copy(value) }));
  const caseDraftSave = vi.fn(async (_location, value) => ({ testCase: copy(value), sourceApiRevision: revision }));
  const api = { apiGet: async () => detail(), apiSave, caseDraftSave } as unknown as ApiccApi;
  const editor = useEditorStore(api, localContext);
  return {
    api, apiSave, caseDraftSave, editor, before,
    async refresh(after: ContractWorkspace, previous = before, extra?: Parameters<typeof editor.reconcileDiskRefresh>[2]) {
      disk = after;
      revision = "r2";
      await editor.reconcileDiskRefresh(receipt(previous, after), () => true, extra);
    },
  };
}

describe("draft recovery after explicit disk refresh", () => {
  it("preserves a retained formal request draft and rebases its save after a different project's write", async () => {
    const { editor, apiSave, before, refresh } = editorFixture();
    await editor.load(locator);
    const key = editor.activeKey!;
    editor.api!.contract.request.path = "/local";
    editor.activeKey = null;
    const after = copy(before);
    after.groups[1]!.projects[0]!.name = "External project";
    await refresh(after);
    expect(editor.sessions[key]!.api.contract.request.path).toBe("/local");
    await editor.load(locator);
    expect(editor.dirty).toBe(true);
    await editor.save();
    expect(apiSave).toHaveBeenCalledWith(locator, expect.objectContaining({ contract: expect.objectContaining({ request: expect.objectContaining({ path: "/local" }) }) }), "r2");
    expect(editor.dirty).toBe(false);
  });

  it("blocks a request dependency conflict after repeat refresh, then restores only the request", async () => {
    const { editor, before, apiSave, refresh } = editorFixture();
    await editor.load(locator);
    const key = editor.activeKey!;
    editor.api!.contract.request.path = "/draft";
    editor.api!.documentation = "retained documentation draft";
    const after = copy(before);
    asset(after).cases[0]!.requestOverride = copy(asset(after).contract.request);
    await refresh(after);
    await refresh(after, after);
    expect(editor.sessions[key]!.diskConflicts?.request?.reason).toBe("changed");
    await expect(editor.save()).rejects.toThrow("disk-draft-blocked");
    expect(apiSave).not.toHaveBeenCalled();
    expect(editor.restoreDiskUnit(key, "request")).toBe(true);
    expect(editor.api?.contract.request.path).toBe(asset(after).contract.request.path);
    expect(editor.api?.documentation).toBe("retained documentation draft");
  });

  it("keeps a request draft protected when explicit refresh observes a shared dependency update", async () => {
    const { editor, before, apiSave, refresh } = editorFixture();
    await editor.load(locator);
    editor.api!.contract.request.path = "/kept-after-refresh";
    const after = copy(before);
    after.variables.tenant = "external value";
    await refresh(after);
    expect(editor.sessions[editor.activeKey!]!.diskConflicts?.request?.reason).toBe("changed");
    expect(editor.api?.contract.request.path).toBe("/kept-after-refresh");
    await expect(editor.save()).rejects.toThrow("disk-draft-blocked");
    expect(apiSave).not.toHaveBeenCalled();
  });

  it("keeps an environment draft protected when explicit refresh changes its parent", () => {
    const before = makeWorkspace();
    const parentId = uuid(501), childId = uuid(502);
    projectOne(before).environments.push(
      { id: parentId, name: "parent", variables: { tenant: "original" }, baseUrls: {} },
      { id: childId, name: "child", extends: "parent", variables: { editable: "original" }, baseUrls: {} },
    );
    const after = copy(before);
    projectOne(after).environments.find(item => item.id === parentId)!.variables.tenant = "externally updated";
    const store = useEnvsStore({} as ApiccApi, localContext);
    const drafts = environmentDraftsFor(store);
    const feedback = (): SaveFeedback => ({ pending: false, saved: false, error: null });
    const globals = { ...projectOne(before).globals, variables: projectOne(before).variables };
    const key = projectSessionKey(root, project);
    drafts.set(key, { root, locator: project, globals, latestGlobals: globals, queryRows: [], headerRows: [], variableRows: [],
      variableFeedback: feedback(), parameterFeedback: feedback(), environments: new Map([[childId, {
        name: "child", baseUrls: {}, confirmedBaseUrls: {}, confirmedVariables: { editable: "original" },
        rows: [{ id: "draft-row", key: "editable", value: "unsaved" }], feedback: feedback(),
      }]]) });
    reconcileEnvironmentDrafts(store, receipt(before, after));
    const draft = drafts.get(key)!.environments.get(childId)!;
    expect(draft.feedback.conflict?.reason).toBe("changed");
    expect(draft.rows[0]?.value).toBe("unsaved");
    draft.feedback.conflict?.restore?.();
    expect(draft.rows[0]?.value).toBe("original");
  });

  it("keeps the conflicting pending deletion and saves the safe scope of the same logical case", async () => {
    const { editor, api, before, caseDraftSave, refresh } = editorFixture();
    await editor.load(locator);
    const cases = useCasesStore(api, editor);
    const key = editor.activeKey!;
    const removed = { caseId: IDS.sharedCase, scope: "blue" };
    cases.removeCase(removed.caseId, removed.scope);
    const local = editor.api!.cases.find((entry) => entry.scope === "green")!;
    local.name = "green draft";
    const after = copy(before);
    asset(after).cases[0]!.name = "changed blue on disk";
    await refresh(after);
    expect(editor.sessions[key]!.diskConflicts?.[caseUnit(removed)]?.reason).toBe("changed");
    cases.select(local.id, local.scope);
    await cases.save();
    expect(caseDraftSave).toHaveBeenCalledWith(expect.objectContaining({ scope: "green" }), expect.objectContaining({ name: "green draft" }), "r2", [], []);
    expect(cases.pendingDeletes[key]).toEqual([expect.objectContaining(removed)]);
    expect(editor.restoreDiskUnit(key, caseUnit(removed))).toBe(true);
    cases.resolveDiskDraft(key, caseUnit(removed));
    expect(cases.pendingDeletes[key]).toBeUndefined();
    expect(editor.api!.cases.find((entry) => entry.scope === "blue")?.name).toBe("changed blue on disk");
  });

  it("compares a separate Markdown draft and replaces only the clean editor cache", async () => {
    const { editor, api, before, refresh } = editorFixture();
    const design = useDesignStore(api, editor);
    await editor.load(locator);
    const key = editor.activeKey!;
    design.load();
    const updated = copy(before);
    asset(updated).documentation = "first disk document";
    await refresh(updated);
    design.reconcileDiskDrafts(root);
    expect(design.content).toBe("first disk document");
    design.setContent("local markdown draft");
    const competing = copy(updated);
    asset(competing).documentation = "competing disk document";
    await refresh(competing, updated, (_item, key) => ({ request: false, asset: design.hasDocumentDraft(key) }));
    design.reconcileDiskDrafts(root);
    expect(design.content).toBe("local markdown draft");
    await expect(design.save()).rejects.toThrow("disk-draft-blocked");
    expect(editor.restoreDiskUnit(key, "asset")).toBe(true);
    design.abandonDiskDraft(key);
    expect(design.content).toBe("competing disk document");
  });

  it("blocks a dependent workflow draft on repeat refresh and keeps its captured run on restore", async () => {
    const before = makeWorkspace();
    const flow = projectOne(before).workflows[0]!;
    const workflowLocator = { ...project, workflowId: flow.id };
    const wfSave = vi.fn(async (_loc, draft) => draft);
    const workflow = useWorkflowDesignStore({ wfGet: async () => ({ workflow: flow, locator: workflowLocator }), wfSave } as unknown as ApiccApi, localContext);
    await workflow.load(root, workflowLocator);
    workflow.update({ ...copy(flow), name: "workflow draft" });
    const previousRun = { invocationId: "previous" } as NonNullable<typeof workflow.runResult>;
    workflow.runResult = previousRun;
    const after = copy(before);
    projectOne(after).workflows[0]!.name = "disk workflow";
    workflow.reconcileDiskRefresh(receipt(before, after));
    workflow.reconcileDiskRefresh(receipt(after, after));
    await expect(workflow.save()).rejects.toThrow("disk-draft-blocked");
    expect(wfSave).not.toHaveBeenCalled();
    expect(workflow.workflow?.name).toBe("workflow draft");
    workflow.diskConflict!.restore!();
    expect(workflow.workflow?.name).toBe("disk workflow");
    expect(workflow.runResult).toEqual(previousRun);
  });

  it("reissues a late workflow read after refresh and confirms status without replacing edits made during the request", async () => {
    const before = makeWorkspace();
    const stale = projectOne(before).workflows[0]!;
    const after = copy(before);
    const latest = projectOne(after).workflows[0]!;
    latest.name = "fresh workflow";
    const target = { ...project, workflowId: stale.id };
    let releaseRead!: () => void, releaseStatus!: () => void;
    const readHold = new Promise<void>((resolve) => { releaseRead = resolve; });
    const statusHold = new Promise<void>((resolve) => { releaseStatus = resolve; });
    const wfGet = vi.fn(async () => ({ workflow: copy(latest), locator: target })).mockImplementationOnce(async () => {
      await readHold;
      return { workflow: stale, locator: target };
    });
    const wfSetStatus = vi.fn(async () => {
      await statusHold;
      return { workflow: { ...latest, status: "published" }, errors: [], warnings: [] };
    });
    const workflow = useWorkflowDesignStore({ wfGet, wfSetStatus } as unknown as ApiccApi, localContext);
    const loading = workflow.load(root, target);
    workflow.reconcileDiskRefresh(receipt(before, after));
    releaseRead();
    await loading;
    expect(wfGet).toHaveBeenCalledTimes(2);
    expect(workflow.workflow?.name).toBe("fresh workflow");
    const publishing = workflow.setStatus("published");
    workflow.update({ ...copy(workflow.workflow!), name: "typed while publishing" });
    releaseStatus();
    await publishing;
    expect(workflow.workflow).toMatchObject({ name: "typed while publishing", status: "published" });
    expect(workflow.dirty).toBe(true);
  });

  it("keeps draft dataset fields and unstaged columns while advancing the safe save context", async () => {
    const dataset: DatasetAsset = { id: uuid(71), name: "customers", formatVersion: 1, columns: ["id"], rows: [{ id: 1 }] };
    const before = makeWorkspace();
    projectOne(before).datasets = [dataset];
    let revision = "r1";
    let disk = before;
    const view = (): TestingAssets => ({ context: { root, project, revision }, readOnly: false,
      datasets: copy(projectOne(disk).datasets ?? []), suites: [], environments: [], cases: [], collections: [], workflows: [] });
    const saveDataset = vi.fn(async (input: Parameters<ApiccApi["saveDataset"]>[0]) => {
      if (input.context.revision !== "r2") throw localWorkspaceError("revision-conflict", "stale", root);
      return view();
    });
    const testing = createTestingStore({ listTestingAssets: async () => view(), assertionOperators: async () => [], saveDataset } as unknown as ApiccApi, {
      confirmDiscard: () => true, getActive: () => ({ ...localContext(), project }),
    });
    await testing.activate(root, project);
    await testing.select("dataset", dataset.id);
    testing.pendingDatasetColumns = "id\nnewColumn";
    testing.dataset!.name = "local dataset";
    await expect(testing.save()).rejects.toMatchObject({ failure: { reason: "revision-conflict" } });
    disk = copy(before);
    disk.groups[1]!.projects[0]!.name = "unrelated project";
    revision = "r2";
    await testing.reconcileDiskRefresh(receipt(before, disk), () => true);
    expect(testing.saveFailure).toBeNull();
    expect(testing.dataset?.name).toBe("local dataset");
    expect(testing.pendingDatasetColumns).toBe("id\nnewColumn");
    await testing.save();
    expect(saveDataset.mock.calls.at(-1)?.[0].context.revision).toBe("r2");
    expect(testing.pendingDatasetColumns).toBe("id\nnewColumn");
  });

  it("keeps a suite's changed dataset dependency blocked and retains the prior result", async () => {
    const dataset: DatasetAsset = { id: uuid(71), name: "customers", formatVersion: 1, columns: ["id"], rows: [{ id: 1 }] };
    const suite: SuiteAsset = { id: uuid(72), name: "smoke", formatVersion: 1, tags: [], datasetId: dataset.id, failFast: false, reporters: ["html"], selection: { kind: "explicit", entries: [] } };
    const before = makeWorkspace();
    projectOne(before).datasets = [dataset];
    projectOne(before).suites = [suite];
    let revision = "r1";
    let disk = before;
    const api = { assertionOperators: async () => [], listTestingAssets: async (): Promise<TestingAssets> => ({
      context: { root, revision, project }, readOnly: false, datasets: copy(projectOne(disk).datasets ?? []), suites: copy(projectOne(disk).suites ?? []),
      cases: [], environments: [], collections: [], workflows: [],
    }) } as unknown as ApiccApi;
    const testing = createTestingStore(api, { confirmDiscard: () => true, getActive: () => ({ ...localContext(), project }) });
    await testing.activate(root, project);
    await testing.select("suite", suite.id);
    testing.suite!.name = "suite draft";
    const previousResult = { invocationId: "history" } as NonNullable<typeof testing.result>;
    testing.result = previousResult;
    disk = copy(before);
    projectOne(disk).datasets![0]!.rows[0]!.id = 2;
    revision = "r2";
    await testing.reconcileDiskRefresh(receipt(before, disk), () => true);
    await testing.reconcileDiskRefresh(receipt(disk, disk), () => true);
    expect(testing.diskConflict?.reason).toBe("changed");
    await expect(testing.save()).rejects.toThrow("disk-draft-blocked");
    expect(testing.suite?.name).toBe("suite draft");
    testing.diskConflict!.restore!();
    expect(testing.suite?.name).toBe("smoke");
    expect(testing.result).toEqual(previousResult);
  });

  it("merges duplicate renderer requests and keeps writes gated until reconciliation completes", async () => {
    const before = makeWorkspace(), after = copy(before);
    after.name = "disk workspace";
    const opened = { ...receipt(before, before, "r1"), disposition: "opened" as const };
    const wsRefresh = vi.fn(async () => receipt(before, after));
    const workspace = useWorkspaceStore({ wsOpen: async () => opened, wsRefresh } as unknown as ApiccApi);
    await workspace.open(root);
    let release!: () => void;
    let entered!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const start = new Promise<void>((resolve) => { entered = resolve; });
    const reconcile = vi.fn(async () => { entered(); await hold; });
    const pending = workspace.refreshFromDisk(reconcile);
    try {
      await start;
      const duplicate = workspace.refreshFromDisk(reconcile);
      expect(workspace.hasPendingDiskRefresh()).toBe(true);
      release();
      await Promise.all([pending, duplicate]);
      expect(wsRefresh).toHaveBeenCalledTimes(1);
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(workspace.revision).toBe("r2");
      expect(workspace.hasPendingDiskRefresh()).toBe(false);
    } finally { release(); await pending; }
  });
});

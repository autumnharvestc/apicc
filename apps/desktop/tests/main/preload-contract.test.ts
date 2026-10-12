import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiccApi } from "../../src/shared/types.js";
import type { ApiTestCase } from "@apicc/core";
import { IpcChannel } from "../../src/shared/channels.js";
import { toTreeNode } from "../../src/main/tree.js";
import { IDS, makeApi, makeWorkspace, projectOne, uuid } from "./helpers/contract-assets.js";

const electron = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined as unknown),
  on: vi.fn(),
  send: vi.fn(),
  expose: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcRenderer: { invoke: electron.invoke, on: electron.on, send: electron.send },
  contextBridge: { exposeInMainWorld: electron.expose },
}));

describe("typed preload contract", () => {
  beforeEach(() => {
    electron.invoke.mockReset();
    electron.invoke.mockResolvedValue(undefined);
    electron.on.mockReset();
    electron.send.mockReset();
    electron.expose.mockReset();
  });

  async function exposedApi() {
    vi.resetModules();
    await import("../../src/preload/preload.js");
    const exposed = electron.expose.mock.calls.at(-1);
    expect(exposed?.[0]).toBe("apicc");
    return exposed?.[1] as ApiccApi;
  }

  it("passes full locators and complete result payloads through unchanged", async () => {
    const api = await exposedApi();
    const locator = {
      workspaceId: "00000000-0000-4000-8000-000000000001",
      groupId: "00000000-0000-4000-8000-000000000002",
      projectId: "00000000-0000-4000-8000-000000000004",
      collectionId: "00000000-0000-4000-8000-000000000006",
      folderIds: [],
      apiId: "00000000-0000-4000-8000-000000000008",
    };
    const result = { locator, api: { contract: { id: locator.apiId } }, envs: [] };
    electron.invoke.mockResolvedValueOnce(result);

    await expect(api.apiGet(locator as never)).resolves.toBe(result);
    expect(electron.invoke).toHaveBeenCalledWith("api:get", locator);
  });

  it("preserves the full workspace-open and local tree result DTOs", async () => {
    const api = await exposedApi();
    const workspace = makeWorkspace();
    const openResult = { workspace, problems: [], root: "C:/fixture", readOnly: false, revision: "revision-1" };
    electron.invoke.mockResolvedValueOnce(openResult);

    await expect(api.wsOpen("C:/fixture")).resolves.toBe(openResult);
    expect(electron.invoke).toHaveBeenLastCalledWith(IpcChannel.WsOpen, "C:/fixture");

    const tree = toTreeNode(workspace);
    electron.invoke.mockResolvedValueOnce(tree);
    await expect(api.treeGet()).resolves.toBe(tree);
    expect(electron.invoke).toHaveBeenLastCalledWith(IpcChannel.TreeGet);

    electron.invoke.mockResolvedValueOnce(openResult);
    await expect(api.wsCreate("C:/new", "new workspace")).resolves.toBe(openResult);
    expect(electron.invoke).toHaveBeenLastCalledWith(IpcChannel.WsCreate, "C:/new", "new workspace");
  });

  it("keeps the container save result shape and full node locator on their IPC channels", async () => {
    const api = await exposedApi();
    const locator = {
      workspaceId: "00000000-0000-4000-8000-000000000001",
      groupId: "00000000-0000-4000-8000-000000000002",
      projectId: "00000000-0000-4000-8000-000000000004",
    };
    const node = { kind: "project" as const, locator };
    const saveResult = { kind: "collection", locator: { ...locator, collectionId: "00000000-0000-4000-8000-000000000006" }, operations: { preOperations: [], postOperations: [], variables: {} } };
    electron.invoke.mockResolvedValueOnce(saveResult);

    await expect(api.containerSave({ kind: "collection", locator: saveResult.locator, operations: saveResult.operations })).resolves.toBe(saveResult);
    expect(electron.invoke).toHaveBeenCalledWith("container:save", { kind: "collection", locator: saveResult.locator, operations: saveResult.operations });

    await api.nodeRename(node, "renamed");
    expect(electron.invoke).toHaveBeenLastCalledWith("node:rename", node, "renamed");
  });

  it("maps every changed public method to its exact invoke channel and full payload tuple", async () => {
    const api = await exposedApi();
    const workspaceLocator = { workspaceId: IDS.workspace };
    const groupLocator = { ...workspaceLocator, groupId: IDS.groupOne };
    const projectLocator = { ...groupLocator, projectId: IDS.projectOne };
    const collectionLocator = { ...projectLocator, collectionId: IDS.collectionOne };
    const folderLocator = { ...collectionLocator, folderIds: [IDS.folderOne] };
    const apiLocator = { ...collectionLocator, folderIds: [], apiId: IDS.sharedApi };
    const environmentLocator = { ...projectLocator, environmentId: IDS.environment };
    const modelLocator = { ...projectLocator, modelId: IDS.model };
    const componentLocator = { ...projectLocator, componentKind: "parameter" as const, componentId: IDS.parameter };
    const workflowLocator = { ...projectLocator, workflowId: IDS.workflow };
    const workspace = makeWorkspace();
    const project = projectOne(workspace);
    const asset = makeApi(IDS.sharedApi, "preload API");
    const testCase: ApiTestCase = asset.cases[0]!;
    const workflow = project.workflows[0]!;
    const policy = { trustedOrigins: ["https://api.example.test"], deniedOrigins: [], maxConcurrency: 2 };
    const globals = { variables: { token: "secret-ref" }, query: [], headers: [], cookies: [], body: [] };
    const operations = { preOperations: [], postOperations: [] };
    const collectionOperations = { ...operations, variables: { token: "saved" } };
    const modelInput = { name: "new model", description: "", schema: { kind: "scalar" as const, type: "string" as const } };
    const componentInput = {
      kind: "parameter" as const,
      name: "new parameter",
      description: "",
      definition: { location: "header" as const, name: "x-token", schema: { kind: "scalar" as const, type: "string" as const }, required: false, description: "" },
    };
    const projectImport = { mode: "project" as const, target: groupLocator, name: "imported", project };
    const moduleImport = { mode: "module" as const, target: projectLocator, name: "module", project };
    const cases: Array<{ invoke: () => Promise<unknown>; channel: string; payload: unknown[] }> = [
      { invoke: () => api.wsOpen("C:/fixture"), channel: IpcChannel.WsOpen, payload: ["C:/fixture"] },
      { invoke: () => api.wsCreate("C:/new", "new workspace"), channel: IpcChannel.WsCreate, payload: ["C:/new", "new workspace"] },
      { invoke: () => api.treeGet(), channel: IpcChannel.TreeGet, payload: [] },
      { invoke: () => api.nodeCreate({ kind: "group", parent: workspaceLocator, name: "new group" }), channel: IpcChannel.NodeCreate, payload: [{ kind: "group", parent: workspaceLocator, name: "new group" }] },
      { invoke: () => api.nodeCreate({ kind: "project", parent: groupLocator, name: "new project" }), channel: IpcChannel.NodeCreate, payload: [{ kind: "project", parent: groupLocator, name: "new project" }] },
      { invoke: () => api.nodeCreate({ kind: "collection", parent: projectLocator, name: "new collection" }), channel: IpcChannel.NodeCreate, payload: [{ kind: "collection", parent: projectLocator, name: "new collection" }] },
      { invoke: () => api.nodeCreate({ kind: "folder", parent: folderLocator, name: "new folder" }), channel: IpcChannel.NodeCreate, payload: [{ kind: "folder", parent: folderLocator, name: "new folder" }] },
      { invoke: () => api.nodeCreate({ kind: "api", parent: folderLocator, api: { name: "new API", protocol: "http" } }), channel: IpcChannel.NodeCreate, payload: [{ kind: "api", parent: folderLocator, api: { name: "new API", protocol: "http" } }] },
      { invoke: () => api.nodeRename({ kind: "api", locator: apiLocator }, "renamed"), channel: IpcChannel.NodeRename, payload: [{ kind: "api", locator: apiLocator }, "renamed"] },
      { invoke: () => api.nodeDelete({ kind: "workflow", locator: workflowLocator }), channel: IpcChannel.NodeDelete, payload: [{ kind: "workflow", locator: workflowLocator }] },
      { invoke: () => api.envCreate({ locator: projectLocator, name: "qa", extends: null, variables: { token: "qa" }, baseUrls: { [IDS.collectionOne]: "https://qa.example.test" } }), channel: IpcChannel.EnvCreate, payload: [{ locator: projectLocator, name: "qa", extends: null, variables: { token: "qa" }, baseUrls: { [IDS.collectionOne]: "https://qa.example.test" } }] },
      { invoke: () => api.envVarsSave(environmentLocator, { token: "next" }), channel: IpcChannel.EnvVarsSave, payload: [environmentLocator, { token: "next" }] },
      { invoke: () => api.envBaseUrlsSave(environmentLocator, { [IDS.collectionOne]: "https://next.example.test" }), channel: IpcChannel.EnvBaseUrlsSave, payload: [environmentLocator, { [IDS.collectionOne]: "https://next.example.test" }] },
      { invoke: () => api.globalsSave(projectLocator, globals), channel: IpcChannel.GlobalsSave, payload: [projectLocator, globals] },
      { invoke: () => api.globalsGet(projectLocator), channel: IpcChannel.GlobalsGet, payload: [projectLocator] },
      { invoke: () => api.stressPolicySave(projectLocator, policy), channel: IpcChannel.StressPolicySave, payload: [projectLocator, policy] },
      { invoke: () => api.containerGet({ kind: "collection", locator: collectionLocator }), channel: IpcChannel.ContainerGet, payload: [{ kind: "collection", locator: collectionLocator }] },
      { invoke: () => api.containerGet({ kind: "folder", locator: folderLocator }), channel: IpcChannel.ContainerGet, payload: [{ kind: "folder", locator: folderLocator }] },
      { invoke: () => api.containerSave({ kind: "folder", locator: folderLocator, operations }), channel: IpcChannel.ContainerSave, payload: [{ kind: "folder", locator: folderLocator, operations }] },
      { invoke: () => api.apiGet(apiLocator), channel: IpcChannel.ApiGet, payload: [apiLocator] },
      { invoke: () => api.apiSave(apiLocator, asset), channel: IpcChannel.ApiSave, payload: [apiLocator, asset] },
      { invoke: () => api.caseSave({ ...apiLocator, caseId: testCase.id, scope: testCase.scope }, testCase), channel: IpcChannel.CaseSave, payload: [{ ...apiLocator, caseId: testCase.id, scope: testCase.scope }, testCase] },
      { invoke: () => api.caseDelete({ ...apiLocator, caseId: testCase.id, scope: testCase.scope }), channel: IpcChannel.CaseDelete, payload: [{ ...apiLocator, caseId: testCase.id, scope: testCase.scope }] },
      { invoke: () => api.modelList(projectLocator), channel: IpcChannel.ModelList, payload: [projectLocator] },
      { invoke: () => api.modelGet(modelLocator), channel: IpcChannel.ModelGet, payload: [modelLocator] },
      { invoke: () => api.modelCreate(projectLocator, modelInput), channel: IpcChannel.ModelCreate, payload: [projectLocator, modelInput] },
      { invoke: () => api.modelSave(modelLocator, project.models[0]!), channel: IpcChannel.ModelSave, payload: [modelLocator, project.models[0]!] },
      { invoke: () => api.componentList(projectLocator), channel: IpcChannel.ComponentList, payload: [projectLocator] },
      { invoke: () => api.componentGet(componentLocator), channel: IpcChannel.ComponentGet, payload: [componentLocator] },
      { invoke: () => api.componentCreate(projectLocator, componentInput), channel: IpcChannel.ComponentCreate, payload: [projectLocator, componentInput] },
      { invoke: () => api.componentSave(componentLocator, project.components.find((item) => item.id === IDS.parameter)!), channel: IpcChannel.ComponentSave, payload: [componentLocator, project.components.find((item) => item.id === IDS.parameter)!] },
      { invoke: () => api.assetReferences(projectLocator, IDS.model), channel: IpcChannel.AssetReferences, payload: [projectLocator, IDS.model] },
      { invoke: () => api.debugSend({ locator: apiLocator, caseId: testCase.id, envName: null }), channel: IpcChannel.DebugSend, payload: [{ locator: apiLocator, caseId: testCase.id, envName: null }] },
      { invoke: () => api.runCollection({ locator: collectionLocator, envName: null }), channel: IpcChannel.RunCollection, payload: [{ locator: collectionLocator, envName: null }] },
      { invoke: () => api.importApply(projectImport), channel: IpcChannel.ImportApply, payload: [projectImport] },
      { invoke: () => api.importApply(moduleImport), channel: IpcChannel.ImportApply, payload: [moduleImport] },
      { invoke: () => api.importPreview({ fileName: "fixture.json", content: "{}" }), channel: IpcChannel.ImportPreview, payload: [{ fileName: "fixture.json", content: "{}" }] },
      { invoke: () => api.projectClone(projectLocator), channel: IpcChannel.ProjectClone, payload: [projectLocator] },
      { invoke: () => api.projectMove(projectLocator, groupLocator), channel: IpcChannel.ProjectMove, payload: [projectLocator, groupLocator] },
      { invoke: () => api.designExport(apiLocator), channel: IpcChannel.DesignExport, payload: [apiLocator] },
      { invoke: () => api.wfList(projectLocator), channel: IpcChannel.WfList, payload: [projectLocator] },
      { invoke: () => api.wfGet(workflowLocator), channel: IpcChannel.WfGet, payload: [workflowLocator] },
      { invoke: () => api.wfCreate({ locator: projectLocator, name: "new workflow" }), channel: IpcChannel.WfCreate, payload: [{ locator: projectLocator, name: "new workflow" }] },
      { invoke: () => api.wfDelete(workflowLocator), channel: IpcChannel.WfDelete, payload: [workflowLocator] },
      { invoke: () => api.wfRename(workflowLocator, "renamed workflow"), channel: IpcChannel.WfRename, payload: [workflowLocator, "renamed workflow"] },
      { invoke: () => api.wfSave(workflowLocator, workflow), channel: IpcChannel.WfSave, payload: [workflowLocator, workflow] },
      { invoke: () => api.wfSetStatus(workflowLocator, "published"), channel: IpcChannel.WfSetStatus, payload: [workflowLocator, "published"] },
      { invoke: () => api.wfImpact({ ...apiLocator, caseId: testCase.id }), channel: IpcChannel.WfImpact, payload: [{ ...apiLocator, caseId: testCase.id }] },
      { invoke: () => api.wfRun({ locator: workflowLocator, envName: null, strict: true }), channel: IpcChannel.WfRun, payload: [{ locator: workflowLocator, envName: null, strict: true }] },
      { invoke: () => api.stressRun({ locator: apiLocator, caseId: testCase.id, concurrency: 1, maxIterations: 1 }), channel: IpcChannel.StressRun, payload: [{ locator: apiLocator, caseId: testCase.id, concurrency: 1, maxIterations: 1 }] },
      { invoke: () => api.authConfig("https://contracts.example.test"), channel: IpcChannel.OnlineAuthConfig, payload: ["https://contracts.example.test"] },
      { invoke: () => api.credentialPut({ locator: { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne }, ref: { id: "new-ref", policy: "test-auto" }, value: "synthetic value" }), channel: IpcChannel.CredentialPut, payload: [{ locator: { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne }, ref: { id: "new-ref", policy: "test-auto" }, value: "synthetic value" }] },
      { invoke: () => api.credentialRemove({ locator: { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne }, ref: { id: "new-ref", policy: "test-auto" } }), channel: IpcChannel.CredentialRemove, payload: [{ locator: { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne }, ref: { id: "new-ref", policy: "test-auto" } }] },
      { invoke: () => api.credentialStatus({ locator: { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne }, ref: { id: "new-ref", policy: "test-auto" } }), channel: IpcChannel.CredentialStatus, payload: [{ locator: { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne }, ref: { id: "new-ref", policy: "test-auto" } }] },
    ];

    for (const test of cases) {
      if (test.channel === IpcChannel.StressRun) {
        electron.invoke.mockResolvedValueOnce({ ok: false, error: { code: "target_denied", message: "denied", targetOrigin: "https://api.example.test" } });
      }
      if (test.channel === IpcChannel.CredentialPut || test.channel === IpcChannel.CredentialRemove) electron.invoke.mockResolvedValueOnce({ ok: true });
      if (test.channel === IpcChannel.CredentialStatus) electron.invoke.mockResolvedValueOnce({ ok: true, status: "missing" });
      await test.invoke();
      expect(electron.invoke).toHaveBeenLastCalledWith(test.channel, ...test.payload);
    }
    expect(cases).toHaveLength(54);
  });

  it("validates stress results at the actual preload boundary", async () => {
    const api = await exposedApi();
    const locator = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne, collectionId: IDS.collectionOne, folderIds: [], apiId: IDS.sharedApi };
    const input = { locator, caseId: IDS.sharedCase, concurrency: 1, maxIterations: 1 };
    const result = { ok: false as const, error: { code: "target_denied" as const, message: "denied", targetOrigin: "https://api.example.test" } };
    electron.invoke.mockResolvedValueOnce(result);

    await expect(api.stressRun(input)).resolves.toEqual(result);
    expect(electron.invoke).toHaveBeenLastCalledWith(IpcChannel.StressRun, input);

    electron.invoke.mockResolvedValueOnce({ ...result, unexpected: true });
    await expect(api.stressRun(input)).rejects.toThrow(/unexpected|Unrecognized key/i);
  });

  it("parses credential results and rejects secret-bearing or malformed envelopes", async () => {
    const api = await exposedApi();
    const input = { locator: { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne }, ref: { id: "preload-ref", policy: "test-auto" } };
    electron.invoke.mockResolvedValueOnce({ ok: true });
    await expect(api.credentialPut({ ...input, value: "synthetic" })).resolves.toEqual({ ok: true });
    electron.invoke.mockResolvedValueOnce({ ok: true, status: "unavailable" });
    await expect(api.credentialStatus(input)).resolves.toEqual({ ok: true, status: "unavailable" });
    electron.invoke.mockResolvedValueOnce({ ok: false, error: { code: "CREDENTIAL_MISSING", refId: "preload-ref", message: "Credential is not available." } });
    await expect(api.credentialRemove(input)).resolves.toEqual({ ok: false, error: { code: "CREDENTIAL_MISSING", refId: "preload-ref", message: "Credential is not available." } });

    for (const malformed of [
      { ok: true, value: "plaintext-secret" },
      { ok: false, error: { code: "native_error", refId: "preload-ref", message: "secret-bearing" } },
      { ok: true, status: "missing", bindings: {} },
      { ok: true, status: "future-state" },
    ]) {
      electron.invoke.mockResolvedValueOnce(malformed);
      await expect(api.credentialStatus(input)).rejects.toThrow();
    }
  });

  it("forwards dirty-check responses without exposing the Electron event", async () => {
    const api = await exposedApi();
    const handler = vi.fn(() => true);
    api.onDirtyCheck(handler);
    const listener = electron.on.mock.calls[0]?.[1] as () => void;

    listener();
    expect(handler).toHaveBeenCalledOnce();
    expect(electron.send).toHaveBeenCalledWith("app:dirty-check:reply", true);
  });
});

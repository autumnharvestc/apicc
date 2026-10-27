import { watch } from "vue";
import { ContractProjectSchema, DatasetAssetSchema, SuiteAssetSchema, WorkflowSchema } from "@apicc/core/schema";
import type { ContractWorkspace, ContractCollection, ContractFolder, ApiAsset, Workflow } from "@apicc/core";
import type { ApiccApi, ApiDetail } from "../../../shared/types.js";
import type { TestingAssets, TestingContext } from "../../../shared/testing.js";
import type { ApiLocator } from "../../../shared/locations.js";
import { toTreeNode } from "../../../main/tree.js"; // Pure DTO projection: type-only Core dependency, no filesystem/runtime imports.
import { useWorkspaceStore } from "./workspace.js";
import { useEnvsStore } from "./envs.js";
import { createTestingStore } from "./testing.js";
import { useWorkflowDesignStore } from "./workflowDesign.js";
import { useWfListStore } from "./wfList.js";
import { useEditorStore } from "./editor.js";
import { useCasesStore } from "./cases.js";
import { CredentialMutationResultSchema, CredentialStatusResultSchema } from "../../../shared/credentials.js";
import type { OnlineExecutionStore } from "./onlineExecution.js";
import { OnlineDatasetContentSchema } from "../../../shared/online/execution.js";
import { z } from "zod";

/** Reuses the existing business editors. Every mutation is captured against the explicit
 * online scope/version and saved with the atomic assets API. The renderer-only root key
 * distinguishes editor sessions; it is never a filesystem path or an IPC local-session input. */
export function createOnlineProjectAdapter(execution: OnlineExecutionStore, api: ApiccApi, readOnly: () => boolean, confirmDiscard: () => boolean) {
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const editorRoot = () => execution.context ? `online:${JSON.stringify(execution.context)}` : "";
  const locator = () => { if (!execution.context || !execution.project) throw new Error("online-project-unavailable"); return { workspaceId: execution.context.scope.workspaceId, groupId: execution.context.scope.groupId, projectId: execution.project.id }; };
  const project = () => { if (!execution.project) throw new Error("online-project-unavailable"); return execution.project; };
  const context = () => ({ root: editorRoot(), project: locator(), revision: execution.view!.assets.version });
  function assertDatasetContext(input: TestingContext) {
    const current = locator();
    if (input.root !== editorRoot() || input.project.workspaceId !== current.workspaceId || input.project.groupId !== current.groupId || input.project.projectId !== current.projectId) throw new Error("online-session-changed");
  }
  const facade = (): ContractWorkspace => ({ formatVersion: 1, id: locator().workspaceId, name: project().name, variables: {}, groups: [{ id: locator().groupId, name: project().name, default: true, projects: [clone(project())] }] });
  async function change(edit: (draft: ReturnType<typeof project>) => void) {
    if (readOnly()) throw new Error("online-project-read-only");
    const scope = editorRoot(); const draft = clone(project()); edit(draft);
    if (scope !== editorRoot()) throw new Error("online-session-changed");
    await execution.saveProject(ContractProjectSchema.parse(draft));
  }
  function apiEntries() {
    const entries: Array<{ locator: ApiLocator; asset: ApiAsset }> = [];
    for (const collection of project().collections) {
      const visit = (container: ContractCollection | ContractFolder, folders: string[]) => {
        for (const asset of container.apis) entries.push({ locator: { ...locator(), collectionId: collection.id, folderIds: folders, apiId: asset.contract.id }, asset });
        for (const folder of container.folders) visit(folder, [...folders, folder.id]);
      }; visit(collection, []);
    }
    return entries;
  }
  const changeApi = async (id: string, edit: (asset: ApiAsset) => void, expected?: string) => {
    if (expected && expected !== execution.view?.assets.manifestHash) throw new Error("version_conflict");
    await change(draft => {
      let found = 0;
      const visit = (container: ContractCollection | ContractFolder) => { for (const asset of container.apis) if (asset.contract.id === id) { edit(asset); found++; } for (const folder of container.folders) visit(folder); };
      for (const collection of draft.collections) visit(collection);
      if (found !== 1) throw new Error("api-not-found");
    });
  };
  const credentialAction = async (action: "put" | "remove" | "status", ref: import("@apicc/core").SecretRef, value?: string) => {
    if (!execution.context) throw new Error("online-project-unavailable");
    const raw = await api.onlineExecution({ operation: "credential", context: clone(execution.context), action, ref, contractProjectId: project().id, storage: execution.localOnlyRefIds.includes(ref.id) ? "local" : "project", ...(value === undefined ? {} : { value }) });
    return action === "status" ? CredentialStatusResultSchema.parse(raw) : CredentialMutationResultSchema.parse(raw);
  };
  function testingView(): TestingAssets { return { context: context(), readOnly: readOnly(), datasets: clone(project().datasets ?? []), suites: clone(project().suites ?? []), environments: project().environments.map(({ id, name }) => ({ id, name })), collections: project().collections.map(({ id, name }) => ({ id, name })), workflows: project().workflows.map(({ id, name, status }) => ({ id, name, status })), cases: apiEntries().flatMap(({ locator, asset }) => asset.cases.map(item => ({ locator, caseId: item.id, name: item.name, scopes: [item.scope], tags: item.tags ?? [] }))) }; }
  const operations: Partial<ApiccApi> = {
    onlineExecution: input => api.onlineExecution(input),
    importDataset: async input => {
      assertDatasetContext(input.context);
      if (!execution.context) throw new Error("online-session-changed");
      const captured = editorRoot(); const revision = execution.view!.assets.version;
      const result = await api.onlineExecution({ context: clone(execution.context), operation: "datasetImport", content: input.content, format: input.format });
      if (captured !== editorRoot() || revision !== execution.view?.assets.version) throw new Error("online-session-changed");
      return OnlineDatasetContentSchema.parse(result);
    },
    exportDataset: async input => {
      assertDatasetContext(input.context);
      const current = locator();
      if (!execution.context || input.locator.workspaceId !== current.workspaceId || input.locator.groupId !== current.groupId || input.locator.projectId !== current.projectId) throw new Error("online-session-changed");
      const captured = editorRoot(); const revision = execution.view!.assets.version;
      const result = await api.onlineExecution({ context: clone(execution.context), operation: "datasetExport", datasetId: input.locator.datasetId, format: input.format });
      if (captured !== editorRoot() || revision !== execution.view?.assets.version) throw new Error("online-session-changed");
      return z.string().parse(result);
    },
    treeGet: async () => toTreeNode(facade()),
    globalsGet: async () => ({ variables: clone(project().variables), ...clone(project().globals) }),
    globalsSave: async (_locator, globals) => { await change(draft => { draft.variables = clone(globals.variables); const { variables: _variables, ...params } = globals; draft.globals = params; }); return globals; },
    envCreate: async input => { const env = { id: crypto.randomUUID(), name: input.name, variables: {}, baseUrls: {}, ...(input.extends ? { extends: input.extends } : {}) }; await change(draft => { draft.environments.push(env); }); return env; },
    envVarsSave: async (where, variables) => { await change(draft => { const env = draft.environments.find(env => env.id === where.environmentId); if (!env) throw new Error("environment-not-found"); env.variables = clone(variables); }); return clone(project().environments.find(env => env.id === where.environmentId)!); },
    envBaseUrlsSave: async (where, baseUrls) => { await change(draft => { const env = draft.environments.find(env => env.id === where.environmentId); if (!env) throw new Error("environment-not-found"); env.baseUrls = clone(baseUrls); }); return clone(project().environments.find(env => env.id === where.environmentId)!); },
    nodeDelete: async input => { if (input.kind !== "environment") throw new Error("online-editor-operation-unavailable"); await change(draft => { draft.environments = draft.environments.filter(env => env.id !== input.locator.environmentId); }); },
    listTestingAssets: async () => testingView(), assertionOperators: () => api.assertionOperators(),
    saveDataset: async input => { const asset = DatasetAssetSchema.parse(input.asset); await change(draft => { draft.datasets = [...(draft.datasets ?? []).filter(item => item.id !== asset.id), asset]; }); return testingView(); },
    saveSuite: async input => { const asset = SuiteAssetSchema.parse(input.asset); await change(draft => { draft.suites = [...(draft.suites ?? []).filter(item => item.id !== asset.id), asset]; }); return testingView(); },
    deleteTestingAsset: async input => { const target = input.target; await change(draft => { if (target.kind === "dataset") draft.datasets = draft.datasets?.filter(item => item.id !== target.locator.datasetId); else draft.suites = draft.suites?.filter(item => item.id !== target.locator.suiteId); }); return testingView(); },
    wfList: async () => project().workflows.map(workflow => ({ id: workflow.id, name: workflow.name, status: workflow.status, locator: { ...locator(), workflowId: workflow.id } })),
    wfGet: async where => { const workflow = project().workflows.find(item => item.id === where.workflowId); if (!workflow) throw new Error("workflow-not-found"); return { workflow: clone(workflow), locator: where }; },
    wfCreate: async input => { const workflow = WorkflowSchema.parse({ id: crypto.randomUUID(), name: input.name, status: "draft", ...(input.executionVersion === 2 ? { executionVersion: 2, inputs: {}, outputs: {} } : {}), nodes: [], edges: [] }); await change(draft => { draft.workflows.push(workflow); }); return workflow; },
    wfSave: async (where, value) => { const workflow = WorkflowSchema.parse(value); await change(draft => { const index = draft.workflows.findIndex(item => item.id === where.workflowId); if (index < 0 || workflow.id !== where.workflowId) throw new Error("workflow-not-found"); draft.workflows[index] = workflow; }); return clone(workflow); },
    wfSetStatus: async (where, status) => { await change(draft => { const workflow = draft.workflows.find(item => item.id === where.workflowId); if (!workflow) throw new Error("workflow-not-found"); workflow.status = status; }); return { workflow: clone(project().workflows.find(item => item.id === where.workflowId)!), errors: [], warnings: [] }; },
    wfDelete: async where => { await change(draft => { draft.workflows = draft.workflows.filter(item => item.id !== where.workflowId); }); },
    apiGet: async where => { const found = apiEntries().find(entry => entry.asset.contract.id === where.apiId); if (!found) throw new Error("api-not-found"); return { api: clone(found.asset), locator: where, envs: project().environments.map(env => ({ id: env.id, name: env.name, locator: { ...locator(), environmentId: env.id } })), sourceApiRevision: execution.view!.assets.manifestHash, sourceProjectRevision: execution.view!.assets.manifestHash } satisfies ApiDetail; },
    apiSave: async (where, asset, expected) => { await changeApi(where.apiId, current => Object.assign(current, clone(asset)), expected); return { api: clone(asset), sourceApiRevision: execution.view!.assets.manifestHash, sourceProjectRevision: execution.view!.assets.manifestHash }; },
    caseDraftSave: async (where, value, expected, deletes) => { await changeApi(where.apiId, asset => { asset.cases = asset.cases.filter(item => !(deletes ?? []).some(deleted => deleted.caseId === item.id && deleted.scope === item.scope) && !(item.id === value.id && item.scope === value.scope)); asset.cases.push(clone(value)); }, expected); return { testCase: clone(value), sourceApiRevision: execution.view!.assets.manifestHash }; },
    credentialStatus: async input => CredentialStatusResultSchema.parse(await credentialAction("status", input.ref)),
    credentialPut: async input => CredentialMutationResultSchema.parse(await credentialAction("put", input.ref, input.value)),
    credentialRemove: async input => CredentialMutationResultSchema.parse(await credentialAction("remove", input.ref)),
  };
  const bridge = new Proxy({} as ApiccApi, { get: (_target, name: keyof ApiccApi) => operations[name] ?? (async () => { throw new Error("online-editor-operation-unavailable"); }) });
  const workspace = useWorkspaceStore(bridge);
  const getContext = () => ({ root: editorRoot(), readOnly: readOnly() });
  const envs = useEnvsStore(bridge, getContext);
  const testing = createTestingStore(bridge, { confirmDiscard, getActive: () => execution.project ? { ...getContext(), project: locator() } : null });
  const workflowDesign = useWorkflowDesignStore(bridge, getContext); const wfList = useWfListStore(bridge, getContext);
  const editor = useEditorStore(bridge, getContext); const cases = useCasesStore(bridge, editor);
  const stop = watch(() => [editorRoot(), execution.view?.assets.version, execution.project !== null, readOnly()], () => {
    if (!execution.project) { workspace.reset(); return; }
    workspace.root = editorRoot(); workspace.opened = true; workspace.readOnly = readOnly();
    (workspace as unknown as { workspace: ContractWorkspace | null }).workspace = facade(); workspace.name = project().name;
    const tree = toTreeNode(facade()); if (tree.kind === "root") workspace.tree = tree;
    void envs.load(locator()).catch(error => { execution.error = error.message; });
    void testing.activate(editorRoot(), locator(), readOnly()).catch(error => { execution.error = error.message; });
    void wfList.load(editorRoot(), locator()).catch(error => { execution.error = error.message; });
  }, { immediate: true });
  return { bridge, workspace, envs, testing, workflowDesign, wfList, editor, cases, locator, editorRoot, apiEntries, stop };
}

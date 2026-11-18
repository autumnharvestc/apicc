import { watch } from "vue";
import { ContractProjectSchema, DatasetAssetSchema, SuiteAssetSchema, WorkflowSchema } from "@apicc/core/schema";
import type { ContractWorkspace, ContractProject, ContractCollection, ContractFolder, ApiAsset, Workflow } from "@apicc/core";
import { findProjectSaveApi, sameProjectSaveValue, type ProjectApiTarget } from "@apicc/core/collaboration/project-save";
import type { ApiccApi, ApiDetail } from "../../../shared/types.js";
import type { TestingAssets, TestingContext } from "../../../shared/testing.js";
import type { ApiLocator } from "../../../shared/locations.js";
import { toTreeNode } from "../../../main/tree.js"; // Pure DTO projection shared with the main process.
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
import { apiSessionKey } from "./localIdentity.js";

/** Reuses the existing business editors. Every mutation is captured against the explicit
 * online scope/version and saved with the atomic assets API. The renderer-only root key
 * distinguishes editor sessions; it is never a filesystem path or an IPC local-session input. */
export function createOnlineProjectAdapter(execution: OnlineExecutionStore, api: ApiccApi, readOnly: () => boolean, confirmDiscard: () => boolean) {
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const editorRoot = () => execution.context ? `online:${JSON.stringify(execution.context)}` : "";
  const locator = () => { if (!execution.context || !execution.project) throw new Error("online-project-unavailable"); return { workspaceId: execution.context.scope.workspaceId, groupId: execution.context.scope.groupId, projectId: execution.project.id }; };
  const project = () => { if (!execution.project) throw new Error("online-project-unavailable"); return execution.project; };
  const confirmed = () => {
    const model = execution.confirmedProject();
    if (!model) throw new Error("online-project-unavailable");
    return model;
  };
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
  const apiTarget = (where: ApiLocator): ProjectApiTarget => ({ collectionId: where.collectionId, folderIds: [...where.folderIds], apiId: where.apiId });
  const assertApiScope = (where: ApiLocator) => {
    const current = locator();
    if (where.workspaceId !== current.workspaceId || where.groupId !== current.groupId || where.projectId !== current.projectId) throw new Error("online-session-changed");
  };
  async function readBindingApi(where: ApiLocator): Promise<Pick<ApiDetail, "api">> {
    assertApiScope(where);
    const asset = findProjectSaveApi(project(), apiTarget(where));
    if (!asset) throw new Error("api-not-found");
    return { api: asset };
  }
  const apiBaselines = new Map<string, { project: ContractProject; version: string }>();
  function captureApi(where: ApiLocator, expected?: string) {
    if (readOnly()) throw new Error("online-project-read-only");
    assertApiScope(where);
    const root = editorRoot(), key = apiSessionKey(root, where);
    const session = editor.sessions[key];
    const target = apiTarget(where);
    const baseline = session ? JSON.parse(session.snapshot) as ApiAsset : findProjectSaveApi(confirmed(), target);
    if (!baseline || session && expected && expected !== session.sourceApiRevision) throw new Error("version_conflict");
    return { key, session, target, baseline, version: apiBaselines.get(key)?.version ?? execution.view!.assets.version,
      project: apiBaselines.get(key)?.project ?? confirmed() };
  }
  const workflowReceipts = new Map<string, { signature: string; workflow: Workflow }>();
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
    wfCreate: async input => {
      if (readOnly()) throw new Error("online-project-read-only");
      const root = editorRoot();
      if (!sameProjectSaveValue(input.locator, locator())) throw new Error("online-session-changed");
      const signature = JSON.stringify([input.name, input.executionVersion]);
      const prior = workflowReceipts.get(root);
      if (prior?.signature === signature) { workflowReceipts.delete(root); return clone(prior.workflow); }
      const workflow = WorkflowSchema.parse({ id: crypto.randomUUID(), name: input.name, status: "draft",
        ...(input.executionVersion === 2 ? { executionVersion: 2, inputs: {}, outputs: {} } : {}), nodes: [], edges: [] });
      const saved = await execution.saveAssetEdit({ kind: "workflow-create", workflow }, confirmed(), "workflow-create", workflow.name,
        () => workflowReceipts.set(root, { signature, workflow }));
      if (!saved) throw new Error("online-save-feedback");
      workflowReceipts.delete(root);
      return workflow;
    },
    wfSave: async (where, value) => { const workflow = WorkflowSchema.parse(value); await change(draft => { const index = draft.workflows.findIndex(item => item.id === where.workflowId); if (index < 0 || workflow.id !== where.workflowId) throw new Error("workflow-not-found"); draft.workflows[index] = workflow; }); return clone(workflow); },
    wfSetStatus: async (where, status) => { await change(draft => { const workflow = draft.workflows.find(item => item.id === where.workflowId); if (!workflow) throw new Error("workflow-not-found"); workflow.status = status; }); return { workflow: clone(project().workflows.find(item => item.id === where.workflowId)!), errors: [], warnings: [] }; },
    wfDelete: async where => { await change(draft => { draft.workflows = draft.workflows.filter(item => item.id !== where.workflowId); }); },
    apiGet: async where => {
      assertApiScope(where);
      const root = editorRoot();
      await execution.checkForUpdates();
      if (root !== editorRoot()) throw new Error("online-session-changed");
      assertApiScope(where);
      const latest = execution.editorProject(true);
      const baseline = latest?.project ?? confirmed();
      const asset = findProjectSaveApi(baseline, apiTarget(where));
      if (!asset) throw new Error("api-not-found");
      const view = latest?.view ?? execution.view!;
      apiBaselines.set(apiSessionKey(root, where), { project: baseline, version: view.assets.version });
      return { api: clone(asset), locator: where, envs: project().environments.map(env => ({ id: env.id, name: env.name, locator: { ...locator(), environmentId: env.id } })),
        sourceApiRevision: view.assets.manifestHash, sourceProjectRevision: view.assets.manifestHash } satisfies ApiDetail;
    },
    apiSave: async (where, asset, expected) => {
      const fixed = captureApi(where, expected);
      const submitted = clone(asset);
      const saved = await execution.saveAssetEdit({ kind: "api", target: fixed.target, baseline: fixed.baseline, submitted },
        fixed.project, JSON.stringify(["api", fixed.target]), fixed.baseline.contract.metadata.name, receipt => {
          const original = editor.sessions[fixed.key];
          if (original && original === fixed.session) {
            original.snapshot = JSON.stringify({ ...submitted, cases: (JSON.parse(original.snapshot) as ApiAsset).cases });
            original.sourceApiRevision = receipt.assets.manifestHash;
            original.sourceProjectRevision = receipt.assets.manifestHash;
            apiBaselines.set(fixed.key, { project: fixed.project, version: receipt.assets.version });
          }
        }, fixed.version);
      if (!saved) throw new Error("online-save-feedback");
      return { api: submitted, sourceApiRevision: saved.assets.manifestHash, sourceProjectRevision: saved.assets.manifestHash };
    },
    caseDraftSave: async (where, value, expected, deletes) => {
      const fixed = captureApi(where, expected);
      const matches = (item: { id: string; scope: string }, target: { caseId: string; scope: string }) => item.id === target.caseId && item.scope === target.scope;
      const baseline = fixed.baseline.cases.find(item => matches(item, where)) ?? null;
      if (value.id !== where.caseId || value.scope !== where.scope) throw new Error("api-not-found");
      const explicit = (deletes ?? []).flatMap(item => {
        const deleted = fixed.baseline.cases.find(candidate => matches(candidate, item));
        return deleted ? [{ ...item, baseline: deleted }] : [];
      });
      if (explicit.length !== (deletes?.length ?? 0)) throw new Error("version_conflict");
      const submitted = clone(value);
      const previousScopes = fixed.session?.api.cases.filter(item => item.id === value.id).map(item => item.scope) ?? [];
      const saved = await execution.saveAssetEdit({ kind: "case", target: fixed.target, baseline, baselineRequest: fixed.baseline.contract.request,
        submitted, deletes: explicit }, fixed.project, JSON.stringify(["case", fixed.target, value.id]), value.name, receipt => {
        const original = editor.sessions[fixed.key];
        if (!original || original !== fixed.session) return;
        const asset = JSON.parse(original.snapshot) as ApiAsset;
        asset.cases = asset.cases.filter(item => !explicit.some(deleted => matches(item, deleted)));
        const index = asset.cases.findIndex(item => matches(item, where));
        if (index < 0) asset.cases.push(submitted); else asset.cases[index] = submitted;
        original.snapshot = JSON.stringify(asset);
        original.sourceApiRevision = receipt.assets.manifestHash;
        cases.preserveEditsAfterCaseConfirmation(fixed.key, original.generation, { caseId: where.caseId, scope: where.scope }, previousScopes);
        apiBaselines.set(fixed.key, { project: fixed.project, version: receipt.assets.version });
      }, fixed.version);
      if (!saved) throw new Error("online-save-feedback");
      return { testCase: submitted, sourceApiRevision: saved.assets.manifestHash };
    },
    credentialStatus: async input => CredentialStatusResultSchema.parse(await credentialAction("status", input.ref)),
    credentialPut: async input => CredentialMutationResultSchema.parse(await credentialAction("put", input.ref, input.value)),
    credentialRemove: async input => CredentialMutationResultSchema.parse(await credentialAction("remove", input.ref)),
  };
  const bridge = new Proxy({} as ApiccApi, {
    get(target, name: keyof ApiccApi) {
      if (Object.hasOwn(operations, name)) return operations[name];
      // Framework reflection (including promise detection) must see an ordinary object.
      if (!(name in api)) return Reflect.get(target, name);
      return async () => { throw new Error("online-editor-operation-unavailable"); };
    },
  });
  const workspace = useWorkspaceStore(bridge);
  const getContext = () => ({ root: editorRoot(), readOnly: readOnly() });
  const envs = useEnvsStore(bridge, getContext);
  const testing = createTestingStore(bridge, { confirmDiscard, getActive: () => execution.project ? { ...getContext(), project: locator() } : null });
  const workflowDesign = useWorkflowDesignStore(bridge, getContext); const wfList = useWfListStore(bridge, getContext);
  const editor = useEditorStore(bridge, getContext); const cases = useCasesStore(bridge, editor);
  const stop = watch(() => [editorRoot(), execution.project, readOnly()], () => {
    const root = editorRoot();
    if (editor.activeKey && editor.sessions[editor.activeKey]?.root !== root) editor.activeKey = null;
    if (!execution.project) { workspace.reset(); return; }
    workspace.root = editorRoot(); workspace.opened = true; workspace.readOnly = readOnly();
    (workspace as unknown as { workspace: ContractWorkspace | null }).workspace = facade(); workspace.name = project().name;
    const tree = toTreeNode(facade()); if (tree.kind === "root") workspace.tree = tree;
    const reportCurrentError = (error: Error) => { if (root === editorRoot()) execution.error = error.message; };
    void envs.load(locator()).catch(reportCurrentError);
    void testing.activate(root, locator(), readOnly()).catch(reportCurrentError);
    void wfList.load(root, locator()).catch(reportCurrentError);
  }, { immediate: true });
  const stopRebase = watch(() => execution.appliedUpdate, () => {
    if (!execution.project || !execution.view) return;
    const root = editorRoot(), baseline = confirmed(), view = execution.view;
    for (const [key, session] of Object.entries(editor.sessions)) {
      if (session.root !== root || JSON.stringify(session.api) !== session.snapshot
          || cases.diskDraftUnits(key, session.generation).length || cases.pendingDeletes[key]?.length) continue;
      const asset = findProjectSaveApi(baseline, apiTarget(session.locator));
      if (!asset) { delete editor.sessions[key]; if (editor.activeKey === key) editor.activeKey = null; continue; }
      session.api = clone(asset); session.snapshot = JSON.stringify(session.api);
      session.sourceApiRevision = view.assets.manifestHash; session.sourceProjectRevision = view.assets.manifestHash;
      session.envs = baseline.environments.map(env => ({ id: env.id, name: env.name, locator: { ...locator(), environmentId: env.id } }));
      apiBaselines.set(key, { project: baseline, version: view.assets.version });
    }
  });
  return { bridge, workspace, envs, testing, workflowDesign, wfList, editor, cases, locator, editorRoot, apiEntries, readBindingApi,
    stop: () => { stop(); stopRebase(); } };
}

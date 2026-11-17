import { createProjectAssetContext } from "@apicc/core/assets/context";
import { findProjectSaveApi } from "@apicc/core/collaboration/project-save";
import { findProjectApi, workflowCalls } from "@apicc/core/workflow/references";
import type { ApiAsset, ContractFolder, ContractProject, ContractWorkspace, SuiteAsset, Workflow } from "@apicc/core";
import type { ProjectLocator } from "./locations.js";
import { workspaceRequestDependencies } from "./workspace-api-dependencies.js";

export function localTestingDependencies(workspace: ContractWorkspace, project: ContractProject | undefined, locator: ProjectLocator,
  workflow?: Workflow, suite?: SuiteAsset): unknown {
  if (!project) return null;
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const workflows = new Map<string, unknown>();
  const apis = new Map<string, unknown>();
  const addApi = (apiId: string, exact?: { collectionId: string; folderIds: string[] }) => {
    const located = exact ? { api: findProjectSaveApi(project, { ...exact, apiId }), collection: { id: exact.collectionId },
      folders: exact.folderIds.map(id => ({ id })) } : findProjectApi(project, apiId);
    if (!located?.api) { apis.set(JSON.stringify([exact, apiId]), null); return; }
    const where = { ...locator, collectionId: located.collection.id, folderIds: located.folders.map(item => item.id), apiId };
    const closure = createProjectAssetContext({ projectId: project.id, assets: [copy(located.api)] as ApiAsset[],
      models: copy(project.models), components: copy(project.components), datasets: copy(project.datasets ?? []) }).dependencyClosure(apiId);
    apis.set(JSON.stringify(where), [located.api, closure, workspaceRequestDependencies(workspace, where)]);
  };
  const visitWorkflow = (item: Workflow | undefined, id: string) => {
    if (workflows.has(id)) return;
    workflows.set(id, item ?? null);
    if (!item) return;
    for (const node of item.nodes) {
      if (node.kind === "request" && node.apiId) addApi(node.apiId);
      for (const call of workflowCalls(node)) visitWorkflow(project.workflows.find(value => value.id === call.workflowId), call.workflowId);
    }
  };
  if (workflow) visitWorkflow(workflow, workflow.id);
  const selection = suite?.selection;
  if (selection?.kind === "explicit") {
    for (const entry of selection.entries) {
      if (entry.kind === "case") addApi(entry.apiId, entry);
      else visitWorkflow(project.workflows.find(item => item.id === entry.workflowId), entry.workflowId);
    }
  } else if (selection?.kind === "query") {
    for (const collection of project.collections) {
      if (selection.collectionIds?.length && !selection.collectionIds.includes(collection.id)) continue;
      const walk = (container: typeof collection | ContractFolder, folderIds: string[]) => {
        for (const item of container.apis) if (item.cases.some(row => !selection.caseTags?.length || selection.caseTags.some(tag => row.tags?.includes(tag)))) {
          addApi(item.contract.id, { collectionId: collection.id, folderIds });
        }
        for (const folder of container.folders) walk(folder, [...folderIds, folder.id]);
      };
      walk(collection, []);
    }
  }
  return [workspace.variables, project.variables, project.globals, [...workflows], [...apis],
    suite?.environmentId ? project.environments.find(item => item.id === suite.environmentId) : undefined,
    suite?.datasetId ? project.datasets?.find(item => item.id === suite.datasetId) : undefined];
}

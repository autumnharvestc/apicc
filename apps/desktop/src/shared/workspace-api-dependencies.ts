import { projectSaveDependencies } from "@apicc/core/collaboration/project-save";
import type { ApiRequest, ApiTestCase, ContractCollection, ContractFolder, ContractWorkspace } from "@apicc/core";
import type { ApiLocator, ProjectLocator } from "./locations.js";

function findProject(workspace: ContractWorkspace, locator: ProjectLocator) {
  if (workspace.id !== locator.workspaceId) return;
  return workspace.groups.find(group => group.id === locator.groupId)?.projects.find(project => project.id === locator.projectId);
}

export function workspaceEnvironmentDependencies(workspace: ContractWorkspace, locator: ProjectLocator, id: string,
  editedUrls?: Record<string, string>): unknown {
  const project = findProject(workspace, locator);
  const current = project?.environments.find(item => item.id === id);
  if (!project || !current) return null;
  const parents = [];
  const visited = new Set([current.name]);
  let name = current.extends;
  while (name && !visited.has(name)) {
    visited.add(name);
    const parent = project.environments.find(item => item.name === name);
    parents.push(parent ?? name);
    name = parent?.extends;
  }
  const urls = editedUrls && [...new Set([...Object.keys(current.baseUrls), ...Object.keys(editedUrls)])].sort()
    .filter(key => (current.baseUrls[key] ?? "").trim() !== (editedUrls[key] ?? "").trim())
    .map(key => [key, project.collections.some(item => item.id === key)]);
  return [workspace.variables, project.variables, project.globals, parents, urls];
}

/** The default request may run under any environment and every enclosing operation list. */
export function workspaceRequestDependencies(workspace: ContractWorkspace, locator: ApiLocator): unknown {
  const project = findProject(workspace, locator);
  const collection = project?.collections.find(item => item.id === locator.collectionId);
  if (!project || !collection) return null;
  const chain: Array<ContractCollection | ContractFolder> = [collection];
  for (const id of locator.folderIds) {
    const folder = chain.at(-1)?.folders.find(item => item.id === id);
    if (!folder) return null;
    chain.push(folder);
  }
  return { workspace: workspace.variables, project: project.variables, globals: project.globals, module: collection.variables,
    operations: chain.map(item => [item.preOperations, item.postOperations]),
    environments: project.environments.map(({ id, name, extends: parent, variables, baseUrls }) => ({
      id, name, parent, variables, baseUrl: baseUrls[locator.collectionId],
    })).sort((left, right) => left.id.localeCompare(right.id)) };
}

export function workspaceCaseDependencies(workspace: ContractWorkspace, locator: ApiLocator,
  baselineRequest: ApiRequest, baseline: ApiTestCase | null, submitted: ApiTestCase): unknown {
  const project = findProject(workspace, locator);
  if (!project) return null;
  return [workspace.variables, projectSaveDependencies(project, { kind: "case", target: locator, baselineRequest, baseline, submitted, deletes: [] })];
}

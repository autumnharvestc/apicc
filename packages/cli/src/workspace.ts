import type {
  ApiAsset,
  Collection,
  Group,
  LoadProblem,
  Project,
  Workflow,
  Workspace,
  WorkspaceLoadState,
} from "@apicc/core";
import type { PluginRegistry } from "@apicc/core";

export interface ApiLocation {
  api: ApiAsset;
  apiPath: string;
  group: Group;
  project: Project;
  collection: Collection;
  folderIds: readonly string[];
}

export interface CollectionLocation {
  collection: Collection;
  collectionPath: string;
  group: Group;
  project: Project;
}

export interface WorkflowLocation {
  workflow: Workflow;
  workflowPath: string;
  group: Group;
  project: Project;
}

export type LoadedWorkspace = WorkspaceLoadState<Workspace>;

export async function loadWorkspace(registry: PluginRegistry, root: string): Promise<LoadedWorkspace> {
  const storage = registry.getStorage();
  if (!storage) throw new Error("未注册存储适配器");
  return storage.load(root);
}

export function workspaceProblemsMessage(problems: readonly LoadProblem[]): string {
  return problems.map((problem) => `${problem.file}: ${problem.message}`).join("; ");
}

export function assertWorkspaceUsable(state: LoadedWorkspace): void {
  if (state.readOnly || state.problems.length > 0) {
    const detail = workspaceProblemsMessage(state.problems);
    throw new Error(`工作区存在格式或资产问题，当前只读${detail ? `：${detail}` : ""}`);
  }
}

export function normalizeWorkspaceRelativePath(input: string): string {
  const path = input.replaceAll("\\", "/");
  const segments = path.split("/");
  if (!path || path.startsWith("/") || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes(":"))) {
    throw new Error(`接口或资产路径必须是工作区内的完整 UUID 相对路径: ${input}`);
  }
  return path;
}

export function locateApi(workspace: Workspace, inputPath: string): ApiLocation {
  const target = normalizeWorkspaceRelativePath(inputPath);
  for (const group of workspace.groups) {
    for (const project of group.projects) {
      for (const collection of project.collections) {
        for (const api of collection.apis) {
          const apiPath = formatApiPath(group.id, project.id, collection.id, [], api.contract.id);
          if (apiPath === target) return { api, apiPath, group, project, collection, folderIds: [] };
        }
        const nested = locateFolderApi(group, project, collection, collection.folders, [], target);
        if (nested) return nested;
      }
    }
  }
  throw new Error(`未找到接口: ${inputPath}`);
}

function locateFolderApi(
  group: Group,
  project: Project,
  collection: Collection,
  folders: Workspace["groups"][number]["projects"][number]["collections"][number]["folders"],
  ancestors: readonly string[],
  target: string,
): ApiLocation | undefined {
  for (const folder of folders) {
    const folderIds = [...ancestors, folder.id];
    for (const api of folder.apis) {
      const apiPath = formatApiPath(group.id, project.id, collection.id, folderIds, api.contract.id);
      if (apiPath === target) return { api, apiPath, group, project, collection, folderIds };
    }
    const nested = locateFolderApi(group, project, collection, folder.folders, folderIds, target);
    if (nested) return nested;
  }
  return undefined;
}

export function listApiLocations(workspace: Workspace): ApiLocation[] {
  const results: ApiLocation[] = [];
  for (const group of workspace.groups) {
    for (const project of group.projects) {
      for (const collection of project.collections) {
        for (const api of collection.apis) {
          results.push({
            api,
            apiPath: formatApiPath(group.id, project.id, collection.id, [], api.contract.id),
            group,
            project,
            collection,
            folderIds: [],
          });
        }
        collectFolderApis(results, group, project, collection, collection.folders, []);
      }
    }
  }
  return results;
}

function collectFolderApis(
  results: ApiLocation[],
  group: Group,
  project: Project,
  collection: Collection,
  folders: Workspace["groups"][number]["projects"][number]["collections"][number]["folders"],
  ancestors: readonly string[],
): void {
  for (const folder of folders) {
    const folderIds = [...ancestors, folder.id];
    for (const api of folder.apis) {
      results.push({
        api,
        apiPath: formatApiPath(group.id, project.id, collection.id, folderIds, api.contract.id),
        group,
        project,
        collection,
        folderIds,
      });
    }
    collectFolderApis(results, group, project, collection, folder.folders, folderIds);
  }
}

export function locateCollection(workspace: Workspace, inputPath: string): CollectionLocation {
  const target = normalizeWorkspaceRelativePath(inputPath);
  for (const group of workspace.groups) {
    for (const project of group.projects) {
      for (const collection of project.collections) {
        const collectionPath = `groups/${group.id}/projects/${project.id}/collections/${collection.id}`;
        if (collectionPath === target) return { collection, collectionPath, group, project };
      }
    }
  }
  throw new Error(`未找到集合: ${inputPath}`);
}

export function locateWorkflow(workspace: Workspace, inputPath: string): WorkflowLocation {
  const target = normalizeWorkspaceRelativePath(inputPath);
  for (const group of workspace.groups) {
    for (const project of group.projects) {
      for (const workflow of project.workflows) {
        const workflowPath = `groups/${group.id}/projects/${project.id}/workflows/${workflow.id}`;
        if (workflowPath === target) return { workflow, workflowPath, group, project };
      }
    }
  }
  throw new Error(`未找到工作流: ${inputPath}`);
}

export function locateProject(workspace: Workspace, inputPath: string): { group: Group; project: Project } {
  const target = normalizeWorkspaceRelativePath(inputPath);
  for (const group of workspace.groups) {
    for (const project of group.projects) {
      if (`groups/${group.id}/projects/${project.id}` === target) return { group, project };
    }
  }
  throw new Error(`未找到项目: ${inputPath}`);
}

export function formatApiPath(groupId: string, projectId: string, collectionId: string, folderIds: readonly string[], apiId: string): string {
  return ["groups", groupId, "projects", projectId, "collections", collectionId,
    ...folderIds.flatMap((id) => ["folders", id]), "apis", apiId].join("/");
}

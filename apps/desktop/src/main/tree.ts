import type { ApiAsset, ContractCollection, ContractFolder, ContractProject, ContractWorkspace } from "@apicc/core";
import type { ApiLocator, CollectionLocator, FolderLocator, GroupLocator, ProjectLocator, WorkflowLocator, WorkspaceLocator } from "../shared/locations.js";
import { localTreeNodeKey, type LocalTreeNodeDTO, type TreeNodeDTO } from "../shared/tree-dto.js";

export type { TreeNodeDTO };

function apiNode(locator: ApiLocator, asset: ApiAsset): LocalTreeNodeDTO {
  const identity = { source: "local" as const, kind: "api" as const, locator };
  const protocol = asset.contract.request.protocol;
  const method = protocol === "soap" ? "POST" : protocol === "http" ? asset.contract.request.method : undefined;
  return {
    ...identity,
    id: asset.contract.id,
    key: localTreeNodeKey(identity),
    label: asset.contract.metadata.name,
    protocol,
    ...(method === undefined ? {} : { method }),
  };
}

function folderNode(
  locator: Omit<FolderLocator, "folderIds"> & { folderIds: string[] },
  folder: ContractFolder,
): LocalTreeNodeDTO {
  const typedLocator: FolderLocator = { ...locator, folderIds: [...locator.folderIds] };
  const identity = { source: "local" as const, kind: "folder" as const, locator: typedLocator };
  return {
    ...identity,
    id: folder.id,
    key: localTreeNodeKey(identity),
    label: folder.name,
    children: [
      ...folder.apis.map((asset) => apiNode({ ...typedLocator, apiId: asset.contract.id }, asset)),
      ...folder.folders.map((child) => folderNode({ ...typedLocator, folderIds: [...typedLocator.folderIds, child.id] }, child)),
    ],
  };
}

function collectionNode(locator: ProjectLocator, collection: ContractCollection): LocalTreeNodeDTO {
  const typedLocator: CollectionLocator = { ...locator, collectionId: collection.id };
  const identity = { source: "local" as const, kind: "collection" as const, locator: typedLocator };
  return {
    ...identity,
    id: collection.id,
    key: localTreeNodeKey(identity),
    label: collection.name,
    children: [
      ...collection.apis.map((asset) => apiNode({ ...typedLocator, folderIds: [], apiId: asset.contract.id }, asset)),
      ...collection.folders.map((folder) => folderNode({ ...typedLocator, folderIds: [folder.id] }, folder)),
    ],
  };
}

function projectNode(locator: ProjectLocator, project: ContractProject): LocalTreeNodeDTO {
  const identity = { source: "local" as const, kind: "project" as const, locator };
  return {
    ...identity,
    id: project.id,
    key: localTreeNodeKey(identity),
    label: project.name,
    ...(project.stressPolicy === undefined ? {} : { stressPolicy: structuredClone(project.stressPolicy) }),
    envs: project.environments.map((environment) => {
      const environmentLocator = { ...locator, environmentId: environment.id };
      const environmentIdentity = { source: "local" as const, kind: "environment" as const, locator: environmentLocator };
      return {
        source: "local" as const,
        key: localTreeNodeKey(environmentIdentity),
        id: environment.id,
        name: environment.name,
        ...(environment.extends === undefined ? {} : { extends: environment.extends }),
        variables: structuredClone(environment.variables),
        ...(environment.baseUrls === undefined ? {} : { baseUrls: structuredClone(environment.baseUrls) }),
        locator: environmentLocator,
      };
    }),
    workflows: project.workflows.map((workflow) => {
      const workflowLocator: WorkflowLocator = { ...locator, workflowId: workflow.id };
      const workflowIdentity = { source: "local" as const, kind: "workflow" as const, locator: workflowLocator };
      return {
        source: "local" as const,
        key: localTreeNodeKey(workflowIdentity),
        id: workflow.id,
        name: workflow.name,
        status: workflow.status,
        locator: workflowLocator,
      };
    }),
    children: project.collections.map((collection) => collectionNode(locator, collection)),
  };
}

export function toTreeNode(workspace: ContractWorkspace): LocalTreeNodeDTO {
  const workspaceLocator: WorkspaceLocator = { workspaceId: workspace.id };
  const rootIdentity = { source: "local" as const, kind: "root" as const, locator: workspaceLocator };
  return {
    ...rootIdentity,
    id: workspace.id,
    key: localTreeNodeKey(rootIdentity),
    label: workspace.name,
    children: workspace.groups.map((group) => {
      const groupLocator: GroupLocator = { ...workspaceLocator, groupId: group.id };
      const groupIdentity = { source: "local" as const, kind: "group" as const, locator: groupLocator };
      return {
        ...groupIdentity,
        id: group.id,
        key: localTreeNodeKey(groupIdentity),
        label: group.name,
        children: group.projects.map((project) => projectNode({ ...groupLocator, projectId: project.id }, project)),
      };
    }),
  };
}

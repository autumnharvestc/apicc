import type { StressTargetPolicy, WorkflowStatus } from "@apicc/core";
import type { OnlineProjectRole } from "./online/contract.js";
import type {
  ApiLocator,
  CollectionLocator,
  EnvironmentLocator,
  FolderLocator,
  GroupLocator,
  ProjectLocator,
  WorkflowLocator,
  WorkspaceLocator,
} from "./locations.js";

export type LocalTreeKind = "root" | "group" | "project" | "collection" | "folder" | "api" | "workflow" | "environment";
export type OnlineTreeKind = "root" | "group" | "project" | "collection" | "folder" | "api" | "file";

interface LocalBase<K extends LocalTreeKind, L> {
  source: "local";
  kind: K;
  id: string;
  key: string;
  label: string;
  locator: L;
  children?: LocalTreeNodeDTO[];
}

export interface LocalRootTreeNodeDTO extends LocalBase<"root", WorkspaceLocator> {
  children: LocalTreeNodeDTO[];
}

export interface LocalGroupTreeNodeDTO extends LocalBase<"group", GroupLocator> {
  children: LocalTreeNodeDTO[];
}

export interface LocalEnvironmentSummaryDTO {
  source: "local";
  key: string;
  id: string;
  name: string;
  extends?: string;
  variables: Record<string, string>;
  baseUrls?: Record<string, string>;
  locator: EnvironmentLocator;
}

export interface LocalWorkflowSummaryDTO {
  source: "local";
  key: string;
  id: string;
  name: string;
  status: WorkflowStatus;
  locator: WorkflowLocator;
}

export interface LocalProjectTreeNodeDTO extends LocalBase<"project", ProjectLocator> {
  stressPolicy?: StressTargetPolicy;
  envs: LocalEnvironmentSummaryDTO[];
  workflows: LocalWorkflowSummaryDTO[];
  children: LocalTreeNodeDTO[];
}

export interface LocalCollectionTreeNodeDTO extends LocalBase<"collection", CollectionLocator> {
  children: LocalTreeNodeDTO[];
}

export interface LocalFolderTreeNodeDTO extends LocalBase<"folder", FolderLocator> {
  children: LocalTreeNodeDTO[];
}

export interface LocalApiTreeNodeDTO extends LocalBase<"api", ApiLocator> {
  protocol: "http" | "websocket" | "soap";
  method?: string;
}

export interface LocalWorkflowTreeNodeDTO extends LocalBase<"workflow", WorkflowLocator> {
  status: WorkflowStatus;
}

export type LocalTreeNodeDTO =
  | LocalRootTreeNodeDTO
  | LocalGroupTreeNodeDTO
  | LocalProjectTreeNodeDTO
  | LocalCollectionTreeNodeDTO
  | LocalFolderTreeNodeDTO
  | LocalApiTreeNodeDTO
  | LocalWorkflowTreeNodeDTO;

export type LocalTreeIdentity =
  | { source: "local"; kind: "root"; locator: WorkspaceLocator }
  | { source: "local"; kind: "group"; locator: GroupLocator }
  | { source: "local"; kind: "project"; locator: ProjectLocator }
  | { source: "local"; kind: "collection"; locator: CollectionLocator }
  | { source: "local"; kind: "folder"; locator: FolderLocator }
  | { source: "local"; kind: "api"; locator: ApiLocator }
  | { source: "local"; kind: "environment"; locator: EnvironmentLocator }
  | { source: "local"; kind: "workflow"; locator: WorkflowLocator };

export interface OnlineTreeNodeDTO {
  source: "online";
  kind: OnlineTreeKind;
  id: string;
  key: string;
  label: string;
  method?: string;
  myRole?: OnlineProjectRole;
  children?: OnlineTreeNodeDTO[];
}

export type TreeNodeDTO = LocalTreeNodeDTO | OnlineTreeNodeDTO;

/** Stable UI identity encoded from locator fields in a fixed order. */
export function localTreeNodeKey(node: LocalTreeIdentity): string {
  switch (node.kind) {
    case "root":
      return JSON.stringify([node.source, node.kind, node.locator.workspaceId]);
    case "group":
      return JSON.stringify([node.source, node.kind, node.locator.workspaceId, node.locator.groupId]);
    case "project":
      return JSON.stringify([node.source, node.kind, node.locator.workspaceId, node.locator.groupId, node.locator.projectId]);
    case "collection":
      return JSON.stringify([node.source, node.kind, node.locator.workspaceId, node.locator.groupId, node.locator.projectId, node.locator.collectionId]);
    case "folder":
      return JSON.stringify([node.source, node.kind, node.locator.workspaceId, node.locator.groupId, node.locator.projectId, node.locator.collectionId, ...node.locator.folderIds]);
    case "api":
      return JSON.stringify([node.source, node.kind, node.locator.workspaceId, node.locator.groupId, node.locator.projectId, node.locator.collectionId, ...node.locator.folderIds, node.locator.apiId]);
    case "workflow":
      return JSON.stringify([node.source, node.kind, node.locator.workspaceId, node.locator.groupId, node.locator.projectId, node.locator.workflowId]);
    case "environment":
      return JSON.stringify([node.source, node.kind, node.locator.workspaceId, node.locator.groupId, node.locator.projectId, node.locator.environmentId]);
  }
}

export function onlineTreeNodeKey(workspaceId: string, kind: OnlineTreeKind, id: string): string {
  return JSON.stringify(["online", workspaceId, kind, id]);
}

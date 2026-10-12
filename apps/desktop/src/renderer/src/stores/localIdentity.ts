import type { ApiLocator, ProjectLocator } from "../../../shared/locations.js";

export interface LocalWorkspaceContext {
  root: string;
  readOnly: boolean;
}

export function projectSessionKey(root: string, locator: ProjectLocator): string {
  return JSON.stringify([
    "local",
    root,
    locator.workspaceId,
    locator.groupId,
    locator.projectId,
  ]);
}

export function apiSessionKey(root: string, locator: ApiLocator): string {
  return JSON.stringify([
    "local",
    root,
    locator.workspaceId,
    locator.groupId,
    locator.projectId,
    locator.collectionId,
    [...locator.folderIds],
    locator.apiId,
  ]);
}

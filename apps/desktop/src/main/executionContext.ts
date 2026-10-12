import type { ApiAsset, Environment, ProjectSnapshot } from "@apicc/core";
import { join } from "node:path";
import type { ApiLocator } from "../shared/locations.js";

/** Runtime-neutral helpers for resolving execution data from an immutable snapshot. */
export function workspaceRunsDir(root: string): string {
  return join(root, ".apicc", "runs");
}

export function findSnapshotApi(snapshot: ProjectSnapshot, locator: ApiLocator): ApiAsset {
  const collection = snapshot.project.collections.find((candidate) => candidate.id === locator.collectionId);
  if (!collection) throw new Error(`未找到集合: ${locator.collectionId}`);
  let folders = collection.folders;
  let container: typeof collection | (typeof folders)[number] = collection;
  for (const folderId of locator.folderIds) {
    const folder = folders.find((candidate) => candidate.id === folderId);
    if (!folder) throw new Error(`未找到接口: ${JSON.stringify(locator)}`);
    container = folder;
    folders = folder.folders;
  }
  const asset = container.apis.find((candidate) => candidate.contract.id === locator.apiId);
  if (!asset) throw new Error(`未找到接口: ${JSON.stringify(locator)}`);
  return asset as ApiAsset;
}

export function resolveSnapshotEnvironment(
  project: ProjectSnapshot["project"],
  envName: string | null | undefined,
): Environment | undefined {
  if (!envName) return undefined;
  const environment = project.environments.find((candidate) => candidate.name === envName);
  if (!environment) throw new Error(`未找到环境: ${envName}`);
  return environment as Environment;
}

import { prepareTestData, testDataSelectionsForRequests, type ApiAsset, type Environment, type ProjectSnapshot, type ProjectExecutionRun, type CredentialRequestSelection } from "@apicc/core";
import { join, resolve } from "node:path";
import type { ApiLocator } from "../shared/locations.js";

/** One selected data capture per host invocation, before any runner/VU is dispatched. */
export async function prepareDesktopTestData<T extends { run: ProjectExecutionRun }>(prepared: T, selections: readonly CredentialRequestSelection[], workspaceRoot: string, environmentId?: string): Promise<T> {
  const snapshot = prepared.run.snapshot;
  const preparedTestData = await prepareTestData(snapshot, testDataSelectionsForRequests(snapshot, selections, environmentId), { workspaceRoot });
  return { ...prepared, run: { ...prepared.run, preparedTestData } };
}

/** Runtime-neutral helpers for resolving execution data from an immutable snapshot. */
export function workspaceRunsDir(root: string): string {
  return join(root, ".apicc", "runs");
}

/** Stable owner key for the in-memory HTTP cookie jar; it never crosses IPC or disk. */
export function debugHttpSessionKey(root: string, locator: Pick<ApiLocator, "workspaceId" | "groupId" | "projectId">, environmentId?: string): string {
  return JSON.stringify([resolve(root), locator.workspaceId, locator.groupId, locator.projectId, environmentId ?? null]);
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

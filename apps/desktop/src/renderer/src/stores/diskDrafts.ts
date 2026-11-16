import type { ApiAsset, ContractProject, ContractWorkspace } from "@apicc/core";
import type { ApiLocator, ProjectLocator } from "../../../shared/locations.js";
import type { LocalWorkspaceFailure } from "../../../shared/workspace-refresh.js";

export type DiskDraftReason = "changed" | "deleted" | "unverified";
export interface DiskDraftConflict {
  reason: DiskDraftReason;
  name: string;
  restore?: () => void;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonical(record[key])]));
  }
  return value;
}

export function sameDiskValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

export function jsonCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function diskProject(workspace: ContractWorkspace, locator: ProjectLocator): ContractProject | undefined {
  if (workspace.id !== locator.workspaceId) return;
  return workspace.groups.find((group) => group.id === locator.groupId)?.projects.find((project) => project.id === locator.projectId);
}

export function diskApi(project: ContractProject | undefined, locator: ApiLocator): ApiAsset | undefined {
  let container = project?.collections.find((collection) => collection.id === locator.collectionId) as Pick<ContractProject["collections"][number], "apis" | "folders"> | undefined;
  for (const folderId of locator.folderIds) container = container?.folders.find((folder) => folder.id === folderId);
  return container?.apis.find((asset) => asset.contract.id === locator.apiId);
}

export function isRefreshableFailure(failure: LocalWorkspaceFailure): boolean {
  return failure.reason === "revision-conflict" || failure.reason === "busy" || failure.reason === "unstable";
}

/** A view requested before refresh may arrive after the new disk version was
 * published. While its navigation is current, read from the new version. */
export async function currentDiskRead<T>(read: () => Promise<T>, readEpoch: () => number, current: () => boolean): Promise<T | undefined> {
  while (current()) {
    const epoch = readEpoch();
    try {
      const value = await read();
      if (current() && epoch === readEpoch()) return value;
    } catch (error) {
      if (!current()) return;
      if (epoch === readEpoch()) throw error;
    }
  }
}

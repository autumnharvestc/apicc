import { decodeContractProjectFiles, encodeContractProjectFiles, type ContractProject } from "@apicc/core";
import { ProjectAssetsSchema, type ProjectAssets, type AssetDelta } from "@apicc/execution/contract";
import type { OnlineExecutionContext, OnlineProjectView } from "../../shared/online/execution.js";

export function assertAssetsScope(assets: ProjectAssets, context: OnlineExecutionContext) {
  if (assets.workspaceId !== context.scope.workspaceId || assets.groupId !== context.scope.groupId || assets.projectId !== context.scope.projectId) throw new Error("online-project-scope-mismatch");
}
export const isBlankOnlineProject = (assets: ProjectAssets) => assets.version === "0" && assets.format === null
  && assets.contractProjectId === null && assets.files.length === 0;
export async function readOnlineProject(raw: unknown, context: OnlineExecutionContext): Promise<OnlineProjectView> {
  const assets = ProjectAssetsSchema.parse(raw); assertAssetsScope(assets, context);
  if (assets.format !== "contract-files-v1") return { assets, project: null,
    problems: isBlankOnlineProject(assets) ? [] : ["legacy-format-publish-new-project"] };
  const decoded = await decodeContractProjectFiles(new Map(assets.files.map(file => [file.path, file.content])));
  if (decoded.project?.id !== assets.contractProjectId) return { assets, project: null, problems: ["contract-project-identity-mismatch"] };
  return { assets, project: !decoded.readOnly && !decoded.problems.length ? decoded.project ?? null : null, problems: decoded.problems.map(problem => `${problem.file}: ${problem.message}`) };
}
export function onlineProjectDelta(project: ContractProject, assets: ProjectAssets): AssetDelta {
  if (assets.format !== "contract-files-v1" || assets.contractProjectId !== project.id) throw new Error("legacy-format-read-only");
  const files = encodeContractProjectFiles(project).files; const previous = new Map(assets.files.map(file => [file.path, file.content]));
  return { format: "contract-files-v1", contractProjectId: project.id, expectedVersion: assets.version, changes: [...files].filter(([path, content]) => previous.get(path) !== content).map(([path, content]) => ({ path, content })), deletes: [...previous.keys()].filter(path => !files.has(path)) };
}

export function initialOnlineProjectDelta(project: ContractProject): AssetDelta {
  return { format: "contract-files-v1", contractProjectId: project.id, expectedVersion: "0",
    changes: [...encodeContractProjectFiles(project).files].map(([path, content]) => ({ path, content })), deletes: [] };
}

/** Directory operations add files or change a container manifest. Preserve the bytes of other assets. */
export function onlineDirectoryDelta(project: ContractProject, before: OnlineProjectView): AssetDelta {
  if (isBlankOnlineProject(before.assets)) return initialOnlineProjectDelta(project);
  if (!before.project || before.assets.contractProjectId !== project.id || before.project.id !== project.id) throw new Error("legacy-format-read-only");
  const baseline = encodeContractProjectFiles(before.project).files;
  const next = encodeContractProjectFiles(project).files;
  return { format: "contract-files-v1", contractProjectId: project.id, expectedVersion: before.assets.version,
    changes: [...next].filter(([path, content]) => baseline.get(path) !== content).map(([path, content]) => ({ path, content })), deletes: [] };
}

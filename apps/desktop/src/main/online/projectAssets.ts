import { decodeContractProjectFiles, encodeContractProjectFiles, type ContractProject } from "@apicc/core";
import { ProjectAssetsSchema, type ProjectAssets, type AssetDelta } from "@apicc/execution/contract";
import type { OnlineExecutionContext, OnlineProjectView } from "../../shared/online/execution.js";

export function assertAssetsScope(assets: ProjectAssets, context: OnlineExecutionContext) {
  if (assets.workspaceId !== context.scope.workspaceId || assets.groupId !== context.scope.groupId || assets.projectId !== context.scope.projectId) throw new Error("online-project-scope-mismatch");
}
export async function readOnlineProject(raw: unknown, context: OnlineExecutionContext): Promise<OnlineProjectView> {
  const assets = ProjectAssetsSchema.parse(raw); assertAssetsScope(assets, context);
  if (assets.format !== "contract-files-v1") return { assets, project: null, problems: ["legacy-format-publish-new-project"] };
  const decoded = await decodeContractProjectFiles(new Map(assets.files.map(file => [file.path, file.content])));
  if (decoded.project?.id !== assets.contractProjectId) return { assets, project: null, problems: ["contract-project-identity-mismatch"] };
  return { assets, project: !decoded.readOnly && !decoded.problems.length ? decoded.project ?? null : null, problems: decoded.problems.map(problem => `${problem.file}: ${problem.message}`) };
}
export function onlineProjectDelta(project: ContractProject, assets: ProjectAssets): AssetDelta {
  if (assets.format !== "contract-files-v1" || assets.contractProjectId !== project.id) throw new Error("legacy-format-read-only");
  const files = encodeContractProjectFiles(project).files; const previous = new Map(assets.files.map(file => [file.path, file.content]));
  return { format: "contract-files-v1", contractProjectId: project.id, expectedVersion: assets.version, changes: [...files].filter(([path, content]) => previous.get(path) !== content).map(([path, content]) => ({ path, content })), deletes: [...previous.keys()].filter(path => !files.has(path)) };
}

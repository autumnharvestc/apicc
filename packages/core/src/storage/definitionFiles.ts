import type { ContractWorkspace } from "../contract/workspace.js";
import { encodeContractWorkspace } from "./contractFiles.js";
import { listSyncManagedFiles } from "../sync/storage.js";

/** Lists the canonical definition paths emitted by Core's workspace encoder. */
export function listContractWorkspaceDefinitionFiles(workspace: ContractWorkspace): readonly string[] {
  return Object.freeze([...encodeContractWorkspace(workspace).files.keys()]);
}

/** Private managed paths are for local deletion only; public projections use the
 * business-only synchronous definition list above. Content bytes stay lazy. */
export async function listContractWorkspaceManagedFiles(root: string, workspace: ContractWorkspace): Promise<readonly string[]> {
  const files = [...listContractWorkspaceDefinitionFiles(workspace)];
  for (const group of workspace.groups) for (const project of group.projects) {
    files.push(...await listSyncManagedFiles(root, { groupId: group.id, projectId: project.id }));
  }
  return Object.freeze(files);
}

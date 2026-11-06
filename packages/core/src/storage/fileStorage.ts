import { commitWritePlan } from "./writeJournal.js";
import { decodeContractWorkspace, encodeContractWorkspace } from "./contractFiles.js";
import type { Workspace } from "../domain/model.js";
import type { StorageAdapter } from "../plugin/types.js";
import { listContractWorkspaceManagedFiles } from "./definitionFiles.js";
import { projectDirectoryPath } from "./paths.js";

/** File-backed storage delegates the contract, recovery, revision, and journal rules to Task 4. */
export const fileStorage: StorageAdapter = {
  load(root) {
    return decodeContractWorkspace(root);
  },

  async save(root, workspace: Workspace, options) {
    const deletions = new Set(options.deletions);
    if (options.expectedRevision !== "empty") {
      const previous = await decodeContractWorkspace(root);
      const retained = new Set(workspace.groups.flatMap(g => g.projects.map(p => projectDirectoryPath(g.id, p.id))));
      const removed = previous.workspace.groups.flatMap(g => g.projects.filter(p => !retained.has(projectDirectoryPath(g.id, p.id))).map(p => `${projectDirectoryPath(g.id, p.id)}/`));
      if (removed.length) for (const file of await listContractWorkspaceManagedFiles(root, previous.workspace)) {
        if (removed.some(prefix => file.startsWith(prefix))) deletions.add(file);
      }
    }
    return commitWritePlan(root, encodeContractWorkspace(workspace), { ...options, deletions: [...deletions] });
  },
};

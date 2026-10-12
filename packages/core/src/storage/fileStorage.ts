import { commitWritePlan } from "./writeJournal.js";
import { decodeContractWorkspace, encodeContractWorkspace } from "./contractFiles.js";
import type { Workspace } from "../domain/model.js";
import type { StorageAdapter } from "../plugin/types.js";

/** File-backed storage delegates the contract, recovery, revision, and journal rules to Task 4. */
export const fileStorage: StorageAdapter = {
  load(root) {
    return decodeContractWorkspace(root);
  },

  save(root, workspace: Workspace, options) {
    return commitWritePlan(root, encodeContractWorkspace(workspace), options);
  },
};

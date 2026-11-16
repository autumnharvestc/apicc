import type { ApiccApi } from "../../shared/types.js";
import { LocalWorkspaceError, localWorkspaceError } from "../../shared/workspace-refresh.js";

const writes = new Set<string>([
  "apiSave", "apiRequestDraftSave", "apiCreateFromRequestDraft", "caseSave", "caseDraftSave", "caseDelete",
  "globalsSave", "envVarsSave", "envBaseUrlsSave", "envCreate", "wfSave", "wfSetStatus", "wfCreate", "wfDelete",
  "saveDataset", "saveSuite", "deleteTestingAsset", "nodeCreate", "nodeDelete", "nodeRename", "importApply", "importUndo",
]);

/** Keep the editing controls available during reconciliation, while draft
 * submissions still belong to the version the user saw before refresh. */
export function guardLocalDiskWrites(api: ApiccApi, pending: () => boolean) {
  let count = 0;
  return {
    get writing() { return count > 0; },
    api: new Proxy(api, {
      get(target, key) {
        const method = Reflect.get(target, key) as unknown;
        if (typeof key !== "string" || !writes.has(key) || typeof method !== "function") return method;
        return async (...args: unknown[]) => {
          if (pending()) throw localWorkspaceError("busy", "A disk refresh is in progress.");
          count++;
          try { return await method.apply(target, args); }
          finally { count--; }
        };
      },
    }),
  };
}

export function diskErrorMessage(error: unknown, translate: (key: string) => string): string {
  if (error instanceof LocalWorkspaceError) return translate(`diskRefresh.error.${error.failure.reason}`);
  const message = error instanceof Error ? error.message : String(error);
  if (message === "disk-draft-blocked") return translate("diskRefresh.blocked");
  return message;
}

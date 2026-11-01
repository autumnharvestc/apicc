import type { DeepReadonly, ProjectSnapshot } from "../assets/snapshot.js";
import type { ApiRequest } from "../contract/model.js";
import { selectCredentialRequests, type CredentialRequestSelection } from "../credentials/output.js";
import type { ExecutableRequest } from "../plugin/types.js";
import { resolveRequestSettings, type RequestSettingsOverride } from "../request/settings.js";
import { captureRequestFiles, HttpFileError, type CapturedRequestFiles, type CapturedRequestFileOwner } from "./files.js";

/** Host-only selected file ownership; borrowed runtime bindings never own the parent handles. */
export interface PreparedRequestFiles {
  assertUnchanged(): Promise<void>;
  borrow(definition: DeepReadonly<ApiRequest>, runtime: ExecutableRequest, uploadLimitBytes: number): Promise<CapturedRequestFiles>;
  close(): Promise<void>;
}

export async function prepareRequestFiles(
  snapshot: ProjectSnapshot,
  selections: readonly CredentialRequestSelection[],
  options: { workspaceRoot: string; requestSettings?: RequestSettingsOverride; signal?: AbortSignal },
): Promise<PreparedRequestFiles> {
  const selected = selectCredentialRequests(snapshot, selections);
  const records = new WeakMap<DeepReadonly<ApiRequest>, CapturedRequestFileOwner>();
  const owners: CapturedRequestFileOwner[] = [];
  try {
    for (let index = 0; index < selections.length; index++) {
      options.signal?.throwIfAborted();
      const request = selected[index]!.request;
      const settings = resolveRequestSettings(selections[index]!.testCase?.requestSettingsOverride, options.requestSettings);
      const owner = await captureRequestFiles(request, { workspaceRoot: options.workspaceRoot, uploadLimitBytes: settings.uploadLimitBytes });
      owners.push(owner);
      // Every selection's budget is checked and every owner retained, even for shared definitions.
      if (!records.has(request)) records.set(request, owner);
    }
    options.signal?.throwIfAborted();
  } catch (error) { await Promise.allSettled(owners.map(owner => owner.close())); throw error; }
  let closing: Promise<void> | undefined;
  const assertOpen = () => { if (closing) throw new HttpFileError("Prepared request files are closed.", "FILE_SOURCE_NOT_REPLAYABLE"); };
  return {
    async assertUnchanged() { assertOpen(); for (const owner of owners) await owner.assertUnchanged(); },
    async borrow(definition, runtime, uploadLimitBytes) {
      assertOpen();
      const owner = records.get(definition);
      if (!owner) throw new HttpFileError("The request does not own prepared file bindings.", "FILE_SOURCE_NOT_REPLAYABLE");
      return owner.borrow(runtime, uploadLimitBytes);
    },
    close() {
      closing ??= (async () => {
        const results = await Promise.allSettled(owners.map(owner => owner.close()));
        const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (rejected) throw rejected.reason;
      })();
      return closing;
    },
  };
}

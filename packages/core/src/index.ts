import { createSystemSecretStore as createInternalSystemSecretStore } from "./credentials/systemStore.js";
import type { SecretStore as SecretStoreContract } from "./credentials/types.js";

export * from "./shared.js";

// Node-only debugger execution service; browser consumers get DTOs from shared.js.
export { prepareDebugExecution, runDebugExecution, abortedDebugResult, failedDebugResult, getSourceApiRevision } from "./debug/service.js";
export type { DebugExecutionPlan, RunDebugExecutionOptions } from "./debug/service.js";
export { createDebugHistoryOwnerKey, defaultDebugHistoryRoot, createDebugHistoryStore, DebugHistoryStoreError } from "./debug/history.js";
export type { DebugHistoryOwnerIdentity, DebugHistoryStoreOptions, DebugHistoryWriter } from "./debug/history.js";
export { createDebugReplayInvocation, restoreDebugHistoryExchange } from "./debug/replay.js";

// Node-only HTTP runtime ports. Browser consumers resolve `shared.js` instead.
export { createHttpSession } from "./http/session.js";
export type { HttpSession, HttpCookieSummary } from "./http/session.js";
export { captureRequestFiles, HttpFileError } from "./http/files.js";
export type { CapturedFile, CapturedRequestFiles, CaptureRequestFilesOptions } from "./http/files.js";

export function createSystemSecretStore(options: { privateRoot: string }): SecretStoreContract {
  return createInternalSystemSecretStore({ privateRoot: options.privateRoot });
}

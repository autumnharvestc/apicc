import { createSystemSecretStore as createInternalSystemSecretStore } from "./credentials/systemStore.js";
import type { SecretStore as SecretStoreContract } from "./credentials/types.js";

export * from "./shared.js";
export * from "./plugin/executionRegistry.js";
export * from "./runner/scriptRequirements.js";
export { createJsScriptEngine } from "./sandbox/jsEngine.js";
export { loadUserPlugins } from "./plugins/loader.js";
export { createUserPluginHost, createUserPluginHostFromSnapshot, assertPluginRuntimeSnapshot } from "./plugins/runtime.js";
export type { PluginManifest, PluginLoadEntry, PluginLoadResult, PluginLoaderOptions, PluginContributionSummary,
  UserPluginHost, UserPluginBindings, PluginRuntimeEntryV1, PluginRuntimeSnapshotV1 } from "./plugins/types.js";
export * from "./stress/execution.js";
export { runStressSchedule } from "./stress/loadScheduler.js";
export { runStressPlan } from "./stress/plannedRunner.js";
export * from "./stress/workerProtocol.js";
export * from "./stress/localWorker.js";
export { runLocalStressWorkers, createLocalStressWorkerDeps, type LocalStressWorkerOptions } from "./stress/distributed.js";
export { legacyStressMetricPlan } from "./stress/runner.js";
export type { StressRunnerOptions } from "./stress/runner.js";
export { createStressRequestGate } from "./stress/requestGate.js";
export { createStressCaseVuSession } from "./stress/caseSession.js";
export { createStressAccumulator, StressMetricsError } from "./stress/metrics.js";
export type { StressAccumulatorOptions } from "./stress/metrics.js";
export { SuiteRunner, validateSuiteExecution } from "./testing/suiteRunner.js";
export { prepareTestData, parseDatasetContent, validateDatasetTable, bindPreparedTestData, readPreparedCaseData, preparedCaseKey, testDataSelectionsForRequests, TestDataError } from "./testing/data.js";
export { buildImportMergePlan } from "./import/merge.js";
export { deduplicateImportDiagnostics, normalizeImportDiagnostics, projectAssetImportDiagnostics } from "./import/diagnostics.js";
export type {
  ImportExchangeDiagnostic,
  ImportMergeAction,
  ImportMergeDecisions,
  ImportMergeEntry,
  ImportMergeItemDecision,
  ImportMergePlan,
} from "./import/merge.js";
export { generateMockJsonValue } from "./mock/generate.js";
export type { GenerateMockJsonOptions, GenerateMockJsonResult } from "./mock/generate.js";
export { compileProjectMock } from "./mock/compile.js";
export type { CompileProjectMockResult, CompiledMockPlan, CompiledMockRoute, CompiledMockRule, CompiledPathSegment } from "./mock/compile.js";
export { startMockServer, MockServerError } from "./mock/server.js";
export type { MockRequestLog, MockServerHandle, MockServerState, StartMockServerOptions } from "./mock/server.js";
// Node-only assembly from an immutable project snapshot; browser consumers use the DTO schemas in shared.js.
export { buildDocumentProjection } from "./design/projection.js";
export { exportOpenapi } from "./design/openapi.js";
export type { OpenapiExportDiagnostic, OpenapiExportOptions, OpenapiExportResult } from "./design/openapi.js";

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

// Network profile schemas/types are browser-safe from shared.js; private storage and prepared secret/certificate material stay Node-only.
export { createFileNetworkProfileStore } from "./network/privateStore.js";
export type { FileNetworkProfileStoreOptions, NetworkProfileStore } from "./network/privateStore.js";
export { prepareNetworkRun, collectNetworkDependencies } from "./network/prepare.js";
export type {
  PrepareNetworkRunOptions,
  PreparedNetworkTLS,
  PreparedNetworkRoute,
  PreparedNetworkResolution,
  PreparedNetworkRun,
} from "./network/prepare.js";
export { defaultNetworkPrivateRoot, createNetworkProfileHost } from "./network/host.js";
export type { NetworkProfileHostOptions, NetworkProfileHost } from "./network/host.js";

// Node-only OAuth profile persistence, SecretStore host operations, and private token exchange.
export { createFileOAuthProfileStore, withOAuthBearerRefLock } from "./oauth/privateStore.js";
export type { FileOAuthProfileStoreOptions, OAuthProfileStore, OAuthBearerRegistration } from "./oauth/privateStore.js";
export { defaultOAuthPrivateRoot, createOAuthProfileHost } from "./oauth/host.js";
export type { OAuthProfileSnapshot } from "./oauth/host.js";
export { createOAuthProfileCoordinator } from "./oauth/coordinator.js";
export type {
  OAuthProfileCoordinatorOptions,
  OAuthProfileCoordinator,
  OAuthCoordinatorExchangeInput,
  PrepareOAuthBearerRefsInput,
  OAuthExplicitGrant,
  ExchangeOAuthProfileInput,
} from "./oauth/coordinator.js";
export type {
  OAuthProfileHostOptions,
  OAuthProfileSaveOptions,
  OAuthProfileExchangeOptions,
  OAuthProfileHost,
  OAuthLockedBearer,
} from "./oauth/host.js";
export { exchangeOAuthToken, createOAuthPkceChallenge } from "./oauth/tokenClient.js";
export type {
  OAuthTokenGrant,
  OAuthTokenSecrets,
  OAuthTokenSet,
  ExchangeOAuthTokenOptions,
} from "./oauth/tokenClient.js";
export { OAuthError } from "./oauth/model.js";
export type {
  OAuthProfileRecord,
  OAuthProfileState,
  OAuthCredentialVersions,
  OAuthProfileDocument,
} from "./oauth/model.js";

export function createSystemSecretStore(options: { privateRoot: string }): SecretStoreContract {
  return createInternalSystemSecretStore({ privateRoot: options.privateRoot });
}
export * from "./testing/model.js";
export * from "./report/evidence.js";
export * from "./testing/references.js";
export * from "./workflow/prepared.js";
export * from "./stress/workflowSession.js";
export { encodeContractProjectFiles, decodeContractProjectFiles, type ContractProjectLoadState } from "./storage/contractFiles.js";
export { apiCaseFilePath, collectionMetadataFilePath, folderMetadataFilePath, projectDirectoryPath } from "./storage/paths.js";

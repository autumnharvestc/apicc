export { version } from "./version.js";
export {
  NetworkScopeSchema,
  NetworkSelectionSchema,
  NetworkProfileSchema,
  NetworkConfigurationSchema,
  emptyNetworkConfiguration,
  NetworkProfileError,
} from "./network/profiles.js";
export type {
  NetworkProjectIdentity,
  NetworkScope,
  NetworkSelection,
  NetworkTLSSettings,
  NetworkTargetTLSBinding,
  DirectNetworkProfile,
  ProxyNetworkProfile,
  NetworkProfile,
  NetworkEnvironmentSelection,
  NetworkConfiguration,
  NetworkProfileErrorCode,
} from "./network/profiles.js";
// Browser-safe profile and status DTOs; token exchange and persistence stay in the Node entry point.
export {
  OAuthProfileSchema,
  OAuthProfileStatusSchema,
  OAuthOperationStatusSchema,
  OAuthProfileSummarySchema,
  OAuthPublicResultSchema,
  OAuthErrorCodeSchema,
} from "./oauth/model.js";
export type {
  OAuthScope,
  OAuthProfile,
  OAuthFlow,
  OAuthClientAuthentication,
  OAuthProfileStatus,
  OAuthOperationStatus,
  OAuthProfileSummary,
  OAuthPublicResult,
  OAuthErrorCode,
} from "./oauth/model.js";
// Browser-safe debugger DTOs; execution services stay in the Node entry point.
export {
  DebugIdentitySchema,
  DebugCaseIdentitySchema,
  DebugProjectIdentitySchema,
  DebugHistoryOwnerIdentitySchema,
  DebugFieldStateSchema,
  DebugInvocationSchema,
  DebugRequestBodySchema,
  DebugResponseBodySchema,
  DebugRequestSchema,
  DebugResponseSchema,
  DebugOutcomeSchema,
  DebugRunSummarySchema,
  DebugReplayDescriptorSchema,
  DebugExchangeSchema,
  DebugResultSchema,
  DebugResultSourceSchema,
  DebugExecutionSourceSchema,
  DebugHistoryPreferencesSchema,
  DebugHistoryRecordSchema,
  DebugHistoryResultFilterSchema,
  DebugHistorySummarySchema,
  DebugHistoryListFilterSchema,
  DebugHistoryDiagnosticSchema,
  DebugHistoryPageSchema,
  DebugHistoryReadResultSchema,
} from "./debug/model.js";
export type {
  DebugIdentity,
  DebugCaseIdentity,
  DebugProjectIdentity,
  DebugFieldState,
  DebugInvocation,
  DebugRequestBody,
  DebugResponseBody,
  DebugRequest,
  DebugResponse,
  DebugOutcome,
  DebugRunSummary,
  DebugReplayDescriptor,
  DebugExchange,
  DebugResult,
  DebugHistoryPreferences,
  DebugHistoryRecord,
  DebugHistoryResultFilter,
  DebugHistorySummary,
  DebugHistoryListFilter,
  DebugHistoryDiagnostic,
  DebugHistoryPage,
  DebugHistoryReadResult,
  DebugExecutionIdentity,
  DebugExecutionSource,
  DebugResultSource,
  DebugHistoryOwnerIdentity,
  DebugRequestOverride,
  DebugRequestValue,
  DebugFailureKind,
} from "./debug/model.js";
export {
  AssertionSchema,
  DataDriverSchema,
  EnvironmentSchema,
  HttpMethodSchema,
  KeyValuePairSchema,
  OperationListSchema,
  OperationSchema,
  ProtocolSchema,
  ProjectGlobalsSchema,
  StressPolicySchema,
  TestCaseSchema,
  ApiAssetSchema,
  ApiContractSchema,
  ApiRequestSchema,
  ApiTestCaseSchema,
  AuthBindingSchema,
  ComponentAssetSchema,
  ExampleBindingSchema,
  InlineAuthBindingSchema,
  ModelAssetSchema,
  ParameterBindingSchema,
  RequestBodySchema,
  ResponseBindingSchema,
  ResponseDefinitionSchema,
  SecretRefSchema,
  JsonValueSchema,
  SchemaNodeSchema,
  ContractCollectionSchema,
  ContractEnvironmentSchema,
  ContractFolderSchema,
  ContractGroupSchema,
  ContractProjectSchema,
  ContractWorkspaceSchema,
  CollectionSchema,
  FolderSchema,
  GroupSchema,
  ProjectSchema,
  WorkspaceSchema,
} from "./domain/model.js";
export type {
  Assertion,
  DataDriver,
  Environment,
  HttpMethod,
  ID,
  KeyValuePair,
  Operation,
  ProjectGlobals,
  Protocol,
  StressPolicy,
  StressTargetPolicy,
  TestCase,
  ApiAsset,
  ApiContract,
  ApiLifecycleStatus,
  ApiMetadata,
  ApiRequest,
  ApiTestCase,
  AuthBinding,
  ComponentAsset,
  ExampleBinding,
  ExampleComponentAsset,
  ExampleDefinition,
  ExampleReference,
  HttpRequest,
  InlineAuthBinding,
  InlineExampleBinding,
  InlineParameter,
  InlineResponse,
  JsonValue,
  LocalFileReference,
  ModelAsset,
  MultipartEntry,
  ParameterBinding,
  ParameterComponentAsset,
  ParameterComponentDefinition,
  ParameterLocation,
  ParameterReference,
  RequestBody,
  ResponseBinding,
  ResponseComponentAsset,
  ResponseContent,
  ResponseDefinition,
  ResponseReference,
  ResponseStatus,
  SchemaAnnotations,
  SchemaNode,
  SecretRef,
  SoapRequest,
  WebSocketRequest,
  ContractCollection,
  ContractFolder,
  ContractGroup,
  ContractProject,
  ContractWorkspace,
  Collection,
  Folder,
  Group,
  Project,
  Workspace,
} from "./domain/model.js";
export { envChain } from "./domain/envChain.js";
export { resolveExecutionEnvironment, selectEffectiveCases } from "./domain/executionSelection.js";
export type { ExecutionEnvironment } from "./domain/executionSelection.js";
export { createEventBus } from "./events/bus.js";
export type { RunEventMap } from "./events/bus.js";
export type {
  ExecutableRequest, ExecutionResponse, HttpExecuteOptions, HttpRuntimeOptions, HttpHopObservation, ProtocolClient, AuthProvider,
  AssertResult, AssertOperator, PmVariables, PmApi, ScriptContext, ScriptEngine, Reporter,
  ImportedProject, ImportDiagnostic, Importer, LoadProblem, StorageSaveOptions, StorageAdapter,
  PluginContext, PluginRegistryApi, PluginDefinition,
} from "./plugin/types.js";
export { createPluginRegistry, type PluginRegistry } from "./plugin/registry.js";
export { loadUserPlugins } from "./plugins/loader.js";
export type {
  PluginManifest, PluginContributionSummary, PluginLoadEntry, PluginLoadResult, PluginLoaderOptions,
} from "./plugins/types.js";
export { fileStorage } from "./storage/fileStorage.js";
export { listContractWorkspaceDefinitionFiles } from "./storage/definitionFiles.js";
export { sanitizeNodeName } from "./storage/sanitize.js";
export { SqliteIndex } from "./storage/sqliteIndex.js";
export type { IndexedObject, IndexedObjectIdentity, IndexedAssetReference } from "./storage/sqliteIndex.js";
export type { WorkspaceLoadState } from "./storage/contractFiles.js";
export { createProjectAssetContext } from "./assets/context.js";
export type {
  AssetBundle, AssetDiagnostic, AssetGate, AssetGateResult, AssetMutationResult, AssetReferenceTarget, DeepReadonly,
  ProjectAssetContext, ProjectAssetContextInput, ProjectAssetContextReadView,
} from "./assets/context.js";
export { createProjectSnapshot } from "./assets/snapshot.js";
export type { ProjectSnapshot } from "./assets/snapshot.js";
export { cloneProjectDefinition, cloneAssetBundle } from "./assets/clone.js";
export type { CloneIdFactory, CloneIdKind, CloneIdMapping, ClonedAssetBundle, ClonedProjectDefinition } from "./assets/clone.js";
export { MockConditionSchema, MockProjectConfigSchema, MockResponseSourceSchema, MockRuleSchema } from "./mock/config.js";
export type { MockCondition, MockDiagnostic, MockProjectConfig, MockResponseSource, MockRule } from "./mock/config.js";
export { rotateProjectSecretRefs, collectDefinedProjectCredentialRefs } from "./assets/secretRefs.js";
export { prepareCredentialBindings } from "./credentials/bindings.js";
export { defaultCredentialPrivateRoot } from "./credentials/host.js";
export type { CredentialScope, CredentialErrorCode, SecretStore, CredentialBindings } from "./credentials/types.js";
export { CredentialError } from "./credentials/types.js";
export {
  selectCredentialRequests,
  collectCredentialRefsForRequests,
  collectBearerCredentialRefsForRequests,
  collectCredentialRefsFromRequestDrafts,
  collectCredentialMarkersForRequests,
  collectProjectCredentialRefs,
  collectCredentialOutputMarkers,
  createCredentialOutputSanitizer,
} from "./credentials/output.js";
export type {
  CredentialOutputSanitizer,
  EffectiveCredentialRequest,
  CredentialRequestSelection,
} from "./credentials/output.js";
export {
  RequestSettingsSchema,
  RequestSettingsOverrideSchema,
  resolveRequestSettings,
  assertRequestSettingsApplicable,
} from "./request/settings.js";
export type { RequestSettings, RequestSettingsOverride } from "./request/settings.js";
export { getEffectiveCaseRequest } from "./request/effective.js";
export { materializeRequest } from "./request/materialize.js";
export type { MaterializeInputs, MaterializedRequest, RuntimeAuth } from "./request/materialize.js";
export { createVariableResolver, CyclicVariableError } from "./variables/resolver.js";
export { withBaseUrl } from "./variables/baseUrl.js";
export { CollectionRunner, CollectionRunError } from "./runner/runner.js";
export type { ProjectExecutionRun, RunnerOptions } from "./runner/runner.js";
export { PreparedTestDataSchema } from "./testing/dataModel.js";
export type { PreparedCaseSelection, PreparedTestData, PreparedDataSource, TestDataDiagnostic } from "./testing/dataModel.js";
export {
  executeCase,
  prepareCaseExecution,
  type CaseExecutionDeps, CaseExecutionInput, CaseExecutionResult, CaseFailureKind, CaseExecutionLocator, PreparedCaseExecution,
} from "./runner/caseExecutor.js";
export { evaluateExtractions, prepareExtractions, createExtractionRuntimeState, extractionVariables, clearExtractionTargets } from "./testing/extraction.js";
export type { ExtractionRuntimeState, ExtractionOutcome, ExtractionBinding, ExtractionBatchResult, PreparedExtractions } from "./testing/extraction.js";
export type { RunResult, CaseOutcome } from "./report/types.js";
export type { SafeExecutionEvidence, EvidenceIdentity, EvidencePreview, ReportingUnitSummary, WorkflowReportingUnit, RequestFacts } from "./report/types.js";
export { reportingUnits, caseReportingIdentity, reportEntryEvidence } from "./report/units.js";
export { renderDesignMarkdown, renderContractMarkdown } from "./design/export.js";
export { DocumentDiagnosticSchema, DocumentProjectionSchema, DocumentScopeSchema } from "./design/projection.js";
export type { DocumentApi, DocumentDiagnostic, DocumentProjection, DocumentScope } from "./design/projection.js";
export { generateRequestSnippet, renderDocumentHtml, renderDocumentMarkdown, RequestSnippetLanguageSchema, RequestSnippetResultSchema } from "./design/document.js";
export type { RequestSnippetLanguage, RequestSnippetResult } from "./design/document.js";
export { htmlReporter } from "./report/html.js";
export { junitReporter } from "./report/junit.js";
export { collectionV21Importer } from "./import/collection21.js";
export { openapiImporter } from "./import/openapi.js";
export { parseCurlRequest, CurlParseError } from "./import/curl.js";
export type { CurlParseResult, CurlBodyDeclaration, CurlDiagnostic, CurlSourcePosition } from "./import/curl.js";
export { curlImporter, parseContractCurl } from "./import/curlImporter.js";
export * from "./workflow/model.js";
export * from "./workflow/predicate.js";
export * from "./workflow/scope.js";
export * from "./workflow/trace.js";
export * from "./workflow/plan.js";
export { validateWorkflowStructure, transitionWorkflowStatus, validateEnablement, type ValidationIssue } from "./workflow/validate.js";
export { workflowImpact, type WorkflowImpactEntry } from "./workflow/impact.js";
export { WorkflowRunner, type WorkflowRunResult, type NodeResult, type NodeState, type NodeSkipReason, type ConditionVerdict, type WorkflowRunnerOptions } from "./workflow/runner.js";
export { findProjectApi, selectWorkflowCollection, type ProjectApiLocation } from "./workflow/references.js";
export { workflowToRunResult } from "./workflow/adapter.js";
export { mergedEnvVars } from "./domain/envChain.js";
export {
  STRESS_FAILURE_KINDS, StressSampleSchema, StressFailureCountsSchema, StressGeneratorSchema,
  StressMeasurementWindowSchema, StressSafetySchema, StressDistributedSchema, StressReportSchema,
  CurrentStressReportSchema,
} from "./stress/model.js";
export type {
  StressFailureKind, StressFailureCounts, StressThresholds, StressViolationMetric, StressViolation,
  StressVerdict, StressMeasurementWindow, StressGeneratorAvailability, StressGeneratorMetrics,
  StressSafetyTarget, StressSafetyRun, StressSafety, StressSample, StressDistributed,
  CurrentStressReport, StressReport,
} from "./stress/model.js";
export { computeReport } from "./stress/aggregate.js";
export { evaluateStressThresholds } from "./stress/thresholds.js";
export { buildStressRequest } from "./stress/build.js";
export {
  assertStressTargetAllowed, normalizeStressOrigin, normalizeStressPolicy, isLoopbackStressOrigin, StressSafetyError,
  type StressSafetyDecision, type StressSafetyErrorCode,
} from "./stress/safety.js";
export { StressRunner, validateStressRunOptions, type StressRunnerOptions, type StressRunOptions } from "./stress/runner.js";
export {
  createGeneratorMetricsCollector,
  createStressGeneratorMetricsCollector,
  createGeneratorCollector,
  DEFAULT_GENERATOR_LIMITS,
  type GeneratorMetricsCollector,
  type GeneratorMetricsProbe,
  type GeneratorCpuUsage,
  type GeneratorCpuUsageMs,
} from "./stress/generatorMetrics.js";
export {
  createStressCaseSession,
  type StressCaseTarget, StressCaseSessionDeps, StressWorkerSession,
} from "./stress/caseSession.js";
export {
  StressWorkerSpecSchema, ShardResultSchema, ShardFailureSchema, ShardOutcomeSchema,
  planShards, mergeStressReport, DistributedStressCoordinator,
  type StressWorkerSpec, type StressWorkerSpecBase, type ShardResult, type ShardFailure,
  type ShardOutcome, type SpawnWorker, type PrivateWorkerControl, type ShardPlan, type DistributedRunOptions, type CoordinatorRunResult,
} from "./stress/distributed.js";
export {
  createAiProvider, AiProviderError, type AiProviderDeps, type AiProviderErrorKind,
} from "./ai/provider.js";
export { suggestCases, AiSuggestError } from "./ai/suggest.js";
export { AI_SUGGEST_SYSTEM_PROMPT, buildSuggestMessages } from "./ai/prompt.js";
export {
  DEFAULT_AI_TIMEOUT_MS, DEFAULT_SUGGEST_LIMIT, AiCaseDraftSchema, AiSuggestOutputSchema,
  type AiProviderConfig, type AiChatMessage, type AiProvider, type AiCaseDraft, type AiSuggestedCase,
  type AiSuggestResult, type AiSuggestOptions,
} from "./ai/types.js";

import { createPluginRegistry, type PluginRegistry } from "./plugin/registry.js";
import { fileStorage } from "./storage/fileStorage.js";
import { createHttpClient, httpClient } from "./http/client.js";
import { wsClient } from "./protocol/websocket.js";
import { createSoapClient, soapClient } from "./protocol/soap.js";
import { builtinAuthProviders } from "./http/auth.js";
// 内置协议客户端与认证器同时对外导出：CLI run-stress 等消费方直接注入 StressRunner，无需绕注册中心取回。
export { createHttpClient, httpClient, wsClient, soapClient, createSoapClient, builtinAuthProviders };
import { builtinAssertOperators } from "./assert/operators.js";
import { jsScriptEngine } from "./sandbox/jsEngine.js";
import { htmlReporter } from "./report/html.js";
import { junitReporter } from "./report/junit.js";
import { collectionV21Importer } from "./import/collection21.js";
import { openapiImporter } from "./import/openapi.js";
import { curlImporter } from "./import/curlImporter.js";

/** 创建注册了全部内置插件的注册中心（内置功能即普通插件，规格 §4）。 */
export function createDefaultRegistry(): PluginRegistry {
  const registry = createPluginRegistry();
  registry.registerStorage(fileStorage);
  registry.registerProtocol(httpClient);
  registry.registerProtocol(wsClient);
  registry.registerProtocol(soapClient);
  for (const p of builtinAuthProviders) registry.registerAuth(p);
  for (const o of builtinAssertOperators) registry.registerAssert(o);
  registry.registerScriptEngine(jsScriptEngine);
  registry.registerReporter(htmlReporter);
  registry.registerReporter(junitReporter);
  registry.registerImporter(collectionV21Importer);
  registry.registerImporter(openapiImporter);
  registry.registerImporter(curlImporter);
  return registry;
}
export * from "./testing/model.js";
export * from "./testing/references.js";
export * from "./testing/selection.js";
export type { SuiteRunResult, SuiteCaseOutcome, SuiteEntryResult, SuiteRunnerOptions } from "./testing/suiteRunner.js";
export { suiteToRunResult } from "./report/suiteAdapter.js";
export { selectResponseValue, validateResponseSelector, AssertionValueError } from "./assert/selection.js";
export type { SelectedResponseValue } from "./assert/selection.js";
export { compileCaseAssertions, evaluateCaseAssertions } from "./assert/evaluate.js";
export type { AssertionOutcome, CompiledAssertion, CompiledCaseAssertions } from "./assert/evaluate.js";
export { compileRegex } from "./assert/regex.js";
export type { CompiledRegex } from "./assert/regex.js";
export type { AssertOperatorDescriptor, AssertEvaluationContext } from "./plugin/types.js";
export { builtinAssertDescriptors } from "./assert/operators.js";

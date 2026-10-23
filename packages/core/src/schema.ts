/** Side-effect-light schema entry point for renderer/preload runtime validation. */
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
} from "./domain/common.js";
export type {
  Assertion,
  DataDriver,
  Environment,
  HttpMethod,
  KeyValuePair,
  Operation,
  ProjectGlobals,
  Protocol,
  StressPolicy,
  TestCase,
} from "./domain/common.js";

export {
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
} from "./contract/model.js";
export type {
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
  SecretRef,
  SoapRequest,
  WebSocketRequest,
} from "./contract/model.js";
export { JsonValueSchema, SchemaNodeSchema, StringRecordSchema } from "./contract/schemaNode.js";
export type { JsonValue, SchemaAnnotations, SchemaNode } from "./contract/schemaNode.js";
export { MockConditionSchema, MockProjectConfigSchema, MockResponseSourceSchema, MockRuleSchema } from "./mock/config.js";
export type { MockCondition, MockDiagnostic, MockProjectConfig, MockResponseSource, MockRule } from "./mock/config.js";
export { DocumentDiagnosticSchema, DocumentProjectionSchema, DocumentScopeSchema } from "./design/projection.js";
export type { DocumentApi, DocumentDiagnostic, DocumentProjection, DocumentScope } from "./design/projection.js";
export { RequestSnippetLanguageSchema, RequestSnippetResultSchema } from "./design/document.js";
export type { RequestSnippetLanguage, RequestSnippetResult } from "./design/document.js";

export {
  NetworkScopeSchema,
  NetworkSelectionSchema,
  NetworkProfileSchema,
  NetworkConfigurationSchema,
  emptyNetworkConfiguration,
} from "./network/profiles.js";
export type {
  NetworkScope,
  NetworkSelection,
  NetworkTLSSettings,
  NetworkTargetTLSBinding,
  DirectNetworkProfile,
  ProxyNetworkProfile,
  NetworkProfile,
  NetworkEnvironmentSelection,
  NetworkConfiguration,
} from "./network/profiles.js";

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
} from "./debug/model.js";

export {
  RequestSettingsSchema,
  RequestSettingsOverrideSchema,
  resolveRequestSettings,
} from "./request/settings.js";
export type { RequestSettings, RequestSettingsOverride } from "./request/settings.js";

export {
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

export {
  StressReportSchema,
  CurrentStressReportSchema,
  StressGeneratorSchema,
  StressSafetySchema,
} from "./stress/model.js";
export type { StressReport, CurrentStressReport } from "./stress/model.js";
export * from "./stress/plan.js";
export * from "./stress/reportV2.js";
export { StressStatisticsSchema, type StressStatistics } from "./stress/model.js";
export * from "./testing/model.js";
export * from "./workflow/model.js";
export * from "./workflow/predicate.js";
export * from "./workflow/scope.js";
export * from "./workflow/trace.js";
export type { AssertOperatorDescriptor } from "./plugin/types.js";
export { builtinAssertDescriptors } from "./assert/operators.js";
export { StressComparisonSchema } from "./stress/compare.js";
export { stressArrivalWindowNotices, type StressArrivalWindowNotice } from "./stress/arrivalWindow.js";

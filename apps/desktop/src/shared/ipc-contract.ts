import { z } from "zod";
import { OnlineExecutionInputSchema } from "./online/execution.js";
import { OnlineSchedulingInputSchema } from './online/scheduling.js';
import { StressPlanSaveInputSchema, StressCompareInputSchema, StressExportInputSchema, StressReportFileSchema } from "./types.js";
import { StressPlanSchema } from "@apicc/core/schema";
import { EvidenceInvocationSchema, TestingReadInputSchema, DatasetSaveInputSchema, SuiteSaveInputSchema, TestingDeleteInputSchema, DatasetExchangeInputSchema, DatasetExportInputSchema, SuiteInvocationSchema } from "./testing.js";
import {
  ApiAssetSchema,
  ApiRequestSchema,
  ApiTestCaseSchema,
  ComponentAssetSchema,
  ContractProjectSchema,
  HttpMethodSchema,
  InlineAuthBindingSchema,
  JsonValueSchema,
  StringRecordSchema,
  KeyValuePairSchema,
  ModelAssetSchema,
  OperationSchema,
  ResponseDefinitionSchema,
  SchemaNodeSchema,
  StressPolicySchema,
  DebugInvocationSchema,
  DebugFieldStateSchema,
  DebugHistoryListFilterSchema,
  DebugHistoryPreferencesSchema,
  WorkflowStatusSchema,
  WorkflowNodeSchema,
  WorkflowEdgeSchema,
  WorkflowSchema,
} from "@apicc/core/schema";
import {
  OnlineBaseUrlSchema,
  OnlineBatchEntrySchema,
  OnlineMappingEntrySchema,
  OnlinePathSchema,
  OnlineRegisterInputSchema,
  OnlineRoleSchema,
} from "./online/contract.js";
import {
  ApiLocatorSchema,
  ApiParentLocatorSchema,
  CaseLocatorSchema,
  CollectionLocatorSchema,
  ComponentLocatorSchema,
  EnvironmentLocatorSchema,
  FolderLocatorSchema,
  GroupLocatorSchema,
  ModelLocatorSchema,
  NodeLocatorSchema,
  ProjectLocatorSchema,
  WorkflowImpactLocatorSchema,
  WorkflowLocatorSchema,
  WorkspaceLocatorSchema,
} from "./locations.js";
import { CredentialPutInputSchema, CredentialRefInputSchema } from "./credentials.js";
import { NetworkProfilesGetInputSchema, NetworkProfilesSaveInputSchema, NetworkSecretImportInputSchema } from "./network.js";
import {
  OAuthAuthorizationBeginInputSchema,
  OAuthAuthorizationSessionIdSchema,
  OAuthProfileActionInputSchema,
  OAuthProfileSaveInputSchema,
  OAuthProfileUnlinkInputSchema,
  OAuthProfilesGetInputSchema,
} from "./oauth.js";
import { IpcChannel, type IpcChannelName } from "./channels.js";
import { DesignExportInputSchema, DesignPreviewInputSchema } from "./design.js";
import {
  MockConfigSaveInputSchema,
  MockControlInputSchema,
  MockProjectCloseInputSchema,
  MockStartInputSchema,
} from "./mock.js";
import type {
  ApiccApi,
  ImportApplyInput,
  ImportPlanInput,
  ImportUndoInput,
  NodeCreateInput,
  StressRunInput,
} from "./types.js";
import type {
  Workflow as CoreWorkflow,
  WorkflowEdge as CoreWorkflowEdge,
  WorkflowNode as CoreWorkflowNode,
  WorkflowStatus as CoreWorkflowStatus,
} from "@apicc/core";

const StringMapSchema = z.record(z.string(), z.string());
type ExactType<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends (<Value>() => Value extends Right ? 1 : 2)
    ? ((<Value>() => Value extends Right ? 1 : 2) extends (<Value>() => Value extends Left ? 1 : 2) ? true : false)
    : false;
type AssertExact<Value extends true> = Value;
export type WorkflowSchemaCoreParity = [
  AssertExact<ExactType<z.input<typeof WorkflowStatusSchema>, z.input<typeof import("@apicc/core").WorkflowStatusSchema>>>,
  AssertExact<ExactType<z.infer<typeof WorkflowStatusSchema>, CoreWorkflowStatus>>,
  AssertExact<ExactType<z.input<typeof WorkflowNodeSchema>, z.input<typeof import("@apicc/core").WorkflowNodeSchema>>>,
  AssertExact<ExactType<z.infer<typeof WorkflowNodeSchema>, CoreWorkflowNode>>,
  AssertExact<ExactType<z.input<typeof WorkflowEdgeSchema>, z.input<typeof import("@apicc/core").WorkflowEdgeSchema>>>,
  AssertExact<ExactType<z.infer<typeof WorkflowEdgeSchema>, CoreWorkflowEdge>>,
  AssertExact<ExactType<z.input<typeof WorkflowSchema>, z.input<typeof import("@apicc/core").WorkflowSchema>>>,
  AssertExact<ExactType<z.infer<typeof WorkflowSchema>, CoreWorkflow>>,
];
const CreateApiInputSchema = z.object({
  name: z.string(),
  protocol: z.enum(["http", "websocket", "soap"]).optional(),
  method: HttpMethodSchema.optional(),
  baseUrl: z.string().optional(),
  path: z.string().optional(),
}).strict();
const NodeCreateInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("group"), parent: WorkspaceLocatorSchema, name: z.string() }).strict(),
  z.object({ kind: z.literal("project"), parent: GroupLocatorSchema, name: z.string() }).strict(),
  z.object({ kind: z.literal("collection"), parent: ProjectLocatorSchema, name: z.string() }).strict(),
  z.object({ kind: z.literal("folder"), parent: ApiParentLocatorSchema, name: z.string() }).strict(),
  z.object({ kind: z.literal("api"), parent: ApiParentLocatorSchema, api: CreateApiInputSchema }).strict(),
]);
const EnvCreateInputSchema = z.object({
  locator: ProjectLocatorSchema,
  name: z.string(),
  extends: z.string().nullish(),
  variables: StringMapSchema.optional(),
  baseUrls: StringMapSchema.optional(),
}).strict();
const ProjectGlobalSettingsSchema = z.object({
  variables: StringMapSchema,
  query: z.array(KeyValuePairSchema),
  headers: z.array(KeyValuePairSchema),
  cookies: z.array(KeyValuePairSchema),
  body: z.array(KeyValuePairSchema),
}).strict();
const ContainerOperationsSchema = z.object({
  preOperations: z.array(OperationSchema),
  postOperations: z.array(OperationSchema),
}).strict();
const ContainerTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("collection"), locator: CollectionLocatorSchema }).strict(),
  z.object({ kind: z.literal("folder"), locator: FolderLocatorSchema }).strict(),
]);
const ContainerSaveInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("collection"), locator: CollectionLocatorSchema, operations: ContainerOperationsSchema.extend({ variables: StringMapSchema }).strict() }).strict(),
  z.object({ kind: z.literal("folder"), locator: FolderLocatorSchema, operations: ContainerOperationsSchema }).strict(),
]);
const CreateModelInputSchema = z.object({ name: z.string(), description: z.string(), schema: SchemaNodeSchema }).strict();
const CreateComponentInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("parameter"), name: z.string(), description: z.string(),
    definition: z.object({ location: z.enum(["path", "query", "header", "cookie"]), name: z.string(), schema: SchemaNodeSchema, required: z.boolean(), description: z.string() }).strict(),
  }).strict(),
  z.object({ kind: z.literal("auth"), name: z.string(), description: z.string(), definition: InlineAuthBindingSchema }).strict(),
  z.object({ kind: z.literal("response"), name: z.string(), description: z.string(), definition: ResponseDefinitionSchema }).strict(),
  z.object({ kind: z.literal("example"), name: z.string(), description: z.string(), definition: z.object({ name: z.string(), value: JsonValueSchema }).strict() }).strict(),
]);
const StressThresholdsSchema = z.object({
  maxErrorRate: z.number().finite().min(0).max(1).optional(),
  maxAssertionFailureRate: z.number().finite().min(0).max(1).optional(),
  maxP95Ms: z.number().finite().positive().optional(),
  minRps: z.number().finite().positive().optional(),
}).strict();
const StressOriginSchema = z.string().superRefine((value, ctx) => {
  try {
    const parsed = new URL(value);
    const authority = value.slice(value.indexOf("://") + 3);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash
      || !/^[^/?#\s]+\/?$/.test(authority)) throw new Error("invalid origin");
  } catch {
    ctx.addIssue({ code: "custom", message: "必须是无路径、查询、片段和用户信息的 HTTP(S) origin" });
  }
}).transform((value) => {
  const parsed = new URL(value);
  return parsed.origin;
});
const StressOriginListSchema = z.array(StressOriginSchema).transform((values) => [...new Set(values)]);
const LegacyStressRunInputSchema = z.object({
  locator: ApiLocatorSchema,
  caseId: z.string(),
  envName: z.string().nullish(),
  concurrency: z.number().finite().int().positive().safe(),
  maxIterations: z.number().finite().int().positive().safe().nullish(),
  durationMs: z.number().finite().positive().max(Number.MAX_SAFE_INTEGER).nullish(),
  thresholds: StressThresholdsSchema.optional(),
  connectionMode: z.enum(["pooled", "fresh"]).optional(),
  confirmedTargetOrigins: StressOriginListSchema.optional(),
}).strict();
const StressRunInputSchema = z.union([LegacyStressRunInputSchema, z.object({ kind: z.literal("plan"), root: z.string().min(1), invocationId: z.string().uuid(), projectLocator: ProjectLocatorSchema, plan: StressPlanSchema, confirmedTargetOrigins: StressOriginListSchema.optional() }).strict()]);
const ImportPreviewInputSchema = z.object({ fileName: z.string(), content: z.string() }).strict();
const ImportPlanInputSchema = z.discriminatedUnion("mode", [
  z.object({ previewToken: z.string().uuid(), mode: z.literal("project"), target: GroupLocatorSchema, name: z.string() }).strict(),
  z.object({ previewToken: z.string().uuid(), mode: z.literal("module"), target: ProjectLocatorSchema, name: z.string(), sourceEnvironmentOptionToken: z.string().min(1).optional() }).strict(),
  z.object({
    previewToken: z.string().uuid(), mode: z.literal("merge"), target: CollectionLocatorSchema,
    sourceCollectionIds: z.array(z.string()).min(1),
    decisions: z.record(z.string(), z.object({ action: z.enum(["skip", "rename", "overwrite", "cancel"]), targetApiId: z.string().optional(), name: z.string().optional() }).strict()),
  }).strict(),
]);
const ImportApplyInputSchema = z.object({ planToken: z.string().uuid(), allowLossy: z.boolean() }).strict();
const ImportUndoInputSchema = z.object({ undoToken: z.string().uuid() }).strict();
const OnlineWorkspaceIdSchema = z.object({ workspaceId: z.string().min(1) }).strict();
const OnlineWorkspaceOpenSchema = z.object({ workspaceId: z.string().min(1), name: z.string().min(1), myRole: OnlineRoleSchema }).strict();
const OnlineFilesGetSchema = z.object({ workspaceId: z.string().min(1), paths: z.array(z.string()).min(1).max(200) }).strict();
const OnlineFilePutSchema = z.object({ workspaceId: z.string().min(1), path: OnlinePathSchema, content: z.string(), baseVersion: z.number().int().nonnegative() }).strict();
const OnlineFilesBatchSchema = z.object({ workspaceId: z.string().min(1), files: z.array(OnlineBatchEntrySchema.strict()).min(1).max(200) }).strict();
const OnlineFileDeleteSchema = z.object({ workspaceId: z.string().min(1), path: OnlinePathSchema, baseVersion: z.number().int().nonnegative() }).strict();
const OnlineMigrateScanSchema = z.object({ dir: z.string().min(1) }).strict();
const OnlineMigrateWriteSchema = z.object({
  dir: z.string().min(1),
  files: z.array(z.object({ path: OnlinePathSchema, content: z.string() }).strict()).min(1).max(200),
}).strict();
const OnlineProjectMappingSchema = z.object({
  workspaceId: z.string().min(1),
  entries: z.array(OnlineMappingEntrySchema.strict()).min(1).max(200),
}).strict();
const AiSaveConfigSchema = z.object({ baseUrl: z.string().min(1), model: z.string().min(1), apiKey: z.string().optional() }).strict();
const AiSuggestSchema = z.object({ locator: ApiLocatorSchema, baseUrl: z.string().min(1), model: z.string().min(1) }).strict();
const AiTestConfigSchema = z.object({ baseUrl: z.string().min(1), model: z.string().min(1) }).strict();

export const IpcArgsSchemas = {
  [IpcChannel.EvidenceInspect]: z.tuple([EvidenceInvocationSchema]),
  [IpcChannel.EvidenceRerun]: z.tuple([EvidenceInvocationSchema]),
  [IpcChannel.EvidenceCancel]: z.tuple([EvidenceInvocationSchema]),
  [IpcChannel.TestingList]: z.tuple([TestingReadInputSchema]),
  [IpcChannel.AssertionOperators]: z.tuple([]),
  [IpcChannel.DatasetSave]: z.tuple([DatasetSaveInputSchema]),
  [IpcChannel.SuiteSave]: z.tuple([SuiteSaveInputSchema]),
  [IpcChannel.TestingDelete]: z.tuple([TestingDeleteInputSchema]),
  [IpcChannel.DatasetImport]: z.tuple([DatasetExchangeInputSchema]),
  [IpcChannel.DatasetExport]: z.tuple([DatasetExportInputSchema]),
  [IpcChannel.SuitePreview]: z.tuple([SuiteInvocationSchema]),
  [IpcChannel.SuiteRun]: z.tuple([SuiteInvocationSchema]),
  [IpcChannel.SuiteCancel]: z.tuple([SuiteInvocationSchema]),
  [IpcChannel.WsOpen]: z.tuple([z.string()]),
  [IpcChannel.WsCreate]: z.tuple([z.string(), z.string()]),
  [IpcChannel.WsPickDirectory]: z.tuple([]),
  [IpcChannel.WsValidate]: z.tuple([]),
  [IpcChannel.TreeGet]: z.tuple([]),
  [IpcChannel.NodeCreate]: z.tuple([NodeCreateInputSchema]),
  [IpcChannel.NodeRename]: z.tuple([NodeLocatorSchema, z.string()]),
  [IpcChannel.NodeDelete]: z.tuple([NodeLocatorSchema]),
  [IpcChannel.EnvCreate]: z.tuple([EnvCreateInputSchema]),
  [IpcChannel.EnvVarsSave]: z.tuple([EnvironmentLocatorSchema, StringMapSchema]),
  [IpcChannel.EnvBaseUrlsSave]: z.tuple([EnvironmentLocatorSchema, StringMapSchema]),
  [IpcChannel.ContainerSave]: z.tuple([ContainerSaveInputSchema]),
  [IpcChannel.ContainerGet]: z.tuple([ContainerTargetSchema]),
  [IpcChannel.GlobalsSave]: z.tuple([ProjectLocatorSchema, ProjectGlobalSettingsSchema]),
  [IpcChannel.GlobalsGet]: z.tuple([ProjectLocatorSchema]),
  [IpcChannel.StressPolicySave]: z.tuple([ProjectLocatorSchema, StressPolicySchema]),
  [IpcChannel.ApiGet]: z.tuple([ApiLocatorSchema]),
  [IpcChannel.ApiCreateFromRequestDraft]: z.tuple([z.object({
    project: ProjectLocatorSchema,
    targetParent: ApiParentLocatorSchema,
    name: z.string(),
    request: ApiRequestSchema,
    sourceProjectRevision: z.string().min(1),
    fields: z.array(DebugFieldStateSchema),
  }).strict()]),
  [IpcChannel.DebugProjectContext]: z.tuple([ProjectLocatorSchema]),
  [IpcChannel.ApiSave]: z.tuple([ApiLocatorSchema, ApiAssetSchema, z.string().min(1)]),
  [IpcChannel.ApiRequestDraftSave]: z.tuple([ApiLocatorSchema, ApiRequestSchema, z.string().min(1), z.array(DebugFieldStateSchema)]),
  [IpcChannel.CaseSave]: z.tuple([CaseLocatorSchema, ApiTestCaseSchema, z.string().min(1), z.array(DebugFieldStateSchema)]),
  [IpcChannel.CaseDraftSave]: z.tuple([CaseLocatorSchema, ApiTestCaseSchema, z.string().min(1), z.array(z.object({ caseId: z.string().min(1), scope: z.string().min(1) }).strict()), z.array(DebugFieldStateSchema)]),
  [IpcChannel.CaseDelete]: z.tuple([CaseLocatorSchema]),
  [IpcChannel.ModelList]: z.tuple([ProjectLocatorSchema]),
  [IpcChannel.ModelGet]: z.tuple([ModelLocatorSchema]),
  [IpcChannel.ModelCreate]: z.tuple([ProjectLocatorSchema, CreateModelInputSchema]),
  [IpcChannel.ModelSave]: z.tuple([ModelLocatorSchema, ModelAssetSchema]),
  [IpcChannel.ComponentList]: z.tuple([ProjectLocatorSchema]),
  [IpcChannel.ComponentGet]: z.tuple([ComponentLocatorSchema]),
  [IpcChannel.ComponentCreate]: z.tuple([ProjectLocatorSchema, CreateComponentInputSchema]),
  [IpcChannel.ComponentSave]: z.tuple([ComponentLocatorSchema, ComponentAssetSchema]),
  [IpcChannel.MockGet]: z.tuple([ProjectLocatorSchema]),
  [IpcChannel.MockConfigSave]: z.tuple([MockConfigSaveInputSchema]),
  [IpcChannel.MockStart]: z.tuple([MockStartInputSchema]),
  [IpcChannel.MockStop]: z.tuple([MockControlInputSchema]),
  [IpcChannel.MockReload]: z.tuple([MockControlInputSchema]),
  [IpcChannel.MockProjectClose]: z.tuple([MockProjectCloseInputSchema]),
  [IpcChannel.AssetReferences]: z.tuple([ProjectLocatorSchema, z.string()]),
  [IpcChannel.DebugSend]: z.tuple([z.object({ locator: ApiLocatorSchema, caseId: z.string(), envName: z.string().nullish() }).strict()]),
  [IpcChannel.DebugStart]: z.tuple([DebugInvocationSchema]),
  [IpcChannel.DebugWait]: z.tuple([z.object({ runId: z.string().min(1) }).strict()]),
  [IpcChannel.DebugCancel]: z.tuple([z.object({ runId: z.string().min(1) }).strict()]),
  [IpcChannel.DebugCookiesList]: z.tuple([z.object({ locator: ApiLocatorSchema, environmentId: z.string().min(1).optional() }).strict()]),
  [IpcChannel.DebugCookiesClear]: z.tuple([z.object({ locator: ApiLocatorSchema, environmentId: z.string().min(1).optional() }).strict()]),
  [IpcChannel.DebugPickFile]: z.tuple([]),
  [IpcChannel.DebugSaveProjected]: z.tuple([z.string().min(1), z.string()]),
  [IpcChannel.DebugHistoryList]: z.tuple([DebugHistoryListFilterSchema]),
  [IpcChannel.DebugHistoryGet]: z.tuple([z.string().uuid()]),
  [IpcChannel.DebugHistoryDelete]: z.tuple([z.string().uuid()]),
  [IpcChannel.DebugHistoryCleanup]: z.tuple([]),
  [IpcChannel.DebugHistoryPreferencesGet]: z.tuple([]),
  [IpcChannel.DebugHistoryPreferencesUpdate]: z.tuple([DebugHistoryPreferencesSchema]),
  [IpcChannel.DebugHistoryRestore]: z.tuple([z.object({
    historyId: z.string().uuid(),
    exchangeOrder: z.number().int().positive(),
    project: ProjectLocatorSchema.optional(),
  }).strict()]),
  [IpcChannel.DebugHistoryReplay]: z.tuple([z.union([
    z.string().uuid(),
    z.object({ historyId: z.string().uuid(), project: ProjectLocatorSchema }).strict(),
  ])]),
  [IpcChannel.RunCollection]: z.tuple([z.object({ locator: CollectionLocatorSchema, envName: z.string().nullish() }).strict()]),
  [IpcChannel.RunsList]: z.tuple([]),
  [IpcChannel.RunsGet]: z.tuple([z.string()]),
  [IpcChannel.ImportPreview]: z.tuple([ImportPreviewInputSchema]),
  [IpcChannel.ImportPlan]: z.tuple([ImportPlanInputSchema]),
  [IpcChannel.ImportApply]: z.tuple([ImportApplyInputSchema]),
  [IpcChannel.ImportUndo]: z.tuple([ImportUndoInputSchema]),
  [IpcChannel.ProjectClone]: z.tuple([ProjectLocatorSchema]),
  [IpcChannel.ProjectMove]: z.tuple([ProjectLocatorSchema, GroupLocatorSchema]),
  [IpcChannel.DesignExport]: z.tuple([DesignExportInputSchema]),
  [IpcChannel.DesignPreview]: z.tuple([DesignPreviewInputSchema]),
  [IpcChannel.WfList]: z.tuple([ProjectLocatorSchema]),
  [IpcChannel.WfGet]: z.tuple([WorkflowLocatorSchema]),
  [IpcChannel.WfCreate]: z.tuple([z.object({ locator: ProjectLocatorSchema, name: z.string(), executionVersion: z.union([z.literal(1), z.literal(2)]).optional() }).strict()]),
  [IpcChannel.WfDelete]: z.tuple([WorkflowLocatorSchema]),
  [IpcChannel.WfRename]: z.tuple([WorkflowLocatorSchema, z.string()]),
  [IpcChannel.WfSave]: z.tuple([WorkflowLocatorSchema, WorkflowSchema]),
  [IpcChannel.WfSetStatus]: z.tuple([WorkflowLocatorSchema, WorkflowStatusSchema]),
  [IpcChannel.WfImpact]: z.tuple([WorkflowImpactLocatorSchema]),
  [IpcChannel.WfRun]: z.tuple([z.object({ locator: WorkflowLocatorSchema, envName: z.string().nullish(), strict: z.boolean().optional(), invocationId: z.string().uuid().optional(), root: z.string().min(1).optional(), inputs: StringRecordSchema(JsonValueSchema).optional() }).strict()]),
  [IpcChannel.WfCancel]: z.tuple([z.object({ locator: WorkflowLocatorSchema, invocationId: z.string().uuid(), root: z.string().min(1) }).strict()]),
  [IpcChannel.StressRun]: z.tuple([StressRunInputSchema]),
  [IpcChannel.StressPlansList]: z.tuple([ProjectLocatorSchema]),
  [IpcChannel.StressRunsList]: z.tuple([ProjectLocatorSchema]),
  [IpcChannel.StressRunsGet]: z.tuple([ProjectLocatorSchema, StressReportFileSchema]),
  [IpcChannel.StressPlansGet]: z.tuple([ProjectLocatorSchema, z.string().uuid()]),
  [IpcChannel.StressPlansSave]: z.tuple([ProjectLocatorSchema, StressPlanSaveInputSchema]),
  [IpcChannel.StressPlansRemove]: z.tuple([ProjectLocatorSchema, z.string().uuid()]),
  [IpcChannel.StressCompare]: z.tuple([ProjectLocatorSchema, StressCompareInputSchema]),
  [IpcChannel.StressExport]: z.tuple([ProjectLocatorSchema, StressExportInputSchema]),
  [IpcChannel.StressStop]: z.union([z.tuple([]), z.tuple([z.object({ runId: z.string().uuid(), root: z.string().min(1), projectLocator: ProjectLocatorSchema }).strict()])]),
  [IpcChannel.CredentialPut]: z.tuple([CredentialPutInputSchema]),
  [IpcChannel.CredentialRemove]: z.tuple([CredentialRefInputSchema]),
  [IpcChannel.CredentialStatus]: z.tuple([CredentialRefInputSchema]),
  [IpcChannel.OAuthProfilesGet]: z.tuple([OAuthProfilesGetInputSchema]),
  [IpcChannel.OAuthProfileSave]: z.tuple([OAuthProfileSaveInputSchema]),
  [IpcChannel.OAuthProfileUnlink]: z.tuple([OAuthProfileUnlinkInputSchema]),
  [IpcChannel.OAuthProfileAcquire]: z.tuple([OAuthProfileActionInputSchema]),
  [IpcChannel.OAuthProfileRefresh]: z.tuple([OAuthProfileActionInputSchema]),
  [IpcChannel.OAuthAuthorizeBegin]: z.tuple([OAuthAuthorizationBeginInputSchema]),
  [IpcChannel.OAuthAuthorizeStatus]: z.tuple([OAuthAuthorizationSessionIdSchema]),
  [IpcChannel.OAuthAuthorizeWait]: z.tuple([OAuthAuthorizationSessionIdSchema]),
  [IpcChannel.OAuthAuthorizeCancel]: z.tuple([OAuthAuthorizationSessionIdSchema]),
  [IpcChannel.NetworkProfilesGet]: z.tuple([NetworkProfilesGetInputSchema]),
  [IpcChannel.NetworkProfilesSave]: z.tuple([NetworkProfilesSaveInputSchema]),
  [IpcChannel.NetworkSecretImport]: z.tuple([NetworkSecretImportInputSchema]),
  [IpcChannel.OnlineRegister]: z.tuple([OnlineRegisterInputSchema.strict().extend({ baseUrl: OnlineBaseUrlSchema }).strict()]),
  [IpcChannel.OnlineLogin]: z.tuple([z.object({ baseUrl: OnlineBaseUrlSchema, username: z.string(), password: z.string() }).strict()]),
  [IpcChannel.OnlineAuthConfig]: z.tuple([OnlineBaseUrlSchema]),
  [IpcChannel.OnlineLogout]: z.tuple([]),
  [IpcChannel.OnlineResume]: z.tuple([z.object({ baseUrl: OnlineBaseUrlSchema }).strict()]),
  [IpcChannel.OnlineMe]: z.tuple([]),
  [IpcChannel.OnlineWorkspaceList]: z.tuple([]),
  [IpcChannel.OnlineWorkspaceCreate]: z.tuple([z.object({ name: z.string().min(1) }).strict()]),
  [IpcChannel.OnlineTreeGet]: z.tuple([OnlineWorkspaceIdSchema]),
  [IpcChannel.OnlineFilesGet]: z.tuple([OnlineFilesGetSchema]),
  [IpcChannel.OnlineFilePut]: z.tuple([OnlineFilePutSchema]),
  [IpcChannel.OnlineFilesBatch]: z.tuple([OnlineFilesBatchSchema]),
  [IpcChannel.OnlineFileDelete]: z.tuple([OnlineFileDeleteSchema]),
  [IpcChannel.OnlineWorkspaceOpen]: z.tuple([OnlineWorkspaceOpenSchema]),
  [IpcChannel.OnlineWorkspaceActivate]: z.tuple([OnlineWorkspaceIdSchema]),
  [IpcChannel.OnlineWorkspaceClose]: z.tuple([z.object({ workspaceId: z.string().min(1).optional() }).strict().optional()]),
  [IpcChannel.OnlineTreeView]: z.tuple([OnlineWorkspaceIdSchema]),
  [IpcChannel.OnlineMigrateScan]: z.tuple([OnlineMigrateScanSchema]),
  [IpcChannel.OnlineMigrateWrite]: z.tuple([OnlineMigrateWriteSchema]),
  [IpcChannel.OnlineProjectMapping]: z.tuple([OnlineProjectMappingSchema]),
  [IpcChannel.OnlineGroupsList]: z.tuple([OnlineWorkspaceIdSchema]),
  [IpcChannel.OnlineExecution]: z.tuple([OnlineExecutionInputSchema]),
  [IpcChannel.OnlineScheduling]: z.tuple([OnlineSchedulingInputSchema]),
  [IpcChannel.AiSaveConfig]: z.tuple([AiSaveConfigSchema]),
  [IpcChannel.AiGetConfig]: z.tuple([]),
  [IpcChannel.AiSuggest]: z.tuple([AiSuggestSchema]),
  [IpcChannel.AiTestConfig]: z.tuple([AiTestConfigSchema]),
  [IpcChannel.PluginsList]: z.tuple([]),
} satisfies Record<IpcChannelName, z.ZodTypeAny>;

export type IpcArgsMap = { [Channel in IpcChannelName]: z.infer<(typeof IpcArgsSchemas)[Channel]> };
export type IpcInputArgsMap = { [Channel in IpcChannelName]: z.input<(typeof IpcArgsSchemas)[Channel]> };

type IpcArgsMatch = {
  // These existing public methods keep their scalar signatures while preload wraps
  // them in strict transport objects required by the existing main IPC handlers.
  [Channel in IpcChannelName]: Channel extends
    | typeof IpcChannel.OnlineTreeGet
    | typeof IpcChannel.OnlineWorkspaceActivate
    | typeof IpcChannel.OnlineTreeView
    | typeof IpcChannel.OnlineMigrateScan
    | typeof IpcChannel.OnlineGroupsList
    ? true
    : IpcArgsMap[Channel] extends Parameters<ApiccApi[(typeof resultMethodByChannel)[Channel]]> ? true : false;
};

const resultMethodByChannel = {
  [IpcChannel.EvidenceInspect]: "inspectEvidence",
  [IpcChannel.EvidenceRerun]: "rerunEvidence",
  [IpcChannel.EvidenceCancel]: "cancelEvidence",
  [IpcChannel.WsOpen]: "wsOpen",
  [IpcChannel.TestingList]: "listTestingAssets",
  [IpcChannel.AssertionOperators]: "assertionOperators",
  [IpcChannel.DatasetSave]: "saveDataset",
  [IpcChannel.SuiteSave]: "saveSuite",
  [IpcChannel.TestingDelete]: "deleteTestingAsset",
  [IpcChannel.DatasetImport]: "importDataset",
  [IpcChannel.DatasetExport]: "exportDataset",
  [IpcChannel.SuitePreview]: "previewSuite",
  [IpcChannel.SuiteRun]: "runSuite",
  [IpcChannel.SuiteCancel]: "cancelSuite",
  [IpcChannel.WsCreate]: "wsCreate",
  [IpcChannel.WsPickDirectory]: "wsPickDirectory",
  [IpcChannel.WsValidate]: "wsValidate",
  [IpcChannel.TreeGet]: "treeGet",
  [IpcChannel.NodeCreate]: "nodeCreate",
  [IpcChannel.NodeRename]: "nodeRename",
  [IpcChannel.NodeDelete]: "nodeDelete",
  [IpcChannel.EnvCreate]: "envCreate",
  [IpcChannel.EnvVarsSave]: "envVarsSave",
  [IpcChannel.EnvBaseUrlsSave]: "envBaseUrlsSave",
  [IpcChannel.ContainerSave]: "containerSave",
  [IpcChannel.ContainerGet]: "containerGet",
  [IpcChannel.GlobalsSave]: "globalsSave",
  [IpcChannel.GlobalsGet]: "globalsGet",
  [IpcChannel.StressPolicySave]: "stressPolicySave",
  [IpcChannel.ApiGet]: "apiGet",
  [IpcChannel.ApiCreateFromRequestDraft]: "apiCreateFromRequestDraft",
  [IpcChannel.DebugProjectContext]: "debugProjectContext",
  [IpcChannel.ApiSave]: "apiSave",
  [IpcChannel.ApiRequestDraftSave]: "apiRequestDraftSave",
  [IpcChannel.CaseSave]: "caseSave",
  [IpcChannel.CaseDraftSave]: "caseDraftSave",
  [IpcChannel.CaseDelete]: "caseDelete",
  [IpcChannel.ModelList]: "modelList",
  [IpcChannel.ModelGet]: "modelGet",
  [IpcChannel.ModelCreate]: "modelCreate",
  [IpcChannel.ModelSave]: "modelSave",
  [IpcChannel.ComponentList]: "componentList",
  [IpcChannel.ComponentGet]: "componentGet",
  [IpcChannel.ComponentCreate]: "componentCreate",
  [IpcChannel.ComponentSave]: "componentSave",
  [IpcChannel.MockGet]: "mockGet",
  [IpcChannel.MockConfigSave]: "mockConfigSave",
  [IpcChannel.MockStart]: "mockStart",
  [IpcChannel.MockStop]: "mockStop",
  [IpcChannel.MockReload]: "mockReload",
  [IpcChannel.MockProjectClose]: "mockProjectClose",
  [IpcChannel.AssetReferences]: "assetReferences",
  [IpcChannel.DebugSend]: "debugSend",
  [IpcChannel.DebugStart]: "debugStart",
  [IpcChannel.DebugWait]: "debugWait",
  [IpcChannel.DebugCancel]: "debugCancel",
  [IpcChannel.DebugCookiesList]: "debugCookiesList",
  [IpcChannel.DebugCookiesClear]: "debugCookiesClear",
  [IpcChannel.DebugPickFile]: "debugPickFile",
  [IpcChannel.DebugSaveProjected]: "debugSaveProjected",
  [IpcChannel.DebugHistoryList]: "debugHistoryList",
  [IpcChannel.DebugHistoryGet]: "debugHistoryGet",
  [IpcChannel.DebugHistoryDelete]: "debugHistoryDelete",
  [IpcChannel.DebugHistoryCleanup]: "debugHistoryCleanup",
  [IpcChannel.DebugHistoryPreferencesGet]: "debugHistoryPreferencesGet",
  [IpcChannel.DebugHistoryPreferencesUpdate]: "debugHistoryPreferencesUpdate",
  [IpcChannel.DebugHistoryRestore]: "debugHistoryRestore",
  [IpcChannel.DebugHistoryReplay]: "debugHistoryReplay",
  [IpcChannel.RunCollection]: "runCollection",
  [IpcChannel.RunsList]: "runsList",
  [IpcChannel.RunsGet]: "runsGet",
  [IpcChannel.ImportPreview]: "importPreview",
  [IpcChannel.ImportPlan]: "importPlan",
  [IpcChannel.ImportApply]: "importApply",
  [IpcChannel.ImportUndo]: "importUndo",
  [IpcChannel.ProjectClone]: "projectClone",
  [IpcChannel.ProjectMove]: "projectMove",
  [IpcChannel.DesignExport]: "designExport",
  [IpcChannel.DesignPreview]: "designPreview",
  [IpcChannel.WfList]: "wfList",
  [IpcChannel.WfGet]: "wfGet",
  [IpcChannel.WfCreate]: "wfCreate",
  [IpcChannel.WfDelete]: "wfDelete",
  [IpcChannel.WfRename]: "wfRename",
  [IpcChannel.WfSave]: "wfSave",
  [IpcChannel.WfSetStatus]: "wfSetStatus",
  [IpcChannel.WfImpact]: "wfImpact",
  [IpcChannel.WfRun]: "wfRun",
  [IpcChannel.WfCancel]: "wfCancel",
  [IpcChannel.StressRun]: "stressRun",
  [IpcChannel.StressPlansList]: "stressPlansList",
  [IpcChannel.StressRunsList]: "stressRunsList",
  [IpcChannel.StressRunsGet]: "stressRunsGet",
  [IpcChannel.StressPlansGet]: "stressPlansGet",
  [IpcChannel.StressPlansSave]: "stressPlansSave",
  [IpcChannel.StressPlansRemove]: "stressPlansRemove",
  [IpcChannel.StressCompare]: "stressCompare",
  [IpcChannel.StressExport]: "stressExport",
  [IpcChannel.StressStop]: "stressStop",
  [IpcChannel.CredentialPut]: "credentialPut",
  [IpcChannel.CredentialRemove]: "credentialRemove",
  [IpcChannel.CredentialStatus]: "credentialStatus",
  [IpcChannel.OAuthProfilesGet]: "oauthProfilesGet",
  [IpcChannel.OAuthProfileSave]: "oauthProfileSave",
  [IpcChannel.OAuthProfileUnlink]: "oauthProfileUnlink",
  [IpcChannel.OAuthProfileAcquire]: "oauthProfileAcquire",
  [IpcChannel.OAuthProfileRefresh]: "oauthProfileRefresh",
  [IpcChannel.OAuthAuthorizeBegin]: "oauthAuthorizeBegin",
  [IpcChannel.OAuthAuthorizeStatus]: "oauthAuthorizeStatus",
  [IpcChannel.OAuthAuthorizeWait]: "oauthAuthorizeWait",
  [IpcChannel.OAuthAuthorizeCancel]: "oauthAuthorizeCancel",
  [IpcChannel.NetworkProfilesGet]: "networkProfilesGet",
  [IpcChannel.NetworkProfilesSave]: "networkProfilesSave",
  [IpcChannel.NetworkSecretImport]: "networkSecretImport",
  [IpcChannel.OnlineRegister]: "onlineRegister",
  [IpcChannel.OnlineLogin]: "onlineLogin",
  [IpcChannel.OnlineAuthConfig]: "authConfig",
  [IpcChannel.OnlineLogout]: "onlineLogout",
  [IpcChannel.OnlineResume]: "onlineResume",
  [IpcChannel.OnlineMe]: "onlineMe",
  [IpcChannel.OnlineWorkspaceList]: "onlineWorkspaceList",
  [IpcChannel.OnlineWorkspaceCreate]: "onlineWorkspaceCreate",
  [IpcChannel.OnlineTreeGet]: "onlineTreeGet",
  [IpcChannel.OnlineFilesGet]: "onlineFilesGet",
  [IpcChannel.OnlineFilePut]: "onlineFilePut",
  [IpcChannel.OnlineFilesBatch]: "onlineFilesBatch",
  [IpcChannel.OnlineFileDelete]: "onlineFileDelete",
  [IpcChannel.OnlineWorkspaceOpen]: "onlineWorkspaceOpen",
  [IpcChannel.OnlineWorkspaceActivate]: "onlineWorkspaceActivate",
  [IpcChannel.OnlineWorkspaceClose]: "onlineWorkspaceClose",
  [IpcChannel.OnlineTreeView]: "onlineTreeView",
  [IpcChannel.OnlineMigrateScan]: "onlineMigrateScan",
  [IpcChannel.OnlineMigrateWrite]: "onlineMigrateWrite",
  [IpcChannel.OnlineProjectMapping]: "onlineProjectMapping",
  [IpcChannel.OnlineGroupsList]: "onlineGroupsList",
  [IpcChannel.OnlineExecution]: "onlineExecution",
  [IpcChannel.OnlineScheduling]: 'onlineScheduling',
  [IpcChannel.AiSaveConfig]: "aiSaveConfig",
  [IpcChannel.AiGetConfig]: "aiGetConfig",
  [IpcChannel.AiSuggest]: "aiSuggest",
  [IpcChannel.AiTestConfig]: "aiTestConfig",
  [IpcChannel.PluginsList]: "pluginsList",
} as const satisfies Record<IpcChannelName, keyof ApiccApi>;

type MismatchedIpcArgs = { [Channel in IpcChannelName]: IpcArgsMatch[Channel] extends true ? never : Channel }[IpcChannelName];
type AssertNoMismatchedIpcArgs<Value extends never> = Value;
type IpcArgsAreSynchronizedWithPreload = AssertNoMismatchedIpcArgs<MismatchedIpcArgs>;

export type IpcResultMap = {
  [Channel in IpcChannelName]: Awaited<ReturnType<ApiccApi[(typeof resultMethodByChannel)[Channel]]>>;
};

export function parseIpcArgs<Channel extends IpcChannelName>(channel: Channel, rawArgs: unknown): IpcArgsMap[Channel] {
  const result = IpcArgsSchemas[channel].safeParse(rawArgs);
  if (!result.success) {
    const issue = result.error.issues[0];
    const location = issue ? `${issue.path.join(".") || "(root)"} ${issue.message}` : "未知错误";
    throw new Error(`[${channel}] 入参校验失败: ${location}`);
  }
  return result.data as IpcArgsMap[Channel];
}

export type { ImportApplyInput, ImportPlanInput, ImportUndoInput, NodeCreateInput, StressRunInput };

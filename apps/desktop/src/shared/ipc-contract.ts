import { z } from "zod";
import {
  ApiAssetSchema,
  ApiTestCaseSchema,
  ComponentAssetSchema,
  ContractProjectSchema,
  HttpMethodSchema,
  InlineAuthBindingSchema,
  JsonValueSchema,
  KeyValuePairSchema,
  ModelAssetSchema,
  OperationSchema,
  ResponseDefinitionSchema,
  SchemaNodeSchema,
  StressPolicySchema,
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
import { IpcChannel, type IpcChannelName } from "./channels.js";
import type {
  ApiccApi,
  ImportApplyInput,
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
const WorkflowStatusSchema = z.enum(["draft", "published", "enabled"]);
const WorkflowNodeSchema = z.object({
  id: z.string(),
  kind: z.enum(["request", "noop"]),
  apiId: z.string().optional(),
  caseId: z.string().optional(),
  label: z.string().optional(),
  position: z.object({ x: z.number(), y: z.number() }).strict().optional(),
}).strict();
const WorkflowEdgeSchema = z.object({ id: z.string(), from: z.string(), to: z.string(), condition: z.string().optional() }).strict();
const WorkflowSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: WorkflowStatusSchema.default("draft"),
  nodes: z.array(WorkflowNodeSchema).default([]),
  edges: z.array(WorkflowEdgeSchema).default([]),
}).strict();
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
const StressRunInputSchema = z.object({
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
const ImportPreviewInputSchema = z.object({ fileName: z.string(), content: z.string() }).strict();
const ImportApplyInputSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("project"), target: GroupLocatorSchema, name: z.string(), project: ContractProjectSchema }).strict(),
  z.object({ mode: z.literal("module"), target: ProjectLocatorSchema, name: z.string(), sourceEnvironmentName: z.string().optional(), project: ContractProjectSchema }).strict(),
]);
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
  [IpcChannel.ApiSave]: z.tuple([ApiLocatorSchema, ApiAssetSchema]),
  [IpcChannel.CaseSave]: z.tuple([CaseLocatorSchema, ApiTestCaseSchema]),
  [IpcChannel.CaseDelete]: z.tuple([CaseLocatorSchema]),
  [IpcChannel.ModelList]: z.tuple([ProjectLocatorSchema]),
  [IpcChannel.ModelGet]: z.tuple([ModelLocatorSchema]),
  [IpcChannel.ModelCreate]: z.tuple([ProjectLocatorSchema, CreateModelInputSchema]),
  [IpcChannel.ModelSave]: z.tuple([ModelLocatorSchema, ModelAssetSchema]),
  [IpcChannel.ComponentList]: z.tuple([ProjectLocatorSchema]),
  [IpcChannel.ComponentGet]: z.tuple([ComponentLocatorSchema]),
  [IpcChannel.ComponentCreate]: z.tuple([ProjectLocatorSchema, CreateComponentInputSchema]),
  [IpcChannel.ComponentSave]: z.tuple([ComponentLocatorSchema, ComponentAssetSchema]),
  [IpcChannel.AssetReferences]: z.tuple([ProjectLocatorSchema, z.string()]),
  [IpcChannel.DebugSend]: z.tuple([z.object({ locator: ApiLocatorSchema, caseId: z.string(), envName: z.string().nullish() }).strict()]),
  [IpcChannel.RunCollection]: z.tuple([z.object({ locator: CollectionLocatorSchema, envName: z.string().nullish() }).strict()]),
  [IpcChannel.RunsList]: z.tuple([]),
  [IpcChannel.RunsGet]: z.tuple([z.string()]),
  [IpcChannel.ImportPreview]: z.tuple([ImportPreviewInputSchema]),
  [IpcChannel.ImportApply]: z.tuple([ImportApplyInputSchema]),
  [IpcChannel.ProjectClone]: z.tuple([ProjectLocatorSchema]),
  [IpcChannel.ProjectMove]: z.tuple([ProjectLocatorSchema, GroupLocatorSchema]),
  [IpcChannel.DesignExport]: z.tuple([ApiLocatorSchema]),
  [IpcChannel.WfList]: z.tuple([ProjectLocatorSchema]),
  [IpcChannel.WfGet]: z.tuple([WorkflowLocatorSchema]),
  [IpcChannel.WfCreate]: z.tuple([z.object({ locator: ProjectLocatorSchema, name: z.string() }).strict()]),
  [IpcChannel.WfDelete]: z.tuple([WorkflowLocatorSchema]),
  [IpcChannel.WfRename]: z.tuple([WorkflowLocatorSchema, z.string()]),
  [IpcChannel.WfSave]: z.tuple([WorkflowLocatorSchema, WorkflowSchema]),
  [IpcChannel.WfSetStatus]: z.tuple([WorkflowLocatorSchema, WorkflowStatusSchema]),
  [IpcChannel.WfImpact]: z.tuple([WorkflowImpactLocatorSchema]),
  [IpcChannel.WfRun]: z.tuple([z.object({ locator: WorkflowLocatorSchema, envName: z.string().nullish(), strict: z.boolean().optional() }).strict()]),
  [IpcChannel.StressRun]: z.tuple([StressRunInputSchema]),
  [IpcChannel.StressStop]: z.tuple([]),
  [IpcChannel.CredentialPut]: z.tuple([CredentialPutInputSchema]),
  [IpcChannel.CredentialRemove]: z.tuple([CredentialRefInputSchema]),
  [IpcChannel.CredentialStatus]: z.tuple([CredentialRefInputSchema]),
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
  [IpcChannel.AiSaveConfig]: z.tuple([AiSaveConfigSchema]),
  [IpcChannel.AiGetConfig]: z.tuple([]),
  [IpcChannel.AiSuggest]: z.tuple([AiSuggestSchema]),
  [IpcChannel.AiTestConfig]: z.tuple([AiTestConfigSchema]),
  [IpcChannel.PluginsList]: z.tuple([]),
} satisfies Record<IpcChannelName, z.ZodTypeAny>;

export type IpcArgsMap = { [Channel in IpcChannelName]: z.infer<(typeof IpcArgsSchemas)[Channel]> };

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
  [IpcChannel.WsOpen]: "wsOpen",
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
  [IpcChannel.ApiSave]: "apiSave",
  [IpcChannel.CaseSave]: "caseSave",
  [IpcChannel.CaseDelete]: "caseDelete",
  [IpcChannel.ModelList]: "modelList",
  [IpcChannel.ModelGet]: "modelGet",
  [IpcChannel.ModelCreate]: "modelCreate",
  [IpcChannel.ModelSave]: "modelSave",
  [IpcChannel.ComponentList]: "componentList",
  [IpcChannel.ComponentGet]: "componentGet",
  [IpcChannel.ComponentCreate]: "componentCreate",
  [IpcChannel.ComponentSave]: "componentSave",
  [IpcChannel.AssetReferences]: "assetReferences",
  [IpcChannel.DebugSend]: "debugSend",
  [IpcChannel.RunCollection]: "runCollection",
  [IpcChannel.RunsList]: "runsList",
  [IpcChannel.RunsGet]: "runsGet",
  [IpcChannel.ImportPreview]: "importPreview",
  [IpcChannel.ImportApply]: "importApply",
  [IpcChannel.ProjectClone]: "projectClone",
  [IpcChannel.ProjectMove]: "projectMove",
  [IpcChannel.DesignExport]: "designExport",
  [IpcChannel.WfList]: "wfList",
  [IpcChannel.WfGet]: "wfGet",
  [IpcChannel.WfCreate]: "wfCreate",
  [IpcChannel.WfDelete]: "wfDelete",
  [IpcChannel.WfRename]: "wfRename",
  [IpcChannel.WfSave]: "wfSave",
  [IpcChannel.WfSetStatus]: "wfSetStatus",
  [IpcChannel.WfImpact]: "wfImpact",
  [IpcChannel.WfRun]: "wfRun",
  [IpcChannel.StressRun]: "stressRun",
  [IpcChannel.StressStop]: "stressStop",
  [IpcChannel.CredentialPut]: "credentialPut",
  [IpcChannel.CredentialRemove]: "credentialRemove",
  [IpcChannel.CredentialStatus]: "credentialStatus",
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

export type { ImportApplyInput, NodeCreateInput, StressRunInput };

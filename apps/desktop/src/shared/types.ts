import type {
  ApiAsset,
  ApiRequest,
  ApiTestCase,
  CaseOutcome,
  ComponentAsset,
  ContractProject,
  ContractWorkspace,
  Environment,
  LoadProblem,
  ModelAsset,
  RunResult,
  StressReport,
  StressFailureCounts,
  Workflow,
  WorkflowRunResult,
  WorkflowStatus,
  ProjectGlobals,
  StressThresholds,
  StressTargetPolicy,
  DebugInvocation,
  DebugFieldState,
  DebugResult,
  HttpCookieSummary,
  DebugHistoryDiagnostic,
  DebugHistoryListFilter,
  DebugHistoryPage,
  DebugHistoryPreferences,
  DebugHistoryReadResult,
} from "@apicc/core";
import type { NetworkProfilesResult, NetworkProfilesSaveInput, NetworkProfilesSaveResult, NetworkSecretImportResult, NetworkSecretImportInput } from "./network.js";
import type {
  ApiLocator,
  ApiParentLocator,
  CaseLocator,
  CollectionLocator,
  ComponentLocator,
  EnvironmentLocator,
  FolderLocator,
  GroupLocator,
  ModelLocator,
  NodeLocator,
  ProjectLocator,
  WorkflowLocator,
  WorkspaceLocator,
} from "./locations.js";
import type { LocalTreeNodeDTO } from "./tree-dto.js";
import type { TestingApi } from "./testing.js";
import type { KeyValuePair } from "@apicc/core";
import { CurrentStressReportSchema } from "@apicc/core/schema";
import { z } from "zod";
import type { CredentialMutationResult, CredentialPutInput, CredentialRefInput, CredentialStatusResult } from "./credentials.js";
import type {
  OAuthProfileActionInput,
  OAuthAuthorizationBeginInput,
  OAuthAuthorizationSessionId,
  OAuthAuthorizationSessionView,
  OAuthProfileMutationResult,
  OAuthProfileSaveInput,
  OAuthProfileUnlinkInput,
  OAuthProfilesGetInput,
  OAuthProfilesResult,
} from "./oauth.js";

export type CreateModelInput = ModelAsset extends infer Asset
  ? Asset extends { formatVersion: number; id: string }
    ? Omit<Asset, "formatVersion" | "id">
    : never
  : never;
export type CreateComponentInput = ComponentAsset extends infer Asset
  ? Asset extends { formatVersion: number; id: string }
    ? Omit<Asset, "formatVersion" | "id">
    : never
  : never;
export type { DebugHistoryListFilter, DebugHistoryPreferences };
type LocatorKey =
  | "workspaceId" | "groupId" | "projectId" | "collectionId" | "folderIds" | "apiId"
  | "environmentId" | "modelId" | "componentKind" | "componentId" | "workflowId";
type ExactLocator<Locator> = Locator extends object
  ? Locator & { [Key in Exclude<LocatorKey, keyof Locator>]?: never }
  : never;
export interface CreateApiInput {
  name: string;
  protocol?: "http" | "websocket" | "soap";
  method?: import("@apicc/core").HttpMethod;
  baseUrl?: string;
  path?: string;
}
export type NodeCreateInput =
  | { kind: "group"; parent: ExactLocator<WorkspaceLocator>; name: string }
  | { kind: "project"; parent: ExactLocator<GroupLocator>; name: string }
  | { kind: "collection"; parent: ExactLocator<ProjectLocator>; name: string }
  | { kind: "folder"; parent: ExactLocator<ApiParentLocator>; name: string }
  | { kind: "api"; parent: ExactLocator<ApiParentLocator>; api: CreateApiInput };
export type NodeCreatedDTO =
  | { kind: "group"; source: "local"; id: string; key: string; locator: GroupLocator; label: string }
  | { kind: "project"; source: "local"; id: string; key: string; locator: ProjectLocator; label: string }
  | { kind: "collection"; source: "local"; id: string; key: string; locator: CollectionLocator; label: string }
  | { kind: "folder"; source: "local"; id: string; key: string; locator: FolderLocator; label: string }
  | { kind: "api"; source: "local"; id: string; key: string; locator: ApiLocator; label: string; protocol: "http" | "websocket" | "soap"; method?: string };
export interface ContainerOperations {
  preOperations: Array<{ id: string; type: "script"; content: string }>;
  postOperations: Array<{ id: string; type: "script"; content: string }>;
}
export type ContainerTarget =
  | { kind: "collection"; locator: CollectionLocator }
  | { kind: "folder"; locator: FolderLocator };
export type ContainerDetail =
  | { kind: "collection"; locator: CollectionLocator; name: string; operations: ContainerOperations & { variables: Record<string, string> } }
  | { kind: "folder"; locator: FolderLocator; name: string; operations: ContainerOperations };
export type ContainerSaveInput =
  | { kind: "collection"; locator: CollectionLocator; operations: ContainerOperations & { variables: Record<string, string> } }
  | { kind: "folder"; locator: FolderLocator; operations: ContainerOperations };
export type ContainerSaveResult =
  | { kind: "collection"; locator: CollectionLocator; operations: ContainerOperations & { variables: Record<string, string> } }
  | { kind: "folder"; locator: FolderLocator; operations: ContainerOperations };

/** 项目级全局设置（M10）：全局变量（=project.variables）+ 四类全局参数的复合包络。 */
export interface ProjectGlobalSettings {
  variables: Record<string, string>;
  query: KeyValuePair[];
  headers: KeyValuePair[];
  cookies: KeyValuePair[];
  body: KeyValuePair[];
}
import type { AiSuggestedCase } from "@apicc/core";
import type { AiKeyStatus, AiSaveConfigInput, AiSuggestInput, AiTestConfigInput, AiTestConfigResult } from "./ai/contract.js";
import type { PluginsListResult } from "./plugins/contract.js";
import type {
  OnlineBatchResult,
  OnlineDeleteOutcome,
  OnlineFilesGetInput,
  OnlineFilesBatchInput,
  OnlineFileDeleteInput,
  OnlineFilePutInput,
  OnlineFilesResult,
  OnlineGroup,
  OnlineLoginInput,
  OnlineLoginOutput,
  OnlineMappingResult,
  OnlineMigrateScanResult,
  OnlineMigrateWriteInput,
  OnlineProjectMappingInput,
  OnlinePushOutcome,
  OnlineRegisterChannelInput,
  OnlineResumeInput,
  OnlineResumeOutput,
  OnlineTree,
  OnlineUser,
  OnlineWorkspaceCreateInput,
  OnlineWorkspaceCreated,
  OnlineWorkspaceOpenInput,
  OnlineWorkspaceSummary,
  OnlineWorkspaceView,
} from "./online/types.js";
import type { WorkflowImpactLocator } from "./locations.js";
import type { DesignExportInput, DesignPreviewInput, DesignPreviewResult } from "./design.js";
import type { MockConfigSaveInput, MockControlInput, MockProjectCloseInput, MockStartInput, MockStatus } from "./mock.js";

export interface WorkflowImpactEntryDTO {
  workflowId: string;
  workflowName: string;
  status: WorkflowStatus;
  nodeId: string;
  nodeLabel?: string;
}
export interface OpenResult { workspace: ContractWorkspace; problems: LoadProblem[]; root: string; readOnly: boolean; revision: string }
export interface ApiDetail { api: ApiAsset; locator: ApiLocator; sourceApiRevision: string; sourceProjectRevision: string; envs: Array<{ id: string; name: string; locator: EnvironmentLocator }> }
export interface CreateApiFromRequestDraftInput {
  project: ProjectLocator;
  targetParent: ApiParentLocator;
  name: string;
  request: ApiRequest;
  sourceProjectRevision: string;
  fields: DebugFieldState[];
}
export interface CreateApiFromRequestDraftResult { locator: ApiLocator; detail: ApiDetail }
export interface DebugProjectContext { project: ProjectLocator; sourceProjectRevision: string; envs: Array<{ id: string; name: string; locator: EnvironmentLocator }> }
export interface ApiRequestDraftSaveResult { request: import("@apicc/core").ApiRequest; sourceApiRevision: string }
export interface ApiSaveResult { api: ApiAsset; sourceApiRevision: string; sourceProjectRevision: string }
export interface CaseDraftSaveResult { testCase: ApiTestCase; sourceApiRevision: string }
export interface CaseDraftDeletion { caseId: string; scope: string }
export type DebugHistoryReplayResult = DebugStartResult & (
  | { sourceKind: "asset"; locator: ApiLocator }
  | { sourceKind: "free"; project: ProjectLocator; draftId: string }
);
export interface DebugFileReference { path: string; name: string; size: number }
export type DebugCookieSummary = HttpCookieSummary;
export interface DebugCookieInput { locator: ApiLocator; environmentId?: string }
export interface DebugInput { locator: ApiLocator; caseId: string; envName?: string | null }
export type DebugStartInput = DebugInvocation;
export interface DebugRunIdInput { runId: string }
export interface DebugStartResult { runId: string }
export type DebugCancelResult = { status: "cancelled" | "no-active" };
export interface DebugHistoryRestoreResult {
  invocation: DebugInvocation;
  sourceChanged: boolean;
  sourceAvailable: boolean;
}
export interface DebugHistoryRestoreInput { historyId: string; exchangeOrder: number; project?: ProjectLocator }
export type DebugHistoryReplayInput = string | { historyId: string; project: ProjectLocator };
export interface DebugHistoryCleanupResult { deleted: number; diagnostics: DebugHistoryDiagnostic[] }
export interface DebugHistoryPreferencesResult { preferences: DebugHistoryPreferences; diagnostics: DebugHistoryDiagnostic[] }
/** env:create 入参：extends 按环境名引用父环境（规格 §6 继承链，运行时由 Runner 合并）。 */
export interface EnvCreateInput {
  locator: ProjectLocator;
  name: string;
  extends?: string | null;
  variables?: Record<string, string>;
  baseUrls?: Record<string, string>;
}
/** 响应快照：随 afterResponse 事件捕获，ResponseViewer 用真实数据替换「—」占位。 */
export interface ResponseSnapshot { status: number; headers: Record<string, string>; bodyText: string; timeMs: number }
export interface DebugOutput { run: RunResult; outcome: CaseOutcome; response?: ResponseSnapshot }
/** run:collection 入参：envName 按环境名引用（与 DebugInput 同语义，规格 §6）。 */
export interface RunCollectionInput { locator: CollectionLocator; envName?: string | null }
/**
 * runs:list 行摘要（集合运行）：与 src/main/runs.ts 同名接口结构同构（IPC 结构化克隆传输，
 * 字段变更需双侧同步）；结构漂移由 ipc.ts runs:list 分支的 satisfies 校验兜底。
 * kind 必填（M2-D3 任务 1）：运行历史按 kind 区分集合/压测两类报告（规格 §2 D11）。
 */
export interface RunSummaryDTO { kind: "collection" | "suite" | "workflow"; projectId?: string; file: string; collectionName: string; startedAt: string; total: number; passed: number; failed: number; skipped?: number; reportingUnits?: RunResult["reportingUnits"] }
/**
 * runs:list 行摘要（压测，M2-D3 任务 1）：startedAt 为 report.startedAt（epoch ms）格式化的
 * ISO 字符串，与集合行的 startedAt 同口径排序。
 */
export interface StressRunSummaryDTO { kind: "stress"; projectId?: string; file: string; startedAt: string; totalRequests: number; ok: number; failed: number; rps: number }
export type RunSummary = RunSummaryDTO | StressRunSummaryDTO;

/** stress:run 入参：maxIterations/durationMs 至少给其一（都给先到先停），二者可传 null（渲染层「清空」惯例）。 */
export interface StressRunInput {
  locator: ApiLocator;
  caseId: string;
  envName?: string | null;
  concurrency: number;
  maxIterations?: number | null;
  durationMs?: number | null;
  thresholds?: StressThresholds;
  connectionMode?: "pooled" | "fresh";
  /** Explicit, canonical origins approved only for this run. */
  confirmedTargetOrigins?: string[];
}
/**
 * stress:run / stress:stop 返回：最终（或中止后的部分）报告 + 落盘文件名。
 * 落盘降级不影响报告返回，与集合运行口径一致（core Runner 落盘失败仅告警仍返回完整结果）：
 * file 落盘成功为文件名（.apicc/runs/stress-<apiId>-<ts>.json），降级时省略。
 */
const StressRunErrorCodeSchema = z.enum([
  "invalid_target_origin",
  "target_confirmation_required",
  "target_denied",
  "concurrency_policy_exceeded",
  "max_rps_policy_exceeded",
  "invalid_stress_policy",
]);
// Runtime validation uses the strict current-report contract; the public renderer
// type remains the historical StressReport supertype so deterministic test doubles
// and report viewers can still represent legacy-shaped data.
const StressRunCurrentReportSchema = CurrentStressReportSchema.transform((report) => report as StressReport);
const StressRunSuccessSchema = z.object({
  ok: z.literal(true),
  report: StressRunCurrentReportSchema,
  file: z.string().optional(),
}).strict();
const StressRunErrorSchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: StressRunErrorCodeSchema,
    message: z.string(),
    targetOrigin: z.string(),
  }).strict(),
}).strict();
/** Structured-clone-safe outcome for stress start; unknown main exceptions still reject IPC. */
export const StressRunResultSchema = z.discriminatedUnion("ok", [StressRunSuccessSchema, StressRunErrorSchema]);
export type StressRunOutput = z.infer<typeof StressRunSuccessSchema>;
export type StressRunError = z.infer<typeof StressRunErrorSchema>;
export type StressRunResult = z.infer<typeof StressRunResultSchema>;
/** runs:get 对 stress 文件的返回：kind 判别 + 完整压测报告（集合文件返回既有 RunResult 形状）。 */
export type DesktopStressReport = Omit<StressReport, "failures" | "scriptLatency" | "iterationLatency"> & {
  /** Historical reports may omit fields introduced after their creation. */
  failures?: StressFailureCounts;
  scriptLatency?: StressReport["scriptLatency"];
  iterationLatency?: StressReport["iterationLatency"];
};
export interface StressReportDTO { kind: "stress"; report: DesktopStressReport }
export type StressPolicyInput = StressTargetPolicy;

/** import:preview 入参：渲染层经 input[type=file] 读出文本与文件名（不新增文件选择 IPC）。 */
export interface ImportPreviewInput { fileName: string; content: string }
export interface ImportExchangeDiagnostic { severity: "warning" | "error"; code: string; path: string; message: string; lossy: boolean; ownerId?: string }
export interface ImportPreviewApi { id: string; name: string; method: string; path: string }
export interface ImportPreviewCollection { id: string; name: string; apis: ImportPreviewApi[] }
export interface ImportPreviewEnvironmentOption { optionToken: string; label: string }
/** Renderer-visible preview deliberately excludes the parsed project and every credential/asset payload. */
export interface ImportPreviewResult {
  token: string;
  importerName: string;
  summary: { projectName: string; collections: number; apis: number; environments: ImportPreviewEnvironmentOption[] };
  tree: ImportPreviewCollection[];
  diagnostics: ImportExchangeDiagnostic[];
}
export type ImportPlanInput =
  | { previewToken: string; mode: "project"; target: GroupLocator; name: string }
  | { previewToken: string; mode: "module"; target: ProjectLocator; name: string; sourceEnvironmentOptionToken?: string }
  | { previewToken: string; mode: "merge"; target: CollectionLocator; sourceCollectionIds: string[]; decisions: Record<string, { action: "skip" | "rename" | "overwrite" | "cancel"; targetApiId?: string; name?: string }> };
export interface ImportPlanResult {
  token: string;
  mode: ImportPlanInput["mode"];
  summary: { added: number; overwritten: number; skipped: number };
  entries: Array<{ sourceApiId: string; sourceName: string; sourcePath: string; method: string; path: string; status: "added" | "overwritten" | "skipped"; targetApiIds: string[]; targetName?: string }>;
  diagnostics: ImportExchangeDiagnostic[];
  cancelled: boolean;
}
export interface ImportApplyInput { planToken: string; allowLossy: boolean }
export interface ImportApplyResult { committed: boolean; undoToken?: string; summary: ImportPlanResult["summary"] }
export interface ImportUndoInput { undoToken: string }

/** wf:list 行摘要：工作流列表（侧树「工作流」分组与列表视图共用，规格 §3）。 */
export interface WorkflowSummary { id: string; name: string; status: WorkflowStatus; locator: WorkflowLocator }
/** wf:get 返回：完整工作流 + 所属项目 id（设计器级联数据按项目定位）。 */
export interface WorkflowDetail { workflow: Workflow; locator: WorkflowLocator }
/** wf:create 入参：目标项目 + 工作流名（同项目重名拒绝「工作流已存在: name」）。 */
export interface WfCreateInput { locator: ProjectLocator; name: string }
/**
 * wf:set-status 返回：迁移后的工作流 + 启用校验错误/警告。
 * published→enabled 校验未过时 workflow 为状态不变的原工作流、errors 非空；
 * 非法迁移（如 draft→enabled 跳级）不落在此形状——session 直接抛错（UI 按钮禁用本不应触发）。
 */
export interface WfSetStatusResult { workflow: Workflow; errors: string[]; warnings: string[] }
/** wf:impact 入参：按用例/接口 id 反查工作流引用（规格 §3.1 影响分析）。 */
export type WfImpactInput = WorkflowImpactLocator;
/** wf:run 入参：envName 按环境名引用（与 DebugInput 同语义，规格 §6）。 */
export interface WfRunInput { locator: WorkflowLocator; envName?: string | null; strict?: boolean }

export interface ApiccApi extends TestingApi {
  wsOpen(rootPath: string): Promise<OpenResult>;
  wsCreate(rootPath: string, name: string): Promise<OpenResult>;
  wsPickDirectory(): Promise<string>;
  wsValidate(): Promise<LoadProblem[]>;
  treeGet(): Promise<LocalTreeNodeDTO>;
  nodeCreate(input: NodeCreateInput): Promise<NodeCreatedDTO>;
  nodeRename(node: NodeLocator, name: string): Promise<void>;
  nodeDelete(node: NodeLocator): Promise<void>;
  envCreate(input: EnvCreateInput): Promise<Environment>;
  envVarsSave(locator: EnvironmentLocator, variables: Record<string, string>): Promise<Environment>;
  envBaseUrlsSave(locator: EnvironmentLocator, baseUrls: Record<string, string>): Promise<Environment>;
  globalsSave(locator: ProjectLocator, globals: ProjectGlobalSettings): Promise<ProjectGlobalSettings>;
  stressPolicySave(locator: ProjectLocator, policy: StressPolicyInput): Promise<StressPolicyInput>;
  containerSave(input: ContainerSaveInput): Promise<ContainerSaveResult>;
  containerGet(target: ContainerTarget): Promise<ContainerDetail>;
  globalsGet(locator: ProjectLocator): Promise<ProjectGlobalSettings>;
  apiGet(locator: ApiLocator): Promise<ApiDetail>;
  apiCreateFromRequestDraft(input: CreateApiFromRequestDraftInput): Promise<CreateApiFromRequestDraftResult>;
  debugProjectContext(locator: ProjectLocator): Promise<DebugProjectContext>;
  apiSave(locator: ApiLocator, api: ApiAsset, expectedSourceApiRevision: string): Promise<ApiSaveResult>;
  apiRequestDraftSave(locator: ApiLocator, request: import("@apicc/core").ApiRequest, expectedSourceApiRevision: string, fields: DebugFieldState[]): Promise<ApiRequestDraftSaveResult>;
  caseSave(locator: CaseLocator, testCase: ApiTestCase, expectedSourceApiRevision: string, fields: DebugFieldState[]): Promise<CaseDraftSaveResult>;
  caseDraftSave(locator: CaseLocator, testCase: ApiTestCase, expectedSourceApiRevision: string, deletedCases: CaseDraftDeletion[], fields: DebugFieldState[]): Promise<CaseDraftSaveResult>;
  caseDelete(locator: CaseLocator): Promise<void>;
  modelList(locator: ProjectLocator): Promise<ModelAsset[]>;
  modelGet(locator: ModelLocator): Promise<ModelAsset>;
  modelCreate(locator: ProjectLocator, input: CreateModelInput): Promise<ModelAsset>;
  modelSave(locator: ModelLocator, model: ModelAsset): Promise<ModelAsset>;
  componentList(locator: ProjectLocator): Promise<ComponentAsset[]>;
  componentGet(locator: ComponentLocator): Promise<ComponentAsset>;
  componentCreate(locator: ProjectLocator, input: CreateComponentInput): Promise<ComponentAsset>;
  componentSave(locator: ComponentLocator, component: ComponentAsset): Promise<ComponentAsset>;
  mockGet(locator: ProjectLocator): Promise<MockStatus>;
  mockConfigSave(input: MockConfigSaveInput): Promise<MockStatus>;
  mockStart(input: MockStartInput): Promise<MockStatus>;
  mockStop(input: MockControlInput): Promise<MockStatus>;
  mockReload(input: MockControlInput): Promise<MockStatus>;
  mockProjectClose(input: MockProjectCloseInput): Promise<void>;
  assetReferences(locator: ProjectLocator, assetId: string): Promise<import("@apicc/core").AssetDiagnostic[]>;
  debugSend(input: DebugInput): Promise<DebugOutput>;
  debugStart(input: DebugStartInput): Promise<DebugStartResult>;
  debugWait(input: DebugRunIdInput): Promise<DebugResult>;
  debugCancel(input: DebugRunIdInput): Promise<DebugCancelResult>;
  debugCookiesList(input: DebugCookieInput): Promise<DebugCookieSummary[]>;
  debugCookiesClear(input: DebugCookieInput): Promise<void>;
  debugPickFile(): Promise<DebugFileReference | null>;
  debugSaveProjected(defaultName: string, content: string): Promise<string>;
  debugHistoryList(filter: DebugHistoryListFilter): Promise<DebugHistoryPage>;
  debugHistoryGet(historyId: string): Promise<DebugHistoryReadResult>;
  debugHistoryDelete(historyId: string): Promise<boolean>;
  debugHistoryCleanup(): Promise<DebugHistoryCleanupResult>;
  debugHistoryPreferencesGet(): Promise<DebugHistoryPreferencesResult>;
  debugHistoryPreferencesUpdate(preferences: DebugHistoryPreferences): Promise<DebugHistoryPreferences>;
  debugHistoryRestore(input: DebugHistoryRestoreInput): Promise<DebugHistoryRestoreResult>;
  debugHistoryReplay(input: DebugHistoryReplayInput): Promise<DebugHistoryReplayResult>;
  runCollection(input: RunCollectionInput): Promise<RunResult>;
  runsList(): Promise<Array<RunSummaryDTO | StressRunSummaryDTO>>;
  runsGet(file: string): Promise<RunResult | StressReportDTO | null>;
  /** stress:run（M2-D3 任务 1）：main 进程执行压测，返回最终报告 + 落盘文件名；单活动约束（「已有压测进行中」）。 */
  stressRun(input: StressRunInput): Promise<StressRunResult>;
  /** stress:stop：abort 活动运行（停发新采样、等在途完成），返回部分报告；无活动运行抛「没有进行中的压测」。 */
  stressStop(): Promise<StressRunOutput>;
  credentialPut(input: CredentialPutInput): Promise<CredentialMutationResult>;
  credentialRemove(input: CredentialRefInput): Promise<CredentialMutationResult>;
  credentialStatus(input: CredentialRefInput): Promise<CredentialStatusResult>;
  oauthProfilesGet(input: OAuthProfilesGetInput): Promise<OAuthProfilesResult>;
  oauthProfileSave(input: OAuthProfileSaveInput): Promise<OAuthProfileMutationResult>;
  oauthProfileUnlink(input: OAuthProfileUnlinkInput): Promise<OAuthProfileMutationResult>;
  oauthProfileAcquire(input: OAuthProfileActionInput): Promise<OAuthProfileMutationResult>;
  oauthProfileRefresh(input: OAuthProfileActionInput): Promise<OAuthProfileMutationResult>;
  oauthAuthorizeBegin(input: OAuthAuthorizationBeginInput): Promise<OAuthAuthorizationSessionView>;
  oauthAuthorizeStatus(input: OAuthAuthorizationSessionId): Promise<OAuthAuthorizationSessionView | null>;
  oauthAuthorizeWait(input: OAuthAuthorizationSessionId): Promise<OAuthAuthorizationSessionView | null>;
  oauthAuthorizeCancel(input: OAuthAuthorizationSessionId): Promise<OAuthAuthorizationSessionView | null>;
  networkProfilesGet(locator: ProjectLocator): Promise<NetworkProfilesResult>;
  networkProfilesSave(input: NetworkProfilesSaveInput): Promise<NetworkProfilesSaveResult>;
  /** The main process opens/reads a secret file; no path or secret bytes cross IPC. */
  networkSecretImport(input: NetworkSecretImportInput): Promise<NetworkSecretImportResult>;
  importPreview(input: ImportPreviewInput): Promise<ImportPreviewResult>;
  importPlan(input: ImportPlanInput): Promise<ImportPlanResult>;
  importApply(input: ImportApplyInput): Promise<ImportApplyResult>;
  importUndo(input: ImportUndoInput): Promise<void>;
  /** project:clone：整项目深拷贝新 id 落回原分组，返回克隆体。 */
  projectClone(locator: ProjectLocator): Promise<ContractProject>;
  /** project:move：项目移入目标分组。 */
  projectMove(source: ProjectLocator, target: GroupLocator): Promise<void>;
  /** design:export：从当前项目已保存快照按格式/范围生成文档，经原生保存入口落盘；取消返回空串。 */
  designExport(input: DesignExportInput): Promise<string>;
  /** design:preview：仅在主进程克隆项目快照、替换当前草稿预览，不保存输入。 */
  designPreview(input: DesignPreviewInput): Promise<DesignPreviewResult>;
  /** 工作流频道（M2-B 任务 1）：语义与主进程 session 一致，错误文案逐字对齐。 */
  wfList(locator: ProjectLocator): Promise<WorkflowSummary[]>;
  wfGet(locator: WorkflowLocator): Promise<WorkflowDetail>;
  wfCreate(input: WfCreateInput): Promise<Workflow>;
  wfDelete(locator: WorkflowLocator): Promise<void>;
  /** wf:rename：同项目内改名（重名拒绝「工作流已存在: name」），落盘并清理旧目录。 */
  wfRename(locator: WorkflowLocator, name: string): Promise<Workflow>;
  /** wf:save：恒保持当前 status 不变（生命周期只经 wf:set-status），返回落盘后的工作流。 */
  wfSave(locator: WorkflowLocator, workflow: Workflow): Promise<Workflow>;
  wfSetStatus(locator: WorkflowLocator, next: WorkflowStatus): Promise<WfSetStatusResult>;
  wfImpact(input: WfImpactInput): Promise<WorkflowImpactEntryDTO[]>;
  /** wf:run：draft 拒绝（「工作流为草稿，请先发布启用」）；结果由主进程落盘 .apicc/runs。 */
  wfRun(input: WfRunInput): Promise<WorkflowRunResult>;
  // —— 在线频道（M3-B 任务 1，规格 §2 D9 / §3）：main 进程 onlineClient 的 IPC 出口 ——
  /** 注册（不建立登录态）。 */
  authConfig(baseUrl: string): Promise<{ allowRegistration: boolean }>;
  onlineRegister(input: OnlineRegisterChannelInput): Promise<OnlineUser>;
  /** 登录：token 留在 main 进程（tokenStore 持久化），出口只含 expiresAt + user。 */
  onlineLogin(input: OnlineLoginInput): Promise<OnlineLoginOutput>;
  /** 登出：吊销服务端 token + 清本地登录态。 */
  onlineLogout(): Promise<void>;
  /** 登录态恢复（任务 2 裁定 A）：存档 token 验活通过 → restored 携用户；失败/无存档 → signed-out（已清档），不抛。 */
  onlineResume(input: OnlineResumeInput): Promise<OnlineResumeOutput>;
  onlineMe(): Promise<OnlineUser>;
  onlineWorkspaceList(): Promise<OnlineWorkspaceSummary[]>;
  onlineWorkspaceCreate(input: OnlineWorkspaceCreateInput): Promise<OnlineWorkspaceCreated>;
  onlineTreeGet(workspaceId: string): Promise<OnlineTree>;
  onlineFilesGet(input: OnlineFilesGetInput): Promise<OnlineFilesResult>;
  /** 推送单文件：409 冲突不抛错，返回 { outcome: "conflict", conflict }（服务端现状过 IPC 不丢字段）。 */
  onlineFilePut(input: OnlineFilePutInput): Promise<OnlinePushOutcome>;
  /** 批量推送（≤200/批）：逐文件结果（pushed/conflict/forbidden/invalid），部分成功语义。 */
  onlineFilesBatch(input: OnlineFilesBatchInput): Promise<OnlineBatchResult>;
  onlineFileDelete(input: OnlineFileDeleteInput): Promise<OnlineDeleteOutcome>;
  // —— 在线工作区浏览/迁移（M3-B 任务 3，裁定 A/D/E）——
  /** 打开在线工作区：main 入表驻留并置活跃（计划 C 任务 1：不覆盖其他驻留工作区）并返回树视图。 */
  onlineWorkspaceOpen(input: OnlineWorkspaceOpenInput): Promise<OnlineWorkspaceView>;
  /** 显式激活驻留工作区（计划 C 任务 1）：纯切活跃指针；未驻留/未登录抛「尚未打开在线工作区」。 */
  onlineWorkspaceActivate(workspaceId: string): Promise<void>;
  /** 关闭在线工作区（计划 C 任务 1）：可带 workspaceId 出表指定工作区；无参关活跃。 */
  onlineWorkspaceClose(input?: { workspaceId?: string }): Promise<void>;
  /** 当前在线工作区视图（树缓存：首次取 /tree，之后复用；切换/推送后经此刷新）。 */
  onlineTreeView(workspaceId: string): Promise<OnlineWorkspaceView>;
  /** 扫描本地目录：/ 相对路径 + sha-256 + utf8 内容（跳过 .apicc/.git 生成物）+ 项目目录归属。 */
  onlineMigrateScan(dir: string): Promise<OnlineMigrateScanResult>;
  /** 迁移拉取落盘：按相对路径写目标目录（≤200/批；路径过契约规则，越界拒绝）。 */
  onlineMigrateWrite(input: OnlineMigrateWriteInput): Promise<{ written: string[] }>;
  /** 迁移映射桥（计划 C 任务 2）：本地名称目录二元组 → 服务端实体（行级三态：建成/missing/forbidden）。 */
  onlineProjectMapping(input: OnlineProjectMappingInput): Promise<OnlineMappingResult>;
  /** 组织分组只读清单（计划 C 任务 2 迁移拉取：groupId → 组名反查）。 */
  onlineGroupsList(workspaceId: string): Promise<OnlineGroup[]>;
  // —— AI 频道（M6-C 任务 1 登记 / 任务 2 真链路，规格 §2 D2/D4）——
  /** 保存 AI 配置：baseUrl/model 由渲染层 localStorage 持久化；apiKey 非空时经 main 入安全存储（省略/空串 = 保持既有）。 */
  aiSaveConfig(input: AiSaveConfigInput): Promise<AiKeyStatus>;
  /** 读取 AI 配置状态：key 只以 hasKey 表达，明文永不回传渲染层（裁定②）。 */
  aiGetConfig(): Promise<AiKeyStatus>;
  /** AI 建议用例（任务 2 真链路）：main 以 safeStorage key + 随调用的已保存配置构造 core provider → suggestCases；配置缺失抛可读错误。 */
  aiSuggest(input: AiSuggestInput): Promise<AiSuggestedCase[]>;
  /** 连接轻量探测（任务 2）：最小 completions（内容不解析）；resolve 即可用，失败抛 provider 归一化可读错误。 */
  aiTestConfig(input: AiTestConfigInput): Promise<AiTestConfigResult>;
  // —— 插件频道（M7-B 任务 1 登记 / 任务 2 真加载器，规格 §2 D3/D5）——
  /**
   * 插件加载摘要：plugins 为 loaded/failed 混合清单（D3 诊断可见面），importers 为
   * registry 导入器名枚举（内置 + 插件贡献，导入向导选择面动态枚举数据源，D5）。
   * 任务 1 为 fixture 桩；任务 2 切 core 加载器真实现，出口形状不变。
   */
  pluginsList(): Promise<PluginsListResult>;
  // —— 退出程序 dirty 拦截（计划 C 任务 6，不变量 6）——
  /**
   * 注册渲染层 dirty 应答器：main 关窗拦截后经 app:dirty-check 下行询问，handler 同步
   * 计算聚合 dirty（editor 任一会话槽 + workflowDesign + online 各驻留会话任一缓冲槽）
   * 经 app:dirty-check:reply 上行回传。内存替身为登记 no-op（jsdom 无 main 询问链路）。
   */
  onDirtyCheck(handler: () => boolean): void;
}

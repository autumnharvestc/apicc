import type {
  ApiDefinition,
  CaseOutcome,
  Environment,
  LoadProblem,
  Project,
  RunResult,
  StressReport,
  Workflow,
  WorkflowImpactEntry,
  WorkflowRunResult,
  WorkflowStatus,
  WorkspaceGlobals,
  ProjectGlobals,
} from "@apicc/core";
import type { TreeNodeDTO } from "./tree-dto.js";
import type { KeyValuePair } from "@apicc/core";

/** 容器保存载荷（M10）：模块（集合）= 变量+操作；文件夹 = 操作。id 定位，整体替换。 */
export interface ContainerSaveInput {
  kind: "collection" | "folder";
  id: string;
  /** 仅 containerGet 回填供对话框标题展示；save 侧忽略。 */
  name?: string;
  variables?: Record<string, string>;
  preOperations: Array<{ id: string; type: "script"; content: string }>;
  postOperations: Array<{ id: string; type: "script"; content: string }>;
}

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
  OnlineLoginInput,
  OnlineLoginOutput,
  OnlineMigrateScanResult,
  OnlineMigrateWriteInput,
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

export interface OpenResult { workspace: { id: string; name: string }; problems: LoadProblem[]; root: string }
export interface ApiDetail { api: ApiDefinition; envs: Array<{ id: string; name: string }> }
export interface NodeCreateInput {
  kind: "group" | "project" | "collection" | "folder" | "api";
  parentId: string | null;
  name: string;
  method?: string;
  url?: string;
}
export interface DebugInput { apiId: string; caseId: string; envName?: string }
/** env:create 入参：extends 按环境名引用父环境（规格 §6 继承链，运行时由 Runner 合并）。 */
export interface EnvCreateInput { projectId: string; name: string; extends?: string }
/** 响应快照：随 afterResponse 事件捕获，ResponseViewer 用真实数据替换「—」占位。 */
export interface ResponseSnapshot { status: number; headers: Record<string, string>; bodyText: string; timeMs: number }
export interface DebugOutput { run: RunResult; outcome: CaseOutcome; response?: ResponseSnapshot }
/** run:collection 入参：envName 按环境名引用（与 DebugInput 同语义，规格 §6）。 */
export interface RunCollectionInput { collectionId: string; envName?: string }
/**
 * runs:list 行摘要（集合运行）：与 src/main/runs.ts 同名接口结构同构（IPC 结构化克隆传输，
 * 字段变更需双侧同步）；结构漂移由 ipc.ts runs:list 分支的 satisfies 校验兜底。
 * kind 必填（M2-D3 任务 1）：运行历史按 kind 区分集合/压测两类报告（规格 §2 D11）。
 */
export interface RunSummaryDTO { kind: "collection"; file: string; collectionName: string; startedAt: string; total: number; passed: number; failed: number }
/**
 * runs:list 行摘要（压测，M2-D3 任务 1）：startedAt 为 report.startedAt（epoch ms）格式化的
 * ISO 字符串，与集合行的 startedAt 同口径排序。
 */
export interface StressRunSummaryDTO { kind: "stress"; file: string; startedAt: string; totalRequests: number; ok: number; failed: number; rps: number }
export type RunSummary = RunSummaryDTO | StressRunSummaryDTO;

/** stress:run 入参：maxIterations/durationMs 至少给其一（都给先到先停），二者可传 null（渲染层「清空」惯例）。 */
export interface StressRunInput { apiId: string; caseId: string; envName?: string; concurrency: number; maxIterations?: number | null; durationMs?: number | null }
/**
 * stress:run / stress:stop 返回：最终（或中止后的部分）报告 + 落盘文件名。
 * 落盘降级不影响报告返回，与集合运行口径一致（core Runner 落盘失败仅告警仍返回完整结果）：
 * file 落盘成功为文件名（.apicc/runs/stress-<apiId>-<ts>.json），降级时省略。
 */
export interface StressRunOutput { report: StressReport; file?: string }
/** runs:get 对 stress 文件的返回：kind 判别 + 完整压测报告（集合文件返回既有 RunResult 形状）。 */
export interface StressReportDTO { kind: "stress"; report: StressReport }

/** import:preview 入参：渲染层经 input[type=file] 读出文本与文件名（不新增文件选择 IPC）。 */
export interface ImportPreviewInput { fileName: string; content: string }
/** import:preview 返回：命中的导入器名 + 解析产物（id 均为新生成 UUID）+ 警告列表。 */
export interface ImportPreviewResult { importerName: string; project: Project; warnings: string[] }
/** import:apply 入参（轨二双模式）：project=整包落到所选分组（name=项目名，预填 title 可改）；
 * module=产物集合改名后并入目标项目（baseUrl 进模块变量、不造环境）。同名并存（同名放开）。 */
export type ImportApplyInput =
  | { mode: "project"; groupId: string; name: string; project: Project }
  | { mode: "module"; projectId: string; name: string; project: Project };

/** wf:list 行摘要：工作流列表（侧树「工作流」分组与列表视图共用，规格 §3）。 */
export interface WorkflowSummary { id: string; name: string; status: WorkflowStatus }
/** wf:get 返回：完整工作流 + 所属项目 id（设计器级联数据按项目定位）。 */
export interface WorkflowDetail { workflow: Workflow; projectId: string }
/** wf:create 入参：目标项目 + 工作流名（同项目重名拒绝「工作流已存在: name」）。 */
export interface WfCreateInput { projectId: string; name: string }
/**
 * wf:set-status 返回：迁移后的工作流 + 启用校验错误/警告。
 * published→enabled 校验未过时 workflow 为状态不变的原工作流、errors 非空；
 * 非法迁移（如 draft→enabled 跳级）不落在此形状——session 直接抛错（UI 按钮禁用本不应触发）。
 */
export interface WfSetStatusResult { workflow: Workflow; errors: string[]; warnings: string[] }
/** wf:impact 入参：按用例/接口 id 反查工作流引用（规格 §3.1 影响分析）。 */
export interface WfImpactInput { caseId?: string; apiId?: string }
/** wf:run 入参：envName 按环境名引用（与 DebugInput 同语义，规格 §6）。 */
export interface WfRunInput { workflowId: string; envName?: string }

/**
 * nodeCreate 统一返回的瘦节点 DTO（宽审查 I2：ipc 与 memory 契约一致的单一事实源）。
 * kind 与 TreeNodeDTO 的节点子集对齐（不含 root；workflow 亦非 node:create 产物，同样排除），
 * 与请求 input.kind 恒等。
 */
export interface NodeCreatedDTO {
  kind: Exclude<TreeNodeDTO["kind"], "root" | "workflow">;
  id: string;
  label: string;
  method?: string;
}

export interface ApiccApi {
  wsOpen(rootPath: string): Promise<OpenResult>;
  wsCreate(rootPath: string, name: string): Promise<OpenResult>;
  wsPickDirectory(): Promise<string>;
  wsValidate(): Promise<LoadProblem[]>;
  treeGet(): Promise<TreeNodeDTO>;
  nodeCreate(input: NodeCreateInput): Promise<NodeCreatedDTO>;
  nodeRename(kind: "group" | "project" | "collection" | "folder" | "api" | "environment", id: string, name: string): Promise<void>;
  nodeDelete(kind: "group" | "project" | "collection" | "folder" | "api" | "environment", id: string): Promise<void>;
  envCreate(input: EnvCreateInput): Promise<Environment>;
  envVarsSave(envId: string, variables: Record<string, string>): Promise<void>;
  envBaseUrlsSave(envId: string, baseUrls: Record<string, string>): Promise<void>;
  globalsSave(projectId: string, globals: ProjectGlobalSettings): Promise<void>;
  containerSave(input: ContainerSaveInput): Promise<void>;
  containerGet(kind: "collection" | "folder", id: string): Promise<ContainerSaveInput>;
  globalsGet(projectId: string): Promise<ProjectGlobalSettings>;
  apiGet(apiId: string): Promise<ApiDetail>;
  apiSave(api: ApiDefinition): Promise<void>;
  debugSend(input: DebugInput): Promise<DebugOutput>;
  runCollection(input: RunCollectionInput): Promise<RunResult>;
  runsList(): Promise<Array<RunSummaryDTO | StressRunSummaryDTO>>;
  runsGet(file: string): Promise<RunResult | StressReportDTO | null>;
  /** stress:run（M2-D3 任务 1）：main 进程执行压测，返回最终报告 + 落盘文件名；单活动约束（「已有压测进行中」）。 */
  stressRun(input: StressRunInput): Promise<StressRunOutput>;
  /** stress:stop：abort 活动运行（停发新采样、等在途完成），返回部分报告；无活动运行抛「没有进行中的压测」。 */
  stressStop(): Promise<StressRunOutput>;
  importPreview(input: ImportPreviewInput): Promise<ImportPreviewResult>;
  importApply(input: ImportApplyInput): Promise<void>;
  /** project:clone：整项目深拷贝新 id 落回原分组，返回克隆体。 */
  projectClone(projectId: string): Promise<Project>;
  /** project:move：项目移入目标分组。 */
  projectMove(projectId: string, targetGroupId: string): Promise<void>;
  /** design:export：主进程渲染 agent 设计 md → showSaveDialog 落盘；返回保存路径（取消为空串）。 */
  designExport(apiId: string): Promise<string>;
  /** 工作流频道（M2-B 任务 1）：语义与主进程 session 一致，错误文案逐字对齐。 */
  wfList(projectId: string): Promise<WorkflowSummary[]>;
  wfGet(workflowId: string): Promise<WorkflowDetail>;
  wfCreate(input: WfCreateInput): Promise<Workflow>;
  wfDelete(workflowId: string): Promise<void>;
  /** wf:rename：同项目内改名（重名拒绝「工作流已存在: name」），落盘并清理旧目录。 */
  wfRename(workflowId: string, name: string): Promise<void>;
  /** wf:save：恒保持当前 status 不变（生命周期只经 wf:set-status），返回落盘后的工作流。 */
  wfSave(workflow: Workflow): Promise<Workflow>;
  wfSetStatus(workflowId: string, next: WorkflowStatus): Promise<WfSetStatusResult>;
  wfImpact(input: WfImpactInput): Promise<WorkflowImpactEntry[]>;
  /** wf:run：draft 拒绝（「工作流为草稿，请先发布启用」）；结果由主进程落盘 .apicc/runs。 */
  wfRun(input: WfRunInput): Promise<WorkflowRunResult>;
  // —— 在线频道（M3-B 任务 1，规格 §2 D9 / §3）：main 进程 onlineClient 的 IPC 出口 ——
  /** 注册（不建立登录态）。 */
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
  /** 打开在线工作区：main 记录当前工作区（与本地互斥，ws:open 链路反向清理）并返回树视图。 */
  onlineWorkspaceOpen(input: OnlineWorkspaceOpenInput): Promise<OnlineWorkspaceView>;
  /** 关闭在线工作区：清 main 侧状态与树/文件缓存。 */
  onlineWorkspaceClose(): Promise<void>;
  /** 当前在线工作区视图（树缓存：首次取 /tree，之后复用；切换/推送后经此刷新）。 */
  onlineTreeView(workspaceId: string): Promise<OnlineWorkspaceView>;
  /** 扫描本地目录：/ 相对路径 + sha-256 + utf8 内容（跳过 .apicc/.git 生成物）。 */
  onlineMigrateScan(dir: string): Promise<OnlineMigrateScanResult>;
  /** 迁移拉取落盘：按相对路径写目标目录（≤200/批；路径过契约规则，越界拒绝）。 */
  onlineMigrateWrite(input: OnlineMigrateWriteInput): Promise<{ written: string[] }>;
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
}

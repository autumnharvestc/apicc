import type {
  ApiDefinition,
  CaseOutcome,
  Environment,
  LoadProblem,
  Project,
  RunResult,
  Workflow,
  WorkflowImpactEntry,
  WorkflowRunResult,
  WorkflowStatus,
} from "@apicc/core";
import type { TreeNodeDTO } from "./tree-dto.js";

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
 * runs:list 行摘要：与 src/main/runs.ts 同名接口结构同构（IPC 结构化克隆传输，字段变更
 * 需双侧同步）；结构漂移由 ipc.ts runs:list 分支的 satisfies 校验兜底。
 */
export interface RunSummaryDTO { file: string; collectionName: string; startedAt: string; total: number; passed: number; failed: number }

/** import:preview 入参：渲染层经 input[type=file] 读出文本与文件名（不新增文件选择 IPC）。 */
export interface ImportPreviewInput { fileName: string; content: string }
/** import:preview 返回：命中的导入器名 + 解析产物（id 均为新生成 UUID）+ 警告列表。 */
export interface ImportPreviewResult { importerName: string; project: Project; warnings: string[] }
/** import:apply 入参：目标分组（不存在则创建）+ 预览产出的项目。 */
export interface ImportApplyInput { groupName: string; project: Project }

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
  apiGet(apiId: string): Promise<ApiDetail>;
  apiSave(api: ApiDefinition): Promise<void>;
  debugSend(input: DebugInput): Promise<DebugOutput>;
  runCollection(input: RunCollectionInput): Promise<RunResult>;
  runsList(): Promise<RunSummaryDTO[]>;
  runsGet(file: string): Promise<RunResult | null>;
  importPreview(input: ImportPreviewInput): Promise<ImportPreviewResult>;
  importApply(input: ImportApplyInput): Promise<void>;
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
}

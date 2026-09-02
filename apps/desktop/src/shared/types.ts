import type { ApiDefinition, CaseOutcome, Environment, LoadProblem, RunResult } from "@apicc/core";
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

/**
 * nodeCreate 统一返回的瘦节点 DTO（宽审查 I2：ipc 与 memory 契约一致的单一事实源）。
 * kind 与 TreeNodeDTO 的节点子集对齐（不含 root），与请求 input.kind 恒等。
 */
export interface NodeCreatedDTO {
  kind: Exclude<TreeNodeDTO["kind"], "root">;
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
}

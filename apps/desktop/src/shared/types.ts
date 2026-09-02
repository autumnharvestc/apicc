import type { ApiDefinition, CaseOutcome, LoadProblem, RunResult } from "@apicc/core";
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
export interface DebugOutput { run: RunResult; outcome: CaseOutcome }

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
  apiGet(apiId: string): Promise<ApiDetail>;
  apiSave(api: ApiDefinition): Promise<void>;
  debugSend(input: DebugInput): Promise<DebugOutput>;
}

import type { WorkflowStatus } from "@apicc/core";

/** 渲染层树节点 DTO：主进程与渲染层共享的单一类型源。 */
export interface TreeNodeDTO {
  /**
   * kind：本地树使用 root/group/project/collection/folder/api/workflow；
   * file（M3-B 任务 3）为在线工作区只读配置叶（工作流/环境/项目/集合配置等，
   * 仅本地在线模式产生，id = 文件全路径），本地树永不产出。
   */
  kind: "root" | "group" | "project" | "collection" | "folder" | "api" | "workflow" | "file";
  id: string;
  label: string;
  method?: string;
  /** project 节点环境：含 extends（按环境名引用，规格 §6）与已存 variables，供环境面板水合。 */
  envs?: Array<{ id: string; name: string; extends?: string; variables: Record<string, string>; baseUrls?: Record<string, string> }>;
  /**
   * project 节点工作流摘要（M2-B 收口：侧树发现/打开工作流的数据源）。与 children 分离：
   * SideTree 据此在 project children 尾部合成 workflow 叶子节点（不落 children，避免
   * 主进程树与集合层级耦合）。
   */
  workflows?: Array<{ id: string; name: string; status: WorkflowStatus }>;
  /** workflow 叶子（SideTree 由 workflows 摘要合成的节点）状态：渲染状态徽标色点。 */
  status?: WorkflowStatus;
  children?: TreeNodeDTO[];
}

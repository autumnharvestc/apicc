/** 渲染层树节点 DTO：主进程与渲染层共享的单一类型源。 */
export interface TreeNodeDTO {
  kind: "root" | "group" | "project" | "collection" | "folder" | "api";
  id: string;
  label: string;
  method?: string;
  envs?: Array<{ id: string; name: string }>;
  children?: TreeNodeDTO[];
}

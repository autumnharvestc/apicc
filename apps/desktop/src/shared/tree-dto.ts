/** 渲染层树节点 DTO：主进程与渲染层共享的单一类型源。 */
export interface TreeNodeDTO {
  kind: "root" | "group" | "project" | "collection" | "folder" | "api";
  id: string;
  label: string;
  method?: string;
  /** project 节点环境：含 extends（按环境名引用，规格 §6）与已存 variables，供环境面板水合。 */
  envs?: Array<{ id: string; name: string; extends?: string; variables: Record<string, string> }>;
  children?: TreeNodeDTO[];
}

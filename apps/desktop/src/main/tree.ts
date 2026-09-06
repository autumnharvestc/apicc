import type { Workspace } from "@apicc/core";
import type { TreeNodeDTO } from "../shared/tree-dto.js";

export type { TreeNodeDTO };

export function toTreeNode(ws: Workspace): TreeNodeDTO {
  return {
    kind: "root",
    id: ws.id,
    label: ws.name,
    children: ws.groups.map((g) => ({
      kind: "group" as const, id: g.id, label: g.name,
      children: g.projects.map((p) => ({
        kind: "project" as const, id: p.id, label: p.name,
          envs: p.environments.map((e) => ({ id: e.id, name: e.name, extends: e.extends, variables: e.variables, baseUrls: e.baseUrls })),
          // 工作流摘要（M2-B 收口）：SideTree 据此在 project children 尾部合成 workflow 叶子。
          workflows: p.workflows.map((w) => ({ id: w.id, name: w.name, status: w.status })),
          children: p.collections.map((c) => ({
          kind: "collection" as const, id: c.id, label: c.name,
          children: [
            ...c.apis.map((a) => ({ kind: "api" as const, id: a.id, label: a.name, method: a.method })),
            ...c.folders.map((f) => ({
              kind: "folder" as const, id: f.id, label: f.name,
              children: f.apis.map((a) => ({ kind: "api" as const, id: a.id, label: a.name, method: a.method })),
            })),
          ],
        })),
      })),
    })),
  };
}

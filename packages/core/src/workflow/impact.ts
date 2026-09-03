import type { Workspace } from "../domain/model.js";

export interface WorkflowImpactEntry {
  workflowId: string; workflowName: string; status: string;
  nodeId: string; nodeLabel?: string;
}

/** 反查某用例/接口被哪些工作流节点引用（规格 §3.1 影响分析；删除/修改前供 CLI 与 UI 提醒）。 */
export function workflowImpact(workspace: Workspace, ref: { caseId?: string; apiId?: string }): WorkflowImpactEntry[] {
  const hits: WorkflowImpactEntry[] = [];
  for (const g of workspace.groups) for (const p of g.projects) for (const wf of p.workflows) {
    for (const n of wf.nodes) {
      if (n.kind !== "request") continue;
      const hit = (ref.caseId !== undefined && n.caseId === ref.caseId)
        || (ref.apiId !== undefined && n.apiId === ref.apiId);
      if (hit) hits.push({ workflowId: wf.id, workflowName: wf.name, status: wf.status, nodeId: n.id, nodeLabel: n.label });
    }
  }
  return hits;
}

import type { Workflow, WorkflowNode, WorkflowEdge } from "./model.js";
import type { Workspace } from "../domain/model.js";

export interface ValidationIssue { level: "error" | "warning"; code: string; message: string }

/** 结构校验：环（error）/ 边端点（error）/ 孤立节点与完全重复边（warning）。 */
export function validateWorkflowStructure(wf: Workflow): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const ids = new Set(wf.nodes.map((n) => n.id));

  for (const e of wf.edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) {
      issues.push({ level: "error", code: "edge-endpoint", message: `边 ${e.id} 端点不存在: ${e.from} → ${e.to}` });
    }
  }

  // 环检测：仅对端点完整的边做 DFS
  const adj = new Map<string, string[]>();
  for (const e of wf.edges) {
    if (ids.has(e.from) && ids.has(e.to)) {
      adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
    }
  }
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const dfs = (node: string) => {
    state.set(node, "visiting");
    path.push(node);
    for (const next of adj.get(node) ?? []) {
      if (state.get(next) === "visiting") {
        const start = path.indexOf(next);
        issues.push({ level: "error", code: "cycle", message: `检测到环: ${[...path.slice(start), next].join(" → ")}` });
      } else if (!state.has(next)) {
        dfs(next);
      }
    }
    path.pop();
    state.set(node, "done");
  };
  for (const n of wf.nodes) if (!state.has(n.id)) dfs(n.id);

  // 孤立节点：无入边且无出边
  const hasInOut = new Set(wf.edges.flatMap((e) => [e.from, e.to]));
  for (const n of wf.nodes) {
    if (!hasInOut.has(n.id) && wf.nodes.length > 1) {
      issues.push({ level: "warning", code: "isolated-node", message: `节点「${n.label ?? n.id}」没有任何连线（孤立节点）` });
    }
  }

  // 完全重复边（同 from/to/condition）
  const seen = new Map<string, number>();
  for (const e of wf.edges) {
    const key = `${e.from}\u0000${e.to}\u0000${e.condition ?? ""}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (seen.get(key) === 2) {
      issues.push({ level: "warning", code: "duplicate-edge", message: `存在完全重复的边: ${e.from} → ${e.to}` });
    }
  }
  return issues;
}

export type { WorkflowNode, WorkflowEdge };

/** 三态生命周期迁移表：draft→published→enabled 单向；enabled→published = 解除启用。 */
const TRANSITIONS: Record<string, Workflow["status"][]> = {
  draft: ["published"],
  published: ["enabled"],
  enabled: ["published"], // 解除启用
};

export interface EnablementResult { ok: boolean; errors: string[]; warnings: string[] }

/** 状态迁移守卫：跳级/回退（除解除启用）拒绝；published→enabled 必须注入且通过启用校验结果。 */
export function transitionWorkflowStatus(
  wf: Workflow,
  next: Workflow["status"],
  enablement?: EnablementResult,
): Workflow {
  const allowed = TRANSITIONS[wf.status] ?? [];
  if (!allowed.includes(next)) {
    throw new Error(`非法状态迁移: ${wf.status} → ${next}（允许: ${allowed.join(", ") || "无"}）`);
  }
  if (next === "enabled") {
    const check = enablement ?? { ok: false, errors: ["未提供启用校验结果"], warnings: [] };
    if (!check.ok) throw new Error(`启用校验未通过: ${check.errors.join("; ")}`);
  }
  return { ...wf, status: next };
}

/** 启用校验：结构校验的 error/warning 并入结果，另校验 request 节点的接口/用例引用存在性。 */
export function validateEnablement(wf: Workflow, workspace: Workspace): EnablementResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const issues = validateWorkflowStructure(wf);
  errors.push(...issues.filter((i) => i.level === "error").map((i) => i.message));
  warnings.push(...issues.filter((i) => i.level === "warning").map((i) => i.message));

  // 三层查找：collections 直属 apis 与 folder apis 两种归属都要覆盖。
  const findCase = (apiId: string, caseId: string): boolean => {
    for (const g of workspace.groups) {
      for (const p of g.projects) {
        for (const c of p.collections) {
          const direct = c.apis.find((a) => a.id === apiId);
          if (direct?.cases.some((x) => x.id === caseId)) return true;
          for (const f of c.folders) {
            const fApi = f.apis.find((a) => a.id === apiId);
            if (fApi?.cases.some((x) => x.id === caseId)) return true;
          }
        }
      }
    }
    return false;
  };

  for (const n of wf.nodes) {
    if (n.kind !== "request") continue;
    if (!n.apiId || !n.caseId) {
      errors.push(`节点「${n.label ?? n.id}」缺少接口/用例引用`);
      continue;
    }
    if (!findCase(n.apiId, n.caseId)) {
      errors.push(`节点「${n.label ?? n.id}」引用的接口/用例不存在（apiId=${n.apiId}, caseId=${n.caseId}）`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

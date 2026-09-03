import type { Workflow, WorkflowNode, WorkflowEdge } from "./model.js";

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

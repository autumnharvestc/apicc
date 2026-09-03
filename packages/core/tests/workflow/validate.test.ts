import { describe, expect, it } from "vitest";
import { transitionWorkflowStatus, validateEnablement, validateWorkflowStructure } from "../../src/workflow/validate.js";
import type { Workflow } from "../../src/workflow/model.js";
import type { Workspace } from "../../src/domain/model.js";

function wf(nodes: Workflow["nodes"], edges: Workflow["edges"]): Workflow {
  return { id: "w", name: "wf", status: "draft", nodes, edges };
}
const req = (id: string) => ({ id, kind: "request" as const, apiId: `a-${id}`, caseId: `c-${id}` });

describe("validateWorkflowStructure", () => {
  it("合法链式图零 error 零 warning", () => {
    const issues = validateWorkflowStructure(wf([req("n1"), req("n2")], [{ id: "e", from: "n1", to: "n2" }]));
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    expect(issues.filter((i) => i.level === "warning")).toEqual([]);
  });

  it("环报 error（含路径）", () => {
    const issues = validateWorkflowStructure(wf([req("a"), req("b")], [
      { id: "e1", from: "a", to: "b" }, { id: "e2", from: "b", to: "a" },
    ]));
    expect(issues.some((i) => i.level === "error" && i.code === "cycle" && /检测到环: a → b → a/.test(i.message))).toBe(true);
  });

  it("单节点工作区不报 isolated-node", () => {
    const issues = validateWorkflowStructure(wf([req("only")], []));
    expect(issues.some((i) => i.level === "warning" && i.code === "isolated-node")).toBe(false);
    expect(issues).toEqual([]);
  });

  it("同向不同条件的多条边合法（多条件分支，不报 duplicate-edge）", () => {
    const issues = validateWorkflowStructure(wf([req("a"), req("b")], [
      { id: "e1", from: "a", to: "b", condition: "prev.passed" },
      { id: "e2", from: "a", to: "b", condition: "false" },
    ]));
    expect(issues.some((i) => i.level === "warning" && i.code === "duplicate-edge")).toBe(false);
  });

  it("幽灵端点的边不参与环检测（只报 edge-endpoint，不报 cycle）", () => {
    const issues = validateWorkflowStructure(wf([req("a"), req("b")], [
      { id: "e1", from: "a", to: "b" },
      { id: "e2", from: "b", to: "ghost" },
      { id: "e3", from: "ghost", to: "a" },
    ]));
    const errors = issues.filter((i) => i.level === "error");
    expect(errors.length).toBe(2);
    expect(errors.every((i) => i.code === "edge-endpoint")).toBe(true);
    expect(issues.some((i) => i.code === "cycle")).toBe(false);
  });

  it("边端点不存在报 error", () => {
    const issues = validateWorkflowStructure(wf([req("a")], [{ id: "e", from: "a", to: "ghost" }]));
    expect(issues.some((i) => i.level === "error" && i.code === "edge-endpoint")).toBe(true);
  });

  it("孤立节点报 warning", () => {
    const issues = validateWorkflowStructure(wf([req("a"), req("lonely")], []));
    expect(issues.some((i) => i.level === "warning" && i.code === "isolated-node")).toBe(true);
  });

  it("重复边报 warning（同 from-to 多条合法用于多条件，完全同向同条件才告警）", () => {
    const issues = validateWorkflowStructure(wf([req("a"), req("b")], [
      { id: "e1", from: "a", to: "b", condition: "prev.passed" },
      { id: "e2", from: "a", to: "b", condition: "prev.passed" },
    ]));
    expect(issues.some((i) => i.level === "warning" && i.code === "duplicate-edge")).toBe(true);
  });
});

// 生命周期/启用校验共用的单一定义辅助（合并原 wf 局部函数，status 缺省 published）。
const wfFactory = (nodes: Workflow["nodes"], edges: Workflow["edges"], status: Workflow["status"] = "published"): Workflow =>
  ({ id: "w", name: "wf", status, nodes, edges });

describe("transitionWorkflowStatus", () => {
  it("draft→published→enabled 合法；跳级拒绝", () => {
    expect(transitionWorkflowStatus(wfFactory([], [], "draft"), "published").status).toBe("published");
    expect(() => transitionWorkflowStatus(wfFactory([], [], "draft"), "enabled")).toThrow(/draft.*enabled/);
  });
  it("published→enabled 需启用校验通过（注入校验结果）", () => {
    expect(() => transitionWorkflowStatus(wfFactory([], []), "enabled", { ok: false, errors: ["节点 n1 引用缺失"], warnings: [] }))
      .toThrow(/节点 n1 引用缺失/);
    expect(transitionWorkflowStatus(wfFactory([], []), "enabled", { ok: true, errors: [], warnings: [] }).status).toBe("enabled");
  });
  it("enabled→published（解除启用）合法；draft→draft 拒绝", () => {
    expect(transitionWorkflowStatus(wfFactory([], [], "enabled"), "published").status).toBe("published");
    expect(() => transitionWorkflowStatus(wfFactory([], [], "draft"), "draft")).toThrow();
  });
});

describe("validateEnablement", () => {
  const workspaceWith = (apis: Array<{ id: string }>, cases: Array<{ id: string; apiId: string }>): Workspace =>
    ({ id: "w", name: "w", variables: {}, groups: [{ id: "g", name: "g", projects: [{ id: "p", name: "p", variables: {}, environments: [], collections: apis.map((a) => ({ id: a.id, name: a.id, variables: {}, folders: [], apis: [{ id: a.id, name: a.id, version: "1", deprecated: false, method: "GET", url: "/", headers: [], query: [], cases: cases.filter((c) => c.apiId === a.id).map((c) => ({ id: c.id, name: c.id, scope: "base", parameters: {}, assertions: [] })) }] })), workflows: [] }] }] } as unknown as Workspace);

  it("空工作流（0 节点）不可启用 → ok=false 且 errors 含「没有任何节点」", () => {
    // 规格 §5 第 5 条（2026-09-03 增补）：空流没有可执行编排语义，启用必被拒
    const r = validateEnablement(wfFactory([], []), workspaceWith([], []));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /没有任何节点/.test(e))).toBe(true);
  });

  it("全部节点引用存在且图合法 → ok", () => {
    const wf = wfFactory([req("n1")], []);
    // n1 引用 a-n1/c-n1（workspaceWith 已含）
    const r = validateEnablement(wf, workspaceWith([{ id: "a-n1" }], [{ id: "c-n1", apiId: "a-n1" }]));
    expect(r.ok).toBe(true);
  });

  it("missing 引用与环 → ok=false 且 errors 齐全", () => {
    const wf = wfFactory([req("n1"), req("n2")], [{ id: "e1", from: "n1", to: "n2" }, { id: "e2", from: "n2", to: "n1" }]);
    const r = validateEnablement(wf, workspaceWith([], []));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /环/.test(e))).toBe(true);
    expect(r.errors.some((e) => /不存在/.test(e))).toBe(true);
  });

  it("两个连通分量（a→b 与 c→d）：无单一起始节点可达全部 → ok=false 且 errors 含「不可达」", () => {
    // 规格 §5.4 第 4 条：至少一个起始节点可达全部非孤立节点。
    // 两分量均有边（非孤立），但任一起始节点都够不着另一个分量 → 启用校验必须失败。
    const wf = wfFactory([req("a"), req("b"), req("c"), req("d")], [
      { id: "e1", from: "a", to: "b" },
      { id: "e2", from: "c", to: "d" },
    ]);
    const r = validateEnablement(wf, workspaceWith([], []));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => /不可达/.test(e))).toBe(true);
  });

  it("孤立节点不触发可达性 error：仍仅 warning，ok 不受影响", () => {
    const wf = wfFactory([req("a"), req("b"), req("z")], [{ id: "e1", from: "a", to: "b" }]);
    const r = validateEnablement(wf, workspaceWith(
      [{ id: "a-a" }, { id: "a-b" }, { id: "a-z" }],
      [{ id: "c-a", apiId: "a-a" }, { id: "c-b", apiId: "a-b" }, { id: "c-z", apiId: "a-z" }],
    ));
    expect(r.ok).toBe(true);
    expect(r.errors.some((e) => /不可达/.test(e))).toBe(false);
    expect(r.warnings.some((w) => /孤立节点/.test(w))).toBe(true);
  });
});

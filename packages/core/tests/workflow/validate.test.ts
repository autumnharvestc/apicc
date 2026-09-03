import { describe, expect, it } from "vitest";
import { validateWorkflowStructure } from "../../src/workflow/validate.js";
import type { Workflow } from "../../src/workflow/model.js";

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
    expect(issues.some((i) => i.level === "error" && i.code === "cycle" && /a/.test(i.message))).toBe(true);
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

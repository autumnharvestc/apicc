import { describe, expect, it } from "vitest";
import { WorkflowSchema, WorkflowStatusSchema } from "../../src/workflow/model.js";

describe("工作流 schema", () => {
  it("接受合法工作流并填充默认值", () => {
    const wf = WorkflowSchema.parse({
      id: "w1", name: "下单流程",
      nodes: [
        { id: "n1", kind: "request", apiId: "a1", caseId: "c1", label: "登录" },
        { id: "n3", kind: "noop", label: "退款占位" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n3" }],
    });
    expect(wf.status).toBe("draft");
    expect(wf.nodes[1]!.kind).toBe("noop");
    expect(wf.edges[0]!.condition).toBeUndefined();
  });

  it("拒绝未知字段与非法状态/节点类型", () => {
    expect(() => WorkflowSchema.parse({ id: "w", name: "x", nonsense: 1 })).toThrow();
    expect(() => WorkflowStatusSchema.parse("archived")).toThrow();
    expect(() => WorkflowSchema.parse({ id: "w", name: "x", nodes: [{ id: "n", kind: "timer" }], edges: [] })).toThrow();
  });

  it("position 字段（M2-B 预留）合法且可选", () => {
    const wf = WorkflowSchema.parse({
      id: "w", name: "x",
      nodes: [{ id: "n", kind: "request", apiId: "a", caseId: "c", position: { x: 10, y: -20 } }],
      edges: [],
    });
    expect(wf.nodes[0]!.position).toEqual({ x: 10, y: -20 });
  });
});

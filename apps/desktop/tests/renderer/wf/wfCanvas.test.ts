import { describe, expect, it } from "vitest";
import { toFlowElements, applyNodeAdd, applyNodeRemove, applyEdgeAdd, applyEdgeRemove, colorForState } from "../../../src/renderer/src/wf/wfCanvas.js";
import type { Workflow } from "@apicc/core";

const wf: Workflow = {
  id: "w", name: "流", status: "enabled",
  nodes: [
    { id: "n1", kind: "request", apiId: "a1", caseId: "c1", label: "登录", position: { x: 0, y: 0 } },
    { id: "n2", kind: "noop", label: "占位", position: { x: 200, y: 0 } },
  ],
  edges: [{ id: "e1", from: "n1", to: "n2", condition: "prev.passed" }],
};

describe("toFlowElements", () => {
  it("Workflow → Vue Flow 元素：节点带 position/自定义 data，边带 condition 标签数据", () => {
    const { nodes, edges } = toFlowElements(wf);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ id: "n1", position: { x: 0, y: 0 }, data: { node: wf.nodes[0], missing: false } });
    expect(edges[0]).toMatchObject({ id: "e1", source: "n1", target: "n2", data: { condition: "prev.passed" } });
  });
  it("missing 标注：apiIds 集合不含节点引用时 missing=true", () => {
    const { nodes } = toFlowElements(wf, { apiIds: new Set(["other"]) });
    expect(nodes[0]!.data.missing).toBe(true);
    expect(nodes[1]!.data.missing).toBe(false); // noop 不标
  });
  it("type 标注：节点 type=wf、边 type=wfEdge 且 data 携带原始 edge", () => {
    const { nodes, edges } = toFlowElements(wf);
    expect(nodes.every((n) => n.type === "wf")).toBe(true);
    expect(edges[0]).toMatchObject({ type: "wfEdge", data: { edge: wf.edges[0] } });
  });
  it("nodeStates 着色：stateClass 经 colorForState 注入节点 data（无状态为空串）", () => {
    const { nodes } = toFlowElements(wf, { nodeStates: new Map([["n1", "passed"]]) });
    expect(nodes[0]!.data.stateClass).toBe("wf-node-passed");
    expect(nodes[1]!.data.stateClass).toBe("");
  });
});

describe("编辑变换（不可变：返回新缓冲）", () => {
  it("applyNodeAdd 追加节点（position 缺省网格摆放）", () => {
    const b = applyNodeAdd(wf, { id: "nX", kind: "request", apiId: "a", caseId: "c" });
    expect(b.nodes.at(-1)!.id).toBe("nX");
    expect(b.nodes.at(-1)!.position).toBeDefined();
    expect(b).not.toBe(wf); // 原对象不变
  });
  it("applyNodeRemove 同时移除关联边", () => {
    const b = applyNodeRemove(wf, "n1");
    expect(b.nodes.some((n) => n.id === "n1")).toBe(false);
    expect(b.edges.some((e) => e.from === "n1" || e.to === "n1")).toBe(false);
  });
  it("applyEdgeAdd 拒绝自环与重复（同 from-to-condition）", () => {
    expect(() => applyEdgeAdd(wf, { source: "n1", target: "n1" })).toThrow(/自环/);
    expect(() => applyEdgeAdd(wf, { source: "n1", target: "n2", condition: undefined })).toThrow(/已存在/);
  });
  it("applyEdgeAdd 成功追加（不同 condition 并行边不冲突）且原缓冲不变", () => {
    const b = applyEdgeAdd(wf, { source: "n1", target: "n2", condition: "prev.failed" });
    expect(b.edges).toHaveLength(2);
    expect(b.edges.at(-1)).toMatchObject({ from: "n1", to: "n2", condition: "prev.failed" });
    expect(b.edges.at(-1)!.id).toBeTruthy();
    expect(b).not.toBe(wf);
    expect(wf.edges).toHaveLength(1);
  });
  it("applyEdgeRemove 按 id 移除", () => {
    const b = applyEdgeRemove(wf, "e1");
    expect(b.edges.some((e) => e.id === "e1")).toBe(false);
    expect(b.nodes).toHaveLength(2); // 节点不受影响
    expect(b).not.toBe(wf);
    expect(wf.edges).toHaveLength(1); // 原对象不变
  });
});

describe("colorForState", () => {
  it("状态 → CSS 类名映射", () => {
    expect(colorForState("passed")).toBe("wf-node-passed");
    expect(colorForState("failed")).toBe("wf-node-failed");
    expect(colorForState("skipped")).toBe("wf-node-skipped");
    expect(colorForState("noop")).toBe("wf-node-noop");
    expect(colorForState(undefined)).toBe("");
  });
});

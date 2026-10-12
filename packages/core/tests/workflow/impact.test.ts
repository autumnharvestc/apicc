import { describe, expect, it } from "vitest";
import { workflowImpact } from "../../src/workflow/impact.js";
import type { ContractWorkspace } from "../../src/contract/workspace.js";

const ws: ContractWorkspace = {
  formatVersion: 1,
  id: "10000000-0000-4000-8000-000000000001", name: "w", variables: {},
  groups: [{
    id: "10000000-0000-4000-8000-000000000002", name: "g", projects: [{
      id: "10000000-0000-4000-8000-000000000003", name: "p", variables: {},
      globals: { query: [], headers: [], cookies: [], body: [] }, environments: [], collections: [],
      stressPolicy: {}, models: [], components: [],
      workflows: [
        { id: "wf1", name: "已启用流", status: "enabled",
          nodes: [{ id: "n1", kind: "request", apiId: "a1", caseId: "c1", label: "登录" }], edges: [] },
        { id: "wf2", name: "草稿流", status: "draft",
          nodes: [{ id: "n2", kind: "request", apiId: "a1", caseId: "c9", label: "引用缺失" }], edges: [] },
      ],
    }],
  }],
};

describe("workflowImpact", () => {
  it("按 caseId 反查：命中 enabled 工作流节点", () => {
    const r = workflowImpact(ws, { caseId: "c1" });
    expect(r).toEqual([{ workflowId: "wf1", workflowName: "已启用流", status: "enabled", nodeId: "n1", nodeLabel: "登录" }]);
  });
  it("按 apiId 反查：两个工作流的节点都命中", () => {
    expect(workflowImpact(ws, { apiId: "a1" })).toHaveLength(2);
  });
  it("无命中返回空数组", () => {
    expect(workflowImpact(ws, { caseId: "nope" })).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { toTreeNode } from "../../src/main/tree.js";
import type { Workspace } from "@apicc/core";

const ws: Workspace = {
  id: "w", name: "ws", variables: {},
  groups: [{
    id: "g1", name: "分组A",
    projects: [{
      id: "p1", name: "项目B", variables: {},
      environments: [{ id: "e1", name: "dev", variables: {} }],
      collections: [{
        id: "c1", name: "集合C", variables: {}, folders: [],
        apis: [{ id: "a1", name: "接口D", version: "1", deprecated: false, method: "GET", url: "/", headers: [], query: [], cases: [] }],
      }],
    }],
  }],
};

describe("toTreeNode", () => {
  it("产出 根→分组→项目(含环境)→集合→接口 的 DTO 树", () => {
    const node = toTreeNode(ws);
    expect(node.kind).toBe("root");
    const group = node.children![0]!;
    expect(group).toMatchObject({ kind: "group", id: "g1", label: "分组A" });
    const project = group.children![0]!;
    expect(project.kind).toBe("project");
    expect(project.envs).toEqual([{ id: "e1", name: "dev" }]);
    const collection = project.children![0]!;
    const api = collection.children![0]!;
    expect(api).toMatchObject({ kind: "api", id: "a1", label: "接口D", method: "GET" });
  });
});

// @vitest-environment jsdom
// 注：pinia/vue 响应式需要 DOM 环境，渲染层 store 测试用文件级 pragma 指定 jsdom。
import { describe, expect, it } from "vitest";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import type { TreeNodeDTO } from "../../../src/shared/tree-dto.js";

function freshStore() {
  const api = createMemoryApi();
  return { api, store: useWorkspaceStore(api) };
}

describe("workspace store", () => {
  it("初始未打开；open 后持有名称与树", async () => {
    const { api, store } = freshStore();
    expect(store.opened).toBe(false);
    api.seedWorkspace();
    await store.open("/tmp/ws");
    expect(store.opened).toBe(true);
    expect(store.tree?.children).toHaveLength(2); // 示例分组 + 默认分组（M10）
  });

  it("打开带问题文件的工作区时 problems 可见", async () => {
    const { api, store } = freshStore();
    api.seedWorkspace();
    (api as { problems: unknown[] }).problems = [{ file: "x.yaml", message: "schema 校验失败: ..." }];
    await store.open("/tmp/ws");
    expect(store.problems).toHaveLength(1);
  });

  it("项目策略保存规范化去重且禁用 origin 优先", async () => {
    const { api, store } = freshStore();
    api.seedWorkspace();
    await store.open("/tmp/ws");
    const project = store.tree!.children![0]!.children![0]!;
    const saved = await store.saveStressPolicy(project.id, {
      trustedOrigins: ["HTTPS://Example.COM:443/", "https://example.com"],
      deniedOrigins: ["https://EXAMPLE.com/"],
      maxConcurrency: 2,
      maxRps: 5,
    });
    expect(saved.trustedOrigins).toEqual([]);
    expect(saved.deniedOrigins).toEqual(["https://example.com"]);
    expect(saved.maxConcurrency).toBe(2);
    expect(store.tree!.children![0]!.children![0]!.stressPolicy).toEqual(saved);
  });

  it("API 所属项目只接受 kind=api 且恰好唯一：0/1/重复 API 与 collection/folder ID 碰撞均拒绝", () => {
    const { store } = freshStore();
    const api = (id: string): TreeNodeDTO => ({ kind: "api", id, label: id });
    const tree = (children: TreeNodeDTO[]): TreeNodeDTO => ({
      kind: "root", id: "root", label: "root", children: [{
        kind: "group", id: "g", label: "g", children: [{ kind: "project", id: "p", label: "p", children }],
      }],
    });
    store.tree = tree([{ kind: "collection", id: "same", label: "c", children: [] }, { kind: "folder", id: "api-1", label: "f", children: [] }]);
    expect(store.projectIdForApi("missing")).toBeNull();
    expect(store.projectIdForApi("same")).toBeNull();
    expect(store.projectIdForApi("api-1")).toBeNull();
    store.tree = tree([{ kind: "collection", id: "c", label: "c", children: [api("api-1")] }]);
    expect(store.projectIdForApi("api-1")).toBe("p");
    store.tree = tree([
      { kind: "collection", id: "c", label: "c", children: [api("api-1")] },
      { kind: "folder", id: "f", label: "f", children: [api("api-1")] },
    ]);
    expect(store.projectIdForApi("api-1")).toBeNull();
    store.tree = {
      kind: "root", id: "root", label: "root", children: [
        { kind: "group", id: "g1", label: "g1", children: [{ kind: "project", id: "p1", label: "p1", children: [{ kind: "collection", id: "c1", label: "c1", children: [api("api-1")] }] }] },
        { kind: "group", id: "g2", label: "g2", children: [{ kind: "project", id: "p2", label: "p2", children: [{ kind: "collection", id: "c2", label: "c2", children: [api("api-1")] }] }] },
      ],
    };
    expect(store.projectIdForApi("api-1")).toBeNull();
  });
});

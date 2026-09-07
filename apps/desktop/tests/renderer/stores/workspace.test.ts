// @vitest-environment jsdom
// 注：pinia/vue 响应式需要 DOM 环境，渲染层 store 测试用文件级 pragma 指定 jsdom。
import { describe, expect, it } from "vitest";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";

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
});

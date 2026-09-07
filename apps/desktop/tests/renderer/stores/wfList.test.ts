// @vitest-environment jsdom
// 注：pinia/vue 响应式需要 DOM 环境，渲染层 store 测试用文件级 pragma 指定 jsdom。
import { describe, expect, it } from "vitest";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useWfListStore } from "../../../src/renderer/src/stores/wfList.js";

async function seeded() {
  const api = createMemoryApi();
  api.seedWorkspace();
  const ws = useWorkspaceStore(api);
  await ws.open("/tmp/ws");
  // 种子树：根 → 分组[0] → 项目[0]
  const projectNode = ws.tree!.children![0]!.children![0]!;
  const list = useWfListStore(api);
  return { api, ws, list, projectNode };
}

describe("wfList store", () => {
  it("load(projectId) 拉取项目工作流列表", async () => {
    const { api, list, projectNode } = await seeded();
    await api.wfCreate({ projectId: projectNode.id, name: "流甲" });
    await api.wfCreate({ projectId: projectNode.id, name: "流乙" });
    expect(list.items).toEqual([]);
    await list.load(projectNode.id);
    expect(list.projectId).toBe(projectNode.id);
    expect(list.items.map((i) => i.name)).toEqual(["流甲", "流乙"]);
    expect(list.items[0]).toMatchObject({ name: "流甲", status: "draft" });
  });

  it("create(name) 返回新工作流（draft）并刷新列表；同名并存（轨二）", async () => {
    const { list, projectNode } = await seeded();
    await list.load(projectNode.id);
    const wf = await list.create("新流");
    expect(wf.status).toBe("draft");
    expect(list.items.map((i) => i.name)).toContain("新流");
    // 同名放开（轨二）：同名工作流并存（id 不同）
    const dup = await list.create("新流");
    expect(dup.id).not.toBe(wf.id);
    expect(list.items).toHaveLength(2);
  });

  it("remove(id, confirm)：确认回调放行后删除并刷新列表", async () => {
    const { list, projectNode } = await seeded();
    await list.load(projectNode.id);
    const wf = await list.create("待删除流");
    let asked = false;
    await list.remove(wf.id, async () => {
      asked = true;
      return true;
    });
    expect(asked).toBe(true);
    expect(list.items.some((i) => i.id === wf.id)).toBe(false);
  });

  it("remove(id, confirm)：确认取消则不删除", async () => {
    const { list, projectNode } = await seeded();
    await list.load(projectNode.id);
    const wf = await list.create("保留流");
    await list.remove(wf.id, async () => false);
    expect(list.items.some((i) => i.id === wf.id)).toBe(true);
  });

  it("工厂每调用 createPinia 隔离：新实例 items 为空、projectId 未设", async () => {
    const { api, list, projectNode } = await seeded();
    await list.load(projectNode.id);
    const other = useWfListStore(api);
    expect(other.items).toEqual([]);
    expect(other.projectId).toBeNull();
  });
});

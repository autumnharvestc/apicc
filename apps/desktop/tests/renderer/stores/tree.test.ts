// @vitest-environment jsdom
// 注：pinia/vue 响应式需要 DOM 环境，渲染层 store 测试用文件级 pragma 指定 jsdom。
import { describe, expect, it } from "vitest";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useTreeStore } from "../../../src/renderer/src/stores/tree.js";

async function seeded() {
  const api = createMemoryApi();
  api.seedWorkspace();
  const ws = useWorkspaceStore(api);
  await ws.open("/tmp/ws");
  const tree = useTreeStore(api, ws);
  return { api, ws, tree };
}

describe("tree store", () => {
  it("createNode 后树刷新且返回新节点 id", async () => {
    const { ws, tree } = await seeded();
    const groupNode = ws.tree!.children![0]!;
    const created = await tree.createNode({ kind: "project", parentId: groupNode.id, name: "新项目" });
    expect(created.id).toBeTruthy();
    // 修正：project 挂在分组之下（根的 children 是分组，见 toTreeNode 形状），
    // 简报原断言取根层 children 永远不含新项目。
    const names = ws.tree!.children![0]!.children!.map((c) => c.label);
    expect(names).toContain("新项目");
  });

  it("deleteNode 需确认回调放行才删除", async () => {
    const { ws, tree } = await seeded();
    const apiNode = ws.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
    let asked = false;
    await tree.deleteNode("api", apiNode.id, async () => { asked = true; return true; });
    expect(asked).toBe(true);
    const flat = JSON.stringify(ws.tree);
    expect(flat).not.toContain(apiNode.id);
  });

  it("deleteNode 确认取消则不删除", async () => {
    const { ws, tree } = await seeded();
    const apiNode = ws.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
    await tree.deleteNode("api", apiNode.id, async () => false);
    expect(JSON.stringify(ws.tree)).toContain(apiNode.id);
  });

  it("renameNode 后标签更新", async () => {
    const { ws, tree } = await seeded();
    const apiNode = ws.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
    await tree.renameNode("api", apiNode.id, "改名后");
    expect(JSON.stringify(ws.tree)).toContain("改名后");
  });
});

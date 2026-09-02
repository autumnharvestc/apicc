// @vitest-environment jsdom
// 注：pinia/vue 响应式需要 DOM 环境，渲染层 store 测试用文件级 pragma 指定 jsdom。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";
import { useCasesStore } from "../../../src/renderer/src/stores/cases.js";

async function seeded() {
  const api = createMemoryApi();
  api.seedWorkspace();
  const ws = useWorkspaceStore(api);
  await ws.open("/tmp/ws");
  const apiNode = ws.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
  const editor = useEditorStore(api);
  await editor.load(apiNode.id);
  return { api, editor, cases: useCasesStore(api, editor) };
}

describe("cases store", () => {
  it("addCase 新增基座用例并选中", async () => {
    const { editor, cases } = await seeded();
    const before = editor.api!.cases.length;
    const created = cases.addCase({ name: "新用例", scope: "base" });
    expect(editor.api!.cases.length).toBe(before + 1);
    expect(cases.selectedCaseId).toBe(created.id);
    expect(editor.dirty).toBe(true);
  });

  it("removeCase 删除用例（至少保留一个时拒绝删除最后一个）", async () => {
    const { editor, cases } = await seeded();
    expect(cases.removeCase(editor.api!.cases[0]!.id)).toBe(false);
    const extra = cases.addCase({ name: "extra", scope: "base" });
    expect(cases.removeCase(extra.id)).toBe(true);
    expect(editor.api!.cases.some((c) => c.id === extra.id)).toBe(false);
  });

  it("save 经 editor.save 持久化", async () => {
    // 修正（沿 2A editor.test.ts 先例）：memory 不导出 groups（简报 fresh.groups =
    // api.groups 只会挂无效属性，fresh 实例未打开工作区必抛「尚未打开工作区」），
    // 改为注入同一 options.root 建两个实例，经 fileStorage 落盘重开验证持久化。
    const root = mkdtempSync(join(tmpdir(), "apicc-cases-"));
    const api = createMemoryApi({ root });
    api.seedWorkspace();
    const ws = useWorkspaceStore(api);
    await ws.open("/tmp/ws");
    const apiNode = ws.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
    const editor = useEditorStore(api);
    await editor.load(apiNode.id);
    const cases = useCasesStore(api, editor);
    cases.addCase({ name: "持久", scope: "base" });
    await cases.save();
    const fresh = createMemoryApi({ root });
    await fresh.wsOpen(root);
    const reEditor = useEditorStore(fresh);
    await reEditor.load(apiNode.id);
    expect(reEditor.api!.cases.some((c) => c.name === "持久")).toBe(true);
  });
});

// @vitest-environment jsdom
// 注：pinia/vue 响应式需要 DOM 环境，渲染层 store 测试用文件级 pragma 指定 jsdom。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";
import { useDesignStore } from "../../../src/renderer/src/stores/design.js";

/** 显式装配辅助（组合根约定的测试形态）：editor 加载接口后创建 design store。 */
async function seeded(root?: string) {
  const api = createMemoryApi(root ? { root } : undefined);
  api.seedWorkspace();
  const ws = useWorkspaceStore(api);
  await ws.open("/tmp/ws");
  const apiNode = ws.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
  const editor = useEditorStore(api);
  await editor.load(apiNode.id);
  const design = useDesignStore(api, editor);
  return { api, ws, editor, design, apiNode };
}

describe("design store", () => {
  it("load 读取 editor.api.design（未编写为空串）并复位 dirty", async () => {
    const { design, editor } = await seeded();
    design.load();
    expect(design.content).toBe("");
    expect(design.dirty).toBe(false);
    editor.api!.design = "已保存的设计";
    design.load();
    expect(design.content).toBe("已保存的设计");
    expect(design.dirty).toBe(false);
  });

  it("setContent 置 dirty；save 写回 editor.api.design 并持久化（重开可读回）", async () => {
    const root = mkdtempSync(join(tmpdir(), "apicc-design-"));
    const { design, editor, api, apiNode } = await seeded(root);
    design.setContent("业务规则：下单前需校验库存");
    expect(design.dirty).toBe(true);
    await design.save();
    expect(design.dirty).toBe(false);
    expect(editor.api!.design).toBe("业务规则：下单前需校验库存");
    // 持久化验证：同一 root 建新实例重开（fileStorage 全量落盘）
    const fresh = createMemoryApi({ root });
    await fresh.wsOpen(root);
    const reEditor = useEditorStore(fresh);
    await reEditor.load(apiNode.id);
    expect(reEditor.api!.design).toBe("业务规则：下单前需校验库存");
  });

  it("exportMarkdown 调 api.designExport(apiId) 返回保存路径", async () => {
    const { design, api, editor } = await seeded();
    let receivedApiId: string | null = null;
    const original = api.designExport.bind(api);
    api.designExport = async (apiId: string) => {
      receivedApiId = apiId;
      return original(apiId);
    };
    const path = await design.exportMarkdown();
    expect(receivedApiId).toBe(editor.apiId);
    expect(path).toContain("示例接口");
    expect(path.endsWith(".md")).toBe(true);
  });
});

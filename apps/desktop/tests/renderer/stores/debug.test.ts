// @vitest-environment jsdom
// 注：pinia/vue 响应式需要 DOM 环境，渲染层 store 测试用文件级 pragma 指定 jsdom。
import { describe, expect, it } from "vitest";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";
import { useDebugStore } from "../../../src/renderer/src/stores/debug.js";

async function seeded() {
  const api = createMemoryApi();
  api.seedWorkspace();
  const ws = useWorkspaceStore(api);
  await ws.open("/tmp/ws");
  const apiNode = ws.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
  const editor = useEditorStore(api);
  await editor.load(apiNode.id);
  const debug = useDebugStore(api);
  return { editor, debug };
}

describe("debug store", () => {
  it("send 前保存编辑（脏→保存）并携带环境", async () => {
    const { editor, debug } = await seeded();
    editor.api!.url = "/sent";
    let captured: { caseId: string; envName?: string } | null = null;
    // 修正：删除简报测试里的噪声行（对 editor.api 的自赋值与 spyApi/void 占位）。
    await debug.send(editor, (input) => {
      captured = input;
      return Promise.resolve({
        run: { total: 1, passed: 1, failed: 0, cases: [], startedAt: "", finishedAt: "", collectionId: "c", collectionName: "c" },
        outcome: { apiId: "a", apiName: "a", caseId: "t", caseName: "t", passed: true, durationMs: 1, assertions: [] },
      });
    }, "dev");
    expect(editor.dirty).toBe(false);
    expect(captured).toMatchObject({ envName: "dev" });
    expect(debug.result?.outcome.passed).toBe(true);
    expect(debug.sending).toBe(false);
  });

  it("发送失败时错误可见且状态复位", async () => {
    const { editor, debug } = await seeded();
    await debug.send(editor, () => Promise.reject(new Error("网络不可达")));
    expect(debug.error).toContain("网络不可达");
    expect(debug.sending).toBe(false);
  });
});

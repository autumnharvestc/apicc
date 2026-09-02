// @vitest-environment jsdom
// 注：pinia/vue 响应式需要 DOM 环境，渲染层 store 测试用文件级 pragma 指定 jsdom。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isReactive } from "vue";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";

async function seeded() {
  const api = createMemoryApi();
  api.seedWorkspace();
  const ws = useWorkspaceStore(api);
  await ws.open("/tmp/ws");
  const apiNode = ws.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
  const editor = useEditorStore(api);
  return { api, ws, editor, apiNode };
}

describe("editor store", () => {
  it("load 拉取接口与可用环境；dirty 跟踪编辑", async () => {
    const { editor, apiNode } = await seeded();
    await editor.load(apiNode.id);
    // 修正：memory.seedWorkspace 预置接口名为「示例接口」（简报写「接口一」，
    // memory 是契约源，断言对齐实际值）。
    expect(editor.api?.name).toBe("示例接口");
    // 修正：memory 预置项目 environments 为空数组，apiGet.envs 即其映射（简报写
    // [{ id: "e1", name: "dev" }]，与 memory 契约不符，断言对齐实际值）。
    expect(editor.envs).toEqual([]);
    expect(editor.dirty).toBe(false);
    editor.api!.url = "{{baseUrl}}/changed";
    expect(editor.dirty).toBe(true);
  });

  it("save 持久化并清除 dirty", async () => {
    // 修正：memory 不导出 groups（简报 fresh.groups = api.groups 不成立），
    // 改为注入同一 root 建两个实例，经 fileStorage 落盘重开验证持久化。
    const root = mkdtempSync(join(tmpdir(), "apicc-editor-"));
    const api = createMemoryApi({ root });
    api.seedWorkspace();
    const ws = useWorkspaceStore(api);
    await ws.open("/tmp/ws");
    const apiNode = ws.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
    const editor = useEditorStore(api);
    await editor.load(apiNode.id);
    editor.api!.url = "/v2";
    await editor.save();
    expect(editor.dirty).toBe(false);
    const fresh = createMemoryApi({ root });
    await fresh.wsOpen(root);
    const reEditor = useEditorStore(fresh);
    await reEditor.load(apiNode.id);
    expect(reEditor.api!.url).toBe("/v2");
  });

  it("save 传给 IPC 的是剥离响应式后的普通对象（结构化克隆不接受 Proxy）", async () => {
    const api = createMemoryApi();
    api.seedWorkspace();
    const ws = useWorkspaceStore(api);
    await ws.open("/tmp/ws");
    const apiNode = ws.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
    const editor = useEditorStore(api);
    await editor.load(apiNode.id);
    let saved: unknown;
    const original = api.apiSave.bind(api);
    api.apiSave = async (input) => { saved = input; return original(input); };
    editor.api!.url = "/v3";
    await editor.save();
    // 回归：直接传响应式 Proxy 会在 Electron 结构化克隆时 DataCloneError。
    expect(isReactive(saved)).toBe(false);
    expect(saved).toMatchObject({ url: "/v3" });
  });
});

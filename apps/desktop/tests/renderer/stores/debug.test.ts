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

  it("选择环境与用例后按选择发送；失效选择自动回退", async () => {
    const { editor, debug } = await seeded();
    // 注：memory 种子的基座用例 id 为 randomUUID（非简报示例中的固定 "t0"），以实际种子为准；
    // 种子项目也无环境，dev 为测试自注入（selectEnv 的生效前提是 editor.envs 中存在该环境名）。
    const baseCaseId = editor.api!.cases[0]!.id;
    await debug.send(editor); // 现状基线：cases[0]
    editor.api!.cases.push({ id: "t2", name: "second", scope: "base", parameters: {}, assertions: [] });
    editor.envs = [{ id: "e1", name: "dev" }];
    debug.selectCase("t2");
    debug.selectEnv("dev");
    let captured: { apiId: string; caseId: string; envName?: string } | null = null;
    await debug.send(editor, (input) => { captured = input; return Promise.resolve({ run: { total: 1, passed: 1, failed: 0, cases: [], startedAt: "", finishedAt: "", collectionId: "c", collectionName: "c" }, outcome: { apiId: "a", apiName: "a", caseId: "t2", caseName: "t2", passed: true, durationMs: 1, assertions: [] } }); }, undefined);
    expect(captured).toMatchObject({ caseId: "t2", envName: "dev" });
    // 失效回退：选中的用例/环境不在当前接口/项目里时回退 cases[0]/无环境
    editor.api!.cases = editor.api!.cases.filter((c) => c.id === baseCaseId);
    editor.envs = [];
    await debug.send(editor, (input) => { captured = input; return Promise.resolve({ run: { total: 1, passed: 1, failed: 0, cases: [], startedAt: "", finishedAt: "", collectionId: "c", collectionName: "c" }, outcome: { apiId: "a", apiName: "a", caseId: baseCaseId, caseName: "t0", passed: true, durationMs: 1, assertions: [] } }); }, undefined);
    expect(captured).toMatchObject({ caseId: baseCaseId });
    expect(captured!.envName).toBeUndefined();
  });
});

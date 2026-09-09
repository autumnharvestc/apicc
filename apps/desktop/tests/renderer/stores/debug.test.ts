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
  const collectionNode = ws.tree!.children![0]!.children![0]!.children![0]!;
  const apiNode = collectionNode.children![0]!;
  const editor = useEditorStore(api);
  await editor.load(apiNode.id);
  // 计划 C 任务 4：结果按 apiId 驻留——result getter 依赖 editor 活跃 apiId（组合根同序装配）
  const debug = useDebugStore(api, editor);
  return { api, ws, editor, debug, collectionNode, apiNode };
}

function fakeOutput(apiId: string, caseId: string, passed = true) {
  return {
    run: { total: 1, passed: passed ? 1 : 0, failed: passed ? 0 : 1, cases: [], startedAt: "", finishedAt: "", collectionId: "c", collectionName: "c" },
    outcome: { apiId, apiName: "a", caseId, caseName: caseId, passed, durationMs: 1, assertions: [] },
  };
}

describe("debug store", () => {
  it("send 前保存编辑（脏→保存）并携带环境", async () => {
    const { editor, debug } = await seeded();
    editor.api!.url = "/sent";
    let captured: { caseId: string; envName?: string } | null = null;
    // 修正：删除简报测试里的噪声行（对 editor.api 的自赋值与 spyApi/void 占位）。
    await debug.send(editor, (input) => {
      captured = input;
      return Promise.resolve(fakeOutput(input.apiId, input.caseId));
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
    // 会话表化（计划 C 任务 4）：envs 隶属活跃会话槽，经槽直写注入。
    const baseCaseId = editor.api!.cases[0]!.id;
    await debug.send(editor); // 现状基线：cases[0]
    editor.api!.cases.push({ id: "t2", name: "second", scope: "base", parameters: {}, assertions: [] });
    editor.sessions[editor.apiId!]!.envs = [{ id: "e1", name: "dev" }];
    debug.selectCase("t2");
    debug.selectEnv("dev");
    let captured: { apiId: string; caseId: string; envName?: string } | null = null;
    await debug.send(editor, (input) => { captured = input; return Promise.resolve(fakeOutput(input.apiId, input.caseId)); }, undefined);
    expect(captured).toMatchObject({ caseId: "t2", envName: "dev" });
    // 失效回退：选中的用例/环境不在当前接口/项目里时回退 cases[0]/无环境
    editor.api!.cases = editor.api!.cases.filter((c) => c.id === baseCaseId);
    editor.sessions[editor.apiId!]!.envs = [];
    await debug.send(editor, (input) => { captured = input; return Promise.resolve(fakeOutput(input.apiId, input.caseId)); }, undefined);
    expect(captured).toMatchObject({ caseId: baseCaseId });
    expect(captured!.envName).toBeUndefined();
  });
});

// —— 计划 C 任务 4：debug 结果按 apiId 驻留（切接口回看各自结果；切项目不清其他结果）——
describe("debug 结果按 apiId 驻留（计划 C 任务 4）", () => {
  it("双接口各自结果驻留：A 发送 → B 发送 → 回 A 显示 A 的旧结果（不重发）", async () => {
    const { api, editor, debug, apiNode, collectionNode } = await seeded();
    const apiB = await api.nodeCreate({ kind: "api", parentId: collectionNode.id, name: "接口B" });
    let sends = 0;
    const sendFn = (input: { apiId: string; caseId: string }) => {
      sends += 1;
      return Promise.resolve(fakeOutput(input.apiId, input.caseId));
    };
    await debug.send(editor, sendFn);
    expect(debug.result?.outcome.apiId).toBe(apiNode.id);
    await editor.load(apiB.id);
    await debug.send(editor, sendFn);
    expect(debug.result?.outcome.apiId).toBe(apiB.id);
    await editor.load(apiNode.id); // 回切 A：显示 A 的驻留结果，不重发
    expect(debug.result?.outcome.apiId).toBe(apiNode.id);
    expect(sends).toBe(2);
    expect(Object.keys(debug.results).sort()).toEqual([apiNode.id, apiB.id].sort());
  });

  it("setProject 切项目不清其他项目结果：results 按 apiId 累积驻留", async () => {
    const { editor, debug, apiNode } = await seeded();
    await debug.send(editor, (input) => Promise.resolve(fakeOutput(input.apiId, input.caseId)));
    debug.setProject("另一个项目"); // 项目切换（App.vue selectedProjectId watch 先例）
    expect(debug.results[apiNode.id]).not.toBeNull(); // 其他接口的结果驻留不被清
    expect(debug.result?.outcome.apiId).toBe(apiNode.id); // 活跃接口结果照常可读
  });

  it("无 editor 依赖（旧装配面）：result 回落最近发送槽（兼容面）", async () => {
    const api = createMemoryApi();
    api.seedWorkspace();
    const ws = useWorkspaceStore(api);
    await ws.open("/tmp/ws");
    const apiNode = ws.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
    const editor = useEditorStore(api);
    const debug = useDebugStore(api); // 未注入 editor（components.test 旧装配先例）
    await editor.load(apiNode.id);
    expect(debug.result).toBeNull();
    await debug.send(editor, (input) => Promise.resolve(fakeOutput(input.apiId, input.caseId)));
    expect(debug.result?.outcome.apiId).toBe(apiNode.id);
  });
});

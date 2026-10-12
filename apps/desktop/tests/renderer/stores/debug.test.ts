// @vitest-environment jsdom
// 注：pinia/vue 响应式需要 DOM 环境，渲染层 store 测试用文件级 pragma 指定 jsdom。
import { describe, expect, it } from "vitest";
import type { ApiLocator } from "../../../src/shared/locations.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";
import { useDebugStore } from "../../../src/renderer/src/stores/debug.js";

async function seeded() {
  const api = createMemoryApi();
  api.seedWorkspace();
  const ws = useWorkspaceStore(api);
  await ws.open("/tmp/ws");
  const group = ws.tree!.children.find((node) => node.kind === "group" && node.children.some((child) =>
    child.kind === "project" && child.children.some((item) => item.kind === "collection" && item.children.some((apiItem) => apiItem.kind === "api"))));
  if (!group || group.kind !== "group") throw new Error("Memory workspace is missing the seeded project group");
  const project = group.children.find((node) => node.kind === "project" && node.children.some((item) => item.kind === "collection" && item.children.some((apiItem) => apiItem.kind === "api")));
  if (!project || project.kind !== "project") throw new Error("Memory group is missing the seeded project");
  const collectionNode = project.children.find((node) => node.kind === "collection");
  if (!collectionNode || collectionNode.kind !== "collection") throw new Error("Memory project is missing the seeded collection");
  const apiNode = collectionNode.children.find((node) => node.kind === "api");
  if (!apiNode || apiNode.kind !== "api") throw new Error("Memory collection is missing the seeded API");
  const context = () => ({ root: ws.root, readOnly: ws.readOnly });
  const editor = useEditorStore(api, context);
  await editor.load(apiNode.locator);
  const debug = useDebugStore(api, editor, context);
  return { api, ws, editor, debug, project, collectionNode, apiNode };
}

function fakeOutput(apiId: string, caseId: string, passed = true) {
  return {
    run: { total: 1, passed: passed ? 1 : 0, failed: passed ? 0 : 1, cases: [], startedAt: "", finishedAt: "", collectionId: "c", collectionName: "c" },
    outcome: { apiId, apiName: "a", caseId, caseName: caseId, passed, durationMs: 1, assertions: [] },
  };
}

describe("debug store", () => {
  it("send 前保存编辑（脏→保存）并携带环境", async () => {
    const { api, editor, debug, project } = await seeded();
    await api.envCreate({ locator: project.locator, name: "dev" });
    await editor.reloadEnvs();
    editor.api!.contract.request.baseUrl = "/sent";
    let captured: { locator: ApiLocator; caseId: string; envName?: string | null } | null = null;
    await debug.send(editor, (input) => {
      captured = input;
      return Promise.resolve(fakeOutput(input.locator.apiId, input.caseId));
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
    const { api, editor, debug, project } = await seeded();
    const baseCase = editor.api!.cases[0]!;
    await debug.send(editor); // 初始选择回退至当前 contract 的首个 case
    editor.api!.cases.push({ id: "t2", name: "second", scope: "base", parameters: {}, preOperations: [], postOperations: [], assertions: [] });
    await api.envCreate({ locator: project.locator, name: "dev" });
    await editor.reloadEnvs();
    debug.selectCase({ caseId: "t2", scope: "base" });
    debug.selectEnv("dev");
    let captured: { locator: ApiLocator; caseId: string; envName?: string | null } | null = null;
    await debug.send(editor, (input) => { captured = input; return Promise.resolve(fakeOutput(input.locator.apiId, input.caseId)); });
    expect(captured).toMatchObject({ caseId: "t2", envName: "dev" });
    // 失效回退：选中的用例和环境不在当前接口/项目里时回退首用例/无环境。
    editor.api!.cases = editor.api!.cases.filter((item) => item.id === baseCase.id);
    await api.nodeDelete({ kind: "environment", locator: editor.envs[0]!.locator });
    await editor.reloadEnvs();
    await debug.send(editor, (input) => { captured = input; return Promise.resolve(fakeOutput(input.locator.apiId, input.caseId)); });
    expect(captured).toMatchObject({ caseId: baseCase.id });
    expect(captured!.envName).toBeUndefined();
  });
});

// Result retention is keyed by workspace root plus the complete API locator.
describe("debug 结果按完整 API 身份驻留", () => {
  it("双接口各自结果驻留：A 发送 → B 发送 → 回 A 显示 A 的旧结果（不重发）", async () => {
    const { api, editor, debug, apiNode, collectionNode } = await seeded();
    const apiB = await api.nodeCreate({ kind: "api", parent: collectionNode.locator, api: { name: "接口B" } });
    if (apiB.kind !== "api") throw new Error("Memory API creation did not return an API node");
    let sends = 0;
    const sendFn = (input: { locator: ApiLocator; caseId: string }) => {
      sends += 1;
      return Promise.resolve(fakeOutput(input.locator.apiId, input.caseId));
    };
    await debug.send(editor, sendFn);
    expect(debug.result?.outcome.apiId).toBe(apiNode.locator.apiId);
    await editor.load(apiB.locator);
    await debug.send(editor, sendFn);
    expect(debug.result?.outcome.apiId).toBe(apiB.locator.apiId);
    await editor.load(apiNode.locator); // 回切 A：显示 A 的驻留结果，不重发
    expect(debug.result?.outcome.apiId).toBe(apiNode.locator.apiId);
    expect(sends).toBe(2);
    expect(Object.values(debug.results).map((result) => result.outcome.apiId).sort()).toEqual([apiNode.locator.apiId, apiB.locator.apiId].sort());
  });

  it("setProject 切项目不清其他项目结果：results 按完整 API 身份累积驻留", async () => {
    const { api, editor, debug, apiNode, ws } = await seeded();
    await debug.send(editor, (input) => Promise.resolve(fakeOutput(input.locator.apiId, input.caseId)));
    const group = ws.tree!.children.find((node) => node.kind === "group");
    if (!group || group.kind !== "group") throw new Error("Memory workspace is missing a group");
    const otherProject = await api.nodeCreate({ kind: "project", parent: group.locator, name: "另一个项目" });
    if (otherProject.kind !== "project") throw new Error("Memory project creation did not return a project node");
    debug.setProject(otherProject.locator);
    expect(Object.values(debug.results).some((result) => result.outcome.apiId === apiNode.locator.apiId)).toBe(true);
    expect(debug.result?.outcome.apiId).toBe(apiNode.locator.apiId); // editor 仍在原 API，驻留结果照常可读
  });

  it("无 editor 依赖时 result 回落最近发送槽", async () => {
    const { api, ws, apiNode } = await seeded();
    const context = () => ({ root: ws.root, readOnly: ws.readOnly });
    const editor = useEditorStore(api, context);
    const debug = useDebugStore(api, undefined, context);
    await editor.load(apiNode.locator);
    expect(debug.result).toBeNull();
    await debug.send(editor, (input) => Promise.resolve(fakeOutput(input.locator.apiId, input.caseId)));
    expect(debug.result?.outcome.apiId).toBe(apiNode.locator.apiId);
  });

  it("注入 editor 但无当前 API 或当前 root 不同不回退到最近结果", async () => {
    const { api, ws, editor, debug, apiNode } = await seeded();
    await debug.send(editor, (input) => Promise.resolve(fakeOutput(input.locator.apiId, input.caseId)));
    expect(debug.result?.outcome.apiId).toBe(apiNode.locator.apiId);

    ws.root = `${ws.root}-copied`;
    expect(debug.result).toBeNull();
    editor.deactivate();
    expect(debug.result).toBeNull();
  });
});

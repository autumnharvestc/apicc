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
  const groupNode = ws.tree!.children![0]!;
  const projectNode = groupNode.children![0]!;
  const collectionNode = projectNode.children![0]!;
  const apiNode = collectionNode.children![0]!;
  const editor = useEditorStore(api);
  return { api, ws, editor, groupNode, projectNode, collectionNode, apiNode };
}

/** 经替身再建一个接口（计划 C 任务 4 会话表化用例的第二会话）。 */
async function createApi(ctx: Awaited<ReturnType<typeof seeded>>, name: string) {
  return ctx.api.nodeCreate({ kind: "api", parentId: ctx.collectionNode.id, name });
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

// —— M5-B 任务 1：多协议字段进编辑缓冲与快照（规格 D2 契约 fixture——两阶段执行：
// main 基线 core strict schema 尚无这些字段，保存链路不接线，载荷仅经 apiSave 出口观测；
// 任务 2 同步 main 后由 core 新 schema 校验落盘往返）——
describe("editor store 多协议 fixture（M5-B T1，D2）", () => {
  it("protocol/message/envelope/soapAction 进编辑缓冲：修改即 dirty，save 后快照复位", async () => {
    const { editor, apiNode } = await seeded();
    await editor.load(apiNode.id);
    editor.api!.protocol = "websocket";
    editor.api!.message = "{{greeting}}";
    expect(editor.dirty).toBe(true);
    await editor.save();
    expect(editor.dirty).toBe(false);
    // soap 字段同样进缓冲与快照比对
    editor.api!.protocol = "soap";
    editor.api!.envelope = "<Envelope/>";
    editor.api!.soapAction = "urn:do";
    expect(editor.dirty).toBe(true);
    await editor.save();
    expect(editor.dirty).toBe(false);
  });

  it("保存载荷携带新字段（fixture 断言：经 apiSave 出口观测载荷形状）", async () => {
    const { api, editor, apiNode } = await seeded();
    await editor.load(apiNode.id);
    let saved: unknown;
    const original = api.apiSave.bind(api);
    api.apiSave = async (input) => { saved = input; return original(input); };
    editor.api!.protocol = "soap";
    editor.api!.envelope = "<Envelope>{{payload}}</Envelope>";
    editor.api!.soapAction = "urn:Action";
    await editor.save();
    expect(saved).toMatchObject({
      protocol: "soap",
      envelope: "<Envelope>{{payload}}</Envelope>",
      soapAction: "urn:Action",
    });
  });
});

// —— 计划 C 任务 4：编辑器会话表化——草稿按 apiId 驻留（不变量 2：切签免确认、草稿驻留）——
describe("editor 会话表化（计划 C 任务 4）", () => {
  it("双接口会话并存：load A 改 url → load B（api 换槽且非脏）→ load A 回切草稿原样驻留（定位槽不重拉）", async () => {
    const ctx = await seeded();
    const apiB = await createApi(ctx, "接口B");
    const gets: string[] = [];
    const originalGet = ctx.api.apiGet.bind(ctx.api);
    ctx.api.apiGet = async (id: string) => {
      gets.push(id);
      return originalGet(id);
    };
    await ctx.editor.load(ctx.apiNode.id);
    ctx.editor.api!.url = "{{baseUrl}}/draft-a";
    expect(ctx.editor.dirty).toBe(true);
    await ctx.editor.load(apiB.id); // 未驻留：拉取建槽
    expect(ctx.editor.api?.name).toBe("接口B");
    expect(ctx.editor.dirty).toBe(false); // B 的会话是干净槽
    await ctx.editor.load(ctx.apiNode.id); // 已驻留：仅切活跃指针
    expect(ctx.editor.api?.url).toBe("{{baseUrl}}/draft-a"); // 草稿驻留
    expect(ctx.editor.dirty).toBe(true);
    expect(gets).toEqual([ctx.apiNode.id, apiB.id]); // 回切 A 不重拉
    // 会话表形状：双槽驻留
    expect(Object.keys(ctx.editor.sessions).sort()).toEqual([ctx.apiNode.id, apiB.id].sort());
    expect(ctx.editor.activeApiId).toBe(ctx.apiNode.id);
  });

  it("save/reloadEnvs 写活跃槽：B 活跃时 save 只落 B，A 草稿与快照不受牵连", async () => {
    const ctx = await seeded();
    const apiB = await createApi(ctx, "接口B");
    const savedIds: string[] = [];
    const originalSave = ctx.api.apiSave.bind(ctx.api);
    ctx.api.apiSave = async (input) => {
      savedIds.push((input as { id: string }).id);
      return originalSave(input);
    };
    await ctx.editor.load(ctx.apiNode.id);
    ctx.editor.api!.url = "/draft-a"; // A 脏
    await ctx.editor.load(apiB.id);
    ctx.editor.api!.url = "/draft-b"; // B 脏
    await ctx.editor.save(); // 只保存活跃槽 B
    expect(savedIds).toEqual([apiB.id]);
    expect(ctx.editor.dirty).toBe(false); // B 快照复位
    // reloadEnvs 同样只动活跃槽（M9-A1 语义保持：envs 重拉、api 快照不动）
    ctx.editor.sessions[ctx.apiNode.id]!.envs = [{ id: "e1", name: "dev" }]; // A 槽预置旧清单
    await ctx.editor.load(ctx.apiNode.id); // 切回 A（定位槽，envs 保留旧清单）
    expect(ctx.editor.envs).toEqual([{ id: "e1", name: "dev" }]);
    await ctx.editor.reloadEnvs(); // 按活跃接口重拉 → A 所属项目环境为空
    expect(ctx.editor.envs).toEqual([]);
    expect(ctx.editor.dirty).toBe(true); // reloadEnvs 只动 envs，api 快照不动（A 草稿仍脏）
  });

  it("evictProject：按 apiIds 驱逐会话槽；活跃槽被逐则 activeApiId 复位 null；其余会话驻留不受牵连", async () => {
    const ctx = await seeded();
    const apiB = await createApi(ctx, "接口B");
    await ctx.editor.load(ctx.apiNode.id);
    ctx.editor.api!.url = "/draft-a";
    await ctx.editor.load(apiB.id);
    ctx.editor.api!.url = "/draft-b"; // 活跃在 B
    // 驱逐活跃槽 B：指针复位 null（编辑区空白），A 会话驻留不受牵连
    ctx.editor.evictProject("project-b", [apiB.id]);
    expect(ctx.editor.sessions[apiB.id]).toBeUndefined();
    expect(ctx.editor.sessions[ctx.apiNode.id]).toBeDefined(); // A 会话驻留
    expect(ctx.editor.activeApiId).toBeNull(); // 活跃槽被逐 → 复位
    expect(ctx.editor.api).toBeNull();
    expect(ctx.editor.dirty).toBe(false);
    // 活跃槽不在驱逐集合：指针不动，草稿驻留
    await ctx.editor.load(ctx.apiNode.id);
    expect(ctx.editor.api?.url).toBe("/draft-a");
    ctx.editor.evictProject("project-a", ["不存在的 id"]);
    expect(ctx.editor.activeApiId).toBe(ctx.apiNode.id);
  });
});

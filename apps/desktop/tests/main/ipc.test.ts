import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Importer } from "@apicc/core";
import { createIpcDeps } from "../../src/main/ipc.js";
import { createSession } from "../../src/main/session.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "apicc-ipc-"));
  const session = createSession();
  const deps = createIpcDeps({ session, pickDirectory: async () => dir, saveFile: async () => "" });
  return { deps, dir };
}

/** 固定 importer 替身：detect 按 MAGIC 标记命中，parse 返回固定项目与警告（导入器由 deps 注入）。 */
const fixedImporter: Importer = {
  name: "fixed",
  detect: (_fileName, content) => content.includes("FIXED-MAGIC"),
  parse: () => ({
    project: {
      id: "00000000-0000-4000-8000-000000000101", name: "导入项目", variables: {}, environments: [], workflows: [],
      collections: [{ id: "00000000-0000-4000-8000-000000000102", name: "导入集合", variables: {}, folders: [], apis: [] }],
    },
    warnings: ["示例警告"],
  }),
};

function setupWithImporters(importers: Importer[]) {
  const dir = mkdtempSync(join(tmpdir(), "apicc-ipc-"));
  const session = createSession();
  const deps = createIpcDeps({ session, pickDirectory: async () => dir, saveFile: async () => "", importers });
  return { deps, dir };
}

describe("IPC 处理器", () => {
  it("ws:create → tree:get → node:create → api:get 全链路", async () => {
    const { deps, dir } = setup();
    const opened = await deps.handle("ws:create", {}, dir, "演示");
    expect(opened.workspace.name).toBe("演示");
    let tree = await deps.handle("tree:get", {});
    // M10：默认分组是唯一顶层节点
    expect(tree.children).toHaveLength(1);
    expect(tree.children![0]).toMatchObject({ kind: "group", label: "默认分组" });
    const group = await deps.handle("node:create", {}, { kind: "group", parentId: null, name: "g" });
    const project = await deps.handle("node:create", {}, { kind: "project", parentId: group.id, name: "p" });
    const collection = await deps.handle("node:create", {}, { kind: "collection", parentId: project.id, name: "c" });
    const api = await deps.handle("node:create", {}, { kind: "api", parentId: collection.id, name: "a", method: "GET", url: "/" });
    // 契约收紧（宽审查 I2）：node:create 返回统一瘦 DTO，不再泄漏 url/cases 等原生字段
    expect(group).toEqual({ kind: "group", id: group.id, label: "g" });
    expect(api).toEqual({ kind: "api", id: api.id, label: "a", method: "GET" });
    tree = await deps.handle("tree:get", {});
    const gNode = tree.children!.find((x: { label: string }) => x.label === "g")!;
    const apiNode = gNode.children![0]!.children![0]!.children![0]!;
    expect(apiNode.id).toBe(api.id);
    const fetched = await deps.handle("api:get", {}, api.id);
    expect(fetched.api.name).toBe("a");
    expect(fetched.envs).toEqual([]);
  });

  it("folder 内新建接口：parentId 指向文件夹时挂到所属集合的文件夹下", async () => {
    const { deps, dir } = setup();
    await deps.handle("ws:create", {}, dir, "w");
    const group = await deps.handle("node:create", {}, { kind: "group", parentId: null, name: "g" });
    const project = await deps.handle("node:create", {}, { kind: "project", parentId: group.id, name: "p" });
    const collection = await deps.handle("node:create", {}, { kind: "collection", parentId: project.id, name: "c" });
    const folder = await deps.handle("node:create", {}, { kind: "folder", parentId: collection.id, name: "f" });
    // 回归背景（宽审查 C1）：parentId 此前被直接当集合 id 传给 createApi，folder 内新建必抛「未找到集合」
    const api = await deps.handle("node:create", {}, { kind: "api", parentId: folder.id, name: "a", method: "GET", url: "/" });
    expect(api.kind).toBe("api");
    const fetched = await deps.handle("api:get", {}, api.id);
    expect(fetched.api.name).toBe("a");
    const tree = await deps.handle("tree:get", {});
    const gNode = tree.children!.find((x: { label: string }) => x.label === "g")!;
    const folderNode = gNode.children![0]!.children![0]!.children!.find((n: { kind: string }) => n.kind === "folder")!;
    expect(folderNode.children!.map((c: { id: string }) => c.id)).toContain(api.id);
  });

  it("api:save 持久化并落盘", async () => {
    const { deps, dir } = setup();
    await deps.handle("ws:create", {}, dir, "w");
    const g = await deps.handle("node:create", {}, { kind: "group", parentId: null, name: "g" });
    const p = await deps.handle("node:create", {}, { kind: "project", parentId: g.id, name: "p" });
    const c = await deps.handle("node:create", {}, { kind: "collection", parentId: p.id, name: "c" });
    const api = await deps.handle("node:create", {}, { kind: "api", parentId: c.id, name: "a", method: "GET", url: "/x" });
    // node:create 只回瘦 DTO（无 url），编辑链路经 api:get 取完整接口本体再保存
    const detail = await deps.handle("api:get", {}, api.id);
    detail.api.url = "/y";
    await deps.handle("api:save", {}, detail.api);
    const fresh = createIpcDeps({ session: createSession(), pickDirectory: async () => dir, saveFile: async () => "" });
    await fresh.handle("ws:open", {}, dir);
    const fetched = await fresh.handle("api:get", {}, api.id);
    expect(fetched.api.url).toBe("/y");
  });

  it("env:create 返回环境对象并落盘；env:vars:save 保存变量后重开读回", async () => {
    const { deps, dir } = setup();
    await deps.handle("ws:create", {}, dir, "w");
    const g = await deps.handle("node:create", {}, { kind: "group", parentId: null, name: "g" });
    const p = await deps.handle("node:create", {}, { kind: "project", parentId: g.id, name: "p" });
    // env:create → 返回环境对象；处理器显式 save 落盘（session 变更操作不自动落盘）
    const env = await deps.handle("env:create", {}, { projectId: p.id, name: "sit", extends: "dev" });
    expect(env).toMatchObject({ name: "sit", extends: "dev", variables: {} });
    expect(env.id).toBeTruthy();
    await expect(deps.handle("env:create", {}, { projectId: "不存在", name: "x" })).rejects.toThrow(/未找到项目/);
    const fresh = createIpcDeps({ session: createSession(), pickDirectory: async () => dir, saveFile: async () => "" });
    await fresh.handle("ws:open", {}, dir);
    const tree = await fresh.handle("tree:get", {});
    const projectNode = tree.children![0]!.children![0]!;
    expect(projectNode.envs).toEqual([{ id: env.id, name: "sit", extends: "dev", variables: {}, baseUrls: {} }]);
    // env:vars:save → 变量覆盖 + 显式 save 落盘，重开读回验证
    await fresh.handle("env:vars:save", {}, env.id, { baseUrl: "http://s" });
    const rereadSession = createSession();
    const reread = createIpcDeps({ session: rereadSession, pickDirectory: async () => dir, saveFile: async () => "" });
    await reread.handle("ws:open", {}, dir);
    const sit = rereadSession.workspace!.groups.find((x) => x.name === "g")!.projects[0]!.environments[0]!;
    expect(sit.variables).toEqual({ baseUrl: "http://s" });
    expect(sit.extends).toBe("dev");
  });

  it("未打开工作区时 tree:get 抛可读错误", async () => {
    const { deps } = setup();
    const fresh = createIpcDeps({ session: createSession(), pickDirectory: async () => "", saveFile: async () => "" });
    await expect(fresh.handle("tree:get", {})).rejects.toThrow(/未打开/);
  });

  it("debug:send 走调试链路", async () => {
    const { deps, dir } = setup();
    await deps.handle("ws:create", {}, dir, "w");
    const g = await deps.handle("node:create", {}, { kind: "group", parentId: null, name: "g" });
    const p = await deps.handle("node:create", {}, { kind: "project", parentId: g.id, name: "p" });
    const c = await deps.handle("node:create", {}, { kind: "collection", parentId: p.id, name: "c" });
    const api = await deps.handle("node:create", {}, { kind: "api", parentId: c.id, name: "a", method: "GET", url: "http://127.0.0.1:1/" });
    const detail = await deps.handle("api:get", {}, api.id);
    const result = await deps.handle("debug:send", {}, { apiId: api.id, caseId: detail.api.cases[0]!.id, envName: undefined });
    expect(result.outcome.passed).toBe(false);
    expect(result.run.total).toBe(1);
  });

  it("import:preview 按 detect 命中注入 importer，返回 importerName/project/warnings；无命中抛「无法识别的导入格式」", async () => {
    const { deps, dir } = setupWithImporters([fixedImporter]);
    await deps.handle("ws:create", {}, dir, "w");
    const preview = await deps.handle("import:preview", {}, { fileName: "x.yaml", content: "FIXED-MAGIC" });
    expect(preview.importerName).toBe("fixed");
    expect(preview.project.name).toBe("导入项目");
    expect(preview.warnings).toEqual(["示例警告"]);
    await expect(deps.handle("import:preview", {}, { fileName: "x.yaml", content: "no-marker" })).rejects.toThrow(/无法识别的导入格式/);
  });

  it("import:preview 未注入 importers 时走默认注册中心（内置 openapi 导入器可识别文档）", async () => {
    const { deps, dir } = setup();
    await deps.handle("ws:create", {}, dir, "w");
    const preview = await deps.handle("import:preview", {}, {
      fileName: "openapi.yaml",
      content: ["openapi: 3.0.0", "info:", "  title: 默认导入", "  version: 1.0.0", "servers:", "  - url: http://127.0.0.1:1", "paths: {}"].join("\n"),
    });
    expect(preview.importerName).toBe("openapi");
    expect(preview.project.name).toBe("默认导入");
  });

  it("import:apply 缺分组时创建分组并入项目、落盘可重开；重复导入拒绝「项目已存在」", async () => {
    const { deps, dir } = setupWithImporters([fixedImporter]);
    await deps.handle("ws:create", {}, dir, "w");
    const preview = await deps.handle("import:preview", {}, { fileName: "x.yaml", content: "FIXED-MAGIC" });
    await deps.handle("import:apply", {}, { groupName: "新分组", project: preview.project });
    // 重开读回：分组与项目均已落盘（apply 分支显式 save 语义）
    const fresh = createIpcDeps({ session: createSession(), pickDirectory: async () => dir, saveFile: async () => "" });
    await fresh.handle("ws:open", {}, dir);
    const tree = await fresh.handle("tree:get", {});
    const importedGroup = tree.children!.find((n: { label: string }) => n.label === "新分组")!;
    expect(importedGroup).toBeDefined();
    expect(importedGroup.children!.map((n: { label: string }) => n.label)).toContain("导入项目");
    // 同分组重复导入同名项目：拒绝
    await expect(deps.handle("import:apply", {}, { groupName: "新分组", project: preview.project })).rejects.toThrow(/项目已存在: 导入项目/);
  });

  it("import:apply 目标分组已存在时合并进该分组（不新建）", async () => {
    const { deps, dir } = setupWithImporters([fixedImporter]);
    await deps.handle("ws:create", {}, dir, "w");
    const g = await deps.handle("node:create", {}, { kind: "group", parentId: null, name: "已有分组" });
    const preview = await deps.handle("import:preview", {}, { fileName: "x.yaml", content: "FIXED-MAGIC" });
    await deps.handle("import:apply", {}, { groupName: "已有分组", project: preview.project });
    const tree = await deps.handle("tree:get", {});
    expect(tree.children).toHaveLength(2); // 默认分组 + 已有分组
    const existingGroup = tree.children!.find((n: { id: string }) => n.id === g.id)!;
    expect(existingGroup.children!.map((n: { label: string }) => n.label)).toContain("导入项目");
  });

  it("import:preview/apply 入参形状非法时抛带频道名的可读错误（zod 校验先行）", async () => {
    const { deps, dir } = setupWithImporters([fixedImporter]);
    await deps.handle("ws:create", {}, dir, "w");
    await expect(deps.handle("import:preview", {}, { fileName: 42, content: "x" })).rejects.toThrow(/\[import:preview\]/);
    await expect(deps.handle("import:preview", {}, { content: "x" })).rejects.toThrow(/\[import:preview\]/);
    await expect(deps.handle("import:apply", {}, { groupName: "g", project: { id: "p" } })).rejects.toThrow(/\[import:apply\]/);
    await expect(deps.handle("import:apply", {}, { groupName: "g" })).rejects.toThrow(/\[import:apply\]/);
  });

  it("design:export 渲染 agent 设计 md 经注入的 saveFile 落盘并返回路径；取消返回空串", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-ipc-"));
    const session = createSession();
    const writes: Array<{ defaultName: string; content: string }> = [];
    const deps = createIpcDeps({
      session,
      pickDirectory: async () => dir,
      saveFile: async (defaultName, content) => {
        writes.push({ defaultName, content });
        return `C:\\fake\\${defaultName}`;
      },
    });
    await deps.handle("ws:create", {}, dir, "w");
    const g = await deps.handle("node:create", {}, { kind: "group", parentId: null, name: "g" });
    const p = await deps.handle("node:create", {}, { kind: "project", parentId: g.id, name: "p" });
    const c = await deps.handle("node:create", {}, { kind: "collection", parentId: p.id, name: "c" });
    const api = await deps.handle("node:create", {}, { kind: "api", parentId: c.id, name: "下单", method: "POST", url: "/orders" });
    const path = await deps.handle("design:export", {}, api.id);
    expect(path).toBe("C:\\fake\\下单.design.md");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.defaultName).toBe("下单.design.md");
    // 渲染产物 = core renderDesignMarkdown（agent 可消费的详细设计 md）
    expect(writes[0]!.content).toContain("# 接口详细设计：下单");
    expect(writes[0]!.content).toContain("**POST /orders**");
    // 用户取消保存对话框：主进程 saveFile 回传空串，频道原样返回
    const cancelDeps = createIpcDeps({ session, pickDirectory: async () => dir, saveFile: async () => "" });
    expect(await cancelDeps.handle("design:export", {}, api.id)).toBe("");
    // 未找到接口：可读错误
    await expect(deps.handle("design:export", {}, "不存在")).rejects.toThrow(/未找到接口/);
  });

  it("入参形状非法时抛带频道名的可读错误（单参/无参频道的类型与缺参）", async () => {
    const { deps } = setup();
    await expect(deps.handle("api:get", {}, 42)).rejects.toThrow(/\[api:get\] 入参校验失败/);
    await expect(deps.handle("ws:open", {})).rejects.toThrow(/\[ws:open\] 入参校验失败/);
    await expect(deps.handle("tree:get", {}, "多余参数")).rejects.toThrow(/\[tree:get\] 入参校验失败/);
  });

  it("入参形状非法时抛带频道名的可读错误（多参 tuple / 对象 / record 频道）", async () => {
    const { deps } = setup();
    await expect(deps.handle("ws:create", {}, "缺第二个参数")).rejects.toThrow(/\[ws:create\] 入参校验失败/);
    await expect(deps.handle("node:create", {}, { kind: "bogus", parentId: null, name: "x" })).rejects.toThrow(/\[node:create\] 入参校验失败/);
    await expect(deps.handle("env:vars:save", {}, "e1", { k: 42 })).rejects.toThrow(/\[env:vars:save\] 入参校验失败/);
  });

  it("可选字符串字段接受显式 null（渲染层「无选中」惯例）：走无环境/无继承语义而非校验拒绝", async () => {
    // 回归背景（修复轮 1）：代码库「无选中」惯例是 null（App.vue 的 string | null computed、
    // selectedEnvId/selectedCollectionId），optional 只认 undefined——store 原样透传 null
    // 会被全频道校验收口误伤，故 envName/extends 均为 nullish。
    const { deps, dir } = setup();
    await deps.handle("ws:create", {}, dir, "w");
    const g = await deps.handle("node:create", {}, { kind: "group", parentId: null, name: "g" });
    const p = await deps.handle("node:create", {}, { kind: "project", parentId: g.id, name: "p" });
    const c = await deps.handle("node:create", {}, { kind: "collection", parentId: p.id, name: "c" });
    const api = await deps.handle("node:create", {}, { kind: "api", parentId: c.id, name: "a", method: "GET", url: "http://127.0.0.1:1/" });
    // debug:send envName=null → 通过校验，按无环境运行（resolveEnv 对 falsy 一视同仁）
    const detail = await deps.handle("api:get", {}, api.id);
    const result = await deps.handle("debug:send", {}, { apiId: api.id, caseId: detail.api.cases[0]!.id, envName: null });
    expect(result.outcome.passed).toBe(false); // 不可达地址 → 运行完成、用例失败（无环境语义）
    expect(result.run.total).toBe(1);
    // env:create extends=null → 通过校验且不把 null 写进模型（严格 EnvironmentSchema 可重开）
    const env = await deps.handle("env:create", {}, { projectId: p.id, name: "sit", extends: null });
    expect(env.extends).toBeUndefined();
    const fresh = createIpcDeps({ session: createSession(), pickDirectory: async () => dir, saveFile: async () => "" });
    await fresh.handle("ws:open", {}, dir);
    const tree = await fresh.handle("tree:get", {});
    expect(tree.children![0]!.children![0]!.envs).toEqual([{ id: env.id, name: "sit", extends: undefined, variables: {}, baseUrls: {} }]);
  });
});

describe("工作流 IPC", () => {
  /** 共用夹具：工作区 + 分组 + 项目 + 集合 + 接口（含一个「冒烟」用例），返回 full api 供节点引用。 */
  async function setupWf() {
    const { deps, dir } = setup();
    await deps.handle("ws:create", {}, dir, "w");
    const group = await deps.handle("node:create", {}, { kind: "group", parentId: null, name: "g" });
    const project = await deps.handle("node:create", {}, { kind: "project", parentId: group.id, name: "p" });
    const collection = await deps.handle("node:create", {}, { kind: "collection", parentId: project.id, name: "c" });
    const api = await deps.handle("node:create", {}, { kind: "api", parentId: collection.id, name: "a", method: "GET", url: "http://127.0.0.1:1/" });
    const detail = await deps.handle("api:get", {}, api.id);
    return { deps, dir, project, api: detail.api };
  }

  it("wf:create → wf:list → wf:get → wf:save → wf:set-status 全链路", async () => {
    const { deps, dir, project, api } = await setupWf();
    const wf = await deps.handle("wf:create", {}, { projectId: project.id, name: "条件流" });
    expect(wf.status).toBe("draft");
    expect((await deps.handle("wf:list", {}, { projectId: project.id })).map((w: { name: string }) => w.name)).toEqual(["条件流"]);
    const got = await deps.handle("wf:get", {}, { workflowId: wf.id });
    expect(got.workflow.id).toBe(wf.id);
    expect(got.projectId).toBe(project.id);
    const saved = await deps.handle("wf:save", {}, { workflow: { ...wf, nodes: [{ id: "n1", kind: "request", apiId: api.id, caseId: api.cases[0]!.id }] } });
    expect(saved.status).toBe("draft");
    const r = await deps.handle("wf:set-status", {}, { workflowId: wf.id, next: "published" });
    expect(r.workflow.status).toBe("published");
    const enabled = await deps.handle("wf:set-status", {}, { workflowId: wf.id, next: "enabled" });
    expect(enabled.workflow.status).toBe("enabled");
    expect(enabled.errors).toEqual([]);
    // 全量落盘重开读回：节点与生命周期状态均持久化（save 走既有 fileStorage）
    const fresh = createIpcDeps({ session: createSession(), pickDirectory: async () => dir, saveFile: async () => "" });
    await fresh.handle("ws:open", {}, dir);
    const reread = await fresh.handle("wf:get", {}, { workflowId: wf.id });
    expect(reread.workflow.status).toBe("enabled");
    expect(reread.workflow.nodes.map((n: { id: string }) => n.id)).toEqual(["n1"]);
  });

  it("wf:set-status 启用校验失败返回 errors 且状态不变；非法迁移直接抛错", async () => {
    const { deps, project, api } = await setupWf();
    // request 节点引用不存在的用例：结构合法但启用校验必失败
    const wf = await deps.handle("wf:create", {}, { projectId: project.id, name: "坏引用流" });
    await deps.handle("wf:save", {}, { workflow: { ...wf, nodes: [{ id: "n1", kind: "request", apiId: "ghost-api", caseId: "ghost-case" }] } });
    // 发布（draft→published）不做启用校验，正常迁移
    const pub = await deps.handle("wf:set-status", {}, { workflowId: wf.id, next: "published" });
    expect(pub.workflow.status).toBe("published");
    // 启用：校验未过 → 返回状态不变 + errors 非空
    const enabled = await deps.handle("wf:set-status", {}, { workflowId: wf.id, next: "enabled" });
    expect(enabled.workflow.status).toBe("published");
    expect(enabled.errors.length).toBeGreaterThan(0);
    // 非法迁移（draft→enabled 跳级）由 core 守卫直接抛错（UI 按钮禁用本不应触发）；
    // 流须含合法节点（启用校验可通过）才会到达迁移守卫——空流在启用校验即被拒（§5 第 5 条）
    const wf2 = await deps.handle("wf:create", {}, { projectId: project.id, name: "跳级流" });
    await deps.handle("wf:save", {}, { workflow: { ...wf2, nodes: [{ id: "n1", kind: "request", apiId: api.id, caseId: api.cases[0]!.id }] } });
    await expect(deps.handle("wf:set-status", {}, { workflowId: wf2.id, next: "enabled" })).rejects.toThrow(/非法状态迁移/);
    // 空流（0 节点）启用 → 启用校验失败返回 errors 且状态不变（不走迁移守卫抛错）
    const wf3 = await deps.handle("wf:create", {}, { projectId: project.id, name: "空流" });
    await deps.handle("wf:set-status", {}, { workflowId: wf3.id, next: "published" });
    const emptyEnabled = await deps.handle("wf:set-status", {}, { workflowId: wf3.id, next: "enabled" });
    expect(emptyEnabled.workflow.status).toBe("published");
    expect(emptyEnabled.errors).toContain("工作流没有任何节点，无法启用");
    // 解除启用（enabled→published）合法；此处以 published 工作流验证 enabled 迁移守卫文案后补
    expect(await deps.handle("wf:get", {}, { workflowId: wf2.id })).toMatchObject({ workflow: { status: "draft" } });
  });

  it("wf:impact 反查引用；wf:delete 删除后列表为空", async () => {
    const { deps, project, api } = await setupWf();
    const wf = await deps.handle("wf:create", {}, { projectId: project.id, name: "引用流" });
    await deps.handle("wf:save", {}, { workflow: { ...wf, nodes: [{ id: "n1", kind: "request", apiId: api.id, caseId: api.cases[0]!.id, label: "下单" }] } });
    // 按用例反查：命中工作流/节点信息
    const hits = await deps.handle("wf:impact", {}, { caseId: api.cases[0]!.id });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ workflowId: wf.id, workflowName: "引用流", status: "draft", nodeId: "n1", nodeLabel: "下单" });
    // 按接口反查同样命中
    expect(await deps.handle("wf:impact", {}, { apiId: api.id })).toHaveLength(1);
    // 删除后列表为空，反查不再命中
    await deps.handle("wf:delete", {}, { workflowId: wf.id });
    expect(await deps.handle("wf:list", {}, { projectId: project.id })).toEqual([]);
    expect(await deps.handle("wf:impact", {}, { caseId: api.cases[0]!.id })).toEqual([]);
  });

  it("重名创建拒绝；未知 workflowId 抛「未找到工作流」", async () => {
    const { deps, project } = await setupWf();
    await deps.handle("wf:create", {}, { projectId: project.id, name: "条件流" });
    await expect(deps.handle("wf:create", {}, { projectId: project.id, name: "条件流" })).rejects.toThrow(/工作流已存在: 条件流/);
    await expect(deps.handle("wf:get", {}, { workflowId: "不存在" })).rejects.toThrow(/未找到工作流: 不存在/);
    await expect(deps.handle("wf:delete", {}, { workflowId: "不存在" })).rejects.toThrow(/未找到工作流: 不存在/);
    await expect(deps.handle("wf:save", {}, { workflow: { id: "不存在", name: "x", status: "draft", nodes: [], edges: [] } })).rejects.toThrow(/未找到工作流: 不存在/);
    await expect(deps.handle("wf:set-status", {}, { workflowId: "不存在", next: "published" })).rejects.toThrow(/未找到工作流: 不存在/);
  });

  it("wf:rename 改名后 wf:list 反映新名、树摘要同步且旧目录清理（落盘读回）；重名拒绝", async () => {
    const { deps, dir, project } = await setupWf();
    const wf = await deps.handle("wf:create", {}, { projectId: project.id, name: "old-name-flow" });
    await deps.handle("wf:rename", {}, { workflowId: wf.id, name: "new-name-flow" });
    // wf:list 反映新名
    expect((await deps.handle("wf:list", {}, { projectId: project.id })).map((w: { name: string }) => w.name)).toEqual(["new-name-flow"]);
    // 树 DTO project 节点 workflows 摘要同步（侧树入口数据源）
    const tree = await deps.handle("tree:get", {});
    const gNodeWf = tree.children!.find((x: { label: string }) => x.label === "g")!;
    expect(gNodeWf.children![0]!.workflows).toEqual([{ id: wf.id, name: "new-name-flow", status: "draft" }]);
    // 落盘读回：新目录可读、旧目录已清理（rename 分支显式 save → cleanupOrphanDirs 补层）
    const fresh = createIpcDeps({ session: createSession(), pickDirectory: async () => dir, saveFile: async () => "" });
    await fresh.handle("ws:open", {}, dir);
    const reread = await fresh.handle("wf:get", {}, { workflowId: wf.id });
    expect(reread.workflow.name).toBe("new-name-flow");
    // 重名拒绝（与 wf:create 同文案）+ 未知 id 抛「未找到工作流」+ zod 入参校验
    await deps.handle("wf:create", {}, { projectId: project.id, name: "placeholder-flow" });
    await expect(deps.handle("wf:rename", {}, { workflowId: wf.id, name: "placeholder-flow" })).rejects.toThrow(/工作流已存在: placeholder-flow/);
    await expect(deps.handle("wf:rename", {}, { workflowId: "不存在", name: "x" })).rejects.toThrow(/未找到工作流: 不存在/);
    await expect(deps.handle("wf:rename", {}, { workflowId: 42, name: "x" })).rejects.toThrow(/\[wf:rename\] 入参校验失败/);
  });

  it("wf:run：draft 拒绝运行；envName 未找到抛错；成功运行落盘 .apicc/runs/workflow-*.json", async () => {
    const { deps, dir, project, api } = await setupWf();
    const wf = await deps.handle("wf:create", {}, { projectId: project.id, name: "运行流" });
    await deps.handle("wf:save", {}, { workflow: { ...wf, nodes: [{ id: "n1", kind: "request", apiId: api.id, caseId: api.cases[0]!.id }] } });
    // draft 直接拒绝（UI 对 draft 禁用运行按钮，本错误为护栏）
    await expect(deps.handle("wf:run", {}, { workflowId: wf.id })).rejects.toThrow(/工作流为草稿，请先发布启用/);
    await deps.handle("wf:set-status", {}, { workflowId: wf.id, next: "published" });
    await deps.handle("wf:set-status", {}, { workflowId: wf.id, next: "enabled" });
    // 环境按名解析：未命中显式抛错（不静默降级为无环境运行）
    await expect(deps.handle("wf:run", {}, { workflowId: wf.id, envName: "nope" })).rejects.toThrow(/未找到环境: nope/);
    // 成功运行（不可达地址 → 节点 failed，但运行链路完整），结果落盘 workflow-<id>-<ts>.json
    const result = await deps.handle("wf:run", {}, { workflowId: wf.id });
    expect(result.workflowId).toBe(wf.id);
    expect(result.total).toBe(1);
    expect(result.nodeResults).toHaveLength(1);
    const files = readdirSync(join(dir, ".apicc", "runs"));
    expect(files.some((f) => f.startsWith(`workflow-${wf.id}-`) && f.endsWith(".json"))).toBe(true);
  });

  it("wf 频道入参形状非法时抛带频道名的可读错误（zod 校验入表）", async () => {
    const { deps, project } = await setupWf();
    await expect(deps.handle("wf:create", {}, { projectId: 42, name: "x" })).rejects.toThrow(/\[wf:create\] 入参校验失败/);
    await expect(deps.handle("wf:list", {}, {})).rejects.toThrow(/\[wf:list\] 入参校验失败/);
    await expect(deps.handle("wf:get", {}, "not-an-object")).rejects.toThrow(/\[wf:get\] 入参校验失败/);
    // wf:save 走 WorkflowSchema 全量校验：未知字段/缺字段均拒绝（strict schema）
    await expect(deps.handle("wf:save", {}, { workflow: { id: "w", name: "x", bogus: true } })).rejects.toThrow(/\[wf:save\] 入参校验失败/);
    await expect(deps.handle("wf:set-status", {}, { workflowId: project.id, next: "bogus" })).rejects.toThrow(/\[wf:set-status\] 入参校验失败/);
    await expect(deps.handle("wf:impact", {}, { caseId: 42 })).rejects.toThrow(/\[wf:impact\] 入参校验失败/);
    await expect(deps.handle("wf:run", {}, { workflowId: "w" })).rejects.toThrow(/未找到工作流/);
  });
});

describe("压测 IPC", () => {
  // —— 压测频道（M2-D3 任务 1）：stress:run 主进程执行并落盘，runs:list/get 按 kind 判别 ——
  it("stress:run 执行压测并落盘 stress-*.json；runs:list/get 按 kind 判别；无活动 stop 抛「没有进行中的压测」", async () => {
    const { deps, dir } = setup();
    await deps.handle("ws:create", {}, dir, "w");
    const g = await deps.handle("node:create", {}, { kind: "group", parentId: null, name: "g" });
    const p = await deps.handle("node:create", {}, { kind: "project", parentId: g.id, name: "p" });
    const c = await deps.handle("node:create", {}, { kind: "collection", parentId: p.id, name: "c" });
    const api = await deps.handle("node:create", {}, { kind: "api", parentId: c.id, name: "a", method: "GET", url: "http://127.0.0.1:1/" });
    const detail = await deps.handle("api:get", {}, api.id);
    // envName=null 兼容既有 nullish 口径：通过校验按无环境运行（不可达地址 → failed 采样，运行完成）
    const out = await deps.handle("stress:run", {}, { apiId: api.id, caseId: detail.api.cases[0]!.id, envName: null, concurrency: 1, maxIterations: 1 });
    expect(out.report.totalRequests).toBe(1);
    expect(out.file).toMatch(new RegExp(`^stress-${api.id}-\\d+\\.json$`));
    const list = await deps.handle("runs:list", {});
    expect(list).toHaveLength(1);
    expect(list[0].kind).toBe("stress");
    expect(list[0].totalRequests).toBe(1);
    const stressDetail = await deps.handle("runs:get", {}, out.file);
    expect(stressDetail.kind).toBe("stress");
    expect(stressDetail.report.totalRequests).toBe(1);
    // 运行已结束：无活动运行时 stress:stop 抛「没有进行中的压测」
    await expect(deps.handle("stress:stop", {})).rejects.toThrow(/没有进行中的压测/);
  });

  it("stress:run 入参校验：负并发/零并发/非整数并发 zod 拒绝；迭代与时长都缺走 core 文案（可空字段 null 兼容）", async () => {
    const { deps, dir } = setup();
    await deps.handle("ws:create", {}, dir, "w");
    const g = await deps.handle("node:create", {}, { kind: "group", parentId: null, name: "g" });
    const p = await deps.handle("node:create", {}, { kind: "project", parentId: g.id, name: "p" });
    const c = await deps.handle("node:create", {}, { kind: "collection", parentId: p.id, name: "c" });
    const api = await deps.handle("node:create", {}, { kind: "api", parentId: c.id, name: "a", method: "GET", url: "http://127.0.0.1:1/" });
    await expect(deps.handle("stress:run", {}, { apiId: api.id, caseId: "x", concurrency: -1, maxIterations: 1 })).rejects.toThrow(/\[stress:run\] 入参校验失败/);
    await expect(deps.handle("stress:run", {}, { apiId: api.id, caseId: "x", concurrency: 0, maxIterations: 1 })).rejects.toThrow(/\[stress:run\] 入参校验失败/);
    await expect(deps.handle("stress:run", {}, { apiId: api.id, caseId: "x", concurrency: 1.5, maxIterations: 1 })).rejects.toThrow(/\[stress:run\] 入参校验失败/);
    // maxIterations/durationMs 传 null（antd InputNumber 清空口径）：通过 zod，运行层报 core 终止条件文案
    const detail = await deps.handle("api:get", {}, api.id);
    await expect(deps.handle("stress:run", {}, { apiId: api.id, caseId: detail.api.cases[0]!.id, concurrency: 1, maxIterations: null, durationMs: null })).rejects.toThrow(/压测终止条件缺失/);
  });
});

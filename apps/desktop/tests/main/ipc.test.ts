import { mkdtempSync } from "node:fs";
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
      id: "p-imported", name: "导入项目", variables: {}, environments: [],
      collections: [{ id: "c-imported", name: "导入集合", variables: {}, folders: [], apis: [] }],
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
    expect(tree.children).toEqual([]);
    const group = await deps.handle("node:create", {}, { kind: "group", parentId: null, name: "g" });
    const project = await deps.handle("node:create", {}, { kind: "project", parentId: group.id, name: "p" });
    const collection = await deps.handle("node:create", {}, { kind: "collection", parentId: project.id, name: "c" });
    const api = await deps.handle("node:create", {}, { kind: "api", parentId: collection.id, name: "a", method: "GET", url: "/" });
    // 契约收紧（宽审查 I2）：node:create 返回统一瘦 DTO，不再泄漏 url/cases 等原生字段
    expect(group).toEqual({ kind: "group", id: group.id, label: "g" });
    expect(api).toEqual({ kind: "api", id: api.id, label: "a", method: "GET" });
    tree = await deps.handle("tree:get", {});
    const apiNode = tree.children![0]!.children![0]!.children![0]!.children![0]!;
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
    const folderNode = tree.children![0]!.children![0]!.children![0]!.children!.find((n: { kind: string }) => n.kind === "folder")!;
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
    expect(projectNode.envs).toEqual([{ id: env.id, name: "sit", extends: "dev", variables: {} }]);
    // env:vars:save → 变量覆盖 + 显式 save 落盘，重开读回验证
    await fresh.handle("env:vars:save", {}, env.id, { baseUrl: "http://s" });
    const rereadSession = createSession();
    const reread = createIpcDeps({ session: rereadSession, pickDirectory: async () => dir, saveFile: async () => "" });
    await reread.handle("ws:open", {}, dir);
    const sit = rereadSession.workspace!.groups[0]!.projects[0]!.environments[0]!;
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
    expect(tree.children).toHaveLength(1);
    expect(tree.children![0]!.id).toBe(g.id);
    expect(tree.children![0]!.children!.map((n: { label: string }) => n.label)).toContain("导入项目");
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
});

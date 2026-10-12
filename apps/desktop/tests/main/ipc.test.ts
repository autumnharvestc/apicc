import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ContractProject, Importer, Workflow, WorkflowRunResult, WorkflowStatus } from "@apicc/core";
import { createIpcDeps } from "../../src/main/ipc.js";
import { createSession } from "../../src/main/session.js";
import { createStressPreloadApi } from "../../src/preload/stressBridge.js";
import type { WorkflowLocator } from "../../src/shared/locations.js";
import type { NodeCreateInput, NodeCreatedDTO, WfSetStatusResult, WorkflowDetail, WorkflowSummary } from "../../src/shared/types.js";
import { IDS, makeWorkspace, persistWorkspace, projectOne, projectTwo } from "./helpers/contract-assets.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "apicc-ipc-"));
  const session = createSession();
  const deps = createIpcDeps({ session, pickDirectory: async () => dir, saveFile: async () => "" });
  return { deps, dir, session };
}

/** 固定 importer 替身：detect 按 MAGIC 标记命中，parse 返回固定项目与警告（导入器由 deps 注入）。 */
const fixedImporter: Importer = {
  name: "fixed",
  detect: (_fileName, content) => content.includes("FIXED-MAGIC"),
  parse: () => ({ project: importProject(), warnings: ["示例警告"], diagnostics: [] }),
};

function setupWithImporters(importers: Importer[]) {
  const dir = mkdtempSync(join(tmpdir(), "apicc-ipc-"));
  const session = createSession();
  const deps = createIpcDeps({ session, pickDirectory: async () => dir, saveFile: async () => "", importers });
  return { deps, dir, session };
}

function invalidIpc(deps: ReturnType<typeof createIpcDeps>, channel: string, ...args: unknown[]): Promise<unknown> {
  const rawHandle = deps.handle.bind(deps) as unknown as (
    channel: string,
    event: object,
    ...args: unknown[]
  ) => Promise<unknown>;
  return rawHandle(channel, {}, ...args);
}

type CreatedGroup = Extract<NodeCreatedDTO, { kind: "group" }>;
type CreatedProject = Extract<NodeCreatedDTO, { kind: "project" }>;
type CreatedCollection = Extract<NodeCreatedDTO, { kind: "collection" }>;
type CreatedFolder = Extract<NodeCreatedDTO, { kind: "folder" }>;
type CreatedApi = Extract<NodeCreatedDTO, { kind: "api" }>;

async function createGroup(deps: ReturnType<typeof createIpcDeps>, session: ReturnType<typeof createSession>, name: string): Promise<CreatedGroup> {
  const result = await deps.handle("node:create", {}, { kind: "group", parent: { workspaceId: session.workspace!.id }, name });
  if (result.kind !== "group") throw new Error(`Expected group DTO, received ${result.kind}`);
  return result;
}

async function createProject(deps: ReturnType<typeof createIpcDeps>, group: CreatedGroup, name: string): Promise<CreatedProject> {
  const result = await deps.handle("node:create", {}, { kind: "project", parent: group.locator, name });
  if (result.kind !== "project") throw new Error(`Expected project DTO, received ${result.kind}`);
  return result;
}

async function createCollection(deps: ReturnType<typeof createIpcDeps>, project: CreatedProject, name: string): Promise<CreatedCollection> {
  const result = await deps.handle("node:create", {}, { kind: "collection", parent: project.locator, name });
  if (result.kind !== "collection") throw new Error(`Expected collection DTO, received ${result.kind}`);
  return result;
}

async function createFolder(deps: ReturnType<typeof createIpcDeps>, parent: CreatedCollection, name: string): Promise<CreatedFolder> {
  const result = await deps.handle("node:create", {}, { kind: "folder", parent: parent.locator, name });
  if (result.kind !== "folder") throw new Error(`Expected folder DTO, received ${result.kind}`);
  return result;
}

async function createApi(
  deps: ReturnType<typeof createIpcDeps>,
  parent: CreatedCollection | CreatedFolder,
  api: Extract<NodeCreateInput, { kind: "api" }>['api'],
): Promise<CreatedApi> {
  const result = await deps.handle("node:create", {}, { kind: "api", parent: parent.locator, api });
  if (result.kind !== "api") throw new Error(`Expected API DTO, received ${result.kind}`);
  return result;
}

function workflowLocator(project: CreatedProject, workflow: Workflow): WorkflowLocator {
  return { ...project.locator, workflowId: workflow.id };
}

async function createWorkflow(deps: ReturnType<typeof createIpcDeps>, project: CreatedProject, name: string): Promise<Workflow> {
  return deps.handle("wf:create", {}, { locator: project.locator, name });
}

async function saveWorkflow(deps: ReturnType<typeof createIpcDeps>, project: CreatedProject, workflow: Workflow): Promise<Workflow> {
  return deps.handle("wf:save", {}, workflowLocator(project, workflow), workflow);
}

async function setWorkflowStatus(deps: ReturnType<typeof createIpcDeps>, project: CreatedProject, workflow: Workflow, status: WorkflowStatus): Promise<WfSetStatusResult> {
  return deps.handle("wf:set-status", {}, workflowLocator(project, workflow), status);
}

async function runWorkflow(deps: ReturnType<typeof createIpcDeps>, project: CreatedProject, workflow: Workflow, options: { envName?: string | null; strict?: boolean } = {}): Promise<WorkflowRunResult> {
  return deps.handle("wf:run", {}, { locator: workflowLocator(project, workflow), ...options });
}

async function getWorkflow(deps: ReturnType<typeof createIpcDeps>, project: CreatedProject, workflow: Workflow): Promise<WorkflowDetail> {
  return deps.handle("wf:get", {}, workflowLocator(project, workflow));
}

async function deleteWorkflow(deps: ReturnType<typeof createIpcDeps>, project: CreatedProject, workflow: Workflow): Promise<void> {
  return deps.handle("wf:delete", {}, workflowLocator(project, workflow));
}

async function renameWorkflow(deps: ReturnType<typeof createIpcDeps>, project: CreatedProject, workflow: Workflow, name: string): Promise<Workflow> {
  return deps.handle("wf:rename", {}, workflowLocator(project, workflow), name);
}

async function listWorkflows(deps: ReturnType<typeof createIpcDeps>, project: CreatedProject): Promise<WorkflowSummary[]> {
  return deps.handle("wf:list", {}, project.locator);
}

function importProject(): ContractProject {
  const project = structuredClone(projectOne(makeWorkspace()));
  project.name = "导入项目";
  return project;
}

describe("IPC 处理器", () => {
  it("ws:create → tree:get → node:create → api:get 全链路", async () => {
    const { deps, dir, session } = setup();
    const opened = await deps.handle("ws:create", {}, dir, "演示");
    expect(opened.workspace.name).toBe("演示");
    let tree = await deps.handle("tree:get", {});
    // M10：默认分组是唯一顶层节点
    expect(tree.children).toHaveLength(1);
    expect(tree.children![0]).toMatchObject({ kind: "group", label: "默认分组" });
    const group = await createGroup(deps, session, "g");
    const project = await createProject(deps, group, "p");
    const collection = await createCollection(deps, project, "c");
    const api = await createApi(deps, collection, { name: "a", method: "GET", baseUrl: "http://127.0.0.1:1", path: "/" });
    expect(group).toMatchObject({ kind: "group", id: group.id, label: "g", locator: { workspaceId: opened.workspace.id, groupId: group.id } });
    expect(api).toMatchObject({ kind: "api", id: api.id, label: "a", protocol: "http", method: "GET", locator: { apiId: api.id } });
    tree = await deps.handle("tree:get", {});
    const gNode = tree.children!.find((x: { label: string }) => x.label === "g")!;
    const apiNode = gNode.children![0]!.children![0]!.children![0]!;
    expect(apiNode.id).toBe(api.id);
    const fetched = await deps.handle("api:get", {}, api.locator);
    expect(fetched.api.contract.metadata.name).toBe("a");
    expect(fetched.envs).toEqual([]);
  });

  it("folder 内新建接口：full folder locator 将接口挂到所属集合的文件夹下", async () => {
    const { deps, dir, session } = setup();
    await deps.handle("ws:create", {}, dir, "w");
    const group = await createGroup(deps, session, "g");
    const project = await createProject(deps, group, "p");
    const collection = await createCollection(deps, project, "c");
    const folder = await createFolder(deps, collection, "f");
    const api = await createApi(deps, folder, { name: "a", method: "GET", baseUrl: "http://127.0.0.1:1", path: "/" });
    expect(api.kind).toBe("api");
    const fetched = await deps.handle("api:get", {}, api.locator);
    expect(fetched.api.contract.metadata.name).toBe("a");
    const tree = await deps.handle("tree:get", {});
    const gNode = tree.children!.find((x: { label: string }) => x.label === "g")!;
    const folderNode = gNode.children![0]!.children![0]!.children!.find((n: { kind: string }) => n.kind === "folder")!;
    expect(folderNode.children!.map((c: { id: string }) => c.id)).toContain(api.id);
  });

  it("api:save 持久化并落盘", async () => {
    const { deps, dir, session } = setup();
    await deps.handle("ws:create", {}, dir, "w");
    const g = await createGroup(deps, session, "g");
    const p = await createProject(deps, g, "p");
    const c = await createCollection(deps, p, "c");
    const api = await createApi(deps, c, { name: "a", method: "GET", baseUrl: "http://127.0.0.1:1", path: "/x" });
    const detail = await deps.handle("api:get", {}, api.locator);
    (detail.api.contract.request as { path: string }).path = "/y";
    await deps.handle("api:save", {}, api.locator, detail.api);
    const fresh = createIpcDeps({ session: createSession(), pickDirectory: async () => dir, saveFile: async () => "" });
    await fresh.handle("ws:open", {}, dir);
    const fetched = await fresh.handle("api:get", {}, api.locator);
    expect((fetched.api.contract.request as { path: string }).path).toBe("/y");
  });

  it("env:create 返回环境对象并落盘；env:vars:save 保存变量后重开读回", async () => {
    const { deps, dir, session } = setup();
    await deps.handle("ws:create", {}, dir, "w");
    const g = await createGroup(deps, session, "g");
    const p = await createProject(deps, g, "p");
    // env:create → 返回环境对象；处理器显式 save 落盘（session 变更操作不自动落盘）
    const env = await deps.handle("env:create", {}, { locator: p.locator, name: "sit", extends: "dev" });
    expect(env).toMatchObject({ name: "sit", extends: "dev", variables: {} });
    expect(env.id).toBeTruthy();
    await expect(deps.handle("env:create", {}, { locator: { ...p.locator, projectId: "00000000-0000-4000-8000-000000009999" }, name: "x" })).rejects.toThrow(/Project not found/);
    const fresh = createIpcDeps({ session: createSession(), pickDirectory: async () => dir, saveFile: async () => "" });
    await fresh.handle("ws:open", {}, dir);
    const tree = await fresh.handle("tree:get", {});
    // id 布局（轨一）：重开加载按目录名（=UUID）字典序，分组顺序随机——按 id 定位，禁用下标
    const groupNode = tree.children!.find((n) => n.kind === "group" && n.id === g.id);
    if (!groupNode || groupNode.kind !== "group") throw new Error("Imported group missing from tree");
    const projectNode = groupNode.children[0];
    if (!projectNode || projectNode.kind !== "project") throw new Error("Imported project missing from tree");
    expect(projectNode.envs).toMatchObject([{ id: env.id, name: "sit", extends: "dev", variables: {}, baseUrls: {} }]);
    // env:vars:save → 变量覆盖 + 显式 save 落盘，重开读回验证
    await fresh.handle("env:vars:save", {}, { ...p.locator, environmentId: env.id }, { baseUrl: "http://s" });
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
    const { deps, dir, session } = setup();
    await deps.handle("ws:create", {}, dir, "w");
    const g = await createGroup(deps, session, "g");
    const p = await createProject(deps, g, "p");
    const c = await createCollection(deps, p, "c");
    const api = await createApi(deps, c, { name: "a", method: "GET", baseUrl: "http://127.0.0.1:1", path: "/" });
    const detail = await deps.handle("api:get", {}, api.locator);
    const result = await deps.handle("debug:send", {}, { locator: api.locator, caseId: detail.api.cases[0]!.id, envName: undefined });
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

  it("import:apply project 模式落到所选分组（按 id 选择）、落盘可重开；重复导入同名并存（轨二）", async () => {
    const { deps, dir, session } = setupWithImporters([fixedImporter]);
    await deps.handle("ws:create", {}, dir, "w");
    const g = await createGroup(deps, session, "目标分组");
    const preview = await deps.handle("import:preview", {}, { fileName: "x.yaml", content: "FIXED-MAGIC" });
    await deps.handle("import:apply", {}, { mode: "project", target: g.locator, name: "导入项目", project: preview.project });
    // 重开读回：分组与项目均已落盘（apply 分支显式 save 语义）
    const fresh = createIpcDeps({ session: createSession(), pickDirectory: async () => dir, saveFile: async () => "" });
    await fresh.handle("ws:open", {}, dir);
    const tree = await fresh.handle("tree:get", {});
    const importedGroup = tree.children!.find((n: { id: string }) => n.id === g.id)!;
    expect(importedGroup).toBeDefined();
    expect(importedGroup.children!.map((n: { label: string }) => n.label)).toContain("导入项目");
    // 同分组重复导入同名项目：同名放开（轨二）并存，两次导入 id 不同
    await deps.handle("import:apply", {}, { mode: "project", target: g.locator, name: "导入项目", project: preview.project });
    const tree2 = await deps.handle("tree:get", {});
    const dup = tree2.children!.find((n: { id: string }) => n.id === g.id)!.children!.filter((n: { label: string }) => n.label === "导入项目");
    expect(dup).toHaveLength(2);
    // 固定 importer 复用同一 project 对象（id 相同）——并存条数即语义；真实导入器 id 均为新 UUID
    const proj = session.workspace!.groups.find((x) => x.id === g.id)!.projects;
    expect(proj.filter((x) => x.name === "导入项目")).toHaveLength(2);
  });

  it("import:apply module 模式并入目标项目（baseUrl 进模块变量、不造环境）", async () => {
    const { deps, dir, session } = setupWithImporters([fixedImporter]);
    await deps.handle("ws:create", {}, dir, "w");
    const g = await createGroup(deps, session, "g");
    const p = await createProject(deps, g, "宿主项目");
    // 产物带 imported 环境（baseUrl）——module 模式应把它写进模块变量而不是落环境
    const importer: Importer = {
      name: "fixed",
      detect: (_fileName, content) => content.includes("FIXED-MAGIC"),
      parse: () => {
        const project = importProject();
        project.environments = [{ ...project.environments[0]!, name: "imported", variables: { baseUrl: "http://from-file" }, baseUrls: {} }];
        const collection = project.collections[0]!;
        collection.name = "导入集合";
        collection.apis = [];
        collection.folders = [];
        project.collections = [collection];
        return { project, warnings: [], diagnostics: [] };
      },
    };
    const deps2 = createIpcDeps({ session, pickDirectory: async () => dir, saveFile: async () => "", importers: [importer] });
    const preview = await deps2.handle("import:preview", {}, { fileName: "x.yaml", content: "FIXED-MAGIC" });
    await deps2.handle("import:apply", {}, { mode: "module", target: p.locator, name: "并入模块", project: preview.project });
    const ws = session.workspace!;
    const host = ws.groups.find((x) => x.id === g.id)!.projects.find((x) => x.id === p.id)!;
    expect(host.collections.map((c) => c.name)).toEqual(["并入模块"]);
    expect(host.collections[0]!.variables.baseUrl).toBe("http://from-file");
    expect(host.environments).toEqual([]); // 不造环境
  });

  it("import:apply 目标分组已存在时合并进该分组（按 id，不新建）", async () => {
    const { deps, dir, session } = setupWithImporters([fixedImporter]);
    await deps.handle("ws:create", {}, dir, "w");
    const g = await createGroup(deps, session, "已有分组");
    const preview = await deps.handle("import:preview", {}, { fileName: "x.yaml", content: "FIXED-MAGIC" });
    await deps.handle("import:apply", {}, { mode: "project", target: g.locator, name: "导入项目", project: preview.project });
    const tree = await deps.handle("tree:get", {});
    expect(tree.children).toHaveLength(2); // 默认分组 + 已有分组
    const existingGroup = tree.children!.find((n) => n.kind === "group" && n.id === g.id);
    if (!existingGroup || existingGroup.kind !== "group") throw new Error("Existing group missing from tree");
    expect(existingGroup.children!.map((n: { label: string }) => n.label)).toContain("导入项目");
  });

  it("import:preview/apply 入参形状非法时抛带频道名的可读错误（zod 校验先行）", async () => {
    const { deps, dir } = setupWithImporters([fixedImporter]);
    await deps.handle("ws:create", {}, dir, "w");
    await expect(invalidIpc(deps, "import:preview", { fileName: 42, content: "x" })).rejects.toThrow(/\[import:preview\]/);
    await expect(invalidIpc(deps, "import:preview", { content: "x" })).rejects.toThrow(/\[import:preview\]/);
    await expect(invalidIpc(deps, "import:apply", { mode: "project", target: { workspaceId: "00000000-0000-4000-8000-000000000001", groupId: "00000000-0000-4000-8000-000000000002" }, name: "n", project: { id: "p" } })).rejects.toThrow(/\[import:apply\]/);
    await expect(invalidIpc(deps, "import:apply", { mode: "module", target: { workspaceId: "00000000-0000-4000-8000-000000000001", groupId: "00000000-0000-4000-8000-000000000002", projectId: "00000000-0000-4000-8000-000000000003" }, name: "n" })).rejects.toThrow(/\[import:apply\]/);
    await expect(invalidIpc(deps, "import:apply", { mode: "bogus" })).rejects.toThrow(/\[import:apply\]/);
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
    const g = await createGroup(deps, session, "g");
    const p = await createProject(deps, g, "p");
    const c = await createCollection(deps, p, "c");
    const api = await createApi(deps, c, { name: "下单", method: "POST", baseUrl: "http://127.0.0.1:1", path: "/orders" });
    const path = await deps.handle("design:export", {}, api.locator);
    expect(path).toBe("C:\\fake\\下单.design.md");
    expect(writes).toHaveLength(1);
    expect(writes[0]!.defaultName).toBe("下单.design.md");
    // 渲染产物 = core renderDesignMarkdown（agent 可消费的详细设计 md）
    expect(writes[0]!.content).toContain("# 下单");
    expect(writes[0]!.content).toContain("- Method: POST");
    expect(writes[0]!.content).toContain("- Path: /orders");
    // 用户取消保存对话框：主进程 saveFile 回传空串，频道原样返回
    const cancelDeps = createIpcDeps({ session, pickDirectory: async () => dir, saveFile: async () => "" });
    expect(await cancelDeps.handle("design:export", {}, api.locator)).toBe("");
    // 未找到接口：可读错误
    await expect(deps.handle("design:export", {}, { ...api.locator, apiId: "00000000-0000-4000-8000-000000009999" })).rejects.toThrow(/未找到接口/);
  });

  it("入参形状非法时抛带频道名的可读错误（单参/无参频道的类型与缺参）", async () => {
    const { deps } = setup();
    await expect(invalidIpc(deps, "api:get", 42)).rejects.toThrow(/\[api:get\] 入参校验失败/);
    await expect(invalidIpc(deps, "ws:open")).rejects.toThrow(/\[ws:open\] 入参校验失败/);
    await expect(invalidIpc(deps, "tree:get", "多余参数")).rejects.toThrow(/\[tree:get\] 入参校验失败/);
  });

  it("入参形状非法时抛带频道名的可读错误（多参 tuple / 对象 / record 频道）", async () => {
    const { deps } = setup();
    await expect(invalidIpc(deps, "ws:create", "缺第二个参数")).rejects.toThrow(/\[ws:create\] 入参校验失败/);
    await expect(invalidIpc(deps, "node:create", { kind: "bogus", parent: { workspaceId: "00000000-0000-4000-8000-000000000001" }, name: "x" })).rejects.toThrow(/\[node:create\] 入参校验失败/);
    await expect(invalidIpc(deps, "env:vars:save", "e1", { k: 42 })).rejects.toThrow(/\[env:vars:save\] 入参校验失败/);
  });

  it("可选字符串字段接受显式 null（渲染层「无选中」惯例）：走无环境/无继承语义而非校验拒绝", async () => {
    // 回归背景（修复轮 1）：代码库「无选中」惯例是 null（App.vue 的 string | null computed、
    // selectedEnvId/selectedCollectionId），optional 只认 undefined——store 原样透传 null
    // 会被全频道校验收口误伤，故 envName/extends 均为 nullish。
    const { deps, dir, session } = setup();
    await deps.handle("ws:create", {}, dir, "w");
    const g = await createGroup(deps, session, "g");
    const p = await createProject(deps, g, "p");
    const c = await createCollection(deps, p, "c");
    const api = await createApi(deps, c, { name: "a", method: "GET", baseUrl: "http://127.0.0.1:1", path: "/" });
    // debug:send envName=null → 通过校验，按无环境运行（resolveEnv 对 falsy 一视同仁）
    const detail = await deps.handle("api:get", {}, api.locator);
    const result = await deps.handle("debug:send", {}, { locator: api.locator, caseId: detail.api.cases[0]!.id, envName: null });
    expect(result.outcome.passed).toBe(false); // 不可达地址 → 运行完成、用例失败（无环境语义）
    expect(result.run.total).toBe(1);
    // env:create extends=null → 通过校验且不把 null 写进模型（严格 EnvironmentSchema 可重开）
    const env = await deps.handle("env:create", {}, { locator: p.locator, name: "sit", extends: null });
    expect(env.extends).toBeUndefined();
    const fresh = createIpcDeps({ session: createSession(), pickDirectory: async () => dir, saveFile: async () => "" });
    await fresh.handle("ws:open", {}, dir);
    const tree = await fresh.handle("tree:get", {});
    // id 布局（轨一）：重开后分组顺序=UUID 字典序（随机）——按 id 定位
    const gNode = tree.children!.find((n) => n.kind === "group" && n.id === g.id);
    if (!gNode || gNode.kind !== "group") throw new Error("Group missing from tree");
    const projectNode = gNode.children[0];
    if (!projectNode || projectNode.kind !== "project") throw new Error("Project missing from tree");
    expect(projectNode.envs).toMatchObject([{ id: env.id, name: "sit", variables: {}, baseUrls: {} }]);
  });
});

describe("工作流 IPC", () => {
  /** 共用夹具：工作区 + 分组 + 项目 + 集合 + 接口（含一个「冒烟」用例），返回 full api 供节点引用。 */
  async function setupWf() {
    const { deps, dir, session } = setup();
    await deps.handle("ws:create", {}, dir, "w");
    const group = await createGroup(deps, session, "g");
    const project = await createProject(deps, group, "p");
    const collection = await createCollection(deps, project, "c");
    const api = await createApi(deps, collection, { name: "a", method: "GET", baseUrl: "http://127.0.0.1:1", path: "/" });
    const detail = await deps.handle("api:get", {}, api.locator);
    return { deps, dir, project, api: detail.api, apiLocator: api.locator, session };
  }

  it("wf:create → wf:list → wf:get → wf:save → wf:set-status 全链路", async () => {
    const { deps, dir, project, api } = await setupWf();
    const wf = await createWorkflow(deps, project, "条件流");
    expect(wf.status).toBe("draft");
    expect((await listWorkflows(deps, project)).map((w: { name: string }) => w.name)).toEqual(["条件流"]);
    const got = await getWorkflow(deps, project, wf);
    expect(got.workflow.id).toBe(wf.id);
    expect(got.locator.projectId).toBe(project.id);
    const saved = await saveWorkflow(deps, project, { ...wf, nodes: [{ id: "n1", kind: "request", apiId: api.contract.id, caseId: api.cases[0]!.id }] });
    expect(saved.status).toBe("draft");
    const r = await setWorkflowStatus(deps, project, wf, "published");
    expect(r.workflow.status).toBe("published");
    const enabled = await setWorkflowStatus(deps, project, wf, "enabled");
    expect(enabled.workflow.status).toBe("enabled");
    expect(enabled.errors).toEqual([]);
    // 全量落盘重开读回：节点与生命周期状态均持久化（save 走既有 fileStorage）
    const fresh = createIpcDeps({ session: createSession(), pickDirectory: async () => dir, saveFile: async () => "" });
    await fresh.handle("ws:open", {}, dir);
    const reread = await fresh.handle("wf:get", {}, workflowLocator(project, wf));
    expect(reread.workflow.status).toBe("enabled");
    expect(reread.workflow.nodes.map((n: { id: string }) => n.id)).toEqual(["n1"]);
  });

  it("wf:set-status 启用校验失败返回诊断 DTO 且不提交；非法迁移仍 reject", async () => {
    const { deps, project, api, session } = await setupWf();
    // 先用有效引用完成发布，再保存缺失引用；启用校验失败时状态不变。
    const wf = await createWorkflow(deps, project, "坏引用流");
    await saveWorkflow(deps, project, { ...wf, nodes: [{ id: "n1", kind: "request", apiId: api.contract.id, caseId: api.cases[0]!.id }] });
    const pub = await setWorkflowStatus(deps, project, wf, "published");
    expect(pub.workflow.status).toBe("published");
    await saveWorkflow(deps, project, { ...pub.workflow, nodes: [{ id: "n1", kind: "request", apiId: "ghost-api", caseId: "ghost-case" }] });
    // 已发布工作流启用校验失败返回正式 DTO，不保存候选，也不改变 revision/活动状态。
    const before = await getWorkflow(deps, project, wf);
    const revisionBefore = session.revision;
    const failed = await setWorkflowStatus(deps, project, wf, "enabled");
    expect(failed.workflow).toEqual(before.workflow);
    expect(failed.workflow.status).toBe("published");
    expect(failed.errors.length).toBeGreaterThan(0);
    expect(failed.warnings).toEqual(expect.any(Array));
    expect(session.revision).toBe(revisionBefore);
    expect(await getWorkflow(deps, project, wf)).toEqual(before);
    // 非法迁移（draft→enabled 跳级）由 core 守卫直接抛错（UI 按钮禁用本不应触发）；
    // 流须含合法节点（启用校验可通过）才会到达迁移守卫——空流在启用校验即被拒（§5 第 5 条）
    const wf2 = await createWorkflow(deps, project, "跳级流");
    await saveWorkflow(deps, project, { ...wf2, nodes: [{ id: "n1", kind: "request", apiId: api.contract.id, caseId: api.cases[0]!.id }] });
    await expect(setWorkflowStatus(deps, project, wf2, "enabled")).rejects.toThrow(/非法状态迁移/);
    // 空流也是已发布→启用的校验失败：返回可诊断 DTO，不改变生命周期状态。
    const wf3 = await createWorkflow(deps, project, "空流");
    await setWorkflowStatus(deps, project, wf3, "published");
    const emptyFailure = await setWorkflowStatus(deps, project, wf3, "enabled");
    expect(emptyFailure.workflow.status).toBe("published");
    expect(emptyFailure.errors).toContain("工作流没有任何节点，无法启用");
    expect((await getWorkflow(deps, project, wf3)).workflow.status).toBe("published");
    // 解除启用（enabled→published）合法；此处以 published 工作流验证 enabled 迁移守卫文案后补
    expect(await getWorkflow(deps, project, wf2)).toMatchObject({ workflow: { status: "draft" } });
  });

  it("wf:impact 反查引用；wf:delete 删除后列表为空", async () => {
    const { deps, project, api, apiLocator } = await setupWf();
    const wf = await createWorkflow(deps, project, "引用流");
    await saveWorkflow(deps, project, { ...wf, nodes: [{ id: "n1", kind: "request", apiId: api.contract.id, caseId: api.cases[0]!.id, label: "下单" }] });
    // 按用例反查：命中工作流/节点信息
    const hits = await deps.handle("wf:impact", {}, { ...apiLocator, caseId: api.cases[0]!.id });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ workflowId: wf.id, workflowName: "引用流", status: "draft", nodeId: "n1", nodeLabel: "下单" });
    // 按接口反查同样命中
    expect(await deps.handle("wf:impact", {}, apiLocator)).toHaveLength(1);
    // 删除后列表为空，反查不再命中
    await deleteWorkflow(deps, project, wf);
    expect(await listWorkflows(deps, project)).toEqual([]);
    expect(await deps.handle("wf:impact", {}, { ...apiLocator, caseId: api.cases[0]!.id })).toEqual([]);
  });

  it("同名创建并存（轨二同名放开）；未知 workflowId 抛「未找到工作流」", async () => {
    const { deps, project } = await setupWf();
    const first = await createWorkflow(deps, project, "条件流");
    const second = await createWorkflow(deps, project, "条件流");
    expect(second.id).not.toBe(first.id);
    const missing = { ...project.locator, workflowId: "00000000-0000-4000-8000-000000009999" };
    await expect(deps.handle("wf:get", {}, missing)).rejects.toThrow(/Workflow not found/);
    await expect(deps.handle("wf:delete", {}, missing)).rejects.toThrow(/Workflow not found/);
    await expect(deps.handle("wf:save", {}, missing, { id: missing.workflowId, name: "x", status: "draft", nodes: [], edges: [] })).rejects.toThrow(/Workflow not found/);
    await expect(deps.handle("wf:set-status", {}, missing, "published")).rejects.toThrow(/Workflow not found/);
  });

  it("wf:rename 改名后 wf:list 反映新名、树摘要同步（落盘读回）；同名放开", async () => {
    const { deps, dir, project } = await setupWf();
    const wf = await createWorkflow(deps, project, "old-name-flow");
    await renameWorkflow(deps, project, wf, "new-name-flow");
    // wf:list 反映新名
    expect((await listWorkflows(deps, project)).map((w: { name: string }) => w.name)).toEqual(["new-name-flow"]);
    // 树 DTO project 节点 workflows 摘要同步（侧树入口数据源）
    const tree = await deps.handle("tree:get", {});
    const gNodeWf = tree.children!.find((x) => x.kind === "group" && x.label === "g");
    if (!gNodeWf || gNodeWf.kind !== "group") throw new Error("Group missing from tree");
    const projectNode = gNodeWf.children[0];
    if (!projectNode || projectNode.kind !== "project") throw new Error("Project missing from tree");
    expect(projectNode.workflows).toMatchObject([{ id: wf.id, name: "new-name-flow", status: "draft" }]);
    // 落盘读回：改名已持久化（id 布局后目录=工作流 id，改名只改 yaml 名称）
    const fresh = createIpcDeps({ session: createSession(), pickDirectory: async () => dir, saveFile: async () => "" });
    await fresh.handle("ws:open", {}, dir);
    const reread = await fresh.handle("wf:get", {}, workflowLocator(project, wf));
    expect(reread.workflow.name).toBe("new-name-flow");
    // 同名放开（轨二）：改名到已存在名称直接成功；未知 id 抛「未找到工作流」+ zod 入参校验
    await createWorkflow(deps, project, "placeholder-flow");
    await renameWorkflow(deps, project, wf, "placeholder-flow");
    expect((await getWorkflow(deps, project, wf)).workflow.name).toBe("placeholder-flow");
    const missing = { ...project.locator, workflowId: "00000000-0000-4000-8000-000000009999" };
    await expect(deps.handle("wf:rename", {}, missing, "x")).rejects.toThrow(/Workflow not found/);
    await expect(invalidIpc(deps, "wf:rename", { ...missing, workflowId: 42 }, "x")).rejects.toThrow(/\[wf:rename\] 入参校验失败/);
  });

  it("wf:run：draft 拒绝运行；envName 未找到抛错；成功运行落盘 .apicc/runs/workflow-*.json", async () => {
    const { deps, dir, project, api } = await setupWf();
    const wf = await createWorkflow(deps, project, "运行流");
    await saveWorkflow(deps, project, { ...wf, nodes: [{ id: "n1", kind: "request", apiId: api.contract.id, caseId: api.cases[0]!.id }] });
    // draft 直接拒绝（UI 对 draft 禁用运行按钮，本错误为护栏）
    await expect(runWorkflow(deps, project, wf)).rejects.toThrow(/工作流为草稿，请先发布启用/);
    await setWorkflowStatus(deps, project, wf, "published");
    await setWorkflowStatus(deps, project, wf, "enabled");
    // 环境按名解析：未命中显式抛错（不静默降级为无环境运行）
    await expect(runWorkflow(deps, project, wf, { envName: "nope" })).rejects.toThrow(/未找到环境: nope/);
    // 成功运行（不可达地址 → 节点 failed，但运行链路完整），结果落盘 workflow-<id>-<uuid>.json
    const result = await runWorkflow(deps, project, wf);
    expect(result.workflowId).toBe(wf.id);
    expect(result.total).toBe(1);
    expect(result.nodeResults).toHaveLength(1);
    await runWorkflow(deps, project, wf);
    const files = readdirSync(join(dir, ".apicc", "runs"));
    const rawFiles = files.filter((f) => f.startsWith(`workflow-${wf.id}-`) && f.endsWith(".json"));
    expect(rawFiles).toHaveLength(2);
    expect(rawFiles[0]).not.toBe(rawFiles[1]);
  });

  it("wf:run 接受 strict=false 并保留缺引用失败结论", async () => {
    const { deps, project, api } = await setupWf();
    const wf = await createWorkflow(deps, project, "严格诊断流");
    await saveWorkflow(deps, project, {
      ...wf,
      nodes: [
        { id: "missing", kind: "request", apiId: "ghost-api", caseId: "ghost-case" },
        { id: "independent", kind: "request", apiId: api.contract.id, caseId: api.cases[0]!.id },
      ],
    });
    await setWorkflowStatus(deps, project, wf, "published");
    const result = await runWorkflow(deps, project, wf, { strict: false });
    expect(result.nodeResults.find((node: { nodeId: string }) => node.nodeId === "missing")?.state).toBe("failed");
    expect(result.nodeResults.find((node: { nodeId: string }) => node.nodeId === "independent")?.state).toBe("failed");
    expect(result.nodeResults.find((node: { nodeId: string; failureKind?: string }) => node.nodeId === "independent")?.failureKind).toBe("transport");
    expect(result.verdict).toBe("failed");
  });

  it("wf:run 同毫秒两次落盘仍各有 UUID 文件且内容归属可读", async () => {
    const { deps, dir, project } = await setupWf();
    const wf = await createWorkflow(deps, project, "同毫秒甲");
    await saveWorkflow(deps, project, { ...wf, nodes: [{ id: "noop", kind: "noop" }] });
    await setWorkflowStatus(deps, project, wf, "published");
    await setWorkflowStatus(deps, project, wf, "enabled");
    vi.useFakeTimers();
    vi.setSystemTime(1_791_000_000_000);
    try {
      await runWorkflow(deps, project, wf);
      await renameWorkflow(deps, project, wf, "同毫秒乙");
      await runWorkflow(deps, project, wf);
    } finally {
      vi.useRealTimers();
    }
    const files = readdirSync(join(dir, ".apicc", "runs"))
      .filter((f) => f.startsWith(`workflow-${wf.id}-`) && f.endsWith(".json"));
    expect(files).toHaveLength(2);
    const runIds = files.map((f) => f.slice(`workflow-${wf.id}-`.length, -".json".length));
    expect(new Set(runIds).size).toBe(2);
    const reports = files.map((f) => JSON.parse(readFileSync(join(dir, ".apicc", "runs", f), "utf8")) as { workflowId: string; workflowName: string; startedAt: string; nodeResults: Array<{ nodeId: string }> });
    expect(reports).toHaveLength(2);
    expect(reports.every((report) => report.workflowId === wf.id)).toBe(true);
    expect(reports.every((report) => report.nodeResults.some((node) => node.nodeId === "noop"))).toBe(true);
    expect(reports.map((report) => report.workflowName).sort()).toEqual(["同毫秒乙", "同毫秒甲"].sort());
    expect(reports[0]!.startedAt).toBe(reports[1]!.startedAt);
  });

  it("wf:run 数据驱动 JSON 保留完整零基行且实际 handler verdict 失败", async () => {
    const { deps, dir, project, api, apiLocator } = await setupWf();
    const rowsDirectory = mkdtempSync(join(tmpdir(), "apicc-workflow-rows-"));
    const rowsPath = join(rowsDirectory, "workflow-rows.json");
    writeFileSync(rowsPath, JSON.stringify([{ expected: "200" }, { expected: "500" }]));
    const server = createServer((_req, res) => { res.statusCode = 200; res.end("{}"); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const testCase = api.cases[0]!;
      (api.contract.request as { baseUrl: string; path: string }).baseUrl = baseUrl;
      (api.contract.request as { baseUrl: string; path: string }).path = "/rows";
      api.cases[0] = { ...testCase, dataDriver: { sourcePath: rowsPath, format: "json" }, assertions: [{ id: "status", target: "status", op: "eq", expected: "{{expected}}" }] };
      await deps.handle("api:save", {}, apiLocator, api);
      const wf = await createWorkflow(deps, project, "IPC 数据行流");
      await saveWorkflow(deps, project, { ...wf, nodes: [{ id: "data-row", kind: "request", apiId: api.contract.id, caseId: testCase.id }] });
      await setWorkflowStatus(deps, project, wf, "published");
      await setWorkflowStatus(deps, project, wf, "enabled");
      const result = await runWorkflow(deps, project, wf);
      expect(result.verdict).toBe("failed");
      expect(result.nodeResults[0]?.outcomes?.map((outcome: { row?: number; passed: boolean }) => ({ row: outcome.row, passed: outcome.passed }))).toEqual([
        { row: 0, passed: true }, { row: 1, passed: false },
      ]);
      expect(result.nodeResults[0]?.state).toBe("failed");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(rowsDirectory, { recursive: true, force: true });
    }
  });

  it("wf:run 所属项目递归定位同 ID 两层 folder API，使用模块 baseUrl 而非错项目", async () => {
    let receivedPath = "";
    const server = createServer((req, res) => { receivedPath = req.url ?? ""; res.statusCode = 200; res.end("{}"); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const dir = mkdtempSync(join(tmpdir(), "apicc-ipc-project-scope-"));
    try {
      const workspace = makeWorkspace();
      const project1 = projectOne(workspace);
      const project2 = projectTwo(workspace);
      const apiOne = project1.collections[0]!.apis.find((asset) => asset.contract.id === IDS.sharedApi)!;
      (apiOne.contract.request as { baseUrl: string; path: string }).baseUrl = "http://127.0.0.1:1";
      (apiOne.contract.request as { baseUrl: string; path: string }).path = "/wrong-project";
      const collection = project2.collections[0]!;
      const duplicate = collection.apis.find((asset) => asset.contract.id === IDS.sharedApi)!;
      (duplicate.contract.request as { baseUrl: string; path: string }).baseUrl = "{{baseUrl}}";
      (duplicate.contract.request as { baseUrl: string; path: string }).path = "/ipc-project-two";
      collection.variables.baseUrl = `${baseUrl}/module-base`;
      collection.apis = [];
      collection.folders = [{
        id: "00000000-0000-4000-8000-000000000040", name: "outer", preOperations: [], postOperations: [], apis: [], folders: [{
          id: "00000000-0000-4000-8000-000000000041", name: "inner", preOperations: [], postOperations: [], apis: [duplicate], folders: [],
        }],
      }];
      await persistWorkspace(dir, workspace);
      const session = createSession();
      await session.open(dir);
      const deps = createIpcDeps({ session, pickDirectory: async () => dir, saveFile: async () => "" });
      const tree = await deps.handle("tree:get", {});
      const groupNode = tree.children?.find((node) => node.kind === "group" && node.id === IDS.groupTwo);
      const projectDto = groupNode?.kind === "group"
        ? groupNode.children.find((node) => node.kind === "project" && node.id === project2.id)
        : undefined;
      if (!projectDto || projectDto.kind !== "project") throw new Error("Second project missing from IPC tree");
      const wf = await createWorkflow(deps, projectDto, "IPC 项目作用域流");
      await saveWorkflow(deps, projectDto, { ...wf, nodes: [{ id: "nested", kind: "request", apiId: duplicate.contract.id, caseId: duplicate.cases[0]!.id }] });
      await setWorkflowStatus(deps, projectDto, wf, "published");
      await setWorkflowStatus(deps, projectDto, wf, "enabled");
      const result = await runWorkflow(deps, projectDto, wf);
      expect(result.verdict).toBe("passed");
      expect(result.nodeResults[0]?.outcomes?.[0]?.passed).toBe(true);
      expect(receivedPath).toBe("/module-base/ipc-project-two");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("wf:run 默认 strict、条件剪枝与坏条件都保留 verdict/诊断", async () => {
    const { deps, project, api } = await setupWf();
    const missing = await createWorkflow(deps, project, "默认严格流");
    await saveWorkflow(deps, project, { ...missing, nodes: [
      { id: "missing", kind: "request", apiId: "ghost-api", caseId: "ghost-case" },
      { id: "independent", kind: "request", apiId: api.contract.id, caseId: api.cases[0]!.id },
    ] });
    await setWorkflowStatus(deps, project, missing, "published");
    const strict = await runWorkflow(deps, project, missing);
    expect(strict.verdict).toBe("failed");
    expect(strict.nodeResults.find((node: { nodeId: string }) => node.nodeId === "missing")?.state).toBe("failed");
    expect(strict.nodeResults.find((node: { nodeId: string }) => node.nodeId === "independent")?.state).toBe("skipped");

    const branch = await createWorkflow(deps, project, "剪枝流");
    await saveWorkflow(deps, project, { ...branch, nodes: [
      { id: "source", kind: "noop" }, { id: "pruned", kind: "noop" },
    ], edges: [{ id: "false", from: "source", to: "pruned", condition: "false" }] });
    await setWorkflowStatus(deps, project, branch, "published");
    const branched = await runWorkflow(deps, project, branch);
    expect(branched.verdict).toBe("passed");
    expect(branched.nodeResults.find((node: { nodeId: string }) => node.nodeId === "pruned")?.skipReason).toBe("condition-pruned");

    const bad = await createWorkflow(deps, project, "坏条件流");
    await saveWorkflow(deps, project, { ...bad, nodes: [
      { id: "source", kind: "noop" }, { id: "target", kind: "noop" },
    ], edges: [{ id: "bad", from: "source", to: "target", condition: "missingConditionValue" }] });
    await setWorkflowStatus(deps, project, bad, "published");
    const badResult = await runWorkflow(deps, project, bad);
    expect(badResult.verdict).toBe("failed");
    expect(badResult.nodeResults.find((node: { nodeId: string }) => node.nodeId === "source")).toMatchObject({ state: "failed", failureKind: "script" });
    expect(badResult.nodeResults.find((node: { nodeId: string }) => node.nodeId === "target")?.state).toBe("skipped");
  });

  it("wf 频道入参形状非法时抛带频道名的可读错误（zod 校验入表）", async () => {
    const { deps, project } = await setupWf();
    await expect(invalidIpc(deps, "wf:create", { locator: { ...project.locator, projectId: 42 }, name: "x" })).rejects.toThrow(/\[wf:create\] 入参校验失败/);
    await expect(invalidIpc(deps, "wf:list", {})).rejects.toThrow(/\[wf:list\] 入参校验失败/);
    await expect(invalidIpc(deps, "wf:get", "not-an-object")).rejects.toThrow(/\[wf:get\] 入参校验失败/);
    // wf:save 走 WorkflowSchema 全量校验：未知字段/缺字段均拒绝（strict schema）
    const workflowLocator = { ...project.locator, workflowId: IDS.workflow };
    await expect(invalidIpc(deps, "wf:save", workflowLocator, { id: "w", name: "x", bogus: true })).rejects.toThrow(/\[wf:save\] 入参校验失败/);
    await expect(invalidIpc(deps, "wf:set-status", workflowLocator, "bogus")).rejects.toThrow(/\[wf:set-status\] 入参校验失败/);
    await expect(invalidIpc(deps, "wf:impact", { ...project.locator, caseId: 42 })).rejects.toThrow(/\[wf:impact\] 入参校验失败/);
    await expect(invalidIpc(deps, "wf:run", { locator: workflowLocator })).rejects.toThrow(/未找到工作流/);
  });
});

describe("压测 IPC", () => {
  // —— 压测频道（M2-D3 任务 1）：stress:run 主进程执行并落盘，runs:list/get 按 kind 判别 ——
  it("stress:run 执行压测并落盘 stress-*.json；runs:list/get 按 kind 判别；无活动 stop 抛「没有进行中的压测」", async () => {
    const { deps, dir, session } = setup();
    await deps.handle("ws:create", {}, dir, "w");
    const g = await createGroup(deps, session, "g");
    const p = await createProject(deps, g, "p");
    const c = await createCollection(deps, p, "c");
    const api = await createApi(deps, c, { name: "a", method: "GET", baseUrl: "http://127.0.0.1:1", path: "/" });
    const detail = await deps.handle("api:get", {}, api.locator);
    // envName=null 兼容既有 nullish 口径：通过校验按无环境运行（不可达地址 → failed 采样，运行完成）
    const out = await deps.handle("stress:run", {}, { locator: api.locator, caseId: detail.api.cases[0]!.id, envName: null, concurrency: 1, maxIterations: 1, confirmedTargetOrigins: ["http://127.0.0.1:1"] });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error("expected stress report");
    if (!out.file) throw new Error("expected stress report file");
    expect(out.report.totalRequests).toBe(1);
    expect(out.file).toMatch(new RegExp(`^stress-${api.id}-\\d+\\.json$`));
    const list = await deps.handle("runs:list", {});
    expect(list).toHaveLength(1);
    expect(list[0].kind).toBe("stress");
    const summary = list[0];
    if (!summary || summary.kind !== "stress") throw new Error("Expected stress run summary");
    expect(summary.totalRequests).toBe(1);
    const stressDetail = await deps.handle("runs:get", {}, out.file);
    if (!stressDetail || !("kind" in stressDetail) || stressDetail.kind !== "stress") throw new Error("Expected stress run detail");
    expect(stressDetail.report.totalRequests).toBe(1);
    // 运行已结束：无活动运行时 stress:stop 抛「没有进行中的压测」
    await expect(deps.handle("stress:stop", {})).rejects.toThrow(/没有进行中的压测/);
  });

  it("stress:run 安全拒绝通过 IPC 结构化克隆仍保留 code/targetOrigin，并可用精确 origin 重试", async () => {
    const { deps, dir, session } = setup();
    await deps.handle("ws:create", {}, dir, "w");
    const g = await createGroup(deps, session, "g");
    const p = await createProject(deps, g, "p");
    const c = await createCollection(deps, p, "c");
    const api = await createApi(deps, c, { name: "a", method: "GET", baseUrl: "http://127.0.0.1:1", path: "/" });
    const detail = await deps.handle("api:get", {}, api.locator);
    const input = { locator: api.locator, caseId: detail.api.cases[0]!.id, concurrency: 1, maxIterations: 1 };

    const denied = await deps.handle("stress:run", {}, input);
    const cloned = structuredClone(denied);
    expect(cloned).toEqual({ ok: false, error: { code: "target_confirmation_required", message: expect.any(String), targetOrigin: "http://127.0.0.1:1" } });
    expect(cloned.ok).toBe(false);
    if (cloned.ok) throw new Error("expected structured safety refusal");
    expect(cloned.error.code).toBe("target_confirmation_required");
    expect(cloned.error.targetOrigin).toBe("http://127.0.0.1:1");

    const retried = await deps.handle("stress:run", {}, { ...input, confirmedTargetOrigins: [cloned.error.targetOrigin] });
    expect(retried.ok).toBe(true);
    if (!retried.ok) throw new Error("expected confirmed stress report");
    expect(retried.report.totalRequests).toBe(1);
  });

  it("ipcMain.handle → ipcRenderer.invoke → preload 暴露 API 边界校验安全 DTO，非法输出拒绝且未知异常继续 reject", async () => {
    const { deps, dir, session } = setup();
    await deps.handle("ws:create", {}, dir, "w");
    const g = await createGroup(deps, session, "g");
    const p = await createProject(deps, g, "p");
    const c = await createCollection(deps, p, "c");
    const api = await createApi(deps, c, { name: "a", method: "GET", baseUrl: "http://127.0.0.1:1", path: "/" });
    const detail = await deps.handle("api:get", {}, api.locator);
    const input = { locator: api.locator, caseId: detail.api.cases[0]!.id, concurrency: 1, maxIterations: 1 };
    const exposed = createStressPreloadApi({
      invoke: async (channel, ...args) => structuredClone(await deps.handle(channel, {}, ...args)),
    });
    const refused = await exposed.stressRun(input);
    expect(refused).toMatchObject({ ok: false, error: { code: "target_confirmation_required", targetOrigin: "http://127.0.0.1:1" } });

    const invalidOutput = createStressPreloadApi({ invoke: async () => ({ ok: false, error: { code: "target_denied", message: "denied", targetOrigin: "http://127.0.0.1:1", extra: true } }) });
    await expect(invalidOutput.stressRun(input)).rejects.toThrow(/extra|Unrecognized key/);
    const unknownFailure = new Error("unknown main failure");
    const rejectingInvoke = createStressPreloadApi({ invoke: async () => { throw unknownFailure; } });
    await expect(rejectingInvoke.stressRun(input)).rejects.toBe(unknownFailure);
  });

  it("stress:run 入参校验：负并发/零并发/非整数并发 zod 拒绝；迭代与时长都缺走 core 文案（可空字段 null 兼容）", async () => {
    const { deps, dir, session } = setup();
    await deps.handle("ws:create", {}, dir, "w");
    const g = await createGroup(deps, session, "g");
    const p = await createProject(deps, g, "p");
    const c = await createCollection(deps, p, "c");
    const api = await createApi(deps, c, { name: "a", method: "GET", baseUrl: "http://127.0.0.1:1", path: "/" });
    await expect(deps.handle("stress:run", {}, { locator: api.locator, caseId: "x", concurrency: -1, maxIterations: 1 })).rejects.toThrow(/\[stress:run\] 入参校验失败/);
    await expect(deps.handle("stress:run", {}, { locator: api.locator, caseId: "x", concurrency: 0, maxIterations: 1 })).rejects.toThrow(/\[stress:run\] 入参校验失败/);
    await expect(deps.handle("stress:run", {}, { locator: api.locator, caseId: "x", concurrency: 1.5, maxIterations: 1 })).rejects.toThrow(/\[stress:run\] 入参校验失败/);
    await expect(deps.handle("stress:run", {}, { locator: api.locator, caseId: "x", concurrency: 1, maxIterations: 1.5 })).rejects.toThrow(/\[stress:run\] 入参校验失败/);
    await expect(deps.handle("stress:run", {}, { locator: api.locator, caseId: "x", concurrency: 1, maxIterations: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow(/\[stress:run\] 入参校验失败/);
    await expect(deps.handle("stress:run", {}, { locator: api.locator, caseId: "x", concurrency: 1, durationMs: Number.NaN })).rejects.toThrow(/\[stress:run\] 入参校验失败/);
    await expect(deps.handle("stress:run", {}, { locator: api.locator, caseId: "x", concurrency: 1, durationMs: Number.POSITIVE_INFINITY })).rejects.toThrow(/\[stress:run\] 入参校验失败/);
    // maxIterations/durationMs 传 null（antd InputNumber 清空口径）：通过 zod，运行层报 core 终止条件文案
    const detail = await deps.handle("api:get", {}, api.locator);
    await expect(deps.handle("stress:run", {}, { locator: api.locator, caseId: detail.api.cases[0]!.id, concurrency: 1, maxIterations: null, durationMs: null })).rejects.toThrow(/压测终止条件缺失/);
  });
});

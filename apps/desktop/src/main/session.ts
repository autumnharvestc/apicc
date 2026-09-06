import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  fileStorage,
  sanitizeNodeName,
  transitionWorkflowStatus,
  validateEnablement,
  type ApiDefinition,
  type Collection,
  type Environment,
  type Group,
  type Project,
  type Workflow,
  type WorkflowStatus,
  type Workspace,
  type LoadProblem,
  HttpMethod,
} from "@apicc/core";
import { randomUUID } from "node:crypto";

export interface ApiLocation { api: ApiDefinition; collection: Collection; project: Project; group: Group; folder: { id: string; name: string; apis: ApiDefinition[] } | null }

/** 集合定位结果：集合运行（run:collection）需集合本体 + 所属项目（环境解析）与分组。 */
export interface CollectionLocation { collection: Collection; project: Project; group: Group }

/** 工作流定位结果：wf:get/wf:set-status/wf:run 需工作流本体 + 所属项目（环境/级联数据）与分组。 */
export interface WorkflowLocation { workflow: Workflow; project: Project; group: Group }

export type NodeKind = "group" | "project" | "collection" | "folder" | "api" | "environment";

/**
 * 名称比较（C1 修复）：win32 文件系统大小写不敏感——save 按 name 写盘时 NTFS 会把
 * `workflows\Flow` 解析到既有 `flow` 目录（盘上名保持旧大小写），cleanup/重名检查若按
 * === 严格比较，会把刚写入的目录误判为孤儿递归删除（数据破坏）。win32 下两侧
 * toLowerCase 归一比较；其余平台保持严格相等（POSIX 大小写敏感，`Flow`/`flow` 是两个
 * 不同目录）。platform 参数供测试注入（默认取当前进程平台）。
 */
export function sameName(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** 会话选项：platform 仅注入目录名/重名比较的大小写语义（测试模拟 win32 判定路径）。 */
export interface SessionOptions { platform?: NodeJS.Platform }

/** 主进程工作区会话：内存模型为唯一事实源，save() 全量落盘（规格 §4）。 */
export function createSession(options: SessionOptions = {}) {
  const platform = options.platform ?? process.platform;
  let root: string | null = null;
  let workspace: Workspace | null = null;

  function ensureOpen(): { root: string; workspace: Workspace } {
    if (!root || !workspace) throw new Error("尚未打开工作区");
    return { root, workspace: workspace! };
  }

  function createGroup(rawName: string): Group {
    const { workspace: ws } = ensureOpen();
    const name = sanitizeNodeName(rawName);
    // 同级重名拒绝（M9-A2）：名称即盘上目录名，重名双写同目录互相覆盖（与工作流 sameName 同口径）。
    if (ws.groups.some((x) => sameName(x.name, name, platform))) throw new Error(`分组已存在: ${name}`);
    const group: Group = { id: randomUUID(), name, projects: [] };
    ws.groups.push(group);
    return group;
  }

  function createProject(groupId: string, rawName: string): Project {
    const { workspace: ws } = ensureOpen();
    const name = sanitizeNodeName(rawName);
    const group = ws.groups.find((x) => x.id === groupId);
    if (!group) throw new Error(`未找到分组: ${groupId}`);
    if (group.projects.some((x) => sameName(x.name, name, platform))) throw new Error(`项目已存在: ${name}`);
    const project: Project = { id: randomUUID(), name, variables: {}, environments: [], collections: [], workflows: [] };
    group.projects.push(project);
    return project;
  }

  function createCollection(projectId: string, rawName: string): Collection {
    const { workspace: ws } = ensureOpen();
    const name = sanitizeNodeName(rawName);
    const project = ws.groups.flatMap((g) => g.projects).find((x) => x.id === projectId);
    if (!project) throw new Error(`未找到项目: ${projectId}`);
    if (project.collections.some((x) => sameName(x.name, name, platform))) throw new Error(`集合已存在: ${name}`);
    const collection: Collection = { id: randomUUID(), name, variables: {}, folders: [], apis: [] };
    project.collections.push(collection);
    return collection;
  }

  function createFolder(collectionId: string, rawName: string): { id: string; name: string; apis: ApiDefinition[] } {
    const { workspace: ws } = ensureOpen();
    const name = sanitizeNodeName(rawName);
    const collection = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.collections).find((x) => x.id === collectionId);
    if (!collection) throw new Error(`未找到集合: ${collectionId}`);
    if (collection.folders.some((x) => sameName(x.name, name, platform))) throw new Error(`文件夹已存在: ${name}`);
    const folder = { id: randomUUID(), name, apis: [] };
    collection.folders.push(folder);
    return folder;
  }

  function createApi(collectionId: string, folderId: string | null, input: { name: string; method: HttpMethod; url: string }): ApiDefinition {
    const { workspace: ws } = ensureOpen();
    const name = sanitizeNodeName(input.name);
    const collection = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.collections).find((x) => x.id === collectionId);
    if (!collection) throw new Error(`未找到集合: ${collectionId}`);
    const makeApi = (): ApiDefinition => ({
      id: randomUUID(), name, version: "1.0.0", deprecated: false,
      method: input.method, url: input.url, headers: [], query: [],
      cases: [{ id: randomUUID(), name: "冒烟", scope: "base", parameters: {}, assertions: [] }],
    });
    if (folderId) {
      const folder = collection.folders.find((f) => f.id === folderId);
      if (!folder) throw new Error(`未找到文件夹: ${folderId}`);
      if (folder.apis.some((x) => sameName(x.name, name, platform))) throw new Error(`接口已存在: ${name}`);
      const api = makeApi();
      folder.apis.push(api);
      return api;
    }
    if (collection.apis.some((x) => sameName(x.name, name, platform))) throw new Error(`接口已存在: ${name}`);
    const api = makeApi();
    collection.apis.push(api);
    return api;
  }

  function locateApi(apiId: string): ApiLocation | undefined {
    const { workspace: ws } = ensureOpen();
    for (const group of ws.groups) {
      for (const project of group.projects) {
        for (const collection of project.collections) {
          const api = collection.apis.find((a) => a.id === apiId);
          if (api) return { api, collection, project, group, folder: null };
          for (const folder of collection.folders) {
            const fApi = folder.apis.find((a) => a.id === apiId);
            if (fApi) return { api: fApi, collection, project, group, folder };
          }
        }
      }
    }
    return undefined;
  }

  /** 集合定位（同 locateApi 遍历模式）：集合运行入口按 id 取集合 + 所属项目/分组。 */
  function locateCollection(collectionId: string): CollectionLocation | undefined {
    const { workspace: ws } = ensureOpen();
    for (const group of ws.groups) {
      for (const project of group.projects) {
        for (const collection of project.collections) {
          if (collection.id === collectionId) return { collection, project, group };
        }
      }
    }
    return undefined;
  }

  async function saveApi(api: ApiDefinition): Promise<void> {
    const loc = locateApi(api.id);
    if (!loc) throw new Error(`未找到接口: ${api.id}`);
    const list = loc.folder ? loc.folder.apis : loc.collection.apis;
    const index = list.findIndex((a) => a.id === api.id);
    list[index] = api;
    await save();
  }

  // 工作流操作（M2-B 任务 1）：模式对齐 locateCollection/createCollection——只改内存模型
  // 不自动落盘，落盘时机由 IPC 处理器显式 save()（saveWorkflow/setWorkflowStatus 语义见各自注释）。
  function locateWorkflow(workflowId: string): WorkflowLocation | undefined {
    const { workspace: ws } = ensureOpen();
    for (const group of ws.groups) {
      for (const project of group.projects) {
        const workflow = project.workflows.find((w) => w.id === workflowId);
        if (workflow) return { workflow, project, group };
      }
    }
    return undefined;
  }

  function createWorkflow(projectId: string, name: string): Workflow {
    const { workspace: ws } = ensureOpen();
    const project = ws.groups.flatMap((g) => g.projects).find((x) => x.id === projectId);
    if (!project) throw new Error(`未找到项目: ${projectId}`);
    // 重名检查走 sameName（C1）：win32 上 flow/FLOW 是同一盘上目录，严格比较会放行
    // 大小写变体重名 → save 双写同目录互相覆盖。
    if (project.workflows.some((w) => sameName(w.name, name, platform))) throw new Error(`工作流已存在: ${name}`);
    const workflow: Workflow = { id: randomUUID(), name, status: "draft", nodes: [], edges: [] };
    project.workflows.push(workflow);
    return workflow;
  }

  function deleteWorkflow(workflowId: string): void {
    const { workspace: ws } = ensureOpen();
    for (const group of ws.groups) {
      for (const project of group.projects) {
        const index = project.workflows.findIndex((w) => w.id === workflowId);
        if (index >= 0) {
          project.workflows.splice(index, 1);
          return;
        }
      }
    }
    throw new Error(`未找到工作流: ${workflowId}`);
  }

  /**
   * 重命名工作流（M2-B 收口：侧树重命名入口）：按 id 定位 → 改名 → save() 落盘。
   * 旧目录由 save 后的 cleanupOrphanDirs workflows 层清理（先写新、后删旧，与集合
   * renameNode 同一盘上语义）；同项目重名拒绝（与 createWorkflow 同文案）。status 恒不变。
   */
  async function renameWorkflow(workflowId: string, name: string): Promise<void> {
    const loc = locateWorkflow(workflowId);
    if (!loc) throw new Error(`未找到工作流: ${workflowId}`);
    // 重名检查走 sameName（C1）：win32 归一比较（自身大小写改名经 id 排除放行）。
    if (loc.project.workflows.some((w) => w.id !== workflowId && sameName(w.name, name, platform))) {
      throw new Error(`工作流已存在: ${name}`);
    }
    loc.workflow.name = name;
    await save();
  }

  /**
   * 保存工作流：按 id 定位替换 + save() 落盘。恒保持当前 status 不变（裁定：生命周期
   * 只经 setWorkflowStatus；编辑已发布/已启用工作流的回退由 UI 显式询问，save 不掺和）。
   * 返回落盘后的工作流（含保留的 status），wf:save 频道原样回传给渲染层。
   */
  async function saveWorkflow(workflow: Workflow): Promise<Workflow> {
    const loc = locateWorkflow(workflow.id);
    if (!loc) throw new Error(`未找到工作流: ${workflow.id}`);
    const stored: Workflow = { ...workflow, status: loc.workflow.status };
    const index = loc.project.workflows.findIndex((w) => w.id === workflow.id);
    loc.project.workflows[index] = stored;
    await save();
    return stored;
  }

  /**
   * 生命周期迁移：draft→published / published→enabled 单向（enabled→published = 解除启用）。
   * enabled 迁移先过 core validateEnablement——未过时返回 { workflow(状态不变), errors, warnings }
   * （UI 展示错误列表）；非法迁移（如 draft→enabled 跳级）由 core transitionWorkflowStatus
   * 直接抛错（UI 按钮禁用本不应触发）。成功时原地更新状态并返回（含校验 warnings 透传）。
   */
  function setWorkflowStatus(workflowId: string, next: WorkflowStatus): { workflow: Workflow; errors: string[]; warnings: string[] } {
    const loc = locateWorkflow(workflowId);
    if (!loc) throw new Error(`未找到工作流: ${workflowId}`);
    const { workspace: ws } = ensureOpen();
    const enablement = next === "enabled" ? validateEnablement(loc.workflow, ws) : undefined;
    if (enablement && !enablement.ok) {
      return { workflow: loc.workflow, errors: enablement.errors, warnings: enablement.warnings };
    }
    transitionWorkflowStatus(loc.workflow, next, enablement);
    loc.workflow.status = next;
    return { workflow: loc.workflow, errors: [], warnings: enablement?.warnings ?? [] };
  }

  // 环境操作（任务 4）：与 create/createProject 同契约——只改内存模型不落盘，
  // 落盘时机由 IPC 处理器显式 save()（语义备忘：session 变更操作不自动落盘）。
  function createEnvironment(projectId: string, input: { name: string; extends?: string }): Environment {
    const { workspace: ws } = ensureOpen();
    const project = ws.groups.flatMap((g) => g.projects).find((x) => x.id === projectId);
    if (!project) throw new Error(`未找到项目: ${projectId}`);
    const env: Environment = { id: randomUUID(), name: sanitizeNodeName(input.name), extends: input.extends, variables: {}, baseUrls: {} };
    project.environments.push(env);
    return env;
  }

  /** 环境前置 URL（M9-B）：按集合整体替换该环境的 baseUrls 映射（collectionId → 前置 URL）。 */
  function setEnvironmentBaseUrls(envId: string, baseUrls: Record<string, string>): void {
    const { workspace: ws } = ensureOpen();
    const env = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.environments).find((x) => x.id === envId);
    if (!env) throw new Error(`未找到环境: ${envId}`);
    env.baseUrls = baseUrls;
  }

  /** 工作区全局设置（M9-B）：整体替换 globals（全局变量 + 全局 query/header 参数）。 */
  function setWorkspaceGlobals(globals: Workspace["globals"]): void {
    const { workspace: ws } = ensureOpen();
    ws.globals = globals;
  }

  function setEnvironmentVariables(envId: string, variables: Record<string, string>): void {
    const { workspace: ws } = ensureOpen();
    const env = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.environments).find((x) => x.id === envId);
    if (!env) throw new Error(`未找到环境: ${envId}`);
    env.variables = variables;
  }

  /** 导入项目（任务 7）：目标分组不存在则创建；同分组重名项目拒绝。导入器产物的 id 均为新生成 UUID，无 id 冲突风险。
   * M9-A2：分组名与导入树内全部实体名经 sanitizeNodeName 深度净化（内置导入器已净化；
   * 此处兜底插件导入器——其产物名称不受控，非法字符同样会打穿盘上目录布局）。 */
  async function importProject(groupName: string, imported: { project: Project }): Promise<void> {
    const { workspace: ws } = ensureOpen();
    const sanitizedGroup = sanitizeNodeName(groupName);
    let group = ws.groups.find((x) => x.name === sanitizedGroup);
    if (!group) { group = createGroup(sanitizedGroup); }
    const project = imported.project;
    project.name = sanitizeNodeName(project.name);
    const existing = group.projects.find((x) => sameName(x.name, project.name, platform));
    if (existing) throw new Error(`项目已存在: ${project.name}`);
    project.environments = (project.environments ?? []).map((e) => ({ ...e, name: sanitizeNodeName(e.name) }));
    project.collections = project.collections.map((c) => ({
      ...c,
      name: sanitizeNodeName(c.name),
      folders: c.folders.map((f) => ({
        ...f,
        name: sanitizeNodeName(f.name),
        apis: f.apis.map((a) => ({ ...a, name: sanitizeNodeName(a.name), cases: a.cases.map((tc) => ({ ...tc, name: sanitizeNodeName(tc.name) })) })),
      })),
      apis: c.apis.map((a) => ({ ...a, name: sanitizeNodeName(a.name), cases: a.cases.map((tc) => ({ ...tc, name: sanitizeNodeName(tc.name) })) })),
    }));
    project.workflows = (project.workflows ?? []).map((w) => ({ ...w, name: sanitizeNodeName(w.name) }));
    group.projects.push(project);
    await save();
  }

  function renameNode(kind: NodeKind, id: string, rawName: string): void {
    const { workspace: ws } = ensureOpen();
    const name = sanitizeNodeName(rawName);
    if (kind === "group") {
      const n = ws.groups.find((x) => x.id === id);
      if (!n) throw new Error(`未找到: ${id}`);
      if (ws.groups.some((x) => x.id !== id && sameName(x.name, name, platform))) throw new Error(`分组已存在: ${name}`);
      n.name = name;
      return;
    }
    if (kind === "project") {
      const n = ws.groups.flatMap((g) => g.projects).find((x) => x.id === id);
      if (!n) throw new Error(`未找到: ${id}`);
      const parent = ws.groups.find((g) => g.projects.some((x) => x.id === id));
      if (parent && parent.projects.some((x) => x.id !== id && sameName(x.name, name, platform))) throw new Error(`项目已存在: ${name}`);
      n.name = name;
      return;
    }
    if (kind === "collection") {
      const n = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.collections).find((x) => x.id === id);
      if (!n) throw new Error(`未找到: ${id}`);
      const parent = ws.groups.flatMap((g) => g.projects).find((p) => p.collections.some((x) => x.id === id));
      if (parent && parent.collections.some((x) => x.id !== id && sameName(x.name, name, platform))) throw new Error(`集合已存在: ${name}`);
      n.name = name;
      return;
    }
    if (kind === "folder") {
      const n = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.collections).flatMap((c) => c.folders).find((x) => x.id === id);
      if (!n) throw new Error(`未找到: ${id}`);
      const parent = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.collections).find((c) => c.folders.some((x) => x.id === id));
      if (parent && parent.folders.some((x) => x.id !== id && sameName(x.name, name, platform))) throw new Error(`文件夹已存在: ${name}`);
      n.name = name;
      return;
    }
    if (kind === "environment") {
      const n = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.environments).find((x) => x.id === id);
      if (!n) throw new Error(`未找到: ${id}`);
      n.name = name;
      return;
    }
    const loc = locateApi(id);
    if (!loc) throw new Error(`未找到: ${id}`);
    const siblings = loc.folder ? loc.folder.apis : loc.collection.apis;
    if (siblings.some((x) => x.id !== id && sameName(x.name, name, platform))) throw new Error(`接口已存在: ${name}`);
    loc.api.name = name;
  }

  function deleteNode(kind: NodeKind, id: string): void {
    const { workspace: ws } = ensureOpen();
    const removeFrom = <T>(list: T[], pred: (x: T) => boolean) => {
      const index = list.findIndex(pred);
      if (index >= 0) list.splice(index, 1);
      return index >= 0;
    };
    // group 与其余 kind 同契约：未命中抛「未找到」（宽审查 I3，与 memory 对齐），
    // 不再静默成功——否则调用侧 save 误认为删除成功。
    if (kind === "group") {
      if (!removeFrom(ws.groups, (x) => x.id === id)) throw new Error(`未找到: ${id}`);
      return;
    }
    for (const g of ws.groups) {
      if (kind === "project" && removeFrom(g.projects, (x) => x.id === id)) return;
      for (const p of g.projects) {
        if (kind === "environment" && removeFrom(p.environments, (x) => x.id === id)) return;
        for (const c of p.collections) {
          if (kind === "collection" && removeFrom(p.collections, (x) => x.id === id)) return;
          if (kind === "folder" && removeFrom(c.folders, (x) => x.id === id)) return;
          if (kind === "api") {
            if (removeFrom(c.apis, (x) => x.id === id)) return;
            for (const f of c.folders) if (removeFrom(f.apis, (x) => x.id === id)) return;
          }
        }
      }
    }
    throw new Error(`未找到: ${id}`);
  }

  async function save(): Promise<void> {
    const { root: r, workspace: ws } = ensureOpen();
    await fileStorage.save(r, ws);
    await cleanupOrphanDirs(r, ws);
  }

  /**
   * 重命名后清理盘上旧目录（save 只写新路径；规格账本：孤儿清理在此收口）。
   * 目录名匹配走 sameName（C1 修复）：win32 文件系统大小写不敏感——大小写改名（如
   * flow→Flow）后 save 写 `Flow` 被 NTFS 解析到既有 `flow` 目录（盘名不变），严格比较
   * 会把刚写入的目录误判为孤儿递归删除；win32 下归一比较，其余平台严格相等。
   * 删除用 node:fs/promises 的 rm（而非 rmSync）：本机（Windows + Node 24）实测 rmSync
   * 对含非 ASCII 祖先的路径会静默失效甚至硬崩（同步 uv_fs_rm 缺陷，任务 1 报告备案），
   * 异步 rm 实测稳定；maxRetries 兼顾杀软扫描等瞬时句柄竞争。中文目录名是本产品的
   * 常态输入，清理不得依赖一个对它失效的系统调用。
   */
  async function cleanupOrphanDirs(rootDir: string, ws: Workspace): Promise<void> {
    const groupsDir = join(rootDir, "groups");
    if (!existsSync(groupsDir)) return;
    for (const gName of readdirSafe(groupsDir)) {
      const gDir = join(groupsDir, gName);
      const g = ws.groups.find((x) => sameName(x.name, gName, platform));
      if (!g) { await rmOrphan(gDir); continue; }
      const projectsDir = join(gDir, "projects");
      for (const pName of readdirSafe(projectsDir)) {
        const p = g.projects.find((x) => sameName(x.name, pName, platform));
        if (!p) { await rmOrphan(join(projectsDir, pName)); continue; }
        const workflowsDir = join(projectsDir, pName, "workflows");
        for (const wName of readdirSafe(workflowsDir)) {
          if (!p.workflows.find((x) => sameName(x.name, wName, platform))) {
            await rmOrphan(join(workflowsDir, wName));
          }
        }
        const collectionsDir = join(projectsDir, pName, "collections");
        for (const cName of readdirSafe(collectionsDir)) {
          const c = p.collections.find((x) => sameName(x.name, cName, platform));
          if (!c) { await rmOrphan(join(collectionsDir, cName)); continue; }
          const apisDir = join(collectionsDir, cName, "apis");
          for (const aName of readdirSafe(apisDir)) {
            if (!c.apis.find((x) => sameName(x.name, aName, platform)) && !c.folders.find((x) => sameName(x.name, aName, platform))) {
              await rmOrphan(join(apisDir, aName));
            }
          }
          const foldersDir = join(collectionsDir, cName, "folders");
          for (const fName of readdirSafe(foldersDir)) {
            if (!c.folders.find((x) => sameName(x.name, fName, platform))) {
              await rmOrphan(join(foldersDir, fName));
            }
          }
        }
      }
    }
  }

  return {
    get root() { return root; },
    get workspace() { return workspace; },
    async open(dir: string) {
      const storage = fileStorage;
      const loaded = await storage.load(dir);
      root = dir;
      workspace = loaded.workspace;
      return { workspace: loaded.workspace, problems: loaded.problems as LoadProblem[], root: dir };
    },
    async create(dir: string, name: string) {
      if (existsSync(join(dir, "apicc.workspace.yaml"))) throw new Error("目录已是工作区");
      mkdirSync(dir, { recursive: true });
      const ws: Workspace = { id: randomUUID(), name, variables: {}, globals: { variables: {}, query: [], headers: [] }, groups: [] };
      await fileStorage.save(dir, ws);
      root = dir;
      workspace = ws;
      return { workspace: ws, problems: [] as LoadProblem[], root: dir };
    },
    async validate(): Promise<LoadProblem[]> {
      const { root: r } = ensureOpen();
      return (await fileStorage.load(r)).problems;
    },
    createGroup, createProject, createCollection, createFolder, createApi,
    createEnvironment, setEnvironmentVariables, setEnvironmentBaseUrls, setWorkspaceGlobals, importProject,
    locateApi, locateCollection, saveApi,
    locateWorkflow, createWorkflow, deleteWorkflow, saveWorkflow, setWorkflowStatus, renameWorkflow,
    renameNode, deleteNode, save,
  };
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** 孤儿目录/文件删除：force 吞 ENOENT；maxRetries 抗瞬时句柄竞争（杀软扫描等）。 */
function rmOrphan(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

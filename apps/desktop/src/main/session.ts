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
  type Folder,
  type Group,
  type Project,
  type TestCase,
  type Workflow,
  type WorkflowStatus,
  type Workspace,
  type LoadProblem,
  HttpMethod,
} from "@apicc/core";
import { randomUUID } from "node:crypto";
import type { ProjectGlobalSettings } from "../shared/types.js";

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
    // 同名放开（轨二）：id 为身份、目录名=UUID，同级同名并存不再拒绝
    const group: Group = { id: randomUUID(), name, projects: [] };
    ws.groups.push(group);
    return group;
  }

  function createProject(groupId: string, rawName: string): Project {
    const { workspace: ws } = ensureOpen();
    const name = sanitizeNodeName(rawName);
    const group = ws.groups.find((x) => x.id === groupId);
    if (!group) throw new Error(`未找到分组: ${groupId}`);
    const project: Project = { id: randomUUID(), name, variables: {}, globals: { query: [], headers: [], cookies: [], body: [] }, environments: [], collections: [], workflows: [] };
    group.projects.push(project);
    return project;
  }

  function createCollection(projectId: string, rawName: string): Collection {
    const { workspace: ws } = ensureOpen();
    const name = sanitizeNodeName(rawName);
    const project = ws.groups.flatMap((g) => g.projects).find((x) => x.id === projectId);
    if (!project) throw new Error(`未找到项目: ${projectId}`);
    const collection: Collection = { id: randomUUID(), name, variables: {}, folders: [], apis: [] };
    project.collections.push(collection);
    return collection;
  }

  function createFolder(collectionId: string, rawName: string): { id: string; name: string; apis: ApiDefinition[] } {
    const { workspace: ws } = ensureOpen();
    const name = sanitizeNodeName(rawName);
    const collection = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.collections).find((x) => x.id === collectionId);
    if (!collection) throw new Error(`未找到集合: ${collectionId}`);
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
      const api = makeApi();
      folder.apis.push(api);
      return api;
    }
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
    // 同名放开（轨二）：id 为身份、目录名=UUID，同项目同名工作流并存
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
   * id 布局（轨一）后目录名=工作流 id，改名仅改 yaml 名称、盘上目录恒在。
   * 同名放开（轨二）：同项目同名工作流并存，不再拒绝。status 恒不变。
   */
  async function renameWorkflow(workflowId: string, name: string): Promise<void> {
    const loc = locateWorkflow(workflowId);
    if (!loc) throw new Error(`未找到工作流: ${workflowId}`);
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

  /** 项目级全局设置（M10 取代工作区级）：复合包络 = 全局变量（project.variables）+ 四类参数（project.globals）。 */
  function setProjectGlobals(projectId: string, settings: ProjectGlobalSettings): void {
    const { workspace: ws } = ensureOpen();
    const project = ws.groups.flatMap((g) => g.projects).find((x) => x.id === projectId);
    if (!project) throw new Error(`未找到项目: ${projectId}`);
    project.variables = settings.variables;
    project.globals = { query: settings.query, headers: settings.headers, cookies: settings.cookies, body: settings.body };
  }

  function getProjectGlobals(projectId: string): ProjectGlobalSettings {
    const { workspace: ws } = ensureOpen();
    const project = ws.groups.flatMap((g) => g.projects).find((x) => x.id === projectId);
    if (!project) throw new Error(`未找到项目: ${projectId}`);
    const g = project.globals ?? { query: [], headers: [], cookies: [], body: [] };
    return { variables: project.variables, query: g.query, headers: g.headers, cookies: g.cookies, body: g.body };
  }

  /** 容器读取（M10）：管理对话框水合。返回与 ContainerSaveInput 同形（含 name 显示用）。 */
  function getContainer(kind: "collection" | "folder", id: string): {
    kind: "collection" | "folder"; id: string; name: string;
    variables?: Record<string, string>;
    preOperations: Array<{ id: string; type: "script"; content: string }>;
    postOperations: Array<{ id: string; type: "script"; content: string }>;
  } {
    const { workspace: ws } = ensureOpen();
    if (kind === "collection") {
      const c = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.collections).find((x) => x.id === id);
      if (!c) throw new Error(`未找到集合: ${id}`);
      return {
        kind, id, name: c.name, variables: c.variables,
        preOperations: c.preOperations ?? [], postOperations: c.postOperations ?? [],
      };
    }
    const f = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.collections).flatMap((c) => c.folders).find((x) => x.id === id);
    if (!f) throw new Error(`未找到文件夹: ${id}`);
    return { kind, id, name: f.name, preOperations: f.preOperations ?? [], postOperations: f.postOperations ?? [] };
  }

  /** 容器保存（M10）：模块（集合）= 变量 + 前置/后置操作；文件夹 = 前置/后置操作。id 定位整体替换。 */
  function saveContainer(input: {
    kind: "collection" | "folder";
    id: string;
    variables?: Record<string, string>;
    preOperations: Array<{ id: string; type: "script"; content: string }>;
    postOperations: Array<{ id: string; type: "script"; content: string }>;
  }): void {
    const { workspace: ws } = ensureOpen();
    if (input.kind === "collection") {
      const c = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.collections).find((x) => x.id === input.id);
      if (!c) throw new Error(`未找到集合: ${input.id}`);
      if (input.variables) c.variables = input.variables;
      c.preOperations = input.preOperations;
      c.postOperations = input.postOperations;
      return;
    }
    const f = ws.groups
      .flatMap((g) => g.projects)
      .flatMap((p) => p.collections)
      .flatMap((c) => c.folders)
      .find((x) => x.id === input.id);
    if (!f) throw new Error(`未找到文件夹: ${input.id}`);
    f.preOperations = input.preOperations;
    f.postOperations = input.postOperations;
  }

  /**
   * 默认分组保障（M10）：打开工作区后调用——按标记定位；缺失时同名「默认分组」就地补标记；
   * 再缺失才创建。只在发生变更时落盘（只读打开零写入）。
   */
  async function ensureDefaultGroup(): Promise<void> {
    const { workspace: ws } = ensureOpen();
    if (ws.groups.some((x) => x.default === true)) return;
    const byName = ws.groups.find((x) => sameName(x.name, "默认分组", platform));
    if (byName) {
      byName.default = true;
      await save();
      return;
    }
    ws.groups.push({ id: randomUUID(), name: "默认分组", default: true, projects: [] });
    await save();
  }

  function setEnvironmentVariables(envId: string, variables: Record<string, string>): void {
    const { workspace: ws } = ensureOpen();
    const env = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.environments).find((x) => x.id === envId);
    if (!env) throw new Error(`未找到环境: ${envId}`);
    env.variables = variables;
  }

  /**
   * 导入项目（轨二 project 模式）：目标分组按 id 选择；同名项目并存不再拒绝。
   * 导入树内全部实体名经 sanitizeNodeName 净化（名称卫生；id 布局后不再承担盘上安全职责）。
   * 产物环境（如 OpenAPI 的 imported baseUrl 环境）随项目整包落库。
   */
  async function importProjectToGroup(groupId: string, projectName: string, imported: { project: Project }): Promise<Project> {
    const { workspace: ws } = ensureOpen();
    const group = ws.groups.find((x) => x.id === groupId);
    if (!group) throw new Error(`未找到分组: ${groupId}`);
    const project = imported.project;
    project.name = sanitizeNodeName(projectName.trim() || project.name);
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
    return project;
  }

  /**
   * 导入模块（轨二 module 模式）：把导入产物的每个集合改名后追加为目标项目的模块；
   * 产物环境里的 baseUrl 变量写入该模块的模块变量（变量链=环境>模块>全局，任何环境可
   * 直接跑通、按环境可覆盖），**不创建环境**——避免多次导入灌水 imported 环境；产物
   * 环境与工作流在 module 模式丢弃。同名模块并存（同名放开）。
   */
  async function importModuleToProject(projectId: string, moduleName: string, imported: { project: Project }): Promise<Collection[]> {
    const { workspace: ws } = ensureOpen();
    const project = ws.groups.flatMap((g) => g.projects).find((x) => x.id === projectId);
    if (!project) throw new Error(`未找到项目: ${projectId}`);
    const baseUrl = imported.project.environments?.[0]?.variables?.baseUrl;
    const imported0 = imported.project.collections.map((c) => ({
      ...c,
      name: sanitizeNodeName(moduleName.trim() || c.name),
      variables: { ...c.variables, ...(baseUrl ? { baseUrl } : {}) },
      folders: c.folders.map((f) => ({
        ...f,
        name: sanitizeNodeName(f.name),
        apis: f.apis.map((a) => ({ ...a, name: sanitizeNodeName(a.name), cases: a.cases.map((tc) => ({ ...tc, name: sanitizeNodeName(tc.name) })) })),
      })),
      apis: c.apis.map((a) => ({ ...a, name: sanitizeNodeName(a.name), cases: a.cases.map((tc) => ({ ...tc, name: sanitizeNodeName(tc.name) })) })),
    }));
    project.collections.push(...imported0);
    await save();
    return imported0;
  }

  /**
   * 克隆项目（轨二）：整项目深拷贝、全部实体发新 UUID（含环境/模块/目录/接口/用例/
   * 工作流），变量/全局参数/操作列表随结构带走；落回原分组，名称=原名（同名放开）。
   */
  async function cloneProject(projectId: string): Promise<Project> {
    const { workspace: ws } = ensureOpen();
    const group = ws.groups.find((g) => g.projects.some((p) => p.id === projectId));
    const source = group?.projects.find((p) => p.id === projectId);
    if (!group || !source) throw new Error(`未找到项目: ${projectId}`);
    const clone = JSON.parse(JSON.stringify(source)) as Project;
    const reidCase = (tc: TestCase): TestCase => ({ ...tc, id: randomUUID() });
    const reidApi = (a: ApiDefinition): ApiDefinition => ({ ...a, id: randomUUID(), cases: a.cases.map(reidCase) });
    const reidFolder = (f: Folder): Folder => ({ ...f, id: randomUUID(), apis: f.apis.map(reidApi), folders: (f.folders ?? []).map(reidFolder) });
    clone.id = randomUUID();
    clone.environments = (clone.environments ?? []).map((e) => ({ ...e, id: randomUUID() }));
    clone.collections = clone.collections.map((c) => ({
      ...c, id: randomUUID(), apis: c.apis.map(reidApi), folders: c.folders.map(reidFolder),
      preOperations: c.preOperations?.map((o) => ({ ...o, id: randomUUID() })),
      postOperations: c.postOperations?.map((o) => ({ ...o, id: randomUUID() })),
    }));
    for (const c of clone.collections) {
      for (const f of c.folders) {
        for (const o of f.preOperations ?? []) o.id = randomUUID();
        for (const o of f.postOperations ?? []) o.id = randomUUID();
        for (const sub of f.folders ?? []) {
          for (const o of sub.preOperations ?? []) o.id = randomUUID();
          for (const o of sub.postOperations ?? []) o.id = randomUUID();
        }
      }
    }
    clone.workflows = (clone.workflows ?? []).map((w) => ({ ...w, id: randomUUID() }));
    group.projects.push(clone);
    await save();
    return clone;
  }

  /** 移动项目（轨二）：按 id 从原分组移入目标分组（落盘）。 */
  async function moveProject(projectId: string, targetGroupId: string): Promise<void> {
    const { workspace: ws } = ensureOpen();
    const source = ws.groups.find((g) => g.projects.some((p) => p.id === projectId));
    if (!source) throw new Error(`未找到项目: ${projectId}`);
    const target = ws.groups.find((g) => g.id === targetGroupId);
    if (!target) throw new Error(`未找到分组: ${targetGroupId}`);
    if (target.id === source.id) return;
    const index = source.projects.findIndex((p) => p.id === projectId);
    const [project] = source.projects.splice(index, 1);
    target.projects.push(project);
    await save();
  }

  function renameNode(kind: NodeKind, id: string, rawName: string): void {
    const { workspace: ws } = ensureOpen();
    const name = sanitizeNodeName(rawName);
    // 同名放开（轨二）：仅默认分组守卫与「未找到」保留，其余重名检查全部移除
    if (kind === "group") {
      const n = ws.groups.find((x) => x.id === id);
      if (!n) throw new Error(`未找到: ${id}`);
      if (n.default === true) throw new Error("默认分组不可改名");
      n.name = name;
      return;
    }
    if (kind === "project") {
      const n = ws.groups.flatMap((g) => g.projects).find((x) => x.id === id);
      if (!n) throw new Error(`未找到: ${id}`);
      n.name = name;
      return;
    }
    if (kind === "collection") {
      const n = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.collections).find((x) => x.id === id);
      if (!n) throw new Error(`未找到: ${id}`);
      n.name = name;
      return;
    }
    if (kind === "folder") {
      const n = ws.groups.flatMap((g) => g.projects).flatMap((p) => p.collections).flatMap((c) => c.folders).find((x) => x.id === id);
      if (!n) throw new Error(`未找到: ${id}`);
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
      const g = ws.groups.find((x) => x.id === id);
      if (!g) throw new Error(`未找到: ${id}`);
      if (g.default === true) throw new Error("默认分组不可删除");
      removeFrom(ws.groups, (x) => x.id === id);
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
   * 清理盘上孤儿目录（save 只写现存实体；重命名/删除后的旧目录在此收口）。
   * id 布局（轨一）后目录名=实体 id，按 id 精确匹配——名称制时代的 win32 大小写归一
   * 特判随目录名消失（UUID 恒为小写且逐字符精确）。
   * 删除用 node:fs/promises 的 rm（而非 rmSync）：本机（Windows + Node 24）实测 rmSync
   * 对含非 ASCII 祖先的路径会静默失效甚至硬崩（同步 uv_fs_rm 缺陷，任务 1 报告备案），
   * 异步 rm 实测稳定；maxRetries 兼顾杀软扫描等瞬时句柄竞争。中文目录名是本产品的
   * 常态输入，清理不得依赖一个对它失效的系统调用。
   */
  async function cleanupOrphanDirs(rootDir: string, ws: Workspace): Promise<void> {
    const groupsDir = join(rootDir, "groups");
    if (!existsSync(groupsDir)) return;
    for (const gId of readdirSafe(groupsDir)) {
      const gDir = join(groupsDir, gId);
      const g = ws.groups.find((x) => x.id === gId);
      if (!g) { await rmOrphan(gDir); continue; }
      const projectsDir = join(gDir, "projects");
      for (const pId of readdirSafe(projectsDir)) {
        const p = g.projects.find((x) => x.id === pId);
        if (!p) { await rmOrphan(join(projectsDir, pId)); continue; }
        const workflowsDir = join(projectsDir, pId, "workflows");
        for (const wId of readdirSafe(workflowsDir)) {
          if (!p.workflows.find((x) => x.id === wId)) {
            await rmOrphan(join(workflowsDir, wId));
          }
        }
        const collectionsDir = join(projectsDir, pId, "collections");
        for (const cId of readdirSafe(collectionsDir)) {
          const c = p.collections.find((x) => x.id === cId);
          if (!c) { await rmOrphan(join(collectionsDir, cId)); continue; }
          const apisDir = join(collectionsDir, cId, "apis");
          for (const aId of readdirSafe(apisDir)) {
            if (!c.apis.find((x) => x.id === aId)) {
              await rmOrphan(join(apisDir, aId));
            }
          }
          const foldersDir = join(collectionsDir, cId, "folders");
          for (const fId of readdirSafe(foldersDir)) {
            if (!c.folders.find((x) => x.id === fId)) {
              await rmOrphan(join(foldersDir, fId));
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
      await ensureDefaultGroup();
      return { workspace: loaded.workspace, problems: loaded.problems as LoadProblem[], root: dir };
    },
    async create(dir: string, name: string) {
      if (existsSync(join(dir, "apicc.workspace.yaml"))) throw new Error("目录已是工作区");
      mkdirSync(dir, { recursive: true });
      const g: Group = { id: randomUUID(), name: "默认分组", default: true, projects: [] };
      const ws: Workspace = { id: randomUUID(), name, variables: {}, groups: [g] };
      await fileStorage.save(dir, ws);
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
    createEnvironment, setEnvironmentVariables, setEnvironmentBaseUrls, setProjectGlobals, getProjectGlobals, getContainer, saveContainer, ensureDefaultGroup,
    importProjectToGroup, importModuleToProject, cloneProject, moveProject,
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

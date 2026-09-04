/**
 * online 会话（M3-B 任务 1/2）：登录态串联——login 成功 → token 注入 client（请求自动带头）
 * → tokenStore 按 baseUrl 持久化（任务 2 裁定 A：多服务器凭据并存）；401 会话失效事件 →
 * 清该服务器存档 + 清当前 client。任务 2 裁定 A：resume() 恢复链路——启动（或服务器档案
 * 激活）时 load(baseUrl) 存档 → seed client → GET /me 验活：成功 = 登录态恢复；失败
 * （401/网络错误）= 清档并保持登出态。
 *
 * 任务 3 扩展：当前在线工作区状态（openWorkspace/closeWorkspace，纯状态操作不发网络）+
 * 树缓存（getTreeView 首取后缓存，内容变更（put/batch/delete 成功）即失效，切换/关闭重置）。
 * 树映射 onlineTreeToDto 为纯函数（裁定 A）：服务端不回树结构，由 files path 清单按 M1 §6
 * 目录约定推导 groups/projects/collections/folders/apis 层级，工作流/环境/配置文件映射为
 * 只读 file 叶（裁定 B：只读浏览，不做编辑器）。
 * **不持文件内容缓存**（审查次要 5 顺修）：文件版本号由渲染层编辑缓冲自持
 * （selectNode 取数即入缓冲、saveApi 前移），main 侧只写不读的缓存已删除。
 */
import type { OnlineClient } from "./client.js";
import { OnlineConflictError } from "./client.js";
import type { TokenStore } from "./tokenStore.js";
import type { TreeNodeDTO } from "../../shared/tree-dto.js";
import type {
  OnlineDeleteOutcome,
  OnlineFilesBatchInput,
  OnlineFileDeleteInput,
  OnlineFilePutInput,
  OnlineFilesGetInput,
  OnlineLoginInput,
  OnlineLoginOutput,
  OnlinePushOutcome,
  OnlineRegisterChannelInput,
  OnlineResumeOutput,
  OnlineWorkspaceCreateInput,
  OnlineWorkspaceOpenInput,
  OnlineWorkspaceView,
} from "../../shared/online/types.js";
import type { OnlineBatchResult, OnlineFilesResult, OnlinePutFileResult, OnlineTree, OnlineTreeFile, OnlineUser, OnlineWorkspaceCreated, OnlineWorkspaceSummary } from "../../shared/online/contract.js";

/** 当前在线工作区状态（渲染层顶栏徽标/只读判定的数据源）。 */
export interface OnlineWorkspaceState {
  id: string;
  name: string;
  myRole: OnlineWorkspaceOpenInput["myRole"];
}

// —— onlineTreeToDto（裁定 A：path 清单 → 侧树层级，纯函数）——

/** path 解析产物：M1 §6 布局逐段匹配；未匹配 = 杂散文件，不进树。 */
interface ParsedPath {
  group: string;
  project?: string;
  collection?: string;
  folder?: string;
  kind: "group-config" | "project-config" | "env" | "workflow" | "collection-config" | "folder-config" | "api";
  /** 叶显示名：配置文件取文件名、环境取文件名、工作流/接口取目录名。 */
  name: string;
}

function parseWorkspacePath(path: string): ParsedPath | null {
  const segs = path.split("/");
  if (segs[0] !== "groups" || segs.length < 3) return null;
  const group = segs[1]!;
  if (segs.length === 3) return segs[2] === "group.yaml" ? { group, kind: "group-config", name: "group.yaml" } : null;
  if (segs[2] !== "projects" || segs.length < 5) return null;
  const project = segs[3]!;
  if (segs.length === 5) return segs[4] === "project.yaml" ? { group, project, kind: "project-config", name: "project.yaml" } : null;
  if (segs.length === 6 && segs[4] === "environments") return { group, project, kind: "env", name: segs[5]! };
  if (segs.length === 7 && segs[4] === "workflows" && segs[6] === "workflow.yaml") {
    return { group, project, kind: "workflow", name: segs[5]! };
  }
  if (segs[4] !== "collections" || segs.length < 7) return null;
  const collection = segs[5]!;
  if (segs.length === 7) return segs[6] === "collection.yaml" ? { group, project, collection, kind: "collection-config", name: "collection.yaml" } : null;
  // 文件夹配置：collections/<c>/folders/<f>/folder.yaml（次要 3 顺修：与 group/project/collection.yaml 同口径只读叶）
  if (segs.length === 9 && segs[6] === "folders" && segs[8] === "folder.yaml") {
    return { group, project, collection, folder: segs[7]!, kind: "folder-config", name: "folder.yaml" };
  }
  // 接口：collections/<c>/apis/<a>/api.yaml 与 folders/<f>/apis/<a>/api.yaml
  if (segs[6] === "apis" && segs.length === 9 && segs[8] === "api.yaml") {
    return { group, project, collection, kind: "api", name: segs[7]! };
  }
  if (segs[6] === "folders" && segs.length === 11 && segs[8] === "apis" && segs[10] === "api.yaml") {
    return { group, project, collection, folder: segs[7]!, kind: "api", name: segs[9]! };
  }
  return null;
}

function sortTree(node: TreeNodeDTO): TreeNodeDTO {
  if (node.children?.length) {
    node.children.sort((a, b) => (a.label === b.label ? (a.id < b.id ? -1 : 1) : a.label < b.label ? -1 : 1));
    for (const child of node.children) sortTree(child);
  }
  return node;
}

/**
 * 服务端 tree → 侧树根 DTO。容器节点 id 取目录路径（groups/<g>/…，树内唯一）；
 * api/file 叶 id 取文件全路径（渲染层据此 getFiles 取内容）。root label 优先取工作区名。
 */
export function onlineTreeToDto(tree: OnlineTree, workspaceName?: string): TreeNodeDTO {
  const root: TreeNodeDTO = { kind: "root", id: tree.workspaceId, label: workspaceName ?? tree.workspaceId, children: [] };
  const containers = new Map<string, TreeNodeDTO>();
  const ensure = (kind: TreeNodeDTO["kind"], id: string, label: string, parent: TreeNodeDTO): TreeNodeDTO => {
    const existing = containers.get(id);
    if (existing) return existing;
    const node: TreeNodeDTO = { kind, id, label, children: [] };
    containers.set(id, node);
    parent.children!.push(node);
    return node;
  };
  const leaf = (id: string, label: string): TreeNodeDTO => ({ kind: "file", id, label, children: [] });

  // 根配置：apicc.workspace.yaml（工作区级"项目配置"只读叶）
  if (tree.files.some((f: OnlineTreeFile) => f.path === "apicc.workspace.yaml")) {
    root.children!.push(leaf("apicc.workspace.yaml", "apicc.workspace.yaml"));
  }
  for (const file of tree.files) {
    if (file.path === "apicc.workspace.yaml") continue;
    const parsed = parseWorkspacePath(file.path);
    if (!parsed) continue;
    const group = ensure("group", `groups/${parsed.group}`, parsed.group, root);
    if (parsed.kind === "group-config") {
      group.children!.push(leaf(file.path, parsed.name));
      continue;
    }
    const project = ensure("project", `groups/${parsed.group}/projects/${parsed.project}`, parsed.project!, group);
    if (parsed.kind === "project-config") {
      project.children!.push(leaf(file.path, parsed.name));
      continue;
    }
    if (parsed.kind === "env" || parsed.kind === "workflow") {
      project.children!.push(leaf(file.path, parsed.name));
      continue;
    }
    const collection = ensure(
      "collection",
      `groups/${parsed.group}/projects/${parsed.project}/collections/${parsed.collection}`,
      parsed.collection!,
      project,
    );
    if (parsed.kind === "collection-config") {
      collection.children!.push(leaf(file.path, parsed.name));
      continue;
    }
    const folderNode = parsed.folder
      ? ensure("folder", `groups/${parsed.group}/projects/${parsed.project}/collections/${parsed.collection}/folders/${parsed.folder}`, parsed.folder, collection)
      : collection;
    if (parsed.kind === "folder-config") {
      // folder.yaml 只读叶挂在 folder 节点（folder 仅为 folder.yaml 存在时也建容器，与 collection-config 同口径）
      folderNode.children!.push(leaf(file.path, parsed.name));
      continue;
    }
    // api 叶 id = api.yaml 全路径：选中后渲染层按该路径 getFiles 取内容（裁定 B）
    folderNode.children!.push({ kind: "api", id: file.path, label: parsed.name, children: [] });
  }
  return sortTree(root);
}

export interface OnlineSessionDeps {
  /** client 工厂：baseUrl 定服务端，hooks.onUnauthorized 挂会话失效清理。 */
  createClient: (baseUrl: string, hooks: { onUnauthorized: () => void }) => OnlineClient;
  tokenStore: TokenStore;
}

export function createOnlineSession(deps: OnlineSessionDeps) {
  let current: { baseUrl: string; client: OnlineClient } | null = null;
  // 任务 3：当前在线工作区 + 树缓存（open/close/切换时重置；内容变更即失效）。
  // 不持文件内容缓存（审查次要 5）：版本号在渲染层编辑缓冲自持，main 侧只写不读即死代码。
  let workspaceState: OnlineWorkspaceState | null = null;
  let treeCache: OnlineTree | null = null;

  function requireWorkspace(workspaceId: string): OnlineWorkspaceState {
    if (!workspaceState || workspaceState.id !== workspaceId) throw new Error("尚未打开在线工作区");
    return workspaceState;
  }

  /**
   * 会话失效清理（审查重要 1 修复）：清**指定**服务器的 token 存档；current 属于该服务器
   * 时一并摘除。钩子按捕获的 baseUrl 调用、不经 current 反查——resume 验活期 current 可能
   * 仍指旧会话，按 current 清会串档清掉旧服务器的有效存档（且误摘旧会话）。
   */
  function invalidate(baseUrl: string): void {
    deps.tokenStore.clear(baseUrl);
    if (current?.baseUrl === baseUrl) current = null;
  }

  function requireClient(): OnlineClient {
    if (!current) throw new Error("尚未登录在线服务器");
    return current.client;
  }

  /** put/delete 共用的冲突出口转换：OnlineConflictError → outcome 结果对象（过 IPC 不丢字段）。 */
  async function pushOutcome(run: () => Promise<OnlinePutFileResult>): Promise<OnlinePushOutcome> {
    try {
      return { outcome: "pushed", result: await run() };
    } catch (e) {
      if (e instanceof OnlineConflictError) return { outcome: "conflict", conflict: e.conflict };
      throw e;
    }
  }

  return {
    /** 当前登录态信息（任务 2 顶栏/登录面板消费）；未登录为 null。 */
    get current(): { baseUrl: string } | null {
      return current ? { baseUrl: current.baseUrl } : null;
    },

    /** 当前在线工作区（任务 3）：null = 未打开。 */
    get workspace(): OnlineWorkspaceState | null {
      return workspaceState;
    },

    /**
     * 打开在线工作区（纯状态操作，不发网络）：记录三元组并重置树缓存。
     * 与本地工作区互斥（裁定 E）由 IPC 组合层保证（ws:open 链路反向清理）。
     */
    openWorkspace(input: OnlineWorkspaceOpenInput): void {
      workspaceState = { id: input.workspaceId, name: input.name, myRole: input.myRole };
      treeCache = null;
    },

    /** 关闭在线工作区（裁定 E 退出清理）：清状态 + 树缓存（编辑缓冲由渲染层同步清）。 */
    closeWorkspace(): void {
      workspaceState = null;
      treeCache = null;
    },

    /**
     * 在线工作区视图（裁定 A）：首次取服务端 /tree 并缓存，映射为侧树 TreeNodeDTO，
     * 附带项目角色清单（渲染层逐项目只读判定）。workspaceId 与当前工作区不符 → 可读错误。
     */
    async getTreeView(workspaceId: string): Promise<OnlineWorkspaceView> {
      const ws = requireWorkspace(workspaceId);
      const client = requireClient();
      treeCache ??= await client.getTree(workspaceId);
      return {
        workspaceId: ws.id,
        name: ws.name,
        myRole: ws.myRole,
        projects: treeCache.projects,
        tree: onlineTreeToDto(treeCache, ws.name),
      };
    },

    /** 会话失效清理（401 事件链的显式入口，测试与组合根可直呼）。 */
    invalidate,

    async register(input: OnlineRegisterChannelInput): Promise<OnlineUser> {
      const { baseUrl, ...credentials } = input;
      // 注册不建立登录态：一次性 client 只发注册请求（hooks 空——注册 401 语义为禁注册等，无会话可失效）。
      const client = deps.createClient(baseUrl, { onUnauthorized: () => undefined });
      return client.register(credentials);
    },

    async login(input: OnlineLoginInput): Promise<OnlineLoginOutput> {
      // 401 钩子按捕获的 baseUrl 清档（审查重要 1）：不经 current 反查，避免串档。
      const client = deps.createClient(input.baseUrl, { onUnauthorized: () => invalidate(input.baseUrl) });
      const result = await client.login({ username: input.username, password: input.password });
      deps.tokenStore.save(input.baseUrl, result.token); // 登录 → 按服务器存档（client 已注入，后续请求自动带头）
      current = { baseUrl: input.baseUrl, client };
      return { expiresAt: result.expiresAt, user: result.user }; // token 不出 main 进程
    },

    /**
     * 恢复登录态（任务 2 裁定 A）：启动或服务器档案激活时调用。load(baseUrl) 有存档 →
     * seed client → GET /me 验活：成功 = 建立 current 并返回 restored + 用户；失败
     * （401/网络错误/协议错误）= 清档（clear(baseUrl)）并保持登出态；无存档 = 直接登出态。
     * 任何失败都不抛（渲染层拿到可辨别的结果对象，引导重新登录而非裸错误）。
     * 401 钩子按捕获的 baseUrl 清档（审查重要 1）：验活期 current 仍指旧会话（或 null），
     * 钩子只清 resume 目标的存档、不摘未归属的 current——修复前会串档清旧会话的有效存档。
     */
    async resume(baseUrl: string): Promise<OnlineResumeOutput> {
      const token = deps.tokenStore.load(baseUrl);
      if (token === null) return { outcome: "signed-out" };
      const client = deps.createClient(baseUrl, { onUnauthorized: () => invalidate(baseUrl) });
      client.setToken(token);
      try {
        const user = await client.me();
        current = { baseUrl, client };
        return { outcome: "restored", user };
      } catch {
        // 验活失败（过期/网络/协议）：清档保持登出态（裁定 A 原文语义）。401 路径钩子已按
        // 同一 baseUrl 清过（幂等），此处收口覆盖不经 401 钩子的网络/协议失败路径。
        invalidate(baseUrl);
        return { outcome: "signed-out" };
      }
    },

    async logout(): Promise<void> {
      if (!current) return;
      const { baseUrl, client } = current;
      invalidate(baseUrl); // 先摘本地态再吊销；吊销失败（网络断等）不阻断本地登出——本地态已清，token 留服务端 30 天自然过期
      try {
        await client.logout();
      } catch (e) {
        console.warn(`在线登出请求失败（本地登录态已清除）: ${e instanceof Error ? e.message : String(e)}`);
      }
    },

    async me(): Promise<OnlineUser> {
      return requireClient().me();
    },

    async listWorkspaces(): Promise<OnlineWorkspaceSummary[]> {
      return requireClient().listWorkspaces();
    },

    async createWorkspace(input: OnlineWorkspaceCreateInput): Promise<OnlineWorkspaceCreated> {
      return requireClient().createWorkspace(input);
    },

    async getTree(workspaceId: string): Promise<OnlineTree> {
      return requireClient().getTree(workspaceId);
    },

    async getFiles(input: OnlineFilesGetInput): Promise<OnlineFilesResult> {
      // 直通出口（不缓存文件内容——版本号由渲染层编辑缓冲自持，审查次要 5 顺修备案）
      return requireClient().getFiles(input.workspaceId, input.paths);
    },

    async putFile(input: OnlineFilePutInput): Promise<OnlinePushOutcome> {
      const { workspaceId, path, content, baseVersion } = input;
      const outcome = await pushOutcome(() => requireClient().putFile(workspaceId, { path, content, baseVersion }));
      // 推送成功使树缓存失效（推送后 refreshTreeView 取到新 hash/新文件）；
      // 冲突不动缓存——服务端现状以冲突对象带回。
      if (outcome.outcome === "pushed" && workspaceState?.id === workspaceId) {
        treeCache = null;
      }
      return outcome;
    },

    async batchPush(input: OnlineFilesBatchInput): Promise<OnlineBatchResult> {
      const { workspaceId, files } = input;
      const result = await requireClient().batchPush(workspaceId, { files });
      // 任一文件推送成功即树缓存失效（迁移推送后的树刷新必须见到新文件/新 hash）。
      if (workspaceState?.id === workspaceId && result.results.some((r) => r.status === "pushed")) {
        treeCache = null;
      }
      return result;
    },

    async deleteFile(input: OnlineFileDeleteInput): Promise<OnlineDeleteOutcome> {
      try {
        await requireClient().deleteFile(input.workspaceId, { path: input.path, baseVersion: input.baseVersion });
        if (workspaceState?.id === input.workspaceId) treeCache = null;
        return { outcome: "deleted" };
      } catch (e) {
        if (e instanceof OnlineConflictError) return { outcome: "conflict", conflict: e.conflict };
        throw e;
      }
    },
  };
}

export type OnlineSession = ReturnType<typeof createOnlineSession>;

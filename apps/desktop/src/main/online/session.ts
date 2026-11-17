/**
 * online 会话（M3-B 任务 1/2）：登录态串联——login 成功 → token 注入 client（请求自动带头）
 * → tokenStore 按 baseUrl 持久化（任务 2 裁定 A：多服务器凭据并存）；401 会话失效事件 →
 * 清该服务器存档 + 清当前 client。任务 2 裁定 A：resume() 恢复链路——启动（或服务器档案
 * 激活）时 load(baseUrl) 存档 → seed client → GET /me 验活：成功 = 登录态恢复；失败
 * （401/网络错误）= 清档并保持登出态。
 *
 * 任务 3 扩展：当前在线工作区状态（openWorkspace/closeWorkspace，纯状态操作不发网络）+
 * 树缓存（getTreeView 首取后缓存，内容变更（put/batch/delete 成功）即失效，切换/关闭重置）。
 * 计划 C 任务 1 会话表化：单槽 → Map<workspaceId, {workspaceState, treeCache}> + 活跃指针——
 * open 入表激活、activateWorkspace 显式切活跃、closeWorkspace 带 id 出表/无参关活跃
 * （出表不自动切活跃）、logout 清全表；树缓存按工作区隔离。
 * 树映射 onlineTreeToDto 为纯函数（裁定 A）：服务端不回树结构，由 files path 清单推导
 * projects/collections/folders/apis 层级（path 实体化 2026-09-08：首段=项目实体 id；
 * 2026-09-09 服务端 BIGINT 化后项目 id 为数字，对外字符串化数字），
 * 工作流/环境/配置文件映射为只读 file 叶（裁定 B：只读浏览，不做编辑器）。
 * 计划 C 任务 3 分组层：getTreeView 同取 /groups 清单（groupId→组名反查表，失败降级空表）
 * 注入映射——有组归属且组名可得的项目挂 `group:<groupId>` 合成组节点，孤儿项目直挂根。
 * **不持文件内容缓存**（审查次要 5 顺修）：文件版本号由渲染层编辑缓冲自持
 * （selectNode 取数即入缓冲、saveApi 前移），main 侧只写不读的缓存已删除。
 */
import type { OnlineClient } from "./client.js";
import type { OnlineExecutionContext } from "../../shared/online/execution.js";
import { OnlineConflictError } from "./client.js";
import type { TokenStore } from "./tokenStore.js";
import { onlineTreeToDto } from "../../shared/online/tree.js";
export { onlineTreeToDto } from "../../shared/online/tree.js";
import type {
  OnlineDeleteOutcome,
  OnlineFilesBatchInput,
  OnlineFileDeleteInput,
  OnlineFilePutInput,
  OnlineFilesGetInput,
  OnlineLoginInput,
  OnlineLoginOutput,
  OnlineProjectMappingInput,
  OnlinePushOutcome,
  OnlineRegisterChannelInput,
  OnlineResumeOutput,
  OnlineWorkspaceCreateInput,
  OnlineWorkspaceOpenInput,
  OnlineWorkspaceView,
} from "../../shared/online/types.js";
import type { OnlineBatchResult, OnlineFilesResult, OnlineGroup, OnlineMappingResult, OnlinePutFileResult, OnlineTree, OnlineUser, OnlineWorkspaceCreated, OnlineWorkspaceSummary } from "../../shared/online/contract.js";

/** 当前在线工作区状态（渲染层顶栏徽标/只读判定的数据源）。 */
export interface OnlineWorkspaceState {
  id: string;
  name: string;
  myRole: OnlineWorkspaceOpenInput["myRole"];
}

export interface OnlineSessionDeps {
  /** client 工厂：baseUrl 定服务端，hooks.onUnauthorized 挂会话失效清理。 */
  createClient: (baseUrl: string, hooks: { onUnauthorized: () => void }) => OnlineClient;
  tokenStore: TokenStore;
}

/** 在线工作区驻留会话（计划 C 任务 1）：状态 + 按工作区隔离的树缓存。 */
interface OnlineWorkspaceSession {
  workspaceState: OnlineWorkspaceState;
  baseUrl: string | null;
  treeCache: { tree: OnlineTree; groups: OnlineGroup[] } | null;
  treeGeneration: number;
}

export function createOnlineSession(deps: OnlineSessionDeps) {
  let current: { baseUrl: string; client: OnlineClient; userId: string } | null = null;
  let authenticationGeneration = 0;
  // 计划 C 任务 1：会话表——Map<workspaceId, {workspaceState, treeCache}> + 活跃指针。
  // 工作区驻留：open 入表（不覆盖其他驻留工作区）；切换只由 activateWorkspace 显式驱动；
  // 出表后活跃指针置 null（不自动切）。树缓存随表项走（按工作区隔离，内容变更只失效对应项）。
  // 不持文件内容缓存（审查次要 5）：版本号在渲染层编辑缓冲自持，main 侧只写不读即死代码。
  const sessions = new Map<string, OnlineWorkspaceSession>(); // key = workspaceState.id
  let activeId: string | null = null;

  function activeSession(): OnlineWorkspaceSession | null {
    return activeId !== null ? sessions.get(activeId) ?? null : null;
  }

  function requireWorkspace(workspaceId: string): OnlineWorkspaceState {
    const active = activeSession();
    if (!active || active.workspaceState.id !== workspaceId) throw new Error("online-workspace-not-open");
    if (active.baseUrl && active.baseUrl !== current?.baseUrl) throw new Error("online-workspace-server-conflict");
    active.baseUrl ??= current?.baseUrl ?? null;
    return active.workspaceState;
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
    if (!current) throw new Error("online-not-signed-in");
    return current.client;
  }

  function requireWorkspaceClient(workspaceId: string): OnlineClient {
    const client = requireClient();
    const owner = sessions.get(workspaceId)?.baseUrl;
    if (owner && owner !== current?.baseUrl) throw new Error("online-workspace-server-conflict");
    return client;
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
    /** Only main consumes this capture. Tokens never enter renderer DTOs. */
    captureExecution(context: OnlineExecutionContext) {
      const captured = current;
      const capturedWorkspace = sessions.get(context.scope.workspaceId);
      const serverId = captured ? `${captured.baseUrl.replace(/\/$/, "")}/api/v1` : "";
      const assertCurrent = () => {
        const workspace = sessions.get(context.scope.workspaceId);
        if (!captured || current !== captured || context.ownerId !== captured.userId || context.serverId !== serverId
            || activeId !== context.scope.workspaceId || !workspace || workspace !== capturedWorkspace
            || (workspace.baseUrl && workspace.baseUrl !== captured.baseUrl)) {
          throw new Error("online-session-changed");
        }
      };
      assertCurrent();
      const base = new URL(serverId);
      if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("execution-requires-https");
      return { serverId, userId: captured!.userId, token: () => { assertCurrent(); if (!captured!.client.token) throw new Error("online-session-changed"); return captured!.client.token; }, assertCurrent,
        invalidateTree: () => {
          if (capturedWorkspace && sessions.get(context.scope.workspaceId) === capturedWorkspace && current === captured) {
            capturedWorkspace.treeCache = null;
            capturedWorkspace.treeGeneration += 1;
          }
        } };
    },
    /** 当前登录态信息（任务 2 顶栏/登录面板消费）；未登录为 null。 */
    get current(): { baseUrl: string } | null {
      return current ? { baseUrl: current.baseUrl } : null;
    },

    /** 活跃在线工作区（渲染层顶栏徽标/只读判定的数据源）；null = 无活跃工作区。 */
    get workspace(): OnlineWorkspaceState | null {
      return activeSession()?.workspaceState ?? null;
    },

    /** 驻留工作区 id 快照（计划 C 任务 1：IPC open 失败回滚按「表空才回滚」判定用）。 */
    get residentIds(): string[] {
      return [...sessions.keys()];
    },

    /**
     * 打开在线工作区（纯状态操作，不发网络）：入表（已驻留则更新 workspaceState）+ 置活跃
     * + 清该工作区树缓存（重开重取）。计划 C 任务 1：不再是覆盖式单槽——其他驻留工作区
     * 不受影响。与本地工作区的互斥（裁定 E）由 IPC 组合层保证。
     */
    openWorkspace(input: OnlineWorkspaceOpenInput): void {
      const baseUrl = current?.baseUrl ?? null;
      const existing = sessions.get(input.workspaceId);
      if (existing?.baseUrl && existing.baseUrl !== baseUrl) throw new Error("online-workspace-server-conflict");
      sessions.set(input.workspaceId, {
        workspaceState: { id: input.workspaceId, name: input.name, myRole: input.myRole },
        baseUrl,
        treeCache: null,
        treeGeneration: 0,
      });
      activeId = input.workspaceId;
    },

    /**
     * 显式激活驻留工作区（计划 C 任务 1）：纯切活跃指针，不动树缓存。
     * 表中有且已登录才切换；否则抛既有「尚未打开在线工作区」口径错误。
     */
    activateWorkspace(workspaceId: string): void {
      const session = sessions.get(workspaceId);
      if (!current || !session) throw new Error("online-workspace-not-open");
      if (session.baseUrl && session.baseUrl !== current.baseUrl) throw new Error("online-workspace-server-conflict");
      session.baseUrl ??= current.baseUrl;
      activeId = workspaceId;
    },

    /**
     * 关闭在线工作区：无参关活跃、带 id 出表指定工作区。出表后活跃指针若指向被关工作区
     * 则置 null——**不自动切**到其他驻留工作区（切换只由 activateWorkspace 显式驱动，
     * 计划 C 任务 1）。
     */
    closeWorkspace(workspaceId?: string): void {
      const target = workspaceId ?? activeId;
      if (target === null || !sessions.delete(target)) return;
      if (activeId === target) activeId = null;
    },

    /**
     * 在线工作区视图（裁定 A）：首次取服务端 /tree 并缓存（组清单 /groups 同取同缓存——
     * 分组层 groupId→组名反查表，清单失败降级空表：孤儿项目直挂根，树浏览不被阻断），
     * 映射为侧树 TreeNodeDTO，附带项目角色清单（渲染层逐项目只读判定）。
     * workspaceId 与当前工作区不符 → 可读错误。
     */
    async getTreeView(workspaceId: string): Promise<OnlineWorkspaceView> {
      const ws = requireWorkspace(workspaceId);
      const client = requireClient();
      const entry = sessions.get(workspaceId)!; // requireWorkspace 已保证活跃驻留
      const owner = current;
      while (!entry.treeCache) {
        const generation = entry.treeGeneration;
        const tree = await client.getTree(workspaceId);
        const groups = await client.listGroups(workspaceId).catch(() => [] as OnlineGroup[]);
        if (current !== owner || sessions.get(workspaceId) !== entry) throw new Error("online-session-changed");
        if (generation === entry.treeGeneration) entry.treeCache = { tree, groups };
      }
      const groupNames = new Map(entry.treeCache.groups.map((g) => [g.id, g.name]));
      return {
        workspaceId: ws.id,
        name: ws.name,
        myRole: ws.myRole,
        projects: entry.treeCache.tree.projects,
        tree: onlineTreeToDto(entry.treeCache.tree, ws.name, groupNames),
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
      const generation = ++authenticationGeneration;
      // 401 钩子按捕获的 baseUrl 清档（审查重要 1）：不经 current 反查，避免串档。
      const client = deps.createClient(input.baseUrl, { onUnauthorized: () => { if (generation === authenticationGeneration) invalidate(input.baseUrl); } });
      const result = await client.login({ username: input.username, password: input.password });
      if (generation !== authenticationGeneration) throw new Error("online-session-changed");
      deps.tokenStore.save(input.baseUrl, result.token); // 登录 → 按服务器存档（client 已注入，后续请求自动带头）
      current = { baseUrl: input.baseUrl, client, userId: result.user.id };
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
      const generation = ++authenticationGeneration;
      const token = deps.tokenStore.load(baseUrl);
      if (token === null) return { outcome: "signed-out" };
      const client = deps.createClient(baseUrl, { onUnauthorized: () => { if (generation === authenticationGeneration) invalidate(baseUrl); } });
      client.setToken(token);
      try {
        const user = await client.me();
        if (generation !== authenticationGeneration) return { outcome: "signed-out" };
        current = { baseUrl, client, userId: user.id };
        return { outcome: "restored", user };
      } catch {
        // 验活失败（过期/网络/协议）：清档保持登出态（裁定 A 原文语义）。401 路径钩子已按
        // 同一 baseUrl 清过（幂等），此处收口覆盖不经 401 钩子的网络/协议失败路径。
        if (generation === authenticationGeneration) invalidate(baseUrl);
        return { outcome: "signed-out" };
      }
    },

    async logout(): Promise<void> {
      authenticationGeneration++;
      // 计划 C 任务 1：登出清全表（工作区驻留随登录态失效——token 已不可用，缓存无意义）。
      sessions.clear();
      activeId = null;
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
      return requireWorkspaceClient(workspaceId).getTree(workspaceId);
    },

    async getFiles(input: OnlineFilesGetInput): Promise<OnlineFilesResult> {
      // 直通出口（不缓存文件内容——版本号由渲染层编辑缓冲自持，审查次要 5 顺修备案）
      return requireWorkspaceClient(input.workspaceId).getFiles(input.workspaceId, input.paths);
    },

    async putFile(input: OnlineFilePutInput): Promise<OnlinePushOutcome> {
      const { workspaceId, path, content, baseVersion } = input;
      const outcome = await pushOutcome(() => requireWorkspaceClient(workspaceId).putFile(workspaceId, { path, content, baseVersion }));
      // 推送成功使该工作区的树缓存失效（推送后 refreshTreeView 取到新 hash/新文件）；
      // 冲突不动缓存——服务端现状以冲突对象带回。按工作区失效（计划 C 任务 1），不扰其他驻留项。
      if (outcome.outcome === "pushed") {
        const entry = sessions.get(workspaceId);
        if (entry) { entry.treeCache = null; entry.treeGeneration += 1; }
      }
      return outcome;
    },

    async batchPush(input: OnlineFilesBatchInput): Promise<OnlineBatchResult> {
      const { workspaceId, files } = input;
      const result = await requireWorkspaceClient(workspaceId).batchPush(workspaceId, { files });
      // 任一文件推送成功即该工作区树缓存失效（迁移推送后的树刷新必须见到新文件/新 hash）。
      if (result.results.some((r) => r.status === "pushed")) {
        const entry = sessions.get(workspaceId);
        if (entry) { entry.treeCache = null; entry.treeGeneration += 1; }
      }
      return result;
    },

    async deleteFile(input: OnlineFileDeleteInput): Promise<OnlineDeleteOutcome> {
      try {
        await requireWorkspaceClient(input.workspaceId).deleteFile(input.workspaceId, { path: input.path, baseVersion: input.baseVersion });
        const entry = sessions.get(input.workspaceId);
        if (entry) { entry.treeCache = null; entry.treeGeneration += 1; }
        return { outcome: "deleted" };
      } catch (e) {
        if (e instanceof OnlineConflictError) return { outcome: "conflict", conflict: e.conflict };
        throw e;
      }
    },

    /** 迁移映射桥（计划 C 任务 2）：本地名称目录 → 服务端实体（直通出口，行级三态由渲染层换算）。 */
    async projectMapping(input: OnlineProjectMappingInput): Promise<OnlineMappingResult> {
      return requireWorkspaceClient(input.workspaceId).onlineProjectMapping(input.workspaceId, input.entries);
    },

    /** 组织分组只读清单（计划 C 任务 2 迁移拉取：groupId → 组名反查数据源）。 */
    async listGroups(workspaceId: string): Promise<OnlineGroup[]> {
      return requireWorkspaceClient(workspaceId).listGroups(workspaceId);
    },
  };
}

export type OnlineSession = ReturnType<typeof createOnlineSession>;

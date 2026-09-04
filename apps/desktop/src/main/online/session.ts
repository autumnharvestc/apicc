/**
 * online 会话（M3-B 任务 1/2）：登录态串联——login 成功 → token 注入 client（请求自动带头）
 * → tokenStore 按 baseUrl 持久化（任务 2 裁定 A：多服务器凭据并存）；401 会话失效事件 →
 * 清该服务器存档 + 清当前 client。任务 2 裁定 A：resume() 恢复链路——启动（或服务器档案
 * 激活）时 load(baseUrl) 存档 → seed client → GET /me 验活：成功 = 登录态恢复；失败
 * （401/网络错误）= 清档并保持登出态。任务 3 将在此扩展当前在线工作区/树缓存。
 */
import type { OnlineClient } from "./client.js";
import { OnlineConflictError } from "./client.js";
import type { TokenStore } from "./tokenStore.js";
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
} from "../../shared/online/types.js";
import type { OnlineBatchResult, OnlineFilesResult, OnlinePutFileResult, OnlineTree, OnlineUser, OnlineWorkspaceCreated, OnlineWorkspaceSummary } from "../../shared/online/contract.js";

export interface OnlineSessionDeps {
  /** client 工厂：baseUrl 定服务端，hooks.onUnauthorized 挂会话失效清理。 */
  createClient: (baseUrl: string, hooks: { onUnauthorized: () => void }) => OnlineClient;
  tokenStore: TokenStore;
}

export function createOnlineSession(deps: OnlineSessionDeps) {
  let current: { baseUrl: string; client: OnlineClient } | null = null;

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
      return requireClient().getFiles(input.workspaceId, input.paths);
    },

    async putFile(input: OnlineFilePutInput): Promise<OnlinePushOutcome> {
      const { workspaceId, path, content, baseVersion } = input;
      return pushOutcome(() => requireClient().putFile(workspaceId, { path, content, baseVersion }));
    },

    async batchPush(input: OnlineFilesBatchInput): Promise<OnlineBatchResult> {
      const { workspaceId, files } = input;
      return requireClient().batchPush(workspaceId, { files });
    },

    async deleteFile(input: OnlineFileDeleteInput): Promise<OnlineDeleteOutcome> {
      try {
        await requireClient().deleteFile(input.workspaceId, { path: input.path, baseVersion: input.baseVersion });
        return { outcome: "deleted" };
      } catch (e) {
        if (e instanceof OnlineConflictError) return { outcome: "conflict", conflict: e.conflict };
        throw e;
      }
    },
  };
}

export type OnlineSession = ReturnType<typeof createOnlineSession>;

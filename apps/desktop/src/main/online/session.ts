/**
 * online 会话（M3-B 任务 1）：登录态串联——login 成功 → token 注入 client（请求自动带头）
 * → tokenStore 持久化；401 会话失效事件 → 清持久化 + 清当前 client。任务 3 将在此扩展
 * 当前在线工作区/树缓存（规格 §2 D9 onlineStore 的 main 侧对位）。
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

  function invalidate(): void {
    deps.tokenStore.clear();
    current = null;
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
      const client = deps.createClient(input.baseUrl, { onUnauthorized: invalidate });
      const result = await client.login({ username: input.username, password: input.password });
      deps.tokenStore.save(result.token); // 登录 → 存 token（client 已注入，后续请求自动带头）
      current = { baseUrl: input.baseUrl, client };
      return { expiresAt: result.expiresAt, user: result.user }; // token 不出 main 进程
    },

    async logout(): Promise<void> {
      if (!current) return;
      const client = current.client;
      invalidate();
      try {
        await client.logout(); // 吊销失败（网络断等）不阻断本地登出——本地态已清，token 留服务端 30 天自然过期
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

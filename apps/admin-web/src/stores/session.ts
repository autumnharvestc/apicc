/**
 * 会话 store 工厂（M4-A 任务 2，裁定 B）：登录态核心——state `{ token, user, status, error }`
 * （status ∈ idle | authenticating | authenticated）+ login/register/logout/initialize actions。
 * token 持久化 localStorage 键 `apicc.admin.token`（裁定 B/进度账本裁定③）；initialize 于
 * app 启动读档并 GET /me 验活（成功 → authenticated；401/网络错误 → 清档登出态，desktop
 * resume 同语义、全程不抛）。401 拦截钩子由工厂装到 client（setOnUnauthorized）→ 清会话 +
 * onSessionExpired 回调（路由跳转经回调注入，store 不依赖 router，裁定 B）。
 * 语义沿用 desktop 先例：登录失败 → error 上屏且不清旧态；注册不建立登录态（契约语义，
 * 成功返回 true 由视图引导登录）；工厂隔离——每次调用绑定独立 Pinia 实例、storage 可注入
 * （测试传内存替身）。组件内零工厂调用：实例由装配层创建后经路由 props 下传。
 */
import { createPinia, defineStore } from "pinia";
import { AdminApiError, type AdminClient } from "../api/client.js";
import type { AdminRegisterInput, AdminUser } from "../api/contract.js";

/** token 持久化键（裁定 B；与语言偏好 `apicc.admin.locale` 同命名空间）。 */
export const TOKEN_KEY = "apicc.admin.token";

/** 会话状态：idle=未登录；authenticating=登录/验活在途；authenticated=已登录。 */
export type SessionStatus = "idle" | "authenticating" | "authenticated";

export interface SessionStoreDeps {
  client: AdminClient;
  /** 持久化通道；缺省 localStorage（测试注入内存替身隔离，desktop 先例）。 */
  storage?: Storage;
  /** 会话失效（401 拦截/验活失败）后的跳转回调（注入避免 store 依赖 router）。 */
  onSessionExpired?: () => void;
}

/** 统一错误文案出口：AdminApiError.message 即服务端 message，其余取 Error message。 */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createSessionStore(deps: SessionStoreDeps) {
  const client = deps.client;
  const storage = deps.storage ?? localStorage;
  const store = defineStore("admin-session", {
    state: () => ({
      /** 当前会话 token（内存态；持久化在 storage）。 */
      token: undefined as string | undefined,
      /** 登录用户；null = 未登录。 */
      user: null as AdminUser | null,
      status: "idle" as SessionStatus,
      /** api 失败文案（登录/注册共享一条错误通道；组件上屏）。 */
      error: null as string | null,
      /** 提交在途（登录/注册按钮 loading 与防重复提交，desktop 先例）。 */
      submitting: false,
    }),
    getters: {
      /** 已登录判定（守卫与视图统一出口）。 */
      isAuthenticated(state): boolean {
        return state.status === "authenticated" && state.token !== undefined;
      },
    },
    actions: {
      /** 本地会话清空：client 内存 token、storage 存档、state 三处同步。 */
      clearSession(): void {
        client.clearToken();
        storage.removeItem(TOKEN_KEY);
        this.token = undefined;
        this.user = null;
        this.status = "idle";
      },

      /** 会话失效（401 拦截钩子入口）：清会话 + 通知外层跳转（幂等）。 */
      handleUnauthorized(): void {
        this.clearSession();
        deps.onSessionExpired?.();
      },

      /**
       * 启动验活（resume）：读档 → seed client → GET /me。成功恢复 authenticated；
       * 无存档直接登出态；失败（401/网络/协议）清档保持登出态、不抛（desktop resume 同）。
       * 401 已由 client 钩子触发会话失效回调（恰好一次）；网络/协议失败不经钩子，此处补调
       * （任务 2 审查重要 1 顺修：守卫非响应式，验活失败须把用户送回登录页，否则滞留受保护页）。
       */
      async initialize(): Promise<void> {
        const saved = storage.getItem(TOKEN_KEY);
        if (saved === null) return;
        this.token = saved;
        client.setToken(saved);
        this.status = "authenticating";
        try {
          this.user = await client.me();
          this.status = "authenticated";
          this.error = null;
        } catch (e) {
          this.clearSession();
          if (!(e instanceof AdminApiError && e.status === 401)) deps.onSessionExpired?.();
        }
      },

      /** 登录：成功 → token 入 localStorage + user 态；失败 → error 上屏且不清旧态。 */
      async login(input: { username: string; password: string }): Promise<void> {
        if (this.submitting) return; // 防重复提交（desktop 先例）
        const previousStatus = this.status === "authenticating" ? "idle" : this.status;
        this.status = "authenticating";
        this.submitting = true;
        this.error = null;
        try {
          const result = await client.login(input); // client 内部已持 token，后续请求自动带头
          this.token = result.token;
          storage.setItem(TOKEN_KEY, result.token);
          this.user = result.user;
          this.status = "authenticated";
        } catch (e) {
          this.error = errorMessage(e);
          this.status = previousStatus; // 失败不清旧态：有旧会话回到 authenticated，否则 idle
        } finally {
          this.submitting = false;
        }
      },

      /**
       * 注册（不建立登录态，契约语义 desktop 同）：成功返回 true（视图提示并引导登录）；
       * 失败返回 false + error 上屏。client 契约校验为第二道防线（视图本地校验先行，裁定 D）。
       */
      async register(input: AdminRegisterInput): Promise<boolean> {
        if (this.submitting) return false;
        this.submitting = true;
        this.error = null;
        try {
          await client.register(input);
          return true;
        } catch (e) {
          this.error = errorMessage(e);
          return false;
        } finally {
          this.submitting = false;
        }
      },

      /**
       * 登出：先吊销服务端（client.logout 内 204 后自清 client token），失败不阻断——
       * 本地登出照常完成（token 留服务端 30 天自然过期，desktop 同语义）；随后清本地三处。
       */
      async logout(): Promise<void> {
        if (this.token !== undefined) {
          try {
            await client.logout();
          } catch (e) {
            console.warn(`管理端登出请求失败（本地登录态仍将清除）: ${errorMessage(e)}`);
          }
        }
        this.clearSession();
      },
    },
  })(createPinia());

  // 401 拦截钩子接线（裁定 B）：client 401（带 token）→ 清会话 + 外层跳转回调。
  client.setOnUnauthorized(() => store.handleUnauthorized());
  return store;
}

export type SessionStore = ReturnType<typeof createSessionStore>;

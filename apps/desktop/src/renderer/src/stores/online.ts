import { createPinia, defineStore } from "pinia";
import { OnlineBaseUrlSchema } from "../../../shared/online/contract.js";
import type { OnlineServerProfile, OnlineUser, OnlineWorkspaceSummary } from "../../../shared/online/types.js";
import type { ApiccApi } from "../../../shared/types.js";

/**
 * 服务器档案存储键（任务 2 裁定 C）：与既有偏好存储同一先例（renderer localStorage——
 * theme `apicc.theme` / 语言 `apicc.locale`）。档案是**非敏感**配置（url + 昵称；token
 * 留在 main 进程 tokenStore 安全存储），无需加密；选 localStorage 使档案随渲染层偏好
 * 同生命周期，且组件测试（jsdom）可直接注入内存 Storage 替身隔离。
 */
export const STORAGE_KEY = "apicc.onlineServers";

/** localStorage 持久化形状：档案列表 + 上次激活的服务器（重启恢复登录态的目标）。 */
export interface PersistedOnlineServers { active: string | null; servers: OnlineServerProfile[] }

/** 读档案（形状守卫：非 JSON/缺字段/类型不符 → 空白 + warn，不抛——损坏配置引导重新配置）。 */
export function readPersisted(storage: Storage): PersistedOnlineServers {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) return { active: null, servers: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn(`在线服务器档案存储损坏，已忽略: ${e instanceof Error ? e.message : String(e)}`);
    return { active: null, servers: [] };
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as PersistedOnlineServers).servers)) {
    console.warn("在线服务器档案存储形状不符，已忽略（请重新配置服务器）");
    return { active: null, servers: [] };
  }
  const servers = (parsed as PersistedOnlineServers).servers.filter(
    (s): s is OnlineServerProfile => typeof s === "object" && s !== null && typeof s.baseUrl === "string" && typeof s.name === "string",
  );
  const active = (parsed as PersistedOnlineServers).active;
  // active 必须指向存在的档案，否则复位（悬空激活位无意义）
  return { active: servers.some((s) => s.baseUrl === active) ? active : null, servers };
}

function writePersisted(storage: Storage, state: PersistedOnlineServers): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/**
 * 在线 store 工厂（M3-B 任务 2）：服务器档案（增删改 + localStorage 持久化）+ 登录态 +
 * 登录/注册/登出 + init/resume 恢复链路（裁定 A）。接受依赖注入（api + storage，测试传
 * 新实例即天然隔离）；每次工厂调用绑定独立 Pinia 实例。组件内零工厂调用：实例由 App
 * 组合根创建后经 props 下传（TopBar/OnlineLoginDialog）。
 *
 * 状态契约：登录失败 → error 上屏且**不清旧登录态**（plan 任务 2 步骤 1③）；登出只清
 * 登录态，服务器档案保留（裁定 C：档案与登录态分离）；档案激活（新增/切换）即对目标
 * 服务器 resume（裁定 A），恢复成功静默进入登录态、失败保持登出态。
 */
export function createOnlineStore(deps: { api: ApiccApi; storage?: Storage }) {
  const api = deps.api;
  const storage = deps.storage ?? localStorage;
  return defineStore("online", {
    state: () => ({
      /** 服务器档案（url + 昵称，多档案并存）。 */
      profiles: [] as OnlineServerProfile[],
      /** 当前激活（登录/恢复的目标）服务器；null = 未选。 */
      activeBaseUrl: null as string | null,
      /** 登录用户（登录态核心）；null = 未登录。 */
      user: null as OnlineUser | null,
      /** 登录结果的服务端过期时间（ISO）；resume 恢复时无存档字段，保持空串。 */
      expiresAt: "",
      loggedIn: false,
      /** resume 验活在途（启动/切档案时 UI 可指示）。 */
      restoring: false,
      /** 提交在途（登录/注册按钮 loading 与防重复提交）。 */
      submitting: false,
      /** api 失败文案（登录/注册/登出/恢复共享一条错误通道；组件上屏）。 */
      error: null as string | null,
      /** 在线工作区列表（refreshWorkspaces 产出；列表 UI 归任务 3）。 */
      workspaces: [] as OnlineWorkspaceSummary[],
      /** 登录/配置对话框显隐（TopBar 打开、对话框关闭双向读写）。 */
      dialogOpen: false,
    }),
    getters: {
      /** 激活档案显示名：昵称为空回退 baseUrl（顶栏/对话框统一出口）。 */
      activeName(state): string {
        const profile = state.profiles.find((p) => p.baseUrl === state.activeBaseUrl);
        if (!profile) return state.activeBaseUrl ?? "";
        return profile.name || profile.baseUrl;
      },
    },
    actions: {
      persistProfiles(): void {
        writePersisted(storage, { active: this.activeBaseUrl, servers: this.profiles.map((p) => ({ ...p })) });
      },

      /** 本地登录态清空（不动档案）。 */
      clearLoginState(): void {
        this.user = null;
        this.expiresAt = "";
        this.loggedIn = false;
      },

      /**
       * 启动装配（App 组合根 onMounted 调用，void 之）：载入档案并对激活档案尝试恢复
       * 登录态。全程不抛（存储损坏降级空白、resume 失败返回登出态）。
       */
      async init(): Promise<void> {
        const persisted = readPersisted(storage);
        this.profiles = persisted.servers;
        this.activeBaseUrl = persisted.active;
        if (this.activeBaseUrl) await this.resume(this.activeBaseUrl);
      },

      /**
       * 恢复登录态（裁定 A 渲染侧入口）：对指定服务器验活存档 token。restored → 静默
       * 进入登录态；signed-out（无存档/验活失败，main 侧已清档）→ 保持登出态；仅替身
       * 层面异常（不抛的契约被破坏时）记入 error，不崩。
       */
      async resume(baseUrl: string): Promise<void> {
        this.restoring = true;
        try {
          const out = await api.onlineResume({ baseUrl });
          if (out.outcome === "restored") {
            this.user = out.user;
            this.loggedIn = true;
            this.error = null;
          } else {
            this.clearLoginState();
          }
        } catch (e) {
          this.error = e instanceof Error ? e.message : String(e);
        } finally {
          this.restoring = false;
        }
      },

      /**
       * 新增或更新档案（同 baseUrl = 改昵称）并激活；url 形态 store 侧再守一次。
       * 换目标（含首次保存）与 setActive 同口径（审查重要 2）：清旧登录态（防止旧服务器的
       * user 以新档案名呈现的假登录态）并对新目标 resume 验活；同 baseUrl 改昵称不动登录态。
       */
      addProfile(baseUrl: string, name: string): boolean {
        const parsed = OnlineBaseUrlSchema.safeParse(baseUrl.trim());
        if (!parsed.success) return false;
        const url = parsed.data;
        const switched = this.activeBaseUrl !== url;
        const existing = this.profiles.find((p) => p.baseUrl === url);
        if (existing) existing.name = name.trim();
        else this.profiles.push({ baseUrl: url, name: name.trim() });
        this.activeBaseUrl = url;
        this.persistProfiles();
        if (switched) {
          this.clearLoginState();
          void this.resume(url);
        }
        return true;
      },

      /**
       * 删除档案；若删除的是当前登录目标：尽力吊销服务端 token + 清本地登录态（档案与
       * 登录态分离的反向操作）。吊销失败静默（网络断时本地态已清，token 30 天自然过期）。
       */
      removeProfile(baseUrl: string): void {
        const index = this.profiles.findIndex((p) => p.baseUrl === baseUrl);
        if (index < 0) return;
        this.profiles.splice(index, 1);
        if (this.activeBaseUrl === baseUrl) {
          this.activeBaseUrl = null;
          if (this.loggedIn) {
            api.onlineLogout().catch(() => undefined);
          }
          this.clearLoginState();
        }
        this.persistProfiles();
      },

      /** 切换激活档案：先清本地登录态（旧服务器的登录展示不得挂在目标服务器上），再 resume。 */
      setActive(baseUrl: string): void {
        if (!this.profiles.some((p) => p.baseUrl === baseUrl)) return;
        this.activeBaseUrl = baseUrl;
        this.clearLoginState();
        this.persistProfiles();
        void this.resume(baseUrl);
      },

      /** 登录（目标 = 激活档案）：成功 → 登录态上屏；失败 → error 且不清旧态。 */
      async login(username: string, password: string): Promise<void> {
        const baseUrl = this.activeBaseUrl;
        if (!baseUrl || this.submitting) return;
        this.submitting = true;
        this.error = null;
        try {
          const out = await api.onlineLogin({ baseUrl, username, password });
          this.user = out.user;
          this.expiresAt = out.expiresAt;
          this.loggedIn = true;
        } catch (e) {
          this.error = e instanceof Error ? e.message : String(e);
        } finally {
          this.submitting = false;
        }
      },

      /** 注册（不建立登录态）：成功返回 true（组件提示后引导登录）；失败返回 false + error。 */
      async register(input: { username: string; password: string; displayName: string }): Promise<boolean> {
        const baseUrl = this.activeBaseUrl;
        if (!baseUrl || this.submitting) return false;
        this.submitting = true;
        this.error = null;
        try {
          await api.onlineRegister({ baseUrl, ...input });
          return true;
        } catch (e) {
          this.error = e instanceof Error ? e.message : String(e);
          return false;
        } finally {
          this.submitting = false;
        }
      },

      /** 登出：吊销服务端 token（失败记入 error 不阻断）+ 清本地登录态；档案保留（裁定 C）。 */
      async logout(): Promise<void> {
        try {
          await api.onlineLogout();
        } catch (e) {
          this.error = e instanceof Error ? e.message : String(e);
        }
        this.clearLoginState();
      },

      /** 在线工作区列表拉取（本任务只备 store 状态与动作，列表 UI 与错误呈现归任务 3）。 */
      async refreshWorkspaces(): Promise<void> {
        this.workspaces = await api.onlineWorkspaceList();
      },
    },
  })(createPinia());
}

export type OnlineStore = ReturnType<typeof createOnlineStore>;

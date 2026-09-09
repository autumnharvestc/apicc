import { createPinia, defineStore } from "pinia";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
// core 主入口含 native 索引面（better-sqlite3）——渲染层沙箱求值即崩（白屏，2026-09-06 用户报告）。
// 纯 schema 一律走 ./schema 子路径（依赖闭包仅 zod）。
import { ApiDefinitionSchema } from "@apicc/core/schema";
import type { ApiDefinition } from "@apicc/core";
import { OnlineBaseUrlSchema, type OnlineRole, type OnlineTreeProject, type OnlineUser, type OnlineVersionConflict, type OnlineWorkspaceSummary } from "../../../shared/online/contract.js";
import { chunk, planPull, planPush, restoreLocalPaths, toEntityPath, type LocalFileRow, type ProjectDirRef } from "../../../shared/online/migrate.js";
import type { OnlineGroup } from "../../../shared/online/contract.js";
import type { TreeNodeDTO } from "../../../shared/tree-dto.js";
import type { MigrationResult, OnlineServerProfile } from "../../../shared/online/types.js";
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
 * 在线编辑缓冲（计划 C 任务 2 会话表化 → 任务 4 按 editorPath 表化）：随工作区会话驻留
 * 且按文件路径多槽并存——同工作区双项目（乃至同项目多接口）草稿互不污染（任务 3 重要 1
 * 裁定的核心验收），切接口/切项目签零丢失零确认（计划全局不变量 2）。字段与旧单槽扁平态
 * 一一对应（裁定 B：仅 api.yaml 级编辑 + 只读文件原文浏览）。
 */
export interface OnlineEditorBuffer {
  path: string | null;
  kind: "api" | "file" | null;
  api: ApiDefinition | null;
  raw: string;
  problems: string[];
  version: number;
  snapshot: string;
  loading: boolean;
}

function emptyBuffer(): OnlineEditorBuffer {
  return { path: null, kind: null, api: null, raw: "", problems: [], version: 0, snapshot: "", loading: false };
}

/** 在线工作区驻留会话（计划 C 任务 2，与 main online session 同构）：工作区态 + 树视图 +
 *  项目角色清单 + 编辑缓冲表（key = editorPath 实体路径；活跃指针 activeEditorPath）。 */
export interface OnlineSession {
  workspace: { id: string; name: string; myRole: OnlineRole };
  tree: TreeNodeDTO | null;
  projects: OnlineTreeProject[];
  buffers: Record<string, OnlineEditorBuffer>;
  activeEditorPath: string | null;
}

/** 活跃驻留会话定位（getter/action 共用的表语义中枢）；无活跃指针 → null。 */
function activeSessionOf(state: { sessions: Record<string, OnlineSession>; activeWorkspaceId: string | null }): OnlineSession | null {
  return state.activeWorkspaceId !== null ? state.sessions[state.activeWorkspaceId] ?? null : null;
}

/** 活跃编辑缓冲定位（任务 4 表语义中枢）：活跃会话的活跃路径槽；无会话/无活跃路径 → null。 */
function activeBufferOf(state: { sessions: Record<string, OnlineSession>; activeWorkspaceId: string | null }): OnlineEditorBuffer | null {
  const session = activeSessionOf(state);
  if (!session || session.activeEditorPath === null) return null;
  return session.buffers[session.activeEditorPath] ?? null;
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

      // —— 任务 3：在线工作区浏览/编辑/迁移（裁定 A–E）；计划 C 任务 2 会话表化 ——
      /** 驻留在线工作区会话表（key = workspaceId）：本地 1 + 在线 N 并存驻留（裁定 E 互斥退役）。 */
      sessions: {} as Record<string, OnlineSession>,
      /** 活跃在线工作区 id；null = 无活跃（在线树/编辑面走本地上下文）。切换只由 activateWorkspace 显式驱动。 */
      activeWorkspaceId: null as string | null,
      /** 保存与冲突（裁定 C：409 → conflict 状态驱动冲突对话框）。 */
      saving: false,
      conflict: null as OnlineVersionConflict | null,
      /** 迁移（裁定 D）：单活动护栏 + 分批进度 + 结果清单。 */
      migrating: false,
      migrationProgress: "",
      migrationResult: null as MigrationResult | null,
      migrateDialogOpen: false,
    }),
    getters: {
      /** 激活档案显示名：昵称为空回退 baseUrl（顶栏/对话框统一出口）。 */
      activeName(state): string {
        const profile = state.profiles.find((p) => p.baseUrl === state.activeBaseUrl);
        if (!profile) return state.activeBaseUrl ?? "";
        return profile.name || profile.baseUrl;
      },

      /**
       * 兼容面（计划 C 任务 2：TopBar/视图层零改动）：以下扁平 getter 全部转发活跃驻留
       * 会话的**活跃路径槽**（任务 4 缓冲表化）——activeWorkspace/onlineTree/projects
       * （工作区上下文）与编辑缓冲八字段（editorPath/editorKind/editorApi/editorRaw/
       * editorProblems/editorVersion/editorSnapshot/editorLoading）。无活跃会话/无活跃
       * 路径时回落到旧单槽「空态」形状。
       */
      activeWorkspace(state): OnlineSession["workspace"] | null {
        return activeSessionOf(state)?.workspace ?? null;
      },
      onlineTree(state): TreeNodeDTO | null {
        return activeSessionOf(state)?.tree ?? null;
      },
      projects(state): OnlineTreeProject[] {
        return activeSessionOf(state)?.projects ?? [];
      },
      editorPath(state): string | null {
        return activeBufferOf(state)?.path ?? null;
      },
      editorKind(state): "api" | "file" | null {
        return activeBufferOf(state)?.kind ?? null;
      },
      editorApi(state): ApiDefinition | null {
        return activeBufferOf(state)?.api ?? null;
      },
      editorRaw(state): string {
        return activeBufferOf(state)?.raw ?? "";
      },
      editorProblems(state): string[] {
        return activeBufferOf(state)?.problems ?? [];
      },
      editorVersion(state): number {
        return activeBufferOf(state)?.version ?? 0;
      },
      editorSnapshot(state): string {
        return activeBufferOf(state)?.snapshot ?? "";
      },
      editorLoading(state): boolean {
        return activeBufferOf(state)?.loading ?? false;
      },

      /**
       * 在线编辑缓冲 dirty（快照比对，先例同本地 editor store）——按活跃会话活跃槽判定。
       */
      editorDirty(state): boolean {
        const buffer = activeBufferOf(state);
        return buffer !== null && buffer.api !== null && JSON.stringify(buffer.api) !== buffer.snapshot;
      },

      /**
       * 可写判定（裁定 B：VIEWER 只读 vs EDITOR 可编辑）：工作区 VIEWER 恒只读；
       * 项目级 ACL 覆盖按 path 首段项目 id 定位文件所属项目（path 实体化修订 2026-09-08：
       * 内容 path = `<projectId>/...`，服务端不再回 projects[].path 目录路径）；
       * VIEWER/NONE 时该项目子树只读；工作区配置叶（根级 apicc.workspace.yaml）对齐
       * 服务端 ADMIN+ 守卫（计划 C 任务 4 / B-任务 7 遗留④）：仅 ADMIN/OWNER 可编辑，
       * 否则 EDITOR 编辑推送必中途 403。按活跃会话的工作区角色与项目清单判定。
       */
      canEdit(state): (path: string | null) => boolean {
        return (path: string | null): boolean => {
          const session = activeSessionOf(state);
          if (!session || session.workspace.myRole === "VIEWER" || !path) return false;
          if (path === "apicc.workspace.yaml") {
            return session.workspace.myRole === "ADMIN" || session.workspace.myRole === "OWNER";
          }
          const project = session.projects.find((p) => path === p.id || path.startsWith(`${p.id}/`));
          if (project) return project.myRole !== "VIEWER" && project.myRole !== "NONE";
          return true;
        };
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

      /**
       * 登出：吊销服务端 token（失败记入 error 不阻断）+ 清本地登录态；档案保留（裁定 C）。
       * 驻留会话全清（计划 C 任务 2：main 侧 online:logout 清会话全表，本地随动全清——
       * 不再逐会话 closeWorkspace，出表即弃各会话编辑缓冲）。
       */
      async logout(): Promise<void> {
        try {
          await api.onlineLogout();
        } catch (e) {
          this.error = e instanceof Error ? e.message : String(e);
        }
        this.sessions = {};
        this.activeWorkspaceId = null;
        this.conflict = null;
        this.migrationResult = null;
        this.migrationProgress = "";
        this.clearLoginState();
      },

      /** 在线工作区列表拉取：失败经 error 通道呈现（列表 UI 保留旧清单）。 */
      async refreshWorkspaces(): Promise<void> {
        try {
          this.workspaces = await api.onlineWorkspaceList();
          this.error = null;
        } catch (e) {
          this.error = e instanceof Error ? e.message : String(e);
        }
      },

      // —— 任务 3：在线工作区浏览/编辑/迁移（裁定 A–E）；计划 C 任务 2 会话表化 ——

      /**
       * 显式清场（任务 4 范围控制保留）：清空活跃会话的**整张**缓冲表 + 活跃指针。
       * selectNode 不再调用它（切接口/选容器只切活跃指针，草稿驻留）；工作区级清场由
       * closeWorkspace/logout 出表释放缓冲表，本动作保留给显式丢弃语义。
       */
      clearEditor(): void {
        const session = activeSessionOf(this);
        if (!session) return;
        session.buffers = {};
        session.activeEditorPath = null;
      },

      /**
       * 打开在线工作区（裁定 A；计划 C 任务 2 表语义）：入表不覆盖——已驻留工作区刷新
       * 树/项目角色并**保留其编辑缓冲表**（任务 4：草稿随会话驻留），其他驻留工作区不受
       * 影响；成功后活跃指针切到该工作区。失败 error 上屏且不入表；若 main 侧活跃指针
       * 已被失败的 open 移走（表非空不回滚，任务 1 口径），显式 activate 归还原活跃——
       * 失败不抢活跃。
       */
      async openWorkspace(ws: OnlineWorkspaceSummary): Promise<void> {
        this.error = null;
        const previousActiveId = this.activeWorkspaceId;
        try {
          const view = await api.onlineWorkspaceOpen({ workspaceId: ws.id, name: ws.name, myRole: ws.myRole });
          const existing = this.sessions[ws.id];
          this.sessions[ws.id] = {
            workspace: { id: ws.id, name: ws.name, myRole: ws.myRole },
            tree: view.tree,
            projects: view.projects,
            buffers: existing?.buffers ?? {},
            activeEditorPath: existing?.activeEditorPath ?? null,
          };
          this.activeWorkspaceId = ws.id;
          this.conflict = null;
          this.migrationResult = null;
        } catch (e) {
          this.error = e instanceof Error ? e.message : String(e);
          if (previousActiveId !== null && previousActiveId !== ws.id) {
            await api.onlineWorkspaceActivate(previousActiveId).catch(() => undefined);
          }
        }
      },

      /**
       * 显式激活驻留工作区（计划 C 任务 2）：调 IPC activate（main 切活跃指针）成功后
       * 本地指针随动——树/项目/编辑缓冲经兼容面自动换挡。未驻留/未登录：error 上屏且
       * 不切换（失败不抢活跃；任务 3 tabs 激活编排据此标记离线签）。
       */
      async activateWorkspace(workspaceId: string): Promise<void> {
        this.error = null;
        try {
          await api.onlineWorkspaceActivate(workspaceId);
          this.activeWorkspaceId = workspaceId;
          this.conflict = null; // 编辑上下文换挡：跨工作区冲突态不残留
        } catch (e) {
          this.error = e instanceof Error ? e.message : String(e);
        }
      },

      /**
       * 关闭在线工作区（裁定 E 会话清理）：main 会话出表（带 id 关指定驻留工作区、无参
       * 关活跃）+ 本地出表并弃其编辑缓冲；活跃指针指向被关工作区时置 null（不自动切其他
       * 驻留，切换只由 activateWorkspace 显式驱动）。IPC 失败照常清本地（容错收口）。
       * 仅关的是活跃工作区时复位冲突/迁移展示态（非活跃出表不抢全局 UI 态）。
       */
      async closeWorkspace(workspaceId?: string): Promise<void> {
        try {
          await api.onlineWorkspaceClose(workspaceId !== undefined ? { workspaceId } : undefined);
        } catch {
          // main 侧已无会话（或在线未配置）——本地照常清理，不阻断退出
        }
        const target = workspaceId ?? this.activeWorkspaceId;
        if (target === null) return;
        delete this.sessions[target];
        if (this.activeWorkspaceId === target) {
          this.activeWorkspaceId = null;
          this.conflict = null;
          this.migrationResult = null;
          this.migrationProgress = "";
        }
      },

      /** 刷新活跃工作区树视图（推送/迁移后调用；main 侧内容变更（put/batch/delete 成功）已使树缓存失效，此处取到的是新树）。 */
      async refreshTreeView(): Promise<void> {
        const workspaceId = this.activeWorkspaceId;
        if (workspaceId === null) return;
        try {
          const view = await api.onlineTreeView(workspaceId);
          const session = this.sessions[workspaceId];
          if (!session) return; // 刷新在途会话已被关：丢弃迟到视图
          session.tree = view.tree;
          session.projects = view.projects;
        } catch (e) {
          this.error = e instanceof Error ? e.message : String(e);
        }
      },

      /**
       * 在线侧树选中（App.onSelect 的在线分支 / tabs 激活编排的项目选中，任务 4 表语义）：
       * api/file → 已驻留路径仅切活跃指针（草稿零扰动，不重拉——重拉会以服务端内容覆盖
       * 草稿；强制重取走 conflictPullOverwrite 的 force 分支），未驻留路径建槽拉取；
       * 容器节点（project 等）→ 活跃指针置空（编辑区空白，旧清场 UX 保留）但缓冲表驻留
       * （切项目签草稿零丢失）。坏数据进 problems 展示原文，禁崩。拉取失败/文件缺失不驻留
       * 空槽（重试可重拉）。
       */
      async selectNode(kind: TreeNodeDTO["kind"], id: string, opts?: { force?: boolean }): Promise<void> {
        const wsId = this.activeWorkspaceId;
        if (wsId === null || (kind !== "api" && kind !== "file")) {
          const pending = wsId !== null ? this.sessions[wsId] : undefined;
          if (pending) pending.activeEditorPath = null;
          return;
        }
        const session = this.sessions[wsId];
        if (!session) return;
        const existing = session.buffers[id];
        if (existing && existing.path !== null && !opts?.force) {
          session.activeEditorPath = id; // 已驻留：仅切指针
          return;
        }
        const slot = existing ?? emptyBuffer();
        session.buffers[id] = slot;
        session.activeEditorPath = id;
        slot.loading = true;
        this.error = null;
        try {
          const result = await api.onlineFilesGet({ workspaceId: wsId, paths: [id] });
          const file = result.files[0];
          if (!file) {
            if (slot.path === null) {
              // 全新空槽即弃：避免「空槽短路」让重试永远拉不到内容
              delete session.buffers[id];
              if (session.activeEditorPath === id) session.activeEditorPath = null;
            }
            this.error = `文件不在可见清单中: ${id}`;
            return;
          }
          slot.path = file.path;
          slot.version = file.version;
          slot.raw = file.content;
          if (kind === "file") {
            slot.kind = "file";
            slot.api = null;
            slot.problems = [];
            slot.snapshot = "";
            return;
          }
          slot.kind = "api";
          try {
            const parsed = ApiDefinitionSchema.safeParse(parseYaml(file.content));
            if (parsed.success) {
              slot.api = parsed.data;
              slot.problems = [];
              slot.snapshot = JSON.stringify(parsed.data);
            } else {
              slot.api = null;
              slot.snapshot = "";
              slot.problems = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
            }
          } catch (e) {
            // YAML 语法坏损：同走 problems（不崩，原文可读）
            slot.api = null;
            slot.snapshot = "";
            slot.problems = [e instanceof Error ? e.message : String(e)];
          }
        } catch (e) {
          this.error = e instanceof Error ? e.message : String(e);
          if (slot.path === null) {
            delete session.buffers[id];
            if (session.activeEditorPath === id) session.activeEditorPath = null;
          }
        } finally {
          slot.loading = false;
        }
      },

      /**
       * 保存在线接口定义（裁定 B）：序列化回 YAML 文本 putFile（baseVersion=当前 version）；
       * 成功 → 版本前移 + 快照复位；409 → conflict 入 store（冲突对话框由组合根渲染）。
       * 写活跃会话的活跃路径槽（计划 C 任务 4）。
       */
      async saveApi(): Promise<void> {
        const wsId = this.activeWorkspaceId;
        const session = wsId !== null ? this.sessions[wsId] : undefined;
        const buffer = session && session.activeEditorPath !== null ? session.buffers[session.activeEditorPath] : undefined;
        if (wsId === null || !session || !buffer || this.saving) return;
        const apiDef = buffer.api;
        const path = buffer.path;
        if (!apiDef || !path || !this.canEdit(path)) return;
        this.saving = true;
        this.error = null;
        try {
          const content = stringifyYaml(JSON.parse(JSON.stringify(apiDef)) as Record<string, unknown>);
          const outcome = await api.onlineFilePut({
            workspaceId: wsId,
            path,
            content,
            baseVersion: buffer.version,
          });
          if (outcome.outcome === "pushed") {
            buffer.version = outcome.result.version;
            buffer.snapshot = JSON.stringify(apiDef);
          } else {
            this.conflict = outcome.conflict;
          }
        } catch (e) {
          this.error = e instanceof Error ? e.message : String(e);
        } finally {
          this.saving = false;
        }
      },

      /** 冲突-放弃（裁定 C）：清冲突态，本地编辑缓冲保留（可继续改或手动放弃）。 */
      conflictDiscard(): void {
        this.conflict = null;
      },

      /** 冲突-拉取覆盖我的（裁定 C）：丢弃本地编辑（对话框选择即确认），强制重取服务端最新并重新渲染（force 绕过已驻留短路）。 */
      async conflictPullOverwrite(): Promise<void> {
        if (!this.conflict || this.activeWorkspaceId === null || !this.editorPath) return;
        const path = this.editorPath;
        const kind = this.editorKind ?? "api";
        this.conflict = null;
        await this.selectNode(kind, path, { force: true });
      },

      /**
       * 关签驱逐（计划 C 任务 4，不变量 3：关签=项目关闭）：按 `<projectId>/` 前缀驱逐
       * 指定驻留工作区缓冲表的该项目槽；根级配置叶（apicc.workspace.yaml）无项目前缀不受
       * 牵连；活跃槽被逐则指针复位 null。指定会话不存在时 no-op。
       */
      evictProjectBuffers(workspaceId: string, projectId: string): void {
        const session = this.sessions[workspaceId];
        if (!session) return;
        const prefix = `${projectId}/`;
        for (const path of Object.keys(session.buffers)) {
          if (path.startsWith(prefix)) delete session.buffers[path];
        }
        if (session.activeEditorPath !== null && session.buffers[session.activeEditorPath] === undefined) {
          session.activeEditorPath = null;
        }
      },

      /**
       * 迁移-拉取到本地目录（裁定 D + 计划 C 任务 2 映射桥）：getTree（实体寻址）+ groups
       * 清单（groupId → 组名反查）→ `<projectId>/...` 还原本地名称树路径（项目名取
       * tree.projects；孤儿 projectId 退化为实体路径原样落盘并在明细注记；同组同名项目碰撞
       * ——两个实体还原同一条本地路径——后行者计 failed + 冲突注记，不进取数/落盘清单，保
       * 先行者）→ 本地扫描 hash 比对（同 hash 跳过）→ 分批（≤200）按实体路径取内容 → 按
       * 本地名称路径落盘 → 结果清单（明细 path 统一本地名称形态）。单活动护栏：进行中二次
       * 调用直接返回。
       */
      async migratePull(dir: string): Promise<void> {
        if (this.migrating || this.activeWorkspaceId === null) return;
        this.migrating = true;
        this.migrationResult = null;
        this.migrationProgress = "";
        this.error = null;
        try {
          const workspaceId = this.activeWorkspaceId;
          const [scan, tree, groups] = await Promise.all([
            api.onlineMigrateScan(dir),
            api.onlineTreeGet(workspaceId),
            api.onlineGroupsList(workspaceId),
          ]);
          // 实体路径 → 本地名称路径还原（项目名=tree.projects、组名=groups 清单；双向对照表
          // 同时服务取数（本地→实体）与取回内容落盘行（实体→本地）的路径换算）。
          // 同名碰撞行（conflict，后行者）不进任何对照表与取数清单——否则对照表后行覆盖先行，
          // 两行取数都指到同一实体（先行者内容取不回）且同路径落盘后写覆盖先写（审查发现 1）
          const rows = restoreLocalPaths(tree.files, tree.projects, new Map(groups.map((g: OnlineGroup) => [g.id, g.name])));
          const usable = rows.filter((r) => !r.conflict);
          const entityByLocal = new Map(usable.map((r) => [r.localPath, r.serverPath]));
          const localByEntity = new Map(usable.map((r) => [r.serverPath, r.localPath]));
          const orphanLocals = new Set(usable.filter((r) => r.orphan).map((r) => r.localPath));
          // 树行与还原行按序一一对应，冲突行从比对/取数面整体剔除（明细单独计 failed）
          const restored = tree.files
            .filter((_, i) => !rows[i]!.conflict)
            .map((file) => ({ ...file, path: localByEntity.get(file.path) ?? file.path }));
          const plan = planPull(restored, scan.files);
          const contents: Array<{ path: string; content: string }> = [];
          let done = 0;
          for (const batch of chunk(plan.toFetch, 200)) {
            const result = await api.onlineFilesGet({ workspaceId, paths: batch.map((p) => entityByLocal.get(p) ?? p) });
            for (const file of result.files) contents.push({ path: localByEntity.get(file.path) ?? file.path, content: file.content });
            this.migrationProgress = `${(done += batch.length)}/${plan.toFetch.length}`;
          }
          const written: string[] = [];
          for (const batch of chunk(contents, 200)) {
            written.push(...(await api.onlineMigrateWrite({ dir, files: batch })).written);
          }
          // 取数批内 missing（权限恰变/文件刚删）按 failed 计，不入落盘清单；
          // 孤儿退化行（按实体路径原样落盘）在明细注记
          const writtenSet = new Set(written);
          const details = plan.details.map((d): MigrationResult["details"][number] => {
            if (d.action === "skipped" || writtenSet.has(d.path)) {
              return orphanLocals.has(d.path)
                ? { ...d, note: `分组/项目名不可得，按服务端实体路径落盘: ${entityByLocal.get(d.path) ?? d.path}` }
                : d;
            }
            return { path: d.path, action: "failed" as const };
          });
          // 同名项目冲突明细（审查发现 1）：后行者计 failed 并注明冲突路径（不计入落盘）
          for (const row of rows) {
            if (row.conflict) details.push({ path: row.localPath, action: "failed", note: `同名项目冲突，路径 ${row.localPath}` });
          }
          this.migrationResult = {
            direction: "pull",
            pulled: details.filter((d) => d.action === "pulled").length,
            updated: details.filter((d) => d.action === "updated").length,
            skipped: details.filter((d) => d.action === "skipped").length,
            pushed: 0,
            conflicts: 0,
            failed: details.filter((d) => d.action === "failed").length,
            details,
          };
        } catch (e) {
          this.error = e instanceof Error ? e.message : String(e);
        } finally {
          this.migrating = false;
          this.migrationProgress = "";
        }
      },

      /**
       * 迁移-推送本地目录（裁定 D + 计划 C 任务 2 映射桥）：本地扫描（名称树）→ 提取去重
       * 项目目录清单 → 映射端点（createIfMissing=true 按需建，≤200/批）→ 项目内文件路径
       * 换算 `<projectId>/<项目内相对路径>`（服务端实体寻址）→ 与服务端 tree 比对（新文件
       * baseVersion=0、变更带服务端 version、同 hash 跳过——从不盲目覆盖）→ 分批 batch →
       * 结果清单。根级文件（projectDir=null，如 apicc.workspace.yaml）不过映射、原路径直推；
       * 映射行 missing/forbidden（缺失/无权建）→ 该项目全部文件计 failed（明细 path 统一
       * 本地名称路径——用户可读，服务端实体路径不出 UI）。编排不缓存跨调用状态：同一本地
       * 目录重复迁移映射到同一实体（幂等由服务端同 (组,项目) 解析保证）。
       */
      async migratePush(dir: string): Promise<void> {
        if (this.migrating || this.activeWorkspaceId === null) return;
        this.migrating = true;
        this.migrationResult = null;
        this.migrationProgress = "";
        this.error = null;
        try {
          const workspaceId = this.activeWorkspaceId;
          const [scan, tree] = await Promise.all([api.onlineMigrateScan(dir), api.onlineTreeGet(workspaceId)]);
          // 1. 去重项目目录清单（扫描产物 projectDir；根级文件不参与映射）→ 映射桥（≤200/批）
          const dirs = new Map<string, ProjectDirRef>();
          for (const file of scan.files) {
            if (file.projectDir) dirs.set(`${file.projectDir.group}/${file.projectDir.project}`, file.projectDir);
          }
          const projectIdByDir = new Map<string, string>();
          for (const batch of chunk([...dirs.values()], 200)) {
            const entries = batch.map((d) => ({ group: d.group, project: d.project, createIfMissing: true }));
            const result = await api.onlineProjectMapping({ workspaceId, entries });
            // 行按**条目位置**关联（服务端 ProjectMappingService 按 entries 顺序逐行产出，任务 1
            // 已核实），映射表 key 取本地目录原名（entries 即 scan 产物）——不按服务端回显名回查：
            // 服务端对名称 trim() 后回显（审查重要 1），本地目录名带首尾空格时按名回查恒 miss →
            // 映射实际成功（且已留建实体副作用）却整项目误计 failed 且重试复现。
            for (let i = 0; i < entries.length; i++) {
              const row = result.mappings[i];
              if (row?.projectId) projectIdByDir.set(`${entries[i]!.group}/${entries[i]!.project}`, row.projectId);
              // missing/forbidden 行（三态之二）与缺行（协议异常防护）不进映射表 → 该项目文件按 failed 呈现
            }
          }
          // 2. 路径换算：项目内文件 → <projectId>/<项目内相对路径>；实体→本地对照表供明细
          //    还原（batch 行 path 与 skipped 均为服务端路径，回显必须转回名称路径）
          const localByEntity = new Map<string, string>();
          const failedLocals: string[] = [];
          const converted: LocalFileRow[] = [];
          for (const file of scan.files) {
            const projectId = file.projectDir ? projectIdByDir.get(`${file.projectDir.group}/${file.projectDir.project}`) : undefined;
            const entityPath = projectId !== undefined ? toEntityPath(file.path, projectId) : null;
            if (entityPath === null) {
              if (file.projectDir) failedLocals.push(file.path); // 映射缺失/无权建（含路径-目录不一致的防护兜底）
              else converted.push(file); // 根级文件原路径直推（不过映射）
              continue;
            }
            converted.push({ path: entityPath, hash: file.hash, content: file.content });
            localByEntity.set(entityPath, file.path);
          }
          // 3. 差异比对 + 分批推送（D8：新文件 baseVersion=0、变更带服务端 version、同 hash 跳过）
          const plan = planPush(converted, tree.files);
          const details: MigrationResult["details"] = plan.skipped.map((entityPath) => ({
            path: localByEntity.get(entityPath) ?? entityPath,
            action: "skipped" as const,
          }));
          for (const path of failedLocals) details.push({ path, action: "failed" });
          let pushed = 0;
          let conflicts = 0;
          let failed = failedLocals.length;
          let done = 0;
          for (const batch of chunk(plan.entries, 200)) {
            const result = await api.onlineFilesBatch({ workspaceId, files: batch });
            for (const item of result.results) {
              const path = localByEntity.get(item.path) ?? item.path;
              if (item.status === "pushed") {
                pushed += 1;
                details.push({ path, action: "pushed" });
              } else if (item.status === "conflict") {
                conflicts += 1;
                details.push({ path, action: "conflict" });
              } else {
                failed += 1;
                details.push({ path, action: item.status });
              }
            }
            this.migrationProgress = `${(done += batch.length)}/${plan.entries.length}`;
          }
          this.migrationResult = {
            direction: "push",
            pulled: 0,
            updated: 0,
            skipped: plan.skipped.length,
            pushed,
            conflicts,
            failed,
            details,
          };
          await this.refreshTreeView();
        } catch (e) {
          this.error = e instanceof Error ? e.message : String(e);
        } finally {
          this.migrating = false;
          this.migrationProgress = "";
        }
      },
    },
  })(createPinia());
}

export type OnlineStore = ReturnType<typeof createOnlineStore>;

import { createPinia, defineStore } from "pinia";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
// core 主入口含 native 索引面（better-sqlite3）——渲染层沙箱求值即崩（白屏，2026-09-06 用户报告）。
// 纯 schema 一律走 ./schema 子路径（依赖闭包仅 zod）。
import { ApiDefinitionSchema } from "@apicc/core/schema";
import type { ApiDefinition } from "@apicc/core";
import { OnlineBaseUrlSchema, type OnlineRole, type OnlineTreeProject, type OnlineUser, type OnlineVersionConflict, type OnlineWorkspaceSummary } from "../../../shared/online/contract.js";
import { chunk, planPull, planPush } from "../../../shared/online/migrate.js";
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

      // —— 任务 3：在线工作区浏览/编辑/迁移（裁定 A–E）——
      /** 当前在线工作区（null = 本地模式）。与本地工作区互斥（裁定 E）。 */
      activeWorkspace: null as { id: string; name: string; myRole: OnlineRole } | null,
      /** 在线树视图（main onlineTreeToDto 映射产物）。 */
      onlineTree: null as TreeNodeDTO | null,
      /** 项目角色清单（逐项目只读判定：myRole VIEWER/NONE 覆盖工作区角色）。 */
      projects: [] as OnlineTreeProject[],
      /** 编辑缓冲（裁定 B：仅 api.yaml 级编辑 + 只读文件原文浏览）。 */
      editorPath: null as string | null,
      editorKind: null as "api" | "file" | null,
      editorApi: null as ApiDefinition | null,
      editorRaw: "",
      editorProblems: [] as string[],
      editorVersion: 0,
      editorSnapshot: "",
      editorLoading: false,
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
       * 在线编辑缓冲 dirty（快照比对，先例同本地 editor store）。
       */
      editorDirty(state): boolean {
        return state.editorApi !== null && JSON.stringify(state.editorApi) !== state.editorSnapshot;
      },

      /**
       * 可写判定（裁定 B：VIEWER 只读 vs EDITOR 可编辑）：工作区 VIEWER 恒只读；
       * 项目级 ACL 覆盖按 path 首段项目 id 定位文件所属项目（path 实体化修订 2026-09-08：
       * 内容 path = `<projectId>/...`，服务端不再回 projects[].path 目录路径）；
       * VIEWER/NONE 时该项目子树只读；非项目子树（根配置）按工作区角色。
       */
      canEdit(state): (path: string | null) => boolean {
        return (path: string | null): boolean => {
          if (!state.activeWorkspace || state.activeWorkspace.myRole === "VIEWER" || !path) return false;
          const project = state.projects.find((p) => path === p.id || path.startsWith(`${p.id}/`));
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

      /** 登出：吊销服务端 token（失败记入 error 不阻断）+ 清本地登录态；档案保留（裁定 C）。
       *  在线工作区打开中先关闭（裁定 E：退出在线工作区 → 会话清理）。 */
      async logout(): Promise<void> {
        if (this.activeWorkspace) await this.closeWorkspace();
        try {
          await api.onlineLogout();
        } catch (e) {
          this.error = e instanceof Error ? e.message : String(e);
        }
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

      // —— 任务 3：在线工作区浏览/编辑/迁移（裁定 A–E）——

      /** 编辑缓冲与会话清理（裁定 E：关闭在线工作区即清树缓存/编辑缓冲/文件态）。 */
      clearEditor(): void {
        this.editorPath = null;
        this.editorKind = null;
        this.editorApi = null;
        this.editorRaw = "";
        this.editorProblems = [];
        this.editorVersion = 0;
        this.editorSnapshot = "";
        this.editorLoading = false;
      },

      /**
       * 打开在线工作区（裁定 A/E）：main 记录工作区并返回树视图（与本地互斥的自动侧——
       * 调用方先关本地工作区）；失败 error 上屏且状态不变（不开半开工作区）。
       */
      async openWorkspace(ws: OnlineWorkspaceSummary): Promise<void> {
        this.error = null;
        try {
          const view = await api.onlineWorkspaceOpen({ workspaceId: ws.id, name: ws.name, myRole: ws.myRole });
          this.activeWorkspace = { id: ws.id, name: ws.name, myRole: ws.myRole };
          this.onlineTree = view.tree;
          this.projects = view.projects;
          this.clearEditor();
          this.conflict = null;
          this.migrationResult = null;
        } catch (e) {
          this.error = e instanceof Error ? e.message : String(e);
        }
      },

      /** 关闭在线工作区（裁定 E）：main 会话清理 + 本地态全清；IPC 失败照常清本地（容错收口）。 */
      async closeWorkspace(): Promise<void> {
        try {
          await api.onlineWorkspaceClose();
        } catch {
          // main 侧已无会话（或在线未配置）——本地照常清理，不阻断退出
        }
        this.activeWorkspace = null;
        this.onlineTree = null;
        this.projects = [];
        this.clearEditor();
        this.conflict = null;
        this.migrationResult = null;
        this.migrationProgress = "";
      },

      /** 刷新在线树视图（推送/迁移后调用；main 侧内容变更（put/batch/delete 成功）已使树缓存失效，此处取到的是新树）。 */
      async refreshTreeView(): Promise<void> {
        if (!this.activeWorkspace) return;
        try {
          const view = await api.onlineTreeView(this.activeWorkspace.id);
          this.onlineTree = view.tree;
          this.projects = view.projects;
        } catch (e) {
          this.error = e instanceof Error ? e.message : String(e);
        }
      },

      /**
       * 在线侧树选中（App.onSelect 的在线分支）：api → getFiles 取 api.yaml，YAML 解析 +
       * core ApiDefinitionSchema 校验（裁定 B：坏数据进 problems 展示原文，禁崩）；
       * file → 只读原文浏览；容器节点仅清空编辑区。
       */
      async selectNode(kind: TreeNodeDTO["kind"], id: string): Promise<void> {
        if (!this.activeWorkspace || (kind !== "api" && kind !== "file")) {
          this.clearEditor();
          return;
        }
        this.editorLoading = true;
        this.error = null;
        try {
          const result = await api.onlineFilesGet({ workspaceId: this.activeWorkspace.id, paths: [id] });
          const file = result.files[0];
          if (!file) {
            this.clearEditor();
            this.error = `文件不在可见清单中: ${id}`;
            return;
          }
          this.editorPath = file.path;
          this.editorVersion = file.version;
          this.editorRaw = file.content;
          if (kind === "file") {
            this.editorKind = "file";
            this.editorApi = null;
            this.editorProblems = [];
            this.editorSnapshot = "";
            return;
          }
          this.editorKind = "api";
          try {
            const parsed = ApiDefinitionSchema.safeParse(parseYaml(file.content));
            if (parsed.success) {
              this.editorApi = parsed.data;
              this.editorProblems = [];
              this.editorSnapshot = JSON.stringify(parsed.data);
            } else {
              this.editorApi = null;
              this.editorSnapshot = "";
              this.editorProblems = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
            }
          } catch (e) {
            // YAML 语法坏损：同走 problems（不崩，原文可读）
            this.editorApi = null;
            this.editorSnapshot = "";
            this.editorProblems = [e instanceof Error ? e.message : String(e)];
          }
        } catch (e) {
          this.error = e instanceof Error ? e.message : String(e);
        } finally {
          this.editorLoading = false;
        }
      },

      /**
       * 保存在线接口定义（裁定 B）：序列化回 YAML 文本 putFile（baseVersion=当前 version）；
       * 成功 → 版本前移 + 快照复位；409 → conflict 入 store（冲突对话框由组合根渲染）。
       */
      async saveApi(): Promise<void> {
        if (!this.activeWorkspace || !this.editorApi || !this.editorPath || this.saving || !this.canEdit(this.editorPath)) return;
        this.saving = true;
        this.error = null;
        try {
          const content = stringifyYaml(JSON.parse(JSON.stringify(this.editorApi)) as Record<string, unknown>);
          const outcome = await api.onlineFilePut({
            workspaceId: this.activeWorkspace.id,
            path: this.editorPath,
            content,
            baseVersion: this.editorVersion,
          });
          if (outcome.outcome === "pushed") {
            this.editorVersion = outcome.result.version;
            this.editorSnapshot = JSON.stringify(this.editorApi);
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

      /** 冲突-拉取覆盖我的（裁定 C）：丢弃本地编辑（对话框选择即确认），重取服务端最新并重新渲染。 */
      async conflictPullOverwrite(): Promise<void> {
        if (!this.conflict || !this.activeWorkspace || !this.editorPath) return;
        const path = this.editorPath;
        const kind = this.editorKind ?? "api";
        this.conflict = null;
        await this.selectNode(kind, path);
      },

      /**
       * 迁移-拉取到本地目录（裁定 D）：getTree → 本地扫描 hash 比对（同 hash 跳过）→
       * 分批（≤200）取内容 → 分批落盘 → 结果清单（新拉/更新/跳过计数 + 明细）。
       * 单活动护栏：进行中二次调用直接返回。
       */
      async migratePull(dir: string): Promise<void> {
        if (this.migrating || !this.activeWorkspace) return;
        this.migrating = true;
        this.migrationResult = null;
        this.migrationProgress = "";
        this.error = null;
        try {
          const workspaceId = this.activeWorkspace.id;
          const [scan, tree] = await Promise.all([api.onlineMigrateScan(dir), api.onlineTreeGet(workspaceId)]);
          const plan = planPull(tree.files, scan.files);
          const contents: Array<{ path: string; content: string }> = [];
          let done = 0;
          for (const batch of chunk(plan.toFetch, 200)) {
            const result = await api.onlineFilesGet({ workspaceId, paths: batch });
            for (const file of result.files) contents.push({ path: file.path, content: file.content });
            this.migrationProgress = `${(done += batch.length)}/${plan.toFetch.length}`;
          }
          const written: string[] = [];
          for (const batch of chunk(contents, 200)) {
            written.push(...(await api.onlineMigrateWrite({ dir, files: batch })).written);
          }
          // 取数批内 missing（权限恰变/文件刚删）按 failed 计，不入落盘清单
          const writtenSet = new Set(written);
          const details = plan.details.map((d) =>
            d.action !== "skipped" && !writtenSet.has(d.path) ? { path: d.path, action: "failed" as const } : d,
          );
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
       * 迁移-推送本地目录（裁定 D）：本地扫描 → 与服务端 tree 比对（新文件 baseVersion=0、
       * 变更带服务端 version、同 hash 跳过——从不盲目覆盖）→ 分批 batch → 结果清单
       * （冲突默认跳过并列出）→ 刷新在线树（新文件可见）。
       */
      async migratePush(dir: string): Promise<void> {
        if (this.migrating || !this.activeWorkspace) return;
        this.migrating = true;
        this.migrationResult = null;
        this.migrationProgress = "";
        this.error = null;
        try {
          const workspaceId = this.activeWorkspace.id;
          const [scan, tree] = await Promise.all([api.onlineMigrateScan(dir), api.onlineTreeGet(workspaceId)]);
          const plan = planPush(scan.files, tree.files);
          const details: MigrationResult["details"] = plan.skipped.map((path) => ({ path, action: "skipped" as const }));
          let pushed = 0;
          let conflicts = 0;
          let failed = 0;
          let done = 0;
          for (const batch of chunk(plan.entries, 200)) {
            const result = await api.onlineFilesBatch({ workspaceId, files: batch });
            for (const item of result.results) {
              if (item.status === "pushed") {
                pushed += 1;
                details.push({ path: item.path, action: "pushed" });
              } else if (item.status === "conflict") {
                conflicts += 1;
                details.push({ path: item.path, action: "conflict" });
              } else {
                failed += 1;
                details.push({ path: item.path, action: item.status });
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

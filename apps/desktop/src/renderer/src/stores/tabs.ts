import { createPinia, defineStore } from "pinia";
import type { useTreeStore } from "./tree.js";
import type { useWorkspaceStore } from "./workspace.js";
import type { useEditorStore } from "./editor.js";
import type { useWorkflowDesignStore } from "./workflowDesign.js";
import type { OnlineStore } from "./online.js";
import type { TreeNodeDTO } from "../../../shared/tree-dto.js";

/**
 * 工作区引用（计划 C 任务 3）：签归属的工作区身份——本地目录或在线工作区。
 * 持久化（不变量 5）只记签结构，本形状即落盘形状（草稿绝不落盘）。
 */
export type WorkspaceRef = { kind: "local"; dir: string } | { kind: "online"; workspaceId: string; name: string };

/** 项目页签：顶栏页签栏的最小结构（渲染层 tabs store，计划 C 任务 3）。 */
export interface ProjectTab {
  /** tab-<自增>，运行期唯一（重启恢复时重生成，不落盘）。 */
  tabId: string;
  workspaceRef: WorkspaceRef;
  projectId: string;
  projectName: string;
}

export const STORAGE_KEY = "apicc.projectTabs";

/** localStorage 持久化形状（不变量 5：只记签结构）：签清单 + 活跃位下标。 */
export interface PersistedProjectTabs {
  tabs: Array<{ workspaceRef: WorkspaceRef; projectId: string; projectName: string }>;
  activeIndex: number | null;
}

/** workspaceRef 相等（去重键的一半）：同 kind 同身份即同一工作区。 */
function sameRef(a: WorkspaceRef, b: WorkspaceRef): boolean {
  if (a.kind === "local" && b.kind === "local") return a.dir === b.dir;
  if (a.kind === "online" && b.kind === "online") return a.workspaceId === b.workspaceId;
  return false;
}

/** workspaceRef 形状守卫（逐条过滤损坏条目，先例同 online.ts readPersisted）。 */
function parseWorkspaceRef(value: unknown): WorkspaceRef | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.kind === "local" && typeof v.dir === "string") return { kind: "local", dir: v.dir };
  if (v.kind === "online" && typeof v.workspaceId === "string" && typeof v.name === "string") {
    return { kind: "online", workspaceId: v.workspaceId, name: v.name };
  }
  return null;
}

/**
 * 读签表（形状守卫，照 online.ts readPersisted 先例）：非 JSON/形状不符/条目字段缺失 →
 * 过滤丢弃并 warn，不抛——损坏配置降级空签表（引导重新成签，不阻塞启动）。
 * 重复签（同 ref+projectId，正常路径不可能，损坏数据可）保留首条；activeIndex 越界复位 null。
 */
export function readPersistedTabs(storage: Storage): PersistedProjectTabs {
  const raw = storage.getItem(STORAGE_KEY);
  if (raw === null) return { tabs: [], activeIndex: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn(`项目签表存储损坏，已忽略: ${e instanceof Error ? e.message : String(e)}`);
    return { tabs: [], activeIndex: null };
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { tabs: unknown }).tabs)) {
    console.warn("项目签表存储形状不符，已忽略（签将在本次会话中重建）");
    return { tabs: [], activeIndex: null };
  }
  const tabs: PersistedProjectTabs["tabs"] = [];
  for (const row of (parsed as { tabs: unknown[] }).tabs) {
    if (typeof row !== "object" || row === null) continue;
    const r = row as Record<string, unknown>;
    const ref = parseWorkspaceRef(r.workspaceRef);
    if (!ref || typeof r.projectId !== "string" || typeof r.projectName !== "string") continue;
    if (tabs.some((t) => sameRef(t.workspaceRef, ref) && t.projectId === r.projectId)) continue; // 重复签去重
    tabs.push({ workspaceRef: ref, projectId: r.projectId, projectName: r.projectName });
  }
  const activeIndex = (parsed as { activeIndex: unknown }).activeIndex;
  const valid = typeof activeIndex === "number" && Number.isInteger(activeIndex) && activeIndex >= 0 && activeIndex < tabs.length;
  return { tabs, activeIndex: valid ? activeIndex : null };
}

function writePersistedTabs(storage: Storage, state: PersistedProjectTabs): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(state));
}

/**
 * tabs store 依赖（结构化 Pick，组件内零工厂调用——实例由 App 组合根创建后下传）：
 * 测试传内存 stub（可控行为、不发 IPC）即天然隔离。
 */
export interface TabsStoreDeps {
  /** 本地工作区 store（单例即驻留，不变量 4/8）：本地签上下文未就位时兜底重开目录；tree 供关签 dirty 判定收集项目 api 集合。 */
  workspace: Pick<ReturnType<typeof useWorkspaceStore>, "open" | "opened" | "root" | "tree">;
  /** 本地树选中：本地项目选中走 tree.select("project", id)（App.vue:367-370 先例）。 */
  tree: Pick<ReturnType<typeof useTreeStore>, "select">;
  /** 在线 store：会话表存在性（分歧防御）+ 显式激活 + 在线树项目选中 + 缓冲表（关签 dirty 判定）。 */
  online: Pick<OnlineStore, "sessions" | "activeWorkspaceId" | "error" | "activateWorkspace" | "selectNode">;
  /**
   * 本地编辑器会话表（任务 5 关签 dirty 判定聚合源之一）：该项目 apiIds 的任一会话槽
   * dirty 即需确认。App 组合根注入；未注入（store 单测省略）时跳过该草稿源。
   */
  editor?: Pick<ReturnType<typeof useEditorStore>, "sessions">;
  /**
   * 工作流设计器单会话（任务 5 关签 dirty 判定聚合源之一，规格勘误口径）：活跃工作流
   * 属于该项目且 dirty 即需确认。App 组合根注入；未注入时跳过该草稿源。
   */
  workflowDesign?: Pick<ReturnType<typeof useWorkflowDesignStore>, "dirty" | "workflowId">;
  /**
   * 关签驱逐钩子（不变量 3：关签=项目关闭）：驱逐该项目的编辑器会话（本地 editor 会话）
   * 与在线编辑缓冲。计划 C 任务 4 落地：用 createEvictProjectSessions 装配真实实现
   * （App 组合根任务 5 接 ProjectTabs 时传入）。
   */
  evictProjectSessions?: (workspaceRef: WorkspaceRef, projectId: string) => void;
  /**
   * 激活尾部钩子（编排第③步）：editor 上下文由活跃项目驱动。
   * 计划 C 任务 4 接线；任务 3 缺省 no-op（留接口）。
   */
  onProjectActivated?: (tab: ProjectTab) => Promise<void> | void;
  /** 持久化存储（缺省 localStorage；测试注入内存 Storage 隔离）。 */
  storage?: Storage;
}

/**
 * tabs store 工厂（计划 C 任务 3）：项目签注册表 + 激活编排 + localStorage 持久化。
 * 每次工厂调用绑定独立 Pinia 实例（先例同 createOnlineStore）。
 *
 * 状态契约：激活失败（分歧/激活被拒/本地目录失效）→ 签标记离线（offlineTabIds，运行期
 * 态不落盘）、error 上屏、**不切换**活跃；离线签保留在栏上（禁用态）可再激活，激活成功
 * 即移出离线表。签结构变更（成签/关签/切签成功）自动 persist（不变量 5 只记签结构）。
 */
export function createTabsStore(deps: TabsStoreDeps) {
  const storage = deps.storage ?? localStorage;
  return defineStore("projectTabs", {
    state: () => ({
      /** 签注册表（栏上顺序即数组序）。 */
      tabs: [] as ProjectTab[],
      /** 活跃签 id；null = 无活跃（回主页）。 */
      activeTabId: null as string | null,
      /** 离线签（恢复失败/激活失败）；运行期态不落盘——重启恢复时按重建结果重新推导。 */
      offlineTabIds: [] as string[],
      /** tabId 自增计数（运行期）。 */
      seq: 0,
      /** 激活失败文案（组件上屏）。 */
      error: null as string | null,
      /** 恢复在途（restore 运行期）：组合根的派生监听（首项目自动选中等）避让，防恢复中途插入成签竞态。 */
      restoring: false,
    }),
    getters: {
      activeTab(state): ProjectTab | null {
        return state.tabs.find((t) => t.tabId === state.activeTabId) ?? null;
      },
      /** 离线判定（任务 5 渲染禁用态）。 */
      isTabOffline(state): (tabId: string) => boolean {
        return (tabId: string) => state.offlineTabIds.includes(tabId);
      },
    },
    actions: {
      /** 标记离线 + error 上屏（不切换；激活失败的统一出口）。 */
      markOffline(tabId: string, message: string): void {
        if (!this.offlineTabIds.includes(tabId)) this.offlineTabIds.push(tabId);
        this.error = message;
      },

      /**
       * 确保签的工作区上下文就位（编排第①步，restore 重建与 activateTab 共用）。
       * 在线：先查渲染层会话表存在性（任务 2 审查裁定的分歧防御——main/渲染层分歧悬空
       * 指针在此拦截，online store 本体不改），未活跃再 activateWorkspace（内部 token
       * 验证）；激活被拒/分歧 → 标记离线返回 false。本地：单例已打开同目录则不动（驻留），
       * 否则兜底重开目录；目录失效 → 标记离线返回 false。
       */
      async ensureWorkspaceContext(tab: ProjectTab): Promise<boolean> {
        const ref = tab.workspaceRef;
        if (ref.kind === "online") {
          if (!deps.online.sessions[ref.workspaceId]) {
            this.markOffline(tab.tabId, `在线工作区会话不存在（可能已退出登录），签已标记离线: ${ref.name}`);
            return false;
          }
          if (deps.online.activeWorkspaceId !== ref.workspaceId) {
            await deps.online.activateWorkspace(ref.workspaceId);
            if (deps.online.activeWorkspaceId !== ref.workspaceId) {
              // activateWorkspace 失败不抛（error 通道），以活跃指针未随动为准
              this.markOffline(tab.tabId, deps.online.error ?? `在线工作区激活失败: ${ref.name}`);
              return false;
            }
          }
          return true;
        }
        if (!deps.workspace.opened || deps.workspace.root !== ref.dir) {
          try {
            await deps.workspace.open(ref.dir);
          } catch (e) {
            this.markOffline(tab.tabId, e instanceof Error ? e.message : String(e));
            return false;
          }
        }
        return true;
      },

      /**
       * 项目选中即成签（不变量 1）：同 workspaceRef+projectId 已存在 → 仅激活（已活跃
       * 则 no-op，草稿零扰动）；否则成签置活跃并跑激活编排。
       */
      async openProjectTab(ref: WorkspaceRef, project: { id: string; name: string }): Promise<void> {
        const existing = this.tabs.find((t) => sameRef(t.workspaceRef, ref) && t.projectId === project.id);
        if (existing) {
          if (this.activeTabId !== existing.tabId) await this.activateTab(existing.tabId);
          return;
        }
        const tab: ProjectTab = {
          tabId: `tab-${++this.seq}`,
          workspaceRef: { ...ref },
          projectId: project.id,
          projectName: project.name,
        };
        this.tabs.push(tab);
        this.persist(); // 成签即落盘：首激活失败的签（如离线）也驻留持久层，重启可恢复后再激活
        await this.activateTab(tab.tabId);
      },

      /**
       * 激活编排：①工作区上下文就位（在线签先 activateWorkspace，失败标记离线不切换——
       * 见 ensureWorkspaceContext）；②项目选中（本地 tree.select 项目节点 / 在线
       * selectNode 项目节点）；③editor 上下文由活跃项目驱动（任务 4 接线钩子）。
       * 已活跃签 no-op（切签免确认、草稿驻留，不变量 2）。成功后移出离线表并 persist。
       */
      async activateTab(tabId: string): Promise<void> {
        this.error = null;
        const tab = this.tabs.find((t) => t.tabId === tabId);
        if (!tab || this.activeTabId === tabId) return;
        if (!(await this.ensureWorkspaceContext(tab))) return;
        // ② 项目选中（工作区上下文就位后）
        if (tab.workspaceRef.kind === "online") await deps.online.selectNode("project", tab.projectId);
        else deps.tree.select("project", tab.projectId);
        this.activeTabId = tabId;
        this.offlineTabIds = this.offlineTabIds.filter((id) => id !== tabId);
        this.persist();
        // ③ editor 上下文由活跃项目驱动（任务 4 接线点）
        await deps.onProjectActivated?.(tab);
      },

      /**
       * 关签 dirty 判定（不变量 3 确认口径，任务 5）：聚合该项目**全部**草稿源——
       * - 本地签：editor 中该项目 apiIds 的任一会话槽 dirty（apiIds 由 workspace.tree 收集，
       *   与 createEvictProjectSessions 同款收集逻辑；非活跃槽脏同样拦截）；
       * - 在线签：该驻留会话缓冲表中 `<projectId>/` 前缀槽任一 dirty（先例同 editorDirty）；
       * - 外加 workflowDesign 单会话（规格勘误口径）：活跃工作流属于该项目且 dirty（归属按
       *   树 workflows 摘要过滤——别的项目的草稿流不牵连本项目关签）。
       * editor/workflowDesign 依赖未注入时对应草稿源跳过（App 组合根必注入，store 单测可省）。
       */
      projectHasDrafts(tabId: string): boolean {
        const tab = this.tabs.find((t) => t.tabId === tabId);
        if (!tab) return false;
        const wf = deps.workflowDesign;
        if (wf?.dirty && wf.workflowId !== null) {
          const owner = findProjectNode(deps.workspace.tree, tab.projectId);
          if (owner?.workflows?.some((w) => w.id === wf.workflowId)) return true;
        }
        if (tab.workspaceRef.kind === "online") {
          const session = deps.online.sessions[tab.workspaceRef.workspaceId];
          if (!session) return false;
          const prefix = `${tab.projectId}/`;
          for (const path of Object.keys(session.buffers)) {
            if (!path.startsWith(prefix)) continue;
            const buffer = session.buffers[path]!;
            if (buffer.api !== null && JSON.stringify(buffer.api) !== buffer.snapshot) return true;
          }
          return false;
        }
        const project = findProjectNode(deps.workspace.tree, tab.projectId);
        if (!project || !deps.editor) return false;
        const apiIds: string[] = [];
        collectApiIds(project, apiIds);
        return apiIds.some((apiId) => {
          const session = deps.editor!.sessions[apiId];
          return session !== undefined && session.api !== null && JSON.stringify(session.api) !== session.snapshot;
        });
      },

      /**
       * 关签（不变量 3：关签=项目关闭；dirty 确认由调用方负责）：驱逐该项目的编辑器
       * 会话（deps.evictProjectSessions，任务 4 落地）→ 签出表；关的是活跃签 → 活跃切
       * 相邻签（右邻优先、尾签回左邻，相邻激活失败保持 null），无签则 null（回主页）。
       */
      async closeTab(tabId: string): Promise<void> {
        const index = this.tabs.findIndex((t) => t.tabId === tabId);
        if (index < 0) return;
        const tab = this.tabs[index]!;
        deps.evictProjectSessions?.(tab.workspaceRef, tab.projectId);
        this.tabs.splice(index, 1);
        this.offlineTabIds = this.offlineTabIds.filter((id) => id !== tabId);
        if (this.activeTabId === tabId) {
          this.activeTabId = null;
          const adjacent = this.tabs[Math.min(index, this.tabs.length - 1)];
          if (adjacent) await this.activateTab(adjacent.tabId);
        }
        this.persist();
      },

      /** 持久化签结构（不变量 5：只记签结构，草稿/离线态不落盘；成签/关签/切签成功后自动调用）。 */
      persist(): void {
        const index = this.activeTabId !== null ? this.tabs.findIndex((t) => t.tabId === this.activeTabId) : -1;
        writePersistedTabs(storage, {
          tabs: this.tabs.map((t) => ({ workspaceRef: { ...t.workspaceRef }, projectId: t.projectId, projectName: t.projectName })),
          activeIndex: index >= 0 ? index : null,
        });
      },

      /**
       * 启动按签恢复（不变量 5，App 组合根任务 5 接线）：逐签重建——本地签重开目录、
       * 在线签 activateWorkspace（内部 token 验证），失败签标记离线（禁用态可再激活）；
       * 持久化的活跃签未离线则走完整激活编排（项目选中 + 钩子），离线/无记录 → null 回主页。
       * 全程不抛（存储损坏降级空签表；恢复失败以离线态呈现，不阻塞启动）。
       */
      async restore(): Promise<void> {
        this.restoring = true;
        try {
          const persisted = readPersistedTabs(storage);
          this.tabs = [];
          this.activeTabId = null;
          this.offlineTabIds = [];
          this.seq = 0;
          const rebuiltTabIds: string[] = [];
          for (const row of persisted.tabs) {
            const tab: ProjectTab = {
              tabId: `tab-${++this.seq}`,
              workspaceRef: row.workspaceRef,
              projectId: row.projectId,
              projectName: row.projectName,
            };
            this.tabs.push(tab);
            rebuiltTabIds.push(tab.tabId);
            // 逐签重建工作区上下文（非活跃签不选项目——选中留给激活时）
            await this.ensureWorkspaceContext(tab);
          }
          const activeId = persisted.activeIndex !== null ? rebuiltTabIds[persisted.activeIndex] : undefined;
          if (activeId !== undefined && !this.offlineTabIds.includes(activeId)) {
            await this.activateTab(activeId);
            return;
          }
          this.activeTabId = null; // 活跃签离线/无活跃记录 → 回主页
        } finally {
          this.restoring = false;
        }
      },
    },
  })(createPinia());
}

export type TabsStore = ReturnType<typeof createTabsStore>;

/** createEvictProjectSessions 依赖（结构化最小面，测试可传真实 store 或 spy）。 */
export interface EvictProjectSessionsDeps {
  /** 本地工作区 store：按 tree 定位项目节点并收集其 api 集合（任务 4：本地 apiId 集合由 tree 取）。 */
  workspace: { tree: TreeNodeDTO | null };
  /** 本地编辑器 store：驱逐该项目的编辑会话槽。 */
  editor: Pick<ReturnType<typeof useEditorStore>, "evictProject">;
  /** 在线 store：按 `<projectId>/` 前缀驱逐驻留工作区缓冲槽。 */
  online: Pick<OnlineStore, "evictProjectBuffers">;
}

/** 树中定位项目节点（按 id，任意分组下；导出供组合根成签取项目名与 lastApi 过滤复用）。 */
export function findProjectNode(root: TreeNodeDTO | null, projectId: string): TreeNodeDTO | null {
  for (const group of root?.children ?? []) {
    for (const project of group.children ?? []) {
      if (project.kind === "project" && project.id === projectId) return project;
    }
  }
  return null;
}

/** 递归收集项目子树内全部接口 id（驱逐集合/lastApi 归属过滤，先序无影响；导出同上）。 */
export function collectApiIds(node: TreeNodeDTO, out: string[]): void {
  for (const child of node.children ?? []) {
    if (child.kind === "api") out.push(child.id);
    collectApiIds(child, out);
  }
}

/**
 * 关签驱逐真实实现（计划 C 任务 4，不变量 3：关签=项目关闭）——组装出 tabs deps 的
 * `evictProjectSessions` 钩子（App 组合根任务 5 接 ProjectTabs 时传入 createTabsStore）：
 * - 本地签：按 workspace.tree 收集该项目的 api id 集合 → `editor.evictProject` 驱逐会话槽；
 * - 在线签：按 projectId 前缀（`<projectId>/`）驱逐该驻留工作区缓冲表槽（`online.evictProjectBuffers`）。
 * 防护口径（任务 3 钩子契约）：实现内部不抛——驱逐失败只 warn 不阻断关签（closeTab
 * 调用方不 try/catch）。
 */
export function createEvictProjectSessions(
  deps: EvictProjectSessionsDeps,
): (workspaceRef: WorkspaceRef, projectId: string) => void {
  return (workspaceRef, projectId) => {
    try {
      if (workspaceRef.kind === "online") {
        deps.online.evictProjectBuffers(workspaceRef.workspaceId, projectId);
        return;
      }
      const project = findProjectNode(deps.workspace.tree, projectId);
      if (!project) return; // 树中无此项目（已删/未刷新）：无可驱逐集合，不抛
      const apiIds: string[] = [];
      collectApiIds(project, apiIds);
      deps.editor.evictProject(projectId, apiIds);
    } catch (e) {
      console.warn(`关签驱逐项目编辑会话失败（projectId=${projectId}）: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}

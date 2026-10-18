import { createPinia, defineStore } from "pinia";
import type { ApiLocator, ProjectLocator } from "../../../shared/locations.js";

export type RequestTabSource =
  | { kind: "asset"; locator: ApiLocator }
  | { kind: "free"; project: ProjectLocator; draftId: string };

export interface RequestTab {
  tabId: string;
  root: string;
  project: ProjectLocator;
  source: RequestTabSource;
  generation: number;
}

export interface RequestCloseState { dirty: boolean; running: boolean }

export interface RequestTabsDeps {
  getContext: () => { root: string; project: ProjectLocator | null };
  isDirty: (tabId: string) => boolean;
  isRunning: (tabId: string) => boolean;
  confirmClose: (tabId: string, state: RequestCloseState) => Promise<boolean>;
  confirmCloseMany?: (tabs: RequestTab[], state: RequestCloseState) => Promise<boolean>;
  cancelRun: (tabId: string) => Promise<void>;
  evict: (tabId: string) => void;
}

function projectOf(locator: ApiLocator): ProjectLocator {
  return { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId };
}

function sameProject(left: ProjectLocator, right: ProjectLocator): boolean {
  return left.workspaceId === right.workspaceId && left.groupId === right.groupId && left.projectId === right.projectId;
}

function sameAsset(left: ApiLocator, right: ApiLocator): boolean {
  return sameProject(left, right) && left.collectionId === right.collectionId && left.apiId === right.apiId
    && left.folderIds.length === right.folderIds.length && left.folderIds.every((id, index) => id === right.folderIds[index]);
}

function scopeKey(root: string, project: ProjectLocator): string {
  return JSON.stringify([root, project.workspaceId, project.groupId, project.projectId]);
}

function sameSource(tab: RequestTab, root: string, source: RequestTabSource): boolean {
  if (tab.root !== root || tab.source.kind !== source.kind) return false;
  return source.kind === "asset" && tab.source.kind === "asset"
    ? sameAsset(tab.source.locator, source.locator)
    : source.kind === "free" && tab.source.kind === "free"
      && tab.source.draftId === source.draftId && sameProject(tab.source.project, source.project);
}

export function createRequestTabsStore(deps: RequestTabsDeps) {
  const closing = new Set<string>();
  return defineStore("requestTabs", {
    state: () => ({
      tabs: {} as Record<string, RequestTab>,
      order: [] as string[],
      activeId: null as string | null,
      lastActiveByScope: {} as Record<string, string>,
      seq: 0,
      generation: 0,
    }),
    getters: {
      activeTab(state): RequestTab | null {
        return state.activeId ? state.tabs[state.activeId] ?? null : null;
      },
    },
    actions: {
      open(source: RequestTabSource): string {
        const context = deps.getContext();
        if (!context.root) throw new Error("打开请求签需要已打开的本地工作区");
        const project = source.kind === "asset" ? projectOf(source.locator) : source.project;
        if (!context.project || !sameProject(project, context.project)) throw new Error("请求签项目上下文无效");
        const existing = Object.values(this.tabs).find((tab) => sameSource(tab, context.root, source));
        if (existing) {
          this.activate(existing.tabId);
          return existing.tabId;
        }
        const tabId = `request-${++this.seq}`;
        const copiedSource: RequestTabSource = source.kind === "asset"
          ? { kind: "asset", locator: { ...source.locator, folderIds: [...source.locator.folderIds] } }
          : { kind: "free", project: { ...source.project }, draftId: source.draftId };
        this.tabs[tabId] = { tabId, root: context.root, project: { ...project }, source: copiedSource, generation: ++this.generation };
        this.order.push(tabId);
        this.activate(tabId);
        return tabId;
      },

      activate(tabId: string): boolean {
        const tab = this.tabs[tabId];
        if (!tab) return false;
        this.activeId = tabId;
        this.lastActiveByScope[scopeKey(tab.root, tab.project)] = tabId;
        return true;
      },

      activateProject(root: string, project: ProjectLocator): string | null {
        const key = scopeKey(root, project);
        const previous = this.lastActiveByScope[key];
        const candidate = previous && this.tabs[previous]?.root === root && sameProject(this.tabs[previous]!.project, project)
          ? previous
          : [...this.order].reverse().find((id) => {
            const tab = this.tabs[id];
            return !!tab && tab.root === root && sameProject(tab.project, project);
          }) ?? null;
        this.activeId = candidate;
        return candidate;
      },

      hasProjectDrafts(root: string, project: ProjectLocator): boolean {
        return this.order.some((id) => {
          const tab = this.tabs[id];
          return !!tab && tab.root === root && sameProject(tab.project, project)
            && (deps.isDirty(id) || deps.isRunning(id));
        });
      },

      async close(tabId: string): Promise<boolean> {
        return this.closeMany([tabId], true);
      },

      async closeProject(root: string, project: ProjectLocator, confirmed = false): Promise<boolean> {
        const ids = this.order.filter((id) => {
          const tab = this.tabs[id];
          return !!tab && tab.root === root && sameProject(tab.project, project);
        });
        return this.closeMany(ids, !confirmed);
      },

      async closeMany(tabIds: string[], ask: boolean): Promise<boolean> {
        const selected = tabIds.map((id) => this.tabs[id]).filter((tab): tab is RequestTab => !!tab);
        if (selected.length === 0 || selected.some((tab) => closing.has(tab.tabId))) return false;
        const closeState = selected.reduce<RequestCloseState>((state, tab) => ({
          dirty: state.dirty || deps.isDirty(tab.tabId),
          running: state.running || deps.isRunning(tab.tabId),
        }), { dirty: false, running: false });
        if (ask && (closeState.dirty || closeState.running)) {
          const accepted = selected.length === 1
            ? await deps.confirmClose(selected[0]!.tabId, closeState)
            : await (deps.confirmCloseMany?.(selected, closeState) ?? deps.confirmClose(selected[0]!.tabId, closeState));
          if (!accepted) return false;
        }
        for (const tab of selected) closing.add(tab.tabId);
        try {
          for (const tab of selected) {
            if (!deps.isRunning(tab.tabId)) continue;
            try { await deps.cancelRun(tab.tabId); }
            catch (error) { console.warn(`关闭请求签时取消运行失败（tab=${tab.tabId}）: ${error instanceof Error ? error.message : String(error)}`); }
          }
          for (const tab of selected) {
            if (this.tabs[tab.tabId] !== tab) continue;
            try { deps.evict(tab.tabId); }
            catch (error) { console.warn(`关闭请求签时驱逐草稿失败（tab=${tab.tabId}）: ${error instanceof Error ? error.message : String(error)}`); }
            delete this.tabs[tab.tabId];
            this.order = this.order.filter((id) => id !== tab.tabId);
            if (this.activeId === tab.tabId) this.activeId = null;
            for (const [scope, activeId] of Object.entries(this.lastActiveByScope)) {
              if (activeId === tab.tabId) delete this.lastActiveByScope[scope];
            }
          }
          if (!this.activeId) {
            const replacement = [...this.order].reverse().find((id) => this.tabs[id]?.root === selected[0]!.root
              && sameProject(this.tabs[id]!.project, selected[0]!.project));
            if (replacement) this.activate(replacement);
          }
          return true;
        } finally {
          for (const tab of selected) closing.delete(tab.tabId);
        }
      },

      isCurrent(tabId: string, generation: number, root: string): boolean {
        const tab = this.tabs[tabId];
        return !!tab && tab.root === root && tab.generation === generation;
      },

      canConvertFreeToAsset(
        tabId: string,
        expected: { root: string; generation: number; project: ProjectLocator; draftId: string },
        locator: ApiLocator,
      ): boolean {
        const tab = this.tabs[tabId];
        const context = deps.getContext();
        return !!tab && tab.source.kind === "free" && tab.tabId === tabId
          && tab.root === expected.root && context.root === expected.root && tab.generation === expected.generation
          && tab.source.draftId === expected.draftId && sameProject(tab.project, expected.project)
          && sameProject(tab.source.project, expected.project) && sameProject(projectOf(locator), expected.project)
          && !!context.project && sameProject(context.project, expected.project);
      },

      convertFreeToAsset(
        tabId: string,
        expected: { root: string; generation: number; project: ProjectLocator; draftId: string },
        locator: ApiLocator,
      ): boolean {
        if (!this.canConvertFreeToAsset(tabId, expected, locator)) return false;
        this.commitFreeToAsset(tabId, locator);
        return true;
      },

      /** Commit a conversion already preflighted in the same synchronous turn. */
      commitFreeToAsset(tabId: string, locator: ApiLocator): RequestTab {
        const tab = this.tabs[tabId]!;
        tab.source = { kind: "asset", locator: { ...locator, folderIds: [...locator.folderIds] } };
        tab.project = projectOf(locator);
        tab.generation = ++this.generation;
        this.lastActiveByScope[scopeKey(tab.root, tab.project)] = tabId;
        return tab;
      },
    },
  })(createPinia());
}

export type RequestTabsStore = ReturnType<typeof createRequestTabsStore>;

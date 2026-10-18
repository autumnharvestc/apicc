import { createPinia, defineStore } from "pinia";
import { watch } from "vue";
import type { ApiccApi } from "../../../shared/types.js";
import type { ApiRequest, DebugFieldState, DebugInvocation, DebugResult, RequestSettingsOverride } from "@apicc/core";
import { ApiRequestSchema } from "@apicc/core/schema";
import type { DebugHistoryRestoreResult } from "../../../shared/types.js";
import type { ApiLocator, ProjectLocator } from "../../../shared/locations.js";
import type { useEditorStore } from "./editor.js";
import type { RequestTab } from "./requestTabs.js";
import type { RequestTabsStore } from "./requestTabs.js";
import type { LocalWorkspaceContext } from "./localIdentity.js";
import { apiSessionKey, projectSessionKey } from "./localIdentity.js";
import type { CaseIdentity } from "./cases.js";

type Editor = ReturnType<typeof useEditorStore>;
type RunFn = (input: DebugInvocation) => Promise<DebugResult>;
type StartFn = (onStarted: (runId: string) => boolean) => Promise<DebugResult>;
type ResultTarget = { root: string; locator: ApiLocator; generation?: number };
type RequestDebugInvocation = Extract<DebugInvocation, { mode: "request" }>;
type RestoreState = {
  generation: number;
  fields: DebugFieldState[];
  parameters: Record<string, string>;
  parentHistoryId: string | null;
  originalValues: Record<string, string>;
};

export interface RequestTabDebugState {
  tabId: string;
  root: string;
  generation: number;
  restoreEditorGeneration: number | null;
  draftSnapshot: string;
  settings: RequestSettingsOverride;
  selectedEnvironmentId: string | null;
  selectedCase: CaseIdentity | null;
  parameters: Record<string, string>;
  fields: DebugFieldState[];
  parentHistoryId: string | null;
  originalValues: Record<string, string>;
  result: DebugResult | null;
  error: string | null;
  sending: boolean;
  starting: boolean;
  activeRunId: string | null;
  requestPanel: string;
  responsePanel: string;
  requestScrollTop: number;
  responseScrollTop: number;
}

function restoreStateKey(sessionKey: string, generation: number): string {
  return `${sessionKey}\0${generation}`;
}

function setRestoredPreview(target: object, value: RequestDebugInvocation): void {
  Reflect.set(target, "restoredPreview", value);
}

function projectOf(locator: ApiLocator): ProjectLocator {
  return { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId };
}

function requestUrl(request: ApiRequest): string {
  const base = request.baseUrl.replace(/\/$/, "");
  const path = request.path.startsWith("/") ? request.path : `/${request.path}`;
  const query = request.protocol === "http" ? request.query.filter((item) => item.kind === "inline" && item.enabled !== false && item.name)
    .map((item) => `${encodeURIComponent(item.kind === "inline" ? item.name : "")}=${encodeURIComponent(item.value ?? "")}`).join("&") : "";
  return `${base}${path}${query ? `?${query}` : ""}`;
}

function requestTabDraftSnapshot(state: Pick<RequestTabDebugState,
  "settings" | "selectedEnvironmentId" | "selectedCase" | "parameters" | "fields" | "parentHistoryId">): string {
  return JSON.stringify({
    settings: state.settings,
    selectedEnvironmentId: state.selectedEnvironmentId,
    selectedCase: state.selectedCase,
    parameters: state.parameters,
    fields: state.fields,
    parentHistoryId: state.parentHistoryId,
  });
}

function copyLocator(locator: ApiLocator): ApiLocator {
  return { ...projectOf(locator), collectionId: locator.collectionId, folderIds: [...locator.folderIds], apiId: locator.apiId };
}

function assetTabFor(requestTabs: RequestTabsStore | undefined, root: string, locator: ApiLocator): RequestTab | null {
  return Object.values(requestTabs?.tabs ?? {}).find((tab) => tab.root === root && tab.source.kind === "asset"
    && sameLocator(tab.source.locator, locator)) ?? null;
}

/** Debug drafts never save a formal asset. Results and active jobs are root/full-locator scoped. */
export function useDebugStore(
  api: ApiccApi,
  editor?: Editor,
  getContext: () => LocalWorkspaceContext = () => ({ root: "", readOnly: false }),
  requestTabs?: RequestTabsStore,
) {
  const store = defineStore("debug", {
    state: () => ({
      sending: false,
      starting: false,
      activeRunId: null as string | null,
      activeResultKey: null as string | null,
      results: {} as Record<string, DebugResult>,
      lastResultKey: null as string | null,
      error: null as string | null,
      activeProjectKey: null as string | null,
      envByProject: {} as Record<string, string | null>,
      selectedEnvName: null as string | null,
      selectedCase: null as CaseIdentity | null,
      settings: {} as RequestSettingsOverride,
      restoredFields: [] as DebugFieldState[],
      restoredParameters: {} as Record<string, string>,
      restoredParentHistoryId: null as string | null,
      restoredTargetKey: null as string | null,
      restoredTargetGeneration: null as number | null,
      restoredPreview: null as Extract<DebugInvocation, { mode: "request" }> | null,
      freeRestoredPreview: null as Extract<DebugInvocation, { mode: "free" }> | null,
      restoredSourceAvailable: null as boolean | null,
      restoredOriginalValues: {} as Record<string, string>,
      restoreByTarget: {} as Record<string, RestoreState>,
      requestTabs: {} as Record<string, RequestTabDebugState>,
      sendEpoch: 0,
      restoreEpoch: 0,
    }),
    getters: {
      result(state): DebugResult | null {
        if (!editor) return state.lastResultKey ? state.results[state.lastResultKey] ?? null : null;
        const activeKey = editor.activeKey;
        const session = activeKey ? editor.sessions[activeKey] : undefined;
        if (!session || session.root !== getContext().root) return null;
        const key = apiSessionKey(session.root, session.locator);
        return key ? state.results[key] ?? null : null;
      },
      projectEnvName(state): string | null {
        return state.activeProjectKey ? state.envByProject[state.activeProjectKey] ?? null : null;
      },
    },
    actions: {
      hasUnresolvedRestoreInput(sessionKey: string, generation: number): boolean {
        if (!editor || editor.activeKey !== sessionKey) return false;
        const session = editor.sessions[sessionKey];
        if (!session || session.generation !== generation || apiSessionKey(session.root, session.locator) !== sessionKey) return false;
        const tab = assetTabFor(requestTabs, session.root, session.locator);
        if (tab) {
          const state = this.requestTabs[tab.tabId];
          if (state?.root === tab.root && state.generation === tab.generation
            && state.restoreEditorGeneration === generation) return state.fields.some((field) => field.needsInput);
        }
        return this.restoreByTarget[restoreStateKey(sessionKey, generation)]?.fields.some((field) => field.needsInput) ?? false;
      },
      restoreForSession(sessionKey: string, generation: number): RestoreState | null {
        if (editor) {
          const session = editor.sessions[sessionKey];
          if (session?.generation === generation) {
            const tab = assetTabFor(requestTabs, session.root, session.locator);
            const state = tab ? this.requestTabs[tab.tabId] : undefined;
            if (state?.restoreEditorGeneration === generation && state.root === tab!.root && state.generation === tab!.generation) {
              return JSON.parse(JSON.stringify({ generation, fields: state.fields, parameters: state.parameters,
                parentHistoryId: state.parentHistoryId, originalValues: state.originalValues })) as RestoreState;
            }
          }
        }
        const value = this.restoreByTarget[restoreStateKey(sessionKey, generation)];
        return value ? JSON.parse(JSON.stringify(value)) as RestoreState : null;
      },
      requestTabForSession(sessionKey: string): RequestTab | null {
        const session = editor?.sessions[sessionKey];
        return session ? assetTabFor(requestTabs, session.root, session.locator) : null;
      },
      syncActiveRestore(editorValue: Editor) {
        const activeKey = editorValue.activeKey;
        const session = activeKey ? editorValue.sessions[activeKey] : undefined;
        const key = session && session.root === getContext().root ? apiSessionKey(session.root, session.locator) : null;
        const tab = session ? assetTabFor(requestTabs, session.root, session.locator) : null;
        const tabState = tab ? this.requestTabs[tab.tabId] : undefined;
        const tabRestoreMatches = !!session && !!tabState && tabState.root === tab!.root
          && tabState.generation === tab!.generation && tabState.restoreEditorGeneration === session.generation;
        const restored = tabRestoreMatches && tabState && session
          ? { generation: session.generation, fields: tabState.fields, parameters: tabState.parameters,
            parentHistoryId: tabState.parentHistoryId, originalValues: tabState.originalValues }
          : key && session ? this.restoreByTarget[restoreStateKey(key, session.generation)] : undefined;
        this.restoredFields = restored ? restored.fields.map((field) => ({ ...field })) : [];
        this.restoredParameters = restored ? { ...restored.parameters } : {};
        this.restoredParentHistoryId = restored?.parentHistoryId ?? null;
        this.restoredTargetKey = restored && key ? key : null;
        this.restoredTargetGeneration = restored ? restored.generation : null;
        this.restoredOriginalValues = restored ? { ...restored.originalValues } : {};
      },
      setProject(locator: ProjectLocator | null) {
        const root = getContext().root;
        this.activeProjectKey = locator ? projectSessionKey(root, locator) : null;
        this.selectedEnvName = this.activeProjectKey ? this.envByProject[this.activeProjectKey] ?? null : null;
        this.selectedCase = null;
      },
      selectEnv(name: string | null) {
        this.selectedEnvName = name;
        if (this.activeProjectKey) this.envByProject[this.activeProjectKey] = name;
      },
      selectCase(identity: CaseIdentity | null) {
        this.selectedCase = identity ? { caseId: identity.caseId, scope: identity.scope } : null;
      },
      requestTabState(tab: RequestTab): RequestTabDebugState {
        const existing = this.requestTabs[tab.tabId];
        if (existing && existing.root === tab.root && existing.generation === tab.generation) return existing;
        const value: RequestTabDebugState = {
          tabId: tab.tabId,
          root: tab.root,
          generation: tab.generation,
          restoreEditorGeneration: null,
          draftSnapshot: "",
          settings: {},
          selectedEnvironmentId: null,
          selectedCase: null,
          parameters: {},
          fields: [],
          parentHistoryId: null,
          originalValues: {},
          result: null,
          error: null,
          sending: false,
          starting: false,
          activeRunId: null,
          requestPanel: "path",
          responsePanel: "body",
          requestScrollTop: 0,
          responseScrollTop: 0,
        };
        value.draftSnapshot = requestTabDraftSnapshot(value);
        this.requestTabs[tab.tabId] = value;
        return value;
      },
      applyFreeHistoryRestore(
        tab: RequestTab,
        invocation: Extract<DebugInvocation, { mode: "free" }>,
        freeGeneration: number,
        targetEditor: Editor,
      ): boolean {
        if (tab.source.kind !== "free" || !requestTabs?.isCurrent(tab.tabId, tab.generation, tab.root)
          || getContext().root !== tab.root || !sameProject(tab.source.project, invocation.project)) return false;
        const free = targetEditor.freeSessions[tab.tabId];
        if (!free || free.root !== tab.root || free.generation !== freeGeneration || free.draftId !== tab.source.draftId
          || !sameProject(free.project, invocation.project)) return false;
        const state = this.requestTabState(tab);
        state.restoreEditorGeneration = freeGeneration;
        state.fields = invocation.fields.map((field) => ({ ...field }));
        state.parameters = { ...invocation.parameters };
        state.parentHistoryId = invocation.parentHistoryId ?? null;
        state.originalValues = Object.fromEntries(invocation.fields.map((field) => [field.path,
          readSessionRestoreField(invocation.request, invocation.parameters, field.path)]));
        state.settings = { ...(invocation.settings ?? {}) };
        state.selectedEnvironmentId = invocation.environmentId ?? null;
        state.selectedCase = null;
        state.result = null;
        state.error = null;
        state.draftSnapshot = requestTabDraftSnapshot(state);
        this.freeRestoredPreview = null;
        this.restoredPreview = null;
        this.restoredSourceAvailable = true;
        return true;
      },
      async replayFreeHistory(
        historyId: string,
        project: ProjectLocator,
        sourceDraftId: string,
        tab: RequestTab,
        targetEditor: Editor,
      ): Promise<void> {
        if (tab.source.kind !== "free" || !sameProject(tab.source.project, project)
          || getContext().root !== tab.root || !requestTabs?.isCurrent(tab.tabId, tab.generation, tab.root)) return;
        const startReplay: StartFn = async (onStarted) => {
          const started = await api.debugHistoryReplay({ historyId, project: { ...project } });
          if (started.sourceKind !== "free" || !sameProject(started.project, project) || started.draftId !== sourceDraftId
            || !onStarted(started.runId)) {
            void api.debugCancel({ runId: started.runId });
            throw new Error("历史重放上下文已变化；迟到运行已取消。");
          }
          return api.debugWait({ runId: started.runId });
        };
        await this.runRequestTabInvocation(tab, targetEditor, undefined, undefined, startReplay);
      },
      canConvertRequestTab(tabId: string, expected: { root: string; generation: number; project: ProjectLocator; draftId: string }): boolean {
        const state = this.requestTabs[tabId];
        const tab = requestTabs?.tabs[tabId];
        return !!state && state.root === expected.root && state.generation === expected.generation
          && !state.starting && !state.sending && !!tab && tab.tabId === tabId
          && tab.root === expected.root && tab.generation === expected.generation && tab.source.kind === "free"
          && tab.source.draftId === expected.draftId && sameProject(tab.project, expected.project)
          && sameProject(tab.source.project, expected.project)
          && !!requestTabs?.isCurrent(tabId, expected.generation, expected.root);
      },
      convertRequestTab(tabId: string, expectedGeneration: number, tab: RequestTab, editorGeneration: number): boolean {
        const state = this.requestTabs[tabId];
        if (!state || state.root !== tab.root || state.generation !== expectedGeneration
          || tab.tabId !== tabId || tab.source.kind !== "asset" || !requestTabs?.isCurrent(tabId, tab.generation, tab.root)) return false;
        this.commitRequestTabConversion(tab, editorGeneration);
        return true;
      },
      /** Commit after canConvertRequestTab passed before any store in the conversion changes. */
      commitRequestTabConversion(tab: RequestTab, editorGeneration: number): void {
        const state = this.requestTabs[tab.tabId]!;
        state.generation = tab.generation;
        state.restoreEditorGeneration = editorGeneration;
        state.selectedCase = null;
        state.draftSnapshot = requestTabDraftSnapshot(state);
      },
      isRequestTabDirty(tabId: string): boolean {
        const value = this.requestTabs[tabId];
        return !!value && requestTabDraftSnapshot(value) !== value.draftSnapshot;
      },
      refreshRequestTabRestoreFields(tab: RequestTab, editorValue: Editor): void {
        const state = this.requestTabState(tab);
        const request = tab.source.kind === "free"
          ? editorValue.freeSessions[tab.tabId]?.request
          : (() => {
            const key = apiSessionKey(tab.root, tab.source.locator);
            return key ? editorValue.sessions[key]?.api.contract.request : undefined;
          })();
        if (!request) return;
        state.fields = state.fields.map((field) => {
          if (!field.needsInput || state.originalValues[field.path] === undefined) return field;
          return readSessionRestoreField(request, state.parameters, field.path) !== state.originalValues[field.path]
            ? { ...field, needsInput: false }
            : field;
        });
      },
      isRequestTabRunning(tabId: string): boolean {
        const state = this.requestTabs[tabId];
        return !!state && (state.starting || state.sending);
      },
      async runRequestTabInvocation(tab: RequestTab, editorValue: Editor, invocation?: DebugInvocation, runFn?: RunFn, startFn?: StartFn): Promise<void> {
        const state = this.requestTabState(tab);
        if (state.starting || state.sending || !requestTabs?.isCurrent(tab.tabId, tab.generation, tab.root)
          || getContext().root !== tab.root) return;
        let sessionGeneration: number;
        if (tab.source.kind === "asset") {
          const key = apiSessionKey(tab.root, tab.source.locator);
          const session = key ? editorValue.sessions[key] : undefined;
          if (!session || session.root !== tab.root || !sameLocator(session.locator, tab.source.locator)) return;
          sessionGeneration = session.generation;
        } else {
          const session = editorValue.freeSessions[tab.tabId];
          if (!session || session.root !== tab.root || session.draftId !== tab.source.draftId
            || !sameProject(session.project, tab.source.project)) return;
          sessionGeneration = session.generation;
        }
        const ownerIsCurrent = () => {
          if (!requestTabs.isCurrent(tab.tabId, tab.generation, tab.root) || getContext().root !== tab.root) return false;
          if (tab.source.kind === "asset") {
            const key = apiSessionKey(tab.root, tab.source.locator);
            const current = key ? editorValue.sessions[key] : undefined;
            return current?.root === tab.root && current.generation === sessionGeneration
              && sameLocator(current.locator, tab.source.locator);
          }
          const current = editorValue.freeSessions[tab.tabId];
          return current?.root === tab.root && current.generation === sessionGeneration
            && current.draftId === tab.source.draftId && sameProject(current.project, tab.source.project);
        };
        state.starting = true;
        state.sending = true;
        state.activeRunId = null;
        state.error = null;
        try {
          let result: DebugResult;
          const registerRunId = (runId: string): boolean => {
            if (!ownerIsCurrent()) return false;
            state.activeRunId = runId;
            state.starting = false;
            return true;
          };
          if (startFn) result = await startFn(registerRunId);
          else if (runFn) {
            if (!invocation) throw new Error("缺少调试调用信息");
            result = await runFn(invocation);
          } else if (invocation) {
            const started = await api.debugStart(invocation);
            if (!registerRunId(started.runId)) {
              void api.debugCancel({ runId: started.runId });
              return;
            }
            result = await api.debugWait({ runId: started.runId });
          } else throw new Error("缺少调试调用信息");
          if (ownerIsCurrent()) state.result = result;
        } catch (error) {
          if (ownerIsCurrent()) state.error = error instanceof Error ? error.message : String(error);
        } finally {
          if (requestTabs.isCurrent(tab.tabId, tab.generation, tab.root) && this.requestTabs[tab.tabId] === state) {
            state.sending = false;
            state.starting = false;
            state.activeRunId = null;
          }
        }
      },
      evictRequestTab(tabId: string): void {
        delete this.requestTabs[tabId];
      },
      async sendRequestTab(tab: RequestTab, editorValue: Editor, runFn?: RunFn): Promise<void> {
        const state = this.requestTabState(tab);
        if (state.starting || state.sending || !requestTabs?.isCurrent(tab.tabId, tab.generation, tab.root)) return;
        if (getContext().root !== tab.root) return;
        let invocation: DebugInvocation;
        if (tab.source.kind === "asset") {
          const key = apiSessionKey(tab.root, tab.source.locator);
          const session = key ? editorValue.sessions[key] : undefined;
          if (!session || session.root !== tab.root || !sameLocator(session.locator, tab.source.locator)) return;
          if (state.restoreEditorGeneration !== null && state.restoreEditorGeneration !== session.generation) {
            state.restoreEditorGeneration = null;
            state.fields = [];
            state.parameters = {};
            state.parentHistoryId = null;
            state.originalValues = {};
          }
          const restore = state.fields.some((field) => field.needsInput) ? state.fields : [];
          if (restore.length > 0) {
            state.error = "请先补齐调试恢复字段，再发送请求。";
            return;
          }
          invocation = {
            mode: "request",
            locator: copyLocator(session.locator),
            request: JSON.parse(JSON.stringify(session.api.contract.request)) as typeof session.api.contract.request,
            parameters: { ...state.parameters },
            fields: state.fields.map((field) => ({ ...field })),
            ...(state.selectedEnvironmentId ? { environmentId: state.selectedEnvironmentId } : {}),
            ...(Object.keys(state.settings).length ? { settings: { ...state.settings } } : {}),
            ...(state.parentHistoryId ? { parentHistoryId: state.parentHistoryId } : {}),
          };
        } else {
          const session = editorValue.freeSessions[tab.tabId];
          if (!session || session.root !== tab.root || session.draftId !== tab.source.draftId
            || !sameProject(session.project, tab.source.project)) return;
          if (session.request.protocol === "http") {
            try {
              const parsed = new URL(requestUrl(session.request));
              if (session.urlDraftInvalid || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) throw new Error();
            } catch {
              state.error = "请输入完整有效的 HTTP 或 HTTPS URL。";
              return;
            }
          }
          if (state.fields.some((field) => field.needsInput)) {
            state.error = "请先补齐调试恢复字段，再发送请求。";
            return;
          }
          invocation = {
            mode: "free",
            project: { ...session.project },
            draftId: session.draftId,
            request: JSON.parse(JSON.stringify(session.request)) as typeof session.request,
            parameters: { ...state.parameters },
            fields: state.fields.map((field) => ({ ...field })),
            ...(state.selectedEnvironmentId ? { environmentId: state.selectedEnvironmentId } : {}),
            ...(Object.keys(state.settings).length ? { settings: { ...state.settings } } : {}),
            ...(state.parentHistoryId ? { parentHistoryId: state.parentHistoryId } : {}),
          };
        }
        await this.runRequestTabInvocation(tab, editorValue, invocation, runFn);
      },
      async cancelRequestTab(tabId: string) {
        const state = this.requestTabs[tabId];
        if (!state?.activeRunId) return { status: "no-active" as const };
        return api.debugCancel({ runId: state.activeRunId });
      },
      applyRestore(invocation: Extract<DebugInvocation, { mode: "request" }>, sourceAvailable: boolean, editorValue: Editor) {
        const copied = JSON.parse(JSON.stringify(invocation)) as RequestDebugInvocation;
        setRestoredPreview(this, copied);
        this.restoredSourceAvailable = sourceAvailable;
        if (!sourceAvailable) {
          this.syncActiveRestore(editorValue);
          this.error = "原接口当前不可用；历史请求仅作只读查看，不能借用其他接口保存或执行。";
          return true;
        }
        const activeKey = editorValue.activeKey;
        const session = activeKey ? editorValue.sessions[activeKey] : undefined;
        const expectedKey = apiSessionKey(session?.root ?? "", invocation.locator);
        if (!session || session.root !== getContext().root || expectedKey === null
          || apiSessionKey(session.root, session.locator) !== expectedKey) {
          this.error = "恢复目标与当前接口不一致。";
          return false;
        }
        session.api.contract.request = JSON.parse(JSON.stringify(copied.request)) as typeof session.api.contract.request;
        const tab = assetTabFor(requestTabs, session.root, session.locator);
        if (tab) {
          const state = this.requestTabState(tab);
          state.restoreEditorGeneration = session.generation;
          state.fields = copied.fields.map((field) => ({ ...field }));
          state.parameters = { ...copied.parameters };
          state.parentHistoryId = copied.parentHistoryId ?? null;
          state.originalValues = Object.fromEntries(copied.fields.map((field) => [field.path, readRestoreField(copied, field.path)]));
          state.settings = { ...(copied.settings ?? {}) };
          state.selectedEnvironmentId = copied.environmentId ?? null;
          state.error = null;
          delete this.restoreByTarget[restoreStateKey(expectedKey, session.generation)];
        } else {
          this.restoreByTarget[restoreStateKey(expectedKey, session.generation)] = {
            generation: session.generation,
            fields: copied.fields.map((field) => ({ ...field })),
            parameters: { ...copied.parameters },
            parentHistoryId: copied.parentHistoryId ?? null,
            originalValues: Object.fromEntries(copied.fields.map((field) => [field.path, readRestoreField(copied, field.path)])),
          };
        }
        this.syncActiveRestore(editorValue);
        const environment = session.envs.find((item) => item.id === copied.environmentId);
        if (!tab) {
          this.settings = { ...(copied.settings ?? {}) };
          this.selectEnv(environment?.name ?? null);
        }
        this.error = null;
        return true;
      },
      async restoreHistory(input: { historyId: string; exchangeOrder: number }, expectedLocator: ApiLocator, targetEditor: Editor, canApply: () => boolean = () => true): Promise<DebugHistoryRestoreResult | null> {
        const root = getContext().root;
        const expectedKey = apiSessionKey(root, expectedLocator);
        if (!root || !expectedKey) return null;
        const epoch = ++this.restoreEpoch;
        const activeKey = targetEditor.activeKey;
        const activeSession = activeKey ? targetEditor.sessions[activeKey] : undefined;
        const activeGeneration = activeSession?.generation;
        const activeTab = requestTabs?.activeTab ?? null;
        const activeTabSnapshot = activeTab ? {
          tabId: activeTab.tabId,
          root: activeTab.root,
          generation: activeTab.generation,
          source: activeTab.source.kind === "asset"
            ? { kind: "asset" as const, locator: copyLocator(activeTab.source.locator) }
            : { kind: "free" as const, project: { ...activeTab.source.project }, draftId: activeTab.source.draftId },
        } : null;
        const activeFreeSession = activeTab?.source.kind === "free" ? targetEditor.freeSessions[activeTab.tabId] : undefined;
        const activeFreeGeneration = activeFreeSession?.generation;
        const originalTarget = targetEditor.sessions[expectedKey];
        const targetGeneration = originalTarget?.generation;
        const contextIsCurrent = () => {
          if (epoch !== this.restoreEpoch || getContext().root !== root || targetEditor.activeKey !== activeKey) return false;
          const current = activeKey ? targetEditor.sessions[activeKey] : undefined;
          if (current?.generation !== activeGeneration) return false;
          if (!requestTabs) return true;
          const currentTab = requestTabs.activeTab;
          if (currentTab?.tabId !== activeTabSnapshot?.tabId || currentTab?.generation !== activeTabSnapshot?.generation) return false;
          if (!activeTabSnapshot) return currentTab === null;
          if (!requestTabs.isCurrent(activeTabSnapshot.tabId, activeTabSnapshot.generation, root)) return false;
          if (activeTabSnapshot.source.kind === "free") {
            if (currentTab?.source.kind !== "free") return false;
            const free = targetEditor.freeSessions[activeTabSnapshot.tabId];
            return free?.generation === activeFreeGeneration && free?.root === root
              && free.draftId === activeTabSnapshot.source.draftId && sameProject(free.project, activeTabSnapshot.source.project);
          }
          return currentTab?.root === root && currentTab.source.kind === "asset"
            && sameLocator(currentTab.source.locator, activeTabSnapshot.source.locator);
        };
        this.error = null;
        this.restoredPreview = null;
        this.restoredSourceAvailable = null;
        try {
          const restored = await api.debugHistoryRestore(input);
          if (restored.invocation.mode === "free") {
            if (!contextIsCurrent() || !sameProject(projectOf(expectedLocator), restored.invocation.project)) return null;
            this.restoredSourceAvailable = restored.sourceAvailable;
            this.error = "Free 请求历史已恢复为项目级意图；当前没有请求编辑器可载入它。";
            return restored;
          }
          if (epoch !== this.restoreEpoch || getContext().root !== root || !sameLocator(restored.invocation.locator, expectedLocator)) return null;
          if (restored.invocation.mode !== "request") throw new Error("所选历史没有可恢复的请求模板。");
          if (!restored.sourceAvailable) {
            if (!contextIsCurrent()) return null;
            this.applyRestore(restored.invocation, false, targetEditor);
            return restored;
          }
          if (!canApply()) return null;
          if (!contextIsCurrent()) return null;
          const currentTarget = targetEditor.sessions[expectedKey];
          if (targetGeneration === undefined ? currentTarget !== undefined : currentTarget?.generation !== targetGeneration) return null;
          if (targetEditor.activeKey !== expectedKey) {
            const loading = targetEditor.load(restored.invocation.locator);
            const loadEpoch = targetEditor.activation;
            await loading;
            if (epoch !== this.restoreEpoch || getContext().root !== root || targetEditor.activation !== loadEpoch) return null;
          }
          const target = targetEditor.sessions[expectedKey];
          if (targetEditor.activeKey !== expectedKey || !target || target.root !== root) return null;
          if (targetGeneration !== undefined && target.generation !== targetGeneration) return null;
          const applied = this.applyRestore(restored.invocation, true, targetEditor);
          if (!applied) return null;
          if (restored.sourceChanged) this.error = "原接口定义已变化；恢复内容按历史安全投影显示。";
          return restored;
        } catch (error) {
          if (contextIsCurrent()) this.error = error instanceof Error ? error.message : String(error);
          return null;
        }
      },
      repairRestoredField(path: string, value: string, editorValue: Editor) {
        const activeKey = editorValue.activeKey;
        const session = activeKey ? editorValue.sessions[activeKey] : undefined;
        if (!session) return;
        const key = apiSessionKey(session.root, session.locator);
        const tab = assetTabFor(requestTabs, session.root, session.locator);
        const tabState = tab ? this.requestTabs[tab.tabId] : undefined;
        const tabOwnsRestore = !!tabState && tabState.root === tab!.root && tabState.generation === tab!.generation
          && tabState.restoreEditorGeneration === session.generation;
        const restored = key ? this.restoreByTarget[restoreStateKey(key, session.generation)] : undefined;
        const fields = tabOwnsRestore ? tabState.fields : restored?.fields;
        const parameters = tabOwnsRestore ? tabState.parameters : restored?.parameters;
        if (!fields?.some((field) => field.path === path && field.needsInput) || !parameters) return;
        if (path === "request") {
          try { session.api.contract.request = ApiRequestSchema.parse(JSON.parse(value)) as typeof session.api.contract.request; }
          catch { return; }
        } else if (path.startsWith("request.")) {
          if (!setSafePath(session.api.contract.request as unknown as Record<string, unknown>, path.slice("request.".length), value)) return;
        } else if (path.startsWith("parameters.")) {
          parameters[path.slice("parameters.".length)] = value;
        } else return;
        this.refreshRestoredFields(editorValue);
      },
      refreshRestoredFields(editorValue: Editor) {
        const activeKey = editorValue.activeKey;
        const session = activeKey ? editorValue.sessions[activeKey] : undefined;
        if (!session) return;
        const key = apiSessionKey(session.root, session.locator);
        const tab = assetTabFor(requestTabs, session.root, session.locator);
        const tabState = tab ? this.requestTabs[tab.tabId] : undefined;
        const tabOwnsRestore = !!tabState && tabState.root === tab!.root && tabState.generation === tab!.generation
          && tabState.restoreEditorGeneration === session.generation;
        const restored = tabOwnsRestore && tabState
          ? { fields: tabState.fields, parameters: tabState.parameters, originalValues: tabState.originalValues, setFields: (fields: DebugFieldState[]) => { tabState.fields = fields; } }
          : (() => {
            const value = key ? this.restoreByTarget[restoreStateKey(key, session.generation)] : undefined;
            return value ? { fields: value.fields, parameters: value.parameters, originalValues: value.originalValues, setFields: (fields: DebugFieldState[]) => { value.fields = fields; } } : null;
          })();
        if (!restored) return;
        const fields = restored.fields.map((field) => {
          if (!field.needsInput || restored.originalValues[field.path] === undefined) return field;
          return readSessionRestoreField(session.api.contract.request, restored.parameters, field.path) !== restored.originalValues[field.path]
            ? { ...field, needsInput: false }
            : field;
        });
        restored.setFields(fields);
        this.syncActiveRestore(editorValue);
      },
      async runCase(targetEditor: Editor, identity: CaseIdentity, runFn?: RunFn) {
        const activeKey = targetEditor.activeKey;
        const session = activeKey ? targetEditor.sessions[activeKey] : undefined;
        if (!session) return;
        const tab = assetTabFor(requestTabs, session.root, session.locator);
        const tabState = tab ? this.requestTabState(tab) : null;
        const saved = JSON.parse(session.snapshot) as typeof session.api;
        const draft = session.api.cases.find((item) => item.id === identity.caseId && item.scope === identity.scope);
        const persisted = saved.cases.find((item) => item.id === identity.caseId && item.scope === identity.scope);
        if (!draft || !persisted || JSON.stringify(draft) !== JSON.stringify(persisted)) {
          if (tabState) tabState.error = "请先显式保存当前用例，再运行已保存用例。";
          else this.error = "请先显式保存当前用例，再运行已保存用例。";
          return;
        }
        if (tab) {
          const state = tabState!;
          state.selectedCase = { caseId: identity.caseId, scope: identity.scope };
          const env = session.envs.find((item) => item.id === state.selectedEnvironmentId);
          const invocation: DebugInvocation = {
            mode: "case",
            locator: copyLocator(session.locator),
            case: { ...copyLocator(session.locator), caseId: identity.caseId, scope: identity.scope },
            ...(env ? { environmentId: env.id } : {}),
            ...(Object.keys(state.settings).length ? { settings: { ...state.settings } } : {}),
          };
          await this.runRequestTabInvocation(tab, targetEditor, invocation, runFn);
          return;
        }
        this.selectCase(identity);
        const env = session.envs.find((item) => item.name === this.selectedEnvName);
        const invocation: DebugInvocation = {
          mode: "case",
          locator: copyLocator(session.locator),
          case: { ...copyLocator(session.locator), caseId: identity.caseId, scope: identity.scope },
          ...(env ? { environmentId: env.id } : {}),
          ...(Object.keys(this.settings).length ? { settings: { ...this.settings } } : {}),
        };
        await this.runInvocation(targetEditor, invocation, runFn);
      },
      async send(targetEditor: Editor, runFn?: RunFn) {
        const activeKey = targetEditor.activeKey;
        const session = activeKey ? targetEditor.sessions[activeKey] : undefined;
        const root = session?.root;
        if (!activeKey || !session || !root || root !== getContext().root) return;
        const restore = this.restoreByTarget[restoreStateKey(activeKey, session.generation)];
        if (restore?.fields.some((field) => field.needsInput)) {
          this.error = "请先补齐调试恢复字段，再发送请求。";
          return;
        }
        const fixedLocator = copyLocator(session.locator);
        const env = session.envs.find((item) => item.name === this.selectedEnvName);
        const request = JSON.parse(JSON.stringify(session.api.contract.request)) as typeof session.api.contract.request;
        const invocation: DebugInvocation = {
          mode: "request",
          locator: fixedLocator,
          request,
          parameters: restore ? { ...restore.parameters } : {},
          fields: restore ? restore.fields.map((field) => ({ ...field })) : [],
          ...(env ? { environmentId: env.id } : {}),
          ...(Object.keys(this.settings).length ? { settings: { ...this.settings } } : {}),
          ...(restore?.parentHistoryId ? { parentHistoryId: restore.parentHistoryId } : {}),
        };
        await this.runInvocation(targetEditor, invocation, runFn);
      },
      async replay(historyId: string, targetEditor: Editor, locator: ApiLocator) {
        const root = getContext().root;
        const resultKey = apiSessionKey(root, locator);
        if (!root || !resultKey) return;
        const sourceSession = targetEditor.sessions[resultKey];
        const target: ResultTarget = { root, locator: copyLocator(locator), ...(sourceSession ? { generation: sourceSession.generation } : {}) };
        const startReplay: StartFn = async (onStarted) => {
          const started = await api.debugHistoryReplay(historyId);
          if (started.sourceKind !== "asset" || !sameLocator(started.locator, target.locator) || !onStarted?.(started.runId)) {
            void api.debugCancel({ runId: started.runId });
            throw new Error("历史重放上下文已变化；迟到运行已取消。");
          }
          return api.debugWait({ runId: started.runId });
        };
        const tab = assetTabFor(requestTabs, root, locator);
        if (tab && sourceSession?.generation !== undefined) {
          await this.runRequestTabInvocation(tab, targetEditor, undefined, undefined, startReplay);
        } else await this.runInvocation(targetEditor, undefined, undefined, target, startReplay);
      },
      async cancel() {
        const runId = this.activeRunId;
        if (!runId) return { status: "no-active" as const };
        return api.debugCancel({ runId });
      },
      async runInvocation(targetEditor: Editor, invocation: DebugInvocation | undefined, runFn?: RunFn, target?: ResultTarget, startFn?: StartFn) {
        const activeKey = targetEditor.activeKey;
        const session = activeKey ? targetEditor.sessions[activeKey] : undefined;
        const root = target?.root ?? session?.root;
        const locator = target?.locator ?? session?.locator;
        const generation = target ? target.generation : session?.generation;
        if (!root || !locator || root !== getContext().root || (!target && !session)) return;
        const resultKey = apiSessionKey(root, locator);
        if (!resultKey) return;
        const epoch = ++this.sendEpoch;
        const contextIsCurrent = () => {
          if (getContext().root !== root) return false;
          if (target) {
            const currentTarget = targetEditor.sessions[resultKey];
            return target.generation === undefined ? currentTarget === undefined : currentTarget?.generation === target.generation;
          }
          if (!activeKey || targetEditor.activeKey !== activeKey) return false;
          const current = targetEditor.sessions[activeKey];
          return getContext().root === root && !!current
            && current.generation === generation && current.root === root
            && apiSessionKey(current.root, current.locator) === resultKey;
        };
        this.sending = true;
        this.starting = true;
        this.error = null;
        this.activeResultKey = resultKey;
        try {
          let result: DebugResult;
          const registerRunId = (runId: string): boolean => {
            if (epoch !== this.sendEpoch || !contextIsCurrent()) return false;
            this.activeRunId = runId;
            this.starting = false;
            return true;
          };
          if (startFn) {
            result = await startFn(registerRunId);
          } else if (runFn) {
            if (!invocation) throw new Error("缺少调试调用信息");
            result = await runFn(invocation);
          } else if (invocation) {
            const started = await api.debugStart(invocation);
            if (epoch !== this.sendEpoch || !contextIsCurrent()) {
              void api.debugCancel({ runId: started.runId });
              return;
            }
            this.activeRunId = started.runId;
            this.starting = false;
            result = await api.debugWait({ runId: started.runId });
          } else {
            throw new Error("缺少调试调用信息");
          }
          if (contextIsCurrent() && epoch === this.sendEpoch) {
            this.results[resultKey] = result;
            this.lastResultKey = resultKey;
          }
        } catch (error) {
          if (contextIsCurrent() && epoch === this.sendEpoch) this.error = error instanceof Error ? error.message : String(error);
        } finally {
          if (epoch === this.sendEpoch) {
            this.sending = false;
            this.starting = false;
            this.activeRunId = null;
          }
        }
      },
    },
  })(createPinia());
  if (editor) watch(() => {
    const key = editor.activeKey;
    const session = key ? editor.sessions[key] : undefined;
    return [key, session?.generation, getContext().root] as const;
  }, () => store.syncActiveRestore(editor), { immediate: true });
  if (editor) {
    const guardRestoreInput = (session: { generation: number }) => {
      const sessionKey = editor.activeKey;
      if (sessionKey && store.hasUnresolvedRestoreInput(sessionKey, session.generation)) {
        throw new Error("请先补齐调试恢复字段，再保存接口。");
      }
    };
    editor.registerFullAssetSaveGuard(guardRestoreInput);
    editor.registerRequestDraftSaveGuard(guardRestoreInput);
  }
  return store;
}

function parseSafePath(path: string): Array<string | number> | null {
  const segments: Array<string | number> = [];
  let index = 0;
  while (index < path.length) {
    const start = index;
    while (index < path.length && path[index] !== "." && path[index] !== "[") index += 1;
    const name = path.slice(start, index);
    if (!name || name.includes("]") || ["__proto__", "prototype", "constructor"].includes(name)) return null;
    segments.push(name);
    while (path[index] === "[") {
      const close = path.indexOf("]", index + 1);
      if (close < 0) return null;
      const raw = path.slice(index + 1, close);
      if (!/^\d+$/.test(raw)) return null;
      segments.push(Number(raw));
      index = close + 1;
    }
    if (index === path.length) break;
    if (path[index] !== ".") return null;
    index += 1;
    if (index === path.length) return null;
  }
  return segments.length ? segments : null;
}

function setSafePath(root: Record<string, unknown>, path: string, value: string): boolean {
  const segments = parseSafePath(path);
  if (!segments) return false;
  let current: unknown = root;
  for (const segment of segments.slice(0, -1)) {
    if (Array.isArray(current)) {
      if (typeof segment !== "number" || !Object.hasOwn(current, segment)) return false;
      current = current[segment];
    } else if (typeof current === "object" && current !== null && typeof segment === "string" && Object.hasOwn(current, segment)) current = (current as Record<string, unknown>)[segment];
    else return false;
  }
  const last = segments.at(-1)!;
  if (Array.isArray(current)) {
    if (typeof last !== "number" || !Object.hasOwn(current, last)) return false;
    current[last] = value;
  } else if (typeof current === "object" && current !== null && typeof last === "string" && Object.hasOwn(current, last)) {
    (current as Record<string, unknown>)[last] = value;
  } else return false;
  return true;
}

function getSafePath(root: unknown, path: string): unknown {
  const segments = parseSafePath(path);
  if (!segments) return undefined;
  let current = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (typeof segment !== "number" || !Object.hasOwn(current, segment)) return undefined;
      current = current[segment];
    } else if (typeof current === "object" && current !== null && typeof segment === "string" && Object.hasOwn(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
    } else return undefined;
  }
  return current;
}

function snapshotValue(value: unknown): string {
  return value === undefined ? "\u0000undefined" : JSON.stringify(value);
}

export function readSessionRestoreField(request: unknown, parameters: Record<string, string>, path: string): string {
  if (path === "request") return snapshotValue(request);
  if (path.startsWith("request.")) return snapshotValue(getSafePath(request, path.slice("request.".length)));
  if (path.startsWith("parameters.")) {
    const key = path.slice("parameters.".length);
    return snapshotValue(Object.hasOwn(parameters, key) ? parameters[key] : undefined);
  }
  return "\u0000unsupported";
}

function readRestoreField(invocation: Extract<DebugInvocation, { mode: "request" }>, path: string): string {
  return readSessionRestoreField(invocation.request, invocation.parameters, path);
}

function sameLocator(left: ApiLocator, right: ApiLocator): boolean {
  return left.workspaceId === right.workspaceId && left.groupId === right.groupId && left.projectId === right.projectId
    && left.collectionId === right.collectionId && left.apiId === right.apiId
    && left.folderIds.length === right.folderIds.length && left.folderIds.every((folder, index) => folder === right.folderIds[index]);
}

function sameProject(left: ProjectLocator, right: ProjectLocator): boolean {
  return left.workspaceId === right.workspaceId && left.groupId === right.groupId && left.projectId === right.projectId;
}

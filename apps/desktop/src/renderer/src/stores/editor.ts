import { createPinia, defineStore } from "pinia";
import type { ApiAsset, ApiRequest } from "@apicc/core";
import type { ApiccApi } from "../../../shared/types.js";
import type { CaseDraftDeletion } from "../../../shared/types.js";
import type { DebugFieldState, DebugInvocation } from "@apicc/core";
import type { ApiLocator, EnvironmentLocator, ProjectLocator } from "../../../shared/locations.js";
import type { RequestTab } from "./requestTabs.js";
import { apiSessionKey, projectSessionKey, type LocalWorkspaceContext } from "./localIdentity.js";

export interface EditorSession {
  root: string;
  locator: ApiLocator;
  api: ApiAsset;
  sourceApiRevision: string;
  sourceProjectRevision: string;
  envs: Array<{ id: string; name: string; locator: EnvironmentLocator }>;
  snapshot: string;
  protocolDrafts: Partial<Record<ApiAsset["contract"]["request"]["protocol"], unknown>>;
  generation: number;
}

export interface FreeRequestSession {
  tabId: string;
  root: string;
  project: ProjectLocator;
  draftId: string;
  request: ApiRequest;
  protocolDrafts: Partial<Record<ApiRequest["protocol"], unknown>>;
  sourceProjectRevision: string;
  draftRevision: number;
  envs: Array<{ id: string; name: string; locator: EnvironmentLocator }>;
  snapshot: string;
  urlDraft: string;
  urlDraftInvalid: boolean;
  generation: number;
}

export type FullAssetSaveGuard = (session: EditorSession) => void;
export type RequestDraftSaveGuard = (session: EditorSession) => void;

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function locatorCopy(locator: ApiLocator): ApiLocator {
  return { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId,
    collectionId: locator.collectionId, folderIds: [...locator.folderIds], apiId: locator.apiId };
}

function projectLocator(locator: ApiLocator): ProjectLocator {
  return { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId };
}

function activeSession(state: { sessions: Record<string, EditorSession>; activeKey: string | null }): EditorSession | null {
  return state.activeKey === null ? null : state.sessions[state.activeKey] ?? null;
}

/** Asset editor sessions are keyed by directory plus the full immutable API location. */
export function useEditorStore(api: ApiccApi, getContext: () => LocalWorkspaceContext) {
  const fullAssetSaveGuards = new Set<FullAssetSaveGuard>();
  const requestDraftSaveGuards = new Set<RequestDraftSaveGuard>();
  return defineStore("editor", {
    state: () => ({
      sessions: {} as Record<string, EditorSession>,
      freeSessions: {} as Record<string, FreeRequestSession>,
      activeKey: null as string | null,
      activeFreeId: null as string | null,
      generation: 0,
      activation: 0,
      loadEpoch: 0,
      projectLoadEpochs: {} as Record<string, number>,
      freeLoadEpochs: {} as Record<string, number>,
    }),
    getters: {
      locator(state): ApiLocator | null {
        const session = activeSession(state);
        return session ? locatorCopy(session.locator) : null;
      },
      apiId(state): string | null {
        return activeSession(state)?.locator.apiId ?? null;
      },
      api(state): ApiAsset | null {
        return activeSession(state)?.api ?? null;
      },
      activeFreeSession(state): FreeRequestSession | null {
        return state.activeFreeId ? state.freeSessions[state.activeFreeId] ?? null : null;
      },
      activeRequest(state): ApiRequest | null {
        if (state.activeFreeId) return state.freeSessions[state.activeFreeId]?.request ?? null;
        return activeSession(state)?.api.contract.request ?? null;
      },
      envs(state): EditorSession["envs"] {
        if (state.activeFreeId) return state.freeSessions[state.activeFreeId]?.envs ?? [];
        return activeSession(state)?.envs ?? [];
      },
      snapshot(state): string {
        if (state.activeFreeId) return state.freeSessions[state.activeFreeId]?.snapshot ?? "";
        return activeSession(state)?.snapshot ?? "";
      },
      dirty(state): boolean {
        if (state.activeFreeId) {
          const free = state.freeSessions[state.activeFreeId];
          return !!free && (JSON.stringify(free.request) !== free.snapshot || free.urlDraftInvalid);
        }
        const session = activeSession(state);
        return session !== null && JSON.stringify(session.api) !== session.snapshot;
      },
      readOnly(): boolean {
        return getContext().readOnly;
      },
    },
    actions: {
      registerFullAssetSaveGuard(guard: FullAssetSaveGuard): void {
        fullAssetSaveGuards.add(guard);
      },
      registerRequestDraftSaveGuard(guard: RequestDraftSaveGuard): void {
        requestDraftSaveGuards.add(guard);
      },
      async load(locator: ApiLocator, isCurrent: () => boolean = () => true): Promise<void> {
        const context = getContext();
        const root = context.root;
        const fixedLocator = locatorCopy(locator);
        const key = apiSessionKey(root, fixedLocator);
        const projectKey = projectSessionKey(root, projectLocator(fixedLocator));
        const loadEpoch = ++this.loadEpoch;
        this.projectLoadEpochs[projectKey] = loadEpoch;
        const existing = this.sessions[key];
        const activation = ++this.activation;
        this.activeFreeId = null;
        if (!isCurrent()) return;
        if (existing) {
          this.activeKey = key;
          return;
        }

        const detail = await api.apiGet(fixedLocator);
        if (activation !== this.activation || this.projectLoadEpochs[projectKey] !== loadEpoch || getContext().root !== root || !isCurrent()) return;
        if (this.sessions[key]) {
          this.activeKey = key;
          return;
        }
        const session: EditorSession = {
          root,
          locator: fixedLocator,
          api: copy(detail.api),
          sourceApiRevision: detail.sourceApiRevision,
          sourceProjectRevision: detail.sourceProjectRevision,
          envs: copy(detail.envs),
          snapshot: JSON.stringify(detail.api),
          protocolDrafts: {},
          generation: ++this.generation,
        };
        this.sessions[key] = session;
        this.activeKey = key;
      },

      async loadFreeRequestTab(tab: RequestTab, isCurrent: () => boolean = () => true): Promise<FreeRequestSession | null> {
        if (tab.source.kind !== "free") return null;
        const existing = this.freeSessions[tab.tabId];
        if (existing) {
          if (existing.root === tab.root && existing.draftId === tab.source.draftId) return existing;
          delete this.freeSessions[tab.tabId];
        }
        if (!tab.root || getContext().root !== tab.root || !isCurrent()) return null;
        const loadEpoch = (this.freeLoadEpochs[tab.tabId] ?? 0) + 1;
        this.freeLoadEpochs[tab.tabId] = loadEpoch;
        const generation = ++this.generation;
        const detail = await api.debugProjectContext({ ...tab.source.project });
        if (this.freeLoadEpochs[tab.tabId] !== loadEpoch) {
          const current = this.freeSessions[tab.tabId];
          return current?.root === tab.root && current.draftId === tab.source.draftId && sameProject(current.project, tab.source.project)
            ? current : null;
        }
        if (!isCurrent() || getContext().root !== tab.root || !sameProject(detail.project, tab.source.project)) return null;
        const loaded = this.freeSessions[tab.tabId];
        if (loaded?.root === tab.root && loaded.draftId === tab.source.draftId && sameProject(loaded.project, tab.source.project)) return loaded;
        const request = newFreeRequest();
        const session: FreeRequestSession = {
          tabId: tab.tabId,
          root: tab.root,
          project: { ...tab.source.project },
          draftId: tab.source.draftId,
          request,
          protocolDrafts: {},
          sourceProjectRevision: detail.sourceProjectRevision,
          draftRevision: 0,
          envs: copy(detail.envs),
          snapshot: JSON.stringify(request),
          urlDraft: requestUrl(request),
          urlDraftInvalid: false,
          generation,
        };
        if (!isCurrent() || getContext().root !== tab.root) return null;
        this.freeSessions[tab.tabId] = session;
        this.activeKey = null;
        this.activeFreeId = tab.tabId;
        return session;
      },

      async applyFreeHistoryRequest(
        tab: RequestTab,
        invocation: Extract<DebugInvocation, { mode: "free" }>,
        isCurrent: () => boolean = () => true,
      ): Promise<FreeRequestSession | null> {
        if (tab.source.kind !== "free" || !sameProject(tab.source.project, invocation.project)) return null;
        const session = await this.loadFreeRequestTab(tab, isCurrent);
        if (!session || !isCurrent() || getContext().root !== tab.root || this.freeSessions[tab.tabId] !== session
          || session.root !== tab.root || session.draftId !== tab.source.draftId
          || !sameProject(session.project, invocation.project)) return null;
        session.request = copy(invocation.request);
        session.snapshot = JSON.stringify(session.request);
        session.protocolDrafts = {};
        session.urlDraft = requestUrl(session.request);
        session.urlDraftInvalid = false;
        return session;
      },

      canAdoptCreatedApiForFreeTab(
        tab: RequestTab,
        expectedFreeGeneration: number,
        submittedRequest: ApiRequest,
        detail: { api: ApiAsset; locator: ApiLocator },
        expectedUrlDraft: Pick<FreeRequestSession, "urlDraft" | "urlDraftInvalid" | "draftRevision">,
      ): boolean {
        if (tab.source.kind !== "free" || getContext().root !== tab.root
          || !sameProject(projectLocator(detail.locator), tab.source.project)) return false;
        const free = this.freeSessions[tab.tabId];
        const key = apiSessionKey(tab.root, detail.locator);
        return !!free && !!key && free.root === tab.root && free.generation === expectedFreeGeneration
          && free.draftId === tab.source.draftId && sameProject(free.project, tab.source.project)
          && free.urlDraft === expectedUrlDraft.urlDraft && free.urlDraftInvalid === expectedUrlDraft.urlDraftInvalid
          && free.draftRevision === expectedUrlDraft.draftRevision
          && JSON.stringify(free.request) === JSON.stringify(submittedRequest)
          && JSON.stringify(detail.api.contract.request) === JSON.stringify(submittedRequest)
          && !this.sessions[key];
      },

      adoptCreatedApiForFreeTab(
        tab: RequestTab,
        expectedFreeGeneration: number,
        submittedRequest: ApiRequest,
        detail: {
          api: ApiAsset;
          locator: ApiLocator;
          sourceApiRevision: string;
          sourceProjectRevision: string;
          envs: EditorSession["envs"];
        },
        expectedUrlDraft: Pick<FreeRequestSession, "urlDraft" | "urlDraftInvalid" | "draftRevision">,
      ): EditorSession | null {
        if (!this.canAdoptCreatedApiForFreeTab(tab, expectedFreeGeneration, submittedRequest, detail, expectedUrlDraft)) return null;
        if (tab.source.kind !== "free") return null;
        const key = apiSessionKey(tab.root, detail.locator);
        if (!key) return null;
        const free = this.freeSessions[tab.tabId]!;
        const session: EditorSession = {
          root: tab.root,
          locator: locatorCopy(detail.locator),
          api: copy(detail.api),
          sourceApiRevision: detail.sourceApiRevision,
          sourceProjectRevision: detail.sourceProjectRevision,
          envs: copy(detail.envs),
          snapshot: JSON.stringify(detail.api),
          protocolDrafts: copy(free.protocolDrafts),
          generation: ++this.generation,
        };
        this.sessions[key] = session;
        this.freeLoadEpochs[tab.tabId] = (this.freeLoadEpochs[tab.tabId] ?? 0) + 1;
        delete this.freeSessions[tab.tabId];
        if (this.activeFreeId === tab.tabId) {
          this.activeFreeId = null;
          this.activeKey = key;
        }
        return session;
      },

      activateFree(tabId: string): boolean {
        if (!this.freeSessions[tabId]) return false;
        this.activation += 1;
        this.activeKey = null;
        this.activeFreeId = tabId;
        return true;
      },

      isRequestDirty(tab: RequestTab): boolean {
        if (tab.source.kind === "free") {
          const free = this.freeSessions[tab.tabId];
          return !!free && free.root === tab.root && free.draftId === tab.source.draftId
            && (JSON.stringify(free.request) !== free.snapshot || free.urlDraftInvalid);
        }
        const key = apiSessionKey(tab.root, tab.source.locator);
        const session = key ? this.sessions[key] : undefined;
        return !!session && JSON.stringify(session.api) !== session.snapshot;
      },

      evictRequestTab(tab: RequestTab): void {
        if (tab.source.kind === "free") {
          this.freeLoadEpochs[tab.tabId] = (this.freeLoadEpochs[tab.tabId] ?? 0) + 1;
          const current = this.freeSessions[tab.tabId];
          if (current?.root === tab.root && current.draftId === tab.source.draftId) delete this.freeSessions[tab.tabId];
          if (this.activeFreeId === tab.tabId) this.activeFreeId = null;
          return;
        }
        const key = apiSessionKey(tab.root, tab.source.locator);
        if (key) delete this.sessions[key];
        if (this.activeKey === key) this.activeKey = null;
      },

      async save(): Promise<ApiAsset | null> {
        const current = activeSession(this);
        if (!current) return null;
        const context = getContext();
        if (context.root !== current.root) throw new Error("当前工作区已切换，拒绝保存到其他工作区");
        if (context.readOnly) throw new Error("工作区处于只读模式，不能保存接口");
        for (const guard of fullAssetSaveGuards) guard(current);

        const key = this.activeKey!;
        const generation = current.generation;
        const fixedLocator = locatorCopy(current.locator);
        const expectedSourceApiRevision = current.sourceApiRevision;
        const submitted = copy(current.api);
        const submittedSnapshot = JSON.stringify(submitted);
        const saved = await api.apiSave(fixedLocator, submitted, expectedSourceApiRevision);
        const original = this.sessions[key];
        if (original?.generation === generation) {
          original.snapshot = submittedSnapshot;
          original.sourceApiRevision = saved.sourceApiRevision;
          original.sourceProjectRevision = saved.sourceProjectRevision;
        }
        return copy(saved.api);
      },

      async saveRequestDraft(fields: DebugFieldState[] = []): Promise<ApiAsset | null> {
        const current = activeSession(this);
        if (!current) return null;
        const context = getContext();
        if (context.root !== current.root) throw new Error("当前工作区已切换，拒绝保存到其他工作区");
        if (context.readOnly) throw new Error("工作区处于只读模式，不能保存接口请求");
        for (const guard of requestDraftSaveGuards) guard(current);
        const key = this.activeKey!;
        const generation = current.generation;
        const fixedLocator = locatorCopy(current.locator);
        const submitted = copy(current.api.contract.request);
        const baseline = copy(JSON.parse(current.snapshot) as ApiAsset);
        baseline.contract.request = copy(submitted);
        const saved = await api.apiRequestDraftSave(fixedLocator, submitted, current.sourceApiRevision, fields);
        const original = this.sessions[key];
        if (original?.generation === generation) {
          original.sourceApiRevision = saved.sourceApiRevision;
          original.snapshot = JSON.stringify(baseline);
        }
        return copy(current.api);
      },

      async saveCaseDraft(identity: { caseId: string; scope: string }, deletedCases: CaseDraftDeletion[] = [], fields: DebugFieldState[] = []): Promise<ApiAsset | null> {
        const current = activeSession(this);
        if (!current) return null;
        const context = getContext();
        if (context.root !== current.root) throw new Error("当前工作区已切换，拒绝保存到其他工作区");
        if (context.readOnly) throw new Error("工作区处于只读模式，不能保存用例");
        const testCase = current.api.cases.find((item) => item.id === identity.caseId && item.scope === identity.scope);
        if (!testCase) throw new Error(`Case not found at complete API locator: ${JSON.stringify({ ...current.locator, ...identity })}`);
        const key = this.activeKey!;
        const generation = current.generation;
        const fixedLocator = locatorCopy(current.locator);
        const caseLocator = { ...fixedLocator, caseId: identity.caseId, scope: identity.scope };
        const submitted = copy(testCase);
        const baseline = copy(JSON.parse(current.snapshot) as ApiAsset);
        const deletedKeys = new Set(deletedCases.map((item) => `${item.caseId}\0${item.scope}`));
        baseline.cases = baseline.cases.filter((item) => !deletedKeys.has(`${item.id}\0${item.scope}`));
        const previousIndex = baseline.cases.findIndex((item) => item.id === identity.caseId && item.scope === identity.scope);
        if (previousIndex < 0) baseline.cases.push(copy(submitted));
        else baseline.cases[previousIndex] = copy(submitted);
        const saved = await api.caseDraftSave(caseLocator, submitted, current.sourceApiRevision, deletedCases.map((item) => ({ ...item })), fields.map((field) => ({ ...field })));
        const original = this.sessions[key];
        if (original?.generation === generation) {
          original.sourceApiRevision = saved.sourceApiRevision;
          original.snapshot = JSON.stringify(baseline);
        }
        return copy(current.api);
      },

      async reloadEnvs(): Promise<void> {
        if (this.activeFreeId) {
          const key = this.activeFreeId;
          const current = this.freeSessions[key];
          if (!current) return;
          const generation = current.generation;
          const root = current.root;
          const detail = await api.debugProjectContext({ ...current.project });
          const original = this.freeSessions[key];
          if (original?.generation === generation && original.root === root && getContext().root === root
            && sameProject(detail.project, original.project)) {
            original.envs = copy(detail.envs);
            original.sourceProjectRevision = detail.sourceProjectRevision;
          }
          return;
        }
        const current = activeSession(this);
        if (!current) return;
        const key = this.activeKey!;
        const generation = current.generation;
        const root = current.root;
        const fixedLocator = locatorCopy(current.locator);
        const detail = await api.apiGet(fixedLocator);
        const original = this.sessions[key];
        if (original?.generation === generation && original.root === root) original.envs = copy(detail.envs);
      },

      deactivate(): void {
        this.activation += 1;
        this.activeKey = null;
        this.activeFreeId = null;
      },

      evictProject(locator: ProjectLocator, root: string): void {
        const key = projectSessionKey(root, locator);
        this.projectLoadEpochs[key] = ++this.loadEpoch;
        let activeEvicted = false;
        for (const [sessionKey, session] of Object.entries(this.sessions)) {
          if (session.root !== root || projectSessionKey(session.root, projectLocator(session.locator)) !== key) continue;
          delete this.sessions[sessionKey];
          if (this.activeKey === sessionKey) activeEvicted = true;
        }
        for (const [tabId, session] of Object.entries(this.freeSessions)) {
          if (session.root === root && sameProject(session.project, locator)) {
            this.freeLoadEpochs[tabId] = (this.freeLoadEpochs[tabId] ?? 0) + 1;
            delete this.freeSessions[tabId];
            if (this.activeFreeId === tabId) this.activeFreeId = null;
          }
        }
        if (activeEvicted) {
          this.activeKey = null;
        }
      },

      isProjectDirty(locator: ProjectLocator, root: string): boolean {
        const key = projectSessionKey(root, locator);
        const assetDirty = Object.values(this.sessions).some((session) => session.root === root
          && projectSessionKey(session.root, projectLocator(session.locator)) === key
          && JSON.stringify(session.api) !== session.snapshot);
        return assetDirty || Object.values(this.freeSessions).some((session) => session.root === root
          && sameProject(session.project, locator)
          && (JSON.stringify(session.request) !== session.snapshot || session.urlDraftInvalid));
      },
    },
  })(createPinia());
}

function newFreeRequest(): ApiRequest {
  return {
    protocol: "http",
    method: "GET",
    baseUrl: "",
    path: "/",
    pathParams: [],
    query: [],
    headers: [],
    cookies: [],
    auth: { kind: "none" },
    body: { kind: "none" },
  };
}

function requestUrl(request: ApiRequest): string {
  const base = request.baseUrl.replace(/\/$/, "");
  const path = request.path.startsWith("/") ? request.path : `/${request.path}`;
  if (request.protocol !== "http") return `${base}${path}`;
  const query = request.query.filter((item) => item.kind === "inline" && item.enabled !== false && item.name)
    .map((item) => `${encodeURIComponent(item.kind === "inline" ? item.name : "")}=${encodeURIComponent(item.value ?? "")}`).join("&");
  return `${base}${path}${query ? `?${query}` : ""}`;
}

function sameProject(left: ProjectLocator, right: ProjectLocator): boolean {
  return left.workspaceId === right.workspaceId && left.groupId === right.groupId && left.projectId === right.projectId;
}

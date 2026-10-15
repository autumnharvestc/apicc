import { createPinia, defineStore } from "pinia";
import type { ApiAsset } from "@apicc/core";
import type { ApiccApi } from "../../../shared/types.js";
import type { CaseDraftDeletion } from "../../../shared/types.js";
import type { DebugFieldState } from "@apicc/core";
import type { ApiLocator, EnvironmentLocator, ProjectLocator } from "../../../shared/locations.js";
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

export type FullAssetSaveGuard = (session: EditorSession) => void;

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
  return defineStore("editor", {
    state: () => ({
      sessions: {} as Record<string, EditorSession>,
      activeKey: null as string | null,
      generation: 0,
      activation: 0,
      loadEpoch: 0,
      projectLoadEpochs: {} as Record<string, number>,
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
      envs(state): EditorSession["envs"] {
        return activeSession(state)?.envs ?? [];
      },
      snapshot(state): string {
        return activeSession(state)?.snapshot ?? "";
      },
      dirty(state): boolean {
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
      async load(locator: ApiLocator): Promise<void> {
        const context = getContext();
        const root = context.root;
        const fixedLocator = locatorCopy(locator);
        const key = apiSessionKey(root, fixedLocator);
        const projectKey = projectSessionKey(root, projectLocator(fixedLocator));
        const loadEpoch = ++this.loadEpoch;
        this.projectLoadEpochs[projectKey] = loadEpoch;
        const existing = this.sessions[key];
        const activation = ++this.activation;
        if (existing) {
          this.activeKey = key;
          return;
        }

        const detail = await api.apiGet(fixedLocator);
        if (activation !== this.activation || this.projectLoadEpochs[projectKey] !== loadEpoch || getContext().root !== root) return;
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
        if (activeEvicted) {
          this.activeKey = null;
        }
      },

      isProjectDirty(locator: ProjectLocator, root: string): boolean {
        const key = projectSessionKey(root, locator);
        return Object.values(this.sessions).some((session) => session.root === root
          && projectSessionKey(session.root, projectLocator(session.locator)) === key
          && JSON.stringify(session.api) !== session.snapshot);
      },
    },
  })(createPinia());
}

import { createPinia, defineStore } from "pinia";
import type { ApiAsset } from "@apicc/core";
import type { ApiccApi } from "../../../shared/types.js";
import type { ApiLocator, EnvironmentLocator, ProjectLocator } from "../../../shared/locations.js";
import { apiSessionKey, projectSessionKey, type LocalWorkspaceContext } from "./localIdentity.js";

export interface EditorSession {
  root: string;
  locator: ApiLocator;
  api: ApiAsset;
  envs: Array<{ id: string; name: string; locator: EnvironmentLocator }>;
  snapshot: string;
  protocolDrafts: Partial<Record<ApiAsset["contract"]["request"]["protocol"], unknown>>;
  generation: number;
}

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

        const key = this.activeKey!;
        const generation = current.generation;
        const fixedLocator = locatorCopy(current.locator);
        const submitted = copy(current.api);
        const submittedSnapshot = JSON.stringify(submitted);
        const saved = await api.apiSave(fixedLocator, submitted);
        const original = this.sessions[key];
        if (original?.generation === generation) original.snapshot = submittedSnapshot;
        return copy(saved);
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

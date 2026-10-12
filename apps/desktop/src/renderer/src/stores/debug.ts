import { createPinia, defineStore } from "pinia";
import type { ApiccApi, DebugInput, DebugOutput } from "../../../shared/types.js";
import type { ApiLocator, ProjectLocator } from "../../../shared/locations.js";
import type { useEditorStore } from "./editor.js";
import type { LocalWorkspaceContext } from "./localIdentity.js";
import { apiSessionKey, projectSessionKey } from "./localIdentity.js";
import type { CaseIdentity } from "./cases.js";

type Editor = ReturnType<typeof useEditorStore>;
type SendFn = (input: DebugInput) => Promise<DebugOutput>;

function projectOf(locator: ApiLocator): ProjectLocator {
  return { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId };
}

function copyLocator(locator: ApiLocator): ApiLocator {
  return { ...projectOf(locator), collectionId: locator.collectionId, folderIds: [...locator.folderIds], apiId: locator.apiId };
}

/** Debug results and environment selection are scoped to the root plus the full local locator. */
export function useDebugStore(api: ApiccApi, editor?: Editor, getContext: () => LocalWorkspaceContext = () => ({ root: "", readOnly: false })) {
  return defineStore("debug", {
    state: () => ({
      sending: false,
      results: {} as Record<string, DebugOutput>,
      lastResultKey: null as string | null,
      error: null as string | null,
      activeProjectKey: null as string | null,
      envByProject: {} as Record<string, string | null>,
      selectedEnvName: null as string | null,
      selectedCase: null as CaseIdentity | null,
      sendEpoch: 0,
    }),
    getters: {
      result(state): DebugOutput | null {
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
      async runCase(targetEditor: Editor, identity: CaseIdentity) {
        this.selectCase(identity);
        await this.send(targetEditor);
      },
      async send(targetEditor: Editor, sendFn: SendFn = (input) => api.debugSend(input), explicitEnvName?: string) {
        const activeKey = targetEditor.activeKey;
        const session = activeKey ? targetEditor.sessions[activeKey] : undefined;
        const root = session?.root;
        if (!activeKey || !session || !root || root !== getContext().root) return;
        const generation = session.generation;
        const fixedLocator = copyLocator(session.locator);
        const resultKey = apiSessionKey(root, fixedLocator);
        const cases = session.api.cases;
        const chosen = this.selectedCase && cases.some((item) => item.id === this.selectedCase!.caseId && item.scope === this.selectedCase!.scope)
          ? this.selectedCase
          : cases[0] ? { caseId: cases[0].id, scope: cases[0].scope } : null;
        const caseId = chosen?.caseId;
        const envName = explicitEnvName !== undefined
          ? explicitEnvName && session.envs.some((item) => item.name === explicitEnvName) ? explicitEnvName : undefined
          : this.selectedEnvName && session.envs.some((item) => item.name === this.selectedEnvName) ? this.selectedEnvName : undefined;
        if (!caseId) return;
        const contextIsCurrent = () => {
          const current = targetEditor.sessions[activeKey];
          return getContext().root === root && targetEditor.activeKey === activeKey
            && current?.generation === generation && current.root === root
            && apiSessionKey(current.root, current.locator) === resultKey;
        };
        const epoch = ++this.sendEpoch;
        this.sending = true;
        this.error = null;
        try {
          if (targetEditor.dirty) await targetEditor.save();
          if (!contextIsCurrent()) return;
          const output = await sendFn({ locator: fixedLocator, caseId, envName });
          this.results[resultKey] = output;
          this.lastResultKey = resultKey;
        } catch (error) {
          if (contextIsCurrent()) {
            this.error = error instanceof Error ? error.message : String(error);
          }
        } finally {
          if (epoch === this.sendEpoch) this.sending = false;
        }
      },
    },
  })(createPinia());
}

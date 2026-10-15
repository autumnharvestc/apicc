import { createPinia, defineStore } from "pinia";
import { watch } from "vue";
import type { ApiccApi } from "../../../shared/types.js";
import type { DebugFieldState, DebugInvocation, DebugResult, RequestSettingsOverride } from "@apicc/core";
import { ApiRequestSchema } from "@apicc/core/schema";
import type { DebugHistoryRestoreResult } from "../../../shared/types.js";
import type { ApiLocator, ProjectLocator } from "../../../shared/locations.js";
import type { useEditorStore } from "./editor.js";
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

function restoreStateKey(sessionKey: string, generation: number): string {
  return `${sessionKey}\0${generation}`;
}

function setRestoredPreview(target: object, value: RequestDebugInvocation): void {
  Reflect.set(target, "restoredPreview", value);
}

function projectOf(locator: ApiLocator): ProjectLocator {
  return { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId };
}

function copyLocator(locator: ApiLocator): ApiLocator {
  return { ...projectOf(locator), collectionId: locator.collectionId, folderIds: [...locator.folderIds], apiId: locator.apiId };
}

/** Debug drafts never save a formal asset. Results and active jobs are root/full-locator scoped. */
export function useDebugStore(api: ApiccApi, editor?: Editor, getContext: () => LocalWorkspaceContext = () => ({ root: "", readOnly: false })) {
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
      restoredSourceAvailable: null as boolean | null,
      restoredOriginalValues: {} as Record<string, string>,
      restoreByTarget: {} as Record<string, RestoreState>,
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
        return this.restoreByTarget[restoreStateKey(sessionKey, generation)]?.fields.some((field) => field.needsInput) ?? false;
      },
      restoreForSession(sessionKey: string, generation: number): RestoreState | null {
        const value = this.restoreByTarget[restoreStateKey(sessionKey, generation)];
        return value ? JSON.parse(JSON.stringify(value)) as RestoreState : null;
      },
      syncActiveRestore(editorValue: Editor) {
        const activeKey = editorValue.activeKey;
        const session = activeKey ? editorValue.sessions[activeKey] : undefined;
        const key = session && session.root === getContext().root ? apiSessionKey(session.root, session.locator) : null;
        const restored = key && session ? this.restoreByTarget[restoreStateKey(key, session.generation)] : undefined;
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
        this.restoreByTarget[restoreStateKey(expectedKey, session.generation)] = {
          generation: session.generation,
          fields: copied.fields.map((field) => ({ ...field })),
          parameters: { ...copied.parameters },
          parentHistoryId: copied.parentHistoryId ?? null,
          originalValues: Object.fromEntries(copied.fields.map((field) => [field.path, readRestoreField(copied, field.path)])),
        };
        this.syncActiveRestore(editorValue);
        this.settings = { ...(copied.settings ?? {}) };
        const environment = session.envs.find((item) => item.id === copied.environmentId);
        this.selectEnv(environment?.name ?? null);
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
        const originalTarget = targetEditor.sessions[expectedKey];
        const targetGeneration = originalTarget?.generation;
        const contextIsCurrent = () => {
          if (epoch !== this.restoreEpoch || getContext().root !== root || targetEditor.activeKey !== activeKey) return false;
          const current = activeKey ? targetEditor.sessions[activeKey] : undefined;
          return current?.generation === activeGeneration;
        };
        this.error = null;
        this.restoredPreview = null;
        this.restoredSourceAvailable = null;
        try {
          const restored = await api.debugHistoryRestore(input);
          if (epoch !== this.restoreEpoch || getContext().root !== root || !sameLocator(restored.invocation.locator, expectedLocator)) return null;
          if (restored.invocation.mode !== "request") throw new Error("所选历史没有可恢复的请求模板。");
          if (!restored.sourceAvailable) {
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
          if (epoch === this.restoreEpoch && getContext().root === root) this.error = error instanceof Error ? error.message : String(error);
          return null;
        }
      },
      repairRestoredField(path: string, value: string, editorValue: Editor) {
        const activeKey = editorValue.activeKey;
        const session = activeKey ? editorValue.sessions[activeKey] : undefined;
        if (!session) return;
        const key = apiSessionKey(session.root, session.locator);
        const restored = key ? this.restoreByTarget[restoreStateKey(key, session.generation)] : undefined;
        if (!restored?.fields.some((field) => field.path === path && field.needsInput)) return;
        if (path === "request") {
          try { session.api.contract.request = ApiRequestSchema.parse(JSON.parse(value)) as typeof session.api.contract.request; }
          catch { return; }
        } else if (path.startsWith("request.")) {
          if (!setSafePath(session.api.contract.request as unknown as Record<string, unknown>, path.slice("request.".length), value)) return;
        } else if (path.startsWith("parameters.")) {
          restored.parameters[path.slice("parameters.".length)] = value;
        } else return;
        this.refreshRestoredFields(editorValue);
      },
      refreshRestoredFields(editorValue: Editor) {
        const activeKey = editorValue.activeKey;
        const session = activeKey ? editorValue.sessions[activeKey] : undefined;
        if (!session) return;
        const key = apiSessionKey(session.root, session.locator);
        const restored = key ? this.restoreByTarget[restoreStateKey(key, session.generation)] : undefined;
        if (!restored) return;
        restored.fields = restored.fields.map((field) => {
          if (!field.needsInput || restored.originalValues[field.path] === undefined) return field;
          return readSessionRestoreField(session.api.contract.request, restored.parameters, field.path) !== restored.originalValues[field.path]
            ? { ...field, needsInput: false }
            : field;
        });
        this.syncActiveRestore(editorValue);
      },
      async runCase(targetEditor: Editor, identity: CaseIdentity, runFn?: RunFn) {
        this.selectCase(identity);
        const activeKey = targetEditor.activeKey;
        const session = activeKey ? targetEditor.sessions[activeKey] : undefined;
        if (!session) return;
        const saved = JSON.parse(session.snapshot) as typeof session.api;
        const draft = session.api.cases.find((item) => item.id === identity.caseId && item.scope === identity.scope);
        const persisted = saved.cases.find((item) => item.id === identity.caseId && item.scope === identity.scope);
        if (!draft || !persisted || JSON.stringify(draft) !== JSON.stringify(persisted)) {
          this.error = "请先显式保存当前用例，再运行已保存用例。";
          return;
        }
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
        await this.runInvocation(targetEditor, undefined, undefined, target, async (onStarted) => {
          const started = await api.debugHistoryReplay(historyId);
          if (!sameLocator(started.locator, target.locator) || !onStarted?.(started.runId)) {
            void api.debugCancel({ runId: started.runId });
            throw new Error("历史重放上下文已变化；迟到运行已取消。");
          }
          return api.debugWait({ runId: started.runId });
        });
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
  if (editor) editor.registerFullAssetSaveGuard(() => {
    const sessionKey = editor.activeKey;
    const session = sessionKey ? editor.sessions[sessionKey] : undefined;
    if (sessionKey && session && store.hasUnresolvedRestoreInput(sessionKey, session.generation)) {
      throw new Error("请先补齐调试恢复字段，再保存接口。");
    }
  });
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

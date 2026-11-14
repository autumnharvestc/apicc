import { computed, reactive, ref, shallowReactive, shallowRef, watch, type ComputedRef } from "vue";
import type { ApiRequest, ContractProject } from "@apicc/core";
import { isDefaultCollectionId } from "@apicc/core/schema";
import { z } from "zod";
import { OnlineDirectoryWriteSchema, OnlineExecutionContextSchema } from "../../../shared/online/execution.js";
import type { OnlineDirectoryChange, OnlineDirectoryTarget, OnlineDirectoryWrite, OnlineExecutionContext } from "../../../shared/online/execution.js";
import type { OnlineTreeNodeDTO } from "../../../shared/tree-dto.js";
import type { createOnlineStore } from "./online.js";
import { isOnlineDirectoryBlank, onlineContainerTarget } from "../onlineDirectory.js";

type Draft = {
  id: string; name: string; request: ApiRequest; expectedVersion: string; expectedContractProjectId: string | null;
  initialProjectId: string; caseId: string; defaultNonce: string; target: OnlineDirectoryTarget | null;
  pending: OnlineDirectoryWrite | null; busy: boolean; error: string; needsTarget: boolean;
};

const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const scopeKey = (context: OnlineExecutionContext | null) => context ? JSON.stringify(context) : "";
const emptyRequest = (): ApiRequest => ({ protocol: "http", method: "GET", baseUrl: "", path: "/", pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, body: { kind: "none" } });
const TREE_STORAGE_KEY = "apicc.onlineDirectory";
const treeSchema = z.object({ filter: z.string(), expanded: z.array(z.string()), selected: z.string() });
type TreeState = z.infer<typeof treeSchema>;
type TabScope = { workspaceId: string; projectId: string; baseUrl?: string; ownerId?: string };

function rememberedTrees(storage: Storage) {
  const result = new Map<string, TreeState>();
  try {
    const entries = z.array(z.tuple([OnlineExecutionContextSchema, treeSchema])).parse(JSON.parse(storage.getItem(TREE_STORAGE_KEY) ?? "[]"));
    for (const [context, tree] of entries) result.set(scopeKey(context), tree);
  } catch { /* Directory preferences are optional. */ }
  return result;
}

export function useOnlineDirectory(online: ReturnType<typeof createOnlineStore>, context: ComputedRef<OnlineExecutionContext | null>, root: ComputedRef<OnlineTreeNodeDTO | null>, selectSaved: (path: string) => void, storage = localStorage) {
  const key = computed(() => scopeKey(context.value));
  const drafts = shallowReactive(new Map<string, Draft>());
  const pendingStructure = shallowReactive(new Map<string, OnlineDirectoryWrite>());
  const writingStructure = shallowReactive(new Map<string, symbol>());
  const trees = reactive(rememberedTrees(storage));
  const savedPaths = new Map<string, string>();
  const draft = computed(() => drafts.get(key.value));
  const tree = computed(() => trees.get(key.value) ?? { filter: "", expanded: [], selected: "" });
  const writable = computed(() => !!root.value && !!key.value && key.value === scopeKey(online.execution.context) && online.canWriteDirectory(context.value)
    && !online.execution.busy && !!online.execution.view && (!!online.execution.view.project || isOnlineDirectoryBlank(online.execution.view)));
  const dialog = shallowRef<{ key: string; action: "collection" | "rename"; node: OnlineTreeNodeDTO; version: string; contractProjectId: string | null }>();
  const error = ref("");
  let navigation = 0;
  watch(key, () => {
    navigation += 1;
    dialog.value = undefined;
    error.value = pendingStructure.has(key.value) ? "unknown" : savedPaths.has(key.value) ? "refresh-failed" : "";
  }, { flush: "sync" });
  const structurePending = computed(() => pendingStructure.has(key.value));

  function updateTree(change: Partial<TreeState>) {
    if (!key.value) return;
    trees.set(key.value, { ...tree.value, ...change });
    try { storage.setItem(TREE_STORAGE_KEY, JSON.stringify([...trees].map(([scope, state]) => [JSON.parse(scope), state]))); }
    catch { /* Keep the in-memory preferences when storage is inaccessible. */ }
  }

  function defaultTarget(project: ContractProject | null | undefined): OnlineDirectoryTarget | null {
    const matches = project?.collections.filter(row => isDefaultCollectionId(project.id, row.id)) ?? [];
    return matches.length > 1 ? null : { kind: "project-default", expectedCollectionId: matches[0]?.id ?? null };
  }

  function start(action: string, node: OnlineTreeNodeDTO) {
    const view = online.execution.view;
    if (!writable.value || !context.value || !view || !key.value) return;
    if (pendingStructure.has(key.value) || writingStructure.has(key.value)) { error.value = "unknown"; return; }
    if (action === "collection" || action === "rename") {
      if (action === "rename" && !node.isDefault) return;
      dialog.value = { key: key.value, action, node, version: view.assets.version, contractProjectId: view.assets.contractProjectId };
      return;
    }
    if (action !== "api" || drafts.has(key.value)) return;
    const target = node.kind === "project" ? defaultTarget(view.project) : onlineContainerTarget(node, context.value.scope.projectId);
    const initial: Draft = { id: crypto.randomUUID(), name: "", request: emptyRequest(), target,
      expectedVersion: view.assets.version, expectedContractProjectId: view.assets.contractProjectId,
      initialProjectId: crypto.randomUUID(), caseId: crypto.randomUUID(), defaultNonce: crypto.randomUUID(),
      pending: null, busy: false, error: "", needsTarget: !target };
    drafts.set(key.value, reactive(initial as object) as Draft);
  }

  function makeInput(change: OnlineDirectoryChange, version: string, projectId: string | null, initialProjectId: string): OnlineDirectoryWrite | null {
    if (!context.value || !root.value) return null;
    return { operation: "directoryWrite", context: plain(context.value), projectName: root.value.label,
      expectedVersion: version, expectedContractProjectId: projectId, initialProjectId, change: plain(change) };
  }

  async function confirmName(value: string | null) {
    const entered = dialog.value;
    const view = online.execution.view;
    if (!entered || entered.key !== key.value || !value?.trim() || !writable.value || !view || !context.value) return;
    const target = onlineContainerTarget(entered.node, context.value.scope.projectId);
    const change: OnlineDirectoryChange = entered.action === "collection" ? { kind: "create-module", collectionId: crypto.randomUUID(), name: value.trim() }
      : { kind: "rename-default", collectionId: target?.collectionId ?? "", name: value.trim() };
    if (entered.action === "rename" && !target) return;
    const input = OnlineDirectoryWriteSchema.safeParse(makeInput(change, entered.version, entered.contractProjectId, crypto.randomUUID()));
    if (!input.success) { error.value = "invalid"; return; }
    dialog.value = undefined;
    await submitStructure(input.data);
  }

  async function submitStructure(input: OnlineDirectoryWrite, verifyOnly = false) {
    const owner = scopeKey(input.context);
    if (key.value !== owner || writingStructure.has(owner) || !writable.value) return;
    const turn = navigation;
    const attempt = Symbol();
    writingStructure.set(owner, attempt);
    error.value = "";
    try {
      const reply = await online.writeDirectory(verifyOnly ? { ...input, verifyOnly: true } : input);
      if (writingStructure.get(owner) !== attempt) return;
      const { result } = reply;
      if (result.status === "unknown" && !result.view) pendingStructure.set(owner, input);
      else pendingStructure.delete(owner);
      if (result.status === "unknown" || result.status === "version-conflict") {
        if (result.view) pendingStructure.set(owner, { ...input, expectedVersion: result.view.assets.version,
          expectedContractProjectId: result.view.assets.contractProjectId });
      }
      if (turn !== navigation || !reply.current) {
        if (result.status === "saved" && !reply.refreshed) rememberSaved(owner, `${input.context.scope.projectId}/${result.path}`);
        return;
      }
      if (result.status === "saved") {
        showSaved(owner, `${input.context.scope.projectId}/${result.path}`, reply.refreshed);
      } else if (result.status === "unknown" || result.status === "version-conflict") {
        error.value = result.status === "unknown" && result.view ? "no-save-observed" : result.status;
      } else error.value = result.status;
    } catch (cause) {
      if (writingStructure.get(owner) !== attempt) return;
      const reason = directoryError(cause);
      if (verifyOnly || reason === "unknown") pendingStructure.set(owner, input);
      if (turn === navigation) error.value = reason;
    } finally { if (writingStructure.get(owner) === attempt) writingStructure.delete(owner); }
  }

  function showSaved(owner: string, path: string, refreshed: boolean) {
    if (refreshed) selectSaved(path);
    else rememberSaved(owner, path);
  }

  function rememberSaved(owner: string, path: string) {
    savedPaths.set(owner, path);
    if (owner === key.value) error.value = "refresh-failed";
  }

  async function refreshSaved() {
    const owner = key.value;
    const turn = navigation;
    const path = savedPaths.get(owner);
    if (!path || !(await online.refreshTreeView())) return;
    if (turn !== navigation || savedPaths.get(owner) !== path) return;
    savedPaths.delete(owner);
    error.value = "";
    selectSaved(path);
  }

  const structureReadyToRetry = computed(() => structurePending.value && !writingStructure.has(key.value)
    && (error.value === "version-conflict" || error.value === "no-save-observed"));
  async function reconcileStructure(retry = false) {
    const current = pendingStructure.get(key.value);
    if (!current || (retry && !structureReadyToRetry.value)) return;
    await submitStructure(current, !retry);
  }

  async function save(verifyOnly = false) {
    const owner = key.value;
    const current = draft.value;
    if (!owner || !current || current.busy || !writable.value) return;
    const submitted = current.pending ?? (current.target && current.name.trim() ? makeInput({ kind: "create-api", apiId: current.id, caseId: current.caseId,
      defaultNonce: current.defaultNonce, target: current.target, name: current.name.trim(), request: current.request },
      current.expectedVersion, current.expectedContractProjectId, current.initialProjectId) : null);
    if (!submitted || (verifyOnly !== !!current.pending)) return;
    const parsed = OnlineDirectoryWriteSchema.safeParse(submitted);
    if (!parsed.success) { current.error = "invalid"; return; }
    const input = parsed.data;
    const turn = navigation;
    current.busy = true;
    current.error = "";
    try {
      const reply = await online.writeDirectory(verifyOnly ? { ...input, verifyOnly: true } : input);
      if (drafts.get(owner) !== current) return;
      const result = reply.result;
      if (result.status === "saved") {
        drafts.delete(owner);
        if (turn !== navigation || !reply.current) {
          if (!reply.refreshed) rememberSaved(owner, `${input.context.scope.projectId}/${result.path}`);
          return;
        }
        online.openCreatedDirectoryApi(input.context, result.path);
        showSaved(owner, `${input.context.scope.projectId}/${result.path}`, reply.refreshed);
        return;
      }
      current.error = result.status;
      if (result.status === "unknown" && !result.view) current.pending = input;
      else {
        current.pending = null;
        if (result.view && (result.status === "version-conflict" || result.status === "unknown" || result.status === "target-missing")) {
          current.expectedVersion = result.view.assets.version;
          current.expectedContractProjectId = result.view.assets.contractProjectId;
          current.target = null;
          current.needsTarget = true;
        }
      }
    } catch (cause) {
      if (drafts.get(owner) !== current) return;
      current.error = directoryError(cause);
      if (verifyOnly || current.error === "unknown") current.pending = input;
    } finally { current.busy = false; }
  }

  const dirty = computed(() => pendingStructure.size > 0 || writingStructure.size > 0 || [...drafts.values()].some(hasDraftChanges));
  function hasDraftChanges(current: Draft) {
    return current.busy || !!current.pending || !!current.name.trim() || JSON.stringify(current.request) !== JSON.stringify(emptyRequest());
  }
  function tabScopeMatches(key: string, target: TabScope) {
    const stored = JSON.parse(key) as OnlineExecutionContext;
    return !!target.baseUrl && stored.serverId === `${target.baseUrl.replace(/\/$/, "")}/api/v1`
      && (!target.ownerId || stored.ownerId === target.ownerId)
      && stored.scope.workspaceId === target.workspaceId && stored.scope.projectId === target.projectId;
  }
  function tabHasDraft(target: TabScope) {
    return [...drafts].some(([key, value]) => tabScopeMatches(key, target) && hasDraftChanges(value))
      || [...pendingStructure.keys(), ...writingStructure.keys()].some(key => tabScopeMatches(key, target));
  }
  function discardTab(target: TabScope) {
    for (const key of drafts.keys()) if (tabScopeMatches(key, target)) drafts.delete(key);
    for (const key of pendingStructure.keys()) if (tabScopeMatches(key, target)) pendingStructure.delete(key);
    for (const key of writingStructure.keys()) if (tabScopeMatches(key, target)) writingStructure.delete(key);
    for (const key of savedPaths.keys()) if (tabScopeMatches(key, target)) savedPaths.delete(key);
  }
  function discard(context: OnlineExecutionContext | null) { drafts.delete(scopeKey(context)); }

  return { key, draft, tree, writable, dialog, error, dirty, structurePending, structureReadyToRetry, tabHasDraft, discardTab,
    discard, updateTree, start, confirmName, reconcileStructure, refreshSaved, save };
}

function directoryError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.includes("forbidden") || message.includes("unauthorized")) return "forbidden";
  if (message.includes("invalid_project_assets")) return "invalid";
  return "unknown";
}

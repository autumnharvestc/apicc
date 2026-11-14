<script setup lang="ts">
import { computed, nextTick, ref, toRaw, watch } from "vue";
import { useI18n } from "vue-i18n";
import { DownOutlined, EllipsisOutlined, SlidersOutlined } from "@ant-design/icons-vue";
import { Alert as AAlert, Button as AButton, Checkbox as ACheckbox, Input as AInput, Modal as AModal, RadioButton as ARadioButton, RadioGroup as ARadioGroup, Select as ASelect, TabPane as ATabPane, Tabs as ATabs, Textarea as ATextarea } from "ant-design-vue";
import type { ApiRequest, ComponentAsset, DebugFieldState, ModelAsset, MultipartEntry, ParameterBinding, RequestBody } from "@apicc/core";
import { CollectionLocatorSchema, FolderLocatorSchema } from "../../../shared/locations.js";
import type { SchemaNode } from "@apicc/core/schema";
import type { ApiccApi, CreateComponentInput, CreateModelInput } from "../../../shared/types.js";
import type { ApiParentLocator, ComponentLocator, ModelLocator, ProjectLocator, RequestSaveTarget } from "../../../shared/locations.js";
import type { LocalProjectTreeNodeDTO } from "../../../shared/tree-dto.js";
import type { ParameterListKey, useEditorStore } from "../stores/editor.js";
import type { useDebugStore } from "../stores/debug.js";
import type { RequestTab } from "../stores/requestTabs.js";
import { apiSessionKey } from "../stores/localIdentity.js";
import type { DeleteAssetResult } from "../stores/assets.js";
import type { ProjectAssetTarget } from "../projectAssetTarget.js";
import EmptyState from "./EmptyState.vue";
import SchemaEditor from "./SchemaEditor.vue";
import ResponseEditor from "./ResponseEditor.vue";
import CredentialEditor from "./CredentialEditor.vue";
import OAuthManager from "./OAuthManager.vue";
import ProjectAssetsPanel from "./ProjectAssetsPanel.vue";
import MockPanel from "./MockPanel.vue";
import DebugSettings from "./DebugSettings.vue";
import DebugEnvironmentMenu from "./DebugEnvironmentMenu.vue";
import ActionMenu from "./ActionMenu.vue";
import { debugEnvironmentSelection, type DebugEnvironmentSelection } from "../debugEnvironment.js";

const emit = defineEmits<{ "new-free-request": []; "collaboration-history": [trigger: HTMLElement | undefined] }>();

const props = defineProps<{
  editor: ReturnType<typeof useEditorStore>;
  debug: ReturnType<typeof useDebugStore>;
  api?: ApiccApi;
  assets?: {
    projectLocator: ProjectLocator | null;
    models: ModelAsset[];
    components: ComponentAsset[];
    createModel(input: CreateModelInput): Promise<ModelAsset>;
    saveModel(locator: ModelLocator, model: ModelAsset): Promise<ModelAsset>;
    createComponent(input: CreateComponentInput): Promise<ComponentAsset>;
    saveComponent(locator: ComponentLocator, component: ComponentAsset): Promise<ComponentAsset>;
    deleteAsset(input: { kind: "model"; locator: ModelLocator } | { kind: "component"; locator: ComponentLocator }): Promise<DeleteAssetResult>;
  };
  projectLocator?: ProjectLocator | null;
  requestTab?: RequestTab | null;
  environmentSelection?: DebugEnvironmentSelection | null;
  environmentLoading?: boolean;
  requestPath?: string;
  viewModel?: (modelId: string, trigger: HTMLElement) => void;
  viewProjectAsset?: (target: ProjectAssetTarget, trigger: HTMLElement) => void;
  sharedCredentialStatusRevision?: number;
  suggestCases?: (trigger: HTMLElement) => void;
  compactSuggest?: boolean;
  suggestingCases?: boolean;
  captureResponseExpansion?: () => (() => void);
  models?: ModelAsset[];
  projectTools?: boolean;
  hasDrafts?: boolean;
  projectNode?: LocalProjectTreeNodeDTO | null;
  createFreeModule?: (tab: RequestTab, name: string) => Promise<ApiParentLocator>;
  saveFreeRequest?: (tab: RequestTab, targetParent: RequestSaveTarget, name: string, request: ApiRequest, fields: DebugFieldState[]) => Promise<{ tabId: string; generation: number } | undefined>;
  reloadSaveTargets?: (tab: RequestTab) => Promise<void>;
}>();
const { t } = useI18n();
const isFreeRequest = computed(() => props.requestTab?.source.kind === "free");
const freeSession = computed(() => {
  const tab = props.requestTab;
  if (!tab || tab.source.kind !== "free" || props.editor.activeFreeId !== tab.tabId) return null;
  const session = props.editor.freeSessions[tab.tabId];
  return session?.root === tab.root && session.draftId === tab.source.draftId
    && session.project.workspaceId === tab.source.project.workspaceId
    && session.project.groupId === tab.source.project.groupId
    && session.project.projectId === tab.source.project.projectId ? session : null;
});
const request = computed<ApiRequest | null>(() => {
  const tab = props.requestTab;
  if (!tab) return props.editor.api?.contract.request ?? null;
  if (tab.source.kind === "free") return freeSession.value?.request ?? null;
  const key = apiSessionKey(tab.root, tab.source.locator);
  if (!key || props.editor.activeKey !== key) return null;
  const session = props.editor.sessions[key];
  return session?.root === tab.root ? session.api.contract.request : null;
});
const tabDebugState = computed(() => props.requestTab ? props.debug.requestTabState(props.requestTab) : null);
const currentRestoreMatches = computed(() => {
  if (tabDebugState.value && props.requestTab) {
    return tabDebugState.value.root === props.requestTab.root && tabDebugState.value.generation === props.requestTab.generation;
  }
  const activeKey = props.editor.activeKey;
  const session = activeKey ? props.editor.sessions[activeKey] : undefined;
  return !!session && props.debug.restoredTargetKey === activeKey
    && props.debug.restoredTargetGeneration === session.generation;
});
const pendingRestoreFields = computed(() => currentRestoreMatches.value
  ? (tabDebugState.value?.fields ?? props.debug.restoredFields).filter((field) => field.needsInput) : []);
const bodyText = computed(() => {
  const body = request.value?.protocol === "http" ? request.value.body : undefined;
  return body && (body.kind === "json" || body.kind === "xml" || body.kind === "text") ? body : null;
});
const urlencodedFields = computed(() => {
  const body = request.value?.protocol === "http" ? request.value.body : undefined;
  return body?.kind === "urlencoded" ? body.fields : [];
});
const multipartEntries = computed(() => {
  const body = request.value?.protocol === "http" ? request.value.body : undefined;
  return body?.kind === "multipart" ? body.entries : [];
});
const metadata = computed(() => isFreeRequest.value ? null : props.editor.api?.contract.metadata ?? null);
const credentialContextKey = computed(() => {
  const tab = props.requestTab;
  if (tab) return JSON.stringify({
    root: tab.root,
    project: tab.project,
    tabId: tab.tabId,
    source: tab.source.kind === "asset" ? { kind: tab.source.kind, locator: tab.source.locator } : { kind: tab.source.kind, draftId: tab.source.draftId },
    generation: tab.generation,
  });
  const activeKey = props.editor.activeKey;
  const session = activeKey ? props.editor.sessions[activeKey] : undefined;
  if (!session) return "";
  return JSON.stringify({
    root: session.root,
    project: props.projectLocator,
    locator: session.locator,
    generation: session.generation,
  });
});
const saveFeedback = ref<"" | "debugLoop.freeSavedInherited" | "debugLoop.requestSaved" | "editor.saved">("");
const saveError = ref("");
const freeSaveOpen = ref(false);
const freeSaveBusy = ref(false);
const freeSaveNeedsReload = ref(false);
const freeSaveName = ref("");
const freeSaveParentKey = ref("");
const freeModuleName = ref("");
let freeSaveOperation = 0;
const settingsOpen = ref(false);
const metadataOpen = ref(false);
const parameterDetails = ref<string[]>([]);
const cancelError = ref("");
let saveOperation = 0;
const chosenFileInfo = ref<Record<string, { name: string; size: number }>>({});
const editorElement = ref<HTMLElement | null>(null);
let renderedRequestScroll: { element: HTMLElement; owner: string } | undefined;
const localRequestPanel = ref("path");
const requestPanel = computed({
  get: () => tabDebugState.value?.requestPanel ?? localRequestPanel.value,
  set: (value: string) => {
    localRequestPanel.value = value;
    if (tabDebugState.value) tabDebugState.value.requestPanel = value;
  },
});
const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const authKinds = ["none", "bearer", "basic", "apikey"];
const bodyKinds = ["none", "json", "xml", "text", "graphql", "urlencoded", "multipart", "binary"];
const parameterLocations = ["path", "query", "header", "cookie"] as const;
type ParameterLocation = (typeof parameterLocations)[number];
const parameterKeys: Record<ParameterLocation, ParameterListKey> = {
  path: "pathParams", query: "query", header: "headers", cookie: "cookies",
};
const credentialProjectLocator = computed(() => props.requestTab?.project ?? props.projectLocator ?? null);
const oauthManagedState = ref<"managed" | "unmanaged" | "unknown">("unmanaged");
const credentialManagementOpen = ref(false);
const oauthManagementOpen = ref(false);
const sharedAuth = computed(() => {
  const auth = request.value?.auth;
  if (auth?.kind !== "componentRef") return null;
  const asset = props.assets?.components.find((item): item is Extract<ComponentAsset, { kind: "auth" }> => item.kind === "auth" && item.id === auth.componentId);
  return { id: auth.componentId, asset };
});
const effectiveAuth = computed(() => sharedAuth.value ? sharedAuth.value.asset?.definition : request.value?.auth);
const authReference = computed(() => {
  const auth = effectiveAuth.value;
  if (auth?.kind === "bearer") return auth.token.id;
  if (auth?.kind === "basic") return auth.password.id;
  if (auth?.kind === "apikey") return auth.value.id;
  return null;
});
const editorTitle = computed(() => isFreeRequest.value ? t("requestTabs.freeName") : metadata.value?.name || t("requestWorkbench.title"));
const protocolItems = computed(() => (["http", "websocket", "soap"] as const).map((key) => ({
  key, label: t(`protocol.${key}`), checked: request.value?.protocol === key, testId: `request-protocol-${key}`,
})));
const moreItems = computed(() => [
  ...(props.suggestCases && props.compactSuggest && !isFreeRequest.value ? [{ key: "suggest-cases", label: t("ai.suggestBtn"),
    disabled: props.editor.readOnly || props.suggestingCases, testId: "ai-suggest-btn" }] : []),
  ...(!isFreeRequest.value ? [{ key: "save-request", label: t("requestWorkbench.saveRequestOnly"),
    disabled: props.editor.readOnly || pendingRestoreFields.value.length > 0, testId: "save-request-btn" }] : []),
  { key: "settings", label: t("debugLoop.settings"), disabled: !props.api, testId: "debug-settings-open" },
  { key: "history", label: t("collaboration.chooseDebugHistory"), testId: "collaboration-open-history" },
]);
const requestMore = ref<InstanceType<typeof ActionMenu>>();
watch(() => props.compactSuggest, (compact) => {
  const focused = document.activeElement;
  if (compact && focused instanceof HTMLElement && focused.matches('.request-heading [data-testid="ai-suggest-btn"]')) {
    void nextTick(() => editorElement.value?.closest(".editor")?.querySelector<HTMLElement>('[data-testid="request-more"]')?.focus({ preventScroll: true }));
  } else if (!compact && focused instanceof HTMLElement && focused.matches('[data-menu-owner="request-more"] [data-testid="ai-suggest-btn"]')) {
    requestMore.value?.close(false);
    void nextTick(() => editorElement.value?.closest(".editor")?.querySelector<HTMLElement>('.request-heading [data-testid="ai-suggest-btn"]')?.focus({ preventScroll: true }));
  }
});
const sending = computed(() => tabDebugState.value?.sending ?? props.debug.sending);
const runId = computed(() => tabDebugState.value ? tabDebugState.value.activeRunId : props.debug.activeRunId);
const cancellingRun = computed(() => tabDebugState.value ? tabDebugState.value.cancelRunId : props.debug.cancelRunId);
const sendAction = computed(() => sending.value && runId.value ? "cancel" : sending.value ? "busy" : "send");
const sendDisabled = computed(() => sendAction.value === "cancel"
  ? runId.value === cancellingRun.value
  : sendAction.value === "busy" || pendingRestoreFields.value.length > 0 || environmentUnavailable.value || !!freeSession.value?.urlDraftInvalid);

function selectProtocol(key: string) {
  if (key === "http" || key === "websocket" || key === "soap") switchProtocol(key);
}

function selectRequestAction(key: string) {
  if (key === "suggest-cases") {
    const trigger = document.activeElement;
    if (props.compactSuggest && !props.editor.readOnly && !props.suggestingCases && trigger instanceof HTMLElement) props.suggestCases?.(trigger);
  } else if (key === "save-request") void saveRequest(true);
  else if (key === "settings") settingsOpen.value = true;
  else if (key === "history") emit("collaboration-history", document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
}

function toggleParameterDetails(id: string) {
  parameterDetails.value = parameterDetails.value.includes(id)
    ? parameterDetails.value.filter((key) => key !== id) : [...parameterDetails.value, id];
}

const freeSaveParents = computed(() => {
  const project = props.projectNode;
  const tab = props.requestTab;
  const result: Array<{ key: string; label: string; target: RequestSaveTarget; disabled?: boolean }> = [];
  if (project && tab && tab.source.kind === "free"
    && project.locator.workspaceId === tab.project.workspaceId
    && project.locator.groupId === tab.project.groupId
    && project.locator.projectId === tab.project.projectId) {
    const defaults = project.children.filter((child) => child.kind === "collection" && child.isDefault);
    const defaultCollection = defaults.length === 1 ? defaults[0] : undefined;
    const target: RequestSaveTarget = { kind: "project-default", expectedCollectionId: defaultCollection?.id ?? null };
    result.push({ key: JSON.stringify(target), target, disabled: defaults.length > 1,
      label: t("projectDirectory.defaultTarget", { name: defaultCollection?.label ?? t("projectDirectory.defaultCollectionName") }) });
    for (const child of project.children) {
      if (child.kind !== "collection") continue;
      const collectionLocator = CollectionLocatorSchema.parse(child.locator);
      if (child.id !== defaultCollection?.id) result.push({ key: JSON.stringify(collectionLocator), label: child.label, target: collectionLocator });
      const visitFolders = (nodes: typeof child.children, prefix: string): void => {
        for (const node of nodes ?? []) {
          if (node.kind !== "folder") continue;
          const folderLocator = FolderLocatorSchema.parse(node.locator);
          const label = `${prefix} / ${node.label}`;
          result.push({ key: JSON.stringify(folderLocator), label, target: folderLocator });
          visitFolders(node.children ?? [], label);
        }
      };
      visitFolders(child.children ?? [], child.label);
    }
  }
  return result;
});
const freeSaveTarget = computed(() => freeSaveParents.value.find((item) => item.key === freeSaveParentKey.value && !item.disabled));
const freeSaveAmbiguous = computed(() => freeSaveParents.value.some((item) => item.disabled));
const freeSaveTargetMissing = computed(() => !!freeSaveParentKey.value && !freeSaveParents.value.some((item) => item.key === freeSaveParentKey.value));

watch(credentialContextKey, () => {
  saveOperation += 1;
  saveFeedback.value = "";
  saveError.value = "";
  freeSaveOperation += 1;
  freeSaveOpen.value = false;
  freeSaveBusy.value = false;
  freeSaveNeedsReload.value = false;
  freeSaveParentKey.value = "";
  freeSaveName.value = "";
  freeModuleName.value = "";
  metadataOpen.value = false;
  parameterDetails.value = [];
  settingsOpen.value = false;
  cancelError.value = "";
}, { flush: "sync" });
watch(runId, () => { cancelError.value = ""; });

function openFreeSaveDialog() {
  saveError.value = "";
  saveFeedback.value = "";
  const source = props.requestTab?.source;
  const parent = source?.kind === "free" ? source.saveParent : undefined;
  const currentDefault = freeSaveParents.value.find((item) => "kind" in item.target);
  freeSaveParentKey.value = parent === null ? currentDefault?.key ?? "" : parent ?
    freeSaveParents.value.find((item) => "kind" in item.target && !("folderIds" in parent)
      && item.target.expectedCollectionId === parent.collectionId)?.key ?? JSON.stringify("folderIds" in parent ? FolderLocatorSchema.parse(parent) : CollectionLocatorSchema.parse(parent)) : "";
  freeSaveOpen.value = true;
}

function closeFreeSaveDialog() {
  if (!freeSaveBusy.value) freeSaveOpen.value = false;
}

async function reloadSaveTargets() {
  const tab = props.requestTab;
  if (!tab || tab.source.kind !== "free" || tab.source.saveParent === undefined || !props.reloadSaveTargets || freeSaveBusy.value) return;
  const operation = ++freeSaveOperation;
  freeSaveBusy.value = true;
  try {
    await props.reloadSaveTargets(tab);
    if (operation !== freeSaveOperation) return;
    freeSaveParentKey.value = "";
    freeSaveNeedsReload.value = false;
    saveError.value = "";
  } catch (error) {
    if (operation === freeSaveOperation) saveError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (operation === freeSaveOperation) freeSaveBusy.value = false;
  }
}

async function onCreateFreeModule() {
  const tab = props.requestTab;
  const name = freeModuleName.value.trim();
  if (!tab || tab.source.kind !== "free" || !props.createFreeModule || !name) return;
  const operation = ++freeSaveOperation;
  freeSaveBusy.value = true;
  saveError.value = "";
  try {
    const locator = await props.createFreeModule(tab, name);
    if (operation !== freeSaveOperation || props.requestTab?.tabId !== tab.tabId
      || props.requestTab.generation !== tab.generation || props.requestTab.source.kind !== "free") return;
    const key = JSON.stringify("folderIds" in locator ? FolderLocatorSchema.parse(locator) : CollectionLocatorSchema.parse(locator));
    freeSaveParentKey.value = key;
    freeModuleName.value = "";
  } catch (error) {
    if (operation === freeSaveOperation) saveError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (operation === freeSaveOperation) freeSaveBusy.value = false;
  }
}

async function submitFreeSave() {
  const tab = props.requestTab;
  const current = request.value;
  const target = freeSaveTarget.value?.target;
  if (!tab || tab.source.kind !== "free" || !current || !target || !props.saveFreeRequest || !freeSaveName.value.trim()
    || freeSaveBusy.value || freeSaveNeedsReload.value) return;
  if (freeSession.value?.urlDraftInvalid) {
    saveError.value = t("editor.invalidFullUrl");
    return;
  }
  if (tabDebugState.value?.fields.some((field) => field.needsInput)) {
    saveError.value = t("debugLoop.restoreFieldsRequired");
    return;
  }
  const operation = ++freeSaveOperation;
  freeSaveBusy.value = true;
  saveError.value = "";
  try {
    const receipt = await props.saveFreeRequest(tab, target, freeSaveName.value.trim(), cloneContract(current),
      (tabDebugState.value?.fields ?? []).map((field) => ({ ...field })));
    const active = props.requestTab;
    if (!receipt || !active || active.source.kind !== "asset" || active.tabId !== receipt.tabId
      || active.generation !== receipt.generation) return;
    saveFeedback.value = "debugLoop.freeSavedInherited";
    freeSaveOpen.value = false;
  } catch (error) {
    if (operation === freeSaveOperation) {
      const message = error instanceof Error ? error.message : String(error);
      const targetMissing = message.includes("REQUEST_SAVE_TARGET_MISSING");
      const revisionConflict = /project source revision conflict/i.test(message);
      if (tab.source.saveParent !== undefined && (targetMissing || revisionConflict)) freeSaveNeedsReload.value = true;
      saveError.value = targetMissing ? t("projectDirectory.targetMissing")
        : message.includes("REQUEST_SAVE_DEFAULT_AMBIGUOUS") ? t("projectDirectory.defaultAmbiguous")
          : revisionConflict ? t(tab.source.saveParent === undefined ? "projectDirectory.revisionConflictFree" : "projectDirectory.revisionConflict") : message;
    }
  } finally {
    if (operation === freeSaveOperation) freeSaveBusy.value = false;
  }
}

watch(() => request.value, (value) => {
  const session = freeSession.value;
  if (!session || !value) return;
  session.draftRevision += 1;
  if (!session.urlDraftInvalid) session.urlDraft = requestUrl(value);
}, { deep: true, flush: "sync" });

watch(() => request.value, () => {
  if (props.requestTab && tabDebugState.value) props.debug.refreshRequestTabRestoreFields(props.requestTab, props.editor);
  else props.debug.refreshRestoredFields(props.editor);
}, { deep: true, flush: "post" });

watch([credentialContextKey, editorElement], ([owner, element]) => {
  renderedRequestScroll = undefined;
  if (!element) return;
  element.scrollTop = tabDebugState.value?.requestScrollTop ?? 0;
  renderedRequestScroll = { element, owner };
}, { immediate: true, flush: "post" });

function captureRequestScroll(event: Event) {
  if (tabDebugState.value && renderedRequestScroll?.owner === credentialContextKey.value
    && renderedRequestScroll.element === event.currentTarget) {
    tabDebugState.value.requestScrollTop = renderedRequestScroll.element.scrollTop;
  }
}

function cloneContract<T>(value: T): T {
  return JSON.parse(JSON.stringify(toRaw(value))) as T;
}

function secretRef() {
  return { id: crypto.randomUUID(), policy: "test-auto" };
}

function switchProtocol(next: ApiRequest["protocol"]) {
  const current = request.value;
  const session = freeSession.value ?? (props.editor.activeKey ? props.editor.sessions[props.editor.activeKey] : undefined);
  if (!session || !current || current.protocol === next) return;
  session.protocolDrafts[current.protocol] = cloneContract(current);
  const saved = session.protocolDrafts[next] as ApiRequest | undefined;
  if (saved) {
    setRequest(cloneContract(saved));
    if (freeSession.value) {
      freeSession.value.urlDraft = requestUrl(saved);
      freeSession.value.urlDraftInvalid = false;
    }
    return;
  }
  const common = {
    baseUrl: current.baseUrl,
    path: current.path,
    pathParams: cloneContract(current.pathParams),
    query: cloneContract(current.query),
    headers: cloneContract(current.headers),
    cookies: cloneContract(current.cookies),
    auth: cloneContract(current.auth),
  };
  if (next === "http") setRequest({ ...common, protocol: "http", method: "GET", body: { kind: "none" } });
  else if (next === "websocket") setRequest({ ...common, protocol: "websocket" });
  else setRequest({ ...common, protocol: "soap", method: "POST", envelope: "" });
  if (freeSession.value && request.value) {
    freeSession.value.urlDraft = requestUrl(request.value);
    freeSession.value.urlDraftInvalid = false;
  }
}

function setRequest(value: ApiRequest) {
  if (freeSession.value) freeSession.value.request = value;
  else if (props.editor.api) props.editor.api.contract.request = value;
}

const environment = computed(() => props.environmentSelection === undefined
  ? debugEnvironmentSelection(props.editor, props.debug, props.requestTab) : props.environmentSelection);
const selectedEnvironmentId = computed(() => environment.value?.value ?? "");
const environmentUnavailable = computed(() => {
  const selection = environment.value;
  return !!selection?.value && !selection.options.some((option) => option.key === selection.value);
});

const oauthContextKey = computed(() => JSON.stringify({
  root: props.requestTab?.root ?? null,
  project: credentialProjectLocator.value,
  tabId: props.requestTab?.tabId ?? null,
  source: props.requestTab?.source.kind === "asset"
    ? { kind: "asset", locator: props.requestTab.source.locator }
    : props.requestTab?.source.kind === "free"
      ? { kind: "free", draftId: props.requestTab.source.draftId }
      : null,
  generation: props.requestTab?.generation ?? null,
  environmentId: selectedEnvironmentId.value || null,
  sharedComponentId: sharedAuth.value?.id ?? null,
  bearerRef: effectiveAuth.value?.kind === "bearer" ? effectiveAuth.value.token : null,
}));

watch(credentialContextKey, () => {
  oauthManagedState.value = props.requestTab ? "unknown" : "unmanaged";
  credentialManagementOpen.value = false;
  oauthManagementOpen.value = false;
}, { flush: "sync" });

function updateRequestAuth(auth: ApiRequest["auth"]): void {
  const current = request.value;
  if (!current || props.editor.readOnly) return;
  current.auth = auth;
}

function onSend() {
  if (environmentUnavailable.value) return;
  const onAccepted = props.captureResponseExpansion?.();
  if (props.requestTab) void props.debug.sendRequestTab(props.requestTab, props.editor, undefined, onAccepted);
  else void props.debug.send(props.editor, undefined, onAccepted);
}

async function onCancel() {
  const current = runId.value;
  if (!current || sendDisabled.value) return;
  const tab = props.requestTab;
  cancelError.value = "";
  try {
    const result = tab ? await props.debug.cancelRequestTab(tab.tabId) : await props.debug.cancel();
    if (runId.value === current && props.requestTab === tab) {
      if (result.status !== "cancelled") cancelError.value = t("requestWorkbench.cancelUnconfirmed");
    }
  } catch (error) {
    if (runId.value === current && props.requestTab === tab) cancelError.value = error instanceof Error ? error.message : String(error);
  }
}

function runCommand() {
  if (sendDisabled.value) return;
  if (sendAction.value === "cancel") void onCancel();
  else onSend();
}

function updateFullUrl(value: string) {
  const session = freeSession.value;
  if (!session) return;
  session.draftRevision += 1;
  session.urlDraft = value;
  session.urlDraftInvalid = true;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
    if (request.value?.protocol !== "http") return;
    const current = request.value;
    current.baseUrl = parsed.origin;
    current.path = parsed.pathname || "/";
    current.query = [...parsed.searchParams.entries()].map(([name, itemValue]) => ({
      kind: "inline" as const,
      id: crypto.randomUUID(),
      name,
      schema: { kind: "scalar" as const, type: "string" as const },
      required: false,
      enabled: true,
      description: "",
      value: itemValue,
    }));
    session.urlDraft = requestUrl(current);
    session.urlDraftInvalid = false;
  } catch {
    session.urlDraftInvalid = true;
    // Keep incomplete input in the editor while leaving the last valid request intact.
  }
}

function requestUrl(current: ApiRequest): string {
  const base = current.baseUrl.replace(/\/$/, "");
  const path = current.path.startsWith("/") ? current.path : `/${current.path}`;
  const query = current.protocol === "http" ? current.query.filter((item) => item.kind === "inline" && item.enabled !== false && item.name)
    .map((item) => `${encodeURIComponent(item.kind === "inline" ? item.name : "")}=${encodeURIComponent(item.value ?? "")}`).join("&") : "";
  return `${base}${path}${query ? `?${query}` : ""}`;
}

function parameterList(location: ParameterLocation): ParameterBinding[] {
  return request.value?.[parameterKeys[location]] ?? [];
}

function editParameterValue(location: ParameterLocation, binding: ParameterBinding, value: string) {
  if (request.value) props.editor.setParameterValue(request.value, parameterKeys[location], binding, value);
}

function addParameter(location: ParameterLocation) {
  const id = crypto.randomUUID();
  const item: ParameterBinding = {
    kind: "inline", id, name: "", schema: { kind: "scalar", type: "string" },
    required: false, enabled: true, description: "", value: "",
  };
  parameterList(location).push(item);
}

function removeParameter(location: ParameterLocation, index: number) {
  parameterList(location).splice(index, 1);
}

function parameterComponents(location: ParameterLocation): Extract<ComponentAsset, { kind: "parameter" }>[] {
  const components = props.assets?.components ?? [];
  return components.filter((component): component is Extract<ComponentAsset, { kind: "parameter" }> =>
    component.kind === "parameter" && component.definition.location === location);
}

function bindParameter(location: ParameterLocation, index: number, componentId: string) {
  const list = parameterList(location);
  const previous = list[index];
  if (!previous || !componentId) return;
  const component = parameterComponents(location).find((entry) => entry.id === componentId);
  if (!component) return;
  list.splice(index, 1, {
    kind: "componentRef", id: previous.id, componentId: component.id, expectedKind: "parameter",
    ...(previous.value === undefined ? {} : { value: previous.value }), enabled: previous.enabled,
  });
}

function setAuthKind(kind: string) {
  const current = request.value;
  if (!current) return;
  if (kind === "none") current.auth = { kind: "none" };
  else if (kind === "bearer") current.auth = { kind: "bearer", token: secretRef() };
  else if (kind === "basic") current.auth = { kind: "basic", username: "", password: secretRef() };
  else if (kind === "apikey") current.auth = { kind: "apikey", name: "", placement: "header", value: secretRef() };
  else if (kind.startsWith("component:")) current.auth = { kind: "componentRef", componentId: kind.slice("component:".length), expectedKind: "auth" };
}

function setBodyKind(kind: string) {
  const current = request.value;
  if (!current || current.protocol !== "http") return;
  const previous = current.body;
  if (kind === "none") current.body = { kind: "none" };
  else if (kind === "json" || kind === "xml" || kind === "text") {
    current.body = { kind, content: previous.kind === kind ? previous.content : "" };
  } else if (kind === "graphql") {
    current.body = previous.kind === "graphql" ? previous : { kind, query: "", variables: "" };
  } else if (kind === "urlencoded") {
    current.body = previous.kind === "urlencoded" ? previous : { kind, fields: [] };
  } else if (kind === "multipart") {
    current.body = previous.kind === "multipart" ? previous : { kind, entries: [] };
  } else if (kind === "binary") {
    current.body = previous.kind === "binary" ? previous : { kind, file: { path: "" }, contentType: "application/octet-stream" };
  }
}

function setBodyText(value: string) {
  if (bodyText.value) bodyText.value.content = value;
}

function bodySchema(): SchemaNode | undefined {
  const body = request.value?.protocol === "http" ? request.value.body : undefined;
  return body && (body.kind === "json" || body.kind === "xml" || body.kind === "text") ? body.schema : undefined;
}

function updateBodySchema(schema: SchemaNode | undefined) {
  const body = request.value?.protocol === "http" ? request.value.body : undefined;
  if (!body || (body.kind !== "json" && body.kind !== "xml" && body.kind !== "text")) return;
  if (schema === undefined) delete body.schema;
  else body.schema = schema;
}

function bodyExamples(): unknown[] {
  const schema = bodySchema();
  return schema?.examples ?? [];
}

function useBodyExample(index: number) {
  const body = request.value?.protocol === "http" ? request.value.body : undefined;
  const example = bodyExamples()[index];
  if (!body || (body.kind !== "json" && body.kind !== "xml" && body.kind !== "text") || example === undefined) return;
  body.content = JSON.stringify(example, null, 2);
}

function addBodyEntry(body: Extract<RequestBody, { kind: "multipart" | "urlencoded" }>) {
  if (body.kind === "urlencoded") body.fields.push({ id: crypto.randomUUID(), name: "", value: "", enabled: true });
  else body.entries.push({ kind: "text", id: crypto.randomUUID(), name: "", value: "", enabled: true });
}

function removeBodyEntry(body: Extract<RequestBody, { kind: "multipart" | "urlencoded" }>, index: number) {
  if (body.kind === "urlencoded") body.fields.splice(index, 1);
  else body.entries.splice(index, 1);
}

function setMultipartEntryKind(index: number, kind: "text" | "file") {
  const body = request.value?.protocol === "http" ? request.value.body : undefined;
  const previous = body?.kind === "multipart" ? body.entries[index] : undefined;
  if (body?.kind !== "multipart" || !previous || previous.kind === kind) return;
  const next: MultipartEntry = kind === "file"
    ? { kind, id: previous.id, name: previous.name, file: { path: "" }, enabled: previous.enabled }
    : { kind, id: previous.id, name: previous.name, value: "", enabled: previous.enabled };
  body.entries.splice(index, 1, next);
}

async function chooseBinaryFile(target: { file: { path: string } }, key: string) {
  if (!props.api || props.editor.readOnly) return;
  try {
    const selected = await props.api.debugPickFile();
    if (!selected) return;
    target.file.path = selected.path;
    chosenFileInfo.value[key] = { name: selected.name, size: selected.size };
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : String(error);
  }
}

function localFileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function caseValue(identity: { caseId: string; scope: string }): string {
  return JSON.stringify([identity.caseId, identity.scope]);
}

function activeCaseValue(): string {
  if (isFreeRequest.value) return "";
  const cases = props.editor.api?.cases ?? [];
  const selected = tabDebugState.value ? tabDebugState.value.selectedCase : props.debug.selectedCase;
  const active = cases.find((item) => item.id === selected?.caseId && item.scope === selected.scope) ?? cases[0];
  return active ? caseValue({ caseId: active.id, scope: active.scope }) : "";
}

function selectDebugCase(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
      if (tabDebugState.value) tabDebugState.value.selectedCase = { caseId: parsed[0], scope: parsed[1] };
      else props.debug.selectCase({ caseId: parsed[0], scope: parsed[1] });
    }
  } catch {
    if (tabDebugState.value) tabDebugState.value.selectedCase = null;
    else props.debug.selectCase(null);
  }
}

function metadataTags(value: string) {
  if (metadata.value) metadata.value.tags = value.split(",").map((tag) => tag.trim()).filter(Boolean);
}

async function saveRequest(requestOnly: boolean) {
  if (props.editor.readOnly || !request.value || pendingRestoreFields.value.length) return;
  const operation = ++saveOperation;
  saveFeedback.value = "";
  saveError.value = "";
  try {
    if (requestOnly) {
      await props.editor.saveRequestDraft(currentRestoreMatches.value ? tabDebugState.value?.fields ?? props.debug.restoredFields : []);
    } else await props.editor.save();
    if (operation === saveOperation) saveFeedback.value = requestOnly ? "debugLoop.requestSaved" : "editor.saved";
  } catch (error) {
    if (operation === saveOperation) saveError.value = error instanceof Error ? error.message : String(error);
  }
}
</script>

<template>
  <section v-if="request" class="editor" data-testid="request-editor" :data-source-kind="isFreeRequest ? 'free' : 'asset'">
    <header class="editor-header">
      <div class="request-heading">
        <div class="request-heading-text">
          <div v-if="requestPath" class="request-path" :title="requestPath" tabindex="0">{{ requestPath }}</div>
          <h2 :title="editorTitle">{{ editorTitle }}</h2>
        </div>
        <span v-if="hasDrafts || editor.dirty" class="dirty">{{ t("editor.unsaved") }}</span>
        <button v-if="metadata" type="button" class="editor-detail-button" data-testid="asset-metadata-toggle"
          :aria-expanded="metadataOpen" @click="metadataOpen = !metadataOpen">{{ t("requestWorkbench.details") }}</button>
        <a-button v-if="metadata && suggestCases && !compactSuggest" size="small" data-testid="ai-suggest-btn"
          :aria-disabled="editor.readOnly || suggestingCases" :disabled="editor.readOnly"
          @click="!suggestingCases && suggestCases($event.currentTarget as HTMLElement)">{{ t("ai.suggestBtn") }}</a-button>
      </div>
      <div class="request-command" data-testid="request-command">
        <div class="request-address">
          <ActionMenu :key="credentialContextKey" class="protocol-trigger" test-id="editor-protocol" :label="t('requestWorkbench.protocol') + ' · ' + t(`protocol.${request.protocol}`)"
            :disabled="editor.readOnly" :items="protocolItems" @select="selectProtocol">
            {{ t(`protocol.${request.protocol}`) }} <DownOutlined />
          </ActionMenu>
          <a-select v-if="request.protocol === 'http'" v-model:value="request.method" class="method-select" data-testid="editor-method" :aria-label="t('requestWorkbench.method')" :disabled="editor.readOnly" :options="methods.map((value) => ({ label: value, value }))" />
          <span v-else-if="request.protocol === 'soap'" class="method-fixed" data-testid="editor-method">POST</span>
          <a-input v-if="isFreeRequest && freeSession && request.protocol === 'http'" :value="freeSession.urlDraft" class="url full-url" data-testid="editor-full-url" :disabled="editor.readOnly" :aria-label="t('editor.fullUrl')" :placeholder="t('editor.fullUrl')" @update:value="updateFullUrl" />
          <template v-else>
            <a-input v-model:value="request.baseUrl" class="url base-url" data-testid="editor-base-url" :disabled="editor.readOnly" :aria-label="t('editor.baseUrl')" :placeholder="t('editor.baseUrl')" />
            <a-input v-model:value="request.path" class="url url-path" data-testid="editor-path" :disabled="editor.readOnly" :aria-label="t('editor.path')" :placeholder="t('editor.path')" />
          </template>
        </div>
        <div class="request-actions">
          <DebugEnvironmentMenu :selection="environment" :loading="environmentLoading" test-id="debug-env-select" />
          <button type="button" class="send-slot" data-testid="request-send-slot" :aria-busy="sending" :aria-disabled="sendDisabled" @click="runCommand">
            <span :data-testid="sendAction === 'cancel' ? 'debug-cancel' : 'send-btn'">{{ sendAction === "cancel" ? t('debugLoop.cancelRun') : sending ? t('editor.sending') : t('editor.send') }}</span>
          </button>
          <a-button v-if="!isFreeRequest" data-testid="save-btn" :disabled="editor.readOnly || pendingRestoreFields.length > 0" @click="saveRequest(false)">{{ t('editor.save') }}</a-button>
          <a-button v-else data-testid="save-free-btn" :disabled="editor.readOnly || freeSession?.urlDraftInvalid || pendingRestoreFields.length > 0 || !props.saveFreeRequest" @click="openFreeSaveDialog">{{ t('debugLoop.freeSaveAsApi') }}</a-button>
          <ActionMenu ref="requestMore" :key="credentialContextKey" test-id="request-more" :label="t('requestWorkbench.more')" :items="moreItems" @select="selectRequestAction"><EllipsisOutlined /></ActionMenu>
          <a-select v-if="!isFreeRequest" class="case-select" data-testid="debug-case-select" size="small" :aria-label="t('requestWorkbench.case')"
            :value="activeCaseValue()" :options="(editor.api?.cases ?? []).map((item) => ({ label: `${item.name} (${item.scope})`, value: caseValue({ caseId: item.id, scope: item.scope }) }))"
            @update:value="(value) => selectDebugCase(value as string)" />
        </div>
      </div>
      <p v-if="freeSession?.urlDraftInvalid" class="request-feedback error" role="alert" data-testid="free-url-draft-error">{{ t('editor.invalidFullUrl') }}</p>
      <p v-if="environmentUnavailable" class="request-feedback error" role="status">{{ t("environmentShortcut.unavailable") }}</p>
      <p v-if="cancelError" class="request-feedback error" role="alert">{{ cancelError }}</p>
      <span v-if="saveFeedback" class="request-feedback" role="status" data-testid="save-feedback">{{ t(saveFeedback) }}</span>
      <span v-if="saveError" class="request-feedback error" role="alert" data-testid="save-error">{{ saveError }}</span>
    </header>

    <a-modal :open="freeSaveOpen" :title="t('debugLoop.freeSaveTitle')" :confirm-loading="freeSaveBusy" @cancel="closeFreeSaveDialog">
      <a-input v-model:value="freeSaveName" data-testid="free-save-name" :placeholder="t('debugLoop.freeSaveName')" />
      <template v-if="freeSaveParents.length">
        <a-select :value="freeSaveTargetMissing ? undefined : freeSaveParentKey || undefined" class="free-save-target"
          :placeholder="t('debugLoop.freeSaveTarget')" :aria-label="t('debugLoop.freeSaveTarget')"
          :options="freeSaveParents.map((item) => ({ label: item.label, value: item.key, disabled: item.disabled }))"
          data-testid="free-save-target" @update:value="(value) => { freeSaveParentKey = String(value); saveError = '' }" />
        <p v-if="freeSaveTargetMissing" role="alert" data-testid="free-save-target-missing">{{ t('projectDirectory.targetMissing') }}</p>
        <p v-if="freeSaveAmbiguous" role="status">{{ t('projectDirectory.defaultAmbiguous') }}</p>
        <p class="note">{{ t("debugLoop.freeSaveInheritanceNote") }}</p>
        <a-button v-if="requestTab?.source.kind === 'free' && requestTab.source.saveParent !== undefined && (freeSaveNeedsReload || freeSaveTargetMissing)"
          data-testid="free-save-reload-targets" :loading="freeSaveBusy" @click="reloadSaveTargets">{{ t('projectDirectory.reloadTargets') }}</a-button>
      </template>
      <a-alert v-if="!projectNode?.children.length" type="info" show-icon :message="t('debugLoop.freeSaveNeedsModule')" data-testid="free-save-needs-module" />
      <div v-if="createFreeModule" class="free-save-new-module">
        <a-input v-model:value="freeModuleName" data-testid="free-save-module-name" :placeholder="t('debugLoop.freeSaveModuleName')" />
        <a-button data-testid="free-save-create-module" :disabled="editor.readOnly || !freeModuleName.trim() || !props.createFreeModule" :loading="freeSaveBusy" @click="onCreateFreeModule">{{ t("debugLoop.freeSaveCreateModule") }}</a-button>
      </div>
      <a-alert v-if="saveError" type="error" show-icon :message="saveError" data-testid="free-save-error" />
      <template #footer>
        <a-button data-testid="free-save-cancel" :disabled="freeSaveBusy" @click="closeFreeSaveDialog">{{ t("debugLoop.freeSaveCancel") }}</a-button>
        <a-button type="primary" data-testid="free-save-submit" :disabled="editor.readOnly || freeSession?.urlDraftInvalid || !freeSaveTarget || freeSaveNeedsReload || !freeSaveName.trim() || !props.saveFreeRequest || pendingRestoreFields.length > 0 || tabDebugState?.fields.some((field) => field.needsInput)" :loading="freeSaveBusy" @click="submitFreeSave">{{ t("debugLoop.freeSaveSubmit") }}</a-button>
      </template>
    </a-modal>

    <div :key="requestTab ? credentialContextKey : undefined" ref="editorElement" class="editor-content" data-testid="request-editor-scroll" @scroll="captureRequestScroll">
    <section v-if="metadata && metadataOpen" class="metadata" :aria-label="t('requestWorkbench.details')">
      <a-input v-model:value="metadata.name" data-testid="asset-metadata-name" :disabled="editor.readOnly" :placeholder="t('contract.metadataName')" />
      <a-input v-model:value="metadata.description" data-testid="asset-metadata-description" :disabled="editor.readOnly" :placeholder="t('contract.metadataDescription')" />
      <a-input :value="metadata.tags.join(', ')" data-testid="asset-metadata-tags" :disabled="editor.readOnly" :placeholder="t('contract.metadataTags')" @update:value="metadataTags" />
      <a-input v-model:value="metadata.version" data-testid="asset-metadata-version" :disabled="editor.readOnly" :placeholder="t('contract.metadataVersion')" />
      <a-select v-model:value="metadata.status" data-testid="asset-metadata-status" :disabled="editor.readOnly" :options="['draft', 'published', 'deprecated'].map((value) => ({ label: t(`contract.status.${value}`), value }))" />
    </section>
    <a-tabs v-model:active-key="requestPanel">
      <a-tab-pane v-for="location in parameterLocations" :key="location">
        <template #tab><span :data-testid="`tab-${location}`">{{ t(`contract.location.${location}`) }}</span></template>
        <div class="panel parameter-panel">
          <div v-if="parameterList(location).length" class="parameter-grid parameter-labels" aria-hidden="true">
            <span>{{ t("requestWorkbench.enabled") }}</span><span>{{ t("requestWorkbench.field") }}</span><span>{{ t("requestWorkbench.value") }}</span><span>{{ t("contract.description") }}</span><span>{{ t("requestWorkbench.actions") }}</span>
          </div>
          <div v-for="(binding, index) in parameterList(location)" :key="binding.id" class="parameter-entry">
            <div class="parameter-grid">
              <a-checkbox v-model:checked="binding.enabled" data-testid="kv-enabled" :aria-label="t('requestWorkbench.enabled')" :disabled="editor.readOnly" />
              <a-input v-if="binding.kind === 'inline'" v-model:value="binding.name" size="small" data-testid="kv-key" :aria-label="t('requestWorkbench.field')" :disabled="editor.readOnly" />
              <span v-else class="component-name" :title="parameterComponents(location).find((item) => item.id === binding.componentId)?.name ?? t('contract.missingComponent')">
                {{ parameterComponents(location).find((item) => item.id === binding.componentId)?.name ?? t("contract.missingComponent") }}
              </span>
              <a-input :value="binding.value ?? ''" size="small" data-testid="kv-value" :aria-label="t('requestWorkbench.value')" :disabled="editor.readOnly"
                @update:value="editParameterValue(location, binding, $event)" />
              <a-input v-if="binding.kind === 'inline'" v-model:value="binding.description" size="small" :aria-label="t('contract.description')" :disabled="editor.readOnly" />
              <span v-else class="component-name">{{ t("requestWorkbench.componentReference") }}</span>
              <div class="parameter-actions">
                <button type="button" class="editor-detail-button" :data-testid="`parameter-details-${location}-${index}`"
                  :title="t('requestWorkbench.parameterDetails')" :aria-label="t('requestWorkbench.parameterDetails')"
                  :aria-expanded="parameterDetails.includes(binding.id)" @click="toggleParameterDetails(binding.id)"><SlidersOutlined /></button>
                <a-button danger type="text" size="small" data-testid="kv-remove" :aria-label="t('tree.delete')" :disabled="editor.readOnly" @click="removeParameter(location, index)">×</a-button>
              </div>
            </div>
            <div v-if="parameterDetails.includes(binding.id)" class="parameter-details">
              <label v-if="assets">
                <span>{{ t("requestWorkbench.componentReference") }}</span>
                <a-select :value="binding.kind === 'componentRef' ? binding.componentId : ''" :data-testid="`parameter-component-${location}-${index}`" :disabled="editor.readOnly" :options="[{ label: t('contract.inlineParameter'), value: '' }, ...parameterComponents(location).map((item) => ({ label: item.name, value: item.id }))]" @update:value="(value) => bindParameter(location, index, value as string)" />
              </label>
              <template v-if="binding.kind === 'inline'">
                <a-checkbox v-model:checked="binding.required" :data-testid="`parameter-required-${location}-${index}`" :disabled="editor.readOnly">{{ t('contract.required') }}</a-checkbox>
                <div :data-testid="`parameter-schema-${location}-${index}`">
                  <SchemaEditor :model-value="binding.schema" :models="assets?.models ?? []" :read-only="editor.readOnly" @update:model-value="(value) => { if (value) binding.schema = value; }" />
                </div>
              </template>
            </div>
          </div>
          <a-button class="add" type="text" size="small" :disabled="editor.readOnly" :data-testid="`add-${location}`" @click="addParameter(location)">＋ {{ t('editor.addRow') }}</a-button>
        </div>
      </a-tab-pane>

      <a-tab-pane key="auth" force-render>
        <template #tab><span data-testid="tab-auth">{{ t('editor.auth') }}</span></template>
        <div class="panel">
          <div class="auth-controls">
            <label class="auth-kind">
              <span>{{ t("design.authKind") }}</span>
              <a-select :value="request.auth.kind === 'componentRef' ? `component:${request.auth.componentId}` : request.auth.kind" data-testid="auth-type" :aria-label="t('design.authKind')" :disabled="editor.readOnly" :options="[...authKinds.map((value) => ({ label: t(`contract.auth.${value}`), value })), ...(assets?.components.filter((item) => item.kind === 'auth').map((item) => ({ label: item.name, value: `component:${item.id}` })) ?? [])]" @update:value="(value) => setAuthKind(value as string)" />
            </label>
            <button v-if="authReference && !sharedAuth && api && credentialProjectLocator" type="button" class="editor-detail-button"
              data-testid="auth-manage-credentials" aria-controls="request-credential-controls" :aria-expanded="credentialManagementOpen"
              @click="credentialManagementOpen = !credentialManagementOpen">{{ t("requestAuth.manageCredentials") }}</button>
            <button v-if="api && credentialProjectLocator && requestTab?.root" type="button" class="editor-detail-button"
              data-testid="auth-manage-oauth" aria-controls="request-oauth-controls" :aria-expanded="oauthManagementOpen"
              @click="oauthManagementOpen = !oauthManagementOpen">{{ t("oauth.title") }}</button>
          </div>
          <a-input v-if="request.auth.kind === 'basic'" v-model:value="request.auth.username" data-testid="auth-basic-username" :disabled="editor.readOnly" :placeholder="t('contract.username')" />
          <div v-if="request.auth.kind === 'apikey'" class="kv-row">
            <a-input v-model:value="request.auth.name" data-testid="auth-apikey-name" :disabled="editor.readOnly" :placeholder="t('contract.apiKeyName')" />
            <a-select v-model:value="request.auth.placement" data-testid="auth-apikey-placement" :disabled="editor.readOnly" :options="[{ label: t('contract.location.header'), value: 'header' }, { label: t('contract.location.query'), value: 'query' }]" />
          </div>
          <div v-if="authReference" class="auth-reference" data-testid="request-auth-reference">
            <span>{{ t("design.secretReference") }}</span> <code>{{ authReference }}</code>
          </div>
          <div v-if="sharedAuth" class="auth-reference" data-testid="request-shared-auth">
            <span>{{ t("requestAuth.sharedComponent") }}</span>
            <span>{{ sharedAuth.asset?.name ?? t("contract.missingComponent") }}</span>
            <span v-if="effectiveAuth">{{ t(`contract.auth.${effectiveAuth.kind}`) }}</span>
            <button v-if="viewProjectAsset" type="button" class="editor-detail-button" data-testid="auth-view-shared-component"
              @click="viewProjectAsset({ kind: 'auth', id: sharedAuth.id }, $event.currentTarget as HTMLElement)">{{ t("requestAuth.viewComponent") }}</button>
          </div>
          <CredentialEditor v-if="api && credentialProjectLocator && effectiveAuth" id="request-credential-controls"
            :api="api" :locator="credentialProjectLocator" :auth="effectiveAuth" :context-key="credentialContextKey"
            :managed-state="oauthManagedState" :read-only="editor.readOnly || !!sharedAuth" :manage-open="!sharedAuth && credentialManagementOpen"
            :status-only="!!sharedAuth" :status-revision="sharedCredentialStatusRevision" />
          <OAuthManager v-if="api && credentialProjectLocator && requestTab?.root" v-show="oauthManagementOpen"
            id="request-oauth-controls" :api="api" :locator="credentialProjectLocator" :context-key="oauthContextKey"
            :environment-id="selectedEnvironmentId || undefined" :auth="effectiveAuth ?? request.auth" :read-only="editor.readOnly"
            @update:auth="updateRequestAuth" @managed-state="oauthManagedState = $event" />
        </div>
      </a-tab-pane>

      <a-tab-pane v-if="request.protocol === 'http'" key="body">
        <template #tab><span data-testid="tab-body">{{ t('editor.body') }}</span></template>
        <div class="panel">
          <a-radio-group :value="request.body.kind" data-testid="body-kind" :disabled="editor.readOnly" @update:value="(value) => setBodyKind(value as string)">
            <a-radio-button v-for="kind in bodyKinds" :key="kind" :value="kind">{{ t(`contract.body.${kind}`) }}</a-radio-button>
          </a-radio-group>
          <a-textarea v-if="bodyText" :value="bodyText.content" @update:value="setBodyText" class="body-text" data-testid="body-content" :disabled="editor.readOnly" :rows="8" />
          <template v-else-if="request.body.kind === 'graphql'">
            <a-textarea v-model:value="request.body.query" data-testid="body-graphql-query" :disabled="editor.readOnly" :rows="5" />
            <a-textarea v-model:value="request.body.variables" data-testid="body-graphql-variables" :disabled="editor.readOnly" :rows="4" />
            <a-input v-model:value="request.body.operationName" data-testid="body-graphql-operation" :disabled="editor.readOnly" />
          </template>
          <template v-else-if="request.body.kind === 'urlencoded'">
            <div v-for="(field, index) in urlencodedFields" :key="field.id" class="kv-row">
              <a-input v-model:value="field.name" data-testid="body-field-name" :disabled="editor.readOnly" />
              <a-input v-model:value="field.value" data-testid="body-field-value" :disabled="editor.readOnly" />
              <a-checkbox v-model:checked="field.enabled" :disabled="editor.readOnly" />
              <a-button :data-testid="`body-remove-field-${index}`" :disabled="editor.readOnly" @click="removeBodyEntry(request.body, index)">×</a-button>
            </div>
            <a-button data-testid="body-add-field" :disabled="editor.readOnly" @click="addBodyEntry(request.body)">{{ t('editor.addRow') }}</a-button>
          </template>
          <template v-else-if="request.body.kind === 'multipart'">
            <div v-for="(field, index) in multipartEntries" :key="field.id" class="kv-row">
              <a-input v-model:value="field.name" data-testid="body-field-name" :disabled="editor.readOnly" />
              <select :value="field.kind" :data-testid="`body-field-kind-${index}`" :disabled="editor.readOnly" @change="setMultipartEntryKind(index, ($event.target as HTMLSelectElement).value as 'text' | 'file')">
                <option value="text">text</option>
                <option value="file">file</option>
              </select>
              <template v-if="field.kind === 'text'">
                <a-input v-model:value="field.value" data-testid="body-field-value" :disabled="editor.readOnly" />
              </template>
              <template v-else>
                <span :data-testid="`body-file-path-${index}`">{{ chosenFileInfo[`multipart-${field.id}`]?.name ?? (field.file.path ? localFileName(field.file.path) : t('debugLoop.noFileSelected')) }}</span>
                <a-button size="small" :disabled="editor.readOnly" :data-testid="`body-file-pick-${index}`" @click="chooseBinaryFile(field, `multipart-${field.id}`)">{{ t('debugLoop.chooseFile') }}</a-button>
                <span v-if="chosenFileInfo[`multipart-${field.id}`]">{{ chosenFileInfo[`multipart-${field.id}`].size }} B</span>
                <a-input v-model:value="field.filename" :placeholder="t('debugLoop.filename')" :disabled="editor.readOnly" />
                <a-input v-model:value="field.contentType" :data-testid="`body-file-content-type-${index}`" :disabled="editor.readOnly" />
              </template>
              <a-checkbox v-model:checked="field.enabled" :disabled="editor.readOnly" />
              <a-button :data-testid="`body-remove-field-${index}`" :disabled="editor.readOnly" @click="removeBodyEntry(request.body, index)">×</a-button>
            </div>
            <a-button data-testid="body-add-field" :disabled="editor.readOnly" @click="addBodyEntry(request.body)">{{ t('editor.addRow') }}</a-button>
          </template>
          <template v-else-if="request.body.kind === 'binary'">
            <span data-testid="body-binary-path">{{ chosenFileInfo.binary?.name ?? (request.body.file.path ? localFileName(request.body.file.path) : t('debugLoop.noFileSelected')) }}</span>
            <a-button size="small" :disabled="editor.readOnly" data-testid="body-binary-pick" @click="chooseBinaryFile(request.body, 'binary')">{{ t('debugLoop.chooseFile') }}</a-button>
            <span v-if="chosenFileInfo.binary">{{ chosenFileInfo.binary.size }} B</span>
            <a-input v-model:value="request.body.contentType" data-testid="body-binary-content-type" :disabled="editor.readOnly" />
          </template>
          <section v-if="['json', 'xml', 'text'].includes(request.body.kind)" class="body-schema">
            <SchemaEditor :model-value="bodySchema()" :models="models ?? assets?.models ?? []" :read-only="editor.readOnly" :view-model="viewModel" @update:model-value="updateBodySchema($event as SchemaNode | undefined)" />
            <div v-if="bodyExamples().length" class="examples" data-testid="body-examples">
              <span>{{ t('contract.schemaExamples') }}</span>
              <button v-for="(example, index) in bodyExamples()" :key="index" type="button" :data-testid="`body-example-use-${index}`" :disabled="editor.readOnly" @click="useBodyExample(index)">{{ t('contract.useExample', { index: index + 1 }) }}</button>
            </div>
          </section>
        </div>
      </a-tab-pane>

      <a-tab-pane v-if="request.protocol === 'websocket'" key="message">
        <template #tab><span data-testid="tab-message">{{ t('protocol.message') }}</span></template>
        <a-textarea v-model:value="request.message" data-testid="editor-message" :disabled="editor.readOnly" :rows="8" />
      </a-tab-pane>
      <a-tab-pane v-if="request.protocol === 'soap'" key="envelope">
        <template #tab><span data-testid="tab-envelope">{{ t('protocol.envelope') }}</span></template>
        <a-textarea v-model:value="request.envelope" data-testid="editor-envelope" :disabled="editor.readOnly" :rows="8" />
        <a-input v-model:value="request.soapAction" data-testid="editor-soap-action" :disabled="editor.readOnly" />
      </a-tab-pane>
    </a-tabs>
    <details v-if="assets && !isFreeRequest && metadata && editor.api" class="request-extra">
      <summary>{{ t("requestWorkbench.responseContract") }}</summary>
      <ResponseEditor :responses="editor.api.contract.responses" :assets="assets" :context-key="credentialContextKey" :read-only="editor.readOnly" :view-model="viewModel" />
    </details>
    <details v-if="!projectTools && assets && !isFreeRequest" class="request-extra">
      <summary>{{ t("requestWorkbench.projectAssets") }}</summary>
      <ProjectAssetsPanel :assets="assets" :api="api" :credential-context-key="credentialContextKey" :read-only="editor.readOnly" />
    </details>
    <details v-if="!projectTools && api && projectLocator" class="request-extra">
      <summary>{{ t("requestWorkbench.mock") }}</summary>
      <MockPanel :api="api" :root="requestTab?.root" :locator="projectLocator" :read-only="editor.readOnly" @new-free-request="emit('new-free-request')" />
    </details>
    </div>
    <DebugSettings v-if="api" :open="settingsOpen" :api="api" :debug="debug" :editor="editor" :request-tab="requestTab" @close="settingsOpen = false" />
  </section>
  <EmptyState v-else :text="t('editor.empty')" />
</template>

<style scoped>
.editor { container-type: inline-size; display: flex; flex: 1; flex-direction: column; gap: 5px; min-height: 0; padding: 8px 12px 10px; box-sizing: border-box; overflow: hidden; background: var(--bg); }
.editor-header { flex: none; display: flex; flex-direction: column; gap: 5px; }
.request-heading { display: flex; align-items: center; gap: 8px; min-width: 0; }
.free-save-target { width: 100%; margin-top: 10px; }
.free-save-new-module { display: flex; gap: 8px; margin-top: 12px; }
.request-heading-text { flex: 1; min-width: 0; }
.request-heading-text h2, .request-path { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.request-heading-text h2 { color: var(--text); font-size: 20px; line-height: 1.35; }
.request-path { color: var(--text-muted); font-size: 12px; }
.request-command { display: flex; align-items: center; gap: 8px; }
.request-address { flex: 1 1 410px; min-width: 0; display: flex; align-items: center; gap: 0; border: 1px solid var(--border); border-radius: 6px; }
.request-address :deep(.protocol-trigger) { border: 0; border-radius: 5px 0 0 5px; min-height: 30px; padding-inline: 6px; border-inline-end: 1px solid var(--border); }
.request-address :deep(.ant-select-selector), .request-address :deep(.ant-input) { border: 0; border-radius: 0; height: 30px; box-shadow: none; }
.request-address :deep(.ant-input:focus) { outline-offset: -2px; }
.request-address :deep(.ant-select-selector) { background: var(--workbench-method-surface); color: var(--pass); border-inline-end: 1px solid var(--border); }
.request-address .method-select { flex: 0 0 74px; min-width: 0; }
.method-fixed { flex: none; padding: 0 6px; color: var(--pass); }
.request-address .url { flex: 1 1 100px; min-width: 0; }
.request-address .url-path { border-inline-start: 1px solid var(--border); }
.request-actions { display: flex; align-items: center; flex: none; gap: 6px; flex-wrap: wrap; min-width: 0; }
.request-actions :deep(.menu-trigger) { border-color: var(--border); min-height: 32px; }
.send-slot { flex: 0 0 8.6em; width: 8.6em; height: 32px; border: 1px solid transparent; border-radius: 6px; background: #1557d8; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
.send-slot[aria-disabled="true"] { opacity: 0.7; cursor: default; }
.send-slot:focus-visible, .editor-detail-button:focus-visible { outline-offset: 1px; }
.editor-detail-button { flex: none; min-height: 26px; padding: 2px 6px; color: var(--text-muted); border: 1px solid transparent; border-radius: 4px; background: transparent; font: inherit; cursor: pointer; }
.editor-detail-button:hover, .editor-detail-button[aria-expanded="true"] { border-color: var(--border); background: var(--active-weak); color: var(--text); }
.case-select { width: 125px; min-width: 95px; max-width: 100%; }
.request-feedback { margin: 0; overflow-wrap: anywhere; font-size: 12px; }
.request-feedback.error { color: var(--fail); }
.editor-content { flex: 1; min-height: 0; overflow: auto; scrollbar-width: thin; }
.editor-content :deep(.ant-tabs-nav) { margin-bottom: 4px; }
.editor-content :deep(.ant-tabs-tab) { padding: 5px 0; }
.auth-controls, .auth-reference, .auth-kind { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.auth-kind :deep(.ant-select) { min-width: 150px; }
.auth-reference { color: var(--text-muted); overflow-wrap: anywhere; }
.metadata { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(160px, 100%), 1fr)); gap: 8px; align-items: center; padding: 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--subtle); }
.panel { display: flex; flex-direction: column; gap: 10px; overflow: visible; }
.parameter-panel { gap: 0; padding-bottom: 12px; }
.parameter-grid { display: grid; grid-template-columns: 42px minmax(45px, 1fr) minmax(55px, 1fr) minmax(50px, 1.2fr) 64px; align-items: center; min-height: 32px; gap: 4px; }
.parameter-labels { min-height: 20px; padding-inline: 2px; color: var(--text-muted); font-size: 11px; font-weight: 600; }
.parameter-entry { border-bottom: 1px solid var(--border); }
.parameter-actions { display: flex; }
.parameter-details { display: grid; gap: 6px; margin: 0 0 6px; padding: 8px; border: 1px solid var(--border); border-radius: 5px; background: var(--subtle); }
.parameter-details label { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.parameter-details :deep(.ant-select) { min-width: 130px; }
.component-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.request-extra { border-top: 1px solid var(--border); margin-top: 3px; }
.request-extra summary { padding: 5px 0; color: var(--text-muted); cursor: pointer; }
.request-extra[open] summary { color: var(--text); }
@container (max-width: 760px) {
  .request-command { flex-direction: column; align-items: stretch; gap: 5px; }
  .request-address { flex: auto; }
}
@container (max-width: 420px) {
  .request-address { flex-wrap: wrap; }
  .request-address .url-path { flex-basis: 100%; border-inline-start: 0; border-top: 1px solid var(--border); }
  .parameter-grid { grid-template-columns: 32px minmax(38px, 1fr) minmax(45px, 1fr) minmax(50px, 1fr) 54px; gap: 2px; }
  .parameter-labels { font-size: 10px; }
}
.dirty { flex: none; color: var(--accent); font-size: 12px; }
.body-text { font-family: ui-monospace, monospace; resize: vertical; }
.body-schema { display: grid; gap: 8px; }
.examples { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
</style>

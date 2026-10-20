<script setup lang="ts">
import { computed, nextTick, ref, toRaw, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Alert as AAlert, Button as AButton, Checkbox as ACheckbox, Input as AInput, Modal as AModal, RadioButton as ARadioButton, RadioGroup as ARadioGroup, Select as ASelect, TabPane as ATabPane, Tabs as ATabs, Textarea as ATextarea } from "ant-design-vue";
import type { ApiRequest, ComponentAsset, DebugFieldState, ModelAsset, MultipartEntry, ParameterBinding, RequestBody } from "@apicc/core";
import type { SchemaNode } from "@apicc/core/schema";
import type { ApiccApi, CreateComponentInput, CreateModelInput } from "../../../shared/types.js";
import type { ApiParentLocator, ComponentLocator, ModelLocator, ProjectLocator } from "../../../shared/locations.js";
import type { LocalProjectTreeNodeDTO } from "../../../shared/tree-dto.js";
import type { useEditorStore } from "../stores/editor.js";
import type { useDebugStore } from "../stores/debug.js";
import type { RequestTab } from "../stores/requestTabs.js";
import { apiSessionKey } from "../stores/localIdentity.js";
import type { DeleteAssetResult } from "../stores/assets.js";
import EmptyState from "./EmptyState.vue";
import SchemaEditor from "./SchemaEditor.vue";
import ResponseEditor from "./ResponseEditor.vue";
import CredentialEditor from "./CredentialEditor.vue";
import OAuthManager from "./OAuthManager.vue";
import ProjectAssetsPanel from "./ProjectAssetsPanel.vue";
import MockPanel from "./MockPanel.vue";
import DebugSettings from "./DebugSettings.vue";

const emit = defineEmits<{ "new-free-request": [] }>();

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
  projectNode?: LocalProjectTreeNodeDTO | null;
  createFreeModule?: (tab: RequestTab, name: string) => Promise<ApiParentLocator>;
  saveFreeRequest?: (tab: RequestTab, targetParent: ApiParentLocator, name: string, request: ApiRequest, fields: DebugFieldState[]) => Promise<void>;
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
const saveFeedback = ref("");
const saveError = ref("");
const freeSaveOpen = ref(false);
const freeSaveBusy = ref(false);
const freeSaveName = ref("");
const freeSaveParentKey = ref("");
const freeModuleName = ref("");
const createdFreeSaveParents = ref<Array<{ key: string; label: string; locator: ApiParentLocator }>>([]);
let freeSaveOperation = 0;
const settingsOpen = ref(false);
const chosenFileInfo = ref<Record<string, { name: string; size: number }>>({});
const editorElement = ref<HTMLElement | null>(null);
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
const credentialProjectLocator = computed(() => props.requestTab?.project ?? props.projectLocator ?? null);
const oauthManagedState = ref<"managed" | "unmanaged" | "unknown">("unmanaged");

const freeSaveParents = computed(() => {
  const project = props.projectNode;
  const tab = props.requestTab;
  const result: Array<{ key: string; label: string; locator: ApiParentLocator }> = [];
  if (project && tab && tab.source.kind === "free"
    && project.locator.workspaceId === tab.project.workspaceId
    && project.locator.groupId === tab.project.groupId
    && project.locator.projectId === tab.project.projectId) {
    for (const child of project.children) {
      if (child.kind !== "collection") continue;
      const collectionLocator: ApiParentLocator = { ...child.locator };
      result.push({ key: JSON.stringify(collectionLocator), label: child.label, locator: collectionLocator });
      const visitFolders = (nodes: typeof child.children, prefix: string): void => {
        for (const node of nodes ?? []) {
          if (node.kind !== "folder") continue;
          const folderLocator: ApiParentLocator = { ...node.locator, folderIds: [...node.locator.folderIds] };
          const label = `${prefix}/${node.label}`;
          result.push({ key: JSON.stringify(folderLocator), label, locator: folderLocator });
          visitFolders(node.children ?? [], label);
        }
      };
      visitFolders(child.children ?? [], child.label);
    }
  }
  for (const created of createdFreeSaveParents.value) {
    if (!result.some((item) => item.key === created.key)) result.push(created);
  }
  return result;
});

watch(() => props.requestTab?.tabId, () => {
  freeSaveOperation += 1;
  freeSaveOpen.value = false;
  freeSaveBusy.value = false;
  freeSaveParentKey.value = "";
  freeSaveName.value = "";
  freeModuleName.value = "";
  createdFreeSaveParents.value = [];
});

function openFreeSaveDialog() {
  saveError.value = "";
  saveFeedback.value = "";
  freeSaveName.value = "";
  freeSaveParentKey.value = "";
  freeSaveOpen.value = true;
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
    const key = JSON.stringify(locator);
    createdFreeSaveParents.value = [...createdFreeSaveParents.value, { key, label: name, locator }];
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
  const target = freeSaveParents.value.find((item) => item.key === freeSaveParentKey.value)?.locator;
  if (!tab || tab.source.kind !== "free" || !current || !target || !props.saveFreeRequest || !freeSaveName.value.trim()) return;
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
    await props.saveFreeRequest(tab, target, freeSaveName.value.trim(), cloneContract(current),
      (tabDebugState.value?.fields ?? []).map((field) => ({ ...field })));
    if (operation !== freeSaveOperation || props.requestTab?.tabId !== tab.tabId) return;
    saveFeedback.value = t("debugLoop.freeSavedInherited");
    freeSaveOpen.value = false;
  } catch (error) {
    if (operation === freeSaveOperation) saveError.value = error instanceof Error ? error.message : String(error);
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

watch(() => props.requestTab?.tabId, async () => {
  await nextTick();
  if (editorElement.value && tabDebugState.value) editorElement.value.scrollTop = tabDebugState.value.requestScrollTop;
}, { immediate: true, flush: "post" });

function captureRequestScroll(event: Event) {
  if (tabDebugState.value) tabDebugState.value.requestScrollTop = (event.currentTarget as HTMLElement).scrollTop;
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

const selectedEnvironmentId = computed(() => {
  if (tabDebugState.value) return tabDebugState.value.selectedEnvironmentId ?? "";
  return props.editor.envs.some((environment) => environment.name === props.debug.selectedEnvName)
    ? props.debug.selectedEnvName ?? "" : "";
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
  bearerRef: request.value?.auth.kind === "bearer" ? request.value.auth.token : null,
}));

watch(credentialContextKey, () => {
  oauthManagedState.value = props.requestTab ? "unknown" : "unmanaged";
}, { flush: "sync" });

function updateRequestAuth(auth: ApiRequest["auth"]): void {
  const current = request.value;
  if (!current || props.editor.readOnly) return;
  current.auth = auth;
}

function selectEnvironment(value: string) {
  if (tabDebugState.value) tabDebugState.value.selectedEnvironmentId = value || null;
  else props.debug.selectEnv(value || null);
}

function onSend() {
  if (props.requestTab) void props.debug.sendRequestTab(props.requestTab, props.editor);
  else void props.debug.send(props.editor);
}

function onCancel() {
  if (props.requestTab) void props.debug.cancelRequestTab(props.requestTab.tabId);
  else void props.debug.cancel();
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
  const current = request.value;
  if (!current) return [];
  return location === "path" ? current.pathParams
    : location === "query" ? current.query
      : location === "header" ? current.headers : current.cookies;
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
    value: previous.value, enabled: previous.kind === "inline" ? previous.enabled : previous.enabled,
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
  const selected = tabDebugState.value?.selectedCase ?? props.debug.selectedCase;
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

async function onSave() {
  saveFeedback.value = "";
  saveError.value = "";
  try {
    await props.editor.save();
    saveFeedback.value = t("editor.saved");
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : String(error);
  }
}

async function onSaveRequest() {
  saveFeedback.value = "";
  saveError.value = "";
  try {
    await props.editor.saveRequestDraft(currentRestoreMatches.value ? tabDebugState.value?.fields ?? props.debug.restoredFields : []);
    saveFeedback.value = t("debugLoop.requestSaved");
  } catch (error) {
    saveError.value = error instanceof Error ? error.message : String(error);
  }
}
</script>

<template>
  <section v-if="request" class="editor" data-testid="request-editor" :data-source-kind="isFreeRequest ? 'free' : 'asset'">
    <div class="editor-header">
    <div class="top-row">
      <a-radio-group :value="request.protocol" data-testid="editor-protocol" :disabled="editor.readOnly" @update:value="switchProtocol">
        <a-radio-button v-for="protocol in ['http', 'websocket', 'soap']" :key="protocol" :value="protocol">{{ t(`protocol.${protocol}`) }}</a-radio-button>
      </a-radio-group>
      <a-select v-if="request.protocol === 'http'" v-model:value="request.method" class="method-select" data-testid="editor-method" :disabled="editor.readOnly" :options="methods.map((value) => ({ label: value, value }))" />
      <span v-else-if="request.protocol === 'soap'" data-testid="editor-method">POST</span>
      <template v-if="isFreeRequest && freeSession && request.protocol === 'http'">
        <a-input :value="freeSession.urlDraft" class="url full-url" data-testid="editor-full-url" :disabled="editor.readOnly" :placeholder="t('editor.fullUrl')" @update:value="updateFullUrl" />
        <a-alert v-if="freeSession.urlDraftInvalid" type="error" :message="t('editor.invalidFullUrl')" data-testid="free-url-draft-error" />
      </template>
      <template v-else>
        <a-input v-model:value="request.baseUrl" class="url" data-testid="editor-base-url" :disabled="editor.readOnly" :placeholder="t('editor.baseUrl')" />
        <a-input v-model:value="request.path" class="url" data-testid="editor-path" :disabled="editor.readOnly" :placeholder="t('editor.path')" />
      </template>
      <a-select data-testid="debug-env-select" :value="selectedEnvironmentId" :options="[{ label: t('editor.noEnv'), value: '' }, ...editor.envs.map((e) => ({ label: e.name, value: tabDebugState ? e.id : e.name }))]" @update:value="(value) => selectEnvironment(value as string)" />
      <a-select v-if="!isFreeRequest" data-testid="debug-case-select" :value="activeCaseValue()" :options="(editor.api?.cases ?? []).map((item) => ({ label: `${item.name} (${item.scope})`, value: caseValue({ caseId: item.id, scope: item.scope }) }))" @update:value="(value) => selectDebugCase(value as string)" />
      <a-button type="primary" data-testid="send-btn" :disabled="(tabDebugState?.sending ?? debug.sending) || pendingRestoreFields.length > 0" @click="onSend">{{ (tabDebugState?.sending ?? debug.sending) ? t('editor.sending') : t('editor.send') }}</a-button>
      <a-button v-if="(tabDebugState?.sending ?? debug.sending) && (tabDebugState?.activeRunId ?? debug.activeRunId)" data-testid="debug-cancel" @click="onCancel">{{ t('debugLoop.cancelRun') }}</a-button>
      <a-button data-testid="debug-settings-open" @click="settingsOpen = true">{{ t('debugLoop.settings') }}</a-button>
      <template v-if="!isFreeRequest">
        <a-button data-testid="save-request-btn" :disabled="editor.readOnly || pendingRestoreFields.length > 0" @click="onSaveRequest">{{ t('debugLoop.saveRequest') }}</a-button>
        <a-button data-testid="save-btn" :disabled="editor.readOnly || pendingRestoreFields.length > 0" @click="onSave">{{ t('editor.save') }}</a-button>
      </template>
      <a-button v-else data-testid="save-free-btn" :disabled="editor.readOnly || freeSession?.urlDraftInvalid || pendingRestoreFields.length > 0 || !props.saveFreeRequest" @click="openFreeSaveDialog">{{ t('debugLoop.freeSaveAsApi') }}</a-button>
      <span v-if="saveFeedback" data-testid="save-feedback">{{ saveFeedback }}</span>
      <span v-if="saveError" data-testid="save-error">{{ saveError }}</span>
    </div>
    </div>

    <a-modal :open="freeSaveOpen" :title="t('debugLoop.freeSaveTitle')" :confirm-loading="freeSaveBusy" @cancel="freeSaveOpen = false">
      <a-input v-model:value="freeSaveName" data-testid="free-save-name" :placeholder="t('debugLoop.freeSaveName')" />
      <template v-if="freeSaveParents.length">
        <a-select v-model:value="freeSaveParentKey" class="free-save-target" :placeholder="t('debugLoop.freeSaveTarget')" :options="freeSaveParents.map((item) => ({ label: item.label, value: item.key }))" data-testid="free-save-target" />
        <p class="note">{{ t("debugLoop.freeSaveInheritanceNote") }}</p>
      </template>
      <template v-else>
        <a-alert type="warning" show-icon :message="t('debugLoop.freeSaveNeedsModule')" data-testid="free-save-needs-module" />
        <a-input v-model:value="freeModuleName" data-testid="free-save-module-name" :placeholder="t('debugLoop.freeSaveModuleName')" />
        <a-button data-testid="free-save-create-module" :disabled="editor.readOnly || !freeModuleName.trim() || !props.createFreeModule" :loading="freeSaveBusy" @click="onCreateFreeModule">{{ t("debugLoop.freeSaveCreateModule") }}</a-button>
      </template>
      <a-alert v-if="saveError" type="error" show-icon :message="saveError" data-testid="free-save-error" />
      <template #footer>
        <a-button @click="freeSaveOpen = false">{{ t("debugLoop.freeSaveCancel") }}</a-button>
        <a-button type="primary" data-testid="free-save-submit" :disabled="editor.readOnly || freeSession?.urlDraftInvalid || !freeSaveParents.some((item) => item.key === freeSaveParentKey) || !freeSaveName.trim() || !props.saveFreeRequest || pendingRestoreFields.length > 0 || tabDebugState?.fields.some((field) => field.needsInput)" :loading="freeSaveBusy" @click="submitFreeSave">{{ t("debugLoop.freeSaveSubmit") }}</a-button>
      </template>
    </a-modal>

    <div ref="editorElement" class="editor-content" data-testid="request-editor-scroll" @scroll="captureRequestScroll">
    <section v-if="metadata" class="metadata" aria-label="API metadata">
      <a-input v-model:value="metadata.name" data-testid="asset-metadata-name" :disabled="editor.readOnly" :placeholder="t('contract.metadataName')" />
      <a-input v-model:value="metadata.description" data-testid="asset-metadata-description" :disabled="editor.readOnly" :placeholder="t('contract.metadataDescription')" />
      <a-input :value="metadata.tags.join(', ')" data-testid="asset-metadata-tags" :disabled="editor.readOnly" :placeholder="t('contract.metadataTags')" @update:value="metadataTags" />
      <a-input v-model:value="metadata.version" data-testid="asset-metadata-version" :disabled="editor.readOnly" :placeholder="t('contract.metadataVersion')" />
      <a-select v-model:value="metadata.status" data-testid="asset-metadata-status" :disabled="editor.readOnly" :options="['draft', 'published', 'deprecated'].map((value) => ({ label: t(`contract.status.${value}`), value }))" />
      <span v-if="editor.dirty" class="dirty" :title="t('editor.unsaved')">●</span>
    </section>
    <a-tabs v-model:active-key="requestPanel">
      <a-tab-pane v-for="location in parameterLocations" :key="location">
        <template #tab><span :data-testid="`tab-${location}`">{{ t(`contract.location.${location}`) }}</span></template>
        <div class="panel">
          <div v-for="(binding, index) in parameterList(location)" :key="binding.id" class="kv-row">
            <a-select v-if="assets" :value="binding.kind === 'componentRef' ? binding.componentId : ''" :data-testid="`parameter-component-${location}-${index}`" :disabled="editor.readOnly" :options="[{ label: t('contract.inlineParameter'), value: '' }, ...parameterComponents(location).map((item) => ({ label: item.name, value: item.id }))]" @update:value="(value) => bindParameter(location, index, value as string)" />
            <template v-if="binding.kind === 'inline'">
              <a-input v-model:value="binding.name" data-testid="kv-key" :disabled="editor.readOnly" placeholder="name" />
              <a-input v-model:value="binding.value" data-testid="kv-value" :disabled="editor.readOnly" placeholder="value" />
              <a-input v-model:value="binding.description" :disabled="editor.readOnly" :placeholder="t('contract.description')" />
              <a-checkbox v-model:checked="binding.required" :data-testid="`parameter-required-${location}-${index}`" :disabled="editor.readOnly">{{ t('contract.required') }}</a-checkbox>
              <div :data-testid="`parameter-schema-${location}-${index}`">
                <SchemaEditor :model-value="binding.schema" :models="assets?.models ?? []" :read-only="editor.readOnly" @update:model-value="(value) => { if (value) binding.schema = value; }" />
              </div>
            </template>
            <template v-else>
              <span>{{ parameterComponents(location).find((item) => item.id === binding.componentId)?.name ?? t('contract.missingComponent') }}</span>
              <a-input v-model:value="binding.value" data-testid="kv-value" :disabled="editor.readOnly" placeholder="value" />
            </template>
            <a-checkbox v-model:checked="binding.enabled" data-testid="kv-enabled" :disabled="editor.readOnly" />
            <a-button danger type="text" size="small" data-testid="kv-remove" :disabled="editor.readOnly" @click="removeParameter(location, index)">×</a-button>
          </div>
          <a-button class="add" :disabled="editor.readOnly" :data-testid="`add-${location}`" @click="addParameter(location)">{{ t('editor.addRow') }}</a-button>
        </div>
      </a-tab-pane>

      <a-tab-pane key="auth">
        <template #tab><span data-testid="tab-auth">{{ t('editor.auth') }}</span></template>
        <div class="panel">
          <a-select :value="request.auth.kind === 'componentRef' ? `component:${request.auth.componentId}` : request.auth.kind" data-testid="auth-type" :disabled="editor.readOnly" :options="[...authKinds.map((value) => ({ label: t(`contract.auth.${value}`), value })), ...(assets?.components.filter((item) => item.kind === 'auth').map((item) => ({ label: item.name, value: `component:${item.id}` })) ?? [])]" @update:value="(value) => setAuthKind(value as string)" />
          <a-input v-if="request.auth.kind === 'basic'" v-model:value="request.auth.username" data-testid="auth-basic-username" :disabled="editor.readOnly" :placeholder="t('contract.username')" />
          <div v-if="request.auth.kind === 'apikey'" class="kv-row">
            <a-input v-model:value="request.auth.name" data-testid="auth-apikey-name" :disabled="editor.readOnly" :placeholder="t('contract.apiKeyName')" />
            <a-select v-model:value="request.auth.placement" data-testid="auth-apikey-placement" :disabled="editor.readOnly" :options="[{ label: t('contract.location.header'), value: 'header' }, { label: t('contract.location.query'), value: 'query' }]" />
          </div>
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
            <SchemaEditor :model-value="bodySchema()" :models="assets?.models ?? []" :read-only="editor.readOnly" @update:model-value="updateBodySchema($event as SchemaNode | undefined)" />
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
    <ResponseEditor v-if="assets && !isFreeRequest && metadata && editor.api" :responses="editor.api.contract.responses" :assets="assets" :context-key="credentialContextKey" :read-only="editor.readOnly" />
    <ProjectAssetsPanel v-if="assets && !isFreeRequest" :assets="assets" :api="api" :credential-context-key="credentialContextKey" :read-only="editor.readOnly" />
    <MockPanel v-if="api && projectLocator" :api="api" :root="requestTab?.root" :locator="projectLocator" :read-only="editor.readOnly" @new-free-request="emit('new-free-request')" />
    <CredentialEditor v-if="api && credentialProjectLocator" :api="api" :locator="credentialProjectLocator" :auth="request.auth" :context-key="credentialContextKey" :managed-state="oauthManagedState" :read-only="editor.readOnly" />
    <OAuthManager
      v-if="api && credentialProjectLocator && requestTab?.root"
      :api="api"
      :locator="credentialProjectLocator"
      :context-key="oauthContextKey"
      :environment-id="selectedEnvironmentId || undefined"
      :auth="request.auth"
      :read-only="editor.readOnly"
      @update:auth="updateRequestAuth"
      @managed-state="oauthManagedState = $event"
    />
    </div>
    <DebugSettings v-if="api" :open="settingsOpen" :api="api" :debug="debug" :editor="editor" :request-tab="requestTab" @close="settingsOpen = false" />
  </section>
  <EmptyState v-else :text="t('editor.empty')" />
</template>

<style scoped>
.editor { display: flex; flex: 1; flex-direction: column; gap: 8px; min-height: 0; padding: 10px; box-sizing: border-box; overflow: hidden; }
.editor-header { flex: none; display: flex; flex-direction: column; gap: 8px; }
.editor-content { flex: 1; min-height: 0; overflow: auto; }
.metadata { display: grid; grid-template-columns: repeat(4, minmax(120px, 1fr)); gap: 6px; align-items: center; }
.top-row { display: flex; gap: 8px; flex-wrap: wrap; }
.url { flex: 1; min-width: 120px; }
.panel { display: flex; flex-direction: column; gap: 6px; overflow: visible; }
.kv-row { display: flex; gap: 6px; align-items: center; }
.kv-row > * { flex: 1; }
.dirty { color: var(--accent); }
.body-text { font-family: ui-monospace, monospace; resize: vertical; }
.body-schema { display: grid; gap: 8px; }
.examples { display: flex; gap: 8px; align-items: center; }
</style>

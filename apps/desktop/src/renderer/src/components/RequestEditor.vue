<script setup lang="ts">
import { computed, ref, toRaw } from "vue";
import { useI18n } from "vue-i18n";
import { Button as AButton, Checkbox as ACheckbox, Input as AInput, RadioButton as ARadioButton, RadioGroup as ARadioGroup, Select as ASelect, TabPane as ATabPane, Tabs as ATabs, Textarea as ATextarea } from "ant-design-vue";
import type { ApiRequest, ComponentAsset, ModelAsset, MultipartEntry, ParameterBinding, RequestBody } from "@apicc/core";
import type { SchemaNode } from "@apicc/core/schema";
import type { ApiccApi, CreateComponentInput, CreateModelInput } from "../../../shared/types.js";
import type { ComponentLocator, ModelLocator, ProjectLocator } from "../../../shared/locations.js";
import type { useEditorStore } from "../stores/editor.js";
import type { useDebugStore } from "../stores/debug.js";
import type { DeleteAssetResult } from "../stores/assets.js";
import EmptyState from "./EmptyState.vue";
import SchemaEditor from "./SchemaEditor.vue";
import ResponseEditor from "./ResponseEditor.vue";
import CredentialEditor from "./CredentialEditor.vue";
import ProjectAssetsPanel from "./ProjectAssetsPanel.vue";

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
}>();
const { t } = useI18n();
const request = computed<ApiRequest | null>(() => props.editor.api?.contract.request ?? null);
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
const metadata = computed(() => props.editor.api?.contract.metadata ?? null);
const credentialContextKey = computed(() => {
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
const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const authKinds = ["none", "bearer", "basic", "apikey"];
const bodyKinds = ["none", "json", "xml", "text", "graphql", "urlencoded", "multipart", "binary"];
const parameterLocations = ["path", "query", "header", "cookie"] as const;
type ParameterLocation = (typeof parameterLocations)[number];

function cloneContract<T>(value: T): T {
  return JSON.parse(JSON.stringify(toRaw(value))) as T;
}

function secretRef() {
  return { id: crypto.randomUUID(), policy: "test-auto" };
}

function switchProtocol(next: ApiRequest["protocol"]) {
  const asset = props.editor.api;
  const slotKey = props.editor.activeKey;
  const session = slotKey ? props.editor.sessions[slotKey] : undefined;
  const current = asset?.contract.request;
  if (!asset || !session || !current || current.protocol === next) return;
  session.protocolDrafts[current.protocol] = cloneContract(current);
  const saved = session.protocolDrafts[next] as ApiRequest | undefined;
  if (saved) {
    asset.contract.request = cloneContract(saved);
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
  if (next === "http") asset.contract.request = { ...common, protocol: "http", method: "GET", body: { kind: "none" } };
  else if (next === "websocket") asset.contract.request = { ...common, protocol: "websocket" };
  else asset.contract.request = { ...common, protocol: "soap", method: "POST", envelope: "" };
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

function caseValue(identity: { caseId: string; scope: string }): string {
  return JSON.stringify([identity.caseId, identity.scope]);
}

function activeCaseValue(): string {
  const cases = props.editor.api?.cases ?? [];
  const selected = props.debug.selectedCase;
  const active = cases.find((item) => item.id === selected?.caseId && item.scope === selected.scope) ?? cases[0];
  return active ? caseValue({ caseId: active.id, scope: active.scope }) : "";
}

function selectDebugCase(value: string) {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
      props.debug.selectCase({ caseId: parsed[0], scope: parsed[1] });
    }
  } catch {
    props.debug.selectCase(null);
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
</script>

<template>
  <section v-if="editor.api && request && metadata" class="editor" data-testid="request-editor">
    <section class="metadata" aria-label="API metadata">
      <a-input v-model:value="metadata.name" data-testid="asset-metadata-name" :disabled="editor.readOnly" :placeholder="t('contract.metadataName')" />
      <a-input v-model:value="metadata.description" data-testid="asset-metadata-description" :disabled="editor.readOnly" :placeholder="t('contract.metadataDescription')" />
      <a-input :value="metadata.tags.join(', ')" data-testid="asset-metadata-tags" :disabled="editor.readOnly" :placeholder="t('contract.metadataTags')" @update:value="metadataTags" />
      <a-input v-model:value="metadata.version" data-testid="asset-metadata-version" :disabled="editor.readOnly" :placeholder="t('contract.metadataVersion')" />
      <a-select v-model:value="metadata.status" data-testid="asset-metadata-status" :disabled="editor.readOnly" :options="['draft', 'published', 'deprecated'].map((value) => ({ label: t(`contract.status.${value}`), value }))" />
      <span v-if="editor.dirty" class="dirty" :title="t('editor.unsaved')">●</span>
    </section>

    <div class="top-row">
      <a-radio-group :value="request.protocol" data-testid="editor-protocol" :disabled="editor.readOnly" @update:value="switchProtocol">
        <a-radio-button v-for="protocol in ['http', 'websocket', 'soap']" :key="protocol" :value="protocol">{{ t(`protocol.${protocol}`) }}</a-radio-button>
      </a-radio-group>
      <a-select v-if="request.protocol === 'http'" v-model:value="request.method" class="method-select" data-testid="editor-method" :disabled="editor.readOnly" :options="methods.map((value) => ({ label: value, value }))" />
      <span v-else-if="request.protocol === 'soap'" data-testid="editor-method">POST</span>
      <a-input v-model:value="request.baseUrl" class="url" data-testid="editor-base-url" :disabled="editor.readOnly" :placeholder="t('editor.baseUrl')" />
      <a-input v-model:value="request.path" class="url" data-testid="editor-path" :disabled="editor.readOnly" :placeholder="t('editor.path')" />
      <a-select data-testid="debug-env-select" :value="(editor.envs ?? []).some((e) => e.name === debug.selectedEnvName) ? debug.selectedEnvName ?? '' : ''" :options="[{ label: t('editor.noEnv'), value: '' }, ...editor.envs.map((e) => ({ label: e.name, value: e.name }))]" @update:value="(value) => debug.selectEnv(value === '' ? null : (value as string))" />
      <a-select data-testid="debug-case-select" :value="activeCaseValue()" :options="(editor.api?.cases ?? []).map((item) => ({ label: `${item.name} (${item.scope})`, value: caseValue({ caseId: item.id, scope: item.scope }) }))" @update:value="(value) => selectDebugCase(value as string)" />
      <a-button type="primary" data-testid="send-btn" :disabled="debug.sending" @click="debug.send(editor)">{{ debug.sending ? t('editor.sending') : t('editor.send') }}</a-button>
      <a-button data-testid="save-btn" :disabled="editor.readOnly" @click="onSave">{{ t('editor.save') }}</a-button>
      <span v-if="saveFeedback" data-testid="save-feedback">{{ saveFeedback }}</span>
      <span v-if="saveError" data-testid="save-error">{{ saveError }}</span>
    </div>

    <a-tabs>
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
                <a-input v-model:value="field.file.path" :data-testid="`body-file-path-${index}`" :disabled="editor.readOnly" />
                <a-input v-model:value="field.contentType" :data-testid="`body-file-content-type-${index}`" :disabled="editor.readOnly" />
              </template>
              <a-checkbox v-model:checked="field.enabled" :disabled="editor.readOnly" />
              <a-button :data-testid="`body-remove-field-${index}`" :disabled="editor.readOnly" @click="removeBodyEntry(request.body, index)">×</a-button>
            </div>
            <a-button data-testid="body-add-field" :disabled="editor.readOnly" @click="addBodyEntry(request.body)">{{ t('editor.addRow') }}</a-button>
          </template>
          <template v-else-if="request.body.kind === 'binary'">
            <a-input v-model:value="request.body.file.path" data-testid="body-binary-path" :disabled="editor.readOnly" />
            <a-input v-model:value="request.body.contentType" data-testid="body-binary-content-type" :disabled="editor.readOnly" />
            <p>{{ t('contract.transferNotImplemented') }}</p>
          </template>
          <p v-if="request.body.kind === 'multipart'">{{ t('contract.transferNotImplemented') }}</p>
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
    <ResponseEditor v-if="assets" :responses="editor.api.contract.responses" :assets="assets" :context-key="credentialContextKey" :read-only="editor.readOnly" />
    <ProjectAssetsPanel v-if="assets" :assets="assets" :api="api" :credential-context-key="credentialContextKey" :read-only="editor.readOnly" />
    <CredentialEditor v-if="api && projectLocator" :api="api" :locator="projectLocator" :auth="request.auth" :context-key="credentialContextKey" :read-only="editor.readOnly" />
  </section>
  <EmptyState v-else :text="t('editor.empty')" />
</template>

<style scoped>
.editor { display: flex; flex-direction: column; gap: 8px; padding: 10px; height: 100%; box-sizing: border-box; overflow: auto; }
.metadata { display: grid; grid-template-columns: repeat(4, minmax(120px, 1fr)); gap: 6px; align-items: center; }
.top-row { display: flex; gap: 8px; flex-wrap: wrap; }
.url { flex: 1; min-width: 120px; }
.panel { display: flex; flex-direction: column; gap: 6px; overflow: auto; }
.kv-row { display: flex; gap: 6px; align-items: center; }
.kv-row > * { flex: 1; }
.dirty { color: var(--accent); }
.body-text { font-family: ui-monospace, monospace; resize: vertical; }
.body-schema { display: grid; gap: 8px; }
.examples { display: flex; gap: 8px; align-items: center; }
</style>

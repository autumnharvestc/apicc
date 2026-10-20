<script setup lang="ts">
import { computed, toRaw } from "vue";
import { useI18n } from "vue-i18n";
import { Input as AInput } from "ant-design-vue";
import type { ApiRequest, ComponentAsset, ModelAsset, MultipartEntry, ParameterBinding } from "@apicc/core";
import type { SchemaNode } from "@apicc/core/schema";
import type { useEditorStore } from "../stores/editor.js";
import type { DesignControlDraft } from "../stores/design.js";
import SchemaEditor from "./SchemaEditor.vue";
import ResponseEditor from "./ResponseEditor.vue";

const props = withDefaults(defineProps<{
  editor: ReturnType<typeof useEditorStore>;
  assets?: { models: ModelAsset[]; components: ComponentAsset[] };
  draftScope: string;
  drafts: Record<string, DesignControlDraft>;
  readOnly?: boolean;
}>(), { assets: () => ({ models: [], components: [] }), readOnly: false });
const emit = defineEmits<{
  "update:controlDraft": [path: string, value: string, error: string | null];
  "clear:control-drafts": [prefix: string];
  "move:control-drafts": [fromPrefix: string, toPrefix: string];
}>();
const { t } = useI18n();
const asset = computed(() => props.editor.api);
const request = computed(() => asset.value?.contract.request ?? null);
const parameterGroups = [
  { key: "pathParams", name: "path", location: "path" }, { key: "query", name: "query", location: "query" },
  { key: "headers", name: "header", location: "header" }, { key: "cookies", name: "cookie", location: "cookie" },
] as const;
const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
const bodyKinds = ["none", "json", "xml", "text", "graphql", "urlencoded", "multipart", "binary"] as const;
const protocols = ["http", "websocket", "soap"] as const;
function forwardControlDraft(path: string, value: string, error: string | null) {
  emit("update:controlDraft", path, value, error);
}

function clearControlDrafts(prefix: string) {
  if (prefix) emit("clear:control-drafts", prefix);
}

function forwardMoveControlDrafts(fromPrefix: string, toPrefix: string) {
  emit("move:control-drafts", fromPrefix, toPrefix);
}

function parameterDraftScope(key: (typeof parameterGroups)[number]["key"], binding: ParameterBinding): string {
  return `${props.draftScope}.request.${key}.${binding.id}`;
}

function parameterComponents(location: (typeof parameterGroups)[number]["location"]): Extract<ComponentAsset, { kind: "parameter" }>[] {
  return props.assets.components.filter((item): item is Extract<ComponentAsset, { kind: "parameter" }> =>
    item.kind === "parameter" && item.definition.location === location);
}

function parameterComponentName(location: (typeof parameterGroups)[number]["location"], componentId: string): string {
  return parameterComponents(location).find((item) => item.id === componentId)?.name ?? t("contract.missingComponent");
}

function newId(): string {
  return crypto.randomUUID();
}

function setProtocol(protocol: string) {
  if (props.readOnly || !asset.value || !request.value || !protocols.includes(protocol as (typeof protocols)[number]) || request.value.protocol === protocol) return;
  const prior = request.value;
  clearControlDrafts(`${props.draftScope}.request.body`);
  const common = {
    baseUrl: prior.baseUrl, path: prior.path,
    pathParams: prior.pathParams, query: prior.query, headers: prior.headers, cookies: prior.cookies, auth: prior.auth,
  };
  let next: ApiRequest;
  if (protocol === "http") next = { protocol: "http", ...common, method: "GET", body: { kind: "none" } };
  else if (protocol === "websocket") next = { protocol: "websocket", ...common };
  else next = { protocol: "soap", ...common, method: "POST", envelope: "", soapAction: "" };
  asset.value.contract.request = next;
}

function setName(value: string) {
  if (!props.readOnly && asset.value) asset.value.contract.metadata.name = value;
}

function setBodyKind(kind: string) {
  if (props.readOnly || request.value?.protocol !== "http") return;
  const bodyKind = kind as (typeof bodyKinds)[number];
  if (!bodyKinds.includes(bodyKind) || request.value.body.kind === bodyKind) return;
  clearControlDrafts(`${props.draftScope}.request.body`);
  switch (bodyKind) {
    case "none": request.value.body = { kind: bodyKind }; break;
    case "json": case "xml": case "text": request.value.body = { kind: bodyKind, content: "" }; break;
    case "graphql": request.value.body = { kind: bodyKind, query: "", variables: "" }; break;
    case "urlencoded": request.value.body = { kind: bodyKind, fields: [] }; break;
    case "multipart": request.value.body = { kind: bodyKind, entries: [] }; break;
    case "binary": request.value.body = { kind: bodyKind, file: { path: "" }, contentType: "application/octet-stream" }; break;
  }
}

function setBodySchema(value: SchemaNode | undefined) {
  if (props.readOnly || request.value?.protocol !== "http") return;
  const body = request.value.body;
  if (body.kind === "json" || body.kind === "xml" || body.kind === "text") {
    if (value) body.schema = value;
    else {
      clearControlDrafts(`${props.draftScope}.request.body.schema`);
      delete body.schema;
    }
  }
}

function groupBindings(key: (typeof parameterGroups)[number]["key"]): ParameterBinding[] {
  const current = request.value;
  return current ? current[key] : [];
}

function addParameter(key: (typeof parameterGroups)[number]["key"]) {
  if (props.readOnly || !request.value) return;
  groupBindings(key).push({ kind: "inline", id: crypto.randomUUID(), name: "", schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "", value: "" });
}

function removeParameter(key: (typeof parameterGroups)[number]["key"], binding: ParameterBinding) {
  if (props.readOnly || !request.value) return;
  clearControlDrafts(parameterDraftScope(key, binding));
  const list = groupBindings(key);
  const index = list.indexOf(binding);
  if (index >= 0) list.splice(index, 1);
}

function bindParameter(key: (typeof parameterGroups)[number]["key"], index: number, componentId: string) {
  if (props.readOnly || !request.value) return;
  const list = groupBindings(key);
  const previous = list[index];
  if (!previous) return;
  const group = parameterGroups.find((item) => item.key === key)!;
  if (!componentId) {
    if (previous.kind !== "componentRef") return;
    clearControlDrafts(`${parameterDraftScope(key, previous)}.schema`);
    const component = parameterComponents(group.location).find((item) => item.id === previous.componentId);
    list.splice(index, 1, {
      kind: "inline",
      id: previous.id,
      name: component?.definition.name ?? "",
      schema: component ? structuredClone(toRaw(component.definition.schema)) : { kind: "scalar", type: "string" },
      required: component?.definition.required ?? false,
      enabled: previous.enabled !== false,
      description: component?.definition.description ?? "",
      value: previous.value ?? "",
    });
    return;
  }
  const component = parameterComponents(group.location).find((item) => item.id === componentId);
  if (!component || (previous.kind === "componentRef" && previous.componentId === componentId)) return;
  clearControlDrafts(`${parameterDraftScope(key, previous)}.schema`);
  list.splice(index, 1, {
    kind: "componentRef", id: previous.id, componentId: component.id, expectedKind: "parameter",
    value: previous.value ?? "", enabled: previous.enabled !== false,
  });
}

function setParameterEnabled(binding: ParameterBinding, event: Event) {
  if (props.readOnly) return;
  binding.enabled = (event.target as HTMLInputElement).checked;
}

function setMultipartEntryKind(index: number, kind: string) {
  if (props.readOnly || request.value?.protocol !== "http" || request.value.body.kind !== "multipart") return;
  if (kind !== "text" && kind !== "file") return;
  const previous = request.value.body.entries[index];
  if (!previous || previous.kind === kind) return;
  const next: MultipartEntry = kind === "file"
    ? { kind, id: previous.id, name: previous.name, file: { path: "" }, filename: "", contentType: "application/octet-stream", enabled: previous.enabled }
    : { kind, id: previous.id, name: previous.name, value: "", enabled: previous.enabled };
  request.value.body.entries.splice(index, 1, next);
}

function addBodyEntry(body: Extract<ApiRequest, { protocol: "http" }>['body']): void {
  if (props.readOnly) return;
  if (body.kind === "urlencoded") body.fields.push({ id: newId(), name: "", value: "", enabled: true });
  else if (body.kind === "multipart") body.entries.push({ kind: "text", id: newId(), name: "", value: "", enabled: true });
}

function removeBodyEntry(index: number): void {
  if (props.readOnly || request.value?.protocol !== "http") return;
  const body = request.value.body;
  if (body.kind === "urlencoded") body.fields.splice(index, 1);
  else if (body.kind === "multipart") body.entries.splice(index, 1);
}

function setAuthKind(kind: string) {
  if (props.readOnly || !request.value) return;
  if (kind === "none") request.value.auth = { kind: "none" };
  else if (kind === "bearer") request.value.auth = { kind, token: { id: "", policy: "" } };
  else if (kind === "basic") request.value.auth = { kind, username: "", password: { id: "", policy: "" } };
  else if (kind === "apikey") request.value.auth = { kind, name: "", placement: "header", value: { id: "", policy: "" } };
  else if (kind === "componentRef") {
    const auth = props.assets?.components.find((item) => item.kind === "auth");
    if (auth) request.value.auth = { kind, componentId: auth.id, expectedKind: "auth" };
  }
}

function authComponents() {
  return props.assets?.components.filter((component) => component.kind === "auth") ?? [];
}
</script>

<template>
  <section v-if="asset && request" class="contract-designer" data-testid="contract-designer">
    <fieldset :disabled="readOnly" class="metadata">
      <legend>{{ t('design.metadata') }}</legend>
      <label>{{ t('design.apiName') }}<a-input :value="asset.contract.metadata.name" :disabled="readOnly" data-testid="design-api-name" @update:value="setName" /></label>
      <label>{{ t('design.description') }}<textarea v-model="asset.contract.metadata.description" :disabled="readOnly" data-testid="design-api-description" /></label>
      <label>{{ t('design.version') }}<input v-model="asset.contract.metadata.version" :disabled="readOnly" data-testid="design-api-version" /></label>
      <label>{{ t('design.tags') }}<input :value="asset.contract.metadata.tags.join(', ')" :disabled="readOnly" data-testid="design-api-tags" @change="asset.contract.metadata.tags = ($event.target as HTMLInputElement).value.split(',').map((tag) => tag.trim()).filter(Boolean)" /></label>
      <label>{{ t('design.status') }}<select v-model="asset.contract.metadata.status" :disabled="readOnly" data-testid="design-api-status"><option value="draft">draft</option><option value="published">published</option><option value="deprecated">deprecated</option></select></label>
    </fieldset>

    <fieldset :disabled="readOnly" class="request">
      <legend>{{ t('design.request') }}</legend>
      <div class="request-grid">
        <label>{{ t('design.protocol') }}<select :value="request.protocol" data-testid="design-protocol" @change="setProtocol(($event.target as HTMLSelectElement).value)"><option v-for="protocol in protocols" :key="protocol" :value="protocol">{{ t(`protocol.${protocol}`) }}</option></select></label>
        <label v-if="request.protocol !== 'websocket'">{{ t('editor.method') }}<select v-if="request.protocol === 'http'" v-model="request.method" data-testid="design-method"><option v-for="method in methods" :key="method" :value="method">{{ method }}</option></select><input v-else value="POST" disabled data-testid="design-method" /></label>
        <label>{{ t('editor.baseUrl') }}<input v-model="request.baseUrl" data-testid="design-base-url" /></label>
        <label>{{ t('editor.path') }}<input v-model="request.path" data-testid="design-path" /></label>
      </div>

      <section v-for="group in parameterGroups" :key="group.key" class="parameter-group">
        <header><strong>{{ t(`design.parameter.${group.name}`) }}</strong><button type="button" :disabled="readOnly" :data-testid="`design-add-parameter-${group.key}`" @click="addParameter(group.key)">{{ t('editor.addRow') }}</button></header>
        <div v-for="(binding, index) in groupBindings(group.key)" :key="binding.id" class="parameter-row">
          <select :value="binding.kind === 'componentRef' ? binding.componentId : ''" :data-testid="`design-parameter-component-${group.key}-${index}`" :disabled="readOnly" :aria-label="t('design.parameter.reference')" @change="bindParameter(group.key, index, ($event.target as HTMLSelectElement).value)">
            <option value="">{{ t('contract.inlineParameter') }}</option>
            <option v-for="component in parameterComponents(group.location)" :key="component.id" :value="component.id">{{ component.name }}</option>
          </select>
          <template v-if="binding.kind === 'inline'">
            <input v-model="binding.name" :placeholder="t('design.parameter.name')" :data-testid="`design-parameter-name-${group.key}-${index}`" />
            <input v-model="binding.value" :placeholder="t('design.parameter.value')" :data-testid="`design-parameter-value-${group.key}-${index}`" />
            <input v-model="binding.description" :placeholder="t('design.description')" :data-testid="`design-parameter-description-${group.key}-${index}`" />
            <label><input v-model="binding.required" type="checkbox" :data-testid="`design-parameter-required-${group.key}-${index}`" />{{ t('contract.required') }}</label>
            <SchemaEditor :model-value="binding.schema" :models="assets.models" :read-only="readOnly" :draft-scope="`${parameterDraftScope(group.key, binding)}.schema`" :drafts="drafts" @update:model-value="binding.schema = $event || { kind: 'scalar', type: 'string' }" @update:control-draft="forwardControlDraft" @clear:control-drafts="clearControlDrafts" @move:control-drafts="forwardMoveControlDrafts" />
          </template>
          <template v-else>
            <span>{{ parameterComponentName(group.location, binding.componentId) }}</span>
            <input v-model="binding.value" :placeholder="t('design.parameter.value')" />
          </template>
          <label class="enabled-field"><input :checked="binding.enabled !== false" type="checkbox" :data-testid="`design-parameter-enabled-${group.key}-${index}`" :aria-label="t('design.enabled')" @change="setParameterEnabled(binding, $event)" />{{ t('design.enabled') }}</label>
          <button type="button" :disabled="readOnly" :aria-label="t('design.parameter.remove')" @click="removeParameter(group.key, binding)">×</button>
        </div>
      </section>

      <section class="auth">
        <h3>{{ t('editor.auth') }}</h3>
        <label>{{ t('design.authKind') }}<select :value="request.auth.kind" data-testid="design-auth-kind" @change="setAuthKind(($event.target as HTMLSelectElement).value)"><option value="none">none</option><option value="bearer">bearer</option><option value="basic">basic</option><option value="apikey">apikey</option><option value="componentRef">componentRef</option></select></label>
        <template v-if="request.auth.kind === 'bearer'"><label>{{ t('design.secretReference') }}<input v-model="request.auth.token.id" data-testid="design-auth-secret-ref" /></label><label>{{ t('design.secretPolicy') }}<input v-model="request.auth.token.policy" /></label></template>
        <template v-else-if="request.auth.kind === 'basic'"><label>{{ t('design.username') }}<input v-model="request.auth.username" /></label><label>{{ t('design.secretReference') }}<input v-model="request.auth.password.id" data-testid="design-auth-secret-ref" /></label><label>{{ t('design.secretPolicy') }}<input v-model="request.auth.password.policy" /></label></template>
        <template v-else-if="request.auth.kind === 'apikey'"><label>{{ t('design.apiKeyName') }}<input v-model="request.auth.name" /></label><label>{{ t('design.apiKeyPlacement') }}<select v-model="request.auth.placement"><option value="header">header</option><option value="query">query</option></select></label><label>{{ t('design.secretReference') }}<input v-model="request.auth.value.id" data-testid="design-auth-secret-ref" /></label><label>{{ t('design.secretPolicy') }}<input v-model="request.auth.value.policy" /></label></template>
        <template v-else-if="request.auth.kind === 'componentRef'"><label>{{ t('design.authComponent') }}<select v-model="request.auth.componentId"><option v-for="component in authComponents()" :key="component.id" :value="component.id">{{ component.name }}</option></select></label><span>{{ t('design.structuralOnly') }}</span></template>
      </section>

      <section v-if="request.protocol === 'http'" class="body">
        <h3>{{ t('editor.body') }}</h3>
        <label>{{ t('editor.bodyKind') }}<select :value="request.body.kind" data-testid="design-body-kind" @change="setBodyKind(($event.target as HTMLSelectElement).value)"><option v-for="kind in bodyKinds" :key="kind" :value="kind">{{ t(`contract.body.${kind}`) }}</option></select></label>
        <template v-if="request.body.kind === 'json' || request.body.kind === 'xml' || request.body.kind === 'text'">
          <label>{{ t('design.bodyContent') }}<textarea v-model="request.body.content" data-testid="design-body-content" /></label>
          <SchemaEditor :model-value="request.body.schema" :models="assets.models" :read-only="readOnly" :draft-scope="`${draftScope}.request.body.schema`" :drafts="drafts" @update:model-value="setBodySchema" @update:control-draft="forwardControlDraft" @clear:control-drafts="clearControlDrafts" @move:control-drafts="forwardMoveControlDrafts" />
        </template>
        <template v-else-if="request.body.kind === 'graphql'"><label>{{ t('design.graphqlQuery') }}<textarea v-model="request.body.query" /></label><label>{{ t('design.graphqlVariables') }}<textarea v-model="request.body.variables" /></label><label>{{ t('design.graphqlOperationName') }}<input v-model="request.body.operationName" data-testid="design-graphql-operation-name" /></label></template>
        <template v-else-if="request.body.kind === 'binary'"><label>{{ t('design.filePath') }}<input v-model="request.body.file.path" /></label><label>{{ t('design.contentType') }}<input v-model="request.body.contentType" /></label></template>
        <template v-else-if="request.body.kind === 'urlencoded'"><div v-for="(field, index) in request.body.fields" :key="field.id" class="parameter-row"><input v-model="field.name" :data-testid="`design-body-urlencoded-name-${index}`" :placeholder="t('design.parameter.name')" /><input v-model="field.value" :data-testid="`design-body-urlencoded-value-${index}`" :placeholder="t('design.parameter.value')" /><label class="enabled-field"><input v-model="field.enabled" type="checkbox" :data-testid="`design-body-urlencoded-enabled-${index}`" :aria-label="t('design.enabled')" />{{ t('design.enabled') }}</label><button type="button" @click="removeBodyEntry(index)">×</button></div><button type="button" data-testid="design-body-add-entry" @click="addBodyEntry(request.body)">{{ t('editor.addRow') }}</button></template>
        <template v-else-if="request.body.kind === 'multipart'"><div v-for="(entry, index) in request.body.entries" :key="entry.id" class="parameter-row"><select :value="entry.kind" :data-testid="`design-body-entry-kind-${index}`" :aria-label="t('editor.bodyKind')" @change="setMultipartEntryKind(index, ($event.target as HTMLSelectElement).value)"><option value="text">text</option><option value="file">file</option></select><input v-model="entry.name" :data-testid="`design-body-entry-name-${index}`" :placeholder="t('design.parameter.name')" /><template v-if="entry.kind === 'text'"><input v-model="entry.value" :data-testid="`design-body-entry-value-${index}`" :placeholder="t('design.parameter.value')" /></template><template v-else><input v-model="entry.file.path" :data-testid="`design-body-entry-path-${index}`" :placeholder="t('design.filePath')" /><input v-model="entry.filename" :data-testid="`design-body-entry-filename-${index}`" :placeholder="t('debugLoop.filename')" /><input v-model="entry.contentType" :data-testid="`design-body-entry-content-type-${index}`" :placeholder="t('design.contentType')" /></template><label class="enabled-field"><input v-model="entry.enabled" type="checkbox" :data-testid="`design-body-entry-enabled-${index}`" :aria-label="t('design.enabled')" />{{ t('design.enabled') }}</label><button type="button" @click="removeBodyEntry(index)">×</button></div><button type="button" data-testid="design-body-add-entry" @click="addBodyEntry(request.body)">{{ t('editor.addRow') }}</button></template>
      </section>
      <section v-else-if="request.protocol === 'websocket'" class="body"><h3>{{ t('protocol.message') }}</h3><textarea v-model="request.message" data-testid="design-websocket-message" /></section>
      <section v-else class="body"><h3>{{ t('protocol.envelope') }}</h3><textarea v-model="request.envelope" data-testid="design-soap-envelope" /><label>{{ t('protocol.soapAction') }}<input v-model="request.soapAction" /></label></section>
    </fieldset>

    <ResponseEditor
      :responses="asset.contract.responses"
      :assets="assets"
      :context-key="draftScope"
      :draft-scope="`${draftScope}.responses`"
      :drafts="drafts"
      :read-only="readOnly"
      @update:control-draft="forwardControlDraft"
      @clear:control-drafts="clearControlDrafts"
      @move:control-drafts="forwardMoveControlDrafts"
    />
  </section>
</template>

<style scoped>
.contract-designer { display: grid; gap: 10px; min-width: 0; padding-bottom: 12px; }
fieldset { min-width: 0; border: 1px solid var(--border, #d9d9d9); border-radius: 4px; padding: 10px; display: grid; gap: 10px; }
legend { font-weight: 600; }
label { display: grid; gap: 4px; min-width: 0; }
input, select, textarea { min-width: 0; max-width: 100%; box-sizing: border-box; }
textarea { min-height: 54px; font-family: ui-monospace, monospace; }
.request-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; }
.parameter-group, .auth, .body { display: grid; gap: 8px; border-top: 1px solid var(--border, #d9d9d9); padding-top: 8px; }
.parameter-group header, .parameter-row { display: flex; align-items: center; gap: 6px; }
.parameter-group header strong { flex: 1; }
.parameter-row > input { flex: 1; }
.enabled-field { display: flex; align-items: center; white-space: nowrap; }
h3 { margin: 0; font-size: 13px; }
</style>

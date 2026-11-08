<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { AiStore } from "../../stores/ai.js";
import { AiPublicConnectionSchema } from "../../../../shared/ai/contract.js";
import { AiProtocolSchema } from "@apicc/core/schema";
import { createAiConnectionFromTemplate } from "@apicc/core/ai/catalog";
const props = defineProps<{ ai: AiStore }>();
const { t } = useI18n();
const selected = ref("");
const draft = ref(AiPublicConnectionSchema.parse({ id: crypto.randomUUID(), revision: 1, name: "new", owner: { kind: "personal" }, baseUrl: "https://example.test", auth: { kind: "bearer" }, protocols: ["openai-chat-completions"], headers: {} }));
const key = ref("");
const mode = ref<"persistent" | "session-only">("persistent");
const templateId = ref("");
const confirmConflicts = ref(false);
const headerRows = ref<{ name: string; value: string }[]>([]);
const changedAudience = ref(false);
const audienceDirty = computed(() => { const old = props.ai.settings?.connections.find(c => c.id === selected.value); return old && (draft.value.baseUrl !== old.baseUrl || JSON.stringify(draft.value.auth) !== JSON.stringify(old.auth)); });
watch(audienceDirty, dirty => { props.ai.pendingConnectionAudienceId = dirty ? selected.value : null; }, { immediate: true });
onBeforeUnmount(() => { props.ai.pendingConnectionAudienceId = null; });
const updateTemplate = computed(() => props.ai.catalog?.catalog.find(template => template.id === draft.value.templateSource?.id && template.revision !== draft.value.templateSource.revision));
function select(id: string) {
  selected.value = id; key.value = "";
  const connection = props.ai.settings?.connections.find(c => c.id === id);
  if (connection) { const { credentialState: _state, ...safe } = connection; draft.value = JSON.parse(JSON.stringify(safe)); headerRows.value = Object.entries(connection.headers).map(([name, value]) => ({ name, value })); }
}
function newConnection() {
  selected.value = ""; key.value = ""; changedAudience.value = false; headerRows.value = [];
  draft.value = { id: crypto.randomUUID(), revision: 1, name: "", owner: { kind: "personal" }, baseUrl: "", auth: { kind: "bearer" }, protocols: ["openai-chat-completions"], headers: {} };
}
function fromTemplate() {
  const template = props.ai.catalog?.catalog.find(value => value.id === templateId.value);
  if (!template) return;
  newConnection();
  const { credentialRef: _ref, ...connection } = createAiConnectionFromTemplate(template, { id: draft.value.id, name: template.name });
  draft.value = connection; headerRows.value = Object.entries(connection.headers).map(([name, value]) => ({ name, value }));
}
function auth(event: Event) {
  const kind = (event.target as HTMLSelectElement).value;
  draft.value.auth = kind === "api-key" ? { kind, header: "x-api-key" } : kind === "none" ? { kind } : { kind: "bearer" };
}
function adoptTemplate() {
  const template = updateTemplate.value; if (!template) return;
  const { credentialRef: _ref, ...connection } = createAiConnectionFromTemplate(template, { id: draft.value.id, name: draft.value.name });
  draft.value = { ...connection, revision: draft.value.revision, ...(draft.value.networkProfileId ? { networkProfileId: draft.value.networkProfileId } : {}) };
  headerRows.value = Object.entries(connection.headers).map(([name, value]) => ({ name, value }));
}
async function importFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return;
  confirmConflicts.value = false;
  const generation = props.ai.beginCatalogImport();
  try {
    const text = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(file); });
    if (generation !== props.ai.catalogImportGeneration) return;
    await props.ai.previewCatalog({ file: file.name, document: JSON.parse(text) }, generation);
  } catch (error) {
    if (generation === props.ai.catalogImportGeneration) { props.ai.settingsFailure(error); if (props.ai.settingsIssue) props.ai.settingsIssue.file = file.name; }
  }
}
watch(() => props.ai.settings, () => { if (!selected.value && props.ai.settings?.connections[0]) select(props.ai.settings.connections[0].id); }, { immediate: true });
async function save() {
  if (!props.ai.settings) return;
  const id = draft.value.id;
  const rebind = audienceDirty.value;
  if (await props.ai.writeSettings({ operation: "connection", expectedRevision: props.ai.settings.revision, connection: { ...draft.value, headers: Object.fromEntries(headerRows.value.map(row => [row.name, row.value])) } })) {
    changedAudience.value = Boolean(rebind); select(id);
  }
}
async function bind() {
  if (!props.ai.settings || audienceDirty.value) { props.ai.settingsIssue = { code: "credential-audience-mismatch" }; return; }
  if (await props.ai.writeSettings({ operation: "credential", expectedRevision: props.ai.settings.revision, connectionId: draft.value.id, value: key.value, mode: mode.value })) key.value = "";
}
</script>
<template>
  <section aria-labelledby="ai-connections-title">
    <h3 id="ai-connections-title" tabindex="-1">{{ t('aiSettings.connections') }}</h3>
    <h4>{{ t('aiSettings.templates') }}</h4>
    <label>{{ t('aiSettings.templates') }}<select v-model="templateId" data-testid="connection-template"><option value="">{{ t('aiSettings.manual') }}</option><option v-for="template in ai.catalog?.catalog" :key="template.id" :value="template.id">{{ template.name }}</option></select></label>
    <button data-testid="catalog-reload" @click="ai.reloadCatalog()">{{ t('aiSettings.reloadCatalog') }}</button>
    <button data-testid="connection-from-template" @click="fromTemplate">{{ t('aiSettings.fromTemplate') }}</button>
    <label>{{ t('aiSettings.importFile') }}<input type="file" accept=".json,application/json" data-testid="catalog-import-file" @change="importFile"></label>
    <div v-if="ai.catalogPreview || ai.catalog">
      <h4>{{ t('aiSettings.catalogDiff') }}</h4>
      <div class="ai-catalog-diff"><dl v-for="kind in ['added', 'updated', 'removed'] as const" :key="kind"><dt>{{ t(`aiSettings.${kind}`) }}</dt><dd><span v-if="!(ai.catalogPreview ?? ai.catalog)?.diff[kind].length">{{ t('aiSettings.noDiff') }}</span><ul v-else><li v-for="id in (ai.catalogPreview ?? ai.catalog)?.diff[kind]" :key="id">{{ id }}</li></ul></dd></dl></div>
      <ul v-if="(ai.catalogPreview ?? ai.catalog)?.errors.length"><li v-for="(error, index) in (ai.catalogPreview ?? ai.catalog)?.errors" :key="index">{{ error.file }} · {{ error.field }} · {{ t('aiSettings.errorCodes.invalid-catalog') }}</li></ul>
      <template v-if="ai.catalogImportInput"><label>{{ t('aiSettings.confirmConflicts') }}<input v-model="confirmConflicts" type="checkbox" data-testid="catalog-confirm-conflicts"></label><button data-testid="catalog-import-apply" @click="ai.applyCatalog(confirmConflicts)">{{ t('aiSettings.applyImport') }}</button></template>
    </div>
    <div class="ai-scroll"><table><thead><tr><th>{{ t('aiSettings.name') }}</th><th>{{ t('ai.baseUrl') }}</th><th>{{ t('ai.apiKey') }}</th><th>{{ t('aiSettings.action') }}</th></tr></thead>
      <tbody><tr v-for="connection in ai.settings?.connections" :key="connection.id"><td class="ai-long">{{ connection.name }}</td><td class="ai-long" :title="connection.baseUrl">{{ connection.baseUrl }}</td><td>{{ t(`aiSettings.credential.${connection.credentialState}`) }}</td><td><button :data-testid="`connection-edit-${connection.id}`" @click="select(connection.id)">{{ t('aiSettings.edit') }}</button></td></tr></tbody>
    </table></div>
    <button data-testid="connection-new" @click="newConnection">{{ t('aiSettings.newConnection') }}</button>
    <div class="ai-grid">
      <label>{{ t('aiSettings.stableId') }}<input :value="draft.id" readonly></label>
      <label>{{ t('aiSettings.name') }}<input v-model="draft.name" data-testid="connection-name"></label>
      <label>{{ t('ai.baseUrl') }}<input v-model="draft.baseUrl" data-testid="connection-url"></label>
      <label>{{ t('aiSettings.auth') }}<select :value="draft.auth.kind" data-testid="connection-auth" @change="auth"><option value="bearer">Bearer</option><option value="api-key">API Key</option><option value="none">{{ t('aiSettings.noAuthentication') }}</option></select></label>
      <label v-if="draft.auth.kind === 'api-key'">{{ t('aiSettings.authHeader') }}<input v-model="draft.auth.header" data-testid="connection-auth-header"></label>
      <label v-for="protocol in AiProtocolSchema.options" :key="protocol">{{ protocol }}<input v-model="draft.protocols" type="checkbox" :value="protocol" :data-testid="`connection-protocol-${protocol}`"></label>
      <label>{{ t('aiSettings.insecureLocal') }}<input v-model="draft.insecureLocalTest" type="checkbox" data-testid="connection-insecure-local"></label>
    </div>
    <h4>{{ t('aiSettings.headers') }}</h4>
    <div v-for="(row, index) in headerRows" :key="index" class="ai-grid"><label>{{ t('aiSettings.name') }}<input v-model="row.name" :data-testid="`connection-header-name-${index}`"></label><label>{{ t('aiSettings.headerValue') }}<input v-model="row.value" :data-testid="`connection-header-value-${index}`"></label><button @click="headerRows.splice(index, 1)">{{ t('aiSettings.remove') }}</button></div>
    <button data-testid="connection-header-add" @click="headerRows.push({ name: '', value: '' })">{{ t('aiSettings.addHeader') }}</button>
    <p v-if="changedAudience || audienceDirty" role="alert">{{ t('aiSettings.rebind') }}</p>
    <button v-if="updateTemplate" data-testid="connection-template-update" @click="adoptTemplate">{{ t('aiSettings.templateUpdate') }}</button>
    <button data-testid="connection-save" :disabled="ai.savingConfig" @click="save">{{ t('aiSettings.saveConnection') }}</button>
    <label>{{ t('ai.apiKey') }}<input v-model="key" type="password" autocomplete="new-password" data-testid="connection-key" :placeholder="t('ai.keySavedPlaceholder')"></label>
    <label>{{ t('aiSettings.credentialMode') }}<select v-model="mode" data-testid="credential-mode"><option value="persistent" :disabled="ai.settings?.backend === 'unavailable'">{{ t('aiSettings.persistent') }}</option><option value="session-only">{{ t('aiSettings.sessionOnly') }}</option></select></label>
    <p v-if="ai.settings?.backend === 'unavailable'" role="alert">{{ t('aiSettings.secureUnavailable') }}</p>
    <button data-testid="credential-save" :disabled="ai.savingConfig || Boolean(audienceDirty)" @click="bind">{{ t('aiSettings.bindCredential') }}</button>
  </section>
</template>

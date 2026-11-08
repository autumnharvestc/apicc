<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AiModelCapabilitiesSchema, AiModelProfileSchema, AiProtocolSchema } from "@apicc/core/schema";
import { createInitialAiModelBudgets } from "@apicc/core/ai/config";
import type { AiModelProfile } from "@apicc/core";
import type { AiStore } from "../../stores/ai.js";
const props = defineProps<{ ai: AiStore }>();
const { t } = useI18n();
const selected = ref("");
const draft = ref<AiModelProfile>(blank());
const initializeReasoning = ref(false);
const numericCaps = ["contextWindowTokens", "maxInputTokens", "maxOutputTokens"] as const;
function blank(): AiModelProfile { return { id: crypto.randomUUID(), revision: 1, connectionId: props.ai.settings?.connections[0]?.id ?? "", modelId: "", protocol: "openai-chat-completions", structuredOutput: "json-schema", streaming: true, supportedParameters: [], capabilities: { status: "unconfirmed", source: "manual" }, budgets: {}, purposeBudgets: {} }; }
function edit(id: string) { selected.value = id; initializeReasoning.value = false; draft.value = id ? JSON.parse(JSON.stringify(props.ai.settings?.models.find(m => m.id === id))) : blank(); }
watch(() => props.ai.settings, () => { if (!selected.value && props.ai.settings?.models[0]) edit(props.ai.settings.models[0].id); }, { immediate: true });
const connection = computed(() => props.ai.settings?.connections.find(c => c.id === draft.value.connectionId));
const modelDirty = computed(() => JSON.stringify(draft.value) !== JSON.stringify(props.ai.settings?.models.find(model => model.id === selected.value)));
const audienceDirty = computed(() => props.ai.pendingConnectionAudienceId === draft.value.connectionId);
watch([selected, modelDirty, audienceDirty], () => { void props.ai.cancelAuxiliary(); props.ai.testResult = null; props.ai.discovery = null; });
const route = (protocol: AiModelProfile['protocol']) => protocol === "openai-chat-completions" ? "chat/completions" : protocol === "openai-responses" ? "responses" : "messages";
function cap(event: Event, key: typeof numericCaps[number]) { const raw = (event.target as HTMLInputElement).value; if (raw === "") delete draft.value.capabilities[key]; else draft.value.capabilities[key] = Number(raw); }
async function save() {
  if (!props.ai.settings) return;
  const id = draft.value.id;
  const model = JSON.parse(JSON.stringify(draft.value)) as AiModelProfile;
  const current = props.ai.settings.models.find(value => value.id === id);
  if (current) { model.budgets = JSON.parse(JSON.stringify(current.budgets)); model.purposeBudgets = JSON.parse(JSON.stringify(current.purposeBudgets)); }
  if (!selected.value && initializeReasoning.value) model.budgets = createInitialAiModelBudgets({ ...model.capabilities, outputIncludesReasoning: true });
  const models = props.ai.settings.models.some(m => m.id === id) ? props.ai.settings.models.map(m => m.id === id ? model : m) : [...props.ai.settings.models, model];
  if (await props.ai.writeSettings({ operation: "preferences", expectedRevision: props.ai.settings.revision, models })) edit(id);
}
</script>
<template>
  <section aria-labelledby="ai-models-title"><h3 id="ai-models-title" tabindex="-1">{{ t('aiSettings.models') }}</h3>
    <div class="ai-scroll"><table><thead><tr><th>{{ t('ai.model') }}</th><th>{{ t('aiSettings.capabilities') }}</th><th>{{ t('aiSettings.finalUrl') }}</th><th>{{ t('aiSettings.action') }}</th></tr></thead>
      <tbody><tr v-for="model in ai.settings?.models" :key="model.id"><td class="ai-long">{{ model.modelId }}</td><td><p>{{ t(`aiSettings.confirmation.${model.capabilities.status}`) }}</p><p>{{ t('aiSettings.fields.contextWindowTokens') }}: {{ model.capabilities.contextWindowTokens ?? t('aiSettings.unknown') }} Token</p><p>{{ t('aiSettings.capabilityLabels.maxInputTokens') }}: {{ model.capabilities.maxInputTokens ?? t('aiSettings.unknown') }} Token</p><p>{{ t('aiSettings.capabilityLabels.maxOutputTokens') }}: {{ model.capabilities.maxOutputTokens ?? t('aiSettings.unknown') }} Token</p></td><td class="ai-long">{{ ai.settings?.connections.find(c => c.id === model.connectionId)?.baseUrl }}/{{ route(model.protocol) }}</td><td><button :data-testid="`model-edit-${model.id}`" @click="edit(model.id)">{{ t('aiSettings.edit') }}</button></td></tr></tbody>
    </table></div>
    <button data-testid="model-new" @click="edit('')">{{ t('aiSettings.newModel') }}</button>
    <div class="ai-grid">
      <label>{{ t('aiSettings.stableId') }}<input :value="draft.id" readonly></label>
      <label>{{ t('aiSettings.modelId') }}<input v-model="draft.modelId" data-testid="model-id"></label>
      <label>{{ t('aiSettings.connection') }}<select v-model="draft.connectionId" data-testid="model-connection"><option v-for="c in ai.settings?.connections" :key="c.id" :value="c.id">{{ c.name }}</option></select></label>
      <label>{{ t('aiSettings.protocol') }}<select v-model="draft.protocol" data-testid="model-protocol"><option v-for="protocol in AiProtocolSchema.options" :key="protocol" :value="protocol">{{ protocol }}</option></select></label>
      <label>{{ t('aiSettings.structuredOutput') }}<select v-model="draft.structuredOutput"><option v-for="format in AiModelProfileSchema.shape.structuredOutput.options" :key="format" :value="format">{{ format }}</option></select></label>
      <label>{{ t('aiSettings.streaming') }}<input v-model="draft.streaming" type="checkbox"></label>
      <label>{{ t('aiSettings.tokenParameter') }}<select v-model="draft.chatCompletionTokenParameter"><option :value="undefined">{{ t('aiSettings.inherit') }}</option><option value="max_completion_tokens">max_completion_tokens</option><option value="max_tokens">max_tokens</option></select></label>
      <label v-for="parameter in ['temperature', 'reasoning'] as const" :key="parameter">{{ t(`aiSettings.${parameter}`) }}<input v-model="draft.supportedParameters" type="checkbox" :value="parameter"></label>
      <label>{{ t('aiSettings.capabilities') }}<select v-model="draft.capabilities.status" data-testid="capability-status"><option value="unconfirmed">{{ t('aiSettings.confirmation.unconfirmed') }}</option><option value="confirmed">{{ t('aiSettings.confirmation.confirmed') }}</option></select></label>
      <label>{{ t('aiSettings.capabilitySource') }}<input v-model="draft.capabilities.source" data-testid="capability-source"></label>
      <label v-for="key in numericCaps" :key="key">{{ t(key === 'contextWindowTokens' ? `aiSettings.fields.${key}` : `aiSettings.capabilityLabels.${key}`) }} (Token)<input :value="draft.capabilities[key]" type="number" :min="AiModelCapabilitiesSchema.shape[key].unwrap().minValue ?? undefined" :max="AiModelCapabilitiesSchema.shape[key].unwrap().maxValue ?? undefined" :data-testid="`capability-${key}`" @input="cap($event, key)"></label>
      <label v-for="key in ['sharedContextWindow', 'outputIncludesReasoning'] as const" :key="key">{{ t(`aiSettings.fields.${key}`) }}<select v-model="draft.capabilities[key]" :data-testid="`capability-${key}`"><option :value="undefined">{{ t('aiSettings.unknown') }}</option><option :value="true">{{ t('aiSettings.yes') }}</option><option :value="false">{{ t('aiSettings.no') }}</option></select></label>
    </div>
    <label v-if="!selected">{{ t('aiSettings.createReasoning') }}<input v-model="initializeReasoning" type="checkbox" data-testid="model-init-reasoning"></label>
    <p class="ai-long" data-testid="model-final-url">{{ t('aiSettings.finalUrl') }}: {{ connection?.baseUrl }}/{{ route(draft.protocol) }}</p>
    <p class="ai-long">{{ t('aiSettings.discoverUrl') }}: {{ connection?.baseUrl }}/models</p>
    <button data-testid="model-save" :disabled="ai.savingConfig" @click="save">{{ t('aiSettings.saveModel') }}</button>
    <p class="ai-hint">{{ t('aiSettings.networkWarning') }}</p>
    <button data-testid="model-probe" :disabled="ai.testing || !selected || modelDirty || audienceDirty" @click="ai.testConnection(selected)">{{ t('aiSettings.probe') }}</button>
    <button data-testid="model-discover" :disabled="ai.testing || !draft.connectionId || modelDirty || audienceDirty" @click="ai.runAuxiliary('discover', draft.connectionId)">{{ t('aiSettings.discover') }}</button>
  </section>
</template>

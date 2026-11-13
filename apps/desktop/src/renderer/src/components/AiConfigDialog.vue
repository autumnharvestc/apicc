<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Modal as AModal, Button as AButton } from "ant-design-vue";
import type { AiStore } from "../stores/ai.js";
import AiConnections from "./ai/AiConnections.vue";
import AiModels from "./ai/AiModels.vue";
import AiBudgets from "./ai/AiBudgets.vue";
import '../styles/ai-presentation.css';
const props = defineProps<{ ai: AiStore; forSuggestion?: boolean }>();
const { t, te } = useI18n();
const formEpoch = ref(0);
const settingsBody = ref<HTMLElement | null>(null);
function jumpTo(section: 'connections' | 'models' | 'budgets') {
  const heading = settingsBody.value?.querySelector<HTMLElement>(`#ai-${section}-title`);
  heading?.scrollIntoView?.({ block: 'start' });
  heading?.focus({ preventScroll: true });
}
async function reload() { await props.ai.init(); formEpoch.value++; }
const issue = computed(() => {
  const value = props.ai.settingsIssue;
  if (!value) return props.ai.error;
  const reason = te(`aiSettings.errorCodes.${value.code}`) ? t(`aiSettings.errorCodes.${value.code}`) : `${t('aiSettings.invalid')} (${value.code})`;
  const field = value.field === "baseUrl" ? t('ai.baseUrl') : !value.field ? "" : te(`aiSettings.fields.${value.field}`) ? t(`aiSettings.fields.${value.field}`) : te(`aiSettings.${value.field}`) ? t(`aiSettings.${value.field}`) : value.field;
  const unit = value.field?.endsWith('Tokens') ? 'Token' : value.field?.endsWith('Bytes') ? t('aiSettings.units.bytes') : value.field?.endsWith('Ms') ? t('aiSettings.units.ms') : '';
  const allowed = value.allowed === undefined ? '' : typeof value.allowed === 'number' || /^[\d≤≥–. -]+$/.test(value.allowed) ? `${value.allowed} ${unit}` : '';
  return [reason, field, value.file, value.source ? `${t('aiSettings.source')}: ${t(`aiSettings.sourceLabels.${value.source}`)}` : "", allowed].filter(Boolean).join(' · ');
});
watch(() => props.ai.configDialogOpen, (open) => {
  if (open) { props.ai.savedNotice = false; props.ai.testResult = null; if (!props.ai.settings) void props.ai.init(); }
  else void props.ai.cancelAuxiliary();
}, { immediate: true });
watch(() => [props.ai.configDialogOpen, props.forSuggestion, !!props.ai.settings] as const, ([open, suggestion, ready]) => {
  if (open && suggestion && ready) jumpTo(props.ai.settings?.models.length ? "budgets" : "models");
}, { flush: "post" });
</script>
<template>
  <a-modal v-if="ai.configDialogOpen" :open="true" :title="t('aiSettings.title')" :width="1000" centered @cancel="ai.configDialogOpen = false">
    <div ref="settingsBody" class="ai-settings" data-testid="ai-config-body">
      <div class="ai-intro"><strong>{{ t('aiSettings.owner') }}</strong><p>{{ t('aiSettings.offline') }}</p></div>
      <p v-if="forSuggestion" role="status" data-testid="ai-settings-for-suggestion">{{ t("requestAi.configureModel") }}</p>
      <nav v-if="ai.settings" class="ai-section-nav" :aria-label="t('aiUi.settingsSections')">
        <button v-for="section in ['connections', 'models', 'budgets'] as const" :key="section" :data-testid="`ai-jump-${section}`" :aria-controls="`ai-${section}-title`" @click="jumpTo(section)">{{ t(`aiSettings.${section}`) }}</button>
      </nav>
      <button data-testid="ai-settings-reload" :disabled="ai.configLoading" @click="reload">{{ t('aiSettings.reload') }}</button>
      <button v-if="ai.settings?.legacyAvailable" data-testid="ai-legacy-migrate" :disabled="ai.savingConfig" @click="ai.writeSettings({ operation: 'migrate-legacy' })">{{ t('aiSettings.migrate') }}</button>
      <p v-if="ai.migrationStatus" role="status">{{ te(`aiSettings.migration.${ai.migrationStatus}`) ? t(`aiSettings.migration.${ai.migrationStatus}`) : ai.migrationStatus }}</p>
      <p v-if="ai.configLoading" role="status">{{ t('aiSettings.loading') }}</p>
      <p v-if="issue" role="alert" data-testid="ai-save-error">{{ issue }}</p>
      <p v-if="ai.savedNotice" role="status" data-testid="ai-saved">{{ t('ai.saved') }}</p>
      <p v-if="ai.testResult === 'success'" role="status" data-testid="ai-test-ok">{{ t('ai.testOk') }}</p>
      <p v-if="ai.testing" role="status">{{ t('ai.testing') }}</p>
      <button v-if="ai.activeOperationId" data-testid="ai-operation-cancel" @click="ai.cancelAuxiliary()">{{ t('aiSettings.cancel') }}</button>
      <p v-if="ai.discovery?.status === 'unsupported'">{{ t('aiSettings.discoveryUnsupported') }}</p>
      <div v-if="ai.discovery?.status === 'available'"><h4>{{ t('aiSettings.discovered') }}</h4><ul><li v-for="model in ai.discovery.models" :key="model.id">{{ model.id }}</li></ul></div>
      <div v-if="ai.settings" :key="formEpoch" class="ai-config-sections"><AiConnections :ai="ai" /><AiModels :ai="ai" /><AiBudgets :ai="ai" :case-binding="forSuggestion && !!ai.settings.models.length" /></div>
    </div>
    <template #footer><a-button data-testid="ai-config-close" @click="ai.configDialogOpen = false">{{ t('common.close') }}</a-button></template>
  </a-modal>
</template>

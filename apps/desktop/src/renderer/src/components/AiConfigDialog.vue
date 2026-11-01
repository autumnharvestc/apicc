<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Modal as AModal, Button as AButton } from "ant-design-vue";
import type { AiStore } from "../stores/ai.js";
import AiConnections from "./ai/AiConnections.vue";
import AiModels from "./ai/AiModels.vue";
import AiBudgets from "./ai/AiBudgets.vue";
const props = defineProps<{ ai: AiStore }>();
const { t, te } = useI18n();
const formEpoch = ref(0);
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
</script>
<template>
  <a-modal v-if="ai.configDialogOpen" :open="true" :title="t('aiSettings.title')" :width="1000" @cancel="ai.configDialogOpen = false">
    <div class="ai-settings" data-testid="ai-config-body">
      <p>{{ t('aiSettings.owner') }}</p><p>{{ t('aiSettings.offline') }}</p>
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
      <div v-if="ai.settings" :key="formEpoch"><AiConnections :ai="ai" /><AiModels :ai="ai" /><AiBudgets :ai="ai" /></div>
    </div>
    <template #footer><a-button data-testid="ai-config-close" @click="ai.configDialogOpen = false">{{ t('common.close') }}</a-button></template>
  </a-modal>
</template>
<style>
.ai-settings { max-height: 72vh; overflow: auto; overflow-wrap: anywhere; }
.ai-settings section { border-top: 1px solid var(--border); padding: 12px 0; }
.ai-settings h3, .ai-settings h4 { margin: 8px 0; }
.ai-settings .ai-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 10px 16px; }
.ai-settings label { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.ai-settings input, .ai-settings select, .ai-settings textarea { width: 100%; min-width: 0; box-sizing: border-box; padding: 5px; border: 1px solid var(--border); border-radius: 4px; color: var(--text); background: var(--panel); }
.ai-settings input[type=checkbox] { width: auto; align-self: start; }
.ai-settings button { margin: 6px 8px 6px 0; padding: 5px 10px; cursor: pointer; }
.ai-settings table { border-collapse: collapse; min-width: 600px; width: 100%; }
.ai-settings th { white-space: nowrap; text-align: start; }
.ai-settings th, .ai-settings td { padding: 6px 10px; border-bottom: 1px solid var(--border); }
.ai-settings .ai-scroll { max-width: 100%; overflow: auto; }
.ai-settings .ai-long { max-width: 360px; overflow-wrap: anywhere; }
.ai-settings [role=alert] { color: #cf1322; }
.ai-settings .ai-hint { color: var(--text-secondary); font-size: 12px; }
</style>

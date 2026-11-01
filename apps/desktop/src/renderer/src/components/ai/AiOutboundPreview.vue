<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { AiContextPreviewDto } from '../../../../shared/ai/contract.js';
import AiSourceSummary from './AiSourceSummary.vue';
import type { AiDisplayConnection } from '../../stores/ai.js';
defineProps<{ preview: AiContextPreviewDto; connection?: AiDisplayConnection | null }>();
defineEmits<{ confirm: [] }>();
const { t } = useI18n();
const itemKeys: Record<string, string> = {
  contract: 'contract', scripts: 'scripts', 'dataset-rows': 'datasetRows', 'secrets-attachments-absolute-paths': 'restricted',
  'contract:request-body': 'requestBody', 'related-models-and-components': 'relatedAssets', 'existing-case-names': 'caseNames',
};
const itemLabel = (item: string) => itemKeys[item] ? `${t(`ai.outboundItems.${itemKeys[item]}`)} (${item})` : item;
const reasonKeys: Record<string, string> = { 'default-omitted': 'defaultOmitted', 'not-authorized': 'notAuthorized',
  'not-selected': 'notSelected', truncated: 'truncated', 'not-collected': 'notCollected', 'legacy-not-collected': 'notCollected', 'candidate-count-budget': 'candidateBudget' };
const reasonLabel = (reason: string) => reasonKeys[reason] ? t(`ai.outboundReasons.${reasonKeys[reason]}`) : reason;
const budgetFields = ['maxRequests', 'transportRetries', 'repairAttempts', 'maxOutputTokens', 'totalOutputTokens', 'deadlineMs', 'requestTimeoutMs', 'maxInputTokens',
  'maxInputBytes', 'maxInstructionBytes', 'maxOutputBytes', 'candidateCount', 'evidenceCount', 'maxEventBytes', 'maxStreamBytes'] as const;
const itemUnits: Record<string, string> = { candidateCount: 'items', evidenceCount: 'items' };
const unit = (field: string) => t(`aiSettings.units.${itemUnits[field] ?? (field.endsWith('Ms') ? 'ms' : field.endsWith('Bytes') ? 'bytes' : field.endsWith('Tokens') ? 'tokens' : 'count')}`);
</script>

<template>
  <section data-testid="ai-outbound-preview" class="outbound-preview">
    <p>{{ t('ai.previewPrepared') }}</p>
    <dl>
      <dt>{{ t('ai.baseUrl') }}</dt><dd>{{ preview.destination.baseUrl }}</dd>
      <dt>{{ t('ai.connectionIdentity') }}</dt><dd>{{ connection ? `${connection.name} (${connection.id}, ${t('ai.revision')} ${connection.revision})` : t('ai.notCollected') }}<span v-if="connection?.providerId"> · {{ connection.providerId }}</span></dd>
      <dt>{{ t('ai.model') }}</dt><dd>{{ preview.destination.modelId }}</dd>
      <dt>{{ t('ai.project') }}</dt><dd>{{ preview.source.projectId }}</dd>
      <dt>{{ t('ai.purpose') }}</dt><dd>{{ t(`ai.purposes.${preview.purpose}`) }}</dd>
      <dt>{{ t('ai.estimatedBytes') }}</dt><dd>{{ preview.bytes }} {{ t('ai.bytes') }}</dd>
      <dt>{{ t('ai.tokens') }}</dt><dd>{{ t('ai.tokensUnconfirmed') }}</dd>
    </dl>
    <AiSourceSummary :source="preview.source" />
    <h4>{{ t('aiSettings.effective') }} · {{ t('aiSettings.budgets') }}</h4>
    <p>{{ t('aiSettings.capabilities') }}: {{ t(`aiSettings.confirmation.${preview.capabilityStatus}`) }}</p>
    <p>{{ t('aiSettings.budgetNotice') }}</p>
    <div class="budget-scroll"><table><thead><tr><th>{{ t('aiSettings.name') }}</th><th>{{ t('aiSettings.effective') }}</th><th>{{ t('aiSettings.source') }}</th></tr></thead>
      <tbody><tr v-for="key in budgetFields" :key="key"><td>{{ t(`aiSettings.fields.${key}`) }}</td><td>{{ preview.budgets[key] ?? t('aiSettings.unknown') }} {{ unit(key) }}</td>
        <td>{{ preview.budgetSources[key] ? t(`aiSettings.sourceLabels.${preview.budgetSources[key].source}`) : t('aiSettings.unknown') }}<span v-if="preview.budgetSources[key]?.limitedBy"> · {{ t('aiSettings.limited') }}</span></td></tr></tbody>
    </table></div>
    <p v-for="warning in preview.warnings" :key="warning" role="note">{{ t('aiSettings.requestCostWarning') }}</p>
    <h4>{{ t('ai.included') }}</h4>
    <ul><li v-for="item in preview.included" :key="item">{{ itemLabel(item) }}</li></ul>
    <h4>{{ t('ai.omitted') }}</h4>
    <ul><li v-for="item in preview.omitted" :key="item.item">{{ itemLabel(item.item) }} — {{ reasonLabel(item.reason) }}</li></ul>
    <h4>{{ t('ai.redaction') }}</h4>
    <p>{{ t('ai.heuristicRedaction') }}</p>
    <ul><li v-for="limitation in preview.redaction.limitations" :key="limitation">{{ limitation === '启发式脱敏不能保证发现所有用户自定义秘密。' ? t('ai.heuristicRedaction') : limitation }}</li></ul>
    <button type="button" data-testid="ai-confirm-send" @click="$emit('confirm')">{{ t('ai.confirmSend') }}</button>
  </section>
</template>

<style scoped>
dl { display: grid; grid-template-columns: minmax(90px, 1fr) minmax(0, 3fr); gap: 8px 12px; }
dt { color: var(--text-muted, #666); }
dd { margin: 0; overflow-wrap: anywhere; }
.outbound-preview { max-width: 100%; overflow: auto; }
.budget-scroll { max-width: 100%; overflow: auto; }
table { border-collapse: collapse; min-width: 400px; width: 100%; }
th, td { padding: 6px 8px; text-align: start; border-bottom: 1px solid var(--border); }
th { white-space: nowrap; }
</style>

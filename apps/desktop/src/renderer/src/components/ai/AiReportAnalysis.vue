<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { AiBusinessResultDto } from '../../../../shared/ai/contract.js';
import type { AiEvidence } from '@apicc/core';
import { aiFactRows, aiFactTitle, aiProgramFacts } from '../../ai/presentation.js';
import { computed } from 'vue';
const props = defineProps<{ result: Extract<AiBusinessResultDto, { purpose: 'report-analysis' }>; canLocate?: (id: string) => boolean }>();
const facts = computed(() => aiProgramFacts(props.result.evidence, props.result.analysis.observedFacts));
const { t } = useI18n();
defineEmits<{ locate: [id: string]; export: [] }>();
const factRows = (evidence: AiEvidence) => aiFactRows(evidence, t);
</script>
<template>
  <section class="analysis" data-testid="ai-report-analysis">
    <button type="button" data-testid="ai-export-analysis" @click="$emit('export')">{{ t('ai.exportAnalysis') }}</button>
    <div class="conclusion"><h3>{{ t('ai.conclusion') }}</h3><p>{{ result.analysis.conclusion }}</p></div>
    <h3>{{ t('ai.observedFacts') }}</h3>
    <article v-for="fact in facts" :key="fact.id">
      <h4>{{ aiFactTitle(fact, t) }}</h4>
      <p v-if="fact.state !== 'collected' || fact.value === null">{{ t('ai.notCollected') }}</p>
      <dl v-else><template v-for="(row, index) in factRows(fact)" :key="index"><dt>{{ row.label }}</dt><dd>{{ row.value }}</dd></template></dl>
      <p class="evidence-ref">{{ t('ai.evidence') }}: {{ fact.id }} · {{ fact.location }}</p>
    </article>
    <p>{{ t('ai.modelReferences') }}: {{ result.analysis.observedFacts.map(fact => fact.id).join(' · ') || t('ai.none') }}</p>
    <h3>{{ t('ai.possibleCauses') }}</h3>
    <ul><li v-for="(cause, index) in result.analysis.possibleCauses" :key="index">{{ cause.text }} <small>{{ t('ai.possibleOnly') }} · {{ cause.evidenceIds.join(' · ') }}</small></li></ul>
    <h3>{{ t('ai.checks') }}</h3><ul><li v-for="(check, index) in result.analysis.checks" :key="index">{{ check.text }} <small>{{ check.evidenceIds.join(' · ') }}</small></li></ul>
    <h3>{{ t('ai.evidence') }}</h3><ul><li v-for="evidence in result.evidence" :key="evidence.id"><button v-if="canLocate?.(evidence.id)" type="button" @click="$emit('locate', evidence.id)">{{ evidence.id }}</button><span v-else>{{ evidence.id }} · {{ t('ai.notNavigable') }}</span> · {{ evidence.location }}</li></ul>
    <div class="limitations"><h3>{{ t('ai.limitations') }}</h3><ul><li v-for="limitation in result.analysis.limitations" :key="limitation">{{ limitation }}</li></ul></div>
  </section>
</template>
<style scoped>
.analysis { overflow: auto; max-width: 100%; } p, li, dd { overflow-wrap: anywhere; white-space: pre-wrap; }
dl { display: grid; grid-template-columns: minmax(90px, 1fr) minmax(0, 3fr); gap: 6px 12px; }
dd { margin: 0; } dt, small, .evidence-ref { color: var(--text-muted, #666); }
article { border: 1px solid var(--border); padding: 12px 14px; border-radius: 8px; margin: 10px 0; }
article h4 { margin-top: 0; }
.conclusion, .limitations { border-radius: 8px; padding: 12px 14px; margin: 12px 0; background: var(--subtle); border: 1px solid var(--border); }
.conclusion { border-left: 3px solid var(--accent); background: var(--active-weak); }
.conclusion h3, .limitations h3 { margin-top: 0; }
p:last-child, ul:last-child { margin-bottom: 0; }
ul { padding-left: 20px; } li { margin: 8px 0; } small { display: block; margin-top: 4px; }
</style>

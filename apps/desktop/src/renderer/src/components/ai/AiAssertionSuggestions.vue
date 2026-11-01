<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { AiStore } from '../../stores/ai.js';
import AiAssertionDetails from './AiAssertionDetails.vue';
defineProps<{ ai: AiStore }>();
const { t } = useI18n();
</script>
<template>
  <section v-if="ai.businessResult?.purpose === 'assertion-suggestion'" class="assertions">
    <article v-for="candidate in ai.businessResult.assertions" :key="candidate.assertion.id">
      <label><input type="checkbox" :checked="ai.selectedIds.includes(candidate.assertion.id)" @change="ai.toggleSelect(candidate.assertion.id)" /> {{ t('ai.selectCandidate') }}</label>
      <AiAssertionDetails :assertion="candidate.assertion" />
      <dl>
        <dt>{{ t('ai.basis') }}</dt><dd>{{ t(`ai.bases.${candidate.basis}`) }}</dd>
        <dt>{{ t('ai.reason') }}</dt><dd>{{ candidate.reason }}</dd>
        <dt>{{ t('ai.evidence') }}</dt><dd><ul><li v-for="id in candidate.evidenceIds" :key="id">{{ id }}</li></ul></dd>
      </dl>
      <p v-if="candidate.requiresUserJudgment" role="note">{{ t('ai.judgmentRequired') }}</p>
    </article>
  </section>
</template>
<style scoped>
article { border-bottom: 1px solid var(--border, #ddd); padding: 12px 0; }
dl { display: grid; grid-template-columns: minmax(80px, 1fr) minmax(0, 3fr); gap: 6px 12px; }
dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; } dt { color: var(--text-muted, #666); }
ul { margin: 0; padding-left: 18px; } .assertions { overflow: auto; }
</style>

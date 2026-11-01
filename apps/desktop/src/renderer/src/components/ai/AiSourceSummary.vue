<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { AiSourceSummary } from '@apicc/core';
import { aiSourceSections } from '../../ai/presentation.js';
const props = defineProps<{ source: AiSourceSummary }>();
const { t } = useI18n();
const sections = computed(() => aiSourceSections(props.source, t));
</script>
<template>
  <section v-for="(section, index) in sections" :key="index" class="source-summary">
    <h4>{{ section.label }}</h4><dl><template v-for="(row, rowIndex) in section.rows" :key="rowIndex"><dt>{{ row.label }}</dt><dd>{{ row.value }}</dd></template></dl>
  </section>
</template>
<style scoped>
dl { display: grid; grid-template-columns: minmax(90px, 1fr) minmax(0, 3fr); gap: 6px 12px; }
dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; } dt { color: var(--text-muted, #666); }
.source-summary { overflow: auto; max-width: 100%; }
</style>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { Assertion } from '@apicc/core';
defineProps<{ assertion: Assertion }>();
const { t } = useI18n();
// Options are declarative business values, not debug JSON. Keep user keys and scalar values intact.
function optionRows(value: unknown, path = ''): Array<{ key: string; value: string }> {
  if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => optionRows(item, path ? `${path}.${key}` : key));
  return [{ key: path, value: value === null ? 'null' : String(value) }];
}
</script>
<template>
  <dl class="assertion-details">
    <dt>{{ t('ai.target') }}</dt><dd>{{ assertion.target }}</dd>
    <dt>{{ t('ai.operator') }}</dt><dd>{{ assertion.op }}</dd>
    <template v-if="assertion.path !== undefined"><dt>{{ t('ai.path') }}</dt><dd>{{ assertion.path }}</dd></template>
    <template v-if="assertion.headerName !== undefined"><dt>{{ t('ai.headerName') }}</dt><dd>{{ assertion.headerName }}</dd></template>
    <template v-if="assertion.cookieName !== undefined"><dt>{{ t('ai.cookieName') }}</dt><dd>{{ assertion.cookieName }}</dd></template>
    <dt>{{ t('ai.match') }}</dt><dd>{{ t(assertion.match === 'all' ? 'ai.matchAll' : 'ai.matchFirst') }}</dd>
    <dt>{{ t('ai.expected') }}</dt><dd>{{ assertion.expected ?? t('ai.unspecified') }}</dd>
    <template v-if="assertion.namespaces"><dt>{{ t('ai.namespaces') }}</dt><dd><dl><template v-for="(uri, prefix) in assertion.namespaces" :key="prefix"><dt>{{ prefix }}</dt><dd>{{ uri }}</dd></template></dl></dd></template>
    <template v-if="assertion.options"><dt>{{ t('ai.assertionOptions') }}</dt><dd><dl><template v-for="row in optionRows(assertion.options)" :key="row.key"><dt>{{ row.key }}</dt><dd>{{ row.value }}</dd></template></dl></dd></template>
  </dl>
</template>
<style scoped>
dl { display: grid; grid-template-columns: minmax(80px, 1fr) minmax(0, 3fr); gap: 6px 12px; }
dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; } dt { color: var(--text-muted, #666); }
</style>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { SyncHistoryEntry } from '@apicc/core/sync/shared';
import { utcTime, shortIdentity } from './presentation.js';
const props = defineProps<{ entries: SyncHistoryEntry[]; search?: string; disabled?: boolean }>();
const emit = defineEmits<{ rollback: [entry: SyncHistoryEntry] }>();
const { t } = useI18n(); const confirming = ref('');
const rows = computed(() => props.entries.filter(h => !props.search || [h.sourceId, h.actor.name, h.operationKind, h.id].join(' ').toLowerCase().includes(props.search.toLowerCase())).slice().reverse());
</script>
<template><section><h3>{{ t('sync.history') }}</h3><p v-if="!rows.length">{{ t(entries.length ? 'sync.noMatchingHistory' : 'sync.noHistory') }}</p><ol class="sync-history"><li v-for="entry in rows" :key="entry.id"><h4>{{ t(entry.operationKind === 'apply' ? 'sync.applyKind' : 'sync.rollbackKind') }} · <time :title="String(entry.createdAtMs)">{{ utcTime(entry.createdAtMs) }}</time></h4><dl><dt>{{ t('sync.actor') }}</dt><dd>{{ entry.actor.name }}</dd><dt>{{ t('sync.sourceId') }}</dt><dd>{{ entry.sourceId }}</dd><dt>{{ t('sync.definition') }}</dt><dd>{{ shortIdentity(entry.before.definitionRevision) }} → {{ shortIdentity(entry.after.definitionRevision) }}</dd></dl><details><summary>{{ t('sync.advanced') }}</summary><dl><dt>{{ t('sync.history') }}</dt><dd>{{ entry.id }}</dd><dt>{{ t('sync.intent') }}</dt><dd>{{ entry.intentId }}</dd><dt>{{ t('sync.definition') }}</dt><dd>{{ entry.before.definitionRevision }} → {{ entry.after.definitionRevision }}</dd></dl></details><button :disabled="disabled" @click="confirming = entry.id">{{ t('sync.rollback') }}</button><div v-if="confirming === entry.id" class="sync-confirm"><p>{{ t('sync.rollbackConfirm') }}</p><button :disabled="disabled" @click="emit('rollback', entry); confirming = ''">{{ t('sync.rollback') }}</button><button @click="confirming = ''">{{ t('sync.close') }}</button></div></li></ol></section></template>

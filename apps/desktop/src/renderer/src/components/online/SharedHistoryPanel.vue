<script setup lang="ts">
import type { CollaborationStore } from '../../stores/collaboration.js';
import { useI18n } from 'vue-i18n';
import { collaborationTime as time } from './collaborationPresentation.js';
import CollaborationArtifact from './CollaborationArtifact.vue';
import { ref } from 'vue';
import type { CollaborationHistoryMetadata } from '@apicc/execution/client';
const props = defineProps<{ collaboration: CollaborationStore }>();
type Query = NonNullable<Parameters<CollaborationStore['loadHistory']>[0]>;
const source = ref<Query['source'] | ''>(''), conclusion = ref<Query['conclusion'] | ''>(''), limit = ref('');
async function action(run: () => Promise<unknown>) { try { await run(); } catch { /* Finite store reason is shown by the surrounding collaboration panel. */ } }
async function filter() { await props.collaboration.loadHistory({ ...(source.value ? { source: source.value } : {}), ...(conclusion.value ? { conclusion: conclusion.value } : {}), ...(limit.value ? { limit: Number(limit.value) } : {}) }); }
async function publish(row: CollaborationHistoryMetadata) { await props.collaboration.selectOnline({ title: t('collaboration.historyReport'), includeEvidence: false, source: row.source === 'server-report' ? { kind: 'server-report', jobId: row.jobId! } : { kind: 'member-history', uploadId: row.id } }); }
const { t, te, locale } = useI18n();
const label = (code: string) => te(`collaboration.knownCodes.${code}`) ? t(`collaboration.knownCodes.${code}`) : te(`collaboration.codes.${code}`) ? t(`collaboration.codes.${code}`) : code;
</script>
<template>
  <section class="shared-history">
    <h3>{{ t('collaboration.sharedHistory') }}</h3>
    <div class="filters"><label>{{ t('collaboration.source') }}<select v-model="source" data-testid="history-source"><option value="">{{ t('collaboration.allSources') }}</option><option value="server-report">{{ label('server-report') }}</option><option value="member-history">{{ label('member-history') }}</option></select></label><label>{{ t('collaboration.conclusion') }}<select v-model="conclusion" data-testid="history-conclusion"><option value="">{{ t('collaboration.allConclusions') }}</option><option v-for="code in (['passed','failed','interrupted','cancelled','timed-out','rejected','unknown'] as const)" :key="code" :value="code">{{ label(code) }}</option></select></label><label>{{ t('collaboration.pageSize') }}<input v-model="limit" type="number" min="1" max="200" :placeholder="t('collaboration.serverDefault')" data-testid="history-limit" /></label><button data-testid="history-filter" @click="action(filter)">{{ t('collaboration.applyFilters') }}</button></div>
    <div class="table-scroll"><table><thead><tr><th class="compact-column">ID</th><th>{{ t('collaboration.source') }}</th><th class="compact-column">{{ t('collaboration.conclusion') }}</th><th>{{ t('collaboration.conclusionBasis') }}</th><th>{{ t('collaboration.integrity') }}</th><th>{{ t('collaboration.createdAt') }}</th><th>{{ t('collaboration.agent') }}</th><th>{{ t('collaboration.execution') }}</th><th>{{ t('collaboration.runtime') }}</th><th>{{ t('collaboration.readHistory') }}</th></tr></thead>
      <tbody><tr v-for="row in collaboration.history" :key="`${row.source}:${row.id}`"><td>{{ row.id }}</td><td>{{ label(row.source) }} · {{ label(row.trust) }}</td><td>{{ label(row.conclusion ?? 'unknown') }} · {{ label(row.state) }}</td><td>{{ label(row.conclusionInfo.reasonCode ?? row.conclusionInfo.origin) }}</td><td>{{ label(row.integrity) }}</td><td>{{ time(row.createdAt, locale) }}</td><td>{{ row.agentId ?? t('collaboration.notCollected') }}</td><td>{{ row.executionId ?? t('collaboration.notCollected') }}</td><td>{{ row.runtime.runtimeCompatibilityId ?? t('collaboration.notCollected') }} · Node {{ row.runtime.nodeVersion ?? t('collaboration.notCollected') }}</td><td><button data-testid="history-read" @click="action(() => collaboration.readHistory({id: row.id, source: row.source}))">{{ t('collaboration.readHistory') }}</button><button data-testid="history-publish" @click="action(() => publish(row))">{{ t('collaboration.publishToProject') }}</button></td></tr></tbody>
    </table></div>
    <button v-if="collaboration.historyCursor" data-testid="history-next" @click="action(() => collaboration.nextHistory())">{{ t('collaboration.nextPage') }}</button>
    <template v-if="collaboration.historyBody"><h4>{{ collaboration.historyBody.artifact.title }}</h4><CollaborationArtifact :artifact="collaboration.historyBody.artifact" /></template>
  </section>
</template>
<style scoped>.shared-history{min-width:0}.table-scroll{overflow:auto;max-height:32rem}table{border-collapse:collapse;min-width:1000px;width:100%}td,th{text-align:left;padding:8px;border-bottom:1px solid var(--border);overflow-wrap:anywhere;vertical-align:top}th.compact-column{min-width:5rem;white-space:nowrap;overflow-wrap:normal}</style>

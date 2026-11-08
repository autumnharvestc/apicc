<script setup lang="ts">
import { computed, reactive } from 'vue';
import { useI18n } from 'vue-i18n';
import { presentSyncCandidate, type SyncCandidateView, type SyncFixedDetail, type SyncFixedDetailRequest, type SyncDecisions } from '@apicc/core/sync/shared';
import { readableReason, shortIdentity } from './presentation.js';
const props = defineProps<{ view: SyncCandidateView; decisions: SyncDecisions['entries']; search?: string; details?: Record<string, SyncFixedDetail>; detailChangeId?: string; detailBusy?: string[]; detailErrors?: Record<string, string> }>();
const emit = defineEmits<{ decide: [entry: SyncDecisions['entries'][number]]; reader: [changeId: string]; detail: [changeId: string, side: SyncFixedDetailRequest['side']] }>();
const { t, te, locale } = useI18n();
const presentation = computed(() => presentSyncCandidate(props.view, locale.value === 'en' ? 'en' : 'zh-CN'));
const matches = computed(() => props.view.candidate.changes.map((change, index) => ({ change, display: presentation.value.changes[index]! })).filter(row => !props.search || [row.display.name, row.display.field, row.display.baseline, row.display.current, row.display.source, row.change.path].join(' ').toLowerCase().includes(props.search.toLowerCase())));
const sides = ['baseline', 'current', 'source'] as const;
const detailKey = (changeId: string, side: string) => `${props.view.candidate.id}:${changeId}:${side}`;
const detailFor = (changeId: string, side: string) => props.details?.[detailKey(changeId, side)];
const existing = reactive<Record<string, string>>({});
const selected = (id: string) => props.decisions.find(d => d.changeId === id)?.decision ?? '';
function decide(id: string, decision: string) { if (decision === 'map-existing') emit('decide', { changeId: id, decision, existingEntityId: existing[id] ?? '' }); else if (decision === 'take-source' || decision === 'keep-current') emit('decide', { changeId: id, decision }); }
const conflictLabel = (reason: string) => t('sync.' + ({ 'both-modified': 'bothModified', 'source-deleted-local-modified': 'sourceDeleted', 'identity-ambiguous': 'ambiguous', 'protected-reference': 'protected', 'unsupported-source': 'unsupported' }[reason] ?? 'conflicts'));
</script>
<template>
  <section data-testid="sync-candidate" aria-live="polite">
    <h3>{{ presentation.title }}</h3><p data-testid="sync-candidate-status">{{ presentation.status }}</p>
    <dl class="sync-summary"><div v-for="item in presentation.summary" :key="item.label"><dt>{{ item.label }}</dt><dd>{{ item.value }}</dd></div></dl>
    <p>{{ t('sync.fixedSummary') }}</p>
    <ul v-if="presentation.diagnostics.length" aria-label="diagnostics"><li v-for="diagnostic in presentation.diagnostics" :key="diagnostic.code + diagnostic.path">{{ diagnostic.severity }} — {{ diagnostic.message }} <span>{{ diagnostic.path }}</span></li></ul>
    <p v-if="view.candidate.changes.length && !matches.length" data-testid="sync-change-empty" class="sync-empty" role="status">{{ t('sync.noMatchingChanges') }}</p>
    <article v-for="{ change, display } in matches" :key="change.changeId" class="sync-change">
      <h4>{{ display.name }} — {{ display.operation }} · {{ display.layer }} · {{ display.field }}</h4>
      <p v-for="conflict in view.candidate.conflicts.filter(c => c.changeId === change.changeId)" :key="conflict.reasonCode" class="sync-reason">{{ conflictLabel(conflict.reasonCode) }}</p>
      <dl class="sync-three-way"><dt>{{ t('sync.baseline') }}</dt><dd>{{ display.baseline }}</dd><dt>{{ t('sync.current') }}</dt><dd>{{ display.current }}</dd><dt>{{ t('sync.upstream') }}</dt><dd>{{ display.source }}</dd></dl>
      <label>{{ t('sync.decision') }} <select :value="selected(change.changeId)" :data-change="change.changeId" @change="decide(change.changeId, ($event.target as HTMLSelectElement).value)"><option value="" disabled>{{ t('sync.choose') }}</option><option value="take-source">{{ t('sync.takeSource') }}</option><option value="keep-current">{{ t('sync.keepCurrent') }}</option><option value="map-existing">{{ t('sync.mapExisting') }}</option></select></label>
      <label v-if="selected(change.changeId) === 'map-existing'">{{ t('sync.existingId') }}<input v-model="existing[change.changeId]" @input="decide(change.changeId, 'map-existing')" /></label>
      <details :data-fixed-detail="change.changeId" :open="detailChangeId === change.changeId" class="sync-fixed-documents" @toggle="($event.target as HTMLDetailsElement).open && emit('reader', change.changeId)"><summary>{{ t('sync.fixedDocuments') }}</summary>
        <p>{{ t('sync.fixedDocumentNote') }} {{ change.path }} · {{ change.fieldPath || '/' }}</p>
        <section v-for="side in sides" :key="side"><h5>{{ t(side === 'baseline' ? 'sync.baseline' : side === 'current' ? 'sync.current' : 'sync.upstream') }}</h5>
          <button :data-detail-side="side" :disabled="!!detailBusy?.length" @click="emit('detail', change.changeId, side)">{{ t('sync.loadFixedDocument') }}</button>
          <p v-if="detailErrors?.[detailKey(change.changeId, side)]" role="alert">{{ readableReason(detailErrors[detailKey(change.changeId, side)]!, t, te) }}</p>
          <template v-if="detailFor(change.changeId, side)"><p v-if="detailFor(change.changeId, side)!.kind === 'absent'">{{ t('sync.fixedAssetAbsent') }}</p><template v-else-if="detailFor(change.changeId, side)!.kind === 'document'">
            <p>{{ (detailFor(change.changeId, side) as Extract<SyncFixedDetail, { kind: 'document' }>).contentType }} · {{ (detailFor(change.changeId, side) as Extract<SyncFixedDetail, { kind: 'document' }>).bytes.toLocaleString() }} {{ t('sync.bytes') }}</p>
            <pre class="sync-fixed-document" :data-fixed-side="side">{{ (detailFor(change.changeId, side) as Extract<SyncFixedDetail, { kind: 'document' }>).text }}</pre>
            <details><summary>{{ t('sync.advanced') }}</summary>{{ (detailFor(change.changeId, side) as Extract<SyncFixedDetail, { kind: 'document' }>).sha256 }}</details>
          </template></template>
        </section>
      </details>
      <details><summary>{{ t('sync.advanced') }}</summary><dl><dt>{{ t('sync.change') }}</dt><dd>{{ change.changeId }}</dd><dt>{{ t('sync.filePath') }}</dt><dd>{{ change.path }} {{ change.fieldPath }}</dd><dt>{{ t('sync.existingId') }}</dt><dd>{{ change.entityId }}</dd></dl></details>
    </article>
    <section v-if="presentation.references.length"><h4>{{ t('sync.dependencies') }}</h4><ul><li v-for="reference in presentation.references" :key="reference.ownerId + reference.path">{{ reference.reason }} — {{ shortIdentity(reference.ownerId) }} → {{ shortIdentity(reference.targetId) }} · {{ reference.path }}<details><summary>{{ t('sync.advanced') }}</summary>{{ reference.ownerId }} → {{ reference.targetId }}</details></li></ul></section>
    <details><summary>{{ t('sync.advanced') }} · {{ shortIdentity(view.candidate.candidateDigest) }}</summary>
      <dl><dt>{{ t('sync.candidateId') }}</dt><dd>{{ view.candidate.id }}</dd><dt>{{ t('sync.digest') }}</dt><dd>{{ view.candidate.candidateDigest }}</dd><dt>{{ t('sync.definition') }}</dt><dd>{{ view.candidate.stamp.definitionRevision }}</dd><dt>{{ t('sync.coreIdentity') }}</dt><dd>{{ view.candidate.stamp.coreBuildId }}</dd><dt>{{ t('sync.rawDigest') }}</dt><dd>{{ view.candidate.upstream.rawSha256 }}</dd><template v-if="view.candidate.upstream.kind === 'git'"><dt>{{ t('sync.commitOid') }}</dt><dd>{{ view.candidate.upstream.commitOid }}</dd><dt>{{ t('sync.blobOid') }}</dt><dd>{{ view.candidate.upstream.blobOid }}</dd></template></dl>
    </details>
    <p v-if="view.candidate.upstream.kind === 'git'">{{ t('sync.commitOid') }}: {{ shortIdentity(view.candidate.upstream.commitOid) }} · {{ t('sync.blobOid') }}: {{ shortIdentity(view.candidate.upstream.blobOid) }}</p>
  </section>
</template>

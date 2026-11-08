<script setup lang="ts">
import type { CollaborationStore } from '../../stores/collaboration.js';
import { useI18n } from 'vue-i18n';
import { ref, computed, watch } from 'vue';
import { collaborationTime as time } from './collaborationPresentation.js';
import PublicationPreview from './PublicationPreview.vue';
import SharedHistoryPanel from './SharedHistoryPanel.vue';
const { t, te, locale } = useI18n();
const label = (code: string) => te('collaboration.knownCodes.' + code) ? t('collaboration.knownCodes.' + code) : te('collaboration.codes.' + code) ? t('collaboration.codes.' + code) : `${t('collaboration.codes.unknown')} (${code})`;
const props = defineProps<{ collaboration: CollaborationStore; saved?: { revision: string; manifestHash: string }; dirty?: boolean }>();
const canManage = computed(() => !props.collaboration.access || props.collaboration.access.capabilities.includes(props.collaboration.publications.find(row => row.id === props.collaboration.selectedPublicationId)?.kind === 'mock' ? 'mock.manage' : 'publication.manage'));
const revisionConflict = computed(() => /\b(?:grant|publication)_revision_conflict\b/.test(props.collaboration.error));
async function refreshRevisions() { await Promise.all([props.collaboration.loadPublications(), props.collaboration.loadGrants(props.collaboration.selectedPublicationId)]); }
async function previewSaved(kind: 'document' | 'mock') {
  if (props.dirty) { await props.collaboration.cancelPreview(); props.collaboration.error = 'collaboration-save-first'; return; }
  await props.collaboration.selectOnline({ title: t('collaboration.defaultTitles.' + kind), includeEvidence: false, source: { kind, ...props.saved!, scope: { kind: 'project' } } });
}
const audience = ref<'members' | 'external'>('members'), duration = ref(604800000), download = ref(false), durationEdited = ref(false);
async function action(run: () => Promise<unknown>) { try { await run(); } catch { /* The store presents a finite reason; never retry a write here. */ } }
watch(() => props.collaboration.grantConstraints?.defaultShareDurationMs.value, value => { if (value !== undefined && !durationEdited.value) duration.value = value; }, { immediate: true });
</script>
<template>
  <section class="collaboration-panel online-surface">
    <header class="collaboration-status"><h2>{{ t('collaboration.title') }}</h2><p v-if="collaboration.result?.stage === 'published'">{{ collaboration.result.publication.id }}</p>
    <button v-for="kind in (['publication', 'grant'] as const)" :key="kind" :disabled="kind === 'grant' && collaboration.grantBusy" :data-testid="'reconcile-' + kind" @click="action(() => collaboration.reconcile(kind))">{{ t('collaboration.reconcile.' + kind) }}</button>
    <p v-if="collaboration.grantPending" role="status">{{ t('collaboration.producerErrors.collaboration-grant-pending.reason') }} · {{ t('collaboration.producerErrors.collaboration-grant-pending.nextStep') }}</p>
    <p v-if="collaboration.result?.stage === 'publication-reconciled'">{{ collaboration.result.receipt.state === 'committed' ? t('collaboration.publicationCommitted') : collaboration.result.receipt.state }} · {{ collaboration.result.receipt.publicationId }}</p>
    <p v-if="collaboration.result?.stage === 'published' && 'activity' in collaboration.result.publication && collaboration.result.publication.activity">{{ t('collaboration.mockActivity') }}: {{ collaboration.result.publication.activity.activeRequests }} · {{ t('collaboration.activityStates.' + collaboration.result.publication.activity.state) }}</p>
    <p v-if="collaboration.error === 'collaboration-save-first'" role="alert">{{ t('collaboration.saveFirst') }}</p>
    </header>
    <PublicationPreview :collaboration="collaboration" /><SharedHistoryPanel :collaboration="collaboration" />
    <section class="collaboration-card"><h3>{{ t('collaboration.publications') }}</h3>
    <button v-if="revisionConflict && collaboration.selectedPublicationId" data-testid="refresh-collaboration" @click="action(refreshRevisions)">{{ t('collaboration.refreshRevisions') }}</button>
    <div v-if="saved"><button v-for="kind in (['document','mock'] as const)" :key="kind" :data-testid="'preview-' + kind" @click="action(() => previewSaved(kind))">{{ t('collaboration.previewKinds.' + kind) }}</button></div>
    <button data-testid="load-publications" @click="action(() => collaboration.loadPublications())">{{ t('collaboration.publications') }}</button>
    <ul><li v-for="row in collaboration.publications" :key="row.id">{{ row.id }} · {{ t('collaboration.version') }} {{ row.version }} · {{ t('collaboration.kindNames.' + row.kind) }} · {{ t('collaboration.codes.' + row.trust) }} · {{ t('collaboration.externalAvailability') }}: {{ t(row.enabled ? 'collaboration.allowed' : 'collaboration.notAllowed') }} <button data-testid="manage-grants" @click="action(() => collaboration.loadGrants(row.id))">{{ t('collaboration.grants') }}</button><button v-if="row.kind === 'mock'" :data-testid="row.enabled ? 'mock-disable' : 'mock-enable'" @click="action(() => collaboration.setMock(row.id, !row.enabled, row.revision))">{{ t(row.enabled ? 'collaboration.disableMock' : 'collaboration.enableMock') }}</button></li></ul>
    <button v-if="collaboration.publicationsCursor" data-testid="publications-next" @click="action(() => collaboration.nextPublications())">{{ t('collaboration.nextPage') }}</button>
    </section>
    <section class="collaboration-card"><h3>{{ t('collaboration.grants') }}</h3>
    <dl v-if="collaboration.grantConstraints"><template v-for="(fact, code) in collaboration.grantConstraints" :key="code"><dt>{{ t('collaboration.constraints.' + code) }}</dt><dd>{{ typeof fact.value === 'boolean' ? t(fact.value ? 'collaboration.allowed' : 'collaboration.notAllowed') : `${fact.value} ms` }} · {{ t('collaboration.sources.' + fact.source) }}</dd></template></dl>
    <div v-if="collaboration.grantConstraints"><p>{{ t('collaboration.durationRange', { maximum: collaboration.grantConstraints.maxShareDurationMs.value }) }} · {{ t('collaboration.serverDurationStart') }}</p><label>{{ t('collaboration.audience') }}<select v-model="audience" data-testid="grant-audience"><option value="members">{{ t('collaboration.members') }}</option><option value="external">{{ t('collaboration.external') }}</option></select></label><label>{{ t('collaboration.duration') }}<input v-model.number="duration" @input="durationEdited = true" type="number" min="60000" :max="collaboration.grantConstraints.maxShareDurationMs.value" data-testid="grant-duration" /> ms</label><label><input v-model="download" :disabled="!collaboration.grantConstraints.externalDownloadAllowed.value" type="checkbox" />{{ t('collaboration.download') }}</label><button :disabled="!canManage || collaboration.grantBusy || collaboration.grantPending" data-testid="create-grant" @click="action(() => collaboration.createGrant(audience, duration, download))">{{ t('collaboration.createGrant') }}</button></div>
    <p v-if="collaboration.result?.stage === 'grant-reconciled'">{{ t('collaboration.keyNotObtained') }} · {{ collaboration.result.receipt.grantId }} · {{ t('collaboration.explicitRotation') }}</p>
    <p v-if="collaboration.grantRefreshRequired">{{ t('collaboration.revokedRefresh') }} <button data-testid="refresh-grants" @click="action(() => collaboration.loadGrants(collaboration.selectedPublicationId))">{{ t('collaboration.refreshGrants') }}</button></p>
    <ul><li v-for="row in collaboration.grants" :key="row.id">{{ row.id }} · {{ t('collaboration.purposeNames.' + row.purpose) }} · {{ t(row.audience === 'external' ? 'collaboration.external' : 'collaboration.members') }} · {{ label(row.state) }} <span v-if="row.reason">· {{ label(row.reason) }}</span><dl><dt>{{ t('collaboration.grantExpiry') }}</dt><dd>{{ time(row.expiresAt, locale) }}</dd><dt>{{ t('collaboration.download') }}</dt><dd>{{ t(row.downloadAllowed ? 'collaboration.allowed' : 'collaboration.notAllowed') }}</dd><dt>{{ t('collaboration.revision') }}</dt><dd>{{ row.revision }}</dd></dl><p v-if="row.state !== 'active'">{{ t('collaboration.inactiveGrant') }}</p><button v-for="command in (['copy','rotate','revoke'] as const)" :key="command" :disabled="command !== 'copy' && !canManage || command === 'rotate' && (row.state !== 'active' || collaboration.grantBusy || collaboration.grantPending)" :data-testid="command + '-grant'" @click="action(() => collaboration.grantCommand(command, row))">{{ t('collaboration.' + command) }}</button></li></ul>
    <button v-if="collaboration.grantsCursor" data-testid="grants-next" @click="action(() => collaboration.nextGrants())">{{ t('collaboration.nextPage') }}</button>
    </section>
  </section>
</template>
<style scoped src="../../styles/online-controls.css"></style>
<style scoped>

.collaboration-panel{min-width:0;display:flex;flex-direction:column;gap:16px;background:var(--panel);padding:16px;border-radius:12px}.collaboration-status,.collaboration-card{min-width:0;border:1px solid var(--border);background:var(--bg);border-radius:10px;padding:16px;box-shadow:var(--panel-shadow)}
ul{list-style:none;padding:0;max-height:30rem;overflow:auto}li{margin:10px 0;overflow-wrap:anywhere;border:1px solid var(--border);border-radius:8px;padding:12px;background:var(--subtle)}
dl{display:grid;grid-template-columns:minmax(90px,.4fr) minmax(0,1fr);gap:8px 16px}dd{margin:0;overflow-wrap:anywhere}button{margin:4px 8px 4px 0;white-space:normal}label{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:12px 0}input[type=number]{width:12rem}p{max-width:90ch}
@media(max-width:600px){.collaboration-panel{padding:10px;gap:10px}.collaboration-status,.collaboration-card{padding:12px}}

</style>

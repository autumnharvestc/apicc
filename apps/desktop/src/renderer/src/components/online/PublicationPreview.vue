<script setup lang="ts">
import { computed } from 'vue';
import type { CollaborationStore } from '../../stores/collaboration.js';
import { useI18n } from 'vue-i18n';
import CollaborationArtifact from './CollaborationArtifact.vue';
import { collaborationBytes as bytes, collaborationTime as time, collaborationDuration as duration } from './collaborationPresentation.js';
const props = defineProps<{ collaboration: CollaborationStore }>();
async function action(run: () => Promise<unknown>) { try { await run(); } catch { /* Store owns the finite presentation reason. */ } }
const { t, te, locale } = useI18n();
const producerError = computed(() => props.collaboration.error.match(/[A-Za-z][A-Za-z_-]+/g)?.find(code => te(`collaboration.producerErrors.${code}.reason`)));
const errorKey = computed(() => {
  const code = props.collaboration.error.match(/[A-Za-z][A-Za-z_-]+/g)?.find(value => te(`collaboration.rejections.${value}`));
  return `collaboration.rejections.${code ?? 'unknown'}`;
});
const selected = computed(() => props.collaboration.preview);
const upload = computed(() => { const id = selected.value?.candidateId; return () => props.collaboration.confirmUpload(id); });
const publish = computed(() => { const id = selected.value?.candidateId; return () => props.collaboration.confirmPublication(id); });
const artifact = computed(() => props.collaboration.preview?.stage === 'local' ? props.collaboration.preview.artifact : props.collaboration.preview?.stage === 'server' && 'artifact' in props.collaboration.preview.preview ? props.collaboration.preview.preview.artifact : null);
const source = computed(() => artifact.value?.source ?? (selected.value?.stage === 'server' && 'source' in selected.value.preview ? selected.value.preview.source : null));
const serverContentBytes = computed(() => selected.value?.stage === 'server' ? new TextEncoder().encode(JSON.stringify('artifact' in selected.value.preview ? selected.value.preview.artifact : selected.value.preview.plan)).length : 0);
</script>
<template>
  <section v-if="collaboration.error" role="alert"><template v-if="producerError"><p>{{ t('collaboration.producerErrors.' + producerError + '.reason') }}</p><p>{{ t('collaboration.producerErrors.' + producerError + '.nextStep') }}</p></template><template v-else><p>{{ t(errorKey) }}</p><p v-if="!errorKey.endsWith('collaboration-key-unavailable')">{{ t('collaboration.reselectHint') }}</p></template></section>
  <section v-if="selected" class="publication-preview online-surface" data-testid="publication-preview">
    <h3>{{ artifact?.title ?? t('collaboration.mockPlan') }}</h3>
    <dl><dt>{{ t('collaboration.target') }}</dt><dd>{{ collaboration.context?.serverId }} · {{ collaboration.context?.scope.workspaceId }} / {{ collaboration.context?.scope.projectId }}</dd><dt>{{ t('collaboration.account') }}</dt><dd>{{ collaboration.context?.ownerId }}</dd><dt>{{ t('collaboration.trust') }}</dt><dd>{{ t('collaboration.codes.' + (artifact?.source.trust ?? 'saved-contract')) }}</dd><dt>{{ t('collaboration.sourceRevision') }}</dt><dd>{{ source?.revision }}</dd><dt>{{ t('collaboration.previewExpires') }}</dt><dd>{{ time(selected.stage === 'local' ? selected.expiresAt : selected.preview.expiresAt, locale) }}</dd></dl>
    <details v-if="selected.stage === 'server'"><summary>{{ t('collaboration.fingerprint') }}: {{ selected.preview.candidateDigest.slice(0,12) }}…</summary><code>{{ selected.preview.candidateDigest }}</code></details>
    <template v-if="selected.stage === 'local'">
      <h4>{{ t('collaboration.localCeiling') }}</h4><p>{{ t('collaboration.localNoNetwork') }}</p>
      <dl><dt>{{ t('collaboration.location') }}</dt><dd>{{ t('collaboration.localExecution') }}</dd><dt>{{ t('collaboration.scope') }}</dt><dd>{{ t('collaboration.singleItem') }} · {{ t('collaboration.codes.' + selected.source.kind) }}</dd><dt>{{ t('collaboration.artifactBytes') }}</dt><dd>{{ selected.artifactBytes }} B</dd><dt>{{ t('collaboration.uploadBytes') }}</dt><dd>{{ selected.uploadBytes }} B</dd><dt>{{ t('collaboration.sourceBudget') }}</dt><dd>{{ bytes(selected.localLimits.maxSourceBytes) }}</dd><dt>{{ t('collaboration.artifactBudget') }}</dt><dd>{{ bytes(selected.localLimits.maxArtifactBytes) }}</dd><dt>{{ t('collaboration.fieldBudget') }}</dt><dd>{{ bytes(selected.localLimits.maxFieldBytes) }}</dd><dt>{{ t('collaboration.evidence') }}</dt><dd>{{ t('collaboration.evidenceExcluded') }}</dd><dt>{{ t('collaboration.retention') }}</dt><dd>{{ t('collaboration.retentionUnknown') }}</dd></dl>
      <button :disabled="collaboration.busy" data-testid="confirm-upload" @click="action(upload)">{{ t('collaboration.confirmUpload') }}</button>
    </template>
    <template v-else>
      <h4>{{ t('collaboration.serverLimits') }}</h4><p>{{ t('collaboration.policyNotAuthority') }}</p>
      <dl><dt>{{ t('collaboration.scope') }}</dt><dd>{{ t('collaboration.fixedScope') }}</dd><dt>{{ t('collaboration.fixedContentBytes') }}</dt><dd>{{ serverContentBytes }} B</dd></dl>
      <div class="table-scroll"><table><thead><tr><th>{{ t('collaboration.setting') }}</th><th>{{ t('collaboration.value') }}</th><th>{{ t('collaboration.factSource') }}</th></tr></thead><tbody><tr v-for="(fact, code) in selected.preview.constraints" :key="code"><th>{{ t('collaboration.constraints.' + code) }}</th><td>{{ typeof fact.value === 'boolean' ? t(fact.value ? 'collaboration.allowed' : 'collaboration.notAllowed') : code.endsWith('Ms') ? duration(fact.value, locale) : bytes(fact.value) }}</td><td>{{ t('collaboration.sources.' + fact.source) }}</td></tr></tbody></table></div>
      <p>{{ t('collaboration.retentionIndependent') }}</p><button :disabled="collaboration.busy" data-testid="confirm-publication" @click="action(publish)">{{ t('collaboration.confirmPublication') }}</button>
    </template>
    <CollaborationArtifact v-if="artifact" :artifact="artifact" />
    <template v-else-if="selected.stage === 'server' && 'plan' in selected.preview"><h4>{{ t('collaboration.mockPlan') }}</h4><div class="table-scroll"><table><thead><tr><th>{{ t('collaboration.method') }}</th><th>{{ t('collaboration.path') }}</th><th>{{ t('collaboration.rules') }}</th></tr></thead><tbody><tr v-for="route in selected.preview.plan.routes" :key="route.contractId"><td>{{ route.method }}</td><td>{{ route.pathTemplate }}</td><td>{{ route.rules.length }}</td></tr></tbody></table></div></template>
    <button data-testid="cancel-preview" @click="action(() => collaboration.cancelPreview())">{{ t('collaboration.cancelPreview') }}</button>
  </section>
</template>
<style scoped src="../../styles/online-controls.css"></style>
<style scoped>

.publication-preview{padding:16px;min-width:0;border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:10px;background:var(--bg);box-shadow:var(--panel-shadow)}dl{display:grid;grid-template-columns:minmax(90px,.4fr) minmax(0,1fr);gap:8px 16px}dd{margin:0;overflow-wrap:anywhere}.table-scroll{max-height:360px}table{min-width:480px}td{overflow-wrap:anywhere}button{margin:8px 8px 8px 0}.publication-preview>details{padding:8px 12px;background:var(--subtle);border-radius:8px}.publication-preview h3{margin-top:0}

</style>

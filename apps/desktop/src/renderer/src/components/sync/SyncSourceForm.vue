<script setup lang="ts">
import { reactive, ref, watch, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { SyncSourceSchema, type SyncSource } from '@apicc/core/sync/shared';
import { SyncNetworkCredentialSchema } from '@apicc/execution/contract';
import type { ApiccApi } from '../../../../shared/types.js';
import type { SyncScope, SyncMaterialStatus } from '../../../../shared/synchronization.js';
import { readableReason } from './presentation.js';
const props = defineProps<{ source: SyncSource | null; modules: { id: string; name: string }[]; scope: SyncScope; materials: SyncMaterialStatus[]; api?: ApiccApi; contractProjectId?: string; disabled?: boolean; canManageMaterials?: boolean }>();
const emit = defineEmits<{ save: [source: SyncSource, expectedRevision: string]; materialSaved: [] }>();
const { t, te, locale } = useI18n();
const form = reactive({ kind: 'url' as SyncSource['kind'], moduleId: '', url: '', repositoryUrl: '', ref: 'main', filePath: 'openapi.yaml', authRef: '', networkProfileRef: '', privateKeyRef: '', knownHostsRef: '', passphraseRef: '' });
const error = ref(''), savingMaterial = ref(false), materialFeedback = ref(''), headerName = ref('Authorization'), materialValue = ref(''), purpose = ref<'authRef' | 'privateKeyRef' | 'knownHostsRef' | 'passphraseRef' | 'networkProfileRef'>('authRef');
const tlsDraft = () => ({ caPem: '', clientCertPem: '', clientKeyPem: '', clientKeyPassphrase: '' });
const network = reactive({ kind: 'direct' as 'direct' | 'proxy', name: '', proxyUrl: '', username: '', password: '', targetOrigin: '', target: tlsDraft(), proxy: tlsDraft() });
const clearNetworkSecrets = () => { network.password = ''; network.target.clientKeyPem = ''; network.target.clientKeyPassphrase = ''; network.proxy.clientKeyPem = ''; network.proxy.clientKeyPassphrase = ''; };
let epoch = 0;
watch(() => [props.source, props.scope], () => { epoch++; error.value = ''; materialValue.value = ''; clearNetworkSecrets(); materialFeedback.value = ''; const source = props.source;
  Object.assign(form, { kind: source?.kind ?? 'url', moduleId: source?.moduleId ?? props.modules[0]?.id ?? '', url: source?.kind === 'url' ? source.url : '', repositoryUrl: source && source.kind !== 'url' ? source.repositoryUrl : '', ref: source && source.kind !== 'url' ? source.ref : 'main', filePath: source && source.kind !== 'url' ? source.filePath : 'openapi.yaml', authRef: source && source.kind !== 'git-ssh' ? source.authRef ?? '' : '', networkProfileRef: source?.networkProfileRef ?? '', privateKeyRef: source?.kind === 'git-ssh' ? source.privateKeyRef : '', knownHostsRef: source?.kind === 'git-ssh' ? source.knownHostsRef : '', passphraseRef: source?.kind === 'git-ssh' ? source.passphraseRef ?? '' : '' });
}, { immediate: true });
const blocked = computed(() => !!props.disabled || !!props.source?.schedule.enabled);
watch(() => form.kind, kind => { purpose.value = kind === 'git-ssh' ? 'privateKeyRef' : 'authRef'; materialValue.value = ''; });
const materialRef = computed(() => form[purpose.value]);
function status(refId: string, network = false) { if (!refId) return t('sync.noMaterials'); const found = props.materials.find(m => m.refId === refId && (props.scope.kind === 'online' || m.kind === (network ? 'network-profile' : 'credential'))); return `${t('sync.' + (found?.status ?? 'missing'))}${found?.version ? ' · ' + t('sync.revision') + ' ' + found.version : ''}`; }
function save() {
  const source = props.source, expected = source?.revision ?? '0', base = { formatVersion: 1, id: source?.id ?? crypto.randomUUID(), revision: (BigInt(expected) + 1n).toString(), moduleId: form.moduleId, ...(form.networkProfileRef ? { networkProfileRef: form.networkProfileRef } : {}), schedule: { enabled: false, rule: source?.schedule.rule ?? { kind: 'cron', expression: '0 0 * * * *', timeZone: 'UTC', dstOverlap: 'first' } } };
  const parsed = SyncSourceSchema.safeParse(form.kind === 'url' ? { ...base, kind: form.kind, url: form.url, ...(form.authRef ? { authRef: form.authRef } : {}) } : form.kind === 'git-https' ? { ...base, kind: form.kind, repositoryUrl: form.repositoryUrl, ref: form.ref, filePath: form.filePath, ...(form.authRef ? { authRef: form.authRef } : {}) } : { ...base, kind: form.kind, repositoryUrl: form.repositoryUrl, ref: form.ref, filePath: form.filePath, privateKeyRef: form.privateKeyRef, knownHostsRef: form.knownHostsRef, ...(form.passphraseRef ? { passphraseRef: form.passphraseRef } : {}) });
  if (!parsed.success) { error.value = t('sync.unknownReason') + ' · ' + parsed.error.issues.map(i => i.path.join('.')).join(', '); return; } error.value = ''; emit('save', parsed.data, expected);
}
function saveNetworkMaterial() {
  const tls = (draft: ReturnType<typeof tlsDraft>) => ({ caPems: draft.caPem ? [draft.caPem] : [], clientCertPems: draft.clientCertPem ? [draft.clientCertPem] : [], ...(draft.clientKeyPem ? { clientKeyPem: draft.clientKeyPem } : {}), ...(draft.clientKeyPassphrase ? { clientKeyPassphrase: draft.clientKeyPassphrase } : {}) });
  const base = { name: network.name, targetTlsBindings: network.targetOrigin || Object.values(network.target).some(Boolean) ? [{ origin: network.targetOrigin, tls: tls(network.target) }] : [] };
  const result = SyncNetworkCredentialSchema.safeParse({ formatVersion: 1, kind: 'network-profile', profile: network.kind === 'direct' ? { ...base, kind: 'direct' } : { ...base, kind: 'proxy', proxyUrl: network.proxyUrl, ...(network.username ? { username: network.username } : {}), ...(network.password ? { password: network.password } : {}), proxyTLS: tls(network.proxy) } });
  clearNetworkSecrets(); if (!result.success) { error.value = readableReason('SYNC_MATERIAL_INVALID', t, te); return; }
  return saveMaterial(false, JSON.stringify(result.data));
}
async function saveMaterial(importFile = false, networkValue?: string) {
  if (!props.api || !props.canManageMaterials || !materialRef.value) return; const token = epoch, scope = props.scope, ref = { id: materialRef.value, policy: 'test-auto' as const }; savingMaterial.value = true; error.value = ''; materialFeedback.value = '';
  const value = networkValue ?? (purpose.value === 'authRef' ? JSON.stringify({ formatVersion: 1, kind: 'http-headers', headers: [{ name: headerName.value, value: materialValue.value }] }) : materialValue.value);
  materialValue.value = '';
  try {
    if (scope.kind === 'local') {
      if (importFile) { const result = await props.api.networkSecretImport({ locator: scope.locator, ref, locale: locale.value === 'en' ? 'en' : 'zh-CN' }); if (result.outcome !== 'saved') throw Error('SYNC_MATERIAL_INVALID'); }
      else { const result = await props.api.credentialPut({ locator: scope.locator, ref, value }); if (!result.ok) throw Error(result.error.code); }
    } else {
      if (!props.contractProjectId) throw Error('SYNC_CONTEXT_CHANGED');
      const result = await props.api.onlineExecution({ operation: 'credential', action: 'put', context: scope.context, ref, storage: 'project', contractProjectId: props.contractProjectId, value }); if (!result || typeof result !== 'object' || !('ok' in result) || !result.ok) throw Error('SYNC_MATERIAL_INVALID');
    }
    if (token === epoch) { materialFeedback.value = t('sync.materialSaved'); emit('materialSaved'); }
  } catch (cause) { if (token === epoch) error.value = readableReason(cause instanceof Error ? cause.message : 'SYNC_MATERIAL_INVALID', t, te); }
  finally { if (token === epoch) savingMaterial.value = false; }
}
</script>
<template>
  <section class="sync-source-form"><h3>{{ source ? t('sync.editSource') : t('sync.newSource') }}</h3><p>{{ t('sync.referencesOnly') }}</p><p v-if="source?.schedule.enabled" class="sync-reason">{{ t('sync.editEnabled') }}</p>
    <form @submit.prevent="save"><fieldset :disabled="blocked"><label>{{ t('sync.sourceType') }}<select v-model="form.kind"><option value="url">URL</option><option value="git-https">Git HTTPS</option><option value="git-ssh">Git SSH</option></select></label><label>{{ t('sync.module') }}<select v-model="form.moduleId" :disabled="!!source"><option v-for="module in modules" :key="module.id" :value="module.id">{{ module.name }}</option></select></label>
      <label v-if="form.kind === 'url'">{{ t('sync.url') }}<input v-model="form.url" type="url" required /></label><template v-else><label>{{ t('sync.repository') }}<input v-model="form.repositoryUrl" required /></label><label>{{ t('sync.gitRef') }}<input v-model="form.ref" required /></label><label>{{ t('sync.filePath') }}<input v-model="form.filePath" required /></label></template>
      <label>{{ t('sync.networkRef') }}<input v-model="form.networkProfileRef" :placeholder="t('sync.direct')" /></label><p v-if="form.networkProfileRef">{{ status(form.networkProfileRef, true) }}</p>
      <template v-if="form.kind !== 'git-ssh'"><label>{{ t('sync.authRef') }}<input v-model="form.authRef" /></label><p>{{ status(form.authRef) }}</p></template><template v-else><label>{{ t('sync.privateKeyRef') }}<input v-model="form.privateKeyRef" required /></label><p>{{ status(form.privateKeyRef) }}</p><label>{{ t('sync.knownHostsRef') }}<input v-model="form.knownHostsRef" required /></label><p>{{ status(form.knownHostsRef) }}</p><label>{{ t('sync.passphraseRef') }}<input v-model="form.passphraseRef" /></label><p v-if="form.passphraseRef">{{ status(form.passphraseRef) }}</p></template><button type="submit">{{ t('sync.save') }}</button></fieldset></form>
    <details v-if="api"><summary>{{ t('sync.materialSetup') }}</summary><p>{{ t('sync.materialEditPermission') }}</p><label>{{ t('sync.materialPurpose') }}<select v-model="purpose" @change="materialValue = ''"><option v-if="form.kind !== 'git-ssh'" value="authRef">{{ t('sync.authRef') }}</option><template v-else><option value="privateKeyRef">{{ t('sync.privateKeyRef') }}</option><option value="knownHostsRef">{{ t('sync.knownHostsRef') }}</option><option value="passphraseRef">{{ t('sync.passphraseRef') }}</option></template><option v-if="scope.kind === 'online'" value="networkProfileRef">{{ t('sync.networkMaterial') }}</option></select></label><p>{{ materialRef || t('sync.missing') }}</p>
      <section v-if="purpose === 'networkProfileRef' && scope.kind === 'online'" class="sync-network-material">
        <label>{{ t('sync.networkKind') }}<select v-model="network.kind" data-testid="sync-network-kind"><option value="direct">{{ t('sync.networkDirect') }}</option><option value="proxy">{{ t('sync.networkProxy') }}</option></select></label>
        <label>{{ t('sync.networkName') }}<input v-model="network.name" data-testid="sync-network-name" /></label>
        <label>{{ t('sync.networkOrigin') }}<input v-model="network.targetOrigin" data-testid="sync-network-origin" placeholder="https://api.example.com" /></label>
        <label>{{ t('sync.networkCa') }}<textarea v-model="network.target.caPem" data-testid="sync-network-ca" /></label>
        <label>{{ t('sync.networkClientCert') }}<textarea v-model="network.target.clientCertPem" data-testid="sync-network-client-cert" /></label>
        <label>{{ t('sync.networkClientKey') }}<textarea v-model="network.target.clientKeyPem" data-testid="sync-network-client-key" autocomplete="off" /></label>
        <label>{{ t('sync.networkClientPassphrase') }}<input v-model="network.target.clientKeyPassphrase" type="password" autocomplete="new-password" /></label>
        <template v-if="network.kind === 'proxy'"><label>{{ t('sync.networkProxyUrl') }}<input v-model="network.proxyUrl" data-testid="sync-network-proxy-url" /></label><label>{{ t('sync.networkProxyUser') }}<input v-model="network.username" data-testid="sync-network-proxy-user" /></label><label>{{ t('sync.networkProxyPassword') }}<input v-model="network.password" type="password" data-testid="sync-network-proxy-password" autocomplete="new-password" /></label><label>{{ t('sync.networkProxyCa') }}<textarea v-model="network.proxy.caPem" data-testid="sync-network-proxy-ca" /></label><label>{{ t('sync.networkClientCert') }}<textarea v-model="network.proxy.clientCertPem" /></label><label>{{ t('sync.networkClientKey') }}<textarea v-model="network.proxy.clientKeyPem" autocomplete="off" /></label><label>{{ t('sync.networkClientPassphrase') }}<input v-model="network.proxy.clientKeyPassphrase" type="password" autocomplete="new-password" /></label></template>
        <button data-testid="sync-network-save" :disabled="!canManageMaterials || !materialRef || savingMaterial" @click="saveNetworkMaterial">{{ t('sync.saveMaterial') }}</button>
      </section>
      <template v-else-if="scope.kind === 'local' && (purpose === 'privateKeyRef' || purpose === 'knownHostsRef')"><button :disabled="!canManageMaterials || !materialRef || savingMaterial" @click="saveMaterial(true)">{{ t('sync.importMaterial') }}</button></template>
      <template v-else><label v-if="purpose === 'authRef'">{{ t('sync.headerName') }}<input v-model="headerName" /></label><label>{{ purpose === 'authRef' ? t('sync.headerValue') : t('sync.materialValue') }}<textarea v-if="purpose === 'knownHostsRef' || purpose === 'privateKeyRef'" v-model="materialValue" autocomplete="off" /><input v-else v-model="materialValue" type="password" autocomplete="new-password" /></label><button :disabled="!canManageMaterials || !materialRef || !materialValue || savingMaterial" @click="saveMaterial()">{{ t('sync.saveMaterial') }}</button></template><p role="status">{{ materialFeedback }}</p>
    </details><p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>

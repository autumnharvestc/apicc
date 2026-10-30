<script setup lang="ts">
import {watch,onBeforeUnmount} from 'vue';
import {useI18n} from 'vue-i18n';
import type {SchedulingStore} from '../stores/scheduling.js';
const durationFields=['requestTimeoutMs','retryMinMs','retryMaxMs','deliveryTtlMs'] as const;
const budgetFields=['maxAttempts','jitterRatio','maxPayloadBytes','maxResponseBytes'] as const;
const props=defineProps<{scheduling:SchedulingStore;workspaceId:string}>();const {t}=useI18n();
watch(()=>props.workspaceId,()=>void props.scheduling.loadChannels(props.workspaceId),{immediate:true});
onBeforeUnmount(()=>props.scheduling.reset());
</script>
<template>
  <section class="channels" data-testid="notification-channels-view">
    <h2>{{t('scheduling.channelsTitle')}}</h2>
    <p>{{t('scheduling.channelHelp')}}</p><p>{{t('scheduling.originHelp')}}</p><p>{{t('scheduling.outboundHelp')}}</p>
    <p v-if="scheduling.error" role="alert">{{scheduling.error==='channel_unavailable'?t('scheduling.keyStates.unavailable'):t('scheduling.errors.'+(['forbidden','version_conflict','validation_failed','unauthorized','rotation_confirmation_required'].includes(scheduling.error)?scheduling.error:'other'))}} ({{scheduling.error}})<span v-for="field in scheduling.errorFields" :key="field"> · {{t((['name','url','hmacSecret'].includes(field)?'scheduling.channelFields.':'scheduling.fields.')+field)}}: {{t('scheduling.channelValidationHelp')}}</span></p>
    <button v-if="scheduling.conflict" type="button" data-testid="channel-reload" @click="scheduling.loadChannels(workspaceId,true)">{{t('scheduling.reload')}}</button>
    <div v-if="scheduling.channelsReady" class="table-scroll"><table>
      <thead><tr><th>{{t('scheduling.name')}}</th><th>{{t('scheduling.channelId')}}</th><th>{{t('scheduling.origin')}}</th><th>{{t('scheduling.enabled')}}</th><th>{{t('scheduling.status')}}</th><th>{{t('scheduling.keyStatus')}}</th><th>{{t('scheduling.safeReasons')}}</th><th>{{t('scheduling.version')}}</th><th>{{t('scheduling.actions')}}</th></tr></thead>
      <tbody><tr v-for="row in scheduling.channels" :key="row.id" :data-testid="`channel-row-${row.id}`"><th :title="row.name">{{row.name}}</th><td>{{row.id}}</td><td>{{row.origin??t('scheduling.originUnavailable')}}</td><td>{{t(row.enabled?'scheduling.on':'scheduling.off')}}</td><td>{{t(`scheduling.channelStatuses.${row.status}`)}}</td><td>{{t(`scheduling.keyStates.${row.keyState}`)}}</td><td class="reasons"><ul v-if="row.reasonCodes.length"><li v-for="reason in row.reasonCodes" :key="reason">{{t(`scheduling.channelReasons.${reason}`)}} ({{reason}})</li></ul><span v-else>{{t('scheduling.noSafeReasons')}}</span></td><td>{{row.version}}</td><td><button type="button" :disabled="scheduling.busy" :data-testid="`channel-edit-${row.id}`" @click="scheduling.editChannel(row)">{{t('scheduling.edit')}}</button><button type="button" :disabled="scheduling.busy" :data-testid="`channel-delete-${row.id}`" @click="scheduling.deleteChannelTarget=row">{{t('scheduling.delete')}}</button></td></tr></tbody>
    </table><p v-if="!scheduling.channels.length">{{t('scheduling.noChannels')}}</p></div>
    <button v-if="scheduling.channelsReady" type="button" data-testid="channel-create" :disabled="scheduling.busy" @click="scheduling.editChannel()">{{t('scheduling.createChannel')}}</button>
    <form v-if="scheduling.channelDraft" @submit.prevent="scheduling.saveChannel(workspaceId)">
      <h3>{{t(scheduling.channelDraft.id?'scheduling.edit':'scheduling.createChannel')}}</h3>
      <label>{{t('scheduling.name')}}<input v-model="scheduling.channelDraft.name" :disabled="scheduling.busy" data-testid="channel-name" maxlength="128" /></label>
      <label>{{t('scheduling.channelUrl')}}<input v-model="scheduling.channelDraft.url" :disabled="scheduling.busy" data-testid="channel-url" autocomplete="off" :placeholder="t('scheduling.writeOnly')" /></label>
      <label>{{t('scheduling.channelSecret')}}<input v-model="scheduling.channelDraft.hmacSecret" :disabled="scheduling.busy" data-testid="channel-secret" type="password" autocomplete="new-password" :placeholder="t('scheduling.writeOnly')" /></label>
      <label><input v-model="scheduling.channelDraft.enabled" :disabled="scheduling.busy" data-testid="channel-enabled" type="checkbox" />{{t('scheduling.enabled')}}</label><p>{{t('scheduling.channelWriteHelp')}}</p>
      <label v-if="scheduling.channelDraft.id"><input v-model="scheduling.channelDraft.rotationConfirmed" :disabled="scheduling.busy" data-testid="channel-rotation-confirm" type="checkbox" />{{t('scheduling.rotationConfirm')}}</label>
      <fieldset><legend>{{t('scheduling.durations')}}</legend><label v-for="key in durationFields" :key="key">{{t(`scheduling.fields.${key}`)}} ({{t('scheduling.units.seconds')}})<input v-model="scheduling.channelDraft.limits[key]" :disabled="scheduling.busy" :data-testid="`channel-limit-${key}`" inputmode="decimal" /></label></fieldset>
      <fieldset><legend>{{t('scheduling.budgets')}}</legend><label v-for="key in budgetFields" :key="key">{{t(`scheduling.fields.${key}`)}} ({{t(`scheduling.units.${key.endsWith('Bytes')?'kib':key.endsWith('Ratio')?'percent':'count'}`)}})<input v-model="scheduling.channelDraft.limits[key]" :disabled="scheduling.busy" :data-testid="`channel-limit-${key}`" inputmode="decimal" /></label></fieldset>
      <p>{{t('scheduling.deliveryApplies')}}</p><button type="submit" data-testid="channel-save" :disabled="scheduling.busy||scheduling.conflict">{{t('scheduling.save')}}</button><button type="button" :disabled="scheduling.busy" @click="scheduling.channelDraft=null">{{t('scheduling.cancel')}}</button>
    </form>
    <div v-if="scheduling.deleteChannelTarget" role="dialog" :aria-label="t('scheduling.delete')"><p>{{t('scheduling.deleteChannelHelp',{name:scheduling.deleteChannelTarget.name})}}</p><button type="button" data-testid="channel-delete-confirm" :disabled="scheduling.busy||scheduling.conflict" @click="scheduling.deleteChannel(workspaceId)">{{t('scheduling.delete')}}</button><button type="button" @click="scheduling.deleteChannelTarget=null">{{t('scheduling.cancel')}}</button></div>
  </section>
</template>
<style scoped>
.channels{min-width:0}.table-scroll{max-width:100%;overflow-x:auto}table{min-width:950px;width:100%;border-collapse:collapse}th,td{text-align:left;white-space:nowrap;padding:10px 12px;border-bottom:1px solid #eee}th:first-child{max-width:260px;overflow:hidden;text-overflow:ellipsis}p{overflow-wrap:anywhere}
form{margin-top:20px;padding:16px;border:1px solid #ddd;border-radius:8px}label{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:10px 0}input:not([type=checkbox]){min-width:160px;max-width:100%;padding:6px}fieldset{margin:12px 0;border:1px solid #ddd}button{margin:4px}
.reasons{white-space:normal;min-width:280px;max-width:420px}.reasons ul{padding-left:16px;margin:0}
</style>

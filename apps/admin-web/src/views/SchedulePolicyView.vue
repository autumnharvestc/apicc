<script setup lang="ts">
import { watch,onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import type { SchedulingStore } from '../stores/scheduling.js';
const props=withDefaults(defineProps<{scheduling:SchedulingStore;workspaceId?:string;projectId?:string;platform?:boolean}>(),{workspaceId:'',platform:false});
const {t}=useI18n();
watch(()=>[props.workspaceId,props.projectId,props.platform],()=>void (props.platform?props.scheduling.loadControl():props.scheduling.loadPolicy(props.workspaceId,props.projectId)),{immediate:true});
onBeforeUnmount(()=>props.scheduling.reset());
const groups=[{name:'durations',keys:['minIntervalMs','lateToleranceMs','catchupWindowMs','queueTimeoutMs','maxQueueTimeoutMs']},{name:'counts',keys:['maxSchedules','maxPendingDeliveries']},{name:'retention',keys:['historyRetentionDays','notificationRetentionDays']},{name:'behavior',keys:['misfire','overlap']}] as const;
function range(key:string){return key.endsWith('Days')?'1–3650':key==='lateToleranceMs'?'1–300':key.endsWith('Ms')?'1–86400':'1–100000';}
function value(key:string,input:unknown){if(input===undefined)return t('scheduling.inherited');if(typeof input==='string')return t(`scheduling.values.${input}`);return `${Number(input)/(key.endsWith('Ms')?1000:1)} ${t(`scheduling.units.${key.endsWith('Ms')?'seconds':key.endsWith('Days')?'days':'count'}`)}`;}
function edit(key:string,event:Event){props.scheduling.policyDraft[key]=(event.target as HTMLInputElement).value;props.scheduling.resetKeys=props.scheduling.resetKeys.filter(item=>item!==key);}
</script>
<template>
  <section class="schedule-policy" data-testid="schedule-policy-view">
    <h2>{{t(platform?'scheduling.controlTitle':'scheduling.policyTitle')}}</h2>
    <p v-if="scheduling.error" role="alert">{{t('scheduling.errors.'+(['forbidden','project_forbidden','version_conflict','validation_failed','unauthorized'].includes(scheduling.error)?scheduling.error:'other'))}} ({{scheduling.error}})<span v-for="field in scheduling.errorFields" :key="field"> · {{t(`scheduling.fields.${field}`)}}: {{t('scheduling.validationHelp')}}</span></p>
    <button v-if="scheduling.conflict&&!platform" type="button" data-testid="policy-reload" @click="scheduling.loadPolicy(workspaceId,projectId,true)">{{t('scheduling.reload')}}</button><button v-if="scheduling.conflict&&platform" type="button" data-testid="control-reload" @click="scheduling.loadControl(true)">{{t('scheduling.reload')}}</button>
    <template v-if="platform&&scheduling.control">
      <p>{{t(`scheduling.modes.${scheduling.control.mode}`)}} · {{t('scheduling.generation')}} {{scheduling.control.generation}} · {{t('scheduling.version')}} {{scheduling.control.version}}</p><p>{{t('scheduling.controlHelp')}}</p>
      <label>{{t('scheduling.controlMode')}}<select v-model="scheduling.controlModeDraft" data-testid="control-mode"><option value="embedded">{{t('scheduling.modes.embedded')}}</option><option value="disabled">{{t('scheduling.modes.disabled')}}</option></select></label><button type="button" data-testid="control-save" :disabled="scheduling.busy||scheduling.conflict" @click="scheduling.saveControl()">{{t('scheduling.save')}}</button>
    </template>
    <template v-if="!platform&&scheduling.policy">
      <p>{{t('scheduling.version')}}: {{scheduling.policy.version}} · {{t('scheduling.workspace')}} {{scheduling.policy.versions.workspace}} · {{t('scheduling.project')}} {{scheduling.policy.versions.project}}</p>
      <p>{{t('scheduling.applies')}}</p>
      <div class="table-scroll"><table>
        <thead><tr><th>{{t('scheduling.parameter')}}</th><th>{{t('scheduling.default')}}</th><th>{{t('scheduling.workspaceExplicit')}}</th><th>{{t('scheduling.projectExplicit')}}</th><th>{{t('scheduling.effective')}}</th><th>{{t('scheduling.source')}}</th><th>{{t('scheduling.draft')}}</th><th>{{t('scheduling.whenApplies')}}</th></tr></thead>
        <tbody v-for="group in groups" :key="group.name"><tr class="group-heading"><th colspan="8">{{t(`scheduling.groups.${group.name}`)}}</th></tr><tr v-for="key in group.keys" :key="key" :data-testid="`policy-row-${key}`">
          <th>{{t(`scheduling.fields.${key}`)}}<small v-if="key!=='misfire'&&key!=='overlap'">{{range(key)}} {{t(`scheduling.units.${key.endsWith('Ms')?'seconds':key.endsWith('Days')?'days':'count'}`)}}</small></th><td>{{value(key,scheduling.policy.default[key])}}</td><td>{{value(key,scheduling.policy.explicitByScope.workspace[key])}}</td><td>{{value(key,scheduling.policy.explicitByScope.project[key])}}</td><td>{{value(key,scheduling.policy.effective[key])}}</td><td>{{t(`scheduling.${scheduling.policy.source[key]}`)}}</td>
          <td>
            <select v-if="key==='misfire'||key==='overlap'" :disabled="scheduling.busy" :aria-label="t(`scheduling.fields.${key}`)" :data-testid="`policy-input-${key}`" :value="scheduling.policyDraft[key]??''" @change="edit(key,$event)"><option value="">{{t('scheduling.keep')}}</option><option v-for="option in key==='misfire'?['skip','catch-up-one']:['skip','queue-one']" :key="option" :value="option">{{t(`scheduling.values.${option}`)}}</option></select>
            <input v-else type="text" inputmode="decimal" :disabled="scheduling.busy" :aria-label="t(`scheduling.fields.${key}`)" :data-testid="`policy-input-${key}`" :value="scheduling.policyDraft[key]??''" :placeholder="t('scheduling.keep')" @input="edit(key,$event)" />
            <button type="button" :disabled="scheduling.busy" :data-testid="`policy-reset-${key}`" @click="scheduling.inherit(key)">{{t('scheduling.inherited')}}</button><span v-if="scheduling.resetKeys.includes(key)">{{t('scheduling.pendingReset')}}</span>
          </td>
          <td class="timing">{{t(`scheduling.appliesByField.${key}`)}}</td>
        </tr></tbody>
      </table></div>
      <p>{{t('scheduling.emptyHelp')}}</p><button type="button" data-testid="policy-save" :disabled="scheduling.busy||scheduling.conflict" @click="scheduling.savePolicy(workspaceId,projectId)">{{t('scheduling.save')}}</button>
    </template>
  </section>
</template>
<style scoped>
.schedule-policy{min-width:0}.table-scroll{max-width:100%;overflow-x:auto}table{border-collapse:collapse;min-width:900px;width:100%}th,td{padding:10px 12px;border-bottom:1px solid #eee;text-align:left;white-space:nowrap}p{overflow-wrap:anywhere}
small{display:block;font-weight:400;color:#666}.group-heading{background:#f5f7fa}.timing{min-width:240px;max-width:360px;white-space:normal}input{width:120px;padding:5px}button{margin:4px}
</style>

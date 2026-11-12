<script setup lang="ts">
import type { CollaborationPolicy } from '@apicc/execution/client/collaboration';
import {useI18n} from 'vue-i18n';
const props=defineProps<{policy:CollaborationPolicy;draft:Record<string,unknown>}>();
const {t}=useI18n();
const readOnly=new Set(['deploymentMaxStorageBytes','deploymentPublicReadRps','deploymentPublicReadInFlight','deploymentMockRps','deploymentMockInFlight','deploymentMaxActiveGrants','maxPreviewsGlobal','rpcConnectTimeoutMs','rpcCallTimeoutMs','rpcMaxMessageBytes','nodeCacheBytes']);
function value(v:unknown):string{return v===null?t('collaboration.inherit'):typeof v==='boolean'?t(v?'collaboration.on':'collaboration.off'):Array.isArray(v)?v.join(' · ')||t('collaboration.empty'):String(v);}
function list(code:string,local:unknown){return (props.draft[code]??local??[]) as string[];}
function item(code:string,local:unknown,index:number,event:Event){const next=[...list(code,local)];next[index]=(event.target as HTMLInputElement).value;props.draft[code]=next;}
function input(code:string,event:Event){props.draft[code]=(event.target as HTMLInputElement).valueAsNumber;}
function linked(code:string){return props.policy.settings.find(row=>row.code===(code==='defaultShareDurationMs'?'maxShareDurationMs':'maxPageSize'))?.effective;}
</script>
<template>
  <div class="table-scroll" data-testid="collaboration-policy-scroll"><table>
    <thead><tr><th>{{t('collaboration.parameter')}}</th><th>{{t('collaboration.default')}}</th><th>{{t('collaboration.local')}}</th><th>{{t('collaboration.effective')}}</th><th>{{t('collaboration.source')}}</th><th>{{t('collaboration.range')}}</th><th>{{t('collaboration.draft')}}</th><th>{{t('collaboration.effect')}}</th></tr></thead>
    <tbody><tr v-for="row in policy.settings" :key="row.code" :data-testid="`collaboration-setting-${row.code}`">
      <th>{{t(`collaboration.fields.${row.code}`)}}<small>{{t(`collaboration.units.${row.unit}`)}}</small></th>
      <td>{{value(row.builtin)}}</td><td>{{value(row.local)}}</td><td><ul v-if="Array.isArray(row.effective)"><li v-for="entry in row.effective" :key="entry">{{entry}}</li></ul><span v-else>{{value(row.effective)}}</span></td><td>{{t(`collaboration.sources.${row.source}`)}}</td>
      <td><template v-if="row.valueType==='integer'||row.valueType==='decimal'">{{row.minimum}}–{{row.maximum}} {{t(`collaboration.units.${row.unit}`)}}<small v-if="row.code==='defaultShareDurationMs'||row.code==='defaultPageSize'">{{t('collaboration.currentCeiling')}}: {{linked(row.code)}} {{t(`collaboration.units.${row.unit}`)}}</small></template><template v-else-if="row.valueType==='string-list'">{{row.maxItems}} {{t('collaboration.units.items')}} · {{row.maxItemCodePoints}} {{t('collaboration.characters')}}</template><span v-else>{{t('collaboration.booleanRange')}}</span></td>
      <td>
        <template v-if="row.valueType==='string-list'">
          <ul class="list-editor"><li v-for="(entry,index) in list(row.code,row.local)" :key="index"><input :value="entry" :aria-label="t(`collaboration.fields.${row.code}`)" :data-testid="`collaboration-list-${row.code}-${index}`" @input="item(row.code,row.local,index,$event)"/><button @click="draft[row.code]=list(row.code,row.local).filter((_,i)=>i!==index)">{{t('collaboration.remove')}}</button></li></ul><button :data-testid="`collaboration-list-add-${row.code}`" @click="draft[row.code]=[...list(row.code,row.local),'']">{{t('collaboration.addEntry')}}</button>
        </template>
        <select v-else-if="row.valueType==='boolean'" :value="draft[row.code]===undefined?'keep':draft[row.code]===null?'inherit':String(draft[row.code])" :data-testid="`collaboration-input-${row.code}`" :aria-label="t(`collaboration.fields.${row.code}`)" @change="draft[row.code]=($event.target as HTMLSelectElement).value==='inherit'?null:($event.target as HTMLSelectElement).value==='keep'?undefined:($event.target as HTMLSelectElement).value==='true'"><option value="keep">{{t('collaboration.keep')}}</option><option value="inherit">{{t('collaboration.inherit')}}</option><option value="true">{{t('collaboration.on')}}</option><option value="false">{{t('collaboration.off')}}</option></select>
        <input v-else type="number" :disabled="readOnly.has(row.code)" :value="draft[row.code]===undefined?row.local:draft[row.code]" :min="row.minimum??undefined" :max="row.maximum??undefined" :aria-label="t(`collaboration.fields.${row.code}`)" :data-testid="`collaboration-input-${row.code}`" @input="input(row.code,$event)"/>
        <button v-if="!readOnly.has(row.code)" :data-testid="`collaboration-inherit-${row.code}`" @click="draft[row.code]=null">{{t('collaboration.inherit')}}</button><small v-else>{{t('collaboration.deploymentOnly')}}</small>
        <small v-if="draft[row.code]!==undefined">{{t('collaboration.pendingValue')}}: {{value(draft[row.code])}}</small>
      </td><td class="effect">{{t(`collaboration.effects.${row.effect}`)}}</td>
    </tr></tbody>
  </table></div>
  <p>{{t('collaboration.consentHint')}}</p><p>{{t('collaboration.corsHint')}}</p><p>{{t('collaboration.tighteningHint')}}</p>
</template>
<style scoped>
.table-scroll{max-width:100%;overflow:auto}table{border-collapse:collapse;width:100%;min-width:1180px}th,td{padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:left;vertical-align:top;white-space:nowrap}th{min-width:150px}small{display:block;font-weight:400;color:#595959;margin-top:5px}.effect{min-width:220px;max-width:320px;white-space:normal}td ul{margin:0;padding-left:18px;max-width:300px;white-space:normal;overflow-wrap:anywhere}.list-editor{list-style:none;padding:0}input{width:145px}button{margin:4px}p{overflow-wrap:anywhere}
</style>

<style scoped src="../styles/admin-controls.css"></style>

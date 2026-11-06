<script setup lang="ts">
import {useI18n} from 'vue-i18n';
import {defaultSyncPolicyValues,SyncPolicyValuesSchema} from '@apicc/execution/contract';
import type {SyncPolicyView,SyncPolicyField} from '../api/synchronization.js';
const props=defineProps<{view:SyncPolicyView;draft:Partial<Record<SyncPolicyField,string>>;reset:SyncPolicyField[];editable:boolean;locked:boolean}>();
const emit=defineEmits<{edit:[key:SyncPolicyField,value:string];inherit:[key:SyncPolicyField]}>();
const {t}=useI18n();
const fields=Object.keys(defaultSyncPolicyValues) as SyncPolicyField[];
function scale(key:SyncPolicyField){return props.view.units[key]==='milliseconds'?1000:props.view.units[key]==='bytes'?1048576:1;}
function unit(key:SyncPolicyField){return t(`sync.units.${props.view.units[key]}`);}
function value(key:SyncPolicyField,n:number|undefined){return n===undefined?t('sync.inherit'):`${n/scale(key)} ${unit(key)}`;}
function range(key:SyncPolicyField){const schema=SyncPolicyValuesSchema.shape[key];return `${schema.minValue!/scale(key)}–${schema.maxValue!/scale(key)} ${unit(key)}`;}
</script>
<template><div class="table-scroll"><table><thead><tr><th>{{t('sync.parameter')}}</th><th>{{t('sync.default')}}</th><th>{{t('sync.saved')}}</th><th>{{t('sync.parent')}}</th><th>{{t('sync.effective')}}</th><th>{{t('sync.source')}}</th><th>{{t('sync.range')}}</th><th>{{t('sync.ceiling')}}</th><th v-if="editable">{{t('sync.draft')}}</th></tr></thead><tbody><tr v-for="key in fields" :key="key" :data-testid="`sync-row-${key}`">
  <th>{{t(`sync.fields.${key}`)}}</th><td>{{value(key,defaultSyncPolicyValues[key])}}</td><td>{{view.saved[key]===undefined?t('sync.inherit'):`${t('sync.explicit')}: ${value(key,view.saved[key])}`}}</td><td>{{view.inherited===null?t('sync.notApplicable'):value(key,view.inherited[key])}}</td><td>{{view.effective?value(key,view.effective.policy[key]):t('sync.noEffective')}}</td><td>{{view.effective?t(`sync.sources.${view.effective.sources[key]}`):t('sync.invalidState')}}</td><td>{{range(key)}}</td><td>{{view.deploymentCeilings[key]===undefined?t('sync.notConfigured'):value(key,view.deploymentCeilings[key])}}</td>
  <td v-if="editable"><label><span class="sr-only">{{t(`sync.fields.${key}`)}} ({{unit(key)}})</span><input type="text" inputmode="decimal" :aria-label="`${t(`sync.fields.${key}`)} (${unit(key)})`" :data-testid="`sync-input-${key}`" :value="draft[key]??''" :placeholder="t('sync.keep')" :disabled="locked" @input="emit('edit',key,($event.target as HTMLInputElement).value)" /></label><button type="button" :data-testid="`sync-inherit-${key}`" :disabled="locked" @click="emit('inherit',key)">{{t('sync.inheritAction')}}</button><span v-if="reset.includes(key)">{{t('sync.pendingReset')}}</span></td>
</tr></tbody></table></div></template>
<style scoped>.table-scroll{max-width:100%;max-height:65vh;overflow:auto}table{width:100%;min-width:1500px;border-collapse:collapse}th,td{padding:10px 12px;border-bottom:1px solid #ddd;text-align:left;white-space:nowrap}thead{position:sticky;top:0;background:#fff}input{width:100px;padding:5px}button{margin:4px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style>

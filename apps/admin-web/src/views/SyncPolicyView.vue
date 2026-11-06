<script setup lang="ts">
import {ref,computed,watch,onBeforeUnmount} from 'vue';
import {useI18n} from 'vue-i18n';
import {SyncPolicySchema,SyncPolicySaveInputSchema,type SyncPolicySaveInput} from '@apicc/execution/contract';
import type {AdminClient} from '../api/client.js';
import {createCollaborationApi,type AccessScope} from '../api/collaboration.js';
import {createSynchronizationApi,type SyncPolicyView,type SyncPolicyField} from '../api/synchronization.js';
import SyncPolicyFields from '../components/SyncPolicyFields.vue';
const props=defineProps<{client:AdminClient;workspaceId:string;projectId?:string}>();
const {t,te}=useI18n();const api=createSynchronizationApi(props.client),accessApi=createCollaborationApi(props.client);
const view=ref<SyncPolicyView|null>(null),editable=ref(false),busy=ref(false),loading=ref(false),conflict=ref(false),error=ref('');
const draft=ref<Partial<Record<SyncPolicyField,string>>>({}),reset=ref<SyncPolicyField[]>([]);
type PolicyAttempt=object;
type PolicyOperation={input:SyncPolicySaveInput;latest:PolicyAttempt;active:Set<PolicyAttempt>;uncertain:boolean;confirmation:SyncPolicyView|null};
const pending=ref<SyncPolicySaveInput|null>(null),pendingByScope=new Map<string,PolicyOperation>(),reloadRequired=ref(false),pendingConfirmed=ref(false),confirmedReload=ref(false);let generation=0,authorityEpoch=0,loadSequence=0;
const key=()=>`${props.workspaceId}/${props.projectId??''}`;
const scope=():AccessScope=>({workspaceId:props.workspaceId,...(props.projectId?{projectId:props.projectId}:{})});
const locked=computed(()=>busy.value||loading.value||conflict.value||reloadRequired.value||pending.value!==null);
const errorText=computed(()=>te(`sync.errors.${error.value}`)?t(`sync.errors.${error.value}`):t('sync.errors.other'));
function invalidateAuthority(){authorityEpoch++;view.value=null;editable.value=false;reloadRequired.value=true;}
function fail(e:unknown){const code=typeof e==='object'&&e!==null&&'code'in e?String(e.code):'other';error.value=code;if(code==='SYNC_POLICY_REVISION_CHANGED')conflict.value=true;if(['forbidden','project_forbidden','unauthorized'].includes(code))invalidateAuthority();}
async function load(keepDraft=false){
  invalidateAuthority();const g=generation,s=scope(),epoch=authorityEpoch,sequence=++loadSequence;loading.value=true;error.value='';
  const current=()=>g===generation&&epoch===authorityEpoch&&sequence===loadSequence;
  try{
    let canEdit=false;
    if(s.projectId){const access=await accessApi.access(s);if(!current())return;if(!access.accountEnabled||!access.member||access.effectiveRole===null){error.value='contentUnreadable';return;}canEdit=access.capabilities.includes('sync.manage');}
    else {try{const access=await accessApi.accessPolicy(s);if(!current())return;canEdit=access.capabilities.some(row=>row.code==='sync.manage'&&row.effective);}catch{if(!current())return;}}
    const value=await api.policy(s);if(!current())return;view.value=value;editable.value=canEdit;conflict.value=false;reloadRequired.value=false;confirmedReload.value=false;if(!keepDraft){draft.value={};reset.value=[];}
  }catch(e){if(current())fail(e);}finally{if(g===generation&&sequence===loadSequence)loading.value=false;}
}
function edit(field:SyncPolicyField,value:string){if(locked.value)return;draft.value[field]=value;reset.value=reset.value.filter(k=>k!==field);}
function inherit(field:SyncPolicyField){if(locked.value)return;delete draft.value[field];if(!reset.value.includes(field))reset.value.push(field);}
async function send(input:SyncPolicySaveInput){
  if(busy.value||loading.value||!editable.value)return;const g=generation,s=scope(),k=key(),epoch=authorityEpoch,attempt:PolicyAttempt={};
  const operation=pendingByScope.get(k)??{input,latest:attempt,active:new Set<PolicyAttempt>(),uncertain:false,confirmation:null};operation.latest=attempt;operation.active.add(attempt);pendingByScope.set(k,operation);busy.value=true;error.value='';pending.value=operation.input;pendingConfirmed.value=operation.confirmation!==null;
  // Operation truth survives display scopes. A rejection proves only that one
  // attempt did not commit; all outstanding and unknown attempts still matter.
  const currentDisplay=()=>g===generation&&epoch===authorityEpoch&&operation.latest===attempt;
  const settle=(result:'success'|'rejected'|'unknown',value?:SyncPolicyView)=>{
    if(pendingByScope.get(k)!==operation||!operation.active.delete(attempt))return false;
    if(result==='unknown')operation.uncertain=true;if(value)operation.confirmation=value;
    const complete=operation.active.size===0&&(operation.confirmation!==null||!operation.uncertain);
    if(complete)pendingByScope.delete(k);
    if(key()===k){pending.value=pendingByScope.get(k)?.input??null;pendingConfirmed.value=!complete&&operation.confirmation!==null;if(operation.confirmation&&error.value==='unknown')error.value='';if(operation.latest===attempt||operation.active.size===0)busy.value=false;}
    return complete;
  };
  const confirmForReload=(complete:boolean)=>{if(complete&&operation.confirmation&&key()===k){confirmedReload.value=true;reloadRequired.value=true;if(error.value==='unknown')error.value='';}};
  try{const value=await api.savePolicy(s,operation.input);const complete=settle('success',value);if(!currentDisplay()){confirmForReload(complete);return;}view.value=value;draft.value={};reset.value=[];}
  catch(e){
    const code=typeof e==='object'&&e!==null&&'code'in e?String(e.code):'other';
    // Only a finite server rejection establishes that this policy was not committed.
    const rejected=['SYNC_POLICY_INVALID','SYNC_POLICY_REVISION_CHANGED','forbidden','project_forbidden','unauthorized','validation_failed'].includes(code);
    const complete=settle(rejected?'rejected':'unknown');
    if(currentDisplay()){if(rejected)fail(e);else if(!operation.confirmation)error.value='unknown';}
    confirmForReload(complete);
  }
}
async function save(){
  if(!view.value||!editable.value||locked.value)return;
  const saved={...view.value.saved,revision:(BigInt(view.value.saved.revision)+1n).toString()};
  for(const field of reset.value)delete saved[field];
  for(const [field,text] of Object.entries(draft.value) as [SyncPolicyField,string][]){if(text.trim()==='')continue;const scale=view.value.units[field]==='milliseconds'?1000:view.value.units[field]==='bytes'?1048576:1;const n=Number(text)*scale;if(!Number.isSafeInteger(n)){error.value='number';return;}saved[field]=n;}
  const valid=SyncPolicySchema.safeParse(saved);if(!valid.success){error.value='number';return;}
  const input=SyncPolicySaveInputSchema.parse({formatVersion:1,intentId:crypto.randomUUID(),expectedRevision:view.value.saved.revision,policy:valid.data});await send(input);
}
watch(()=>[props.workspaceId,props.projectId],()=>{generation++;view.value=null;editable.value=false;busy.value=false;loading.value=false;conflict.value=false;error.value='';draft.value={};reset.value=[];pending.value=pendingByScope.get(key())?.input??null;pendingConfirmed.value=pendingByScope.get(key())?.confirmation!=null;confirmedReload.value=false;void load();},{immediate:true,flush:'sync'});
onBeforeUnmount(()=>{generation++;});
</script>
<template><section class="sync-policy" data-testid="sync-policy-view"><h2>{{t('sync.policyTitle')}}</h2><p>{{t('sync.clientEditor')}}</p><p v-if="loading">{{t('sync.loading')}}</p><p v-if="error" role="alert">{{errorText}}<span v-if="error!=='unknown'"> ({{error}})</span></p>
  <p v-if="pending&&(pendingConfirmed||!busy)" role="status">{{t(pendingConfirmed?'sync.confirmedWaiting':'sync.errors.unknown')}}</p><p v-if="confirmedReload" role="status">{{t('sync.confirmedReload')}}</p><button v-if="pending&&!busy&&editable" type="button" data-testid="sync-policy-retry" @click="send(pending)">{{t('sync.retryOriginal')}}</button>
  <button v-if="conflict||reloadRequired||(pending&&!busy)" type="button" data-testid="sync-policy-reload" :disabled="loading||busy" @click="load(true)">{{t('sync.reload')}}</button>
  <template v-if="view"><p>{{t('sync.version')}} {{view.saved.revision}} · {{t('sync.workspaceRevision')}} {{view.workspaceRevision}} · {{t(`sync.sources.${view.saved.scope}`)}}</p><p>{{t('sync.nextCheck')}}</p><p v-if="view.status==='invalid'" role="alert">{{t('sync.errors.SYNC_POLICY_INVALID')}} ({{view.reasonCode}})</p>
    <p>{{t('sync.deploymentReadOnly')}} · {{t('sync.wire')}}: {{view.deploymentLimits.maxWireBytes/1048576}} MiB · {{t('sync.reserve')}}: {{view.deploymentLimits.envelopeReserveBytes/1048576}} MiB</p>
    <SyncPolicyFields :view="view" :draft="draft" :reset="reset" :editable="editable" :locked="locked" @edit="edit" @inherit="inherit" />
    <p>{{t('sync.retentionHint')}}</p><p>{{t('sync.draftHint')}}</p><p v-if="!editable">{{t('sync.readOnly')}}</p><button v-if="editable" type="button" data-testid="sync-policy-save" :disabled="locked" @click="save">{{t('sync.save')}}</button>
  </template>
</section></template>
<style scoped>.sync-policy{min-width:0}p{overflow-wrap:anywhere}button{margin:5px;padding:6px 12px}</style>

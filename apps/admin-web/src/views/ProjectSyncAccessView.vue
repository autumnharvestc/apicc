<script setup lang="ts">
import {ref,computed,watch,onBeforeUnmount} from 'vue';
import {useI18n} from 'vue-i18n';
import type {SyncSource,SyncCheckLookup} from '@apicc/execution/contract';
import type {AdminClient} from '../api/client.js';
import {createCollaborationApi,type AccessScope,type AccessPolicy,type CapabilityMode,type ManagementProject} from '../api/collaboration.js';
import {createSynchronizationApi} from '../api/synchronization.js';
import CollaborationAccessTable from '../components/CollaborationAccessTable.vue';
const props=defineProps<{client:AdminClient;workspaceId:string;projectId?:string}>();
const {t,te}=useI18n();const sync=createSynchronizationApi(props.client),api=createCollaborationApi(props.client);
const finiteCodes=['sync.manage','sync.check','sync.apply'] as const;
const access=ref<Awaited<ReturnType<typeof api.access>>|null>(null),policy=ref<AccessPolicy|null>(null),directory=ref<ManagementProject[]>([]);
const sources=ref<SyncSource[]>([]),materials=ref<Awaited<ReturnType<typeof sync.materials>>>([]),checks=ref<Record<string,SyncCheckLookup>>({});
const audit=ref<Awaited<ReturnType<typeof api.audit>>|null>(null),draft=ref<Record<string,CapabilityMode>>({});
const errors=ref<Record<string,string>>({}),busy=ref(false),conflict=ref(false),uncertain=ref(false);let generation=0,auditGeneration=0;
const policyLoading=ref(false),policyNeedsReload=ref(false);let policyReadSequence=0;
const scope=():AccessScope=>({workspaceId:props.workspaceId,...(props.projectId?{projectId:props.projectId}:{})});
const readable=computed(()=>access.value?.accountEnabled===true&&access.value.member&&access.value.effectiveRole!==null);
const rows=computed(()=>policy.value?.capabilities.filter(row=>finiteCodes.some(code=>code===row.code))??[]);
const auditRows=computed(()=>audit.value?.execution.filter(row=>row.action.startsWith('sync.'))??[]);
const selectedProject=computed(()=>directory.value.find(p=>p.id===props.projectId));
const base=computed(()=>`/workspaces/${encodeURIComponent(props.workspaceId)}`);
function errorCode(e:unknown){return typeof e==='object'&&e!==null&&'code'in e?String(e.code):'other';}
function errorLabel(code:string){return te(`sync.errors.${code}`)?t(`sync.errors.${code}`):code==='access_revision_conflict'?t('syncStatus.conflict'):t('sync.errors.other');}
function reason(code:string|null|undefined){if(!code)return t('syncStatus.notCollected');const key=`syncStatus.reasons.${code}`;return `${te(key)?t(key):t('syncStatus.otherReason')} (${code})`;}
function time(value:string|number|null){return value===null?t('syncStatus.notCollected'):new Date(value).toISOString().replace('T',' ').replace('Z',' UTC');}
function action(code:string){const key=`syncStatus.actions.${code.replaceAll('.','_')}`;return te(key)?t(key):`${t('syncStatus.otherAction')} (${code})`;}
function references(source:SyncSource){return ['authRef','privateKeyRef','knownHostsRef','passphraseRef','networkProfileRef'].flatMap(field=>{const value=Reflect.get(source,field);return typeof value==='string'?[`${t(`syncStatus.materialRoles.${field}`)}: ${value}`]:[];});}
async function readAudit(cursor?:string){
  if(!readable.value||!access.value?.capabilities.includes('audit.read'))return;
  const g=generation,a=++auditGeneration,s=scope();try{const value=await api.audit(s,{limit:50,...(cursor?{cursor}:{})});if(g===generation&&a===auditGeneration){audit.value=value;delete errors.value.audit;}}catch(e){if(g===generation&&a===auditGeneration)errors.value.audit=errorCode(e);}
}
function invalidatePolicy(){policyReadSequence++;policy.value=null;policyNeedsReload.value=true;}
async function loadPolicy(){invalidatePolicy();const g=generation,s=scope(),sequence=policyReadSequence;policyLoading.value=true;try{const value=await api.accessPolicy(s);if(g!==generation||sequence!==policyReadSequence)return;policy.value=value;conflict.value=false;uncertain.value=false;policyNeedsReload.value=false;delete errors.value.access;}catch(e){if(g===generation&&sequence===policyReadSequence)errors.value.access=errorCode(e);}finally{if(g===generation&&sequence===policyReadSequence)policyLoading.value=false;}}
async function savePolicy(){
  if(!policy.value||busy.value||policyLoading.value||conflict.value||uncertain.value||Object.keys(draft.value).length===0)return;
  const g=generation,s=scope(),patch={...draft.value};busy.value=true;delete errors.value.access;
  try{const value=await api.putAccessPolicy(s,{expectedRevision:policy.value.revision,defaults:patch});if(g!==generation)return;policy.value=value;draft.value={};if(s.projectId){access.value=null;try{const current=await api.access(s);if(g===generation)access.value=current;}catch(e){if(g===generation)errors.value.content=errorCode(e);}}}
  catch(e){if(g!==generation)return;const code=errorCode(e);errors.value.access=code;conflict.value=code==='access_revision_conflict';uncertain.value=!['access_revision_conflict','forbidden','unauthorized','validation_failed','project_forbidden'].includes(code);if(['forbidden','project_forbidden','unauthorized'].includes(code))invalidatePolicy();}
  finally{if(g===generation)busy.value=false;}
}
async function loadContent(g:number,s:AccessScope){
  const safe=async<T>(key:string,read:()=>Promise<T>,assign:(value:T)=>void|Promise<void>)=>{try{const value=await read();if(g===generation)await assign(value);}catch(e){if(g===generation)errors.value[key]=errorCode(e);}};
  await Promise.all([
    safe('materials',()=>sync.materials(s),value=>{materials.value=value;}),
    safe('sources',()=>sync.sources(s),async(value:SyncSource[])=>{sources.value=value;await Promise.all(value.map(source=>safe(`check-${source.id}`,()=>sync.checks(s,source.id),value=>{checks.value[source.id]=value;})));}),
    readAudit(),
  ]);
}
async function load(){
  const g=generation,s=scope();void loadPolicy();
  void (async()=>{try{const value=await api.directory(s.workspaceId);if(g===generation)directory.value=value;}catch(e){if(g===generation)errors.value.directory=errorCode(e);}})();
  if(!s.projectId)return;
  try{const value=await api.access(s);if(g!==generation)return;access.value=value;if(!readable.value){errors.value.content='contentUnreadable';return;}await loadContent(g,s);}catch(e){if(g===generation)errors.value.content=errorCode(e);}
}
watch(()=>[props.workspaceId,props.projectId],()=>{generation++;auditGeneration++;access.value=null;policy.value=null;directory.value=[];sources.value=[];materials.value=[];checks.value={};audit.value=null;draft.value={};errors.value={};busy.value=false;conflict.value=false;uncertain.value=false;policyLoading.value=false;policyNeedsReload.value=false;void load();},{immediate:true,flush:'sync'});
onBeforeUnmount(()=>{generation++;auditGeneration++;});
</script>
<template><section class="admin-page sync-access" data-testid="project-sync-access-view"><h2>{{t('sync.accessTitle')}}</h2><h3 v-if="selectedProject" class="project-name" :title="selectedProject.name">{{selectedProject.name}}</h3><p>{{t('sync.clientEditor')}}</p>
  <p v-for="(code,section) in errors" :key="section" role="alert">{{t('syncStatus.sections.'+(String(section).startsWith('check-')?'checks':section))}}: {{errorLabel(code)}} ({{code}})</p>
  <nav><a v-if="readable" data-testid="sync-policy-link" :href="`${base}/projects/${encodeURIComponent(projectId!)}/sync-policy`">{{t('sync.policyTitle')}}</a><template v-if="policy"><a :href="`${base}/${projectId?'acl':'members'}`">{{t('syncStatus.memberAccess')}}</a><span>{{t('syncStatus.currentRole')}}: {{access?.effectiveRole?t('scheduling.roles.'+access.effectiveRole):t('syncStatus.notApplicable')}}</span></template></nav>
  <section v-if="directory.length"><h3>{{t('syncStatus.directory')}}</h3><p>{{t('syncStatus.directoryHint')}}</p><div class="table-scroll"><table><thead><tr><th>{{t('syncStatus.project')}}</th><th>{{t('syncStatus.contentAccess')}}</th><th>{{t('syncStatus.open')}}</th></tr></thead><tbody><tr v-for="project in directory" :key="project.id"><th class="long-name" :title="project.name">{{project.name}}</th><td>{{t(project.contentReadable?'syncStatus.readable':'syncStatus.unreadable')}}</td><td><a :href="`${base}/projects/${encodeURIComponent(project.id)}/sync-access`">{{t('sync.accessTitle')}}</a></td></tr></tbody></table></div></section>
  <section v-if="policy"><h3>{{t('syncStatus.defaults')}}</h3><p>{{t('sync.version')}} {{policy.revision}} · {{t('syncStatus.defaultsHint')}}</p><CollaborationAccessTable :rows="rows" :draft="draft" :defaults="policy.defaults" :disabled="busy||policyLoading||conflict||uncertain" @save="savePolicy" /><p v-if="uncertain" role="status">{{t('syncStatus.unknownAccess')}}</p></section><button v-if="conflict||uncertain||policyNeedsReload" type="button" data-testid="sync-access-reload" :disabled="busy||policyLoading" @click="loadPolicy">{{t('sync.reload')}}</button>
  <template v-if="readable"><section><h3>{{t('syncStatus.materials')}}</h3><p>{{t('syncStatus.trustHint')}}</p><dl><dt>{{t('syncStatus.handshake')}}</dt><dd>{{t('syncStatus.notCollected')}}</dd><dt>{{t('syncStatus.hostTrust')}}</dt><dd>{{t('syncStatus.notCollected')}}</dd></dl><div class="table-scroll"><table><thead><tr><th>{{t('syncStatus.reference')}}</th><th>{{t('sync.version')}}</th><th>{{t('syncStatus.materialStatus')}}</th></tr></thead><tbody><tr v-for="material in materials" :key="material.refId"><th>{{material.refId}}</th><td>{{material.version}}</td><td>{{t(`syncStatus.materialStates.${material.status}`)}}</td></tr></tbody></table></div><p v-if="!materials.length&&!errors.materials">{{t('syncStatus.noMaterials')}}</p></section>
  <section><h3>{{t('syncStatus.sources')}}</h3><div class="table-scroll"><table><thead><tr><th>{{t('syncStatus.sourceIdentity')}}</th><th>{{t('syncStatus.sourceType')}}</th><th>{{t('sync.version')}}</th><th>{{t('syncStatus.references')}}</th></tr></thead><tbody><tr v-for="source in sources" :key="source.id"><th><code :title="source.id">{{source.id.slice(0,8)}}…</code><details><summary>{{t('syncStatus.fullIdentity')}}</summary><code>{{source.id}}</code></details></th><td>{{t(`syncStatus.sourceTypes.${source.kind}`)}}</td><td>{{source.revision}}</td><td><ul v-if="references(source).length"><li v-for="ref in references(source)" :key="ref">{{ref}}</li></ul><span v-else>{{t('syncStatus.noReferences')}}</span></td></tr></tbody></table></div><p v-if="!sources.length&&!errors.sources">{{t('syncStatus.noSources')}}</p></section>
  <section><h3>{{t('syncStatus.checks')}}</h3><p>{{t('syncStatus.checkHint')}}</p><div class="table-scroll"><table><thead><tr><th>{{t('syncStatus.sourceIdentity')}}</th><th>{{t('syncStatus.checkKind')}}</th><th>{{t('syncStatus.state')}}</th><th>{{t('syncStatus.created')}}</th><th>{{t('syncStatus.completed')}}</th><th>{{t('syncStatus.reason')}}</th></tr></thead><tbody><template v-for="source in sources" :key="source.id"><tr v-for="kind in (['current','latestAttempt','latestSuccess'] as const)" :key="kind"><th><code :title="source.id">{{source.id.slice(0,8)}}…</code></th><td>{{t(`syncStatus.checkKinds.${kind}`)}}</td><template v-if="checks[source.id]?.[kind]"><td>{{t(`syncStatus.states.${checks[source.id]![kind]!.state}`)}}</td><td>{{time(checks[source.id]![kind]!.createdAtMs)}}</td><td>{{time(checks[source.id]![kind]!.completedAtMs)}}</td><td>{{reason(checks[source.id]![kind]!.reasonCode)}}<p v-if="checks[source.id]![kind]!.detailCode">{{reason(checks[source.id]![kind]!.detailCode)}}</p></td></template><td v-else colspan="4">{{!checks[source.id]?t('syncStatus.notCollected'):t(`syncStatus.noCheck.${kind}`)}}</td></tr></template></tbody></table></div></section>
  <section><h3>{{t('syncStatus.audit')}}</h3><template v-if="audit"><p>{{t('syncStatus.auditHint',{scanned:audit.scannedCount,limit:audit.pageLimit})}}</p><div class="table-scroll"><table><thead><tr><th>{{t('syncStatus.created')}}</th><th>{{t('syncStatus.actor')}}</th><th>{{t('syncStatus.action')}}</th><th>{{t('syncStatus.project')}}</th><th>{{t('sync.version')}}</th></tr></thead><tbody><tr v-for="event in auditRows" :key="event.id"><td>{{time(event.time)}}</td><td>{{event.actorId??t('syncStatus.notCollected')}}</td><td>{{action(event.action)}}</td><td>{{event.objectId??t('syncStatus.notCollected')}}</td><td>{{event.revision??t('syncStatus.notCollected')}}</td></tr></tbody></table></div><p v-if="!auditRows.length">{{t('syncStatus.noAudit')}}</p><button v-if="audit.nextCursor" type="button" @click="readAudit(audit.nextCursor)">{{t('syncStatus.nextPage')}}</button></template><p v-else-if="!access?.capabilities.includes('audit.read')">{{t('syncStatus.auditDenied')}}</p></section></template>
</section></template>
<style scoped>.sync-access{min-width:0}section section{margin:24px 0}p,dd,code{overflow-wrap:anywhere}nav{display:flex;gap:16px;flex-wrap:wrap}a{margin-right:12px}.project-name{max-width:100%;overflow-wrap:anywhere}.table-scroll{max-width:100%;max-height:55vh;overflow:auto}table{width:100%;min-width:650px;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top}thead{position:sticky;top:0;background:#fff}th{min-width:140px}td{min-width:140px;max-width:420px}td p{margin:4px 0}.long-name{min-width:240px;max-width:500px;overflow-wrap:anywhere}ul{padding-left:18px;margin:0}li{overflow-wrap:anywhere}dl{display:grid;grid-template-columns:minmax(140px,240px) 1fr}button{padding:6px 12px}</style>

<style scoped src="../styles/admin-controls.css"></style>

<style scoped>
.sync-access>section{border-top:1px solid var(--border);padding-top:16px}.sync-access dl{grid-template-columns:minmax(100px,180px) minmax(0,1fr)}
</style>

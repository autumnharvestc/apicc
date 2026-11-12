<script setup lang="ts">
import {ref,shallowRef,watch,computed,reactive,onBeforeUnmount} from 'vue';
import {useI18n} from 'vue-i18n';
import type {CollaborationApi,PolicyScope,AccessScope,AccessPolicy,CapabilityMode,DeploymentView} from '../api/collaboration.js';
import type {CollaborationPolicy,CollaborationPublicationMetadata,CollaborationGrant} from '@apicc/execution/client/collaboration';
import CollaborationPolicyTable from '../components/CollaborationPolicyTable.vue';
import CollaborationAccessTable from '../components/CollaborationAccessTable.vue';
const incoming=defineProps<{api:CollaborationApi;scope:PolicyScope}>();
let scopeGeneration=0;const staleScope=Symbol('stale collaboration scope');
const props={get scope(){return incoming.scope;},api:new Proxy(incoming.api,{get(target,key){const method=Reflect.get(target,key);return async(...args:unknown[])=>{const generation=scopeGeneration;try{const value=await method(...args);if(generation!==scopeGeneration)throw staleScope;return value;}catch(e){if(generation!==scopeGeneration)throw staleScope;throw e;}};}})};
onBeforeUnmount(()=>{scopeGeneration++;selectionGeneration++;oneTime.value=null;});
const {t,te}=useI18n();
const policy=ref<CollaborationPolicy|null>(null);const draft=ref<Record<string,unknown>>({});const error=ref('');
const pageSize=computed(()=>{const row=policy.value?.settings.find(setting=>setting.code==='defaultPageSize');return row?.valueType==='integer'?row.effective:50;});
const errorCode=ref('');
const accessPolicy=ref<AccessPolicy|null>(null);const accessDraft=ref<Record<string,CapabilityMode>>({});
const deployment=ref<DeploymentView|null>(null);
const access=ref<Awaited<ReturnType<CollaborationApi['access']>>|null>(null);
const publications=ref<Awaited<ReturnType<CollaborationApi['publications']>>|null>(null);
const selected=ref<CollaborationPublicationMetadata|null>(null);
const grantPage=ref<Awaited<ReturnType<CollaborationApi['grants']>>|null>(null);
const duration=ref(120000);const audience=ref<'members'|'external'>('external');const download=ref(false);
const durationEdited=ref(false);const currentConstraints=ref<NonNullable<typeof grantPage.value>['constraints']|null>(null);
const oneTime=ref<CollaborationGrant|null>(null);
let selectionGeneration=0;
const pendingIntents=reactive<Record<string,string>>({});const reconciled=ref(false);
function selectionKey(){return `${props.scope.workspaceId}/${props.scope.projectId}/${selected.value?.id}`;}
async function loadPublications(cursor?:string){try{access.value=await props.api.access(props.scope as AccessScope);if(access.value.effectiveRole===null){publications.value=null;errorCode.value='content_unreadable';return;}publications.value=await props.api.publications(props.scope as AccessScope,{limit:pageSize.value,...(cursor?{cursor}:{})});}catch(e){failure(e);}}
async function choosePublication(row:CollaborationPublicationMetadata){const generation=++selectionGeneration;if(selected.value?.id!==row.id)durationEdited.value=false;selected.value=row;oneTime.value=null;grantPage.value=null;currentConstraints.value=null;logsPage.value=null;publicationDetails.value=null;reconciled.value=false;refreshNeeded.value=false;try{const page=await props.api.grants(props.scope as AccessScope,row.id,{limit:pageSize.value});if(generation!==selectionGeneration)return;grantPage.value=page;currentConstraints.value=page.constraints;if(!durationEdited.value)duration.value=page.constraints.defaultShareDurationMs.value;}catch(e){if(generation===selectionGeneration)failure(e);}}
async function nextGrants(cursor:string){const generation=selectionGeneration;try{const page=await props.api.grants(props.scope as AccessScope,selected.value!.id,{limit:pageSize.value,cursor});if(generation!==selectionGeneration)return;grantPage.value=page;currentConstraints.value=page.constraints;}catch(e){if(generation===selectionGeneration)failure(e);}}
async function refreshGrants(){const generation=selectionGeneration,row=selected.value!;try{const value=await props.api.publication(props.scope as AccessScope,row.id);if(generation!==selectionGeneration)return;await choosePublication({...row,revision:value.revision,enabled:value.enabled});}catch(e){if(generation===selectionGeneration)failure(e);}}
const refreshNeeded=ref(false);
const logsPage=ref<Awaited<ReturnType<CollaborationApi['mockLogs']>>|null>(null);
const auditPage=ref<Awaited<ReturnType<CollaborationApi['audit']>>|null>(null);
const publicationDetails=shallowRef<Awaited<ReturnType<CollaborationApi['publication']>>|null>(null);
const auditFilters=reactive({object:'',actor:'',from:'',to:'',limit:null as number|null});const logFilters=reactive({object:'',actor:'',from:'',to:'',limit:null as number|null});
function metadataQuery(filters:typeof auditFilters,cursor?:string){return {limit:filters.limit??pageSize.value,...(filters.object?{object:filters.object}:{}),...(filters.actor?{actor:filters.actor}:{}),...(filters.from||filters.to?{time:`${filters.from}/${filters.to}`} :{}),...(cursor?{cursor}:{})};}
let appliedAuditQuery:ReturnType<typeof metadataQuery>={limit:50},appliedLogQuery:ReturnType<typeof metadataQuery>={limit:50};
function hasCapability(capability:string){return access.value?.capabilities.some(code=>code===capability)===true;}
async function readLogs(cursor?:string){
  const generation=selectionGeneration;
  if(!hasCapability('mock.logs.read')){errorCode.value='logs_not_allowed';return;}
  const query=cursor?{...appliedLogQuery,cursor}:metadataQuery(logFilters);if(!cursor)appliedLogQuery={...query};
  try{const page=await props.api.mockLogs(props.scope as AccessScope,selected.value!.id,query);if(generation===selectionGeneration)logsPage.value=page;}catch(e){if(generation===selectionGeneration)failure(e);}
}
async function readAudit(cursor?:string){try{
  if(!access.value)access.value=await props.api.access(props.scope as AccessScope);
  if(!hasCapability('audit.read')){errorCode.value='audit_not_allowed';return;}
  const query=cursor?{...appliedAuditQuery,cursor}:metadataQuery(auditFilters);if(!cursor)appliedAuditQuery={...query};
  auditPage.value=await props.api.audit(props.scope as AccessScope,query);
}catch(e){failure(e);}}
async function setMock(){if(!hasCapability('mock.manage'))return;const generation=selectionGeneration,row=selected.value!;try{const value=await props.api.setMockEnabled(props.scope as AccessScope,row.id,!row.enabled,row.revision);if(generation!==selectionGeneration)return;publicationDetails.value=value;selected.value={...row,enabled:value.enabled,revision:value.revision};}catch(e){if(generation===selectionGeneration)failure(e);}}
function escapedLocation(value:string){return value.replaceAll('\\','\\\\').replaceAll('\r','\\r').replaceAll('\n','\\n');}
function classification(value:string|null){if(value===null)return t('collaboration.notCollected');const key=`collaboration.classifications.${value}`;return te(key)?t(key):`${t('collaboration.unknown')} (${value})`;}
function codeLabel(code:string|null){if(code===null)return t('collaboration.notCollected');const key=`collaboration.states.${code}`;return te(key)?t(key):`${t('collaboration.unknown')} (${code})`;}
function time(value:string|number){return new Date(value).toISOString().replace('T',' ').replace('Z',' UTC');}
async function createGrant(){
  if(pendingIntents[selectionKey()]||!currentConstraints.value)return;
  if(!Number.isSafeInteger(duration.value)||duration.value<60000||duration.value>currentConstraints.value!.maxShareDurationMs.value){errorCode.value='invalid_duration';return;}
  if(audience.value==='external'&&!currentConstraints.value!.externalSharingAllowed.value){errorCode.value='external_not_allowed';return;}
  if(download.value&&!currentConstraints.value!.externalDownloadAllowed.value){errorCode.value='download_not_allowed';return;}
  const key=selectionKey(),generation=selectionGeneration,intent=crypto.randomUUID();pendingIntents[key]=intent;
  try{const reply=await props.api.createGrant(props.scope as AccessScope,selected.value!.id,{purpose:selected.value!.kind==='mock'?'call':'view',audience:audience.value,durationMs:duration.value,downloadAllowed:download.value,expectedRevision:selected.value!.revision,operationIntent:intent});if(generation!==selectionGeneration)return;delete pendingIntents[key];oneTime.value=reply;grantPage.value=null;refreshNeeded.value=true;}catch(e){if(typeof e==='object'&&e!==null&&'status'in e&&Number(e.status)>=400&&Number(e.status)<500)delete pendingIntents[key];if(generation===selectionGeneration)failure(e);}
}
async function rotateGrant(row:CollaborationGrant){if(pendingIntents[selectionKey()])return;const key=selectionKey(),generation=selectionGeneration,intent=crypto.randomUUID();pendingIntents[key]=intent;try{const reply=await props.api.rotateGrant(props.scope as AccessScope,row.id,{expectedRevision:row.revision,operationIntent:intent});if(generation!==selectionGeneration)return;delete pendingIntents[key];oneTime.value=reply;grantPage.value=null;refreshNeeded.value=true;}catch(e){if(typeof e==='object'&&e!==null&&'status'in e&&Number(e.status)>=400&&Number(e.status)<500)delete pendingIntents[key];if(generation===selectionGeneration)failure(e);}}
async function reconcileGrant(){const key=selectionKey(),intent=pendingIntents[key],generation=selectionGeneration;if(!intent)return;try{await props.api.grantOperation(props.scope as AccessScope,intent);if(generation!==selectionGeneration)return;delete pendingIntents[key];oneTime.value=null;reconciled.value=true;refreshNeeded.value=true;error.value='';errorCode.value='';}catch(e){if(generation===selectionGeneration)failure(e);}}
async function revokeGrant(row:CollaborationGrant){const generation=selectionGeneration;try{await props.api.revokeGrant(props.scope as AccessScope,row.id,row.revision);if(generation!==selectionGeneration)return;oneTime.value=null;grantPage.value=null;refreshNeeded.value=true;}catch(e){if(generation===selectionGeneration)failure(e);}}
watch(()=>props.scope,()=>{scopeGeneration++;selectionGeneration++;policy.value=null;draft.value={};accessPolicy.value=null;accessDraft.value={};deployment.value=null;access.value=null;publications.value=null;selected.value=null;grantPage.value=null;currentConstraints.value=null;oneTime.value=null;logsPage.value=null;auditPage.value=null;publicationDetails.value=null;error.value='';errorCode.value='';durationEdited.value=false;},{deep:true,flush:'sync'});
watch(()=>props.scope,async()=>{if(!props.scope.workspaceId){try{deployment.value=await props.api.deployment();}catch(e){failure(e);}}},{immediate:true,deep:true});
function display(value:unknown){return value===null||value===''?t('collaboration.unconfigured'):typeof value==='boolean'?t(value?'collaboration.on':'collaboration.off'):String(value);}
function deploymentValue(code:string){const d=deployment.value!;const values:Record<string,unknown>={'runtime.enabled':d.runtime.enabled,'runtime.endpoint':d.runtime.endpointConfigured,'runtime.authentication':d.runtime.secretConfigured,'runtime.expectedProtocolVersion':d.runtime.expectedProtocolVersion,'runtime.privateNetwork':t('collaboration.notCollected'),'public.enabled':d.publicAccess.enabled,'public.bindAddress':d.publicAccess.bindAddress,'public.port':d.publicAccess.port,'public.baseUrl':d.publicAccess.baseUrl,'public.managementBaseUrl':d.publicAccess.managementBaseUrl};return display(values[code]);}
watch(()=>props.scope,async()=>{if(props.scope.workspaceId){try{accessPolicy.value=await props.api.accessPolicy({workspaceId:props.scope.workspaceId,projectId:props.scope.projectId});}catch(e){failure(e);}}},{immediate:true,deep:true});
function failure(e:unknown){if(e===staleScope)return;errorCode.value=typeof e==='object'&&e!==null&&'code'in e?String(e.code):'';error.value=e instanceof Error?e.message:String(e);}
const errorText=computed(()=>te(`collaboration.grantErrors.${errorCode.value}`)?t(`collaboration.grantErrors.${errorCode.value}`):te(`collaboration.errors.${errorCode.value}`)?t(`collaboration.errors.${errorCode.value}`):te(`collaboration.denials.${errorCode.value}`)?t(`collaboration.denials.${errorCode.value}`):error.value);
async function savePolicy(){
  if(Object.values(draft.value).some(value=>typeof value==='number'&&!Number.isSafeInteger(value))){errorCode.value='integer_required';return;}
  try{policy.value=await props.api.savePolicy(props.scope,{expectedRevision:policy.value!.revision,settings:draft.value});draft.value={};error.value='';errorCode.value='';}catch(e){failure(e);}
}
async function reloadPolicy(){try{policy.value=await props.api.policy(props.scope);}catch(e){failure(e);}}
async function saveAccessPolicy(){try{accessPolicy.value=await props.api.putAccessPolicy(props.scope as AccessScope,{expectedRevision:accessPolicy.value!.revision,defaults:accessDraft.value});accessDraft.value={};}catch(e){failure(e);}}
async function reloadAccessPolicy(){try{accessPolicy.value=await props.api.accessPolicy(props.scope as AccessScope);}catch(e){failure(e);}}
watch(()=>props.scope,async()=>{try{policy.value=await props.api.policy(props.scope);}catch(e){failure(e);}},{immediate:true,deep:true});
</script>
<template>
  <section class="admin-page collaboration-view" data-testid="collaboration-view">
    <h2>{{t('collaboration.title')}}</h2>
    <nav v-if="scope.projectId" :aria-label="t('collaboration.title')"><a v-for="section in ['policy','sharing','mock','audit']" :key="section" :href="'#'+section">{{t('collaboration.sections.'+section)}}</a></nav>
    <p v-if="error||errorCode" role="alert">{{errorText}} <span v-if="errorCode">({{errorCode}})</span>
</p>
    <section v-if="scope.projectId" id="sharing" data-testid="collaboration-sharing">
<h3>{{t('collaboration.sharingTitle')}}</h3>
<p>{{t('collaboration.clientEditing')}}</p>
<button data-testid="publications-load" @click="loadPublications()">{{t('collaboration.loadPublications')}}</button>
      <ul class="publication-list">
<li v-for="row in publications?.items" :key="row.id">
<button :data-testid="`publication-select-${row.id}`" @click="choosePublication(row)">v{{row.version}} · {{codeLabel(row.kind)}} · {{codeLabel(row.trust)}}</button>
<span>{{time(row.createdAt)}}</span>
<details>
<summary>{{t('collaboration.identity')}} {{row.digest.slice(0,12)}}…</summary>
<code>{{row.digest}}</code>
<dl>
<dt>{{t('collaboration.source')}}</dt>
<dd>{{codeLabel(row.source.kind)}} · {{row.source.revision}}</dd>
<dt>{{t('collaboration.sourceDigest')}}</dt>
<dd>{{row.source.digest}}</dd>
</dl>
</details>
</li>
</ul>
      <button v-if="publications?.nextCursor" data-testid="publications-next" @click="loadPublications(publications.nextCursor)">{{t('collaboration.nextPage')}}</button>
      <div v-if="selected">
<h4 data-testid="selected-publication">v{{selected.version}} · {{t('collaboration.currentRevision')}} {{selected.revision}}</h4>
<p>{{t('collaboration.revokeHint')}}</p>
<p v-if="refreshNeeded||pendingIntents[selectionKey()]">{{t('collaboration.directoryRefreshNeeded')}}</p>
        <div class="table-scroll">
<table>
<thead>
<tr>
<th>{{t('collaboration.authorization')}}</th>
<th>{{t('collaboration.state')}}</th>
<th>{{t('collaboration.responsible')}}</th>
<th>{{t('collaboration.expiry')}}</th>
<th>{{t('collaboration.currentRevision')}}</th>
<th>{{t('collaboration.actions')}}</th>
</tr>
</thead>
<tbody>
<tr v-for="row in grantPage?.items" :key="row.id" :data-testid="`grant-${row.id}`">
<th>{{row.id}} · {{codeLabel(row.purpose)}} / {{codeLabel(row.audience)}}<small>{{row.publicId??row.memberPath}}</small>
</th>
<td>{{codeLabel(row.state)}}<p v-if="row.reason">{{codeLabel(row.reason)}}</p>
</td>
<td>{{row.responsibleId}} · {{t('collaboration.responsibilityEpoch')}} {{row.responsibilityEpoch}}</td>
<td>{{time(row.expiresAt)}}</td>
<td>{{row.revision}} · {{t('collaboration.generation')}} {{row.generation}}</td>
<td>
<button :data-testid="`grant-rotate-${row.id}`" @click="rotateGrant(row)">{{t('collaboration.rotate')}}</button>
<button :data-testid="`grant-revoke-${row.id}`" @click="revokeGrant(row)">{{t('collaboration.revoke')}}</button>
</td>
</tr>
</tbody>
</table>
</div>
        <button v-if="grantPage?.nextCursor" data-testid="grants-next" @click="nextGrants(grantPage.nextCursor)">{{t('collaboration.nextPage')}}</button>
        <p v-if="grantPage">{{t('collaboration.durationHint')}} 60000–{{grantPage.constraints.maxShareDurationMs.value}} {{t('collaboration.units.milliseconds')}} · {{t('collaboration.sources.'+grantPage.constraints.maxShareDurationMs.source)}}</p>
        <label>{{t('collaboration.duration')}} <input type="number" v-model.number="duration" min="60000" data-testid="grant-duration" @input="durationEdited=true"/>
</label>
<label>{{t('collaboration.audience')}} <select v-model="audience" data-testid="grant-audience">
<option value="members">{{codeLabel('members')}}</option>
<option value="external">{{codeLabel('external')}}</option>
</select>
</label>
<label>
<input type="checkbox" v-model="download" data-testid="grant-download"/>{{t('collaboration.download')}}</label>
<button class="primary-action" data-testid="grant-create" @click="createGrant">{{t('collaboration.createGrant')}}</button>
<button data-testid="grants-refresh" @click="refreshGrants">{{t('collaboration.reload')}}</button>
<button data-testid="grant-reconcile" :disabled="!pendingIntents[selectionKey()]" @click="reconcileGrant">{{t('collaboration.reconcile')}}</button>
<p v-if="pendingIntents[selectionKey()]">{{t('collaboration.uncertainGrant')}}</p>
<p v-if="reconciled">{{t('collaboration.grantReconciled')}}</p>
        <div v-if="oneTime" data-testid="grant-reply">
<p>{{t(oneTime.key?'collaboration.onceOnly':'collaboration.secretUnavailable')}}</p>
<output v-if="oneTime.key">{{oneTime.key}}</output>
<p>{{oneTime.publicUrl??oneTime.baseUrl??oneTime.memberPath}}</p>
<p>{{t('collaboration.expiry')}}: {{time(oneTime.expiresAt)}}</p>
</div>
        <section v-if="selected.kind==='mock'" id="mock" data-testid="shared-mock">
<h4>{{t('collaboration.mockTitle')}}</h4>
<p data-testid="mock-object-state">{{t(selected.enabled?'collaboration.mockObjectEnabled':'collaboration.mockObjectDisabled')}} · {{t(publicationDetails?'collaboration.mockReplySource':'collaboration.mockDirectorySource')}}</p>
<p>{{t('collaboration.mockReadinessHint')}}</p>
<p v-if="publicationDetails&&'activity' in publicationDetails&&publicationDetails.activity">{{t('collaboration.mockActivity.'+publicationDetails.activity.state)}} · {{t('collaboration.activeRequests')}}: {{publicationDetails.activity.activeRequests}}</p>
<p v-else>{{t('collaboration.notCollected')}}</p>
        <button data-testid="mock-enable" :disabled="!hasCapability('mock.manage')" @click="setMock">{{t(selected.enabled?'collaboration.disableMock':'collaboration.enableMockNow')}}</button>
        <fieldset>
<legend>{{t('collaboration.logFilters')}}</legend>
<label>{{t('collaboration.ruleId')}}<input v-model="logFilters.object" data-testid="logs-object"/>
</label>
<label>{{t('collaboration.grantPublicId')}}<input v-model="logFilters.actor" data-testid="logs-actor"/>
</label>
<label>{{t('collaboration.from')}}<input v-model="logFilters.from" data-testid="logs-from"/>
</label>
<label>{{t('collaboration.to')}}<input v-model="logFilters.to" data-testid="logs-to"/>
</label>
<label>{{t('collaboration.pageLimit')}}<input type="number" min="1" max="200" :value="logFilters.limit??pageSize" @input="logFilters.limit=($event.target as HTMLInputElement).valueAsNumber" data-testid="logs-limit"/>
</label>
</fieldset>
        <button data-testid="mock-logs-load" :disabled="!hasCapability('mock.logs.read')" @click="readLogs()">{{t('collaboration.readLogs')}}</button>
        <div v-if="logsPage" data-testid="logs-visible">
<p>
<span data-testid="logs-loaded">{{logsPage.items.length}}</span> {{t('collaboration.units.items')}} · {{t('collaboration.scanned')}} {{logsPage.scannedCount}} / {{logsPage.pageLimit}}</p>
<p>{{t('collaboration.logStates.'+logsPage.state)}}</p>
<p>{{t('collaboration.discarded')}}: {{logsPage.discarded}} · {{t('collaboration.logMax')}}: {{logsPage.maxEntries}} · {{t('collaboration.retention')}}: {{logsPage.retentionMs}} {{t('collaboration.units.milliseconds')}}</p>
          <div class="table-scroll">
<table>
<thead>
<tr>
<th>{{t('collaboration.time')}}</th>
<th>{{t('collaboration.route')}}</th>
<th>{{t('collaboration.ruleId')}}</th>
<th>{{t('collaboration.httpStatus')}}</th>
<th>{{t('collaboration.duration')}}</th>
<th>{{t('collaboration.state')}}</th>
<th>{{t('collaboration.grantPublicId')}}</th>
<th>{{t('collaboration.requestId')}}</th>
</tr>
</thead>
<tbody>
<tr v-for="row in logsPage.items" :key="row.id">
<td>{{time(row.time)}}</td>
<td>{{row.method}} {{row.routeTemplate??t('collaboration.notCollected')}}</td>
<td>{{row.ruleId??t('collaboration.notCollected')}}</td>
<td>{{row.status===0?t('collaboration.noHttpResponse'):row.status}}</td>
<td>{{row.durationMs}} {{t('collaboration.units.milliseconds')}}</td>
<td>{{codeLabel(row.reason)}}</td>
<td>{{row.grantPublicId??t('collaboration.notCollected')}}</td>
<td>{{row.requestId??t('collaboration.notCollected')}}</td>
</tr>
</tbody>
</table>
</div>
          <button v-if="logsPage.nextCursor" data-testid="logs-next" @click="readLogs(logsPage.nextCursor)">{{t('collaboration.nextPage')}}</button>
        </div>
        </section>
      </div>
    </section>
    <section v-if="scope.projectId">
<h3 id="audit">{{t('collaboration.auditTitle')}}</h3>
<p>{{t('collaboration.auditHint')}}</p>
<fieldset>
<legend>{{t('collaboration.auditFilters')}}</legend>
<label>{{t('collaboration.auditObject')}}<input v-model="auditFilters.object" data-testid="audit-object" placeholder="PROJECT:2"/>
</label>
<label>{{t('collaboration.memberActor')}}<input v-model="auditFilters.actor" data-testid="audit-actor"/>
</label>
<label>{{t('collaboration.from')}}<input v-model="auditFilters.from" data-testid="audit-from"/>
</label>
<label>{{t('collaboration.to')}}<input v-model="auditFilters.to" data-testid="audit-to"/>
</label>
<label>{{t('collaboration.pageLimit')}}<input type="number" min="1" max="200" :value="auditFilters.limit??pageSize" @input="auditFilters.limit=($event.target as HTMLInputElement).valueAsNumber" data-testid="audit-limit"/>
</label>
</fieldset>
    <button data-testid="audit-load" :disabled="access!==null&&!hasCapability('audit.read')" @click="readAudit()">{{t('collaboration.readAudit')}}</button>
      <div v-if="auditPage" data-testid="audit-visible">
<p v-if="auditPage.accessDetails">{{t('collaboration.accessObservations')}}: {{t('collaboration.accessObservationStates.'+auditPage.accessDetails.state)}} · {{t('collaboration.retention')}} {{auditPage.accessDetails.retentionMs}} ms</p>
<p>{{t('collaboration.scanned')}} <span data-testid="audit-loaded">{{auditPage.scannedCount}}</span> / {{auditPage.pageLimit}}</p>
<section v-for="domain in ['access','execution','collaboration'] as const" :key="domain">
<h4>{{t('collaboration.auditDomains.'+domain)}}</h4>
<div class="table-scroll">
<table>
<thead>
<tr>
<th>{{t('collaboration.time')}}</th>
<th>{{t('collaboration.memberActor')}}</th>
<th>{{t('collaboration.auditObject')}}</th>
<th>{{t('collaboration.action')}}</th>
<th>{{t('collaboration.currentRevision')}}</th>
<th>{{t('collaboration.details')}}</th>
</tr>
</thead>
<tbody>
<tr v-for="row in auditPage[domain]" :key="row.id">
<td>{{time(row.time)}}</td>
<td>{{row.actorId??t('collaboration.notCollected')}}</td>
<td>{{row.objectKind??t('collaboration.notCollected')}}:{{row.objectId??t('collaboration.notCollected')}}</td>
<td>{{classification(row.action)}}</td>
<td>{{row.revision??t('collaboration.notCollected')}}</td>
<td>
<template v-if="'locations'in row">
<p>{{classification(row.summary)}} · {{t('collaboration.agent')}}: {{row.agentId??t('collaboration.notCollected')}}</p>
<span v-if="row.locations===null">{{t('collaboration.notCollected')}}</span>
<span v-else-if="row.locations.length===0">{{t('collaboration.noChangedLocations')}}</span>
<ul v-else>
<li v-for="(location,index) in row.locations" :key="index">
<code>{{escapedLocation(location)}}</code>
</li>
</ul>
<details>
<summary>{{t('collaboration.beforeAfter')}}</summary>
<dl>
<dt>{{t('collaboration.before')}}</dt>
<dd>
<code>{{row.beforeRevision??t('collaboration.notCollected')}}</code>
</dd>
<dt>{{t('collaboration.after')}}</dt>
<dd>
<code>{{row.afterRevision??t('collaboration.notCollected')}}</code>
</dd>
</dl>
</details>
</template>
<span v-else>{{row.reason===null?t('collaboration.notCollected'):classification(row.reason)}}</span>
</td>
</tr>
</tbody>
</table>
</div>
</section>
<button v-if="auditPage.nextCursor" data-testid="audit-next" @click="readAudit(auditPage.nextCursor)">{{t('collaboration.nextPage')}}</button>
</div>
      <details v-if="auditPage" class="raw-security-records" data-testid="audit-raw">
<summary>{{t('collaboration.rawRecords')}}</summary>
<pre>{{JSON.stringify(auditPage,null,2)}}</pre>
</details>
    </section>
    <section v-if="deployment" data-testid="collaboration-deployment">
<h3>{{t('collaboration.deploymentTitle')}}</h3>
      <p>{{t(`collaboration.runtimeStates.${deployment.runtime.health}`)}} · {{t('collaboration.expectedProtocol')}}: {{deployment.runtime.expectedProtocolVersion}}</p>
<p>{{t('collaboration.uncheckedHint')}}</p>
      <dl>
<dt>{{t('collaboration.boundPort')}}</dt>
<dd>{{deployment.publicAccess.boundPort===null?t('collaboration.unbound'):deployment.publicAccess.boundPort}}</dd>
<dt>{{t('collaboration.originConfigured')}}</dt>
<dd>{{display(deployment.publicAccess.originConfigured)}}</dd>
<dt>{{t('collaboration.savedOriginStatus')}}</dt>
<dd>{{t('collaboration.originStatuses.'+deployment.publicAccess.originStatus)}}</dd>
<dt>{{t('collaboration.savedManagementOriginStatus')}}</dt>
<dd>{{t('collaboration.originStatuses.'+deployment.publicAccess.managementOriginStatus)}}</dd>
<dt>{{t('collaboration.reconciled')}}</dt>
<dd>{{display(deployment.publicAccess.startupReconciled)}}</dd>
</dl>
      <div class="table-scroll">
<table>
<thead>
<tr>
<th>{{t('collaboration.parameter')}}</th>
<th>{{t('collaboration.local')}}</th>
<th>{{t('collaboration.default')}}</th>
<th>{{t('collaboration.range')}}</th>
<th>{{t('collaboration.source')}}</th>
<th>{{t('collaboration.effect')}}</th>
</tr>
</thead>
<tbody>
<tr v-for="field in deployment.fields" :key="field.code">
<th>{{t(`collaboration.deploymentFields.${field.code.replaceAll('.','_')}`)}}</th>
<td>{{deploymentValue(field.code)}}</td>
<td>{{display(field.defaultValue==='true'?true:field.defaultValue==='false'?false:field.defaultValue)}}</td>
<td>{{field.minimum}}–{{field.maximum}} {{t(`collaboration.deploymentUnits.${field.unit}`)}}<p>{{t(`collaboration.deploymentConstraints.${field.constraint}`)}}</p>
</td>
<td>{{t('collaboration.sources.deployment')}}</td>
<td>{{t('collaboration.restartRequired')}}</td>
</tr>
</tbody>
</table>
</div>
      <h4>{{t('collaboration.resourceMetadataTitle')}}</h4>
<p>{{t('collaboration.resourceDefaultHint')}}</p>
<p>{{t('collaboration.resourceCombinations.'+deployment.resourceConstraint)}}</p>
<div class="table-scroll"><table class="resource-metadata"><thead><tr><th>{{t('collaboration.parameter')}}</th><th>{{t('collaboration.default')}}</th><th>{{t('collaboration.value')}}</th><th>{{t('collaboration.range')}}</th><th>{{t('collaboration.source')}}</th><th>{{t('collaboration.effect')}}</th><th>{{t('collaboration.permissionReason')}}</th></tr></thead><tbody>
<tr v-for="row in deployment.resources" :key="row.code" :data-testid="`deployment-resource-${row.code}`"><th>{{row.code==='nodeCacheBytes'?t('collaboration.nodeCache'):t('collaboration.resourceLabels.'+row.code.replaceAll('.','_'))}}</th><td>{{display(row.defaultValue)}}<span v-if="row.defaultValue!==null"> {{t('collaboration.units.'+row.unit)}}</span></td><td>{{display(row.value)}}<span v-if="row.value!==null"> {{t('collaboration.units.'+row.unit)}}</span></td><td>{{row.minimum}}–{{row.maximum===null?t('collaboration.noStandaloneMaximum'):row.maximum}} {{t('collaboration.units.'+row.unit)}}</td><td>{{t('collaboration.sources.'+row.source)}}</td><td>{{t('collaboration.resourceEffects.'+row.effect)}}</td><td>{{t('collaboration.resourceConstraints.'+row.constraint)}}</td></tr>
</tbody></table></div>
    </section>
    <section v-if="accessPolicy">
<h3>{{t('collaboration.capability')}}</h3>
<p>{{t('collaboration.currentRevision')}}: {{accessPolicy.revision}}</p>
<CollaborationAccessTable :rows="accessPolicy.capabilities" :defaults="accessPolicy.defaults" :draft="accessDraft" @save="saveAccessPolicy"/>
<button data-testid="capability-reload" @click="reloadAccessPolicy">{{t('collaboration.reload')}}</button>
</section>
    <section v-if="policy" id="policy">
<h3>{{t('collaboration.parameter')}}</h3>
<p>{{t('collaboration.currentRevision')}}: {{policy.revision}} · {{t('collaboration.projectionRevision')}}: {{policy.projectionRevision}}</p>
<CollaborationPolicyTable :policy="policy" :draft="draft" />
<button class="primary-action" data-testid="collaboration-policy-save" @click="savePolicy">{{t('collaboration.save')}}</button>
<button data-testid="collaboration-policy-reload" @click="reloadPolicy">{{t('collaboration.reload')}}</button>
      <h3>{{t('collaboration.resources')}}</h3>
<p>{{t('collaboration.resourceHint')}}</p>
<div class="table-scroll">
<table>
<thead>
<tr>
<th>{{t('collaboration.parameter')}}</th>
<th>{{t('collaboration.value')}}</th>
<th>{{t('collaboration.range')}}</th>
<th>{{t('collaboration.source')}}</th>
</tr>
</thead>
<tbody>
<tr v-for="(fact,key) in policy.resources.recommendations" :key="key">
<th>{{t(`collaboration.resourceLabels.recommendations_${key}`)}}</th>
<td>{{fact.value}} {{t(`collaboration.units.${fact.unit}`)}}</td>
<td>{{fact.minimum}}–{{fact.maximum}} {{t(`collaboration.units.${fact.unit}`)}}</td>
<td>{{t('collaboration.recommendation')}}</td>
</tr>
<template v-for="group in ['externalLimits','applicationSettings'] as const" :key="group">
<tr v-for="(fact,key) in policy.resources[group]" :key="key">
<th>{{t(`collaboration.resourceLabels.${group}_${key}`)}}</th>
<td>{{display(fact.value)}} <span v-if="fact.value!==null">{{t(`collaboration.units.${fact.unit}`)}}</span>
</td>
<td>{{t('collaboration.deploymentOnly')}}</td>
<td>{{t('collaboration.sources.deployment')}}</td>
</tr>
</template>
</tbody>
</table>
</div>
      <details>
<summary>{{t('collaboration.identity')}} {{policy.identity.effectiveDigest.slice(0,12)}}…</summary>
<dl>
<dt>{{t('collaboration.deploymentIdentity')}}</dt>
<dd>
<code>{{policy.identity.deploymentDigest}}</code>
</dd>
<dt>{{t('collaboration.effectiveIdentity')}}</dt>
<dd>
<code>{{policy.identity.effectiveDigest}}</code>
</dd>
</dl>
<ul>
<li v-for="item in policy.identity.lineage" :key="item.scope">{{t(`collaboration.sources.${item.scope}`)}} · {{item.workspaceId}} / {{item.projectId}} · {{t('collaboration.currentRevision')}} {{item.revision}} · {{t('collaboration.projectionRevision')}} {{item.projectionRevision}}</li>
</ul>
</details>
    </section>
  </section>
</template>
<style scoped>.collaboration-view{min-width:0;max-width:100%}section{margin-bottom:24px}p,dd,code{overflow-wrap:anywhere}button{margin:6px 8px 6px 0}.table-scroll{max-width:100%;overflow:auto}table{min-width:900px;width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #eee;text-align:left;vertical-align:top;white-space:nowrap}td p{min-width:220px;max-width:340px;white-space:normal}td ul{max-width:420px;white-space:normal}dl{display:grid;grid-template-columns:minmax(130px,220px) minmax(0,1fr);gap:8px}dd{margin:0}summary{cursor:pointer}fieldset{display:flex;flex-wrap:wrap;gap:12px;padding:12px}label{display:inline-flex;gap:6px;align-items:center;max-width:100%}.publication-list{padding:0;list-style:none}.publication-list>li{padding:12px;border-bottom:1px solid #eee;min-width:0}.raw-security-records pre{max-height:400px;overflow:auto}output{overflow-wrap:anywhere}</style>

<style scoped src="../styles/admin-controls.css"></style>

<style scoped>
.collaboration-view>section{padding:20px 0;border-top:1px solid var(--border);scroll-margin-top:16px}.publication-list>li{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;border:1px solid var(--border);border-radius:8px;margin:10px 0;background:var(--subtle)}.publication-list details{flex-basis:100%}.collaboration-view fieldset{background:var(--subtle)}.collaboration-view label{flex-wrap:wrap}.collaboration-view input:not([type=checkbox]){max-width:100%}
</style>

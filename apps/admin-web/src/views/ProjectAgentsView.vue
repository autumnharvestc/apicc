<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { defaultProjectPolicy, displayValue, wireValue, fieldUnit, readableTime, validationMessage, type PolicyPatch, type ScriptGrant } from "../api/agents.js";
import type { AgentsStore } from "../stores/agents.js";
const props=defineProps<{ agents: AgentsStore; workspaceId: string; projectId: string; agentId?: string }>();
const {t}=useI18n();
const associated = ref<string[]>([]), defaultAgent = ref(""), choice = ref(""), scriptAgent = ref("");
const policyDraft=ref<Record<string,string|number>>({});
const queueNever=ref(false);
const scope = ref<"script-version"|"project">("script-version"), scripts=ref<ScriptGrant["scripts"]>([]), risk=ref(false), localError=ref("");
const fields=Object.keys(defaultProjectPolicy) as (keyof typeof defaultProjectPolicy)[];
const canManage=computed(()=>props.agents.project?.canManageScripts===true);
const locked=computed(()=>!canManage.value||props.agents.busy||props.agents.conflict);
const scriptNode=computed(()=>props.agents.project?.agents.find(n=>n.id===scriptAgent.value));
const requestedAgentError=computed(()=>props.agentId&&props.agents.project&&!props.agents.project.agents.some(n=>n.id===props.agentId)?t("agents.requestedAgentUnavailable"):"");
watch(()=>[props.workspaceId,props.projectId] as const,([ws,p])=>{scriptAgent.value="";choice.value="";policyDraft.value={};localError.value="";void props.agents.loadProject(ws,p);},{immediate:true});
watch(()=>props.agents.settings,s=>{associated.value=[...(s?.agentIds??[])];defaultAgent.value=s?.defaultAgentId??"";policyDraft.value={};queueNever.value=false;},{immediate:true});
watch(()=>[props.agents.project,props.agentId] as const,([project,requested],previous)=>{
  if(!project)return;
  if(requested&&!project.agents.some(n=>n.id===requested)){scriptAgent.value="";return;}
  const currentValid=project.agents.some(n=>n.id===scriptAgent.value);
  const target=requested&&(requested!==previous?.[1]||!currentValid)?requested:currentValid?scriptAgent.value:project.defaultAgentId??project.agents[0]?.id??"";
  if(target!==scriptAgent.value)scriptAgent.value=target;
  else if(target&&canManage.value)void props.agents.loadGrant(props.workspaceId,props.projectId,target);
},{immediate:true});
watch(scriptAgent,id=>{risk.value=false;localError.value="";if(id&&canManage.value)void props.agents.loadGrant(props.workspaceId,props.projectId,id);});
watch(()=>props.agents.grant,g=>{scope.value=g?.scope??"script-version";scripts.value=g?.scripts.map(s=>({...s}))??[];risk.value=false;},{immediate:true});
watch(scope,()=>{risk.value=false;});
function addAgent(){if(choice.value&&!associated.value.includes(choice.value))associated.value.push(choice.value);choice.value="";}
function removeAgent(id:string){associated.value=associated.value.filter(a=>a!==id);if(defaultAgent.value===id)defaultAgent.value="";}
async function saveProject(){
  if(locked.value)return;
  // A selected candidate can be associated in the same save, without an extra confirmation step.
  if(choice.value)addAgent();
  const policy:Record<string,unknown>={};for(const [key,value] of Object.entries(policyDraft.value))if(value!=="")policy[key]=wireValue(key,value);
  if(queueNever.value)policy.queueTimeoutMs=null;
  await props.agents.saveProject(props.workspaceId,props.projectId,{agentIds:associated.value,defaultAgentId:defaultAgent.value||null,policy:policy as PolicyPatch});
}
async function saveGrant(revoke=false){
  if(locked.value||!scriptAgent.value)return;
  localError.value="";
  if(!revoke&&scope.value==="project"&&!risk.value){localError.value=t("agents.trustConfirmation");return;}
  if(!revoke&&scope.value==="script-version"&&scripts.value.some(s=>!s.scriptId.trim()||!/^[a-f0-9]{64}$/.test(s.contentHash))){localError.value=t("agents.invalidScriptVersion");return;}
  await props.agents.saveGrant(props.workspaceId,props.projectId,scriptAgent.value,revoke?"script-version":scope.value,revoke||scope.value==="project"?[]:scripts.value,!revoke&&risk.value);
}
function agentName(id:string){return props.agents.candidates.find(n=>n.id===id)?.name??props.agents.project?.agents.find(n=>n.id===id)?.name??id;}
</script>
<template>
  <section class="project-agents" data-testid="project-agents-view">
    <h2>{{t('agents.projectTitle')}} · {{projectId}}</h2>
    <p>{{t('agents.scopeHint')}}</p>
    <p v-if="agents.error" role="alert">{{agents.error}}</p><p v-if="localError" role="alert">{{localError}}</p>
    <p v-if="requestedAgentError" role="alert">{{requestedAgentError}}</p>
    <ul v-if="agents.validationIssues.length" role="alert"><li v-for="(issue,index) in agents.validationIssues" :key="index">{{validationMessage(issue,t)}}</li></ul>
    <p v-if="agents.conflict" role="alert">{{t('agents.conflict')}}</p>
    <button @click="agents.loadProject(workspaceId,projectId)">{{t('agents.reload')}}</button>
    <p v-if="!agents.project&&!agents.loading">{{t('agents.projectUnavailable')}}</p>
    <template v-if="agents.project&&agents.settings">
      <p v-if="!canManage">{{t('agents.projectReadOnly')}}</p>
      <form @submit.prevent="saveProject">
        <div v-if="canManage" class="toolbar"><label>{{t('agents.allocatedCandidates')}} <select data-testid="project-agent-choice" v-model="choice" :disabled="locked"><option value="">{{t('agents.choose')}}</option><option v-for="node in agents.candidates.filter(n=>!associated.includes(n.id))" :key="node.id" :value="node.id">{{node.name}} · {{node.id}}</option></select></label><button type="button" :disabled="locked||!choice" @click="addAgent">{{t('agents.associate')}}</button></div>
        <ul><li v-for="id in associated" :key="id">{{agentName(id)}} · {{id}} <button v-if="canManage" type="button" :disabled="locked" @click="removeAgent(id)">{{t('agents.removeAssociation')}}</button></li></ul>
        <label>{{t('agents.defaultAgent')}} <select v-model="defaultAgent" :disabled="locked"><option value="">{{t('agents.noDefault')}}</option><option v-for="id in associated" :key="id" :value="id">{{agentName(id)}} · {{id}}</option></select></label>
        <h3>{{t('agents.projectPolicy')}}</h3><p>{{t('agents.inheritHint')}}</p>
        <div class="table-scroll"><table><thead><tr><th>{{t('agents.field')}}</th><th>{{t('agents.default')}}</th><th>{{t('agents.workspaceExplicit')}}</th><th>{{t('agents.projectExplicit')}}</th><th>{{t('agents.effective')}}</th><th>{{t('agents.source')}}</th><th v-if="canManage">{{t('agents.override')}}</th></tr></thead><tbody>
<tr v-for="key in fields" :key="key"><th>{{t(`agents.fields.${key}`)}} ({{t(`agents.units.${fieldUnit(key)}`)}})</th><td>{{displayValue(key,defaultProjectPolicy[key])}}</td><td>{{displayValue(key,agents.settings.explicit.workspace[key])}}</td><td>{{displayValue(key,agents.settings.explicit.project[key])}}</td><td>{{displayValue(key,agents.settings.policy[key])}}</td><td>{{t(`agents.sources.${agents.settings.sources[`policy.${key}`]??'default'}`)}}</td><td v-if="canManage"><input type="number" step="any" :value="policyDraft[key]" @input="policyDraft[key]=($event.target as HTMLInputElement).value" :aria-label="t(`agents.fields.${key}`)" :disabled="locked" /></td></tr>
        </tbody></table></div>
        <p>{{t('agents.savedVersion')}}: {{agents.settings.configVersion}} · {{t('agents.policyVersion')}}: {{agents.settings.policyVersion}}</p>
        <label v-if="canManage"><input type="checkbox" v-model="queueNever" :disabled="locked" />{{t('agents.queueNever')}}</label>
        <p>{{t('agents.retentionHint')}}</p>
        <ul v-if="agents.settings.restrictions.length"><li v-for="r in agents.settings.restrictions" :key="r.field">{{t(`agents.fields.${r.field.split('.').pop()}`)}}: {{displayValue(r.field.split('.').pop()!,r.effectiveValue)}} · {{t('agents.restrictedBy')}} {{t(`agents.fields.${r.reason.split('.').pop()}`)}}</li></ul>
        <button v-if="canManage" data-testid="project-agents-save" :disabled="locked">{{t('agents.saveProject')}}</button>
      </form>
      <h3>{{t('agents.associatedRuntime')}}</h3>
      <p>{{t('agents.applicationHint')}}</p>
      <div class="table-scroll"><table><thead><tr><th>{{t('agents.agent')}}</th><th>{{t('agents.state')}}</th><th>{{t('agents.lastSeen')}}</th><th>{{t('agents.configuration')}}</th><th>{{t('agents.scripts')}}</th><th>{{t('agents.runtimeIdentity')}}</th></tr></thead><tbody>
<tr v-for="n in agents.project.agents" :key="n.id"><th>{{n.name}} · {{n.id}}<p>{{t('agents.fields.maxQueuedJobs')}}: {{n.policy.maxQueuedJobs}} {{t('agents.units.count')}}</p><p>{{t('agents.policyVersion')}}: {{n.policyVersion}}</p></th><td>{{t(`agents.availability.${n.availability}`)}}</td><td>{{readableTime(n.lastSeenAt)}}</td><td>{{t(`agents.application.${n.configuration.status}`)}}<br />{{t('agents.savedVersion')}} {{n.configuration.configVersion}} / {{t('agents.appliedVersion')}} {{n.configuration.appliedConfigVersion}}<br />{{t('agents.pending')}}: {{n.configuration.pendingFields.map(k=>t(`agents.fields.${k}`)).join('、')||t('agents.none')}}<br />{{t('agents.restart')}}: {{n.configuration.restartRequiredFields.map(k=>t(`agents.fields.${k}`)).join('、')||t('agents.none')}}</td><td>{{t(n.scriptsAllowed?'agents.scriptModes.trusted-core':'agents.scriptModes.deny')}}<br />{{t(n.scriptGrant.scope==='project'?'agents.wholeProjectTrust':n.scriptGrant.scripts.length?'agents.versionApproval':'agents.noApproval')}} · {{t('agents.approvalVersion')}} {{n.scriptGrant.version}}</td><td v-if="n.runtime"><span>Node {{n.runtime.nodeVersion}} / V8 {{n.runtime.v8Version}}</span><details><summary>Core {{n.runtime.coreBuildId.slice(0,12)}} · {{t('agents.details')}}</summary><dl><dt>Core</dt><dd>{{n.runtime.coreBuildId}}</dd><dt>{{t('agents.scriptApi')}}</dt><dd>{{n.runtime.scriptApiId}}</dd><dt>{{t('agents.compatibility')}}</dt><dd>{{n.runtime.runtimeCompatibilityId}}</dd><dt>{{t('agents.capabilities')}}</dt><dd>{{n.runtime.capabilities.join(', ')}}</dd></dl></details></td><td v-else>{{t('agents.availability.runtime-missing')}}</td></tr>
      </tbody></table></div>
      <section v-if="canManage" class="scripts" data-testid="project-script-management">
        <h3>{{t('agents.scriptApprovals')}}</h3><p>{{t('agents.scriptRecordsHint')}}</p><p>{{t('agents.trustedRisk')}}</p>
        <label>{{t('agents.agent')}} <select v-model="scriptAgent" data-testid="script-agent"><option value="">{{t('agents.choose')}}</option><option v-for="n in agents.project.agents" :key="n.id" :value="n.id">{{n.name}} · {{n.id}}</option></select></label>
        <template v-if="agents.grant&&agents.grant.agentId===scriptAgent">
          <p>{{t('agents.approvalVersion')}}: {{agents.grant.version}} · {{t('agents.grantedBy')}}: {{agents.grant.version==='0'?'—':agents.grant.grantedByUserId}}</p>
          <p>{{t('agents.actualPermissionHint')}}</p>
          <p v-if="scriptNode&&!scriptNode.scriptsAllowed">{{t('agents.nodeScriptsDenied')}}</p>
          <form @submit.prevent="saveGrant()">
            <label>{{t('agents.approvalScope')}} <select v-model="scope" data-testid="script-scope" :disabled="locked"><option value="script-version">{{t('agents.versionApproval')}}</option><option value="project">{{t('agents.wholeProjectTrust')}}</option></select></label>
            <template v-if="scope==='script-version'">
              <div class="table-scroll"><table><thead><tr><th>{{t('agents.scriptId')}}</th><th>{{t('agents.contentHash')}}</th><th>{{t('agents.actions')}}</th></tr></thead><tbody><tr v-for="(s,index) in scripts" :key="index"><td><input required maxlength="512" v-model="s.scriptId" :aria-label="t('agents.scriptId')" :disabled="locked" /></td><td><input required pattern="[a-f0-9]{64}" v-model="s.contentHash" :aria-label="t('agents.contentHash')" :disabled="locked" /><details v-if="s.contentHash"><summary>{{s.contentHash.slice(0,12)}} · {{t('agents.fullFingerprint')}}</summary><span class="hash">{{s.contentHash}}</span></details></td><td><button type="button" :disabled="locked" @click="scripts.splice(index,1)">{{t('agents.remove')}}</button></td></tr></tbody></table></div>
              <button type="button" :disabled="locked" @click="scripts.push({scriptId:'',contentHash:''})">{{t('agents.addScriptVersion')}}</button>
            </template>
            <label v-else class="risk"><input type="checkbox" v-model="risk" data-testid="script-risk" :disabled="locked" />{{t('agents.trustConfirmation')}}</label>
            <button data-testid="script-save" :disabled="locked||(scope==='project'&&!risk)">{{t('agents.saveApproval')}}</button>
            <button type="button" data-testid="script-revoke" :disabled="locked" @click="saveGrant(true)">{{t('agents.revokeApproval')}}</button>
          </form>
        </template>
      </section>
    </template>
  </section>
</template>
<style scoped>
.project-agents{min-width:0;max-width:1500px}h2{margin-top:0}p,li{line-height:1.65}label,.toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:12px 0}button,input,select{font:inherit;padding:6px 10px}button{cursor:pointer;margin-right:8px}button:disabled{cursor:default}input{max-width:100%}.table-scroll{max-height:48vh;overflow:auto;margin:12px 0;background:white;border:1px solid #ddd}table{min-width:850px;width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 12px;border-bottom:1px solid #eee;vertical-align:top;white-space:nowrap}thead{position:sticky;top:0;background:#fafafa}td input{width:150px}.scripts{margin-top:24px;border-top:1px solid #ddd}.scripts td:nth-child(2) input{width:400px}.hash,dd{overflow-wrap:anywhere;white-space:normal;max-width:600px}.risk{background:#fff7e6;padding:12px}[role=alert]{color:#a8071a}
</style>

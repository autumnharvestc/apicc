<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { defaultAgentConfig, defaultPolicyConfig, displayValue, wireValue, fieldUnit, readableTime, validationMessage, type AgentPatch, type PolicyPatch } from "../api/agents.js";
import type { AgentsStore } from "../stores/agents.js";
const props = defineProps<{ agents: AgentsStore; platform: boolean; workspaceId?: string }>();
const { t } = useI18n();
const draft = ref<Record<string,string|number>>({}), policyDraft = ref<Record<string,string|number>>({});
const nodeName = ref(""), accepting = ref(true), queue = ref(100), createName = ref("");
const grantIds = ref<string[]>([]), allocationAgent = ref(""), allocationIds = ref<string[]>([]);
const revokeConfirmed = ref(false);
const queueNever=ref(false);
const agentFields = Object.keys(defaultAgentConfig) as (keyof typeof defaultAgentConfig)[];
const policyFields = Object.keys(defaultPolicyConfig) as (keyof typeof defaultPolicyConfig)[];
const locked = computed(()=>!props.platform || props.agents.busy || props.agents.conflict);
const allocationLocked=computed(()=>props.agents.busy||props.agents.conflict||props.agents.allocationStatus!=="ready"||props.agents.allocationWorkspaceId!==props.workspaceId||props.agents.allocationAgentId!==allocationAgent.value);
watch(()=>props.agents.node, node=>{
  draft.value = node ? Object.fromEntries(Object.entries(node.config).map(([k,v])=>[k,displayValue(k,v)])) : {};
  nodeName.value=node?.name??""; accepting.value=node?.acceptingJobs??true;queue.value=node?.agentPolicy.maxQueuedJobs??100;revokeConfirmed.value=false;
},{immediate:true});
watch(()=>props.agents.workspaceIds,ids=>{grantIds.value=[...ids];},{immediate:true});
watch(()=>props.agents.allocation,ids=>{allocationIds.value=[...ids];},{immediate:true});
watch(()=>props.agents.workspace,()=>{policyDraft.value={};queueNever.value=false;});
watch(()=>[props.platform,props.workspaceId] as const,([platform,ws])=>{
  if(ws){allocationAgent.value="";void props.agents.loadWorkspace(ws);}
  else if(platform){void props.agents.refreshNodes();void props.agents.loadDirectory();}
},{immediate:true});
watch(allocationAgent,id=>{if(id&&props.workspaceId)void props.agents.loadAllocation(props.workspaceId,id);});
async function saveNode(){
  const node=props.agents.node;if(!node||locked.value)return;
  const config: Record<string,unknown>={};
  for(const key of agentFields){if(String(draft.value[key])===String(displayValue(key,node.config[key])))continue;const value=key==="scriptMode"?draft.value[key]:wireValue(key,draft.value[key]??"");if(value!==node.config[key])config[key]=value;}
  await props.agents.saveNode(node.id,config as AgentPatch,{name:nodeName.value,acceptingJobs:accepting.value,expectedPolicyVersion:node.agentPolicy.version,policy:{maxQueuedJobs:queue.value}});
}
async function saveWorkspace(){
  if(!props.workspaceId)return;
  const patch:Record<string,unknown>={};for(const [key,value] of Object.entries(policyDraft.value))if(value!=="")patch[key]=wireValue(key,value);
  if(queueNever.value)patch.queueTimeoutMs=null;
  await props.agents.saveWorkspace(props.workspaceId,patch as PolicyPatch);
}
function nodeEffective(key:keyof typeof defaultAgentConfig){return props.agents.node?.restrictions.find(r=>r.field===`agent.${key}`)?.effectiveValue??props.agents.node?.config[key];}
function refresh(){
  if(props.workspaceId){void props.agents.loadWorkspace(props.workspaceId);allocationAgent.value="";}
  else if(props.agents.node)void props.agents.selectNode(props.agents.node.id);
  else void props.agents.refreshNodes();
}
</script>
<template>
  <section class="agents-view" data-testid="agents-view">
    <h2>{{ t(workspaceId ? "agents.workspaceTitle" : "agents.title") }}</h2>
    <p>{{ t("agents.scopeHint") }}</p>
    <p v-if="agents.error" role="alert">{{ agents.error }}</p>
    <ul v-if="agents.validationIssues.length" role="alert"><li v-for="(issue,index) in agents.validationIssues" :key="index">{{validationMessage(issue,t)}}</li></ul>
    <p v-if="agents.conflict" role="alert">{{ t("agents.conflict") }}</p>
    <button @click="refresh">{{ t("agents.reload") }}</button>
    <template v-if="workspaceId">
      <h3>{{ t("agents.allocations") }}</h3>
      <label>{{ t("agents.agent") }} <select v-model="allocationAgent"><option value="">{{ t("agents.choose") }}</option><option v-for="n in agents.available" :key="n.id" :value="n.id">{{ n.name }} · {{ n.id }}</option></select></label>
      <div v-if="allocationAgent" class="checks">
        <p v-if="agents.allocationStatus==='loading'">{{t('agents.allocationLoading')}}</p>
        <p v-if="agents.allocationStatus==='failed'">{{t('agents.allocationFailed')}} <button @click="agents.loadAllocation(workspaceId,allocationAgent)">{{t('agents.reload')}}</button></p>
        <label v-for="p in agents.projects" :key="p.id"><input type="checkbox" v-model="allocationIds" :value="p.id" :disabled="allocationLocked" />{{ p.name }} · {{ p.id }}</label>
        <button :disabled="allocationLocked" @click="agents.allocate(workspaceId,allocationAgent,allocationIds)">{{ t("agents.saveAllocation") }}</button>
      </div>
      <h3>{{ t("agents.workspacePolicy") }}</h3>
      <p>{{ t("agents.inheritHint") }}</p>
      <form v-if="agents.workspace" @submit.prevent="saveWorkspace">
        <div class="table-scroll"><table><thead><tr><th>{{ t("agents.field") }}</th><th>{{ t("agents.default") }}</th><th>{{ t("agents.effective") }}</th><th>{{ t("agents.source") }}</th><th>{{ t("agents.override") }}</th></tr></thead>
          <tbody><tr v-for="key in policyFields" :key="key"><th>{{ t(`agents.fields.${key}`) }} ({{ t(`agents.units.${fieldUnit(key)}`) }})</th><td>{{ displayValue(key,defaultPolicyConfig[key]) }}</td><td>{{ displayValue(key,agents.workspace.policy[key]) }}</td><td>{{ t(`agents.sources.${agents.workspace.sources[`policy.${key}`]??'default'}`) }}</td><td><input type="number" step="any" :value="policyDraft[key]" @input="policyDraft[key]=($event.target as HTMLInputElement).value" :aria-label="t(`agents.fields.${key}`)" :disabled="agents.busy||agents.conflict" /></td></tr></tbody></table></div>
        <p>{{ t("agents.savedVersion") }}: {{ agents.workspace.configVersion }} · {{ t("agents.policyVersion") }}: {{ agents.workspace.policyVersion }}</p>
        <label><input type="checkbox" v-model="queueNever" :disabled="agents.busy||agents.conflict" />{{t('agents.queueNever')}}</label>
        <p>{{t('agents.retentionHint')}}</p>
        <button :disabled="agents.busy||agents.conflict">{{ t("agents.savePolicy") }}</button>
      </form>
    </template>
    <template v-else>
      <form v-if="platform" class="toolbar" @submit.prevent="agents.createNode(createName)"><label>{{ t("agents.name") }} <input required maxlength="128" v-model="createName" /></label><button :disabled="agents.busy">{{ t("agents.create") }}</button></form>
      <div class="node-layout">
        <nav :aria-label="t('agents.title')"><button v-for="n in agents.nodes" :key="n.id" @click="platform&&agents.selectNode(n.id)">{{ n.name }} · {{ n.id }}<span v-if="n.revoked"> · {{ t("agents.availability.revoked") }}</span></button></nav>
        <div v-if="agents.node" class="node-detail">
          <p>{{ t(`agents.availability.${agents.node.availability}`) }} · {{ t("agents.lastSeen") }}: {{ readableTime(agents.node.lastSeenAt) }}</p>
          <p data-testid="agent-application">{{ t(`agents.application.${agents.node.status}`) }} · {{ t("agents.savedVersion") }}: {{ agents.node.configVersion }} · {{ t("agents.appliedVersion") }}: {{ agents.node.appliedConfigVersion }}<span v-if="agents.node.runtime"> · {{ t("agents.runtimeAppliedVersion") }}: {{ agents.node.runtime.configuration.appliedConfigVersion }}</span></p>
          <p>{{ t("agents.pending") }}: {{ agents.node.pendingFields.map(k=>t(`agents.fields.${k}`)).join('、')||t('agents.none') }} · {{ t("agents.restart") }}: {{ agents.node.restartRequiredFields.map(k=>t(`agents.fields.${k}`)).join('、')||t('agents.none') }}</p>
          <p>{{ t("agents.applicationHint") }}</p>
          <p>{{t('agents.deploymentCeiling')}}: {{agents.node.deployment.maxAgentConcurrentJobs}} · {{t('agents.externalMemory')}}: {{agents.node.deployment.agentMemoryLimitBytes===null?t('agents.notConfigured'):displayValue('agentMemoryLimitBytes',agents.node.deployment.agentMemoryLimitBytes)+' MiB'}} · {{t('agents.externalCpu')}}: {{agents.node.deployment.agentCpuLimit??t('agents.notConfigured')}}</p>
          <div v-if="agents.node.runtime" class="runtime">
            <p>Node {{ agents.node.runtime.nodeVersion }} · V8 {{ agents.node.runtime.v8Version }} · {{ t("agents.protocol") }} {{ agents.node.runtime.protocolVersion }}</p>
            <p>{{ t("agents.capabilities") }}: {{ agents.node.runtime.capabilities.join(', ') }}</p>
            <details><summary>{{ t("agents.runtimeIdentity") }} · Core {{ agents.node.runtime.coreBuildId.slice(0,12) }}</summary><dl><dt>Core</dt><dd>{{ agents.node.runtime.coreBuildId }}</dd><dt>{{ t("agents.scriptApi") }}</dt><dd>{{ agents.node.runtime.scriptApiId }}</dd><dt>{{ t("agents.compatibility") }}</dt><dd>{{ agents.node.runtime.runtimeCompatibilityId }}</dd></dl></details>
          </div>
          <form @submit.prevent="saveNode">
            <label>{{ t("agents.name") }} <input v-model="nodeName" :disabled="locked" required maxlength="128" /></label>
            <label><input type="checkbox" v-model="accepting" :disabled="locked" />{{ t("agents.accepting") }}</label>
            <p v-if="!platform">{{ t("agents.platformOnly") }}</p>
            <div class="table-scroll"><table><thead><tr><th>{{ t("agents.field") }}</th><th>{{ t("agents.default") }}</th><th>{{ t("agents.effective") }}</th><th>{{ t("agents.source") }}</th><th>{{ t("agents.edit") }}</th></tr></thead>
              <tbody><tr v-for="key in agentFields" :key="key"><th>{{ t(`agents.fields.${key}`) }} {{key==='scriptMode'?'':`(${t(`agents.units.${fieldUnit(key)}`)})`}}</th><td>{{ key==='scriptMode'?t(`agents.scriptModes.${defaultAgentConfig[key]}`):displayValue(key,defaultAgentConfig[key]) }}</td><td>{{ key==='scriptMode'?t(`agents.scriptModes.${agents.node.config[key]}`):displayValue(key,nodeEffective(key)) }}</td><td>{{ t(`agents.sources.${agents.node.sources[key]??'default'}`) }}</td><td>
<select v-if="key==='scriptMode'" v-model="draft[key]" :disabled="locked" :aria-label="t(`agents.fields.${key}`)"><option value="deny">{{ t('agents.scriptModes.deny') }}</option><option value="trusted-core">{{ t('agents.scriptModes.trusted-core') }}</option></select>
                <input v-else type="number" step="any" required :value="draft[key]" @input="draft[key]=($event.target as HTMLInputElement).value" :disabled="locked" :aria-label="t(`agents.fields.${key}`)" :data-testid="key==='maxConcurrentJobs'?'agent-concurrency':undefined" />
              </td></tr></tbody></table></div>
            <label>{{ t("agents.agentQueue") }} ({{ t('agents.units.count') }}) <input type="number" min="1" step="1" required v-model.number="queue" :disabled="locked" /></label>
            <p>{{ t("agents.trustedRisk") }}</p>
            <ul v-if="agents.node.restrictions.length"><li v-for="r in agents.node.restrictions" :key="r.field">{{ t(`agents.fields.${r.field.split('.').pop()}`) }}: {{ displayValue(r.field.split('.').pop()!,r.effectiveValue) }} · {{ t("agents.restrictedBy") }} {{ t(`agents.fields.${r.reason.split('.').pop()}`) }}</li></ul>
            <button data-testid="agent-save" :disabled="locked">{{ t("agents.save") }}</button>
          </form>
          <template v-if="platform">
            <h3>{{ t("agents.workspaceGrants") }}</h3>
            <p>{{ t("agents.grantsHint") }}</p>
            <div class="checks"><label v-for="w in agents.directory" :key="w.id"><input type="checkbox" v-model="grantIds" :value="w.id" :disabled="agents.busy" />{{ w.name }} · {{ w.id }}</label></div>
            <button :disabled="agents.busy||agents.conflict" @click="agents.saveGrants(agents.node.id,grantIds)">{{ t("agents.saveGrants") }}</button>
            <h3>{{ t("agents.registration") }}</h3>
            <button :disabled="agents.busy||agents.node.revoked" @click="agents.issueEnrollment(agents.node.id)">{{ t("agents.issueEnrollment") }}</button>
            <div v-if="agents.enrollment"><p>{{ t("agents.enrollmentHint") }} · {{ t("agents.expires") }} {{ readableTime(agents.enrollment.expiresAt) }}</p><output class="token">{{ agents.enrollment.enrollmentToken }}</output><button @click="agents.enrollment=null">{{ t('agents.hideEnrollment') }}</button></div>
            <label><input type="checkbox" v-model="revokeConfirmed" />{{ t("agents.revokeConfirm") }}</label>
            <button :disabled="!revokeConfirmed||agents.busy||agents.node.revoked" @click="agents.revoke(agents.node.id)">{{ t("agents.revoke") }}</button>
          </template>
        </div>
        <p v-else>{{ t("agents.choose") }}</p>
      </div>
    </template>
  </section>
</template>
<style scoped>
.agents-view {max-width:1500px} h2{margin-top:0} p,li{line-height:1.65} .toolbar,label{display:flex;align-items:center;gap:8px;margin:10px 0;flex-wrap:wrap} button,input,select{font:inherit;padding:6px 10px}button{cursor:pointer}button:disabled{cursor:default}.node-layout{display:grid;grid-template-columns:minmax(160px,220px) minmax(0,1fr);gap:20px;margin-top:16px}nav{display:flex;flex-direction:column;gap:8px;max-height:70vh;overflow:auto}nav button{text-align:left;overflow-wrap:anywhere}.node-detail{min-width:0}.table-scroll{max-height:52vh;overflow:auto;margin:12px 0;background:white;border:1px solid #ddd}table{border-collapse:collapse;min-width:790px;width:100%}th,td{padding:9px 12px;text-align:left;border-bottom:1px solid #eee;white-space:nowrap}thead{position:sticky;top:0;background:#fafafa}td input{width:140px}dd{overflow-wrap:anywhere}.checks{max-height:260px;overflow:auto}.token{display:block;overflow-wrap:anywhere;padding:12px;background:#fff7e6}[role=alert]{color:#a8071a}details{margin:12px 0}@media(max-width:850px){.node-layout{grid-template-columns:1fr}nav{max-height:150px}}
</style>

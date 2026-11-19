<script setup lang="ts">
import { EllipsisOutlined, FileOutlined, PlusOutlined } from "@ant-design/icons-vue";
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { confirmOnlineStress, runOnlineStress } from '../../execution/launch.js';
import { ZodError } from 'zod';
import { StressPlanSchema } from '@apicc/core/schema';
import type { StressPlan, StressTarget, ContractCollection, ContractFolder } from '@apicc/core';
import type { OnlineExecutionStore } from '../../stores/onlineExecution.js';
import ActionMenu from "../ActionMenu.vue";
import StressLoadEditor from '../StressLoadEditor.vue';
import {resolveStressExecutionConfig} from '@apicc/execution/contract';
import { onlineSessionErrorKey } from '../../i18n/index.js';
const props = defineProps<{ execution: OnlineExecutionStore; readOnly?: boolean; shortcut?: StressTarget }>();
const emit = defineEmits<{ record: [id: string] }>();
const search = ref("");
const showLoadSettings = ref(false), rename = ref(false);
const submitted = computed(() => props.execution.submissions.find(item => item.target.stressPlanId === selected.value));
const submittedId = computed(() => submitted.value?.runId);
const { t } = useI18n();
const selected = ref('');
const plans = computed(() => props.execution.project?.stressPlans ?? []);
const plan = ref<StressPlan | null>(null), name = ref(''), origins = ref(''), error = ref(''), valid = ref(false), saving = ref(false);
watch(origins, () => props.execution.invalidateStressConfirmation(), { flush: 'sync' });
const saved = computed(() => plans.value.find(item => item.id === selected.value));
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
function choosePlan(id: string) {
  if (id && !plans.value.some(item => item.id === id) || !confirmLeave()) return;
  pick(id);
}
function pick(id: string) {
  showLoadSettings.value = false; rename.value = false;
  selected.value = id;
  plan.value = saved.value ? clone(saved.value.plan) : null; name.value = saved.value?.name ?? ''; origins.value = ''; error.value = '';
  props.execution.invalidateStressConfirmation();
}
watch(() => props.execution.context, () => { search.value = ''; selected.value = ''; plan.value = null; name.value = ''; origins.value = ''; error.value = ''; });
const targetKey = (target: StressTarget) => target.kind === 'workflow' ? `workflow:${target.workflowId}` : `case:${target.collectionId}:${target.apiId}:${target.caseId}`;
const targets = computed(() => {
  const project = props.execution.latestView?.project ?? props.execution.project;
  const values: Array<{ label: string; target: StressTarget }> = (project?.workflows ?? []).map(workflow => ({ label: `${t('stress.workbench.workflow')} · ${workflow.name}`, target: { kind: 'workflow', workflowId: workflow.id } }));
  for (const collection of project?.collections ?? []) {
    const visit = (container: ContractCollection | ContractFolder) => {
      for (const asset of container.apis) if (asset.contract.request.protocol === 'http') for (const testCase of asset.cases) values.push({ label: `${collection.name} / ${asset.contract.metadata.name} / ${testCase.name}`, target: { kind: 'case', collectionId: collection.id, apiId: asset.contract.id, caseId: testCase.id } });
      for (const folder of container.folders) visit(folder);
    };
    visit(collection);
  }
  return values;
});
const targetAvailable = computed(() => !!plan.value && targets.value.some(item => targetKey(item.target) === targetKey(plan.value!.target)));
function newPlan(shortcut?: StressTarget) {
  if (props.readOnly || props.execution.running || !confirmLeave()) return;
  const target = shortcut ? targets.value.find(row => targetKey(row.target) === targetKey(shortcut))?.target : targets.value[0]?.target; if (!target) { error.value = t('onlineStressDraft.noTargets'); return; }
  showLoadSettings.value = false; rename.value = false;
  selected.value = crypto.randomUUID(); name.value = t('stress.workbench.new'); origins.value = ''; error.value = '';
  plan.value = StressPlanSchema.parse({ formatVersion: 1, target: clone(target), load: { kind: 'constant-vus', vus: 1 }, termination: { maxIterations: 10 } });
}
function target(value: string) { const next = targets.value.find(item => targetKey(item.target) === value); if (plan.value && next && !props.readOnly && !props.execution.running) { plan.value.target = clone(next.target); props.execution.invalidateStressConfirmation(); } }
const dirty = computed(() => !!plan.value && (!saved.value || name.value !== saved.value.name || JSON.stringify(plan.value) !== JSON.stringify(saved.value.plan)));
function confirmLeave() { return !dirty.value || window.confirm(t("testing.discardConfirm")); }
watch(() => props.shortcut, shortcut => { if (shortcut) newPlan(shortcut); }, { immediate: true });
const dirtyStressPlanId = computed(() => dirty.value ? selected.value : null);
defineExpose({ confirmLeave, dirtyStressPlanId });
const agent = computed(() => props.execution.location.kind === 'agent' ? props.execution.agents?.agents.find(row => props.execution.location.kind === 'agent' && row.id === props.execution.location.agentId) : undefined);
const admissionRows=computed(()=>{const configuration=agent.value?.stressConfiguration;if(!configuration||!agent.value)return [];return [
  {label:t('stressPresentation.requestConcurrency'),scope:t('stressPresentation.agent'),value:configuration.agent.maxStressRequestConcurrency,unit:t('stressPresentation.requestUnit'),source:configuration.sources['agent.maxStressRequestConcurrency']},
  {label:t('stressPresentation.rps'),scope:t('stressPresentation.agent'),value:configuration.agent.maxStressRps,unit:t('stressPresentation.rpsUnit'),source:configuration.sources['agent.maxStressRps']},
  {label:t('stressPresentation.requestConcurrency'),scope:t('stressPresentation.project'),value:agent.value.policy.maxStressRequestConcurrency,unit:t('stressPresentation.requestUnit'),source:configuration.sources['policy.maxStressRequestConcurrency']},
  {label:t('stressPresentation.rps'),scope:t('stressPresentation.project'),value:agent.value.policy.maxStressRps,unit:t('stressPresentation.rpsUnit'),source:configuration.sources['policy.maxStressRps']},
];});
const unavailable = computed(() => props.execution.location.kind === 'agent' && (!agent.value || agent.value.availability !== 'available' || agent.value.configuration.status !== 'applied' || !agent.value.runtime?.capabilities.includes('task:stress') || !agent.value.runtime.capabilities.includes('stress:local-workers-v1')));
const workerLimit=computed(()=>{
  if(!plan.value)return undefined;
  if(!agent.value)return Math.min(props.execution.agents?.policy.maxStressWorkers??1000,plan.value.maxVus);
  try{return resolveStressExecutionConfig(plan.value,{workerCount:1},{...agent.value.stressConfiguration,policy:agent.value.policy}).effectiveWorkerLimit;}catch{return 0;}
});
const environmentMismatch = computed(() => !!plan.value?.environmentId && !!props.execution.environmentId && plan.value.environmentId !== props.execution.environmentId);
const canRun = computed(() => !!plan.value && targetAvailable.value && valid.value && (workerLimit.value === undefined || props.execution.stressWorkerCount <= workerLimit.value) && !props.readOnly && !dirty.value && !props.execution.dirty && !props.execution.running && !unavailable.value && !environmentMismatch.value && !(props.execution.location.kind === 'agent' && props.execution.localOnlyRefIds.length) && props.execution.isStressConfirmed(plan.value));
const errorText = computed(() => {
  const key = onlineSessionErrorKey(error.value);
  if (key) return t(key);
  if (error.value === 'version_conflict') return t('onlineStress.conflict');
  return ['stress-local-budget-exceeded','stress-worker-policy-exceeded','stress-capacity-exceeded'].includes(error.value) ? t(`stressFinal.codes.${error.value}`) : error.value;
});
const stopTarget = computed(() => {
  const run = submitted.value;
  if (!run || run.target.kind !== 'stress') return null;
  if (run.location.kind === 'local') return run.runId === props.execution.activeStressLocalRunId ? { kind: 'local' as const } : null;
  const ref = run.agentRef;
  if (!ref || !run.job) return null;
  const job = props.execution.jobs.find(item => item.agentId === ref.agentId && item.jobId === ref.jobId && item.executionId === ref.executionId) ?? run.job;
  return job.canCancel && job.state !== 'ended' && job.cancelState !== 'requested' ? { kind: 'agent' as const, job } : null;
});
const canStop = computed(() => !!stopTarget.value);
async function action(operation: () => Promise<unknown> | void) { const context = JSON.stringify(props.execution.context); try { await operation(); } catch (cause) { if (context === JSON.stringify(props.execution.context)) error.value = cause instanceof Error ? cause.message : String(cause); } }
async function save() {
  if (!plan.value || !props.execution.project || props.readOnly || props.execution.running || !valid.value || !targetAvailable.value || !name.value.trim()) return;
  const next = clone(props.execution.project), item = { formatVersion: 1 as const, id: selected.value, name: name.value, updatedAt: Date.now(), plan: StressPlanSchema.parse(clone(plan.value)) };
  next.stressPlans = [...(next.stressPlans ?? []).filter(row => row.id !== item.id), item];
  const owner = JSON.stringify(props.execution.context), id = selected.value;
  saving.value = true;
  try { await props.execution.saveProject(next); if (owner !== JSON.stringify(props.execution.context) || id !== selected.value) return; if (saved.value) { plan.value = clone(saved.value.plan); name.value = saved.value.name; } error.value = ''; }
  finally { saving.value = false; }
}
function confirm() {
  if (!plan.value || !targetAvailable.value || props.readOnly || dirty.value || !valid.value || props.execution.running) return;
  try { confirmOnlineStress(props.execution, plan.value, origins.value); error.value = ''; }
  catch (cause) { if (cause instanceof ZodError) throw new Error(t('onlineStressDraft.invalidRunConfiguration')); throw cause; }
}
function environment(value: string) { if (!plan.value) return; if (value) plan.value.environmentId = value; else delete plan.value.environmentId; props.execution.invalidateStressConfirmation(); }
async function stop() { const target = stopTarget.value; if (target?.kind === 'local') await props.execution.cancelLocal(); else if (target?.kind === 'agent') await props.execution.cancel(target.job); }
async function run() {
  if (!plan.value || !canRun.value) return;
  await runOnlineStress(props.execution, plan.value, selected.value);
}
</script>
<template>
  <section class="online-stress online-surface" data-testid="online-stress-panel">
    <aside class="plan-list">
      <header><h2>{{ t('testPresentation.stressPlan') }}</h2><button data-testid="online-stress-new" :disabled="readOnly || execution.running" @click="newPlan()"><PlusOutlined /> {{ t('testAssets.new') }}</button></header>
      <input v-model="search" :placeholder="t('testAssets.searchPlans')" :aria-label="t('testAssets.searchPlans')"/>
      <div class="plans"><button v-if="plan && !saved" class="plan-row" aria-current="true" :title="name">{{ name }}</button>
        <button v-for="item in plans.filter(item => item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))" :key="item.id" class="plan-row"
          :title="item.name" :data-plan-id="item.id" :aria-current="selected === item.id ? 'true' : undefined" @click="choosePlan(selected === item.id ? '' : item.id)">{{ item.name }}</button>
      </div>
    </aside>
    <article class="asset-detail">
      <div v-if="!plan" class="empty-state"><FileOutlined /><h2>{{ t('testAssets.pickPlan') }}</h2><p>{{ t(plans.length || readOnly ? 'testAssets.choosePlan' : 'testAssets.newPlanHint') }}</p></div>
      <template v-else>
        <header class="asset-heading"><h2>{{ name }}</h2><span class="saved-state">{{ t(dirty ? 'testing.unsaved' : 'testAssets.saved') }}</span><div class="asset-actions">
          <button class="primary" :disabled="!valid || !targetAvailable || saving || readOnly || execution.running" data-testid="online-stress-save" @click="action(save)">{{ t('stress.workbench.save') }}</button>
          <ActionMenu test-id="stress-plan-more" :label="t('requestWorkbench.more')" :items="[{ key:'settings', label:t('testAssets.loadSettings') }, { key:'name', label:t('testAssets.editName'), disabled:readOnly }]"
            @select="key => key === 'name' ? rename = !rename : showLoadSettings = !showLoadSettings"><EllipsisOutlined /></ActionMenu>
          </div></header>
        <section class="plan-fields"><h3>{{ t('testAssets.planConfig') }}</h3>
          <label v-if="!saved || rename">{{ t('stress.workbench.name') }}<input v-model="name" :disabled="readOnly || execution.running" data-testid="online-stress-name" /></label>
          <label>{{ t('onlineStressDraft.target') }}<select :value="targetKey(plan.target)" :disabled="readOnly || execution.running" data-testid="online-stress-target" @change="target(($event.target as HTMLSelectElement).value)"><option v-for="item in targets" :key="targetKey(item.target)" :value="targetKey(item.target)" :title="item.label">{{ item.label }}</option></select></label>
          <p v-if="!targetAvailable" role="alert">{{ t('testAssets.targetMissing') }}</p>
          <label>{{ t('projectWorkbench.planEnvironment') }}<select :value="plan.environmentId ?? ''" :disabled="execution.running || readOnly" data-testid="online-stress-environment" @change="environment(($event.target as HTMLSelectElement).value)"><option value="">{{ t('testAssets.followEnvironment', {name:execution.project?.environments.find(env => env.id === execution.environmentId)?.name ?? t('onlineExecution.baseEnvironment')}) }}</option><option v-for="env in execution.project?.environments" :key="env.id" :value="env.id">{{ env.name }}</option></select></label>
          <p v-if="environmentMismatch" role="alert">{{ t('onlineStress.environmentMismatch') }}</p>
          <StressLoadEditor compact :expanded="showLoadSettings" :plan="plan" :disabled="!!readOnly || execution.running" :workflows="execution.project?.workflows ?? []" :envs="execution.project?.environments ?? []" @valid="valid = $event" />
        </section>
        <section class="plan-fields"><h3>{{ t('testAssets.thisRun') }}</h3>
          <div class="location-row"><span>{{ t('onlineExecution.location') }}</span><strong>{{ execution.location.kind === 'local' ? t('onlineExecution.local') : agent?.name ?? execution.location.agentId }}</strong></div>
          <p v-if="unavailable" role="alert">{{ t('onlineStress.agentUnavailable') }}</p>
          <p v-if="execution.location.kind === 'agent' && execution.localOnlyRefIds.length" role="alert">{{ t('onlineStress.localMaterials') }}</p>
    <details v-if="agent?.stressConfiguration" class="admission" data-testid="online-stress-admission">
      <summary>{{t('stressPresentation.currentAdmission')}}</summary><p>{{t('stressPresentation.admissionHint')}}</p>
      <p>{{t('stressPresentation.savedVersion')}} {{agent.configuration.configVersion}} · {{t('stressPresentation.appliedVersion')}} {{agent.configuration.appliedConfigVersion}}</p>
      <div class="table-scroll"><table><thead><tr><th>{{t('stressPresentation.field')}}</th><th>{{t('stressPresentation.bound')}}</th><th>{{t('stressPresentation.source')}}</th></tr></thead><tbody><tr v-for="(row,index) in admissionRows" :key="index"><th>{{row.scope}} · {{row.label}}</th><td>{{row.value}} {{row.unit}}</td><td>{{t(`stressPresentation.${row.source}`)}}</td></tr></tbody></table></div>
      <p>{{t('stressPresentation.agent')}}: {{agent.stressConfiguration.agent.maxConcurrentStressJobs}} {{t('stressPresentation.jobs')}} · {{agent.stressConfiguration.agent.maxStressProcesses}} {{t('stressPresentation.processUnit')}} · {{agent.stressConfiguration.agent.maxStressVus}} VU · {{agent.stressConfiguration.agent.maxStressMetricMemoryBytes/1048576}} MiB</p>
      <p>{{t('stressPresentation.project')}}: {{agent.policy.maxStressWorkers}} worker/{{t('stressPresentation.jobs')}} · {{agent.policy.maxStressVus}} VU · {{agent.policy.stressMetricMemoryBytes/1048576}} MiB/{{t('stressPresentation.processUnit')}} · {{agent.policy.stressEvidenceMaxSamples}} {{t('stressPresentation.samples')}}/{{t('stressPresentation.jobs')}}</p>
      <p>{{t('stressPresentation.budgetHint')}}</p>
    </details>
    <label>{{ t('testAssets.processes') }}<input v-model.number="execution.stressWorkerCount" type="number" min="1" :max="workerLimit" :disabled="execution.running" data-testid="online-stress-workers" /></label>
    <p v-if="workerLimit!==undefined && execution.stressWorkerCount > workerLimit" role="alert">{{t('stressCapacity.workerIntersection',{count:workerLimit})}}</p>
    <label>{{ t('testAssets.origins') }}<input v-model="origins" :title="t('onlineStress.origins')" placeholder="https://orders.example.test" data-testid="online-stress-origins" :disabled="execution.running" /></label>
    <p v-if="errorText" role="alert">{{ errorText }}</p>
    <div class="run-actions"><button :disabled="readOnly || dirty || !valid || !targetAvailable || execution.running" data-testid="online-stress-confirm" @click="action(confirm)">{{ t('testAssets.confirmTarget') }}</button>
    <button :disabled="!canRun" data-testid="online-stress-run" @click="action(run)">{{ t('testAssets.startStress') }}</button></div>
      </section>
    <button v-if="submittedId" @click="emit('record', submittedId)">{{ t('projectWorkbench.viewRun') }}</button>
    <button v-if="canStop" data-testid="online-stress-stop" @click="action(stop)">{{ t('stress.stop') }}</button>
      </template>
    </article>
  </section>
</template>
<style scoped src="../../styles/online-controls.css"></style>
<style scoped src="../../styles/testing-assets.css"></style>
<style scoped>
.online-stress { padding:0; min-height:0; min-width:0; display:grid; grid-template-columns:minmax(148px,28%) minmax(0,1fr); gap:8px; overflow:hidden; height:100%; }
.plan-list { display:flex; flex-direction:column; min-height:0; min-width:0; border:1px solid var(--border); border-radius:7px; background:var(--bg); padding:11px; gap:9px; }
.plan-list header {display:flex;align-items:center;justify-content:space-between;gap:6px;}
.plan-list h2 {margin:0;font-size:18px;}
.plan-list header button {background:var(--accent);color:#fff;border-color:var(--accent);font-weight:600;}
.plan-list header button:hover:not(:disabled) {background:var(--accent);color:#fff;filter:brightness(.94);}
.plan-list header button:disabled {background:var(--subtle);color:var(--text-muted);border-color:var(--border);opacity:.65;}
.plans {overflow:auto;}
.plan-row { display:block; width:100%; text-align:start; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; border:0; border-bottom:1px solid var(--border); border-inline-start:4px solid transparent; border-radius:0; }
.plan-row[aria-current] {background:var(--workbench-form-selected);border-inline-start-color:var(--accent);font-weight:600;}
.asset-detail { overflow:auto; min-height:0; }
.asset-heading h2 {margin:0;}
.plan-fields { border-top:1px solid var(--border); padding-top:6px; }
.plan-fields h3 { margin:0 0 6px; font-size:17px; }
.plan-fields label,.location-row { display:grid; grid-template-columns:minmax(80px,16%) minmax(0,440px); gap:10px; align-items:center; margin:5px 0; }
.plan-fields input[type=number] {width:min(100%,180px);}
.plan-fields :deep(.load-editor) {margin:0;padding:0;border:0;background:transparent;}
.plan-fields .location-row strong {font-weight:400;}
.run-actions {display:flex;gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap;}
.run-actions button:first-child {color:var(--accent);border-color:var(--accent);}
.plan-fields :deep(.basic-load label) { display:grid; grid-template-columns:minmax(80px,16%) minmax(0,180px); justify-content:stretch; }
.plan-fields :deep(.basic-load input) { max-width:100%; }
.plan-fields :deep(.load-editor) {gap:0;}
.plan-fields :deep(.advanced) { margin:0; }
.admission {margin:6px 0;}
.admission .table-scroll {max-height:220px;}
.empty-state {border:0;background:transparent;}
</style>

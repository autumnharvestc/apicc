<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ZodError } from 'zod';
import { StressPlanSchema } from '@apicc/core/schema';
import type { StressPlan, StressTarget, ContractCollection, ContractFolder } from '@apicc/core';
import type { OnlineExecutionStore } from '../../stores/onlineExecution.js';
import StressLoadEditor from '../StressLoadEditor.vue';
import {resolveStressExecutionConfig} from '@apicc/execution/contract';
const props = defineProps<{ execution: OnlineExecutionStore; readOnly?: boolean }>();
const { t } = useI18n();
const selected = ref('');
const plans = computed(() => props.execution.project?.stressPlans ?? []);
const plan = ref<StressPlan | null>(null), name = ref(''), origins = ref(''), error = ref(''), valid = ref(false), saving = ref(false);
watch(origins, () => props.execution.invalidateStressConfirmation(), { flush: 'sync' });
const saved = computed(() => plans.value.find(item => item.id === selected.value));
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
function pick(id: string) {
  selected.value = id;
  plan.value = saved.value ? clone(saved.value.plan) : null; name.value = saved.value?.name ?? ''; origins.value = ''; error.value = '';
  if (plan.value?.environmentId) props.execution.environmentId = plan.value.environmentId;
}
watch(() => props.execution.context, () => { selected.value = ''; plan.value = null; name.value = ''; origins.value = ''; error.value = ''; });
const targetKey = (target: StressTarget) => target.kind === 'workflow' ? `workflow:${target.workflowId}` : `case:${target.collectionId}:${target.apiId}:${target.caseId}`;
const targets = computed(() => {
  const values: Array<{ label: string; target: StressTarget }> = (props.execution.project?.workflows ?? []).map(workflow => ({ label: `${t('stress.workbench.workflow')} · ${workflow.name}`, target: { kind: 'workflow', workflowId: workflow.id } }));
  for (const collection of props.execution.project?.collections ?? []) {
    const visit = (container: ContractCollection | ContractFolder) => {
      for (const asset of container.apis) if (asset.contract.request.protocol === 'http') for (const testCase of asset.cases) values.push({ label: `${collection.name} / ${asset.contract.metadata.name} / ${testCase.name}`, target: { kind: 'case', collectionId: collection.id, apiId: asset.contract.id, caseId: testCase.id } });
      for (const folder of container.folders) visit(folder);
    };
    visit(collection);
  }
  return values;
});
function newPlan() {
  if (props.readOnly || props.execution.running) return;
  const target = targets.value[0]?.target; if (!target) { error.value = t('onlineStressDraft.noTargets'); return; }
  selected.value = crypto.randomUUID(); name.value = t('stress.workbench.new'); origins.value = ''; error.value = '';
  plan.value = StressPlanSchema.parse({ formatVersion: 1, target: clone(target), load: { kind: 'constant-vus', vus: 1 }, termination: { maxIterations: 10 }, ...(props.execution.environmentId ? { environmentId: props.execution.environmentId } : {}) });
}
function target(value: string) { const next = targets.value.find(item => targetKey(item.target) === value); if (plan.value && next && !props.readOnly && !props.execution.running) plan.value.target = clone(next.target); }
const dirty = computed(() => !!plan.value && (!saved.value || name.value !== saved.value.name || JSON.stringify(plan.value) !== JSON.stringify(saved.value.plan)));
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
const canRun = computed(() => !!plan.value && valid.value && !dirty.value && !props.execution.dirty && !props.execution.running && !unavailable.value && !environmentMismatch.value && !(props.execution.location.kind === 'agent' && props.execution.localOnlyRefIds.length) && props.execution.isStressConfirmed(plan.value));
const errorText = computed(() => error.value === 'version_conflict' ? t('onlineStress.conflict') : ['stress-local-budget-exceeded','stress-worker-policy-exceeded','stress-capacity-exceeded'].includes(error.value) ? t(`stressFinal.codes.${error.value}`) : error.value);
const selectedJob = computed(() => { const selection = props.execution.resultSelection; return selection?.kind === 'agent' && 'job' in selection && selection.job.task.target.kind === 'stress' ? props.execution.jobs.find(job => job.jobId === selection.job.jobId && job.executionId === selection.job.executionId) : undefined; });
const stopTarget = computed(() => {
  const selection = props.execution.resultSelection;
  if (selection?.kind === 'local' && selection.runId === props.execution.activeStressLocalRunId) return { kind: 'local' as const };
  const job = selectedJob.value;
  return job?.canCancel && job.state !== 'ended' && job.cancelState !== 'requested' ? { kind: 'agent' as const, job } : null;
});
const canStop = computed(() => !!stopTarget.value);
async function action(operation: () => Promise<unknown> | void) { const context = JSON.stringify(props.execution.context); try { await operation(); } catch (cause) { if (context === JSON.stringify(props.execution.context)) error.value = cause instanceof Error ? cause.message : String(cause); } }
async function save() {
  if (!plan.value || !props.execution.project || props.readOnly || props.execution.running || !valid.value || !name.value.trim()) return;
  const next = clone(props.execution.project), item = { formatVersion: 1 as const, id: selected.value, name: name.value, updatedAt: Date.now(), plan: StressPlanSchema.parse(clone(plan.value)) };
  next.stressPlans = [...(next.stressPlans ?? []).filter(row => row.id !== item.id), item];
  saving.value = true;
  try { await props.execution.saveProject(next); if (saved.value) { plan.value = clone(saved.value.plan); name.value = saved.value.name; } error.value = ''; }
  finally { saving.value = false; }
}
function confirm() {
  if (!plan.value) return;
  try { props.execution.confirmStressOrigins(plan.value, origins.value.split(/[\s,]+/).filter(Boolean)); error.value = ''; }
  catch (cause) { if (cause instanceof ZodError) throw new Error(t('onlineStressDraft.invalidRunConfiguration')); throw cause; }
}
function environment(value: string) { if (!plan.value) return; if (value) plan.value.environmentId = value; else delete plan.value.environmentId; props.execution.environmentId = value || undefined; }
async function stop() { const target = stopTarget.value; if (target?.kind === 'local') await props.execution.cancelLocal(); else if (target?.kind === 'agent') await props.execution.cancel(target.job); }
async function run() { if (plan.value && canRun.value) await props.execution.run({ kind: 'stress', plan: clone(plan.value) }); }
</script>
<template>
  <section class="online-stress" data-testid="online-stress-panel">
    <button data-testid="online-stress-new" :disabled="readOnly || execution.running" @click="newPlan">{{ t('stress.workbench.new') }}</button>
    <label>{{ t('stress.workbench.plans') }}<select :value="selected" :disabled="execution.running" data-testid="online-stress-plan" @change="pick(($event.target as HTMLSelectElement).value)"><option value="">{{ t('stress.workbench.plans') }}</option><option v-if="plan && !saved" :value="selected">{{ name }} · {{ t('onlineStressDraft.unsaved') }}</option><option v-for="item in plans" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
    <label>{{ t('onlineExecution.location') }}<select :value="execution.location.kind === 'local' ? 'local' : execution.location.agentId" :disabled="execution.running" data-testid="online-stress-location" @change="execution.selectLocation(($event.target as HTMLSelectElement).value === 'local' ? { kind: 'local' } : { kind: 'agent', agentId: ($event.target as HTMLSelectElement).value })"><option value="local">{{ t('onlineExecution.local') }}</option><option v-for="agent in execution.agents?.agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option></select></label>
    <label>{{ t('onlineExecution.environment') }}<select :value="plan?.environmentId ?? execution.environmentId ?? ''" :disabled="!plan || execution.running || readOnly" data-testid="online-stress-environment" @change="environment(($event.target as HTMLSelectElement).value)"><option value="">{{ t('onlineExecution.baseEnvironment') }}</option><option v-for="env in execution.project?.environments" :key="env.id" :value="env.id">{{ env.name }}</option></select></label>
    <p>{{ t('onlineStress.loopback') }}</p>
    <p>{{ t(execution.location.kind === 'local' ? 'onlineExecution.localLifetime' : 'onlineExecution.agentLifetime') }}</p>
    <p v-if="errorText" role="alert">{{ errorText }}</p>
    <p v-if="unavailable" role="alert">{{ t('onlineStress.agentUnavailable') }}</p>
    <p v-if="environmentMismatch" role="alert">{{ t('onlineStress.environmentMismatch') }}</p>
    <p v-if="execution.location.kind === 'agent' && execution.localOnlyRefIds.length" role="alert">{{ t('onlineStress.localMaterials') }}</p>
    <section v-if="agent?.stressConfiguration" class="admission" data-testid="online-stress-admission">
      <h4>{{t('stressPresentation.currentAdmission')}}</h4><p>{{t('stressPresentation.admissionHint')}}</p>
      <p>{{t('stressPresentation.savedVersion')}} {{agent.configuration.configVersion}} · {{t('stressPresentation.appliedVersion')}} {{agent.configuration.appliedConfigVersion}}</p>
      <div class="table-scroll"><table><thead><tr><th>{{t('stressPresentation.field')}}</th><th>{{t('stressPresentation.bound')}}</th><th>{{t('stressPresentation.source')}}</th></tr></thead><tbody><tr v-for="(row,index) in admissionRows" :key="index"><th>{{row.scope}} · {{row.label}}</th><td>{{row.value}} {{row.unit}}</td><td>{{t(`stressPresentation.${row.source}`)}}</td></tr></tbody></table></div>
      <p>{{t('stressPresentation.agent')}}: {{agent.stressConfiguration.agent.maxConcurrentStressJobs}} {{t('stressPresentation.jobs')}} · {{agent.stressConfiguration.agent.maxStressProcesses}} {{t('stressPresentation.processUnit')}} · {{agent.stressConfiguration.agent.maxStressVus}} VU · {{agent.stressConfiguration.agent.maxStressMetricMemoryBytes/1048576}} MiB</p>
      <p>{{t('stressPresentation.project')}}: {{agent.policy.maxStressWorkers}} worker/{{t('stressPresentation.jobs')}} · {{agent.policy.maxStressVus}} VU · {{agent.policy.stressMetricMemoryBytes/1048576}} MiB/{{t('stressPresentation.processUnit')}} · {{agent.policy.stressEvidenceMaxSamples}} {{t('stressPresentation.samples')}}/{{t('stressPresentation.jobs')}}</p>
      <p>{{t('stressPresentation.budgetHint')}}</p>
    </section>
    <label v-if="plan">{{ t('stress.workbench.name') }}<input v-model="name" :disabled="readOnly || execution.running" data-testid="online-stress-name" /></label>
    <label v-if="plan">{{ t('onlineStressDraft.target') }}<select :value="targetKey(plan.target)" :disabled="readOnly || execution.running" data-testid="online-stress-target" @change="target(($event.target as HTMLSelectElement).value)"><option v-for="item in targets" :key="targetKey(item.target)" :value="targetKey(item.target)" :title="item.label">{{ item.label }}</option></select></label>
    <StressLoadEditor v-if="plan" :plan="plan" :disabled="!!readOnly || execution.running" :workflows="execution.project?.workflows ?? []" :envs="execution.project?.environments ?? []" @valid="valid = $event" />
    <button :disabled="!plan || !valid || saving || readOnly || execution.running" data-testid="online-stress-save" @click="action(save)">{{ t('stress.workbench.save') }}</button>
    <label>{{ t('onlineStress.workers') }}<input v-model.number="execution.stressWorkerCount" type="number" min="1" :max="workerLimit" :disabled="execution.running" data-testid="online-stress-workers" /></label>
    <p v-if="workerLimit!==undefined">{{t('stressCapacity.workerIntersection',{count:workerLimit})}}</p>
    <label>{{ t('onlineStress.origins') }}<input v-model="origins" data-testid="online-stress-origins" :disabled="execution.running" /></label>
    <button :disabled="!plan || dirty || !valid || execution.running" data-testid="online-stress-confirm" @click="action(confirm)">{{ t('onlineStress.confirm') }}</button>
    <p v-if="plan && !execution.isStressConfirmed(plan)">{{ t('onlineStress.confirmationRequired') }}</p>
    <button :disabled="!canRun" data-testid="online-stress-run" @click="action(run)">{{ t('stress.start') }}</button>
    <button :disabled="!canStop" data-testid="online-stress-stop" @click="action(stop)">{{ t('stress.stop') }}</button>
  </section>
</template>
<style scoped>.online-stress{padding:12px;min-width:0}.online-stress label{display:inline-flex;gap:6px;margin:4px;align-items:center}.online-stress select{max-width:350px}p{overflow-wrap:anywhere}.table-scroll{overflow:auto;max-height:240px}table{width:100%;border-collapse:collapse;white-space:nowrap}th,td{text-align:left;padding:6px;border-bottom:1px solid var(--border,#ddd)}</style>

<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import { useI18n } from "vue-i18n";
import { JsonValueSchema, StressPlanSchema } from "@apicc/core/schema";
import type { JsonValue, StressLifecycleRole, StressPlan } from "@apicc/core";
const props = defineProps<{ plan: StressPlan; disabled: boolean; workflows: Array<{ id: string; name: string }>; envs: Array<{ id: string; name: string }> }>();
const emit = defineEmits<{ valid: [valid: boolean] }>();
const { t } = useI18n();
const roles: StressLifecycleRole[] = ["setup", "vuSetup", "vuTeardown", "teardown"];
type InputRow = { key: string; value: string };
type Mapping = { source: string; target: string };
const rows = reactive<Record<string, InputRow[]>>({});
const maps = reactive<Record<string, Mapping[]>>({});
const errors = reactive<Record<string, boolean>>({});
const toRows = (values: Record<string, JsonValue> | undefined) => Object.entries(values ?? {}).map(([key, value]) => ({ key, value: JSON.stringify(value) }));
watch(() => props.plan, (plan) => {
  for (const key of Object.keys(errors)) delete errors[key];
  rows.target = toRows(plan.target.kind === "workflow" ? plan.target.inputs : undefined);
  for (const role of roles) { rows[role] = toRows(plan.lifecycle?.[role]?.inputs); const step = plan.lifecycle?.[role]; maps[role] = Object.entries(step && 'outputs' in step ? step.outputs ?? {} : {}).map(([source, target]) => ({ source, target })); }
}, { immediate: true });
const referenceValid = computed(() => (props.plan.target.kind !== 'workflow' || props.workflows.some(w => props.plan.target.kind === 'workflow' && w.id === props.plan.target.workflowId)) && roles.every(role => !props.plan.lifecycle?.[role] || props.workflows.some(w => w.id === props.plan.lifecycle?.[role]?.workflowId)) && (!props.plan.environmentId || props.envs.some(e => e.id === props.plan.environmentId)));
const validation = computed(() => StressPlanSchema.safeParse(props.plan));
const valid = computed(() => validation.value.success && referenceValid.value && !Object.values(errors).some(Boolean));
watch(valid, value => emit('valid', value), { immediate: true });
function loadKind(kind: string) {
  if (props.disabled) return;
  props.plan.load = kind === 'constant-arrival' ? { kind: 'constant-arrival', rate: 1 } : kind === 'stages' ? { kind: 'stages', executor: 'vus', startTarget: 1, stages: [{ id: 'stage-1', durationMs: 10000, target: 1 }] } : { kind: 'constant-vus', vus: 1 };
  if (kind === 'stages') delete props.plan.termination.durationMs;
  else if (kind === 'constant-arrival') props.plan.termination.durationMs ??= 10000;
  else if (!props.plan.termination.durationMs && !props.plan.termination.maxIterations) props.plan.termination.maxIterations = 10;
}
function optionalNumber(key: 'maxRps' | 'maxRequestConcurrency', event: Event) {
  const value = (event.target as HTMLInputElement).value;
  if (!value) delete props.plan[key]; else props.plan[key] = Number(value);
}
function termination(key: 'durationMs' | 'maxIterations', event: Event) {
  const value = (event.target as HTMLInputElement).value;
  if (!value) delete props.plan.termination[key]; else props.plan.termination[key] = Number(value);
}
function lifecycle(role: StressLifecycleRole, id: string) {
  props.plan.lifecycle ??= {};
  if (id) props.plan.lifecycle[role] = { workflowId: id };
  else delete props.plan.lifecycle[role];
  rows[role] = []; maps[role] = []; errors[role] = false; errors[`${role}-map`] = false;
}
function syncInputs(key: string) {
  if (props.disabled) return;
  const values: Record<string, JsonValue> = {}; const names = new Set<string>();
  try {
    for (const row of rows[key] ?? []) {
      if (!row.key.trim() || names.has(row.key)) throw new Error();
      names.add(row.key); Object.defineProperty(values, row.key, { value: JsonValueSchema.parse(JSON.parse(row.value)), enumerable: true });
    }
    errors[key] = false;
    if (key === 'target' && props.plan.target.kind === 'workflow') props.plan.target.inputs = values;
    else { const step = props.plan.lifecycle?.[key as StressLifecycleRole]; if (step) step.inputs = values; }
  } catch { errors[key] = true; }
}
function syncMappings(role: StressLifecycleRole) {
  if (props.disabled || role !== 'setup' && role !== 'vuSetup') return;
  const values: Record<string, string> = {}; const names = new Set<string>();
  for (const row of maps[role] ?? []) {
    if (!row.source.trim() || !row.target.trim() || names.has(row.source)) { errors[`${role}-map`] = true; return; }
    names.add(row.source); Object.defineProperty(values, row.source, { value: row.target, enumerable: true });
  }
  const step = props.plan.lifecycle?.[role]; if (step) step.outputs = values;
  errors[`${role}-map`] = false;
}
function addStage() {
  if (props.plan.load.kind !== 'stages' || props.plan.load.stages.length >= 32) return;
  let index = props.plan.load.stages.length + 1; while (props.plan.load.stages.some(s => s.id === `stage-${index}`)) index++;
  props.plan.load.stages.push({ id: `stage-${index}`, durationMs: 10000, target: 1 });
}
function threshold(key: keyof NonNullable<StressPlan['thresholds']>, event: Event) {
  props.plan.thresholds ??= {}; const value = (event.target as HTMLInputElement).value;
  if (!value) delete props.plan.thresholds[key]; else props.plan.thresholds[key] = Number(value);
}
</script>
<template>
  <fieldset class="load-editor" :disabled="disabled" data-testid="stress-load-editor">
    <label>{{ t('stress.workbench.load') }}<select :value="plan.load.kind" data-testid="stress-load-kind" @change="loadKind(($event.target as HTMLSelectElement).value)"><option value="constant-vus">{{ t('stress.workbench.constantVus') }}</option><option value="constant-arrival">{{ t('stress.workbench.constantArrival') }}</option><option value="stages">{{ t('stress.workbench.stages') }}</option></select></label>
    <label>{{ t('stress.workbench.maxVus') }}<input v-model.number="plan.maxVus" type="number" min="1" max="1000" /></label>
    <label v-if="plan.load.kind === 'constant-vus'">{{ t('stress.workbench.constantVus') }}<input v-model.number="plan.load.vus" type="number" min="1" max="1000" /></label>
    <label v-else-if="plan.load.kind === 'constant-arrival'">{{ t('stress.workbench.arrivalRate') }}<input v-model.number="plan.load.rate" data-testid="stress-arrival-rate" type="number" min="0.001" step="any" /></label>
    <template v-else>
      <label>{{ t('stress.workbench.executor') }}<select v-model="plan.load.executor"><option value="vus">VU</option><option value="arrival">{{ t('stress.workbench.arrivalRate') }}</option></select></label>
      <label>{{ t('stress.workbench.startTarget') }}<input v-model.number="plan.load.startTarget" type="number" min="0" :step="plan.load.executor === 'vus' ? 1 : 'any'" /></label>
      <div v-for="(stage,index) in plan.load.stages" :key="index" class="stage" data-testid="stress-stage">
        <label>{{ t('stress.workbench.stageId') }}<input v-model="stage.id" /></label><label>{{ t('stress.workbench.stageDuration') }}<input v-model.number="stage.durationMs" type="number" min="1" max="604800000" /></label><label>{{ t('stress.workbench.stageTarget') }} ({{ plan.load.executor === 'vus' ? 'VU' : t('stress.workbench.arrivalRate') }})<input v-model.number="stage.target" type="number" min="0" :step="plan.load.executor === 'vus' ? 1 : 'any'" /></label><button type="button" class="icon-action" :title="t('common.delete')" :aria-label="t('common.delete')" @click="plan.load.stages.splice(index,1)">×</button>
      </div>
      <button type="button" :disabled="plan.load.stages.length >= 32" data-testid="stress-add-stage" @click="addStage">{{ t('stress.workbench.addStage') }}</button>
    </template>
    <label v-if="plan.load.kind !== 'stages'">{{ t('stress.workbench.duration') }}<input :value="plan.termination.durationMs" type="number" min="1" max="604800000" @input="termination('durationMs',$event)" /></label>
    <label>{{ t('stress.workbench.maxIterations') }}<input :value="plan.termination.maxIterations" type="number" min="1" max="9007199254740991" @input="termination('maxIterations',$event)" /></label>
    <label>{{ t('stress.workbench.warmup') }}<input v-model.number="plan.warmupMs" type="number" min="0" max="3600000" /></label><label>{{ t('stress.workbench.think') }}<input v-model.number="plan.thinkTimeMs" type="number" min="0" max="3600000" /></label><label>{{ t('stress.workbench.pacing') }}<input v-model.number="plan.pacingMs" type="number" min="0" max="3600000" /></label><label>{{ t('stress.workbench.gracefulStop') }}<input v-model.number="plan.gracefulStopMs" type="number" min="0" max="300000" /></label>
    <label>{{ t('stress.workbench.requestConcurrency') }}<input :value="plan.maxRequestConcurrency" type="number" min="1" max="1000" @input="optionalNumber('maxRequestConcurrency',$event)" /></label><label>{{ t('stress.maxRps') }}<input :value="plan.maxRps" type="number" min="0.001" step="any" @input="optionalNumber('maxRps',$event)" /></label>
    <p class="hint">{{ t('stress.workbench.arrivalRate') }} ≠ {{ t('stress.workbench.httpRps') }}</p>
    <label>{{ t('stress.env') }}<select :value="plan.environmentId ?? ''" @change="plan.environmentId = ($event.target as HTMLSelectElement).value || undefined"><option value="">{{ t('stress.envNone') }}</option><option v-for="env in envs" :key="env.id" :value="env.id">{{ env.name }}</option></select></label>
    <label>{{ t('stress.connectionMode') }}<select v-model="plan.connectionMode"><option value="pooled">{{ t('stress.pooled') }}</option><option value="fresh">{{ t('stress.fresh') }}</option></select></label>
    <details><summary>{{ t('stress.criteria') }}</summary><label v-for="key in (['maxErrorRate','maxAssertionFailureRate','maxP95Ms','minRps'] as const)" :key="key">{{ t(`stress.${key}`) }}<input :value="plan.thresholds?.[key]" type="number" min="0" :max="key.endsWith('Rate') ? 1 : undefined" step="any" @input="threshold(key,$event)" /></label></details>
    <details v-if="plan.target.kind === 'workflow'" open><summary>{{ t('stress.workbench.targetInputs') }}</summary><div v-for="(row,index) in rows.target" :key="index" class="input-row"><input v-model="row.key" :placeholder="t('stress.workbench.key')" @input="syncInputs('target')" /><input v-model="row.value" :placeholder="t('stress.workbench.value')" @input="syncInputs('target')" /><button type="button" class="icon-action" :title="t('common.delete')" @click="rows.target!.splice(index,1);syncInputs('target')">×</button></div><button type="button" @click="rows.target!.push({key:'',value:'&quot;&quot;'});syncInputs('target')">{{ t('stress.workbench.addInput') }}</button></details>
    <details><summary>{{ t('stress.workbench.lifecycle') }}</summary><section v-for="role in roles" :key="role" class="lifecycle-step"><label>{{ role }}<select :value="plan.lifecycle?.[role]?.workflowId ?? ''" @change="lifecycle(role,($event.target as HTMLSelectElement).value)"><option value="">{{ t('stress.workbench.none') }}</option><option v-for="flow in workflows" :key="flow.id" :value="flow.id">{{ flow.name }}</option></select></label><template v-if="plan.lifecycle?.[role]">
      <div v-for="(row,index) in rows[role]" :key="index" class="input-row"><input v-model="row.key" :placeholder="t('stress.workbench.key')" @input="syncInputs(role)" /><input v-model="row.value" :placeholder="t('stress.workbench.value')" @input="syncInputs(role)" /><button type="button" class="icon-action" :title="t('common.delete')" @click="rows[role]!.splice(index,1);syncInputs(role)">×</button></div><button type="button" @click="rows[role]!.push({key:'',value:'&quot;&quot;'});syncInputs(role)">{{ t('stress.workbench.addInput') }}</button>
      <template v-if="role === 'setup' || role === 'vuSetup'"><p>{{ t('stress.workbench.outputs') }}</p><div v-for="(row,index) in maps[role]" :key="index" class="input-row"><input v-model="row.source" :placeholder="t('stress.workbench.sourceOutput')" @input="syncMappings(role)" /><input v-model="row.target" :placeholder="t('stress.workbench.targetInput')" @input="syncMappings(role)" /><button type="button" class="icon-action" :title="t('common.delete')" @click="maps[role]!.splice(index,1);syncMappings(role)">×</button></div><button type="button" @click="maps[role]!.push({source:'',target:''});syncMappings(role)">{{ t('stress.workbench.addMapping') }}</button></template>
    </template></section></details>
    <p v-if="!referenceValid" class="error" data-testid="stress-reference-error">{{ t('stress.workbench.missingReference') }}</p><p v-if="Object.values(errors).some(Boolean)" class="error">{{ t('stress.workbench.invalidInputs') }}</p><p v-if="!validation.success" class="error">{{ validation.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(' · ') }}</p>
  </fieldset>
</template>
<style scoped>
.load-editor { border:0;padding:0;margin:0;display:flex;flex-direction:column;gap:10px;min-width:0; } label { display:flex;align-items:center;justify-content:space-between;gap:10px; } input,select { min-width:0;width:190px;max-width:55%;padding:4px 6px;color:inherit;background:var(--bg-panel,#fff);border:1px solid var(--border,#ddd);border-radius:4px; } input:disabled,select:disabled { opacity:.6; } .stage,.lifecycle-step { border:1px solid var(--border,#ddd);padding:8px;display:flex;flex-direction:column;gap:6px;position:relative; } .input-row { display:flex;gap:6px;margin:6px 0; } .input-row input { flex:1;max-width:none;width:0; } button { width:fit-content;cursor:pointer;color:inherit;background:var(--bg-panel,#fff);border:1px solid var(--border,#ddd);border-radius:4px;min-height:26px; } button:disabled { cursor:default;opacity:.5; } .icon-action { width:26px;height:26px;flex:none; } .hint { font-size:12px;color:var(--text-muted,#666); } summary { cursor:pointer;margin:6px 0; } .error { color:var(--fail,#cf1322);overflow-wrap:anywhere; } details label { margin:6px 0; }
</style>

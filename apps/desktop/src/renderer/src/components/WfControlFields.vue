<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { JsonValue, WorkflowNode, WorkflowPredicate, WorkflowValue, WorkflowV2 } from "@apicc/core";
import { JsonValueSchema, WorkflowPredicateSchema, WorkflowValueSchema } from "@apicc/core/schema";

// Recursive structured editors share one vocabulary and never execute expressions.
type Call = Extract<WorkflowNode, { kind: "subflow" }>;
type Definitions = WorkflowV2["inputs"];
const props = withDefaults(defineProps<{
  mode?: "node" | "workflow" | "value" | "predicate" | "values" | "outputs" | "definitions" | "call";
  node?: WorkflowNode; workflow?: WorkflowV2; value?: WorkflowValue; predicate?: WorkflowPredicate;
  values?: Record<string, WorkflowValue>; outputs?: Record<string, string>; definitions?: Definitions;
  call?: Pick<Call, "workflowId" | "inputs" | "outputs">;
  workflows?: Array<{ id: string; name: string }>; depth?: number;
}>(), { mode: "node", workflows: () => [], depth: 1 });
const emit = defineEmits<{
  node: [value: WorkflowNode]; workflow: [value: WorkflowV2]; value: [value: WorkflowValue]; predicate: [value: WorkflowPredicate];
  values: [value: Record<string, WorkflowValue>]; outputs: [value: Record<string, string>]; definitions: [value: Definitions];
  call: [value: Pick<Call, "workflowId" | "inputs" | "outputs">]; navigate: [id: string];
}>();
const { t } = useI18n();
const error = ref("");
const literal = (): WorkflowValue => ({ kind: "literal", value: null });
const initialPredicate = (): WorkflowPredicate => ({ op: "eq", left: { kind: "ref", source: "vars", path: [] }, right: literal() });
const sources = ["inputs", "vars", "env", "previous", "error", "loop"] as const;
const ops = ["eq", "neq", "lt", "lte", "gt", "gte", "exists", "notExists", "and", "or", "not"] as const;
function text(event: Event) { return (event.target as HTMLInputElement).value; }
function checked(event: Event) { return (event.target as HTMLInputElement).checked; }
function guard(action: () => void) { try { action(); error.value = ""; } catch (e) { error.value = e instanceof Error ? e.message : String(e); } }
function json(event: Event, accept: (value: JsonValue) => void) { guard(() => accept(JsonValueSchema.parse(JSON.parse(text(event))))); }
function number(event: Event, accept: (value: number) => void, min: number, max = Number.MAX_SAFE_INTEGER) {
  guard(() => { const raw = text(event); const value = Number(raw); if (!raw || !Number.isInteger(value) || value < min || value > max) throw new Error(t("wf.control.numberRange", { min, max })); accept(value); });
}
function setNode(patch: Partial<WorkflowNode>) { if (props.node) emit("node", { ...props.node, ...patch } as WorkflowNode); }
const policy = computed(() => props.node?.policy ?? {});
function setPolicy(patch: Partial<NonNullable<WorkflowNode["policy"]>>) { setNode({ policy: { ...policy.value, ...patch } }); }
function valueKind(kind: string) { emit("value", kind === "ref" ? { kind: "ref", source: "vars", path: [] } : literal()); }
function path(event: Event) { guard(() => { if (props.value?.kind !== "ref") return; emit("value", WorkflowValueSchema.parse({ ...props.value, path: JSON.parse(text(event)) })); }); }
function predicateOp(op: WorkflowPredicate["op"]) {
  const previous = props.predicate;
  if (op === "and" || op === "or") emit("predicate", { op, items: previous && (previous.op === "and" || previous.op === "or") ? previous.items : [initialPredicate()] });
  else if (op === "not") emit("predicate", { op, item: previous?.op === "not" ? previous.item : initialPredicate() });
  else if (op === "exists" || op === "notExists") emit("predicate", { op, value: previous && "value" in previous ? previous.value : literal() });
  else emit("predicate", { op, left: previous && "left" in previous ? previous.left : literal(), right: previous && "right" in previous ? previous.right : literal() });
}
function setPredicate(value: WorkflowPredicate) { guard(() => emit("predicate", WorkflowPredicateSchema.parse(value))); }
function unique(record: object, stem: string) { let index = 1; while (Object.hasOwn(record, `${stem}${index}`)) index++; return `${stem}${index}`; }
function rename<T>(record: Record<string, T>, old: string, name: string, accept: (value: Record<string, T>) => void) {
  guard(() => { if (!name.trim() || (name !== old && Object.hasOwn(record, name))) throw new Error(t("wf.control.uniqueName")); accept(Object.fromEntries(Object.entries(record).map(([key, value]) => [key === old ? name : key, value]))); });
}
function without<T>(record: Record<string, T>, key: string) { return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key)); }
function setRetry(enabled: boolean) {
  if (props.node?.kind !== "request") return;
  emit("node", { ...props.node, policy: { ...props.node.policy, retry: enabled ? { maxAttempts: 2, retryOn: ["transport"], delayMs: 0, backoff: "fixed", allowRepeatSideEffects: false } : undefined } });
}
function retryPatch(patch: Partial<NonNullable<Extract<WorkflowNode, { kind: "request" }>["policy"]>["retry"]>) {
  if (props.node?.kind !== "request" || !props.node.policy?.retry) return;
  emit("node", { ...props.node, policy: { ...props.node.policy, retry: { ...props.node.policy.retry, ...patch } } });
}
function handler(role: "onError" | "finally", id: string) {
  setPolicy({ [role]: id ? { workflowId: id, timeoutMs: 5000, ...(role === "onError" ? { mode: "propagate" } : {}) } : undefined });
}
function addBranch() { if (props.node?.kind === 'parallel') setNode({ branches: [...props.node.branches, { id: crypto.randomUUID(), workflowId: props.workflows[0]?.id ?? props.node.branches[0]!.workflowId, inputs: {}, outputs: {} }] }); }
function setLimits(patch: Partial<WorkflowV2['limits']>) { if (props.workflow) emit('workflow', { ...props.workflow, limits: { ...props.workflow.limits, ...patch } }); }
function setLoopMax(value: number) { if (props.node?.kind !== 'loop') return; if ((props.node.count ?? 0) > value) throw new Error(t('wf.control.countBudget')); setNode({ maxIterations: value }); }
</script>

<template>
  <div class="wf-controls" :data-editor="mode">
    <template v-if="mode === 'value' && value">
      <label>{{ t('wf.control.source') }}
        <select :value="value.kind" data-testid="wf-value-kind" @change="valueKind(text($event))"><option value="literal">{{ t('wf.control.literal') }}</option><option value="ref">{{ t('wf.control.reference') }}</option></select>
      </label>
      <template v-if="value.kind === 'ref'">
        <label>{{ t('wf.control.source') }}<select :value="value.source" data-testid="wf-value-source" @change="emit('value', { ...value, source: text($event) as typeof value.source })"><option v-for="source in sources" :key="source" :value="source">{{ t(`wf.control.sources.${source}`) }}</option></select></label>
        <label>{{ t('wf.control.path') }}<input :value="JSON.stringify(value.path)" data-testid="wf-value-path" @change="path" /></label>
      </template>
      <label v-else>{{ t('wf.control.jsonValue') }}<input :value="JSON.stringify(value.value)" data-testid="wf-value-literal" @change="json($event, value => emit('value', { kind: 'literal', value }))" /></label>
    </template>
    <template v-else-if="mode === 'predicate' && predicate">
      <label>{{ t('wf.control.operator') }}<select :value="predicate.op" data-testid="wf-predicate-op" @change="predicateOp(text($event) as WorkflowPredicate['op'])"><option v-for="op in ops" :key="op" :value="op">{{ t(`wf.control.ops.${op}`) }}</option></select></label>
      <template v-if="'left' in predicate">
        <WfControlFields mode="value" :value="predicate.left" @value="setPredicate({ ...predicate, left: $event } as WorkflowPredicate)" />
        <WfControlFields mode="value" :value="predicate.right" @value="setPredicate({ ...predicate, right: $event } as WorkflowPredicate)" />
      </template>
      <WfControlFields v-else-if="'value' in predicate" mode="value" :value="predicate.value" @value="setPredicate({ ...predicate, value: $event } as WorkflowPredicate)" />
      <WfControlFields v-else-if="predicate.op === 'not' && depth < 32" mode="predicate" :predicate="predicate.item" :depth="depth + 1" @predicate="setPredicate({ op: 'not', item: $event })" />
      <template v-else-if="'items' in predicate && depth < 32">
        <fieldset v-for="(item, index) in predicate.items" :key="index">
          <WfControlFields mode="predicate" :predicate="item" :depth="depth + 1" @predicate="setPredicate({ ...predicate, items: predicate.items.map((p, i) => i === index ? $event : p) } as WorkflowPredicate)" />
          <button type="button" :disabled="predicate.items.length === 1" @click="setPredicate({ ...predicate, items: predicate.items.filter((_, i) => i !== index) } as WorkflowPredicate)">{{ t('common.delete') }}</button>
        </fieldset>
        <button type="button" @click="setPredicate({ ...predicate, items: [...predicate.items, initialPredicate()] } as WorkflowPredicate)">{{ t('wf.control.addCondition') }}</button>
      </template>
    </template>
    <template v-else-if="mode === 'values'">
      <fieldset v-for="(item, key) in values" :key="key">
        <label>{{ t('wf.control.name') }}<input :value="key" data-testid="wf-map-name" @change="rename(values ?? {}, String(key), text($event), value => emit('values', value))" /></label>
        <WfControlFields mode="value" :value="item" @value="emit('values', { ...values, [key]: $event })" />
        <button type="button" @click="emit('values', without(values ?? {}, String(key)))">{{ t('common.delete') }}</button>
      </fieldset>
      <button type="button" data-testid="wf-map-add" @click="emit('values', { ...values, [unique(values ?? {}, 'value')]: literal() })">{{ t('wf.control.addMapping') }}</button>
    </template>
    <template v-else-if="mode === 'outputs'">
      <fieldset v-for="(target, key) in outputs" :key="key">
        <label>{{ t('wf.control.outputName') }}<input :value="key" @change="rename(outputs ?? {}, String(key), text($event), value => emit('outputs', value))" /></label>
        <label>{{ t('wf.control.targetVariable') }}<input :value="target" data-testid="wf-output-target" @change="guard(() => { if (!text($event)) throw new Error(t('wf.control.uniqueName')); emit('outputs', { ...outputs, [key]: text($event) }); })" /></label>
        <button type="button" @click="emit('outputs', without(outputs ?? {}, String(key)))">{{ t('common.delete') }}</button>
      </fieldset>
      <button type="button" data-testid="wf-output-add" @click="emit('outputs', { ...outputs, [unique(outputs ?? {}, 'output')]: unique(Object.fromEntries(Object.values(outputs ?? {}).map(value => [value, true])), 'variable') })">{{ t('wf.control.addMapping') }}</button>
    </template>
    <template v-else-if="mode === 'definitions'">
      <fieldset v-for="(definition, key) in definitions" :key="key">
        <label>{{ t('wf.control.name') }}<input :value="key" @change="rename(definitions ?? {}, String(key), text($event), value => emit('definitions', value))" /></label>
        <label><input type="checkbox" :checked="definition.required" @change="emit('definitions', { ...definitions, [key]: { ...definition, required: checked($event) } })" />{{ t('wf.control.required') }}</label>
        <label>{{ t('wf.control.default') }}<input :value="definition.default === undefined ? '' : JSON.stringify(definition.default)" @change="text($event) === '' ? emit('definitions', { ...definitions, [key]: { required: definition.required } }) : json($event, value => emit('definitions', { ...definitions, [key]: { ...definition, default: value } }))" /></label>
        <button type="button" @click="emit('definitions', without(definitions ?? {}, String(key)))">{{ t('common.delete') }}</button>
      </fieldset>
      <button type="button" data-testid="wf-input-add" @click="emit('definitions', { ...definitions, [unique(definitions ?? {}, 'input')]: { required: false } })">{{ t('wf.control.addInput') }}</button>
    </template>
    <template v-else-if="mode === 'call' && call">
      <label>{{ t('wf.control.workflow') }}<select :value="call.workflowId" data-testid="wf-call-workflow" @change="emit('call', { ...call, workflowId: text($event) })"><option v-if="!workflows.some(w => w.id === call!.workflowId)" :value="call.workflowId">{{ call.workflowId }}</option><option v-for="item in workflows" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      <button type="button" data-testid="wf-reference-open" @click="emit('navigate', call.workflowId)">{{ t('wf.control.openReference') }}</button>
      <h4>{{ t('wf.control.inputMappings') }}</h4><WfControlFields mode="values" :values="call.inputs" @values="emit('call', { ...call, inputs: $event })" />
      <h4>{{ t('wf.control.outputMappings') }}</h4><WfControlFields mode="outputs" :outputs="call.outputs" @outputs="emit('call', { ...call, outputs: $event })" />
    </template>
    <template v-else-if="mode === 'workflow' && workflow">
      <h4>{{ t('wf.control.inputs') }}</h4><WfControlFields mode="definitions" :definitions="workflow.inputs" @definitions="emit('workflow', { ...workflow, inputs: $event })" />
      <h4>{{ t('wf.control.outputs') }}</h4><WfControlFields mode="values" :values="workflow.outputs" @values="emit('workflow', { ...workflow, outputs: $event })" />
      <label>{{ t('wf.control.concurrency') }}<input type="number" min="1" max="32" :value="workflow.limits.maxConcurrency" @change="number($event, value => setLimits({ maxConcurrency: value }), 1, 32)" /></label>
      <label>{{ t('wf.control.rootTimeout') }}<input type="number" min="1" max="3600000" :value="workflow.limits.timeoutMs" @change="number($event, value => setLimits({ timeoutMs: value }), 1, 3600000)" /></label>
    </template>
    <template v-else-if="node">
      <WfControlFields v-if="node.kind === 'assign'" mode="values" :values="node.assignments" @values="setNode({ assignments: $event })" />
      <label v-if="node.kind === 'delay'">{{ t('wf.control.delay') }}<input type="number" min="0" :value="node.delayMs" data-testid="wf-delay" @change="number($event, value => setNode({ delayMs: value }), 0)" /></label>
      <WfControlFields v-if="node.kind === 'assert' || node.kind === 'condition'" mode="predicate" :predicate="node.predicate" @predicate="setNode({ predicate: $event })" />
      <template v-if="node.kind === 'subflow' || node.kind === 'loop'">
        <WfControlFields mode="call" :call="node" :workflows="workflows" @call="setNode($event)" @navigate="emit('navigate', $event)" />
        <p class="hint">{{ t('wf.control.callIsolation') }}</p>
      </template>
      <template v-if="node.kind === 'loop'">
        <label>{{ t('wf.control.loopMode') }}<select :value="node.count === undefined ? 'while' : 'count'" data-testid="wf-loop-mode" @change="setNode(text($event) === 'count' ? { count: 1, while: undefined } : { count: undefined, while: initialPredicate() })"><option value="count">{{ t('wf.control.count') }}</option><option value="while">{{ t('wf.control.while') }}</option></select></label>
        <label v-if="node.count !== undefined">{{ t('wf.control.count') }}<input type="number" min="0" :max="node.maxIterations" :value="node.count" data-testid="wf-loop-count" @change="number($event, value => setNode({ count: value }), 0, node.maxIterations)" /></label>
        <WfControlFields v-else mode="predicate" :predicate="node.while" @predicate="setNode({ while: $event })" />
        <label>{{ t('wf.control.maxIterations') }}<input type="number" min="1" max="10000" :value="node.maxIterations" data-testid="wf-loop-max" @change="number($event, setLoopMax, 1, 10000)" /></label>
        <label><input type="checkbox" :checked="!!node.until" data-testid="wf-until-enable" @change="setNode({ until: checked($event) ? initialPredicate() : undefined })" />{{ t('wf.control.until') }}</label>
        <WfControlFields v-if="node.until" mode="predicate" :predicate="node.until" @predicate="setNode({ until: $event })" />
        <p class="hint">{{ t('wf.control.loopHint') }}</p>
      </template>
      <template v-if="node.kind === 'parallel'">
        <label>{{ t('wf.control.join') }}<select :value="node.join" data-testid="wf-join" @change="setNode({ join: text($event) as 'all' | 'any-success' })"><option value="all">{{ t('wf.control.all') }}</option><option value="any-success">{{ t('wf.control.anySuccess') }}</option></select></label>
        <fieldset v-for="(branch, index) in node.branches" :key="branch.id"><legend>{{ t('wf.control.branch', { n: index + 1 }) }}</legend>
          <WfControlFields mode="call" :call="branch" :workflows="workflows" @call="setNode({ branches: node.branches.map((b, i) => i === index ? { ...b, ...$event } : b) })" @navigate="emit('navigate', $event)" />
          <button type="button" :disabled="node.branches.length <= 2" @click="setNode({ branches: node.branches.filter((_, i) => i !== index) })">{{ t('common.delete') }}</button>
        </fieldset>
        <button type="button" data-testid="wf-branch-add" @click="addBranch">{{ t('wf.control.addBranch') }}</button>
        <p class="hint">{{ t('wf.control.parallelHint') }}</p>
      </template>
      <h4>{{ t('wf.control.policy') }}</h4>
      <label>{{ t('wf.control.nodeTimeout') }}<input type="number" min="1" max="3600000" :value="policy.timeoutMs ?? ''" data-testid="wf-node-timeout" @change="text($event) === '' ? setPolicy({ timeoutMs: undefined }) : number($event, value => setPolicy({ timeoutMs: value }), 1, 3600000)" /></label>
      <template v-if="node.kind === 'request'">
        <label><input type="checkbox" :checked="!!node.policy?.retry" data-testid="wf-retry-enable" @change="setRetry(checked($event))" />{{ t('wf.control.retry') }}</label>
        <template v-if="node.policy?.retry">
          <label>{{ t('wf.control.maxAttempts') }}<input type="number" min="1" max="5" :value="node.policy.retry.maxAttempts" data-testid="wf-retry-attempts" @change="number($event, value => retryPatch({ maxAttempts: value }), 1, 5)" /></label>
          <label v-for="kind in (['transport', 'http', 'assertion', 'extraction'] as const)" :key="kind"><input type="checkbox" :checked="node.policy.retry.retryOn.includes(kind)" @change="retryPatch({ retryOn: checked($event) ? [...node.policy.retry.retryOn, kind] : node.policy.retry.retryOn.filter(k => k !== kind) })" />{{ t(`wf.control.retryKinds.${kind}`) }}</label>
          <label>{{ t('wf.control.retryDelay') }}<input type="number" min="0" max="30000" :value="node.policy.retry.delayMs" @change="number($event, value => retryPatch({ delayMs: value }), 0, 30000)" /></label>
          <label>{{ t('wf.control.backoff') }}<select :value="node.policy.retry.backoff" @change="retryPatch({ backoff: text($event) as 'fixed' | 'exponential' })"><option value="fixed">{{ t('wf.control.fixed') }}</option><option value="exponential">{{ t('wf.control.exponential') }}</option></select></label>
          <label><input type="checkbox" :checked="node.policy.retry.allowRepeatSideEffects" data-testid="wf-retry-side-effects" @change="retryPatch({ allowRepeatSideEffects: checked($event) })" />{{ t('wf.control.allowSideEffects') }}</label>
          <p class="hint" data-testid="wf-retry-hint">{{ t('wf.control.retryHint') }}</p>
        </template>
      </template>
      <fieldset v-for="role in (['onError', 'finally'] as const)" :key="role"><legend>{{ t(`wf.control.${role}`) }}</legend>
        <select :value="policy[role]?.workflowId ?? ''" :data-testid="`wf-${role}-workflow`" @change="handler(role, text($event))"><option value="">{{ t('wf.control.none') }}</option><option v-if="policy[role] && !workflows.some(w => w.id === policy[role]?.workflowId)" :value="policy[role]?.workflowId">{{ policy[role]?.workflowId }}</option><option v-for="item in workflows" :key="item.id" :value="item.id">{{ item.name }}</option></select>
        <template v-if="policy[role]">
          <button type="button" @click="emit('navigate', policy[role]!.workflowId)">{{ t('wf.control.openReference') }}</button>
          <label>{{ t('wf.control.handlerTimeout') }}<input type="number" min="1" max="30000" :value="policy[role]?.timeoutMs" @change="number($event, value => setPolicy({ [role]: { ...policy[role], timeoutMs: value } }), 1, 30000)" /></label>
          <label v-if="role === 'onError'">{{ t('wf.control.errorMode') }}<select :value="policy.onError?.mode" data-testid="wf-error-mode" @change="setPolicy({ onError: { ...policy.onError!, mode: text($event) as 'propagate' | 'recover' } })"><option value="propagate">{{ t('wf.control.propagate') }}</option><option value="recover">{{ t('wf.control.recover') }}</option></select></label>
        </template>
      </fieldset>
      <p class="hint">{{ t('wf.control.cancelCleanupHint') }}</p>
    </template>
    <p v-if="error" role="alert" data-testid="wf-field-error" class="field-error">{{ error }}</p>
  </div>
</template>

<style scoped>
.wf-controls { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
label { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; font-size: 12px; }
label > input:not([type=checkbox]), select { width: 100%; min-width: 0; color: var(--text); background: var(--panel); border: 1px solid var(--border); padding: 4px; border-radius: 3px; }
input[type=checkbox] { width: auto; }
fieldset { min-width: 0; border: 1px solid var(--border); padding: 8px; margin: 4px 0; }
button { color: var(--text); background: var(--panel); border: 1px solid var(--border); border-radius: 3px; padding: 4px 8px; cursor: pointer; }
button:disabled { opacity: .5; cursor: default; }
h4 { margin: 8px 0 2px; } .hint { font-size: 12px; color: var(--text-muted); margin: 4px 0; } .field-error { color: var(--fail); overflow-wrap: anywhere; }
</style>

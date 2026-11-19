<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useWorkbenchPosition } from "../../stores/workbenchPosition.js";
import { resolveExecutionEnvironment, selectEffectiveCases } from "@apicc/core/domain/execution-selection";
import { resolveSuitePlan } from "@apicc/core/testing/selection";
import { createReadonlyProjectAssetContext } from "@apicc/core/assets/context";
import { StressPlanSchema } from "@apicc/core/schema";
import type { ApiAsset, ContractCollection, ContractFolder, JsonValue } from "@apicc/core";
import type { ApiLocator } from "../../../../shared/locations.js";
import type { OnlineExecutionStore } from "../../stores/onlineExecution.js";
import type { createOnlineProjectAdapter } from "../../stores/onlineProjectAdapter.js";
import { apiSessionKey } from "../../stores/localIdentity.js";
import { onlineExecutionLocationIssue } from "../../onlineExecutionLocation.js";
import { onlineSessionErrorKey } from "../../i18n/index.js";
import { launchError, useLaunchMessages } from "../../execution/launchMessages.js";
import { confirmOnlineStress, runOnlineCase, runOnlineStress, runOnlineSuite, runOnlineWorkflow, type LaunchKind } from "../../execution/launch.js";
import RunLaunchForm from "../RunLaunchForm.vue";
import RunWorkflowInputs from "../RunWorkflowInputs.vue";

const props = defineProps<{ execution: OnlineExecutionStore; adapter: ReturnType<typeof createOnlineProjectAdapter>; readOnly?: boolean; dirtyStressPlanId?: string | null; reportError: (error: unknown) => void }>();
const emit = defineEmits<{ records: [runId: string] }>();
const { t, te } = useI18n();
const label = useLaunchMessages();
const kinds = ["case", "suite", "workflow", "stress"] as const;
const position = useWorkbenchPosition(() => scopeKey.value);
const kind = computed<LaunchKind>({ get: () => position.value.launchTarget?.kind ?? "case", set: kind => { position.value.launchTarget = { kind, id: "" }; } });
const selected = computed({ get: () => position.value.launchTarget?.id ?? "", set: id => { position.value.launchTarget = { kind: kind.value, id }; } });
const allowDraft = ref(false), origins = ref("");
const inputs = ref<Record<string, JsonValue>>(), validInputs = ref(false);
const busy = ref(false), launched = ref(""), notice = ref("");
let selectionEpoch = 0;
const project = computed(() => props.execution.confirmedProject());
const scopeKey = computed(() => JSON.stringify(props.execution.context));
const version = computed(() => props.execution.view?.assets.version);
const assets = computed(() => {
  const context = props.execution.context;
  if (!project.value || !context) return [];
  const entries: Array<{ locator: ApiLocator; asset: ApiAsset }> = [];
  for (const collection of project.value.collections) {
    const visit = (container: ContractCollection | ContractFolder, folderIds: string[]) => {
      for (const asset of container.apis) entries.push({ asset, locator: {
        workspaceId: context.scope.workspaceId, groupId: context.scope.groupId, projectId: project.value!.id, collectionId: collection.id, folderIds, apiId: asset.contract.id,
      } });
      for (const folder of container.folders) visit(folder, [...folderIds, folder.id]);
    };
    visit(collection, []);
  }
  return entries;
});
const cases = computed(() => assets.value.flatMap(({ locator, asset }) => asset.cases.map(testCase => ({
  id: JSON.stringify([locator, testCase.id, testCase.scope]), label: testCase.name,
  detail: `${asset.contract.metadata.name} · ${testCase.scope === "base" ? t("onlineExecution.baseEnvironment") : testCase.scope}`,
  locator, asset, testCase,
}))));
const choices = computed(() => {
  if (kind.value === "case") return cases.value;
  if (kind.value === "suite") return (project.value?.suites ?? []).map(item => ({ id: item.id, label: item.name }));
  if (kind.value === "workflow") return (project.value?.workflows ?? []).map(item => ({ id: item.id, label: item.name }));
  return (project.value?.stressPlans ?? []).map(item => ({ id: item.id, label: item.name }));
});
const testCase = computed(() => kind.value === "case" ? cases.value.find(item => item.id === selected.value) : undefined);
const suite = computed(() => kind.value === "suite" ? project.value?.suites?.find(item => item.id === selected.value) : undefined);
const workflow = computed(() => kind.value === "workflow" ? project.value?.workflows.find(item => item.id === selected.value) : undefined);
const plan = computed(() => kind.value === "stress" ? project.value?.stressPlans?.find(item => item.id === selected.value)?.plan : undefined);
const suiteEnvironment = computed(() => props.execution.environmentId ?? suite.value?.environmentId);
const environmentId = computed(() => plan.value?.environmentId ?? suiteEnvironment.value);
const environment = computed(() => project.value?.environments.find(item => item.id === environmentId.value));
const dataset = computed(() => project.value?.datasets?.find(item => item.id === suite.value?.datasetId));
const agent = computed(() => {
  const location = props.execution.location;
  return location.kind === "agent" ? props.execution.agents?.agents.find(item => item.id === location.agentId) : undefined;
});
const suitePreview = computed(() => {
  if (!suite.value || !project.value) return null;
  const value = project.value;
  try {
    const context = createReadonlyProjectAssetContext({
      projectId: value.id, project: value, assets: assets.value.map(item => item.asset),
      models: value.models, components: value.components, suites: value.suites, datasets: value.datasets,
    });
    const resolved = resolveSuitePlan({ project: value, definitionRevision: version.value!, context }, suite.value.id, {
      environmentId: props.execution.environmentId, allowDraft: allowDraft.value,
    });
    return { count: resolved.entries.length, error: "" };
  } catch (error) { return { count: null, error: launchError(error, label) }; }
});
const saveRequired = computed(() => {
  const { adapter, execution } = props;
  if (testCase.value) {
    const key = apiSessionKey(adapter.editorRoot(), testCase.value.locator);
    const session = adapter.editor.sessions[key];
    return !!session && JSON.stringify(session.api) !== session.snapshot;
  }
  return execution.dirty || !!suite.value && adapter.testing.suite?.id === suite.value.id && adapter.testing.dirty
    || !!workflow.value && adapter.workflowDesign.workflowId === workflow.value.id && (adapter.workflowDesign.dirty || adapter.workflowDesign.saving);
});
const blocked = computed(() => {
  const e = props.execution;
  if (!project.value || e.projectAccessLost || !e.visible) return label("unavailable");
  if (!selected.value) return "";
  if (e.hasProjectUpdates) return label("preview-changed");
  if (!choices.value.some(item => item.id === selected.value)) return label("target-unavailable");
  if (props.readOnly) return label("read-only");
  if (e.environmentId && !project.value.environments.some(item => item.id === e.environmentId) || environmentId.value && !environment.value) return label("environment-unavailable");
  if (e.location.kind === "agent") {
    const issue = onlineExecutionLocationIssue(e);
    if (issue) return te(issue) ? t(issue) : issue.split(".").at(-1)!;
    if (!agent.value?.runtime) return label("agent-offline");
    const task = kind.value === "case" ? "debug" : kind.value;
    if (!agent.value.runtime.capabilities.includes(`task:${task}`) || task === "stress" && !agent.value.runtime.capabilities.includes("stress:local-workers-v1")) return label("agent-capability");
  }
  if (saveRequired.value) return label("save-before-running");
  if (workflow.value?.status === "draft") return label("workflow-draft");
  if (testCase.value) {
    try {
      const { locator, asset, testCase: chosen } = testCase.value;
      const chain = resolveExecutionEnvironment(project.value, locator.collectionId, e.environmentId).chain;
      if (selectEffectiveCases(asset.cases, chain, chosen.id)[0]?.scope !== chosen.scope) return label("scope-unavailable");
    } catch (error) { return launchError(error, label); }
  }
  if (suitePreview.value?.error) return suitePreview.value.error;
  if (plan.value) {
    if (selected.value === props.dirtyStressPlanId) return label("save-before-running");
    if (!StressPlanSchema.safeParse(plan.value).success) return label("invalid-stress");
    if (plan.value.environmentId && e.environmentId && plan.value.environmentId !== e.environmentId) return t("onlineStress.environmentMismatch");
  }
  return "";
});
const reason = computed(() => blocked.value || (plan.value && !props.execution.isStressConfirmed(plan.value) ? t("onlineStress.confirmationRequired") : ""));
watch(scopeKey, () => { launched.value = ""; busy.value = false; notice.value = ""; }, { flush: "sync" });
watch([kind, selected], () => { inputs.value = undefined; validInputs.value = false; allowDraft.value = false; origins.value = ""; }, { flush: "sync" });
watch([scopeKey, kind, selected, () => props.execution.environmentId, environmentId, () => props.execution.location.kind,
  () => props.execution.location.kind === "agent" ? props.execution.location.agentId : undefined], () => {
  selectionEpoch++; launched.value = ""; notice.value = "";
}, { flush: "sync" });
watch(version, (next, previous) => {
  if (selected.value && previous && next !== previous) notice.value = label("preview-changed");
});
watch(origins, () => { if (plan.value) props.execution.invalidateStressConfirmation(); }, { flush: "sync" });
let mounted = true;
onBeforeUnmount(() => { mounted = false; });

function failure(error: unknown) {
  const text = launchError(error, label);
  const session = onlineSessionErrorKey(text);
  const code = text.match(/(?:^|Error: )([a-z][a-z-]+)(?:$|:)/)?.[1];
  const key = code && `onlineExecution.reasons.${code}`;
  return session ? t(session) : key && te(key) ? t(key) : text;
}
function confirm() {
  if (!plan.value || blocked.value || props.execution.running || busy.value) return;
  try { confirmOnlineStress(props.execution, plan.value, origins.value); notice.value = ""; }
  catch (error) { notice.value = failure(error); }
}
async function start() {
  const e = props.execution;
  if (busy.value || e.running || reason.value || !selected.value || (workflow.value && !validInputs.value)) return;
  const scope = scopeKey.value, location = e.location.kind;
  const sameProject = () => mounted && scope === scopeKey.value;
  const epoch = selectionEpoch;
  const stillSelected = () => sameProject() && selectionEpoch === epoch;
  busy.value = true;
  notice.value = ""; launched.value = "";
  try {
    const previous = e.resultSelection;
    let pending: Promise<void>;
    if (testCase.value) {
      const { locator, testCase: chosen } = testCase.value;
      pending = runOnlineCase(e, locator, { caseId: chosen.id, scope: chosen.scope });
    } else if (suite.value) pending = runOnlineSuite(e, suite.value, allowDraft.value);
    else if (workflow.value) pending = runOnlineWorkflow(e, workflow.value, inputs.value);
    else if (plan.value) pending = runOnlineStress(e, plan.value, selected.value);
    else return;
    const selection = e.resultSelection;
    const submittedId = selection && selection !== previous && "runId" in selection ? selection.runId : "";
    const reused = !!submittedId && !e.running;
    if (submittedId && stillSelected()) launched.value = submittedId;
    await pending;
    if (stillSelected()) notice.value = reused ? label("prior-submission") : location === "agent" ? label("accepted") : label("finished");
  } catch (error) {
    if (stillSelected()) {
      notice.value = /version_conflict/.test(String(error)) ? label("preview-changed") : failure(error);
    }
  } finally { if (sameProject()) busy.value = false; }
}
async function cancel() {
  const epoch = selectionEpoch;
  try { await props.execution.cancelLocal(); }
  catch (error) { if (mounted && selectionEpoch === epoch) notice.value = failure(error); }
}
</script>

<template>
  <RunLaunchForm v-model:kind="kind" v-model:selected="selected" :kinds="kinds" :choices="choices" :reason="reason"
    :notice="notice" :busy="busy || execution.running" :disabled="!!workflow && !validInputs" @launch="start">
    <dl>
      <dt>{{ label("scope") }}</dt><dd v-if="suite">{{ suitePreview?.count == null ? label('suite') : label('entries', { count: suitePreview.count }) }}</dd>
      <dd v-else-if="workflow">{{ label('nodes', { count: workflow.nodes.length }) }}</dd>
      <dd v-else-if="testCase">{{ testCase.asset.contract.metadata.name }} · {{ label('assertionCount', { count: testCase.testCase.assertions.length }) }}</dd>
      <dd v-else>{{ label(kind) }}</dd>
      <dt>{{ label("environment") }}</dt><dd>{{ environment?.name ?? (environmentId ? label('environment-unavailable') : t('onlineExecution.baseEnvironment')) }}<small v-if="environment && (plan?.environmentId || (suite?.environmentId && !execution.environmentId))"> · {{ label('planEnvironment') }}</small></dd>
      <dt>{{ label("location") }}</dt><dd>{{ execution.location.kind === 'local' ? label('local') : agent?.name ?? label('agent-offline') }}</dd>
      <template v-if="suite"><dt>{{ label("data") }}</dt><dd>{{ dataset?.name ?? label("noData") }}</dd></template>
      <template v-if="plan"><dt>{{ label("maxVus") }}</dt><dd>{{ plan.maxVus }}</dd></template>
    </dl>
    <label v-if="suite"><input v-model="allowDraft" type="checkbox" />{{ t("testing.allowDraft") }}</label>
    <RunWorkflowInputs v-if="workflow" :key="workflow.id" :workflow="workflow" @change="(values, valid) => { inputs = values; validInputs = valid; }" />
    <fieldset v-if="plan" class="stress-launch">
      <legend>{{ t("onlineStress.confirm") }}</legend>
      <label>{{ t("onlineStress.workers") }} <input v-model.number="execution.stressWorkerCount" type="number" min="1" :max="plan.maxVus" :disabled="busy || execution.running" /></label>
      <label>{{ t("onlineStress.origins") }} <input v-model="origins" :disabled="busy || execution.running" /></label>
      <button :disabled="!!blocked || busy || execution.running || !origins.trim()" @click="confirm">{{ t("onlineStress.confirm") }}</button>
    </fieldset>
    <template #actions>
      <button v-if="launched && launched === execution.activeLocalRunId" type="button" @click="cancel">{{ label("cancel") }}</button>
      <button v-if="launched" type="button" @click="emit('records', launched)">{{ label("inspect") }}</button>
    </template>
  </RunLaunchForm>
</template>

<style scoped>
.stress-launch { min-width: 0; display: grid; gap: 8px; border: 1px solid var(--border); border-radius: 6px; }
.stress-launch label { display: grid; gap: 4px; }
.stress-launch input { min-width: 0; }
.stress-launch button { justify-self: start; }
</style>

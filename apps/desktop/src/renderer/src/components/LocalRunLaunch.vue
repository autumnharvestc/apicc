<script setup lang="ts">
import { computed, ref, shallowRef, watch, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import type { JsonValue, SavedStressPlan, SuitePreview, Workflow } from "@apicc/core";
import { StressPlanSchema } from "@apicc/core/schema";
import type { CollectionLaunchPreview } from "../../../shared/collection-launch.js";
import type { SuiteInvocation, TestingAssets } from "../../../shared/testing.js";
import type { LocalLaunchProps } from "../execution/localLaunch.js";
import { buildSavedCaseInvocation, type LaunchKind } from "../execution/launch.js";
import { useLaunchMessages, launchError } from "../execution/launchMessages.js";
import { apiSessionKey, projectSessionKey } from "../stores/localIdentity.js";
import { isPersistedCase } from "../stores/debug.js";
import RunLaunchForm from "./RunLaunchForm.vue";
import RunWorkflowInputs from "./RunWorkflowInputs.vue";

const props = defineProps<LocalLaunchProps>();
const emit = defineEmits<{ records: [file: string]; "open-debug-record": [historyId: string]; selection: [kind: LaunchKind, id: string] }>();
const { t } = useI18n();
const label = useLaunchMessages();
const kinds = ["module", "case", "suite", "workflow", "stress"] as const;
const kind = ref<LaunchKind>("module"), selected = ref("");
const catalog = shallowRef<TestingAssets | null>(null), plans = shallowRef<SavedStressPlan[]>([]);
const collection = shallowRef<CollectionLaunchPreview>(), suitePreview = shallowRef<SuitePreview & { dataDigest?: string }>(), workflow = shallowRef<Workflow>();
const readError = ref(""), previewError = ref(""), notice = ref("");
const loading = ref(false), reading = ref(false), starting = ref(false), refresh = ref(0);
const allowDraft = ref(false), inputs = shallowRef<Record<string, JsonValue>>(), inputsValid = ref(false);
const scope = computed(() => props.projectLocator ? projectSessionKey(props.workspace.root, props.projectLocator) : "");
const plain = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const caseChoices = computed(() => (catalog.value?.cases ?? []).flatMap(row => row.scopes.map(caseScope => ({
  id: JSON.stringify([row.locator, row.caseId, caseScope]), label: row.name,
  detail: caseScope === "base" ? t("testWorkbench.baseCase") : caseScope,
  locator: row.locator, caseId: row.caseId, scope: caseScope,
}))));
const choices = computed(() => {
  if (kind.value === "case") return caseChoices.value;
  const items = kind.value === "module" ? catalog.value?.collections : kind.value === "suite" ? catalog.value?.suites
    : kind.value === "workflow" ? catalog.value?.workflows : plans.value;
  return (items ?? []).map(item => ({ id: item.id, label: item.name }));
});
const chosenCase = computed(() => kind.value === "case" ? caseChoices.value.find(item => item.id === selected.value) : undefined);
const suite = computed(() => kind.value === "suite" ? catalog.value?.suites.find(item => item.id === selected.value) : undefined);
const savedPlan = computed(() => kind.value === "stress" ? plans.value.find(item => item.id === selected.value) : undefined);
const actualEnvId = computed(() => savedPlan.value?.plan.environmentId ?? props.environmentId ?? suite.value?.environmentId);
const actualEnv = computed(() => catalog.value?.environments.find(env => env.id === actualEnvId.value));
const intent = computed(() => JSON.stringify([scope.value, kind.value, selected.value, props.environmentId, allowDraft.value, inputs.value]));
const busy = computed(() => starting.value || props.run.running || props.run.caseRunning || props.testing.running || props.workflowDesign.running || props.stress.running);
const ownCase = computed(() => props.run.caseOwner && projectSessionKey(props.run.caseOwner.root, props.run.caseOwner.project) === scope.value);
const ownWorkflow = computed(() => props.workflowDesign.activeRun && projectSessionKey(props.workflowDesign.activeRun.root, props.workflowDesign.activeRun.locator) === scope.value);
const archive = ref(""), debugHistoryId = ref("");
let catalogueRead = 0, previewRead = 0, selectionEpoch = 0, alive = true;
let lastPreview: { target: string; signature: string } | undefined;
onBeforeUnmount(() => { alive = false; catalogueRead++; previewRead++; });
function resetConfirmation() {
  if (props.stress.planConfirmation?.saved) props.stress.denyPlanTarget();
}
watch(scope, () => { kind.value = "module"; selected.value = ""; archive.value = ""; debugHistoryId.value = ""; starting.value = false; notice.value = ""; }, { flush: "sync" });
watch([scope, () => props.selectedCollectionLocator], () => {
  const target = props.selectedCollectionLocator;
  if (kind.value === "module") selected.value = target && projectSessionKey(props.workspace.root, target) === scope.value ? target.collectionId : "";
}, { immediate: true });
watch(kind, () => { selected.value = ""; }, { flush: "sync" });
watch([kind, selected], ([type, id]) => emit("selection", type, id), { immediate: true, flush: "sync" });
watch([kind, selected], () => { selectionEpoch++; archive.value = ""; debugHistoryId.value = ""; inputs.value = undefined; inputsValid.value = false; allowDraft.value = false; notice.value = ""; lastPreview = undefined; resetConfirmation(); }, { flush: "sync" });
watch(() => props.environmentId, () => { notice.value = ""; resetConfirmation(); }, { flush: "sync" });

watch([scope, () => props.workspace.tree, refresh], async () => {
  const read = ++catalogueRead;
  readError.value = ""; catalog.value = null; plans.value = [];
  const project = props.projectLocator;
  if (!scope.value || !project) { loading.value = false; return; }
  loading.value = true;
  try {
    const view = await props.api.listTestingAssets({ root: props.workspace.root, project: plain(project) });
    if (read === catalogueRead) catalog.value = view;
  } catch (error) { if (read === catalogueRead) readError.value = launchError(error, label); }
  finally { if (read === catalogueRead) loading.value = false; }
}, { immediate: true, flush: "sync" });

function suiteInput(): SuiteInvocation {
  const context = catalog.value!.context;
  return { context: plain(context), locator: { ...context.project, suiteId: selected.value },
    invocationId: crypto.randomUUID(), evidenceMode: props.testing.evidenceMode,
    overrides: { allowDraft: allowDraft.value, ...(props.environmentId ? { environmentId: props.environmentId } : {}) } };
}
watch([kind, selected, () => props.environmentId, allowDraft, catalog], async () => {
  const read = ++previewRead, data = catalog.value;
  collection.value = undefined; workflow.value = undefined; suitePreview.value = undefined; previewError.value = "";
  if (!data) { reading.value = false; return; }
  reading.value = true;
  try {
    const context = data.context;
    if (kind.value === "stress") {
      const saved = await props.api.stressPlansList(plain(context.project));
      if (read === previewRead) plans.value = saved;
    } else if (selected.value && choices.value.some(item => item.id === selected.value)) {
      if (kind.value === "module" || chosenCase.value) {
        const collectionId = chosenCase.value?.locator.collectionId ?? selected.value;
        const result = await props.api.previewCollection({ root: context.root, locator: { ...context.project, collectionId },
          ...(props.environmentId ? { environmentId: props.environmentId } : {}) });
        if (read === previewRead) collection.value = result;
      } else if (kind.value === "suite") {
        const result = await props.api.previewSuite(suiteInput());
        if (read === previewRead) suitePreview.value = result;
      } else if (kind.value === "workflow") {
        const result = await props.api.wfGet({ ...context.project, workflowId: selected.value });
        if (read === previewRead) workflow.value = result.workflow;
      }
    }
    if (read === previewRead && selected.value) {
      const target = JSON.stringify([scope.value, kind.value, selected.value]);
      const signature = JSON.stringify([data.context.revision, props.environmentId, collection.value, suitePreview.value, workflow.value, savedPlan.value]);
      if (lastPreview?.target === target && lastPreview.signature !== signature) notice.value = label("preview-changed");
      lastPreview = {target, signature};
    }
  } catch (error) { if (read === previewRead) previewError.value = launchError(error, label); }
  finally { if (read === previewRead) reading.value = false; }
}, { immediate: true, flush: "sync" });

const effectiveCase = computed(() => {
  const picked = chosenCase.value;
  return picked && collection.value?.cases.find(item => item.apiId === picked.locator.apiId && item.caseId === picked.caseId
    && item.scope === picked.scope && JSON.stringify(item.folderIds) === JSON.stringify(picked.locator.folderIds));
});
const apiCount = computed(() => new Set(collection.value?.cases.map(item => JSON.stringify([item.folderIds, item.apiId]))).size);
const caseTab = computed(() => chosenCase.value ? props.debug.requestTabForSession(apiSessionKey(props.workspace.root, chosenCase.value.locator)) : null);
const caseState = computed(() => caseTab.value ? props.debug.requestTabs[caseTab.value.tabId] : undefined);
const reason = computed(() => {
  if (readError.value || previewError.value) return readError.value || previewError.value;
  if (!scope.value || (props.readOnly && !props.workspace.readOnly)) return label("unavailable");
  if (!selected.value || loading.value || reading.value) return "";
  if (!choices.value.some(item => item.id === selected.value)) return label("target-unavailable");
  if (props.environmentId && !catalog.value?.environments.some(item => item.id === props.environmentId) || actualEnvId.value && !actualEnv.value) return label("environment-unavailable");
  if ((kind.value === "module" || workflow.value) && actualEnv.value && catalog.value!.environments.some(env => env.id !== actualEnvId.value && env.name === actualEnv.value!.name)) return label("environment-ambiguous");
  if (kind.value === "module" && !collection.value?.cases.length) return label("no-cases");
  if (chosenCase.value) {
    if (!effectiveCase.value) return label("scope-unavailable");
    const key = apiSessionKey(props.workspace.root, chosenCase.value.locator), session = props.editor.sessions[key];
    const identity = chosenCase.value;
    if (session && (!isPersistedCase(session, identity) || props.cases.overrideDrafts.get(JSON.stringify([JSON.stringify([key, session.generation]), identity.caseId, identity.scope]))?.error)) return label("save-before-running");
    if (caseState.value?.sending || caseState.value?.starting) return label("busy");
  }
  if (suite.value && (!props.testing.current || props.testing.transitioning)) return label("unavailable");
  if (suite.value && props.testing.suite?.id === suite.value.id && props.testing.dirty) return label("save-before-running");
  if (workflow.value) {
    const design = props.workflowDesign;
    if (design.root === props.workspace.root && design.locator && projectSessionKey(design.root, design.locator) === scope.value && design.workflowId === selected.value && (design.dirty || design.saving)) return label("save-before-running");
    if (workflow.value.status === "draft") return label("workflow-draft");
  }
  if (savedPlan.value) {
    if (!StressPlanSchema.safeParse(savedPlan.value.plan).success) return label("invalid-stress");
    if (savedPlan.value.plan.environmentId && props.environmentId && savedPlan.value.plan.environmentId !== props.environmentId) return t("onlineStress.environmentMismatch");
    if (props.stress.planCurrent() && props.stress.savedPlanId === selected.value && JSON.stringify(props.stress.plan) !== JSON.stringify(savedPlan.value.plan)) return label("save-before-running");
  }
  return "";
});
const pendingOrigin = computed(() => props.stress.planConfirmation?.saved?.id === savedPlan.value?.id && !!savedPlan.value
  && props.stress.planCurrent() && props.stress.planConfirmation?.saved?.revision === catalog.value?.context.revision
  && props.stress.planConfirmation?.plan.environmentId === actualEnvId.value ? props.stress.planPendingOrigin : null);
function changed() { resetConfirmation(); refresh.value++; notice.value = label("preview-changed"); }
async function start(confirmOrigin = false) {
  if (!catalog.value || busy.value || reason.value || loading.value || reading.value || !selected.value
    || workflow.value && !inputsValid.value || !!pendingOrigin.value !== confirmOrigin) return;
  const captured = intent.value, owner = scope.value, data = catalog.value;
  const selection = selectionEpoch;
  const stillSelected = () => alive && scope.value === owner && selection === selectionEpoch;
  starting.value = true;
  notice.value = ""; archive.value = ""; debugHistoryId.value = "";
  try {
    const current = await props.api.listTestingAssets({ root: data.context.root, project: plain(data.context.project) });
    if (!stillSelected() || captured !== intent.value || reason.value) return;
    if (current.context.revision !== data.context.revision || catalog.value !== data) { changed(); return; }
    const context = current.context;
    let file: string | undefined, feedback: string | undefined;
    if (kind.value === "module" && collection.value) {
      const value = await props.run.runCollection(context.root, { ...context.project, collectionId: selected.value }, collection.value.environmentName,
        { root: context.root, revision: collection.value.revision, ...(props.environmentId ? { environmentId: props.environmentId } : {}) });
      file = value?.archiveFile;
    } else if (chosenCase.value) {
      const identity = chosenCase.value;
      const invocation = buildSavedCaseInvocation(identity.locator, { caseId: identity.caseId, scope: identity.scope }, props.environmentId ?? undefined, caseState.value?.settings ?? props.debug.settings);
      const result = await props.run.runSavedCase(invocation, context);
      if (result?.historyId && stillSelected()) debugHistoryId.value = result.historyId;
      if (result) feedback = [label("caseOutcome", { passed: result.run.passed, failed: result.run.failed }), result.error, ...result.warnings].filter(Boolean).join(" · ");
    } else if (suite.value && suitePreview.value) {
      const input = suiteInput(), before = suitePreview.value;
      const actual = await props.api.previewSuite(input);
      if (!stillSelected() || captured !== intent.value || reason.value) return;
      if (JSON.stringify(actual) !== JSON.stringify(before)) { changed(); return; }
      const result = await props.testing.run(input.overrides, { context, suiteId: suite.value.id, expectedDataDigest: actual.dataDigest });
      file = result?.archiveFile;
    } else if (workflow.value) {
      const result = await props.workflowDesign.run(actualEnv.value?.name, inputs.value, { root: context.root, revision: context.revision,
        workflow: workflow.value, locator: { ...context.project, workflowId: selected.value } });
      file = result?.archiveFile;
    } else if (savedPlan.value) {
      const saved = savedPlan.value;
      const latest = await props.api.stressPlansGet(plain(context.project), saved.id);
      if (!stillSelected() || captured !== intent.value || reason.value) return;
      if (!latest || JSON.stringify(saved) !== JSON.stringify(latest)) { changed(); return; }
      const result = confirmOrigin ? await props.stress.confirmPlanTarget(false, saved.id)
        : await props.stress.startPlan(false, { root: context.root, scope: context.project, revision: context.revision, id: saved.id,
          plan: StressPlanSchema.parse({ ...saved.plan, ...(actualEnvId.value ? { environmentId: actualEnvId.value } : {}) }) });
      if (!result) { if (stillSelected()) notice.value = props.stress.error ?? ""; return; }
      file = result.file;
    } else return;
    if (stillSelected()) { archive.value = file ?? ""; notice.value = feedback ?? label("finished"); }
  } catch (error) {
    if (stillSelected()) {
      if (/run-launch-preview-changed|revision-conflict|root\/revision changed/.test(String(error))) changed();
      else { notice.value = launchError(error, label); props.reportError(error); }
    }
  } finally { if (alive && scope.value === owner) starting.value = false; }
}
async function cancel() {
  try {
    if (ownCase.value && props.run.caseRunning && props.projectLocator) await props.run.cancelSavedCase(props.workspace.root, props.projectLocator);
    else if (props.testing.running && props.testing.current) await props.testing.cancel();
    else if (ownWorkflow.value) await props.workflowDesign.cancel();
    else if (props.stress.running && props.stress.planCurrent()) await props.stress.stopPlan();
  } catch (error) { props.reportError(error); }
}
</script>

<template>
  <RunLaunchForm v-model:kind="kind" v-model:selected="selected" :kinds="kinds" :choices="choices" :reason="reason" :notice="notice"
    :loading="loading || reading" :busy="busy" :disabled="!!pendingOrigin || (!!workflow && !inputsValid)" @launch="start()">
    <dl>
      <dt>{{ label('scope') }}</dt>
      <dd v-if="kind === 'module'">{{ label('moduleScope') }}</dd>
      <dd v-else-if="suitePreview">{{ label('entries', {count: suitePreview.entries.length}) }}</dd>
      <dd v-else-if="workflow">{{ label('nodes', {count: workflow.nodes.length}) }}</dd>
      <dd v-else-if="chosenCase">{{ effectiveCase?.apiName ?? chosenCase.label }} · {{ chosenCase.detail }}</dd>
      <dd v-else>{{ label(kind) }}</dd>
      <template v-if="kind === 'module' && collection"><dt>{{ label('applicable') }}</dt><dd>{{ label('apis', {count: apiCount}) }} · {{ label('cases', {count: collection.cases.length}) }}</dd></template>
      <dt>{{ label('environment') }}</dt><dd>{{ actualEnv?.name ?? (actualEnvId ? label('environment-unavailable') : t('onlineExecution.baseEnvironment')) }}</dd>
      <dt>{{ label('location') }}</dt><dd>{{ label('local') }}</dd>
      <template v-if="suite"><dt>{{ label('data') }}</dt><dd>{{ catalog?.datasets.find(item => item.id === suite?.datasetId)?.name ?? label('noData') }}</dd></template>
      <template v-if="savedPlan"><dt>{{ label('maxVus') }}</dt><dd>{{ savedPlan.plan.maxVus }}</dd></template>
    </dl>
    <section v-if="kind === 'module' && collection" class="case-preview" data-testid="module-scope">
      <header><h4>{{ label('previewCases') }}</h4><span>{{ label('cases', {count: collection.cases.length}) }}</span></header>
      <div class="case-scroll" v-if="collection.cases.length"><table>
        <thead><tr><th>{{ label('api') }}</th><th>{{ t('run.case') }}</th></tr></thead>
        <tbody><tr v-for="item in collection.cases" :key="JSON.stringify([item.folderIds,item.apiId,item.caseId,item.scope])">
          <td>{{ item.apiName }}</td><td>{{ item.caseName }}<small v-if="item.dataDriven"> · {{ label('dataDriven') }}</small></td>
        </tr></tbody>
      </table></div>
      <p v-for="item in collection.skipped" :key="JSON.stringify([item.folderIds,item.apiId])">{{ label('skippedCase', {name: item.apiName}) }}</p>
      <small v-if="collection.cases.some(item => item.dataDriven)">{{ label('rowsAfterRun') }}</small>
    </section>
    <label v-if="suite"><input v-model="allowDraft" type="checkbox" />{{ t('testing.allowDraft') }}</label>
    <RunWorkflowInputs v-if="workflow" :key="workflow.id" :workflow="workflow" @change="(value, valid) => { inputs = value; inputsValid = valid; }" />
    <section v-if="pendingOrigin"><p>{{ t('stress.targetConfirmation', {origin: pendingOrigin}) }}</p>
      <p>{{ t('stress.targetConfirmationRisk') }}</p>
      <button type="button" :disabled="busy || !!reason" @click="start(true)">{{ t('stress.confirmOnce') }}</button>
      <button type="button" @click="stress.denyPlanTarget()">{{ t('stress.denyTarget') }}</button>
    </section>
    <template #actions>
      <button v-if="ownCase || (testing.running && testing.current) || ownWorkflow || (stress.running && stress.planCurrent())" type="button" @click="cancel">{{ label('cancel') }}</button>
      <button v-if="debugHistoryId" type="button" data-testid="launch-open-debug" @click="emit('open-debug-record', debugHistoryId)">{{ label("inspect") }}</button>
      <button v-if="archive" type="button" data-testid="launch-open-record" @click="emit('records', archive)">{{ label('inspect') }}</button>
    </template>
  </RunLaunchForm>
</template>

<style scoped>
.case-preview header { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px; align-items: center; margin-bottom: 8px; }
.case-preview h4 { margin: 0; font-size: 15px; }
.case-preview p { color: var(--text-muted); margin: 6px 0; overflow-wrap: anywhere; }
.case-scroll { max-height: 230px; overflow: auto; border: 1px solid var(--border); border-radius: 5px; }
.case-scroll table { width: 100%; border-collapse: collapse; }
.case-scroll th, .case-scroll td { border-bottom: 1px solid var(--border); text-align: start; padding: 5px 8px; overflow-wrap: anywhere; }
.case-scroll th { position: sticky; top: 0; background: var(--subtle); white-space: nowrap; }
.case-scroll tr:last-child td { border-bottom: 0; }
.case-preview small { color: var(--text-muted); }
</style>

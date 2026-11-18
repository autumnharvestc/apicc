<script setup lang="ts">
import { computed, reactive, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { createOnlineStore } from "../../stores/online.js";
import type { createOnlineProjectAdapter } from "../../stores/onlineProjectAdapter.js";
import type { ContractProject, JsonValue, Workflow, StressTarget } from "@apicc/core";
import { ProjectRelativePathSchema } from "@apicc/execution/contract";
import { buildBindIndex, type WfBindIndex } from "../../wf/wfBindings.js";
import EnvPanel from "../EnvPanel.vue";
import DatasetPanel from "../DatasetPanel.vue";
import SuitePanel from "../SuitePanel.vue";
import WfDesigner from "../WfDesigner.vue";
import CasePanel from "../CasePanel.vue";
import CredentialEditor from "../CredentialEditor.vue";
import OnlineApiEditor from "../OnlineApiEditor.vue";
import ActionMenu from "../ActionMenu.vue";
import ResponseViewer from "../ResponseViewer.vue";
import { Modal as AModal, Button as AButton } from "ant-design-vue";
import OnlineRunRecordsHost from "./OnlineRunRecordsHost.vue";
import OnlineStressPanel from "./OnlineStressPanel.vue";
import { onlineExecutionLocationIssue } from "../../onlineExecutionLocation.js";
import { onlineSessionErrorKey } from "../../i18n/index.js";
import { runOnlineCase, runOnlineSuite, runOnlineWorkflow } from "../../execution/launch.js";
import type { SwitchView } from "../../viewSwitch.js";
import { isFullOnlineJob, OnlineReportSchema, type OnlineReport } from "../../../../shared/online/execution.js";
import { locateOnlineApi } from "../../stores/online.js";
const props = defineProps<{ online: ReturnType<typeof createOnlineStore>; adapter: ReturnType<typeof createOnlineProjectAdapter>; localProjects: Array<{ label: string; project: ContractProject }>; ai?: import('../../stores/ai.js').AiStore;
  view?: SwitchView; materialsOpen?: boolean; titlePath?: string;
  openProject?: (workspaceId: string, projectId: string) => Promise<boolean>;
  blank?: boolean; directoryWritable?: boolean; directoryDraft?: boolean }>();
const { t, te } = useI18n();
const moduleView = computed(() => props.view ?? "api");
const pane = ref<"cases" | "datasets" | "suites" | "stress">("cases");
const runPane = ref<"launch" | "records" | "schedules" | "notifications">("launch");
const runVisited = ref(false);
watch(moduleView, view => { if (view === "run") runVisited.value = true; }, { immediate: true });
const datasetName = ref(""); const suiteName = ref(""); const selectedApi = ref(""); const publishSource = ref("");
const stressVisited = ref(false);
const stressShortcut = ref<StressTarget>();
const stressPanel = ref<InstanceType<typeof OnlineStressPanel>>();
defineExpose({ confirmLeave: () => stressPanel.value?.confirmLeave() ?? true });
watch(pane, tab => { if (tab === "stress") stressVisited.value = true; });
const attachmentRef = ref(''); const attachmentPath = ref(''); const attachmentId = ref(''); const attachmentKind = ref<'file' | 'network-public'>('file');
async function upload(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  const refId = attachmentRef.value, kind = attachmentKind.value;
  const owner = contextKey.value;
  if (!file || readOnly.value || !refId) return;
  if (file.size > (execution.value.agents?.policy.singleAttachmentBytes ?? 0)) throw new Error("input-capacity-exceeded");
  const expectedVersion = execution.value.materialMetadata?.attachments.find(item => item.refId === refId)?.version ?? "0";
  const contentBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("attachment-read-failed"));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
  if (owner !== contextKey.value || !props.materialsOpen || readOnly.value) return;
  await execution.value.uploadAttachment({ refId, expectedVersion, kind, contentBase64 });
}
const execution = computed(() => props.online.execution);
const materialCredentials = computed(() => execution.value.materialMetadata?.credentials.map(credential => ({ ...credential, status: t(`contract.credentialStatus.${credential.status}`) })));
const entries = computed(() => execution.value.project ? props.adapter.apiEntries() : []);
const bindIndex = ref<WfBindIndex | null>(null);
const readOnly = computed(() => !execution.value.context || !props.online.canEdit(`${execution.value.context.scope.projectId}/project.yaml`));
function reportError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message !== "online-save-feedback") execution.value.error = message;
}
async function action(operation: () => unknown | Promise<unknown>) { const scope = JSON.stringify(execution.value.context); try { await operation(); } catch (error) { if (scope === JSON.stringify(execution.value.context) && execution.value.visible) reportError(error); } }
watch(() => [execution.value.context, execution.value.project], async (_, __, onCleanup) => {
  bindIndex.value = null;
  if (!execution.value.project) return;
  let active = true;
  onCleanup(() => { active = false; });
  const index = await buildBindIndex(props.adapter.workspace.tree, props.adapter.locator(), props.adapter.readBindingApi);
  if (active) bindIndex.value = index;
}, { immediate: true });
const contextKey = computed(() => JSON.stringify(execution.value.context));
const businessRunIssue = computed(() => {
  if (readOnly.value) return t("projectWorkbench.readOnlyRun");
  const env = execution.value.environmentId;
  if (env && !execution.value.project?.environments.some(item => item.id === env)) return t("environmentShortcut.unavailable");
  const issue = onlineExecutionLocationIssue(execution.value);
  if (issue) return te(issue) ? t(issue) : issue.split(".").at(-1);
  return execution.value.running ? t("onlineExecution.runInProgress") : "";
});
function issueText(code: string) {
  const session = onlineSessionErrorKey(code);
  if (session) return t(session);
  const reason = code.split("Error: ").at(-1)?.trim() ?? code;
  const [key, ...context] = reason.split(/[:\s]+/);
  const translation = key === "invalid-core-output" ? "onlineExecution.invalidOutput" : `onlineExecution.reasons.${key}`;
  return te(translation) ? [t(translation), ...context].join(" ") : code;
}
async function pickApi(key: string) {
  const entry = entries.value.find(item => JSON.stringify(item.locator) === key);
  if (entry) { const owner = contextKey.value; await props.adapter.editor.load(entry.locator); if (contextKey.value === owner) selectedApi.value = JSON.stringify(props.adapter.editor.locator); }
}
const selectedEntry = computed(() => {
  const project = execution.value.project, scope = execution.value.context?.scope.projectId;
  const path = props.online.editorPath;
  if (!project || !scope || !path?.startsWith(scope + "/")) return;
  const entry = locateOnlineApi(project, path.slice(scope.length + 1));
  if (entry && entry.asset.contract.id === props.online.editorApi?.contract.id) return { ...props.adapter.locator(), ...entry.target };
});

watch(contextKey, () => {
  selectedApi.value = ""; pane.value = "cases"; stressVisited.value = false; stressShortcut.value = undefined;
  datasetName.value = ""; suiteName.value = ""; publishSource.value = "";
  businessReceipts.clear();
  attachmentId.value = ""; attachmentRef.value = ""; attachmentPath.value = "";
});
const debugPathKey = computed(() => JSON.stringify([contextKey.value, props.online.editorPath]));
const debugSubmission = computed(() => {
  const where = selectedEntry.value;
  if (!where) return;
  return execution.value.submissions.find(item => {
    const saved = item.target.debugRequestLocator;
    return saved && saved.workspaceId === where.workspaceId && saved.groupId === where.groupId
      && saved.projectId === where.projectId && saved.collectionId === where.collectionId && saved.apiId === where.apiId
      && saved.folderIds.length === where.folderIds.length && saved.folderIds.every((id, index) => id === where.folderIds[index]);
  });
});
const debugSelection = computed(() => debugSubmission.value?.runId);
const debugJob = computed(() => {
  const original = debugSubmission.value?.job;
  if (!original) return;
  return execution.value.jobs.find(job => job.jobId === original.jobId && job.executionId === original.executionId) ?? original;
});
const debugPending = computed(() => !!debugSubmission.value?.pending);
const responseOpen = ref(false);
const responseError = ref("");
const agentReport = shallowRef<OnlineReport | null>(null);
const debugError = computed(() => {
  const output = debugSubmission.value?.result?.output ?? agentReport.value?.output;
  return responseError.value || debugSubmission.value?.error || (output?.kind === "failure" ? output.error : "");
});
watch(debugPathKey, () => { responseOpen.value = !!debugSelection.value; });
const debugOutput = computed(() => {
  const output = debugSubmission.value?.result?.output ?? agentReport.value?.output;
  return output?.kind === "debug" ? output.result : null;
});
watch([moduleView, debugPathKey, debugSelection, () => debugJob.value?.executionId,
  () => debugJob.value && isFullOnlineJob(debugJob.value) ? debugJob.value.reportState : null], async (_, __, cleanup) => {
  agentReport.value = null;
  responseError.value = "";
  const job = debugJob.value, context = execution.value.context;
  if (moduleView.value !== "api" || !context || !job || !isFullOnlineJob(job) || job.reportState !== "archived") return;
  let current = true;
  cleanup(() => { current = false; });
  try {
    const result = await props.adapter.bridge.onlineExecution({ operation: "report", context, location: { kind: "agent", agentId: job.agentId }, runId: job.jobId });
    if (!current) return;
    const report = OnlineReportSchema.parse(result);
    if (report.executionId !== job.executionId) throw new Error("fixed-input-mismatch");
    agentReport.value = report;
  } catch (error) {
    if (current) responseError.value = error instanceof Error ? error.message : String(error);
  }
}, { immediate: true, flush: "sync" });
const canCancelDebug = computed(() => {
  const job = debugJob.value;
  return !!debugSelection.value && (execution.value.activeLocalRunId === debugSelection.value ||
    !!job?.canCancel && job.state !== "ended" && job.cancelState !== "requested");
});
async function cancelDebug() {
  if (!canCancelDebug.value) return;
  if (debugJob.value) await execution.value.cancel(debugJob.value);
  else if (debugSelection.value === execution.value.activeLocalRunId) await execution.value.cancelLocal();
}
async function showDebugRecord() {
  const id = debugSelection.value, owner = debugPathKey.value;
  if (!id) return;
  await execution.value.selectSubmission(id);
  if (owner === debugPathKey.value && moduleView.value === "api") openRecords();
}
async function debugRequest() {
  const locator = selectedEntry.value, request = props.online.editorApi?.contract.request;
  if (!locator || !request || businessRunIssue.value || !props.online.canEdit(props.online.editorPath)) return;
  const address = debugPathKey.value, before = execution.value.resultSelection;
  responseError.value = "";
  const pending = execution.value.run({ kind: "debug", invocation: {
    mode: "request", locator, request: JSON.parse(JSON.stringify(request)), parameters: {}, fields: [],
    ...(execution.value.environmentId ? { environmentId: execution.value.environmentId } : {}),
  } });
  const selected = execution.value.resultSelection;
  if (selected && selected !== before && "runId" in selected) {
    responseOpen.value = true;
  }
  try { await pending; } catch (error) {
    if (debugPathKey.value === address) responseError.value = error instanceof Error ? error.message : String(error);
  }
}
const businessReceipts = reactive(new Map<string, string>());
const businessKey = computed(() => {
  const adapter = props.adapter;
  const target = moduleView.value === "wf" ? adapter.workflowDesign.locator
    : pane.value === "suites" ? adapter.testing.suite?.id
    : pane.value === "cases" && adapter.cases.selectedCase ? [adapter.editor.locator, adapter.cases.selectedCase] : null;
  return target ? JSON.stringify([contextKey.value, moduleView.value === "wf" ? "workflow" : pane.value, target]) : "";
});
const businessSubmission = computed(() => {
  const id = businessReceipts.get(businessKey.value);
  return id ? execution.value.submissions.find(item => item.runId === id) : undefined;
});
async function submitBusiness(start: () => Promise<void>) {
  const owner = businessKey.value, previous = execution.value.resultSelection;
  const pending = start(), selected = execution.value.resultSelection;
  if (owner && selected && selected !== previous && "runId" in selected) businessReceipts.set(owner, selected.runId);
  await pending;
}
async function showBusinessRecord(id: string) {
  const owner = contextKey.value, view = moduleView.value, key = businessKey.value;
  await execution.value.selectSubmission(id);
  if (contextKey.value === owner && moduleView.value === view && key === businessKey.value) openRecords();
}
async function runCase() {
  const locator = props.adapter.editor.locator, selected = props.adapter.cases.selectedCase;
  if (!locator || !selected || props.adapter.editor.dirty || businessRunIssue.value) return;
  await submitBusiness(() => runOnlineCase(execution.value, locator, selected));
}
async function workflowRun(workflow: Workflow, inputs?: Readonly<Record<string, JsonValue>>) {
  if (businessRunIssue.value) throw new Error(businessRunIssue.value);
  if (props.adapter.workflowDesign.dirty) throw new Error(t("wf.unsaved"));
  await submitBusiness(() => runOnlineWorkflow(execution.value, workflow, inputs));
}
async function suiteRun(allowDraft: boolean) {
  if (businessRunIssue.value) throw new Error(businessRunIssue.value);
  if (!props.adapter.testing.suite || props.adapter.testing.dirty) throw new Error(t("wf.unsaved"));
  const suite = props.adapter.testing.suite;
  await submitBusiness(() => runOnlineSuite(execution.value, suite, allowDraft));
}
function openStress(target: StressTarget) {
  if (readOnly.value || execution.value.running) return;
  stressShortcut.value = target;
  pane.value = "stress";
  emit("update:view", "test");
}
function openRecords() {
  runPane.value = "records";
  emit("update:view", "run");
}
const auth = computed(() => props.online.editorApi?.contract.request.auth);
function authKind(value: string) { const request = props.online.editorApi?.contract.request; if (!request || readOnly.value) return; request.auth = value === "bearer" ? { kind: "bearer", token: { id: "project-token", policy: "test-auto" } } : value === "basic" ? { kind: "basic", username: "", password: { id: "project-password", policy: "test-auto" } } : value === "apikey" ? { kind: "apikey", name: "X-API-Key", placement: "header", value: { id: "project-api-key", policy: "test-auto" } } : { kind: "none" }; }
const credentialRef = computed(() => auth.value?.kind === "bearer" ? auth.value.token : auth.value?.kind === "basic" ? auth.value.password : auth.value?.kind === "apikey" ? auth.value.value : null);
function localOnly(checked: boolean) { const id = credentialRef.value?.id; if (!id) return; execution.value.localOnlyRefIds = checked ? [...new Set([...execution.value.localOnlyRefIds, id])] : execution.value.localOnlyRefIds.filter(ref => ref !== id); }
const emit = defineEmits<{ published: [projectId: string]; 'update:view': [view: SwitchView]; 'close-materials': []; 'create-api': []; 'collaboration-result': [value: { context: import('../../../../shared/online/execution.js').OnlineExecutionContext; source: import('../../../../shared/online/collaboration.js').CollaborationLocalSource }] }>();
async function publish() { const item = props.localProjects.find(item => item.project.id === publishSource.value); const context = execution.value.context; if (!item || !context) return; const captured = JSON.stringify(context); const result = await props.adapter.bridge.onlineExecution({ operation: "publishNew", context, name: item.project.name, project: item.project }); if (captured !== JSON.stringify(execution.value.context)) return; if (typeof result === 'object' && result !== null && 'scope' in result && 'view' in result) { await props.online.refreshTreeView(); if (captured === contextKey.value) emit('published', result.scope.projectId); } }

</script>
<template>
  <section class="online-project" data-testid="online-project-assets">
    <p v-if="execution.busy && !execution.view" role="status">{{ t('onlineExecution.loading') }}</p>
    <template v-else>
      <div v-if="moduleView === 'api' && directoryDraft" class="asset-scroll" data-testid="online-draft"><slot name="draft" /></div>
      <OnlineApiEditor v-else-if="moduleView === 'api' && online.editorKind === 'file'" :online="online" />
      <section v-else-if="blank || !execution.project" class="legacy" :data-testid="blank ? 'online-directory-blank' : 'online-legacy-limitation'">
        <p v-if="blank">{{ t(directoryWritable ? 'onlineDirectory.blank' : 'onlineDirectory.blankReadOnly') }}</p>
        <p v-else>{{ t(execution.view ? 'onlineExecution.legacy' : 'onlineExecution.notCollected') }}</p>
        <button v-if="directoryWritable && blank" @click="emit('create-api')">{{ t('tree.newApi') }}</button>
        <OnlineApiEditor v-if="!blank && online.editorPath" :online="online" />
        <template v-if="execution.view">
          <ul v-if="execution.view.problems.length"><li v-for="problem in execution.view.problems" :key="problem">{{ problem === 'legacy-format-publish-new-project' ? t('onlineExecution.legacy') : problem }}</li></ul>
          <p>{{ t('onlineExecution.publishEmpty') }}</p>
          <select v-model="publishSource" :aria-label="t('onlineExecution.localProject')"><option value="">{{ t('onlineExecution.localProject') }}</option><option v-for="item in localProjects" :key="item.project.id" :value="item.project.id">{{ item.label }}</option></select>
          <button :disabled="!publishSource || readOnly" @click="action(publish)">{{ t('onlineExecution.publish') }}</button>
        </template>
      </section>
      <section v-else-if="moduleView === 'api'" class="api-workbench">
        <div v-if="!online.editorPath" class="guide" data-testid="online-project-api-empty">
          <p>{{ t("projectWorkbench.pickApi") }}</p>
          <a-button v-if="directoryWritable" @click="emit('create-api')">{{ t('tree.newApi') }}</a-button>
        </div>
        <template v-else>
          <OnlineApiEditor :online="online" :title-path="titlePath" class="api-editor">
            <template #send>
              <a-button type="primary" :disabled="!!businessRunIssue || !selectedEntry" data-testid="online-debug-run" @click="action(debugRequest)">{{ t('editor.send') }}</a-button>
              <ActionMenu :label="t('requestWorkbench.more')" test-id="online-debug-more" :disabled="!selectedEntry || readOnly || execution.running"
                :items="[{ key: 'session', label: t('onlineExecution.newSession') }]" @select="execution.newDebugSession()">⋯</ActionMenu>
            </template>
            <template #auth><section class="auth"><p>{{ t('onlineExecution.authInProject') }}</p><p v-if="!auth">{{ t('onlineExecution.pickApi') }}</p><template v-else><select :value="auth.kind" :disabled="readOnly" @change="authKind(($event.target as HTMLSelectElement).value)"><option value="none">{{ t('online.authNone') }}</option><option value="bearer">Bearer</option><option value="basic">Basic</option><option value="apikey">API Key</option><option v-if="auth.kind === 'componentRef'" value="componentRef">{{ t('online.authComponent') }}</option></select><label v-if="credentialRef">{{ t('onlineExecution.refId') }}<input v-model="credentialRef.id" :disabled="readOnly" /></label><label v-if="auth.kind === 'basic'">{{ t('onlineExecution.username') }}<input v-model="auth.username" :disabled="readOnly" /></label><template v-if="auth.kind === 'apikey'"><label>{{ t('onlineExecution.keyName') }}<input v-model="auth.name" :disabled="readOnly" /></label><select v-model="auth.placement" :disabled="readOnly"><option value="header">Header</option><option value="query">Query</option></select></template><button :disabled="readOnly" @click="action(() => online.saveApi())">{{ t('onlineExecution.saveAuth') }}</button><label v-if="credentialRef"><input type="checkbox" :checked="execution.localOnlyRefIds.includes(credentialRef.id)" :disabled="readOnly" @change="localOnly(($event.target as HTMLInputElement).checked)" />{{ t('onlineExecution.localOnly') }}</label><CredentialEditor v-if="credentialRef" :api="adapter.bridge" :locator="adapter.locator()" :auth="auth" :context-key="JSON.stringify([execution.context, execution.localOnlyRefIds])" managed-state="unmanaged" :read-only="readOnly" /></template></section></template>
          </OnlineApiEditor>
          <p v-if="online.editorApi && (businessRunIssue || !selectedEntry)" class="feedback" role="status">{{ businessRunIssue || t('projectWorkbench.savedTargetRequired') }}</p>
          <section v-if="selectedEntry" class="api-response" data-testid="online-debug-response">
            <header><strong>{{ t("projectWorkbench.response") }}</strong>
              <button v-if="canCancelDebug" @click="action(cancelDebug)">{{ t("onlineExecution.cancel") }}</button>
              <button v-if="debugSelection" @click="action(showDebugRecord)">{{ t("projectWorkbench.viewRun") }}</button>
              <button :aria-expanded="responseOpen" @click="responseOpen = !responseOpen">{{ t(responseOpen ? "responseWorkbench.collapse" : "responseWorkbench.expand") }}</button>
            </header>
            <p v-if="debugError" class="feedback" role="alert">{{ issueText(debugError) }}</p>
            <p v-if="debugJob" role="status">{{ t('onlineExecution.state') }} · {{ t('onlineExecution.states.' + debugJob.state) }}</p>
            <ResponseViewer v-if="responseOpen" :sending="debugPending" :result="debugOutput" />
          </section>
        </template>
      </section>
      <template v-if="execution.project && !blank">
        <EnvPanel v-if="moduleView === 'envs'" class="asset-scroll" :envs="adapter.envs" :workspace="adapter.workspace" :project-locator="adapter.locator()" :report-error="reportError" />
        <WfDesigner v-if="moduleView === 'wf'" class="asset-scroll" :ai="ai" :workflow-design="adapter.workflowDesign" :wf-list="adapter.wfList" :workspace="adapter.workspace" :project-locator="adapter.locator()" :bind-index="bindIndex" :report-error="reportError" :external-run="workflowRun" :external-run-issue="businessRunIssue" @stress-workflow="loc => openStress({ kind: 'workflow', workflowId: loc.workflowId })" />
        <nav v-if="moduleView === 'test'" class="tabs" :aria-label="t('nav.test')">
          <button v-for="tab in (['cases','suites','datasets','stress'] as const)" :key="tab" :aria-current="pane === tab ? 'page' : undefined" @click="pane = tab">{{ t(tab === 'stress' ? 'stress.title' : 'onlineExecution.panes.' + tab) }}</button>
        </nav>
        <div v-if="moduleView === 'test'" class="asset-scroll" v-show="pane !== 'stress'">
          <template v-if="pane === 'cases'"><select data-testid="online-case-api" :value="selectedApi" @change="action(() => pickApi(($event.target as HTMLSelectElement).value))"><option value="">{{ t('onlineExecution.pickApi') }}</option><option v-for="entry in entries" :key="JSON.stringify(entry.locator)" :value="JSON.stringify(entry.locator)">{{ entry.asset.contract.metadata.name }}</option></select><button v-if="ai" :disabled="readOnly || !adapter.editor.api || ai.suggestLoading" @click="ai.fetchSuggestions()">{{ t('ai.suggestBtn') }}</button><CasePanel :ai="ai" :editor="adapter.editor" :cases="adapter.cases" :read-only="readOnly" :datasets="execution.project.datasets" :operators="adapter.testing.operators" :report-error="reportError" /><button v-if="adapter.cases.selectedCase && adapter.editor.locator" :disabled="readOnly || adapter.editor.dirty" @click="openStress({ kind: 'case', collectionId: adapter.editor.locator.collectionId, apiId: adapter.editor.locator.apiId, caseId: adapter.cases.selectedCase.caseId })">{{ t('case.stress') }}</button><button :disabled="!adapter.cases.selectedCase || !!businessRunIssue || adapter.editor.dirty" @click="action(runCase)">{{ t('onlineExecution.runCase') }}</button><p v-if="businessRunIssue" role="status">{{ businessRunIssue }}</p></template>
          <template v-else-if="pane === 'datasets'"><div class="toolbar"><select :value="adapter.testing.dataset?.id ?? ''" @change="action(() => adapter.testing.select('dataset', ($event.target as HTMLSelectElement).value))"><option value="">{{ t('testing.pickDataset') }}</option><option v-for="item in execution.project.datasets" :key="item.id" :value="item.id">{{ item.name }}</option></select><input v-model="datasetName" :placeholder="t('testing.name')" /><button :disabled="readOnly || !datasetName" @click="action(() => adapter.testing.newDataset(datasetName))">{{ t('testing.newDataset') }}</button></div><DatasetPanel :testing="adapter.testing" /></template>
          <template v-else-if="pane === 'suites'"><div class="toolbar"><select :value="adapter.testing.suite?.id ?? ''" @change="action(() => adapter.testing.select('suite', ($event.target as HTMLSelectElement).value))"><option value="">{{ t('testing.pickSuite') }}</option><option v-for="item in execution.project.suites" :key="item.id" :value="item.id">{{ item.name }}</option></select><input v-model="suiteName" :placeholder="t('testing.name')" /><button :disabled="readOnly || !suiteName" @click="action(() => adapter.testing.newSuite(suiteName))">{{ t('testing.newSuite') }}</button></div><SuitePanel :ai="ai" :testing="adapter.testing" :external-run="suiteRun" :external-run-issue="businessRunIssue" /></template>
        </div>
        <OnlineStressPanel ref="stressPanel" v-if="stressVisited" v-show="moduleView === 'test' && pane === 'stress'" class="asset-scroll" :execution="execution" :read-only="readOnly" :shortcut="stressShortcut" @record="id => action(() => showBusinessRecord(id))" />
        <div v-if="['wf','test'].includes(moduleView) && businessSubmission" class="toolbar" role="status">
          <span v-if="businessSubmission.pending">{{ t('projectWorkbench.waiting') }}</span>
          <button @click="action(() => showBusinessRecord(businessSubmission!.runId))">{{ t("projectWorkbench.viewRun") }}</button>
        </div>
        <p v-if="['wf','test'].includes(moduleView) && execution.error" class="feedback" role="alert">{{ issueText(execution.error) }}</p>

        <a-modal v-if="materialsOpen" :open="materialsOpen" :footer="null" :title="t('onlineExecution.panes.materials')" @cancel="emit('close-materials')">
          <section class="materials">
            <button type="button" @click="action(() => execution.reloadMaterials())">{{ t('projectWorkbench.materialsRefresh') }}</button>
            <p>{{ t('onlineExecution.attachmentHint') }}</p>
            <label>{{ t('onlineExecution.attachmentRef') }}<input v-model="attachmentRef" :disabled="readOnly" /></label>
            <select v-model="attachmentKind" :disabled="readOnly" :aria-label="t('projectWorkbench.attachmentKind')">
              <option value="file">{{ t('onlineExecution.file') }}</option><option value="network-public">{{ t('onlineExecution.networkPublic') }}</option>
            </select>
            <label>{{ t('onlineExecution.upload') }}<input type="file" :disabled="readOnly || !attachmentRef" @change="action(() => upload($event))" /></label>
            <table v-if="materialCredentials?.length">
              <thead><tr><th>{{ t('onlineExecution.refId') }}</th><th>{{ t('onlineExecution.version') }}</th><th>{{ t('onlineExecution.materialState') }}</th></tr></thead>
              <tbody><tr v-for="credential in materialCredentials" :key="credential.refId"><td>{{ credential.refId }}</td><td>{{ credential.version }}</td><td>{{ credential.status }}</td></tr></tbody>
            </table>
            <table v-if="execution.materialMetadata?.attachments.length">
              <thead><tr><th>{{ t('onlineExecution.attachmentRef') }}</th><th>{{ t('onlineExecution.version') }}</th><th>{{ t('onlineExecution.bytes') }}</th></tr></thead>
              <tbody><tr v-for="attachment in execution.materialMetadata.attachments" :key="attachment.refId"><td>{{ attachment.refId }}</td><td>{{ attachment.version }}</td><td>{{ attachment.size }}</td></tr></tbody>
            </table>
            <label>{{ t('onlineExecution.attachmentPath') }}<input v-model="attachmentPath" :disabled="readOnly" /></label>
            <select v-model="attachmentId" :disabled="readOnly" :aria-label="t('onlineExecution.attachmentRef')">
              <option value="">{{ t('onlineExecution.attachmentRef') }}</option>
              <option v-for="attachment in execution.materialMetadata?.attachments" :key="attachment.refId" :value="attachment.refId">{{ attachment.refId }}</option>
            </select>
            <button :disabled="readOnly || !attachmentPath || !attachmentId" @click="action(() => execution.bindAttachment(ProjectRelativePathSchema.parse(attachmentPath), attachmentId))">{{ t('onlineExecution.bindAttachment') }}</button>
            <ul><li v-for="(attachment, path) in execution.materials.attachmentPaths" :key="path">{{ path }} → {{ attachment.refId }} · {{ t('onlineExecution.version') }} {{ attachment.version }}</li></ul>
          </section>
          <p v-if="execution.error" role="alert">{{ issueText(execution.error) }}</p>
        </a-modal>
      </template>
    </template>
        <OnlineRunRecordsHost v-if="runVisited" v-show="moduleView === 'run' && !!execution.project" :active="moduleView === 'run'" v-model:pane="runPane" :online="online" :adapter="adapter" :ai="ai" :read-only="readOnly" :report-error="reportError" :open-project="openProject" @collaboration="emit('collaboration-result', $event)" />
  </section>
</template>
<style scoped src="../../styles/online-controls.css"></style>
<style scoped>
.online-project, .api-workbench { display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;overflow:hidden; }
.asset-scroll, .legacy, .api-editor { flex:1;min-height:0;overflow:auto; }
.guide, .legacy, .toolbar, .tabs, .feedback { padding:8px 12px; }
.toolbar,.tabs,.api-response header { display:flex;gap:8px;align-items:center;flex-wrap:wrap; }
.tabs { border-bottom:1px solid var(--border); }
.tabs button[aria-current] { color:var(--accent);border-color:var(--accent);background:var(--active-weak); }
.api-response { flex:none;max-height:45%;overflow:auto;border-top:1px solid var(--border); }
.api-response header { padding:5px 12px; } .api-response header strong { margin-inline-end:auto; }
.feedback { margin:0;overflow-wrap:anywhere;color:var(--text-muted); }
.materials,.auth { min-width:0;overflow:auto;max-height:65vh; }
.materials label,.auth label { display:flex;gap:8px;margin:8px 0;align-items:center;flex-wrap:wrap; }
</style>

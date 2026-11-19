<script setup lang="ts">
import { EllipsisOutlined, FileOutlined, PlusOutlined, PlayCircleOutlined } from "@ant-design/icons-vue";
import ActionMenu from "./ActionMenu.vue";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { SuiteEntry } from "@apicc/core";
import type { TestingStore } from "../stores/testing.js";
import { diskErrorMessage } from "../diskRefreshPresentation.js";
import { LocalWorkspaceError } from "../../../shared/workspace-refresh.js";
import CaseEvidencePanel from "./CaseEvidencePanel.vue";
import type { EvidenceIdentity } from "@apicc/core";
import { reportEntryEvidence } from "@apicc/core/report/units";
import { caseEvidenceIdentity } from '../ai/evidenceNavigation.js';
import type { LocalRunRecordTarget } from "../execution/localLaunch.js";
import { useLaunchMessages } from "../execution/launchMessages.js";
function runOverrides() {
  const id = props.projectEnvironment?.value;
  if (id && !props.projectEnvironment?.options.some(option => option.key === id)) throw new Error(t('environmentShortcut.unavailable'));
  return { allowDraft: allowDraft.value, ...(id ? { environmentId: id } : {}) };
}
const emit = defineEmits<{ (event: "locate-evidence", identity: EvidenceIdentity): void; (event: "open-run-record", target: LocalRunRecordTarget): void }>();
const props = defineProps<{ testing: TestingStore; projectEnvironment?: import("../debugEnvironment.js").DebugEnvironmentSelection; externalPreview?: (allowDraft: boolean) => import("@apicc/core/testing/selection").ResolvedSuitePlan; environmentId?: string; externalRunIssue?: string; externalRun?: (allowDraft: boolean) => Promise<void>; ai?: import('../stores/ai.js').AiStore; refreshingDisk?: boolean }>();
const { t, te } = useI18n(); const allowDraft = ref(false); const error = ref("");
const launchLabel = useLaunchMessages();
const onlinePreview = ref<ReturnType<NonNullable<typeof props.externalPreview>>>();
async function preview() {
  if (props.testing.dirty || !props.testing.current) return;
  if (props.externalPreview) onlinePreview.value = props.externalPreview(allowDraft.value);
  else await props.testing.previewSuite(runOverrides());
}
const record = computed<LocalRunRecordTarget | undefined>(() => {
  const result = props.testing.result;
  if (!props.externalRun && props.testing.current && result?.archiveFile) {
    return { ...result.context, kind: "archive", id: result.archiveFile };
  }
});
const errorIsTyped = ref(false);
function stateLabel(code: string | undefined) { if (!code) return '—'; const key = `executionLabels.${code}`; return te(key) ? t(key) : code; }
function workflowStatus(code: string) { return ['draft','published','enabled'].includes(code) ? t(`testingUi.workflowStates.${code}`) : code; }
const showChoices = ref(false);
const suite = computed(() => props.testing.suite);
const resourceKey = computed(() => JSON.stringify([props.testing.view?.context.root, props.testing.view?.context.project, suite.value?.id]));
watch(resourceKey, () => { showChoices.value = false; allowDraft.value = false; error.value = ""; errorIsTyped.value = false; });
watch([resourceKey, allowDraft, () => props.testing.dirty, () => props.testing.view?.context.revision, () => props.environmentId], () => { onlinePreview.value = undefined; });
watch(() => props.testing.saveFailure, (failure) => { if (!failure && errorIsTyped.value) { error.value = ""; errorIsTyped.value = false; } });
async function attempt(operation: () => unknown | Promise<unknown>) {
  const key = resourceKey.value;
  try { await operation(); if (key === resourceKey.value) { error.value = ""; errorIsTyped.value = false; } }
  catch (failure) { if (key === resourceKey.value) { error.value = diskErrorMessage(failure, t); errorIsTyped.value = failure instanceof LocalWorkspaceError; } }
}
function field(key: string, value: unknown) { if (!props.testing.readOnly && suite.value) Object.assign(suite.value, { [key]: value }); }
function mode(value: string) { if (!props.testing.readOnly && suite.value) suite.value.selection = value === "query" ? { kind: "query" } : { kind: "explicit", entries: [] }; }
function checked(entry: Omit<Extract<SuiteEntry, { kind: "case" }>, "id"> | Omit<Extract<SuiteEntry, { kind: "workflow" }>, "id">) {
  return suite.value?.selection.kind === "explicit" && suite.value.selection.entries.some(item => same(item, entry));
}
function same(left: SuiteEntry, right: Parameters<typeof checked>[0]) {
  return left.kind === "workflow" ? right.kind === "workflow" && left.workflowId === right.workflowId : right.kind === "case" && left.collectionId === right.collectionId && left.apiId === right.apiId && left.caseId === right.caseId && JSON.stringify(left.folderIds) === JSON.stringify(right.folderIds);
}
function toggle(entry: Parameters<typeof checked>[0], value: boolean) {
  if (props.testing.readOnly || suite.value?.selection.kind !== "explicit") return;
  const entries = suite.value.selection.entries; const index = entries.findIndex(item => same(item, entry));
  if (value && index < 0) entries.push({ ...entry, id: crypto.randomUUID() }); else if (!value && index >= 0) entries.splice(index, 1);
}
function move(index: number, delta: number) { if (!props.testing.readOnly && suite.value?.selection.kind === "explicit") { const entries = suite.value.selection.entries; if (index + delta >= 0 && index + delta < entries.length) entries.splice(index + delta, 0, ...entries.splice(index, 1)); } }
function query(key: "collectionIds" | "caseTags", value: string[]) { if (!props.testing.readOnly && suite.value?.selection.kind === "query") { if (value.length) suite.value.selection[key] = value; else delete suite.value.selection[key]; } }
function optional(key: "environmentId" | "datasetId", value: string) { if (props.testing.readOnly || !suite.value) return; if (value) suite.value[key] = value; else delete suite.value[key]; }
function caseSummary(entry: { collectionId: string; folderIds: readonly string[]; apiId: string; caseId: string }) {
  return props.testing.view?.cases.find(item => item.locator.apiId === entry.apiId && item.locator.collectionId === entry.collectionId &&
    JSON.stringify(item.locator.folderIds) === JSON.stringify(entry.folderIds) && item.caseId === entry.caseId);
}
const label = (entry: SuiteEntry) => entry.kind === "workflow" ? props.testing.view?.workflows.find(item => item.id === entry.workflowId)?.name ?? entry.workflowId
  : caseSummary(entry)?.caseName ?? caseSummary(entry)?.name ?? entry.caseId;
type ResultEntry = NonNullable<NonNullable<import("@apicc/core").RunResult["suite"]>["entries"]>[number];
function resultEntryName(entry: ResultEntry) {
  if (entry.workflowId) return props.testing.view?.workflows.find(item => item.id === entry.workflowId)?.name ?? entry.workflowId;
  const row = props.testing.result?.result.cases.find(item => item.entryId === entry.entryId && item.suiteRow === entry.suiteRow);
  if (row) return [row.apiName, row.caseName].filter(Boolean).join(" / ");
  if (entry.caseLocator) return caseSummary(entry.caseLocator)?.name ?? entry.caseLocator.caseId;
  const definition = suite.value?.selection.kind === "explicit" && suite.value.selection.entries.find(item => item.id === entry.entryId);
  return definition ? label(definition) : entry.entryId;
}
function sourceName(label: string) {
  const match = /^(dataset|file):(\d+)$/.exec(label);
  return match ? t(match[1] === "dataset" ? "testAssets.datasetSource" : "testAssets.fileSource", { number: match[2] }) : label;
}
function entryEvidence(entry: ResultEntry): import("@apicc/core").SafeExecutionEvidence {
  return reportEntryEvidence(props.testing.result!.result, entry);
}
function analyzeReport() {
  const displayed = props.testing.result, context = props.testing.view?.context, key = resourceKey.value;
  if (!displayed || !context || !props.ai) return;
  void props.ai.prepareReportAnalysis({ source: { kind: 'local', project: context.project }, displayed,
    isCurrent: () => props.testing.result === displayed && resourceKey.value === key,
    canLocateEvidence: (evidence, authorised) => !!caseEvidenceIdentity(evidence, authorised, displayed.result.cases),
    locateEvidence: (evidence, authorised) => {
      const identity = caseEvidenceIdentity(evidence, authorised, displayed.result.cases);
      if (identity) emit('locate-evidence', identity);
    } });
}
</script>
<template>
  <section class="suite-panel asset-detail" data-testid="suite-panel">
    <header v-if="suite" class="asset-heading"><h2>{{ suite.name }}</h2><span class="saved-state">{{ t(testing.dirty ? 'testing.unsaved' : 'testAssets.saved') }}</span><div class="asset-actions">
      <button class="run-suite" data-testid="suite-run" :disabled="!!externalRunIssue || testing.dirty || testing.running || !testing.current" @click="attempt(() => externalRun ? externalRun(allowDraft) : testing.run(runOverrides()))"><PlayCircleOutlined /> {{ t('testing.run') }}</button>
      <button class="primary" data-testid="suite-save" :disabled="testing.readOnly || refreshingDisk || testing.busy || !!testing.diskConflict" @click="attempt(() => testing.save())">{{ t('testAssets.saveSuite') }}</button>
      <ActionMenu test-id="suite-more" :label="t('requestWorkbench.more')" :items="[{key:'clear',label:t('testAssets.clear')},
        {key:'delete',label:t('testing.remove'),disabled:testing.readOnly || refreshingDisk || testing.creating || testing.running || !!testing.diskConflict,danger:true}]"
        @select="key => attempt(() => key === 'clear' ? testing.select('suite','') : testing.remove())"><EllipsisOutlined /></ActionMenu>
      </div></header>
    <p v-if="error || testing.error" role="alert" class="error">{{ testing.saveFailure ? t(`diskRefresh.error.${testing.saveFailure.reason}`) : error || (testing.error === "workbenchPosition.unavailable" ? t(testing.error) : testing.error) }}</p>
    <div v-if="!suite" class="empty-state"><FileOutlined /><h2>{{ t('testAssets.pickSuite') }}</h2><p>{{ t('testAssets.chooseSuite') }}</p></div>
    <template v-else>
      <div class="editor-scroll">
        <div class="form-card"><label>{{ t('testing.name') }}<input :value="suite.name" :disabled="testing.readOnly" @input="field('name', ($event.target as HTMLInputElement).value)" /></label>
        <label>{{ t('testAssets.dataset') }}<select :value="suite.datasetId ?? ''" :disabled="testing.readOnly" @change="optional('datasetId',($event.target as HTMLSelectElement).value)"><option value="">{{ t('testing.none') }}</option><option v-for="item in testing.view?.datasets" :key="item.id" :value="item.id">{{ item.name }} · {{ item.rows.length }} {{ t('testing.rows') }}</option></select></label>
        <label>{{ t('testing.selection') }}<select :value="suite.selection.kind" :disabled="testing.readOnly" @change="mode(($event.target as HTMLSelectElement).value)"><option value="explicit">{{ t('testAssets.explicit') }}</option><option value="query">{{ t('testing.query') }}</option></select></label>
        <template v-if="suite.selection.kind === 'explicit'">
          <div class="section-heading"><h3>{{ t('testAssets.order') }}</h3><button :disabled="testing.readOnly" @click="showChoices = !showChoices"><PlusOutlined /> {{ t('testAssets.addCases') }}</button></div>
          <div v-show="showChoices" class="choices">
            <label v-for="item in testing.view?.cases" :key="JSON.stringify([item.locator,item.caseId])"><input type="checkbox" data-testid="suite-case-choice" :checked="checked({kind:'case', collectionId:item.locator.collectionId, folderIds:item.locator.folderIds, apiId:item.locator.apiId, caseId:item.caseId})" :disabled="testing.readOnly" @change="toggle({kind:'case',collectionId:item.locator.collectionId,folderIds:item.locator.folderIds,apiId:item.locator.apiId,caseId:item.caseId},($event.target as HTMLInputElement).checked)" />{{ [item.modulePath, item.name].filter(Boolean).join(" / ") }} · {{ item.scopes.map(scope => scope === "base" ? t("testWorkbench.baseCase") : scope).join(", ") }}</label>
            <label v-for="item in testing.view?.workflows" :key="item.id"><input type="checkbox" :checked="checked({kind:'workflow',workflowId:item.id})" :disabled="testing.readOnly" @change="toggle({kind:'workflow',workflowId:item.id},($event.target as HTMLInputElement).checked)" />{{ item.name }} · {{ workflowStatus(item.status) }}</label>
          </div>
          <div class="table-scroll"><table class="selected-entries"><thead><tr><th>{{ t('testAssets.sequence') }}</th><th>{{ t('nav.api') }}</th><th>{{ t('testingUi.case') }}</th><th>{{ t('testingUi.actions') }}</th></tr></thead>
            <tbody><tr v-for="(entry,index) in suite.selection.entries" :key="entry.id"><th>{{ index + 1 }}</th><td>{{ entry.kind === 'workflow' ? t('testingUi.workflow') : caseSummary(entry)?.apiName ?? entry.apiId }}</td><td>{{ label(entry) }}</td><td class="order-controls"><button :aria-label="t('testingUi.moveUp', {name:label(entry)})" :title="t('testingUi.moveUp', {name:label(entry)})" :disabled="testing.readOnly || index === 0" @click="move(index,-1)">↑</button><button :aria-label="t('testingUi.moveDown', {name:label(entry)})" :title="t('testingUi.moveDown', {name:label(entry)})" :disabled="testing.readOnly || index === suite.selection.entries.length - 1" @click="move(index,1)">↓</button></td></tr></tbody></table></div>
        </template>
        <template v-else>
          <label>{{ t('testing.collections') }}<select multiple :value="suite.selection.collectionIds" :disabled="testing.readOnly" @change="query('collectionIds',Array.from(($event.target as HTMLSelectElement).selectedOptions).map(item => item.value))"><option v-for="item in testing.view?.collections" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
          <label>{{ t('testing.caseTags') }}<input data-testid="suite-query-tags" :value="suite.selection.caseTags?.join(', ')" :disabled="testing.readOnly" @change="query('caseTags',($event.target as HTMLInputElement).value.split(',').map(value=>value.trim()).filter(Boolean))" /></label>
          <p class="hint">{{ t('testing.queryHint') }}</p>
        </template>
        <label><input type="checkbox" :checked="suite.failFast" :disabled="testing.readOnly" @change="field('failFast',($event.target as HTMLInputElement).checked)" />{{ t('testing.failFast') }}</label>
        </div><details class="form-card fold"><summary>{{ t('testingUi.runSettings') }}</summary>        <label>{{ t('testing.description') }}<input :value="suite.description" :disabled="testing.readOnly" @input="field('description', ($event.target as HTMLInputElement).value)" /></label>
        <label>{{ t('testing.tags') }}<input :value="suite.tags.join(', ')" :disabled="testing.readOnly" @change="field('tags', ($event.target as HTMLInputElement).value.split(',').map(value => value.trim()).filter(Boolean))" /></label>
<label>{{ t('testing.environment') }}<select :value="suite.environmentId ?? ''" :disabled="testing.readOnly" @change="optional('environmentId',($event.target as HTMLSelectElement).value)"><option value="">{{ t('testingUi.baseEnvironment') }}</option><option v-for="item in testing.view?.environments" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>


        <label>{{ t('testing.reporters') }}<select multiple :value="suite.reporters" :disabled="testing.readOnly" @change="field('reporters',Array.from(($event.target as HTMLSelectElement).selectedOptions).map(item=>item.value))"><option>html</option><option>json</option><option>junit</option></select></label>
<label v-if="!externalRun" class="evidence-setting">{{ t('caseEvidence.collection') }}<select v-model="testing.evidenceMode" :disabled="testing.running || testing.transitioning"><option value="none">{{ t('caseEvidence.modeNone') }}</option><option value="failures">{{ t('caseEvidence.modeFailures') }}</option><option value="all">{{ t('caseEvidence.modeAll') }}</option></select></label>
      <div class="run-toolbar"><label><input v-model="allowDraft" type="checkbox" :disabled="testing.running" />{{ t('testing.allowDraft') }}</label><button v-if="!externalRun || externalPreview" data-testid="suite-preview" :disabled="testing.dirty || testing.running || !testing.current" @click="attempt(preview)">{{ t('testing.preview') }}</button><button v-if="!externalRun && testing.running" data-testid="suite-cancel" :disabled="!testing.running" @click="attempt(() => testing.cancel())">{{ t('testing.cancel') }}</button></div>
        </details>
      </div>
      <p v-if="externalRunIssue" role="status">{{ externalRunIssue }}</p>

      <section v-if="onlinePreview" class="form-card" data-testid="suite-online-preview">
        <h3>{{ t('testing.preview') }}</h3><p>{{ t('testAssets.dataset') }} · {{ testing.view?.datasets.find(item => item.id === onlinePreview!.datasetId)?.name ?? t('testing.none') }}</p>
        <table><thead><tr><th>{{ t('testAssets.sequence') }}</th><th>{{ t('testingUi.resolvedCases') }}</th></tr></thead><tbody>
          <tr v-for="(entry,index) in onlinePreview.entries" :key="entry.id"><th>{{ index + 1 }}</th><td>
            <span v-if="entry.workflowId">{{ testing.view?.workflows.find(item => item.id === entry.workflowId)?.name ?? entry.workflowId }}</span>
            <div v-for="item in entry.cases" :key="JSON.stringify(item.locator)" :title="[item.locator.collectionId, ...item.locator.folderIds, item.locator.apiId, item.locator.caseId, item.locator.scope].join(' / ')">{{ caseSummary(item.locator)?.name ?? item.locator.caseId }} · {{ item.locator.scope === 'base' ? t('testWorkbench.baseCase') : item.locator.scope }}<small v-if="caseSummary(item.locator)?.modulePath"> · {{ caseSummary(item.locator)?.modulePath }}</small></div>
          </td></tr></tbody></table>
      </section>
      <div v-if="testing.result || testing.preview" class="result-scroll">
        <button v-if="ai && testing.result && !externalRun" data-testid="ai-analyze-report" :disabled="ai.suggestLoading" @click="analyzeReport">{{ t('ai.analyzeReport') }}</button>
        <div v-if="testing.result"><p>{{ t('run.reportingUnits', { total: testing.result.result.reportingUnits?.total ?? '—', failed: testing.result.result.reportingUnits?.failed ?? '—', diagnostics: testing.result.result.reportingUnits?.entryDiagnostics ?? '—' }) }}</p><details v-for="(row,index) in testing.result.result.cases" :key="JSON.stringify([row.locator,row.scope,row.entryId,row.suiteRow,row.row,row.nodeId,index])"><summary :title="row.entryId">{{ row.apiName }} / {{ row.caseName }} · {{ stateLabel(row.passed ? 'passed' : 'failed') }} · {{ t('run.row') }}={{ row.row === undefined ? '—' : row.row + 1 }}</summary><CaseEvidencePanel :evidence="row.evidence" :disabled="testing.running || testing.transitioning || testing.dirty" :inspect="testing.inspectEvidence" :rerun="testing.rerunEvidence" @locate="emit('locate-evidence', $event)" /></details></div>
        <div v-if="testing.preview" data-testid="suite-preview-result"><p>{{ t('testAssets.dataset') }} · {{ testing.view?.datasets.find(item => item.id === testing.preview!.plan.datasetId)?.name ?? t('testing.none') }}</p><p>{{ t('testing.scale', { entries: testing.preview.plan.entries.length, rows: testing.preview.outerRows, executions: testing.preview.plannedExecutions }) }}</p><div class="table-scroll"><table data-testid="suite-preview-table"><thead><tr><th>#</th><th>{{ t('testingUi.kind') }}</th><th>{{ t('testingUi.executions') }}</th><th>{{ t('testingUi.resolvedCases') }}</th></tr></thead><tbody><tr v-for="(entry,index) in testing.preview.plan.entries" :key="entry.id"><th>{{ index + 1 }}</th><td>{{ entry.kind === 'case' ? t('testingUi.case') : entry.kind === 'workflow' ? t('testingUi.workflow') : entry.kind }}</td><td>{{ testing.preview.entries[index]?.plannedExecutions ?? '—' }}</td><td><p v-if="entry.workflowId"><span :title="entry.workflowId">{{ testing.view?.workflows.find(item => item.id === entry.workflowId)?.name ?? entry.workflowId }}</span></p><div v-for="item in entry.cases" :key="JSON.stringify(item.locator)" :title="[item.locator.collectionId, ...item.locator.folderIds, item.locator.apiId, item.locator.caseId, item.locator.scope].join(' / ')">{{ caseSummary(item.locator)?.name ?? item.locator.caseId }} · {{ item.locator.scope === 'base' ? t('testWorkbench.baseCase') : item.locator.scope }}<small v-if="caseSummary(item.locator)?.modulePath"> · {{ caseSummary(item.locator)?.modulePath }}</small></div></td></tr></tbody></table></div><div v-if="testing.preview.sources.length" class="table-scroll"><table><thead><tr><th>{{ t('testingUi.source') }}</th><th>{{ t('testing.rows') }}</th><th>{{ t('testingUi.notes') }}</th></tr></thead><tbody><tr v-for="(source,index) in testing.preview.sources" :key="index"><td :title="source.label">{{ sourceName(source.label) }}</td><td>{{ source.rowCount }}</td><td>{{ source.legacyEmptyFallback ? t('testing.legacyEmpty') : '—' }}</td></tr></tbody></table></div></div>
        <div v-if="testing.result" data-testid="suite-result"><h4>{{ testing.result.result.collectionName }} · {{ stateLabel(testing.result.result.suite?.verdict) }}</h4><p>{{ t('testing.entryCounts', testing.result.result.suite ?? {}) }}</p><p>{{ t('testing.caseCounts', testing.result.result) }}</p><div class="table-scroll"><table data-testid="suite-result-table"><thead><tr><th>{{ t('caseEvidence.entry') }}</th><th>{{ t('testingUi.outerRow') }}</th><th>{{ t('testingUi.state') }}</th><th>{{ t('testingUi.reason') }}</th></tr></thead><tbody><tr v-for="(entry,index) in testing.result.result.suite?.entries" :key="index"><th :title="entry.entryId">{{ resultEntryName(entry) }}</th><td>{{ entry.suiteRow === undefined ? '—' : entry.suiteRow + 1 }}</td><td>{{ stateLabel(entry.status) }}</td><td><p v-if="entry.error" class="error">{{ entry.error }}</p><p v-if="entry.skipReason">{{ stateLabel(entry.skipReason) }}</p><span v-if="!entry.error && !entry.skipReason">—</span></td></tr></tbody></table></div><p v-for="warning in testing.result.result.warnings" :key="warning">{{ warning }}</p></div>
        <button v-if="record" type="button" data-testid="suite-open-record" @click="emit('open-run-record', record)">{{ launchLabel("inspect") }}</button>
        <template v-for="entry in testing.result?.result.suite?.entries" :key="JSON.stringify([entry.entryId,entry.suiteRow])"><CaseEvidencePanel v-if="entry.status === 'failed' || entry.status === 'aborted'" :evidence="entryEvidence(entry)" :disabled="testing.running || testing.transitioning || testing.dirty" :inspect="testing.inspectEvidence" :rerun="testing.rerunEvidence" @locate="emit('locate-evidence', $event)" /></template>
      </div>
    </template>
  </section>
</template>
<style scoped>

.toolbar{display:flex;align-items:center;gap:10px;flex:none;flex-wrap:wrap;padding-bottom:12px;border-bottom:1px solid var(--border)}.toolbar strong{flex:1;font-size:17px;min-width:90px}.dirty-badge{color:var(--text-muted);background:var(--subtle);border:1px solid var(--border);border-radius:20px;padding:3px 9px;font-size:12px}
.editor-scroll{flex:1;min-height:100px;overflow:auto;display:flex;flex-direction:column;gap:14px;padding:2px}.form-card{flex:none;min-width:0;padding:16px;background:var(--bg);border:1px solid var(--border);border-radius:10px;box-shadow:var(--panel-shadow)}h3{font-size:14px;margin:0 0 14px;color:var(--text)}.form-card>label{margin:10px 0}label{display:flex;gap:10px;align-items:center;font-size:13px;min-width:0}label input:not([type=checkbox]){flex:1;min-width:0}input,textarea,select{background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--control-radius);padding:7px 9px;box-sizing:border-box;font:inherit;max-width:100%}textarea{width:100%;font-family:ui-monospace,monospace;resize:vertical}select[multiple]{min-width:180px}input[type=checkbox]{accent-color:var(--accent);flex:none}button{color:var(--text);background:var(--bg);border:1px solid var(--border);border-radius:var(--control-radius);padding:7px 12px;min-height:32px;cursor:pointer;font:inherit;white-space:nowrap}button:hover:not(:disabled){border-color:var(--accent);background:var(--active-weak)}button.primary{color:var(--accent);background:var(--active-weak);border-color:var(--accent);font-weight:600}button:disabled,input:disabled,select:disabled,textarea:disabled{opacity:.55;cursor:default}summary{cursor:pointer;font-weight:600;padding:8px 0;overflow-wrap:anywhere}details[open]>summary{margin-bottom:10px}.hint{color:var(--text-muted);font-size:12px;line-height:1.6;margin:8px 0}.error{color:var(--fail);overflow-wrap:anywhere;margin:0}.empty-state{color:var(--text-muted);text-align:center;padding:40px 12px}.table-scroll{overflow:auto;max-width:100%;max-height:45vh;flex:none;border:1px solid var(--border);border-radius:8px;margin:10px 0}table{border-collapse:separate;border-spacing:0;min-width:100%;font-size:12px}th,td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--border);vertical-align:top}thead th{position:sticky;top:0;background:var(--subtle);z-index:1;white-space:nowrap;color:var(--text-muted);font-weight:600}tbody tr:last-child>*{border-bottom:0}tbody tr:hover{background:var(--hover)}tbody th{font-weight:500}td{overflow-wrap:anywhere}p{line-height:1.6}
.suite-panel{height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;gap:12px;padding:16px;box-sizing:border-box;background:var(--panel);color:var(--text)}.evidence-setting{flex:none;flex-wrap:wrap}.run-toolbar{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap;padding:10px 0;border-top:1px solid var(--border)}.run-toolbar>label{margin-right:auto}.result-scroll{flex:0 1 45%;min-height:100px;overflow:auto;font-size:12px;border:1px solid var(--border);border-radius:10px;background:var(--bg);padding:12px}.result-scroll>div{margin-bottom:14px}.result-scroll p{margin:6px 0}.result-scroll details{padding:6px 0;border-bottom:1px solid var(--border)}.choices{max-height:180px;overflow:auto;border:1px solid var(--border);border-radius:8px;margin:10px 0;padding:8px}.choices label{padding:6px;overflow-wrap:anywhere}.choices label:hover{background:var(--hover)}.selected-entries{margin:0;padding-left:24px}.selected-entries li{padding:5px 0}.selected-entries li>span{display:inline-block;max-width:calc(100% - 90px);vertical-align:middle;overflow-wrap:anywhere}.selected-entries button{padding:4px 9px;margin-left:6px}td dl{display:grid;grid-template-columns:max-content minmax(180px,1fr);gap:4px 10px;margin:0 0 12px}dt{color:var(--text-muted)}dd{margin:0;overflow-wrap:anywhere}tbody th{max-width:240px;overflow-wrap:anywhere}.result-scroll .table-scroll{max-height:320px}h4{font-size:14px;margin:8px 0;overflow-wrap:anywhere}@media(max-width:650px){.suite-panel{padding:10px}.form-card{padding:12px}.form-card>label:has(input:not([type=checkbox])),.form-card>label:has(select){align-items:stretch;flex-direction:column}.run-toolbar>label{width:100%}.result-scroll{padding:8px}}
[data-testid="suite-preview-table"] td:nth-child(2),[data-testid="suite-result-table"] td:nth-child(3){white-space:nowrap}
</style>
<style scoped src="../styles/testing-assets.css"></style>
<style scoped>
.suite-panel { height:auto; overflow:visible; background:var(--bg); }
.editor-scroll { flex:none; min-height:0; overflow:visible; }
.asset-detail .form-card > label { grid-template-columns: minmax(68px,auto) minmax(0,1fr); }
.asset-detail .form-card > label:has(input[type=checkbox]) { display:flex; flex-direction:row-reverse; justify-content:flex-end; margin:16px 0 3px; }
.asset-detail .section-heading { margin:17px 0 7px; }
.selected-entries { width:100%; border-collapse:collapse; }
.selected-entries th,.selected-entries td { padding:6px 9px; border:1px solid var(--border); text-align:left; }
.selected-entries th { background:var(--subtle); }
.order-controls { width:62px; white-space:nowrap; }
.order-controls button { padding:2px 4px; min-height:20px; font-size:12px; }
.result-scroll { flex:none; }
</style>

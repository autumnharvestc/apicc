<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { SuiteEntry } from "@apicc/core";
import type { TestingStore } from "../stores/testing.js";
import CaseEvidencePanel from "./CaseEvidencePanel.vue";
import type { EvidenceIdentity } from "@apicc/core";
import { reportEntryEvidence } from "@apicc/core/report/units";
const emit = defineEmits<{ (event: "locate-evidence", identity: EvidenceIdentity): void }>();
const props = defineProps<{ testing: TestingStore }>();
const { t } = useI18n(); const allowDraft = ref(false); const error = ref("");
const suite = computed(() => props.testing.suite);
const resourceKey = computed(() => JSON.stringify([props.testing.view?.context.root, props.testing.view?.context.project, suite.value?.id]));
watch(resourceKey, () => { allowDraft.value = false; error.value = ""; });
async function attempt(operation: () => unknown | Promise<unknown>) { const key = resourceKey.value; try { await operation(); if (key === resourceKey.value) error.value = ""; } catch (failure) { if (key === resourceKey.value) error.value = failure instanceof Error ? failure.message : String(failure); } }
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
const label = (entry: SuiteEntry) => entry.kind === "workflow" ? props.testing.view?.workflows.find(item => item.id === entry.workflowId)?.name ?? entry.workflowId : props.testing.view?.cases.find(item => item.locator.apiId === entry.apiId && item.locator.collectionId === entry.collectionId && JSON.stringify(item.locator.folderIds) === JSON.stringify(entry.folderIds) && item.caseId === entry.caseId)?.name ?? entry.caseId;
function entryEvidence(entry: NonNullable<NonNullable<import("@apicc/core").RunResult["suite"]>["entries"]>[number]): import("@apicc/core").SafeExecutionEvidence {
  return reportEntryEvidence(props.testing.result!.result, entry);
}
</script>
<template>
  <section class="suite-panel" data-testid="suite-panel">
    <header class="toolbar"><strong>{{ t('testing.suites') }}</strong><span v-if="testing.dirty">{{ t('testing.unsaved') }}</span><button data-testid="suite-save" :disabled="testing.readOnly || !suite || testing.busy" @click="attempt(() => testing.save())">{{ t('testing.save') }}</button><button :disabled="testing.readOnly || !suite || testing.creating || testing.running" @click="attempt(() => testing.remove())">{{ t('testing.remove') }}</button></header>
    <p v-if="error || testing.error" role="alert" class="error">{{ error || testing.error }}</p>
    <label>证据采集<select v-model="testing.evidenceMode" :disabled="testing.running || testing.transitioning"><option value="none">none（仅定位）</option><option value="failures">failures（失败，默认）</option><option value="all">all（全部）</option></select></label>
    <p v-if="!suite">{{ t('testing.pickSuite') }}</p>
    <template v-else>
      <div class="editor-scroll">
        <label>{{ t('testing.name') }}<input :value="suite.name" :disabled="testing.readOnly" @input="field('name', ($event.target as HTMLInputElement).value)" /></label>
        <label>{{ t('testing.description') }}<input :value="suite.description" :disabled="testing.readOnly" @input="field('description', ($event.target as HTMLInputElement).value)" /></label>
        <label>{{ t('testing.tags') }}<input :value="suite.tags.join(', ')" :disabled="testing.readOnly" @change="field('tags', ($event.target as HTMLInputElement).value.split(',').map(value => value.trim()).filter(Boolean))" /></label>
        <label>{{ t('testing.selection') }}<select :value="suite.selection.kind" :disabled="testing.readOnly" @change="mode(($event.target as HTMLSelectElement).value)"><option value="explicit">{{ t('testing.explicit') }}</option><option value="query">{{ t('testing.query') }}</option></select></label>
        <template v-if="suite.selection.kind === 'explicit'">
          <div class="choices">
            <label v-for="item in testing.view?.cases" :key="JSON.stringify([item.locator,item.caseId])"><input type="checkbox" data-testid="suite-case-choice" :checked="checked({kind:'case', collectionId:item.locator.collectionId, folderIds:item.locator.folderIds, apiId:item.locator.apiId, caseId:item.caseId})" :disabled="testing.readOnly" @change="toggle({kind:'case',collectionId:item.locator.collectionId,folderIds:item.locator.folderIds,apiId:item.locator.apiId,caseId:item.caseId},($event.target as HTMLInputElement).checked)" />{{ item.name }} · {{ item.scopes.join(', ') }}</label>
            <label v-for="item in testing.view?.workflows" :key="item.id"><input type="checkbox" :checked="checked({kind:'workflow',workflowId:item.id})" :disabled="testing.readOnly" @change="toggle({kind:'workflow',workflowId:item.id},($event.target as HTMLInputElement).checked)" />{{ item.name }} · {{ item.status }}</label>
          </div>
          <ol><li v-for="(entry,index) in suite.selection.entries" :key="entry.id">{{ label(entry) }}<button :disabled="testing.readOnly || index === 0" @click="move(index,-1)">↑</button><button :disabled="testing.readOnly || index === suite.selection.entries.length - 1" @click="move(index,1)">↓</button></li></ol>
        </template>
        <template v-else>
          <label>{{ t('testing.collections') }}<select multiple :value="suite.selection.collectionIds" :disabled="testing.readOnly" @change="query('collectionIds',Array.from(($event.target as HTMLSelectElement).selectedOptions).map(item => item.value))"><option v-for="item in testing.view?.collections" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
          <label>{{ t('testing.caseTags') }}<input :value="suite.selection.caseTags?.join(', ')" :disabled="testing.readOnly" @change="query('caseTags',($event.target as HTMLInputElement).value.split(',').map(value=>value.trim()).filter(Boolean))" /></label>
          <p class="hint">{{ t('testing.queryHint') }}</p>
        </template>
        <label>{{ t('testing.environment') }}<select :value="suite.environmentId ?? ''" :disabled="testing.readOnly" @change="optional('environmentId',($event.target as HTMLSelectElement).value)"><option value="">base</option><option v-for="item in testing.view?.environments" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
        <label>{{ t('testing.dataset') }}<select :value="suite.datasetId ?? ''" :disabled="testing.readOnly" @change="optional('datasetId',($event.target as HTMLSelectElement).value)"><option value="">{{ t('testing.none') }}</option><option v-for="item in testing.view?.datasets" :key="item.id" :value="item.id">{{ item.name }} · {{ item.rows.length }} {{ t('testing.rows') }}</option></select></label>
        <label><input type="checkbox" :checked="suite.failFast" :disabled="testing.readOnly" @change="field('failFast',($event.target as HTMLInputElement).checked)" />{{ t('testing.failFast') }}</label>
        <label>{{ t('testing.reporters') }}<select multiple :value="suite.reporters" :disabled="testing.readOnly" @change="field('reporters',Array.from(($event.target as HTMLSelectElement).selectedOptions).map(item=>item.value))"><option>html</option><option>json</option><option>junit</option></select></label>
        <p class="hint">{{ t('testing.suiteIsolation') }}</p>
      </div>
      <div class="run-toolbar"><label><input v-model="allowDraft" type="checkbox" :disabled="testing.running" />{{ t('testing.allowDraft') }}</label><button data-testid="suite-preview" :disabled="testing.dirty || testing.running || !testing.current" @click="attempt(() => testing.previewSuite({allowDraft}))">{{ t('testing.preview') }}</button><button data-testid="suite-run" :disabled="testing.dirty || testing.running || !testing.current" @click="attempt(() => testing.run({allowDraft}))">{{ t('testing.run') }}</button><button data-testid="suite-cancel" :disabled="!testing.running" @click="attempt(() => testing.cancel())">{{ t('testing.cancel') }}</button></div>
      <div class="result-scroll">
        <template v-for="entry in testing.result?.result.suite?.entries" :key="JSON.stringify([entry.entryId,entry.suiteRow])"><CaseEvidencePanel v-if="entry.status === 'failed' || entry.status === 'aborted'" :evidence="entryEvidence(entry)" :disabled="testing.running || testing.transitioning || testing.dirty" :inspect="testing.inspectEvidence" :rerun="testing.rerunEvidence" @locate="emit('locate-evidence', $event)" /></template>
        <div v-if="testing.result"><p>reporting-units {{ testing.result.result.reportingUnits?.total }} · failed {{ testing.result.result.reportingUnits?.failed }}</p><details v-for="(row,index) in testing.result.result.cases" :key="JSON.stringify([row.locator,row.scope,row.entryId,row.suiteRow,row.row,row.nodeId,index])"><summary>{{ row.apiName }} / {{ row.caseName }} · {{ row.passed ? '通过' : '失败' }} · row={{ row.row === undefined ? '—' : row.row + 1 }} · entry={{ row.entryId }}</summary><CaseEvidencePanel :evidence="row.evidence" :disabled="testing.running || testing.transitioning || testing.dirty" :inspect="testing.inspectEvidence" :rerun="testing.rerunEvidence" @locate="emit('locate-evidence', $event)" /></details></div>
        <div v-if="testing.preview" data-testid="suite-preview-result"><p>{{ t('testing.scale', { entries: testing.preview.plan.entries.length, rows: testing.preview.outerRows, executions: testing.preview.plannedExecutions }) }}</p><div v-for="(entry,index) in testing.preview.plan.entries" :key="entry.id">{{ index + 1 }} · {{ entry.kind }} · {{ testing.preview.entries[index]?.plannedExecutions }}<div v-for="item in entry.cases" :key="JSON.stringify(item.locator)">{{ item.locator.apiId }} / {{ item.locator.caseId }} · scope={{ item.locator.scope }} · {{ item.locator.folderIds.join('/') }}</div></div><p v-for="source in testing.preview.sources" :key="source.label">{{ source.label }} · {{ source.rowCount }} {{ t('testing.rows') }}<span v-if="source.legacyEmptyFallback"> · {{ t('testing.legacyEmpty') }}</span></p></div>
        <div v-if="testing.result" data-testid="suite-result"><h4>{{ testing.result.result.collectionName }} · {{ testing.result.result.suite?.verdict }}</h4><p>{{ t('testing.entryCounts', testing.result.result.suite ?? {}) }}</p><p>{{ t('testing.caseCounts', testing.result.result) }}</p><div v-for="(entry,index) in testing.result.result.suite?.entries" :key="index">{{ entry.entryId }} · {{ entry.suiteRow === undefined ? '' : entry.suiteRow + 1 }} · {{ entry.status }}<span v-if="entry.error" class="error"> · {{ entry.error }}</span><span v-if="entry.skipReason"> · {{ entry.skipReason }}</span></div><p v-for="warning in testing.result.result.warnings" :key="warning">{{ warning }}</p></div>
      </div>
    </template>
  </section>
</template>
<style scoped>
.suite-panel{height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;gap:8px;padding:10px;box-sizing:border-box}.toolbar,.run-toolbar{display:flex;align-items:center;gap:8px;flex:none;flex-wrap:wrap}.toolbar strong{flex:1}.editor-scroll{flex:1;min-height:80px;overflow:auto;display:flex;flex-direction:column;gap:8px}.result-scroll{flex:0 1 40%;min-height:0;overflow:auto;border-top:1px solid var(--border);font-size:12px}.choices{max-height:180px;overflow:auto;border:1px solid var(--border);padding:6px}.choices label{display:flex}label{display:flex;gap:6px;align-items:center;font-size:12px}input,select{background:var(--bg);color:var(--text);border:1px solid var(--border);padding:4px}label input:not([type=checkbox]){flex:1}.hint{color:var(--text-muted);margin:0;font-size:12px}.error{color:var(--fail,#cf1322)}button:disabled{opacity:.5}p{margin:4px 0}ol{margin:0;padding-left:24px}
</style>

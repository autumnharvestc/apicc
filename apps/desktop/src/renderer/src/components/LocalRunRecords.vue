<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useWorkbenchPosition } from "../stores/workbenchPosition.js";
import type { EvidenceIdentity, RunResult, StressComparison } from "@apicc/core";
import { reportingUnits, reportEntryEvidence } from "@apicc/core/report/units";
import type { ProjectLocator } from "../../../shared/locations.js";
import type { RunSummary, StressReportDTO } from "../../../shared/types.js";
import type { CollaborationLocalSource } from "../../../shared/online/collaboration.js";
import type { useRunStore } from "../stores/run.js";
import type { useWorkspaceStore } from "../stores/workspace.js";
import type { AiStore } from "../stores/ai.js";
import { caseEvidenceIdentity } from "../ai/evidenceNavigation.js";
import { shortRecordId, workflowFailure } from "../execution/recordFacts.js";
import { recordTime, useRecordMessages } from "../execution/recordMessages.js";
import CaseEvidencePanel from "./CaseEvidencePanel.vue";
import RunSummaryView from "./RunSummaryView.vue";
import StressReportView from "./StressReportView.vue";

const props = defineProps<{ run: ReturnType<typeof useRunStore>; workspace: ReturnType<typeof useWorkspaceStore>;
  project: ProjectLocator; file?: string | null; ai?: AiStore; reportError: (e: unknown) => void }>();
const emit = defineEmits<{ opened: []; launch: []; collaboration: [source: CollaborationLocalSource]; "locate-evidence": [identity: EvidenceIdentity] }>();
const { t, te, locale } = useI18n();
const msg = useRecordMessages();
const duration = (value: number) => value.toLocaleString(locale.value, { maximumFractionDigits: 2 });
const source = computed(() => ({ kind: "local" as const, project: props.project }));
const context = computed(() => JSON.stringify([props.workspace.root, props.project.workspaceId, props.project.groupId, props.project.projectId]));
const position = useWorkbenchPosition(() => context.value);
const rows = shallowRef<RunSummary[]>([]), selected = shallowRef<RunSummary | null>(null);
const report = shallowRef<RunResult | StressReportDTO | null>(null);
const runReport = computed(() => report.value?.kind === "stress" ? null : report.value);
const stress = computed(() => report.value?.kind === "stress" ? report.value.report : null);
const selectedFile = ref(""), baseline = ref(""), comparison = shallowRef<StressComparison | null>(null);
const rerunTarget = shallowRef<EvidenceIdentity | null>(null), issue = ref(""), loading = ref(false);
const legacyOpen = ref(false), list = ref<HTMLElement>(), showReport = ref(false);
watch(selectedFile, () => { showReport.value = false; });
let listGeneration = 0, detailGeneration = 0;
onBeforeUnmount(() => { listGeneration++; detailGeneration++; });
const knownScopes = computed(() => props.workspace.tree?.children.flatMap(group => group.children ?? []).filter(node => node.kind === "project").map(node => node.locator) ?? []);
function ownership(row: RunSummary) {
  const scope = row.archiveProject;
  if (scope) return scope.workspaceId === props.project.workspaceId && scope.groupId === props.project.groupId && scope.projectId === props.project.projectId ? "current" : "other";
  if (!row.projectId || knownScopes.value.filter(item => item.projectId === row.projectId).length !== 1) return "legacy";
  return row.projectId === props.project.projectId ? "current" : "other";
}
const current = computed(() => rows.value.filter(row => ownership(row) === "current"));
const legacy = computed(() => rows.value.filter(row => ownership(row) === "legacy"));
const trusted = computed(() => !!selected.value?.archiveProject && ownership(selected.value) === "current");
function label(code?: string) {
  if (!code) return msg("notRecorded");
  for (const ns of ["executionLabels","onlineExecution.states","stress.workbench.verdict","stressFinal.codes"]) if (te(ns + "." + code)) return t(ns + "." + code);
  return code;
}
const kind = (row: RunSummary) => t(row.kind === "collection" ? "run.kindCollection" : row.kind === "stress" ? "run.kindStress" : "onlineExecution.states." + row.kind);
const title = (row: RunSummary) => row.kind === "stress" ? row.target?.kind === "case" ? row.target.caseId : row.target?.workflowId ?? kind(row) : row.collectionName;
const verdictCode = (row: RunSummary) => row.kind === "stress" ? row.verdict : row.logicalVerdict ?? ((row.reportingUnits?.failed ?? row.failed) ? "failed" : "passed");
const verdict = (row: RunSummary) => label(verdictCode(row));
const facts = computed(() => {
  const r = runReport.value, s = stress.value;
  const id = r?.suite?.environmentId ?? r?.executionIdentity?.environmentId ?? (s && 'formatVersion' in s && s.formatVersion === 2 ? s.environmentId : undefined);
  const hasBaseEvidence = s && 'formatVersion' in s && s.formatVersion === 2 && s.environmentId === null || !!(r?.executionIdentity || r?.suite);
  const project = props.workspace.tree?.children.flatMap(group => group.children ?? []).find(node => node.kind === "project"
    && node.locator.workspaceId === props.project.workspaceId && node.locator.groupId === props.project.groupId && node.locator.projectId === props.project.projectId);
  const currentName = id && project?.kind === "project" && trusted.value && project.envs?.find(env => env.id === id)?.name;
  const failedNode = r?.workflow?.entries.find(v => v.error);
  return { environment: r?.envName || (currentName ? t("runRecords.currentName",{name:currentName}) : id ? t("runRecords.environmentId",{id:shortRecordId(id)}) : hasBaseEvidence ? t("run.envNone") : msg("notRecorded")),
    id, rawReason: failedNode?.error,
    reason: r?.cases.flatMap(v => v.assertions ?? []).find(a => !a.pass)?.message ?? workflowFailure(failedNode,t("runRecords.workflowAssertion"))
      ?? r?.cases.find(v => v.error)?.error ?? r?.suite?.entries?.find(v => v.error)?.error };
});
function closeDetail() { detailGeneration++; selected.value = null; report.value = null; issue.value = ""; rerunTarget.value = null; }
async function open(row: RunSummary) {
  const token = ++detailGeneration;
  position.value.localRecord = { file: row.file, digest: row.archiveDigest, legacy: ownership(row) === "legacy" };
  selected.value = row; selectedFile.value = row.file; report.value = null; issue.value = ""; rerunTarget.value = null;
  try {
    const proof = row.archiveProject ? { scope: { ...props.project }, digest: row.archiveDigest } : undefined;
    const value = proof ? await props.run.readArchive(row.file, proof) : await props.run.readArchive(row.file);
    if (token !== detailGeneration) return;
    if (!value) throw new Error(proof ? msg("unavailable") : t("run.fileMissing"));
    const owner = value.kind === "stress" ? value.report.projectId : value.projectId ?? value.suite?.projectId;
    if (ownership(row) === "other" || (row.projectId && owner !== row.projectId)) throw new Error(msg("unavailable"));
    report.value = value;
  } catch (e) { if (token === detailGeneration) issue.value = e instanceof Error ? e.message : String(e); }
}
async function refresh(file?: string | null) {
  const token = ++listGeneration;
  loading.value = true; issue.value = "";
  try {
    const values = await props.run.readArchiveList();
    if (token !== listGeneration) return;
    rows.value = values;
    await nextTick(); if (token !== listGeneration) return;
    if (list.value) list.value.scrollTop = position.value.recordScrollTop;
    const restore = !file && position.value.localRecord;
    if (file || restore) {
      const row = file ? current.value.find(item => item.file === file)
        : (restore && restore.digest && (restore.legacy ? legacy.value : current.value).find(item => item.file === restore.file && item.archiveDigest === restore.digest));
      if (row) { await open(row); if (file && token === listGeneration) emit("opened"); }
      else { position.value.localRecord = null; closeDetail(); issue.value = msg("unavailable"); }
    } else if (selected.value && !values.some(item => item.file === selected.value!.file && ownership(item) === ownership(selected.value!))) closeDetail();
  } catch (e) { if (token === listGeneration) issue.value = e instanceof Error ? e.message : String(e); }
  finally { if (token === listGeneration) loading.value = false; }
}
watch([context, () => props.file], ([key, file], previous) => {
  if (previous?.[0] !== key) { closeDetail(); selectedFile.value = ""; rows.value = []; legacyOpen.value = false; baseline.value = ""; }
  if (file || previous?.[0] !== key) void refresh(file);
}, { immediate: true });
watch([baseline, stress, context], async (_, __, cleanup) => {
  comparison.value = null; let live = true; cleanup(() => { live = false; });
  if (!baseline.value || !stress.value || !selected.value || !trusted.value) return;
  try { const result = await props.run.compareArchivedStress({ ...props.project }, baseline.value, selected.value.file); if (live) comparison.value = result; }
  catch (e) { if (live) props.reportError(e); }
});
const metric = (key: string, value: number | null) => value === null ? t("stress.workbench.notComputable") : key === "errorRate" ? (value*100).toFixed(2)+"%" : key.endsWith("Ms") ? value.toFixed(2)+" ms" : key === "rps" ? value.toFixed(2)+" "+t("stressPresentation.rpsUnit") : String(value);
const inspect = (identity: EvidenceIdentity) => props.run.inspectEvidence(identity, { root: props.workspace.root, project: { ...props.project } });
const askRerun = async (identity: EvidenceIdentity) => { rerunTarget.value = identity; };
async function rerun() {
  const identity = rerunTarget.value; if (!identity || !trusted.value || props.workspace.readOnly) return;
  rerunTarget.value = null; const token = detailGeneration;
  try { await props.run.rerunEvidence(identity, { root: props.workspace.root, project: { ...props.project } }); if (token === detailGeneration) await refresh(); }
  catch (e) { if (token === detailGeneration) props.reportError(e); }
}
function analyze() {
  const displayed = runReport.value, row = selected.value, key = context.value;
  if (!trusted.value || !displayed || !row || !props.ai) return;
  void props.ai.prepareReportAnalysis({ source: source.value, report: { kind: "run", file: row.file }, displayed,
    isCurrent: () => context.value === key && runReport.value === displayed,
    canLocateEvidence: (e, allowed) => !!caseEvidenceIdentity(e, allowed, displayed.cases),
    locateEvidence: (e, allowed) => { const id = caseEvidenceIdentity(e, allowed, displayed.cases); if (id) emit("locate-evidence", id); } });
}
async function exportStress() { if (selected.value && trusted.value) try { await props.run.exportArchivedStress({ ...props.project }, selected.value.file, baseline.value || undefined); } catch (e) { props.reportError(e); } }
</script>
<template>
  <section class="records-layout" data-testid="local-run-records">
    <aside ref="list" class="record-list" @scroll="position.recordScrollTop = ($event.currentTarget as HTMLElement).scrollTop">
      <header class="record-heading"><h2>{{ t("runRecords.localHistory") }}</h2><button :aria-label="msg('refresh')" :title="msg('refresh')" @click="refresh()" :disabled="loading">{{ t("runRecords.refresh") }}</button></header>
      <template v-if="!loading && !current.length"><p>{{ msg("noRecords") }}</p><button @click="emit('launch')">{{ msg("launch") }}</button></template>
      <table v-if="current.length" class="record-table"><thead><tr><th>{{ t('onlineExecution.task') }}</th><th>{{ t('runRecords.time') }} · UTC</th><th>{{ t('runRecords.status') }}</th><th>{{ t('runRecords.conclusion') }}</th></tr></thead>
        <tbody><tr v-for="row in current" :key="row.file" class="record-row" :data-file="row.file" :aria-current="selectedFile === row.file" @click="open(row)">
          <th scope="row"><button class="record-link" :title="title(row)" @click.stop="open(row)">{{ title(row) }}</button></th>
          <td :title="recordTime(row.startedAt,locale)">{{ recordTime(row.startedAt,locale,true) ?? msg("notRecorded") }}</td>
          <td>{{ label('ended') }}</td><td><span class="verdict" :data-verdict="verdictCode(row)">{{ verdict(row) }}</span></td>
        </tr></tbody></table>
      <details v-if="legacy.length" :open="legacyOpen" @toggle="legacyOpen = ($event.target as HTMLDetailsElement).open">
        <summary>{{ msg("legacy") }} ({{ legacy.length }})</summary>
        <button v-for="row in legacy" :key="row.file" class="record-row" :data-file="row.file" :aria-current="selectedFile === row.file" @click="open(row)"><strong>{{ title(row) }}</strong><small>{{ row.file }}</small><small>{{ recordTime(row.startedAt,locale) }}</small></button>
      </details>
    </aside>
    <article class="record-detail">
      <p v-if="issue" role="alert">{{ issue }}</p><p v-if="!selected">{{ msg("pick") }}</p>
      <template v-if="selected">
        <header class="record-heading"><h2>{{ title(selected) }}</h2><span class="verdict" :data-verdict="verdictCode(selected)">{{ verdict(selected) }}</span>
          <button class="record-back" @click="position.localRecord = null; closeDetail()">{{ msg("back") }}</button></header>
        <p v-if="ownership(selected) === 'legacy'">{{ msg("legacyHint") }}</p><p v-if="facts.reason" class="record-failure" role="alert">{{ facts.reason }}</p>
        <dl class="record-facts"><div><dt>{{ t("runRecords.actualEnvironment") }}</dt><dd :title="facts.id ?? undefined">{{ facts.environment }}</dd></div>
          <div><dt>{{ msg("position") }}</dt><dd>{{ selected.archiveProject ? t("onlineExecution.local") : msg("notRecorded") }}</dd></div>
          <div><dt>{{ t("onlineExecution.state") }}</dt><dd>{{ label("ended") }}</dd></div>
          <div><dt>{{ t("onlineExecution.archive") }}</dt><dd>{{ report ? label("archived") : msg("notRecorded") }}</dd></div>
        </dl>
        <details><summary>{{ msg("technical") }}</summary><p>{{ selected.file }}</p><p v-if="facts.rawReason">{{ facts.rawReason }}</p><p>{{ t('onlineExecution.startedAt') }} · {{ recordTime(selected.startedAt,locale) }}</p></details>
        <header v-if="report" class="record-heading report-heading"><h3>{{ t('runRecords.caseResults') }}</h3>
          <button class="record-back" :aria-expanded="showReport" @click="showReport = !showReport">{{ t('runRecords.openReport') }}</button></header>
        <div v-show="showReport">
        <div v-if="report && trusted" class="record-actions">
          <button @click="emit('collaboration', {kind: stress ? 'stress' : 'run', file:selected.file, project:{...project}})">{{ t("collaboration.publishToProject") }}</button>
          <button v-if="ai && runReport" :disabled="ai.suggestLoading" @click="analyze">{{ t("ai.analyzeReport") }}</button>
          <template v-if="stress"><button @click="baseline=selected.file">{{ t("stressPresentation.pin") }}</button><button v-if="baseline" @click="baseline=''">{{ t("stressPresentation.clear") }}</button><button @click="exportStress">{{ t("stressPresentation.export") }}</button></template>
        </div>
        <StressReportView v-if="stress" :report="stress" :ai="trusted ? ai : undefined" :source="source" :report-ref="{kind:'stress',file:selected.file}" :baseline-ref="baseline ? {kind:'stress',file:baseline} : undefined" />
        <section v-if="stress && comparison"><h4>{{ t("stress.workbench.comparison") }}</h4><p>{{ t("stress.workbench.baseline") }} · {{ baseline }}</p><p v-if="!comparison.directlyComparable">{{ t("stress.workbench.notComparable") }}</p><p v-for="code in [...comparison.mismatches,...comparison.notices]" :key="code">{{ code==='environment-definition-not-compared' ? t('stressPresentation.environmentNotice') : te('stressPresentation.coreReasons.'+code) ? t('stressPresentation.coreReasons.'+code) : code }}</p><dl><div v-for="(v,k) in comparison.metrics" :key="k"><dt>{{ t("stressPresentation.metrics."+k) }}</dt><dd>{{ metric(k,v.base) }} → {{ metric(k,v.candidate) }}</dd></div></dl></section>
        <template v-if="runReport">
          <RunSummaryView :result="runReport" />
          <details v-if="runReport.trace"><summary>{{ msg("trace") }}</summary><ol><li v-for="(event,i) in runReport.trace.events" :key="i">{{ label(event.type) }} · {{ event.nodeId }} · {{ label(event.state) }} {{ event.message }}</li></ol><p v-if="runReport.trace.truncated">{{ t('wf.control.truncated',{shown:runReport.trace.events.length,total:runReport.trace.totalEvents}) }}</p></details>
          <CaseEvidencePanel v-for="entry in reportingUnits(runReport).diagnostics" :key="JSON.stringify([entry.entryId,entry.suiteRow])" :evidence="reportEntryEvidence(runReport,entry)" :inspect="trusted ? inspect : undefined" :rerun="trusted && !workspace.readOnly ? askRerun : undefined" :disabled="run.running" @locate="emit('locate-evidence',$event)" />
          <details v-for="(row,index) in runReport.cases" :key="index"><summary>{{ row.apiName }} / {{ row.caseName }} · {{ label(row.skipped ? "skipped" : row.passed ? "passed" : "failed") }} · {{ duration(row.durationMs) }} ms</summary><p v-if="row.error || row.skipReason">{{ row.error ?? row.skipReason }}</p><p v-for="(a,i) in row.assertions" :key="i">{{ a.message }}</p>
            <CaseEvidencePanel :evidence="row.evidence" :inspect="trusted ? inspect : undefined" :rerun="trusted && !workspace.readOnly ? askRerun : undefined" :disabled="run.running" @locate="emit('locate-evidence',$event)" />
          </details>
          <div v-if="rerunTarget" class="record-actions"><span>{{ msg("confirmRerun") }}</span><button @click="rerun">{{ msg("rerun") }}</button><button @click="rerunTarget=null">{{ msg("cancel") }}</button></div>
        </template>
        </div>
      </template>
    </article>
  </section>
</template>
<style scoped src="../styles/run-records.css"></style>

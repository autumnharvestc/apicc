<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button as AButton, Table as ATable, Tag as ATag } from "ant-design-vue";
import type { CaseOutcome } from "@apicc/core";
import type { CollectionLocator, ProjectLocator } from "../../../shared/locations.js";
import type { LocalLaunchProps } from "../execution/localLaunch.js";
import { useLaunchMessages } from "../execution/launchMessages.js";
import { projectSessionKey } from "../stores/localIdentity.js";
import { useWorkbenchPosition } from "../stores/workbenchPosition.js";
import LocalRunLaunch from "./LocalRunLaunch.vue";
import LocalRunRecords from "./LocalRunRecords.vue";
import EmptyState from "./EmptyState.vue";
import CaseEvidencePanel from "./CaseEvidencePanel.vue";
import RunSummaryView from "./RunSummaryView.vue";
import type { EvidenceIdentity } from "@apicc/core";
import { reportingUnits, reportEntryEvidence } from "@apicc/core/report/units";
import type { AiStore } from '../stores/ai.js';
import { caseEvidenceIdentity } from '../ai/evidenceNavigation.js';
import { aiReportDigest } from '../../../shared/ai/reportDigest.js';
const emit = defineEmits<{ (event: "open-debug-record", id: string): void; (event: "locate-evidence", identity: EvidenceIdentity): void; (event: 'collaboration', source: import('../../../shared/online/collaboration.js').CollaborationLocalSource): void }>();

const props = defineProps<LocalLaunchProps & { ai?: AiStore }>();
const { t } = useI18n();
const label = useLaunchMessages();
const projectKey = computed(() => props.projectLocator ? projectSessionKey(props.workspace.root, props.projectLocator) : "");
const position = useWorkbenchPosition(() => projectKey.value);
const pane = computed({ get: () => position.value.runPane, set: value => { position.value.runPane = value; } });
const file = ref("");
const previewModule = ref<string | null>("");
const matchingResultEnvironment = computed(() => (props.run.resultEnvironmentId ?? null) === props.environmentId);
const selectedCollectionLocator = computed(() => props.run.target && projectSessionKey(props.run.targetRoot ?? "", props.run.target) === projectKey.value ? props.run.target : null);
const collectionValue = (locator: CollectionLocator | null) => locator ? JSON.stringify(locator) : "";
function projectOfCollection(locator: CollectionLocator): ProjectLocator {
  return { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId };
}
watch(projectKey, () => {
  file.value = "";
  if (!selectedCollectionLocator.value) {
    const where = props.selectedCollectionLocator;
    void props.run.setTarget(props.workspace.root, where && projectSessionKey(props.workspace.root, where) === projectKey.value ? where : null);
  }
}, { immediate: true });
async function shareReport() {
  const selected = selectedCollectionLocator.value, displayed = props.run.result;
  if (!selected || !displayed) return;
  const expectedReportDigest = await aiReportDigest(displayed);
  if (displayed === props.run.result && selected === selectedCollectionLocator.value) emit("collaboration", { kind: "current", project: projectOfCollection(selected), expectedReportDigest });
}
function openRecord(target: string) { file.value = target; pane.value = "records"; }
defineExpose({ openRecord });

// —— 结果表 ——
const columns = computed(() => [
  { key: "apiName", title: t("run.api"), dataIndex: "apiName" },
  { key: "caseName", title: t("run.case"), dataIndex: "caseName" },
  { key: "row", title: t("run.row"), dataIndex: "row" },
  { key: "passed", title: t("run.result"), dataIndex: "passed" },
  { key: "durationMs", title: t("run.duration"), dataIndex: "durationMs" },
  ...(props.ai ? [{ key: 'observation', title: t('ai.basis') }] : []),
]);

type OutcomeState = "passed" | "failed" | "skipped";
function outcomeState(record: Record<string, any>): OutcomeState {
  if (record.skipped) return "skipped";
  return record.passed ? "passed" : "failed";
}

// CaseOutcome 无独立 id：apiId+caseId+数据行号合成稳定 rowKey（EnvPanel row-key 告警教训）。
function rowKey(record: CaseOutcome): string {
  return JSON.stringify([record.locator, record.apiId, record.caseId, record.scope, record.entryId, record.suiteRow, record.row, record.nodeId, record.invocationId, record.invocationPath, record.nodeVisitId, record.attempt]);
}

function formatMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}
function analyzeReport() {
  const displayed = props.run.result, locator = selectedCollectionLocator.value, root = props.workspace.root;
  if (!displayed || !locator || !props.ai) return;
  const key = collectionValue(locator);
  void props.ai.prepareReportAnalysis({ source: { kind: 'local', project: projectOfCollection(locator) }, displayed,
    isCurrent: () => props.run.result === displayed && props.workspace.root === root && collectionValue(selectedCollectionLocator.value) === key,
    canLocateEvidence: (evidence, authorised) => !!caseEvidenceIdentity(evidence, authorised, displayed.cases),
    locateEvidence: (evidence, authorised) => {
      const identity = caseEvidenceIdentity(evidence, authorised, displayed.cases);
      if (identity) emit('locate-evidence', identity);
    } });
}
const observationLocator = (record: Record<string, any>) => {
  const proof: CaseOutcome['locator'] = record.locator ?? record.evidence?.identity.locator;
  return proof && ['collectionId', 'apiId', 'caseId', 'scope'].every(key => typeof proof[key as keyof typeof proof] === 'string') && Array.isArray(proof.folderIds) ? proof : undefined;
};
async function selectObservation(record: Record<string, any>) {
  const displayed = props.run.result!, collection = selectedCollectionLocator.value!, root = props.workspace.root;
  const proof = observationLocator(record)!;
  const expectedReportDigest = await aiReportDigest(displayed);
  props.ai!.selectAssertionObservation({ target: { ...projectOfCollection(collection), ...proof, folderIds: [...proof.folderIds] },
    basis: { kind: 'observation', report: { kind: 'current', expectedReportDigest }, caseIndex: displayed.cases.indexOf(record as CaseOutcome) },
    isCurrent: () => props.run.result === displayed && props.workspace.root === root });
}
</script>

<template>
  <section class="run-view" data-testid="run-view">
    <EmptyState v-if="!workspace.tree || !props.projectLocator" :text="t('run.empty')" />
    <template v-else>
      <h1 class="run-heading">{{ t("nav.run") }}</h1>
      <nav class="run-tabs" :aria-label="t('nav.run')">
        <button type="button" :aria-current="pane === 'launch' ? 'page' : undefined" data-testid="run-launch-tab" @click="pane = 'launch'">{{ label('launch') }}</button>
        <button type="button" :aria-current="pane === 'records' ? 'page' : undefined" data-testid="runs-history-btn" @click="pane = 'records'">{{ label('records') }}</button>
      </nav>
      <LocalRunLaunch v-show="pane === 'launch'" v-bind="props" @records="openRecord" @open-debug-record="id => emit('open-debug-record', id)"
        @selection="(kind, id) => { previewModule = kind === 'module' ? id : null; }" />
      <LocalRunRecords v-if="pane === 'records' && props.projectLocator" :run="run" :workspace="workspace" :project="props.projectLocator"  :file="file" @opened="file = ''"
        :ai="ai" :report-error="reportError" @launch="pane = 'launch'" @locate-evidence="emit('locate-evidence', $event)" @collaboration="emit('collaboration', $event)" />
      <template v-if="pane === 'launch' && matchingResultEnvironment && selectedCollectionLocator && previewModule !== null && (!previewModule || previewModule === selectedCollectionLocator.collectionId)">
      <div v-if="run.result" class="summary" data-testid="run-summary">
        <a-button v-if="ai && selectedCollectionLocator" data-testid="ai-analyze-report" :disabled="ai.suggestLoading" @click="analyzeReport">{{ t('ai.analyzeReport') }}</a-button>
        <a-button v-if="selectedCollectionLocator" data-testid="collaboration-publish-current" @click="shareReport">{{ t('collaboration.publishToProject') }}</a-button>
        <RunSummaryView :result="run.result" />
        <CaseEvidencePanel v-for="entry in reportingUnits(run.result).diagnostics" :key="JSON.stringify([entry.entryId,entry.suiteRow])" :evidence="reportEntryEvidence(run.result, entry)" :disabled="run.running" :inspect="run.inspectEvidence" :rerun="run.rerunEvidence" @locate="emit('locate-evidence', $event)" />
      </div>
      <a-table
        v-if="run.result"
        :data-source="run.result.cases"
        :columns="columns"
        :row-key="rowKey"
        :pagination="false"
        :scroll="{ x: 680 }"
        size="small"
        data-testid="run-table"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'row'">{{ record.row === undefined ? "—" : record.row + 1 }}</template>
          <template v-else-if="column.key === 'passed'">
            <a-tag
              :color="outcomeState(record) === 'passed' ? 'success' : outcomeState(record) === 'skipped' ? 'default' : 'error'"
              :data-passed="String(record.passed)"
              :data-state="outcomeState(record)"
              data-testid="run-outcome"
            >
              {{ outcomeState(record) === "skipped" ? t("wf.nodeState.skipped") : record.passed ? t("response.passed") : t("response.failed") }}
              <span v-if="record.skipReason">（{{ record.skipReason }}）</span>
              <span v-else-if="record.failureKind">（{{ record.failureKind }}）</span>
            </a-tag>
          </template>
          <template v-else-if="column.key === 'durationMs'">{{ formatMs(record.durationMs) }}</template>
          <template v-else-if="column.key === 'observation'">
            <button type="button" data-testid="ai-select-observation" :disabled="!observationLocator(record)" @click="selectObservation(record)">{{ t('ai.selectObservation') }}</button>
            <span v-if="!observationLocator(record)">{{ t('ai.observationLocatorMissing') }}</span>
          </template>
        </template>
        <template #expandedRowRender="{ record }">
          <div class="case-detail" data-testid="run-detail">
            <CaseEvidencePanel :evidence="record.evidence" :disabled="run.running" :inspect="run.inspectEvidence" :rerun="run.rerunEvidence" @locate="emit('locate-evidence', $event)" />
            <div v-if="record.skipReason" class="detail-skip">{{ record.skipReason }}</div>
            <div v-if="record.failureKind" class="detail-failure-kind">{{ record.failureKind }}</div>
            <div v-if="record.error" class="detail-error">{{ record.error }}</div>
            <div
              v-for="(a, i) in record.assertions"
              :key="i"
              class="detail-assert"
              :class="{ fail: !a.pass }"
            >
              {{ a.message }}
            </div>
          </div>
        </template>
      </a-table>
      </template>
    </template>
  </section>
</template>

<style scoped>
.run-view {
  padding: 16px;
  min-width: 0;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.run-heading { font-size: 20px; margin: 0; }
.run-tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--border); }
.run-tabs button { border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--text-muted); padding: 6px 12px; cursor: pointer; font: inherit; }
.run-tabs button[aria-current] { color: var(--accent); border-bottom-color: currentColor; }
.summary {
  color: var(--text);
}
.summary > .ant-btn { margin: 0 8px 12px 0; }
.case-detail { min-width: 0; }
.run-view :deep(.ant-table-cell) { overflow-wrap: anywhere; }
.run-view :deep(th.ant-table-cell) { white-space: nowrap; }
.detail-error {
  color: var(--fail);
  margin-bottom: 4px;
}
.detail-assert.fail {
  color: var(--fail);
}
</style>

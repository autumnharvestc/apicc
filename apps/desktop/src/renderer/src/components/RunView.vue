<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button as AButton, Select as ASelect, Table as ATable, Tag as ATag } from "ant-design-vue";
import type { CaseOutcome } from "@apicc/core";
import type { CollectionLocator, ProjectLocator } from "../../../shared/locations.js";
import type { useRunStore } from "../stores/run.js";
import type { useWorkspaceStore } from "../stores/workspace.js";
import EmptyState from "./EmptyState.vue";
import RunsHistory from "./RunsHistory.vue";
import CaseEvidencePanel from "./CaseEvidencePanel.vue";
import type { EvidenceIdentity } from "@apicc/core";
import { reportingUnits, reportEntryEvidence } from "@apicc/core/report/units";
const emit = defineEmits<{ (event: "locate-evidence", identity: EvidenceIdentity): void }>();

/**
 * 运行视图（任务 6）：集合/环境 a-select（集合选项来自树 DTO；环境选项 = 选中集合
 * 所属项目的 envs，按环境名引用——runCollection 入参与 DebugInput 同语义）+「运行」
 * 按钮（loading=running）+ 结果 a-table（接口/用例/数据行/结果 Tag/耗时，断言与错误
 * 经行展开查看）+ 汇总文本 + 运行历史抽屉（RunsHistory）。
 * store 经 props 注入（组合根一次装配；组件内部禁止重复调用工厂）；selectedCollectionId
 * 由组合根随树选中集合下发（仅作默认值，选择仍在组件内），链路拒绝统一转报
 * 组合根错误通道（reportError）。
 */
const props = defineProps<{
  run: ReturnType<typeof useRunStore>;
  workspace: ReturnType<typeof useWorkspaceStore>;
  selectedCollectionLocator: CollectionLocator | null;
  reportError: (e: unknown) => void;
}>();
const { t } = useI18n();

// —— 集合/环境选项（均派生自树 DTO） ——
function projectLocator(locator: CollectionLocator): ProjectLocator {
  return { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId };
}

const collectionEntries = computed(() => {
  const result: Array<{ label: string; locator: CollectionLocator }> = [];
  for (const group of props.workspace.tree?.children ?? []) if (group.kind === "group") for (const project of group.children ?? []) {
    if (project.kind !== "project") continue;
    for (const collection of project.children ?? []) if (collection.kind === "collection") {
      result.push({ label: collection.label, locator: { ...collection.locator } });
    }
  }
  return result;
});
const collectionValue = (locator: CollectionLocator | null) => locator ? JSON.stringify(locator) : "";
const collectionOptions = computed(() => collectionEntries.value.map((entry) => ({ label: entry.label, value: collectionValue(entry.locator) })));
const selectedCollectionLocator = ref<CollectionLocator | null>(props.selectedCollectionLocator ? { ...props.selectedCollectionLocator } : null);
watch(() => props.selectedCollectionLocator, (locator) => { selectedCollectionLocator.value = locator ? { ...locator } : null; }, { deep: true });
watch([() => props.workspace.root, selectedCollectionLocator], ([root, locator]) => props.run.setTarget(root || null, locator), { immediate: true, deep: true });

/** Resolve environments from the exact selected collection's project, not the first matching id. */
const projectOfSelected = computed(() => selectedCollectionLocator.value ? props.workspace.findProject(projectLocator(selectedCollectionLocator.value)) : null);

// 环境按名称引用（run:collection 入参 envName），首项「无环境」= 不传 envName。
const selectedEnv = ref("");
// 环境列表随选中集合所属项目而变：项目切换后原选中环境名在新项目中不存在（残留失效值
// 会被主进程「未找到环境」显式拒绝），故 projectOfSelected 变化即重置回「无环境」；
// 同项目内切换集合不触发（computed 引用未变），环境列表不变可保留选中。
watch(() => selectedCollectionLocator.value ? JSON.stringify(projectLocator(selectedCollectionLocator.value)) : null, () => {
  selectedEnv.value = "";
});
const envOptions = computed(() => [
  { label: t("run.envNone"), value: "" },
  ...(projectOfSelected.value?.envs ?? []).map((e) => ({ label: e.name, value: e.name })),
]);

// —— 运行 ——
async function onRun() {
  const locator = selectedCollectionLocator.value;
  if (!locator) return;
  try {
    await props.run.runCollection(props.workspace.root, locator, selectedEnv.value || undefined);
  } catch (e) {
    props.reportError(e);
  }
}

// —— 结果表 ——
const columns = computed(() => [
  { key: "apiName", title: t("run.api"), dataIndex: "apiName" },
  { key: "caseName", title: t("run.case"), dataIndex: "caseName" },
  { key: "row", title: t("run.row"), dataIndex: "row" },
  { key: "passed", title: t("run.result"), dataIndex: "passed" },
  { key: "durationMs", title: t("run.duration"), dataIndex: "durationMs" },
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
</script>

<template>
  <section class="run-view" data-testid="run-view">
    <EmptyState v-if="!workspace.tree" :text="t('run.empty')" />
    <template v-else>
      <div class="toolbar">
        <a-select
          class="collection-select"
          :value="collectionValue(selectedCollectionLocator) || undefined"
          :options="collectionOptions"
          :placeholder="t('run.collectionPlaceholder')"
          data-testid="run-collection-select"
          @update:value="(value) => (selectedCollectionLocator = collectionEntries.find((entry) => collectionValue(entry.locator) === value)?.locator ?? null)"
        />
        <a-select
          class="env-select"
          v-model:value="selectedEnv"
          :options="envOptions"
          :placeholder="t('run.envPlaceholder')"
          data-testid="run-env-select"
        />
        <a-button type="primary" :loading="run.running" :disabled="!selectedCollectionLocator" data-testid="run-btn" @click="onRun">
          {{ t("run.runBtn") }}
        </a-button>
        <a-button data-testid="runs-history-btn" @click="run.historyOpen = true">{{ t("run.history") }}</a-button>
      </div>
      <div v-if="run.result" class="summary" data-testid="run-summary">
        <p v-if="run.result.reportingMode" data-testid="run-logical-summary">{{ t('wf.control.mode') }}: {{ run.result.reportingMode }} · {{ t('wf.control.logicalVerdict') }}: {{ run.result.suite?.verdict ?? run.result.workflowUnits?.[0]?.verdict ?? '—' }} · {{ t('wf.control.logicalUnits') }}: {{ reportingUnits(run.result).summary.total }} · {{ t('wf.control.rawRows') }}: {{ run.result.total }} · {{ t('wf.control.rawFailed') }}: {{ run.result.failed }}</p>
        <span v-else>{{ t("run.summary", { total: run.result.total, passed: run.result.passed, failed: run.result.failed, skipped: run.result.skipped ?? 0 }) }}</span>
        <p v-if="run.result.suite">条目 {{ run.result.suite.total }} · 失败 {{ run.result.suite.failed }} · 跳过 {{ run.result.suite.skipped }} · {{ run.result.suite.verdict }}</p>
        <p v-if="run.result.reportingUnits">reporting-units {{ run.result.reportingUnits.total }} · failed {{ run.result.reportingUnits.failed }}</p>
        <details v-if="run.result.workflow"><summary>工作流节点统计及状态</summary><pre>{{ JSON.stringify(run.result.workflow, null, 2) }}</pre></details>
        <p v-for="entry in run.result.suite?.entries" :key="JSON.stringify([entry.entryId,entry.suiteRow])">{{ entry.entryId }} · {{ entry.suiteRow === undefined ? "—" : entry.suiteRow + 1 }} · {{ entry.status }} · {{ entry.error }}</p>
        <p v-for="warning in run.result.warnings" :key="warning">{{ warning }}</p>
        <CaseEvidencePanel v-for="entry in reportingUnits(run.result).diagnostics" :key="JSON.stringify([entry.entryId,entry.suiteRow])" :evidence="reportEntryEvidence(run.result, entry)" :disabled="run.running" :inspect="run.inspectEvidence" :rerun="run.rerunEvidence" @locate="emit('locate-evidence', $event)" />
      </div>
      <a-table
        v-if="run.result"
        :data-source="run.result.cases"
        :columns="columns"
        :row-key="rowKey"
        :pagination="false"
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
    <RunsHistory :run="run" :report-error="reportError" />
  </section>
</template>

<style scoped>
.run-view {
  padding: 8px 10px;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
}
.collection-select {
  min-width: 180px;
}
.env-select {
  min-width: 140px;
}
.summary {
  color: var(--text-muted);
}
.detail-error {
  color: var(--fail);
  margin-bottom: 4px;
}
.detail-assert.fail {
  color: var(--fail);
}
</style>

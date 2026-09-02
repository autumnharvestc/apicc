<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button as AButton, Select as ASelect, Table as ATable, Tag as ATag } from "ant-design-vue";
import type { CaseOutcome } from "@apicc/core";
import type { useRunStore } from "../stores/run.js";
import type { useWorkspaceStore } from "../stores/workspace.js";
import type { TreeNodeDTO } from "../../../shared/tree-dto.js";
import EmptyState from "./EmptyState.vue";
import RunsHistory from "./RunsHistory.vue";

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
  selectedCollectionId: string | null;
  reportError: (e: unknown) => void;
}>();
const { t } = useI18n();

// —— 集合/环境选项（均派生自树 DTO） ——
const collectionOptions = computed(() => {
  const options: Array<{ label: string; value: string }> = [];
  for (const group of props.workspace.tree?.children ?? []) {
    for (const project of group.children ?? []) {
      for (const collection of project.children ?? []) {
        if (collection.kind === "collection") options.push({ label: collection.label, value: collection.id });
      }
    }
  }
  return options;
});

const selectedCollectionId = ref<string | null>(props.selectedCollectionId);
watch(() => props.selectedCollectionId, (id) => { if (id !== null) selectedCollectionId.value = id; });

/** 选中集合所属的项目节点：环境下拉取其 envs（含派生链的完整环境列表）。 */
const projectOfSelected = computed<TreeNodeDTO | undefined>(() => {
  for (const group of props.workspace.tree?.children ?? []) {
    for (const project of group.children ?? []) {
      if ((project.children ?? []).some((c) => c.id === selectedCollectionId.value)) return project;
    }
  }
  return undefined;
});

// 环境按名称引用（run:collection 入参 envName），首项「无环境」= 不传 envName。
const selectedEnv = ref("");
// 环境列表随选中集合所属项目而变：项目切换后原选中环境名在新项目中不存在（残留失效值
// 会被主进程「未找到环境」显式拒绝），故 projectOfSelected 变化即重置回「无环境」；
// 同项目内切换集合不触发（computed 引用未变），环境列表不变可保留选中。
watch(projectOfSelected, () => {
  selectedEnv.value = "";
});
const envOptions = computed(() => [
  { label: t("run.envNone"), value: "" },
  ...(projectOfSelected.value?.envs ?? []).map((e) => ({ label: e.name, value: e.name })),
]);

// —— 运行 ——
async function onRun() {
  const collectionId = selectedCollectionId.value;
  if (!collectionId) return;
  try {
    await props.run.runCollection(collectionId, selectedEnv.value || undefined);
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

// CaseOutcome 无独立 id：apiId+caseId+数据行号合成稳定 rowKey（EnvPanel row-key 告警教训）。
function rowKey(record: CaseOutcome): string {
  return `${record.apiId}:${record.caseId}:${record.row ?? -1}`;
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
          :value="selectedCollectionId"
          :options="collectionOptions"
          :placeholder="t('run.collectionPlaceholder')"
          data-testid="run-collection-select"
          @update:value="(id: string) => (selectedCollectionId = id)"
        />
        <a-select
          class="env-select"
          v-model:value="selectedEnv"
          :options="envOptions"
          :placeholder="t('run.envPlaceholder')"
          data-testid="run-env-select"
        />
        <a-button type="primary" :loading="run.running" :disabled="!selectedCollectionId" data-testid="run-btn" @click="onRun">
          {{ t("run.runBtn") }}
        </a-button>
        <a-button data-testid="runs-history-btn" @click="run.historyOpen = true">{{ t("run.history") }}</a-button>
      </div>
      <div v-if="run.result" class="summary" data-testid="run-summary">
        {{ t("run.summary", { total: run.result.total, passed: run.result.passed, failed: run.result.failed }) }}
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
          <template v-if="column.key === 'row'">{{ record.row ?? "—" }}</template>
          <template v-else-if="column.key === 'passed'">
            <a-tag :color="record.passed ? 'success' : 'error'" :data-passed="String(record.passed)" data-testid="run-outcome">
              {{ record.passed ? t("response.passed") : t("response.failed") }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'durationMs'">{{ formatMs(record.durationMs) }}</template>
        </template>
        <template #expandedRowRender="{ record }">
          <div class="case-detail" data-testid="run-detail">
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

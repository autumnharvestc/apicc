<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Alert as AAlert, Drawer as ADrawer, Table as ATable, Tag as ATag } from "ant-design-vue";
import type { CaseOutcome, NodeResult, NodeState, WorkflowRunResult } from "@apicc/core";
import { stateTagColor } from "../wf/wfCanvas.js";

/**
 * 运行结果抽屉（M2-B 任务 7，纯展示组件）：props 只收 open/result（WorkflowRunResult），
 * 关闭经 emit("close") 上抛（开关状态由 WfDesigner 持有：运行完成自动打开、顶栏
 * 「结果」按钮重开）。内容 = warnings a-alert 置顶列表 + 节点 a-table（label / 状态
 * Tag（stateTagColor，复用 colorForState 语义）/ 耗时（outcome?.durationMs）/ 错误）。
 * 组件内零 store/工厂调用；耗时无 outcome（noop/skipped）与无 error 以「—」占位。
 */
const props = defineProps<{ open: boolean; result: WorkflowRunResult | null }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();

const columns = computed(() => [
  { key: "label", title: t("wf.colNode"), dataIndex: "label" },
  { key: "row", title: t("run.row"), dataIndex: "row" },
  { key: "state", title: t("wf.colState"), dataIndex: "state" },
  { key: "duration", title: t("wf.colDuration"), dataIndex: "duration" },
  { key: "error", title: t("wf.colError"), dataIndex: "error" },
]);

interface ResultRow {
  node: NodeResult;
  outcome?: CaseOutcome;
  state: NodeState;
  key: string;
}

/** 展开节点的全部实际数据行；旧报告无 outcomes 时回退 outcome。 */
const rows = computed<ResultRow[]>(() => props.result?.nodeResults.flatMap((node) => {
  const outcomes = node.outcomes?.length ? node.outcomes : node.outcome ? [node.outcome] : [];
  if (outcomes.length === 0) return [{ node, state: node.state, key: `${node.nodeId}:0` }];
  const expanded = outcomes.map((outcome, index) => ({
    node, outcome, state: outcome.skipped ? "skipped" as const : outcome.passed ? "passed" as const : "failed" as const,
    key: `${node.nodeId}:${index}`,
  }));
  // 条件/路由失败不能改写已经通过的 HTTP 数据行；追加独立节点诊断行。
  if (node.state === "failed" && expanded.every((row) => row.outcome?.passed)) {
    expanded.push({
      node,
      outcome: {
        apiId: node.nodeId, apiName: node.label ?? node.nodeId, caseId: node.nodeId,
        caseName: `${node.label ?? node.nodeId}（节点诊断）`, passed: false, durationMs: 0,
        assertions: [], error: node.error ?? "节点执行失败", failureKind: node.failureKind,
      },
      state: "failed", key: `${node.nodeId}:diagnostic`,
    });
  }
  return expanded;
}) ?? []);

function rowKey(record: ResultRow): string {
  return record.key;
}

function formatMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}
</script>

<template>
  <a-drawer
    :open="open"
    :title="t('wf.resultTitle')"
    :width="460"
    data-testid="wf-result-drawer"
    @close="emit('close')"
  >
    <template v-if="result">
      <!-- warnings 置顶（结构性告警如悬空边——不阻断运行但必须可见，core runner 折进 warnings） -->
      <a-alert
        v-if="result.warnings.length > 0"
        class="wf-result-warnings"
        type="warning"
        show-icon
        data-testid="wf-result-warnings"
      >
        <template #message>
          <span>{{ t("wf.warnings") }}</span>
          <ul class="wf-result-warning-list">
            <li v-for="(w, i) in result.warnings" :key="i" data-testid="wf-result-warning-item">{{ w }}</li>
          </ul>
        </template>
      </a-alert>
      <a-table
        :data-source="rows"
        :columns="columns"
        :row-key="rowKey"
        :pagination="false"
        size="small"
        data-testid="wf-result-table"
        :custom-row="(): Record<string, any> => ({ 'data-testid': 'wf-result-node' })"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'label'">
            {{ record.outcome?.caseName || record.node.label || record.node.nodeId }}
          </template>
          <template v-else-if="column.key === 'state'">
            <a-tag :color="stateTagColor(record.state)" data-testid="wf-result-state">
              {{ t(`wf.nodeState.${record.state}`) }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'row'">{{ record.outcome?.row ?? "—" }}</template>
          <template v-else-if="column.key === 'duration'">
            {{ record.outcome ? formatMs(record.outcome.durationMs) : "—" }}
          </template>
          <template v-else-if="column.key === 'error'">
            <span class="wf-result-error">
              <template v-if="record.outcome?.skipReason">{{ record.outcome.skipReason }}</template>
              <template v-if="record.outcome?.failureKind">{{ record.outcome.failureKind }}</template>
              <template v-if="!record.outcome?.failureKind && record.node.failureKind">{{ record.node.failureKind }}</template>
              <template v-if="record.outcome?.error">{{ record.outcome.error }}</template>
              <template v-if="!record.outcome?.error && record.node.error">{{ record.node.error }}</template>
              <template v-if="!record.outcome?.skipReason && !record.outcome?.failureKind && !record.node.failureKind && !record.outcome?.error && !record.node.error">{{ record.node.skipReason ?? "—" }}</template>
            </span>
          </template>
        </template>
      </a-table>
    </template>
  </a-drawer>
</template>

<style scoped>
/* 长文本防溢出（2B T7③）：warnings 告警整体 break-all（word-break 可继承，覆盖
 * message/列表全部子文本，li 上的显式规则保留兜底）；错误列单元格单独断行。 */
.wf-result-warnings { margin-bottom: 12px; word-break: break-all; }
.wf-result-warning-list { margin: 4px 0 0; padding-left: 18px; }
.wf-result-warning-list li { word-break: break-all; }
.wf-result-error { word-break: break-all; }
</style>

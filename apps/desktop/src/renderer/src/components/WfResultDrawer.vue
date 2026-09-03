<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Alert as AAlert, Drawer as ADrawer, Table as ATable, Tag as ATag } from "ant-design-vue";
import type { NodeResult, WorkflowRunResult } from "@apicc/core";
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
  { key: "state", title: t("wf.colState"), dataIndex: "state" },
  { key: "duration", title: t("wf.colDuration"), dataIndex: "duration" },
  { key: "error", title: t("wf.colError"), dataIndex: "error" },
]);

// NodeResult 以 nodeId 为天然稳定键（EnvPanel row-key 告警教训）。
function rowKey(record: NodeResult): string {
  return record.nodeId;
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
        :data-source="result.nodeResults"
        :columns="columns"
        :row-key="rowKey"
        :pagination="false"
        size="small"
        data-testid="wf-result-table"
        :custom-row="() => ({ 'data-testid': 'wf-result-node' })"
      >
        <template #bodyCell="{ column, record }">
          <template v-if="column.key === 'state'">
            <a-tag :color="stateTagColor(record.state)" data-testid="wf-result-state">
              {{ t(`wf.nodeState.${record.state}`) }}
            </a-tag>
          </template>
          <template v-else-if="column.key === 'duration'">
            {{ record.outcome ? formatMs(record.outcome.durationMs) : "—" }}
          </template>
          <template v-else-if="column.key === 'error'">{{ record.error ?? "—" }}</template>
        </template>
      </a-table>
    </template>
  </a-drawer>
</template>

<style scoped>
.wf-result-warnings { margin-bottom: 12px; }
.wf-result-warning-list { margin: 4px 0 0; padding-left: 18px; }
.wf-result-warning-list li { word-break: break-all; }
</style>

<script setup lang="ts">
import { watch } from "vue";
import { useI18n } from "vue-i18n";
import { Drawer as ADrawer } from "ant-design-vue";
import type { useRunStore } from "../stores/run.js";
import type { RunSummaryDTO, StressRunSummaryDTO } from "../../../shared/types.js";

/**
 * 运行历史抽屉（任务 6）：a-drawer 内按新→旧列出运行摘要（runs:list），点击一条经
 * runs:get 读回完整结果回填 RunView 表格并收起抽屉。store 经 props 注入（组合根一次
 * 装配；组件内部禁止重复调用工厂）；historyOpen 置真时自动 loadHistory 刷新列表；
 * 链路拒绝统一转报组合根错误通道（reportError）。
 * kind 判别（M2-D3 任务 1 最小改动）：集合行渲染同前；压测行暂以摘要文本占位，
 * 报告展示与行内详情为任务 2/3 范围。
 */
const props = defineProps<{
  run: ReturnType<typeof useRunStore>;
  reportError: (e: unknown) => void;
}>();
const { t } = useI18n();

type RunSummary = RunSummaryDTO | StressRunSummaryDTO;

function rowName(s: RunSummary): string {
  return s.kind === "collection" ? s.collectionName : `压测 · ${s.totalRequests} 请求`;
}
function rowMeta(s: RunSummary): string {
  return s.kind === "collection"
    ? t("run.summary", { total: s.total, passed: s.passed, failed: s.failed })
    : `成功 ${s.ok} · 失败 ${s.failed} · RPS ${s.rps.toFixed(1)}`;
}
function rowFailed(s: RunSummary): number {
  return s.failed;
}

async function loadHistory() {
  try {
    await props.run.loadHistory();
  } catch (e) {
    props.reportError(e);
  }
}
watch(
  () => props.run.historyOpen,
  (open) => {
    if (open) void loadHistory();
  },
);

async function onOpen(file: string) {
  try {
    await props.run.openRun(file);
    props.run.historyOpen = false;
  } catch (e) {
    props.reportError(e);
  }
}
</script>

<template>
  <a-drawer
    :open="run.historyOpen"
    :title="t('run.history')"
    :width="320"
    data-testid="runs-drawer"
    @close="run.historyOpen = false"
  >
    <div
      v-for="s in run.summaries"
      :key="s.file"
      class="history-row"
      :data-file="s.file"
      :data-kind="s.kind"
      data-testid="history-row"
      @click="onOpen(s.file)"
    >
      <div class="row-name">{{ rowName(s) }}</div>
      <div class="row-meta">
        <span>{{ s.startedAt }}</span>
        <span :class="{ fail: rowFailed(s) > 0 }">{{ rowMeta(s) }}</span>
      </div>
    </div>
    <div v-if="run.summaries.length === 0" class="history-empty">{{ t("run.historyEmpty") }}</div>
  </a-drawer>
</template>

<style scoped>
.history-row {
  padding: 8px 10px;
  border: 1px solid var(--border, #d9d9d9);
  border-radius: 6px;
  margin-bottom: 8px;
  cursor: pointer;
}
.history-row:hover {
  border-color: var(--primary, #1677ff);
}
.row-name {
  font-weight: 600;
  margin-bottom: 4px;
}
.row-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  color: var(--text-secondary, #666);
  word-break: break-all;
}
.row-meta .fail {
  color: var(--fail, #cf1322);
}
.history-empty {
  color: var(--text-secondary, #666);
  text-align: center;
  padding: 24px 0;
}
</style>

<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button as AButton, Drawer as ADrawer, Tag as ATag } from "ant-design-vue";
import type { useRunStore } from "../stores/run.js";
import type { RunSummaryDTO, StressRunSummaryDTO } from "../../../shared/types.js";
import StressReportView from "./StressReportView.vue";

/**
 * 运行历史抽屉（任务 6）：a-drawer 内按新→旧列出运行摘要（runs:list），点击集合行经
 * runs:get 读回完整结果回填 RunView 表格并收起抽屉。store 经 props 注入（组合根一次
 * 装配；组件内部禁止重复调用工厂）；historyOpen 置真时自动 loadHistory 刷新列表；
 * 链路拒绝统一转报组合根错误通道（reportError）。
 * kind 区分（M2-D3 任务 3，裁定 B）：两类行均带 a-tag 标签（集合/压测，i18n 键）；
 * 压测行显示 totalRequests/failed/rps 摘要，点击经 run.openRun（runs:get 联合分支 →
 * store.stressReport）后在抽屉内嵌切换为 StressReportView 展示（实现成本低者：复用
 * 同一抽屉内嵌区，不再叠一层传送门抽屉），「返回」复位列表与 store 报告。任务 1 的
 * 内联中文占位在本任务 i18n 收口（组件内零内联中文）。
 */
const props = defineProps<{
  run: ReturnType<typeof useRunStore>;
  reportError: (e: unknown) => void;
}>();
const { t } = useI18n();

type RunSummary = RunSummaryDTO | StressRunSummaryDTO;

/** 抽屉内嵌视图开关：false 列表 / true 压测报告（打开抽屉时复位）。 */
const viewingStress = ref(false);

function kindLabel(s: RunSummary): string {
  return s.kind === "collection" ? t("run.kindCollection") : t("run.kindStress");
}
function rowName(s: RunSummary): string {
  return s.kind === "collection" ? s.collectionName : "";
}
function rowMeta(s: RunSummary): string {
  return s.kind === "collection"
    ? t("run.summary", { total: s.total, passed: s.passed, failed: s.failed })
    : t("run.stressSummary", { total: s.totalRequests, failed: s.failed, rps: fmtRps(s.rps) });
}
function rowFailed(s: RunSummary): number {
  return s.failed;
}
/** rps 两位小数内联格式化（与 StressReportView 同口径，禁 NaN：来源为校验过的数值）。 */
function fmtRps(v: number): string {
  return String(Math.round(v * 100) / 100);
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
    if (open) {
      // 重开抽屉复位上次的内嵌报告视图（store 报告一并清掉，避免陈旧残留）
      viewingStress.value = false;
      props.run.stressReport = null;
      void loadHistory();
    }
  },
);

async function onOpen(s: RunSummary) {
  try {
    await props.run.openRun(s.file);
    if (s.kind === "collection") {
      props.run.historyOpen = false;
    } else {
      viewingStress.value = true; // 抽屉保持打开，内嵌切到压测报告
    }
  } catch (e) {
    props.reportError(e);
  }
}

/** 返回列表：卸载内嵌报告并复位 store 报告。 */
function onBack() {
  viewingStress.value = false;
  props.run.stressReport = null;
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
    <template v-if="!viewingStress">
      <div
        v-for="s in run.summaries"
        :key="s.file"
        class="history-row"
        :data-file="s.file"
        :data-kind="s.kind"
        data-testid="history-row"
        @click="onOpen(s)"
      >
        <div class="row-name">
          <a-tag
            :color="s.kind === 'stress' ? 'purple' : 'blue'"
            class="kind-tag"
            data-testid="history-kind"
          >{{ kindLabel(s) }}</a-tag>
          <span v-if="rowName(s)">{{ rowName(s) }}</span>
        </div>
        <div class="row-meta">
          <span>{{ s.startedAt }}</span>
          <span :class="{ fail: rowFailed(s) > 0 }">{{ rowMeta(s) }}</span>
        </div>
      </div>
      <div v-if="run.summaries.length === 0" class="history-empty">{{ t("run.historyEmpty") }}</div>
    </template>
    <template v-else>
      <a-button size="small" class="back-btn" data-testid="history-back" @click="onBack">
        {{ t("run.back") }}
      </a-button>
      <StressReportView :report="run.stressReport?.report ?? null" />
    </template>
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
  display: flex;
  align-items: center;
  gap: 4px;
}
.kind-tag {
  margin-inline-end: 0;
  flex: none;
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
.back-btn {
  margin-bottom: 8px;
}
</style>

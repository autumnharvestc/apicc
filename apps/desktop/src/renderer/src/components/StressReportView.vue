<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Table as ATable } from "ant-design-vue";
import type { StressReport } from "@apicc/core";

/**
 * 压测报告纯展示组件（M2-D3 任务 2，裁定 C）：props 报告对象 → 摘要行（total/ok/failed/
 * rps/时长）+ 时延分位表 + 状态码/错误分布两小表；报告为 null/undefined 时整块不渲染；
 * totalRequests=0 展示「无样本」态。数字格式化 helper 内联（毫秒取整、rps 两位小数），
 * 任何数值路径不产 NaN；面板与运行历史详情（任务 3）复用本组件。
 */
const props = defineProps<{ report: StressReport | null }>();
const { t } = useI18n();

// —— 数字格式化（内联 helper，禁 NaN：所有输入来自 StressReportSchema 校验过的数值） ——
function fmtInt(v: number): string {
  return String(Math.round(v));
}
function fmtMs(v: number): string {
  return `${Math.round(v)} ms`;
}
function fmtRps(v: number): string {
  return String(Math.round(v * 100) / 100);
}

const summary = computed(() => {
  const r = props.report;
  if (!r) return "";
  return t("stress.summary", {
    total: fmtInt(r.totalRequests),
    ok: fmtInt(r.ok),
    failed: fmtInt(r.failed),
    rps: fmtRps(r.rps),
    duration: fmtMs(r.durationMs),
  });
});

// —— 分位表：单行 7 列（列名 min/avg/p50/p90/p95/p99/max 为技术 token，不入 i18n） ——
const LATENCY_KEYS = ["min", "avg", "p50", "p90", "p95", "p99", "max"] as const;
const latencyColumns = computed(() => LATENCY_KEYS.map((k) => ({ key: k, title: k, dataIndex: k })));
const latencyRows = computed(() => {
  const l = props.report?.latency;
  if (!l) return [];
  const row: Record<string, string> = { key: "latency" };
  for (const k of LATENCY_KEYS) row[k] = fmtMs(l[k]);
  return [row];
});

// —— 分布两列小表（状态码 / 错误类型 → 次数） ——
function distRows(dist: Record<string, number>): Array<{ label: string; count: number }> {
  return Object.entries(dist).map(([label, count]) => ({ label, count }));
}
const statusRows = computed(() => distRows(props.report?.statusDist ?? {}));
const errorRows = computed(() => distRows(props.report?.errorKinds ?? {}));
const statusColumns = computed(() => [
  { key: "label", title: t("stress.statusCol"), dataIndex: "label" },
  { key: "count", title: t("stress.count"), dataIndex: "count" },
]);
const errorColumns = computed(() => [
  { key: "label", title: t("stress.errorCol"), dataIndex: "label" },
  { key: "count", title: t("stress.count"), dataIndex: "count" },
]);
</script>

<template>
  <section v-if="report" class="stress-report" data-testid="stress-report">
    <div v-if="report.totalRequests === 0" class="no-samples" data-testid="stress-no-samples">
      {{ t("stress.noSamples") }}
    </div>
    <template v-else>
      <div class="summary" data-testid="stress-summary">{{ summary }}</div>
      <h4 class="block-title">{{ t("stress.latency") }}</h4>
      <a-table
        :data-source="latencyRows"
        :columns="latencyColumns"
        row-key="key"
        :pagination="false"
        size="small"
        data-testid="stress-latency"
      />
      <div class="dist">
        <div>
          <h4 class="block-title">{{ t("stress.statusDist") }}</h4>
          <a-table
            :data-source="statusRows"
            :columns="statusColumns"
            row-key="label"
            :pagination="false"
            size="small"
            data-testid="stress-status-dist"
          />
        </div>
        <div>
          <h4 class="block-title">{{ t("stress.errorKinds") }}</h4>
          <a-table
            :data-source="errorRows"
            :columns="errorColumns"
            row-key="label"
            :pagination="false"
            size="small"
            data-testid="stress-error-kinds"
          />
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.stress-report {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 4px;
}
.summary {
  color: var(--text-muted, #666);
}
.block-title {
  margin: 4px 0 0;
  font-size: 13px;
  font-weight: 600;
}
.no-samples {
  color: var(--text-muted, #666);
}
.dist {
  display: flex;
  gap: 16px;
}
.dist > div {
  flex: 1;
  min-width: 0;
}
</style>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Table as ATable } from "ant-design-vue";
import type { DesktopStressReport } from "../../../shared/types.js";

/**
 * 压测报告纯展示组件（M2-D3 任务 2，裁定 C）：props 报告对象 → 摘要行（total/ok/failed/
 * rps/时长）+ 时延分位表 + 状态码/错误分布两小表；报告为 null/undefined 时整块不渲染；
 * totalRequests=0 展示「无样本」态。数字格式化 helper 内联（毫秒取整、rps 两位小数），
 * 任何数值路径不产 NaN；面板与运行历史详情（任务 3）复用本组件。
 */
const props = defineProps<{ report: DesktopStressReport | null }>();
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
const verdict = computed(() => {
  if (!props.report?.verdict) return "unassessed";
  return props.report.verdict.passed ? "passed" : "failed";
});
const violationRows = computed(() => (props.report?.verdict?.violations ?? []).map((violation) => ({
  metric: t(`stress.metric.${violation.metric}`), actual: String(violation.actual), expected: String(violation.expected), message: violation.message,
})));
const failureRows = computed(() => Object.entries(props.report?.failures ?? {}).filter(([, count]) => count > 0).map(([kind, count]) => ({ kind: t(`stress.failure.${kind}`), count })));
const safetyRows = computed(() => props.report?.safety?.targetOrigins ?? []);
const safetyRun = computed(() => props.report?.safety?.run);
const generator = computed(() => props.report?.generator);
const eligibleCompletedAttempts = computed(() => props.report?.eligibleCompletedAttempts ?? props.report?.totalRequests ?? 0);
</script>

<template>
  <section v-if="report" class="stress-report" data-testid="stress-report">
    <div class="verdict" :data-verdict="verdict" data-testid="stress-verdict">
      <strong v-if="verdict === 'passed'">{{ t("stress.verdictPassed") }}</strong>
      <strong v-else-if="verdict === 'failed'">{{ t("stress.verdictFailed") }}</strong>
      <strong v-else>{{ t("stress.verdictUnassessed") }}</strong>
    </div>
    <div v-if="report.generator?.saturated" class="saturated-warning" data-testid="stress-generator-saturated">{{ t("stress.generatorSaturated") }}</div>
    <div v-if="violationRows.length" class="violations" data-testid="stress-violations">
      <h4 class="block-title">{{ t("stress.violations") }}</h4>
      <a-table :data-source="violationRows" :columns="[{ key: 'metric', title: t('stress.metricName'), dataIndex: 'metric' }, { key: 'actual', title: t('stress.actual'), dataIndex: 'actual' }, { key: 'expected', title: t('stress.expected'), dataIndex: 'expected' }, { key: 'message', title: t('stress.detail'), dataIndex: 'message' }]" row-key="metric" :pagination="false" size="small" />
    </div>
    <div v-if="failureRows.length" class="violations" data-testid="stress-failures">
      <h4 class="block-title">{{ t("stress.failureKinds") }}</h4>
      <a-table :data-source="failureRows" :columns="[{ key: 'kind', title: t('stress.failureKind'), dataIndex: 'kind' }, { key: 'count', title: t('stress.count'), dataIndex: 'count' }]" row-key="kind" :pagination="false" size="small" />
    </div>
    <div class="safety" data-testid="stress-safety">
      <h4 class="block-title">{{ t("stress.safety") }}</h4>
      <span v-if="report.safety?.availability === 'unavailable'">{{ t("stress.safetyUnavailable") }}</span>
      <span v-else-if="!safetyRows.length">{{ t("stress.safetyNone") }}</span>
      <ul v-else>
        <li v-for="row in safetyRows" :key="row.origin">
          {{ row.origin }} · {{ row.confirmation }} · {{ row.policy }} · loopback={{ row.loopback === true ? "true" : "false" }}
          <span v-if="row.appliedPolicy"> · trusted={{ (row.appliedPolicy.trustedOrigins ?? []).join(",") }} · denied={{ (row.appliedPolicy.deniedOrigins ?? []).join(",") }}<span v-if="row.appliedPolicy.maxConcurrency !== undefined"> · maxConcurrency={{ row.appliedPolicy.maxConcurrency }}</span><span v-if="row.appliedPolicy.maxRps !== undefined"> · maxRps={{ row.appliedPolicy.maxRps }}</span></span>
        </li>
      </ul>
      <div v-if="safetyRun" data-testid="stress-safety-run">{{ t("stress.safetyRun") }}: requestedConcurrency={{ safetyRun.requestedConcurrency }} · effectiveConcurrency={{ safetyRun.effectiveConcurrency }} · requestedMaxRps={{ safetyRun.requestedMaxRps ?? "none" }} · effectiveMaxRps={{ safetyRun.effectiveMaxRps ?? "none" }} · {{ safetyRun.connectionMode }}</div>
    </div>
    <div class="generator" data-testid="stress-generator">
      <h4 class="block-title">{{ t("stress.generator") }}</h4>
      <span v-if="!generator || generator.availability === 'unavailable'">{{ generator?.unavailableReason ?? t("stress.generatorUnavailable") }}</span>
      <span v-else>{{ generator.availability === 'partial' ? `${t("stress.generatorPartial")} · ` : "" }}CPU {{ fmtInt(generator.cpuPercent ?? 0) }}% · RSS {{ fmtInt(generator.rssPeakBytes ?? 0) }} · {{ fmtMs(generator.eventLoopDelayP95Ms ?? 0) }} · backlog {{ generator.schedulerBacklogMax ?? 0 }}</span>
    </div>
    <div v-if="eligibleCompletedAttempts === 0" class="no-samples" data-testid="stress-no-samples">
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
.verdict { font-weight: 600; }
.verdict[data-verdict="passed"] { color: var(--pass, #389e0d); }
.verdict[data-verdict="failed"], .saturated-warning { color: var(--fail, #cf1322); }
.saturated-warning { border: 1px solid currentColor; padding: 6px; font-weight: 600; }
.safety, .generator, .violations { font-size: 12px; }
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

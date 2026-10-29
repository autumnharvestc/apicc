<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Table as ATable } from "ant-design-vue";
import type { DesktopStressReport } from "../../../shared/types.js";
import type { StressReportV2, StressLatencyMetric, StressNumericMetric, StressExecutionSummary } from "@apicc/core";
import { stressArrivalWindowNotices } from "@apicc/core/schema";
import CaseEvidencePanel from "./CaseEvidencePanel.vue";
import StressTrendView from "./StressTrendView.vue";
import StressExecutionSummaryView from './StressExecutionSummaryView.vue';
import {stressSafetyCodeText} from '@apicc/core/stress/html';

/**
 * 压测报告纯展示组件（M2-D3 任务 2，裁定 C）：props 报告对象 → 摘要行（total/ok/failed/
 * rps/时长）+ 时延分位表 + 状态码/错误分布两小表；报告为 null/undefined 时整块不渲染；
 * totalRequests=0 展示「无样本」态。数字格式化 helper 内联（毫秒取整、rps 两位小数），
 * 任何数值路径不产 NaN；面板与运行历史详情（任务 3）复用本组件。
 */
const props = defineProps<{ report: DesktopStressReport | StressReportV2 | null; execution?: StressExecutionSummary }>();
const { t,te,locale } = useI18n();
const code=(value:string|undefined)=>value===undefined?t('stressPresentation.notCollected'):te(`stressFinal.codes.${value}`)?t(`stressFinal.codes.${value}`):te(`stressPresentation.codes.${value}`)?t(`stressPresentation.codes.${value}`):te(`stressPresentation.states.${value}`)?t(`stressPresentation.states.${value}`):te(`stress.failure.${value}`)?t(`stress.failure.${value}`):value;
function time(value:number){return Number.isFinite(new Date(value).getTime())?new Intl.DateTimeFormat(locale.value,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3,timeZoneName:'longOffset'}).format(new Date(value)):t('stressPresentation.timeOutOfRange');}
const v2 = computed(() => props.report && 'formatVersion' in props.report ? props.report : null);
const report = computed(() => props.report && !('formatVersion' in props.report) ? props.report : null);
const metric = (v: StressNumericMetric | undefined) => v?.availability === 'available' ? fmtRps(v.value) : v?.availability === 'unavailable' ? code(v.reason) : t('stress.workbench.notCollected');
const arrivalApplicable=computed(()=>v2.value?.plan.load.kind==='constant-arrival'||v2.value?.plan.load.kind==='stages'&&v2.value.plan.load.executor==='arrival');
const arrivalMetric=(value:StressNumericMetric|undefined)=>arrivalApplicable.value?metric(value):t('stressPresentation.notApplicable');
const latencyMetric = (v: StressLatencyMetric) => v.availability === 'available' ? `${fmtRps(v.value.p95)} ms` : code(v.reason);
const metricName=(name:string)=>te(`stress.metric.${name}`)?t(`stress.metric.${name}`):name;
const thresholdValue=(name:string,value:number)=>name==='errorRate'||name==='assertionFailureRate'?`${fmtRps(value*100)}%`:name==='p95'?`${fmtRps(value)} ms`:name==='rps'?`${fmtRps(value)} ${t('stressPresentation.rpsUnit')}`:String(value);

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
  const r = report.value;
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
  const l = report.value?.latency;
  if (!l) return [];
  const row: Record<string, string> = { key: "latency" };
  for (const k of LATENCY_KEYS) row[k] = fmtMs(l[k]);
  return [row];
});

// —— 分布两列小表（状态码 / 错误类型 → 次数） ——
function distRows(dist: Record<string, number>): Array<{ label: string; count: number }> {
  return Object.entries(dist).map(([label, count]) => ({ label, count }));
}
const statusRows = computed(() => distRows(report.value?.statusDist ?? {}));
const errorRows = computed(() => distRows(report.value?.errorKinds ?? {}));
const statusColumns = computed(() => [
  { key: "label", title: t("stress.statusCol"), dataIndex: "label" },
  { key: "count", title: t("stress.count"), dataIndex: "count" },
]);
const errorColumns = computed(() => [
  { key: "label", title: t("stress.errorCol"), dataIndex: "label" },
  { key: "count", title: t("stress.count"), dataIndex: "count" },
]);
const verdict = computed(() => {
  if (!report.value?.verdict) return "unassessed";
  return report.value.verdict.passed ? "passed" : "failed";
});
const violationRows = computed(() => (report.value?.verdict?.violations ?? []).map((violation) => ({
  metric: t(`stress.metric.${violation.metric}`), actual: String(violation.actual), expected: String(violation.expected), message: violation.message,
})));
const failureRows = computed(() => Object.entries(report.value?.failures ?? {}).filter(([, count]) => count > 0).map(([kind, count]) => ({ kind: t(`stress.failure.${kind}`), count })));
const safetyRows = computed(() => report.value?.safety?.targetOrigins ?? []);
const safetyRun = computed(() => report.value?.safety?.run);
const generator = computed(() => report.value?.generator);
const eligibleCompletedAttempts = computed(() => report.value?.eligibleCompletedAttempts ?? report.value?.measurementWindow?.eligibleCompletedAttempts ?? report.value?.totalRequests ?? 0);
</script>

<template>
  <section v-if="v2" class="stress-report" data-testid="stress-report">
    <div class="verdict" :data-verdict="v2.verdict.status" data-testid="stress-verdict">{{t('stressPresentation.logicalVerdict')}}: {{ t(`stress.workbench.verdict.${v2.verdict.status}`) }}</div>
    <p>{{t('stressPresentation.logicalIterations')}}: {{v2.iterations.passed}} / {{v2.iterations.completed}} · {{t('stressPresentation.failed')}} {{v2.iterations.failed}}</p>
    <p class="identity">{{ t(v2.target.kind==='workflow'?'stress.workbench.workflow':'stress.case') }} · {{ v2.target.kind === 'workflow' ? v2.target.workflowId : v2.target.caseId }} · {{ v2.runId }}</p>
    <details class="identity"><summary>{{t('stressPresentation.fingerprint')}} · {{v2.definitionRevision.length>12?v2.definitionRevision.slice(0,8)+'…'+v2.definitionRevision.slice(-4):v2.definitionRevision}}</summary><code>{{v2.definitionRevision}}</code></details>
    <p><time :title="String(v2.startedAt)">{{t('stressPresentation.startedAt')}}: {{time(v2.startedAt)}}</time> · <time :title="String(v2.finishedAt)">{{t('stressPresentation.finishedAt')}}: {{time(v2.finishedAt)}}</time></p>
    <StressExecutionSummaryView v-if="execution" :execution="execution" />
    <div class="completeness" data-testid="stress-completeness"><p v-for="(part,key) in v2.completeness" :key="key">{{ t(`stress.workbench.${key}`) }}: {{ t(part.complete ? 'stress.workbench.complete' : 'stress.workbench.incomplete') }} <span v-if="part.reasons.length">({{ part.reasons.map(code).join(', ') }})</span></p></div>
    <p data-testid="stress-iteration-counts">{{ t('stress.workbench.iterations') }}: <span v-for="key in ['planned','started','completed','passed','failed','aborted','dropped'] as const" :key="key">{{t(`stressPresentation.${key}`)}} {{v2.iterations[key]}} · </span> p95 {{ latencyMetric(v2.iterations.latency) }}</p>
    <p>{{t('stressPresentation.measurementPopulation')}} · {{t('stressPresentation.lifecyclePopulation')}}</p>
    <p data-testid="stress-request-counts">{{ t('stress.workbench.requests') }}: {{t('stressPresentation.started')}} {{ v2.requests.started }} · {{t('stressPresentation.completed')}} {{ v2.requests.completed }} · {{t('stressPresentation.eligible')}} {{ v2.requests.eligibleCompleted }} · {{ t('stress.workbench.requestFailures') }} {{ v2.requests.failed }} · {{ t('stress.workbench.httpRps') }} {{ metric(v2.rps) }} · p95 {{ latencyMetric(v2.latency) }}</p>
    <p>{{t('stressPresentation.caseRows')}} {{ v2.caseRows.total }} ({{t('stressPresentation.failed')}} {{ v2.caseRows.failed }}) · {{t('stressPresentation.httpHops')}} {{ v2.httpExchanges.started }}/{{ v2.httpExchanges.completed }}</p>
    <p>{{ t('stress.workbench.capacity') }}: VU {{ v2.load.maxVus }} · {{ t('stress.workbench.requestConcurrency') }} {{ v2.load.maxRequestConcurrency }} {{t('stressPresentation.requestUnit')}} · {{ t('stress.maxRps') }} {{ v2.load.effectiveMaxRps === undefined ? t('stressPresentation.notCollected') : v2.load.effectiveMaxRps === null ? t('stressPresentation.noRpsLimit') : v2.load.effectiveMaxRps+' '+t('stressPresentation.rpsUnit') }} · {{ t('stress.workbench.arrivalRate') }} {{ arrivalMetric(v2.load.targetArrivalRate) }} · {{ t('stress.workbench.actualStartRate') }} {{ arrivalMetric(v2.load.actualStartRate) }}</p>
    <p>{{ t('stress.workbench.measurement') }} {{ v2.load.measurementDurationMs }} ms · {{t('stressPresentation.drain')}} {{ v2.load.drainDurationMs }} ms · {{t('stressPresentation.policyWait')}} {{ v2.load.policyLimitedMs }} ms</p>
    <p v-for="notice in stressArrivalWindowNotices(v2)" :key="notice.code" data-testid="stress-arrival-window-notice">{{ t(`stress.workbench.arrivalWindow.${notice.code}`) }}</p>
    <div v-if="v2.load.saturated || v2.generator?.saturated || v2.iterations.dropped" class="saturated-warning" data-testid="stress-generator-saturated">{{ t('stress.generatorSaturated') }} · {{t('stressPresentation.dropped')}} {{ v2.iterations.dropped }}</div>
    <p>{{ t('stress.workbench.precision') }}: {{ code(v2.statistics.method) }} · {{ v2.statistics.overflow > 0 ? t('stress.workbench.overflowPrecision') : v2.statistics.exact ? t('stressPresentation.exact') : t('stress.workbench.rangePrecision', { percent: v2.statistics.relativeError * 100 }) }} <span v-if="v2.statistics.underflow > 0"> · {{ t('stress.workbench.underflowPrecision', { resolution: v2.statistics.minValueMs }) }}</span> · {{ t('stress.workbench.resolution') }} {{ v2.statistics.minValueMs }} ms · {{ t('stress.workbench.seriesBounds') }} {{ v2.statistics.underflow }}/{{ v2.statistics.overflow }}</p>
    <p>{{ t('stress.generator') }}: {{ v2.generator ? code(v2.generator.availability) : t('stress.workbench.notCollected') }} · CPU {{ v2.generator?.cpuPercent ?? '—' }}% · RSS {{ v2.generator?.rssPeakBytes == null ? t('stressPresentation.notCollected') : v2.generator.rssPeakBytes/1048576+' MiB' }} · {{t('stressPresentation.eventLoop')}} {{ v2.generator?.eventLoopDelayP95Ms ?? '—' }} ms · {{t('stressPresentation.backlog')}} {{ v2.generator?.schedulerBacklogMax ?? '—' }}</p>
    <StressTrendView :timeline="v2.timeline" :phases="v2.phases" />
    <details open><summary>{{ t('stress.workbench.nodes') }} ({{ v2.nodes.length }})</summary><p>{{ t('stress.workbench.otherHint') }}</p><div class="table-scroll"><table><thead><tr><th>{{ t('stress.workbench.node') }}</th><th>{{t('stressPresentation.visits')}}</th><th>{{ t('stress.workbench.requests') }}</th><th>HTTP p95</th><th>{{ t('stress.workbench.node') }} p95</th></tr></thead><tbody><tr v-for="node in v2.nodes" :key="node.key"><td :title="node.key">{{ node.other ? 'other' : `${node.workflowId} / ${node.nodeId}` }}</td><td>{{ node.visits }} / {{ node.failed }} / {{ node.aborted }} / {{ node.skipped }}</td><td>{{ node.requests.eligibleCompleted }} / {{ node.requests.failed }}</td><td>{{ latencyMetric(node.requestLatency) }}</td><td>{{ latencyMetric(node.nodeLatency) }}</td></tr></tbody></table></div></details>
    <details><summary>{{ t('stress.workbench.lifecycle') }}</summary><div class="table-scroll"><p v-for="(step,index) in v2.lifecycle" :key="index" :title="String(step.durationMs)">{{ code(step.role) }} · {{ step.vuId ?? t('stressPresentation.runLevel') }} · {{ code(step.state) }} · {{ fmtRps(step.durationMs) }} ms · {{ step.failureKind ? code(step.failureKind) : t('stressPresentation.notApplicable') }}</p></div></details>
    <details><summary>{{ t('stress.failureKinds') }} / {{ t('stress.violations') }}</summary><p v-for="(count,kind) in v2.failures" :key="kind">{{ code(String(kind)) }}: {{ count }}</p><p v-for="(count,kind) in v2.errorKinds" :key="kind">{{ code(String(kind)) }}: {{ count }}</p><p v-for="(violation,index) in v2.verdict.violations" :key="index">{{ metricName(violation.metric) }}: {{ thresholdValue(violation.metric,violation.actual) }} / {{ thresholdValue(violation.metric,violation.expected) }}<span v-if="violation.message!==violation.metric"> · {{ violation.message }}</span></p></details>
    <details><summary>{{ t('stress.safety') }}</summary><p>{{ v2.safety ? code(v2.safety.availability) : t('stress.workbench.notCollected') }}</p><p v-for="row in v2.safety?.targetOrigins" :key="row.origin">{{ row.origin }} · {{ code(stressSafetyCodeText(row.confirmation,locale)) }} · {{ code(stressSafetyCodeText(row.policy,locale)) }}</p></details>
    <details><summary>{{ t('stress.workbench.evidence') }}</summary><CaseEvidencePanel v-for="(evidence,index) in v2.failureEvidence" :key="index" :evidence="evidence" /></details>
  </section>
  <section v-else-if="report" class="stress-report" data-testid="stress-report">
    <p class="legacy-note">{{ t('stress.workbench.legacy') }}</p>
    <details><summary>失败证据（最多 20 个；其余仅聚合）</summary><p v-if="!report.failureEvidence">旧记录未采集</p><CaseEvidencePanel v-for="(evidence,index) in report.failureEvidence" :key="index" :evidence="evidence" /></details>
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
      <span v-else>{{ generator.availability === 'partial' ? `${t("stress.generatorPartial")} · ` : "" }}CPU {{ generator.cpuPercent ?? '—' }}% · RSS {{ generator.rssPeakBytes ?? '—' }} · {{ generator.eventLoopDelayP95Ms ?? '—' }} ms · backlog {{ generator.schedulerBacklogMax ?? '—' }}</span>
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
.stress-report p { margin: 3px 0; } .identity { overflow-wrap:anywhere; } .legacy-note { color:var(--text-muted,#666); } .completeness { border:1px solid var(--border,#ddd);padding:6px; } .table-scroll { max-height:300px;overflow:auto; } table { border-collapse:collapse;width:100%;font-size:12px; } td,th { text-align:left;padding:6px;border-bottom:1px solid var(--border,#ddd);white-space:nowrap; }
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

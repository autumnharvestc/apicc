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
const props = defineProps<{ report: DesktopStressReport | StressReportV2 | null; execution?: StressExecutionSummary;
  ai?: import('../stores/ai.js').AiStore; source?: import('../../../shared/ai/contract.js').AiSourceRef;
  reportRef?: import('../../../shared/ai/contract.js').AiReportRef; baselineRef?: import('../../../shared/ai/contract.js').AiReportRef }>();
function analyzeReport() {
  const displayed = props.report, source = props.source, report = props.reportRef, baseline = props.baselineRef;
  if (!displayed || !source || !report || !props.ai) return;
  const key = JSON.stringify([source, report, baseline]);
  void props.ai.prepareReportAnalysis({ source, report, baseline, displayed,
    isCurrent: () => props.report === displayed && JSON.stringify([props.source, props.reportRef, props.baselineRef]) === key });
}
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
const evidenceItems = computed(() => props.report?.failureEvidence);
// Preserve the two legacy safety aliases without interpreting arbitrary business
// decisions as lifecycle, failure, or execution status codes.
const safetyDecision = (value: string) => value === 'confirmed' || value === 'allowed'
  ? t(`stressFinal.codes.${value}`) : stressSafetyCodeText(value, locale.value);
const optionalRps = (value: number | null | undefined) => value === undefined ? t('stressPresentation.notCollected') : value === null ? t('stressPresentation.noRpsLimit') : `${fmtRps(value)} ${t('stressPresentation.rpsUnit')}`;

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
  metric: metricName(violation.metric), actual: thresholdValue(violation.metric, violation.actual), expected: thresholdValue(violation.metric, violation.expected), message: violation.message,
})));
const failureRows = computed(() => Object.entries(report.value?.failures ?? {}).filter(([, count]) => count > 0).map(([kind, count]) => ({ kind: t(`stress.failure.${kind}`), count })));
const safetyRows = computed(() => report.value?.safety?.targetOrigins ?? []);
const safetyRun = computed(() => report.value?.safety?.run);
const generator = computed(() => report.value?.generator);
const eligibleCompletedAttempts = computed(() => report.value?.eligibleCompletedAttempts ?? report.value?.measurementWindow?.eligibleCompletedAttempts ?? report.value?.totalRequests ?? 0);
</script>

<template>
  <section v-if="v2" class="stress-report" data-testid="stress-report">
    <button v-if="ai && source && reportRef" data-testid="ai-analyze-report" :disabled="ai.suggestLoading" @click="analyzeReport">{{ t('ai.analyzeReport') }}</button>
    <header class="report-heading">
    <div class="verdict" :data-verdict="v2.verdict.status" data-testid="stress-verdict">{{t('stressPresentation.logicalVerdict')}}: {{ t(`stress.workbench.verdict.${v2.verdict.status}`) }}</div>
    <p class="identity">{{ t(v2.target.kind==='workflow'?'stress.workbench.workflow':'stress.case') }} · {{ v2.target.kind === 'workflow' ? v2.target.workflowId : v2.target.caseId }} · {{ v2.runId }}</p>
    <details class="identity"><summary>{{t('stressPresentation.fingerprint')}} · {{v2.definitionRevision.length>12?v2.definitionRevision.slice(0,8)+'…'+v2.definitionRevision.slice(-4):v2.definitionRevision}}</summary><code>{{v2.definitionRevision}}</code></details>
    <p><time :title="String(v2.startedAt)">{{t('stressPresentation.startedAt')}}: {{time(v2.startedAt)}}</time> · <time :title="String(v2.finishedAt)">{{t('stressPresentation.finishedAt')}}: {{time(v2.finishedAt)}}</time></p>
    </header>
    <StressExecutionSummaryView v-if="execution" :execution="execution" />
    <div class="completeness" data-testid="stress-completeness"><p v-for="(part,key) in v2.completeness" :key="key">{{ t(`stress.workbench.${key}`) }}: {{ t(part.complete ? 'stress.workbench.complete' : 'stress.workbench.incomplete') }} <span v-if="part.reasons.length">({{ part.reasons.map(code).join(', ') }})</span></p></div>
    <div class="population-grid">
    <section class="population-card">
    <h4>{{ t('stress.workbench.iterations') }}</h4>
    <p class="population-lead"><strong>{{v2.iterations.passed}} / {{v2.iterations.completed}}</strong> {{t('stressPresentation.logicalIterations')}}</p>
    <p data-testid="stress-iteration-counts"><span v-for="key in ['planned','started','completed','passed','failed','aborted','dropped'] as const" :key="key">{{t(`stressPresentation.${key}`)}} {{v2.iterations[key]}} · </span> p95 {{ latencyMetric(v2.iterations.latency) }}</p>
    </section>
    <section class="population-card">
    <h4>{{t('stressPresentation.measurementPopulation')}}</h4>
    <p class="population-lead"><strong>{{v2.requests.eligibleCompleted}}</strong> {{t('stressPresentation.eligible')}} · {{ t('stress.workbench.requestFailures') }} {{v2.requests.failed}}</p>
    <p data-testid="stress-request-counts">{{ t('stress.workbench.requests') }}: {{t('stressPresentation.started')}} {{ v2.requests.started }} · {{t('stressPresentation.completed')}} {{ v2.requests.completed }} · {{t('stressPresentation.eligible')}} {{ v2.requests.eligibleCompleted }} · {{ t('stress.workbench.requestFailures') }} {{ v2.requests.failed }} · {{ t('stress.workbench.httpRps') }} {{ metric(v2.rps) }} · p95 {{ latencyMetric(v2.latency) }}</p>
    <p>{{t('stressPresentation.caseRows')}} {{ v2.caseRows.total }} ({{t('stressPresentation.failed')}} {{ v2.caseRows.failed }}) · {{t('stressPresentation.httpHops')}} {{ v2.httpExchanges.started }}/{{ v2.httpExchanges.completed }}</p>
    </section>
    </div>
    <p class="population-note">{{t('stressPresentation.lifecyclePopulation')}}</p>
    <section class="fact-section">
    <h4>{{t('stress.workbench.capacity')}}</h4>
    <p>{{ t('stress.workbench.capacity') }}: VU {{ v2.load.maxVus }} · {{ t('stress.workbench.requestConcurrency') }} {{ v2.load.maxRequestConcurrency }} {{t('stressPresentation.requestUnit')}} · {{ t('stress.maxRps') }} {{ v2.load.effectiveMaxRps === undefined ? t('stressPresentation.notCollected') : v2.load.effectiveMaxRps === null ? t('stressPresentation.noRpsLimit') : v2.load.effectiveMaxRps+' '+t('stressPresentation.rpsUnit') }} · {{ t('stress.workbench.arrivalRate') }} {{ arrivalMetric(v2.load.targetArrivalRate) }} · {{ t('stress.workbench.actualStartRate') }} {{ arrivalMetric(v2.load.actualStartRate) }}</p>
    <p>{{ t('stress.workbench.measurement') }} {{ v2.load.measurementDurationMs }} ms · {{t('stressPresentation.drain')}} {{ v2.load.drainDurationMs }} ms · {{t('stressPresentation.policyWait')}} {{ v2.load.policyLimitedMs }} ms</p>
    <p v-for="notice in stressArrivalWindowNotices(v2)" :key="notice.code" data-testid="stress-arrival-window-notice">{{ t(`stress.workbench.arrivalWindow.${notice.code}`) }}</p>
    </section>
    <div v-if="v2.load.saturated || v2.generator?.saturated || v2.iterations.dropped" class="saturated-warning" data-testid="stress-generator-saturated">{{ t('stress.generatorSaturated') }} · {{t('stressPresentation.dropped')}} {{ v2.iterations.dropped }}</div>
    <section class="fact-section">
    <h4>{{t('stress.workbench.precision')}}</h4>
    <p>{{ code(v2.statistics.method) }} · {{ v2.statistics.overflow > 0 ? t('stress.workbench.overflowPrecision') : v2.statistics.exact ? t('stressPresentation.exact') : t('stress.workbench.rangePrecision', { percent: v2.statistics.relativeError * 100 }) }} <span v-if="v2.statistics.underflow > 0"> · {{ t('stress.workbench.underflowPrecision', { resolution: v2.statistics.minValueMs }) }}</span> · {{ t('stress.workbench.resolution') }} {{ v2.statistics.minValueMs }} ms · {{ t('stress.workbench.seriesBounds') }} {{ v2.statistics.underflow }}/{{ v2.statistics.overflow }}</p>
    <p>{{ t('stress.generator') }}: {{ v2.generator ? code(v2.generator.availability) : t('stress.workbench.notCollected') }} · CPU {{ v2.generator?.cpuPercent ?? '—' }}% · RSS {{ v2.generator?.rssPeakBytes == null ? t('stressPresentation.notCollected') : v2.generator.rssPeakBytes/1048576+' MiB' }} · {{t('stressPresentation.eventLoop')}} {{ v2.generator?.eventLoopDelayP95Ms ?? '—' }} ms · {{t('stressPresentation.backlog')}} {{ v2.generator?.schedulerBacklogMax ?? '—' }}</p>
    </section>
    <StressTrendView :timeline="v2.timeline" :phases="v2.phases" />
    <details open><summary>{{ t('stress.workbench.nodes') }} ({{ v2.nodes.length }})</summary><p>{{ t('stress.workbench.otherHint') }}</p>
      <div class="table-scroll" tabindex="0" :aria-label="t('stress.workbench.nodes')"><table data-testid="stress-nodes"><thead><tr>
        <th>{{ t('stress.workbench.node') }}</th><th>{{t('stressReportUi.visits')}}</th><th>{{t('stressPresentation.passed')}}</th><th>{{t('stressPresentation.failed')}}</th><th>{{t('stressPresentation.aborted')}}</th><th>{{t('stressReportUi.skipped')}}</th><th>{{t('stressReportUi.eligibleRequests')}}</th><th>{{t('stressReportUi.failedRequests')}}</th><th>HTTP p95</th><th>{{ t('stress.workbench.node') }} p95</th>
      </tr></thead><tbody><tr v-for="node in v2.nodes" :key="node.key">
        <td class="business-id" :title="node.key">{{ node.other ? t('stressReportUi.otherNodes') : `${node.workflowId} / ${node.nodeId}` }}</td><td>{{node.visits}}</td><td>{{node.passed}}</td><td>{{node.failed}}</td><td>{{node.aborted}}</td><td>{{node.skipped}}</td><td>{{node.requests.eligibleCompleted}}</td><td>{{node.requests.failed}}</td><td>{{latencyMetric(node.requestLatency)}}</td><td>{{latencyMetric(node.nodeLatency)}}</td>
      </tr></tbody></table><p v-if="!v2.nodes.length" class="empty-note">{{t('stressReportUi.noRecords')}}</p></div>
    </details>
    <details><summary>{{ t('stress.workbench.lifecycle') }}</summary><div class="table-scroll" tabindex="0" :aria-label="t('stress.workbench.lifecycle')"><table data-testid="stress-lifecycle"><thead><tr><th>{{t('stressReportUi.role')}}</th><th>{{t('stressReportUi.vu')}}</th><th>{{t('stressReportUi.state')}}</th><th>{{t('stressReportUi.duration')}}</th><th>{{t('stressReportUi.failureKind')}}</th></tr></thead><tbody>
      <tr v-for="(step,index) in v2.lifecycle" :key="index"><td>{{code(step.role)}}</td><td class="business-id">{{step.vuId ?? t('stressPresentation.runLevel')}}</td><td>{{code(step.state)}}</td><td :title="String(step.durationMs)">{{fmtRps(step.durationMs)}} ms</td><td>{{step.failureKind ? code(step.failureKind) : t('stressPresentation.notApplicable')}}</td></tr>
    </tbody></table><p v-if="!v2.lifecycle.length" class="empty-note">{{t('stressReportUi.noRecords')}}</p></div></details>
    <details><summary>{{ t('stress.failureKinds') }} / {{ t('stress.violations') }}</summary>
      <div class="failure-counts"><span v-for="(count,kind) in v2.failures" :key="kind">{{ code(String(kind)) }}: {{ count }}</span></div>
      <p v-for="(count,kind) in v2.errorKinds" :key="kind">{{ String(kind) }}: {{ count }}</p>
      <div v-if="v2.verdict.violations.length" class="table-scroll" tabindex="0" :aria-label="t('stress.violations')"><table><thead><tr><th>{{t('stress.metricName')}}</th><th>{{t('stress.actual')}}</th><th>{{t('stress.expected')}}</th><th>{{t('stress.detail')}}</th></tr></thead><tbody><tr v-for="(violation,index) in v2.verdict.violations" :key="index"><td>{{metricName(violation.metric)}}</td><td>{{thresholdValue(violation.metric,violation.actual)}}</td><td>{{thresholdValue(violation.metric,violation.expected)}}</td><td class="business-id">{{violation.message}}</td></tr></tbody></table></div>
    </details>
    <details><summary>{{ t('stress.safety') }}</summary><p>{{ v2.safety ? code(v2.safety.availability) : t('stress.workbench.notCollected') }}</p><p v-for="row in v2.safety?.targetOrigins" :key="row.origin">{{ row.origin }} · {{ safetyDecision(row.confirmation) }} · {{ safetyDecision(row.policy) }}</p></details>
    <details data-testid="stress-evidence"><summary>{{t('stressReportUi.evidence')}}<span v-if="evidenceItems"> ({{evidenceItems.length}})</span></summary><p>{{t('stressReportUi.evidenceHint')}}</p><p v-if="!evidenceItems">{{t('stressPresentation.notCollected')}}</p><p v-else-if="!evidenceItems.length">{{t('stressReportUi.noEvidence')}}</p><CaseEvidencePanel v-for="(evidence,index) in evidenceItems" :key="index" :evidence="evidence" /></details>
  </section>
  <section v-else-if="report" class="stress-report" data-testid="stress-report">
    <button v-if="ai && source && reportRef" data-testid="ai-analyze-report" :disabled="ai.suggestLoading" @click="analyzeReport">{{ t('ai.analyzeReport') }}</button>
    <p class="legacy-note">{{ t('stress.workbench.legacy') }}</p>
    <details data-testid="stress-evidence"><summary>{{t('stressReportUi.evidence')}}<span v-if="evidenceItems"> ({{evidenceItems.length}})</span></summary><p>{{t('stressReportUi.evidenceHint')}}</p><p v-if="!evidenceItems">{{t('stressPresentation.notCollected')}}</p><p v-else-if="!evidenceItems.length">{{t('stressReportUi.noEvidence')}}</p><CaseEvidencePanel v-for="(evidence,index) in evidenceItems" :key="index" :evidence="evidence" /></details>
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
          <strong class="business-id">{{row.origin}}</strong><p>{{safetyDecision(row.confirmation)}} · {{safetyDecision(row.policy)}} · {{t('stressReportUi.loopback')}}: {{row.loopback === undefined ? t('stressPresentation.notCollected') : t(row.loopback ? 'stressReportUi.yes' : 'stressReportUi.no')}}</p>
          <dl v-if="row.appliedPolicy" class="field-grid">
            <div><dt>{{t('stressReportUi.trusted')}}</dt><dd>{{row.appliedPolicy.trustedOrigins === undefined ? t('stressPresentation.notCollected') : row.appliedPolicy.trustedOrigins.join(', ') || t('stressPresentation.none')}}</dd></div>
            <div><dt>{{t('stressReportUi.denied')}}</dt><dd>{{row.appliedPolicy.deniedOrigins === undefined ? t('stressPresentation.notCollected') : row.appliedPolicy.deniedOrigins.join(', ') || t('stressPresentation.none')}}</dd></div>
            <div v-if="row.appliedPolicy.maxConcurrency !== undefined"><dt>{{t('stressReportUi.policyConcurrency')}}</dt><dd>{{row.appliedPolicy.maxConcurrency}}</dd></div>
            <div v-if="row.appliedPolicy.maxRps !== undefined"><dt>{{t('stress.maxRps')}}</dt><dd>{{optionalRps(row.appliedPolicy.maxRps)}}</dd></div>
          </dl>
        </li>
      </ul>
      <div v-if="safetyRun" data-testid="stress-safety-run"><h4>{{ t("stress.safetyRun") }}</h4><dl class="field-grid">
        <div><dt>{{t('stressReportUi.requestedConcurrency')}}</dt><dd>{{safetyRun.requestedConcurrency}}</dd></div><div><dt>{{t('stressReportUi.effectiveConcurrency')}}</dt><dd>{{safetyRun.effectiveConcurrency}}</dd></div>
        <div><dt>{{t('stressReportUi.requestedRps')}}</dt><dd>{{optionalRps(safetyRun.requestedMaxRps)}}</dd></div><div><dt>{{t('stressReportUi.effectiveRps')}}</dt><dd>{{optionalRps(safetyRun.effectiveMaxRps)}}</dd></div>
        <div><dt>{{t('stressReportUi.connectionMode')}}</dt><dd>{{t(safetyRun.connectionMode === 'pooled' ? 'stressReportUi.pooled' : 'stressReportUi.fresh')}}</dd></div>
      </dl></div>
    </div>
    <div class="generator" data-testid="stress-generator">
      <h4 class="block-title">{{ t("stress.generator") }}</h4>
      <span v-if="!generator || generator.availability === 'unavailable'">{{ generator?.unavailableReason ?? t("stress.generatorUnavailable") }}</span>
      <span v-else>{{ generator.availability === 'partial' ? `${t("stress.generatorPartial")} · ` : "" }}CPU {{ generator.cpuPercent ?? '—' }}% · RSS {{generator.rssPeakBytes == null ? t('stressPresentation.notCollected') : fmtRps(generator.rssPeakBytes / 1048576) + ' MiB'}} · {{t('stressPresentation.eventLoop')}} {{ generator.eventLoopDelayP95Ms ?? '—' }} ms · {{t('stressPresentation.backlog')}} {{ generator.schedulerBacklogMax ?? '—' }}</span>
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
  gap: 14px;
  margin-top: 4px;
}
.stress-report { min-width: 0; color: var(--text); font-size: 13px; line-height: 1.65; }
.stress-report p { margin: 6px 0; }
.stress-report h4 { margin: 0 0 8px; font-size: 13px; font-weight: 650; }
.identity { overflow-wrap: anywhere; color: var(--text-muted); font-size: 12px; }
.report-heading { padding: 18px 20px; background: var(--subtle); border: 1px solid var(--border); border-radius: 10px; }
.report-heading .verdict { font-size: 20px; margin-bottom: 8px; }
.report-heading time { display: inline-block; color: var(--text-muted); font-size: 12px; }
.population-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.population-card, .fact-section { padding: 16px 18px; border: 1px solid var(--border); border-radius: 9px; background: var(--bg); }
.population-card { border-top: 3px solid var(--accent); }
.population-card p, .fact-section p { font-size: 12px; }
.population-lead strong { display: inline-block; margin-right: 8px; font-size: 27px; line-height: 1.4; color: var(--text); font-variant-numeric: tabular-nums; }
.population-note, .legacy-note, .empty-note { color: var(--text-muted); font-size: 12px; }
.completeness { display: flex; flex-wrap: wrap; gap: 4px 20px; border: 1px solid var(--border); padding: 8px 14px; border-radius: 8px; background: var(--subtle); }
.stress-report > details { min-width: 0; border: 1px solid var(--border); border-radius: 9px; padding: 12px 16px; background: var(--bg); }
.stress-report summary { cursor: pointer; font-weight: 600; overflow-wrap: anywhere; }
.stress-report > details[open] > summary { margin-bottom: 12px; }
.table-scroll { max-height: 340px; overflow: auto; border: 1px solid var(--border); border-radius: 6px; scrollbar-gutter: stable; }
.table-scroll:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
table { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 12px; font-variant-numeric: tabular-nums; }
td, th { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); white-space: nowrap; vertical-align: top; }
th { position: sticky; top: 0; background: var(--subtle); z-index: 1; font-weight: 600; }
tbody tr:last-child td { border-bottom: 0; }
.business-id { min-width: 160px; max-width: 320px; white-space: normal; overflow-wrap: anywhere; }
.field-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px 20px; margin: 12px 0; }
.field-grid dt { color: var(--text-muted); font-size: 12px; }
.field-grid dd { margin: 2px 0 0; overflow-wrap: anywhere; }
.failure-counts { display: flex; flex-wrap: wrap; gap: 8px 20px; }
.safety ul { padding-left: 20px; }
.safety li { margin: 12px 0; }
.safety, .generator, .violations { padding: 14px; border: 1px solid var(--border); border-radius: 8px; min-width: 0; overflow: auto; }
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
@media (max-width: 760px) {
  .population-grid { grid-template-columns: minmax(0, 1fr); }
  .dist { flex-direction: column; }
  .report-heading, .population-card, .fact-section, .stress-report > details { padding: 12px; }
}
</style>

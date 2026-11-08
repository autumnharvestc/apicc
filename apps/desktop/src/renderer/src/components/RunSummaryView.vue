<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { RunResult } from '@apicc/core';
import { reportingUnits } from '@apicc/core/report/units';

const props = defineProps<{ result: RunResult }>();
const { t, te } = useI18n();
const units = computed(() => reportingUnits(props.result).summary);
const counts = (value: { total: number; passed: number; failed: number; skipped?: number }) => t('run.summary', { ...value, skipped: value.skipped ?? 0 });
function label(code?: string, group = 'executionLabels') {
  if (!code) return '—';
  const key = `${group}.${code}`;
  return te(key) ? t(key) : code;
}
</script>

<template>
  <div class="run-overview">
    <header class="overview-heading">
      <h3>{{ t('reportPresentation.overview') }}</h3>
      <span v-if="result.reportingMode" class="mode">{{ label(result.reportingMode) }}</span>
    </header>
    <div class="population-cards">
      <section class="population-card" data-testid="run-logical-summary">
        <h4>{{ t('reportPresentation.logical') }}</h4>
        <p class="count" :class="{ failed: units.failed > 0 }">{{ units.total }}</p>
        <p>{{ counts(units) }}</p>
        <span class="muted">{{ t('reportPresentation.diagnostics', { count: units.entryDiagnostics }) }}</span>
      </section>
      <section class="population-card" data-testid="run-raw-summary">
        <h4>{{ t('reportPresentation.raw') }}</h4>
        <p class="count">{{ result.total }}</p>
        <p>{{ counts(result) }}</p>
        <span class="muted">{{ t('reportPresentation.populationHint') }}</span>
      </section>
    </div>
    <p v-if="result.requestFacts" class="muted">{{ t('reportPresentation.requestFacts', { ...result.requestFacts }) }}</p>
    <p v-if="result.reportFailure || result.evidenceOmitted" class="notice" data-testid="run-report-limit">{{ t('reportPresentation.incomplete') }}</p>
    <details v-if="result.workflow" open class="entry-section">
      <summary>{{ t('reportPresentation.workflow') }} <span class="muted">{{ counts(result.workflow) }}</span></summary>
      <p v-if="result.workflow.verdict">{{ t('run.result') }}: {{ label(result.workflow.verdict) }}</p>
      <div v-if="result.workflow.entries.length" class="table-scroll" tabindex="0" :aria-label="t('reportPresentation.workflow')">
        <table data-testid="run-workflow-entries">
          <thead><tr><th>{{ t('caseEvidence.node') }}</th><th>{{ t('reportPresentation.kind') }}</th><th>{{ t('run.row') }}</th><th>{{ t('run.result') }}</th><th>{{ t('reportPresentation.reason') }}</th></tr></thead>
          <tbody><tr v-for="(entry, index) in result.workflow.entries" :key="index">
            <td><strong>{{ entry.label || entry.entryId }}</strong><span v-if="entry.label" class="identifier">{{ entry.entryId }}</span><span class="identifier">{{ entry.workflowId }}</span></td>
            <td>{{ label(entry.nodeKind, 'wf.control.kinds') }}</td><td>{{ entry.suiteRow === undefined ? '—' : entry.suiteRow + 1 }}</td>
            <td><span class="status" :class="{ failed: entry.status === 'failed' }">{{ label(entry.state ?? entry.status) }}</span></td>
            <td><p v-if="entry.error" class="business-text">{{ entry.error }}</p><p v-if="entry.skipReason">{{ label(entry.skipReason) }}</p><p v-if="entry.failureKind">{{ label(entry.failureKind) }}</p><span v-if="!entry.error && !entry.skipReason && !entry.failureKind">—</span></td>
          </tr></tbody>
        </table>
      </div>
      <p v-else class="muted">{{ t('reportPresentation.noDetails') }}</p>
    </details>
    <details v-if="result.suite" open class="entry-section">
      <summary>{{ t('reportPresentation.suite') }} <span class="muted">{{ counts(result.suite) }} · {{ label(result.suite.verdict) }}</span></summary>
      <div v-if="result.suite.entries?.length" class="table-scroll" tabindex="0" :aria-label="t('reportPresentation.suite')">
        <table data-testid="run-suite-entries">
          <thead><tr><th>{{ t('caseEvidence.entry') }}</th><th>{{ t('run.row') }}</th><th>{{ t('reportPresentation.kind') }}</th><th>{{ t('run.result') }}</th><th>{{ t('reportPresentation.reason') }}</th></tr></thead>
          <tbody><tr v-for="(entry, index) in result.suite.entries" :key="index">
            <td>{{ entry.entryId }}<span v-if="entry.workflowId" class="identifier">{{ entry.workflowId }}</span></td><td>{{ entry.suiteRow === undefined ? '—' : entry.suiteRow + 1 }}</td>
            <td>{{ t(entry.kind === 'workflow' ? 'reportPresentation.workflowKind' : 'run.case') }}</td><td>{{ label(entry.status) }}</td>
            <td><p v-if="entry.error" class="business-text">{{ entry.error }}</p><p v-if="entry.skipReason">{{ label(entry.skipReason) }}</p><span v-if="!entry.error && !entry.skipReason">—</span></td>
          </tr></tbody>
        </table>
      </div>
      <p v-else class="muted">{{ t('reportPresentation.noDetails') }}</p>
    </details>
    <ul v-if="result.warnings?.length" class="notices"><li v-for="(warning, index) in result.warnings" :key="index">{{ warning }}</li></ul>
  </div>
</template>

<style scoped>
.run-overview { color: var(--text); min-width: 0; }
.overview-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 16px; margin: 4px 0 12px; }
h3,h4,p { margin: 0; } h3 { font-size: 16px; } h4 { font-size: 13px; font-weight: 600; }
.mode,.muted,.identifier { color: var(--text-muted); font-size: 12px; }
.mode { background: var(--panel); border-radius: 6px; padding: 4px 8px; }
.population-cards { display: grid; grid-template-columns: repeat(auto-fit,minmax(min(100%,260px),1fr)); gap: 12px; }
.population-card { padding: 16px; border: 1px solid var(--border); border-radius: 10px; background: var(--subtle); display: flex; flex-direction: column; gap: 8px; }
.count { font-size: 28px; font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1.15; }
.failed { color: var(--fail); }.notice,.notices { padding: 10px 14px; border-left: 3px solid var(--accent); background: var(--panel); margin: 12px 0; overflow-wrap: anywhere; }
.notices { padding-left: 30px; }.run-overview > p { margin-top: 12px; }
.entry-section { margin-top: 14px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
summary { padding: 12px; cursor: pointer; font-weight: 600; background: var(--subtle); } summary .muted { font-weight: 400; margin-left: 12px; }
.entry-section > p { padding: 8px 12px; }.table-scroll { overflow: auto; max-height: 360px; }
table { width: 100%; border-collapse: collapse; min-width: 640px; text-align: left; }
th,td { padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { white-space: nowrap; position: sticky; top: 0; background: var(--panel); z-index: 1; font-weight: 600; }
td { max-width: 360px; overflow-wrap: anywhere; } td p + p { margin-top: 4px; }.identifier { display: block; margin-top: 4px; }.business-text { white-space: pre-wrap; }
</style>

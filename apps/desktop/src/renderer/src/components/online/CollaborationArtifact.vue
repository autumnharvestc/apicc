<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { PublicArtifactDto } from '@apicc/core/collaboration';
import { countLabels } from './collaborationPresentation.js';
defineProps<{ artifact: PublicArtifactDto }>();
const { t, te } = useI18n();
const label = (code: string) => te(`collaboration.contentCodes.${code}`) ? t(`collaboration.contentCodes.${code}`) : te(`collaboration.codes.${code}`) ? t(`collaboration.codes.${code}`) : code;
</script>
<template>
  <section v-if="artifact.document"><h4>{{ t('collaboration.documentContent') }}</h4><article v-for="api in artifact.document.apis" :key="api.id"><h5>{{ api.name }} · {{ api.request.method }} {{ api.request.path }}</h5><p>{{ api.collection }} / {{ api.folders.join(' / ') }} · {{ api.description }}</p><dl><template v-for="parameter in api.request.parameters" :key="parameter.id"><dt>{{ parameter.location }} · {{ parameter.name }}</dt><dd>{{ parameter.description }} {{ parameter.value }}</dd></template></dl><ul><li v-for="response in api.responses" :key="response.id">{{ response.status }} · {{ response.description }}</li></ul></article><ul><li v-for="model in artifact.document.models" :key="model.id">{{ model.name }} · {{ model.description }}</li></ul></section>
  <ul class="limitations"><li v-for="(item,index) in artifact.limitations" :key="index">{{ label(item.code) }} · {{ item.path }}</li></ul>
  <section v-if="artifact.report" class="report-facts">
    <h4>{{ t('collaboration.reportFacts') }}</h4><p>{{ t('collaboration.conclusion') }}: {{ label(artifact.report.verdict) }} · {{ t('collaboration.populationHint') }}</p>
    <p v-for="(row,index) in artifact.summary.filter(row => row.labelCode === 'report.failure')" :key="index">{{ t('collaboration.failureDiagnostic') }}: {{ row.value }}</p>
    <div class="table-scroll"><table data-testid="artifact-counts"><thead><tr><th>{{ t('collaboration.population') }}</th><th>{{ t('collaboration.total') }}</th><th>{{ t('collaboration.passed') }}</th><th>{{ t('collaboration.failed') }}</th></tr></thead><tbody><tr v-for="(row,index) in artifact.report.counts" :key="index"><th>{{ countLabels[row.labelCode] ? t('collaboration.' + countLabels[row.labelCode]) : row.labelCode }}</th><td>{{ row.total }}</td><td>{{ row.passed ?? t('collaboration.notCollected') }}</td><td>{{ row.failed ?? t('collaboration.notCollected') }}</td></tr></tbody></table></div>
    <h4>{{ t('collaboration.originalFailures') }}</h4><ul><li v-for="row in artifact.report.failures" :key="row.category">{{ label(row.category) }} ({{ row.category }}) · {{ row.count }}</li></ul>
    <h4>{{ t('collaboration.trace') }}</h4><ol><li v-for="(event,index) in artifact.report.trace" :key="index">{{ event.nodeId }} · {{ label(event.type) }} · {{ event.state ? label(event.state) : '' }} · {{ event.message }} <span v-if="event.delayMs !== undefined">{{ event.delayMs }} ms</span></li></ol>
    <h4>{{ t('collaboration.evidenceStatus') }}</h4><ul><li v-for="(row,index) in artifact.report.evidence" :key="index">{{ row.nodeId }} · {{ label(row.status) }}</li></ul>
    <div class="table-scroll"><table><thead><tr><th>{{ t('collaboration.node') }}</th><th>{{ t('collaboration.state') }}</th><th>{{ t('collaboration.originalFailure') }}</th></tr></thead><tbody><tr v-for="row in artifact.report.nodes" :key="row.id"><td>{{ row.name }}</td><td>{{ label(row.state) }}</td><td>{{ row.message ?? t('collaboration.notCollected') }}</td></tr></tbody></table></div>
  </section>
</template>
<style scoped>.table-scroll{overflow:auto;max-height:24rem}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:7px;border-bottom:1px solid var(--border);overflow-wrap:anywhere}th{white-space:nowrap}</style>

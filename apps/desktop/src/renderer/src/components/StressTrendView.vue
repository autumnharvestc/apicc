<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { StressReportV2 } from "@apicc/core";
const props = defineProps<{ timeline: StressReportV2["timeline"]; phases: StressReportV2["phases"] }>();
const { t,te } = useI18n();
const code=(value:string)=>te(`stressFinal.codes.${value}`)?t(`stressFinal.codes.${value}`):te(`stressPresentation.codes.${value}`)?t(`stressPresentation.codes.${value}`):value;
const buckets = computed(() => props.timeline.buckets.slice(0, 120));
const extent = computed(() => Math.max(1, ...buckets.value.map(b => b.endOffsetMs)));
const x = (ms: number) => 48 + 710 * ms / extent.value;
const charts = computed(() => (["rps", "p95"] as const).map(kind => {
  const values = buckets.value.map(b => kind === "rps" ? b.rps.availability === "available" ? b.rps.value : null : b.latency.availability === "available" ? b.latency.value.p95 : null);
  const max = Math.max(1, ...values.filter((v): v is number => v !== null));
  const segments: string[] = []; let path = "";
  buckets.value.forEach((b, index) => {
    const value = values[index];
    if (value === null || value === undefined) { if (path) segments.push(path); path = ""; return; }
    if(index>0 && buckets.value[index-1]!.endOffsetMs !== b.startOffsetMs){if(path)segments.push(path);path='';}
    const px = x((b.startOffsetMs + b.endOffsetMs) / 2), py = 120 - 100 * value / max;
    path += `${path ? " L" : "M"}${px.toFixed(2)},${py.toFixed(2)}`;
  });
  if (path) segments.push(path);
  const points = buckets.value.flatMap((b,index) => { const value = values[index]; return value === null || value === undefined ? [] : [{ x: x((b.startOffsetMs + b.endOffsetMs) / 2), y: 120 - 100 * value / max, value, start: b.startOffsetMs, end: b.endOffsetMs }]; });
  return { kind, max, segments, points };
}));
const phases = computed(() => props.phases.slice(0, 69));
const sources = (b: StressReportV2["timeline"]["buckets"][number]) => b.sources.map(s => `${code(s.phase)}${s.stageId === null ? "" : ` / ${s.stageId}`}`).join(", ");
</script>
<template>
  <section class="trend" data-testid="stress-trend">
    <h4>{{ t('stress.workbench.trend') }}</h4>
    <p>{{ t('stress.workbench.bucketWidth') }} {{ timeline.bucketWidthMs }} ms · {{ t('stress.workbench.uncertainty') }} {{ timeline.uncertaintyMs }} ms · {{ t(timeline.aligned ? 'stress.workbench.aligned' : 'stress.workbench.unaligned') }}</p>
    <p v-if="!buckets.length">{{ t('stressPresentation.zeroBuckets') }}</p>
    <p v-if="buckets.length===1">{{t('stressPresentation.singleBucket')}}</p>
    <p v-if="!timeline.aligned">{{t('stressPresentation.unknownClock')}}</p>
    <figure v-for="chart in buckets.length ? charts : []" :key="chart.kind">
      <figcaption>{{ chart.kind === 'rps' ? t('stress.workbench.httpRps') : t('stress.workbench.httpP95') }}</figcaption>
      <svg viewBox="0 0 800 155" role="img" :aria-label="chart.kind === 'rps' ? t('stress.workbench.httpRps') : t('stress.workbench.httpP95')">
        <path d="M48,20 V120 H758" class="axis" />
        <text x="0" y="24">{{ Math.round(chart.max * 100) / 100 }}</text><text x="24" y="122">0</text>
        <text x="48" y="148">0 ms</text><text x="680" y="148">{{ extent }} ms</text>
        <g v-for="(phase,index) in phases" :key="index"><line v-if="phase.startOffsetMs !== null" :x1="x(phase.startOffsetMs)" y1="20" :x2="x(phase.startOffsetMs)" y2="120" class="phase"><title>{{ code(phase.phase) }} / {{ phase.stageId ?? '—' }}</title></line></g>
        <path v-for="(segment,index) in chart.segments" :key="index" :d="segment" class="series" />
        <circle v-for="(point,index) in chart.points" :key="index" :cx="point.x" :cy="point.y" r="2.5" fill="var(--primary,#1677ff)"><title>{{ point.start }}–{{ point.end }} ms: {{ point.value }}</title></circle>
      </svg>
    </figure>
    <details><summary>{{ t('stress.workbench.buckets') }} ({{ buckets.length }})</summary><div class="table-scroll"><table><thead><tr><th>ms</th><th>{{ t('stress.workbench.phase') }}</th><th>{{ t('stress.workbench.httpRps') }}</th><th>p95 ms</th><th>{{ t('stress.workbench.requestFailures') }}</th></tr></thead><tbody><tr v-for="b in buckets" :key="b.startOffsetMs"><td>{{ b.startOffsetMs }}–{{ b.endOffsetMs }}</td><td>{{ sources(b) }}</td><td>{{ b.rps.availability === 'available' ? b.rps.value.toFixed(2) : t('stress.workbench.notCollected') }}</td><td>{{ b.latency.availability === 'available' ? b.latency.value.p95.toFixed(2) : t('stress.workbench.notCollected') }}</td><td>{{ b.requests.failed }}</td></tr></tbody></table></div></details>
    <div class="phase-legend"><span v-for="(phase,index) in phases" :key="index">{{ code(phase.phase) }} / {{ phase.stageId ?? '—' }}: {{ phase.startOffsetMs ?? '—' }}–{{ phase.endOffsetMs ?? '—' }} ms</span></div>
    <details><summary>{{ t('stress.workbench.phase') }}</summary><div class="table-scroll"><table><thead><tr><th>{{ t('stress.workbench.phase') }}</th><th>ms</th><th>{{ t('stress.workbench.httpRps') }}</th><th>{{ t('stress.workbench.requests') }}</th><th>p95 ms</th></tr></thead><tbody><tr v-for="(phase,index) in phases" :key="index"><td>{{ code(phase.phase) }} / {{ phase.stageId ?? '—' }}</td><td>{{ phase.durationMs === null ? '—' : Number(phase.durationMs.toFixed(2)) }}</td><td>{{ phase.rps.availability === 'available' ? phase.rps.value.toFixed(2) : code(phase.rps.reason) }}</td><td>{{ phase.requests.eligibleCompleted }} / {{ phase.requests.failed }}</td><td>{{ phase.latency.availability === 'available' ? phase.latency.value.p95.toFixed(2) : code(phase.latency.reason) }}</td></tr></tbody></table></div></details>
  </section>
</template>
<style scoped>
.trend { min-width: 0; } h4,p,figure { margin: 6px 0; } svg { width: 100%; max-height: 180px; display: block; } .axis { fill:none;stroke:var(--border,#aaa); } .series { fill:none;stroke:var(--primary,#1677ff);stroke-width:2;stroke-linecap:round; } .phase { stroke:var(--text-muted,#888);stroke-dasharray:3 4;opacity:.5; } text { font-size:11px;fill:var(--text-muted,#666); } .phase-legend { display:flex;gap:8px;flex-wrap:wrap;font-size:11px; } .table-scroll { overflow:auto;max-height:260px; } table { border-collapse:collapse;width:100%;font-size:12px; } th,td { text-align:left;padding:5px;border-bottom:1px solid var(--border,#ddd);white-space:nowrap; }
</style>

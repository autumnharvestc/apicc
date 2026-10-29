<script setup lang="ts">
import {useI18n} from 'vue-i18n';
import type {StressExecutionSummary} from '@apicc/core';
import {stressProcessObservationText,stressContentionHintText} from '@apicc/core/stress/html';
defineProps<{execution:StressExecutionSummary}>();
const {t,te,locale}=useI18n();
const state=(code:string)=>te(`stressPresentation.states.${code}`)?t(`stressPresentation.states.${code}`):code;
const short=(value:string)=>value.length>12?`${value.slice(0,8)}…${value.slice(-4)}`:value;
</script>
<template>
  <section class="execution-summary" data-testid="stress-execution-summary">
    <p>{{t('stressPresentation.location')}}: {{t(execution.location==='local'?'onlineExecution.local':'onlineExecution.agent')}} · {{t('stressPresentation.executor')}}: {{execution.executorName || execution.executorId}}</p>
    <p>{{t('stressPresentation.workers')}}: {{execution.workerCount}} worker · {{t('stressPresentation.processBudget')}}: {{execution.processBudget}} {{t('stressPresentation.processUnit')}}</p>
    <p>{{stressProcessObservationText(execution.processObservation,locale)}}</p><p>{{t('stressPresentation.recordedSources')}}</p>
    <p>Node {{execution.runtime.nodeVersion}} · V8 {{execution.runtime.v8Version}}</p>
    <details v-for="(value,key) in {Core:execution.runtime.coreBuildId,[t('stressPresentation.scriptApi')]:execution.runtime.scriptApiId,[t('stressPresentation.compatibility')]:execution.runtime.runtimeCompatibilityId}" :key="key"><summary>{{key}} · {{short(value)}}</summary><code>{{value}}</code></details>
    <div v-if="execution.reservation" class="table-scroll"><table><thead><tr><th>{{t('stressPresentation.field')}}</th><th>{{t('stressPresentation.jobs')}}</th><th>{{t('stressPresentation.processUnit')}}</th><th>VU</th><th>{{t('stressPresentation.requestConcurrency')}}</th><th>{{t('stressPresentation.rps')}}</th><th>{{t('stressPresentation.memory')}}</th></tr></thead><tbody><tr v-for="(vector,key) in {requested:execution.requestedReservation,effective:execution.reservation}" :key="key"><template v-if="vector"><th>{{t(`stressPresentation.${key}`)}}</th><td>{{vector.jobs}}</td><td>{{vector.processes}}</td><td>{{vector.vus}} VU</td><td>{{vector.requestConcurrency}} {{t('stressPresentation.requestUnit')}}</td><td>{{vector.maxRps}} {{t('stressPresentation.rpsUnit')}}</td><td>{{vector.metricMemoryBytes/1048576}} MiB</td></template></tr></tbody></table></div>
    <p>{{t('stressPresentation.budgetHint')}}</p>
    <p v-if="execution.status"><span v-for="(value,key) in execution.status" :key="key">{{t(`stressPresentation.${key}`)}}: {{state(value)}} · </span></p>
    <ul v-if="execution.contentionHints?.length"><li v-for="(hint,index) in execution.contentionHints" :key="index">{{stressContentionHintText(hint,locale)}}</li></ul>
  </section>
</template>
<style scoped>.execution-summary{min-width:0}p{overflow-wrap:anywhere}.table-scroll{overflow:auto;max-height:240px}table{border-collapse:collapse;white-space:nowrap;width:100%}th,td{text-align:left;padding:6px;border-bottom:1px solid var(--border,#ddd)}code{overflow-wrap:anywhere}details{margin:4px 0}</style>

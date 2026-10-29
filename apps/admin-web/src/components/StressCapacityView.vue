<script setup lang="ts">
import {useI18n} from 'vue-i18n';
import type {ProjectExecutionAgents} from '../api/agents.js';
defineProps<{capacity:NonNullable<ProjectExecutionAgents['agents'][number]['stressCapacity']>}>();
const {t}=useI18n();
const dimensions=['jobs','processes','vus','requestConcurrency','maxRps','metricMemoryBytes'] as const;
const value=(dimension:string,n:number)=>dimension==='metricMemoryBytes'?Number((n/1048576).toFixed(2)):n;
</script>
<template>
  <section data-testid="stress-capacity" class="stress-capacity">
    <h4>{{t('stressCapacity.title')}}</h4><p v-if="capacity.drainingDimensions.length">{{t('stressCapacity.draining')}} · {{t('stressCapacity.drainHint')}}</p>
    <div class="table-scroll"><table><thead><tr><th>{{t('stressCapacity.dimension')}}</th><th>{{t('stressCapacity.quantity')}}</th><th>{{t('stressCapacity.state')}}</th></tr></thead><tbody><tr v-for="dimension in dimensions" :key="dimension"><th>{{t(`stressCapacity.dimensions.${dimension}`)}}</th><td>{{value(dimension,capacity.used[dimension])}} / {{value(dimension,capacity.limits[dimension])}} {{t(`stressCapacity.units.${dimension}`)}}</td><td>{{t(capacity.drainingDimensions.includes(dimension)?'stressCapacity.draining':'stressCapacity.within')}}</td></tr></tbody></table></div>
  </section>
</template>
<style scoped>.stress-capacity{min-width:0}.table-scroll{overflow:auto}table{width:100%;border-collapse:collapse;white-space:nowrap}th,td{text-align:left;padding:6px;border-bottom:1px solid var(--border,#ddd)}</style>

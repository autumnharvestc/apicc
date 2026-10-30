<script setup lang="ts">
import {watch,onBeforeUnmount} from 'vue';
import {useI18n} from 'vue-i18n';
import type {SchedulingStore} from '../stores/scheduling.js';
const props=defineProps<{scheduling:SchedulingStore;workspaceId:string;projectId:string}>();const {t}=useI18n();
watch(()=>[props.workspaceId,props.projectId],()=>void props.scheduling.loadGrantOptions(props.workspaceId,props.projectId),{immediate:true});
onBeforeUnmount(()=>props.scheduling.reset());
</script>
<template>
  <section class="schedule-grants" data-testid="project-schedule-grants-view">
    <h2>{{t('scheduling.grantsTitle')}}</h2><p>{{t('scheduling.grantsHelp')}}</p>
    <p v-if="scheduling.error" role="alert">{{scheduling.error==='schedule-grant-ineligible'?t('scheduling.grantChanged'):t('scheduling.errors.'+(['forbidden','project_forbidden','version_conflict','unauthorized'].includes(scheduling.error)?scheduling.error:'other'))}} ({{scheduling.error}})</p>
    <button v-if="scheduling.conflict||scheduling.error==='schedule-grant-ineligible'" type="button" data-testid="grant-reload" @click="scheduling.loadGrantOptions(workspaceId,projectId,true)">{{t('scheduling.reload')}}</button>
    <p v-if="scheduling.grantOptions&&scheduling.invalidGrantIds().length" role="status">{{t('scheduling.invalidGrantDraft')}}<button type="button" data-testid="grant-clear-ineligible" @click="scheduling.clearInvalidGrants()">{{t('scheduling.clearInvalidGrants')}}</button></p>
    <p v-if="scheduling.grants">{{t('scheduling.version')}}: {{scheduling.grants.version}}</p>
    <div v-if="scheduling.grantOptions&&scheduling.grants" class="table-scroll"><table>
      <thead><tr><th>{{t('scheduling.member')}}</th><th>{{t('scheduling.effectiveRole')}}</th><th>{{t('scheduling.eligibility')}}</th><th>{{t('scheduling.safeReasons')}}</th><th>{{t('scheduling.explicitGrant')}}</th></tr></thead>
      <tbody><tr v-for="row in scheduling.grantOptions.items" :key="row.userId" :data-testid="`grant-row-${row.userId}`"><th><span class="member-name" :title="row.displayName">{{row.displayName}}</span><small :title="row.username">{{row.username}} · {{row.userId}}</small></th><td>{{t(`scheduling.roles.${row.effectiveRole??'none'}`)}}</td><td>{{t(row.eligible?'scheduling.eligible':'scheduling.ineligible')}}</td><td class="reason">{{row.reasonCode==='editor-required'&&(row.effectiveRole==='OWNER'||row.effectiveRole==='ADMIN')?t('scheduling.implicitAdmin'):row.reasonCode?t(`scheduling.grantReasons.${row.reasonCode}`):t('scheduling.grantReasons.qualified')}}<small v-if="row.reasonCode">{{row.reasonCode}}</small></td><td><input v-model="scheduling.grantDraft" :value="row.userId" type="checkbox" :disabled="scheduling.busy||!row.eligible" :data-testid="`grant-select-${row.userId}`" :aria-label="t('scheduling.explicitGrant')+' '+row.displayName" /></td></tr></tbody>
    </table><p v-if="!scheduling.grantOptions.items.length">{{t('scheduling.noMembers')}}</p></div>
    <button v-if="scheduling.grants&&scheduling.grantOptions" type="button" data-testid="grant-save" :disabled="scheduling.busy||scheduling.conflict||scheduling.error==='schedule-grant-ineligible'||scheduling.invalidGrantIds().length>0" @click="scheduling.saveGrants(workspaceId,projectId)">{{t('scheduling.save')}}</button>
  </section>
</template>
<style scoped>
.schedule-grants{min-width:0}.table-scroll{max-width:100%;overflow-x:auto}table{border-collapse:collapse;min-width:900px;width:100%}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid #eee;white-space:nowrap}small{display:block;font-weight:400;color:#666}.member-name{display:block;max-width:260px;overflow:hidden;text-overflow:ellipsis}.reason{white-space:normal;min-width:280px;max-width:450px}p{overflow-wrap:anywhere}
</style>

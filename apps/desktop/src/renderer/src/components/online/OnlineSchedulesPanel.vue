<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useWorkbenchPosition } from "../../stores/workbenchPosition.js";
import { useI18n } from 'vue-i18n';
import { ScheduleRuleSchema, SchedulePoliciesSchema, RunConfigSchema, type ScheduleRule, type ScheduleUpdate } from '@apicc/execution/contract';
import type { OnlineExecutionStore } from '../../stores/onlineExecution.js';
import type { OnlineSchedulesStore } from '../../stores/onlineSchedules.js';
import type { OnlineSchedulePreparationInput } from '../../../../shared/online/scheduling.js';
import OnlineDeliveryList from './OnlineDeliveryList.vue';
import type { ScheduleOccurrence } from '@apicc/execution/contract';
const emit = defineEmits<{ report: [row: ScheduleOccurrence] }>();
const props = defineProps<{ execution: OnlineExecutionStore; schedules: OnlineSchedulesStore; draftDirty?: boolean }>();
const { t, te, locale } = useI18n();
const position = useWorkbenchPosition(() => JSON.stringify(props.execution.context));
const name = ref(''); const target = ref(''); const agentId = ref(''); const environmentId = ref('');
const jobSeconds = ref<number | string>(''); const scriptSeconds = ref<number | string>('');
const credentialModes = ref<Record<string, string>>({}); const fixedVersions = ref<Record<string, string>>({}); const deleteConfirmed = ref(false);
const ruleMode = ref('daily'); const zone = ref('Asia/Shanghai'); const hour = ref(9); const minute = ref(0); const weekday = ref('MON'); const cron = ref('0 0 9 * * *'); const atUtc = ref(''); const dstOverlap = ref<'first' | 'both'>('first');
const late = ref(10); const catchup = ref(300); const queue = ref(300); const misfire = ref<'skip' | 'catch-up-one'>('skip'); const overlap = ref<'skip' | 'queue-one'>('skip');
const inApp = ref(true); const eventKinds = ref<string[]>(['failed', 'abnormal', 'expired', 'paused']); const channelIds = ref<string[]>([]);
const riskConfirmed = ref(false); const subjectConfirmed = ref(false); const ruleTouched = ref(false);
const search = computed({get: () => position.value.scheduleSearch, set: value => {position.value.scheduleSearch = value;}});
const filter = computed({get: () => position.value.scheduleFilter, set: value => {position.value.scheduleFilter = value;}});
const planList = ref<HTMLElement>(), planBody = ref<HTMLElement>(), previewPanel = ref<HTMLElement>();
async function previewRule() {
  const owner = props.schedules.context, id = props.schedules.selected?.id;
  await action(() => props.schedules.preview(rule())); await nextTick();
  if (props.schedules.context === owner && props.schedules.selected?.id === id && props.schedules.previewResult) previewPanel.value?.scrollIntoView?.({block:"nearest"});
}
const searchInput = ref<HTMLInputElement>(), historyPanel = ref<HTMLElement>(), riskPanel = ref<HTMLDetailsElement>();
async function openHistory() {
  await props.schedules.loadHistory(); await nextTick();
  historyPanel.value?.scrollIntoView?.({block:"nearest"}); historyPanel.value?.focus({preventScroll:true});
}
function showEnable() { if (riskPanel.value) { riskPanel.value.open = true; riskPanel.value.scrollIntoView?.({block:"nearest"}); } }
function clearSearch() { search.value = ''; searchInput.value?.focus(); }
const code = (value: string | null | undefined) => {
  if (value === 'linked-record-unavailable') return t('workbenchPosition.unavailable');
  if (!value) return t('onlineExecution.notCollected');
  const safe = value.match(/(?:^|Error: )([a-z][a-z0-9_-]{0,95})$/)?.[1];
  if (!safe) return t('scheduleEditor.requestFailed');
  for (const namespace of ['scheduleCodes', 'onlineExecution.reasons', 'startRejectionLabels']) if (te(namespace + '.' + safe)) return t(namespace + '.' + safe);
  return safe;
};
const reasons = computed(() => [
  ...(props.execution.dirty || props.draftDirty ? ['draft'] : []),
  ...(props.execution.localOnlyRefIds.length ? ['local'] : []),
  ...(!agentId.value ? ['agent'] : []),
]);
const snapshotChanged = computed(() => {
  const saved = props.schedules.selected?.execution;
  if (!saved) return false;
  const originalTarget = saved.target.kind === "suite" ? "suite:" + saved.target.suiteId :
    saved.target.kind === "workflow" ? "workflow:" + saved.target.workflowId : "";
  const originals = saved.materials.credentials.filter(item => item.mode === "fixed-version").map(item => [item.refId,item.version]).sort();
  const fixed = Object.entries(credentialModes.value).filter(([,mode]) => mode === "fixed-version").map(([id]) => [id,fixedVersions.value[id] ?? props.schedules.materialOptions?.credentials.find(item => item.refId === id)?.version]).sort();
  return target.value !== originalTarget || agentId.value !== saved.agentId || environmentId.value !== (saved.environmentId ?? "")
    || (jobSeconds.value === "" ? undefined : Math.round(Number(jobSeconds.value)*1000)) !== saved.runConfig.jobTimeoutMs
    || (scriptSeconds.value === "" ? undefined : Math.round(Number(scriptSeconds.value)*1000)) !== saved.runConfig.scriptTimeoutMs
    || JSON.stringify(originals) !== JSON.stringify(fixed);
});
const canManage = computed(() => !!props.schedules.options?.canManageSchedules);
watch(() => props.schedules.options, options => { if (options && !props.schedules.selected) { late.value = options.policy.lateToleranceMs / 1000; catchup.value = options.policy.catchupWindowMs / 1000; queue.value = options.policy.queueTimeoutMs / 1000; misfire.value = options.policy.misfire; overlap.value = options.policy.overlap; } }, { immediate: true });
const items = computed(() => props.schedules.items.filter(item => (!search.value || item.name.toLowerCase().includes(search.value.toLowerCase())) && (filter.value === 'all' || item.enabled === (filter.value === 'enabled'))));
watch(() => [props.execution.context, props.execution.visible] as const, async ([context, visible], _, cleanup) => {
  if (!context || !visible) return;
  const saved = position.value.scheduleId, intent = props.schedules.navigationIntent;
  let live = true; cleanup(() => { live = false; });
  const listTop = position.value.scheduleListScroll, detailTop = position.value.scheduleDetailScroll;
  await props.schedules.load(context);
  if (live && saved && position.value.scheduleId === saved && !props.schedules.paneRequest && !props.schedules.returnTo
    && intent === props.schedules.navigationIntent && !props.schedules.selected) {
    await props.schedules.inspect(saved);
    if (live && position.value.scheduleId === saved && !props.schedules.selected) {
      position.value.scheduleId = ""; props.schedules.error = "linked-record-unavailable";
    }
  }
  await nextTick();
  if (live && position.value.scheduleId === saved) {
    if (planList.value) planList.value.scrollTop = listTop;
    if (planBody.value) planBody.value.scrollTop = detailTop;
  }
}, { immediate: true });
watch(() => props.schedules.selected, row => {
  riskConfirmed.value = false; subjectConfirmed.value = false; ruleTouched.value = false;
  deleteConfirmed.value = false;
  if (!row) { resetForm(); return; }
  position.value.scheduleId = row.id;
  name.value = row.name; const e = row.execution; target.value = e.target.kind === 'suite' ? 'suite:' + e.target.suiteId : e.target.kind === 'workflow' ? 'workflow:' + e.target.workflowId : ''; agentId.value = e.agentId; environmentId.value = e.environmentId ?? '';
  jobSeconds.value = e.runConfig.jobTimeoutMs === undefined ? '' : e.runConfig.jobTimeoutMs / 1000; scriptSeconds.value = e.runConfig.scriptTimeoutMs === undefined ? '' : e.runConfig.scriptTimeoutMs / 1000;
  credentialModes.value = Object.fromEntries(e.materials.credentials.map(binding => [binding.refId, binding.mode])); fixedVersions.value = Object.fromEntries(e.materials.credentials.filter(binding => binding.mode === 'fixed-version').map(binding => [binding.refId, binding.mode === 'fixed-version' ? binding.version : '']));
  zone.value = row.rule.timeZone;
  if (row.rule.kind === 'once') { ruleMode.value = 'once'; atUtc.value = row.rule.atUtc; } else {
    cron.value = row.rule.expression; dstOverlap.value = row.rule.dstOverlap;
    const basic = /^0 (\d|[1-5]\d) (\d|1\d|2[0-3]) \* \* (\*|MON|TUE|WED|THU|FRI|SAT|SUN)$/.exec(row.rule.expression.trim());
    ruleMode.value = basic ? basic[3] === "*" ? "daily" : "weekly" : "cron";
    if (basic) { minute.value = Number(basic[1]); hour.value = Number(basic[2]); if (basic[3] !== "*") weekday.value = basic[3]!; }
  }
  late.value = row.policies.lateToleranceMs / 1000; catchup.value = row.policies.catchupWindowMs / 1000; queue.value = row.policies.queueTimeoutMs / 1000; misfire.value = row.policies.misfire; overlap.value = row.policies.overlap;
  inApp.value = row.notifications.inApp; eventKinds.value = [...row.notifications.eventKinds]; channelIds.value = [...row.notifications.channelIds];
}, { immediate: true });
watch(() => [target.value, agentId.value, environmentId.value, jobSeconds.value, scriptSeconds.value, credentialModes.value, fixedVersions.value], () => { riskConfirmed.value = false; props.schedules.invalidateRefresh(); }, { deep: true });
const clockTime = computed({get: () => [hour.value,minute.value].map(value => String(value).padStart(2,"0")).join(":"),
  set: (value: string) => { const [h,m] = value.split(":").map(Number); hour.value = h!; minute.value = m!; }});
function ruleChanged() { ruleTouched.value = true; props.schedules.invalidatePreview(); }
function rule(): ScheduleRule {
  // Preserve untouched UTC nanoseconds; presentation never reconstructs an existing rule.
  if (props.schedules.selected && !ruleTouched.value) return props.schedules.selected.rule;
  return ScheduleRuleSchema.parse(ruleMode.value === 'once' ? { kind: 'once', atUtc: atUtc.value, timeZone: zone.value } : { kind: 'cron', expression: ruleMode.value === 'cron' ? cron.value : `0 ${minute.value} ${hour.value} * * ${ruleMode.value === 'weekly' ? weekday.value : '*'}`, timeZone: zone.value, dstOverlap: dstOverlap.value });
}
function policies() { return SchedulePoliciesSchema.parse({ lateToleranceMs: Math.round(late.value * 1000), catchupWindowMs: Math.round(catchup.value * 1000), queueTimeoutMs: Math.round(queue.value * 1000), misfire: misfire.value, overlap: overlap.value }); }
function notifications() { return { inApp: inApp.value, eventKinds: [...eventKinds.value] as Array<'failed' | 'abnormal' | 'expired' | 'paused' | 'succeeded' | 'skipped'>, channelIds: [...channelIds.value] }; }
function preparation(): OnlineSchedulePreparationInput {
  const e = props.execution; if (!e.context || !e.view) throw Error('online-project-unavailable');
  const [kind, id] = target.value.split(':');
  const { jobTimeoutMs: _job, scriptTimeoutMs: _script, ...previousSettings } = props.schedules.selected?.execution.runConfig ?? {};
  const runConfig = RunConfigSchema.parse({ ...previousSettings, ...(jobSeconds.value === '' ? {} : { jobTimeoutMs: Math.round(Number(jobSeconds.value) * 1000) }), ...(scriptSeconds.value === '' ? {} : { scriptTimeoutMs: Math.round(Number(scriptSeconds.value) * 1000) }) });
  const credentials = Object.entries(credentialModes.value).filter(([, mode]) => mode === 'fixed-version').map(([refId]) => ({ refId, mode: 'fixed-version' as const, version: fixedVersions.value[refId] ?? props.schedules.materialOptions?.credentials.find(ref => ref.refId === refId)?.version ?? '' }));
  return { context: e.context, expectedVersion: e.view.assets.version, agentId: agentId.value, target: kind === 'suite' ? { kind: 'suite', suiteId: id!, allowDraft: false } : { kind: 'workflow', workflowId: id! }, ...(environmentId.value ? { environmentId: environmentId.value } : {}), runConfig, materials: { projectId: e.context.scope.projectId, attachments: e.materials.attachments, attachmentPaths: e.materials.attachmentPaths }, credentialBindings: credentials, localOnlyRefIds: e.localOnlyRefIds, ...(props.schedules.selected?.execution.network ? { network: props.schedules.selected.execution.network } : {}) };
}
async function action(operation: () => Promise<unknown>) { try { await operation(); } catch (e) { props.schedules.error = e instanceof Error ? e.message : String(e); } }
async function save() {
  if (reasons.value.length || !name.value || !target.value || !canManage.value) return;
  await action(() => props.schedules.create({ name: name.value, rule: rule(), policies: policies(), notifications: notifications() }, preparation()));
}
async function update() {
  const row = props.schedules.selected; if (!row || snapshotChanged.value) return;
  const patch: Omit<ScheduleUpdate, 'expectedVersion'> = {};
  if (name.value !== row.name) patch.name = name.value;
  if (ruleTouched.value) patch.rule = rule();
  const p = policies(); if (JSON.stringify(p) !== JSON.stringify(row.policies)) patch.policies = p;
  const n = notifications(); if (JSON.stringify(n) !== JSON.stringify(row.notifications)) patch.notifications = n;
  await action(() => props.schedules.update(patch));
}
function resetForm() {
  name.value = ''; target.value = ''; agentId.value = ''; environmentId.value = ''; jobSeconds.value = ''; scriptSeconds.value = ''; credentialModes.value = {}; fixedVersions.value = {};
  ruleMode.value = 'daily'; zone.value = 'Asia/Shanghai'; hour.value = 9; minute.value = 0; weekday.value = 'MON'; cron.value = '0 0 9 * * *'; atUtc.value = ''; dstOverlap.value = 'first'; ruleTouched.value = false;
  const policy = props.schedules.options?.policy; late.value = (policy?.lateToleranceMs ?? 10000) / 1000; catchup.value = (policy?.catchupWindowMs ?? 300000) / 1000; queue.value = (policy?.queueTimeoutMs ?? 300000) / 1000; misfire.value = policy?.misfire ?? 'skip'; overlap.value = policy?.overlap ?? 'skip';
  inApp.value = true; eventKinds.value = ['failed', 'abnormal', 'expired', 'paused']; channelIds.value = []; riskConfirmed.value = false; subjectConfirmed.value = false; deleteConfirmed.value = false;
}
async function inspectSchedule(id: string) {
  if (position.value.scheduleId !== id && planBody.value) { position.value.scheduleDetailScroll = 0; planBody.value.scrollTop = 0; }
  position.value.scheduleId = id; await action(() => props.schedules.inspect(id));
}
function newSchedule() { position.value.scheduleDetailScroll = 0; if (planBody.value) planBody.value.scrollTop = 0; position.value.scheduleId = ""; props.schedules.clearSelection(); resetForm(); }
function short(value: string) { return value.length > 24 ? value.slice(0, 12) + '…' : value; }
function time(value: string | null) { if (!value) return t('onlineExecution.notCollected'); return new Intl.DateTimeFormat(locale.value, { timeZone: props.schedules.selected?.rule.timeZone ?? 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hourCycle: 'h23' }).format(new Date(value)) + ' ' + (props.schedules.selected?.rule.timeZone ?? 'Asia/Shanghai'); }
</script>
<template>
<section class="schedules online-surface">
  <div class="schedule-columns">
    <nav ref="planList" class="schedule-list" @scroll="position.scheduleListScroll = ($event.currentTarget as HTMLElement).scrollTop" :aria-label="t('scheduling.title')"><header class="schedule-toolbar"><input ref="searchInput" v-model="search" data-testid="schedule-search" :aria-label="t('scheduleEditor.search')" :placeholder="t('scheduleEditor.search')" /><button v-if="search" data-testid="schedule-clear-search" @click="clearSearch">{{ t('scheduleEditor.clearSearch') }}</button><select v-model="filter" data-testid="schedule-filter" :aria-label="t('scheduleEditor.filter')"><option value="all">{{ t('scheduleEditor.all') }}</option><option value="enabled">{{ t('scheduling.enabled') }}</option><option value="paused">{{ t('scheduling.paused') }}</option></select><button class="primary" :disabled="!canManage || schedules.busy" @click="newSchedule">{{ t('scheduleEditor.new') }}</button></header><p v-if="!items.length" class="empty-state">{{ t(search || filter !== 'all' ? 'scheduleEditor.noMatches' : 'scheduleEditor.empty') }}</p><ul><li v-for="item in items" :key="item.id"><button class="plan-row" data-testid="schedule-open" :aria-current="schedules.selected?.id === item.id ? 'true' : undefined" @click="inspectSchedule(item.id)"><strong :title="item.name">{{ item.name }}</strong><span>{{ t(item.enabled ? 'scheduling.enabled' : 'scheduling.paused') }}</span></button></li></ul><button v-if="schedules.nextBeforeId" data-testid="schedule-list-more" @click="schedules.loadMore()">{{ t('scheduleRun.more') }}</button></nav>
    <main class="schedule-detail">
      <header class="plan-heading"><h2>{{ schedules.selected?.name || t('scheduleEditor.new') }}</h2><span v-if="schedules.selected" class="plan-state">{{ t(schedules.selected.enabled ? 'scheduling.enabled' : 'scheduling.paused') }}</span><button v-if="schedules.selected" data-testid="schedule-history-open" @click="openHistory">{{ t('runRecords.planHistory') }}</button></header>

      <div ref="planBody" class="plan-body" @scroll="position.scheduleDetailScroll = ($event.currentTarget as HTMLElement).scrollTop">
      <p v-if="!schedules.selected">{{ t('scheduling.initialPaused') }}</p><p v-if="!canManage">{{ t('scheduleEditor.permission') }}</p><p v-if="schedules.options && !schedules.options.schedulerAvailable">{{ t('scheduleEditor.unavailable') }}</p>
      <p v-if="schedules.error" role="alert">{{ code(schedules.error) }}</p>

      <fieldset class="plan-form" :disabled="!canManage || schedules.busy">
        <h3>{{ t('runRecords.scheduleConfig') }}</h3>
        <label v-if="!schedules.selected">{{ t('scheduling.name') }}<input v-model="name" maxlength="128" data-testid="schedule-name" /></label>
        <label>{{ t('scheduling.target') }}<select v-model="target" data-testid="schedule-target"><option value="">{{ t('scheduling.target') }}</option><option v-for="item in execution.project?.suites ?? []" :key="item.id" :value="'suite:' + item.id">{{ item.name }}</option><option v-for="item in execution.project?.workflows ?? []" :key="item.id" :value="'workflow:' + item.id">{{ item.name }}</option></select></label>

        <label>{{ t('scheduleEditor.environment') }}<select v-model="environmentId"><option value="">{{ t('onlineExecution.baseEnvironment') }}</option><option v-for="env in execution.project?.environments ?? []" :key="env.id" :value="env.id">{{ env.name }}</option></select></label>
        <label>{{ t('scheduling.agent') }}<select v-model="agentId" data-testid="schedule-agent"><option value="">{{ t('scheduling.blocked.agent') }}</option><option v-for="agent in execution.agents?.agents ?? []" :key="agent.id" :value="agent.id" :disabled="agent.availability !== 'available' || agent.configuration.status !== 'applied'">{{ agent.name }} · {{ t('onlineExecution.states.' + agent.availability) }}<template v-if="agent.configuration.status !== 'applied'"> · {{ t('scheduleAgentConfig.' + agent.configuration.status) }}</template></option></select></label>
        <details v-if="schedules.selected" :open="snapshotChanged || !!schedules.refreshCandidate" class="plan-options snapshot-options"><summary>{{ t('scheduleEditor.refresh') }}</summary><p>{{ t('scheduleRun.refreshHint') }}</p>
          <button data-testid="schedule-refresh-snapshot" :disabled="reasons.length > 0 || !target" @click="action(() => schedules.prepareRefresh(preparation()))">{{ t('scheduleEditor.refresh') }}</button>
          <section v-if="schedules.refreshCandidate" data-testid="schedule-snapshot-diff"><h3>{{ t('scheduleEditor.diff') }}</h3><div class="table-scroll"><table><thead><tr><th>{{ t('scheduleEditor.area') }}</th><th>{{ t('scheduleEditor.before') }}</th><th>{{ t('scheduleEditor.after') }}</th></tr></thead><tbody><tr v-for="area in schedules.refreshCandidate.preparation.snapshotDiff.areas" :key="area.area"><th>{{ t('scheduleEditor.areas.' + area.area) }} · {{ t(area.changed ? 'scheduleEditor.changed' : 'scheduleEditor.unchanged') }}</th><td v-for="(value, side) in [area.before, area.after]" :key="side"><template v-if="value"><span v-if="value.name">{{ value.name }}</span><ul v-if="value.ids"><li v-for="id in value.ids" :key="id" :title="id">{{ short(id) }}</li></ul><span v-if="value.count !== undefined">{{ t('scheduleEditor.count') }}: {{ value.count }}</span><span v-if="value.version">{{ t('scheduleDetails.version') }}: {{ value.version }}</span><span v-if="value.fingerprint" :title="value.fingerprint">{{ short(value.fingerprint) }}</span><details v-if="value.fingerprint || value.ids?.some(id => id.length > 24)"><summary>{{ t('scheduleOriginal.comparison') }}</summary><ul><li v-for="id in value.ids ?? []" :key="id"><code>{{ id }}</code></li></ul><code v-if="value.fingerprint">{{ value.fingerprint }}</code></details></template><span v-else>{{ t('scheduleEditor.noPrevious') }}</span></td></tr></tbody></table></div><button data-testid="schedule-confirm-refresh" @click="schedules.confirmRefresh()">{{ t('scheduleEditor.confirmRefresh') }}</button></section>
        </details>
        <fieldset class="trigger-rule" @input="ruleChanged" @change="ruleChanged"><legend>{{ t('scheduleEditor.rule') }}</legend>
          <select v-model="ruleMode" data-testid="schedule-rule-mode" :aria-label="t('scheduleEditor.rule')"><option value="daily">{{ t('scheduleEditor.daily') }}</option><option value="weekly">{{ t('scheduleEditor.weekly') }}</option><option value="cron">{{ t('scheduleEditor.cron') }}</option><option value="once">{{ t('scheduleEditor.once') }}</option></select>
          <label>{{ t('scheduleEditor.zone') }}<input v-model="zone" data-testid="schedule-zone" /></label>
          <template v-if="ruleMode === 'daily' || ruleMode === 'weekly'"><input v-model="clockTime" data-testid="schedule-time" type="time" :aria-label="t('scheduleHistory.planned')" /><select v-if="ruleMode === 'weekly'" v-model="weekday" data-testid="schedule-weekday" :aria-label="t('scheduleEditor.weekday')"><option v-for="day in ['MON','TUE','WED','THU','FRI','SAT','SUN']" :key="day" :value="day">{{ t('scheduleEditor.days.' + day) }}</option></select></template>
          <label v-if="ruleMode === 'cron'">{{ t('scheduleEditor.cron') }}<input v-model="cron" data-testid="schedule-cron" /></label>
          <label v-if="ruleMode === 'once'">{{ t('scheduleEditor.atUtc') }}<input v-model="atUtc" data-testid="schedule-at" placeholder="2035-01-01T00:00:00.000Z" /></label>
          <details v-if="ruleMode !== 'once'" class="dst"><summary>{{ t('scheduleEditor.dst') }}</summary><label>{{ t('scheduleEditor.dst') }}<select v-model="dstOverlap"><option value="first">{{ t('scheduleEditor.first') }}</option><option value="both">{{ t('scheduleEditor.both') }}</option></select></label></details>
        </fieldset>
        <button data-testid="schedule-preview" @click="previewRule">{{ t('scheduleEditor.preview') }}</button>
        <section v-if="schedules.previewResult" ref="previewPanel" class="plan-preview" data-testid="schedule-preview-results">
          <ol><li v-for="candidate in schedules.previewResult.candidates.slice(0,2)" :key="candidate.plannedAtUtc"><time :title="candidate.plannedAtUtc">{{ candidate.localTime }} {{ candidate.offset }}</time></li></ol>
          <details v-if="schedules.previewResult.candidates.length > 2"><summary>{{ t('scheduleEditor.preview') }} ({{ schedules.previewResult.candidates.length }})</summary><ol><li v-for="candidate in schedules.previewResult.candidates.slice(2)" :key="candidate.plannedAtUtc"><time :title="candidate.plannedAtUtc">{{ candidate.localTime }} {{ candidate.offset }}</time></li></ol></details>
          <p v-for="notice in schedules.previewResult.notices" :key="notice">{{ code(notice) }}</p></section>
        <details class="plan-options"><summary>{{ t('runRecords.planPolicy') }}</summary>
      <section v-if="schedules.options"><h3>{{ t('schedulePolicy.title') }}</h3><dl><dt>{{ t('schedulePolicy.minInterval') }}</dt><dd>{{ schedules.options.policy.minIntervalMs / 1000 }} {{ t('schedulePolicy.seconds') }} · {{ t('schedulePolicy.sources.' + schedules.options.sources.minIntervalMs) }}</dd><dt>{{ t('schedulePolicy.maxQueue') }}</dt><dd>{{ schedules.options.policy.maxQueueTimeoutMs / 1000 }} {{ t('schedulePolicy.seconds') }} · {{ schedules.options.sources.maxQueueTimeoutMs ? t('schedulePolicy.sources.' + schedules.options.sources.maxQueueTimeoutMs) : t('onlineExecution.notCollected') }}</dd><dt>{{ t('schedulePolicy.maxSchedules') }}</dt><dd>{{ schedules.options.policy.maxSchedules }}</dd><dt>{{ t('schedulePolicy.versions') }}</dt><dd>{{ t('schedulePolicy.sources.workspace') }} {{ schedules.options.policyVersion.workspace }} / {{ t('schedulePolicy.sources.project') }} {{ schedules.options.policyVersion.project }}</dd></dl></section>
        <label>{{ t('scheduleRun.job') }}<input v-model="jobSeconds" type="number" min="0.001" step="0.001" :placeholder="t('scheduleRun.inherit')" data-testid="schedule-job-seconds" /></label><label>{{ t('scheduleRun.script') }}<input v-model="scriptSeconds" type="number" min="0.001" step="0.001" :placeholder="t('scheduleRun.inherit')" data-testid="schedule-script-seconds" /></label><p>{{ t('scheduleRun.refreshHint') }}</p>
        <fieldset><legend>{{ t('scheduleRun.materials') }}</legend><button data-testid="schedule-material-options" @click="schedules.loadMaterialOptions()">{{ t('scheduleRun.loadMetadata') }}</button><p>{{ t('scheduleRun.materialHint') }}</p><label v-for="credential in schedules.materialOptions?.credentials ?? []" :key="credential.refId">{{ credential.refId }}<select :value="credentialModes[credential.refId] ?? 'current-at-trigger'" data-testid="schedule-credential-mode" @change="credentialModes[credential.refId] = ($event.target as HTMLSelectElement).value"><option value="current-at-trigger">{{ t('scheduleRun.current') }}</option><option value="fixed-version">{{ t('scheduleRun.fixed') }}</option></select><input v-if="credentialModes[credential.refId] === 'fixed-version'" :aria-label="t('scheduleDetails.version')" :value="fixedVersions[credential.refId] ?? credential.version" @input="fixedVersions[credential.refId] = ($event.target as HTMLInputElement).value" /></label></fieldset>
        <label>{{ t('scheduleEditor.late') }}<input v-model.number="late" type="number" min="1" step="0.001" /></label>
        <label>{{ t('scheduleEditor.misfire') }}<select v-model="misfire"><option value="skip">{{ t('scheduleEditor.skipMissed') }}</option><option value="catch-up-one">{{ t('scheduleEditor.catchupOne') }}</option></select></label>
        <label>{{ t('scheduleEditor.catchup') }}<input v-model.number="catchup" type="number" min="1" step="0.001" /></label>
        <label>{{ t('scheduleEditor.overlap') }}<select v-model="overlap"><option value="skip">{{ t('scheduleEditor.skipOverlap') }}</option><option value="queue-one">{{ t('scheduleEditor.queueOne') }}</option></select></label>
        <label>{{ t('scheduleEditor.queue') }}<input v-model.number="queue" type="number" min="1" step="0.001" data-testid="schedule-queue-seconds" /></label><p>{{ t('scheduleEditor.queueHint') }}</p>
        </details>
        <details class="plan-options"><summary>{{ t('scheduleEditor.notifications') }}</summary><label><input v-model="inApp" type="checkbox" data-testid="schedule-inapp" />{{ t('scheduleEditor.inApp') }}</label><label v-for="event in ['failed','abnormal','expired','paused','succeeded','skipped']" :key="event"><input v-model="eventKinds" type="checkbox" :value="event" />{{ t('scheduleEditor.events.' + event) }}</label><label v-for="channel in schedules.options?.channels ?? []" :key="channel.id"><input v-model="channelIds" type="checkbox" :value="channel.id" />Webhook · {{ channel.name }}</label></details>
        <template v-if="!schedules.selected"><p v-for="reason in reasons" :key="reason">{{ t('scheduling.blocked.' + reason) }}</p></template>
        <template v-else>
          <details class="plan-options"><summary>{{ t('runRecords.scheduleMore') }}</summary>
        <label>{{ t('scheduling.name') }}<input v-model="name" maxlength="128" data-testid="schedule-name" /></label>
      <dl v-if="schedules.selected"><dt>{{ t('scheduleDetails.version') }}</dt><dd>{{ schedules.selected.version }}</dd><dt>{{ t('scheduleDetails.snapshot') }}</dt><dd>{{ schedules.selected.snapshotVersion }}</dd><dt>{{ t('scheduleDetails.fingerprint') }}</dt><dd><span data-testid="schedule-fingerprint" :title="schedules.selected.manifestHash">{{ short(schedules.selected.manifestHash) }}</span><details data-testid="schedule-full-fingerprint"><summary>{{ t('scheduleOriginal.fingerprint') }}</summary><code>{{ schedules.selected.manifestHash }}</code></details></dd></dl>
          <p v-for="reason in reasons" :key="reason">{{ t('scheduling.blocked.' + reason) }}</p>
          </details>
          <details ref="riskPanel" class="plan-options risk"><summary>{{ t('scheduleEditor.risk') }}</summary><p>{{ schedules.selected.execution.target.kind === 'suite' ? 'suite:' + schedules.selected.execution.target.suiteId : schedules.selected.execution.target.kind === 'workflow' ? 'workflow:' + schedules.selected.execution.target.workflowId : '' }} · {{ schedules.selected.execution.agentId }} · {{ schedules.selected.execution.environmentId || t('onlineExecution.baseEnvironment') }}</p><p>{{ t('scheduleEditor.riskHint') }}</p><p>{{ t('scheduleEditor.scriptRisk') }}</p><label><input v-model="riskConfirmed" type="checkbox" data-testid="schedule-risk-confirm" />{{ t('scheduleEditor.confirmRisk') }}</label><button data-testid="schedule-enable" :disabled="snapshotChanged || !riskConfirmed || !schedules.options?.schedulerAvailable" @click="schedules.update({ enabled: true })">{{ t('scheduleEditor.enable') }}</button><button @click="schedules.update({ enabled: false })">{{ t('scheduleEditor.pause') }}</button>
          <section><h3>{{ t('scheduleEditor.reauthorize') }}</h3><p>{{ schedules.selected.subjectUserId }} → {{ execution.context?.ownerId }}</p><p>{{ t('scheduleEditor.subjectHint') }}</p><label><input v-model="subjectConfirmed" type="checkbox" data-testid="schedule-subject-confirm" />{{ t('scheduleEditor.confirmSubject') }}</label><button data-testid="schedule-reauthorize" :disabled="!subjectConfirmed" @click="schedules.update({ reauthorize: true, enabled: false })">{{ t('scheduleEditor.reauthorize') }}</button></section>
          <section><p>{{ t('scheduleRun.deleteHint') }}</p><label><input v-model="deleteConfirmed" type="checkbox" data-testid="schedule-delete-confirm" />{{ t('scheduleRun.confirmDelete') }}</label><button data-testid="schedule-delete" :disabled="!deleteConfirmed" @click="schedules.remove()">{{ t('scheduleRun.delete') }}</button></section></details>

        </template>
      </fieldset>
      <button v-if="schedules.selected" data-testid="schedule-notification-history-open" @click="schedules.loadNotificationHistory()">{{ t('scheduleCenter.history') }}</button>
      <section v-if="schedules.notificationHistory" data-testid="schedule-notification-history">
        <h3>{{ t('scheduleCenter.history') }}</h3><h4>{{ t('scheduleCenter.sources') }}</h4>
        <ul><li v-for="source in [...schedules.notificationHistory.sources, ...(schedules.notificationHistory.pauseSource ? [schedules.notificationHistory.pauseSource] : [])]" :key="source.sourceId"><strong v-if="source === schedules.notificationHistory.pauseSource">{{ t('scheduleCenter.pauseSource') }} · </strong>{{ source.sourceId }} · {{ t('scheduleDetails.version') }} {{ source.sourceVersion ?? t('onlineExecution.notCollected') }} · {{ t('scheduleCenter.observations.' + source.observationState) }}<p v-if="source.inApp !== null">{{ t(source.inApp ? 'scheduleCenter.inAppOn' : 'scheduleCenter.inAppOff') }}</p><p v-if="source.eventId">{{ t('scheduleCenter.eventId') }} {{ source.eventId }}</p></li></ul>
        <button v-if="schedules.notificationHistory.nextSourceBeforeId" data-testid="schedule-notification-sources-more" @click="schedules.loadNotificationHistory({ sourceBeforeId: schedules.notificationHistory.nextSourceBeforeId })">{{ t('scheduleCenter.moreSources') }}</button>
        <article v-for="event in schedules.notificationHistory.items" :key="event.eventId"><h4>{{ event.sourceId }} · {{ event.sourceVersion }}</h4><p v-if="event.detailState === 'expired'">{{ t('scheduleCenter.detailExpired') }}</p><p>{{ t(event.inApp ? 'scheduleCenter.inAppOn' : 'scheduleCenter.inAppOff') }}</p><p>{{ t('scheduleDelivery.' + event.notificationState) }}</p><p v-for="reason in event.reasonCodes" :key="reason">{{ code(reason) }}</p><OnlineDeliveryList :deliveries="event.deliveries" /></article>
        <button v-if="schedules.notificationHistory.nextBeforeId" data-testid="schedule-notification-events-more" @click="schedules.loadNotificationHistory({ beforeId: schedules.notificationHistory.nextBeforeId })">{{ t('scheduleCenter.moreEvents') }}</button>
      </section>
      <section v-if="schedules.history" ref="historyPanel" class="history-scroll" data-testid="schedule-history" role="region" :aria-label="t('scheduleHistory.title')" tabindex="0"><h3>{{ t('scheduleHistory.title') }}</h3><p>{{ t('scheduleHistory.states.' + schedules.history.evaluationStatus) }} · {{ code(schedules.history.pausedReasonCode) }}</p>
        <table><thead><tr><th v-for="column in ['planned','delay','queue','actual','verdict','archive','notification','reason']" :key="column">{{ t('scheduleHistory.' + column) }}</th></tr></thead><tbody><tr v-for="row in schedules.history.items" :key="row.id"><td><time :title="row.plannedAtUtc">{{ time(row.plannedAtUtc) }}</time><p>{{ t('scheduleDetails.version') }} {{ row.revision }}</p></td><td>{{ row.delayMs }} ms</td><td>{{ t('scheduleHistory.states.' + row.state) }}<p><time :title="row.queueDeadlineUtc">{{ time(row.queueDeadlineUtc) }}</time></p></td><td>{{ row.execution.availability === 'available' ? t('onlineExecution.states.' + row.execution.state) : t('scheduleHistory.states.' + row.execution.availability) }}<p>{{ t('onlineExecution.notCollected') }}</p></td><td>{{ row.execution.verdict ? t('onlineExecution.states.' + row.execution.verdict) : t('onlineExecution.notCollected') }}</td><td>{{ row.execution.reportState ? t('onlineExecution.states.' + row.execution.reportState) : t('onlineExecution.notCollected') }}<p>{{ row.execution.released === null ? t('onlineExecution.notCollected') : t(row.execution.released ? 'onlineExecution.states.released' : 'onlineExecution.states.retained') }}</p><button v-if="row.jobId" data-testid="schedule-original-report" @click="emit('report', row)">{{ t('scheduleHistory.originalReport') }}</button></td><td>{{ t('scheduleHistory.notificationIndependent') }}</td><td>{{ code(row.reasonCode) }}<details><summary>{{ t('scheduleHistory.identity') }}</summary><dl><dt>ID</dt><dd>{{ row.id }}</dd><dt>Job</dt><dd>{{ row.jobId ?? t('scheduleHistory.notSubmitted') }}</dd><dt>{{ t('scheduleHistory.executionId') }}</dt><dd>{{ row.executionId ?? t('scheduleHistory.notSubmitted') }}</dd><dt>{{ t('scheduleHistory.observed') }}</dt><dd>{{ time(row.observedAtUtc) }}</dd></dl></details></td></tr></tbody></table>
        <h4>{{ t('scheduleHistory.missed') }}</h4><ul><li v-for="window in schedules.history.missedWindows" :key="window.id"><time :title="window.fromUtc">{{ time(window.fromUtc) }}</time> → <time :title="window.throughUtc">{{ time(window.throughUtc) }}</time> · {{ window.missedCount === null ? t('scheduleHistory.countUnknown') : window.missedCount }} · {{ code(window.reasonCode) }}</li></ul>
        <button v-if="schedules.history.nextBeforeId" data-testid="schedule-history-more" @click="schedules.loadHistory({ beforeId: schedules.history.nextBeforeId })">{{ t('schedulePagination.occurrences') }}</button><button v-if="schedules.history.nextMissedBeforeId" data-testid="schedule-missed-more" @click="schedules.loadHistory({ missedBeforeId: schedules.history.nextMissedBeforeId })">{{ t('schedulePagination.missed') }}</button>
      </section>
      </div>
      <footer class="plan-actions">
        <button v-if="!schedules.selected" class="primary" data-testid="schedule-save" :disabled="!canManage || schedules.busy || reasons.length > 0 || !name || !target" @click="save">{{ t('scheduling.savePaused') }}</button>
        <template v-else><button data-testid="schedule-update" :disabled="!canManage || schedules.busy || snapshotChanged" @click="action(update)">{{ t('runRecords.saveSettings') }}</button>
          <button class="primary" :disabled="!canManage || schedules.busy || snapshotChanged" @click="showEnable">{{ schedules.selected.enabled ? t('scheduleEditor.pause') : t('runRecords.enablePlan') }}</button></template>
      </footer>
    </main>
  </div>
</section>
</template>
<style scoped src="../../styles/online-controls.css"></style>
<style scoped>

.schedules, .schedule-columns { min-width:0; min-height:0; flex:1; display:flex; }
.schedule-columns { display:grid; grid-template-columns:minmax(215px,33%) minmax(0,1fr); gap:8px; padding:9px; }
.schedule-list,.schedule-detail { min-width:0; min-height:0; overflow:auto; padding:12px; border:1px solid var(--border); border-radius:7px; background:var(--bg); }
.schedule-toolbar,.plan-heading,.plan-actions { display:flex;align-items:center; gap:7px; flex-wrap:wrap; }
.schedule-toolbar input { flex:1; min-width:65px; width:45%; }.schedule-toolbar select { max-width:36%; }
.schedule-list ul { list-style:none; margin:12px 0; padding:0; }
.schedule-list .plan-row { width:100%; min-height:38px; display:flex; justify-content:space-between; align-items:center; border:0; border-bottom:1px solid var(--border); border-radius:0; padding:5px 9px; text-align:start; }
.plan-row strong { overflow-wrap:anywhere; }.plan-row span,.plan-state { padding:1px 5px; background:var(--subtle); border-radius:4px; white-space:nowrap; }
.plan-row[aria-current] { box-shadow:inset 3px 0 var(--accent); background:var(--active-weak); }
.plan-heading { border-bottom:1px solid var(--border); padding-bottom:10px; }
.plan-heading h2 { margin:0; font-size:18px; }.plan-heading button { margin-left:auto; color:var(--accent); border:0; }
.plan-form { display:block; min-width:0; padding:0; margin:0; border:0; }
.plan-form h3 { margin:10px 0 6px; }.plan-form > label { display:grid; grid-template-columns:minmax(80px,16%) minmax(0,260px); align-items:center; gap:8px; margin:4px 0; }
.plan-form input,.plan-form select { max-width:100%; min-width:0; }
.trigger-rule { display:flex; flex-wrap:wrap; align-items:center; gap:8px; border:0; border-top:1px solid var(--border); padding:8px 0; margin-top:13px; }
.trigger-rule legend { font-weight:600; }.trigger-rule label { display:flex; align-items:center; gap:4px; }.trigger-rule input[type=number] { width:48px; }
.plan-options { border-top:1px solid var(--border); padding:7px 0; }.plan-options summary { cursor:pointer; font-weight:500; }
.plan-options label { display:flex; gap:7px; align-items:center; margin:5px 0; flex-wrap:wrap; }.plan-actions { justify-content:flex-end; padding:10px 0; border-top:1px solid var(--border); }
.primary { color:white; background:var(--accent); border-color:var(--accent); }
.schedule-detail > button { margin:8px 6px 10px 0; }.history-scroll { overflow:auto; max-height:440px; }.history-scroll table { min-width:1280px; } .table-scroll { overflow:auto; max-height:360px; }
dl { display:grid; grid-template-columns:minmax(90px,28%) minmax(0,1fr); gap:5px 12px; } dd { margin:0; overflow-wrap:anywhere; }
@container(max-width:650px){.schedule-columns{grid-template-columns:minmax(0,1fr); grid-template-rows:minmax(100px,30%) minmax(0,1fr);} }
.schedule-detail { display:flex; flex-direction:column; overflow:hidden; }
.plan-body { flex:1; min-height:0; overflow:auto; }
.plan-heading,.plan-actions { flex:none; }
.plan-preview ol { display:flex; flex-wrap:wrap; gap:7px 12px; padding-left:0; list-style:none; margin:4px 0; }
.trigger-rule .dst { font-size:12px; color:var(--text-muted); }
</style>

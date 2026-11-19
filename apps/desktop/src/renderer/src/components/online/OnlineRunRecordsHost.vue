<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, provide, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { isFullOnlineJob, OnlineJobSchema, type OnlineExecutionContext, type OnlineJob } from "../../../../shared/online/execution.js";
import type { CollaborationLocalSource } from "../../../../shared/online/collaboration.js";
import type { NotificationEvent, ScheduleOccurrence } from "@apicc/execution/contract";
import type { createOnlineStore } from "../../stores/online.js";
import type { createOnlineProjectAdapter } from "../../stores/onlineProjectAdapter.js";
import type { NotificationPosition, OnlineRunPane } from "../../stores/onlineSchedules.js";
import { useWorkbenchPosition, workbenchPositionKey } from "../../stores/workbenchPosition.js";
import type { RunRecord } from "../../stores/onlineExecution.js";
import type { AiStore } from "../../stores/ai.js";
import { recordTime, useRecordMessages } from "../../execution/recordMessages.js";
import { jobRecordFacts, shortRecordId } from "../../execution/recordFacts.js";
import RunWorkbench from "../RunWorkbench.vue";
import OnlineRunLaunch from "./OnlineRunLaunch.vue";
import OnlineExecutionPanel from "./OnlineExecutionPanel.vue";
import OnlineSchedulesPanel from "./OnlineSchedulesPanel.vue";
import OnlineNotificationsPanel from "./OnlineNotificationsPanel.vue";
const props = withDefaults(defineProps<{ online: ReturnType<typeof createOnlineStore>; adapter: ReturnType<typeof createOnlineProjectAdapter>;
  ai?: AiStore; readOnly?: boolean; dirtyStressPlanId?: string | null; pane: OnlineRunPane; active?: boolean; reportError: (e: unknown) => void;
  openProject?: (workspaceId: string, projectId: string) => Promise<boolean> }>(), { active: true });
const emit = defineEmits<{ "update:pane": [pane: OnlineRunPane]; collaboration: [v: {context: OnlineExecutionContext; source: CollaborationLocalSource}] }>();
const { t, te, locale } = useI18n();
const msg = useRecordMessages();
const e = computed(() => props.online.execution), schedules = computed(() => props.online.schedules);
const scopesMatch = (a?: OnlineExecutionContext | null,b?: OnlineExecutionContext | null) => !!a && !!b && a.serverId === b.serverId && a.ownerId === b.ownerId && a.scope.workspaceId === b.scope.workspaceId && a.scope.groupId === b.scope.groupId && a.scope.projectId === b.scope.projectId;
const sameMember = (a: OnlineExecutionContext,b?: OnlineExecutionContext | null) => !!b && a.serverId === b.serverId && a.ownerId === b.ownerId && a.scope.workspaceId === b.scope.workspaceId;
const position = ref<"schedules" | null>(null), issue = ref(""), list = ref<HTMLElement>();
let intent = 0;
const workbench = useWorkbenchPosition(() => JSON.stringify(e.value.context));
provide(workbenchPositionKey, workbench);
const hideDetail = computed({ get: () => workbench.value.recordListOnly, set: value => { workbench.value.recordListOnly = value; } });
const selected = computed(() => e.value.resultSelection);
const selectedJob = computed(() => selected.value?.kind === "agent" && "job" in selected.value ? selected.value.job : undefined);
const jobKey = (j: OnlineJob) => [j.agentId,j.jobId,j.executionId].join("/");
const selectedKey = computed(() => selectedJob.value ? jobKey(selectedJob.value) : selected.value && "runId" in selected.value ? selected.value.runId : "");
function code(value?: string) {
  if (!value) return msg("notRecorded");
  if (value === "stress") return t("run.kindStress");
  for (const ns of ["onlineExecution.states", "stress.workbench.verdict", "executionLabels"]) if (te(ns + "." + value)) return t(ns + "." + value);
  return value;
}
function go(pane: OnlineRunPane, revealing = false) { workbench.value.revealingRecord = revealing; issue.value = ""; intent++; emit("update:pane", pane); }
watch(() => [props.active, e.value.context, e.value.visible, props.pane, schedules.value.selected], () => { intent++; issue.value = ""; }, { flush: "sync" });
watch(() => e.value.context, () => { position.value = null; });
watch(() => props.active, active => {
  if (active) return;
  schedules.value.navigationIntent++;
  schedules.value.returnTo = null; schedules.value.restorePosition = null; schedules.value.paneRequest = null;
}, { flush: "sync" });
watch(() => schedules.value.paneRequest, request => {
  if (request && props.active && scopesMatch(e.value.context, request.context)) { hideDetail.value = false; emit("update:pane", request.pane); }
}, { immediate: true, flush: "post" });
onBeforeUnmount(() => { intent++; });
type Row = { key: string; job?: OnlineJob; run?: RunRecord; name: string; targetId?: string; agentName?: string; kind?: string; time?: string | number; started?: boolean; state: string; verdict?: string };
const rows = computed(() => {
  const result: Row[] = [], seen = new Set<string>();
  function addJob(job: OnlineJob, receipt?: RunRecord) {
    const key = jobKey(job); if (seen.has(key)) return; seen.add(key);
    const full = isFullOnlineJob(job) ? job : undefined;
    const target = full?.task.target;
    const report = selectedKey.value === key && full?.reportState === "archived" && e.value.report?.executionId === job.executionId ? e.value.report : undefined;
    const facts = full && jobRecordFacts(full, e.value.view, report);
    const number = "#" + shortRecordId(job.jobId);
    result.push({ key, job, run: receipt, name: full ? facts?.targetName || receipt?.targetName || code(full.task.target.kind) + " " + number : number,
      targetId: facts?.targetId, agentName: full ? facts?.agentName || receipt?.locationName : undefined, kind: target?.kind,
      time: facts?.startedAt ?? (full ? receipt?.submittedAt : undefined), started: facts?.startedAt !== undefined,
      state: code(job.state), verdict: report?.verdict ?? (full && typeof full.summary?.verdict === "string" ? full.summary.verdict : undefined) });
  }
  for (const receipt of e.value.submissions) {
    if (receipt.agentRef && !receipt.job) continue;
    if (receipt.job) { const job = e.value.jobs.find(j => jobKey(j) === jobKey(receipt.job!)); if (job) addJob(job, receipt); continue; }
    const local = receipt.result?.output;
    result.push({key:receipt.runId,run:receipt,name:receipt.targetName || code(receipt.target.kind) + " #" + shortRecordId(receipt.runId),kind:receipt.target.kind,time:receipt.submittedAt,
      state:local || receipt.localReport ? code("ended") : receipt.pending ? msg("awaiting") : msg("uncertain"),
      verdict:local?.kind === "failure" || local?.kind === "stress-failure" ? "failed" : local?.kind === "stress" ? local.result.verdict.status :
        local?.kind === "debug" ? (local.result.error || local.result.failureKind || local.result.run.failed ? "failed" : "passed") :
        local ? (local.kind === "suite" ? local.result.suite?.verdict : local.result.verdict) : receipt.localReport?.verdict });
  }
  e.value.jobs.forEach(job => addJob(job));
  if (selectedJob.value) addJob(selectedJob.value);
  return result;
});
const selectedRow = computed(() => rows.value.find(row => row.key === selectedKey.value));
const selectedLocal = computed(() => {
  const row = selectedRow.value?.run;
  return props.active && props.pane === "records" && !hideDetail.value && row?.location.kind === "local" ? row : undefined;
});
async function recoverLocal(run: RunRecord) {
  if (run.pending || run.result || !scopesMatch(run.context, e.value.context)) return;
  try { await e.value.selectSubmission(run.runId); }
  catch { if (selectedLocal.value === run) issue.value = msg("unavailable"); }
}
watch(() => [selectedLocal.value?.runId, selectedLocal.value?.pending] as const, ([id, pending], [previous, wasPending]) => {
  const run = selectedLocal.value;
  if (run && id === previous && wasPending && !pending && !run.localReport) void recoverLocal(run);
});
async function refreshRecords() {
  const run = selectedLocal.value;
  await e.value.refresh();
  if (run && selectedLocal.value === run) await recoverLocal(run);
}
async function cancelRow(row: Row) {
  const context = e.value.context;
  try {
    if (row.job?.canCancel && row.job.state !== "ended" && row.job.cancelState !== "requested") await e.value.cancel(row.job);
    else if (row.run?.location.kind === "local" && row.run.runId === e.value.activeLocalRunId) await e.value.cancelLocal();
  } catch (error) { if (scopesMatch(context,e.value.context)) props.reportError(error); }
}
watch(() => [props.pane,e.value.context,props.active] as const, async () => {
  if (props.pane !== "records" || !props.active) return;
  await nextTick();
  if (list.value) list.value.scrollTop = workbench.value.recordScrollTop;
}, {immediate:true});
async function choose(row: Row) {
  schedules.value.navigationIntent++;
  workbench.value.onlineRecord = row.job ? { jobId: row.job.jobId, executionId: row.job.executionId, agentId: row.job.agentId }
    : row.run ? { runId: row.run.runId } : null;
  const n = ++intent; hideDetail.value = false; issue.value = "";
  const live = () => intent === n && props.active && e.value.visible;
  try { if (row.job) await e.value.inspect(row.job, live); else if (row.run) await e.value.selectSubmission(row.run.runId); }
  catch (err) { if (live()) issue.value = err instanceof Error ? err.message : String(err); }
}
async function inspectLaunch(id?: string) {
  workbench.value.onlineRecord = id ? { runId: id } : null;
  go("records", true); await nextTick(); hideDetail.value = false;
  if (id) try { await e.value.selectSubmission(id); } catch (err) { props.reportError(err); }
}
async function original(ctx: OnlineExecutionContext, jobId: string, executionId: string, live: () => boolean) {
  const ref = await schedules.value.originalJob(ctx, jobId, executionId);
  if (!live()) return false;
  if (ref.jobId !== jobId || ref.executionId !== executionId) throw new Error("fixed-input-mismatch");
  const job = OnlineJobSchema.parse(await props.adapter.bridge.onlineExecution({operation:"status", context:ctx, runId:jobId,location:{kind:"agent",agentId:ref.agentId}}));
  if (!live()) return false;
  if (job.jobId !== jobId || job.executionId !== executionId || job.agentId !== ref.agentId) throw new Error("fixed-input-mismatch");
  workbench.value.onlineRecord = { jobId: job.jobId, executionId: job.executionId, agentId: job.agentId };
  await e.value.inspect(job,live); return live();
}
async function scheduleReport(row: ScheduleOccurrence) {
  const ctx=e.value.context, plan=schedules.value.selected;
  if (!ctx || !plan || !row.jobId || !row.executionId || row.scheduleId!==plan.id || row.projectId!==ctx.scope.projectId || row.workspaceId!==ctx.scope.workspaceId) return;
  const n=++intent, live=() => n===intent && scopesMatch(ctx,e.value.context) && e.value.visible && props.active && props.pane==="schedules";
  try { if(await original(ctx,row.jobId,row.executionId,live)) { position.value="schedules"; hideDetail.value=false; go("records", true); } }
  catch(err) { if(live()) { issue.value=msg("unavailable"); props.reportError(err); } }
}
async function switchProject(source: OnlineExecutionContext, projectId: string) {
  if (!sameMember(source,e.value.context)) return false;
  if (e.value.context?.scope.projectId !== projectId && !await props.openProject?.(source.scope.workspaceId,projectId)) return false;
  return sameMember(source,e.value.context) && e.value.context?.scope.projectId === projectId && e.value.visible;
}
async function notification(event: NotificationEvent, dest: "schedules"|"records", pos: NotificationPosition) {
  const ctx = e.value.context, store = schedules.value;
  if (!ctx || event.workspaceId !== ctx.scope.workspaceId || (dest==="records" && (!event.jobId || !event.executionId))) return;
  const n=++store.navigationIntent;
  store.returnTo={ context:ctx, position:pos, targetProjectId:event.projectId };
  try {
    if (!await switchProject(ctx,event.projectId)) throw new Error(msg("unavailable"));
    if (n !== store.navigationIntent) return;
    const target=e.value.context!, version=store.contextVersion;
    const live=() => n===store.navigationIntent && version===store.contextVersion && scopesMatch(target,e.value.context) && e.value.visible;
    if (dest === 'records') {
      e.value.resultSelection=null; e.value.report=null; e.value.localResult=null; e.value.selectedJobId=""; e.value.error="";
    }
    store.paneRequest={ context:target,pane:dest }; await nextTick(); await nextTick();
    if (!live()) return;
    if (dest==="schedules") { await store.inspect(event.scheduleId); if (live() && !store.selected) throw new Error(msg("unavailable")); }
    else if (event.jobId && event.executionId) await original(target,event.jobId,event.executionId,live);
  } catch(err) {
    if (n!==store.navigationIntent) return;
    if (e.value.context?.scope.projectId === event.projectId && !scopesMatch(ctx,e.value.context)) {
      try { await switchProject(ctx,ctx.scope.projectId); } catch { /* Show the issue in the remaining accessible project. */ }
    }
    if (n!==store.navigationIntent) return;
    store.error="linked-record-unavailable";
    e.value.error=err instanceof Error ? err.message : msg("unavailable");
    if (scopesMatch(ctx,e.value.context) && e.value.visible) {
      store.restorePosition={ ...pos, unavailable:true };
      store.paneRequest={context:ctx,pane:"notifications"};
      store.returnTo=null;
    }
  }
}
watch(() => props.active && props.pane === "records" && e.value.visible && !e.value.busy && !e.value.projectAccessLost
  ? JSON.stringify(e.value.context) : "", async (owner, _, cleanup) => {
  const saved = workbench.value.onlineRecord, context = e.value.context;
  if (!owner || !saved || !context || schedules.value.returnTo || schedules.value.paneRequest) return;
  if (workbench.value.revealingRecord) { workbench.value.revealingRecord = false; return; }
  let current = true;
  cleanup(() => { current = false; });
  const live = () => current && workbench.value.onlineRecord === saved && owner === JSON.stringify(e.value.context);
  try {
    if ("runId" in saved) {
      if (!e.value.submissions.some(run => run.runId === saved.runId)) throw new Error(msg("unavailable"));
      await e.value.selectSubmission(saved.runId);
    } else {
      const job = OnlineJobSchema.parse(await props.adapter.bridge.onlineExecution({ operation: "status", context,
        location: { kind: "agent", agentId: saved.agentId }, runId: saved.jobId }));
      if (!live()) return;
      if (job.agentId !== saved.agentId || job.executionId !== saved.executionId || job.jobId !== saved.jobId) throw new Error(msg("unavailable"));
      await e.value.inspect(job, live);
    }
  } catch {
    if (!live()) return;
    workbench.value.onlineRecord = null; hideDetail.value = true; issue.value = msg("unavailable");
    e.value.resultSelection = null; e.value.selectedJobId = ""; e.value.report = null; e.value.localResult = null;
  }
}, { immediate: true, flush: "post" });
const canReturn = computed(() => { const ref=schedules.value.returnTo, ctx=e.value.context; return ref && sameMember(ref.context,ctx) && (ctx?.scope.projectId===ref.targetProjectId || scopesMatch(ref.context,ctx)) && props.pane!=="notifications"; });
async function backToNotification() {
  const store=schedules.value, ref=store.returnTo;
  if (!ref) return;
  const n=++store.navigationIntent;
  try {
    const opened = await switchProject(ref.context,ref.context.scope.projectId);
    if (n!==store.navigationIntent) return;
    if (!opened) { issue.value=msg("unavailable"); return; }
    store.restorePosition=ref.position; store.paneRequest={context:ref.context,pane:"notifications"}; store.returnTo=null;
  } catch { if (n===store.navigationIntent) issue.value=msg("unavailable"); }
}
function changePane(pane: OnlineRunPane) { schedules.value.navigationIntent++; schedules.value.returnTo=null; schedules.value.paneRequest=null; position.value=null; go(pane); }
function returnList() { workbench.value.onlineRecord = null; hideDetail.value=true; nextTick(() => list.value?.querySelector<HTMLElement>('[aria-current="true"] .record-link')?.focus()); }
const dirty = computed(() => props.adapter.editor.dirty || props.adapter.testing.dirty || props.adapter.workflowDesign.dirty || props.online.editorDirty);
</script>
<template>
  <RunWorkbench online :pane="pane" data-testid="online-run-host" @navigate="changePane">
    <button v-if="canReturn" class="return" data-testid="return-notification" @click="backToNotification">{{ msg("returnNotifications") }}</button>
    <button v-else-if="position && pane==='records'" class="return" @click="position=null;go('schedules')">{{ msg("returnSchedule") }}</button>
    <p v-if="issue" role="alert">{{ issue }}</p>
    <OnlineRunLaunch v-if="pane==='launch'" :execution="e" :adapter="adapter" :read-only="readOnly" :dirty-stress-plan-id="dirtyStressPlanId" :report-error="reportError" @records="inspectLaunch" />
    <div v-show="pane==='records'" class="records-layout" data-testid="online-run-records"><aside ref="list" class="record-list" @scroll="workbench.recordScrollTop = ($event.currentTarget as HTMLElement).scrollTop">
      <header class="record-heading"><h2>{{ t('runRecords.onlineHistory') }}</h2><div class="record-tools">
        <button :aria-label="t('onlineExecution.refreshNow')" @click="refreshRecords">{{ t('runRecords.refresh') }}</button>
        <details class="list-settings"><summary>{{ t('runRecords.settings') }}</summary><div><p>{{ msg("recent") }}</p><p>{{ msg("session") }}</p>
          <label>{{ t("onlineExecution.refresh") }} <input type="number" min="1" max="2147483647" :value="e.statusRefreshMs" @change="event => { try {e.setRefreshMs(Number((event.target as HTMLInputElement).value))} catch(err){reportError(err)} }" /> ms</label></div></details>
      </div></header>
      <p v-if="!rows.length">{{ msg("noRecords") }}</p><button v-if="!rows.length" @click="changePane('launch')">{{ msg("launch") }}</button>
      <table v-else class="record-table"><thead><tr><th>{{ t('onlineExecution.task') }}</th><th>{{ t('runRecords.time') }} · UTC</th><th>{{ t('runRecords.status') }}</th><th>{{ t('runRecords.conclusion') }}</th><th>{{ t('onlineExecution.actions') }}</th></tr></thead>
        <tbody><tr v-for="row in rows" :key="row.key" class="record-row" :aria-current="row.key===selectedKey" :data-record="row.key" @click="choose(row)">
          <th scope="row"><button class="record-link" :title="[row.name,row.job?.jobId ?? row.run?.runId,row.targetId].filter(Boolean).join(' · ')" @click.stop="choose(row)">{{ row.name }}</button></th>
          <td><time v-if="row.time !== undefined" :title="recordTime(row.time,locale)" :datetime="String(row.time)">{{ recordTime(row.time,locale,true) }}</time><template v-else>{{ msg('notRecorded') }}</template></td><td>{{ row.state }}</td>
          <td><span v-if="row.verdict" class="verdict" :data-verdict="row.verdict">{{ code(row.verdict) }}</span><template v-else>—</template></td>
          <td><button v-if="row.job?.canCancel && row.job.state !== 'ended'" :disabled="row.job.cancelState === 'requested'" @click.stop="cancelRow(row)">{{ t('onlineExecution.cancel') }}</button>
            <button v-else-if="row.run?.runId === e.activeLocalRunId && e.activeLocalRunId" @click.stop="cancelRow(row)">{{ t('onlineExecution.cancel') }}</button>
            <button v-else class="view-record" @click.stop="choose(row)">{{ t('runRecords.details') }}</button></td>
        </tr></tbody>
      </table>
    </aside><article class="record-detail">
      <header v-if="selectedRow && !hideDetail" class="record-heading"><h2 :title="selectedRow.targetId">{{ selectedRow.name }}</h2>
        <span v-if="selectedRow.verdict" class="verdict" :data-verdict="selectedRow.verdict">{{ code(selectedRow.verdict) }}</span>
        <button class="record-back" @click="returnList">{{ msg("back") }}</button></header>
      <p v-if="hideDetail || !selected">{{ msg("pick") }}</p><OnlineExecutionPanel v-show="!hideDetail && (selected || e.error)" :execution="e" report-only :ai="ai" @collaboration="emit('collaboration',$event)" />
    </article></div>
    <OnlineSchedulesPanel v-if="pane==='schedules'" :execution="e" :schedules="schedules" :draft-dirty="dirty" @report="scheduleReport" />
    <OnlineNotificationsPanel v-if="pane==='notifications'" :schedules="schedules" @navigate="notification" />
  </RunWorkbench>
</template>
<style scoped src="../../styles/run-records.css"></style>
<style scoped>
.return{border:0;background:transparent;padding:7px 10px;cursor:pointer;font:inherit}.return{align-self:flex-start;color:var(--accent)}input[type=number]{max-width:92px}.record-detail :deep(.execution){border:0;padding:8px 2px}.record-actions{align-items:baseline}
</style>

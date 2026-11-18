<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { isFullOnlineJob, OnlineJobSchema, type OnlineExecutionContext, type OnlineJob } from "../../../../shared/online/execution.js";
import type { CollaborationLocalSource } from "../../../../shared/online/collaboration.js";
import type { NotificationEvent, ScheduleOccurrence } from "@apicc/execution/contract";
import type { createOnlineStore } from "../../stores/online.js";
import type { createOnlineProjectAdapter } from "../../stores/onlineProjectAdapter.js";
import type { NotificationPosition, OnlineRunPane } from "../../stores/onlineSchedules.js";
import type { RunRecord } from "../../stores/onlineExecution.js";
import type { AiStore } from "../../stores/ai.js";
import { recordTime, useRecordMessages } from "../../execution/recordMessages.js";
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
const position = ref<"schedules" | null>(null), issue = ref(""), hideDetail = ref(false), list = ref<HTMLElement>();
let intent = 0;
const selected = computed(() => e.value.resultSelection);
const selectedJob = computed(() => selected.value?.kind === "agent" && "job" in selected.value ? selected.value.job : undefined);
const jobKey = (j: OnlineJob) => [j.agentId,j.jobId,j.executionId].join("/");
const selectedKey = computed(() => selectedJob.value ? jobKey(selectedJob.value) : selected.value && "runId" in selected.value ? selected.value.runId : "");
const paneTitle = (p: OnlineRunPane) => p === "schedules" ? t("scheduling.title") : msg(p);
function code(value?: string) { return value ? te("onlineExecution.states."+value) ? t("onlineExecution.states."+value) : value : msg("notRecorded"); }
function go(pane: OnlineRunPane) { issue.value = ""; intent++; emit("update:pane", pane); }
watch(() => [props.active, e.value.context, e.value.visible, props.pane, schedules.value.selected], () => { intent++; issue.value = ""; }, { flush: "sync" });
watch(() => e.value.context, () => { hideDetail.value = false; position.value = null; });
watch(() => props.active, active => {
  if (active) { hideDetail.value = false; return; }
  schedules.value.navigationIntent++;
  schedules.value.returnTo = null; schedules.value.restorePosition = null; schedules.value.paneRequest = null;
}, { flush: "sync" });
watch(() => selectedKey.value, key => { if (key) hideDetail.value=false; });
watch(() => schedules.value.paneRequest, request => {
  if (request && props.active && scopesMatch(e.value.context, request.context)) { hideDetail.value = false; emit("update:pane", request.pane); }
}, { immediate: true, flush: "post" });
onBeforeUnmount(() => { intent++; });
type Row = { key: string; job?: OnlineJob; run?: RunRecord; name: string; kind?: string; time?: string; state: string; verdict?: string };
const rows = computed(() => {
  const result: Row[] = [], seen = new Set<string>();
  function addJob(job: OnlineJob, receipt?: RunRecord) {
    const key = jobKey(job); if (seen.has(key)) return; seen.add(key);
    const full = isFullOnlineJob(job) ? job : undefined;
    const target = full?.task.target;
    const identity = target?.kind === "workflow" ? target.workflowId : target?.kind === "suite" ? target.suiteId : target?.kind === "debug" && target.invocation.mode !== "free" ? target.invocation.locator.apiId : undefined;
    result.push({ key, job, run: receipt, name: full ? receipt?.targetName ?? identity ?? "#" + job.jobId : "#" + job.jobId, kind: target?.kind,
      time: full ? receipt?.submittedAt : undefined, state: code(job.state), verdict: full && typeof full.summary?.verdict === "string" ? code(full.summary.verdict) : undefined });
  }
  for (const receipt of e.value.submissions) {
    if (receipt.agentRef && !receipt.job) continue;
    if (receipt.job) { const job = e.value.jobs.find(j => jobKey(j) === jobKey(receipt.job!)); if (job) addJob(job, receipt); continue; }
    const local = receipt.result?.output;
    result.push({key:receipt.runId,run:receipt,name:receipt.targetName ?? receipt.runId,kind:receipt.target.kind,time:receipt.submittedAt,
      state:local || receipt.localReport ? code("ended") : receipt.pending ? msg("awaiting") : msg("uncertain"),
      verdict:local?.kind === "failure" || local?.kind === "stress-failure" ? code("failed") : local?.kind === "stress" ? code(local.result.verdict.status) :
        local?.kind === "debug" ? code(local.result.error || local.result.failureKind || local.result.run.failed ? "failed" : "passed") :
        local ? code(local.kind === "suite" ? local.result.suite?.verdict : local.result.verdict) : receipt.localReport ? code(receipt.localReport.verdict) : undefined });
  }
  e.value.jobs.forEach(job => addJob(job));
  if (selectedJob.value) addJob(selectedJob.value);
  return result;
});
const selectedRow = computed(() => rows.value.find(row => row.key === selectedKey.value));
async function choose(row: Row) {
  schedules.value.navigationIntent++;
  const n = ++intent; hideDetail.value = false; issue.value = "";
  const live = () => intent === n && props.active && e.value.visible;
  try { if (row.job) await e.value.inspect(row.job, live); else if (row.run) await e.value.selectSubmission(row.run.runId); }
  catch (err) { if (live()) issue.value = err instanceof Error ? err.message : String(err); }
}
async function inspectLaunch(id?: string) {
  go("records"); await nextTick(); hideDetail.value = false;
  if (id) try { await e.value.selectSubmission(id); } catch (err) { props.reportError(err); }
}
async function original(ctx: OnlineExecutionContext, jobId: string, executionId: string, live: () => boolean) {
  const ref = await schedules.value.originalJob(ctx, jobId, executionId);
  if (!live()) return false;
  if (ref.jobId !== jobId || ref.executionId !== executionId) throw new Error("fixed-input-mismatch");
  const job = OnlineJobSchema.parse(await props.adapter.bridge.onlineExecution({operation:"status", context:ctx, runId:jobId,location:{kind:"agent",agentId:ref.agentId}}));
  if (!live()) return false;
  if (job.jobId !== jobId || job.executionId !== executionId || job.agentId !== ref.agentId) throw new Error("fixed-input-mismatch");
  await e.value.inspect(job,live); return live();
}
async function scheduleReport(row: ScheduleOccurrence) {
  const ctx=e.value.context, plan=schedules.value.selected;
  if (!ctx || !plan || !row.jobId || !row.executionId || row.scheduleId!==plan.id || row.projectId!==ctx.scope.projectId || row.workspaceId!==ctx.scope.workspaceId) return;
  const n=++intent, live=() => n===intent && scopesMatch(ctx,e.value.context) && e.value.visible && props.active && props.pane==="schedules";
  try { if(await original(ctx,row.jobId,row.executionId,live)) { position.value="schedules"; hideDetail.value=false; go("records"); } }
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
function returnList() { hideDetail.value=true; nextTick(() => list.value?.querySelector<HTMLElement>('button[aria-current="true"]')?.focus()); }
const dirty = computed(() => props.adapter.editor.dirty || props.adapter.testing.dirty || props.adapter.workflowDesign.dirty || props.online.editorDirty);
</script>
<template>
  <section class="run-host" data-testid="online-run-host">
    <nav class="run-tabs" :aria-label="msg('records')"><button v-for="p in (['launch','records','schedules','notifications'] as const)" :key="p" :data-testid="'run-pane-'+p" :aria-current="pane===p" @click="changePane(p)">{{ paneTitle(p) }}</button></nav>
    <button v-if="canReturn" class="return" data-testid="return-notification" @click="backToNotification">{{ msg("returnNotifications") }}</button>
    <button v-else-if="position && pane==='records'" class="return" @click="position=null;go('schedules')">{{ msg("returnSchedule") }}</button>
    <p v-if="issue" role="alert">{{ issue }}</p>
    <OnlineRunLaunch v-if="pane==='launch'" :execution="e" :adapter="adapter" :read-only="readOnly" :dirty-stress-plan-id="dirtyStressPlanId" :report-error="reportError" @records="inspectLaunch" />
    <div v-show="pane==='records'" class="records-layout" data-testid="online-run-records"><aside ref="list" class="record-list">
      <h3>{{ msg("records") }}</h3><p>{{ msg("recent") }}</p><p>{{ msg("session") }}</p>
      <div class="record-actions"><button @click="e.refresh()">{{ t("onlineExecution.refreshNow") }}</button><details><summary>{{ msg("settings") }}</summary><label>{{ t("onlineExecution.refresh") }} <input type="number" min="1" max="2147483647" :value="e.statusRefreshMs" @change="event => { try {e.setRefreshMs(Number((event.target as HTMLInputElement).value))} catch(err){reportError(err)} }" /> ms</label></details></div>
      <p v-if="!rows.length">{{ msg("noRecords") }}</p><button v-if="!rows.length" @click="changePane('launch')">{{ msg("launch") }}</button>
      <button v-for="row in rows" :key="row.key" class="record-row" :aria-current="row.key===selectedKey" :data-record="row.key" @click="choose(row)"><strong :title="row.name">{{ row.name }}</strong>
        <small>{{ row.job || row.run?.location.kind==='agent' ? t("onlineExecution.agent") : t("onlineExecution.local") }} · {{ row.kind ? code(row.kind) : t("onlineExecution.statusOnly") }}</small>
        <small>{{ row.state }}<template v-if="row.verdict"> · {{ row.verdict }}</template></small><small :title="row.time">{{ recordTime(row.time,locale) ?? msg("notRecorded") }}</small></button>
    </aside><article class="record-detail"><button v-if="selected && !hideDetail" @click="returnList">{{ msg("back") }}</button>
      <template v-if="selectedRow && !hideDetail"><h3>{{ selectedRow.name }}</h3><p v-if="selectedRow.time">{{ msg("submitted") }} · <time :title="selectedRow.time">{{ recordTime(selectedRow.time,locale) }}</time></p></template>
      <p v-if="hideDetail || !selected">{{ msg("pick") }}</p><OnlineExecutionPanel v-show="!hideDetail && (selected || e.error)" :execution="e" report-only :ai="ai" @collaboration="emit('collaboration',$event)" />
    </article></div>
    <OnlineSchedulesPanel v-if="pane==='schedules'" :execution="e" :schedules="schedules" :draft-dirty="dirty" @report="scheduleReport" />
    <OnlineNotificationsPanel v-if="pane==='notifications'" :schedules="schedules" @navigate="notification" />
  </section>
</template>
<style scoped src="../../styles/run-records.css"></style>
<style scoped>
.run-host{min-height:0;height:100%;min-width:0;display:flex;flex-direction:column;overflow:hidden;color:var(--text);background:var(--bg)}
.run-host>:last-child,.records-layout{min-height:0}.run-tabs{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid var(--border);padding:6px 12px}.run-tabs button,.return{border:0;background:transparent;color:var(--text-muted);padding:7px 10px;cursor:pointer;font:inherit}.run-tabs button[aria-current=true]{color:var(--accent);box-shadow:inset 0 -2px var(--accent)}.return{align-self:flex-start;color:var(--accent)}input[type=number]{max-width:92px}.record-detail{padding:12px}.record-detail :deep(.execution){border:0;padding:8px 2px}.record-actions{align-items:baseline}
</style>

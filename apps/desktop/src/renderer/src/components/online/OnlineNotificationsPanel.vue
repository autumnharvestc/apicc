<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useWorkbenchPosition } from "../../stores/workbenchPosition.js";
import type { NotificationEvent } from '@apicc/execution/contract';
import type { NotificationPosition } from '../../stores/onlineSchedules.js';
import { recordTime, useRecordMessages } from '../../execution/recordMessages.js';
import { useI18n } from 'vue-i18n';
import type { OnlineSchedulesStore } from '../../stores/onlineSchedules.js';
import OnlineDeliveryList from './OnlineDeliveryList.vue';
const props = defineProps<{ schedules: OnlineSchedulesStore }>();
const emit = defineEmits<{ navigate: [event: NotificationEvent, dest: 'schedules'|'records', position: NotificationPosition] }>();
const msg = useRecordMessages();
const workbench = useWorkbenchPosition(() => JSON.stringify(props.schedules.context));
const scroll = ref<HTMLElement>(), selected = ref(''), unavailable = ref(false), refreshToken = ref(0);
const events = computed(() => props.schedules.notifications?.items ?? []);
const current = computed(() => events.value.find(item => item.id === selected.value) ?? (!selected.value && !unavailable.value ? events.value[0] : undefined));
function select(event: NotificationEvent) {
  unavailable.value = false; selected.value = event.id;
  if (props.schedules.error === "linked-record-unavailable") props.schedules.error = "";
  props.schedules.restorePosition = null;
  workbench.value.notification = { eventId:event.id, scrollTop:scroll.value?.scrollTop ?? 0, pages:props.schedules.notificationPages };
}
function keepScroll() {
  if (current.value) workbench.value.notification = {eventId: current.value.id, scrollTop:scroll.value?.scrollTop ?? 0, pages:props.schedules.notificationPages};
}
function navigate(event: NotificationEvent, dest: 'schedules'|'records') {
  selected.value = event.id;
  const point = { eventId: event.id, scrollTop: scroll.value?.scrollTop ?? 0, pages: props.schedules.notificationPages };
  workbench.value.notification = point; emit('navigate', event, dest, point);
}
const { t, te, locale } = useI18n();
const label = (code: string | null) => !code ? t('onlineExecution.notCollected') : te('scheduleDelivery.' + code) ? t('scheduleDelivery.' + code) : te('scheduleCodes.' + code) ? t('scheduleCodes.' + code) : te('onlineExecution.states.' + code) ? t('onlineExecution.states.' + code) : code;
function executionLabel(value?: string | null) {
  if (!value) return t("onlineExecution.notCollected");
  if (te("onlineExecution.states." + value)) return t("onlineExecution.states." + value);
  if (te("stress.workbench.verdict." + value)) return t("stress.workbench.verdict." + value);
  return value;
}
const reason = (value: string) => { if (value === 'linked-record-unavailable') return msg('unavailable'); const safe = value.match(/(?:^|Error: )([a-z][a-z0-9_-]{0,95})$/)?.[1]; if (!safe) return t('scheduleEditor.requestFailed'); for (const namespace of ['scheduleCodes', 'onlineExecution.reasons', 'startRejectionLabels']) if (te(namespace + '.' + safe)) return t(namespace + '.' + safe); return safe; };
const time = (value: string | null) => value ? new Intl.DateTimeFormat(locale.value, { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hourCycle: 'h23' }).format(new Date(value)) + ' UTC' : t('onlineExecution.notCollected');
watch(() => [props.schedules.context, props.schedules.visible, props.schedules.restorePosition, refreshToken.value] as const, async ([context, visible, restore], previous, cleanup) => {
  if (previous?.[0] !== context) { selected.value = ""; unavailable.value = false; }
  if (!context || !visible) return;
  if (!restore && previous?.[2] && previous[0]===context && previous[1]===visible && previous[3] === refreshToken.value) return;
  let live = true; cleanup(() => { live = false; });
  const point = restore ?? workbench.value.notification;
  await props.schedules.loadNotifications();
  if (!point || !live) return;
  const seen = new Set<string>();
  while (live && props.schedules.notificationPages < point.pages && props.schedules.notifications?.nextBeforeId) {
    const cursor = props.schedules.notifications.nextBeforeId;
    if (seen.has(cursor)) break;
    seen.add(cursor); await props.schedules.loadNotifications(cursor);
  }
  if (!live || restore && props.schedules.restorePosition !== restore) return;
  if (!props.schedules.notifications?.items.some(item => item.id === point.eventId)) {
    unavailable.value = true; selected.value = ""; workbench.value.notification = null;
    if (restore) props.schedules.restorePosition = null;
    props.schedules.error = "linked-record-unavailable"; return;
  }
  selected.value = point.eventId; await nextTick();
  if (live && scroll.value) {
    scroll.value.scrollTop = point.scrollTop;
    scroll.value.querySelector<HTMLElement>('[aria-current="true"] button')?.focus({ preventScroll: true });
    if (point.unavailable) props.schedules.error='linked-record-unavailable';
    props.schedules.restorePosition = null;
  }
}, { immediate: true });
</script>
<template>
  <section class="notifications online-surface">
    <aside class="event-list">
      <header><h2>{{ t('runRecords.noticeList') }}</h2><button data-testid="notification-refresh" @click="keepScroll(); refreshToken++">{{ t('runRecords.refresh') }}</button></header>
      <div ref="scroll" class="event-scroll" @scroll="keepScroll">
        <p v-if="schedules.notifications && !events.length && !schedules.error" role="status">{{ t('scheduleNotifications.empty') }}</p>
        <article v-for="event in events" :key="event.id" :aria-current="current?.id === event.id">
          <button class="event-row" type="button" :data-event="event.id" @click="select(event)">
            <span class="read-dot" :class="{read:event.read}" :title="t(event.read ? 'scheduleCenter.read' : 'scheduleCenter.unread')"></span>
            <span class="event-name"><strong>{{ event.scheduleName }}</strong><small>{{ event.projectName }}</small><span class="sr-only">{{ t(event.read ? 'scheduleCenter.read' : 'scheduleCenter.unread') }}</span></span>
            <span class="verdict" :data-verdict="event.verdict">{{ event.verdict ? executionLabel(event.verdict) : event.eventKind === 'paused' ? t('scheduling.paused') : event.eventKind === 'skipped' ? executionLabel('skipped') : executionLabel(null) }}</span>
            <time :title="time(event.plannedAtUtc)">{{ event.plannedAtUtc ? recordTime(event.plannedAtUtc,locale,true) + ' UTC' : t('onlineExecution.notCollected') }}</time>
          </button>
        </article>
      </div>
      <button v-if="schedules.notifications?.nextBeforeId" class="more-events" data-testid="notification-more" @click="schedules.loadNotifications(schedules.notifications.nextBeforeId)">{{ t('schedulePagination.notifications') }}</button>
    </aside>
    <main class="notice-detail">
      <p v-if="schedules.error" role="alert">{{ reason(schedules.error) }}</p>
      <p v-if="!current && !schedules.error">{{ t('runRecords.selectEvent') }}</p>
      <template v-if="current">
        <header><h2>{{ current.scheduleName }}</h2><button v-if="!current.read" data-testid="notification-read" @click="schedules.markRead(current.id)">{{ t('scheduleCenter.markRead') }}</button></header>
        <h3>{{ t('runRecords.noticeResult') }}</h3>
        <dl><dt>{{ t('onlineExecution.verdict') }}</dt><dd><span class="verdict" :data-verdict="current.verdict">{{ executionLabel(current.verdict) }}</span></dd>
          <dt>{{ t('scheduleHistory.reason') }}</dt><dd>{{ reason(current.reasonCode) }}</dd>
          <dt>{{ t('onlineExecution.archive') }}</dt><dd>{{ current.reportState === 'pending' ? t('runRecords.pendingArchive') : executionLabel(current.reportState) }}</dd>
          <dt>{{ t('scheduleHistory.planned') }}</dt><dd>{{ time(current.plannedAtUtc) }}</dd>
          <dt>{{ t('scheduleHistory.actual') }}</dt><dd>{{ time(current.startedAtUtc) }}</dd></dl>
        <div class="links"><button data-testid="notification-plan" @click="navigate(current,'schedules')">{{ msg("plan") }}</button><button data-testid="notification-run" :disabled="!current.jobId || !current.executionId" @click="navigate(current,'records')">{{ msg("run") }}</button></div>
        <p v-if="!current.jobId || !current.executionId" role="status">{{ msg("noRun") }}</p>
        <h3>{{ t('runRecords.delivery') }}</h3><p v-if="!current.deliveries.length">{{ label(current.notificationState) }}</p><OnlineDeliveryList :deliveries="current.deliveries" />
      </template>
    </main>
  </section>
</template>
<style scoped src="../../styles/online-controls.css"></style>
<style scoped>
.notifications { min-height: 0; min-width: 0; flex: 1; display: grid; grid-template-columns: minmax(0,1fr) minmax(0,1.02fr); gap: 8px; padding: 9px; }
.event-list, .notice-detail { min-width: 0; min-height: 0; padding: 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 7px; }
.event-list { display:flex; flex-direction:column; }
.notice-detail, .event-scroll { overflow: auto; }
header, .links { display: flex; align-items: center; gap: 8px; }
header { min-height: 28px; margin-bottom: 12px; }
header h2 { margin: 0; flex: 1; font-size: 18px; }
.notice-detail h3 { margin: 18px 0 8px; font-size: 16px; }
.event-row { display: grid; width: 100%; min-height: 48px; grid-template-columns: 10px minmax(0,1fr) auto auto; align-items: center; gap: 10px; text-align: start; padding: 7px 10px; border: 0; border-bottom: 1px solid var(--border); border-radius: 0; background: var(--bg); }
article[aria-current=true] .event-row { box-shadow: inset 3px 0 var(--accent); background: var(--active-weak); }
.event-name strong,.event-name small { display:block; overflow-wrap:anywhere; }
.event-row time, .event-name small { color: var(--text-muted); font-size: 12px; }
.read-dot { width: 9px; height: 9px; border: 1px solid var(--accent); background: var(--accent); border-radius:50%; }
.read-dot.read { background: transparent; border-color: var(--text-muted); }
.sr-only { position: absolute; width: 1px; height: 1px; clip-path: inset(50%); overflow:hidden; }
.more-events { margin: auto auto 0; }
.notice-detail dl { display:grid; grid-template-columns:minmax(max-content,28%) minmax(0,1fr); border-top:1px solid var(--border); }
.notice-detail dd,.notice-detail dt { padding:4px; margin:0; border-bottom:1px solid var(--border); overflow-wrap:anywhere; }
.links button { flex:1; }
.verdict { display:inline-block; padding:1px 5px; background:var(--subtle); border-radius:4px; }
.verdict[data-verdict=failed] { color:var(--fail); background:color-mix(in srgb,var(--fail) 12%, var(--bg)); }
.verdict[data-verdict=passed] { color:var(--pass); background:color-mix(in srgb,var(--pass) 12%, var(--bg)); }
@container (max-width:650px) { .notifications { grid-template-columns:minmax(0,1fr); grid-template-rows:minmax(105px,35%) minmax(0,1fr); } .event-row { grid-template-columns:10px minmax(0,1fr) auto; } .event-row time { display:none; } }
</style>

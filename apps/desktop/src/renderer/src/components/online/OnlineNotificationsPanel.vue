<script setup lang="ts">
import { watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { OnlineSchedulesStore } from '../../stores/onlineSchedules.js';
import OnlineDeliveryList from './OnlineDeliveryList.vue';
const props = defineProps<{ schedules: OnlineSchedulesStore }>();
const { t, te, locale } = useI18n();
const label = (code: string | null) => !code ? t('onlineExecution.notCollected') : te('scheduleDelivery.' + code) ? t('scheduleDelivery.' + code) : te('scheduleCodes.' + code) ? t('scheduleCodes.' + code) : te('onlineExecution.states.' + code) ? t('onlineExecution.states.' + code) : code;
const reason = (value: string) => { const safe = value.match(/(?:^|Error: )([a-z][a-z0-9_-]{0,95})$/)?.[1]; if (!safe) return t('scheduleEditor.requestFailed'); for (const namespace of ['scheduleCodes', 'onlineExecution.reasons', 'startRejectionLabels']) if (te(namespace + '.' + safe)) return t(namespace + '.' + safe); return safe; };
const time = (value: string | null) => value ? new Intl.DateTimeFormat(locale.value, { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hourCycle: 'h23' }).format(new Date(value)) + ' UTC' : t('onlineExecution.notCollected');
watch(() => [props.schedules.context, props.schedules.visible] as const, ([context, visible]) => { if (context && visible) void props.schedules.loadNotifications(); }, { immediate: true });
</script>
<template><section class="notifications online-surface"><header><h3>{{ t('scheduleNotifications.title') }}</h3><p>{{ t('scheduleNotifications.scope') }}</p><button @click="schedules.loadNotifications()">{{ t('scheduleCenter.refresh') }}</button><button v-if="schedules.notifications?.nextBeforeId" data-testid="notification-more" @click="schedules.loadNotifications(schedules.notifications.nextBeforeId)">{{ t('schedulePagination.notifications') }}</button></header><p v-if="schedules.error" role="alert">{{ reason(schedules.error) }}</p><div class="event-scroll"><p v-if="schedules.notifications && !schedules.notifications.items.length && !schedules.error" class="empty-state" role="status">{{ t('scheduleNotifications.empty') }}</p><article v-for="event in schedules.notifications?.items ?? []" :key="event.id"><h3 :title="event.scheduleName">{{ event.scheduleName }}</h3><p :title="event.projectName">{{ event.projectName }} · #{{ event.scheduleId }}</p><p>{{ t('scheduleCenter.verdict', { value: event.verdict ? t('onlineExecution.states.' + event.verdict) : t('onlineExecution.notCollected') }) }}</p><dl><dt>{{ t('scheduleHistory.planned') }}</dt><dd><time :title="event.plannedAtUtc ?? undefined">{{ time(event.plannedAtUtc) }}</time></dd><dt>{{ t('scheduleHistory.actual') }}</dt><dd>{{ time(event.startedAtUtc) }}</dd><dt>{{ t('scheduleHistory.archive') }}</dt><dd>{{ t('onlineExecution.states.' + event.reportState) }}</dd><dt>{{ t('scheduleHistory.reason') }}</dt><dd>{{ reason(event.reasonCode) }}</dd></dl><p>{{ t(event.read ? 'scheduleCenter.read' : 'scheduleCenter.unread') }}</p><button v-if="!event.read" data-testid="notification-read" @click="schedules.markRead(event.id)">{{ t('scheduleCenter.markRead') }}</button><section><h4>{{ t('scheduleHistory.notification') }} · {{ label(event.notificationState) }}</h4><OnlineDeliveryList :deliveries="event.deliveries" /></section></article></div></section></template>
<style scoped src="../../styles/online-controls.css"></style>
<style scoped>

.notifications{height:100%;min-height:0;min-width:0;display:flex;flex-direction:column;overflow:hidden;background:var(--panel)}
header{padding:16px 20px;background:var(--bg);border-bottom:1px solid var(--border);flex:none}header p{color:var(--text-muted);margin:8px 0}header button{margin-right:8px}header h3{margin:0}
.event-scroll{min-height:0;overflow:auto;padding:16px 20px;scrollbar-gutter:stable}article{background:var(--bg);border:1px solid var(--border);border-radius:10px;box-shadow:var(--panel-shadow);padding:16px;margin:0 0 16px;min-width:0}
h3{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}article>p{margin:8px 0}article>section{border-top:1px solid var(--border);margin-top:14px}dl{display:grid;grid-template-columns:minmax(80px,.3fr) minmax(0,1fr);gap:8px 16px}dd{margin:0;overflow-wrap:anywhere}
@media(max-width:600px){header,.event-scroll{padding:12px}article{padding:12px}}

</style>

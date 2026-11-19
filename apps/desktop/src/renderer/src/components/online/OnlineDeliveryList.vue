<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { NotificationDelivery } from '@apicc/execution/contract';
defineProps<{ deliveries: NotificationDelivery[] }>();
const { t, te } = useI18n();
const label = (code: string) => te('scheduleDelivery.' + code) ? t('scheduleDelivery.' + code) : te('scheduleCodes.' + code) ? t('scheduleCodes.' + code) : code;
</script>
<template>
  <ul class="delivery-list">
    <li v-for="delivery in deliveries" :key="delivery.id">
      <dl><dt>Webhook</dt><dd><span :data-state="delivery.state">{{ label(delivery.state) }}</span></dd>
        <dt>{{ t('runRecords.attempts') }}</dt><dd>{{ delivery.attempts }}</dd>
        <template v-if="delivery.status !== null"><dt>{{ t('runRecords.httpStatus') }}</dt><dd>HTTP {{ delivery.status }}</dd></template>
        <template v-if="delivery.reasonCode && label(delivery.reasonCode) !== label(delivery.state)"><dt>{{ t('scheduleHistory.reason') }}</dt><dd>{{ label(delivery.reasonCode) }}</dd></template>
      </dl>
      <details><summary>{{ t('scheduleDelivery.details') }}</summary><dl><dt>ID</dt><dd>{{ delivery.id }}</dd>
        <dt>{{ t('runRecords.channelVersion') }}</dt><dd>Webhook #{{ delivery.channelId }} · {{ delivery.channelVersion }}</dd>
        <dt>{{ t('scheduleDelivery.deadline') }}</dt><dd>{{ delivery.deadlineUtc }}</dd><dt>{{ t('scheduleDelivery.next') }}</dt><dd>{{ delivery.nextAttemptAtUtc ?? t('scheduleDelivery.none') }}</dd></dl></details>
    </li>
  </ul>
</template>
<style scoped src="../../styles/online-controls.css"></style>
<style scoped>

.delivery-list { list-style:none; padding:0; margin:0; }
.delivery-list li { overflow-wrap:anywhere; margin-bottom:8px; }
dl { display:grid; grid-template-columns:minmax(90px,28%) minmax(0,1fr); margin:5px 0; }
dt,dd { margin:0; padding:4px; border-bottom:1px solid var(--border); }
[data-state=acknowledged] { color:var(--pass); background:color-mix(in srgb,var(--pass) 12%,var(--bg)); border-radius:4px; padding:1px 5px; }
details { margin-top:7px; } summary { cursor:pointer; }
</style>

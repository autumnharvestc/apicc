<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { NotificationDelivery } from '@apicc/execution/contract';
defineProps<{ deliveries: NotificationDelivery[] }>();
const { t, te } = useI18n();
const label = (code: string) => te('scheduleDelivery.' + code) ? t('scheduleDelivery.' + code) : te('scheduleCodes.' + code) ? t('scheduleCodes.' + code) : code;
</script>
<template><ul class="delivery-list"><li v-for="delivery in deliveries" :key="delivery.id"><p>Webhook #{{ delivery.channelId }} · {{ t('scheduleDetails.version') }} {{ delivery.channelVersion }} · {{ label(delivery.state) }}</p><p v-if="delivery.reasonCode">{{ label(delivery.reasonCode) }}</p><p>{{ delivery.attempts }} {{ t('scheduleDelivery.attempts') }}<template v-if="delivery.status !== null"> · HTTP {{ delivery.status }}</template></p><details><summary>{{ t('scheduleDelivery.details') }}</summary><dl><dt>ID</dt><dd>{{ delivery.id }}</dd><dt>{{ t('scheduleDelivery.deadline') }}</dt><dd>{{ delivery.deadlineUtc }} UTC</dd><dt>{{ t('scheduleDelivery.next') }}</dt><dd>{{ delivery.nextAttemptAtUtc ?? t('scheduleDelivery.none') }}</dd></dl></details></li></ul></template>
<style scoped src="../../styles/online-controls.css"></style>
<style scoped>

.delivery-list{list-style:none;padding:0;display:grid;gap:10px}.delivery-list li{background:var(--subtle);border:1px solid var(--border);border-radius:8px;padding:10px 14px;overflow-wrap:anywhere}.delivery-list p{margin:5px 0}dl{display:grid;grid-template-columns:minmax(80px,.3fr) minmax(0,1fr);gap:8px 12px}dd{margin:0;overflow-wrap:anywhere}

</style>

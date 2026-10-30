<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { NotificationDelivery } from '@apicc/execution/contract';
defineProps<{ deliveries: NotificationDelivery[] }>();
const { t, te } = useI18n();
const label = (code: string) => te('scheduleDelivery.' + code) ? t('scheduleDelivery.' + code) : te('scheduleCodes.' + code) ? t('scheduleCodes.' + code) : code;
</script>
<template><ul class="delivery-list"><li v-for="delivery in deliveries" :key="delivery.id"><p>Webhook #{{ delivery.channelId }} · {{ t('scheduleDetails.version') }} {{ delivery.channelVersion }} · {{ label(delivery.state) }}</p><p v-if="delivery.reasonCode">{{ label(delivery.reasonCode) }}</p><p>{{ delivery.attempts }} {{ t('scheduleDelivery.attempts') }}<template v-if="delivery.status !== null"> · HTTP {{ delivery.status }}</template></p><details><summary>{{ t('scheduleDelivery.details') }}</summary><dl><dt>ID</dt><dd>{{ delivery.id }}</dd><dt>{{ t('scheduleDelivery.deadline') }}</dt><dd>{{ delivery.deadlineUtc }} UTC</dd><dt>{{ t('scheduleDelivery.next') }}</dt><dd>{{ delivery.nextAttemptAtUtc ?? t('scheduleDelivery.none') }}</dd></dl></details></li></ul></template>
<style scoped>.delivery-list{padding-left:20px}.delivery-list p{margin:5px 0}.delivery-list li{margin:8px 0;overflow-wrap:anywhere}dl{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px}dd{margin:0;overflow-wrap:anywhere}</style>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useRecordMessages } from "../execution/recordMessages.js";
import type { OnlineRunPane } from "../stores/onlineSchedules.js";

const props = defineProps<{ pane: OnlineRunPane; online?: boolean }>();
defineEmits<{ navigate: [pane: OnlineRunPane] }>();
const { t } = useI18n();
const label = useRecordMessages();
const tabs = computed(() => [
  { pane: "launch" as const, name: label("launch"), localId: "run-launch-tab" },
  { pane: "records" as const, name: label("records"), localId: "runs-history-btn" },
  ...(props.online ? [
    { pane: "schedules" as const, name: t("scheduling.title"), localId: "" },
    { pane: "notifications" as const, name: label("notifications"), localId: "" },
  ] : []),
]);
</script>
<template>
  <section class="run-workbench">
    <header class="run-header">
      <h1>{{ t("nav.run") }}</h1>
      <nav class="run-tabs" :aria-label="t('nav.run')">
        <button v-for="tab in tabs" :key="tab.pane" type="button" :data-testid="online ? 'run-pane-' + tab.pane : tab.localId"
          :aria-current="pane === tab.pane ? 'page' : undefined" @click="$emit('navigate', tab.pane)">{{ tab.name }}</button>
      </nav>
    </header>
    <slot />
  </section>
</template>
<style scoped>
.run-workbench { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: auto; color: var(--text); background: var(--workbench-background); container-type: inline-size; }
.run-header { flex: none; border-bottom: 1px solid var(--border); }
.run-header h1 { margin: 0; padding: 12px 17px 3px; font-size: 22px; line-height: 1.35; font-weight: 650; }
.run-header nav { display: flex; overflow-x: auto; padding-inline: 10px; }
.run-header button { flex: none; padding: 7px 13px 8px; border: 0; border-bottom: 3px solid transparent; border-radius: 0; background: transparent; color: var(--text); cursor: pointer; font: inherit; font-weight: 500; }
.run-header button[aria-current] { border-bottom-color: var(--accent); color: var(--accent); font-weight: 650; }
</style>

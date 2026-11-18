<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { DownOutlined, GlobalOutlined, DesktopOutlined } from "@ant-design/icons-vue";
import type { DebugEnvironmentSelection } from "../debugEnvironment.js";
import type { OnlineExecutionStore } from "../stores/onlineExecution.js";
import ActionMenu from "./ActionMenu.vue";
import { onlineExecutionLocationIssue } from "../onlineExecutionLocation.js";

const props = defineProps<{
  owner: string;
  environment: DebugEnvironmentSelection;
  execution?: OnlineExecutionStore;
  disabled?: boolean;
}>();
const emit = defineEmits<{ details: [] }>();
const { t, te } = useI18n();
const environmentMenu = ref<InstanceType<typeof ActionMenu>>();
const locationMenu = ref<InstanceType<typeof ActionMenu>>();
const openedOwner = ref("");
function closeMenus() {
  environmentMenu.value?.close(false);
  locationMenu.value?.close(false);
  openedOwner.value = "";
}
watch(() => [props.owner, props.disabled, props.execution?.context], closeMenus, { flush: "sync" });
onBeforeUnmount(closeMenus);

const baseEnvironment = computed(() => t(props.execution ? "onlineExecution.baseEnvironment" : "editor.noEnv"));
const options = computed(() => props.environment.options.map(({key, name}) => ({
  key: `env:${key}`, testId: `project-env-option-${key}`,
  label: props.environment.options.some(option => option.key !== key && option.name === name) ? `${name} · ${key}` : name,
  checked: props.environment.value === key,
})));
const environmentName = computed(() => props.environment.value === null ? baseEnvironment.value
  : options.value.find(option => option.checked)?.label ?? t("environmentShortcut.unavailable"));
const environments = computed(() => [{ key: "base", testId: "project-env-option-base", label: baseEnvironment.value, checked: props.environment.value === null }, ...options.value]);
const locationName = computed(() => {
  const location = props.execution?.location;
  if (location?.kind !== "agent") return t("onlineExecution.local");
  return props.execution?.agents?.agents.find(agent => agent.id === location.agentId)?.name ?? location.agentId;
});
function translate(key: string) { return te(key) ? t(key) : key.split(".").at(-1); }
const locationIssue = computed(() => props.execution && onlineExecutionLocationIssue(props.execution));
const locations = computed(() => {
  const execution = props.execution;
  if (!execution) return [];
  const location = execution.location;
  return [
    { key: "local", testId: "project-location-local", label: t("onlineExecution.local"), checked: location.kind === "local", disabled: execution.running },
    ...(execution.agents?.agents ?? []).map(agent => {
      const issue = onlineExecutionLocationIssue(execution, agent.id);
      return {
        key: `agent:${agent.id}`, testId: `project-agent-option-${agent.id}`,
        label: issue ? `${agent.name} · ${translate(issue)}` : agent.name,
        checked: location.kind === "agent" && location.agentId === agent.id,
        disabled: execution.running || !!issue,
      };
    }),
    { key: "details", testId: "project-execution-details-entry", label: t("projectWorkbench.executionDetails"), divider: true },
  ];
});
function selectEnvironment(key: string) {
  if (openedOwner.value !== props.owner || props.disabled || props.execution?.running) return;
  if (key === "base") props.environment.select(null);
  else if (options.value.some(option => option.key === key)) props.environment.select(key.slice("env:".length));
}
function selectLocation(key: string) {
  const execution = props.execution;
  if (!execution || openedOwner.value !== props.owner || props.disabled) return;
  if (key === "details") { emit("details"); return; }
  if (execution.running || !locations.value.some(option => option.key === key && !("disabled" in option && option.disabled))) return;
  execution.selectLocation(key === "local" ? { kind: "local" } : { kind: "agent", agentId: key.slice("agent:".length) });
}
</script>

<template>
  <footer class="project-status-bar" data-testid="project-status-bar">
    <ActionMenu ref="environmentMenu" class="context-choice" test-id="project-environment"
      :label="`${t('projectWorkbench.environment')} · ${environmentName}`"
      :items="environments" :disabled="disabled || execution?.running"
      @opened="openedOwner = owner" @select="selectEnvironment">
      <GlobalOutlined />
      <span class="context-label">{{ t("projectWorkbench.environment") }}</span>
      <span class="current-value">{{ environmentName }}</span>
      <DownOutlined class="chevron" />
    </ActionMenu>
    <ActionMenu v-if="execution" ref="locationMenu" class="context-choice" test-id="project-execution-location"
      :label="`${t('onlineExecution.location')} · ${locationName}${locationIssue ? ' · ' + translate(locationIssue) : ''}`"
      :disabled="disabled" :items="locations" @opened="openedOwner = owner" @select="selectLocation">
      <DesktopOutlined />
      <span class="context-label">{{ t("onlineExecution.location") }}</span>
      <span class="current-value" :class="{ unavailable: locationIssue }">{{ locationName }}</span>
      <DownOutlined class="chevron" />
    </ActionMenu>
  </footer>
</template>

<style scoped>
.project-status-bar { display: flex; flex: 0 0 30px; align-items: center; gap: 8px; min-width: 0; padding: 0 8px; border-top: 1px solid var(--border); background: var(--workbench-rail); }
.project-status-bar :deep(.context-choice) { flex: 0 1 auto; min-width: 0; max-width: 50%; min-height: 26px; font-size: 12px; gap: 6px; }
.context-label, .chevron { flex: none; font-size: 11px; color: var(--text-muted); }
.chevron { font-size: 8px; }
.current-value { white-space: nowrap; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
.unavailable { color: var(--fail); }
</style>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { DownOutlined, GlobalOutlined } from "@ant-design/icons-vue";
import { useI18n } from "vue-i18n";
import type { DebugEnvironmentSelection } from "../debugEnvironment.js";
import ActionMenu from "./ActionMenu.vue";

const props = defineProps<{
  selection: DebugEnvironmentSelection | null;
  testId: string;
  rail?: boolean;
  manage?: boolean;
  disabled?: boolean;
  loading?: boolean;
}>();
const emit = defineEmits<{ manage: [] }>();
const { t } = useI18n();
const actionMenu = ref<InstanceType<typeof ActionMenu>>();
const items = computed(() => {
  const selection = props.selection;
  const options = selection?.options ?? [];
  const choices = selection ? [
    { key: "none", label: t("editor.noEnv"), checked: selection.value === null, testId: "debug-env-option-none" },
    ...options.map((option) => ({
      key: `env:${option.key}`,
      label: options.filter((candidate) => candidate.name === option.name).length > 1 ? `${option.name} · ${option.key}` : option.name,
      checked: option.key === selection.value,
      testId: `debug-env-option-${option.key}`,
    })),
  ] : [];
  return [...choices, ...(props.manage ? [{ key: "manage", label: t("environmentShortcut.manage"), divider: choices.length > 0, testId: "manage-environments" }] : [])];
});
const currentName = computed(() => {
  const selection = props.selection;
  if (!selection) return props.loading ? t("environmentShortcut.loading") : t("nav.envs");
  if (selection.value === null) return t("editor.noEnv");
  return selection.options.find((option) => option.key === selection.value)?.name ?? t("environmentShortcut.unavailable");
});
const title = computed(() => selectionLabel(currentName.value));
function selectionLabel(name: string) {
  const selection = props.selection;
  if (!selection || !selection.value) return name === t("nav.envs") ? t("environmentShortcut.selectRequest") : name;
  const option = selection.options.find((candidate) => candidate.key === selection.value);
  const duplicate = option && selection.options.some((candidate) => candidate.key !== option.key && candidate.name === option.name);
  return duplicate ? `${t("nav.envs")} · ${name} · ${option.key}` : `${t("nav.envs")} · ${name}`;
}
const openOwner = ref<string | null>(null);
watch(() => props.selection?.owner, () => actionMenu.value?.close());
watch(() => props.disabled, (disabled) => { if (disabled) actionMenu.value?.close(false); });

function select(key: string) {
  if (key === "manage") {
    if (props.disabled || !props.manage) return;
    emit("manage");
    return;
  }
  const selection = props.selection;
  if (props.disabled || !selection || selection.owner !== openOwner.value) return;
  if (key === "none") selection.select(null);
  else {
    const value = key.slice("env:".length);
    if (selection.options.some((option) => option.key === value)) selection.select(value);
  }
}
</script>

<template>
  <div class="environment-control" :class="{ 'environment-rail-control': rail }">
  <ActionMenu
    ref="actionMenu"
    class="debug-environment-menu"
    :class="{ 'environment-rail': rail }"
    :test-id="testId"
    :label="title"
    :disabled="disabled || !items.length"
    :items="items"
    @opened="openOwner = selection?.owner ?? null"
    @select="select"
  >
    <GlobalOutlined class="environment-icon" />
    <span class="environment-current">{{ currentName }}</span>
    <DownOutlined class="environment-arrow" />
  </ActionMenu>
  </div>
</template>

<style scoped>
.debug-environment-menu { min-width: 0; }
.environment-current { min-width: 0; max-width: 14ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.environment-rail-control :deep(.menu-trigger.environment-rail) {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 10px;
  grid-template-rows: 17px auto;
  align-items: center;
  gap: 3px 0;
  padding: 4px 2px;
  border-color: var(--border);
  background: var(--workbench-directory);
  font-size: 11px;
  min-height: 46px;
  width: 100%;
}
.environment-rail-control .environment-icon { grid-area: 1 / 1; justify-self: center; font-size: 16px; }
.environment-rail-control .environment-arrow { grid-area: 1 / 2; justify-self: center; }
.environment-rail-control .environment-current { grid-area: 2 / 1 / 3 / 3; width: 100%; max-width: none; text-align: center; line-height: 1.35; }
.environment-arrow { font-size: 8px; }
</style>

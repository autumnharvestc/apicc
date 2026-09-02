<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ApiccApi } from "../../shared/types.js";
import type { useWorkspaceStore } from "../stores/workspace.js";
import ThemeLanguageToggle from "./ThemeLanguageToggle.vue";
import ConfirmDialog from "./ConfirmDialog.vue";

/**
 * 顶栏：工作区名 + 打开/新建工作区 + 语言/主题切换。
 * store 与 api 经 props 注入（组合根一次装配；组件内部不调工厂、不持有第二个 api 实例）。
 */
const props = defineProps<{
  workspace: ReturnType<typeof useWorkspaceStore>;
  api: ApiccApi;
}>();
const { t } = useI18n();

const dialogOpen = ref(false);
const pendingRoot = ref("");

async function openWorkspace() {
  const dir = await props.api.wsPickDirectory();
  if (dir) await props.workspace.open(dir);
}

async function startCreate() {
  const dir = await props.api.wsPickDirectory();
  if (!dir) return; // 用户取消目录选择
  pendingRoot.value = dir;
  dialogOpen.value = true;
}

async function onCreateConfirm(name: string | null) {
  dialogOpen.value = false;
  if (name) await props.workspace.create(pendingRoot.value, name);
}
</script>

<template>
  <header class="topbar" data-testid="topbar">
    <span class="name" data-testid="workspace-name">{{ workspace.name || t("app.openWorkspace") }}</span>
    <span v-if="workspace.problems.length" class="problems" data-testid="workspace-problems">
      {{ t("workspace.problems") }}: {{ workspace.problems.length }}
    </span>
    <span class="spacer"></span>
    <button data-testid="open-workspace" @click="openWorkspace">{{ t("app.openWorkspace") }}</button>
    <button data-testid="new-workspace" @click="startCreate">{{ t("app.newWorkspace") }}</button>
    <ThemeLanguageToggle />
    <ConfirmDialog
      :open="dialogOpen"
      :title="t('app.newWorkspace')"
      :input-placeholder="t('app.workspaceName')"
      @confirm="onCreateConfirm"
      @cancel="dialogOpen = false"
    />
  </header>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
.name { font-weight: 600; }
.problems { color: var(--fail); font-size: 12px; }
.spacer { flex: 1; }
button {
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
}
</style>

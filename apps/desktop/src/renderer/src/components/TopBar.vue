<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Space as ASpace, Button as AButton, Tag as ATag, Typography as ATypography, Select as ASelect, Drawer as ADrawer } from "ant-design-vue";
import { SettingOutlined, HomeOutlined } from "@ant-design/icons-vue";
import type { ApiccApi } from "../../../shared/types.js";
import type { useWorkspaceStore } from "../stores/workspace.js";
import type { useTreeStore } from "../stores/tree.js";
import type { createOnlineStore } from "../stores/online.js";
import type { createPluginsStore } from "../stores/plugins.js";
import ThemeLanguageToggle from "./ThemeLanguageToggle.vue";
import PluginsView from "./PluginsView.vue";

const ATypographyText = ATypography.Text;

/**
 * 顶栏（M9-C 层级调整）：工作区/模式徽标 + 项目切换下拉（本地模式；选中即切换活动
 * 项目——侧树作用域化至该项目）+ 在线模式入口 + 设置抽屉（插件管理，插件归应用设置项）
 * + 语言/主题。本地目录的 打开/新建 迁至主页（HomeView）；远程在线仍走既有登录对话框。
 * store 与 api 经 props 注入（组合根一次装配）；reportError 为组合根错误反馈通道。
 */
const props = defineProps<{
  workspace: ReturnType<typeof useWorkspaceStore>;
  tree: ReturnType<typeof useTreeStore>;
  api: ApiccApi;
  online: ReturnType<typeof createOnlineStore>;
  plugins: ReturnType<typeof createPluginsStore>;
  reportError: (e: unknown) => void;
}>();
const emit = defineEmits<{ "open-home": [] }>();
const { t } = useI18n();

const settingsOpen = ref(false);

// —— 项目切换（本地模式）：选中树中的项目节点，侧树作用域化至该项目 ——
const projects = computed(() =>
  (props.workspace.tree?.children ?? [])
    .flatMap((g) => g.children ?? [])
    .filter((n) => n.kind === "project")
    .map((p) => ({ label: p.label, value: p.id })),
);
// 选中任意节点时回溯其所属项目（与 App 的 selectedProjectId 同口径——仅选中项目节点
// 时显示会让接口/集合选中后下拉退回占位符）。
const activeProjectId = computed(() => {
  const sel = props.tree.selected;
  if (!sel || !props.workspace.tree) return undefined;
  if (sel.kind === "project") return sel.id;
  const contains = (node: { id: string; children?: Array<{ id: string; children?: unknown[] }> }): boolean =>
    (node.children ?? []).some((c) => c.id === sel.id || contains(c as never));
  for (const g of props.workspace.tree.children ?? []) {
    for (const p of g.children ?? []) {
      if (p.id === sel.id || contains(p)) return p.id;
    }
  }
  return undefined;
});

function onProjectSelect(id: string) {
  props.tree.select("project", id);
}

async function exitOnline() {
  try {
    await props.online.closeWorkspace();
  } catch (e) {
    props.reportError(e);
  }
}
</script>

<template>
  <header class="topbar" data-testid="topbar">
    <a-typography-text strong data-testid="workspace-name">
      {{ online.activeWorkspace?.name ?? (workspace.name || t("app.openWorkspace")) }}
    </a-typography-text>
    <!-- 主页入口（M11）：取代本地/在线徽标位置——模式由打开项目的来源决定 -->
    <a-button size="small" data-testid="topbar-home" @click="emit('open-home')">
      <HomeOutlined />
      {{ t("nav.home") }}
    </a-button>
    <!-- 项目切换（M9-C，本地模式）：归属项目的栏目随项目切换 -->
    <a-select
      v-if="!online.activeWorkspace && workspace.opened"
      class="project-switch"
      :value="activeProjectId"
      :options="projects"
      :placeholder="t('topbar.projectPlaceholder')"
      data-testid="project-switch"
      @update:value="(v) => onProjectSelect(v as string)"
    />
    <a-typography-text v-if="workspace.problems.length && !online.activeWorkspace" type="danger" data-testid="workspace-problems">
      {{ t("workspace.problems") }}: {{ workspace.problems.length }}
    </a-typography-text>
    <span class="spacer"></span>
    <a-space :size="8">
      <!-- 迁移/退出（任务 3）：仅在线工作区激活时可见 -->
      <a-button v-if="online.activeWorkspace" data-testid="online-migrate" @click="online.migrateDialogOpen = true">
        {{ t("online.migrate") }}
      </a-button>
      <a-button v-if="online.activeWorkspace" data-testid="online-exit" @click="exitOnline">
        {{ t("online.exitOnline") }}
      </a-button>
      <!-- 在线模式入口：对话框本体由组合根渲染，按钮只置 online.dialogOpen -->
      <a-button data-testid="online-toggle" @click="props.online.dialogOpen = true">
        <span v-if="online.loggedIn" data-testid="online-status">
          {{ t("online.loggedInAs", { name: online.user?.displayName ?? "", server: online.activeName }) }}
        </span>
        <span v-else data-testid="online-status">{{ t("online.title") }}</span>
      </a-button>
      <!-- 设置抽屉（M9-C 裁定 D5）：插件管理归应用设置项 -->
      <a-button data-testid="settings-toggle" @click="settingsOpen = true">
        <SettingOutlined />
      </a-button>
      <ThemeLanguageToggle />
    </a-space>
    <a-drawer
      v-model:open="settingsOpen"
      :title="t('settings.title')"
      :width="560"
      data-testid="settings-drawer"
    >
      <PluginsView :plugins="plugins" />
    </a-drawer>
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
.spacer { flex: 1; }
.mode-badge {
  margin-inline-end: 0;
}
.project-switch { min-width: 180px; max-width: 260px; }
</style>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Space as ASpace, Button as AButton, Typography as ATypography, Select as ASelect, Drawer as ADrawer, Dropdown as ADropdown } from "ant-design-vue";
import { EllipsisOutlined, SettingOutlined } from "@ant-design/icons-vue";
import type { ApiccApi } from "../../../shared/types.js";
import type { useWorkspaceStore } from "../stores/workspace.js";
import type { useTreeStore } from "../stores/tree.js";
import type { createOnlineStore } from "../stores/online.js";
import type { createPluginsStore } from "../stores/plugins.js";
import type { createTabsStore, ProjectTab } from "../stores/tabs.js";
import type { ProjectLocator } from "../../../shared/locations.js";
import ThemeLanguageToggle from "./ThemeLanguageToggle.vue";
import ProjectTabs from "./ProjectTabs.vue";
import PluginsView from "./PluginsView.vue";
import NetworkSettings from "./NetworkSettings.vue";
import ConfirmDialog from "./ConfirmDialog.vue";

const ATypographyText = ATypography.Text;

/**
 * 顶栏（M9-C 层级调整）：工作区/模式徽标 + 项目切换下拉（本地模式；选中即切换活动
 * 项目——侧树作用域化至该项目）+ 在线模式入口 + 设置抽屉（插件管理，插件归应用设置项）
 * + 语言/主题。本地目录的 打开/新建 迁至主页（HomeView）；远程在线仍走既有登录对话框。
 * store 与 api 经 props 注入（组合根一次装配）；reportError 为组合根错误反馈通道。
 * 计划 C 任务 6（不变量 4）：退出在线工作区 = 工作区级关闭唯一入口，改为确认 Modal——
 * 列出该工作区的签（项目名 + 草稿态，tabs store 的 projectHasDrafts 统计），确认后先
 * tabs.closeWorkspaceTabs（关其全部签+驱逐各项目会话，签级不再确认）再 online.closeWorkspace。
 */
const props = defineProps<{
  workspace: ReturnType<typeof useWorkspaceStore>;
  tree: ReturnType<typeof useTreeStore>;
  api: ApiccApi;
  online: ReturnType<typeof createOnlineStore>;
  plugins: ReturnType<typeof createPluginsStore>;
  tabs: ReturnType<typeof createTabsStore>;
  reportError: (e: unknown) => void;
}>();
const { t } = useI18n();

const settingsOpen = ref(false);
const activeLocalProjectTab = computed(() => {
  const tab = props.tabs.activeTab;
  if (!tab || !("projectLocator" in tab) || tab.workspaceRef.kind !== "local" || props.workspace.root !== tab.workspaceRef.dir) return null;
  return tab;
});

// —— 项目切换（本地模式）：value 为完整 ProjectLocator，避免跨分组同 ID 串项 ——
const projects = computed(() =>
  (props.workspace.tree?.children ?? [])
    .flatMap((g) => g.children ?? [])
    .filter((n) => n.kind === "project")
    .map((p) => ({ label: p.label, value: JSON.stringify(p.locator) })),
);
function onProjectSelect(value: string) {
  try {
    const locator = JSON.parse(value) as ProjectLocator;
    const project = props.workspace.findProject(locator);
    if (project) void props.tabs.openProjectTab(
      { kind: "local", dir: props.workspace.root },
      { locator: project.locator, name: project.label },
    );
  } catch (error) {
    props.reportError(error);
  }
}

function openSettings() {
  settingsOpen.value = true;
}

// —— 退出在线工作区（计划 C 任务 6，不变量 4：工作区级关闭唯一入口，确认弹窗列出受影响签）——
const exitConfirmOpen = ref(false);
/** 打开确认时快照受影响签（确认期间签表变化不漂移展示）。 */
const exitAffectedTabs = ref<ProjectTab[]>([]);

function requestExitOnline() {
  const ws = props.online.activeWorkspace;
  if (!ws) return;
  exitAffectedTabs.value = props.tabs.tabs.filter(
    (tab) => tab.workspaceRef.kind === "online" && tab.workspaceRef.workspaceId === ws.id,
  );
  exitConfirmOpen.value = true;
}

async function onExitConfirm() {
  exitConfirmOpen.value = false;
  const ws = props.online.activeWorkspace;
  if (!ws) return;
  try {
    // 先关该工作区全部签（逐签驱逐项目会话；工作区级关闭本身已经确认，签级不再拦截），
    // 再出表关闭工作区会话（在线树/编辑缓冲随会话释放，顶栏工作区名随 activeWorkspace 复位）。
    await props.tabs.closeWorkspaceTabs({ kind: "online", workspaceId: ws.id, name: ws.name });
    await props.online.closeWorkspace(ws.id);
  } catch (e) {
    props.reportError(e);
  }
}

function onExitCancel() {
  exitConfirmOpen.value = false;
}
</script>

<template>
  <header class="topbar" data-testid="topbar">
    <a-typography-text strong class="workspace-name" data-testid="workspace-name" :title="online.activeWorkspace?.name ?? (workspace.name || t('app.openWorkspace'))">
      {{ online.activeWorkspace?.name ?? (workspace.name || t("app.openWorkspace")) }}
    </a-typography-text>
    <ProjectTabs class="project-navigation" :tabs="tabs" />
    <!-- 项目下拉是查找/打开入口；当前选择只由统一页签栏表示。 -->
    <a-select
      v-if="!online.activeWorkspace && workspace.opened"
      class="project-switch"
      :value="undefined"
      :options="projects"
      :placeholder="t('topbar.projectPlaceholder')"
      data-testid="project-switch"
      @update:value="(v) => onProjectSelect(v as string)"
    />
    <a-typography-text v-if="workspace.problems.length && !online.activeWorkspace" type="danger" data-testid="workspace-problems">
      {{ t("workspace.problems") }}: {{ workspace.problems.length }}
    </a-typography-text>
    <a-space class="topbar-tools" :size="6">
      <!-- 迁移/退出（任务 3）：仅在线工作区激活时可见 -->
      <a-button v-if="online.activeWorkspace" size="small" data-testid="online-migrate" @click="online.migrateDialogOpen = true">
        {{ t("online.migrate") }}
      </a-button>
      <a-button v-if="online.activeWorkspace" size="small" data-testid="online-exit" @click="requestExitOnline">
        {{ t("online.exitOnline") }}
      </a-button>
      <!-- 在线模式入口：对话框本体由组合根渲染，按钮只置 online.dialogOpen -->
      <a-button size="small" class="online-toggle" data-testid="online-toggle" :title="online.loggedIn ? t('online.loggedInAs', { name: online.user?.displayName ?? '', server: online.activeName }) : t('online.title')" @click="props.online.dialogOpen = true">
        <span class="online-icon" aria-hidden="true">◉</span>
        <span v-if="online.loggedIn" class="online-label" data-testid="online-status">
          {{ t("online.loggedInAs", { name: online.user?.displayName ?? "", server: online.activeName }) }}
        </span>
        <span v-else class="online-label" data-testid="online-status">{{ t("online.title") }}</span>
      </a-button>
      <!-- 设置抽屉（M9-C 裁定 D5）：插件管理归应用设置项 -->
      <a-button size="small" data-testid="settings-toggle" :title="t('settings.title')" @click="openSettings">
        <SettingOutlined />
      </a-button>
      <ThemeLanguageToggle class="topbar-theme" />
      <a-dropdown class="topbar-more" :trigger="['click']" placement="bottomRight">
        <a-button size="small" :title="t('topbar.more')" :aria-label="t('topbar.more')" data-testid="topbar-more">
          <EllipsisOutlined />
        </a-button>
        <template #overlay>
          <div class="topbar-more-menu" role="menu">
            <button type="button" role="menuitem" data-testid="more-projects" @click="tabs.activateHome()">{{ t("topbar.projectPlaceholder") }}</button>
            <button type="button" role="menuitem" data-testid="more-online-toggle" @click="online.dialogOpen = true">{{ t("online.title") }}</button>
            <button type="button" role="menuitem" data-testid="more-settings" @click="openSettings">{{ t("settings.title") }}</button>
            <button v-if="online.activeWorkspace" type="button" role="menuitem" data-testid="more-online-migrate" @click="online.migrateDialogOpen = true">{{ t("online.migrate") }}</button>
            <button v-if="online.activeWorkspace" type="button" role="menuitem" data-testid="more-online-exit" @click="requestExitOnline">{{ t("online.exitOnline") }}</button>
            <ThemeLanguageToggle class="more-theme" />
          </div>
        </template>
      </a-dropdown>
    </a-space>
    <a-drawer
      v-model:open="settingsOpen"
      :title="t('settings.title')"
      :width="560"
      data-testid="settings-drawer"
    >
      <PluginsView :plugins="plugins" />
      <NetworkSettings
        v-if="activeLocalProjectTab"
        :key="`${activeLocalProjectTab.workspaceRef.dir}:${activeLocalProjectTab.projectLocator.workspaceId}:${activeLocalProjectTab.projectLocator.groupId}:${activeLocalProjectTab.projectLocator.projectId}`"
        :api="api"
        :locator="activeLocalProjectTab.projectLocator"
        :read-only="workspace.readOnly"
      />
    </a-drawer>
    <!-- 退出在线工作区确认（计划 C 任务 6）：a-modal 传送门渲染于 body，受影响签清单走默认插槽 -->
    <ConfirmDialog
      :open="exitConfirmOpen"
      :title="t('online.exitOnline')"
      @confirm="onExitConfirm"
      @cancel="onExitCancel"
    >
      <div data-testid="online-exit-impact">
        <p>{{ t("online.exitConfirmDesc", { count: exitAffectedTabs.length }) }}</p>
        <ul v-if="exitAffectedTabs.length > 0" class="exit-impact-list">
          <li
            v-for="(tab, index) in exitAffectedTabs"
            :key="tab.tabId"
            :data-testid="`online-exit-tab-${index}`"
          >
            {{ tab.projectName }}
            <span v-if="tabs.projectHasDrafts(tab.tabId)" data-testid="online-exit-draft">（{{ t("online.exitHasDraft") }}）</span>
          </li>
        </ul>
        <p v-else>{{ t("online.exitNoTabs") }}</p>
      </div>
    </ConfirmDialog>
  </header>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  height: 44px;
  flex: none;
  box-sizing: border-box;
  overflow: hidden;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
.workspace-name {
  flex: none;
  max-width: 150px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}
.project-navigation { flex: 1 1 auto; }
.topbar-tools { flex: none; min-width: 0; }
.mode-badge {
  margin-inline-end: 0;
}
.project-switch { width: 160px; flex: none; }
.online-toggle { max-width: 170px; }
.online-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.online-icon { display: none; }
.topbar-more { display: none; }
.topbar-more-menu {
  display: flex;
  flex-direction: column;
  min-width: 190px;
  padding: 4px;
  border-radius: 6px;
  background: var(--panel);
  box-shadow: 0 3px 12px rgb(0 0 0 / 18%);
}
.topbar-more-menu > button {
  padding: 7px 10px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text);
  text-align: start;
  cursor: pointer;
}
.topbar-more-menu > button:hover { background: var(--active-weak); }
.more-theme { padding: 6px 8px; border-top: 1px solid var(--border); }
.more-theme :deep(.toggles) { flex-wrap: wrap; }
/* 退出在线确认的受影响签清单（ConfirmDialog 默认插槽内容） */
.exit-impact-list {
  margin: 4px 0 0;
  padding-inline-start: 18px;
}

@media (max-width: 900px) {
  .workspace-name { max-width: 86px; }
  .project-switch { width: 120px; }
}

@media (max-width: 680px) {
  .workspace-name { display: none; }
  .project-switch { display: none; }
  .topbar-theme { display: none; }
  .topbar-more { display: inline-flex; }
  .topbar-tools :deep([data-testid="online-migrate"]),
  .topbar-tools :deep([data-testid="online-exit"]) { display: none; }
  .online-toggle { width: 32px; min-width: 32px; padding-inline: 0; }
  .online-label { display: none; }
  .online-icon { display: inline; }
}
</style>

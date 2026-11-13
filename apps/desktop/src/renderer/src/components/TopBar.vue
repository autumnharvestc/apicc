<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button as AButton, Drawer as ADrawer } from "ant-design-vue";
import { ExclamationCircleOutlined, SettingOutlined } from "@ant-design/icons-vue";
import type { ApiccApi } from "../../../shared/types.js";
import type { useWorkspaceStore } from "../stores/workspace.js";
import type { createOnlineStore } from "../stores/online.js";
import type { createPluginsStore } from "../stores/plugins.js";
import type { createTabsStore } from "../stores/tabs.js";
import ThemeLanguageToggle from "./ThemeLanguageToggle.vue";
import ProjectTabs from "./ProjectTabs.vue";
import PluginsView from "./PluginsView.vue";
import NetworkSettings from "./NetworkSettings.vue";
import OnlineExecutionCacheSettings from "./OnlineExecutionCacheSettings.vue";
import appIcon from "../../../../build/icon.png";

const props = defineProps<{
  workspace: ReturnType<typeof useWorkspaceStore>;
  api: ApiccApi;
  online: ReturnType<typeof createOnlineStore>;
  plugins: ReturnType<typeof createPluginsStore>;
  tabs: ReturnType<typeof createTabsStore>;
  reportError: (e: unknown) => void;
  ai?: import("../stores/ai.js").AiStore;
}>();
const { t } = useI18n();

const settingsOpen = ref(false);
const problemsOpen = ref(false);
const settingsTrigger = ref<HTMLButtonElement>();
const problemsTrigger = ref<HTMLButtonElement>();
const activeLocalProjectTab = computed(() => {
  const tab = props.tabs.activeTab;
  if (!tab || !("projectLocator" in tab) || props.workspace.root !== tab.workspaceRef.dir) return null;
  return tab;
});
const workspaceContext = ref<"local" | "online">(props.online.activeWorkspace ? "online" : "local");
watch(() => props.workspace.root, () => { workspaceContext.value = "local"; }, { flush: "sync" });
watch(() => props.online.activeWorkspace?.id, (id) => { workspaceContext.value = id ? "online" : "local"; }, { flush: "sync" });
watch(() => props.tabs.activeTab, (tab) => {
  if (tab) workspaceContext.value = tab.workspaceRef.kind;
}, { flush: "sync", immediate: true });
const workspaceName = computed(() => {
  const active = props.tabs.activeTab;
  if (active && "projectLocator" in active) return activeLocalProjectTab.value ? props.workspace.name || active.workspaceRef.dir : active.workspaceRef.dir;
  if (active) return props.online.activeWorkspace?.id === active.workspaceRef.workspaceId ? props.online.activeWorkspace.name : active.workspaceRef.name;
  return (workspaceContext.value === "online" ? props.online.activeWorkspace?.name : props.workspace.name)
    || props.workspace.name || props.online.activeWorkspace?.name || t("topbar.noWorkspace");
});
const showLocalProblems = computed(() => props.workspace.problems.length > 0
  && (activeLocalProjectTab.value !== null || (!props.tabs.activeTab && workspaceContext.value === "local")));
const hasNativeMenu = typeof window.apicc?.showApplicationMenu === "function";
const nativeOverlay = window.apicc?.windowsTitleBarOverlay === true;
let lastEditor: HTMLElement | null = null;

function rememberEditor(event: FocusEvent) {
  if (event.target instanceof HTMLElement && event.target.matches("input:not([type=button]), textarea, [contenteditable=true]")) {
    lastEditor = event.target;
  }
}

if (hasNativeMenu) {
  onMounted(() => document.addEventListener("focusin", rememberEditor));
  onBeforeUnmount(() => document.removeEventListener("focusin", rememberEditor));
}

function openApplicationMenu() {
  // Electron's native Edit roles use the focused renderer control.
  if (lastEditor?.isConnected && lastEditor.getClientRects().length > 0) lastEditor.focus({ preventScroll: true });
  void window.apicc?.showApplicationMenu?.().catch(props.reportError);
}

function restoreDrawerFocus(open: boolean, trigger: HTMLButtonElement | undefined) {
  if (open || props.ai?.configDialogOpen) return;
  const target = trigger?.isConnected ? trigger : document.querySelector<HTMLElement>('[data-testid="project-tabs"] [aria-selected="true"]');
  target?.focus({ preventScroll: true });
}
</script>

<template>
  <header class="topbar" :class="{ 'titlebar-overlay': nativeOverlay }" data-testid="topbar">
    <img class="app-icon" :src="appIcon" alt="" width="28" height="28" draggable="false" />
    <span class="workspace-name" data-testid="workspace-name" tabindex="0" :title="workspaceName">
      {{ workspaceName }}
      <span class="workspace-full-name" aria-hidden="true">{{ workspaceName }}</span>
    </span>
    <ProjectTabs class="project-navigation" :tabs="tabs" />
    <div class="topbar-tools">
      <button
        v-if="showLocalProblems"
        ref="problemsTrigger"
        type="button"
        class="topbar-button workspace-problems"
        data-testid="workspace-problems"
        :title="t('topbar.workspaceProblemCount', { count: workspace.problems.length })"
        :aria-label="t('topbar.workspaceProblemCount', { count: workspace.problems.length })"
        @click="problemsOpen = true"
      >
        <ExclamationCircleOutlined /> {{ workspace.problems.length }}
      </button>
      <ThemeLanguageToggle :show-application-menu="hasNativeMenu" @application-menu="openApplicationMenu" />
      <button ref="settingsTrigger" type="button" class="topbar-button" data-testid="settings-toggle" :title="t('settings.title')" :aria-label="t('settings.title')" @click="settingsOpen = true">
        <SettingOutlined />
      </button>
    </div>
    <a-drawer v-model:open="problemsOpen" :title="t('workspace.problems')" width="min(560px, 100vw)" @after-open-change="restoreDrawerFocus($event, problemsTrigger)">
      <ul class="problem-list">
        <li v-for="(problem, index) in workspace.problems" :key="index">
          <div>{{ problem.message }}</div>
          <small>{{ problem.file }}</small>
        </li>
      </ul>
    </a-drawer>
    <a-drawer v-model:open="settingsOpen" :title="t('settings.title')" width="min(560px, 100vw)" data-testid="settings-drawer" @after-open-change="restoreDrawerFocus($event, settingsTrigger)">
      <a-button v-if="ai" block data-testid="settings-ai" @click="settingsOpen = false; ai.configDialogOpen = true">{{ t("aiSettings.title") }}</a-button>
      <PluginsView :plugins="plugins" />
      <OnlineExecutionCacheSettings v-if="online.execution" :execution="online.execution" :open="settingsOpen" />
      <NetworkSettings
        v-if="activeLocalProjectTab"
        :key="`${activeLocalProjectTab.workspaceRef.dir}:${activeLocalProjectTab.projectLocator.workspaceId}:${activeLocalProjectTab.projectLocator.groupId}:${activeLocalProjectTab.projectLocator.projectId}`"
        :api="api"
        :locator="activeLocalProjectTab.projectLocator"
        :read-only="workspace.readOnly"
      />
    </a-drawer>
  </header>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  height: max(46px, env(titlebar-area-height, 0px));
  flex: none;
  box-sizing: border-box;
  padding: 0 8px;
  padding-left: calc(8px + env(titlebar-area-x, 0px));
  padding-right: calc(8px + max(0px, 100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw)));
  border-bottom: 1px solid var(--border);
  background: var(--workbench-topbar);
  color: var(--text);
}
.topbar.titlebar-overlay { app-region: drag; -webkit-app-region: drag; }
.app-icon { display: block; flex: none; }
.workspace-name {
  flex: 0 0 152px;
  min-width: 0;
  box-sizing: border-box;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
.workspace-full-name {
  display: none;
  position: fixed;
  z-index: 1100;
  inset: max(46px, env(titlebar-area-height, 0px)) auto auto calc(40px + env(titlebar-area-x, 0px));
  width: max-content;
  max-width: calc(100vw - 50px);
  max-height: calc(100vh - max(46px, env(titlebar-area-height, 0px)) - 8px);
  box-sizing: border-box;
  overflow: auto;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--control-radius, 6px);
  background: var(--bg);
  color: var(--text);
  white-space: normal;
  overflow-wrap: anywhere;
  pointer-events: none;
}
.workspace-name:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.workspace-name:focus-visible .workspace-full-name { display: block; }
.project-navigation { flex: 1 1 auto; }
.topbar-tools { display: flex; align-items: center; gap: 4px; flex: none; app-region: no-drag; -webkit-app-region: no-drag; }
.topbar-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 30px;
  height: 30px;
  padding: 0 6px;
  border: 1px solid transparent;
  border-radius: var(--control-radius, 6px);
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.topbar-button:hover { background: var(--active-weak); }
.topbar-button:focus-visible { outline-offset: -2px; }
.workspace-problems { color: var(--fail); }
.problem-list { padding-inline-start: 18px; overflow-wrap: anywhere; }
.problem-list li + li { margin-top: 8px; }
@media (max-width: 1023px) { .workspace-name { flex-basis: 112px; } }
@media (max-width: 759px) {
  .topbar { gap: 5px; }
  .workspace-name { flex-basis: 88px; }
}
@media (forced-colors: active) { .topbar-button { border-color: ButtonText; } }
</style>

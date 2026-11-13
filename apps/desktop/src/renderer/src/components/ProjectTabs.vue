<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { CloseOutlined, EditOutlined, HomeOutlined, LeftOutlined, RightOutlined, UnorderedListOutlined, WarningOutlined } from "@ant-design/icons-vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import ActionMenu from "./ActionMenu.vue";
import type { ProjectTab, TabsStore } from "../stores/tabs.js";

/**
 * 统一页面页签栏：固定主页首签 + 横向滚动项目签——项目名 + 关闭钮 + 激活高亮 + 离线态；
 * 溢出时仅项目区横向滚动。组合根注入 tabs store，主页与项目页共享同一选择状态。
 * 点项目签 activateTab（离线签
 * 点按即重试激活，激活失败文案由组合根经 tabs.error 上屏）；v-for :key 拼 index 防
 * path/id 碰撞。关签走 projectHasDrafts（聚合该项目全部草稿源：本地 editor 会话表任一槽
 * / 在线 `<projectId>/` 前缀缓冲槽 / workflowDesign 单会话归属过滤）——有草稿弹
 * ConfirmDialog「未保存的修改将丢弃」，确认后才 closeTab；无草稿直关。
 */
const props = defineProps<{ tabs: TabsStore }>();
const { t } = useI18n();

// —— 溢出检测与滚动箭头（jsdom/无布局环境 scrollWidth=clientWidth=0 → 恒不溢出）——
const scroller = ref<HTMLElement | null>(null);
const tablist = ref<HTMLElement | null>(null);
const overflow = ref(false);
const narrowTabs = ref(false);
const showProjectList = computed(() => props.tabs.tabs.length > 0 && (overflow.value || narrowTabs.value));
const projectOptions = computed(() => props.tabs.tabs.flatMap((tab) => [
  { key: `open:${tab.tabId}`, label: projectTabTitle(tab), checked: tab.tabId === props.tabs.activeTabId },
  ...(narrowTabs.value ? [{ key: `close:${tab.tabId}`, label: `${t("common.close")} ${projectTabTitle(tab)}` }] : []),
]));

function updateOverflow() {
  const el = scroller.value;
  if (!el) return;
  const home = tablist.value?.querySelector<HTMLElement>(".home-tab");
  const width = tablist.value?.clientWidth && home ? tablist.value.clientWidth - home.offsetWidth - 6 : el.clientWidth;
  const stripWidth = Array.from(el.children).reduce((total, child) => total + (child as HTMLElement).offsetWidth + 4, 0);
  overflow.value = Math.max(0, stripWidth - 4) > width + 1;
  narrowTabs.value = width < 170 && window.innerWidth < 760;
}

function revealTab(tabId: string | null) {
  const el = scroller.value;
  if (!el || !tabId) return;
  const entry = Array.from(el.children).find((child) => (child as HTMLElement).dataset.tabId === tabId);
  if (!entry) return;
  const visible = el.getBoundingClientRect();
  const target = entry.getBoundingClientRect();
  if (target.left < visible.left) el.scrollLeft += target.left - visible.left;
  else if (target.right > visible.right) el.scrollLeft += Math.min(target.right - visible.right, target.left - visible.left);
}

function scrollByDir(dir: -1 | 1) {
  const el = scroller.value;
  if (!el) return;
  // 直接改 scrollLeft（jsdom 无 Element.scrollBy；真实浏览器行为一致）
  el.scrollLeft += dir * Math.max(160, Math.floor(el.clientWidth * 0.8));
}

let resizeObserver: ResizeObserver | null = null;
onMounted(() => {
  updateOverflow();
  window.addEventListener("resize", updateOverflow);
  if (typeof ResizeObserver === "function" && scroller.value) {
    resizeObserver = new ResizeObserver(() => {
      updateOverflow();
      revealTab(props.tabs.activeTabId);
    });
    resizeObserver.observe(scroller.value);
  }
});
onBeforeUnmount(() => {
  window.removeEventListener("resize", updateOverflow);
  resizeObserver?.disconnect();
});
// 签增删改变内容宽度：DOM 更新后重判溢出
watch(
  () => props.tabs.tabs.length,
  () => void nextTick(updateOverflow),
);
watch(() => props.tabs.activeTabId, (id) => void nextTick(() => revealTab(id)), { flush: "post" });

// —— 点签激活（离线签点按即重试激活：activateTab 内部重跑工作区上下文编排）——
function onActivate(tabId: string) {
  void props.tabs.activateTab(tabId).then(() => revealTab(props.tabs.activeTabId));
}

function pickProject(key: string) {
  const tabId = key.slice(key.indexOf(":") + 1);
  if (key.startsWith("close:")) requestClose(tabId);
  else onActivate(tabId);
}

function onActivateHome() {
  props.tabs.activateHome();
}

function onTabKeydown(event: KeyboardEvent) {
  const tabs = Array.from(tablist.value?.querySelectorAll<HTMLButtonElement>("button[role=tab]") ?? []);
  const currentIndex = tabs.indexOf(event.currentTarget as HTMLButtonElement);
  if (currentIndex < 0 || tabs.length < 2) return;
  let targetIndex: number | null = null;
  if (event.key === "ArrowRight") targetIndex = (currentIndex + 1) % tabs.length;
  else if (event.key === "ArrowLeft") targetIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  else if (event.key === "Home") targetIndex = 0;
  else if (event.key === "End") targetIndex = tabs.length - 1;
  if (targetIndex === null) return;
  event.preventDefault();
  const target = tabs[targetIndex]!;
  target.focus();
  target.click();
}

function projectTabTitle(tab: ProjectTab): string {
  const context = "projectLocator" in tab ? `${tab.workspaceRef.dir} · ${tab.projectLocator.groupId}`
    : [tab.workspaceRef.name, tab.workspaceRef.baseUrl].filter(Boolean).join(" · ");
  return [tab.projectName, context, ...projectTabStatuses(tab)].join(" · ");
}

function projectTabStatuses(tab: ProjectTab): string[] {
  return [
    ...(props.tabs.isTabOffline(tab.tabId) ? [t("tabs.offline")] : []),
    ...(props.tabs.projectHasDrafts(tab.tabId) ? [t("tabs.draft")] : []),
  ];
}

function focusCurrentTab() {
  tablist.value?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus({ preventScroll: true });
}

// —— 关签（dirty 确认两分支）——
const closeConfirmOpen = ref(false);
const pendingCloseTabId = ref<string | null>(null);

const closeOrigin = ref<HTMLElement | null>(null);

function requestClose(tabId: string) {
  closeOrigin.value = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (props.tabs.projectHasDrafts(tabId)) {
    pendingCloseTabId.value = tabId;
    closeConfirmOpen.value = true;
    return;
  }
  void closeTab(tabId);
}

async function closeTab(tabId: string) {
  const origin = closeOrigin.value;
  closeOrigin.value = null;
  await props.tabs.closeTab(tabId);
  await nextTick();
  if (origin?.isConnected) origin.focus({ preventScroll: true });
  else focusCurrentTab();
}

function onCloseConfirm() {
  const tabId = pendingCloseTabId.value;
  pendingCloseTabId.value = null;
  closeConfirmOpen.value = false;
  if (tabId) void closeTab(tabId);
}

function onCloseCancel() {
  pendingCloseTabId.value = null;
  closeConfirmOpen.value = false;
  const origin = closeOrigin.value;
  closeOrigin.value = null;
  void nextTick(() => origin?.isConnected ? origin.focus({ preventScroll: true }) : focusCurrentTab());
}
</script>

<template>
  <div class="project-tabs">
    <div ref="tablist" class="tablist" data-testid="project-tabs" role="tablist" :aria-label="t('nav.home')">
    <button
      type="button"
      class="home-tab"
      :class="{ active: tabs.selectedPage.kind === 'home' }"
      data-testid="topbar-home"
      role="tab"
      :title="t('nav.home')"
      :aria-label="t('nav.home')"
      :aria-selected="tabs.selectedPage.kind === 'home' ? 'true' : 'false'"
      :tabindex="tabs.selectedPage.kind === 'home' ? 0 : -1"
      @click="onActivateHome"
      @keydown="onTabKeydown"
    >
      <HomeOutlined />
      <span>{{ t("nav.home") }}</span>
    </button>
    <button
      v-if="overflow && !narrowTabs"
      type="button"
      class="tabs-arrow"
      data-testid="tabs-arrow-left"
      :aria-label="t('tabs.scrollLeft')"
      @click="scrollByDir(-1)"
    >
      <LeftOutlined />
    </button>
    <div ref="scroller" class="tabs-scroll" data-testid="project-tabs-scroll" @scroll="updateOverflow">
      <div v-for="(tab, index) in tabs.tabs" :key="tab.tabId" class="tab-entry" :data-tab-id="tab.tabId" :class="{ active: tab.tabId === tabs.activeTabId }">
        <button
          type="button"
          class="tab-item"
          role="tab"
          :class="{ active: tabs.selectedPage.kind === 'project' && tab.tabId === tabs.selectedPage.tabId, offline: tabs.isTabOffline(tab.tabId) }"
          :data-active="tabs.selectedPage.kind === 'project' && tab.tabId === tabs.selectedPage.tabId ? 'true' : 'false'"
          :data-offline="tabs.isTabOffline(tab.tabId) ? 'true' : 'false'"
          :aria-selected="tabs.selectedPage.kind === 'project' && tab.tabId === tabs.selectedPage.tabId ? 'true' : 'false'"
          :aria-label="[tab.projectName, ...projectTabStatuses(tab)].join(' · ')"
          :tabindex="tabs.selectedPage.kind === 'project' && tab.tabId === tabs.selectedPage.tabId ? 0 : -1"
          :data-testid="`project-tab-${index}`"
          :title="projectTabTitle(tab)"
          @click="onActivate(tab.tabId)"
          @keydown="onTabKeydown"
        >
          <span class="tab-name">{{ tab.projectName }}</span>
          <WarningOutlined v-if="tabs.isTabOffline(tab.tabId)" class="tab-offline" />
          <EditOutlined v-if="tabs.projectHasDrafts(tab.tabId)" />
        </button>
        <button
          type="button"
          class="tab-close"
          :aria-label="`${t('common.close')} ${tab.projectName}`"
          :data-testid="`tab-close-${index}`"
          @click="requestClose(tab.tabId)"
        >
          <CloseOutlined />
        </button>
      </div>
    </div>
    <button
      v-if="overflow && !narrowTabs"
      type="button"
      class="tabs-arrow"
      data-testid="tabs-arrow-right"
      :aria-label="t('tabs.scrollRight')"
      @click="scrollByDir(1)"
    >
      <RightOutlined />
    </button>
    <ActionMenu v-if="showProjectList" class="tab-menu"
      test-id="project-tabs-list" :label="t('tabs.openProjects')" :items="projectOptions" @select="pickProject">
      <UnorderedListOutlined />
    </ActionMenu>
    </div>
    <!-- 关签 dirty 丢弃确认（有草稿才弹）：a-modal 传送门渲染于 body -->
    <ConfirmDialog
      :open="closeConfirmOpen"
      :title="t('tabs.closeConfirm')"
      @confirm="onCloseConfirm"
      @cancel="onCloseCancel"
    />
  </div>
</template>

<style scoped>
.project-tabs {
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
}
.tablist {
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  min-width: 0;
  height: 100%;
}
.home-tab,
.tab-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--control-radius, 6px);
  background: transparent;
  color: var(--text-muted);
  font: inherit;
  font-size: 13px;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
.home-tab {
  flex: none;
}
.home-tab:hover,
.tab-item:hover {
  background: var(--active-weak);
}
.home-tab.active,
.tab-entry.active {
  color: var(--accent);
  background: var(--bg);
  box-shadow: inset 0 2px 0 var(--accent);
}
.home-tab.active,
.tab-item.active {
  color: var(--accent);
  font-weight: 600;
}
.tab-entry {
  display: inline-flex;
  align-items: center;
  flex: none;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: var(--control-radius, 6px);
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
.tabs-scroll {
  display: flex;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  gap: 4px;
  margin-inline-start: 6px;
}
.tabs-scroll::-webkit-scrollbar {
  display: none;
}
.tab-item {
  max-width: 200px;
}
.tab-offline { color: var(--fail); }
.tab-name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.tab-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 26px;
  height: 28px;
  margin-inline-end: 4px;
  font-size: 10px;
  opacity: 0.7;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.tab-close:hover {
  opacity: 1;
  background: var(--active-weak);
}
.home-tab:focus-visible,
.tab-item:focus-visible,
.tab-close:focus-visible,
.tabs-arrow:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
/* 两侧滚动箭头：低对比辅助控件（仅溢出时出现） */
.tabs-arrow {
  flex: none;
  display: inline-flex;
  align-items: center;
  min-height: 30px;
  padding: 0 5px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  font-size: 11px;
  -webkit-app-region: no-drag;
  app-region: no-drag;
}
.tabs-arrow:hover {
  background: var(--active-weak);
}
.tab-menu { margin-inline-start: 3px; }
@media (max-width: 759px) {
  .home-tab { justify-content: center; width: 32px; padding: 0; }
  .home-tab > span:not(.anticon) { display: none; }
  .tab-item { max-width: 122px; padding: 0 6px; }
}
@media (forced-colors: active) {
  .home-tab.active, .tab-entry.active { border: 1px solid Highlight; }
}
</style>

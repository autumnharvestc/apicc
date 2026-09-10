<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { CloseOutlined, LeftOutlined, RightOutlined } from "@ant-design/icons-vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import type { TabsStore } from "../stores/tabs.js";

/**
 * 项目页签栏（计划 C 任务 5，顶栏第二行）：渲染 tabs store 的项目签——项目名 + 关闭钮 +
 * 激活高亮 + 离线禁用态；溢出时横向滚动并显示两侧低对比箭头（仅溢出时显示）。
 * 组合根约定：tabs store 实例经 props 注入，组件内零工厂调用；点签 activateTab（离线签
 * 点按即重试激活，激活失败文案由组合根经 tabs.error 上屏）；v-for :key 拼 index 防
 * path/id 碰撞。关签走 projectHasDrafts（聚合该项目全部草稿源：本地 editor 会话表任一槽
 * / 在线 `<projectId>/` 前缀缓冲槽 / workflowDesign 单会话归属过滤）——有草稿弹
 * ConfirmDialog「未保存的修改将丢弃」，确认后才 closeTab；无草稿直关。
 */
const props = defineProps<{ tabs: TabsStore }>();
const { t } = useI18n();

// —— 溢出检测与滚动箭头（jsdom/无布局环境 scrollWidth=clientWidth=0 → 恒不溢出）——
const scroller = ref<HTMLElement | null>(null);
const overflow = ref(false);

function updateOverflow() {
  const el = scroller.value;
  if (!el) return;
  overflow.value = el.scrollWidth > el.clientWidth + 1;
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
    resizeObserver = new ResizeObserver(updateOverflow);
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

// —— 点签激活（离线签点按即重试激活：activateTab 内部重跑工作区上下文编排）——
function onActivate(tabId: string) {
  void props.tabs.activateTab(tabId);
}

// —— 关签（dirty 确认两分支）——
const closeConfirmOpen = ref(false);
const pendingCloseTabId = ref<string | null>(null);

function requestClose(tabId: string) {
  if (props.tabs.projectHasDrafts(tabId)) {
    pendingCloseTabId.value = tabId;
    closeConfirmOpen.value = true;
    return;
  }
  void props.tabs.closeTab(tabId);
}

function onCloseConfirm() {
  const tabId = pendingCloseTabId.value;
  pendingCloseTabId.value = null;
  closeConfirmOpen.value = false;
  if (tabId) void props.tabs.closeTab(tabId);
}

function onCloseCancel() {
  pendingCloseTabId.value = null;
  closeConfirmOpen.value = false;
}
</script>

<template>
  <div v-if="tabs.tabs.length > 0" class="project-tabs" data-testid="project-tabs">
    <button
      v-if="overflow"
      type="button"
      class="tabs-arrow"
      data-testid="tabs-arrow-left"
      :aria-label="t('tabs.scrollLeft')"
      @click="scrollByDir(-1)"
    >
      <LeftOutlined />
    </button>
    <div ref="scroller" class="tabs-scroll" data-testid="project-tabs-scroll" @scroll="updateOverflow">
      <div
        v-for="(tab, index) in tabs.tabs"
        :key="`${index}-${tab.tabId}`"
        class="tab-item"
        :class="{ active: tab.tabId === tabs.activeTabId, offline: tabs.isTabOffline(tab.tabId) }"
        :data-active="tab.tabId === tabs.activeTabId ? 'true' : 'false'"
        :data-offline="tabs.isTabOffline(tab.tabId) ? 'true' : 'false'"
        :aria-disabled="tabs.isTabOffline(tab.tabId) ? 'true' : undefined"
        :data-testid="`project-tab-${index}`"
        :title="tab.projectName"
        role="tab"
        @click="onActivate(tab.tabId)"
      >
        <span class="tab-name">{{ tab.projectName }}</span>
        <span
          class="tab-close"
          role="button"
          :aria-label="t('common.close')"
          :data-testid="`tab-close-${index}`"
          @click.stop="requestClose(tab.tabId)"
        >
          <CloseOutlined />
        </span>
      </div>
    </div>
    <button
      v-if="overflow"
      type="button"
      class="tabs-arrow"
      data-testid="tabs-arrow-right"
      :aria-label="t('tabs.scrollRight')"
      @click="scrollByDir(1)"
    >
      <RightOutlined />
    </button>
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
  align-items: stretch;
  min-height: 30px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
.tabs-scroll {
  display: flex;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.tabs-scroll::-webkit-scrollbar {
  display: none;
}
.tab-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 200px;
  padding: 4px 10px;
  border-right: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-muted);
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
}
.tab-item:hover {
  background: var(--active-weak);
}
.tab-item.active {
  color: var(--accent);
  font-weight: 600;
  background: var(--active-weak);
  box-shadow: inset 0 -2px 0 var(--accent);
}
/* 离线签：禁用视觉（点击仍触发重试激活，activateTab 失败保持离线态） */
.tab-item.offline {
  opacity: 0.45;
  cursor: not-allowed;
  text-decoration: line-through;
}
.tab-name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.tab-close {
  display: inline-flex;
  align-items: center;
  padding: 1px 2px;
  font-size: 10px;
  opacity: 0.5;
  border-radius: 3px;
}
.tab-close:hover {
  opacity: 1;
  background: var(--active-weak);
}
/* 两侧滚动箭头：低对比辅助控件（仅溢出时出现） */
.tabs-arrow {
  flex: none;
  display: inline-flex;
  align-items: center;
  padding: 0 6px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  opacity: 0.55;
  cursor: pointer;
  font-size: 11px;
}
.tabs-arrow:hover {
  opacity: 1;
}
</style>

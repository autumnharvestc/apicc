<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { CloseOutlined, EditOutlined, PlusOutlined } from "@ant-design/icons-vue";
import { useI18n } from "vue-i18n";
import type { ProjectLocator } from "../../../shared/locations.js";
import type { useEditorStore } from "../stores/editor.js";
import type { RequestTabsStore } from "../stores/requestTabs.js";
import { apiSessionKey } from "../stores/localIdentity.js";

const props = defineProps<{
  tabs: RequestTabsStore;
  editor: ReturnType<typeof useEditorStore>;
  root: string;
  project: ProjectLocator | null;
  hasDrafts?: (tabId: string) => boolean;
}>();
const emit = defineEmits<{ (event: "new-free"): void; (event: "activate", tabId: string): void }>();
const { t } = useI18n();
const list = ref<HTMLElement>();

function sameProject(left: ProjectLocator, right: ProjectLocator): boolean {
  return left.workspaceId === right.workspaceId && left.groupId === right.groupId && left.projectId === right.projectId;
}

const visibleIds = computed(() => props.project ? props.tabs.order.filter((id) => {
  const tab = props.tabs.tabs[id];
  return !!tab && tab.root === props.root && sameProject(tab.project, props.project!);
}) : []);

function title(tabId: string): string {
  const tab = props.tabs.tabs[tabId];
  if (!tab) return "";
  if (tab.source.kind === "free") return t("requestTabs.freeName");
  const key = apiSessionKey(tab.root, tab.source.locator);
  return key ? props.editor.sessions[key]?.api.contract.metadata.name ?? tab.source.locator.apiId : tab.source.locator.apiId;
}

function activate(tabId: string) {
  props.tabs.activate(tabId);
  emit("activate", tabId);
}

async function close(tabId: string) {
  const wasActive = props.tabs.activeId === tabId;
  const closed = await props.tabs.close(tabId);
  if (closed && wasActive && props.tabs.activeId) emit("activate", props.tabs.activeId);
}

watch(() => props.tabs.activeId, async (tabId) => {
  await nextTick();
  const viewport = list.value;
  const active = viewport?.querySelector<HTMLElement>('[aria-selected="true"]')?.parentElement;
  if (!tabId || !active || !viewport || viewport.scrollWidth <= viewport.clientWidth) return;
  const bounds = viewport.getBoundingClientRect();
  const item = active.getBoundingClientRect();
  if (item.left < bounds.left) viewport.scrollLeft += item.left - bounds.left;
  else if (item.right > bounds.right) viewport.scrollLeft += item.right - bounds.right;
});
</script>

<template>
  <nav class="request-tabs" data-testid="request-tabs" :aria-label="t('requestTabs.title')">
    <div ref="list" class="request-tab-list" role="tablist">
      <div v-for="tabId in visibleIds" :key="tabId" class="request-tab-entry" :class="{ active: tabs.activeId === tabId }">
        <button
          type="button"
          role="tab"
          class="request-tab"
          :class="{ active: tabs.activeId === tabId }"
          :aria-selected="tabs.activeId === tabId ? 'true' : 'false'"
          :data-testid="`request-tab-${tabId}`"
          :title="title(tabId)"
          :aria-label="hasDrafts?.(tabId) ? title(tabId) + ' · ' + t('tabs.draft') : title(tabId)"
          @click="activate(tabId)"
        >
          <span class="request-tab-name">{{ title(tabId) }}</span>
          <EditOutlined v-if="hasDrafts?.(tabId)" class="request-tab-draft" />
        </button>
        <button type="button" class="request-tab-close" :aria-label="`${t('common.close')} ${title(tabId)}`" :data-testid="`request-tab-close-${tabId}`" @click.stop="close(tabId)"><CloseOutlined /></button>
      </div>
    </div>
    <button type="button" class="request-tab-new" data-testid="request-tab-new-free" :disabled="!project" @click="emit('new-free')"><PlusOutlined /> {{ t("requestTabs.newFree") }}</button>
  </nav>
</template>

<style scoped>
.request-tabs { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 36px; flex: none; padding: 0 8px; border-bottom: 1px solid var(--border); background: var(--workbench-topbar); }
.request-tab-list { display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0; overflow-x: auto; }
.request-tab-entry { display: inline-flex; align-items: center; flex: none; min-width: 0; max-width: 220px; border: 1px solid transparent; border-radius: 5px; }
.request-tab-entry.active { border-color: var(--border); background: var(--bg); box-shadow: inset 0 2px var(--accent); }
.request-tab { display: flex; align-items: center; gap: 6px; min-width: 0; height: 29px; padding: 4px 8px; border: 0; border-radius: 5px; background: transparent; color: var(--text); cursor: pointer; font: inherit; font-size: 12px; }
.request-tab-draft { color: var(--accent); }
.request-tab-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.request-tab-close { flex: none; width: 26px; height: 28px; border: 0; border-radius: 4px; background: transparent; color: var(--text-muted); cursor: pointer; }
.request-tab-close:hover, .request-tab-new:hover:not(:disabled) { background: var(--active-weak); }
.request-tab:focus-visible, .request-tab-close:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.request-tab-new { flex: none; border: 1px solid var(--border); border-radius: 4px; padding: 4px 8px; background: var(--bg); color: var(--text); cursor: pointer; font: inherit; font-size: 12px; }
.request-tab-new:disabled { opacity: .5; cursor: not-allowed; }
</style>

<script setup lang="ts">
import { computed } from "vue";
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
}>();
const emit = defineEmits<{ (event: "new-free"): void; (event: "activate", tabId: string): void }>();
const { t } = useI18n();

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
</script>

<template>
  <nav class="request-tabs" data-testid="request-tabs" :aria-label="t('requestTabs.title')">
    <div class="request-tab-list" role="tablist">
      <div v-for="tabId in visibleIds" :key="tabId" class="request-tab-entry" :class="{ active: tabs.activeId === tabId }">
        <button
          type="button"
          role="tab"
          class="request-tab"
          :class="{ active: tabs.activeId === tabId }"
          :aria-selected="tabs.activeId === tabId ? 'true' : 'false'"
          :data-testid="`request-tab-${tabId}`"
          @click="activate(tabId)"
        >
          <span class="request-tab-kind">{{ tabs.tabs[tabId]?.source.kind === "free" ? t("requestTabs.freeShort") : t("requestTabs.assetShort") }}</span>
          <span class="request-tab-name">{{ title(tabId) }}</span>
        </button>
        <button type="button" class="request-tab-close" :aria-label="`${t('common.close')} ${title(tabId)}`" :data-testid="`request-tab-close-${tabId}`" @click.stop="close(tabId)">×</button>
      </div>
    </div>
    <button type="button" class="request-tab-new" data-testid="request-tab-new-free" :disabled="!project" @click="emit('new-free')">{{ t("requestTabs.newFree") }}</button>
  </nav>
</template>

<style scoped>
.request-tabs { display: flex; align-items: center; gap: 8px; min-width: 0; height: 38px; padding: 0 8px; border-bottom: 1px solid var(--border); background: var(--bg); }
.request-tab-list { display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0; overflow-x: auto; }
.request-tab-entry { display: inline-flex; align-items: center; min-width: 0; max-width: 220px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); }
.request-tab-entry.active { border-color: var(--accent); background: var(--active-weak); }
.request-tab { display: flex; align-items: center; gap: 6px; min-width: 0; padding: 4px 6px; border: 0; background: transparent; color: var(--text); cursor: pointer; font: inherit; font-size: 12px; }
.request-tab-kind { color: var(--text-muted); font-size: 10px; text-transform: uppercase; }
.request-tab-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.request-tab-close { flex: none; width: 22px; height: 24px; border: 0; background: transparent; color: var(--text-muted); cursor: pointer; }
.request-tab-new { flex: none; border: 1px solid var(--border); border-radius: 4px; padding: 4px 8px; background: var(--bg); color: var(--text); cursor: pointer; font: inherit; font-size: 12px; }
.request-tab-new:disabled { opacity: .5; cursor: not-allowed; }
</style>

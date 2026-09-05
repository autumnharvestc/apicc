<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Alert as AAlert, Button as AButton, Table as ATable, Tag as ATag } from "ant-design-vue";
import type { PluginLoadEntry } from "../../../shared/plugins/contract.js";
import type { PluginsStore } from "../stores/plugins.js";
import EmptyState from "./EmptyState.vue";

/**
 * 插件管理视图（M7-B 任务 1，规格 §2 D3/D5，裁定①②③）：只读清单——
 * 已加载插件（名称/版本/贡献分类 tag：分类 + 计数 + 名称明细）+ 失败项红 tag 与原因列
 * （D3 失败隔离诊断可见，裁定②）；空清单给「未登记插件」空态并指引 docs/plugins.md
 * （裁定③）。store 经 props 注入（组合根一次装配，组件内零工厂调用）；刷新钮走
 * store.refresh（失败经组件内 alert 上屏，既有清单保留）。
 */
const props = defineProps<{ plugins: PluginsStore }>();
const { t } = useI18n();

const columns = computed(() => [
  { title: t("plugins.colName"), dataIndex: "name", key: "name" },
  { title: t("plugins.status"), key: "kind", width: 88 },
  { title: t("plugins.colVersion"), dataIndex: "version", key: "version", width: 88 },
  { title: t("plugins.colContrib"), key: "contrib" },
  { title: t("plugins.colError"), key: "error" },
]);

// 六类贡献（与契约 PluginContributions 一致）：仅渲染非空分类，计数 = 名称数组长度。
const CONTRIB_KEYS = ["protocols", "auths", "asserts", "scripts", "reporters", "importers"] as const;

function contribTags(entry: PluginLoadEntry): Array<{ key: string; label: string; names: string[] }> {
  const c = entry.contributions;
  if (!c) return [];
  return CONTRIB_KEYS.map((key) => ({ key, label: t(`plugins.contrib.${key}`), names: c[key] })).filter(
    (g) => g.names.length > 0,
  );
}

/** 行级属性：testid 钩子 + 失败行红标（裁定②，CSS 按 data-failed 淡红底）。 */
function rowAttrs(record: PluginLoadEntry): Record<string, unknown> {
  return {
    "data-testid": "plugins-row",
    ...(record.kind === "failed" ? { "data-failed": "true" } : {}),
  };
}

function onRefresh() {
  void props.plugins.refresh();
}
</script>

<template>
  <section class="plugins-view" data-testid="plugins-view">
    <div class="head">
      <span class="title">{{ t("plugins.title") }}</span>
      <a-button size="small" data-testid="plugins-refresh" @click="onRefresh">{{ t("plugins.refresh") }}</a-button>
    </div>
    <a-alert v-if="plugins.error" type="error" :message="plugins.error" show-icon data-testid="plugins-error-alert" />
    <!-- 空清单（裁定③）：未登记插件空态 + 登记与开发指引（指向 docs/plugins.md） -->
    <div v-else-if="plugins.entries.length === 0" class="plugins-empty" data-testid="plugins-empty">
      <EmptyState :text="t('plugins.empty')" />
      <p class="guide">{{ t("plugins.emptyGuide") }}</p>
    </div>
    <a-table
      v-else
      class="table"
      :data-source="plugins.entries"
      :columns="columns"
      :pagination="false"
      :custom-row="rowAttrs"
      row-key="name"
      size="small"
      data-testid="plugins-table"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'kind'">
          <a-tag :color="record.kind === 'failed' ? 'error' : 'success'" data-testid="plugins-kind" :data-kind="record.kind">
            {{ record.kind === "failed" ? t("plugins.kindFailed") : t("plugins.kindLoaded") }}
          </a-tag>
        </template>
        <template v-else-if="column.key === 'version'">
          <span>{{ record.version ?? "—" }}</span>
        </template>
        <template v-else-if="column.key === 'contrib'">
          <!-- 行数据经 data-source（PluginLoadEntry[]）进入：slot 的宽 Record 类型在此收窄 -->
          <a-tag v-for="g in contribTags(record as PluginLoadEntry)" :key="g.key" class="contrib-tag" data-testid="plugins-contrib-tag">
            {{ g.label }} ×{{ g.names.length }}: {{ g.names.join(", ") }}
          </a-tag>
          <span v-if="contribTags(record as PluginLoadEntry).length === 0" class="muted">—</span>
        </template>
        <template v-else-if="column.key === 'error'">
          <span v-if="record.error" class="error-text" data-testid="plugins-error">{{ record.error }}</span>
          <span v-else class="muted">—</span>
        </template>
      </template>
    </a-table>
  </section>
</template>

<style scoped>
.plugins-view {
  padding: 8px 10px;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.title {
  font-weight: 600;
}
.plugins-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 24px 0;
}
.guide {
  margin: 0;
  color: var(--text-muted);
  font-size: 12px;
}
.contrib-tag {
  margin-inline-end: 4px;
}
.error-text {
  color: var(--fail);
}
.muted {
  color: var(--text-muted);
}
/* 失败行淡红底（红 tag + 原因列之外的行级红标钩子） */
.plugins-view :deep(tr[data-failed="true"]) {
  background: color-mix(in srgb, var(--fail) 8%, transparent);
}
</style>

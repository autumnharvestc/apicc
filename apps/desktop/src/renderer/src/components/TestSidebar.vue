<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Button as AButton, Tooltip as ATooltip } from "ant-design-vue";
import type { useWorkspaceStore } from "../stores/workspace.js";
import type { ApiLocator, ProjectLocator, WorkflowLocator } from "../../../shared/locations.js";
import { localTreeNodeKey } from "../../../shared/tree-dto.js";
import type { LocalTreeNodeDTO } from "../../../shared/tree-dto.js";

/**
 * 测试模块 API 栏（M11 自主视图侧栏迁入）：单接口用例 / 场景用例 锚点 + 活动项目的
 * 接口清单（按模块分组）与场景清单。选中状态（pane/apiId）由 moduleMemory store 经
 * props 持久——与接口模块的树互不干扰（M11 澄清③）。运行/工作流等动作回主视图处理。
 */
const props = defineProps<{
  workspace: ReturnType<typeof useWorkspaceStore>;
  activeProjectLocator: ProjectLocator | null;
  activeApiLocator: ApiLocator | null;
  pane: "api-cases" | "scenario";
  scenarios: Array<{ id: string; name: string; locator: WorkflowLocator }>;
  reportError: (e: unknown) => void;
}>();
const emit = defineEmits<{
  "update:pane": [pane: "api-cases" | "scenario"];
  "pick-api": [locator: ApiLocator];
  "open-workflow": [locator: WorkflowLocator];
}>();
const { t } = useI18n();

const apis = computed(() => {
  const project = props.activeProjectLocator ? props.workspace.findProject(props.activeProjectLocator) : null;
  const result: Array<{ id: string; key: string; label: string; collection: string; locator: ApiLocator }> = [];
  const visit = (node: LocalTreeNodeDTO, collection: string) => {
    if (node.kind === "api") result.push({
      id: node.id, key: node.key, label: node.label, collection,
      locator: { ...node.locator, folderIds: [...node.locator.folderIds] },
    });
    for (const child of node.children ?? []) visit(child, node.kind === "collection" ? node.label : collection);
  };
  for (const child of project?.children ?? []) visit(child, "");
  return result;
});

function sameApi(left: ApiLocator | null, right: ApiLocator): boolean {
  return !!left && localTreeNodeKey({ source: "local", kind: "api", locator: left }) === localTreeNodeKey({ source: "local", kind: "api", locator: right });
}

const moduleNames = computed(() => [...new Set(apis.value.map((a) => a.collection))]);
</script>

<template>
  <aside class="test-side" data-testid="test-sidebar">
    <div class="side-head">
      <span class="side-title" data-testid="sider-title">{{ t("nav.test") }}</span>
    </div>
    <div class="anchors">
      <button
        type="button"
        class="anchor-item"
        :class="{ active: pane === 'api-cases' }"
        data-testid="test-tab-api-cases"
        @click="emit('update:pane', 'api-cases')"
      >
        {{ t("test.apiCases") }}
      </button>
      <button
        type="button"
        class="anchor-item"
        :class="{ active: pane === 'scenario' }"
        data-testid="test-tab-scenario"
        @click="emit('update:pane', 'scenario')"
      >
        {{ t("test.scenarios") }}
      </button>
    </div>

    <template v-if="pane === 'api-cases'">
      <div v-for="m in moduleNames" :key="m" class="group-block">
        <div class="group-name">{{ m }}</div>
        <button
          v-for="a in apis.filter((x) => x.collection === m)"
          :key="a.key"
          type="button"
          class="api-item"
          :class="{ active: sameApi(activeApiLocator, a.locator) }"
          :data-testid="`test-api-${encodeURIComponent(a.key)}`"
          @click="emit('pick-api', a.locator)"
        >
          {{ a.label }}
        </button>
      </div>
      <span v-if="apis.length === 0" class="muted" data-testid="test-no-apis">{{ t("test.noApis") }}</span>
    </template>

    <template v-else>
      <div v-for="w in scenarios" :key="JSON.stringify(w.locator)" class="scenario-row" :data-testid="`test-scenario-${encodeURIComponent(JSON.stringify(w.locator))}`">
        <span class="scenario-name">{{ w.name }}</span>
        <a-tooltip :title="t('test.scenarioStressDeferred')">
          <a-button size="small" type="text" disabled data-testid="test-scenario-stress">{{ t("case.stress") }}</a-button>
        </a-tooltip>
        <a-button size="small" type="text" :data-testid="`test-scenario-run-${encodeURIComponent(JSON.stringify(w.locator))}`" @click="emit('open-workflow', w.locator)">
          {{ t("case.run") }}
        </a-button>
      </div>
      <span v-if="scenarios.length === 0" class="muted" data-testid="test-no-scenarios">{{ t("test.noScenarios") }}</span>
    </template>
  </aside>
</template>

<style scoped>
.test-side {
  width: 240px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--border);
  background: var(--bg);
  overflow-y: auto;
}
.side-head { padding: 8px 10px 0; }
.side-title { font-weight: 600; font-size: 13px; }
.anchors { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px 4px; }
.anchor-item {
  text-align: left;
  border: none;
  background: transparent;
  color: var(--text);
  padding: 5px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.anchor-item:hover { background: var(--hover); }
.anchor-item.active { background: var(--active-weak); color: var(--accent); }
.group-block { margin-top: 6px; }
.group-name { font-weight: 600; color: var(--text-muted); padding: 2px 10px; font-size: 12px; }
.api-item {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  color: var(--text);
  padding: 4px 10px 4px 18px;
  cursor: pointer;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.api-item:hover { background: var(--hover); }
.api-item.active { background: var(--active-weak); color: var(--accent); }
.scenario-row { display: flex; align-items: center; gap: 2px; padding: 2px 8px; border-radius: 6px; }
.scenario-row:hover { background: var(--hover); }
.scenario-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.muted { color: var(--text-muted); font-size: 12px; padding: 4px 10px; }
</style>

<script setup lang="ts">
import { computed, ref } from "vue";
import type { TestingPane } from "../../../shared/testing.js";
import type { TestingStore } from "../stores/testing.js";
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
  pane: TestingPane;
  testing?: TestingStore;
  scenarios: Array<{ id: string; name: string; locator: WorkflowLocator }>;
  reportError: (e: unknown) => void;
}>();
const emit = defineEmits<{
  "update:pane": [pane: TestingPane];
  "pick-api": [locator: ApiLocator];
  "open-workflow": [locator: WorkflowLocator];
  "stress-workflow": [locator: WorkflowLocator];
}>();
const { t } = useI18n();
const search = ref("");
const searchInput = ref<HTMLInputElement | null>(null);
function clearSearch() { search.value = ""; searchInput.value?.focus(); }
const visibleScenarios = computed(() => props.scenarios.filter(item => matches(item.name)));
const query = computed(() => search.value.trim().toLocaleLowerCase());
const matches = (name: string) => name.toLocaleLowerCase().includes(query.value);
const testingCurrent = computed(() => {
  const actual = props.testing?.view?.context.project; const selected = props.activeProjectLocator;
  return props.testing?.current && actual && selected && actual.workspaceId === selected.workspaceId && actual.groupId === selected.groupId && actual.projectId === selected.projectId;
});

const modules = computed(() => {
  const project = props.activeProjectLocator ? props.workspace.findProject(props.activeProjectLocator) : null;
  return (project?.children ?? []).filter((node) => node.kind === "collection").map((module) => {
    const apis: Array<{ key: string; label: string; path: string; method?: string; locator: ApiLocator }> = [];
    const visit = (node: LocalTreeNodeDTO, folders: string[]) => {
      if (node.kind === "api") {
        const path = [...folders, node.label].join(" / ");
        if (matches(path) || matches(module.label)) apis.push({
          key: node.key, label: node.label, path, method: node.method ?? (node.protocol === "websocket" ? "WS" : undefined),
          locator: { ...node.locator, folderIds: [...node.locator.folderIds] },
        });
      }
      const childrenPath = node.kind === "folder" ? [...folders, node.label] : folders;
      for (const child of node.children ?? []) visit(child, childrenPath);
    };
    visit(module, []);
    return { key: module.key, label: module.label, apis };
  }).filter((module) => module.apis.length);
});

function sameApi(left: ApiLocator | null, right: ApiLocator): boolean {
  return !!left && localTreeNodeKey({ source: "local", kind: "api", locator: left }) === localTreeNodeKey({ source: "local", kind: "api", locator: right });
}

async function editAsset(action: () => unknown | Promise<unknown>) { try { await action(); } catch (error) { props.reportError(error); } }
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
        :aria-current="pane === 'api-cases' ? 'page' : undefined"
        data-testid="test-tab-api-cases"
        @click="emit('update:pane', 'api-cases')"
      >
        {{ t("test.apiCases") }}
      </button>
      <button
        type="button"
        class="anchor-item"
        :class="{ active: pane === 'scenario' }"
        :aria-current="pane === 'scenario' ? 'page' : undefined"
        data-testid="test-tab-scenario"
        @click="emit('update:pane', 'scenario')"
      >
        {{ t("test.scenarios") }}
      </button>
      <button type="button" class="anchor-item" :class="{active: pane === 'suites'}" :aria-current="pane === 'suites' ? 'page' : undefined" data-testid="test-tab-suites" @click="emit('update:pane','suites')">{{ t('testing.suites') }}</button>
      <button type="button" class="anchor-item" :class="{active: pane === 'datasets'}" :aria-current="pane === 'datasets' ? 'page' : undefined" data-testid="test-tab-datasets" @click="emit('update:pane','datasets')">{{ t('testing.datasets') }}</button>
    </div>
    <div class="fixed-actions"><div class="search-field"><input ref="searchInput" v-model="search" :placeholder="t('testing.search')" :aria-label="t('testing.search')" /><button type="button" class="search-clear" data-testid="test-search-clear" :style="{ visibility: search ? 'visible' : 'hidden' }" :aria-label="t('testPresentation.clearSearch')" :title="t('testPresentation.clearSearch')" @click="clearSearch">×</button></div><button v-if="pane === 'datasets'" :disabled="!testingCurrent || testing?.readOnly" @click="editAsset(() => testing?.newDataset(t('testing.newDataset')))">{{ t('testing.newDataset') }}</button><button v-if="pane === 'suites'" :disabled="!testingCurrent || testing?.readOnly" @click="editAsset(() => testing?.newSuite(t('testing.newSuite')))">{{ t('testing.newSuite') }}</button></div>

    <div class="test-list" data-testid="test-navigation-list">
      <template v-if="pane === 'api-cases'">
        <div v-for="module in modules" :key="module.key" class="group-block">
          <div class="group-name">{{ module.label }}</div>
          <a-tooltip v-for="a in module.apis" :key="a.key" :title="`${module.label} / ${a.path}`" :trigger="['hover', 'focus']" placement="right">
            <button type="button" class="api-item api-detail" :class="{ active: sameApi(activeApiLocator, a.locator) }"
              :title="`${module.label} / ${a.path}`"
              :aria-current="sameApi(activeApiLocator, a.locator) ? 'true' : undefined"
              :data-testid="`test-api-${encodeURIComponent(a.key)}`" @click="emit('pick-api', a.locator)">
              <span v-if="a.method" class="method" :data-method="a.method">{{ a.method }}</span>
              <span class="api-name">{{ a.label }}</span>
            </button>
          </a-tooltip>
        </div>
        <span v-if="!modules.length" class="muted" data-testid="test-no-apis">{{ query ? t('testPresentation.noMatches') : t("test.noApis") }}</span>
      </template>

      <template v-else-if="pane === 'scenario'">
        <div v-for="w in visibleScenarios" :key="JSON.stringify(w.locator)" class="scenario-row" :data-testid="`test-scenario-${encodeURIComponent(JSON.stringify(w.locator))}`">
          <a-tooltip :title="w.name" :trigger="['hover', 'focus']" placement="right">
            <span tabindex="0" class="scenario-name" :title="w.name">{{ w.name }}</span>
          </a-tooltip>
          <a-tooltip :title="t('stress.workbench.title')">
            <a-button size="small" type="text" data-testid="test-scenario-stress" @click.stop="emit('stress-workflow', w.locator)">{{ t("case.stress") }}</a-button>
          </a-tooltip>
          <a-button size="small" type="text" :data-testid="`test-scenario-run-${encodeURIComponent(JSON.stringify(w.locator))}`" @click="emit('open-workflow', w.locator)">
            {{ t("case.run") }}
          </a-button>
        </div>
        <span v-if="visibleScenarios.length === 0" class="muted" data-testid="test-no-scenarios">{{ search ? t('testPresentation.noMatches') : t("test.noScenarios") }}</span>
      </template>
      <template v-else-if="testingCurrent && testing">
        <button v-for="item in (pane === 'datasets' ? testing.view?.datasets : testing.view?.suites)?.filter(item => matches(item.name))" :key="item.id" :title="item.name" type="button" class="api-item" :class="{active: testing.dataset?.id === item.id || testing.suite?.id === item.id}" @click="editAsset(() => testing!.select(pane === 'datasets' ? 'dataset' : 'suite',item.id))">{{ item.name }}</button>
        <span v-if="!(pane === 'datasets' ? testing.view?.datasets : testing.view?.suites)?.some(item => matches(item.name))" class="muted">{{ t(search ? 'testPresentation.noMatches' : 'testPresentation.emptyAssets') }}</span>
      </template>
    </div>
  </aside>
</template>

<style scoped src="../styles/editor-controls.css"></style>
<style scoped>
.test-side {
  width: clamp(154px, 24vw, 240px); min-width: 0; min-height: 0; flex: 1;
  display: flex; flex-direction: column; overflow: hidden;
  border-right: 1px solid var(--border); background: var(--workbench-form-navigation);
}
.side-head { flex: none; padding: 14px 14px 0; }
.side-title { font-weight: 600; font-size: 17px; }
.anchors { flex: none; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 3px; padding: 12px; }
.anchor-item { overflow-wrap: anywhere; padding: 5px; font-size: 12px; background: transparent; }
.anchor-item.active, .api-item.active { background: var(--workbench-form-selected); color: var(--accent); }
.anchor-item.active { border-color: var(--accent); }
.fixed-actions { flex: none; display: flex; flex-direction: column; gap: 8px; padding: 0 12px 12px; border-bottom: 1px solid var(--border); }
.search-field { position: relative; }
.search-field input { width: 100%; padding-right: 28px; }
.search-clear { position: absolute; right: 1px; top: 1px; bottom: 1px; padding: 0 8px; min-height: 0; border: 0; background: transparent; }
.test-list { flex: 1; min-height: 0; overflow: auto; padding: 8px; scrollbar-color: var(--text-muted) var(--workbench-form-navigation); }
.group-block { margin: 4px 0; }
.group-block + .group-block { border-top: 1px solid var(--border); }
.group-name { font-weight: 600; padding: 8px; overflow-wrap: anywhere; }
.api-item { display: block; width: 100%; text-align: start; border-color: transparent; padding: 6px; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: transparent; }
.api-detail { display: flex; gap: 5px; align-items: center; border-inline-start: 3px solid transparent; }
.api-detail.active { border-inline-start-color: var(--accent); }
.api-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.method { flex: 0 0 43px; font-size: 11px; font-weight: 600; color: var(--accent); }
.method[data-method="GET"] { color: var(--pass); }
.method[data-method="DELETE"] { color: var(--fail); }
.scenario-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 6px; border-radius: 6px; }
.scenario-row:hover { background: var(--hover); }
.scenario-name { flex: 1 1 80%; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.muted { display: block; color: var(--text-muted); font-size: 12px; padding: 16px 8px; text-align: center; }
@media (max-width: 780px) {
  .anchors { grid-template-columns: 1fr; padding-block: 8px; }
}
</style>

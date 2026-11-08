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
const matches = (name: string) => name.toLocaleLowerCase().includes(search.value.toLocaleLowerCase());
const testingCurrent = computed(() => {
  const actual = props.testing?.view?.context.project; const selected = props.activeProjectLocator;
  return props.testing?.current && actual && selected && actual.workspaceId === selected.workspaceId && actual.groupId === selected.groupId && actual.projectId === selected.projectId;
});

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
  return result.filter(item => matches(item.label));
});

function sameApi(left: ApiLocator | null, right: ApiLocator): boolean {
  return !!left && localTreeNodeKey({ source: "local", kind: "api", locator: left }) === localTreeNodeKey({ source: "local", kind: "api", locator: right });
}

const moduleNames = computed(() => [...new Set(apis.value.map((a) => a.collection))]);
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
      <button type="button" class="anchor-item" :class="{active: pane === 'suites'}" data-testid="test-tab-suites" @click="emit('update:pane','suites')">{{ t('testing.suites') }}</button>
      <button type="button" class="anchor-item" :class="{active: pane === 'datasets'}" data-testid="test-tab-datasets" @click="emit('update:pane','datasets')">{{ t('testing.datasets') }}</button>
    </div>
    <div class="fixed-actions"><div class="search-field"><input ref="searchInput" v-model="search" :placeholder="t('testing.search')" :aria-label="t('testing.search')" /><button type="button" class="search-clear" data-testid="test-search-clear" :style="{ visibility: search ? 'visible' : 'hidden' }" :aria-label="t('testPresentation.clearSearch')" :title="t('testPresentation.clearSearch')" @click="clearSearch">×</button></div><button v-if="pane === 'datasets'" :disabled="!testingCurrent || testing?.readOnly" @click="editAsset(() => testing?.newDataset(t('testing.newDataset')))">{{ t('testing.newDataset') }}</button><button v-if="pane === 'suites'" :disabled="!testingCurrent || testing?.readOnly" @click="editAsset(() => testing?.newSuite(t('testing.newSuite')))">{{ t('testing.newSuite') }}</button></div>

    <div class="test-list" data-testid="test-navigation-list">
      <template v-if="pane === 'api-cases'">
        <div v-for="m in moduleNames" :key="m" class="group-block">
          <div class="group-name">{{ m }}</div>
          <button
            v-for="a in apis.filter((x) => x.collection === m)"
            :key="a.key" :title="a.label"
            type="button"
            class="api-item"
            :class="{ active: sameApi(activeApiLocator, a.locator) }"
            :data-testid="`test-api-${encodeURIComponent(a.key)}`"
            @click="emit('pick-api', a.locator)"
          >
            {{ a.label }}
          </button>
        </div>
        <span v-if="apis.length === 0" class="muted" data-testid="test-no-apis">{{ search ? t('testPresentation.noMatches') : t("test.noApis") }}</span>
      </template>

      <template v-else-if="pane === 'scenario'">
        <div v-for="w in visibleScenarios" :key="JSON.stringify(w.locator)" class="scenario-row" :data-testid="`test-scenario-${encodeURIComponent(JSON.stringify(w.locator))}`">
          <span class="scenario-name" :title="w.name">{{ w.name }}</span>
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
.test-side { width: 240px; min-width: 0; display: flex; flex-direction: column; flex: 1; min-height: 0; border-right: 1px solid var(--border); background: var(--bg); overflow: hidden; }.side-head { flex: none; padding: 14px 14px 0; }.side-title { font-weight: 600; font-size: 13px; }.anchors { flex: none; display: grid; grid-template-columns: 1fr 1fr; gap: 6px; padding: 12px; }.anchor-item { text-align: left; font-size: 12px; }.anchor-item.active, .api-item.active { background: var(--active-weak); color: var(--accent); border-color: var(--accent); }.fixed-actions { flex: none; display: flex; flex-direction: column; gap: 8px; padding: 0 12px 12px; border-bottom: 1px solid var(--border); }.search-field { position: relative; }.search-field input { width: 100%; padding-right: 32px; }.search-clear { position: absolute; right: 1px; top: 1px; bottom: 1px; padding: 0 8px; min-height: 0; border: 0; background: transparent; }.test-list { flex: 1; min-height: 0; overflow: auto; padding: 8px; }.group-block { margin: 6px 0; }.group-name { font-weight: 600; color: var(--text-muted); padding: 8px; font-size: 12px; overflow-wrap: anywhere; }.api-item { display: block; width: 100%; text-align: left; border-color: transparent; padding: 8px 10px; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.scenario-row { display: flex; align-items: center; gap: 4px; padding: 6px; border-radius: 6px; }.scenario-row:hover { background: var(--hover); }.scenario-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }.muted { display: block; color: var(--text-muted); font-size: 12px; padding: 20px 8px; text-align: center; }
</style>

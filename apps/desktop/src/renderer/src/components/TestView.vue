<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Button as AButton, Tag as ATag, Tooltip as ATooltip } from "ant-design-vue";
import type { useTreeStore } from "../stores/tree.js";
import type { useEditorStore } from "../stores/editor.js";
import type { useDebugStore } from "../stores/debug.js";
import type { useCasesStore } from "../stores/cases.js";
import type { useEnvsStore } from "../stores/envs.js";
import type { createStressStore } from "../stores/stress.js";
import type { useWorkflowDesignStore } from "../stores/workflowDesign.js";
import type { useWorkspaceStore } from "../stores/workspace.js";
import CasePanel from "./CasePanel.vue";
import ResponseViewer from "./ResponseViewer.vue";
import StressPanel from "./StressPanel.vue";
import EmptyState from "./EmptyState.vue";

/**
 * 测试模块（M9-D，取代原压测栏）：左侧锚点「单接口用例 / 场景用例」。
 * - 单接口用例：活动项目的集合→接口清单，点接口加载进编辑器展示用例面板（增删用例项，
 *   每条用例行「运行」= debug.runCase 结果内嵌上屏、「压测」= 切换内嵌 StressPanel 并
 *   预选该用例，绑定当前接口——原压测模块的面板与 store 原样复用）；「返回用例」回列表。
 * - 场景用例：活动项目工作流清单（裁定 D2 复用工作流引擎），「运行」= 打开工作流设计器
 *   （组合根回调）；场景级性能测试延后（禁用态 + 提示，不做假入口）。
 * store 经 props 注入（组合根一次装配）；reportError 为组合根错误反馈通道。
 */
const props = defineProps<{
  workspace: ReturnType<typeof useWorkspaceStore>;
  tree: ReturnType<typeof useTreeStore>;
  editor: ReturnType<typeof useEditorStore>;
  debug: ReturnType<typeof useDebugStore>;
  cases: ReturnType<typeof useCasesStore>;
  envs: ReturnType<typeof useEnvsStore>;
  stress: ReturnType<typeof createStressStore>;
  activeProjectId: string | null;
  reportError: (e: unknown) => void;
  /** 场景用例「运行」回调：组合根载入工作流设计器并切 wf 模块（含 dirty 确认链路）。 */
  openWorkflow: (id: string) => void;
}>();
const { t } = useI18n();

// 左侧锚点：单接口用例 / 场景用例
const pane = ref<"api-cases" | "scenario">("api-cases");
// 压测上下文：从用例行「压测」进入（内嵌 StressPanel）；「返回用例」退出
const stressContext = ref(false);

// 活动项目的集合→接口清单（点接口即加载编辑器，与侧树选中同效）。
const apis = computed(() => {
  const project = (props.workspace.tree?.children ?? [])
    .flatMap((g) => g.children ?? [])
    .find((p) => p.id === props.activeProjectId);
  return (project?.children ?? [])
    .filter((c) => c.kind === "collection")
    .flatMap((c) => (c.children ?? []).filter((n) => n.kind === "api").map((a) => ({ id: a.id, label: a.label, collection: c.label })));
});

// 场景用例 = 活动项目工作流（树摘要）。
const scenarios = computed(() => {
  const project = (props.workspace.tree?.children ?? [])
    .flatMap((g) => g.children ?? [])
    .find((p) => p.id === props.activeProjectId);
  return project?.workflows ?? [];
});

async function pickApi(id: string) {
  stressContext.value = false;
  props.tree.select("api", id);
  try {
    await props.editor.load(id);
  } catch (e) {
    props.reportError(e);
  }
}

function onStress(caseId: string) {
  if (!props.editor.apiId) return;
  props.stress.form.caseId = caseId;
  stressContext.value = true;
}

</script>

<template>
  <section class="test-view" data-testid="test-view">
    <div class="layout">
      <!-- 左侧锚点 -->
      <aside class="side">
        <button
          type="button"
          class="side-item"
          :class="{ active: pane === 'api-cases' }"
          data-testid="test-tab-api-cases"
          @click="pane = 'api-cases'"
        >
          {{ t("test.apiCases") }}
        </button>
        <button
          type="button"
          class="side-item"
          :class="{ active: pane === 'scenario' }"
          data-testid="test-tab-scenario"
          @click="pane = 'scenario'"
        >
          {{ t("test.scenarios") }}
        </button>

        <!-- 单接口用例：集合 → 接口 -->
        <template v-if="pane === 'api-cases'">
          <div v-for="c in apis.length ? [...new Set(apis.map((a) => a.collection))] : []" :key="c" class="group-block">
            <div class="group-name">{{ c }}</div>
            <button
              v-for="a in apis.filter((x) => x.collection === c)"
              :key="a.id"
              type="button"
              class="side-item sub"
              :class="{ active: editor.apiId === a.id }"
              :data-testid="`test-api-${a.id}`"
              @click="pickApi(a.id)"
            >
              {{ a.label }}
            </button>
          </div>
          <span v-if="apis.length === 0" class="muted" data-testid="test-no-apis">{{ t("test.noApis") }}</span>
        </template>

        <!-- 场景用例：项目工作流清单 -->
        <template v-else>
          <div v-for="w in scenarios" :key="w.id" class="scenario-row" :data-testid="`test-scenario-${w.id}`">
            <span class="scenario-name">{{ w.name }}</span>
            <a-tooltip :title="t('test.scenarioStressDeferred')">
              <a-button size="small" type="text" disabled data-testid="test-scenario-stress">{{ t("case.stress") }}</a-button>
            </a-tooltip>
            <a-button size="small" type="text" :data-testid="`test-scenario-run-${w.id}`" @click="openWorkflow(w.id)">
              {{ t("case.run") }}
            </a-button>
          </div>
          <span v-if="scenarios.length === 0" class="muted" data-testid="test-no-scenarios">{{ t("test.noScenarios") }}</span>
        </template>
      </aside>

      <!-- 右侧详情 -->
      <div class="detail">
        <!-- 压测上下文（从用例行进入） -->
        <template v-if="pane === 'api-cases' && stressContext && editor.apiId">
          <div class="pane-head">
            <a-button size="small" data-testid="test-back-to-cases" @click="stressContext = false">{{ t("test.backToCases") }}</a-button>
            <a-tag color="orange">{{ t("test.stressContext") }}</a-tag>
          </div>
          <StressPanel
            class="stress-embed"
            :stress="stress"
            :api-id="editor.apiId"
            :cases="editor.api?.cases ?? []"
            :envs="editor.envs"
            :report-error="reportError"
          />
        </template>

        <!-- 单接口用例：用例面板 + 运行结果内嵌上屏 -->
        <template v-else-if="pane === 'api-cases'">
          <EmptyState v-if="!editor.api" :text="t('test.pickApi')" />
          <template v-else>
            <CasePanel :editor="editor" :cases="cases" :debug="debug" :report-error="reportError" @stress="onStress" />
            <div v-if="debug.result" class="result" data-testid="test-result">
              <ResponseViewer :result="debug.result" :sending="debug.sending" :error="debug.error" />
            </div>
          </template>
        </template>

        <!-- 场景用例说明（运行在工作流设计器进行） -->
        <template v-else>
          <EmptyState :text="t('test.scenarioHint')" />
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.test-view { height: 100%; box-sizing: border-box; }
.layout {
  display: flex;
  gap: 14px;
  height: 100%;
  min-height: 0;
}
.side {
  width: 190px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-right: 1px solid var(--border);
  padding-right: 10px;
  overflow-y: auto;
}
.side-item {
  text-align: left;
  border: none;
  background: transparent;
  color: var(--text);
  padding: 5px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.side-item:hover { background: var(--hover); }
.side-item.active { background: var(--active-weak); color: var(--accent); }
.side-item.sub { padding-left: 16px; }
.group-block { margin-top: 6px; }
.group-name { font-weight: 600; color: var(--text-muted); padding: 2px 8px; font-size: 12px; }
.scenario-row { display: flex; align-items: center; gap: 2px; padding: 2px 4px; border-radius: 6px; }
.scenario-row:hover { background: var(--hover); }
.scenario-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.detail { flex: 1; min-width: 0; overflow: auto; }
.pane-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.stress-embed { flex: 1; min-height: 0; }
.result { margin-top: 10px; border-top: 1px solid var(--border); padding-top: 6px; }
.muted { color: var(--text-muted); font-size: 12px; padding: 4px 8px; }
</style>

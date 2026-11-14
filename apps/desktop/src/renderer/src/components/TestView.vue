<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { useEditorStore } from "../stores/editor.js";
import type { useDebugStore } from "../stores/debug.js";
import type { useCasesStore } from "../stores/cases.js";
import type { useEnvsStore } from "../stores/envs.js";
import type { createStressStore } from "../stores/stress.js";
import CasePanel from "./CasePanel.vue";
import ResponseViewer from "./ResponseViewer.vue";
import EmptyState from "./EmptyState.vue";
import DatasetPanel from "./DatasetPanel.vue";
import SuitePanel from "./SuitePanel.vue";
import type { TestingStore } from "../stores/testing.js";
import type { TestingPane } from "../../../shared/testing.js";

/**
 * 测试模块主视图（M11：导航列迁至 TestSidebar——API 栏按模块专用，澄清③）。
 * 选择状态（pane/apiId）由 moduleMemory 经 props 下发；本组件只承载主区内容：
 * - 单接口用例：用例面板（增删用例项，行内「运行」= debug.runCase 结果内嵌上屏、
 *   「压测」事件上报父级切内嵌 StressPanel 并预选用例）；
 * - 场景用例页签：说明空态（场景清单在侧栏，运行在工作流设计器进行）。
 */
const props = defineProps<{
  editor: ReturnType<typeof useEditorStore>;
  debug: ReturnType<typeof useDebugStore>;
  cases: ReturnType<typeof useCasesStore>;
  envs: ReturnType<typeof useEnvsStore>;
  stress: ReturnType<typeof createStressStore>;
  pane: TestingPane;
  testing?: TestingStore;
  reportError: (e: unknown) => void;
  readOnly?: boolean;
  ai?: import('../stores/ai.js').AiStore;
  interfacePath?: string;
  interfaceReady?: boolean;
  interfaceLoading?: boolean;
  interfaceError?: string;
  canOperate?: () => boolean;
}>();
const emit = defineEmits<{ (e: "stress", caseId: string): void; (e: "locate-evidence", identity: import("@apicc/core").EvidenceIdentity): void }>();
const { t } = useI18n();
const requestTab = computed(() => props.editor.activeKey
  ? props.debug.requestTabForSession(props.editor.activeKey) : null);
const requestTabState = computed(() => requestTab.value ? props.debug.requestTabState(requestTab.value) : null);
const currentCase = computed(() => {
  const api = props.editor.api;
  const identity = requestTabState.value ? requestTabState.value.selectedCase : props.cases.selectedCase;
  return api?.cases.find((item) => item.id === identity?.caseId && item.scope === identity.scope) ?? api?.cases[0];
});
const run = computed(() => currentCase.value ? props.debug.caseRunFor(props.editor, { caseId: currentCase.value.id, scope: currentCase.value.scope }) : undefined);
const runError = computed(() => {
  const error = run.value?.error;
  return error && /is not effective in the selected environment|is not the current effective case scope/.test(error)
    ? t("testWorkbench.scopeUnavailable") : error;
});
const resultRegion = ref<HTMLElement>();

function showResult() {
  void nextTick(() => {
    resultRegion.value?.scrollIntoView?.({ block: "start" });
    resultRegion.value?.focus({ preventScroll: true });
  });
}

</script>

<template>
  <section class="test-view" data-testid="test-view">
    <DatasetPanel v-if="pane === 'datasets' && testing?.current" :testing="testing" />
    <SuitePanel v-else-if="pane === 'suites' && testing?.current" :ai="ai" :testing="testing" @locate-evidence="emit('locate-evidence', $event)" />
    <!-- 单接口用例：用例面板 + 运行结果内嵌上屏 -->
    <template v-else-if="pane === 'api-cases'">
      <p v-if="interfaceReady === false && interfaceError" class="interface-error" role="alert">{{ t("testWorkbench.loadApiFailed", { error: interfaceError }) }}</p>
      <EmptyState v-else-if="interfaceReady === false || !editor.api" :text="t(interfaceLoading ? 'testWorkbench.loadingApi' : 'test.pickApi')" />
      <template v-else>
        <CasePanel workbench :can-operate="canOperate" :interface-path="interfacePath" :ai="ai" :editor="editor" :cases="cases" :debug="debug" :report-error="reportError" :read-only="readOnly" :operators="testing?.operators" :datasets="testing?.view?.datasets" @stress="(caseId: string) => emit('stress', caseId)" @show-result="showResult">
          <template #after-cases>
            <div v-if="run" ref="resultRegion" class="result" data-testid="test-result" tabindex="-1" role="region" :aria-label="t('testWorkbench.result')">
              <p class="result-environment"><strong>{{ t("testWorkbench.runEnvironment") }}</strong>
                {{ run.result?.run.envName ?? run.environmentName ?? t("testWorkbench.defaultEnvironment") }}</p>
              <ResponseViewer :key="run.result?.runId ?? 'pending'" :result="run.result" :sending="run.pending" :error="runError" />
            </div>
          </template>
        </CasePanel>
      </template>
    </template>

    <!-- 场景用例说明（清单在侧栏；运行在工作流设计器进行） -->
    <template v-else>
      <EmptyState :text="t('test.scenarioHint')" />
    </template>
  </section>
</template>

<style scoped>
.test-view { height: 100%; min-height: 0; min-width: 0; box-sizing: border-box; overflow: auto; background: var(--bg); container-type: inline-size; }
.result { min-width: 0; margin-top: 4px; border: 1px solid var(--border); border-radius: 10px; padding: 12px; background: var(--subtle); }
.result:focus { outline: 2px solid var(--accent); outline-offset: -2px; }
.result-environment { margin: 0 0 8px; color: var(--text-muted); overflow-wrap: anywhere; }
.result-environment strong { margin-inline-end: 4px; }
.interface-error { padding: 12px; color: var(--fail); overflow-wrap: anywhere; }
</style>

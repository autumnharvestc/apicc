<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { useEditorStore } from "../stores/editor.js";
import type { useDebugStore } from "../stores/debug.js";
import type { useCasesStore } from "../stores/cases.js";
import type { useEnvsStore } from "../stores/envs.js";
import type { createStressStore } from "../stores/stress.js";
import CasePanel from "./CasePanel.vue";
import ResponseViewer from "./ResponseViewer.vue";
import EmptyState from "./EmptyState.vue";

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
  pane: "api-cases" | "scenario";
  reportError: (e: unknown) => void;
}>();
const emit = defineEmits<{ (e: "stress", caseId: string): void }>();
const { t } = useI18n();

async function runCase(caseId: string) {
  try {
    await props.editor.save();
    await props.debug.runCase(props.editor, caseId);
  } catch (e) {
    props.reportError(e);
  }
}
</script>

<template>
  <section class="test-view" data-testid="test-view">
    <!-- 单接口用例：用例面板 + 运行结果内嵌上屏 -->
    <template v-if="pane === 'api-cases'">
      <EmptyState v-if="!editor.api" :text="t('test.pickApi')" />
      <template v-else>
        <CasePanel :editor="editor" :cases="cases" :debug="debug" :report-error="reportError" @stress="(caseId: string) => emit('stress', caseId)" />
        <div v-if="debug.result" class="result" data-testid="test-result">
          <ResponseViewer :result="debug.result" :sending="debug.sending" :error="debug.error" />
        </div>
      </template>
    </template>

    <!-- 场景用例说明（清单在侧栏；运行在工作流设计器进行） -->
    <template v-else>
      <EmptyState :text="t('test.scenarioHint')" />
    </template>
  </section>
</template>

<style scoped>
.test-view { height: 100%; box-sizing: border-box; overflow: auto; }
.result { margin-top: 10px; border-top: 1px solid var(--border); padding-top: 6px; }
</style>

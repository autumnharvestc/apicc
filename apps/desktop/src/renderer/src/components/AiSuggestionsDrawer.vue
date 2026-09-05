<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Button as AButton, Checkbox as ACheckbox, Drawer as ADrawer, Tag as ATag } from "ant-design-vue";
import type { createAiStore } from "../stores/ai.js";

/**
 * AI 建议抽屉（M6-C 任务 1 组件 / 任务 2 真链路产物，规格 §2 D4，纯展示组件）：props 只收
 * ai store 实例（App 组合根装配，组件内零工厂调用）；建议列表为只读预览——name/scope/
 * 断言数/后置脚本有无，并恒带「AI 生成」来源标注（裁定④）。勾选写回 store.selectedIds
 * （按 core AiSuggestedCase 本地生成的 id）；「采用」调 store.adopt()（并入
 * editor.api.cases，不自动保存——裁定③）；关闭经 @close 调 dismissSuggestions 丢弃（零落盘）。
 * 组件零 i18n 内联中文。
 */
const props = defineProps<{ ai: ReturnType<typeof createAiStore> }>();
const { t } = useI18n();

function hasPostScript(index: number): boolean {
  const row = props.ai.suggestions?.[index];
  return row?.postScript !== undefined && row.postScript !== "";
}
</script>

<template>
  <a-drawer
    :open="ai.drawerOpen"
    :title="t('ai.drawerTitle')"
    :width="480"
    data-testid="ai-suggestions-drawer"
    @close="ai.dismissSuggestions()"
  >
    <!-- 来源标注恒在（裁定④）：列表内容为 AI 生成，采用前必须可见 -->
    <a-tag color="purple" class="source-tag" data-testid="ai-source-tag">{{ t("ai.sourceTag") }}</a-tag>
    <div v-if="!ai.suggestions || ai.suggestions.length === 0" class="empty" data-testid="ai-suggestions-empty">
      {{ t("ai.empty") }}
    </div>
    <div v-else class="list">
      <div
        v-for="(row, index) in ai.suggestions"
        :key="row.id"
        class="row"
        data-testid="ai-suggest-item"
      >
        <a-checkbox
          :checked="ai.selectedIds.includes(row.id)"
          data-testid="ai-suggest-check"
          @update:checked="() => ai.toggleSelect(row.id)"
        />
        <div class="row-main">
          <span class="row-name" data-testid="ai-suggest-name">{{ row.name }}</span>
          <span class="row-meta">
            <span data-testid="ai-suggest-scope">{{ t("ai.colScope") }}: {{ row.scope }}</span>
            <span data-testid="ai-suggest-assertions">{{ t("ai.colAssertions") }}: {{ row.assertions.length }}</span>
            <span data-testid="ai-suggest-postscript">{{ t("ai.colPostScript") }}: {{ hasPostScript(index) ? t("ai.postScriptYes") : t("ai.postScriptNo") }}</span>
          </span>
        </div>
      </div>
    </div>
    <template #footer>
      <a-button
        type="primary"
        :disabled="ai.selectedIds.length === 0"
        data-testid="ai-adopt-btn"
        @click="ai.adopt()"
      >
        {{ t("ai.adopt") }}
      </a-button>
    </template>
  </a-drawer>
</template>

<style scoped>
.source-tag {
  margin-bottom: 12px;
}
.empty {
  color: var(--text-muted, #666);
  font-size: 13px;
  padding: 24px 0;
  text-align: center;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px;
  border: 1px solid var(--border, #e5e5e5);
  border-radius: 6px;
}
.row-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.row-name {
  font-weight: 600;
  font-size: 13px;
  word-break: break-all;
}
.row-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  color: var(--text-muted, #666);
  font-size: 12px;
}
</style>

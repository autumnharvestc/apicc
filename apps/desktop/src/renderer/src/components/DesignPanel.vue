<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { message, Button as AButton, Input as AInput, Typography as ATypography } from "ant-design-vue";
import type { useEditorStore } from "../stores/editor.js";
import type { useDesignStore } from "../stores/design.js";
import EmptyState from "./EmptyState.vue";

const ATextarea = AInput.TextArea;
const ATypographyParagraph = ATypography.Paragraph;

/**
 * 详细设计面板（任务 8）：a-textarea（等宽字体）编辑接口设计 + a-typography 段落
 * 只读预览原文（YAGNI：M1 不做 md 渲染）+「保存设计」（写回 editor.api.design 并经
 * apiSave 持久化）+「导出 agent 设计」（api.designExport → 主进程 renderDesignMarkdown
 * + showSaveDialog，成功经 message 显示保存路径，取消空串静默）。
 * store 经 props 注入（组合根一次装配；组件内部禁止重复调用工厂）；挂载/接口切换
 * （editor.apiId 变化）即从 editor.api.design 水合缓冲——视图切换重挂后内容不丢；
 * 保存/导出链路的拒绝统一转报组合根错误通道（reportError）。
 */
const props = defineProps<{
  editor: ReturnType<typeof useEditorStore>;
  design: ReturnType<typeof useDesignStore>;
  reportError?: (e: unknown) => void;
}>();
const { t } = useI18n();

const saved = ref(false);

// immediate：装配后首次挂载（含视图切换重挂）也要按当前接口水合，不等 apiId 变化。
watch(
  () => props.editor.apiId,
  () => {
    props.design.load();
    saved.value = false;
  },
  { immediate: true },
);

async function onSave() {
  try {
    await props.design.save();
    saved.value = true;
  } catch (e) {
    props.reportError?.(e);
  }
}

async function onExport() {
  try {
    const path = await props.design.exportMarkdown();
    if (path) void message.success(t("design.exported", { path }));
  } catch (e) {
    props.reportError?.(e);
  }
}
</script>

<template>
  <section class="design-panel" data-testid="design-panel">
    <EmptyState v-if="!editor.api" :text="t('design.empty')" />
    <template v-else>
      <div class="toolbar">
        <a-button size="small" type="primary" data-testid="design-save" @click="onSave">{{ t("design.save") }}</a-button>
        <a-button size="small" data-testid="design-export" @click="onExport">{{ t("design.export") }}</a-button>
        <span v-if="saved" class="saved" data-testid="design-saved">{{ t("design.saved") }}</span>
      </div>
      <a-textarea
        :value="design.content"
        :rows="12"
        class="design-text"
        :placeholder="t('design.placeholder')"
        data-testid="design-content"
        @update:value="design.setContent($event as string)"
      />
      <a-typography class="preview">
        <a-typography-paragraph>
          <pre class="preview-text">{{ design.content || t("design.previewEmpty") }}</pre>
        </a-typography-paragraph>
      </a-typography>
    </template>
  </section>
</template>

<style scoped>
.design-panel {
  padding: 8px 10px;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  box-sizing: border-box;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
}
.saved {
  color: var(--pass, #389e0d);
}
.design-text {
  font-family: ui-monospace, monospace;
  resize: vertical;
}
.preview {
  border-top: 1px solid var(--border, #d9d9d9);
  padding-top: 6px;
  overflow: auto;
}
.preview-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  font-size: 12px;
}
</style>

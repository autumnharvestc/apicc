<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Button as AButton, Checkbox as ACheckbox, Drawer as ADrawer, Tag as ATag } from "ant-design-vue";
import type { createAiStore } from "../stores/ai.js";
import AiOutboundPreview from "./ai/AiOutboundPreview.vue";
import AiAssertionSuggestions from './ai/AiAssertionSuggestions.vue';
import AiReportAnalysis from './ai/AiReportAnalysis.vue';
import AiAssertionDetails from './ai/AiAssertionDetails.vue';
import { computed } from 'vue';
import { aiFactTitle } from '../ai/presentation.js';

/**
 * AI 建议抽屉（M6-C 任务 1 组件 / 任务 2 真链路产物，规格 §2 D4，纯展示组件）：props 只收
 * ai store 实例（App 组合根装配，组件内零工厂调用）；建议列表为只读预览——name/scope/
 * 断言数/后置操作数，并恒带「AI 生成」来源标注（裁定④）。勾选写回 store.selectedIds
 * （按 core AiSuggestedCase 本地生成的 id）；「采用」调 store.adopt()（并入
 * editor.api.cases，不自动保存——裁定③）；关闭经 @close 调 dismissSuggestions 丢弃（零落盘）。
 * 组件零 i18n 内联中文。
 */
const props = defineProps<{ ai: ReturnType<typeof createAiStore> }>();
const { t, te } = useI18n();
const errorMessage = computed(() => {
  const code = props.ai.businessError;
  return code ? te(`ai.errors.${code}`) ? t(`ai.errors.${code}`) : te(`aiSettings.errorCodes.${code}`) ? t(`aiSettings.errorCodes.${code}`) : t('ai.operationFailed') : '';
});
function downloadAnalysis() {
  const file = props.ai.exportAnalysis(); if (!file) return;
  const url = URL.createObjectURL(new Blob([file.content], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.filename;
  try { anchor.click(); } finally { URL.revokeObjectURL(url); }
}

</script>

<template>
  <a-drawer
    :open="ai.drawerOpen"
    :title="t(`ai.drawerTitles.${ai.businessPurpose}`)"
    :width="480"
    data-testid="ai-suggestions-drawer"
    @close="ai.dismissSuggestions()"
  >
    <!-- 来源标注恒在（裁定④）：列表内容为 AI 生成，采用前必须可见 -->
    <a-tag color="purple" class="source-tag" data-testid="ai-source-tag">{{ t("ai.sourceTag") }}</a-tag>
    <p v-if="errorMessage" role="alert">{{ errorMessage }}</p>
    <section v-if="ai.contentChoices && !ai.businessOperationId && !ai.businessResult" class="content-choices" data-testid="ai-content-choices">
      <h3>{{ t('ai.contentSelection') }}</h3>
      <p>{{ t('ai.selectionNotice') }}</p>
      <button v-if="ai.canSelectContentEvidence" type="button" :disabled="ai.suggestLoading" @click="ai.clearContentEvidence()">{{ t('ai.clearEvidence') }}</button>
      <section v-for="section in (ai.canSelectContentEvidence ? ['evidence', 'bodies'] as const : ['bodies'] as const)" :key="section">
        <h4>{{ t(section === 'evidence' ? 'ai.evidenceSelection' : 'ai.bodySelection') }}</h4>
        <p>{{ t('ai.catalogCounts', { total: ai.contentChoices[section].total, selectable: ai.contentChoices[section].selectable, omitted: ai.contentChoices[section].omitted }) }}</p>
        <p v-if="!ai.contentChoices[section].complete">{{ t('ai.catalogIncomplete') }}</p>
        <ul class="choice-list">
          <li v-for="item in ai.contentChoices[section].items" :key="item.location + ('id' in item ? item.id : '')">
            <label><input type="checkbox" :data-testid="section === 'evidence' ? 'ai-content-evidence' : 'ai-content-body'"
              :checked="section === 'evidence' && 'id' in item ? ai.contentEvidenceIds === null || ai.contentEvidenceIds.includes(item.id) : ai.contentChoices.bodySelection.includes(item.location)"
              :disabled="ai.suggestLoading"
              @change="section === 'evidence' && 'id' in item ? ai.toggleContentEvidence(item.id) : ai.toggleContentBody(item.location)" />
              {{ section === 'evidence' && 'state' in item ? item.kind === 'contract' ? t('ai.outboundItems.contract') : aiFactTitle({ ...item, purpose: 'report-analysis', value: null }, t) : t('ai.contentBodyLocation') }} · {{ item.location }}
              <span v-if="'state' in item"> · {{ t(`ai.evidenceStates.${item.state}`) }}</span>
            </label>
          </li>
        </ul>
        <button type="button" :disabled="ai.suggestLoading" @click="ai.contentPage(section)">{{ t('ai.firstPage') }}</button>
        <button type="button" :disabled="ai.suggestLoading || !ai.contentChoices[section].nextCursor" @click="ai.contentPage(section, true)">{{ t('ai.nextPage') }}</button>
      </section>
      <button type="button" data-testid="ai-repreview-content" :disabled="ai.suggestLoading" @click="ai.repreviewContent()">{{ t('ai.repreview') }}</button>
    </section>
    <section v-if="ai.businessOperationId" role="status">
      <p>{{ ai.businessProgress ? t(`ai.phases.${ai.businessProgress.phase}`) : t('ai.waitingForProgress') }}</p>
      <p>{{ t('ai.localElapsed') }}: {{ ai.businessElapsedMs }} ms</p>
      <p v-if="ai.businessProgress">{{ t('ai.attempt') }}: {{ ai.businessProgress.attempt }}<span v-if="ai.businessProgress.receivedBytes !== undefined"> · {{ t('ai.received') }}: {{ ai.businessProgress.receivedBytes }} {{ t('ai.bytes') }}</span></p>
      <button type="button" data-testid="ai-cancel-operation" @click="ai.cancelAssistance()">{{ t('ai.cancelOperation') }}</button>
    </section>
    <AiOutboundPreview v-else-if="ai.outboundPreview" :preview="ai.outboundPreview.preview" :connection="ai.outboundConnection" @confirm="ai.confirmAssistance()" />
    <AiAssertionSuggestions v-else-if="ai.businessResult?.purpose === 'assertion-suggestion'" :ai="ai" />
    <AiReportAnalysis v-else-if="ai.businessResult?.purpose === 'report-analysis'" :result="ai.businessResult" :can-locate="ai.canLocateEvidence" @locate="ai.locateEvidence" @export="downloadAnalysis" />
    <div v-else-if="!ai.suggestions || ai.suggestions.length === 0" class="empty" data-testid="ai-suggestions-empty">
      {{ t("ai.empty") }}
    </div>
    <div v-else class="list">
      <div
        v-for="row in ai.suggestions"
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
            <span data-testid="ai-suggest-postoperations">{{ t("ai.colPostOperations") }}: {{ row.postOperations.length }}</span>
          </span>
          <details class="candidate-details">
            <summary>{{ t('ai.details') }}</summary>
            <h4>{{ t('ai.parameters') }}</h4>
            <dl v-if="Object.keys(row.parameters).length" class="fields">
              <template v-for="(value, name) in row.parameters" :key="name"><dt>{{ name }}</dt><dd>{{ value }}</dd></template>
            </dl>
            <p v-else>{{ t('ai.none') }}</p>
            <h4>{{ t('ai.conditions') }}</h4>
            <AiAssertionDetails v-for="assertion in row.assertions" :key="assertion.id" :assertion="assertion" />
            <dl v-for="explanation in ai.businessResult?.purpose === 'case-suggestion' ? ai.businessResult.explanations.filter(item => item.caseId === row.id) : []" :key="explanation.caseId" class="fields">
              <dt>{{ t('ai.reason') }}</dt><dd>{{ explanation.reason }}</dd>
              <dt>{{ t('ai.evidence') }}</dt><dd>{{ explanation.evidenceIds.join(' · ') }}</dd>
            </dl>
            <p v-if="!row.assertions.length">{{ t('ai.none') }}</p>
            <section v-for="group in [{ label: 'ai.preOperations', items: row.preOperations }, { label: 'ai.postOperations', items: row.postOperations }]" :key="group.label">
              <h4>{{ t(group.label) }}</h4>
              <p v-if="!group.items.length">{{ t('ai.none') }}</p>
              <p v-else class="script-warning">{{ t('ai.scriptTrustWarning') }}</p>
              <details v-for="(operation, index) in group.items" :key="operation.id" class="operation">
                <summary>{{ t('ai.script') }} {{ index + 1 }}</summary>
                <pre class="script-source">{{ operation.content }}</pre>
              </details>
            </section>
          </details>
        </div>
      </div>
    </div>
    <template #footer>
      <a-button
        v-if="ai.businessResult?.purpose !== 'report-analysis'"
        type="primary"
        :disabled="!ai.canAdopt"
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
.choice-list { max-height: 240px; overflow: auto; padding-left: 20px; }
.choice-list li { margin: 8px 0; overflow-wrap: anywhere; }
.content-choices { margin: 12px 0; }
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
  width: 100%;
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
.candidate-details { overflow: auto; max-width: 100%; }
.candidate-details h4 { margin: 12px 0 6px; }
.fields { display: grid; grid-template-columns: minmax(72px, 1fr) minmax(0, 3fr); gap: 6px 12px; margin: 8px 0; }
.fields dt { color: var(--text-muted, #666); }
.fields dd { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.condition { border-bottom: 1px solid var(--border, #e5e5e5); padding-bottom: 8px; }
.script-warning { color: var(--warning-color, #9b6500); }
.script-source { max-height: 240px; max-width: 100%; overflow: auto; padding: 8px; background: var(--surface-muted, #f5f5f5); white-space: pre; }
.operation { margin-bottom: 8px; }
</style>

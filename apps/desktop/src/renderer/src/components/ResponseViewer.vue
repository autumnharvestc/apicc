<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import type { DebugOutput } from "../../shared/types.js";
import EmptyState from "./EmptyState.vue";

/**
 * 响应查看器：props 为纯数据（result/sending/error），不持有 store。
 * 语义约束（任务 7 确立）：DebugOutput 无响应体/响应头字段——body/headers tab
 * 显示占位「—」，禁止臆造字段（响应体入参属计划 2B 的 debug:send 扩展）。
 * 有结果时展示 passed/durationMs、断言明细（消息 + 通过/失败徽标）与错误徽标。
 */
withDefaults(defineProps<{ result?: DebugOutput | null; sending?: boolean; error?: string | null }>(), {
  result: null,
  sending: false,
  error: null,
});
const { t } = useI18n();
const tab = ref<"body" | "headers">("body");
</script>

<template>
  <section class="viewer" data-testid="response-viewer">
    <div v-if="!result" data-testid="response-empty">
      <EmptyState :text="t('response.empty')" />
    </div>
    <template v-else>
      <div class="head">
        <span data-testid="response-outcome" :class="result.outcome.passed ? 'badge pass' : 'badge fail'">
          {{ result.outcome.passed ? t("response.passed") : t("response.failed") }}
        </span>
        <span class="muted" data-testid="response-duration">{{ Math.round(result.outcome.durationMs) }} ms</span>
        <span v-if="sending" class="muted">{{ t("editor.sending") }}</span>
        <span v-if="error" class="badge fail" data-testid="response-error">{{ t("response.error") }}: {{ error }}</span>
      </div>
      <div class="assertions" data-testid="response-assertions">
        <div class="muted section-title">{{ t("response.assertions") }}</div>
        <div v-for="(a, index) in result.outcome.assertions" :key="index" class="assert-row" data-testid="assertion-row">
          <span :class="a.pass ? 'badge pass' : 'badge fail'">{{ a.pass ? t("response.passed") : t("response.failed") }}</span>
          <span class="message">{{ a.message }}</span>
        </div>
        <div v-if="result.outcome.assertions.length === 0" class="muted">—</div>
      </div>
      <div class="tabs">
        <button data-testid="response-tab-body" :class="{ active: tab === 'body' }" @click="tab = 'body'">{{ t("response.body") }}</button>
        <button data-testid="response-tab-headers" :class="{ active: tab === 'headers' }" @click="tab = 'headers'">{{ t("response.headers") }}</button>
      </div>
      <!-- 占位「—」：RunResult/CaseOutcome 不携带响应体与响应头，不臆造字段 -->
      <pre v-if="tab === 'body'" class="payload" data-testid="response-body">—</pre>
      <pre v-else class="payload" data-testid="response-headers">—</pre>
    </template>
  </section>
</template>

<style scoped>
.viewer {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  height: 100%;
  box-sizing: border-box;
  overflow: auto;
}
.head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.muted { color: var(--text-muted); font-size: 12px; }
.section-title { font-weight: 600; }
.badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  color: #fff;
}
.badge.pass { background: var(--pass); }
.badge.fail { background: var(--fail); }
.assertions { display: flex; flex-direction: column; gap: 4px; }
.assert-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.assert-row .message { overflow-wrap: anywhere; }
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-top: 4px; }
.tabs button {
  border: none;
  background: none;
  color: var(--text-muted);
  padding: 6px 12px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}
.tabs button.active { color: var(--accent); border-bottom-color: var(--accent); }
.payload {
  margin: 0;
  padding: 8px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-muted);
  min-height: 40px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Tabs as ATabs, Tag as ATag, Table as ATable, Typography as ATypography } from "ant-design-vue";
import type { DebugOutput } from "../../shared/types.js";
import EmptyState from "./EmptyState.vue";

const ATabPane = ATabs.TabPane;
const ATypographyText = ATypography.Text;

/**
 * 响应查看器：props 为纯数据（result/sending/error），不持有 store。
 * 响应快照语义（计划 2B 任务 3）：DebugOutput.response 携带 status/headers/bodyText/
 * timeMs 快照（main/debug.ts 经 afterResponse 事件捕获）——body tab 渲染 bodyText
 * （JSON 可解析时 pretty 缩进，否则原样展示），headers tab 渲染响应头表格；
 * response 缺失（如渲染层 memory 替身）时保留「—」占位，不臆造数据。
 * 有结果时展示 passed/durationMs、断言明细（消息 + 通过/失败徽标）与错误徽标。
 * antd 4 落地：passed/failed 徽标为 a-tag（success/error 语义色），断言列表与响应头
 * 均为 a-table（行 data-testid 经 customRow 保留），页签为 a-tabs（#tab slot 保留
 * 触发钩子），时长/发送中为 a-typography-text。断言为空时显示 antd 内建空态（原自研
 * 「—」占位让位于 antd 空态——其文案随 ConfigProvider locale 变化，App.test 的
 * ConfigProvider 消费侧用例以此断言）。
 */
const props = withDefaults(defineProps<{ result?: DebugOutput | null; sending?: boolean; error?: string | null }>(), {
  result: null,
  sending: false,
  error: null,
});
const { t } = useI18n();
const tab = ref<"body" | "headers">("body");

const assertionColumns = [
  { key: "pass", dataIndex: "pass", title: "" },
  { key: "message", dataIndex: "message", title: "" },
];
// 行级测试钩子：customRow 把 data-testid 落到断言行 <tr> 上
const assertionRowProps = () => ({ "data-testid": "assertion-row" });

const headerColumns = [
  { key: "name", dataIndex: "name", title: "" },
  { key: "value", dataIndex: "value", title: "" },
];
/** body 展示：JSON 可解析则 pretty 缩进，否则原样文本；无快照时「—」。 */
const bodyText = computed<string>(() => {
  const snap = props.result?.response;
  if (!snap) return "—";
  try {
    return JSON.stringify(JSON.parse(snap.bodyText), null, 2);
  } catch {
    return snap.bodyText;
  }
});
const headerRows = computed(() =>
  Object.entries(props.result?.response?.headers ?? {}).map(([name, value]) => ({ name, value })),
);
</script>

<template>
  <section class="viewer" data-testid="response-viewer">
    <div v-if="!result" data-testid="response-empty">
      <EmptyState :text="t('response.empty')" />
    </div>
    <template v-else>
      <div class="head">
        <a-tag :color="result.outcome.passed ? 'success' : 'error'" data-testid="response-outcome">
          {{ result.outcome.passed ? t("response.passed") : t("response.failed") }}
        </a-tag>
        <a-typography-text type="secondary" data-testid="response-duration">
          {{ Math.round(result.outcome.durationMs) }} ms
        </a-typography-text>
        <a-typography-text v-if="sending" type="secondary">{{ t("editor.sending") }}</a-typography-text>
        <a-tag v-if="error" color="error" data-testid="response-error">{{ t("response.error") }}: {{ error }}</a-tag>
      </div>
      <div class="assertions" data-testid="response-assertions">
        <div class="muted section-title">{{ t("response.assertions") }}</div>
        <a-table
          size="small"
          :pagination="false"
          :columns="assertionColumns"
          :data-source="result.outcome.assertions"
          :custom-row="assertionRowProps"
        >
          <template #bodyCell="{ column, record }">
            <a-tag v-if="column.key === 'pass'" :color="record.pass ? 'success' : 'error'">
              {{ record.pass ? t("response.passed") : t("response.failed") }}
            </a-tag>
            <span v-else class="message">{{ record.message }}</span>
          </template>
        </a-table>
      </div>
      <a-tabs v-model:active-key="tab">
        <a-tab-pane key="body">
          <template #tab><span data-testid="response-tab-body">{{ t("response.body") }}</span></template>
          <pre class="payload" data-testid="response-body">{{ bodyText }}</pre>
        </a-tab-pane>
        <a-tab-pane key="headers">
          <template #tab><span data-testid="response-tab-headers">{{ t("response.headers") }}</span></template>
          <!-- 无 response 快照时保留「—」占位；有则渲染响应头表格 -->
          <pre v-if="!props.result?.response" class="payload" data-testid="response-headers">—</pre>
          <a-table
            v-else
            size="small"
            :pagination="false"
            :columns="headerColumns"
            :data-source="headerRows"
            data-testid="response-headers"
          >
            <template #bodyCell="{ column, record }">
              <span v-if="column.key === 'name'" class="header-name">{{ record.name }}</span>
              <span v-else class="message">{{ record.value }}</span>
            </template>
          </a-table>
        </a-tab-pane>
      </a-tabs>
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
.assertions { display: flex; flex-direction: column; gap: 4px; }
.message { overflow-wrap: anywhere; }
.header-name { font-weight: 600; overflow-wrap: anywhere; }
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

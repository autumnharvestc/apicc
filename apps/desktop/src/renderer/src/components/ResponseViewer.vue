<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Tabs as ATabs, Tag as ATag, Table as ATable, Typography as ATypography } from "ant-design-vue";
import type { DebugOutput } from "../../../shared/types.js";
import EmptyState from "./EmptyState.vue";

const ATabPane = ATabs.TabPane;
const ATypographyText = ATypography.Text;

/**
 * 响应查看器：props 为纯数据（result/sending/error），不持有 store。
 * 响应快照语义（计划 2B 任务 3）：DebugOutput.response 携带 status/headers/bodyText/
 * timeMs 快照（main/debug.ts 经 afterResponse 事件捕获）——body tab 渲染 bodyText
 * （JSON 可解析时 pretty 缩进，否则原样展示），headers tab 渲染响应头表格；
 * response 缺失（如渲染层 memory 替身）时保留「—」占位，不臆造数据。
 * 有结果时展示 passed/durationMs、断言明细（消息 + 通过/失败徽标）与错误徽标；
 * response 快照存在时头部另展示 status/timeMs（宽审查修复 2，快照已有数据此前未上 UI）。
 * M8 布局层级改造：页签化 Body/Headers/断言（断言从独立块收编为第三页签，缺省仍显示
 * Body）；元信息（状态胶囊按 2xx/3xx/4xx/5xx 语义着色、耗时、体大小、用例名、outcome
 * 徽标、错误）经 a-tabs 的 tabBarExtraContent 插槽右对齐于页签行——借鉴参考布局的
 * 「页签在左、状态摘要在右」。全部既有 data-testid 保留，新增 response-tab-assertions
 * 与 response-size（体字节数，B/KB/MB 格式）。
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
const tab = ref<"body" | "headers" | "assertions">("body");

const assertionColumns = [
  { key: "pass", dataIndex: "pass", title: "" },
  { key: "message", dataIndex: "message", title: "" },
];
// 行级测试钩子：customRow 把 data-testid 落到断言行 <tr> 上
// （antd customRow 返回类型未建模 data-* 透传属性，any 索引签名对齐，运行时原样展开）。
const assertionRowProps = (): Record<string, any> => ({ "data-testid": "assertion-row" });

// AssertResult 无 id 字段（仅 pass/message）：断言表以索引为键，消除 antd row-key
// dev 告警（2B T2①；EnvPanel row-key 告警同源教训）。
function assertionRowKey(_record: unknown, index?: number): number {
  return index ?? 0;
}

// 响应头行 { name, value } 同样无稳定 id（同名头可重复），索引自键（同上告警消除）。
function headerRowKey(_record: unknown, index?: number): number {
  return index ?? 0;
}

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

// —— M8 元信息：状态语义色（1xx/2xx 绿、3xx 蓝、4xx 橙、5xx 红、无快照灰）与体大小 ——
const statusColor = computed(() => {
  const s = props.result?.response?.status;
  if (s == null) return "default";
  if (s < 300) return "success";
  if (s < 400) return "processing";
  if (s < 500) return "warning";
  return "error";
});

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const bodySize = computed(() => {
  const snap = props.result?.response;
  if (!snap) return null;
  return formatBytes(new Blob([snap.bodyText]).size);
});
</script>

<template>
  <section class="viewer" data-testid="response-viewer">
    <div v-if="!result" data-testid="response-empty">
      <EmptyState :text="t('response.empty')" />
    </div>
    <a-tabs v-else v-model:active-key="tab" class="resp-tabs">
      <!-- 页签行右侧元信息（M8）：发送中/错误/状态胶囊/耗时/体大小/总时长/用例名/outcome -->
      <template #tabBarExtraContent>
        <div class="meta">
          <a-typography-text v-if="sending" type="secondary">{{ t("editor.sending") }}</a-typography-text>
          <a-tag v-if="error" color="error" data-testid="response-error">{{ t("response.error") }}: {{ error }}</a-tag>
          <a-tag v-if="result.response" :color="statusColor" data-testid="response-status">
            {{ result.response.status }}
          </a-tag>
          <a-typography-text v-if="result.response" type="secondary" data-testid="response-time">
            {{ t("response.time") }} {{ Math.round(result.response.timeMs) }} ms
          </a-typography-text>
          <a-typography-text v-if="bodySize" type="secondary" data-testid="response-size">{{ bodySize }}</a-typography-text>
          <a-typography-text type="secondary" data-testid="response-duration">
            {{ Math.round(result.outcome.durationMs) }} ms
          </a-typography-text>
          <a-typography-text type="secondary" data-testid="response-case-name">
            {{ result.outcome.caseName }}
          </a-typography-text>
          <a-tag :color="result.outcome.passed ? 'success' : 'error'" data-testid="response-outcome">
            {{ result.outcome.passed ? t("response.passed") : t("response.failed") }}
          </a-tag>
        </div>
      </template>
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
          :row-key="headerRowKey"
          data-testid="response-headers"
        >
          <template #bodyCell="{ column, record }">
            <span v-if="column.key === 'name'" class="header-name">{{ record.name }}</span>
            <span v-else class="message">{{ record.value }}</span>
          </template>
        </a-table>
      </a-tab-pane>
      <!-- 断言页签（M8 收编）：明细表 + 通过/失败徽标；空断言走 antd 内建空态 -->
      <a-tab-pane key="assertions">
        <template #tab><span data-testid="response-tab-assertions">{{ t("response.assertions") }}</span></template>
        <div class="assertions" data-testid="response-assertions">
          <a-table
            size="small"
            :pagination="false"
            :columns="assertionColumns"
            :data-source="result.outcome.assertions"
            :row-key="assertionRowKey"
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
      </a-tab-pane>
    </a-tabs>
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
/* 页签行右对齐元信息（M8）：状态胶囊 + 计量文本一行排开，防溢出换行 */
.resp-tabs { flex: 1; min-height: 0; }
.resp-tabs :deep(.ant-tabs-content) { overflow: auto; }
.meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.assertions { display: flex; flex-direction: column; gap: 4px; }
/* 长错误/消息列防溢出：break-all 强断行（2B T7③），anywhere 兜底 min-content 收缩 */
.message { word-break: break-all; overflow-wrap: anywhere; }
.header-name { font-weight: 600; word-break: break-all; overflow-wrap: anywhere; }
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

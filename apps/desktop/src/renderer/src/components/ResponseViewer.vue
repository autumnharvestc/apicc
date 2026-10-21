<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Alert as AAlert, Button as AButton, Input as AInput, Select as ASelect, TabPane as ATabPane, Tabs as ATabs, Table as ATable, Tag as ATag, Typography as ATypography } from "ant-design-vue";
import type { DebugResult } from "@apicc/core";
import type { ApiccApi, DebugOutput } from "../../../shared/types.js";
import type { RequestTabDebugState } from "../stores/debug.js";
import EmptyState from "./EmptyState.vue";
import CaseEvidencePanel from "./CaseEvidencePanel.vue";

const props = withDefaults(defineProps<{ result?: DebugResult | DebugOutput | null; sending?: boolean; error?: string | null; api?: ApiccApi; tabState?: RequestTabDebugState | null }>(), {
  result: null,
  sending: false,
  error: null,
});
const ATypographyText = ATypography.Text;
const { t } = useI18n();
const viewerElement = ref<HTMLElement | null>(null);
const localTab = ref("body");
const tab = computed({
  get: () => props.tabState?.responsePanel ?? localTab.value,
  set: (value: string) => {
    localTab.value = value;
    if (props.tabState) props.tabState.responsePanel = value;
  },
});
const format = ref<"raw" | "pretty">("pretty");
const search = ref("");
const exchangeOrder = ref<number | null>(null);
const actionError = ref("");
const isDebugResult = computed(() => Boolean(props.result && "exchanges" in props.result));
const debugResult = computed(() => isDebugResult.value ? props.result as DebugResult : null);
const legacyResult = computed(() => !isDebugResult.value ? props.result as DebugOutput | null : null);
const exchanges = computed(() => debugResult.value?.exchanges ?? []);
const selectedExchange = computed(() => exchanges.value.find((exchange) => exchange.order === exchangeOrder.value) ?? exchanges.value.at(-1) ?? null);
const response = computed(() => selectedExchange.value?.response ?? legacyResult.value?.response ?? null);
const request = computed(() => selectedExchange.value?.request ?? null);
const legacyBodyText = computed(() => legacyResult.value?.response?.bodyText ?? "");
const responseBodyText = computed(() => {
  const body = response.value && "body" in response.value ? response.value.body : null;
  if (!body) return legacyBodyText.value || "—";
  if (body.kind === "text") return body.text || "";
  if (body.kind === "binary") return body.previewHex ? `hex preview\n${body.previewHex}` : t("debugLoop.binaryOmitted");
  return body.omittedReason ? `${t("debugLoop.bodyUnavailable")}: ${body.omittedReason}` : t("debugLoop.bodyUnavailable");
});
const responseContentType = computed(() => response.value && "contentType" in response.value
  ? response.value.contentType ?? ""
  : response.value && "headers" in response.value
    ? (Array.isArray(response.value.headers)
      ? response.value.headers.find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? ""
      : String(response.value.headers["content-type"] ?? ""))
    : "");
const displayBodyText = computed(() => {
  if (format.value !== "pretty") return responseBodyText.value;
  try { return JSON.stringify(JSON.parse(responseBodyText.value), null, 2); }
  catch {
    return /(?:application|text)\/(?:[a-z0-9.+-]*\+)?xml\b/i.test(responseContentType.value)
      ? prettyXml(responseBodyText.value) ?? responseBodyText.value
      : responseBodyText.value;
  }
});
const requestBodyText = computed(() => {
  const body = request.value?.body;
  if (!body || body.kind === "none") return "—";
  if (body.kind === "text") return body.text;
  if (body.kind === "form") return body.fields.map((field) => `${field.key}=${field.value}`).join("\n");
  if (body.kind === "multipart") return body.entries.map((entry) => entry.kind === "text"
    ? `${entry.name}: ${entry.value}`
    : `${entry.name}: ${entry.effectiveFilename ?? entry.filename ?? t("debugLoop.filePart")} (${entry.contentType}; ${t("debugLoop.localFile")}) · ${fileMetadataText(entry)}`).join("\n");
  if (body.kind === "binary") return `${body.contentType} · ${t("debugLoop.localFile")} · ${fileMetadataText(body)}`;
  if (body.kind === "metadata") return t("debugLoop.bodyUnavailable");
  return JSON.stringify(body, null, 2);
});
const headerRows = computed(() => {
  const headers = response.value && "headers" in response.value ? response.value.headers : null;
  if (Array.isArray(headers)) return headers.map(([name, value]) => ({ name, value }));
  if (headers && typeof headers === "object") return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
  return [];
});
const responseCookies = computed(() => response.value && "cookies" in response.value ? response.value.cookies : []);
const requestCookies = computed(() => request.value?.cookies ?? []);
const requestBodyCounters = computed(() => selectedExchange.value?.response?.requestBody ?? null);
const projectionNotes = computed(() => {
  const notes: string[] = [];
  const body = response.value && "body" in response.value ? response.value.body : null;
  if (body && "truncated" in body && body.truncated) notes.push(t("debugLoop.responseTruncated"));
  if (body?.kind === "binary" && body.omittedReason) notes.push(`${t("debugLoop.responseOmitted")}: ${body.omittedReason}`);
  if (body?.kind === "metadata" && body.omittedReason) notes.push(`${t("debugLoop.responseOmitted")}: ${body.omittedReason}`);
  if (debugResult.value?.replay.fields.length) {
    for (const field of debugResult.value.replay.fields) {
      if (field.needsInput) notes.push(`${t("debugLoop.fieldNeedsInput")} (${field.status}): ${field.path}`);
    }
  }
  if (debugResult.value?.warnings.length) notes.push(...debugResult.value.warnings);
  return [...new Set(notes)];
});
const projectedBodyText = computed(() => projectionNotes.value.length
  ? `${t("debugLoop.projectionNotes")}\n${projectionNotes.value.map((note) => `- ${note}`).join("\n")}\n\n${displayBodyText.value}`
  : displayBodyText.value);
const assertionRows = computed(() => debugResult.value
  ? debugResult.value.outcomes.flatMap((outcome) => outcome.assertions.map((assertion) => ({ ...assertion, caseName: outcome.caseName })))
  : legacyResult.value ? legacyResult.value.outcome.assertions.map((assertion) => ({ ...assertion, caseName: legacyResult.value!.outcome.caseName })) : []);
const firstOutcome = computed(() => legacyResult.value?.outcome ?? debugResult.value?.outcomes[0] ?? null);
const terminalState = computed<"passed" | "failed" | "aborted" | null>(() => {
  if (legacyResult.value) return legacyResult.value.outcome.passed ? "passed" : "failed";
  const result = debugResult.value;
  if (!result) return null;
  if (result.failureKind === "aborted") return "aborted";
  if (result.failureKind || result.error || result.run.failed > 0) return "failed";
  if (result.outcomes.length > 0 && result.outcomes.every((outcome) => outcome.passed || outcome.skipped)) {
    return result.outcomes.some((outcome) => outcome.passed) ? "passed" : null;
  }
  return null;
});
const terminalError = computed(() => debugResult.value?.error
  ?? (debugResult.value?.failureKind ? `${t("debugLoop.terminalFailure")}: ${debugResult.value.failureKind}` : ""));
const caseName = computed(() => firstOutcome.value?.caseName ?? (debugResult.value?.mode === "request" ? t("debugLoop.requestMode") : "—"));
const status = computed(() => response.value?.status ?? null);
const responseTime = computed(() => selectedExchange.value?.durationMs ?? legacyResult.value?.response?.timeMs ?? null);
const statusColor = computed(() => {
  if (status.value == null) return "default";
  if (status.value < 300) return "success";
  if (status.value < 400) return "processing";
  if (status.value < 500) return "warning";
  return "error";
});
const bodySize = computed(() => {
  const body = response.value && "body" in response.value ? response.value.body : null;
  if (body && "contentBytes" in body && body.contentBytes !== undefined) return `${body.contentBytes} B`;
  if (legacyResult.value?.response) return `${new Blob([legacyBodyText.value]).size} B`;
  return null;
});
const searchCount = computed(() => search.value ? displayBodyText.value.split(search.value).length - 1 : 0);
const responseTimeLabel = computed(() => responseTime.value === null || responseTime.value === undefined ? t("debugLoop.unknown") : `${Math.round(responseTime.value)} ms`);
const headerColumns = [
  { key: "name", dataIndex: "name", title: "" },
  { key: "value", dataIndex: "value", title: "" },
];
const assertionColumns = [
  { key: "pass", dataIndex: "pass", title: "" },
  { key: "caseName", dataIndex: "caseName", title: "" },
  { key: "message", dataIndex: "message", title: "" },
];

watch(() => debugResult.value?.runId, () => {
  exchangeOrder.value = debugResult.value?.exchanges.at(-1)?.order ?? null;
});

watch(() => props.tabState?.tabId, async () => {
  await nextTick();
  if (viewerElement.value && props.tabState) viewerElement.value.scrollTop = props.tabState.responseScrollTop;
}, { immediate: true, flush: "post" });

function captureResponseScroll(event: Event) {
  if (props.tabState) props.tabState.responseScrollTop = (event.currentTarget as HTMLElement).scrollTop;
}

function headerRowKey(_record: unknown, index?: number): number { return index ?? 0; }
function assertionRowKey(_record: unknown, index?: number): number { return index ?? 0; }
function assertionRowProps(): Record<string, string> { return { "data-testid": "assertion-row" }; }

function exchangeLabel(exchange: NonNullable<typeof selectedExchange.value>): string {
  const cause = [exchange.failureStage, exchange.failureCode].filter(Boolean).join(" / ");
  return `#${exchange.order} · ${exchange.transportState} · ${exchange.observation ?? "http-hop"}${cause ? ` · ${cause}` : ""}`;
}

function sourceCategoryLabel(category: string): string {
  const labels: Record<string, string> = {
    project: "debugLoop.sourceProject", environment: "debugLoop.sourceEnvironment", module: "debugLoop.sourceModule",
    "request-override": "debugLoop.sourceRequestOverride", auth: "debugLoop.sourceAuth", session: "debugLoop.sourceSession",
    unknown: "debugLoop.sourceUnknown",
  };
  const key = labels[category];
  return key ? t(key) : t("debugLoop.sourceUnknown");
}

function fileMetadataText(file: { metadataAvailable?: boolean; capturedFilename?: string; capturedSizeBytes?: number; effectiveFilename?: string }): string {
  if (file.metadataAvailable !== true) return t("debugLoop.fileMetadataUnknown");
  return `${t("debugLoop.capturedFile")}: ${file.capturedFilename ?? t("debugLoop.unknown")} (${file.capturedSizeBytes ?? t("debugLoop.unknown")} B); ${t("debugLoop.effectiveFilename")}: ${file.effectiveFilename ?? t("debugLoop.unknown")}`;
}

async function copyProjected(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    actionError.value = "";
  } catch (error) {
    actionError.value = error instanceof Error ? error.message : String(error);
  }
}

async function saveProjected() {
  if (!props.api) return;
  actionError.value = "";
  try { await props.api.debugSaveProjected("debug-response.txt", projectedBodyText.value); }
  catch (error) { actionError.value = error instanceof Error ? error.message : String(error); }
}

function prettyXml(source: string): string | null {
  if (source.includes("<![CDATA[") || /\bxml:space\s*=\s*(["'])preserve\1(?=\s|\/?>)/.test(source)) return null;
  const tokens = source.match(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/?[A-Za-z_][\w.:-]*(?:\s+(?:[^<>"']|"[^"]*"|'[^']*')*)?\s*\/?>|[^<]+/g);
  if (!tokens || tokens.join("") !== source) return null;
  const lines: string[] = [];
  const stack: Array<{ name: string; line: number; hasElementChild: boolean; hasText: boolean }> = [];
  const indent = (depth: number) => "  ".repeat(depth);
  let rootCount = 0;
  for (const token of tokens) {
    if (/^<\?/.test(token) || /^<!/.test(token)) {
      if (stack.length > 0) {
        const parent = stack.at(-1)!;
        if (parent.hasText) return null;
        parent.hasElementChild = true;
      }
      lines.push(`${indent(stack.length)}${token}`);
      continue;
    }
    if (/^<\//.test(token)) {
      const name = token.match(/^<\/([A-Za-z_][\w.:-]*)/)?.[1];
      const frame = stack.pop();
      if (!frame || frame.name !== name) return null;
      if (!frame.hasElementChild) lines[frame.line] += token;
      else lines.push(`${indent(stack.length)}${token}`);
      continue;
    }
    if (/^<[A-Za-z_]/.test(token)) {
      const name = token.match(/^<([A-Za-z_][\w.:-]*)/)?.[1];
      if (!name) return null;
      if (stack.length === 0) rootCount += 1;
      else {
        const parent = stack.at(-1)!;
        if (parent.hasText) return null;
        parent.hasElementChild = true;
      }
      const line = lines.length;
      lines.push(`${indent(stack.length)}${token}`);
      if (!/\/\s*>$/.test(token)) stack.push({ name, line, hasElementChild: false, hasText: false });
      continue;
    }
    if (stack.length === 0) {
      if (token.length > 0) return null;
      continue;
    }
    const frame = stack.at(-1)!;
    if (frame.hasElementChild) return null;
    frame.hasText = true;
    lines[frame.line] += token;
  }
  return stack.length === 0 && rootCount === 1 ? lines.join("\n") : null;
}
</script>

<template>
  <section ref="viewerElement" class="viewer" data-testid="response-viewer" @scroll="captureResponseScroll">
    <CaseEvidencePanel v-if="firstOutcome" :evidence="firstOutcome.evidence" />
    <div v-if="!result" data-testid="response-empty"><EmptyState :text="t('response.empty')" /></div>
    <a-tabs v-else v-model:active-key="tab" class="resp-tabs">
      <template #tabBarExtraContent>
        <div class="meta">
          <a-typography-text v-if="sending" type="secondary">{{ t("editor.sending") }}</a-typography-text>
          <a-button v-if="debugResult && exchanges.length > 1" size="small" data-testid="exchange-select-label">{{ t("debugLoop.exchanges") }} {{ exchangeOrder ?? selectedExchange?.order }}</a-button>
          <a-tag v-if="error" color="error" data-testid="response-error">{{ t("response.error") }}: {{ error }}</a-tag>
          <a-alert v-if="terminalError" type="error" show-icon :message="terminalError" data-testid="response-terminal-error" />
          <a-tag v-if="status !== null" :color="statusColor" data-testid="response-status">{{ status }}</a-tag>
          <a-typography-text v-if="responseTime !== null" type="secondary" data-testid="response-time">{{ t("response.time") }} {{ responseTimeLabel }}</a-typography-text>
          <a-typography-text v-if="bodySize" type="secondary" data-testid="response-size">{{ bodySize }}</a-typography-text>
          <a-typography-text v-if="firstOutcome" type="secondary" data-testid="response-case-name">{{ caseName }}</a-typography-text>
          <a-tag v-if="firstOutcome || debugResult" :color="terminalState === 'passed' ? 'success' : terminalState ? 'error' : 'default'" data-testid="response-outcome">{{ terminalState ? t(`debugLoop.${terminalState}`) : t("debugLoop.unknown") }}</a-tag>
        </div>
      </template>
      <a-tab-pane key="exchanges">
        <template #tab><span data-testid="response-tab-exchanges">{{ t("debugLoop.exchanges") }}</span></template>
        <div v-if="debugResult" class="exchange-list" data-testid="response-exchanges">
          <button v-for="exchange in exchanges" :key="exchange.order" type="button" :class="{ active: exchange.order === (selectedExchange?.order ?? null) }" :data-testid="`response-exchange-${exchange.order}`" @click="exchangeOrder = exchange.order">{{ exchangeLabel(exchange) }}</button>
          <div v-if="selectedExchange" class="counts">
            <span>{{ t("debugLoop.encodedBytes") }}: {{ selectedExchange.response?.encodedReceivedBytes ?? t("debugLoop.unknown") }}</span>
            <span>{{ t("debugLoop.decodedBytes") }}: {{ selectedExchange.response?.decodedReceivedBytes ?? t("debugLoop.unknown") }}</span>
            <span>{{ t("debugLoop.bodyComplete") }}: {{ selectedExchange.response?.bodyComplete ?? t("debugLoop.unknown") }}</span>
          </div>
        </div>
        <p v-else class="payload">{{ t("debugLoop.noExchange") }}</p>
      </a-tab-pane>
      <a-tab-pane key="request">
        <template #tab><span data-testid="response-tab-request">{{ t("debugLoop.request") }}</span></template>
        <template v-if="request">
          <pre class="payload" data-testid="response-request-summary">{{ request.method }} {{ request.url }}</pre>
          <pre class="payload" data-testid="response-request-sources">{{ request.sourceCategories?.length ? request.sourceCategories.map(sourceCategoryLabel).join(", ") : t("debugLoop.sourceUnknown") }}</pre>
          <pre class="payload" data-testid="response-request-headers">{{ JSON.stringify(request.headers, null, 2) }}</pre>
          <pre class="payload" data-testid="response-request-body">{{ requestBodyText }}</pre>
          <pre class="payload" data-testid="response-request-upload-counters">{{ t("debugLoop.fileBytesRead") }}: {{ requestBodyCounters?.fileBytesRead ?? t("debugLoop.unknown") }} B · {{ t("debugLoop.transportEncodedBytesWritten") }}: {{ requestBodyCounters?.transportEncodedBytesWritten ?? t("debugLoop.unknown") }} B · {{ t("debugLoop.requestBodyComplete") }}: {{ requestBodyCounters?.complete ?? t("debugLoop.unknown") }}</pre>
          <a-alert v-if="request?.body && ((request.body.kind === 'text' && request.body.truncated) || (request.body.kind === 'form' && request.body.fields.some((field) => field.truncated)) || (request.body.kind === 'multipart' && request.body.entries.some((entry) => entry.kind === 'text' && entry.truncated)))" type="warning" show-icon :message="t('debugLoop.requestTruncated')" data-testid="response-request-projection-note" />
        </template>
        <pre v-else class="payload">{{ t("debugLoop.unknown") }}</pre>
      </a-tab-pane>
      <a-tab-pane key="body">
        <template #tab><span data-testid="response-tab-body">{{ t("response.body") }}</span></template>
        <div class="body-tools">
          <a-select v-model:value="format" size="small" :options="[{label:t('debugLoop.pretty'),value:'pretty'},{label:t('debugLoop.raw'),value:'raw'}]" data-testid="response-format" />
          <a-input v-model:value="search" size="small" allow-clear :placeholder="t('debugLoop.searchLiteral')" data-testid="response-search" />
          <span data-testid="response-search-count">{{ searchCount }}</span>
          <a-button size="small" data-testid="response-copy" @click="copyProjected(projectedBodyText)">{{ t("debugLoop.copy") }}</a-button>
          <a-button size="small" data-testid="response-download" @click="saveProjected">{{ t("debugLoop.downloadProjected") }}</a-button>
        </div>
        <a-alert v-if="projectionNotes.length" type="warning" show-icon :message="t('debugLoop.projectionNotes')" :description="projectionNotes.join('\n')" data-testid="response-projection-note" />
        <pre class="payload" data-testid="response-body">{{ displayBodyText }}</pre>
        <a-alert v-if="actionError" type="error" :message="actionError" data-testid="response-action-error" />
      </a-tab-pane>
      <a-tab-pane key="headers">
        <template #tab><span data-testid="response-tab-headers">{{ t("response.headers") }}</span></template>
        <pre v-if="!response || headerRows.length === 0" class="payload" data-testid="response-headers">{{ response ? t("debugLoop.unknown") : "—" }}</pre>
        <a-table v-else size="small" :pagination="false" :columns="headerColumns" :data-source="headerRows" :row-key="headerRowKey" data-testid="response-headers">
          <template #bodyCell="{ column, record: row }"><span v-if="column.key === 'name'" class="header-name">{{ row.name }}</span><span v-else class="message">{{ row.value }}</span></template>
        </a-table>
      </a-tab-pane>
      <a-tab-pane key="cookies">
        <template #tab><span data-testid="response-tab-cookies">{{ t("debugLoop.cookies") }}</span></template>
        <h4>{{ t("debugLoop.requestCookies") }}</h4>
        <pre class="payload" data-testid="response-request-cookies">{{ requestCookies.length ? JSON.stringify(requestCookies, null, 2) : t("debugLoop.unknown") }}</pre>
        <h4>{{ t("debugLoop.responseCookies") }}</h4>
        <pre class="payload" data-testid="response-cookies">{{ responseCookies.length ? responseCookies.join("\n") : t("debugLoop.unknown") }}</pre>
      </a-tab-pane>
      <a-tab-pane key="assertions">
        <template #tab><span data-testid="response-tab-assertions">{{ t("response.assertions") }}</span></template>
        <div class="assertions" data-testid="response-assertions">
          <a-table size="small" :pagination="false" :columns="assertionColumns" :data-source="assertionRows" :row-key="assertionRowKey" :custom-row="assertionRowProps">
            <template #bodyCell="{ column, record: row }">
              <a-tag v-if="column.key === 'pass'" :color="row.pass ? 'success' : 'error'">{{ row.pass ? t("response.passed") : t("response.failed") }}</a-tag>
              <span v-else class="message">{{ column.key === 'caseName' ? row.caseName : row.message }}</span>
            </template>
          </a-table>
        </div>
      </a-tab-pane>
      <a-tab-pane key="console">
        <template #tab><span data-testid="response-tab-console">{{ t("debugLoop.console") }}</span></template>
        <pre class="payload" data-testid="response-console">{{ debugResult?.console.length ? JSON.stringify(debugResult.console, null, 2) : t("debugLoop.consoleUnavailable") }}</pre>
      </a-tab-pane>
    </a-tabs>
  </section>
</template>

<style scoped>
.viewer { display: flex; flex-direction: column; gap: 8px; padding: 10px; height: 100%; min-height: 0; box-sizing: border-box; overflow: auto; }
.resp-tabs { flex: 1; min-height: 0; }
.meta,.body-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.body-tools :deep(.ant-input) { width: 180px; }
.body-tools :deep(.ant-select) { width: 100px; }
.assertions,.exchange-list { display: flex; flex-direction: column; gap: 6px; }
.exchange-list button { padding: 6px 8px; text-align: left; color: var(--text); background: var(--panel); border: 1px solid var(--border); border-radius: 4px; cursor: pointer; }
.exchange-list button.active { border-color: var(--accent); }
.counts { display: flex; gap: 12px; flex-wrap: wrap; color: var(--text-muted); font-size: 12px; }
.message,.header-name { word-break: break-all; overflow-wrap: anywhere; }
.header-name { font-weight: 600; }
.payload { margin: 0; padding: 8px; background: var(--panel); border: 1px solid var(--border); border-radius: 4px; color: var(--text-muted); min-height: 40px; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>

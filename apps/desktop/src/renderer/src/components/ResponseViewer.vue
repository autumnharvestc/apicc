<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Alert as AAlert, Button as AButton, Input as AInput, Select as ASelect, TabPane as ATabPane, Tabs as ATabs, Table as ATable, Tag as ATag } from "ant-design-vue";
import type { DebugResult } from "@apicc/core";
import type { ApiccApi, DebugOutput } from "../../../shared/types.js";
import type { RequestTabDebugState } from "../stores/debug.js";
import CaseEvidencePanel from "./CaseEvidencePanel.vue";
import ActionMenu from "./ActionMenu.vue";
import { EllipsisOutlined } from "@ant-design/icons-vue";

const props = withDefaults(defineProps<{ result?: DebugResult | DebugOutput | null; sending?: boolean; error?: string | null; api?: ApiccApi; tabState?: RequestTabDebugState | null; expanded?: boolean }>(), {
  result: null,
  sending: false,
  error: null,
  expanded: true,
});
const { t, te } = useI18n();
const viewerRoot = ref<HTMLElement | null>(null);
const searchInput = ref<{ focus(): void }>();
const compactTools = ref(false);
const localTab = ref("body");
const tab = computed({
  get: () => props.tabState?.responsePanel ?? localTab.value,
  set: (value: string) => {
    localTab.value = value;
    if (props.tabState) props.tabState.responsePanel = value;
  },
});
const localFormat = ref<"raw" | "pretty">("pretty");
const format = computed({
  get: () => props.tabState?.responseFormat ?? localFormat.value,
  set: (value: "raw" | "pretty") => { if (props.tabState) props.tabState.responseFormat = value; else localFormat.value = value; },
});
const localSearch = ref("");
const search = computed({
  get: () => props.tabState?.responseSearch ?? localSearch.value,
  set: (value: string) => { if (props.tabState) props.tabState.responseSearch = value; else localSearch.value = value; },
});
const localExchange = ref<number | null>(null);
const exchangeOrder = computed({
  get: () => props.tabState ? props.tabState.responseExchangeOrder : localExchange.value,
  set: (value: number | null) => { if (props.tabState) props.tabState.responseExchangeOrder = value; else localExchange.value = value; },
});
const actionError = ref("");
const showErrorDetail = ref(false);
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
const firstOutcome = computed(() => legacyResult.value?.outcome ?? debugResult.value?.outcomes?.[0] ?? null);
const displayTab = computed({
  get: () => tab.value === "evidence" && !firstOutcome.value ? "body" : tab.value,
  set: (value: string) => { tab.value = value; },
});
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
const terminalError = computed(() => {
  const kind = debugResult.value?.failureKind;
  return debugResult.value?.error ?? (kind ? `${t("debugLoop.terminalFailure")}: ${labelCode("failure", kind)}` : "");
});
const visibleError = computed(() => props.error === "debug-environment-unavailable" ? t("environmentShortcut.unavailable") : props.error || terminalError.value);
const compactStatus = computed(() => {
  if (props.error) return visibleError.value;
  if (props.sending) return t(props.result ? "responseWorkbench.previous" : "editor.sending");
  if (terminalState.value === "aborted") return t("debugLoop.aborted");
  if (visibleError.value) return visibleError.value;
  if (terminalState.value) return t(`debugLoop.${terminalState.value}`);
  if (!props.result) return t("responseWorkbench.noResult");
  return status.value === null ? t("responseWorkbench.noHttpStatus") : "";
});
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
const bodyBytes = computed(() => {
  const body = response.value && "body" in response.value ? response.value.body : null;
  if (body && "contentBytes" in body && body.contentBytes !== undefined) return body.contentBytes;
  if (legacyResult.value?.response) return new Blob([legacyBodyText.value]).size;
  return null;
});
const bodySize = computed(() => bodyBytes.value === null ? t("debugLoop.unknown")
  : bodyBytes.value >= 1024 ? `${(bodyBytes.value / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KiB` : `${bodyBytes.value} B`);
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

const currentOwner = computed(() => props.tabState
  ? JSON.stringify([props.tabState.root, props.tabState.tabId, props.tabState.generation]) : "");
const downloadItems = computed(() => [{ key: "download", label: t("debugLoop.downloadProjected"), testId: "response-download" }]);
const canHighlight = computed(() => format.value === "pretty" && displayBodyText.value.length <= 65_536
  && new TextEncoder().encode(displayBodyText.value).length <= 65_536);
const jsonTokens = computed(() => {
  const source = displayBodyText.value;
  if (!canHighlight.value || source.split("\n").length > 1000) return null;
  try { JSON.parse(source); } catch { return null; }
  const parts = source.split(/("(?:[^"\\]|\\.)*"|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[Ee][+-]?\d+)?)/g);
  return parts.map((value, index) => ({
    value,
    kind: index % 2 === 0 ? "" : value.startsWith('"') ? (/^\s*:/.test(parts[index + 1] ?? "") ? "key" : "string") : "literal",
  }));
});
const lineNumbers = computed(() => displayBodyText.value.split("\n", 1001).length);
const bodyControls = computed(() => [{ label: t("debugLoop.pretty"), value: "pretty" }, { label: t("debugLoop.raw"), value: "raw" }]);
let scrollEpoch = 0;
let projectionEpoch = 0;
let renderedScroll: { element: HTMLElement; owner: string; panel: string } | undefined;

function activeScroller(): HTMLElement | null {
  const pane = viewerRoot.value?.querySelector<HTMLElement>(".ant-tabs-tabpane-active");
  return pane?.querySelector<HTMLElement>(".body-scroll") ?? pane ?? null;
}

watch([currentOwner, () => props.result], () => {
  projectionEpoch += 1;
  if (!props.tabState) localExchange.value = null;
  actionError.value = "";
  showErrorDetail.value = false;
}, { immediate: true, flush: "sync" });

const localScrollByPanel: Record<string, number> = {};
watch([currentOwner, () => props.result, displayTab, exchangeOrder, () => props.expanded], async ([owner, result, panel, exchange, expanded], previous) => {
  const operation = ++scrollEpoch;
  renderedScroll = undefined;
  const changedOwner = owner !== previous[0];
  const newResultOrExchange = !changedOwner && (result !== previous[1] || exchange !== previous[3]);
  const state = props.tabState;
  if (newResultOrExchange && state) state.responseScrollByPanel = {};
  if (newResultOrExchange && !state) for (const key of Object.keys(localScrollByPanel)) delete localScrollByPanel[key];
  if (!expanded) return;
  await nextTick();
  if (operation !== scrollEpoch || currentOwner.value !== owner || props.result !== result || displayTab.value !== panel) return;
  const element = activeScroller();
  if (!element) return;
  measureViewer();
  const saved = (state?.responseScrollByPanel ?? localScrollByPanel)[panel] ?? 0;
  element.scrollTop = newResultOrExchange ? 0 : saved;
  renderedScroll = { element, owner, panel };
}, { immediate: true, flush: "post" });

let resizeObserver: ResizeObserver | undefined;
function measureViewer() {
  if (!props.expanded) return;
  const width = viewerRoot.value?.clientWidth;
  compactTools.value = !!width && width < 590;
}
onMounted(() => {
  measureViewer();
  if (typeof ResizeObserver === "function" && viewerRoot.value) {
    resizeObserver = new ResizeObserver(measureViewer);
    resizeObserver.observe(viewerRoot.value);
  }
});
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  scrollEpoch += 1;
  projectionEpoch += 1;
});

function clearSearch() {
  search.value = "";
  searchInput.value?.focus();
}
function labelCode(group: string, code: string): string {
  const key = `responseWorkbench.${group}.${code}`;
  return te(key) ? t(key) : code;
}

function captureResponseScroll(event: Event) {
  const target = event.target;
  if (!props.expanded || !renderedScroll || renderedScroll.owner !== currentOwner.value || renderedScroll.panel !== displayTab.value
    || target !== renderedScroll.element) return;
  const positions = props.tabState?.responseScrollByPanel ?? localScrollByPanel;
  positions[renderedScroll.panel] = renderedScroll.element.scrollTop;
}

function headerRowKey(_record: unknown, index?: number): number { return index ?? 0; }
function assertionRowKey(_record: unknown, index?: number): number { return index ?? 0; }
function assertionRowProps(): Record<string, string> { return { "data-testid": "assertion-row" }; }

function exchangeLabel(exchange: NonNullable<typeof selectedExchange.value>): string {
  const cause = [exchange.failureStage ? labelCode("stage", exchange.failureStage) : "", exchange.failureCode].filter(Boolean).join(" / ");
  return `#${exchange.order} · ${labelCode("transport", exchange.transportState)} · ${labelCode("observation", exchange.observation ?? "http-hop")}${cause ? ` · ${cause}` : ""}`;
}

function selectExchange(order: number) {
  if (!props.expanded) return;
  if (order === exchangeOrder.value) return;
  projectionEpoch += 1;
  actionError.value = "";
  exchangeOrder.value = order;
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
  const operation = ++projectionEpoch;
  actionError.value = "";
  try {
    await navigator.clipboard.writeText(value);
  } catch (error) {
    if (operation === projectionEpoch) actionError.value = error instanceof Error ? error.message : String(error);
  }
}

async function saveProjected() {
  if (!props.api) return;
  const operation = ++projectionEpoch;
  actionError.value = "";
  try { await props.api.debugSaveProjected("debug-response.txt", projectedBodyText.value); }
  catch (error) {
    if (operation === projectionEpoch) actionError.value = error instanceof Error ? error.message : String(error);
  }
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
  <section ref="viewerRoot" class="viewer" :class="{ 'viewer-collapsed': !expanded }" data-testid="response-viewer" :aria-label="t('responseWorkbench.title')" @scroll.capture="captureResponseScroll">
    <header class="response-summary">
      <div class="response-summary-row">
      <div class="meta" aria-live="polite">
        <h3>{{ t("responseWorkbench.title") }}</h3>
        <template v-if="!expanded">
          <span v-if="compactStatus" class="compact-status" :class="{ 'compact-error': error || (!sending && visibleError) }" :title="compactStatus" data-testid="response-compact-status">{{ compactStatus }}</span>
          <span v-if="!error && status !== null" :class="`compact-http-${statusColor}`" class="compact-http" data-testid="response-status">HTTP {{ status }}</span>
          <span v-if="!error && responseTime !== null" class="compact-time">{{ responseTimeLabel }}</span>
        </template>
        <template v-else>
        <span v-if="sending" class="response-busy">{{ t(result ? "responseWorkbench.previous" : "editor.sending") }}</span>
        <span v-else-if="error && result" class="response-busy">{{ t("responseWorkbench.previousResult") }}</span>
        <a-tag v-if="status !== null" :color="statusColor" data-testid="response-status">HTTP {{ status }}</a-tag>
        <span v-else-if="result" class="notes">{{ t("responseWorkbench.noHttpStatus") }}</span>
        <span v-if="result" data-testid="response-time">{{ t("response.time") }} {{ responseTimeLabel }}</span>
        <span v-if="result" :title="bodyBytes === null ? undefined : `${bodyBytes} B`" data-testid="response-size">{{ t("responseWorkbench.size") }} {{ bodySize }}</span>
        <a-tag v-if="firstOutcome || debugResult" :color="terminalState === 'passed' ? 'success' : terminalState === 'failed' ? 'error' : 'default'" data-testid="response-outcome">{{ terminalState ? t(`debugLoop.${terminalState}`) : t("debugLoop.unknown") }}</a-tag>
        <span v-if="firstOutcome" class="response-case-name" :title="caseName" data-testid="response-case-name">{{ caseName }}</span>
        <button v-if="debugResult && exchanges.length > 1" type="button" class="summary-button" data-testid="exchange-select-label" @click="tab = 'exchanges'">{{ t("debugLoop.exchanges") }} {{ exchangeOrder ?? selectedExchange?.order }}</button>
        </template>
      </div>
      <div v-if="$slots.actions" class="response-actions"><slot name="actions" /></div>
      </div>
      <div v-if="expanded && visibleError" class="response-error" role="alert" :title="visibleError" :data-testid="error ? 'response-error' : 'response-terminal-error'">
        <span>{{ visibleError }}</span>
        <button type="button" class="summary-button" :aria-expanded="result ? undefined : showErrorDetail"
          @click="result ? tab = 'exchanges' : showErrorDetail = !showErrorDetail">{{ t("responseWorkbench.details") }}</button>
      </div>
    </header>
    <div v-if="!result" v-show="expanded" data-testid="response-empty" class="response-empty">
      <p v-if="showErrorDetail && visibleError" class="detail-error">{{ visibleError }}</p>
      <p v-else>{{ t(sending ? 'editor.sending' : 'response.empty') }}</p>
    </div>
    <a-tabs v-else v-show="expanded" v-model:active-key="displayTab" class="resp-tabs">
      <a-tab-pane key="exchanges">
        <template #tab><span data-testid="response-tab-exchanges">{{ t("debugLoop.exchanges") }}</span></template>
        <div v-if="debugResult" class="exchange-list" data-testid="response-exchanges">
          <p v-if="visibleError" class="detail-error">{{ visibleError }}</p>
          <button v-for="exchange in exchanges" :key="exchange.order" type="button" :class="{ active: exchange.order === (selectedExchange?.order ?? null) }" :data-testid="`response-exchange-${exchange.order}`" @click="selectExchange(exchange.order)">{{ exchangeLabel(exchange) }}</button>
          <div v-if="selectedExchange" class="counts">
            <span>{{ t("debugLoop.encodedBytes") }} · {{ selectedExchange.response?.encodedReceivedBytes ?? t("debugLoop.unknown") }} B</span>
            <span>{{ t("debugLoop.decodedBytes") }} · {{ selectedExchange.response?.decodedReceivedBytes ?? t("debugLoop.unknown") }} B</span>
            <span>{{ t("debugLoop.bodyComplete") }} · {{ selectedExchange.response?.bodyComplete === undefined ? t("debugLoop.unknown") : t(selectedExchange.response.bodyComplete ? "responseWorkbench.yes" : "responseWorkbench.no") }}</span>
          </div>
        </div>
        <p v-else class="notes">{{ visibleError || t("debugLoop.noExchange") }}</p>
      </a-tab-pane>
      <a-tab-pane key="request">
        <template #tab><span data-testid="response-tab-request">{{ t("debugLoop.request") }}</span></template>
        <template v-if="request">
          <p class="detail-text" data-testid="response-request-summary">{{ request.method }} {{ request.url }}</p>
          <p class="detail-text" data-testid="response-request-sources">{{ request.sourceCategories?.length ? request.sourceCategories.map(sourceCategoryLabel).join(", ") : t("debugLoop.sourceUnknown") }}</p>
          <dl class="response-header-list" data-testid="response-request-headers">
            <template v-for="([name, value], index) in request.headers" :key="index"><dt>{{ name }}</dt><dd>{{ value }}</dd></template>
          </dl>
          <pre class="payload" data-testid="response-request-body">{{ requestBodyText }}</pre>
          <p class="detail-text" data-testid="response-request-upload-counters">{{ t("debugLoop.fileBytesRead") }} · {{ requestBodyCounters?.fileBytesRead ?? t("debugLoop.unknown") }} B · {{ t("debugLoop.transportEncodedBytesWritten") }} · {{ requestBodyCounters?.transportEncodedBytesWritten ?? t("debugLoop.unknown") }} B · {{ t("debugLoop.requestBodyComplete") }} · {{ requestBodyCounters?.complete === undefined ? t("debugLoop.unknown") : t(requestBodyCounters.complete ? "responseWorkbench.yes" : "responseWorkbench.no") }}</p>
          <a-alert v-if="request?.body && ((request.body.kind === 'text' && request.body.truncated) || (request.body.kind === 'form' && request.body.fields.some((field) => field.truncated)) || (request.body.kind === 'multipart' && request.body.entries.some((entry) => entry.kind === 'text' && entry.truncated)))" type="warning" show-icon :message="t('debugLoop.requestTruncated')" data-testid="response-request-projection-note" />
        </template>
        <p v-else class="notes">{{ t("debugLoop.unknown") }}</p>
      </a-tab-pane>
      <a-tab-pane key="body">
        <template #tab><span data-testid="response-tab-body">{{ t("response.body") }}</span></template>
        <div class="body-tools">
          <a-select v-model:value="format" size="small" :options="bodyControls" :aria-label="t('responseWorkbench.format')" data-testid="response-format" />
          <a-input ref="searchInput" v-model:value="search" size="small" :aria-label="t('debugLoop.searchLiteral')" :placeholder="t('debugLoop.searchLiteral')" data-testid="response-search" />
          <span class="matches" :title="t('responseWorkbench.matches', { count: searchCount })" :aria-label="t('responseWorkbench.matches', { count: searchCount })" data-testid="response-search-count">{{ searchCount }}</span>
          <a-button v-if="search" size="small" data-testid="response-search-clear" @click="clearSearch">{{ t("responseWorkbench.clear") }}</a-button>
          <a-button size="small" data-testid="response-copy" @click="copyProjected(projectedBodyText)">{{ t("debugLoop.copy") }}</a-button>
          <a-button v-if="!compactTools" size="small" data-testid="response-download" @click="saveProjected">{{ t("debugLoop.downloadProjected") }}</a-button>
          <ActionMenu v-else :label="t('responseWorkbench.more')" :items="downloadItems" :hidden="!expanded" @select="saveProjected"><EllipsisOutlined /></ActionMenu>
        </div>
        <details v-if="projectionNotes.length" class="response-notes" data-testid="response-projection-note">
          <summary>{{ t("debugLoop.projectionNotes") }} · {{ projectionNotes[0] }}</summary>
          <ul><li v-for="note in projectionNotes" :key="note">{{ note }}</li></ul>
        </details>
        <a-alert v-if="actionError" class="response-action-error" type="error" :message="actionError" data-testid="response-action-error" />
        <div class="body-scroll" data-testid="response-body-scroll" tabindex="0" :aria-label="t('response.body')">
          <div class="code-area">
            <div v-if="lineNumbers <= 1000" class="line-numbers" aria-hidden="true">
              <span v-for="line in lineNumbers" :key="line">{{ line }}</span>
            </div>
            <pre class="body-code" data-testid="response-body"><template v-if="jsonTokens"><span v-for="(token, index) in jsonTokens" :key="index" :class="token.kind && `json-${token.kind}`">{{ token.value }}</span></template><template v-else>{{ displayBodyText }}</template></pre>
          </div>
        </div>
      </a-tab-pane>
      <a-tab-pane key="headers">
        <template #tab><span data-testid="response-tab-headers">{{ t("response.headers") }}</span></template>
        <p v-if="!response || headerRows.length === 0" class="notes" data-testid="response-headers">{{ response ? t("debugLoop.unknown") : "—" }}</p>
        <a-table v-else size="small" :pagination="false" :columns="headerColumns" :data-source="headerRows" :row-key="headerRowKey" data-testid="response-headers">
          <template #bodyCell="{ column, record: row }"><span v-if="column.key === 'name'" class="header-name">{{ row.name }}</span><span v-else class="message">{{ row.value }}</span></template>
        </a-table>
      </a-tab-pane>
      <a-tab-pane key="cookies">
        <template #tab><span data-testid="response-tab-cookies">{{ t("debugLoop.cookies") }}</span></template>
        <h4>{{ t("debugLoop.requestCookies") }}</h4>
        <dl v-if="requestCookies.length" class="response-header-list" data-testid="response-request-cookies">
          <template v-for="([name, value], index) in requestCookies" :key="index"><dt>{{ name }}</dt><dd>{{ value }}</dd></template>
        </dl>
        <p v-else class="notes" data-testid="response-request-cookies">{{ t("debugLoop.unknown") }}</p>
        <h4>{{ t("debugLoop.responseCookies") }}</h4>
        <ul v-if="responseCookies.length" data-testid="response-cookies"><li v-for="(cookie, index) in responseCookies" :key="index">{{ cookie }}</li></ul>
        <p v-else class="notes" data-testid="response-cookies">{{ t("debugLoop.unknown") }}</p>
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
        <div class="console" data-testid="response-console">
          <ol v-if="debugResult?.console.length" class="console-entries" :aria-label="t('debugLoop.console')">
            <li v-for="(entry, index) in debugResult.console" :key="index" class="console-entry" data-testid="console-entry">
              <span class="console-level" :class="{ 'console-error': entry.level === 'error' }">{{ t(`reportPresentation.consoleLevels.${entry.level}`) }}</span>
              <span class="console-message">{{ entry.message }}</span>
            </li>
          </ol>
          <p v-else class="notes">{{ t('debugLoop.consoleUnavailable') }}</p>
        </div>
      </a-tab-pane>
      <a-tab-pane v-if="firstOutcome" key="evidence">
        <template #tab><span data-testid="response-tab-evidence">{{ t("responseWorkbench.evidence") }}</span></template>
        <CaseEvidencePanel :evidence="firstOutcome.evidence" />
      </a-tab-pane>
    </a-tabs>
  </section>
</template>

<style scoped>
.console { border: 1px solid var(--border); border-radius: 8px; background: var(--subtle); }
.console-entries { list-style: none; padding: 0; margin: 0; }
.console-entry { display: grid; grid-template-columns: 72px minmax(0,1fr); gap: 12px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
.console-entry:last-child { border-bottom: 0; }.console-level { font-size: 12px; font-weight: 600; color: var(--text-muted); }.console-error { color: var(--fail); }
.console-message { white-space: pre-wrap; overflow-wrap: anywhere; font-family: ui-monospace,Consolas,monospace; font-size: 12px; }.console > .notes { padding: 12px; }
.viewer { display: flex; flex-direction: column; gap: 3px; padding: 8px 12px 12px; height: 100%; min-height: 0; box-sizing: border-box; overflow: hidden; background: var(--bg); }
.viewer-collapsed { padding-block: 3px; }
.response-summary { flex: none; min-width: 0; }
.response-summary-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 6px; min-width: 0; }
.response-summary-row .meta { min-width: 0; }
.response-actions { display: flex; align-items: center; flex: none; gap: 6px; }
.response-summary h3 { margin: 0 4px 0 0; font-size: 15px; }
.viewer-collapsed .meta { flex-wrap: nowrap; overflow: hidden; }
.viewer-collapsed .meta h3, .compact-http, .compact-time { flex: none; white-space: nowrap; }
.compact-status { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.compact-error, .compact-http-error { color: var(--fail); }
.compact-http-success { color: var(--pass); }
.compact-http-warning { color: var(--workbench-method-post); }
.compact-http-processing { color: var(--accent); }
.response-case-name { max-width: 18ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.response-busy { color: var(--text-muted); }
.response-empty { display: grid; place-items: center; flex: 1; min-height: 0; overflow: auto; color: var(--text-muted); }
.response-error { display: flex; align-items: center; gap: 8px; color: var(--fail); font-size: 12px; }
.response-error > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.detail-error, .detail-text { overflow-wrap: anywhere; }
.summary-button { flex: none; background: transparent; color: var(--accent); border: 0; border-radius: 4px; cursor: pointer; }
.resp-tabs { flex: 1; min-height: 0; overflow: hidden; }
.resp-tabs :deep(.ant-tabs-nav) { flex: none; min-height: 33px; margin-bottom: 3px; }
.resp-tabs :deep(.ant-tabs-nav-wrap) { min-width: 0; }
.resp-tabs :deep(.ant-tabs-tab) { padding: 4px 0; }
.resp-tabs :deep(.ant-tabs-content-holder), .resp-tabs :deep(.ant-tabs-content) { flex: 1; min-height: 0; height: 100%; }
.resp-tabs :deep(.ant-tabs-tabpane) { height: 100%; overflow: auto; }
.resp-tabs :deep(.ant-tabs-tabpane > .evidence) { max-height: none; overflow: visible; }
.resp-tabs :deep(.ant-tabs-tabpane-active:has(.body-scroll)) { display: flex; flex-direction: column; overflow: hidden; }
.meta,.body-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.meta { min-height: 26px; font-size: 12px; font-variant-numeric: tabular-nums; }
.meta :deep(.ant-tag) { white-space: normal; overflow-wrap: anywhere; max-width: 100%; }
.body-tools { flex: none; background: var(--bg); padding: 3px 0 6px; }
.body-tools :deep(.ant-input) { flex: 1 1 100px; min-width: 85px; max-width: 340px; }
.body-tools :deep(.ant-select) { width: 86px; }
.matches { font-variant-numeric: tabular-nums; }
.body-scroll { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--border); border-radius: 6px; background: var(--workbench-code, var(--subtle)); }
.code-area { display: flex; align-items: flex-start; min-width: max-content; color: var(--text); font: 12px/1.55 ui-monospace, Consolas, monospace; }
.line-numbers { display: grid; flex: none; padding: 8px 7px; border-right: 1px solid var(--border); text-align: right; color: var(--text-muted); user-select: none; }
.body-code { margin: 0; padding: 8px 10px; color: inherit; font: inherit; white-space: pre; }
.json-key { color: var(--workbench-json-key, var(--accent)); }
.json-string { color: var(--workbench-json-string, var(--pass)); }
.json-literal { color: var(--workbench-json-literal, var(--text)); }
.response-notes { flex: none; max-height: 70px; overflow: auto; margin-bottom: 4px; padding: 2px 6px; color: var(--text-muted); background: var(--subtle); }
.response-notes summary { cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.response-notes ul { overflow-wrap: anywhere; }
.response-action-error { flex: none; max-height: 70px; overflow: auto; }
.response-header-list { display: grid; grid-template-columns: minmax(75px, 24%) minmax(0, 1fr); gap: 5px 12px; padding: 6px; }
.response-header-list dt, .response-header-list dd { margin: 0; overflow-wrap: anywhere; }
.assertions,.exchange-list { display: flex; flex-direction: column; gap: 6px; }
.exchange-list button { padding: 6px 8px; text-align: left; color: var(--text); background: var(--panel); border: 1px solid var(--border); border-radius: 4px; cursor: pointer; }
.exchange-list button.active { border-color: var(--accent); }
.counts { display: flex; gap: 12px; flex-wrap: wrap; color: var(--text-muted); font-size: 12px; }
.message,.header-name { word-break: break-all; overflow-wrap: anywhere; }
.header-name { font-weight: 600; }
.payload { margin: 0; padding: 12px; background: var(--subtle); border: 1px solid var(--border); border-radius: 6px; color: var(--text); min-height: 40px; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.65 ui-monospace, Consolas, monospace; }
</style>

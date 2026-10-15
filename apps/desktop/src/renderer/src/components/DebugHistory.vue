<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Alert as AAlert, Button as AButton, Input as AInput, InputNumber as AInputNumber, Modal as AModal, Select as ASelect, Tag as ATag } from "ant-design-vue";
import type { ApiccApi } from "../../../shared/types.js";
import type { DebugHistorySummary } from "@apicc/core";
import type { useDebugStore } from "../stores/debug.js";
import type { useDebugHistoryStore } from "../stores/debugHistory.js";
import type { useEditorStore } from "../stores/editor.js";
import EmptyState from "./EmptyState.vue";

const props = defineProps<{
  open: boolean;
  api: ApiccApi;
  history: ReturnType<typeof useDebugHistoryStore>;
  debug: ReturnType<typeof useDebugStore>;
  editor: ReturnType<typeof useEditorStore>;
}>();
const emit = defineEmits<{ (event: "close"): void }>();
const { t } = useI18n();
const selectedExchangeOrder = ref<number | null>(null);
const restoreResult = ref<{ sourceChanged: boolean; sourceAvailable: boolean } | null>(null);
const busyAction = ref("");
const searchText = ref("");
const method = ref("");
const resultFilter = ref("");
const projectId = ref(props.history.filter.projectId ?? "");
const apiId = ref(props.history.filter.apiId ?? "");
const fromDate = ref(toLocalDateTime(props.history.filter.from));
const toDate = ref(toLocalDateTime(props.history.filter.to));

const activeSession = computed(() => props.editor.activeKey ? props.editor.sessions[props.editor.activeKey] : undefined);
const currentProjectId = computed(() => activeSession.value?.locator.projectId ?? "");
const currentApiId = computed(() => activeSession.value?.locator.apiId ?? "");
const record = computed(() => props.history.selected?.record ?? null);
const exchanges = computed(() => record.value?.result.exchanges ?? []);
const selectedExchange = computed(() => exchanges.value.find((exchange) => exchange.order === selectedExchangeOrder.value) ?? exchanges.value[0] ?? null);
const selectedExchangeDisplay = computed(() => {
  const exchange = selectedExchange.value;
  if (!exchange?.request) return exchange;
  const request = exchange.request;
  const body = request.body.kind === "binary"
    ? { ...request.body, metadataAvailable: request.body.metadataAvailable ?? false }
    : request.body.kind === "multipart"
      ? { ...request.body, entries: request.body.entries.map((entry) => entry.kind === "file"
        ? { ...entry, metadataAvailable: entry.metadataAvailable ?? false }
        : entry) }
      : request.body;
  return { ...exchange, request: { ...request, sourceCategories: request.sourceCategories?.length ? request.sourceCategories : ["unknown" as const], body } };
});
const selectedSummary = computed(() => record.value ? props.history.items.find((item) => item.historyId === record.value!.historyId) ?? null : null);
const currentSourceChanged = computed(() => {
  const current = props.editor.activeKey ? props.editor.sessions[props.editor.activeKey] : undefined;
  return Boolean(record.value && current && JSON.stringify(current.locator) === JSON.stringify(record.value.result.locator)
    && current.sourceProjectRevision !== record.value.result.sourceProjectRevision);
});
const hasPendingInput = computed(() => props.debug.restoredFields.some((field) => field.needsInput));
const canRestoreSelected = computed(() => {
  const selected = selectedExchange.value;
  const replay = record.value?.result.replay;
  if (!selected?.intent || !replay || record.value?.result.identityAvailable === false || replay.identityAvailable === false) return false;
  const identity = replay.mode === "request" ? replay.locator : replay.case;
  const template = replay.mode === "request" ? replay.requestTemplate ?? replay.request : replay.requestTemplate;
  return Boolean(identity && template && (selected.intent.available || selected.intent.fields.some((field) => field.needsInput)));
});

watch(() => props.open, (open) => {
  if (!open) return;
  void props.history.load();
  searchText.value = "";
  method.value = "";
  resultFilter.value = "";
  restoreResult.value = null;
});

async function applyFilters() {
  const from = parseLocalDateTime(fromDate.value);
  const to = parseLocalDateTime(toDate.value);
  if (from === null || to === null || (from && to && Date.parse(from) > Date.parse(to))) {
    props.history.error = t("debugLoop.invalidDateRange");
    return;
  }
  props.history.error = null;
  props.history.filter = {
    limit: 50,
    offset: 0,
    ...(projectId.value ? { projectId: projectId.value } : {}),
    ...(apiId.value ? { apiId: apiId.value } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(searchText.value.trim() ? { text: searchText.value.trim() } : {}),
    ...(method.value.trim() ? { method: method.value.trim() } : {}),
    ...(resultFilter.value ? { result: resultFilter.value as "passed" | "failed" | "aborted" } : {}),
  };
  await props.history.refresh(true);
}

function scopeToCurrentProject() {
  if (!currentProjectId.value) return;
  projectId.value = currentProjectId.value;
  apiId.value = "";
}

function scopeToCurrentApi() {
  if (!currentProjectId.value || !currentApiId.value) return;
  projectId.value = currentProjectId.value;
  apiId.value = currentApiId.value;
}

function clearScope() {
  projectId.value = "";
  apiId.value = "";
}

function toLocalDateTime(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function parseLocalDateTime(value: string): string | undefined | null {
  if (!value) return undefined;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function summaryLabel(item: DebugHistorySummary): string {
  const when = new Date(item.createdAt).toLocaleString();
  return `${when} · ${item.method ?? item.mode.toUpperCase()} · ${item.apiName ?? item.collectionName ?? item.apiId ?? t("debugLoop.unknownApi")} · ${item.passed}/${item.total}`;
}

async function openRecord(item: DebugHistorySummary) {
  selectedExchangeOrder.value = null;
  restoreResult.value = null;
  await props.history.openRecord(item.historyId);
  selectedExchangeOrder.value = exchanges.value.find((exchange) => exchange.intent?.available || exchange.intent?.fields.some((field) => field.needsInput))?.order ?? exchanges.value[0]?.order ?? null;
}

async function deleteRecord() {
  if (!record.value || !window.confirm(t("debugLoop.deleteConfirm"))) return;
  busyAction.value = "delete";
  try { await props.history.deleteRecord(record.value.historyId); }
  finally { busyAction.value = ""; }
}

async function clearAll() {
  if (!window.confirm(t("debugLoop.clearAllConfirm"))) return;
  busyAction.value = "clear";
  props.history.error = null;
  try {
    const ids: string[] = [];
    let offset = 0;
    while (true) {
      const page = await props.api.debugHistoryList({ limit: 200, offset });
      ids.push(...page.items.map((item) => item.historyId));
      if (page.nextOffset === undefined || page.nextOffset <= offset) break;
      offset = page.nextOffset;
    }
    for (const historyId of ids) await props.api.debugHistoryDelete(historyId);
    props.history.selected = null;
    await props.history.refresh(true);
  } catch (error) {
    props.history.error = error instanceof Error ? error.message : String(error);
  } finally { busyAction.value = ""; }
}

async function restoreSelected() {
  if (!record.value || !selectedExchange.value) return;
  const identity = record.value.result.replay.mode === "request"
    ? record.value.result.replay.locator
    : record.value.result.replay.case;
  if (!identity) return;
  const locator = { workspaceId: identity.workspaceId, groupId: identity.groupId, projectId: identity.projectId,
    collectionId: identity.collectionId, folderIds: [...identity.folderIds], apiId: identity.apiId };
  busyAction.value = "restore";
  try {
    const restored = await props.debug.restoreHistory(
      { historyId: record.value.historyId, exchangeOrder: selectedExchange.value.order }, locator, props.editor,
      () => !(props.editor.dirty || props.editor.isProjectDirty({ workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId }, props.editor.sessions[props.editor.activeKey ?? ""]?.root ?? ""))
        || window.confirm(t("debugLoop.restoreDirtyConfirm")),
    );
    if (!restored) return;
    restoreResult.value = { sourceChanged: restored.sourceChanged, sourceAvailable: restored.sourceAvailable };
  } catch (error) {
    props.history.error = error instanceof Error ? error.message : String(error);
  } finally { busyAction.value = ""; }
}

async function replaySelected() {
  if (!record.value) return;
  const replay = record.value.result.replay;
  const identity = replay.mode === "request" ? replay.locator : replay.case;
  if (!identity) return;
  const locator = { workspaceId: identity.workspaceId, groupId: identity.groupId, projectId: identity.projectId,
    collectionId: identity.collectionId, folderIds: [...identity.folderIds], apiId: identity.apiId };
  busyAction.value = "replay";
  try { await props.debug.replay(record.value.historyId, props.editor, locator); }
  catch (error) { props.history.error = error instanceof Error ? error.message : String(error); }
  finally { busyAction.value = ""; }
}

async function savePreferences() {
  busyAction.value = "preferences";
  await props.history.updatePreferences({ ...props.history.preferences });
  busyAction.value = "";
}
</script>

<template>
  <a-modal :open="open" :title="t('debugLoop.historyTitle')" :footer="null" width="1040px" @cancel="emit('close')">
    <div class="history" data-testid="debug-history">
      <div class="history-toolbar">
        <a-input v-model:value="searchText" allow-clear :placeholder="t('debugLoop.searchHistory')" data-testid="debug-history-search" @press-enter="applyFilters" />
        <a-input v-model:value="method" allow-clear :placeholder="t('debugLoop.methodFilter')" data-testid="debug-history-method" @press-enter="applyFilters" />
        <a-select v-model:value="resultFilter" allow-clear :placeholder="t('debugLoop.resultFilter')" :options="[{label:t('debugLoop.passed'),value:'passed'},{label:t('debugLoop.failed'),value:'failed'},{label:t('debugLoop.aborted'),value:'aborted'}]" data-testid="debug-history-result-filter" />
        <a-button :disabled="!currentProjectId" data-testid="debug-history-current-project" @click="scopeToCurrentProject">{{ t("debugLoop.currentProject") }}</a-button>
        <a-button :disabled="!currentProjectId || !currentApiId" data-testid="debug-history-current-api" @click="scopeToCurrentApi">{{ t("debugLoop.currentApi") }}</a-button>
        <a-button data-testid="debug-history-all-scope" @click="clearScope">{{ t("debugLoop.allScopes") }}</a-button>
        <label class="date-filter">{{ t("debugLoop.from") }} <input v-model="fromDate" type="datetime-local" data-testid="debug-history-from" /></label>
        <label class="date-filter">{{ t("debugLoop.to") }} <input v-model="toDate" type="datetime-local" data-testid="debug-history-to" /></label>
        <a-button data-testid="debug-history-filter" @click="applyFilters">{{ t("debugLoop.filter") }}</a-button>
        <a-button :loading="busyAction === 'clear'" danger data-testid="debug-history-clear" @click="clearAll">{{ t("debugLoop.clearHistory") }}</a-button>
      </div>
      <a-alert v-if="history.error" type="error" show-icon :message="history.error" data-testid="debug-history-error" />
      <a-alert v-for="(diagnostic, index) in history.diagnostics" :key="`${diagnostic.code}-${index}`" type="warning" show-icon :message="diagnostic.message" :data-testid="`debug-history-diagnostic-${diagnostic.code}`" />
      <div class="history-columns">
        <section class="history-list" aria-label="history records">
          <EmptyState v-if="history.items.length === 0 && !history.loading" :text="t('debugLoop.noHistory')" />
          <button v-for="item in history.items" :key="item.historyId" type="button" class="history-row" :data-testid="`history-${item.historyId}`" @click="openRecord(item)">
            <span>{{ summaryLabel(item) }}</span>
            <a-tag :color="item.result === 'passed' ? 'success' : 'error'">{{ t(`debugLoop.${item.result}`) }}</a-tag>
          </button>
          <a-button v-if="history.nextOffset !== null" block :loading="history.loading" data-testid="debug-history-load-more" @click="history.loadMore()">{{ t("debugLoop.loadMore") }}</a-button>
        </section>
        <section class="history-detail" data-testid="debug-history-detail">
          <template v-if="record">
            <div class="detail-head">
              <span>{{ selectedSummary ? summaryLabel(selectedSummary) : record.historyId }}</span>
              <a-button size="small" danger :loading="busyAction === 'delete'" data-testid="debug-history-delete" @click="deleteRecord">{{ t("debugLoop.deleteRecord") }}</a-button>
            </div>
            <a-alert v-if="record.result.identityAvailable === false || record.result.replay.identityAvailable === false" type="warning" :message="t('debugLoop.identityUnavailable')" />
            <a-alert v-if="currentSourceChanged || restoreResult?.sourceChanged" type="warning" :message="t('debugLoop.sourceChanged')" data-testid="debug-history-source-changed" />
            <div class="exchange-select">
              <label>{{ t("debugLoop.exchange") }}</label>
              <a-select :value="selectedExchangeOrder ?? undefined" :options="exchanges.map((item) => ({ label: `#${item.order} · ${item.transportState}${item.observation ? ` · ${item.observation}` : ''}`, value: item.order }))" data-testid="debug-history-exchange" @update:value="(value) => selectedExchangeOrder = value as number" />
            </div>
            <pre v-if="selectedExchangeDisplay" class="projected-exchange">{{ JSON.stringify(selectedExchangeDisplay, null, 2) }}</pre>
            <p v-else class="note">{{ t("debugLoop.noExchange") }}</p>
            <div v-if="restoreResult && !restoreResult.sourceAvailable" class="note">{{ t("debugLoop.sourceUnavailable") }}</div>
            <section v-if="debug.restoredPreview && debug.restoredSourceAvailable === false" class="restore-preview" data-testid="debug-history-readonly-restore">
              <a-alert type="warning" show-icon :message="t('debugLoop.sourceUnavailable')" />
              <span class="note">{{ JSON.stringify(debug.restoredPreview.locator) }}</span>
              <pre class="projected-exchange">{{ JSON.stringify(debug.restoredPreview.request, null, 2) }}</pre>
              <div v-if="debug.restoredPreview.fields.some((field) => field.needsInput)" class="needs-input" data-testid="debug-history-pending-readonly">
                <span v-for="field in debug.restoredPreview.fields.filter((item) => item.needsInput)" :key="field.path">{{ field.path }} · {{ field.status }}</span>
              </div>
            </section>
            <div v-if="debug.restoredTargetKey && hasPendingInput" class="needs-input" data-testid="debug-history-needs-input">
              <label v-for="field in debug.restoredFields.filter((item) => item.needsInput)" :key="field.path">
                <span>{{ field.path }} · {{ field.status }}</span>
                <a-input :data-testid="`restore-field-${field.path}`" @update:value="(value) => debug.repairRestoredField(field.path, value as string, editor)" />
              </label>
            </div>
            <div class="detail-actions">
              <a-button type="primary" :disabled="!canRestoreSelected" :loading="busyAction === 'restore'" data-testid="debug-history-restore" @click="restoreSelected">{{ t("debugLoop.restoreRequest") }}</a-button>
              <a-button :disabled="!record.result.replay.available || record.result.identityAvailable === false" :loading="busyAction === 'replay'" data-testid="debug-history-replay" @click="replaySelected">{{ t("debugLoop.replay") }}</a-button>
            </div>
          </template>
          <EmptyState v-else :text="t('debugLoop.selectHistory')" />
        </section>
      </div>
      <section class="preferences" data-testid="debug-history-preferences">
        <h3>{{ t("debugLoop.historyPreferences") }}</h3>
        <label><input v-model="history.preferences.enabled" type="checkbox" data-testid="history-enabled" /> {{ t("debugLoop.historyEnabled") }}</label>
        <label>{{ t("debugLoop.retentionDays") }} <a-input-number v-model:value="history.preferences.retentionDays" :min="1" :max="3650" data-testid="history-retention-days" /></label>
        <label>{{ t("debugLoop.maxRecords") }} <a-input-number v-model:value="history.preferences.maxRecords" :min="1" :max="10000" data-testid="history-max-records" /></label>
        <span class="note">{{ t("debugLoop.historyPreferencesNote") }}</span>
        <a-button size="small" :loading="busyAction === 'preferences'" data-testid="history-preferences-save" @click="savePreferences">{{ t("debugLoop.savePreferences") }}</a-button>
      </section>
    </div>
  </a-modal>
</template>

<style scoped>
.history { display: flex; flex-direction: column; gap: 10px; max-height: 72vh; overflow: auto; }
.history-toolbar { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.history-toolbar > :first-child { flex: 2; }
.date-filter { display: flex; align-items: center; gap: 4px; color: var(--text-muted); font-size: 12px; }
.date-filter input { max-width: 190px; min-width: 150px; }
.history-columns { display: grid; grid-template-columns: minmax(290px, 0.8fr) minmax(420px, 1.2fr); gap: 12px; min-height: 260px; }
.history-list,.history-detail { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.history-list { max-height: 360px; overflow: auto; }
.history-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 8px; text-align: left; color: var(--text); background: var(--panel); border: 1px solid var(--border); border-radius: 4px; cursor: pointer; }
.history-row span { overflow-wrap: anywhere; }
.detail-head,.detail-actions,.exchange-select { display: flex; align-items: center; gap: 8px; }
.detail-head span { flex: 1; overflow-wrap: anywhere; }
.exchange-select label { min-width: 52px; }
.exchange-select :deep(.ant-select) { flex: 1; }
.projected-exchange { max-height: 230px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: var(--panel); border: 1px solid var(--border); padding: 8px; }
.needs-input { display: flex; flex-direction: column; gap: 6px; }
.needs-input label { display: flex; align-items: center; gap: 8px; }
.needs-input span { min-width: 150px; }
.preferences { border-top: 1px solid var(--border); padding-top: 8px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.preferences h3 { width: 100%; margin: 0; font-size: 14px; }
.preferences label { display: flex; align-items: center; gap: 6px; }
.preferences :deep(.ant-input-number) { width: 96px; }
.note { color: var(--text-muted); font-size: 12px; }
</style>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { MockProjectConfigSchema } from "@apicc/core/schema";
import type { ApiccApi } from "../../../shared/types.js";
import type { ProjectLocator } from "../../../shared/locations.js";
import type { MockStatus } from "../../../shared/mock.js";

const props = defineProps<{ api: ApiccApi; root?: string; locator: ProjectLocator; readOnly?: boolean }>();
const emit = defineEmits<{ "new-free-request": [] }>();
const { t } = useI18n();
const state = ref<MockStatus | null>(null);
const draft = ref("");
const draftBaseRevision = ref("");
const port = ref(0);
const busy = ref<string | null>(null);
const refreshing = ref(false);
const error = ref("");
const feedback = ref("");
let contextGeneration = 0;
const refreshes = new Map<number, PanelContext>();
let refreshTimer: ReturnType<typeof setInterval> | undefined;

type PanelContext = {
  key: string;
  generation: number;
  locator: ProjectLocator;
  api: ApiccApi;
};

const contextKey = computed(() => JSON.stringify([
  props.root ?? "",
  props.locator.workspaceId,
  props.locator.groupId,
  props.locator.projectId,
]));
const savedText = (config: MockStatus["config"]): string => JSON.stringify(config ?? { formatVersion: 1, seed: "apicc-mock", enabledContractIds: [], rules: [] }, null, 2);
const hasUnsavedDraft = computed(() => !!state.value && (!state.value.config || draft.value !== savedText(state.value.config)));
const draftIsStale = computed(() => hasUnsavedDraft.value && !!draftBaseRevision.value
  && draftBaseRevision.value !== state.value?.sourceProjectRevision);

const parsedConfig = computed(() => {
  try { return MockProjectConfigSchema.safeParse(JSON.parse(draft.value)); }
  catch { return { success: false as const, error: null }; }
});
const addressUrl = computed(() => {
  const address = state.value?.address;
  if (!address) return "";
  const host = address.address.includes(":") ? `[${address.address}]` : address.address;
  return `http://${host}:${address.port}`;
});
const canReload = computed(() => !!state.value?.address && ["running", "invalid"].includes(state.value.status));

function captureContext(): PanelContext {
  return {
    key: contextKey.value,
    generation: contextGeneration,
    locator: { workspaceId: props.locator.workspaceId, groupId: props.locator.groupId, projectId: props.locator.projectId },
    api: props.api,
  };
}

function isCurrent(context: PanelContext): boolean {
  return context.generation === contextGeneration && context.key === contextKey.value;
}

function adopt(next: MockStatus, context: PanelContext, resetDraft = false): void {
  if (!isCurrent(context)) return;
  const preserveDraft = hasUnsavedDraft.value;
  state.value = next;
  if (resetDraft || !preserveDraft) {
    draft.value = savedText(next.config);
    draftBaseRevision.value = next.sourceProjectRevision;
  }
}

async function refresh(context = captureContext()): Promise<void> {
  if (!isCurrent(context)) return;
  if (busy.value) return;
  if (refreshes.has(context.generation)) return;
  refreshes.set(context.generation, context);
  refreshing.value = true;
  error.value = "";
  try {
    const next = await context.api.mockGet(context.locator);
    adopt(next, context);
  } catch (cause) {
    if (isCurrent(context)) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (isCurrent(context)) refreshing.value = false;
    refreshes.delete(context.generation);
  }
}

watch(contextKey, () => {
  contextGeneration += 1;
  state.value = null;
  draft.value = "";
  draftBaseRevision.value = "";
  busy.value = null;
  refreshing.value = false;
  error.value = "";
  feedback.value = "";
  void refresh(captureContext());
}, { immediate: true });

async function runOperation(
  kind: string,
  invoke: (context: PanelContext, current: MockStatus) => Promise<MockStatus>,
  resetDraft = false,
): Promise<void> {
  const context = captureContext();
  const current = state.value;
  if (props.readOnly || busy.value || !current || !isCurrent(context)) return;
  busy.value = kind;
  error.value = "";
  feedback.value = "";
  try {
    const next = await invoke(context, current);
    adopt(next, context, resetDraft);
  } catch (cause) {
    if (isCurrent(context)) error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    if (isCurrent(context) && busy.value === kind) busy.value = null;
  }
}

async function saveConfig(): Promise<void> {
  const parsed = parsedConfig.value;
  if (!parsed.success) return;
  const config = parsed.data;
  const expectedRevision = draftBaseRevision.value;
  await runOperation("save", (context) => context.api.mockConfigSave({
    locator: context.locator,
    sourceProjectRevision: expectedRevision,
    config,
  }), true);
}

async function start(): Promise<void> {
  if (!Number.isInteger(port.value) || port.value < 0 || port.value > 65_535) return;
  await runOperation("start", (context, current) => context.api.mockStart({
    locator: context.locator,
    sourceProjectRevision: current.sourceProjectRevision,
    port: port.value,
  }));
}

async function stop(): Promise<void> {
  await runOperation("stop", (context, current) => context.api.mockStop({
    locator: context.locator,
    sourceProjectRevision: current.sourceProjectRevision,
  }));
}

async function reload(): Promise<void> {
  if (!canReload.value) return;
  await runOperation("reload", (context, current) => context.api.mockReload({
    locator: context.locator,
    sourceProjectRevision: current.sourceProjectRevision,
  }));
}

function useSavedConfig(): void {
  if (!state.value) return;
  draft.value = savedText(state.value.config);
  draftBaseRevision.value = state.value.sourceProjectRevision;
  error.value = "";
}

async function copyAddress(): Promise<void> {
  const context = captureContext();
  if (!addressUrl.value || !isCurrent(context)) return;
  try {
    await navigator.clipboard.writeText(addressUrl.value);
    if (isCurrent(context)) feedback.value = t("mockPanel.copied");
  } catch {
    if (isCurrent(context)) feedback.value = t("mockPanel.copyFailed");
  }
}

onMounted(() => {
  refreshTimer = setInterval(() => {
    if (state.value && !busy.value && !refreshing.value) void refresh();
  }, 2_000);
});

onUnmounted(() => {
  contextGeneration += 1;
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<template>
  <section class="mock-panel" data-testid="mock-panel">
    <header><h3>{{ t("mockPanel.title") }}</h3><span v-if="state?.simulated" data-testid="mock-simulated">{{ t("mockPanel.simulated") }}</span></header>
    <label class="mock-label" for="mock-config">{{ t("mockPanel.config") }}</label>
    <p v-if="hasUnsavedDraft" class="mock-note" data-testid="mock-unsaved">{{ t("mockPanel.unsaved") }}</p>
    <p v-if="state" class="mock-note" data-testid="mock-start-saved-note">{{ t("mockPanel.savedSemantics") }}</p>
    <p v-if="draftIsStale" class="mock-note" data-testid="mock-stale-draft">{{ t("mockPanel.staleDraft") }}</p>
    <textarea id="mock-config" v-model="draft" data-testid="mock-config" :disabled="props.readOnly || busy !== null || !state" rows="8" spellcheck="false"></textarea>
    <p v-if="!parsedConfig.success" class="mock-error" data-testid="mock-config-error">{{ t("mockPanel.invalidJson") }}</p>
    <div v-if="state && !state.config" class="mock-note">{{ t("mockPanel.noConfiguration") }}</div>
    <div class="mock-controls">
      <button type="button" data-testid="mock-save" :disabled="props.readOnly || busy !== null || !state || !parsedConfig.success || draftIsStale" @click="saveConfig">{{ t("mockPanel.save") }}</button>
      <button v-if="hasUnsavedDraft" type="button" data-testid="mock-use-saved" :disabled="busy !== null || !state" @click="useSavedConfig">{{ t("mockPanel.useSaved") }}</button>
      <button type="button" data-testid="mock-refresh" :disabled="busy !== null || refreshing" @click="refresh()">{{ refreshing ? t("mockPanel.refreshing") : t("mockPanel.refresh") }}</button>
      <label>{{ t("mockPanel.port") }} <input v-model.number="port" data-testid="mock-port" type="number" min="0" max="65535" :disabled="props.readOnly || busy !== null || !state"></label>
      <button type="button" data-testid="mock-start" :disabled="props.readOnly || busy !== null || !state?.config" @click="start">{{ busy === 'start' ? t("mockPanel.starting") : t("mockPanel.start") }}</button>
      <button type="button" data-testid="mock-stop" :disabled="props.readOnly || busy !== null || !state || state.status === 'stopped'" @click="stop">{{ t("mockPanel.stop") }}</button>
      <button type="button" data-testid="mock-reload" :disabled="props.readOnly || busy !== null || !canReload" @click="reload">{{ t("mockPanel.reload") }}</button>
      <button type="button" data-testid="mock-new-free-request" :disabled="!state" @click="emit('new-free-request')">{{ t("mockPanel.newFreeRequest") }}</button>
    </div>
    <p v-if="state" class="mock-status" data-testid="mock-status"><strong>{{ t("mockPanel.status") }}:</strong> {{ state.status }} · {{ t("mockPanel.revision") }} {{ state.sourceProjectRevision }}</p>
    <div v-if="addressUrl" class="mock-address">
      <strong>{{ t("mockPanel.address") }}:</strong>
      <span data-testid="mock-address">{{ addressUrl }}</span>
      <button type="button" data-testid="mock-copy-address" :disabled="busy !== null" @click="copyAddress">{{ t("mockPanel.copyAddress") }}</button>
    </div>
    <p v-if="feedback" role="status">{{ feedback }}</p>
    <p v-if="error" class="mock-error" role="alert">{{ error }}</p>
    <ul v-if="state?.diagnostics.length" class="mock-diagnostics" data-testid="mock-diagnostics">
      <li v-for="(diagnostic, index) in state.diagnostics" :key="`${diagnostic.code}-${index}`">{{ diagnostic.code }} · {{ diagnostic.path }} · {{ diagnostic.message }}</li>
    </ul>
    <section class="mock-logs">
      <h4>{{ t("mockPanel.logs") }}</h4>
      <p v-if="!state?.logs.length">{{ t("mockPanel.emptyLogs") }}</p>
      <ul v-else>
        <li v-for="log in state.logs" :key="log.requestId" :data-testid="`mock-log-row-${log.requestId}`">
          <span>{{ log.method }} {{ log.routeTemplate ?? "" }}</span>
          <span>{{ t("mockPanel.status") }} {{ log.status }} · {{ t("mockPanel.revision") }} {{ log.revision }} · {{ t("mockPanel.reason") }} {{ log.reason }}</span>
        </li>
      </ul>
    </section>
  </section>
</template>

<style scoped>
.mock-panel { flex: none; display: grid; gap: 8px; padding: 10px; border: 1px solid var(--border-color, #d9d9d9); border-radius: 6px; overflow: auto; }
.mock-panel header, .mock-controls, .mock-address { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mock-panel h3, .mock-panel h4, .mock-logs p, .mock-status { margin: 0; }
.mock-panel header { justify-content: space-between; }
.mock-panel textarea { width: 100%; resize: vertical; box-sizing: border-box; font: 12px/1.5 monospace; }
.mock-controls label { display: flex; align-items: center; gap: 6px; }
.mock-controls input { width: 100px; }
.mock-logs ul { display: grid; gap: 4px; margin: 0; padding-left: 20px; }
.mock-logs li { display: grid; gap: 2px; font: 12px/1.4 monospace; overflow-wrap: anywhere; }
.mock-error { color: #b42318; }
.mock-diagnostics { margin: 0; padding-left: 20px; }
</style>

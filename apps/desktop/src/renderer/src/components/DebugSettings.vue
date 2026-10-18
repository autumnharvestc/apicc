<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Alert as AAlert, Button as AButton, InputNumber as AInputNumber, Modal as AModal, Table as ATable } from "ant-design-vue";
import type { ApiccApi, DebugCookieSummary } from "../../../shared/types.js";
import type { useDebugStore } from "../stores/debug.js";
import type { useEditorStore } from "../stores/editor.js";
import type { RequestTab } from "../stores/requestTabs.js";

const props = defineProps<{
  open: boolean;
  api: ApiccApi;
  debug: ReturnType<typeof useDebugStore>;
  editor: ReturnType<typeof useEditorStore>;
  requestTab?: RequestTab | null;
}>();
const emit = defineEmits<{ (event: "close"): void }>();
const { t } = useI18n();
const cookies = ref<Awaited<ReturnType<ApiccApi["debugCookiesList"]>>>([]);
const cookieError = ref("");
const loadingCookies = ref(false);

const requestTabState = computed(() => props.requestTab ? props.debug.requestTabState(props.requestTab) : null);
const settings = computed(() => requestTabState.value?.settings ?? props.debug.settings);
const environmentId = computed(() => requestTabState.value?.selectedEnvironmentId
  ?? props.editor.envs.find((item) => item.name === props.debug.selectedEnvName)?.id);
const cookieInput = computed(() => props.requestTab?.source.kind === "free" ? null : props.editor.locator
  ? { locator: props.editor.locator, ...(environmentId.value ? { environmentId: environmentId.value } : {}) }
  : null);
const cookieColumns = computed(() => [
  { key: "name", dataIndex: "name", title: t("debugLoop.cookieName") },
  { key: "domain", dataIndex: "domain", title: t("debugLoop.cookieDomain") },
  { key: "path", dataIndex: "path", title: t("debugLoop.cookiePath") },
  { key: "flags", dataIndex: "secure", title: t("debugLoop.cookieFlags") },
]);

const defaults = {
  connectTimeoutMs: 10_000,
  headersTimeoutMs: 30_000,
  bodyTimeoutMs: 30_000,
  totalTimeoutMs: 30_000,
  uploadLimitBytes: 64 * 1024 * 1024,
  responseLimitBytes: 32 * 1024 * 1024,
};
type NumericSetting = keyof typeof defaults;

function settingValue(key: NumericSetting): number {
  return settings.value[key] ?? defaults[key];
}

function updateSettings(value: typeof settings.value) {
  if (requestTabState.value) requestTabState.value.settings = value;
  else props.debug.settings = value;
}

function updateSetting(key: NumericSetting, value: number | null) {
  if (value === null || !Number.isFinite(value) || value <= 0) return;
  updateSettings({ ...settings.value, [key]: Math.floor(value) });
}

function updateFollowRedirects(value: boolean) {
  updateSettings({ ...settings.value, followRedirects: value, maxRedirects: value ? settings.value.maxRedirects ?? 10 : 0 });
}

function updateMaxRedirects(value: number | null) {
  if (value === null || !Number.isInteger(value) || value < 0 || value > 10) return;
  updateSettings({ ...settings.value, maxRedirects: value, followRedirects: value > 0 });
}

function cookieCell(record: unknown, dataIndex: unknown): string {
  const key = Array.isArray(dataIndex) ? dataIndex[0] : dataIndex;
  const cookie = record as Partial<DebugCookieSummary>;
  if (key === "name") return cookie.name || "—";
  if (key === "domain") return cookie.domain || "—";
  if (key === "path") return cookie.path || "—";
  return "—";
}

async function refreshCookies() {
  if (!cookieInput.value) { cookies.value = []; return; }
  loadingCookies.value = true;
  cookieError.value = "";
  try { cookies.value = await props.api.debugCookiesList(cookieInput.value); }
  catch (error) { cookieError.value = error instanceof Error ? error.message : String(error); }
  finally { loadingCookies.value = false; }
}

async function clearCookies() {
  if (!cookieInput.value || cookies.value.length === 0) return;
  if (!window.confirm(t("debugLoop.clearCookiesConfirm"))) return;
  try {
    await props.api.debugCookiesClear(cookieInput.value);
    cookies.value = [];
  } catch (error) { cookieError.value = error instanceof Error ? error.message : String(error); }
}

watch(() => [props.open, props.editor.activeKey, props.requestTab?.tabId, environmentId.value] as const, ([open]) => {
  if (open) void refreshCookies();
});
</script>

<template>
  <a-modal :open="open" :title="t('debugLoop.settingsTitle')" :footer="null" width="760px" @cancel="emit('close')">
    <div class="settings" data-testid="debug-settings">
      <p class="note">{{ t("debugLoop.settingsNote") }}</p>
      <div class="setting-grid">
        <label v-for="key in ['connectTimeoutMs','headersTimeoutMs','bodyTimeoutMs','totalTimeoutMs'] as NumericSetting[]" :key="key">
          <span>{{ t(`debugLoop.${key}`) }}</span>
          <a-input-number :value="settingValue(key)" :min="1" :max="600000" :data-testid="`debug-setting-${key}`" @update:value="(value) => updateSetting(key, value as number | null)" />
        </label>
        <label>
          <span>{{ t("debugLoop.followRedirects") }}</span>
        <input type="checkbox" :checked="settings.followRedirects ?? false" data-testid="debug-setting-followRedirects" @change="updateFollowRedirects(($event.target as HTMLInputElement).checked)" />
        </label>
        <label>
          <span>{{ t("debugLoop.maxRedirects") }}</span>
          <a-input-number :value="settings.maxRedirects ?? 10" :min="0" :max="10" :disabled="!(settings.followRedirects ?? false)" data-testid="debug-setting-maxRedirects" @update:value="(value) => updateMaxRedirects(value as number | null)" />
        </label>
        <label v-for="key in ['uploadLimitBytes','responseLimitBytes'] as NumericSetting[]" :key="key">
          <span>{{ t(`debugLoop.${key}`) }}</span>
          <a-input-number :value="settingValue(key)" :min="1" :max="key === 'uploadLimitBytes' ? 1073741824 : 134217728" :data-testid="`debug-setting-${key}`" @update:value="(value) => updateSetting(key, value as number | null)" />
        </label>
      </div>
      <section v-if="requestTab?.source.kind !== 'free'" class="cookies">
        <div class="cookie-head">
          <h3>{{ t("debugLoop.cookiesTitle") }}</h3>
          <a-button size="small" :loading="loadingCookies" data-testid="debug-cookies-refresh" @click="refreshCookies">{{ t("debugLoop.refresh") }}</a-button>
          <a-button size="small" danger :disabled="cookies.length === 0" data-testid="debug-cookies-clear" @click="clearCookies">{{ t("debugLoop.clearCookies") }}</a-button>
        </div>
        <p class="note">{{ t("debugLoop.cookiesNote") }}</p>
        <a-alert v-if="cookieError" type="error" show-icon :message="cookieError" data-testid="debug-cookies-error" />
        <a-table size="small" :pagination="false" :columns="cookieColumns" :data-source="cookies" row-key="name" data-testid="debug-cookies">
          <template #bodyCell="{ column, record }">
            <span v-if="column.key === 'flags'">{{ [record.secure ? 'Secure' : '', record.httpOnly ? 'HttpOnly' : '', record.sameSite].filter(Boolean).join(' · ') || '—' }}</span>
            <span v-else>{{ cookieCell(record, column.dataIndex) }}</span>
          </template>
        </a-table>
      </section>
    </div>
  </a-modal>
</template>

<style scoped>
.settings { display: flex; flex-direction: column; gap: 14px; }
.note { margin: 0; color: var(--text-muted); font-size: 12px; }
.setting-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px 16px; }
.setting-grid label { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.setting-grid :deep(.ant-input-number) { width: 170px; }
.cookies { border-top: 1px solid var(--border); padding-top: 10px; }
.cookie-head { display: flex; align-items: center; gap: 8px; }
.cookie-head h3 { flex: 1; margin: 0; font-size: 14px; }
</style>

<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { OnlineExecutionStore } from "../stores/onlineExecution.js";
import { DEFAULT_ONLINE_EXECUTION_CACHE_PREFERENCES, OnlineExecutionCachePreferencesSchema, type OnlineExecutionCachePreferences } from "../stores/onlineExecutionCachePreferences.js";

const props = withDefaults(defineProps<{
  execution: Pick<OnlineExecutionStore, "cachePreferences" | "cacheUsage" | "setCachePreferences" | "cachePreferenceDiagnostic">;
  open?: boolean;
}>(), { open: true });
const { t, locale } = useI18n();
type Field = keyof OnlineExecutionCachePreferences;
const fields: Array<{ key: Field; min: number; max: number; unit: string; testId: string }> = [
  { key: "maxInactiveContexts", min: 0, max: 200, unit: "contextsUnit", testId: "execution-cache-max-contexts" },
  { key: "inactiveTtlMinutes", min: 1, max: 1440, unit: "minutesUnit", testId: "execution-cache-ttl" },
  { key: "maxInactivePayloadMiB", min: 1, max: 512, unit: "mibUnit", testId: "execution-cache-max-payload" },
];
const draft = reactive(Object.fromEntries(fields.map(field => [field.key, String(props.execution.cachePreferences[field.key])])) as Record<Field, string>);
const saved = ref(false);
const failure = ref("");
function values() { return Object.fromEntries(fields.map(field => [field.key, draft[field.key].trim() === "" ? NaN : Number(draft[field.key])])); }
const parsed = computed(() => OnlineExecutionCachePreferencesSchema.safeParse(values()));
const dirty = computed(() => fields.some(field => draft[field.key] !== String(props.execution.cachePreferences[field.key])));
const usage = computed(() => props.execution.cacheUsage);
const payloadMiB = computed(() => {
  const bytes = usage.value.inactivePayloadBytes;
  if (bytes > 0 && bytes < 0.01 * 1024 * 1024) return t("executionCacheSettings.belowMiB");
  return `${new Intl.NumberFormat(locale.value, { maximumFractionDigits: 2 }).format(bytes / 1024 / 1024)} MiB`;
});
function errorText(code: string | null) {
  switch (code) {
    case "online-cache-settings-invalid": return t("executionCacheSettings.invalid");
    case "online-cache-settings-save-failed": return t("executionCacheSettings.saveFailed");
    case "online-cache-settings-corrupt": return t("executionCacheSettings.corrupt");
    case "online-cache-settings-unavailable": return t("executionCacheSettings.unavailable");
    default: return code;
  }
}
function hydrate() {
  for (const field of fields) draft[field.key] = String(props.execution.cachePreferences[field.key]);
  saved.value = false; failure.value = "";
}
watch(() => props.open, open => { if (open) hydrate(); });
watch(() => props.execution.cachePreferences, hydrate, { flush: "sync" });
function edit(key: Field, event: Event) { draft[key] = (event.target as HTMLInputElement).value; saved.value = false; failure.value = ""; }
function save() {
  saved.value = false; failure.value = "";
  const result = parsed.value;
  if (!result.success) { failure.value = "online-cache-settings-invalid"; return; }
  try {
    props.execution.setCachePreferences(result.data);
    hydrate(); saved.value = true;
  } catch (error) { failure.value = error instanceof Error ? error.message : String(error); }
}
</script>

<template>
  <section class="execution-cache-settings" data-testid="execution-cache-settings" aria-labelledby="execution-cache-title">
    <h3 id="execution-cache-title">{{ t('executionCacheSettings.title') }}</h3>
    <p>{{ t('executionCacheSettings.localOnly') }}</p>
    <p v-if="execution.cachePreferenceDiagnostic && execution.cachePreferenceDiagnostic !== failure" class="warning" role="alert" data-testid="execution-cache-diagnostic">{{ errorText(execution.cachePreferenceDiagnostic) }}</p>
    <form data-testid="execution-cache-form" @submit.prevent="save">
      <label v-for="field in fields" :key="field.key" class="cache-field">
        <span>{{ t(`executionCacheSettings.${field.key}`) }}</span>
        <span class="cache-value"><input :data-testid="field.testId" :value="draft[field.key]" type="number" :min="field.min" :max="field.max" step="1" required @input="edit(field.key, $event)" />{{ t(`executionCacheSettings.${field.unit}`) }}</span>
        <small>{{ t('executionCacheSettings.range', { default: DEFAULT_ONLINE_EXECUTION_CACHE_PREFERENCES[field.key], min: field.min, max: field.max, unit: t(`executionCacheSettings.${field.unit}`) }) }}</small>
      </label>
      <p class="hint">{{ t('executionCacheSettings.zeroHint') }}</p>
      <p v-if="dirty && !parsed.success" class="error" role="alert" data-testid="execution-cache-invalid">{{ t('executionCacheSettings.invalid') }}</p>
      <div class="save-row"><button type="submit" data-testid="execution-cache-save" :disabled="!parsed.success">{{ t('executionCacheSettings.save') }}</button><span v-if="dirty">{{ t('executionCacheSettings.unsaved') }}</span></div>
      <p v-if="failure" role="alert" class="error" data-testid="execution-cache-error">{{ errorText(failure) }}</p>
      <p v-if="saved" role="status" data-testid="execution-cache-saved">{{ t('executionCacheSettings.saved') }}</p>
    </form>
    <h4>{{ t('executionCacheSettings.usageTitle') }}</h4>
    <dl data-testid="execution-cache-usage">
      <dt>{{ t('executionCacheSettings.currentContexts') }}</dt><dd data-testid="execution-cache-current">{{ usage.currentContexts }}</dd>
      <dt>{{ t('executionCacheSettings.protectedContexts') }}</dt><dd data-testid="execution-cache-protected">{{ usage.protectedContexts }}</dd>
      <dt>{{ t('executionCacheSettings.inactiveContexts') }}</dt><dd data-testid="execution-cache-inactive">{{ usage.inactiveContexts }}</dd>
      <dt>{{ t('executionCacheSettings.inactivePayload') }}</dt><dd data-testid="execution-cache-payload" :title="t('executionCacheSettings.rawBytes', { bytes: usage.inactivePayloadBytes })">{{ payloadMiB }}</dd>
    </dl>
    <p v-if="usage.overLimit" role="status" class="warning" data-testid="execution-cache-over-limit">{{ t('executionCacheSettings.overLimit') }}</p>
    <p class="hint">{{ t('executionCacheSettings.protection') }}</p>
    <ul class="cache-notes"><li>{{ t('executionCacheSettings.cleanupHint') }}</li><li>{{ t('executionCacheSettings.restoreHint') }}</li><li>{{ t('executionCacheSettings.ttlHint') }}</li><li>{{ t('executionCacheSettings.estimateHint') }}</li></ul>
  </section>
</template>

<style scoped src="../styles/editor-controls.css"></style>
<style scoped>
.execution-cache-settings{margin:16px 0;padding-top:12px;border-top:1px solid var(--border);font-size:13px;min-width:0;overflow-wrap:anywhere}h3,h4{margin:0 0 8px}p{margin:6px 0}.cache-field{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;margin:12px 0}.cache-field small{grid-column:1/-1;color:var(--text-muted)}.cache-value{display:flex;align-items:center;gap:6px;white-space:nowrap}input{box-sizing:border-box;width:90px;max-width:100%;padding:4px;background:var(--bg);color:var(--text);border:1px solid var(--border)}.save-row{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.save-row button{padding:5px 10px}.save-row span,.hint{color:var(--text-muted)}dl{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 12px;margin:8px 0}dt,dd{margin:0}dd{font-variant-numeric:tabular-nums}.warning{color:var(--warning,#ad6800)}.error{color:var(--fail,#cf1322)}.cache-notes{margin:10px 0;padding-left:20px}.cache-notes li{margin:6px 0;line-height:1.5}

.execution-cache-settings { padding: 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--subtle); } .warning { color: var(--text); border-left: 3px solid var(--accent); padding-left: 8px; } .cache-field { grid-template-columns: minmax(0,1fr) minmax(100px,auto); } .cache-value { flex-wrap: wrap; }

</style>

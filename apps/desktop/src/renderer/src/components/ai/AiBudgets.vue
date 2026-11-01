<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { AiBudgetOverridesSchema, AiApplicationProtectionSchema, AiPurposeSchema } from "@apicc/core/schema";
import type { AiPurpose, AiBudgetOverrides, AiApplicationProtection } from "@apicc/core";
import type { AiStore } from "../../stores/ai.js";
const props = defineProps<{ ai: AiStore }>();
const { t } = useI18n();
const modelId = ref(props.ai.settings?.models[0]?.id ?? "");
const purpose = ref<AiPurpose>("case-suggestion");
const layer = ref<"model" | "modelPurpose" | "application" | "binding">("model");
const draft = ref<AiBudgetOverrides>({});
const protection = ref<AiApplicationProtection>(JSON.parse(JSON.stringify(props.ai.settings?.application.protection)));
const fields = Object.keys(AiBudgetOverridesSchema.shape) as (keyof AiBudgetOverrides)[];
const protectionFields = Object.keys(AiApplicationProtectionSchema.shape) as (keyof AiApplicationProtection)[];
function load() {
  const settings = props.ai.settings; if (!settings) return;
  const model = settings.models.find(m => m.id === modelId.value);
  const value = layer.value === "application" ? settings.application.purposeDefaults[purpose.value] : layer.value === "model" ? model?.budgets : layer.value === "modelPurpose" ? model?.purposeBudgets[purpose.value] : settings.bindings.find(b => b.purpose === purpose.value)?.budgets;
  draft.value = JSON.parse(JSON.stringify(value ?? {}));
  protection.value = JSON.parse(JSON.stringify(settings.application.protection));
}
watch([() => props.ai.settings, purpose, layer], () => {
  const binding = props.ai.settings?.bindings.find(value => value.purpose === purpose.value);
  if (layer.value === "binding" && binding) modelId.value = binding.modelProfileId;
  load();
}, { immediate: true });
// Explicit model selection changes the draft target; it must not rehydrate the saved target over the user's choice.
watch(modelId, load);
const resolved = computed(() => { try { return props.ai.resolveSettings(modelId.value, purpose.value); } catch { return null; } });
const itemUnits: Record<string, string> = { candidateCount: 'items', evidenceCount: 'items' };
const unit = (field: string) => t(`aiSettings.units.${itemUnits[field] ?? (field.endsWith('Ms') ? 'ms' : field.endsWith('Bytes') ? 'bytes' : field.endsWith('Tokens') ? 'tokens' : 'count')}`);
function change(event: Event, key: keyof AiBudgetOverrides) { const raw = (event.target as HTMLInputElement).value; if (raw === "") delete draft.value[key]; else draft.value[key] = Number(raw); }
async function save() {
  const settings = props.ai.settings; if (!settings) return;
  const budgets = { ...draft.value };
  if (layer.value === "application") {
    await props.ai.writeSettings({ operation: "preferences", expectedRevision: settings.revision, application: { ...settings.application, purposeDefaults: { ...settings.application.purposeDefaults, [purpose.value]: budgets } } });
  } else if (layer.value === "binding") {
    const binding = { purpose: purpose.value, modelProfileId: modelId.value, budgets };
    const bindings = settings.bindings.some(b => b.purpose === purpose.value) ? settings.bindings.map(b => b.purpose === purpose.value ? binding : b) : [...settings.bindings, binding];
    await props.ai.writeSettings({ operation: "preferences", expectedRevision: settings.revision, bindings });
  } else {
    const models = settings.models.map(m => m.id !== modelId.value ? m : layer.value === "model" ? { ...m, budgets } : { ...m, purposeBudgets: { ...m.purposeBudgets, [purpose.value]: budgets } });
    await props.ai.writeSettings({ operation: "preferences", expectedRevision: settings.revision, models });
  }
}
async function restore(key: keyof AiBudgetOverrides) { delete draft.value[key]; await save(); }
async function saveProtection() {
  const settings = props.ai.settings; if (!settings) return;
  await props.ai.writeSettings({ operation: "preferences", expectedRevision: settings.revision, application: { ...settings.application, protection: protection.value } });
}
</script>
<template>
  <section><h3>{{ t('aiSettings.budgets') }}</h3>
    <div class="ai-grid">
      <label>{{ t('ai.model') }}<select v-model="modelId" data-testid="budget-model"><option v-for="model in ai.settings?.models" :key="model.id" :value="model.id">{{ model.modelId }}</option></select></label>
      <label>{{ t('aiSettings.purpose') }}<select v-model="purpose" data-testid="budget-purpose"><option v-for="value in AiPurposeSchema.options" :key="value" :value="value">{{ t(`aiSettings.purposes.${value}`) }}</option></select></label>
      <label>{{ t('aiSettings.layer') }}<select v-model="layer" data-testid="budget-layer"><option v-for="value in ['model', 'modelPurpose', 'application', 'binding']" :key="value" :value="value">{{ t(`aiSettings.${value}`) }}</option></select></label>
    </div>
    <div class="ai-scroll"><table><thead><tr><th>{{ t('aiSettings.name') }}</th><th>{{ t('aiSettings.layer') }}</th><th>{{ t('aiSettings.effective') }}</th><th>{{ t('aiSettings.source') }}</th><th>{{ t('aiSettings.action') }}</th></tr></thead><tbody>
      <tr v-for="key in fields" :key="key"><td>{{ t(`aiSettings.fields.${key}`) }} ({{ unit(key) }})</td><td><input :value="draft[key]" type="number" :min="AiBudgetOverridesSchema.shape[key].unwrap().minValue ?? undefined" :max="AiBudgetOverridesSchema.shape[key].unwrap().maxValue ?? undefined" :placeholder="t('aiSettings.inherit')" :aria-label="t(`aiSettings.fields.${key}`)" :data-testid="`budget-${key}`" @input="change($event, key)"></td><td :data-testid="`effective-${key}`">{{ resolved?.budgets[key] ?? t('aiSettings.unknown') }} {{ unit(key) }}</td><td>{{ resolved?.sources[key] ? t(`aiSettings.sourceLabels.${resolved.sources[key]?.source}`) : t('aiSettings.unknown') }} <span v-if="resolved?.sources[key]?.limitedBy">{{ t('aiSettings.limited') }}</span></td><td><button :data-testid="`inherit-${key}`" :disabled="ai.savingConfig" @click="restore(key)">{{ t('aiSettings.restore') }}</button></td></tr>
    </tbody></table></div>
    <p v-for="warning in resolved?.warnings" :key="warning" role="note">{{ t('aiSettings.requestCostWarning') }}</p>
    <button data-testid="budget-save" :disabled="ai.savingConfig" @click="save">{{ t('aiSettings.saveBudgets') }}</button>
    <h3>{{ t('aiSettings.protection') }}</h3>
    <div class="ai-grid"><label v-for="key in protectionFields" :key="key">{{ t(`aiSettings.fields.${key}`) }} ({{ unit(key) }})<input v-model.number="protection[key]" type="number" :min="AiApplicationProtectionSchema.shape[key].minValue ?? undefined" :max="AiApplicationProtectionSchema.shape[key].maxValue ?? undefined" :data-testid="`protection-${key}`"></label></div>
    <button data-testid="protection-save" :disabled="ai.savingConfig" @click="saveProtection">{{ t('aiSettings.saveProtection') }}</button>
  </section>
</template>

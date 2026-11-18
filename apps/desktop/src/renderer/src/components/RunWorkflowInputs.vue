<script setup lang="ts">
import { computed, reactive, watchEffect } from "vue";
import { useI18n } from "vue-i18n";
import type { JsonValue, Workflow } from "@apicc/core";
import { JsonValueSchema } from "@apicc/core/schema";
import { useLaunchMessages } from "../execution/launchMessages.js";

const props = defineProps<{ workflow: Workflow }>();
const emit = defineEmits<{ change: [inputs: Record<string, JsonValue> | undefined, valid: boolean] }>();
const { t } = useI18n();
const label = useLaunchMessages();
const entered = reactive<Record<string, string>>(Object.create(null));
const definitions = computed(() => props.workflow.executionVersion === 2 ? Object.entries(props.workflow.inputs) : []);
const checked = computed(() => {
  const values: Array<[string, JsonValue]> = [];
  const errors = new Map<string, string>();
  for (const [name, definition] of definitions.value) {
    const text = entered[name];
    if (!text?.trim()) {
      if (definition.required && definition.default === undefined) errors.set(name, label("missingInput", { name }));
      continue;
    }
    try { values.push([name, JsonValueSchema.parse(JSON.parse(text))]); }
    catch { errors.set(name, t("wf.control.invalidJson")); }
  }
  return { inputs: props.workflow.executionVersion === 2 ? Object.fromEntries(values) : undefined, errors };
});
watchEffect(() => emit("change", checked.value.inputs, checked.value.errors.size === 0));
</script>

<template>
  <fieldset v-if="definitions.length" class="run-inputs">
    <legend>{{ label("inputs") }}</legend>
    <label v-for="[name, definition] in definitions" :key="name">
      <span>{{ name }}<small v-if="definition.required && definition.default === undefined"> · {{ label("required") }}</small></span>
      <input v-model="entered[name]" type="text" :placeholder="definition.default === undefined ? t('wf.control.jsonValue') : JSON.stringify(definition.default)" :aria-invalid="checked.errors.has(name)" />
      <small v-if="checked.errors.has(name)" class="input-error">{{ checked.errors.get(name) }}</small>
    </label>
  </fieldset>
</template>

<style scoped>
.run-inputs { display: grid; gap: 8px; min-width: 0; border: 1px solid var(--border); border-radius: 6px; }
.run-inputs label { display: grid; gap: 4px; overflow-wrap: anywhere; }
.run-inputs input { min-width: 0; color: inherit; background: var(--surface); border: 1px solid var(--border); border-radius: 5px; padding: 4px 6px; }
.input-error { color: var(--fail); }
</style>

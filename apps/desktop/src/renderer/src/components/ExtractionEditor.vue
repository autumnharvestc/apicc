<script setup lang="ts">
import { reactive } from "vue";
import { useI18n } from "vue-i18n";
import { ExtractionListSchema, type ExtractionDefinition } from "@apicc/core/schema";
import { compileRegex } from "@apicc/core/assert/regex";
const props = defineProps<{ items: ExtractionDefinition[]; readOnly?: boolean }>();
const emit = defineEmits<{ validity: [message: string] }>();
const { t } = useI18n();
const errors = reactive<Record<string, Record<string, string>>>({});
const targets = ["status", "responseTime", "header", "bodyText", "bodyJson", "bodyXml", "cookie"];
function validate() {
  for (const row of props.items) {
    if (row.method !== "regex") delete errors[row.id]?.regex;
    else {
      try { compileRegex(row.pattern, row.flags); delete errors[row.id]?.regex; }
      catch (error) { (errors[row.id] ??= {}).regex = error instanceof Error ? error.message : String(error); }
    }
  }
  const parsed = ExtractionListSchema.safeParse(props.items);
  emit("validity", [...Object.values(errors).flatMap(Object.values), ...(parsed.success ? [] : parsed.error.issues.map(item => item.message))].join("; "));
}
const rowError = (row: ExtractionDefinition) => Object.values(errors[row.id] ?? {}).join("; ");
function change(row: ExtractionDefinition, key: string, value: unknown) { if (!props.readOnly) { Object.assign(row, { [key]: value }); validate(); } }
function selector(row: ExtractionDefinition, key: string, value: unknown) {
  if (props.readOnly) return;
  Object.assign(row.selector, { [key]: value });
  if (key === "target") {
    if (value !== "header") delete row.selector.headerName;
    if (value !== "cookie") delete row.selector.cookieName;
    if (value !== "bodyXml") { delete row.selector.namespaces; delete errors[row.id]?.namespaces; }
    if (value !== "bodyXml" && value !== "bodyJson") delete row.selector.path;
  }
  validate();
}
function method(row: ExtractionDefinition, value: string) {
  if (props.readOnly) return;
  if (value === "regex") { Object.assign(row, { method: "regex", pattern: "", group: 0, regexMatch: "first" }); row.selector.match = "first"; }
  else { for (const key of ["pattern", "flags", "group", "regexMatch"]) delete (row as unknown as Record<string, unknown>)[key]; Object.assign(row, { method: "value" }); }
  validate();
}
function json(row: ExtractionDefinition, field: "defaultValue" | "namespaces", value: string) {
  if (props.readOnly) return;
  try {
    const owner = field === "namespaces" ? row.selector : row;
    if (!value.trim()) delete (owner as Record<string, unknown>)[field]; else Object.assign(owner, { [field]: JSON.parse(value) });
    delete errors[row.id]?.[field]; validate();
  } catch (error) { (errors[row.id] ??= {})[field] = error instanceof Error ? error.message : String(error); validate(); }
}
function regex(row: ExtractionDefinition, field: string, value: unknown) {
  change(row, field, value);
}
function add() { if (!props.readOnly) { props.items.push({ id: crypto.randomUUID(), name: "value", selector: { target: "bodyJson", path: "$", match: "first" }, method: "value", required: true, sensitive: false }); validate(); } }
function remove(index: number) { if (!props.readOnly) { delete errors[props.items[index]!.id]; props.items.splice(index, 1); validate(); } }
</script>
<template>
  <div class="extraction-editor">
    <h4>{{ t('testing.extractions') }}</h4>
    <div v-for="(row,index) in items" :key="row.id" class="extraction-row">
      <label>{{ t('testing.variableName') }}<input :value="row.name" :disabled="readOnly" data-testid="extraction-name" @input="change(row, 'name', ($event.target as HTMLInputElement).value)" /></label>
      <label>{{ t('case.target') }}<select :value="row.selector.target" :disabled="readOnly" @change="selector(row,'target',($event.target as HTMLSelectElement).value)"><option v-for="value in targets" :key="value">{{ value }}</option></select></label>
      <label v-if="row.selector.target === 'header'">{{ t('case.headerName') }}<input :value="row.selector.headerName" :disabled="readOnly" @input="selector(row,'headerName',($event.target as HTMLInputElement).value)" /></label>
      <label v-if="row.selector.target === 'cookie'">{{ t('testing.cookieName') }}<input :value="row.selector.cookieName" :disabled="readOnly" @input="selector(row,'cookieName',($event.target as HTMLInputElement).value)" /></label>
      <label v-if="['bodyJson','bodyXml'].includes(row.selector.target)">{{ t('case.path') }}<input :value="row.selector.path" :disabled="readOnly" @input="selector(row,'path',($event.target as HTMLInputElement).value)" /></label>
      <label>{{ t('testing.match') }}<select :value="row.selector.match ?? 'first'" :disabled="readOnly || row.method === 'regex'" @change="selector(row,'match',($event.target as HTMLSelectElement).value)"><option>first</option><option>all</option></select></label>
      <label>{{ t('testing.method') }}<select :value="row.method" :disabled="readOnly" @change="method(row,($event.target as HTMLSelectElement).value)"><option>value</option><option>regex</option></select></label>
      <template v-if="row.method === 'regex'">
        <label>{{ t('testing.pattern') }}<input :value="row.pattern" :disabled="readOnly" @input="regex(row,'pattern',($event.target as HTMLInputElement).value)" /></label>
        <label>{{ t('testing.flags') }}<input :value="row.flags" :disabled="readOnly" @input="regex(row,'flags',($event.target as HTMLInputElement).value)" /></label>
        <label>{{ t('testing.group') }}<input type="number" min="0" :value="row.group ?? 0" :disabled="readOnly" @input="change(row,'group',Number(($event.target as HTMLInputElement).value))" /></label>
        <label>{{ t('testing.regexMatch') }}<select :value="row.regexMatch ?? 'first'" :disabled="readOnly" @change="change(row,'regexMatch',($event.target as HTMLSelectElement).value)"><option>first</option><option>all</option></select></label>
        <p class="hint">{{ t('testing.regexHint') }}</p>
      </template>
      <label v-if="row.selector.target === 'bodyXml'">{{ t('testing.namespaces') }}<input :value="JSON.stringify(row.selector.namespaces ?? {})" :disabled="readOnly" @change="json(row,'namespaces',($event.target as HTMLInputElement).value)" /></label>
      <label><input type="checkbox" :checked="row.required ?? true" :disabled="readOnly" @change="change(row,'required',($event.target as HTMLInputElement).checked)" />{{ t('testing.required') }}</label>
      <label><input type="checkbox" :checked="row.sensitive ?? false" :disabled="readOnly" data-testid="extraction-sensitive" @change="change(row,'sensitive',($event.target as HTMLInputElement).checked)" />{{ t('testing.sensitive') }}</label>
      <label>{{ t('testing.defaultValue') }}<input :value="row.defaultValue === undefined ? '' : JSON.stringify(row.defaultValue)" :disabled="readOnly" @change="json(row,'defaultValue',($event.target as HTMLInputElement).value)" /></label>
      <button type="button" :disabled="readOnly" @click="remove(index)">{{ t('testing.remove') }}</button>
      <p v-if="rowError(row)" role="alert">{{ rowError(row) }}</p>
    </div>
    <p class="hint">{{ t('testing.extractionHint') }}</p>
    <button type="button" data-testid="extraction-add" :disabled="readOnly || items.length >= 64" @click="add">{{ t('testing.addExtraction') }}</button>
  </div>
</template>
<style scoped>
.extraction-editor{display:flex;flex-direction:column;gap:8px}.extraction-row{display:flex;flex-wrap:wrap;gap:8px;border:1px solid var(--border);padding:8px;border-radius:6px}label{display:flex;align-items:center;gap:4px;font-size:12px}input,select{max-width:240px;color:var(--text);background:var(--bg);border:1px solid var(--border);padding:4px}.hint{color:var(--text-muted);font-size:12px;margin:0}p[role=alert]{color:var(--fail,#cf1322)}h4{margin:4px 0}
</style>

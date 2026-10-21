<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { JsonValue } from "@apicc/core";
import type { TestingStore } from "../stores/testing.js";
const props = defineProps<{ testing: TestingStore }>();
const { t } = useI18n();
const page = ref(0); const format = ref<"json" | "csv">("json"); const content = ref(""); const columns = ref(""); const error = ref(""); const exported = ref<{ format: "json" | "csv"; text: string } | null>(null);
const dataset = computed(() => props.testing.dataset);
const resourceKey = computed(() => JSON.stringify([props.testing.view?.context.root, props.testing.view?.context.project, dataset.value?.id]));
const pages = computed(() => Math.max(1, Math.ceil((dataset.value?.rows.length ?? 0) / 100)));
const rows = computed(() => dataset.value?.rows.slice(page.value * 100, page.value * 100 + 100) ?? []);
watch(resourceKey, () => { page.value = 0; columns.value = dataset.value?.columns.join("\n") ?? ""; content.value = ""; error.value = ""; exported.value = null; }, { immediate: true });
watch(() => dataset.value?.rows.length, () => { page.value = Math.min(page.value, pages.value - 1); columns.value = dataset.value?.columns.join("\n") ?? ""; });
async function attempt(operation: () => unknown | Promise<unknown>) { const key = resourceKey.value; try { await operation(); if (key === resourceKey.value) error.value = ""; } catch (failure) { if (key === resourceKey.value) error.value = failure instanceof Error ? failure.message : String(failure); } }
function field(key: "name" | "description", value: string) { if (!props.testing.readOnly && dataset.value) dataset.value[key] = value; }
function applyColumns() {
  if (props.testing.readOnly || !dataset.value) return;
  const names = columns.value.split(/\r?\n/).map(name => name.trim()).filter(Boolean);
  if (names.length > 256 || new Set(names).size !== names.length) { error.value = t("testing.columnInvalid"); return; }
  if (dataset.value.rows.some(row => Object.keys(row).some(name => !names.includes(name)))) { error.value = t("testing.columnInUse"); return; }
  dataset.value.columns = names; error.value = "";
}
function cell(index: number, column: string, value: string) {
  if (props.testing.readOnly || !dataset.value) return;
  const row = dataset.value.rows[page.value * 100 + index]!;
  try { if (!value.trim()) delete row[column]; else row[column] = JSON.parse(value) as JsonValue; error.value = ""; }
  catch { error.value = t("testing.cellInvalid"); }
}
function addRow() { if (!props.testing.readOnly && dataset.value && dataset.value.rows.length < 10000) { dataset.value.rows.push({}); page.value = pages.value - 1; } }
function removeRow(index: number) { if (!props.testing.readOnly) dataset.value?.rows.splice(page.value * 100 + index, 1); }
async function readFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]; if (!file || props.testing.readOnly) return;
  if (file.size > 10 * 1024 * 1024) throw new Error(t("testing.sourceLimit"));
  const id = dataset.value?.id; const context = props.testing.view?.context;
  const bytes = await file.arrayBuffer();
  if (id !== dataset.value?.id || context !== props.testing.view?.context) return;
  content.value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  format.value = file.name.toLowerCase().endsWith(".csv") ? "csv" : "json";
}
async function exportData() {
  const exportedFormat = format.value;
  const result = await props.testing.exportDataset(exportedFormat);
  if (result === null) return;
  exported.value = { format: exportedFormat, text: result };
}
function download() {
  if (!exported.value || !dataset.value) return;
  const url = URL.createObjectURL(new Blob([exported.value.text], { type: exported.value.format === "json" ? "application/json" : "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${dataset.value.name || 'dataset'}.${exported.value.format}`; anchor.click(); URL.revokeObjectURL(url);
}
</script>
<template>
  <section class="dataset-panel" data-testid="dataset-panel">
    <header class="toolbar">
      <strong>{{ t('testing.datasets') }}</strong><span v-if="testing.dirty">{{ t('testing.unsaved') }}</span>
      <button data-testid="dataset-save" :disabled="testing.readOnly || !dataset || testing.busy || !!error" @click="attempt(() => testing.save())">{{ t('testing.save') }}</button>
      <button :disabled="testing.readOnly || !dataset || testing.creating || testing.busy" @click="attempt(() => testing.remove())">{{ t('testing.remove') }}</button>
    </header>
    <p v-if="error || testing.error" class="error" role="alert">{{ error || testing.error }}</p>
    <p v-if="!dataset">{{ t('testing.pickDataset') }}</p>
    <div v-else class="editor-scroll">
      <label>{{ t('testing.name') }}<input :value="dataset.name" :disabled="testing.readOnly" data-testid="dataset-name" @input="field('name', ($event.target as HTMLInputElement).value)" /></label>
      <label>{{ t('testing.description') }}<input :value="dataset.description" :disabled="testing.readOnly" @input="field('description', ($event.target as HTMLInputElement).value)" /></label>
      <details><summary>{{ t('testing.columns') }}</summary><textarea v-model="columns" :disabled="testing.readOnly" rows="3" /><button :disabled="testing.readOnly" @click="applyColumns">{{ t('testing.applyColumns') }}</button></details>
      <p class="hint">{{ t('testing.typedCellHint') }}</p>
      <div class="table-scroll"><table><thead><tr><th>#</th><th v-for="column in dataset.columns" :key="column">{{ column }}</th><th /></tr></thead><tbody>
        <tr v-for="(row,index) in rows" :key="page * 100 + index" data-testid="dataset-row"><th>{{ page * 100 + index + 1 }}</th><td v-for="column in dataset.columns" :key="column"><input :value="column in row ? JSON.stringify(row[column]) : ''" :placeholder="t('testing.missing')" :disabled="testing.readOnly" @change="cell(index,column,($event.target as HTMLInputElement).value)" /></td><td><button :disabled="testing.readOnly" @click="removeRow(index)">×</button></td></tr>
      </tbody></table></div>
      <div class="pagination"><button :disabled="page === 0" @click="page--">‹</button><span>{{ page + 1 }} / {{ pages }} · {{ dataset.rows.length }} {{ t('testing.rows') }}</span><button data-testid="dataset-page-next" :disabled="page + 1 >= pages" @click="page++">›</button><button :disabled="testing.readOnly || dataset.rows.length >= 10000" @click="addRow">{{ t('testing.addRow') }}</button></div>
      <p v-if="!dataset.rows.length" class="hint">{{ t('testing.emptyDraft') }}</p>
      <details open class="exchange"><summary>{{ t('testing.importExport') }}</summary>
        <select v-model="format"><option>json</option><option>csv</option></select>
        <input type="file" accept=".csv,.json" :disabled="testing.readOnly" @change="event => attempt(() => readFile(event))" />
        <textarea v-model="content" :disabled="testing.readOnly" rows="4" data-testid="dataset-import-content" :aria-label="t('testing.importContent')" />
        <button data-testid="dataset-import-preview" :disabled="testing.readOnly" @click="attempt(() => testing.previewImport(format, content))">{{ t('testing.importPreview') }}</button>
        <template v-if="testing.importPreview"><p>{{ t('testing.importRows', { count: testing.importPreview.rows.length }) }}</p><pre>{{ JSON.stringify(testing.importPreview.rows.slice(0,100), null, 2) }}</pre><button data-testid="dataset-import-apply" :disabled="testing.readOnly" @click="testing.applyImport()">{{ t('testing.applyImport') }}</button></template>
        <button :disabled="testing.dirty" @click="attempt(exportData)">{{ t('testing.exportPreview') }}</button>
        <p class="hint">{{ t('testing.csvHint') }}</p>
        <template v-if="exported"><textarea :value="exported.text" readonly rows="4" /><button @click="download">{{ t('testing.download') }}</button></template>
      </details>
    </div>
  </section>
</template>
<style scoped>
.dataset-panel{height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;padding:10px;box-sizing:border-box;gap:8px}.toolbar,.pagination{display:flex;align-items:center;gap:8px;flex:none}.toolbar strong{flex:1}.editor-scroll{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:10px}.table-scroll{overflow:auto;max-height:45vh;flex:none}table{border-collapse:collapse;min-width:100%}th,td{padding:4px;border:1px solid var(--border);text-align:left}td input{min-width:140px}label{display:flex;gap:8px;align-items:center}label input{flex:1}input,textarea,select{background:var(--bg);color:var(--text);border:1px solid var(--border);padding:5px;box-sizing:border-box}textarea{width:100%}.hint{color:var(--text-muted);font-size:12px;margin:0}.error{color:var(--fail,#cf1322);margin:0}.exchange pre{max-height:200px;overflow:auto;white-space:pre-wrap}button{cursor:pointer}button:disabled{cursor:default;opacity:.5}
</style>

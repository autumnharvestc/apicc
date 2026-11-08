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
      <strong>{{ t('testing.datasets') }}</strong><span v-if="testing.dirty" class="dirty-badge">{{ t('testing.unsaved') }}</span>
      <button class="primary" data-testid="dataset-save" :disabled="testing.readOnly || !dataset || testing.busy || !!error" @click="attempt(() => testing.save())">{{ t('testing.save') }}</button>
      <button :disabled="testing.readOnly || !dataset || testing.creating || testing.busy" @click="attempt(() => testing.remove())">{{ t('testing.remove') }}</button>
    </header>
    <p v-if="error || testing.error" class="error" role="alert">{{ error || testing.error }}</p>
    <p v-if="!dataset" class="empty-state">{{ t('testing.pickDataset') }}</p>
    <div v-else class="editor-scroll">
      <div class="form-card"><h3>{{ t('testingUi.basic') }}</h3><label>{{ t('testing.name') }}<input :value="dataset.name" :disabled="testing.readOnly" data-testid="dataset-name" @input="field('name', ($event.target as HTMLInputElement).value)" /></label>
      <label>{{ t('testing.description') }}<input :value="dataset.description" :disabled="testing.readOnly" @input="field('description', ($event.target as HTMLInputElement).value)" /></label>
      </div><div class="form-card"><h3>{{ t('testingUi.dataTable') }}</h3><details><summary>{{ t('testing.columns') }}</summary><textarea :aria-label="t('testing.columns')" v-model="columns" :disabled="testing.readOnly" rows="3" /><button :disabled="testing.readOnly" @click="applyColumns">{{ t('testing.applyColumns') }}</button></details>
      <p class="hint">{{ t('testing.typedCellHint') }}</p>
      <div class="table-scroll"><table><thead><tr><th>#</th><th v-for="column in dataset.columns" :key="column">{{ column }}</th><th>{{ t('testingUi.actions') }}</th></tr></thead><tbody>
        <tr v-for="(row,index) in rows" :key="page * 100 + index" data-testid="dataset-row"><th>{{ page * 100 + index + 1 }}</th><td v-for="column in dataset.columns" :key="column"><input :aria-label="t('testingUi.cell', {row:page * 100 + index + 1, column})" :value="Object.hasOwn(row, column) ? JSON.stringify(row[column]) : ''" :placeholder="t('testing.missing')" :disabled="testing.readOnly" @change="cell(index,column,($event.target as HTMLInputElement).value)" /></td><td><button class="icon-button" :aria-label="t('testingUi.deleteRow', {row:page * 100 + index + 1})" :title="t('testingUi.deleteRow', {row:page * 100 + index + 1})" :disabled="testing.readOnly" @click="removeRow(index)">×</button></td></tr>
      </tbody></table></div>
      <div class="pagination"><button :aria-label="t('testingUi.previousPage')" :title="t('testingUi.previousPage')" :disabled="page === 0" @click="page--">‹</button><span>{{ page + 1 }} / {{ pages }} · {{ dataset.rows.length }} {{ t('testing.rows') }}</span><button :aria-label="t('testingUi.nextPage')" :title="t('testingUi.nextPage')" data-testid="dataset-page-next" :disabled="page + 1 >= pages" @click="page++">›</button><button :disabled="testing.readOnly || dataset.rows.length >= 10000" @click="addRow">{{ t('testing.addRow') }}</button></div>
      <p v-if="!dataset.rows.length" class="hint">{{ t('testing.emptyDraft') }}</p>
      </div><details open class="exchange form-card"><summary>{{ t('testing.importExport') }}</summary>
        <div class="exchange-controls"><label>{{ t('testingUi.format') }}<select v-model="format"><option>json</option><option>csv</option></select></label>
        <input :aria-label="t('testingUi.sourceFile')" type="file" accept=".csv,.json" :disabled="testing.readOnly" @change="event => attempt(() => readFile(event))" /></div>
        <textarea v-model="content" :disabled="testing.readOnly" rows="4" data-testid="dataset-import-content" :aria-label="t('testing.importContent')" />
        <button data-testid="dataset-import-preview" :disabled="testing.readOnly" @click="attempt(() => testing.previewImport(format, content))">{{ t('testing.importPreview') }}</button>
        <template v-if="testing.importPreview"><p>{{ t('testing.importRows', { count: testing.importPreview.rows.length }) }}</p><div class="table-scroll import-table"><table data-testid="dataset-import-table"><thead><tr><th>#</th><th v-for="column in testing.importPreview.columns" :key="column">{{ column }}</th></tr></thead><tbody><tr v-for="(row,index) in testing.importPreview.rows.slice(0,100)" :key="index"><th>{{ index + 1 }}</th><td v-for="column in testing.importPreview.columns" :key="column"><code v-if="Object.hasOwn(row, column)">{{ JSON.stringify(row[column]) }}</code><span v-else class="hint">{{ t('testing.missing') }}</span></td></tr></tbody></table></div><button data-testid="dataset-import-apply" :disabled="testing.readOnly" @click="testing.applyImport()">{{ t('testing.applyImport') }}</button></template>
        <button :disabled="testing.dirty" @click="attempt(exportData)">{{ t('testing.exportPreview') }}</button>
        <p class="hint">{{ t('testing.csvHint') }}</p>
        <template v-if="exported"><textarea :aria-label="t('testingUi.exportContent')" :value="exported.text" readonly rows="4" /><button @click="download">{{ t('testing.download') }}</button></template>
      </details>
    </div>
  </section>
</template>
<style scoped>

.toolbar{display:flex;align-items:center;gap:10px;flex:none;flex-wrap:wrap;padding-bottom:12px;border-bottom:1px solid var(--border)}.toolbar strong{flex:1;font-size:17px;min-width:90px}.dirty-badge{color:var(--text-muted);background:var(--subtle);border:1px solid var(--border);border-radius:20px;padding:3px 9px;font-size:12px}
.editor-scroll{flex:1;min-height:100px;overflow:auto;display:flex;flex-direction:column;gap:14px;padding:2px}.form-card{flex:none;min-width:0;padding:16px;background:var(--bg);border:1px solid var(--border);border-radius:10px;box-shadow:var(--panel-shadow)}h3{font-size:14px;margin:0 0 14px;color:var(--text)}.form-card>label{margin:10px 0}label{display:flex;gap:10px;align-items:center;font-size:13px;min-width:0}label input:not([type=checkbox]){flex:1;min-width:0}input,textarea,select{background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:var(--control-radius);padding:7px 9px;box-sizing:border-box;font:inherit;max-width:100%}textarea{width:100%;font-family:ui-monospace,monospace;resize:vertical}select[multiple]{min-width:180px}input[type=checkbox]{accent-color:var(--accent);flex:none}button{color:var(--text);background:var(--bg);border:1px solid var(--border);border-radius:var(--control-radius);padding:7px 12px;min-height:32px;cursor:pointer;font:inherit;white-space:nowrap}button:hover:not(:disabled){border-color:var(--accent);background:var(--active-weak)}button.primary{color:var(--accent);background:var(--active-weak);border-color:var(--accent);font-weight:600}button:disabled,input:disabled,select:disabled,textarea:disabled{opacity:.55;cursor:default}summary{cursor:pointer;font-weight:600;padding:8px 0;overflow-wrap:anywhere}details[open]>summary{margin-bottom:10px}.hint{color:var(--text-muted);font-size:12px;line-height:1.6;margin:8px 0}.error{color:var(--fail);overflow-wrap:anywhere;margin:0}.empty-state{color:var(--text-muted);text-align:center;padding:40px 12px}.table-scroll{overflow:auto;max-width:100%;max-height:45vh;flex:none;border:1px solid var(--border);border-radius:8px;margin:10px 0}table{border-collapse:separate;border-spacing:0;min-width:100%;font-size:12px}th,td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--border);vertical-align:top}thead th{position:sticky;top:0;background:var(--subtle);z-index:1;white-space:nowrap;color:var(--text-muted);font-weight:600}tbody tr:last-child>*{border-bottom:0}tbody tr:hover{background:var(--hover)}tbody th{font-weight:500}td{overflow-wrap:anywhere}p{line-height:1.6}
.dataset-panel{height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;padding:16px;box-sizing:border-box;gap:12px;background:var(--panel);color:var(--text)}.pagination,.exchange-controls{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.pagination{font-size:12px;color:var(--text-muted)}.exchange-controls{margin:8px 0 12px}.exchange-controls input{min-width:0;flex:1}.exchange>button{margin:8px 8px 0 0}.icon-button{padding:4px 10px;font-size:18px}td input{min-width:160px;width:100%}.import-table code{display:block;min-width:110px;max-width:360px;max-height:160px;overflow:auto;white-space:pre;font:12px/1.6 ui-monospace,monospace}.exchange>p{font-size:12px}@media(max-width:650px){.dataset-panel{padding:10px}.form-card{padding:12px}.form-card>label{align-items:stretch;flex-direction:column}.exchange-controls{align-items:stretch;flex-direction:column}}
</style>

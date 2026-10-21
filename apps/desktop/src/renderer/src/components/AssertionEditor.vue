<script setup lang="ts">
import { computed, reactive } from "vue";
import { useI18n } from "vue-i18n";
import { Input as AInput, Select as ASelect, Button as AButton } from "ant-design-vue";
import { builtinAssertDescriptors } from "@apicc/core/schema";
import { compileRegex } from "@apicc/core/assert/regex";
import type { Assertion } from "@apicc/core";
import type { AssertionOperatorDTO } from "../../../shared/testing.js";
const props = defineProps<{ assertions: Assertion[]; readOnly?: boolean; operators?: AssertionOperatorDTO[] }>();
const emit = defineEmits<{ validity: [message: string] }>();
const { t } = useI18n();
const errors = reactive<Record<string, string>>({});
const parseErrors = reactive<Record<string, string>>({});
const operators = computed(() => props.operators ?? Object.entries(builtinAssertDescriptors).map(([op, descriptor]) => ({ op, descriptor })));
const targets = ["status", "responseTime", "header", "bodyText", "bodyJson", "bodyXml", "cookie"];
const descriptor = (row: Assertion) => operators.value.find((item) => item.op === row.op)?.descriptor;
const known = (row: Assertion) => operators.value.some((item) => item.op === row.op);
function validate() {
  for (const row of props.assertions) {
    try {
      const format = descriptor(row)?.expectedFormat;
      const expected = row.expected ?? "";
      if (!expected.includes("{{")) {
        if (format === "json" || format === "jsonArray") {
          const value: unknown = JSON.parse(expected);
          if (format === "jsonArray" && !Array.isArray(value)) throw new Error(t("testing.arrayRequired"));
        }
        if (format === "integer" && (!/^(0|[1-9]\d*)$/.test(expected) || !Number.isSafeInteger(Number(expected)))) throw new Error(t("testing.integerRequired"));
        if (row.op === "regex") compileRegex(expected, typeof row.options?.flags === "string" ? row.options.flags : undefined);
      }
      if (row.op === "schema" && (!!row.options?.schema === !!row.options?.useContractResponse)) throw new Error(t("testing.schemaChoice"));
      delete errors[row.id];
    } catch (error) { errors[row.id] = error instanceof Error ? error.message : String(error); }
  }
  emit("validity", [...Object.values(parseErrors), ...Object.values(errors)].join("; "));
}
function set(row: Assertion, field: keyof Assertion, value: unknown) {
  if (props.readOnly) return;
  Object.assign(row, { [field]: value });
  validate();
}
function target(row: Assertion, value: Assertion["target"]) {
  if (props.readOnly) return;
  row.target = value;
  if (value !== "header") delete row.headerName; else row.headerName ??= "";
  if (value !== "cookie") delete row.cookieName; else row.cookieName ??= "";
  if (!["bodyJson", "bodyXml"].includes(value)) delete row.path; else row.path ??= value === "bodyJson" ? "$" : "/";
  if (value !== "bodyXml") { delete row.namespaces; delete parseErrors[`${row.id}:namespaces`]; }
  validate();
}
function json(row: Assertion, field: "options" | "namespaces", value: string) {
  if (props.readOnly) return;
  try {
    if (!value.trim()) delete row[field];
    else {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || (field === "namespaces" && Object.values(parsed).some((item) => typeof item !== "string"))) throw new Error(t("testing.objectRequired"));
      Object.assign(row, { [field]: parsed });
    }
    delete parseErrors[`${row.id}:${field}`]; validate();
  } catch (error) { parseErrors[`${row.id}:${field}`] = error instanceof Error ? error.message : String(error); validate(); }
}
function remove(index: number) {
  if (props.readOnly) return;
  const id = props.assertions[index]!.id;
  delete errors[id]; delete parseErrors[`${id}:options`]; delete parseErrors[`${id}:namespaces`]; props.assertions.splice(index, 1); validate();
}
</script>
<template>
  <div class="assertion-editor" data-testid="assert-table">
    <div v-for="(row, index) in assertions" :key="row.id" class="assertion-row">
      <div class="fields">
        <label>{{ t('case.target') }}<a-select :value="row.target" :disabled="readOnly" :options="[...new Set([...(descriptor(row)?.targets ?? targets),row.target])].map(value => ({ label: value, value }))" data-testid="assert-target" @update:value="value => target(row, value as Assertion['target'])" /></label>
        <label>{{ t('case.op') }}<a-select :value="row.op" :disabled="readOnly" :options="[...operators, ...(!known(row) ? [{ op: row.op }] : [])].map(item => ({ label: item.op, value: item.op }))" data-testid="assert-op" @update:value="value => set(row, 'op', value)" /></label>
        <label v-if="descriptor(row)?.expectedFormat !== 'none'">{{ t('case.expected') }}<a-input :value="row.expected" :disabled="readOnly" :placeholder="descriptor(row)?.expectedFormat ?? 'text'" data-testid="assert-expected" @update:value="value => set(row, 'expected', value)" /></label>
        <label v-if="row.target === 'header'">{{ t('case.headerName') }}<a-input :value="row.headerName" :disabled="readOnly" data-testid="assert-header-name" @update:value="value => set(row, 'headerName', value)" /></label>
        <label v-if="row.target === 'cookie'">{{ t('testing.cookieName') }}<a-input :value="row.cookieName" :disabled="readOnly" @update:value="value => set(row, 'cookieName', value)" /></label>
        <label v-if="['bodyJson','bodyXml'].includes(row.target)">{{ t('case.path') }}<a-input :value="row.path" :disabled="readOnly" data-testid="assert-path" @update:value="value => set(row, 'path', value)" /></label>
        <label>{{ t('testing.match') }}<select :value="row.match ?? 'first'" :disabled="readOnly" @change="set(row, 'match', ($event.target as HTMLSelectElement).value)"><option>first</option><option>all</option></select></label>
        <a-button size="small" danger type="text" data-testid="assert-delete" :disabled="readOnly" @click="remove(index)">×</a-button>
      </div>
      <p v-if="!known(row)" role="alert" data-testid="assertion-unknown">{{ t('testing.unknownOperator', { op: row.op }) }}</p>
      <p v-else-if="!descriptor(row)">{{ t('testing.manualOperator') }}</p>
      <p v-if="descriptor(row)?.targets && !descriptor(row)!.targets!.includes(row.target)" role="alert">{{ t('testing.targetUnsupported') }}</p>
      <p v-if="row.op === 'regex'" class="hint">{{ t('testing.regexHint') }}</p>
      <label>{{ t('testing.options') }}<a-input :value="row.options ? JSON.stringify(row.options) : ''" :disabled="readOnly" data-testid="assert-options" @update:value="value => json(row, 'options', value ?? '')" /></label>
      <label v-if="row.target === 'bodyXml'">{{ t('testing.namespaces') }}<a-input :value="JSON.stringify(row.namespaces ?? {})" :disabled="readOnly" @update:value="value => json(row, 'namespaces', value ?? '')" /></label>
      <p v-if="errors[row.id]" role="alert">{{ errors[row.id] }}</p>
      <p v-if="parseErrors[`${row.id}:options`] || parseErrors[`${row.id}:namespaces`]" role="alert">{{ parseErrors[`${row.id}:options`] || parseErrors[`${row.id}:namespaces`] }}</p>
    </div>
  </div>
</template>
<style scoped>
.assertion-editor{display:flex;flex-direction:column;gap:8px;min-width:0}.assertion-row{padding:8px;border:1px solid var(--border);border-radius:6px}.fields{display:flex;flex-wrap:wrap;gap:8px;align-items:end}label{display:flex;flex-direction:column;gap:4px;min-width:100px;flex:1}label :deep(.ant-select){min-width:120px}p{margin:5px 0;font-size:12px}p[role=alert]{color:var(--fail,#cf1322)}.hint{color:var(--text-muted)}
</style>

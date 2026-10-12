<script setup lang="ts">
import { computed, ref, toRaw } from "vue";
import { useI18n } from "vue-i18n";
import type { ModelAsset } from "@apicc/core";
import type { JsonValue, SchemaAnnotations, SchemaNode } from "@apicc/core/schema";

const props = withDefaults(defineProps<{
  modelValue?: SchemaNode;
  models?: ModelAsset[];
  readOnly?: boolean;
}>(), { models: () => [], readOnly: false });
const emit = defineEmits<{ "update:modelValue": [value: SchemaNode | undefined] }>();
const { t } = useI18n();
const propertyName = ref("");
type AnnotationField = "default" | "examples" | "enum";
const annotationDrafts = ref<Partial<Record<AnnotationField, string>>>({});
const annotationErrors = ref<Partial<Record<AnnotationField, string>>>({});
const node = computed(() => props.modelValue);
const modelRefNode = computed(() => node.value?.kind === "modelRef" ? node.value : null);
const modelRefExists = computed(() => {
  const modelRef = modelRefNode.value;
  return modelRef !== null && props.models.some((model) => model.id === modelRef.modelId);
});
const kinds = ["scalar", "object", "array", "allOf", "oneOf", "anyOf", "modelRef"] as const;
const scalarTypes = ["string", "number", "integer", "boolean", "null"] as const;

function replace(mutator: (copy: SchemaNode) => void) {
  if (!node.value) return;
  const copy = structuredClone(toRaw(node.value));
  mutator(copy);
  emit("update:modelValue", copy);
}

function createKind(kind: (typeof kinds)[number]): SchemaNode {
  const annotations: SchemaAnnotations = node.value ? {
    ...(node.value.description === undefined ? {} : { description: node.value.description }),
    ...(node.value.default === undefined ? {} : { default: node.value.default }),
    ...(node.value.examples === undefined ? {} : { examples: node.value.examples }),
    ...(node.value.enum === undefined ? {} : { enum: node.value.enum }),
  } : {};
  if (kind === "scalar") return { ...annotations, kind, type: "string" };
  if (kind === "object") return { ...annotations, kind, properties: {}, required: [], additionalProperties: false };
  if (kind === "array") return { ...annotations, kind, items: { kind: "scalar", type: "string" } };
  if (kind === "modelRef") return { ...annotations, kind, modelId: props.models[0]?.id ?? "" };
  return { ...annotations, kind, variants: [{ kind: "scalar", type: "string" }] };
}

function setKind(kind: string) {
  if (!kinds.includes(kind as (typeof kinds)[number])) return;
  emit("update:modelValue", createKind(kind as (typeof kinds)[number]));
}

function setProperty(name: string, value: SchemaNode) {
  replace((copy) => { if (copy.kind === "object") copy.properties[name] = value; });
}

function addProperty() {
  const name = propertyName.value.trim();
  if (!name || !node.value || node.value.kind !== "object" || Object.hasOwn(node.value.properties, name)) return;
  replace((copy) => {
    if (copy.kind !== "object") return;
    Object.defineProperty(copy.properties, name, {
      value: { kind: "scalar", type: "string" },
      enumerable: true,
      configurable: true,
      writable: true,
    });
    propertyName.value = "";
  });
}

function removeProperty(name: string) {
  replace((copy) => {
    if (copy.kind !== "object") return;
    delete copy.properties[name];
    copy.required = copy.required.filter((item) => item !== name);
  });
}

function setRequired(name: string, required: boolean) {
  replace((copy) => {
    if (copy.kind !== "object") return;
    copy.required = required ? [...new Set([...copy.required, name])] : copy.required.filter((item) => item !== name);
  });
}

function additionalMode(): "false" | "true" | "schema" {
  if (node.value?.kind !== "object") return "false";
  const value = node.value.additionalProperties;
  return typeof value === "boolean" ? String(value) as "false" | "true" : "schema";
}

function setAdditionalMode(mode: string) {
  if (mode !== "false" && mode !== "true" && mode !== "schema") return;
  replace((copy) => {
    if (copy.kind !== "object") return;
    if (mode === "schema") {
      if (typeof copy.additionalProperties === "boolean") copy.additionalProperties = { kind: "scalar", type: "string" };
    } else {
      copy.additionalProperties = mode === "true";
    }
  });
}

function setVariant(index: number, value: SchemaNode) {
  replace((copy) => { if (copy.kind === "allOf" || copy.kind === "oneOf" || copy.kind === "anyOf") copy.variants[index] = value; });
}

function addVariant() {
  replace((copy) => { if (copy.kind === "allOf" || copy.kind === "oneOf" || copy.kind === "anyOf") copy.variants.push({ kind: "scalar", type: "string" }); });
}

function removeVariant(index: number) {
  replace((copy) => { if (copy.kind === "allOf" || copy.kind === "oneOf" || copy.kind === "anyOf") copy.variants.splice(index, 1); });
}

function setAnnotation<K extends keyof SchemaAnnotations>(key: K, value: SchemaAnnotations[K]) {
  replace((copy) => {
    if (value === undefined || (key === "description" && value === "")) Reflect.deleteProperty(copy, key);
    else Object.assign(copy, { [key]: value });
  });
}

function annotationText(value: JsonValue | JsonValue[] | undefined): string {
  return value === undefined ? "" : JSON.stringify(value, null, 2);
}

function annotationEditorText(key: AnnotationField, value: JsonValue | JsonValue[] | undefined): string {
  return annotationDrafts.value[key] ?? annotationText(value);
}

function annotationError(key: AnnotationField): string | undefined {
  return annotationErrors.value[key];
}

function updateAnnotationDraft(key: AnnotationField, value: string) {
  annotationDrafts.value = { ...annotationDrafts.value, [key]: value };
}

function clearAnnotationDraft(key: AnnotationField) {
  const drafts = { ...annotationDrafts.value };
  const errors = { ...annotationErrors.value };
  delete drafts[key];
  delete errors[key];
  annotationDrafts.value = drafts;
  annotationErrors.value = errors;
}

function parseAnnotation(key: AnnotationField, value: string) {
  if (!value.trim()) {
    clearAnnotationDraft(key);
    setAnnotation(key, undefined);
    return;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (key === "default") setAnnotation("default", parsed as JsonValue);
    else if (Array.isArray(parsed)) setAnnotation(key, parsed as JsonValue[]);
    else {
      annotationErrors.value = { ...annotationErrors.value, [key]: "此项必须是 JSON 数组" };
      return;
    }
    clearAnnotationDraft(key);
  } catch {
    annotationErrors.value = { ...annotationErrors.value, [key]: "JSON 格式无效" };
  }
}
</script>

<template>
  <fieldset class="schema-editor" data-testid="schema-editor" :disabled="readOnly">
    <legend>{{ t('contract.schema') }}</legend>
    <button v-if="!node" type="button" data-testid="schema-add" @click="setKind('object')">{{ t('contract.schemaAdd') }}</button>
    <template v-else>
      <div class="row">
        <label>{{ t('contract.schemaKind') }}</label>
        <select data-testid="schema-kind" :value="node.kind" @change="setKind(($event.target as HTMLSelectElement).value)">
          <option v-for="kind in kinds" :key="kind" :value="kind">{{ t(`contract.schemaKindValue.${kind}`) }}</option>
        </select>
      </div>
      <div v-if="node.kind === 'scalar'" class="row">
        <label>{{ t('contract.schemaType') }}</label>
        <select data-testid="schema-scalar-type" :value="node.type" @change="replace((copy) => { if (copy.kind === 'scalar') copy.type = ($event.target as HTMLSelectElement).value as typeof copy.type; })">
          <option v-for="type in scalarTypes" :key="type" :value="type">{{ type }}</option>
        </select>
      </div>
      <div v-else-if="modelRefNode" class="row">
        <label>{{ t('contract.modelRef') }}</label>
        <select :value="modelRefNode.modelId" data-testid="schema-model-ref" @change="replace((copy) => { if (copy.kind === 'modelRef') copy.modelId = ($event.target as HTMLSelectElement).value; })">
          <option v-for="model in models" :key="model.id" :value="model.id">{{ model.name }}</option>
        </select>
        <span v-if="!modelRefExists">{{ t('contract.missingModel') }}</span>
      </div>
      <div v-else-if="node.kind === 'object'" class="nested">
        <div v-for="(child, name) in node.properties" :key="name" class="property">
          <div class="row">
            <strong>{{ name }}</strong>
            <label><input type="checkbox" :checked="node.required.includes(name)" data-testid="schema-required" @change="setRequired(name, ($event.target as HTMLInputElement).checked)" />{{ t('contract.required') }}</label>
            <button type="button" data-testid="schema-property-remove" @click="removeProperty(name)">×</button>
          </div>
          <SchemaEditor :model-value="child" :models="models" :read-only="readOnly" @update:model-value="setProperty(name, $event as SchemaNode)" />
        </div>
        <div class="row">
          <input v-model="propertyName" data-testid="schema-property-name" :placeholder="t('contract.propertyName')" />
          <button type="button" data-testid="schema-property-add" @click="addProperty">{{ t('contract.schemaAddProperty') }}</button>
        </div>
        <label class="row"><span>{{ t('contract.additionalProperties') }}</span><select data-testid="schema-additional-mode" :value="additionalMode()" @change="setAdditionalMode(($event.target as HTMLSelectElement).value)">
          <option value="false">false</option>
          <option value="true">true</option>
          <option value="schema">schema</option>
        </select></label>
        <div v-if="typeof node.additionalProperties === 'object'" data-testid="schema-additional-schema">
          <SchemaEditor :model-value="node.additionalProperties" :models="models" :read-only="readOnly" @update:model-value="replace((copy) => { if (copy.kind === 'object' && $event) copy.additionalProperties = $event; })" />
        </div>
      </div>
      <div v-else-if="node.kind === 'array'" class="nested">
        <label>{{ t('contract.arrayItems') }}</label>
        <SchemaEditor :model-value="node.items" :models="models" :read-only="readOnly" @update:model-value="replace((copy) => { if (copy.kind === 'array' && $event) copy.items = $event; })" />
      </div>
      <div v-else-if="node.kind === 'allOf' || node.kind === 'oneOf' || node.kind === 'anyOf'" class="nested">
        <div v-for="(variant, index) in node.variants" :key="index" class="property">
          <div class="row"><strong>{{ t('contract.schemaVariant', { index: index + 1 }) }}</strong><button type="button" @click="removeVariant(index)">×</button></div>
          <SchemaEditor :model-value="variant" :models="models" :read-only="readOnly" @update:model-value="setVariant(index, $event as SchemaNode)" />
        </div>
        <button type="button" data-testid="schema-variant-add" @click="addVariant">{{ t('contract.schemaAddVariant') }}</button>
      </div>
      <label class="row"><span>{{ t('contract.description') }}</span><input :value="node.description ?? ''" data-testid="schema-description" @input="setAnnotation('description', ($event.target as HTMLInputElement).value)" /></label>
      <label class="row"><span>{{ t('contract.schemaDefault') }}</span><textarea :value="annotationEditorText('default', node.default)" data-testid="schema-default" :aria-invalid="annotationError('default') ? 'true' : undefined" @input="updateAnnotationDraft('default', ($event.target as HTMLTextAreaElement).value)" @change="parseAnnotation('default', ($event.target as HTMLTextAreaElement).value)" /><span v-if="annotationError('default')" role="alert" data-testid="schema-annotation-error-default">{{ annotationError('default') }}</span></label>
      <label class="row"><span>{{ t('contract.schemaExamples') }}</span><textarea :value="annotationEditorText('examples', node.examples)" data-testid="schema-examples" :aria-invalid="annotationError('examples') ? 'true' : undefined" @input="updateAnnotationDraft('examples', ($event.target as HTMLTextAreaElement).value)" @change="parseAnnotation('examples', ($event.target as HTMLTextAreaElement).value)" /><span v-if="annotationError('examples')" role="alert" data-testid="schema-annotation-error-examples">{{ annotationError('examples') }}</span></label>
      <label class="row"><span>{{ t('contract.schemaEnum') }}</span><textarea :value="annotationEditorText('enum', node.enum)" data-testid="schema-enum" :aria-invalid="annotationError('enum') ? 'true' : undefined" @input="updateAnnotationDraft('enum', ($event.target as HTMLTextAreaElement).value)" @change="parseAnnotation('enum', ($event.target as HTMLTextAreaElement).value)" /><span v-if="annotationError('enum')" role="alert" data-testid="schema-annotation-error-enum">{{ annotationError('enum') }}</span></label>
    </template>
  </fieldset>
</template>

<style scoped>
.schema-editor { border: 1px solid var(--border, #d9d9d9); min-width: 0; padding: 8px; display: grid; gap: 6px; }
.nested { display: grid; gap: 6px; margin-left: 12px; }
.property { border-left: 2px solid var(--border, #d9d9d9); padding-left: 8px; }
.row { display: flex; align-items: center; gap: 8px; }
.row > label, .row > input, .row > textarea, .row > select { flex: 1; }
textarea { min-height: 42px; font-family: ui-monospace, monospace; }
</style>

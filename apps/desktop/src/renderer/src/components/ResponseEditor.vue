<script setup lang="ts">
import { ref, toRaw, watch } from "vue";
import { useI18n } from "vue-i18n";
import type { ComponentAsset, ExampleBinding, JsonValue, ModelAsset, ResponseBinding, ResponseContent, ResponseDefinition } from "@apicc/core";
import type { SchemaNode } from "@apicc/core/schema";
import SchemaEditor from "./SchemaEditor.vue";

const props = defineProps<{
  responses: ResponseBinding[];
  assets: { components: ComponentAsset[]; models: ModelAsset[] };
  readOnly?: boolean;
  contextKey?: string;
  /** Optional identity-scoped JSON value drafts used by the formal Design view. */
  draftScope?: string;
  drafts?: Record<string, { value: string; error: string }>;
}>();
const emit = defineEmits<{
  "update:controlDraft": [path: string, value: string, error: string | null];
  "clear:control-drafts": [prefix: string];
  "move:control-drafts": [fromPrefix: string, toPrefix: string];
}>();
const { t } = useI18n();
const newMediaType = ref("application/json");
const headerError = ref("");
const headerNameDrafts = ref(new Map<string, string>());
const exampleDrafts = ref(new Map<string, string>());
const exampleErrors = ref(new Map<string, string>());
function forwardControlDraft(path: string, value: string, error: string | null) {
  emit("update:controlDraft", path, value, error);
}

function clearControlDrafts(prefix: string) {
  if (props.draftScope && prefix) emit("clear:control-drafts", prefix);
}

function forwardMoveControlDrafts(fromPrefix: string, toPrefix: string) {
  emit("move:control-drafts", fromPrefix, toPrefix);
}

// Track binding/session boundaries, without observing header edits that must retain focus.
watch(() => [props.contextKey, props.readOnly, props.responses.map((response) => [
  response, response.kind, response.kind === "componentRef" ? response.componentId : null,
])], () => {
  headerNameDrafts.value.clear();
  exampleDrafts.value.clear();
  exampleErrors.value.clear();
  headerError.value = "";
}, { flush: "sync" });

function responseDraftPrefix(response: ResponseBinding): string {
  return `${props.draftScope}.response.${response.id}`;
}

function ownerSegment(value: string): string {
  return encodeURIComponent(value).replace(/\./g, "%2E");
}

function emptyResponse(): ResponseBinding {
  return {
    kind: "inline", id: crypto.randomUUID(), status: "200", description: "",
    headers: {}, content: { "application/json": { examples: [] } },
  };
}

function addResponse() {
  if (props.readOnly) return;
  props.responses.push(emptyResponse());
}

function removeResponse(index: number) {
  if (props.readOnly) return;
  const response = props.responses[index];
  if (response) clearControlDrafts(responseDraftPrefix(response));
  props.responses.splice(index, 1);
}

function responseComponents(): Extract<ComponentAsset, { kind: "response" }>[] {
  return props.assets.components.filter((asset): asset is Extract<ComponentAsset, { kind: "response" }> => asset.kind === "response");
}

function exampleComponents(): Extract<ComponentAsset, { kind: "example" }>[] {
  return props.assets.components.filter((asset): asset is Extract<ComponentAsset, { kind: "example" }> => asset.kind === "example");
}

function useResponseComponent(index: number, componentId: string) {
  if (props.readOnly) return;
  const current = props.responses[index];
  if (!current || !componentId) return;
  const priorId = current.id;
  if (!responseComponents().some((item) => item.id === componentId)) return;
  clearControlDrafts(responseDraftPrefix(current));
  props.responses.splice(index, 1, { kind: "componentRef", id: priorId, componentId, expectedKind: "response" });
}

function editAsInline(index: number) {
  if (props.readOnly) return;
  const current = props.responses[index];
  if (!current || current.kind !== "componentRef") return;
  clearControlDrafts(responseDraftPrefix(current));
  props.responses.splice(index, 1, { ...emptyResponse(), id: current.id });
}

function definition(response: ResponseBinding): ResponseDefinition | undefined {
  if (response.kind === "inline") return response;
  return responseComponents().find((item) => item.id === response.componentId)?.definition;
}

function addHeader(response: ResponseBinding) {
  if (props.readOnly || response.kind !== "inline") return;
  const current = response;
  let index = Object.keys(current.headers).length + 1;
  while (`X-Header-${index}` in current.headers) index += 1;
  current.headers[`X-Header-${index}`] = "";
}

function headerRowId(response: ResponseBinding, name: string): string {
  return `${response.id}:${name}`;
}

function headerDraftPath(response: ResponseBinding, name: string): string {
  return `${responseDraftPrefix(response)}.header.${ownerSegment(name)}`;
}

function displayedHeaderName(response: ResponseBinding, name: string): string {
  if (props.readOnly || response.kind !== "inline") return name;
  return props.drafts?.[headerDraftPath(response, name)]?.value
    ?? headerNameDrafts.value.get(headerRowId(response, name)) ?? name;
}

function headerDraftError(response: ResponseBinding, name: string): string | undefined {
  return props.drafts?.[headerDraftPath(response, name)]?.error || undefined;
}

function localHeaderDraftError(response: ResponseBinding, name: string): string | undefined {
  if (response.kind !== "inline") return undefined;
  const rawName = headerNameDrafts.value.get(headerRowId(response, name));
  return rawName === undefined ? undefined : headerNameError(response, name, rawName) ?? undefined;
}

function headerNameError(response: Extract<ResponseBinding, { kind: "inline" }>, previousName: string, rawName: string): string | null {
  const nextName = rawName.trim();
  if (!nextName) return t("design.headerNameInvalid");
  const duplicate = Object.keys(response.headers).some((name) =>
    name !== previousName && name.toLowerCase() === nextName.toLowerCase());
  return duplicate ? t("design.headerNameInvalid") : null;
}

function updateHeaderNameDraft(response: ResponseBinding, previousName: string, rawName: string) {
  if (props.readOnly || response.kind !== "inline") return;
  headerNameDrafts.value.set(headerRowId(response, previousName), rawName);
  const error = headerNameError(response, previousName, rawName);
  headerError.value = error ?? "";
  if (props.draftScope) emit("update:controlDraft", headerDraftPath(response, previousName), rawName, error);
}

function commitHeaderName(response: ResponseBinding, previousName: string) {
  if (props.readOnly || response.kind !== "inline") return;
  const rowId = headerRowId(response, previousName);
  const rawName = headerNameDrafts.value.get(rowId);
  if (rawName === undefined) return;
  const validationError = headerNameError(response, previousName, rawName);
  if (validationError) {
    headerError.value = validationError;
    return;
  }
  const nextName = rawName.trim();
  headerError.value = "";
  if (nextName !== previousName) {
    response.headers = Object.fromEntries(Object.entries(response.headers).map(([name, value]) =>
      name === previousName ? [nextName, value] : [name, value]));
  }
  headerNameDrafts.value.delete(rowId);
  if (props.draftScope) emit("update:controlDraft", headerDraftPath(response, previousName), "", null);
}

function removeHeader(response: ResponseBinding, name: string) {
  if (props.readOnly || response.kind !== "inline") return;
  const rowId = headerRowId(response, name);
  delete response.headers[name];
  headerNameDrafts.value.delete(rowId);
  clearControlDrafts(headerDraftPath(response, name));
}

function addMedia(response: ResponseBinding) {
  if (props.readOnly || response.kind !== "inline") return;
  const current = response;
  const media = newMediaType.value.trim();
  if (current && media && !(media in current.content)) current.content[media] = { examples: [] };
}

function removeMedia(response: ResponseBinding, media: string) {
  if (props.readOnly || response.kind !== "inline") return;
  const current = response;
  if (current) {
    clearControlDrafts(`${responseDraftPrefix(response)}.${ownerSegment(media)}`);
    delete current.content[media];
  }
}

function setSchema(response: ResponseBinding, content: ResponseContent, media: string, value: SchemaNode | undefined) {
  if (props.readOnly || response.kind !== "inline") return;
  if (value === undefined) {
    clearControlDrafts(`${responseDraftPrefix(response)}.${ownerSegment(media)}.schema`);
    delete content.schema;
  }
  else content.schema = value;
}

function addExample(response: ResponseBinding, content: ResponseContent) {
  if (props.readOnly || response.kind !== "inline") return;
  content.examples.push({ kind: "inline", id: crypto.randomUUID(), name: "", value: {} });
}

function useExampleComponent(response: ResponseBinding, content: ResponseContent, media: string, index: number, componentId: string) {
  if (props.readOnly || response.kind !== "inline") return;
  const previous = content.examples[index];
  if (!previous) return;
  const path = exampleDraftPath(response, previous, media);
  if (!componentId) {
    if (previous.kind !== "componentRef") return;
    const component = exampleComponents().find((item) => item.id === previous.componentId);
    const inlineExample: ExampleBinding = {
      kind: "inline", id: previous.id, name: component?.name ?? "",
      value: component ? structuredClone(toRaw(component.definition.value)) : {},
    };
    clearControlDrafts(path);
    content.examples.splice(index, 1, inlineExample);
    return;
  }
  const component = exampleComponents().find((item) => item.id === componentId);
  if (!component || (previous.kind === "componentRef" && previous.componentId === componentId)) return;
  clearControlDrafts(path);
  content.examples.splice(index, 1, { kind: "componentRef", id: previous.id, componentId, expectedKind: "example" });
}

function setExampleName(response: ResponseBinding, binding: ExampleBinding, name: string) {
  if (props.readOnly || response.kind !== "inline" || binding.kind !== "inline") return;
  binding.name = name;
}

function setExampleValue(response: ResponseBinding, binding: ExampleBinding, media: string, raw: string) {
  if (props.readOnly || response.kind !== "inline" || binding.kind !== "inline") return;
  try {
    binding.value = JSON.parse(raw) as JsonValue;
    exampleDrafts.value.delete(binding.id);
    exampleErrors.value.delete(binding.id);
    if (props.draftScope) emit("update:controlDraft", exampleDraftPath(response, binding, media), "", null);
  } catch {
    const error = t("design.invalidJson");
    exampleErrors.value.set(binding.id, error);
    if (props.draftScope) emit("update:controlDraft", exampleDraftPath(response, binding, media), raw, error);
  }
}

function exampleDraftPath(response: ResponseBinding, binding: ExampleBinding, media: string): string {
  return `${responseDraftPrefix(response)}.${ownerSegment(media)}.example.${binding.id}`;
}

function updateExampleDraft(response: ResponseBinding, binding: ExampleBinding, media: string, raw: string) {
  if (props.readOnly || binding.kind !== "inline") return;
  exampleDrafts.value.set(binding.id, raw);
  if (props.draftScope) {
    let error: string | null = null;
    try { JSON.parse(raw); } catch { error = t("design.invalidJson"); }
    emit("update:controlDraft", exampleDraftPath(response, binding, media), raw, error);
  }
}

function exampleError(response: ResponseBinding, binding: ExampleBinding, media: string): string | undefined {
  const external = props.draftScope ? props.drafts?.[exampleDraftPath(response, binding, media)] : undefined;
  return external ? external.error || undefined : exampleErrors.value.get(binding.id);
}

function displayExample(response: ResponseBinding, binding: ExampleBinding, media: string): string {
  if (binding.kind === "inline") {
    const external = props.draftScope ? props.drafts?.[exampleDraftPath(response, binding, media)] : undefined;
    return external?.value ?? exampleDrafts.value.get(binding.id) ?? JSON.stringify(binding.value, null, 2);
  }
  return JSON.stringify(exampleComponents().find((item) => item.id === binding.componentId)?.definition.value ?? {}, null, 2);
}

function responseLabel(response: ResponseBinding, index: number): string {
  const current = definition(response);
  return current ? `${current.status} · ${current.description}` : t("contract.missingComponent");
}

function exampleRefName(binding: ExampleBinding): string {
  return binding.kind === "componentRef"
    ? exampleComponents().find((item) => item.id === binding.componentId)?.name ?? t("contract.missingComponent")
    : binding.name;
}

function exampleAddTestId(index: number, media: string): string {
  const safeMedia = media.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `response-example-add-${index}-${safeMedia}`;
}
</script>

<template>
  <section class="responses" data-testid="response-editor">
    <header><h3>{{ t('contract.responses') }}</h3><button type="button" data-testid="response-add" :disabled="readOnly" @click="addResponse">{{ t('contract.responseAdd') }}</button></header>
    <article v-for="(response, index) in responses" :key="response.id" class="response">
      <header>
        <strong>{{ responseLabel(response, index) }}</strong>
        <select v-if="responseComponents().length" :value="response.kind === 'componentRef' ? response.componentId : ''" :data-testid="`response-component-${index}`" :disabled="readOnly" :aria-label="t('contract.responseReference')" @change="useResponseComponent(index, ($event.target as HTMLSelectElement).value)">
          <option value="">{{ t('contract.inlineResponse') }}</option>
          <option v-for="asset in responseComponents()" :key="asset.id" :value="asset.id">{{ asset.name }}</option>
        </select>
        <button v-if="response.kind === 'componentRef'" type="button" :disabled="readOnly" @click="editAsInline(index)">{{ t('contract.editInline') }}</button>
        <button type="button" data-testid="response-remove" :disabled="readOnly" @click="removeResponse(index)">×</button>
      </header>
      <template v-if="definition(response)">
        <div class="row">
          <input v-if="response.kind === 'inline'" v-model="response.status" :data-testid="`response-status-${index}`" :disabled="readOnly" aria-label="status" />
          <span v-else>{{ definition(response)!.status }}</span>
          <input v-if="response.kind === 'inline'" v-model="response.description" :data-testid="`response-description-${index}`" :disabled="readOnly" :placeholder="t('contract.description')" />
          <span v-else>{{ definition(response)!.description }}</span>
        </div>
        <div class="headers">
          <strong>{{ t('contract.responseHeaders') }}</strong>
          <div v-for="(value, name) in definition(response)!.headers" :key="headerRowId(response, name)" class="row">
            <input :value="displayedHeaderName(response, name)" :data-testid="`response-header-name-${index}-${Object.keys(definition(response)!.headers).indexOf(name)}`" :disabled="readOnly || response.kind !== 'inline'" :aria-invalid="headerDraftError(response, name) || localHeaderDraftError(response, name) ? 'true' : undefined" @input="updateHeaderNameDraft(response, name, ($event.target as HTMLInputElement).value)" @change="commitHeaderName(response, name)" />
            <span v-if="headerDraftError(response, name)" role="alert" data-testid="response-header-error">{{ headerDraftError(response, name) }}</span>
            <input :value="value" :data-testid="`response-header-value-${index}-${Object.keys(definition(response)!.headers).indexOf(name)}`" :disabled="readOnly || response.kind !== 'inline'" @input="(event) => { if (!readOnly && response.kind === 'inline') response.headers[name] = (event.target as HTMLInputElement).value; }" />
            <button type="button" :data-testid="`response-header-remove-${index}-${Object.keys(definition(response)!.headers).indexOf(name)}`" :disabled="readOnly || response.kind !== 'inline'" @click="removeHeader(response, name)">×</button>
          </div>
          <span v-if="!draftScope && headerError" role="alert" data-testid="response-header-error">{{ headerError }}</span>
          <button type="button" data-testid="response-header-add" :disabled="readOnly || response.kind !== 'inline'" @click="addHeader(response)">{{ t('contract.responseHeaderAdd') }}</button>
        </div>
        <div v-for="(content, media) in definition(response)!.content" :key="media" class="media">
          <header><strong>{{ media }}</strong><button type="button" :disabled="readOnly || response.kind !== 'inline'" @click="removeMedia(response, media)">×</button></header>
          <SchemaEditor :model-value="content.schema" :models="assets.models" :read-only="readOnly || response.kind !== 'inline'" :draft-scope="draftScope ? `${draftScope}.response.${response.id}.${ownerSegment(media)}.schema` : undefined" :drafts="drafts" @update:model-value="setSchema(response, content, media, $event as SchemaNode | undefined)" @update:control-draft="forwardControlDraft" @clear:control-drafts="clearControlDrafts" @move:control-drafts="forwardMoveControlDrafts" />
          <div v-for="(example, exampleIndex) in content.examples" :key="example.id" class="example">
            <input v-if="example.kind === 'inline'" :value="example.name" :disabled="readOnly || response.kind !== 'inline'" :placeholder="t('contract.exampleName')" @input="setExampleName(response, example, ($event.target as HTMLInputElement).value)" />
            <span v-else>{{ exampleRefName(example) }}</span>
            <select v-if="exampleComponents().length" :value="example.kind === 'componentRef' ? example.componentId : ''" :disabled="readOnly || response.kind !== 'inline'" @change="useExampleComponent(response, content, media, exampleIndex, ($event.target as HTMLSelectElement).value)">
              <option value="">{{ t('contract.inlineExample') }}</option>
              <option v-for="asset in exampleComponents()" :key="asset.id" :value="asset.id">{{ asset.name }}</option>
            </select>
            <textarea :value="displayExample(response, example, media)" :disabled="readOnly || response.kind !== 'inline' || example.kind === 'componentRef'" :aria-invalid="exampleError(response, example, media) ? 'true' : undefined" :data-testid="`response-example-${index}-${exampleIndex}`" @input="updateExampleDraft(response, example, media, ($event.target as HTMLTextAreaElement).value)" @change="setExampleValue(response, example, media, ($event.target as HTMLTextAreaElement).value)" />
            <span v-if="exampleError(response, example, media)" role="alert" data-testid="response-example-error">{{ exampleError(response, example, media) }}</span>
          </div>
          <button type="button" :data-testid="exampleAddTestId(index, media)" :disabled="readOnly || response.kind !== 'inline'" @click="addExample(response, content)">{{ t('contract.exampleAdd') }}</button>
        </div>
        <div class="row"><input v-model="newMediaType" :disabled="readOnly || response.kind !== 'inline'" :placeholder="t('contract.mediaType')" /><button type="button" data-testid="response-media-add" :disabled="readOnly || response.kind !== 'inline'" @click="addMedia(response)">{{ t('contract.mediaAdd') }}</button></div>
      </template>
      <div v-else-if="response.kind === 'componentRef'" class="missing">{{ t('contract.missingComponent') }}</div>
    </article>
    <p v-if="responses.length === 0">{{ t('contract.noResponses') }}</p>
  </section>
</template>

<style scoped>
.responses { border-top: 1px solid var(--border, #d9d9d9); padding: 8px; display: grid; gap: 8px; }
.response, .media { border: 1px solid var(--border, #d9d9d9); padding: 8px; display: grid; gap: 8px; }
header, .row, .example { display: flex; gap: 8px; align-items: center; }
header > strong { flex: 1; }
.row > input, .example > input, textarea { flex: 1; }
textarea { min-height: 50px; font-family: ui-monospace, monospace; }
</style>

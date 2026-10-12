<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ComponentAssetSchema, ModelAssetSchema } from "@apicc/core/schema";
import type { ComponentAsset, ModelAsset } from "@apicc/core";
import type { ApiccApi } from "../../../shared/types.js";
import type { CreateComponentInput, CreateModelInput } from "../../../shared/types.js";
import type { DeleteAssetResult } from "../stores/assets.js";
import type { ComponentLocator, ModelLocator, ProjectLocator } from "../../../shared/locations.js";
import SchemaEditor from "./SchemaEditor.vue";
import CredentialEditor from "./CredentialEditor.vue";

const props = defineProps<{
  assets: {
    projectLocator: ProjectLocator | null;
    models: ModelAsset[];
    components: ComponentAsset[];
    createModel(input: CreateModelInput): Promise<ModelAsset>;
    saveModel(locator: ModelLocator, model: ModelAsset): Promise<ModelAsset>;
    createComponent(input: CreateComponentInput): Promise<ComponentAsset>;
    saveComponent(locator: ComponentLocator, component: ComponentAsset): Promise<ComponentAsset>;
    deleteAsset(input: { kind: "model"; locator: ModelLocator } | { kind: "component"; locator: ComponentLocator }): Promise<DeleteAssetResult>;
  };
  api?: ApiccApi;
  credentialContextKey?: string;
  readOnly?: boolean;
}>();
const { t } = useI18n();
const selectedModelId = ref("");
const selectedComponentKey = ref("");
const componentDraft = ref("");
const newComponentKind = ref<CreateComponentInput["kind"]>("parameter");
const error = ref("");
const feedback = ref("");
const model = computed(() => props.assets.models.find((item) => item.id === selectedModelId.value) ?? null);
const component = computed(() => props.assets.components.find((item) => `${item.kind}:${item.id}` === selectedComponentKey.value) ?? null);
const authComponent = computed(() => component.value?.kind === "auth" ? component.value : null);

watch(component, (value) => { componentDraft.value = value ? JSON.stringify(value, null, 2) : ""; }, { immediate: true });
watch(() => props.assets.models.map((item) => item.id).join("|"), () => {
  if (!props.assets.models.some((item) => item.id === selectedModelId.value)) selectedModelId.value = props.assets.models[0]?.id ?? "";
}, { immediate: true });
watch(() => props.assets.components.map((item) => `${item.kind}:${item.id}`).join("|"), () => {
  if (!props.assets.components.some((item) => `${item.kind}:${item.id}` === selectedComponentKey.value)) {
    const first = props.assets.components[0];
    selectedComponentKey.value = first ? `${first.kind}:${first.id}` : "";
  }
}, { immediate: true });

function projectLocator() {
  const locator = props.assets.projectLocator;
  if (!locator) throw new Error(t("contract.assetsNotLoaded"));
  return { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId };
}

function referenceMessage(references: Array<{ ownerId: string; path: string }>): string {
  const callers = references.map((item) => `${item.ownerId} · ${item.path}`).join("；");
  return t("contract.assetInUse", { count: references.length, callers });
}

async function addModel() {
  error.value = "";
  feedback.value = "";
  try {
    const created = await props.assets.createModel({
      name: t("contract.newModel"), description: "",
      schema: { kind: "object", properties: {}, required: [], additionalProperties: false },
    });
    selectedModelId.value = created.id;
    feedback.value = t("contract.assetCreated");
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
}

async function saveModel() {
  if (!model.value) return;
  error.value = "";
  feedback.value = "";
  try {
    const parsed = ModelAssetSchema.parse(JSON.parse(JSON.stringify(model.value)));
    await props.assets.saveModel({ ...projectLocator(), modelId: parsed.id }, parsed);
    feedback.value = t("contract.assetSaved");
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
}

function componentInput(kind: CreateComponentInput["kind"]): CreateComponentInput {
  if (kind === "parameter") return {
    kind, name: t("contract.newComponent"), description: "",
    definition: { location: "query", name: "", schema: { kind: "scalar", type: "string" }, required: false, description: "" },
  };
  if (kind === "auth") return {
    kind, name: t("contract.newComponent"), description: "",
    definition: { kind: "bearer", token: { id: crypto.randomUUID(), policy: "test-auto" } },
  };
  if (kind === "response") return {
    kind, name: t("contract.newComponent"), description: "",
    definition: { status: "200", description: "", headers: {}, content: { "application/json": { examples: [] } } },
  };
  return { kind, name: t("contract.newComponent"), description: "", definition: { name: "", value: {} } };
}

function selectComponent(asset: ComponentAsset) {
  selectedComponentKey.value = `${asset.kind}:${asset.id}`;
  componentDraft.value = JSON.stringify(asset, null, 2);
}

async function addComponent() {
  error.value = "";
  feedback.value = "";
  try {
    const created = await props.assets.createComponent(componentInput(newComponentKind.value));
    await nextTick(); // let the component-list reconciliation settle before pinning the newly created selection
    selectComponent(created);
    feedback.value = t("contract.assetCreated");
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
}

async function saveComponent() {
  error.value = "";
  feedback.value = "";
  try {
    const candidate: unknown = JSON.parse(componentDraft.value);
    const parsed = ComponentAssetSchema.parse(candidate);
    if (!component.value || parsed.id !== component.value.id || parsed.kind !== component.value.kind) {
      throw new Error(t("contract.assetIdentityChanged"));
    }
    await props.assets.saveComponent({ ...projectLocator(), componentKind: parsed.kind, componentId: parsed.id }, parsed);
    componentDraft.value = JSON.stringify(parsed, null, 2);
    feedback.value = t("contract.assetSaved");
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
}

async function deleteModel() {
  if (!model.value) return;
  error.value = "";
  feedback.value = "";
  try {
    const result = await props.assets.deleteAsset({ kind: "model", locator: { ...projectLocator(), modelId: model.value.id } });
    if (!result.deleted) { error.value = referenceMessage(result.references); return; }
    selectedModelId.value = props.assets.models[0]?.id ?? "";
    feedback.value = t("contract.assetDeleted");
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
}

async function deleteComponent() {
  if (!component.value) return;
  error.value = "";
  feedback.value = "";
  try {
    const current = component.value;
    const result = await props.assets.deleteAsset({ kind: "component", locator: { ...projectLocator(), componentKind: current.kind, componentId: current.id } });
    if (!result.deleted) { error.value = referenceMessage(result.references); return; }
    selectedComponentKey.value = "";
    feedback.value = t("contract.assetDeleted");
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
}
</script>

<template>
  <details class="assets-panel" data-testid="assets-panel">
    <summary>{{ t('contract.projectAssets') }} ({{ assets.models.length }} {{ t('contract.models') }}, {{ assets.components.length }} {{ t('contract.components') }})</summary>
    <div class="asset-columns">
      <section>
        <header><h3>{{ t('contract.models') }}</h3><button type="button" data-testid="asset-model-add" :disabled="readOnly" @click="addModel">{{ t('contract.modelAdd') }}</button></header>
        <button v-for="item in assets.models" :key="item.id" type="button" class="asset-choice" :aria-pressed="selectedModelId === item.id" @click="selectedModelId = item.id">{{ item.name }}</button>
        <div v-if="model" class="asset-detail">
          <input v-model="model.name" data-testid="asset-model-name" :disabled="readOnly" :placeholder="t('contract.metadataName')" />
          <input v-model="model.description" :disabled="readOnly" :placeholder="t('contract.metadataDescription')" />
          <SchemaEditor v-model="model.schema" :models="assets.models" :read-only="readOnly" />
          <button type="button" data-testid="asset-model-save" :disabled="readOnly" @click="saveModel">{{ t('contract.assetSave') }}</button>
          <button type="button" data-testid="asset-model-delete" :disabled="readOnly" @click="deleteModel">{{ t('contract.assetDelete') }}</button>
        </div>
      </section>
      <section>
        <header><h3>{{ t('contract.components') }}</h3></header>
        <div class="row">
          <select v-model="newComponentKind" :disabled="readOnly" data-testid="asset-component-kind">
            <option v-for="kind in ['parameter', 'auth', 'response', 'example']" :key="kind" :value="kind">{{ t(`contract.componentKind.${kind}`) }}</option>
          </select>
          <button type="button" data-testid="asset-component-add" :disabled="readOnly" @click="addComponent">{{ t('contract.componentAdd') }}</button>
        </div>
        <button v-for="item in assets.components" :key="`${item.kind}:${item.id}`" type="button" class="asset-choice" :data-testid="`asset-component-select-${item.kind}-${item.id}`" :aria-pressed="selectedComponentKey === `${item.kind}:${item.id}`" @click="selectComponent(item)">{{ t(`contract.componentKind.${item.kind}`) }} · {{ item.name }}</button>
        <div v-if="component" class="asset-detail">
          <textarea v-model="componentDraft" data-testid="asset-component-definition" :disabled="readOnly" rows="12" spellcheck="false" />
          <CredentialEditor v-if="api && assets.projectLocator && authComponent" :api="api" :locator="assets.projectLocator" :auth="authComponent.definition" :context-key="`${credentialContextKey ?? ''}:auth-component:${authComponent.id}`" :read-only="readOnly" />
          <button type="button" data-testid="asset-component-save" :disabled="readOnly" @click="saveComponent">{{ t('contract.assetSave') }}</button>
          <button type="button" data-testid="asset-component-delete" :disabled="readOnly" @click="deleteComponent">{{ t('contract.assetDelete') }}</button>
        </div>
      </section>
    </div>
    <p v-if="feedback" data-testid="asset-feedback">{{ feedback }}</p>
    <p v-if="error" data-testid="asset-error">{{ error }}</p>
  </details>
</template>

<style scoped>
.assets-panel { border-top: 1px solid var(--border, #d9d9d9); padding: 8px; }
.asset-columns { display: grid; grid-template-columns: minmax(220px, 1fr) minmax(280px, 1.4fr); gap: 12px; }
section, .asset-detail { display: grid; align-content: start; gap: 6px; }
header, .row { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
h3 { margin: 4px 0; }
.asset-choice { text-align: left; }
textarea { font-family: ui-monospace, monospace; }
</style>

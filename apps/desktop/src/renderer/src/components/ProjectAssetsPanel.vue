<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, shallowReactive, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ComponentAssetSchema, ModelAssetSchema } from "@apicc/core/schema";
import type { ComponentAsset, ModelAsset } from "@apicc/core";
import type { ApiccApi } from "../../../shared/types.js";
import type { CreateComponentInput, CreateModelInput } from "../../../shared/types.js";
import type { DeleteAssetResult } from "../stores/assets.js";
import type { ComponentLocator, ModelLocator, ProjectLocator } from "../../../shared/locations.js";
import SchemaEditor from "./SchemaEditor.vue";
import CredentialEditor from "./CredentialEditor.vue";
import type { ProjectAssetTarget } from "../projectAssetTarget.js";

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
  direct?: boolean;
  target?: ProjectAssetTarget | null;
}>();
const emit = defineEmits<{ "credential-changed": [owner: string | undefined] }>();
const { t } = useI18n();
const selectedModelId = ref("");
const selectedComponentKey = ref("");
type ModelDraft = { baseline: string; value: ModelAsset };
const modelDrafts = shallowReactive(new Map<string, ModelDraft>());
const componentDrafts = reactive(new Map<string, { baseline: string; text: string }>());
const savingModel = ref(false);
const savingComponent = ref(false);
const newComponentKind = ref<CreateComponentInput["kind"]>("parameter");
const error = ref("");
const feedback = ref("");
const targetMissing = ref(false);
let mounted = true;
onBeforeUnmount(() => { mounted = false; });
const model = computed(() => props.assets.models.find((item) => item.id === selectedModelId.value) ?? null);
const component = computed(() => props.assets.components.find((item) => `${item.kind}:${item.id}` === selectedComponentKey.value) ?? null);
const authComponent = computed(() => component.value?.kind === "auth" ? component.value : null);
const selectedModelDraft = computed(() => modelDrafts.get(selectedModelId.value));
const selectedComponentDraft = computed(() => componentDrafts.get(selectedComponentKey.value));
const assetText = (asset: ModelAsset | ComponentAsset) => JSON.stringify(asset, null, 2);
const modelConflict = computed(() => !!model.value && !!selectedModelDraft.value
  && assetText(model.value) !== selectedModelDraft.value.baseline
  && assetText(selectedModelDraft.value.value) !== selectedModelDraft.value.baseline);
const componentConflict = computed(() => !!component.value && !!selectedComponentDraft.value
  && assetText(component.value) !== selectedComponentDraft.value.baseline
  && selectedComponentDraft.value.text !== selectedComponentDraft.value.baseline);

function resetModelDraft() {
  const current = model.value;
  if (current) {
    const baseline = assetText(current);
    modelDrafts.set(current.id, shallowReactive({ baseline, value: shallowReactive(JSON.parse(baseline) as ModelAsset) }));
  }
}
function resetComponentDraft() {
  const current = component.value;
  if (current) {
    const baseline = assetText(current);
    componentDrafts.set(`${current.kind}:${current.id}`, { baseline, text: baseline });
  }
}

watch(model, () => {
  const draft = selectedModelDraft.value;
  if (!draft || assetText(draft.value) === draft.baseline) resetModelDraft();
}, { immediate: true });
watch(component, () => {
  const draft = selectedComponentDraft.value;
  if (!draft || draft.text === draft.baseline) resetComponentDraft();
}, { immediate: true });
watch(() => JSON.stringify([props.assets.projectLocator, props.credentialContextKey]), () => {
  modelDrafts.clear();
  componentDrafts.clear();
  resetModelDraft();
  resetComponentDraft();
});
watch(() => props.assets.models.map((item) => item.id).join("|"), () => {
  if (!props.assets.models.some((item) => item.id === selectedModelId.value)) selectedModelId.value = props.assets.models[0]?.id ?? "";
}, { immediate: true });
watch(() => props.assets.components.map((item) => `${item.kind}:${item.id}`).join("|"), () => {
  if (!props.assets.components.some((item) => `${item.kind}:${item.id}` === selectedComponentKey.value)) {
    const first = props.assets.components[0];
    selectedComponentKey.value = first ? `${first.kind}:${first.id}` : "";
  }
}, { immediate: true });
watch(() => props.target, (target) => {
  targetMissing.value = false;
  if (!target) return;
  if (target.kind === "model") {
    targetMissing.value = !props.assets.models.some((item) => item.id === target.id);
    selectedModelId.value = targetMissing.value ? "" : target.id;
  } else {
    const component = props.assets.components.find((item) => item.id === target.id && item.kind === "auth");
    targetMissing.value = !component;
    if (component) selectComponent(component);
    else selectedComponentKey.value = "";
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
  if (props.readOnly) return;
  error.value = "";
  feedback.value = "";
  try {
    const created = await props.assets.createModel({
      name: t("contract.newModel"), description: "",
      schema: { kind: "object", properties: {}, required: [], additionalProperties: false },
    });
    if (!mounted) return;
    selectedModelId.value = created.id;
    feedback.value = t("contract.assetCreated");
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
}

async function saveModel() {
  const draft = selectedModelDraft.value;
  if (!model.value || !draft || props.readOnly || modelConflict.value || savingModel.value) return;
  savingModel.value = true;
  error.value = "";
  feedback.value = "";
  try {
    const submitted = assetText(draft.value);
    const parsed = ModelAssetSchema.parse(JSON.parse(submitted));
    const saved = await props.assets.saveModel({ ...projectLocator(), modelId: parsed.id }, parsed);
    if (modelDrafts.get(parsed.id) === draft) {
      const baseline = assetText(saved);
      if (assetText(draft.value) === submitted) draft.value = shallowReactive(saved);
      draft.baseline = baseline;
    }
    feedback.value = t("contract.assetSaved");
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { savingModel.value = false; }
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
}

async function addComponent() {
  if (props.readOnly) return;
  error.value = "";
  feedback.value = "";
  try {
    const created = await props.assets.createComponent(componentInput(newComponentKind.value));
    await nextTick(); // let the component-list reconciliation settle before pinning the newly created selection
    if (!mounted) return;
    selectComponent(created);
    feedback.value = t("contract.assetCreated");
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
}

async function saveComponent() {
  const draft = selectedComponentDraft.value;
  if (!draft || props.readOnly || componentConflict.value || savingComponent.value) return;
  savingComponent.value = true;
  error.value = "";
  feedback.value = "";
  try {
    const submitted = draft.text;
    const candidate: unknown = JSON.parse(submitted);
    const parsed = ComponentAssetSchema.parse(candidate);
    if (!component.value || parsed.id !== component.value.id || parsed.kind !== component.value.kind) {
      throw new Error(t("contract.assetIdentityChanged"));
    }
    const saved = await props.assets.saveComponent({ ...projectLocator(), componentKind: parsed.kind, componentId: parsed.id }, parsed);
    const key = `${saved.kind}:${saved.id}`;
    if (componentDrafts.get(key) === draft) {
      const baseline = assetText(saved);
      if (draft.text === submitted) componentDrafts.set(key, { baseline, text: baseline });
      else draft.baseline = baseline;
    }
    feedback.value = t("contract.assetSaved");
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { savingComponent.value = false; }
}

async function deleteModel() {
  if (!model.value || props.readOnly || modelConflict.value) return;
  const id = model.value.id;
  error.value = "";
  feedback.value = "";
  try {
    const result = await props.assets.deleteAsset({ kind: "model", locator: { ...projectLocator(), modelId: model.value.id } });
    if (!mounted) return;
    if (!result.deleted) { error.value = referenceMessage(result.references); return; }
    modelDrafts.delete(id);
    selectedModelId.value = props.assets.models[0]?.id ?? "";
    feedback.value = t("contract.assetDeleted");
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
}

async function deleteComponent() {
  if (!component.value || props.readOnly || componentConflict.value) return;
  error.value = "";
  feedback.value = "";
  try {
    const current = component.value;
    const result = await props.assets.deleteAsset({ kind: "component", locator: { ...projectLocator(), componentKind: current.kind, componentId: current.id } });
    if (!mounted) return;
    if (!result.deleted) { error.value = referenceMessage(result.references); return; }
    componentDrafts.delete(`${current.kind}:${current.id}`);
    selectedComponentKey.value = "";
    feedback.value = t("contract.assetDeleted");
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
}
</script>

<template>
  <component :is="direct ? 'section' : 'details'" class="assets-panel" data-testid="assets-panel">
    <summary v-if="!direct">{{ t('contract.projectAssets') }} ({{ assets.models.length }} {{ t('contract.models') }}, {{ assets.components.length }} {{ t('contract.components') }})</summary>
    <p v-if="targetMissing" role="alert" data-testid="project-asset-target-missing">{{ t(target?.kind === 'model' ? 'contract.missingModel' : 'contract.missingComponent') }}</p>
    <div class="asset-columns">
      <section>
        <header><h3>{{ t('contract.models') }}</h3><button type="button" data-testid="asset-model-add" :disabled="readOnly" @click="addModel">{{ t('contract.modelAdd') }}</button></header>
        <p v-if="!assets.models.length">{{ t('projectTools.noModels') }}</p>
        <button v-for="item in assets.models" :key="item.id" type="button" class="asset-choice" :title="item.name" :data-testid="`asset-model-select-${item.id}`" :aria-pressed="selectedModelId === item.id" @click="selectedModelId = item.id; targetMissing = false">{{ item.name }}</button>
        <div v-if="model && selectedModelDraft" class="asset-detail">
          <input v-model="selectedModelDraft.value.name" data-testid="asset-model-name" :disabled="readOnly" :placeholder="t('contract.metadataName')" />
          <input v-model="selectedModelDraft.value.description" :disabled="readOnly" :placeholder="t('contract.metadataDescription')" />
          <SchemaEditor v-model="selectedModelDraft.value.schema" :models="assets.models" :read-only="readOnly" />
          <p v-if="modelConflict" role="alert">{{ t('projectTools.assetChanged') }}</p>
          <button v-if="modelConflict" type="button" data-testid="asset-model-use-saved" @click="resetModelDraft">{{ t('projectTools.useSavedAsset') }}</button>
          <button type="button" data-testid="asset-model-save" :disabled="readOnly || modelConflict || savingModel" @click="saveModel">{{ t('contract.assetSave') }}</button>
          <button type="button" data-testid="asset-model-delete" :disabled="readOnly || modelConflict || savingModel" @click="deleteModel">{{ t('contract.assetDelete') }}</button>
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
        <p v-if="!assets.components.length">{{ t('projectTools.noComponents') }}</p>
        <button v-for="item in assets.components" :key="`${item.kind}:${item.id}`" type="button" class="asset-choice" :title="item.name" :data-testid="`asset-component-select-${item.kind}-${item.id}`" :aria-pressed="selectedComponentKey === `${item.kind}:${item.id}`" @click="selectComponent(item); targetMissing = false">{{ t(`contract.componentKind.${item.kind}`) }} · {{ item.name }}</button>
        <div v-if="component && selectedComponentDraft" class="asset-detail">
          <label class="asset-definition">
            <span>{{ t('desktopPresentation.rawComponent') }}</span>
            <textarea v-model="selectedComponentDraft.text" data-testid="asset-component-definition" :disabled="readOnly" rows="8" spellcheck="false" />
          </label>
          <CredentialEditor v-if="api && assets.projectLocator && authComponent" :api="api" :locator="assets.projectLocator" :auth="authComponent.definition" :context-key="`${credentialContextKey ?? ''}:auth-component:${authComponent.id}`" :read-only="readOnly" manage-open
            @changed="emit('credential-changed', credentialContextKey)" />
          <p v-if="componentConflict" role="alert">{{ t('projectTools.assetChanged') }}</p>
          <button v-if="componentConflict" type="button" data-testid="asset-component-use-saved" @click="resetComponentDraft">{{ t('projectTools.useSavedAsset') }}</button>
          <button type="button" data-testid="asset-component-save" :disabled="readOnly || componentConflict || savingComponent" @click="saveComponent">{{ t('contract.assetSave') }}</button>
          <button type="button" data-testid="asset-component-delete" :disabled="readOnly || componentConflict || savingComponent" @click="deleteComponent">{{ t('contract.assetDelete') }}</button>
        </div>
      </section>
    </div>
    <p v-if="feedback" data-testid="asset-feedback">{{ feedback }}</p>
    <p v-if="error" data-testid="asset-error">{{ error }}</p>
  </component>
</template>

<style scoped src="../styles/editor-controls.css"></style>
<style scoped>
.assets-panel { border-top: 1px solid var(--border, #d9d9d9); padding: 8px; }
.asset-columns { display: grid; grid-template-columns: minmax(220px, 1fr) minmax(280px, 1.4fr); gap: 12px; }
section, .asset-detail { display: grid; align-content: start; gap: 6px; }
header, .row { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
h3 { margin: 4px 0; }
.asset-choice { text-align: left; }
textarea { font-family: ui-monospace, monospace; }
.asset-definition { display: grid; gap: 4px; }

.assets-panel { min-width: 0; background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 12px; } .asset-columns { grid-template-columns: repeat(auto-fit,minmax(min(100%,300px),1fr)); margin-top: 12px; } section,.asset-detail { min-width: 0; } header,.row { flex-wrap: wrap; } .asset-choice { overflow-wrap: anywhere; } .asset-choice[aria-pressed=true] { border-color: var(--accent); background: var(--active-weak); } textarea { width: 100%; min-height: 100px; }

</style>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { message, Alert as AAlert, Button as AButton, Input as AInput, Modal as AModal, Radio as ARadio, Select as ASelect } from "ant-design-vue";
import type { ComponentAsset, ModelAsset } from "@apicc/core";
import type { DocumentScope } from "@apicc/core";
import type { useEditorStore } from "../stores/editor.js";
import type { useDesignStore } from "../stores/design.js";
import type { useWorkspaceStore } from "../stores/workspace.js";
import type { LocalTreeNodeDTO } from "../../../shared/tree-dto.js";
import EmptyState from "./EmptyState.vue";
import ContractDesigner from "./ContractDesigner.vue";
import DocumentPreview from "./DocumentPreview.vue";

const ATextarea = AInput.TextArea;
const ARadioGroup = ARadio.Group;

/**
 * Project design editor. Saved-snapshot export shares the Core document projection and
 * renders Markdown/HTML/OpenAPI in Node; this dialog captures the scope and complete editor-session
 * identity, then delegates the native save dialog and atomic write to the main process.
 */
const props = defineProps<{
  editor: ReturnType<typeof useEditorStore>;
  design: ReturnType<typeof useDesignStore>;
  workspace: ReturnType<typeof useWorkspaceStore>;
  assets?: { models: ModelAsset[]; components: ComponentAsset[] };
  reportError?: (e: unknown) => void;
  readOnly?: boolean;
}>();
const { t } = useI18n();

const savedVersion = ref<string | null>(null);
const activeView = ref<"contract" | "document">("document");
const exportOpen = ref(false);
const exportFormat = ref<"markdown" | "html" | "openapi-3.0" | "openapi-3.1">("markdown");
const exportEncoding = ref<"json" | "yaml">("json");
const exportInfoVersion = ref("");
const openapiExport = computed(() => exportFormat.value === "openapi-3.0" || exportFormat.value === "openapi-3.1");
const exportScopeKind = ref<DocumentScope["kind"]>("project");
const selectedCollectionIds = ref<string[]>([]);
const selectedApiIds = ref<string[]>([]);
const selectedTags = ref<string[]>([]);
let exportIdentity = "";
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let lastPreviewSessionIdentity: string | null | undefined;
const saved = computed(() => savedVersion.value !== null && savedVersion.value === props.design.committedContentVersion);

const projectTree = computed(() => {
  const locator = props.editor.locator;
  return locator ? props.workspace.findProject({ workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId }) : null;
});
const collectionOptions = computed(() => treeOptions(projectTree.value, "collection"));
const apiOptions = computed(() => treeOptions(projectTree.value, "api"));
const exportDirty = computed(() => props.editor.dirty || props.design.dirty);
const invalidControlDrafts = computed(() => props.design.hasInvalidControls);
const validExportScope = computed(() => exportScopeKind.value === "project"
  || (exportScopeKind.value === "collections" && selectedCollectionIds.value.length > 0)
  || (exportScopeKind.value === "apis" && selectedApiIds.value.length > 0)
  || (exportScopeKind.value === "tags" && selectedTags.value.length > 0));

// immediate：装配后首次挂载（含视图切换重挂）也要按当前接口水合，不等 apiId 变化。
watch(
  () => {
    const key = props.editor.activeKey;
    const session = key ? props.editor.sessions[key] : undefined;
    return [key, session?.generation] as const;
  },
  () => {
    props.design.load();
    savedVersion.value = null;
  },
  { immediate: true },
);
watch(() => props.editor.activeKey, () => { exportOpen.value = false; });
watch(() => props.design.contentVersion, () => {
  savedVersion.value = null;
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = undefined;
  const identity = props.design.sessionIdentity;
  const sessionChanged = lastPreviewSessionIdentity === undefined || lastPreviewSessionIdentity !== identity;
  lastPreviewSessionIdentity = identity;
  if (activeView.value !== "document" || !identity) return;
  if (sessionChanged) {
    void props.design.preview();
    return;
  }
  previewTimer = setTimeout(() => {
    previewTimer = undefined;
    if (activeView.value === "document") void props.design.preview();
  }, 180);
}, { flush: "post", immediate: true });

onUnmounted(() => {
  if (previewTimer) clearTimeout(previewTimer);
});

async function onSave() {
  if (props.readOnly) return;
  savedVersion.value = null;
  try {
    // Reconcile the design draft with the current editor generation before it can write documentation.
    props.design.load();
    const submittedVersion = props.design.committedContentVersion;
    await props.design.save();
    savedVersion.value = submittedVersion;
  } catch (e) {
    savedVersion.value = null;
    props.reportError?.(e);
  }
}

function setView(view: "contract" | "document") {
  activeView.value = view;
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = undefined;
  if (view === "document") void props.design.preview();
}

function setContent(value: string) {
  if (!props.readOnly) props.design.setContent(value);
}

function onExport() {
  const key = props.editor.activeKey;
  const session = key ? props.editor.sessions[key] : undefined;
  if (!session) return;
  exportIdentity = exportSessionIdentity(session);
  exportFormat.value = "markdown";
  exportEncoding.value = "json";
  exportInfoVersion.value = "";
  exportScopeKind.value = "project";
  selectedCollectionIds.value = [session.locator.collectionId];
  selectedApiIds.value = [session.locator.apiId];
  selectedTags.value = [...(props.editor.api?.contract.metadata.tags ?? [])];
  exportOpen.value = true;
}

function buildExportScope(): DocumentScope {
  switch (exportScopeKind.value) {
    case "project": return { kind: "project" };
    case "collections": return { kind: "collections", collectionIds: [...selectedCollectionIds.value] };
    case "apis": return { kind: "apis", contractIds: [...selectedApiIds.value] };
    case "tags": return { kind: "tags", tags: [...selectedTags.value] };
  }
}

async function exportDocument(saveFirst: boolean) {
  try {
    const key = props.editor.activeKey;
    let session = key ? props.editor.sessions[key] : undefined;
    if (!session || exportSessionIdentity(session) !== exportIdentity) throw new Error(t("design.exportContextChanged"));
    if (saveFirst) {
      if (invalidControlDrafts.value) throw new Error(t("design.exportInvalidDraft"));
      props.design.load();
      await props.design.save();
      session = props.editor.sessions[props.editor.activeKey ?? ""];
      if (!session || exportSessionIdentity(session) !== exportIdentity) throw new Error(t("design.exportContextChanged"));
    }
    const path = await props.design.exportDocument(
      exportFormat.value,
      buildExportScope(),
      openapiExport.value ? {
        encoding: exportEncoding.value,
        ...(exportInfoVersion.value.trim() ? { infoVersion: exportInfoVersion.value.trim() } : {}),
      } : undefined,
    );
    exportOpen.value = false;
    if (path) void message.success(t("design.exported", { path }));
  } catch (e) {
    props.reportError?.(e);
  }
}

function exportSessionIdentity(session: NonNullable<ReturnType<typeof useEditorStore>["sessions"][string]>): string {
  const locator = session.locator;
  return JSON.stringify([session.root, session.generation, locator.workspaceId, locator.groupId, locator.projectId, locator.collectionId, ...locator.folderIds, locator.apiId]);
}

function treeOptions(root: LocalTreeNodeDTO | null, kind: "collection" | "api"): Array<{ label: string; value: string }> {
  const options: Array<{ label: string; value: string }> = [];
  const visit = (node: LocalTreeNodeDTO): void => {
    if (node.kind === kind) {
      const method = node.kind === "api" ? `${node.method ?? node.protocol.toUpperCase()} ` : "";
      options.push({ label: `${method}${node.label}`, value: node.id });
    }
    for (const child of node.children ?? []) visit(child);
  };
  if (root) visit(root);
  return options;
}
</script>

<template>
  <section class="design-panel" data-testid="design-panel">
    <EmptyState v-if="!editor.api" :text="t('design.empty')" />
    <template v-else>
      <div class="toolbar">
        <a-button size="small" type="primary" data-testid="design-save" :disabled="readOnly" @click="onSave">{{ t("design.save") }}</a-button>
        <a-button size="small" data-testid="design-export" @click="onExport">{{ t("design.export") }}</a-button>
        <span v-if="saved" class="saved" data-testid="design-saved">{{ t("design.saved") }}</span>
        <span class="toolbar-spacer"></span>
        <a-button size="small" :type="activeView === 'contract' ? 'primary' : 'default'" data-testid="design-contract-tab" @click="setView('contract')">{{ t('design.contractTab') }}</a-button>
        <a-button size="small" :type="activeView === 'document' ? 'primary' : 'default'" data-testid="design-document-tab" @click="setView('document')">{{ t('design.documentTab') }}</a-button>
      </div>
      <a-modal v-model:open="exportOpen" :title="t('design.exportDialogTitle')" :mask-closable="false" data-testid="design-export-dialog">
        <div class="export-options">
          <label>{{ t('design.exportFormat') }}</label>
          <ARadioGroup v-model:value="exportFormat" data-testid="design-export-format">
            <a-radio value="markdown">Markdown</a-radio>
            <a-radio value="html">HTML</a-radio>
            <a-radio value="openapi-3.0">OpenAPI 3.0</a-radio>
            <a-radio value="openapi-3.1">OpenAPI 3.1</a-radio>
          </ARadioGroup>

          <template v-if="openapiExport">
            <label>{{ t('design.exportEncoding') }}</label>
            <ARadioGroup v-model:value="exportEncoding" data-testid="design-export-encoding">
              <a-radio value="json">JSON</a-radio>
              <a-radio value="yaml">YAML</a-radio>
            </ARadioGroup>
            <label>{{ t('design.exportInfoVersion') }}</label>
            <a-input v-model:value="exportInfoVersion" :placeholder="t('design.exportInfoVersionHint')" data-testid="design-export-info-version" />
          </template>

          <label>{{ t('design.exportScope') }}</label>
          <ARadioGroup v-model:value="exportScopeKind" data-testid="design-export-scope">
            <a-radio value="project">{{ t('design.exportProject') }}</a-radio>
            <a-radio value="collections">{{ t('design.exportCollections') }}</a-radio>
            <a-radio value="apis">{{ t('design.exportApis') }}</a-radio>
            <a-radio value="tags">{{ t('design.exportTags') }}</a-radio>
          </ARadioGroup>

          <a-select v-if="exportScopeKind === 'collections'" v-model:value="selectedCollectionIds" mode="multiple" :options="collectionOptions" :placeholder="t('design.exportSelectCollections')" />
          <a-select v-else-if="exportScopeKind === 'apis'" v-model:value="selectedApiIds" mode="multiple" :options="apiOptions" :placeholder="t('design.exportSelectApis')" />
          <a-select v-else-if="exportScopeKind === 'tags'" v-model:value="selectedTags" mode="tags" :placeholder="t('design.exportEnterTags')" />

          <a-alert v-if="exportDirty" type="warning" show-icon :message="t('design.exportSavedWarning')" :description="invalidControlDrafts ? t('design.exportInvalidDraft') : undefined" />
        </div>
        <template #footer>
          <a-button data-testid="design-export-cancel" @click="exportOpen = false">{{ t('design.exportCancel') }}</a-button>
          <a-button v-if="exportDirty && !invalidControlDrafts" data-testid="design-export-save-first" @click="exportDocument(true)">{{ t('design.exportSaveFirst') }}</a-button>
          <a-button type="primary" data-testid="design-export-saved" :disabled="!validExportScope" @click="exportDocument(false)">{{ exportDirty ? t('design.exportSaved') : t('design.export') }}</a-button>
        </template>
      </a-modal>
      <div class="panel-content">
        <div v-show="activeView === 'contract'" class="content-view" data-testid="design-contract-view">
          <ContractDesigner
            :key="design.sessionIdentity ?? 'no-session'"
            :editor="editor"
            :assets="assets"
            :draft-scope="'contract'"
            :drafts="design.activeControlDrafts"
            :read-only="readOnly"
            @update:control-draft="design.setControlDraft"
            @clear:control-drafts="design.clearControlDrafts"
            @move:control-drafts="design.moveControlDrafts"
          />
        </div>
        <div v-show="activeView === 'document'" class="content-view document-view" data-testid="design-document-view">
          <label class="document-label" for="design-content">{{ t('design.documentTab') }}</label>
          <a-textarea
            id="design-content"
            :value="design.content"
            :rows="10"
            class="design-text"
            :placeholder="t('design.placeholder')"
            data-testid="design-content"
            :disabled="readOnly"
            @update:value="setContent($event as string)"
          />
          <pre class="preview-text">{{ design.content || t("design.previewEmpty") }}</pre>
          <DocumentPreview :status="design.previewStatus" :result="design.previewResult" :error="design.previewError" />
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
.design-panel {
  padding: 8px 10px;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
  box-sizing: border-box;
}
.toolbar {
  position: sticky;
  top: 8px;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--bg);
}
.toolbar-spacer { flex: 1; }
.panel-content { flex: 1; min-height: 0; min-width: 0; overflow: auto; }
.content-view { min-width: 0; }
.document-view { display: flex; flex-direction: column; gap: 8px; }
.document-label { font-weight: 600; }
.saved {
  color: var(--pass, #389e0d);
}
.export-options { display: flex; flex-direction: column; gap: 12px; }
.design-text {
  font-family: ui-monospace, monospace;
  resize: vertical;
  flex: none;
}
.preview-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  font-size: 12px;
}
</style>

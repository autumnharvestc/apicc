<script setup lang="ts">
import type { KeyValuePair } from "@apicc/core";
import { LocalWorkspaceError } from "../../../shared/workspace-refresh.js";
import { baseUrlPayload, environmentDraftsFor, normalizedVariables, parameterPayload, paramsToRows, recordToRows, variablePayload,
  type EnvironmentDraft, type FailureStep, type ParamRow, type ProjectDraft, type SaveFeedback, type VarRow } from "../stores/environmentDrafts.js";
import { isRefreshableFailure, jsonCopy, type DiskDraftConflict } from "../stores/diskDrafts.js";
import { diskErrorMessage } from "../diskRefreshPresentation.js";
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button as AButton, Checkbox as ACheckbox, Input as AInput, Modal as AModal, Select as ASelect, Tooltip as ATooltip } from "ant-design-vue";
import { DeleteOutlined, EllipsisOutlined, PlusOutlined } from "@ant-design/icons-vue";
import type { EnvironmentLocator, ProjectLocator } from "../../../shared/locations.js";
import type { EnvItem, useEnvsStore } from "../stores/envs.js";
import { projectSessionKey } from "../stores/localIdentity.js";
import type { useWorkspaceStore } from "../stores/workspace.js";
import ActionMenu from "./ActionMenu.vue";
import EmptyState from "./EmptyState.vue";
import ConfirmDialog from "./ConfirmDialog.vue";

const props = defineProps<{
  envs: ReturnType<typeof useEnvsStore>;
  workspace: ReturnType<typeof useWorkspaceStore>;
  projectLocator: ProjectLocator | null;
  reportError: (e: unknown) => void;
  refreshDisk?: () => Promise<void>;
  resolveDiskConflict?: (conflict: DiskDraftConflict, event: Event) => void;
  reviewMissingProject?: boolean;
}>();
const { t } = useI18n();

const pane = ref("gvars");
const drafts = computed(() => environmentDraftsFor(props.envs));
const projectKey = computed(() => props.projectLocator ? projectSessionKey(props.workspace.root, props.projectLocator) : "");
const loadedKey = computed(() => props.envs.root !== null && props.envs.projectLocator
  ? projectSessionKey(props.envs.root, props.envs.projectLocator) : "");
const contextReady = computed(() => !!projectKey.value && (projectKey.value === loadedKey.value || props.reviewMissingProject));
const environmentReadOnly = computed(() => props.workspace.readOnly || !!props.reviewMissingProject);
const scope = computed(() => contextReady.value ? drafts.value.get(projectKey.value) : undefined);
const collections = computed(() => {
  if (props.reviewMissingProject) return scope.value?.previousModules ?? [];
  const project = props.projectLocator ? props.workspace.findProject(props.projectLocator) : null;
  return (project?.children ?? []).filter((node) => node.kind === "collection").map((node) => ({ id: node.id, name: node.label }));
});
const projectName = computed(() => props.projectLocator ? props.workspace.findProject(props.projectLocator)?.label : undefined);
const environmentList = computed(() => {
  if (!contextReady.value || !props.projectLocator) return [];
  const current = props.reviewMissingProject ? [] : props.envs.envs;
  const retained = [...(scope.value?.environments.entries() ?? [])].flatMap(([id, draft]) =>
    draft.feedback.conflict?.reason === "deleted" && !current.some((entry) => entry.id === id) ? [{
      id, name: draft.name, locator: { ...props.projectLocator!, environmentId: id },
      variables: draft.confirmedVariables, baseUrls: draft.confirmedBaseUrls,
    }] : []);
  return [...current, ...retained];
});
const currentEnvironment = computed(() => environmentList.value.find((env) => env.id === pane.value));
const environmentDraft = computed(() => currentEnvironment.value ? scope.value?.environments.get(currentEnvironment.value.id) : undefined);
const variableRows = computed(() => environmentDraft.value?.rows ?? scope.value?.variableRows ?? []);
const variableTestPrefix = computed(() => environmentDraft.value ? "env-var" : "env-global-var");
const loadError = ref("");

function contextIsCurrent(root: string, locator: ProjectLocator): boolean {
  return projectSessionKey(root, locator) === projectKey.value && props.envs.isCurrentProject(root, locator)
    && !props.workspace.hasPendingOpen();
}

async function loadEnvs() {
  const key = projectKey.value;
  const locator = props.projectLocator ? { ...props.projectLocator } : null;
  loadError.value = "";
  if (!locator) return;
  try {
    await props.envs.load(locator);
  } catch (error) {
    if (key === projectKey.value) loadError.value = errorMessage(error);
  }
}

function sameRecord(left: Record<string, string>, right: Record<string, string>) {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && right[key] === left[key]);
}

function sameParams(left: KeyValuePair[], right: KeyValuePair[]) {
  return left.length === right.length && left.every((item, i) =>
    item.key === right[i]?.key && item.value === right[i]?.value && item.enabled === right[i]?.enabled);
}

function newFeedback(): SaveFeedback {
  return { pending: false, saved: false, error: null };
}

function syncDrafts() {
  if (!contextReady.value || props.reviewMissingProject) return;
  const key = projectKey.value;
  const globals = props.envs.globals;
  let projectDraft = drafts.value.get(key);
  if (!projectDraft) {
    drafts.value.set(key, {
      root: props.workspace.root,
      locator: { ...props.projectLocator! },
      globals,
      latestGlobals: globals,
      variableRows: recordToRows(globals.variables),
      queryRows: paramsToRows(globals.query),
      headerRows: paramsToRows(globals.headers),
      variableFeedback: newFeedback(),
      parameterFeedback: newFeedback(),
      environments: new Map(),
    });
    projectDraft = drafts.value.get(key)!;
  } else if (!projectDraft.variableFeedback.pending && !projectDraft.parameterFeedback.pending) {
    const previous = projectDraft.globals;
    if (!projectDraft.variableFeedback.conflict && sameRecord(variablePayload(projectDraft.variableRows), normalizedVariables(previous.variables)) && !sameRecord(globals.variables, previous.variables)) {
      projectDraft.variableRows = recordToRows(globals.variables);
    }
    if (!projectDraft.parameterFeedback.conflict && sameParams(parameterPayload(projectDraft.queryRows), parameterPayload(previous.query)) && !sameParams(globals.query, previous.query)) {
      projectDraft.queryRows = paramsToRows(globals.query);
    }
    if (!projectDraft.parameterFeedback.conflict && sameParams(parameterPayload(projectDraft.headerRows), parameterPayload(previous.headers)) && !sameParams(globals.headers, previous.headers)) {
      projectDraft.headerRows = paramsToRows(globals.headers);
    }
    projectDraft.latestGlobals = globals;
    projectDraft.globals = {
      ...globals,
      ...(projectDraft.variableFeedback.conflict ? { variables: previous.variables } : {}),
      ...(projectDraft.parameterFeedback.conflict ? { query: previous.query, headers: previous.headers } : {}),
    };
  }
  // Refresh clean fields from the loaded snapshot and preserve modified fields.
  // Pending writes establish their own baselines when their responses arrive.
  for (const env of props.envs.envs) {
    const existing = projectDraft.environments.get(env.id);
    if (existing) {
      if (existing.feedback.pending || existing.feedback.conflict) continue;
      existing.name = env.name;
      if (sameRecord(variablePayload(existing.rows), normalizedVariables(existing.confirmedVariables)) && !sameRecord(env.variables, existing.confirmedVariables)) {
        existing.rows = recordToRows(env.variables);
      }
      if (sameRecord(baseUrlPayload(existing.baseUrls), baseUrlPayload(existing.confirmedBaseUrls)) && !sameRecord(env.baseUrls, existing.confirmedBaseUrls)) {
        existing.baseUrls = { ...env.baseUrls };
      }
      existing.confirmedVariables = { ...env.variables };
      existing.confirmedBaseUrls = { ...env.baseUrls };
      continue;
    }
    projectDraft.environments.set(env.id, {
      name: env.name,
      rows: recordToRows(env.variables),
      baseUrls: { ...env.baseUrls },
      confirmedVariables: { ...env.variables },
      confirmedBaseUrls: { ...env.baseUrls },
      feedback: newFeedback(),
    });
  }
  for (const id of projectDraft.environments.keys()) {
    if (!props.envs.envs.some((env) => env.id === id) && !projectDraft.environments.get(id)?.feedback.conflict) projectDraft.environments.delete(id);
  }
}

watch([projectKey, () => props.reviewMissingProject], () => {
  pane.value = "gvars";
  if (props.reviewMissingProject) {
    const draft = scope.value;
    if (draft?.variableFeedback.conflict) return;
    if (draft?.parameterFeedback.conflict) pane.value = "gparams";
    else pane.value = environmentList.value[0]?.id ?? "gvars";
    return;
  }
  void loadEnvs();
}, { immediate: true });
watch([contextReady, () => props.envs.loadedRevision], syncDrafts, { immediate: true });
watch([contextReady, () => props.envs.selectedEnvId, () => props.envs.loadedRevision], ([ready, id]) => {
  if (!ready || props.reviewMissingProject) return;
  const saved = scope.value?.pane;
  const requested = saved ?? id;
  if (requested === "gparams" || requested === "gvars" || environmentList.value.some(env => env.id === requested)) pane.value = requested!;
  else {
    pane.value = "gvars";
    if (saved && scope.value) { scope.value.pane = "gvars"; loadError.value = t("workbenchPosition.unavailable"); }
  }
}, { immediate: true });

function selectEnvironment(env: EnvItem) {
  pane.value = env.id;
  if (scope.value) scope.value.pane = env.id;
  if (!props.reviewMissingProject) props.envs.select(env.locator);
}

function selectGlobalPane(next: "gvars" | "gparams") {
  pane.value = next;
  if (scope.value) scope.value.pane = next;
  if (!props.reviewMissingProject) props.envs.select(null);
}

function resolveEnvironmentConflict(conflict: DiskDraftConflict, event: Event) {
  const oldPane = pane.value;
  const key = projectKey.value;
  props.resolveDiskConflict?.({ ...conflict, restore: () => {
    conflict.restore?.();
    if (conflict.reason === "deleted" && key === projectKey.value && oldPane === pane.value) selectGlobalPane("gvars");
  } }, event);
}

const activeDraft = computed(() => {
  const draft = scope.value;
  if (!draft) return null;
  if (pane.value === "gvars") return {
    feedback: draft.variableFeedback,
    dirty: !sameRecord(variablePayload(draft.variableRows), normalizedVariables(draft.globals.variables)),
    title: t("env.globalVars"), saveLabel: t("env.saveVars"), testId: "env-global-vars-save", savedId: "env-global-vars-saved",
  };
  if (pane.value === "gparams") return {
    feedback: draft.parameterFeedback,
    dirty: !sameParams(parameterPayload(draft.queryRows), parameterPayload(draft.globals.query))
      || !sameParams(parameterPayload(draft.headerRows), parameterPayload(draft.globals.headers)),
    title: t("env.globalParams"), saveLabel: t("env.saveParams"), testId: "env-global-params-save", savedId: "env-global-params-saved",
  };
  const env = environmentDraft.value;
  return env && {
    feedback: env.feedback,
    dirty: !sameRecord(variablePayload(env.rows), normalizedVariables(env.confirmedVariables))
      || !sameRecord(baseUrlPayload(env.baseUrls), baseUrlPayload(env.confirmedBaseUrls)),
    title: currentEnvironment.value!.name, saveLabel: t("env.saveEnvironment"), testId: "env-vars-save", savedId: "env-vars-saved",
  };
});
const globalsSaving = computed(() => !!(scope.value?.variableFeedback.pending || scope.value?.parameterFeedback.pending));
const diskPending = computed(() => props.workspace.hasPendingDiskRefresh?.() ?? false);
const saveDisabled = computed(() => environmentReadOnly.value || diskPending.value || !!activeDraft.value?.feedback.pending || !!activeDraft.value?.feedback.conflict
  || ((pane.value === "gvars" || pane.value === "gparams") && globalsSaving.value));
const statusText = computed(() => {
  const draft = activeDraft.value;
  if (!draft) return "";
  if (environmentReadOnly.value) return t("workspace.readonlyBadge");
  if (draft.feedback.pending) return t("env.saving");
  if ((pane.value === "gvars" || pane.value === "gparams") && globalsSaving.value) return t("env.savingGlobals");
  if (draft.dirty) return t("env.unsaved");
  if (draft.feedback.error) return t("env.noChanges");
  return t(draft.feedback.saved ? "env.saved" : "env.noChanges");
});
const failureText = computed(() => {
  const failure = activeDraft.value?.feedback.error;
  if (!failure) return "";
  const keys = {
    globals: "env.saveFailed",
    variables: "env.saveVariablesFailed",
    baseUrls: "env.saveBaseUrlsFailed",
    interrupted: "env.baseUrlsPending",
  } as const;
  const typed = activeDraft.value?.feedback.failure;
  return t(keys[failure.step], { error: typed ? t(`diskRefresh.error.${typed.reason}`) : failure.message });
});

function errorMessage(error: unknown) {
  return diskErrorMessage(error, t);
}

const detail = ref<HTMLElement>();
function addVariable(rows: VarRow[]) {
  const id = crypto.randomUUID();
  rows.push({ id, key: "", value: "" });
  void nextTick(() => detail.value?.querySelector<HTMLInputElement>(`[data-row-id="${id}"] input`)?.focus());
}

function addParameter(rows: ParamRow[]) {
  rows.push({ id: crypto.randomUUID(), key: "", value: "", enabled: true });
}

function beginSave(feedback: SaveFeedback) {
  feedback.pending = true;
  feedback.saved = false;
  feedback.error = null;
  feedback.failure = undefined;
}

async function saveGlobalDraft(root: string, locator: ProjectLocator, draft: ProjectDraft, variables: boolean) {
  if (globalsSaving.value || !contextIsCurrent(root, locator)) return;
  const feedback = variables ? draft.variableFeedback : draft.parameterFeedback;
  const baseline = jsonCopy(draft.latestGlobals);
  const payload = variables
    ? { ...baseline, variables: variablePayload(draft.variableRows) }
    : { ...baseline, query: parameterPayload(draft.queryRows), headers: parameterPayload(draft.headerRows) };
  beginSave(feedback);
  try {
    const confirmed = await props.envs.saveGlobals(locator, payload);
    draft.latestGlobals = confirmed;
    draft.globals = variables ? { ...draft.globals, variables: confirmed.variables } : { ...draft.globals, query: confirmed.query, headers: confirmed.headers };
    feedback.saved = true;
  } catch (error) {
    feedback.error = { step: "globals", message: errorMessage(error) };
    if (error instanceof LocalWorkspaceError) feedback.failure = error.failure;
  } finally {
    feedback.pending = false;
  }
}

async function saveEnvironmentDraft(root: string, locator: EnvironmentLocator, draft: EnvironmentDraft) {
  const feedback = draft.feedback;
  if (feedback.pending || !contextIsCurrent(root, locator)) return;
  const variables = variablePayload(draft.rows);
  const baseUrls = baseUrlPayload(draft.baseUrls);
  const retryBaseUrls = draft.pendingBaseUrls && sameRecord(variables, normalizedVariables(draft.confirmedVariables));
  beginSave(feedback);
  let step: FailureStep = "variables";
  try {
    if (!retryBaseUrls) {
      draft.confirmedVariables = await props.envs.saveVars(locator, variables);
      draft.pendingBaseUrls = true;
    }
    if (!contextIsCurrent(root, locator) || diskPending.value) {
      feedback.error = { step: "interrupted", message: "" };
      return;
    }
    step = "baseUrls";
    draft.confirmedBaseUrls = await props.envs.saveBaseUrls(locator, baseUrls);
    draft.pendingBaseUrls = false;
    feedback.saved = true;
  } catch (error) {
    feedback.error = { step, message: errorMessage(error) };
    if (error instanceof LocalWorkspaceError) feedback.failure = error.failure;
  } finally {
    feedback.pending = false;
  }
}

function saveCurrentPane() {
  const root = props.workspace.root;
  const locator = props.projectLocator ? { ...props.projectLocator } : null;
  const draft = scope.value;
  if (saveDisabled.value || !locator || !draft) return;
  if (pane.value === "gvars" || pane.value === "gparams") {
    void saveGlobalDraft(root, locator, draft, pane.value === "gvars");
  } else if (currentEnvironment.value && environmentDraft.value) {
    void saveEnvironmentDraft(root, { ...currentEnvironment.value.locator }, environmentDraft.value);
  }
}

const modal = ref<{ mode: "new" | "derive"; name: string; parentId: string | undefined; root: string; locator: ProjectLocator } | null>(null);
const createItems = computed(() => [
  { key: "new", label: t("env.newEnvironment"), testId: "env-new" },
  {
    key: "derive",
    label: environmentList.value.length ? t("env.derive") : t("env.deriveNeedsParent"),
    testId: "env-derive",
    disabled: !environmentList.value.length,
  },
]);

function closeCreateModal() {
  modal.value = null;
  void nextTick(() => nav.value?.querySelector<HTMLButtonElement>('[data-testid="env-create-menu"]')?.focus({ preventScroll: true }));
}

function openModal(mode: string) {
  if (!props.projectLocator || !contextIsCurrent(props.workspace.root, props.projectLocator) || environmentReadOnly.value) return;
  if (mode !== "new" && mode !== "derive") return;
  if (mode === "derive" && !environmentList.value.length) return;
  modal.value = {
    mode,
    name: "",
    parentId: mode === "derive" ? environmentList.value[0]?.id : undefined,
    root: props.workspace.root,
    locator: { ...props.projectLocator },
  };
}

async function confirmModal() {
  const target = modal.value;
  if (!target || environmentReadOnly.value || !contextIsCurrent(target.root, target.locator)) return;
  const name = target.name.trim();
  if (!name) return;
  const parent = target.mode === "derive" ? environmentList.value.find((env) => env.id === target.parentId) : undefined;
  if (target.mode === "derive" && !parent) return;
  closeCreateModal();
  try {
    const env = await props.envs.create({ locator: target.locator, name, extends: parent?.name });
    const created = environmentList.value.find(item => item.id === env.id);
    if (created && contextIsCurrent(target.root, target.locator)) selectEnvironment(created);
  } catch (error) {
    if (contextIsCurrent(target.root, target.locator)) props.reportError(error);
  }
}

const deleteTarget = ref<{ root: string; locator: EnvironmentLocator; name: string } | null>(null);
const nav = ref<HTMLElement>();
let deleteTrigger: HTMLElement | undefined;

function openDelete(env: EnvItem) {
  if (!contextIsCurrent(props.workspace.root, env.locator)
    || environmentReadOnly.value || scope.value?.environments.get(env.id)?.feedback.pending) return;
  deleteTrigger = nav.value?.querySelector<HTMLElement>(`[data-environment-menu="${env.id}"]`) ?? undefined;
  deleteTarget.value = { root: props.workspace.root, locator: { ...env.locator }, name: env.name };
}

function restoreDeleteFocus() {
  const trigger = deleteTrigger;
  deleteTrigger = undefined;
  void nextTick(() => {
    const target = trigger?.isConnected ? trigger : nav.value?.querySelector<HTMLElement>("[aria-current='page']");
    target?.focus({ preventScroll: true });
  });
}

function cancelDelete() {
  deleteTarget.value = null;
  restoreDeleteFocus();
}

async function onDeleteConfirm() {
  const target = deleteTarget.value;
  deleteTarget.value = null;
  if (!target || environmentReadOnly.value || !contextIsCurrent(target.root, target.locator)
    || !environmentList.value.some((env) => env.id === target.locator.environmentId)
    || scope.value?.environments.get(target.locator.environmentId)?.feedback.pending) {
    restoreDeleteFocus();
    return;
  }
  try {
    await props.envs.remove(target.locator, async () => true, () => contextIsCurrent(target.root, target.locator));
    if (contextIsCurrent(target.root, target.locator) && pane.value === target.locator.environmentId) pane.value = "gvars";
  } catch (error) {
    if (contextIsCurrent(target.root, target.locator)) props.reportError(error);
  } finally {
    if (contextIsCurrent(target.root, target.locator)) restoreDeleteFocus();
  }
}

const okButtonProps = computed(() => ({ "data-testid": "env-modal-confirm", disabled: environmentReadOnly.value }));
const cancelButtonProps: Record<string, unknown> = { "data-testid": "env-modal-cancel" };
function rowActions(env: EnvItem) {
  const pending = scope.value?.environments.get(env.id)?.feedback.pending;
  return [{ key: "delete", label: t(pending ? "env.deleteAfterSave" : "tree.delete"), testId: "env-delete", disabled: pending, danger: true }];
}
</script>

<template>
  <section class="env-panel" data-testid="env-panel">
    <EmptyState v-if="!projectLocator" :text="t('env.empty')" />
    <div v-else class="layout">
      <aside ref="nav" class="side" :aria-label="t('env.navigation')">
        <h2 class="side-heading">{{ t("env.globalSection") }}</h2>
        <button type="button" class="side-item" :class="{ active: pane === 'gvars' }" :aria-current="pane === 'gvars' ? 'page' : undefined"
          data-testid="env-tab-globals-vars" @click="selectGlobalPane('gvars')">
          {{ t("env.globalVars") }}
        </button>
        <button type="button" class="side-item" :class="{ active: pane === 'gparams' }" :aria-current="pane === 'gparams' ? 'page' : undefined"
          data-testid="env-tab-globals-params" @click="selectGlobalPane('gparams')">
          {{ t("env.globalParams") }}
        </button>
        <div class="environment-heading">
          <h2 class="side-heading">{{ t("env.envSection") }}</h2>
          <ActionMenu test-id="env-create-menu" :label="t('env.createActions')" :items="createItems"
            :disabled="environmentReadOnly || !contextReady" @select="openModal">
            <PlusOutlined />
          </ActionMenu>
        </div>
        <div v-if="contextReady && !environmentList.length" class="side-empty">{{ t("env.noEnvironments") }}</div>
        <div v-for="env in environmentList" :key="env.id" class="environment-row" :class="{ active: pane === env.id }">
          <a-tooltip :title="env.name" :trigger="['hover', 'focus']" placement="right">
            <button type="button" class="side-item" :aria-current="pane === env.id ? 'page' : undefined"
              :data-testid="`env-item-${env.id}`" @click="selectEnvironment(env)">{{ env.name }}</button>
          </a-tooltip>
          <ActionMenu class="environment-menu" :test-id="`env-more-${env.id}`" :data-environment-menu="env.id"
            :label="t('env.rowActions', { name: env.name })" :items="rowActions(env)" :disabled="environmentReadOnly"
            @select="openDelete(env)">
            <EllipsisOutlined />
          </ActionMenu>
        </div>
      </aside>

      <div ref="detail" class="detail">
        <p v-if="loadError" class="failure" role="alert">{{ t("env.loadFailed", { error: loadError }) }}</p>
        <p v-else-if="!scope || !activeDraft" role="status">{{ t("env.loading") }}</p>
        <template v-else>
          <header class="pane-head">
            <p v-if="projectName" class="pane-context">{{ projectName }} / {{ t("nav.envs") }}</p>
            <div class="pane-summary">
              <h1 class="pane-title">{{ activeDraft.title }}</h1>
              <div class="pane-actions">
                <span
                  role="status" class="save-status"
                  :class="{ dirty: activeDraft.dirty, saved: activeDraft.feedback.saved && !activeDraft.dirty && !saveDisabled }"
                  :data-testid="activeDraft.feedback.saved && !activeDraft.dirty && !saveDisabled ? activeDraft.savedId : 'env-save-status'"
                >{{ statusText }}</span>
                <a-button size="small" type="primary" :data-testid="activeDraft.testId" :disabled="saveDisabled" @click="saveCurrentPane">
                  {{ activeDraft.saveLabel }}
                </a-button>
              </div>
            </div>
            <p v-if="failureText" class="failure" role="alert" data-testid="env-save-error">{{ failureText }}</p>
            <a-button v-if="activeDraft?.feedback.failure && refreshDisk && isRefreshableFailure(activeDraft.feedback.failure)"
              size="small" :disabled="diskPending" data-testid="env-refresh-disk" @click="refreshDisk">{{ t("diskRefresh.action") }}</a-button>
            <div v-if="activeDraft?.feedback.conflict" class="failure" role="alert" data-testid="env-disk-conflict">
              <span>{{ t(`diskRefresh.draft.${activeDraft.feedback.conflict.reason}`, { name: activeDraft.feedback.conflict.name }) }}</span>
              <a-button v-if="activeDraft.feedback.conflict.restore && resolveDiskConflict" size="small"
                @click="resolveEnvironmentConflict(activeDraft.feedback.conflict, $event)">{{ t(activeDraft.feedback.conflict.reason === "deleted" ? "diskRefresh.discardRemoved" : "diskRefresh.restore") }}</a-button>
            </div>
          </header>

          <div v-if="pane === 'gparams'" data-testid="env-pane-globals-params" class="pane-body">
            <section v-for="section in [{ id: 'query', label: t('env.queryParams'), rows: scope.queryRows },
              { id: 'header', label: t('env.headerParams'), rows: scope.headerRows }]" :key="section.id" class="table-section">
              <div class="section-head">
                <h2 :id="`env-${section.id}-title`">{{ section.label }}</h2>
                <a-button type="text" size="small" :disabled="environmentReadOnly" :data-testid="`env-global-${section.id}-add`" @click="addParameter(section.rows)">
                  <PlusOutlined /> {{ t("env.addParam") }}
                </a-button>
              </div>
              <div class="table-scroll" role="region" :aria-labelledby="`env-${section.id}-title`" tabindex="0">
                <table class="config-table" :data-testid="`env-global-${section.id}-table`">
                  <thead>
                    <tr><th scope="col" class="enabled-cell">{{ t("env.enabled") }}</th><th scope="col" class="name-cell">{{ t("env.paramName") }}</th>
                      <th scope="col">{{ t("env.varValue") }}</th><th scope="col" class="action-cell"><span class="visually-hidden">{{ t("env.actions") }}</span></th></tr>
                  </thead>
                  <tbody>
                    <tr v-if="!section.rows.length"><td colspan="4" class="table-empty">{{ t("env.noParams") }}</td></tr>
                    <tr v-for="(row, index) in section.rows" :key="row.id">
                      <td class="enabled-cell">
                        <a-checkbox v-model:checked="row.enabled" :aria-label="t('env.enabled')" :disabled="environmentReadOnly" :data-testid="`env-global-${section.id}-enabled`" />
                      </td>
                      <td>
                        <a-input v-model:value="row.key" :disabled="environmentReadOnly" :aria-label="t('env.paramName')"
                          :data-testid="`env-global-${section.id}-key`" :placeholder="t('env.paramName')" />
                      </td>
                      <td>
                        <a-input v-model:value="row.value" :disabled="environmentReadOnly" :aria-label="t('env.varValue')"
                          :data-testid="`env-global-${section.id}-value`" :placeholder="t('env.varValue')" />
                      </td>
                      <td class="action-cell">
                        <a-button type="text" size="small" danger :disabled="environmentReadOnly" :data-testid="`env-global-${section.id}-delete`"
                          :aria-label="t('tree.delete')" :title="t('tree.delete')" @click="section.rows.splice(index, 1)"><DeleteOutlined /></a-button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <div v-else class="pane-body" :data-testid="pane === 'gvars' ? 'env-pane-globals-vars' : 'env-pane-env'">
            <section v-if="environmentDraft" class="table-section">
              <div class="section-head"><h2 id="env-module-urls-title">{{ t("env.baseUrls") }}</h2></div>
              <div v-if="collections.length" class="table-scroll" role="region" aria-labelledby="env-module-urls-title" tabindex="0">
                <table class="config-table" data-testid="env-baseurls-table">
                  <thead><tr><th scope="col" class="name-cell">{{ t("env.module") }}</th><th scope="col">{{ t("env.baseUrl") }}</th></tr></thead>
                  <tbody>
                    <tr v-for="item in collections" :key="item.id">
                      <th scope="row">
                        <a-tooltip :title="item.name" :trigger="['hover', 'focus']">
                          <span class="module-name" tabindex="0">{{ item.name }}</span>
                        </a-tooltip>
                      </th>
                      <td>
                        <a-input v-model:value="environmentDraft.baseUrls[item.id]" data-testid="env-baseurl-input"
                          :data-collection-id="item.id" :aria-label="t('env.moduleBaseUrl', { name: item.name })"
                          :placeholder="t('env.baseUrlPlaceholder')" :disabled="environmentReadOnly" />
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <p v-else class="empty-copy">{{ t("env.noCollections") }}</p>
            </section>
            <section class="table-section">
              <div class="section-head" v-if="environmentDraft || variableRows.length">
                <h2 id="env-variable-title">{{ t(environmentDraft ? "env.envVars" : "env.globalVars") }}</h2>
                <a-button
                  size="small" type="text" :disabled="environmentReadOnly" :data-testid="`${variableTestPrefix}-add`"
                  @click="addVariable(variableRows)"
                ><PlusOutlined /> {{ t("env.addVar") }}</a-button>
              </div>
              <div v-if="variableRows.length" class="table-scroll" role="region" aria-labelledby="env-variable-title" tabindex="0">
                <table class="config-table" :data-testid="`${variableTestPrefix}-table`">
                  <thead><tr><th scope="col" class="name-cell">{{ t("env.varName") }}</th><th scope="col">{{ t("env.varValue") }}</th>
                    <th scope="col" class="action-cell"><span class="visually-hidden">{{ t("env.actions") }}</span></th></tr></thead>
                  <tbody>
                    <tr v-for="(row, index) in variableRows" :key="row.id" :data-row-id="row.id">
                      <td>
                        <a-input v-model:value="row.key" :aria-label="t('env.varName')" :disabled="environmentReadOnly"
                          :data-testid="`${variableTestPrefix}-key`" :placeholder="t('env.varName')" />
                      </td>
                      <td>
                        <a-input v-model:value="row.value" :aria-label="t('env.varValue')" :disabled="environmentReadOnly"
                          :data-testid="`${variableTestPrefix}-value`" :placeholder="t('env.varValue')" />
                      </td>
                      <td class="action-cell">
                        <a-button type="text" size="small" danger :disabled="environmentReadOnly" :data-testid="`${variableTestPrefix}-delete`"
                          :aria-label="t('tree.delete')" :title="t('tree.delete')" @click="variableRows.splice(index, 1)"><DeleteOutlined /></a-button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div v-else class="variables-empty">
                <p>{{ t(environmentDraft ? "env.noVariables" : "env.noGlobalVariables") }}</p>
                <a-button v-if="!environmentDraft" size="small" :disabled="environmentReadOnly" data-testid="env-global-var-add" @click="addVariable(variableRows)">
                  <PlusOutlined /> {{ t("env.addVar") }}
                </a-button>
              </div>
            </section>
          </div>
        </template>
      </div>
    </div>
    <a-modal
      v-if="modal" :open="true" :title="t(modal.mode === 'derive' ? 'env.derive' : 'env.newEnvironment')"
      :ok-text="t('common.confirm')" :cancel-text="t('common.cancel')" :ok-button-props="okButtonProps"
      :cancel-button-props="cancelButtonProps" :width="420" data-testid="env-modal"
      @ok="confirmModal" @cancel="closeCreateModal"
    >
      <a-input v-model:value="modal.name" data-testid="env-name-input" :placeholder="t('env.namePlaceholder')" :disabled="environmentReadOnly" />
      <a-select v-if="modal.mode === 'derive'" v-model:value="modal.parentId" class="parent-select"
        :options="environmentList.map((env) => ({ label: env.name, value: env.id }))"
        :placeholder="t('env.parent')" data-testid="env-parent-select" :disabled="environmentReadOnly" />
    </a-modal>
    <ConfirmDialog :open="deleteTarget !== null" :title="t('env.deleteConfirm', { name: deleteTarget?.name ?? '' })"
      @confirm="onDeleteConfirm" @cancel="cancelDelete" />
  </section>
</template>

<style scoped>
.env-panel {
  padding: 12px;
  min-width: 0;
  height: 100%;
  box-sizing: border-box;
  font-size: 13px;
  background: var(--panel);
  container-type: inline-size;
}
.layout { display: flex; gap: 12px; height: 100%; min-height: 0; }
.side, .detail {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: auto;
}
.side {
  box-sizing: border-box;
  flex: 0 0 205px;
  padding: 10px;
  background: var(--workbench-form-navigation);
}
.side-heading { margin: 0; padding: 4px 6px; font-size: 15px; }
.environment-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin: 8px 0 3px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}
.side-empty { padding: 4px 6px 4px 16px; color: var(--text-muted); }
.side-item {
  display: block;
  width: 100%;
  min-width: 0;
  min-height: 34px;
  padding: 5px 5px 5px 16px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: start;
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
  cursor: pointer;
}
.side-item:focus-visible { outline-offset: -2px; }
.side-item:hover, .environment-row:hover { background: var(--hover); }
.side-item.active, .environment-row.active {
  background: var(--workbench-form-selected);
  color: var(--accent);
  font-weight: 600;
}
.environment-row { display: flex; align-items: center; gap: 4px; border-radius: 6px; padding-inline-end: 3px; }
.environment-menu { opacity: 0; pointer-events: none; }
.environment-row:hover .environment-menu, .environment-row:focus-within .environment-menu,
.environment-menu[aria-expanded="true"] { opacity: 1; pointer-events: auto; }
@media (hover: none) { .environment-menu { opacity: 1; pointer-events: auto; } }

.detail {
  flex: 1;
  min-height: 0;
  padding: 0 20px 20px;
  background: var(--bg);
}
.pane-head {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 14px 0;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}
.pane-context { margin: 0 0 6px; color: var(--text-muted); overflow-wrap: anywhere; }
.pane-summary, .pane-actions, .section-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pane-summary, .section-head { justify-content: space-between; }
.pane-title { margin: 0; font-size: 22px; line-height: 1.4; overflow-wrap: anywhere; }
.pane-actions { margin-inline-start: auto; }
.save-status { color: var(--text-muted); }
.save-status.dirty::before {
  content: "";
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-inline-end: 6px;
  border-radius: 50%;
  background: var(--workbench-form-pending);
}
.save-status.saved { color: var(--pass); }
.failure { margin: 8px 0 0; color: var(--fail); overflow-wrap: anywhere; }
.pane-body { display: flex; flex-direction: column; gap: 22px; padding-top: 15px; }
.section-head { margin-bottom: 8px; }
.section-head h2 { margin: 0; font-weight: 600; font-size: 16px; }
.table-scroll {
  overflow: auto;
  scrollbar-color: var(--text-muted) var(--bg);
  border: 1px solid var(--border);
  border-radius: 7px;
}
.table-scroll:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.config-table { width: 100%; min-width: 380px; table-layout: fixed; border-collapse: collapse; }
.config-table th, .config-table td { padding: 5px 10px; text-align: start; }
.config-table thead th { background: var(--workbench-form-table-head); white-space: nowrap; }
.config-table tbody tr { border-top: 1px solid var(--border); }
.config-table tbody th { font-weight: 400; }
.config-table .name-cell { width: 32%; }
.config-table .enabled-cell { width: 64px; text-align: center; }
.config-table .action-cell { width: 48px; text-align: center; padding-inline: 4px; }
.module-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.config-table :deep(.ant-input) { min-width: 0; width: 100%; }
.empty-copy, .config-table .table-empty { color: var(--text-muted); padding: 10px; }
.variables-empty { text-align: center; padding: 24px 10px; color: var(--text-muted); }
.parent-select { margin-top: 8px; width: 100%; }
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
@container (max-width: 620px) {
  .layout { flex-direction: column; gap: 8px; }
  .side { flex: none; max-height: min(170px, 35vh); }
  .detail { padding-inline: 12px; }
}
@container (max-width: 400px) {
  .pane-actions { margin-inline-start: 0; }
  .config-table { min-width: 340px; }
}
</style>

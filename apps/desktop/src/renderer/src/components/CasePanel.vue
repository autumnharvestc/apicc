<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button as AButton, Input as AInput, Select as ASelect, Tooltip as ATooltip } from "ant-design-vue";
import { EllipsisOutlined, PlusOutlined } from "@ant-design/icons-vue";
import type { DatasetAsset, TestCase } from "@apicc/core";
import { ApiRequestSchema } from "@apicc/core/schema";
import type { useCasesStore } from "../stores/cases.js";
import type { CaseIdentity } from "../stores/cases.js";
import { isPersistedCase, type useDebugStore } from "../stores/debug.js";
import { debugEnvironmentSelection } from "../debugEnvironment.js";
import type { useEditorStore } from "../stores/editor.js";
import EmptyState from "./EmptyState.vue";
import AssertionEditor from "./AssertionEditor.vue";
import ExtractionEditor from "./ExtractionEditor.vue";
import ActionMenu from "./ActionMenu.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import type { AssertionOperatorDTO } from "../../../shared/testing.js";
import type { AiStore } from '../stores/ai.js';

const ATextarea = AInput.TextArea;

const props = defineProps<{
  editor: ReturnType<typeof useEditorStore>;
  cases: ReturnType<typeof useCasesStore>;
  /** 调试 store（M9-D 测试模块）：单条用例「运行」复用既有发送管线，结果共享上屏。 */
  debug?: ReturnType<typeof useDebugStore>;
  reportError?: (e: unknown) => void;
  readOnly?: boolean;
  operators?: AssertionOperatorDTO[];
  datasets?: DatasetAsset[];
  ai?: AiStore;
  workbench?: boolean;
  interfacePath?: string;
  canOperate?: () => boolean;
}>();
const emit = defineEmits<{ (e: "stress", caseId: string): void; (e: "show-result"): void }>();
const { t } = useI18n();
const overrideJson = ref("");
const overrideError = ref("");
const assertionError = ref("");
const assertionBasis = ref<'contract' | 'observation'>('contract');
const overrideBuffers = new Map<string, { text: string; error: string }>();
const observedBasis = computed(() => {
  const observation = props.ai?.assertionObservation, locator = props.editor.locator, testCase = selected.value;
  if (!observation || !locator || !testCase || !observation.isCurrent()) return undefined;
  const target = observation.target;
  return target.caseId === testCase.id && target.scope === testCase.scope
    && target.workspaceId === locator.workspaceId && target.groupId === locator.groupId && target.projectId === locator.projectId
    && target.collectionId === locator.collectionId && target.apiId === locator.apiId
    && target.folderIds.length === locator.folderIds.length && target.folderIds.every((id, index) => id === locator.folderIds[index]) ? observation.basis : undefined;
});
const extractionError = ref("");
const requestTab = computed(() => props.debug && props.editor.activeKey
  ? props.debug.requestTabForSession(props.editor.activeKey) : null);
const requestTabState = computed(() => requestTab.value && props.debug
  ? props.debug.requestTabState(requestTab.value) : null);
const environment = computed(() => props.workbench && props.debug
  ? debugEnvironmentSelection(props.editor, props.debug, requestTab.value) : null);
const session = computed(() => props.editor.activeKey ? props.editor.sessions[props.editor.activeKey] : undefined);
const validationError = computed(() => overrideError.value || assertionError.value || extractionError.value);
const saving = ref(new Set<string>());
const saveError = ref("");
const contextKey = computed(() => JSON.stringify([props.editor.activeKey, session.value?.generation]));
const savingCurrent = computed(() => saving.value.has(contextKey.value));
function overrideKey(identity: CaseIdentity) {
  return JSON.stringify([contextKey.value, identity.caseId, identity.scope]);
}

// scope 可选项 = base + 当前接口所属项目的环境名列表（editor.envs，取 name）。
const scopeOptions = computed(() => [
  { label: t("testWorkbench.baseCase"), value: "base" },
  ...props.editor.envs.map((e) => ({ label: e.name, value: e.name })),
]);

// 选中用例：store 未选中/悬空（如刚切换接口）时回退第一个，保证面板始终有编辑目标。
const selected = computed(() => {
  const list = props.editor.api?.cases ?? [];
  const identity = requestTabState.value ? requestTabState.value.selectedCase : props.cases.selectedCase;
  return list.find((c) => c.id === identity?.caseId && c.scope === identity.scope) ?? list[0] ?? null;
});
const selectedDatasetId = computed(() => {
  const driver = selected.value?.dataDriver;
  return driver && 'kind' in driver ? driver.datasetId : null;
});
const selectedRun = computed(() => props.debug && selected.value && props.debug.caseRunFor(props.editor, identityOf(selected.value)));
const busy = computed(() => !!(requestTabState.value ? requestTabState.value.sending || requestTabState.value.starting
  : props.debug?.sending || props.debug?.starting));
const runReason = computed(() => selected.value ? unavailableRunReason(selected.value) : "");

function identityOf(testCase: TestCase): CaseIdentity {
  return { caseId: testCase.id, scope: testCase.scope };
}

function unavailableRunReason(testCase: TestCase): string {
  if (savingCurrent.value) return t("testWorkbench.saving");
  if (props.debug?.caseRunFor(props.editor, identityOf(testCase))?.pending) return t("testWorkbench.running");
  if (busy.value) return t("testWorkbench.otherRun");
  if ((testCase === selected.value && validationError.value) || overrideBuffers.get(overrideKey(identityOf(testCase)))?.error) {
    return t("testWorkbench.fixValidation");
  }
  if (!session.value || !isPersistedCase(session.value, identityOf(testCase))) return t("testWorkbench.saveToRun");
  if (environment.value?.value && !environment.value.options.some((option) => option.key === environment.value!.value)) {
    return t("environmentShortcut.unavailable");
  }
  if (environment.value && !environment.value.value && testCase.scope !== "base") return t("testWorkbench.scopeUnavailable");
  return "";
}

function scopeLabel(scope: string) {
  return scope === "base" ? t("testWorkbench.baseCase") : scope;
}

function selectCase(caseId: string, scope: string) {
  props.cases.select(caseId, scope);
  if (requestTabState.value) requestTabState.value.selectedCase = { caseId, scope };
}

watch(() => [contextKey.value, selected.value?.id, selected.value?.scope], () => {
  const buffer = selected.value ? overrideBuffers.get(overrideKey(identityOf(selected.value))) : undefined;
  overrideJson.value = buffer?.text ?? (selected.value?.requestOverride ? JSON.stringify(selected.value.requestOverride, null, 2) : "");
  overrideError.value = buffer?.error ?? "";
  assertionError.value = "";
  extractionError.value = "";
  saveError.value = "";
}, { immediate: true });

const editorRoot = ref<HTMLElement>();
function addCase() {
  if (props.readOnly) return;
  const created = props.cases.addCase({ name: t("case.new"), scope: "base" });
  selectCase(created.id, created.scope);
  if (props.workbench) void nextTick(() => editorRoot.value?.querySelector<HTMLInputElement>('[data-testid="case-name"]')?.focus());
}

function setCaseName(testCase: TestCase, name: string) {
  if (!props.readOnly) testCase.name = name;
}

/** 单条用例运行（M9-D）：存编辑缓冲后按该用例发送（结果经共享 debug store 上屏）。 */
async function runCase(identity: CaseIdentity) {
  if (!props.debug || props.canOperate?.() === false) return;
  const active = props.editor.api?.cases.find((item) => item.id === identity.caseId && item.scope === identity.scope);
  if (props.workbench && (!active || unavailableRunReason(active))) return;
  try {
    // debug.send captures the complete editor/root identity before its own save await.
    await props.debug.runCase(props.editor, { caseId: identity.caseId, scope: identity.scope });
  } catch (e) {
    props.reportError?.(e);
  }
}

// 保存链路收口（任务 8 补课）：拒绝经可选 reportError 转报，不再作为未处理 rejection 静默吞没。
async function saveCases() {
  if (props.readOnly || !selected.value || savingCurrent.value || props.canOperate?.() === false) return;
  if (validationError.value) {
    props.reportError?.(new Error(validationError.value));
    return;
  }
  const key = contextKey.value;
  const identity = identityOf(selected.value);
  props.cases.select(identity.caseId, identity.scope);
  saving.value.add(key);
  saveError.value = "";
  try {
    await props.cases.save();
  } catch (e) {
    if (key === contextKey.value && selected.value?.id === identity.caseId && selected.value.scope === identity.scope) {
      saveError.value = e instanceof Error ? e.message : String(e);
      props.reportError?.(e);
    }
  } finally {
    saving.value.delete(key);
  }
}

function inheritDefaultRequest() {
  if (props.readOnly || !selected.value) return;
  overrideBuffers.delete(overrideKey(identityOf(selected.value)));
  delete selected.value.requestOverride;
  props.cases.clearRequestRestoreFields({ caseId: selected.value.id, scope: selected.value.scope });
  overrideJson.value = "";
  overrideError.value = "";
}

function copyDefaultRequest() {
  if (props.readOnly || !selected.value || !props.editor.api) return;
  overrideBuffers.delete(overrideKey(identityOf(selected.value)));
  selected.value.requestOverride = JSON.parse(JSON.stringify(props.editor.api.contract.request));
  overrideJson.value = JSON.stringify(selected.value.requestOverride, null, 2);
  overrideError.value = "";
}

function applyCurrentDebugDraft() {
  if (props.readOnly || !selected.value || !props.editor.api || !props.debug) return;
  const sessionKey = props.editor.activeKey;
  if (!sessionKey) return;
  const session = props.editor.sessions[sessionKey];
  if (!session) return;
  const identity = { caseId: selected.value.id, scope: selected.value.scope };
  const persisted = (JSON.parse(session.snapshot) as typeof props.editor.api).cases.some((testCase) =>
    testCase.id === identity.caseId && testCase.scope === identity.scope);
  if (persisted && !window.confirm(t("debugLoop.applyDraftConfirm", { name: selected.value.name, scope: selected.value.scope }))) return;
  overrideBuffers.delete(overrideKey(identity));
  const restore = props.debug.restoreForSession(sessionKey, session.generation);
  const request = JSON.parse(JSON.stringify(props.editor.api.contract.request)) as typeof props.editor.api.contract.request;
  const fields = restore?.fields.map((field) => ({ ...field })) ?? [];
  const originalValues = restore ? { ...restore.originalValues } : {};
  selected.value.requestOverride = request;
  selected.value.parameters = restore ? { ...restore.parameters } : {};
  const settings = requestTabState.value?.settings ?? props.debug.settings;
  if (Object.keys(settings).length > 0) selected.value.requestSettingsOverride = { ...settings };
  else delete selected.value.requestSettingsOverride;
  props.cases.setPendingRestoreFields(identity, fields, originalValues);
  overrideJson.value = JSON.stringify(request, null, 2);
  overrideError.value = "";
}

function updateRequestOverride(value: string) {
  overrideJson.value = value;
  if (!selected.value) return;
  const key = overrideKey(identityOf(selected.value));
  try {
    if (!value.trim()) throw new Error(t("testWorkbench.emptyOverride"));
    const parsed = ApiRequestSchema.parse(JSON.parse(value));
    if (parsed.protocol !== props.editor.api?.contract.request.protocol) throw new Error("用例请求覆盖必须与接口协议一致");
    selected.value.requestOverride = parsed;
    overrideError.value = "";
    overrideBuffers.delete(key);
  } catch (error) {
    overrideError.value = error instanceof Error ? error.message : String(error);
    overrideBuffers.set(key, { text: value, error: overrideError.value });
  }
}

function removeSelected() {
  if (!props.readOnly && selected.value) props.cases.removeCase(selected.value.id, selected.value.scope);
}

function updateScope(testCase: TestCase, scope: string) {
  if (props.readOnly) return;
  try {
    const previous = overrideKey(identityOf(testCase));
    if (props.cases.changeScope(testCase.id, testCase.scope, scope)) {
      const buffer = overrideBuffers.get(previous);
      if (buffer) {
        overrideBuffers.delete(previous);
        overrideBuffers.set(overrideKey({ caseId: testCase.id, scope }), buffer);
      }
      selectCase(testCase.id, scope);
    }
  } catch (error) {
    props.reportError?.(error);
  }
}

const deleteTarget = ref<{ key: string; identity: CaseIdentity; name: string } | null>(null);
function caseActions(testCase: TestCase) {
  const reason = unavailableRunReason(testCase);
  return [
    { key: "run", label: reason ? t("testWorkbench.unavailableRun", { reason }) : t("case.run"), testId: "case-menu-run", disabled: !!reason },
    { key: "stress", label: t("case.stress"), testId: "case-menu-stress" },
    { key: "edit", label: t("tree.rename"), disabled: props.readOnly },
    { key: "delete", label: t("case.remove"), testId: "case-menu-delete", disabled: props.readOnly || (props.editor.api?.cases.length ?? 0) <= 1, danger: true },
  ];
}

function onCaseAction(action: string, testCase: TestCase) {
  const identity = identityOf(testCase);
  if (action === "run") {
    if (unavailableRunReason(testCase)) return;
    selectCase(identity.caseId, identity.scope);
    void runCase(identity);
  } else if (action === "stress") emit("stress", identity.caseId);
  else if (!props.readOnly && action === "edit") {
    selectCase(identity.caseId, identity.scope);
    void nextTick(() => editorRoot.value?.querySelector<HTMLInputElement>('[data-testid="case-name"]')?.focus());
  } else if (!props.readOnly && action === "delete") {
    deleteTarget.value = { key: contextKey.value, identity, name: testCase.name };
  }
}

function finishDelete(confirmed: boolean) {
  const target = deleteTarget.value;
  deleteTarget.value = null;
  if (!target || target.key !== contextKey.value) return;
  if (confirmed && !props.readOnly) {
    props.cases.removeCase(target.identity.caseId, target.identity.scope);
    overrideBuffers.delete(overrideKey(target.identity));
    if (selected.value) selectCase(selected.value.id, selected.value.scope);
  }
  void nextTick(() => {
    const element = editorRoot.value?.querySelector<HTMLElement>(confirmed
      ? ".case-choice[aria-current='true']"
      : `[data-testid="${caseMenuId(target.identity)}"]`);
    element?.focus({ preventScroll: true });
  });
}

function caseMenuId(identity: CaseIdentity) {
  return `case-more-${encodeURIComponent(JSON.stringify([identity.caseId, identity.scope]))}`;
}

function addAssertion() {
  if (props.readOnly || (selected.value?.assertions.length ?? 0) >= 256) return;
  selected.value?.assertions.push({ id: crypto.randomUUID(), target: "status", op: "eq", expected: "" });
}

function setTags(value: string) { if (!props.readOnly && selected.value) selected.value.tags = value.split(',').map(item => item.trim()).filter(Boolean); }
function dataDriver(value: string) {
  if (props.readOnly || !selected.value) return;
  if (value === 'none') delete selected.value.dataDriver;
  else if (value === 'file') selected.value.dataDriver = { sourcePath: '', format: 'csv' };
  else selected.value.dataDriver = { kind: 'dataset', datasetId: value };
}
function fileDriver(field: 'sourcePath' | 'format', value: string) {
  const driver = selected.value?.dataDriver;
  if (!props.readOnly && driver && !('kind' in driver)) Object.assign(driver, { [field]: value });
}

// —— M10 操作列表：增删/排序（数组不存在时先初始化——旧数据兼容） ——
type CaseOperation = NonNullable<TestCase["preOperations"]>[number];

function opsList(kind: "pre" | "post"): CaseOperation[] {
  const target = selected.value!;
  if (kind === "pre") {
    target.preOperations ??= [];
    return target.preOperations;
  }
  target.postOperations ??= [];
  return target.postOperations;
}

function addOp(kind: "pre" | "post") {
  if (props.readOnly) return;
  opsList(kind).push({ id: crypto.randomUUID(), type: "script", content: "" });
}

function moveOp(kind: "pre" | "post", index: number, delta: -1 | 1) {
  if (props.readOnly) return;
  const list = opsList(kind);
  const target = index + delta;
  if (target < 0 || target >= list.length) return;
  const [item] = list.splice(index, 1);
  list.splice(target, 0, item!);
}

function setOperationContent(op: CaseOperation, content: string) {
  if (!props.readOnly) op.content = content;
}

function removeOp(kind: "pre" | "post", index: number) {
  if (!props.readOnly) opsList(kind).splice(index, 1);
}
</script>

<template>
  <section ref="editorRoot" class="case-panel" :class="{ 'case-workbench': workbench }" data-testid="case-panel">
    <EmptyState v-if="!editor.api" :text="t('case.empty')" />
    <template v-else>
      <header v-if="workbench" class="test-case-head">
        <p v-if="interfacePath" class="interface-path">{{ interfacePath }}</p>
        <div class="interface-summary">
          <h1>{{ editor.api.contract.metadata.name }}</h1>
          <div v-if="selected && debug" class="toolbar case-toolbar">
            <span v-if="runReason" class="run-reason" role="status">{{ runReason }}</span>
            <a-button v-if="selectedRun && (selectedRun.result || selectedRun.error)" size="small" data-testid="case-show-result" @click="emit('show-result')">
              {{ t("testWorkbench.showResult") }}
            </a-button>
            <a-button size="small" :data-testid="`case-run-${selected.id}`" :data-case-id="selected.id"
              :disabled="!!runReason" @click="runCase(identityOf(selected))">{{ t("case.run") }}</a-button>
            <a-button size="small" :data-testid="`case-stress-${selected.id}`" :data-case-id="selected.id"
              @click="emit('stress', selected.id)">{{ t("case.stress") }}</a-button>
            <a-button size="small" type="primary" data-testid="case-save" :disabled="readOnly || savingCurrent"
              @click="saveCases">{{ t("case.save") }}</a-button>
          </div>
        </div>
        <div v-if="environment" class="runtime-environment">
          <label>{{ t("testWorkbench.runEnvironment") }}
            <select :key="environment.owner" :value="environment.value ?? ''"
              data-testid="case-run-environment" @change="environment.select(($event.target as HTMLSelectElement).value || null)">
              <option value="">{{ t("testWorkbench.defaultEnvironment") }}</option>
              <option v-if="environment.value && !environment.options.some(option => option.key === environment?.value)" :value="environment.value" disabled>
                {{ t("environmentShortcut.unavailable") }}
              </option>
              <option v-for="option in environment.options" :key="option.key" :value="option.key">{{ option.name }}</option>
            </select>
          </label>
        </div>
        <p v-if="saveError" class="override-error" role="alert" data-testid="case-save-error">{{ saveError }}</p>
      </header>
      <div v-else class="toolbar">
        <a-button size="small" data-testid="case-add" :disabled="readOnly" @click="addCase">{{ t("case.add") }}</a-button>
        <a-button
          size="small"
          danger
          :disabled="readOnly || editor.api.cases.length <= 1"
          data-testid="case-delete"
          @click="removeSelected"
        >
          {{ t("case.remove") }}
        </a-button>
        <a-button size="small" type="primary" data-testid="case-save" :disabled="readOnly" @click="saveCases">{{ t("case.save") }}</a-button>
      </div>

      <div class="case-layout">
      <aside v-if="workbench" class="case-navigation" :aria-label="t('testWorkbench.caseList')">
        <a-button class="new-case" type="text" size="small" data-testid="case-add" :disabled="readOnly" @click="addCase">
          <PlusOutlined /> {{ t("testWorkbench.newCase") }}
        </a-button>
        <div class="case-navigation-list">
          <div v-for="c in editor.api.cases" :key="caseMenuId(identityOf(c))" class="case-row summary-row"
            :class="{ active: c.id === selected?.id && c.scope === selected?.scope }" data-testid="case-row">
            <a-tooltip :title="c.name" :trigger="['hover', 'focus']" placement="right">
              <button type="button" class="case-choice" :aria-current="c.id === selected?.id && c.scope === selected?.scope ? 'true' : undefined"
                @click="selectCase(c.id, c.scope)">
              <span class="case-choice-name">{{ c.name }}</span>
                <span class="case-choice-detail">
                  <span class="scope-label" :title="scopeLabel(c.scope)">{{ scopeLabel(c.scope) }}</span>
                  <span>{{ t("testWorkbench.assertionCount", c.assertions.length) }}</span>
                </span>
              </button>
            </a-tooltip>
            <ActionMenu class="case-more" :test-id="caseMenuId(identityOf(c))" :label="t('testWorkbench.caseActions', { name: c.name, scope: scopeLabel(c.scope) })"
              :items="caseActions(c)" @select="onCaseAction($event, c)"><EllipsisOutlined /></ActionMenu>
          </div>
        </div>
      </aside>
      <!-- Online and legacy consumers keep their inline case management. -->
      <div v-else class="case-list">
        <div
          v-for="c in editor.api.cases"
          :key="`${c.id}:${c.scope}`"
          class="case-row"
          :class="{ active: c.id === selected?.id && c.scope === selected?.scope }"
          data-testid="case-row"
          @click="selectCase(c.id, c.scope)"
        >
          <a-input :value="c.name" :title="c.name" :aria-label="t('tree.namePlaceholder')" :disabled="readOnly" class="case-name" data-testid="case-name" :placeholder="t('tree.namePlaceholder')" @update:value="(value) => setCaseName(c, value as string)" />
          <a-select :value="c.scope" :aria-label="t('case.scope')" :disabled="readOnly" class="scope-select" :options="scopeOptions" data-testid="case-scope" @update:value="(value) => updateScope(c, value as string)" />
          <span class="assert-count" :title="t('case.assertions')">{{ c.assertions.length }}</span>
          <a-button
            v-if="debug"
            size="small"
            type="text"
            :data-testid="`case-run-${c.id}`"
            :data-case-id="c.id"
            @click.stop="runCase({ caseId: c.id, scope: c.scope })"
          >
            {{ t("case.run") }}
          </a-button>
          <a-button
            v-if="debug"
            size="small"
            type="text"
            :data-testid="`case-stress-${c.id}`"
            :data-case-id="c.id"
            @click.stop="emit('stress', c.id)"
          >
            {{ t("case.stress") }}
          </a-button>
        </div>
      </div>

      <div class="case-editor">
      <div v-if="workbench && selected" class="selected-case-head">
        <h2>{{ selected.name }}</h2>
        <span class="scope-label">{{ scopeLabel(selected.scope) }}</span>
      </div>
      <div v-if="workbench && selected" class="case-identity-fields">
        <label>{{ t("testWorkbench.caseName") }}
          <a-input :value="selected.name" :disabled="readOnly" data-testid="case-name"
            @update:value="(value) => setCaseName(selected!, value as string)" />
        </label>
        <label>{{ t("testWorkbench.caseScope") }}
          <a-select :value="selected.scope" :disabled="readOnly" :options="scopeOptions" :aria-label="t('testWorkbench.caseScope')" data-testid="case-scope"
            @update:value="(value) => updateScope(selected!, value as string)" />
        </label>
      </div>
      <template v-if="selected">
        <section class="case-card case-data"><h3 v-if="!workbench">{{ t('testPresentation.caseSettings') }}</h3>
        <label>{{ t('testing.tags') }}<a-input :value="selected.tags?.join(', ')" :disabled="readOnly" @update:value="value => setTags(value ?? '')" /></label>
        <label>{{ t('testing.caseData') }}<select :value="!selected.dataDriver ? 'none' : selectedDatasetId ?? 'file'" :disabled="readOnly" @change="dataDriver(($event.target as HTMLSelectElement).value)"><option value="none">{{ t('testing.none') }}</option><option value="file">{{ t('testing.externalFile') }}</option><option v-for="dataset in datasets" :key="dataset.id" :value="dataset.id">{{ dataset.name }}</option><option v-if="selectedDatasetId && !datasets?.some(item => item.id === selectedDatasetId)" :value="selectedDatasetId">{{ selectedDatasetId }}</option></select></label>
        <div v-if="selected.dataDriver && !('kind' in selected.dataDriver)"><input :value="selected.dataDriver.sourcePath" :disabled="readOnly" :aria-label="t('testing.externalFile')" @input="fileDriver('sourcePath',($event.target as HTMLInputElement).value)" /><select :value="selected.dataDriver.format" :disabled="readOnly" @change="fileDriver('format',($event.target as HTMLSelectElement).value)"><option>csv</option><option>json</option></select><p class="note">{{ t('testing.externalFileHint') }}</p></div>
        </section>
        <section class="case-card case-request-override" data-testid="case-request-override">
          <div class="override-toolbar">
            <h3 class="section-title">{{ t("debugLoop.caseRequest") }}</h3>
            <span data-testid="case-request-mode">{{ selected.requestOverride ? t("debugLoop.requestOverride") : t("debugLoop.inheritRequest") }}</span>
            <a-button v-if="debug" size="small" :disabled="readOnly" data-testid="case-apply-debug-draft" @click="applyCurrentDebugDraft">{{ t("debugLoop.applyDebugDraft") }}</a-button>
            <a-button v-else size="small" :disabled="readOnly" data-testid="case-request-copy-default" @click="copyDefaultRequest">{{ t("debugLoop.copyDefaultRequest") }}</a-button>
            <a-button size="small" :disabled="readOnly || !selected.requestOverride" data-testid="case-request-inherit" @click="inheritDefaultRequest">{{ t("debugLoop.inheritRequest") }}</a-button>
          </div>
          <a-textarea v-if="selected.requestOverride" :value="overrideJson" :disabled="readOnly" :rows="8"
            :aria-label="t('debugLoop.caseRequest')" data-testid="case-request-override-json" @update:value="updateRequestOverride" />
          <span v-if="overrideError" class="override-error" role="alert" data-testid="case-request-override-error">{{ overrideError }}</span>
          <span class="note">{{ t("debugLoop.cookiesNotSavedWithCase") }}</span>
        </section>
        <section class="case-card">
        <div class="assertion-toolbar">
        <h3 class="section-title">{{ t("case.assertions") }}</h3>
        <template v-if="ai">
          <label>{{ t('ai.basis') }}
            <select v-model="assertionBasis" data-testid="ai-assertion-basis">
              <option value="contract">{{ t('ai.bases.contract') }}</option>
              <option value="observation" :disabled="!observedBasis">{{ t('ai.bases.observation') }}</option>
            </select>
          </label>
        </template>
        <a-button size="small" data-testid="assert-add" :disabled="readOnly || selected.assertions.length >= 256" @click="addAssertion">{{ t("case.addAssert") }}</a-button>
        <a-button v-if="ai" size="small" :disabled="readOnly || ai.suggestLoading || (assertionBasis === 'observation' && !observedBasis)" data-testid="ai-suggest-assertions" @click="ai.prepareAssertions({ caseId: selected.id, scope: selected.scope }, assertionBasis === 'observation' ? observedBasis : { kind: 'contract' })">{{ t('ai.suggestAssertions') }}</a-button>
        </div>
        <p v-if="ai?.assertionObservation">{{ t('ai.selectedObservationRow', { index: ai.assertionObservation.basis.caseIndex + 1 }) }}</p>
        <AssertionEditor :key="`${editor.activeKey}:${selected.id}:${selected.scope}:assertions`" :workbench="workbench" :assertions="selected.assertions" :read-only="readOnly" :operators="operators" @validity="message => assertionError = message" />
        </section>
        <section class="case-card">
        <ExtractionEditor :key="`${editor.activeKey}:${selected.id}:${selected.scope}:extractions`" :items="selected.extractors ?? (selected.extractors = [])" :read-only="readOnly" @validity="message => extractionError = message" />
        <p v-if="assertionError || extractionError" class="override-error" role="alert">{{ assertionError || extractionError }}</p>

        </section>

        <!-- M10：前置/后置操作（有序脚本操作列表；legacy preScript/postScript 保留只读迁移提示） -->
        <div class="scripts">
          <details :open="workbench ? undefined : true" class="case-card script-row">
            <summary>{{ t("container.preOperations") }} <span>{{ t("testWorkbench.operationCount", selected.preOperations?.length ?? 0) }}</span></summary>
            <div class="ops-list" data-testid="case-pre-ops">
              <div v-for="(op, index) in selected.preOperations ?? []" :key="op.id" class="op-row">
                <div class="op-btns">
                  <a-button size="small" type="text" :disabled="readOnly || index === 0" @click="moveOp('pre', index, -1)" :title="t('testPresentation.operationUp', { index: index + 1 })" :aria-label="t('testPresentation.operationUp', { index: index + 1 })">↑</a-button>
                  <a-button size="small" type="text" :disabled="readOnly || index === (selected!.preOperations?.length ?? 0) - 1" @click="moveOp('pre', index, 1)" :title="t('testPresentation.operationDown', { index: index + 1 })" :aria-label="t('testPresentation.operationDown', { index: index + 1 })">↓</a-button>
                  <a-button size="small" danger type="text" data-testid="case-op-delete" :disabled="readOnly" @click="removeOp('pre', index)" :title="t('testPresentation.operationDelete', { index: index + 1 })" :aria-label="t('testPresentation.operationDelete', { index: index + 1 })">×</a-button>
                </div>
                <a-textarea :value="op.content" :aria-label="t('testPresentation.operationContent', { index: index + 1 })" :disabled="readOnly" :rows="3" class="script-text" data-testid="case-op-content" @update:value="(v) => setOperationContent(op, v as string)" />
              </div>
              <a-button size="small" data-testid="case-pre-op-add" :disabled="readOnly" @click="addOp('pre')">{{ t("container.addOperation") }}</a-button>
            </div>
          </details>
          <details :open="workbench ? undefined : true" class="case-card script-row">
            <summary>{{ t("container.postOperations") }} <span>{{ t("testWorkbench.operationCount", selected.postOperations?.length ?? 0) }}</span></summary>
            <div class="ops-list" data-testid="case-post-ops">
              <div v-for="(op, index) in selected.postOperations ?? []" :key="op.id" class="op-row">
                <div class="op-btns">
                  <a-button size="small" type="text" :disabled="readOnly || index === 0" @click="moveOp('post', index, -1)" :title="t('testPresentation.operationUp', { index: index + 1 })" :aria-label="t('testPresentation.operationUp', { index: index + 1 })">↑</a-button>
                  <a-button size="small" type="text" :disabled="readOnly || index === (selected!.postOperations?.length ?? 0) - 1" @click="moveOp('post', index, 1)" :title="t('testPresentation.operationDown', { index: index + 1 })" :aria-label="t('testPresentation.operationDown', { index: index + 1 })">↓</a-button>
                  <a-button size="small" danger type="text" data-testid="case-op-delete" :disabled="readOnly" @click="removeOp('post', index)" :title="t('testPresentation.operationDelete', { index: index + 1 })" :aria-label="t('testPresentation.operationDelete', { index: index + 1 })">×</a-button>
                </div>
                <a-textarea :value="op.content" :aria-label="t('testPresentation.operationContent', { index: index + 1 })" :disabled="readOnly" :rows="3" class="script-text" data-testid="case-op-content" @update:value="(v) => setOperationContent(op, v as string)" />
              </div>
              <a-button size="small" data-testid="case-post-op-add" :disabled="readOnly" @click="addOp('post')">{{ t("container.addOperation") }}</a-button>
            </div>
          </details>
        </div>
      </template>
      <slot name="after-cases" />
      </div>
      </div>
      <ConfirmDialog v-if="workbench" :open="deleteTarget !== null" :title="t('testWorkbench.deleteCase', { name: deleteTarget?.name ?? '' })"
        @cancel="finishDelete(false)" @confirm="finishDelete(true)" />
    </template>
  </section>
</template>

<style scoped src="../styles/editor-controls.css"></style>
<style scoped>
.case-panel { padding: 16px; font-size: 13px; display: flex; flex-direction: column; gap: 16px; min-width: 0; box-sizing: border-box; }
.case-layout, .case-editor { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.toolbar { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 0; background: var(--bg); border-bottom: 1px solid var(--border); }
.case-list { display: flex; flex-direction: column; gap: 6px; }
.case-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; cursor: pointer; }
.case-row.active { border-color: var(--accent); background: var(--active-weak); }
.case-name { flex: 1 1 180px; min-width: 0; }.scope-select { width: 140px; max-width: 100%; }.assert-count { min-width: 24px; text-align: center; color: var(--text-muted); }
.case-card { min-width: 0; padding: 16px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg); box-shadow: var(--panel-shadow); }
h3, .section-title { font-size: 14px; font-weight: 600; margin: 0 0 12px; }
.case-data { display: flex; flex-wrap: wrap; gap: 12px; }.case-data h3 { flex-basis: 100%; margin-bottom: 0; }.case-data label { flex: 1 1 180px; min-width: 0; display: flex; flex-direction: column; gap: 6px; }.case-data > div { flex-basis: 100%; }
.case-request-override { display: flex; flex-direction: column; gap: 8px; }.override-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }.override-toolbar span { flex: 1 1 180px; }.override-error { display: block; color: var(--fail); overflow-wrap: anywhere; }.note { color: var(--text-muted); font-size: 12px; line-height: 1.6; }
.scripts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr)); gap: 16px; }.ops-list { display: flex; flex-direction: column; gap: 12px; min-width: 0; }.op-row { display: flex; gap: 8px; align-items: flex-start; min-width: 0; }.op-btns { display: flex; flex-direction: column; flex: none; }.script-text { flex: 1; min-width: 0; font-family: ui-monospace, monospace; resize: vertical; }
summary { font-weight: 600; cursor: pointer; }
summary span { margin-inline-start: 8px; color: var(--text-muted); font-weight: 400; }
details[open] summary { margin-bottom: 12px; }

.case-workbench { height: 100%; padding: 0; gap: 0; overflow: hidden; }
.test-case-head { flex: none; padding: 12px 18px; border-bottom: 1px solid var(--border); }
.interface-path { margin: 0 0 6px; color: var(--text-muted); overflow-wrap: anywhere; }
.interface-summary, .selected-case-head, .case-identity-fields { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.interface-summary h1 { flex: 1 1 180px; margin: 0; min-width: 0; font-size: 22px; overflow-wrap: anywhere; }
.case-toolbar { position: static; padding: 0; border: 0; margin-inline-start: auto; }
.run-reason { color: var(--text-muted); }
.runtime-environment { margin-top: 10px; }
.runtime-environment label { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-weight: 600; }
.runtime-environment select { max-width: 100%; }
.case-workbench .case-layout { display: grid; grid-template-columns: 205px minmax(0, 1fr); flex: 1; min-height: 0; gap: 0; }
.case-navigation { display: flex; flex-direction: column; min-height: 0; min-width: 0; background: var(--workbench-form-navigation); border-right: 1px solid var(--border); }
.new-case { flex: none; align-self: flex-start; margin: 10px 8px 6px; }
.case-navigation-list { overflow: auto; scrollbar-color: var(--text-muted) var(--workbench-form-navigation); }
.summary-row {
  min-width: 0; min-height: 54px; flex-wrap: nowrap; gap: 4px; margin: 0 6px 3px;
  padding: 0 4px 0 0; border: 0; border-inline-start: 3px solid transparent; border-radius: 5px;
}
.summary-row.active { border-color: var(--accent); background: var(--workbench-form-selected); }
.case-workbench .summary-row button.case-choice {
  min-width: 0; flex: 1; padding: 6px 8px; text-align: start;
  background: transparent; border: 0;
}
.case-choice-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.case-choice-detail { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; margin-top: 3px; font-size: 12px; color: var(--text-muted); }
.case-more { opacity: 0; pointer-events: none; }
.summary-row:hover .case-more, .summary-row:focus-within .case-more, .case-more[aria-expanded="true"] { opacity: 1; pointer-events: auto; }
@media (hover: none) { .case-more { opacity: 1; pointer-events: auto; } }
.case-workbench .case-editor { padding: 16px 18px; min-height: 0; gap: 0; overflow: auto; scrollbar-color: var(--text-muted) var(--bg); }
.selected-case-head h2 { margin: 0; font-size: 18px; overflow-wrap: anywhere; }
.scope-label { display: inline-block; max-width: 100%; padding: 1px 5px; border-radius: 4px; background: var(--workbench-form-selected); color: var(--accent); overflow-wrap: anywhere; }
.assertion-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
.assertion-toolbar .section-title, .override-toolbar .section-title { margin: 0; }
.assertion-toolbar label { display: flex; flex: 1 1 140px; align-items: center; gap: 6px; }
.case-workbench .override-toolbar span { flex-basis: 145px; }
.case-identity-fields { align-items: stretch; padding: 12px 0 0; }
.case-identity-fields label { display: grid; gap: 4px; flex: 1 1 145px; min-width: 0; color: var(--text-muted); }
.case-workbench .case-card { padding: 13px 0; border: 0; border-bottom: 1px solid var(--border); border-radius: 0; box-shadow: none; }
.case-workbench .case-data h3 { font-weight: 600; }
.case-workbench .scripts { grid-template-columns: 1fr; gap: 0; }
@container (max-width: 760px) {
  .case-workbench .case-layout { display: flex; overflow: auto; scrollbar-color: var(--text-muted) var(--bg); }
  .case-navigation { flex: 0 0 auto; border-right: 0; border-bottom: 1px solid var(--border); }
  .case-navigation-list { max-height: 135px; }
  .case-workbench .case-editor { overflow: visible; }
  .case-toolbar { margin-inline-start: 0; }
  .test-case-head, .case-workbench .case-editor { padding-inline: 12px; }
}
@container (max-width: 360px) {
  .test-case-head { padding-block: 8px; }
  .interface-summary h1 { font-size: 18px; }
}
</style>

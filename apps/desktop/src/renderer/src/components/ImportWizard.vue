<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Alert as AAlert, Button as AButton, Checkbox as ACheckbox, Input as AInput, Select as ASelect, Steps as ASteps, Tag as ATag, Tree as ATree } from "ant-design-vue";
import type { useImportWizardStore } from "../stores/importW.js";
import type { PluginsStore } from "../stores/plugins.js";
import type { CollectionLocator, GroupLocator, ProjectLocator } from "../../../shared/locations.js";

/**
 * 导入向导（antd a-steps 三步；轨二双模式）：① 选择文件——渲染层 input[type=file] 读文本，
 * 读出 content + fileName 进 preview；② 预览确认——a-tree 渲染项目结构 + 警告 a-alert +
 * 落点表单（按 mode 区分）；③ 完成——apply 落库 + workspace 刷新 + 成功态。
 * - mode="project"（主页入口）：「目标分组」下拉（按 id，默认分组默认选中）+「项目名」
 *   输入（预填文件 title 可改）——整项目落库（含 imported 环境）。
 * - mode="module"（接口模块头部入口）：无落点选择，仅「模块名」输入（预填 title 可改）——
 *   产物集合并入目标项目，baseUrl 写模块变量、不造环境。
 * 同名放开（轨二）：重名不拒绝，重复导入并存。
 * store 经 props 注入（组合根一次装配）；取消/完成向组合根发 close 事件。apply 拒绝时
 * 经 reportError 上报并留在第二步可重试；无法识别的格式经组件内错误提示留在第一步。
 * 导入格式清单（M7-B）：来自 plugins:list 出口的 importers，向导内零硬编码格式名。
 */
const props = defineProps<{
  importW: ReturnType<typeof useImportWizardStore>;
  plugins: PluginsStore;
  reportError: (e: unknown) => void;
  /** 落点模式：project=导入为项目（选分组）；module=并入指定项目（默认当前项目）。 */
  mode: "project" | "module";
  /** project 模式：分组及其完整位置。 */
  groups?: Array<{ locator: GroupLocator; label: string }>;
  defaultGroupLocator?: GroupLocator | null;
  /** module 模式：目标项目的完整位置。 */
  targetProjectLocator?: ProjectLocator | null;
  /** merge 模式只绑定当前已选模块，不提供跨项目选择。 */
  targetCollectionLocator?: CollectionLocator | null;
}>();
const emit = defineEmits<{ (e: "close"): void }>();
const { t } = useI18n();

const current = ref(0);
const targetName = ref("");
const groupValue = ref<string | undefined>(undefined);
const sourceEnvironmentOptionToken = ref<string | undefined>(undefined);
const stepError = ref("");
const curlText = ref("");
const mergeIntoExisting = ref(false);
const sourceCollectionIds = ref<string[]>([]);
const decisionActions = ref<Record<string, "skip" | "rename" | "overwrite" | "cancel">>({});
const targetApiDecisions = ref<Record<string, string>>({});
const overwriteConfirmed = ref(false);
const lossyConfirmed = ref(false);

const steps = computed(() => [
  { title: t("import.stepFile") },
  { title: t("import.stepPreview") },
  { title: t("import.stepDone") },
]);

const treeData = computed(() => {
  const preview = props.importW.preview;
  if (!preview) return [];
  return [{
    title: `${preview.summary.projectName}（${t("import.project")}）`,
    key: `project:${preview.token}`,
    children: preview.tree.map((collection) => ({
      title: `${collection.name}（${collection.apis.length} ${t("import.apiCount")}）`,
      key: `collection:${collection.id}`,
      children: collection.apis.map((api) => ({ title: `${api.method} ${api.name} — ${api.path}`, key: `api:${api.id}` })),
    })),
  }];
});

const sourceEnvironmentOptions = computed(() => (props.importW.preview?.summary.environments ?? []).map(({ label, optionToken }) => ({ label, value: optionToken })));
const sourceCollectionOptions = computed(() => (props.importW.preview?.tree ?? []).map((collection) => ({ label: collection.name, value: collection.id })));

const groupOptions = computed(() => (props.groups ?? []).map((g) => ({ label: g.label, value: JSON.stringify(g.locator) })));
const activeTarget = computed(() => selectedTarget());
const hasCurrentPlan = computed(() => Boolean(props.importW.plan && activeTarget.value && props.importW.planTargetKey === JSON.stringify(activeTarget.value)));
const warnings = computed(() => hasCurrentPlan.value && props.importW.plan
  ? props.importW.plan.diagnostics
  : props.importW.preview?.diagnostics ?? []);
const hasOverwrite = computed(() => props.importW.plan?.entries.some((entry) => decisionActions.value[entry.sourceApiId] === "overwrite") ?? false);

async function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // 复位以允许重复选择同一文件
  if (!file) return;
  const context = props.importW.capturePreviewContext();
  try {
    const content = await file.text();
    await previewSource(file.name, content, context);
  } catch (e) {
    if (props.importW.isPreviewContextCurrent(context)) {
      stepError.value = e instanceof Error ? e.message : String(e);
    }
  }
}

async function onCurlPreview() {
  const context = props.importW.capturePreviewContext();
  try {
    await previewSource("pasted.curl", curlText.value, context);
    curlText.value = "";
  } catch (e) {
    if (props.importW.isPreviewContextCurrent(context)) stepError.value = e instanceof Error ? e.message : String(e);
  }
}

async function previewSource(fileName: string, content: string, context: ReturnType<typeof props.importW.capturePreviewContext>) {
    await props.importW.previewFile(fileName, content, context);
    if (!props.importW.isPreviewContextCurrent(context)) return;
    // 预填可编辑名称：project=项目名 / module=模块名（均取文件 title）
    targetName.value = props.importW.preview?.summary.projectName ?? "";
    const sourceEnvironments = props.importW.preview?.summary.environments ?? [];
    sourceEnvironmentOptionToken.value = sourceEnvironments.length === 1 ? sourceEnvironments[0]!.optionToken : undefined;
    sourceCollectionIds.value = (props.importW.preview?.tree ?? []).map((collection) => collection.id);
    decisionActions.value = {};
    targetApiDecisions.value = {};
    mergeIntoExisting.value = false;
    overwriteConfirmed.value = false;
    lossyConfirmed.value = false;
    groupValue.value = props.defaultGroupLocator ? JSON.stringify(props.defaultGroupLocator)
      : props.groups?.[0] ? JSON.stringify(props.groups[0].locator) : undefined;
    stepError.value = "";
    current.value = 1;
}

function selectedTarget() {
  if (props.mode === "project") {
    if (!groupValue.value) return null;
    return { mode: "project" as const, target: JSON.parse(groupValue.value) as GroupLocator, name: targetName.value.trim() };
  }
  if (mergeIntoExisting.value) {
    if (!props.targetCollectionLocator || sourceCollectionIds.value.length === 0) return null;
    const decisions: Record<string, { action: "skip" | "rename" | "overwrite" | "cancel"; targetApiId?: string; name?: string }> = {};
    for (const [apiId, action] of Object.entries(decisionActions.value)) decisions[apiId] = {
      action,
      ...(targetApiDecisions.value[apiId] === undefined ? {} : { targetApiId: targetApiDecisions.value[apiId] }),
    };
    return { mode: "merge" as const, target: { ...props.targetCollectionLocator }, sourceCollectionIds: [...sourceCollectionIds.value], decisions };
  }
  if (!props.targetProjectLocator) return null;
  return {
    mode: "module" as const,
    target: { ...props.targetProjectLocator },
    name: targetName.value.trim(),
    ...(sourceEnvironmentOptionToken.value === undefined ? {} : { sourceEnvironmentOptionToken: sourceEnvironmentOptionToken.value }),
  };
}

async function makeImportPlan() {
  const context = props.importW.previewContext;
  if (!props.importW.preview || !context || !props.importW.isPreviewContextCurrent(context)) return;
  const target = selectedTarget();
  if (!target) { stepError.value = t("import.targetRequired"); return; }
  try {
    if (target.mode === "module" && sourceEnvironmentOptions.value.length > 1 && sourceEnvironmentOptionToken.value === undefined) throw new Error(t("import.sourceEnvironmentRequired"));
    await props.importW.makePlan(target);
    stepError.value = "";
  } catch (e) {
    if (props.importW.isPreviewContextCurrent(context)) stepError.value = e instanceof Error ? e.message : String(e);
  }
}

async function applyImport() {
  const context = props.importW.previewContext;
  const target = selectedTarget();
  if (!target || !context || !props.importW.isPreviewContextCurrent(context)) return;
  if (props.importW.plan?.entries.some((entry) => decisionActions.value[entry.sourceApiId] === "overwrite") && !overwriteConfirmed.value) {
    stepError.value = t("import.overwriteConfirmRequired");
    return;
  }
  try {
    const result = await props.importW.apply(target, lossyConfirmed.value);
    if (!props.importW.isPreviewContextCurrent(context)) return;
    if (!result.committed && !props.importW.plan?.cancelled && result.summary.added + result.summary.overwritten === 0) {
      stepError.value = t("import.planNoChanges");
    }
    current.value = 2;
  } catch (e) {
    if (props.importW.isPreviewContextCurrent(context)) props.reportError(e); // 仅报告发起该 apply 的预览错误
  }
}

async function refreshCommitted() {
  try { await props.importW.refreshAfterCommit(); } catch { /* committed state remains; retry refresh is safe */ }
}

async function undoImport() {
  try { await props.importW.undo(); } catch (e) { props.reportError(e); }
}

function closeWizard() {
  props.importW.reset();
  targetName.value = "";
  groupValue.value = undefined;
  sourceEnvironmentOptionToken.value = undefined;
  sourceCollectionIds.value = [];
  decisionActions.value = {};
  targetApiDecisions.value = {};
  overwriteConfirmed.value = false;
  lossyConfirmed.value = false;
  stepError.value = "";
  curlText.value = "";
  current.value = 0;
  emit("close");
}
</script>

<template>
  <section class="import-wizard" data-testid="import-wizard">
    <a-steps :items="steps" :current="current" size="small" data-testid="import-steps" />
    <!-- 第一步：选择文件 -->
    <div v-if="current === 0" class="step-body">
      <!-- 动态枚举的导入格式（M7-B 任务 1，D5）：内置 + 插件贡献，随 plugins:list 出口 -->
      <div class="formats" data-testid="import-formats">
        <span class="formats-label">{{ t("import.formats") }}</span>
        <a-tag v-for="name in plugins.importers" :key="name" data-testid="import-format">{{ name }}</a-tag>
        <span v-if="plugins.importers.length === 0" class="formats-empty">—</span>
      </div>
      <input
        ref="fileInput"
        type="file"
        class="hidden-input"
        data-testid="import-file-input"
        @change="onFileChange"
      />
      <a-button type="primary" data-testid="import-file-button" @click="($refs.fileInput as HTMLInputElement).click()">
        {{ t("import.pickFile") }}
      </a-button>
      <label for="import-curl-text">{{ t("import.pasteCurl") }}</label>
      <textarea id="import-curl-text" v-model="curlText" class="curl-input" rows="5" spellcheck="false" data-testid="import-curl-input" />
      <a-button :disabled="!curlText.trim()" data-testid="import-curl-preview" @click="onCurlPreview">{{ t("import.previewCurl") }}</a-button>
      <a-button data-testid="import-cancel" @click="closeWizard">{{ t("common.cancel") }}</a-button>
      <a-alert
        v-if="stepError"
        type="error"
        :message="t('import.error')"
        :description="stepError"
        show-icon
        data-testid="import-error"
      />
    </div>
    <!-- 第二步：预览确认（表单按模式区分） -->
    <div v-else-if="current === 1" class="step-body">
      <a-alert v-for="(diagnostic, index) in warnings" :key="`${diagnostic.code}:${diagnostic.path}:${index}`"
        :type="diagnostic.severity === 'error' ? 'error' : 'warning'"
        :message="`${diagnostic.code}${diagnostic.lossy ? t('import.lossyMarker') : ''}`"
        :description="`${diagnostic.path ? `${diagnostic.path}: ` : ''}${diagnostic.message}`"
        show-icon data-testid="import-warnings" />
      <a-tree :tree-data="treeData" block-node default-expand-all data-testid="import-preview-tree" />
      <a-checkbox v-if="mode === 'module'" v-model:checked="mergeIntoExisting" data-testid="import-merge-selected-module">
        {{ t("import.mergeSelectedModule") }}
      </a-checkbox>
      <label v-if="mode === 'module' && mergeIntoExisting" class="group-row">
        <span>{{ t("import.sourceModule") }}</span>
        <a-select v-model:value="sourceCollectionIds" class="group-select" mode="multiple" :options="sourceCollectionOptions" data-testid="import-source-collections" />
      </label>
      <a-alert v-if="mode === 'module' && mergeIntoExisting && !targetCollectionLocator" type="error" :message="t('import.mergeTargetRequired')" show-icon />
      <label v-if="mode === 'module' && sourceEnvironmentOptions.length > 0" class="group-row">
        <span>{{ t("import.sourceEnvironment") }}</span>
        <a-select
          v-model:value="sourceEnvironmentOptionToken"
          class="group-select"
          :options="sourceEnvironmentOptions"
          :placeholder="t('import.sourceEnvironment')"
          data-testid="import-source-environment-select"
          @change="stepError = ''"
        />
      </label>
      <label v-if="mode === 'project'" class="group-row">
        <span>{{ t("home.targetGroup") }}</span>
        <a-select
          v-model:value="groupValue"
          class="group-select"
          :options="groupOptions"
          data-testid="import-group-select"
        />
      </label>
      <label class="group-row">
        <span>{{ mode === "project" ? t("home.projectName") : t("home.moduleName") }}</span>
        <a-input
          v-model:value="targetName"
          :placeholder="mode === 'project' ? t('home.projectName') : t('home.moduleName')"
          data-testid="import-name-input"
        />
      </label>
      <div v-if="importW.plan" class="merge-plan" data-testid="import-plan-summary">
        <span>{{ t("import.planSummary", { added: importW.plan.summary.added, overwritten: importW.plan.summary.overwritten, skipped: importW.plan.summary.skipped }) }}</span>
        <div v-for="entry in importW.plan.entries" :key="entry.sourceApiId" class="merge-entry">
          <span>{{ entry.method }} {{ entry.path }} — {{ entry.sourceName }}</span>
          <a-select v-if="mode === 'module' && mergeIntoExisting" v-model:value="decisionActions[entry.sourceApiId]"
            :options="[{label:t('import.conflictSkip'),value:'skip'},{label:t('import.conflictRename'),value:'rename'},{label:t('import.conflictOverwrite'),value:'overwrite'},{label:t('import.conflictCancel'),value:'cancel'}]"
            data-testid="import-conflict-policy" />
          <a-select v-if="mode === 'module' && mergeIntoExisting && decisionActions[entry.sourceApiId] === 'overwrite' && entry.targetApiIds.length > 1"
            v-model:value="targetApiDecisions[entry.sourceApiId]"
            :options="entry.targetApiIds.map((id) => ({label:id,value:id}))" data-testid="import-conflict-target" />
        </div>
      </div>
      <a-checkbox v-if="warnings.some((item) => item.lossy)" v-model:checked="lossyConfirmed" data-testid="import-lossy-confirm">{{ t("import.lossyConfirm") }}</a-checkbox>
      <a-checkbox v-if="hasOverwrite" v-model:checked="overwriteConfirmed" data-testid="import-overwrite-confirm">{{ t("import.overwriteConfirm") }}</a-checkbox>
      <a-alert v-if="stepError" type="error" :message="stepError" show-icon data-testid="import-error" />
      <div class="actions">
        <a-button data-testid="import-prev" @click="current = 0">{{ t("import.prev") }}</a-button>
        <a-button data-testid="import-cancel" @click="closeWizard">{{ t("common.cancel") }}</a-button>
        <a-button :disabled="!importW.previewIsCurrent || importW.applying" data-testid="import-build-plan" @click="makeImportPlan">{{ t("import.buildPlan") }}</a-button>
        <a-button
          type="primary"
          :disabled="!hasCurrentPlan || !importW.previewIsCurrent || importW.applying || warnings.some((item) => item.severity === 'error') || (mode === 'module' && !mergeIntoExisting && sourceEnvironmentOptions.length > 1 && sourceEnvironmentOptionToken === undefined) || (warnings.some((item) => item.lossy) && !lossyConfirmed) || (hasOverwrite && !overwriteConfirmed)"
          data-testid="import-apply"
          @click="applyImport"
        >
          {{ t("import.apply") }}
        </a-button>
      </div>
    </div>
    <!-- 第三步：完成 -->
    <div v-else class="step-body">
      <div data-testid="import-done">
        <a-alert
          :type="importW.applyResult?.committed ? 'success' : 'info'"
          :message="importW.applyResult?.committed ? t('import.doneTitle') : t('import.noChangesWritten')"
          :description="importW.applyResult?.committed ? t('import.doneText', { name: importW.preview?.summary.projectName ?? '' }) : t('import.planCancelled')"
          show-icon
        />
      </div>
      <a-alert v-if="importW.refreshError" type="warning" :message="t('import.refreshError')" :description="importW.refreshError" show-icon data-testid="import-refresh-error" />
      <a-button v-if="importW.refreshError" data-testid="import-refresh-only" @click="refreshCommitted">{{ t("import.refreshOnly") }}</a-button>
      <a-button v-if="importW.applyResult?.undoToken" data-testid="import-undo" @click="undoImport">{{ t("import.undo") }}</a-button>
      <a-button type="primary" data-testid="import-finish" @click="closeWizard">{{ t("import.finish") }}</a-button>
    </div>
  </section>
</template>

<style scoped>
.import-wizard {
  padding: 8px 10px;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.step-body {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
}
.hidden-input {
  display: none;
}
.curl-input {
  box-sizing: border-box;
  width: 100%;
  font-family: monospace;
  resize: vertical;
}
/* 动态枚举的导入格式清单（M7-B 任务 1）：文件选择上方轻量 tag 行 */
.formats {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}
.formats-label {
  color: var(--text-muted);
  font-size: 12px;
  margin-inline-end: 2px;
}
.formats-empty {
  color: var(--text-muted);
}
.group-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.group-row .ant-input,
.group-row input,
.group-select {
  flex: 1;
}
.actions {
  display: flex;
  gap: 8px;
}
</style>

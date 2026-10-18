<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button as AButton, Input as AInput, Select as ASelect, Table as ATable } from "ant-design-vue";
import type { Assertion, TestCase } from "@apicc/core";
import { ApiRequestSchema } from "@apicc/core/schema";
import type { useCasesStore } from "../stores/cases.js";
import type { CaseIdentity } from "../stores/cases.js";
import type { useDebugStore } from "../stores/debug.js";
import type { useEditorStore } from "../stores/editor.js";
import EmptyState from "./EmptyState.vue";

const ATextarea = AInput.TextArea;

/**
 * 用例面板：props 接收 editor/cases store 实例（组合根一次装配；组件内部禁止重复调用
 * store 工厂）。用例列表行内编辑名称（a-input）与 scope（a-select：base + editor.envs
 * 的环境名列表——scope 按环境名引用，规格 §6），行点击经 cases.select 选中；
 * 断言区为选中用例的 a-table 行编辑（target/op 下拉、expected 输入；headerName/path
 * 按目标条件显示，切换目标即清理无关字段——strict schema 不残留旧键）；
 * 前置/后置脚本 a-textarea。「添加用例」cases.addCase（新增即选中），「删除用例」
 * cases.removeCase（仅剩一个时禁用，store 同样拒绝），「保存用例」cases.save()
 * （委托 editor.save → apiSave 持久化 + 复位 dirty 快照），保存链路拒绝经可选
 * reportError 转报组合根错误通道（宽审查 I1，不静默吞没）。
 */
const props = defineProps<{
  editor: ReturnType<typeof useEditorStore>;
  cases: ReturnType<typeof useCasesStore>;
  /** 调试 store（M9-D 测试模块）：单条用例「运行」复用既有发送管线，结果共享上屏。 */
  debug?: ReturnType<typeof useDebugStore>;
  reportError?: (e: unknown) => void;
  readOnly?: boolean;
}>();
const emit = defineEmits<{ (e: "stress", caseId: string): void }>();
const { t } = useI18n();
const overrideJson = ref("");
const overrideError = ref("");
const requestTab = computed(() => props.debug && props.editor.activeKey
  ? props.debug.requestTabForSession(props.editor.activeKey) : null);
const requestTabState = computed(() => requestTab.value && props.debug
  ? props.debug.requestTabState(requestTab.value) : null);

const TARGET_OPTIONS = (["status", "header", "bodyJson", "responseTime"] as const).map((v) => ({ label: v, value: v }));
const OP_OPTIONS = (["eq", "neq", "contains", "lt", "gt", "lte", "gte"] as const).map((v) => ({ label: v, value: v }));

// scope 可选项 = base + 当前接口所属项目的环境名列表（editor.envs，取 name）。
const scopeOptions = computed(() => [
  { label: "base", value: "base" },
  ...props.editor.envs.map((e) => ({ label: e.name, value: e.name })),
]);

// 选中用例：store 未选中/悬空（如刚切换接口）时回退第一个，保证面板始终有编辑目标。
const selected = computed(() => {
  const list = props.editor.api?.cases ?? [];
  const identity = requestTabState.value ? requestTabState.value.selectedCase : props.cases.selectedCase;
  return list.find((c) => c.id === identity?.caseId && c.scope === identity.scope) ?? list[0] ?? null;
});

function selectCase(caseId: string, scope: string) {
  props.cases.select(caseId, scope);
  if (requestTabState.value) requestTabState.value.selectedCase = { caseId, scope };
}

watch(() => selected.value ? `${selected.value.id}:${selected.value.scope}` : "", () => {
  overrideJson.value = selected.value?.requestOverride ? JSON.stringify(selected.value.requestOverride, null, 2) : "";
  overrideError.value = "";
}, { immediate: true });

// 断言表列（computed 包裹保持语言切换响应，EnvPanel 同款）。
const assertColumns = computed(() => [
  { key: "target", title: t("case.target") },
  { key: "op", title: t("case.op") },
  { key: "expected", title: t("case.expected") },
  { key: "headerName", title: t("case.headerName") },
  { key: "path", title: t("case.path") },
  { key: "actions", title: "" },
]);

function addCase() {
  if (props.readOnly) return;
  props.cases.addCase({ name: t("case.new"), scope: "base" });
}

function setCaseName(testCase: TestCase, name: string) {
  if (!props.readOnly) testCase.name = name;
}

/** 单条用例运行（M9-D）：存编辑缓冲后按该用例发送（结果经共享 debug store 上屏）。 */
async function runCase(identity: CaseIdentity) {
  if (!props.debug) return;
  try {
    // debug.send captures the complete editor/root identity before its own save await.
    await props.debug.runCase(props.editor, { caseId: identity.caseId, scope: identity.scope });
  } catch (e) {
    props.reportError?.(e);
  }
}

// 保存链路收口（任务 8 补课）：拒绝经可选 reportError 转报，不再作为未处理 rejection 静默吞没。
async function saveCases() {
  if (props.readOnly) return;
  if (overrideError.value) {
    props.reportError?.(new Error(overrideError.value));
    return;
  }
  try {
    await props.cases.save();
  } catch (e) {
    props.reportError?.(e);
  }
}

function inheritDefaultRequest() {
  if (props.readOnly || !selected.value) return;
  delete selected.value.requestOverride;
  props.cases.clearRequestRestoreFields({ caseId: selected.value.id, scope: selected.value.scope });
  overrideJson.value = "";
  overrideError.value = "";
}

function copyDefaultRequest() {
  if (props.readOnly || !selected.value || !props.editor.api) return;
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
  if (!selected.value || !value.trim()) return;
  try {
    const parsed = ApiRequestSchema.parse(JSON.parse(value));
    if (parsed.protocol !== props.editor.api?.contract.request.protocol) throw new Error("用例请求覆盖必须与接口协议一致");
    selected.value.requestOverride = parsed;
    overrideError.value = "";
  } catch (error) {
    overrideError.value = error instanceof Error ? error.message : String(error);
  }
}

function removeSelected() {
  if (!props.readOnly && selected.value) props.cases.removeCase(selected.value.id, selected.value.scope);
}

function updateScope(testCase: TestCase, scope: string) {
  if (props.readOnly) return;
  props.cases.changeScope(testCase.id, testCase.scope, scope);
}

// strict schema：headerName 仅 header 需要、path 仅 bodyJson 需要，其余目标即时删除旧键。
function setTarget(record: Assertion, target: Assertion["target"]) {
  if (props.readOnly) return;
  record.target = target;
  if (target === "header") record.headerName = record.headerName ?? "";
  else delete record.headerName;
  if (target === "bodyJson") record.path = record.path ?? "";
  else delete record.path;
}

function addAssertion() {
  if (props.readOnly) return;
  selected.value?.assertions.push({ id: crypto.randomUUID(), target: "status", op: "eq", expected: "" });
}

function setAssertionField<K extends keyof Assertion>(record: Assertion, key: K, value: Assertion[K]) {
  if (!props.readOnly) record[key] = value;
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

function removeAssertion(index: number) {
  if (props.readOnly) return;
  selected.value?.assertions.splice(index, 1);
}

function setOperationContent(op: CaseOperation, content: string) {
  if (!props.readOnly) op.content = content;
}

function removeOp(kind: "pre" | "post", index: number) {
  if (!props.readOnly) opsList(kind).splice(index, 1);
}
</script>

<template>
  <section class="case-panel" data-testid="case-panel">
    <EmptyState v-if="!editor.api" :text="t('case.empty')" />
    <template v-else>
      <div class="toolbar">
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

      <!-- 用例列表：行内编辑名称/scope，行点击选中；断言数只读展示 -->
      <div class="case-list">
        <div
          v-for="c in editor.api.cases"
          :key="`${c.id}:${c.scope}`"
          class="case-row"
          :class="{ active: c.id === selected?.id && c.scope === selected?.scope }"
          data-testid="case-row"
          @click="selectCase(c.id, c.scope)"
        >
          <a-input :value="c.name" :disabled="readOnly" class="case-name" data-testid="case-name" :placeholder="t('tree.namePlaceholder')" @update:value="(value) => setCaseName(c, value as string)" />
          <a-select :value="c.scope" :disabled="readOnly" class="scope-select" :options="scopeOptions" data-testid="case-scope" @update:value="(value) => updateScope(c, value as string)" />
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

      <!-- 选中用例的断言表 + 前置/后置脚本 -->
      <template v-if="selected">
        <section class="case-request-override" data-testid="case-request-override">
          <div class="section-title">{{ t("debugLoop.caseRequest") }}</div>
          <div class="override-toolbar">
            <span data-testid="case-request-mode">{{ selected.requestOverride ? t("debugLoop.requestOverride") : t("debugLoop.inheritRequest") }}</span>
            <a-button v-if="debug" size="small" :disabled="readOnly" data-testid="case-apply-debug-draft" @click="applyCurrentDebugDraft">{{ t("debugLoop.applyDebugDraft") }}</a-button>
            <a-button v-else size="small" :disabled="readOnly" data-testid="case-request-copy-default" @click="copyDefaultRequest">{{ t("debugLoop.copyDefaultRequest") }}</a-button>
            <a-button size="small" :disabled="readOnly || !selected.requestOverride" data-testid="case-request-inherit" @click="inheritDefaultRequest">{{ t("debugLoop.inheritRequest") }}</a-button>
          </div>
          <a-textarea v-if="selected.requestOverride" :value="overrideJson" :disabled="readOnly" :rows="8" data-testid="case-request-override-json" @update:value="updateRequestOverride" />
          <span v-if="overrideError" class="override-error" data-testid="case-request-override-error">{{ overrideError }}</span>
          <span class="note">{{ t("debugLoop.cookiesNotSavedWithCase") }}</span>
        </section>
        <div class="section-title">{{ t("case.assertions") }}</div>
        <a-table
          :data-source="selected.assertions"
          :columns="assertColumns"
          row-key="id"
          :pagination="false"
          size="small"
          data-testid="assert-table"
        >
          <template #bodyCell="{ column, record, index }">
            <template v-if="column.key === 'target'">
              <!-- 断言行 record 为表格槽宽类型、v 为 SelectValue：选项值恒为 target 联合内字符串，断言收窄。 -->
              <a-select
                :value="record.target"
                :disabled="readOnly"
                :options="TARGET_OPTIONS"
                data-testid="assert-target"
                @update:value="(v) => setTarget(record as Assertion, v as Assertion['target'])"
              />
            </template>
            <template v-else-if="column.key === 'op'">
              <a-select :value="record.op" :disabled="readOnly" :options="OP_OPTIONS" data-testid="assert-op" @update:value="(v) => setAssertionField(record as Assertion, 'op', v as Assertion['op'])" />
            </template>
            <template v-else-if="column.key === 'expected'">
              <a-input :value="record.expected" :disabled="readOnly" data-testid="assert-expected" @update:value="(v) => setAssertionField(record as Assertion, 'expected', v as string)" />
            </template>
            <template v-else-if="column.key === 'headerName'">
              <a-input v-if="record.target === 'header'" :value="record.headerName ?? ''" :disabled="readOnly" data-testid="assert-header-name" @update:value="(v) => setAssertionField(record as Assertion, 'headerName', v as string)" />
              <span v-else class="na">—</span>
            </template>
            <template v-else-if="column.key === 'path'">
              <a-input v-if="record.target === 'bodyJson'" :value="record.path ?? ''" :disabled="readOnly" data-testid="assert-path" @update:value="(v) => setAssertionField(record as Assertion, 'path', v as string)" />
              <span v-else class="na">—</span>
            </template>
            <template v-else>
              <a-button size="small" danger type="text" data-testid="assert-delete" :disabled="readOnly" @click="removeAssertion(index)">×</a-button>
            </template>
          </template>
        </a-table>
        <a-button size="small" data-testid="assert-add" :disabled="readOnly" @click="addAssertion">{{ t("case.addAssert") }}</a-button>

        <!-- M10：前置/后置操作（有序脚本操作列表；legacy preScript/postScript 保留只读迁移提示） -->
        <div class="scripts">
          <div class="script-row">
            <label>{{ t("container.preOperations") }}</label>
            <div class="ops-list" data-testid="case-pre-ops">
              <div v-for="(op, index) in selected.preOperations ?? []" :key="op.id" class="op-row">
                <div class="op-btns">
                  <a-button size="small" type="text" :disabled="readOnly || index === 0" @click="moveOp('pre', index, -1)">↑</a-button>
                  <a-button size="small" type="text" :disabled="readOnly || index === (selected!.preOperations?.length ?? 0) - 1" @click="moveOp('pre', index, 1)">↓</a-button>
                  <a-button size="small" danger type="text" data-testid="case-op-delete" :disabled="readOnly" @click="removeOp('pre', index)">×</a-button>
                </div>
                <a-textarea :value="op.content" :disabled="readOnly" :rows="3" class="script-text" data-testid="case-op-content" @update:value="(v) => setOperationContent(op, v as string)" />
              </div>
              <a-button size="small" data-testid="case-pre-op-add" :disabled="readOnly" @click="addOp('pre')">{{ t("container.addOperation") }}</a-button>
            </div>
          </div>
          <div class="script-row">
            <label>{{ t("container.postOperations") }}</label>
            <div class="ops-list" data-testid="case-post-ops">
              <div v-for="(op, index) in selected.postOperations ?? []" :key="op.id" class="op-row">
                <div class="op-btns">
                  <a-button size="small" type="text" :disabled="readOnly || index === 0" @click="moveOp('post', index, -1)">↑</a-button>
                  <a-button size="small" type="text" :disabled="readOnly || index === (selected!.postOperations?.length ?? 0) - 1" @click="moveOp('post', index, 1)">↓</a-button>
                  <a-button size="small" danger type="text" data-testid="case-op-delete" :disabled="readOnly" @click="removeOp('post', index)">×</a-button>
                </div>
                <a-textarea :value="op.content" :disabled="readOnly" :rows="3" class="script-text" data-testid="case-op-content" @update:value="(v) => setOperationContent(op, v as string)" />
              </div>
              <a-button size="small" data-testid="case-post-op-add" :disabled="readOnly" @click="addOp('post')">{{ t("container.addOperation") }}</a-button>
            </div>
          </div>
        </div>
      </template>
      <slot name="after-cases" />
    </template>
  </section>
</template>

<style scoped>
.case-panel {
  padding: 8px 10px;
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.toolbar {
  position: sticky;
  top: 8px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--bg);
}
.case-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.case-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px;
  border-radius: 4px;
  cursor: pointer;
}
.case-row.active {
  background: var(--accent-bg, rgba(22, 119, 255, 0.08));
}
.case-name {
  flex: 1;
}
.scope-select {
  width: 120px;
}
.assert-count {
  min-width: 20px;
  text-align: center;
  color: var(--text-muted, #888);
}
.section-title {
  font-weight: 600;
  margin-top: 4px;
}
.na {
  color: var(--text-muted, #bbb);
}
.case-request-override { display: flex; flex-direction: column; gap: 6px; }
.override-toolbar { display: flex; align-items: center; gap: 8px; }
.override-toolbar span { flex: 1; }
.override-error { color: var(--fail, #cf1322); }
.note { color: var(--text-muted, #888); font-size: 12px; }
.script-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 6px;
}
.script-row label {
  width: 80px;
  color: var(--text-muted, #888);
  font-size: 12px;
  padding-top: 4px;
}
.script-text {
  flex: 1;
  font-family: ui-monospace, monospace;
  resize: vertical;
}
.ops-list { flex: 1; display: flex; flex-direction: column; gap: 6px; }
.op-row { display: flex; gap: 6px; align-items: flex-start; }
.op-btns { display: flex; flex-direction: column; }
</style>

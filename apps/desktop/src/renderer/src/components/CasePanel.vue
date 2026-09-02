<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Button as AButton, Input as AInput, Select as ASelect, Table as ATable } from "ant-design-vue";
import type { Assertion } from "@apicc/core";
import type { useCasesStore } from "../stores/cases.js";
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
 * （委托 editor.save → apiSave 持久化 + 复位 dirty 快照）。
 */
const props = defineProps<{
  editor: ReturnType<typeof useEditorStore>;
  cases: ReturnType<typeof useCasesStore>;
}>();
const { t } = useI18n();

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
  return list.find((c) => c.id === props.cases.selectedCaseId) ?? list[0] ?? null;
});

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
  props.cases.addCase({ name: t("case.new"), scope: "base" });
}

function removeSelected() {
  if (selected.value) props.cases.removeCase(selected.value.id);
}

// strict schema：headerName 仅 header 需要、path 仅 bodyJson 需要，其余目标即时删除旧键。
function setTarget(record: Assertion, target: Assertion["target"]) {
  record.target = target;
  if (target === "header") record.headerName = record.headerName ?? "";
  else delete record.headerName;
  if (target === "bodyJson") record.path = record.path ?? "";
  else delete record.path;
}

function addAssertion() {
  selected.value?.assertions.push({ id: crypto.randomUUID(), target: "status", op: "eq", expected: "" });
}

function removeAssertion(index: number) {
  selected.value?.assertions.splice(index, 1);
}
</script>

<template>
  <section class="case-panel" data-testid="case-panel">
    <EmptyState v-if="!editor.api" :text="t('case.empty')" />
    <template v-else>
      <div class="toolbar">
        <a-button size="small" data-testid="case-add" @click="addCase">{{ t("case.add") }}</a-button>
        <a-button
          size="small"
          danger
          :disabled="editor.api.cases.length <= 1"
          data-testid="case-delete"
          @click="removeSelected"
        >
          {{ t("case.remove") }}
        </a-button>
        <a-button size="small" type="primary" data-testid="case-save" @click="cases.save()">{{ t("case.save") }}</a-button>
      </div>

      <!-- 用例列表：行内编辑名称/scope，行点击选中；断言数只读展示 -->
      <div class="case-list">
        <div
          v-for="c in editor.api.cases"
          :key="c.id"
          class="case-row"
          :class="{ active: c.id === selected?.id }"
          data-testid="case-row"
          @click="cases.select(c.id)"
        >
          <a-input v-model:value="c.name" class="case-name" data-testid="case-name" :placeholder="t('tree.namePlaceholder')" />
          <a-select v-model:value="c.scope" class="scope-select" :options="scopeOptions" data-testid="case-scope" />
          <span class="assert-count" :title="t('case.assertions')">{{ c.assertions.length }}</span>
        </div>
      </div>

      <!-- 选中用例的断言表 + 前置/后置脚本 -->
      <template v-if="selected">
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
              <a-select
                :value="record.target"
                :options="TARGET_OPTIONS"
                data-testid="assert-target"
                @update:value="(v) => setTarget(record, v)"
              />
            </template>
            <template v-else-if="column.key === 'op'">
              <a-select v-model:value="record.op" :options="OP_OPTIONS" data-testid="assert-op" />
            </template>
            <template v-else-if="column.key === 'expected'">
              <a-input v-model:value="record.expected" data-testid="assert-expected" />
            </template>
            <template v-else-if="column.key === 'headerName'">
              <a-input v-if="record.target === 'header'" v-model:value="record.headerName" data-testid="assert-header-name" />
              <span v-else class="na">—</span>
            </template>
            <template v-else-if="column.key === 'path'">
              <a-input v-if="record.target === 'bodyJson'" v-model:value="record.path" data-testid="assert-path" />
              <span v-else class="na">—</span>
            </template>
            <template v-else>
              <a-button size="small" danger type="text" data-testid="assert-delete" @click="removeAssertion(index)">×</a-button>
            </template>
          </template>
        </a-table>
        <a-button size="small" data-testid="assert-add" @click="addAssertion">{{ t("case.addAssert") }}</a-button>

        <div class="scripts">
          <div class="script-row">
            <label>{{ t("case.preScript") }}</label>
            <a-textarea v-model:value="selected.preScript" :rows="3" data-testid="pre-script" class="script-text" />
          </div>
          <div class="script-row">
            <label>{{ t("case.postScript") }}</label>
            <a-textarea v-model:value="selected.postScript" :rows="3" data-testid="post-script" class="script-text" />
          </div>
        </div>
      </template>
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
  display: flex;
  align-items: center;
  gap: 6px;
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
</style>

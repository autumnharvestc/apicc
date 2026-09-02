<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button as AButton, Input as AInput, Modal as AModal, Select as ASelect, Table as ATable } from "ant-design-vue";
import type { useEnvsStore } from "../stores/envs.js";
import EmptyState from "./EmptyState.vue";
import ConfirmDialog from "./ConfirmDialog.vue";

/**
 * 环境面板：环境 a-select 选择 + 变量 a-table 行编辑 + 「从现有环境派生」a-modal
 * （extends 按环境名引用，规格 §6）+ 删除确认（复用 ConfirmDialog）。
 * store 经 props 注入（组合根一次装配；组件内部禁止重复调用工厂）；projectId 由
 * 组合根随树选中项目下发，变化即重载环境列表；reportError 为组合根错误反馈通道。
 * 语义边界：变量表是组件内编辑缓冲，选中/切换环境时以该环境已存 variables 水合
 * （tree DTO project 节点 envs 携带已存值；saveVars 后 store 本地项同步，切回不丢）；
 * 保存经 envs.saveVars 落盘（主进程 IPC 显式 save，全量替换语义）。
 */
const props = defineProps<{
  envs: ReturnType<typeof useEnvsStore>;
  projectId: string | null;
  reportError: (e: unknown) => void;
}>();
const { t } = useI18n();

async function loadEnvs() {
  if (!props.projectId) return;
  try {
    await props.envs.load(props.projectId);
  } catch (e) {
    props.reportError(e);
  }
}
watch(() => props.projectId, loadEnvs, { immediate: true });

// —— 环境选择 ——
const envOptions = computed(() => props.envs.envs.map((e) => ({ label: e.name, value: e.id })));

function onSelectEnv(id: string) {
  props.envs.selectedEnvId = id;
}

// —— 变量行编辑缓冲（a-table 行编辑；rowKey 需稳定 id，ResponseViewer 缺 row-key 的告警不再复刻） ——
interface VarRow { id: string; key: string; value: string }
const rows = ref<VarRow[]>([]);
const saved = ref(false);
// 选中/切换环境：以已存 variables 水合行缓冲（而非清空）——已存值始终可见。
watch(
  () => props.envs.selectedEnvId,
  (envId) => {
    saved.value = false;
    const env = props.envs.envs.find((e) => e.id === envId);
    rows.value = env
      ? Object.entries(env.variables ?? {}).map(([key, value]) => ({ id: crypto.randomUUID(), key, value }))
      : [];
  },
);
const columns = computed(() => [
  { key: "key", title: t("env.varName"), dataIndex: "key" },
  { key: "value", title: t("env.varValue"), dataIndex: "value" },
  { key: "actions", title: "" },
]);

function addRow() {
  saved.value = false;
  rows.value.push({ id: crypto.randomUUID(), key: "", value: "" });
}
function removeRow(index: number) {
  saved.value = false;
  rows.value.splice(index, 1);
}

async function saveVars() {
  const envId = props.envs.selectedEnvId;
  if (!envId) return;
  const variables: Record<string, string> = {};
  for (const row of rows.value) {
    const key = row.key.trim();
    if (key) variables[key] = row.value;
  }
  try {
    await props.envs.saveVars(envId, variables);
    saved.value = true;
  } catch (e) {
    props.reportError(e);
  }
}

// —— 新建 / 从现有环境派生（共用一个 a-modal；derive 模式多父环境选择） ——
const modal = ref<{ open: boolean; mode: "new" | "derive"; name: string; parentId: string | undefined }>({
  open: false,
  mode: "new",
  name: "",
  parentId: undefined,
});

function openModal(mode: "new" | "derive") {
  modal.value = { open: true, mode, name: "", parentId: mode === "derive" ? props.envs.envs[0]?.id : undefined };
}

function closeModal() {
  modal.value = { ...modal.value, open: false };
}

async function confirmModal() {
  const name = modal.value.name.trim();
  if (!name || !props.envs.projectId) return;
  let extendsName: string | undefined;
  if (modal.value.mode === "derive") {
    const parent = props.envs.envs.find((e) => e.id === modal.value.parentId);
    if (!parent) return;
    extendsName = parent.name;
  }
  closeModal();
  // 先关对话框再执行（SideTree 对话框同款收口）：拒绝统一转报组合根错误展示条。
  try {
    await props.envs.create({ projectId: props.envs.projectId, name, extends: extendsName });
  } catch (e) {
    props.reportError(e);
  }
}

// —— 删除当前选中环境（确认对话框放行） ——
const deleteTarget = ref<{ id: string; name: string } | null>(null);

async function onDeleteConfirm() {
  const target = deleteTarget.value;
  deleteTarget.value = null;
  if (!target) return;
  try {
    await props.envs.remove("environment", target.id, async () => true);
  } catch (e) {
    props.reportError(e);
  }
}
</script>

<template>
  <section class="env-panel" data-testid="env-panel">
    <EmptyState v-if="!projectId" :text="t('env.empty')" />
    <template v-else>
      <div class="toolbar">
        <a-select
          class="env-select"
          :value="envs.selectedEnvId"
          :options="envOptions"
          :placeholder="t('env.select')"
          data-testid="env-select"
          @update:value="onSelectEnv"
        />
        <a-button size="small" data-testid="env-new" @click="openModal('new')">{{ t("env.new") }}</a-button>
        <a-button size="small" data-testid="env-derive" @click="openModal('derive')">{{ t("env.derive") }}</a-button>
        <a-button
          size="small"
          danger
          :disabled="!envs.selectedEnvId"
          :data-env-id="envs.selectedEnvId ?? ''"
          data-testid="env-delete"
          @click="deleteTarget = envs.envs.find((e) => e.id === envs.selectedEnvId) ?? null"
        >
          {{ t("tree.delete") }}
        </a-button>
      </div>
      <div class="vars">
        <a-table
          :data-source="rows"
          :columns="columns"
          row-key="id"
          :pagination="false"
          size="small"
          data-testid="env-var-table"
        >
          <template #bodyCell="{ column, record, index }">
            <template v-if="column.key === 'key'">
              <a-input v-model:value="record.key" data-testid="env-var-key" :placeholder="t('env.varName')" />
            </template>
            <template v-else-if="column.key === 'value'">
              <a-input v-model:value="record.value" data-testid="env-var-value" :placeholder="t('env.varValue')" />
            </template>
            <template v-else>
              <a-button size="small" danger data-testid="env-var-delete" @click="removeRow(index)">{{ t("tree.delete") }}</a-button>
            </template>
          </template>
        </a-table>
        <div class="vars-actions">
          <a-button size="small" :disabled="!envs.selectedEnvId" data-testid="env-var-add" @click="addRow">{{ t("env.addVar") }}</a-button>
          <a-button size="small" type="primary" :disabled="!envs.selectedEnvId" data-testid="env-vars-save" @click="saveVars">
            {{ t("env.saveVars") }}
          </a-button>
          <span v-if="saved" class="saved" data-testid="env-vars-saved">{{ t("env.saved") }}</span>
        </div>
      </div>
    </template>
    <a-modal
      v-if="modal.open"
      :open="modal.open"
      :title="modal.mode === 'derive' ? t('env.derive') : t('env.new')"
      :ok-text="t('common.confirm')"
      :cancel-text="t('common.cancel')"
      :ok-button-props="{ 'data-testid': 'env-modal-confirm' }"
      :cancel-button-props="{ 'data-testid': 'env-modal-cancel' }"
      :width="420"
      data-testid="env-modal"
      @ok="confirmModal"
      @cancel="closeModal"
    >
      <a-input v-model:value="modal.name" data-testid="env-name-input" :placeholder="t('env.namePlaceholder')" />
      <a-select
        v-if="modal.mode === 'derive'"
        v-model:value="modal.parentId"
        class="parent-select"
        :options="envOptions"
        :placeholder="t('env.parent')"
        data-testid="env-parent-select"
      />
    </a-modal>
    <ConfirmDialog
      :open="deleteTarget !== null"
      :title="t('env.deleteConfirm', { name: deleteTarget?.name ?? '' })"
      @confirm="onDeleteConfirm"
      @cancel="deleteTarget = null"
    />
  </section>
</template>

<style scoped>
.env-panel {
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
.env-select {
  min-width: 140px;
}
.vars-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}
.saved {
  color: var(--pass, #389e0d);
}
.parent-select {
  margin-top: 8px;
  width: 100%;
}
</style>

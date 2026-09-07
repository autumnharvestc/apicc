<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button as AButton, Checkbox as ACheckbox, Input as AInput, Modal as AModal, Select as ASelect, Table as ATable } from "ant-design-vue";
import type { KeyValuePair } from "@apicc/core";
import type { useEnvsStore } from "../stores/envs.js";
import type { useWorkspaceStore } from "../stores/workspace.js";
import EmptyState from "./EmptyState.vue";
import ConfirmDialog from "./ConfirmDialog.vue";

/**
 * 环境管理（M9-B 重做，参考主流平台布局）：左侧锚点导航——全局（全局变量/全局参数）
 * + 环境清单（新建/派生/删除入口保留）；右侧详情——
 * - 全局变量：KV 行编辑，落 workspace.globals.variables（跨环境公用，变量链最低层）；
 * - 全局参数：query/header 两张 KV 表（含启用勾选），请求同名项以接口定义优先；
 * - 环境详情：前置 URL 表（当前项目集合清单 × URL，M9-B 按集合设置）+ 环境变量表
 *   （既有行编辑语义不变），保存 = saveVars + saveBaseUrls 双写。
 * store 经 props 注入（组合根一次装配；组件内部禁止重复调用工厂）；projectId 由
 * 组合根随树选中项目下发，变化即重载环境列表与全局设置；reportError 为组合根错误
 * 反馈通道。既有 data-testid（env-new、env-derive、env-delete、env-modal 系、env-var 系）
 * 全部保留，测试锚点零迁移成本。
 */
const props = defineProps<{
  envs: ReturnType<typeof useEnvsStore>;
  workspace: ReturnType<typeof useWorkspaceStore>;
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

// —— 左侧导航选择：全局变量 / 全局参数 / 某环境（值为环境 id） ——
// selectedEnvId 程序性变化（创建后自动选中、重挂水合、删除清空）时 pane 跟随：
// 置空回全局变量页；用户点击导航条目不受扰（值不变不触发）。
type Pane = "gvars" | "gparams" | string;
const pane = ref<Pane>("gvars");
const selectedEnv = computed(() => props.envs.envs.find((e) => e.id === pane.value) ?? null);
watch(
  () => props.envs.selectedEnvId,
  (id) => {
    pane.value = id ?? "gvars";
  },
  { immediate: true },
);

// 当前项目的集合清单（前置 URL 表的「模块」列，M9-B 按集合设置）：取树中所属项目的集合子节点。
const collections = computed(() => {
  const pid = props.projectId;
  const project = (props.workspace.tree?.children ?? [])
    .flatMap((g) => g.children ?? [])
    .find((p) => p.id === pid);
  return (project?.children ?? [])
    .filter((n) => n.kind === "collection")
    .map((c) => ({ id: c.id, name: c.label }));
});

// —— 全局变量/全局参数行编辑缓冲 ——
interface VarRow { id: string; key: string; value: string }
interface ParamRow { id: string; key: string; value: string; enabled: boolean }

function recordToRows(record: Record<string, string>): VarRow[] {
  return Object.entries(record ?? {}).map(([key, value]) => ({ id: crypto.randomUUID(), key, value }));
}
function paramsToRows(list: KeyValuePair[] | undefined): ParamRow[] {
  return (list ?? []).map((kv) => ({ id: crypto.randomUUID(), key: kv.key, value: kv.value, enabled: kv.enabled }));
}
const gvarRows = ref<VarRow[]>([]);
const gqueryRows = ref<ParamRow[]>([]);
const gheaderRows = ref<ParamRow[]>([]);
watch(
  () => props.envs.globals,
  (g) => {
    gvarRows.value = recordToRows(g?.variables);
    gqueryRows.value = paramsToRows(g?.query);
    gheaderRows.value = paramsToRows(g?.headers);
  },
  { immediate: true, deep: true },
);

const gvarsSaved = ref(false);
function addGvarRow() {
  gvarRows.value.push({ id: crypto.randomUUID(), key: "", value: "" });
}
async function saveGlobalVars() {
  const variables: Record<string, string> = {};
  for (const row of gvarRows.value) {
    const key = row.key.trim();
    if (key) variables[key] = row.value;
  }
  try {
    await props.envs.saveGlobals(props.projectId!, { ...props.envs.globals, variables });
    gvarsSaved.value = true;
  } catch (e) {
    props.reportError(e);
  }
}

const gparamsSaved = ref(false);
function addParamRow(list: ParamRow[]) {
  list.push({ id: crypto.randomUUID(), key: "", value: "", enabled: true });
}
async function saveGlobalParams() {
  const toParams = (rows: ParamRow[]): KeyValuePair[] =>
    rows.filter((r) => r.key.trim()).map((r) => ({ key: r.key.trim(), value: r.value, enabled: r.enabled }));
  try {
    await props.envs.saveGlobals(props.projectId!, {
      ...props.envs.globals,
      query: toParams(gqueryRows.value),
      headers: toParams(gheaderRows.value),
    });
    gparamsSaved.value = true;
  } catch (e) {
    props.reportError(e);
  }
}

// —— 环境详情：前置 URL 缓冲（collectionId → url，选中环境时水合）+ 变量行缓冲（既有语义） ——
const baseUrlRows = ref<Record<string, string>>({});
const varRows = ref<VarRow[]>([]);
const saved = ref(false);
watch(
  [() => props.envs.selectedEnvId, selectedEnv],
  () => {
    saved.value = false;
    const env = selectedEnv.value;
    baseUrlRows.value = { ...(env?.baseUrls ?? {}) };
    varRows.value = env ? recordToRows(env.variables) : [];
  },
  { immediate: true, deep: true },
);

function addRow() {
  varRows.value.push({ id: crypto.randomUUID(), key: "", value: "" });
}
function removeRow(index: number) {
  varRows.value.splice(index, 1);
}

/** 环境保存（M9-B）：变量 + 前置 URL 双写（同一「保存」动作，语义 = 该环境详情页整体落盘）。 */
async function saveVars() {
  const envId = props.envs.selectedEnvId;
  if (!envId) return;
  const variables: Record<string, string> = {};
  for (const row of varRows.value) {
    const key = row.key.trim();
    if (key) variables[key] = row.value;
  }
  const baseUrls: Record<string, string> = {};
  for (const [collectionId, url] of Object.entries(baseUrlRows.value)) {
    const trimmed = url.trim();
    if (trimmed) baseUrls[collectionId] = trimmed;
  }
  try {
    await props.envs.saveVars(envId, variables);
    await props.envs.saveBaseUrls(envId, baseUrls);
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
    const env = await props.envs.create({ projectId: props.envs.projectId, name, extends: extendsName });
    pane.value = env.id;
  } catch (e) {
    props.reportError(e);
  }
}

// —— 删除当前选中环境（确认对话框放行） ——
const deleteTarget = ref<{ id: string; name: string } | null>(null);

// data-* 为 HTML 透传属性，antd 按钮 props 类型未建模；经 any 索引签名断言保留测试锚点
// （运行时 Vue 原样透传到 ok/cancel 按钮上，行为不变，见 vue-tsc 收口）。
const okButtonProps: Record<string, any> = { "data-testid": "env-modal-confirm" };
const cancelButtonProps: Record<string, any> = { "data-testid": "env-modal-cancel" };

async function onDeleteConfirm() {
  const target = deleteTarget.value;
  deleteTarget.value = null;
  if (!target) return;
  try {
    await props.envs.remove("environment", target.id, async () => true);
    if (pane.value === target.id) pane.value = "gvars";
  } catch (e) {
    props.reportError(e);
  }
}
</script>

<template>
  <section class="env-panel" data-testid="env-panel">
    <EmptyState v-if="!projectId" :text="t('env.empty')" />
    <div v-else class="layout">
      <!-- 左侧锚点：全局 + 环境清单 -->
      <aside class="side">
        <div class="side-title">{{ t("env.globalSection") }}</div>
        <button type="button" class="side-item" :class="{ active: pane === 'gvars' }" data-testid="env-tab-globals-vars" @click="pane = 'gvars'">
          {{ t("env.globalVars") }}
        </button>
        <button type="button" class="side-item" :class="{ active: pane === 'gparams' }" data-testid="env-tab-globals-params" @click="pane = 'gparams'">
          {{ t("env.globalParams") }}
        </button>
        <div class="side-title side-envs">
          <span>{{ t("env.envSection") }}</span>
          <span class="side-actions">
            <a-button size="small" type="text" data-testid="env-new" @click="openModal('new')">{{ t("env.new") }}</a-button>
            <a-button size="small" type="text" data-testid="env-derive" @click="openModal('derive')">{{ t("env.derive") }}</a-button>
          </span>
        </div>
        <button
          v-for="e in envs.envs"
          :key="e.id"
          type="button"
          class="side-item"
          :class="{ active: pane === e.id }"
          :data-testid="`env-item-${e.id}`"
          @click="pane = e.id; envs.selectedEnvId = e.id"
        >
          {{ e.name }}
        </button>
        <a-button
          size="small"
          danger
          class="side-delete"
          :disabled="!envs.selectedEnvId"
          :data-env-id="envs.selectedEnvId ?? ''"
          data-testid="env-delete"
          @click="deleteTarget = envs.envs.find((e) => e.id === envs.selectedEnvId) ?? null"
        >
          {{ t("tree.delete") }}
        </a-button>
      </aside>

      <!-- 右侧详情 -->
      <div class="detail">
        <!-- 全局变量 -->
        <div v-if="pane === 'gvars'" data-testid="env-pane-globals-vars">
          <div class="pane-title">{{ t("env.globalVars") }}</div>
          <a-table
            :data-source="gvarRows"
            :columns="[{ key: 'key', title: t('env.varName'), dataIndex: 'key' }, { key: 'value', title: t('env.varValue'), dataIndex: 'value' }, { key: 'actions', title: '' }]"
            row-key="id"
            :pagination="false"
            size="small"
            data-testid="env-global-var-table"
          >
            <template #bodyCell="{ column, record, index }">
              <template v-if="column.key === 'key'">
                <a-input v-model:value="record.key" data-testid="env-global-var-key" :placeholder="t('env.varName')" />
              </template>
              <template v-else-if="column.key === 'value'">
                <a-input v-model:value="record.value" data-testid="env-global-var-value" :placeholder="t('env.varValue')" />
              </template>
              <template v-else-if="column.key === 'actions'">
                <a-button size="small" danger data-testid="env-global-var-delete" @click="gvarRows.splice(index, 1)">{{ t("tree.delete") }}</a-button>
              </template>
            </template>
          </a-table>
          <div class="pane-actions">
            <a-button size="small" data-testid="env-global-var-add" @click="addGvarRow">{{ t("env.addVar") }}</a-button>
            <a-button size="small" type="primary" data-testid="env-global-vars-save" @click="saveGlobalVars">{{ t("env.saveVars") }}</a-button>
            <span v-if="gvarsSaved" class="saved" data-testid="env-global-vars-saved">{{ t("env.saved") }}</span>
          </div>
        </div>

        <!-- 全局参数 -->
        <div v-else-if="pane === 'gparams'" data-testid="env-pane-globals-params">
          <div class="pane-title">{{ t("env.globalParams") }}</div>
          <div class="param-block">
            <div class="block-title">{{ t("env.queryParams") }}</div>
            <a-table
              :data-source="gqueryRows"
              :columns="[{ key: 'enabled', title: '' }, { key: 'key', title: t('env.varName'), dataIndex: 'key' }, { key: 'value', title: t('env.varValue'), dataIndex: 'value' }, { key: 'actions', title: '' }]"
              row-key="id"
              :pagination="false"
              size="small"
              data-testid="env-global-query-table"
            >
              <template #bodyCell="{ column, record, index }">
                <template v-if="column.key === 'enabled'">
                  <a-checkbox v-model:checked="record.enabled" data-testid="env-global-query-enabled" />
                </template>
                <template v-else-if="column.key === 'key'">
                  <a-input v-model:value="record.key" data-testid="env-global-query-key" :placeholder="t('env.varName')" />
                </template>
                <template v-else-if="column.key === 'value'">
                  <a-input v-model:value="record.value" data-testid="env-global-query-value" :placeholder="t('env.varValue')" />
                </template>
                <template v-else>
                  <a-button size="small" danger data-testid="env-global-query-delete" @click="gqueryRows.splice(index, 1)">{{ t("tree.delete") }}</a-button>
                </template>
              </template>
            </a-table>
            <a-button size="small" data-testid="env-global-query-add" @click="addParamRow(gqueryRows)">{{ t("env.addVar") }}</a-button>
          </div>
          <div class="param-block">
            <div class="block-title">{{ t("env.headerParams") }}</div>
            <a-table
              :data-source="gheaderRows"
              :columns="[{ key: 'enabled', title: '' }, { key: 'key', title: t('env.varName'), dataIndex: 'key' }, { key: 'value', title: t('env.varValue'), dataIndex: 'value' }, { key: 'actions', title: '' }]"
              row-key="id"
              :pagination="false"
              size="small"
              data-testid="env-global-header-table"
            >
              <template #bodyCell="{ column, record, index }">
                <template v-if="column.key === 'enabled'">
                  <a-checkbox v-model:checked="record.enabled" data-testid="env-global-header-enabled" />
                </template>
                <template v-else-if="column.key === 'key'">
                  <a-input v-model:value="record.key" data-testid="env-global-header-key" :placeholder="t('env.varName')" />
                </template>
                <template v-else-if="column.key === 'value'">
                  <a-input v-model:value="record.value" data-testid="env-global-header-value" :placeholder="t('env.varValue')" />
                </template>
                <template v-else>
                  <a-button size="small" danger data-testid="env-global-header-delete" @click="gheaderRows.splice(index, 1)">{{ t("tree.delete") }}</a-button>
                </template>
              </template>
            </a-table>
            <a-button size="small" data-testid="env-global-header-add" @click="addParamRow(gheaderRows)">{{ t("env.addVar") }}</a-button>
          </div>
          <div class="pane-actions">
            <a-button size="small" type="primary" data-testid="env-global-params-save" @click="saveGlobalParams">{{ t("env.saveVars") }}</a-button>
            <span v-if="gparamsSaved" class="saved" data-testid="env-global-params-saved">{{ t("env.saved") }}</span>
          </div>
        </div>

        <!-- 环境详情：前置 URL（按集合）+ 环境变量 -->
        <div v-else data-testid="env-pane-env">
          <template v-if="selectedEnv">
            <div class="pane-title">{{ selectedEnv.name }}</div>
            <div class="param-block">
              <div class="block-title">{{ t("env.baseUrls") }}</div>
              <EmptyState v-if="collections.length === 0" :text="t('env.noCollections')" />
              <div v-else class="baseurl-rows" data-testid="env-baseurls-table">
                <label v-for="c in collections" :key="c.id" class="baseurl-row">
                  <span class="baseurl-name">{{ c.name }}</span>
                  <a-input
                    v-model:value="baseUrlRows[c.id]"
                    data-testid="env-baseurl-input"
                    :data-collection-id="c.id"
                    :placeholder="t('env.baseUrlPlaceholder')"
                  />
                </label>
              </div>
            </div>
            <div class="param-block">
              <div class="block-title">{{ t("env.envVars") }}</div>
              <a-table
                :data-source="varRows"
                :columns="[{ key: 'key', title: t('env.varName'), dataIndex: 'key' }, { key: 'value', title: t('env.varValue'), dataIndex: 'value' }, { key: 'actions', title: '' }]"
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
              <div class="pane-actions">
                <a-button size="small" data-testid="env-var-add" @click="addRow">{{ t("env.addVar") }}</a-button>
                <a-button size="small" type="primary" data-testid="env-vars-save" @click="saveVars">{{ t("env.saveVars") }}</a-button>
                <span v-if="saved" class="saved" data-testid="env-vars-saved">{{ t("env.saved") }}</span>
              </div>
            </div>
          </template>
          <EmptyState v-else :text="t('env.select')" />
        </div>
      </div>
    </div>
    <a-modal
      v-if="modal.open"
      :open="modal.open"
      :title="modal.mode === 'derive' ? t('env.derive') : t('env.new')"
      :ok-text="t('common.confirm')"
      :cancel-text="t('common.cancel')"
      :ok-button-props="okButtonProps"
      :cancel-button-props="cancelButtonProps"
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
        :options="envs.envs.map((e) => ({ label: e.name, value: e.id }))"
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
  height: 100%;
  box-sizing: border-box;
}
.layout {
  display: flex;
  gap: 14px;
  height: 100%;
  min-height: 0;
}
.side {
  width: 150px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-right: 1px solid var(--border);
  padding-right: 10px;
  overflow-y: auto;
}
.side-title {
  font-weight: 600;
  color: var(--text-muted);
  padding: 4px 6px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.side-envs { margin-top: 8px; }
.side-actions { display: inline-flex; gap: 2px; }
.side-item {
  text-align: left;
  border: none;
  background: transparent;
  color: var(--text);
  padding: 5px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.side-item:hover { background: var(--hover); }
.side-item.active { background: var(--active-weak); color: var(--accent); }
.side-delete { margin-top: 10px; align-self: flex-start; }
.detail {
  flex: 1;
  min-width: 0;
  overflow: auto;
}
.pane-title {
  font-weight: 600;
  font-size: 14px;
  margin-bottom: 8px;
}
.param-block { margin-bottom: 14px; }
.block-title { font-weight: 600; margin-bottom: 4px; }
.baseurl-rows { display: flex; flex-direction: column; gap: 6px; }
.baseurl-row { display: flex; align-items: center; gap: 8px; }
.baseurl-name { width: 140px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pane-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}
.saved { color: var(--pass, #389e0d); }
.parent-select { margin-top: 8px; width: 100%; }
</style>

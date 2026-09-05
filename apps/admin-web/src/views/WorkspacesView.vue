<script setup lang="ts">
/**
 * 工作区管理视图（M4-A 任务 3，裁定 B/D6）：a-table 清单（name/myRole/createdAt + 操作列，
 * 点名称行点选工作区 → 详情拉取、侧栏管理入口随角色出现）；创建 a-modal（name 必填 1-64
 * 本地校验，提交 loading，api 错误上屏，成功后清单自动刷新并关闭）；删除仅 OWNER 行可见，
 * 受控 a-modal 二次输入工作区名确认（名字不匹配禁确定——不可逆操作强化，desktop ConfirmDialog
 * 同款受控 a-modal 形态；api 错误上屏不关窗）。组件内零工厂调用：workspaces 经路由 props 注入。
 */
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Alert as AAlert, Button as AButton, Input as AInput, Modal as AModal, Table as ATable } from "ant-design-vue";
import type { AdminWorkspaceSummary } from "../api/contract.js";
import type { WorkspacesStore } from "../stores/workspaces.js";

const props = defineProps<{ workspaces: WorkspacesStore }>();
const { t } = useI18n();

onMounted(() => {
  void props.workspaces.refresh(); // 挂载即拉清单（裁定 B：列表）
});

const columns = computed(() => [
  { title: t("ws.colName"), dataIndex: "name", key: "name" },
  { title: t("ws.colMyRole"), dataIndex: "myRole", key: "myRole" },
  { title: t("ws.colCreatedAt"), dataIndex: "createdAt", key: "createdAt" },
  { title: t("ws.colActions"), key: "actions" },
]);

async function selectWorkspace(workspaceId: string): Promise<void> {
  // 行点选 = 选中工作区（详情拉取，侧栏管理入口随角色出现；不换页）
  await props.workspaces.select(workspaceId);
}

// —— 创建（a-modal）——
const createOpen = ref(false);
const createName = ref("");
const createError = ref("");

function openCreate(): void {
  createName.value = "";
  createError.value = "";
  createOpen.value = true;
}

async function onCreate(): Promise<void> {
  const name = createName.value.trim();
  if (!name) {
    createError.value = t("ws.nameRequired");
    return;
  }
  if (name.length > 64) {
    createError.value = t("ws.nameLength");
    return;
  }
  const ok = await props.workspaces.create({ name });
  if (ok) createOpen.value = false; // store 已自动刷新清单
}

// —— 删除（受控 a-modal：二次输入工作区名确认，不可逆操作强化）——
const deleteTarget = ref<AdminWorkspaceSummary | null>(null);
const deleteName = ref("");

function openDelete(record: AdminWorkspaceSummary): void {
  deleteTarget.value = record;
  deleteName.value = "";
}

function cancelDelete(): void {
  deleteTarget.value = null;
}

const deleteConfirmed = computed(() => deleteTarget.value !== null && deleteName.value === deleteTarget.value.name);

async function onDelete(): Promise<void> {
  if (!deleteConfirmed.value || deleteTarget.value === null) return;
  const ok = await props.workspaces.remove(deleteTarget.value.id);
  if (ok) cancelDelete(); // store 已自动刷新清单；失败保留窗体便于重试/看到错误
}
</script>

<template>
  <div class="ws-view" data-testid="workspaces-view">
    <div class="ws-toolbar">
      <h2 class="ws-title">{{ t("ws.listTitle") }}</h2>
      <a-button type="primary" data-testid="ws-create-open" @click="openCreate">{{ t("ws.create") }}</a-button>
    </div>

    <!-- api 错误通道（清单/创建/删除共享 store.error；模态内另有就近呈现） -->
    <a-alert
      v-if="workspaces.error"
      class="ws-api-error"
      type="error"
      show-icon
      :message="t('ws.error')"
      :description="workspaces.error"
      data-testid="ws-error"
    />

    <a-table
      :columns="columns"
      :data-source="workspaces.list"
      row-key="id"
      :pagination="false"
      :loading="workspaces.loading"
      data-testid="ws-table"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'name'">
          <a-button type="link" class="ws-name" data-testid="ws-open" @click="selectWorkspace(record.id)">
            {{ record.name }}
          </a-button>
        </template>
        <template v-else-if="column.key === 'actions'">
          <a-button
            v-if="record.myRole === 'OWNER'"
            danger
            size="small"
            data-testid="ws-delete"
            @click="openDelete(record as AdminWorkspaceSummary)"
          >
            {{ t("ws.delete") }}
          </a-button>
        </template>
      </template>
    </a-table>

    <!-- 创建工作区 -->
    <a-modal v-if="createOpen" :open="createOpen" :title="t('ws.createTitle')" data-testid="ws-create-modal" @cancel="createOpen = false">
      <a-input
        v-model:value="createName"
        data-testid="ws-create-name"
        :placeholder="t('ws.name')"
        @press-enter="onCreate"
      />
      <div v-if="createError" class="form-error" data-testid="ws-create-error">{{ createError }}</div>
      <a-alert
        v-if="workspaces.error"
        class="modal-api-error"
        type="error"
        show-icon
        :message="t('ws.error')"
        :description="workspaces.error"
        data-testid="ws-create-api-error"
      />
      <template #footer>
        <a-button data-testid="ws-create-cancel" @click="createOpen = false">{{ t("common.cancel") }}</a-button>
        <a-button type="primary" :loading="workspaces.submitting" data-testid="ws-create-submit" @click="onCreate">
          {{ t("ws.submitCreate") }}
        </a-button>
      </template>
    </a-modal>

    <!-- 删除工作区（不可逆）：二次输入工作区名确认，名字不匹配禁确定 -->
    <a-modal v-if="deleteTarget !== null" :open="true" :title="t('ws.deleteTitle')" data-testid="ws-delete-modal" @cancel="cancelDelete">
      <p class="delete-hint">{{ t("ws.deleteHint", { name: deleteTarget.name }) }}</p>
      <a-input v-model:value="deleteName" data-testid="ws-delete-name" :placeholder="t('ws.deleteNamePlaceholder')" />
      <a-alert
        v-if="workspaces.error"
        class="modal-api-error"
        type="error"
        show-icon
        :message="t('ws.error')"
        :description="workspaces.error"
        data-testid="ws-delete-api-error"
      />
      <template #footer>
        <a-button data-testid="ws-delete-cancel" @click="cancelDelete">{{ t("common.cancel") }}</a-button>
        <a-button
          danger
          type="primary"
          :disabled="!deleteConfirmed"
          :loading="workspaces.submitting"
          data-testid="ws-delete-confirm"
          @click="onDelete"
        >
          {{ t("ws.deleteConfirm") }}
        </a-button>
      </template>
    </a-modal>
  </div>
</template>

<style scoped>
.ws-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.ws-title {
  margin: 0;
  font-size: 16px;
}
.ws-name {
  padding: 0;
}
.form-error {
  margin-top: 8px;
  color: #cf1322;
  font-size: 12px;
}
.modal-api-error {
  margin-top: 8px;
  font-size: 12px;
}
.ws-api-error {
  margin-bottom: 16px;
}
.delete-hint {
  font-size: 13px;
}
</style>

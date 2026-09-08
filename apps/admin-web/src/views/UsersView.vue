<script setup lang="ts">
/**
 * 用户管理视图（任务 5，超管专属）：a-table 清单（username/displayName/平台角色 a-tag 色分/状态
 * a-tag/createdAt + 操作列：重置密码、停用|启用）；创建 a-modal（username/password/displayName，
 * 本地校验同注册口径——用户名 3-32 [a-zA-Z0-9_-]、密码 ≥8、显示名称 1-32 非空白，client 校验为
 * 第二道防线；api 错误在 Modal 内就近呈现、失败不关窗）；重置密码受控 a-modal（newPassword ≥8，
 * 成功关窗）。停用/启用为行内直接动作（成功后清单自动刷新——disabled 状态随行切换按钮；api 错误
 * 走页顶 error 通道）。错误通道按呈现面拆分（workspaces store 先例）：error=清单/行内动作、
 * actionError=弹窗内。组件内零工厂调用：users 经路由 props 注入。
 */
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Alert as AAlert, Button as AButton, Input as AInput, Modal as AModal, Table as ATable, Tag as ATag } from "ant-design-vue";
import type { AdminAccount } from "../api/contract.js";
import type { UsersStore } from "../stores/users.js";

const props = defineProps<{ users: UsersStore }>();
const { t } = useI18n();

onMounted(() => {
  void props.users.refresh(); // 挂载即拉清单（workspaces 列表同口径）
});

const columns = computed(() => [
  { title: t("users.colUsername"), dataIndex: "username", key: "username" },
  { title: t("users.colDisplayName"), dataIndex: "displayName", key: "displayName" },
  { title: t("users.colRole"), dataIndex: "role", key: "role" },
  { title: t("users.colStatus"), key: "status" },
  { title: t("users.colCreatedAt"), dataIndex: "createdAt", key: "createdAt" },
  { title: t("users.colActions"), key: "actions" },
]);

/** a-tag 色分（域内枚举值原样呈现，不翻译）。 */
const ROLE_COLORS: Record<string, string> = { SUPERADMIN: "red", USER: "geekblue" };

// —— 创建账号（a-modal，本地校验同注册口径）——
const createOpen = ref(false);
const createUsername = ref("");
const createPassword = ref("");
const createDisplayName = ref("");
const createError = ref("");

/** 注册用户名规则（契约 §3.1：3-32 字符 [a-zA-Z0-9_-]，LoginView 同款）。 */
const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/;

function openCreate(): void {
  createUsername.value = "";
  createPassword.value = "";
  createDisplayName.value = "";
  createError.value = "";
  props.users.actionError = null; // 弹窗内错误通道复位（workspaces 先例）
  createOpen.value = true;
}

async function onCreate(): Promise<void> {
  const username = createUsername.value.trim();
  if (!USERNAME_PATTERN.test(username)) {
    createError.value = t(username ? "login.usernameInvalid" : "login.usernameRequired");
    return;
  }
  if (createPassword.value.length < 8) {
    createError.value = t("login.passwordMin");
    return;
  }
  const display = createDisplayName.value.trim();
  if (display.length < 1 || display.length > 32) {
    createError.value = t("login.displayNameInvalid");
    return;
  }
  const ok = await props.users.create({ username, password: createPassword.value, displayName: display });
  if (ok) createOpen.value = false; // store 已自动刷新清单
}

// —— 重置密码（受控 a-modal）——
const resetTarget = ref<AdminAccount | null>(null);
const resetPassword = ref("");
const resetError = ref("");

function openReset(record: AdminAccount): void {
  resetTarget.value = record;
  resetPassword.value = "";
  resetError.value = "";
  props.users.actionError = null; // 弹窗内错误通道复位
}

function cancelReset(): void {
  resetTarget.value = null;
}

async function onReset(): Promise<void> {
  if (resetTarget.value === null) return;
  if (resetPassword.value.length < 8) {
    resetError.value = t("login.passwordMin");
    return;
  }
  const ok = await props.users.resetPassword(resetTarget.value.id, resetPassword.value);
  if (ok) cancelReset(); // 失败保留窗体便于重试/看到错误
}
</script>

<template>
  <div class="users-view" data-testid="users-view">
    <div class="users-toolbar">
      <h2 class="users-title">{{ t("users.title") }}</h2>
      <a-button type="primary" data-testid="users-create" @click="openCreate">{{ t("users.create") }}</a-button>
    </div>

    <!-- api 错误通道（清单/行内动作共享 store.error；弹窗内另有就近呈现） -->
    <a-alert
      v-if="users.error"
      class="users-api-error"
      type="error"
      show-icon
      :message="t('users.error')"
      :description="users.error"
      data-testid="users-error"
    />

    <a-table
      :columns="columns"
      :data-source="users.items"
      row-key="id"
      :pagination="false"
      :loading="users.loading"
      data-testid="users-table"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'role'">
          <a-tag :color="ROLE_COLORS[record.role as string]">{{ record.role }}</a-tag>
        </template>
        <template v-else-if="column.key === 'status'">
          <a-tag v-if="record.disabled" color="red">{{ t("users.statusDisabled") }}</a-tag>
          <a-tag v-else color="green">{{ t("users.statusActive") }}</a-tag>
        </template>
        <template v-else-if="column.key === 'actions'">
          <div class="row-actions">
            <a-button
              size="small"
              :loading="users.busyId === record.id"
              :data-testid="`user-reset-${record.id}`"
              @click="openReset(record as AdminAccount)"
            >
              {{ t("users.resetPassword") }}
            </a-button>
            <a-button
              v-if="!record.disabled"
              danger
              size="small"
              :loading="users.busyId === record.id"
              :data-testid="`user-disable-${record.id}`"
              @click="props.users.setDisabled(record.id, true)"
            >
              {{ t("users.disable") }}
            </a-button>
            <a-button
              v-else
              size="small"
              :loading="users.busyId === record.id"
              :data-testid="`user-enable-${record.id}`"
              @click="props.users.setDisabled(record.id, false)"
            >
              {{ t("users.enable") }}
            </a-button>
          </div>
        </template>
      </template>
    </a-table>

    <!-- 创建账号 -->
    <a-modal v-if="createOpen" :open="createOpen" :title="t('users.createTitle')" data-testid="users-create-modal" @cancel="createOpen = false">
      <a-input
        v-model:value="createUsername"
        data-testid="users-form-username"
        :placeholder="t('login.username')"
        @press-enter="onCreate"
      />
      <a-input
        v-model:value="createPassword"
        class="form-gap"
        data-testid="users-form-password"
        :placeholder="t('login.password')"
        @press-enter="onCreate"
      />
      <a-input
        v-model:value="createDisplayName"
        class="form-gap"
        data-testid="users-form-display"
        :placeholder="t('login.displayName')"
        @press-enter="onCreate"
      />
      <div v-if="createError" class="form-error" data-testid="users-form-error">{{ createError }}</div>
      <a-alert
        v-if="users.actionError"
        class="modal-api-error"
        type="error"
        show-icon
        :message="t('users.error')"
        :description="users.actionError"
        data-testid="users-form-api-error"
      />
      <template #footer>
        <a-button data-testid="users-form-cancel" @click="createOpen = false">{{ t("common.cancel") }}</a-button>
        <a-button type="primary" :loading="users.submitting" data-testid="users-form-save" @click="onCreate">
          {{ t("users.submitCreate") }}
        </a-button>
      </template>
    </a-modal>

    <!-- 重置密码（受控） -->
    <a-modal v-if="resetTarget !== null" :open="true" :title="t('users.resetTitle', { user: resetTarget.displayName })" data-testid="users-reset-modal" @cancel="cancelReset">
      <p class="reset-hint" data-testid="users-reset-hint">{{ t("users.resetHint", { user: resetTarget.username }) }}</p>
      <a-input
        v-model:value="resetPassword"
        data-testid="users-reset-password"
        :placeholder="t('users.newPassword')"
        @press-enter="onReset"
      />
      <div v-if="resetError" class="form-error" data-testid="users-reset-error">{{ resetError }}</div>
      <a-alert
        v-if="users.actionError"
        class="modal-api-error"
        type="error"
        show-icon
        :message="t('users.error')"
        :description="users.actionError"
        data-testid="users-reset-api-error"
      />
      <template #footer>
        <a-button data-testid="users-reset-cancel" @click="cancelReset">{{ t("common.cancel") }}</a-button>
        <a-button
          type="primary"
          :loading="users.busyId === resetTarget.id"
          data-testid="users-reset-save"
          @click="onReset"
        >
          {{ t("users.submitReset") }}
        </a-button>
      </template>
    </a-modal>
  </div>
</template>

<style scoped>
.users-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.users-title {
  margin: 0;
  font-size: 16px;
}
.users-api-error {
  margin-bottom: 16px;
}
.row-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.form-gap {
  margin-top: 8px;
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
.reset-hint {
  margin: 0 0 8px;
  font-size: 13px;
}
</style>

<script setup lang="ts">
/**
 * 成员管理视图（M4-A 任务 4，裁定 A/B/C/D6）：成员清单（displayName/username/role a-tag 色分
 * + 操作列）；改角色（a-select 即改，OWNER 行禁用——D6 体验层，后端 403 为准）；移除
 * （a-popconfirm 确认，OWNER 行禁用）；添加成员（userId + 角色——§3.2 PUT 对非成员即创建行；
 * 后端按 userId 寻址，契约无按名查 id 端点，输入框只接受 userId，placeholder 说明）；OWNER
 * 转让（把成员角色改为 OWNER）弹受控确认 a-modal（输入工作区名，文案明示自身降为 ADMIN 且
 * 不可逆，任务 3 受控弹窗先例）。403 直达 URL → membersError 上屏 + 弹回 /workspaces（列表页
 * 可见原因，裁定 C）；其他后端错误码（owner_immutable 等）→ 顶部 membersError alert（选顶部
 * alert 而非行级提示：单通道单呈现面，实现最干净，报告注明）。组件内零工厂调用：workspaces
 * 经路由 props 注入。
 */
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { Alert as AAlert, Button as AButton, Input as AInput, Modal as AModal, Popconfirm as APopconfirm, Select as ASelect, Table as ATable, Tag as ATag } from "ant-design-vue";
import type { AdminMember, AdminRole } from "../api/contract.js";
import type { WorkspacesStore } from "../stores/workspaces.js";

const props = defineProps<{ workspaces: WorkspacesStore }>();
const { t } = useI18n();
const route = useRoute();
const router = useRouter();

/** 路由参数工作区 id（成员页数据寻址）。 */
const workspaceId = computed(() => (typeof route.params.id === "string" ? route.params.id : ""));

onMounted(async () => {
  const res = await props.workspaces.loadMembers(workspaceId.value);
  if (!res.ok && res.forbidden) {
    // 403 直达（非 ADMIN）：错误已同步列表页 error 通道，弹回 /workspaces（裁定 C）
    await router.push({ name: "workspaces" });
  }
});

const columns = computed(() => [
  { title: t("members.colDisplayName"), dataIndex: "displayName", key: "displayName" },
  { title: t("members.colUsername"), dataIndex: "username", key: "username" },
  { title: t("members.colRole"), dataIndex: "role", key: "role" },
  { title: t("members.colActions"), key: "actions" },
]);

/** a-tag 色分（域内枚举值原样呈现，不翻译）。 */
const ROLE_COLORS: Record<AdminRole, string> = { OWNER: "gold", ADMIN: "geekblue", EDITOR: "green", VIEWER: "default" };
const ROLE_OPTIONS: AdminRole[] = ["OWNER", "ADMIN", "EDITOR", "VIEWER"];

function isOwnerRow(member: AdminMember): boolean {
  return member.role === "OWNER";
}

async function onRoleChange(member: AdminMember, role: AdminRole): Promise<void> {
  if (role === member.role) return; // 未变化不发请求
  if (role === "OWNER") {
    // OWNER 转让：受控确认（裁定 B），确认后才 PUT
    transferTarget.value = member;
    transferName.value = "";
    return;
  }
  await props.workspaces.changeRole(workspaceId.value, member.userId, role);
}

// —— OWNER 转让受控确认（裁定 B）——
const transferTarget = ref<AdminMember | null>(null);
const transferName = ref("");

function cancelTransfer(): void {
  transferTarget.value = null;
  transferName.value = "";
}

const transferConfirmed = computed(() => transferTarget.value !== null && transferName.value === props.workspaces.current?.name);

async function onTransferConfirm(): Promise<void> {
  if (!transferConfirmed.value || transferTarget.value === null) return;
  const ok = await props.workspaces.changeRole(workspaceId.value, transferTarget.value.userId, "OWNER");
  if (ok) cancelTransfer(); // 成功后 current 已重选（自身降为 ADMIN），Layout 显隐随响应式联动
}

async function onRemove(userId: string): Promise<void> {
  await props.workspaces.removeMember(workspaceId.value, userId);
  removeTargetUserId.value = null; // 确认后收起气泡（受控 open）
}

// —— 添加成员（裁定 A：userId 直填；§3.2 PUT 对非成员即创建）——
const addUserId = ref("");
const addRole = ref<AdminRole>("VIEWER");
const addError = ref("");

/** 移除气泡受控 open（antd-vue 气泡在 jsdom 惰性渲染不展开，受控模式可测且交互确定）。 */
const removeTargetUserId = ref<string | null>(null);

// data-* 为 HTML 透传属性，antd 按钮 props 类型未建模（desktop ConfirmDialog 同款断言口径）。
const removeOkButtonProps: Record<string, any> = { "data-testid": "members-remove-confirm" };

async function onAdd(): Promise<void> {
  const userId = addUserId.value.trim();
  if (!userId) {
    addError.value = t("members.userIdRequired");
    return;
  }
  const ok = await props.workspaces.addMember(workspaceId.value, userId, addRole.value);
  if (ok) {
    addUserId.value = "";
    addRole.value = "VIEWER";
  }
}
</script>

<template>
  <div class="members-view" data-testid="members-view">
    <h2 class="members-title">{{ t("members.title") }}</h2>

    <!-- 成员面错误通道（顶部 alert；owner_immutable 等，裁定 C） -->
    <a-alert
      v-if="workspaces.membersError"
      class="members-api-error"
      type="error"
      show-icon
      :message="t('members.error')"
      :description="workspaces.membersError"
      data-testid="members-error"
    />

    <!-- 添加成员：userId + 角色（§3.2 PUT 对非成员即创建行） -->
    <div class="add-row" data-testid="members-add">
      <a-input
        v-model:value="addUserId"
        class="add-userid"
        data-testid="members-add-userid"
        :placeholder="t('members.userIdPlaceholder')"
        @press-enter="onAdd"
      />
      <a-select
        v-model:value="addRole"
        class="add-role"
        data-testid="members-add-role"
        :options="ROLE_OPTIONS.map((r) => ({ value: r, label: r }))"
      />
      <a-button type="primary" :loading="workspaces.memberSubmitting" data-testid="members-add-submit" @click="onAdd">
        {{ t("members.addSubmit") }}
      </a-button>
    </div>
    <div v-if="addError" class="form-error" data-testid="members-add-error">{{ addError }}</div>

    <a-table
      :columns="columns"
      :data-source="workspaces.members"
      row-key="userId"
      :pagination="false"
      :loading="workspaces.membersLoading || workspaces.currentLoading"
      data-testid="members-table"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'role'">
          <a-tag :color="ROLE_COLORS[record.role as AdminRole]">{{ record.role }}</a-tag>
        </template>
        <template v-else-if="column.key === 'actions'">
          <div class="row-actions">
            <a-select
              :value="record.role"
              :disabled="isOwnerRow(record as AdminMember)"
              :loading="workspaces.memberBusyId === record.userId"
              size="small"
              class="role-select"
              :data-testid="`members-role-${record.userId}`"
              :options="ROLE_OPTIONS.map((r) => ({ value: r, label: r }))"
              @change="(value) => onRoleChange(record as AdminMember, value as AdminRole)"
            />
            <a-popconfirm
              :title="t('members.removeTitle')"
              :ok-text="t('members.removeOk')"
              :cancel-text="t('common.cancel')"
              :open="removeTargetUserId === record.userId"
              :ok-button-props="removeOkButtonProps"
              @confirm="onRemove(record.userId)"
              @cancel="removeTargetUserId = null"
            >
              <a-button
                danger
                size="small"
                :disabled="isOwnerRow(record as AdminMember)"
                :data-testid="`members-remove-${record.userId}`"
                @click="removeTargetUserId = record.userId"
              >
                {{ t("members.remove") }}
              </a-button>
            </a-popconfirm>
          </div>
        </template>
      </template>
    </a-table>

    <!-- OWNER 转让受控确认（裁定 B）：输入工作区名，明示自身降为 ADMIN 且不可逆 -->
    <a-modal v-if="transferTarget !== null" :open="true" :title="t('members.transferTitle')" @cancel="cancelTransfer">
      <p class="transfer-hint" data-testid="members-transfer-hint">
        {{ t("members.transferHint", { user: transferTarget.displayName, name: workspaces.current?.name ?? "" }) }}
      </p>
      <a-input v-model:value="transferName" data-testid="members-transfer-name" :placeholder="t('ws.deleteNamePlaceholder')" />
      <template #footer>
        <a-button data-testid="members-transfer-cancel" @click="cancelTransfer">{{ t("common.cancel") }}</a-button>
        <a-button
          danger
          type="primary"
          :disabled="!transferConfirmed"
          :loading="workspaces.memberBusyId !== null"
          data-testid="members-transfer-confirm"
          @click="onTransferConfirm"
        >
          {{ t("members.transferConfirm") }}
        </a-button>
      </template>
    </a-modal>
  </div>
</template>

<style scoped>
.members-title {
  margin: 0 0 16px;
  font-size: 16px;
}
.members-api-error {
  margin-bottom: 16px;
}
.add-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
}
.add-userid {
  width: 240px;
}
.add-role {
  width: 120px;
}
.form-error {
  margin-bottom: 8px;
  color: #cf1322;
  font-size: 12px;
}
.row-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.role-select {
  width: 110px;
}
.transfer-hint {
  font-size: 13px;
}
</style>

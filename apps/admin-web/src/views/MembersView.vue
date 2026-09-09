<script setup lang="ts">
/**
 * 成员管理视图（M4-A 任务 4，裁定 A/B/C/D6）：成员清单（displayName/username/role a-tag 色分
 * + 操作列）；改角色（a-select 即改，OWNER 行禁用——D6 体验层，后端 403 为准）；移除
 * （a-popconfirm 确认，OWNER 行禁用）；添加成员（规格 2026-09-09：用户名搜索下拉——内部 id
 * 不许手输（先例级教训），a-auto-complete 接 userPicker（成员+非成员候选合并，候选远搜
 * debounce 300ms），选中 username 提交时解析为 userId，§3.2 PUT 对非成员即创建行；角色下拉
 * 排除 OWNER——非成员直接授 OWNER 走不到转让确认，任务 5 审查顺修）；OWNER
 * 转让（把成员角色改为 OWNER）弹受控确认 a-modal（输入工作区名，文案明示自身降为 ADMIN 且
 * 不可逆，任务 3 受控弹窗先例；转让失败错误经 membersError 在 Modal 内就近呈现）。403 直达
 * URL → membersError 上屏 + 弹回 /workspaces（原因仅在成员面通道，列表页不重复呈现——任务 5
 * 审查注释更正）；成员清单随路由参数变化重拉（终审 Important 1）；其他后端错误码
 * （owner_immutable 等）→ 顶部 membersError alert（选顶部
 * alert 而非行级提示：单通道单呈现面，实现最干净，报告注明）；候选搜索失败经 candidatesError
 * 在添加行下方就地上屏。组件内零工厂调用：workspaces 经路由 props 注入。
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { Alert as AAlert, AutoComplete as AAutoComplete, Button as AButton, Input as AInput, Modal as AModal, Popconfirm as APopconfirm, Select as ASelect, Table as ATable, Tag as ATag } from "ant-design-vue";
import type { AdminMember, AdminRole } from "../api/contract.js";
import { createUserPicker } from "../composables/userPicker.js";
import type { WorkspacesStore } from "../stores/workspaces.js";

const props = defineProps<{ workspaces: WorkspacesStore }>();
const { t } = useI18n();
const route = useRoute();
const router = useRouter();

/** 路由参数工作区 id（成员页数据寻址）。 */
const workspaceId = computed(() => (typeof route.params.id === "string" ? route.params.id : ""));

/**
 * 成员清单随路由参数变化重拉（终审 Important 1）：同路由记录参数变化复用组件实例、不重跑
 * onMounted——immediate watch 兼顾首载；403 弹回逻辑复用（ProjectAclView 同款姊妹口径）。
 */
watch(
  workspaceId,
  async (id) => {
    if (!id) return;
    const res = await props.workspaces.loadMembers(id);
    if (!res.ok && res.forbidden) {
      // 403 直达（非 ADMIN）：原因入 membersError（仅成员面通道呈现，不外溢列表页），弹回 /workspaces（裁定 C）
      await router.push({ name: "workspaces" });
    }
  },
  { immediate: true },
);

const columns = computed(() => [
  { title: t("members.colDisplayName"), dataIndex: "displayName", key: "displayName" },
  { title: t("members.colUsername"), dataIndex: "username", key: "username" },
  { title: t("members.colRole"), dataIndex: "role", key: "role" },
  { title: t("members.colActions"), key: "actions" },
]);

/** a-tag 色分（域内枚举值原样呈现，不翻译）。 */
const ROLE_COLORS: Record<AdminRole, string> = { OWNER: "gold", ADMIN: "geekblue", EDITOR: "green", VIEWER: "default" };
const ROLE_OPTIONS: AdminRole[] = ["OWNER", "ADMIN", "EDITOR", "VIEWER"];
/** 添加成员角色下拉排除 OWNER（任务 5 审查顺修·重要）：非成员直接授 OWNER 走不到转让确认；
 * 授 OWNER 唯一路径 = 行内改角色触发的受控确认（裁定 B）。 */
const ADD_ROLE_OPTIONS: AdminRole[] = ["ADMIN", "EDITOR", "VIEWER"];

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

// —— 添加成员（规格 2026-09-09：用户名搜索下拉，id 不再手输——先例级教训）——
// composable 返回的 refs 在 script 顶层解构后保持响应式，template 自动解包（v-model 可直接绑定）。
const { username: addUserName, options: candidateOptions, onSearch: onSearchUser, resolveId, reset: resetPicker } = createUserPicker(props.workspaces, workspaceId);
const addRole = ref<AdminRole>("VIEWER");
const addError = ref("");

/** 移除气泡受控 open（antd-vue 气泡在 jsdom 惰性渲染不展开，受控模式可测且交互确定）。 */
const removeTargetUserId = ref<string | null>(null);

// data-* 为 HTML 透传属性，antd 按钮 props 类型未建模（desktop ConfirmDialog 同款断言口径）。
const removeOkButtonProps: Record<string, any> = { "data-testid": "members-remove-confirm" };

async function onAdd(): Promise<void> {
  const userId = resolveId();
  if (!userId) {
    addError.value = t("members.selectUserRequired");
    return;
  }
  const ok = await props.workspaces.addMember(workspaceId.value, userId, addRole.value);
  if (ok) {
    resetPicker();
    props.workspaces.clearCandidates();
    addRole.value = "VIEWER";
    addError.value = ""; // 成功后复位本地校验错误（任务 4 审查顺修）
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

    <!-- 添加成员：用户名搜索下拉（userPicker 合并成员+候选；提交解析为 userId）+ 角色（§3.2 PUT 对非成员即创建行） -->
    <div class="add-row" data-testid="members-add">
      <a-auto-complete
        v-model:value="addUserName"
        class="add-userid"
        data-testid="members-add-user"
        :options="candidateOptions"
        :placeholder="t('members.searchPlaceholder')"
        @search="onSearchUser"
      />
      <a-select
        v-model:value="addRole"
        class="add-role"
        data-testid="members-add-role"
        :options="ADD_ROLE_OPTIONS.map((r) => ({ value: r, label: r }))"
      />
      <a-button type="primary" :loading="workspaces.memberSubmitting" data-testid="members-add-submit" @click="onAdd">
        {{ t("members.addSubmit") }}
      </a-button>
    </div>
    <div v-if="addError" class="form-error" data-testid="members-add-error">{{ addError }}</div>
    <!-- 候选搜索失败就地上屏（与顶部 membersError 分通道，互不覆盖） -->
    <div v-if="workspaces.candidatesError" class="form-error" data-testid="members-candidates-error">{{ workspaces.candidatesError }}</div>

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
              @open-change="(open: boolean) => { if (!open) removeTargetUserId = null; }"
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
      <!-- 转让失败错误就近呈现（任务 4 审查备案顺手项：Modal 遮罩会挡住页面级 alert） -->
      <div v-if="workspaces.membersError" class="form-error" data-testid="members-transfer-error">{{ workspaces.membersError }}</div>
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

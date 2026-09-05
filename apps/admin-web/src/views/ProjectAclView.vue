<script setup lang="ts">
/**
 * 项目 ACL 管理视图（M4-A 任务 5，裁定 A/B/C/D6）：顶部项目选择（来自 tree.projects 清单，
 * 选项显式展示 name+path+myRole——契约修订 2026-09-03 path 必显；无读权限项目天然不在清单，
 * 服务端已滤）；ACL 行表（userId/role + 操作：改角色 a-select 即改含 NONE、删行 popconfirm）。
 * **NONE 与删行语义显式区分（裁定 B/i18n 审校点）**：NONE=明确拒绝（行仍在、显示「拒绝访问
 * （NONE）」）；删行=恢复工作区角色继承（独立按钮 + popconfirm 文案说明，DELETE ?userId=）。
 * 添加行：userId 从成员列表下拉建议 + 支持手输非成员 userId（§3.3 ACL 可预设，D5 语义；
 * a-auto-complete 自由输入）；角色域 NONE/VIEWER/EDITOR/ADMIN（无 OWNER——ACL 角色域即如此）。
 * 失败 → aclError 顶部 alert 单通道。组件内零工厂调用：workspaces 经子路由 props 注入。
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { Alert as AAlert, AutoComplete as AAutoComplete, Button as AButton, Input as AInput, Popconfirm as APopconfirm, Select as ASelect, Table as ATable, Tag as ATag } from "ant-design-vue";
import type { AdminAclRole } from "../api/contract.js";
import type { WorkspacesStore } from "../stores/workspaces.js";

const props = defineProps<{ workspaces: WorkspacesStore }>();
const { t } = useI18n();
const route = useRoute();

/** 路由参数工作区 id（ACL 页数据寻址）。 */
const workspaceId = computed(() => (typeof route.params.id === "string" ? route.params.id : ""));

const projects = computed(() => props.workspaces.tree?.projects ?? []);
const selectedProjectId = ref<string | null>(null);
const selectedProject = computed(() => projects.value.find((p) => p.id === selectedProjectId.value) ?? null);

// —— 添加行状态（声明先于 immediate watch：watch 回调首航即复位这些输入）——
const addUserId = ref("");
const addRole = ref<AdminAclRole>("VIEWER");
const addError = ref("");

// 路由参数驱动：进页/切工作区 → 拉树（项目清单）+ 拉成员清单（添加行下拉建议，任务 4 审查
// 备案 4 口径：依赖选中工作区的数据随路由参数变化重拉）；添加行输入随切换复位（终审顺手⑦）。
watch(
  workspaceId,
  (id) => {
    if (!id) return;
    selectedProjectId.value = null;
    addUserId.value = "";
    addRole.value = "VIEWER";
    addError.value = "";
    void props.workspaces.loadTree(id);
    void props.workspaces.loadMembers(id);
  },
  { immediate: true },
);

// 树到达后默认选第一个项目；已选项目不在树中（被滤/工作区切换）→ 回退第一个。
watch(
  () => props.workspaces.tree,
  (tree) => {
    if (!tree) return;
    if (!selectedProjectId.value || !tree.projects.some((p) => p.id === selectedProjectId.value)) {
      selectedProjectId.value = tree.projects[0]?.id ?? null;
    }
  },
);

watch(selectedProjectId, (projectId) => {
  addUserId.value = "";
  addRole.value = "VIEWER";
  addError.value = ""; // 添加行输入随项目切换复位（终审顺手⑦）
  if (projectId && workspaceId.value) void props.workspaces.loadAcl(workspaceId.value, projectId);
});

const projectOptions = computed(() =>
  projects.value.map((p) => ({ value: p.id, label: `${p.name}（${p.path}）· ${t("acl.myRoleLabel")}: ${p.myRole}` })),
);

/** ACL 角色域（§3.3）：NONE 标签文案显式（裁定 B）；域内无 OWNER。 */
const ACL_ROLE_OPTIONS = computed(() => [
  { value: "NONE", label: t("acl.roleNone") },
  { value: "VIEWER", label: "VIEWER" },
  { value: "EDITOR", label: "EDITOR" },
  { value: "ADMIN", label: "ADMIN" },
]);

/** a-tag 色分（NONE 显式红色以区别继承态，裁定 B）。 */
const ROLE_COLORS: Record<AdminAclRole, string> = { NONE: "red", VIEWER: "default", EDITOR: "green", ADMIN: "geekblue" };

function roleLabel(role: AdminAclRole): string {
  return role === "NONE" ? t("acl.roleNone") : role;
}

const columns = computed(() => [
  { title: t("acl.colUserId"), dataIndex: "userId", key: "userId" },
  { title: t("acl.colRole"), dataIndex: "role", key: "role" },
  { title: t("acl.colActions"), key: "actions" },
]);

async function onRoleChange(userId: string, role: AdminAclRole): Promise<void> {
  if (!workspaceId.value || !selectedProjectId.value) return;
  const current = props.workspaces.aclEntries.find((e) => e.userId === userId);
  if (current?.role === role) return; // 未变化不发请求
  await props.workspaces.setAclEntry(workspaceId.value, selectedProjectId.value, { userId, role });
}

// —— 删行（受控 popconfirm，同 MembersView 先例；文案说明恢复继承，裁定 B）——
const removeRowUserId = ref<string | null>(null);

// data-* 为 HTML 透传属性，antd 按钮 props 类型未建模（desktop ConfirmDialog 同款断言口径）。
const deleteOkButtonProps: Record<string, any> = { "data-testid": "acl-delete-confirm" };

async function onRemoveRow(userId: string): Promise<void> {
  if (!workspaceId.value || !selectedProjectId.value) return;
  await props.workspaces.removeAclEntry(workspaceId.value, selectedProjectId.value, userId);
  removeRowUserId.value = null;
}

// —— 添加行（裁定 A：成员下拉建议 + 手输非成员 userId；§3.3 ACL 可预设）——
const memberOptions = computed(() =>
  props.workspaces.members.map((m) => ({ value: m.userId, label: `${m.displayName}（${m.username}）` })),
);

async function onAdd(): Promise<void> {
  const userId = addUserId.value.trim();
  if (!userId) {
    addError.value = t("acl.userIdRequired");
    return;
  }
  if (!workspaceId.value || !selectedProjectId.value) return;
  const ok = await props.workspaces.addAclEntry(workspaceId.value, selectedProjectId.value, { userId, role: addRole.value });
  if (ok) {
    addUserId.value = "";
    addRole.value = "VIEWER";
    addError.value = "";
  }
}
</script>

<template>
  <div class="acl-view" data-testid="acl-view">
    <h2 class="acl-title">{{ t("acl.title") }}</h2>

    <a-alert
      v-if="workspaces.aclError"
      class="acl-api-error"
      type="error"
      show-icon
      :message="t('acl.error')"
      :description="workspaces.aclError"
      data-testid="acl-error"
    />

    <!-- 项目选择（tree.projects；name+path+myRole 显式，裁定 A/C） -->
    <div class="project-row">
      <span class="project-label">{{ t("acl.projectLabel") }}</span>
      <a-select
        class="project-select"
        :value="selectedProjectId ?? undefined"
        :options="projectOptions"
        data-testid="acl-project-select"
        @update:value="(v) => (selectedProjectId = v as string)"
      />
      <span v-if="selectedProject" class="project-myrole" data-testid="acl-project-myrole">
        {{ t("acl.myRoleLabel") }}: {{ selectedProject.myRole }}
      </span>
    </div>

    <!-- NONE 与删行的语义区分（裁定 B/i18n 审校点） -->
    <p class="none-hint" data-testid="acl-none-hint">{{ t("acl.noneHint") }}</p>

    <a-table
      :columns="columns"
      :data-source="workspaces.aclEntries"
      row-key="userId"
      :pagination="false"
      :loading="workspaces.aclLoading || workspaces.treeLoading"
      data-testid="acl-table"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'role'">
          <a-tag :color="ROLE_COLORS[record.role as AdminAclRole]">{{ roleLabel(record.role as AdminAclRole) }}</a-tag>
        </template>
        <template v-else-if="column.key === 'actions'">
          <div class="row-actions">
            <a-select
              :value="record.role"
              :loading="workspaces.aclBusyUserId === record.userId"
              size="small"
              class="role-select"
              :data-testid="`acl-role-${record.userId}`"
              :options="ACL_ROLE_OPTIONS"
              @change="(value) => onRoleChange(record.userId, value as AdminAclRole)"
            />
            <a-popconfirm
              :title="t('acl.deleteRowTitle')"
              :ok-text="t('acl.deleteRowOk')"
              :cancel-text="t('common.cancel')"
              :open="removeRowUserId === record.userId"
              :ok-button-props="deleteOkButtonProps"
              @confirm="onRemoveRow(record.userId)"
              @cancel="removeRowUserId = null"
              @open-change="(open: boolean) => { if (!open) removeRowUserId = null; }"
            >
              <a-button danger size="small" :data-testid="`acl-delete-${record.userId}`" @click="removeRowUserId = record.userId">
                {{ t("acl.deleteRow") }}
              </a-button>
            </a-popconfirm>
          </div>
        </template>
      </template>
    </a-table>

    <!-- 添加 ACL 行（成员下拉建议 + 手输非成员 userId） -->
    <div class="add-row" data-testid="acl-add">
      <a-auto-complete
        v-model:value="addUserId"
        class="add-userid"
        data-testid="acl-add-userid"
        :options="memberOptions"
        :placeholder="t('acl.userIdPlaceholder')"
      />
      <a-select
        v-model:value="addRole"
        class="add-role"
        data-testid="acl-add-role"
        :options="ACL_ROLE_OPTIONS"
      />
      <a-button type="primary" :loading="workspaces.aclSubmitting" data-testid="acl-add-submit" @click="onAdd">
        {{ t("acl.addSubmit") }}
      </a-button>
    </div>
    <div v-if="addError" class="form-error" data-testid="acl-add-error">{{ addError }}</div>
  </div>
</template>

<style scoped>
.acl-title {
  margin: 0 0 16px;
  font-size: 16px;
}
.acl-api-error {
  margin-bottom: 16px;
}
.project-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}
.project-label {
  font-size: 13px;
}
.project-select {
  width: 380px;
}
.project-myrole {
  font-size: 13px;
}
.none-hint {
  margin: 0 0 12px;
  color: #8c8c8c;
  font-size: 12px;
}
.row-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.role-select {
  width: 150px;
}
.add-row {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}
.add-userid {
  width: 240px;
}
.add-role {
  width: 150px;
}
.form-error {
  margin-top: 8px;
  color: #cf1322;
  font-size: 12px;
}
</style>

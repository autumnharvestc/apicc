<script setup lang="ts">
/**
 * 组织管理视图（任务 6，规格 2026-09-08 §4 消费面）：左分组清单（名称 + isDefault「默认」标记 +
 * 点击选中；默认组改名/删除按钮前端提前禁用——服务端 400 default_group_immutable 兜底双保险）+
 * 右项目卡片网格（按选中分组过滤；卡片沿桌面端 ProjectCard 设计思路自建简版——确定性色块头像 +
 * 项目名，不跨包引依赖）。操作全部走受控 a-modal（UsersView/ConnectionPanel 先例）：建分组/
 * 分组改名/删分组确认（group_not_empty 409 确认窗内就近上屏不关窗）、建项目（groupId 预选当前
 * 选中分组）/项目改名/移动（改选目标分组）/删项目确认。权限面：页面所有成员可读（清单端点成员
 * 可读），新建/改名/移动/删除操作按钮按 workspaces.current.myRole ∈ {OWNER, ADMIN} 显隐——
 * 服务端 guard.requireAdmin 为准（403 forbidden）。本地校验：名称 1-64 非空白（服务端
 * @NotBlank @Size(max=64) 同口径）；api 错误通道：error=清单拉取（页顶）、actionError=弹窗内
 * （打开任一弹窗即复位）。组件内零工厂调用：org/workspaces 经路由 props 注入。
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { Alert as AAlert, Button as AButton, Input as AInput, Modal as AModal, Select as ASelect, Tag as ATag } from "ant-design-vue";
import type { AdminGroup, AdminProject } from "../api/contract.js";
import type { OrgStore } from "../stores/org.js";
import type { WorkspacesStore } from "../stores/workspaces.js";

const props = defineProps<{ org: OrgStore; workspaces: WorkspacesStore }>();
const { t } = useI18n();
const route = useRoute();

/** 路由参数工作区 id（组织页数据寻址，MembersView 同款口径）。 */
const workspaceId = computed(() => (typeof route.params.id === "string" ? route.params.id : ""));

/** 清单随路由参数变化重拉（MembersView 终审 Important 1 同款：immediate watch 兼顾首载）。 */
watch(
  workspaceId,
  (id) => {
    if (id) void props.org.refresh(id);
  },
  { immediate: true },
);

/** 操作可见性：选中工作区详情 myRole ∈ {OWNER, ADMIN}（详情未拉取时隐藏防闪烁，LayoutView 裁定 A 同口径）。 */
const canManage = computed(() => {
  const role = props.workspaces.current?.myRole;
  return role === "OWNER" || role === "ADMIN";
});

// —— 选中分组（右侧项目网格过滤键）：清单变化后失选则回选默认分组（无则首个）——
const selectedGroupId = ref<string | null>(null);
watch(
  () => props.org.groups,
  (groups) => {
    if (!groups.some((g) => g.id === selectedGroupId.value)) {
      selectedGroupId.value = groups.find((g) => g.isDefault)?.id ?? groups[0]?.id ?? null;
    }
  },
  { immediate: true },
);

const selectedGroup = computed(() => props.org.groups.find((g) => g.id === selectedGroupId.value) ?? null);
const filteredProjects = computed(() => props.org.projects.filter((p) => p.groupId === selectedGroupId.value));

/** 分组下拉选项（建项目/移动项目共用）。 */
const groupOptions = computed(() => props.org.groups.map((g) => ({ value: g.id, label: g.name })));

/** 本地名称校验（服务端 @NotBlank @Size(max=64) 同口径）：非空白 + ≤64 字符。 */
function nameValidationError(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return t("org.nameRequired");
  if (trimmed.length > 64) return t("org.nameLength");
  return null;
}

/** 确定性色块头像（桌面端 ProjectCard 同思路：按 id 哈希取色，纯 CSS 零素材）。 */
const AVATAR_COLORS = ["#5b8ff9", "#5ad8a6", "#f6bd16", "#e8684a", "#6dc8ec", "#9270ca", "#ff9d4d", "#f08bb4"];
function avatarColor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

// —— 建分组（受控 a-modal）——
const groupCreateOpen = ref(false);
const groupCreateName = ref("");
const groupCreateError = ref("");

function openGroupCreate(): void {
  groupCreateName.value = "";
  groupCreateError.value = "";
  props.org.actionError = null; // 弹窗内错误通道复位（users/workspaces 先例）
  groupCreateOpen.value = true;
}

async function onGroupCreate(): Promise<void> {
  const name = groupCreateName.value.trim();
  const invalid = nameValidationError(name);
  if (invalid !== null) {
    groupCreateError.value = invalid;
    return;
  }
  const ok = await props.org.createGroup(workspaceId.value, name);
  if (ok) groupCreateOpen.value = false; // store 已自动刷新清单
}

// —— 分组改名（受控 a-modal，预填现名）——
const renameGroupTarget = ref<AdminGroup | null>(null);
const groupRenameName = ref("");
const groupRenameError = ref("");

function openGroupRename(group: AdminGroup): void {
  renameGroupTarget.value = group;
  groupRenameName.value = group.name;
  groupRenameError.value = "";
  props.org.actionError = null;
}

function cancelGroupRename(): void {
  renameGroupTarget.value = null;
}

async function onGroupRename(): Promise<void> {
  if (renameGroupTarget.value === null) return;
  const name = groupRenameName.value.trim();
  const invalid = nameValidationError(name);
  if (invalid !== null) {
    groupRenameError.value = invalid;
    return;
  }
  const ok = await props.org.renameGroup(workspaceId.value, renameGroupTarget.value.id, name);
  if (ok) cancelGroupRename(); // 失败保留窗体便于重试/看到错误
}

// —— 删分组（受控确认 a-modal；默认组按钮已禁用，此处为非默认组确认）——
const deleteGroupTarget = ref<AdminGroup | null>(null);

function openGroupDelete(group: AdminGroup): void {
  deleteGroupTarget.value = group;
  props.org.actionError = null;
}

function cancelGroupDelete(): void {
  deleteGroupTarget.value = null;
}

async function onGroupDelete(): Promise<void> {
  if (deleteGroupTarget.value === null) return;
  const ok = await props.org.deleteGroup(workspaceId.value, deleteGroupTarget.value.id);
  if (ok) cancelGroupDelete();
}

// —— 建项目（受控 a-modal；groupId 预选当前选中分组）——
const projectCreateOpen = ref(false);
const projectCreateGroupId = ref<string | undefined>(undefined);
const projectCreateName = ref("");
const projectCreateError = ref("");

function openProjectCreate(): void {
  projectCreateGroupId.value = selectedGroupId.value ?? props.org.groups[0]?.id;
  projectCreateName.value = "";
  projectCreateError.value = "";
  props.org.actionError = null;
  projectCreateOpen.value = true;
}

async function onProjectCreate(): Promise<void> {
  const name = projectCreateName.value.trim();
  const invalid = nameValidationError(name);
  if (invalid !== null) {
    projectCreateError.value = invalid;
    return;
  }
  if (!projectCreateGroupId.value) {
    projectCreateError.value = t("org.groupRequired");
    return;
  }
  const ok = await props.org.createProject(workspaceId.value, { groupId: projectCreateGroupId.value, name });
  if (ok) projectCreateOpen.value = false;
}

// —— 项目改名（受控 a-modal，预填现名）——
const renameProjectTarget = ref<AdminProject | null>(null);
const projectRenameName = ref("");
const projectRenameError = ref("");

function openProjectRename(project: AdminProject): void {
  renameProjectTarget.value = project;
  projectRenameName.value = project.name;
  projectRenameError.value = "";
  props.org.actionError = null;
}

function cancelProjectRename(): void {
  renameProjectTarget.value = null;
}

async function onProjectRename(): Promise<void> {
  if (renameProjectTarget.value === null) return;
  const name = projectRenameName.value.trim();
  const invalid = nameValidationError(name);
  if (invalid !== null) {
    projectRenameError.value = invalid;
    return;
  }
  const ok = await props.org.renameProject(workspaceId.value, renameProjectTarget.value.id, name);
  if (ok) cancelProjectRename();
}

// —— 移动项目（受控 a-modal；预选项目现分组，改选目标分组后 POST move）——
const moveProjectTarget = ref<AdminProject | null>(null);
const projectMoveGroupId = ref<string | undefined>(undefined);

function openProjectMove(project: AdminProject): void {
  moveProjectTarget.value = project;
  projectMoveGroupId.value = project.groupId;
  props.org.actionError = null;
}

function cancelProjectMove(): void {
  moveProjectTarget.value = null;
}

async function onProjectMove(): Promise<void> {
  if (moveProjectTarget.value === null || !projectMoveGroupId.value) return;
  const ok = await props.org.moveProject(workspaceId.value, moveProjectTarget.value.id, projectMoveGroupId.value);
  if (ok) cancelProjectMove();
}

// —— 删项目（受控确认 a-modal）——
const deleteProjectTarget = ref<AdminProject | null>(null);

function openProjectDelete(project: AdminProject): void {
  deleteProjectTarget.value = project;
  props.org.actionError = null;
}

function cancelProjectDelete(): void {
  deleteProjectTarget.value = null;
}

async function onProjectDelete(): Promise<void> {
  if (deleteProjectTarget.value === null) return;
  const ok = await props.org.deleteProject(workspaceId.value, deleteProjectTarget.value.id);
  if (ok) cancelProjectDelete();
}
</script>

<template>
  <div class="org-view" data-testid="org-view">
    <div class="org-toolbar">
      <h2 class="org-title">{{ t("org.title") }}</h2>
      <div v-if="canManage" class="org-toolbar-actions">
        <a-button data-testid="org-project-create" @click="openProjectCreate">{{ t("org.createProject") }}</a-button>
        <a-button type="primary" data-testid="org-group-create" @click="openGroupCreate">{{ t("org.createGroup") }}</a-button>
      </div>
    </div>

    <!-- api 错误通道（清单拉取；弹窗动作错误另有就近呈现） -->
    <a-alert
      v-if="org.error"
      class="org-api-error"
      type="error"
      show-icon
      :message="t('org.error')"
      :description="org.error"
      data-testid="org-error"
    />

    <div class="org-panes">
      <!-- 左：分组清单 -->
      <div class="org-groups" data-testid="org-groups-panel">
        <h3 class="pane-title">{{ t("org.groupsTitle") }}</h3>
        <div
          v-for="g in org.groups"
          :key="g.id"
          class="group-row"
          :class="{ active: g.id === selectedGroupId }"
          :data-testid="`org-group-item-${g.id}`"
          @click="selectedGroupId = g.id"
        >
          <span class="group-name" :title="g.name">{{ g.name }}</span>
          <a-tag v-if="g.isDefault" color="blue" class="group-default-tag" :data-testid="`org-group-default-${g.id}`">
            {{ t("org.defaultTag") }}
          </a-tag>
          <span v-if="canManage" class="group-actions" @click.stop>
            <a-button size="small" :data-testid="`org-group-rename-${g.id}`" :disabled="g.isDefault" @click="openGroupRename(g)">
              {{ t("org.renameAction") }}
            </a-button>
            <a-button size="small" danger :data-testid="`org-group-delete-${g.id}`" :disabled="g.isDefault" @click="openGroupDelete(g)">
              {{ t("org.deleteAction") }}
            </a-button>
          </span>
        </div>
        <div v-if="org.groups.length === 0 && !org.loading" class="pane-empty" data-testid="org-groups-empty">
          {{ t("org.emptyGroups") }}
        </div>
      </div>

      <!-- 右：项目卡片网格（按选中分组过滤） -->
      <div class="org-projects" data-testid="org-projects-panel">
        <h3 class="pane-title">
          {{ selectedGroup ? selectedGroup.name : t("org.projectsTitle") }}
        </h3>
        <div v-if="filteredProjects.length === 0 && !org.loading" class="pane-empty" data-testid="org-projects-empty">
          {{ t("org.emptyProjects") }}
        </div>
        <div v-else class="cards">
          <div v-for="p in filteredProjects" :key="p.id" class="project-card" :data-testid="`org-project-card-${p.id}`">
            <span class="avatar" :style="{ background: avatarColor(p.id) }">{{ (p.name || "?").slice(0, 1) }}</span>
            <span class="card-name" :title="p.name">{{ p.name }}</span>
            <span v-if="canManage" class="card-actions">
              <a-button size="small" :data-testid="`org-project-rename-${p.id}`" @click="openProjectRename(p)">
                {{ t("org.renameAction") }}
              </a-button>
              <a-button size="small" :data-testid="`org-project-move-${p.id}`" @click="openProjectMove(p)">
                {{ t("org.moveAction") }}
              </a-button>
              <a-button size="small" danger :data-testid="`org-project-delete-${p.id}`" @click="openProjectDelete(p)">
                {{ t("org.deleteAction") }}
              </a-button>
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- 建分组 -->
    <a-modal v-if="groupCreateOpen" :open="groupCreateOpen" :title="t('org.groupCreateTitle')" data-testid="org-group-create-modal" @cancel="groupCreateOpen = false">
      <a-input
        v-model:value="groupCreateName"
        data-testid="org-group-create-name"
        :placeholder="t('org.namePlaceholder')"
        @press-enter="onGroupCreate"
      />
      <div v-if="groupCreateError" class="form-error" data-testid="org-group-create-error">{{ groupCreateError }}</div>
      <a-alert
        v-if="org.actionError"
        class="modal-api-error"
        type="error"
        show-icon
        :message="t('org.error')"
        :description="org.actionError"
        data-testid="org-group-create-api-error"
      />
      <template #footer>
        <a-button data-testid="org-group-create-cancel" @click="groupCreateOpen = false">{{ t("common.cancel") }}</a-button>
        <a-button type="primary" :loading="org.submitting" data-testid="org-group-create-save" @click="onGroupCreate">
          {{ t("org.submitCreate") }}
        </a-button>
      </template>
    </a-modal>

    <!-- 分组改名（受控） -->
    <a-modal v-if="renameGroupTarget !== null" :open="true" :title="t('org.groupRenameTitle')" data-testid="org-group-rename-modal" @cancel="cancelGroupRename">
      <a-input
        v-model:value="groupRenameName"
        data-testid="org-group-rename-name"
        :placeholder="t('org.namePlaceholder')"
        @press-enter="onGroupRename"
      />
      <div v-if="groupRenameError" class="form-error" data-testid="org-group-rename-error">{{ groupRenameError }}</div>
      <a-alert
        v-if="org.actionError"
        class="modal-api-error"
        type="error"
        show-icon
        :message="t('org.error')"
        :description="org.actionError"
        data-testid="org-group-rename-api-error"
      />
      <template #footer>
        <a-button data-testid="org-group-rename-cancel" @click="cancelGroupRename">{{ t("common.cancel") }}</a-button>
        <a-button type="primary" :loading="org.submitting" data-testid="org-group-rename-save" @click="onGroupRename">
          {{ t("org.submitRename") }}
        </a-button>
      </template>
    </a-modal>

    <!-- 删分组（受控确认） -->
    <a-modal v-if="deleteGroupTarget !== null" :open="true" :title="t('org.groupDeleteTitle')" data-testid="org-group-delete-modal" @cancel="cancelGroupDelete">
      <p class="delete-hint" data-testid="org-group-delete-hint">{{ t("org.groupDeleteHint", { name: deleteGroupTarget.name }) }}</p>
      <a-alert
        v-if="org.actionError"
        class="modal-api-error"
        type="error"
        show-icon
        :message="t('org.error')"
        :description="org.actionError"
        data-testid="org-group-delete-api-error"
      />
      <template #footer>
        <a-button data-testid="org-group-delete-cancel" @click="cancelGroupDelete">{{ t("common.cancel") }}</a-button>
        <a-button danger type="primary" :loading="org.busyId === deleteGroupTarget.id" data-testid="org-group-delete-confirm" @click="onGroupDelete">
          {{ t("org.confirmDelete") }}
        </a-button>
      </template>
    </a-modal>

    <!-- 建项目（groupId 预选当前选中分组） -->
    <a-modal v-if="projectCreateOpen" :open="projectCreateOpen" :title="t('org.projectCreateTitle')" data-testid="org-project-create-modal" @cancel="projectCreateOpen = false">
      <a-select
        v-model:value="projectCreateGroupId"
        class="group-select"
        :options="groupOptions"
        :placeholder="t('org.groupPlaceholder')"
        data-testid="org-project-create-group"
      />
      <a-input
        v-model:value="projectCreateName"
        class="form-gap"
        data-testid="org-project-create-name"
        :placeholder="t('org.namePlaceholder')"
        @press-enter="onProjectCreate"
      />
      <div v-if="projectCreateError" class="form-error" data-testid="org-project-create-error">{{ projectCreateError }}</div>
      <a-alert
        v-if="org.actionError"
        class="modal-api-error"
        type="error"
        show-icon
        :message="t('org.error')"
        :description="org.actionError"
        data-testid="org-project-create-api-error"
      />
      <template #footer>
        <a-button data-testid="org-project-create-cancel" @click="projectCreateOpen = false">{{ t("common.cancel") }}</a-button>
        <a-button type="primary" :loading="org.submitting" data-testid="org-project-create-save" @click="onProjectCreate">
          {{ t("org.submitCreate") }}
        </a-button>
      </template>
    </a-modal>

    <!-- 项目改名（受控） -->
    <a-modal v-if="renameProjectTarget !== null" :open="true" :title="t('org.projectRenameTitle')" data-testid="org-project-rename-modal" @cancel="cancelProjectRename">
      <a-input
        v-model:value="projectRenameName"
        data-testid="org-project-rename-name"
        :placeholder="t('org.namePlaceholder')"
        @press-enter="onProjectRename"
      />
      <div v-if="projectRenameError" class="form-error" data-testid="org-project-rename-error">{{ projectRenameError }}</div>
      <a-alert
        v-if="org.actionError"
        class="modal-api-error"
        type="error"
        show-icon
        :message="t('org.error')"
        :description="org.actionError"
        data-testid="org-project-rename-api-error"
      />
      <template #footer>
        <a-button data-testid="org-project-rename-cancel" @click="cancelProjectRename">{{ t("common.cancel") }}</a-button>
        <a-button type="primary" :loading="org.submitting" data-testid="org-project-rename-save" @click="onProjectRename">
          {{ t("org.submitRename") }}
        </a-button>
      </template>
    </a-modal>

    <!-- 移动项目（受控；预选现分组） -->
    <a-modal v-if="moveProjectTarget !== null" :open="true" :title="t('org.projectMoveTitle')" data-testid="org-project-move-modal" @cancel="cancelProjectMove">
      <p class="delete-hint">{{ t("org.projectMoveHint", { name: moveProjectTarget.name }) }}</p>
      <a-select
        v-model:value="projectMoveGroupId"
        class="group-select"
        :options="groupOptions"
        :placeholder="t('org.groupPlaceholder')"
        data-testid="org-project-move-group"
      />
      <a-alert
        v-if="org.actionError"
        class="modal-api-error"
        type="error"
        show-icon
        :message="t('org.error')"
        :description="org.actionError"
        data-testid="org-project-move-api-error"
      />
      <template #footer>
        <a-button data-testid="org-project-move-cancel" @click="cancelProjectMove">{{ t("common.cancel") }}</a-button>
        <a-button type="primary" :loading="org.submitting" data-testid="org-project-move-save" @click="onProjectMove">
          {{ t("org.submitMove") }}
        </a-button>
      </template>
    </a-modal>

    <!-- 删项目（受控确认） -->
    <a-modal v-if="deleteProjectTarget !== null" :open="true" :title="t('org.projectDeleteTitle')" data-testid="org-project-delete-modal" @cancel="cancelProjectDelete">
      <p class="delete-hint" data-testid="org-project-delete-hint">{{ t("org.projectDeleteHint", { name: deleteProjectTarget.name }) }}</p>
      <a-alert
        v-if="org.actionError"
        class="modal-api-error"
        type="error"
        show-icon
        :message="t('org.error')"
        :description="org.actionError"
        data-testid="org-project-delete-api-error"
      />
      <template #footer>
        <a-button data-testid="org-project-delete-cancel" @click="cancelProjectDelete">{{ t("common.cancel") }}</a-button>
        <a-button danger type="primary" :loading="org.busyId === deleteProjectTarget.id" data-testid="org-project-delete-confirm" @click="onProjectDelete">
          {{ t("org.confirmDelete") }}
        </a-button>
      </template>
    </a-modal>
  </div>
</template>

<style scoped>
.org-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.org-title {
  margin: 0;
  font-size: 16px;
}
.org-toolbar-actions {
  display: flex;
  gap: 8px;
}
.org-api-error {
  margin-bottom: 16px;
}
.org-panes {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}
.org-groups {
  width: 320px;
  flex: none;
  background: #fff;
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  padding: 12px;
}
.org-projects {
  flex: 1;
  min-width: 0;
}
.pane-title {
  margin: 0 0 8px;
  font-size: 14px;
}
.group-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: 6px;
  cursor: pointer;
}
.group-row:hover {
  background: #f5f5f5;
}
.group-row.active {
  background: #e6f4ff;
}
.group-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.group-default-tag {
  margin-inline-end: 0;
}
.group-actions {
  display: flex;
  gap: 4px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}
.project-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  border: 1px solid #f0f0f0;
  border-radius: 8px;
  background: #fff;
}
.avatar {
  flex: none;
  width: 32px;
  height: 32px;
  border-radius: 6px;
  color: #fff;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
}
.card-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.card-actions {
  display: flex;
  gap: 4px;
}
.pane-empty {
  color: #999;
  font-size: 13px;
  padding: 8px 0;
}
.group-select {
  width: 100%;
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
.delete-hint {
  margin: 0 0 8px;
  font-size: 13px;
}
</style>

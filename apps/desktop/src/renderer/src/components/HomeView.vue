<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Button as AButton, Input as AInput, Modal as AModal, Select as ASelect, Tag as ATag } from "ant-design-vue";
import type { ApiccApi } from "../../../shared/types.js";
import type { useWorkspaceStore } from "../stores/workspace.js";
import type { useTreeStore } from "../stores/tree.js";
import type { createOnlineStore } from "../stores/online.js";
import type { useImportWizardStore } from "../stores/importW.js";
import type { PluginsStore } from "../stores/plugins.js";
import EmptyState from "./EmptyState.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import ConnectionPanel from "./ConnectionPanel.vue";
import ProjectCard from "./ProjectCard.vue";
import ImportWizard from "./ImportWizard.vue";

/**
 * 主页（M9-C/M10；轨三左右栏重构）：内部左栏（落点选择）+ 右栏（内容视图）。
 * - 左栏「我的团队」=本地工作区：子项=分组（点击过滤右栏项目）+「新建分组」；未开工作区
 *   时显示打开/新建本地目录入口（M11 行为保留）。
 * - 左栏「服务器」=在线档案（昵称，色块头像）；选中服务器→右栏该服务器团队空间只读清单
 *   （未登录提示去「管理连接」登录）。
 * - 左栏底部「管理连接」→ 右栏连接管理面板（档案增删改+登录唯一入口，登录对话框收口）。
 * - 右栏本地视图：项目卡片网格（ProjectCard：色块头像+名称+菜单 修改名称/克隆/移动/删除）
 *   + 工具栏「导入项目」（project 模式向导：选分组+项目名）+「新建项目」（带分组选择器）。
 */
const props = defineProps<{
  api: ApiccApi;
  workspace: ReturnType<typeof useWorkspaceStore>;
  tree: ReturnType<typeof useTreeStore>;
  online: ReturnType<typeof createOnlineStore>;
  importW: ReturnType<typeof useImportWizardStore>;
  plugins: PluginsStore;
  reportError: (e: unknown) => void;
  /** 打开项目回调：组合根成签并激活（不变量 1）+ 切接口模块。 */
  openProject: (id: string) => void;
  /** 活动项目 id（计划 C 任务 5 D）：该项目签存在且激活——组合根从 tabs store 计算。 */
  activeProjectId?: string | null;
}>();
const { t } = useI18n();

// —— 左栏选中态：本地全部 / 某分组 / 某服务器 / 连接管理 ——
type Selection =
  | { kind: "local" }
  | { kind: "group"; groupId: string }
  | { kind: "server"; baseUrl: string }
  | { kind: "connections" };
const selection = ref<Selection>({ kind: "local" });

interface GroupView {
  id: string;
  name: string;
  projects: Array<{ id: string; name: string }>;
}

const groups = computed<GroupView[]>(() =>
  (props.workspace.tree?.children ?? []).map((g) => ({
    id: g.id,
    name: g.label,
    projects: (g.children ?? []).filter((n) => n.kind === "project").map((p) => ({ id: p.id, name: p.label })),
  })),
);
const defaultGroupId = computed(() => groups.value.find((g) => g.name === "默认分组")?.id ?? groups.value[0]?.id ?? null);

/** 右栏可见项目：选 local → 全部；选 group → 该分组。 */
const visibleProjects = computed(() => {
  const sel = selection.value;
  if (sel.kind === "group") {
    return groups.value.find((g) => g.id === sel.groupId)?.projects ?? [];
  }
  return groups.value.flatMap((g) => g.projects);
});

const selectedGroupId = computed(() => (selection.value.kind === "group" ? selection.value.groupId : ""));
const selectedBaseUrl = computed(() => (selection.value.kind === "server" ? selection.value.baseUrl : ""));

function selectLocal() {
  selection.value = { kind: "local" };
}
function selectGroup(groupId: string) {
  selection.value = { kind: "group", groupId };
}
function selectServer(baseUrl: string) {
  selection.value = { kind: "server", baseUrl };
  if (props.online.loggedIn && props.online.activeBaseUrl === baseUrl) void refreshOnline();
}
function selectConnections() {
  selection.value = { kind: "connections" };
}

// —— 命名对话框（M10 澄清①）：创建分组 / 重命名分组 / 删除分组 / 新建项目 / 重命名项目 / 删除项目 共用 ——
type DialogKind =
  | "create-group" | "create-project" | "rename-group" | "delete-group"
  | "rename-project" | "delete-project";
const dialog = ref<{
  open: boolean;
  kind: DialogKind;
  groupId: string;
  projectId: string;
  name: string;
  error: string;
}>({ open: false, kind: "create-group", groupId: "", projectId: "", name: "", error: "" });

function openCreateGroup() {
  dialog.value = { open: true, kind: "create-group", groupId: "", projectId: "", name: "", error: "" };
}
function openCreateProject(groupId: string) {
  dialog.value = { open: true, kind: "create-project", groupId, projectId: "", name: "", error: "" };
}
function openRenameGroup(g: GroupView) {
  dialog.value = { open: true, kind: "rename-group", groupId: g.id, projectId: "", name: g.name, error: "" };
}
function openDeleteGroup(g: GroupView) {
  dialog.value = { open: true, kind: "delete-group", groupId: g.id, projectId: "", name: g.name, error: "" };
}
function openRenameProject(p: { id: string; name: string }) {
  dialog.value = { open: true, kind: "rename-project", groupId: "", projectId: p.id, name: p.name, error: "" };
}
function openDeleteProject(p: { id: string; name: string }) {
  dialog.value = { open: true, kind: "delete-project", groupId: "", projectId: p.id, name: p.name, error: "" };
}
function closeDialog() {
  dialog.value = { ...dialog.value, open: false };
}

async function onDialogConfirm(name: string | null) {
  const kind = dialog.value.kind;
  try {
    if (kind === "create-group") {
      await props.tree.createNode({ kind: "group", parentId: null, name: (name ?? "").trim() });
      closeDialog();
      return;
    }
    if (kind === "create-project") {
      const node = await props.tree.createNode({ kind: "project", parentId: dialog.value.groupId, name: (name ?? "").trim() });
      closeDialog();
      props.openProject(node.id); // 创建即打开（参考产品行为：建完进项目）
      return;
    }
    if (kind === "rename-group") {
      await props.api.nodeRename("group", dialog.value.groupId, (name ?? "").trim());
      await props.workspace.refresh();
      closeDialog();
      return;
    }
    if (kind === "rename-project") {
      await props.api.nodeRename("project", dialog.value.projectId, (name ?? "").trim());
      await props.workspace.refresh();
      closeDialog();
      return;
    }
    if (kind === "delete-project") {
      await props.api.nodeDelete("project", dialog.value.projectId);
      await props.workspace.refresh();
      closeDialog();
      return;
    }
    if (kind === "delete-group") {
      const g = groups.value.find((x) => x.id === dialog.value.groupId);
      if (g && g.projects.length > 0) {
        dialog.value.error = t("home.groupNotEmpty");
        return;
      }
      await props.api.nodeDelete("group", dialog.value.groupId);
      await props.workspace.refresh();
      if (selection.value.kind === "group" && selection.value.groupId === dialog.value.groupId) selectLocal();
      closeDialog();
    }
  } catch (e) {
    // 错误显示在对话框内（M10 澄清①），可改后重试
    dialog.value.error = e instanceof Error ? e.message : String(e);
  }
}

const dialogTitle = computed(() => {
  const k = dialog.value.kind;
  if (k === "create-group") return t("home.newGroup");
  if (k === "create-project") return t("home.newProject");
  if (k === "rename-group") return t("tree.rename");
  if (k === "rename-project") return t("home.renameProject");
  if (k === "delete-project") return t("home.deleteProject");
  return t("tree.delete");
});

// —— 工具栏「新建项目」（带分组选择器，默认「默认分组」） ——
const newProjectOpen = ref(false);
const newProjectName = ref("");
const newProjectGroupId = ref<string | undefined>(undefined);
const newProjectError = ref("");

function openNewProject() {
  newProjectGroupId.value = selection.value.kind === "group" ? selection.value.groupId : defaultGroupId.value ?? undefined;
  newProjectName.value = "";
  newProjectError.value = "";
  newProjectOpen.value = true;
}

async function createProjectConfirm() {
  if (!newProjectGroupId.value) {
    newProjectError.value = t("home.targetGroup");
    return;
  }
  try {
    const node = await props.tree.createNode({ kind: "project", parentId: newProjectGroupId.value, name: newProjectName.value.trim() });
    newProjectOpen.value = false;
    props.openProject(node.id);
  } catch (e) {
    newProjectError.value = e instanceof Error ? e.message : String(e);
  }
}

const newProjectGroupOptions = computed(() => groups.value.map((g) => ({ label: g.name, value: g.id })));

// —— 项目卡片动作：克隆 / 移动 / 删除（同名放开：克隆与重命名都可直接落） ——
const moveOpen = ref(false);
const moveProjectId = ref("");
const moveTargetGroupId = ref<string | undefined>(undefined);

function openMoveProject(p: { id: string }) {
  moveProjectId.value = p.id;
  moveTargetGroupId.value = groups.value.find((g) => g.projects.some((x) => x.id === p.id))?.id ?? defaultGroupId.value ?? undefined;
  moveOpen.value = true;
}

async function moveConfirm() {
  if (!moveTargetGroupId.value) return;
  try {
    await props.api.projectMove(moveProjectId.value, moveTargetGroupId.value);
    await props.workspace.refresh();
    moveOpen.value = false;
  } catch (e) {
    props.reportError(e);
  }
}

async function cloneProject(p: { id: string }) {
  try {
    await props.api.projectClone(p.id);
    await props.workspace.refresh();
  } catch (e) {
    props.reportError(e);
  }
}

const moveGroupOptions = computed(() => groups.value.map((g) => ({ label: g.name, value: g.id })));

// —— 导入项目向导（project 模式） ——
const importOpen = ref(false);
function openImportProject() {
  importOpen.value = true;
}

// —— 远程服务器 ——
const remoteProfiles = computed(() => props.online.profiles);

async function refreshOnline() {
  try {
    await props.online.refreshWorkspaces();
  } catch (e) {
    props.reportError(e);
  }
}

async function openRemote(ws: { id: string; name: string; myRole: string; createdAt: string }) {
  try {
    await props.online.openWorkspace(ws as never);
  } catch (e) {
    props.reportError(e);
  }
}

function loginServer(baseUrl: string) {
  props.online.setActive(baseUrl);
  props.online.dialogOpen = true;
}

// —— 本地目录 打开/新建（计划 C 任务 2：裁定 E 互斥退役——本地打开不退在线，并存驻留） ——
const wsDialogOpen = ref(false);
const pendingRoot = ref("");

async function openLocalDir() {
  try {
    const dir = await props.api.wsPickDirectory();
    if (!dir) return;
    await props.workspace.open(dir);
  } catch (e) {
    props.reportError(e);
  }
}

async function startCreateLocal() {
  try {
    const dir = await props.api.wsPickDirectory();
    if (!dir) return;
    pendingRoot.value = dir;
    wsDialogOpen.value = true;
  } catch (e) {
    props.reportError(e);
  }
}

async function onCreateWsConfirm(name: string | null) {
  wsDialogOpen.value = false;
  if (!name) return;
  try {
    await props.workspace.create(pendingRoot.value, name);
  } catch (e) {
    props.reportError(e);
  }
}
</script>

<template>
  <section class="home-view" data-testid="home-view">
    <!-- 左栏：落点选择 -->
    <aside class="home-side" data-testid="home-sidebar">
      <div class="side-section" data-testid="home-side-local">
        <div
          class="side-item top"
          :class="{ active: selection.kind === 'local' }"
          data-testid="home-side-local"
          @click="selectLocal"
        >
          {{ t("home.myTeams") }}
          <span v-if="workspace.opened" class="side-sub">{{ workspace.name }}</span>
        </div>
        <template v-if="workspace.opened">
          <div
            v-for="g in groups"
            :key="g.id"
            class="side-item child"
            :class="{ active: selection.kind === 'group' && selectedGroupId === g.id }"
            data-testid="home-side-group"
            @click="selectGroup(g.id)"
          >
            <span class="side-name">{{ g.name }}</span>
            <span class="side-actions" @click.stop>
              <a-button size="small" type="text" data-testid="home-rename-group" @click="openRenameGroup(g)">{{ t("tree.rename") }}</a-button>
              <a-button
                size="small"
                type="text"
                danger
                :disabled="g.projects.length > 0"
                :title="g.projects.length > 0 ? t('home.groupNotEmpty') : undefined"
                data-testid="home-delete-group"
                @click="openDeleteGroup(g)"
              >
                {{ t("tree.delete") }}
              </a-button>
            </span>
          </div>
          <div class="side-item child action">
            <a-button size="small" type="text" data-testid="home-new-group" @click="openCreateGroup">{{ t("home.newGroup") }}</a-button>
          </div>
          <!-- 打开/新建常驻（切换工作区入口不随打开态消失） -->
          <div class="side-item child action">
            <a-button size="small" type="text" data-testid="home-open-dir" @click="openLocalDir">{{ t("home.openWorkspace") }}</a-button>
            <a-button size="small" type="text" data-testid="home-new-dir" @click="startCreateLocal">{{ t("home.newDir") }}</a-button>
          </div>
        </template>
        <template v-else>
          <div class="side-item child action">
            <a-button size="small" type="primary" data-testid="home-open-dir" @click="openLocalDir">{{ t("home.openWorkspace") }}</a-button>
          </div>
          <div class="side-item child action">
            <a-button size="small" data-testid="home-new-dir" @click="startCreateLocal">{{ t("home.newDir") }}</a-button>
          </div>
          <div class="side-empty" data-testid="home-local-empty">{{ t("home.noWorkspaceSide") }}</div>
        </template>
      </div>

      <div class="side-section" data-testid="home-side-servers">
        <div class="side-title">{{ t("home.servers") }}</div>
        <div
          v-for="s in remoteProfiles"
          :key="s.baseUrl"
          class="side-item"
          :class="{ active: selection.kind === 'server' && selectedBaseUrl === s.baseUrl }"
          :data-testid="`home-side-server-${s.baseUrl}`"
          @click="selectServer(s.baseUrl)"
        >
          <span class="side-name">{{ s.name || s.baseUrl }}</span>
          <a-tag v-if="online.loggedIn && online.activeBaseUrl === s.baseUrl" color="blue" class="side-tag">{{ t("home.active") }}</a-tag>
        </div>
        <div v-if="remoteProfiles.length === 0" class="side-empty" data-testid="home-servers-empty">{{ t("home.noServers") }}</div>
      </div>

      <div class="side-bottom">
        <a-button block data-testid="home-manage-connections" @click="selectConnections">
          {{ t("home.connections") }}
        </a-button>
      </div>
    </aside>

    <!-- 右栏：内容视图 -->
    <div class="home-main" data-testid="home-content">
      <!-- 连接管理 -->
      <ConnectionPanel
        v-if="selection.kind === 'connections'"
        :online="online"
        @browse="selectServer"
      />

      <!-- 服务器视图：团队空间只读清单 -->
      <template v-else-if="selection.kind === 'server'">
        <div class="content-head">
          <span class="content-title" data-testid="home-server-title">
            {{ remoteProfiles.find((s) => s.baseUrl === selectedBaseUrl)?.name || selectedBaseUrl }}
          </span>
          <a-tag v-if="online.loggedIn && online.activeBaseUrl === selectedBaseUrl" color="blue">{{ t("home.active") }}</a-tag>
        </div>
        <template v-if="online.loggedIn && online.activeBaseUrl === selectedBaseUrl">
          <div class="content-toolbar">
            <span class="muted">{{ t("home.serverWorkspaces") }}</span>
            <span class="spacer"></span>
            <a-button size="small" data-testid="home-refresh-online" @click="refreshOnline">{{ t("home.refresh") }}</a-button>
          </div>
          <div class="ws-list" data-testid="home-ws-list">
            <button
              v-for="w in online.workspaces"
              :key="w.id"
              type="button"
              class="ws-row"
              :data-testid="`home-ws-${w.id}`"
              @click="openRemote(w)"
            >
              {{ w.name }}
            </button>
            <span v-if="online.workspaces.length === 0" class="muted">{{ t("home.noWorkspaces") }}</span>
          </div>
        </template>
        <EmptyState v-else :text="t('home.loginToBrowse')" />
        <div class="login-row" v-if="!(online.loggedIn && online.activeBaseUrl === selectedBaseUrl)">
          <a-button size="small" type="primary" data-testid="home-server-login" @click="loginServer(selection.baseUrl)">
            {{ t("home.connectionLogin") }}
          </a-button>
        </div>
      </template>

      <!-- 本地视图：项目卡片网格 -->
      <template v-else>
        <div class="content-head">
          <span class="content-title" data-testid="home-content-title">
            {{ selection.kind === "group" ? groups.find((g) => g.id === selectedGroupId)?.name : workspace.name }}
          </span>
          <span class="spacer"></span>
          <a-button size="small" data-testid="home-import-project" :disabled="!workspace.opened" @click="openImportProject">
            {{ t("home.importProject") }}
          </a-button>
          <a-button size="small" type="primary" data-testid="home-new-project-top" :disabled="!workspace.opened" @click="openNewProject">
            {{ t("home.newProject") }}
          </a-button>
        </div>
        <EmptyState v-if="!workspace.opened" :text="t('home.localEmpty')" />
        <EmptyState v-else-if="visibleProjects.length === 0" :text="t('home.noProjects')" />
        <div v-else class="project-grid" data-testid="home-project-grid">
          <ProjectCard
            v-for="p in visibleProjects"
            :key="p.id"
            :project-id="p.id"
            :project-name="p.name"
            :active="p.id === activeProjectId"
            @open="openProject(p.id)"
            @rename="openRenameProject(p)"
            @clone="cloneProject(p)"
            @move="openMoveProject(p)"
            @remove="openDeleteProject(p)"
          />
        </div>
      </template>
    </div>

    <!-- 导入项目向导（project 模式，弹窗承载） -->
    <a-modal
      v-if="importOpen"
      :open="importOpen"
      :title="t('home.importProjectTitle')"
      :width="560"
      :footer="null"
      data-testid="home-import-modal"
      @cancel="importOpen = false"
    >
      <ImportWizard
        v-if="importOpen"
        mode="project"
        :groups="groups.map((g) => ({ id: g.id, label: g.name }))"
        :default-group-id="defaultGroupId"
        :import-w="importW"
        :plugins="plugins"
        :report-error="reportError"
        @close="importOpen = false"
      />
    </a-modal>

    <!-- 工具栏新建项目（带分组选择器） -->
    <a-modal
      v-if="newProjectOpen"
      :open="newProjectOpen"
      :title="t('home.newProject')"
      :width="420"
      data-testid="home-project-dialog"
      @cancel="newProjectOpen = false"
    >
      <div class="dialog-body">
        <label class="field">
          <span class="field-label">{{ t("home.targetGroup") }}</span>
          <a-select
            v-model:value="newProjectGroupId"
            class="control"
            :options="newProjectGroupOptions"
            data-testid="home-project-dialog-group"
          />
        </label>
        <label class="field">
          <span class="field-label">{{ t("home.projectName") }}</span>
          <a-input v-model:value="newProjectName" data-testid="home-project-dialog-name" />
        </label>
        <div v-if="newProjectError" class="error" data-testid="home-project-dialog-error">{{ newProjectError }}</div>
      </div>
      <template #footer>
        <a-button data-testid="home-project-dialog-cancel" @click="newProjectOpen = false">{{ t("common.cancel") }}</a-button>
        <a-button type="primary" data-testid="home-project-dialog-confirm" @click="createProjectConfirm">{{ t("common.confirm") }}</a-button>
      </template>
    </a-modal>

    <!-- 移动项目（换分组） -->
    <a-modal
      v-if="moveOpen"
      :open="moveOpen"
      :title="t('home.moveToGroup')"
      :width="420"
      data-testid="home-move-dialog"
      @cancel="moveOpen = false"
    >
      <div class="dialog-body">
        <label class="field">
          <span class="field-label">{{ t("home.targetGroup") }}</span>
          <a-select
            v-model:value="moveTargetGroupId"
            class="control"
            :options="moveGroupOptions"
            data-testid="home-move-dialog-group"
          />
        </label>
      </div>
      <template #footer>
        <a-button data-testid="home-move-dialog-cancel" @click="moveOpen = false">{{ t("common.cancel") }}</a-button>
        <a-button type="primary" data-testid="home-move-dialog-confirm" @click="moveConfirm">{{ t("common.confirm") }}</a-button>
      </template>
    </a-modal>

    <!-- 分组/项目命名与删除确认（M10：错误显示在对话框内） -->
    <ConfirmDialog
      :open="dialog.open"
      :title="dialogTitle"
      :input-placeholder="t('tree.namePlaceholder')"
      :initial-value="dialog.kind === 'rename-group' || dialog.kind === 'rename-project' ? dialog.name : undefined"
      :error="dialog.error"
      @confirm="onDialogConfirm"
      @cancel="closeDialog"
    >
      <p v-if="dialog.kind === 'delete-group'" class="muted">{{ t("home.deleteGroupHint") }}</p>
      <p v-if="dialog.kind === 'delete-project'" class="muted">{{ t("home.deleteProjectHint") }}</p>
    </ConfirmDialog>

    <!-- 新建本地目录 -->
    <ConfirmDialog
      :open="wsDialogOpen"
      :title="t('app.newWorkspace')"
      :input-placeholder="t('app.workspaceName')"
      @confirm="onCreateWsConfirm"
      @cancel="wsDialogOpen = false"
    />
  </section>
</template>

<style scoped>
.home-view {
  padding: 12px;
  overflow: hidden;
  height: 100%;
  box-sizing: border-box;
  display: flex;
  gap: 12px;
}
/* 左栏 */
.home-side {
  width: 208px;
  flex: none;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  padding: 10px 8px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  overflow: auto;
}
.side-section {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.side-title {
  font-weight: 600;
  font-size: 12px;
  color: var(--text-muted);
  padding: 0 8px 4px;
}
.side-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  flex-wrap: wrap;
}
.side-item:hover {
  background: var(--active-weak);
}
.side-item.active {
  background: var(--active-weak);
  color: var(--accent);
  font-weight: 600;
}
.side-item.top {
  font-weight: 600;
}
.side-item.child {
  padding-left: 20px;
}
.side-item.action {
  cursor: default;
}
.side-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.side-sub {
  font-weight: 400;
  font-size: 11px;
  color: var(--text-muted);
}
.side-actions {
  display: none;
  gap: 0;
}
.side-item:hover .side-actions {
  display: inline-flex;
}
.side-tag {
  margin: 0;
}
.side-empty {
  color: var(--text-muted);
  font-size: 12px;
  padding: 2px 8px;
}
.side-bottom {
  margin-top: auto;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}
/* 右栏 */
.home-main {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
  padding: 12px 14px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.content-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.content-title {
  font-weight: 600;
  font-size: 14px;
}
.content-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.spacer {
  flex: 1;
}
.project-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-content: flex-start;
}
.ws-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ws-row {
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  border-radius: 8px;
  padding: 6px 12px;
  cursor: pointer;
  font-size: 13px;
  text-align: left;
}
.ws-row:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.login-row {
  display: flex;
}
.dialog-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.field {
  display: flex;
  align-items: center;
  gap: 8px;
}
.field-label {
  min-width: 72px;
  color: var(--text-muted);
  font-size: 12px;
}
.control {
  flex: 1;
}
.error {
  color: var(--fail, #cf1322);
  font-size: 12px;
}
.muted {
  color: var(--text-muted);
  font-size: 12px;
}
</style>

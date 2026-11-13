<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Button as AButton, Input as AInput, Modal as AModal, Select as ASelect, Tag as ATag } from "ant-design-vue";
import { DownOutlined } from "@ant-design/icons-vue";
import type { ApiccApi } from "../../../shared/types.js";
import type { OnlineWorkspaceSummary } from "../../../shared/online/contract.js";
import type { useWorkspaceStore } from "../stores/workspace.js";
import type { useTreeStore } from "../stores/tree.js";
import type { createOnlineStore } from "../stores/online.js";
import type { useImportWizardStore } from "../stores/importW.js";
import type { PluginsStore } from "../stores/plugins.js";
import type { GroupLocator, ProjectLocator, WorkspaceLocator } from "../../../shared/locations.js";
import type { LocalGroupTreeNodeDTO, LocalProjectTreeNodeDTO } from "../../../shared/tree-dto.js";
import EmptyState from "./EmptyState.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import ConnectionPanel from "./ConnectionPanel.vue";
import ProjectCard from "./ProjectCard.vue";
import ImportWizard from "./ImportWizard.vue";
import ActionMenu from "./ActionMenu.vue";
import { onlineSessionErrorKey } from "../i18n/index.js";
import type { OnlineWorkspaceAction, OnlineWorkspaceActionTarget } from "../onlineWorkspaceActions.js";

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
  openProject: (locator: ProjectLocator) => void;
  /** 打开在线工作区回调（计划 C 终审 Important 1 ①，open-project 同款组合根模式）：组合根
   * 打开驻留会话并切接口模块——纯在线用户（无本地工作区）从主页打开在线工作区后由此离开
   * 主页（否则侧栏 v-show 与 ModuleRail v-if 双双隐藏，在线树/成签入口不可达）。 */
  openOnlineWorkspace: (ws: OnlineWorkspaceSummary) => void;
  /** 在线项目卡片成签回调（终审 Important 1 ②）：组合根直连 tabs.openProjectTab
   * （online 分支 workspaceRef），纯在线用户在主页即可点项目成签。 */
  openOnlineProject: (projectId: string) => void;
  /** 活动项目 id（计划 C 任务 5 D）：该项目签存在且激活——组合根从 tabs store 计算。 */
  activeProjectLocator?: ProjectLocator | null;
  /** 活跃在线项目 id（终审 Important 1 ②）：活跃签为在线签时的 projectId——卡片高亮。 */
  activeOnlineProjectId?: string | null;
  activeOnlineWorkspaceTarget?: OnlineWorkspaceActionTarget | null;
  retainedOnlineWorkspaceTarget?: OnlineWorkspaceActionTarget | null;
}>();
const emit = defineEmits<{ "online-workspace-action": [action: OnlineWorkspaceAction, target: OnlineWorkspaceActionTarget] }>();
const { t } = useI18n();

// —— 左栏选中态：本地全部 / 某分组 / 某服务器 / 连接管理 ——
type Selection =
  | { kind: "local" }
  | { kind: "group"; locator: GroupLocator }
  | { kind: "server"; baseUrl: string }
  | { kind: "connections" };
const selection = ref<Selection>({ kind: "local" });
const projectFilter = ref("");
const projectSearch = ref<{ focus(): void }>();
function clearProjectFilter() {
  projectFilter.value = "";
  void nextTick(() => projectSearch.value?.focus());
}

interface GroupView {
  id: string;
  locator: GroupLocator;
  name: string;
  projects: Array<{ id: string; name: string; locator: ProjectLocator }>;
}

const groups = computed<GroupView[]>(() =>
  (props.workspace.tree?.children ?? []).filter((node): node is LocalGroupTreeNodeDTO => node.kind === "group").map((g) => ({
    id: g.id,
    locator: { ...g.locator },
    name: g.label,
    projects: (g.children ?? []).filter((node): node is LocalProjectTreeNodeDTO => node.kind === "project")
      .map((p) => ({ id: p.id, name: p.label, locator: { ...p.locator } })),
  })),
);
const defaultGroupLocator = computed(() => groups.value.find((g) => g.name === "默认分组")?.locator ?? groups.value[0]?.locator ?? null);

/** 在分组浏览中输入名称，也能查找本地工作区的所有项目。 */
const visibleProjects = computed(() => {
  const query = projectFilter.value.trim().toLocaleLowerCase();
  if (query) {
    return groups.value.flatMap((group) => group.projects
      .filter((project) => project.name.toLocaleLowerCase().includes(query))
      .map((project) => ({ ...project, groupName: group.name })));
  }
  const sel = selection.value;
  if (sel.kind === "group") {
    return (groups.value.find((g) => JSON.stringify(g.locator) === JSON.stringify(sel.locator))?.projects ?? [])
      .map((project) => ({ ...project, groupName: "" }));
  }
  return groups.value.flatMap((group) => group.projects.map((project) => ({ ...project, groupName: group.name })));
});

const selectedGroupId = computed(() => (selection.value.kind === "group" ? selection.value.locator.groupId : ""));
const selectedBaseUrl = computed(() => (selection.value.kind === "server" ? selection.value.baseUrl : ""));

function selectLocal() {
  projectFilter.value = "";
  selection.value = { kind: "local" };
}
function selectGroup(locator: GroupLocator) {
  projectFilter.value = "";
  selection.value = { kind: "group", locator: { ...locator } };
}
function selectServer(baseUrl: string) {
  selection.value = { kind: "server", baseUrl };
  if (props.online.loggedIn && props.online.activeBaseUrl === baseUrl) void refreshOnline();
}
function selectConnections() {
  selection.value = { kind: "connections" };
}
defineExpose({ selectConnections });

// —— 命名对话框（M10 澄清①）：创建分组 / 重命名分组 / 删除分组 / 新建项目 / 重命名项目 / 删除项目 共用 ——
type DialogKind =
  | "create-group" | "create-project" | "rename-group" | "delete-group"
  | "rename-project" | "delete-project";
const dialog = ref<{
  open: boolean;
  kind: DialogKind;
  groupLocator: GroupLocator | null;
  projectLocator: ProjectLocator | null;
  name: string;
  error: string;
}>({ open: false, kind: "create-group", groupLocator: null, projectLocator: null, name: "", error: "" });

function openCreateGroup() {
  dialog.value = { open: true, kind: "create-group", groupLocator: null, projectLocator: null, name: "", error: "" };
}
function openCreateProject(groupLocator: GroupLocator) {
  dialog.value = { open: true, kind: "create-project", groupLocator: { ...groupLocator }, projectLocator: null, name: "", error: "" };
}
function openRenameGroup(g: GroupView) {
  dialog.value = { open: true, kind: "rename-group", groupLocator: { ...g.locator }, projectLocator: null, name: g.name, error: "" };
}
function openDeleteGroup(g: GroupView) {
  dialog.value = { open: true, kind: "delete-group", groupLocator: { ...g.locator }, projectLocator: null, name: g.name, error: "" };
}
function openRenameProject(p: { name: string; locator: ProjectLocator }) {
  dialog.value = { open: true, kind: "rename-project", groupLocator: null, projectLocator: { ...p.locator }, name: p.name, error: "" };
}
function openDeleteProject(p: { name: string; locator: ProjectLocator }) {
  dialog.value = { open: true, kind: "delete-project", groupLocator: null, projectLocator: { ...p.locator }, name: p.name, error: "" };
}
function closeDialog() {
  dialog.value = { ...dialog.value, open: false };
}

async function onDialogConfirm(name: string | null) {
  if (props.workspace.readOnly) {
    dialog.value.error = t("workspace.readonlyBadge");
    return;
  }
  const kind = dialog.value.kind;
  try {
    if (kind === "create-group") {
      const root = props.workspace.tree;
      if (!root) return;
      await props.tree.createNode({ kind: "group", parent: { ...root.locator }, name: (name ?? "").trim() });
      closeDialog();
      return;
    }
    if (kind === "create-project") {
      const groupLocator = dialog.value.groupLocator;
      if (!groupLocator) return;
      const node = await props.tree.createNode({ kind: "project", parent: { ...groupLocator }, name: (name ?? "").trim() });
      if (node.kind !== "project") throw new Error("创建项目返回了非项目节点");
      closeDialog();
      props.openProject(node.locator); // 创建即打开（参考产品行为：建完进项目）
      return;
    }
    if (kind === "rename-group") {
      if (!dialog.value.groupLocator) return;
      await props.api.nodeRename({ kind: "group", locator: dialog.value.groupLocator }, (name ?? "").trim());
      await props.workspace.refresh();
      closeDialog();
      return;
    }
    if (kind === "rename-project") {
      if (!dialog.value.projectLocator) return;
      await props.api.nodeRename({ kind: "project", locator: dialog.value.projectLocator }, (name ?? "").trim());
      await props.workspace.refresh();
      closeDialog();
      return;
    }
    if (kind === "delete-project") {
      if (!dialog.value.projectLocator) return;
      await props.api.nodeDelete({ kind: "project", locator: dialog.value.projectLocator });
      await props.workspace.refresh();
      closeDialog();
      return;
    }
    if (kind === "delete-group") {
      const groupLocator = dialog.value.groupLocator;
      if (!groupLocator) return;
      const g = groups.value.find((x) => JSON.stringify(x.locator) === JSON.stringify(groupLocator));
      if (g && g.projects.length > 0) {
        dialog.value.error = t("home.groupNotEmpty");
        return;
      }
      await props.api.nodeDelete({ kind: "group", locator: groupLocator });
      await props.workspace.refresh();
      if (selection.value.kind === "group" && JSON.stringify(selection.value.locator) === JSON.stringify(groupLocator)) selectLocal();
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
  const locator = selection.value.kind === "group" ? selection.value.locator : defaultGroupLocator.value;
  newProjectGroupId.value = locator ? JSON.stringify(locator) : undefined;
  newProjectName.value = "";
  newProjectError.value = "";
  newProjectOpen.value = true;
}

async function createProjectConfirm() {
  if (props.workspace.readOnly) {
    newProjectError.value = t("workspace.readonlyBadge");
    return;
  }
  const groupValue = newProjectGroupId.value;
  if (!groupValue) {
    newProjectError.value = t("home.targetGroup");
    return;
  }
  try {
    const groupLocator = JSON.parse(groupValue) as GroupLocator;
    const node = await props.tree.createNode({ kind: "project", parent: groupLocator, name: newProjectName.value.trim() });
    if (node.kind !== "project") throw new Error("创建项目返回了非项目节点");
    newProjectOpen.value = false;
    props.openProject(node.locator);
  } catch (e) {
    newProjectError.value = e instanceof Error ? e.message : String(e);
  }
}

const newProjectGroupOptions = computed(() => groups.value.map((g) => ({ label: g.name, value: JSON.stringify(g.locator) })));

// —— 项目卡片动作：克隆 / 移动 / 删除（同名放开：克隆与重命名都可直接落） ——
const moveOpen = ref(false);
const moveProjectLocator = ref<ProjectLocator | null>(null);
const moveTargetGroupValue = ref<string | undefined>(undefined);

function openMoveProject(p: { locator: ProjectLocator }) {
  moveProjectLocator.value = { ...p.locator };
  const sourceGroup = groups.value.find((g) => JSON.stringify(g.locator) === JSON.stringify({
    workspaceId: p.locator.workspaceId, groupId: p.locator.groupId,
  }));
  moveTargetGroupValue.value = sourceGroup ? JSON.stringify(sourceGroup.locator)
    : defaultGroupLocator.value ? JSON.stringify(defaultGroupLocator.value) : undefined;
  moveOpen.value = true;
}

async function moveConfirm() {
  if (props.workspace.readOnly) {
    props.reportError(new Error(t("workspace.readonlyBadge")));
    return;
  }
  if (!moveProjectLocator.value || !moveTargetGroupValue.value) return;
  try {
    const target = JSON.parse(moveTargetGroupValue.value) as GroupLocator;
    await props.api.projectMove(moveProjectLocator.value, target);
    await props.workspace.refresh();
    moveOpen.value = false;
  } catch (e) {
    props.reportError(e);
  }
}

async function cloneProject(p: { locator: ProjectLocator }) {
  if (props.workspace.readOnly) {
    props.reportError(new Error(t("workspace.readonlyBadge")));
    return;
  }
  try {
    await props.api.projectClone(p.locator);
    await props.workspace.refresh();
  } catch (e) {
    props.reportError(e);
  }
}

const moveGroupOptions = computed(() => groups.value.map((g) => ({ label: g.name, value: JSON.stringify(g.locator) })));

// —— 导入项目向导（project 模式） ——
const importOpen = ref(false);
function openImportProject() {
  importOpen.value = true;
}

// —— 远程服务器 ——
const remoteProfiles = computed(() => {
  const profiles = props.online.profiles;
  const baseUrl = props.retainedOnlineWorkspaceTarget?.baseUrl;
  return baseUrl && !profiles.some((profile) => profile.baseUrl === baseUrl) ? [...profiles, { baseUrl, name: "" }] : profiles;
});
const serverConnected = computed(() => props.online.loggedIn && props.online.activeBaseUrl === selectedBaseUrl.value);
const serverError = computed(() => {
  if (props.online.activeBaseUrl !== selectedBaseUrl.value || !props.online.error) return null;
  const key = onlineSessionErrorKey(props.online.error);
  return key ? t(key) : props.online.error;
});
const serverNeedsReconnect = computed(() => props.online.activeBaseUrl === selectedBaseUrl.value
  && onlineSessionErrorKey(props.online.error) === "online.sessionErrors.online-not-signed-in");
const canBrowseServer = computed(() => serverConnected.value && !serverNeedsReconnect.value);
const retainedWorkspace = computed(() => {
  const target = props.retainedOnlineWorkspaceTarget;
  return target?.baseUrl === selectedBaseUrl.value ? props.online.sessions[target.workspaceId]?.workspace ?? null : null;
});
const showRetainedWorkspace = computed(() => retainedWorkspace.value
  && (!canBrowseServer.value || !props.online.workspaces.some((workspace) => workspace.id === retainedWorkspace.value?.id)));
const workspaceExit = computed(() => ({ key: "exit", label: t("online.exitOnline"), testId: "online-exit", disabled: props.online.migrating }));
const workspaceActions = computed(() => [
  { key: "migrate", label: t("online.migrate"), testId: "online-migrate", disabled: props.online.migrating },
  workspaceExit.value,
]);

function requestWorkspaceAction(action: string, workspaceId: string) {
  const target = action === "migrate" ? props.activeOnlineWorkspaceTarget : props.retainedOnlineWorkspaceTarget;
  if ((action === "migrate" || action === "exit") && target?.baseUrl === selectedBaseUrl.value && target.workspaceId === workspaceId) {
    emit("online-workspace-action", action, target);
  }
}

async function refreshOnline() {
  try {
    await props.online.refreshWorkspaces();
  } catch (e) {
    props.reportError(e);
  }
}

/** 打开在线工作区（终审 Important 1 ①）：经组合根回调——组合根打开驻留会话并切接口模块
 * （视图态在组合根手里），失败由组合根上屏错误通道；组件内零 store 写、零工厂调用。 */
function openRemote(ws: OnlineWorkspaceSummary) {
  props.openOnlineWorkspace(ws);
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
      <div class="side-section">
        <button
          type="button"
          class="side-item top"
          :class="{ active: selection.kind === 'local' }"
          :aria-current="selection.kind === 'local' ? 'page' : undefined"
          data-testid="home-side-local"
          @click="selectLocal"
        >
          {{ t("home.myTeams") }}
          <span v-if="workspace.opened" class="side-sub">{{ workspace.name }}</span>
        </button>
        <template v-if="workspace.opened">
          <div
            v-for="g in groups"
            :key="g.id"
            class="side-item child"
          :class="{ active: selection.kind === 'group' && JSON.stringify(selection.locator) === JSON.stringify(g.locator) }"
            data-testid="home-side-group"
          >
            <button type="button" class="side-name group-select" :title="g.name" :aria-current="selection.kind === 'group' && JSON.stringify(selection.locator) === JSON.stringify(g.locator) ? 'page' : undefined" @click="selectGroup(g.locator)">{{ g.name }}</button>
            <span class="side-actions" @click.stop>
              <a-button size="small" type="text" data-testid="home-rename-group" :disabled="workspace.readOnly" @click="openRenameGroup(g)">{{ t("tree.rename") }}</a-button>
              <a-button
                size="small"
                type="text"
                danger
                :disabled="workspace.readOnly || g.projects.length > 0"
                :title="g.projects.length > 0 ? t('home.groupNotEmpty') : undefined"
                data-testid="home-delete-group"
                @click="openDeleteGroup(g)"
              >
                {{ t("tree.delete") }}
              </a-button>
            </span>
          </div>
          <div class="side-item child action">
            <a-button size="small" type="text" data-testid="home-new-group" :disabled="workspace.readOnly" @click="openCreateGroup">{{ t("home.newGroup") }}</a-button>
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
        <button
          type="button"
          v-for="s in remoteProfiles"
          :key="s.baseUrl"
          class="side-item"
          :class="{ active: selection.kind === 'server' && selectedBaseUrl === s.baseUrl }"
          :aria-current="selection.kind === 'server' && selectedBaseUrl === s.baseUrl ? 'page' : undefined"
          :data-testid="`home-side-server-${s.baseUrl}`"
          @click="selectServer(s.baseUrl)"
        >
          <span class="side-name" :title="s.name || s.baseUrl">{{ s.name || s.baseUrl }}</span>
          <a-tag v-if="online.loggedIn && online.activeBaseUrl === s.baseUrl" color="blue" class="side-tag">{{ t("home.active") }}</a-tag>
        </button>
        <div v-if="remoteProfiles.length === 0" class="side-empty" data-testid="home-servers-empty">{{ t("home.noServers") }}</div>
      </div>

      <div class="side-bottom">
        <a-button block data-testid="home-manage-connections" :aria-current="selection.kind === 'connections' ? 'page' : undefined" @click="selectConnections">
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
          <a-tag v-if="serverConnected" color="blue">{{ t("home.active") }}</a-tag>
          <a-button v-if="serverConnected && !serverNeedsReconnect" size="small" data-testid="home-server-account" @click="online.openConnectionAccount(selectedBaseUrl)">
            {{ t("home.connectionAccount") }}
          </a-button>
        </div>
        <p v-if="serverError" class="error server-error" role="alert">{{ serverError }}</p>
        <div v-if="showRetainedWorkspace && retainedWorkspace" class="ws-row" data-testid="retained-online-workspace">
          <span class="ws-name retained-ws-name" tabindex="0" :title="retainedWorkspace.name">{{ retainedWorkspace.name }}</span>
          <ActionMenu
            test-id="workspace-actions"
            :label="t('home.workspaceActions')"
            :items="[workspaceExit]"
            @select="requestWorkspaceAction($event, retainedWorkspace.id)"
          >
            {{ t("home.workspaceActions") }} <DownOutlined />
          </ActionMenu>
        </div>
        <template v-if="canBrowseServer">
          <div class="content-toolbar">
            <span class="muted">{{ t("home.serverWorkspaces") }}</span>
            <span class="spacer"></span>
            <a-button size="small" data-testid="home-refresh-online" @click="refreshOnline">{{ t("home.refresh") }}</a-button>
          </div>
          <div class="ws-list" data-testid="home-ws-list">
            <template v-for="w in online.workspaces" :key="w.id">
              <div class="ws-row">
                <button type="button" class="ws-name" :title="w.name" :data-testid="`home-ws-${w.id}`" @click="openRemote(w)">
                  {{ w.name }}
                </button>
                <ActionMenu
                  v-if="activeOnlineWorkspaceTarget?.baseUrl === selectedBaseUrl && activeOnlineWorkspaceTarget.workspaceId === w.id"
                  test-id="workspace-actions"
                  :label="t('home.workspaceActions')"
                  :items="workspaceActions"
                  @select="requestWorkspaceAction($event, w.id)"
                >
                  {{ t("home.workspaceActions") }} <DownOutlined />
                </ActionMenu>
              </div>
              <!-- 终审 Important 1 ②：活跃工作区下列出其项目卡片（online.projects 随活跃会话），
                   点卡片经组合根回调直达成签——纯在线用户在主页即可进入项目，不经工作区行中转 -->
              <div
                v-if="activeOnlineWorkspaceTarget?.baseUrl === selectedBaseUrl && activeOnlineWorkspaceTarget.workspaceId === w.id && online.projects.length > 0"
                class="ws-projects"
                :data-testid="`home-ws-projects-${w.id}`"
              >
                <ProjectCard
                  v-for="p in online.projects"
                  :key="p.id"
                  :project-id="p.id"
                  :project-name="p.name"
                  :active="p.id === activeOnlineProjectId"
                  plain
                  @open="openOnlineProject(p.id)"
                />
              </div>
            </template>
            <span v-if="online.workspaces.length === 0" class="muted">{{ t("home.noWorkspaces") }}</span>
          </div>
        </template>
        <EmptyState v-else :text="t('home.loginToBrowse')" />
        <div class="login-row" v-if="!canBrowseServer && online.profiles.some((profile) => profile.baseUrl === selectedBaseUrl)">
          <a-button size="small" type="primary" data-testid="home-server-login" @click="online.openConnectionAccount(selection.baseUrl)">
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
          <a-button size="small" data-testid="home-import-project" :disabled="!workspace.opened || workspace.readOnly" @click="openImportProject">
            {{ t("home.importProject") }}
          </a-button>
          <a-button size="small" type="primary" data-testid="home-new-project-top" :disabled="!workspace.opened || workspace.readOnly" @click="openNewProject">
            {{ t("home.newProject") }}
          </a-button>
        </div>
        <label v-if="workspace.opened" class="project-filter">
          <span>{{ t("home.findProject") }}</span>
          <a-input ref="projectSearch" v-model:value="projectFilter" allow-clear data-testid="home-project-search" :placeholder="t('home.findProjectHint')" />
        </label>
        <EmptyState v-if="!workspace.opened" :text="t('home.localEmpty')" />
        <div v-else-if="projectFilter.trim() && visibleProjects.length === 0" class="project-filter-empty">
          <p>{{ t("home.noMatchingProjects") }}</p>
          <a-button size="small" data-testid="home-clear-project-search" @click="clearProjectFilter">{{ t("home.clearProjectSearch") }}</a-button>
        </div>
        <EmptyState v-else-if="visibleProjects.length === 0" :text="t('home.noProjects')" />
        <div v-else class="project-grid" data-testid="home-project-grid">
          <ProjectCard
            v-for="p in visibleProjects"
            :key="JSON.stringify(p.locator)"
            :project-id="p.id"
            :project-name="p.name"
            :active="JSON.stringify(p.locator) === JSON.stringify(activeProjectLocator)"
            :plain="workspace.readOnly"
            @open="openProject(p.locator)"
            @rename="openRenameProject(p)"
            @clone="cloneProject(p)"
            @move="openMoveProject(p)"
            @remove="openDeleteProject(p)"
          >
            <template v-if="p.groupName" #tags><span class="project-group" :title="p.groupName">{{ p.groupName }}</span></template>
          </ProjectCard>
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
        :groups="groups.map((g) => ({ locator: g.locator, label: g.name }))"
        :default-group-locator="defaultGroupLocator"
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
            v-model:value="moveTargetGroupValue"
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
  padding: 16px;
  background: var(--panel);
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
  background: var(--subtle);
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
  padding: 7px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
  min-height: 32px;
  box-sizing: border-box;
  flex: none;
}
button.side-item, .group-select {
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
}
.group-select { padding: 0; }
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
  flex-wrap: wrap;
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
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.side-actions {
  display: inline-flex;
  flex: none;
  opacity: 0;
  pointer-events: none;
  gap: 0;
}
.side-item:hover .side-actions, .side-item:focus-within .side-actions {
  opacity: 1;
  pointer-events: auto;
}
@media (hover: none) { .side-actions { opacity: 1; pointer-events: auto; } }
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
  background: var(--bg);
  padding: 20px;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.content-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--border);
}
.content-title {
  font-weight: 600;
  font-size: 18px;
  overflow-wrap: anywhere;
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
  gap: 12px;
  align-content: flex-start;
}
.ws-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ws-row {
  display: flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  border-radius: 8px;
  padding: 2px 6px;
  font-size: 13px;
  text-align: left;
}
.ws-row:focus-within, .ws-row:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.ws-name {
  flex: 1;
  min-width: 0;
  min-height: 30px;
  padding: 4px 6px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: start;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.retained-ws-name { cursor: default; }
.project-filter { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.project-filter :deep(.ant-input-affix-wrapper) { width: min(280px, 100%); }
.project-filter-empty { padding: 12px 0; color: var(--text-muted); }
.project-group { display: block; overflow-wrap: anywhere; color: var(--text-muted); }
.server-error { margin: 0; overflow-wrap: anywhere; }
/* 活跃工作区的项目卡片行（终审 Important 1 ②）：缩进排布于工作区行下 */
.ws-projects {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 4px 0 4px 12px;
}
.ws-projects :deep(.project-card) {
  background: var(--bg);
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
@media (max-width: 759px) {
  .home-view { padding: 8px; gap: 8px; }
  .home-side { width: clamp(104px, 32vw, 208px); padding: 8px 4px; }
  .home-main { padding: 10px; }
  .side-item.child { padding-left: 6px; }
  .side-item.top { flex-wrap: wrap; }
  .side-bottom :deep(.ant-btn) { white-space: normal; height: auto; padding-inline: 4px; }
  .ws-row { flex-wrap: wrap; }
}
</style>

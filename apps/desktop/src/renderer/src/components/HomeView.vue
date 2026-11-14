<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button as AButton, Input as AInput, Modal as AModal, Select as ASelect, Tag as ATag, Tooltip as ATooltip } from "ant-design-vue";
import { DownOutlined, EllipsisOutlined, PlusOutlined } from "@ant-design/icons-vue";
import type { ApiccApi } from "../../../shared/types.js";
import type { OnlineWorkspaceSummary } from "../../../shared/online/contract.js";
import type { useWorkspaceStore } from "../stores/workspace.js";
import type { useTreeStore } from "../stores/tree.js";
import type { createOnlineStore } from "../stores/online.js";
import type { useImportWizardStore } from "../stores/importW.js";
import type { PluginsStore } from "../stores/plugins.js";
import type { GroupLocator, ProjectLocator } from "../../../shared/locations.js";
import type { LocalGroupTreeNodeDTO, LocalProjectTreeNodeDTO } from "../../../shared/tree-dto.js";
import { projectSessionKey } from "../stores/localIdentity.js";
import EmptyState from "./EmptyState.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import ConnectionPanel from "./ConnectionPanel.vue";
import ProjectCard from "./ProjectCard.vue";
import ImportWizard from "./ImportWizard.vue";
import ActionMenu from "./ActionMenu.vue";
import { onlineSessionErrorKey } from "../i18n/index.js";
import type { OnlineWorkspaceAction, OnlineWorkspaceActionTarget } from "../onlineWorkspaceActions.js";

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
  openLocalProjectKeys?: ReadonlySet<string>;
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
let dialogTrigger: HTMLElement | null = null;

function rememberDialogTrigger(active = document.activeElement) {
  dialogTrigger = active instanceof HTMLElement && active.matches(".home-view button") ? active : null;
}

function restoreDialogFocus() {
  const trigger = dialogTrigger;
  dialogTrigger = null;
  if (!trigger) return;
  void nextTick(() => {
    if (trigger.isConnected) trigger.focus({ preventScroll: true });
    else projectSearch.value?.focus();
  });
}

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

function sameGroup(left: GroupLocator, right: GroupLocator) {
  return left.workspaceId === right.workspaceId && left.groupId === right.groupId;
}

const selectedGroup = computed(() => {
  const sel = selection.value;
  return sel.kind === "group" ? groups.value.find((group) => sameGroup(group.locator, sel.locator)) ?? null : null;
});
const allProjectsSelected = computed(() => selection.value.kind === "local" || (selection.value.kind === "group" && !selectedGroup.value));
const projectQuery = computed(() => projectFilter.value.trim().toLocaleLowerCase());

/** 在分组浏览中输入名称，也能查找本地工作区的所有项目。 */
const visibleProjects = computed(() => {
  const query = projectQuery.value;
  const scope = !query && selectedGroup.value ? [selectedGroup.value] : groups.value;
  return scope.flatMap((group) => group.projects
    .filter((project) => !query || project.name.toLocaleLowerCase().includes(query))
    .map((project) => ({
      ...project,
      groupName: group.name,
      key: projectSessionKey(props.workspace.root, project.locator),
    })));
});

const selectedBaseUrl = computed(() => (selection.value.kind === "server" ? selection.value.baseUrl : ""));

watch([() => props.workspace.root, () => props.workspace.tree?.locator.workspaceId], () => {
  projectFilter.value = "";
  if (selection.value.kind === "group") selection.value = { kind: "local" };
});

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
  rememberDialogTrigger();
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

function groupActions(group: GroupView) {
  const nonempty = group.projects.length > 0;
  return [
    { key: "rename", label: t("tree.rename"), testId: "home-rename-group" },
    {
      key: "delete",
      label: nonempty ? t("home.deleteNonemptyGroup", { reason: t("home.groupNotEmpty") }) : t("tree.delete"),
      testId: "home-delete-group",
      disabled: nonempty,
      danger: true,
    },
  ];
}

function onGroupAction(action: string, group: GroupView) {
  if (props.workspace.readOnly) return;
  rememberDialogTrigger();
  if (action === "rename") openRenameGroup(group);
  if (action === "delete" && group.projects.length === 0) openDeleteGroup(group);
}

function openRenameProject(p: { name: string; locator: ProjectLocator }) {
  rememberDialogTrigger();
  dialog.value = { open: true, kind: "rename-project", groupLocator: null, projectLocator: { ...p.locator }, name: p.name, error: "" };
}
function openDeleteProject(p: { name: string; locator: ProjectLocator }) {
  rememberDialogTrigger();
  dialog.value = { open: true, kind: "delete-project", groupLocator: null, projectLocator: { ...p.locator }, name: p.name, error: "" };
}
function closeDialog() {
  dialog.value = { ...dialog.value, open: false };
  restoreDialogFocus();
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
      const g = groups.value.find((x) => sameGroup(x.locator, groupLocator));
      if (g && g.projects.length > 0) {
        dialog.value.error = t("home.groupNotEmpty");
        return;
      }
      await props.api.nodeDelete({ kind: "group", locator: groupLocator });
      await props.workspace.refresh();
      if (selection.value.kind === "group" && sameGroup(selection.value.locator, groupLocator)) selectLocal();
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
  const locator = selectedGroup.value?.locator ?? defaultGroupLocator.value;
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
const moveProjectName = ref("");
const moveTargetGroupValue = ref<string | undefined>(undefined);

function openMoveProject(p: { name: string; locator: ProjectLocator }) {
  rememberDialogTrigger();
  moveProjectLocator.value = { ...p.locator };
  moveProjectName.value = p.name;
  const sourceGroup = groups.value.find((g) => sameGroup(g.locator, p.locator));
  moveTargetGroupValue.value = sourceGroup ? JSON.stringify(sourceGroup.locator)
    : defaultGroupLocator.value ? JSON.stringify(defaultGroupLocator.value) : undefined;
  moveOpen.value = true;
}

function closeMoveDialog() {
  moveOpen.value = false;
  restoreDialogFocus();
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
    closeMoveDialog();
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
const localWorkspaceActions = computed(() => [
  { key: "open", label: t("home.openWorkspace"), testId: "home-open-dir" },
  { key: "create", label: t("home.newDir"), testId: "home-new-dir" },
]);

function onLocalWorkspaceAction(action: string) {
  if (action === "open") void openLocalDir();
  if (action === "create") void startCreateLocal();
}

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
    const trigger = document.activeElement;
    const dir = await props.api.wsPickDirectory();
    if (!dir) return;
    rememberDialogTrigger(trigger);
    pendingRoot.value = dir;
    wsDialogOpen.value = true;
  } catch (e) {
    props.reportError(e);
  }
}

function closeCreateWorkspace() {
  wsDialogOpen.value = false;
  restoreDialogFocus();
}

async function onCreateWsConfirm(name: string | null) {
  closeCreateWorkspace();
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
        <div class="side-heading">
          <h2 class="side-title local-title">{{ t("home.localWorkspace") }}</h2>
          <ActionMenu
            v-if="workspace.opened"
            test-id="home-workspace-more"
            :label="t('home.localWorkspaceActions')"
            :items="localWorkspaceActions"
            @select="onLocalWorkspaceAction"
          >
            <EllipsisOutlined />
          </ActionMenu>
        </div>
        <button
          v-if="workspace.opened"
          type="button"
          class="side-item side-select"
          :class="{ active: allProjectsSelected }"
          :aria-current="allProjectsSelected ? 'page' : undefined"
          data-testid="home-side-local"
          @click="selectLocal"
        >
          {{ t("home.allProjects") }}
        </button>
        <div v-else class="side-entry-actions">
          <a-button size="small" type="primary" data-testid="home-open-dir" @click="openLocalDir">{{ t("home.openWorkspace") }}</a-button>
          <a-button size="small" data-testid="home-new-dir" @click="startCreateLocal">{{ t("home.newDir") }}</a-button>
        </div>
      </div>

      <div v-if="workspace.opened" class="side-section">
        <div class="side-heading">
          <h2 class="side-title">{{ t("home.groups") }}</h2>
          <button
            type="button"
            class="side-add"
            data-testid="home-new-group"
            :aria-label="t('home.newGroup')"
            :title="t('home.newGroup')"
            :disabled="workspace.readOnly"
            @click="openCreateGroup"
          >
            <PlusOutlined />
          </button>
        </div>
        <div
          v-for="g in groups"
          :key="g.id"
          class="side-item group-row"
          :class="{ active: selectedGroup === g }"
          data-testid="home-side-group"
        >
          <a-tooltip :title="g.name" :trigger="['hover', 'focus']" placement="right">
            <button type="button" class="side-name group-select" :aria-current="selectedGroup === g ? 'page' : undefined" @click="selectGroup(g.locator)">{{ g.name }}</button>
          </a-tooltip>
          <ActionMenu
            class="group-actions"
            test-id="home-group-more"
            :label="t('home.groupActions', { name: g.name })"
            :items="groupActions(g)"
            :disabled="workspace.readOnly"
            @select="onGroupAction($event, g)"
          >
            <EllipsisOutlined />
          </ActionMenu>
        </div>
      </div>

      <div class="side-section" data-testid="home-side-servers">
        <div class="side-heading">
          <h2 class="side-title">{{ t("home.servers") }}</h2>
        </div>
        <a-tooltip
          v-for="s in remoteProfiles"
          :key="s.baseUrl"
          :title="s.name || s.baseUrl"
          :trigger="['hover', 'focus']"
          placement="right"
        >
          <button
            type="button"
            class="side-item side-select server-select"
            :class="{ active: selectedBaseUrl === s.baseUrl }"
            :aria-current="selectedBaseUrl === s.baseUrl ? 'page' : undefined"
            :data-testid="`home-side-server-${s.baseUrl}`"
            @click="selectServer(s.baseUrl)"
          >
            <span class="side-name">{{ s.name || s.baseUrl }}</span>
            <span v-if="online.loggedIn && online.activeBaseUrl === s.baseUrl" class="side-status">{{ t("home.active") }}</span>
          </button>
        </a-tooltip>
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
          <a-tooltip :title="retainedWorkspace.name" :trigger="['hover', 'focus']">
            <span class="ws-name retained-ws-name" tabindex="0" :title="retainedWorkspace.name">{{ retainedWorkspace.name }}</span>
          </a-tooltip>
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
                <a-tooltip :title="w.name" :trigger="['hover', 'focus']">
                  <button type="button" class="ws-name" :title="w.name" :data-testid="`home-ws-${w.id}`" @click="openRemote(w)">
                    {{ w.name }}
                  </button>
                </a-tooltip>
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
        <div class="content-head local-content-head">
          <h1 class="content-title" data-testid="home-content-title">
            {{ projectQuery ? t("home.searchResults") : selectedGroup?.name ?? t("home.allProjects") }}
          </h1>
          <a-tag v-if="workspace.opened && workspace.readOnly">{{ t("workspace.readonlyBadge") }}</a-tag>
          <div class="project-tools">
            <a-button size="small" data-testid="home-import-project" :disabled="!workspace.opened || workspace.readOnly" @click="openImportProject">
              {{ t("home.importProject") }}
            </a-button>
            <a-button size="small" type="primary" data-testid="home-new-project-top" :disabled="!workspace.opened || workspace.readOnly" @click="openNewProject">
              {{ t("home.newProject") }}
            </a-button>
          </div>
        </div>
        <div v-if="workspace.opened" class="project-filter">
          <label for="home-project-search">{{ t("home.findProject") }}</label>
          <a-input
            id="home-project-search"
            ref="projectSearch"
            v-model:value="projectFilter"
            data-testid="home-project-search"
            :placeholder="t('home.findProjectHint')"
          />
          <a-button v-if="projectFilter" size="small" data-testid="home-clear-project-search" @click="clearProjectFilter">
            {{ t("home.clearProjectSearch") }}
          </a-button>
        </div>
        <p v-if="projectQuery" class="search-result-count" role="status" data-testid="home-search-count">
          {{ t("home.searchResultCount", visibleProjects.length) }}
        </p>
        <EmptyState v-if="!workspace.opened" :text="t('home.localEmpty')" />
        <EmptyState v-else-if="visibleProjects.length === 0" :text="t(projectQuery ? 'home.noMatchingProjects' : selectedGroup ? 'home.noProjects' : 'home.noWorkspaceProjects')" />
        <div v-else class="project-grid" data-testid="home-project-grid">
          <ProjectCard
            v-for="p in visibleProjects"
            :key="p.key"
            :project-id="p.id"
            :project-name="p.name"
            :group-name="p.groupName"
            :opened="openLocalProjectKeys?.has(p.key)"
            :plain="workspace.readOnly"
            @open="openProject(p.locator)"
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
      @cancel="closeMoveDialog"
    >
      <div class="dialog-body">
        <div class="field">
          <span class="field-label">{{ t("home.projectName") }}</span>
          <span class="dialog-name">{{ moveProjectName }}</span>
        </div>
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
        <a-button data-testid="home-move-dialog-cancel" @click="closeMoveDialog">{{ t("common.cancel") }}</a-button>
        <a-button type="primary" data-testid="home-move-dialog-confirm" @click="moveConfirm">{{ t("common.confirm") }}</a-button>
      </template>
    </a-modal>

    <!-- 分组/项目命名与删除确认（M10：错误显示在对话框内） -->
    <ConfirmDialog
      :open="dialog.open"
      :title="dialogTitle"
      :input-placeholder="dialog.kind === 'delete-group' || dialog.kind === 'delete-project' ? undefined : t('tree.namePlaceholder')"
      :initial-value="dialog.kind === 'rename-group' || dialog.kind === 'rename-project' ? dialog.name : undefined"
      :error="dialog.error"
      @confirm="onDialogConfirm"
      @cancel="closeDialog"
    >
      <p v-if="dialog.kind === 'delete-group' || dialog.kind === 'delete-project'" class="dialog-name">{{ dialog.name }}</p>
      <p v-if="dialog.kind === 'delete-group'" class="muted">{{ t("home.deleteGroupHint") }}</p>
      <p v-if="dialog.kind === 'delete-project'" class="muted">{{ t("home.deleteProjectHint") }}</p>
    </ConfirmDialog>

    <!-- 新建本地目录 -->
    <ConfirmDialog
      :open="wsDialogOpen"
      :title="t('app.newWorkspace')"
      :input-placeholder="t('app.workspaceName')"
      @confirm="onCreateWsConfirm"
      @cancel="closeCreateWorkspace"
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
  box-sizing: border-box;
  width: 208px;
  flex: none;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--subtle);
  padding: 10px 8px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  overflow: auto;
}
.side-section {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.side-heading {
  min-height: 30px;
  padding-inline: 7px 2px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
}
.side-title {
  margin: 0;
  font-weight: 600;
  font-size: 13px;
  color: var(--text-muted);
  overflow-wrap: anywhere;
}
.local-title {
  font-size: 16px;
  color: var(--text);
}
.side-add {
  flex: 0 0 30px;
  height: 30px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  cursor: pointer;
}
.side-add:hover:enabled { background: var(--active-weak); }
.side-add:disabled { opacity: 0.5; cursor: default; }
.side-item, .side-empty, .side-entry-actions {
  padding-inline-start: 20px;
}
.side-item {
  display: flex;
  align-items: center;
  gap: 6px;
  border-radius: 6px;
  font-size: 13px;
  min-height: 31px;
  box-sizing: border-box;
  min-width: 0;
}
.side-select, .group-select {
  border: 0;
  background: transparent;
  color: inherit;
  font-family: inherit;
  text-align: start;
  cursor: pointer;
}
.side-select { padding-inline-end: 8px; }
.group-select {
  min-height: 30px;
  padding: 0;
  border-radius: 4px;
  font-size: inherit;
  font-weight: inherit;
}
.side-item:hover {
  background: var(--hover);
}
.side-item.active {
  background: var(--active-weak);
  color: var(--accent);
  font-weight: 600;
}
.side-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.group-row { padding-inline-end: 2px; }
.side-entry-actions {
  display: grid;
  justify-items: start;
  gap: 6px;
}
.side-entry-actions :deep(.ant-btn) {
  max-width: 100%;
  height: auto;
  white-space: normal;
}
.group-actions {
  opacity: 0;
  pointer-events: none;
}
.group-row:hover .group-actions, .group-row:focus-within .group-actions, .group-actions[aria-expanded="true"] {
  opacity: 1;
  pointer-events: auto;
}
@media (hover: none) { .group-actions { opacity: 1; pointer-events: auto; } }
.side-status {
  flex: none;
  color: var(--text-muted);
  font-size: 11px;
  font-weight: 400;
}
.side-empty {
  color: var(--text-muted);
  font-size: 13px;
  padding-block: 5px;
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
  margin: 0;
  min-width: 0;
  font-weight: 600;
  font-size: 18px;
  overflow-wrap: anywhere;
}
.local-content-head .content-title { flex: 1 1 auto; }
.project-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-inline-start: auto;
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
.project-filter { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.project-filter :deep(.ant-input) { width: min(280px, 100%); height: 32px; }
.project-filter :deep(.ant-input::placeholder) { color: var(--text-muted); }
.search-result-count { margin: 0; color: var(--text-muted); font-size: 13px; }
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
.dialog-name { overflow-wrap: anywhere; }
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
  .home-side { width: clamp(136px, 32vw, 208px); padding: 8px 4px; }
  .home-main { padding: 10px; }
  .side-item, .side-empty, .side-entry-actions { padding-inline-start: 14px; }
  .server-select { flex-wrap: wrap; gap: 0; padding-block: 4px; }
  .server-select .side-name { flex-basis: 100%; }
  .side-bottom :deep(.ant-btn) { white-space: normal; height: auto; padding-inline: 4px; }
  .ws-row { flex-wrap: wrap; }
}
</style>

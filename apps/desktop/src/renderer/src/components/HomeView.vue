<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Button as AButton, Tag as ATag } from "ant-design-vue";
import type { ApiccApi } from "../../../shared/types.js";
import type { useWorkspaceStore } from "../stores/workspace.js";
import type { useTreeStore } from "../stores/tree.js";
import type { createOnlineStore } from "../stores/online.js";
import EmptyState from "./EmptyState.vue";
import ConfirmDialog from "./ConfirmDialog.vue";

/**
 * 主页（M9-C/M10）：服务器 → 团队分组 → 项目管理。
 * - 本地服务器：分组卡片清单——新建分组/项目走命名对话框（重名错误显示在对话框内，
 *   M10 澄清①）；自建分组仅空（无项目）时可删、可重命名（M10 澄清②）。
 * - 远程服务器：档案/登录态/团队空间只读清单（管理在后台），打开进入在线模式。
 * store 经 props 注入（组合根一次装配）；reportError 为组合根错误反馈通道。
 */
const props = defineProps<{
  api: ApiccApi;
  workspace: ReturnType<typeof useWorkspaceStore>;
  tree: ReturnType<typeof useTreeStore>;
  online: ReturnType<typeof createOnlineStore>;
  reportError: (e: unknown) => void;
  /** 打开项目回调：组合根执行树选中 + 切接口模块（与侧树选中同一路径）。 */
  openProject: (id: string) => void;
}>();
const { t } = useI18n();

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
const activeProjectId = computed(() => (props.tree.selected?.kind === "project" ? props.tree.selected.id : null));

// —— 命名对话框（M10 澄清①）：创建分组 / 创建项目 / 重命名分组 / 删除分组确认 共用 ——
type DialogKind = "create-group" | "create-project" | "rename-group" | "delete-group";
const dialog = ref<{
  open: boolean;
  kind: DialogKind;
  groupId: string;
  name: string;
  error: string;
}>({ open: false, kind: "create-group", groupId: "", name: "", error: "" });

function openCreateGroup() {
  dialog.value = { open: true, kind: "create-group", groupId: "", name: "", error: "" };
}
function openCreateProject(groupId: string) {
  dialog.value = { open: true, kind: "create-project", groupId, name: "", error: "" };
}
function openRenameGroup(g: GroupView) {
  dialog.value = { open: true, kind: "rename-group", groupId: g.id, name: g.name, error: "" };
}
function openDeleteGroup(g: GroupView) {
  dialog.value = { open: true, kind: "delete-group", groupId: g.id, name: g.name, error: "" };
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
    if (kind === "delete-group") {
      const g = groups.value.find((x) => x.id === dialog.value.groupId);
      if (g && g.projects.length > 0) {
        dialog.value.error = t("home.groupNotEmpty");
        return;
      }
      await props.api.nodeDelete("group", dialog.value.groupId);
      await props.workspace.refresh();
      closeDialog();
    }
  } catch (e) {
    // 重名/守卫错误显示在对话框内（M10 澄清①），可改后重试
    dialog.value.error = e instanceof Error ? e.message : String(e);
  }
}

const dialogTitle = computed(() => {
  const k = dialog.value.kind;
  if (k === "create-group") return t("home.newGroup");
  if (k === "create-project") return t("home.newProject");
  if (k === "rename-group") return t("tree.rename");
  return t("tree.delete");
});

// —— 远程服务器 ——
const remoteProfiles = computed(() => props.online.profiles);
const remoteWorkspaces = computed(() => props.online.workspaces);

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

// —— 本地目录 打开/新建（模式互斥语义保持：先退出在线） ——
const wsDialogOpen = ref(false);
const pendingRoot = ref("");

async function openLocalDir() {
  try {
    const dir = await props.api.wsPickDirectory();
    if (!dir) return;
    if (props.online.activeWorkspace) await props.online.closeWorkspace();
    await props.workspace.open(dir);
  } catch (e) {
    props.reportError(e);
  }
}

async function startCreateLocal() {
  try {
    const dir = await props.api.wsPickDirectory();
    if (!dir) return;
    if (props.online.activeWorkspace) await props.online.closeWorkspace();
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
    <!-- 本地服务器 -->
    <div class="card" data-testid="home-local">
      <div class="card-head">
        <span class="card-title">{{ t("home.localServer") }}</span>
        <a-tag v-if="workspace.opened" data-testid="home-local-opened">{{ workspace.name }}</a-tag>
        <span class="spacer"></span>
        <a-button size="small" data-testid="home-open-dir" @click="openLocalDir">{{ t("home.openDir") }}</a-button>
        <a-button size="small" type="primary" data-testid="home-new-dir" @click="startCreateLocal">{{ t("home.newDir") }}</a-button>
      </div>
      <EmptyState v-if="!workspace.opened" :text="t('home.localEmpty')" />
      <template v-else>
        <div v-for="g in groups" :key="g.id" class="group-block" data-testid="home-group">
          <div class="group-row">
            <span class="group-name">{{ g.name }}</span>
            <a-button size="small" type="text" data-testid="home-new-project" @click="openCreateProject(g.id)">{{ t("home.newProject") }}</a-button>
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
          </div>
          <div class="project-list">
            <button
              v-for="p in g.projects"
              :key="p.id"
              type="button"
              class="project-item"
              :class="{ active: p.id === activeProjectId }"
              :data-testid="`home-project-${p.id}`"
              @click="openProject(p.id)"
            >
              {{ p.name }}
            </button>
            <span v-if="g.projects.length === 0" class="muted">{{ t("home.noProjects") }}</span>
          </div>
        </div>
        <div class="group-row">
          <a-button size="small" type="text" data-testid="home-new-group" @click="openCreateGroup">{{ t("home.newGroup") }}</a-button>
        </div>
      </template>
    </div>

    <!-- 远程服务器 -->
    <div class="card" data-testid="home-remote">
      <div class="card-head">
        <span class="card-title">{{ t("home.remoteServer") }}</span>
        <span class="spacer"></span>
        <a-button size="small" data-testid="home-online-open" @click="online.dialogOpen = true">{{ t("home.manageServers") }}</a-button>
      </div>
      <div v-if="remoteProfiles.length === 0" class="muted" data-testid="home-remote-empty">{{ t("home.noServers") }}</div>
      <div v-else class="server-list">
        <div v-for="s in remoteProfiles" :key="s.baseUrl" class="server-row" :data-testid="`home-server-${s.baseUrl}`">
          <span class="server-name">{{ s.name }}</span>
          <span class="muted url">{{ s.baseUrl }}</span>
          <a-tag v-if="online.loggedIn && online.activeName === s.baseUrl" color="blue">{{ t("home.active") }}</a-tag>
        </div>
      </div>
      <template v-if="online.loggedIn">
        <div class="group-row">
          <span class="group-name">{{ t("home.teamSpaces") }}</span>
          <a-button size="small" type="text" data-testid="home-refresh-online" @click="refreshOnline">{{ t("home.refresh") }}</a-button>
        </div>
        <div class="project-list">
          <button
            v-for="w in remoteWorkspaces"
            :key="w.id"
            type="button"
            class="project-item"
            :data-testid="`home-ws-${w.id}`"
            @click="openRemote(w)"
          >
            {{ w.name }}
          </button>
          <span v-if="remoteWorkspaces.length === 0" class="muted">{{ t("home.noWorkspaces") }}</span>
        </div>
        <p class="muted hint">{{ t("home.remoteHint") }}</p>
      </template>
    </div>

    <!-- 分组/项目命名与删除确认（M10：重名/守卫错误显示在对话框内） -->
    <ConfirmDialog
      :open="dialog.open"
      :title="dialogTitle"
      :input-placeholder="t('tree.namePlaceholder')"
      :initial-value="dialog.kind === 'rename-group' ? dialog.name : undefined"
      :error="dialog.error"
      @confirm="onDialogConfirm"
      @cancel="closeDialog"
    >
      <p v-if="dialog.kind === 'delete-group'" class="muted">{{ t("home.deleteGroupHint") }}</p>
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
  padding: 14px 16px;
  overflow: auto;
  height: 100%;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.card {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--panel);
}
.card-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.card-title { font-weight: 600; font-size: 14px; }
.spacer { flex: 1; }
.group-block { margin-bottom: 6px; }
.group-row { display: flex; align-items: center; gap: 4px; }
.group-name { font-weight: 600; margin-right: 4px; }
.project-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 0 6px 14px;
}
.project-item {
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  border-radius: 8px;
  padding: 5px 12px;
  cursor: pointer;
  font-size: 13px;
}
.project-item:hover { border-color: var(--accent); color: var(--accent); }
.project-item.active { border-color: var(--accent); color: var(--accent); background: var(--active-weak); }
.server-list { display: flex; flex-direction: column; gap: 4px; }
.server-row { display: flex; align-items: center; gap: 8px; }
.server-name { font-weight: 600; }
.url { word-break: break-all; }
.muted { color: var(--text-muted); font-size: 12px; }
.hint { margin: 6px 0 0; }
</style>

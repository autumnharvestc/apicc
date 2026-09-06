<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Button as AButton, Input as AInput, Tag as ATag } from "ant-design-vue";
import type { TreeNodeDTO } from "../../../shared/tree-dto.js";
import type { ApiccApi } from "../../../shared/types.js";
import type { useWorkspaceStore } from "../stores/workspace.js";
import type { useTreeStore } from "../stores/tree.js";
import type { createOnlineStore } from "../stores/online.js";
import EmptyState from "./EmptyState.vue";
import ConfirmDialog from "./ConfirmDialog.vue";

/**
 * 主页（M9-C 层级调整）：rail 最左侧的固定入口，管理「服务器 → 团队分组 → 项目」。
 * - 本地服务器（= 当前打开的本地工作区目录）：分组清单（可新建）+ 分组下项目（可新建/打开）；
 *   未打开目录时提供 打开本地目录 / 新建本地目录（原 TopBar 按钮迁移至此）。
 * - 远程服务器（在线档案）：登录状态 + 团队空间（服务端工作空间）清单——客户端只读，
 *   分组/项目在管理后台网页创建管理（裁定）；打开 → 进入在线模式（既有链路）。
 * 「打开项目」= tree.select(project) + 切到接口模块（组合根 onSelect 同构）。
 * store 经 props 注入（组合根一次装配；组件内部禁止重复调用工厂）；reportError 为
 * 组合根错误反馈通道。
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

// —— 本地：分组/项目视图模型 ——
const groups = computed(() =>
  (props.workspace.tree?.children ?? []).map((g) => ({
    id: g.id,
    name: g.label,
    projects: (g.children ?? []).filter((n) => n.kind === "project").map((p) => ({ id: p.id, name: p.label })),
  })),
);
const activeProjectId = computed(() => props.tree.selected?.kind === "project" ? props.tree.selected.id : null);

async function createGroup() {
  try {
    await props.tree.createNode({ kind: "group", parentId: null, name: t("home.newGroupName") });
  } catch (e) {
    props.reportError(e);
  }
}

async function createProject(groupId: string) {
  try {
    await props.tree.createNode({ kind: "project", parentId: groupId, name: t("home.newProjectName") });
  } catch (e) {
    props.reportError(e);
  }
}

// —— 远程服务器（在线档案）：仅展示 + 打开；分组/项目管理在管理后台（裁定 D5） ——
const remoteProfiles = computed(() => props.online.profiles);
const remoteWorkspaces = computed(() => props.online.workspaces);

async function refreshOnline() {
  try {
    await props.online.refreshWorkspaces();
  } catch (e) {
    props.reportError(e);
  }
}

/** 打开远程团队空间：进入在线模式（既有链路），与本地项目打开分道。 */
async function openRemote(ws: { id: string; name: string; myRole: string; createdAt: string }) {
  try {
    await props.online.openWorkspace(ws as never);
  } catch (e) {
    props.reportError(e);
  }
}

// —— 本地目录 打开/新建（自 TopBar 迁移；模式互斥语义保持：先退出在线） ——
const dialogOpen = ref(false);
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
    dialogOpen.value = true;
  } catch (e) {
    props.reportError(e);
  }
}

async function onCreateConfirm(name: string | null) {
  dialogOpen.value = false;
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
            <a-button size="small" type="text" data-testid="home-new-project" @click="createProject(g.id)">{{ t("home.newProject") }}</a-button>
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
          <a-button size="small" type="text" data-testid="home-new-group" @click="createGroup">{{ t("home.newGroup") }}</a-button>
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

    <ConfirmDialog
      :open="dialogOpen"
      :title="t('app.newWorkspace')"
      :input-placeholder="t('app.workspaceName')"
      @confirm="onCreateConfirm"
      @cancel="dialogOpen = false"
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
.group-row { display: flex; align-items: center; gap: 6px; }
.group-name { font-weight: 600; }
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

<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { Space as ASpace, Button as AButton, Tag as ATag, Typography as ATypography } from "ant-design-vue";
import type { ApiccApi } from "../../../shared/types.js";
import type { useWorkspaceStore } from "../stores/workspace.js";
import type { createOnlineStore } from "../stores/online.js";
import ThemeLanguageToggle from "./ThemeLanguageToggle.vue";
import ConfirmDialog from "./ConfirmDialog.vue";

const ATypographyText = ATypography.Text;

/**
 * 顶栏：工作区名 + 模式徽标（本地/在线，M3-B 任务 3 裁定 E）+ 打开/新建工作区 + 在线模式
 * 入口（任务 2）+ 迁移/退出在线（任务 3）+ 语言/主题切换。
 * 模式互斥（裁定 E）：在线工作区激活时点「打开/新建本地工作区」先退出在线（closeWorkspace
 * 清会话）再走本地目录流程；「退出在线工作区」反向切回本地模式。迁移入口仅在线模式可见。
 * store 与 api 经 props 注入（组合根一次装配；组件内部不调工厂、不持有第二个 api 实例）。
 * reportError 为组合根注入的最小错误反馈通道（宽审查 I1）。
 */
const props = defineProps<{
  workspace: ReturnType<typeof useWorkspaceStore>;
  api: ApiccApi;
  online: ReturnType<typeof createOnlineStore>;
  reportError: (e: unknown) => void;
}>();
const { t } = useI18n();

const dialogOpen = ref(false);
const pendingRoot = ref("");

async function leaveOnlineIfNeeded(): Promise<void> {
  if (props.online.activeWorkspace) await props.online.closeWorkspace();
}

async function openWorkspace() {
  try {
    // 目录选定成功后再切模式（次要 4 顺修）：取消选择不动在线会话，避免落空态
    const dir = await props.api.wsPickDirectory();
    if (!dir) return;
    await leaveOnlineIfNeeded();
    await props.workspace.open(dir);
  } catch (e) {
    props.reportError(e);
  }
}

async function startCreate() {
  try {
    const dir = await props.api.wsPickDirectory();
    if (!dir) return; // 用户取消目录选择：不切模式
    await leaveOnlineIfNeeded();
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

/** 退出在线工作区（裁定 E 会话清理）：store 内聚清态，失败转报错误通道。 */
async function exitOnline() {
  try {
    await props.online.closeWorkspace();
  } catch (e) {
    props.reportError(e);
  }
}
</script>

<template>
  <header class="topbar" data-testid="topbar">
    <a-typography-text strong data-testid="workspace-name">
      {{ online.activeWorkspace?.name ?? (workspace.name || t("app.openWorkspace")) }}
    </a-typography-text>
    <!-- 模式徽标（裁定 E）：顶栏当前工作区标识旁可辨「本地/在线」 -->
    <a-tag
      v-if="workspace.opened || online.activeWorkspace"
      class="mode-badge"
      :color="online.activeWorkspace ? 'blue' : 'default'"
      data-testid="mode-badge"
    >
      {{ online.activeWorkspace ? t("online.modeOnline") : t("online.modeLocal") }}
    </a-tag>
    <a-typography-text v-if="workspace.problems.length && !online.activeWorkspace" type="danger" data-testid="workspace-problems">
      {{ t("workspace.problems") }}: {{ workspace.problems.length }}
    </a-typography-text>
    <span class="spacer"></span>
    <a-space :size="8">
      <!-- 迁移/退出（任务 3）：仅在线工作区激活时可见 -->
      <a-button v-if="online.activeWorkspace" data-testid="online-migrate" @click="online.migrateDialogOpen = true">
        {{ t("online.migrate") }}
      </a-button>
      <a-button v-if="online.activeWorkspace" data-testid="online-exit" @click="exitOnline">
        {{ t("online.exitOnline") }}
      </a-button>
      <a-button data-testid="open-workspace" @click="openWorkspace">{{ t("app.openWorkspace") }}</a-button>
      <a-button data-testid="new-workspace" @click="startCreate">{{ t("app.newWorkspace") }}</a-button>
      <!-- 在线模式入口（M3-B 任务 2）：低侵入点选顶栏（与打开/新建同列，恒可达）；
           对话框本体由组合根渲染，按钮只置 online.dialogOpen -->
      <a-button data-testid="online-toggle" @click="props.online.dialogOpen = true">
        <span v-if="online.loggedIn" data-testid="online-status">
          {{ t("online.loggedInAs", { name: online.user?.displayName ?? "", server: online.activeName }) }}
        </span>
        <span v-else data-testid="online-status">{{ t("online.title") }}</span>
      </a-button>
      <ThemeLanguageToggle />
    </a-space>
    <ConfirmDialog
      :open="dialogOpen"
      :title="t('app.newWorkspace')"
      :input-placeholder="t('app.workspaceName')"
      @confirm="onCreateConfirm"
      @cancel="dialogOpen = false"
    />
  </header>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
.spacer { flex: 1; }
.mode-badge {
  margin-inline-end: 0;
}
</style>

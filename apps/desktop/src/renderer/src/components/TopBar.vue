<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { Space as ASpace, Button as AButton, Typography as ATypography } from "ant-design-vue";
import type { ApiccApi } from "../../shared/types.js";
import type { useWorkspaceStore } from "../stores/workspace.js";
import ThemeLanguageToggle from "./ThemeLanguageToggle.vue";
import ConfirmDialog from "./ConfirmDialog.vue";

const ATypographyText = ATypography.Text;

/**
 * 顶栏：工作区名 + 打开/新建工作区 + 语言/主题切换。
 * antd 4 落地：a-typography-text（工作区名/问题数）+ a-space + a-button（按钮组），
 * data-testid 全部保留在等效触发元素/文本元素上。
 * store 与 api 经 props 注入（组合根一次装配；组件内部不调工厂、不持有第二个 api 实例）。
 * reportError 为组合根注入的最小错误反馈通道（宽审查 I1）：Promise 拒绝转报，不静默吞没。
 */
const props = defineProps<{
  workspace: ReturnType<typeof useWorkspaceStore>;
  api: ApiccApi;
  reportError: (e: unknown) => void;
}>();
const { t } = useI18n();

const dialogOpen = ref(false);
const pendingRoot = ref("");

async function openWorkspace() {
  try {
    const dir = await props.api.wsPickDirectory();
    if (dir) await props.workspace.open(dir);
  } catch (e) {
    props.reportError(e);
  }
}

async function startCreate() {
  try {
    const dir = await props.api.wsPickDirectory();
    if (!dir) return; // 用户取消目录选择
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
  <header class="topbar" data-testid="topbar">
    <a-typography-text strong data-testid="workspace-name">
      {{ workspace.name || t("app.openWorkspace") }}
    </a-typography-text>
    <a-typography-text v-if="workspace.problems.length" type="danger" data-testid="workspace-problems">
      {{ t("workspace.problems") }}: {{ workspace.problems.length }}
    </a-typography-text>
    <span class="spacer"></span>
    <a-space :size="8">
      <a-button data-testid="open-workspace" @click="openWorkspace">{{ t("app.openWorkspace") }}</a-button>
      <a-button data-testid="new-workspace" @click="startCreate">{{ t("app.newWorkspace") }}</a-button>
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
</style>

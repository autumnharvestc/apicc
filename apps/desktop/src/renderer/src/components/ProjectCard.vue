<script setup lang="ts">
import { computed, useId } from "vue";
import { useI18n } from "vue-i18n";
import { Tooltip as ATooltip } from "ant-design-vue";
import { EllipsisOutlined } from "@ant-design/icons-vue";
import ActionMenu from "./ActionMenu.vue";

/**
 * 项目卡片（主页右栏网格；轨三）：色块头像（按项目 id 确定性生成颜色，纯 CSS 零素材——
 * 素材许可合规约束）+ 项目名 + 更多菜单（修改名称/克隆项目/移动项目/删除项目）。
 * 点击卡片主体 = 打开项目。
 */
const props = defineProps<{
  projectId: string;
  projectName: string;
  groupName?: string;
  opened?: boolean;
  active?: boolean;
  /** 纯展示卡片（终审 Important 1 ②主页在线项目卡片）：重命名/克隆/移动/删除是本地目录
   * 管理动作，在线项目无对应能力——隐藏「更多」菜单，卡片点击=打开（成签）。 */
  plain?: boolean;
}>();
const emit = defineEmits<{
  (e: "open"): void;
  (e: "rename"): void;
  (e: "clone"): void;
  (e: "move"): void;
  (e: "remove"): void;
}>();
const { t } = useI18n();
const groupDescriptionId = useId();
const actions = computed(() => [
  { key: "rename", label: t("home.renameProject"), testId: "project-menu-rename" },
  { key: "clone", label: t("home.cloneProject"), testId: "project-menu-clone" },
  { key: "move", label: t("home.moveProject"), testId: "project-menu-move" },
  { key: "remove", label: t("home.deleteProject"), testId: "project-menu-delete", danger: true },
]);

function onAction(key: string) {
  if (props.plain) return;
  if (key === "rename") emit("rename");
  if (key === "clone") emit("clone");
  if (key === "move") emit("move");
  if (key === "remove") emit("remove");
}

const AVATAR_COLORS = ["#5b8ff9", "#5ad8a6", "#f6bd16", "#e8684a", "#6dc8ec", "#9270ca", "#ff9d4d", "#f08bb4"];
const avatarColor = computed(() => {
  let h = 0;
  for (const ch of props.projectId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
});
const avatarChar = computed(() => (props.projectName || "?").slice(0, 1).toUpperCase());
</script>

<template>
  <div
    class="project-card"
    :class="{ active }"
    :data-testid="`project-card-${projectId}`"
    @click="emit('open')"
  >
    <div class="card-top">
      <span class="avatar" aria-hidden="true" :style="{ background: avatarColor }">{{ avatarChar }}</span>
      <span v-if="opened" class="card-opened" :title="t('home.projectOpened')">{{ t("home.projectOpened") }}</span>
    </div>
    <a-tooltip :title="projectName" :trigger="['hover', 'focus']">
      <button
        type="button"
        class="card-name"
        :title="projectName"
        :aria-describedby="groupName ? groupDescriptionId : undefined"
        @click.stop="emit('open')"
      ><span>{{ projectName }}</span></button>
    </a-tooltip>
    <a-tooltip v-if="groupName" :title="groupName" :trigger="['hover', 'focus']" placement="bottom">
      <span :id="groupDescriptionId" class="project-group" :title="groupName" tabindex="0">{{ groupName }}</span>
    </a-tooltip>
    <slot name="tags" />
    <span v-if="!plain" class="card-actions" @click.stop>
      <ActionMenu test-id="project-card-more" :label="t('home.projectActions', { name: projectName })" :items="actions" @select="onAction">
        <EllipsisOutlined />
      </ActionMenu>
    </span>
  </div>
</template>

<style scoped>
.project-card {
  position: relative;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  padding: 16px;
  width: 200px;
  max-width: 100%;
  box-sizing: border-box;
  min-height: 124px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 6px;
  text-align: left;
}
.project-card:hover, .project-card:focus-within {
  border-color: var(--accent);
  box-shadow: var(--panel-shadow);
}
.project-card.active {
  border-color: var(--accent);
  background: var(--active-weak);
}
.card-top {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-inline-end: 24px;
}
.avatar {
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 8px;
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.card-name {
  border: 0;
  background: transparent;
  color: var(--text);
  font-family: inherit;
  text-align: left;
  cursor: pointer;
  padding: 0;
  width: 100%;
  min-height: 36px;
  align-content: start;
  border-radius: 3px;
  font-weight: 600;
  font-size: 13px;
  line-height: 18px;
}
.card-name span {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
}
.card-actions {
  position: absolute;
  top: 8px;
  inset-inline-end: 8px;
  opacity: 0;
  pointer-events: none;
}
.project-card:hover .card-actions, .project-card:focus-within .card-actions, .card-actions:has([aria-expanded="true"]) {
  opacity: 1;
  pointer-events: auto;
}
@media (hover: none) { .card-actions { opacity: 1; pointer-events: auto; } }
.project-group, .card-opened {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
  font-size: 13px;
}
.card-opened {
  font-size: 11px;
}
</style>

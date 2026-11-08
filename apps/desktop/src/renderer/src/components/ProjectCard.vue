<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Button as AButton, Dropdown as ADropdown, Menu as AMenu, MenuItem as AMenuItem } from "ant-design-vue";
import { EllipsisOutlined } from "@ant-design/icons-vue";

/**
 * 项目卡片（主页右栏网格；轨三）：色块头像（按项目 id 确定性生成颜色，纯 CSS 零素材——
 * 素材许可合规约束）+ 项目名 + 更多菜单（修改名称/克隆项目/移动项目/删除项目）。
 * 卡片组件预留标签插槽位（tags slot）：标签数据模型后置，先留扩展点（轨三澄清④）。
 * 点击卡片主体 = 打开项目。
 */
const props = defineProps<{
  projectId: string;
  projectName: string;
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
      <span class="avatar" :style="{ background: avatarColor }">{{ avatarChar }}</span>
      <span v-if="!plain" class="card-actions" @click.stop>
        <a-dropdown :trigger="['click']">
          <a-button size="small" type="text" data-testid="project-card-more" :aria-label="t('tree.moreActions')" :title="t('tree.moreActions')">
            <EllipsisOutlined />
          </a-button>
          <template #overlay>
            <a-menu>
              <a-menu-item key="rename" data-testid="project-menu-rename" @click="emit('rename')">
                {{ t("home.renameProject") }}
              </a-menu-item>
              <a-menu-item key="clone" data-testid="project-menu-clone" @click="emit('clone')">
                {{ t("home.cloneProject") }}
              </a-menu-item>
              <a-menu-item key="move" data-testid="project-menu-move" @click="emit('move')">
                {{ t("home.moveProject") }}
              </a-menu-item>
              <a-menu-item key="delete" danger data-testid="project-menu-delete" @click="emit('remove')">
                {{ t("home.deleteProject") }}
              </a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
      </span>
    </div>
    <button type="button" class="card-name" :title="projectName" @click.stop="emit('open')">{{ projectName }}</button>
    <!-- 标签插槽位（轨三澄清④：标签后置，仅留扩展点） -->
    <div class="card-tags">
      <slot name="tags" />
    </div>
  </div>
</template>

<style scoped>
.project-card {
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  padding: 16px;
  width: 200px;
  max-width: 100%;
  box-sizing: border-box;
  min-height: 116px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 8px;
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
  align-items: flex-start;
  justify-content: space-between;
  gap: 4px;
}
.avatar {
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
  padding: 2px 0;
  width: 100%;
  border-radius: 3px;
  font-weight: 600;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-actions {
  opacity: 0;
}
.project-card:hover .card-actions, .project-card:focus-within .card-actions {
  opacity: 1;
}
@media (hover: none) { .card-actions { opacity: 1; } }
.card-tags {
  min-height: 4px;
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
</style>

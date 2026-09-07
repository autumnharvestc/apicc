<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Tooltip as ATooltip } from "ant-design-vue";
import {
  ApiOutlined,
  PlayCircleOutlined,
  DeploymentUnitOutlined,
  ExperimentOutlined,
  GlobalOutlined,
  HomeOutlined,
} from "@ant-design/icons-vue";
import { SWITCH_VIEWS, isViewDisabled, type SwitchView } from "../viewSwitch.js";

/**
 * 图标导航栏（M8 布局层级改造）：64px 竖排模块入口——图标 + 语言标签 + 选中高亮。
 * 组件零状态：选中值/门控上下文均经 props 注入，切换 emit update:view
 * （父组件 v-model:view）。图标取自 @ant-design/icons-vue（ant-design-vue
 * 自带依赖，MIT）；禁用语义经 viewSwitch.isViewDisabled 单测钉住。
 */
const props = defineProps<{
  view: SwitchView;
  gate: { workspaceOpened: boolean; onlineActive: boolean; apiSelected: boolean };
}>();
const emit = defineEmits<{ "update:view": [view: SwitchView] }>();
const { t } = useI18n();

const ICONS: Record<SwitchView, ReturnType<typeof ApiOutlined>> = {
  home: HomeOutlined,
  api: ApiOutlined,
  run: PlayCircleOutlined,
  wf: DeploymentUnitOutlined,
  test: ExperimentOutlined,
  envs: GlobalOutlined,
};

function disabled(v: SwitchView): boolean {
  return isViewDisabled(v, props.gate);
}
</script>

<template>
  <nav class="rail" data-testid="module-rail">
    <div class="logo" aria-hidden="true">A</div>
    <a-tooltip v-for="v in SWITCH_VIEWS" :key="v" :title="t(`nav.${v}`)" placement="right">
      <button
        type="button"
        class="rail-item"
        :class="{ active: view === v }"
        :data-testid="`rail-${v}`"
        :disabled="disabled(v)"
        @click="emit('update:view', v)"
      >
        <component :is="ICONS[v]" class="rail-icon" />
        <span class="rail-label">{{ t(`nav.${v}`) }}</span>
      </button>
    </a-tooltip>
  </nav>
</template>

<style scoped>
.rail {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
  width: 64px;
  padding: 8px 4px;
  box-sizing: border-box;
  border-right: 1px solid var(--border);
  background: var(--panel);
  overflow-y: auto;
  flex-shrink: 0;
}
.logo {
  width: 32px;
  height: 32px;
  margin: 0 auto 8px;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-weight: 700;
  font-size: 18px;
  line-height: 32px;
  text-align: center;
  user-select: none;
}
.rail-item {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 7px 2px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.rail-item:hover:not(:disabled) { background: var(--hover); color: var(--text); }
.rail-item.active { color: var(--accent); background: var(--active-weak); }
.rail-item.active::before {
  content: "";
  position: absolute;
  left: -4px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 18px;
  border-radius: 2px;
  background: var(--accent);
}
.rail-item:disabled { opacity: 0.4; cursor: not-allowed; }
.rail-icon { font-size: 17px; }
.rail-label { font-size: 11px; line-height: 1.2; max-width: 56px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>

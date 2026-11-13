<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Tooltip as ATooltip } from "ant-design-vue";
import {
  ApiOutlined,
  PlayCircleOutlined,
  DeploymentUnitOutlined,
  ExperimentOutlined,
  GlobalOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
} from "@ant-design/icons-vue";
import { SWITCH_VIEWS, isViewDisabled, type SwitchView } from "../viewSwitch.js";
import DebugEnvironmentMenu from "./DebugEnvironmentMenu.vue";
import type { DebugEnvironmentSelection } from "../debugEnvironment.js";

/**
 * 图标导航栏（M8 布局层级改造）：64px 竖排模块入口——图标 + 语言标签 + 选中高亮。
 * 组件零状态：选中值/门控上下文均经 props 注入，切换 emit update:view
 * （父组件 v-model:view）。图标取自 @ant-design/icons-vue（ant-design-vue
 * 自带依赖，MIT）；禁用语义经 viewSwitch.isViewDisabled 单测钉住。
 */
const props = defineProps<{
  view: SwitchView;
  gate: { workspaceOpened: boolean; onlineActive: boolean; apiSelected: boolean };
  environment?: DebugEnvironmentSelection | null;
  environmentLoading?: boolean;
  directoryOverlay?: boolean;
  directoryOpen?: boolean;
}>();
const emit = defineEmits<{ "update:view": [view: SwitchView]; "toggle-directory": [] }>();
const { t } = useI18n();
const moduleViews = SWITCH_VIEWS.filter((view) => view !== "envs");
const directoryLabel = computed(() => t(props.directoryOpen ? "workbench.closeDirectory" : "workbench.openDirectory"));

const ICONS: Record<SwitchView, ReturnType<typeof ApiOutlined>> = {
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
  <nav class="rail" data-testid="module-rail" :aria-label="t('workbench.moduleNavigation')">
    <a-tooltip v-for="v in moduleViews" :key="v" :title="t(`nav.${v}`)" placement="right">
      <button
        type="button"
        class="rail-item"
        :class="{ active: view === v }"
        :aria-current="view === v ? 'page' : undefined"
        :data-testid="`rail-${v}`"
        :disabled="disabled(v)"
        @click="emit('update:view', v)"
      >
        <component :is="ICONS[v]" class="rail-icon" />
        <span class="rail-label">{{ t(`nav.${v}`) }}</span>
      </button>
    </a-tooltip>
    <button v-if="directoryOverlay" type="button" class="rail-item rail-directory" data-testid="rail-directory"
      :aria-label="directoryLabel" :title="directoryLabel" :aria-expanded="directoryOpen" aria-controls="workbench-directory"
      @click="emit('toggle-directory')">
      <MenuFoldOutlined v-if="directoryOpen" class="rail-icon" />
      <MenuUnfoldOutlined v-else class="rail-icon" />
      <span class="rail-label">{{ t("workbench.directory") }}</span>
    </button>
    <div class="rail-environment">
      <DebugEnvironmentMenu
        v-if="environment || environmentLoading"
        :selection="environment ?? null"
        :loading="environmentLoading"
        :disabled="disabled('envs')"
        rail manage test-id="rail-envs"
        @manage="emit('update:view', 'envs')"
      />
      <button v-else type="button" class="rail-item" :class="{ active: view === 'envs' }" data-testid="rail-envs"
        :title="t('environmentShortcut.selectRequest')" :aria-label="t('nav.envs')"
        :aria-current="view === 'envs' ? 'page' : undefined" :disabled="disabled('envs')" @click="emit('update:view', 'envs')">
        <GlobalOutlined class="rail-icon" />
        <span class="rail-label">{{ t("nav.envs") }}</span>
      </button>
    </div>
    <div v-if="$slots.tools" class="rail-tools"><slot name="tools" /></div>
  </nav>
</template>

<style scoped>
.rail {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
  width: 64px;
  padding: 8px 5px;
  box-sizing: border-box;
  border-right: 1px solid var(--border);
  background: var(--workbench-rail);
  overflow-y: auto;
  flex-shrink: 0;
  scrollbar-width: thin;
}
.rail-item {
  flex: none;
  min-height: 48px;
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
.rail-item:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
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
.rail-label { font-size: 11px; line-height: 1.2; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rail-environment { padding-top: 6px; margin-top: 4px; border-top: 1px solid var(--border); }
.rail-environment > * { width: 100%; }
.rail-tools { margin-top: auto; }
@media (max-width: 1023px) { .rail { width: 56px; } }
@media (forced-colors: active) { .rail-item.active { border: 1px solid Highlight; } }
</style>

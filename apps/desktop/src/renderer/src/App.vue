<script setup lang="ts">
// 组合根（装配约定）：store 工厂每调用一次即新建独立 Pinia 实例、得到互不相通的
// 状态副本——因此全部 store 只能在此一次性创建，再经 props 向下传递；
// SideTree/RequestEditor/TopBar 等组件内部禁止重复调用工厂。
import { ref, computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  ConfigProvider,
  Layout as ALayout,
  LayoutSider as ALayoutSider,
  LayoutContent as ALayoutContent,
  Alert as AAlert,
  Radio as ARadio,
  theme as antdTheme,
} from "ant-design-vue";
import zhCN from "ant-design-vue/es/locale/zh_CN";
import enUS from "ant-design-vue/es/locale/en_US";
import { apicc } from "./api";
import type { TreeNodeDTO } from "../../shared/tree-dto.js";
import TopBar from "./components/TopBar.vue";
import SideTree from "./components/SideTree.vue";
import ConfirmDialog from "./components/ConfirmDialog.vue";
import RequestEditor from "./components/RequestEditor.vue";
import ResponseViewer from "./components/ResponseViewer.vue";
import CasePanel from "./components/CasePanel.vue";
import EnvPanel from "./components/EnvPanel.vue";
import RunView from "./components/RunView.vue";
import ImportWizard from "./components/ImportWizard.vue";
import DesignPanel from "./components/DesignPanel.vue";
import WfDesigner from "./components/WfDesigner.vue";
import { useWorkspaceStore } from "./stores/workspace.js";
import { useTreeStore } from "./stores/tree.js";
import { useEditorStore } from "./stores/editor.js";
import { useDebugStore } from "./stores/debug.js";
import { useCasesStore } from "./stores/cases.js";
import { useEnvsStore } from "./stores/envs.js";
import { useRunStore } from "./stores/run.js";
import { useImportWizardStore } from "./stores/importW.js";
import { useDesignStore } from "./stores/design.js";
import { useWfListStore } from "./stores/wfList.js";
import { useWorkflowDesignStore } from "./stores/workflowDesign.js";
import { createBindIndexLoader, type WfBindIndex } from "./wf/wfBindings.js";
import { currentLocale } from "./i18n/bridge.js";
import { themePreference, resolveTheme } from "./theme.js";

const ARadioGroup = ARadio.Group;
const ARadioButton = ARadio.Button;

// —— antd ConfigProvider 联动（i18n / 主题算法）——
// locale 源 = bridge 单例当前语言；algorithm 源 = theme.ts 响应式偏好 + 系统偏好解析。
const antdLocale = computed(() => (currentLocale() === "zh-CN" ? zhCN : enUS));
const antdThemeConfig = computed(() => ({
  algorithm:
    resolveTheme(themePreference.value, window.matchMedia("(prefers-color-scheme: dark)").matches) === "dark"
      ? antdTheme.darkAlgorithm
      : antdTheme.defaultAlgorithm,
}));

const { t } = useI18n();
const workspace = useWorkspaceStore(apicc);
const tree = useTreeStore(apicc, workspace);
const editor = useEditorStore(apicc);
const debug = useDebugStore(apicc);
// —— 视图面板 store（任务 8 装配）：与既有 store 同一组合根一次性创建 ——
const cases = useCasesStore(apicc, editor);
const envs = useEnvsStore(apicc);
const run = useRunStore(apicc);
const importW = useImportWizardStore(apicc, workspace);
const design = useDesignStore(apicc, editor);
// —— 工作流设计器 store（M2-B 任务 4 装配）：同一组合根一次性创建 ——
const wfList = useWfListStore(apicc);
const workflowDesign = useWorkflowDesignStore(apicc);

// —— 视图切换（任务 8 收官装配）——
// 侧栏顶部 a-radio-group；未打开工作区时整组禁用（现状保留：只有打开/新建可用）。
type View = "debug" | "cases" | "envs" | "run" | "import" | "design" | "wf";
const VIEWS: View[] = ["debug", "cases", "envs", "run", "import", "design", "wf"];
const view = ref<View>("debug");

// —— 最小错误反馈通道（宽审查 I1）——
// SideTree/TopBar/各面板链路的 Promise 拒绝统一转报到这里，集中展示、可手动关闭，
// 不再作为未处理的 rejection 被静默吞没。
// antd 4 落地：错误展示条为 a-alert type="error"；关闭钮（a-alert closeText slot）
// 保留 data-testid="app-error-close"，点击冒泡到 a-alert 关闭处理器 → @close →
// 走原 reportError 通道反向清空（errorMessage 置空后 v-if 卸载整条 alert）。
const errorMessage = ref("");

function reportError(e: unknown) {
  errorMessage.value = e instanceof Error ? e.message : String(e);
}

function dismissError() {
  errorMessage.value = "";
}

/**
 * 侧树选中回调：接口节点加载进编辑器；工作流节点（M2-B 收口）加载进工作流设计器并
 * 切到工作流视图——缓冲 dirty 时先经确认对话框放行（审查 I1 修复），确认丢弃后才载入
 * 目标流，不再静默覆盖未保存编辑（先例同 WfDesigner requestUnload）。
 * 其余节点仅记录选中态。
 */
async function onSelect(kind: TreeNodeDTO["kind"], id: string) {
  tree.select(kind, id);
  if (kind === "api") await editor.load(id);
  if (kind === "workflow") {
    if (workflowDesign.dirty) {
      pendingSwitchId = id;
      wfSwitchConfirmOpen.value = true;
      return;
    }
    await openWorkflowInDesigner(id);
  }
}
// M2-C 跟进：树摘要/wfList/设计器三方同步协议 + dirty 确认（侧树切换的确认放行已随
// 审查 I1 补齐；跨视图选中态/摘要一致性仍随协议收口）。

// —— 侧树切换工作流的 dirty 确认（审查 I1）——
// 确认前缓冲与会话态不动；确认丢弃后卸载旧会话再载入目标流；取消则留在原工作流，
// 并把树选中项回退到设计器当前流，避免「树选中 B、设计器开着 A」的选中错位。
const wfSwitchConfirmOpen = ref(false);
let pendingSwitchId: string | null = null;

/** 载入工作流进设计器并切到 wf 视图（load 失败经 reportError 上报，与对话框链路同一收口点）。 */
async function openWorkflowInDesigner(id: string) {
  view.value = "wf";
  try {
    await workflowDesign.load(id);
  } catch (e) {
    reportError(e);
  }
}

function onWfSwitchConfirm() {
  const id = pendingSwitchId;
  pendingSwitchId = null;
  wfSwitchConfirmOpen.value = false;
  if (id) void openWorkflowInDesigner(id);
}

function onWfSwitchCancel() {
  pendingSwitchId = null;
  wfSwitchConfirmOpen.value = false;
  if (workflowDesign.workflowId) tree.select("workflow", workflowDesign.workflowId);
}

/** 树选中节点所属项目 id：环境面板按它加载环境列表（接口/文件夹/集合向上归属）。
 * 工作流节点（M2-B 收口）按 project.workflows 摘要归属——否则侧树打开工作流后
 * selectedProjectId 落空，设计器的绑定级联索引与 wf 列表会丢失项目上下文。 */
const selectedProjectId = computed<string | null>(() => {
  const sel = tree.selected;
  const root = workspace.tree;
  if (!sel || !root) return null;
  if (sel.kind === "project") return sel.id;
  if (sel.kind === "group") return null;
  for (const group of root.children ?? []) {
    for (const project of group.children ?? []) {
      if (project.id === sel.id) return project.id;
      if (project.workflows?.some((w) => w.id === sel.id)) return project.id;
      for (const collection of project.children ?? []) {
        if (collection.id === sel.id) return project.id;
        for (const folder of collection.children ?? []) {
          if (folder.id === sel.id) return project.id;
        }
      }
    }
  }
  return null;
});

/** 树选中节点所属集合 id：运行视图的默认选中集合（文件夹/接口向上归属）。 */
const selectedCollectionId = computed<string | null>(() => {
  const sel = tree.selected;
  const root = workspace.tree;
  if (!sel || !root) return null;
  if (sel.kind === "collection") return sel.id;
  for (const group of root.children ?? []) {
    for (const project of group.children ?? []) {
      for (const collection of project.children ?? []) {
        if (collection.id === sel.id) return collection.id;
        for (const folder of collection.children ?? []) {
          if (folder.id === sel.id) return collection.id;
        }
      }
    }
  }
  return null;
});

// —— 工作流设计器的绑定级联索引（M2-B 任务 4 / 审查修复竞态）——
// 树 DTO 不含用例目录：按当前项目逐接口 apiGet 补齐（wfBindings 注入式取数），
// 产出 a-cascader options + 画布名称预注入 + missing 检测集合。随选中项目变化重建；
// 装载器以递增序号守护竞态：快速切换项目时先发起的后完成结果被丢弃，不覆盖新索引。
// 审查 I2：watch 源追加 workspace.tree——项目内经侧树新增/删除接口后 refresh 换新
// tree 引用即触发重建，避免改绑级联/画布预注入/missing 检测基于陈旧索引。
const bindIndexLoader = createBindIndexLoader(
  () => workspace.tree,
  (id) => apicc.apiGet(id),
);
const wfBindIndex = ref<WfBindIndex | null>(null);
watch(
  [selectedProjectId, () => workspace.opened, () => workspace.tree],
  async ([pid]) => {
    wfBindIndex.value = null;
    try {
      const index = await bindIndexLoader.load(pid);
      if (index) wfBindIndex.value = index; // 过期结果为 null：不覆盖（新请求已落位）
    } catch (e) {
      reportError(e);
    }
  },
  { immediate: true },
);

// —— 工作流列表 → 侧树摘要同步（M2-B 收口）——
// 设计器列表是工作流唯一创建/删除入口，而树 DTO 的 project.workflows 摘要只在
// treeGet 时构建：不随刷新，设计器里新建的流在侧树永远不可见（「发现」落空）。
// 监听 items.length（create/remove 必变；等长重拉不触发，避免无谓 treeGet）。
watch(
  () => wfList.items.length,
  async () => {
    if (!workspace.opened) return;
    try {
      await workspace.refresh();
    } catch (e) {
      reportError(e);
    }
  },
);

// —— 生命周期迁移 → 侧树状态色点同步（审查修复：色点陈旧）——
// 发布/启用（wf:set-status）不改列表长度，上面的 watcher 感知不到；单独监听设计器
// 缓冲的 status 变化刷新树摘要，侧树色点才不滞留旧状态。unload（workflow=null）跳过，
// 避免「返回列表」触发无谓 treeGet；启用校验未过时缓冲 status 不变，watcher 不触发。
watch(
  () => workflowDesign.workflow?.status,
  async (status) => {
    if (!workspace.opened || status === undefined) return;
    try {
      await workspace.refresh();
    } catch (e) {
      reportError(e);
    }
  },
);
</script>

<template>
  <ConfigProvider :locale="antdLocale" :theme="antdThemeConfig">
    <a-layout class="app" data-testid="app-root">
      <TopBar :workspace="workspace" :api="apicc" :report-error="reportError" />
      <a-alert v-if="errorMessage" class="app-error" type="error" show-icon data-testid="app-error" @close="dismissError">
        <template #message>{{ t("app.error") }}: {{ errorMessage }}</template>
        <template #closeText><span data-testid="app-error-close">{{ t("common.close") }}</span></template>
      </a-alert>
      <a-layout has-sider class="main">
        <a-layout-sider :width="240" theme="light" class="sider">
          <a-radio-group
            v-model:value="view"
            class="view-switch"
            size="small"
            :disabled="!workspace.opened"
            data-testid="view-switch"
          >
            <a-radio-button v-for="v in VIEWS" :key="v" :value="v" :data-testid="`view-${v}`">
              {{ t(`nav.${v}`) }}
            </a-radio-button>
          </a-radio-group>
          <!-- workflow-design 注入（审查 I2）：侧树重命名命中设计器正开的流时强制卸载会话 -->
          <SideTree
            class="side-col"
            :api="apicc"
            :workspace="workspace"
            :tree="tree"
            :workflow-design="workflowDesign"
            :report-error="reportError"
            @select="onSelect"
          />
        </a-layout-sider>
        <a-layout-content class="right-col" data-testid="main-split">
          <template v-if="view === 'debug'">
            <div class="editor-pane" data-testid="editor-pane">
              <RequestEditor :editor="editor" :debug="debug" />
            </div>
            <div class="viewer-pane" data-testid="viewer-pane">
              <ResponseViewer :result="debug.result" :sending="debug.sending" :error="debug.error" />
            </div>
          </template>
          <CasePanel
            v-else-if="view === 'cases'"
            class="panel-view"
            :editor="editor"
            :cases="cases"
            :report-error="reportError"
          />
          <EnvPanel
            v-else-if="view === 'envs'"
            class="panel-view"
            :envs="envs"
            :project-id="selectedProjectId"
            :report-error="reportError"
          />
          <RunView
            v-else-if="view === 'run'"
            class="panel-view"
            :run="run"
            :workspace="workspace"
            :selected-collection-id="selectedCollectionId"
            :report-error="reportError"
          />
          <ImportWizard v-else-if="view === 'import'" class="panel-view" :import-w="importW" :report-error="reportError" @close="view = 'debug'" />
          <DesignPanel v-else-if="view === 'design'" class="panel-view" :editor="editor" :design="design" :report-error="reportError" />
          <WfDesigner
            v-else
            class="wf-view"
            :workflow-design="workflowDesign"
            :wf-list="wfList"
            :workspace="workspace"
            :project-id="selectedProjectId"
            :bind-index="wfBindIndex"
            :report-error="reportError"
          />
        </a-layout-content>
    </a-layout>
    <!-- 侧树切换工作流的 dirty 丢弃确认（审查 I1）：a-modal 传送门渲染于 body -->
    <ConfirmDialog
      :open="wfSwitchConfirmOpen"
      :title="t('wf.discardConfirm')"
      @confirm="onWfSwitchConfirm"
      @cancel="onWfSwitchCancel"
    />
  </a-layout>
  </ConfigProvider>
</template>

<style>
html, body, #app { height: 100%; margin: 0; }
.app { height: 100%; background: var(--bg); color: var(--text); }
.app .ant-layout-sider { border-right: 1px solid var(--border); background: var(--bg); }
.app .ant-layout-sider-children { height: 100%; }
.right-col { display: flex; flex-direction: column; min-width: 0; height: 100%; }
.editor-pane { flex: 1; min-height: 0; overflow: auto; }
.viewer-pane { flex: none; max-height: 45%; overflow: auto; border-top: 1px solid var(--border); }
.panel-view { flex: 1; min-height: 0; overflow: auto; }
/* 设计器视图：三区布局占满内容区（画布需要确定高度的容器，否则 Vue Flow 视口失真） */
.wf-view { flex: 1; min-height: 0; overflow: hidden; }
.view-switch { display: flex; flex-wrap: wrap; padding: 6px 8px; gap: 0; }
.view-switch .ant-radio-button-wrapper { flex: 1 1 33%; text-align: center; font-size: 12px; padding: 0 4px; }
</style>

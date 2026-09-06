<script setup lang="ts">
// 组合根（装配约定）：store 工厂每调用一次即新建独立 Pinia 实例、得到互不相通的
// 状态副本——因此全部 store 只能在此一次性创建，再经 props 向下传递；
// SideTree/RequestEditor/TopBar 等组件内部禁止重复调用工厂。
// M8 布局层级改造：九平铺视图收敛为「图标导航栏（ModuleRail）→ 树面板（带模块标题
// 与搜索）→ 内容区」；接口模块（api）内含子视图页签（调试/设计/用例），调试子视图
// 保持 main-split 上下结构（editor-pane / 可拖拽分割条 / viewer-pane）。
import { ref, computed, watch, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import {
  ConfigProvider,
  Layout as ALayout,
  Alert as AAlert,
  Radio as ARadio,
  Input as AInput,
  Space as ASpace,
  Button as AButton,
  theme as antdTheme,
} from "ant-design-vue";
import zhCN from "ant-design-vue/es/locale/zh_CN";
import enUS from "ant-design-vue/es/locale/en_US";
import { apicc } from "./api";
import type { TreeNodeDTO } from "../../shared/tree-dto.js";
import TopBar from "./components/TopBar.vue";
import ModuleRail from "./components/ModuleRail.vue";
import SideTree from "./components/SideTree.vue";
import ConfirmDialog from "./components/ConfirmDialog.vue";
import OnlineLoginDialog from "./components/OnlineLoginDialog.vue";
import OnlineApiEditor from "./components/OnlineApiEditor.vue";
import OnlineConflictDialog from "./components/OnlineConflictDialog.vue";
import OnlineMigrateDialog from "./components/OnlineMigrateDialog.vue";
import RequestEditor from "./components/RequestEditor.vue";
import ResponseViewer from "./components/ResponseViewer.vue";
import CasePanel from "./components/CasePanel.vue";
import EnvPanel from "./components/EnvPanel.vue";
import RunView from "./components/RunView.vue";
import ImportWizard from "./components/ImportWizard.vue";
import DesignPanel from "./components/DesignPanel.vue";
import WfDesigner from "./components/WfDesigner.vue";
import StressPanel from "./components/StressPanel.vue";
import AiConfigDialog from "./components/AiConfigDialog.vue";
import AiSuggestionsDrawer from "./components/AiSuggestionsDrawer.vue";
import PluginsView from "./components/PluginsView.vue";
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
import { createStressStore } from "./stores/stress.js";
import { createOnlineStore } from "./stores/online.js";
import { createAiStore } from "./stores/ai.js";
import { createPluginsStore } from "./stores/plugins.js";
import { createBindIndexLoader, type WfBindIndex } from "./wf/wfBindings.js";
import {
  isViewDisabled,
  isApiSubViewDisabled,
  SWITCH_VIEWS,
  API_SUB_VIEWS,
  type SwitchView,
  type ApiSubView,
} from "./viewSwitch.js";
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
// —— 压测 store（M2-D3 任务 3 装配，裁定 A）：同一组合根一次性创建，经 props 下传 ——
const stress = createStressStore({ api: apicc });
// —— 在线 store（M3-B 任务 2 装配）：同一组合根一次性创建；挂载后对上次激活的服务器
// 尝试恢复登录态（裁定 A resume 链路，init 全程不抛）。对话框本体在组合根渲染，
// TopBar 的在线入口按钮只置 online.dialogOpen。 ——
const online = createOnlineStore({ api: apicc });
// —— AI store（M6-C 任务 1 装配）：同一组合根一次性创建；挂载后读持久化配置与 key
// 状态（init 全程不抛）。对话框/抽屉本体在组合根渲染，接口头部入口按钮只置显隐/拉取。 ——
const ai = createAiStore({ api: apicc, editor });
// —— 插件 store（M7-B 任务 1 装配）：同一组合根一次性创建；挂载后拉取 plugins:list
// （fixture 桩）——插件视图清单 + 导入向导的导入格式动态枚举共用此份状态。 ——
const plugins = createPluginsStore({ api: apicc });
onMounted(() => {
  void online.init();
  void ai.init();
  void plugins.init();
});

// —— 视图切换（M8 模块化）：ModuleRail v-model:view；接口模块子视图独立状态 ——
// 门控语义（viewSwitch 单测钉住）：在线模式全部禁用（含 plugins）；plugins 管理类
// 视图恒可用；其余工作区级；压测接口级。
const VIEWS: SwitchView[] = SWITCH_VIEWS;
const SUB_VIEWS: ApiSubView[] = API_SUB_VIEWS;
const view = ref<SwitchView>("api");
const apiSubView = ref<ApiSubView>("debug");
const railGate = computed(() => ({
  workspaceOpened: workspace.opened,
  onlineActive: !!online.activeWorkspace,
  apiSelected: !!editor.apiId,
}));
const subGate = computed(() => ({ onlineActive: !!online.activeWorkspace, apiSelected: !!editor.apiId }));

// —— 树面板头（M8）：模块标题 + 前端搜索（SideTree 按 label 过滤）——
const treeFilter = ref("");
const siderTitle = computed(() => t(`nav.${view.value}`));

// —— 压测会话随接口切换清空（M2-D3 任务 3，裁定 A）——
// 旧接口的压测报告不能带到新接口：editor.apiId 变化（含首次 null→id，此时本就是空会话）
// 即调 store.clear()（只清报告/file/错误，form 保留；同时代际 +1，在途旧 run 的完成/
// 拒绝不再上屏——终审修复）；同接口视图往返不动 apiId，form/报告原样保留。
watch(
  () => editor.apiId,
  () => {
    stress.clear();
  },
);

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
 * 拉取 AI 建议用例（M6-C 任务 1，规格 §2 D4 调试视图入口）：成功 → store 打开建议抽屉；
 * 失败（如未配置 AI 密钥）→ store.error 上屏于抽屉/对话框，此处兜底转报错误通道。
 * M8：入口按钮自 debug-ai-bar 收编进接口模块头部（api-head），全子视图可达。
 */
async function onAiSuggest() {
  try {
    await ai.fetchSuggestions();
  } catch (e) {
    reportError(e);
  }
}

/**
 * 侧树选中回调：在线工作区激活时路由到在线编辑链路（api → 取内容进在线编辑缓冲；
 * file → 只读原文；其余仅记录选中，裁定 B）；本地模式保持原行为——接口节点加载进编辑器
 * （不强制切模块：创建接口的 select 事件同样走此通道，保持所在模块不被踹走，
 * 行为与 M8 前对等；工作流节点除外——加载进工作流设计器并切到工作流模块，先例保留），
 * 缓冲 dirty 时先经确认对话框放行（审查 I1 修复），确认丢弃后才载入目标流，
 * 不再静默覆盖未保存编辑。其余节点仅记录选中态。
 */
async function onSelect(kind: TreeNodeDTO["kind"], id: string) {
  if (online.activeWorkspace) {
    try {
      await online.selectNode(kind, id);
    } catch (e) {
      reportError(e);
    }
    return;
  }
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

/** 载入工作流进设计器并切到 wf 模块（load 失败经 reportError 上报，与对话框链路同一收口点）。 */
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

/** 导入向导取消（close 事件）：回接口模块调试子视图（M8 前为回 debug 视图，语义等价）。 */
function onImportClose() {
  view.value = "api";
  apiSubView.value = "debug";
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

// —— 调试子视图可拖拽分割（M8）：pointer 拖拽调整响应区高度占比（20%–70% 夹取），
// 双击复位默认 40%。纯前端布局态，不入 store、不持久化；拖拽监听挂分割条自身并
// 以 setPointerCapture 捕获，指针移出条外仍持续生效，pointerup 解绑。
const viewerPct = ref(40);

function onDividerDown(e: PointerEvent) {
  const divider = e.currentTarget as HTMLElement;
  const container = divider.parentElement;
  if (!container) return;
  const height = container.clientHeight;
  const startY = e.clientY;
  const startPct = viewerPct.value;
  divider.setPointerCapture(e.pointerId);
  const onMove = (ev: PointerEvent) => {
    if (height <= 0) return;
    const pct = startPct + ((startY - ev.clientY) / height) * 100;
    viewerPct.value = Math.min(70, Math.max(20, pct));
  };
  const onUp = (ev: PointerEvent) => {
    divider.releasePointerCapture(ev.pointerId);
    divider.removeEventListener("pointermove", onMove);
    divider.removeEventListener("pointerup", onUp);
  };
  divider.addEventListener("pointermove", onMove);
  divider.addEventListener("pointerup", onUp);
}

function onDividerDblClick() {
  viewerPct.value = 40;
}
</script>

<template>
  <ConfigProvider :locale="antdLocale" :theme="antdThemeConfig">
    <a-layout class="app" data-testid="app-root">
      <TopBar :workspace="workspace" :api="apicc" :online="online" :report-error="reportError" />
      <a-alert v-if="errorMessage" class="app-error" type="error" show-icon data-testid="app-error" @close="dismissError">
        <template #message>{{ t("app.error") }}: {{ errorMessage }}</template>
        <template #closeText><span data-testid="app-error-close">{{ t("common.close") }}</span></template>
      </a-alert>
      <div class="body">
        <!-- 图标导航栏（M8）：v-model:view + 门控上下文；在线模式全禁用 -->
        <ModuleRail v-model:view="view" :gate="railGate" />
        <!-- 树面板（M8）：模块标题 + 搜索（本地模式开放；在线只读树同样可搜索过滤） -->
        <div class="sider-col-wrap">
          <div class="sider-head">
            <span class="sider-title" data-testid="sider-title">{{ siderTitle }}</span>
          </div>
          <div class="sider-search">
            <a-input
              v-model:value="treeFilter"
              size="small"
              allow-clear
              data-testid="tree-search"
              :placeholder="t('tree.search')"
            />
          </div>
          <!-- workflow-design 注入（审查 I2）：侧树重命名命中设计器正开的流时强制卸载会话。
               在线模式（任务 3）：treeRoot 切在线树视图、readonly 只读装饰、空态文案覆写 -->
          <SideTree
            class="side-col"
            :api="apicc"
            :workspace="workspace"
            :tree="tree"
            :workflow-design="workflowDesign"
            :report-error="reportError"
            :filter="treeFilter"
            :tree-root="online.activeWorkspace ? online.onlineTree : undefined"
            :readonly="!!online.activeWorkspace"
            :empty-text="online.activeWorkspace ? t('online.treeEmpty') : undefined"
            @select="onSelect"
          />
        </div>
        <div class="right-col" data-testid="main-split">
          <!-- 在线工作区模式（任务 3）：只提供浏览/编辑面板，不提供调试/运行等本地模块 -->
          <OnlineApiEditor v-if="online.activeWorkspace" class="panel-view" :online="online" />
          <!-- 接口模块（M8）：头部（子视图页签 + AI 入口）+ 调试/设计/用例子视图 -->
          <template v-else-if="view === 'api'">
            <div class="api-head" data-testid="api-head">
              <a-radio-group v-model:value="apiSubView" size="small" class="sub-tabs" data-testid="api-sub-tabs">
                <a-radio-button
                  v-for="s in SUB_VIEWS"
                  :key="s"
                  :value="s"
                  :data-testid="`view-${s}`"
                  :disabled="isApiSubViewDisabled(subGate)"
                >
                  {{ t(`nav.${s}`) }}
                </a-radio-button>
              </a-radio-group>
              <span class="head-spacer"></span>
              <!-- AI 入口（M6-C 任务 1）自 debug-ai-bar 收编于接口头部：全子视图可达 -->
              <a-space :size="8">
                <a-button
                  size="small"
                  data-testid="ai-suggest-btn"
                  :disabled="!editor.apiId"
                  :loading="ai.suggestLoading"
                  @click="onAiSuggest"
                >
                  {{ t("ai.suggestBtn") }}
                </a-button>
                <a-button size="small" data-testid="ai-config-btn" @click="ai.configDialogOpen = true">
                  {{ t("ai.configBtn") }}
                </a-button>
              </a-space>
            </div>
            <!-- 调试子视图：上编辑器 / 可拖拽分割条 / 下响应（结构契约：main-split 四子元素） -->
            <template v-if="apiSubView === 'debug'">
              <div class="editor-pane" data-testid="editor-pane">
                <RequestEditor :editor="editor" :debug="debug" />
              </div>
              <div
                class="split-divider"
                data-testid="split-divider"
                role="separator"
                :aria-label="t('app.splitDivider')"
                @pointerdown="onDividerDown"
                @dblclick="onDividerDblClick"
              ></div>
              <div class="viewer-pane" data-testid="viewer-pane" :style="{ height: `${viewerPct}%` }">
                <ResponseViewer :result="debug.result" :sending="debug.sending" :error="debug.error" />
              </div>
            </template>
            <DesignPanel v-else-if="apiSubView === 'design'" class="panel-view" :editor="editor" :design="design" :report-error="reportError" />
            <CasePanel v-else class="panel-view" :editor="editor" :cases="cases" :report-error="reportError" />
          </template>
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
          <ImportWizard v-else-if="view === 'import'" class="panel-view" :import-w="importW" :plugins="plugins" :report-error="reportError" @close="onImportClose" />
          <!-- 压测模块（M2-D3 任务 3）：apiId/cases/envs 取 editor store 当前接口；rail 已按
               接口选中门控，此分支保证 apiId 非空（类型收窄 + 防御） -->
          <StressPanel
            v-else-if="view === 'stress' && editor.apiId"
            class="panel-view"
            :stress="stress"
            :api-id="editor.apiId"
            :cases="editor.api?.cases ?? []"
            :envs="editor.envs"
            :report-error="reportError"
          />
          <!-- 插件管理模块（M7-B 任务 1，裁定①）：只读清单 + 失败诊断（fixture 桩）。
               置于兜底分支之前：内容区兜底仍是设计器（wf 模块与 stress 未选接口的防御路径不变） -->
          <PluginsView v-else-if="view === 'plugins'" class="panel-view" :plugins="plugins" />
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
        </div>
      </div>
    <!-- 侧树切换工作流的 dirty 丢弃确认（审查 I1）：a-modal 传送门渲染于 body -->
    <ConfirmDialog
      :open="wfSwitchConfirmOpen"
      :title="t('wf.discardConfirm')"
      @confirm="onWfSwitchConfirm"
      @cancel="onWfSwitchCancel"
    />
    <!-- 在线登录与服务器配置对话框（M3-B 任务 2）：a-modal 传送门渲染于 body；
         显隐由 online store 的 dialogOpen 驱动（TopBar 入口 / 对话框关闭双向读写）。
         workspace 注入供任务 3 的工作区列表打开入口做模式互斥（先关本地工作区） -->
    <OnlineLoginDialog :online="online" :workspace="workspace" />
    <!-- 在线推送冲突对话框（任务 3 裁定 C）：online.conflict 驱动 -->
    <OnlineConflictDialog :online="online" />
    <!-- 在线工作区迁移向导（任务 3 裁定 D）：TopBar 迁移入口置 migrateDialogOpen -->
    <OnlineMigrateDialog :online="online" :api="apicc" :report-error="reportError" />
    <!-- AI 配置对话框与建议抽屉（M6-C 任务 1）：接口头部入口按钮置显隐/拉取 -->
    <AiConfigDialog :ai="ai" />
    <AiSuggestionsDrawer :ai="ai" />
  </a-layout>
  </ConfigProvider>
</template>

<style>
html, body, #app { height: 100%; margin: 0; }
.app { height: 100%; background: var(--bg); color: var(--text); }
.body { flex: 1; display: flex; min-height: 0; }
/* 树面板列（M8）：240px 定宽 + 头部（模块标题/搜索）+ 侧树；替代原 a-layout-sider */
.sider-col-wrap {
  width: 240px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-right: 1px solid var(--border);
  background: var(--bg);
}
.sider-head { padding: 8px 10px 0; }
.sider-title { font-weight: 600; font-size: 13px; }
.sider-search { padding: 6px 10px; }
.side-col { flex: 1; min-height: 0; }
.right-col { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.editor-pane { flex: 1; min-height: 0; overflow: auto; }
/* 可拖拽分割条（M8）：5px 命中区，hover/拖拽高亮 */
.split-divider {
  flex: none;
  height: 5px;
  cursor: row-resize;
  border-top: 1px solid var(--border);
  background: transparent;
}
.split-divider:hover { background: var(--active-weak); }
.viewer-pane { flex: none; overflow: auto; border-top: 1px solid var(--border); box-sizing: border-box; }
/* 接口模块头部（M8）：子视图页签 + 右侧 AI 入口 */
.api-head { display: flex; align-items: center; gap: 8px; padding: 6px 10px; }
.api-head .head-spacer { flex: 1; }
.panel-view { flex: 1; min-height: 0; overflow: auto; }
/* 设计器视图：三区布局占满内容区（画布需要确定高度的容器，否则 Vue Flow 视口失真） */
.wf-view { flex: 1; min-height: 0; overflow: hidden; }
</style>

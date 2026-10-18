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
  Tag as ATag,
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
import type { ApiRequest, DebugFieldState } from "@apicc/core";
import type { OnlineTreeNodeDTO, TreeNodeDTO } from "../../shared/tree-dto.js";
import type { LocalTreeNodeDTO } from "../../shared/tree-dto.js";
import type { NodeCreatedDTO } from "../../shared/types.js";
import type { ApiLocator, ApiParentLocator, CollectionLocator, ProjectLocator, WorkflowLocator } from "../../shared/locations.js";
import type { OnlineWorkspaceSummary } from "../../shared/online/contract.js";
import TopBar from "./components/TopBar.vue";
import HomeView from "./components/HomeView.vue";
import TestView from "./components/TestView.vue";
import TestSidebar from "./components/TestSidebar.vue";
import ModuleRail from "./components/ModuleRail.vue";
import SideTree from "./components/SideTree.vue";
import ConfirmDialog from "./components/ConfirmDialog.vue";
import OnlineLoginDialog from "./components/OnlineLoginDialog.vue";
import OnlineApiEditor from "./components/OnlineApiEditor.vue";
import OnlineConflictDialog from "./components/OnlineConflictDialog.vue";
import OnlineMigrateDialog from "./components/OnlineMigrateDialog.vue";
import RequestEditor from "./components/RequestEditor.vue";
import ResponseViewer from "./components/ResponseViewer.vue";
import RequestTabs from "./components/RequestTabs.vue";
import DebugHistory from "./components/DebugHistory.vue";
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
import { useDebugHistoryStore } from "./stores/debugHistory.js";
import { useAssetsStore } from "./stores/assets.js";
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
import { createRequestTabsStore, type RequestTab, type RequestCloseState } from "./stores/requestTabs.js";
import {
  createTabsStore,
  createEvictProjectSessions,
  findProjectNode,
  readPersistedTabs,
  type ProjectTab,
} from "./stores/tabs.js";
import { useModuleMemoryStore } from "./stores/moduleMemory.js";
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
import { localTreeNodeKey, type LocalTreeIdentity } from "../../shared/tree-dto.js";

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
const localContext = () => ({ root: workspace.root, readOnly: workspace.readOnly });
const editor = useEditorStore(apicc, localContext);
const assets = useAssetsStore(apicc, () => ({ root: workspace.root, readOnly: workspace.readOnly }));
let debugInstance: ReturnType<typeof useDebugStore> | null = null;
let requestTabsRef: ReturnType<typeof createRequestTabsStore> | null = null;
let requestContextRoot = "";
let requestProjectContext: ProjectLocator | null = null;
const requestCloseConfirmOpen = ref(false);
let requestCloseResolve: ((accepted: boolean) => void) | null = null;
function confirmRequestTabClose(_tabId: string, _state: RequestCloseState): Promise<boolean> {
  if (requestCloseResolve) return Promise.resolve(false);
  requestCloseConfirmOpen.value = true;
  return new Promise<boolean>((resolve) => { requestCloseResolve = resolve; });
}
function finishRequestTabClose(accepted: boolean) {
  requestCloseConfirmOpen.value = false;
  requestCloseResolve?.(accepted);
  requestCloseResolve = null;
}
const requestTabs = createRequestTabsStore({
  getContext: () => ({ root: workspace.root, project: requestContextRoot === workspace.root ? requestProjectContext : null }),
  isDirty: (tabId) => {
    const tab = requestTabsRef?.tabs[tabId];
    return !!tab && (editor.isRequestDirty(tab) || debugInstance?.isRequestTabDirty(tabId) === true);
  },
  isRunning: (tabId) => debugInstance?.isRequestTabRunning(tabId) ?? false,
  confirmClose: confirmRequestTabClose,
  confirmCloseMany: (_tabs: RequestTab[], state: RequestCloseState) => confirmRequestTabClose("multiple", state),
  cancelRun: async (tabId) => { await debugInstance?.cancelRequestTab(tabId); },
  evict: (tabId) => {
    const tab = requestTabsRef?.tabs[tabId];
    if (tab) editor.evictRequestTab(tab);
    debugInstance?.evictRequestTab(tabId);
  },
});
requestTabsRef = requestTabs;
const debug = debugInstance = useDebugStore(apicc, editor, localContext, requestTabs);
const debugHistory = useDebugHistoryStore(apicc);
const historyOpen = ref(false);
// —— 视图面板 store（任务 8 装配）：与既有 store 同一组合根一次性创建 ——
const cases = useCasesStore(apicc, editor);
const envs = useEnvsStore(apicc, localContext);
const run = useRunStore(apicc);
const importW = useImportWizardStore(apicc, workspace);
const design = useDesignStore(apicc, editor);
// —— 工作流设计器 store（M2-B 任务 4 装配）：同一组合根一次性创建 ——
const wfList = useWfListStore(apicc, localContext);
const workflowDesign = useWorkflowDesignStore(apicc, localContext);
// —— 压测 store（M2-D3 任务 3 装配，裁定 A）：同一组合根一次性创建，经 props 下传 ——
const stress = createStressStore({
  api: apicc,
  getContext: () => ({ root: workspace.root, locator: editor.locator }),
  trustOrigin: (locator, origin) => workspace.trustStressOrigin(locator, origin).then(() => undefined),
});
// —— 在线 store（M3-B 任务 2 装配）：同一组合根一次性创建；挂载后对上次激活的服务器
// 尝试恢复登录态（裁定 A resume 链路，init 全程不抛）。对话框本体在组合根渲染，
// TopBar 的在线入口按钮只置 online.dialogOpen。 ——
const online = createOnlineStore({ api: apicc });
// —— AI store（M6-C 任务 1 装配）：同一组合根一次性创建；挂载后读持久化配置与 key
// 状态（init 全程不抛）。对话框/抽屉本体在组合根渲染，接口头部入口按钮只置显隐/拉取。 ——
const ai = createAiStore({ api: apicc, editor, getContext: localContext });
// —— 插件 store（M7-B 任务 1 装配）：同一组合根一次性创建；挂载后拉取 plugins:list
// （fixture 桩）——插件视图清单 + 导入向导的导入格式动态枚举共用此份状态。 ——
const plugins = createPluginsStore({ api: apicc });
// —— 项目页签 store（计划 C 任务 5 装配）：签注册表 + 激活编排 + 关签驱逐真实实现 ——
// 关签驱逐按 createEvictProjectSessions 组装（不变量 3：关签=项目关闭）；onProjectActivated
// 钩子 = lastApi 记忆按活跃签项目过滤恢复（restoreLastApiForTab，编排第③步 editor 上下文）；
// confirmWorkflowDraft = 切签工作流草稿确认（任务 6 规格勘误口径，弹窗与钩子实现见下文）。
const tabs = createTabsStore({
  workspace,
  tree,
  online,
  editor,
  workflowDesign,
  requestTabs,
  evictProjectSessions: createEvictProjectSessions({ editor, online, workflowDesign, requestTabs }),
  onProjectActivated: restoreLastApiForTab,
  confirmWorkflowDraft,
});

// 启动恢复由签表驱动；模块选择与树状态由按 root+ProjectLocator 分区的 moduleMemory 持久化。

function findLocalNodeByKey(key: string): LocalTreeNodeDTO | null {
  let result: LocalTreeNodeDTO | null = null;
  const visit = (node: LocalTreeNodeDTO): void => {
    if (node.key === key) { result = node; return; }
    for (const child of node.children ?? []) visit(child);
  };
  if (workspace.tree) visit(workspace.tree);
  return result;
}

function sameProjectLocator(left: ProjectLocator, right: ProjectLocator): boolean {
  return left.workspaceId === right.workspaceId && left.groupId === right.groupId && left.projectId === right.projectId;
}

function projectOfLocator(locator: ProjectLocator | ApiLocator | WorkflowLocator | CollectionLocator): ProjectLocator {
  return { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId };
}

/** One local API activation path keeps editor, project assets, and design drafts on the same locator. */
async function activateRequestTab(tabId: string, showRequestEditor = true): Promise<void> {
  const tab = requestTabs.tabs[tabId];
  if (!tab || tab.root !== workspace.root) return;
  requestTabs.activate(tabId);
  if (showRequestEditor) {
    view.value = "api";
    apiSubView.value = "debug";
  }
  const isCurrent = () => requestTabs.activeId === tabId && requestTabs.isCurrent(tabId, tab.generation, tab.root);
  debug.requestTabState(tab);
  if (tab.source.kind === "free") {
    const session = await editor.loadFreeRequestTab(tab, isCurrent);
    if (!session || !isCurrent()) return;
    editor.activateFree(tabId);
    return;
  }
  const nodeKey = localTreeNodeKey({ source: "local", kind: "api", locator: tab.source.locator });
  const node = findLocalNodeByKey(nodeKey);
  if (node?.kind === "api") tree.select(node);
  await loadApiIntoEditor(tab.source.locator, isCurrent, false);
}

function openFreeRequestTab(): void {
  const context = selectedProjectContext.value;
  if (!context || isHome.value || onlineMode.value || context.root !== workspace.root) return;
  requestContextRoot = context.root;
  requestProjectContext = { ...context.locator };
  try {
    const tabId = requestTabs.open({ kind: "free", project: { ...context.locator }, draftId: crypto.randomUUID() });
    void activateRequestTab(tabId).catch(reportError);
  } catch (error) {
    reportError(error);
  }
}

async function loadApiIntoEditor(locator: ApiLocator, isCurrent: () => boolean = () => true, openRequestTab = true): Promise<void> {
  const root = workspace.root;
  const expected = { ...locator, folderIds: [...locator.folderIds] };
  if (!isCurrent()) return;
  if (openRequestTab) {
    const project = projectOfLocator(expected);
    requestContextRoot = root;
    requestProjectContext = project;
    const tabId = requestTabs.open({ kind: "asset", locator: expected });
    await activateRequestTab(tabId, false);
    return;
  }
  await editor.load(locator, isCurrent);
  if (!isCurrent() || workspace.root !== root || !editor.locator || JSON.stringify(editor.locator) !== JSON.stringify(expected)) return;
  const project = workspace.projectLocatorForApi(expected);
  if (!project) throw new Error("接口 locator 在当前本地树中不存在");
  await assets.load(project);
  if (!isCurrent() || workspace.root !== root || !editor.locator || JSON.stringify(editor.locator) !== JSON.stringify(expected)) return;
  design.load();
}

/**
 * 活跃签项目驱动编辑器上下文（tabs.onProjectActivated 钩子）：apicc.lastApi 记忆仅当属于
 * 活跃签项目时恢复（按当前树反查接口归属项目过滤，findProjectIdByApiId）——跨项目/跨
 * 工作区的旧记忆不再串扰。在线签不消费（该键仅本地侧树写入，见 SideTree selectNode）。
 * 任务 7 冒烟修复：切到的项目没有可恢复的接口记忆时，编辑器上下文清空回空白
 * （editor.deactivate，会话槽驻留不动）——否则上一项目的活跃会话串显到当前签下。
 */
async function restoreLastApiForTab(tab: ProjectTab, isCurrent: () => boolean = () => true): Promise<void> {
  if (!isCurrent() || !("projectLocator" in tab) || workspace.root !== tab.workspaceRef.dir) return;
  moduleMemory.activateProject(tab.workspaceRef.dir, tab.projectLocator);
  requestContextRoot = tab.workspaceRef.dir;
  requestProjectContext = { ...tab.projectLocator };
  const retainedRequestTabId = requestTabs.activateProject(tab.workspaceRef.dir, tab.projectLocator);
  if (retainedRequestTabId) {
    await activateRequestTab(retainedRequestTabId, false);
    return;
  }
  try {
    const last = moduleMemory.test.apiLocator ?? moduleMemory.apiTree.lastApiLocator;
    if (last && sameProjectLocator(projectOfLocator(last), tab.projectLocator)) {
      const key = localTreeNodeKey({ source: "local", kind: "api", locator: last });
      const node = findLocalNodeByKey(key);
      if (node?.kind === "api") {
        if (!isCurrent() || workspace.root !== tab.workspaceRef.dir) return;
        tree.select(node);
        await loadApiIntoEditor(node.locator, isCurrent);
        if (!isCurrent() || workspace.root !== tab.workspaceRef.dir) return;
        return;
      }
    }
  } catch {
    // 恢复失败静默（无碍主流程）
  }
  if (isCurrent() && workspace.root === tab.workspaceRef.dir) editor.deactivate();
}

/**
 * 在线签重建前置（重启后 main/渲染层在线会话表为空）：按持久化签引用重开驻留在线工作区
 * （登录态已由 online.init/resume 验活；重开失败由 tabs.restore 标记离线，可再激活）。
 * 已驻留的工作区跳过；refreshWorkspaces/openWorkspace 内部消化错误，全程不抛。
 */
async function reopenOnlineWorkspaces(): Promise<void> {
  if (!online.loggedIn) return;
  const workspaceIds = new Set<string>();
  for (const row of readPersistedTabs(localStorage).tabs) {
    if (row.workspaceRef.kind === "online") workspaceIds.add(row.workspaceRef.workspaceId);
  }
  if (workspaceIds.size === 0) return;
  await online.refreshWorkspaces();
  for (const workspaceId of workspaceIds) {
    if (online.sessions[workspaceId]) continue;
    const target = online.workspaces.find((w) => w.id === workspaceId);
    if (target) await online.openWorkspace(target);
  }
}

onMounted(async () => {
  ai.init().catch(() => undefined);
  plugins.init().catch(() => undefined);
  // 在线静默恢复（token 续登）优先——登录态是在线签重建的前置
  try {
    await online.init();
  } catch {
    // init 内部已消化错误
  }
  await reopenOnlineWorkspaces();
  // 启动按签恢复（不变量 5）：本地签重开目录、活跃签走完整激活编排（含 lastApi 按项目
  // 过滤恢复）；失败签标记离线（可再激活），活跃落空 → 停留主页
  await tabs.restore();
});

// —— 视图切换（M8 模块化）：ModuleRail v-model:view；接口模块子视图独立状态 ——
// 门控语义（viewSwitch 单测钉住）：在线模式全部禁用（含 plugins）；plugins 管理类
// 视图恒可用；其余工作区级；压测接口级。
const VIEWS: SwitchView[] = SWITCH_VIEWS;
const SUB_VIEWS: ApiSubView[] = API_SUB_VIEWS;
// 项目模块保持原状态；主页/项目页面选择只由 tabs.selectedPage 控制。
const view = ref<SwitchView>("api");
const apiSubView = ref<ApiSubView>("debug");
// —— 内容上下文由活跃签驱动（计划 C 任务 5）：活跃签是本地签 → 本地内容；活跃签是在线签
// （或无签但有活跃在线工作区——主页打开在线工作区尚未成签的过渡态）→ 在线内容。切到本地
// 签不退在线会话（驻留，不变量 4：工作区级关闭唯一入口=退出在线工作区按钮）。
function isLocalProjectTab(tab: ProjectTab | null): tab is Extract<ProjectTab, { projectLocator: ProjectLocator }> {
  return tab !== null && "projectLocator" in tab;
}

const activeLocalProjectTab = computed(() => isLocalProjectTab(tabs.activeTab) ? tabs.activeTab : null);
const retainedLocalProjectTab = computed(() => isLocalProjectTab(tabs.contextTab) ? tabs.contextTab : null);
const isHome = computed(() => tabs.selectedPage.kind === "home");
const onlineMode = computed(() => online.activeWorkspace !== null && activeLocalProjectTab.value === null);
const railGate = computed(() => ({
  workspaceOpened: workspace.opened,
  onlineActive: onlineMode.value,
  apiSelected: !!editor.apiId || !!editor.activeFreeSession,
}));
const subGate = computed(() => ({ onlineActive: onlineMode.value, apiSelected: !!editor.apiId || !!editor.activeFreeSession }));
// 主页项目卡片高亮（任务 5 D）：该项目签存在且激活（从 tabs store 算，不再看树选中）
const homeActiveProjectId = computed(() => activeLocalProjectTab.value?.projectLocator.projectId ?? null);
// 主页在线项目卡片高亮（终审 Important 1 ②）：活跃签为在线签时的 projectId
const homeActiveOnlineProjectId = computed(() => {
  const tab = tabs.activeTab;
  return tab && !isLocalProjectTab(tab) ? tab.projectId : null;
});

// 激活失败文案（离线标记等）上屏到既有错误通道（tabs store 契约：error 组件上屏）
watch(
  () => tabs.error,
  (message) => {
    if (message) reportError(new Error(message));
  },
);

// —— 树面板头（M8）：模块标题 + 前端搜索（SideTree 按 label 过滤）——
// 模块侧栏记忆（M11）：接口树过滤、测试页签/选中接口——重启保留
const moduleMemory = useModuleMemoryStore();
const treeFilter = computed({
  get: () => moduleMemory.apiTree.filter,
  set: (v: string) => {
    moduleMemory.apiTree.filter = v;
    moduleMemory.touch();
  },
});
// 导入向导（M10 归接口模块）：显隐状态
const importOpen = ref(false);
const siderTitle = computed(() => t(`nav.${view.value}`));

// —— 环境清单联动（M9-A1）：调试选择器读 editor.envs（选中接口时快照），环境管理里
// 新建/删除环境后必须重拉，否则选择器看不到新环境（用户实测 bug）。环境增删只发生在
// 环境模块（envs store 的 load/create/remove 必改 envs 数量），以其长度为触发源重拉；
// saveVars 不改数量且不改名，无需触发。envs 指向别项目时重拉依旧按当前接口取数，无害。
watch(
  () => envs.envs.length,
  () => {
    void editor.reloadEnvs().catch(reportError);
  },
);

// —— 压测会话随接口切换清空（M2-D3 任务 3，裁定 A）——
// 旧接口的压测报告不能带到新接口：editor.apiId 变化（含首次 null→id，此时本就是空会话）
// 即调 store.clear()（只清报告/file/错误，form 保留；同时代际 +1，在途旧 run 的完成/
// 拒绝不再上屏——终审修复）；同接口视图往返不动 apiId，form/报告原样保留。
watch(
  () => JSON.stringify([workspace.root, editor.locator]),
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
async function onSelect(node: TreeNodeDTO | NodeCreatedDTO) {
  if (node.source === "online") {
    if (node.kind === "project") openProjectTabFor(node);
    else {
      try { await online.selectNode(node.kind, node.id); }
      catch (e) { reportError(e); }
    }
    return;
  }
  if (node.kind === "project") {
    openProjectTabFor(node);
    return;
  }
  if (node.kind === "api") {
    await loadApiIntoEditor(node.locator);
  }
  if (node.kind === "workflow") {
    if (workflowDesign.dirty) {
      pendingSwitchLocator = { root: workspace.root, locator: { ...node.locator } };
      wfSwitchConfirmOpen.value = true;
      return;
    }
    await openWorkflowInDesigner(node.locator);
  }
}

// —— 工作流切换按完整 locator 捕获，确认等待期间不重新读取活动选中目标 ——
const wfSwitchConfirmOpen = ref(false);
let pendingSwitchLocator: { root: string; locator: WorkflowLocator } | null = null;

async function openWorkflowInDesigner(locator: WorkflowLocator, root = workspace.root) {
  if (workspace.root !== root) return;
  view.value = "wf";
  try {
    await workflowDesign.load(root, { ...locator });
  } catch (e) {
    reportError(e);
  }
}

function onWfSwitchConfirm() {
  const target = pendingSwitchLocator;
  pendingSwitchLocator = null;
  wfSwitchConfirmOpen.value = false;
  if (target && workspace.root === target.root) void openWorkflowInDesigner(target.locator, target.root);
}

function onWfSwitchCancel() {
  pendingSwitchLocator = null;
  wfSwitchConfirmOpen.value = false;
  const locator = workflowDesign.locator;
  if (locator && workflowDesign.root === workspace.root) {
    const key = localTreeNodeKey({ source: "local", kind: "workflow", locator });
    const node = findLocalNodeByKey(key);
    if (node?.kind === "workflow") tree.select(node);
  }
}

// M2-C 跟进：树摘要/wfList/设计器三方同步协议 + dirty 确认（侧树切换的确认放行已随
// 审查 I1 补齐；跨视图选中态/摘要一致性仍随协议收口）。

// —— 切签工作流草稿确认（计划 C 任务 6，规格勘误口径）——
// tabs.activateTab 在「离开当前项目上下文」时机回调 confirmWorkflowDraft（仅当活跃工作流
// 属于离开的项目且 dirty）：弹既有 ConfirmDialog；确认丢弃 → 卸载设计器会话（草稿丢弃、
// dirty 复位，避免下次切签重复纠缠）并放行切换；取消 → 不切换（树选中尚未被编排改动，
// 无需回退——与侧树切流确认的选中回退不同）。
const wfTabSwitchConfirmOpen = ref(false);
let wfTabSwitchResolve: ((ok: boolean) => void) | null = null;

function confirmWorkflowDraft(): Promise<boolean> {
  wfTabSwitchConfirmOpen.value = true;
  return new Promise<boolean>((resolve) => {
    wfTabSwitchResolve = resolve;
  });
}

function onWfTabSwitchConfirm() {
  workflowDesign.unload();
  wfTabSwitchConfirmOpen.value = false;
  wfTabSwitchResolve?.(true);
  wfTabSwitchResolve = null;
}

function onWfTabSwitchCancel() {
  wfTabSwitchConfirmOpen.value = false;
  wfTabSwitchResolve?.(false);
  wfTabSwitchResolve = null;
}

function onRequestTabCloseConfirm() { finishRequestTabClose(true); }
function onRequestTabCloseCancel() { finishRequestTabClose(false); }

// —— 退出程序 dirty 拦截（计划 C 任务 6，不变量 6）——
// main 关窗询问（app:dirty-check）的渲染层应答器：聚合全部草稿源——本地 editor 任一会话
// 槽 dirty + workflowDesign 单会话 + online 各驻留会话任一缓冲槽 dirty（遍历全表，任务 4
// 移交口径；判定先例同 editorDirty/projectHasDrafts 的快照比对）。
function aggregateHasDrafts(): boolean {
  for (const session of Object.values(editor.sessions)) {
    if (session.api !== null && JSON.stringify(session.api) !== session.snapshot) return true;
  }
  for (const session of Object.values(editor.freeSessions)) {
    const tab = requestTabs.tabs[session.tabId];
    if (tab && editor.isRequestDirty(tab)) return true;
  }
  for (const tabId of requestTabs.order) {
    if (debug.isRequestTabDirty(tabId) || debug.isRequestTabRunning(tabId)) return true;
  }
  if (workflowDesign.dirty) return true;
  for (const session of Object.values(online.sessions)) {
    for (const buffer of Object.values(session.buffers)) {
      if (buffer.api !== null && JSON.stringify(buffer.api) !== buffer.snapshot) return true;
    }
  }
  return false;
}
apicc.onDirtyCheck(aggregateHasDrafts);

function projectOfLocalNode(node: LocalTreeIdentity): ProjectLocator | null {
  switch (node.kind) {
    case "project": return { ...node.locator };
    case "collection":
    case "folder":
    case "api":
    case "workflow": return projectOfLocator(node.locator);
    case "environment": return {
      workspaceId: node.locator.workspaceId,
      groupId: node.locator.groupId,
      projectId: node.locator.projectId,
    };
    case "root":
    case "group": return null;
  }
}

function collectionOfLocalNode(node: LocalTreeIdentity): CollectionLocator | null {
  switch (node.kind) {
    case "collection": return { ...node.locator };
    case "folder":
    case "api": return {
      workspaceId: node.locator.workspaceId,
      groupId: node.locator.groupId,
      projectId: node.locator.projectId,
      collectionId: node.locator.collectionId,
    };
    default: return null;
  }
}

// 本地面板都消费树 DTO 已携带的完整 locator，在线节点不进入本地合同。
const selectedProjectContext = computed(() => {
  // Home 不选中任何签，但保留上下文仍归原本地项目所有。用签自身的 root，避免
  // 后台工作区切换/修复期间把环境记忆与调试选择临时挂到别的目录。
  if (isHome.value) {
    const retained = retainedLocalProjectTab.value;
    return retained ? { root: retained.workspaceRef.dir, locator: { ...retained.projectLocator } } : null;
  }
  const selected = tree.selected;
  if (onlineMode.value || selected?.source !== "local") return null;
  const locator = projectOfLocalNode(selected);
  return locator ? { root: workspace.root, locator } : null;
});
const selectedProjectLocator = computed(() => selectedProjectContext.value?.locator ?? null);
const activeProjectLocator = computed(() => selectedProjectLocator.value ? { ...selectedProjectLocator.value } : null);
const activeRequestTab = computed(() => {
  const tab = requestTabs.activeTab;
  const context = selectedProjectContext.value;
  return tab && context && tab.root === context.root && sameProjectLocator(tab.project, context.locator) ? tab : null;
});
const historyNavigationGeneration = ref(0);
watch(
  () => JSON.stringify([
    workspace.root,
    tabs.selectedPage,
    tabs.contextTabId,
    selectedProjectContext.value
      ? [selectedProjectContext.value.root, selectedProjectContext.value.locator.workspaceId,
        selectedProjectContext.value.locator.groupId, selectedProjectContext.value.locator.projectId]
      : null,
    requestTabs.activeId,
    requestTabs.activeTab?.generation ?? null,
  ]),
  () => { historyNavigationGeneration.value += 1; },
  { flush: "sync" },
);

async function createFreeRequestModule(tab: RequestTab, name: string): Promise<ApiParentLocator> {
  if (tab.source.kind !== "free" || workspace.readOnly || workspace.root !== tab.root
    || !requestTabs.isCurrent(tab.tabId, tab.generation, tab.root)
    || !sameProjectLocator(requestTabs.tabs[tab.tabId]?.project ?? tab.project, tab.source.project)) {
    throw new Error("Free 请求来源已变化，不能在其他工作区或项目创建模块。");
  }
  const created = await apicc.nodeCreate({ kind: "collection", parent: { ...tab.source.project }, name });
  if (created.kind !== "collection") throw new Error("创建接口模块失败。");
  if (workspace.root === tab.root) await workspace.refresh();
  if (workspace.root !== tab.root || !requestTabs.isCurrent(tab.tabId, tab.generation, tab.root)) {
    throw new Error("模块已创建，但请求签上下文已变化；请切回来源项目后继续。");
  }
  const free = editor.freeSessions[tab.tabId];
  if (!free || free.root !== tab.root || free.draftId !== tab.source.draftId || !sameProjectLocator(free.project, tab.source.project)) {
    throw new Error("模块已创建，但 Free 请求草稿上下文已变化；请重新打开请求签。");
  }
  const context = await apicc.debugProjectContext({ ...tab.source.project });
  if (workspace.root !== tab.root || !requestTabs.isCurrent(tab.tabId, tab.generation, tab.root)
    || editor.freeSessions[tab.tabId] !== free || !sameProjectLocator(context.project, tab.source.project)) {
    throw new Error("模块已创建，但请求签上下文已变化；请切回来源项目后继续。");
  }
  free.sourceProjectRevision = context.sourceProjectRevision;
  free.envs = context.envs.map((environment) => ({ ...environment, locator: { ...environment.locator } }));
  return { ...created.locator };
}

async function saveFreeRequestAsApi(
  tab: RequestTab,
  targetParent: ApiParentLocator,
  name: string,
  request: ApiRequest,
  fields: DebugFieldState[],
): Promise<void> {
  if (tab.source.kind !== "free") throw new Error("当前请求签不是 Free 请求。");
  const root = tab.root;
  const sourceProject = { ...tab.source.project };
  const free = editor.freeSessions[tab.tabId];
  if (!free || free.root !== root || free.draftId !== tab.source.draftId
    || !sameProjectLocator(free.project, sourceProject)
    || JSON.stringify(free.request) !== JSON.stringify(request)) throw new Error("Free 请求草稿已变化，请重试保存。");
  if (free.urlDraftInvalid) throw new Error("完整 URL 草稿无效，请修正后再保存为正式接口。");
  const submittedUrlDraft = {
    urlDraft: free.urlDraft,
    urlDraftInvalid: free.urlDraftInvalid,
    draftRevision: free.draftRevision,
  };
  if (workspace.readOnly || workspace.root !== root || !requestTabs.isCurrent(tab.tabId, tab.generation, root)
    || !sameProjectLocator(selectedProjectContext.value?.locator ?? sourceProject, sourceProject)
    || selectedProjectContext.value?.root !== root) throw new Error("项目上下文已变化或处于只读模式，拒绝保存 Free 请求。");
  if (targetParent.workspaceId !== sourceProject.workspaceId || targetParent.groupId !== sourceProject.groupId
    || targetParent.projectId !== sourceProject.projectId) throw new Error("保存目标必须属于 Free 请求的来源项目。");
  if (debug.isRequestTabRunning(tab.tabId)) throw new Error("请求运行期间不能保存为正式接口。");
  if (fields.some((field) => field.needsInput)) throw new Error("请先补齐调试恢复字段，再保存为正式接口。");

  const submitted = JSON.parse(JSON.stringify(request)) as ApiRequest;
  const submittedFields = fields.map((field) => ({ ...field }));
  const freeGeneration = free.generation;
  const expected = { root, generation: tab.generation, project: sourceProject, draftId: tab.source.draftId };
  const wasActive = requestTabs.activeId === tab.tabId;
  const created = await apicc.apiCreateFromRequestDraft({
    project: sourceProject,
    targetParent: "folderIds" in targetParent
      ? { ...targetParent, folderIds: [...targetParent.folderIds] }
      : { ...targetParent },
    name,
    request: submitted,
    sourceProjectRevision: free.sourceProjectRevision,
    fields: submittedFields,
  });

  const current = requestTabs.tabs[tab.tabId];
  const currentFree = editor.freeSessions[tab.tabId];
  const currentProjectContext = selectedProjectContext.value;
  if (!current || current.root !== root || current.generation !== expected.generation || current.source.kind !== "free"
    || current.source.draftId !== expected.draftId || !sameProjectLocator(current.source.project, sourceProject)
    || !currentFree || currentFree.generation !== freeGeneration || JSON.stringify(currentFree.request) !== JSON.stringify(submitted)
    || currentFree.urlDraft !== submittedUrlDraft.urlDraft || currentFree.urlDraftInvalid !== submittedUrlDraft.urlDraftInvalid
    || currentFree.draftRevision !== submittedUrlDraft.draftRevision
    || workspace.root !== root || !currentProjectContext || currentProjectContext.root !== root
    || !sameProjectLocator(currentProjectContext.locator, sourceProject)) {
    throw new Error("接口已在来源项目创建，但源请求签已变化；草稿保持原样，请切回来源项目刷新后查看新接口。");
  }
  if (!requestTabs.canConvertFreeToAsset(tab.tabId, expected, created.locator)) {
    throw new Error("接口已创建，但请求签上下文已变化；原 Free 请求仍保留，请从项目树打开新接口。");
  }
  if (!editor.canAdoptCreatedApiForFreeTab(current, freeGeneration, submitted, created.detail, submittedUrlDraft)) {
    throw new Error("接口已创建，但源草稿未能安全转换；原 Free 请求仍保留，请从项目树打开新接口。");
  }
  if (!debug.canConvertRequestTab(tab.tabId, expected)) {
    throw new Error("接口已创建，但调试会话上下文已变化；原 Free 请求仍保留，请从项目树打开新接口。");
  }
  // All fallible guards run before the first mutation. Keep these three store commits
  // in one synchronous turn: no async callback can invalidate the preflight between them.
  const adopted = editor.adoptCreatedApiForFreeTab(current, freeGeneration, submitted, created.detail, submittedUrlDraft);
  if (!adopted) throw new Error("接口已创建，但请求签状态未能安全转换；请从项目树打开新接口。");
  const converted = requestTabs.commitFreeToAsset(tab.tabId, created.locator);
  debug.commitRequestTabConversion(converted, adopted.generation);

  await workspace.refresh();
  if (!wasActive || requestTabs.activeId !== tab.tabId || workspace.root !== root
    || !requestTabs.isCurrent(tab.tabId, converted.generation, root)) return;
  const node = findLocalNodeByKey(localTreeNodeKey({ source: "local", kind: "api", locator: created.locator }));
  if (node?.kind === "api") tree.select(node);
  view.value = "api";
  apiSubView.value = "debug";
  await activateRequestTab(tab.tabId, true);
}

function historyProjectIsCurrent(root: string, project: ProjectLocator): boolean {
  const context = selectedProjectContext.value;
  return workspace.root === root && !!context && context.root === root && sameProjectLocator(context.locator, project);
}

async function openFreeHistoryRequest(input: { historyId: string; exchangeOrder: number; project: ProjectLocator }): Promise<{
  sourceChanged: boolean;
  sourceAvailable: boolean;
  invocation: Extract<import("@apicc/core").DebugInvocation, { mode: "free" }> | null;
  tab: RequestTab | null;
  isCurrent: () => boolean;
} | null> {
  const root = workspace.root;
  const originatingTabId = requestTabs.activeId;
  const originatingTabGeneration = originatingTabId ? requestTabs.tabs[originatingTabId]?.generation ?? null : null;
  const originatingNavigationGeneration = historyNavigationGeneration.value;
  const sourceProject = { ...input.project };
  const originIsCurrent = () => historyNavigationGeneration.value === originatingNavigationGeneration
    && workspace.root === root
    && requestTabs.activeId === originatingTabId
    && (originatingTabId === null || (originatingTabGeneration !== null
      && requestTabs.isCurrent(originatingTabId, originatingTabGeneration, root ?? "")))
    && !!root && historyProjectIsCurrent(root, sourceProject);
  if (!root || !historyProjectIsCurrent(root, input.project)) throw new Error("请先切换到 Free 请求的来源项目。");
  const restored = await apicc.debugHistoryRestore({ historyId: input.historyId, exchangeOrder: input.exchangeOrder, project: sourceProject });
  if (!originIsCurrent()) return null;
  if (restored.invocation.mode !== "free" || !sameProjectLocator(restored.invocation.project, sourceProject)) {
    throw new Error("所选历史不是当前项目的 Free 请求。");
  }
  debug.freeRestoredPreview = restored.sourceAvailable ? null : JSON.parse(JSON.stringify(restored.invocation));
  debug.restoredPreview = null;
  debug.restoredSourceAvailable = restored.sourceAvailable;
  if (!restored.sourceAvailable) return {
    sourceChanged: restored.sourceChanged, sourceAvailable: false, invocation: restored.invocation, tab: null, isCurrent: originIsCurrent,
  };

  const tabId = requestTabs.open({ kind: "free", project: sourceProject, draftId: crypto.randomUUID() });
  const tab = requestTabs.tabs[tabId];
  if (!tab || tab.source.kind !== "free") throw new Error("无法创建 Free 历史请求签。");
  const restoredNavigationGeneration = historyNavigationGeneration.value;
  const isCurrent = () => historyNavigationGeneration.value === restoredNavigationGeneration
    && requestTabs.activeId === tabId && requestTabs.isCurrent(tabId, tab.generation, root)
    && historyProjectIsCurrent(root, sourceProject);
  try {
    await activateRequestTab(tabId, true);
    if (!isCurrent()) throw new Error("恢复期间请求签或项目已切换，未应用迟到的历史请求。");
    const free = await editor.applyFreeHistoryRequest(tab, restored.invocation, isCurrent);
    if (!free || !isCurrent()) throw new Error("Free 历史请求未能安全恢复到新请求签。");
    if (!debug.applyFreeHistoryRestore(tab, restored.invocation, free.generation, editor)) {
      throw new Error("Free 历史调试状态未能安全恢复到新请求签。");
    }
    if (!isCurrent()) throw new Error("恢复期间请求签或项目已切换，未应用迟到的历史请求。");
    debug.freeRestoredPreview = null;
    return { sourceChanged: restored.sourceChanged, sourceAvailable: true, invocation: restored.invocation, tab, isCurrent };
  } catch (error) {
    if (requestTabs.tabs[tabId]) await requestTabs.closeMany([tabId], false);
    throw error;
  }
}

async function restoreFreeHistory(input: { historyId: string; exchangeOrder: number; project: ProjectLocator }) {
  const restored = await openFreeHistoryRequest(input);
  if (!restored) return null;
  return { sourceChanged: restored.sourceChanged, sourceAvailable: restored.sourceAvailable };
}

async function replayFreeHistory(input: { historyId: string; exchangeOrder: number; project: ProjectLocator; draftId: string }): Promise<void> {
  const restored = await openFreeHistoryRequest(input);
  if (!restored || !restored.sourceAvailable || !restored.invocation || !restored.tab || !restored.isCurrent()) return;
  if (restored.invocation.fields.some((field) => field.needsInput)) throw new Error("请先补齐历史请求中的必填字段，或先恢复为新请求签后再重放。");
  await debug.replayFreeHistory(input.historyId, input.project, input.draftId, restored.tab, editor);
}

watch(
  () => selectedProjectContext.value ? JSON.stringify([selectedProjectContext.value.root, selectedProjectContext.value.locator]) : null,
  () => {
    const context = selectedProjectContext.value;
    moduleMemory.activateProject(context?.root ?? workspace.root, context?.locator ?? null);
    requestContextRoot = context?.root ?? "";
    requestProjectContext = context ? { ...context.locator } : null;
  },
  { immediate: true },
);

// M9-C 的「打开工作区后自动选中首个项目」随签表化退役（计划 C 任务 5）：项目上下文一律
// 由活跃签承载（不变量 1：不存在「选中项目但不入签」的状态——自动选中恰会制造该状态，
// 且会在打开目录后把用户从主页踹进项目）。打开目录后停留主页，经项目卡片/侧树点选成签。

// 不变量 1（项目选中即成签）兜底：任何本地树的项目选中（侧树点击、新建项目的内部选中）
// 统一转换成 openProjectTab（已存在仅激活）。在线上下文不走本地树（onSelect 已显式分流）；
// 启动恢复期避让。openProjectTab 去重保证激活编排内的 tree.select 不产生回路。
watch(
  () => tree.selected,
  (selected) => {
    if (!selected || selected.source !== "local" || selected.kind !== "project" || isHome.value || tabs.restoring || onlineMode.value) return;
    const project = findLocalNodeByKey(selected.key);
    if (project?.kind === "project") openProjectTabFor(project);
  },
);

/**
 * 项目选中即成签（不变量 1）：按当前内容上下文解析 workspaceRef（在线=活跃驻留会话 /
 * 本地=单例目录）与项目名后入签；同签已存在则仅激活（openProjectTab 去重）。
 */
type LocalProjectNode = Extract<TreeNodeDTO, { source: "local"; kind: "project" }> | Extract<NodeCreatedDTO, { kind: "project" }>;

function isLocalProjectNode(node: TreeNodeDTO | NodeCreatedDTO): node is LocalProjectNode {
  return node.source === "local" && node.kind === "project";
}

function isOnlineProjectNode(node: TreeNodeDTO | NodeCreatedDTO): node is OnlineTreeNodeDTO & { kind: "project" } {
  return node.source === "online" && node.kind === "project";
}

function openProjectTabFor(node: TreeNodeDTO | NodeCreatedDTO): void {
  if (isOnlineProjectNode(node) && onlineMode.value && online.activeWorkspace) {
    void tabs.openProjectTab(
      { kind: "online", workspaceId: online.activeWorkspace.id, name: online.activeWorkspace.name },
      { id: node.id, name: node.label },
    );
    return;
  }
  if (isLocalProjectNode(node)) {
    void tabs.openProjectTab({ kind: "local", dir: workspace.root }, { locator: node.locator, name: node.label });
  }
}

/** 主页「打开项目」：本地项目成签并激活，页面选择由 tabs store 统一承接。 */
function openProjectFromHome(locator: ProjectLocator) {
  const node = findProjectNode(workspace.tree, locator);
  if (node) void tabs.openProjectTab({ kind: "local", dir: workspace.root }, { locator: node.locator, name: node.label });
}

/**
 * 主页「打开在线工作区」：打开驻留会话后仍留在主页，让主页项目卡片承接成签；失败
 * （openWorkspace 不抛但活跃指针未随动）上屏错误通道并停留主页。
 */
async function openOnlineWorkspaceFromHome(ws: OnlineWorkspaceSummary) {
  await online.openWorkspace(ws);
  if (online.activeWorkspace?.id !== ws.id && online.error) reportError(new Error(online.error));
}

/**
 * 主页在线项目卡片成签（终审 Important 1 ②）：直连 tabs.openProjectTab（online 分支
 * workspaceRef，项目名取活跃会话 projects 清单）——纯在线用户在主页即可点项目成签；
 * 激活编排完成后统一切到该项目页。
 */
function openOnlineProjectFromHome(projectId: string) {
  const ws = online.activeWorkspace;
  if (!ws) return;
  const project = online.projects.find((p) => p.id === projectId);
  if (!project) return;
  void tabs.openProjectTab(
    { kind: "online", workspaceId: ws.id, name: ws.name },
    { id: project.id, name: project.name },
  );
}

// —— 测试模块（M11）：压测上下文 + 场景清单 + 侧栏选接口载入编辑器 ——
const testStressOpen = ref(false);

function onTestStress(caseId: string) {
  if (!editor.locator) return;
  stress.form.caseId = caseId;
  stress.form.envName = debug.selectedEnvName; // 与调试共享项目环境选中态
  testStressOpen.value = true;
}

function onTestPickApi(locator: ApiLocator) {
  testStressOpen.value = false;
  moduleMemory.test.apiLocator = { ...locator, folderIds: [...locator.folderIds] };
  moduleMemory.apiTree.lastApiLocator = { ...locator, folderIds: [...locator.folderIds] };
  moduleMemory.touch();
  const node = findLocalNodeByKey(localTreeNodeKey({ source: "local", kind: "api", locator }));
  if (!node || node.kind !== "api") return;
  tree.select(node);
  loadApiIntoEditor(locator).catch(reportError);
}

/** 场景清单（活动项目工作流摘要）：测试侧栏数据源。 */
const testScenarios = computed(() => {
  return selectedProjectLocator.value ? workspace.findProject(selectedProjectLocator.value)?.workflows ?? [] : [];
});

// 导入向导显隐（M10 归接口模块）：向导 close 事件由模板内联 importOpen=false 处理。

const selectedProjectStressPolicy = computed(() => {
  return selectedProjectLocator.value ? workspace.findProject(selectedProjectLocator.value)?.stressPolicy : undefined;
});

const saveSelectedProjectPolicy = async (policy: Parameters<typeof workspace.saveStressPolicy>[1]): Promise<void> => {
  const locator = selectedProjectLocator.value;
  if (locator) await workspace.saveStressPolicy(locator, policy);
};

// 环境选中态项目记忆（M10）：项目切换即换挡（恢复该项目记忆值或「无环境」）；
// 调试与压测共享同一状态源（StressPanel 传 debug）。
watch(
  () => selectedProjectContext.value ? JSON.stringify([selectedProjectContext.value.root, selectedProjectContext.value.locator]) : null,
  () => {
    debug.setProject(selectedProjectLocator.value);
  },
  { immediate: true },
);

/** 树选中节点所属集合 id：运行视图的默认选中集合（文件夹/接口向上归属）。 */
const selectedCollectionLocator = computed<CollectionLocator | null>(() => {
  const selected = tree.selected;
  return selected?.source === "local" ? collectionOfLocalNode(selected) : null;
});

// —— 工作流设计器的绑定级联索引（M2-B 任务 4 / 审查修复竞态）——
// 树 DTO 不含用例目录：按当前项目逐接口 apiGet 补齐（wfBindings 注入式取数），
// 产出 a-cascader options + 画布名称预注入 + missing 检测集合。随选中项目变化重建；
// 装载器以递增序号守护竞态：快速切换项目时先发起的后完成结果被丢弃，不覆盖新索引。
// 审查 I2：watch 源追加 workspace.tree——项目内经侧树新增/删除接口后 refresh 换新
// tree 引用即触发重建，避免改绑级联/画布预注入/missing 检测基于陈旧索引。
const bindIndexLoader = createBindIndexLoader(
  () => workspace.tree,
  (locator) => apicc.apiGet(locator),
);
const wfBindIndex = ref<WfBindIndex | null>(null);
watch(
  [() => workspace.root, () => selectedProjectLocator.value ? JSON.stringify(selectedProjectLocator.value) : null, () => workspace.opened, () => workspace.tree],
  async ([root, projectKey]) => {
    wfBindIndex.value = null;
    try {
      const locator = projectKey && selectedProjectLocator.value ? { ...selectedProjectLocator.value } : null;
      const index = await bindIndexLoader.load(locator);
      if (index && workspace.root === root && sameProjectLocator(selectedProjectLocator.value ?? locator!, locator!)) wfBindIndex.value = index;
    } catch (e) {
      if (workspace.root === root) reportError(e);
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
      <TopBar :workspace="workspace" :tree="tree" :api="apicc" :online="online" :plugins="plugins" :tabs="tabs" :report-error="reportError" />
      <a-alert v-if="errorMessage" class="app-error" type="error" show-icon data-testid="app-error" @close="dismissError">
        <template #message>{{ t("app.error") }}: {{ errorMessage }}</template>
        <template #closeText><span data-testid="app-error-close">{{ t("common.close") }}</span></template>
      </a-alert>
      <div class="body">
        <!-- 图标导航栏（M11 五项）：v-model:view + 门控上下文；主页不显示；
             在线模式全禁用 -->
        <ModuleRail
          v-if="!isHome"
          :view="view"
          :gate="railGate"
          @update:view="(v: SwitchView) => (view = v)"
        />
        <!-- API 栏（M11 按模块专用）：接口=树；测试=用例/场景导航；运行/工作流/环境与主页隐藏。
             在线模式侧栏必须可见（回归修复：M11 的 !online.activeWorkspace 条件把在线树整个藏死，
             导致在线工作区无任何项目入口——在线时 treeRoot 已切在线树，侧栏跟随显示） -->
        <div
          v-show="!isHome && (onlineMode || view === 'api')"
          class="sider-col-wrap"
          data-testid="sidebar-api"
        >
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
               在线上下文（任务 5：内容上下文由活跃签驱动）：treeRoot 切在线树视图、readonly
               只读装饰、空态文案覆写 -->
          <SideTree
            class="side-col"
            :api="apicc"
            :workspace="workspace"
            :tree="tree"
            :workflow-design="workflowDesign"
            :report-error="reportError"
            :module-memory="moduleMemory"
            :filter="treeFilter"
            :active-project-locator="activeProjectLocator"
            :tree-root="onlineMode ? online.onlineTree : undefined"
            :readonly="onlineMode"
            :empty-text="onlineMode ? t('online.treeEmpty') : undefined"
            @select="onSelect"
          />
        </div>
        <!-- 测试模块侧栏（M11）：与接口树各自独立记忆 -->
        <div v-show="!isHome && view === 'test' && !onlineMode" class="sider-col-wrap" data-testid="sidebar-test">
          <TestSidebar
            :workspace="workspace"
            :active-project-locator="selectedProjectLocator"
            :active-api-locator="editor.locator"
            :pane="moduleMemory.test.pane"
            :scenarios="testScenarios"
            :report-error="reportError"
            @update:pane="(p) => { moduleMemory.test.pane = p; moduleMemory.touch(); }"
            @pick-api="onTestPickApi"
            @open-workflow="openWorkflowInDesigner"
          />
        </div>
        <div class="right-col-wrap">
          <RequestTabs
            v-show="!isHome && !onlineMode && view === 'api' && selectedProjectContext"
            :tabs="requestTabs"
            :editor="editor"
            :root="workspace.root"
            :project="selectedProjectLocator"
            @new-free="openFreeRequestTab"
            @activate="(tabId) => { void activateRequestTab(tabId).catch(reportError); }"
          />
        <div class="right-col" data-testid="main-split">
          <!-- 主页（M9-C；轨三左右栏）：落点选择/项目卡片/连接管理，恒可用 -->
          <HomeView
            v-if="isHome"
            class="panel-view"
            :api="apicc"
            :workspace="workspace"
            :tree="tree"
            :online="online"
            :import-w="importW"
            :plugins="plugins"
            :report-error="reportError"
            :open-project="openProjectFromHome"
            :active-project-locator="activeLocalProjectTab?.projectLocator ?? null"
            :open-online-workspace="openOnlineWorkspaceFromHome"
            :open-online-project="openOnlineProjectFromHome"
            :active-online-project-id="homeActiveOnlineProjectId"
          />
          <!-- 在线工作区上下文（任务 5：活跃签在线或无签但有活跃在线工作区）：只提供浏览/编辑面板 -->
          <OnlineApiEditor v-else-if="onlineMode" class="panel-view" :online="online" />
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
                <a-button size="small" data-testid="debug-history-open" @click="historyOpen = true">{{ t("debugLoop.historyTitle") }}</a-button>
                <a-button size="small" data-testid="api-import-btn" @click="importOpen = true">
                  {{ t("api.import") }}
                </a-button>
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
            <!-- 导入向导（M10 归接口模块；轨二 module 模式）：打开时替代子视图区域——
                 产物集合并入当前项目（baseUrl 进模块变量、不造环境），无落点选择 -->
            <ImportWizard
              v-if="importOpen"
              class="panel-view"
              mode="module"
              :target-project-locator="activeProjectLocator"
              :import-w="importW"
              :plugins="plugins"
              :report-error="reportError"
              @close="importOpen = false"
            />
            <!-- 调试子视图：上编辑器 / 可拖拽分割条 / 下响应（结构契约：main-split 四子元素） -->
            <template v-else-if="apiSubView === 'debug'">
              <div class="editor-pane" data-testid="editor-pane">
                <RequestEditor
                  :editor="editor"
                  :debug="debug"
                  :api="apicc"
                  :assets="activeRequestTab?.source.kind === 'asset' ? assets : undefined"
                  :project-locator="activeRequestTab?.project ?? null"
                  :request-tab="activeRequestTab"
                  :project-node="activeRequestTab ? workspace.findProject(activeRequestTab.project) : null"
                  :create-free-module="createFreeRequestModule"
                  :save-free-request="saveFreeRequestAsApi"
                />
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
                <ResponseViewer
                  :result="activeRequestTab ? debug.requestTabState(activeRequestTab).result : debug.result"
                  :sending="activeRequestTab ? debug.requestTabState(activeRequestTab).sending : debug.sending"
                  :error="activeRequestTab ? debug.requestTabState(activeRequestTab).error : debug.error"
                  :tab-state="activeRequestTab ? debug.requestTabState(activeRequestTab) : null"
                  :api="apicc"
                />
              </div>
            </template>
            <DesignPanel v-else class="panel-view" :editor="editor" :design="design" :report-error="reportError" :read-only="workspace.readOnly" />
          </template>
          <EnvPanel
            v-else-if="view === 'envs'"
            class="panel-view"
            :envs="envs"
            :workspace="workspace"
            :project-locator="selectedProjectLocator"
            :report-error="reportError"
          />
          <RunView
            v-else-if="view === 'run'"
            class="panel-view"
            :run="run"
            :workspace="workspace"
            :selected-collection-locator="selectedCollectionLocator"
            :report-error="reportError"
          />
          <!-- 测试模块（M11）：侧栏导航 + 主区用例面板/压测上下文 -->
          <template v-else-if="view === 'test'">
            <template v-if="testStressOpen && editor.locator">
              <div class="api-head">
                <a-button size="small" data-testid="test-back-to-cases" @click="testStressOpen = false">{{ t("test.backToCases") }}</a-button>
                <a-tag color="orange">{{ t("test.stressContext") }}</a-tag>
              </div>
              <StressPanel
                class="panel-view"
                :stress="stress"
                :api-locator="editor.locator"
                :cases="editor.api?.cases ?? []"
                :envs="editor.envs"
                :debug="debug"
                :report-error="reportError"
                :policy="selectedProjectStressPolicy"
                :save-policy="saveSelectedProjectPolicy"
                :read-only="workspace.readOnly"
              />
            </template>
            <TestView
              v-else
              class="panel-view"
              :editor="editor"
              :debug="debug"
              :cases="cases"
              :envs="envs"
              :stress="stress"
              :pane="moduleMemory.test.pane"
              :report-error="reportError"
              :read-only="workspace.readOnly"
              @stress="onTestStress"
            />
          </template>
          <WfDesigner
            v-else
            class="wf-view"
            :workflow-design="workflowDesign"
            :wf-list="wfList"
            :workspace="workspace"
            :project-locator="selectedProjectLocator"
            :bind-index="wfBindIndex"
            :report-error="reportError"
          />
        </div>
        </div>
      </div>
    <!-- 侧树切换工作流的 dirty 丢弃确认（审查 I1）：a-modal 传送门渲染于 body -->
    <ConfirmDialog
      :open="wfSwitchConfirmOpen"
      :title="t('wf.discardConfirm')"
      @confirm="onWfSwitchConfirm"
      @cancel="onWfSwitchCancel"
    />
    <!-- 切签工作流草稿确认（计划 C 任务 6，规格勘误口径）：tabs.activateTab 离开当前项目前经此放行 -->
    <ConfirmDialog
      :open="wfTabSwitchConfirmOpen"
      :title="t('wf.discardConfirm')"
      @confirm="onWfTabSwitchConfirm"
      @cancel="onWfTabSwitchCancel"
    />
    <ConfirmDialog
      :open="requestCloseConfirmOpen"
      :title="t('requestTabs.closeConfirm')"
      @confirm="onRequestTabCloseConfirm"
      @cancel="onRequestTabCloseCancel"
    />
    <!-- 在线登录与服务器配置对话框（M3-B 任务 2）：a-modal 传送门渲染于 body；
         显隐由 online store 的 dialogOpen 驱动（TopBar 入口 / 对话框关闭双向读写）。
         计划 C 任务 2：打开在线工作区不再关本地（并存驻留），无需 workspace 注入。
         终审 Important 2：登出前草稿确认需要签表（受影响签聚合 + 逐工作区关签），注入 tabs -->
    <OnlineLoginDialog :online="online" :apicc="apicc" :tabs="tabs" />
    <!-- 在线推送冲突对话框（任务 3 裁定 C）：online.conflict 驱动 -->
    <OnlineConflictDialog :online="online" />
    <!-- 在线工作区迁移向导（任务 3 裁定 D）：TopBar 迁移入口置 migrateDialogOpen -->
    <OnlineMigrateDialog :online="online" :api="apicc" :report-error="reportError" />
    <!-- AI 配置对话框与建议抽屉（M6-C 任务 1）：接口头部入口按钮置显隐/拉取 -->
    <AiConfigDialog :ai="ai" />
    <AiSuggestionsDrawer :ai="ai" />
    <DebugHistory :open="historyOpen" :api="apicc" :history="debugHistory" :debug="debug" :editor="editor" :project-locator="selectedProjectLocator" :restore-free="restoreFreeHistory" :replay-free="replayFreeHistory" @close="historyOpen = false" />
  </a-layout>
  </ConfigProvider>
</template>

<style>
html, body, #app { height: 100%; margin: 0; }
.app { height: 100%; min-height: 0; overflow: hidden; background: var(--bg); color: var(--text); }
.body { flex: 1; display: flex; min-height: 0; overflow: hidden; }
/* 树面板列（M8）：240px 定宽 + 头部（模块标题/搜索）+ 侧树；替代原 a-layout-sider */
.sider-col-wrap {
  width: 240px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  border-right: 1px solid var(--border);
  background: var(--bg);
}
.sider-head { padding: 8px 10px 0; }
.sider-title { font-weight: 600; font-size: 13px; }
.sider-search { padding: 6px 10px; }
.side-col { flex: 1; min-height: 0; }
.right-col-wrap { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; flex: 1; }
.right-col { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; flex: 1; }
.editor-pane { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
/* 可拖拽分割条（M8）：5px 命中区，hover/拖拽高亮 */
.split-divider {
  flex: none;
  height: 5px;
  cursor: row-resize;
  border-top: 1px solid var(--border);
  background: transparent;
}
.split-divider:hover { background: var(--active-weak); }
.viewer-pane { flex: none; min-height: 0; overflow: hidden; border-top: 1px solid var(--border); box-sizing: border-box; }
/* 接口模块头部（M8）：子视图页签 + 右侧 AI 入口 */
.api-head { display: flex; align-items: center; gap: 8px; padding: 6px 10px; }
.api-head .head-spacer { flex: 1; }
.panel-view { flex: 1; min-height: 0; overflow: auto; }
/* 设计器视图：三区布局占满内容区（画布需要确定高度的容器，否则 Vue Flow 视口失真） */
.wf-view { flex: 1; min-height: 0; overflow: hidden; }
</style>

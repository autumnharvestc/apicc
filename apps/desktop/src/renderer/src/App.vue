<script setup lang="ts">
// 组合根（装配约定）：store 工厂每调用一次即新建独立 Pinia 实例、得到互不相通的
// 状态副本——因此全部 store 只能在此一次性创建，再经 props 向下传递；
// SideTree/RequestEditor/TopBar 等组件内部禁止重复调用工厂。
// M8 布局层级改造：九平铺视图收敛为「图标导航栏（ModuleRail）→ 树面板（带模块标题
// 与搜索）→ 内容区」；接口模块（api）内含子视图页签（调试/设计/用例），调试子视图
// 保持 main-split 上下结构（editor-pane / 可拖拽分割条 / viewer-pane）。
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick, type ComponentPublicInstance } from "vue";
import { EllipsisOutlined } from "@ant-design/icons-vue";
import { useI18n } from "vue-i18n";
import {
  ConfigProvider,
  Tag as ATag,
  Layout as ALayout,
  Alert as AAlert,
  Radio as ARadio,
  Input as AInput,
  Button as AButton,
  Modal as AModal,
  theme as antdTheme,
} from "ant-design-vue";
import zhCN from "ant-design-vue/es/locale/zh_CN";
import enUS from "ant-design-vue/es/locale/en_US";
import { apicc } from "./api";
import SyncPanel from './components/sync/SyncPanel.vue';
import { createSynchronizationStore } from './stores/synchronization.js';
import type { SyncScope } from '../../shared/synchronization.js';
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
import ActionMenu from "./components/ActionMenu.vue";
import { debugEnvironmentSelection } from "./debugEnvironment.js";
import SideTree from "./components/SideTree.vue";
import ConfirmDialog from "./components/ConfirmDialog.vue";
import OnlineLoginDialog from "./components/OnlineLoginDialog.vue";
import OnlineApiEditor from "./components/OnlineApiEditor.vue";
import OnlineProjectAssets from "./components/online/OnlineProjectAssets.vue";
import CollaborationPanel from './components/online/CollaborationPanel.vue';
import { createCollaborationStore } from './stores/collaboration.js';
import type { CollaborationLocalSource } from '../../shared/online/collaboration.js';
import type { OnlineExecutionContext } from '../../shared/online/execution.js';
import { createOnlineProjectAdapter } from "./stores/onlineProjectAdapter.js";
import OnlineConflictDialog from "./components/OnlineConflictDialog.vue";
import OnlineMigrateDialog from "./components/OnlineMigrateDialog.vue";
import RequestEditor from "./components/RequestEditor.vue";
import ProjectAssetsPanel from "./components/ProjectAssetsPanel.vue";
import MockPanel from "./components/MockPanel.vue";
import type { ProjectAssetTarget } from "./projectAssetTarget.js";
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
import { createTestingStore } from "./stores/testing.js";
import type { TestingPane } from "../../shared/testing.js";
import { useEnvsStore } from "./stores/envs.js";
import { useRunStore } from "./stores/run.js";
import { useImportWizardStore } from "./stores/importW.js";
import { useDesignStore } from "./stores/design.js";
import { useWfListStore } from "./stores/wfList.js";
import { useWorkflowDesignStore } from "./stores/workflowDesign.js";
import { createStressStore } from "./stores/stress.js";
import { createOnlineStore, type OnlineSession } from "./stores/online.js";
import { normalizeOnlineBaseUrl, type OnlineWorkspaceAction, type OnlineWorkspaceActionTarget } from "./onlineWorkspaceActions.js";
import { createAiStore } from "./stores/ai.js";
import { createPluginsStore } from "./stores/plugins.js";
import { createRequestTabsStore, type RequestTab, type RequestCloseState } from "./stores/requestTabs.js";
import {
  createTabsStore,
  createEvictProjectSessions,
  findProjectNode,
  readPersistedTabs,
  sameWorkspaceRef,
  type OnlineWorkspaceRef,
  type ProjectTab,
} from "./stores/tabs.js";
import { useModuleMemoryStore } from "./stores/moduleMemory.js";
import { apiSessionKey, projectSessionKey } from "./stores/localIdentity.js";
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
import { onlineSessionErrorKey } from "./i18n/index.js";
import { themePreference, resolveTheme, applyTheme } from "./theme.js";
import { localTreeNodeKey, type LocalTreeIdentity } from "../../shared/tree-dto.js";

const ARadioGroup = ARadio.Group;
const ARadioButton = ARadio.Button;

// —— antd ConfigProvider 联动（i18n / 主题算法）——
// locale 源 = bridge 单例当前语言；algorithm 源 = theme.ts 响应式偏好 + 系统偏好解析。
const antdLocale = computed(() => (currentLocale() === "zh-CN" ? zhCN : enUS));
const systemColorScheme = window.matchMedia("(prefers-color-scheme: dark)");
const highContrast = window.matchMedia("(forced-colors: active)");
const systemDark = ref(systemColorScheme.matches);
const resolvedTheme = computed(() => resolveTheme(themePreference.value, systemDark.value));
function syncWindowChrome() {
  void window.apicc?.setWindowChromeTheme?.(resolvedTheme.value).catch(reportError);
}
function onSystemThemeChange(event: MediaQueryListEvent) {
  systemDark.value = event.matches;
}
watch(resolvedTheme, () => {
  applyTheme(themePreference.value, systemDark.value);
  syncWindowChrome();
}, { immediate: true });
onMounted(() => {
  systemColorScheme.addEventListener?.("change", onSystemThemeChange);
  highContrast.addEventListener?.("change", syncWindowChrome);
});
onBeforeUnmount(() => {
  systemColorScheme.removeEventListener?.("change", onSystemThemeChange);
  highContrast.removeEventListener?.("change", syncWindowChrome);
});
const antdThemeConfig = computed(() => ({
  token: {
    colorPrimary: "#315fe9",
    borderRadius: 6,
    controlHeight: 32,
    fontSize: 13,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
  },
  algorithm:
    resolvedTheme.value === "dark"
      ? antdTheme.darkAlgorithm
      : antdTheme.defaultAlgorithm,
}));

const { t } = useI18n();
const workspace = useWorkspaceStore(apicc);
const tree = useTreeStore(apicc, workspace);
const localContext = () => ({ root: workspace.root, readOnly: workspace.readOnly });
const editor = useEditorStore(apicc, localContext);
const design = useDesignStore(apicc, editor);
const assets = useAssetsStore(apicc, () => ({ root: workspace.root, readOnly: workspace.readOnly }));
const mockDrafts = new Map<string, { text: string; revision: string; port: number }>();
let debugInstance: ReturnType<typeof useDebugStore> | null = null;
let requestTabsRef: ReturnType<typeof createRequestTabsStore> | null = null;
let requestContextRoot = "";
let requestProjectContext: ProjectLocator | null = null;
function requestHasDrafts(tabId: string) {
  const tab = requestTabsRef?.tabs[tabId];
  const session = tab?.source.kind === "asset" ? editor.sessions[apiSessionKey(tab.root, tab.source.locator)] : undefined;
  return !!tab && (editor.isRequestDirty(tab) || debugInstance?.isRequestTabDirty(tabId) === true
    || (session ? design.hasControlDrafts(session) : false));
}
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
  isDirty: requestHasDrafts,
  isRunning: (tabId) => debugInstance?.isRequestTabRunning(tabId) ?? false,
  confirmClose: confirmRequestTabClose,
  confirmCloseMany: (_tabs: RequestTab[], state: RequestCloseState) => confirmRequestTabClose("multiple", state),
  cancelRun: async (tabId) => { await debugInstance?.cancelRequestTab(tabId); },
  evict: (tabId) => {
    const tab = requestTabsRef?.tabs[tabId];
    if (tab) {
      if (tab.source.kind === "asset") {
        const session = editor.sessions[apiSessionKey(tab.root, tab.source.locator)];
        if (session) design.evictControlDrafts(session);
      }
      editor.evictRequestTab(tab);
    }
    debugInstance?.evictRequestTab(tabId);
  },
});
requestTabsRef = requestTabs;
const debug = debugInstance = useDebugStore(apicc, editor, localContext, requestTabs);
const debugHistory = useDebugHistoryStore(apicc);
const historyOpen = ref(false);
let historyTrigger: HTMLElement | undefined;
// —— 视图面板 store（任务 8 装配）：与既有 store 同一组合根一次性创建 ——
const cases = useCasesStore(apicc, editor);
const envs = useEnvsStore(apicc, localContext);
const run = useRunStore(apicc);
const importW = useImportWizardStore(apicc, workspace);
const moduleImportW = useImportWizardStore(apicc, {
  get root() { return workspace.root; },
  get readOnly() { return workspace.readOnly; },
  get tree() { return workspace.tree; },
  refresh: () => refreshLocalProject(),
});
// —— 工作流设计器 store（M2-B 任务 4 装配）：同一组合根一次性创建 ——
const wfList = useWfListStore(apicc, localContext);
const workflowDesign = useWorkflowDesignStore(apicc, localContext);
// —— 压测 store（M2-D3 任务 3 装配，裁定 A）：同一组合根一次性创建，经 props 下传 ——
const stress = createStressStore({
  api: apicc,
  getContext: () => ({ root: workspace.root, locator: editor.locator, projectLocator: !isHome.value && !onlineMode.value ? selectedProjectLocator.value : null }),
  trustOrigin: (locator, origin) => workspace.trustStressOrigin(locator, origin).then(() => undefined),
});
// —— 在线 store（M3-B 任务 2 装配）：同一组合根一次性创建；挂载后对上次激活的服务器
// 尝试恢复登录态（裁定 A resume 链路，init 全程不抛）。对话框本体在组合根渲染，
// 连接管理和服务器行共用在线 store 的账户入口。 ——
const online = createOnlineStore({ api: apicc });
const homeView = ref<InstanceType<typeof HomeView> | null>(null);
async function manageConnections() {
  online.dialogOpen = false;
  await tabs.activateHome();
  await nextTick();
  homeView.value?.selectConnections();
}
const collaboration = createCollaborationStore(apicc);
const pendingCollaborationSource = ref<CollaborationLocalSource | null>(null), collaborationTargetId = ref('');
function chooseCollaborationTarget(source: CollaborationLocalSource) { pendingCollaborationSource.value = source; collaborationTargetId.value = ''; }
async function prepareLocalCollaboration() { const source = pendingCollaborationSource.value!; const context = online.executionContext(collaborationTargetId.value)!; pendingCollaborationSource.value = null; collaboration.visible = true; await collaboration.selectLocal(context, source, t('collaboration.localReport')); }
async function shareOnlineLocal(value: { context: OnlineExecutionContext; source: CollaborationLocalSource }) { collaboration.visible = true; await collaboration.selectLocal(value.context, value.source, t('collaboration.localReport')); }
const onlineProjectAdapter = createOnlineProjectAdapter(online.execution, apicc, () => !online.execution.context || !online.canEdit(`${online.execution.context.scope.projectId}/project.yaml`), () => window.confirm(t('testing.discardConfirm')));
// —— AI store（M6-C 任务 1 装配）：同一组合根一次性创建；挂载后读持久化配置与 key
// 状态（init 全程不抛）。对话框/抽屉本体在组合根渲染，接口头部入口按钮只置显隐/拉取。 ——
const ai = createAiStore({ api: apicc, editor,
  getEditor: () => onlineMode.value ? onlineProjectAdapter.editor : editor,
  getContext: () => onlineMode.value ? { root: onlineProjectAdapter.editorRoot(), readOnly: onlineProjectAdapter.workspace.readOnly } : localContext(),
  getSource: () => {
    if (onlineMode.value) return online.execution.context ? { kind: 'online', context: online.execution.context } : null;
    const locator = editor.locator;
    return locator ? { kind: 'local', project: { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId } } : null;
  },
  getSourceVersion: () => onlineMode.value ? online.execution.view?.assets.version ?? null : null,
});
onBeforeUnmount(() => ai.dispose());
// —— 插件 store（M7-B 任务 1 装配）：同一组合根一次性创建；挂载后拉取 plugins:list
// （fixture 桩）——插件视图清单 + 导入向导的导入格式动态枚举共用此份状态。 ——
const plugins = createPluginsStore({ api: apicc });
// —— 项目页签 store（计划 C 任务 5 装配）：签注册表 + 激活编排 + 关签驱逐真实实现 ——
// 关签驱逐按 createEvictProjectSessions 组装（不变量 3：关签=项目关闭）；onProjectActivated
// 钩子 = lastApi 记忆按活跃签项目过滤恢复（restoreLastApiForTab，编排第③步 editor 上下文）；
// confirmWorkflowDraft = 切签工作流草稿确认（任务 6 规格勘误口径，弹窗与钩子实现见下文）。
const testing = createTestingStore(apicc, {
  confirmDiscard: () => window.confirm(t('testing.discardConfirm')),
  getActive: () => !isHome.value && !onlineMode.value && selectedProjectContext.value ? { root: selectedProjectContext.value.root, project: selectedProjectContext.value.locator, readOnly: workspace.readOnly } : null,
});
const evictSessions = createEvictProjectSessions({ editor, online, workflowDesign, requestTabs, mockProjectClose: async (root, locator) => {
  mockDrafts.delete(projectSessionKey(root, locator));
  await apicc.mockProjectClose({ root, locator });
} });
const tabs = createTabsStore({
  workspace,
  tree,
  online,
  editor,
  workflowDesign,
  requestTabs,
  evictProjectSessions: async (tab) => {
    await evictSessions(tab);
    if (tab.workspaceRef.kind === 'local' && 'projectLocator' in tab) await testing.evict(tab.workspaceRef.dir, tab.projectLocator);
  },
  onProjectActivated: restoreLastApiForTab,
  confirmWorkflowDraft,
  confirmTestingDraft: () => testing.leave(),
  testingHasDrafts: (root, project) => testing.dirty && testing.view?.context.root === root && sameProjectLocator(testing.view.context.project, project),
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
async function activateRequestTab(tabId: string, showRequestEditor = true, navigationIsCurrent: () => boolean = () => true): Promise<void> {
  const tab = requestTabs.tabs[tabId];
  if (!tab || tab.root !== workspace.root || !navigationIsCurrent()) return;
  requestTabs.activate(tabId);
  if (showRequestEditor) {
    view.value = "api";
    apiSubView.value = "debug";
  }
  const isCurrent = () => navigationIsCurrent() && requestTabs.activeId === tabId && requestTabs.isCurrent(tabId, tab.generation, tab.root);
  debug.requestTabState(tab);
  if (tab.source.kind === "free") {
    const session = await editor.loadFreeRequestTab(tab, isCurrent);
    if (!session || !isCurrent()) return;
    editor.activateFree(tabId);
    void ensureProjectAssets(tab.root, tab.project).catch((error) => { if (isCurrent()) reportError(error); });
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

async function loadApiIntoEditor(locator: ApiLocator, isCurrent: () => boolean = () => true, openRequestTab = true, onRequestActivated?: (tab: RequestTab) => void): Promise<void> {
  const root = workspace.root;
  const expected = { ...locator, folderIds: [...locator.folderIds] };
  if (!isCurrent()) return;
  if (openRequestTab) {
    const project = projectOfLocator(expected);
    requestContextRoot = root;
    requestProjectContext = project;
    const tabId = requestTabs.open({ kind: "asset", locator: expected });
    onRequestActivated?.(requestTabs.tabs[tabId]!);
    await activateRequestTab(tabId, false, isCurrent);
    return;
  }
  await editor.load(locator, isCurrent);
  if (!isCurrent() || workspace.root !== root || !editor.locator || JSON.stringify(editor.locator) !== JSON.stringify(expected)) return;
  const project = workspace.projectLocatorForApi(expected);
  if (!project) throw new Error("接口 locator 在当前本地树中不存在");
  await ensureProjectAssets(root, project);
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
  const baseUrl = online.activeBaseUrl;
  if (!online.loggedIn || !baseUrl) return;
  const normalized = normalizeOnlineBaseUrl(baseUrl);
  const workspaceIds = new Set<string>();
  const allowLegacy = online.profiles.length === 1;
  for (const row of readPersistedTabs(localStorage).tabs) {
    const ref = row.workspaceRef;
    if (ref.kind === "online" && (ref.baseUrl ? ref.baseUrl === normalized : allowLegacy)) workspaceIds.add(ref.workspaceId);
  }
  if (workspaceIds.size === 0) return;
  await online.refreshWorkspaces();
  for (const workspaceId of workspaceIds) {
    if (!online.loggedIn || online.activeBaseUrl !== baseUrl) return;
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
const workbenchBody = ref<HTMLElement>();
const workbenchWidth = ref(window.innerWidth);
const workbenchHeight = ref(window.innerHeight - 46);
const directoryOpen = ref(false);
const apiDirectory = computed(() => !isHome.value && (onlineMode.value || view.value === "api"));
const compactDirectory = computed(() => workbenchWidth.value < 1024);
const directoryOverlay = computed(() => apiDirectory.value && (workbenchWidth.value < 900
  || workbenchWidth.value - (compactDirectory.value ? 264 : 312) < 600));
const directoryVisible = computed(() => apiDirectory.value && (!directoryOverlay.value || directoryOpen.value));
const useDirectoryTools = computed(() => apiDirectory.value && !directoryOverlay.value && workbenchHeight.value >= 300);
const treeSearch = ref<{ focus(): void }>();
const projectToolsMenu = ref<InstanceType<typeof ActionMenu>>();
function setWorkbenchBody(component: Element | ComponentPublicInstance | null) {
  workbenchBody.value = component instanceof HTMLElement ? component : undefined;
}
let workbenchResize: ResizeObserver | undefined;
function updateWorkbenchSize() {
  workbenchWidth.value = workbenchBody.value?.clientWidth || window.innerWidth;
  workbenchHeight.value = workbenchBody.value?.clientHeight || window.innerHeight - 46;
}
onMounted(() => {
  updateWorkbenchSize();
  window.addEventListener("resize", updateWorkbenchSize);
  if (typeof ResizeObserver === "function" && workbenchBody.value) {
    workbenchResize = new ResizeObserver(updateWorkbenchSize);
    workbenchResize.observe(workbenchBody.value);
  }
});
onBeforeUnmount(() => {
  window.removeEventListener("resize", updateWorkbenchSize);
  workbenchResize?.disconnect();
});
function toggleDirectory() {
  directoryOpen.value = !directoryOpen.value;
  void nextTick(() => {
    if (directoryOpen.value) treeSearch.value?.focus();
    else document.querySelector<HTMLElement>('[data-testid="rail-directory"]')?.focus({ preventScroll: true });
  });
}
// —— 内容上下文由活跃签驱动（计划 C 任务 5）：活跃签是本地签 → 本地内容；活跃签是在线签
// （或无签但有活跃在线工作区——主页打开在线工作区尚未成签的过渡态）→ 在线内容。切到本地
// 签不退在线会话（驻留，不变量 4：工作区级关闭唯一入口=退出在线工作区按钮）。
function isLocalProjectTab(tab: ProjectTab | null): tab is Extract<ProjectTab, { projectLocator: ProjectLocator }> {
  return tab !== null && "projectLocator" in tab;
}

const activeLocalProjectTab = computed(() => isLocalProjectTab(tabs.activeTab) ? tabs.activeTab : null);
const retainedLocalProjectTab = computed(() => isLocalProjectTab(tabs.contextTab) ? tabs.contextTab : null);
const isHome = computed(() => tabs.selectedPage.kind === "home");
const activeOnlineProjectTab = computed(() => {
  const tab = tabs.activeTab;
  return tab && "projectId" in tab ? tab : null;
});
const onlineMode = computed(() => activeLocalProjectTab.value === null
  && (activeOnlineProjectTab.value !== null || online.activeWorkspace !== null));
watch(directoryOverlay, (overlay) => { if (!overlay) directoryOpen.value = false; });
watch(directoryVisible, (visible) => {
  const focused = document.activeElement;
  if (visible || !(focused instanceof HTMLElement)
      || !focused.closest('#workbench-directory, [data-menu-owner="directory-create"], [data-menu-owner="tree-more"]')) return;
  void nextTick(() => {
    if (document.activeElement !== focused && document.activeElement !== document.body) return;
    const target = document.querySelector<HTMLElement>('[data-testid="rail-directory"]')
      ?? document.querySelector<HTMLElement>('[data-testid="rail-api"]:not(:disabled)')
      ?? document.querySelector<HTMLElement>('[data-testid="project-tabs"] [aria-selected="true"]');
    target?.focus({ preventScroll: true });
  });
}, { flush: "sync" });
const onlineProjectContextAvailable = computed(() => {
  const workspace = online.activeWorkspace;
  const tab = activeOnlineProjectTab.value;
  return !!workspace && (!tab || (tab.workspaceRef.workspaceId === workspace.id
    && (!tab.workspaceRef.baseUrl || tab.workspaceRef.baseUrl === normalizeOnlineBaseUrl(online.activeBaseUrl))));
});
const activeOnlineWorkspaceTarget = computed<OnlineWorkspaceActionTarget | null>(() => {
  const { activeWorkspaceId: workspaceId, activeBaseUrl: baseUrl } = online;
  if (!online.loggedIn || onlineSessionErrorKey(online.error) === "online.sessionErrors.online-not-signed-in"
      || !workspaceId || !baseUrl || online.sessions[workspaceId]?.baseUrl !== baseUrl) return null;
  return { baseUrl, workspaceId };
});
const retainedOnlineWorkspaceTarget = computed<OnlineWorkspaceActionTarget | null>(() => {
  const workspaceId = online.activeWorkspaceId;
  const baseUrl = workspaceId ? online.sessions[workspaceId]?.baseUrl : undefined;
  return workspaceId && baseUrl ? { baseUrl, workspaceId } : null;
});

interface WorkspaceExitImpact {
  tabId: string;
  projectName: string;
  hasDrafts: boolean;
}
interface WorkspaceActionSelection {
  target: OnlineWorkspaceActionTarget;
  session: OnlineSession;
}
const exitWorkspace = ref<(WorkspaceActionSelection & { impact: WorkspaceExitImpact[] }) | null>(null);
const migrateWorkspace = ref<WorkspaceActionSelection | null>(null);
const workspaceActionError = ref<"online.workspaceActionChanged" | "online.workspaceExitImpactChanged" | null>(null);
const workspaceExitBusy = ref(false);
let workspaceActionOrigin: HTMLElement | null = null;

function isCurrentWorkspaceAction(selection: WorkspaceActionSelection, action: OnlineWorkspaceAction) {
  const active = action === "migrate" ? activeOnlineWorkspaceTarget.value : retainedOnlineWorkspaceTarget.value;
  const { baseUrl, workspaceId } = selection.target;
  return active?.baseUrl === baseUrl && active.workspaceId === workspaceId && online.sessions[workspaceId] === selection.session;
}

function affectedWorkspaceTabs(ref: OnlineWorkspaceRef): WorkspaceExitImpact[] {
  return tabs.tabs.filter((tab) => sameWorkspaceRef(tab.workspaceRef, ref))
    .map((tab) => ({ tabId: tab.tabId, projectName: tab.projectName, hasDrafts: tabs.projectHasDrafts(tab.tabId) }));
}

function requestOnlineWorkspaceAction(action: OnlineWorkspaceAction, target: OnlineWorkspaceActionTarget) {
  const session = online.sessions[target.workspaceId];
  if (!session || !isCurrentWorkspaceAction({ target, session }, action) || workspaceExitBusy.value || online.migrating) return;
  workspaceActionOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  workspaceActionError.value = null;
  if (action === "migrate") {
    migrateWorkspace.value = { target, session };
    online.migrateDialogOpen = true;
  } else {
    exitWorkspace.value = { target, session, impact: affectedWorkspaceTabs({ kind: "online", ...target, name: session.workspace.name }) };
  }
}

function restoreWorkspaceActionFocus() {
  const origin = workspaceActionOrigin;
  workspaceActionOrigin = null;
  void nextTick(() => {
    const focus = origin?.isConnected ? origin : document.querySelector<HTMLElement>('[data-testid="project-tabs"] [aria-selected="true"]');
    focus?.focus({ preventScroll: true });
  });
}

function cancelWorkspaceExit() {
  exitWorkspace.value = null;
  restoreWorkspaceActionFocus();
}

async function confirmWorkspaceExit() {
  const pending = exitWorkspace.value;
  if (!pending || workspaceExitBusy.value) return;
  if (workspaceActionError.value === "online.workspaceActionChanged" || !isCurrentWorkspaceAction(pending, "exit")) {
    cancelWorkspaceExit();
    return;
  }
  const ref = { kind: "online", ...pending.target, name: pending.session.workspace.name } as const;
  const impact = affectedWorkspaceTabs(ref);
  if (JSON.stringify(impact) !== JSON.stringify(pending.impact)) {
    pending.impact = impact;
    workspaceActionError.value = "online.workspaceExitImpactChanged";
    return;
  }
  workspaceExitBusy.value = true;
  exitWorkspace.value = null;
  try {
    await tabs.closeWorkspaceTabs(ref);
    if (online.sessions[ref.workspaceId] === pending.session) await online.closeWorkspace(ref.workspaceId);
  } catch (error) {
    reportError(error);
  } finally {
    workspaceExitBusy.value = false;
    restoreWorkspaceActionFocus();
  }
}

watch([retainedOnlineWorkspaceTarget, activeOnlineWorkspaceTarget], () => {
  if (exitWorkspace.value && !isCurrentWorkspaceAction(exitWorkspace.value, "exit")) workspaceActionError.value = "online.workspaceActionChanged";
  if (migrateWorkspace.value && !isCurrentWorkspaceAction(migrateWorkspace.value, "migrate")) online.migrateDialogOpen = false;
}, { flush: "sync" });
watch(() => online.migrateDialogOpen, (open) => {
  if (!open && migrateWorkspace.value) {
    migrateWorkspace.value = null;
    restoreWorkspaceActionFocus();
  }
});

function canMigrateWorkspace() {
  return !!migrateWorkspace.value && isCurrentWorkspaceAction(migrateWorkspace.value, "migrate");
}
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
  return tab && !isLocalProjectTab(tab) && onlineProjectContextAvailable.value ? tab.projectId : null;
});
watch(() => JSON.stringify([isHome.value, onlineMode.value, homeActiveOnlineProjectId.value, online.activeBaseUrl, online.user?.id]), async () => {
  const context = online.executionContext(homeActiveOnlineProjectId.value);
  online.execution.activate(context);
  online.execution.setVisible(!isHome.value && onlineMode.value && context !== null);
  if (online.execution.visible) {
    await online.execution.load();
    if (online.editorPath && online.editorKind === 'api' && !online.editorDirty) await online.selectNode('api', online.editorPath, { force: true });
  }
}, { immediate: true });
const onlinePublishProjects = computed(() => workspace.workspace?.groups.flatMap(group => group.projects.map(project => ({ label: `${group.name} / ${project.name}`, project }))) ?? []);

// 激活失败文案（离线标记等）上屏到既有错误通道（tabs store 契约：error 组件上屏）
watch(
  () => tabs.error,
  (message) => {
    if (message) reportError(new Error(message));
  },
  // 重试会在同一 tick 清空再写回同一个原因；同步观察保留这次新失败，
  // 使用户关闭提示后再次点击离线签仍能看到错误。
  { flush: "sync" },
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

watch(() => envs.envs, (environments) => {
  if (envs.root && envs.projectLocator) {
    editor.refreshProjectEnvironments(envs.root, envs.projectLocator,
      environments.map(({ id, name, locator }) => ({ id, name, locator })));
  }
});

// —— 最小错误反馈通道（宽审查 I1）——
// SideTree/TopBar/各面板链路的 Promise 拒绝统一转报到这里，集中展示、可手动关闭，
// 不再作为未处理的 rejection 被静默吞没。
// antd 4 落地：错误展示条为 a-alert type="error"；关闭钮（a-alert closeText slot）
// 保留 data-testid="app-error-close"，点击冒泡到 a-alert 关闭处理器 → @close →
// 走原 reportError 通道反向清空（errorMessage 置空后 v-if 卸载整条 alert）。
const errorMessage = ref("");
const presentedError = computed(() => {
  if (errorMessage.value === "design-invalid-json") return t("design.fixInvalidJson");
  if (errorMessage.value === "online-workspace-session-missing") return t("online.sessionErrors.online-workspace-session-missing");
  const onlineError = onlineSessionErrorKey(errorMessage.value);
  return onlineError ? t(onlineError) : errorMessage.value;
});

function reportError(e: unknown) {
  errorMessage.value = e instanceof Error ? e.message : String(e);
}

function dismissError() {
  errorMessage.value = "";
}

let suggestionEntry: { isCurrent: () => boolean; trigger: HTMLElement } | undefined;
const aiSettingsForSuggestion = ref(false);
let suggestionEntryGeneration = 0;
watch([view, apiSubView], () => { suggestionEntryGeneration += 1; }, { flush: "sync" });

function restoreSuggestionFocus() {
  const entry = suggestionEntry;
  suggestionEntry = undefined;
  if (!entry) return;
  void nextTick(() => {
    if (ai.drawerOpen || ai.configDialogOpen) return;
    const target = entry.isCurrent()
      ? entry.trigger.isConnected ? entry.trigger
        : document.querySelector<HTMLElement>('[data-testid="main-split"] [data-testid="ai-suggest-btn"]')
          ?? document.querySelector<HTMLElement>('[data-testid="request-more"]')
      : document.querySelector<HTMLElement>('[data-testid="project-tabs"] [aria-selected="true"]');
    target?.focus({ preventScroll: true });
  });
}

watch(() => ai.drawerOpen, (open) => { if (!open && !aiSettingsForSuggestion.value) restoreSuggestionFocus(); });
watch(() => ai.configDialogOpen, (open) => {
  if (open || !aiSettingsForSuggestion.value) return;
  aiSettingsForSuggestion.value = false;
  restoreSuggestionFocus();
});

function openSuggestionSettings() {
  if (!suggestionEntry?.isCurrent() || !ai.drawerOpen || ai.businessPurpose !== "case-suggestion" || ai.businessError !== "missing-model") return;
  aiSettingsForSuggestion.value = true;
  ai.dismissSuggestions();
  ai.configDialogOpen = true;
}

function invalidateSuggestionEntry() {
  if (suggestionEntry && !suggestionEntry.isCurrent() && ai.drawerOpen) ai.dismissSuggestions();
}
watch([view, apiSubView], invalidateSuggestionEntry, { flush: "post" });

async function onAiSuggest(trigger: HTMLElement) {
  const navigation = historyNavigationGeneration.value;
  const entryGeneration = suggestionEntryGeneration;
  const subView = apiSubView.value;
  const owner = editor.activeKey;
  if (!owner || workspace.readOnly || ai.suggestLoading) return;
  const isCurrent = () => historyNavigationGeneration.value === navigation && suggestionEntryGeneration === entryGeneration && editor.activeKey === owner
    && view.value === "api" && apiSubView.value === subView && !isHome.value && !onlineMode.value;
  suggestionEntry = { isCurrent, trigger };
  try {
    await ai.fetchSuggestions(undefined, undefined, isCurrent);
  } catch (e) {
    if (isCurrent()) reportError(e);
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
    await requestWorkflowNavigation(node.locator, workspace.root);
  }
}
let evidenceNavigation = 0;
async function locateWorkflowEvidence(identity: import('@apicc/core').EvidenceIdentity, project: ProjectLocator, root: string) {
  if (workspace.root !== root || !selectedProjectLocator.value || !sameProjectLocator(selectedProjectLocator.value, project)) { reportError(new Error('运行证据不属于当前工作区/项目')); return; }
  // A real case locator takes precedence over workflowId; use the existing dirty-aware case navigation.
  await locateExecutionEvidence({ ...identity, workflowId: undefined });
}
async function locateExecutionEvidence(identity: import("@apicc/core").EvidenceIdentity) {
  const project = selectedProjectLocator.value;
  if (!project || project.projectId !== identity.projectId) { reportError(new Error("历史证据不属于当前项目")); return; }
  if (identity.workflowId) { await requestWorkflowNavigation({ ...project, workflowId: identity.workflowId }, workspace.root); return; }
  if (!identity.locator) { reportError(new Error("旧记录未采集精确定位")); return; }
  const root = workspace.root;
  const token = ++evidenceNavigation;
  const navigation = historyNavigationGeneration.value;
  const locator: ApiLocator = { ...project, collectionId: identity.locator.collectionId, folderIds: [...identity.locator.folderIds], apiId: identity.locator.apiId };
  const nodeKey = localTreeNodeKey({ source: "local", kind: "api", locator });
  const node = findLocalNodeByKey(nodeKey);
  if (node?.kind !== "api") { reportError(new Error("当前资源已不存在，不能定位历史用例")); return; }
  let activated: { tabId: string; generation: number; navigation: number } | null = null;
  const isCurrent = () => token === evidenceNavigation && workspace.root === root
    && !!selectedProjectLocator.value && sameProjectLocator(selectedProjectLocator.value, project)
    && (!activated || (historyNavigationGeneration.value === activated.navigation
      && requestTabs.activeId === activated.tabId && requestTabs.isCurrent(activated.tabId, activated.generation, root)));
  try {
    if (moduleMemory.test.pane !== "api-cases" && !(await testing.leave())) return;
    if (!isCurrent() || historyNavigationGeneration.value !== navigation) return;
    // Existing request/editor sessions retain their live dirty buffer; never reload to reveal it.
    await loadApiIntoEditor(locator, isCurrent, true, tab => {
      // Capture after our own synchronous open/activation, before any loading await.
      activated = { tabId: tab.tabId, generation: tab.generation, navigation: historyNavigationGeneration.value };
    });
    if (!isCurrent() || !editor.locator || localTreeNodeKey({ source: "local", kind: "api", locator: editor.locator }) !== nodeKey) return;
    const selected = editor.api?.cases.find(item => item.id === identity.locator!.caseId && item.scope === identity.locator!.scope);
    if (!selected) { reportError(new Error("当前用例已变化或删除，不能定位到其它同名用例")); return; }
    const caseIdentity = { caseId: selected.id, scope: selected.scope };
    cases.selectedCase = caseIdentity;
    const requestTab = editor.activeKey ? debug.requestTabForSession(editor.activeKey) : null;
    if (requestTab) debug.requestTabState(requestTab).selectedCase = { ...caseIdentity };
    tree.select(node);
    moduleMemory.test.apiLocator = { ...locator, folderIds: [...locator.folderIds] };
    moduleMemory.apiTree.lastApiLocator = { ...locator, folderIds: [...locator.folderIds] };
    moduleMemory.test.pane = "api-cases"; moduleMemory.touch();
    testStressOpen.value = false;
    view.value = "test";
  } catch (error) { reportError(error); }
}

// —— 工作流切换按完整 locator 捕获，确认等待期间不重新读取活动选中目标 ——
const wfSwitchConfirmOpen = ref(false);
let pendingSwitchLocator: { root: string; locator: WorkflowLocator } | null = null;

async function requestWorkflowNavigation(locator: WorkflowLocator, root: string) {
  const captured = { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId, workflowId: locator.workflowId };
  if (workspace.root !== root) return;
  const current = workflowDesign.locator;
  // Locating the already-open workflow reveals its live buffer, never reloads a dirty draft.
  if (workflowDesign.root === root && current && current.workspaceId === captured.workspaceId && current.groupId === captured.groupId
    && current.projectId === captured.projectId && current.workflowId === captured.workflowId) { view.value = "wf"; return; }
  if (workflowDesign.dirty) { pendingSwitchLocator = { root, locator: captured }; wfSwitchConfirmOpen.value = true; return; }
  await openWorkflowInDesigner(captured, root);
}

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
  if (testing.dirty) return true;
  for (const session of Object.values(editor.sessions)) {
    if ((session.api !== null && JSON.stringify(session.api) !== session.snapshot) || design.hasControlDrafts(session)) return true;
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
const localProjectTools = computed(() => {
  const tab = activeLocalProjectTab.value;
  if (isHome.value || onlineMode.value || !tab || !workspace.opened || tab.workspaceRef.dir !== workspace.root) return null;
  const project = workspace.findProject(tab.projectLocator);
  return project ? { root: workspace.root, project, key: projectSessionKey(workspace.root, project.locator) } : null;
});
const localProjectToolsKey = computed(() => localProjectTools.value?.key ?? "");
const localTool = ref<"assets" | "mock" | null>(null);
const lastLocalTool = ref<"assets" | "mock">("assets");
const mockPanelMounted = ref(false);
const assetsPanelMounted = ref(false);
const localToolTitle = computed(() => lastLocalTool.value === "assets" ? t("contract.projectAssets") : t("mockPanel.title"));
const assetTarget = ref<ProjectAssetTarget | null>(null);
const sharedCredentialStatusRevision = ref(0);
const assetLoadError = ref("");
const assetReadyKey = ref("");
let assetRequest: { key: string; pending: Promise<void> } | undefined;
let localToolTrigger: HTMLElement | undefined;

function refreshSharedCredentialStatus(owner: string | undefined) {
  if (owner && owner === localProjectToolsKey.value) sharedCredentialStatusRevision.value += 1;
}

function ensureProjectAssets(root: string, project: ProjectLocator, refresh = false): Promise<void> {
  const key = projectSessionKey(root, project);
  if (root !== workspace.root || key !== localProjectToolsKey.value) return Promise.resolve();
  if (!refresh && assetReadyKey.value === key) return Promise.resolve();
  if (!refresh && assetRequest?.key === key) return assetRequest.pending;
  const pending = assets.load(project).then(() => {
    if (assetRequest?.pending === pending && localProjectToolsKey.value === key) assetReadyKey.value = key;
  }).finally(() => {
    if (assetRequest?.pending === pending) assetRequest = undefined;
  });
  assetRequest = { key, pending };
  return pending;
}

async function refreshLocalProject() {
  const scope = localProjectTools.value;
  await workspace.refresh();
  if (!scope || localProjectToolsKey.value !== scope.key || (!assetReadyKey.value && !assetRequest)) return;
  await ensureProjectAssets(scope.root, scope.project.locator, true);
}

function projectToolFocus() {
  return document.querySelector<HTMLElement>('[data-testid="project-tools"]');
}

function closeLocalTool(restoreToProject = false) {
  if (!localTool.value) return;
  if (localTool.value === "assets" && !restoreToProject) refreshSharedCredentialStatus(localProjectToolsKey.value);
  const trigger = localToolTrigger;
  localToolTrigger = undefined;
  localTool.value = null;
  void nextTick(() => {
    if (localTool.value) return;
    const selected = document.querySelector<HTMLElement>('[data-testid="project-tabs"] [aria-selected="true"]');
    if (restoreToProject) {
      if (document.activeElement === document.body) selected?.focus({ preventScroll: true });
      return;
    }
    const visibleTrigger = trigger?.isConnected && !trigger.closest('[style*="display: none"]');
    (visibleTrigger ? trigger : projectToolFocus() ?? selected)?.focus({ preventScroll: true });
  });
}

async function openLocalTool(tool: "assets" | "mock", target: ProjectAssetTarget | null = null, trigger?: HTMLElement) {
  const scope = localProjectTools.value;
  if (!scope) return;
  if (syncOpen.value) {
    syncOpen.value = false;
    synchronization.setVisible(false);
  }
  localToolTrigger = trigger;
  assetTarget.value = target;
  assetLoadError.value = "";
  lastLocalTool.value = tool;
  localTool.value = tool;
  if (tool === "mock") mockPanelMounted.value = true;
  if (tool === "assets") {
    assetsPanelMounted.value = true;
    try { await ensureProjectAssets(scope.root, scope.project.locator); }
    catch (error) {
      if (localProjectToolsKey.value === scope.key && localTool.value === "assets") {
        assetLoadError.value = error instanceof Error ? error.message : String(error);
      }
    }
  }
}

function locateProjectAsset(target: ProjectAssetTarget, trigger: HTMLElement) {
  const scope = localProjectTools.value;
  const tab = activeRequestTab.value;
  const owner = tab?.project ?? editor.locator;
  if (!scope || !owner || (tab && tab.root !== scope.root)
    || !sameProjectLocator(owner, scope.project.locator)) return;
  void openLocalTool("assets", target, trigger);
}

function rememberMockDraft(value: { text: string; revision: string; port: number } | null, key: string) {
  if (!mockPanelMounted.value || localProjectToolsKey.value !== key) return;
  if (value) mockDrafts.set(key, value);
  else mockDrafts.delete(key);
}

function viewProjectModel(id: string, trigger: HTMLElement) {
  locateProjectAsset({ kind: "model", id }, trigger);
}

watch(localProjectToolsKey, () => {
  closeLocalTool(true);
  mockPanelMounted.value = false;
  assetsPanelMounted.value = false;
  assetTarget.value = null;
  assetRequest = undefined;
  assetReadyKey.value = "";
  assets.deactivate();
}, { flush: "sync" });
watch(localProjectToolsKey, () => {
  const scope = localProjectTools.value;
  const owner = activeRequestTab.value?.project ?? editor.locator;
  if (!scope || !owner || !sameProjectLocator(scope.project.locator, owner)) return;
  void ensureProjectAssets(scope.root, scope.project.locator).catch((error) => {
    if (localProjectToolsKey.value === scope.key) reportError(error);
  });
});

const syncOpen = ref(false);
const syncScope = computed<SyncScope | null>(() => {
  if (isHome.value) return null;
  if (onlineMode.value) return online.execution.context ? { kind: 'online', context: online.execution.context } : null;
  const project = selectedProjectContext.value; return project?.root ? { kind: 'local', root: project.root, locator: project.locator } : null;
});
const synchronization = createSynchronizationStore(apicc, async () => {
  if (syncScope.value?.kind === 'online') { await online.execution.load(); if (online.execution.error) throw Error(online.execution.error); }
  else await refreshLocalProject();
});
const syncModules = computed(() => syncScope.value?.kind === 'online' ? (online.execution.project?.collections ?? []).map(collection => ({ id: collection.id, name: collection.name })) : syncScope.value?.kind === 'local' ? (workspace.findProject(syncScope.value.locator)?.children ?? []).flatMap(node => node.kind === 'collection' ? [{ id: node.locator.collectionId, name: node.label }] : []) : []);
const syncScopeKey = computed(() => JSON.stringify(syncScope.value));
const projectOnlineTarget = computed(() => {
  const tab = activeOnlineProjectTab.value;
  const target = retainedOnlineWorkspaceTarget.value;
  if (!tab || !target || tab.workspaceRef.workspaceId !== target.workspaceId
      || normalizeOnlineBaseUrl(tab.workspaceRef.baseUrl) !== normalizeOnlineBaseUrl(target.baseUrl)) return null;
  return target;
});
const projectToolsKey = computed(() => JSON.stringify([tabs.activeTabId, syncScopeKey.value, projectOnlineTarget.value, localProjectToolsKey.value]));
const projectToolItems = computed(() => [
  ...(localProjectTools.value ? [
    { key: "assets", label: t("contract.projectAssets"), testId: "project-assets-entry" },
    { key: "mock", label: t("mockPanel.title"), testId: "project-mock-entry" },
  ] : []),
  ...(syncScope.value ? [{ key: "sync", label: t("sync.title"), testId: "sync-entry" }] : []),
  ...(projectOnlineTarget.value ? [
    ...(online.profiles.some((profile) => profile.baseUrl === projectOnlineTarget.value?.baseUrl) ? [
      { key: "account", label: t("home.connectionAccount"), testId: "project-connection-account" },
    ] : []),
    ...(activeOnlineWorkspaceTarget.value?.baseUrl === projectOnlineTarget.value.baseUrl
      && activeOnlineWorkspaceTarget.value?.workspaceId === projectOnlineTarget.value.workspaceId ? [
      { key: "migrate", label: t("online.migrate"), disabled: online.migrating, testId: "project-online-migrate" },
    ] : []),
    { key: "exit", label: t("online.exitOnline"), disabled: online.migrating, testId: "project-online-exit" },
  ] : []),
]);
function openSyncPanel() {
  if (!syncScope.value) return;
  closeLocalTool(true);
  syncOpen.value = true;
  void nextTick(() => document.querySelector<HTMLElement>('[data-testid="sync-panel"]')?.focus({ preventScroll: true }));
}
const openedProjectToolsKey = ref<string | null>(null);
function selectProjectTool(action: string) {
  if (openedProjectToolsKey.value !== projectToolsKey.value || !projectToolItems.value.some((item) => item.key === action)) return;
  if (action === "assets" || action === "mock") {
    void openLocalTool(action, null, projectToolFocus() ?? undefined);
    return;
  }
  if (action === "sync") openSyncPanel();
  const target = projectOnlineTarget.value;
  if (!target) return;
  if (action === "account") online.openConnectionAccount(target.baseUrl);
  if (action === "migrate" || action === "exit") requestOnlineWorkspaceAction(action, target);
}
function closeSyncPanel(restoreToProject = false) {
  if (!syncOpen.value) return;
  syncOpen.value = false;
  synchronization.setVisible(false);
  void nextTick(() => {
    const trigger = restoreToProject ? null : projectToolFocus();
    const selected = document.querySelector<HTMLElement>('[data-testid="project-tabs"] [aria-selected="true"]');
    (trigger ?? selected)?.focus({ preventScroll: true });
  });
}
watch(syncScopeKey, () => {
  closeSyncPanel(true);
  synchronization.activate(syncScope.value);
}, { immediate: true, flush: "sync" });
watch(projectToolsKey, () => {
  const restoreFocus = projectToolsMenu.value?.hasFocus();
  projectToolsMenu.value?.close(false);
  directoryOpen.value = false;
  if (restoreFocus) void nextTick(() => document.querySelector<HTMLElement>('[data-testid="project-tabs"] [aria-selected="true"]')?.focus());
});
watch(useDirectoryTools, () => {
  const restoreFocus = projectToolsMenu.value?.hasFocus();
  projectToolsMenu.value?.close(false);
  if (restoreFocus) void nextTick(() => projectToolFocus()?.focus());
});
watch(() => online.execution.view?.assets.version, version => { synchronization.assetVersion = version ?? '0'; }, { immediate: true });
onBeforeUnmount(() => { synchronization.setVisible(false); synchronization.activate(null); });

watch([() => online.activeBaseUrl, () => online.user, () => online.loggedIn, () => isHome.value, () => workspace.root, () => JSON.stringify(selectedProjectLocator.value), () => JSON.stringify(online.execution.context)], () => {
  pendingCollaborationSource.value = null;
  if (collaboration.visible) void collaboration.close().catch(reportError);
}, { flush: 'sync' });
const activeProjectLocator = computed(() => selectedProjectLocator.value ? { ...selectedProjectLocator.value } : null);
watch(() => JSON.stringify([isHome.value, onlineMode.value, selectedProjectContext.value]), () => {
  const context = selectedProjectContext.value;
  if (isHome.value) return;
  void testing.activate(context?.root ?? '', !onlineMode.value ? context?.locator ?? null : null, workspace.readOnly).catch(reportError);
});
async function onTestPane(pane: TestingPane) {
  if (pane !== moduleMemory.test.pane && !(await testing.leave())) return;
  moduleMemory.test.pane = pane; moduleMemory.touch();
  if ((pane === 'datasets' || pane === 'suites') && testing.current && !testing.dirty) await testing.refresh().catch(reportError);
}
const activeRequestTab = computed(() => {
  const tab = requestTabs.activeTab;
  const context = selectedProjectContext.value;
  return tab && context && tab.root === context.root && sameProjectLocator(tab.project, context.locator) ? tab : null;
});
const requestPath = computed(() => {
  const tab = activeRequestTab.value;
  const locator = tab?.source.kind === "asset" ? tab.source.locator : !tab ? editor.locator : null;
  if (!locator) return "";
  const project = workspace.findProject(locator);
  if (!project) return "";
  const module = project.children.find((node) => node.kind === "collection" && node.locator.collectionId === locator.collectionId);
  const path = [project.label];
  if (module) path.push(module.label);
  let parent: LocalTreeNodeDTO | undefined = module;
  for (const folderId of locator.folderIds) {
    parent = parent?.children?.find((node) => node.kind === "folder" && node.id === folderId);
    if (parent) path.push(parent.label);
  }
  return path.join(" / ");
});
const showDebugEnvironment = computed(() => !isHome.value && !onlineMode.value && view.value === "api" && apiSubView.value === "debug");
const environmentSelection = computed(() => {
  if (!showDebugEnvironment.value || !selectedProjectContext.value || selectedProjectContext.value.root !== workspace.root) return null;
  const locator = editor.locator;
  if (!activeRequestTab.value && (!locator || !sameProjectLocator(locator, selectedProjectContext.value.locator))) return null;
  return debugEnvironmentSelection(editor, debug, activeRequestTab.value);
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
watch(historyNavigationGeneration, invalidateSuggestionEntry, { flush: "post" });

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
): Promise<{ tabId: string; generation: number } | undefined> {
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
  return { tabId: tab.tabId, generation: converted.generation };
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
  if (online.error) reportError(new Error(online.error));
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
watch(() => JSON.stringify([workspace.root, isHome.value, onlineMode.value, selectedProjectLocator.value]), () => {
  stress.clear(); testStressOpen.value = false;
});

async function onTestStress(caseId: string) {
  if (!editor.locator || !selectedProjectLocator.value) return;
  stress.form.caseId = caseId;
  stress.form.envName = debug.selectedEnvName; // 与调试共享项目环境选中态
  try {
    await stress.openWorkbench(selectedProjectLocator.value, { kind: 'case', collectionId: editor.locator.collectionId, apiId: editor.locator.apiId, caseId });
    if (stress.plan && debug.selectedEnvName) stress.plan.environmentId = editor.envs.find(env => env.name === debug.selectedEnvName)?.id;
    testStressOpen.value = !!stress.planOwner;
  } catch (e) { reportError(e); }
}
async function onTestWorkflowStress(locator: WorkflowLocator) {
  const scope = selectedProjectLocator.value;
  if (!scope || !sameProjectLocator(scope, locator)) return;
  try {
    await stress.openWorkbench(scope, { kind: 'workflow', workflowId: locator.workflowId });
    if (!stress.planOwner || !sameProjectLocator(scope, selectedProjectLocator.value ?? locator)) return;
    view.value = 'test'; testStressOpen.value = true;
  } catch (e) { reportError(e); }
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
const stressEnvs = computed(() => selectedProjectLocator.value ? workspace.findProject(selectedProjectLocator.value)?.envs ?? [] : []);

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

const directoryImportTarget = computed(() => {
  const scope = localProjectTools.value;
  if (!scope || workspace.readOnly || !directoryVisible.value) return null;
  const selected = selectedCollectionLocator.value;
  const collection = selected && sameProjectLocator(selected, scope.project.locator)
    ? scope.project.children.find((node) => node.kind === "collection" && node.locator.collectionId === selected.collectionId)
    : undefined;
  return {
    key: JSON.stringify([scope.key, collection?.id ?? null]),
    scopeKey: scope.key,
    project: { ...scope.project.locator },
    projectName: scope.project.label,
    collection: collection?.kind === "collection" ? { ...collection.locator } : null,
    collectionName: collection?.label,
  };
});
const moduleImportTarget = ref<NonNullable<typeof directoryImportTarget.value> | null>(null);
const moduleImportTargetCurrent = computed(() => {
  const target = moduleImportTarget.value;
  const scope = localProjectTools.value;
  return !!target && !!scope && target.scopeKey === scope.key && !workspace.readOnly
    && (!target.collection || scope.project.children.some((node) =>
      node.kind === "collection" && node.locator.collectionId === target.collection?.collectionId));
});

function openDirectoryImport(targetKey: string) {
  const target = directoryImportTarget.value;
  if (!target || target.key !== targetKey) return;
  moduleImportW.reset();
  moduleImportTarget.value = target;
}

function closeDirectoryImport(restoreFocus = true) {
  if (!moduleImportTarget.value) return;
  moduleImportW.reset();
  moduleImportTarget.value = null;
  if (restoreFocus) void nextTick(() => {
    if (moduleImportTarget.value) return;
    document.querySelector<HTMLElement>('[data-testid="directory-create"], [data-testid="rail-directory"]')?.focus({ preventScroll: true });
  });
}
watch(moduleImportTargetCurrent, (current) => {
  if (!current) closeDirectoryImport(false);
}, { flush: "sync" });

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

const viewerPreference = ref<number | null>(null);
const debugSplit = ref<HTMLElement>();
const debugHeight = ref(0);
const debugWidth = ref(window.innerWidth);
const shortDebug = computed(() => debugHeight.value > 0 && debugHeight.value < 400);
const splitHeight = computed(() => Math.max(0, debugHeight.value - 10));
const defaultResponsePercent = computed(() => debugHeight.value > 0 && debugHeight.value < 550 ? 50 : 54);
const minResponsePercent = computed(() => splitHeight.value ? Math.max(20, 192 / splitHeight.value * 100) : 20);
const maxResponsePercent = computed(() => splitHeight.value ? Math.min(70, 100 - 184 / splitHeight.value * 100) : 70);
const clampResponsePercent = (value: number) => Math.min(maxResponsePercent.value, Math.max(minResponsePercent.value, value));
const viewerPct = computed(() => clampResponsePercent(viewerPreference.value ?? defaultResponsePercent.value));
const responseHeight = computed(() => splitHeight.value ? `${splitHeight.value * viewerPct.value / 100}px` : `${viewerPct.value}%`);
const compactApiTools = computed(() => debugWidth.value < 680);
const apiHead = ref<HTMLElement>();
const requestSection = ref<HTMLElement>();
const responseSection = ref<HTMLElement>();
const responseToggle = ref<HTMLButtonElement>();
const legacyResponseExpanded = ref(false);
const responseState = computed(() => activeRequestTab.value ? debug.requestTabState(activeRequestTab.value) : null);
const responseExpanded = computed({
  get: () => responseState.value?.responseExpanded ?? legacyResponseExpanded.value,
  set: (value: boolean) => {
    if (responseState.value) responseState.value.responseExpanded = value;
    else legacyResponseExpanded.value = value;
  },
});
const splitDrag = ref<{ id: number; y: number; percent: number; divider: HTMLElement }>();
let responseNavigation = 0;
watch([view, apiSubView, historyNavigationGeneration], () => { responseNavigation += 1; }, { flush: "sync" });
watch(() => editor.activeKey, () => { if (!activeRequestTab.value) legacyResponseExpanded.value = false; });

function captureResponseExpansion() {
  const navigation = responseNavigation;
  const state = responseState.value;
  const owner = editor.activeKey;
  return () => {
    if (responseNavigation === navigation && view.value === "api" && apiSubView.value === "debug" && !isHome.value
      && responseState.value === state && (state !== null || owner === editor.activeKey)) responseExpanded.value = true;
  };
}

function openDebugHistory(trigger?: HTMLElement) {
  historyTrigger = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  historyOpen.value = true;
}

function closeDebugHistory() {
  historyOpen.value = false;
}

function restoreHistoryFocus() {
  const trigger = historyTrigger;
  if (historyOpen.value) return;
  historyTrigger = undefined;
  if (trigger?.isConnected && !trigger.closest('[style*="display: none"]')) trigger.focus({ preventScroll: true });
  else (document.querySelector<HTMLElement>('[data-testid="debug-history-open"]')
    ?? document.querySelector<HTMLElement>('[data-testid="project-tabs"] [aria-selected="true"]'))?.focus({ preventScroll: true });
}

function toggleResponse() {
  responseExpanded.value = !responseExpanded.value;
  if (!responseExpanded.value && shortDebug.value) void nextTick(() => responseToggle.value?.focus({ preventScroll: true }));
}
function measureDebugLayout() {
  const split = debugSplit.value;
  const padding = split ? Number.parseFloat(getComputedStyle(split).paddingBottom) || 0 : 0;
  debugHeight.value = Math.max(0, (split?.clientHeight ?? 0) - padding);
  debugWidth.value = apiHead.value?.clientWidth || window.innerWidth;
}
let debugResize: ResizeObserver | undefined;
watch([debugSplit, apiHead], ([split, head]) => {
  debugResize?.disconnect();
  measureDebugLayout();
  if (typeof ResizeObserver !== "function") return;
  debugResize = new ResizeObserver(measureDebugLayout);
  if (split) debugResize.observe(split);
  if (head) debugResize.observe(head);
}, { flush: "post" });
onMounted(() => {
  window.addEventListener("resize", measureDebugLayout);
  window.addEventListener("blur", endSplitDrag);
});
onBeforeUnmount(() => {
  debugResize?.disconnect();
  window.removeEventListener("resize", measureDebugLayout);
  window.removeEventListener("blur", endSplitDrag);
  endSplitDrag();
});
watch([debugSplit, shortDebug, responseExpanded, () => activeRequestTab.value?.tabId], endSplitDrag);

function onDividerDown(event: PointerEvent) {
  if (event.button !== 0 || shortDebug.value || !splitHeight.value) return;
  const divider = event.currentTarget as HTMLElement;
  splitDrag.value = { id: event.pointerId, y: event.clientY, percent: viewerPct.value, divider };
  divider.setPointerCapture?.(event.pointerId);
}
function onDividerMove(event: PointerEvent) {
  const drag = splitDrag.value;
  if (drag?.id !== event.pointerId || !splitHeight.value) return;
  viewerPreference.value = clampResponsePercent(drag.percent + (drag.y - event.clientY) / splitHeight.value * 100);
}
function endSplitDrag() {
  const drag = splitDrag.value;
  splitDrag.value = undefined;
  if (drag?.divider.hasPointerCapture?.(drag.id)) drag.divider.releasePointerCapture(drag.id);
}
function onDividerKey(event: KeyboardEvent) {
  const values: Record<string, number> = { ArrowUp: viewerPct.value + 5, ArrowDown: viewerPct.value - 5,
    Home: minResponsePercent.value, End: maxResponsePercent.value, Enter: defaultResponsePercent.value };
  if (!(event.key in values)) return;
  event.preventDefault();
  viewerPreference.value = event.key === "Enter" ? null : clampResponsePercent(values[event.key]!);
}
function focusDebugSection(section: HTMLElement | undefined) {
  section?.scrollIntoView?.({ block: "start" });
  section?.focus({ preventScroll: true });
}
</script>

<template>
  <ConfigProvider :locale="antdLocale" :theme="antdThemeConfig">
    <a-layout class="app" data-testid="app-root">
      <TopBar :workspace="workspace" :api="apicc" :online="online" :plugins="plugins" :tabs="tabs" :ai="ai" :report-error="reportError" />
      <a-alert v-if="errorMessage" class="app-error" type="error" show-icon data-testid="app-error" @close="dismissError">
        <template #message>{{ t("app.error") }}: {{ presentedError }}</template>
        <template #closeText><span data-testid="app-error-close">{{ t("common.close") }}</span></template>
      </a-alert>
      <div v-if="syncOpen && syncScope" class="sync-workbench" @keydown.esc.stop="closeSyncPanel()">
        <SyncPanel :store="synchronization" :modules="syncModules" :api="apicc" :contract-project-id="syncScope.kind === 'online' ? online.execution.project?.id : syncScope.locator.projectId" :read-only="syncScope.kind === 'local' && workspace.readOnly" @close="closeSyncPanel()" />
      </div>
      <a-modal v-if="(localTool || mockPanelMounted || assetsPanelMounted) && localProjectTools" :open="!!localTool" :footer="null" :mask-closable="false"
        :focus-trigger-after-close="false" :width="920" class="local-project-tool" @cancel="closeLocalTool()">
        <template #title><span data-testid="project-tool-title">{{ localToolTitle }} · {{ localProjectTools.project.label }}</span></template>
        <div class="project-tool-content" data-testid="local-project-tool">
          <div v-if="assetsPanelMounted" v-show="lastLocalTool === 'assets'">
            <ProjectAssetsPanel v-if="assetReadyKey === localProjectToolsKey" :key="localProjectToolsKey" direct :target="assetTarget"
              :assets="assets" :api="apicc" :read-only="workspace.readOnly" :credential-context-key="localProjectToolsKey"
              @credential-changed="refreshSharedCredentialStatus" />
            <div v-else-if="assetLoadError" role="alert">
              <p>{{ assetLoadError }}</p>
              <a-button @click="openLocalTool('assets', assetTarget, localToolTrigger)">{{ t('projectTools.retry') }}</a-button>
            </div>
            <p v-else role="status">{{ t("projectTools.loadingAssets") }}</p>
          </div>
          <MockPanel v-if="mockPanelMounted" v-show="lastLocalTool === 'mock'" embedded :active="localTool === 'mock'"
            :key="localProjectToolsKey" :api="apicc" :root="localProjectTools.root"
            :locator="localProjectTools.project.locator" :read-only="workspace.readOnly" :draft-memory="mockDrafts.get(localProjectToolsKey)"
            @draft="rememberMockDraft"
            @new-free-request="openFreeRequestTab(); closeLocalTool()" />
        </div>
      </a-modal>
      <div :ref="setWorkbenchBody" class="body">
        <!-- 图标导航栏（M11 五项）：v-model:view + 门控上下文；主页不显示；
             在线模式全禁用 -->
        <ModuleRail
          v-if="!isHome"
          :view="view"
          :gate="railGate"
          :environment="environmentSelection"
          :environment-loading="showDebugEnvironment && !!activeRequestTab && !environmentSelection"
          :directory-overlay="directoryOverlay"
          :directory-open="directoryOpen"
          @update:view="(v: SwitchView) => (view = v)"
          @toggle-directory="toggleDirectory"
        >
          <template v-if="projectToolItems.length && !useDirectoryTools" #tools>
            <ActionMenu ref="projectToolsMenu" class="rail-project-tools" test-id="project-tools"
              :label="t('workbench.projectTools')" :items="projectToolItems"
              @opened="openedProjectToolsKey = projectToolsKey" @select="selectProjectTool">
              <EllipsisOutlined />
            </ActionMenu>
          </template>
        </ModuleRail>
        <!-- API 栏（M11 按模块专用）：接口=树；测试=用例/场景导航；运行/工作流/环境与主页隐藏。
             在线模式侧栏必须可见（回归修复：M11 的 !online.activeWorkspace 条件把在线树整个藏死，
             导致在线工作区无任何项目入口——在线时 treeRoot 已切在线树，侧栏跟随显示） -->
        <div
          v-show="directoryVisible"
          id="workbench-directory"
          class="sider-col-wrap"
          :class="{ 'directory-overlay': directoryOverlay }"
          data-testid="sidebar-api"
          @keydown.esc.stop="directoryOverlay && directoryOpen && toggleDirectory()"
        >
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
            show-create-in-header
            :import-target-key="directoryImportTarget?.key"
            :compact="compactDirectory"
            :hidden="!directoryVisible"
            :active-project-locator="activeProjectLocator"
            :tree-root="onlineMode ? (onlineProjectContextAvailable ? online.onlineTree : null) : undefined"
            :readonly="onlineMode"
            :empty-text="onlineMode ? t('online.treeEmpty') : undefined"
            @select="onSelect"
            @import-interfaces="openDirectoryImport"
          >
            <template #search>
              <a-input ref="treeSearch" v-model:value="treeFilter" size="small" allow-clear data-testid="tree-search"
                :aria-label="t('tree.search')" :placeholder="t('tree.search')" />
            </template>
          </SideTree>
          <div v-if="projectToolItems.length && useDirectoryTools" class="directory-project-tools">
            <ActionMenu ref="projectToolsMenu" test-id="project-tools" :label="t('workbench.projectTools')" :items="projectToolItems"
              @opened="openedProjectToolsKey = projectToolsKey" @select="selectProjectTool">
              <EllipsisOutlined /> {{ t("workbench.projectTools") }}
            </ActionMenu>
          </div>
        </div>
        <!-- 测试模块侧栏（M11）：与接口树各自独立记忆 -->
        <div v-show="!isHome && view === 'test' && !onlineMode" class="sider-col-wrap" data-testid="sidebar-test">
          <TestSidebar
            :workspace="workspace"
            :active-project-locator="selectedProjectLocator"
            :active-api-locator="editor.locator"
            :pane="moduleMemory.test.pane"
            :scenarios="testScenarios"
            :testing="testing"
            :report-error="reportError"
            @update:pane="onTestPane"
            @pick-api="onTestPickApi"
            @open-workflow="openWorkflowInDesigner"
            @stress-workflow="onTestWorkflowStress"
          />
        </div>
        <div class="right-col-wrap">
          <RequestTabs
            v-show="!isHome && !onlineMode && view === 'api' && selectedProjectContext"
            :tabs="requestTabs"
            :editor="editor"
            :root="workspace.root"
            :project="selectedProjectLocator"
            :has-drafts="requestHasDrafts"
            @new-free="openFreeRequestTab"
            @activate="(tabId) => { void activateRequestTab(tabId).catch(reportError); }"
          />
        <div class="right-col" data-testid="main-split">
          <!-- 主页（M9-C；轨三左右栏）：落点选择/项目卡片/连接管理，恒可用 -->
          <HomeView
            v-if="isHome"
            ref="homeView"
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
            :active-online-workspace-target="activeOnlineWorkspaceTarget"
            :retained-online-workspace-target="retainedOnlineWorkspaceTarget"
            @online-workspace-action="requestOnlineWorkspaceAction"
          />
          <!-- 在线工作区上下文（任务 5：活跃签在线或无签但有活跃在线工作区）：只提供浏览/编辑面板 -->
          <OnlineProjectAssets v-else-if="onlineMode && onlineProjectContextAvailable && online.execution.context" class="panel-view" :ai="ai" :online="online" :adapter="onlineProjectAdapter" :local-projects="onlinePublishProjects" @collaboration="context => collaboration.activate(context).catch(reportError)" @collaboration-result="value => shareOnlineLocal(value).catch(reportError)" @published="openOnlineProjectFromHome"><OnlineApiEditor :online="online" /></OnlineProjectAssets>
          <OnlineApiEditor v-else-if="onlineMode && onlineProjectContextAvailable" class="panel-view" :online="online" />
          <div v-else-if="onlineMode" class="panel-view online-context-unavailable">
            <p>{{ t("online.sessionErrors.online-workspace-session-missing") }}</p>
            <a-button @click="tabs.activateHome()">{{ t("nav.home") }}</a-button>
          </div>
          <!-- 接口模块（M8）：头部（子视图页签 + AI 入口）+ 调试/设计/用例子视图 -->
          <template v-else-if="view === 'api'">
            <div ref="apiHead" class="api-head" data-testid="api-head">
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
              <a-button v-if="apiSubView === 'design'" size="small" data-testid="debug-history-open"
                @click="openDebugHistory($event.currentTarget as HTMLElement)">{{ t("debugLoop.historyTitle") }}</a-button>
            </div>
            <a-modal v-if="moduleImportTarget && moduleImportTargetCurrent" :open="true" :footer="null"
              :title="t('projectTools.importInterfaces')" :mask-closable="false" :focus-trigger-after-close="false"
              :width="860" @cancel="closeDirectoryImport()">
              <ImportWizard mode="module" :target-project-locator="moduleImportTarget.project"
                :target-project-name="moduleImportTarget.projectName" :target-collection-locator="moduleImportTarget.collection"
                :target-collection-name="moduleImportTarget.collectionName" :import-w="moduleImportW"
                :plugins="plugins" :report-error="reportError" @close="closeDirectoryImport()" />
            </a-modal>
            <div v-if="apiSubView === 'debug'" ref="debugSplit" class="debug-split" data-testid="debug-split"
              :class="{ 'short-debug': shortDebug && responseExpanded, 'response-collapsed': !responseExpanded }">
              <div ref="requestSection" class="editor-pane" data-testid="editor-pane" tabindex="-1">
                <button v-if="shortDebug && responseExpanded" type="button" class="debug-jump" @click="focusDebugSection(responseSection)">{{ t("responseWorkbench.goToResponse") }}</button>
                <RequestEditor
                  :editor="editor"
                  :debug="debug"
                  :api="apicc"
                  :assets="activeRequestTab?.source.kind === 'asset' ? assets : undefined"
                  :models="assets.models"
                  :project-locator="activeRequestTab?.project ?? null"
                  :request-tab="activeRequestTab"
                  :environment-selection="environmentSelection"
                  :environment-loading="!!activeRequestTab && !environmentSelection"
                  :request-path="requestPath"
                  :view-model="localProjectTools ? viewProjectModel : undefined"
                  :view-project-asset="localProjectTools ? locateProjectAsset : undefined"
                  :shared-credential-status-revision="sharedCredentialStatusRevision"
                  :suggest-cases="onAiSuggest"
                  :suggesting-cases="ai.suggestLoading"
                  :compact-suggest="compactApiTools"
                  :capture-response-expansion="captureResponseExpansion"
                  project-tools
                  :has-drafts="activeRequestTab ? requestHasDrafts(activeRequestTab.tabId) : editor.dirty"
                  :project-node="activeRequestTab ? workspace.findProject(activeRequestTab.project) : null"
                  :create-free-module="createFreeRequestModule"
                  :save-free-request="saveFreeRequestAsApi"
                  @new-free-request="openFreeRequestTab"
                  @collaboration-history="openDebugHistory"
                />
              </div>
              <div
                v-if="!shortDebug && responseExpanded"
                class="split-divider"
                data-testid="split-divider"
                role="separator"
                aria-orientation="horizontal"
                :aria-label="t('responseWorkbench.splitter')"
                :aria-valuemin="Math.round(minResponsePercent)"
                :aria-valuemax="Math.round(maxResponsePercent)"
                :aria-valuenow="Math.round(viewerPct)"
                :aria-valuetext="t('responseWorkbench.responsePercent', { percent: Math.round(viewerPct) })"
                tabindex="0"
                @pointerdown="onDividerDown"
                @pointermove="onDividerMove"
                @pointerup="endSplitDrag"
                @pointercancel="endSplitDrag"
                @lostpointercapture="endSplitDrag"
                @keydown="onDividerKey"
                @dblclick="viewerPreference = null"
              ></div>
              <div ref="responseSection" class="viewer-pane" data-testid="viewer-pane" tabindex="-1"
                :style="responseExpanded && !shortDebug ? { height: responseHeight } : undefined">
                <button v-if="shortDebug && responseExpanded" type="button" class="debug-jump" @click="focusDebugSection(requestSection)">{{ t("responseWorkbench.backToRequest") }}</button>
                <ResponseViewer
                  :result="responseState ? responseState.result : debug.result"
                  :sending="responseState ? responseState.sending : debug.sending"
                  :error="responseState ? responseState.error : debug.error"
                  :tab-state="responseState"
                  :expanded="responseExpanded"
                  :api="apicc"
                >
                  <template #actions>
                    <button type="button" class="response-header-action" data-testid="debug-history-open"
                      :aria-label="t('debugLoop.historyTitle')" :title="t('debugLoop.historyTitle')"
                      @click="openDebugHistory($event.currentTarget as HTMLElement)">{{ t(compactApiTools ? "responseWorkbench.history" : "debugLoop.historyTitle") }}</button>
                    <button ref="responseToggle" type="button" class="response-header-action response-toggle" data-testid="response-expand-toggle"
                      :aria-label="t(responseExpanded ? 'responseWorkbench.collapseResponse' : 'responseWorkbench.expandResponse')"
                      :aria-expanded="responseExpanded" @click="toggleResponse">{{ t(responseExpanded ? "responseWorkbench.collapse" : "responseWorkbench.expand") }}</button>
                  </template>
                </ResponseViewer>
              </div>
            </div>
            <DesignPanel v-else class="panel-view" :editor="editor" :design="design" :workspace="workspace" :assets="assets"
              :view-model="localProjectTools ? viewProjectModel : undefined" :suggest-cases="onAiSuggest"
              :suggesting-cases="ai.suggestLoading" :report-error="reportError" :read-only="workspace.readOnly" />
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
            :ai="ai"
            v-else-if="view === 'run'"
            class="panel-view"
            :run="run"
            :workspace="workspace"
            :selected-collection-locator="selectedCollectionLocator"
            :report-error="reportError"
            @locate-evidence="locateExecutionEvidence"
            @collaboration="chooseCollaborationTarget"
          />
          <!-- 测试模块（M11）：侧栏导航 + 主区用例面板/压测上下文 -->
          <template v-else-if="view === 'test'">
            <template v-if="testStressOpen && stress.planOwner">
              <div class="api-head">
                <a-button size="small" data-testid="test-back-to-cases" @click="testStressOpen = false">{{ t("test.backToCases") }}</a-button>
                <a-tag color="orange">{{ t("test.stressContext") }}</a-tag>
              </div>
              <StressPanel
                :ai="ai"
                class="panel-view"
                :stress="stress"
                :api-locator="editor.locator"
                :project-locator="selectedProjectLocator"
                :workflows="testScenarios"
                :cases="editor.api?.cases ?? []"
                :envs="stressEnvs"
                :debug="debug"
                :report-error="reportError"
                :policy="selectedProjectStressPolicy"
                :save-policy="saveSelectedProjectPolicy"
                :read-only="workspace.readOnly"
              />
            </template>
            <TestView
              :ai="ai"
              v-else
              class="panel-view"
              :editor="editor"
              :debug="debug"
              :cases="cases"
              :envs="envs"
              :stress="stress"
              :pane="moduleMemory.test.pane"
              :testing="testing"
              :report-error="reportError"
              :read-only="workspace.readOnly"
              @stress="onTestStress"
              @locate-evidence="locateExecutionEvidence"
            />
          </template>
          <WfDesigner
            :ai="ai"
            v-else
            class="wf-view"
            :workflow-design="workflowDesign"
            :wf-list="wfList"
            :workspace="workspace"
            :project-locator="selectedProjectLocator"
            :bind-index="wfBindIndex"
            :report-error="reportError"
            @locate-evidence="locateWorkflowEvidence"
            @stress-workflow="onTestWorkflowStress"
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
    <OnlineLoginDialog :online="online" :apicc="apicc" :tabs="tabs" @manage-connections="manageConnections" />
    <!-- 在线推送冲突对话框（任务 3 裁定 C）：online.conflict 驱动 -->
    <OnlineConflictDialog :online="online" />
    <OnlineMigrateDialog :online="online" :api="apicc" :report-error="reportError" :can-migrate="canMigrateWorkspace" />
    <ConfirmDialog
      :open="exitWorkspace !== null"
      :title="t('online.exitOnline')"
      :error="workspaceActionError ? t(workspaceActionError) : undefined"
      @confirm="confirmWorkspaceExit"
      @cancel="cancelWorkspaceExit"
    >
      <div v-if="exitWorkspace" class="exit-impact" data-testid="online-exit-impact">
        <p><strong>{{ exitWorkspace.session.workspace.name }}</strong> · {{ exitWorkspace.target.baseUrl }}</p>
        <p>{{ t("online.exitConfirmDesc", { count: exitWorkspace.impact.length }) }}</p>
        <ul v-if="exitWorkspace.impact.length">
          <li v-for="(tab, index) in exitWorkspace.impact" :key="tab.tabId" :data-testid="`online-exit-tab-${index}`">
            {{ tab.projectName }}
            <span v-if="tab.hasDrafts" data-testid="online-exit-draft">（{{ t("online.exitHasDraft") }}）</span>
          </li>
        </ul>
        <p v-else>{{ t("online.exitNoTabs") }}</p>
      </div>
    </ConfirmDialog>
    <!-- AI 配置对话框与建议抽屉（M6-C 任务 1）：接口头部入口按钮置显隐/拉取 -->
    <AiConfigDialog :ai="ai" :for-suggestion="aiSettingsForSuggestion" />
    <AiSuggestionsDrawer :ai="ai" :open-case-settings="openSuggestionSettings" />
    <DebugHistory :ai="ai" :open="historyOpen" :api="apicc" :history="debugHistory" :debug="debug" :editor="editor" :project-locator="selectedProjectLocator" :restore-free="restoreFreeHistory" :replay-free="replayFreeHistory" @collaboration="chooseCollaborationTarget" @close="closeDebugHistory" @after-close="restoreHistoryFocus" />
    <aside v-if="pendingCollaborationSource" class="collaboration-drawer" role="dialog" data-testid="collaboration-target-picker"><h2>{{ t('collaboration.chooseTarget') }}</h2><p>{{ t('collaboration.localNoNetwork') }}</p><p v-if="!online.loggedIn || !online.projects.length">{{ t('collaboration.connectTarget') }}</p><select v-model="collaborationTargetId" data-testid="collaboration-target"><option value="">{{ t('collaboration.chooseTarget') }}</option><option v-for="project in online.projects" :key="project.id" :value="project.id">{{ online.activeName }} · {{ online.activeWorkspace?.name }} / {{ project.name }}</option></select><button :disabled="!online.executionContext(collaborationTargetId)" data-testid="collaboration-prepare-local" @click="prepareLocalCollaboration().catch(reportError)">{{ t('collaboration.prepareLocal') }}</button><button @click="pendingCollaborationSource = null">{{ t('collaboration.close') }}</button></aside>
    <aside v-if="collaboration.visible" class="collaboration-drawer" role="dialog" :aria-label="t('collaboration.title')"><button @click="collaboration.close().catch(reportError)">{{ t('collaboration.close') }}</button><CollaborationPanel :collaboration="collaboration" :saved="online.execution.view ? { revision: online.execution.view.assets.version, manifestHash: online.execution.view.assets.manifestHash } : undefined" :dirty="online.editorDirty || onlineProjectAdapter.editor.dirty || onlineProjectAdapter.testing.dirty || onlineProjectAdapter.workflowDesign.dirty" /></aside>
  </a-layout>
  </ConfigProvider>
</template>

<style>
.exit-impact { max-height: min(240px, 48vh); overflow: auto; overflow-wrap: anywhere; }
.online-context-unavailable { padding: 16px; }
.sync-workbench{position:fixed;inset:54px 12px 12px max(12px,9vw);z-index:1040;background:var(--bg);border:1px solid var(--border);box-shadow:0 8px 36px #0004;min-width:0;overflow:hidden}
.project-tool-content { max-height: min(70vh, 720px); overflow: auto; min-width: 0; }
.collaboration-drawer{position:fixed;inset:24px 24px 24px max(24px,20vw);z-index:1050;background:var(--bg);border:1px solid var(--border);box-shadow:0 8px 36px #0004;padding:16px;overflow:auto;min-width:0}
html, body, #app { height: 100%; margin: 0; }
.app { height: 100%; min-height: 0; overflow: hidden; background: var(--bg); color: var(--text); }
.body { position: relative; flex: 1; display: flex; min-height: 0; overflow: hidden; background: var(--workbench-background); }
.sider-col-wrap {
  width: 248px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  border-right: 1px solid var(--border);
  background: var(--workbench-directory);
}
.side-col { flex: 1; min-height: 0; }
.directory-project-tools { padding: 6px 8px; border-top: 1px solid var(--border); }
.directory-project-tools > button { width: 100%; justify-content: flex-start; }
.rail-project-tools { width: 100%; }
.directory-overlay { position: absolute; z-index: 12; left: 56px; inset-block: 0; width: min(248px, calc(100% - 56px)); box-shadow: 3px 0 12px rgb(20 35 61 / 18%); }
@media (max-width: 1023px) { .sider-col-wrap:not(.directory-overlay) { width: 208px; } }
.right-col-wrap { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; flex: 1; }
.right-col { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; flex: 1; }
.debug-split { display: flex; flex: 1; flex-direction: column; min-height: 0; padding: 0 8px 8px; overflow: hidden; }
.editor-pane, .viewer-pane { display: flex; flex-direction: column; min-height: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 7px; background: var(--bg); }
.editor-pane { flex: 1; }
.split-divider {
  flex: none;
  position: relative;
  height: 10px;
  cursor: row-resize;
  background: transparent;
  touch-action: none;
}
.split-divider::before { content: ""; position: absolute; left: 0; right: 0; top: 50%; border-top: 1px solid var(--border); }
.split-divider::after { content: ""; position: absolute; left: 50%; top: 50%; width: 32px; height: 3px; border-radius: 3px; background: var(--text-muted); transform: translate(-50%, -50%); }
.split-divider:hover, .split-divider:focus-visible { background: var(--active-weak); outline: 2px solid var(--accent); outline-offset: -2px; }
.viewer-pane { flex: none; box-sizing: border-box; }
.viewer-pane > .viewer { flex: 1; }
.response-collapsed .viewer-pane { height: 36px; }
.response-header-action { min-height: 26px; flex: none; padding: 0 7px; border: 1px solid var(--border); border-radius: 5px; background: var(--bg); color: var(--text); font: inherit; font-size: 12px; cursor: pointer; }
.response-header-action:hover { background: var(--active-weak); }
.response-toggle { min-width: 56px; }
.debug-split.short-debug { display: block; overflow-y: auto; }
.short-debug .editor-pane { min-height: 225px; max-height: min(540px, 100vh); }
.short-debug .viewer-pane { height: max(270px, 60vh); margin-top: 8px; }
.debug-jump { flex: none; align-self: flex-start; margin: 5px 8px 0; padding: 3px 6px; border: 0; border-radius: 4px; background: var(--subtle); color: var(--accent); font: inherit; cursor: pointer; }
.api-head { display: flex; flex: none; align-items: center; min-height: 34px; gap: 8px; padding: 3px 8px; }
.api-head .head-spacer { flex: 1; }
.panel-view { flex: 1; min-height: 0; overflow: auto; }
/* 设计器视图：三区布局占满内容区（画布需要确定高度的容器，否则 Vue Flow 视口失真） */
.wf-view { flex: 1; min-height: 0; overflow: hidden; }
</style>

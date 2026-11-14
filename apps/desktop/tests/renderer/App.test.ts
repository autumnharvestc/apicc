// @vitest-environment jsdom
// 注：App 是组合根——内部经 api/index.ts 单例（vitest 无 preload → 回退内存替身）
// 一次装配全部 store；i18n 必须装 bridge 单例（TopBar→ThemeLanguageToggle 的
// useLocale 读同一实例，装其它实例会导致语言切换与文案不一致）。
// 宽审查 I1：本文件在模块求值期把 window.apicc 换成「已 seed、nodeCreate 恒拒绝」的
// 内存替身——api/index.ts 是惰性求值（首次 import App 时读 window.apicc），因此注入
// 必须先于组件树的首次加载，故 App 以动态 import 方式在 mountApp 内引入。
// antd 迁移后的选择器适配（task-2 步骤 2）：
// 1. a-modal（ConfirmDialog）恒经传送门渲染到 document.body，对话框内元素用
//    body 作用域包装器查询（expectBody/bodyHas）。
// 2. 其余 data-testid 触发元素（含 a-tabs #tab slot 的页签 span、a-alert 的
//    app-error-close）仍在组件 DOM 内，照旧 wrapper.find。
// TopBar 现代化（计划 2C 任务 2）适配：3. a-dropdown（语言切换）展开的菜单同样
//    传送门渲染到 body，菜单项用 langOption（data-locale）查询。
import { describe, expect, it, beforeAll, afterAll, afterEach, vi } from "vitest";
import { createStressRunInvoker } from "../../src/shared/types.js";
import { stressV2Report } from "../helpers/stressV2.js";
import { Button as AButton } from "ant-design-vue";
import { mount, flushPromises, enableAutoUnmount, DOMWrapper, type VueWrapper } from "@vue/test-utils";
import { initI18n } from "../../src/renderer/src/i18n/bridge";
import { savePreference } from "../../src/renderer/src/theme.js";
import { createMemoryApi } from "../../src/renderer/src/api/memory.js";
import HomeView from "../../src/renderer/src/components/HomeView.vue";
import DebugHistory from "../../src/renderer/src/components/DebugHistory.vue";
import ProjectTabs from "../../src/renderer/src/components/ProjectTabs.vue";
import RequestTabs from "../../src/renderer/src/components/RequestTabs.vue";
import TopBar from "../../src/renderer/src/components/TopBar.vue";
import WfDesigner from "../../src/renderer/src/components/WfDesigner.vue";
import CasePanel from "../../src/renderer/src/components/CasePanel.vue";
import EnvPanel from "../../src/renderer/src/components/EnvPanel.vue";
import RequestEditor from "../../src/renderer/src/components/RequestEditor.vue";
import OAuthManager from "../../src/renderer/src/components/OAuthManager.vue";
import SideTree from "../../src/renderer/src/components/SideTree.vue";
import ImportWizard from "../../src/renderer/src/components/ImportWizard.vue";
import MockPanel from "../../src/renderer/src/components/MockPanel.vue";
import StressPanel from "../../src/renderer/src/components/StressPanel.vue";
import RunView from "../../src/renderer/src/components/RunView.vue";
import TestView from "../../src/renderer/src/components/TestView.vue";
import AiSuggestionsDrawer from '../../src/renderer/src/components/AiSuggestionsDrawer.vue';
import { createAiBusinessFixture } from './fixtures/aiBusiness.js';
import OnlineLoginDialog from '../../src/renderer/src/components/OnlineLoginDialog.vue';
import OnlineProjectAssets from '../../src/renderer/src/components/online/OnlineProjectAssets.vue';
import CollaborationPanel from '../../src/renderer/src/components/online/CollaborationPanel.vue';
import { port as collaborationPort } from './components/collaboration-fixtures.js';
import { useDebugHistoryStore } from '../../src/renderer/src/stores/debugHistory.js';
import { useDebugStore } from '../../src/renderer/src/stores/debug.js';
import { useEditorStore } from '../../src/renderer/src/stores/editor.js';
import { debugHistory as collaborationDebugFixture, runReport as collaborationRunFixture } from '../../../../packages/core/tests/collaboration/fixtures.js';
import { workspaceFixture } from '../../../../packages/core/tests/helpers/contractFixtures.js';
import { ApiAssetSchema, ContractProjectSchema, ContractWorkspaceSchema, DebugHistoryRecordSchema } from '@apicc/core/schema';
import { defaultPolicyConfig } from '@apicc/execution/contract';
import { holdRealReportDigest } from '../helpers/realReportDigest.js';
import { onlineTreeToDto } from '../../src/main/online/session.js';
import type { useWorkspaceStore } from "../../src/renderer/src/stores/workspace.js";
import type { createTabsStore } from "../../src/renderer/src/stores/tabs.js";
import type { createRequestTabsStore, RequestTab } from "../../src/renderer/src/stores/requestTabs.js";
import type { useTreeStore } from "../../src/renderer/src/stores/tree.js";
import type { useWorkflowDesignStore } from "../../src/renderer/src/stores/workflowDesign.js";
import type { useWfListStore } from "../../src/renderer/src/stores/wfList.js";
import type { useEnvsStore } from "../../src/renderer/src/stores/envs.js";
import { useModuleMemoryStore } from "../../src/renderer/src/stores/moduleMemory.js";
import type { WfBindIndex } from "../../src/renderer/src/wf/wfBindings.js";
import type { ApiParentLocator, ProjectLocator } from "../../src/shared/locations.js";
import type { ApiccApi, ImportPreviewResult } from "../../src/shared/types.js";
import type { LocalProjectTreeNodeDTO, LocalTreeNodeDTO } from "../../src/shared/tree-dto.js";
import type { DebugInvocation, StressReport } from "@apicc/core";

const failingApi = createMemoryApi();
failingApi.seedWorkspace();
// 审查 I2 回归需要真实 nodeCreate（项目内新增接口后断言 bindIndex 重建）：
// 先留存原实现再换成恒拒绝替身，I2 用例内换回、结束时还原。
const realNodeCreate = failingApi.nodeCreate.bind(failingApi);
failingApi.nodeCreate = async () => { throw new Error("接口创建失败（测试注入）"); };
window.apicc = failingApi;

function projectByLabel(tree: LocalTreeNodeDTO, label: string): LocalProjectTreeNodeDTO {
  if (tree.kind !== "root") throw new Error("Expected local root tree");
  for (const group of tree.children) {
    if (group.kind !== "group") continue;
    const project = group.children.find((node) => node.kind === "project" && node.label === label);
    if (project?.kind === "project") return project;
  }
  throw new Error(`Project not found: ${label}`);
}

const jsdomComputedStyle = window.getComputedStyle;
beforeAll(() => {
  // Antd measures modal scrollbars via a pseudo-element. jsdom has no pseudo-element
  // layout; use the element's real computed style for that measurement only.
  window.getComputedStyle = (element) => jsdomComputedStyle.call(window, element);
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false, media: query,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    }),
  });
  // jsdom 未实现 ResizeObserver/DOMMatrixReadOnly：M2-B 侧树工作流入口用例点击节点后
  // 渲染设计器画布（vue-flow 依赖二者），与 wfDesigner.test.ts 同款 stub。
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  (globalThis as Record<string, unknown>).DOMMatrixReadOnly = class {
    m22: number;
    constructor(transform?: string) {
      const scale = transform?.match(/scale\(([1-9.]+)\)/)?.[1];
      this.m22 = scale !== undefined ? +scale : 1;
    }
  };
  localStorage.setItem("apicc.locale", "zh-CN");
});
afterAll(() => { window.getComputedStyle = jsdomComputedStyle; });

// a-modal 传送门内容随组件卸载移除：每条用例后自动卸载，防止跨用例 body 残留。
enableAutoUnmount(afterEach);

/** body 作用域查询：a-modal（ConfirmDialog）传送门渲染在 document.body（见文件头说明）。 */
function bodyFind(testid: string): DOMWrapper<Element> | null {
  const el = document.body.querySelector(`[data-testid="${testid}"]`);
  return el ? new DOMWrapper(el) : null;
}

function expectBody(testid: string): DOMWrapper<Element> {
  const w = bodyFind(testid);
  if (!w) throw new Error(`document.body 中找不到 [data-testid="${testid}"]（Modal 传送门未渲染？）`);
  return w;
}

function chooseAppSelect(wrapper: VueWrapper, testid: string, value: string): void {
  const select = wrapper.findAllComponents({ name: "ASelect" }).find((item) => item.attributes("data-testid") === testid);
  if (!select) throw new Error(`ASelect 未找到: ${testid}`);
  select.vm.$emit("update:value", value);
}

/** 语言下拉菜单项（a-dropdown 传送门渲染在 document.body，菜单项带 data-locale）。 */
function langOption(locale: string): DOMWrapper<Element> {
  const el = document.body.querySelector(`[data-locale="${locale}"]`);
  if (!el) throw new Error(`document.body 中找不到 [data-locale="${locale}"]（语言下拉未展开？）`);
  return new DOMWrapper(el);
}

/** 动态 import App：保证上方 window.apicc 注入先于 api/index.ts 的模块求值。 */
async function mountApp(attachTo?: HTMLElement, stubs?: Record<string, boolean>) {
  // M11 启动恢复会读持久化键——测试间清理保证互不影响。
  // 计划 C 任务 5：apicc.lastWorkspace 单槽退役，不再读写也无须清理；签表键 apicc.projectTabs
  // 为启动恢复的数据源（恢复用例自行播种后由 mountApp 清理隔离）。
  for (const k of ["apicc.lastApi", "apicc.tree.expanded", "apicc.moduleMemory", "apicc.projectTabs"]) localStorage.removeItem(k);
  const { default: App } = await import("../../src/renderer/src/App.vue");
  const wrapper = mount(App, { attachTo, global: { plugins: [initI18n().i18n], components: { AButton }, stubs } });
  await flushPromises();
  return wrapper;
}

/** 打开本地目录（M11：主页入口 → topbar-home → Open Directory → 成签 → 切接口模块）。
 * wsOpen 走真实磁盘 IO（替身重载），高负载下单次 flushPromises 可能早于 open 完成——
 * 轮询等待 tree 就绪（上限 ~2s）后再切接口模块，消除时序边缘。
 * 计划 C 任务 5：项目卡片点开走成签链路（openProjectTab → activateTab 编排）——
 * 轮询等待首个项目签出现后再等树节点。 */
async function expandAllCollapsedTreeContainers(wrapper: VueWrapper): Promise<void> {
  while (true) {
    const collapsed = wrapper
      .findAll('[data-testid="tree-group-toggle"]')
      .find((toggle) => toggle.text().trim() === "▸");
    if (!collapsed) return;
    await collapsed.trigger("click");
  }
}

/** Create an API through the current container More menu, matching the visible SideTree path. */
async function openNewApiFromContainer(wrapper: VueWrapper, label: string): Promise<void> {
  if (!wrapper.get('[data-testid="sidebar-api"]').isVisible()) {
    await wrapper.get('[data-testid="rail-api"]').trigger("click");
    const directory = wrapper.find('[data-testid="rail-directory"]');
    if (directory.exists() && !wrapper.get('[data-testid="sidebar-api"]').isVisible()) await directory.trigger("click");
  }
  expect(wrapper.get('[data-testid="sidebar-api"]').isVisible()).toBe(true);
  const row = wrapper.findAll(".node").find((candidate) =>
    candidate.find(".label").exists() && candidate.find(".label").text() === label);
  if (!row) throw new Error(`Expected the ${label} container row to be rendered`);
  await row.get('[data-testid="tree-more"]').trigger("click");
  await expectBody("new-api").trigger("click");
  await vi.waitFor(() => expect(wrapper.find('[data-testid="editor-full-url"]').exists()).toBe(true));
}

async function submitNewApiDraft(wrapper: VueWrapper, name: string) {
  await wrapper.get('[data-testid="editor-full-url"]').setValue("https://example.test/directory-draft");
  await wrapper.get('[data-testid="save-free-btn"]').trigger("click");
  await expectBody("free-save-name").setValue(name);
  await expectBody("free-save-submit").trigger("click");
}

async function openProjectTool(wrapper: VueWrapper, item: string) {
  await wrapper.get('[data-testid="project-tools"]').trigger("click");
  await expectBody(item).trigger("click");
  await flushPromises();
}

async function openDirectoryImport(wrapper: VueWrapper) {
  await wrapper.get('[data-testid="directory-create"]').trigger("click");
  await expectBody("directory-import-interfaces").trigger("click");
  await flushPromises();
}

/** Open the real workspace, await its store action, then open the named seed project tab. */
async function openLocalDir(wrapper: VueWrapper) {
  await wrapper.find('[data-testid="topbar-home"]').trigger("click");
  const home = wrapper.findComponent(HomeView);
  if (!home.exists()) throw new Error("HomeView was not mounted after navigating home");
  const workspace = home.props("workspace") as ReturnType<typeof useWorkspaceStore>;
  const originalOpen = workspace.open.bind(workspace);
  let openTask: Promise<void> | null = null;
  workspace.open = (rootPath) => {
    openTask = originalOpen(rootPath);
    return openTask;
  };
  await wrapper.find('[data-testid="home-open-dir"]').trigger("click");
  if (!openTask) {
    workspace.open = originalOpen;
    throw new Error("Open Directory did not invoke the real workspace.open action");
  }
  try {
    await openTask;
  } finally {
    workspace.open = originalOpen;
  }
  await flushPromises();
  const projectCard = wrapper
    .findAll('[data-testid^="project-card-"]')
    .find((card) => card.text().includes("示例项目"));
  if (!projectCard) throw new Error("The seeded 示例项目 card is unavailable after workspace.open");
  const tabs = wrapper.findComponent(ProjectTabs).props("tabs") as ReturnType<typeof createTabsStore>;
  const originalOpenProjectTab = tabs.openProjectTab.bind(tabs);
  let openTabTask: ReturnType<typeof originalOpenProjectTab> | null = null;
  tabs.openProjectTab = (...args) => {
    openTabTask = originalOpenProjectTab(...args);
    return openTabTask;
  };
  try {
    await projectCard.trigger("click");
    if (!openTabTask) throw new Error("Opening the seeded project did not invoke tabs.openProjectTab");
    await openTabTask;
  } finally {
    tabs.openProjectTab = originalOpenProjectTab;
  }
  await flushPromises();
  await expandAllCollapsedTreeContainers(wrapper);
}

function captureWorkflowLoad(workflowDesign: ReturnType<typeof useWorkflowDesignStore>) {
  const original = workflowDesign.load.bind(workflowDesign);
  let pending: ReturnType<typeof original> | null = null;
  workflowDesign.load = (root, locator) => {
    pending = original(root, locator);
    return pending;
  };
  return {
    called(): boolean {
      return pending !== null;
    },
    async settle(): Promise<void> {
      if (!pending) throw new Error("Tree selection did not invoke the real workflowDesign.load action");
      await pending;
      await flushPromises();
    },
    restore(): void {
      workflowDesign.load = original;
    },
  };
}

async function clickApiAndWait(wrapper: VueWrapper): Promise<void> {
  const editor = wrapper.findComponent(RequestEditor).props("editor") as ReturnType<typeof useEditorStore>;
  const original = editor.load.bind(editor);
  let pending: ReturnType<typeof original> | null = null;
  editor.load = (locator) => {
    pending = original(locator);
    return pending;
  };
  try {
    await wrapper.find('[data-testid="tree-api"]').trigger("click");
    if (!pending) throw new Error("Selecting the visible API did not invoke the real editor.load action");
    await pending;
    await flushPromises();
  } finally {
    editor.load = original;
  }
}

async function openWorkflowDesigner(wrapper: VueWrapper): Promise<ReturnType<typeof useWorkflowDesignStore>> {
  // WfDesigner is the workflow rail view, not the API module's design subview.
  // Select an API first so the workflow rail is enabled, then wait for the real view to mount.
  await clickApiAndWait(wrapper);
  await wrapper.find('[data-testid="rail-wf"]').trigger("click");
  await vi.waitFor(() => expect(wrapper.findComponent(WfDesigner).exists()).toBe(true));
  return wrapper.findComponent(WfDesigner).props("workflowDesign") as ReturnType<typeof useWorkflowDesignStore>;
}

describe("App 布局（M8 模块化：rail + 树面板 + 内容区）", () => {
  it('T12 opens the one synchronization entry for the selected local project and clears it on home', async () => {
    const wrapper = await mountApp(); await openLocalDir(wrapper); await clickApiAndWait(wrapper);
    await wrapper.get('[data-testid="project-tools"]').trigger("click");
    expect(document.body.querySelectorAll('[data-testid="sync-entry"]')).toHaveLength(1);
    await expectBody("sync-entry").trigger("click");
    await flushPromises();
    expect(wrapper.get('[data-testid="sync-panel"]').text()).toContain('当前电脑');
    await wrapper.get('[data-testid="topbar-home"]').trigger('click'); await flushPromises(); expect(wrapper.find('[data-testid="sync-panel"]').exists()).toBe(false);
  });

  it("R7 项目工具随目录布局迁移，A 到 B 时同步面板关闭并清旧作用域", async () => {
    const wrapper = await mountApp(document.body);
    await openLocalDir(wrapper);
    const root = await failingApi.treeGet();
    const group = root.children?.find((node) => node.kind === "group");
    if (!group || group.kind !== "group") throw new Error("Expected a workspace group");
    const second = await realNodeCreate({ kind: "project", parent: group.locator, name: "R7 同步 B" });
    if (second.kind !== "project") throw new Error("Expected the second project");
    const workspace = wrapper.getComponent(TopBar).props("workspace");
    const tabs = wrapper.getComponent(ProjectTabs).props("tabs");
    try {
      await workspace.refresh();
      const tools = () => wrapper.get('[data-testid="project-tools"]');
      expect(wrapper.get('[data-testid="sidebar-api"]').find('[data-testid="project-tools"]').exists()).toBe(true);
      await openProjectTool(wrapper, "sync-entry");
      expect(wrapper.find('[data-testid="sync-panel"]').exists()).toBe(true);
      await tabs.openProjectTab({ kind: "local", dir: workspace.root }, { locator: second.locator, name: second.label });
      await flushPromises();
      expect(wrapper.find('[data-testid="sync-panel"]').exists()).toBe(false);
      expect(wrapper.findAll('[data-testid="project-tools"]')).toHaveLength(1);
      vi.stubGlobal("innerWidth", 640);
      window.dispatchEvent(new Event("resize"));
      await flushPromises();
      expect(wrapper.get('[data-testid="module-rail"]').find('[data-testid="project-tools"]').exists()).toBe(true);
      expect(wrapper.get('[data-testid="sidebar-api"]').isVisible()).toBe(false);
      await wrapper.get('[data-testid="rail-directory"]').trigger("click");
      await flushPromises();
      expect(wrapper.get('[data-testid="rail-directory"]').attributes("aria-expanded")).toBe("true");
      expect(wrapper.get('[data-testid="sidebar-api"]').isVisible()).toBe(true);
      await wrapper.get('[data-testid="tree-search"]').setValue("remember me");
      await wrapper.get('[data-testid="directory-create"]').trigger("click");
      const staleCreate = expectBody("new-collection");
      await wrapper.get('[data-testid="rail-directory"]').trigger("click");
      await flushPromises();
      expect(bodyFind("new-collection")).toBeNull();
      await staleCreate.trigger("click");
      expect(bodyFind("dialog-input")).toBeNull();
      await wrapper.get('[data-testid="rail-directory"]').trigger("click");
      await wrapper.get('[data-testid="sidebar-api"]').trigger("keydown", { key: "Escape" });
      expect(wrapper.get('[data-testid="sidebar-api"]').isVisible()).toBe(false);
      await wrapper.get('[data-testid="rail-directory"]').trigger("click");
      expect((wrapper.get('[data-testid="tree-search"]').element as HTMLInputElement).value).toBe("remember me");
      await tools().trigger("click");
      await expectBody("sync-entry").trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-testid="sync-panel"]').exists()).toBe(true);
      await wrapper.get(".sync-workbench").trigger("keydown", { key: "Escape" });
      expect(wrapper.find('[data-testid="sync-panel"]').exists()).toBe(false);
      expect(document.activeElement).toBe(tools().element);
    } finally {
      vi.unstubAllGlobals();
      await failingApi.nodeDelete({ kind: "project", locator: second.locator });
    }
  });

  it("R7 后续 项目工具在空请求区可用，模型按稳定 ID 定位并恢复到请求原位置", async () => {
    const wrapper = await mountApp(document.body);
    await openLocalDir(wrapper);
    const project = projectByLabel(await failingApi.treeGet(), "示例项目");
    const model = await failingApi.modelCreate(project.locator, { name: "工具模型", description: "", schema: { kind: "scalar", type: "string" } });
    const component = await failingApi.componentCreate(project.locator, {
      kind: "parameter", name: "工具组件", description: "",
      definition: { location: "query", name: "fromTool", schema: { kind: "scalar", type: "string" }, required: false, description: "" },
    });
    try {
      expect(wrapper.find('[data-testid="request-editor"]').exists()).toBe(false);
      await openProjectTool(wrapper, "project-assets-entry");
      await vi.waitFor(() => expect(expectBody("project-tool-title").text()).toContain("示例项目"));
      expect(expectBody("assets-panel").element.tagName).toBe("SECTION");
      expect(expectBody(`asset-model-select-${model.id}`).text()).toBe("工具模型");
      await expectBody(`asset-component-select-parameter-${component.id}`).trigger("click");
      const rawDraft = JSON.stringify({ ...component, name: "待保存组件" }, null, 2);
      await expectBody("asset-component-definition").setValue(rawDraft);
      await new DOMWrapper(expectBody("local-project-tool").element.closest('[role="dialog"]')!).find(".ant-modal-close").trigger("click");
      await flushPromises();
      await openProjectTool(wrapper, "project-assets-entry");
      expect((expectBody("asset-component-definition").element as HTMLTextAreaElement).value).toBe(rawDraft);
      await new DOMWrapper(expectBody("local-project-tool").element.closest('[role="dialog"]')!).find(".ant-modal-close").trigger("click");
      await flushPromises();

      await clickApiAndWait(wrapper);
      const editor = wrapper.getComponent(RequestEditor).props("editor");
      const request = editor.api!.contract.request;
      if (request.protocol !== "http") throw new Error("Expected HTTP fixture");
      request.body = { kind: "json", content: '{"edited":true}', schema: { kind: "array", items: { kind: "modelRef", modelId: model.id } } };
      await wrapper.get('[data-testid="tab-body"]').trigger("click");
      await flushPromises();
      const scroll = wrapper.get<HTMLElement>('[data-testid="request-editor-scroll"]');
      scroll.element.scrollTop = 61;
      await scroll.trigger("scroll");
      const shortcut = wrapper.get<HTMLElement>('[data-testid="schema-view-model"]');
      shortcut.element.focus();
      await shortcut.trigger("click");
      await flushPromises();
      expect(expectBody(`asset-model-select-${model.id}`).attributes("aria-pressed")).toBe("true");
      await new DOMWrapper(expectBody("local-project-tool").element.closest('[role="dialog"]')!).find(".ant-modal-close").trigger("click");
      await flushPromises();
      expect(document.activeElement).toBe(shortcut.element);
      expect(wrapper.get('[data-testid="request-editor-scroll"]').element).toBe(scroll.element);
      expect(scroll.element.scrollTop).toBe(61);
      expect(request.body.content).toBe('{"edited":true}');
      request.body.schema = { kind: "modelRef", modelId: "missing-model" };
      await flushPromises();
      await wrapper.get('[data-testid="schema-view-model"]').trigger("click");
      await flushPromises();
      expect(expectBody("project-asset-target-missing").text()).toBeTruthy();
      await new DOMWrapper(expectBody("local-project-tool").element.closest('[role="dialog"]')!).find(".ant-modal-close").trigger("click");
      await wrapper.get('[data-testid="request-tab-new-free"]').trigger("click");
      await vi.waitFor(() => expect(wrapper.getComponent(RequestEditor).props("requestTab")?.source.kind).toBe("free"));
      const free = editor.activeFreeSession;
      if (!free || free.request.protocol !== "http") throw new Error("Expected a free HTTP draft");
      free.request.body = { kind: "json", content: "{}", schema: { kind: "modelRef", modelId: model.id } };
      await wrapper.get('[data-testid="tab-body"]').trigger("click");
      await wrapper.get('[data-testid="schema-view-model"]').trigger("click");
      await vi.waitFor(() => expect(expectBody(`asset-model-select-${model.id}`).attributes("aria-pressed")).toBe("true"));
    } finally {
      await failingApi.nodeDelete({ kind: "model", locator: { ...project.locator, modelId: model.id } });
      await failingApi.nodeDelete({ kind: "component", locator: { ...project.locator, componentKind: "parameter", componentId: component.id } });
    }
  });

  it("R7 后续 认证签显示共享凭据引用，按稳定组件 ID 定位且回焦", async () => {
    const wrapper = await mountApp(document.body);
    await openLocalDir(wrapper);
    const project = projectByLabel(await failingApi.treeGet(), "示例项目");
    const ref = { id: "shared-auth-ref-for-view", policy: "test-auto" as const };
    const asset = await failingApi.componentCreate(project.locator, { kind: "auth", name: "共享认证 A", description: "", definition: { kind: "bearer", token: ref } });
    try {
      await clickApiAndWait(wrapper);
      const editor = wrapper.getComponent(RequestEditor).props("editor");
      const request = editor.api!.contract.request;
      request.auth = { kind: "componentRef", componentId: asset.id, expectedKind: "auth" };
      await wrapper.get('[data-testid="tab-auth"]').trigger("click");
      expect(wrapper.get('[data-testid="request-shared-auth"]').text()).toContain("共享认证 A");
      expect(wrapper.get('[data-testid="request-shared-auth"]').text()).toContain("Bearer");
      expect(wrapper.get('[data-testid="request-auth-reference"]').text()).toContain(ref.id);
      await vi.waitFor(() => expect(wrapper.get('[data-testid="credential-status"]').text()).toBe("凭据未保存"));
      expect(wrapper.find('[data-testid="credential-value"]').exists()).toBe(false);
      expect(request.auth.kind).toBe("componentRef");
      const trigger = wrapper.get<HTMLElement>('[data-testid="auth-view-shared-component"]');
      trigger.element.focus();
      await trigger.trigger("click");
      await vi.waitFor(() => expect(expectBody(`asset-component-select-auth-${asset.id}`).attributes("aria-pressed")).toBe("true"));
      const modal = new DOMWrapper(expectBody("local-project-tool").element.closest('[role="dialog"]')!);
      expect(modal.find('[data-testid="credential-editor"]').exists()).toBe(true);
      const token = "shared-fixture-value";
      let releaseSave!: () => void;
      const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
      const realPut = failingApi.credentialPut.bind(failingApi);
      const put = vi.spyOn(failingApi, "credentialPut").mockImplementationOnce(async (input) => { await saveGate; return realPut(input); });
      try {
        await modal.get('[data-testid="credential-value"]').setValue(token);
        await modal.get('[data-testid="credential-save"]').trigger("click");
        expect(put).toHaveBeenCalledOnce();
        await modal.get(".ant-modal-close").trigger("click");
        await vi.waitFor(() => expect(wrapper.get('[data-testid="credential-status"]').text()).toBe("凭据未保存"));
      } finally { releaseSave(); put.mockRestore(); }
      await flushPromises();
      expect(document.activeElement).toBe(trigger.element);
      await vi.waitFor(() => expect(wrapper.get('[data-testid="credential-status"]').text()).toBe("凭据可用"));
      expect(wrapper.text()).not.toContain(token);
      expect(request.auth).toEqual({ kind: "componentRef", componentId: asset.id, expectedKind: "auth" });

      await trigger.trigger("click");
      await vi.waitFor(() => expect(expectBody(`asset-component-select-auth-${asset.id}`).attributes("aria-pressed")).toBe("true"));
      const reopened = new DOMWrapper(expectBody("local-project-tool").element.closest('[role="dialog"]')!);
      let releaseRemove!: () => void;
      const removeGate = new Promise<void>((resolve) => { releaseRemove = resolve; });
      const realRemove = failingApi.credentialRemove.bind(failingApi);
      const remove = vi.spyOn(failingApi, "credentialRemove").mockImplementationOnce(async (input) => { await removeGate; return realRemove(input); });
      try {
        await reopened.get('[data-testid="credential-remove"]').trigger("click");
        expect(remove).toHaveBeenCalledOnce();
        await reopened.get(".ant-modal-close").trigger("click");
        await vi.waitFor(() => expect(wrapper.get('[data-testid="credential-status"]').text()).toBe("凭据可用"));
      } finally { releaseRemove(); remove.mockRestore(); }
      await vi.waitFor(() => expect(wrapper.get('[data-testid="credential-status"]').text()).toBe("凭据未保存"));

      const workspace = wrapper.getComponent(TopBar).props("workspace");
      const tabs = wrapper.getComponent(ProjectTabs).props("tabs");
      const second = await realNodeCreate({ kind: "project", parent: { workspaceId: project.locator.workspaceId, groupId: project.locator.groupId }, name: "共享凭据隔离 B" });
      if (second.kind !== "project") throw new Error("Expected second project");
      let releasePrior!: () => void;
      const priorGate = new Promise<void>((resolve) => { releasePrior = resolve; });
      const latePut = vi.spyOn(failingApi, "credentialPut").mockImplementationOnce(async (input) => { await priorGate; return realPut(input); });
      try {
        await trigger.trigger("click");
        await vi.waitFor(() => expect(expectBody(`asset-component-select-auth-${asset.id}`).attributes("aria-pressed")).toBe("true"));
        const prior = new DOMWrapper(expectBody("local-project-tool").element.closest('[role="dialog"]')!);
        await prior.get('[data-testid="credential-value"]').setValue(token);
        await prior.get('[data-testid="credential-save"]').trigger("click");
        expect(latePut).toHaveBeenCalledOnce();
        await workspace.refresh();
        await tabs.openProjectTab({ kind: "local", dir: workspace.root }, { locator: second.locator, name: second.label });
        await flushPromises();
        expect(bodyFind("local-project-tool")).toBeNull();
        releasePrior();
        await latePut.mock.results[0]?.value;
        await flushPromises();
        expect(wrapper.find('[data-testid="credential-status"]').exists()).toBe(false);
        expect(bodyFind("local-project-tool")).toBeNull();
      } finally {
        releasePrior();
        await latePut.mock.results[0]?.value;
        latePut.mockRestore();
        await realRemove({ locator: project.locator, ref });
        await failingApi.nodeDelete({ kind: "project", locator: second.locator });
      }
    } finally {
      await failingApi.nodeDelete({ kind: "component", locator: { ...project.locator, componentKind: "auth", componentId: asset.id } });
    }
  });

  it("R7 后续 Mock 从项目工具关闭停止读取，切项目无串读，回到同项目保留草稿和运行", async () => {
    const wrapper = await mountApp(document.body);
    await openLocalDir(wrapper);
    const root = await failingApi.treeGet();
    const project = projectByLabel(root, "示例项目");
    const group = root.children?.find((node) => node.kind === "group");
    if (group?.kind !== "group") throw new Error("Expected workspace group");
    const second = await realNodeCreate({ kind: "project", parent: group.locator, name: "后续 Mock B" });
    if (second.kind !== "project") throw new Error("Expected project");
    const workspace = wrapper.getComponent(TopBar).props("workspace");
    const tabs = wrapper.getComponent(ProjectTabs).props("tabs");
    const get = vi.spyOn(failingApi, "mockGet");
    const stop = vi.spyOn(failingApi, "mockStop");
    const original = await failingApi.mockGet(project.locator);
    const savedConfig = { formatVersion: 1 as const, seed: "saved-before-mock", enabledContractIds: [], rules: [] };
    await failingApi.mockConfigSave({ locator: project.locator, sourceProjectRevision: original.sourceProjectRevision, config: savedConfig });
    get.mockClear();
    try {
      await workspace.refresh();
      expect(wrapper.findComponent(RequestEditor).attributes("data-source-kind")).toBeUndefined();
      await openProjectTool(wrapper, "project-mock-entry");
      await vi.waitFor(() => expect(expectBody("mock-status").attributes("data-status")).toBe("stopped"));
      await expectBody("mock-start").trigger("click");
      await vi.waitFor(() => expect(expectBody("mock-status").attributes("data-status")).toBe("running"));
      const draftText = JSON.stringify({ ...savedConfig, seed: "keep-A-draft" }, null, 2);
      await expectBody("mock-config").setValue(draftText);
      await new DOMWrapper(expectBody("local-project-tool").element.closest('[role="dialog"]')!).find(".ant-modal-close").trigger("click");
      await flushPromises();
      expect(wrapper.getComponent(MockPanel).props("active")).toBe(false);
      const before = get.mock.calls.length;
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(4_500);
      vi.useRealTimers();
      expect(get).toHaveBeenCalledTimes(before);
      expect(stop).not.toHaveBeenCalled();

      await tabs.openProjectTab({ kind: "local", dir: workspace.root }, { locator: second.locator, name: second.label });
      await openProjectTool(wrapper, "project-mock-entry");
      expect(get).toHaveBeenLastCalledWith(second.locator);
      expect((expectBody("mock-config").element as HTMLTextAreaElement).value).not.toContain("keep-A-draft");
      const originalTab = Object.values((tabs as ReturnType<typeof createTabsStore>).tabs)
        .find((tab) => "projectLocator" in tab && tab.projectLocator.projectId === project.locator.projectId);
      if (!originalTab) throw new Error("Expected the original project tab");
      await tabs.activateTab(originalTab.tabId);
      await flushPromises();
      expect(wrapper.findComponent(MockPanel).exists()).toBe(false);
      await openProjectTool(wrapper, "project-mock-entry");
      expect(get).toHaveBeenLastCalledWith(project.locator);
      expect(expectBody("mock-status").attributes("data-status")).toBe("running");
      expect((expectBody("mock-config").element as HTMLTextAreaElement).value).toBe(draftText);
      await expectBody("mock-new-free-request").trigger("click");
      await vi.waitFor(() => expect(wrapper.getComponent(RequestEditor).props("requestTab")?.source.kind).toBe("free"));
      expect(wrapper.getComponent(RequestEditor).props("requestTab")?.project).toEqual(project.locator);
    } finally {
      vi.useRealTimers();
      get.mockRestore();
      stop.mockRestore();
      await failingApi.mockProjectClose({ root: workspace.root, locator: project.locator });
      await failingApi.nodeDelete({ kind: "project", locator: second.locator });
    }
  });

  it("R7 后续 目录导入锁定当前项目和所选模块，新建和合并各自落盘", async () => {
    const wrapper = await mountApp(document.body);
    await openLocalDir(wrapper);
    const project = projectByLabel(await failingApi.treeGet(), "示例项目");
    const existing = project.children.find((node) => node.kind === "collection");
    if (existing?.kind !== "collection") throw new Error("Expected existing module");
    const source = ContractProjectSchema.parse({
      id: "b2514220-cb8f-4c2e-a690-c41e017afe00", name: "目录导入测试", globals: {},
      collections: [{ id: "b2514220-cb8f-4c2e-a690-c41e017afe01", name: "导入来源", variables: {}, preOperations: [], postOperations: [], folders: [],
        apis: [ApiAssetSchema.parse({ contract: {
          formatVersion: 1, id: "b2514220-cb8f-4c2e-a690-c41e017afe02", metadata: { name: "合并来源接口", description: "", tags: [], version: "1", status: "draft" },
          request: { protocol: "http", method: "GET", baseUrl: "https://example.test", path: "/directory-import", pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, body: { kind: "none" } },
          responses: [],
        }, cases: [], documentation: "" })],
      }],
    });
    const imported = source.collections[0]!;
    const originalPreview = failingApi.importPreview.bind(failingApi);
    const preview = vi.spyOn(failingApi, "importPreview").mockImplementation(async (input) => {
      const result = await originalPreview(input);
      failingApi.setImportPreviewCandidate(result.token, source);
      return { ...result, tree: [{ id: imported.id, name: imported.name, apis: [
        { id: imported.apis[0]!.contract.id, name: "合并来源接口", method: "GET", path: "/directory-import" },
      ] }] };
    });
    const plan = vi.spyOn(failingApi, "importPlan");
    const apply = vi.spyOn(failingApi, "importApply");
    try {
      expect(wrapper.find('[data-testid="request-editor"]').exists()).toBe(false);
      await openDirectoryImport(wrapper);
      expect(expectBody("import-target-project").text()).toBe("示例项目");
      await expectBody("import-curl-input").setValue("curl https://example.test/directory-import");
      await expectBody("import-curl-preview").trigger("click");
      await vi.waitFor(() => expect(bodyFind("import-preview-tree")).not.toBeNull());
      await expectBody("import-name-input").setValue("目录新建模块");
      await expectBody("import-build-plan").trigger("click");
      await vi.waitFor(() => expect(expectBody("import-apply").attributes("disabled")).toBeUndefined());
      await expectBody("import-apply").trigger("click");
      await vi.waitFor(() => expect(bodyFind("import-done")).not.toBeNull());
      expect(expectBody("import-done").text()).toContain("已新建模块「目录新建模块」");
      expect(plan).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "module", target: project.locator, name: "目录新建模块" }));
      expect(projectByLabel(await failingApi.treeGet(), "示例项目").children.some((node) => node.label === "目录新建模块")).toBe(true);
      await expectBody("import-undo").trigger("click");
      await vi.waitFor(async () => expect(projectByLabel(await failingApi.treeGet(), "示例项目").children.some((node) => node.label === "目录新建模块")).toBe(false));
      await expectBody("import-finish").trigger("click");

      await clickApiAndWait(wrapper);
      await openDirectoryImport(wrapper);
      expect(expectBody("import-target-module").text()).toBe(existing.label);
      await expectBody("import-curl-input").setValue("curl https://example.test/directory-import");
      await expectBody("import-curl-preview").trigger("click");
      await vi.waitFor(() => expect(bodyFind("import-preview-tree")).not.toBeNull());
      const control = expectBody("import-merge-selected-module").element;
      const checkbox = control instanceof HTMLInputElement ? control : control.querySelector("input");
      if (!checkbox) throw new Error("Expected merge option");
      await new DOMWrapper(checkbox).setValue(true);
      expect(bodyFind("import-name-input")).toBeNull();
      await expectBody("import-build-plan").trigger("click");
      await vi.waitFor(() => expect(expectBody("import-apply").attributes("disabled")).toBeUndefined());
      await expectBody("import-apply").trigger("click");
      await vi.waitFor(() => expect(bodyFind("import-done")).not.toBeNull());
      expect(expectBody("import-done").text()).toContain(`已合并到模块「${existing.label}」`);
      expect(plan).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "merge", target: existing.locator }));
      expect(apply).toHaveBeenCalledTimes(2);
      const merged = projectByLabel(await failingApi.treeGet(), "示例项目").children.find((node) => node.id === existing.id);
      expect(merged?.children?.some((node) => node.label === "合并来源接口")).toBe(true);
      await expectBody("import-undo").trigger("click");
      await vi.waitFor(async () => {
        const restored = projectByLabel(await failingApi.treeGet(), "示例项目").children.find((node) => node.id === existing.id);
        expect(restored?.children?.some((node) => node.label === "合并来源接口")).toBe(false);
      });
    } finally { preview.mockRestore(); plan.mockRestore(); apply.mockRestore(); }
  });

  it("R7 后续 目录导入在同工作区切项目时丢弃迟到计划，旧预览无法应用", async () => {
    const wrapper = await mountApp(document.body);
    await openLocalDir(wrapper);
    const workspace = wrapper.getComponent(TopBar).props("workspace");
    const tabs = wrapper.getComponent(ProjectTabs).props("tabs");
    const root = await failingApi.treeGet();
    const projectA = projectByLabel(root, "示例项目");
    const group = root.children?.find((node) => node.kind === "group");
    if (group?.kind !== "group") throw new Error("Expected workspace group");
    const projectB = await realNodeCreate({ kind: "project", parent: group.locator, name: "目录导入 B" });
    if (projectB.kind !== "project") throw new Error("Expected a second project");
    const originalPlan = failingApi.importPlan.bind(failingApi);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const plan = vi.spyOn(failingApi, "importPlan").mockImplementation(async (input) => {
      if (input.target.workspaceId === projectA.locator.workspaceId && "projectId" in input.target && input.target.projectId === projectA.locator.projectId) await gate;
      return originalPlan(input);
    });
    const apply = vi.spyOn(failingApi, "importApply");
    try {
      await workspace.refresh();
      await openDirectoryImport(wrapper);
      await expectBody("import-curl-input").setValue("curl https://example.test/old");
      await expectBody("import-curl-preview").trigger("click");
      await vi.waitFor(() => expect(bodyFind("import-preview-tree")).not.toBeNull());
      const oldStore = wrapper.getComponent(ImportWizard).props("importW");
      await expectBody("import-build-plan").trigger("click");
      await vi.waitFor(() => expect(plan).toHaveBeenCalledTimes(1));
      await tabs.openProjectTab({ kind: "local", dir: workspace.root }, { locator: projectB.locator, name: projectB.label });
      await flushPromises();
      expect(bodyFind("import-wizard")).toBeNull();
      await openDirectoryImport(wrapper);
      expect(expectBody("import-target-project").text()).toBe("目录导入 B");
      await expectBody("import-curl-input").setValue("curl https://example.test/new");
      await expectBody("import-curl-preview").trigger("click");
      await vi.waitFor(() => expect(bodyFind("import-preview-tree")).not.toBeNull());
      release();
      await flushPromises();
      expect(oldStore.plan).toBeNull();
      expect(expectBody("import-apply").attributes("disabled")).toBeDefined();
      expect(apply).not.toHaveBeenCalled();
    } finally {
      release();
      plan.mockRestore();
      apply.mockRestore();
      await failingApi.nodeDelete({ kind: "project", locator: projectB.locator });
    }
  });

  it("R7 左栏与请求栏共享请求签环境，切换请求后旧菜单不能选到另一签", async () => {
    const wrapper = await mountApp();
    await openLocalDir(wrapper);
    const project = projectByLabel(await failingApi.treeGet(), "示例项目");
    const env = await failingApi.envCreate({ locator: project.locator, name: "R7 调试环境" });
    const locator = { ...project.locator, environmentId: env.id };
    try {
      await clickApiAndWait(wrapper);
      const requestEditor = wrapper.getComponent(RequestEditor);
      const debug = requestEditor.props("debug") as ReturnType<typeof useDebugStore>;
      const asset = requestEditor.props("requestTab") as RequestTab;
      const rail = wrapper.get('[data-testid="rail-envs"]');
      const request = () => wrapper.get('[data-testid="debug-env-select"]');
      await rail.trigger("click");
      await expectBody(`debug-env-option-${env.id}`).trigger("click");
      expect(request().text()).toBe("R7 调试环境");
      expect(debug.requestTabState(asset).selectedEnvironmentId).toBe(env.id);
      await request().trigger("click");
      await expectBody("debug-env-option-none").trigger("click");
      expect(rail.text()).toBe("无环境");
      await rail.trigger("click");
      const stale = expectBody(`debug-env-option-${env.id}`);
      await wrapper.get('[data-testid="request-tab-new-free"]').trigger("click");
      await flushPromises();
      const free = wrapper.getComponent(RequestEditor).props("requestTab") as RequestTab;
      expect(free.source.kind).toBe("free");
      expect(bodyFind(`debug-env-option-${env.id}`)).toBeNull();
      await stale.trigger("click");
      expect(debug.requestTabState(free).selectedEnvironmentId).toBeNull();
      expect(debug.requestTabState(asset).selectedEnvironmentId).toBeNull();
      await request().trigger("click");
      await expectBody(`debug-env-option-${env.id}`).trigger("click");
      expect(debug.requestTabState(free).selectedEnvironmentId).toBe(env.id);
      expect(wrapper.get('[data-testid="rail-envs"]').text()).toBe("R7 调试环境");
      await wrapper.get(`[data-testid="request-tab-${asset.tabId}"]`).trigger("click");
      await flushPromises();
      expect(wrapper.get('[data-testid="rail-envs"]').text()).toBe("无环境");
    } finally {
      await failingApi.nodeDelete({ kind: "environment", locator });
    }
  });

  it("R7 在线项目工具保留账户、迁移和退出，且不开放本地调试环境", async () => {
    await seedOnlineLogin();
    try {
      const wrapper = await mountApp();
      await gotoServerWorkspaces(wrapper);
      await wrapper.get('[data-testid="home-ws-ws-online-1"]').trigger("click");
      await flushPromises();
      await wrapper.get('[data-testid="project-card-300"]').trigger("click");
      await flushPromises();
      expect(wrapper.get('[data-testid="rail-envs"]').attributes("disabled")).toBeDefined();
      const tools = wrapper.get('[data-testid="project-tools"]');
      await tools.trigger("click");
      expect(bodyFind("project-online-migrate")).not.toBeNull();
      expect(bodyFind("project-online-exit")).not.toBeNull();
      await expectBody("project-connection-account").trigger("click");
      await flushPromises();
      expect(expectBody("online-user").text()).toContain("示例用户");
      const online = wrapper.getComponent(OnlineLoginDialog).props("online");
      expect(online.activeBaseUrl).toBe(ONLINE_SERVER);
      online.dialogOpen = false;
      await flushPromises();
      await tools.trigger("click");
      await expectBody("project-online-exit").trigger("click");
      await flushPromises();
      expect(expectBody("online-exit-impact").text()).toContain(ONLINE_SERVER);
      await expectBody("dialog-cancel").trigger("click");
      expect(online.activeWorkspace?.id).toBe("ws-online-1");
    } finally {
      await cleanupOnlineLogin();
    }
  });

  // Catches leaf entries receiving no shared AI store from the actual composition root.
  it('T11 passes the same AI store to actual local case and run report entries', async () => {
    const wrapper = await mountApp(); await openLocalDir(wrapper); await clickApiAndWait(wrapper);
    const ai = wrapper.findComponent(AiSuggestionsDrawer).props('ai');
    await wrapper.get('[data-testid="rail-test"]').trigger('click'); await flushPromises();
    expect(wrapper.findComponent(CasePanel).props('ai') === ai).toBe(true);
    await wrapper.get('[data-testid="rail-run"]').trigger('click'); await flushPromises();
    expect(wrapper.findComponent(RunView).props('ai') === ai).toBe(true);
  });

  // Catches online-shaped fixtures passing unit tests while App still captures its local editor/context.
  it('T9 shortcut from the local request editor opens selected-history sharing without requiring online state or blocking Send', async () => {
    const wrapper = await mountApp();
    await openLocalDir(wrapper);
    await clickApiAndWait(wrapper);
    expect(wrapper.get('[data-testid="request-send-slot"]').attributes('aria-disabled')).toBe('false');
    await wrapper.get('[data-testid="request-more"]').trigger('click');
    await expectBody('collaboration-open-history').trigger('click');
    await flushPromises();
    expect(wrapper.findComponent(DebugHistory).props('open')).toBe(true);
    expect(wrapper.get('[data-testid="request-send-slot"]').attributes('aria-disabled')).toBe('false');
  });
  it('T9 shortcut selects one attributable private debug history descriptor without any renderer artifact', async () => {
    const api = createMemoryApi(), project = { workspaceId: '00000000-0000-4000-8000-000000000001', groupId: '00000000-0000-4000-8000-000000000002', projectId: '00000000-0000-4000-8000-000000000003' }, editor = useEditorStore(api, () => ({ root: 'memory-root', readOnly: false })), debug = useDebugStore(api, editor), history = useDebugHistoryStore(api);
    const record = DebugHistoryRecordSchema.options[1].parse(collaborationDebugFixture()); record.result.replay = { mode: 'free', sourceKind: 'free', project, draftId: '40000000-0000-4000-8000-000000000009', request: { protocol: 'http', method: 'GET', baseUrl: 'https://example.test', path: '/', pathParams: [], headers: [], query: [], cookies: [], body: { kind: 'none' }, auth: { kind: 'none' } }, parameters: {}, fields: [], available: true }; Object.assign(history, { selected: { record, diagnostics: [] } });
    const wrapper = mount(DebugHistory, { props: { open: true, api, history, debug, editor, projectLocator: project }, global: { plugins: [initI18n().i18n] } }); await flushPromises(); expect(document.body.textContent).toContain(record.historyId);
    await expectBody('collaboration-publish-debug').trigger('click'); expect(wrapper.emitted('collaboration')?.[0]?.[0]).toEqual({ kind: 'debug', historyId: record.historyId, owner: { sourceKind: 'free', project, draftId: '40000000-0000-4000-8000-000000000009' }, project });
  });
  it('T9 local report shortcut asks for an online target without affecting offline execution or sending anything', async () => {
    const original = failingApi.onlineCollaboration, calls: unknown[] = []; failingApi.onlineCollaboration = async input => { calls.push(input); return { stage: 'idle' }; };
    const wrapper = await mountApp();
    let digest: ReturnType<typeof holdRealReportDigest> | undefined;
    try { await openLocalDir(wrapper); await clickApiAndWait(wrapper); await wrapper.get('[data-testid="rail-run"]').trigger('click'); await flushPromises(); const reportView = wrapper.findComponent(RunView), run = reportView.props('run'); expect(reportView.props('selectedCollectionLocator')).toBeTruthy();
      run.result = collaborationRunFixture(); await flushPromises(); expect(wrapper.text()).toContain('用例1'); digest = holdRealReportDigest(); await wrapper.get('[data-testid="collaboration-publish-current"]').trigger('click'); await flushPromises(); expect(digest.spy).toHaveBeenCalledTimes(1);
      expect(wrapper.find('[data-testid="collaboration-target-picker"]').exists()).toBe(false); expect(calls).toEqual([]); expect(wrapper.get('[data-testid="run-btn"]').attributes('disabled')).toBeUndefined();
      await digest.settle(); await flushPromises();
      expect(wrapper.find('[data-testid="collaboration-target-picker"]').exists()).toBe(true); expect(calls).toEqual([]); expect(wrapper.get('[data-testid="run-btn"]').attributes('disabled')).toBeUndefined();
    } finally { try { await digest?.settle(); await flushPromises(); } finally { digest?.restore(); wrapper.unmount(); failingApi.onlineCollaboration = original; } }
  });
  it.each(['entry', 'online-local', 'session-change', 'navigation', 'local-target'] as const)('T9 opens the actual App collaboration panel and binds its %s flow to the selected online project', async flow => {
    const names = ['onlineLogin', 'onlineWorkspaceList', 'onlineWorkspaceOpen', 'onlineWorkspaceActivate', 'onlineTreeView', 'onlineExecution', 'onlineCollaboration'] as const, originals = new Map(names.map(name => [name, failingApi[name]]));
    const projectAsset = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!, scope = { workspaceId: '11', groupId: '22', projectId: '33' }, api = collaborationPort();
    const projects = [{ id: '33', groupId: '22', name: projectAsset.name, myRole: 'EDITOR' as const }], view = { workspaceId: '11', name: 'Member fixture', myRole: 'OWNER' as const, projects, tree: onlineTreeToDto({ workspaceId: '11', rootVersion: 1, files: [], projects }, 'Member fixture') };
    failingApi.onlineLogin = async () => ({ expiresAt: '2099-01-01T00:00:00Z', user: { id: '7', username: 'alice', displayName: 'Member' } }); failingApi.onlineWorkspaceList = async () => [{ id: '11', name: view.name, myRole: 'OWNER', createdAt: '2026-11-01T00:00:00Z' }];
    failingApi.onlineWorkspaceOpen = async () => view; failingApi.onlineWorkspaceActivate = async () => {}; failingApi.onlineTreeView = async () => view; failingApi.onlineCollaboration = api.onlineCollaboration;
    failingApi.onlineExecution = async input => input.operation === 'assets' ? { project: projectAsset, problems: [], assets: { ...scope, format: 'contract-files-v1', contractProjectId: projectAsset.id, version: '12', manifestHash: 'c'.repeat(64), files: [] } } : input.operation === 'agents' ? { defaultAgentId: null, canManageScripts: false, policy: structuredClone(defaultPolicyConfig), policyVersion: '1', agents: [] } : input.operation === 'materials' ? { credentials: [], attachments: [] } : [];
    const wrapper = await mountApp();
    try {
      const online = wrapper.findComponent(OnlineLoginDialog).props('online'); online.addProfile('http://127.0.0.1:8080', 'Member'); await online.login('alice', 'password8'); await online.refreshWorkspaces(); await online.openWorkspace(online.workspaces[0]!);
      await wrapper.findComponent(ProjectTabs).props('tabs').openProjectTab({ kind: 'online', workspaceId: '11', name: view.name }, { id: '33', name: projectAsset.name }); await flushPromises();
      await vi.waitFor(() => expect(wrapper.findComponent(OnlineProjectAssets).exists()).toBe(true)); await wrapper.get('[data-testid="collaboration-entry"]').trigger('click'); await flushPromises();
      expect(wrapper.findComponent(CollaborationPanel).exists()).toBe(true); expect(api.calls.map(call => call.operation)).toEqual(['activate', 'access', 'history', 'publications']);
      expect(wrapper.findComponent(CollaborationPanel).text()).toContain('40');
      if (flow === 'session-change') { online.clearLoginState(); await flushPromises(); expect(wrapper.findComponent(CollaborationPanel).exists()).toBe(false); expect(api.calls.at(-1)?.operation).toBe('cancel-preview'); }
      if (flow === 'navigation') { await wrapper.get('[data-testid="topbar-home"]').trigger('click'); await flushPromises(); expect(wrapper.findComponent(CollaborationPanel).exists()).toBe(false); expect(api.calls.at(-1)?.operation).toBe('cancel-preview'); }
      if (flow === 'online-local') {
        await wrapper.findComponent(CollaborationPanel).props('collaboration').close(); online.execution.localResult = { location: { kind: 'local' }, runId: '40000000-0000-4000-8000-000000000019', snapshotId: '66', manifestHash: 'a'.repeat(64), runtimeCompatibilityId: 'recorded', scriptTimeoutMs: 3000, output: { kind: 'suite', result: collaborationRunFixture() } }; await flushPromises();
        const count = api.calls.length; await wrapper.get('[data-testid="collaboration-publish-result"]').trigger('click'); await flushPromises(); expect(api.calls.slice(count)).toEqual([{ operation: 'preview-local', context: { serverId: 'http://127.0.0.1:8080/api/v1', ownerId: '7', scope }, source: { kind: 'online-local', runId: '40000000-0000-4000-8000-000000000019' }, title: '本机执行报告' }]); expect(wrapper.findComponent(CollaborationPanel).text()).toContain('Selected safe report');
      }
      if (flow === 'local-target') {
        await openLocalDir(wrapper); await clickApiAndWait(wrapper); await wrapper.get('[data-testid="rail-run"]').trigger('click'); await flushPromises(); const run = wrapper.findComponent(RunView).props('run'); run.result = collaborationRunFixture(); await flushPromises(); await wrapper.get('[data-testid="collaboration-publish-current"]').trigger('click'); await flushPromises(); const count = api.calls.length;
        await vi.waitFor(() => expect(wrapper.find('[data-testid="collaboration-target-picker"]').exists()).toBe(true)); await wrapper.get('[data-testid="collaboration-target"]').setValue('33'); await wrapper.get('[data-testid="collaboration-prepare-local"]').trigger('click'); await flushPromises(); expect(api.calls.slice(count)).toHaveLength(1); expect(api.calls.at(-1)).toMatchObject({ operation: 'preview-local', context: { scope }, source: { kind: 'current', expectedReportDigest: expect.stringMatching(/^[a-f0-9]{64}$/) } }); expect((api.calls.at(-1) as any).source.project.projectId).not.toBe('33');
      }
    } finally { wrapper.unmount(); for (const name of names) Object.assign(failingApi, { [name]: originals.get(name) }); }
  });
  it('T11 prepares the actual App online member editor through the one shared AI store', async () => {
    const fixture = createAiBusinessFixture(); const names = ['aiSettingsRead', 'aiCatalogReload', 'aiPrepareAssistance', 'aiStart', 'aiCancel', 'onAiProgress', 'aiInspectChoices', 'onlineLogin', 'onlineWorkspaceList', 'onlineWorkspaceOpen', 'onlineWorkspaceActivate', 'onlineTreeView', 'onlineExecution'] as const;
    const originals = new Map(names.map(name => [name, failingApi[name]]));
    for (const name of names.slice(0, 7)) Object.assign(failingApi, { [name]: fixture.api[name] });
    const projectAsset = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
    const scope = { workspaceId: '11', groupId: '22', projectId: '33' };
    const projects = [{ id: '33', groupId: '22', name: projectAsset.name, myRole: 'EDITOR' as const }];
    const view = { workspaceId: '11', name: 'Typed member fixture', myRole: 'OWNER' as const,
      projects, tree: onlineTreeToDto({ workspaceId: '11', rootVersion: 1, files: [], projects }, 'Typed member fixture') };
    failingApi.onlineLogin = async () => ({ expiresAt: '2026-11-01T00:00:00.000Z', user: { id: '7', username: 'alice', displayName: 'Synthetic member' } });
    failingApi.onlineWorkspaceList = async () => [{ id: '11', name: view.name, myRole: 'OWNER', createdAt: '2026-10-31T00:00:00.000Z' }];
    failingApi.onlineWorkspaceOpen = async () => view; failingApi.onlineWorkspaceActivate = async () => {}; failingApi.onlineTreeView = async () => view;
    failingApi.onlineExecution = async input => {
      if (input.operation === 'assets') return { project: projectAsset, problems: [], assets: { ...scope, format: 'contract-files-v1', contractProjectId: projectAsset.id, version: '1', manifestHash: 'a'.repeat(64), files: [] } };
      if (input.operation === 'agents') return { defaultAgentId: null, canManageScripts: false, policy: structuredClone(defaultPolicyConfig), policyVersion: '1', agents: [] };
      if (input.operation === 'materials') return { credentials: [], attachments: [] };
      if (input.operation === 'list') return [];
      throw new Error('unexpected-online-test-action');
    };
    const wrapper = await mountApp();
    try {
      const online = wrapper.findComponent(OnlineLoginDialog).props('online');
      online.addProfile('http://127.0.0.1:8080', 'Synthetic member fixture'); await online.login('alice', 'password8'); await online.refreshWorkspaces(); await online.openWorkspace(online.workspaces[0]!);
      const project = online.projects[0]!; const tabs = wrapper.findComponent(ProjectTabs).props('tabs');
      await tabs.openProjectTab({ kind: 'online', workspaceId: online.activeWorkspace!.id, name: online.activeWorkspace!.name }, { id: project.id, name: project.name });
      await flushPromises();
      expect(online.execution.context).toEqual({ serverId: 'http://127.0.0.1:8080/api/v1', ownerId: '7', scope });
      await vi.waitFor(() => expect(wrapper.findComponent(OnlineProjectAssets).exists()).toBe(true));
      await vi.waitFor(() => expect(online.execution.project).not.toBeNull());
      const adapter = wrapper.findComponent(OnlineProjectAssets).props('adapter');
      const entry = adapter.apiEntries()[0]!; await adapter.editor.load(entry.locator);
      const ai = wrapper.findComponent(AiSuggestionsDrawer).props('ai'); await ai.fetchSuggestions();
      expect(fixture.prepared[0]?.selection.source).toEqual({ kind: 'online', context: JSON.parse(JSON.stringify(online.execution.context)) });
      expect(fixture.prepared[0]?.selection.business).toMatchObject({ purpose: 'case-suggestion', target: { apiId: entry.locator.apiId } });
    } finally { wrapper.unmount(); for (const name of names) Object.assign(failingApi, { [name]: originals.get(name) }); }
  });
  it('opens the online directory draft above the compact sidebar and restores its rail trigger', async () => {
    const names = ['onlineLogin', 'onlineWorkspaceList', 'onlineWorkspaceOpen', 'onlineWorkspaceActivate', 'onlineTreeView', 'onlineExecution'] as const;
    const originals = new Map(names.map(name => [name, failingApi[name]]));
    const scope = { workspaceId: '11', groupId: '22', projectId: '33' };
    const projects = [{ id: '33', groupId: '22', name: 'Compact online project', myRole: 'EDITOR' as const }];
    const view = { workspaceId: '11', name: 'Team', myRole: 'VIEWER' as const,
      projects, tree: onlineTreeToDto({ workspaceId: '11', rootVersion: 1, files: [], projects }, 'Team') };
    failingApi.onlineLogin = async () => ({ expiresAt: '2099-01-01T00:00:00Z', user: { id: '7', username: 'alice', displayName: 'Member' } });
    failingApi.onlineWorkspaceList = async () => [{ id: '11', name: view.name, myRole: 'VIEWER', createdAt: '2026-11-01T00:00:00Z' }];
    failingApi.onlineWorkspaceOpen = async () => view;
    failingApi.onlineWorkspaceActivate = async () => {};
    failingApi.onlineTreeView = async () => view;
    failingApi.onlineExecution = async input => {
      if (input.operation === 'assets') return { project: null, problems: [], assets: { ...scope, format: null, contractProjectId: null, version: '0', manifestHash: 'a'.repeat(64), files: [] } };
      if (input.operation === 'agents') return { defaultAgentId: null, canManageScripts: false, policy: structuredClone(defaultPolicyConfig), policyVersion: '1', agents: [] };
      if (input.operation === 'materials') return { credentials: [], attachments: [] };
      if (input.operation === 'list') return [];
      throw new Error('Unexpected online write');
    };
    vi.stubGlobal('innerWidth', 640);
    const wrapper = await mountApp(document.body);
    try {
      const online = wrapper.findComponent(OnlineLoginDialog).props('online');
      online.addProfile('http://127.0.0.1:8080', 'Team');
      await online.login('alice', 'password8'); await online.refreshWorkspaces(); await online.openWorkspace(online.workspaces[0]!);
      await wrapper.findComponent(ProjectTabs).props('tabs').openProjectTab({ kind: 'online', workspaceId: '11', name: view.name }, projects[0]!);
      await vi.waitFor(() => expect(wrapper.find('[data-testid="online-directory-blank"]').exists()).toBe(true));
      const rail = wrapper.get('[data-testid="rail-directory"]');
      await rail.trigger('click');
      const create = wrapper.get('[data-testid="directory-create"]');
      await create.trigger('click');
      await expectBody('new-api').trigger('click');
      const draft = wrapper.get('[data-testid="online-draft"]');
      expect(draft.isVisible()).toBe(true);
      expect(rail.attributes('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(draft.get('[data-testid="online-editor-name"]').element);
      await draft.get('[data-testid="online-draft-cancel"]').trigger('click');
      expect(wrapper.find('[data-testid="online-draft"]').exists()).toBe(false);
      expect(document.activeElement).toBe(rail.element);
    } finally {
      wrapper.unmount(); vi.unstubAllGlobals();
      for (const name of names) Object.assign(failingApi, { [name]: originals.get(name) });
    }
  });
  // Catches the composition root leaving its real AI operation/subscription alive after unmount.
  it('T11 disposes the shared App AI operation on unmount', async () => {
    const fixture = createAiBusinessFixture();
    const names = ['aiSettingsRead', 'aiCatalogReload', 'aiPrepareAssistance', 'aiStart', 'aiCancel', 'onAiProgress', 'aiInspectChoices'] as const;
    const originals = new Map(names.map(name => [name, failingApi[name]]));
    for (const name of names) Object.assign(failingApi, { [name]: fixture.api[name] });
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const cancelled: string[] = []; let operationId = '', detached = 0;
    const start = fixture.api.aiStart;
    failingApi.aiStart = async input => { operationId = input.operationId; const result = await start(input); await gate; return result; };
    failingApi.onAiProgress = () => () => { detached++; };
    failingApi.aiCancel = async input => { cancelled.push(input.operationId); return { cancelled: true }; };
    let pending: Promise<void> | undefined;
    const wrapper = await mountApp();
    try {
      await openLocalDir(wrapper); await clickApiAndWait(wrapper);
      const ai = wrapper.findComponent(AiSuggestionsDrawer).props('ai');
      await ai.fetchSuggestions(); pending = ai.confirmAssistance(); await flushPromises();
      expect(operationId).toMatch(/^[0-9a-f-]{36}$/);
      wrapper.unmount(); await flushPromises();
      expect(cancelled).toEqual([operationId]); expect(detached).toBe(1);
    } finally { release(); await pending; for (const name of names) Object.assign(failingApi, { [name]: originals.get(name) }); }
  });

  it("R7 后续 AI 建议从标题、窄窗请求菜单和设计进入，缺模型时明确点击设置并回焦", async () => {
    const inspect = vi.spyOn(failingApi, "aiInspectChoices").mockRejectedValue(
      new Error("Error invoking remote method 'ai:inspectChoices': Error: missing-model"),
    );
    const wrapper = await mountApp(document.body);
    try {
      await openLocalDir(wrapper);
      await clickApiAndWait(wrapper);
      const title = wrapper.get<HTMLElement>(".request-heading [data-testid='ai-suggest-btn']");
      title.element.focus();
      await title.trigger("click");
      await vi.waitFor(() => expect(bodyFind("ai-open-case-settings")).not.toBeNull());
      expect(bodyFind("ai-config-body")).toBeNull();
      await expectBody("ai-open-case-settings").trigger("click");
      await vi.waitFor(() => expect(bodyFind("ai-settings-for-suggestion")).not.toBeNull());
      expect(inspect).toHaveBeenLastCalledWith(expect.objectContaining({ operation: "capture", input: expect.objectContaining({
        selection: expect.objectContaining({ business: expect.objectContaining({ purpose: "case-suggestion" }) }),
      }) }));
      await expectBody("ai-config-close").trigger("click");
      await flushPromises();
      expect(document.activeElement).toBe(title.element);

      vi.stubGlobal("innerWidth", 640);
      window.dispatchEvent(new Event("resize"));
      await flushPromises();
      expect(wrapper.find(".request-heading [data-testid='ai-suggest-btn']").exists()).toBe(false);
      const more = wrapper.get<HTMLElement>('[data-testid="request-more"]');
      await more.trigger("click");
      await expectBody("ai-suggest-btn").trigger("click");
      await vi.waitFor(() => expect(bodyFind("ai-open-case-settings")).not.toBeNull());
      expect(bodyFind("ai-config-body")).toBeNull();
      await expectBody("ai-open-case-settings").trigger("click");
      await vi.waitFor(() => expect(bodyFind("ai-settings-for-suggestion")).not.toBeNull());
      await expectBody("ai-config-close").trigger("click");
      await flushPromises();
      expect(document.activeElement).toBe(more.element);

      await subRadio(wrapper, "design").setValue(true);
      await flushPromises();
      const designTrigger = wrapper.get<HTMLElement>('[data-testid="design-panel"] [data-testid="ai-suggest-btn"]');
      await designTrigger.trigger("click");
      await vi.waitFor(() => expect(bodyFind("ai-open-case-settings")).not.toBeNull());
      expect(bodyFind("ai-config-body")).toBeNull();
      await expectBody("ai-open-case-settings").trigger("click");
      await vi.waitFor(() => expect(bodyFind("ai-settings-for-suggestion")).not.toBeNull());
      await expectBody("ai-config-close").trigger("click");
      await flushPromises();
      expect(document.activeElement).toBe(designTrigger.element);
      expect(inspect).toHaveBeenCalledTimes(3);

      await wrapper.get('[data-testid="settings-toggle"]').trigger("click");
      await expectBody("settings-ai").trigger("click");
      await vi.waitFor(() => expect(bodyFind("ai-config-body")).not.toBeNull());
      expect(bodyFind("ai-settings-for-suggestion")).toBeNull();
      await expectBody("ai-config-close").trigger("click");
      await flushPromises();
      expect(document.activeElement).toBe(wrapper.get('[data-testid="settings-toggle"]').element);
    } finally {
      vi.unstubAllGlobals();
      inspect.mockRestore();
    }
  });

  it("R7 后续 切换请求后迟到的 AI 缺模型结果不会打开设置", async () => {
    let rejectInspection!: (error: Error) => void;
    const inspection = new Promise<Awaited<ReturnType<typeof failingApi.aiInspectChoices>>>((_resolve, reject) => { rejectInspection = reject; });
    const inspect = vi.spyOn(failingApi, "aiInspectChoices").mockReturnValue(inspection);
    const wrapper = await mountApp(document.body);
    try {
      await openLocalDir(wrapper);
      await clickApiAndWait(wrapper);
      const tab = wrapper.getComponent(RequestEditor).props("requestTab");
      if (!tab) throw new Error("Expected API request tab");
      await wrapper.get('[data-testid="ai-suggest-btn"]').trigger("click");
      expect(inspect).toHaveBeenCalledOnce();
      await wrapper.get('[data-testid="request-tab-new-free"]').trigger("click");
      await vi.waitFor(() => expect(wrapper.getComponent(RequestEditor).props("requestTab")?.source.kind).toBe("free"));
      await wrapper.get(`[data-testid="request-tab-${tab.tabId}"]`).trigger("click");
      await clickApiAndWait(wrapper);
      rejectInspection(new Error("Error invoking remote method 'ai:inspectChoices': Error: missing-model"));
      await flushPromises();
      expect(bodyFind("ai-config-body")).toBeNull();
      expect(wrapper.getComponent(AiSuggestionsDrawer).props("ai").drawerOpen).toBe(false);
    } finally { inspect.mockRestore(); }
  });
  it("挂载缺省主页（无打开记录）；顶栏主页入口可见；主页视图不渲染 rail（用户裁定）", async () => {
    const wrapper = await mountApp();
    expect(wrapper.find('[data-testid="app-root"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="topbar"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="topbar-home"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="mode-badge"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="home-view"]').exists()).toBe(true);
    // 主页无 API 栏（M11 澄清①）——v-show 隐藏（组件常驻保状态），可见性断言
    expect(wrapper.find('[data-testid="side-tree"]').isVisible()).toBe(false);
    // 主页视图不渲染 rail（用户裁定 2026-09-09）：离开主页经项目打开/页签，不经 rail
    expect(wrapper.find('[data-testid="module-rail"]').exists()).toBe(false);
  });

  it("接口模块渲染：API 栏（树）+ 子视图页签（调试/设计）+ 调试子视图 上编辑器/分割条/下响应", async () => {
    const wrapper = await mountApp();
    await openLocalDir(wrapper);
    const side = wrapper.find('[data-testid="side-tree"]');
    expect(side.classes()).toContain("side-col");
    expect(side.isVisible()).toBe(true);
    expect(wrapper.find('[data-testid="sider-title"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="api-head"]').exists()).toBe(true);
    const split = wrapper.find('[data-testid="main-split"]');
    expect(split.exists()).toBe(true);
    expect(Array.from(split.element.children).map((el) => el.getAttribute("data-testid"))).toEqual(["api-head", "debug-split"]);
    const debugSplit = split.get('[data-testid="debug-split"]');
    expect(Array.from(debugSplit.element.children).map((el) => el.getAttribute("data-testid"))).toEqual(["editor-pane", "viewer-pane"]);
    const toggle = debugSplit.get('[data-testid="response-expand-toggle"]');
    expect(toggle.attributes("aria-expanded")).toBe("false");
    await toggle.trigger("click");
    expect(Array.from(debugSplit.element.children).map((el) => el.getAttribute("data-testid"))).toEqual(["editor-pane", "split-divider", "viewer-pane"]);
    const separator = debugSplit.get('[role="separator"]');
    expect(separator.attributes("aria-valuenow")).toBe("54");
    await separator.trigger("keydown", { key: "ArrowUp" });
    expect(separator.attributes("aria-valuenow")).toBe("59");
    await separator.trigger("keydown", { key: "End" });
    expect(separator.attributes("aria-valuenow")).toBe("70");
    await toggle.trigger("click");
    expect(debugSplit.find('[role="separator"]').exists()).toBe(false);
    await toggle.trigger("click");
    expect(debugSplit.get('[role="separator"]').attributes("aria-valuenow")).toBe("70");
    await debugSplit.get('[role="separator"]').trigger("keydown", { key: "Enter" });
    expect(debugSplit.get('[role="separator"]').attributes("aria-valuenow")).toBe("54");
  });

  it("R7 后续 收起和展开时共用响应历史入口，设计入口也保留筛选和回焦", async () => {
    const wrapper = await mountApp(document.body, { transition: false });
    await openLocalDir(wrapper);
    await clickApiAndWait(wrapper);
    const start = vi.spyOn(failingApi, "debugStart");
    const historyList = vi.spyOn(failingApi, "debugHistoryList");
    try {
      const history = wrapper.getComponent(DebugHistory);
      const trigger = wrapper.get<HTMLElement>('[data-testid="debug-history-open"]');
      for (const expanded of [false, true]) {
        const toggle = wrapper.get('[data-testid="response-expand-toggle"]');
        if (expanded) await toggle.trigger("click");
        expect(toggle.attributes("aria-expanded")).toBe(String(expanded));
        expect(wrapper.get('[data-testid="debug-history-open"]').element).toBe(trigger.element);
        trigger.element.focus();
        await trigger.trigger("click");
        await vi.waitFor(() => expect(bodyFind("debug-history")).not.toBeNull());
        expect(wrapper.getComponent(DebugHistory).props("history") === history.props("history")).toBe(true);
        await expectBody("debug-history-current-api").trigger("click");
        await expectBody("debug-history-filter").trigger("click");
        await flushPromises();
        expect(historyList).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: expect.any(String), apiId: expect.any(String) }));
        const close = new DOMWrapper(expectBody("debug-history").element.closest('[role="dialog"]')!).get<HTMLElement>(".ant-modal-close");
        close.element.focus();
        await close.trigger("keydown", { key: "Escape", keyCode: 27 });
        await vi.waitFor(() => expect(document.activeElement === trigger.element).toBe(true));
      }
      await subRadio(wrapper, "design").setValue(true);
      await flushPromises();
      const design = wrapper.get<HTMLElement>('[data-testid="debug-history-open"]');
      await design.trigger("click");
      await vi.waitFor(() => expect(bodyFind("debug-history")).not.toBeNull());
      expect(wrapper.getComponent(DebugHistory).props("history") === history.props("history")).toBe(true);
      await new DOMWrapper(expectBody("debug-history").element.closest('[role="dialog"]')!).get(".ant-modal-close").trigger("click");
      await vi.waitFor(() => expect(document.activeElement === design.element).toBe(true));
      expect(start).not.toHaveBeenCalled();
    } finally { start.mockRestore(); historyList.mockRestore(); }
  });

  it("R7 后续 仅已接受的前台发送展开响应，拒绝和后台结果不改变偏好", async () => {
    const wrapper = await mountApp(document.body);
    await openLocalDir(wrapper);
    await clickApiAndWait(wrapper);
    const tab = wrapper.getComponent(RequestEditor).props("requestTab");
    if (!tab) throw new Error("Expected API request tab");
    const toggle = () => wrapper.get('[data-testid="response-expand-toggle"]');
    const realStart = failingApi.debugStart.bind(failingApi);
    const realWait = failingApi.debugWait.bind(failingApi);
    const waitWithHttp = async (input: Parameters<typeof realWait>[0]) => {
      const result = await realWait(input);
      if (result.source.sourceKind !== "asset") return result;
      return { ...result, exchanges: [{
        source: { sourceKind: "asset" as const, case: { ...result.source.locator, caseId: "fixture-case", scope: "base" } },
        rowIndex: 0, hopIndex: 0, order: 1, transportState: "responded" as const,
        settings: { connectTimeoutMs: 1000, headersTimeoutMs: 1000, bodyTimeoutMs: 1000, totalTimeoutMs: 1000, followRedirects: false, maxRedirects: 0, uploadLimitBytes: 1024, responseLimitBytes: 1024 },
        response: { status: 200, headers: [], cookies: [], body: { kind: "text" as const, text: "ok", contentBytes: 2, truncated: false } },
        startedAt: result.startedAt,
      }], exchangeTotal: 1 };
    };
    const start = vi.spyOn(failingApi, "debugStart").mockRejectedValueOnce(new Error("preflight request rejected"));
    const wait = vi.spyOn(failingApi, "debugWait").mockImplementation(waitWithHttp);
    try {
      expect(toggle().attributes("aria-expanded")).toBe("false");
      await wrapper.get('[data-testid="request-send-slot"]').trigger("click");
      await vi.waitFor(() => expect(wrapper.get('[data-testid="response-compact-status"]').text()).toBe("preflight request rejected"));
      expect(toggle().attributes("aria-expanded")).toBe("false");
      expect(wait).not.toHaveBeenCalled();

      let acceptForeground!: () => void;
      let finishForeground!: () => void;
      const foregroundStart = new Promise<void>((resolve) => { acceptForeground = resolve; });
      const foregroundWait = new Promise<void>((resolve) => { finishForeground = resolve; });
      start.mockImplementationOnce(async (input) => { await foregroundStart; return realStart(input); });
      wait.mockImplementationOnce(async (input) => { await foregroundWait; return waitWithHttp(input); });
      await wrapper.get('[data-testid="request-send-slot"]').trigger("click");
      expect(toggle().attributes("aria-expanded")).toBe("false");
      expect(wrapper.get('[data-testid="request-send-slot"]').attributes("aria-busy")).toBe("true");
      acceptForeground();
      await vi.waitFor(() => expect(toggle().attributes("aria-expanded")).toBe("true"));
      expect(wrapper.find('[data-testid="debug-cancel"]').exists()).toBe(true);
      await toggle().trigger("click");
      finishForeground();
      await vi.waitFor(() => expect(wrapper.get('[data-testid="response-status"]').text()).toBe("HTTP 200"));
      expect(toggle().attributes("aria-expanded")).toBe("false");
      expect(wrapper.find('[data-testid="response-tab-body"]').isVisible()).toBe(false);

      let acceptBackground!: () => void;
      const backgroundStart = new Promise<void>((resolve) => { acceptBackground = resolve; });
      start.mockImplementationOnce(async (input) => { await backgroundStart; return realStart(input); });
      await wrapper.get('[data-testid="request-send-slot"]').trigger("click");
      await wrapper.get('[data-testid="request-tab-new-free"]').trigger("click");
      await vi.waitFor(() => expect(wrapper.getComponent(RequestEditor).props("requestTab")?.source.kind).toBe("free"));
      acceptBackground();
      await vi.waitFor(() => expect(wait).toHaveBeenCalledTimes(2));
      expect(toggle().attributes("aria-expanded")).toBe("false");
      await wrapper.get(`[data-testid="request-tab-${tab.tabId}"]`).trigger("click");
      await vi.waitFor(() => expect(wrapper.getComponent(RequestEditor).props("requestTab")?.tabId).toBe(tab.tabId));
      expect(toggle().attributes("aria-expanded")).toBe("false");
      expect(wrapper.get('[data-testid="response-status"]').text()).toBe("HTTP 200");
    } finally { start.mockRestore(); wait.mockRestore(); }
  });

  it("R7 固定发送槽按请求签取消，离开和返回同一次运行也不会重复取消", async () => {
    const wrapper = await mountApp(document.body);
    await openLocalDir(wrapper);
    await clickApiAndWait(wrapper);
    const editorComponent = wrapper.getComponent(RequestEditor);
    const debug = editorComponent.props("debug") as ReturnType<typeof useDebugStore>;
    const tabA = editorComponent.props("requestTab") as RequestTab;
    const stateA = debug.requestTabState(tabA);
    let resolveCancellation!: (result: Awaited<ReturnType<typeof failingApi.debugCancel>>) => void;
    const cancelReply = new Promise<Awaited<ReturnType<typeof failingApi.debugCancel>>>((resolve) => { resolveCancellation = resolve; });
    const cancel = vi.spyOn(failingApi, "debugCancel").mockReturnValue(cancelReply);
    try {
      debug.activeRunId = "legacy-other-request";
      debug.sending = true;
      stateA.sending = true;
      await flushPromises();
      const slot = wrapper.get<HTMLButtonElement>('[data-testid="request-send-slot"]');
      slot.element.focus();
      expect(slot.attributes("aria-disabled")).toBe("true");
      expect(slot.find('[data-testid="debug-cancel"]').exists()).toBe(false);
      await slot.trigger("click");
      expect(cancel).not.toHaveBeenCalled();

      stateA.activeRunId = "asset-run";
      await flushPromises();
      expect(wrapper.get('[data-testid="request-send-slot"]').element).toBe(slot.element);
      expect(document.activeElement).toBe(slot.element);
      await slot.get('[data-testid="debug-cancel"]').trigger("click");
      expect(cancel).toHaveBeenCalledExactlyOnceWith({ runId: "asset-run" });
      await wrapper.get('[data-testid="request-tab-new-free"]').trigger("click");
      await flushPromises();
      expect(wrapper.get('[data-testid="request-send-slot"]').attributes("aria-disabled")).toBe("false");
      await wrapper.get(`[data-testid="request-tab-${tabA.tabId}"]`).trigger("click");
      await flushPromises();
      const returnedSlot = wrapper.get('[data-testid="request-send-slot"]');
      expect(returnedSlot.attributes("aria-disabled")).toBe("true");
      await returnedSlot.trigger("click");
      resolveCancellation({ status: "cancelled" });
      await flushPromises();
      expect(returnedSlot.attributes("aria-disabled")).toBe("true");
      await returnedSlot.trigger("click");
      expect(cancel).toHaveBeenCalledTimes(1);
      stateA.sending = false;
      stateA.activeRunId = null;
      await flushPromises();
      expect(wrapper.find('[data-testid="send-btn"]').exists()).toBe(true);
    } finally {
      resolveCancellation({ status: "no-active" });
      cancel.mockRestore();
    }
  });

  it("R7 切换请求签收回协议菜单和保存反馈，旧操作不改变当前请求", async () => {
    const wrapper = await mountApp();
    await openLocalDir(wrapper);
    await clickApiAndWait(wrapper);
    const editorComponent = wrapper.getComponent(RequestEditor);
    const editor = editorComponent.props("editor") as ReturnType<typeof useEditorStore>;
    const tabA = editorComponent.props("requestTab") as RequestTab;
    let rejectSave!: (reason: Error) => void;
    const saveReply = new Promise<Awaited<ReturnType<typeof editor.save>>>((_resolve, reject) => { rejectSave = reject; });
    const save = vi.spyOn(editor, "save").mockReturnValue(saveReply);
    try {
      await wrapper.get('[data-testid="save-btn"]').trigger("click");
      expect(save).toHaveBeenCalledOnce();
      await wrapper.get('[data-testid="editor-protocol"]').trigger("click");
      const staleSoap = expectBody("request-protocol-soap");
      await wrapper.get('[data-testid="request-tab-new-free"]').trigger("click");
      await flushPromises();
      expect(bodyFind("request-protocol-soap")).toBeNull();
      await staleSoap.trigger("click");
      expect(editor.activeFreeSession?.request.protocol).toBe("http");
      rejectSave(new Error("asset A late save"));
      await flushPromises();
      expect(wrapper.find('[data-testid="save-error"]').exists()).toBe(false);
      await wrapper.get(`[data-testid="request-tab-${tabA.tabId}"]`).trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-testid="save-error"]').exists()).toBe(false);
      expect(editor.api?.contract.request.protocol).toBe("http");
    } finally {
      save.mockRestore();
    }
  });

  it("目录空项目首存默认模块，取消无写入，改名后复用同一模块", async () => {
    const wrapper = await mountApp(document.body);
    await openLocalDir(wrapper);
    const original = await failingApi.treeGet();
    const group = original.children?.find((node) => node.kind === "group");
    if (group?.kind !== "group") throw new Error("Expected a fixture group");
    const created = await realNodeCreate({ kind: "project", parent: group.locator, name: "Directory first save" });
    if (created.kind !== "project") throw new Error("Expected a fixture project");
    const workspace = wrapper.getComponent(SideTree).props("workspace") as ReturnType<typeof useWorkspaceStore>;
    const collection = () => workspace.findProject(created.locator)?.children.find((node) => node.kind === "collection");
    try {
      await workspace.refresh();
      await wrapper.get('[data-testid="topbar-home"]').trigger("click");
      await wrapper.get(`[data-testid="project-card-${created.id}"]`).trigger("click");
      const startDraft = async () => {
        await vi.waitFor(() => expect(wrapper.find('[data-testid="directory-create"]').isVisible()).toBe(true));
        await wrapper.get('[data-testid="directory-create"]').trigger("click");
        await expectBody("new-api").trigger("click");
        await vi.waitFor(() => expect(wrapper.find('[data-testid="editor-full-url"]').exists()).toBe(true));
      };
      await startDraft();
      expect(wrapper.get('.request-path').text()).toBe("尚未选择保存位置");
      await wrapper.get('[data-testid="editor-full-url"]').setValue("https://example.test/first");
      await wrapper.get('[data-testid="save-free-btn"]').trigger("click");
      expect(expectBody("free-save-target").text()).toContain("未分类接口（默认）");
      await expectBody("free-save-name").setValue("First API");
      await expectBody("free-save-cancel").trigger("click");
      expect(collection()).toBeUndefined();
      await submitNewApiDraft(wrapper, "First API");
      await vi.waitFor(() => expect(wrapper.get('[data-testid="tree-default-collection"]').text()).toBe("默认"));
      expect(wrapper.get('.request-path').text()).toBe("未分类接口");
      const initial = collection();
      if (initial?.kind !== "collection") throw new Error("Expected the persisted default module");
      const row = wrapper.get('[data-testid="tree-container-row"]');
      await row.get('[data-testid="tree-more"]').trigger("click");
      const openedMenu = new DOMWrapper(document.body).get('[data-menu-owner="tree-more"]');
      await openedMenu.get('[data-testid="node-rename"]').trigger("click");
      await expectBody("dialog-input").setValue("Renamed intake");
      await expectBody("dialog-confirm").trigger("click");
      await vi.waitFor(() => expect(wrapper.get('.request-path').text()).toBe("Renamed intake"));
      await startDraft();
      await wrapper.get('[data-testid="save-free-btn"]').trigger("click");
      expect(expectBody("free-save-target").text()).toContain("Renamed intake（默认）");
      await expectBody("free-save-name").setValue("Second API");
      await expectBody("free-save-submit").trigger("click");
      await vi.waitFor(() => expect(collection()?.children).toHaveLength(2));
      expect(collection()?.id).toBe(initial.id);
      const bridge = initI18n().i18n.global;
      await vi.waitFor(() => expect(wrapper.get('[data-testid="save-feedback"]').text()).toContain("保存"));
      const language = bridge.locale.value;
      try {
        bridge.locale.value = "en";
        await vi.waitFor(() => expect(wrapper.get('[data-testid="save-feedback"]').text()).toContain("API saved"));
      } finally { bridge.locale.value = language; }
    } finally {
      await failingApi.nodeDelete({ kind: "project", locator: created.locator });
    }
  });

  it("目录删掉预选嵌套容器后保留草稿，经显式重读和重新选择保存", async () => {
    const wrapper = await mountApp(document.body);
    await openLocalDir(wrapper);
    const workspace = wrapper.getComponent(SideTree).props("workspace") as ReturnType<typeof useWorkspaceStore>;
    const original = await failingApi.treeGet();
    const project = projectByLabel(original, "示例项目");
    const container = project.children.find(node => node.kind === "collection");
    if (container?.kind !== "collection") throw new Error("Expected fixture collection");
    const created = await realNodeCreate({ kind: "folder", parent: container.locator, name: "Directory deleted target" });
    if (created.kind !== "folder") throw new Error("Expected fixture folder");
    const save = vi.spyOn(failingApi, "apiCreateFromRequestDraft");
    let saved: Awaited<ReturnType<ApiccApi["apiCreateFromRequestDraft"]>> | undefined;
    try {
      await workspace.refresh();
      await expandAllCollapsedTreeContainers(wrapper);
      await openNewApiFromContainer(wrapper, created.label);
      expect(wrapper.get(".request-path").text()).toBe(`${container.label} / ${created.label}`);
      await failingApi.nodeDelete({ kind: "folder", locator: created.locator });
      await submitNewApiDraft(wrapper, "After deleted target");
      await vi.waitFor(() => expect(bodyFind("free-save-error")?.text()).toContain("原保存位置已不可用"));
      expect(save).toHaveBeenCalledTimes(1);
      expect(wrapper.get('[data-testid="editor-full-url"]').element.getAttribute("value")).toBe("https://example.test/directory-draft");
      expect(expectBody("free-save-name").element.getAttribute("value")).toBe("After deleted target");
      await expectBody("free-save-reload-targets").trigger("click");
      await vi.waitFor(() => expect(bodyFind("free-save-reload-targets")?.isVisible()).not.toBe(true));
      expect((expectBody("free-save-submit").element as HTMLButtonElement).disabled).toBe(true);
      chooseAppSelect(wrapper, "free-save-target", JSON.stringify(container.locator));
      await flushPromises();
      await expectBody("free-save-submit").trigger("click");
      await vi.waitFor(() => expect(wrapper.find('[data-testid="request-editor"]').attributes("data-source-kind")).toBe("asset"));
      expect(save).toHaveBeenCalledTimes(2);
      saved = await save.mock.results[1]?.value;
      expect(saved?.locator).toMatchObject({ ...container.locator, folderIds: [] });
      expect(wrapper.get(".request-path").text()).toBe(container.label);
    } finally {
      save.mockRestore();
      if (saved) await failingApi.nodeDelete({ kind: "api", locator: saved.locator });
      if (workspace.findProject(project.locator)?.children.some(node => node.kind === "collection" && node.children.some(child => child.id === created.id))) {
        await failingApi.nodeDelete({ kind: "folder", locator: created.locator }).catch(() => undefined);
      }
    }
  });

  it("目录项目操作在刷新失败后仍更新、关闭准确项目签并保留其他项目选择", async () => {
    const wrapper = await mountApp(document.body);
    await openLocalDir(wrapper);
    const workspace = wrapper.getComponent(SideTree).props("workspace") as ReturnType<typeof useWorkspaceStore>;
    const original = await failingApi.treeGet();
    const project = projectByLabel(original, "示例项目");
    const other = await realNodeCreate({ kind: "project", parent: { workspaceId: project.locator.workspaceId, groupId: project.locator.groupId }, name: "Directory project operations" });
    if (other.kind !== "project") throw new Error("Expected fixture project");
    const secondCollection = await realNodeCreate({ kind: "collection", parent: project.locator, name: "Second directory collection" });
    if (secondCollection.kind !== "collection") throw new Error("Expected a second collection");
    const secondApi = await realNodeCreate({ kind: "api", parent: secondCollection.locator, api: { name: "Second directory API", protocol: "http" } });
    let removed = false;
    try {
      await workspace.refresh();
      await clickApiAndWait(wrapper);
      const originalTab = wrapper.getComponent(RequestEditor).props("requestTab") as RequestTab;
      await expandAllCollapsedTreeContainers(wrapper);
      await wrapper.get(`[data-testid="tree-api"][data-node-id="${secondApi.id}"]`).trigger("click");
      await vi.waitFor(() => expect(wrapper.getComponent(RequestEditor).props("requestTab")?.tabId).not.toBe(originalTab.tabId));
      await wrapper.get(`[data-testid="request-tab-${originalTab.tabId}"]`).trigger("click");
      await vi.waitFor(() => expect(wrapper.getComponent(RequestEditor).props("requestTab")?.tabId).toBe(originalTab.tabId));
      await wrapper.get('[data-testid="topbar-home"]').trigger("click");
      await wrapper.get(`[data-testid="project-card-${other.id}"]`).trigger("click");
      await vi.waitFor(() => expect(wrapper.get('[data-testid="project-tab-1"]').attributes("aria-selected")).toBe("true"));
      await wrapper.get('[data-testid="project-tab-0"]').trigger("click");
      await vi.waitFor(() => expect(wrapper.getComponent(RequestEditor).props("requestTab")?.tabId).toBe(originalTab.tabId));
      expect(wrapper.get('.node.selected [data-testid="tree-api"]').attributes("data-node-id")).not.toBe(secondApi.id);
      await wrapper.get('[data-testid="tree-search"]').setValue("示例集合");
      const container = wrapper.get('[data-testid="tree-container-row"]');
      await container.get('.row-title').trigger("click");
      await workspace.refresh();
      await wrapper.get('[data-testid="topbar-home"]').trigger("click");
      await wrapper.get(`[data-testid="project-card-${other.id}"]`).trigger("click");
      await vi.waitFor(() => expect(wrapper.get('[data-testid="project-tab-1"]').attributes("aria-selected")).toBe("true"));
      expect((wrapper.get('[data-testid="tree-search"]').element as HTMLInputElement).value).toBe("");
      await wrapper.get('[data-testid="project-tab-0"]').trigger("click");
      await vi.waitFor(() => expect(wrapper.get('[data-testid="project-tab-0"]').attributes("aria-selected")).toBe("true"));
      expect((wrapper.get('[data-testid="tree-search"]').element as HTMLInputElement).value).toBe("示例集合");
      expect(wrapper.get('[data-testid="tree-container-row"]').classes()).toContain("selected");
      await wrapper.get('[data-testid="project-tab-1"]').trigger("click");
      await vi.waitFor(() => expect(wrapper.get('[data-testid="directory-project-more"]').attributes("aria-label")).toContain(other.label));
      const openProjectMenu = () => wrapper.get('[data-testid="directory-project-more"]').trigger("click");
      const refresh = vi.spyOn(workspace, "refresh").mockRejectedValue(new Error("injected directory refresh"));
      try {
        await openProjectMenu();
        await expectBody("directory-project-rename").trigger("click");
        await expectBody("dialog-input").setValue("Directory project renamed");
        await expectBody("dialog-confirm").trigger("click");
        await vi.waitFor(() => expect(wrapper.get('[data-testid="project-tab-1"]').text()).toContain("Directory project renamed"));
        await vi.waitFor(() => expect(wrapper.get('[data-testid="app-error"]').text()).toContain("项目更改已保存"));
        await openProjectMenu();
        await expectBody("directory-project-delete").trigger("click");
        await expectBody("dialog-cancel").trigger("click");
        expect(wrapper.find('[data-testid="project-tab-1"]').exists()).toBe(true);
        await openProjectMenu();
        await expectBody("directory-project-delete").trigger("click");
        await expectBody("dialog-confirm").trigger("click");
        await vi.waitFor(() => expect(wrapper.find('[data-testid="project-tab-1"]').exists()).toBe(false));
        removed = true;
      } finally { refresh.mockRestore(); }
      await vi.waitFor(() => expect(wrapper.get('[data-testid="project-tab-0"]').attributes("aria-selected")).toBe("true"));
      expect(wrapper.get('[data-testid="tree-container-row"]').classes()).toContain("selected");
      const requestTabs = wrapper.getComponent(RequestTabs).props("tabs") as ReturnType<typeof createRequestTabsStore>;
      for (const id of [...requestTabs.order]) await wrapper.get(`[data-testid="request-tab-close-${id}"]`).trigger("click");
      await vi.waitFor(() => expect(requestTabs.order).toHaveLength(0));
      await wrapper.get('[data-testid="rail-run"]').trigger("click");
      const third = await realNodeCreate({ kind: "project", parent: { workspaceId: project.locator.workspaceId, groupId: project.locator.groupId }, name: "Directory view checkpoint" });
      if (third.kind !== "project") throw new Error("Expected another fixture project");
      try {
        await workspace.refresh();
        await wrapper.get('[data-testid="topbar-home"]').trigger("click");
        await wrapper.get(`[data-testid="project-card-${third.id}"]`).trigger("click");
        await vi.waitFor(() => expect(wrapper.get('[data-testid="project-tab-1"]').attributes("aria-selected")).toBe("true"));
        expect(wrapper.get('[data-testid="rail-run"]').attributes("aria-current")).toBe("page");
        await wrapper.get('[data-testid="project-tab-0"]').trigger("click");
        await vi.waitFor(() => expect(requestTabs.order).toHaveLength(1));
        expect(wrapper.get('[data-testid="rail-run"]').attributes("aria-current")).toBe("page");
      } finally { await failingApi.nodeDelete({ kind: "project", locator: third.locator }); }
    } finally {
      if (!removed) await failingApi.nodeDelete({ kind: "project", locator: other.locator }).catch(() => undefined);
      await failingApi.nodeDelete({ kind: "collection", locator: secondCollection.locator });
    }
  });

  it("当前项目可打开 free 请求签并用完整 URL 保留重复 query 顺序发送", async () => {
    const wrapper = await mountApp();
    await openLocalDir(wrapper);
    const name = "空模块 free 请求项目";
    const previousNodeCreate = failingApi.nodeCreate;
    const previousOAuthProfilesGet = failingApi.oauthProfilesGet;
    const profileReads: Parameters<ApiccApi["oauthProfilesGet"]>[0][] = [];
    failingApi.oauthProfilesGet = async (input) => {
      profileReads.push(input);
      return { revision: "free-app-revision", profiles: [] };
    };
    let projectLocator: ProjectLocator | null = null;
    try {
      const rootTree = await failingApi.treeGet();
      const group = rootTree.children!.find((node) => node.kind === "group");
      if (!group || group.kind !== "group") throw new Error("Memory workspace is missing its group");
      failingApi.nodeCreate = realNodeCreate;
      try {
        const created = await failingApi.nodeCreate({ kind: "project", parent: group.locator, name });
        if (created.kind !== "project") throw new Error("Memory API did not create the empty project");
        projectLocator = created.locator;
        await failingApi.envCreate({ locator: created.locator, name: "free-oauth-env" });
      } finally {
        failingApi.nodeCreate = previousNodeCreate;
      }
      const projectTree = projectByLabel(await failingApi.treeGet(), name);
      expect(projectTree.children ?? []).toEqual([]);

      const workspace = wrapper.findComponent(SideTree).props("workspace") as ReturnType<typeof useWorkspaceStore>;
      await workspace.refresh();
      await wrapper.find('[data-testid="topbar-home"]').trigger("click");
      await flushPromises();
      const projectCard = wrapper.findAll('[data-testid^="project-card-"]').find((candidate) => candidate.text().includes(name));
      if (!projectCard) throw new Error("Empty project was not rendered on HomeView");
      await projectCard.trigger("click");
      await vi.waitFor(() => expect(wrapper.findAll('[data-testid^="project-tab-"]').some((tab) => tab.text().includes(name))).toBe(true));
      await vi.waitFor(() => expect(wrapper.find('[data-testid="request-tab-new-free"]').isVisible()).toBe(true));
      await wrapper.get('[data-testid="request-tab-new-free"]').trigger("click");
      await flushPromises();
      await flushPromises();

      const requestEditor = wrapper.findComponent(RequestEditor);
      const editor = requestEditor.props("editor") as ReturnType<typeof useEditorStore>;
      const debug = requestEditor.props("debug") as ReturnType<typeof useDebugStore>;
      expect(editor.activeFreeSession).toBeTruthy();
      expect(editor.activeFreeSession?.project).toEqual(projectLocator);
      expect(editor.api).toBeNull();
      expect(requestEditor.attributes("data-source-kind")).toBe("free");
      expect(wrapper.find('[data-testid="save-free-btn"]').exists()).toBe(true);
      expect((wrapper.find('[data-testid="save-free-btn"]').element as HTMLButtonElement).disabled).toBe(false);
      const currentTab = requestEditor.props("requestTab") as RequestTab;
      const freeEnvironment = editor.activeFreeSession!.envs.find((item) => item.name === "free-oauth-env");
      if (!freeEnvironment) throw new Error("Free request context did not load its project environment");
      debug.requestTabState(currentTab).selectedEnvironmentId = freeEnvironment.id;
      await flushPromises();
      const oauthManager = requestEditor.findComponent(OAuthManager);
      expect(oauthManager.exists()).toBe(true);
      expect(typeof oauthManager.props("api").oauthProfilesGet).toBe("function");
      expect(oauthManager.props("locator")).toEqual(projectLocator);
      expect(oauthManager.props("environmentId")).toBe(freeEnvironment.id);
      expect(JSON.parse(oauthManager.props("contextKey"))).toMatchObject({
        root: currentTab.root,
        project: projectLocator,
        tabId: currentTab.tabId,
        generation: currentTab.generation,
        environmentId: freeEnvironment.id,
        bearerRef: null,
      });
      expect(profileReads.length).toBeGreaterThan(0);
      expect(profileReads.every((input) => JSON.stringify(input.locator) === JSON.stringify(projectLocator))).toBe(true);
      expect(profileReads.at(-1)).toEqual({ locator: projectLocator, environmentId: freeEnvironment.id });

      const input = wrapper.get('[data-testid="editor-full-url"]');
      await input.setValue("https://example.test/a%20b?x=1&x=two+words&encoded=%2F");
      await flushPromises();
      expect(wrapper.find('[data-testid="editor-base-url"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="editor-path"]').exists()).toBe(false);
      const session = editor.activeFreeSession!;
      expect(session.request).toMatchObject({ baseUrl: "https://example.test", path: "/a%20b" });
      expect(session.request.query.filter((item) => item.kind === "inline").map((item) => [item.name, item.value])).toEqual([
        ["x", "1"], ["x", "two words"], ["encoded", "/"],
      ]);
      expect(session.urlDraft).toBe("https://example.test/a%20b?x=1&x=two%20words&encoded=%2F");

      await wrapper.get(`[data-testid="request-tab-close-${currentTab.tabId}"]`).trigger("click");
      await flushPromises();
      expect(document.body.textContent ?? "").toContain("此请求页签");
      expect(document.body.textContent ?? "").not.toContain("此项目有未保存");
      await expectBody("dialog-cancel").trigger("click");
      await flushPromises();

      await wrapper.get('[data-testid="tab-query"]').trigger("click");
      await flushPromises();
      const queryValues = wrapper.findAll('[data-testid="kv-value"]');
      await queryValues[0]!.setValue("updated value");
      await flushPromises();
      expect(session.request.query.filter((item) => item.kind === "inline").map((item) => [item.name, item.value])).toEqual([
        ["x", "updated value"], ["x", "two words"], ["encoded", "/"],
      ]);
      expect(session.urlDraft).toBe("https://example.test/a%20b?x=updated%20value&x=two%20words&encoded=%2F");

      let captured: DebugInvocation | undefined;
      const originalDebugStart = failingApi.debugStart;
      failingApi.debugStart = async (invocation) => {
        captured = invocation;
        return originalDebugStart(invocation);
      };
      try {
        await wrapper.get('[data-testid="send-btn"]').trigger("click");
        await flushPromises();
      } finally {
        failingApi.debugStart = originalDebugStart;
      }
      expect(captured).toMatchObject({ mode: "free", request: { query: [
        { name: "x", value: "updated value" }, { name: "x", value: "two words" }, { name: "encoded", value: "/" },
      ] } });
      const tabState = Object.values(debug.requestTabs).find((state) => state.result?.mode === "free");
      expect(tabState?.result?.source).toMatchObject({ sourceKind: "free", project: projectLocator });
      const freeDebugState = debug.requestTabs[session.tabId]!;
      freeDebugState.settings = { totalTimeoutMs: 4321 };
      freeDebugState.parameters = { retainedParameter: "kept" };
      const freeScroll = wrapper.get<HTMLElement>('[data-testid="request-editor-scroll"]');
      freeScroll.element.scrollTop = 77;
      await freeScroll.trigger("scroll");
      expect(freeDebugState.requestScrollTop).toBe(77);

      await wrapper.get('[data-testid="save-free-btn"]').trigger("click");
      await flushPromises();
      expect(bodyFind("free-save-needs-module")).not.toBeNull();
      const originalFreeTabValue = requestEditor.props("requestTab") as { tabId: string; generation: number };
      const originalFreeTab = { tabId: originalFreeTabValue.tabId, generation: originalFreeTabValue.generation };
      await expectBody("free-save-name").setValue("Saved full URL request");
      await expectBody("free-save-module-name").setValue("Free destination");
      expect((expectBody("free-save-module-name").element as HTMLInputElement).value).toBe("Free destination");
      expect((expectBody("free-save-create-module").element as HTMLButtonElement).disabled).toBe(false);
      const createModule = vi.fn(realNodeCreate);
      failingApi.nodeCreate = createModule;
      try {
        await expectBody("free-save-create-module").trigger("click");
        await flushPromises();
        await flushPromises();
      } finally {
        failingApi.nodeCreate = previousNodeCreate;
      }
      expect(createModule).toHaveBeenCalledExactlyOnceWith({ kind: "collection", parent: projectLocator, name: "Free destination" });
      const createdModule = await createModule.mock.results[0]?.value;
      expect(createdModule).toMatchObject({ kind: "collection", label: "Free destination", locator: { ...projectLocator } });
      const freeSaveError = bodyFind("free-save-error");
      if (freeSaveError) throw new Error(`创建 Free 保存模块失败：${freeSaveError.text()}`);
      const createdProjectTree = projectByLabel(await failingApi.treeGet(), name);
      expect(createdProjectTree.children?.some((node) => node.kind === "collection" && node.label === "Free destination"),
        JSON.stringify(createdProjectTree.children?.map((node) => ({ kind: node.kind, label: node.label, locator: node.locator })))).toBe(true);
      expect(requestEditor.props("requestTab")).toMatchObject({ ...originalFreeTab, tabId: session.tabId, source: { kind: "free" } });

      expect(bodyFind("free-save-name")).not.toBeNull();
      await vi.waitFor(() => expect((expectBody("free-save-submit").element as HTMLButtonElement).disabled,
        `${expectBody("free-save-target").text()} ${bodyFind("free-save-target-missing")?.text() ?? ""}`).toBe(false));
      await expectBody("free-save-submit").trigger("click");
      await flushPromises();
      await flushPromises();
      const finalFreeSaveError = bodyFind("free-save-error");
      if (finalFreeSaveError) throw new Error(`有效 URL 保存被拒绝：${finalFreeSaveError.text()}`);
      await vi.waitFor(() => expect(wrapper.findComponent(RequestEditor).attributes("data-source-kind")).toBe("asset"));

      const convertedRequestEditor = wrapper.findComponent(RequestEditor);
      expect(convertedRequestEditor.attributes("data-source-kind")).toBe("asset");
      expect(editor.activeFreeSession).toBeNull();
      expect(editor.api).not.toBeNull();
      expect(editor.api!.contract.request.query.filter((item) => item.kind === "inline").map((item) => [item.name, item.value])).toEqual([
        ["x", "updated value"], ["x", "two words"], ["encoded", "/"],
      ]);
      expect(debug.requestTabs[session.tabId]).toMatchObject({
        generation: (convertedRequestEditor.props("requestTab") as { generation: number }).generation,
        result: { mode: "free" },
        settings: { totalTimeoutMs: 4321 },
        parameters: { retainedParameter: "kept" },
        requestScrollTop: 77,
      });
      const assetScroll = wrapper.get<HTMLElement>('[data-testid="request-editor-scroll"]');
      expect(assetScroll.element).not.toBe(freeScroll.element);
      expect(assetScroll.element.scrollTop).toBe(77);
      freeScroll.element.scrollTop = 123;
      await freeScroll.trigger("scroll");
      expect(freeDebugState.requestScrollTop).toBe(77);
      expect(convertedRequestEditor.find('[data-testid="save-btn"]').exists()).toBe(true);
      expect(convertedRequestEditor.find('[data-testid="save-feedback"]').text()).toContain("目标模块继承");
      expect(convertedRequestEditor.find('[data-testid="send-btn"]').exists()).toBe(true);
      expect(convertedRequestEditor.find('[data-testid="debug-case-select"]').exists()).toBe(true);
      const baseCase = editor.api!.cases[0];
      if (!baseCase) throw new Error("保存后的正式接口缺少默认用例入口");
      chooseAppSelect(convertedRequestEditor, "debug-case-select", JSON.stringify([baseCase.id, baseCase.scope]));
      expect(debug.requestTabs[session.tabId]?.selectedCase).toEqual({ caseId: baseCase.id, scope: baseCase.scope });

      let formalSend: DebugInvocation | undefined;
      const previousDebugStart = failingApi.debugStart;
      failingApi.debugStart = async (invocation) => {
        formalSend = invocation;
        return previousDebugStart(invocation);
      };
      try {
        await convertedRequestEditor.get('[data-testid="send-btn"]').trigger("click");
        await flushPromises();
      } finally {
        failingApi.debugStart = previousDebugStart;
      }
      expect(formalSend).toMatchObject({ mode: "request", locator: editor.locator, request: { query: [
        { name: "x", value: "updated value" }, { name: "x", value: "two words" }, { name: "encoded", value: "/" },
      ] } });
      const convertedRequestTab = convertedRequestEditor.props("requestTab") as { tabId: string; generation: number; source: { kind: string } };
      expect(convertedRequestTab.tabId).toBe(originalFreeTab.tabId);
      expect(convertedRequestTab.generation).toBeGreaterThan(originalFreeTab.generation);
      const convertedTab = convertedRequestTab.source;
      expect(convertedTab.kind).toBe("asset");
    } finally {
      failingApi.nodeCreate = previousNodeCreate;
      failingApi.oauthProfilesGet = previousOAuthProfilesGet;
      if (projectLocator) await failingApi.nodeDelete({ kind: "project", locator: projectLocator }).catch(() => undefined);
    }
  });

  it("无效 Free URL 不保存；保存等待期间 URL 改变时保留原 free 草稿", async () => {
    const wrapper = await mountApp();
    await openLocalDir(wrapper);
    const name = "Free URL pending guard";
    const previousNodeCreate = failingApi.nodeCreate;
    let projectLocator: ProjectLocator | null = null;
    let targetParent: ApiParentLocator | null = null;
    try {
      const rootTree = await failingApi.treeGet();
      const group = rootTree.children!.find((node) => node.kind === "group");
      if (!group || group.kind !== "group") throw new Error("Memory workspace is missing its group");
      failingApi.nodeCreate = realNodeCreate;
      try {
        const createdProject = await failingApi.nodeCreate({ kind: "project", parent: group.locator, name });
        if (createdProject.kind !== "project") throw new Error("Memory API did not create the Free URL fixture project");
        projectLocator = createdProject.locator;
        const createdModule = await failingApi.nodeCreate({ kind: "collection", parent: createdProject.locator, name: "Destination" });
        if (createdModule.kind !== "collection") throw new Error("Memory API did not create the destination module");
        targetParent = createdModule.locator;
      } finally {
        failingApi.nodeCreate = previousNodeCreate;
      }

      const workspace = wrapper.findComponent(SideTree).props("workspace") as ReturnType<typeof useWorkspaceStore>;
      await workspace.refresh();
      await wrapper.get('[data-testid="topbar-home"]').trigger("click");
      await flushPromises();
      const projectCard = wrapper.findAll('[data-testid^="project-card-"]').find((candidate) => candidate.text().includes(name));
      if (!projectCard) throw new Error("Free URL fixture project was not rendered on HomeView");
      await projectCard.trigger("click");
      await vi.waitFor(() => expect(wrapper.findAll('[data-testid^="project-tab-"]').some((tab) => tab.text().includes(name))).toBe(true));
      await flushPromises();
      await wrapper.get('[data-testid="request-tab-new-free"]').trigger("click");
      await flushPromises();
      await flushPromises();

      const requestEditor = wrapper.findComponent(RequestEditor);
      const editor = requestEditor.props("editor") as ReturnType<typeof useEditorStore>;
      const session = editor.activeFreeSession;
      if (!session || !projectLocator || !targetParent) throw new Error("Free URL fixture session was not initialized");
      const tab = requestEditor.props("requestTab") as { tabId: string; generation: number };
      const input = wrapper.get('[data-testid="editor-full-url"]');
      await input.setValue("https://example.test/pending?value=original");
      await flushPromises();
      const validUrlDraft = session.urlDraft;
      await wrapper.get('[data-testid="save-free-btn"]').trigger("click");
      await flushPromises();
      await vi.waitFor(() => expect(bodyFind("free-save-target")).not.toBeNull());
      chooseAppSelect(wrapper, "free-save-target", JSON.stringify(targetParent));
      await expectBody("free-save-name").setValue("Pending URL draft");

      await input.setValue("not a full URL");
      await flushPromises();
      expect(session.urlDraftInvalid).toBe(true);
      const saveFreeRequest = requestEditor.props("saveFreeRequest");
      if (!saveFreeRequest) throw new Error("Free save callback was not provided");
      const originalCreateFromDraft = failingApi.apiCreateFromRequestDraft.bind(failingApi);
      const createFromDraft = vi.fn(originalCreateFromDraft);
      failingApi.apiCreateFromRequestDraft = createFromDraft;
      try {
        await expect(saveFreeRequest(tab as never, targetParent, "Invalid URL draft", session.request, []))
          .rejects.toThrow();
        expect(createFromDraft).not.toHaveBeenCalled();
      } finally {
        failingApi.apiCreateFromRequestDraft = originalCreateFromDraft;
      }
      expect((wrapper.get('[data-testid="save-free-btn"]').element as HTMLButtonElement).disabled).toBe(true);
      expect((expectBody("free-save-submit").element as HTMLButtonElement).disabled).toBe(true);
      expect(wrapper.find('[data-testid="free-url-draft-error"]').exists()).toBe(true);

      await input.setValue(validUrlDraft);
      await flushPromises();
      let releaseCreate!: () => void;
      let markCreateStarted!: () => void;
      const createStarted = new Promise<void>((resolve) => { markCreateStarted = resolve; });
      const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
      const deferredCreate = vi.fn(async (draftInput: Parameters<typeof originalCreateFromDraft>[0]) => {
        markCreateStarted();
        await createGate;
        return originalCreateFromDraft(draftInput);
      });
      failingApi.apiCreateFromRequestDraft = deferredCreate;
      try {
        await expectBody("free-save-submit").trigger("click");
        await createStarted;
        await input.setValue("not a full URL");
        await flushPromises();
        releaseCreate();
        const persisted = await deferredCreate.mock.results[0]?.value;
        expect(persisted?.locator).toMatchObject({ ...targetParent, apiId: expect.any(String) });
        await vi.waitFor(() => expect(bodyFind("free-save-error")?.text()).toContain("源请求签已变化"));
        expect(editor.freeSessions[session.tabId]).toBe(session);
        expect(requestEditor.props("requestTab")).toMatchObject({ ...tab, source: { kind: "free" } });
        expect(session.urlDraft).toBe("not a full URL");
        expect(session.urlDraftInvalid).toBe(true);
        expect(bodyFind("free-save-name")).not.toBeNull();
      } finally {
        releaseCreate();
        failingApi.apiCreateFromRequestDraft = originalCreateFromDraft;
      }
    } finally {
      failingApi.nodeCreate = previousNodeCreate;
      if (projectLocator) await failingApi.nodeDelete({ kind: "project", locator: projectLocator }).catch(() => undefined);
    }
  });

  it("Free history 响应迟到时尊重原请求签与项目导航代次", async () => {
    const wrapper = await mountApp();
    await openLocalDir(wrapper);
    const project = projectByLabel(await failingApi.treeGet(), "示例项目");
    await wrapper.get('[data-testid="request-tab-new-free"]').trigger("click");
    await flushPromises();
    await flushPromises();

    const requestTabs = wrapper.findComponent(RequestTabs).props("tabs") as ReturnType<typeof createRequestTabsStore>;
    const editor = wrapper.findComponent(RequestEditor).props("editor") as ReturnType<typeof useEditorStore>;
    const history = wrapper.findComponent(DebugHistory);
    const debug = history.props("debug") as ReturnType<typeof useDebugStore>;
    const replayFree = history.props("replayFree");
    if (!replayFree) throw new Error("Free history replay callback was not provided");
    const firstTab = requestTabs.activeTab;
    const firstSession = editor.activeFreeSession;
    if (!firstTab || firstTab.source.kind !== "free" || !firstSession) throw new Error("Initial Free request tab was not initialized");

    type RestoreResult = Awaited<ReturnType<typeof failingApi.debugHistoryRestore>>;
    const pendingReplies: Array<(result: RestoreResult) => void> = [];
    const originalRestore = failingApi.debugHistoryRestore;
    const originalReplay = failingApi.debugHistoryReplay;
    const deferredRestore = vi.fn(async (_input: Parameters<typeof failingApi.debugHistoryRestore>[0]) =>
      new Promise<RestoreResult>((resolve) => pendingReplies.push(resolve)));
    const replayHistory = vi.fn(async (_input: Parameters<typeof failingApi.debugHistoryReplay>[0]) => {
      throw new Error("late history replay must not start");
    });
    failingApi.debugHistoryRestore = deferredRestore;
    failingApi.debugHistoryReplay = replayHistory;
    const historyDraftId = "30000000-0000-4000-8000-000000000004";
    const makeRestoreResult = (request: typeof firstSession.request, sourceAvailable = true): RestoreResult => ({
      invocation: {
        mode: "free",
        project: { ...project.locator },
        draftId: historyDraftId,
        request: JSON.parse(JSON.stringify(request)) as typeof firstSession.request,
        parameters: {},
        fields: [],
      },
      sourceChanged: false,
      sourceAvailable,
    });
    const sentinelPreview = {
      mode: "free" as const,
      project: { ...project.locator },
      draftId: "30000000-0000-4000-8000-000000000005",
      request: { ...firstSession.request, path: "/preserved-preview" },
      parameters: {},
      fields: [],
    };
    const previewState = debug as unknown as { freeRestoredPreview: DebugInvocation | null };
    previewState.freeRestoredPreview = sentinelPreview;
    const replay = (historyId: string) => replayFree({ historyId, exchangeOrder: 1, project: project.locator, draftId: historyDraftId });
    const releaseNext = async (sourceAvailable = true, request = firstSession.request) => {
      await vi.waitFor(() => expect(pendingReplies).toHaveLength(1));
      pendingReplies.shift()!(makeRestoreResult(request, sourceAvailable));
    };

    try {
      const firstLateReplay = replay("30000000-0000-4000-8000-000000000006");
      await vi.waitFor(() => expect(pendingReplies).toHaveLength(1));
      await wrapper.get('[data-testid="request-tab-new-free"]').trigger("click");
      await flushPromises();
      const secondTabId = requestTabs.activeId;
      expect(secondTabId).not.toBeNull();
      expect(secondTabId).not.toBe(firstTab.tabId);
      await releaseNext(false);
      await firstLateReplay;
      expect(requestTabs.order).toHaveLength(2);
      expect(requestTabs.activeId).toBe(secondTabId);
      expect(previewState.freeRestoredPreview).toEqual(sentinelPreview);
      expect(replayHistory).not.toHaveBeenCalled();

      const secondSession = editor.freeSessions[secondTabId!]!;
      const closingLateReplay = replay("30000000-0000-4000-8000-000000000007");
      await vi.waitFor(() => expect(pendingReplies).toHaveLength(1));
      await wrapper.get(`[data-testid="request-tab-close-${secondTabId}"]`).trigger("click");
      await vi.waitFor(() => expect(requestTabs.tabs[secondTabId!]).toBeUndefined());
      await releaseNext(true, secondSession.request);
      await closingLateReplay;
      expect(requestTabs.order).toEqual([firstTab.tabId]);
      expect(requestTabs.activeId).toBe(firstTab.tabId);
      expect(previewState.freeRestoredPreview).toEqual(sentinelPreview);
      expect(replayHistory).not.toHaveBeenCalled();

      await wrapper.get(`[data-testid="request-tab-close-${firstTab.tabId}"]`).trigger("click");
      await vi.waitFor(() => expect(requestTabs.order).toHaveLength(0));
      expect(requestTabs.activeId).toBeNull();
      const noTabLateReplay = replay("30000000-0000-4000-8000-000000000008");
      await vi.waitFor(() => expect(pendingReplies).toHaveLength(1));
      await wrapper.get('[data-testid="topbar-home"]').trigger("click");
      expect(wrapper.find('[data-testid="home-view"]').exists()).toBe(true);
      await wrapper.get('[data-testid="project-tab-0"]').trigger("click");
      await flushPromises();
      expect(history.props("projectLocator")).toEqual(project.locator);
      await releaseNext(true);
      await noTabLateReplay;
      expect(requestTabs.order).toHaveLength(0);
      expect(requestTabs.activeId).toBeNull();
      expect(previewState.freeRestoredPreview).toEqual(sentinelPreview);
      expect(replayHistory).not.toHaveBeenCalled();
    } finally {
      failingApi.debugHistoryRestore = originalRestore;
      failingApi.debugHistoryReplay = originalReplay;
    }
  });

  it("free context 尚未返回时不把上一正式接口暴露为 free 签的可编辑请求", async () => {
    const wrapper = await mountApp();
    await openLocalDir(wrapper);
    const project = projectByLabel(await failingApi.treeGet(), "示例项目");
    const collection = project.children!.find((node) => node.kind === "collection");
    const apiNode = collection?.children?.find((node) => node.kind === "api");
    if (!apiNode || apiNode.kind !== "api") throw new Error("示例项目缺少用于加载隔离回归的接口");
    const editor = wrapper.findComponent(RequestEditor).props("editor") as ReturnType<typeof useEditorStore>;
    await editor.load(apiNode.locator);
    const originalPath = editor.api!.contract.request.path;
    const detail = await failingApi.debugProjectContext(project.locator);
    let release!: (value: typeof detail) => void;
    const originalContext = failingApi.debugProjectContext;
    failingApi.debugProjectContext = async () => new Promise((resolve) => { release = resolve; });
    try {
      await wrapper.get('[data-testid="request-tab-new-free"]').trigger("click");
      await flushPromises();
      const leakedPath = wrapper.find('[data-testid="editor-path"]');
      if (leakedPath.exists()) await leakedPath.setValue("/wrong-free-owner");
      expect(editor.api!.contract.request.path).toBe(originalPath);
      expect(wrapper.find('[data-testid="editor-path"]').exists()).toBe(false);
    } finally {
      release(detail);
      failingApi.debugProjectContext = originalContext;
    }
  });

  it("关闭项目签对 dirty 请求签只确认一次；拒绝不驱逐，接受后清除所属请求会话", async () => {
    const wrapper = await mountApp();
    await openLocalDir(wrapper);
    await wrapper.get('[data-testid="request-tab-new-free"]').trigger("click");
    await flushPromises();
    await flushPromises();
    const requestEditor = wrapper.findComponent(RequestEditor);
    const editor = requestEditor.props("editor") as ReturnType<typeof useEditorStore>;
    const debug = requestEditor.props("debug") as ReturnType<typeof useDebugStore>;
    const tabs = wrapper.findComponent(ProjectTabs).props("tabs") as ReturnType<typeof createTabsStore>;
    const session = editor.activeFreeSession;
    if (!session) throw new Error("Free request session was not initialized");
    await wrapper.get('[data-testid="editor-full-url"]').setValue("https://example.test/dirty");
    await flushPromises();
    expect(editor.dirty).toBe(true);

    await wrapper.get('[data-testid="tab-close-0"]').trigger("click");
    await flushPromises();
    expect(document.body.querySelector('[data-testid="dialog-confirm"]')).not.toBeNull();
    expect(tabs.tabs).toHaveLength(1);
    await expectBody("dialog-cancel").trigger("click");
    await flushPromises();
    expect(tabs.tabs).toHaveLength(1);
    expect(editor.freeSessions[session.tabId]).toBe(session);
    expect(debug.requestTabs[session.tabId]).toBeDefined();

    await wrapper.get('[data-testid="tab-close-0"]').trigger("click");
    await flushPromises();
    await expectBody("dialog-confirm").trigger("click");
    await vi.waitFor(() => expect(tabs.tabs).toHaveLength(0));
    expect(editor.freeSessions[session.tabId]).toBeUndefined();
    expect(debug.requestTabs[session.tabId]).toBeUndefined();
    expect(document.body.querySelector('[data-testid="dialog-confirm"]')).toBeNull();
  });

  it("只有正式设计器原始 JSON 草稿也触发请求签关闭确认，取消后保留原文", async () => {
    const dirtyCheckRegistration = vi.spyOn(failingApi, "onDirtyCheck");
    const wrapper = await mountApp();
    const aggregateHasDrafts = dirtyCheckRegistration.mock.calls.at(-1)?.[0];
    dirtyCheckRegistration.mockRestore();
    if (!aggregateHasDrafts) throw new Error("App did not register its exit dirty-check handler");
    await openLocalDir(wrapper);
    await flushPromises();
    await clickApiAndWait(wrapper);
    const requestEditor = wrapper.findComponent(RequestEditor);
    const editor = requestEditor.props("editor") as ReturnType<typeof useEditorStore>;
    const tabs = wrapper.findComponent(RequestTabs).props("tabs") as ReturnType<typeof createRequestTabsStore>;
    const tabId = tabs.activeId;
    if (!tabId || tabs.tabs[tabId]?.source.kind !== "asset") throw new Error("The selected API request tab was not initialized");
    const session = editor.sessions[editor.activeKey!]!;
    if (session.api.contract.request.protocol !== "http") throw new Error("The seeded API must use HTTP");
    session.api.contract.request.body = { kind: "json", content: "{}", schema: { kind: "scalar", type: "string" } };
    session.snapshot = JSON.stringify(session.api);
    expect(editor.dirty).toBe(false);
    expect(aggregateHasDrafts()).toBe(false);

    await subRadio(wrapper, "design").setValue(true);
    await flushPromises();
    await wrapper.get('[data-testid="design-contract-tab"]').trigger("click");
    await wrapper.get('[data-testid="schema-default"]').setValue("invalid-only-raw-draft");
    expect(editor.dirty).toBe(false);
    expect(aggregateHasDrafts()).toBe(true);

    await wrapper.get(`[data-testid="request-tab-close-${tabId}"]`).trigger("click");
    await flushPromises();
    expect(bodyFind("dialog-confirm")).not.toBeNull();
    expect(tabs.activeId).toBe(tabId);
    await expectBody("dialog-cancel").trigger("click");
    await flushPromises();
    expect(aggregateHasDrafts()).toBe(true);
    expect(tabs.activeId).toBe(tabId);
    expect(editor.sessions[editor.activeKey!]!.api).toBe(session.api);
    expect((wrapper.get('[data-testid="schema-default"]').element as HTMLTextAreaElement).value).toBe("invalid-only-raw-draft");
  });

  it("R7 后续 还原缺省参数后可直接关闭请求和项目签，其他改动仍需确认", async () => {
    const registration = vi.spyOn(failingApi, "onDirtyCheck");
    const wrapper = await mountApp();
    const hasDrafts = registration.mock.calls.at(-1)?.[0];
    registration.mockRestore();
    if (!hasDrafts) throw new Error("Missing desktop dirty-check handler");
    await openLocalDir(wrapper);
    await clickApiAndWait(wrapper);
    const editor = wrapper.getComponent(RequestEditor).props("editor");
    const projectTabs = wrapper.getComponent(ProjectTabs).props("tabs");
    const requests = wrapper.getComponent(RequestTabs).props("tabs");
    const requestTab = wrapper.getComponent(RequestEditor).props("requestTab");
    if (!requestTab || !editor.activeKey) throw new Error("Expected API request");
    const session = editor.sessions[editor.activeKey]!;
    session.api.contract.request.query = [{ kind: "inline", id: "restore-query", name: "query", schema: { kind: "scalar", type: "string" },
      required: false, enabled: true, description: "" }];
    session.snapshot = JSON.stringify(session.api);
    await wrapper.get('[data-testid="tab-query"]').trigger("click");
    const query = wrapper.get('[data-testid="kv-value"]');
    await query.setValue("edited");
    expect(hasDrafts()).toBe(true);
    await query.setValue("");
    expect(hasDrafts()).toBe(false);
    await wrapper.get('[data-testid="asset-metadata-toggle"]').trigger("click");
    const name = session.api.contract.metadata.name;
    await wrapper.get('[data-testid="asset-metadata-name"]').setValue("other edit");
    await wrapper.get(`[data-testid="request-tab-close-${requestTab.tabId}"]`).trigger("click");
    await vi.waitFor(() => expect(bodyFind("dialog-confirm")).not.toBeNull());
    await expectBody("dialog-cancel").trigger("click");
    await wrapper.get('[data-testid="asset-metadata-name"]').setValue(name);
    expect(hasDrafts()).toBe(false);
    await wrapper.get(`[data-testid="request-tab-close-${requestTab.tabId}"]`).trigger("click");
    await vi.waitFor(() => expect(requests.tabs[requestTab.tabId]).toBeUndefined());
    expect(bodyFind("dialog-confirm")).toBeNull();
    await wrapper.get('[data-testid="tab-close-0"]').trigger("click");
    await vi.waitFor(() => expect(projectTabs.tabs).toHaveLength(0));
    expect(bodyFind("dialog-confirm")).toBeNull();
  });

  it("唯一项目签从主页切回时恢复原项目及未保存请求草稿", async () => {
    const wrapper = await mountApp();
    await openLocalDir(wrapper);

    const tabs = wrapper.findComponent(ProjectTabs).props("tabs") as ReturnType<typeof createTabsStore>;
    expect(tabs.tabs).toHaveLength(1);
    const tabId = tabs.tabs[0]!.tabId;
    const workspace = wrapper.findComponent(TopBar).props("workspace") as ReturnType<typeof useWorkspaceStore>;
    const workspaceOpen = vi.spyOn(workspace, "open");
    const editor = wrapper.findComponent(RequestEditor).props("editor") as ReturnType<typeof import("../../src/renderer/src/stores/editor.js").useEditorStore>;
    const project = projectByLabel(await failingApi.treeGet(), "示例项目");
    const collection = project.children!.find((node) => node.kind === "collection");
    const apiNode = collection?.children?.find((node) => node.kind === "api");
    if (!apiNode || apiNode.kind !== "api") throw new Error("示例项目缺少用于回归的接口");
    await editor.load(apiNode.locator);
    const draftPath = "/f2b-home-return-draft";
    editor.api!.contract.request.path = draftPath;
    expect(editor.dirty).toBe(true);

    await wrapper.get('[data-testid="topbar-home"]').trigger("click");
    expect(wrapper.find('[data-testid="home-view"]').exists()).toBe(true);
    await wrapper.get('[data-testid="project-tab-0"]').trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="home-view"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="module-rail"]').exists()).toBe(true);
    expect(wrapper.findComponent(RequestEditor).exists()).toBe(true);
    expect(tabs.tabs).toHaveLength(1);
    expect(tabs.tabs[0]!.tabId).toBe(tabId);
    expect(editor.api?.contract.request.path).toBe(draftPath);
    expect(editor.dirty).toBe(true);
    expect(workspaceOpen).not.toHaveBeenCalled();
  });

  it("主页保留本地项目调试环境及用例上下文，在线工作区不暴露请求操作", async () => {
    await seedOnlineLogin();
    let environmentId: string | null = null;
    let projectLocator: ProjectLocator | null = null;
    try {
      const wrapper = await mountApp();
      await openLocalDir(wrapper);
      const project = projectByLabel(await failingApi.treeGet(), "示例项目");
      projectLocator = project.locator;
      const created = await failingApi.envCreate({ locator: project.locator, name: "fix1-dev" });
      environmentId = created.id;
      await clickApiAndWait(wrapper);

      const requestEditor = wrapper.findComponent(RequestEditor);
      const editor = requestEditor.props("editor") as ReturnType<typeof useEditorStore>;
      const debug = requestEditor.props("debug") as ReturnType<typeof useDebugStore>;
      const firstCase = editor.api?.cases[0];
      if (!firstCase) throw new Error("示例接口缺少用于回归的用例");
      const selectedCase = { caseId: firstCase.id, scope: firstCase.scope };
      const draftPath = "/f2b-fix1-home-draft";
      editor.api!.contract.request.path = draftPath;
      debug.selectEnv("fix1-dev");
      debug.selectCase(selectedCase);
      expect(editor.dirty).toBe(true);
      expect(editor.envs.map((entry) => entry.name)).toContain("fix1-dev");

      await wrapper.get('[data-testid="topbar-home"]').trigger("click");
      await gotoServerWorkspaces(wrapper);
      await wrapper.find('[data-testid="home-ws-ws-online-1"]').trigger("click");
      await flushPromises();

      expect(wrapper.find('[data-testid="home-view"]').exists()).toBe(true);
      expect(debug.selectedEnvName).toBe("fix1-dev");
      expect(debug.selectedCase).toEqual(selectedCase);
      expect(editor.api?.contract.request.path).toBe(draftPath);
      expect(editor.dirty).toBe(true);
      expect(wrapper.find('[data-testid="send-btn"]').exists()).toBe(false);

      await wrapper.get('[data-testid="project-tab-0"]').trigger("click");
      await flushPromises();

      expect(wrapper.find('[data-testid="home-view"]').exists()).toBe(false);
      expect(debug.selectedEnvName).toBe("fix1-dev");
      expect(debug.selectedCase).toEqual(selectedCase);
      expect(editor.api?.contract.request.path).toBe(draftPath);
      expect(editor.dirty).toBe(true);
    } finally {
      if (environmentId && projectLocator) {
        await failingApi.nodeDelete({
          kind: "environment",
          locator: { ...projectLocator, environmentId },
        }).catch(() => undefined);
      }
      await cleanupOnlineLogin();
    }
  });

  it("主页导航使迟到的项目激活不能抢回页面", async () => {
    const wrapper = await mountApp();
    await openLocalDir(wrapper);
    const tabs = wrapper.findComponent(ProjectTabs).props("tabs") as ReturnType<typeof createTabsStore>;
    const tabId = tabs.tabs[0]!.tabId;
    const workspace = wrapper.findComponent(TopBar).props("workspace") as ReturnType<typeof useWorkspaceStore>;
    const originalOpen = workspace.open.bind(workspace);
    let releaseOpen!: () => void;
    const gate = new Promise<void>((resolve) => { releaseOpen = resolve; });
    let openStarted = false;
    await wrapper.get('[data-testid="topbar-home"]').trigger("click");
    workspace.opened = false;
    workspace.open = async (rootPath) => {
      openStarted = true;
      await gate;
      workspace.root = rootPath;
      workspace.opened = true;
    };

    try {
      const activation = tabs.activateTab(tabId);
      await vi.waitFor(() => expect(openStarted).toBe(true));
      await wrapper.get('[data-testid="topbar-home"]').trigger("click");
      releaseOpen();
      await activation;
      await flushPromises();

      expect(tabs.selectedPage).toEqual({ kind: "home" });
      expect(tabs.contextTabId).toBe(tabId);
      expect(wrapper.find('[data-testid="home-view"]').exists()).toBe(true);
    } finally {
      releaseOpen();
      workspace.open = originalOpen;
      workspace.opened = true;
    }
  });
});

describe("App 错误反馈通道（宽审查 I1）", () => {
  it("F8 design save errors from invalid raw input follow language changes in the App alert", async () => {
    const locale = initI18n(); locale.setLocale("zh-CN");
    const wrapper = await mountApp();
    await openLocalDir(wrapper); await clickApiAndWait(wrapper);
    const editor = wrapper.findComponent(RequestEditor).props("editor") as ReturnType<typeof useEditorStore>;
    const request = editor.api!.contract.request;
    if (request.protocol !== "http") throw new Error("HTTP fixture required");
    request.body = { kind: "json", content: "{}", schema: { kind: "scalar", type: "string" } };
    await subRadio(wrapper, "design").setValue(true); await flushPromises();
    await wrapper.get('[data-testid="design-contract-tab"]').trigger("click");
    await wrapper.get('[data-testid="schema-default"]').setValue("invalid-raw-value");
    const writes = vi.spyOn(failingApi, "apiSave");
    try {
      await wrapper.get('[data-testid="design-save"]').trigger("click"); await flushPromises();
      expect(wrapper.get('[data-testid="app-error"]').text()).toContain("请先修正无效的 JSON 输入");
      locale.setLocale("en"); await flushPromises();
      expect.soft(wrapper.get('[data-testid="app-error"]').text()).toContain("Fix the invalid JSON input before previewing or saving.");
      expect.soft(wrapper.get('[data-testid="app-error"]').text()).not.toContain("请先修正");
      expect(wrapper.get('[data-testid="app-error"]').text()).not.toContain("design-invalid-json");
      expect(writes).not.toHaveBeenCalled();
    } finally { writes.mockRestore(); locale.setLocale("zh-CN"); }
  });
  it("对话框 run 拒绝时 app-error 展示错误并可手动关闭", async () => {
    const wrapper = await mountApp();
    // 打开工作区：memory 替身 wsOpen 对非工作区目录回退内存态（已 seed）
    await openLocalDir(wrapper);
    await flushPromises();
    await wrapper.get('[data-testid="directory-create"]').trigger("click");
    await expectBody("new-collection").trigger("click");
    await expectBody("dialog-input").setValue("x");
    await expectBody("dialog-confirm").trigger("click");
    await flushPromises();
    const bar = wrapper.find('[data-testid="app-error"]');
    expect(bar.exists()).toBe(true);
    expect(bar.text()).toContain("接口创建失败（测试注入）");
    // 手动关闭后隐藏（a-alert closeText 关闭钮 → @close → 清空 errorMessage）
    await wrapper.find('[data-testid="app-error-close"]').trigger("click");
    expect(wrapper.find('[data-testid="app-error"]').exists()).toBe(false);
  });
});

// M8：模块经图标导航栏（rail-*，原生 button）切换；接口模块子视图（调试/设计/用例）
// 经 api-head 里的 radio 组（view-*）切换。radio 断言沿用 input 定位（antd disabled
// 落在内部 input 上），rail 断言直接用 button 的 disabled 属性。
function subRadio(wrapper: import("@vue/test-utils").VueWrapper, value: string) {
  return wrapper.find(`[data-testid="view-${value}"] input[type=radio]`);
}

describe("App 视图切换装配（M8 模块化）", () => {
  it("未打开工作区时：主页不渲染 rail（导航经项目打开）；打开后子视图按选中禁用", async () => {
    const wrapper = await mountApp();
    // 主页视图不渲染 rail（用户裁定）——门控（railGate）逻辑保留在组件内
    expect(wrapper.find('[data-testid="module-rail"]').exists()).toBe(false);
    // 顶栏主页入口恒在（M11：主页不在 rail）
    expect(wrapper.find('[data-testid="topbar-home"]').exists()).toBe(true);
    // 子视图（接口未选中）禁用：打开工作区、切接口模块、未选接口 → design 禁用
    await openLocalDir(wrapper);
    expect(subRadio(wrapper, "design").attributes("disabled")).toBeDefined();
  });

  it("打开工作区后可切换 运行/环境/导入 模块与 调试/用例/设计 子视图，导入取消回调试子视图", async () => {
    const wrapper = await mountApp();
    // 主页视图不渲染 rail（用户裁定）——缺失即断言
    expect(wrapper.find('[data-testid="rail-run"]').exists()).toBe(false);
    await openLocalDir(wrapper);
    await flushPromises();
    // openLocalDir 经项目卡片已直达接口模块
    // 打开后模块可用；缺省接口模块 + 调试子视图 = 编辑器 + 响应区（子视图需选中接口）
    expect(wrapper.find('[data-testid="rail-run"]').attributes("disabled")).toBeUndefined();
    expect(wrapper.find('[data-testid="editor-pane"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="viewer-pane"]').exists()).toBe(true);
    // 选中种子接口 → 子视图（调试/设计）启用 → 设计子视图（M9-D：用例移入测试模块）
    await flushPromises();
    await clickApiAndWait(wrapper);
    await flushPromises();
    expect(subRadio(wrapper, "design").attributes("disabled")).toBeUndefined();
    await subRadio(wrapper, "design").setValue(true);
    await flushPromises();
    expect(wrapper.find('[data-testid="design-panel"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="editor-pane"]').exists()).toBe(false);
    // 回调试子视图
    await subRadio(wrapper, "debug").setValue(true);
    await flushPromises();
    expect(wrapper.find('[data-testid="editor-pane"]').exists()).toBe(true);
    // 环境模块
    await wrapper.find('[data-testid="rail-envs"]').trigger("click");
    await expectBody("manage-environments").trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="env-panel"]').exists()).toBe(true);
    // 运行模块（RunView 内含运行历史抽屉）
    await wrapper.find('[data-testid="rail-run"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="run-view"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="runs-history-btn"]').exists()).toBe(true);
    // 目录打开导入，取消后保留当前调试子视图
    await wrapper.find('[data-testid="rail-api"]').trigger("click");
    await flushPromises();
    await openDirectoryImport(wrapper);
    expect(bodyFind("import-wizard")).not.toBeNull();
    const fileInput = expectBody("import-file-input").element as HTMLInputElement;
    Object.defineProperty(fileInput, "files", {
      value: [new File(["openapi: 3.0.0"], "preview.yaml", { type: "text/yaml" })],
      configurable: true,
    });
    await fileInput.dispatchEvent(new Event("change"));
    await flushPromises();
    expect(bodyFind("import-preview-tree")).not.toBeNull();
    expect((expectBody("import-name-input").element as HTMLInputElement).value).toBe("导入示例项目");
    const importW = wrapper.findComponent(ImportWizard).props("importW") as { preview: ImportPreviewResult | null };
    expect(importW.preview?.importerName).toBe("sample");
    expect(importW.preview?.diagnostics).toContainEqual(expect.objectContaining({
      severity: "warning", code: "IMPORT_SAMPLE_WARNING", message: "示例警告",
    }));
    expect(expectBody("import-warnings").text()).toContain("示例警告");
    await expectBody("import-cancel").trigger("click");
    await flushPromises();
    expect(importW.preview).toBeNull();
    expect(wrapper.find('[data-testid="editor-pane"]').exists()).toBe(true);
  });

  it("调试子视图仍是缺省且发送链路可用（装配不破坏既有行为）", async () => {
    const wrapper = await mountApp();
    await openLocalDir(wrapper);
    await flushPromises();
    await flushPromises();
    await clickApiAndWait(wrapper);
    await flushPromises();
    await wrapper.find('[data-testid="send-btn"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="response-outcome"]').exists()).toBe(true);
  });
});

describe("ConfigProvider 消费侧（计划 1 遗留 T1①）", () => {
  it("语言切换后 antd 内建文案随 locale 变化", async () => {
    const wrapper = await mountApp();
    // 打开工作区并选中接口，发送一次：memory 替身断言恒为空 → 断言表渲染 antd 内建空态
    await openLocalDir(wrapper);
    await flushPromises();
    await flushPromises();
    await clickApiAndWait(wrapper);
    await flushPromises();
    await wrapper.find('[data-testid="send-btn"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="response-outcome"]').exists()).toBe(true);
    // 断言明细页签（M8 页签化，懒渲染）：点开让断言表渲染（memory 替身断言恒为空 →
    // antd 内建空态）；zh-CN：ConfigProvider locale=zh_CN → 空态文案「暂无数据」
    await wrapper.find('[data-testid="response-tab-assertions"]').trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("暂无数据");
    // 语言下拉（点 lang-toggle 展开 → 点选 English 菜单项，ThemeLanguageToggle →
    // bridge → ConfigProvider locale）→ antd 文案切英文
    await wrapper.find('[data-testid="lang-toggle"]').trigger("click");
    await flushPromises();
    await langOption("en").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("No data");
    // 还原语言：重新展开下拉点选中文，避免污染同文件其他用例与 localStorage
    await wrapper.find('[data-testid="lang-toggle"]').trigger("click");
    await flushPromises();
    await langOption("zh-CN").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("暂无数据");
  });
});

// —— 审查 I1：侧树切换工作流必须过 dirty 确认，编辑不得静默丢失 ——
describe("App 侧树切换工作流 dirty 确认（审查 I1）", () => {
  it("C1 Fix1 evidence locate keeps the same dirty workflow and confirms another captured workflow", async () => {
    const wrapper = await mountApp(); await openLocalDir(wrapper);
    const project = projectByLabel(await failingApi.treeGet(), "示例项目");
    const wfA = await failingApi.wfCreate({ locator: project.locator, name: "证据脏草稿" });
    const wfB = await failingApi.wfCreate({ locator: project.locator, name: "证据另一工作流" });
    await openLocalDir(wrapper);
    const design = await openWorkflowDesigner(wrapper);
    const loadA = captureWorkflowLoad(design);
    await wrapper.findAll('[data-testid="tree-workflow"]').find((node) => node.text().includes("证据脏草稿"))!.trigger("click");
    await loadA.settle(); loadA.restore();
    await wrapper.get('[data-testid="wf-add-request"]').trigger("click"); await flushPromises();
    expect(design.dirty).toBe(true);
    const draft = JSON.stringify(design.workflow);
    const selected = wrapper.findComponent(SideTree).props("tree") as ReturnType<typeof useTreeStore>;
    const oldSelection = selected.selected;
    const emitLocate = async (workflowId: string) => {
      await wrapper.get('[data-testid="rail-run"]').trigger("click");
      wrapper.findComponent(RunView).vm.$emit("locate-evidence", { projectId: project.id, definitionRevision: "historical", workflowId });
      await flushPromises();
    };
    const sameLoad = captureWorkflowLoad(design);
    await emitLocate(wfA.id);
    expect(sameLoad.called()).toBe(false); sameLoad.restore();
    expect(JSON.stringify(design.workflow)).toBe(draft);
    expect(design.dirty).toBe(true);
    const blocked = captureWorkflowLoad(design);
    await emitLocate(wfB.id);
    expect(blocked.called()).toBe(false);
    expect(JSON.stringify(design.workflow)).toBe(draft);
    await expectBody("dialog-cancel").trigger("click"); await flushPromises(); blocked.restore();
    expect(design.workflowId).toBe(wfA.id); expect(design.dirty).toBe(true);
    expect(JSON.stringify(design.workflow)).toBe(draft);
    expect(selected.selected).toEqual(oldSelection);
    const confirmed = captureWorkflowLoad(design);
    await emitLocate(wfB.id);
    await expectBody("dialog-confirm").trigger("click");
    await confirmed.settle(); confirmed.restore();
    expect(design.workflowId).toBe(wfB.id); expect(design.dirty).toBe(false);
  });
  it("dirty 时点击另一工作流：确认前缓冲不变；取消保持；确认后新流载入", async () => {
    const wrapper = await mountApp();
    await openLocalDir(wrapper);
    await flushPromises();
    // 直连替身建两条流后重开工作区刷新树（failingApi 为本文件共享单例，按名定位节点）
    const treeDto = await failingApi.treeGet();
    const project = projectByLabel(treeDto, "示例项目");
    const wfA = await failingApi.wfCreate({ locator: project.locator, name: "脏缓冲流" });
    const wfB = await failingApi.wfCreate({ locator: project.locator, name: "切换目标流" });
    await openLocalDir(wrapper);
    await flushPromises();
    const wfNode = (name: string) =>
      wrapper.findAll('[data-testid="tree-workflow"]').find((n) => n.text().includes(name))!;
    // 侧树打开流 A 并经设计器「加节点」制造 dirty
    const designStore = await openWorkflowDesigner(wrapper);
    const loadA = captureWorkflowLoad(designStore);
    await wfNode("脏缓冲流").trigger("click");
    await loadA.settle();
    loadA.restore();
    await wrapper.find('[data-testid="wf-add-request"]').trigger("click");
    await flushPromises();
    const designOf = () =>
      wrapper.findComponent(WfDesigner).props("workflowDesign") as {
        workflowId: string | null;
        dirty: boolean;
        workflow: { name: string } | null;
      };
    expect(designOf().dirty).toBe(true);

    // dirty 时点击流 B：确认框弹出，缓冲仍是 A（修复前：直接 load，编辑静默丢失）
    const blockedLoad = captureWorkflowLoad(designStore);
    await wfNode("切换目标流").trigger("click");
    await flushPromises();
    expect(designOf().workflowId).toBe(wfA.id);
    expect(designOf().dirty).toBe(true);
    expect(expectBody("dialog-cancel").exists()).toBe(true);
    expect(expectBody("dialog-confirm").exists()).toBe(true);
    expect(blockedLoad.called()).toBe(false);

    // 取消：缓冲不变、不载入 B
    await expectBody("dialog-cancel").trigger("click");
    await flushPromises();
    blockedLoad.restore();
    expect(designOf().workflowId).toBe(wfA.id);
    expect(designOf().dirty).toBe(true);

    // 再点流 B 并确认丢弃：新流载入、dirty 复位
    const confirmedLoad = captureWorkflowLoad(designStore);
    await wfNode("切换目标流").trigger("click");
    await flushPromises();
    await expectBody("dialog-confirm").trigger("click");
    await confirmedLoad.settle();
    confirmedLoad.restore();
    expect(designOf().workflowId).toBe(wfB.id);
    expect(designOf().workflow?.name).toBe("切换目标流");
    expect(designOf().dirty).toBe(false);
  });

  it("非 dirty 时点击另一工作流：直接载入不弹确认（现状保持）", async () => {
    const wrapper = await mountApp();
    await openLocalDir(wrapper);
    await flushPromises();
    const treeDto = await failingApi.treeGet();
    const project = projectByLabel(treeDto, "示例项目");
    await failingApi.wfCreate({ locator: project.locator, name: "干净流甲" });
    const wfB = await failingApi.wfCreate({ locator: project.locator, name: "干净流乙" });
    await openLocalDir(wrapper);
    await flushPromises();
    const wfNode = (name: string) =>
      wrapper.findAll('[data-testid="tree-workflow"]').find((n) => n.text().includes(name))!;
    const designStore = await openWorkflowDesigner(wrapper);
    const loadA = captureWorkflowLoad(designStore);
    await wfNode("干净流甲").trigger("click");
    await loadA.settle();
    loadA.restore();
    const loadB = captureWorkflowLoad(designStore);
    await wfNode("干净流乙").trigger("click");
    await loadB.settle();
    loadB.restore();
    const design = wrapper.findComponent(WfDesigner).props("workflowDesign") as { workflowId: string | null };
    expect(design.workflowId).toBe(wfB.id);
    expect(document.body.querySelector('[data-testid="dialog-confirm"]')).toBeNull();
  });
});

// —— 审查 I2：侧树重命名与设计器缓冲脱节 ——
describe("App 侧树重命名与设计器缓冲同步（审查 I2）", () => {
  it("重命名设计器正开的工作流：设计器会话卸载，再次打开重新 load 拿新名", async () => {
    const wrapper = await mountApp();
    await openLocalDir(wrapper);
    await flushPromises();
    const treeDto = await failingApi.treeGet();
    const project = projectByLabel(treeDto, "示例项目");
    const wf = await failingApi.wfCreate({ locator: project.locator, name: "旧名流" });
    await openLocalDir(wrapper);
    await flushPromises();
    const wfNode = (name: string) =>
      wrapper.findAll('[data-testid="tree-workflow"]').find((n) => n.text().includes(name))!;
    // 侧树打开该流（设计器载入，缓冲持旧名）
    const designStore = await openWorkflowDesigner(wrapper);
    const loadOld = captureWorkflowLoad(designStore);
    await wfNode("旧名流").trigger("click");
    await loadOld.settle();
    loadOld.restore();
    const designOf = () =>
      wrapper.findComponent(WfDesigner).props("workflowDesign") as {
        workflowId: string | null;
        workflow: { name: string } | null;
      };
    expect(designOf().workflowId).toBe(wf.id);
    // 侧树重命名该流：workflow 行内动作钮（作用域限定 tree-workflow-row，避开容器节点同名钮）
    const row = wrapper
      .findAll('[data-testid="tree-workflow-row"]')
      .find((r) => r.text().includes("旧名流"))!;
    await row.find('[data-testid="node-rename"]').trigger("click");
    await expectBody("dialog-input").setValue("新名流");
    const originalRename = failingApi.wfRename.bind(failingApi);
    let renameTask: ReturnType<typeof originalRename> | null = null;
    failingApi.wfRename = (...args) => {
      renameTask = originalRename(...args);
      return renameTask;
    };
    const workspace = wrapper.findComponent(WfDesigner).props("workspace") as ReturnType<typeof useWorkspaceStore>;
    const originalRefresh = workspace.refresh.bind(workspace);
    let refreshTask: ReturnType<typeof originalRefresh> | null = null;
    workspace.refresh = () => {
      refreshTask = originalRefresh();
      return refreshTask;
    };
    try {
      await expectBody("dialog-confirm").trigger("click");
      if (!renameTask) throw new Error("Workflow rename confirmation did not invoke the real api.wfRename action");
      await renameTask;
      if (!refreshTask) throw new Error("Completed workflow rename did not invoke the real workspace.refresh action");
      await refreshTask;
    } finally {
      failingApi.wfRename = originalRename;
      workspace.refresh = originalRefresh;
    }
    await flushPromises();
    // 修复前：缓冲仍持旧名（workflowId 不变）——此后保存按缓冲整体替换，改名被静默回滚
    expect(designOf().workflowId).toBeNull();
    expect(designOf().workflow).toBeNull();
    // 再次打开（树已 refresh 显示新名）：走重新 load 拿新名
    const loadRenamed = captureWorkflowLoad(designStore);
    await wfNode("新名流").trigger("click");
    await loadRenamed.settle();
    loadRenamed.restore();
    expect(designOf().workflowId).toBe(wf.id);
    expect(designOf().workflow?.name).toBe("新名流");
  });

  it("重命名未打开的工作流：不影响设计器会话（条件分支不误伤）", async () => {
    const wrapper = await mountApp();
    await openLocalDir(wrapper);
    await flushPromises();
    const treeDto = await failingApi.treeGet();
    const project = projectByLabel(treeDto, "示例项目");
    const wfA = await failingApi.wfCreate({ locator: project.locator, name: "旁路流甲" });
    await failingApi.wfCreate({ locator: project.locator, name: "旁路流乙" });
    await openLocalDir(wrapper);
    await flushPromises();
    const wfNode = (name: string) =>
      wrapper.findAll('[data-testid="tree-workflow"]').find((n) => n.text().includes(name))!;
    // 设计器开着流甲，重命名流乙
    const designStore = await openWorkflowDesigner(wrapper);
    const loadA = captureWorkflowLoad(designStore);
    await wfNode("旁路流甲").trigger("click");
    await loadA.settle();
    loadA.restore();
    const row = wrapper
      .findAll('[data-testid="tree-workflow-row"]')
      .find((r) => r.text().includes("旁路流乙"))!;
    await row.find('[data-testid="node-rename"]').trigger("click");
    await expectBody("dialog-input").setValue("旁路流乙改");
    await expectBody("dialog-confirm").trigger("click");
    await flushPromises();
    // 命中条件 workflowId === 被改名 id 不成立：流甲会话不受旁路重命名影响
    const design = wrapper.findComponent(WfDesigner).props("workflowDesign") as { workflowId: string | null };
    expect(design.workflowId).toBe(wfA.id);
  });
});

// —— 宽范围审查 I2：项目内 API 增删后 bindIndex 必须随树刷新重建 ——
// 修复前 watch 源仅 [selectedProjectId, opened]：项目内新增接口只改变 workspace.tree
// 引用（refresh 换新对象、选中项目不变），watch 不触发 → 设计器拿到陈旧索引，
// 改绑级联、画布 apiName/caseName 预注入与 missing 红框检测全部失真。
describe("App 工作流绑定索引随树刷新（审查 I2）", () => {
  it("项目内新增接口后 bindIndex 重建并包含新接口", async () => {
    failingApi.nodeCreate = realNodeCreate; // 本用例需要真实创建，结束时还原恒拒绝替身
    try {
      const wrapper = await mountApp();
      await openLocalDir(wrapper);
      await flushPromises();
      // 选中种子接口 → selectedProjectId 就绪 → bindIndex 首次构建（仅种子 1 个接口）
      await clickApiAndWait(wrapper);
      await flushPromises();
      await wrapper.find('[data-testid="rail-wf"]').trigger("click");
      await flushPromises();
      const designer = wrapper.findComponent(WfDesigner);
      const before = designer.props("bindIndex") as WfBindIndex | null;
      expect(before).not.toBeNull();
      expect(before!.apiIds.size).toBe(1);

      // 项目内经目录创建并保存请求草稿，刷新目录的绑定索引。
      await openNewApiFromContainer(wrapper, "示例集合");
      await submitNewApiDraft(wrapper, "联动新接口");
      await vi.waitFor(() => expect(wrapper.find('[data-testid="request-editor"]').attributes("data-source-kind")).toBe("asset"));
      await wrapper.get('[data-testid="rail-wf"]').trigger("click");
      await flushPromises();

      // watch 源含 workspace.tree：refresh 即重建索引，新接口进入 apiIds/名称表
      const currentDesigner = wrapper.getComponent(WfDesigner);
      await vi.waitFor(() => {
        const after = currentDesigner.props("bindIndex") as WfBindIndex | null;
        expect(after?.apiIds.size).toBe(2);
        expect([...after!.apiNames.values()]).toContain("联动新接口");
      });
      const after = currentDesigner.props("bindIndex") as WfBindIndex | null;
      expect(after!.apiIds.size).toBe(2); // 修复前索引陈旧仍为 1
      expect([...after!.apiNames.values()]).toContain("联动新接口");
    } finally {
      failingApi.nodeCreate = async () => { throw new Error("接口创建失败（测试注入）"); };
    }
  });
});

// —— M2-B 收口：侧树工作流入口（点击工作流节点 → 视图切 wf + 设计器载入该流） ——
describe("App 侧树工作流入口", () => {
  it("点击侧树工作流节点：视图切到工作流且设计器载入该流（selectedProjectId 保持所属项目）", async () => {
    const wrapper = await mountApp();
    await openLocalDir(wrapper);
    await flushPromises();
    const expectAppShellAboveWorkspace = () => {
      const appRoot = wrapper.find('[data-testid="app-root"]');
      expect(appRoot.classes()).not.toContain("ant-layout-has-sider");
      const children = Array.from(appRoot.element.children);
      const topbarIndex = children.findIndex((child) => child.matches('[data-testid="topbar"]'));
      const workspaceIndex = children.findIndex((child) => child.classList.contains("body"));
      expect(topbarIndex).toBeGreaterThanOrEqual(0);
      expect(workspaceIndex).toBeGreaterThanOrEqual(0);
      expect(topbarIndex).toBeLessThan(workspaceIndex);
      expect(children[topbarIndex]!.querySelector('[data-testid="project-tabs"]')).not.toBeNull();
    };
    expectAppShellAboveWorkspace();
    // 直连替身建工作流后重开工作区刷新树（打开钮对非工作区目录回退内存态）
    const tree = await failingApi.treeGet();
    const project = projectByLabel(tree, "示例项目");
    const wf = await failingApi.wfCreate({ locator: project.locator, name: "侧树入口流" });
    await openLocalDir(wrapper);
    await flushPromises();
    // id 布局（轨一）后树内工作流按 id 字典序排列（名称制时代的名称序不再保证）——按名称点选目标流
    const designStore = wrapper.findComponent(SideTree).props("workflowDesign") as ReturnType<typeof useWorkflowDesignStore>;
    const load = captureWorkflowLoad(designStore);
    await wrapper.findAll('[data-testid="tree-workflow"]').find((n) => n.text().includes("侧树入口流"))!.trigger("click");
    await load.settle();
    load.restore();
    expectAppShellAboveWorkspace();
    const workflowLayout = wrapper.findComponent(WfDesigner).find(".wf-body");
    expect(workflowLayout.classes()).toContain("ant-layout");
    expect(workflowLayout.classes()).toContain("ant-layout-has-sider");
    expect((workflowLayout.element as HTMLElement).style.background).toBe("transparent");
    expect((workflowLayout.element as HTMLElement).style.color).toBe("inherit");
    expect(wrapper.find('[data-testid="wf-canvas"]').exists()).toBe(true);
    const propertyPanel = wrapper.find('[data-testid="wf-panel"]');
    expect(propertyPanel.classes()).toContain("ant-layout-sider");
    expect(propertyPanel.attributes("style")).toMatch(/width:\s*280px/);
    // 视图切到 wf（rail 选中态）
    expect(wrapper.find('[data-testid="rail-wf"]').classes()).toContain("active");
    // 设计器载入点击的工作流（而非空态列表）
    const designer = wrapper.findComponent(WfDesigner);
    const design = designer.props("workflowDesign") as { workflowId: string | null };
    expect(design.workflowId).toBe(wf.id);
    // 选中节点归属项目解析含 workflows 摘要：selectedProjectId 不因 kind=workflow 落空
    expect(designer.props("projectLocator")).toStrictEqual(project.locator);
    await wrapper.find('[data-testid="rail-api"]').trigger("click");
    await flushPromises();
    expect(wrapper.findComponent(WfDesigner).exists()).toBe(false);
    expectAppShellAboveWorkspace();
  });

  it("设计器列表新建工作流后侧树同步出现（树摘要随 wfList 变更刷新）", async () => {
    const wrapper = await mountApp();
    await openLocalDir(wrapper);
    await flushPromises();
    // 选中接口 → selectedProjectId 就绪 → 切到工作流视图（设计器是工作流唯一创建入口）
    await flushPromises();
    await clickApiAndWait(wrapper);
    await wrapper.find('[data-testid="rail-wf"]').trigger("click");
    await flushPromises();
    // 建前树中无同名工作流（failingApi 是本文件共享单例，前面用例可能已建过别的流）
    expect(wrapper.find('[data-testid="tree-workflow"]').text()).not.toContain("设计器新建流");
    // 经设计器列表新建 → 侧树应同步出现该工作流（draft 色点）
    await wrapper.find('[data-testid="wf-new-name"]').setValue("设计器新建流");
    const designer = wrapper.findComponent(WfDesigner);
    const wfList = designer.props("wfList") as ReturnType<typeof useWfListStore>;
    const originalCreate = wfList.create.bind(wfList);
    let createTask: ReturnType<typeof originalCreate> | null = null;
    wfList.create = (...args) => {
      createTask = originalCreate(...args);
      return createTask;
    };
    try {
      await wrapper.find('[data-testid="wf-new-create"]').trigger("click");
      if (!createTask) throw new Error("Create button did not invoke the real wfList.create action");
      await createTask;
    } finally {
      wfList.create = originalCreate;
    }
    await vi.waitFor(() => {
      const created = wrapper.findAll('[data-testid="tree-workflow"]').find((n) => n.text().includes("设计器新建流"));
      expect(created).toBeDefined();
    });
    const nodes = wrapper.findAll('[data-testid="tree-workflow"]');
    const created = nodes.find((n) => n.text().includes("设计器新建流"));
    expect(created).toBeDefined();
    expect(created!.attributes("data-status")).toBe("draft");
  });

  it("设计器发布工作流后侧树状态色点同步（data-status: draft → published）", async () => {
    // 审查修复：生命周期迁移不改 wfList.items.length，树摘要须随设计器 status 变化刷新，
    // 否则侧树色点陈旧。真实链路：wf-publish → store.setStatus → api.wfSetStatus → 树刷新。
    const wrapper = await mountApp();
    await openLocalDir(wrapper);
    await flushPromises();
    // 直连替身建 draft 工作流后重开工作区刷新树（failingApi 为本文件共享单例，按名断言）
    const tree = await failingApi.treeGet();
    const project = projectByLabel(tree, "示例项目");
    const wf = await failingApi.wfCreate({ locator: project.locator, name: "生命周期流" });
    await openLocalDir(wrapper);
    await flushPromises();
    const findNode = () =>
      wrapper.findAll('[data-testid="tree-workflow"]').find((n) => n.text().includes("生命周期流"))!;
    expect(findNode().attributes("data-status")).toBe("draft");
    // 侧树打开工作流 → 设计器点「发布」
    const designStore = wrapper.findComponent(SideTree).props("workflowDesign") as ReturnType<typeof useWorkflowDesignStore>;
    const load = captureWorkflowLoad(designStore);
    await findNode().trigger("click");
    await load.settle();
    load.restore();
    const originalSetStatus = designStore.setStatus.bind(designStore);
    let statusTask: ReturnType<typeof originalSetStatus> | null = null;
    designStore.setStatus = (...args) => {
      statusTask = originalSetStatus(...args);
      return statusTask;
    };
    try {
      await wrapper.find('[data-testid="wf-publish"]').trigger("click");
      if (!statusTask) throw new Error("Publish button did not invoke the real workflowDesign.setStatus action");
      await statusTask;
    } finally {
      designStore.setStatus = originalSetStatus;
    }
    await vi.waitFor(() => expect(findNode().attributes("data-status")).toBe("published"));
    // 侧树色点同步为 published（修复前：同引用赋值不触发响应式 + 无 status watcher，
    // 树摘要陈旧为 draft）
    expect(findNode().attributes("data-status")).toBe("published");
    // 树 DTO 摘要确实重建（status 更新；failingApi 为共享单例，按 id 断言本流）
    const dto = await failingApi.treeGet();
    expect(projectByLabel(dto, "示例项目").workflows.find((item) => item.id === wf.id)).toMatchObject({
      id: wf.id, name: "生命周期流", status: "published",
    });
  });
});

// —— M3-B 任务 2：在线登录与服务器配置装配（入口在 TopBar，对话框由组合根渲染） ——
describe("App 在线模式装配（M3-B 任务 2）", () => {
  it("主页管理连接新增档案并登录：账户显示登录身份，退出登录后档案保留", async () => {
    try {
      const wrapper = await mountApp();
      // 主页 → 管理连接面板：新增连接（url + 昵称；轨三档案管理唯一入口）
      await wrapper.find('[data-testid="home-manage-connections"]').trigger("click");
      await flushPromises();
      await wrapper.find('[data-testid="connections-add"]').trigger("click");
      await wrapper.find('[data-testid="connections-url"]').setValue("http://127.0.0.1:8080");
      await wrapper.find('[data-testid="connections-name"]').setValue("团队服务器");
      await wrapper.find('[data-testid="connections-save"]').trigger("click");
      await flushPromises();
      // 行内「登录」：激活档案 + 打开登录对话框（a-modal 传送门渲染于 body）
      await wrapper.find('[data-testid="connection-login"]').trigger("click");
      await flushPromises();
      expect(bodyFind("online-body")).not.toBeNull();
      // 登录（memory 替身接受任意登录）→ 对话框切已登录区，连接行同步登录身份
      await expectBody("online-username").setValue("alice");
      await expectBody("online-password").setValue("password8");
      await expectBody("online-login-submit").trigger("click");
      await flushPromises();
      expect(expectBody("online-user").text()).toContain("示例用户");
      expect(wrapper.get('[data-testid="connection-logged-in"]').text()).toContain("示例用户");
      await expectBody("online-logout").trigger("click");
      await flushPromises();
      expect(bodyFind("online-login-form")).not.toBeNull();
      expect(wrapper.find('[data-testid="connection-logged-in"]').exists()).toBe(false);
      expect(wrapper.get('[data-testid="connection-login"]').text()).toBe("登录");
    } finally {
      // 清理：本用例写入的档案持久化不污染同文件后续用例
      localStorage.removeItem("apicc.onlineServers");
    }
  });

  it("LOGIN-001 零连接从主页进入连接管理，显示新增入口", async () => {
    localStorage.removeItem("apicc.onlineServers");
    const wrapper = await mountApp();
    await wrapper.get('[data-testid="home-manage-connections"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="connections-panel"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="connections-empty"]').text()).toContain("服务器");
    expect(wrapper.get('[data-testid="connections-add"]').text()).toContain("新增");
    expect(bodyFind("online-username")).toBeNull();
    expect(bodyFind("online-password")).toBeNull();
  });

  it("CI96 real offline tab retry shows its readable error again after dismissal and follows language changes", async () => {
    const wrapper = await mountApp();
    const locale = initI18n();
    const tabs = wrapper.findComponent(ProjectTabs).props("tabs") as ReturnType<typeof createTabsStore>;
    try {
      locale.setLocale("zh-CN");
      await tabs.openProjectTab({ kind: "online", workspaceId: "ci96-missing-session", name: "Synthetic offline workspace" }, { id: "ci96-project", name: "Synthetic offline project" });
      await flushPromises();
      expect(tabs.activeTabId).toBeNull();
      expect(tabs.offlineTabIds).toHaveLength(1);
      expect(wrapper.get('[data-testid="app-error"]').text()).toContain("项目签已标记离线");
      await wrapper.get('[data-testid="app-error-close"]').trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-testid="app-error"]').exists()).toBe(false);
      await wrapper.get('[data-testid="project-tab-0"]').trigger("click");
      await flushPromises();
      expect(tabs.error).toBe("online-workspace-session-missing");
      expect(tabs.activeTabId).toBeNull();
      expect(tabs.tabs).toHaveLength(1);
      expect(wrapper.get('[data-testid="app-error"]').text()).toContain("项目签已标记离线");
      locale.setLocale("en"); await flushPromises();
      expect(wrapper.get('[data-testid="app-error"]').text()).toContain("The project tab is offline");
      expect(wrapper.get('[data-testid="app-error"]').text()).not.toContain("online-workspace-session-missing");
    } finally { locale.setLocale("zh-CN"); }
  });

  it.each([
    ["design-invalid-json", "请先修正无效的 JSON 输入", "Fix the invalid JSON input"],
    ["online-workspace-session-missing", "项目签已标记离线", "The project tab is offline"],
  ])("F8 registered error %s uses readable labels and follows language changes", async (code, zh, en) => {
    const wrapper = await mountApp();
    const locale = initI18n();
    try {
      locale.setLocale("zh-CN");
      wrapper.findComponent(TopBar).props("reportError")(new Error(code));
      await flushPromises();
      expect(wrapper.get('[data-testid="app-error"]').text()).toContain(zh);
      locale.setLocale("en");
      await flushPromises();
      expect(wrapper.get('[data-testid="app-error"]').text()).toContain(en);
      expect(wrapper.get('[data-testid="app-error"]').text()).not.toContain(code);
      wrapper.findComponent(TopBar).props("reportError")(new Error("unknown-business-reason"));
      await flushPromises();
      expect(wrapper.get('[data-testid="app-error"]').text()).toContain("unknown-business-reason");
    } finally { locale.setLocale("zh-CN"); }
  });

  it("App 挂载即尝试恢复登录态（init→resume）：连接管理显示已登录身份", async () => {
    // 预置：替身登录 + 档案存储含激活服务器（模拟上次会话）→ App init 恢复
    await failingApi.onlineLogin({ baseUrl: "http://127.0.0.1:8080", username: "alice", password: "password8" });
    localStorage.setItem("apicc.onlineServers", JSON.stringify({
      active: "http://127.0.0.1:8080",
      servers: [{ baseUrl: "http://127.0.0.1:8080", name: "团队服务器" }],
    }));
    try {
      const wrapper = await mountApp();
      await flushPromises();
      await wrapper.get('[data-testid="home-manage-connections"]').trigger("click");
      expect(wrapper.get('[data-testid="connection-logged-in"]').text()).toContain("示例用户");
    } finally {
      localStorage.removeItem("apicc.onlineServers");
      await failingApi.onlineLogout();
    }
  });

  it("R7 主页工作区菜单锁定退出目标，支持取消和确认，保留其他工作区", async () => {
    const server = "http://127.0.0.1:8080";
    localStorage.removeItem("apicc.onlineServers");
    const workspaceClose = vi.spyOn(failingApi, "onlineWorkspaceClose");
    const wrapper = await mountApp();
    const online = wrapper.getComponent(OnlineLoginDialog).props("online");
    const tabs = wrapper.getComponent(ProjectTabs).props("tabs");
    try {
      online.addProfile(server, "团队服务器");
      await flushPromises();
      await online.login("alice", "password8");
      await online.refreshWorkspaces();
      const first = online.workspaces[0]!;
      await wrapper.get(`[data-testid="home-side-server-${server}"]`).trigger("click");
      await wrapper.get(`[data-testid="home-ws-${first.id}"]`).trigger("click");
      await flushPromises();
      const project = online.projects[0]!;
      await wrapper.get(`[data-testid="project-card-${project.id}"]`).trigger("click");
      await flushPromises();
      await wrapper.get('[data-testid="topbar-home"]').trigger("click");
      await wrapper.get(`[data-testid="home-side-server-${server}"]`).trigger("click");
      await flushPromises();

      const openAction = async (name: "online-migrate" | "online-exit") => {
        await wrapper.get('[data-testid="workspace-actions"]').trigger("click");
        await expectBody(name).trigger("click");
        await flushPromises();
      };
      await openAction("online-migrate");
      expect(expectBody("migrate-body").text()).toContain("拉取");
      online.migrateDialogOpen = false;
      await flushPromises();

      const dirtyPath = `${project.id}/collections/c/apis/a/api.yaml`;
      online.sessions[first.id]!.buffers[dirtyPath] = {
        path: dirtyPath, kind: "api", api: {} as never, raw: "", problems: [], version: 1, snapshot: "", loading: false,
      };
      await openAction("online-exit");
      expect(expectBody("online-exit-impact").text()).toContain(first.name);
      expect(expectBody("online-exit-tab-0").text()).toContain(project.name);
      expect(expectBody("online-exit-draft").text()).toContain("草稿");
      await expectBody("dialog-cancel").trigger("click");
      expect(workspaceClose).not.toHaveBeenCalled();
      expect(tabs.tabs).toHaveLength(1);

      await openAction("online-exit");
      online.sessions["another-workspace"] = {
        workspace: { id: "another-workspace", name: "另一工作区", myRole: "OWNER" },
        baseUrl: server, tree: null, projects: [], buffers: {}, activeEditorPath: null,
      };
      online.activeWorkspaceId = "another-workspace";
      await flushPromises();
      expect(expectBody("dialog-error").text()).toContain("已更改");
      await expectBody("dialog-confirm").trigger("click");
      expect(workspaceClose).not.toHaveBeenCalled();
      expect(tabs.tabs).toHaveLength(1);

      online.activeWorkspaceId = first.id;
      online.workspaces = [];
      await flushPromises();
      expect(wrapper.get('[data-testid="retained-online-workspace"]').text()).toContain(first.name);
      await wrapper.get('[data-testid="workspace-actions"]').trigger("click");
      expect(bodyFind("online-migrate")).toBeNull();
      await expectBody("online-exit").trigger("click");
      await flushPromises();
      await expectBody("dialog-cancel").trigger("click");
      online.loggedIn = false;
      online.user = null;
      await flushPromises();
      expect(wrapper.get('[data-testid="retained-online-workspace"]').text()).toContain(first.name);
      expect(wrapper.get('[data-testid="home-server-login"]').text().replace(/\s/g, "")).toBe("登录");
      await openAction("online-exit");
      await expectBody("dialog-confirm").trigger("click");
      await flushPromises();
      expect(workspaceClose).toHaveBeenCalledExactlyOnceWith({ workspaceId: first.id });
      expect(tabs.tabs).toHaveLength(0);
      expect(online.sessions[first.id]).toBeUndefined();
      expect(online.sessions["another-workspace"]).toBeDefined();
      expect(online.loggedIn).toBe(false);
    } finally {
      workspaceClose.mockRestore();
      localStorage.removeItem("apicc.onlineServers");
      await failingApi.onlineLogout();
    }
  });

  it("R7 从分组搜索全工作区，同名结果按分组打开完整项目定位", async () => {
    const originalTreeGet = failingApi.treeGet.bind(failingApi);
    const tree = await originalTreeGet();
    if (tree.kind !== "root") throw new Error("Fixture has no workspace tree");
    const originalGroup = tree.children.find((node) => node.kind === "group")!;
    const project = projectByLabel(tree, "示例项目");
    const otherGroupId = "00000000-0000-4000-8000-000000000733";
    const otherLocator = { ...project.locator, groupId: otherGroupId };
    const firstGroupName = "r7 分组甲";
    const secondGroupName = "r7 分组乙";
    const sameNameTree = { ...tree, children: [
      { ...originalGroup, label: firstGroupName, children: [project] },
      { ...originalGroup, id: otherGroupId, key: otherGroupId, label: secondGroupName, locator: { ...originalGroup.locator, groupId: otherGroupId }, children: [
        { ...project, key: `r7-${project.key}`, locator: otherLocator, children: [] },
      ] },
    ] };
    failingApi.treeGet = async () => sameNameTree;
    try {
      const wrapper = await mountApp();
      const workspace = wrapper.getComponent(HomeView).props("workspace");
      await workspace.open("/tmp/r7-project-search");
      await flushPromises();
      await wrapper.get(".group-select").trigger("click");
      const search = wrapper.get<HTMLInputElement>('input[data-testid="home-project-search"]');
      await search.setValue("no-such-project");
      expect(wrapper.text()).toContain("没有匹配的项目");
      await wrapper.get('[data-testid="home-clear-project-search"]').trigger("click");
      expect(search.element.value).toBe("");
      await search.setValue("示例");
      const cards = wrapper.findAll(`[data-testid="project-card-${project.id}"]`);
      expect(cards).toHaveLength(2);
      expect(cards.map((card) => card.get(".project-group").text())).toEqual([firstGroupName, secondGroupName]);
      const tabs = wrapper.getComponent(ProjectTabs).props("tabs");
      expect(tabs.tabs).toHaveLength(0);
      await cards[1]!.get(".card-name").trigger("click");
      await flushPromises();
      expect(tabs.activeTab).toMatchObject({ projectLocator: otherLocator });
    } finally {
      failingApi.treeGet = originalTreeGet;
    }
  });

  it("R7 跟随系统主题实时切换渲染与原生窗控，固定主题忽略系统变化", async () => {
    const dark = new EventTarget();
    Object.assign(dark, { matches: false });
    const changeSystemTheme = (matches: boolean) => dark.dispatchEvent(Object.assign(new Event("change"), { matches }));
    const matchMedia = window.matchMedia;
    const setWindowChromeTheme = vi.fn(async () => {});
    window.matchMedia = (query) => query === "(prefers-color-scheme: dark)" ? dark as MediaQueryList : matchMedia(query);
    failingApi.setWindowChromeTheme = setWindowChromeTheme;
    savePreference("system");
    try {
      const wrapper = await mountApp();
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(setWindowChromeTheme).toHaveBeenLastCalledWith("light");
      changeSystemTheme(true);
      await flushPromises();
      expect(document.documentElement.dataset.theme).toBe("dark");
      expect(setWindowChromeTheme).toHaveBeenLastCalledWith("dark");
      await wrapper.get('[data-testid="theme-toggle"]').trigger("click");
      await expectBody("theme-option-light").trigger("click");
      expect(document.documentElement.dataset.theme).toBe("light");
      const callCount = setWindowChromeTheme.mock.calls.length;
      changeSystemTheme(false);
      changeSystemTheme(true);
      await flushPromises();
      expect(document.documentElement.dataset.theme).toBe("light");
      expect(setWindowChromeTheme).toHaveBeenCalledTimes(callCount);
    } finally {
      window.matchMedia = matchMedia;
      delete failingApi.setWindowChromeTheme;
      savePreference("system");
    }
  });
});

// —— 计划 C 任务 5：启动按签恢复（apicc.projectTabs 签表驱动；lastWorkspace 单槽退役）——
// 本组用例需在挂载前播种持久化键，而 mountApp 会清签表键——用不清键的挂装变体（App.vue
// 模块此时已被其他用例求值，window.apicc 注入先于模块求值的约束早已满足）。
async function mountAppKeepingStorage() {
  const { default: App } = await import("../../src/renderer/src/App.vue");
  const wrapper = mount(App, { global: { plugins: [initI18n().i18n] } });
  await flushPromises();
  return wrapper;
}

describe("App 启动按签恢复（计划 C 任务 5：签表驱动）", () => {
  it("R7 在线项目签只在保存的连接恢复，另一服务器同编号项目需单独打开", async () => {
    const serverA = "http://127.0.0.1:8080";
    const serverB = "http://127.0.0.1:8081";
    const workspaceId = "ws-online-1";
    const selector = '[data-testid="project-card-300"]';
    const persistServers = (active: string) => localStorage.setItem("apicc.onlineServers", JSON.stringify({
      active, servers: [{ baseUrl: `${serverA}/`, name: "服务器 A" }, { baseUrl: serverB, name: "服务器 B" }],
    }));
    const open = vi.spyOn(failingApi, "onlineWorkspaceOpen");
    const login = async (baseUrl: string) => failingApi.onlineLogin({ baseUrl, username: "alice", password: "password8" });
    try {
      await login(`${serverA}/`);
      persistServers(`${serverA}/`);
      const first = await mountApp();
      await first.get(`[data-testid="home-side-server-${serverA}/"]`).trigger("click");
      await first.get(`[data-testid="home-ws-${workspaceId}"]`).trigger("click");
      await flushPromises();
      await first.get(selector).trigger("click");
      await flushPromises();
      const savedA = JSON.parse(localStorage.getItem("apicc.projectTabs")!);
      expect(savedA.tabs[0].workspaceRef.baseUrl).toBe(serverA);
      expect(savedA.activeIndex).toBe(0);
      first.unmount();

      open.mockClear();
      await login(serverB);
      persistServers(serverB);
      const second = await mountAppKeepingStorage();
      expect(open).not.toHaveBeenCalled();
      expect(second.get('[data-testid="project-tab-0"]').attributes("data-offline")).toBe("true");
      await second.get(`[data-testid="home-side-server-${serverB}"]`).trigger("click");
      await second.get(`[data-testid="home-ws-${workspaceId}"]`).trigger("click");
      await flushPromises();
      await second.get('[data-testid="project-tab-0"]').trigger("click");
      expect(second.get('[data-testid="topbar-home"]').attributes("aria-selected")).toBe("true");
      await second.get(selector).trigger("click");
      await flushPromises();
      const tabs = second.getComponent(ProjectTabs).props("tabs") as ReturnType<typeof createTabsStore>;
      expect(tabs.tabs.map((tab) => tab.workspaceRef)).toMatchObject([{ baseUrl: serverA }, { baseUrl: serverB }]);
      expect(tabs.activeTab?.workspaceRef).toMatchObject({ baseUrl: serverB });
      const online = second.getComponent(OnlineLoginDialog).props("online");
      const path = "300/collections/c/apis/a/api.yaml";
      const session = online.sessions[workspaceId]!;
      session.buffers[path] = { path, kind: "api", api: {} as never, raw: "", problems: [], version: 1, snapshot: "", loading: false };
      expect(tabs.projectHasDrafts(tabs.tabs[0]!.tabId)).toBe(false);
      expect(tabs.projectHasDrafts(tabs.tabs[1]!.tabId)).toBe(true);
      await second.get('[data-testid="topbar-home"]').trigger("click");
      await second.get(`[data-testid="home-side-server-${serverB}"]`).trigger("click");
      await flushPromises();
      await second.get('[data-testid="workspace-actions"]').trigger("click");
      await expectBody("online-exit").trigger("click");
      await flushPromises();
      expect(expectBody("online-exit-draft").text()).toContain("草稿");
      expect(bodyFind("online-exit-tab-1")).toBeNull();
      await expectBody("dialog-cancel").trigger("click");
      second.unmount();

      await login(`${serverA}/`);
      persistServers(`${serverA}/`);
      const third = await mountAppKeepingStorage();
      await third.get('[data-testid="project-tab-0"]').trigger("click");
      await flushPromises();
      expect(third.getComponent(ProjectTabs).props("tabs").activeTab?.workspaceRef).toMatchObject({ baseUrl: serverA });
      expect(third.get('[data-testid="project-tab-1"]').attributes("data-offline")).toBe("true");
    } finally {
      open.mockRestore();
      localStorage.removeItem("apicc.projectTabs");
      localStorage.removeItem("apicc.onlineServers");
      await failingApi.onlineLogout();
    }
  });

  it("R7 旧在线签仍可从唯一连接恢复，多个连接时从主页显式绑定", async () => {
    const server = "http://127.0.0.1:8080";
    const legacy = { tabs: [{ workspaceRef: { kind: "online", workspaceId: "ws-online-1", name: "旧工作区" }, projectId: "300", projectName: "旧项目" }], activeIndex: 0 };
    await failingApi.onlineLogin({ baseUrl: server, username: "alice", password: "password8" });
    const servers = [{ baseUrl: server, name: "团队服务器" }];
    localStorage.setItem("apicc.onlineServers", JSON.stringify({ active: server, servers }));
    localStorage.setItem("apicc.projectTabs", JSON.stringify(legacy));
    try {
      const single = await mountAppKeepingStorage();
      expect(single.getComponent(ProjectTabs).props("tabs").activeTab?.workspaceRef).toMatchObject({ baseUrl: server });
      single.unmount();

      localStorage.setItem("apicc.onlineServers", JSON.stringify({ active: server, servers: [...servers, { baseUrl: "http://127.0.0.1:8081", name: "另一服务器" }] }));
      localStorage.setItem("apicc.projectTabs", JSON.stringify(legacy));
      const multiple = await mountAppKeepingStorage();
      expect(multiple.get('[data-testid="project-tab-0"]').attributes("data-offline")).toBe("true");
      await multiple.get(`[data-testid="home-side-server-${server}"]`).trigger("click");
      await multiple.get('[data-testid="home-ws-ws-online-1"]').trigger("click");
      await flushPromises();
      const online = multiple.getComponent(OnlineLoginDialog).props("online");
      const path = "300/collections/c/apis/a/api.yaml";
      const session = online.sessions["ws-online-1"]!;
      session.buffers[path] = { path, kind: "api", api: {} as never, raw: "", problems: [], version: 1, snapshot: "", loading: false };
      const tabs = multiple.getComponent(ProjectTabs).props("tabs");
      expect(tabs.projectHasDrafts(tabs.tabs[0]!.tabId)).toBe(false);
      await multiple.get('[data-testid="tab-close-0"]').trigger("click");
      await flushPromises();
      expect(session.buffers[path]).toBeDefined();
      multiple.unmount();

      localStorage.setItem("apicc.projectTabs", JSON.stringify(legacy));
      const rebound = await mountAppKeepingStorage();
      await rebound.get(`[data-testid="home-side-server-${server}"]`).trigger("click");
      await rebound.get('[data-testid="home-ws-ws-online-1"]').trigger("click");
      await flushPromises();
      await rebound.get('[data-testid="project-card-300"]').trigger("click");
      await flushPromises();
      const reboundTabs = rebound.getComponent(ProjectTabs).props("tabs");
      expect(reboundTabs.tabs).toHaveLength(1);
      expect(reboundTabs.activeTab?.workspaceRef).toMatchObject({ baseUrl: server });
    } finally {
      localStorage.removeItem("apicc.projectTabs");
      localStorage.removeItem("apicc.onlineServers");
      await failingApi.onlineLogout();
    }
  });
  it("持久化本地签 → 挂载重开目录并激活该签（视图离开主页）；正式 moduleMemory locator 按项目恢复", async () => {
    const treeDto = await failingApi.treeGet();
    const project = projectByLabel(treeDto, "示例项目");
    const collection = project.children!.find((c) => c.kind === "collection")!;
    const apiNode = collection.children!.find((n) => n.kind === "api")!;
    // 正式树：本地签（内存替身对非工作区目录回退种子内存态）+ root/ProjectLocator scoped memory。
    localStorage.setItem("apicc.projectTabs", JSON.stringify({
      tabs: [{ workspaceRef: { kind: "local", dir: "/tmp/ws-restored" }, projectLocator: project.locator, projectName: "示例项目" }],
      activeIndex: 0,
    }));
    const memory = useModuleMemoryStore();
    memory.activateProject("/tmp/ws-restored", project.locator);
    memory.apiTree.lastApiLocator = { ...apiNode.locator, folderIds: [...apiNode.locator.folderIds] };
    memory.touch();
    const originalWsOpen = failingApi.wsOpen.bind(failingApi);
    let workspaceOpenTask: ReturnType<typeof originalWsOpen> | null = null;
    failingApi.wsOpen = (...args) => {
      workspaceOpenTask = originalWsOpen(...args);
      return workspaceOpenTask;
    };
    try {
      const wrapper = await mountAppKeepingStorage();
      if (!workspaceOpenTask) throw new Error("tabs.restore did not invoke the real wsOpen action");
      await workspaceOpenTask;
      const editorOf = () => wrapper.findComponent(RequestEditor).props("editor") as { apiId: string | null };
      await vi.waitFor(() => {
      // 签栏恢复：持久化签渲染且处于激活态
        expect(wrapper.find('[data-testid="project-tab-0"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="project-tab-0"]').attributes("data-active")).toBe("true");
      // 视图离开主页（签驱动重开），接口模块就位
        expect(wrapper.find('[data-testid="home-view"]').exists()).toBe(false);
        expect(wrapper.find('[data-testid="module-rail"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="editor-pane"]').exists()).toBe(true);
        expect(editorOf().apiId).toBe(apiNode.id);
      });
    } finally {
      failingApi.wsOpen = originalWsOpen;
      localStorage.removeItem("apicc.projectTabs");
      localStorage.removeItem("apicc.moduleMemory");
    }
  });

  it("lastWorkspace 单槽退役：残留键不再驱动恢复（无签表 → 停留主页，键值原样不被改写）", async () => {
    localStorage.setItem("apicc.lastWorkspace", JSON.stringify({ source: "local", dir: "/tmp/whatever" }));
    try {
      const wrapper = await mountAppKeepingStorage();
      await flushPromises();
      expect(wrapper.find('[data-testid="home-view"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid^="project-tab-"]').exists()).toBe(false);
      expect(localStorage.getItem("apicc.lastWorkspace")).toBe(JSON.stringify({ source: "local", dir: "/tmp/whatever" }));
    } finally {
      localStorage.removeItem("apicc.lastWorkspace");
    }
  });
});

// —— M7-B 任务 1：插件管理视图装配（裁定①：路由 /plugins + 侧栏入口，管理类视图）——
describe("App 插件视图装配（M7-B 任务 1）", () => {
  it("插件入口（M9-C 裁定 D5）：顶栏设置抽屉打开插件管理，恒可用（不依赖工作区）", async () => {
    const wrapper = await mountApp();
    // 主页视图不渲染 rail（用户裁定）——设置抽屉不依赖工作区
    await wrapper.find('[data-testid="settings-toggle"]').trigger("click");
    await flushPromises();
    expect(bodyFind("plugins-view")).not.toBeNull();
    // fixture 混合清单上屏（loaded/failed 各至少一）
    expect(document.body.querySelectorAll('[data-testid="plugins-row"]').length).toBeGreaterThanOrEqual(2);
  });
});

// —— M9-D：测试模块（单接口用例 运行/压测 + 场景用例），取代原压测栏 ——

/** 压测报告夹具（App 装配链路用；字段与 core StressReportSchema 对齐）。 */
function stressReportFixture(): StressReport {
  return {
    concurrency: 1,
    totalRequests: 4,
    ok: 4,
    failed: 0,
    durationMs: 100,
    rps: 40,
    latency: { min: 1, avg: 2, max: 3, p50: 2, p90: 3, p95: 3, p99: 3 },
    statusDist: { "200": 4 },
    errorKinds: {},
    failures: { transport: 0, http: 0, script: 0, assertion: 0, config: 0, aborted: 0 },
    scriptLatency: { min: 0, avg: 0, max: 0, p50: 0, p90: 0, p95: 0, p99: 0 },
    iterationLatency: { min: 1, avg: 2, max: 3, p50: 2, p90: 3, p95: 3, p99: 3 },
    startedAt: 0,
    finishedAt: 100,
  };
}

describe("App 测试模块装配（M9-D）", () => {
  it("R19 Fix1 rejects late evidence after same-project request-tab A-B-A navigation", async () => {
    const wrapper = await mountApp(); await openLocalDir(wrapper); await clickApiAndWait(wrapper);
    const editor = wrapper.findComponent(RequestEditor).props("editor") as ReturnType<typeof useEditorStore>;
    const requestTabs = wrapper.findComponent(RequestTabs).props("tabs") as ReturnType<typeof createRequestTabsStore>;
    const locator = { ...editor.locator!, folderIds: [...editor.locator!.folderIds] };
    const tabA = requestTabs.activeId!;
    await wrapper.get('[data-testid="rail-test"]').trigger("click"); await flushPromises();
    const panel = wrapper.findComponent(CasePanel); const cases = panel.props("cases"); const debug = panel.props("debug")!;
    const first = editor.api!.cases[0]!;
    const target = cases.addCase({ name: "迟到证据目标", scope: "base" });
    const draft = JSON.stringify(editor.api);
    const identity = { projectId: locator.projectId, definitionRevision: "historical", locator: {
      collectionId: locator.collectionId, folderIds: locator.folderIds, apiId: locator.apiId, caseId: target.id, scope: target.scope,
    } };
    await wrapper.get('[data-testid="rail-api"]').trigger("click");
    await wrapper.get('[data-testid="request-tab-new-free"]').trigger("click"); await flushPromises();
    const tabB = requestTabs.activeId!; expect(tabB).not.toBe(tabA);
    // The locate's own B→A activation is legitimate and must not invalidate itself.
    await wrapper.get('[data-testid="rail-run"]').trigger("click");
    wrapper.findComponent(RunView).vm.$emit("locate-evidence", identity);
    await vi.waitFor(() => expect(wrapper.findComponent(CasePanel).exists()).toBe(true));
    expect(requestTabs.activeId).toBe(tabA);
    expect(wrapper.get('[data-testid="case-row"].active').find('input').element.value).toBe(target.name);

    await wrapper.get('[data-testid="rail-api"]').trigger("click");
    await wrapper.get(`[data-testid="request-tab-${tabB}"]`).trigger("click"); await flushPromises();
    const originalLoad = editor.load.bind(editor);
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false; let armed = true;
    editor.load = async (...args) => {
      await originalLoad(...args);
      if (armed) { armed = false; entered = true; await gate; }
    };
    try {
      await wrapper.get('[data-testid="rail-run"]').trigger("click");
      wrapper.findComponent(RunView).vm.$emit("locate-evidence", identity);
      await vi.waitFor(() => expect(entered).toBe(true));
      expect(requestTabs.activeId).toBe(tabA);
      await wrapper.get('[data-testid="rail-api"]').trigger("click");
      await wrapper.get(`[data-testid="request-tab-${tabB}"]`).trigger("click"); await flushPromises();
      await wrapper.get(`[data-testid="request-tab-${tabA}"]`).trigger("click"); await flushPromises();
      await wrapper.get('[data-testid="rail-test"]').trigger("click"); await flushPromises();
      await wrapper.findAll('[data-testid="case-row"]')[0]!.trigger("click");
      await wrapper.get('[data-testid="rail-api"]').trigger("click");
      release(); await flushPromises(); await flushPromises();
      expect(wrapper.findComponent(CasePanel).exists()).toBe(false);
      expect(wrapper.findComponent(RequestEditor).exists()).toBe(true);
      expect(requestTabs.activeId).toBe(tabA); expect(editor.locator).toEqual(locator);
      expect(cases.selectedCase).toEqual({ caseId: first.id, scope: first.scope });
      expect(debug.requestTabState(requestTabs.tabs[tabA]!).selectedCase).toEqual({ caseId: first.id, scope: first.scope });
      expect(JSON.stringify(editor.api)).toBe(draft); expect(editor.dirty).toBe(true);
    } finally { release(); editor.load = originalLoad; }
  });
  it("R19 evidence locate reveals the exact case from suites/history and respects dirty pane cancellation", async () => {
    const wrapper = await mountApp(); await openLocalDir(wrapper); await clickApiAndWait(wrapper);
    const editor = wrapper.findComponent(RequestEditor).props("editor") as ReturnType<typeof useEditorStore>;
    const locator = { ...editor.locator!, folderIds: [...editor.locator!.folderIds] };
    const memory = wrapper.findComponent(SideTree).props("moduleMemory")!;
    await wrapper.get('[data-testid="rail-test"]').trigger("click"); await flushPromises();
    const panel = wrapper.findComponent(CasePanel);
    const cases = panel.props("cases"); const debug = panel.props("debug")!;
    const target = cases.addCase({ name: "精确定位脏用例", scope: "base" });
    const tab = debug.requestTabForSession(editor.activeKey!)!;
    debug.requestTabState(tab).selectedCase = { caseId: editor.api!.cases[0]!.id, scope: "base" };
    const draft = JSON.stringify(editor.api);
    const identity = { projectId: locator.projectId, definitionRevision: "historical", locator: {
      collectionId: locator.collectionId, folderIds: locator.folderIds, apiId: locator.apiId, caseId: target.id, scope: target.scope,
    } };
    await wrapper.get('[data-testid="test-tab-suites"]').trigger("click"); await flushPromises();
    wrapper.findComponent(TestView).vm.$emit("locate-evidence", identity);
    await vi.waitFor(() => expect(wrapper.findComponent(CasePanel).exists()).toBe(true));
    const assertLocated = () => {
      expect(wrapper.get('[data-testid="test-tab-api-cases"]').classes()).toContain("active");
      expect(wrapper.get('[data-testid="case-row"].active').find('input').element.value).toBe(target.name);
      expect(editor.locator).toEqual(locator); expect(JSON.stringify(editor.api)).toBe(draft); expect(editor.dirty).toBe(true);
      expect(memory.test.apiLocator).toEqual(locator); expect(memory.apiTree.lastApiLocator).toEqual(locator);
      expect(wrapper.find('[data-testid="test-navigation-list"] .api-item.active').exists()).toBe(true);
    };
    assertLocated();
    const testing = wrapper.findComponent(TestView).props("testing")!;
    await wrapper.get('[data-testid="test-tab-suites"]').trigger("click"); await flushPromises();
    await testing.newSuite("尚未保存的套件");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      await wrapper.get('[data-testid="rail-run"]').trigger("click");
      wrapper.findComponent(RunView).vm.$emit("locate-evidence", identity); await flushPromises();
      expect(wrapper.findComponent(RunView).exists()).toBe(true); expect(testing.dirty).toBe(true);
      expect(memory.test.pane).toBe("suites"); expect(JSON.stringify(editor.api)).toBe(draft);
      confirm.mockReturnValue(true);
      wrapper.findComponent(RunView).vm.$emit("locate-evidence", identity);
      await vi.waitFor(() => expect(wrapper.findComponent(CasePanel).exists()).toBe(true));
      assertLocated(); expect(testing.dirty).toBe(false);
    } finally { confirm.mockRestore(); }
  });
  it("rail-test 打开测试模块：单接口用例面板选接口后可编辑，case-run 运行结果内嵌上屏", async () => {
    const wrapper = await mountApp();
    await openLocalDir(wrapper);
    await flushPromises();
    // 选中种子接口（作用域化树：collection 展开后点接口）
    await flushPromises();
    await clickApiAndWait(wrapper);
    await flushPromises();
    // 测试模块：用例面板渲染（用例列表来自当前接口）
    await wrapper.find('[data-testid="rail-test"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="test-view"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="case-panel"]').exists()).toBe(true);
    // 单条用例「运行」：结果内嵌上屏（memory 替身断言恒通过）
    const runBtn = wrapper.find('[data-testid^="case-run-"]');
    const debug = wrapper.findComponent(CasePanel).props("debug") as ReturnType<typeof useDebugStore>;
    const originalRunCase = debug.runCase.bind(debug);
    let runTask: ReturnType<typeof originalRunCase> | null = null;
    debug.runCase = (...args) => {
      runTask = originalRunCase(...args);
      return runTask;
    };
    try {
    await runBtn.trigger("click");
      if (!runTask) throw new Error("Case Run did not invoke the real debug.runCase action");
      await runTask;
      await flushPromises();
    } finally {
      debug.runCase = originalRunCase;
    }
    expect(wrapper.find('[data-testid="test-result"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="response-outcome"]').exists()).toBe(true);
  });

  it("用例行「压测」：内嵌 StressPanel 渲染并绑定当前接口（apiId/cases/envs 预选该用例）", async () => {
    failingApi.nodeCreate = realNodeCreate;
    try {
      const wrapper = await mountApp();
      await openLocalDir(wrapper);
      await flushPromises();
      await clickApiAndWait(wrapper);
      await flushPromises();
      await wrapper.find('[data-testid="rail-test"]').trigger("click");
      await flushPromises();
      failingApi.stressRun = createStressRunInvoker(async input => {
        if (!('kind' in input)) throw new Error('expected plan');
        const report = stressV2Report(); report.projectId = input.projectLocator.projectId; report.target = input.plan.target; report.plan = input.plan;
        return { ok: true, kind: 'plan', runId: report.runId, report, file: 'stress-x.json' };
      });
      // 用例行点「压测」：内嵌 StressPanel + 预选该用例
      const stressBtn = wrapper.find('[data-testid^="case-stress-"]');
      const caseId = stressBtn.attributes("data-case-id") as string;
      await stressBtn.trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-testid="stress-workbench"]').exists()).toBe(true);
      const panel = wrapper.findComponent(StressPanel);
      const apiId = wrapper.find('[data-testid="tree-api"]').attributes("data-node-id") as string;
      expect((panel.props("apiLocator") as { apiId: string }).apiId).toBe(apiId);
      const selectedCases = panel.props("cases") as Array<{ id: string; name: string }>;
      const seedTree = await failingApi.treeGet();
      const seedProject = projectByLabel(seedTree, "示例项目");
      const seedCollection = seedProject.children!.find((node) => node.kind === "collection");
      if (seedCollection?.kind !== "collection") throw new Error("Seed project has no collection");
      const seedApi = seedCollection.children!.find((node) => node.kind === "api");
      if (seedApi?.kind !== "api") throw new Error("Seed collection has no API");
      const apiDetail = await failingApi.apiGet(seedApi.locator);
      const selectedCase = apiDetail.api.cases.find((candidate) => candidate.id === caseId);
      expect(selectedCases).toEqual([expect.objectContaining({ id: caseId, name: selectedCase?.name })]);
      const stress = panel.props("stress") as { form: { caseId: string; concurrency: number } };
      expect(stress.form.caseId).toBe(caseId);
      // 压测跑一轮出报告，返回用例再进入保留（store 会话不随视图切换清空）
      await wrapper.find('[data-testid="stress-plan-start"]').trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-testid="stress-report"]').exists()).toBe(true);
      await wrapper.find('[data-testid="test-back-to-cases"]').trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-testid="case-panel"]').exists()).toBe(true);
      // 切接口：压测会话清空（clear 裁定）——新建第二接口并选中
      await openNewApiFromContainer(wrapper, "示例集合");
      await submitNewApiDraft(wrapper, "第二接口");
      await vi.waitFor(() => expect(wrapper.find('[data-testid="request-editor"]').attributes("data-source-kind")).toBe("asset"));
      await flushPromises();
      // 新接口在测试模块：进入压测上下文前报告已清空
      await wrapper.get('[data-testid="rail-test"]').trigger("click");
      await flushPromises();
      const newApiBtn = wrapper.findAll('[data-testid^="test-api-"]').find((button) => button.text().includes("第二接口"));
      if (!newApiBtn) throw new Error("The new API did not appear in the test sidebar");
      const caseEditor = wrapper.findComponent(CasePanel).props("editor") as ReturnType<typeof import("../../src/renderer/src/stores/editor.js").useEditorStore>;
      const originalLoad = caseEditor.load.bind(caseEditor);
      let clickedLoad: ReturnType<typeof originalLoad> | null = null;
      caseEditor.load = (...args) => (clickedLoad = originalLoad(...args));
      try {
        await newApiBtn.trigger("click");
        if (!clickedLoad) throw new Error("Test sidebar click did not load the selected API");
        await clickedLoad;
      } finally { caseEditor.load = originalLoad; }
      await flushPromises();
      const stressBtn2 = wrapper.find('[data-testid^="case-stress-"]');
      await stressBtn2.trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-testid="stress-report"]').exists()).toBe(false);
    } finally {
      failingApi.nodeCreate = async () => { throw new Error("接口创建失败（测试注入）"); };
    }
  });

  it("场景用例：未打开接口也能进入同项目工作台，主页往返仍可用，设计器入口复用同一工作台", async () => {
    const wrapper = await mountApp();
    await openLocalDir(wrapper);
    await flushPromises();
    // 建（或复用）一条工作流后进入测试模块场景页签
    const treeDto = await failingApi.treeGet();
    const project = projectByLabel(treeDto, "示例项目");
    const wf = await failingApi.wfCreate({ locator: project.locator, name: "场景流" });
    // 直建工作流后重开目录刷新树摘要（场景清单取自 workspace.tree）
    await openLocalDir(wrapper);
    await flushPromises();
    await flushPromises();
    await wrapper.get('[data-testid="topbar-home"]').trigger('click'); await flushPromises();
    const tabs = wrapper.findComponent(ProjectTabs).props('tabs') as ReturnType<typeof createTabsStore>;
    await tabs.activateTab(tabs.tabs[0]!.tabId);
    await flushPromises();
    await wrapper.find('[data-testid="rail-test"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-testid="test-tab-scenario"]').trigger("click");
    await flushPromises();
    const stressButton = wrapper.findAll('[data-testid="test-scenario-stress"]').find(button => button.element.closest('.scenario-row')?.textContent?.includes('场景流'))!;
    expect(stressButton.attributes('disabled')).toBeUndefined();
    await stressButton.trigger('click'); await flushPromises();
    expect(wrapper.find('[data-testid="stress-workbench"]').exists()).toBe(true);
    expect(wrapper.findComponent(StressPanel).props('stress').plan!.target).toEqual({ kind: 'workflow', workflowId: wf.id });
    expect(wrapper.findComponent(StressPanel).props('apiLocator')).toBeNull();
    await wrapper.get('[data-testid="test-back-to-cases"]').trigger('click'); await flushPromises();
    // 运行：切到工作流模块且设计器载入该流
    const designStore = wrapper.findComponent(SideTree).props("workflowDesign") as ReturnType<typeof useWorkflowDesignStore>;
    const load = captureWorkflowLoad(designStore);
    const runButton = wrapper.findAll('[data-testid^="test-scenario-run-"]')
      .find((button) => button.element.closest(".scenario-row")?.textContent?.includes("场景流"));
    if (!runButton) throw new Error("Scenario workflow run button was not rendered");
    await runButton.trigger("click");
    await load.settle();
    load.restore();
    expect(wrapper.find('[data-testid="rail-wf"]').classes()).toContain("active");
    const design = wrapper.findComponent(WfDesigner).props("workflowDesign") as { workflowId: string | null };
    expect(design.workflowId).toBe(wf.id);
    await wrapper.get('[data-testid="wf-stress"]').trigger('click'); await flushPromises();
    expect(wrapper.find('[data-testid="stress-workbench"]').exists()).toBe(true);
  });
});

// —— M9-A1：环境管理新建环境后，调试环境选择器（editor.envs）同步刷新 ——
describe("App 环境联动（M9-A1）", () => {
  it("环境模块新建环境后，调试选择器可见该环境", async () => {
    const wrapper = await mountApp();
    await openLocalDir(wrapper);
    await flushPromises();
    await flushPromises();
    await clickApiAndWait(wrapper);
    await flushPromises();
    // 选中接口时环境清单为空（种子项目无环境）
    const editorOf = () =>
      wrapper.findComponent(RequestEditor).props("editor") as { envs: Array<{ id: string; name: string }> };
    expect(editorOf().envs).toEqual([]);
    // 环境模块新建环境
    await wrapper.find('[data-testid="rail-envs"]').trigger("click");
    await expectBody("manage-environments").trigger("click");
    await flushPromises();
    await wrapper.find('[data-testid="env-new"]').trigger("click");
    await flushPromises();
    await expectBody("env-name-input").setValue("prod");
    const envs = wrapper.findComponent(EnvPanel).props("envs") as ReturnType<typeof useEnvsStore>;
    const originalCreate = envs.create.bind(envs);
    let envCreateTask: ReturnType<typeof originalCreate> | null = null;
    envs.create = (...args) => {
      envCreateTask = originalCreate(...args);
      return envCreateTask;
    };
    try {
      await expectBody("env-modal-confirm").trigger("click");
      if (!envCreateTask) throw new Error("Environment confirmation did not invoke the real envs.create action");
      await envCreateTask;
    } finally {
      envs.create = originalCreate;
    }
    await vi.waitFor(() => expect(envs.envs.map((entry) => entry.name)).toContain("prod"));
    // 回调试模块：选择器数据源（editor.envs）已含新环境
    await wrapper.find('[data-testid="rail-api"]').trigger("click");
    await vi.waitFor(() => expect(editorOf().envs.map((entry) => entry.name)).toContain("prod"));
    expect(editorOf().envs.map((e) => e.name)).toContain("prod");
  });
});


// —— 计划 C 任务 6（规格勘误口径）：切项目签的工作流草稿确认——tabs.activateTab 离开当前
// 项目上下文前经 confirmWorkflowDraft 钩子弹既有 ConfirmDialog；确认丢弃 = 设计器会话卸载。
// 注意（轨一 id 布局）：项目在树/主页卡片按 UUID 字典序——首签不保证是示例项目，本组用例
// 一律按项目名定位签。置于文件末尾：用例会向共享替身工作区直建第二项目（结束即删，但与
// 仍挂载组件的收尾写盘存在竞态），不把该足迹暴露给文件内更早的既有用例。
describe("App 切签工作流草稿确认（计划 C 任务 6）", () => {
  async function seedSecondProject(name: string): Promise<ProjectLocator> {
    const treeDto = await failingApi.treeGet();
    failingApi.nodeCreate = realNodeCreate;
    try {
      const group = treeDto.children!.find((node) => node.kind === "group");
      if (!group || group.kind !== "group") throw new Error("Memory workspace is missing its group");
      const created = await failingApi.nodeCreate({ kind: "project", parent: group.locator, name });
      if (created.kind !== "project") throw new Error("Memory API did not create a project");
      return created.locator;
    } finally {
      failingApi.nodeCreate = async () => { throw new Error("接口创建失败（测试注入）"); };
    }
  }

  /** 按项目名定位签元素（轮询等成签渲染；签文本=项目名）。 */
  async function tabFor(wrapper: VueWrapper, name: string) {
    let found: DOMWrapper<Element> | undefined;
    await vi.waitFor(() => {
      found = wrapper.findAll('[data-testid^="project-tab-"]').find((tab) => tab.text().includes(name));
      expect(found).toBeDefined();
    });
    if (!found) throw new Error(`项目签未找到: ${name}`);
    return found;
  }

  /** 主页点目标项目卡片成签并激活（无草稿源时干净切换；已活跃则 no-op）。 */
  async function openSecondProjectTab(wrapper: VueWrapper, name: string) {
    await wrapper.find('[data-testid="topbar-home"]').trigger("click");
    await flushPromises();
    const card = wrapper.findAll('[data-testid^="project-card-"]').find((candidate) => candidate.text().includes(name));
    if (!card) throw new Error(`项目卡片未找到: ${name}`);
    const tabs = wrapper.findComponent(ProjectTabs).props("tabs") as ReturnType<typeof createTabsStore>;
    const original = tabs.openProjectTab.bind(tabs);
    let openTask: ReturnType<typeof original> | null = null;
    tabs.openProjectTab = (...args) => {
      openTask = original(...args);
      return openTask;
    };
    try {
      await card.trigger("click");
      if (!openTask) throw new Error(`Opening project card did not invoke tabs.openProjectTab: ${name}`);
      await openTask;
    } finally {
      tabs.openProjectTab = original;
    }
    const tab = await tabFor(wrapper, name);
    expect(tab.classes()).toContain("active");
  }

  it("dirty 时切走当前签：确认前不切换；取消保持；确认丢弃后切签且设计器会话卸载", async () => {
    const targetProject = await seedSecondProject("切签目标项目");
    // 脏流建在示例项目（被离开的签）名下——确认钩子的归属过滤按树 workflows 摘要判定
    const treeDto = await failingApi.treeGet();
    const demoProject = projectByLabel(treeDto, "示例项目");
    const wfA = await failingApi.wfCreate({ locator: demoProject.locator, name: "切签脏流" });
    try {
      const wrapper = await mountApp();
      await openLocalDir(wrapper);
      await flushPromises();
      await openSecondProjectTab(wrapper, "切签目标项目");
      await openSecondProjectTab(wrapper, "示例项目");
      const designStore = wrapper.findComponent(SideTree).props("workflowDesign") as {
        workflowId: string | null;
        dirty: boolean;
      };
      // 两个项目各成签（首卡随机——openLocalDir 只点首卡；均无草稿源，干净切换）
      const tabA = await tabFor(wrapper, "示例项目");
      expect(tabA.classes()).toContain("active");
      await wrapper.findAll('[data-testid="tree-workflow"]').find((n) => n.text().includes("切签脏流"))!.trigger("click");
      await flushPromises();
      await wrapper.find('[data-testid="wf-add-request"]').trigger("click");
      await flushPromises();
      expect(designStore.dirty).toBe(true);
      expect(designStore.workflowId).toBe(wfA.id);
      const tabs = wrapper.findComponent(ProjectTabs).props("tabs") as ReturnType<typeof createTabsStore>;
      const tabAId = tabs.tabs.find((tab) => tab.projectName === "示例项目")!.tabId;
      // A → 主页 → B 仍按保留上下文 A 检查工作流草稿。
      await wrapper.get('[data-testid="topbar-home"]').trigger("click");
      expect(wrapper.find('[data-testid="home-view"]').exists()).toBe(true);
      const tabB = await tabFor(wrapper, "切签目标项目");
      await tabB.trigger("click");
      await flushPromises();
      expect(expectBody("dialog-cancel").exists()).toBe(true);
      expect(wrapper.find('[data-testid="home-view"]').exists()).toBe(true);
      expect(designStore.workflowId).toBe(wfA.id);
      expect(designStore.dirty).toBe(true);
      expect(tabs.activeTabId).toBeNull();
      expect(tabs.contextTabId).toBe(tabAId);
      // 取消：不切换，草稿原样
      await expectBody("dialog-cancel").trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-testid="home-view"]').exists()).toBe(true);
      expect(tabs.contextTabId).toBe(tabAId);
      expect(designStore.dirty).toBe(true);
      // 再切并确认丢弃：切签完成 + 设计器会话卸载（dirty 复位，避免下次切签重复纠缠）
      await tabB.trigger("click");
      await flushPromises();
      await expectBody("dialog-confirm").trigger("click");
      await flushPromises();
      expect(tabB.classes()).toContain("active");
      expect(designStore.workflowId).toBeNull();
      expect(designStore.dirty).toBe(false);
    } finally {
      await failingApi.wfDelete({ ...demoProject.locator, workflowId: wfA.id }).catch(() => undefined);
      await failingApi.nodeDelete({ kind: "project", locator: targetProject }).catch(() => undefined);
    }
  });

  it("非 dirty 时切签：直接切换不弹确认（现状保持）", async () => {
    const targetProject = await seedSecondProject("干净目标项目");
    try {
      const wrapper = await mountApp();
      await openLocalDir(wrapper);
      await flushPromises();
      await openSecondProjectTab(wrapper, "干净目标项目");
      expect(document.body.querySelector('[data-testid="dialog-confirm"]')).toBeNull();
    } finally {
      await failingApi.nodeDelete({ kind: "project", locator: targetProject }).catch(() => undefined);
    }
  });

  it("切到无接口记忆的项目签：编辑区不串显上一项目活跃会话；切回草稿驻留（任务 7 冒烟修复）", async () => {
    const targetProject = await seedSecondProject("无记忆目标项目");
    try {
      const wrapper = await mountApp();
      await openLocalDir(wrapper);
      await flushPromises();
      // 确保示例项目签活跃（openLocalDir 打开的首卡按 UUID 序不保证是示例项目）
      await openSecondProjectTab(wrapper, "示例项目");
      // 展开作用域树至 api 叶可见并载入示例接口
      await expandAllCollapsedTreeContainers(wrapper);
      expect(wrapper.find('[data-testid="tree-api"]').exists()).toBe(true);
      await clickApiAndWait(wrapper);
      await flushPromises();
      await wrapper.get('[data-testid="asset-metadata-toggle"]').trigger("click");
      const nameInput = wrapper.find('[data-testid="asset-metadata-name"]');
      expect(nameInput.exists()).toBe(true);
      await nameInput.setValue("串显回归草稿");
      // 切到无任何接口记忆的目标项目签：编辑区必须回空白
      // （修复前：上一项目的活跃会话串显到当前签下——内容上下文未随签驱动）
      await openSecondProjectTab(wrapper, "无记忆目标项目");
      expect(wrapper.find('[data-testid="request-editor"]').exists()).toBe(false);
      // 切回示例项目：草稿按会话驻留原样恢复（不变量 2）
      const tabA = await tabFor(wrapper, "示例项目");
      await tabA.trigger("click");
      await flushPromises();
      await wrapper.get('[data-testid="asset-metadata-toggle"]').trigger("click");
      const back = wrapper.find('[data-testid="asset-metadata-name"]');
      expect(back.exists()).toBe(true);
      expect((back.element as HTMLInputElement).value).toBe("串显回归草稿");
    } finally {
      await failingApi.nodeDelete({ kind: "project", locator: targetProject }).catch(() => undefined);
    }
  });
});

// —— 主页在线入口：在线工作区与项目发现留在主页，项目卡片成签后进入统一项目页 ——
// 置于文件末尾：用例预置在线登录态（apicc.onlineServers），结束即清，不污染文件内更早用例。
const ONLINE_SERVER = "http://127.0.0.1:8080";

async function seedOnlineLogin() {
  await failingApi.onlineLogin({ baseUrl: ONLINE_SERVER, username: "alice", password: "password8" });
  localStorage.setItem("apicc.onlineServers", JSON.stringify({
    active: ONLINE_SERVER,
    servers: [{ baseUrl: ONLINE_SERVER, name: "团队服务器" }],
  }));
}

async function cleanupOnlineLogin() {
  localStorage.removeItem("apicc.onlineServers");
  await failingApi.onlineLogout();
}

/** 主页 → 服务器视图 → 等工作区行出现（refreshOnline 异步）。 */
async function gotoServerWorkspaces(wrapper: import("@vue/test-utils").VueWrapper) {
  await wrapper.find(`[data-testid="home-side-server-${ONLINE_SERVER}"]`).trigger("click");
  await vi.waitFor(() => expect(wrapper.find('[data-testid="home-ws-ws-online-1"]').exists()).toBe(true));
}

/** 等待激活态项目签出现（成签链路是多拍宏任务：签元素先于激活完成渲染）。 */
async function activeTabElement(wrapper: import("@vue/test-utils").VueWrapper) {
  let active: DOMWrapper<Element> | undefined;
  await vi.waitFor(() => {
    active = wrapper.findAll('[data-testid^="project-tab-"]').find((tab) => tab.attributes("data-active") === "true");
    expect(active).toBeDefined();
  });
  if (!active) throw new Error("激活态项目签未出现");
  return active;
}

describe("App 主页在线入口（终审 Important 1：纯在线用户死胡同修复）", () => {
  it("主页开在线工作区仍可发现项目；项目卡片成签后在线树可用", async () => {
    await seedOnlineLogin();
    try {
      const wrapper = await mountApp();
      expect(wrapper.find('[data-testid="home-view"]').exists()).toBe(true);
      await gotoServerWorkspaces(wrapper);
      // 打开在线工作区后保留主页，活跃工作区下的项目卡片承接成签入口。
      await wrapper.find('[data-testid="home-ws-ws-online-1"]').trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-testid="home-view"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="project-card-300"]').exists()).toBe(true);
      await wrapper.find('[data-testid="project-card-300"]').trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-testid="home-view"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="module-rail"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="sidebar-api"]').isVisible()).toBe(true);
      expect(wrapper.find('[data-testid="online-guide"]').exists()).toBe(true);
      // 项目页内在线树仍可发现并定位当前项目。
      await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
      await flushPromises();
      const projLabel = wrapper.findAll(".label").find((e) => e.text() === "示例项目");
      expect(projLabel).toBeDefined();
      await projLabel!.trigger("click");
      // 成签链路（openProjectTab → activateTab 编排）是多拍宏任务：签元素先于激活完成渲染，
      // 直接等「激活态」出现，不凑拍
      const activeTab = await activeTabElement(wrapper);
      expect(activeTab.text()).toContain("示例项目");
    } finally {
      await cleanupOnlineLogin();
    }
  });

  it("主页在线区活跃工作区下项目卡片 → 点卡片直达成签激活并离开主页", async () => {
    await seedOnlineLogin();
    try {
      const wrapper = await mountApp();
      await gotoServerWorkspaces(wrapper);
      await wrapper.find('[data-testid="home-ws-ws-online-1"]').trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-testid="home-view"]').exists()).toBe(true); // 工作区仍从主页展示项目
      // 回主页 → 服务器视图：活跃工作区下列出其项目卡片（online.projects，ProjectCard 复用）
      await wrapper.find('[data-testid="topbar-home"]').trigger("click");
      await flushPromises();
      await gotoServerWorkspaces(wrapper);
      const card = wrapper.find('[data-testid="project-card-300"]');
      expect(card.exists()).toBe(true);
      // 点卡片：直连 tabs.openProjectTab（online 分支）→ 成签激活，视图随活跃签离开主页
      await card.trigger("click");
      const activeTab = await activeTabElement(wrapper);
      expect(activeTab.text()).toContain("示例项目");
      expect(wrapper.find('[data-testid="home-view"]').exists()).toBe(false);
    } finally {
      await cleanupOnlineLogin();
    }
  });
});

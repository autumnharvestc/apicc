// @vitest-environment jsdom
// 注：渲染层组件测试用文件级 pragma 指定 jsdom 环境（vitest 4 已移除 environmentMatchGlobs）。
//
// antd 迁移后的选择器适配说明（task-2 步骤 2）：
// 1. data-testid 仍是主钩子：所有留在组件自身 DOM 内的触发元素照旧 wrapper.find。
// 2. a-modal（ConfirmDialog）在 antd 4 恒经传送门渲染到 document.body
//    （Modal 把 getContainer=false 视为 falsy 回退到默认 portal），因此对话框内
//    元素（dialog-input/dialog-confirm/dialog-cancel）用 body 作用域包装器查询，
//    见下方 expectBody/bodyHas 辅助。
// 3. a-select 的下拉展开依赖真实布局与动画，jsdom 中不稳定，统一用组件级
//    update:value 事件驱动（chooseSelect 辅助），语义等效于用户在下拉中选中该项。
// 4. a-tabs 的页签触发钩子（tab-*）经 #tab slot 渲染成可点击 span，点击冒泡到
//    a-tabs 内部处理器完成切换，测试仍直接对该 data-testid trigger("click")。
import { describe, expect, it, beforeAll, afterEach, vi } from "vitest";
import { legacyStressRun } from "../../helpers/legacyStress.js";
import { randomUUID } from "node:crypto";
import { mount, flushPromises, enableAutoUnmount, DOMWrapper, type VueWrapper } from "@vue/test-utils";
import { reactive } from "vue";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useTreeStore } from "../../../src/renderer/src/stores/tree.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";
import { useDebugStore } from "../../../src/renderer/src/stores/debug.js";
import { useWorkflowDesignStore } from "../../../src/renderer/src/stores/workflowDesign.js";
import { createStressStore } from "../../../src/renderer/src/stores/stress.js";
import { createOnlineStore } from "../../../src/renderer/src/stores/online.js";
import { createTabsStore } from "../../../src/renderer/src/stores/tabs.js";
import { useImportWizardStore } from "../../../src/renderer/src/stores/importW.js";
import { createPluginsStore } from "../../../src/renderer/src/stores/plugins.js";
import { useRunStore } from "../../../src/renderer/src/stores/run.js";
import SideTree from "../../../src/renderer/src/components/SideTree.vue";
import HomeView from "../../../src/renderer/src/components/HomeView.vue";
import RequestEditor from "../../../src/renderer/src/components/RequestEditor.vue";
import CredentialEditor from "../../../src/renderer/src/components/CredentialEditor.vue";
import OAuthManager from "../../../src/renderer/src/components/OAuthManager.vue";
import ResponseViewer from "../../../src/renderer/src/components/ResponseViewer.vue";
import EmptyState from "../../../src/renderer/src/components/EmptyState.vue";
import ConfirmDialog from "../../../src/renderer/src/components/ConfirmDialog.vue";
import TopBar from "../../../src/renderer/src/components/TopBar.vue";
import RunsHistory from "../../../src/renderer/src/components/RunsHistory.vue";
import DebugHistory from "../../../src/renderer/src/components/DebugHistory.vue";
import StressPanel from "../../../src/renderer/src/components/StressPanel.vue";
import StressReportView from "../../../src/renderer/src/components/StressReportView.vue";
import type { ApiAsset, DebugResult, RunResult, StressReport } from "@apicc/core";
import type { ApiccApi, RunSummaryDTO, StressRunInput, StressRunOutput, StressRunSummaryDTO } from "../../../src/shared/types.js";
import type { ApiLocator, ProjectLocator, WorkflowLocator } from "../../../src/shared/locations.js";
import type { LocalGroupTreeNodeDTO, TreeNodeDTO } from "../../../src/shared/tree-dto.js";

const stressStoreRoot = "C:/apicc-stress-store-tests";
const stressStoreLocator: ApiLocator = {
  workspaceId: "00000000-0000-4000-8000-000000000021",
  groupId: "00000000-0000-4000-8000-000000000022",
  projectId: "00000000-0000-4000-8000-000000000023",
  collectionId: "00000000-0000-4000-8000-000000000024",
  folderIds: [],
  apiId: "00000000-0000-4000-8000-000000000025",
};
const debugFixtureSource = { sourceKind: "asset" as const, locator: stressStoreLocator, sourceApiRevision: "api-revision" };
const debugFixtureExchangeSource = {
  sourceKind: "asset" as const,
  case: { ...stressStoreLocator, caseId: "00000000-0000-4000-8000-000000000026", scope: "project" },
};

beforeAll(() => {
  // jsdom 未实现 matchMedia；TopBar→ThemeLanguageToggle 挂载时解析主题偏好会调用它，
  // antd 组件（响应式断点）亦然。
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
    }),
  });
  // 固定语言为 zh-CN，使文案断言与语言文件一致（jsdom navigator.language 为 en-US）。
  localStorage.setItem("apicc.locale", "zh-CN");
});

// a-modal 传送门内容随组件卸载移除：每条用例后自动卸载，防止跨用例 body 残留。
enableAutoUnmount(afterEach);

/** body 作用域查询：a-modal（ConfirmDialog）传送门渲染在 document.body（见文件头说明）。 */
function bodyFind(testid: string): DOMWrapper<Element> | null {
  const el = document.body.querySelector(`[data-testid="${testid}"]`);
  return el ? new DOMWrapper(el) : null;
}

/** body 作用域断言取用：不存在时直接报错（代替 expectBody(...).exists() 的静默通过）。 */
function expectBody(testid: string): DOMWrapper<Element> {
  const w = bodyFind(testid);
  if (!w) throw new Error(`document.body 中找不到 [data-testid="${testid}"]（Modal 传送门未渲染？）`);
  return w;
}

/** 内存 Storage 替身（M3-B 任务 2）：online store 档案持久化注入，避免污染真实 localStorage。 */
function memStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

function bodyHas(testid: string): boolean {
  return bodyFind(testid) !== null;
}

/**
 * a-select 交互适配：经组件实例发 update:value（v-model 通道），语义等效于用户
 * 在下拉中选中该项。antd 4 Select 的根元素承载透传的 data-testid，据此定位。
 */
function chooseSelect(wrapper: VueWrapper, testid: string, value: string): void {
  const select = wrapper
    .findAllComponents({ name: "ASelect" })
    .find((c) => c.attributes("data-testid") === testid);
  if (!select) throw new Error(`ASelect 未找到: ${testid}`);
  select.vm.$emit("update:value", value);
}

async function clickDebugSendAndWait(wrapper: VueWrapper, debug: ReturnType<typeof useDebugStore>): Promise<void> {
  const original = debug.send.bind(debug);
  let pending: ReturnType<typeof original> | null = null;
  debug.send = (targetEditor, runFn) => {
    pending = original(targetEditor, runFn);
    return pending;
  };
  await wrapper.find('[data-testid="send-btn"]').trigger("click");
  if (!pending) throw new Error("Send button did not invoke the real debug action");
  await pending;
  await flushPromises();
}

function traceDebugStartWait(api: ApiccApi) {
  const trace = {
    invocations: [] as Array<Parameters<ApiccApi["debugStart"]>[0]>,
    runIds: [] as string[],
    waitedRunIds: [] as string[],
  };
  const originalStart = api.debugStart.bind(api);
  api.debugStart = async (invocation) => {
    trace.invocations.push(invocation);
    const started = await originalStart(invocation);
    trace.runIds.push(started.runId);
    return started;
  };
  const originalWait = api.debugWait.bind(api);
  api.debugWait = async (input) => {
    trace.waitedRunIds.push(input.runId);
    return originalWait(input);
  };
  return trace;
}

async function clickEditorSaveAndWait(wrapper: VueWrapper, editor: ReturnType<typeof useEditorStore>): Promise<void> {
  const original = editor.save.bind(editor);
  let pending: ReturnType<typeof original> | null = null;
  editor.save = () => {
    pending = original();
    return pending;
  };
  await wrapper.find('[data-testid="save-btn"]').trigger("click");
  if (!pending) throw new Error("Save button did not invoke the real editor action");
  await pending;
  await flushPromises();
}

/** 读取 a-select 受控 :value 绑定值（显示侧断言用，不经 antd 内部渲染）。 */
function selectValue(wrapper: VueWrapper, testid: string): unknown {
  const select = wrapper
    .findAllComponents({ name: "ASelect" })
    .find((c) => c.attributes("data-testid") === testid);
  if (!select) throw new Error(`ASelect 未找到: ${testid}`);
  return select.props("value");
}

/**
 * 任务 6 夹具：经 memory api 种子一个引用指定接口首个用例的工作流请求节点，
 * 使该完整 ApiLocator 的 wf:impact 恰好命中一条（工作流名/状态/节点 label 可断言）。
 */
async function seedWorkflowReferencingApi(
  api: ReturnType<typeof createMemoryApi>,
  projectLocator: ProjectLocator,
  apiLocator: ApiLocator,
): Promise<void> {
  const detail = await api.apiGet(apiLocator);
  const caseId = detail.api.cases[0]!.id;
  const wf = await api.wfCreate({ locator: projectLocator, name: "下单主流程" });
  await api.wfSave({ ...projectLocator, workflowId: wf.id }, {
    ...wf,
    nodes: [{ id: "n1", kind: "request", label: "创建订单", apiId: apiLocator.apiId, caseId }],
    edges: [],
  });
}

/**
 * 显式装配辅助（组合根约定的测试形态）：
 * store 工厂每调用一次即新建独立 Pinia 实例、得到互不相通的状态副本——因此同一份
 * store 在这里一次性创建，经 props 注入被测组件（简报原 mountWith 未向组件传 store，
 * 与该装配约定冲突，以约定为准调整）。组件内部不重复调用工厂。
 */
async function mountWith(component: Parameters<typeof mount>[0], props: Record<string, unknown> = {}) {
  const api = createMemoryApi();
  api.seedWorkspace();
  const workspace = useWorkspaceStore(api);
  await workspace.open("/tmp/ws");
  const tree = useTreeStore(api, workspace);
  const localContext = () => ({ root: workspace.root, readOnly: workspace.readOnly });
  const editor = useEditorStore(api, localContext);
  const debug = useDebugStore(api, editor, localContext);
  // SideTree 需要设计器会话（审查 I2 重命名卸载）：同一份一次性装配经 props 注入
  const workflowDesign = useWorkflowDesignStore(api, localContext);
  // TopBar 需要 online store（M3-B 任务 2 在线入口）：同一份一次性装配经 props 注入
  const online = createOnlineStore({ api, storage: memStorage() });
  // 计划 C 任务 6：TopBar 退出在线确认需要 tabs store（签列表/草稿态统计 + 关签编排）
  const tabs = createTabsStore({ workspace, tree, online, editor, workflowDesign, storage: memStorage() });
  // HomeView 轨三 props：导入向导 store 与插件清单（其余组件不消费，注入无副作用）
  const importW = useImportWizardStore(api, workspace);
  const plugins = createPluginsStore({ api });
  const { i18n } = createI18nInstance();
  const wrapper = mount(component, {
    props: { api, workspace, tree, editor, debug, workflowDesign, online, tabs, importW, plugins, reportError: () => {}, ...props },
    global: { plugins: [i18n] },
  });
  await flushPromises();
  return { wrapper, api, workspace, tree, editor, debug, workflowDesign, online, tabs };
}

function seededProjectAndApi(workspace: ReturnType<typeof useWorkspaceStore>) {
  const group = workspace.tree?.children.find((node): node is LocalGroupTreeNodeDTO =>
    node.kind === "group" && node.children.some((child) => child.kind === "project"));
  if (!group || group.kind !== "group") throw new Error("Memory workspace is missing its group");
  const project = group.children.find((node) => node.kind === "project");
  if (!project || project.kind !== "project") throw new Error("Memory group is missing its project");
  const collection = project.children.find((node) => node.kind === "collection");
  if (!collection || collection.kind !== "collection") throw new Error("Memory project is missing its collection");
  const apiNode = collection.children.find((node) => node.kind === "api");
  if (!apiNode || apiNode.kind !== "api") throw new Error("Memory collection is missing its API");
  return { project, collection, apiNode };
}

/** 仅需 i18n 插件的挂载（组件只收普通 props，不消费 store）。 */
function mountWithI18n(component: Parameters<typeof mount>[0], props: Record<string, unknown> = {}): VueWrapper {
  const { i18n } = createI18nInstance();
  return mount(component, { props, global: { plugins: [i18n] } });
}

/** 展开当前可见树中的折叠容器；只点 ▸，不会误把已展开节点收回。 */
async function expandAllCollapsedTreeContainers(wrapper: VueWrapper): Promise<void> {
  while (true) {
    const collapsed = wrapper
      .findAll('[data-testid="tree-group-toggle"]')
      .find((toggle) => toggle.text().trim() === "▸");
    if (!collapsed) return;
    await collapsed.trigger("click");
  }
}

function captureTreeCreate(tree: ReturnType<typeof useTreeStore>) {
  const original = tree.createNode.bind(tree);
  let pending: ReturnType<typeof original> | null = null;
  tree.createNode = (input) => {
    pending = original(input);
    return pending;
  };
  return {
    async settle(): Promise<void> {
      if (!pending) throw new Error("Expected the real tree.createNode action to run");
      await pending.catch(() => undefined);
      await flushPromises();
    },
    restore(): void {
      tree.createNode = original;
    },
  };
}

/**
 * M2-B 收口夹具：在种子项目下创建一条工作流并刷新侧树（侧树工作流入口的数据前置）。
 * 返回项目/接口/用例 id 供状态迁移与断言复用。
 */
async function seedTreeWorkflow(
  api: ReturnType<typeof createMemoryApi>,
  workspace: ReturnType<typeof useWorkspaceStore>,
  name: string,
): Promise<{ workflowLocator: WorkflowLocator; projectLocator: ProjectLocator; apiLocator: ApiLocator; workflowId: string; apiId: string; caseId: string }> {
  const { project, apiNode } = seededProjectAndApi(workspace);
  const detail = await api.apiGet(apiNode.locator);
  const wf = await api.wfCreate({ locator: project.locator, name });
  await workspace.refresh();
  return {
    workflowLocator: { ...project.locator, workflowId: wf.id },
    projectLocator: project.locator,
    apiLocator: apiNode.locator,
    workflowId: wf.id,
    apiId: apiNode.id,
    caseId: detail.api.cases[0]!.id,
  };
}

describe("SideTree", () => {
  it.each(["api", "module", "folder"] as const)("%s 行固定图标操作具有可访问名称与 tooltip，模块/目录操作收纳于更多菜单", async (kind) => {
    const { wrapper, api, workspace } = await mountWith(SideTree);
    const { collection } = seededProjectAndApi(workspace);
    let row: DOMWrapper<Element> | undefined;
    let expectedLabel = "";

    if (kind === "folder") {
      const parent = await api.nodeCreate({ kind: "folder", parent: collection.locator, name: "嵌套目录父级" });
      if (parent.kind !== "folder") throw new Error("Expected the folder parent to be created");
      const child = await api.nodeCreate({ kind: "folder", parent: { ...collection.locator, folderIds: [parent.id] }, name: "嵌套目录子级" });
      if (child.kind !== "folder") throw new Error("Expected the nested folder to be created");
      expectedLabel = child.label;
      await workspace.refresh();
    }

    await expandAllCollapsedTreeContainers(wrapper);
    if (kind === "api") row = wrapper.find('[data-testid="tree-api-row"]');
    else {
      expectedLabel ||= kind === "module" ? collection.label : "嵌套目录子级";
      row = wrapper.findAll(".node").find((candidate) =>
        candidate.find(".label").exists() && candidate.find(".label").text() === expectedLabel);
    }
    if (!row?.exists()) throw new Error(`Expected the ${kind} row to be rendered`);

    const rename = row.find('[data-testid="node-rename"]');
    const remove = row.find('[data-testid="node-delete"]');
    expect(rename.attributes("aria-label")).toBe("重命名");
    expect(rename.attributes("title")).toBe("重命名");
    expect(rename.text()).toBe("");
    expect(remove.attributes("aria-label")).toBe("删除");
    expect(remove.attributes("title")).toBe("删除");
    expect(remove.classes()).toContain("danger");

    if (kind !== "api") {
      expect(row.find(".label").attributes("title")).toBe(expectedLabel);
      const expandedBefore = row.find('[data-testid="tree-group-toggle"]').text();
      await row.find('[data-testid="tree-more"]').trigger("click");
      expect(row.find('[data-testid="tree-group-toggle"]').text()).toBe(expandedBefore);
      expect(row.find('[data-testid="new-api"]').exists()).toBe(true);
      expect(row.find('[data-testid="new-folder"]').exists()).toBe(true);
      expect(row.find('[data-testid="container-manage"]').exists()).toBe(true);
      expect(wrapper.emitted("select")).toBeUndefined();
    }

    await rename.trigger("click");
    expect(wrapper.emitted("select")).toBeUndefined();
    await expectBody("dialog-cancel").trigger("click");

    const readonly = await mountWith(SideTree, { readonly: true });
    await expandAllCollapsedTreeContainers(readonly.wrapper);
    expect(readonly.wrapper.find('[data-testid="node-rename"]').exists()).toBe(false);
    expect(readonly.wrapper.find('[data-testid="node-delete"]').exists()).toBe(false);
    expect(readonly.wrapper.find('[data-testid="tree-more"]').exists()).toBe(false);
  });

  it("渲染工作区树并支持选中接口", async () => {
    const { wrapper } = await mountWith(SideTree);
    // 分组/项目/集合默认折叠：接口初始不可见
    expect(wrapper.find('[data-testid="tree-api"]').exists()).toBe(false);
    await expandAllCollapsedTreeContainers(wrapper);
    const apiNode = wrapper.find('[data-testid="tree-api"]');
    expect(apiNode.exists()).toBe(true);
    await apiNode.trigger("click");
    expect(wrapper.emitted("select")).toBeTruthy();
  });

  it("新建接口：集合动作钮经对话框输入后创建并选中", async () => {
    const { wrapper, tree } = await mountWith(SideTree);
    await expandAllCollapsedTreeContainers(wrapper);
    await wrapper.find('[data-testid="tree-more"]').trigger("click");
    await wrapper.find('[data-testid="new-api"]').trigger("click");
    // 创建走 ConfirmDialog 复用的输入对话框（a-modal 渲染于 body）
    const input = expectBody("dialog-input");
    await input.setValue("新接口");
    const create = captureTreeCreate(tree);
    await expectBody("dialog-confirm").trigger("click");
    await create.settle();
    create.restore();
    // App 消费完整节点 DTO；类型与身份来自真实 tree.createNode 返回值。
    const selected = wrapper.emitted("select")![0]![0] as TreeNodeDTO;
    expect(selected).toMatchObject({ source: "local", kind: "api", label: "新接口", locator: { apiId: expect.any(String) } });
    if (selected.source !== "local" || selected.kind !== "api") throw new Error("Created API selection must carry its local API locator");
    expect(selected.id).toBe(selected.locator.apiId);
    expect(wrapper.text()).toContain("新接口");
  });

  it("对话框 run 拒绝时经 reportError 上报（宽审查 I1，不再静默吞没）", async () => {
    const errors: unknown[] = [];
    const { wrapper, api, tree } = await mountWith(SideTree, { reportError: (e: unknown) => { errors.push(e); } });
    await expandAllCollapsedTreeContainers(wrapper);
    await wrapper.find('[data-testid="tree-more"]').trigger("click");
    await wrapper.find('[data-testid="new-api"]').trigger("click");
    await expectBody("dialog-input").setValue("x");
    api.nodeCreate = async () => { throw new Error("boom"); };
    const create = captureTreeCreate(tree);
    await expectBody("dialog-confirm").trigger("click");
    await create.settle();
    create.restore();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
  });

  it("删除接口：确认对话框放行后节点消失", async () => {
    const { wrapper, api, workspace, tree } = await mountWith(SideTree);
    await expandAllCollapsedTreeContainers(wrapper);
    // 以接口所在行（tree-api-row）为作用域，避免命中祖先节点的删除钮
    const row = wrapper.find('[data-testid="tree-api-row"]');
    const apiId = row.find('[data-testid="tree-api"]').attributes("data-node-id") as string;
    const originalImpact = api.wfImpact.bind(api);
    let impactTask: ReturnType<typeof originalImpact> | null = null;
    api.wfImpact = (...args) => {
      impactTask = originalImpact(...args);
      return impactTask;
    };
    await row.find('[data-testid="node-delete"]').trigger("click");
    if (!impactTask) throw new Error("API delete did not perform the real workflow-impact check");
    await impactTask;
    await vi.waitFor(() => expect(bodyHas("dialog-confirm")).toBe(true));
    const originalDelete = tree.deleteNode.bind(tree);
    let deleteTask: ReturnType<typeof originalDelete> | null = null;
    tree.deleteNode = (target, confirm) => {
      deleteTask = originalDelete(target, confirm);
      return deleteTask;
    };
    try {
      await expectBody("dialog-confirm").trigger("click");
      if (!deleteTask) throw new Error("API delete confirmation did not invoke the real tree.deleteNode action");
      await deleteTask;
    } finally {
      tree.deleteNode = originalDelete;
      api.wfImpact = originalImpact;
    }
    await vi.waitFor(() => expect(JSON.stringify(workspace.tree)).not.toContain(apiId));
  });

  it("删除被引用接口：显示引用方，确认后拒绝并保留 API（Task9 引用保护）", async () => {
    const errors: unknown[] = [];
    const { wrapper, api, workspace, tree } = await mountWith(SideTree, { reportError: (e: unknown) => errors.push(e) });
    const { project, apiNode } = seededProjectAndApi(workspace);
    await seedWorkflowReferencingApi(api, project.locator, apiNode.locator);
    await expandAllCollapsedTreeContainers(wrapper);
    const row = wrapper.find('[data-testid="tree-api-row"]');
    await row.find('[data-testid="node-delete"]').trigger("click");
    await flushPromises();
    // 影响清单渲染在 a-modal 传送门内（ConfirmDialog 复用），body 作用域查询
    const list = expectBody("impact-list");
    expect(list.text()).toContain("下单主流程");
    expect(list.text()).toContain("草稿"); // t("wf.status.draft")：工作流名（状态）
    expect(list.text()).toContain("创建订单"); // 节点 label
    // 规格给定警示文案（tree.impactWarning）随插槽渲染进对话框（impact-warning 与
    // impact-list 同为插槽内容；confirm-dialog testid 不被 a-modal 透传，不作钩子）
    expect(expectBody("impact-warning").text()).toContain("该用例被以下工作流引用");
    // 确认后删除执行
    const originalDelete = tree.deleteNode.bind(tree);
    let deleteTask: ReturnType<typeof originalDelete> | null = null;
    tree.deleteNode = (...args) => {
      deleteTask = originalDelete(...args);
      return deleteTask;
    };
    try {
      await expectBody("dialog-confirm").trigger("click");
      if (!deleteTask) throw new Error("API delete confirmation did not invoke the real tree.deleteNode action");
      await expect(deleteTask).rejects.toThrow(/Cannot delete referenced API\/case; workflow callers remain/);
    } finally {
      tree.deleteNode = originalDelete;
    }
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]).toBeInstanceOf(Error);
    expect((errors[0] as Error).message).toMatch(/Cannot delete referenced API\/case; workflow callers remain/);
    expect(JSON.stringify(workspace.tree)).toContain(apiNode.id);
    expect((await api.apiGet(apiNode.locator)).api.contract.id).toBe(apiNode.id);
    const workflows = await api.wfList(project.locator);
    const caller = workflows.find((item) => item.name === "下单主流程");
    expect(caller).toBeDefined();
    if (!caller) throw new Error("The workflow caller should remain after the rejected API deletion");
    expect((await api.wfGet(caller.locator)).workflow.nodes).toContainEqual(expect.objectContaining({
      apiId: apiNode.id,
      label: "创建订单",
    }));
  });

  it("删除未被引用接口：无影响清单（无额外弹窗），确认后直接删除", async () => {
    const { wrapper, workspace, tree } = await mountWith(SideTree);
    await expandAllCollapsedTreeContainers(wrapper);
    const row = wrapper.find('[data-testid="tree-api-row"]');
    const apiId = row.find('[data-testid="tree-api"]').attributes("data-node-id") as string;
    await row.find('[data-testid="node-delete"]').trigger("click");
    await flushPromises();
    // 未命中：常规确认对话框放行即删，不得出现影响清单
    expect(bodyHas("impact-list")).toBe(false);
    const originalDelete = tree.deleteNode.bind(tree);
    let deleteTask: ReturnType<typeof originalDelete> | null = null;
    tree.deleteNode = (...args) => {
      deleteTask = originalDelete(...args);
      return deleteTask;
    };
    try {
      await expectBody("dialog-confirm").trigger("click");
      if (!deleteTask) throw new Error("API delete confirmation did not invoke the real tree.deleteNode action");
      await deleteTask;
    } finally {
      tree.deleteNode = originalDelete;
    }
    expect(JSON.stringify(workspace.tree)).not.toContain(apiId);
  });

  it("删除被引用接口：取消影响清单对话框则不删除", async () => {
    const { wrapper, api, workspace } = await mountWith(SideTree);
    const { project, apiNode } = seededProjectAndApi(workspace);
    await seedWorkflowReferencingApi(api, project.locator, apiNode.locator);
    await expandAllCollapsedTreeContainers(wrapper);
    const row = wrapper.find('[data-testid="tree-api-row"]');
    await row.find('[data-testid="node-delete"]').trigger("click");
    await flushPromises();
    expect(bodyHas("impact-list")).toBe(true);
    await expectBody("dialog-cancel").trigger("click");
    await flushPromises();
    // 取消：接口仍在树中，对话框关闭
    expect(JSON.stringify(workspace.tree)).toContain(apiNode.id);
    expect(bodyHas("impact-list")).toBe(false);
  });

  it("删除接口：wfImpact 反查拒绝时经 reportError 上报并中止（不开框、不删除）", async () => {
    const errors: unknown[] = [];
    const { wrapper, api, workspace } = await mountWith(SideTree, { reportError: (e: unknown) => { errors.push(e); } });
    await expandAllCollapsedTreeContainers(wrapper);
    const row = wrapper.find('[data-testid="tree-api-row"]');
    const apiId = row.find('[data-testid="tree-api"]').attributes("data-node-id") as string;
    api.wfImpact = async () => { throw new Error("影响反查失败"); };
    await row.find('[data-testid="node-delete"]').trigger("click");
    await flushPromises();
    // 拒绝上报 + 中止语义：确认对话框不打开、接口仍在树中
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("影响反查失败");
    expect(bodyHas("dialog-confirm")).toBe(false);
    expect(JSON.stringify(workspace.tree)).toContain(apiId);
  });

  it("根层新建分组：空工作区也能从根创建顶层节点", async () => {
    const { wrapper, workspace, tree } = await mountWith(SideTree);
    const before = workspace.tree!.children!.length;
    await wrapper.find('[data-testid="new-group"]').trigger("click");
    await expectBody("dialog-input").setValue("根层新分组");
    const create = captureTreeCreate(tree);
    await expectBody("dialog-confirm").trigger("click");
    await create.settle();
    create.restore();
    expect(workspace.tree!.children!.length).toBe(before + 1);
    expect(wrapper.text()).toContain("根层新分组");
  });

  it("工作区未打开时渲染空态", async () => {
    const { wrapper, workspace } = await mountWith(SideTree);
    workspace.opened = false;
    await flushPromises();
    expect(wrapper.find('[data-testid="empty-state"]').exists()).toBe(true);
  });

  // —— M2-B 收口：侧树工作流入口（project children 尾部渲染 + 状态徽标色点） ——
  it("project children 尾部渲染工作流节点：label + 状态徽标色点（draft 灰/published 蓝/enabled 绿）", async () => {
    const { wrapper, api, workspace } = await mountWith(SideTree);
    const seeded = await seedTreeWorkflow(api, workspace, "草稿流");
    const pub = await api.wfCreate({ locator: seeded.projectLocator, name: "已发布流" });
    const pubLocator: WorkflowLocator = { ...seeded.projectLocator, workflowId: pub.id };
    await api.wfSetStatus(pubLocator, "published");
    // enabled 须过启用校验：绑定种子接口的真实用例（空流禁止启用）
    const en = await api.wfCreate({ locator: seeded.projectLocator, name: "已启用流" });
    const enLocator: WorkflowLocator = { ...seeded.projectLocator, workflowId: en.id };
    await api.wfSave(enLocator, { ...en, nodes: [{ id: "n1", kind: "request", apiId: seeded.apiId, caseId: seeded.caseId }], edges: [] });
    await api.wfSetStatus(enLocator, "published");
    await api.wfSetStatus(enLocator, "enabled");
    await workspace.refresh();
    await flushPromises();
    await expandAllCollapsedTreeContainers(wrapper);
    const nodes = wrapper.findAll('[data-testid="tree-workflow"]');
    expect(nodes.map((n) => n.text())).toEqual(["草稿流", "已发布流", "已启用流"]);
    // 状态徽标色点契约：data-status + 色点 class（draft 灰/published 蓝/enabled 绿）
    expect(nodes[0]!.attributes("data-status")).toBe("draft");
    expect(nodes[1]!.attributes("data-status")).toBe("published");
    expect(nodes[2]!.attributes("data-status")).toBe("enabled");
    expect(nodes[0]!.find(".wf-dot").classes()).toContain("wf-dot-draft");
    expect(nodes[1]!.find(".wf-dot").classes()).toContain("wf-dot-published");
    expect(nodes[2]!.find(".wf-dot").classes()).toContain("wf-dot-enabled");
    const treeComponent = wrapper.findAllComponents({ name: "ATree" })[0];
    if (!treeComponent) throw new Error("Expected the Ant Design tree component.");
    type TreeData = { key: string; dto?: { kind?: string; id?: string; key?: string }; children?: TreeData[] };
    const flatten = (nodes: TreeData[]): TreeData[] => nodes.flatMap((node) => [node, ...flatten(node.children ?? [])]);
    const workflowNode = flatten(treeComponent.props("treeData") as TreeData[])
      .find((node) => node.dto?.kind === "workflow" && node.dto.id === seeded.workflowId);
    expect(workflowNode?.key).toBe(workflowNode?.dto?.key);
    expect(workflowNode?.key).not.toBe(seeded.workflowId);
    // 工作流节点渲染在 project children 尾部（接口行之后）
    const apiEl = wrapper.find('[data-testid="tree-api-row"]').element;
    const wfEl = wrapper.find('[data-testid="tree-workflow-row"]').element;
    expect(apiEl.compareDocumentPosition(wfEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("点击工作流节点 emit select(\"workflow\", id)", async () => {
    const { wrapper, api, workspace } = await mountWith(SideTree);
    const seeded = await seedTreeWorkflow(api, workspace, "点击流");
    await expandAllCollapsedTreeContainers(wrapper);
    await wrapper.find('[data-testid="tree-workflow"]').trigger("click");
    // App 据此 kind 加载工作流设计器（onSelect → workflowDesign.load + 视图切 wf）
    const selected = wrapper.emitted("select")![0]![0] as TreeNodeDTO;
    expect(selected).toMatchObject({ source: "local", kind: "workflow", id: seeded.workflowId, locator: seeded.workflowLocator });
  });

  it("工作流重命名：对话框输入后经 wfRename 改名并刷新树", async () => {
    const { wrapper, api, workspace } = await mountWith(SideTree);
    const seeded = await seedTreeWorkflow(api, workspace, "旧名流");
    await expandAllCollapsedTreeContainers(wrapper);
    const row = wrapper.find('[data-testid="tree-workflow-row"]');
    await row.find('[data-testid="node-rename"]').trigger("click");
    // 重命名复用 ConfirmDialog 输入先例（a-modal 传送门渲染于 body）
    await expectBody("dialog-input").setValue("新名流");
    const originalRename = api.wfRename.bind(api);
    let renameTask: ReturnType<typeof originalRename> | null = null;
    api.wfRename = (locator, name) => {
      renameTask = originalRename(locator, name);
      return renameTask;
    };
    try {
      await expectBody("dialog-confirm").trigger("click");
      if (!renameTask) throw new Error("Rename confirmation did not invoke the real wfRename API");
      await renameTask;
    } finally {
      api.wfRename = originalRename;
    }
    await vi.waitFor(() => expect(wrapper.find('[data-testid="tree-workflow"]').text()).toContain("新名流"));
    expect((await api.wfList(seeded.projectLocator)).map((w) => w.name)).toEqual(["新名流"]);
    expect(wrapper.find('[data-testid="tree-workflow"]').text()).toContain("新名流");
  });

  it("工作流删除：确认对话框放行后经 wfDelete 删除并从树移除", async () => {
    const { wrapper, api, workspace } = await mountWith(SideTree);
    const seeded = await seedTreeWorkflow(api, workspace, "待删流");
    await expandAllCollapsedTreeContainers(wrapper);
    const row = wrapper.find('[data-testid="tree-workflow-row"]');
    await row.find('[data-testid="node-delete"]').trigger("click");
    await flushPromises();
    // 删除确认文案复用 wf.deleteConfirm（含工作流名），确认前不删
    expect(document.body.textContent).toContain("待删流");
    expect((await api.wfList(seeded.projectLocator)).map((w) => w.name)).toEqual(["待删流"]);
    const originalDelete = api.wfDelete.bind(api);
    let deleteTask: ReturnType<typeof originalDelete> | null = null;
    api.wfDelete = (locator) => {
      deleteTask = originalDelete(locator);
      return deleteTask;
    };
    try {
      await expectBody("dialog-confirm").trigger("click");
      if (!deleteTask) throw new Error("Workflow delete confirmation did not invoke the real wfDelete API");
      await deleteTask;
    } finally {
      api.wfDelete = originalDelete;
    }
    await vi.waitFor(() => expect(wrapper.find('[data-testid="tree-workflow"]').exists()).toBe(false));
    expect(await api.wfList(seeded.projectLocator)).toEqual([]);
    expect(wrapper.find('[data-testid="tree-workflow"]').exists()).toBe(false);
  });
});

// —— M5-B 任务 1：正式 ApiAsset 契约下的协议编辑与字段适配（规格 D2/D8）。——

/** 协议单选切换：经 ARadioGroup 组件级 update:value（与 chooseMode 同理，jsdom 不点真实 radio）。 */
function chooseProtocol(wrapper: VueWrapper, value: "http" | "websocket" | "soap"): void {
  antdComponent(wrapper, "ARadioGroup", "editor-protocol").vm.$emit("update:value", value);
}

function chooseBodyKind(wrapper: VueWrapper, value: string): void {
  antdComponent(wrapper, "ARadioGroup", "body-kind").vm.$emit("update:value", value);
}

/** 读取协议单选组当前值（显示侧断言用，不经 antd 内部渲染）。 */
function protocolValue(wrapper: VueWrapper): unknown {
  return antdComponent(wrapper, "ARadioGroup", "editor-protocol").props("value");
}

/** 协议选项（值 + 标签）断言取用：jsdom 不点真实 radio，经 ARadioButton 组件 props/文本读取。 */
function protocolOptionsOf(wrapper: VueWrapper): Array<{ value: unknown; label: string }> {
  return wrapper
    .findAllComponents({ name: "ARadioButton" })
    .map((r) => ({ value: r.props("value"), label: r.text() }));
}

/** 判定含指定标记的面板是否为激活面板：antd Tabs 对激活过的面板保留 DOM（去 -active 类），exists 不可作活跃判据。 */
function paneActive(wrapper: VueWrapper, testid: string): boolean {
  const pane = wrapper
    .findAll(".ant-tabs-tabpane")
    .find((p) => p.find(`[data-testid="${testid}"]`).exists());
  return pane?.classes().includes("ant-tabs-tabpane-active") ?? false;
}

describe("RequestEditor", () => {
  it("OAuth 状态只显示安全摘要；显式授权可取消，刷新部分失败可见，解绑不删除 Bearer 凭据", async () => {
    const { wrapper, api, editor, debug, workspace } = await mountWith(RequestEditor);
    const { project, apiNode } = seededProjectAndApi(workspace);
    await editor.load(apiNode.locator);
    const environment = await api.envCreate({ locator: project.locator, name: "oauth-dev" });
    await editor.reloadEnvs();
    const bearerRef = { id: "oauth-managed-access", policy: "test-auto" };
    const refreshTokenRef = { id: "oauth-managed-refresh", policy: "test-auto" };
    await api.credentialPut({ locator: project.locator, ref: bearerRef, value: "never-render-this-access-secret" });
    const requestTab = {
      tabId: "request-oauth-ui",
      root: workspace.root!,
      project: project.locator,
      source: { kind: "asset" as const, locator: apiNode.locator },
      generation: 7,
    };
    debug.requestTabState(requestTab).selectedEnvironmentId = environment.id;
    const request = editor.api!.contract.request;
    if (request.protocol !== "http") throw new Error("Seeded API request must be HTTP");
    request.auth = { kind: "bearer", token: bearerRef };

    const profile = {
      profileId: "oauth-managed-profile",
      environmentId: environment.id,
      flow: "authorization_code" as const,
      authorizationEndpoint: "https://issuer.example/authorize",
      tokenEndpoint: "https://issuer.example/token",
      clientId: "client-ui",
      clientAuthentication: "none" as const,
      bearerRef,
      refreshTokenRef,
    };
    const summary = {
      profile,
      configurationFingerprint: "sha256:ui-fixture",
      status: "connected" as const,
      expiresAt: 2_000_000_000_000,
    } satisfies Awaited<ReturnType<ApiccApi["oauthProfilesGet"]>>["profiles"][number];
    const alternateProfile = {
      profileId: "oauth-managed-profile-alternate",
      environmentId: environment.id,
      flow: "authorization_code" as const,
      authorizationEndpoint: "https://issuer.example/authorize",
      tokenEndpoint: "https://issuer.example/token",
      clientId: "client-ui-alternate",
      clientAuthentication: "none" as const,
      bearerRef: { id: "oauth-managed-access-alternate", policy: "test-auto" as const },
    };
    const alternateSummary = {
      profile: alternateProfile,
      configurationFingerprint: "sha256:ui-fixture-alternate",
      status: "connected" as const,
    } satisfies Awaited<ReturnType<ApiccApi["oauthProfilesGet"]>>["profiles"][number];
    let profiles: Awaited<ReturnType<ApiccApi["oauthProfilesGet"]>>["profiles"] = [summary];
    const profileReads: Parameters<ApiccApi["oauthProfilesGet"]>[0][] = [];
    const acquires: Parameters<ApiccApi["oauthProfileAcquire"]>[0][] = [];
    const refreshes: Parameters<ApiccApi["oauthProfileRefresh"]>[0][] = [];
    const unlinks: Parameters<ApiccApi["oauthProfileUnlink"]>[0][] = [];
    const begins: Parameters<ApiccApi["oauthAuthorizeBegin"]>[0][] = [];
    const cancels: Parameters<ApiccApi["oauthAuthorizeCancel"]>[0][] = [];
    const waitResolvers = new Map<string, (value: Awaited<ReturnType<ApiccApi["oauthAuthorizeWait"]>>) => void>();
    const sessionIds = [
      "00000000-0000-4000-8000-000000000041",
      "00000000-0000-4000-8000-000000000042",
      "00000000-0000-4000-8000-000000000043",
      "00000000-0000-4000-8000-000000000044",
    ];
    const sessionProfiles = new Map<string, string>();
    let deferNextBegin = false;
    let resolveDeferredBegin: ((value: Awaited<ReturnType<ApiccApi["oauthAuthorizeBegin"]>>) => void) | undefined;
    let deferAcquires = false;
    const acquireResolvers: Array<(value: Awaited<ReturnType<ApiccApi["oauthProfileAcquire"]>>) => void> = [];
    api.oauthProfilesGet = async (input) => {
      profileReads.push(input);
      const visibleProfiles = input.environmentId && input.environmentId !== environment.id
        ? profiles.map((item) => ({ ...item, profile: { ...item.profile, environmentId: input.environmentId } }))
        : profiles;
      return { revision: input.environmentId === environment.id ? "revision-ui-1" : "revision-ui-other", profiles: visibleProfiles };
    };
    api.oauthProfileAcquire = async (input) => {
      acquires.push(input);
      if (deferAcquires) return new Promise((resolve) => { acquireResolvers.push(resolve); });
      return { result: { status: "success", expiresAt: 2_000_000_000_000 }, profileSnapshot: { status: "available", revision: "revision-ui-1", profiles } };
    };
    api.oauthProfileRefresh = async (input) => {
      refreshes.push(input);
      return { result: { status: "partial_success", errorCode: "OAUTH_REFRESH_TOKEN_SAVE_FAILED" }, profileSnapshot: { status: "unavailable" } };
    };
    api.oauthProfileUnlink = async (input) => {
      unlinks.push(input);
      profiles = [];
      return { result: { status: "success" }, profileSnapshot: { status: "available", revision: "revision-ui-2", profiles } };
    };
    api.oauthAuthorizeBegin = async (input) => {
      begins.push(input);
      const sessionId = sessionIds[begins.length - 1]!;
      sessionProfiles.set(sessionId, input.profileId);
      if (deferNextBegin) {
        deferNextBegin = false;
        return new Promise((resolve) => { resolveDeferredBegin = resolve; });
      }
      return { sessionId, profileId: input.profileId, status: "pending", sessionExpiresAt: 2_000_000_300_000 };
    };
    api.oauthAuthorizeWait = async ({ sessionId }) => new Promise((resolve) => { waitResolvers.set(sessionId, resolve); });
    api.oauthAuthorizeCancel = async (input) => {
      cancels.push(input);
      return { sessionId: input.sessionId, profileId: sessionProfiles.get(input.sessionId) ?? profile.profileId, status: "cancelled", sessionExpiresAt: 2_000_000_300_000 };
    };
    const credentialRemove = vi.fn(api.credentialRemove.bind(api));
    api.credentialRemove = credentialRemove;

    await wrapper.setProps({ projectLocator: project.locator, requestTab } as never);
    await flushPromises();

    expect(wrapper.find('[data-testid="oauth-manager"]').exists()).toBe(true);
    expect(profileReads).toEqual([{ locator: project.locator, environmentId: environment.id }]);
    expect(acquires).toHaveLength(0);
    expect(begins).toHaveLength(0);
    expect(wrapper.get('[data-testid="oauth-profile-status"]').text()).toContain("已连接");
    expect(wrapper.get('[data-testid="oauth-profile-expiry"]').text()).toContain("2033");
    expect(wrapper.text()).not.toContain("never-render-this-access-secret");
    expect(wrapper.get('[data-testid="credential-save"]').attributes("disabled")).toBeDefined();

    await wrapper.get('[data-testid="oauth-authorize"]').trigger("click");
    await flushPromises();
    expect(begins).toEqual([{ locator: project.locator, environmentId: environment.id, profileId: profile.profileId }]);
    expect(waitResolvers.get(sessionIds[0]!)).toBeTypeOf("function");
    await wrapper.get('[data-testid="oauth-cancel"]').trigger("click");
    await flushPromises();
    expect(cancels).toEqual([{ sessionId: sessionIds[0] }]);
    waitResolvers.get(sessionIds[0]!)?.({ sessionId: sessionIds[0]!, profileId: profile.profileId, status: "success", sessionExpiresAt: 2_000_000_300_000, operationResult: { status: "success", expiresAt: 2_000_000_000_000 } });
    await flushPromises();
    expect(wrapper.get('[data-testid="oauth-session-status"]').text()).toContain("已取消");

    await wrapper.get('[data-testid="oauth-refresh"]').trigger("click");
    await flushPromises();
    expect(refreshes).toEqual([{ locator: project.locator, environmentId: environment.id, profileId: profile.profileId }]);
    expect(wrapper.get('[data-testid="oauth-action-result"]').text()).toContain("Refresh Token 保存失败");
    expect(wrapper.get('[data-testid="oauth-snapshot-status"]').text()).toContain("不可用");

    await wrapper.get('[data-testid="oauth-reload"]').trigger("click");
    await flushPromises();
    expect(profileReads).toEqual([
      { locator: project.locator, environmentId: environment.id },
      { locator: project.locator, environmentId: environment.id },
    ]);
    await wrapper.get('[data-testid="oauth-unlink"]').trigger("click");
    await flushPromises();
    expect(unlinks).toEqual([{ locator: project.locator, environmentId: environment.id, profileId: profile.profileId, expectedRevision: "revision-ui-1" }]);
    expect(credentialRemove).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="oauth-snapshot-status"]').text()).toContain("可用");
    expect((wrapper.get('[data-testid="credential-value"]').element as HTMLInputElement).disabled).toBe(false);

    const credentialPut = vi.fn(api.credentialPut.bind(api));
    api.credentialPut = credentialPut;
    const savedProfiles: Parameters<ApiccApi["oauthProfileSave"]>[0][] = [];
    let failNextProfileSave = false;
    api.oauthProfileSave = async (input) => {
      savedProfiles.push(input);
      if (failNextProfileSave) {
        failNextProfileSave = false;
        return {
          result: { status: "failed", errorCode: "OAUTH_PROFILE_REVISION_CONFLICT" },
          profileSnapshot: { status: "available", revision: "revision-ui-3", profiles },
        };
      }
      profiles = [{ ...summary, profile: input.profile }, alternateSummary];
      return {
        result: { status: "success" },
        profileSnapshot: { status: "available", revision: savedProfiles.length === 1 ? "revision-ui-3" : "revision-ui-4", profiles },
      };
    };
    await wrapper.get('[data-testid="oauth-flow"]').setValue("client_credentials");
    await wrapper.get('[data-testid="oauth-token-endpoint"]').setValue("https://issuer.example/new-token");
    await wrapper.get('[data-testid="oauth-client-id"]').setValue("client-created-in-form");
    await wrapper.get('[data-testid="oauth-client-secret"]').setValue("synthetic-new-client-secret");
    expect((wrapper.get('[data-testid="oauth-client-secret"]').element as HTMLInputElement).value).toBe("synthetic-new-client-secret");
    expect((wrapper.get('[data-testid="oauth-save"]').element as HTMLButtonElement).disabled).toBe(false);
    await wrapper.get('[data-testid="oauth-profile-form"]').trigger("submit");
    await flushPromises();
    await flushPromises();
    expect(credentialPut).toHaveBeenCalledTimes(1);
    expect(savedProfiles).toHaveLength(1);
    const savedProfile = savedProfiles[0]!.profile;
    expect(savedProfiles[0]).toMatchObject({
      locator: project.locator,
      environmentId: environment.id,
      expectedRevision: "revision-ui-2",
      profile: {
        flow: "client_credentials",
        tokenEndpoint: "https://issuer.example/new-token",
        clientId: "client-created-in-form",
        clientAuthentication: "client_secret_post",
        bearerRef: { policy: "test-auto" },
        clientSecretRef: { policy: "test-auto" },
      },
    });
    expect(savedProfile.bearerRef.id).not.toBe(bearerRef.id);
    expect(credentialPut).toHaveBeenCalledExactlyOnceWith({
      locator: project.locator,
      ref: savedProfile.clientSecretRef,
      value: "synthetic-new-client-secret",
    });
    expect(request.auth).toEqual({ kind: "bearer", token: savedProfile.bearerRef });
    expect(wrapper.text()).not.toContain("synthetic-new-client-secret");
    expect((wrapper.get('[data-testid="oauth-save"]').element as HTMLButtonElement).disabled).toBe(false);
    expect(wrapper.find('[data-testid="oauth-acquire"]').exists()).toBe(true);
    await wrapper.get('[data-testid="oauth-acquire"]').trigger("click");
    await flushPromises();
    expect(acquires).toEqual([{ locator: project.locator, environmentId: environment.id, profileId: savedProfile.profileId }]);

    const previousSecretRef = savedProfile.clientSecretRef!;
    failNextProfileSave = true;
    await wrapper.get('[data-testid="oauth-client-secret"]').setValue("synthetic-updated-client-secret");
    await wrapper.get('[data-testid="oauth-profile-form"]').trigger("submit");
    await flushPromises();
    const failedEdit = savedProfiles[1]!;
    expect(failedEdit.profile.profileId).toBe(savedProfile.profileId);
    expect(failedEdit.profile.bearerRef).toEqual(savedProfile.bearerRef);
    expect(failedEdit.profile.clientSecretRef!.id).not.toBe(previousSecretRef.id);
    expect(credentialPut).toHaveBeenCalledTimes(2);
    expect(credentialPut).toHaveBeenLastCalledWith({ locator: project.locator, ref: failedEdit.profile.clientSecretRef, value: "synthetic-updated-client-secret" });
    expect((wrapper.get('[data-testid="oauth-client-secret"]').element as HTMLInputElement).value).toBe("");
    expect(wrapper.get('[data-testid="oauth-refs"]').text()).toContain(failedEdit.profile.clientSecretRef!.id);
    expect(wrapper.get('[data-testid="oauth-error"]').text()).toContain("秘密值已保存");
    expect((wrapper.get('[data-testid="oauth-save"]').element as HTMLButtonElement).disabled).toBe(false);

    await wrapper.get('[data-testid="oauth-profile-form"]').trigger("submit");
    await flushPromises();
    const retriedEdit = savedProfiles[2]!;
    expect(retriedEdit.expectedRevision).toBe("revision-ui-3");
    expect(retriedEdit.profile.clientSecretRef).toEqual(failedEdit.profile.clientSecretRef);
    expect(retriedEdit.profile.bearerRef).toEqual(savedProfile.bearerRef);
    expect(credentialPut).toHaveBeenCalledTimes(2);
    expect((wrapper.get('[data-testid="oauth-save"]').element as HTMLButtonElement).disabled).toBe(false);

    const secondEnvironment = await api.envCreate({ locator: project.locator, name: "oauth-busy-next-context" });
    await editor.reloadEnvs();
    deferAcquires = true;
    await wrapper.get('[data-testid="oauth-acquire"]').trigger("click");
    await flushPromises();
    expect(acquireResolvers).toHaveLength(1);
    expect((wrapper.get('[data-testid="oauth-acquire"]').element as HTMLButtonElement).disabled).toBe(true);
    chooseSelect(wrapper, "debug-env-select", secondEnvironment.id);
    await flushPromises();
    await flushPromises();
    expect(wrapper.get('[data-testid="oauth-snapshot-status"]').text()).toContain("可用");
    expect((wrapper.get('[data-testid="oauth-acquire"]').element as HTMLButtonElement).disabled).toBe(false);
    await wrapper.get('[data-testid="oauth-acquire"]').trigger("click");
    await flushPromises();
    expect(acquireResolvers).toHaveLength(2);
    expect((wrapper.get('[data-testid="oauth-acquire"]').element as HTMLButtonElement).disabled).toBe(true);
    acquireResolvers[0]!({ result: { status: "success" }, profileSnapshot: { status: "available", revision: "stale-context", profiles } });
    await flushPromises();
    expect((wrapper.get('[data-testid="oauth-acquire"]').element as HTMLButtonElement).disabled).toBe(true);
    acquireResolvers[1]!({ result: { status: "success" }, profileSnapshot: { status: "available", revision: "revision-ui-other", profiles } });
    await flushPromises();
    expect((wrapper.get('[data-testid="oauth-acquire"]').element as HTMLButtonElement).disabled).toBe(false);

    chooseSelect(wrapper, "debug-env-select", environment.id);
    await flushPromises();
    await flushPromises();
    await wrapper.get('[data-testid="oauth-profile-select"]').setValue(alternateProfile.profileId);
    await flushPromises();
    await wrapper.get('[data-testid="oauth-authorize"]').trigger("click");
    await flushPromises();
    expect(waitResolvers.get(sessionIds[1]!)).toBeTypeOf("function");
    await wrapper.get('[data-testid="oauth-profile-select"]').setValue(savedProfile.profileId);
    await flushPromises();
    expect(cancels).toContainEqual({ sessionId: sessionIds[1] });
    waitResolvers.get(sessionIds[1]!)?.({ sessionId: sessionIds[1]!, profileId: alternateProfile.profileId, status: "success", sessionExpiresAt: 2_000_000_300_000, operationResult: { status: "success", expiresAt: 2_000_000_000_000 } });
    await flushPromises();
    expect(wrapper.find('[data-testid="oauth-session-status"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="oauth-action-result"]').exists()).toBe(false);

    deferNextBegin = true;
    await wrapper.get('[data-testid="oauth-profile-select"]').setValue(alternateProfile.profileId);
    await wrapper.get('[data-testid="oauth-authorize"]').trigger("click");
    await flushPromises();
    expect(resolveDeferredBegin).toBeTypeOf("function");
    await wrapper.get('[data-testid="oauth-profile-select"]').setValue(savedProfile.profileId);
    await flushPromises();
    resolveDeferredBegin?.({ sessionId: sessionIds[2]!, profileId: alternateProfile.profileId, status: "pending", sessionExpiresAt: 2_000_000_300_000 });
    await flushPromises();
    expect(cancels).toContainEqual({ sessionId: sessionIds[2] });

    deferNextBegin = true;
    await wrapper.get('[data-testid="oauth-profile-select"]').setValue(alternateProfile.profileId);
    await wrapper.get('[data-testid="oauth-authorize"]').trigger("click");
    await flushPromises();
    expect(resolveDeferredBegin).toBeTypeOf("function");
    wrapper.unmount();
    resolveDeferredBegin?.({ sessionId: sessionIds[3]!, profileId: alternateProfile.profileId, status: "pending", sessionExpiresAt: 2_000_000_300_000 });
    await flushPromises();
    expect(cancels).toContainEqual({ sessionId: sessionIds[3] });
  });

  it("free OAuth 管理按真实 tab owner/environment/Bearer 隔离，旧 owner 迟到快照不能覆盖新签", async () => {
    const { wrapper, api, editor, debug, workspace } = await mountWith(RequestEditor);
    const { project: firstProject } = seededProjectAndApi(workspace);
    const firstEnvironment = await api.envCreate({ locator: firstProject.locator, name: "free-owner-a" });
    const rootTree = await api.treeGet();
    const group = rootTree.kind === "root" ? rootTree.children.find((node) => node.kind === "group") : undefined;
    if (!group || group.kind !== "group") throw new Error("Memory workspace is missing the project owner group");
    const secondProject = await api.nodeCreate({ kind: "project", parent: group.locator, name: "Free OAuth owner B" });
    if (secondProject.kind !== "project") throw new Error("Memory API did not create the second OAuth owner");
    const secondEnvironment = await api.envCreate({ locator: secondProject.locator, name: "free-owner-b" });
    const firstBearer = { id: "free-oauth-bearer-a", policy: "test-auto" as const };
    const secondBearer = { id: "free-oauth-bearer-b", policy: "test-auto" as const };
    const firstTab = {
      tabId: "free-oauth-tab-a",
      root: workspace.root!,
      project: firstProject.locator,
      source: { kind: "free" as const, project: firstProject.locator, draftId: "free-oauth-draft-a" },
      generation: 11,
    };
    const secondTab = {
      tabId: "free-oauth-tab-b",
      root: workspace.root!,
      project: secondProject.locator,
      source: { kind: "free" as const, project: secondProject.locator, draftId: "free-oauth-draft-b" },
      generation: 29,
    };
    await editor.loadFreeRequestTab(firstTab);
    debug.requestTabState(firstTab).selectedEnvironmentId = firstEnvironment.id;
    editor.freeSessions[firstTab.tabId]!.request.auth = { kind: "bearer", token: firstBearer };

    const makeSummary = (profileId: string, environmentId: string, bearerRef: typeof firstBearer) => ({
      profile: {
        profileId,
        environmentId,
        flow: "authorization_code" as const,
        authorizationEndpoint: "https://issuer.example/authorize",
        tokenEndpoint: "https://issuer.example/token",
        clientId: "safe-client-id",
        clientAuthentication: "none" as const,
        bearerRef,
      },
      configurationFingerprint: `sha256:${profileId}`,
      status: "connected" as const,
    } satisfies Awaited<ReturnType<ApiccApi["oauthProfilesGet"]>>["profiles"][number]);
    let resolveFirstRead!: (value: Awaited<ReturnType<ApiccApi["oauthProfilesGet"]>>) => void;
    const profileReads: Parameters<ApiccApi["oauthProfilesGet"]>[0][] = [];
    api.oauthProfilesGet = async (input) => {
      profileReads.push(input);
      if (profileReads.length === 1) return new Promise((resolve) => { resolveFirstRead = resolve; });
      return { revision: "revision-owner-b", profiles: [makeSummary("owner-b-profile", secondEnvironment.id, secondBearer)] };
    };

    await wrapper.setProps({ requestTab: firstTab, projectLocator: firstProject.locator } as never);
    await flushPromises();
    const manager = wrapper.findComponent(OAuthManager);
    expect(manager.exists()).toBe(true);
    expect(manager.props("locator")).toEqual(firstProject.locator);
    expect(profileReads).toEqual([{ locator: firstProject.locator, environmentId: firstEnvironment.id }]);

    await editor.loadFreeRequestTab(secondTab);
    debug.requestTabState(secondTab).selectedEnvironmentId = secondEnvironment.id;
    editor.freeSessions[secondTab.tabId]!.request.auth = { kind: "bearer", token: secondBearer };
    await wrapper.setProps({ requestTab: secondTab, projectLocator: secondProject.locator } as never);
    await flushPromises();
    await flushPromises();

    expect(profileReads).toEqual([
      { locator: firstProject.locator, environmentId: firstEnvironment.id },
      { locator: secondProject.locator, environmentId: secondEnvironment.id },
    ]);
    const currentManager = wrapper.findComponent(OAuthManager);
    expect(currentManager.props("locator")).toEqual(secondProject.locator);
    expect(JSON.parse(currentManager.props("contextKey"))).toMatchObject({
      root: workspace.root,
      project: secondProject.locator,
      tabId: secondTab.tabId,
      generation: secondTab.generation,
      environmentId: secondEnvironment.id,
      bearerRef: secondBearer,
    });
    expect(wrapper.get('[data-testid="oauth-profile-select"]').text()).toContain("owner-b-profile");

    resolveFirstRead({ revision: "revision-owner-a", profiles: [makeSummary("owner-a-late-profile", firstEnvironment.id, firstBearer)] });
    await flushPromises();
    expect(wrapper.get('[data-testid="oauth-profile-select"]').text()).toContain("owner-b-profile");
    expect(wrapper.get('[data-testid="oauth-profile-select"]').text()).not.toContain("owner-a-late-profile");
    const credentialEditor = wrapper.findComponent(CredentialEditor);
    expect(credentialEditor.props("locator")).toEqual(secondProject.locator);
    expect(credentialEditor.props("auth")).toEqual({ kind: "bearer", token: secondBearer });
  });

  it("编辑 URL 触发 update 且显示发送按钮", async () => {
    const { wrapper, editor, workspace } = await mountWith(RequestEditor);
    // 未加载接口时是空态，无编辑输入
    expect(wrapper.find('[data-testid="editor-base-url"]').exists()).toBe(false);
    const { apiNode } = seededProjectAndApi(workspace);
    await editor.load(apiNode.locator);
    await flushPromises();
    const url = wrapper.find('[data-testid="editor-base-url"]');
    await url.setValue("http://example.com/x");
    expect((url.element as HTMLInputElement).value).toBe("http://example.com/x");
    // v-model 直接写 editor.api 字段（Pinia 响应式），dirty 快照比对 getter 跟踪
    expect(editor.api!.contract.request.baseUrl).toBe("http://example.com/x");
    expect(editor.dirty).toBe(true);
    expect(wrapper.find('[data-testid="send-btn"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="save-btn"]').exists()).toBe(true);
  });

  it("点击发送走默认 apicc.debugSend 并产生结果", async () => {
    const { wrapper, editor, debug, workspace } = await mountWith(RequestEditor);
    const { apiNode } = seededProjectAndApi(workspace);
    await editor.load(apiNode.locator);
    await clickDebugSendAndWait(wrapper, debug);
    expect(debug.result).not.toBeNull();
    expect(debug.sending).toBe(false);
    expect(debug.error).toBeNull();
  });

  it("认证 tab：选择类型生成对应 auth 字段", async () => {
    const { wrapper, editor, workspace } = await mountWith(RequestEditor);
    const { apiNode } = seededProjectAndApi(workspace);
    await editor.load(apiNode.locator);
    // a-tabs 页签钩子为 #tab slot 内的 span，点击冒泡到 a-tabs 完成切换。
    await wrapper.find('[data-testid="tab-auth"]').trigger("click");
    chooseSelect(wrapper, "auth-type", "bearer");
    await flushPromises();
    const request = editor.api!.contract.request;
    if (request.protocol !== "http") throw new Error("Seeded API request must be HTTP");
    expect(request.auth).toMatchObject({ kind: "bearer", token: { id: expect.any(String), policy: "test-auto" } });
    expect(wrapper.find('[data-testid="auth-token"]').exists()).toBe(false);
  });

  it("请求体 tab：选择 form 类型后可添加行", async () => {
    const { wrapper, editor, workspace } = await mountWith(RequestEditor);
    const { apiNode } = seededProjectAndApi(workspace);
    await editor.load(apiNode.locator);
    await wrapper.find('[data-testid="tab-body"]').trigger("click");
    chooseBodyKind(wrapper, "urlencoded");
    await flushPromises();
    const request = editor.api!.contract.request;
    if (request.protocol !== "http") throw new Error("Seeded API request must be HTTP");
    expect(request.body).toEqual({ kind: "urlencoded", fields: [] });
    await wrapper.find('[data-testid="body-add-field"]').trigger("click");
    expect(request.body).toMatchObject({ kind: "urlencoded", fields: [{ id: expect.any(String), name: "", value: "", enabled: true }] });
  });

  it("调试选择器：发送使用 request invocation 和 environmentId，不自动应用选中用例", async () => {
    const { wrapper, api, editor, debug, workspace } = await mountWith(RequestEditor);
    const { project, apiNode } = seededProjectAndApi(workspace);
    await editor.load(apiNode.locator);
    // 种子项目无环境且仅一个用例：通过真实 memory API 创建环境，再由 editor 重新水合。
    await api.envCreate({ locator: project.locator, name: "dev" });
    await editor.reloadEnvs();
    editor.api!.cases.push({ id: "t2", name: "second", scope: "base", parameters: {}, preOperations: [], postOperations: [], assertions: [] });
    const devEnvironment = editor.envs.find((environment) => environment.name === "dev");
    if (!devEnvironment) throw new Error("Created dev environment did not reload into the editor");
    const trace = traceDebugStartWait(api);
    chooseSelect(wrapper, "debug-env-select", "dev");
    chooseSelect(wrapper, "debug-case-select", JSON.stringify(["t2", "base"]));
    await clickDebugSendAndWait(wrapper, debug);
    expect(debug.selectedCase).toEqual({ caseId: "t2", scope: "base" });
    expect(trace.invocations).toHaveLength(1);
    const invocation = trace.invocations[0]!;
    expect(invocation.mode).toBe("request");
    if (invocation.mode !== "request") throw new Error("RequestEditor send must use request mode");
    expect(invocation.locator).toEqual(apiNode.locator);
    expect(invocation.environmentId).toBe(devEnvironment.id);
    expect(invocation.request).toEqual(editor.api!.contract.request);
    expect(invocation).not.toHaveProperty("case");
    expect(trace.waitedRunIds).toEqual(trace.runIds);
    expect(debug.result).not.toBeNull();
    expect(debug.result?.mode).toBe("request");
    expect(debug.error).toBeNull();
    expect(debug.sending).toBe(false);
  });

  it("悬空用例选择显示回退：切接口后失效 id 不再显示，回退 cases[0]（显示与 send 一致）", async () => {
    const { wrapper, api, editor, debug, workspace } = await mountWith(RequestEditor);
    const { apiNode } = seededProjectAndApi(workspace);
    await editor.load(apiNode.locator);
    const defaultPath = editor.api!.contract.request.path;
    const selectedOverride = JSON.parse(JSON.stringify(editor.api!.contract.request));
    selectedOverride.path = "/selected-case-only";
    editor.api!.cases.push({ id: "t2", name: "second", scope: "base", parameters: {}, preOperations: [], postOperations: [], assertions: [], requestOverride: selectedOverride });
    chooseSelect(wrapper, "debug-case-select", JSON.stringify(["t2", "base"]));
    expect(debug.selectedCase?.caseId).toBe("t2");
    // 模拟切接口：cases 整体换成不含 t2 的集合（store 选择状态不清除，仍指向失效 id）
    const fallbackOverride = JSON.parse(JSON.stringify(editor.api!.contract.request));
    fallbackOverride.path = "/fallback-case-only";
    editor.api!.cases = [{ id: "t9", name: "other", scope: "base", parameters: {}, preOperations: [], postOperations: [], assertions: [], requestOverride: fallbackOverride }];
    await flushPromises();
    // 显示侧须回退 cases[0]，但 request-mode 发送不得把回退用例的 override 应用到默认请求。
    expect(selectValue(wrapper, "debug-case-select")).toBe(JSON.stringify(["t9", "base"]));
    const trace = traceDebugStartWait(api);
    await clickDebugSendAndWait(wrapper, debug);
    expect(trace.invocations).toHaveLength(1);
    const invocation = trace.invocations[0]!;
    expect(invocation.mode).toBe("request");
    if (invocation.mode !== "request") throw new Error("RequestEditor send must use request mode");
    expect(invocation.locator).toEqual(apiNode.locator);
    expect(invocation.request.path).toBe(defaultPath);
    expect(invocation.request.path).not.toBe("/selected-case-only");
    expect(invocation.request.path).not.toBe("/fallback-case-only");
    expect(invocation).not.toHaveProperty("case");
    expect(trace.waitedRunIds).toEqual(trace.runIds);
    expect(debug.result?.mode).toBe("request");
  });

  it("悬空环境选择显示回退：删环境后失效名不再显示，回退「无环境」（显示与 send 一致）", async () => {
    const { wrapper, api, editor, debug, workspace } = await mountWith(RequestEditor);
    const { project, apiNode } = seededProjectAndApi(workspace);
    await editor.load(apiNode.locator);
    await api.envCreate({ locator: project.locator, name: "dev" });
    await editor.reloadEnvs();
    const defaultPath = editor.api!.contract.request.path;
    const caseOverride = JSON.parse(JSON.stringify(editor.api!.contract.request));
    caseOverride.path = "/case-only";
    editor.api!.cases[0]!.requestOverride = caseOverride;
    chooseSelect(wrapper, "debug-env-select", "dev");
    await flushPromises();
    expect(selectValue(wrapper, "debug-env-select")).toBe("dev");
    editor.envs.splice(0, editor.envs.length); // 模拟刷新结果已不含所选环境（send 回退 undefined → 无环境）
    await flushPromises();
    expect(selectValue(wrapper, "debug-env-select")).toBe("");
    const trace = traceDebugStartWait(api);
    await clickDebugSendAndWait(wrapper, debug);
    expect(trace.invocations).toHaveLength(1);
    const invocation = trace.invocations[0]!;
    expect(invocation.mode).toBe("request");
    if (invocation.mode !== "request") throw new Error("RequestEditor send must use request mode");
    expect(invocation.locator).toEqual(apiNode.locator);
    expect(invocation.environmentId).toBeUndefined();
    expect(invocation.request.path).toBe(defaultPath);
    expect(invocation.request.path).not.toBe("/case-only");
    expect(invocation).not.toHaveProperty("case");
    expect(trace.waitedRunIds).toEqual(trace.runIds);
    expect(debug.result?.mode).toBe("request");
  });

  it("M5-B 协议选择：正式契约明确 HTTP 默认值，三协议选项文案走 i18n", async () => {
    const { wrapper, editor, workspace } = await mountWith(RequestEditor);
    const { apiNode } = seededProjectAndApi(workspace);
    await editor.load(apiNode.locator);
    expect(editor.api!.contract.request.protocol).toBe("http");
    expect(protocolValue(wrapper)).toBe("http");
    expect(protocolOptionsOf(wrapper).map((o) => o.value)).toEqual(["http", "websocket", "soap"]);
    expect(protocolOptionsOf(wrapper).map((o) => o.label)).toEqual(["HTTP", "WebSocket", "SOAP"]);
  });

  it("M5-B HTTP↔WebSocket↔SOAP 多轮编辑/草稿保留/合法保存载荷（旧三协议与保存标题合并）", async () => {
    const { wrapper, api, editor, workspace } = await mountWith(RequestEditor);
    const { apiNode } = seededProjectAndApi(workspace);
    await editor.load(apiNode.locator);

    const initial = editor.api!.contract.request;
    if (initial.protocol !== "http") throw new Error("Seeded API request must be HTTP");
    initial.query.push({ kind: "inline", id: randomUUID(), name: "q1", schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "", value: "v1" });
    initial.body = { kind: "json", content: '{"a":1}' };

    // 旧“切 WebSocket”断言：HTTP 专属 method/body 面板退场，WS message tab 入场。
    chooseProtocol(wrapper, "websocket");
    await flushPromises();
    expect(wrapper.find('[data-testid="editor-method"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="tab-path"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="tab-body"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="tab-message"]').exists()).toBe(true);
    await wrapper.find('[data-testid="tab-message"]').trigger("click");
    const message = wrapper.find('[data-testid="editor-message"]');
    expect(message.exists()).toBe(true);
    await message.setValue("hello {{name}}");
    const websocket = editor.api!.contract.request;
    if (websocket.protocol !== "websocket") throw new Error("Protocol switch did not produce WebSocket request");
    expect(websocket.message).toBe("hello {{name}}");

    // 旧“切 SOAP”断言：SOAP 固定 POST，不暴露 HTTP 参数/请求体控件。
    chooseProtocol(wrapper, "soap");
    await flushPromises();
    const soap = editor.api!.contract.request;
    if (soap.protocol !== "soap") throw new Error("Protocol switch did not produce SOAP request");
    expect(soap.method).toBe("POST");
    expect(wrapper.find('[data-testid="tab-path"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="tab-envelope"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="editor-method"]').text()).toBe("POST");
    expect(wrapper.findAllComponents({ name: "ASelect" }).some((component) => component.attributes("data-testid") === "editor-method")).toBe(false);
    await wrapper.find('[data-testid="tab-envelope"]').trigger("click");
    await wrapper.find('[data-testid="editor-envelope"]').setValue("<Envelope/>");
    await wrapper.find('[data-testid="editor-soap-action"]').setValue("urn:do");
    expect(soap.envelope).toBe("<Envelope/>");
    expect(soap.soapAction).toBe("urn:do");

    // 旧“协议往返”断言：HTTP body/query、WS message 与 SOAP envelope 各自留在原协议草稿。
    chooseProtocol(wrapper, "http");
    await flushPromises();
    const restoredHttp = editor.api!.contract.request;
    if (restoredHttp.protocol !== "http") throw new Error("Protocol switch did not restore HTTP request");
    expect(protocolValue(wrapper)).toBe("http");
    expect(wrapper.find('[data-testid="tab-path"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="tab-body"]').exists()).toBe(true);
    await wrapper.find('[data-testid="tab-path"]').trigger("click");
    expect(restoredHttp.query).toMatchObject([{ name: "q1", value: "v1", enabled: true }]);
    expect(restoredHttp.body).toEqual({ kind: "json", content: '{"a":1}' });
    chooseProtocol(wrapper, "websocket");
    await flushPromises();
    const restoredWebsocket = editor.api!.contract.request;
    if (restoredWebsocket.protocol !== "websocket") throw new Error("Protocol switch did not restore WebSocket request");
    await wrapper.find('[data-testid="tab-message"]').trigger("click");
    expect(restoredWebsocket.message).toBe("hello {{name}}");
    chooseProtocol(wrapper, "soap");
    await flushPromises();
    const restoredSoap = editor.api!.contract.request;
    if (restoredSoap.protocol !== "soap") throw new Error("Protocol switch did not restore SOAP request");
    await wrapper.find('[data-testid="tab-envelope"]').trigger("click");
    expect(restoredSoap.envelope).toBe("<Envelope/>");
    expect(restoredSoap.soapAction).toBe("urn:do");

    // 旧“保存载荷”断言：apiSave 接收 locator + 完整 ApiAsset，且保存后可真实重读。
    const sent: Array<{ locator: ApiLocator; asset: ApiAsset }> = [];
    const original = api.apiSave.bind(api);
    api.apiSave = async (locator, asset, revision) => { sent.push({ locator, asset }); return original(locator, asset, revision); };
    chooseProtocol(wrapper, "websocket");
    await flushPromises();
    await clickEditorSaveAndWait(wrapper, editor);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      locator: apiNode.locator,
      asset: { contract: { request: { protocol: "websocket", message: "hello {{name}}" } } },
    });
    expect((await api.apiGet(apiNode.locator)).api.contract.request).toMatchObject({ protocol: "websocket", message: "hello {{name}}" });
    expect(editor.dirty).toBe(false);
  });

  // —— M5-B 审查预修：RequestEditor 常驻挂载（App.vue 无 :key），editor.load 原地换 api ——
  // 旧缺陷：协议页签（如 WS message）下切接口，activeTab 本地 ref 无 watcher，无效键
  // 无对应面板 → 编辑区空白。修复 = watch apiId/protocol 重置为新对象协议首签。
  it("M5-B 预修①：WS 消息页签下切另一接口 → 页签回落新接口首签，编辑区可编辑", async () => {
    const { wrapper, api, editor, workspace } = await mountWith(RequestEditor);
    const { apiNode: apiA, collection } = seededProjectAndApi(workspace);
    await editor.load(apiA.locator);
    chooseProtocol(wrapper, "websocket");
    await flushPromises();
    await wrapper.find('[data-testid="tab-message"]').trigger("click");
    expect(wrapper.find('[data-testid="editor-message"]').exists()).toBe(true);
    // 侧树选中新建接口 B：App.vue 对 api 节点即调 editor.load（组件常驻挂载无 remount）
    const created = await api.nodeCreate({ kind: "api", parent: collection.locator, api: { name: "接口B" } });
    if (created.kind !== "api") throw new Error("Expected nodeCreate to return an API node");
    await editor.load(created.locator);
    await flushPromises();
    // 新接口是正式 HTTP 契约：message 面板退场，HTTP path 页签仍可操作。
    expect(wrapper.find('[data-testid="editor-message"]').exists()).toBe(false);
    expect(protocolValue(wrapper)).toBe("http");
    await wrapper.find('[data-testid="tab-path"]').trigger("click");
    expect(wrapper.find('[data-testid="add-path"]').exists()).toBe(true);
    expect(paneActive(wrapper, "add-path")).toBe(true);
  });

  it("M5-B 预修②：同协议页签集内常规互切（http params↔headers、WS message↔headers）不受重置干扰", async () => {
    const { wrapper, editor, workspace } = await mountWith(RequestEditor);
    const { apiNode } = seededProjectAndApi(workspace);
    await editor.load(apiNode.locator);
    // HTTP path（默认激活）→ headers → path（激活面板随点击迁移）。
    expect(paneActive(wrapper, "add-path")).toBe(true);
    await wrapper.find('[data-testid="tab-header"]').trigger("click");
    await flushPromises();
    expect(paneActive(wrapper, "add-header")).toBe(true);
    expect(paneActive(wrapper, "add-path")).toBe(false);
    await wrapper.find('[data-testid="tab-path"]').trigger("click");
    await flushPromises();
    expect(paneActive(wrapper, "add-path")).toBe(true);
    // WS message → headers → message，同协议内页签互切。
    chooseProtocol(wrapper, "websocket");
    await flushPromises();
    await wrapper.find('[data-testid="tab-message"]').trigger("click");
    expect(paneActive(wrapper, "editor-message")).toBe(true);
    await wrapper.find('[data-testid="tab-header"]').trigger("click");
    await flushPromises();
    expect(paneActive(wrapper, "add-header")).toBe(true);
    expect(paneActive(wrapper, "editor-message")).toBe(false);
    await wrapper.find('[data-testid="tab-message"]').trigger("click");
    await flushPromises();
    expect(paneActive(wrapper, "editor-message")).toBe(true);
  });
});

describe("ResponseViewer", () => {
  const result = {
    run: { total: 1, passed: 1, failed: 0, cases: [], startedAt: "", finishedAt: "", collectionId: "c", collectionName: "c" },
    outcome: {
      apiId: "a", apiName: "a", caseId: "t", caseName: "用例甲", passed: true, durationMs: 5,
      assertions: [{ pass: false, message: "eq 失败" }],
    },
  };

  it("无结果时显示空态", () => {
    const wrapper = mountWithI18n(ResponseViewer, {});
    expect(wrapper.find('[data-testid="response-empty"]').exists()).toBe(true);
  });

  it("有结果时显示状态徽标与断言明细（M8：断言收编为第三页签，点击后可见）", async () => {
    const wrapper = mountWithI18n(ResponseViewer, {});
    await wrapper.setProps({ result });
    expect(wrapper.find('[data-testid="response-empty"]').exists()).toBe(false);
    // 头部展示结果归属用例名（outcome.caseName 字段已有，此前未上 UI）
    expect(wrapper.text()).toContain("用例甲");
    expect(wrapper.find('[data-testid="response-outcome"]').exists()).toBe(true);
    // 断言明细在断言页签内（懒渲染：未点击不在 DOM）
    expect(wrapper.text()).not.toContain("eq 失败");
    await wrapper.find('[data-testid="response-tab-assertions"]').trigger("click");
    expect(wrapper.find('[data-testid="response-assertions"]').exists()).toBe(true);
    expect(wrapper.text()).toContain("eq 失败");
  });

  it("无 response 时 body/headers tab 显示占位「—」（DebugOutput.response 缺失不得臆造）", async () => {
    const wrapper = mountWithI18n(ResponseViewer, { result });
    expect(wrapper.find('[data-testid="response-body"]').text()).toBe("—");
    await wrapper.find('[data-testid="response-tab-headers"]').trigger("click");
    expect(wrapper.find('[data-testid="response-headers"]').text()).toBe("—");
  });

  it("带 response 时 body 展示真实响应体（JSON pretty），headers 展示响应头表格", async () => {
    const withResponse = {
      ...result,
      response: { status: 200, headers: { "content-type": "application/json" }, bodyText: '{"ok":true}', timeMs: 3 },
    };
    const wrapper = mountWithI18n(ResponseViewer, { result: withResponse });
    expect(wrapper.find('[data-testid="response-body"]').text()).toContain('"ok": true');
    await wrapper.find('[data-testid="response-tab-headers"]').trigger("click");
    const headers = wrapper.find('[data-testid="response-headers"]');
    expect(headers.text()).toContain("content-type");
    expect(headers.text()).toContain("application/json");
  });

  it("带 response 时头部展示状态码与请求耗时；无 response 时不展示（宽审查修复 2）", async () => {
    const withResponse = {
      ...result,
      response: { status: 201, headers: {}, bodyText: "created", timeMs: 12.4 },
    };
    const wrapper = mountWithI18n(ResponseViewer, { result: withResponse });
    expect(wrapper.find('[data-testid="response-status"]').text()).toContain("201");
    expect(wrapper.find('[data-testid="response-time"]').text()).toContain("12 ms");
    await wrapper.setProps({ result });
    expect(wrapper.find('[data-testid="response-status"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="response-time"]').exists()).toBe(false);
  });

  it("error 属性非空时显示错误徽标", () => {
    const wrapper = mountWithI18n(ResponseViewer, { result, error: "网络不可达" });
    expect(wrapper.find('[data-testid="response-error"]').text()).toContain("网络不可达");
  });

  it("shows failed and aborted DebugResult terminals with their host cause instead of a green zero-count run", () => {
    const terminal: DebugResult = {
      runId: "terminal-failure", source: debugFixtureSource, sourceProjectRevision: "project", executionSnapshotRevision: "snapshot",
      mode: "request", startedAt: "2026-10-14T00:00:00.000Z", finishedAt: "2026-10-14T00:00:00.010Z",
      run: { collectionName: "collection", startedAt: "2026-10-14T00:00:00.000Z", finishedAt: "2026-10-14T00:00:00.010Z", total: 0, passed: 0, failed: 0 },
      outcomes: [], exchanges: [], exchangeTotal: 0, omittedExchangeCount: 0,
      replay: { mode: "request", sourceKind: "asset", parameters: {}, fields: [], available: false }, console: [], warnings: [],
      failureKind: "config", error: "credential preparation failed",
    };
    const wrapper = mountWithI18n(ResponseViewer, { result: terminal });
    expect(wrapper.find('[data-testid="response-outcome"]').text()).toContain("失败");
    expect(wrapper.find('[data-testid="response-terminal-error"]').text()).toContain("credential preparation failed");
    expect(wrapper.find('[data-testid="response-outcome"]').text()).not.toContain("通过");

    wrapper.setProps({ result: { ...terminal, runId: "terminal-aborted", failureKind: "aborted", error: "cancelled by user" } });
    return flushPromises().then(() => {
      expect(wrapper.find('[data-testid="response-outcome"]').text()).toContain("已取消");
      expect(wrapper.find('[data-testid="response-terminal-error"]').text()).toContain("cancelled by user");
    });
  });

  it("marks truncated/redacted response projection in view and projected download", async () => {
    const text = "{\"token\":\"[REDACTED]\"}";
    const debugResult: DebugResult = {
      runId: "projected-body", source: debugFixtureSource, sourceProjectRevision: "project", executionSnapshotRevision: "snapshot",
      mode: "request", startedAt: "2026-10-14T00:00:00.000Z", finishedAt: "2026-10-14T00:00:00.010Z",
      run: { collectionName: "collection", startedAt: "2026-10-14T00:00:00.000Z", finishedAt: "2026-10-14T00:00:00.010Z", total: 1, passed: 1, failed: 0 },
      outcomes: [], exchanges: [{ source: debugFixtureExchangeSource, rowIndex: 0, hopIndex: 0, order: 1, transportState: "responded", observation: "http-hop", settings: {
        connectTimeoutMs: 1000, headersTimeoutMs: 1000, bodyTimeoutMs: 1000, totalTimeoutMs: 1000, followRedirects: false, maxRedirects: 0, uploadLimitBytes: 1024, responseLimitBytes: 1024,
      }, response: { status: 200, headers: [["content-type", "application/json"]], cookies: [], body: { kind: "text", text, contentBytes: 4096, truncated: true } }, startedAt: "2026-10-14T00:00:00.000Z" }],
      exchangeTotal: 1, omittedExchangeCount: 0, replay: { mode: "request", sourceKind: "asset", parameters: {}, fields: [{ path: "request.headers[0].value", status: "redacted", needsInput: true }], available: false },
      console: [], warnings: ["Response projection was truncated."],
    };
    const save = vi.fn(async (_defaultName: string, _content: string) => "");
    const wrapper = mountWithI18n(ResponseViewer, { result: debugResult, api: { debugSaveProjected: save } as unknown as ApiccApi });
    expect(wrapper.find('[data-testid="response-projection-note"]').text()).toContain("truncated");
    expect(wrapper.find('[data-testid="response-projection-note"]').text()).toContain("redacted");
    await wrapper.find('[data-testid="response-download"]').trigger("click");
    await flushPromises();
    expect(save.mock.calls[0]?.[1]).toContain("投影说明");
    expect(save.mock.calls[0]?.[1]).toContain("request.headers[0].value");
  });

  it("renders rejected projected-download errors through registered Alert", async () => {
    const api = { debugSaveProjected: vi.fn(async () => { throw new Error("synthetic save failure"); }) } as unknown as ApiccApi;
    const wrapper = mountWithI18n(ResponseViewer, { result, api });
    await wrapper.find('[data-testid="response-download"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="response-action-error"]').text()).toContain("synthetic save failure");
  });

  it("renders a P3 exchange projection as inert text and leaves absent byte counters unknown", async () => {
    const html = "<script>must-not-run()</script>";
    const debugResult: DebugResult = {
      runId: "run-1",
      source: debugFixtureSource,
      sourceProjectRevision: "project-revision",
      executionSnapshotRevision: "snapshot-revision",
      mode: "request",
      startedAt: "2026-10-14T00:00:00.000Z",
      finishedAt: "2026-10-14T00:00:00.010Z",
      run: {
        collectionName: "collection", startedAt: "2026-10-14T00:00:00.000Z",
        finishedAt: "2026-10-14T00:00:00.010Z", total: 0, passed: 0, failed: 0,
      },
      outcomes: [],
      exchanges: [{
        source: debugFixtureExchangeSource,
        rowIndex: 0, hopIndex: 0, order: 1, transportState: "failed", observation: "http-hop", failureStage: "body", failureCode: "ECONNRESET",
        settings: {
          connectTimeoutMs: 1000, headersTimeoutMs: 1000, bodyTimeoutMs: 1000, totalTimeoutMs: 1000,
          followRedirects: false, maxRedirects: 0, uploadLimitBytes: 1024, responseLimitBytes: 1024,
        },
        request: {
          url: "https://example.test", method: "GET", query: [], headers: [], cookies: [], body: { kind: "none" },
          sourceCategories: ["project", "module", "request-override", "auth", "session"],
        },
        response: {
          status: 200, headers: [["content-type", "text/html"]], cookies: [],
          body: { kind: "text", text: html, contentBytes: html.length, truncated: false },
        },
        startedAt: "2026-10-14T00:00:00.000Z", finishedAt: "2026-10-14T00:00:00.010Z", durationMs: 10,
      }],
      exchangeTotal: 1,
      omittedExchangeCount: 0,
      replay: { mode: "request", sourceKind: "asset", parameters: {}, fields: [], available: true },
      console: [],
      warnings: [],
    };
    const wrapper = mountWithI18n(ResponseViewer, { result: debugResult });

    expect(wrapper.find('[data-testid="response-body"]').text()).toBe(html);
    expect(wrapper.find('[data-testid="response-body"] script').exists()).toBe(false);
    await wrapper.find('[data-testid="response-tab-exchanges"]').trigger("click");
    expect(wrapper.find('[data-testid="response-exchanges"]').text()).toContain("未知");
    expect(wrapper.find('[data-testid="response-exchange-1"]').text()).toContain("body");
    expect(wrapper.find('[data-testid="response-exchange-1"]').text()).toContain("ECONNRESET");
    await wrapper.find('[data-testid="response-tab-request"]').trigger("click");
    expect(wrapper.find('[data-testid="response-request-sources"]').text()).toContain("项目资源");
    expect(wrapper.find('[data-testid="response-request-sources"]').text()).toContain("会话 Cookie Jar");
  });

  it("shows captured and effective upload filenames separately from upload byte counters", async () => {
    const result: DebugResult = {
      runId: "upload-metadata", source: debugFixtureSource, sourceProjectRevision: "project", executionSnapshotRevision: "snapshot",
      mode: "request", startedAt: "2026-10-14T00:00:00.000Z", finishedAt: "2026-10-14T00:00:00.010Z",
      run: { collectionName: "collection", startedAt: "2026-10-14T00:00:00.000Z", finishedAt: "2026-10-14T00:00:00.010Z", total: 1, passed: 1, failed: 0 },
      outcomes: [], exchanges: [{ source: debugFixtureExchangeSource, rowIndex: 0, hopIndex: 0, order: 1, transportState: "responded", settings: {
        connectTimeoutMs: 1000, headersTimeoutMs: 1000, bodyTimeoutMs: 1000, totalTimeoutMs: 1000,
        followRedirects: false, maxRedirects: 0, uploadLimitBytes: 1024, responseLimitBytes: 1024,
      }, request: {
        url: "https://example.test", method: "POST", query: [], headers: [], cookies: [], sourceCategories: ["project"],
        body: { kind: "multipart", entries: [{ kind: "file", name: "payload", filename: "override.bin", capturedFilename: "source.bin", capturedSizeBytes: 18, effectiveFilename: "override.bin", metadataAvailable: true, contentType: "application/octet-stream", source: "local-file" }] },
      }, response: {
        status: 200, headers: [], cookies: [], requestBody: { fileBytesRead: 18, transportEncodedBytesWritten: 176, complete: true },
        body: { kind: "text", text: "ok", contentBytes: 2, truncated: false },
      }, startedAt: "2026-10-14T00:00:00.000Z" }],
      exchangeTotal: 1, omittedExchangeCount: 0, replay: { mode: "request", sourceKind: "asset", parameters: {}, fields: [], available: true }, console: [], warnings: [],
    };
    const wrapper = mountWithI18n(ResponseViewer, { result });
    await wrapper.find('[data-testid="response-tab-request"]').trigger("click");
    const body = wrapper.find('[data-testid="response-request-body"]').text();
    expect(body).toContain("source.bin");
    expect(body).toContain("override.bin");
    expect(body).toContain("18 B");
    expect(body).not.toContain("176 B");
    const counters = wrapper.find('[data-testid="response-request-upload-counters"]').text();
    expect(counters).toContain("18 B");
    expect(counters).toContain("176 B");
    expect(counters).toContain("true");
  });

  // —— M5-B 任务 1：D3 响应映射契约 fixture（零分支核验，组件零改动）——
  it("M5-B D3 契约 fixture：WS 响应（status=101 握手 + bodyText=首帧）按既有渲染零分支呈现", async () => {
    const wsResult = {
      ...result,
      response: {
        status: 101,
        headers: { upgrade: "websocket", "sec-websocket-accept": "abc==" },
        bodyText: "first frame",
        timeMs: 42.6,
      },
    };
    const wrapper = mountWithI18n(ResponseViewer, { result: wsResult });
    expect(wrapper.find('[data-testid="response-status"]').text()).toContain("101");
    expect(wrapper.find('[data-testid="response-body"]').text()).toContain("first frame");
    expect(wrapper.find('[data-testid="response-time"]').text()).toContain("43 ms");
    await wrapper.find('[data-testid="response-tab-headers"]').trigger("click");
    const headers = wrapper.find('[data-testid="response-headers"]');
    expect(headers.text()).toContain("upgrade");
    expect(headers.text()).toContain("websocket");
  });

  it("pretty-prints well-formed XML as inert text while Raw preserves exact original body", async () => {
    const xml = "<Envelope><Body><echo>ok</echo></Body></Envelope>";
    const soapResult = {
      ...result,
      response: { status: 200, headers: { "content-type": "text/xml; charset=utf-8" }, bodyText: xml, timeMs: 7 },
    };
    const wrapper = mountWithI18n(ResponseViewer, { result: soapResult });
    expect(wrapper.find('[data-testid="response-status"]').text()).toContain("200");
    expect(wrapper.find('[data-testid="response-body"]').text()).toBe("<Envelope>\n  <Body>\n    <echo>ok</echo>\n  </Body>\n</Envelope>");
    await chooseSelect(wrapper, "response-format", "raw");
    expect(wrapper.find('[data-testid="response-body"]').text()).toBe(xml);
    await wrapper.setProps({ result: { ...soapResult, response: { ...soapResult.response, bodyText: "<Envelope><Body>" } } });
    await chooseSelect(wrapper, "response-format", "pretty");
    expect(wrapper.find('[data-testid="response-body"]').text()).toBe("<Envelope><Body>");

    const significantLeafText = "<Envelope><Body><echo>  keep exact  </echo></Body></Envelope>";
    await wrapper.setProps({ result: { ...soapResult, response: { ...soapResult.response, bodyText: significantLeafText } } });
    expect(wrapper.find('[data-testid="response-body"]').text()).toBe("<Envelope>\n  <Body>\n    <echo>  keep exact  </echo>\n  </Body>\n</Envelope>");

    for (const unsafeXml of [
      "<p>before <b>bold</b> after</p>",
      '<root xml:space="preserve"><leaf>  keep exact  </leaf></root>',
      "<root><leaf><![CDATA[  keep exact  ]]></leaf></root>",
    ]) {
      await wrapper.setProps({ result: { ...soapResult, response: { ...soapResult.response, bodyText: unsafeXml } } });
      expect(wrapper.find('[data-testid="response-body"]').text()).toBe(unsafeXml);
    }
  });
});

describe("DebugHistory filters", () => {
  it("keeps formal case history replayable when captured request availability is stale", async () => {
    const locator = {
      workspaceId: "30000000-0000-4000-8000-000000000001",
      groupId: "30000000-0000-4000-8000-000000000002",
      projectId: "30000000-0000-4000-8000-000000000003",
      collectionId: "30000000-0000-4000-8000-000000000004",
      folderIds: [],
      apiId: "30000000-0000-4000-8000-000000000005",
    };
    const caseIdentity = { ...locator, caseId: "30000000-0000-4000-8000-000000000006" };
    const replay = {
      mode: "case", case: caseIdentity, available: false, identityAvailable: true,
      fields: [{ path: "request.auth.token", status: "missing", needsInput: true }],
    };

    for (const record of [
      { formatVersion: 1, historyId: "legacy-case", result: {
        mode: "case", locator, caseId: caseIdentity.caseId, sourceProjectRevision: "revision",
        identityAvailable: true, replay, exchanges: [],
      } },
      { formatVersion: 2, historyId: "current-case", result: {
        mode: "case", source: { sourceKind: "asset", locator }, sourceProjectRevision: "revision",
        identityAvailable: true, replay, exchanges: [],
      } },
    ]) {
      const history = reactive({
        filter: { limit: 50, offset: 0 }, items: [], diagnostics: [], error: null, loading: false, nextOffset: null,
        selected: { record }, preferences: { enabled: true, retentionDays: 30, maxRecords: 1000 },
        load: vi.fn(async () => {}), refresh: vi.fn(async () => {}), updatePreferences: vi.fn(async () => {}),
        loadMore: vi.fn(async () => {}), openRecord: vi.fn(async () => {}), deleteRecord: vi.fn(async () => {}),
      });
      const wrapper = mountWithI18n(DebugHistory, {
        open: true, api: {} as ApiccApi, history: history as never,
        debug: { restoredFields: [], restoredTargetKey: null, restoredPreview: null, restoredSourceAvailable: null } as never,
        editor: { activeKey: "active", sessions: { active: { locator, sourceProjectRevision: "revision" } } } as never,
      });
      try {
        await flushPromises();
        expect((expectBody("debug-history-replay").element as HTMLButtonElement).disabled).toBe(false);
      } finally {
        wrapper.unmount();
      }
    }
  });

  it("shows the selected history delete action in the active locale", async () => {
    const previousLocale = localStorage.getItem("apicc.locale");
    try {
      for (const [locale, label] of [["zh-CN", "删除记录"], ["en", "Delete record"]] as const) {
        localStorage.setItem("apicc.locale", locale);
        const history = reactive({
          filter: { limit: 50, offset: 0 }, items: [], diagnostics: [], error: null, loading: false, nextOffset: null,
          selected: { record: { historyId: "selected-history", result: {
            identityAvailable: false, replay: { identityAvailable: false, available: false }, exchanges: [],
          } } },
          preferences: { enabled: true, retentionDays: 30, maxRecords: 1000 },
          load: vi.fn(async () => {}), refresh: vi.fn(async () => {}), updatePreferences: vi.fn(async () => {}),
          loadMore: vi.fn(async () => {}), openRecord: vi.fn(async () => {}), deleteRecord: vi.fn(async () => {}),
        });
        const wrapper = mountWithI18n(DebugHistory, {
          open: true, api: {} as ApiccApi, history: history as never,
          debug: { restoredFields: [], restoredTargetKey: null, restoredPreview: null, restoredSourceAvailable: null } as never,
          editor: { activeKey: null, sessions: {} } as never,
        });
        try {
          await flushPromises();
          expect(expectBody("debug-history-delete").text()).toBe(label);
          expect(expectBody("debug-history-delete").text()).not.toBe("debugLoop.deleteRecord");
        } finally {
          wrapper.unmount();
        }
      }
    } finally {
      if (previousLocale === null) localStorage.removeItem("apicc.locale");
      else localStorage.setItem("apicc.locale", previousLocale);
    }
  });

  it("applies the current API and a valid date range, resets pagination, and can return to all scope", async () => {
    const history = reactive({
      filter: { limit: 50, offset: 17, projectId: "old-project" }, items: [], diagnostics: [], error: null,
      loading: false, nextOffset: 0, selected: null, preferences: { enabled: true, retentionDays: 30, maxRecords: 1000 },
      load: vi.fn(async () => {}), refresh: vi.fn(async () => {}), updatePreferences: vi.fn(async () => {}),
      loadMore: vi.fn(async () => {}), openRecord: vi.fn(async () => {}), deleteRecord: vi.fn(async () => {}),
    });
    const editor = { activeKey: "active", sessions: { active: { locator: { projectId: "project-1", apiId: "api-1" } } } };
    const debug = { restoredFields: [], restoredTargetKey: null, restoredPreview: null, restoredSourceAvailable: null };
    const wrapper = mountWithI18n(DebugHistory, {
      open: true,
      api: {} as ApiccApi,
      history: history as never,
      debug: debug as never,
      editor: editor as never,
    });
    await flushPromises();

    await expectBody("debug-history-current-api").trigger("click");
    await expectBody("debug-history-from").setValue("2026-10-14T09:00");
    await expectBody("debug-history-to").setValue("2026-10-14T10:30");
    await expectBody("debug-history-filter").trigger("click");
    expect(history.filter).toMatchObject({
      projectId: "project-1", apiId: "api-1", from: new Date("2026-10-14T09:00").toISOString(),
      to: new Date("2026-10-14T10:30").toISOString(), limit: 50, offset: 0,
    });
    expect(history.refresh).toHaveBeenCalledWith(true);

    await expectBody("debug-history-all-scope").trigger("click");
    await expectBody("debug-history-filter").trigger("click");
    expect(history.filter).not.toHaveProperty("projectId");
    expect(history.filter).not.toHaveProperty("apiId");
  });

  it("rejects a reversed date range and disables scopes without current context", async () => {
    const history = reactive({
      filter: { limit: 50, offset: 4 }, items: [], diagnostics: [], error: null, loading: false, nextOffset: null,
      selected: null, preferences: { enabled: true, retentionDays: 30, maxRecords: 1000 },
      load: vi.fn(async () => {}), refresh: vi.fn(async () => {}), updatePreferences: vi.fn(async () => {}),
      loadMore: vi.fn(async () => {}), openRecord: vi.fn(async () => {}), deleteRecord: vi.fn(async () => {}),
    });
    const wrapper = mountWithI18n(DebugHistory, {
      open: true, api: {} as ApiccApi, history: history as never,
      debug: { restoredFields: [], restoredTargetKey: null } as never,
      editor: { activeKey: null, sessions: {} } as never,
    });
    await flushPromises();
    expect((expectBody("debug-history-current-project").element as HTMLButtonElement).disabled).toBe(true);
    expect((expectBody("debug-history-current-api").element as HTMLButtonElement).disabled).toBe(true);
    await expectBody("debug-history-from").setValue("2026-10-14T10:30");
    await expectBody("debug-history-to").setValue("2026-10-14T09:00");
    await expectBody("debug-history-filter").trigger("click");
    expect(history.error).toContain("不能晚于");
    expect(history.refresh).not.toHaveBeenCalled();
  });

  it("filters Free sources, shows project and draft identity, and restores only into the matching project", async () => {
    const project: ProjectLocator = {
      workspaceId: "20000000-0000-4000-8000-000000000001",
      groupId: "20000000-0000-4000-8000-000000000002",
      projectId: "20000000-0000-4000-8000-000000000003",
    };
    const draftId = "20000000-0000-4000-8000-000000000004";
    const request = { protocol: "http", method: "GET", baseUrl: "https://example.test", path: "/free", pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, body: { kind: "none" } };
    const item = {
      historyId: "20000000-0000-4000-8000-000000000005", createdAt: new Date("2026-10-15T10:00:00.000Z").toISOString(),
      runId: "free-run", mode: "free", sourceKind: "free", projectId: project.projectId, draftId,
      result: "passed", method: "GET", total: 1, passed: 1, failed: 0, exchangeTotal: 1, searchText: "free /free",
    };
    const history = reactive({
      filter: { limit: 50, offset: 0 }, items: [item], diagnostics: [], error: null, loading: false, nextOffset: null,
      selected: { record: { formatVersion: 2, historyId: item.historyId, createdAt: item.createdAt, result: {
        mode: "free", identityAvailable: true, sourceProjectRevision: "project-rev",
        source: { sourceKind: "free", project, draftId },
        replay: { mode: "free", sourceKind: "free", project, draftId, request, requestTemplate: request, parameters: {}, fields: [], available: true, identityAvailable: true },
        exchanges: [{ order: 1, transportState: "complete", request, intent: { available: true, fields: [] } }],
      } } },
      preferences: { enabled: true, retentionDays: 30, maxRecords: 1000 },
      load: vi.fn(async () => {}), refresh: vi.fn(async () => {}), updatePreferences: vi.fn(async () => {}),
      loadMore: vi.fn(async () => {}), openRecord: vi.fn(async () => {}), deleteRecord: vi.fn(async () => {}),
    });
    const restoreFree = vi.fn(async () => ({ sourceChanged: false, sourceAvailable: true }));
    const replayFree = vi.fn(async () => {});
    const wrapper = mountWithI18n(DebugHistory, {
      open: true, api: {} as ApiccApi, history: history as never,
      debug: { restoredFields: [], restoredTargetKey: null, restoredPreview: null, freeRestoredPreview: null, restoredSourceAvailable: null } as never,
      editor: { activeKey: null, activeFreeSession: null, sessions: {} } as never,
      projectLocator: project, restoreFree, replayFree,
    });
    await flushPromises();

    expect(expectBody("debug-history-free-source").text()).toContain(project.projectId);
    expect(expectBody("debug-history-free-source").text()).toContain(draftId);
    chooseSelect(wrapper, "debug-history-source-filter", "free");
    await expectBody("debug-history-filter").trigger("click");
    expect(history.filter).toMatchObject({ sourceKind: "free", offset: 0 });
    await expectBody("debug-history-restore").trigger("click");
    await flushPromises();
    expect(restoreFree).toHaveBeenCalledExactlyOnceWith({ historyId: item.historyId, exchangeOrder: 1, project });
    await expectBody("debug-history-replay").trigger("click");
    await flushPromises();
    expect(replayFree).toHaveBeenCalledExactlyOnceWith({ historyId: item.historyId, exchangeOrder: 1, project, draftId });

    await wrapper.setProps({ projectLocator: { ...project, projectId: "other-project" } });
    expect((expectBody("debug-history-restore").element as HTMLButtonElement).disabled).toBe(true);
    expect((expectBody("debug-history-replay").element as HTMLButtonElement).disabled).toBe(true);
    expect(bodyFind("debug-history-switch-project")).not.toBeNull();
    expect(restoreFree).toHaveBeenCalledTimes(1);
    expect(replayFree).toHaveBeenCalledTimes(1);
  });

  it("keeps valid v1/v2 case replay enabled when captured request intent is unavailable or needs input", async () => {
    const locator = { ...stressStoreLocator };
    const caseIdentity = { ...locator, caseId: "00000000-0000-4000-8000-000000000026", scope: "project" };
    const template = {
      protocol: "http", method: "GET", baseUrl: "https://example.test", path: "/case", pathParams: [], query: [],
      headers: [], cookies: [], auth: { kind: "none" }, body: { kind: "none" },
    };
    const exchangeRequest = {
      url: "https://example.test/case", method: "GET", query: [], headers: [], cookies: [], body: { kind: "none" },
    };
    const capturedField = { path: "request.body.token", status: "missing", needsInput: true };
    const v1Id = "00000000-0000-4000-8000-000000000027";
    const v2Id = "00000000-0000-4000-8000-000000000028";
    const item = {
      historyId: v1Id, createdAt: new Date("2026-10-15T10:00:00.000Z").toISOString(), mode: "case", sourceKind: "asset",
      projectId: locator.projectId, apiId: locator.apiId, method: "GET", passed: 1, total: 1,
    };
    const v1Record = {
      formatVersion: 1, historyId: v1Id, createdAt: item.createdAt,
      result: {
        mode: "case", locator, identityAvailable: true,
        replay: { mode: "case", case: caseIdentity, requestTemplate: template, parameters: {}, fields: [], identityAvailable: true, available: false },
        exchanges: [{ order: 1, transportState: "complete", request: exchangeRequest, intent: { parameters: {}, fields: [], available: false } }],
      },
    };
    const v2Record = {
      formatVersion: 2, historyId: v2Id, createdAt: item.createdAt,
      result: {
        mode: "case", identityAvailable: true,
        source: { sourceKind: "asset", locator, sourceApiRevision: "api-revision" },
        replay: { mode: "case", sourceKind: "asset", case: caseIdentity, requestTemplate: template, parameters: {}, fields: [capturedField], identityAvailable: true, available: true },
        exchanges: [{ order: 1, transportState: "complete", request: exchangeRequest, intent: { parameters: {}, fields: [capturedField], available: false } }],
      },
    };
    const history = reactive({
      filter: { limit: 50, offset: 0 }, items: [item], diagnostics: [], error: null, loading: false, nextOffset: null,
      selected: { record: v1Record as never },
      preferences: { enabled: true, retentionDays: 30, maxRecords: 1000 },
      load: vi.fn(async () => {}), refresh: vi.fn(async () => {}), updatePreferences: vi.fn(async () => {}),
      loadMore: vi.fn(async () => {}), openRecord: vi.fn(async () => {}), deleteRecord: vi.fn(async () => {}),
    });
    const wrapper = mountWithI18n(DebugHistory, {
      open: true, api: {} as ApiccApi, history: history as never,
      debug: { restoredFields: [], restoredTargetKey: null, restoredPreview: null } as never,
      editor: { activeKey: null, activeFreeSession: null, sessions: {} } as never,
    });
    await flushPromises();

    expect((expectBody("debug-history-replay").element as HTMLButtonElement).disabled).toBe(false);
    history.selected = { record: v2Record as never };
    await flushPromises();
    expect((expectBody("debug-history-replay").element as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("EmptyState", () => {
  it("渲染传入文本", () => {
    const wrapper = mountWithI18n(EmptyState, { text: "打开工作区后在此浏览接口" });
    expect(wrapper.find('[data-testid="empty-state"]').text()).toBe("打开工作区后在此浏览接口");
  });
});

describe("ConfirmDialog", () => {
  it("带输入框时确认回传输入值", async () => {
    const wrapper = mountWithI18n(ConfirmDialog, { open: true, title: "新建接口", inputPlaceholder: "名称" });
    await flushPromises(); // a-modal 传送门渲染需要一帧
    await expectBody("dialog-input").setValue("abc");
    await expectBody("dialog-confirm").trigger("click");
    expect(wrapper.emitted("confirm")![0]).toEqual(["abc"]);
  });

  it("无输入框时确认回传 null，取消触发 cancel", async () => {
    const wrapper = mountWithI18n(ConfirmDialog, { open: true, title: "确认删除" });
    await flushPromises();
    await expectBody("dialog-confirm").trigger("click");
    expect(wrapper.emitted("confirm")![0]).toEqual([null]);
    await expectBody("dialog-cancel").trigger("click");
    expect(wrapper.emitted("cancel")).toBeTruthy();
  });

  it("open=false 不渲染", () => {
    const wrapper = mountWithI18n(ConfirmDialog, { open: false, title: "x" });
    expect(wrapper.find('[data-testid="confirm-dialog"]').exists()).toBe(false);
    // 传送门也不应产生任何对话框元素
    expect(bodyHas("dialog-confirm")).toBe(false);
    expect(bodyHas("dialog-input")).toBe(false);
  });
});

describe("HomeView（M9-C：本地目录 打开/新建 入口自 TopBar 迁至主页）", () => {
  it("打开本地目录：经 wsPickDirectory+wsOpen 后显示工作区名", async () => {
    const { wrapper, workspace } = await mountWith(HomeView, { openProject: () => {}, openOnlineWorkspace: () => {}, openOnlineProject: () => {} });
    await wrapper.find('[data-testid="home-open-dir"]').trigger("click");
    await flushPromises();
    expect(workspace.opened).toBe(true);
    expect(wrapper.text()).toContain("内存工作区");
  });

  it("新建本地目录先弹名称输入对话框，可取消", async () => {
    const { wrapper } = await mountWith(HomeView, { openProject: () => {}, openOnlineWorkspace: () => {}, openOnlineProject: () => {} });
    await wrapper.find('[data-testid="home-new-dir"]').trigger("click");
    await flushPromises();
    expect(bodyHas("dialog-input")).toBe(true);
    await expectBody("dialog-cancel").trigger("click");
    await flushPromises();
    // 取消后对话框整体卸载（模板 v-if，无离场动画时序）
    expect(bodyHas("dialog-input")).toBe(false);
  });

  it("打开本地目录失败时经 reportError 上报（宽审查 I1）", async () => {
    const errors: unknown[] = [];
    const { wrapper, api } = await mountWith(HomeView, { openProject: () => {}, openOnlineWorkspace: () => {}, openOnlineProject: () => {}, reportError: (e: unknown) => { errors.push(e); } });
    api.wsOpen = async () => { throw new Error("打不开"); };
    await wrapper.find('[data-testid="home-open-dir"]').trigger("click");
    await flushPromises();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("打不开");
  });

  // —— M3-B 任务 2：顶栏在线模式入口 ——
  it("在线入口：未登录显示「在线模式」，点击置 dialogOpen=true；已登录显示登录身份", async () => {
    const { wrapper, online } = await mountWith(TopBar, {});
    expect(wrapper.find('[data-testid="online-toggle"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="online-status"]').text()).toBe("在线模式");
    await wrapper.find('[data-testid="online-toggle"]').trigger("click");
    expect(online.dialogOpen).toBe(true);
    // 已登录态（经 store login）→ 按钮文案切登录身份（用户 + 档案名）
    online.addProfile("http://127.0.0.1:8080", "团队服务器");
    await online.login("alice", "password8");
    await flushPromises();
    expect(wrapper.find('[data-testid="online-status"]').text()).toContain("示例用户");
    expect(wrapper.find('[data-testid="online-status"]').text()).toContain("团队服务器");
  });
});

// —— M2-D3 任务 2：压测面板与报告展示（简报裁定 A/B/C/D） ——

/** StressReport 夹具：数值带小数，供「毫秒取整、禁 NaN」断言（1200.6 → 1201 ms）。 */
function makeReport(overrides: Partial<StressReport> = {}): StressReport {
  return {
    concurrency: 2,
    totalRequests: 4,
    ok: 3,
    failed: 1,
    durationMs: 1200.6,
    rps: 3.333,
    latency: { min: 5.4, avg: 10.5, max: 20.9, p50: 9.2, p90: 18.1, p95: 19.3, p99: 20.8 },
    statusDist: { "200": 3, "500": 1 },
    errorKinds: { HTTP_500: 1 },
    failures: { transport: 0, http: 1, script: 0, assertion: 0, config: 0, aborted: 0 },
    scriptLatency: { min: 0, avg: 0, max: 0, p50: 0, p90: 0, p95: 0, p99: 0 },
    iterationLatency: { min: 5.4, avg: 10.5, max: 20.9, p50: 9.2, p90: 18.1, p95: 19.3, p99: 20.8 },
    startedAt: 0,
    finishedAt: 1200,
    ...overrides,
  };
}

/**
 * StressPanel 装配辅助（裁定 B）：store 工厂一次性调用，实例经 props 注入（组件内零工厂调用）；
 * cases/envs 按「props 直接传列表」契约下发。种子：两用例（冒烟 + 第二用例）与环境 dev。
 */
async function mountStress(props: Record<string, unknown> = {}, storeDeps: { trustOrigin?: (locator: ProjectLocator, origin: string) => Promise<void> } = {}) {
  const root = `C:/apicc-stress-${randomUUID()}`;
  const api = createMemoryApi({ root });
  api.seedWorkspace();
  await api.wsOpen(root);
  const tree = await api.treeGet();
  if (tree.source !== "local" || tree.kind !== "root") throw new Error("Expected local stress fixture root");
  const group = tree.children.find((node): node is LocalGroupTreeNodeDTO => node.kind === "group"
    && node.children.some((child) => child.kind === "project"));
  const project = group?.children.find((node) => node.kind === "project");
  const collection = project?.children.find((node) => node.kind === "collection");
  const apiNode = collection?.children.find((node) => node.kind === "api");
  if (!group || !project || !collection || apiNode?.kind !== "api") throw new Error("Stress fixture missing API tree path");
  const projectLocator: ProjectLocator = { ...project.locator };
  const apiLocator: ApiLocator = { ...apiNode.locator, folderIds: [...apiNode.locator.folderIds] };
  await api.envCreate({ locator: projectLocator, name: "dev" });
  const detail = await api.apiGet(apiLocator);
  if (detail.api.cases[0]) detail.api.cases[0].name = "冒烟";
  detail.api.cases.push({ id: "c2", name: "第二用例", scope: "base", parameters: {}, preOperations: [], postOperations: [], assertions: [] });
  await api.apiSave(apiLocator, detail.api, detail.sourceApiRevision);
  const fresh = await api.apiGet(apiLocator);
  const stress = createStressStore({ api, getContext: () => ({ root, locator: apiLocator }), ...storeDeps });
  const errors: unknown[] = [];
  const { i18n } = createI18nInstance();
  const wrapper = mount(StressPanel, {
    props: {
      apiLocator,
      cases: fresh.api.cases,
      envs: fresh.envs,
      stress,
      reportError: (e: unknown) => { errors.push(e); },
      ...props,
    },
    global: { plugins: [i18n] },
  });
  await flushPromises();
  return { wrapper, api, apiLocator, projectLocator, stress, errors, cases: fresh.api.cases, envs: fresh.envs };
}

/** antd 组件定位（chooseSelect/selectValue 同款思路：按组件名 + data-testid，不经下拉展开）。
 * data-testid 命中根元素或后代皆可：antd InputNumber 把透传 attrs 落在内部 <input> 而非根 div。 */
function antdComponent(wrapper: VueWrapper, name: string, testid: string) {
  const found = wrapper
    .findAllComponents({ name })
    .find((c) => c.attributes("data-testid") === testid || c.find(`[data-testid="${testid}"]`).exists());
  if (!found) throw new Error(`${name} 未找到: ${testid}`);
  return found;
}

/** 读取 a-select 的 :options prop（选项列表断言，jsdom 不展开下拉）。 */
function selectOptions(wrapper: VueWrapper, testid: string): Array<{ label: string; value: string }> {
  return antdComponent(wrapper, "ASelect", testid).props("options") as Array<{ label: string; value: string }>;
}

/** a-input-number 经组件级 update:value 写值（v-model 通道，语义等效用户输入）。 */
function setNumber(wrapper: VueWrapper, testid: string, value: number): void {
  antdComponent(wrapper, "AInputNumber", testid).vm.$emit("update:value", value);
}

/** 模式单选切换：经 ARadioGroup 组件级 update:value（与 chooseSelect 同理，jsdom 不点真实 radio）。 */
function chooseMode(wrapper: VueWrapper, mode: "iterations" | "duration"): void {
  antdComponent(wrapper, "ARadioGroup", "stress-mode").vm.$emit("update:value", mode);
}

describe("stressStore", () => {
  it("工厂隔离：两实例 state（form/report）互不可见", () => {
    const apiA = createMemoryApi();
    apiA.seedWorkspace();
    const apiB = createMemoryApi();
    apiB.seedWorkspace();
    const noSelection = () => ({ root: "", locator: null });
    const a = createStressStore({ api: apiA, getContext: noSelection });
    const b = createStressStore({ api: apiB, getContext: noSelection });
    // form 默认值集中定义：并发 1、iterations 模式；改 A 不影响 B
    expect(a.form.concurrency).toBe(1);
    expect(a.form.mode).toBe("iterations");
    a.form.concurrency = 8;
    a.form.mode = "duration";
    a.form.caseId = "cx";
    expect(b.form.concurrency).toBe(1);
    expect(b.form.mode).toBe("iterations");
    expect(b.form.caseId).toBeNull();
    // report 状态同样不互通
    expect(a.report).toBeNull();
    expect(b.report).toBeNull();
    a.report = makeReport();
    expect(b.report).toBeNull();
  });

  it("运行中 clear（切接口）→ 旧 run 完成/拒绝均不上屏不外抛、running 复位（代际令牌防错挂）", async () => {
    const api = createMemoryApi();
    api.seedWorkspace();
    let resolveRun!: (v: StressRunOutput) => void;
    api.stressRun = legacyStressRun((): Promise<StressRunOutput> => new Promise((res) => { resolveRun = res; }));
    const stress = createStressStore({ api, getContext: () => ({ root: stressStoreRoot, locator: stressStoreLocator }) });
    stress.form.caseId = "c1";
    const first = stress.start(stressStoreLocator);
    await flushPromises();
    expect(stress.running).toBe(true);
    // 组合根切接口时机：clear()（代际 +1、展示清空，running 仍 true）
    stress.clear();
    // 旧 run 排空完成：结果属于旧会话，不得写回（新接口面板不受污染）
    resolveRun({ ok: true, report: makeReport(), file: "stress-a.json" });
    await first;
    await flushPromises();
    expect(stress.report).toBeNull();
    expect(stress.file).toBeNull();
    expect(stress.error).toBeNull();
    expect(stress.running).toBe(false);
    // 陈旧拒绝同样不污染：clear 后旧 run reject → error 不置位、不向组件层重抛
    let rejectRun!: (e: Error) => void;
    api.stressRun = legacyStressRun((): Promise<StressRunOutput> => new Promise((_res, rej) => { rejectRun = rej; }));
    const second = stress.start(stressStoreLocator);
    await flushPromises();
    stress.clear();
    rejectRun(new Error("旧会话错误"));
    await second;
    await flushPromises();
    expect(stress.error).toBeNull();
  });
});

describe("StressPanel", () => {
  it("挂载：用例/环境下拉列出用例与环境，模式单选可切换，并发默认 1", async () => {
    const { wrapper, stress, cases } = await mountStress();
    expect(selectOptions(wrapper, "stress-case-select").map((o) => o.label)).toEqual(["冒烟", "第二用例"]);
    expect(selectOptions(wrapper, "stress-env-select").map((o) => o.label)).toEqual(["无环境", "dev"]);
    // 并发默认 1；挂载即回填首个用例为默认选择
    expect(antdComponent(wrapper, "AInputNumber", "stress-concurrency").props("value")).toBe(1);
    expect(stress.form.caseId).toBe(cases[0]!.id);
    // 模式单选切换：iterations（默认）→ duration 后迭代数输入退场、秒数输入登场
    expect(wrapper.find('[data-testid="stress-iterations"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="stress-duration"]').exists()).toBe(false);
    chooseMode(wrapper, "duration");
    await flushPromises();
    expect(stress.form.mode).toBe("duration");
    expect(wrapper.find('[data-testid="stress-iterations"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="stress-duration"]').exists()).toBe(true);
    chooseMode(wrapper, "iterations");
    await flushPromises();
    expect(stress.form.mode).toBe("iterations");
  });

  it("点「开始」：stressRun 以表单值调用（载荷按 mode 组装），运行中开始禁用+停止可用，resolve 后报告与 file 行上屏", async () => {
    const sent: StressRunInput[] = [];
    let resolveFirst!: (v: StressRunOutput) => void;
    const { wrapper, api, apiLocator, cases } = await mountStress();
    api.stressRun = legacyStressRun((input: StressRunInput): Promise<StressRunOutput> => {
      sent.push(input);
      if (sent.length === 1) return new Promise<StressRunOutput>((res) => { resolveFirst = res; });
      return Promise.resolve({ ok: true, report: makeReport({ totalRequests: 2, ok: 2, failed: 0 }) });
    });
    // 初态：无活动运行，停止禁用
    expect(wrapper.find('[data-testid="stress-stop"]').attributes("disabled")).toBeDefined();
    chooseSelect(wrapper, "stress-case-select", "c2");
    chooseSelect(wrapper, "stress-env-select", "dev");
    setNumber(wrapper, "stress-concurrency", 3);
    await wrapper.find('[data-testid="stress-start"]').trigger("click");
    await flushPromises();
    // iterations 模式（默认 10 次）：载荷只带 maxIterations，durationMs 为 null
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ locator: apiLocator, caseId: "c2", envName: "dev", concurrency: 3, maxIterations: 10, durationMs: null });
    // 运行中：开始禁用 + 停止可用 + 运行提示可见，报告未出
    expect(wrapper.find('[data-testid="stress-start"]').attributes("disabled")).toBeDefined();
    expect(wrapper.find('[data-testid="stress-stop"]').attributes("disabled")).toBeUndefined();
    expect(wrapper.find('[data-testid="stress-running"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="stress-report"]').exists()).toBe(false);
    resolveFirst({ ok: true, report: makeReport(), file: `stress-${apiLocator.apiId}-1.json` });
    await flushPromises();
    // resolve 后：报告上屏（totalRequests=4）+ file 行显示 + 按钮态复位
    expect(wrapper.find('[data-testid="stress-report"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="stress-report"]').text()).toContain("4");
    expect(wrapper.find('[data-testid="stress-file"]').text()).toContain("stress-");
    expect(wrapper.find('[data-testid="stress-start"]').attributes("disabled")).toBeUndefined();
    expect(wrapper.find('[data-testid="stress-stop"]').attributes("disabled")).toBeDefined();
    // duration 模式再来一轮（3 秒 → 3000ms）：载荷只带 durationMs，maxIterations 为 null；
    // 该轮返回省略 file（落盘降级口径）→ file 行消失
    chooseMode(wrapper, "duration");
    await flushPromises();
    setNumber(wrapper, "stress-duration", 3);
    await wrapper.find('[data-testid="stress-start"]').trigger("click");
    await flushPromises();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({ locator: apiLocator, caseId: "c2", envName: "dev", concurrency: 3, maxIterations: null, durationMs: 3000 });
    expect(wrapper.find('[data-testid="stress-report"]').text()).toContain("2");
    expect(wrapper.find('[data-testid="stress-file"]').exists()).toBe(false);
  });

  it("start reject：reportError 收到消息、旧报告与 file 保留（debug 错误语义）、错误上屏且 running 复位", async () => {
    const reportA = makeReport();
    let call = 0;
    const { wrapper, api, stress, errors } = await mountStress();
    api.stressRun = legacyStressRun(async (): Promise<StressRunOutput> => {
      call += 1;
      if (call === 1) return { ok: true, report: reportA, file: "stress-a.json" };
      throw new Error("已有压测进行中");
    });
    await wrapper.find('[data-testid="stress-start"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="stress-report"]').exists()).toBe(true);
    // 第二轮 reject：错误经组件转报 reportError 通道
    await wrapper.find('[data-testid="stress-start"]').trigger("click");
    await flushPromises();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("已有压测进行中");
    // 旧报告保留 + 错误文案上屏 + running 复位（可再次发起）
    expect(stress.report).toEqual(reportA);
    expect(wrapper.find('[data-testid="stress-report"]').text()).toContain("4");
    expect(stress.error).toBe("已有压测进行中");
    expect(wrapper.find('[data-testid="stress-error"]').text()).toContain("已有压测进行中");
    expect(wrapper.find('[data-testid="stress-file"]').text()).toContain("stress-a.json");
    expect(stress.running).toBe(false);
    expect(wrapper.find('[data-testid="stress-start"]').attributes("disabled")).toBeUndefined();
  });

  it("点「停止」：stressStop 调用且返回的部分报告上屏", async () => {
    const partial = makeReport({ totalRequests: 2, ok: 2, failed: 0 });
    let resolveRun!: (v: StressRunOutput) => void;
    const { wrapper, api } = await mountStress();
    // 挂起制造活动窗口；abort 后在途 run 收尾（与主进程 StressRunner signal 语义一致，
    // store.start 的 finally 才能复位 running）
    api.stressRun = legacyStressRun((): Promise<StressRunOutput> => new Promise((res) => { resolveRun = res; }));
    api.stressStop = async (): Promise<StressRunOutput> => {
      resolveRun({ ok: true, report: partial, file: "stress-partial.json" });
      return { ok: true, report: partial, file: "stress-partial.json" };
    };
    await wrapper.find('[data-testid="stress-start"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="stress-stop"]').attributes("disabled")).toBeUndefined();
    await wrapper.find('[data-testid="stress-stop"]').trigger("click");
    await flushPromises();
    // 部分报告上屏（totalRequests=2）+ file 行显示 + 停止复位禁用
    expect(wrapper.find('[data-testid="stress-report"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="stress-report"]').text()).toContain("2");
    expect(wrapper.find('[data-testid="stress-file"]').text()).toContain("stress-partial.json");
    expect(wrapper.find('[data-testid="stress-stop"]').attributes("disabled")).toBeDefined();
  });

  // —— M2-D3 任务 3 裁定 C（任务 2 审查折入顺修）——
  it("数字输入清空产生 null：归一为表单默认值（并发 1 / 迭代 10 / 时长秒 10）（裁定 C①）", async () => {
    const { wrapper, stress } = await mountStress();
    // 并发清空 → 归一 1（后续 start 载荷不再携带 null 并发）
    setNumber(wrapper, "stress-concurrency", 8);
    await flushPromises();
    expect(stress.form.concurrency).toBe(8);
    setNumber(wrapper, "stress-concurrency", null as unknown as number);
    await flushPromises();
    expect(stress.form.concurrency).toBe(1);
    // 迭代清空 → 归一 10
    setNumber(wrapper, "stress-iterations", null as unknown as number);
    await flushPromises();
    expect(stress.form.iterations).toBe(10);
    // 时长清空 → 归一 10
    chooseMode(wrapper, "duration");
    await flushPromises();
    setNumber(wrapper, "stress-duration", null as unknown as number);
    await flushPromises();
    expect(stress.form.durationSeconds).toBe(10);
  });

  it("cases 为空：「无用例」空态提示，开始禁用（裁定 C②）", async () => {
    const { wrapper, stress } = await mountStress({ cases: [], envs: [] });
    expect(wrapper.find('[data-testid="stress-no-cases"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="stress-no-cases"]').text()).toBe("无用例");
    expect(stress.form.caseId).toBeNull();
    expect(wrapper.find('[data-testid="stress-start"]').attributes("disabled")).toBeDefined();
  });

  it("实际点击仅本次确认与信任项目：显示风险文案并走精确 origin", async () => {
    let confirmOnlyTrustCalls = 0;
    const { wrapper, api, stress } = await mountStress({}, { trustOrigin: async () => { confirmOnlyTrustCalls += 1; } });
    const outputs = [
      { ok: false as const, error: { code: "target_confirmation_required" as const, message: "confirm", targetOrigin: "https://example.com" } },
      { ok: true as const, report: makeReport() },
    ];
    const calls: StressRunInput[] = [];
    api.stressRun = legacyStressRun(async (input) => { calls.push(input); return outputs.shift()!; });
    await wrapper.find('[data-testid="stress-start"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="stress-target-confirmation"]').text()).toContain("https://example.com");
    expect(wrapper.find('[data-testid="stress-target-confirmation"]').text()).toContain("压测授权");
    await wrapper.find('[data-testid="stress-confirm-once"]').trigger("click");
    await flushPromises();
    expect(calls[1]?.confirmedTargetOrigins).toEqual(["https://example.com"]);
    expect(confirmOnlyTrustCalls).toBe(0);
    expect(stress.pendingTargetOrigin).toBeNull();

    let trustedProject: ProjectLocator | null = null;
    let trustedOrigin = "";
    let trustCalls = 0;
    const second = await mountStress({}, { trustOrigin: async (projectLocator, origin) => { trustCalls += 1; trustedProject = projectLocator; trustedOrigin = origin; } });
    const secondOutputs = [
      { ok: false as const, error: { code: "target_confirmation_required" as const, message: "confirm", targetOrigin: "https://example.com" } },
      { ok: true as const, report: makeReport() },
    ];
    second.api.stressRun = legacyStressRun(async () => secondOutputs.shift()!);
    await second.wrapper.find('[data-testid="stress-start"]').trigger("click");
    await flushPromises();
    await second.wrapper.find('[data-testid="stress-trust-project"]').trigger("click");
    await flushPromises();
    expect(trustedProject).toEqual(second.projectLocator);
    expect(trustedOrigin).toBe("https://example.com");
    expect(trustCalls).toBe(1);
    expect(second.stress.pendingTargetOrigin).toBeNull();
  });
});

describe("StressReportView", () => {
  it("纯展示：摘要/分位/状态分布/错误分布区块可断言，毫秒取整禁 NaN；空报告显无样本；null 整块不渲染", () => {
    // 完整报告：摘要（total/ok/failed/rps/时长）+ 分位表 + 两分布表
    const full = makeReport();
    const w1 = mountWithI18n(StressReportView, { report: full });
    const summary = w1.find('[data-testid="stress-summary"]');
    expect(summary.exists()).toBe(true);
    expect(summary.text()).toContain("4");
    expect(summary.text()).toContain("1201"); // durationMs 1200.6 → 1201 ms（取整）
    expect(summary.text()).toContain("3.33"); // rps 保留两位
    const latency = w1.find('[data-testid="stress-latency"]');
    expect(latency.exists()).toBe(true);
    expect(latency.text()).toContain("11 ms"); // avg 10.5 → 11 ms
    for (const key of ["min", "avg", "p50", "p90", "p95", "p99"]) {
      expect(latency.text()).toContain(key);
    }
    expect(w1.find('[data-testid="stress-status-dist"]').text()).toContain("500");
    expect(w1.find('[data-testid="stress-error-kinds"]').text()).toContain("HTTP_500");
    expect(w1.text()).not.toContain("NaN");
    // 空报告（totalRequests=0）：「无样本」态，不渲染摘要/分位，无 NaN
    const empty = makeReport({
      totalRequests: 0, ok: 0, failed: 0, rps: 0,
      latency: { min: 0, avg: 0, max: 0, p50: 0, p90: 0, p95: 0, p99: 0 },
      statusDist: {}, errorKinds: {},
    });
    const w2 = mountWithI18n(StressReportView, { report: empty });
    expect(w2.find('[data-testid="stress-no-samples"]').text()).toBe("无样本");
    expect(w2.find('[data-testid="stress-summary"]').exists()).toBe(false);
    expect(w2.find('[data-testid="stress-latency"]').exists()).toBe(false);
    expect(w2.text()).not.toContain("NaN");
    // aborted/incomplete samples must use eligible completed attempts, not
    // samples.length, for the no-data display.
    const allAborted = makeReport({ totalRequests: 2, ok: 0, failed: 2, eligibleCompletedAttempts: 0, verdict: { passed: false, violations: [{ metric: "noData", actual: 0, expected: 1, message: "NO_DATA" }] } });
    const wAborted = mountWithI18n(StressReportView, { report: allAborted });
    expect(wAborted.find('[data-testid="stress-no-samples"]').exists()).toBe(true);
    expect(wAborted.find('[data-testid="stress-summary"]').exists()).toBe(false);
    // 报告为 null：整块不渲染
    const w3 = mountWithI18n(StressReportView, { report: null });
    expect(w3.find('[data-testid="stress-report"]').exists()).toBe(false);
  });

  it("显示 verdict、中文 violation、安全目标和 generator 饱和警告；旧报告不臆判", () => {
    const current = makeReport({
      verdict: { passed: false, violations: [{ metric: "p95", actual: 250, expected: 200, message: "p95 超过上限" }] },
      failures: { transport: 1, http: 0, script: 0, assertion: 2, config: 0, aborted: 0 },
      safety: { targetOrigins: [{ origin: "https://example.com", confirmation: "explicit", policy: "none" }] },
      generator: {
        cpuUserMs: 1, cpuSystemMs: 1, cpuPercent: 98, rssStartBytes: 10, rssPeakBytes: 20,
        eventLoopDelayP95Ms: 30, schedulerBacklogMax: 4, saturated: true,
        reasons: ["cpu"], limits: { cpuPercent: 90, eventLoopDelayP95Ms: 50, schedulerBacklog: 10 },
      },
    });
    const currentView = mountWithI18n(StressReportView, { report: current });
    expect(currentView.find('[data-testid="stress-verdict"]').text()).toBe("失败");
    expect(currentView.find('[data-testid="stress-violations"]').text()).toContain("P95");
    expect(currentView.find('[data-testid="stress-violations"]').text()).toContain("250");
    expect(currentView.find('[data-testid="stress-safety"]').text()).toContain("https://example.com");
    expect(currentView.find('[data-testid="stress-generator-saturated"]').exists()).toBe(true);
    expect(currentView.find('[data-testid="stress-generator"]').text()).toContain("98");

    const legacyView = mountWithI18n(StressReportView, { report: makeReport() });
    expect(legacyView.find('[data-testid="stress-verdict"]').text()).toBe("未评估");
    expect(legacyView.find('[data-testid="stress-generator"]').text()).toContain("未采集");
    expect(legacyView.find('[data-testid="stress-generator-saturated"]').exists()).toBe(false);
  });
});

// —— M2-D3 任务 3：运行历史 kind 区分（简报裁定 B + 任务 1 内联中文 i18n 收口）——

const collectionRow: RunSummaryDTO = {
  kind: "collection", file: "run-a.json", collectionName: "示例集合",
  startedAt: "2026-09-03T00:00:00.000Z", total: 3, passed: 2, failed: 1, skipped: 0,
};
const stressRow: StressRunSummaryDTO = {
  kind: "stress", file: "stress-x.json",
  startedAt: "2026-09-03T01:00:00.000Z", totalRequests: 8, ok: 6, failed: 2, rps: 12.5,
};

const collectionRunResult: RunResult = {
  collectionId: "c1", collectionName: "示例集合",
  startedAt: "2026-09-03T00:00:00.000Z", finishedAt: "2026-09-03T00:00:01.000Z",
  total: 3, passed: 2, failed: 1, cases: [],
};

/** RunsHistory 直挂（抽屉 a-drawer 传送门渲染于 document.body，行用 body 作用域查询）。 */
async function mountHistory(props: Record<string, unknown> = {}) {
  const api = createMemoryApi();
  api.seedWorkspace();
  const run = useRunStore(api);
  const { i18n, setLocale } = createI18nInstance();
  const wrapper = mount(RunsHistory, {
    props: { run, reportError: () => {}, ...props },
    global: { plugins: [i18n] },
  });
  await flushPromises();
  return { wrapper, api, run, setLocale };
}

function bodyRows(): Element[] {
  return Array.from(document.body.querySelectorAll('[data-testid="history-row"]'));
}

async function clickBody(testid: string): Promise<void> {
  const el = document.body.querySelector(`[data-testid="${testid}"]`);
  if (!el) throw new Error(`document.body 中找不到 [data-testid="${testid}"]`);
  await new DOMWrapper(el).trigger("click");
}

describe("RunsHistory kind 区分（M2-D3 任务 3，裁定 B）", () => {
  it("混合 kind：集合行渲染既有列 + 集合标签；压测行 totalRequests/failed/rps 摘要 + 压测标签（i18n 收口）", async () => {
    const { api, run } = await mountHistory();
    // 打开抽屉自动 loadHistory：经 runsList 替身注入混合 kind 行（同真实链路）
    api.runsList = async () => [stressRow, collectionRow];
    run.historyOpen = true;
    await flushPromises();
    const rows = bodyRows();
    expect(rows).toHaveLength(2);
    const [stressEl, collectionEl] = rows;
    // 压测行：标签「压测」+ 摘要（totalRequests/failed/rps）——文案全部来自 i18n 键
    expect(stressEl!.getAttribute("data-kind")).toBe("stress");
    expect(stressEl!.querySelector('[data-testid="history-kind"]')!.textContent).toBe("压测");
    expect(stressEl!.textContent).toContain("共 8 请求");
    expect(stressEl!.textContent).toContain("失败 2");
    expect(stressEl!.textContent).toContain("12.5 req/s");
    // 集合行：既有列（集合名/时间/汇总）+ 标签「集合」
    expect(collectionEl!.getAttribute("data-kind")).toBe("collection");
    expect(collectionEl!.querySelector('[data-testid="history-kind"]')!.textContent).toBe("集合");
    expect(collectionEl!.textContent).toContain("示例集合");
    expect(collectionEl!.textContent).toContain("共 3 条 · 通过 2 · 失败 1 · 跳过 0");
  });

  it("英文集合历史摘要仍包含 skipped，旧字段缺失回退 0", async () => {
    const { api, run, setLocale } = await mountHistory();
    setLocale("en");
    api.runsList = async () => [{ ...collectionRow, skipped: undefined }];
    run.historyOpen = true;
    await flushPromises();
    expect(bodyRows()[0]!.textContent).toContain("3 total · 2 passed · 1 failed · 0 skipped");
    setLocale("zh-CN");
  });

  it("点击压测行：runsGet 联合分支 → 内嵌 StressReportView 展示、返回复位；点击集合行仍回填结果并收起抽屉", async () => {
    const { api, run } = await mountHistory();
    const gotten: string[] = [];
    api.runsList = async () => [stressRow, collectionRow];
    api.runsGet = async (file: string) => {
      gotten.push(file);
      return file === "stress-x.json" ? { kind: "stress", report: makeReport() } : collectionRunResult;
    };
    run.historyOpen = true;
    await flushPromises();
    // 点击压测行（rows[0]）：抽屉保持打开，内嵌切到压测报告
    await new DOMWrapper(bodyRows()[0]!).trigger("click");
    await flushPromises();
    expect(gotten).toContain("stress-x.json");
    expect(run.historyOpen).toBe(true);
    const report = bodyFind("stress-report");
    expect(report).not.toBeNull();
    expect(report!.text()).toContain("4");
    expect(report!.text()).not.toContain("NaN");
    // 返回列表：报告卸载、store 报告复位、行列表恢复
    await clickBody("history-back");
    await flushPromises();
    expect(bodyFind("stress-report")).toBeNull();
    expect(run.stressReport).toBeNull();
    expect(bodyRows()).toHaveLength(2);
    // 点击集合行：既有行为回归——回填 RunView 结果并收起抽屉
    const collectionEl = bodyRows().find((r) => r.getAttribute("data-kind") === "collection")!;
    await new DOMWrapper(collectionEl).trigger("click");
    await flushPromises();
    expect(run.historyOpen).toBe(false);
    expect(run.result?.collectionName).toBe("示例集合");
  });

  it("runsGet 未命中（null）：保持列表视图并经 reportError 提示，不切出空白报告区（终审 Minor）", async () => {
    const errors: unknown[] = [];
    const { api, run } = await mountHistory({ reportError: (e: unknown) => { errors.push(e); } });
    api.runsList = async () => [stressRow];
    api.runsGet = async () => null;
    run.historyOpen = true;
    await flushPromises();
    await new DOMWrapper(bodyRows()[0]!).trigger("click");
    await flushPromises();
    // 保持列表视图：不出现空报告区、抽屉不收起、行仍在
    expect(bodyFind("stress-report")).toBeNull();
    expect(bodyRows()).toHaveLength(1);
    expect(run.historyOpen).toBe(true);
    expect(run.stressReport).toBeNull();
    // 经组合根错误通道提示
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("该运行文件不存在");
  });
});

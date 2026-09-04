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
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { mount, flushPromises, enableAutoUnmount, DOMWrapper, type VueWrapper } from "@vue/test-utils";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useTreeStore } from "../../../src/renderer/src/stores/tree.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";
import { useDebugStore } from "../../../src/renderer/src/stores/debug.js";
import { useWorkflowDesignStore } from "../../../src/renderer/src/stores/workflowDesign.js";
import { createStressStore } from "../../../src/renderer/src/stores/stress.js";
import { useRunStore } from "../../../src/renderer/src/stores/run.js";
import SideTree from "../../../src/renderer/src/components/SideTree.vue";
import RequestEditor from "../../../src/renderer/src/components/RequestEditor.vue";
import ResponseViewer from "../../../src/renderer/src/components/ResponseViewer.vue";
import EmptyState from "../../../src/renderer/src/components/EmptyState.vue";
import ConfirmDialog from "../../../src/renderer/src/components/ConfirmDialog.vue";
import TopBar from "../../../src/renderer/src/components/TopBar.vue";
import RunsHistory from "../../../src/renderer/src/components/RunsHistory.vue";
import StressPanel from "../../../src/renderer/src/components/StressPanel.vue";
import StressReportView from "../../../src/renderer/src/components/StressReportView.vue";
import type { RunResult, StressReport } from "@apicc/core";
import type { RunSummaryDTO, StressRunInput, StressRunOutput, StressRunSummaryDTO } from "../../../src/shared/types.js";

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
 * 使该接口的 wf:impact({ apiId }) 恰好命中一条（工作流名/状态/节点 label 可断言）。
 */
async function seedWorkflowReferencingApi(
  api: ReturnType<typeof createMemoryApi>,
  projectId: string,
  apiId: string,
): Promise<void> {
  const detail = await api.apiGet(apiId);
  const caseId = detail.api.cases[0]!.id;
  const wf = await api.wfCreate({ projectId, name: "下单主流程" });
  await api.wfSave({
    ...wf,
    nodes: [{ id: "n1", kind: "request", label: "创建订单", apiId, caseId }],
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
  const editor = useEditorStore(api);
  const debug = useDebugStore(api);
  // SideTree 需要设计器会话（审查 I2 重命名卸载）：同一份一次性装配经 props 注入
  const workflowDesign = useWorkflowDesignStore(api);
  const { i18n } = createI18nInstance();
  const wrapper = mount(component, {
    props: { api, workspace, tree, editor, debug, workflowDesign, reportError: () => {}, ...props },
    global: { plugins: [i18n] },
  });
  await flushPromises();
  return { wrapper, api, workspace, tree, editor, debug, workflowDesign };
}

/** 仅需 i18n 插件的挂载（组件只收普通 props，不消费 store）。 */
function mountWithI18n(component: Parameters<typeof mount>[0], props: Record<string, unknown> = {}): VueWrapper {
  const { i18n } = createI18nInstance();
  return mount(component, { props, global: { plugins: [i18n] } });
}

/**
 * M2-B 收口夹具：在种子项目下创建一条工作流并刷新侧树（侧树工作流入口的数据前置）。
 * 返回项目/接口/用例 id 供状态迁移与断言复用。
 */
async function seedTreeWorkflow(
  api: ReturnType<typeof createMemoryApi>,
  workspace: ReturnType<typeof useWorkspaceStore>,
  name: string,
): Promise<{ workflowId: string; projectId: string; apiId: string; caseId: string }> {
  const project = workspace.tree!.children![0]!.children![0]!;
  const apiNode = project.children![0]!.children![0]!;
  const detail = await api.apiGet(apiNode.id);
  const wf = await api.wfCreate({ projectId: project.id, name });
  await workspace.refresh();
  return { workflowId: wf.id, projectId: project.id, apiId: apiNode.id, caseId: detail.api.cases[0]!.id };
}

describe("SideTree", () => {
  it("渲染工作区树并支持选中接口", async () => {
    const { wrapper } = await mountWith(SideTree);
    // 分组/项目/集合默认折叠：接口初始不可见
    expect(wrapper.find('[data-testid="tree-api"]').exists()).toBe(false);
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    const apiNode = wrapper.find('[data-testid="tree-api"]');
    expect(apiNode.exists()).toBe(true);
    await apiNode.trigger("click");
    expect(wrapper.emitted("select")).toBeTruthy();
  });

  it("新建接口：集合动作钮经对话框输入后创建并选中", async () => {
    const { wrapper } = await mountWith(SideTree);
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    await wrapper.find('[data-testid="new-api"]').trigger("click");
    // 创建走 ConfirmDialog 复用的输入对话框（a-modal 渲染于 body）
    const input = expectBody("dialog-input");
    await input.setValue("新接口");
    await expectBody("dialog-confirm").trigger("click");
    await flushPromises();
    // select 事件必须携带 "api"（App 据此加载编辑器）：nodeCreate 返回统一瘦 DTO 含 kind
    // （宽审查 I2），SideTree 以返回值的 kind 发事件，不再以发起请求的 kind 为准
    expect(wrapper.emitted("select")![0]).toEqual(["api", expect.any(String)]);
    expect(wrapper.text()).toContain("新接口");
  });

  it("对话框 run 拒绝时经 reportError 上报（宽审查 I1，不再静默吞没）", async () => {
    const errors: unknown[] = [];
    const { wrapper, api } = await mountWith(SideTree, { reportError: (e: unknown) => { errors.push(e); } });
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    await wrapper.find('[data-testid="new-api"]').trigger("click");
    await expectBody("dialog-input").setValue("x");
    api.nodeCreate = async () => { throw new Error("boom"); };
    await expectBody("dialog-confirm").trigger("click");
    await flushPromises();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
  });

  it("删除接口：确认对话框放行后节点消失", async () => {
    const { wrapper, workspace } = await mountWith(SideTree);
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    // 以接口所在行（tree-api-row）为作用域，避免命中祖先节点的删除钮
    const row = wrapper.find('[data-testid="tree-api-row"]');
    const apiId = row.find('[data-testid="tree-api"]').attributes("data-node-id") as string;
    await row.find('[data-testid="node-delete"]').trigger("click");
    await expectBody("dialog-confirm").trigger("click");
    await flushPromises();
    expect(JSON.stringify(workspace.tree)).not.toContain(apiId);
  });

  it("删除被引用接口：先弹影响清单（工作流名（状态）—节点 label），确认后删除执行", async () => {
    const { wrapper, api, workspace } = await mountWith(SideTree);
    const group = workspace.tree!.children![0]!;
    const project = group.children![0]!;
    const apiNode = project.children![0]!.children![0]!;
    await seedWorkflowReferencingApi(api, project.id, apiNode.id);
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
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
    await expectBody("dialog-confirm").trigger("click");
    await flushPromises();
    expect(JSON.stringify(workspace.tree)).not.toContain(apiNode.id);
  });

  it("删除未被引用接口：无影响清单（无额外弹窗），确认后直接删除", async () => {
    const { wrapper, workspace } = await mountWith(SideTree);
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    const row = wrapper.find('[data-testid="tree-api-row"]');
    const apiId = row.find('[data-testid="tree-api"]').attributes("data-node-id") as string;
    await row.find('[data-testid="node-delete"]').trigger("click");
    await flushPromises();
    // 未命中：常规确认对话框放行即删，不得出现影响清单
    expect(bodyHas("impact-list")).toBe(false);
    await expectBody("dialog-confirm").trigger("click");
    await flushPromises();
    expect(JSON.stringify(workspace.tree)).not.toContain(apiId);
  });

  it("删除被引用接口：取消影响清单对话框则不删除", async () => {
    const { wrapper, api, workspace } = await mountWith(SideTree);
    const group = workspace.tree!.children![0]!;
    const project = group.children![0]!;
    const apiNode = project.children![0]!.children![0]!;
    await seedWorkflowReferencingApi(api, project.id, apiNode.id);
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
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
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
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
    const { wrapper, workspace } = await mountWith(SideTree);
    const before = workspace.tree!.children!.length;
    await wrapper.find('[data-testid="new-group"]').trigger("click");
    await expectBody("dialog-input").setValue("根层新分组");
    await expectBody("dialog-confirm").trigger("click");
    await flushPromises();
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
    const pub = await api.wfCreate({ projectId: seeded.projectId, name: "已发布流" });
    await api.wfSetStatus(pub.id, "published");
    // enabled 须过启用校验：绑定种子接口的真实用例（空流禁止启用）
    const en = await api.wfCreate({ projectId: seeded.projectId, name: "已启用流" });
    await api.wfSave({ ...en, nodes: [{ id: "n1", kind: "request", apiId: seeded.apiId, caseId: seeded.caseId }], edges: [] });
    await api.wfSetStatus(en.id, "published");
    await api.wfSetStatus(en.id, "enabled");
    await workspace.refresh();
    await flushPromises();
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    const nodes = wrapper.findAll('[data-testid="tree-workflow"]');
    expect(nodes.map((n) => n.text())).toEqual(["草稿流", "已发布流", "已启用流"]);
    // 状态徽标色点契约：data-status + 色点 class（draft 灰/published 蓝/enabled 绿）
    expect(nodes[0]!.attributes("data-status")).toBe("draft");
    expect(nodes[1]!.attributes("data-status")).toBe("published");
    expect(nodes[2]!.attributes("data-status")).toBe("enabled");
    expect(nodes[0]!.find(".wf-dot").classes()).toContain("wf-dot-draft");
    expect(nodes[1]!.find(".wf-dot").classes()).toContain("wf-dot-published");
    expect(nodes[2]!.find(".wf-dot").classes()).toContain("wf-dot-enabled");
    // 工作流节点渲染在 project children 尾部（接口行之后）
    const apiEl = wrapper.find('[data-testid="tree-api-row"]').element;
    const wfEl = wrapper.find('[data-testid="tree-workflow-row"]').element;
    expect(apiEl.compareDocumentPosition(wfEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("点击工作流节点 emit select(\"workflow\", id)", async () => {
    const { wrapper, api, workspace } = await mountWith(SideTree);
    const seeded = await seedTreeWorkflow(api, workspace, "点击流");
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    await wrapper.find('[data-testid="tree-workflow"]').trigger("click");
    // App 据此 kind 加载工作流设计器（onSelect → workflowDesign.load + 视图切 wf）
    expect(wrapper.emitted("select")![0]).toEqual(["workflow", seeded.workflowId]);
  });

  it("工作流重命名：对话框输入后经 wfRename 改名并刷新树", async () => {
    const { wrapper, api, workspace } = await mountWith(SideTree);
    const seeded = await seedTreeWorkflow(api, workspace, "旧名流");
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    const row = wrapper.find('[data-testid="tree-workflow-row"]');
    await row.find('[data-testid="node-rename"]').trigger("click");
    // 重命名复用 ConfirmDialog 输入先例（a-modal 传送门渲染于 body）
    await expectBody("dialog-input").setValue("新名流");
    await expectBody("dialog-confirm").trigger("click");
    await flushPromises();
    expect((await api.wfList(seeded.projectId)).map((w) => w.name)).toEqual(["新名流"]);
    expect(wrapper.find('[data-testid="tree-workflow"]').text()).toContain("新名流");
  });

  it("工作流删除：确认对话框放行后经 wfDelete 删除并从树移除", async () => {
    const { wrapper, api, workspace } = await mountWith(SideTree);
    const seeded = await seedTreeWorkflow(api, workspace, "待删流");
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    const row = wrapper.find('[data-testid="tree-workflow-row"]');
    await row.find('[data-testid="node-delete"]').trigger("click");
    await flushPromises();
    // 删除确认文案复用 wf.deleteConfirm（含工作流名），确认前不删
    expect(document.body.textContent).toContain("待删流");
    expect((await api.wfList(seeded.projectId)).map((w) => w.name)).toEqual(["待删流"]);
    await expectBody("dialog-confirm").trigger("click");
    await flushPromises();
    expect(await api.wfList(seeded.projectId)).toEqual([]);
    expect(wrapper.find('[data-testid="tree-workflow"]').exists()).toBe(false);
  });
});

describe("RequestEditor", () => {
  it("编辑 URL 触发 update 且显示发送按钮", async () => {
    const { wrapper, editor, workspace } = await mountWith(RequestEditor);
    // 未加载接口时是空态，无编辑输入
    expect(wrapper.find('[data-testid="editor-url"]').exists()).toBe(false);
    const apiNode = workspace.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
    await editor.load(apiNode.id);
    await flushPromises();
    const url = wrapper.find('[data-testid="editor-url"]');
    await url.setValue("http://example.com/x");
    expect((url.element as HTMLInputElement).value).toBe("http://example.com/x");
    // v-model 直接写 editor.api 字段（Pinia 响应式），dirty 快照比对 getter 跟踪
    expect(editor.api!.url).toBe("http://example.com/x");
    expect(editor.dirty).toBe(true);
    expect(wrapper.find('[data-testid="send-btn"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="save-btn"]').exists()).toBe(true);
  });

  it("点击发送走默认 apicc.debugSend 并产生结果", async () => {
    const { wrapper, editor, debug, workspace } = await mountWith(RequestEditor);
    const apiNode = workspace.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
    await editor.load(apiNode.id);
    await wrapper.find('[data-testid="send-btn"]').trigger("click");
    await flushPromises();
    expect(debug.result).not.toBeNull();
    expect(debug.sending).toBe(false);
    expect(debug.error).toBeNull();
  });

  it("认证 tab：选择类型生成对应 auth 字段", async () => {
    const { wrapper, editor, workspace } = await mountWith(RequestEditor);
    const apiNode = workspace.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
    await editor.load(apiNode.id);
    // a-tabs 页签钩子为 #tab slot 内的 span，点击冒泡到 a-tabs 完成切换
    await wrapper.find('[data-testid="tab-auth"]').trigger("click");
    chooseSelect(wrapper, "auth-type", "bearer");
    await flushPromises();
    expect(editor.api!.auth).toMatchObject({ type: "bearer" });
    await wrapper.find('[data-testid="auth-token"]').setValue("t0");
    expect(editor.api!.auth!.token).toBe("t0");
  });

  it("请求体 tab：选择 form 类型后可添加行", async () => {
    const { wrapper, editor, workspace } = await mountWith(RequestEditor);
    const apiNode = workspace.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
    await editor.load(apiNode.id);
    await wrapper.find('[data-testid="tab-body"]').trigger("click");
    chooseSelect(wrapper, "body-kind", "form");
    await flushPromises();
    expect(editor.api!.body).toMatchObject({ kind: "form" });
    await wrapper.find('[data-testid="add-form-row"]').trigger("click");
    expect(editor.api!.body!.form).toHaveLength(1);
  });

  it("调试选择器：选环境/用例后发送按选择传参（envName/caseId 走 store 状态）", async () => {
    const { wrapper, api, editor, debug, workspace } = await mountWith(RequestEditor);
    const apiNode = workspace.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
    await editor.load(apiNode.id);
    // 种子项目无环境且仅一个用例（id 为 randomUUID）：注入 dev 环境并追加第二用例供选择
    editor.envs.push({ id: "e1", name: "dev" });
    editor.api!.cases.push({ id: "t2", name: "second", scope: "base", parameters: {}, assertions: [] });
    // memory 替身未记录 debugSend 调用，按简报以 spy 覆写捕获入参（发送按钮不传显式 envName）
    const sent: Array<{ apiId: string; caseId: string; envName?: string }> = [];
    api.debugSend = async (input) => {
      sent.push(input);
      return {
        run: { total: 1, passed: 1, failed: 0, cases: [], startedAt: "", finishedAt: "", collectionId: "c", collectionName: "c" },
        outcome: { apiId: "a", apiName: "a", caseId: "t2", caseName: "second", passed: true, durationMs: 1, assertions: [] },
      };
    };
    chooseSelect(wrapper, "debug-env-select", "dev");
    chooseSelect(wrapper, "debug-case-select", "t2");
    await wrapper.find('[data-testid="send-btn"]').trigger("click");
    await flushPromises();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ caseId: "t2", envName: "dev" });
    expect(debug.result).not.toBeNull();
    expect(debug.error).toBeNull();
    expect(debug.sending).toBe(false);
  });

  it("悬空用例选择显示回退：切接口后失效 id 不再显示，回退 cases[0]（显示与 send 一致）", async () => {
    const { wrapper, editor, debug, workspace } = await mountWith(RequestEditor);
    const apiNode = workspace.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
    await editor.load(apiNode.id);
    editor.api!.cases.push({ id: "t2", name: "second", scope: "base", parameters: {}, assertions: [] });
    chooseSelect(wrapper, "debug-case-select", "t2");
    expect(debug.selectedCaseId).toBe("t2");
    // 模拟切接口：cases 整体换成不含 t2 的集合（store 选择状态不清除，仍指向失效 id）
    editor.api!.cases = [{ id: "t9", name: "other", scope: "base", parameters: {}, assertions: [] }];
    await flushPromises();
    // send 侧已静默回退 cases[0].id（stores/debug.ts），显示侧须同步回退而非渲染失效 id
    expect(selectValue(wrapper, "debug-case-select")).toBe("t9");
  });

  it("悬空环境选择显示回退：删环境后失效名不再显示，回退「无环境」（显示与 send 一致）", async () => {
    const { wrapper, editor, workspace } = await mountWith(RequestEditor);
    const apiNode = workspace.tree!.children![0]!.children![0]!.children![0]!.children![0]!;
    await editor.load(apiNode.id);
    editor.envs.push({ id: "e1", name: "dev" });
    chooseSelect(wrapper, "debug-env-select", "dev");
    await flushPromises();
    expect(selectValue(wrapper, "debug-env-select")).toBe("dev");
    editor.envs.splice(0, editor.envs.length); // 删除所选环境（send 回退 undefined → 无环境）
    await flushPromises();
    expect(selectValue(wrapper, "debug-env-select")).toBe("");
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

  it("有结果时显示状态徽标与断言明细", async () => {
    const wrapper = mountWithI18n(ResponseViewer, {});
    await wrapper.setProps({ result });
    expect(wrapper.find('[data-testid="response-empty"]').exists()).toBe(false);
    expect(wrapper.text()).toContain("eq 失败");
    // 头部展示结果归属用例名（outcome.caseName 字段已有，此前未上 UI）
    expect(wrapper.text()).toContain("用例甲");
    expect(wrapper.find('[data-testid="response-outcome"]').exists()).toBe(true);
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

describe("TopBar", () => {
  it("打开工作区：经 wsPickDirectory+wsOpen 后显示工作区名", async () => {
    const { wrapper, workspace } = await mountWith(TopBar, {});
    await wrapper.find('[data-testid="open-workspace"]').trigger("click");
    await flushPromises();
    expect(workspace.opened).toBe(true);
    expect(wrapper.find('[data-testid="workspace-name"]').text()).toContain("内存工作区");
  });

  it("新建工作区先弹名称输入对话框，可取消", async () => {
    const { wrapper } = await mountWith(TopBar, {});
    await wrapper.find('[data-testid="new-workspace"]').trigger("click");
    await flushPromises();
    expect(bodyHas("dialog-input")).toBe(true);
    await expectBody("dialog-cancel").trigger("click");
    await flushPromises();
    // 取消后对话框整体卸载（模板 v-if，无离场动画时序）
    expect(bodyHas("dialog-input")).toBe(false);
  });

  it("打开工作区失败时经 reportError 上报（宽审查 I1）", async () => {
    const errors: unknown[] = [];
    const { wrapper, api } = await mountWith(TopBar, { reportError: (e: unknown) => { errors.push(e); } });
    api.wsOpen = async () => { throw new Error("打不开"); };
    await wrapper.find('[data-testid="open-workspace"]').trigger("click");
    await flushPromises();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("打不开");
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
    startedAt: 0,
    finishedAt: 1200,
    ...overrides,
  };
}

/**
 * StressPanel 装配辅助（裁定 B）：store 工厂一次性调用，实例经 props 注入（组件内零工厂调用）；
 * cases/envs 按「props 直接传列表」契约下发。种子：两用例（冒烟 + 第二用例）与环境 dev。
 */
async function mountStress(props: Record<string, unknown> = {}) {
  const api = createMemoryApi();
  api.seedWorkspace();
  const tree = await api.treeGet();
  const project = tree.children![0]!.children![0]!;
  const apiId = project.children![0]!.children![0]!.id;
  await api.envCreate({ projectId: project.id, name: "dev" });
  const detail = await api.apiGet(apiId);
  detail.api.cases.push({ id: "c2", name: "第二用例", scope: "base", parameters: {}, assertions: [] });
  await api.apiSave(detail.api);
  const fresh = await api.apiGet(apiId);
  const stress = createStressStore({ api });
  const errors: unknown[] = [];
  const { i18n } = createI18nInstance();
  const wrapper = mount(StressPanel, {
    props: {
      apiId,
      cases: fresh.api.cases,
      envs: fresh.envs,
      stress,
      reportError: (e: unknown) => { errors.push(e); },
      ...props,
    },
    global: { plugins: [i18n] },
  });
  await flushPromises();
  return { wrapper, api, apiId, stress, errors, cases: fresh.api.cases, envs: fresh.envs };
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
    const a = createStressStore({ api: apiA });
    const b = createStressStore({ api: apiB });
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
    const { wrapper, api, apiId, cases } = await mountStress();
    api.stressRun = (input: StressRunInput): Promise<StressRunOutput> => {
      sent.push(input);
      if (sent.length === 1) return new Promise<StressRunOutput>((res) => { resolveFirst = res; });
      return Promise.resolve({ report: makeReport({ totalRequests: 2, ok: 2, failed: 0 }) });
    };
    // 初态：无活动运行，停止禁用
    expect(wrapper.find('[data-testid="stress-stop"]').attributes("disabled")).toBeDefined();
    chooseSelect(wrapper, "stress-case-select", "c2");
    chooseSelect(wrapper, "stress-env-select", "dev");
    setNumber(wrapper, "stress-concurrency", 3);
    await wrapper.find('[data-testid="stress-start"]').trigger("click");
    await flushPromises();
    // iterations 模式（默认 10 次）：载荷只带 maxIterations，durationMs 为 null
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ apiId, caseId: "c2", envName: "dev", concurrency: 3, maxIterations: 10, durationMs: null });
    // 运行中：开始禁用 + 停止可用 + 运行提示可见，报告未出
    expect(wrapper.find('[data-testid="stress-start"]').attributes("disabled")).toBeDefined();
    expect(wrapper.find('[data-testid="stress-stop"]').attributes("disabled")).toBeUndefined();
    expect(wrapper.find('[data-testid="stress-running"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="stress-report"]').exists()).toBe(false);
    resolveFirst({ report: makeReport(), file: `stress-${apiId}-1.json` });
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
    expect(sent[1]).toEqual({ apiId, caseId: "c2", envName: "dev", concurrency: 3, maxIterations: null, durationMs: 3000 });
    expect(wrapper.find('[data-testid="stress-report"]').text()).toContain("2");
    expect(wrapper.find('[data-testid="stress-file"]').exists()).toBe(false);
  });

  it("start reject：reportError 收到消息、旧报告与 file 保留（debug 错误语义）、错误上屏且 running 复位", async () => {
    const reportA = makeReport();
    let call = 0;
    const { wrapper, api, stress, errors } = await mountStress();
    api.stressRun = async (): Promise<StressRunOutput> => {
      call += 1;
      if (call === 1) return { report: reportA, file: "stress-a.json" };
      throw new Error("已有压测进行中");
    };
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
    api.stressRun = (): Promise<StressRunOutput> => new Promise((res) => { resolveRun = res; });
    api.stressStop = async (): Promise<StressRunOutput> => {
      resolveRun({ report: partial, file: "stress-partial.json" });
      return { report: partial, file: "stress-partial.json" };
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
    // 报告为 null：整块不渲染
    const w3 = mountWithI18n(StressReportView, { report: null });
    expect(w3.find('[data-testid="stress-report"]').exists()).toBe(false);
  });
});

// —— M2-D3 任务 3：运行历史 kind 区分（简报裁定 B + 任务 1 内联中文 i18n 收口）——

const collectionRow: RunSummaryDTO = {
  kind: "collection", file: "run-a.json", collectionName: "示例集合",
  startedAt: "2026-09-03T00:00:00.000Z", total: 3, passed: 2, failed: 1,
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
async function mountHistory() {
  const api = createMemoryApi();
  api.seedWorkspace();
  const run = useRunStore(api);
  const { i18n } = createI18nInstance();
  const wrapper = mount(RunsHistory, {
    props: { run, reportError: () => {} },
    global: { plugins: [i18n] },
  });
  await flushPromises();
  return { wrapper, api, run };
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
    expect(collectionEl!.textContent).toContain("共 3 条 · 通过 2 · 失败 1");
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
});

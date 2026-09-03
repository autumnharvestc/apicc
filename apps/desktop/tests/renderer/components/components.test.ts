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
import SideTree from "../../../src/renderer/src/components/SideTree.vue";
import RequestEditor from "../../../src/renderer/src/components/RequestEditor.vue";
import ResponseViewer from "../../../src/renderer/src/components/ResponseViewer.vue";
import EmptyState from "../../../src/renderer/src/components/EmptyState.vue";
import ConfirmDialog from "../../../src/renderer/src/components/ConfirmDialog.vue";
import TopBar from "../../../src/renderer/src/components/TopBar.vue";

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

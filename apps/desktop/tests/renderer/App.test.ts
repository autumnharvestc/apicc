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
import { describe, expect, it, beforeAll, afterEach } from "vitest";
import { mount, flushPromises, enableAutoUnmount, DOMWrapper } from "@vue/test-utils";
import { initI18n } from "../../src/renderer/src/i18n/bridge";
import { createMemoryApi } from "../../src/renderer/src/api/memory.js";
import WfDesigner from "../../src/renderer/src/components/WfDesigner.vue";
import RequestEditor from "../../src/renderer/src/components/RequestEditor.vue";
import StressPanel from "../../src/renderer/src/components/StressPanel.vue";
import type { WfBindIndex } from "../../src/renderer/src/wf/wfBindings.js";
import type { StressReport } from "@apicc/core";

const failingApi = createMemoryApi();
failingApi.seedWorkspace();
// 审查 I2 回归需要真实 nodeCreate（项目内新增接口后断言 bindIndex 重建）：
// 先留存原实现再换成恒拒绝替身，I2 用例内换回、结束时还原。
const realNodeCreate = failingApi.nodeCreate.bind(failingApi);
failingApi.nodeCreate = async () => { throw new Error("接口创建失败（测试注入）"); };
window.apicc = failingApi;

beforeAll(() => {
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

/** 语言下拉菜单项（a-dropdown 传送门渲染在 document.body，菜单项带 data-locale）。 */
function langOption(locale: string): DOMWrapper<Element> {
  const el = document.body.querySelector(`[data-locale="${locale}"]`);
  if (!el) throw new Error(`document.body 中找不到 [data-locale="${locale}"]（语言下拉未展开？）`);
  return new DOMWrapper(el);
}

/** 动态 import App：保证上方 window.apicc 注入先于 api/index.ts 的模块求值。 */
async function mountApp() {
  // M11 启动恢复会读持久化键——测试间清理保证互不影响
  for (const k of ["apicc.lastWorkspace", "apicc.lastApi", "apicc.tree.expanded", "apicc.moduleMemory"]) localStorage.removeItem(k);
  const { default: App } = await import("../../src/renderer/src/App.vue");
  const wrapper = mount(App, { global: { plugins: [initI18n().i18n] } });
  await flushPromises();
  return wrapper;
}

/** 打开本地目录（M11：主页入口 → topbar-home → Open Directory → 切接口模块）。 */
async function openLocalDir(wrapper: import("@vue/test-utils").VueWrapper) {
  await wrapper.find('[data-testid="topbar-home"]').trigger("click");
  await flushPromises();
  await wrapper.find('[data-testid="home-open-dir"]').trigger("click");
  await flushPromises();
  await wrapper.find('[data-testid="rail-api"]').trigger("click");
  await flushPromises();
}

describe("App 布局（M8 模块化：rail + 树面板 + 内容区）", () => {
  it("挂载缺省主页（无打开记录）；顶栏主页入口可见；rail 五项", async () => {
    const wrapper = await mountApp();
    expect(wrapper.find('[data-testid="app-root"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="topbar"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="topbar-home"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="mode-badge"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="home-view"]').exists()).toBe(true);
    // 主页无 API 栏（M11 澄清①）——v-show 隐藏（组件常驻保状态），可见性断言
    expect(wrapper.find('[data-testid="side-tree"]').isVisible()).toBe(false);
    // rail 五项（主页不在 rail——顶栏入口）
    const items = wrapper.findAll('[data-testid="module-rail"] button.rail-item').map((b) => b.attributes("data-testid"));
    expect(items).toEqual(["rail-api", "rail-run", "rail-wf", "rail-test", "rail-envs"]);
    // 未打开工作区：rail 模块禁用
    expect(wrapper.find('[data-testid="rail-api"]').attributes("disabled")).toBeDefined();
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
    // 调试子视图四段：接口头 / 上编辑器 / 可拖拽分割条 / 下响应
    expect(split.element.children.length).toBe(4);
    const ids = Array.from(split.element.children).map((el) => el.getAttribute("data-testid"));
    expect(ids).toEqual(["api-head", "editor-pane", "split-divider", "viewer-pane"]);
  });
});

describe("App 错误反馈通道（宽审查 I1）", () => {
  it("对话框 run 拒绝时 app-error 展示错误并可手动关闭", async () => {
    const wrapper = await mountApp();
    // 打开工作区：memory 替身 wsOpen 对非工作区目录回退内存态（已 seed）
    await openLocalDir(wrapper);
    await flushPromises();
    // 展开分组（一次点击递归展开后代容器）后点集合行的「新建接口」
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    await wrapper.find('[data-testid="new-api"]').trigger("click");
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
  it("未打开工作区时：工作区级模块与子视图禁用（顶栏主页入口恒在）", async () => {
    const wrapper = await mountApp();
    expect(wrapper.find('[data-testid="module-rail"]').exists()).toBe(true);
    // rail 原生 button：disabled 属性
    expect(wrapper.find('[data-testid="rail-run"]').attributes("disabled")).toBeDefined();
    // 顶栏主页入口恒在（M11：主页不在 rail）
    expect(wrapper.find('[data-testid="topbar-home"]').exists()).toBe(true);
    // 子视图（接口未选中）禁用：打开工作区、切接口模块、未选接口 → design 禁用
    await openLocalDir(wrapper);
    expect(subRadio(wrapper, "design").attributes("disabled")).toBeDefined();
  });

  it("打开工作区后可切换 运行/环境/导入 模块与 调试/用例/设计 子视图，导入取消回调试子视图", async () => {
    const wrapper = await mountApp();
    // 打开工作区前模块禁用
    expect(wrapper.find('[data-testid="rail-run"]').attributes("disabled")).toBeDefined();
    await openLocalDir(wrapper);
    await flushPromises();
    // 主页是打开后的缺省视图：切回接口模块再断言
    await wrapper.find('[data-testid="rail-api"]').trigger("click");
    await flushPromises();
    // 打开后模块可用；缺省接口模块 + 调试子视图 = 编辑器 + 响应区（子视图需选中接口）
    expect(wrapper.find('[data-testid="rail-run"]').attributes("disabled")).toBeUndefined();
    expect(wrapper.find('[data-testid="editor-pane"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="viewer-pane"]').exists()).toBe(true);
    // 选中种子接口 → 子视图（调试/设计）启用 → 设计子视图（M9-D：用例移入测试模块）
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    await wrapper.find('[data-testid="tree-api"]').trigger("click");
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
    await flushPromises();
    expect(wrapper.find('[data-testid="env-panel"]').exists()).toBe(true);
    // 运行模块（RunView 内含运行历史抽屉）
    await wrapper.find('[data-testid="rail-run"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="run-view"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="runs-history-btn"]').exists()).toBe(true);
    // 导入（M10 归接口模块）：接口头按钮打开向导，取消回调试子视图
    await wrapper.find('[data-testid="rail-api"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-testid="api-import-btn"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="import-wizard"]').exists()).toBe(true);
    await wrapper.find('[data-testid="import-cancel"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="editor-pane"]').exists()).toBe(true);
  });

  it("调试子视图仍是缺省且发送链路可用（装配不破坏既有行为）", async () => {
    const wrapper = await mountApp();
    await openLocalDir(wrapper);
    await flushPromises();
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    await wrapper.find('[data-testid="tree-api"]').trigger("click");
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
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    await wrapper.find('[data-testid="tree-api"]').trigger("click");
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
  it("dirty 时点击另一工作流：确认前缓冲不变；取消保持；确认后新流载入", async () => {
    const wrapper = await mountApp();
    await openLocalDir(wrapper);
    await flushPromises();
    // 直连替身建两条流后重开工作区刷新树（failingApi 为本文件共享单例，按名定位节点）
    const treeDto = await failingApi.treeGet();
    const project = treeDto.children![0]!.children![0]!;
    const wfA = await failingApi.wfCreate({ projectId: project.id, name: "脏缓冲流" });
    const wfB = await failingApi.wfCreate({ projectId: project.id, name: "切换目标流" });
    await openLocalDir(wrapper);
    await flushPromises();
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    const wfNode = (name: string) =>
      wrapper.findAll('[data-testid="tree-workflow"]').find((n) => n.text().includes(name))!;
    // 侧树打开流 A 并经设计器「加节点」制造 dirty
    await wfNode("脏缓冲流").trigger("click");
    await flushPromises();
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
    await wfNode("切换目标流").trigger("click");
    await flushPromises();
    expect(designOf().workflowId).toBe(wfA.id);
    expect(designOf().dirty).toBe(true);
    expect(expectBody("dialog-cancel").exists()).toBe(true);
    expect(expectBody("dialog-confirm").exists()).toBe(true);

    // 取消：缓冲不变、不载入 B
    await expectBody("dialog-cancel").trigger("click");
    await flushPromises();
    expect(designOf().workflowId).toBe(wfA.id);
    expect(designOf().dirty).toBe(true);

    // 再点流 B 并确认丢弃：新流载入、dirty 复位
    await wfNode("切换目标流").trigger("click");
    await flushPromises();
    await expectBody("dialog-confirm").trigger("click");
    await flushPromises();
    expect(designOf().workflowId).toBe(wfB.id);
    expect(designOf().workflow?.name).toBe("切换目标流");
    expect(designOf().dirty).toBe(false);
  });

  it("非 dirty 时点击另一工作流：直接载入不弹确认（现状保持）", async () => {
    const wrapper = await mountApp();
    await openLocalDir(wrapper);
    await flushPromises();
    const treeDto = await failingApi.treeGet();
    const project = treeDto.children![0]!.children![0]!;
    await failingApi.wfCreate({ projectId: project.id, name: "干净流甲" });
    const wfB = await failingApi.wfCreate({ projectId: project.id, name: "干净流乙" });
    await openLocalDir(wrapper);
    await flushPromises();
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    const wfNode = (name: string) =>
      wrapper.findAll('[data-testid="tree-workflow"]').find((n) => n.text().includes(name))!;
    await wfNode("干净流甲").trigger("click");
    await flushPromises();
    await wfNode("干净流乙").trigger("click");
    await flushPromises();
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
    const project = treeDto.children![0]!.children![0]!;
    const wf = await failingApi.wfCreate({ projectId: project.id, name: "旧名流" });
    await openLocalDir(wrapper);
    await flushPromises();
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    const wfNode = (name: string) =>
      wrapper.findAll('[data-testid="tree-workflow"]').find((n) => n.text().includes(name))!;
    // 侧树打开该流（设计器载入，缓冲持旧名）
    await wfNode("旧名流").trigger("click");
    await flushPromises();
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
    await expectBody("dialog-confirm").trigger("click");
    await flushPromises();
    // 修复前：缓冲仍持旧名（workflowId 不变）——此后保存按缓冲整体替换，改名被静默回滚
    expect(designOf().workflowId).toBeNull();
    expect(designOf().workflow).toBeNull();
    // 再次打开（树已 refresh 显示新名）：走重新 load 拿新名
    await wfNode("新名流").trigger("click");
    await flushPromises();
    expect(designOf().workflowId).toBe(wf.id);
    expect(designOf().workflow?.name).toBe("新名流");
  });

  it("重命名未打开的工作流：不影响设计器会话（条件分支不误伤）", async () => {
    const wrapper = await mountApp();
    await openLocalDir(wrapper);
    await flushPromises();
    const treeDto = await failingApi.treeGet();
    const project = treeDto.children![0]!.children![0]!;
    const wfA = await failingApi.wfCreate({ projectId: project.id, name: "旁路流甲" });
    await failingApi.wfCreate({ projectId: project.id, name: "旁路流乙" });
    await openLocalDir(wrapper);
    await flushPromises();
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    const wfNode = (name: string) =>
      wrapper.findAll('[data-testid="tree-workflow"]').find((n) => n.text().includes(name))!;
    // 设计器开着流甲，重命名流乙
    await wfNode("旁路流甲").trigger("click");
    await flushPromises();
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
      await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
      await wrapper.find('[data-testid="tree-api"]').trigger("click");
      await flushPromises();
      await wrapper.find('[data-testid="rail-wf"]').trigger("click");
      await flushPromises();
      const designer = wrapper.findComponent(WfDesigner);
      const before = designer.props("bindIndex") as WfBindIndex | null;
      expect(before).not.toBeNull();
      expect(before!.apiIds.size).toBe(1);

      // 项目内经侧树新增接口：nodeCreate + workspace.refresh 换新 tree 引用
      await wrapper.find('[data-testid="new-api"]').trigger("click");
      await expectBody("dialog-input").setValue("联动新接口");
      await expectBody("dialog-confirm").trigger("click");
      await flushPromises();

      // watch 源含 workspace.tree：refresh 即重建索引，新接口进入 apiIds/名称表
      const after = designer.props("bindIndex") as WfBindIndex | null;
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
    // 直连替身建工作流后重开工作区刷新树（打开钮对非工作区目录回退内存态）
    const tree = await failingApi.treeGet();
    const project = tree.children![0]!.children![0]!;
    const wf = await failingApi.wfCreate({ projectId: project.id, name: "侧树入口流" });
    await openLocalDir(wrapper);
    await flushPromises();
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    await wrapper.find('[data-testid="tree-workflow"]').trigger("click");
    await flushPromises();
    // 视图切到 wf（rail 选中态）
    expect(wrapper.find('[data-testid="rail-wf"]').classes()).toContain("active");
    // 设计器载入点击的工作流（而非空态列表）
    const designer = wrapper.findComponent(WfDesigner);
    const design = designer.props("workflowDesign") as { workflowId: string | null };
    expect(design.workflowId).toBe(wf.id);
    // 选中节点归属项目解析含 workflows 摘要：selectedProjectId 不因 kind=workflow 落空
    expect(designer.props("projectId")).toBe(project.id);
  });

  it("设计器列表新建工作流后侧树同步出现（树摘要随 wfList 变更刷新）", async () => {
    const wrapper = await mountApp();
    await openLocalDir(wrapper);
    await flushPromises();
    // 选中接口 → selectedProjectId 就绪 → 切到工作流视图（设计器是工作流唯一创建入口）
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    await wrapper.find('[data-testid="tree-api"]').trigger("click");
    await wrapper.find('[data-testid="rail-wf"]').trigger("click");
    await flushPromises();
    // 建前树中无同名工作流（failingApi 是本文件共享单例，前面用例可能已建过别的流）
    expect(wrapper.find('[data-testid="tree-workflow"]').text()).not.toContain("设计器新建流");
    // 经设计器列表新建 → 侧树应同步出现该工作流（draft 色点）
    await wrapper.find('[data-testid="wf-new-name"]').setValue("设计器新建流");
    await wrapper.find('[data-testid="wf-new-create"]').trigger("click");
    await flushPromises();
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
    const project = tree.children![0]!.children![0]!;
    const wf = await failingApi.wfCreate({ projectId: project.id, name: "生命周期流" });
    await openLocalDir(wrapper);
    await flushPromises();
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    const findNode = () =>
      wrapper.findAll('[data-testid="tree-workflow"]').find((n) => n.text().includes("生命周期流"))!;
    expect(findNode().attributes("data-status")).toBe("draft");
    // 侧树打开工作流 → 设计器点「发布」
    await findNode().trigger("click");
    await flushPromises();
    await wrapper.find('[data-testid="wf-publish"]').trigger("click");
    await flushPromises();
    // 侧树色点同步为 published（修复前：同引用赋值不触发响应式 + 无 status watcher，
    // 树摘要陈旧为 draft）
    expect(findNode().attributes("data-status")).toBe("published");
    // 树 DTO 摘要确实重建（status 更新；failingApi 为共享单例，按 id 断言本流）
    const dto = await failingApi.treeGet();
    expect(dto.children![0]!.children![0]!.workflows!.find((w) => w.id === wf.id)).toEqual({
      id: wf.id,
      name: "生命周期流",
      status: "published",
    });
  });
});

// —— M3-B 任务 2：在线登录与服务器配置装配（入口在 TopBar，对话框由组合根渲染） ——
describe("App 在线模式装配（M3-B 任务 2）", () => {
  it("顶栏在线入口：点击打开登录对话框；保存档案 + 登录成功 → 入口显示登录身份；登出后回到未登录文案", async () => {
    try {
      const wrapper = await mountApp();
      // 顶栏入口按钮（未登录文案）
      expect(wrapper.find('[data-testid="online-toggle"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="online-status"]').text()).toBe("在线模式");
      // 打开对话框（a-modal 传送门渲染于 body）
      await wrapper.find('[data-testid="online-toggle"]').trigger("click");
      await flushPromises();
      expect(bodyFind("online-body")).not.toBeNull();
      // 保存服务器档案（url + 昵称）
      await expectBody("online-server-url").setValue("http://127.0.0.1:8080");
      await expectBody("online-server-name").setValue("团队服务器");
      await expectBody("online-server-save").trigger("click");
      await flushPromises();
      // 登录（memory 替身接受任意登录）→ 对话框切已登录区 + 顶栏入口显登录身份
      await expectBody("online-username").setValue("alice");
      await expectBody("online-password").setValue("password8");
      await expectBody("online-login-submit").trigger("click");
      await flushPromises();
      expect(expectBody("online-user").text()).toContain("示例用户");
      expect(wrapper.find('[data-testid="online-status"]').text()).toContain("示例用户");
      // 退出登录：回登录表单，档案保留；顶栏入口回未登录文案
      await expectBody("online-logout").trigger("click");
      await flushPromises();
      expect(bodyFind("online-login-form")).not.toBeNull();
      expect(wrapper.find('[data-testid="online-status"]').text()).toBe("在线模式");
    } finally {
      // 清理：本用例写入的档案持久化不污染同文件后续用例
      localStorage.removeItem("apicc.onlineServers");
    }
  });

  it("App 挂载即尝试恢复登录态（init→resume）：替身已登录时入口直接显示身份", async () => {
    // 预置：替身登录 + 档案存储含激活服务器（模拟上次会话）→ App init 恢复
    await failingApi.onlineLogin({ baseUrl: "http://127.0.0.1:8080", username: "alice", password: "password8" });
    localStorage.setItem("apicc.onlineServers", JSON.stringify({
      active: "http://127.0.0.1:8080",
      servers: [{ baseUrl: "http://127.0.0.1:8080", name: "团队服务器" }],
    }));
    try {
      const wrapper = await mountApp();
      await flushPromises();
      expect(wrapper.find('[data-testid="online-status"]').text()).toContain("示例用户");
    } finally {
      localStorage.removeItem("apicc.onlineServers");
      await failingApi.onlineLogout();
    }
  });
});

// —— M7-B 任务 1：插件管理视图装配（裁定①：路由 /plugins + 侧栏入口，管理类视图）——
describe("App 插件视图装配（M7-B 任务 1）", () => {
  it("插件入口（M9-C 裁定 D5）：顶栏设置抽屉打开插件管理，恒可用（不依赖工作区）", async () => {
    const wrapper = await mountApp();
    // 未打开工作区：工作区级模块（run 等）禁用
    expect(wrapper.find('[data-testid="rail-run"]').attributes("disabled")).toBeDefined();
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
    startedAt: 0,
    finishedAt: 100,
  };
}

describe("App 测试模块装配（M9-D）", () => {
  it("rail-test 打开测试模块：单接口用例面板选接口后可编辑，case-run 运行结果内嵌上屏", async () => {
    const wrapper = await mountApp();
    await openLocalDir(wrapper);
    await flushPromises();
    // 选中种子接口（作用域化树：collection 展开后点接口）
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    await wrapper.find('[data-testid="tree-api"]').trigger("click");
    await flushPromises();
    // 测试模块：用例面板渲染（用例列表来自当前接口）
    await wrapper.find('[data-testid="rail-test"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="test-view"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="case-panel"]').exists()).toBe(true);
    // 单条用例「运行」：结果内嵌上屏（memory 替身断言恒通过）
    const runBtn = wrapper.find('[data-testid^="case-run-"]');
    await runBtn.trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="test-result"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="response-outcome"]').exists()).toBe(true);
  });

  it("用例行「压测」：内嵌 StressPanel 渲染并绑定当前接口（apiId/cases/envs 预选该用例）", async () => {
    failingApi.nodeCreate = realNodeCreate;
    try {
      const wrapper = await mountApp();
      await openLocalDir(wrapper);
      await flushPromises();
      await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
      await wrapper.find('[data-testid="tree-api"]').trigger("click");
      await flushPromises();
      await wrapper.find('[data-testid="rail-test"]').trigger("click");
      await flushPromises();
      failingApi.stressRun = async () => ({ report: stressReportFixture(), file: "stress-x.json" });
      // 用例行点「压测」：内嵌 StressPanel + 预选该用例
      const stressBtn = wrapper.find('[data-testid^="case-stress-"]');
      const caseId = stressBtn.attributes("data-case-id") as string;
      await stressBtn.trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-testid="stress-panel"]').exists()).toBe(true);
      const panel = wrapper.findComponent(StressPanel);
      const apiId = wrapper.find('[data-testid="tree-api"]').attributes("data-node-id") as string;
      expect(panel.props("apiId")).toBe(apiId);
      expect((panel.props("cases") as Array<{ name: string }>).map((c) => c.name)).toEqual(["冒烟"]);
      const stress = panel.props("stress") as { form: { caseId: string; concurrency: number } };
      expect(stress.form.caseId).toBe(caseId);
      // 压测跑一轮出报告，返回用例再进入保留（store 会话不随视图切换清空）
      await wrapper.find('[data-testid="stress-start"]').trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-testid="stress-report"]').exists()).toBe(true);
      await wrapper.find('[data-testid="test-back-to-cases"]').trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-testid="case-panel"]').exists()).toBe(true);
      // 切接口：压测会话清空（clear 裁定）——新建第二接口并选中
      await wrapper.find('[data-testid="new-api"]').trigger("click");
      await expectBody("dialog-input").setValue("第二接口");
      await expectBody("dialog-confirm").trigger("click");
      await flushPromises();
      // 新接口在测试模块：进入压测上下文前报告已清空
      const newApiBtn = wrapper.findAll('[data-testid^="test-api-"]').at(-1)!;
      await newApiBtn.trigger("click");
      await flushPromises();
      const stressBtn2 = wrapper.find('[data-testid^="case-stress-"]');
      await stressBtn2.trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-testid="stress-report"]').exists()).toBe(false);
    } finally {
      failingApi.nodeCreate = async () => { throw new Error("接口创建失败（测试注入）"); };
    }
  });

  it("场景用例：项目工作流清单渲染，点击「运行」切工作流模块并载入；场景压测为禁用态", async () => {
    const wrapper = await mountApp();
    await openLocalDir(wrapper);
    await flushPromises();
    // 建（或复用）一条工作流后进入测试模块场景页签
    const treeDto = await failingApi.treeGet();
    const project = treeDto.children![0]!.children![0]!;
    const wf = await failingApi.wfCreate({ projectId: project.id, name: "场景流" });
    // 直建工作流后重开目录刷新树摘要（场景清单取自 workspace.tree）
    await openLocalDir(wrapper);
    await flushPromises();
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    await wrapper.find('[data-testid="tree-api"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-testid="rail-test"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-testid="test-tab-scenario"]').trigger("click");
    await flushPromises();
    // 场景压测禁用（裁定 D2：延后不做假入口）
    expect(wrapper.find('[data-testid="test-scenario-stress"]').attributes("disabled")).toBeDefined();
    // 运行：切到工作流模块且设计器载入该流
    await wrapper.find(`[data-testid="test-scenario-run-${wf.id}"]`).trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="rail-wf"]').classes()).toContain("active");
    const design = wrapper.findComponent(WfDesigner).props("workflowDesign") as { workflowId: string | null };
    expect(design.workflowId).toBe(wf.id);
  });
});

// —— M9-A1：环境管理新建环境后，调试环境选择器（editor.envs）同步刷新 ——
describe("App 环境联动（M9-A1）", () => {
  it("环境模块新建环境后，调试选择器可见该环境", async () => {
    const wrapper = await mountApp();
    await openLocalDir(wrapper);
    await flushPromises();
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    await wrapper.find('[data-testid="tree-api"]').trigger("click");
    await flushPromises();
    // 选中接口时环境清单为空（种子项目无环境）
    const editorOf = () =>
      wrapper.findComponent(RequestEditor).props("editor") as { envs: Array<{ id: string; name: string }> };
    expect(editorOf().envs).toEqual([]);
    // 环境模块新建环境
    await wrapper.find('[data-testid="rail-envs"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-testid="env-new"]').trigger("click");
    await flushPromises();
    await expectBody("env-name-input").setValue("prod");
    await expectBody("env-modal-confirm").trigger("click");
    await flushPromises();
    // 回调试模块：选择器数据源（editor.envs）已含新环境
    await wrapper.find('[data-testid="rail-api"]').trigger("click");
    await flushPromises();
    expect(editorOf().envs.map((e) => e.name)).toContain("prod");
  });
});

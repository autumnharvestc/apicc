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
import type { WfBindIndex } from "../../src/renderer/src/wf/wfBindings.js";

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
  const { default: App } = await import("../../src/renderer/src/App.vue");
  const wrapper = mount(App, { global: { plugins: [initI18n().i18n] } });
  await flushPromises();
  return wrapper;
}

describe("App 三栏布局", () => {
  it("挂载并渲染 顶栏/侧树/编辑区/响应区 四个区域", async () => {
    const wrapper = await mountApp();
    expect(wrapper.find('[data-testid="app-root"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="topbar"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="side-tree"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="editor-pane"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="viewer-pane"]').exists()).toBe(true);
    // 工作区未打开（内存替身未 seed 打开）：侧树与编辑器均为空态，响应区为空态
    const empties = wrapper.findAll('[data-testid="empty-state"]');
    expect(empties.length).toBeGreaterThanOrEqual(2);
    expect(wrapper.find('[data-testid="response-empty"]').exists()).toBe(true);
  });

  it("侧树为 240px 固定宽（左树右上下分栏结构）", async () => {
    const wrapper = await mountApp();
    const side = wrapper.find('[data-testid="side-tree"]');
    expect(side.classes()).toContain("side-col");
    expect(wrapper.find('[data-testid="main-split"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="main-split"]').element.children.length).toBe(2); // 上编辑器/下响应
  });
});

describe("App 错误反馈通道（宽审查 I1）", () => {
  it("对话框 run 拒绝时 app-error 展示错误并可手动关闭", async () => {
    const wrapper = await mountApp();
    // 打开工作区：memory 替身 wsOpen 对非工作区目录回退内存态（已 seed）
    await wrapper.find('[data-testid="open-workspace"]').trigger("click");
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

describe("App 视图切换装配（任务 8 收官）", () => {
  it("未打开工作区时视图切换禁用（现状保留：只有打开/新建可用）", async () => {
    const wrapper = await mountApp();
    expect(wrapper.find('[data-testid="view-switch"]').exists()).toBe(true);
    const radio = wrapper.find('input[value="cases"]');
    expect(radio.exists()).toBe(true);
    expect(radio.attributes("disabled")).toBeDefined();
  });

  it("打开工作区后可切换 调试/用例/环境/运行/设计/导入 各视图，导入取消回调试视图", async () => {
    const wrapper = await mountApp();
    // 打开工作区前切换钮禁用
    expect(wrapper.find('input[value="cases"]').attributes("disabled")).toBeDefined();
    await wrapper.find('[data-testid="open-workspace"]').trigger("click");
    await flushPromises();
    // 打开后可切换；默认调试视图 = 既有 编辑器 + 响应区
    expect(wrapper.find('input[value="cases"]').attributes("disabled")).toBeUndefined();
    expect(wrapper.find('[data-testid="editor-pane"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="viewer-pane"]').exists()).toBe(true);
    // 用例视图
    await wrapper.find('input[value="cases"]').setValue(true);
    await flushPromises();
    expect(wrapper.find('[data-testid="case-panel"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="editor-pane"]').exists()).toBe(false);
    // 环境视图
    await wrapper.find('input[value="envs"]').setValue(true);
    await flushPromises();
    expect(wrapper.find('[data-testid="env-panel"]').exists()).toBe(true);
    // 运行视图（RunView 内含运行历史抽屉）
    await wrapper.find('input[value="run"]').setValue(true);
    await flushPromises();
    expect(wrapper.find('[data-testid="run-view"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="runs-history-btn"]').exists()).toBe(true);
    // 设计视图
    await wrapper.find('input[value="design"]').setValue(true);
    await flushPromises();
    expect(wrapper.find('[data-testid="design-panel"]').exists()).toBe(true);
    // 导入视图 + 取消经 close 事件回调试视图
    await wrapper.find('input[value="import"]').setValue(true);
    await flushPromises();
    expect(wrapper.find('[data-testid="import-wizard"]').exists()).toBe(true);
    await wrapper.find('[data-testid="import-cancel"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="editor-pane"]').exists()).toBe(true);
  });

  it("调试视图仍是默认视图且发送链路可用（装配不破坏既有行为）", async () => {
    const wrapper = await mountApp();
    await wrapper.find('[data-testid="open-workspace"]').trigger("click");
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
    await wrapper.find('[data-testid="open-workspace"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    await wrapper.find('[data-testid="tree-api"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-testid="send-btn"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('[data-testid="response-outcome"]').exists()).toBe(true);
    // zh-CN：ConfigProvider locale=zh_CN → a-table 空态内建文案「暂无数据」
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

// —— 宽范围审查 I2：项目内 API 增删后 bindIndex 必须随树刷新重建 ——
// 修复前 watch 源仅 [selectedProjectId, opened]：项目内新增接口只改变 workspace.tree
// 引用（refresh 换新对象、选中项目不变），watch 不触发 → 设计器拿到陈旧索引，
// 改绑级联、画布 apiName/caseName 预注入与 missing 红框检测全部失真。
describe("App 工作流绑定索引随树刷新（审查 I2）", () => {
  it("项目内新增接口后 bindIndex 重建并包含新接口", async () => {
    failingApi.nodeCreate = realNodeCreate; // 本用例需要真实创建，结束时还原恒拒绝替身
    try {
      const wrapper = await mountApp();
      await wrapper.find('[data-testid="open-workspace"]').trigger("click");
      await flushPromises();
      // 选中种子接口 → selectedProjectId 就绪 → bindIndex 首次构建（仅种子 1 个接口）
      await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
      await wrapper.find('[data-testid="tree-api"]').trigger("click");
      await flushPromises();
      await wrapper.find('input[value="wf"]').setValue(true);
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

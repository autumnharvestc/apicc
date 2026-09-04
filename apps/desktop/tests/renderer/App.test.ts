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

// —— 审查 I1：侧树切换工作流必须过 dirty 确认，编辑不得静默丢失 ——
describe("App 侧树切换工作流 dirty 确认（审查 I1）", () => {
  it("dirty 时点击另一工作流：确认前缓冲不变；取消保持；确认后新流载入", async () => {
    const wrapper = await mountApp();
    await wrapper.find('[data-testid="open-workspace"]').trigger("click");
    await flushPromises();
    // 直连替身建两条流后重开工作区刷新树（failingApi 为本文件共享单例，按名定位节点）
    const treeDto = await failingApi.treeGet();
    const project = treeDto.children![0]!.children![0]!;
    const wfA = await failingApi.wfCreate({ projectId: project.id, name: "脏缓冲流" });
    const wfB = await failingApi.wfCreate({ projectId: project.id, name: "切换目标流" });
    await wrapper.find('[data-testid="open-workspace"]').trigger("click");
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
    await wrapper.find('[data-testid="open-workspace"]').trigger("click");
    await flushPromises();
    const treeDto = await failingApi.treeGet();
    const project = treeDto.children![0]!.children![0]!;
    await failingApi.wfCreate({ projectId: project.id, name: "干净流甲" });
    const wfB = await failingApi.wfCreate({ projectId: project.id, name: "干净流乙" });
    await wrapper.find('[data-testid="open-workspace"]').trigger("click");
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
    await wrapper.find('[data-testid="open-workspace"]').trigger("click");
    await flushPromises();
    const treeDto = await failingApi.treeGet();
    const project = treeDto.children![0]!.children![0]!;
    const wf = await failingApi.wfCreate({ projectId: project.id, name: "旧名流" });
    await wrapper.find('[data-testid="open-workspace"]').trigger("click");
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
    await wrapper.find('[data-testid="open-workspace"]').trigger("click");
    await flushPromises();
    const treeDto = await failingApi.treeGet();
    const project = treeDto.children![0]!.children![0]!;
    const wfA = await failingApi.wfCreate({ projectId: project.id, name: "旁路流甲" });
    await failingApi.wfCreate({ projectId: project.id, name: "旁路流乙" });
    await wrapper.find('[data-testid="open-workspace"]').trigger("click");
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

// —— M2-B 收口：侧树工作流入口（点击工作流节点 → 视图切 wf + 设计器载入该流） ——
describe("App 侧树工作流入口", () => {
  it("点击侧树工作流节点：视图切到工作流且设计器载入该流（selectedProjectId 保持所属项目）", async () => {
    const wrapper = await mountApp();
    await wrapper.find('[data-testid="open-workspace"]').trigger("click");
    await flushPromises();
    // 直连替身建工作流后重开工作区刷新树（打开钮对非工作区目录回退内存态）
    const tree = await failingApi.treeGet();
    const project = tree.children![0]!.children![0]!;
    const wf = await failingApi.wfCreate({ projectId: project.id, name: "侧树入口流" });
    await wrapper.find('[data-testid="open-workspace"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    await wrapper.find('[data-testid="tree-workflow"]').trigger("click");
    await flushPromises();
    // 视图切到 wf（radio 选中态）
    expect((wrapper.find('input[value="wf"]').element as HTMLInputElement).checked).toBe(true);
    // 设计器载入点击的工作流（而非空态列表）
    const designer = wrapper.findComponent(WfDesigner);
    const design = designer.props("workflowDesign") as { workflowId: string | null };
    expect(design.workflowId).toBe(wf.id);
    // 选中节点归属项目解析含 workflows 摘要：selectedProjectId 不因 kind=workflow 落空
    expect(designer.props("projectId")).toBe(project.id);
  });

  it("设计器列表新建工作流后侧树同步出现（树摘要随 wfList 变更刷新）", async () => {
    const wrapper = await mountApp();
    await wrapper.find('[data-testid="open-workspace"]').trigger("click");
    await flushPromises();
    // 选中接口 → selectedProjectId 就绪 → 切到工作流视图（设计器是工作流唯一创建入口）
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    await wrapper.find('[data-testid="tree-api"]').trigger("click");
    await wrapper.find('input[value="wf"]').setValue(true);
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
    await wrapper.find('[data-testid="open-workspace"]').trigger("click");
    await flushPromises();
    // 直连替身建 draft 工作流后重开工作区刷新树（failingApi 为本文件共享单例，按名断言）
    const tree = await failingApi.treeGet();
    const project = tree.children![0]!.children![0]!;
    const wf = await failingApi.wfCreate({ projectId: project.id, name: "生命周期流" });
    await wrapper.find('[data-testid="open-workspace"]').trigger("click");
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

// —— M2-D3 任务 3：压测视图装配（简报裁定 A）——

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

describe("App 压测视图装配（M2-D3 任务 3，裁定 A）", () => {
  it("未选中接口时压测项禁用；选中接口后可用，切入渲染 StressPanel（props 装配选中接口 apiId/store/cases）", async () => {
    const wrapper = await mountApp();
    await wrapper.find('[data-testid="open-workspace"]').trigger("click");
    await flushPromises();
    // 未选中接口：压测项存在但禁用（cases/envs 视图对接口选中的既有口径）
    const stressRadio = wrapper.find('input[value="stress"]');
    expect(stressRadio.exists()).toBe(true);
    expect(stressRadio.attributes("disabled")).toBeDefined();
    // 选中接口后压测项可用
    await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
    await wrapper.find('[data-testid="tree-api"]').trigger("click");
    await flushPromises();
    expect(wrapper.find('input[value="stress"]').attributes("disabled")).toBeUndefined();
    // 切到压测视图：StressPanel 渲染，props 为选中接口
    await wrapper.find('input[value="stress"]').setValue(true);
    await flushPromises();
    expect(wrapper.find('[data-testid="stress-panel"]').exists()).toBe(true);
    const panel = wrapper.findComponent(StressPanel);
    const apiId = wrapper.find('[data-testid="tree-api"]').attributes("data-node-id") as string;
    expect(panel.props("apiId")).toBe(apiId);
    // store 实例（组合根一次性创建后经 props 下传）：带 form 状态与 start/clear 动作
    const stress = panel.props("stress") as {
      form: { concurrency: number; mode: string };
      start: unknown;
      clear: unknown;
    };
    expect(stress.form.concurrency).toBe(1);
    expect(stress.form.mode).toBe("iterations");
    expect(typeof stress.start).toBe("function");
    expect(typeof stress.clear).toBe("function");
    // cases/envs 经 editor store 下发（种子接口单用例「冒烟」、无环境）
    expect((panel.props("cases") as Array<{ name: string }>).map((c) => c.name)).toEqual(["冒烟"]);
    expect(panel.props("envs")).toEqual([]);
  });

  it("压测报告上屏后同接口视图往返保留；切接口时压测会话清空（clear 裁定）", async () => {
    failingApi.nodeCreate = realNodeCreate; // 本用例需要真实创建第二接口，结束还原恒拒绝替身
    try {
      const wrapper = await mountApp();
      await wrapper.find('[data-testid="open-workspace"]').trigger("click");
      await flushPromises();
      await wrapper.find('[data-testid="tree-group-toggle"]').trigger("click");
      await wrapper.find('[data-testid="tree-api"]').trigger("click");
      await flushPromises();
      // 压测一次出报告（替身立即返回固定报告；表单默认选中首个用例，可直接开始）
      failingApi.stressRun = async () => ({ report: stressReportFixture(), file: "stress-x.json" });
      await wrapper.find('input[value="stress"]').setValue(true);
      await flushPromises();
      await wrapper.find('[data-testid="stress-start"]').trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-testid="stress-report"]').exists()).toBe(true);
      // 同接口视图往返（stress → cases → stress）：form/报告保留
      await wrapper.find('input[value="cases"]').setValue(true);
      await flushPromises();
      await wrapper.find('input[value="stress"]').setValue(true);
      await flushPromises();
      expect(wrapper.find('[data-testid="stress-report"]').exists()).toBe(true);
      // 新建并选中另一个接口：切接口触发 store.clear() → 旧报告不再上屏
      await wrapper.find('[data-testid="new-api"]').trigger("click");
      await expectBody("dialog-input").setValue("第二接口");
      await expectBody("dialog-confirm").trigger("click");
      await flushPromises();
      expect(wrapper.find('[data-testid="stress-panel"]').exists()).toBe(true);
      expect(wrapper.find('[data-testid="stress-report"]').exists()).toBe(false);
    } finally {
      failingApi.nodeCreate = async () => { throw new Error("接口创建失败（测试注入）"); };
    }
  });

  it("视图切换回归：切换控件含全部 8 项，既有 6 视图全部仍可达", async () => {
    const wrapper = await mountApp();
    await wrapper.find('[data-testid="open-workspace"]').trigger("click");
    await flushPromises();
    // 8 项（既有 7 项 + stress），顺序与 VIEWS 一致
    const values = wrapper
      .findAll(".view-switch input[type=radio]")
      .map((i) => (i.element as HTMLInputElement).value);
    expect(values).toEqual(["debug", "cases", "envs", "run", "import", "design", "wf", "stress"]);
    // 既有 6 视图逐一切换仍可达（切换控件增项不破坏既有断言）
    const reachable: Array<[string, string]> = [
      ["cases", "case-panel"],
      ["envs", "env-panel"],
      ["run", "run-view"],
      ["import", "import-wizard"],
      ["design", "design-panel"],
      ["debug", "editor-pane"],
    ];
    for (const [view, testid] of reachable) {
      await wrapper.find(`input[value="${view}"]`).setValue(true);
      await flushPromises();
      expect(wrapper.find(`[data-testid="${testid}"]`).exists()).toBe(true);
    }
  });
});

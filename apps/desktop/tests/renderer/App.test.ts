// @vitest-environment jsdom
// 注：App 是组合根——内部经 api/index.ts 单例（vitest 无 preload → 回退内存替身）
// 一次装配全部 store；i18n 必须装 bridge 单例（TopBar→ThemeLanguageToggle 的
// useLocale 读同一实例，装其它实例会导致语言切换与文案不一致）。
// 宽审查 I1：本文件在模块求值期把 window.apicc 换成「已 seed、nodeCreate 恒拒绝」的
// 内存替身——api/index.ts 是惰性求值（首次 import App 时读 window.apicc），因此注入
// 必须先于组件树的首次加载，故 App 以动态 import 方式在 mountApp 内引入。
import { describe, expect, it, beforeAll } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { initI18n } from "../../src/renderer/src/i18n/bridge";
import { createMemoryApi } from "../../src/renderer/src/api/memory.js";

const failingApi = createMemoryApi();
failingApi.seedWorkspace();
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
    await wrapper.find('[data-testid="dialog-input"]').setValue("x");
    await wrapper.find('[data-testid="dialog-confirm"]').trigger("click");
    await flushPromises();
    const bar = wrapper.find('[data-testid="app-error"]');
    expect(bar.exists()).toBe(true);
    expect(bar.text()).toContain("接口创建失败（测试注入）");
    // 手动关闭后隐藏
    await wrapper.find('[data-testid="app-error-close"]').trigger("click");
    expect(wrapper.find('[data-testid="app-error"]').exists()).toBe(false);
  });
});

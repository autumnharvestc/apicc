// @vitest-environment jsdom
// 注：App 是组合根——内部经 api/index.ts 单例（vitest 无 preload → 回退内存替身）
// 一次装配全部 store；i18n 必须装 bridge 单例（TopBar→ThemeLanguageToggle 的
// useLocale 读同一实例，装其它实例会导致语言切换与文案不一致）。
import { describe, expect, it, beforeAll } from "vitest";
import { mount } from "@vue/test-utils";
import App from "../../src/renderer/src/App.vue";
import { initI18n } from "../../src/renderer/src/i18n/bridge";

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

describe("App 三栏布局", () => {
  it("挂载并渲染 顶栏/侧树/编辑区/响应区 四个区域", () => {
    const wrapper = mount(App, { global: { plugins: [initI18n().i18n] } });
    expect(wrapper.find('[data-testid="app-root"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="topbar"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="side-tree"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="editor-pane"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="viewer-pane"]').exists()).toBe(true);
    // 工作区未打开（内存替身未 seed）：侧树与编辑器均为空态，响应区为空态
    const empties = wrapper.findAll('[data-testid="empty-state"]');
    expect(empties.length).toBeGreaterThanOrEqual(2);
    expect(wrapper.find('[data-testid="response-empty"]').exists()).toBe(true);
  });

  it("侧树为 240px 固定宽（左树右上下分栏结构）", () => {
    const wrapper = mount(App, { global: { plugins: [initI18n().i18n] } });
    const side = wrapper.find('[data-testid="side-tree"]');
    expect(side.classes()).toContain("side-col");
    expect(wrapper.find('[data-testid="main-split"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="main-split"]').element.children.length).toBe(2); // 上编辑器/下响应
  });
});

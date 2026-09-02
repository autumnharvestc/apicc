// @vitest-environment jsdom
// 注：任务 5 遗留收口——ThemeLanguageToggle/theme.ts 此前零入库测试，App 装配后补正式组件测试。
import { describe, expect, it, beforeAll } from "vitest";
import { mount } from "@vue/test-utils";
import ThemeLanguageToggle from "../../../src/renderer/src/components/ThemeLanguageToggle.vue";
import { initI18n } from "../../../src/renderer/src/i18n/bridge";

beforeAll(() => {
  // jsdom 未实现 matchMedia（主题解析 system 偏好需要）；固定 false → system 解析为 light。
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
  localStorage.removeItem("apicc.theme");
  localStorage.setItem("apicc.locale", "zh-CN");
});

describe("ThemeLanguageToggle", () => {
  it("语言循环点击改写 locale（bridge 单例）", async () => {
    const { i18n } = initI18n();
    const wrapper = mount(ThemeLanguageToggle, { global: { plugins: [i18n] } });
    const before = i18n.global.locale.value;
    await wrapper.find('[data-testid="lang-toggle"]').trigger("click");
    expect(i18n.global.locale.value).not.toBe(before);
    expect(wrapper.find('[data-testid="lang-toggle"]').text()).toBe(i18n.global.locale.value);
  });

  it("主题循环点击写 document 数据主题：system→light→dark", async () => {
    const { i18n } = initI18n();
    // 单例 locale 被上一用例的循环点击改写——显式归位后再断言主题切换不动语言。
    i18n.global.locale.value = "zh-CN";
    const wrapper = mount(ThemeLanguageToggle, { global: { plugins: [i18n] } });
    // 挂载即应用当前偏好（system，matchMedia=false → light）
    expect(document.documentElement.dataset.theme).toBe("light");
    await wrapper.find('[data-testid="theme-toggle"]').trigger("click"); // system → light
    expect(document.documentElement.dataset.theme).toBe("light");
    await wrapper.find('[data-testid="theme-toggle"]').trigger("click"); // light → dark
    expect(document.documentElement.dataset.theme).toBe("dark");
    await wrapper.find('[data-testid="theme-toggle"]').trigger("click"); // dark → system(light)
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("apicc.theme")).toBe("system");
    expect(i18n.global.locale.value).toBe("zh-CN"); // 主题切换不影响语言
  });
});

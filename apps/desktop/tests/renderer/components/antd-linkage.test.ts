// @vitest-environment jsdom
// 注：验证 ConfigProvider 两个数据源与既有交互链路的联动——
// locale 源 = bridge.currentLocale()（语言切换后随之变化），
// algorithm 源 = theme.themePreference（主题循环后随之变化）。
import { describe, expect, it, beforeAll } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { createI18nInstance } from "../../../src/renderer/src/i18n/index.js";
import { currentLocale } from "../../../src/renderer/src/i18n/bridge";
import { themePreference } from "../../../src/renderer/src/theme";
import ThemeLanguageToggle from "../../../src/renderer/src/components/ThemeLanguageToggle.vue";

beforeAll(() => {
  // jsdom 未实现 matchMedia（挂载即应用主题偏好需要）；固定 false → system 解析为 light。
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

async function mountToggle() {
  setActivePinia(createPinia());
  const { i18n } = createI18nInstance();
  const wrapper = mount(ThemeLanguageToggle, { global: { plugins: [i18n] } });
  return wrapper;
}

describe("antd 联动数据源", () => {
  it("语言循环后 currentLocale 变化（ConfigProvider locale 源）", async () => {
    const wrapper = await mountToggle();
    const before = currentLocale();
    await wrapper.find('[data-testid="lang-toggle"]').trigger("click");
    expect(currentLocale()).not.toBe(before);
  });
  it("主题循环后 themePreference 变化（ConfigProvider algorithm 源）", async () => {
    const wrapper = await mountToggle();
    const before = themePreference.value;
    await wrapper.find('[data-testid="theme-toggle"]').trigger("click");
    expect(themePreference.value).not.toBe(before);
  });
});

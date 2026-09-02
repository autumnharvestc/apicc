// @vitest-environment jsdom
// 注：验证 ConfigProvider 两个数据源与既有交互链路的联动——
// locale 源 = bridge.currentLocale()（语言下拉选择后随之变化），
// algorithm 源 = theme.themePreference（Segmented 选中段后随之变化）。
import { describe, expect, it, beforeAll } from "vitest";
import { mount, flushPromises, DOMWrapper } from "@vue/test-utils";
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

/** 语言下拉菜单项（a-dropdown 传送门渲染在 document.body，菜单项带 data-locale）。 */
function langOption(locale: string): DOMWrapper<Element> {
  const el = document.body.querySelector(`[data-locale="${locale}"]`);
  if (!el) throw new Error(`document.body 中找不到 [data-locale="${locale}"]（语言下拉未展开？）`);
  return new DOMWrapper(el);
}

describe("antd 联动数据源", () => {
  it("语言下拉点选后 currentLocale 变化（ConfigProvider locale 源）", async () => {
    const wrapper = await mountToggle();
    const before = currentLocale(); // zh-CN
    await wrapper.find('[data-testid="lang-toggle"]').trigger("click");
    await flushPromises();
    await langOption("en").trigger("click");
    expect(currentLocale()).not.toBe(before);
    expect(currentLocale()).toBe("en");
  });
  it("Segmented 选中段后 themePreference 变化（ConfigProvider algorithm 源）", async () => {
    const wrapper = await mountToggle();
    // data-testid 契约：theme-toggle 落在 Segmented 根元素（attrs 透传）
    expect(wrapper.find('[data-testid="theme-toggle"]').exists()).toBe(true);
    const before = themePreference.value; // system（fresh jsdom + localStorage 已清）
    // 三段选项由 radio input 承载，顺序 = options 声明序 [system, light, dark]
    const inputs = wrapper.findAll('input[type="radio"]');
    expect(inputs.length).toBe(3);
    await inputs[1]!.trigger("change"); // 选中「亮色」段
    expect(themePreference.value).not.toBe(before);
    expect(themePreference.value).toBe("light");
  });
});

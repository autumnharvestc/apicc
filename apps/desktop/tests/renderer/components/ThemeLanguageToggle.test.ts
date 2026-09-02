// @vitest-environment jsdom
// 注：TopBar 控件现代化（计划 2C 任务 2）后的适配形态——
// 语言 = a-dropdown 菜单：点击 lang-toggle 打开（菜单经传送门渲染到 document.body，
// 菜单项带 data-locale），点菜单项改写 locale；
// 主题 = a-segmented 三段选择器：选项由 input[type=radio] 承载，对对应段 trigger
// change 即等效用户选中该段；受控值 themePreference 为模块级响应式 ref。
import { describe, expect, it, beforeAll } from "vitest";
import { mount, flushPromises, DOMWrapper } from "@vue/test-utils";
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

/** 语言下拉菜单项（a-dropdown 传送门渲染在 document.body，见文件头说明）。 */
function langOption(locale: string): DOMWrapper<Element> {
  const el = document.body.querySelector(`[data-locale="${locale}"]`);
  if (!el) throw new Error(`document.body 中找不到 [data-locale="${locale}"]（语言下拉未展开？）`);
  return new DOMWrapper(el);
}

describe("ThemeLanguageToggle", () => {
  it("下拉菜单点选 English 改写 locale（bridge 单例）", async () => {
    const { i18n } = initI18n();
    // 单例 locale 可能被同文件其他用例改写——显式归位后断言
    i18n.global.locale.value = "zh-CN";
    const wrapper = mount(ThemeLanguageToggle, { global: { plugins: [i18n] } });
    await wrapper.find('[data-testid="lang-toggle"]').trigger("click");
    await flushPromises();
    await langOption("en").trigger("click");
    expect(i18n.global.locale.value).toBe("en");
    // 触发按钮文案随语言变化（地球图标 + 语言名，不再是裸 locale 代码）
    expect(wrapper.find('[data-testid="lang-toggle"]').text()).toBe("English");
  });

  it("Segmented 三段选择写 document 数据主题：system→light→dark→system(light)", async () => {
    const { i18n } = initI18n();
    // 单例 locale 被上一用例的下拉点选改写——显式归位后再断言主题切换不动语言。
    i18n.global.locale.value = "zh-CN";
    const wrapper = mount(ThemeLanguageToggle, { global: { plugins: [i18n] } });
    // 挂载即应用当前偏好（system，matchMedia=false → light）
    expect(document.documentElement.dataset.theme).toBe("light");
    // 三段选项由 radio input 承载，顺序 = options 声明序 [system, light, dark]
    const radio = (i: number) => {
      const inputs = wrapper.findAll('input[type="radio"]');
      if (inputs.length !== 3) throw new Error(`Segmented 选项数异常: ${inputs.length}`);
      return inputs[i]!;
    };
    await radio(1).trigger("change"); // system → light
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("apicc.theme")).toBe("light");
    await radio(2).trigger("change"); // light → dark
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("apicc.theme")).toBe("dark");
    await radio(0).trigger("change"); // dark → system（matchMedia=false → light）
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("apicc.theme")).toBe("system");
    expect(i18n.global.locale.value).toBe("zh-CN"); // 主题切换不影响语言
  });

  it("语言按钮与主题分段器带 i18n 悬浮提示（app.language/app.theme）", () => {
    const { i18n } = initI18n();
    i18n.global.locale.value = "zh-CN";
    const wrapper = mount(ThemeLanguageToggle, { global: { plugins: [i18n] } });
    expect(wrapper.find('[data-testid="lang-toggle"]').attributes("title")).toBe("语言");
    expect(wrapper.find('[data-testid="theme-toggle"]').attributes("title")).toBe("主题");
  });
});

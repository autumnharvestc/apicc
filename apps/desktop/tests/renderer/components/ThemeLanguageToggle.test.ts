// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOMWrapper, enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import ThemeLanguageToggle from "../../../src/renderer/src/components/ThemeLanguageToggle.vue";
import { initI18n } from "../../../src/renderer/src/i18n/bridge";
import { savePreference } from "../../../src/renderer/src/theme";

enableAutoUnmount(afterEach);
beforeEach(() => initI18n().setLocale("zh-CN"));
afterEach(() => {
  vi.unstubAllGlobals();
  initI18n().setLocale("zh-CN");
  savePreference("system");
});

const mountToggle = () => mount(ThemeLanguageToggle, {
  attachTo: document.body,
  props: { showApplicationMenu: true },
  global: { plugins: [initI18n().i18n] },
});
const menu = () => new DOMWrapper(document.body).get('[role="menu"]');

describe("ThemeLanguageToggle", () => {
  it("uses one compact locale trigger and restores focus after keyboard selection", async () => {
    const wrapper = mountToggle();
    const trigger = wrapper.get<HTMLButtonElement>('[data-testid="lang-toggle"]');
    expect(trigger.text()).toBe("中");
    trigger.element.focus();
    await trigger.trigger("keydown", { key: "ArrowDown" });
    await flushPromises();
    const chinese = menu().get('[data-locale="zh-CN"]');
    expect(chinese.attributes("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(chinese.element);
    await chinese.trigger("keydown", { key: "ArrowDown" });
    const english = menu().get('[data-locale="en"]');
    expect(document.activeElement).toBe(english.element);
    expect(english.text()).toBe("English");
    await english.trigger("click");
    expect(trigger.text()).toBe("EN");
    expect(document.activeElement).toBe(trigger.element);
    expect(localStorage.getItem("apicc.locale")).toBe("en");
  });

  it("shows the current theme, saves a selection and dismisses on Escape or outside click", async () => {
    const wrapper = mountToggle();
    const trigger = wrapper.get('[data-testid="theme-toggle"]');
    expect(trigger.attributes("aria-label")).toContain("自动");
    await trigger.trigger("click");
    const dark = menu().get('[data-testid="theme-option-dark"]');
    await dark.trigger("click");
    expect(trigger.attributes("aria-label")).toContain("暗色");
    expect(localStorage.getItem("apicc.theme")).toBe("dark");
    await trigger.trigger("click");
    expect(menu().get('[data-testid="theme-option-dark"]').attributes("aria-checked")).toBe("true");
    await menu().trigger("keydown", { key: "Escape" });
    expect(trigger.attributes("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger.element);
    await trigger.trigger("click");
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    await flushPromises();
    expect(trigger.attributes("aria-expanded")).toBe("false");
  });

  it("moves an open menu and focus to the single global trigger after shrinking", async () => {
    const wrapper = mountToggle();
    await wrapper.get('[data-testid="theme-toggle"]').trigger("click");
    vi.stubGlobal("innerWidth", 640);
    window.dispatchEvent(new Event("resize"));
    await flushPromises();
    expect(wrapper.find('[data-testid="theme-toggle"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="lang-toggle"]').exists()).toBe(false);
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    const trigger = wrapper.get('[data-testid="topbar-more"]');
    expect(document.activeElement).toBe(trigger.element);
    await trigger.trigger("click");
    expect(menu().get('[data-locale="en"]').text()).toBe("English");
    expect(menu().get('[data-testid="theme-option-system"]').attributes("aria-checked")).toBe("true");
    await menu().get('[data-testid="application-menu"]').trigger("click");
    expect(wrapper.emitted("application-menu")).toEqual([[]]);
    expect(document.activeElement).toBe(trigger.element);
  });
});

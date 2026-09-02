// i18n 单例薄封装：main.ts 在 app.use(i18n) 前调用 initI18n()，
// 组件经 useLocale() 取到同一实例的 locale 与 setLocale，避免产生第二个 i18n 实例。
import { computed } from "vue";
import { createI18nInstance, type Locale } from "./index";

// 组件经 bridge 引用语言清单，保持 ThemeLanguageToggle 的导入面统一在 bridge 上。
export { LOCALES, type Locale } from "./index";

type I18nInstance = ReturnType<typeof createI18nInstance>;

let instance: I18nInstance | null = null;

export function initI18n(): I18nInstance {
  if (!instance) instance = createI18nInstance();
  return instance;
}

export function useLocale() {
  const current = initI18n();
  return {
    locale: computed(() => current.i18n.global.locale.value as Locale),
    setLocale: current.setLocale,
  };
}

// 非组件上下文（如 App 的 ConfigProvider computed）读取当前语言的统一入口，
// 与 useLocale 同源——都走 bridge 单例，语言切换后随之变化。
export function currentLocale(): Locale {
  const current = initI18n();
  return current.i18n.global.locale.value as Locale;
}

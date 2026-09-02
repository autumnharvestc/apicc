import { createI18n } from "vue-i18n";
import zhCN from "./zh-CN.json";
import en from "./en.json";

export const LOCALES = ["zh-CN", "en"] as const;
export type Locale = (typeof LOCALES)[number];
const STORAGE_KEY = "apicc.locale";

export function initialLocale(): Locale {
  const saved = localStorage.getItem(STORAGE_KEY) as Locale | null;
  if (saved && LOCALES.includes(saved)) return saved;
  return navigator.language.startsWith("zh") ? "zh-CN" : "en";
}

export function createI18nInstance() {
  const i18n = createI18n({ legacy: false, locale: initialLocale(), fallbackLocale: "zh-CN", messages: { "zh-CN": zhCN, en } });
  return {
    i18n,
    setLocale(locale: Locale) {
      i18n.global.locale.value = locale;
      localStorage.setItem(STORAGE_KEY, locale);
    },
  };
}

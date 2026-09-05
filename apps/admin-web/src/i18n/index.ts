/**
 * i18n 工厂（M4 规格 §2 D8）：zh/en 成对，扁平命名空间沿用桌面端模式；组件内零内联文案。
 * 语言偏好持久化 localStorage（键 `apicc.admin.locale`，与裁定③的 token 键同一命名空间），
 * 首访按浏览器语言判定。任务 2 起组件经 useI18n() 消费 app 装配的同一实例。
 */
import { createI18n } from "vue-i18n";
import zhCN from "./zh-CN.json";
import en from "./en.json";

export const LOCALES = ["zh-CN", "en"] as const;
export type Locale = (typeof LOCALES)[number];

const STORAGE_KEY = "apicc.admin.locale";

export function initialLocale(): Locale {
  const saved = localStorage.getItem(STORAGE_KEY) as Locale | null;
  if (saved && LOCALES.includes(saved)) return saved;
  return navigator.language.startsWith("zh") ? "zh-CN" : "en";
}

export function createAdminI18n() {
  const i18n = createI18n({
    legacy: false,
    locale: initialLocale(),
    fallbackLocale: "zh-CN",
    messages: { "zh-CN": zhCN, en },
  });
  return {
    i18n,
    setLocale(locale: Locale) {
      i18n.global.locale.value = locale;
      localStorage.setItem(STORAGE_KEY, locale);
    },
  };
}

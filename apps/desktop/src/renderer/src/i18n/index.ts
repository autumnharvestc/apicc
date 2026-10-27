import { createI18n } from "vue-i18n";
import zhCN from "./zh-CN.json";
import en from "./en.json";

export const LOCALES = ["zh-CN", "en"] as const;
export type Locale = (typeof LOCALES)[number];
const STORAGE_KEY = "apicc.locale";

/** Only known session codes at the end of plain/main IPC errors are presentation keys. */
export function onlineSessionErrorKey(message: string | null | undefined): string | null {
  const code = message?.match(/(?:^|Error: )(online-not-signed-in|online-workspace-not-open|online-session-changed)(?:['"])?$/)?.[1];
  return code ? `online.sessionErrors.${code}` : null;
}

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

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { DesktopOutlined, DownOutlined, EllipsisOutlined } from "@ant-design/icons-vue";
import { LOCALES } from "../i18n/index";
import { useLocale } from "../i18n/bridge";
import { savePreference, themePreference } from "../theme";
import ActionMenu from "./ActionMenu.vue";

const props = defineProps<{ showApplicationMenu?: boolean }>();
const emit = defineEmits<{ "application-menu": [] }>();
const { t } = useI18n();
const { locale, setLocale } = useLocale();
const narrow = ref(false);
const languageMenu = ref<InstanceType<typeof ActionMenu>>();
const themeMenu = ref<InstanceType<typeof ActionMenu>>();
const globalMenu = ref<InstanceType<typeof ActionMenu>>();
const menuToggle = ref<HTMLElement>();
const themeNames = { system: "app.themeAuto", light: "app.themeLight", dark: "app.themeDark" };
const languageItems = computed(() => LOCALES.map((value) => ({
  key: value,
  label: value === "zh-CN" ? "中文" : "English",
  checked: value === locale.value,
  testId: "lang-option",
  locale: value,
})));
const themeItems = computed(() => (["system", "light", "dark"] as const).map((value) => ({
  key: value,
  label: t(themeNames[value]),
  checked: value === themePreference.value,
  testId: `theme-option-${value}`,
})));
const menuItems = computed(() => [
  ...(narrow.value ? [...languageItems.value, ...themeItems.value] : []),
  ...(props.showApplicationMenu ? [{ key: "application-menu", label: t("topbar.applicationMenu"), testId: "application-menu" }] : []),
]);

async function measureWidth() {
  const compact = window.innerWidth < 760;
  if (compact === narrow.value) return;
  const hadFocus = globalMenu.value?.hasFocus() || languageMenu.value?.hasFocus() || themeMenu.value?.hasFocus();
  globalMenu.value?.close(false);
  narrow.value = compact;
  if (hadFocus) {
    await nextTick();
    menuToggle.value?.querySelector<HTMLButtonElement>(narrow.value ? "[data-testid=topbar-more]" : "[data-testid=lang-toggle]")?.focus();
  }
}

function select(key: string) {
  if (key === "zh-CN" || key === "en") setLocale(key);
  else if (key === "system" || key === "light" || key === "dark") savePreference(key);
  else if (key === "application-menu") emit("application-menu");
}

onMounted(() => {
  void measureWidth();
  window.addEventListener("resize", measureWidth);
});
onBeforeUnmount(() => window.removeEventListener("resize", measureWidth));
</script>

<template>
  <div ref="menuToggle" class="toggles">
    <template v-if="!narrow">
      <ActionMenu ref="languageMenu" test-id="lang-toggle" :label="t('app.language')" :items="languageItems" @select="select">
        {{ locale === "zh-CN" ? "中" : "EN" }} <DownOutlined class="arrow" />
      </ActionMenu>
      <ActionMenu ref="themeMenu" test-id="theme-toggle" :label="`${t('app.theme')} · ${t(themeNames[themePreference])}`" :items="themeItems" @select="select">
        <DesktopOutlined v-if="themePreference === 'system'" />
        <span v-else class="theme-symbol" aria-hidden="true">{{ themePreference === "light" ? "☀︎" : "☾" }}</span>
        <DownOutlined class="arrow" />
      </ActionMenu>
    </template>
    <ActionMenu v-if="menuItems.length" ref="globalMenu" test-id="topbar-more" :label="t('topbar.more')" :items="menuItems" @select="select">
      <EllipsisOutlined />
    </ActionMenu>
  </div>
</template>

<style scoped>
.toggles { display: flex; align-items: center; gap: 3px; flex: none; }
.arrow { font-size: 9px; }
.theme-symbol { font-size: 16px; line-height: 1; }
</style>

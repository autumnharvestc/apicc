<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { LOCALES, useLocale } from "../i18n/bridge";
import { applyTheme, loadPreference, savePreference, resolveTheme, type Theme } from "../theme";

const { t } = useI18n();
const { locale, setLocale } = useLocale();
const theme = ref<Theme>(loadPreference());
const resolved = ref<"light" | "dark">("light");

function nextTheme() {
  const order: Theme[] = ["system", "light", "dark"];
  theme.value = order[(order.indexOf(theme.value) + 1) % order.length]!;
  savePreference(theme.value);
  resolved.value = applyTheme(theme.value, window.matchMedia("(prefers-color-scheme: dark)").matches);
}
function nextLocale() {
  const index = LOCALES.indexOf(locale.value as never);
  setLocale(LOCALES[(index + 1) % LOCALES.length]!);
}
onMounted(() => {
  resolved.value = applyTheme(theme.value, window.matchMedia("(prefers-color-scheme: dark)").matches);
});
</script>

<template>
  <div class="toggles">
    <button data-testid="lang-toggle" :title="t('app.language')" @click="nextLocale">{{ locale }}</button>
    <button data-testid="theme-toggle" :title="t('app.theme')" @click="nextTheme">{{ theme }}({{ resolved }})</button>
  </div>
</template>

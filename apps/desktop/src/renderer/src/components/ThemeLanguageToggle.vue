<script setup lang="ts">
import { computed, onMounted } from "vue";
import { Dropdown, Menu, MenuItem, Segmented, Button } from "ant-design-vue";
import { GlobalOutlined } from "@ant-design/icons-vue";
import { useI18n } from "vue-i18n";
import { LOCALES, useLocale } from "../i18n/bridge";
import { applyTheme, savePreference, themePreference, type Theme } from "../theme";

// TopBar 语言/主题切换现代化（计划 2C 任务 2）：
// 语言 = a-dropdown 菜单（地球图标触发，菜单项带 data-locale 供联动测试定位）；
// 主题 = a-segmented 三段选择器，受控绑定 themePreference（模块级响应式 ref，
// savePreference 同步写）→ ConfigProvider algorithm 联动；applyTheme 同步 DOM。
const { t } = useI18n();
const { locale, setLocale } = useLocale();
const langLabel = computed(() => (locale.value === "zh-CN" ? "中文" : "English"));
const themeOptions = computed(() => [
  { label: t("app.themeAuto"), value: "system" },
  { label: t("app.themeLight"), value: "light" },
  { label: t("app.themeDark"), value: "dark" },
]);

function onThemeChange(value: unknown) {
  const preference = value as Theme;
  savePreference(preference);
  applyTheme(preference, window.matchMedia("(prefers-color-scheme: dark)").matches);
}

// 挂载即应用已存偏好：html[data-theme] 驱动 CSS 变量（styles/theme.css 的
// `html[data-theme] body` 规则），启动时不落 DOM 会导致 body 基础样式与暗色变量缺失。
onMounted(() => {
  applyTheme(themePreference.value, window.matchMedia("(prefers-color-scheme: dark)").matches);
});
</script>

<template>
  <div class="toggles">
    <Dropdown :trigger="['click']">
      <Button data-testid="lang-toggle" size="small" :title="t('app.language')">
        <GlobalOutlined />
        {{ langLabel }}
      </Button>
      <template #overlay>
        <Menu @click="({ key }: { key: string | number }) => setLocale(key as never)">
          <MenuItem v-for="l in LOCALES" :key="l" data-testid="lang-option" :data-locale="l">
            <span :style="l === locale ? 'font-weight:600' : ''">{{ l === "zh-CN" ? "中文" : "English" }}</span>
          </MenuItem>
        </Menu>
      </template>
    </Dropdown>
    <Segmented
      data-testid="theme-toggle"
      size="small"
      :title="t('app.theme')"
      :options="themeOptions"
      :value="themePreference"
      @change="onThemeChange"
    />
  </div>
</template>

<style scoped>
.toggles { display: inline-flex; align-items: center; gap: 8px; }
</style>

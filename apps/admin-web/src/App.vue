<template>
  <main class="app-root" data-testid="app-root">
    <h1 class="app-title">{{ t("app.title") }}</h1>
    <!-- 任务 2+ 起装配 router-view / 布局壳（App 为组合根，store 工厂只在装配层调用）。 -->
  </main>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";

const { t } = useI18n();
</script>

<template>
  <!-- 成员管理占位（M4-A 任务 3 裁定 C：路由与导航先接线，任务 4 填充成员/角色管理）。 -->
  <div class="placeholder" data-testid="members-view">
    <p class="placeholder-text">{{ t("ws.placeholder") }}</p>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";

const { t } = useI18n();
</script>

<style scoped>
.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 240px;
}
.placeholder-text {
  color: #999;
}
</style>

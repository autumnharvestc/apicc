<script setup lang="ts">
/**
 * 受保护着陆页（M4-A 任务 2 占位，任务 3 将由布局壳 LayoutView 接管 "/" 路由）：
 * 当前用户 + 登出（服务端吊销 + 本地清 + 回登录页）。session 经路由 props 注入，
 * 组件内零工厂调用。
 */
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { Button as AButton } from "ant-design-vue";
import type { SessionStore } from "../stores/session.js";

const props = defineProps<{ session: SessionStore }>();
const { t } = useI18n();
const router = useRouter();

async function onLogout() {
  await props.session.logout();
  await router.push({ name: "login" });
}
</script>

<template>
  <main class="home" data-testid="home-view">
    <h1 class="home-title">{{ t("app.title") }}</h1>
    <p class="home-user" data-testid="home-user">{{ session.user?.displayName }}</p>
    <a-button data-testid="home-logout" @click="onLogout">{{ t("nav.logout") }}</a-button>
  </main>
</template>

<style scoped>
.home {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
}
</style>

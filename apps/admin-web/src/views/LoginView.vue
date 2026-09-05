<script setup lang="ts">
/**
 * 登录/注册视图（M4-A 任务 2，规格 D5①/D8）：a-card 居中 + 登录/注册 a-tabs。
 * 本地校验先行（裁定 D：登录=必填；注册=用户名 3-32 [a-zA-Z0-9_-]、密码 ≥8、显示名称
 * 1-32 非空白——对齐契约 AdminRegisterInputSchema，client 校验为第二道防线），本地校验
 * 错误走 formError 直呈表单、不经 store.error 通道；api 失败经 session.error 上屏（a-alert）。
 * 登录成功清密码输入并回跳 redirect 原目标或 /（裁定 C）；注册成功不建立登录态（契约语义，
 * desktop 同）：提示后回登录页签，用户名保留可直接登录。组件内零工厂调用：session 经路由
 * props 注入。沿用 desktop OnlineLoginDialog 的触发钩子与 data-testid 约定。
 */
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { Alert as AAlert, Button as AButton, Card as ACard, Input as AInput, Tabs as ATabs } from "ant-design-vue";
import type { SessionStore } from "../stores/session.js";

const ATabPane = ATabs.TabPane;

const props = defineProps<{ session: SessionStore }>();
const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const mode = ref<"login" | "register">("login");
const username = ref("");
const password = ref("");
const displayName = ref("");
const formError = ref("");
const registerOk = ref(false);

/** 注册用户名规则（契约 §3.1：3-32 字符 [a-zA-Z0-9_-]）。 */
const USERNAME_PATTERN = /^[a-zA-Z0-9_-]{3,32}$/;

/** 登录成功回跳目标：仅接受站内相对路径（防开放重定向），否则回 /。 */
function redirectTarget(): string {
  const raw = route.query.redirect;
  const first = Array.isArray(raw) ? raw[0] : raw;
  return typeof first === "string" && first.startsWith("/") && !first.startsWith("//") ? first : "/";
}

async function onLogin() {
  formError.value = "";
  registerOk.value = false;
  if (!username.value.trim()) {
    formError.value = t("login.usernameRequired");
    return;
  }
  if (!password.value) {
    formError.value = t("login.passwordRequired");
    return;
  }
  await props.session.login({ username: username.value.trim(), password: password.value });
  if (props.session.isAuthenticated) {
    password.value = ""; // 登录成功清密码输入，不在表单残留凭据（desktop 同）
    await router.push(redirectTarget());
  }
}

async function onRegister() {
  formError.value = "";
  registerOk.value = false;
  const name = username.value.trim();
  if (!USERNAME_PATTERN.test(name)) {
    formError.value = t("login.usernameInvalid");
    return;
  }
  if (password.value.length < 8) {
    formError.value = t("login.passwordMin");
    return;
  }
  const display = displayName.value.trim();
  if (display.length < 1 || display.length > 32) {
    formError.value = t("login.displayNameInvalid");
    return;
  }
  const ok = await props.session.register({ username: name, password: password.value, displayName: display });
  if (ok) {
    // 注册不建立登录态（契约语义）：提示后回登录页签，用户名保留可直接登录（desktop 同）
    registerOk.value = true;
    mode.value = "login";
  }
}
</script>

<template>
  <div class="login-page">
    <a-card class="login-card" :title="t('app.title')" data-testid="login-card">
      <a-tabs v-model:active-key="mode">
        <a-tab-pane key="login">
          <template #tab><span data-testid="login-tab">{{ t("login.tabLogin") }}</span></template>
          <div class="auth-form" data-testid="login-form">
            <a-input
              v-model:value="username"
              data-testid="login-username"
              :placeholder="t('login.username')"
              @press-enter="onLogin"
            />
            <a-input
              v-model:value="password"
              data-testid="login-password"
              type="password"
              :placeholder="t('login.password')"
              @press-enter="onLogin"
            />
            <a-button type="primary" block :loading="session.submitting" data-testid="login-submit" @click="onLogin">
              {{ t("login.submitLogin") }}
            </a-button>
          </div>
        </a-tab-pane>
        <a-tab-pane key="register">
          <template #tab><span data-testid="register-tab">{{ t("login.tabRegister") }}</span></template>
          <div class="auth-form" data-testid="register-form">
            <a-input v-model:value="username" data-testid="register-username" :placeholder="t('login.username')" />
            <a-input v-model:value="displayName" data-testid="register-display-name" :placeholder="t('login.displayName')" />
            <a-input
              v-model:value="password"
              data-testid="register-password"
              type="password"
              :placeholder="t('login.password')"
              @press-enter="onRegister"
            />
            <a-button type="primary" block :loading="session.submitting" data-testid="register-submit" @click="onRegister">
              {{ t("login.submitRegister") }}
            </a-button>
          </div>
        </a-tab-pane>
      </a-tabs>
      <div v-if="registerOk" class="notice" data-testid="register-ok">{{ t("login.registerOk") }}</div>
      <!-- 本地校验错误（表单直呈，不经 error 通道）与 api 失败（store.error）分开呈现（desktop 同） -->
      <div v-if="formError" class="form-error" data-testid="login-form-error">{{ formError }}</div>
      <a-alert
        v-if="session.error"
        class="api-error"
        type="error"
        show-icon
        :message="t('login.failed')"
        :description="session.error"
        data-testid="login-api-error"
      />
    </a-card>
  </div>
</template>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
}
.login-card {
  width: 360px;
}
.auth-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.notice {
  margin-top: 12px;
  color: #389e0d;
  font-size: 12px;
}
.form-error {
  margin-top: 12px;
  color: #cf1322;
  font-size: 12px;
}
.api-error {
  margin-top: 12px;
  font-size: 12px;
}
</style>

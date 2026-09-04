<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  Alert as AAlert,
  Button as AButton,
  Input as AInput,
  Modal as AModal,
  Select as ASelect,
  Tabs as ATabs,
  Typography as ATypography,
} from "ant-design-vue";
import { OnlineBaseUrlSchema } from "../../../shared/online/contract.js";
import type { useWorkspaceStore } from "../stores/workspace.js";
import type { createOnlineStore } from "../stores/online.js";

const ATabPane = ATabs.TabPane;
const ATypographyText = ATypography.Text;

/**
 * 在线登录与服务器配置对话框（M3-B 任务 2）：
 * - 服务器档案区：下拉切换既有档案（切换即经 store 触发 resume 恢复链路，裁定 A）+
 *   url/昵称输入 + 保存（新增/同 baseUrl 改昵称）/删除；持久化由 store 负责
 *   （renderer localStorage，裁定 C，与 theme/i18n 偏好同先例）。
 * - 认证区（未登录时）：登录/注册双模式 a-tabs（简报允许「tab 或链接切换」，取 tab——
 *   既有 RequestEditor/ResponseViewer 页签先例，触发钩子经 #tab slot 保留）。
 * - 已登录：当前用户 + 激活服务器 + 退出登录（登出不清档案，裁定 C）+ 工作区列表
 *   （M3-B 任务 3）：拉取「我参与的工作区」，点「打开」→ 先关本地目录工作区（裁定 E
 *   模式互斥的自动侧）→ 打开在线工作区并收起对话框。
 * **组件内零工厂调用**：store 实例经 props 注入（App 组合根装配）。表单校验先行
 * （url 形态按契约 OnlineBaseUrlSchema、用户名密码必填、注册密码 ≥8 对齐契约），
 * api 失败经 store.error 上屏（plan 任务 2 步骤 1⑤）；组件自身 async 动作不重抛。
 */
const props = defineProps<{
  online: ReturnType<typeof createOnlineStore>;
  /** 本地工作区会话（任务 3 裁定 E）：打开在线工作区前先 reset 关闭本地上下文。 */
  workspace: ReturnType<typeof useWorkspaceStore>;
}>();
const { t } = useI18n();

const mode = ref<"login" | "register">("login");
const username = ref("");
const password = ref("");
const displayName = ref("");
const serverUrl = ref("");
const serverName = ref("");
const formError = ref("");
const registerOk = ref(false);

const serverOptions = computed(() =>
  props.online.profiles.map((p) => ({ label: p.name || p.baseUrl, value: p.baseUrl })),
);

// 每次打开对话框重置本地表单（store 状态保留）；输入区回填当前激活档案便于直接改昵称保存。
// 已登录时顺带刷新工作区列表（打开在线工作区的入口数据）。
watch(
  () => props.online.dialogOpen,
  (open) => {
    if (!open) return;
    formError.value = "";
    registerOk.value = false;
    mode.value = "login";
    serverUrl.value = props.online.activeBaseUrl ?? "";
    serverName.value = props.online.profiles.find((p) => p.baseUrl === props.online.activeBaseUrl)?.name ?? "";
    if (props.online.loggedIn) void props.online.refreshWorkspaces();
  },
  { immediate: true },
);

function onSelectServer(baseUrl: string) {
  formError.value = "";
  if (!baseUrl) return;
  props.online.setActive(baseUrl);
  serverUrl.value = baseUrl;
  serverName.value = props.online.profiles.find((p) => p.baseUrl === baseUrl)?.name ?? "";
}

function onSaveServer() {
  formError.value = "";
  registerOk.value = false;
  const url = serverUrl.value.trim();
  if (!url) {
    formError.value = t("online.serverRequired");
    return;
  }
  if (!OnlineBaseUrlSchema.safeParse(url).success) {
    formError.value = t("online.serverUrlInvalid");
    return;
  }
  props.online.addProfile(url, serverName.value);
}

function onRemoveServer() {
  formError.value = "";
  registerOk.value = false;
  const url = serverUrl.value.trim();
  if (!url) {
    formError.value = t("online.serverRequired");
    return;
  }
  if (!props.online.profiles.some((p) => p.baseUrl === url)) {
    formError.value = t("online.serverMissing");
    return;
  }
  props.online.removeProfile(url);
}

async function onLogin() {
  formError.value = "";
  registerOk.value = false;
  if (!props.online.activeBaseUrl) {
    formError.value = t("online.serverRequired");
    return;
  }
  if (!username.value.trim()) {
    formError.value = t("online.usernameRequired");
    return;
  }
  if (!password.value) {
    formError.value = t("online.passwordRequired");
    return;
  }
  await props.online.login(username.value.trim(), password.value);
  // 登录成功（对话框切已登录区）：清密码输入，不在表单残留凭据；失败保留便于改密重试
  if (props.online.loggedIn) password.value = "";
}

async function onRegister() {
  formError.value = "";
  registerOk.value = false;
  if (!props.online.activeBaseUrl) {
    formError.value = t("online.serverRequired");
    return;
  }
  const name = username.value.trim();
  if (!name) {
    formError.value = t("online.usernameRequired");
    return;
  }
  if (password.value.length < 8) {
    formError.value = t("online.passwordMin");
    return;
  }
  if (!displayName.value.trim()) {
    formError.value = t("online.displayNameRequired");
    return;
  }
  const ok = await props.online.register({ username: name, password: password.value, displayName: displayName.value.trim() });
  if (ok) {
    // 注册不建立登录态（契约语义）：提示后回登录页签，用户名保留可直接登录
    registerOk.value = true;
    mode.value = "login";
  }
}

/**
 * 打开在线工作区（任务 3，裁定 E 模式互斥的自动侧）：先关本地目录工作区会话再开在线；
 * 打开成功（store.activeWorkspace 命中）即收起对话框，失败错误经 store.error 上屏留在对话框。
 */
async function onOpenWorkspace(workspaceId: string) {
  const ws = props.online.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return;
  formError.value = "";
  if (props.workspace.opened) props.workspace.reset();
  await props.online.openWorkspace(ws);
  if (props.online.activeWorkspace?.id === ws.id) props.online.dialogOpen = false;
}
</script>

<template>
  <a-modal
    v-if="online.dialogOpen"
    :open="online.dialogOpen"
    :title="t('online.title')"
    :width="460"
    data-testid="online-dialog"
    @cancel="online.dialogOpen = false"
  >
    <div class="online-body" data-testid="online-body">
      <!-- 服务器档案区（增删切换） -->
      <div class="section">
        <div class="section-title">{{ t("online.serverSection") }}</div>
        <label class="field">
          <span class="field-label">{{ t("online.savedServers") }}</span>
          <a-select
            class="control"
            :value="online.activeBaseUrl ?? undefined"
            :options="serverOptions"
            :placeholder="t('online.serverNone')"
            data-testid="online-server-select"
            @update:value="(v) => onSelectServer(v as string)"
          />
        </label>
        <label class="field">
          <span class="field-label">{{ t("online.serverUrl") }}</span>
          <a-input
            v-model:value="serverUrl"
            class="control"
            data-testid="online-server-url"
            :placeholder="t('online.serverUrlPlaceholder')"
          />
        </label>
        <label class="field">
          <span class="field-label">{{ t("online.serverName") }}</span>
          <a-input
            v-model:value="serverName"
            class="control"
            data-testid="online-server-name"
            :placeholder="t('online.serverNamePlaceholder')"
          />
        </label>
        <div class="actions">
          <a-button data-testid="online-server-save" @click="onSaveServer">{{ t("online.serverSave") }}</a-button>
          <a-button danger data-testid="online-server-delete" @click="onRemoveServer">{{ t("online.serverDelete") }}</a-button>
        </div>
      </div>

      <!-- 已登录：用户 + 退出登录 + 工作区列表（任务 3 打开在线工作区入口） -->
      <div v-if="online.loggedIn" class="section" data-testid="online-signed-in">
        <div class="signed-in-row">
          <a-typography-text data-testid="online-user">
            {{ t("online.loggedInAs", { name: online.user?.displayName ?? "", server: online.activeName }) }}
          </a-typography-text>
          <a-button danger data-testid="online-logout" @click="online.logout()">{{ t("online.logout") }}</a-button>
        </div>
        <!-- 工作区列表：刷新于对话框打开时；点「打开」→ 先关本地工作区再开在线 -->
        <div class="section-title">{{ t("online.wsSection") }}</div>
        <div class="ws-list" data-testid="online-ws-list">
          <div v-if="online.workspaces.length === 0" class="ws-empty">{{ t("online.wsListEmpty") }}</div>
          <div v-for="ws in online.workspaces" :key="ws.id" class="ws-row" :data-ws-id="ws.id">
            <span class="ws-name">{{ ws.name }}</span>
            <span class="ws-role">{{ ws.myRole }}</span>
            <a-button
              size="small"
              type="primary"
              data-testid="online-ws-open"
              :disabled="online.activeWorkspace?.id === ws.id"
              @click="onOpenWorkspace(ws.id)"
            >
              {{ t("online.wsOpen") }}
            </a-button>
          </div>
        </div>
      </div>

      <!-- 未登录：登录 / 注册双模式 -->
      <div v-else class="section">
        <a-tabs v-model:active-key="mode">
          <a-tab-pane key="login">
            <template #tab><span data-testid="online-tab-login">{{ t("online.loginTab") }}</span></template>
            <div class="auth-form" data-testid="online-login-form">
              <a-input v-model:value="username" data-testid="online-username" :placeholder="t('online.username')" />
              <a-input
                v-model:value="password"
                data-testid="online-password"
                type="password"
                :placeholder="t('online.password')"
              />
              <a-button
                type="primary"
                block
                :loading="online.submitting"
                data-testid="online-login-submit"
                @click="onLogin"
              >
                {{ t("online.login") }}
              </a-button>
            </div>
          </a-tab-pane>
          <a-tab-pane key="register">
            <template #tab><span data-testid="online-tab-register">{{ t("online.registerTab") }}</span></template>
            <div class="auth-form" data-testid="online-register-form">
              <a-input v-model:value="username" data-testid="online-reg-username" :placeholder="t('online.username')" />
              <a-input
                v-model:value="password"
                data-testid="online-reg-password"
                type="password"
                :placeholder="t('online.password')"
              />
              <a-input
                v-model:value="displayName"
                data-testid="online-display-name"
                :placeholder="t('online.displayName')"
              />
              <a-button
                type="primary"
                block
                :loading="online.submitting"
                data-testid="online-register-submit"
                @click="onRegister"
              >
                {{ t("online.register") }}
              </a-button>
            </div>
          </a-tab-pane>
        </a-tabs>
        <div v-if="registerOk" class="notice" data-testid="online-register-ok">{{ t("online.registerOk") }}</div>
      </div>

      <!-- 错误上屏：本地表单校验（form-error）与 api 失败（store.error）分开呈现 -->
      <div v-if="formError" class="error" data-testid="online-form-error">{{ formError }}</div>
      <a-alert
        v-if="online.error"
        class="api-error"
        type="error"
        show-icon
        :message="online.error"
        data-testid="online-error"
      />
    </div>
    <template #footer>
      <a-button data-testid="online-close" @click="online.dialogOpen = false">{{ t("common.close") }}</a-button>
    </template>
  </a-modal>
</template>

<style scoped>
.online-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.signed-in-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.section-title {
  font-weight: 600;
  font-size: 13px;
}
.ws-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 180px;
  overflow: auto;
}
.ws-empty {
  color: var(--text-muted, #666);
  font-size: 12px;
}
.ws-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ws-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
.ws-role {
  color: var(--text-muted, #666);
  font-size: 11px;
}
.field {
  display: flex;
  align-items: center;
  gap: 8px;
}
.field-label {
  min-width: 72px;
  color: var(--text-muted, #666);
  font-size: 12px;
}
.control {
  flex: 1;
}
.actions {
  display: flex;
  gap: 8px;
}
.auth-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.notice {
  color: var(--ok, #389e0d);
  font-size: 12px;
}
.error {
  color: var(--fail, #cf1322);
  font-size: 12px;
}
.api-error {
  font-size: 12px;
}
</style>

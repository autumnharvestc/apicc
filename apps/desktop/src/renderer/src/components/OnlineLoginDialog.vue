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
import type { createOnlineStore } from "../stores/online.js";
import type { createTabsStore, ProjectTab, WorkspaceRef } from "../stores/tabs.js";
import ConfirmDialog from "./ConfirmDialog.vue";

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
 *   （M3-B 任务 3）：拉取「我参与的工作区」，点「打开」→ 打开在线工作区并收起对话框
 *   （计划 C 任务 2：裁定 E 互斥退役——不再先关本地工作区，本地 1 + 在线 N 并存驻留）。
 * **组件内零工厂调用**：store 实例经 props 注入（App 组合根装配）。表单校验先行
 * （url 形态按契约 OnlineBaseUrlSchema、用户名密码必填、注册密码 ≥8 对齐契约），
 * api 失败经 store.error 上屏（plan 任务 2 步骤 1⑤）；组件自身 async 动作不重抛。
 * 终审 Important 2：退出登录前过草稿确认——logout 清全部在线会话（渲染层+main 全表），
 * 指向在线工作区的签若还有编辑缓冲草稿将一次性静默丢弃；故先聚合全部在线签的草稿态
 * （tabs.projectHasDrafts），有草稿 → 确认弹窗（列出有草稿的签，复用 TopBar 退出在线
 * 确认形态）→ 确认后逐工作区 tabs.closeWorkspaceTabs（签表同步 + 逐签驱逐会话）再登出；
 * 无草稿直接登出（现状保持）。
 */
const props = defineProps<{
  online: ReturnType<typeof createOnlineStore>;
  apicc: import("../../../shared/types.js").ApiccApi;
  /** 签 store（终审 Important 2）：在线签草稿聚合 + 登出前逐工作区关签同步签表。 */
  tabs: ReturnType<typeof createTabsStore>;
}>();
const { t } = useI18n();

const mode = ref<"login" | "register">("login");
// 注册开关（服务端 auth/config）：关闭时隐藏注册页签（独立部署/非注册模式不显示不可用的功能）
const allowRegistration = ref(false);
void fetchAllowRegistration();
async function fetchAllowRegistration() {
  try {
    allowRegistration.value = (await props.apicc.authConfig()).allowRegistration;
  } catch {
    allowRegistration.value = false; // 探测失败按关闭处理
  }
}
const username = ref("");
const password = ref("");
const displayName = ref("");
const formError = ref("");
const registerOk = ref(false);

// 每次打开对话框重置本地表单（store 状态保留）；目标服务器 = 当前激活档案
// （档案管理唯一入口在主页「管理连接」面板——轨三收口）。
// 已登录时顺带刷新工作区列表（打开在线工作区的入口数据）。
watch(
  () => props.online.dialogOpen,
  (open) => {
    if (!open) return;
    formError.value = "";
    registerOk.value = false;
    mode.value = "login";
    if (props.online.loggedIn) void props.online.refreshWorkspaces();
  },
  { immediate: true },
);

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
 * 打开在线工作区（任务 3；计划 C 任务 2 互斥退役）：直接开在线工作区，本地工作区原样
 * 驻留（并存）；打开成功（store.activeWorkspace 命中）即收起对话框，失败错误经
 * store.error 上屏留在对话框。
 */
async function onOpenWorkspace(workspaceId: string) {
  const ws = props.online.workspaces.find((w) => w.id === workspaceId);
  if (!ws) return;
  formError.value = "";
  await props.online.openWorkspace(ws);
  if (props.online.activeWorkspace?.id === ws.id) props.online.dialogOpen = false;
}

// —— 退出登录前草稿确认（终审 Important 2）——
// logout 一次清掉全部在线会话（渲染层+main 全表）：各工作区编辑缓冲草稿一次性丢弃、
// 指向在线工作区的签留在签栏呈正常态（点击才报错）。故登出前聚合在线签草稿态：
// 有草稿先确认（列出有草稿的签，TopBar 退出在线确认同形态），确认后逐工作区关签
// （closeWorkspaceTabs 逐签驱逐项目会话并同步签表）再 logout；无草稿直接登出。
const logoutConfirmOpen = ref(false);
/** 打开确认时快照有草稿的在线签（确认期间签表变化不漂移展示）。 */
const logoutDraftTabs = ref<ProjectTab[]>([]);

/** 在线签按工作区引用去重（logout 牵连全部驻留工作区，不止有草稿的那些）。 */
function onlineWorkspaceRefs(): WorkspaceRef[] {
  const refs = new Map<string, WorkspaceRef>();
  for (const tab of props.tabs.tabs) {
    if (tab.workspaceRef.kind === "online") refs.set(tab.workspaceRef.workspaceId, tab.workspaceRef);
  }
  return [...refs.values()];
}

function requestLogout() {
  logoutDraftTabs.value = props.tabs.tabs.filter(
    (tab) => tab.workspaceRef.kind === "online" && props.tabs.projectHasDrafts(tab.tabId),
  );
  if (logoutDraftTabs.value.length === 0) {
    void doLogout();
    return;
  }
  logoutConfirmOpen.value = true;
}

async function doLogout() {
  logoutConfirmOpen.value = false;
  // 逐工作区关签（签级确认不拦——登出确认已覆盖；驱逐各项目会话），再清全部在线会话
  for (const ref of onlineWorkspaceRefs()) await props.tabs.closeWorkspaceTabs(ref);
  await props.online.logout();
}

function onLogoutConfirm() {
  void doLogout();
}

function onLogoutCancel() {
  logoutConfirmOpen.value = false;
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
      <!-- 服务器档案区已收口至主页「管理连接」面板（轨三）：目标服务器 = 当前激活档案 -->
      <!-- 已登录：用户 + 退出登录 + 工作区列表（任务 3 打开在线工作区入口） -->
      <div v-if="online.loggedIn" class="section" data-testid="online-signed-in">
        <div class="signed-in-row">
          <a-typography-text data-testid="online-user">
            {{ t("online.loggedInAs", { name: online.user?.displayName ?? "", server: online.activeName }) }}
          </a-typography-text>
          <a-button danger data-testid="online-logout" @click="requestLogout">{{ t("online.logout") }}</a-button>
        </div>
        <!-- 工作区列表：刷新于对话框打开时；点「打开」→ 开在线（本地原样驻留，并存） -->
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
          <a-tab-pane v-if="allowRegistration" key="register">
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
  <!-- 退出登录草稿确认（终审 Important 2）：a-modal 传送门渲染于 body，列出有草稿的在线签 -->
  <ConfirmDialog
    :open="logoutConfirmOpen"
    :title="t('online.logout')"
    @confirm="onLogoutConfirm"
    @cancel="onLogoutCancel"
  >
    <div data-testid="online-logout-impact">
      <p>{{ t("online.logoutConfirmDesc", { count: logoutDraftTabs.length }) }}</p>
      <ul class="logout-impact-list">
        <li
          v-for="(tab, index) in logoutDraftTabs"
          :key="tab.tabId"
          :data-testid="`online-logout-tab-${index}`"
        >
          {{ tab.workspaceRef.kind === "online" ? tab.workspaceRef.name : "" }} / {{ tab.projectName }}
        </li>
      </ul>
    </div>
  </ConfirmDialog>
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
/* 登出确认的受影响签清单（ConfirmDialog 默认插槽内容，形态同 TopBar 退出在线确认） */
.logout-impact-list {
  margin: 4px 0 0;
  padding-inline-start: 18px;
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

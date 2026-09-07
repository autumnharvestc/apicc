<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { Alert as AAlert, Button as AButton, Input as AInput, Tag as ATag } from "ant-design-vue";
import { OnlineBaseUrlSchema } from "../../../shared/online/contract.js";
import type { createOnlineStore } from "../stores/online.js";

/**
 * 连接管理面板（主页右栏形态；轨三收口）：服务器档案的增删改+登录唯一管理入口——
 * - 连接列表行：色块头像（按地址哈希确定性生成）+ 昵称 + 地址 + 登录状态；
 *   行内操作：登录（激活档案并打开登录对话框）/ 浏览（激活并切服务器视图）/ 编辑 / 删除。
 * - 新增/编辑表单：地址（OnlineBaseUrlSchema 校验）+ 昵称；同地址保存=改昵称（store 语义）。
 * **档案管理唯一入口**：登录对话框（OnlineLoginDialog）不再提供档案增删改（轨三收口裁定）。
 */
const props = defineProps<{
  online: ReturnType<typeof createOnlineStore>;
}>();
const { t } = useI18n();

const emit = defineEmits<{ (e: "browse", baseUrl: string): void }>();

const editing = ref(false);
const editUrl = ref("");
const editName = ref("");
const editError = ref("");

/** 头像色：按地址做确定性哈希 → 固定色板取色（纯 CSS 零素材，素材许可合规约束）。 */
const AVATAR_COLORS = ["#5b8ff9", "#5ad8a6", "#f6bd16", "#e8684a", "#6dc8ec", "#9270ca", "#ff9d4d"];
function avatarColor(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function startAdd() {
  editing.value = true;
  editUrl.value = "";
  editName.value = "";
  editError.value = "";
}

function startEdit(baseUrl: string, name: string) {
  editing.value = true;
  editUrl.value = baseUrl;
  editName.value = name;
  editError.value = "";
}

function cancelEdit() {
  editing.value = false;
  editError.value = "";
}

function saveConnection() {
  editError.value = "";
  const url = editUrl.value.trim();
  if (!url) {
    editError.value = t("online.serverRequired");
    return;
  }
  if (!OnlineBaseUrlSchema.safeParse(url).success) {
    editError.value = t("online.serverUrlInvalid");
    return;
  }
  props.online.addProfile(url, editName.value);
  editing.value = false;
}

function removeConnection(baseUrl: string) {
  editError.value = "";
  props.online.removeProfile(baseUrl);
}

/** 登录：激活该档案（resume 恢复链路由 store 负责）并打开登录对话框。 */
function loginConnection(baseUrl: string) {
  props.online.setActive(baseUrl);
  props.online.dialogOpen = true;
}

/** 浏览：切到该服务器视图；仅当目标非当前激活档案才走 setActive（setActive 会清登录态，
 * 对已激活且已登录的档案重复调用反而登出）；已登录时顺带刷新工作区清单。 */
function browseConnection(baseUrl: string) {
  if (props.online.activeBaseUrl !== baseUrl) props.online.setActive(baseUrl);
  if (props.online.loggedIn) void props.online.refreshWorkspaces().catch(() => undefined);
  emit("browse", baseUrl);
}
</script>

<template>
  <div class="conn-panel" data-testid="connections-panel">
    <div class="panel-head">
      <span class="panel-title">{{ t("home.connectionsTitle") }}</span>
      <a-button size="small" type="primary" data-testid="connections-add" @click="startAdd">
        {{ t("home.connectionAdd") }}
      </a-button>
    </div>

    <!-- 新增/编辑表单 -->
    <div v-if="editing" class="conn-form" data-testid="connections-form">
      <label class="field">
        <span class="field-label">{{ t("home.connectionUrl") }}</span>
        <a-input v-model:value="editUrl" data-testid="connections-url" :placeholder="t('online.serverUrlPlaceholder')" />
      </label>
      <label class="field">
        <span class="field-label">{{ t("home.connectionName") }}</span>
        <a-input v-model:value="editName" data-testid="connections-name" :placeholder="t('online.serverNamePlaceholder')" />
      </label>
      <div class="actions">
        <a-button type="primary" data-testid="connections-save" @click="saveConnection">{{ t("home.connectionSave") }}</a-button>
        <a-button data-testid="connections-cancel" @click="cancelEdit">{{ t("common.cancel") }}</a-button>
      </div>
      <div v-if="editError" class="error" data-testid="connections-form-error">{{ editError }}</div>
    </div>

    <!-- 连接列表 -->
    <div v-if="online.profiles.length === 0 && !editing" class="empty" data-testid="connections-empty">
      {{ t("home.connectionEmpty") }}
    </div>
    <div class="conn-list">
      <div v-for="p in online.profiles" :key="p.baseUrl" class="conn-row" :data-testid="`connection-${p.baseUrl}`">
        <span class="avatar" :style="{ background: avatarColor(p.baseUrl) }">{{ (p.name || p.baseUrl).slice(0, 1).toUpperCase() }}</span>
        <span class="conn-name">{{ p.name || p.baseUrl }}</span>
        <span class="conn-url">{{ p.baseUrl }}</span>
        <a-tag v-if="online.loggedIn && online.activeBaseUrl === p.baseUrl" color="blue" data-testid="connection-logged-in">
          {{ t("home.loggedInAs") }}{{ online.user ? ` · ${online.user.displayName}` : "" }}
        </a-tag>
        <span class="spacer"></span>
        <a-button size="small" type="text" data-testid="connection-login" @click="loginConnection(p.baseUrl)">
          {{ online.loggedIn && online.activeBaseUrl === p.baseUrl ? t("home.connectionBrowse") : t("home.connectionLogin") }}
        </a-button>
        <a-button size="small" type="text" data-testid="connection-browse" @click="browseConnection(p.baseUrl)">
          {{ t("home.connectionBrowse") }}
        </a-button>
        <a-button size="small" type="text" data-testid="connection-edit" @click="startEdit(p.baseUrl, p.name)">
          {{ t("home.connectionEdit") }}
        </a-button>
        <a-button size="small" type="text" danger data-testid="connection-delete" @click="removeConnection(p.baseUrl)">
          {{ t("home.connectionDelete") }}
        </a-button>
      </div>
    </div>

    <a-alert
      v-if="online.error"
      class="api-error"
      type="error"
      show-icon
      :message="online.error"
      data-testid="connections-error"
    />
  </div>
</template>

<style scoped>
.conn-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
}
.panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.panel-title {
  font-weight: 600;
  font-size: 14px;
}
.conn-form {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.field {
  display: flex;
  align-items: center;
  gap: 8px;
}
.field-label {
  min-width: 72px;
  color: var(--text-muted);
  font-size: 12px;
}
.actions {
  display: flex;
  gap: 8px;
}
.error {
  color: var(--fail, #cf1322);
  font-size: 12px;
}
.conn-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.conn-row {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 10px;
  background: var(--bg);
}
.avatar {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.conn-name {
  font-weight: 600;
}
.conn-url {
  color: var(--text-muted);
  font-size: 12px;
  word-break: break-all;
}
.spacer {
  flex: 1;
}
.empty {
  color: var(--text-muted);
  font-size: 12px;
}
.api-error {
  font-size: 12px;
}
</style>

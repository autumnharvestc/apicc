<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Alert as AAlert, Button as AButton, Input as AInput, Select as ASelect, Tabs as ATabs, Checkbox as ACheckbox, Tag as ATag, Typography as ATypography } from "ant-design-vue";
import type { AuthSpec, BodyContent, HttpMethod, KeyValuePair } from "@apicc/core";
import type { createOnlineStore } from "../stores/online.js";
import EmptyState from "./EmptyState.vue";

const ATabPane = ATabs.TabPane;
const ATextarea = AInput.TextArea;
const ATypographyText = ATypography.Text;

/**
 * 在线工作区主编辑面板（M3-B 任务 3，简报裁定 B）：
 * - 仅 api.yaml 级编辑：表单字段与本地 RequestEditor 同构（方法/URL/参数/请求头/认证/请求体），
 *   保存 = 序列化回 YAML 文本 putFile（baseVersion=当前 version，store.saveApi 内聚）。
 * - VIEWER 只读态（工作区或项目 ACL VIEWER/NONE）：输入禁用 + 无保存钮 + 只读徽标。
 * - 坏数据（schema 校验失败）：problems 展示原文，不崩、无表单、不可推送。
 * - 只读配置叶（file）：原文浏览（工作流/环境/项目/集合配置等）。
 * - 调试/运行边界：在线工作区不提供调试/运行入口（空态给「先拉取到本地」引导文案）。
 * store 经 props 注入（组合根一次装配；组件内零工厂调用）。
 */
const props = defineProps<{
  online: ReturnType<typeof createOnlineStore>;
}>();
const { t } = useI18n();

const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const METHOD_OPTIONS = METHODS.map((m) => ({ label: m, value: m }));
const AUTH_KIND_OPTIONS = ["none", "bearer", "basic", "apikey"].map((v) => ({ label: v, value: v }));
const AUTH_PLACEMENT_OPTIONS = ["header", "query"].map((v) => ({ label: v, value: v }));
const BODY_KIND_OPTIONS = ["none", "json", "xml", "raw", "graphql", "form"].map((v) => ({ label: v, value: v }));
const TABS = ["params", "headers", "auth", "body"] as const;
type Tab = (typeof TABS)[number];
const activeTab = ref<Tab>("params");

const api = computed(() => props.online.editorApi);
const writable = computed(() => props.online.canEdit(props.online.editorPath));

/** 保存成功提示（推送成功短暂上屏；冲突/失败不提示——分别走冲突对话框与错误通道）。 */
const savedTip = ref(false);
let savedTimer: ReturnType<typeof setTimeout> | undefined;

async function onSave() {
  await props.online.saveApi();
  if (props.online.conflict === null && props.online.error === null && props.online.editorDirty === false) {
    savedTip.value = true;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => {
      savedTip.value = false;
    }, 2000);
  }
}

function addRow(list: KeyValuePair[]) {
  list.push({ key: "", value: "", enabled: true });
}

// —— 认证：none 与三种类型互转（strict schema：切类型重建对象，不残留旧键；只读态不可达） ——
type AuthKind = AuthSpec["type"] | "none";
const authKind = computed<AuthKind>({
  get: () => api.value?.auth?.type ?? "none",
  set: (kind) => {
    const target = api.value;
    if (!target) return;
    if (kind === "none") {
      target.auth = undefined;
      return;
    }
    const base = { type: kind, placement: "header" } as const;
    target.auth =
      kind === "bearer" ? { ...base, token: "" }
      : kind === "basic" ? { ...base, username: "", password: "" }
      : { ...base, key: "", value: "" };
  },
});

// —— 请求体：none 与五种体类型互转（同上） ——
type BodyKind = BodyContent["kind"] | "none";
const bodyKind = computed<BodyKind>({
  get: () => api.value?.body?.kind ?? "none",
  set: (kind) => {
    const target = api.value;
    if (!target) return;
    if (kind === "none") {
      target.body = undefined;
      return;
    }
    const prevContent = target.body?.content ?? "";
    target.body =
      kind === "form" ? { kind: "form", content: prevContent, form: target.body?.form ?? [] } : { kind, content: prevContent };
  },
});
</script>

<template>
  <!-- 空态：未选中任何文件 → 引导文案（含调试/运行边界说明） -->
  <div v-if="!online.editorPath" class="guide-wrap">
    <EmptyState :text="t('online.editorEmpty')" />
    <p class="guide" data-testid="online-guide">{{ t("online.pullGuide") }}</p>
  </div>

  <!-- 只读配置叶：原文浏览 -->
  <section v-else-if="online.editorKind === 'file'" class="editor" data-testid="online-file-view">
    <div class="name-row">
      <a-typography-text strong data-testid="online-file-name">{{ online.editorPath }}</a-typography-text>
      <a-tag data-testid="online-readonly-badge">{{ t("online.readonlyBadge") }}</a-tag>
    </div>
    <pre class="raw" data-testid="online-raw">{{ online.editorRaw }}</pre>
  </section>

  <!-- api.yaml：坏数据 → problems + 原文；好数据 → 表单（只读态禁用） -->
  <section v-else class="editor" data-testid="online-api-editor">
    <template v-if="online.editorProblems.length">
      <a-alert type="error" show-icon :message="t('online.problemsTitle')" data-testid="online-problems">
        <template #description>
          <ul class="problems">
            <li v-for="(problem, index) in online.editorProblems" :key="index">{{ problem }}</li>
          </ul>
        </template>
      </a-alert>
      <pre class="raw" data-testid="online-raw">{{ online.editorRaw }}</pre>
    </template>

    <template v-else-if="api">
      <div class="name-row">
        <a-input
          v-model:value="api.name"
          class="name-input"
          data-testid="online-editor-name"
          :disabled="!writable"
        />
        <span v-if="online.editorDirty" class="dirty" :title="t('wf.unsaved')">●</span>
        <a-tag v-if="!writable" data-testid="online-readonly-badge">{{ t("online.readonlyBadge") }}</a-tag>
        <span v-if="savedTip" class="saved-tip" data-testid="online-saved-tip">{{ t("online.savedTip") }}</span>
      </div>
      <div class="top-row">
        <a-select
          v-model:value="api.method"
          class="method-select"
          data-testid="online-editor-method"
          :options="METHOD_OPTIONS"
          :disabled="!writable"
        />
        <a-input
          v-model:value="api.url"
          class="url"
          data-testid="online-editor-url"
          :placeholder="t('editor.url')"
          :disabled="!writable"
        />
        <a-button
          v-if="writable"
          type="primary"
          data-testid="online-save-btn"
          :disabled="online.saving"
          @click="onSave"
        >
          {{ online.saving ? t("online.saving") : t("online.save") }}
        </a-button>
      </div>
      <a-typography-text class="path-line" type="secondary" data-testid="online-editor-path">
        {{ online.editorPath }}
      </a-typography-text>

      <a-tabs v-model:active-key="activeTab">
        <a-tab-pane key="params">
          <template #tab><span data-testid="online-tab-params">{{ t("editor.params") }}</span></template>
          <div class="panel">
            <div v-for="(row, index) in api.query" :key="index" class="kv-row">
              <a-input v-model:value="row.key" data-testid="kv-key" placeholder="key" :disabled="!writable" />
              <a-input v-model:value="row.value" data-testid="kv-value" placeholder="value" :disabled="!writable" />
              <a-checkbox v-model:checked="row.enabled" data-testid="kv-enabled" :disabled="!writable" />
              <a-button v-if="writable" danger type="text" size="small" data-testid="kv-remove" @click="api.query.splice(index, 1)">×</a-button>
            </div>
            <a-button v-if="writable" class="add" data-testid="add-param" @click="addRow(api.query)">
              {{ t("editor.addRow") }}
            </a-button>
          </div>
        </a-tab-pane>
        <a-tab-pane key="headers">
          <template #tab><span data-testid="online-tab-headers">{{ t("editor.headers") }}</span></template>
          <div class="panel">
            <div v-for="(row, index) in api.headers" :key="index" class="kv-row">
              <a-input v-model:value="row.key" data-testid="kv-key" placeholder="key" :disabled="!writable" />
              <a-input v-model:value="row.value" data-testid="kv-value" placeholder="value" :disabled="!writable" />
              <a-checkbox v-model:checked="row.enabled" data-testid="kv-enabled" :disabled="!writable" />
              <a-button v-if="writable" danger type="text" size="small" data-testid="kv-remove" @click="api.headers.splice(index, 1)">×</a-button>
            </div>
            <a-button v-if="writable" class="add" data-testid="add-header" @click="addRow(api.headers)">
              {{ t("editor.addRow") }}
            </a-button>
          </div>
        </a-tab-pane>

        <a-tab-pane key="auth">
          <template #tab><span data-testid="online-tab-auth">{{ t("editor.auth") }}</span></template>
          <div class="panel">
            <div class="field-row">
              <label>type</label>
              <a-select
                v-model:value="authKind"
                class="field-input"
                data-testid="auth-type"
                :options="AUTH_KIND_OPTIONS"
                :disabled="!writable"
              />
            </div>
            <div v-if="api.auth?.type === 'bearer'" class="field-row">
              <label>token</label>
              <a-input v-model:value="api.auth.token" class="field-input" data-testid="auth-token" :disabled="!writable" />
            </div>
            <template v-if="api.auth?.type === 'basic'">
              <div class="field-row">
                <label>username</label>
                <a-input v-model:value="api.auth.username" class="field-input" data-testid="auth-username" :disabled="!writable" />
              </div>
              <div class="field-row">
                <label>password</label>
                <a-input v-model:value="api.auth.password" class="field-input" data-testid="auth-password" type="password" :disabled="!writable" />
              </div>
            </template>
            <template v-if="api.auth?.type === 'apikey'">
              <div class="field-row">
                <label>key</label>
                <a-input v-model:value="api.auth.key" class="field-input" data-testid="auth-key" :disabled="!writable" />
              </div>
              <div class="field-row">
                <label>value</label>
                <a-input v-model:value="api.auth.value" class="field-input" data-testid="auth-value" :disabled="!writable" />
              </div>
              <div class="field-row">
                <label>placement</label>
                <a-select
                  v-model:value="api.auth.placement"
                  class="field-input"
                  data-testid="auth-placement"
                  :options="AUTH_PLACEMENT_OPTIONS"
                  :disabled="!writable"
                />
              </div>
            </template>
          </div>
        </a-tab-pane>

        <a-tab-pane key="body">
          <template #tab><span data-testid="online-tab-body">{{ t("editor.body") }}</span></template>
          <div class="panel">
            <div class="field-row">
              <label>{{ t("editor.bodyKind") }}</label>
              <a-select
                v-model:value="bodyKind"
                class="field-input"
                data-testid="body-kind"
                :options="BODY_KIND_OPTIONS"
                :disabled="!writable"
              />
            </div>
            <a-textarea
              v-if="api.body && api.body.kind !== 'form'"
              v-model:value="api.body.content"
              class="body-text"
              data-testid="body-content"
              :rows="8"
              :disabled="!writable"
            />
            <div v-if="api.body?.kind === 'form'" class="form-rows">
              <div v-for="(row, index) in api.body.form" :key="index" class="kv-row">
                <a-input v-model:value="row.key" data-testid="kv-key" placeholder="key" :disabled="!writable" />
                <a-input v-model:value="row.value" data-testid="kv-value" placeholder="value" :disabled="!writable" />
                <a-checkbox v-model:checked="row.enabled" data-testid="kv-enabled" :disabled="!writable" />
                <a-button v-if="writable" danger type="text" size="small" data-testid="kv-remove" @click="api.body?.form?.splice(index, 1)">×</a-button>
              </div>
              <a-button v-if="writable" class="add" data-testid="add-form-row" @click="api.body?.form && addRow(api.body.form)">
                {{ t("editor.addRow") }}
              </a-button>
            </div>
          </div>
        </a-tab-pane>
      </a-tabs>
    </template>
  </section>
</template>

<style scoped>
.editor {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  height: 100%;
  box-sizing: border-box;
}
.guide-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
}
.guide {
  margin: 6px 0 0;
  color: var(--text-muted);
  font-size: 12px;
  text-align: center;
}
.name-row { display: flex; align-items: center; gap: 6px; }
.name-input { flex: 1; max-width: 420px; font-weight: 600; }
.dirty { color: var(--accent); }
.saved-tip { color: var(--pass); font-size: 12px; }
.top-row { display: flex; gap: 8px; }
.method-select { width: 96px; }
.url { flex: 1; }
.path-line { font-size: 11px; }
.panel { display: flex; flex-direction: column; gap: 6px; overflow: auto; }
.kv-row { display: flex; gap: 6px; align-items: center; }
.kv-row :deep(.ant-input) { flex: 1; }
.field-row { display: flex; align-items: center; gap: 8px; }
.field-row label { width: 80px; color: var(--text-muted); font-size: 12px; }
.field-input { flex: 1; max-width: 320px; }
button.add { align-self: flex-start; }
.body-text { font-family: ui-monospace, monospace; resize: vertical; }
.raw {
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin: 0;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--panel);
  font-family: ui-monospace, monospace;
  font-size: 12px;
  white-space: pre-wrap;
}
.problems {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  line-height: 1.7;
}
</style>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Alert as AAlert, Button as AButton, Input as AInput, Select as ASelect, Tabs as ATabs, Checkbox as ACheckbox, Tag as ATag, Typography as ATypography } from "ant-design-vue";
import type { ApiRequest, HttpMethod, ParameterBinding, RequestBody } from "@apicc/core";
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
const BODY_KIND_OPTIONS: RequestBody["kind"][] = ["none", "json", "xml", "text", "graphql", "urlencoded", "multipart", "binary"];
const BODY_OPTIONS = BODY_KIND_OPTIONS.map((v) => ({ label: v, value: v }));
const TABS = ["params", "headers", "auth", "body"] as const;
type Tab = (typeof TABS)[number];
const activeTab = ref<Tab>("params");

const api = computed(() => props.online.editorApi);
const request = computed<ApiRequest | null>(() => api.value?.contract.request ?? null);
const writable = computed(() => props.online.canEdit(props.online.editorPath));
const apiName = computed({
  get: () => api.value?.contract.metadata.name ?? "",
  set: (name: string) => { if (api.value) api.value.contract.metadata.name = name; },
});
const requestPath = computed({
  get: () => request.value?.path ?? "",
  set: (path: string) => { if (request.value) request.value.path = path; },
});
const baseUrl = computed({
  get: () => request.value?.baseUrl ?? "",
  set: (value: string) => { if (request.value) request.value.baseUrl = value; },
});
const httpMethod = computed({
  get: () => request.value && request.value.protocol !== "websocket" ? request.value.method : "GET",
  set: (method: HttpMethod) => {
    if (request.value?.protocol === "http") request.value.method = method;
  },
});
const bodyKind = computed<RequestBody["kind"]>({
  get: () => request.value?.protocol === "http" ? request.value.body.kind : "none",
  set: (kind) => {
    if (request.value?.protocol !== "http") return;
    const previous = request.value.body;
    if (kind === "none") request.value.body = { kind };
    else if (kind === "json" || kind === "xml" || kind === "text") {
      request.value.body = { kind, content: previous.kind === kind ? previous.content : "" };
    } else if (kind === "graphql") {
      request.value.body = previous.kind === kind ? previous : { kind, query: "", variables: "" };
    } else if (kind === "urlencoded") {
      request.value.body = previous.kind === kind ? previous : { kind, fields: [] };
    } else if (kind === "multipart") {
      request.value.body = previous.kind === kind ? previous : { kind, entries: [] };
    } else {
      request.value.body = previous.kind === kind ? previous : { kind, file: { path: "" }, contentType: "application/octet-stream" };
    }
  },
});

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

function addParameter(list: ParameterBinding[]) {
  list.push({
    kind: "inline",
    id: crypto.randomUUID(),
    name: "",
    schema: { kind: "scalar", type: "string" },
    required: false,
    enabled: true,
    description: "",
    value: "",
  });
}

function addUrlEncodedField() {
  if (request.value?.protocol === "http" && request.value.body.kind === "urlencoded") {
    request.value.body.fields.push({ id: crypto.randomUUID(), name: "", value: "", enabled: true });
  }
}

function addMultipartText() {
  if (request.value?.protocol === "http" && request.value.body.kind === "multipart") {
    request.value.body.entries.push({ kind: "text", id: crypto.randomUUID(), name: "", value: "", enabled: true });
  }
}

function authDescription(request_: ApiRequest | null): string {
  if (!request_) return "";
  const auth = request_.auth;
  if (auth.kind === "none") return t("online.authNone");
  if (auth.kind === "componentRef") return t("online.authComponent");
  if (auth.kind === "bearer") return t("online.authBearer");
  if (auth.kind === "basic") return t("online.authBasic");
  return t("online.authApiKey");
}
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

    <template v-else-if="api && request">
      <div class="name-row">
        <a-input
          v-model:value="apiName"
          class="name-input"
          data-testid="online-editor-name"
          :disabled="!writable"
        />
        <span v-if="online.editorDirty" class="dirty" :title="t('wf.unsaved')">●</span>
        <a-tag v-if="!writable" data-testid="online-readonly-badge">{{ t("online.readonlyBadge") }}</a-tag>
        <span v-if="savedTip" class="saved-tip" data-testid="online-saved-tip">{{ t("online.savedTip") }}</span>
      </div>
      <div class="top-row">
        <a-tag data-testid="online-editor-protocol">{{ request.protocol }}</a-tag>
        <a-select v-if="request.protocol !== 'websocket'" v-model:value="httpMethod" class="method-select" data-testid="online-editor-method" :options="METHOD_OPTIONS" :disabled="!writable || request.protocol === 'soap'" />
        <a-input
          v-model:value="baseUrl"
          class="url"
          data-testid="online-editor-base-url"
          :placeholder="t('online.baseUrl')"
          :disabled="!writable"
        />
        <a-input
          v-model:value="requestPath"
          class="url"
          data-testid="online-editor-url"
          :placeholder="t('online.path')"
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
            <div v-for="(row, index) in request.query" :key="row.id" class="kv-row">
              <template v-if="row.kind === 'inline'">
                <a-input v-model:value="row.name" data-testid="kv-key" placeholder="name" :disabled="!writable" />
                <a-input v-model:value="row.value" data-testid="kv-value" placeholder="value" :disabled="!writable" />
                <a-checkbox v-model:checked="row.enabled" data-testid="kv-enabled" :disabled="!writable" />
              </template>
              <a-typography-text v-else data-testid="online-parameter-reference">{{ t("online.componentReference") }} · {{ row.componentId }}</a-typography-text>
              <a-button v-if="writable" danger type="text" size="small" data-testid="kv-remove" @click="request.query.splice(index, 1)">×</a-button>
            </div>
            <a-button v-if="writable" class="add" data-testid="add-param" @click="addParameter(request.query)">
              {{ t("editor.addRow") }}
            </a-button>
          </div>
        </a-tab-pane>
        <a-tab-pane key="headers">
          <template #tab><span data-testid="online-tab-headers">{{ t("editor.headers") }}</span></template>
          <div class="panel">
            <div v-for="(row, index) in request.headers" :key="row.id" class="kv-row">
              <template v-if="row.kind === 'inline'">
                <a-input v-model:value="row.name" data-testid="kv-key" placeholder="name" :disabled="!writable" />
                <a-input v-model:value="row.value" data-testid="kv-value" placeholder="value" :disabled="!writable" />
                <a-checkbox v-model:checked="row.enabled" data-testid="kv-enabled" :disabled="!writable" />
              </template>
              <a-typography-text v-else data-testid="online-parameter-reference">{{ t("online.componentReference") }} · {{ row.componentId }}</a-typography-text>
              <a-button v-if="writable" danger type="text" size="small" data-testid="kv-remove" @click="request.headers.splice(index, 1)">×</a-button>
            </div>
            <a-button v-if="writable" class="add" data-testid="add-header" @click="addParameter(request.headers)">
              {{ t("editor.addRow") }}
            </a-button>
          </div>
        </a-tab-pane>

        <a-tab-pane key="auth">
          <template #tab><span data-testid="online-tab-auth">{{ t("editor.auth") }}</span></template>
          <div class="panel">
            <a-typography-text data-testid="online-auth-summary">{{ authDescription(request) }}</a-typography-text>
            <a-typography-text type="secondary" data-testid="online-auth-secret-note">{{ t("online.authSecretNote") }}</a-typography-text>
          </div>
        </a-tab-pane>

        <a-tab-pane key="body">
          <template #tab><span data-testid="online-tab-body">{{ t("editor.body") }}</span></template>
          <div class="panel">
            <div class="field-row">
              <label>{{ t("editor.bodyKind") }}</label>
              <a-select v-if="request.protocol === 'http'" v-model:value="bodyKind" class="field-input" data-testid="body-kind" :options="BODY_OPTIONS" :disabled="!writable" />
              <a-typography-text v-else data-testid="body-kind">{{ request.protocol === 'websocket' ? 'message' : 'SOAP envelope' }}</a-typography-text>
            </div>
            <a-textarea
              v-if="request.protocol === 'http' && (request.body.kind === 'json' || request.body.kind === 'xml' || request.body.kind === 'text')"
              v-model:value="request.body.content"
              class="body-text"
              data-testid="body-content"
              :rows="8"
              :disabled="!writable"
            />
            <template v-else-if="request.protocol === 'http' && request.body.kind === 'graphql'">
              <a-textarea v-model:value="request.body.query" class="body-text" data-testid="body-query" :rows="6" :disabled="!writable" />
              <a-textarea v-model:value="request.body.variables" class="body-text" data-testid="body-variables" :rows="4" :disabled="!writable" />
            </template>
            <div v-else-if="request.protocol === 'http' && request.body.kind === 'urlencoded'" class="form-rows">
              <div v-for="(row, index) in request.body.fields" :key="row.id" class="kv-row">
                <a-input v-model:value="row.name" data-testid="kv-key" placeholder="name" :disabled="!writable" />
                <a-input v-model:value="row.value" data-testid="kv-value" placeholder="value" :disabled="!writable" />
                <a-checkbox v-model:checked="row.enabled" data-testid="kv-enabled" :disabled="!writable" />
                <a-button v-if="writable" danger type="text" size="small" data-testid="kv-remove" @click="request.body.fields.splice(index, 1)">×</a-button>
              </div>
              <a-button v-if="writable" class="add" data-testid="add-form-row" @click="addUrlEncodedField()">
                {{ t("editor.addRow") }}
              </a-button>
            </div>
            <div v-else-if="request.protocol === 'http' && request.body.kind === 'multipart'" class="form-rows">
              <div v-for="(entry, index) in request.body.entries" :key="entry.id" class="kv-row">
                <template v-if="entry.kind === 'text'">
                  <a-input v-model:value="entry.name" data-testid="kv-key" placeholder="name" :disabled="!writable" />
                  <a-input v-model:value="entry.value" data-testid="kv-value" placeholder="value" :disabled="!writable" />
                </template>
                <a-typography-text v-else>{{ entry.name }} · {{ entry.file.path }}</a-typography-text>
                <a-checkbox v-model:checked="entry.enabled" data-testid="kv-enabled" :disabled="!writable" />
                <a-button v-if="writable" danger type="text" size="small" data-testid="kv-remove" @click="request.body.entries.splice(index, 1)">×</a-button>
              </div>
              <a-button v-if="writable" class="add" data-testid="add-form-row" @click="addMultipartText()">{{ t("editor.addRow") }}</a-button>
            </div>
            <div v-else-if="request.protocol === 'http' && request.body.kind === 'binary'" class="field-row">
              <a-input v-model:value="request.body.file.path" data-testid="body-file-path" :disabled="!writable" />
              <a-input v-model:value="request.body.contentType" data-testid="body-content-type" :disabled="!writable" />
            </div>
            <template v-else-if="request.protocol === 'websocket'">
              <a-textarea v-model:value="request.message" class="body-text" data-testid="body-message" :rows="8" :disabled="!writable" />
            </template>
            <template v-else-if="request.protocol === 'soap'">
              <a-input v-model:value="request.soapAction" data-testid="body-soap-action" :disabled="!writable" />
              <a-textarea v-model:value="request.envelope" class="body-text" data-testid="body-envelope" :rows="8" :disabled="!writable" />
            </template>
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

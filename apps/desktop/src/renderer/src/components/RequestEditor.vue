<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import type { AuthSpec, BodyContent, HttpMethod, KeyValuePair } from "@apicc/core";
import type { useEditorStore } from "../stores/editor.js";
import type { useDebugStore } from "../stores/debug.js";
import EmptyState from "./EmptyState.vue";

/**
 * 请求编辑器：props 接收 editor/debug store 实例（组合根一次装配；
 * 组件内部禁止重复调用 store 工厂）。全部绑定直接改 editor.api 字段
 * （Pinia 响应式 + dirty 快照比对自动跟踪），显式保存按钮调 editor.save()；
 * 发送按钮调 debug.send(editor)（发送前自动保存脏编辑）。
 */
const props = defineProps<{
  editor: ReturnType<typeof useEditorStore>;
  debug: ReturnType<typeof useDebugStore>;
}>();
const { t } = useI18n();

const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const TABS = ["params", "headers", "auth", "body"] as const;
type Tab = (typeof TABS)[number];
const activeTab = ref<Tab>("params");
const TAB_KEYS: Record<Tab, string> = { params: "editor.params", headers: "editor.headers", auth: "editor.auth", body: "editor.body" };

function addRow(list: KeyValuePair[]) {
  list.push({ key: "", value: "", enabled: true });
}

// —— 认证：none 与三种类型互转（strict schema：切类型重建对象，不残留旧键） ——
type AuthKind = AuthSpec["type"] | "none";
const authKind = computed<AuthKind>({
  get: () => props.editor.api?.auth?.type ?? "none",
  set: (kind) => {
    const api = props.editor.api;
    if (!api) return;
    if (kind === "none") {
      api.auth = undefined;
      return;
    }
    const base = { type: kind, placement: "header" } as const;
    api.auth =
      kind === "bearer" ? { ...base, token: "" }
      : kind === "basic" ? { ...base, username: "", password: "" }
      : { ...base, key: "", value: "" };
  },
});

// —— 请求体：none 与五种体类型互转（同上，切换时重建避免残留 form 键） ——
type BodyKind = BodyContent["kind"] | "none";
const bodyKind = computed<BodyKind>({
  get: () => props.editor.api?.body?.kind ?? "none",
  set: (kind) => {
    const api = props.editor.api;
    if (!api) return;
    if (kind === "none") {
      api.body = undefined;
      return;
    }
    const prevContent = api.body?.content ?? "";
    api.body =
      kind === "form" ? { kind: "form", content: prevContent, form: api.body?.form ?? [] } : { kind, content: prevContent };
  },
});
</script>

<template>
  <section v-if="editor.api" class="editor" data-testid="request-editor">
    <div class="name-row">
      <input v-model="editor.api.name" class="name-input" data-testid="editor-name" :placeholder="t('editor.name')" />
      <span v-if="editor.dirty" class="dirty" title="unsaved">●</span>
    </div>
    <div class="top-row">
      <select v-model="editor.api.method" data-testid="editor-method" :title="t('editor.method')">
        <option v-for="m in METHODS" :key="m" :value="m">{{ m }}</option>
      </select>
      <input v-model="editor.api.url" class="url" data-testid="editor-url" :placeholder="t('editor.url')" />
      <button class="send" data-testid="send-btn" :disabled="debug.sending" @click="debug.send(editor)">
        {{ debug.sending ? t("editor.sending") : t("editor.send") }}
      </button>
      <button data-testid="save-btn" @click="editor.save()">{{ t("editor.save") }}</button>
    </div>

    <div class="tabs">
      <button
        v-for="tab in TABS"
        :key="tab"
        :data-testid="`tab-${tab}`"
        :class="{ active: activeTab === tab }"
        @click="activeTab = tab"
      >
        {{ t(TAB_KEYS[tab]) }}
      </button>
    </div>

    <!-- 参数 / 请求头：key/value/enabled 行编辑 -->
    <div v-if="activeTab === 'params' || activeTab === 'headers'" class="panel">
      <div v-for="(row, index) in activeTab === 'params' ? editor.api.query : editor.api.headers" :key="index" class="kv-row">
        <input v-model="row.key" data-testid="kv-key" placeholder="key" />
        <input v-model="row.value" data-testid="kv-value" placeholder="value" />
        <input
          v-model="row.enabled"
          type="checkbox"
          data-testid="kv-enabled"
          :title="row.enabled ? 'enabled' : 'disabled'"
        />
        <button
          class="remove"
          data-testid="kv-remove"
          @click="activeTab === 'params' ? editor.api.query.splice(index, 1) : editor.api.headers.splice(index, 1)"
        >
          ×
        </button>
      </div>
      <button class="add" :data-testid="activeTab === 'params' ? 'add-param' : 'add-header'" @click="addRow(activeTab === 'params' ? editor.api.query : editor.api.headers)">
        {{ t("editor.addRow") }}
      </button>
    </div>

    <!-- 认证：type 下拉 + bearer/basic/apikey 对应字段 -->
    <div v-else-if="activeTab === 'auth'" class="panel">
      <div class="field-row">
        <label>type</label>
        <select v-model="authKind" data-testid="auth-type">
          <option value="none">none</option>
          <option value="bearer">bearer</option>
          <option value="basic">basic</option>
          <option value="apikey">apikey</option>
        </select>
      </div>
      <div v-if="editor.api.auth?.type === 'bearer'" class="field-row">
        <label>token</label>
        <input v-model="editor.api.auth.token" data-testid="auth-token" />
      </div>
      <template v-if="editor.api.auth?.type === 'basic'">
        <div class="field-row">
          <label>username</label>
          <input v-model="editor.api.auth.username" data-testid="auth-username" />
        </div>
        <div class="field-row">
          <label>password</label>
          <input v-model="editor.api.auth.password" data-testid="auth-password" type="password" />
        </div>
      </template>
      <template v-if="editor.api.auth?.type === 'apikey'">
        <div class="field-row">
          <label>key</label>
          <input v-model="editor.api.auth.key" data-testid="auth-key" />
        </div>
        <div class="field-row">
          <label>value</label>
          <input v-model="editor.api.auth.value" data-testid="auth-value" />
        </div>
        <div class="field-row">
          <label>placement</label>
          <select v-model="editor.api.auth.placement" data-testid="auth-placement">
            <option value="header">header</option>
            <option value="query">query</option>
          </select>
        </div>
      </template>
    </div>

    <!-- 请求体：kind 下拉 + 对应编辑器 -->
    <div v-else class="panel">
      <div class="field-row">
        <label>{{ t("editor.bodyKind") }}</label>
        <select v-model="bodyKind" data-testid="body-kind">
          <option value="none">none</option>
          <option value="json">json</option>
          <option value="xml">xml</option>
          <option value="raw">raw</option>
          <option value="graphql">graphql</option>
          <option value="form">form</option>
        </select>
      </div>
      <textarea
        v-if="editor.api.body && editor.api.body.kind !== 'form'"
        v-model="editor.api.body.content"
        class="body-text"
        data-testid="body-content"
        rows="8"
      ></textarea>
      <div v-if="editor.api.body?.kind === 'form'" class="form-rows">
        <div v-for="(row, index) in editor.api.body.form" :key="index" class="kv-row">
          <input v-model="row.key" data-testid="kv-key" placeholder="key" />
          <input v-model="row.value" data-testid="kv-value" placeholder="value" />
          <input v-model="row.enabled" type="checkbox" data-testid="kv-enabled" />
          <button class="remove" data-testid="kv-remove" @click="editor.api.body?.form?.splice(index, 1)">×</button>
        </div>
        <button class="add" data-testid="add-form-row" @click="editor.api.body?.form && addRow(editor.api.body.form)">
          {{ t("editor.addRow") }}
        </button>
      </div>
    </div>
  </section>
  <EmptyState v-else :text="t('editor.empty')" />
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
.name-row { display: flex; align-items: center; gap: 6px; }
.name-input {
  flex: 1;
  max-width: 420px;
  font-weight: 600;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
}
.dirty { color: var(--accent); }
.top-row { display: flex; gap: 8px; }
.top-row select { width: 96px; }
.url { flex: 1; }
.top-row input, .top-row select {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
}
.top-row button {
  padding: 6px 14px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
}
.top-row button.send {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.top-row button.send:disabled { opacity: 0.6; cursor: default; }
.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); }
.tabs button {
  border: none;
  background: none;
  color: var(--text-muted);
  padding: 6px 12px;
  cursor: pointer;
  border-bottom: 2px solid transparent;
}
.tabs button.active { color: var(--accent); border-bottom-color: var(--accent); }
.panel { display: flex; flex-direction: column; gap: 6px; overflow: auto; }
.kv-row { display: flex; gap: 6px; align-items: center; }
.kv-row input:first-child, .kv-row input:nth-child(2) {
  flex: 1;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
}
.field-row { display: flex; align-items: center; gap: 8px; }
.field-row label { width: 80px; color: var(--text-muted); font-size: 12px; }
.field-row input, .field-row select {
  flex: 1;
  max-width: 320px;
  padding: 4px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
}
button.add, button.remove {
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
}
button.add { align-self: flex-start; padding: 4px 10px; }
button.remove { border: none; color: var(--fail); padding: 2px 6px; }
.body-text {
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  font-family: ui-monospace, monospace;
  padding: 6px 8px;
  resize: vertical;
}
</style>

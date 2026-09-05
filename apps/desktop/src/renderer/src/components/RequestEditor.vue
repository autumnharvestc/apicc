<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Select as ASelect, Input as AInput, Button as AButton, Tabs as ATabs, Checkbox as ACheckbox, RadioGroup as ARadioGroup, RadioButton as ARadioButton } from "ant-design-vue";
import type { AuthSpec, BodyContent, HttpMethod, KeyValuePair } from "@apicc/core";
import type { useEditorStore } from "../stores/editor.js";
import type { useDebugStore } from "../stores/debug.js";
import { DEFAULT_PROTOCOL, type ProtocolKind } from "../multi-protocol.js";
import EmptyState from "./EmptyState.vue";

const ATabPane = ATabs.TabPane;
const ATextarea = AInput.TextArea;

/**
 * 请求编辑器：props 接收 editor/debug store 实例（组合根一次装配；
 * 组件内部禁止重复调用 store 工厂）。全部绑定直接改 editor.api 字段
 * （Pinia 响应式 + dirty 快照比对自动跟踪），显式保存按钮调 editor.save()；
 * 发送按钮调 debug.send(editor)（发送前自动保存脏编辑）。
 * 调试选择器：URL 行内发送按钮左侧有环境选择器（debug-env-select，含「无环境」空值项）
 * 与用例选择器（debug-case-select），仅写 debug store 的 selectedEnvName/selectedCaseId。
 * antd 4 落地：方法/认证类型/placement/体类型为 a-select，URL/名称/字段为 a-input，
 * 页签为 a-tabs（页签触发的 data-testid 经 #tab slot 保留在可点击的 span 上，
 * 点击冒泡到 a-tabs 内部处理器），行编辑为 a-input + a-checkbox + a-button。
 * M5-B 任务 1（D8 协议选择与字段显隐，D2 契约 fixture）：URL 行左侧 a-radio-group
 * （editor-protocol，三选 a-radio-button，缺省 http）——旧数据无 protocol 字段显示
 * http 不回写；切换协议只改页签显隐（各自字段内容保留不互删）：WS 隐藏 method 选择
 * 与参数/请求体、显消息模板（method 缺省 GET 不参与执行，UI 不显示 method——裁定②）；
 * SOAP 隐藏参数/请求体、显 envelope/soapAction，method 落定显式 POST 且禁用（D2
 * superRefine 前置的 UI 侧 fixture）；HTTP 原样。切协议后激活页签重置为该协议首个
 * 页签（协议载荷页签居首），保证新协议字段立即可编辑。
 */
const props = defineProps<{
  editor: ReturnType<typeof useEditorStore>;
  debug: ReturnType<typeof useDebugStore>;
}>();
const { t } = useI18n();

const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const METHOD_OPTIONS = METHODS.map((m) => ({ label: m, value: m }));
const AUTH_KIND_OPTIONS = ["none", "bearer", "basic", "apikey"].map((v) => ({ label: v, value: v }));
const AUTH_PLACEMENT_OPTIONS = ["header", "query"].map((v) => ({ label: v, value: v }));
const BODY_KIND_OPTIONS = ["none", "json", "xml", "raw", "graphql", "form"].map((v) => ({ label: v, value: v }));

// —— 协议：三选单选（标签走 i18n protocol.*）+ 按协议的页签清单（载荷页签居首） ——
const PROTOCOL_OPTIONS = computed(() =>
  (["http", "websocket", "soap"] as const).map((p) => ({ value: p, label: t(`protocol.${p}`) })),
);
type Tab = "params" | "headers" | "auth" | "body" | "message" | "envelope";
const TABS_BY_PROTOCOL: Record<ProtocolKind, readonly Tab[]> = {
  http: ["params", "headers", "auth", "body"],
  websocket: ["message", "headers", "auth"],
  soap: ["envelope", "headers", "auth"],
};
const activeTab = ref<Tab>("params");

const protocol = computed<ProtocolKind>({
  get: () => props.editor.api?.protocol ?? DEFAULT_PROTOCOL,
  set: (p) => {
    const api = props.editor.api;
    if (!api) return;
    api.protocol = p;
    // D2：soap → method 固定 POST 且必须显式 POST（UI 落定并禁用）；WS method 缺省
    // GET 不参与执行——不写数据，仅 UI 隐藏；来回切不回改（裁定③只保字段内容）。
    if (p === "soap" && api.method !== "POST") api.method = "POST";
    activeTab.value = TABS_BY_PROTOCOL[p][0]!;
  },
});
const isHttp = computed(() => protocol.value === "http");

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
      <a-input v-model:value="editor.api.name" class="name-input" data-testid="editor-name" :placeholder="t('editor.name')" />
      <span v-if="editor.dirty" class="dirty" :title="t('editor.unsaved')">●</span>
    </div>
    <div class="top-row">
      <!-- 协议选择（D8）：三选单选，缺省 http；旧数据无 protocol 字段显示侧回退不回写 -->
      <a-radio-group v-model:value="protocol" data-testid="editor-protocol" class="protocol-select">
        <a-radio-button v-for="p in PROTOCOL_OPTIONS" :key="p.value" :value="p.value">{{ p.label }}</a-radio-button>
      </a-radio-group>
      <!-- method：WS 隐藏（缺省 GET 不参与执行，裁定②选隐藏）；SOAP 固定 POST 禁用（D2） -->
      <a-select
        v-if="protocol !== 'websocket'"
        v-model:value="editor.api.method"
        class="method-select"
        data-testid="editor-method"
        :options="METHOD_OPTIONS"
        :disabled="protocol === 'soap'"
        :title="t('editor.method')"
      />
      <a-input v-model:value="editor.api.url" class="url" data-testid="editor-url" :placeholder="t('editor.url')" />
      <!-- 调试环境/用例选择器（任务 1）：仅写 debug store 的选择状态，send 按钮仍调
           debug.send(editor)（不传显式 envName，走 store 状态）；空值项表示无环境。
           显示侧与 send 相同的存在性校验（宽审查修复 2）：切接口/删环境后失效的选择
           不再渲染为裸字符串，与 send 的静默回退一致（显示 = 发送）。 -->
      <a-select
        data-testid="debug-env-select"
        :value="(editor.envs ?? []).some((e) => e.name === debug.selectedEnvName) ? debug.selectedEnvName ?? '' : ''"
        :options="[{ label: t('editor.noEnv'), value: '' }, ...editor.envs.map((e) => ({ label: e.name, value: e.name }))]"
        style="min-width: 120px"
        @update:value="(v) => debug.selectEnv(v === '' ? null : (v as string))"
      />
      <a-select
        data-testid="debug-case-select"
        :value="(editor.api?.cases ?? []).some((c) => c.id === debug.selectedCaseId) ? debug.selectedCaseId ?? '' : editor.api?.cases[0]?.id ?? ''"
        :options="(editor.api?.cases ?? []).map((c) => ({ label: `${c.name}（${c.scope}）`, value: c.id }))"
        style="min-width: 160px"
        @update:value="(v) => debug.selectCase(v as string)"
      />
      <a-button type="primary" data-testid="send-btn" :disabled="debug.sending" @click="debug.send(editor)">
        {{ debug.sending ? t("editor.sending") : t("editor.send") }}
      </a-button>
      <a-button data-testid="save-btn" @click="editor.save()">{{ t("editor.save") }}</a-button>
    </div>

    <a-tabs v-model:active-key="activeTab">
      <!-- 参数 / 请求头：key/value/enabled 行编辑（参数页签仅 HTTP——D8：WS/SOAP 隐藏
           query，字段内容保留不互删，裁定③；两页签各持一份，data-testid 相同，
           未激活页签不渲染，任一时刻仅有一份在 DOM 中） -->
      <a-tab-pane v-if="isHttp" key="params">
        <template #tab><span data-testid="tab-params">{{ t("editor.params") }}</span></template>
        <div class="panel">
          <div v-for="(row, index) in editor.api.query" :key="index" class="kv-row">
            <a-input v-model:value="row.key" data-testid="kv-key" placeholder="key" />
            <a-input v-model:value="row.value" data-testid="kv-value" placeholder="value" />
            <a-checkbox v-model:checked="row.enabled" data-testid="kv-enabled" :title="row.enabled ? 'enabled' : 'disabled'" />
            <a-button danger type="text" size="small" data-testid="kv-remove" @click="editor.api.query.splice(index, 1)">×</a-button>
          </div>
          <a-button class="add" data-testid="add-param" @click="addRow(editor.api.query)">
            {{ t("editor.addRow") }}
          </a-button>
        </div>
      </a-tab-pane>
      <a-tab-pane key="headers">
        <template #tab><span data-testid="tab-headers">{{ t("editor.headers") }}</span></template>
        <div class="panel">
          <div v-for="(row, index) in editor.api.headers" :key="index" class="kv-row">
            <a-input v-model:value="row.key" data-testid="kv-key" placeholder="key" />
            <a-input v-model:value="row.value" data-testid="kv-value" placeholder="value" />
            <a-checkbox v-model:checked="row.enabled" data-testid="kv-enabled" :title="row.enabled ? 'enabled' : 'disabled'" />
            <a-button danger type="text" size="small" data-testid="kv-remove" @click="editor.api.headers.splice(index, 1)">×</a-button>
          </div>
          <a-button class="add" data-testid="add-header" @click="addRow(editor.api.headers)">
            {{ t("editor.addRow") }}
          </a-button>
        </div>
      </a-tab-pane>

      <!-- 认证：type 下拉 + bearer/basic/apikey 对应字段 -->
      <a-tab-pane key="auth">
        <template #tab><span data-testid="tab-auth">{{ t("editor.auth") }}</span></template>
        <div class="panel">
          <div class="field-row">
            <label>type</label>
            <a-select v-model:value="authKind" class="field-input" data-testid="auth-type" :options="AUTH_KIND_OPTIONS" />
          </div>
          <div v-if="editor.api.auth?.type === 'bearer'" class="field-row">
            <label>token</label>
            <a-input v-model:value="editor.api.auth.token" class="field-input" data-testid="auth-token" />
          </div>
          <template v-if="editor.api.auth?.type === 'basic'">
            <div class="field-row">
              <label>username</label>
              <a-input v-model:value="editor.api.auth.username" class="field-input" data-testid="auth-username" />
            </div>
            <div class="field-row">
              <label>password</label>
              <a-input v-model:value="editor.api.auth.password" class="field-input" data-testid="auth-password" type="password" />
            </div>
          </template>
          <template v-if="editor.api.auth?.type === 'apikey'">
            <div class="field-row">
              <label>key</label>
              <a-input v-model:value="editor.api.auth.key" class="field-input" data-testid="auth-key" />
            </div>
            <div class="field-row">
              <label>value</label>
              <a-input v-model:value="editor.api.auth.value" class="field-input" data-testid="auth-value" />
            </div>
            <div class="field-row">
              <label>placement</label>
              <a-select v-model:value="editor.api.auth.placement" class="field-input" data-testid="auth-placement" :options="AUTH_PLACEMENT_OPTIONS" />
            </div>
          </template>
        </div>
      </a-tab-pane>

      <!-- 请求体：kind 下拉 + 对应编辑器（仅 HTTP——D8；SOAP 的载荷是 envelope） -->
      <a-tab-pane v-if="isHttp" key="body">
        <template #tab><span data-testid="tab-body">{{ t("editor.body") }}</span></template>
        <div class="panel">
          <div class="field-row">
            <label>{{ t("editor.bodyKind") }}</label>
            <a-select v-model:value="bodyKind" class="field-input" data-testid="body-kind" :options="BODY_KIND_OPTIONS" />
          </div>
          <a-textarea
            v-if="editor.api.body && editor.api.body.kind !== 'form'"
            v-model:value="editor.api.body.content"
            class="body-text"
            data-testid="body-content"
            :rows="8"
          />
          <div v-if="editor.api.body?.kind === 'form'" class="form-rows">
            <div v-for="(row, index) in editor.api.body.form" :key="index" class="kv-row">
              <a-input v-model:value="row.key" data-testid="kv-key" placeholder="key" />
              <a-input v-model:value="row.value" data-testid="kv-value" placeholder="value" />
              <a-checkbox v-model:checked="row.enabled" data-testid="kv-enabled" />
              <a-button danger type="text" size="small" data-testid="kv-remove" @click="editor.api.body?.form?.splice(index, 1)">×</a-button>
            </div>
            <a-button class="add" data-testid="add-form-row" @click="editor.api.body?.form && addRow(editor.api.body.form)">
              {{ t("editor.addRow") }}
            </a-button>
          </div>
        </div>
      </a-tab-pane>

      <!-- 消息模板（仅 WebSocket，D8）：连接后发送的文本帧模板，缺省仅连接（D2） -->
      <a-tab-pane v-if="protocol === 'websocket'" key="message">
        <template #tab><span data-testid="tab-message">{{ t("protocol.message") }}</span></template>
        <div class="panel">
          <a-textarea
            v-model:value="editor.api.message"
            class="body-text"
            data-testid="editor-message"
            :rows="8"
            :placeholder="t('protocol.messagePlaceholder')"
          />
        </div>
      </a-tab-pane>

      <!-- SOAP 报文（仅 SOAP，D8）：envelope XML 模板 + 可选 SOAPAction 头 -->
      <a-tab-pane v-if="protocol === 'soap'" key="envelope">
        <template #tab><span data-testid="tab-envelope">{{ t("protocol.envelope") }}</span></template>
        <div class="panel">
          <a-textarea
            v-model:value="editor.api.envelope"
            class="body-text"
            data-testid="editor-envelope"
            :rows="8"
            :placeholder="t('protocol.envelopePlaceholder')"
          />
          <div class="field-row">
            <label>{{ t("protocol.soapAction") }}</label>
            <a-input v-model:value="editor.api.soapAction" class="field-input" data-testid="editor-soap-action" />
          </div>
        </div>
      </a-tab-pane>
    </a-tabs>
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
.name-input { flex: 1; max-width: 420px; font-weight: 600; }
.dirty { color: var(--accent); }
.top-row { display: flex; gap: 8px; }
.method-select { width: 96px; }
.protocol-select { flex-shrink: 0; }
.url { flex: 1; }
.panel { display: flex; flex-direction: column; gap: 6px; overflow: auto; }
.kv-row { display: flex; gap: 6px; align-items: center; }
.kv-row :deep(.ant-input) { flex: 1; }
.field-row { display: flex; align-items: center; gap: 8px; }
.field-row label { width: 80px; color: var(--text-muted); font-size: 12px; }
.field-input { flex: 1; max-width: 320px; }
button.add { align-self: flex-start; }
.body-text { font-family: ui-monospace, monospace; resize: vertical; }
</style>

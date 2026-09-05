<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Alert as AAlert, Button as AButton, Input as AInput, Modal as AModal, Tag as ATag } from "ant-design-vue";
import type { createAiStore } from "../stores/ai.js";

/**
 * AI 配置对话框（M6-C 任务 1，规格 §2 D2/D4）：baseUrl/model 明文输入（渲染层
 * localStorage 持久化，由 store 负责）+ key 密码框（经 IPC 入 main 进程 safeStorage，
 * 留空 = 保持既有；出口只有 hasKey 徽标，明文永不回显——裁定②）。
 * 连接测试（ai:test-config 轻量探测，任务 2）：成功/失败告警上屏。
 * **组件内零工厂调用**：store 实例经 props 注入（App 组合根装配）。表单校验先行
 * （baseUrl/model 必填），保存失败经 store.error 上屏；组件自身 async 动作不重抛。
 * antd 4 落地：a-modal 承载（传送门渲染于 body，测试用 document.body 作用域查询，
 * 先例同 OnlineLoginDialog）；模板外层 v-if="ai.configDialogOpen"：关闭即整体卸载。
 */
const props = defineProps<{ ai: ReturnType<typeof createAiStore> }>();
const { t } = useI18n();

const baseUrl = ref("");
const model = ref("");
const apiKey = ref("");
const formError = ref("");

// 每次打开重置本地表单（key 输入永不回显/残留）；回填已存 baseUrl/model，复位提示与测试态。
watch(
  () => props.ai.configDialogOpen,
  (open) => {
    if (!open) return;
    formError.value = "";
    baseUrl.value = props.ai.baseUrl;
    model.value = props.ai.model;
    apiKey.value = "";
    props.ai.savedNotice = false;
    props.ai.testResult = null;
    props.ai.error = null;
  },
  { immediate: true },
);

function onSave() {
  formError.value = "";
  const url = baseUrl.value.trim();
  if (!url) {
    formError.value = t("ai.baseUrlRequired");
    return;
  }
  const name = model.value.trim();
  if (!name) {
    formError.value = t("ai.modelRequired");
    return;
  }
  void props.ai.saveConfig({ baseUrl: url, model: name, apiKey: apiKey.value || undefined }).then((ok) => {
    // 保存成功清 key 输入（不在表单残留凭据）；失败保留便于改密重试（error 已上屏）
    if (ok) apiKey.value = "";
  });
}

function onTest() {
  void props.ai.testConnection();
}
</script>

<template>
  <a-modal
    v-if="ai.configDialogOpen"
    :open="ai.configDialogOpen"
    :title="t('ai.configTitle')"
    :width="460"
    data-testid="ai-config-dialog"
    @cancel="ai.configDialogOpen = false"
  >
    <div class="ai-config-body" data-testid="ai-config-body">
      <label class="field">
        <span class="field-label">{{ t("ai.baseUrl") }}</span>
        <a-input
          v-model:value="baseUrl"
          class="control"
          data-testid="ai-config-baseurl"
          :placeholder="t('ai.baseUrlPlaceholder')"
        />
      </label>
      <label class="field">
        <span class="field-label">{{ t("ai.model") }}</span>
        <a-input
          v-model:value="model"
          class="control"
          data-testid="ai-config-model"
          :placeholder="t('ai.modelPlaceholder')"
        />
      </label>
      <label class="field">
        <span class="field-label">{{ t("ai.apiKey") }}</span>
        <a-input
          v-model:value="apiKey"
          class="control"
          data-testid="ai-config-key"
          type="password"
          :placeholder="ai.hasKey ? t('ai.keySavedPlaceholder') : t('ai.keyPlaceholder')"
        />
      </label>
      <div class="key-state">
        <a-tag v-if="ai.hasKey" color="green" data-testid="ai-has-key">{{ t("ai.hasKey") }}</a-tag>
        <a-tag v-else data-testid="ai-no-key">{{ t("ai.noKey") }}</a-tag>
      </div>
      <div class="actions">
        <a-button type="primary" :loading="ai.savingConfig" data-testid="ai-config-save" @click="onSave">
          {{ t("ai.save") }}
        </a-button>
        <a-button :loading="ai.testing" data-testid="ai-config-test" @click="onTest">
          {{ ai.testing ? t("ai.testing") : t("ai.test") }}
        </a-button>
      </div>
      <div v-if="ai.savedNotice" class="notice" data-testid="ai-saved">{{ t("ai.saved") }}</div>
      <!-- 连接测试两态（ai:test-config 轻量探测）：成功/失败告警互斥上屏 -->
      <a-alert v-if="ai.testResult === 'success'" type="success" show-icon :message="t('ai.testOk')" data-testid="ai-test-ok" />
      <a-alert v-if="ai.testResult === 'failure'" type="error" show-icon :message="`${t('ai.testFail')}: ${ai.error ?? ''}`" data-testid="ai-test-fail" />
      <!-- 保存失败（store.error）与本地表单校验分开呈现 -->
      <div v-if="formError" class="error" data-testid="ai-form-error">{{ formError }}</div>
      <a-alert v-else-if="ai.error && ai.testResult === null" type="error" show-icon :message="ai.error" data-testid="ai-save-error" />
    </div>
    <template #footer>
      <a-button data-testid="ai-config-close" @click="ai.configDialogOpen = false">{{ t("common.close") }}</a-button>
    </template>
  </a-modal>
</template>

<style scoped>
.ai-config-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
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
.key-state {
  min-height: 22px;
}
.actions {
  display: flex;
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
</style>

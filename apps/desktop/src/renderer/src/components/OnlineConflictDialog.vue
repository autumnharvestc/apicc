<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Button as AButton, Modal as AModal, Typography as ATypography } from "ant-design-vue";
import type { createOnlineStore } from "../stores/online.js";

const ATypographyText = ATypography.Text;
const ATypographyParagraph = ATypography.Paragraph;

/**
 * 在线推送冲突对话框（M3-B 任务 3，简报裁定 C）：putFile 409 → 冲突态入 store →
 * 本对话框呈现服务端当前版本/hash，两选项：
 * - 「拉取覆盖我的」→ getFiles 重取并重新渲染（对话框选择即丢弃本地编辑的确认）；
 * - 「放弃」→ 仅清冲突态，本地编辑缓冲保留（可继续修改或再推）。
 * a-modal 传送门渲染于 body（测试经 body 作用域查询，先例同 ConfirmDialog）。
 */
const props = defineProps<{
  online: ReturnType<typeof createOnlineStore>;
}>();
const { t } = useI18n();

async function onPullOverwrite() {
  await props.online.conflictPullOverwrite();
}

function onDiscard() {
  props.online.conflictDiscard();
}
</script>

<template>
  <a-modal
    v-if="online.conflict"
    :open="true"
    :title="t('online.conflictTitle')"
    :width="420"
    :closable="false"
    :keyboard="false"
    :mask-closable="false"
    data-testid="online-conflict-dialog"
  >
    <a-typography-paragraph data-testid="online-conflict-text">
      {{ t("online.conflictText", { version: online.conflict.currentVersion }) }}
    </a-typography-paragraph>
    <a-typography-text type="secondary" data-testid="online-conflict-hash">
      {{ online.conflict.currentHash }}
    </a-typography-text>
    <template #footer>
      <a-button data-testid="online-conflict-discard" @click="onDiscard">{{ t("online.conflictDiscard") }}</a-button>
      <a-button type="primary" data-testid="online-conflict-pull" @click="onPullOverwrite">
        {{ t("online.conflictPull") }}
      </a-button>
    </template>
  </a-modal>
</template>

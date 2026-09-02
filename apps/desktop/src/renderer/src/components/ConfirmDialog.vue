<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";

/**
 * 确认对话框（可复用为输入对话框）：open 控制显隐；
 * 传 inputPlaceholder 时显示输入框，confirm 回传输入值；否则回传 null（纯确认）。
 * 供重命名/创建/删除确认与 TopBar 新建工作区复用。
 */
const props = defineProps<{
  open: boolean;
  title: string;
  inputPlaceholder?: string;
  initialValue?: string;
}>();
const emit = defineEmits<{ confirm: [value: string | null]; cancel: [] }>();
const { t } = useI18n();

const value = ref("");
watch(
  () => props.open,
  (open) => {
    if (open) value.value = props.initialValue ?? "";
  },
);

function confirm() {
  emit("confirm", props.inputPlaceholder !== undefined ? value.value : null);
}
</script>

<template>
  <div v-if="open" class="overlay" data-testid="confirm-dialog">
    <div class="dialog">
      <div class="title">{{ title }}</div>
      <input
        v-if="inputPlaceholder !== undefined"
        v-model="value"
        class="input"
        data-testid="dialog-input"
        :placeholder="inputPlaceholder"
        @keyup.enter="confirm"
      />
      <div class="actions">
        <button data-testid="dialog-cancel" @click="emit('cancel')">{{ t("common.cancel") }}</button>
        <button class="primary" data-testid="dialog-confirm" @click="confirm">{{ t("common.confirm") }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 35%);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.dialog {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px;
  min-width: 300px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.title { font-weight: 600; }
.input {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
}
.actions { display: flex; justify-content: flex-end; gap: 8px; }
button {
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg);
  color: var(--text);
  cursor: pointer;
}
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
</style>

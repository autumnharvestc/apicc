<script setup lang="ts">
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Button as AButton, Input as AInput, Modal as AModal, TabPane as ATabPane, Tabs as ATabs, Textarea as ATextarea } from "ant-design-vue";
import type { ApiccApi, ContainerSaveInput } from "../../../shared/types.js";

/**
 * 容器管理对话框（M10）：模块（集合）= 变量 / 前置操作 / 后置操作 三页签；
 * 文件夹 = 前置操作 / 后置操作 两页签（无变量——M10 澄清裁定）。
 * 操作 = 有序列表（第一版仅「自定义脚本」类型）：增删 + 上移/下移排序，内容 textarea。
 * 打开时经 api.containerGet 水合，保存经 api.containerSave 整体替换；成功 emit saved
 * （父级刷新树/工作区）；api 拒绝经 reportError 上报并在对话框内显示。
 */
const props = defineProps<{
  api: ApiccApi;
  kind: "collection" | "folder";
  id: string;
  name: string;
  reportError: (e: unknown) => void;
}>();
const emit = defineEmits<{ close: []; saved: [] }>();
const { t } = useI18n();

const activeTab = ref<"variables" | "pre" | "post">("variables");
const variables = ref<Array<{ id: string; key: string; value: string }>>([]);
const preOps = ref<Array<{ id: string; content: string }>>([]);
const postOps = ref<Array<{ id: string; content: string }>>([]);
const error = ref("");
const saved = ref(false);

watch(
  () => props.id,
  async () => {
    if (!props.id) return;
    error.value = "";
    saved.value = false;
    try {
      const data = await props.api.containerGet(props.kind, props.id);
      variables.value = Object.entries(data.variables ?? {}).map(([key, value]) => ({ id: crypto.randomUUID(), key, value }));
      preOps.value = (data.preOperations ?? []).map((o) => ({ id: o.id, content: o.content }));
      postOps.value = (data.postOperations ?? []).map((o) => ({ id: o.id, content: o.content }));
    } catch (e) {
      props.reportError(e);
    }
  },
  { immediate: true },
);

function addVar() {
  variables.value.push({ id: crypto.randomUUID(), key: "", value: "" });
}
function addOp(list: Array<{ id: string; content: string }>) {
  list.push({ id: crypto.randomUUID(), content: "" });
}
function move(list: Array<{ id: string; content: string }>, index: number, delta: -1 | 1) {
  const target = index + delta;
  if (target < 0 || target >= list.length) return;
  const [item] = list.splice(index, 1);
  list.splice(target, 0, item!);
}

async function save() {
  const variablesRecord: Record<string, string> = {};
  for (const row of variables.value) {
    const key = row.key.trim();
    if (key) variablesRecord[key] = row.value;
  }
  const input: ContainerSaveInput = {
    kind: props.kind,
    id: props.id,
    ...(props.kind === "collection" ? { variables: variablesRecord } : {}),
    preOperations: preOps.value.map((o) => ({ id: o.id, type: "script" as const, content: o.content })),
    postOperations: postOps.value.map((o) => ({ id: o.id, type: "script" as const, content: o.content })),
  };
  try {
    await props.api.containerSave(input);
    saved.value = true;
    emit("saved");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    props.reportError(e);
  }
}
</script>

<template>
  <a-modal
    :open="true"
    :title="`${t('container.manage')} — ${name}`"
    :ok-text="t('container.save')"
    :cancel-text="t('common.close')"
    :width="680"
    data-testid="container-dialog"
    @ok="save"
    @cancel="emit('close')"
  >
    <a-tabs v-model:active-key="activeTab">
      <!-- 模块变量（仅模块；文件夹无变量——M10 澄清裁定） -->
      <a-tab-pane v-if="kind === 'collection'" key="variables">
        <template #tab>{{ t("container.variables") }}</template>
        <div v-for="(row, index) in variables" :key="row.id" class="kv-row">
          <a-input v-model:value="row.key" data-testid="container-var-key" placeholder="key" />
          <a-input v-model:value="row.value" data-testid="container-var-value" placeholder="value" />
          <a-button size="small" danger type="text" data-testid="container-var-delete" @click="variables.splice(index, 1)">×</a-button>
        </div>
        <a-button size="small" data-testid="container-var-add" @click="addVar">{{ t("env.addVar") }}</a-button>
      </a-tab-pane>

      <!-- 前置操作 -->
      <a-tab-pane key="pre">
        <template #tab>{{ t("container.preOperations") }}</template>
        <div v-for="(op, index) in preOps" :key="op.id" class="op-row" data-testid="container-op-row">
          <div class="op-btns">
            <a-button size="small" type="text" :disabled="index === 0" @click="move(preOps, index, -1)">↑</a-button>
            <a-button size="small" type="text" :disabled="index === preOps.length - 1" @click="move(preOps, index, 1)">↓</a-button>
            <a-button size="small" danger type="text" @click="preOps.splice(index, 1)">×</a-button>
          </div>
          <a-textarea v-model:value="op.content" :rows="3" class="op-text" data-testid="container-op-content" />
        </div>
        <a-button size="small" data-testid="container-pre-add" @click="addOp(preOps)">{{ t("container.addOperation") }}</a-button>
      </a-tab-pane>

      <!-- 后置操作 -->
      <a-tab-pane key="post">
        <template #tab>{{ t("container.postOperations") }}</template>
        <div v-for="(op, index) in postOps" :key="op.id" class="op-row" data-testid="container-op-row">
          <div class="op-btns">
            <a-button size="small" type="text" :disabled="index === 0" @click="move(postOps, index, -1)">↑</a-button>
            <a-button size="small" type="text" :disabled="index === postOps.length - 1" @click="move(postOps, index, 1)">↓</a-button>
            <a-button size="small" danger type="text" @click="postOps.splice(index, 1)">×</a-button>
          </div>
          <a-textarea v-model:value="op.content" :rows="3" class="op-text" data-testid="container-op-content" />
        </div>
        <a-button size="small" data-testid="container-post-add" @click="addOp(postOps)">{{ t("container.addOperation") }}</a-button>
      </a-tab-pane>
    </a-tabs>
    <p v-if="error" class="dialog-error" data-testid="container-error">{{ error }}</p>
    <p v-if="saved" class="saved" data-testid="container-saved">{{ t("container.saved") }}</p>
  </a-modal>
</template>

<style scoped>
.kv-row { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
.kv-row :deep(.ant-input) { flex: 1; }
.op-row { display: flex; gap: 6px; align-items: flex-start; margin-bottom: 8px; }
.op-btns { display: flex; flex-direction: column; }
.op-text { flex: 1; font-family: ui-monospace, monospace; }
.dialog-error { margin: 8px 0 0; color: var(--fail, #dc2626); font-size: 12px; }
.saved { margin: 8px 0 0; color: var(--pass, #16a34a); font-size: 12px; }
</style>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import {
  Alert as AAlert,
  Button as AButton,
  Cascader as ACascader,
  Form as AForm,
  FormItem as AFormItem,
  Input as AInput,
  Switch as ASwitch,
  Textarea as ATextarea,
} from "ant-design-vue";
import type { WfEdgeData, WfNodeData, WfNodePatch } from "../wf/wfCanvas.js";
import { findBindPath, type BindOption } from "../wf/wfBindings.js";

/**
 * 设计器右侧属性面板（M2-B 任务 4）：无选中 → 提示；节点选中 → label 输入 /
 * 接口用例 a-cascader 改绑（options 由组合根按当前项目树构造）/「空过占位」kind
 * 切换 / 删除节点；边选中 → condition a-textarea + 可用变量与语法提示。
 * 自身无缓冲：所有编辑经事件上抛 WfDesigner，由 wfCanvas 变换写回 store（置 dirty
 * 语义经快照比对自动派生）。noop 切换保留 apiId/caseId（切回 request 不丢绑定）。
 */
const props = defineProps<{
  nodeData: WfNodeData | null;
  edgeData: WfEdgeData | null;
  bindOptions: BindOption[];
}>();
const emit = defineEmits<{
  "node-change": [patch: WfNodePatch];
  "edge-condition": [condition: string];
  "remove-node": [];
}>();
const { t } = useI18n();

/** cascader 受控 value：由当前绑定反查路径（只绑接口为两段，未绑定为空）。 */
const bindPath = computed(() =>
  props.nodeData ? findBindPath(props.bindOptions, props.nodeData.node.apiId, props.nodeData.node.caseId) : [],
);

/** 改绑回写：选到接口层即生效（用例可后补）；清空解除绑定。 */
function onBind(value: unknown) {
  const path = Array.isArray(value) ? value.map(String) : [];
  if (path.length === 0) {
    emit("node-change", { apiId: undefined, caseId: undefined });
    return;
  }
  emit("node-change", { apiId: path[1] ?? undefined, caseId: path[2] ?? undefined });
}

function onKindToggle(checked: unknown) {
  emit("node-change", { kind: checked ? "noop" : "request" });
}
</script>

<template>
  <!-- 无选中：占位提示 -->
  <div v-if="!nodeData && !edgeData" class="panel-empty" data-testid="wf-panel-empty">
    <p class="hint">{{ t("wf.panelEmpty") }}</p>
  </div>

  <!-- 节点选中 -->
  <div v-else-if="nodeData" class="panel-node" data-testid="wf-panel-node">
    <a-alert
      v-if="nodeData.missing"
      class="missing-alert"
      type="error"
      show-icon
      :message="t('wf.missing')"
      data-testid="wf-node-missing"
    />
    <a-form layout="vertical" class="panel-form">
      <a-form-item :label="t('wf.nodeLabel')">
        <a-input
          :value="nodeData.node.label ?? ''"
          data-testid="wf-node-label"
          :placeholder="t('wf.untitled')"
          @change="emit('node-change', { label: ($event.target as HTMLInputElement).value || undefined })"
        />
      </a-form-item>
      <a-form-item v-if="nodeData.node.kind === 'request'" :label="t('wf.binding')">
        <a-cascader
          :value="bindPath"
          :options="bindOptions"
          change-on-select
          data-testid="wf-node-bind"
          :placeholder="t('wf.bindingPlaceholder')"
          @change="onBind"
        />
      </a-form-item>
      <a-form-item :label="t('wf.noopSwitch')">
        <a-switch
          :checked="nodeData.node.kind === 'noop'"
          data-testid="wf-node-noop"
          @change="onKindToggle"
        />
      </a-form-item>
    </a-form>
    <a-button danger block data-testid="wf-node-delete" @click="emit('remove-node')">
      {{ t("wf.deleteNode") }}
    </a-button>
  </div>

  <!-- 边选中 -->
  <div v-else class="panel-edge" data-testid="wf-panel-edge">
    <a-form layout="vertical" class="panel-form">
      <a-form-item :label="t('wf.condition')">
        <a-textarea
          :value="edgeData?.edge.condition ?? ''"
          :rows="4"
          data-testid="wf-edge-condition"
          :placeholder="t('wf.conditionPlaceholder')"
          @change="emit('edge-condition', ($event.target as HTMLTextAreaElement).value)"
        />
      </a-form-item>
    </a-form>
    <div class="edge-hints" data-testid="wf-edge-vars">
      <p>{{ t("wf.varsHint") }}</p>
      <p>{{ t("wf.syntaxHint") }}</p>
    </div>
  </div>
</template>

<style scoped>
.panel-empty, .panel-node, .panel-edge { padding: 12px; }
.hint { color: var(--text-muted); font-size: 12px; }
.missing-alert { margin-bottom: 12px; }
.panel-form { margin-bottom: 12px; }
.edge-hints {
  font-size: 12px;
  color: var(--text-muted);
  border-top: 1px solid var(--border);
  padding-top: 8px;
}
.edge-hints p { margin: 4px 0; }
</style>

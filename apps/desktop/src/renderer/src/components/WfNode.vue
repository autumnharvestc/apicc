<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Handle, Position } from "@vue-flow/core";
import type { WfNodeData } from "../wf/wfCanvas.js";

/**
 * 画布自定义节点（type="wf"，WfDesigner 经 #node-wf 插槽内嵌）。props 只收 WfNodeData：
 * 接口名/用例名已由 WfDesigner 预注入（简报裁定：画布不做查找）；missing 红框、
 * 运行状态着色（wf-node-passed/failed/skipped/noop，任务 7 消费）与 noop 虚线占位
 * 均由 class 承载。上下 Handle 供画布连线。
 */
defineProps<{ data: WfNodeData }>();
const { t } = useI18n();
</script>

<template>
  <div
    class="wf-node"
    :class="[data.stateClass, { 'wf-node-missing': data.missing, 'wf-node-noop-kind': data.node.kind === 'noop' }]"
    data-testid="wf-node"
  >
    <Handle type="target" :position="Position.Top" class="wf-handle" />
    <div class="wf-node-label">{{ data.node.label || t("wf.untitled") }}</div>
    <div class="wf-node-ref" data-testid="wf-node-ref">
      <template v-if="data.node.kind === 'request'">
        {{ data.apiName || t("wf.unbound") }}<template v-if="data.caseName"> · {{ data.caseName }}</template>
      </template>
      <template v-else-if="data.node.kind === 'noop'">{{ t("wf.noopRef") }}</template>
      <template v-else>{{ t(`wf.control.kinds.${data.node.kind}`) }}<template v-if="data.node.kind === 'parallel'"> · {{ data.node.branches.length }} · {{ t(data.node.join === 'all' ? 'wf.control.all' : 'wf.control.anySuccess') }}</template><template v-if="data.node.kind === 'loop'"> · {{ data.node.count ?? t('wf.control.while') }} / {{ data.node.maxIterations }}</template></template>
    </div>
    <template v-if="data.node.kind === 'condition'"><span class="wf-ports">{{ t('wf.control.truePort') }} / {{ t('wf.control.falsePort') }}</span><Handle id="true" type="source" :position="Position.Bottom" class="wf-handle" :style="{ left: '30%' }" /><Handle id="false" type="source" :position="Position.Bottom" class="wf-handle" :style="{ left: '70%' }" /></template>
    <Handle v-else type="source" :position="Position.Bottom" class="wf-handle" />
  </div>
</template>

<style scoped>
.wf-node {
  min-width: 150px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--panel);
  font-size: 12px;
}
.wf-node-label { font-weight: 600; color: var(--text); }
.wf-node-ref { margin-top: 2px; color: var(--text-muted); }
.wf-node-noop-kind { border-style: dashed; }
.wf-node-missing { border: 2px solid var(--fail); }
.wf-node-passed { border-color: var(--pass); box-shadow: 0 0 0 1px var(--pass); }
.wf-node-failed { border-color: var(--fail); box-shadow: 0 0 0 1px var(--fail); }
.wf-node-skipped { opacity: 0.55; }
/* 运行 noop 状态描边（colorForState("noop") = "wf-node-noop"；与占位虚线 wf-node-noop-kind 叠加） */
.wf-node-noop { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.wf-handle { width: 7px; height: 7px; background: var(--accent); }
</style>

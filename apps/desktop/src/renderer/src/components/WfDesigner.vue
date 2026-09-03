<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  BaseEdge,
  VueFlow,
  getBezierPath,
  type Connection,
  type EdgeChange,
  type EdgeMouseEvent,
  type NodeChange,
  type NodeDragEvent,
  type NodeMouseEvent,
} from "@vue-flow/core";
import { Button as AButton, Input as AInput, LayoutSider as ALayoutSider, Space as ASpace, Tag as ATag } from "ant-design-vue";
import type { WorkflowStatus } from "@apicc/core";
import type { useWorkflowDesignStore } from "../stores/workflowDesign.js";
import type { useWfListStore } from "../stores/wfList.js";
import type { useWorkspaceStore } from "../stores/workspace.js";
import type { WfBindIndex } from "../wf/wfBindings.js";
import {
  applyEdgeAdd,
  applyEdgeCondition,
  applyEdgeRemove,
  applyNodeAdd,
  applyNodeMove,
  applyNodeRemove,
  applyNodeUpdate,
  toFlowElements,
  type WfNodePatch,
} from "../wf/wfCanvas.js";
import EmptyState from "./EmptyState.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import WfNode from "./WfNode.vue";
import WfPropertyPanel from "./WfPropertyPanel.vue";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";

/**
 * 工作流设计器视图（M2-B 任务 4）：三区装配——顶栏（列表入口/新建/加节点/保存）+
 * 中央 Vue Flow 画布（受控 :nodes/:edges，经 wfCanvas 变换回写 store）+ 右侧属性面板。
 * 组件内零 store 工厂调用（组合根 App.vue 一次创建经 props 下发）；bindIndex（绑定
 * 级联 + 名称索引）由组合根按当前项目树构造后传入。
 * 编辑即整体替换缓冲（store.update），dirty 由快照比对派生；拖拽落点经 applyNodeMove
 * 以新建 position 对象写回（任务 3 交接：阻断 Vue Flow 原地改写共享引用）。
 * 生命周期按钮/运行着色属任务 5/7，此处不装配。
 */
const props = defineProps<{
  workflowDesign: ReturnType<typeof useWorkflowDesignStore>;
  wfList: ReturnType<typeof useWfListStore>;
  workspace: ReturnType<typeof useWorkspaceStore>;
  projectId: string | null;
  bindIndex: WfBindIndex | null;
  reportError: (e: unknown) => void;
}>();
const { t } = useI18n();

const design = computed(() => props.workflowDesign);
const wf = computed(() => props.workflowDesign.workflow);

const newName = ref("");
async function createAndOpen() {
  const name = newName.value.trim();
  if (!name) return;
  try {
    const created = await props.wfList.create(name);
    await props.workflowDesign.load(created.id);
    clearSelection();
    newName.value = "";
  } catch (e) {
    props.reportError(e);
  }
}

async function selectWorkflow(id: string) {
  try {
    await props.workflowDesign.load(id);
    clearSelection();
  } catch (e) {
    props.reportError(e);
  }
}

async function save() {
  try {
    await props.workflowDesign.save();
  } catch (e) {
    props.reportError(e);
  }
}

// —— 画布选中态（属性面板上下文） ——
const selectedNodeId = ref<string | null>(null);
const selectedEdgeId = ref<string | null>(null);
function clearSelection() {
  selectedNodeId.value = null;
  selectedEdgeId.value = null;
}

// —— 工作流列表入口：进入视图/切换项目时拉取（选中与新建即 load 进设计器） ——
// 换项目时先卸载旧项目已载工作流（审查修复：画布不得残留 A 流而绑 B 的索引），
// dirty 时经确认对话框放行；列表拉取不受确认结果影响（树选中项已在新项目）。
const confirmOpen = ref(false);
let pendingAfterUnload: (() => void) | null = null;
function requestUnload(proceed: () => void) {
  const design = props.workflowDesign;
  if (!design.workflow) {
    proceed();
    return;
  }
  if (!design.dirty) {
    design.unload();
    clearSelection();
    proceed();
    return;
  }
  pendingAfterUnload = proceed;
  confirmOpen.value = true;
}
function onDiscardConfirm() {
  props.workflowDesign.unload();
  clearSelection();
  confirmOpen.value = false;
  pendingAfterUnload?.();
  pendingAfterUnload = null;
}
function onDiscardCancel() {
  confirmOpen.value = false;
  pendingAfterUnload = null;
}
/** 顶栏「返回列表」：卸载当前编辑会话回到空态列表（入口常驻可达）。 */
function backToList() {
  requestUnload(() => {});
}

watch(
  () => props.projectId,
  (pid, oldPid) => {
    if (oldPid !== undefined && pid !== oldPid) requestUnload(() => {});
    if (pid && props.wfList.projectId !== pid) props.wfList.load(pid).catch(props.reportError);
  },
  { immediate: true },
);

// —— Workflow ↔ Vue Flow 元素（数据源唯一为 store 缓冲，经 wfCanvas 纯变换） ——
const flowNodes = computed(() => {
  const w = wf.value;
  if (!w) return [];
  const { nodes } = toFlowElements(w, props.bindIndex ? { apiIds: props.bindIndex.apiIds } : undefined);
  // 名称预注入契约：画布节点不做查找，apiName/caseName 在此解析进 data
  return nodes.map((n) => ({
    ...n,
    data: {
      ...n.data,
      apiName: n.data.node.apiId ? props.bindIndex?.apiNames.get(n.data.node.apiId) : undefined,
      caseName: n.data.node.caseId ? props.bindIndex?.caseNames.get(n.data.node.caseId) : undefined,
    },
  }));
});

/** 条件摘要（画布边标签）：截断 24 字符（规格 §4）。 */
function conditionSummary(condition?: string): string {
  if (!condition) return "";
  return condition.length > 24 ? `${condition.slice(0, 24)}…` : condition;
}

const flowEdges = computed(() => {
  const w = wf.value;
  if (!w) return [];
  return toFlowElements(w).edges.map((e) => ({ ...e, label: conditionSummary(e.data.condition) }));
});

const selectedNodeData = computed(() =>
  selectedNodeId.value ? (flowNodes.value.find((n) => n.id === selectedNodeId.value)?.data ?? null) : null,
);
const selectedEdgeData = computed(() =>
  selectedEdgeId.value ? (flowEdges.value.find((e) => e.id === selectedEdgeId.value)?.data ?? null) : null,
);

// —— 画布事件 → wfCanvas 变换 → store 缓冲 ——
function onNodeClick({ node }: NodeMouseEvent) {
  selectedNodeId.value = node.id;
  selectedEdgeId.value = null;
}
function onEdgeClick({ edge }: EdgeMouseEvent) {
  selectedEdgeId.value = edge.id;
  selectedNodeId.value = null;
}

function addNode(kind: "request" | "noop") {
  const w = wf.value;
  if (!w) return;
  design.value.update(
    applyNodeAdd(w, { id: crypto.randomUUID(), kind, label: kind === "request" ? t("wf.newRequest") : t("wf.newNoop") }),
  );
}

function onNodeChange(patch: WfNodePatch) {
  const w = wf.value;
  if (!w || !selectedNodeId.value) return;
  design.value.update(applyNodeUpdate(w, selectedNodeId.value, patch));
}

function removeSelectedNode() {
  const w = wf.value;
  if (!w || !selectedNodeId.value) return;
  design.value.update(applyNodeRemove(w, selectedNodeId.value));
  clearSelection();
}

function onEdgeConditionChange(condition: string) {
  const w = wf.value;
  if (!w || !selectedEdgeId.value) return;
  design.value.update(applyEdgeCondition(w, selectedEdgeId.value, condition));
}

function onConnect({ source, target }: Connection) {
  const w = wf.value;
  if (!w || !source || !target) return;
  // 自环/重复边拒绝在数据层（错误文案统一），此处仅转报
  try {
    design.value.update(applyEdgeAdd(w, { source, target }));
  } catch (e) {
    props.reportError(e);
  }
}

/** 拖拽落点写回：以新建 position 对象替换（浅共享交接，见 applyNodeMove 注释）。 */
function onNodeDragStop({ node }: NodeDragEvent) {
  const w = wf.value;
  if (!w) return;
  design.value.update(applyNodeMove(w, node.id, { x: node.position.x, y: node.position.y }));
}

/** 画布键盘删除（remove 变更）与属性面板删除同一变换；position/select 等变更不回写。 */
function onNodesChange(changes: NodeChange[]) {
  const w = wf.value;
  if (!w) return;
  let next = w;
  for (const c of changes) {
    if (c.type === "remove") next = applyNodeRemove(next, c.id);
  }
  if (next !== w) {
    if (selectedNodeId.value && !next.nodes.some((n) => n.id === selectedNodeId.value)) selectedNodeId.value = null;
    design.value.update(next);
  }
}

function onEdgesChange(changes: EdgeChange[]) {
  const w = wf.value;
  if (!w) return;
  let next = w;
  for (const c of changes) {
    if (c.type === "remove") next = applyEdgeRemove(next, c.id);
  }
  if (next !== w) {
    if (selectedEdgeId.value && !next.edges.some((e) => e.id === selectedEdgeId.value)) selectedEdgeId.value = null;
    design.value.update(next);
  }
}

/** 画布边路径（#edge-wfEdge 插槽）：默认贝塞尔 + 条件摘要标签。 */
function edgeGeom(p: { sourceX: number; sourceY: number; targetX: number; targetY: number }) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX: p.sourceX,
    sourceY: p.sourceY,
    targetX: p.targetX,
    targetY: p.targetY,
  });
  return { path, labelX, labelY };
}

const statusColors: Record<WorkflowStatus, string> = { draft: "", published: "blue", enabled: "green" };
</script>

<template>
  <div class="wf-designer" data-testid="wf-designer">
    <!-- 未选工作流：空态 + 列表入口（项目内工作流的新建与打开） -->
    <div v-if="!wf" class="wf-empty" data-testid="wf-empty">
      <EmptyState :text="t('wf.empty')" />
      <div class="wf-create">
        <a-input
          v-model:value="newName"
          class="wf-new-name"
          data-testid="wf-new-name"
          :placeholder="t('wf.namePlaceholder')"
          @press-enter="createAndOpen"
        />
        <a-button data-testid="wf-new-create" :disabled="!newName.trim()" @click="createAndOpen">
          {{ t("wf.create") }}
        </a-button>
      </div>
      <ul class="wf-items">
        <li v-for="item in wfList.items" :key="item.id">
          <button class="wf-item" data-testid="wf-list-item" :data-id="item.id" @click="selectWorkflow(item.id)">
            <span>{{ item.name }}</span>
            <a-tag :color="statusColors[item.status]" class="wf-item-status">{{ t(`wf.status.${item.status}`) }}</a-tag>
          </button>
        </li>
      </ul>
      <p v-if="wfList.items.length === 0" class="wf-list-empty">{{ t("wf.listEmpty") }}</p>
    </div>

    <template v-else>
      <!-- 顶栏：名称 + 状态 + dirty 圆点 + 节点操作 + 保存 -->
      <div class="wf-topbar" data-testid="wf-topbar">
        <span class="wf-title" data-testid="wf-title">{{ wf.name }}</span>
        <a-tag :color="statusColors[wf.status]" data-testid="wf-status">{{ t(`wf.status.${wf.status}`) }}</a-tag>
        <span v-if="design.dirty" class="wf-dirty" data-testid="wf-dirty" :title="t('wf.unsaved')">●</span>
        <a-button size="small" data-testid="wf-back-to-list" @click="backToList">{{ t("wf.backToList") }}</a-button>
        <a-space class="wf-actions">
          <a-button size="small" data-testid="wf-add-request" @click="addNode('request')">{{ t("wf.addRequest") }}</a-button>
          <a-button size="small" data-testid="wf-add-noop" @click="addNode('noop')">{{ t("wf.addNoop") }}</a-button>
          <a-button size="small" type="primary" data-testid="wf-save" :loading="design.saving" @click="save">
            {{ t("wf.save") }}
          </a-button>
        </a-space>
      </div>

      <div class="wf-body">
        <!-- 中央画布（受控）：数据层唯一来源为 store 缓冲 -->
        <div class="wf-canvas-wrap" data-testid="wf-canvas">
          <VueFlow
            :nodes="flowNodes"
            :edges="flowEdges"
            @node-click="onNodeClick"
            @edge-click="onEdgeClick"
            @pane-click="clearSelection"
            @connect="onConnect"
            @node-drag-stop="onNodeDragStop"
            @nodes-change="onNodesChange"
            @edges-change="onEdgesChange"
          >
            <template #node-wf="nodeProps">
              <WfNode :data="nodeProps.data" />
            </template>
            <template #edge-wfEdge="edgeProps">
              <BaseEdge
                :id="edgeProps.id"
                :path="edgeGeom(edgeProps).path"
                :label-x="edgeGeom(edgeProps).labelX"
                :label-y="edgeGeom(edgeProps).labelY"
                :label="edgeProps.label"
                label-show-bg
              />
            </template>
          </VueFlow>
          <div v-if="flowNodes.length === 0" class="wf-canvas-empty" data-testid="wf-canvas-empty">
            {{ t("wf.canvasEmpty") }}
          </div>
        </div>

        <!-- 右侧属性面板（280px） -->
        <a-layout-sider :width="280" theme="light" class="wf-panel" data-testid="wf-panel">
          <WfPropertyPanel
            :node-data="selectedNodeData"
            :edge-data="selectedEdgeData"
            :bind-options="bindIndex?.options ?? []"
            @node-change="onNodeChange"
            @edge-condition="onEdgeConditionChange"
            @remove-node="removeSelectedNode"
          />
        </a-layout-sider>
      </div>
    </template>

    <!-- 离开确认（返回列表/换项目遇 dirty）：确认丢弃后卸载编辑会话 -->
    <ConfirmDialog :open="confirmOpen" :title="t('wf.discardConfirm')" @confirm="onDiscardConfirm" @cancel="onDiscardCancel" />
  </div>
</template>

<style scoped>
.wf-designer { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.wf-empty { display: flex; flex-direction: column; gap: 12px; padding: 16px; overflow: auto; }
.wf-create { display: flex; gap: 8px; max-width: 420px; }
.wf-items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.wf-item {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--text);
  border-radius: 4px;
  padding: 4px 10px;
  cursor: pointer;
  font-size: 13px;
}
.wf-item:hover { border-color: var(--accent); }
.wf-item-status { margin-right: 0; }
.wf-list-empty { color: var(--text-muted); font-size: 12px; }
.wf-topbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}
.wf-title { font-weight: 600; }
.wf-dirty { color: var(--accent); }
.wf-actions { margin-left: auto; }
.wf-body { display: flex; flex: 1; min-height: 0; }
.wf-canvas-wrap { position: relative; flex: 1; min-width: 0; }
.wf-canvas-wrap :deep(.vue-flow) { width: 100%; height: 100%; }
.wf-canvas-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 13px;
  pointer-events: none;
}
.wf-panel { border-left: 1px solid var(--border); overflow: auto; }
</style>

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
import {
  Alert as AAlert,
  Button as AButton,
  Input as AInput,
  LayoutSider as ALayoutSider,
  Select as ASelect,
  Space as ASpace,
  Tag as ATag,
} from "ant-design-vue";
import type { NodeState, WorkflowStatus } from "@apicc/core";
import type { WorkflowSummary } from "../../../shared/types.js";
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
  nodeStatesFromRunResult,
  toFlowElements,
  type WfNodePatch,
} from "../wf/wfCanvas.js";
import EmptyState from "./EmptyState.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import WfNode from "./WfNode.vue";
import WfPropertyPanel from "./WfPropertyPanel.vue";
import WfResultDrawer from "./WfResultDrawer.vue";
import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";

/**
 * 工作流设计器视图（M2-B 任务 4）：三区装配——顶栏（列表入口/新建/加节点/保存）+
 * 中央 Vue Flow 画布（受控 :nodes/:edges，经 wfCanvas 变换回写 store）+ 右侧属性面板。
 * 组件内零 store 工厂调用（组合根 App.vue 一次创建经 props 下发）；bindIndex（绑定
 * 级联 + 名称索引）由组合根按当前项目树构造后传入。
 * 空态列表（审查 I3）：列表项悬停动作「删除」→ ConfirmDialog 确认后经 wfList.remove
 * 落库并重拉列表（先例同 SideTree 悬停动作钮）；重命名显式延后 M2-C。
 * 编辑即整体替换缓冲（store.update），dirty 由快照比对派生；拖拽落点经 applyNodeMove
 * 以新建 position 对象写回（任务 3 交接：阻断 Vue Flow 原地改写共享引用）。
 * 生命周期（任务 5）：顶栏按钮组 发布/启用/解除启用——可用性随 status 派生（draft→发布、
 * published→启用、enabled→解除启用），dirty 时全组禁用（防 setStatus 成功返回覆盖编辑
 * 缓冲）并以原生 title 提示先保存（与 dirty 圆点同款；禁用态原生 tooltip 仍可见）；
 * 在途迁移经 pendingAction 全组禁用、动作钮 loading。启用校验未过：store.validationErrors
 * 渲染为 a-alert 错误列表（可关闭）。
 * 运行接线（任务 7）：顶栏 运行环境 a-select（选项 = 当前项目树 envs，按名称引用、
 * 首项「无环境」= 不传 envName，先例同 RunView）+「运行」按钮 → design.run(envName?)，
 * loading=design.running（历史落盘由 wf:run 主进程自动完成，UI 不重复写）；运行完成
 * runResult → toFlowElements(workflow, { nodeStates }) 重算画布节点着色 class
 * （nodeStates 由 nodeResults 经 nodeStatesFromRunResult 映射；不触碰 position），
 * 且结果抽屉自动打开（顶栏「结果」按钮可重开）；链路拒绝统一 reportError。
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

// —— 列表项删除（审查 I3：规格 D3 承诺删除/重命名，删除入口在此补齐）——
// 悬停动作钮先例同 SideTree；复用 wfList.remove(id, confirm) 确认回调模式 +
// 既有 ConfirmDialog。删除入口仅在空态列表（未载工作流），不存在「删除正在编辑的流」
// 的会话错位。重命名显式延后：M2-C 与侧树入口同批。
const deleteTarget = ref<WorkflowSummary | null>(null);
const deleteOpen = computed(() => deleteTarget.value !== null);
function askDelete(item: WorkflowSummary) {
  deleteTarget.value = item;
}
function onDeleteCancel() {
  deleteTarget.value = null;
}
async function onDeleteConfirm() {
  const target = deleteTarget.value;
  deleteTarget.value = null;
  if (!target) return;
  try {
    // 已在对话框确认：放行回调恒真（先例同 SideTree 删除）。
    await props.wfList.remove(target.id, async () => true);
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

// —— 生命周期迁移（M2-B 任务 5）：意图 → 目标状态映射（解除启用 = 回 published） ——
type LifecycleAction = "publish" | "enable" | "retract";
const ACTION_TARGET: Record<LifecycleAction, WorkflowStatus> = {
  publish: "published",
  enable: "enabled",
  retract: "published",
};
/** 在途迁移守卫：全组禁用防重复提交，动作钮单独 loading。 */
const pendingAction = ref<LifecycleAction | null>(null);
async function changeStatus(action: LifecycleAction) {
  if (pendingAction.value) return;
  pendingAction.value = action;
  try {
    await props.workflowDesign.setStatus(ACTION_TARGET[action]);
  } catch (e) {
    props.reportError(e);
  } finally {
    pendingAction.value = null;
  }
}

// —— 画布选中态（属性面板上下文） ——
const selectedNodeId = ref<string | null>(null);
const selectedEdgeId = ref<string | null>(null);
function clearSelection() {
  selectedNodeId.value = null;
  selectedEdgeId.value = null;
}

// —— 运行接线（任务 7）：环境选择 + wf:run + 结果抽屉开关 ——
// 环境按名称引用（wf:run 入参 envName），首项「无环境」= 不传 envName（先例同 RunView）；
// 选项 = 当前项目树 envs（workspace/projectId 已在 props，无需另接 envs store）。
const runEnv = ref("");
const projectEnvs = computed<Array<{ id: string; name: string }>>(() => {
  for (const group of props.workspace.tree?.children ?? []) {
    for (const project of group.children ?? []) {
      if (project.id === props.projectId) return project.envs ?? [];
    }
  }
  return [];
});
const runEnvOptions = computed(() => [
  { label: t("wf.envNone"), value: "" },
  ...projectEnvs.value.map((e) => ({ label: e.name, value: e.name })),
]);

/** 结果抽屉开关：运行完成自动打开（裁定）；顶栏「结果」按钮重开；关闭由抽屉 emit。 */
const resultOpen = ref(false);

// 切流（load/unload 改 workflowId）即重置运行会话态：环境选择与抽屉开关不跨流残留
// （残留失效环境名会被主进程「未找到环境」显式拒绝）。编辑不改 workflowId，不重置。
watch(
  () => design.value.workflowId,
  () => {
    runEnv.value = "";
    resultOpen.value = false;
  },
);

/** 顶栏「运行」：design.run 门控 draft/在途（store 内），链路拒绝统一转报错误通道。 */
async function onRun() {
  const targetId = design.value.workflowId;
  try {
    await design.value.run(runEnv.value || undefined);
  } catch (e) {
    props.reportError(e);
    return;
  }
  // 运行完成自动打开结果抽屉；切流守卫同 store（await 期间换流，旧流结果不弹）。
  if (design.value.runResult && design.value.workflowId === targetId) resultOpen.value = true;
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
// 运行着色（任务 7）：runResult.nodeResults → nodeStates（nodeId→state）注入 stateClass
// （colorForState：passed 绿/failed 红/skipped 灰/noop 蓝）；纯重算不触碰 position。
const nodeStates = computed<Map<string, NodeState> | undefined>(() =>
  design.value.runResult ? nodeStatesFromRunResult(design.value.runResult) : undefined,
);
const flowNodes = computed(() => {
  const w = wf.value;
  if (!w) return [];
  const { nodes } = toFlowElements(w, {
    apiIds: props.bindIndex?.apiIds,
    nodeStates: nodeStates.value,
  });
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

/** 生命周期组锁：dirty（防 setStatus 成功覆盖编辑缓冲）/保存或在途迁移时全组禁用。 */
const lifecycleLocked = computed(
  () => design.value.dirty || design.value.saving || pendingAction.value !== null,
);
/** dirty 提示（原生 title，禁用态仍可见）；非 dirty 不出提示。 */
const dirtyHint = computed(() => (design.value.dirty ? t("wf.dirtySaveFirst") : undefined));

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
        <!-- 行内悬停动作钮（审查 I3 删除）：li 承载 hover 显隐，按钮不嵌套在打开列表项内 -->
        <li v-for="item in wfList.items" :key="item.id" class="wf-item-row">
          <button class="wf-item" data-testid="wf-list-item" :data-id="item.id" @click="selectWorkflow(item.id)">
            <span>{{ item.name }}</span>
            <a-tag :color="statusColors[item.status]" class="wf-item-status">{{ t(`wf.status.${item.status}`) }}</a-tag>
          </button>
          <span class="wf-item-actions">
            <button class="wf-item-act danger" data-testid="wf-item-delete" :data-id="item.id" @click="askDelete(item)">
              {{ t("wf.delete") }}
            </button>
          </span>
        </li>
      </ul>
      <p v-if="wfList.items.length === 0" class="wf-list-empty">{{ t("wf.listEmpty") }}</p>
    </div>

    <template v-else>
      <!-- 顶栏：名称 + 状态 + dirty 圆点 + 返回列表 + 节点操作 + 保存 + 生命周期 + 运行门控 -->
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
          <!-- 生命周期组：可用性随 status；dirty/在途时全组禁用（title 仅 dirty 时提示先保存） -->
          <a-button
            size="small"
            data-testid="wf-publish"
            :disabled="lifecycleLocked || wf.status !== 'draft'"
            :loading="pendingAction === 'publish'"
            :title="dirtyHint"
            @click="changeStatus('publish')"
          >
            {{ t("wf.publish") }}
          </a-button>
          <a-button
            size="small"
            data-testid="wf-enable"
            :disabled="lifecycleLocked || wf.status !== 'published'"
            :loading="pendingAction === 'enable'"
            :title="dirtyHint"
            @click="changeStatus('enable')"
          >
            {{ t("wf.enable") }}
          </a-button>
          <a-button
            size="small"
            data-testid="wf-retract"
            :disabled="lifecycleLocked || wf.status !== 'enabled'"
            :loading="pendingAction === 'retract'"
            :title="dirtyHint"
            @click="changeStatus('retract')"
          >
            {{ t("wf.retract") }}
          </a-button>
          <!-- 运行接线（任务 7）：draft 禁用并提示先发布；环境按名称引用（首项=不传 envName） -->
          <a-select
            v-model:value="runEnv"
            class="wf-run-env"
            size="small"
            :options="runEnvOptions"
            data-testid="wf-run-env"
          />
          <a-button
            size="small"
            data-testid="wf-run"
            :disabled="wf.status === 'draft'"
            :loading="design.running"
            :title="wf.status === 'draft' ? t('wf.runDraftDisabled') : undefined"
            @click="onRun"
          >
            {{ t("wf.run") }}
          </a-button>
          <!-- 「结果」：运行结果就绪后可打开结果抽屉（运行完成亦会自动打开） -->
          <a-button
            size="small"
            data-testid="wf-results"
            :disabled="!design.runResult"
            @click="resultOpen = true"
          >
            {{ t("wf.results") }}
          </a-button>
        </a-space>
      </div>

      <!-- 启用校验错误（set-status 返回 errors 非空）：逐条展示，可关闭（store.dismissValidation） -->
      <a-alert
        v-if="design.validationErrors.length > 0"
        class="wf-errors"
        type="error"
        show-icon
        data-testid="wf-errors"
        @close="design.dismissValidation()"
      >
        <template #message>
          <span class="wf-errors-title">{{ t("wf.enableValidationFailed") }}</span>
          <ul class="wf-error-list">
            <li v-for="(err, index) in design.validationErrors" :key="index" data-testid="wf-error-item">{{ err }}</li>
          </ul>
        </template>
        <template #closeText><span data-testid="wf-errors-close">{{ t("common.close") }}</span></template>
      </a-alert>

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

      <!-- 运行结果抽屉（任务 7）：纯展示，开关状态在本组件（运行完成自动打开） -->
      <WfResultDrawer :open="resultOpen" :result="design.runResult" @close="resultOpen = false" />
    </template>

    <!-- 离开确认（返回列表/换项目遇 dirty）：确认丢弃后卸载编辑会话 -->
    <ConfirmDialog :open="confirmOpen" :title="t('wf.discardConfirm')" @confirm="onDiscardConfirm" @cancel="onDiscardCancel" />

    <!-- 列表项删除确认（审查 I3）：确认经 wfList.remove(id, confirm) 放行，取消不动列表 -->
    <ConfirmDialog
      :open="deleteOpen"
      :title="t('wf.deleteConfirm', { name: deleteTarget?.name ?? '' })"
      @confirm="onDeleteConfirm"
      @cancel="onDeleteCancel"
    />
  </div>
</template>

<style scoped>
.wf-designer { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.wf-empty { display: flex; flex-direction: column; gap: 12px; padding: 16px; overflow: auto; }
.wf-create { display: flex; gap: 8px; max-width: 420px; }
.wf-items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
/* 行内悬停动作区（审查 I3 删除钮）：默认隐藏，行悬停显示（先例同 SideTree .actions） */
.wf-item-row { display: flex; align-items: center; gap: 4px; max-width: 420px; }
.wf-item-row .wf-item { flex: 1; }
.wf-item-actions { display: none; flex: none; }
.wf-item-row:hover .wf-item-actions { display: inline-flex; }
.wf-item-act {
  border: none;
  background: none;
  color: var(--text);
  cursor: pointer;
  font-size: 11px;
  padding: 1px 4px;
  border-radius: 3px;
}
.wf-item-act.danger { color: var(--fail); }
.wf-item-act:hover { background: var(--border); }
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
.wf-run-env { width: 120px; }
.wf-errors { margin: 8px 12px 0; }
.wf-errors-title { font-weight: 600; }
.wf-error-list { margin: 4px 0 0; padding-left: 18px; }
.wf-error-list li { word-break: break-all; }
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

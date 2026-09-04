<script setup lang="ts">
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import { Tree as ATree, Button as AButton } from "ant-design-vue";
import type { WorkflowImpactEntry } from "@apicc/core";
import type { ApiccApi } from "../../../shared/types.js";
import type { TreeNodeDTO } from "../../../shared/tree-dto.js";
import type { useWorkspaceStore } from "../stores/workspace.js";
import type { useTreeStore } from "../stores/tree.js";
import type { useWorkflowDesignStore } from "../stores/workflowDesign.js";
import EmptyState from "./EmptyState.vue";
import ConfirmDialog from "./ConfirmDialog.vue";

/**
 * 左侧树：递归结构按 DTO 固定深度展开（分组→项目→集合→[文件夹→]接口；project 末尾
 * 另有由 workflows 摘要合成的工作流叶子，M2-B 收口）。
 * store 经 props 注入（组合根一次装配；组件内部禁止重复调用 store 工厂）。
 * reportError 为组合根注入的最小错误反馈通道（宽审查 I1）：对话框链路的
 * Promise 拒绝统一转报，不再作为未处理 rejection 静默吞没。
 * 选中接口 emit select(kind,id)；创建/重命名复用 ConfirmDialog 输入，删除先经确认。
 * antd 4 落地：树体为 a-tree（受控 expandedKeys/selectedKeys，treeData 由 DTO 构造，
 * key=id、title=label，原始 DTO 挂在节点 dto 字段——#title slot 作用域展开树节点
 * 数据，可直接解构 dto）。折叠/展开钮、动作钮保留在 title slot 内（hover 显隐不变）；
 * a-tree 自带 switcher 缩进箭头经 :deep 样式隐藏，避免与自带折叠钮重复。
 * 在线模式（M3-B 任务 3，裁定 A/E）：treeRoot 注入在线树视图（缺省回退本地工作区树）；
 * readonly=true 时隐藏全部新建/重命名/删除入口（VIEWER 只读装饰），只读配置叶（kind=file）
 * 渲染为无动作叶子，emptyText 注入在线空态文案。本地模式行为不变（不传新 props）。
 */
const props = defineProps<{
  api: ApiccApi;
  workspace: ReturnType<typeof useWorkspaceStore>;
  tree: ReturnType<typeof useTreeStore>;
  /** 工作流设计器会话（审查 I2）：重命名命中设计器正开的流时强制卸载，防缓冲持旧名回滚改名 */
  workflowDesign: ReturnType<typeof useWorkflowDesignStore>;
  reportError: (e: unknown) => void;
  /** 在线树视图（任务 3）：传入即以它为数据源（本地模式不传/undefined → 本地工作区树）。 */
  treeRoot?: TreeNodeDTO | null;
  /** 在线只读装饰：隐藏新建/动作钮，file 叶无动作。 */
  readonly?: boolean;
  /** 空态文案覆写（在线模式给「没有可见内容」文案）。 */
  emptyText?: string;
}>();
const emit = defineEmits<{ select: [kind: TreeNodeDTO["kind"], id: string] }>();
const { t } = useI18n();

// nodeRename/nodeDelete 频道接受的节点 kind（api 树节点；不含 root/workflow）。
type NodeRenameKind = Parameters<ApiccApi["nodeRename"]>[0];

// 折叠集合：默认全部折叠（分组/项目/集合/文件夹）；展开节点时递归展开其后代容器，
// 一次点击即可从分组直达接口。
const expanded = ref(new Set<string>());
const selectedKeys = ref<string[]>([]);

function descendantContainerIds(node: TreeNodeDTO): string[] {
  const ids: string[] = [];
  for (const child of node.children ?? []) {
    // api 与 workflow 均为叶子（workflow 由 project.workflows 摘要合成，不入 children）
    if (child.kind !== "api" && child.kind !== "workflow") ids.push(child.id);
    ids.push(...descendantContainerIds(child));
  }
  return ids;
}

function toggle(node: TreeNodeDTO) {
  const next = new Set(expanded.value);
  if (next.has(node.id)) {
    next.delete(node.id);
  } else {
    next.add(node.id);
    for (const id of descendantContainerIds(node)) next.add(id);
  }
  expanded.value = next;
}

// —— a-tree 数据面：受控 keys + 由 DTO 构造的 treeData（key=id，dto 字段携带原节点） ——
interface TreeDataNode {
  key: string;
  title: string;
  isLeaf: boolean;
  dto: TreeNodeDTO;
  children?: TreeDataNode[];
}
const expandedKeys = computed(() => Array.from(expanded.value));
// 数据源（任务 3）：显式传入 treeRoot（undefined = 本地模式回退本地工作区树；null = 无树）
const rootNode = computed<TreeNodeDTO | null>(() =>
  props.treeRoot !== undefined ? props.treeRoot : props.workspace.tree,
);
// 空态判定：在线模式只看注入的树视图；本地模式保留原语义（opened && tree 双条件）
const isEmpty = computed(() =>
  props.treeRoot !== undefined ? !props.treeRoot : (!props.workspace.opened || !props.workspace.tree),
);
const emptyText = computed(() => props.emptyText ?? t("tree.empty"));
const treeData = computed<TreeDataNode[]>(() => {
  const mapNodes = (nodes?: TreeNodeDTO[]): TreeDataNode[] =>
    (nodes ?? []).map((n) => {
      // M2-B 收口：project 节点在 children 尾部追加工作流叶子（由 workflows 摘要合成，
      // 状态随 DTO 带给色点渲染；树 refresh 后重算，重命名/删除自动反映）。
      const children =
        n.kind === "project"
          ? [
              ...mapNodes(n.children),
              ...(n.workflows ?? []).map((w) => ({
                key: w.id,
                title: w.name,
                isLeaf: true,
                dto: { kind: "workflow" as const, id: w.id, label: w.name, status: w.status },
                children: [],
              })),
            ]
          : mapNodes(n.children);
      return {
        key: n.id,
        title: n.label,
        // file 叶（在线只读配置）与 api/workflow 同为叶子
        isLeaf: n.kind === "api" || n.kind === "workflow" || n.kind === "file",
        dto: n,
        children,
      };
    });
  return mapNodes(rootNode.value?.children);
});

function selectNode(node: TreeNodeDTO) {
  selectedKeys.value = [node.id];
  // 只读模式（在线）：不写本地树选中态，仅向上发选中事件（App 路由到在线编辑链路）
  if (!props.readonly) props.tree.select(node.kind, node.id);
  emit("select", node.kind, node.id);
}

// —— 对话框（创建/重命名/删除共用一个 ConfirmDialog 实例） ——
interface DialogState {
  open: boolean;
  title: string;
  placeholder?: string;
  initialValue?: string;
  /** 任务 6：删除影响命中清单（可选——openDialog 兜底空数组，非删除对话框无此键）。 */
  impact?: WorkflowImpactEntry[];
  run: (value: string | null) => Promise<void> | void;
}
const dialog = ref<DialogState>({ open: false, title: "", impact: [], run: () => {} });

function openDialog(state: Omit<DialogState, "open">) {
  // impact 默认空数组（创建/重命名不传即无影响清单）；state 显式携带时覆盖。
  dialog.value = { impact: [], open: true, ...state };
}

function closeDialog() {
  dialog.value = { ...dialog.value, open: false };
}

async function onDialogConfirm(value: string | null) {
  const run = dialog.value.run;
  closeDialog();
  // 宽审查 I1：先关对话框再执行 run；run 的拒绝统一转报组合根错误展示条，
  // 不再是未处理的 rejection。创建/重命名/删除链路共用此收口点。
  try {
    await run(value);
  } catch (e) {
    props.reportError(e);
  }
}

type CreateKind = "group" | "project" | "collection" | "folder" | "api";

/** 根层新建分组：空工作区没有可悬停的节点，这是分组创建的唯一入口。 */
function startCreateGroup() {
  openDialog({
    title: t("tree.newGroup"),
    placeholder: t("tree.namePlaceholder"),
    run: async (value) => {
      if (!value) return;
      // nodeCreate 返回统一瘦 DTO（kind 必在，宽审查 I2），选中直接用返回值。
      const node = await props.tree.createNode({ kind: "group", parentId: null, name: value });
      emit("select", node.kind, node.id);
    },
  });
}

function startCreate(parent: TreeNodeDTO, kind: CreateKind) {
  const titleKey = { group: "tree.newGroup", project: "tree.newProject", collection: "tree.newCollection", folder: "tree.newFolder", api: "tree.newApi" }[kind];
  openDialog({
    title: t(titleKey),
    placeholder: t("tree.namePlaceholder"),
    run: async (value) => {
      if (!value) return;
      // nodeCreate 返回统一瘦 DTO（kind 必在，宽审查 I2）：选中用返回值的 kind，
      // App 据此对 "api" 加载编辑器。
      const node = await props.tree.createNode({ kind, parentId: parent.id, name: value });
      emit("select", node.kind, node.id);
    },
  });
}

function startRename(node: TreeNodeDTO) {
  openDialog({
    title: t("tree.rename"),
    placeholder: t("tree.namePlaceholder"),
    initialValue: node.label,
    run: async (value) => {
      if (!value) return;
      // renameNode 只接受 api 树 kind（不含 root/workflow）：本函数仅由 api 叶与容器
      // 动作钮触达（workflow 叶走 startWorkflowRename，root 不渲染动作钮），断言恒成立。
      await props.tree.renameNode(node.kind as NodeRenameKind, node.id, value);
    },
  });
}

/**
 * 删除（任务 6 影响提醒）：接口类节点删除前置 api.wfImpact({ apiId }) 反查——
 * 命中时确认对话框内列出「工作流名（状态）— 节点 label」清单（impact-list），
 * 确认才删、取消不删；未命中维持原确认流程（无额外影响清单）。
 * M2-B 简化（控制者裁定）：树 DTO 无用例节点（用例删除在 CasePanel 编辑缓冲内、
 * 随接口保存持久化），故仅 kind=api 查 apiId；folder/集合/项目删除的级联影响提醒
 * 延后，目前仅弹常规确认。反查失败经 reportError 上报并中止删除流程。
 */
async function startDelete(node: TreeNodeDTO) {
  let impact: WorkflowImpactEntry[] = [];
  if (node.kind === "api") {
    try {
      impact = await props.api.wfImpact({ apiId: node.id });
    } catch (e) {
      props.reportError(e);
      return;
    }
  }
  openDialog({
    title: t("tree.deleteConfirm", { name: node.label }),
    impact,
    run: async () => {
      // 已在对话框确认：放行回调恒真。kind 收窄依据同 startRename（workflow 叶走
      // startWorkflowDelete，root 不渲染动作钮）。
      await props.tree.deleteNode(node.kind as NodeRenameKind, node.id, async () => true);
    },
  });
}

// —— 工作流动作（M2-B 收口）：走 wf:rename / wf:delete 专用频道（不经 node:rename 的
// kind 路由——工作流是 project 内的命名目录，重命名需旧目录清理语义），其余链路
// （ConfirmDialog 复用、拒绝经 reportError、refresh 换新树）与既有动作钮同构。重命名
// 后的 status 恒不变（生命周期只经 wf:set-status）；重命名命中设计器正开的流时强制
// unload 会话（审查 I2）。删除暂不清 workflowDesign 会话态（设计器打开中的工作流被
// 侧树删除属边缘路径）——并入 M2-C 跟进：树摘要/wfList/设计器三方同步协议 + dirty 确认。
function startWorkflowRename(node: TreeNodeDTO) {
  openDialog({
    title: t("tree.rename"),
    placeholder: t("tree.namePlaceholder"),
    initialValue: node.label,
    run: async (value) => {
      if (!value) return;
      await props.api.wfRename(node.id, value);
      // 审查 I2：设计器正开着同一工作流时缓冲仍持旧名——此后保存按缓冲整体替换，
      // 改名被静默回滚且树摘要滞留假值。强制卸载会话，下次打开重新 load 拿新名
      // （避免「改了 id 同步、内容半同步」的中间态）。
      if (props.workflowDesign.workflowId === node.id) props.workflowDesign.unload();
      await props.workspace.refresh();
    },
  });
}

function startWorkflowDelete(node: TreeNodeDTO) {
  openDialog({
    title: t("wf.deleteConfirm", { name: node.label }),
    run: async () => {
      // 已在对话框确认：放行回调恒真。
      await props.api.wfDelete(node.id);
      if (props.tree.selected?.id === node.id) props.tree.selected = null;
      await props.workspace.refresh();
    },
  });
}
</script>

<template>
  <aside class="side" data-testid="side-tree">
    <EmptyState v-if="isEmpty || !rootNode" :text="emptyText" />
    <template v-else>
      <div class="root-row">
        <span class="root-label">{{ rootNode.label }}</span>
        <a-button v-if="!readonly" size="small" data-testid="new-group" @click="startCreateGroup">{{ t("tree.newGroup") }}</a-button>
      </div>
      <a-tree
        class="tree"
        :tree-data="treeData"
        :expanded-keys="expandedKeys"
        :selected-keys="selectedKeys"
        :virtual="false"
        block-node
      >
        <template #title="{ dto }">
          <!-- 接口叶子：整行 tree-api-row，选中经 tree-api 按钮 emit select -->
          <div v-if="dto.kind === 'api'" class="node leaf" data-testid="tree-api-row">
            <button class="api-btn" data-testid="tree-api" :data-node-id="dto.id" @click="selectNode(dto)">
              <span class="method">{{ dto.method }}</span>{{ dto.label }}
            </button>
            <span v-if="!readonly" class="actions">
              <button class="act" data-testid="node-rename" @click="startRename(dto)">{{ t("tree.rename") }}</button>
              <button class="act danger" data-testid="node-delete" @click="startDelete(dto)">{{ t("tree.delete") }}</button>
            </span>
          </div>
          <!-- 只读配置叶（M3-B 任务 3）：在线工作区的工作流/环境/项目/集合配置等，仅选中浏览 -->
          <div v-else-if="dto.kind === 'file'" class="node leaf" data-testid="tree-file-row">
            <button class="api-btn file-btn" data-testid="tree-file" :data-node-id="dto.id" @click="selectNode(dto)">
              {{ dto.label }}
            </button>
          </div>
          <!-- 工作流叶子（M2-B 收口）：project children 尾部，label + 状态徽标色点
               （draft 灰/published 蓝/enabled 绿），动作钮 重命名/删除 -->
          <div v-else-if="dto.kind === 'workflow'" class="node leaf" data-testid="tree-workflow-row" :title="t('tree.workflows')">
            <button class="api-btn" data-testid="tree-workflow" :data-node-id="dto.id" :data-status="dto.status" @click="selectNode(dto)">
              <span class="wf-dot" :class="`wf-dot-${dto.status}`" :title="t(`wf.status.${dto.status}`)"></span>{{ dto.label }}
            </button>
            <span v-if="!readonly" class="actions">
              <button class="act" data-testid="node-rename" @click="startWorkflowRename(dto)">{{ t("tree.rename") }}</button>
              <button class="act danger" data-testid="node-delete" @click="startWorkflowDelete(dto)">{{ t("tree.delete") }}</button>
            </span>
          </div>
          <!-- 容器节点：折叠钮 + 悬停动作钮（按层级保留原有钮集合） -->
          <div v-else class="node">
            <button class="toggle" data-testid="tree-group-toggle" @click="toggle(dto)">
              {{ expanded.has(dto.id) ? "▾" : "▸" }}
            </button>
            <span class="label">{{ dto.label }}</span>
            <span v-if="!readonly" class="actions">
              <button v-if="dto.kind === 'group'" class="act" data-testid="new-project" @click="startCreate(dto, 'project')">{{ t("tree.newProject") }}</button>
              <button v-if="dto.kind === 'project'" class="act" data-testid="new-collection" @click="startCreate(dto, 'collection')">{{ t("tree.newCollection") }}</button>
              <button v-if="dto.kind === 'collection'" class="act" data-testid="new-api" @click="startCreate(dto, 'api')">{{ t("tree.newApi") }}</button>
              <button v-if="dto.kind === 'collection'" class="act" data-testid="new-folder" @click="startCreate(dto, 'folder')">{{ t("tree.newFolder") }}</button>
              <button v-if="dto.kind === 'folder'" class="act" data-testid="new-api" @click="startCreate(dto, 'api')">{{ t("tree.newApi") }}</button>
              <button class="act" data-testid="node-rename" @click="startRename(dto)">{{ t("tree.rename") }}</button>
              <button class="act danger" data-testid="node-delete" @click="startDelete(dto)">{{ t("tree.delete") }}</button>
            </span>
          </div>
        </template>
      </a-tree>
    </template>
    <ConfirmDialog
      :open="dialog.open"
      :title="dialog.title"
      :input-placeholder="dialog.placeholder"
      :initial-value="dialog.initialValue"
      @confirm="onDialogConfirm"
      @cancel="closeDialog"
    >
      <!-- 任务 6：删除影响清单（命中时才渲染）——工作流名（状态）— 节点 label -->
      <template v-if="dialog.impact?.length">
        <p class="impact-warning" data-testid="impact-warning">{{ t("tree.impactWarning") }}</p>
        <ul class="impact-list" data-testid="impact-list">
          <li v-for="entry in dialog.impact" :key="`${entry.workflowId}:${entry.nodeId}`">
            {{ entry.workflowName }}（{{ t(`wf.status.${entry.status}`) }}）— {{ entry.nodeLabel ?? entry.nodeId }}
          </li>
        </ul>
      </template>
    </ConfirmDialog>
  </aside>
</template>

<style scoped>
.side {
  height: 100%;
  overflow: auto;
  font-size: 13px;
}
.root-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
}
.root-label {
  font-weight: 600;
  color: var(--text-muted);
}
/* a-tree 自带的缩进箭头与我们的折叠钮重复，隐藏；节点行铺满整行 */
.side :deep(.ant-tree-switcher) { display: none; }
.side :deep(.ant-tree-node-content-wrapper) { flex: 1; min-width: 0; }
.side :deep(.ant-tree-block-node) { width: 100%; }
.side :deep(.ant-tree-indent) { display: none; }
.node {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  border-radius: 4px;
}
.node:hover { background: var(--panel); }
.toggle {
  border: none;
  background: none;
  color: var(--text-muted);
  cursor: pointer;
  width: 16px;
  padding: 0;
}
.label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.actions {
  margin-left: auto;
  display: none;
  gap: 2px;
}
.node:hover .actions { display: inline-flex; }
.act, .api-btn {
  border: none;
  background: none;
  color: var(--text);
  cursor: pointer;
  font-size: 11px;
  padding: 1px 4px;
  border-radius: 3px;
}
.act.danger { color: var(--fail); }
.act:hover { background: var(--border); }
.api-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  padding: 2px 4px;
  min-width: 0;
  text-align: left;
}
.api-btn:hover { background: var(--border); }
/* 在线只读配置叶：弱化字重视觉区分（无动作钮） */
.file-btn {
  color: var(--text-muted);
  font-size: 12px;
}
.method {
  font-size: 10px;
  font-weight: 600;
  color: var(--accent);
}
/* 工作流状态徽标色点（M2-B 收口）：draft 灰/published 蓝/enabled 绿 */
.wf-dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.wf-dot-draft { background: var(--text-muted); }
.wf-dot-published { background: var(--accent); }
.wf-dot-enabled { background: var(--pass); }
/* 删除影响清单（ConfirmDialog 默认插槽内容，随 SideTree 作用域编译） */
.impact-warning {
  margin: 0 0 6px;
  color: var(--fail);
  font-size: 12px;
  line-height: 1.5;
}
.impact-list {
  margin: 0;
  padding-left: 18px;
  max-height: 180px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.7;
}
</style>

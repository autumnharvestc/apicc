<script setup lang="ts">
import { ref, computed, watch, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { Button as AButton, Tree as ATree, Tooltip as ATooltip } from "ant-design-vue";
import { AppstoreOutlined, DeleteOutlined, EditOutlined, FolderOutlined, MoreOutlined, PlusOutlined, ProjectOutlined } from "@ant-design/icons-vue";
import type { WorkflowImpactEntryDTO } from "../../../shared/types.js";
import type { ApiccApi, ContainerTarget, NodeCreateInput, NodeCreatedDTO } from "../../../shared/types.js";
import type { NodeLocator, ProjectLocator } from "../../../shared/locations.js";
import type { LocalTreeNodeDTO, TreeNodeDTO } from "../../../shared/tree-dto.js";
import type { useWorkspaceStore } from "../stores/workspace.js";
import type { useTreeStore } from "../stores/tree.js";
import type { useWorkflowDesignStore } from "../stores/workflowDesign.js";
import type { useModuleMemoryStore } from "../stores/moduleMemory.js";
import EmptyState from "./EmptyState.vue";
import ConfirmDialog from "./ConfirmDialog.vue";
import ContainerManageDialog from "./ContainerManageDialog.vue";
import ActionMenu from "./ActionMenu.vue";

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
  moduleMemory?: ReturnType<typeof useModuleMemoryStore>;
  /** 前端搜索过滤（M8）：按节点 label 不区分大小写过滤；命中节点保留其完整子树，
   * 容器自身未命中但有命中后代时保留为路径；过滤激活时可见容器全部自动展开。 */
  filter?: string;
  /** 活动项目（M9-C 层级调整）：本地模式传入即把树作用域化至该项目子树
   * （工作区顶层即项目；分组层在主页管理）。空/未选 = 空态提示选择项目。 */
  activeProjectLocator?: ProjectLocator | null;
  showCreateInHeader?: boolean;
  compact?: boolean;
  hidden?: boolean;
}>();
const emit = defineEmits<{ select: [node: TreeNodeDTO | NodeCreatedDTO] }>();
const { t } = useI18n();

// nodeRename/nodeDelete 频道接受的节点 kind（api 树节点；不含 root/workflow）。
// 折叠集合：默认读取上次会话（M11 侧栏状态重启保留），展开节点时递归展开其后代容器，
// 一次点击即可从分组直达接口；变化即落 localStorage（应用本地，不进工作区文件）。
const expanded = ref(new Set<string>(props.moduleMemory?.apiTree.expanded ?? []));
const isReadOnly = computed(() => !!props.readonly || (props.treeRoot === undefined && props.workspace.readOnly));
const selectedKeys = ref<string[]>([]);
const directory = ref<HTMLElement>();
let returnFocus: HTMLElement | null = null;
watch(() => props.tree.selected?.key ?? null, (key) => { selectedKeys.value = key ? [key] : []; }, { immediate: true });
watch(() => props.moduleMemory?.apiTree.expanded, (keys) => {
  if (!props.treeRoot && props.activeProjectLocator) expanded.value = new Set(keys ?? []);
}, { deep: true, immediate: true });

function descendantContainerIds(node: TreeNodeDTO): string[] {
  const ids: string[] = [];
  for (const child of node.children ?? []) {
    // api 与 workflow 均为叶子（workflow 由 project.workflows 摘要合成，不入 children）
    if (child.kind !== "api" && child.kind !== "workflow") ids.push(child.key);
    ids.push(...descendantContainerIds(child));
  }
  return ids;
}

function toggle(node: TreeNodeDTO, opening = !expanded.value.has(node.key)) {
  const next = new Set(expanded.value);
  if (!opening) {
    next.delete(node.key);
  } else {
    next.add(node.key);
    for (const id of descendantContainerIds(node)) next.add(id);
  }
  expanded.value = next;
  if (props.treeRoot === undefined && props.activeProjectLocator && props.moduleMemory) {
    props.moduleMemory.apiTree.expanded = [...next];
    props.moduleMemory.touch();
  }
}
function expandTreeNode(_keys: (string | number)[], event: { node: object; expanded: boolean }) {
  const node = event.node as { dto?: TreeNodeDTO };
  if (node.dto) toggle(node.dto, event.expanded);
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
// 数据源（任务 3）：显式传入 treeRoot（undefined = 本地模式回退本地工作区树；null = 无树）。
// M9-C 作用域化：本地模式且完整 activeProjectLocator 命中时，根 = 该项目节点（顶层即项目；
// 分组层不进侧树，在主页管理）。在线模式不受影响。
const activeProjectNode = computed<TreeNodeDTO | null>(() => {
  if (props.treeRoot !== undefined || !props.activeProjectLocator) return null;
  return props.workspace.findProject(props.activeProjectLocator);
});
const scoped = computed(() => props.treeRoot === undefined && activeProjectNode.value !== null);
const rootNode = computed<TreeNodeDTO | null>(() => {
  if (props.treeRoot !== undefined) return props.treeRoot;
  if (activeProjectNode.value) return activeProjectNode.value;
  return props.workspace.tree;
});
// 空态判定：在线模式只看注入的树视图；本地模式保留原语义 + 作用域开启但未选项目时空态提示
const isEmpty = computed(() => {
  if (props.treeRoot !== undefined) return !props.treeRoot;
  if (!props.workspace.opened || !props.workspace.tree) return true;
  if (props.activeProjectLocator != null && !activeProjectNode.value) return true;
  return false;
});
const emptyText = computed(() => props.emptyText ?? t("tree.empty"));
const treeData = computed<TreeDataNode[]>(() => {
  const mapNodes = (nodes?: TreeNodeDTO[]): TreeDataNode[] =>
    (nodes ?? []).map((n) => {
      // M2-B 收口：project 节点在 children 尾部追加工作流叶子（由 workflows 摘要合成，
      // 状态随 DTO 带给色点渲染；树 refresh 后重算，重命名/删除自动反映）。
      const children =
        n.source === "local" && n.kind === "project"
          ? [
              ...mapNodes(n.children),
              ...(n.workflows ?? []).map((w) => ({
                key: w.key,
                title: w.name,
                isLeaf: true,
                dto: { source: "local" as const, kind: "workflow" as const, id: w.id, key: w.key, locator: { ...w.locator }, label: w.name, status: w.status },
                children: [],
              })),
            ]
          : mapNodes(n.children);
      return {
        key: n.key,
        title: n.label,
        // file 叶（在线只读配置）与 api/workflow 同为叶子
        isLeaf: n.kind === "api" || n.kind === "workflow" || n.kind === "file",
        dto: n,
        children,
      };
    });
  // 作用域化：项目节点本身作为顶层容器过 mapNodes——project.workflows 叶合成逻辑同口径复用。
  const all = mapNodes(scoped.value && rootNode.value ? [rootNode.value] : rootNode.value?.children);
  // 搜索过滤（M8）：label 不区分大小写；命中保留完整子树，未命中但有命中后代则保留为路径
  const kw = props.filter?.trim().toLowerCase();
  if (!kw) return all;
  const prune = (nodes: TreeDataNode[]): TreeDataNode[] =>
    nodes.flatMap((n) => {
      const self = n.title.toLowerCase().includes(kw);
      const children = prune(n.children ?? []);
      if (!self && children.length === 0) return [];
      return [{ ...n, children: self ? (n.children ?? []) : children }];
    });
  return prune(all);
});
// 展开集合持久化（M11）：序列化比对避免同值重写
watch(
  () => JSON.stringify([...expanded.value].sort()),
  () => {
    if (props.treeRoot === undefined && props.activeProjectLocator && props.moduleMemory) {
      props.moduleMemory.apiTree.expanded = [...expanded.value];
      props.moduleMemory.touch();
    }
  },
);

// 过滤激活时可见容器全部展开（否则命中叶子的祖先链处于折叠态，过滤结果不可见）
const effectiveExpandedKeys = computed(() => {
  const keys = new Set(expanded.value);
  // 作用域化：项目根（顶层即项目）恒展开，集合层直接可见
  if (scoped.value && rootNode.value) keys.add(rootNode.value.key);
  // 搜索过滤激活：可见容器全部自动展开（否则命中叶子的祖先链折叠，结果不可见）
  if (!props.filter?.trim()) return Array.from(keys);
  const collect = (nodes: TreeDataNode[]) => {
    for (const n of nodes) {
      if (!n.isLeaf) {
        keys.add(n.key);
        collect(n.children ?? []);
      }
    }
  };
  collect(treeData.value);
  return Array.from(keys);
});
// 节点 label 是否处于过滤命中（过滤激活且当前节点被剪枝掉 → 空态提示「无匹配」）
const filterNoMatch = computed(
  () => !!props.filter?.trim() && treeData.value.length === 0,
);
const createTarget = computed<TreeNodeDTO | null>(() => {
  if (isReadOnly.value || !rootNode.value) return null;
  const selected = props.tree.selected?.key;
  function findTarget(node: TreeNodeDTO, parent: TreeNodeDTO | null): TreeNodeDTO | null {
    if (node.key === selected) return node.kind === "api" ? parent : node;
    for (const child of node.children ?? []) {
      const found = findTarget(child, node);
      if (found) return found;
    }
    return null;
  }
  const target = findTarget(rootNode.value, null);
  return target?.kind === "workflow" ? rootNode.value : target ?? rootNode.value;
});
const createItems = computed(() => createTarget.value ? nodeCreateItems(createTarget.value) : []);

function selectNode(node: TreeNodeDTO) {
  selectedKeys.value = [node.key];
  if (node.source === "local") {
    props.tree.select(node);
    if (node.kind === "api" && props.moduleMemory) {
      props.moduleMemory.apiTree.lastApiLocator = { ...node.locator, folderIds: [...node.locator.folderIds] };
      props.moduleMemory.touch();
    }
  }
  emit("select", node);
}
function selectTreeNode(_keys: (string | number)[], event: { node: object }) {
  const node = event.node as { dto?: TreeNodeDTO };
  if (node.dto) selectNode(node.dto);
}

function nodeCreateItems(node: TreeNodeDTO) {
  const kinds: CreateKind[] = node.kind === "root" ? ["group"] : node.kind === "group" ? ["project"]
    : node.kind === "project" ? ["collection"] : node.kind === "collection" || node.kind === "folder" ? ["api", "folder"] : [];
  const titles = { group: "tree.newGroup", project: "tree.newProject", collection: "tree.newCollection", folder: "tree.newFolder", api: "tree.newApi" };
  return kinds.map((kind) => ({ key: kind, label: t(titles[kind]), testId: `new-${kind}` }));
}

function rowMenuItems(node: TreeNodeDTO) {
  const container = node.kind === "collection" || node.kind === "folder";
  return [
    ...(container ? [{ key: "manage", label: t("container.manage"), testId: "container-manage" }] : []),
    ...nodeCreateItems(node),
    ...(props.compact ? [
      { key: "rename", label: t("tree.renameTooltip"), testId: "node-rename" },
      { key: "delete", label: t("tree.deleteTooltip"), testId: "node-delete" },
    ] : []),
  ];
}

function runNodeAction(node: TreeNodeDTO | null, action: string) {
  if (!node || isReadOnly.value || props.hidden) return;
  if (action === "manage") openManage(node);
  else if (action === "rename") node.kind === "workflow" ? startWorkflowRename(node) : startRename(node);
  else if (action === "delete") node.kind === "workflow" ? startWorkflowDelete(node) : startDelete(node);
  else if (action === "group") startCreateGroup();
  else if (action === "project" || action === "collection" || action === "api" || action === "folder") startCreate(node, action);
}

function rememberActionFocus() {
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

function restoreActionFocus() {
  const origin = returnFocus;
  returnFocus = null;
  void nextTick(() => {
    const target = origin?.isConnected && origin.getClientRects().length ? origin
      : directory.value?.querySelector<HTMLElement>(".node.selected .row-title, .node .row-title") ?? directory.value;
    target?.focus({ preventScroll: true });
  });
}

// —— 容器管理对话框（M10）：以完整 ContainerTarget 定位，不接受裸 kind/id ——
const manageState = ref<{ open: boolean; target: ContainerTarget | null; name: string }>({ open: false, target: null, name: "" });
function openManage(node: TreeNodeDTO) {
  if (node.source !== "local" || (node.kind !== "collection" && node.kind !== "folder")) return;
  rememberActionFocus();
  manageState.value = {
    open: true,
    target: node.kind === "collection"
      ? { kind: "collection", locator: { ...node.locator } }
      : { kind: "folder", locator: { ...node.locator, folderIds: [...node.locator.folderIds] } },
    name: node.label,
  };
}

// —— 对话框（创建/重命名/删除共用一个 ConfirmDialog 实例） ——
interface DialogState {
  open: boolean;
  title: string;
  placeholder?: string;
  initialValue?: string;
  /** 任务 6：删除影响命中清单（可选——openDialog 兜底空数组，非删除对话框无此键）。 */
  impact?: WorkflowImpactEntryDTO[];
  run: (value: string | null) => Promise<void> | void;
}
const dialog = ref<DialogState>({ open: false, title: "", impact: [], run: () => {} });

function openDialog(state: Omit<DialogState, "open">) {
  rememberActionFocus();
  // impact 默认空数组（创建/重命名不传即无影响清单）；state 显式携带时覆盖。
  dialog.value = { impact: [], open: true, ...state };
}

function closeDialog() {
  dialog.value = { ...dialog.value, open: false };
  restoreActionFocus();
}

async function onDialogConfirm(value: string | null) {
  const run = dialog.value.run;
  dialog.value = { ...dialog.value, open: false };
  // 宽审查 I1：先关对话框再执行 run；run 的拒绝统一转报组合根错误展示条，
  // 不再是未处理的 rejection。创建/重命名/删除链路共用此收口点。
  try {
    await run(value);
  } catch (e) {
    props.reportError(e);
  } finally {
    restoreActionFocus();
  }
}

type CreateKind = "group" | "project" | "collection" | "folder" | "api";

/** 根层新建分组：空工作区没有可悬停的节点，这是分组创建的唯一入口。 */
function startCreateGroup() {
  if (isReadOnly.value) return;
  const root = props.workspace.root;
  const rootNode = props.workspace.tree;
  openDialog({
    title: t("tree.newGroup"),
    placeholder: t("tree.namePlaceholder"),
    run: async (value) => {
      if (!value) return;
      if (!root || !rootNode || root !== props.workspace.root || rootNode !== props.workspace.tree) return;
      const node = await props.tree.createNode({ kind: "group", parent: { ...rootNode.locator }, name: value });
      if (props.workspace.root === root) emit("select", node);
    },
  });
}

function startCreate(parent: TreeNodeDTO, kind: CreateKind) {
  if (isReadOnly.value) return;
  const root = props.workspace.root;
  const titleKey = { group: "tree.newGroup", project: "tree.newProject", collection: "tree.newCollection", folder: "tree.newFolder", api: "tree.newApi" }[kind];
  openDialog({
    title: t(titleKey),
    placeholder: t("tree.namePlaceholder"),
    run: async (value) => {
      if (!value) return;
      if (root !== props.workspace.root || parent.source !== "local") return;
      const input = createInput(parent, kind, value);
      if (!input) throw new Error(`不支持在 ${parent.kind} 下创建 ${kind}`);
      const node = await props.tree.createNode(input);
      if (props.workspace.root === root) emit("select", node);
    },
  });
}

function createInput(parent: Extract<TreeNodeDTO, { source: "local" }>, kind: CreateKind, name: string): NodeCreateInput | null {
  if (kind === "project" && parent.kind === "group") return { kind, parent: { ...parent.locator }, name };
  if (kind === "collection" && parent.kind === "project") return { kind, parent: { ...parent.locator }, name };
  if (kind === "folder" && parent.kind === "collection") return { kind, parent: { ...parent.locator }, name };
  if (kind === "folder" && parent.kind === "folder") return { kind, parent: { ...parent.locator, folderIds: [...parent.locator.folderIds] }, name };
  if (kind === "api" && parent.kind === "collection") return { kind, parent: { ...parent.locator }, api: { name, protocol: "http", method: "GET", baseUrl: "", path: "/" } };
  if (kind === "api" && parent.kind === "folder") return { kind, parent: { ...parent.locator, folderIds: [...parent.locator.folderIds] }, api: { name, protocol: "http", method: "GET", baseUrl: "", path: "/" } };
  return null;
}

function startRename(node: TreeNodeDTO) {
  if (isReadOnly.value) return;
  if (node.source !== "local" || node.kind === "root" || node.kind === "workflow") return;
  const root = props.workspace.root;
  openDialog({
    title: t("tree.rename"),
    placeholder: t("tree.namePlaceholder"),
    initialValue: node.label,
    run: async (value) => {
      if (!value) return;
      if (root !== props.workspace.root) return;
      await props.tree.renameNode(locatorForNode(node), value);
    },
  });
}

/**
 * 删除（任务 6 影响提醒）：接口类节点删除前置 api.wfImpact(完整 ApiLocator) 反查——
 * 命中时确认对话框内列出「工作流名（状态）— 节点 label」清单（impact-list），
 * 确认才删、取消不删；未命中维持原确认流程（无额外影响清单）。
 * M2-B 简化（控制者裁定）：树 DTO 无用例节点（用例删除在 CasePanel 编辑缓冲内、
 * 随接口保存持久化），故仅 kind=api 查 apiId；folder/集合/项目删除的级联影响提醒
 * 延后，目前仅弹常规确认。反查失败经 reportError 上报并中止删除流程。
 */
async function startDelete(node: TreeNodeDTO) {
  if (isReadOnly.value) return;
  if (node.source !== "local" || node.kind === "root" || node.kind === "workflow") return;
  const root = props.workspace.root;
  const target = locatorForNode(node);
  let impact: WorkflowImpactEntryDTO[] = [];
  if (target.kind === "api") {
    try {
      impact = await props.api.wfImpact({ ...target.locator });
    } catch (e) {
      props.reportError(e);
      return;
    }
    if (props.workspace.root !== root) return;
  }
  openDialog({
    title: t("tree.deleteConfirm", { name: node.label }),
    impact,
    run: async () => {
      if (props.workspace.root !== root) return;
      await props.tree.deleteNode(target, async () => true);
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
  if (isReadOnly.value) return;
  if (node.source !== "local" || node.kind !== "workflow") return;
  const root = props.workspace.root;
  openDialog({
    title: t("tree.rename"),
    placeholder: t("tree.namePlaceholder"),
    initialValue: node.label,
    run: async (value) => {
      if (!value) return;
      if (props.workspace.root !== root) return;
      const locator = { ...node.locator };
      await props.api.wfRename(locator, value);
      if (props.workspace.root !== root) return;
      // 审查 I2：设计器正开着同一工作流时缓冲仍持旧名——此后保存按缓冲整体替换，
      // 改名被静默回滚且树摘要滞留假值。强制卸载会话，下次打开重新 load 拿新名
      // （避免「改了 id 同步、内容半同步」的中间态）。
      if (JSON.stringify(props.workflowDesign.locator) === JSON.stringify(locator)) props.workflowDesign.unload();
      await props.workspace.refresh();
    },
  });
}

function startWorkflowDelete(node: TreeNodeDTO) {
  if (isReadOnly.value) return;
  if (node.source !== "local" || node.kind !== "workflow") return;
  const root = props.workspace.root;
  openDialog({
    title: t("wf.deleteConfirm", { name: node.label }),
    run: async () => {
      if (props.workspace.root !== root) return;
      // 已在对话框确认：放行回调恒真。
      await props.api.wfDelete({ ...node.locator });
      if (props.workspace.root !== root) return;
      if (props.tree.selected?.key === node.key) props.tree.selected = null;
      await props.workspace.refresh();
    },
  });
}

function locatorForNode(node: Extract<LocalTreeNodeDTO, { kind: "group" | "project" | "collection" | "folder" | "api" }>): NodeLocator {
  switch (node.kind) {
    case "group": return { kind: "group", locator: { ...node.locator } };
    case "project": return { kind: "project", locator: { ...node.locator } };
    case "collection": return { kind: "collection", locator: { ...node.locator } };
    case "folder": return { kind: "folder", locator: { ...node.locator, folderIds: [...node.locator.folderIds] } };
    case "api": return { kind: "api", locator: { ...node.locator, folderIds: [...node.locator.folderIds] } };
  }
}
</script>

<template>
  <aside ref="directory" class="side" :class="{ compact }" tabindex="-1" data-testid="side-tree">
    <div v-if="showCreateInHeader" class="directory-header">
      <div class="directory-heading">
        <span class="sider-title" data-testid="sider-title">{{ t("workbench.directory") }}</span>
        <ActionMenu v-if="createTarget && createItems.length" :key="createTarget.key"
          test-id="directory-create" :label="t('workbench.createIn', { name: createTarget.label })" :items="createItems"
          :hidden="hidden"
          @select="runNodeAction(createTarget, $event)">
          <PlusOutlined />
        </ActionMenu>
      </div>
      <slot name="search" />
    </div>
    <div class="directory-tree">
      <EmptyState v-if="isEmpty || !rootNode" :text="emptyText" />
      <EmptyState v-else-if="filterNoMatch" :text="t('tree.noMatch')" />
      <template v-else>
        <div v-if="!scoped" class="root-row">
          <span class="root-label" :title="rootNode.label">{{ rootNode.label }}</span>
          <a-button v-if="!showCreateInHeader && !isReadOnly" size="small" data-testid="new-group" @click="startCreateGroup">{{ t("tree.newGroup") }}</a-button>
        </div>
        <a-tree :key="rootNode.key" class="tree" :tree-data="treeData" :expanded-keys="effectiveExpandedKeys" :selected-keys="selectedKeys" :virtual="false" block-node @select="selectTreeNode" @expand="expandTreeNode">
          <template #title="{ dto }">
            <div class="node" :class="{ selected: selectedKeys.includes(dto.key) }"
              :data-testid="dto.kind === 'api' ? 'tree-api-row' : dto.kind === 'workflow' ? 'tree-workflow-row' : dto.kind === 'file' ? 'tree-file-row' : undefined">
              <button v-if="dto.kind !== 'api' && dto.kind !== 'file' && dto.kind !== 'workflow'"
                type="button" class="toggle" data-testid="tree-group-toggle" :aria-expanded="effectiveExpandedKeys.includes(dto.key)"
                :title="t('workbench.toggleNode', { name: dto.label })" :aria-label="t('workbench.toggleNode', { name: dto.label })" @click.stop="toggle(dto)">
                {{ effectiveExpandedKeys.includes(dto.key) ? "▾" : "▸" }}
              </button>
              <AppstoreOutlined v-if="dto.kind === 'collection'" class="kind-icon mod" />
              <FolderOutlined v-else-if="dto.kind === 'folder'" class="kind-icon" />
              <ProjectOutlined v-else-if="dto.kind === 'project'" class="kind-icon" />
              <a-tooltip :title="dto.label" :trigger="['focus']" placement="right">
                <button type="button" class="row-title"
                :data-testid="dto.kind === 'api' ? 'tree-api' : dto.kind === 'workflow' ? 'tree-workflow' : dto.kind === 'file' ? 'tree-file' : undefined"
                :data-node-id="dto.id" :data-status="dto.kind === 'workflow' ? dto.status : undefined" :title="dto.label"
                :aria-label="dto.kind === 'workflow' ? dto.label + ' · ' + t(`wf.status.${dto.status}`) : undefined"
                  @click.stop="selectNode(dto)" @keydown.enter.stop @keydown.space.stop>
                  <span v-if="dto.kind === 'api' && dto.method" class="method" :class="`m-${dto.method.toLowerCase()}`">{{ dto.method }}</span>
                  <span v-if="dto.kind === 'workflow'" class="wf-dot" :class="`wf-dot-${dto.status}`" :title="t(`wf.status.${dto.status}`)"></span>
                  <span :class="dto.kind === 'api' ? 'api-name' : 'label'" :title="dto.label">{{ dto.label }}</span>
                </button>
              </a-tooltip>
              <span v-if="!isReadOnly && dto.kind !== 'file'" class="action-rail" @click.stop @keydown.stop>
                <ActionMenu v-if="rowMenuItems(dto).length" class="icon-action more-trigger"
                  test-id="tree-more" :label="t('tree.moreActions')" :items="rowMenuItems(dto)"
                  :hidden="hidden"
                  @select="runNodeAction(dto, $event)">
                  <MoreOutlined />
                </ActionMenu>
                <template v-if="!compact">
                  <button type="button" class="icon-action" data-testid="node-rename" :aria-label="t('tree.renameTooltip')" :title="t('tree.renameTooltip')" @click.stop="runNodeAction(dto, 'rename')"><EditOutlined /></button>
                  <button type="button" class="icon-action danger" data-testid="node-delete" :aria-label="t('tree.deleteTooltip')" :title="t('tree.deleteTooltip')" @click.stop="runNodeAction(dto, 'delete')"><DeleteOutlined /></button>
                </template>
              </span>
            </div>
          </template>
        </a-tree>
      </template>
    </div>
    <ContainerManageDialog
      v-if="manageState.open && manageState.target"
      :api="api"
      :target="manageState.target"
      :name="manageState.name"
      :read-only="workspace.readOnly"
      :report-error="reportError"
      @close="manageState.open = false; restoreActionFocus()"
      @saved="workspace.refresh().catch(() => undefined)"
    />
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
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  font-size: 13px;
}
.directory-header { flex: none; padding: 6px 8px 8px; }
.directory-heading { display: flex; align-items: center; justify-content: space-between; gap: 4px; min-height: 32px; }
.sider-title { font-weight: 600; }
.directory-tree { flex: 1; min-height: 0; overflow: auto; scrollbar-width: thin; }
.root-row { display: flex; align-items: center; gap: 6px; padding: 4px 8px; }
.root-label { font-weight: 600; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side :deep(.ant-tree) { background: transparent; color: var(--text); }
.side :deep(.ant-tree-switcher) { display: none; }
.side :deep(.ant-tree-indent) { flex: 0 0 auto; max-width: 36px; overflow: hidden; }
.side :deep(.ant-tree-indent-unit) { width: 9px; }
.side :deep(.ant-tree-treenode) { padding: 0; }
.side :deep(.ant-tree-node-content-wrapper) { flex: 1; min-width: 0; padding: 0; }
.side :deep(.ant-tree-node-content-wrapper:hover),
.side :deep(.ant-tree-node-content-wrapper.ant-tree-node-selected) { background: transparent; }
.side :deep(.ant-tree-block-node) { width: 100%; }
.side.compact :deep(.ant-tree-indent) { max-width: 32px; }
.side.compact :deep(.ant-tree-indent-unit) { width: 8px; }
.node {
  display: flex;
  align-items: center;
  gap: 3px;
  height: 32px;
  min-width: 0;
  padding: 0 4px;
  box-sizing: border-box;
  border-radius: 5px;
}
.node:hover, .node:focus-within { background: var(--hover); }
.node.selected { background: var(--workbench-directory-selected); }
.toggle, .row-title, .icon-action {
  border: 0;
  background: none;
  color: inherit;
  cursor: pointer;
  font: inherit;
  padding: 0;
}
.toggle { width: 16px; flex: 0 0 16px; color: var(--text-muted); }
.row-title {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  flex: 1 1 auto;
  min-width: 0;
  text-align: start;
  border-radius: 3px;
}
.label, .api-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kind-icon { flex: none; font-size: 13px; color: var(--text-muted); }
.kind-icon.mod { color: var(--accent); }
.action-rail { display: flex; flex: none; align-items: center; }
.action-rail > .icon-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 28px;
  width: 28px;
  min-width: 0;
  height: 28px;
  min-height: 0;
  color: var(--text-muted);
  border-radius: 4px;
  opacity: 0;
  pointer-events: none;
}
.node.selected .icon-action,
.node:hover .icon-action,
.node:focus-within .icon-action,
.icon-action[aria-expanded="true"] { opacity: 1; pointer-events: auto; }
.icon-action:hover, .icon-action:focus-visible { background: var(--border); }
.icon-action.danger { color: var(--fail); }
@media (hover: none) { .icon-action { opacity: 1; pointer-events: auto; } }
@media (forced-colors: active) { .node.selected { outline: 1px solid Highlight; outline-offset: -1px; } }
.method {
  flex: 0 0 auto;
  font-size: 10px;
  font-weight: 600;
  color: var(--accent);
}
/* M8：方法语义色徽标（与调试 URL 栏方法着色同表） */
.method.m-get { color: var(--pass); }
.method.m-post { color: var(--workbench-method-post); }
.method.m-put { color: var(--accent); }
.method.m-patch { color: var(--workbench-method-patch); }
.method.m-delete { color: var(--fail); }
.method.m-head,
.method.m-options { color: var(--text-muted); }
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

import type { NodeState, Workflow, WorkflowEdge, WorkflowNode } from "@apicc/core";

/**
 * 工作流画布纯函数数据层（M2-B 任务 3，TDD 主战场）：Workflow ↔ Vue Flow 元素
 * 双向转换、编辑变换（增删节点/边）、运行状态着色映射。全部为纯数据运算，
 * 不依赖 Vue Flow 运行时（组件层任务 4 以受控 props 消费本模块输出形状）。
 *
 * 契约锁定（任务 7 消费）：
 * - toFlowElements(workflow, { apiIds?, nodeStates? }) → { nodes, edges }；
 * - colorForState(state?) → "wf-node-passed" | "wf-node-failed" | "wf-node-skipped" | "wf-node-noop" | ""；
 * - 编辑变换不可变：spread 返回新 Workflow 缓冲，原对象（含其 nodes/edges 数组）不动，
 *   供 store.update() 整体替换编辑缓冲（workflowDesign store 的 dirty 快照比对依赖换引用）。
 */

/** 运行着色 CSS 类名（画布节点 class，任务 7 按运行结果注入）。 */
export type WfStateClass = "wf-node-passed" | "wf-node-failed" | "wf-node-skipped" | "wf-node-noop" | "";

/** 画布节点自定义 data（WfNode.vue props 消费）。 */
export interface WfNodeData {
  node: WorkflowNode;
  /** request 节点引用的 apiId 不在当前项目接口集合内（红框标注）；noop 恒 false。 */
  missing: boolean;
  stateClass: WfStateClass;
  /**
   * 接口名/用例名（任务 4 预注入契约）：由调用方在 toFlowElements 之后按名称索引解析
   * 填入，画布节点组件不做查找（简报裁定：resolve 移出画布）。
   */
  apiName?: string;
  caseName?: string;
}

/** 画布边自定义 data（属性面板编辑 condition 时回写 applyEdgeAdd/缓冲用）。 */
export interface WfEdgeData {
  condition?: string;
  edge: WorkflowEdge;
}

/** Vue Flow 节点形状（type "wf" = 自定义节点组件插槽 #node-wf）。 */
export interface WfFlowNode {
  id: string;
  type: "wf";
  position: { x: number; y: number };
  data: WfNodeData;
}

/** Vue Flow 边形状（type "wfEdge" 预留给条件标签渲染）。 */
export interface WfFlowEdge {
  id: string;
  source: string;
  target: string;
  type: "wfEdge";
  data: WfEdgeData;
}

export interface ToFlowElementsOptions {
  /** 当前项目全部接口 id 集合：request 节点引用不在集合内时 missing=true。 */
  apiIds?: Set<string>;
  /** 运行结果 nodeId → 状态映射：注入节点着色 class（任务 7 消费）。 */
  nodeStates?: Map<string, NodeState>;
}

/** 状态 → CSS 类名映射；无状态（未运行/结果未覆盖）返回空串（不着色）。 */
export function colorForState(state?: NodeState): WfStateClass {
  switch (state) {
    case "passed":
      return "wf-node-passed";
    case "failed":
      return "wf-node-failed";
    case "skipped":
      return "wf-node-skipped";
    case "noop":
      return "wf-node-noop";
    default:
      return "";
  }
}

/** Workflow → Vue Flow 元素（纯转换：不修改入参，输出 data 持有原始 node/edge 引用）。 */
export function toFlowElements(
  workflow: Workflow,
  opts?: ToFlowElementsOptions,
): { nodes: WfFlowNode[]; edges: WfFlowEdge[] } {
  return {
    nodes: workflow.nodes.map((node) => ({
      id: node.id,
      type: "wf" as const,
      // position 在模型上可选（画布新增节点由 applyNodeAdd 补齐；手工数据兜底原点）。
      position: node.position ?? { x: 0, y: 0 },
      data: {
        node,
        missing: node.kind === "request" && opts?.apiIds ? !opts.apiIds.has(node.apiId ?? "") : false,
        stateClass: colorForState(opts?.nodeStates?.get(node.id)),
      },
    })),
    edges: workflow.edges.map((edge) => ({
      id: edge.id,
      source: edge.from,
      target: edge.to,
      type: "wfEdge" as const,
      data: { condition: edge.condition, edge },
    })),
  };
}

/** 画布缺省网格摆放：每行 5 列，列距 220 / 行距 160（拖拽后由 position 持久化覆盖）。 */
function defaultPosition(index: number): { x: number; y: number } {
  return { x: (index % 5) * 220, y: Math.floor(index / 5) * 160 };
}

/** 追加节点（不可变）：position 缺省时按网格摆放补齐，不改动入参 node。 */
export function applyNodeAdd(workflow: Workflow, node: WorkflowNode): Workflow {
  const position = node.position ?? defaultPosition(workflow.nodes.length);
  return { ...workflow, nodes: [...workflow.nodes, { ...node, position }] };
}

/** 移除节点并级联移除其关联边（不可变）；id 未命中时等价于仅换缓冲引用。 */
export function applyNodeRemove(workflow: Workflow, nodeId: string): Workflow {
  return {
    ...workflow,
    nodes: workflow.nodes.filter((n) => n.id !== nodeId),
    edges: workflow.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
  };
}

/** 画布连线入参（Vue Flow @connect 事件形状；condition 由属性面板后续编辑补写）。 */
export interface WfEdgeAddInput {
  source: string;
  target: string;
  condition?: string;
}

/**
 * 追加边（不可变）。校验：
 * - 自环拒绝（source === target）；
 * - 重复拒绝：去重口径对齐 core validate 的 duplicate-edge（from+to+condition 完全一致
 *   即重复）。另有无条件边与任意条件边同端点对冲突的补充口径——画布连线先建无条件边、
 *   条件在属性面板补写，若放行会立即产生「无条件+有条件」并行冗余边（无条件边恒流转，
 *   条件边永不生效）；同端点对不同确定条件的并行边不冲突（与 core validate 同口径放行）。
 */
export function applyEdgeAdd(workflow: Workflow, input: WfEdgeAddInput): Workflow {
  if (input.source === input.target) {
    throw new Error(`不能创建自环边: ${input.source} → ${input.target}`);
  }
  const duplicate = workflow.edges.some(
    (e) =>
      e.from === input.source &&
      e.to === input.target &&
      (e.condition === input.condition || e.condition === undefined || input.condition === undefined),
  );
  if (duplicate) {
    throw new Error(`边已存在: ${input.source} → ${input.target}（同 from-to-condition 的边不可重复创建）`);
  }
  const edge: WorkflowEdge = { id: crypto.randomUUID(), from: input.source, to: input.target };
  if (input.condition !== undefined) edge.condition = input.condition;
  return { ...workflow, edges: [...workflow.edges, edge] };
}

/** 按 id 移除边（不可变）；id 未命中时等价于仅换缓冲引用。 */
export function applyEdgeRemove(workflow: Workflow, edgeId: string): Workflow {
  return { ...workflow, edges: workflow.edges.filter((e) => e.id !== edgeId) };
}

// —— 任务 4：属性面板/拖拽写回的编辑变换（WfDesigner 薄壳消费，全部不可变） ——

/** 属性面板可编辑的节点属性子集（画布不触达 id）。 */
export type WfNodePatch = Partial<Pick<WorkflowNode, "label" | "kind" | "apiId" | "caseId">>;

/** 合并节点属性（不可变）：patch 键覆盖原值，未命中 id 时等价于仅换缓冲引用。 */
export function applyNodeUpdate(workflow: Workflow, nodeId: string, patch: WfNodePatch): Workflow {
  return {
    ...workflow,
    nodes: workflow.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)),
  };
}

/**
 * 拖拽落点写回（不可变）。任务 3 交接的浅共享处理：Vue Flow 拖拽期间会原地改
 * node.position（对象引用与缓冲共享），此处以**新建 position 对象**替换——缓冲的
 * position 脱离画布引用，后续原地拖拽不再悄悄改写已保存快照比对所依赖的数据。
 */
export function applyNodeMove(workflow: Workflow, nodeId: string, position: { x: number; y: number }): Workflow {
  return {
    ...workflow,
    nodes: workflow.nodes.map((n) =>
      n.id === nodeId ? { ...n, position: { x: position.x, y: position.y } } : n,
    ),
  };
}

/** 写回边条件（不可变）：空串/undefined 清除 condition 键（对齐模型的 optional 语义）。 */
export function applyEdgeCondition(workflow: Workflow, edgeId: string, condition: string | undefined): Workflow {
  const text = condition?.trim();
  return {
    ...workflow,
    edges: workflow.edges.map((e) => {
      if (e.id !== edgeId) return e;
      const next: WorkflowEdge = { id: e.id, from: e.from, to: e.to };
      if (text) next.condition = text;
      return next;
    }),
  };
}

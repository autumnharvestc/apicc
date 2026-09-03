import type { ApiDefinition, Collection, Environment, Project, Workspace } from "../domain/model.js";
import type { PluginRegistry } from "../plugin/registry.js";
import type { PmApi } from "../plugin/types.js";
import { CollectionRunner } from "../runner/runner.js";
import { createEventBus } from "../events/bus.js";
import { validateWorkflowStructure } from "./validate.js";
import type { Workflow, WorkflowEdge, WorkflowNode } from "./model.js";
import type { CaseOutcome } from "../report/types.js";

export type NodeState = "passed" | "failed" | "skipped" | "noop";

export interface NodeResult {
  nodeId: string;
  label?: string;
  kind: WorkflowNode["kind"];
  state: NodeState;
  outcome?: CaseOutcome;
  error?: string;
}

export interface WorkflowRunResult {
  workflowId: string;
  workflowName: string;
  status: Workflow["status"];
  nodeResults: NodeResult[];
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  warnings: string[];
  startedAt: string;
  finishedAt: string;
}

export interface WorkflowRunnerOptions {
  registry: PluginRegistry;
  resolve: (apiId: string) => ApiDefinition | undefined;
  envName?: string;
  failFast?: boolean;
}

/** 条件求值沙箱上下文：在 PmApi 之上扩展只读的 prev/vars 与求值结果槽位 __value。 */
interface ConditionPm extends PmApi {
  prev: unknown;
  vars: Record<string, string>;
  __value: unknown;
}

export class WorkflowRunner {
  /** 跨节点携带的运行时变量（累加语义：只合并不替换，见 run 内桥构造）。 */
  private carried: Record<string, string> = {};

  constructor(private opts: WorkflowRunnerOptions) {}

  async run(workflow: Workflow, ctx: { project: Project; workspace: Workspace }): Promise<WorkflowRunResult> {
    const startedAt = new Date().toISOString();
    const warnings: string[] = [];
    // 结构防御：环在执行前拒绝（端点/孤立等其余问题不阻断遍历）。
    const structural = validateWorkflowStructure(workflow);
    const cycle = structural.find((i) => i.code === "cycle");
    if (cycle) throw new Error(cycle.message);

    const project = ctx.project;
    const env = resolveEnv(project, this.opts.envName);
    const runner = new CollectionRunner({
      registry: this.opts.registry,
      bus: createEventBus(),
      timeouts: { connectTimeoutMs: 10_000, totalTimeoutMs: 30_000 },
      failFast: this.opts.failFast ?? false,
    });
    // 运行时桥（任务 6 审查核定，必须累加语义）：set 用 Object.assign 合并进 carried，
    // 禁止替换式赋值（carried = v 会丢未被下游重新提取的变量）。
    // 桥方法异常兜底（同上）：get 失败包装为可读错误整体拒绝；
    // set 失败绝不吞掉已产生的 WorkflowRunResult，折进 warnings 而非整体拒绝。
    const bridge = {
      get: () => {
        try {
          return { ...this.carried };
        } catch (e) {
          throw new Error(`运行时桥读取失败: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
      set: (v: Record<string, string>) => {
        try {
          Object.assign(this.carried, v);
        } catch (e) {
          warnings.push(`运行时桥回写失败: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    };

    const nodeResults = new Map<string, NodeResult>();
    const incoming = new Map<string, WorkflowEdge[]>();
    const outgoing = new Map<string, WorkflowEdge[]>();
    for (const e of workflow.edges) {
      outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), e]);
      incoming.set(e.to, [...(incoming.get(e.to) ?? []), e]);
    }

    // 多入语义：任一上游 passed/noop 即就绪（简报实现更正指令 ⑥）。
    const ready = (nodeId: string): boolean => {
      const ins = incoming.get(nodeId) ?? [];
      if (ins.length === 0) return true;
      return ins.some((e) => {
        const s = nodeResults.get(e.from);
        return s !== undefined && (s.state === "passed" || s.state === "noop");
      });
    };
    // 级联跳过：上游全部终态且没有任何一条可达（passed/noop）。
    const blocked = (nodeId: string): boolean => {
      const ins = incoming.get(nodeId) ?? [];
      if (ins.length === 0) return false;
      return ins.every((e) => nodeResults.has(e.from)) && !ready(nodeId);
    };

    // 从入度 0 节点拓扑遍历（环已被拒绝，入度 0 节点必存在且覆盖全图）。
    const queue: WorkflowNode[] = workflow.nodes.filter((n) => (incoming.get(n.id) ?? []).length === 0);
    const order: string[] = [];

    while (queue.length > 0) {
      const node = queue.shift()!;
      if (nodeResults.has(node.id)) continue;
      order.push(node.id);

      if (node.kind === "noop") {
        nodeResults.set(node.id, { nodeId: node.id, label: node.label, kind: "noop", state: "noop" });
      } else {
        const api = node.apiId ? this.opts.resolve(node.apiId) : undefined;
        const caseDef = api?.cases.find((c) => c.id === node.caseId);
        if (!api || !caseDef) {
          // missing 引用：skipped 带告警，不中断整轮（「引用缺失」可诊断而非静默破坏）。
          const msg = `节点「${node.label ?? node.id}」引用的接口/用例不存在（apiId=${node.apiId ?? ""}, caseId=${node.caseId ?? ""}），已跳过`;
          warnings.push(msg);
          nodeResults.set(node.id, { nodeId: node.id, label: node.label, kind: "request", state: "skipped", error: msg });
        } else {
          // 合成单用例集合：复用 CollectionRunner 完整语义（脚本/断言/变量/环境），运行时桥跨节点携带变量。
          const collection: Collection = {
            id: `wf-${workflow.id}-${node.id}`,
            name: `${workflow.name}/${node.label ?? api.name}`,
            variables: {},
            folders: [],
            apis: [{ ...api, cases: [caseDef] }],
          };
          const outcome = await runSingleNode(runner, collection, env, project, ctx.workspace, bridge);
          const state: NodeState = outcome.passed ? "passed" : "failed";
          nodeResults.set(node.id, { nodeId: node.id, label: node.label, kind: "request", state, outcome, error: outcome.error });
        }
      }

      // 出边求值：条件为假不流转（告警）；满足则下游入队（多入只入队一次）。
      for (const edge of outgoing.get(node.id) ?? []) {
        if (edge.condition) {
          const verdict = evaluateCondition(edge.condition, nodeResults.get(node.id)!, this.carried, this.opts.registry, warnings);
          if (!verdict) {
            warnings.push(`边 ${edge.from} → ${edge.to} 条件不满足: ${edge.condition}`);
            continue;
          }
        }
        const target = workflow.nodes.find((n) => n.id === edge.to)!;
        if (!queue.some((n) => n.id === target.id) && !nodeResults.has(target.id) && !blocked(target.id)) {
          queue.push(target);
        }
      }
      // 级联：上游全部终态且不可达的节点标记 skipped（扫描置于出边求值之后，简报更正指令 ⑤）。
      for (const n of workflow.nodes) {
        if (!nodeResults.has(n.id) && blocked(n.id)) {
          nodeResults.set(n.id, { nodeId: n.id, label: n.label, kind: n.kind, state: "skipped" });
        }
      }
      if (this.opts.failFast && nodeResults.get(node.id)?.state === "failed") break;
    }

    // 未触达节点（条件不流转/级联/failFast 中断遗留）→ skipped。
    for (const n of workflow.nodes) {
      if (!nodeResults.has(n.id)) {
        nodeResults.set(n.id, { nodeId: n.id, label: n.label, kind: n.kind, state: "skipped" });
      }
    }

    // 先按执行顺序，再按工作流声明顺序补齐 skipped 节点（级联/未触达者不在 order 中）。
    const list: NodeResult[] = order.map((id) => nodeResults.get(id)!);
    for (const n of workflow.nodes) {
      if (!order.includes(n.id)) {
        const r = nodeResults.get(n.id);
        if (r) list.push(r);
      }
    }
    const total = list.length;
    const passed = list.filter((n) => n.state === "passed" || n.state === "noop").length;
    const failed = list.filter((n) => n.state === "failed").length;
    const skipped = list.filter((n) => n.state === "skipped").length;
    return {
      workflowId: workflow.id, workflowName: workflow.name, status: workflow.status,
      nodeResults: list, total, passed, failed, skipped, warnings,
      startedAt, finishedAt: new Date().toISOString(),
    };
  }
}

function resolveEnv(project: Project, envName: string | undefined): Environment | undefined {
  if (!envName) return undefined;
  const env = project.environments.find((e) => e.name === envName);
  if (!env) throw new Error(`未找到环境: ${envName}`);
  return env;
}

/** request 节点单用例路径：CollectionRunner 完整语义（脚本/断言/变量/环境）跑合成单用例集合，取唯一用例结果。 */
async function runSingleNode(
  runner: CollectionRunner, collection: Collection, env: Environment | undefined,
  project: Project, workspace: Workspace,
  bridge: { get(): Record<string, string>; set(v: Record<string, string>): void },
): Promise<CaseOutcome> {
  const result = await runner.run(collection, env, project, workspace, { runtimeBridge: bridge });
  return result.cases[0]!;
}

/**
 * 条件边求值：JS 沙箱内 `pm.__value = Boolean((expr))`，结果必须为 true 才流转。
 * 求值上下文 prev（上游结果只读映射，noop 时 passed=true）/ vars（携带变量快照）以 pm 属性直传沙箱；
 * 表达式以裸标识符引用（如 prev.passed / vars.orderId），而沙箱只注入 pm 一个全局——
 * 故注入一行解构绑定使裸标识符可达（每次 engine.run 均为新沙箱上下文，无跨调用词法残留）。
 * 求值异常/缺引擎按 false 处理并告警（规格 D2/§边界）。
 */
function evaluateCondition(expr: string, upstream: NodeResult, carried: Record<string, string>, registry: PluginRegistry, warnings: string[]): boolean {
  const engine = registry.getScriptEngine("javascript");
  if (!engine) { warnings.push("缺少 javascript 脚本引擎，条件按 false 处理"); return false; }
  const prev = upstream.outcome
    ? { passed: upstream.outcome.passed, caseName: upstream.outcome.caseName, error: upstream.outcome.error, assertions: upstream.outcome.assertions }
    : { passed: upstream.state === "noop", caseName: upstream.label, error: undefined, assertions: [] };
  const pm: ConditionPm = {
    variables: { get: () => undefined, set: () => {} },
    environment: { get: () => undefined },
    request: { method: "GET", url: "", headers: {}, query: [] },
    assert: () => {},
    prev,
    vars: { ...carried },
    __value: undefined,
  };
  try {
    engine.run(`const { prev, vars } = pm; pm.__value = Boolean((${expr}));`, { pm });
    return pm.__value === true;
  } catch (e) {
    warnings.push(`条件求值失败（按不通过处理）: ${expr} —— ${(e as Error).message}`);
    return false;
  }
}

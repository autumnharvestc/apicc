import type { ApiDefinition, Collection, Environment, Project, TestCase, Workspace } from "../domain/model.js";
import type { PluginRegistry } from "../plugin/registry.js";
import type { PmApi } from "../plugin/types.js";
import { CollectionRunner } from "../runner/runner.js";
import { createEventBus } from "../events/bus.js";
import { mergedEnvVars } from "../domain/envChain.js";
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

/** 条件求值沙箱上下文：在 PmApi 之上扩展只读的 prev/vars/env 与求值结果槽位 __value。 */
interface ConditionPm extends PmApi {
  prev: unknown;
  vars: Record<string, string>;
  env: Record<string, string>;
  __value: unknown;
}

export class WorkflowRunner {
  /** 跨节点携带的运行时变量（累加语义：只合并不替换，见 run 内桥构造）。 */
  private carried: Record<string, string> = {};

  constructor(private opts: WorkflowRunnerOptions) {}

  async run(workflow: Workflow, ctx: { project: Project; workspace: Workspace }): Promise<WorkflowRunResult> {
    const startedAt = new Date().toISOString();
    const warnings: string[] = [];
    // 结构防御：环在执行前拒绝（环阻断遍历）；其余结构性 error（如悬空边端点）不阻断运行，
    // 但必须折进 warnings 使诊断可见——悬空 from 边永远不会被边求值触达，下游被静默 skipped 时这是唯一线索。
    const structural = validateWorkflowStructure(workflow);
    const cycle = structural.find((i) => i.code === "cycle");
    if (cycle) throw new Error(cycle.message);
    for (const i of structural) {
      if (i.level === "error" && i.code !== "cycle") warnings.push(i.message);
    }

    const project = ctx.project;
    const env = resolveEnv(project, this.opts.envName);
    // 条件求值上下文 env（规格 §4）：按继承链根→叶合并的环境变量只读快照（与 CollectionRunner
    // 的环境层同源语义，规格 §3.1/§6）；sit extends dev 等继承场景父环境变量必须可见。未选环境时空对象。
    const envVars = mergedEnvVars(env, project);
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
    // 条件为假未流转的边：该边对 to 端判定为「不可达」，就绪/阻塞裁决中视同已终态的否定来源。
    const pruned = new Set<string>();

    // 多入语义：任一上游 passed/noop 即就绪（简报实现更正指令 ⑥）；
    // 被剪枝边（条件为假）不参与就绪判定——其上游即使通过也不经该边流转。
    const ready = (nodeId: string): boolean => {
      const ins = incoming.get(nodeId) ?? [];
      if (ins.length === 0) return true;
      return ins.some((e) => {
        if (pruned.has(e.id)) return false;
        const s = nodeResults.get(e.from);
        return s !== undefined && (s.state === "passed" || s.state === "noop");
      });
    };
    // 级联跳过：每条入边均已定局（来源终态且失败/跳过，或被条件剪枝）且无任何可达来源。
    const blocked = (nodeId: string): boolean => {
      const ins = incoming.get(nodeId) ?? [];
      if (ins.length === 0) return false;
      return ins.every((e) => {
        if (pruned.has(e.id)) return true;
        const s = nodeResults.get(e.from);
        return s !== undefined && s.state !== "passed" && s.state !== "noop";
      }) && !ready(nodeId);
    };

    // 从入度 0 节点拓扑遍历（环已被拒绝，入度 0 节点必存在且覆盖全图）。
    const queue: WorkflowNode[] = workflow.nodes.filter((n) => (incoming.get(n.id) ?? []).length === 0);
    const order: string[] = [];
    // 防活锁：连续延后计数。一轮队列全部被延后（无任何节点可执行、状态零进展）= 调度停滞。
    let deferredInRow = 0;

    while (queue.length > 0) {
      const node = queue.shift()!;
      if (nodeResults.has(node.id)) continue;

      // 出队终审（fan-in 修复）：入队时上游可能未决（当时 blocked=false 即放行入队），
      // 执行前必须按「任一上游 passed/noop 即就绪」复核：
      // - 上游全部定局（终态或被条件剪枝）且无一通过 → 级联 skipped（fan-in 双败在此兜底，下游不再对故障环境发出请求）；
      // - 尚有未决上游 → 延后：放回队尾，待其终态后随下一轮出队再裁决。
      if (!ready(node.id)) {
        const allResolved = (incoming.get(node.id) ?? []).every((e) => pruned.has(e.id) || nodeResults.has(e.from));
        if (allResolved) {
          nodeResults.set(node.id, { nodeId: node.id, label: node.label, kind: node.kind, state: "skipped" });
          continue;
        }
        queue.push(node);
        deferredInRow += 1;
        if (deferredInRow >= queue.length) {
          // 全队延后仍无进展：上游永远不会终态而队列已无别的可执行节点——图调度分析存在缺陷，显式拒绝。
          throw new Error(`调度停滞: 节点「${node.label ?? node.id}」的上游始终未决且队列中无任何可执行节点`);
        }
        continue;
      }
      deferredInRow = 0;
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
          const outcome = await runSingleNode(runner, collection, api, caseDef, env, project, ctx.workspace, bridge);
          const state: NodeState = outcome.passed ? "passed" : "failed";
          nodeResults.set(node.id, { nodeId: node.id, label: node.label, kind: "request", state, outcome, error: outcome.error });
        }
      }

      // 出边求值：条件为假不流转（告警）并把该边记为剪枝——to 端就绪裁决不再等待此上游；
      // 满足则下游入队（多入只入队一次）。
      for (const edge of outgoing.get(node.id) ?? []) {
        if (edge.condition) {
          const verdict = evaluateCondition(edge.condition, nodeResults.get(node.id)!, this.carried, envVars, this.opts.registry, warnings);
          if (!verdict) {
            warnings.push(`边 ${edge.from} → ${edge.to} 条件不满足: ${edge.condition}`);
            pruned.add(edge.id);
            continue;
          }
        }
        // 悬空 to 端点：忽略该边并告警，不以裸 TypeError 中断整轮（端点缺陷不阻断遍历）。
        const target = workflow.nodes.find((n) => n.id === edge.to);
        if (!target) {
          warnings.push(`边 ${edge.id} 指向不存在的节点 ${edge.to}，已忽略`);
          continue;
        }
        if (!queue.some((n) => n.id === target.id) && !nodeResults.has(target.id) && !blocked(target.id)) {
          queue.push(target);
        }
      }
      // 级联：入边全部定局（来源终态否定或被条件剪枝）且不可达的节点标记 skipped（扫描置于出边求值之后，简报更正指令 ⑤）。
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
  runner: CollectionRunner, collection: Collection, api: ApiDefinition, caseDef: TestCase,
  env: Environment | undefined, project: Project, workspace: Workspace,
  bridge: { get(): Record<string, string>; set(v: Record<string, string>): void },
): Promise<CaseOutcome> {
  const result = await runner.run(collection, env, project, workspace, { runtimeBridge: bridge });
  const outcome = result.cases[0];
  if (outcome) return outcome;
  // 被引用用例 scope 与所选环境不匹配时，单用例被 CollectionRunner 的 scope 过滤剔除（cases 为空）——
  // 构造可读 failed outcome 留痕，而非让 outcome undefined 裸崩（节点记 failed，遍历继续）。
  return {
    apiId: api.id, apiName: api.name, caseId: caseDef.id, caseName: caseDef.name,
    passed: false, durationMs: 0, assertions: [],
    error: `用例不适用于当前环境（scope=${caseDef.scope}），已按失败处理`,
  };
}

/**
 * 条件边求值：JS 沙箱内 `pm.__value = Boolean((expr))`，结果必须为 true 才流转。
 * 求值上下文（规格 §4）：prev（上游结果只读映射，noop 时 passed=true）、vars（携带变量快照）、
 * env（当前环境 variables 只读快照，无环境时空对象）以 pm 属性直传沙箱；
 * 表达式以裸标识符引用（如 prev.passed / vars.orderId / env.deploy），而沙箱只注入 pm 一个全局——
 * 故注入一行解构绑定使裸标识符可达（每次 engine.run 均为新沙箱上下文，无跨调用词法残留）。
 * 求值异常/缺引擎按 false 处理并告警（规格 D2/§边界）。
 */
function evaluateCondition(expr: string, upstream: NodeResult, carried: Record<string, string>, envVars: Record<string, string>, registry: PluginRegistry, warnings: string[]): boolean {
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
    env: envVars,
    __value: undefined,
  };
  try {
    engine.run(`const { prev, vars, env } = pm; pm.__value = Boolean((${expr}));`, { pm });
    return pm.__value === true;
  } catch (e) {
    warnings.push(`条件求值失败（按不通过处理）: ${expr} —— ${(e as Error).message}`);
    return false;
  }
}

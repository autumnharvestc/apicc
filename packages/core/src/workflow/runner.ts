import type { ApiDefinition, Collection, Environment, Project, TestCase, Workspace } from "../domain/model.js";
import type { PluginRegistry } from "../plugin/registry.js";
import type { PmApi } from "../plugin/types.js";
import { CollectionRunError, CollectionRunner } from "../runner/runner.js";
import { createEventBus } from "../events/bus.js";
import { mergedEnvVars } from "../domain/envChain.js";
import { validateWorkflowStructure } from "./validate.js";
import { findProjectApi, selectWorkflowCollection } from "./references.js";
import type { Workflow, WorkflowEdge, WorkflowNode } from "./model.js";
import type { CaseOutcome } from "../report/types.js";

export type NodeState = "passed" | "failed" | "skipped" | "noop";
export type NodeSkipReason = "condition-pruned" | "upstream-failed" | "fail-fast" | "reference-missing" | "reference-invalid" | "unreachable";

export interface NodeResult {
  nodeId: string;
  label?: string;
  kind: WorkflowNode["kind"];
  state: NodeState;
  outcomes?: CaseOutcome[];
  outcome?: CaseOutcome;
  error?: string;
  skipReason?: NodeSkipReason;
  failureKind?: CaseOutcome["failureKind"];
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
  verdict?: "passed" | "failed";
  warnings: string[];
  startedAt: string;
  finishedAt: string;
}

export interface WorkflowRunnerOptions {
  registry: PluginRegistry;
  resolve: (apiId: string) => ApiDefinition | undefined;
  envName?: string;
  failFast?: boolean;
  strict?: boolean;
}

export type ConditionVerdict = { kind: "matched" } | { kind: "pruned" } | { kind: "error"; message: string };

/** 条件求值沙箱上下文：在 PmApi 之上扩展只读的 prev/vars/env 与求值结果槽位 __value。 */
interface ConditionPm extends PmApi {
  prev: unknown;
  vars: Record<string, string>;
  env: Record<string, string>;
  __value: unknown;
}

export class WorkflowRunner {
  constructor(private opts: WorkflowRunnerOptions) {}

  async run(workflow: Workflow, ctx: { project: Project; workspace: Workspace }): Promise<WorkflowRunResult> {
    const startedAt = new Date().toISOString();
    const warnings: string[] = [];
    // 结构错误必须在任何节点执行前拒绝；否则重复 ID/悬空端点会让拓扑调度产生
    // 无法解释的 skipped，且可能在错误图上发出请求。
    const structural = validateWorkflowStructure(workflow);
    const structuralErrors = structural.filter((i) => i.level === "error");
    if (structuralErrors.length > 0) throw new Error(structuralErrors.map((i) => i.message).join("; "));
    warnings.push(...structural.filter((i) => i.level === "warning").map((i) => i.message));

    const project = ctx.project;
    const strict = this.opts.strict ?? true;
    // strict 预检必须先于环境解析、CollectionRunner 和任何 HTTP 请求。项目实体优先，
    // 只有项目内没有该接口时才使用 resolve 接缝，与实际运行定位保持一致。
    const missingReferences = workflow.nodes
      .filter((node) => node.kind === "request")
      .map((node) => ({ node, reference: resolveNodeReference(node, project, this.opts.resolve) }))
      .filter(({ reference }) => !reference.api || !reference.caseDef);
    const missingReferenceByNodeId = new Map(missingReferences.map((item) => [item.node.id, item]));
    if (strict && missingReferences.length > 0) {
      for (const { node, reference } of missingReferences) {
        const message = missingReferenceMessage(node);
        warnings.push(message);
        reference.missingMessage = message;
      }
      const missingIds = new Set(missingReferences.map(({ node }) => node.id));
      const nodeResults = workflow.nodes.map((node): NodeResult => {
        const missing = missingIds.has(node.id);
        return missing
          ? { nodeId: node.id, label: node.label, kind: node.kind, state: "failed", failureKind: "config", error: missingReferences.find((m) => m.node.id === node.id)?.reference.missingMessage }
          : { nodeId: node.id, label: node.label, kind: node.kind, state: "skipped", skipReason: "reference-invalid" };
      });
      return makeWorkflowResult(workflow, startedAt, nodeResults, warnings);
    }
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
    // 携带变量属于一次 run，避免同一实例的顺序/并发调用相互污染。
    const carried: Record<string, string> = {};
    // 运行时桥（任务 6 审查核定，必须累加语义）：set 用 Object.assign 合并进 carried，
    // 禁止替换式赋值（carried = v 会丢未被下游重新提取的变量）。
    // 桥方法异常兜底（同上）：get 失败包装为可读错误整体拒绝；
    // set 失败绝不吞掉已产生的 WorkflowRunResult，折进 warnings 而非整体拒绝。
    const bridge = {
      get: () => {
        try {
          return { ...carried };
        } catch (e) {
          throw new Error(`运行时桥读取失败: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
      set: (v: Record<string, string>) => {
        try {
          Object.assign(carried, v);
        } catch (e) {
          warnings.push(`运行时桥回写失败: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    };

    const nodeResults = new Map<string, NodeResult>();
    // Relaxed execution still records every known-invalid request before graph
    // pruning/fail-fast can hide it. The result is materialized only when the
    // scheduler reaches the node (so a reached failure still participates in
    // fail-fast/propagation); hidden invalid nodes are materialized at the end.
    if (!strict) {
      for (const { node, reference } of missingReferences) {
        const message = missingReferenceMessage(node);
        warnings.push(message);
        reference.missingMessage = message;
      }
    }
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
          nodeResults.set(node.id, {
            nodeId: node.id, label: node.label, kind: node.kind, state: "skipped",
            skipReason: skipReasonForBlocked(node.id, incoming, nodeResults, pruned),
          });
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

      const knownMissing = !strict ? missingReferenceByNodeId.get(node.id) : undefined;
      if (knownMissing) {
        nodeResults.set(node.id, missingNodeResult(node, missingReferenceMessage(node)));
      } else if (node.kind === "noop") {
        nodeResults.set(node.id, { nodeId: node.id, label: node.label, kind: "noop", state: "noop" });
      } else {
        const reference = resolveNodeReference(node, project, this.opts.resolve);
        const projectLocation = reference.location;
        const api = reference.api;
        const caseDef = reference.caseDef;
        if (!api || !caseDef) {
          // 非严格模式允许其他独立节点继续，但缺引用本身始终是 failed/config，不能伪装成 skipped/pass。
          const msg = missingReferenceMessage(node);
          warnings.push(msg);
          const outcome: CaseOutcome = {
            apiId: node.apiId ?? "", apiName: node.apiId ?? node.id,
            caseId: node.caseId ?? "", caseName: node.caseId ?? node.id,
            passed: false, durationMs: 0, assertions: [], error: msg, failureKind: "config",
          };
          nodeResults.set(node.id, { nodeId: node.id, label: node.label, kind: "request", state: "failed", outcomes: [outcome], outcome, failureKind: "config", error: msg });
        } else {
          // 保留项目模块/祖先文件夹上下文；外部 resolve 仍使用工作流专属合成集合。
          const collection = projectLocation
            ? selectWorkflowCollection(projectLocation, caseDef)
            : {
              id: `wf-${workflow.id}-${node.id}`,
              name: `${workflow.name}/${node.label ?? api.name}`,
              variables: {}, folders: [], apis: [{ ...api, cases: api.cases.filter((candidate) => candidate.id === caseDef.id) }],
            } satisfies Collection;
          try {
            const nodeRun = await runSingleNode(runner, collection, api, caseDef, env, project, ctx.workspace, bridge);
            warnings.push(...nodeRun.warnings);
            const outcomes = nodeRun.outcomes;
            const state: NodeState = outcomes.every((o) => o.passed) ? "passed" : "failed";
            const outcome = outcomes.find((o) => !o.passed) ?? outcomes[0];
            nodeResults.set(node.id, { nodeId: node.id, label: node.label, kind: "request", state, outcomes, outcome, error: outcome?.error, failureKind: outcome?.failureKind });
          } catch (e) {
            if (e instanceof CollectionRunError) {
              warnings.push(...(e.partialResult.warnings ?? []));
              const diagnostic: CaseOutcome = {
                apiId: api.id, apiName: api.name, caseId: caseDef.id, caseName: caseDef.name,
                passed: false, durationMs: 0, assertions: [], error: e.message, failureKind: e.failureKind,
              };
              const outcomes = [...e.partialResult.cases, diagnostic];
              const outcome = outcomes.find((candidate) => !candidate.passed) ?? diagnostic;
              nodeResults.set(node.id, {
                nodeId: node.id, label: node.label, kind: "request", state: "failed",
                outcomes, outcome, error: e.message, failureKind: e.failureKind,
              });
            } else {
              const error = e instanceof Error ? e.message : String(e);
              const failureKind: CaseOutcome["failureKind"] = /脚本引擎|接口\/用例|环境|数据源/.test(error) ? "config" : "script";
              const outcome: CaseOutcome = {
                apiId: api.id, apiName: api.name, caseId: caseDef.id, caseName: caseDef.name,
                passed: false, durationMs: 0, assertions: [], error, failureKind,
              };
              nodeResults.set(node.id, { nodeId: node.id, label: node.label, kind: "request", state: "failed", outcomes: [outcome], outcome, error, failureKind });
            }
          }
        }
      }

      // 出边求值：条件为假是预期剪枝，不产生异常 warning；to 端就绪裁决不再等待此上游；
      // 满足则下游入队（多入只入队一次）。
      for (const edge of outgoing.get(node.id) ?? []) {
        if (edge.condition) {
          const verdict = evaluateCondition(edge.condition, nodeResults.get(node.id)!, carried, envVars, this.opts.registry);
          if (verdict.kind === "pruned") {
            pruned.add(edge.id);
            continue;
          }
          if (verdict.kind === "error") {
            const result = nodeResults.get(node.id)!;
            result.state = "failed";
            result.failureKind = "script";
            result.error = `边 ${edge.id} 条件求值失败: ${verdict.message}`;
            warnings.push(result.error);
            continue;
          }
        }
        // 悬空端点已由执行前结构校验拒绝；此守卫仅保护未来调用方改变校验策略时的诊断。
        const target = workflow.nodes.find((n) => n.id === edge.to);
        if (!target) {
          warnings.push(`边 ${edge.id} 指向不存在的节点 ${edge.to}，已忽略`);
          continue;
        }
        if (!queue.some((n) => n.id === target.id) && !nodeResults.has(target.id) && !blocked(target.id)) {
          queue.push(target);
        }
      }
      // 级联：反复扫描直到稳定，不能依赖 workflow.nodes 声明顺序。
      // 例如 root→mid(false)→tail 在 tail、mid、root 的逆序声明下，tail 必须等待
      // mid 先被裁决为 condition-pruned，而不是被最终兜底误报 unreachable。
      let propagated = true;
      while (propagated) {
        propagated = false;
        for (const n of workflow.nodes) {
          if (!nodeResults.has(n.id) && blocked(n.id)) {
            // A known-invalid node hidden behind a false/failed path remains a
            // report-visible config failure, but must not become a scheduler
            // participant and globally halt relaxed diagnosis.
            if (!strict && missingReferenceByNodeId.has(n.id)) continue;
            nodeResults.set(n.id, {
              nodeId: n.id, label: n.label, kind: n.kind, state: "skipped",
              skipReason: skipReasonForBlocked(n.id, incoming, nodeResults, pruned),
            });
            propagated = true;
          }
        }
      }
      if (this.opts.failFast && nodeResults.get(node.id)?.state === "failed") break;
    }

    // 未触达节点（条件不流转/级联/failFast 中断遗留）→ skipped。
    for (const n of workflow.nodes) {
      if (!nodeResults.has(n.id)) {
        const knownMissing = !strict ? missingReferenceByNodeId.get(n.id) : undefined;
        nodeResults.set(n.id, knownMissing
          ? missingNodeResult(n, missingReferenceMessage(n))
          : { nodeId: n.id, label: n.label, kind: n.kind, state: "skipped", skipReason: this.opts.failFast ? "fail-fast" : "unreachable" });
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
      nodeResults: list, total, passed, failed, skipped,
      verdict: workflowVerdict(list, failed), warnings,
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

/** request 节点路径：CollectionRunner 完整语义（脚本/断言/变量/环境）。 */
async function runSingleNode(
  runner: CollectionRunner, collection: Collection, api: ApiDefinition, caseDef: TestCase,
  env: Environment | undefined, project: Project, workspace: Workspace,
  bridge: { get(): Record<string, string>; set(v: Record<string, string>): void },
): Promise<{ outcomes: CaseOutcome[]; warnings: string[] }> {
  const result = await runner.run(collection, env, project, workspace, { runtimeBridge: bridge });
  if (result.cases.length > 0) return { outcomes: result.cases, warnings: result.warnings ?? [] };
  // 被引用用例 scope 与所选环境不匹配时，单用例被 CollectionRunner 的 scope 过滤剔除（cases 为空）——
  // 构造可读 failed outcome 留痕，而非让 outcome undefined 裸崩（节点记 failed，遍历继续）。
  return { outcomes: [{
    apiId: api.id, apiName: api.name, caseId: caseDef.id, caseName: caseDef.name,
    passed: false, durationMs: 0, assertions: [],
    error: `用例不适用于当前环境（scope=${caseDef.scope}），已按失败处理`,
    failureKind: "config",
  }], warnings: result.warnings ?? [] };
}

/**
 * 条件边求值：JS 沙箱内 `pm.__value = Boolean((expr))`，结果必须为 true 才流转。
 * 求值上下文（规格 §4）：prev（上游结果只读映射，noop 时 passed=true）、vars（携带变量快照）、
 * env（当前环境 variables 只读快照，无环境时空对象）以 pm 属性直传沙箱；
 * 表达式以裸标识符引用（如 prev.passed / vars.orderId / env.deploy），而沙箱只注入 pm 一个全局——
 * 故注入一行解构绑定使裸标识符可达（每次 engine.run 均为新沙箱上下文，无跨调用词法残留）。
 * 求值异常/缺引擎返回 error，由调用方将源节点标为 script 失败并阻断其下游。
 */
function evaluateCondition(expr: string, upstream: NodeResult, carried: Record<string, string>, envVars: Record<string, string>, registry: PluginRegistry): ConditionVerdict {
  const engine = registry.getScriptEngine("javascript");
  if (!engine) return { kind: "error", message: "缺少 javascript 脚本引擎" };
  const representative = upstream.outcome;
  const prev = deepReadonlySnapshot(representative
    ? {
      passed: upstream.state === "passed" || upstream.state === "noop",
      caseName: representative.caseName, error: representative.error,
      assertions: representative.assertions, outcomes: upstream.outcomes,
    }
    : { passed: upstream.state === "noop", caseName: upstream.label, error: undefined, assertions: [], outcomes: upstream.outcomes });
  const pm: ConditionPm = {
    variables: { get: () => undefined, set: () => {} },
    environment: { get: () => undefined },
    request: { method: "GET", url: "", headers: {}, query: [] },
    assert: () => {},
    prev,
    vars: deepReadonlySnapshot({ ...carried }),
    env: deepReadonlySnapshot({ ...envVars }),
    __value: undefined,
  };
  try {
    engine.run(`const { prev, vars, env } = pm; pm.__value = Boolean((${expr}));`, { pm });
    return pm.__value === true ? { kind: "matched" } : { kind: "pruned" };
  } catch (e) {
    return { kind: "error", message: `${(e as Error).message}（表达式: ${expr}）` };
  }
}

/** 条件脚本只能读取运行结果快照：递归复制并冻结数组及对象，隔离所有嵌套引用。 */
function deepReadonlySnapshot<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Object.freeze(value.map((item) => deepReadonlySnapshot(item))) as T;
  const copy = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepReadonlySnapshot(item)]));
  return Object.freeze(copy) as T;
}

interface NodeReference {
  location?: ReturnType<typeof findProjectApi>;
  api?: ApiDefinition;
  caseDef?: TestCase;
  missingMessage?: string;
}

function resolveNodeReference(
  node: WorkflowNode,
  project: Project,
  resolve: (apiId: string) => ApiDefinition | undefined,
): NodeReference {
  if (node.kind !== "request") return {};
  const location = node.apiId ? findProjectApi(project, node.apiId) : undefined;
  // Project entities are authoritative. The resolver is only a seam for APIs not
  // owned by this project (used by standalone/workspace execution).
  const api = location?.api ?? (node.apiId ? resolve(node.apiId) : undefined);
  return { location, api, caseDef: api?.cases.find((candidate) => candidate.id === node.caseId) };
}

function missingReferenceMessage(node: WorkflowNode): string {
  return `节点「${node.label ?? node.id}」引用的接口/用例不存在（apiId=${node.apiId ?? ""}, caseId=${node.caseId ?? ""}）`;
}

function missingNodeResult(node: WorkflowNode, message: string): NodeResult {
  const outcome: CaseOutcome = {
    apiId: node.apiId ?? "", apiName: node.apiId ?? node.id,
    caseId: node.caseId ?? "", caseName: node.caseId ?? node.id,
    passed: false, durationMs: 0, assertions: [], error: message, failureKind: "config",
  };
  return {
    nodeId: node.id, label: node.label, kind: "request", state: "failed",
    outcomes: [outcome], outcome, failureKind: "config", error: message,
  };
}

function skipReasonForBlocked(
  nodeId: string,
  incoming: Map<string, WorkflowEdge[]>,
  nodeResults: Map<string, NodeResult>,
  pruned: Set<string>,
): NodeSkipReason {
  const ins = incoming.get(nodeId) ?? [];
  const hasFailure = ins.some((edge) => {
    if (pruned.has(edge.id)) return false;
    const source = nodeResults.get(edge.from);
    return source?.state === "failed" || source?.skipReason === "upstream-failed" || source?.skipReason === "reference-invalid" || source?.skipReason === "reference-missing";
  });
  return hasFailure ? "upstream-failed" : "condition-pruned";
}

function workflowVerdict(nodeResults: NodeResult[], failed: number): "passed" | "failed" {
  if (failed > 0) return "failed";
  if (nodeResults.some((node) => node.state === "skipped" && node.skipReason !== "condition-pruned" && node.skipReason !== "upstream-failed")) return "failed";
  return "passed";
}

function makeWorkflowResult(workflow: Workflow, startedAt: string, nodeResults: NodeResult[], warnings: string[]): WorkflowRunResult {
  const total = nodeResults.length;
  const passed = nodeResults.filter((node) => node.state === "passed" || node.state === "noop").length;
  const failed = nodeResults.filter((node) => node.state === "failed").length;
  const skipped = nodeResults.filter((node) => node.state === "skipped").length;
  return {
    workflowId: workflow.id, workflowName: workflow.name, status: workflow.status,
    nodeResults, total, passed, failed, skipped, verdict: "failed", warnings,
    startedAt, finishedAt: new Date().toISOString(),
  };
}

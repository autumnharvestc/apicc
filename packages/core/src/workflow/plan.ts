import type { DeepReadonly, ProjectSnapshot } from "../assets/snapshot.js";
import type { ContractProject } from "../contract/workspace.js";
import type { CredentialRequestSelection } from "../credentials/output.js";
import { resolveExecutionEnvironment, selectEffectiveCases } from "../domain/executionSelection.js";
import { getEffectiveCaseRequest } from "../request/effective.js";
import { WorkflowSchema, type Workflow, type WorkflowValue } from "./model.js";
import { findProjectApi, workflowCalls } from "./references.js";
import { validateWorkflowStructure } from "./validate.js";
import type { PreparedTestData } from "../testing/dataModel.js";
import { JsonValueSchema, StringRecordSchema } from "../contract/schemaNode.js";

export interface WorkflowPlanOptions { environmentId?: string; allowDraft?: boolean; strict?: boolean; legacyRootReferenceMode?: "report" }
/** Pure run-only overrides; hosts call before credential or data preparation. */
export function validateWorkflowRunOptions(workflow: DeepReadonly<Workflow>, options: { inputs?: unknown; maxConcurrency?: number; timeoutMs?: number } = {}) {
  const { inputs, maxConcurrency, timeoutMs } = options;
  for (const [name, value, max] of [["maxConcurrency", maxConcurrency, 32], ["timeoutMs", timeoutMs, 3600000]] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > max)) throw new Error(`Invalid workflow ${name}: 1..${max}`);
  }
  if (workflow.executionVersion !== 2) {
    if (inputs !== undefined || maxConcurrency !== undefined || timeoutMs !== undefined) throw new Error("Workflow run overrides require executionVersion 2");
    return;
  }
  if (inputs !== undefined) {
    if (!StringRecordSchema(JsonValueSchema).safeParse(inputs).success) throw new Error("Workflow inputs must be a JSON object with only JSON values");
  }
  const supplied = (inputs ?? {}) as Record<string, unknown>;
  for (const name of Object.keys(supplied)) if (!Object.hasOwn(workflow.inputs, name)) throw new Error(`Unknown workflow input ${name}`);
  for (const [name, definition] of Object.entries(workflow.inputs)) if (definition.required && definition.default === undefined && !Object.hasOwn(supplied, name)) throw new Error(`Missing workflow input ${name}`);
}
export interface WorkflowPlanReferenceDiagnostic { readonly nodeId: string; readonly code: "request-reference" | "case-reference"; readonly logicalMissing: boolean }
export interface WorkflowPlanCall {
  readonly callerWorkflowId: string;
  readonly nodeId: string;
  readonly kind: "subflow" | "loop" | "branch" | "onError" | "finally";
  readonly branchId?: string;
  readonly workflowId: string;
  readonly inputs: DeepReadonly<Record<string, WorkflowValue>>;
  readonly outputs: Readonly<Record<string, string>>;
  readonly path: string;
}
export interface WorkflowPlanRequestSelection extends CredentialRequestSelection {
  readonly testCase: NonNullable<CredentialRequestSelection["testCase"]>;
  readonly collectionId: string;
  readonly folderIds: readonly string[];
  readonly apiId: string;
  readonly caseId: string;
  readonly scope: string;
}
export interface WorkflowExecutionTerm {
  readonly workflowId: string;
  readonly nodeId: string;
  readonly selectionIndex: number;
  /** Sum terms for shared calls and parallel branches; loops and retries multiply. */
  readonly maxAttempts: number;
  readonly maxCalls: number | null;
  readonly dataRows: number | null;
}
export interface CompiledWorkflowPlan {
  readonly projectId: string;
  readonly definitionRevision: string;
  readonly rootWorkflowId: string;
  readonly environmentId?: string;
  readonly workflowIds: readonly string[];
  readonly workflows: readonly DeepReadonly<Workflow>[];
  readonly calls: readonly WorkflowPlanCall[];
  readonly selections: readonly WorkflowPlanRequestSelection[];
  readonly referenceDiagnostics: readonly WorkflowPlanReferenceDiagnostic[];
  readonly conservativeExecutions: {
    readonly upperBound: number | null;
    readonly exact: false;
    readonly requiresPreparedData: boolean;
    readonly outerIterations: "caller-supplied";
    readonly terms: readonly WorkflowExecutionTerm[];
  };
}
export class WorkflowPlanError extends Error {
  constructor(readonly code: string, message: string, readonly workflowId?: string, readonly nodeId?: string, readonly path?: string) {
    super(`工作流配置错误 [${code}]: ${message}`);
    this.name = "WorkflowPlanError";
  }
}
const owners = new WeakMap<CompiledWorkflowPlan, ProjectSnapshot>();
function fail(code: string, message: string, workflowId?: string, nodeId?: string, path?: string): never { throw new WorkflowPlanError(code, message, workflowId, nodeId, path); }

/** Pure structural/reference preflight; no credentials, files, protocol or mutable project lookup. */
export function inspectWorkflowClosure(project: DeepReadonly<ContractProject>, rootWorkflowId: string, options: WorkflowPlanOptions = {}, purpose: "execution" | "enablement" = "execution") {
  const workflowIds: string[] = [];
  const workflows = new Map<string, DeepReadonly<Workflow>>();
  const calls: WorkflowPlanCall[] = [];
  const selections: WorkflowPlanRequestSelection[] = [];
  const requestIndexes = new Map<string, number>();
  const nodeSelections = new Map<string, number>();
  const referenceDiagnostics: WorkflowPlanReferenceDiagnostic[] = [];
  const active = new Set<string>();
  const heights = new Map<string, number>();
  if (options.environmentId !== undefined && project.environments.filter((item) => item.id === options.environmentId).length !== 1) fail("environment-reference", "环境不存在或有歧义");
  const visit = (id: string): number => {
    if (active.has(id)) fail("workflow-recursion", `检测到递归调用 ${[...active, id].join(" → ")}`, id);
    const height = heights.get(id);
    if (height !== undefined) return height;
    if (active.size >= 8) fail("call-depth", "工作流调用深度超过 8", id);
    const matches = project.workflows.filter((workflow) => workflow.id === id);
    if (matches.length !== 1) fail("workflow-reference", `工作流不存在、跨项目或身份重复: ${id}`, id);
    const raw = matches[0]!;
    const result = WorkflowSchema.safeParse(raw);
    if (!result.success) fail("workflow-schema", result.error.message, id);
    const workflow = result.data;
    const reportReferences = purpose === "execution" && id === rootWorkflowId && workflow.executionVersion !== 2 && options.legacyRootReferenceMode === "report";
    if (workflow.status === "draft" && !options.allowDraft) fail("workflow-draft", `draft 工作流 ${id} 需要 allowDraft`, id);
    const issues = validateWorkflowStructure(workflow).filter((issue) => issue.level === "error");
    if (!workflow.nodes.length) fail("empty-workflow", "工作流没有任何节点", id);
    if (issues.length) fail(issues[0]!.code, issues.map((issue) => issue.message).join("; "), id);
    active.add(id);
    workflowIds.push(id);
    workflows.set(id, workflow);
    let maxChildHeight = 0;
    for (const node of workflow.nodes) {
      if (node.kind === "request") {
        const candidates = allApiMatches(project, node.apiId);
        if (!node.apiId || !node.caseId || candidates !== 1) {
          if (reportReferences && candidates <= 1) { referenceDiagnostics.push({ nodeId: node.id, code: "request-reference", logicalMissing: true }); continue; }
          fail("request-reference", `接口/用例不存在或有歧义: ${node.apiId}/${node.caseId}`, id, node.id);
        }
        const location = findProjectApi(project, node.apiId)!;
        // Enablement validates the logical case across its declared scopes without choosing an environment.
        // Compilation still resolves exactly one physical case for this invocation's environment.
        const selected = purpose === "enablement" ? location.api.cases.filter((candidate) => candidate.id === node.caseId)
          : selectEffectiveCases(location.api.cases, resolveExecutionEnvironment(project, location.collection.id, options.environmentId).chain, node.caseId);
        if (selected.length === 0 && reportReferences) { referenceDiagnostics.push({ nodeId: node.id, code: "case-reference", logicalMissing: !location.api.cases.some((testCase) => testCase.id === node.caseId) }); continue; }
        if (selected.length === 0 || (purpose === "execution" && selected.length !== 1)
          || selected.some((testCase) => location.api.cases.filter((candidate) => candidate.id === testCase.id && candidate.scope === testCase.scope).length !== 1)) fail("case-reference", `用例不存在或 scope 有歧义: ${node.caseId}`, id, node.id);
        const retry = "policy" in node ? node.policy?.retry : undefined;
        for (const testCase of selected) {
          const request = getEffectiveCaseRequest(location.api, testCase);
          if (retry && retry.maxAttempts > 1 && !(request.protocol === "http" && ["GET", "HEAD", "OPTIONS"].includes(request.method)) && !retry.allowRepeatSideEffects) fail("retry-side-effects", "重复副作用需要 allowRepeatSideEffects", id, node.id);
          const driver = testCase.dataDriver;
          if (driver && "kind" in driver && (project.datasets ?? []).filter((dataset) => dataset.id === driver.datasetId).length !== 1) fail("dataset-reference", "数据集不存在或有歧义", id, node.id);
          if (purpose === "enablement") continue;
          const key = JSON.stringify([location.collection.id, location.folders.map((folder) => folder.id), location.api.contract.id, testCase.id, testCase.scope]);
          let index = requestIndexes.get(key);
          if (index === undefined) {
            index = selections.length;
            requestIndexes.set(key, index);
            selections.push({ asset: location.api, testCase, collectionId: location.collection.id, folderIds: location.folders.map((folder) => folder.id), apiId: node.apiId, caseId: testCase.id, scope: testCase.scope });
          }
          nodeSelections.set(JSON.stringify([id, node.id]), index);
        }
      }
      if (node.kind === "parallel") {
        if (new Set(node.branches.map((branch) => branch.id)).size !== node.branches.length) fail("duplicate-branch-id", "并行分支 ID 重复", id, node.id);
        if (node.join === "all") {
          const targets = node.branches.flatMap((branch) => Object.values(branch.outputs));
          if (new Set(targets).size !== targets.length) fail("output-conflict", "AND 分支输出目标冲突", id, node.id);
        }
      }
      for (const call of workflowCalls(node)) {
        const childHeight = visit(call.workflowId);
        maxChildHeight = Math.max(maxChildHeight, childHeight);
        const child = workflows.get(call.workflowId)!;
        if (child.executionVersion === 2) {
          for (const name of Object.keys(call.inputs)) if (!Object.hasOwn(child.inputs, name)) fail("input-mapping", `未知子输入 ${name}`, id, node.id);
          for (const [name, definition] of Object.entries(child.inputs)) if (definition.required && definition.default === undefined && !Object.hasOwn(call.inputs, name)) fail("input-required", `缺少必填子输入 ${name}`, id, node.id);
          for (const name of Object.keys(call.outputs)) if (!Object.hasOwn(child.outputs, name)) fail("output-mapping", `未知子输出 ${name}`, id, node.id);
        }
        const targets = Object.values(call.outputs);
        if (new Set(targets).size !== targets.length) fail("output-conflict", "多个输出写同一目标", id, node.id);
        calls.push({ callerWorkflowId: id, nodeId: node.id, ...call });
      }
    }
    active.delete(id);
    const resultHeight = maxChildHeight + 1;
    if (resultHeight > 8) fail("call-depth", "工作流调用深度超过 8", id);
    heights.set(id, resultHeight);
    return resultHeight;
  };
  visit(rootWorkflowId);
  return { workflowIds, workflows, calls, selections, nodeSelections, referenceDiagnostics };
}

export function compileWorkflowPlan(snapshot: ProjectSnapshot, workflowId: string, options: WorkflowPlanOptions = {}): CompiledWorkflowPlan {
  const closure = inspectWorkflowClosure(snapshot.project, workflowId, options);
  const memo = new Map<string, WorkflowExecutionTerm[]>();
  const multiply = (left: number | null, right: number): number | null => {
    if (right === 0 || left === 0) return 0;
    return left !== null && Number.isSafeInteger(left * right) ? left * right : null;
  };
  const expand = (id: string): WorkflowExecutionTerm[] => {
    const cached = memo.get(id);
    if (cached) return cached;
    const terms = new Map<string, WorkflowExecutionTerm>();
    const add = (term: WorkflowExecutionTerm) => {
      const key = JSON.stringify([term.workflowId, term.nodeId]);
      const old = terms.get(key);
      const sum = old ? old.maxCalls === null || term.maxCalls === null ? null : old.maxCalls + term.maxCalls : term.maxCalls;
      terms.set(key, { ...term, maxCalls: sum !== null && Number.isSafeInteger(sum) ? sum : null });
    };
    const workflow = closure.workflows.get(id)!;
    for (const node of workflow.nodes) {
      if (node.kind === "request") {
        const selectionIndex = closure.nodeSelections.get(JSON.stringify([id, node.id]));
        if (selectionIndex === undefined) continue;
        const testCase = closure.selections[selectionIndex]!.testCase;
        const driver = testCase.dataDriver;
        const dataRows = driver === undefined ? 1 : "kind" in driver ? snapshot.project.datasets!.find((dataset) => dataset.id === driver.datasetId)!.rows.length : null;
        add({ workflowId: id, nodeId: node.id, selectionIndex, maxCalls: 1, maxAttempts: "policy" in node ? node.policy?.retry?.maxAttempts ?? 1 : 1, dataRows });
      }
      for (const call of workflowCalls(node)) {
        const multiplier = call.kind === "loop" && node.kind === "loop" ? node.count ?? node.maxIterations : 1;
        for (const term of expand(call.workflowId)) add({ ...term, maxCalls: multiply(term.maxCalls, multiplier) });
      }
    }
    const result = [...terms.values()];
    memo.set(id, result);
    return result;
  };
  const terms = expand(workflowId);
  const requiresPreparedData = terms.some((term) => term.dataRows === null && term.maxCalls !== 0);
  const overflow = terms.some((term) => term.maxCalls === null);
  const total = terms.reduce((sum, term) => sum + (term.maxCalls ?? 0) * term.maxAttempts * (term.dataRows ?? 0), 0);
  const plan: CompiledWorkflowPlan = { projectId: snapshot.project.id, definitionRevision: snapshot.definitionRevision, rootWorkflowId: workflowId,
    ...(options.environmentId === undefined ? {} : { environmentId: options.environmentId }), workflowIds: closure.workflowIds, workflows: [...closure.workflows.values()], calls: closure.calls, selections: closure.selections,
    referenceDiagnostics: closure.referenceDiagnostics,
    conservativeExecutions: { upperBound: requiresPreparedData || overflow || !Number.isSafeInteger(total) ? null : total, exact: false, requiresPreparedData, outerIterations: "caller-supplied", terms } };
  freeze(plan);
  owners.set(plan, snapshot);
  return plan;
}

export function workflowPlanRequests(snapshot: ProjectSnapshot, plan: CompiledWorkflowPlan): CredentialRequestSelection[] {
  assertWorkflowPlanOwner(snapshot, plan);
  return plan.selections.map((selection) => {
    const location = findProjectApi(snapshot.project, selection.apiId);
    if (location?.api !== selection.asset || !location.api.cases.includes(selection.testCase)) fail("plan-selection", "计划所选请求不属于此快照");
    return { asset: selection.asset, testCase: selection.testCase };
  });
}
/** Constant-time host owner check; prepared runs already validated selections/data once. */
export function assertWorkflowPlanOwner(snapshot: ProjectSnapshot, plan: CompiledWorkflowPlan): void {
  if (owners.get(plan) !== snapshot || snapshot.definitionRevision !== plan.definitionRevision || snapshot.project.id !== plan.projectId) fail("plan-snapshot", "计划不属于此固定快照或 revision 已改变");
}
/** Resolve logical multipliers against the actual prepared physical rows, never expand invocations. */
export function validateWorkflowPlanData(snapshot: ProjectSnapshot, plan: CompiledWorkflowPlan, data: PreparedTestData | undefined,
  options: { preparedRowIndex?: number; maxExecutions?: number } = {}): number {
  workflowPlanRequests(snapshot, plan);
  if (data && (data.projectId !== snapshot.project.id || data.definitionRevision !== snapshot.definitionRevision)) fail("data-preparation", "准备数据不属于此固定快照");
  const counts = plan.selections.map((selection) => {
    const key = JSON.stringify([selection.collectionId, [...selection.folderIds], selection.apiId, selection.caseId, selection.scope]);
    const prepared = data?.selections.find((item) => item.key === key);
    if (data && !prepared) fail("data-selection", "用例不属于本次准备选择集");
    const source = prepared?.sourceKey === undefined ? undefined : data?.sources.find((item) => item.key === prepared.sourceKey);
    if ((selection.testCase.dataDriver || prepared?.datasetId !== undefined || prepared?.sourceKey !== undefined) && !source) fail("data-preparation", "所选数据来源未准备");
    if (source?.diagnostics.some((item) => item.code !== "legacy-empty-fallback")) fail("data-preparation", "所选数据来源准备失败");
    const rows = source?.rows.length || 1;
    if (options.preparedRowIndex !== undefined && (!Number.isInteger(options.preparedRowIndex) || options.preparedRowIndex < 0 || options.preparedRowIndex >= rows)) fail("data-row", "所选准备数据行不存在");
    return options.preparedRowIndex === undefined ? rows : 1;
  });
  let total = 0;
  for (const term of plan.conservativeExecutions.terms) {
    if (term.maxCalls === null) fail("execution-bound", "执行保守上界超出安全整数");
    total += term.maxCalls * term.maxAttempts * counts[term.selectionIndex]!;
    if (!Number.isSafeInteger(total) || (options.maxExecutions !== undefined && total > options.maxExecutions)) fail("execution-bound", `预计 executeCase 超过 ${options.maxExecutions ?? "安全整数"} 次`);
  }
  return total;
}
function freeze(value: unknown): void {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.values(value).forEach(freeze); Object.freeze(value); }
}
function allApiMatches(project: DeepReadonly<ContractProject>, apiId: string | undefined): number {
  const visit = (container: DeepReadonly<ContractProject["collections"][number]> | DeepReadonly<ContractProject["collections"][number]["folders"][number]>): number =>
    container.apis.filter((asset) => asset.contract.id === apiId).length + container.folders.reduce((sum, folder) => sum + visit(folder), 0);
  return project.collections.reduce((sum, collection) => sum + visit(collection), 0);
}

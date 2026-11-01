import type { ProjectSnapshot } from "../assets/snapshot.js";
import type { AiApiLocator } from "./context.js";
import type { DeepReadonly } from "../assets/context.js";
import type { ApiAsset } from "../contract/model.js";
import type { ContractFolder } from "../contract/workspace.js";
import type { WorkflowValue, WorkflowPredicate, WorkflowNode } from "../workflow/model.js";
import { componentAiView, contractAiView, schemaAiView, safeAiValue, redactAiText, redactProjectionText, assertionAiView } from "./contractView.js";

export type AiAssetSelection =
  | { kind: "api"; locator: AiApiLocator }
  | { kind: "case"; locator: AiApiLocator & { caseId: string; scope: string } }
  | { kind: "models" | "components" | "workflows" | "datasets" | "suites" | "environments"; id: string };
export interface AiAssetProjection { asset: Record<string, unknown>; omitted: string[] }

const omitted = ["scripts", "dataset-rows", "request-response-bodies", "example-values", "secret-values-and-references", "absolute-attachment-paths"];
function selectedApi(snapshot: ProjectSnapshot, locator: AiApiLocator): DeepReadonly<ApiAsset> {
  let container: DeepReadonly<{ folders: ContractFolder[]; apis: ApiAsset[] }> | undefined = snapshot.project.collections.find(item => item.id === locator.collectionId);
  for (const id of locator.folderIds) container = container?.folders.find(item => item.id === id);
  const api = container?.apis.find(item => item.contract.id === locator.apiId);
  if (!api || !snapshot.context.getContract(api.contract.id)) throw new Error("asset-selection-unavailable");
  return api;
}
const values = (entries: Readonly<Record<string, string>>) => Object.fromEntries(Object.entries(entries).map(([name, value]) => [redactAiText(name), safeAiValue(value, name)]));
function workflowValue(value: DeepReadonly<WorkflowValue>, field?: string): unknown {
  return value.kind === "literal" ? { kind: "literal", value: safeAiValue(value.value, field) } : { kind: "ref", source: value.source, path: [...value.path] };
}
function mappings(entries: DeepReadonly<Record<string, WorkflowValue>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, workflowValue(value, name)]));
}
function predicate(value: DeepReadonly<WorkflowPredicate>): unknown {
  if (value.op === "and" || value.op === "or") return { op: value.op, items: value.items.map(predicate) };
  if (value.op === "not") return { op: value.op, item: predicate(value.item) };
  if (value.op === "exists" || value.op === "notExists") return { op: value.op, value: workflowValue(value.value) };
  const comparison = value as DeepReadonly<Extract<WorkflowPredicate, { left: WorkflowValue }>>;
  const field = (operand: DeepReadonly<WorkflowValue>) => operand.kind === "ref" ? operand.path.map(String).join(".") : undefined;
  return { op: comparison.op, left: workflowValue(comparison.left, field(comparison.right)), right: workflowValue(comparison.right, field(comparison.left)) };
}
function policy(value: DeepReadonly<WorkflowNode["policy"]>): unknown {
  if (!value) return undefined;
  const retry = "retry" in value ? value.retry : undefined;
  return { timeoutMs: value.timeoutMs,
    onError: value.onError ? { workflowId: value.onError.workflowId, timeoutMs: value.onError.timeoutMs, mode: value.onError.mode } : undefined,
    finally: value.finally ? { workflowId: value.finally.workflowId, timeoutMs: value.finally.timeoutMs } : undefined,
    retry: retry ? { maxAttempts: retry.maxAttempts, retryOn: [...retry.retryOn], delayMs: retry.delayMs, backoff: retry.backoff, allowRepeatSideEffects: retry.allowRepeatSideEffects } : undefined };
}
function node(value: DeepReadonly<WorkflowNode>): Record<string, unknown> {
  const base = { id: value.id, kind: value.kind, label: value.label, policy: policy(value.policy) };
  switch (value.kind) {
    case "request": case "noop": return { ...base, apiId: value.apiId, caseId: value.caseId };
    case "assign": return { ...base, assignments: mappings(value.assignments) };
    case "delay": return { ...base, delayMs: value.delayMs };
    case "assert": case "condition": return { ...base, predicate: predicate(value.predicate) };
    case "subflow": return { ...base, workflowId: value.workflowId, inputs: mappings(value.inputs), outputs: { ...value.outputs } };
    case "loop": return { ...base, workflowId: value.workflowId, inputs: mappings(value.inputs), outputs: { ...value.outputs }, count: value.count, while: value.while ? predicate(value.while) : undefined, until: value.until ? predicate(value.until) : undefined, maxIterations: value.maxIterations };
    case "parallel": return { ...base, join: value.join, branches: value.branches.map(branch => ({ id: branch.id, workflowId: branch.workflowId, inputs: mappings(branch.inputs), outputs: { ...branch.outputs } })) };
  }
}

/** Closed per-kind selection from one immutable snapshot; never a raw-asset serializer. */
export function projectAiAsset(snapshot: ProjectSnapshot, selection: AiAssetSelection): AiAssetProjection {
  let asset: Record<string, unknown> | undefined;
  if (selection.kind === "api" || selection.kind === "case") {
    const api = selectedApi(snapshot, selection.locator);
    if (selection.kind === "api") asset = contractAiView(api, snapshot.context, { includeBodies: false });
    else {
      const selected = api.cases.find(item => item.id === selection.locator.caseId && item.scope === selection.locator.scope);
      if (!selected) throw new Error("asset-selection-unavailable");
      asset = { id: selected.id, name: selected.name, scope: selected.scope, locator: { collectionId: selection.locator.collectionId, folderIds: [...selection.locator.folderIds], apiId: api.contract.id, caseId: selected.id, scope: selected.scope }, parameters: values(selected.parameters),
        assertions: selected.assertions.map(assertionAiView),
        requestSettings: selected.requestSettingsOverride ? { ...selected.requestSettingsOverride } : undefined,
        operations: { pre: selected.preOperations.length, post: selected.postOperations.length }, tags: selected.tags ? [...selected.tags] : [] };
    }
  } else {
    const project = snapshot.project;
    switch (selection.kind) {
      case "models": { const selected = snapshot.context.getModel(selection.id); if (selected) asset = { id: selected.id, name: selected.name, description: selected.description, schema: schemaAiView(selected.schema, snapshot.context) }; break; }
      case "components": { const selected = snapshot.context.getComponent(selection.id); if (selected) asset = componentAiView(selected, snapshot.context); break; }
      case "datasets": { const selected = project.datasets?.find(item => item.id === selection.id); if (selected) asset = { id: selected.id, name: selected.name, description: selected.description, columns: [...selected.columns], rowCount: selected.rows.length }; break; }
      case "environments": { const selected = project.environments.find(item => item.id === selection.id); if (selected) asset = { id: selected.id, name: selected.name }; break; }
      case "suites": {
        const selected = project.suites?.find(item => item.id === selection.id);
        if (selected) asset = { id: selected.id, name: selected.name, description: selected.description, tags: [...selected.tags], failFast: selected.failFast, environmentId: selected.environmentId, datasetId: selected.datasetId,
          selection: selected.selection.kind === "query" ? { kind: "query", collectionIds: selected.selection.collectionIds ? [...selected.selection.collectionIds] : undefined, caseTags: selected.selection.caseTags ? [...selected.selection.caseTags] : undefined }
            : { kind: "explicit", entries: selected.selection.entries.map(entry => entry.kind === "workflow" ? { id: entry.id, kind: entry.kind, workflowId: entry.workflowId } : { id: entry.id, kind: entry.kind, collectionId: entry.collectionId, folderIds: [...entry.folderIds], apiId: entry.apiId, caseId: entry.caseId }) } };
        break;
      }
      case "workflows": {
        const selected = project.workflows.find(item => item.id === selection.id);
        if (selected) asset = { id: selected.id, name: selected.name, status: selected.status, executionVersion: selected.executionVersion ?? 1,
          nodes: selected.nodes.map(item => node(item as DeepReadonly<WorkflowNode>)), edges: selected.edges.map(edge => ({ id: edge.id, from: edge.from, to: edge.to, port: "port" in edge ? edge.port : undefined, ...( "condition" in edge && edge.condition ? { conditionOmitted: true } : {}) })),
          ...(selected.executionVersion === 2 ? { inputs: Object.fromEntries(Object.entries(selected.inputs).map(([name, value]) => [name, { required: value.required, ...(value.default === undefined ? {} : { default: safeAiValue(value.default, name) }) }])), outputs: mappings(selected.outputs), limits: { maxConcurrency: selected.limits.maxConcurrency, timeoutMs: selected.limits.timeoutMs } } : {}) };
        break;
      }
    }
  }
  if (!asset) throw new Error("asset-selection-unavailable");
  return { asset: redactProjectionText(asset) as Record<string, unknown>, omitted: [...omitted] };
}

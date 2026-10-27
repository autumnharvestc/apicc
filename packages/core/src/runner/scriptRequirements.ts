import type { ProjectSnapshot } from "../assets/snapshot.js";
import type { DeepReadonly } from "../assets/context.js";
import type { Operation } from "../domain/common.js";
import type { ContractFolder } from "../contract/workspace.js";
import { resolveExecutionEnvironment, selectEffectiveCases } from "../domain/executionSelection.js";
import { inspectWorkflowClosure } from "../workflow/plan.js";
import type { PluginRegistry } from "../plugin/registry.js";

/** Core-owned semantic locations. File/hash mapping belongs to the execution host. */
export interface CoreScriptRequirement { scriptId: string; content: string; kind: "pre" | "post" | "condition"; location: string }
const declarations = new WeakMap<CoreScriptRequirement, object>();
function requirement(value: CoreScriptRequirement, declaration: object): CoreScriptRequirement { declarations.set(value, declaration); return value; }
/** Repeated references may share a declaration; distinct declarations cannot share its stable ID. */
export function mergeScriptRequirements(requirements: readonly CoreScriptRequirement[]): CoreScriptRequirement[] {
  const unique = new Map<string, CoreScriptRequirement>();
  for (const item of requirements) {
    const previous = unique.get(item.scriptId);
    if (previous && (!declarations.has(item) || declarations.get(previous) !== declarations.get(item))) throw new Error(`Script identity conflict: ${item.scriptId}`);
    if (!previous) unique.set(item.scriptId, item);
  }
  return [...unique.values()];
}
export interface CollectionScriptSelection { apiId: string; caseId: string; folderIds: readonly string[]; scope?: string }
export function collectionScriptRequirements(snapshot: ProjectSnapshot, collectionId: string, options: { environmentId?: string; caseSelection?: CollectionScriptSelection } = {}): CoreScriptRequirement[] {
  const collection = snapshot.project.collections.find(c => c.id === collectionId);
  if (!collection) throw new Error(`配置错误: 集合不存在 ${collectionId}`);
  const chain = resolveExecutionEnvironment(snapshot.project, collectionId, options.environmentId).chain;
  const result: CoreScriptRequirement[] = [];
  const add = (operations: readonly DeepReadonly<Operation>[], kind: "pre" | "post", location: string) => {
    for (const operation of operations) if (operation.type === "script") result.push(requirement({ scriptId: `${location}/${kind}/${operation.id}`, content: operation.content, kind, location }, operation));
  };
  const visit = (container: typeof collection | DeepReadonly<ContractFolder>, folders: readonly string[]) => {
    const selected = options.caseSelection;
    if (selected && (folders.length > selected.folderIds.length || folders.some((id, i) => selected.folderIds[i] !== id))) return;
    const location = `collection/${collectionId}${folders.map(id => `/folder/${id}`).join("")}`;
    add(container.preOperations, "pre", location); add(container.postOperations, "post", location);
    for (const asset of container.apis) {
      if (selected && (asset.contract.id !== selected.apiId || folders.length !== selected.folderIds.length)) continue;
      for (const testCase of selectEffectiveCases(asset.cases, chain, selected?.caseId)) {
        if (selected?.scope !== undefined && selected.scope !== testCase.scope) continue;
        const owner = `${location}/api/${asset.contract.id}/case/${testCase.id}/scope/${testCase.scope}`;
        add(testCase.preOperations, "pre", owner); add(testCase.postOperations, "post", owner);
      }
    }
    for (const folder of container.folders) visit(folder, [...folders, folder.id]);
  };
  visit(collection, []); return mergeScriptRequirements(result);
}
export function workflowScriptRequirements(snapshot: ProjectSnapshot, workflowId: string, environmentId?: string): CoreScriptRequirement[] {
  const closure = inspectWorkflowClosure(snapshot.project, workflowId, { environmentId, allowDraft: true, legacyRootReferenceMode: "report" });
  const result: CoreScriptRequirement[] = [];
  for (const selection of closure.selections) result.push(...collectionScriptRequirements(snapshot, selection.collectionId, { environmentId, caseSelection: selection }));
  for (const workflow of closure.workflows.values()) if (workflow.executionVersion !== 2) for (const edge of workflow.edges) if (edge.condition?.trim()) {
    // Closure validation parses workflow copies. Bind back to the immutable declaration,
    // so two callers of the same child condition share its actual source identity.
    const declaration = snapshot.project.workflows.find(flow => flow.id === workflow.id)!.edges.find(candidate => candidate.id === edge.id)!;
    result.push(requirement({ scriptId: `workflow/${workflow.id}/edge/${edge.id}`, content: edge.condition, kind: "condition", location: `workflow/${workflow.id}/edge/${edge.id}` }, declaration));
  }
  return mergeScriptRequirements(result);
}
export function assertScriptRequirements(registry: PluginRegistry, requirements: readonly CoreScriptRequirement[]): void {
  if (requirements.length && !registry.getScriptEngine("javascript")) throw new Error(`缺少 javascript 脚本引擎插件: ${requirements[0]!.scriptId}`);
}

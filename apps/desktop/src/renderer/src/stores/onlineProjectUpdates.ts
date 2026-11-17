import { findProjectSaveApi, type ProjectSaveConflict, type ProjectSaveOperation } from "@apicc/core/collaboration/project-save";
import type { ContractProject } from "@apicc/core";

export { projectChanges } from "../../../shared/project-updates.js";
export type { WorkspaceObservedAssetChange as OnlineProjectChange } from "../../../shared/workspace-refresh.js";

export function projectSaveDetails(change: ProjectSaveOperation, conflict: ProjectSaveConflict, project: ContractProject | null) {
  if (change.kind === "workflow-create") return { submitted: change.workflow.name, current: project?.workflows.find(row => row.id === change.workflow.id)?.name };
  const latest = project && findProjectSaveApi(project, change.target);
  const valueAt = (value: unknown, field?: string): unknown =>
    field && value && typeof value === "object" && field in value ? (value as Record<string, unknown>)[field] : value;
  if (change.kind === "case") {
    const identity = conflict.physicalCase ?? { caseId: change.submitted.id, scope: change.submitted.scope };
    const selected = identity.caseId === change.submitted.id && identity.scope === change.submitted.scope;
    const baseline = selected ? change.baseline : change.deletes.find(row => row.caseId === identity.caseId && row.scope === identity.scope)?.baseline;
    const current = latest?.cases.find(row => row.id === identity.caseId && row.scope === identity.scope);
    return { baseline: valueAt(baseline, conflict.field), submitted: selected ? valueAt(change.submitted, conflict.field) : undefined,
      current: valueAt(current, conflict.field) };
  }
  function value(asset: typeof latest) {
    if (conflict.area === "metadata") return valueAt(asset?.contract.metadata, conflict.field);
    if (conflict.area === "request") return valueAt(asset?.contract.request, conflict.field);
    if (conflict.area === "responses") return asset?.contract.responses;
    if (conflict.area === "documentation") return asset?.documentation;
    return asset?.contract.metadata.name;
  }
  return { baseline: value(change.baseline), submitted: value(change.submitted), current: value(latest ?? undefined) };
}

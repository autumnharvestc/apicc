import { encodeContractWorkspace, type ApiTestCase, type ContractProject, type ContractWorkspace } from "@apicc/core";
import { findProjectSaveApi, projectSaveDependencies, sameProjectSaveValue, type ProjectSaveIntent } from "@apicc/core/collaboration/project-save";
import type { ApiLocator, ProjectLocator } from "../shared/locations.js";
import { localWorkspaceError, type WorkspaceObservationResult } from "../shared/workspace-refresh.js";
import { projectChanges } from "../shared/project-updates.js";
import { workspaceCaseDependencies, workspaceRequestDependencies } from "../shared/workspace-api-dependencies.js";

function findProject(workspace: ContractWorkspace, locator: ProjectLocator): ContractProject | undefined {
  if (workspace.id !== locator.workspaceId) return;
  return workspace.groups.find(group => group.id === locator.groupId)?.projects.find(project => project.id === locator.projectId);
}

type ApiWrite = { locator: ApiLocator } & ({ kind: "api" }
  | { kind: "case"; case: { id: string; scope: string }; deletes?: readonly { caseId: string; scope: string }[] });
type ProjectWrite = { kind: "project-asset"; locator: ProjectLocator; selected: (project: ContractProject) => unknown;
  dependencies?: (workspace: ContractWorkspace, project: ContractProject) => unknown };
export type WorkspaceWriteUnit = ApiWrite | ProjectWrite;

export function assertIndependentWorkspaceSave(root: string, before: ContractWorkspace, proposed: ContractWorkspace, disk: ContractWorkspace, write: WorkspaceWriteUnit) {
  if (write.kind !== "project-asset") return assertIndependentApiSave(root, before, proposed, disk, write);
  const baseline = findProject(before, write.locator), latest = findProject(disk, write.locator);
  if (!baseline || !latest) throw localWorkspaceError("asset-missing", "The project was removed from its original location.", root);
  const old = write.selected(baseline), next = write.selected(latest);
  if (old !== undefined && next === undefined) throw localWorkspaceError("asset-missing", "The asset was removed from disk.", root);
  if (!sameProjectSaveValue(old, next)) throw localWorkspaceError("asset-changed", "The asset was changed on disk.", root);
  if (write.dependencies && !sameProjectSaveValue(write.dependencies(before, baseline), write.dependencies(disk, latest))) {
    throw localWorkspaceError("dependency-changed", "An asset dependency was changed on disk.", root);
  }
}

/** The first local release admits only an unchanged complete target. Reuse
 * the online business dependency comparison without enabling field merging. */
export function assertIndependentApiSave(root: string, before: ContractWorkspace, proposed: ContractWorkspace, disk: ContractWorkspace, write: ApiWrite) {
  const { locator } = write;
  const baselineProject = findProject(before, locator);
  const submittedProject = findProject(proposed, locator);
  const latestProject = findProject(disk, locator);
  const baseline = baselineProject && findProjectSaveApi(baselineProject, locator);
  const submitted = submittedProject && findProjectSaveApi(submittedProject, locator);
  const latest = latestProject && findProjectSaveApi(latestProject, locator);
  if (!baselineProject || !submittedProject || !baseline || !submitted || !latestProject || !latest) {
    throw localWorkspaceError("asset-missing", "The API target is unavailable in the disk snapshot.", root);
  }
  if (write.kind === "api" && !sameProjectSaveValue(baseline, latest)) {
    throw localWorkspaceError("asset-changed", "The API target was changed on disk.", root);
  }
  const matches = (value: { id: string; scope: string }, target: { caseId: string; scope: string }) => target.caseId === value.id && target.scope === value.scope;
  let operation: ProjectSaveIntent = { kind: "api", target: locator, baseline, submitted };
  if (write.kind === "case") {
    const identity = { caseId: write.case.id, scope: write.case.scope };
    const selected = submitted.cases.find(row => matches(row, identity));
    if (!selected) throw localWorkspaceError("asset-missing", "The case target is unavailable in the disk snapshot.", root);
    for (const target of [identity, ...(write.deletes ?? [])]) {
      const old = baseline.cases.find(row => matches(row, target));
      const current = latest.cases.find(row => matches(row, target));
      if (old && !current) throw localWorkspaceError("asset-missing", "The case target was removed from disk.", root);
      if (!sameProjectSaveValue(old, current)) throw localWorkspaceError("asset-changed", "The case target was changed on disk.", root);
    }
    const deletes = (write.deletes ?? []).flatMap(target => {
      const saved = baseline.cases.find(row => matches(row, target));
      return saved ? [{ ...target, baseline: saved }] : [];
    });
    operation = { kind: "case", target: locator, baselineRequest: baseline.contract.request, submitted: selected,
      baseline: baseline.cases.find(row => row.id === selected.id && row.scope === selected.scope) ?? null, deletes };
    if ((!selected.requestOverride || operation.baseline && !operation.baseline.requestOverride || deletes.some(item => !item.baseline.requestOverride))
          && !sameProjectSaveValue(latest.contract.request, baseline.contract.request)
        || latest.contract.request.protocol !== baseline.contract.request.protocol) {
      throw localWorkspaceError("dependency-changed", "The case's request definition changed on disk.", root);
    }
  }
  const requestChanged = !sameProjectSaveValue(baseline.contract.request, submitted.contract.request);
  if (write.kind === "case" && !sameProjectSaveValue(before.variables, disk.variables)
      || projectSaveDependencies(baselineProject, operation) !== projectSaveDependencies(latestProject, operation)) {
    throw localWorkspaceError("dependency-changed", "An API dependency was changed on disk.", root);
  }
  if (requestChanged && !sameProjectSaveValue(workspaceRequestDependencies(before, locator), workspaceRequestDependencies(disk, locator))) {
    throw localWorkspaceError("dependency-changed", "An API execution dependency was changed on disk.", root);
  }
  if (operation.kind === "api") {
    const changes = (list: ApiTestCase[]) => new Map(list.map(item => [JSON.stringify([item.id, item.scope]), item]));
    const oldCases = changes(baseline.cases), newCases = changes(submitted.cases);
    for (const key of new Set([...oldCases.keys(), ...newCases.keys()])) {
      const oldCase = oldCases.get(key), nextCase = newCases.get(key);
      if (sameProjectSaveValue(oldCase, nextCase)) continue;
      const target = nextCase ?? oldCase!;
      const dependencies = (workspace: ContractWorkspace) => workspaceCaseDependencies(workspace, locator, baseline.contract.request, oldCase ?? null, target);
      if (!sameProjectSaveValue(dependencies(before), dependencies(disk))) {
        throw localWorkspaceError("dependency-changed", "A case execution dependency was changed on disk.", root);
      }
    }
  }
}

export function workspaceDefinitionDelta(before: ContractWorkspace, after: ContractWorkspace, explicitDeletions: readonly string[]) {
  const previous = encodeContractWorkspace(before).files, next = encodeContractWorkspace(after).files;
  const files = new Map([...next].filter(([path, content]) => content !== previous.get(path)));
  return { files, deletions: explicitDeletions.filter(path => previous.has(path) && !next.has(path)) };
}

export function observedProjectChanges(before: ContractWorkspace, after: ContractWorkspace): WorkspaceObservationResult["changes"] {
  const result: WorkspaceObservationResult["changes"] = [];
  const indexed = (workspace: ContractWorkspace) => new Map(workspace.groups.flatMap(group => group.projects.map(project =>
    [JSON.stringify([group.id, project.id]), { project, groupId: group.id, groupName: group.name }] as const)));
  const old = indexed(before), latest = indexed(after);
  const workspaceMetadata = ({ groups, ...workspace }: ContractWorkspace) => ({ ...workspace,
    groups: groups.map(({ projects: _projects, ...group }) => group) });
  const reordered = before.groups.some(group => {
    const next = after.groups.find(item => item.id === group.id);
    if (!next) return false;
    const oldIds = new Set(group.projects.map(project => project.id)), newIds = new Set(next.projects.map(project => project.id));
    const retainedOrder = group.projects.filter(project => newIds.has(project.id)).map(project => project.id);
    const newOrder = next.projects.filter(project => oldIds.has(project.id)).map(project => project.id);
    return !sameProjectSaveValue(retainedOrder, newOrder);
  });
  if (reordered || !sameProjectSaveValue(workspaceMetadata(before), workspaceMetadata(after))) {
    result.push({ name: after.name, kind: "modified", changes: [] });
  }
  for (const key of new Set([...old.keys(), ...latest.keys()])) {
    const previous = old.get(key), current = latest.get(key);
    if (previous && current && sameProjectSaveValue(previous.project, current.project)) continue;
    const target = (current ?? previous)!;
    result.push({ project: { workspaceId: after.id, groupId: target.groupId, projectId: target.project.id },
      name: target.project.name, groupName: target.groupName, kind: !previous ? "added" : !current ? "removed" : "modified",
      changes: previous && current ? projectChanges(previous.project, current.project) : [] });
  }
  return result;
}

import { findProjectSaveApi, sameProjectSaveValue, type ProjectSaveConflict, type ProjectSaveOperation } from "@apicc/core/collaboration/project-save";
import type { ContractCollection, ContractFolder, ContractProject } from "@apicc/core";

export type OnlineProjectChange = { id: string; kind: "added" | "modified" | "removed";
  asset: "project" | "module" | "folder" | "api" | "case" | "workflow" | "environment" | "dataset" | "suite" | "model" | "component";
  name: string; location?: string };
type Entry = Omit<OnlineProjectChange, "kind"> & { value: unknown };
function entries(project: ContractProject): Map<string, Entry> {
  const rows = new Map<string, Entry>();
  const add = (asset: Entry["asset"], path: string[], name: string, value: unknown, location?: string) => {
    const id = JSON.stringify([asset, ...path]);
    rows.set(id, { id, asset, name, value, ...(location ? { location } : {}) });
  };
  const { collections, workflows, environments, datasets, suites, models, components, ...properties } = project;
  add("project", [project.id], project.name, { ...properties, collections: collections.map(item => item.id),
    workflows: workflows.map(item => item.id), environments: environments.map(item => item.id),
    datasets: (datasets ?? []).map(item => item.id), suites: (suites ?? []).map(item => item.id),
    models: models.map(item => item.id), components: components.map(item => item.id) });
  const walk = (container: ContractCollection | ContractFolder, path: string[], parents: string[], kind: "module" | "folder") => {
    const { apis, folders, ...properties } = container;
    add(kind, path, container.name, { ...properties, apiOrder: apis.map(item => item.contract.id), folderOrder: folders.map(item => item.id) }, parents.join(" / "));
    const parentNames = [...parents, container.name];
    for (const item of apis) {
      const { cases, ...asset } = item;
      const apiPath = [...path, item.contract.id];
      add("api", apiPath, item.contract.metadata.name, { ...asset, caseOrder: cases.map(testCase => [testCase.id, testCase.scope]) }, parentNames.join(" / "));
      for (const testCase of cases) add("case", [...apiPath, testCase.id, testCase.scope], testCase.name, testCase, [...parentNames, item.contract.metadata.name, testCase.scope].join(" / "));
    }
    for (const folder of folders) walk(folder, [...path, folder.id], parentNames, "folder");
  };
  for (const collection of collections) walk(collection, [collection.id], [], "module");
  const lists = { workflow: workflows, environment: environments, dataset: datasets ?? [], suite: suites ?? [], model: models, component: components };
  for (const [kind, list] of Object.entries(lists)) for (const item of list) add(kind as keyof typeof lists, [item.id], item.name, item);
  return rows;
}

export function projectChanges(before: ContractProject, after: ContractProject): OnlineProjectChange[] {
  const previous = entries(before), next = entries(after);
  const changes: OnlineProjectChange[] = [];
  for (const id of new Set([...previous.keys(), ...next.keys()])) {
    const old = previous.get(id), current = next.get(id);
    if (old && current && sameProjectSaveValue(old.value, current.value)) continue;
    const { value: _value, ...entry } = (current ?? old)!;
    changes.push({ ...entry, kind: !old ? "added" : !current ? "removed" : "modified" });
  }
  return changes;
}

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

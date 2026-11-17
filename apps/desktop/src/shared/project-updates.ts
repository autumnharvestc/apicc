import { sameProjectSaveValue } from "@apicc/core/collaboration/project-save";
import type { ContractCollection, ContractFolder, ContractProject } from "@apicc/core";
import type { WorkspaceObservedAssetChange } from "./workspace-refresh.js";

type Entry = Omit<WorkspaceObservedAssetChange, "kind"> & { value: unknown };
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

export function projectChanges(before: ContractProject, after: ContractProject): WorkspaceObservedAssetChange[] {
  const previous = entries(before), next = entries(after);
  const changes: WorkspaceObservedAssetChange[] = [];
  for (const id of new Set([...previous.keys(), ...next.keys()])) {
    const old = previous.get(id), current = next.get(id);
    if (old && current && sameProjectSaveValue(old.value, current.value)) continue;
    const { value: _value, ...entry } = (current ?? old)!;
    changes.push({ ...entry, kind: !old ? "added" : !current ? "removed" : "modified" });
  }
  return changes;
}

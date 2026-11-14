import { isDefaultCollectionId } from "@apicc/core/schema";
import type { ContractProject } from "@apicc/core";
import type { OnlineDirectoryTarget, OnlineProjectView } from "../../shared/online/execution.js";
import type { OnlineTreeNodeDTO, TreeNodeDTO } from "../../shared/tree-dto.js";

export function onlineProjectTree(tree: TreeNodeDTO | null, projectId: string): OnlineTreeNodeDTO | null {
  if (!tree || tree.source !== "online") return null;
  if (tree.kind === "project" && tree.id === projectId) return tree;
  for (const child of tree.children ?? []) {
    const match = onlineProjectTree(child, projectId);
    if (match) return match;
  }
  return null;
}

export function isOnlineDirectoryBlank(view: OnlineProjectView | null): boolean {
  const assets = view?.assets;
  return !!assets && assets.version === "0" && assets.format === null && assets.contractProjectId === null && assets.files.length === 0;
}

export function labelOnlineProjectTree(root: OnlineTreeNodeDTO, project: ContractProject | null): OnlineTreeNodeDTO {
  if (!project) return root;
  const names = new Map<string, { label: string; isDefault?: boolean; method?: string }>();
  for (const collection of project.collections) {
    const id = `${root.id}/collections/${collection.id}`;
    names.set(id, { label: collection.name, isDefault: isDefaultCollectionId(project.id, collection.id) });
    const walk = (container: Pick<typeof collection, "folders" | "apis">, path: string) => {
      for (const api of container.apis) names.set(`${path}/apis/${api.contract.id}/api.yaml`, { label: api.contract.metadata.name,
        method: api.contract.request.protocol === "websocket" ? undefined : api.contract.request.method });
      for (const folder of container.folders) {
        const folderPath = `${path}/folders/${folder.id}`;
        names.set(folderPath, { label: folder.name });
        walk(folder, folderPath);
      }
    };
    walk(collection, id);
  }
  const map = (node: OnlineTreeNodeDTO): OnlineTreeNodeDTO => ({ ...node, ...names.get(node.id), children: node.children?.map(map) });
  const mapped = map(root);
  const children = mapped.children ?? [];
  mapped.children = [...children.filter(child => !child.isDefault), ...children.filter(child => child.isDefault)];
  return mapped;
}

export function onlineContainerTarget(node: OnlineTreeNodeDTO, projectId: string): Extract<OnlineDirectoryTarget, { kind: "container" }> | null {
  if (node.kind !== "collection" && node.kind !== "folder") return null;
  const [project, collections, collectionId, ...folders] = node.id.split("/");
  if (project !== projectId || collections !== "collections" || !collectionId || folders.length % 2 !== 0
    || folders.some((part, index) => index % 2 === 0 && part !== "folders")) return null;
  return { kind: "container", collectionId, folderIds: folders.filter((_part, index) => index % 2 === 1) };
}

export function onlineApiTitlePath(root: OnlineTreeNodeDTO | null, apiId: string | null): string {
  if (!root || !apiId) return "";
  function search(node: OnlineTreeNodeDTO, parents: string[]): string[] | undefined {
    if (node.kind === "api" && node.id === apiId) return parents;
    const next = node.kind === "collection" || node.kind === "folder" ? [...parents, node.label] : parents;
    for (const child of node.children ?? []) {
      const found = search(child, next);
      if (found) return found;
    }
  }
  return search(root, [])?.join(" / ") ?? "";
}

export function onlineSaveTargets(project: ContractProject | null, defaultName: string, displayDefault: (name: string) => string) {
  const options: Array<{ target: OnlineDirectoryTarget; label: string }> = [];
  const defaults = project?.collections.filter(row => isDefaultCollectionId(project.id, row.id)) ?? [];
  if (defaults.length <= 1) options.push({ target: { kind: "project-default", expectedCollectionId: defaults[0]?.id ?? null },
    label: displayDefault(defaults[0]?.name ?? defaultName) });
  for (const collection of project?.collections ?? []) {
    options.push({ target: { kind: "container", collectionId: collection.id, folderIds: [] }, label: collection.name });
    const visit = (folders: typeof collection.folders, path: string, folderIds: string[]) => {
      for (const folder of folders) {
        const target = { kind: "container" as const, collectionId: collection.id, folderIds: [...folderIds, folder.id] };
        const label = `${path} / ${folder.name}`;
        options.push({ target, label });
        visit(folder.folders, label, target.folderIds);
      }
    };
    visit(collection.folders, collection.name, []);
  }
  return options;
}

import { ApiAssetSchema, ContractProjectSchema, createDefaultCollectionId, isDefaultCollectionId, sanitizeNodeName,
  type ContractCollection, type ContractFolder, type ContractProject } from "@apicc/core";
import { makeDefaultApi } from "../session.js";
import type { OnlineDirectoryChange, OnlineDirectoryResult, OnlineDirectoryWrite, OnlineProjectView } from "../../shared/online/execution.js";
import { isBlankOnlineProject } from "./projectAssets.js";
import { isDeepStrictEqual } from "node:util";

const collectionPath = (id: string) => `collections/${id}`;
function targetPath(collectionId: string, folderIds: readonly string[]) {
  return collectionPath(collectionId) + folderIds.map(id => `/folders/${id}`).join("");
}

function allIds(value: unknown, ids = new Set<string>()): Set<string> {
  if (value && typeof value === "object") {
    if ("id" in value && typeof value.id === "string") ids.add(value.id.toLowerCase());
    for (const item of Object.values(value)) allIds(item, ids);
  }
  return ids;
}

function locateCollection(project: ContractProject, id: string) {
  const matches = project.collections.filter(item => item.id === id);
  return matches.length === 1 ? matches[0] : undefined;
}

function locateContainer(collection: ContractCollection | undefined, folderIds: readonly string[]) {
  let container: ContractCollection | ContractFolder | undefined = collection;
  for (const id of folderIds) {
    const matches: ContractFolder[] = container?.folders.filter(folder => folder.id === id) ?? [];
    container = matches.length === 1 ? matches[0] : undefined;
  }
  return container;
}

function requestTarget(project: ContractProject, change: Extract<OnlineDirectoryChange, { kind: "create-api" }>) {
  const target = change.target;
  if (target.kind === "container") return { id: target.collectionId, folderIds: target.folderIds };
  const defaults = project.collections.filter(collection => isDefaultCollectionId(project.id, collection.id));
  if (defaults.length > 1) return { status: "ambiguous-default" as const };
  const current = defaults[0]?.id ?? null;
  if (target.expectedCollectionId !== current) return { status: "target-missing" as const };
  return { id: current ?? createDefaultCollectionId(project.id, change.defaultNonce), folderIds: [], allocate: !current };
}

function savedPath(project: ContractProject, change: OnlineDirectoryChange): string | undefined {
  if (change.kind !== "create-api") {
    const collection = locateCollection(project, change.collectionId);
    if (collection?.name !== sanitizeNodeName(change.name)
      || (change.kind === "rename-default") !== isDefaultCollectionId(project.id, collection.id)) return undefined;
    return collectionPath(collection.id);
  }
  const target = change.target.kind === "project-default"
    ? { collectionId: change.target.expectedCollectionId ?? createDefaultCollectionId(project.id, change.defaultNonce), folderIds: [] }
    : change.target;
  const container = locateContainer(locateCollection(project, target.collectionId), target.folderIds);
  const matches = container?.apis.filter(item => item.contract.id === change.apiId) ?? [];
  const asset = matches.length === 1 ? matches[0] : undefined;
  if (!asset || asset.contract.metadata.name !== sanitizeNodeName(change.name) || asset.cases[0]?.id !== change.caseId
    || !isDeepStrictEqual(asset.contract.request, change.request)) return undefined;
  return `${targetPath(target.collectionId, target.folderIds)}/apis/${change.apiId}/api.yaml`;
}

export function recoverOnlineDirectoryWrite(view: OnlineProjectView, input: OnlineDirectoryWrite): OnlineDirectoryResult | undefined {
  if (!view.project || view.project.id !== (input.expectedContractProjectId ?? input.initialProjectId)) return undefined;
  const path = savedPath(view.project, input.change);
  return path ? { status: "saved", view, path, recovered: true } : undefined;
}

function collectionInput(id: string, name: string): ContractCollection {
  return { id, name, variables: {}, preOperations: [], postOperations: [], folders: [], apis: [] };
}

export function prepareOnlineDirectoryWrite(view: OnlineProjectView, input: OnlineDirectoryWrite): OnlineDirectoryResult | { project: ContractProject; path: string } {
  const recovered = recoverOnlineDirectoryWrite(view, input);
  if (recovered) return recovered;
  if (!view.project && !isBlankOnlineProject(view.assets)) return { status: "legacy-layout", view };
  if (view.assets.version !== input.expectedVersion || view.assets.contractProjectId !== input.expectedContractProjectId) return { status: "version-conflict", view };
  const project = view.project ? structuredClone(view.project) : ContractProjectSchema.parse({ id: input.initialProjectId, name: sanitizeNodeName(input.projectName), globals: {} });
  const change = input.change;
  const occupied = allIds(project);
  const name = sanitizeNodeName(change.name);
  if (change.kind === "create-module") {
    if (occupied.has(change.collectionId.toLowerCase()) || isDefaultCollectionId(project.id, change.collectionId)) return { status: "identity-conflict", view };
    project.collections.push(collectionInput(change.collectionId, name));
    return { project, path: collectionPath(change.collectionId) };
  }
  if (change.kind === "rename-default") {
    const collection = locateCollection(project, change.collectionId);
    if (!collection || !isDefaultCollectionId(project.id, collection.id)) return { status: "target-missing", view };
    collection.name = name;
    return { project, path: collectionPath(collection.id) };
  }
  const target = requestTarget(project, change);
  if ("status" in target) return { status: target.status!, view };
  const apiId = change.apiId.toLowerCase();
  const caseId = change.caseId.toLowerCase();
  if (apiId === caseId || occupied.has(apiId) || occupied.has(caseId)) return { status: "identity-conflict", view };
  let collection = locateCollection(project, target.id);
  if (target.allocate) {
    if (occupied.has(target.id.toLowerCase()) || [apiId, caseId].includes(target.id.toLowerCase())) return { status: "identity-conflict", view };
    collection = collectionInput(target.id, "未分类接口");
    project.collections.push(collection);
  }
  const container = locateContainer(collection, target.folderIds);
  if (!container) return { status: "target-missing", view };
  const { request } = change;
  const api = makeDefaultApi({ name, protocol: request.protocol, baseUrl: request.baseUrl, path: request.path,
    ...(request.protocol === "websocket" ? {} : { method: request.method }) },
    kind => kind === "contract" ? change.apiId : change.caseId, project.id);
  container.apis.push(ApiAssetSchema.parse({ ...api, contract: { ...api.contract, request: change.request } }));
  return { project, path: `${targetPath(target.id, target.folderIds)}/apis/${change.apiId}/api.yaml` };
}

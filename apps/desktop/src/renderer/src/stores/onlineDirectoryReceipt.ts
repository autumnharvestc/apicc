import { ContractProjectSchema } from "@apicc/core/schema";
import { findProjectSaveApi } from "@apicc/core/collaboration/project-save";
import type { ContractCollection, ContractFolder, ContractProject } from "@apicc/core";
import type { OnlineDirectoryResult, OnlineDirectoryWrite } from "../../../shared/online/execution.js";

type SavedDirectory = Extract<OnlineDirectoryResult, { status: "saved" }>;

/** Retain only the confirmed action when a read-back also contains other changes. */
export function projectDirectoryReceipt(prior: ContractProject | null, input: OnlineDirectoryWrite, receipt: SavedDirectory) {
  const latest = receipt.view.project;
  if (!latest || latest.id !== (input.expectedContractProjectId ?? input.initialProjectId)) return null;
  const project = prior ? JSON.parse(JSON.stringify(prior)) as ContractProject
    : ContractProjectSchema.parse({ id: latest.id, name: input.projectName, globals: {} });
  if (project.id !== latest.id) return null;
  const parts = receipt.path.split("/");
  const id = parts[1];
  if (parts[0] !== "collections" || !id) return null;
  const latestCollection = latest.collections.find(item => item.id === id);
  if (!latestCollection) return null;
  let collection = project.collections.find(item => item.id === id);
  const addedCollection = !collection;
  const change = input.change;
  if (!collection && (change.kind === "create-module" || change.kind === "create-api" && change.target.kind === "project-default"
    && !change.target.expectedCollectionId)) {
    collection = { id, name: latestCollection.name, variables: {}, preOperations: [], postOperations: [], folders: [], apis: [] };
    project.collections.push(collection);
  }
  if (!collection) return null;
  const paths = new Set<string>();
  if (!prior) paths.add("project.yaml");
  if (addedCollection || change.kind === "rename-default") paths.add(`collections/${id}/collection.yaml`);
  if (change.kind === "rename-default") collection.name = latestCollection.name;
  if (change.kind === "create-api") {
    const folderIds = change.target.kind === "container" ? change.target.folderIds : [];
    const asset = findProjectSaveApi(latest, { collectionId: id, folderIds, apiId: change.apiId });
    if (!asset) return null;
    let container: ContractCollection | ContractFolder | undefined = collection;
    for (const folderId of folderIds) {
      const folder: ContractFolder | undefined = container?.folders.find(item => item.id === folderId);
      container = folder;
    }
    if (!container) return null;
    if (!container.apis.some(item => item.contract.id === change.apiId)) {
      container.apis.push({ ...asset, cases: asset.cases.filter(item => item.id === change.caseId && item.scope === "base") });
    }
    paths.add(receipt.path);
  }
  return { project, files: receipt.view.assets.files.filter(file => paths.has(file.path)) };
}

import type { ContractProject, ContractFolder } from "../contract/workspace.js";
import type { SuiteAsset } from "./model.js";

export interface CaseReferenceLocator {
  collectionId: string;
  folderIds: readonly string[];
  apiId: string;
}

export interface TestingReference {
  ownerId: string;
  path: string;
  targetId: string;
  expectedKind: "dataset" | "workflow" | "environment" | "collection" | "contract" | "case" | "folder";
  caseLocator?: CaseReferenceLocator;
}
export function referencesFromSuite(suite: SuiteAsset): TestingReference[] {
  const refs: TestingReference[] = [];
  const add = (path: string, targetId: string, expectedKind: TestingReference["expectedKind"]) => refs.push({ ownerId: suite.id, path, targetId, expectedKind });
  if (suite.datasetId !== undefined) add("datasetId", suite.datasetId, "dataset");
  if (suite.environmentId !== undefined) add("environmentId", suite.environmentId, "environment");
  if (suite.selection.kind === "query") suite.selection.collectionIds?.forEach((id, index) => add(`selection.collectionIds[${index}]`, id, "collection"));
  else suite.selection.entries.forEach((entry, index) => {
    const path = `selection.entries[${index}]`;
    if (entry.kind === "workflow") add(`${path}.workflowId`, entry.workflowId, "workflow");
    else {
      add(`${path}.collectionId`, entry.collectionId, "collection");
      entry.folderIds.forEach((id, folderIndex) => add(`${path}.folderIds[${folderIndex}]`, id, "folder"));
      add(`${path}.apiId`, entry.apiId, "contract");
      refs.push({ ownerId: suite.id, path: `${path}.caseId`, targetId: entry.caseId, expectedKind: "case", caseLocator: { collectionId: entry.collectionId, folderIds: [...entry.folderIds], apiId: entry.apiId } });
    }
  });
  return refs;
}

export function suiteReferenceDiagnostics(project: ContractProject, suites = project.suites ?? []) {
  const diagnostics: Array<{ code: string; ownerId: string; path: string; targetId: string }> = [];
  for (const suite of suites) {
    const fail = (path: string, targetId: string) => diagnostics.push({ code: "ASSET_REFERENCE_MISSING", ownerId: suite.id, path, targetId });
    if (suite.datasetId !== undefined && !(project.datasets ?? []).some((asset) => asset.id === suite.datasetId)) fail("datasetId", suite.datasetId);
    if (suite.environmentId !== undefined && !project.environments.some((env) => env.id === suite.environmentId)) fail("environmentId", suite.environmentId);
    if (suite.selection.kind === "query") suite.selection.collectionIds?.forEach((id, index) => { if (!project.collections.some((collection) => collection.id === id)) fail(`selection.collectionIds[${index}]`, id); });
    else suite.selection.entries.forEach((entry, index) => {
      const path = `selection.entries[${index}]`;
      if (entry.kind === "workflow") { if (!project.workflows.some((workflow) => workflow.id === entry.workflowId)) fail(`${path}.workflowId`, entry.workflowId); return; }
      const collection = project.collections.find((item) => item.id === entry.collectionId);
      if (!collection) { fail(`${path}.collectionId`, entry.collectionId); return; }
      let container: { folders: ContractFolder[]; apis: ContractProject["collections"][number]["apis"] } = collection;
      for (const [folderIndex, id] of entry.folderIds.entries()) {
        const folder = container.folders.find((item) => item.id === id);
        if (!folder) { fail(`${path}.folderIds[${folderIndex}]`, id); return; }
        container = folder;
      }
      const api = container.apis.find((item) => item.contract.id === entry.apiId);
      if (!api) fail(`${path}.apiId`, entry.apiId);
      else if (!api.cases.some((item) => item.id === entry.caseId)) fail(`${path}.caseId`, entry.caseId);
    });
  }
  return diagnostics;
}

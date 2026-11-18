import { createProjectSnapshot, resolveExecutionEnvironment, selectEffectiveCases } from "@apicc/core";
import type { ContractProject, ProjectSnapshot } from "@apicc/core";
import type { CollectionLocator } from "./locations.js";

export interface CollectionLaunchInput {
  root: string;
  locator: CollectionLocator;
  environmentId?: string;
}

export interface CollectionLaunchPreview {
  revision: string;
  environmentName?: string;
  cases: Array<{ folderIds: readonly string[]; apiId: string; apiName: string; caseName: string; caseId: string; scope: string; dataDriven: boolean }>;
  skipped: Array<{ folderIds: readonly string[]; apiId: string; apiName: string }>;
}

type Collection = ProjectSnapshot["project"]["collections"][number];

function collectCollectionApis(collection: Collection) {
  const apis = collection.apis.map(asset => ({ asset, folderIds: [] as string[] }));
  const visit = (folders: Collection["folders"], parents: string[]) => {
    for (const folder of folders) {
      const folderIds = [...parents, folder.id];
      apis.push(...folder.apis.map(asset => ({asset, folderIds})));
      visit(folder.folders, folderIds);
    }
  };
  visit(collection.folders, []);
  return apis;
}

export function selectCollectionCases(snapshot: ProjectSnapshot, collection: Collection, environmentId?: string) {
  const environment = resolveExecutionEnvironment(snapshot.project, collection.id, environmentId);
  return collectCollectionApis(collection).map(({ asset, folderIds }) => ({
    asset, folderIds, cases: selectEffectiveCases(asset.cases, environment.chain),
  }));
}

export function previewCollectionLaunch(project: ContractProject, collectionId: string, environmentId?: string): CollectionLaunchPreview {
  const snapshot = createProjectSnapshot(project);
  const collection = snapshot.project.collections.find(item => item.id === collectionId);
  if (!collection) throw new Error("run-launch-target-unavailable");
  const environment = snapshot.project.environments.find(item => item.id === environmentId);
  if (environmentId && !environment) throw new Error("run-launch-environment-unavailable");
  const selected = selectCollectionCases(snapshot, collection, environmentId);
  return {
    revision: snapshot.definitionRevision,
    environmentName: environment?.name,
    cases: selected.flatMap(({ asset, folderIds, cases }) => cases.map(testCase => ({
      folderIds, apiId: asset.contract.id, apiName: asset.contract.metadata.name, caseName: testCase.name,
      caseId: testCase.id, scope: testCase.scope, dataDriven: !!testCase.dataDriver,
    }))),
    skipped: selected.filter(item => item.cases.length === 0).map(({ asset, folderIds }) => ({
      folderIds, apiId: asset.contract.id, apiName: asset.contract.metadata.name,
    })),
  };
}

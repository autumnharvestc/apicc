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

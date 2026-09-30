import type { ApiDefinition, Collection, Folder, Project, TestCase } from "../domain/model.js";

export interface ProjectApiLocation {
  api: ApiDefinition;
  collection: Collection;
  folders: Folder[];
}

function findInFolders(folders: Folder[], apiId: string, ancestors: Folder[]): { api: ApiDefinition; folders: Folder[] } | undefined {
  for (const folder of folders) {
    const nextAncestors = [...ancestors, folder];
    const api = folder.apis.find((candidate) => candidate.id === apiId);
    if (api) return { api, folders: nextAncestors };
    const nested = findInFolders(folder.folders ?? [], apiId, nextAncestors);
    if (nested) return nested;
  }
  return undefined;
}

/** 在项目模块及任意深度文件夹中定位 API，并返回其祖先容器。 */
export function findProjectApi(project: Project, apiId: string): ProjectApiLocation | undefined {
  for (const collection of project.collections) {
    const direct = collection.apis.find((candidate) => candidate.id === apiId);
    if (direct) return { api: direct, collection, folders: [] };
    const nested = findInFolders(collection.folders ?? [], apiId, []);
    if (nested) return { ...nested, collection };
  }
  return undefined;
}

function cloneFolderPath(folders: Folder[], api: ApiDefinition, testCase: TestCase): Folder[] {
  if (folders.length === 0) return [];
  const [current, ...rest] = folders;
  const selectedCases = api.cases.filter((candidate) => candidate.id === testCase.id);
  const child: Folder = {
    ...current,
    apis: rest.length === 0 ? [{ ...api, cases: selectedCases.length > 0 ? selectedCases : [testCase] }] : [],
    folders: cloneFolderPath(rest, api, testCase),
    preOperations: current.preOperations ? [...current.preOperations] : current.preOperations,
    postOperations: current.postOperations ? [...current.postOperations] : current.postOperations,
  };
  return [child];
}

/** 生成仅执行目标 API/用例的集合副本，保留模块和目标祖先容器上下文。 */
export function selectWorkflowCollection(location: ProjectApiLocation, testCase: TestCase): Collection {
  const { api, collection, folders } = location;
  const selectedCases = api.cases.filter((candidate) => candidate.id === testCase.id);
  const selectedApi = { ...api, cases: selectedCases.length > 0 ? selectedCases : [testCase] };
  return {
    ...collection,
    variables: { ...collection.variables },
    preOperations: collection.preOperations ? [...collection.preOperations] : collection.preOperations,
    postOperations: collection.postOperations ? [...collection.postOperations] : collection.postOperations,
    apis: folders.length === 0 ? [selectedApi] : [],
    folders: cloneFolderPath(folders, api, testCase),
  };
}

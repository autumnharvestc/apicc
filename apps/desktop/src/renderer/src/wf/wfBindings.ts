import type { ApiLocator, ProjectLocator } from "../../../shared/locations.js";
import type { LocalTreeNodeDTO } from "../../../shared/tree-dto.js";
import type { ApiDetail } from "../../../shared/types.js";

/** a-cascader 选项形状（value 沿用模型中的 API/case id）。 */
export interface BindOption {
  value: string;
  label: string;
  children?: BindOption[];
}

/** 单项目绑定索引；取数与名称解析均按完整 API 定位符分区。 */
export interface WfBindIndex {
  projectLocator: ProjectLocator | null;
  /** 当前项目全部接口 id：Workflow 节点仅持有 API id，missing 检测在项目内进行。 */
  apiIds: Set<string>;
  /** 完整 API 定位符 key → 接口名。 */
  apiNames: Map<string, string>;
  /** 完整 API 定位符 + case id key → 用例名。 */
  caseNames: Map<string, string>;
  /** 供持久化的 Workflow API id 反解完整 API 位置；重复 id 保留全部以消除串名。 */
  apiLocatorsById: Map<string, ApiLocator[]>;
  /** 集合→接口→用例级联选项。 */
  options: BindOption[];
}

export type FetchApiDetail = (locator: ApiLocator) => Promise<ApiDetail>;

interface TreeApiEntry {
  collectionId: string;
  collectionLabel: string;
  locator: ApiLocator;
  apiLabel: string;
}

function copyProject(locator: ProjectLocator): ProjectLocator {
  return { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId };
}

function copyApi(locator: ApiLocator): ApiLocator {
  return {
    workspaceId: locator.workspaceId,
    groupId: locator.groupId,
    projectId: locator.projectId,
    collectionId: locator.collectionId,
    folderIds: [...locator.folderIds],
    apiId: locator.apiId,
  };
}

export function sameProjectLocator(left: ProjectLocator | null, right: ProjectLocator | null): boolean {
  return !!left && !!right && left.workspaceId === right.workspaceId && left.groupId === right.groupId
    && left.projectId === right.projectId;
}

/** Stable key over every API path segment; never merge names from distinct collections/folders. */
export function apiLocatorKey(locator: ApiLocator): string {
  return JSON.stringify([
    locator.workspaceId,
    locator.groupId,
    locator.projectId,
    locator.collectionId,
    ...locator.folderIds,
    locator.apiId,
  ]);
}

export function apiCaseKey(locator: ApiLocator, caseId: string): string {
  return JSON.stringify([apiLocatorKey(locator), caseId]);
}

function sameProject(left: ProjectLocator, right: ProjectLocator): boolean {
  return left.workspaceId === right.workspaceId && left.groupId === right.groupId && left.projectId === right.projectId;
}

function findProject(node: LocalTreeNodeDTO | null, locator: ProjectLocator): LocalTreeNodeDTO | null {
  if (!node) return null;
  if (node.kind === "project" && sameProject(node.locator, locator)) return node;
  for (const child of node.children ?? []) {
    const hit = findProject(child, locator);
    if (hit) return hit;
  }
  return null;
}

function collectProjectApis(
  node: LocalTreeNodeDTO | null,
  out: TreeApiEntry[],
  collection?: { id: string; label: string },
): void {
  if (!node) return;
  if (node.kind === "collection") collection = { id: node.id, label: node.label };
  if (node.kind === "api" && collection) {
    out.push({ collectionId: collection.id, collectionLabel: collection.label, locator: copyApi(node.locator), apiLabel: node.label });
    return;
  }
  for (const child of node.children ?? []) collectProjectApis(child, out, collection);
}

function emptyIndex(projectLocator: ProjectLocator | null = null): WfBindIndex {
  return {
    projectLocator: projectLocator ? copyProject(projectLocator) : null,
    apiIds: new Set(),
    apiNames: new Map(),
    caseNames: new Map(),
    apiLocatorsById: new Map(),
    options: [],
  };
}

/** 构建单项目索引；失败接口仍存在于树索引，只缺其用例目录。 */
export async function buildBindIndex(
  tree: LocalTreeNodeDTO | null,
  projectLocator: ProjectLocator | null,
  fetchCases: FetchApiDetail,
): Promise<WfBindIndex> {
  if (!tree || !projectLocator) return emptyIndex(projectLocator);
  const project = findProject(tree, projectLocator);
  if (!project) return emptyIndex(projectLocator);

  const entries: TreeApiEntry[] = [];
  collectProjectApis(project, entries);
  const casesByApi = new Map<string, BindOption[]>();
  const caseNames = new Map<string, string>();
  await Promise.all(entries.map(async (entry) => {
    const key = apiLocatorKey(entry.locator);
    try {
      const detail = await fetchCases(copyApi(entry.locator));
      casesByApi.set(key, detail.api.cases.map((item) => ({ value: item.id, label: item.name })));
      for (const item of detail.api.cases) caseNames.set(apiCaseKey(entry.locator, item.id), item.name);
    } catch {
      casesByApi.set(key, []);
    }
  }));

  const apiIds = new Set(entries.map((entry) => entry.locator.apiId));
  const apiNames = new Map<string, string>();
  const apiLocatorsById = new Map<string, ApiLocator[]>();
  for (const entry of entries) {
    apiNames.set(apiLocatorKey(entry.locator), entry.apiLabel);
    const candidates = apiLocatorsById.get(entry.locator.apiId) ?? [];
    candidates.push(copyApi(entry.locator));
    apiLocatorsById.set(entry.locator.apiId, candidates);
  }

  const options: BindOption[] = [];
  const collections = new Map<string, BindOption>();
  for (const entry of entries) {
    let option = collections.get(entry.collectionId);
    if (!option) {
      option = { value: entry.collectionId, label: entry.collectionLabel, children: [] };
      collections.set(entry.collectionId, option);
      options.push(option);
    }
    option.children!.push({
      value: entry.locator.apiId,
      label: entry.apiLabel,
      children: casesByApi.get(apiLocatorKey(entry.locator)) ?? [],
    });
  }
  return { projectLocator: copyProject(projectLocator), apiIds, apiNames, caseNames, apiLocatorsById, options };
}

/** 将持久化 Workflow 中的 API/case ids 反查级联受控路径。 */
export function findBindPath(options: BindOption[], apiId?: string, caseId?: string): string[] {
  if (!apiId) return [];
  for (const collection of options) {
    for (const api of collection.children ?? []) {
      if (api.value !== apiId) continue;
      const path = [collection.value, api.value];
      if (!caseId) return path;
      return (api.children ?? []).some((item) => item.value === caseId) ? [...path, caseId] : path;
    }
  }
  return [];
}

export interface BindIndexLoader {
  readonly current: WfBindIndex | null;
  load(projectLocator: ProjectLocator | null): Promise<WfBindIndex | null>;
}

/** 按完整 ProjectLocator 装载，保留序号防止旧项目结果覆盖新索引。 */
export function createBindIndexLoader(
  getTree: () => LocalTreeNodeDTO | null,
  fetchCases: FetchApiDetail,
): BindIndexLoader {
  let seq = 0;
  let current: WfBindIndex | null = null;
  return {
    get current() { return current; },
    async load(projectLocator: ProjectLocator | null): Promise<WfBindIndex | null> {
      const mine = ++seq;
      if (!projectLocator || !getTree()) {
        if (mine !== seq) return null;
        current = null;
        return null;
      }
      const fixed = copyProject(projectLocator);
      const index = await buildBindIndex(getTree(), fixed, fetchCases);
      if (mine !== seq) return null;
      current = index;
      return index;
    },
  };
}

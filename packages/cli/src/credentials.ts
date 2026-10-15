import {
  CredentialError,
  createProjectSnapshot,
  createSystemSecretStore,
  defaultCredentialPrivateRoot,
  envChain,
  collectCredentialMarkersForRequests,
  collectCredentialRefsForRequests,
  collectDefinedProjectCredentialRefs,
  prepareCredentialBindings,
  selectCredentialRequests,
  type ApiAsset,
  type CredentialBindings,
  type CredentialErrorCode,
  type CredentialScope,
  type Environment,
  type CredentialRequestSelection,
  type DeepReadonly,
  type Project,
  type SecretRef,
  type SecretStore,
  type Workspace,
} from "@apicc/core";
import type { ProjectExecutionRun, ProjectSnapshot } from "@apicc/core";

export interface CredentialHostOptions {
  secretStore?: SecretStore;
  credentialPrivateRoot?: string;
}

export interface PreparedExecutionRun {
  run: ProjectExecutionRun;
  snapshot: ProjectSnapshot;
  refs: SecretRef[];
  secrets: string[];
}

export interface ExecutionCredentialSelection {
  collectionId: string;
  apiId: string;
  caseId?: string;
  scope?: string;
}

export function credentialScope(workspace: Workspace, groupId: string, project: Project): CredentialScope {
  return { workspaceId: workspace.id, groupId, projectId: project.id };
}

export function collectCredentialRefs(project: Project, assets: readonly ApiAsset[]): SecretRef[] {
  const snapshot = createProjectSnapshot(project);
  const locators = assets.map((asset) => ({ collectionId: findSourceApi(project, asset).collectionId, apiId: asset.contract.id }));
  return collectCredentialRefsForRequests(snapshot.project, selectCredentialRequests(snapshot, resolveCredentialSelections(snapshot, locators)));
}

export async function prepareExecutionRun(
  workspace: Workspace,
  groupId: string,
  project: Project,
  assets: readonly ApiAsset[],
  options: CredentialHostOptions = {},
  expectedVersions?: Readonly<Record<string, string>>,
  expectedDefinitionRevision?: string,
  selections?: readonly ExecutionCredentialSelection[],
): Promise<PreparedExecutionRun> {
  const snapshot = createProjectSnapshot(project);
  const selectedRequests = selections === undefined
    ? assets.map((asset) => {
      return { collectionId: findSourceApi(project, asset).collectionId, apiId: asset.contract.id };
    })
    : [...selections];
  const credentialSelections = resolveCredentialSelections(snapshot, selectedRequests);
  return prepareExecutionRunFromSnapshot(
    workspace,
    groupId,
    project,
    snapshot,
    credentialSelections,
    options,
    expectedVersions,
    expectedDefinitionRevision,
  );
}

export async function prepareExecutionRunFromSnapshot(
  workspace: Workspace,
  groupId: string,
  project: Project,
  snapshot: ProjectSnapshot,
  credentialSelections: readonly CredentialRequestSelection[],
  options: CredentialHostOptions = {},
  expectedVersions?: Readonly<Record<string, string>>,
  expectedDefinitionRevision?: string,
): Promise<PreparedExecutionRun> {
  const requests = selectCredentialRequests(snapshot, credentialSelections);
  const refs = collectCredentialRefsForRequests(snapshot.project, requests);
  if (expectedVersions !== undefined) {
    for (const ref of refs) {
      if (!Object.hasOwn(expectedVersions, ref.id) || typeof expectedVersions[ref.id] !== "string") {
        throw new Error(`压测 worker 凭据版本描述不完整：ref ${ref.id} 缺少 own expected version`);
      }
    }
  }

  if (expectedDefinitionRevision !== undefined && snapshot.definitionRevision !== expectedDefinitionRevision) {
    throw new Error("工作区定义在压测 worker 启动前发生变化；本次运行未发送请求");
  }
  const scope = credentialScope(workspace, groupId, project);
  let credentialBindings: CredentialBindings;
  try {
    if (refs.length === 0) {
      credentialBindings = await prepareCredentialBindings(scope, [], {} as SecretStore);
    } else {
      const store = options.secretStore ?? createSystemSecretStore({
        privateRoot: options.credentialPrivateRoot ?? defaultCredentialPrivateRoot(),
      });
      credentialBindings = await prepareCredentialBindings(scope, refs, store, expectedVersions);
    }
  } catch (error) {
    throw stableCredentialError(error);
  }

  let secrets: string[];
  try {
    secrets = collectCredentialMarkersForRequests(snapshot.project, requests, credentialBindings);
  } catch (error) {
    throw stableCredentialError(error);
  }
  return {
    run: { snapshot, credentialBindings },
    snapshot,
    refs,
    secrets,
  };
}

export function stableCredentialError(error: unknown): Error {
  if (!(error instanceof CredentialError)) return new Error("凭据操作失败；请检查凭据宿主配置后重试");
  const ref = error.refId;
  switch (error.code) {
    case "CREDENTIAL_MISSING":
      return new StableCredentialError(error.code, ref, `凭据 ${ref} 不存在；请运行 apicc credentials save <projectPath> ${ref} 从标准输入重新绑定`);
    case "CREDENTIAL_FORMAT_UNSUPPORTED":
      return new StableCredentialError(error.code, ref, `凭据 ${ref} 的存储格式无法识别；请重新绑定`);
    case "CREDENTIAL_POLICY_UNSUPPORTED":
      return new StableCredentialError(error.code, ref, `凭据 ${ref} 使用不支持的策略；当前仅支持 test-auto，请重新绑定`);
    case "CREDENTIAL_VERSION_CONFLICT":
      return new StableCredentialError(error.code, ref, `凭据 ${ref} 在运行准备期间发生变化；本次运行未使用新值，请重新绑定后重试`);
    case "CREDENTIAL_UNAVAILABLE":
      return new StableCredentialError(error.code, ref, `凭据 ${ref} 的系统存储当前不可用；请运行 apicc credentials status <projectPath> ${ref} 检查`);
    case "CREDENTIAL_READ_FAILED":
      return new StableCredentialError(error.code, ref, `读取凭据 ${ref} 失败；请检查凭据状态后重试`);
    case "CREDENTIAL_SAVE_FAILED":
      return new StableCredentialError(error.code, ref, `保存凭据 ${ref} 失败；请检查凭据状态后重试`);
    case "CREDENTIAL_REMOVE_FAILED":
      return new StableCredentialError(error.code, ref, `移除凭据 ${ref} 失败；请检查凭据状态后重试`);
  }
}

class StableCredentialError extends Error {
  constructor(readonly code: CredentialErrorCode, readonly refId: string, detail: string) {
    super(`[${code}] ${detail}`);
    this.name = "StableCredentialError";
  }
}

export function authRefsForAssets(project: Project, assets: readonly ApiAsset[]): SecretRef[] {
  return collectCredentialRefs(project, assets);
}

export function findProjectCredentialRef(project: Project, refId: string): SecretRef {
  const ref = collectDefinedProjectCredentialRefs(project).find((candidate) => candidate.id === refId);
  if (!ref) throw new Error(`项目未引用凭据 ${refId}`);
  return ref;
}

function findSourceApi(project: Project, sourceAsset: ApiAsset): { collectionId: string } {
  for (const collection of project.collections) {
    const visit = (folders: typeof collection.folders): boolean => {
      for (const folder of folders) {
        if (folder.apis.includes(sourceAsset)) return true;
        if (visit(folder.folders)) return true;
      }
      return false;
    };
    if (collection.apis.includes(sourceAsset) || visit(collection.folders)) return { collectionId: collection.id };
  }
  throw new TypeError("Credential selections must use API assets from the supplied project.");
}

function resolveCredentialSelections(
  snapshot: ProjectSnapshot,
  locators: readonly ExecutionCredentialSelection[],
): CredentialRequestSelection[] {
  return locators.map(({ collectionId, apiId, caseId, scope }) => {
    const collection = snapshot.project.collections.find((candidate) => candidate.id === collectionId);
    if (!collection) throw new TypeError(`Credential collection ${collectionId} is not in the supplied project snapshot.`);
    const api = findApiInCollection(collection, apiId);
    if (!api) throw new TypeError(`Credential API ${apiId} is not in the selected project snapshot collection.`);
    if (caseId === undefined) return { asset: api };
    const testCase = api.cases.find((candidate) => candidate.id === caseId && (scope === undefined || candidate.scope === scope));
    if (!testCase) throw new TypeError(`Credential case ${caseId} is not in the selected project snapshot API.`);
    return { asset: api, testCase };
  });
}

function findApiInCollection(
  collection: ProjectSnapshot["project"]["collections"][number],
  apiId: string,
): DeepReadonly<ApiAsset> | undefined {
  const matches: DeepReadonly<ApiAsset>[] = [];
  const visit = (folders: typeof collection.folders): void => {
    for (const folder of folders) {
      matches.push(...folder.apis.filter((api) => api.contract.id === apiId));
      visit(folder.folders);
    }
  };
  matches.push(...collection.apis.filter((api) => api.contract.id === apiId));
  visit(collection.folders);
  if (matches.length > 1) throw new TypeError(`Credential API ${apiId} is ambiguous in the selected project snapshot collection.`);
  return matches[0];
}

export function createCredentialHostStore(options: CredentialHostOptions = {}): SecretStore {
  return options.secretStore ?? createSystemSecretStore({
    privateRoot: options.credentialPrivateRoot ?? defaultCredentialPrivateRoot(),
  });
}

export function apiAssetsInCollection(collection: Workspace["groups"][number]["projects"][number]["collections"][number]): ApiAsset[] {
  const assets = [...collection.apis];
  const visit = (folders: typeof collection.folders): void => {
    for (const folder of folders) {
      assets.push(...folder.apis);
      visit(folder.folders);
    }
  };
  visit(collection.folders);
  return assets;
}

export function apiAssetsWithExecutableCases(
  project: Project,
  assets: readonly ApiAsset[],
  environment: Environment,
): ApiAsset[] {
  const applicableScopes = new Set(["base", ...envChain(environment, project)]);
  return assets.filter((asset) => asset.cases.some((testCase) => applicableScopes.has(testCase.scope)));
}

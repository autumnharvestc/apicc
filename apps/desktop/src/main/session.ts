import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  ApiAssetSchema,
  ApiTestCaseSchema,
  ComponentAssetSchema,
  ContractProjectSchema,
  ContractWorkspaceSchema,
  ContractCollectionSchema,
  EnvironmentSchema,
  ModelAssetSchema,
  OperationListSchema,
  ProjectGlobalsSchema,
  StressPolicySchema,
  WorkflowSchema,
  cloneProjectDefinition,
  createProjectSnapshot,
  createProjectAssetContext,
  envChain,
  fileStorage,
  getSourceApiRevision,
  listContractWorkspaceDefinitionFiles,
  mergedEnvVars,
  rotateProjectSecretRefs,
  sanitizeNodeName,
  transitionWorkflowStatus,
  validateEnablement,
  type ApiAsset,
  type ApiRequest,
  type ApiTestCase,
  type DebugFieldState,
  type CloneIdFactory,
  type ComponentAsset,
  type ContractCollection,
  type ContractFolder,
  type ContractGroup,
  type ContractProject,
  type ContractWorkspace,
  type Environment,
  type HttpMethod,
  type LoadProblem,
  type ModelAsset,
  type Operation,
  type ProjectGlobals,
  type StorageAdapter,
  type StressTargetPolicy,
  type Workflow,
  type WorkflowStatus,
} from "@apicc/core";
import { ApiRequestSchema } from "@apicc/core/schema";
import {
  ApiLocatorSchema,
  ApiParentLocatorSchema,
  CaseLocatorSchema,
  CollectionLocatorSchema,
  ComponentLocatorSchema,
  EnvironmentLocatorSchema,
  FolderLocatorSchema,
  GroupLocatorSchema,
  ModelLocatorSchema,
  NodeLocatorSchema,
  ProjectLocatorSchema,
  WorkflowLocatorSchema,
  WorkflowImpactLocatorSchema,
  WorkspaceLocatorSchema,
  type ApiLocator,
  type ApiParentLocator,
  type CaseLocator,
  type CollectionLocator,
  type ComponentLocator,
  type EnvironmentLocator,
  type FolderLocator,
  type GroupLocator,
  type ModelLocator,
  type NodeLocator,
  type ProjectLocator,
  type WorkflowLocator,
  type WorkflowImpactLocator,
  type WorkspaceLocator,
} from "../shared/locations.js";
import type { WorkflowImpactEntryDTO } from "../shared/types.js";

export type NodeKind = NodeLocator["kind"];

export interface ApiLocation {
  api: ApiAsset;
  collection: ContractCollection;
  project: ContractProject;
  group: ContractGroup;
  folder: ContractFolder | null;
  folderAncestors: ContractFolder[];
}

export interface ProjectLocation { project: ContractProject; group: ContractGroup }
export interface CollectionLocation { collection: ContractCollection; project: ContractProject; group: ContractGroup }
export interface WorkflowLocation { workflow: Workflow; project: ContractProject; group: ContractGroup }
export interface EnvironmentLocation { environment: Environment; project: ContractProject; group: ContractGroup }
export interface ModelLocation { model: ModelAsset; project: ContractProject; group: ContractGroup }
export interface ComponentLocation { component: ComponentAsset; project: ContractProject; group: ContractGroup }
export interface ProjectGlobalSettings extends ProjectGlobals { variables: Record<string, string> }

export interface SessionOptions {
  storage?: StorageAdapter;
  newId?: (kind: string, sourceId?: string, ownerId?: string) => string;
  platform?: NodeJS.Platform;
}

export interface CreateApiInput {
  name: string;
  protocol?: "http" | "websocket" | "soap";
  method?: HttpMethod;
  baseUrl?: string;
  path?: string;
}

export type CreateModelInput = Omit<ModelAsset, "formatVersion" | "id">;
export type CreateComponentInput = Omit<ComponentAsset, "formatVersion" | "id">;
export type CreateEnvironmentInput = Omit<Environment, "id" | "variables" | "baseUrls"> & Partial<Pick<Environment, "variables" | "baseUrls">>;
export interface ContainerOperations { preOperations: Operation[]; postOperations: Operation[] }
export interface CollectionContainerOperations extends ContainerOperations { variables: Record<string, string> }
export interface SessionView {
  workspace: ContractWorkspace;
  root: string;
  problems: LoadProblem[];
  readOnly: boolean;
  revision: string;
}

/** Main-process-only snapshot used to bind async draft credential checks to their queued write. */
export interface DraftWriteContext { readonly root: string; readonly revision: string; readonly generation: number }

interface ActiveSession extends SessionView {}
interface MutationResult<T> { value: T; deletions?: string[]; noCommit?: true }

const clone = <T>(value: T): T => structuredClone(value);

/** 名称比较延续平台路径语义，platform 参数只供测试注入。 */
export function sameName(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function parseLocator<T>(schema: { safeParse(value: unknown): { success: boolean; data?: T; error?: { message: string } } }, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new TypeError(`Invalid ${label} locator: ${parsed.error?.message ?? "shape mismatch"}`);
  return parsed.data as T;
}

function containsKnownCredentialLiteral(value: unknown, literals: readonly string[]): boolean {
  if (literals.length === 0) return false;
  if (typeof value === "string") return literals.some((literal) => literal.length > 0 && value.includes(literal));
  if (Array.isArray(value)) return value.some((item) => containsKnownCredentialLiteral(item, literals));
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([key, item]) => {
    if (key === "parameters" && typeof item === "object" && item !== null && !Array.isArray(item)
      && Object.keys(item).some((parameter) => literals.some((literal) => literal.length > 0 && parameter.includes(literal)))) return true;
    return containsKnownCredentialLiteral(item, literals);
  });
}

function recordOfStrings(value: unknown, label: string): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${label} must be a string map`);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") throw new TypeError(`${label}.${key} must be a string`);
    Object.defineProperty(result, key, { value: item, enumerable: true, configurable: true, writable: true });
  }
  return result;
}

function single<T>(items: T[], label: string): T | undefined {
  if (items.length > 1) throw new Error(`Ambiguous ${label}: ${items.length} matching definitions`);
  return items[0];
}

function findGroup(workspace: ContractWorkspace, groupId: string): ContractGroup | undefined {
  return single(workspace.groups.filter((group) => group.id === groupId), `group ${groupId}`);
}

function findProject(workspace: ContractWorkspace, locator: ProjectLocator): { group: ContractGroup; project: ContractProject } | undefined {
  if (workspace.id !== locator.workspaceId) throw new Error(`Workspace mismatch: expected ${workspace.id}, received ${locator.workspaceId}`);
  const group = findGroup(workspace, locator.groupId);
  if (!group) return undefined;
  const project = single(group.projects.filter((item) => item.id === locator.projectId), `project ${locator.projectId}`);
  return project ? { group, project } : undefined;
}

function findCollection(workspace: ContractWorkspace, locator: CollectionLocator): (CollectionLocation & { projectLocation: ProjectLocator }) | undefined {
  const found = findProject(workspace, locator);
  if (!found) return undefined;
  const collection = single(found.project.collections.filter((item) => item.id === locator.collectionId), `collection ${locator.collectionId}`);
  return collection ? { ...found, collection, projectLocation: { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId } } : undefined;
}

function findFolder(collection: ContractCollection, folderIds: readonly string[]): { folder: ContractFolder; ancestors: ContractFolder[] } | undefined {
  let folders = collection.folders;
  const ancestors: ContractFolder[] = [];
  for (const folderId of folderIds) {
    const folder = single(folders.filter((item) => item.id === folderId), `folder ${folderId}`);
    if (!folder) return undefined;
    ancestors.push(folder);
    folders = folder.folders;
  }
  const folder = ancestors.at(-1);
  return folder ? { folder, ancestors } : undefined;
}

function findApi(workspace: ContractWorkspace, locator: ApiLocator): ApiLocation | undefined {
  const collectionLocation = findCollection(workspace, locator);
  if (!collectionLocation) return undefined;
  const ancestors = locator.folderIds.length === 0
    ? []
    : findFolder(collectionLocation.collection, locator.folderIds)?.ancestors;
  if (!ancestors) return undefined;
  const container = ancestors.at(-1);
  const apis = container ? container.apis : collectionLocation.collection.apis;
  const api = single(apis.filter((item) => item.contract.id === locator.apiId), `API ${locator.apiId}`);
  if (!api) return undefined;
  return {
    api,
    collection: collectionLocation.collection,
    project: collectionLocation.project,
    group: collectionLocation.group,
    folder: container ?? null,
    folderAncestors: ancestors,
  };
}

function walkFolders(folders: ContractFolder[], visit: (folder: ContractFolder) => void): void {
  for (const folder of folders) {
    visit(folder);
    walkFolders(folder.folders, visit);
  }
}

function projectApis(project: ContractProject): ApiAsset[] {
  const result: ApiAsset[] = [];
  for (const collection of project.collections) {
    result.push(...collection.apis);
    walkFolders(collection.folders, (folder) => result.push(...folder.apis));
  }
  return result;
}

function projectAssetContext(project: ContractProject) {
  return createProjectAssetContext({
    projectId: project.id,
    assets: projectApis(project),
    models: project.models,
    components: project.components,
  });
}

function allProjectIds(project: ContractProject): Set<string> {
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return; }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    if (typeof record.id === "string") ids.add(record.id);
    for (const item of Object.values(record)) visit(item);
  };
  visit(project);
  return ids;
}

function secretRefsInProject(project: ContractProject): Set<string> {
  const refs = new Set<string>();
  const add = (auth: ApiAsset["contract"]["request"]["auth"]): void => {
    if (auth.kind === "bearer") refs.add(auth.token.id);
    else if (auth.kind === "basic") refs.add(auth.password.id);
    else if (auth.kind === "apikey") refs.add(auth.value.id);
  };
  for (const api of projectApis(project)) add(api.contract.request.auth);
  for (const component of project.components) if (component.kind === "auth") add(component.definition);
  return refs;
}

function allSecretRefs(workspace: ContractWorkspace, exceptProject?: ContractProject): Set<string> {
  const refs = new Set<string>();
  for (const group of workspace.groups) for (const project of group.projects) {
    if (project === exceptProject) continue;
    for (const id of secretRefsInProject(project)) refs.add(id);
  }
  return refs;
}

function allApiLocators(project: ContractProject, workspaceId: string, groupId: string): Array<{ locator: ApiLocator; api: ApiAsset }> {
  const items: Array<{ locator: ApiLocator; api: ApiAsset }> = [];
  const visitFolders = (collection: ContractCollection, folders: ContractFolder[], ancestors: string[]) => {
    for (const folder of folders) {
      const current = [...ancestors, folder.id];
      for (const api of folder.apis) items.push({ locator: { workspaceId, groupId, projectId: project.id, collectionId: collection.id, folderIds: current, apiId: api.contract.id }, api });
      visitFolders(collection, folder.folders, current);
    }
  };
  for (const collection of project.collections) {
    for (const api of collection.apis) items.push({ locator: { workspaceId, groupId, projectId: project.id, collectionId: collection.id, folderIds: [], apiId: api.contract.id }, api });
    visitFolders(collection, collection.folders, []);
  }
  return items;
}

function exactApiAt(project: ContractProject, locator: ApiLocator): ApiAsset | undefined {
  const collection = single(project.collections.filter((item) => item.id === locator.collectionId), `collection ${locator.collectionId}`);
  if (!collection) return undefined;
  const ancestors = locator.folderIds.length ? findFolder(collection, locator.folderIds)?.ancestors : [];
  if (!ancestors) return undefined;
  const folder = ancestors.at(-1);
  return single((folder ? folder.apis : collection.apis).filter((item) => item.contract.id === locator.apiId), `API ${locator.apiId}`);
}

function casePath(locator: ApiLocator, testCase: ApiTestCase): string {
  const casePart = Buffer.from(testCase.id, "utf8").toString("hex");
  const scopePart = Buffer.from(testCase.scope, "utf8").toString("hex");
  return `${apiPrefix(locator)}cases/${casePart}.${scopePart}.yaml`;
}

function apiPrefix(locator: ApiLocator): string {
  return `groups/${locator.groupId}/projects/${locator.projectId}/collections/${locator.collectionId}/${locator.folderIds.map((id) => `folders/${id}/`).join("")}apis/${locator.apiId}/`;
}

function projectPrefix(groupId: string, projectId: string): string {
  return `groups/${groupId}/projects/${projectId}/`;
}

function groupPrefix(groupId: string): string { return `groups/${groupId}/`; }

function knownFilesWithPrefix(workspace: ContractWorkspace, prefix: string): string[] {
  return listContractWorkspaceDefinitionFiles(workspace).filter((file) => file.startsWith(prefix));
}

function knownExactFile(workspace: ContractWorkspace, file: string): string[] {
  return listContractWorkspaceDefinitionFiles(workspace).includes(file) ? [file] : [];
}

function workflowCallers(project: ContractProject, apiIds: ReadonlySet<string>, caseId?: string): Array<{ workflow: Workflow; nodeId: string; label?: string }> {
  const hits: Array<{ workflow: Workflow; nodeId: string; label?: string }> = [];
  for (const workflow of project.workflows) for (const node of workflow.nodes) {
    if (node.kind !== "request" || !node.apiId || !apiIds.has(node.apiId)) continue;
    if (caseId !== undefined && node.caseId !== caseId) continue;
    hits.push({ workflow, nodeId: node.id, label: node.label });
  }
  return hits;
}

function guardWorkflowReferences(project: ContractProject, apiIds: ReadonlySet<string>, caseId?: string): void {
  const hits = workflowCallers(project, apiIds, caseId);
  if (hits.length) {
    const callers = hits.map(({ workflow, nodeId, label }) => `${workflow.name} (${nodeId}${label ? `: ${label}` : ""})`).join(", ");
    throw new Error(`Cannot delete referenced API/case; workflow callers remain: ${callers}`);
  }
}

function sourceAssetNames(project: ContractProject): ContractProject {
  const result = clone(project);
  result.name = sanitizeNodeName(result.name);
  const environmentNames = new Map<string, string>();
  const normalizedEnvironmentNames = new Set<string>();
  for (const environment of result.environments) {
    const sourceName = environment.name;
    const normalizedName = sanitizeNodeName(sourceName);
    if (environmentNames.has(sourceName)) throw new Error(`Ambiguous source environment name: ${sourceName}`);
    if (normalizedEnvironmentNames.has(normalizedName)) throw new Error(`Source environment names collide after sanitization: ${normalizedName}`);
    environmentNames.set(sourceName, normalizedName);
    normalizedEnvironmentNames.add(normalizedName);
    environment.name = normalizedName;
  }
  for (const environment of result.environments) {
    if (environment.extends !== undefined) {
      const normalizedParent = environmentNames.get(environment.extends);
      if (normalizedParent === undefined) throw new Error(`Unresolvable source environment parent: ${environment.extends}`);
      environment.extends = normalizedParent;
    }
  }
  result.workflows.forEach((workflow) => { workflow.name = sanitizeNodeName(workflow.name); });
  result.models.forEach((model) => { model.name = sanitizeNodeName(model.name); });
  result.components.forEach((component) => { component.name = sanitizeNodeName(component.name); });
  for (const collection of result.collections) {
    collection.name = sanitizeNodeName(collection.name);
    const visit = (folder: ContractFolder) => {
      folder.name = sanitizeNodeName(folder.name);
      for (const api of folder.apis) sanitizeApiName(api, environmentNames);
      folder.folders.forEach(visit);
    };
    collection.folders.forEach(visit);
    collection.apis.forEach((api) => sanitizeApiName(api, environmentNames));
  }
  return result;
}

function sanitizeModuleCaseScopes(project: ContractProject): void {
  const sanitizeApiScopes = (api: ApiAsset): void => {
    const originalScopesByCase = new Map<string, Map<string, string>>();
    for (const testCase of api.cases) {
      const originalScope = testCase.scope;
      let normalizedScope = originalScope;
      if (originalScope === "." || originalScope === ".."
        || originalScope.includes("/") || originalScope.includes("\\") || originalScope.includes("\0")) {
        normalizedScope = sanitizeNodeName(originalScope);
        if (normalizedScope === "." || normalizedScope === "..") normalizedScope = sanitizeNodeName(normalizedScope);
      }
      let originalScopes = originalScopesByCase.get(testCase.id);
      if (!originalScopes) {
        originalScopes = new Map();
        originalScopesByCase.set(testCase.id, originalScopes);
      }
      const previousScope = originalScopes.get(normalizedScope);
      if (previousScope !== undefined && previousScope !== originalScope) {
        throw new Error(`Source API case scopes collide after sanitization: ${testCase.id} / ${normalizedScope}`);
      }
      originalScopes.set(normalizedScope, originalScope);
      testCase.scope = normalizedScope;
    }
  };
  const visitFolder = (folder: ContractFolder): void => {
    folder.apis.forEach(sanitizeApiScopes);
    folder.folders.forEach(visitFolder);
  };
  for (const collection of project.collections) {
    collection.apis.forEach(sanitizeApiScopes);
    collection.folders.forEach(visitFolder);
  }
}

function sanitizeApiName(api: ApiAsset, environmentNames: ReadonlyMap<string, string> = new Map()): void {
  api.contract.metadata.name = sanitizeNodeName(api.contract.metadata.name);
  api.cases.forEach((item) => {
    item.name = sanitizeNodeName(item.name);
    if (item.scope !== "base") item.scope = environmentNames.get(item.scope) ?? item.scope;
  });
}

function uniqueEnvironmentNames(project: ContractProject): Map<string, Environment> {
  const byName = new Map<string, Environment>();
  for (const environment of project.environments) {
    if (byName.has(environment.name)) throw new Error(`Ambiguous source environment name: ${environment.name}`);
    byName.set(environment.name, environment);
  }
  for (const environment of project.environments) {
    const seen = new Set<string>();
    let current: Environment | undefined = environment;
    while (current) {
      if (seen.has(current.name)) throw new Error(`Cyclic source environment inheritance at ${current.name}`);
      seen.add(current.name);
      // Core's public chain helper is tolerant of missing/cyclic links; the explicit
      // walk here makes those cases an import error instead of a partial resolution.
      if (current.extends === undefined) break;
      const parent = byName.get(current.extends);
      if (!parent) throw new Error(`Unresolvable source environment parent: ${current.extends}`);
      current = parent;
    }
  }
  return byName;
}

function nonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function resolveImportedCollectionBaseUrl(
  project: ContractProject,
  collection: ContractCollection,
  environmentsByName: ReadonlyMap<string, Environment>,
  sourceEnvironmentName?: string,
): string | undefined {
  const selectedEnvironments = sourceEnvironmentName === undefined
    ? project.environments
    : (() => {
      const selected = environmentsByName.get(sourceEnvironmentName);
      if (!selected) throw new Error(`Unknown source environment name: ${sourceEnvironmentName}`);
      return [selected];
    })();
  const resolvedByEnvironment = selectedEnvironments.map((environment) => {
    let mappedValue: string | undefined;
    for (const name of [...envChain(environment, project)].reverse()) {
      const value = environmentsByName.get(name)?.baseUrls[collection.id];
      if (value !== undefined) mappedValue = value;
    }
    const environmentVariables = mergedEnvVars(environment, project);
    if (nonEmptyString(mappedValue)) return mappedValue;
    if (nonEmptyString(environmentVariables.baseUrl)) return environmentVariables.baseUrl;
    if (nonEmptyString(collection.variables.baseUrl)) return collection.variables.baseUrl;
    return undefined;
  });
  const selected = resolvedByEnvironment[0];
  if (resolvedByEnvironment.some((value) => value !== selected)) {
    throw new Error(`Ambiguous source environment baseUrl for collection ${collection.id}; choose a source environment`);
  }
  return selected;
}

function checkedCloneFactory(
  factory: SessionOptions["newId"],
  existingIds: ReadonlySet<string>,
  existingSecretRefs: ReadonlySet<string>,
  allowedProjectId?: string,
): CloneIdFactory {
  const generated = new Set<string>();
  return (kind, sourceId, ownerId) => {
    const targetId = kind === "project" && allowedProjectId
      ? allowedProjectId
      : (factory ?? (() => randomUUID()))(kind, sourceId, ownerId);
    if (typeof targetId !== "string" || targetId.length === 0) throw new TypeError(`ID factory returned invalid ${kind} identity`);
    if (kind !== "project" && (existingIds.has(targetId) || targetId === allowedProjectId)) {
      throw new Error(`Target identity collision for ${kind}:${targetId}`);
    }
    if (kind === "project" && allowedProjectId === undefined && existingIds.has(targetId)) {
      throw new Error(`Target identity collision for project:${targetId}`);
    }
    if (kind === "secretRef" && existingSecretRefs.has(targetId)) throw new Error(`Target secret reference collision: ${targetId}`);
    if (generated.has(targetId)) throw new Error(`ID factory returned duplicate target identity: ${targetId}`);
    generated.add(targetId);
    return targetId;
  };
}

function makeDefaultApi(input: CreateApiInput, newId: SessionOptions["newId"], projectId: string): ApiAsset {
  const id = (kind: string, ownerId?: string) => (newId ?? (() => randomUUID()))(kind, undefined, ownerId);
  const protocol = input.protocol ?? "http";
  const common = {
    protocol,
    baseUrl: input.baseUrl ?? "",
    path: input.path ?? "/",
    pathParams: [],
    query: [],
    headers: [],
    cookies: [],
    auth: { kind: "none" },
  };
  const request = protocol === "http"
    ? { ...common, protocol, method: input.method ?? "GET", body: { kind: "none" } }
    : protocol === "websocket"
      ? { ...common, protocol }
      : { ...common, protocol, method: "POST", envelope: "" };
  const contractId = id("contract", projectId);
  return ApiAssetSchema.parse({
    contract: {
      formatVersion: 1,
      id: contractId,
      metadata: { name: sanitizeNodeName(input.name), description: "", tags: [], version: "1.0.0", status: "draft" },
      request,
      responses: [],
    },
    cases: [{ id: id("case", contractId), name: "base", scope: "base", parameters: {}, preOperations: [], postOperations: [], assertions: [] }],
    documentation: "",
  });
}

/**
 * Desktop's formal contract session. Every write operates on a private candidate and
 * only publishes it after StorageAdapter accepts the expected revision.
 */
export function createSession(options: SessionOptions = {}) {
  const storage = options.storage ?? fileStorage;
  const newId = options.newId ?? (() => randomUUID());
  let active: ActiveSession | null = null;
  let activeContextGeneration = 0;
  let queue: Promise<unknown> = Promise.resolve();

  function enqueue<T>(action: () => Promise<T> | T): Promise<T> {
    const result = queue.then(action, action);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  function requireActive(): ActiveSession {
    if (!active) throw new Error("尚未打开工作区");
    return active;
  }

  function captureDraftWriteContext(): DraftWriteContext {
    const current = requireActive();
    return Object.freeze({ root: current.root, revision: current.revision, generation: activeContextGeneration });
  }

  function assertDraftWriteContext(context: DraftWriteContext, current = active): void {
    if (!current || current.root !== context.root || current.revision !== context.revision
      || activeContextGeneration !== context.generation) {
      throw new Error("工作区上下文已更改，拒绝保存调试草稿。");
    }
  }

  function checkedWorkspace(workspace: ContractWorkspace, workspaceId: string): void {
    if (workspace.id !== workspaceId) throw new Error(`Workspace mismatch: expected ${workspace.id}, received ${workspaceId}`);
  }

  function mutate<T>(operation: (candidate: ContractWorkspace, current: ActiveSession) => MutationResult<T>): Promise<T> {
    return enqueue(async () => {
      const current = requireActive();
      if (current.readOnly) throw new Error("工作区处于只读模式，不能写入");
      const candidate = clone(current.workspace);
      const result = operation(candidate, current);
      if (result.noCommit) return clone(result.value);
      const parsed = ContractWorkspaceSchema.parse(candidate);
      const saved = await storage.save(current.root, parsed, {
        expectedRevision: current.revision,
        deletions: result.deletions ?? [],
      });
      active = { ...current, workspace: parsed, revision: saved.revision };
      return clone(result.value);
    });
  }

  function readWorkspace<T>(reader: (workspace: ContractWorkspace) => T): T {
    return reader(clone(requireActive().workspace));
  }

  function publicView(current: ActiveSession): SessionView {
    return { ...current, workspace: clone(current.workspace), problems: clone(current.problems) };
  }

  function locateProjectInCandidate(workspace: ContractWorkspace, locatorValue: ProjectLocator): { group: ContractGroup; project: ContractProject } {
    const locator = parseLocator(ProjectLocatorSchema, {
      workspaceId: locatorValue.workspaceId,
      groupId: locatorValue.groupId,
      projectId: locatorValue.projectId,
    }, "project");
    const found = findProject(workspace, locator);
    if (!found) throw new Error(`Project not found at complete locator: ${JSON.stringify(locator)}`);
    return found;
  }

  function locateCollectionInCandidate(workspace: ContractWorkspace, locatorValue: CollectionLocator): CollectionLocation {
    const locator = parseLocator(CollectionLocatorSchema, {
      workspaceId: locatorValue.workspaceId,
      groupId: locatorValue.groupId,
      projectId: locatorValue.projectId,
      collectionId: locatorValue.collectionId,
    }, "collection");
    const found = findCollection(workspace, locator);
    if (!found) throw new Error(`Collection not found at complete locator: ${JSON.stringify(locator)}`);
    return found;
  }

  function locateApiInCandidate(workspace: ContractWorkspace, locatorValue: ApiLocator): ApiLocation {
    const locator = parseLocator(ApiLocatorSchema, {
      workspaceId: locatorValue.workspaceId,
      groupId: locatorValue.groupId,
      projectId: locatorValue.projectId,
      collectionId: locatorValue.collectionId,
      folderIds: locatorValue.folderIds,
      apiId: locatorValue.apiId,
    }, "API");
    const found = findApi(workspace, locator);
    if (!found) throw new Error(`API not found at complete locator: ${JSON.stringify(locator)}`);
    return found;
  }

function setContainerOperations(
  candidate: ContractWorkspace,
  locator: CollectionLocator | FolderLocator,
  operations: ContainerOperations | CollectionContainerOperations,
): ContainerOperations | CollectionContainerOperations {
    const preOperations = OperationListSchema.parse(operations.preOperations);
    const postOperations = OperationListSchema.parse(operations.postOperations);
    if ("folderIds" in locator) {
      const collectionLocation = locateCollectionInCandidate(candidate, locator);
      const found = findFolder(collectionLocation.collection, locator.folderIds);
      if (!found) throw new Error(`Folder not found at complete locator: ${JSON.stringify(locator)}`);
      found.folder.preOperations = preOperations;
      found.folder.postOperations = postOperations;
    } else {
      const collectionLocation = locateCollectionInCandidate(candidate, locator);
      collectionLocation.collection.preOperations = preOperations;
      collectionLocation.collection.postOperations = postOperations;
      if (!("variables" in operations)) throw new TypeError("Collection container variables are required");
      collectionLocation.collection.variables = recordOfStrings(operations.variables, "container.variables");
      return { preOperations, postOperations, variables: collectionLocation.collection.variables };
    }
    return { preOperations, postOperations };
  }

  async function open(dir: string): Promise<SessionView> {
    return enqueue(async () => {
      const root = resolve(dir);
      const loaded = await storage.load(root);
      const workspace = ContractWorkspaceSchema.parse(loaded.workspace);
      const next: ActiveSession = {
        root,
        workspace,
        problems: clone(loaded.problems),
        readOnly: loaded.readOnly,
        revision: loaded.revision,
      };
      active = next;
      activeContextGeneration += 1;
      return publicView(next);
    });
  }

  async function create(dir: string, name: string): Promise<SessionView> {
    return enqueue(async () => {
      const root = resolve(dir);
      if (existsSync(resolve(root, "apicc.workspace.yaml"))) throw new Error("目录已是工作区");
      const workspace = ContractWorkspaceSchema.parse({
        formatVersion: 1,
        id: newId("workspace"),
        name: sanitizeNodeName(name),
        variables: {},
        groups: [{ id: newId("group"), name: "默认分组", default: true, projects: [] }],
      });
      const saved = await storage.save(root, workspace, { expectedRevision: "empty", deletions: [] });
      const next: ActiveSession = { root, workspace, problems: [], readOnly: false, revision: saved.revision };
      active = next;
      activeContextGeneration += 1;
      return publicView(next);
    });
  }

  async function ensureDefaultGroup(): Promise<ContractGroup> {
    return enqueue(async () => {
      const current = requireActive();
      const existing = current.workspace.groups.find((group) => group.default === true);
      if (existing) return clone(existing);
      if (current.readOnly) throw new Error("工作区处于只读模式，不能写入");
      const candidate = clone(current.workspace);
      const group: ContractGroup = { id: newId("group"), name: "默认分组", default: true, projects: [] };
      if (candidate.groups.some((item) => item.id === group.id)) throw new Error(`Target identity collision for group:${group.id}`);
      candidate.groups.unshift(group);
      const parsed = ContractWorkspaceSchema.parse(candidate);
      const saved = await storage.save(current.root, parsed, { expectedRevision: current.revision, deletions: [] });
      active = { ...current, workspace: parsed, revision: saved.revision };
      return clone(group);
    });
  }

  async function validate(): Promise<LoadProblem[]> {
    return enqueue(async () => {
      const current = requireActive();
      return clone((await storage.load(current.root)).problems);
    });
  }

  function locateProject(locatorValue: ProjectLocator): ProjectLocation | undefined {
    const locator = parseLocator(ProjectLocatorSchema, locatorValue, "project");
    return readWorkspace((workspace) => {
      checkedWorkspace(workspace, locator.workspaceId);
      const found = findProject(workspace, locator);
      return found ? { project: found.project, group: found.group } : undefined;
    });
  }

  function locateApi(locatorValue: ApiLocator): ApiLocation | undefined {
    const locator = parseLocator(ApiLocatorSchema, locatorValue, "API");
    return readWorkspace((workspace) => {
      checkedWorkspace(workspace, locator.workspaceId);
      return findApi(workspace, locator);
    });
  }

  function locateCollection(locatorValue: CollectionLocator): CollectionLocation | undefined {
    const locator = parseLocator(CollectionLocatorSchema, locatorValue, "collection");
    return readWorkspace((workspace) => {
      checkedWorkspace(workspace, locator.workspaceId);
      const found = findCollection(workspace, locator);
      if (!found) return undefined;
      return { collection: found.collection, project: found.project, group: found.group };
    });
  }

  function locateFolder(locatorValue: FolderLocator): { folder: ContractFolder; collection: ContractCollection; project: ContractProject; group: ContractGroup; folderAncestors: ContractFolder[] } | undefined {
    const locator = parseLocator(FolderLocatorSchema, locatorValue, "folder");
    return readWorkspace((workspace) => {
      checkedWorkspace(workspace, locator.workspaceId);
      const found = findCollection(workspace, locator);
      if (!found) return undefined;
      const folder = findFolder(found.collection, locator.folderIds);
      return folder ? { folder: folder.folder, collection: found.collection, project: found.project, group: found.group, folderAncestors: folder.ancestors } : undefined;
    });
  }

  function locateWorkflow(locatorValue: WorkflowLocator): WorkflowLocation | undefined {
    const locator = parseLocator(WorkflowLocatorSchema, locatorValue, "workflow");
    return readWorkspace((workspace) => {
      checkedWorkspace(workspace, locator.workspaceId);
      const found = findProject(workspace, locator);
      if (!found) return undefined;
      const workflow = single(found.project.workflows.filter((item) => item.id === locator.workflowId), `workflow ${locator.workflowId}`);
      return workflow ? { workflow, project: found.project, group: found.group } : undefined;
    });
  }

  function locateEnvironment(locatorValue: EnvironmentLocator): EnvironmentLocation | undefined {
    const locator = parseLocator(EnvironmentLocatorSchema, locatorValue, "environment");
    return readWorkspace((workspace) => {
      checkedWorkspace(workspace, locator.workspaceId);
      const found = findProject(workspace, locator);
      if (!found) return undefined;
      const environment = single(found.project.environments.filter((item) => item.id === locator.environmentId), `environment ${locator.environmentId}`);
      return environment ? { environment, project: found.project, group: found.group } : undefined;
    });
  }

  function locateModel(locatorValue: ModelLocator): ModelLocation | undefined {
    const locator = parseLocator(ModelLocatorSchema, locatorValue, "model");
    return readWorkspace((workspace) => {
      checkedWorkspace(workspace, locator.workspaceId);
      const found = findProject(workspace, locator);
      if (!found) return undefined;
      const model = single(found.project.models.filter((item) => item.id === locator.modelId), `model ${locator.modelId}`);
      return model ? { model, project: found.project, group: found.group } : undefined;
    });
  }

  function locateComponent(locatorValue: ComponentLocator): ComponentLocation | undefined {
    const locator = parseLocator(ComponentLocatorSchema, locatorValue, "component");
    return readWorkspace((workspace) => {
      checkedWorkspace(workspace, locator.workspaceId);
      const found = findProject(workspace, locator);
      if (!found) return undefined;
      const component = single(found.project.components.filter((item) => item.kind === locator.componentKind && item.id === locator.componentId), `component ${locator.componentId}`);
      return component ? { component, project: found.project, group: found.group } : undefined;
    });
  }

  function listModels(locatorValue: ProjectLocator): ModelAsset[] {
    const locator = parseLocator(ProjectLocatorSchema, locatorValue, "project");
    return readWorkspace((workspace) => {
      const found = findProject(workspace, locator);
      if (!found) throw new Error(`Project not found at complete locator: ${JSON.stringify(locator)}`);
      return found.project.models;
    });
  }

  function listComponents(locatorValue: ProjectLocator): ComponentAsset[] {
    const locator = parseLocator(ProjectLocatorSchema, locatorValue, "project");
    return readWorkspace((workspace) => {
      const found = findProject(workspace, locator);
      if (!found) throw new Error(`Project not found at complete locator: ${JSON.stringify(locator)}`);
      return found.project.components;
    });
  }

  function referencesTo(locatorValue: ProjectLocator, assetId: string) {
    const locator = parseLocator(ProjectLocatorSchema, locatorValue, "project");
    return readWorkspace((workspace) => {
      const found = findProject(workspace, locator);
      if (!found) throw new Error(`Project not found at complete locator: ${JSON.stringify(locator)}`);
      return projectAssetContext(found.project).referencesTo(assetId);
    });
  }

  function workflowImpact(locatorValue: WorkflowImpactLocator): WorkflowImpactEntryDTO[] {
    const locator = parseLocator(WorkflowImpactLocatorSchema, locatorValue, "workflow impact");
    return readWorkspace((workspace) => {
      checkedWorkspace(workspace, locator.workspaceId);
      const found = findApi(workspace, locator);
      if (!found) return [];
      return found.project.workflows.flatMap((workflow) => workflow.nodes
        .filter((node) => node.kind === "request"
          && node.apiId === locator.apiId
          && (locator.caseId === undefined || node.caseId === locator.caseId))
        .map((node) => ({ workflowId: workflow.id, workflowName: workflow.name, status: workflow.status, nodeId: node.id, ...(node.label === undefined ? {} : { nodeLabel: node.label }) })));
    });
  }

  async function createGroup(locatorValue: WorkspaceLocator, rawName: string): Promise<ContractGroup> {
    const locator = parseLocator(WorkspaceLocatorSchema, locatorValue, "workspace");
    return mutate((candidate) => {
      checkedWorkspace(candidate, locator.workspaceId);
      const id = newId("group");
      if (candidate.groups.some((group) => group.id === id)) throw new Error(`Target identity collision for group:${id}`);
      const group: ContractGroup = { id, name: sanitizeNodeName(rawName), projects: [] };
      candidate.groups.push(group);
      return { value: group };
    });
  }

  async function createProject(locatorValue: GroupLocator, rawName: string): Promise<ContractProject> {
    const locator = parseLocator(GroupLocatorSchema, locatorValue, "group");
    return mutate((candidate) => {
      checkedWorkspace(candidate, locator.workspaceId);
      const group = findGroup(candidate, locator.groupId);
      if (!group) throw new Error(`Group not found at complete locator: ${JSON.stringify(locator)}`);
      const id = newId("project");
      if (group.projects.some((project) => project.id === id)) throw new Error(`Target identity collision for project:${id}`);
      const project = ContractProjectSchema.parse({ id, name: sanitizeNodeName(rawName), globals: {} });
      group.projects.push(project);
      return { value: project };
    });
  }

  async function createCollection(locatorValue: ProjectLocator, rawName: string): Promise<ContractCollection> {
    const locator = parseLocator(ProjectLocatorSchema, locatorValue, "project");
    return mutate((candidate) => {
      const { project } = locateProjectInCandidate(candidate, locator);
      const id = newId("collection", project.id);
      if (allProjectIds(project).has(id)) throw new Error(`Target identity collision for collection:${id}`);
      const collection = ContractCollectionSchema.parse({ id, name: sanitizeNodeName(rawName) });
      project.collections.push(collection);
      return { value: collection };
    });
  }

  async function createFolder(parentValue: ApiParentLocator, rawName: string): Promise<ContractFolder> {
    const parent = parseLocator(ApiParentLocatorSchema, parentValue, "API parent");
    return mutate((candidate) => {
      const collectionLocation = locateCollectionInCandidate(candidate, parent);
      const id = newId("folder", collectionLocation.project.id);
      if (allProjectIds(collectionLocation.project).has(id)) throw new Error(`Target identity collision for folder:${id}`);
      const folder: ContractFolder = { id, name: sanitizeNodeName(rawName), preOperations: [], postOperations: [], folders: [], apis: [] };
      if ("folderIds" in parent) {
        const target = findFolder(collectionLocation.collection, parent.folderIds);
        if (!target) throw new Error(`Parent folder not found: ${JSON.stringify(parent)}`);
        target.folder.folders.push(folder);
      } else collectionLocation.collection.folders.push(folder);
      return { value: folder };
    });
  }

  async function createApi(parentValue: ApiParentLocator, inputValue: CreateApiInput): Promise<ApiAsset> {
    const parent = parseLocator(ApiParentLocatorSchema, parentValue, "API parent");
    const input = clone(inputValue);
    return mutate((candidate) => {
      const collectionLocation = locateCollectionInCandidate(candidate, parent);
      const api = makeDefaultApi(input, newId, collectionLocation.project.id);
      if (allProjectIds(collectionLocation.project).has(api.contract.id)) throw new Error(`Target identity collision for contract:${api.contract.id}`);
      if ("folderIds" in parent) {
        const target = findFolder(collectionLocation.collection, parent.folderIds);
        if (!target) throw new Error(`Parent folder not found: ${JSON.stringify(parent)}`);
        target.folder.apis.push(api);
      } else collectionLocation.collection.apis.push(api);
      return { value: api };
    });
  }

  async function saveApi(
    locatorValue: ApiLocator,
    inputValue: ApiAsset,
    knownCredentialLiterals: readonly string[] = [],
    draftWriteContext?: DraftWriteContext,
    expectedSourceApiRevision?: string,
  ): Promise<{ api: ApiAsset; sourceApiRevision: string; sourceProjectRevision: string }> {
    const locator = parseLocator(ApiLocatorSchema, locatorValue, "API");
    const input = ApiAssetSchema.parse(clone(inputValue));
    return mutate((candidate, current) => {
      if (draftWriteContext) assertDraftWriteContext(draftWriteContext, current);
      if (containsKnownCredentialLiteral(input, knownCredentialLiterals)) {
        throw new Error("拒绝保存包含已知凭据字面值的接口资源。");
      }
      const located = locateApiInCandidate(candidate, {
        workspaceId: locator.workspaceId,
        groupId: locator.groupId,
        projectId: locator.projectId,
        collectionId: locator.collectionId,
        folderIds: locator.folderIds,
        apiId: locator.apiId,
      });
      if (expectedSourceApiRevision) {
        const actualRevision = getSourceApiRevision(located.api);
        if (actualRevision !== expectedSourceApiRevision) {
          throw new Error(`API source revision conflict at ${JSON.stringify(locator)}: expected ${expectedSourceApiRevision}, received ${actualRevision}`);
        }
      }
      if (input.contract.id !== locator.apiId) throw new Error("API contract.id must match its locator");
      const removed = located.api.cases.filter((before) => !input.cases.some((after) => after.id === before.id && after.scope === before.scope));
      const removedLogicalCases = new Set(removed.map((testCase) => testCase.id).filter((caseId) => !input.cases.some((item) => item.id === caseId)));
      for (const caseId of removedLogicalCases) guardWorkflowReferences(located.project, new Set([locator.apiId]), caseId);
      const container = locator.folderIds.length
        ? findFolder(located.collection, locator.folderIds)?.folder
        : located.collection;
      if (!container) throw new Error(`API parent not found: ${JSON.stringify(locator)}`);
      const list = container.apis;
      const index = list.findIndex((item) => item.contract.id === locator.apiId);
      if (index < 0) throw new Error(`API not found at complete locator: ${JSON.stringify(locator)}`);
      list[index] = input;
      if (input.contract.metadata.status === "published") {
        const gate = projectAssetContext(located.project).checkGate("publish", input.contract.id);
        if (!gate.ok) {
          const details = gate.diagnostics.map((diagnostic) =>
            `${diagnostic.code} [${diagnostic.ownerId} ${diagnostic.path}${diagnostic.targetId ? ` -> ${diagnostic.targetId}` : ""}]`,
          ).join("; ");
          throw new Error(`API_PUBLISH_GATE_FAILED: ${details}`);
        }
      }
      const beforeFiles = listContractWorkspaceDefinitionFiles(current.workspace);
      const afterFiles = listContractWorkspaceDefinitionFiles(candidate);
      const removedCaseFiles = removed.map((testCase) => casePath(locator, testCase)).filter((file) => beforeFiles.includes(file) && !afterFiles.includes(file));
      return {
        value: {
          api: input,
          sourceApiRevision: getSourceApiRevision(input),
          sourceProjectRevision: createProjectSnapshot(located.project).definitionRevision,
        },
        deletions: removedCaseFiles,
      };
    });
  }

  async function saveCase(
    locatorValue: CaseLocator,
    inputValue: ApiTestCase,
    expectedSourceApiRevision: string,
    knownCredentialLiterals: readonly string[] = [],
    draftWriteContext?: DraftWriteContext,
    fields: readonly DebugFieldState[] = [],
  ): Promise<{ testCase: ApiTestCase; sourceApiRevision: string }> {
    const locator = parseLocator(CaseLocatorSchema, locatorValue, "case");
    const input = ApiTestCaseSchema.parse(clone(inputValue));
    if (!expectedSourceApiRevision) throw new Error("API source revision is required to save a case");
    return mutate((candidate, current) => {
      if (draftWriteContext) assertDraftWriteContext(draftWriteContext, current);
      if (input.id !== locator.caseId || input.scope !== locator.scope) throw new Error("Case id and scope must match its locator");
      if (fields.some((field) => field.needsInput)) throw new Error("请先补齐调试恢复字段，再保存用例。");
      if (containsKnownCredentialLiteral(input, knownCredentialLiterals)) {
        throw new Error("拒绝保存包含已知凭据字面值的用例。");
      }
      const located = locateApiInCandidate(candidate, {
        workspaceId: locator.workspaceId,
        groupId: locator.groupId,
        projectId: locator.projectId,
        collectionId: locator.collectionId,
        folderIds: locator.folderIds,
        apiId: locator.apiId,
      });
      const actualRevision = getSourceApiRevision(located.api);
      if (actualRevision !== expectedSourceApiRevision) {
        throw new Error(`API source revision conflict at ${JSON.stringify(locator)}: expected ${expectedSourceApiRevision}, received ${actualRevision}`);
      }
      const index = located.api.cases.findIndex((testCase) => testCase.id === locator.caseId && testCase.scope === locator.scope);
      if (index < 0) located.api.cases.push(input);
      else located.api.cases[index] = input;
      return { value: { testCase: input, sourceApiRevision: getSourceApiRevision(located.api) } };
    });
  }

  async function saveRequestDraft(
    locatorValue: ApiLocator,
    requestValue: ApiRequest,
    expectedSourceApiRevision: string,
    fields: readonly DebugFieldState[] = [],
    knownCredentialLiterals: readonly string[] = [],
    draftWriteContext?: DraftWriteContext,
  ): Promise<{ request: ApiRequest; sourceApiRevision: string }> {
    const locator = parseLocator(ApiLocatorSchema, locatorValue, "API");
    const request = ApiRequestSchema.parse(clone(requestValue));
    if (!expectedSourceApiRevision) throw new Error("API source revision is required to save a request draft");
    return mutate((candidate, current) => {
      if (draftWriteContext) assertDraftWriteContext(draftWriteContext, current);
      const located = locateApiInCandidate(candidate, locator);
      const actualRevision = getSourceApiRevision(located.api);
      if (actualRevision !== expectedSourceApiRevision) {
        throw new Error(`API source revision conflict at ${JSON.stringify(locator)}: expected ${expectedSourceApiRevision}, received ${actualRevision}`);
      }
      if (fields.some((field) => field.needsInput)) throw new Error("请先补齐调试恢复字段，再保存请求草稿。");
      if (containsKnownCredentialLiteral(request, knownCredentialLiterals)) {
        throw new Error("拒绝保存包含已知凭据字面值的请求草稿。");
      }
      const incompatibleCase = located.api.cases.find((testCase) =>
        testCase.requestOverride && testCase.requestOverride.protocol !== request.protocol,
      );
      if (incompatibleCase) {
        const caseLocator: CaseLocator = { ...locator, caseId: incompatibleCase.id, scope: incompatibleCase.scope };
        throw new Error(`Request protocol is incompatible with saved case override at ${JSON.stringify(caseLocator)}`);
      }
      const updated = ApiAssetSchema.parse({
        ...located.api,
        contract: { ...located.api.contract, request },
      });
      const container = locator.folderIds.length
        ? findFolder(located.collection, locator.folderIds)?.folder
        : located.collection;
      if (!container) throw new Error(`API parent not found: ${JSON.stringify(locator)}`);
      const index = container.apis.findIndex((item) => item.contract.id === locator.apiId);
      if (index < 0) throw new Error(`API not found at complete locator: ${JSON.stringify(locator)}`);
      container.apis[index] = updated;
      return { value: { request: updated.contract.request, sourceApiRevision: getSourceApiRevision(updated) } };
    });
  }

  async function saveDraftCase(
    locatorValue: CaseLocator,
    inputValue: ApiTestCase,
    expectedSourceApiRevision: string,
    deletedCasesValue: readonly { caseId: string; scope: string }[] = [],
    knownCredentialLiterals: readonly string[] = [],
    draftWriteContext?: DraftWriteContext,
    fields: readonly DebugFieldState[] = [],
  ): Promise<{ testCase: ApiTestCase; sourceApiRevision: string }> {
    const locator = parseLocator(CaseLocatorSchema, locatorValue, "case");
    const input = ApiTestCaseSchema.parse(clone(inputValue));
    const deletedCases = deletedCasesValue.map((identity) => ({ caseId: identity.caseId, scope: identity.scope }));
    if (deletedCases.some((identity) => !identity.caseId || !identity.scope)
      || new Set(deletedCases.map((identity) => `${identity.caseId}\0${identity.scope}`)).size !== deletedCases.length) {
      throw new TypeError("Invalid physical case deletion list.");
    }
    if (!expectedSourceApiRevision) throw new Error("API source revision is required to save a case draft");
    return mutate((candidate, current) => {
      if (draftWriteContext) assertDraftWriteContext(draftWriteContext, current);
      if (input.id !== locator.caseId || input.scope !== locator.scope) throw new Error("Case id and scope must match its locator");
      const located = locateApiInCandidate(candidate, locator);
      const actualRevision = getSourceApiRevision(located.api);
      if (actualRevision !== expectedSourceApiRevision) {
        throw new Error(`API source revision conflict at ${JSON.stringify(locator)}: expected ${expectedSourceApiRevision}, received ${actualRevision}`);
      }
      if (fields.some((field) => field.needsInput)) throw new Error("请先补齐调试恢复字段，再保存用例草稿。");
      if (containsKnownCredentialLiteral(input, knownCredentialLiterals)) {
        throw new Error("拒绝保存包含已知凭据字面值的用例草稿。");
      }
      if (deletedCases.some((identity) => identity.caseId === locator.caseId && identity.scope === locator.scope)) {
        throw new Error("不能同时保存并删除同一物理用例。");
      }
      const removalTargets = deletedCases.map((identity) => {
        const target = located.api.cases.find((item) => item.id === identity.caseId && item.scope === identity.scope);
        if (!target) throw new Error(`Case version not found: ${identity.caseId} / ${identity.scope}`);
        return target;
      });
      const deletedKeys = new Set(deletedCases.map((identity) => `${identity.caseId}\0${identity.scope}`));
      const nextCases = located.api.cases.filter((item) =>
        !deletedKeys.has(`${item.id}\0${item.scope}`)
        && !(item.id === locator.caseId && item.scope === locator.scope),
      );
      nextCases.push(input);
      for (const caseId of new Set(removalTargets.map((item) => item.id))) {
        if (!nextCases.some((item) => item.id === caseId)) {
          guardWorkflowReferences(located.project, new Set([locator.apiId]), caseId);
        }
      }
      const updated = ApiAssetSchema.parse({
        ...located.api,
        cases: nextCases,
      });
      const container = locator.folderIds.length
        ? findFolder(located.collection, locator.folderIds)?.folder
        : located.collection;
      if (!container) throw new Error(`API parent not found: ${JSON.stringify(locator)}`);
      const index = container.apis.findIndex((item) => item.contract.id === locator.apiId);
      if (index < 0) throw new Error(`API not found at complete locator: ${JSON.stringify(locator)}`);
      container.apis[index] = updated;
      const deletions = removalTargets.flatMap((target) => knownExactFile(current.workspace, casePath(locator, target)));
      return { value: { testCase: input, sourceApiRevision: getSourceApiRevision(updated) }, ...(deletions.length ? { deletions } : {}) };
    });
  }

  async function deleteCase(locatorValue: CaseLocator): Promise<void> {
    const locator = parseLocator(CaseLocatorSchema, locatorValue, "case");
    return mutate((candidate, current) => {
      const located = locateApiInCandidate(candidate, locator);
      const index = located.api.cases.findIndex((testCase) => testCase.id === locator.caseId && testCase.scope === locator.scope);
      if (index < 0) throw new Error(`Case version not found: ${locator.caseId} / ${locator.scope}`);
      const target = located.api.cases[index];
      if (!located.api.cases.some((testCase, itemIndex) => itemIndex !== index && testCase.id === target.id)) {
        guardWorkflowReferences(located.project, new Set([locator.apiId]), target.id);
      }
      located.api.cases.splice(index, 1);
      const path = casePath(locator, target);
      return { value: undefined, deletions: knownExactFile(current.workspace, path) };
    });
  }

  async function createModel(locatorValue: ProjectLocator, inputValue: CreateModelInput): Promise<ModelAsset> {
    const locator = parseLocator(ProjectLocatorSchema, locatorValue, "project");
    const input = clone(inputValue);
    return mutate((candidate) => {
      const { project } = locateProjectInCandidate(candidate, locator);
      const id = newId("model", undefined, project.id);
      if (allProjectIds(project).has(id)) throw new Error(`Target identity collision for model:${id}`);
      const model = ModelAssetSchema.parse({ formatVersion: 1, id, ...input });
      project.models.push(model);
      return { value: model };
    });
  }

  async function saveModel(locatorValue: ModelLocator, inputValue: ModelAsset): Promise<ModelAsset> {
    const locator = parseLocator(ModelLocatorSchema, locatorValue, "model");
    const input = ModelAssetSchema.parse(clone(inputValue));
    return mutate((candidate) => {
      const { project } = locateProjectInCandidate(candidate, locator);
      if (input.id !== locator.modelId) throw new Error("Model id must match its locator");
      const index = project.models.findIndex((item) => item.id === locator.modelId);
      if (index < 0) throw new Error(`Model not found: ${locator.modelId}`);
      project.models[index] = input;
      return { value: input };
    });
  }

  async function createComponent(locatorValue: ProjectLocator, inputValue: CreateComponentInput): Promise<ComponentAsset> {
    const locator = parseLocator(ProjectLocatorSchema, locatorValue, "project");
    const input = clone(inputValue);
    return mutate((candidate) => {
      const { project } = locateProjectInCandidate(candidate, locator);
      const id = newId("component", undefined, project.id);
      if (allProjectIds(project).has(id)) throw new Error(`Target identity collision for component:${id}`);
      const component = ComponentAssetSchema.parse({ formatVersion: 1, id, ...input });
      project.components.push(component);
      return { value: component };
    });
  }

  async function saveComponent(locatorValue: ComponentLocator, inputValue: ComponentAsset): Promise<ComponentAsset> {
    const locator = parseLocator(ComponentLocatorSchema, locatorValue, "component");
    const input = ComponentAssetSchema.parse(clone(inputValue));
    return mutate((candidate) => {
      const { project } = locateProjectInCandidate(candidate, locator);
      if (input.id !== locator.componentId || input.kind !== locator.componentKind) throw new Error("Component identity and kind must match its locator");
      const index = project.components.findIndex((item) => item.kind === locator.componentKind && item.id === locator.componentId);
      if (index < 0) throw new Error(`Component not found: ${locator.componentId}`);
      project.components[index] = input;
      return { value: input };
    });
  }

  async function createEnvironment(locatorValue: ProjectLocator, inputValue: CreateEnvironmentInput): Promise<Environment> {
    const locator = parseLocator(ProjectLocatorSchema, locatorValue, "project");
    const input = clone(inputValue);
    return mutate((candidate) => {
      const { project } = locateProjectInCandidate(candidate, locator);
      const id = newId("environment", undefined, project.id);
      if (project.environments.some((environment) => environment.id === id)) throw new Error(`Target identity collision for environment:${id}`);
      const environment = EnvironmentSchema.parse({ ...input, id, variables: input.variables ?? {}, baseUrls: input.baseUrls ?? {} });
      project.environments.push(environment);
      return { value: environment };
    });
  }

  async function setEnvironmentVariables(locatorValue: EnvironmentLocator, variablesValue: Record<string, string>): Promise<Environment> {
    const locator = parseLocator(EnvironmentLocatorSchema, locatorValue, "environment");
    const variables = recordOfStrings(variablesValue, "variables");
    return mutate((candidate) => {
      const found = findProject(candidate, locator);
      if (!found) throw new Error(`Project not found at complete locator: ${JSON.stringify(locator)}`);
      const environment = single(found.project.environments.filter((item) => item.id === locator.environmentId), `environment ${locator.environmentId}`);
      if (!environment) throw new Error(`Environment not found: ${locator.environmentId}`);
      environment.variables = variables;
      return { value: environment };
    });
  }

  async function setEnvironmentBaseUrls(locatorValue: EnvironmentLocator, baseUrlsValue: Record<string, string>): Promise<Environment> {
    const locator = parseLocator(EnvironmentLocatorSchema, locatorValue, "environment");
    const baseUrls = recordOfStrings(baseUrlsValue, "baseUrls");
    return mutate((candidate) => {
      const found = findProject(candidate, locator);
      if (!found) throw new Error(`Project not found at complete locator: ${JSON.stringify(locator)}`);
      const environment = single(found.project.environments.filter((item) => item.id === locator.environmentId), `environment ${locator.environmentId}`);
      if (!environment) throw new Error(`Environment not found: ${locator.environmentId}`);
      environment.baseUrls = baseUrls;
      return { value: environment };
    });
  }

  async function setProjectGlobals(locatorValue: ProjectLocator, inputValue: ProjectGlobalSettings): Promise<ProjectGlobalSettings> {
    const locator = parseLocator(ProjectLocatorSchema, locatorValue, "project");
    const input = clone(inputValue);
    const variables = recordOfStrings(input.variables, "variables");
    const globals: ProjectGlobals = ProjectGlobalsSchema.parse({ query: input.query, headers: input.headers, cookies: input.cookies, body: input.body });
    return mutate((candidate) => {
      const { project } = locateProjectInCandidate(candidate, locator);
      project.variables = variables;
      project.globals = globals;
      return { value: { variables, ...globals } };
    });
  }

  function getProjectGlobals(locatorValue: ProjectLocator): ProjectGlobalSettings {
    const locator = parseLocator(ProjectLocatorSchema, locatorValue, "project");
    return readWorkspace((workspace) => {
      const found = findProject(workspace, locator);
      if (!found) throw new Error(`Project not found at complete locator: ${JSON.stringify(locator)}`);
      return { variables: found.project.variables, ...found.project.globals };
    });
  }

  async function setStressPolicy(locatorValue: ProjectLocator, policyValue: StressTargetPolicy): Promise<StressTargetPolicy> {
    const locator = parseLocator(ProjectLocatorSchema, locatorValue, "project");
    const policy = StressPolicySchema.parse(clone(policyValue));
    return mutate((candidate) => {
      const { project } = locateProjectInCandidate(candidate, locator);
      project.stressPolicy = policy;
      return { value: policy };
    });
  }

  function getContainer(locatorValue: FolderLocator): ContainerOperations;
  function getContainer(locatorValue: CollectionLocator): CollectionContainerOperations;
  function getContainer(locatorValue: CollectionLocator | FolderLocator): ContainerOperations | CollectionContainerOperations;
  function getContainer(locatorValue: CollectionLocator | FolderLocator): ContainerOperations | CollectionContainerOperations {
    const locator = parseLocator(ApiParentLocatorSchema, locatorValue, "container");
    return readWorkspace((workspace) => {
      const found = findCollection(workspace, locator);
      if (!found) throw new Error(`Collection not found at complete locator: ${JSON.stringify(locator)}`);
      if ("folderIds" in locator) {
        const folder = findFolder(found.collection, locator.folderIds);
        if (!folder) throw new Error(`Folder not found: ${JSON.stringify(locator)}`);
        return { preOperations: folder.folder.preOperations, postOperations: folder.folder.postOperations };
      }
      return { preOperations: found.collection.preOperations, postOperations: found.collection.postOperations, variables: found.collection.variables };
    });
  }

  async function saveContainer(locatorValue: FolderLocator, inputValue: ContainerOperations): Promise<ContainerOperations>;
  async function saveContainer(locatorValue: CollectionLocator, inputValue: CollectionContainerOperations): Promise<CollectionContainerOperations>;
  async function saveContainer(locatorValue: CollectionLocator | FolderLocator, inputValue: ContainerOperations | CollectionContainerOperations): Promise<ContainerOperations | CollectionContainerOperations>;
  async function saveContainer(locatorValue: CollectionLocator | FolderLocator, inputValue: ContainerOperations | CollectionContainerOperations): Promise<ContainerOperations | CollectionContainerOperations> {
    const locator = parseLocator(ApiParentLocatorSchema, locatorValue, "container");
    const input = clone(inputValue);
    return mutate((candidate) => ({ value: setContainerOperations(candidate, locator, input) }));
  }

  async function createWorkflow(locatorValue: ProjectLocator, rawName: string): Promise<Workflow> {
    const locator = parseLocator(ProjectLocatorSchema, locatorValue, "project");
    return mutate((candidate) => {
      const { project } = locateProjectInCandidate(candidate, locator);
      const id = newId("workflow", undefined, project.id);
      if (project.workflows.some((item) => item.id === id)) throw new Error(`Target identity collision for workflow:${id}`);
      const workflow = WorkflowSchema.parse({ id, name: sanitizeNodeName(rawName), status: "draft", nodes: [], edges: [] });
      project.workflows.push(workflow);
      return { value: workflow };
    });
  }

  async function saveWorkflow(locatorValue: WorkflowLocator, inputValue: Workflow): Promise<Workflow> {
    const locator = parseLocator(WorkflowLocatorSchema, locatorValue, "workflow");
    const input = WorkflowSchema.parse(clone(inputValue));
    return mutate((candidate) => {
      const found = locateProjectInCandidate(candidate, locator);
      if (input.id !== locator.workflowId) throw new Error("Workflow id must match its locator");
      const index = found.project.workflows.findIndex((workflow) => workflow.id === locator.workflowId);
      if (index < 0) throw new Error(`Workflow not found: ${locator.workflowId}`);
      input.status = found.project.workflows[index].status;
      found.project.workflows[index] = input;
      return { value: input };
    });
  }

  async function setWorkflowStatus(locatorValue: WorkflowLocator, status: WorkflowStatus): Promise<{ workflow: Workflow; errors: string[]; warnings: string[] }> {
    const locator = parseLocator(WorkflowLocatorSchema, locatorValue, "workflow");
    return mutate((candidate) => {
      const found = locateProjectInCandidate(candidate, locator);
      const current = single(found.project.workflows.filter((workflow) => workflow.id === locator.workflowId), `workflow ${locator.workflowId}`);
      if (!current) throw new Error(`Workflow not found: ${locator.workflowId}`);
      const enablement = validateEnablement(current, candidate, found.project);
      if (current.status === "published" && status === "enabled" && !enablement.ok) {
        return {
          value: { workflow: current, errors: enablement.errors, warnings: enablement.warnings },
          noCommit: true,
        };
      }
      const transitioned = transitionWorkflowStatus(current, status, enablement);
      const index = found.project.workflows.findIndex((workflow) => workflow.id === locator.workflowId);
      found.project.workflows[index] = transitioned;
      return { value: { workflow: transitioned, errors: enablement.errors, warnings: enablement.warnings } };
    });
  }

  async function renameWorkflow(locatorValue: WorkflowLocator, rawName: string): Promise<Workflow> {
    const locator = parseLocator(WorkflowLocatorSchema, locatorValue, "workflow");
    return mutate((candidate) => {
      const found = locateProjectInCandidate(candidate, locator);
      const workflow = single(found.project.workflows.filter((item) => item.id === locator.workflowId), `workflow ${locator.workflowId}`);
      if (!workflow) throw new Error(`Workflow not found: ${locator.workflowId}`);
      workflow.name = sanitizeNodeName(rawName);
      return { value: workflow };
    });
  }

  async function deleteWorkflow(locatorValue: WorkflowLocator): Promise<void> {
    const locator = parseLocator(WorkflowLocatorSchema, locatorValue, "workflow");
    return mutate((candidate) => {
      const found = locateProjectInCandidate(candidate, locator);
      const index = found.project.workflows.findIndex((item) => item.id === locator.workflowId);
      if (index < 0) throw new Error(`Workflow not found: ${locator.workflowId}`);
      found.project.workflows.splice(index, 1);
      return { value: undefined };
    });
  }

  async function renameNode(nodeValue: NodeLocator, rawName: string): Promise<void> {
    const node = parseLocator(NodeLocatorSchema, nodeValue, "node");
    const name = sanitizeNodeName(rawName);
    return mutate((candidate) => {
      switch (node.kind) {
        case "group": {
          checkedWorkspace(candidate, node.locator.workspaceId);
          const group = findGroup(candidate, node.locator.groupId);
          if (!group) throw new Error(`Group not found: ${node.locator.groupId}`);
          if (group.default) throw new Error("默认分组不可改名");
          group.name = name;
          break;
        }
        case "project": locateProjectInCandidate(candidate, node.locator).project.name = name; break;
        case "collection": locateCollectionInCandidate(candidate, node.locator).collection.name = name; break;
        case "folder": {
          const location = locateCollectionInCandidate(candidate, node.locator);
          const folder = findFolder(location.collection, node.locator.folderIds)?.folder;
          if (!folder) throw new Error(`Folder not found: ${JSON.stringify(node.locator)}`);
          folder.name = name;
          break;
        }
        case "api": locateApiInCandidate(candidate, node.locator).api.contract.metadata.name = name; break;
        case "environment": {
          const found = locateProjectInCandidate(candidate, node.locator);
          const environment = single(found.project.environments.filter((item) => item.id === node.locator.environmentId), `environment ${node.locator.environmentId}`);
          if (!environment) throw new Error(`Environment not found: ${node.locator.environmentId}`);
          environment.name = name;
          break;
        }
        case "model": {
          const found = locateProjectInCandidate(candidate, node.locator);
          const model = single(found.project.models.filter((item) => item.id === node.locator.modelId), `model ${node.locator.modelId}`);
          if (!model) throw new Error(`Model not found: ${node.locator.modelId}`);
          model.name = name;
          break;
        }
        case "component": {
          const found = locateProjectInCandidate(candidate, node.locator);
          const component = single(found.project.components.filter((item) => item.kind === node.locator.componentKind && item.id === node.locator.componentId), `component ${node.locator.componentId}`);
          if (!component) throw new Error(`Component not found: ${node.locator.componentId}`);
          component.name = name;
          break;
        }
        case "workflow": {
          const found = locateProjectInCandidate(candidate, node.locator);
          const workflow = single(found.project.workflows.filter((item) => item.id === node.locator.workflowId), `workflow ${node.locator.workflowId}`);
          if (!workflow) throw new Error(`Workflow not found: ${node.locator.workflowId}`);
          workflow.name = name;
          break;
        }
      }
      return { value: undefined };
    });
  }

  async function deleteNode(nodeValue: NodeLocator): Promise<void> {
    const node = parseLocator(NodeLocatorSchema, nodeValue, "node");
    return mutate((candidate, current) => {
      const workspaceBefore = current.workspace;
      let deletions: string[] = [];
      switch (node.kind) {
        case "group": {
          checkedWorkspace(candidate, node.locator.workspaceId);
          const group = findGroup(candidate, node.locator.groupId);
          if (!group) throw new Error(`Group not found: ${node.locator.groupId}`);
          if (group.default) throw new Error("默认分组不可删除");
          candidate.groups = candidate.groups.filter((item) => item.id !== group.id);
          deletions = knownFilesWithPrefix(workspaceBefore, groupPrefix(group.id));
          break;
        }
        case "project": {
          const found = locateProjectInCandidate(candidate, node.locator);
          found.group.projects = found.group.projects.filter((item) => item.id !== found.project.id);
          deletions = knownFilesWithPrefix(workspaceBefore, projectPrefix(found.group.id, found.project.id));
          break;
        }
        case "collection": {
          const found = locateCollectionInCandidate(candidate, node.locator);
          const ids = new Set([ ...found.collection.apis.map((api) => api.contract.id) ]);
          walkFolders(found.collection.folders, (folder) => folder.apis.forEach((api) => ids.add(api.contract.id)));
          guardWorkflowReferences(found.project, ids);
          found.project.collections = found.project.collections.filter((item) => item.id !== found.collection.id);
          deletions = knownFilesWithPrefix(workspaceBefore, `groups/${found.group.id}/projects/${found.project.id}/collections/${found.collection.id}/`);
          break;
        }
        case "folder": {
          const found = locateCollectionInCandidate(candidate, node.locator);
          const folderPath = findFolder(found.collection, node.locator.folderIds);
          if (!folderPath) throw new Error(`Folder not found: ${JSON.stringify(node.locator)}`);
          const apiIds = new Set(folderPath.folder.apis.map((api) => api.contract.id));
          walkFolders(folderPath.folder.folders, (folder) => folder.apis.forEach((api) => apiIds.add(api.contract.id)));
          guardWorkflowReferences(found.project, apiIds);
          const siblings = node.locator.folderIds.length === 1
            ? found.collection.folders
            : findFolder(found.collection, node.locator.folderIds.slice(0, -1))?.folder.folders;
          if (!siblings) throw new Error(`Folder parent not found: ${JSON.stringify(node.locator)}`);
          siblings.splice(siblings.findIndex((item) => item.id === folderPath.folder.id), 1);
          const prefix = `groups/${found.group.id}/projects/${found.project.id}/collections/${found.collection.id}/${node.locator.folderIds.map((id) => `folders/${id}/`).join("")}`;
          deletions = knownFilesWithPrefix(workspaceBefore, prefix);
          break;
        }
        case "api": {
          const found = locateApiInCandidate(candidate, node.locator);
          guardWorkflowReferences(found.project, new Set([found.api.contract.id]));
          const container = node.locator.folderIds.length
            ? findFolder(found.collection, node.locator.folderIds)?.folder
            : found.collection;
          if (!container) throw new Error(`API parent not found: ${JSON.stringify(node.locator)}`);
          container.apis = container.apis.filter((item) => item.contract.id !== found.api.contract.id);
          deletions = knownFilesWithPrefix(workspaceBefore, apiPrefix(node.locator));
          break;
        }
        case "environment": {
          const found = locateProjectInCandidate(candidate, node.locator);
          const before = found.project.environments.length;
          found.project.environments = found.project.environments.filter((item) => item.id !== node.locator.environmentId);
          if (found.project.environments.length === before) throw new Error(`Environment not found: ${node.locator.environmentId}`);
          break;
        }
        case "model": {
          const found = locateProjectInCandidate(candidate, node.locator);
          const references = projectAssetContext(found.project).referencesTo(node.locator.modelId);
          if (references.length) throw new Error(`Asset is referenced: ${JSON.stringify(references)}`);
          const before = found.project.models.length;
          found.project.models = found.project.models.filter((item) => item.id !== node.locator.modelId);
          if (found.project.models.length === before) throw new Error(`Model not found: ${node.locator.modelId}`);
          const file = `groups/${found.group.id}/projects/${found.project.id}/models/${node.locator.modelId}.yaml`;
          deletions = knownExactFile(workspaceBefore, file);
          break;
        }
        case "component": {
          const found = locateProjectInCandidate(candidate, node.locator);
          const references = projectAssetContext(found.project).referencesTo(node.locator.componentId);
          if (references.length) throw new Error(`Asset is referenced: ${JSON.stringify(references)}`);
          const before = found.project.components.length;
          found.project.components = found.project.components.filter((item) => !(item.kind === node.locator.componentKind && item.id === node.locator.componentId));
          if (found.project.components.length === before) throw new Error(`Component not found: ${node.locator.componentId}`);
          const file = `groups/${found.group.id}/projects/${found.project.id}/components/${node.locator.componentKind}/${node.locator.componentId}.yaml`;
          deletions = knownExactFile(workspaceBefore, file);
          break;
        }
        case "workflow": {
          const found = locateProjectInCandidate(candidate, node.locator);
          const before = found.project.workflows.length;
          found.project.workflows = found.project.workflows.filter((item) => item.id !== node.locator.workflowId);
          if (found.project.workflows.length === before) throw new Error(`Workflow not found: ${node.locator.workflowId}`);
          break;
        }
      }
      return { value: undefined, deletions };
    });
  }

  async function cloneProject(locatorValue: ProjectLocator): Promise<ContractProject> {
    const locator = parseLocator(ProjectLocatorSchema, locatorValue, "project");
    return mutate((candidate) => {
      const found = locateProjectInCandidate(candidate, locator);
      const occupiedProjectIds = new Set(found.group.projects.map((project) => project.id));
      const occupiedSecrets = allSecretRefs(candidate);
      const factory = checkedCloneFactory(newId, new Set(), occupiedSecrets);
      const cloned = cloneProjectDefinition(found.project, { newId: factory });
      if (occupiedProjectIds.has(cloned.project.id)) throw new Error(`Target identity collision for project:${cloned.project.id}`);
      found.group.projects.push(cloned.project);
      return { value: cloned.project };
    });
  }

  async function moveProject(sourceValue: ProjectLocator, targetValue: GroupLocator): Promise<void> {
    const sourceLocator = parseLocator(ProjectLocatorSchema, sourceValue, "source project");
    const targetLocator = parseLocator(GroupLocatorSchema, targetValue, "target group");
    return enqueue(async () => {
      const current = requireActive();
      const workspace = current.workspace;
      checkedWorkspace(workspace, sourceLocator.workspaceId);
      checkedWorkspace(workspace, targetLocator.workspaceId);
      const source = findProject(workspace, sourceLocator);
      const target = findGroup(workspace, targetLocator.groupId);
      if (!source) throw new Error(`Project not found at complete locator: ${JSON.stringify(sourceLocator)}`);
      if (!target) throw new Error(`Group not found at complete locator: ${JSON.stringify(targetLocator)}`);
      if (source.group.id === target.id) return;
      if (current.readOnly) throw new Error("工作区处于只读模式，不能写入");
      if (target.projects.some((project) => project.id === source.project.id)) throw new Error(`Target project identity collision: ${source.project.id}`);
      const otherSecretRefs = allSecretRefs(workspace, source.project);
      const rotated = rotateProjectSecretRefs(source.project, {
        newId(sourceRefId) {
          const targetId = newId("secretRef", sourceRefId, source.project.id);
          if (otherSecretRefs.has(targetId)) throw new Error(`Target secret reference collision: ${targetId}`);
          return targetId;
        },
      });
      const candidate = clone(workspace);
      const candidateSource = findProject(candidate, sourceLocator)!;
      const candidateTarget = findGroup(candidate, target.id)!;
      candidateSource.group.projects = candidateSource.group.projects.filter((project) => project.id !== source.project.id);
      candidateTarget.projects.push(rotated);
      const parsed = ContractWorkspaceSchema.parse(candidate);
      const deletions = knownFilesWithPrefix(workspace, projectPrefix(source.group.id, source.project.id));
      const saved = await storage.save(current.root, parsed, { expectedRevision: current.revision, deletions });
      active = { ...current, workspace: parsed, revision: saved.revision };
    });
  }

  async function importProjectToGroup(targetValue: GroupLocator, projectName: string, importedValue: { project: ContractProject }): Promise<ContractProject> {
    const targetLocator = parseLocator(GroupLocatorSchema, targetValue, "target group");
    const imported = ContractProjectSchema.parse(clone(importedValue.project));
    uniqueEnvironmentNames(imported);
    const normalized = sourceAssetNames(imported);
    normalized.name = sanitizeNodeName(projectName.trim() || normalized.name);
    return mutate((candidate) => {
      checkedWorkspace(candidate, targetLocator.workspaceId);
      const target = findGroup(candidate, targetLocator.groupId);
      if (!target) throw new Error(`Target group not found: ${JSON.stringify(targetLocator)}`);
      const occupiedProjectIds = new Set(target.projects.map((project) => project.id));
      const factory = checkedCloneFactory(newId, new Set(), allSecretRefs(candidate));
      const cloned = cloneProjectDefinition(normalized, { newId: factory });
      if (occupiedProjectIds.has(cloned.project.id)) throw new Error(`Target identity collision for project:${cloned.project.id}`);
      target.projects.push(cloned.project);
      return { value: cloned.project };
    });
  }

  async function importModuleToProject(targetValue: ProjectLocator, moduleName: string, importedValue: { project: ContractProject; sourceEnvironmentName?: string }): Promise<ContractCollection[]> {
    const targetLocator = parseLocator(ProjectLocatorSchema, targetValue, "target project");
    const imported = ContractProjectSchema.parse(clone(importedValue.project));
    return mutate((candidate) => {
      const target = locateProjectInCandidate(candidate, targetLocator).project;
      const apiAssets = projectApis(imported);
      const context = createProjectAssetContext({ projectId: imported.id, assets: apiAssets, models: imported.models, components: imported.components });
      const closureByModel = new Map<string, ModelAsset>();
      const closureByComponent = new Map<string, ComponentAsset>();
      for (const asset of apiAssets) {
        const closure = context.dependencyClosure(asset.contract.id);
        for (const model of closure.models) closureByModel.set(model.id, model);
        for (const component of closure.components) closureByComponent.set(`${component.kind}:${component.id}`, component);
      }

      const moduleSource = clone(imported);
      // Module imports discard source environments; keep their original scope names instead of
      // normalizing environment names that will not be persisted with the imported module.
      moduleSource.environments = [];
      const module = sourceAssetNames(moduleSource);
      sanitizeModuleCaseScopes(module);
      module.name = sanitizeNodeName(moduleName.trim() || module.name);
      module.workflows = [];
      module.models = [...closureByModel.values()];
      module.components = [...closureByComponent.values()];
      const environmentsByName = uniqueEnvironmentNames(imported);
      const sourceCollectionsById = new Map<string, ContractCollection>();
      for (const sourceCollection of imported.collections) {
        if (sourceCollectionsById.has(sourceCollection.id)) {
          throw new Error(`Ambiguous source collection identity: ${sourceCollection.id}`);
        }
        sourceCollectionsById.set(sourceCollection.id, sourceCollection);
      }
      for (const collection of module.collections) {
        const sourceCollection = sourceCollectionsById.get(collection.id);
        if (!sourceCollection) throw new Error(`Unresolvable source collection identity: ${collection.id}`);
        collection.name = sanitizeNodeName(moduleName.trim() || collection.name);
        const baseUrl = resolveImportedCollectionBaseUrl(imported, sourceCollection, environmentsByName, importedValue.sourceEnvironmentName);
        if (baseUrl) collection.variables = { ...collection.variables, baseUrl };
      }
      module.environments = [];

      const existingIds = allProjectIds(target);
      const secretIds = allSecretRefs(candidate);
      const sourceIds = allProjectIds(module);
      const temporaryProjectId = randomUUID();
      if (sourceIds.has(temporaryProjectId) || existingIds.has(temporaryProjectId) || temporaryProjectId === target.id) {
        throw new Error("Unable to allocate a temporary module project identity");
      }
      module.id = temporaryProjectId;
      const factory = checkedCloneFactory(newId, existingIds, secretIds, target.id);
      const cloned = cloneProjectDefinition(module, { newId: factory }).project;
      if (cloned.collections.some((collection) => target.collections.some((item) => item.id === collection.id))) {
        throw new Error("Target collection identity collision during module import");
      }
      const newAssetIds = new Set<string>();
      for (const id of [...cloned.models.map((model) => model.id), ...cloned.components.map((component) => component.id), ...projectApis(cloned).map((asset) => asset.contract.id)]) {
        if (newAssetIds.has(id) || existingIds.has(id)) throw new Error(`Target asset identity collision: ${id}`);
        newAssetIds.add(id);
      }
      target.collections.push(...cloned.collections);
      target.models.push(...cloned.models);
      target.components.push(...cloned.components);
      return { value: cloned.collections };
    });
  }

  return {
    get root(): string | null { return active?.root ?? null; },
    get workspace(): ContractWorkspace | null { return active ? clone(active.workspace) : null; },
    get readOnly(): boolean { return active?.readOnly ?? false; },
    get revision(): string | null { return active?.revision ?? null; },
    captureDraftWriteContext,
    assertDraftWriteContext,
    open,
    create,
    ensureDefaultGroup,
    validate,
    createGroup,
    createProject,
    createCollection,
    createFolder,
    createApi,
    locateProject,
    locateApi,
    locateCollection,
    locateFolder,
    locateWorkflow,
    locateEnvironment,
    locateModel,
    locateComponent,
    listModels,
    listComponents,
    referencesTo,
    saveApi,
    saveCase,
    saveRequestDraft,
    saveDraftCase,
    deleteCase,
    createModel,
    saveModel,
    createComponent,
    saveComponent,
    createEnvironment,
    setEnvironmentVariables,
    setEnvironmentBaseUrls,
    setProjectGlobals,
    getProjectGlobals,
    setStressPolicy,
    getContainer,
    saveContainer,
    createWorkflow,
    saveWorkflow,
    setWorkflowStatus,
    renameWorkflow,
    deleteWorkflow,
    workflowImpact,
    renameNode,
    deleteNode,
    cloneProject,
    moveProject,
    importProjectToGroup,
    importModuleToProject,
  };
}

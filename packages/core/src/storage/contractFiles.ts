import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { OperationListSchema, ProjectGlobalsSchema, StressPolicySchema } from "../domain/model.js";
import {
  ApiContractSchema,
  ApiTestCaseSchema,
  ComponentAssetSchema,
  ModelAssetSchema,
  type ApiAsset,
  type ApiTestCase,
  type ComponentAsset,
  type ModelAsset,
} from "../contract/model.js";
import {
  ContractEnvironmentSchema,
  ContractWorkspaceSchema,
  type ContractCollection,
  type ContractFolder,
  type ContractGroup,
  type ContractProject,
  type ContractWorkspace,
} from "../contract/workspace.js";
import { StringRecordSchema } from "../contract/schemaNode.js";
import { createProjectAssetContext } from "../assets/context.js";
import type { LoadProblem } from "../plugin/types.js";
import { WorkflowSchema } from "../workflow/model.js";
import { MockProjectConfigSchema } from "../mock/config.js";
import { DatasetAssetSchema, SuiteAssetSchema } from "../testing/model.js";
import {
  isSafeCaseFileName,
  apiCaseIndexFilePath,
  apiCaseFilePath,
  apiContractFilePath,
  apiDesignFilePath,
  apiCasesDirectoryPath,
  collectionDirectoryPath,
  collectionMetadataFilePath,
  componentAssetFilePath,
  folderDirectoryPath,
  folderMetadataFilePath,
  groupDirectoryPath,
  groupMetadataFilePath,
  modelAssetFilePath,
  datasetAssetFilePath,
  suiteAssetFilePath,
  projectDirectoryPath,
  projectMetadataFilePath,
  validateRelativeFilePath,
  workspaceFilePath,
  type CollectionFileLocation,
  type ApiFileLocation,
  type ProjectFileLocation,
} from "./paths.js";
import { calculateWorkspaceRevision, recoverPendingWriteJournal, type LoadFaultInjector } from "./writeJournal.js";

export interface WorkspaceWritePlan {
  files: Map<string, string>;
}

export interface WorkspaceLoadState<T> {
  workspace: T;
  problems: LoadProblem[];
  revision: string;
  readOnly: boolean;
}

const IdSchema = z.string().uuid();
const ComponentOrderSchema = z.object({ kind: z.enum(["parameter", "auth", "response", "example"]), id: IdSchema }).strict();
const CaseIndexEntrySchema = z.object({ id: z.string(), scope: z.string() }).strict();
const CaseIndexSchema = z.object({ formatVersion: z.literal(1), cases: z.array(CaseIndexEntrySchema) }).strict();
const WorkspaceFileSchema = z.object({
  formatVersion: z.literal(1),
  id: IdSchema,
  name: z.string(),
  variables: StringRecordSchema(z.string()).default({}),
  groupOrder: z.array(IdSchema),
}).strict();
const GroupFileSchema = z.object({
  id: IdSchema,
  name: z.string(),
  default: z.boolean().optional(),
  projectOrder: z.array(IdSchema),
}).strict();
const ProjectFileSchema = z.object({
  id: IdSchema,
  name: z.string(),
  variables: StringRecordSchema(z.string()).default({}),
  globals: ProjectGlobalsSchema,
  environments: z.array(ContractEnvironmentSchema).default([]),
  workflows: z.array(WorkflowSchema).default([]),
  stressPolicy: StressPolicySchema,
  collectionOrder: z.array(IdSchema),
  modelOrder: z.array(IdSchema),
  componentOrder: z.array(ComponentOrderSchema),
  datasetOrder: z.array(IdSchema).default([]),
  suiteOrder: z.array(IdSchema).default([]),
  mock: MockProjectConfigSchema.optional(),
}).strict();
const CollectionFileSchema = z.object({
  id: IdSchema,
  name: z.string(),
  variables: StringRecordSchema(z.string()).default({}),
  preOperations: OperationListSchema,
  postOperations: OperationListSchema,
  folderOrder: z.array(IdSchema),
  apiOrder: z.array(IdSchema),
}).strict();
const FolderFileSchema = z.object({
  id: IdSchema,
  name: z.string(),
  preOperations: OperationListSchema,
  postOperations: OperationListSchema,
  folderOrder: z.array(IdSchema),
  apiOrder: z.array(IdSchema),
}).strict();

type WorkspaceFile = z.output<typeof WorkspaceFileSchema>;
type GroupFile = z.output<typeof GroupFileSchema>;
type ProjectFile = z.output<typeof ProjectFileSchema>;
type CollectionFile = z.output<typeof CollectionFileSchema>;
type FolderFile = z.output<typeof FolderFileSchema>;

function yamlText<T>(path: string, schema: z.ZodType<T>, value: unknown): string {
  let parsed: T;
  try {
    parsed = schema.parse(value);
  } catch {
    throw new TypeError(`Invalid contract data for ${path}`);
  }
  const text = stringify(parsed);
  try {
    schema.parse(parse(text));
  } catch {
    throw new TypeError(`Contract file could not be validated after encoding: ${path}`);
  }
  return text;
}

function addYamlFile(files: Map<string, string>, path: string, schema: z.ZodType<unknown>, value: unknown): void {
  const safePath = validateRelativeFilePath(path);
  if (files.has(safePath)) throw new TypeError(`Duplicate contract file path: ${safePath}`);
  files.set(safePath, yamlText(safePath, schema, value));
}

function addTextFile(files: Map<string, string>, path: string, value: string): void {
  const safePath = validateRelativeFilePath(path);
  if (files.has(safePath)) throw new TypeError(`Duplicate contract file path: ${safePath}`);
  files.set(safePath, value);
}

function encodeApi(
  files: Map<string, string>,
  location: Omit<ApiFileLocation, "apiId">,
  api: ApiAsset,
): void {
  const apiLocation = { ...location, apiId: api.contract.id };
  addYamlFile(files, apiContractFilePath(apiLocation), ApiContractSchema, api.contract);
  addTextFile(files, apiDesignFilePath(apiLocation), api.documentation);
  const parsedCases = api.cases.map((testCase) => ApiTestCaseSchema.parse(testCase));
  addYamlFile(files, apiCaseIndexFilePath(apiLocation), CaseIndexSchema, {
    formatVersion: 1,
    cases: parsedCases.map(({ id, scope }) => ({ id, scope })),
  });
  for (const parsed of parsedCases) {
    const path = apiCaseFilePath({ ...location, apiId: api.contract.id }, parsed.id, parsed.scope);
    addYamlFile(files, path, ApiTestCaseSchema, parsed);
  }
}

function encodeFolder(
  files: Map<string, string>,
  location: CollectionFileLocation,
  folder: ContractFolder,
  ancestors: readonly string[],
): void {
  const folderIds = [...ancestors, folder.id];
  const { id, name, preOperations, postOperations } = folder;
  addYamlFile(files, folderMetadataFilePath(location, folderIds), FolderFileSchema, {
    id,
    name,
    preOperations,
    postOperations,
    folderOrder: folder.folders.map((child) => child.id),
    apiOrder: folder.apis.map((api) => api.contract.id),
  });
  for (const api of folder.apis) encodeApi(files, { ...location, folderIds }, api);
  for (const nested of folder.folders) encodeFolder(files, location, nested, folderIds);
}

function encodeCollection(files: Map<string, string>, project: ProjectFileLocation, collection: ContractCollection): void {
  const location: CollectionFileLocation = { ...project, collectionId: collection.id };
  const { id, name, variables, preOperations, postOperations } = collection;
  addYamlFile(files, collectionMetadataFilePath(location), CollectionFileSchema, {
    id,
    name,
    variables,
    preOperations,
    postOperations,
    folderOrder: collection.folders.map((folder) => folder.id),
    apiOrder: collection.apis.map((api) => api.contract.id),
  });
  for (const api of collection.apis) encodeApi(files, { ...location, folderIds: [] }, api);
  for (const folder of collection.folders) encodeFolder(files, location, folder, []);
}

function encodeProject(files: Map<string, string>, groupId: string, project: ContractProject): void {
  const projectLocation = { groupId, projectId: project.id };
  const { id, name, variables, globals, environments, workflows, stressPolicy } = project;
  addYamlFile(files, projectMetadataFilePath(groupId, project.id), ProjectFileSchema, {
    id, name, variables, globals, environments, workflows, stressPolicy,
    ...(project.mock === undefined ? {} : { mock: project.mock }),
    collectionOrder: project.collections.map((collection) => collection.id),
    modelOrder: project.models.map((model) => model.id),
    componentOrder: project.components.map((component) => ({ kind: component.kind, id: component.id })),
    datasetOrder: (project.datasets ?? []).map((asset) => asset.id),
    suiteOrder: (project.suites ?? []).map((asset) => asset.id),
  });
  for (const collection of project.collections) encodeCollection(files, projectLocation, collection);
  for (const model of project.models) addYamlFile(files, modelAssetFilePath(projectLocation, model.id), ModelAssetSchema, model);
  for (const dataset of project.datasets ?? []) addYamlFile(files, datasetAssetFilePath(projectLocation, dataset.id), DatasetAssetSchema, dataset);
  for (const suite of project.suites ?? []) addYamlFile(files, suiteAssetFilePath(projectLocation, suite.id), SuiteAssetSchema, suite);
  for (const component of project.components) {
    addYamlFile(files, componentAssetFilePath(projectLocation, component.kind, component.id), ComponentAssetSchema, component);
  }
}

export function encodeContractWorkspace(workspace: ContractWorkspace): WorkspaceWritePlan {
  let parsed: ContractWorkspace;
  try {
    parsed = ContractWorkspaceSchema.parse(workspace);
  } catch {
    throw new TypeError("Workspace contains invalid or unsupported contract data");
  }

  const files = new Map<string, string>();
  const { formatVersion, id, name, variables } = parsed;
  addYamlFile(files, workspaceFilePath(), WorkspaceFileSchema, {
    formatVersion,
    id,
    name,
    variables,
    groupOrder: parsed.groups.map((group) => group.id),
  });
  for (const group of parsed.groups) {
    const { id: groupId, name: groupName, default: isDefault } = group;
    addYamlFile(files, groupMetadataFilePath(group.id), GroupFileSchema, {
      id: groupId,
      name: groupName,
      default: isDefault,
      projectOrder: group.projects.map((project) => project.id),
    });
    for (const project of group.projects) encodeProject(files, group.id, project);
  }
  return { files };
}

interface ParsedFile<T> {
  value?: T;
  problem?: LoadProblem;
}

type ContractFileSnapshot = ReadonlyMap<string, Buffer>;

function objectHasFormatVersion(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaProblem(path: string, input: unknown, versioned: boolean): string {
  if (versioned) {
    if (!objectHasFormatVersion(input) || !Object.hasOwn(input, "formatVersion")) {
      return "Missing formatVersion; this file cannot be opened for writing.";
    }
    if (input.formatVersion !== 1) return "Unsupported formatVersion; only version 1 is supported.";
  }
  return "Invalid contract file structure or unknown field.";
}

function nativePath(root: string, relativePath: string): string {
  const safePath = validateRelativeFilePath(relativePath);
  const base = resolve(root);
  const target = resolve(base, ...safePath.split("/"));
  const tail = relative(base, target);
  if (tail === ".." || tail.startsWith(`..${sep}`) || tail === "") {
    throw new TypeError("Contract file path escaped the workspace root");
  }
  return target;
}

async function parseFile<T>(
  root: string,
  relativePath: string,
  schema: z.ZodType<T>,
  versioned = false,
  snapshot?: ContractFileSnapshot,
): Promise<ParsedFile<T>> {
  let raw: Buffer;
  if (snapshot) {
    const file = snapshot.get(relativePath);
    if (!file) return { problem: { file: relativePath, message: "Contract file could not be read." } };
    raw = file;
  } else try {
    const absolutePath = nativePath(root, relativePath);
    const stats = await lstat(absolutePath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      return { problem: { file: relativePath, message: "Contract file is not a regular file." } };
    }
    raw = await readFile(absolutePath);
  } catch {
    return { problem: { file: relativePath, message: "Contract file could not be read." } };
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return { problem: { file: relativePath, message: "Contract file is not valid UTF-8." } };
  }

  let input: unknown;
  try {
    input = parse(text);
  } catch {
    return { problem: { file: relativePath, message: "Invalid YAML syntax." } };
  }
  const result = schema.safeParse(input);
  if (!result.success) return { problem: { file: relativePath, message: schemaProblem(relativePath, input, versioned) } };
  return { value: result.data };
}

function decodeMarkdown(raw: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return undefined;
  }
}

async function readMarkdown(root: string, path: string, snapshot?: ContractFileSnapshot): Promise<{ value?: string; problem?: LoadProblem }> {
  if (snapshot) {
    const raw = snapshot.get(path);
    if (!raw) return { problem: { file: path, message: "Design document could not be read." } };
    const value = decodeMarkdown(raw);
    if (value === undefined) return { problem: { file: path, message: "Design document is not valid UTF-8." } };
    return { value };
  }
  try {
    const absolutePath = nativePath(root, path);
    const stats = await lstat(absolutePath);
    if (!stats.isFile() || stats.isSymbolicLink()) return { problem: { file: path, message: "Design document is not a regular file." } };
    const value = decodeMarkdown(await readFile(absolutePath));
    if (value === undefined) return { problem: { file: path, message: "Design document is not valid UTF-8." } };
    return { value };
  } catch {
    return { problem: { file: path, message: "Design document could not be read." } };
  }
}

async function directoryTreeHasFilesOrLinks(directory: string): Promise<boolean> {
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink() || entry.isFile()) return true;
      if (!entry.isDirectory() || await directoryTreeHasFilesOrLinks(join(directory, entry.name))) return true;
    }
    return false;
  } catch {
    return true;
  }
}

async function listDirectories(
  root: string,
  relativePath: string,
  problems: LoadProblem[],
  snapshot?: ContractFileSnapshot,
): Promise<string[]> {
  if (snapshot) {
    if (snapshot.has(relativePath)) {
      problems.push({ file: relativePath, message: "Asset directory is not a regular directory." });
      return [];
    }
    const entries = snapshotEntries(relativePath, snapshot);
    if (entries.some((entry) => entry.isFile || entry.isSymbolicLink)) {
      problems.push({ file: relativePath, message: "Unexpected file in asset directory." });
    }
    return [...entries.filter((entry) => entry.isDirectory).map((entry) => entry.name)].sort();
  }
  const absolutePath = nativePath(root, relativePath);
  let entries;
  try {
    const stats = await lstat(absolutePath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      problems.push({ file: relativePath, message: "Asset directory is not a regular directory." });
      return [];
    }
    entries = await readdir(absolutePath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    problems.push({ file: relativePath, message: "Asset directory could not be read." });
    return [];
  }

  const children: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      if (await directoryTreeHasFilesOrLinks(join(absolutePath, entry.name))) children.push(entry.name);
    }
    else if (entry.isSymbolicLink()) problems.push({ file: relativePath, message: "Symbolic links are not valid contract assets." });
    else if (entry.isFile()) problems.push({ file: relativePath, message: "Unexpected file in asset directory." });
  }
  return children.sort();
}

function snapshotEntries(relativePath: string, snapshot: ContractFileSnapshot): FileEntry[] {
  const prefix = relativePath ? `${relativePath}/` : "";
  const entries = new Map<string, FileEntry>();
  for (const path of snapshot.keys()) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const separator = rest.indexOf("/");
    const name = separator < 0 ? rest : rest.slice(0, separator);
    if (!name) continue;
    const isDirectory = separator >= 0;
    const current = entries.get(name);
    if (current) current.isDirectory ||= isDirectory;
    else entries.set(name, { name, isFile: !isDirectory, isDirectory, isSymbolicLink: false });
  }
  return [...entries.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function parseMetadata<T>(
  root: string,
  path: string,
  schema: z.ZodType<T>,
  problems: LoadProblem[],
  snapshot?: ContractFileSnapshot,
): Promise<T | undefined> {
  const parsed = await parseFile(root, path, schema, false, snapshot);
  if (parsed.problem) {
    problems.push(parsed.problem);
    return undefined;
  }
  return parsed.value;
}

async function validateContainerEntries(
  root: string,
  relativePath: string,
  allowedFiles: readonly string[],
  allowedDirectories: readonly string[],
  problems: LoadProblem[],
  snapshot?: ContractFileSnapshot,
): Promise<void> {
  for (const entry of await listFiles(root, relativePath, problems, snapshot)) {
    if (entry.isSymbolicLink
      || (entry.isDirectory && !allowedDirectories.includes(entry.name)
        && !(relativePath === "" && entry.name.toLowerCase() === ".apicc"))
      || (entry.isFile && !allowedFiles.includes(entry.name))) {
      problems.push({ file: relativePath, message: "Unexpected entry in asset directory." });
    }
  }
}

function validUuidFolder(value: string): boolean {
  return /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/.test(value);
}

function emptyWorkspace(): ContractWorkspace {
  return { formatVersion: 1, id: randomUUID(), name: "", variables: {}, groups: [] };
}

function collectProjectApis(project: ContractProject): ApiAsset[] {
  const assets: ApiAsset[] = [];
  const visitFolder = (folder: ContractFolder): void => {
    assets.push(...folder.apis);
    for (const child of folder.folders) visitFolder(child);
  };
  for (const collection of project.collections) {
    assets.push(...collection.apis);
    for (const folder of collection.folders) visitFolder(folder);
  }
  return assets;
}

function appendSemanticDiagnostics(workspace: ContractWorkspace, problems: LoadProblem[]): void {
  for (const group of workspace.groups) {
    for (const project of group.projects) {
      const context = createProjectAssetContext({
        projectId: project.id,
        assets: collectProjectApis(project),
        models: project.models,
        components: project.components,
        project,
        datasets: project.datasets,
        suites: project.suites,
      });
      for (const diagnostic of context.diagnostics) {
        const target = diagnostic.targetId === undefined ? "" : ` target=${diagnostic.targetId}`;
        problems.push({
          file: diagnostic.ownerId,
          message: `${diagnostic.code} at ${diagnostic.path}${target}`,
        });
      }
    }
  }
}

function attachProblem(problems: LoadProblem[], problem: LoadProblem | undefined): void {
  if (problem) problems.push(problem);
}

function orderChildIds(expected: readonly string[], actual: readonly string[], path: string, problems: LoadProblem[]): string[] {
  const expectedSet = new Set<string>();
  let hasDuplicate = false;
  for (const id of expected) {
    if (expectedSet.has(id)) hasDuplicate = true;
    expectedSet.add(id);
  }
  const actualSet = new Set(actual);
  const missing = expected.some((id) => !actualSet.has(id));
  const unlisted = actual.some((id) => !expectedSet.has(id));
  if (hasDuplicate || missing || unlisted || expected.length !== actual.length) {
    problems.push({ file: path, message: "Ordered child identities do not match the asset files." });
  }
  return [...expected.filter((id) => actualSet.has(id)), ...actual.filter((id) => !expectedSet.has(id))];
}

function componentKey(component: Pick<ComponentAsset, "kind" | "id">): string {
  return `${component.kind}/${component.id}`;
}

function orderedComponents(
  expected: readonly Pick<ComponentAsset, "kind" | "id">[],
  actual: readonly ComponentAsset[],
  path: string,
  problems: LoadProblem[],
): ComponentAsset[] {
  const expectedKeys = expected.map(componentKey);
  const actualKeys = actual.map(componentKey);
  const orderedKeys = orderChildIds(expectedKeys, actualKeys, path, problems);
  const byKey = new Map(actual.map((component) => [componentKey(component), component]));
  return orderedKeys.flatMap((key) => {
    const component = byKey.get(key);
    return component ? [component] : [];
  });
}

function caseKey(id: string, scope: string): string {
  return `${Buffer.byteLength(id, "utf8")}:${id}${Buffer.byteLength(scope, "utf8")}:${scope}`;
}

async function loadCases(
  root: string,
  location: ApiFileLocation,
  problems: LoadProblem[],
  snapshot?: ContractFileSnapshot,
): Promise<ApiTestCase[]> {
  const casesPath = apiCasesDirectoryPath(location);
  const indexPath = apiCaseIndexFilePath(location);
  const parsedIndex = await parseFile(root, indexPath, CaseIndexSchema, true, snapshot);
  attachProblem(problems, parsedIndex.problem);
  if (!parsedIndex.value) return [];
  let entries: FileEntry[];
  if (snapshot) {
    if (snapshot.has(casesPath)) {
      problems.push({ file: casesPath, message: "Case assets are not stored in a regular directory." });
      return [];
    }
    entries = snapshotEntries(casesPath, snapshot);
  } else {
    const absolute = nativePath(root, casesPath);
    try {
      const stats = await lstat(absolute);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        problems.push({ file: casesPath, message: "Case assets are not stored in a regular directory." });
        return [];
      }
      const entriesWithContent = await Promise.all((await readdir(absolute, { withFileTypes: true })).map(async (entry) => ({
        name: entry.name,
        isFile: entry.isFile(),
        isDirectory: entry.isDirectory(),
        isSymbolicLink: entry.isSymbolicLink(),
        hasContent: entry.isDirectory() ? await directoryTreeHasFilesOrLinks(join(absolute, entry.name)) : true,
      })));
      entries = entriesWithContent.filter((entry) => entry.hasContent).map((entry) => ({
        name: entry.name,
        isFile: entry.isFile,
        isDirectory: entry.isDirectory,
        isSymbolicLink: entry.isSymbolicLink,
      }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      problems.push({ file: casesPath, message: "Case assets could not be read." });
      return [];
    }
  }

  const actualByIdentity = new Map<string, ApiTestCase>();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === "index.yaml") continue;
    if (entry.isSymbolicLink || !entry.isFile || !entry.name.endsWith(".yaml")) {
      problems.push({ file: casesPath, message: "Case asset is not a regular YAML file." });
      continue;
    }
    const file = `${casesPath}/${entry.name}`;
    const parsed = await parseFile(root, file, ApiTestCaseSchema, false, snapshot);
    attachProblem(problems, parsed.problem);
    if (!parsed.value) continue;
    try {
      const expectedPath = apiCaseFilePath(location, parsed.value.id, parsed.value.scope);
      if (expectedPath !== file) {
        problems.push({ file: casesPath, message: "Case filename does not match its case identity." });
        continue;
      }
    } catch {
      problems.push({ file: casesPath, message: "Case identity cannot be represented as a safe filename." });
      continue;
    }
    const key = caseKey(parsed.value.id, parsed.value.scope);
    if (actualByIdentity.has(key)) {
      problems.push({ file: casesPath, message: "Case files contain duplicate logical identities." });
      continue;
    }
    actualByIdentity.set(key, parsed.value);
  }

  const indexIdentities = new Set<string>();
  const cases: ApiTestCase[] = [];
  for (const identity of parsedIndex.value.cases) {
    const key = caseKey(identity.id, identity.scope);
    if (indexIdentities.has(key)) {
      problems.push({ file: indexPath, message: "Case index contains duplicate logical identities." });
      continue;
    }
    indexIdentities.add(key);
    const testCase = actualByIdentity.get(key);
    if (!testCase) {
      problems.push({ file: indexPath, message: "Case index points to a missing case file." });
      continue;
    }
    cases.push(testCase);
  }
  if (actualByIdentity.size !== indexIdentities.size) {
    problems.push({ file: indexPath, message: "Case files do not match the case index." });
  }
  return cases;
}

async function loadApi(
  root: string,
  location: Omit<ApiFileLocation, "apiId">,
  apiId: string,
  problems: LoadProblem[],
  snapshot?: ContractFileSnapshot,
): Promise<ApiAsset | undefined> {
  const apiLocation = { ...location, apiId };
  const contractPath = apiContractFilePath(apiLocation);
  const apiDirectory = contractPath.slice(0, contractPath.lastIndexOf("/"));
  await validateContainerEntries(root, apiDirectory, ["api.yaml", "design.md"], ["cases"], problems, snapshot);
  const parsedContract = await parseFile(root, contractPath, ApiContractSchema, true, snapshot);
  attachProblem(problems, parsedContract.problem);
  if (!parsedContract.value) return undefined;
  if (parsedContract.value.id !== apiId) {
    problems.push({ file: contractPath, message: "API identity does not match its UUID directory." });
    return undefined;
  }

  const design = await readMarkdown(root, apiDesignFilePath(apiLocation), snapshot);
  attachProblem(problems, design.problem);
  const cases = await loadCases(root, apiLocation, problems, snapshot);
  return { contract: parsedContract.value, documentation: design.value ?? "", cases };
}

async function loadApis(
  root: string,
  parentPath: string,
  location: CollectionFileLocation,
  folderIds: readonly string[],
  expectedApiOrder: readonly string[],
  problems: LoadProblem[],
  snapshot?: ContractFileSnapshot,
): Promise<ApiAsset[]> {
  const apiParentPath = folderIds.length === 0
    ? `${parentPath}/apis`
    : `${folderDirectoryPath(location, folderIds)}/apis`;
  const apiIds = orderChildIds(expectedApiOrder, await listDirectories(root, apiParentPath, problems, snapshot), apiParentPath, problems);
  const apis: ApiAsset[] = [];
  for (const apiId of apiIds) {
    if (!validUuidFolder(apiId)) {
      problems.push({ file: apiParentPath, message: "API directory name is not a UUID." });
      continue;
    }
    const api = await loadApi(root, { ...location, folderIds }, apiId, problems, snapshot);
    if (api) apis.push(api);
  }
  return apis;
}

async function loadFolder(
  root: string,
  location: CollectionFileLocation,
  folderIds: readonly string[],
  problems: LoadProblem[],
  snapshot?: ContractFileSnapshot,
): Promise<ContractFolder | undefined> {
  const path = folderMetadataFilePath(location, folderIds);
  await validateContainerEntries(root, folderDirectoryPath(location, folderIds), ["folder.yaml"], ["folders", "apis"], problems, snapshot);
  const data = await parseMetadata(root, path, FolderFileSchema, problems, snapshot);
  if (!data) return undefined;
  if (data.id !== folderIds.at(-1)) {
    problems.push({ file: path, message: "Folder identity does not match its UUID directory." });
    return undefined;
  }
  const foldersBase = `${folderDirectoryPath(location, folderIds)}/folders`;
  const folders: ContractFolder[] = [];
  const childFolderIds = orderChildIds(data.folderOrder, await listDirectories(root, foldersBase, problems, snapshot), foldersBase, problems);
  for (const childId of childFolderIds) {
    if (!validUuidFolder(childId)) {
      problems.push({ file: foldersBase, message: "Folder directory name is not a UUID." });
      continue;
    }
    const child = await loadFolder(root, location, [...folderIds, childId], problems, snapshot);
    if (child) folders.push(child);
  }
  const apis = await loadApis(root, folderDirectoryPath(location, folderIds), location, folderIds, data.apiOrder, problems, snapshot);
  return {
    id: data.id,
    name: data.name,
    preOperations: data.preOperations,
    postOperations: data.postOperations,
    folders,
    apis,
  };
}

async function loadFolders(
  root: string,
  location: CollectionFileLocation,
  expectedFolderOrder: readonly string[],
  problems: LoadProblem[],
  snapshot?: ContractFileSnapshot,
): Promise<ContractFolder[]> {
  const base = `${collectionDirectoryPath(location)}/folders`;
  const folders: ContractFolder[] = [];
  const folderIds = orderChildIds(expectedFolderOrder, await listDirectories(root, base, problems, snapshot), base, problems);
  for (const folderId of folderIds) {
    if (!validUuidFolder(folderId)) {
      problems.push({ file: base, message: "Folder directory name is not a UUID." });
      continue;
    }
    const folder = await loadFolder(root, location, [folderId], problems, snapshot);
    if (folder) folders.push(folder);
  }
  return folders;
}

async function loadCollections(
  root: string,
  groupId: string,
  projectId: string,
  expectedCollectionOrder: readonly string[],
  problems: LoadProblem[],
  snapshot?: ContractFileSnapshot,
): Promise<ContractCollection[]> {
  const projectPath = projectDirectoryPath(groupId, projectId);
  const base = `${projectPath}/collections`;
  const collections: ContractCollection[] = [];
  const collectionIds = orderChildIds(expectedCollectionOrder, await listDirectories(root, base, problems, snapshot), base, problems);
  for (const collectionId of collectionIds) {
    if (!validUuidFolder(collectionId)) {
      problems.push({ file: base, message: "Collection directory name is not a UUID." });
      continue;
    }
    const location = { groupId, projectId, collectionId };
    const path = collectionMetadataFilePath(location);
    await validateContainerEntries(root, collectionDirectoryPath(location), ["collection.yaml"], ["folders", "apis"], problems, snapshot);
    const data = await parseMetadata(root, path, CollectionFileSchema, problems, snapshot);
    if (!data) continue;
    if (data.id !== collectionId) {
      problems.push({ file: path, message: "Collection identity does not match its UUID directory." });
      continue;
    }
    const apis = await loadApis(root, collectionDirectoryPath(location), location, [], data.apiOrder, problems, snapshot);
    const folders = await loadFolders(root, location, data.folderOrder, problems, snapshot);
    collections.push({
      id: data.id,
      name: data.name,
      variables: data.variables,
      preOperations: data.preOperations,
      postOperations: data.postOperations,
      apis,
      folders,
    });
  }
  return collections;
}

async function loadModels(
  root: string,
  location: ProjectFileLocation,
  expectedOrder: readonly string[],
  problems: LoadProblem[],
  snapshot?: ContractFileSnapshot,
): Promise<ModelAsset[]> {
  const base = `${projectDirectoryPath(location.groupId, location.projectId)}/models`;
  const entries = await listFiles(root, base, problems, snapshot);
  const filenames = entries.filter((entry) => entry.name.endsWith(".yaml") && entry.isFile && !entry.isSymbolicLink);
  for (const entry of entries) {
    if (entry.isDirectory || entry.isSymbolicLink) problems.push({ file: base, message: "Model asset is not a regular YAML file." });
    else if (!entry.name.endsWith(".yaml")) problems.push({ file: base, message: "Model asset is not a regular YAML file." });
  }
  const actualOrder = filenames.map((entry) => entry.name.slice(0, -".yaml".length));
  const modelIds = orderChildIds(expectedOrder, actualOrder, base, problems);
  const result = new Map<string, ModelAsset>();
  for (const id of modelIds) {
    if (!validUuidFolder(id)) {
      problems.push({ file: base, message: "Model filename does not contain a UUID." });
      continue;
    }
    const path = `${base}/${id}.yaml`;
    const parsed = await parseFile(root, path, ModelAssetSchema, true, snapshot);
    attachProblem(problems, parsed.problem);
    if (!parsed.value) continue;
    if (parsed.value.id !== id) {
      problems.push({ file: path, message: "Model identity does not match its UUID filename." });
      continue;
    }
    result.set(id, parsed.value);
  }
  return modelIds.flatMap((id) => {
    const model = result.get(id);
    return model ? [model] : [];
  });
}

async function loadTestingAssets<T extends { id: string }>(root: string, location: ProjectFileLocation, directory: "datasets" | "suites", expectedOrder: readonly string[], schema: z.ZodType<T>, problems: LoadProblem[], snapshot?: ContractFileSnapshot): Promise<T[]> {
  const base = `${projectDirectoryPath(location.groupId, location.projectId)}/${directory}`;
  const entries = await listFiles(root, base, problems, snapshot);
  const files = entries.filter((entry) => entry.isFile && !entry.isSymbolicLink && entry.name.endsWith(".yaml"));
  for (const entry of entries) if (!files.includes(entry)) problems.push({ file: base, message: "Testing asset is not a regular YAML file." });
  const ids = orderChildIds(expectedOrder, files.map((entry) => entry.name.slice(0, -5)), base, problems);
  const result: T[] = [];
  for (const id of ids) {
    if (!validUuidFolder(id)) { problems.push({ file: base, message: "Testing asset filename must be a UUID." }); continue; }
    const path = `${base}/${id}.yaml`;
    const parsed = await parseFile(root, path, schema, true, snapshot);
    attachProblem(problems, parsed.problem);
    if (!parsed.value) continue;
    if (parsed.value.id !== id) { problems.push({ file: path, message: "Testing asset identity does not match its filename." }); continue; }
    result.push(parsed.value);
  }
  return result;
}

interface FileEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

async function listFiles(
  root: string,
  relativePath: string,
  problems: LoadProblem[],
  snapshot?: ContractFileSnapshot,
): Promise<FileEntry[]> {
  if (snapshot) {
    if (snapshot.has(relativePath)) {
      problems.push({ file: relativePath, message: "Asset directory is not a regular directory." });
      return [];
    }
    return snapshotEntries(relativePath, snapshot);
  }
  const absolute = relativePath ? nativePath(root, relativePath) : resolve(root);
  try {
    const stats = await lstat(absolute);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      problems.push({ file: relativePath, message: "Asset directory is not a regular directory." });
      return [];
    }
    const entries = await Promise.all((await readdir(absolute, { withFileTypes: true })).map(async (entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink(),
      hasContent: entry.isDirectory()
        ? (relativePath === "" && entry.name.toLowerCase() === ".apicc"
          ? true
          : await directoryTreeHasFilesOrLinks(join(absolute, entry.name)))
        : true,
    })));
    return entries.filter((entry) => entry.hasContent).map((entry) => ({
      name: entry.name,
      isFile: entry.isFile,
      isDirectory: entry.isDirectory,
      isSymbolicLink: entry.isSymbolicLink,
    }))
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    problems.push({ file: relativePath, message: "Asset directory could not be read." });
    return [];
  }
}

async function loadComponents(
  root: string,
  location: ProjectFileLocation,
  expectedOrder: readonly Pick<ComponentAsset, "kind" | "id">[],
  problems: LoadProblem[],
  snapshot?: ContractFileSnapshot,
): Promise<ComponentAsset[]> {
  const base = `${projectDirectoryPath(location.groupId, location.projectId)}/components`;
  const components: ComponentAsset[] = [];
  for (const kind of await listDirectories(root, base, problems, snapshot)) {
    if (!["parameter", "auth", "response", "example"].includes(kind)) {
      problems.push({ file: base, message: "Component directory has an unsupported kind." });
      continue;
    }
    const kindPath = `${base}/${kind}`;
    for (const entry of await listFiles(root, kindPath, problems, snapshot)) {
      if (entry.isDirectory || entry.isSymbolicLink) {
        problems.push({ file: kindPath, message: "Component asset is not a regular YAML file." });
        continue;
      }
      if (!entry.name.endsWith(".yaml")) {
        problems.push({ file: kindPath, message: "Component asset is not a regular YAML file." });
        continue;
      }
      const id = entry.name.slice(0, -".yaml".length);
      if (!validUuidFolder(id)) {
        problems.push({ file: kindPath, message: "Component filename does not contain a UUID." });
        continue;
      }
      const path = `${kindPath}/${entry.name}`;
      const parsed = await parseFile(root, path, ComponentAssetSchema, true, snapshot);
      attachProblem(problems, parsed.problem);
      if (!parsed.value) continue;
      if (parsed.value.id !== id || parsed.value.kind !== kind) {
        problems.push({ file: path, message: "Component identity or kind does not match its path." });
        continue;
      }
      components.push(parsed.value);
    }
  }
  return orderedComponents(expectedOrder, components, base, problems);
}

async function loadProjects(
  root: string,
  groupId: string,
  expectedProjectOrder: readonly string[],
  problems: LoadProblem[],
  snapshot?: ContractFileSnapshot,
): Promise<ContractProject[]> {
  const groupPath = groupDirectoryPath(groupId);
  const base = `${groupPath}/projects`;
  const projects: ContractProject[] = [];
  const projectIds = orderChildIds(expectedProjectOrder, await listDirectories(root, base, problems, snapshot), base, problems);
  for (const projectId of projectIds) {
    if (!validUuidFolder(projectId)) {
      problems.push({ file: base, message: "Project directory name is not a UUID." });
      continue;
    }
    const path = projectMetadataFilePath(groupId, projectId);
    await validateContainerEntries(root, projectDirectoryPath(groupId, projectId), ["project.yaml"], ["collections", "models", "components", "datasets", "suites"], problems, snapshot);
    const data = await parseMetadata(root, path, ProjectFileSchema, problems, snapshot);
    if (!data) continue;
    if (data.id !== projectId) {
      problems.push({ file: path, message: "Project identity does not match its UUID directory." });
      continue;
    }
    const location: ProjectFileLocation = { groupId, projectId };
    const collections = await loadCollections(root, groupId, projectId, data.collectionOrder, problems, snapshot);
    const models = await loadModels(root, location, data.modelOrder, problems, snapshot);
    const components = await loadComponents(root, location, data.componentOrder, problems, snapshot);
    projects.push({
      id: data.id,
      name: data.name,
      variables: data.variables,
      globals: data.globals,
      environments: data.environments,
      collections,
      workflows: data.workflows,
      stressPolicy: data.stressPolicy,
      models,
      components,
      datasets: await loadTestingAssets(root, location, "datasets", data.datasetOrder, DatasetAssetSchema, problems, snapshot),
      suites: await loadTestingAssets(root, location, "suites", data.suiteOrder, SuiteAssetSchema, problems, snapshot),
      ...(data.mock === undefined ? {} : { mock: data.mock }),
    });
  }
  return projects;
}

async function loadGroups(
  root: string,
  expectedOrder: readonly string[],
  problems: LoadProblem[],
  snapshot?: ContractFileSnapshot,
): Promise<ContractGroup[]> {
  const groups: ContractGroup[] = [];
  const groupIds = orderChildIds(expectedOrder, await listDirectories(root, "groups", problems, snapshot), "groups", problems);
  for (const groupId of groupIds) {
    if (!validUuidFolder(groupId)) {
      problems.push({ file: "groups", message: "Group directory name is not a UUID." });
      continue;
    }
    const path = groupMetadataFilePath(groupId);
    await validateContainerEntries(root, groupDirectoryPath(groupId), ["group.yaml"], ["projects"], problems, snapshot);
    const data = await parseMetadata(root, path, GroupFileSchema, problems, snapshot);
    if (!data) continue;
    if (data.id !== groupId) {
      problems.push({ file: path, message: "Group identity does not match its UUID directory." });
      continue;
    }
    const group: ContractGroup = {
      id: data.id,
      name: data.name,
      projects: await loadProjects(root, groupId, data.projectOrder, problems, snapshot),
    };
    if (data.default !== undefined) group.default = data.default;
    groups.push(group);
  }
  return groups;
}

export interface DecodeContractWorkspaceOptions {
  faultInjector?: LoadFaultInjector;
}

async function assembleWorkspace(
  root: string,
  problems: LoadProblem[],
  revision: string,
  snapshot?: ContractFileSnapshot,
): Promise<WorkspaceLoadState<ContractWorkspace>> {
  await validateContainerEntries(root, "", ["apicc.workspace.yaml"], ["groups", ".apicc"], problems, snapshot);
  const workspacePath = workspaceFilePath();
  const parsed = await parseFile(root, workspacePath, WorkspaceFileSchema, true, snapshot);
  if (parsed.problem || !parsed.value) {
    if (parsed.problem) problems.push(parsed.problem);
    else problems.push({ file: workspacePath, message: "Workspace metadata is missing." });
    return { workspace: emptyWorkspace(), problems, revision, readOnly: true };
  }

  const workspace: ContractWorkspace = {
    formatVersion: parsed.value.formatVersion,
    id: parsed.value.id,
    name: parsed.value.name,
    variables: parsed.value.variables,
    groups: await loadGroups(root, parsed.value.groupOrder, problems, snapshot),
  };
  const validated = ContractWorkspaceSchema.safeParse(workspace);
  if (!validated.success) {
    problems.push({ file: workspacePath, message: "Workspace metadata and assets could not be assembled." });
    return { workspace: emptyWorkspace(), problems, revision, readOnly: true };
  }
  const readOnly = problems.length > 0;
  appendSemanticDiagnostics(validated.data, problems);
  return { workspace: validated.data, problems, revision, readOnly };
}

export async function validateProspectiveContractFiles(
  files: ReadonlyMap<string, string>,
): Promise<{ problems: LoadProblem[]; readOnly: boolean }> {
  const snapshot = new Map<string, Buffer>();
  for (const [path, content] of files) {
    const safePath = validateRelativeFilePath(path);
    if (safePath !== path) throw new TypeError("Prospective contract file path is not canonical");
    snapshot.set(safePath, Buffer.from(content, "utf8"));
  }
  const state = await assembleWorkspace(".", [], "prospective", snapshot);
  return { problems: state.problems, readOnly: state.readOnly };
}

export async function decodeContractWorkspace(
  root: string,
  options: DecodeContractWorkspaceOptions = {},
): Promise<WorkspaceLoadState<ContractWorkspace>> {
  const problems = await recoverPendingWriteJournal(root, options.faultInjector);
  let revision = "empty";
  try {
    revision = await calculateWorkspaceRevision(root);
  } catch {
    problems.push({ file: ".", message: "Workspace revision could not be calculated." });
  }
  return assembleWorkspace(root, problems, revision);
}

function isApiFilePath(path: string, finalSegments: readonly string[]): boolean {
  const parts = path.split("/");
  if (parts[0] !== "groups" || !validUuidFolder(parts[1] ?? "")
    || parts[2] !== "projects" || !validUuidFolder(parts[3] ?? "")
    || parts[4] !== "collections" || !validUuidFolder(parts[5] ?? "")) return false;
  let index = 6;
  while (parts[index] === "folders") {
    if (!validUuidFolder(parts[index + 1] ?? "")) return false;
    index += 2;
  }
  if (parts[index] !== "apis" || !validUuidFolder(parts[index + 1] ?? "")) return false;
  return parts.slice(index + 2).join("/") === finalSegments.join("/");
}

export function validateManagedWorkspaceFilePath(path: string): string {
  const safePath = validateRelativeFilePath(path);
  if (safePath === workspaceFilePath() || isApiFilePath(safePath, ["design.md"])) return safePath;

  const parts = safePath.split("/");
  if (parts[0] !== "groups" || !validUuidFolder(parts[1] ?? "")) {
    throw new TypeError(`Invalid contract file path: ${safePath}`);
  }
  if (parts.length === 3 && parts[2] === "group.yaml") return safePath;
  if (parts[2] !== "projects" || !validUuidFolder(parts[3] ?? "")) {
    throw new TypeError(`Invalid contract file path: ${safePath}`);
  }
  if (parts.length === 5 && parts[4] === "project.yaml") return safePath;
  const assetFile = (name: string | undefined): boolean => Boolean(name?.endsWith(".yaml") && validUuidFolder(name.slice(0, -5)));
  if (["models", "datasets", "suites"].includes(parts[4] ?? "") && parts.length === 6 && assetFile(parts[5])) return safePath;
  if (parts[4] === "components" && parts.length === 7
    && ["parameter", "auth", "response", "example"].includes(parts[5] ?? "")
    && assetFile(parts[6])) return safePath;

  let index = 4;
  if (parts[index] !== "collections" || !validUuidFolder(parts[index + 1] ?? "")) {
    throw new TypeError(`Invalid contract file path: ${safePath}`);
  }
  index += 2;
  if (parts[index] === "collection.yaml" && index === parts.length - 1) return safePath;
  let hasFolder = false;
  while (parts[index] === "folders") {
    if (!validUuidFolder(parts[index + 1] ?? "")) throw new TypeError(`Invalid contract file path: ${safePath}`);
    hasFolder = true;
    index += 2;
  }
  if (hasFolder && parts[index] === "folder.yaml" && index === parts.length - 1) return safePath;
  if (parts[index] !== "apis" || !validUuidFolder(parts[index + 1] ?? "")) {
    throw new TypeError(`Invalid contract file path: ${safePath}`);
  }
  const suffix = parts.slice(index + 2);
  if (suffix.length === 1 && (suffix[0] === "api.yaml" || suffix[0] === "design.md")) return safePath;
  if (suffix.length === 2 && suffix[0] === "cases"
    && (suffix[1] === "index.yaml" || isSafeCaseFileName(suffix[1]!))) return safePath;
  throw new TypeError(`Invalid contract file path: ${safePath}`);
}

export function validateSerializedWorkspaceFile(path: string, content: string): void {
  const safePath = validateManagedWorkspaceFilePath(path);
  if (isApiFilePath(safePath, ["design.md"])) return;
  let input: unknown;
  try {
    input = parse(content);
  } catch {
    throw new TypeError(`Invalid YAML in contract file: ${safePath}`);
  }

  const matches = <T>(schema: z.ZodType<T>): T => {
    const result = schema.safeParse(input);
    if (!result.success) throw new TypeError(`Invalid contract file: ${safePath}`);
    return result.data;
  };

  if (safePath === workspaceFilePath()) {
    matches(WorkspaceFileSchema);
    return;
  }
  const parts = safePath.split("/");
  if (parts[0] !== "groups" || !validUuidFolder(parts[1] ?? "")) throw new TypeError(`Invalid contract file path: ${safePath}`);
  if (parts.length === 3 && parts[2] === "group.yaml") {
    const group = matches(GroupFileSchema);
    if (group.id !== parts[1]) throw new TypeError(`Group file identity does not match its path: ${safePath}`);
    return;
  }
  if (parts[2] !== "projects" || !validUuidFolder(parts[3] ?? "")) throw new TypeError(`Invalid contract file path: ${safePath}`);
  const projectLocation = { groupId: parts[1]!, projectId: parts[3]! };
  if (parts.length === 5 && parts[4] === "project.yaml") {
    const project = matches(ProjectFileSchema);
    if (project.id !== projectLocation.projectId) throw new TypeError(`Project file identity does not match its path: ${safePath}`);
    return;
  }
  if (parts[4] === "models" && parts.length === 6 && parts[5]!.endsWith(".yaml")) {
    const model = matches(ModelAssetSchema);
    if (model.id !== parts[5]!.slice(0, -5)) throw new TypeError(`Model file identity does not match its path: ${safePath}`);
    return;
  }
  if ((parts[4] === "datasets" || parts[4] === "suites") && parts.length === 6) {
    const asset = parts[4] === "datasets" ? matches(DatasetAssetSchema) : matches(SuiteAssetSchema);
    if (asset.id !== parts[5]!.slice(0, -5)) throw new TypeError(`Testing asset identity does not match its path: ${safePath}`);
    return;
  }
  if (parts[4] === "components" && parts.length === 7 && parts[6]!.endsWith(".yaml")) {
    const component = matches(ComponentAssetSchema);
    if (component.id !== parts[6]!.slice(0, -5) || component.kind !== parts[5]) throw new TypeError(`Component file identity does not match its path: ${safePath}`);
    return;
  }

  let index = 4;
  if (parts[index] !== "collections" || !validUuidFolder(parts[index + 1] ?? "")) throw new TypeError(`Invalid contract file path: ${safePath}`);
  const location = { ...projectLocation, collectionId: parts[index + 1]! };
  index += 2;
  if (parts[index] === "collection.yaml" && index === parts.length - 1) {
    const collection = matches(CollectionFileSchema);
    if (collection.id !== location.collectionId) throw new TypeError(`Collection file identity does not match its path: ${safePath}`);
    return;
  }
  const folderIds: string[] = [];
  while (parts[index] === "folders") {
    const folderId = parts[index + 1];
    if (!folderId || !validUuidFolder(folderId)) throw new TypeError(`Invalid contract file path: ${safePath}`);
    folderIds.push(folderId);
    index += 2;
  }
  if (parts[index] === "folder.yaml" && index === parts.length - 1 && folderIds.length > 0) {
    const folder = matches(FolderFileSchema);
    if (folder.id !== folderIds.at(-1)) throw new TypeError(`Folder file identity does not match its path: ${safePath}`);
    return;
  }
  if (parts[index] !== "apis" || !validUuidFolder(parts[index + 1] ?? "")) throw new TypeError(`Invalid contract file path: ${safePath}`);
  const apiId = parts[index + 1]!;
  index += 2;
  if (parts[index] === "api.yaml" && index === parts.length - 1) {
    const contract = matches(ApiContractSchema);
    if (contract.id !== apiId) throw new TypeError(`API file identity does not match its path: ${safePath}`);
    return;
  }
  if (parts[index] === "design.md" && index === parts.length - 1) return;
  if (parts[index] === "cases" && parts[index + 1] === "index.yaml" && index === parts.length - 2) {
    matches(CaseIndexSchema);
    return;
  }
  if (parts[index] === "cases" && index === parts.length - 2 && parts[index + 1]!.endsWith(".yaml")) {
    const testCase = matches(ApiTestCaseSchema);
    const expected = apiCaseFilePath({ ...location, folderIds, apiId }, testCase.id, testCase.scope);
    if (expected !== safePath) throw new TypeError(`Case file identity does not match its path: ${safePath}`);
    return;
  }
  throw new TypeError(`Unsupported contract file path: ${safePath}`);
}

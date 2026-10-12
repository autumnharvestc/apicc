import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApiAssetSchema,
  ContractProjectSchema,
  ContractWorkspaceSchema,
  fileStorage,
  type ApiAsset,
  type ContractProject,
  type ContractWorkspace,
  type StorageAdapter,
} from "@apicc/core";

export const uuid = (number: number): string => `00000000-0000-4000-8000-${number.toString(16).padStart(12, "0")}`;

export const IDS = {
  workspace: uuid(1),
  groupOne: uuid(2),
  groupTwo: uuid(3),
  projectOne: uuid(4),
  projectTwo: uuid(5),
  collectionOne: uuid(6),
  collectionTwo: uuid(7),
  folderOne: uuid(8),
  folderTwo: uuid(9),
  sharedApi: uuid(10),
  deepApi: uuid(11),
  sharedCase: "case-shared",
  workflow: uuid(13),
  workflowNode: uuid(14),
  environment: uuid(15),
  model: uuid(16),
  parameter: uuid(17),
  auth: uuid(18),
  response: uuid(19),
  example: uuid(20),
  operation: uuid(21),
  secondCollection: uuid(22),
  secondApi: uuid(23),
  unusedModel: uuid(24),
  unusedComponent: uuid(25),
  unusedAuth: uuid(26),
} as const;

export function makeApi(
  id: string,
  name: string,
  cases: Array<{ id: string; name: string; scope: string }> = [{ id: IDS.sharedCase, name: "smoke", scope: "base" }],
): ApiAsset {
  return ApiAssetSchema.parse({
    contract: {
      formatVersion: 1,
      id,
      metadata: { name, description: "", tags: [], version: "1.0.0", status: "draft" },
      request: {
        protocol: "http",
        method: "GET",
        baseUrl: "https://api.example.test",
        path: "/items",
        pathParams: [],
        query: [],
        headers: [],
        cookies: [],
        auth: { kind: "none" },
        body: { kind: "none" },
      },
      responses: [],
    },
    cases: cases.map((testCase) => ({ ...testCase, parameters: {}, preOperations: [], postOperations: [], assertions: [] })),
    documentation: `# ${name}`,
  });
}

export function makeWorkspace(): ContractWorkspace {
  const sharedApi = makeApi(IDS.sharedApi, "project one API", [
    { id: IDS.sharedCase, name: "blue", scope: "blue" },
    { id: IDS.sharedCase, name: "green", scope: "green" },
  ]);
  sharedApi.contract.request.auth = { kind: "bearer", token: { id: "shared-secret-ref", policy: "credential-alias" } };
  const firstProject: ContractProject = ContractProjectSchema.parse({
    id: IDS.projectOne,
    name: "project one",
    globals: {},
    environments: [{
      id: IDS.environment,
      name: "dev",
      variables: {},
      baseUrls: {
        [IDS.collectionOne]: "https://dev.example.test",
        [IDS.secondCollection]: "https://second.example.test",
      },
    }],
    collections: [
      {
        id: IDS.collectionOne,
        name: "collection one",
        preOperations: [{ id: IDS.operation, type: "script", content: "" }],
        folders: [{
          id: IDS.folderOne,
          name: "parent",
          folders: [{ id: IDS.folderTwo, name: "child", apis: [makeApi(IDS.deepApi, "deep API")] }],
        }],
        apis: [sharedApi],
      },
      { id: IDS.secondCollection, name: "second collection", apis: [makeApi(IDS.secondApi, "second API")] },
    ],
    workflows: [{
      id: IDS.workflow,
      name: "request flow",
      status: "draft",
      nodes: [{ id: IDS.workflowNode, kind: "request", apiId: IDS.sharedApi, caseId: IDS.sharedCase }],
      edges: [],
    }],
    models: [{
      formatVersion: 1,
      id: IDS.model,
      name: "Payload",
      description: "",
      schema: { kind: "scalar", type: "string" },
    }, {
      formatVersion: 1,
      id: IDS.unusedModel,
      name: "Unused model",
      description: "",
      schema: { kind: "scalar", type: "number" },
    }],
    components: [
      {
        formatVersion: 1, id: IDS.parameter, name: "token header", description: "", kind: "parameter",
        definition: { location: "header", name: "x-token", schema: { kind: "scalar", type: "string" }, required: false, description: "" },
      },
      {
        formatVersion: 1, id: IDS.auth, name: "saved auth", description: "", kind: "auth",
        definition: { kind: "bearer", token: { id: "shared-secret-ref", policy: "credential-alias" } },
      },
      {
        formatVersion: 1, id: IDS.response, name: "ok response", description: "", kind: "response",
        definition: { status: "200", description: "", headers: {}, content: {} },
      },
      {
        formatVersion: 1, id: IDS.example, name: "ok example", description: "", kind: "example",
        definition: { name: "ok", value: { ok: true } },
      },
      {
        formatVersion: 1, id: IDS.unusedComponent, name: "unused parameter", description: "", kind: "parameter",
        definition: { location: "query", name: "unused", schema: { kind: "scalar", type: "string" }, required: false, description: "" },
      },
      {
        formatVersion: 1, id: IDS.unusedAuth, name: "unused auth", description: "", kind: "auth",
        definition: { kind: "apikey", name: "x-key", placement: "header", value: { id: "unused-secret-ref", policy: "separate-alias" } },
      },
    ],
  });
  const secondProject: ContractProject = ContractProjectSchema.parse({
    id: IDS.projectTwo,
    name: "project two",
    globals: {},
    collections: [{ id: IDS.collectionTwo, name: "collection two", apis: [makeApi(IDS.sharedApi, "project two API")] }],
  });
  return ContractWorkspaceSchema.parse({
    formatVersion: 1,
    id: IDS.workspace,
    name: "fixture workspace",
    groups: [
      { id: IDS.groupOne, name: "group one", default: true, projects: [firstProject] },
      { id: IDS.groupTwo, name: "group two", projects: [secondProject] },
    ],
  });
}

export function projectOne(workspace: ContractWorkspace): ContractProject {
  return workspace.groups.find((group) => group.id === IDS.groupOne)!.projects.find((project) => project.id === IDS.projectOne)!;
}

export function projectTwo(workspace: ContractWorkspace): ContractProject {
  return workspace.groups.find((group) => group.id === IDS.groupTwo)!.projects.find((project) => project.id === IDS.projectTwo)!;
}

export function findApi(project: ContractProject, apiId: string): ApiAsset | undefined {
  for (const collection of project.collections) {
    const direct = collection.apis.find((asset) => asset.contract.id === apiId);
    if (direct) return direct;
    const nested = findFolderApi(collection.folders, apiId);
    if (nested) return nested;
  }
  return undefined;
}

function findFolderApi(folders: ContractProject["collections"][number]["folders"], apiId: string): ApiAsset | undefined {
  for (const folder of folders) {
    const direct = folder.apis.find((asset) => asset.contract.id === apiId);
    if (direct) return direct;
    const nested = findFolderApi(folder.folders, apiId);
    if (nested) return nested;
  }
  return undefined;
}

export async function makeTempRoot(prefix = "apicc-9b1-"): Promise<{ path: string; dispose: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return { path, dispose: () => rm(path, { recursive: true, force: true }) };
}

export async function persistWorkspace(root: string, workspace: ContractWorkspace): Promise<string> {
  const result = await fileStorage.save(root, workspace, { expectedRevision: "empty", deletions: [] });
  return result.revision;
}

export function countingStorage(base: StorageAdapter = fileStorage) {
  const calls: Array<{ kind: "load" | "save"; root: string; deletions?: readonly string[]; expectedRevision?: string }> = [];
  const storage: StorageAdapter = {
    async load(root) {
      calls.push({ kind: "load", root });
      return base.load(root);
    },
    async save(root, workspace, options) {
      calls.push({ kind: "save", root, deletions: [...options.deletions], expectedRevision: options.expectedRevision });
      return base.save(root, workspace, options);
    },
  };
  return { storage, calls };
}

import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import type { ApiAsset, ParameterBinding, RequestBody } from "../../src/contract/model.js";
import type { ContractCollection, ContractFolder, ContractProject } from "../../src/contract/workspace.js";
import type { Environment, Operation, ProjectGlobals, TestCase } from "../../src/domain/common.js";
import type { CredentialBindings } from "../../src/credentials/types.js";
import type { ProjectExecutionRun, CollectionRunner, RunnerOptions } from "../../src/runner/runner.js";
import type { RunResult } from "../../src/report/types.js";
import type { RuntimeBody } from "../../src/request/body.js";

export interface LegacyRunnerCase extends Partial<TestCase> {
  id: string;
  name: string;
  preScript?: string;
  postScript?: string;
}

export interface LegacyRunnerApi {
  id: string;
  name: string;
  version: string;
  deprecated: boolean;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  url: string;
  headers: Array<{ key: string; value: string; enabled: boolean }>;
  query: Array<{ key: string; value: string; enabled: boolean }>;
  body?: RuntimeBody;
  cases: LegacyRunnerCase[];
}

export interface LegacyRunnerFolder {
  id: string;
  name: string;
  preOperations?: Operation[];
  postOperations?: Operation[];
  apis: LegacyRunnerApi[];
  folders: LegacyRunnerFolder[];
}

export interface LegacyRunnerCollection {
  id: string;
  name: string;
  variables: Record<string, string>;
  preOperations?: Operation[];
  postOperations?: Operation[];
  apis: LegacyRunnerApi[];
  folders: LegacyRunnerFolder[];
}

export interface LegacyRunnerProject {
  id: string;
  name: string;
  variables: Record<string, string>;
  globals?: Partial<ProjectGlobals>;
  environments: Environment[];
}

/**
 * Test-only adapter for the pre-contract runner fixtures. It creates a schema-valid
 * immutable project and invokes the real snapshot-based CollectionRunner API.
 */
export async function runLegacyCollection(
  runner: CollectionRunner,
  legacyCollection: LegacyRunnerCollection,
  environment: Environment,
  legacyProject: LegacyRunnerProject,
  options: RunnerOptions = {},
): Promise<RunResult> {
  let nextId = 1;
  const idMap = new Map<string, string>();
  const uuid = (value: string): string => {
    const existing = idMap.get(value);
    if (existing) return existing;
    const suffix = (nextId++).toString(16).padStart(12, "0");
    const generated = `20000000-0000-4000-8000-${suffix}`;
    idMap.set(value, generated);
    return generated;
  };
  const collectionId = uuid(`collection:${legacyCollection.id}`);
  const contractCollection = toCollection(legacyCollection, collectionId, uuid);
  const environments = new Map<string, Environment>();
  for (const candidate of [...legacyProject.environments, environment]) {
    const baseUrls = { ...candidate.baseUrls };
    const legacyBaseUrl = baseUrls[legacyCollection.id];
    delete baseUrls[legacyCollection.id];
    if (legacyBaseUrl !== undefined) baseUrls[collectionId] = legacyBaseUrl;
    environments.set(candidate.id, { ...candidate, baseUrls });
  }
  const project: ContractProject = {
    id: uuid(`project:${legacyProject.id}`),
    name: legacyProject.name,
    variables: { ...legacyProject.variables },
    globals: {
      query: [...(legacyProject.globals?.query ?? [])],
      headers: [...(legacyProject.globals?.headers ?? [])],
      cookies: [...(legacyProject.globals?.cookies ?? [])],
      body: [...(legacyProject.globals?.body ?? [])],
    },
    environments: [...environments.values()],
    collections: [contractCollection],
    workflows: [],
    stressPolicy: {},
    models: [],
    components: [],
  };
  const snapshot = createProjectSnapshot(project);
  const credentialBindings: CredentialBindings = { resolve: () => { throw new Error("No credentials are used by legacy runner fixtures."); }, versions: {} };
  const execution: ProjectExecutionRun = { snapshot, credentialBindings };
  return runner.run(execution, collectionId, { ...options, environmentId: environment.id });
}

function toCollection(source: LegacyRunnerCollection, id: string, uuid: (value: string) => string): ContractCollection {
  return {
    id,
    name: source.name,
    variables: { ...source.variables },
    preOperations: operations(source.preOperations),
    postOperations: operations(source.postOperations),
    folders: source.folders.map((folder) => toFolder(folder, uuid)),
    apis: source.apis.map((api) => toApi(api, uuid)),
  };
}

function operations(values: Operation[] | undefined): Operation[] {
  return (values ?? []).map((operation) => ({ ...operation }));
}

function toFolder(source: LegacyRunnerFolder, uuid: (value: string) => string): ContractFolder {
  return {
    id: uuid(`folder:${source.id}`),
    name: source.name,
    preOperations: operations(source.preOperations),
    postOperations: operations(source.postOperations),
    folders: source.folders.map((folder) => toFolder(folder, uuid)),
    apis: source.apis.map((api) => toApi(api, uuid)),
  };
}

function toApi(source: LegacyRunnerApi, uuid: (value: string) => string): ApiAsset {
  const { baseUrl, path, urlQuery } = splitUrl(source.url);
  const body = toRequestBody(source.body, uuid);
  const query = [
    ...source.query.map((entry, index) => parameter(entry.key, entry.value, entry.enabled, uuid(`api:${source.id}:query:${index}`))),
    ...urlQuery.map((entry, index) => parameter(entry.key, entry.value, true, uuid(`api:${source.id}:url-query:${index}`))),
  ];
  return {
    contract: {
      formatVersion: 1,
      id: uuid(`api:${source.id}`),
      metadata: { name: source.name, description: "", tags: [], version: source.version, status: source.deprecated ? "deprecated" : "draft" },
      request: {
        protocol: "http",
        method: source.method,
        baseUrl,
        path,
        pathParams: [],
        query,
        headers: source.headers.map((entry, index) => parameter(entry.key, entry.value, entry.enabled, uuid(`api:${source.id}:header:${index}`))),
        cookies: [],
        auth: { kind: "none" },
        body,
      },
      responses: [],
    },
    cases: source.cases.map((testCase) => {
      const { preScript, postScript, ...fields } = testCase;
      return {
        id: fields.id,
        name: fields.name,
        scope: fields.scope ?? "base",
        parameters: { ...(fields.parameters ?? {}) },
        ...(fields.dataDriver ? { dataDriver: { ...fields.dataDriver } } : {}),
        preOperations: [...(fields.preOperations ?? []), ...(preScript === undefined ? [] : [{ id: `${fields.id}-legacy-pre`, type: "script" as const, content: preScript }])],
        postOperations: [...(fields.postOperations ?? []), ...(postScript === undefined ? [] : [{ id: `${fields.id}-legacy-post`, type: "script" as const, content: postScript }])],
        assertions: (fields.assertions ?? []).map((assertion) => ({ ...assertion })),
      };
    }),
    documentation: "",
  };
}

function parameter(name: string, value: string, enabled: boolean, id: string): ParameterBinding {
  return {
    kind: "inline", id, name,
    schema: { kind: "scalar", type: "string" },
    required: false, enabled, description: "", value,
  };
}

function toRequestBody(body: RuntimeBody | undefined, uuid: (value: string) => string): RequestBody {
  if (!body) return { kind: "none" };
  switch (body.kind) {
    case "form":
      return { kind: "urlencoded", fields: body.form.map((field, index) => ({ id: uuid(`form:${index}:${field.key}`), name: field.key, value: field.value, enabled: field.enabled })) };
    case "json": return { kind: "json", content: body.content };
    case "xml": return { kind: "xml", content: body.content };
    case "raw": return { kind: "text", content: body.content };
  }
}

function splitUrl(url: string): { baseUrl: string; path: string; urlQuery: Array<{ key: string; value: string }> } {
  const variableBase = /^(\{\{[^{}]+\}\})(.*)$/.exec(url);
  if (variableBase) return { baseUrl: variableBase[1]!, path: variableBase[2] || "/", urlQuery: [] };
  try {
    const parsed = new URL(url);
    return {
      baseUrl: parsed.origin,
      path: parsed.pathname || "/",
      urlQuery: [...parsed.searchParams.entries()].map(([key, value]) => ({ key, value })),
    };
  } catch {
    return { baseUrl: "{{baseUrl}}", path: url || "/", urlQuery: [] };
  }
}

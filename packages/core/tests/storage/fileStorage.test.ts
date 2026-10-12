import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { ContractWorkspaceSchema, type ContractWorkspace } from "../../src/contract/workspace.js";
import { fileStorage } from "../../src/storage/fileStorage.js";
import {
  apiCaseFilePath,
  apiContractFilePath,
  apiDesignFilePath,
  collectionMetadataFilePath,
  modelAssetFilePath,
  projectMetadataFilePath,
  workspaceFilePath,
} from "../../src/storage/paths.js";
import type { StorageAdapter } from "../../src/plugin/types.js";
import { workspaceFixture } from "../helpers/contractFixtures.js";

const adapter: StorageAdapter = fileStorage;

function workspace(): ContractWorkspace {
  return ContractWorkspaceSchema.parse(workspaceFixture());
}

function workspaceWithNonEmptyPersistenceFields(): ContractWorkspace {
  const value = ContractWorkspaceSchema.parse(workspaceFixture());
  value.variables = { workspaceTier: "shared", workspaceRegion: "eu-west" };
  const project = value.groups[0]!.projects[0]!;
  project.variables = { projectStage: "integration", apiVersion: "v3" };
  project.globals = {
    query: [{ key: "tenant", value: "global-tenant", enabled: true }],
    headers: [{ key: "X-Workspace", value: "workspace-header", enabled: true }],
    cookies: [{ key: "session", value: "global-cookie", enabled: true }],
    body: [{ key: "region", value: "global-region", enabled: true }],
  };
  const parentEnvironmentId = "00000000-0000-4000-8000-000000000032";
  project.environments.push({
    id: parentEnvironmentId,
    name: "shared base",
    variables: { environmentLayer: "base", serviceHost: "shared.example.test" },
    baseUrls: { api: "https://shared.example.test/v3" },
  });
  const environment = project.environments[0]!;
  environment.extends = parentEnvironmentId;
  environment.variables = { environmentLayer: "local", userId: "17" };
  environment.baseUrls = { api: "https://local.example.test/v3" };

  const collection = project.collections[0]!;
  collection.variables = { collectionRegion: "eu-west" };
  collection.postOperations.push({ id: "operation-collection-after", type: "script", content: "collectionFinished = true;" });
  collection.folders[0]!.postOperations.push({ id: "operation-folder-after", type: "script", content: "folderFinished = true;" });

  const api = collection.apis[0]!;
  api.contract.request.headers.push({
    kind: "inline",
    id: "00000000-0000-4000-8000-000000000034",
    name: "X-Trace-Id",
    schema: { kind: "scalar", type: "string" },
    required: false,
    enabled: true,
    description: "trace request through storage",
    value: "trace-17",
  });
  api.contract.request.query.push({
    kind: "inline",
    id: "00000000-0000-4000-8000-000000000035",
    name: "include",
    schema: { kind: "scalar", type: "string" },
    required: false,
    enabled: true,
    description: "related resources",
    value: "roles",
  });
  api.contract.request.auth = {
    kind: "bearer",
    token: { id: "credential-ref-fixture", policy: "project-scoped" },
  };

  const testCase = api.cases[0]!;
  testCase.parameters = { userId: "17", tenant: "case-tenant" };
  testCase.dataDriver = { sourcePath: "fixtures/users.csv", format: "csv" };
  testCase.postOperations = [{ id: "operation-case-after", type: "script", content: "response.checked = true;" }];
  testCase.assertions = [
    { id: "assert-created", target: "status", op: "eq", expected: "201" },
    { id: "assert-user-id", target: "bodyJson", op: "eq", path: "id", expected: "17" },
  ];

  const workflow = project.workflows[0]!;
  workflow.status = "enabled";
  workflow.nodes = [
    { id: "node-create-user", kind: "request", apiId: api.contract.id, caseId: testCase.id, label: "Create user", position: { x: 24, y: 40 } },
    { id: "node-finished", kind: "noop", label: "Finished", position: { x: 280, y: 40 } },
  ];
  workflow.edges = [{ id: "edge-create-finished", from: "node-create-user", to: "node-finished", condition: "status == 201" }];

  return ContractWorkspaceSchema.parse(value);
}

function temporaryRoot(label = "storage"): string {
  return mkdtempSync(join(tmpdir(), `apicc-${label}-`));
}

function projectLocation(value: ContractWorkspace, groupIndex = 0) {
  const group = value.groups[groupIndex]!;
  const project = group.projects[0]!;
  return { group, project };
}

function collectionLocation(value: ContractWorkspace) {
  const { group, project } = projectLocation(value);
  const collection = project.collections[0]!;
  return { group, project, collection, groupId: group.id, projectId: project.id, collectionId: collection.id };
}

function firstApi(value: ContractWorkspace) {
  const { group, project, collection } = collectionLocation(value);
  const api = collection.apis[0]!;
  return { group, project, collection, api, location: { groupId: group.id, projectId: project.id, collectionId: collection.id, folderIds: [], apiId: api.contract.id } };
}

async function saveNew(root: string, value: ContractWorkspace) {
  return adapter.save(root, value, { expectedRevision: "empty", deletions: [] });
}

function editYaml(path: string, edit: (document: Record<string, unknown>) => void): string {
  const document = parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  edit(document);
  const raw = stringify(document);
  writeFileSync(path, raw, "utf8");
  return raw;
}

describe("fileStorage — Task 4 contract file adapter", () => {
  it("save→load roundtrip preserves contract structure, variables, and identity", async () => {
    const root = temporaryRoot();
    const source = workspaceWithNonEmptyPersistenceFields();
    const saved = await saveNew(root, source);
    const loaded = await adapter.load(root);

    expect(loaded.workspace).toEqual(source);
    expect(loaded.problems).toEqual([]);
    expect(loaded.readOnly).toBe(false);
    expect(source.variables).toEqual({ workspaceTier: "shared", workspaceRegion: "eu-west" });
    expect(loaded.workspace.variables).toEqual({ workspaceTier: "shared", workspaceRegion: "eu-west" });
    expect(loaded.workspace.id).toBe(source.id);
    expect(loaded.revision).toBe(saved.revision);
  });

  it("BOM and quoted stressPolicy keys remain valid and normalize across load→save", async () => {
    const root = temporaryRoot();
    const source = workspace();
    await saveNew(root, source);
    const { group, project } = projectLocation(source);
    const metadataPath = join(root, projectMetadataFilePath(group.id, project.id));
    const document = parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    document.stressPolicy = { trustedOrigins: ["HTTPS://Example.COM:443/path"], deniedOrigins: [] };
    const quoted = stringify(document).replace("stressPolicy:", '"stressPolicy":').replace("trustedOrigins:", '"trustedOrigins":');
    writeFileSync(metadataPath, `\uFEFF${quoted}`, "utf8");

    const loaded = await adapter.load(root);
    expect(loaded.problems).toEqual([]);
    expect(loaded.workspace.groups[0]!.projects[0]!.stressPolicy.trustedOrigins).toEqual(["https://example.com"]);
    const saved = await adapter.save(root, loaded.workspace, { expectedRevision: loaded.revision, deletions: [] });
    const reloaded = await adapter.load(root);
    expect(reloaded.workspace.groups[0]!.projects[0]!.stressPolicy.trustedOrigins).toEqual(["https://example.com"]);
    expect(reloaded.revision).toBe(saved.revision);
  });

  it("invalid project stressPolicy is isolated while another project remains readable", async () => {
    const root = temporaryRoot();
    const source = workspace();
    const otherGroup = structuredClone(source.groups[0]!);
    otherGroup.id = "00000000-0000-4000-8000-000000000024";
    otherGroup.name = "healthy group";
    source.groups.push(otherGroup);
    await saveNew(root, source);
    const { project } = projectLocation(source);
    const invalidPath = join(root, projectMetadataFilePath(source.groups[0]!.id, project.id));
    const bytes = editYaml(invalidPath, (document) => {
      document.stressPolicy = { trustedOrigins: ["ftp://not-http.example"], deniedOrigins: [] };
    });

    const loaded = await adapter.load(root);
    expect(loaded.readOnly).toBe(true);
    expect(loaded.problems.some((problem) => problem.file.endsWith("project.yaml"))).toBe(true);
    expect(loaded.workspace.groups[0]!.projects).toEqual([]);
    expect(loaded.workspace.groups[1]!.projects[0]!.name).toBe(project.name);
    expect(readFileSync(invalidPath, "utf8")).toBe(bytes);
  });

  it("stores API design and scoped cases at the canonical case paths", async () => {
    const root = temporaryRoot();
    const source = workspace();
    const { api, location } = firstApi(source);
    api.cases.push({ ...api.cases[0]!, scope: "sit", name: "staging success" });
    await saveNew(root, source);

    const loaded = await adapter.load(root);
    const loadedApi = loaded.workspace.groups[0]!.projects[0]!.collections[0]!.apis[0]!;
    const designPath = apiDesignFilePath(location);
    const scopedCasePath = apiCaseFilePath(location, "case-create-user", "sit");
    expect(loadedApi.documentation).toBe("# Create user\n\nCreates a user.");
    expect(loadedApi.cases.map((testCase) => testCase.scope)).toEqual(["base", "sit"]);
    expect(readFileSync(join(root, designPath), "utf8")).toContain("Creates a user.");
    expect(parse(readFileSync(join(root, scopedCasePath), "utf8")).scope).toBe("sit");
  });

  it("isolates a malformed API file, keeps other assets readable, and preserves its bytes", async () => {
    const root = temporaryRoot();
    const source = workspace();
    await saveNew(root, source);
    const { api, location } = firstApi(source);
    const apiPath = join(root, apiContractFilePath(location));
    const raw = "contract: [malformed";
    writeFileSync(apiPath, raw, "utf8");

    const loaded = await adapter.load(root);
    expect(loaded.readOnly).toBe(true);
    expect(loaded.workspace.groups[0]!.projects[0]!.collections[0]!.apis).toEqual([]);
    expect(loaded.workspace.groups[0]!.projects[0]!.models).toHaveLength(1);
    expect(loaded.problems.some((problem) => problem.file === apiContractFilePath(location))).toBe(true);
    expect(readFileSync(apiPath, "utf8")).toBe(raw);
  });

  it("missing workspace metadata returns a read-only load state instead of throwing", async () => {
    const root = temporaryRoot("missing-root");
    const loaded = await adapter.load(root);

    expect(loaded.readOnly).toBe(true);
    expect(loaded.revision).toBe("empty");
    expect(loaded.problems.some((problem) => problem.file === workspaceFilePath())).toBe(true);
  });

  it("legacy name-based directories are diagnosed read-only without rewriting their bytes", async () => {
    const root = temporaryRoot("legacy-layout");
    await saveNew(root, workspace());
    const legacyDirectory = join(root, "groups", "ecommerce");
    mkdirSync(legacyDirectory, { recursive: true });
    const legacyPath = join(legacyDirectory, "group.yaml");
    const legacyBytes = `id: 00000000-0000-4000-8000-000000000002\nname: ecommerce\n`;
    writeFileSync(legacyPath, legacyBytes, "utf8");

    const loaded = await adapter.load(root);
    expect(loaded.readOnly).toBe(true);
    expect(loaded.problems.some((problem) => problem.message.includes("UUID"))).toBe(true);
    expect(readFileSync(legacyPath, "utf8")).toBe(legacyBytes);
  });

  it("unknown collection fields are strict problems and the original file stays intact", async () => {
    const root = temporaryRoot("unknown-collection");
    const source = workspace();
    await saveNew(root, source);
    const { group, project, collection } = collectionLocation(source);
    const relativePath = collectionMetadataFilePath({ groupId: group.id, projectId: project.id, collectionId: collection.id });
    const absolutePath = join(root, relativePath);
    const raw = editYaml(absolutePath, (document) => { document.futureField = true; });

    const loaded = await adapter.load(root);
    expect(loaded.readOnly).toBe(true);
    expect(loaded.workspace.groups[0]!.projects[0]!.collections).toEqual([]);
    expect(loaded.problems.some((problem) => problem.file === relativePath && problem.message.includes("unknown field"))).toBe(true);
    expect(readFileSync(absolutePath, "utf8")).toBe(raw);
  });

  it("omitted collection defaults are supplied by the contract schema", async () => {
    const root = temporaryRoot("collection-defaults");
    const source = workspace();
    await saveNew(root, source);
    const { group, project, collection } = collectionLocation(source);
    const relativePath = collectionMetadataFilePath({ groupId: group.id, projectId: project.id, collectionId: collection.id });
    editYaml(join(root, relativePath), (document) => {
      delete document.variables;
      delete document.preOperations;
      delete document.postOperations;
    });

    const loaded = await adapter.load(root);
    const readCollection = loaded.workspace.groups[0]!.projects[0]!.collections[0]!;
    expect(loaded.problems).toEqual([]);
    expect(loaded.readOnly).toBe(false);
    expect(readCollection.variables).toEqual({});
    expect(readCollection.preOperations).toEqual([]);
    expect(readCollection.postOperations).toEqual([]);
    expect(readCollection.apis).toHaveLength(1);
  });

  it("unknown API contract fields are rejected without dropping sibling metadata", async () => {
    const root = temporaryRoot("unknown-api");
    const source = workspace();
    await saveNew(root, source);
    const { api, location } = firstApi(source);
    const relativePath = apiContractFilePath(location);
    const absolutePath = join(root, relativePath);
    const raw = editYaml(absolutePath, (document) => { document.futureField = true; });

    const loaded = await adapter.load(root);
    expect(loaded.readOnly).toBe(true);
    expect(loaded.workspace.groups[0]!.projects[0]!.collections).toHaveLength(1);
    expect(loaded.workspace.groups[0]!.projects[0]!.collections[0]!.apis).toEqual([]);
    expect(loaded.problems.some((problem) => problem.file === relativePath)).toBe(true);
    expect(readFileSync(absolutePath, "utf8")).toBe(raw);
    expect(api.contract.metadata.name).toBe("Create user");
  });

  it("invalid workspace metadata is read-only and retained byte-for-byte", async () => {
    const root = temporaryRoot("invalid-workspace");
    await saveNew(root, workspace());
    const relativePath = workspaceFilePath();
    const absolutePath = join(root, relativePath);
    const raw = editYaml(absolutePath, (document) => { document.futureField = "unsupported"; });

    const loaded = await adapter.load(root);
    expect(loaded.readOnly).toBe(true);
    expect(loaded.problems.some((problem) => problem.file === relativePath)).toBe(true);
    expect(readFileSync(absolutePath, "utf8")).toBe(raw);
  });

  it("a collection directory missing collection.yaml is reported without hiding valid collections", async () => {
    const root = temporaryRoot("orphan-collection");
    const source = workspace();
    await saveNew(root, source);
    const { group, project } = projectLocation(source);
    const orphanId = "00000000-0000-4000-8000-000000000027";
    const orphanDirectory = join(root, "groups", group.id, "projects", project.id, "collections", orphanId);
    mkdirSync(orphanDirectory, { recursive: true });
    writeFileSync(join(orphanDirectory, "unexpected.txt"), "orphan", "utf8");

    const loaded = await adapter.load(root);
    expect(loaded.readOnly).toBe(true);
    expect(loaded.workspace.groups[0]!.projects[0]!.collections.map((item) => item.id)).toEqual([project.collections[0]!.id]);
    expect(loaded.problems.some((problem) => problem.file.endsWith(`/collections/${orphanId}/collection.yaml`))).toBe(true);
  });

  it("deep folders, nested APIs, design documents, and scoped cases round-trip", async () => {
    const root = temporaryRoot("nested-folder");
    const source = workspace();
    const { collection } = collectionLocation(source);
    const nestedApi = structuredClone(collection.apis[0]!);
    nestedApi.contract.id = "00000000-0000-4000-8000-000000000026";
    nestedApi.contract.metadata.name = "Nested API";
    nestedApi.cases = [{ ...nestedApi.cases[0]!, scope: "sit", name: "nested staging" }];
    collection.folders[0]!.folders[0]!.apis.push(nestedApi);
    const saved = await saveNew(root, source);
    const loaded = await adapter.load(root);

    expect(loaded.problems).toEqual([]);
    expect(loaded.readOnly).toBe(false);
    expect(loaded.workspace).toEqual(source);
    expect(loaded.revision).toBe(saved.revision);
  });

  it("malformed folder metadata is isolated while the collection API still loads", async () => {
    const root = temporaryRoot("bad-folder");
    const source = workspace();
    await saveNew(root, source);
    const { group, project, collection } = collectionLocation(source);
    const folderId = collection.folders[0]!.id;
    const relativePath = `groups/${group.id}/projects/${project.id}/collections/${collection.id}/folders/${folderId}/folder.yaml`;
    const absolutePath = join(root, relativePath);
    const raw = "folders: [broken";
    writeFileSync(absolutePath, raw, "utf8");

    const loaded = await adapter.load(root);
    expect(loaded.readOnly).toBe(true);
    expect(loaded.workspace.groups[0]!.projects[0]!.collections[0]!.folders).toEqual([]);
    expect(loaded.workspace.groups[0]!.projects[0]!.collections[0]!.apis).toHaveLength(1);
    expect(loaded.problems.some((problem) => problem.file === relativePath)).toBe(true);
    expect(readFileSync(absolutePath, "utf8")).toBe(raw);
  });

  it("metadata-declared order is preserved instead of sorting by display name", async () => {
    const root = temporaryRoot("metadata-order");
    const source = workspace();
    const project = source.groups[0]!.projects[0]!;
    const second = structuredClone(project.collections[0]!);
    second.id = "00000000-0000-4000-8000-000000000028";
    second.name = "AAA collection";
    second.apis = [];
    second.folders = [];
    project.collections[0]!.name = "Zulu collection";
    project.collections = [project.collections[0]!, second];
    await saveNew(root, source);

    const loaded = await adapter.load(root);
    expect(loaded.problems).toEqual([]);
    expect(loaded.workspace.groups[0]!.projects[0]!.collections.map((item) => item.name))
      .toEqual(["Zulu collection", "AAA collection"]);
  });

  it("an API directory missing api.yaml is reported and not silently added", async () => {
    const root = temporaryRoot("orphan-api");
    const source = workspace();
    await saveNew(root, source);
    const { group, project, collection } = collectionLocation(source);
    const orphanId = "00000000-0000-4000-8000-000000000029";
    const orphanDirectory = join(root, "groups", group.id, "projects", project.id, "collections", collection.id, "apis", orphanId);
    mkdirSync(join(orphanDirectory, "cases"), { recursive: true });
    writeFileSync(join(orphanDirectory, "cases", "unexpected.txt"), "orphan", "utf8");

    const loaded = await adapter.load(root);
    expect(loaded.readOnly).toBe(true);
    expect(loaded.workspace.groups[0]!.projects[0]!.collections[0]!.apis.map((api) => api.contract.id))
      .toEqual([collection.apis[0]!.contract.id]);
    expect(loaded.problems.some((problem) => problem.file.endsWith(`/apis/${orphanId}/api.yaml`))).toBe(true);
  });

  it("full contract fields round-trip through strict workspace validation", async () => {
    const root = temporaryRoot("full-contract");
    const source = workspaceWithNonEmptyPersistenceFields();
    const saved = await saveNew(root, source);
    const loaded = await adapter.load(root);
    const sourceProject = source.groups[0]!.projects[0]!;
    const loadedProject = loaded.workspace.groups[0]!.projects[0]!;
    const sourceApi = sourceProject.collections[0]!.apis[0]!;
    const loadedApi = loadedProject.collections[0]!.apis[0]!;
    const sourceCase = sourceApi.cases[0]!;
    const loadedCase = loadedApi.cases[0]!;

    expect(loaded.workspace).toEqual(source);
    expect(() => ContractWorkspaceSchema.parse(loaded.workspace)).not.toThrow();
    expect(loaded.workspace.variables).toEqual({ workspaceTier: "shared", workspaceRegion: "eu-west" });
    expect(loadedProject.variables).toEqual({ projectStage: "integration", apiVersion: "v3" });
    expect(loadedProject.globals).toEqual({
      query: [{ key: "tenant", value: "global-tenant", enabled: true }],
      headers: [{ key: "X-Workspace", value: "workspace-header", enabled: true }],
      cookies: [{ key: "session", value: "global-cookie", enabled: true }],
      body: [{ key: "region", value: "global-region", enabled: true }],
    });
    expect(loadedProject.environments[0]).toEqual({
      id: "00000000-0000-4000-8000-000000000019",
      name: "local",
      extends: "00000000-0000-4000-8000-000000000032",
      variables: { environmentLayer: "local", userId: "17" },
      baseUrls: { api: "https://local.example.test/v3" },
    });
    expect(loadedProject.collections[0]!.variables).toEqual({ collectionRegion: "eu-west" });
    expect(loadedProject.collections[0]!.postOperations).toEqual([
      { id: "operation-collection-after", type: "script", content: "collectionFinished = true;" },
    ]);
    expect(loadedApi.contract.request.headers[0]).toMatchObject({ name: "X-Trace-Id", value: "trace-17" });
    expect(loadedApi.contract.request.query[0]).toMatchObject({ name: "include", value: "roles" });
    expect(loadedApi.contract.request.auth).toEqual({
      kind: "bearer",
      token: { id: "credential-ref-fixture", policy: "project-scoped" },
    });
    expect(loadedCase.parameters).toEqual({ userId: "17", tenant: "case-tenant" });
    expect(loadedCase.dataDriver).toEqual({ sourcePath: "fixtures/users.csv", format: "csv" });
    expect(loadedCase.postOperations).toEqual([
      { id: "operation-case-after", type: "script", content: "response.checked = true;" },
    ]);
    expect(loadedCase.assertions).toEqual([
      { id: "assert-created", target: "status", op: "eq", expected: "201" },
      { id: "assert-user-id", target: "bodyJson", op: "eq", path: "id", expected: "17" },
    ]);
    expect(loadedProject.components).toEqual(sourceProject.components);
    expect(loaded.revision).toBe(saved.revision);
  });

  it("persists workflows inline in project.yaml and reloads the same project view", async () => {
    const root = temporaryRoot("inline-workflows");
    const source = workspaceWithNonEmptyPersistenceFields();
    const { group, project } = projectLocation(source);
    const metadataPath = projectMetadataFilePath(group.id, project.id);
    const saved = await saveNew(root, source);
    const metadata = parse(readFileSync(join(root, metadataPath), "utf8")) as Record<string, unknown>;
    const loaded = await adapter.load(root);
    const workflow = loaded.workspace.groups[0]!.projects[0]!.workflows[0]!;
    const api = loaded.workspace.groups[0]!.projects[0]!.collections[0]!.apis[0]!;

    expect(metadata.workflows).toEqual(project.workflows);
    expect(existsSync(join(root, "groups", group.id, "projects", project.id, "workflows"))).toBe(false);
    expect(loaded.workspace.groups[0]!.projects[0]!.workflows).toEqual(project.workflows);
    expect(workflow.nodes).toEqual([
      { id: "node-create-user", kind: "request", apiId: api.contract.id, caseId: "case-create-user", label: "Create user", position: { x: 24, y: 40 } },
      { id: "node-finished", kind: "noop", label: "Finished", position: { x: 280, y: 40 } },
    ]);
    expect(workflow.edges).toEqual([
      { id: "edge-create-finished", from: "node-create-user", to: "node-finished", condition: "status == 201" },
    ]);
    expect(api.cases[0]!.parameters).toEqual({ userId: "17", tenant: "case-tenant" });
    expect(loaded.revision).toBe(saved.revision);
  });

  it("invalid inline workflow data marks the project read-only and preserves project.yaml", async () => {
    const root = temporaryRoot("bad-inline-workflow");
    const source = workspace();
    await saveNew(root, source);
    const { group, project } = projectLocation(source);
    const relativePath = projectMetadataFilePath(group.id, project.id);
    const absolutePath = join(root, relativePath);
    const raw = editYaml(absolutePath, (document) => {
      document.workflows = [{ id: "bad-workflow", name: "Broken", status: "unknown", nodes: [], edges: [] }];
    });

    const loaded = await adapter.load(root);
    expect(loaded.readOnly).toBe(true);
    expect(loaded.workspace.groups[0]!.projects).toEqual([]);
    expect(loaded.problems.some((problem) => problem.file === relativePath)).toBe(true);
    expect(readFileSync(absolutePath, "utf8")).toBe(raw);
  });
});

describe("StorageAdapter contract workspace persistence", () => {
  it("returns the current revision through load and rejects stale saves", async () => {
    const root = temporaryRoot("storage-revision");
    const source = workspace();

    const saved = await saveNew(root, source);
    const loaded = await adapter.load(root);

    expect(saved.revision).toMatch(/^[0-9a-f]{64}$/);
    expect(loaded.workspace).toEqual(source);
    expect(loaded.problems).toEqual([]);
    expect(loaded.readOnly).toBe(false);
    expect(loaded.revision).toBe(saved.revision);
    await expect(adapter.save(root, source, { expectedRevision: "empty", deletions: [] }))
      .rejects.toThrow("Workspace revision conflict");
  });

  it("requires explicit deletions when the complete replacement view removes a model", async () => {
    const root = temporaryRoot("storage-delete");
    const original = workspace();
    const { group, project } = projectLocation(original);
    const modelPath = modelAssetFilePath({ groupId: group.id, projectId: project.id }, project.models[0]!.id);
    const saved = await saveNew(root, original);
    const replacement = structuredClone(original);
    replacement.groups[0]!.projects[0]!.models = [];

    await expect(adapter.save(root, replacement, { expectedRevision: saved.revision, deletions: [] }))
      .rejects.toThrow("Write plan does not produce a structurally valid workspace");
    expect(readFileSync(join(root, modelPath), "utf8")).toContain("id:");

    const committed = await adapter.save(root, replacement, { expectedRevision: saved.revision, deletions: [modelPath] });
    const loaded = await adapter.load(root);
    expect(committed.revision).not.toBe(saved.revision);
    expect(loaded.workspace.groups[0]!.projects[0]!.models).toEqual([]);
    expect(loaded.readOnly).toBe(false);
  });

  it("reports malformed UTF-8 as read-only and preserves the original bytes on save", async () => {
    const root = temporaryRoot("storage-readonly");
    const source = workspace();
    await saveNew(root, source);
    const { api, location } = firstApi(source);
    const designPath = apiDesignFilePath(location);
    const originalBytes = Buffer.from([0xc3, 0x28, 0xff]);
    writeFileSync(join(root, designPath), originalBytes);

    const loaded = await adapter.load(root);
    expect(loaded.readOnly).toBe(true);
    expect(loaded.problems.some((problem) => problem.file === designPath)).toBe(true);
    await expect(adapter.save(root, source, { expectedRevision: loaded.revision, deletions: [] }))
      .rejects.toThrow("Workspace has unresolved load or recovery problems and is read-only");
    expect(readFileSync(join(root, designPath))).toEqual(originalBytes);
    expect(api.contract.id).toBe("00000000-0000-4000-8000-000000000001");
  });
});

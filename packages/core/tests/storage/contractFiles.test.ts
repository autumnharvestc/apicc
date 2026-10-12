import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { parse, stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { ContractWorkspaceSchema, type ContractWorkspace } from "../../src/contract/workspace.js";
import { ModelAssetSchema } from "../../src/contract/model.js";
import { encodeContractWorkspace, decodeContractWorkspace } from "../../src/storage/contractFiles.js";
import { calculateWorkspaceRevision, commitWritePlan } from "../../src/storage/writeJournal.js";
import {
  apiCaseIndexFilePath,
  apiCaseFilePath,
  apiContractFilePath,
  collectionMetadataFilePath,
  groupMetadataFilePath,
  projectMetadataFilePath,
  workspaceFilePath,
} from "../../src/storage/paths.js";
import { modelAssetFixture, workspaceFixture } from "../helpers/contractFixtures.js";

const roots: string[] = [];
const groupId = "00000000-0000-4000-8000-000000000017";
const projectId = "00000000-0000-4000-8000-000000000018";
const collectionId = "00000000-0000-4000-8000-000000000020";
const apiId = "00000000-0000-4000-8000-000000000001";
const modelId = "00000000-0000-4000-8000-000000000005";

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "apicc-contract-files-"));
  roots.push(root);
  return root;
}

async function save(root: string, plan: ReturnType<typeof encodeContractWorkspace>) {
  const { commitWritePlan } = await import("../../src/storage/writeJournal.js");
  const saved = await commitWritePlan(root, plan, { expectedRevision: "empty", deletions: [] });
  expect(saved.revision).not.toBe("");
  return saved;
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const target = resolve(root);
    const tempRoot = resolve(tmpdir()) + sep;
    if (!isAbsolute(target) || !target.startsWith(tempRoot)) {
      throw new Error(`Refusing to clean a non-test directory: ${target}`);
    }
    await rm(target, { recursive: true, force: true });
  }
});

function fixtureWorkspace(): ContractWorkspace {
  return ContractWorkspaceSchema.parse(workspaceFixture());
}

function uppercaseUuidValues(value: unknown): unknown {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ids = new Map<string, string>();
  let nextId = 1;
  const collect = (current: unknown): void => {
    if (typeof current === "string" && uuidPattern.test(current)) {
      const normalized = current.toLowerCase();
      if (!ids.has(normalized)) {
        const suffix = nextId.toString(16).toUpperCase().padStart(12, "0");
        ids.set(normalized, `ABCDEF00-0000-4000-A000-${suffix}`);
        nextId += 1;
      }
    } else if (Array.isArray(current)) {
      current.forEach(collect);
    } else if (typeof current === "object" && current !== null) {
      for (const [key, child] of Object.entries(current)) {
        collect(key);
        collect(child);
      }
    }
  };
  collect(value);

  const remap = (current: unknown): unknown => {
    if (typeof current === "string") return ids.get(current.toLowerCase()) ?? current;
    if (Array.isArray(current)) return current.map(remap);
    if (typeof current === "object" && current !== null) {
      return Object.fromEntries(Object.entries(current).map(([key, child]) => [ids.get(key.toLowerCase()) ?? key, remap(child)]));
    }
    return current;
  };
  return remap(value);
}

async function expectRemovalRoundTrip(
  deletionPrefix: string,
  remove: (workspace: ContractWorkspace) => void,
): Promise<string> {
  const before = fixtureWorkspace();
  const initialPlan = encodeContractWorkspace(before);
  const root = await temporaryRoot();
  const saved = await save(root, initialPlan);
  const after = structuredClone(before);
  remove(after);
  const nextPlan = encodeContractWorkspace(after);
  const deletions = [...initialPlan.files.keys()].filter((path) => path.startsWith(deletionPrefix));
  expect(deletions.length).toBeGreaterThan(0);

  const committed = await commitWritePlan(root, nextPlan, { expectedRevision: saved.revision, deletions });
  expect(committed.revision).not.toBe(saved.revision);
  const loaded = await decodeContractWorkspace(root);
  expect(loaded.workspace).toEqual(after);
  expect(loaded.readOnly).toBe(false);
  expect(loaded.problems).toEqual([]);
  return root;
}

describe("versioned contract workspace files", () => {
  it("splits contract, design, scoped cases, project models and all component kinds, then round-trips", async () => {
    const workspace = fixtureWorkspace();
    const api = workspace.groups[0]!.projects[0]!.collections[0]!.apis[0]!;
    const sameIdDifferentScope = { ...api.cases[0]!, scope: "release.v1", name: "period scope" };
    const unicodeScope = { ...api.cases[0]!, scope: "环境", name: "unicode scope" };
    const emptyIdentifiers = { ...api.cases[0]!, id: "", scope: "", name: "empty identifiers" };
    const periodIdentifier = { ...api.cases[0]!, id: "case.with.dot", scope: "base", name: "period identifier" };
    api.cases = [periodIdentifier, emptyIdentifiers, unicodeScope, sameIdDifferentScope, api.cases[0]!];

    const plan = encodeContractWorkspace(workspace);
    const contractPath = apiContractFilePath({ groupId, projectId, collectionId, folderIds: [], apiId });
    const contractFile = plan.files.get(contractPath);
    expect(contractFile).toBeDefined();
    expect(parse(contractFile!)).not.toHaveProperty("cases");
    expect(parse(plan.files.get(apiCaseIndexFilePath({ groupId, projectId, collectionId, folderIds: [], apiId }))!)).toEqual({
      formatVersion: 1,
      cases: api.cases.map(({ id, scope }) => ({ id, scope })),
    });
    expect(plan.files.has(apiCaseFilePath({ groupId, projectId, collectionId, folderIds: [], apiId }, "case-create-user", "base"))).toBe(true);
    expect(plan.files.has(apiCaseFilePath({ groupId, projectId, collectionId, folderIds: [], apiId }, "case-create-user", sameIdDifferentScope.scope))).toBe(true);
    expect(plan.files.has(apiCaseFilePath({ groupId, projectId, collectionId, folderIds: [], apiId }, "case-create-user", unicodeScope.scope))).toBe(true);
    expect(plan.files.has(apiCaseFilePath({ groupId, projectId, collectionId, folderIds: [], apiId }, "", ""))).toBe(true);
    expect(plan.files.has(apiCaseFilePath({ groupId, projectId, collectionId, folderIds: [], apiId }, "case.with.dot", "base"))).toBe(true);
    expect(plan.files.has("groups/00000000-0000-4000-8000-000000000017/projects/00000000-0000-4000-8000-000000000018/models/00000000-0000-4000-8000-000000000005.yaml")).toBe(true);
    for (const component of workspace.groups[0]!.projects[0]!.components) {
      expect(plan.files.has(`groups/${groupId}/projects/${projectId}/components/${component.kind}/${component.id}.yaml`)).toBe(true);
    }

    const root = await temporaryRoot();
    const saved = await save(root, plan);
    expect(saved.revision).not.toBe("empty");
    const loaded = await decodeContractWorkspace(root);
    expect(loaded.workspace).toEqual(workspace);
    expect(loaded.readOnly).toBe(false);
    expect(loaded.problems).toEqual([]);
  });

  it("rejects a missing or future workspace format version without changing its bytes", async () => {
    const workspace = fixtureWorkspace();
    const plan = encodeContractWorkspace(workspace);
    const root = await temporaryRoot();
    await save(root, plan);
    const path = join(root, workspaceFilePath());
    const workspaceFile = plan.files.get(workspaceFilePath());
    expect(workspaceFile).toBeDefined();

    for (const invalid of [
      (() => { const value = parse(workspaceFile!); delete value.formatVersion; return value; })(),
      { ...parse(workspaceFile!), formatVersion: 2 },
    ]) {
      const raw = stringify(invalid);
      await writeFile(path, raw, "utf8");
      const loaded = await decodeContractWorkspace(root);
      expect(loaded.readOnly).toBe(true);
      expect(loaded.problems.length).toBeGreaterThan(0);
      expect(await readFile(path, "utf8")).toBe(raw);
    }
  });

  it("rejects a future asset format version without changing that asset's bytes", async () => {
    const workspace = fixtureWorkspace();
    const plan = encodeContractWorkspace(workspace);
    const root = await temporaryRoot();
    await save(root, plan);
    const contractPath = apiContractFilePath({ groupId, projectId, collectionId, folderIds: [], apiId });
    const absolutePath = join(root, contractPath);
    const invalid = parse(plan.files.get(contractPath)!);
    invalid.formatVersion = 2;
    const raw = stringify(invalid);
    await writeFile(absolutePath, raw, "utf8");

    const loaded = await decodeContractWorkspace(root);
    expect(loaded.readOnly).toBe(true);
    expect(loaded.problems.length).toBeGreaterThan(0);
    expect(await readFile(absolutePath, "utf8")).toBe(raw);
  });

  it("rejects case identifiers that are path separators or dot-directory escapes", () => {
    const location = { groupId, projectId, collectionId, folderIds: [], apiId };
    for (const value of ["/", "\\", ".", "..", "../outside"]) {
      expect(() => apiCaseFilePath(location, value, "base")).toThrow();
      expect(() => apiCaseFilePath(location, "valid", value)).toThrow();
    }
  });

  it("round-trips case identifiers that collide under Windows filename case-folding", async () => {
    const workspace = fixtureWorkspace();
    const api = workspace.groups[0]!.projects[0]!.collections[0]!.apis[0]!;
    api.cases = [
      { ...api.cases[0]!, id: "aaa", scope: "base" },
      { ...api.cases[0]!, id: "aaG", scope: "base" },
    ];
    const location = { groupId, projectId, collectionId, folderIds: [], apiId };
    const firstPath = apiCaseFilePath(location, "aaa", "base");
    const secondPath = apiCaseFilePath(location, "aaG", "base");

    const root = await temporaryRoot();
    await save(root, encodeContractWorkspace(workspace));
    const loaded = await decodeContractWorkspace(root);
    expect(loaded.workspace).toEqual(workspace);
    expect(loaded.readOnly).toBe(false);
    expect(loaded.problems).toEqual([]);
    expect(parse(await readFile(join(root, firstPath), "utf8")).id).toBe("aaa");
    expect(parse(await readFile(join(root, secondPath), "utf8")).id).toBe("aaG");
  });

  it("round-trips uppercase, NIL and MAX UUIDs in paths, assets, and references", async () => {
    const workspace = ContractWorkspaceSchema.parse(uppercaseUuidValues(fixtureWorkspace()));
    workspace.groups[0]!.id = "00000000-0000-0000-0000-000000000000";
    workspace.groups[0]!.projects[0]!.id = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    const accepted = ContractWorkspaceSchema.safeParse(workspace);
    if (!accepted.success) throw new Error(JSON.stringify(accepted.error.issues));

    const plan = encodeContractWorkspace(workspace);
    const root = await temporaryRoot();
    await save(root, plan);
    const loaded = await decodeContractWorkspace(root);
    expect(loaded.workspace).toEqual(workspace);
    expect(loaded.readOnly).toBe(false);
    expect(loaded.problems).toEqual([]);
    expect(existsSync(join(root, groupMetadataFilePath(workspace.groups[0]!.id)))).toBe(true);
    expect(existsSync(join(root, projectMetadataFilePath(workspace.groups[0]!.id, workspace.groups[0]!.projects[0]!.id)))).toBe(true);
    expect(JSON.stringify(loaded.workspace)).toContain("ffffffff-ffff-ffff-ffff-ffffffffffff");
  });

  it("validates UUIDs in tree and asset path positions", () => {
    expect(() => apiContractFilePath({ groupId: "../escape", projectId, collectionId, folderIds: [], apiId })).toThrow();
    expect(() => apiContractFilePath({ groupId, projectId, collectionId, folderIds: ["not-a-uuid"], apiId })).toThrow();
    expect(() => apiContractFilePath({
      groupId: "00000000-0000-0000-0000-000000000001",
      projectId,
      collectionId,
      folderIds: [],
      apiId,
    })).toThrow();
    expect(() => apiContractFilePath({
      groupId: "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
      projectId,
      collectionId,
      folderIds: [],
      apiId,
    })).toThrow();
  });

  it("reports a malformed asset without leaking its raw bytes or overwriting them", async () => {
    const workspace = fixtureWorkspace();
    const plan = encodeContractWorkspace(workspace);
    const root = await temporaryRoot();
    await save(root, plan);
    const contractPath = apiContractFilePath({ groupId, projectId, collectionId, folderIds: [], apiId });
    const absolutePath = join(root, contractPath);
    const raw = `${plan.files.get(contractPath)}\nfutureField: "PRIVATE-RAW-SENTINEL"\n`;
    await writeFile(absolutePath, raw, "utf8");

    const loaded = await decodeContractWorkspace(root);
    expect(loaded.readOnly).toBe(true);
    expect(loaded.problems.length).toBeGreaterThan(0);
    expect(JSON.stringify(loaded.problems)).not.toContain("PRIVATE-RAW-SENTINEL");
    expect(await readFile(absolutePath, "utf8")).toBe(raw);
  });

  it("keeps YAML with invalid UTF-8 bytes read-only and preserves the original bytes", async () => {
    const workspace = fixtureWorkspace();
    const plan = encodeContractWorkspace(workspace);
    const root = await temporaryRoot();
    await save(root, plan);

    const absolutePath = join(root, workspaceFilePath());
    const original = await readFile(absolutePath);
    const marker = Buffer.from("Fixture workspace", "utf8");
    const offset = original.indexOf(marker);
    expect(offset).toBeGreaterThanOrEqual(0);
    const invalidScalar = Buffer.concat([
      Buffer.from("PRIVATE-RAW-", "utf8"),
      Buffer.from([0xff]),
      Buffer.from("-SENTINEL", "utf8"),
    ]);
    const raw = Buffer.concat([original.subarray(0, offset), invalidScalar, original.subarray(offset + marker.length)]);
    await writeFile(absolutePath, raw);

    const loaded = await decodeContractWorkspace(root);
    expect(loaded.readOnly).toBe(true);
    expect(loaded.problems.some(({ file }) => file === workspaceFilePath())).toBe(true);
    expect(JSON.stringify(loaded.problems)).not.toContain("PRIVATE-RAW");
    expect(JSON.stringify(loaded.problems)).not.toContain("SENTINEL");

    const revision = await calculateWorkspaceRevision(root);
    await expect(commitWritePlan(root, plan, { expectedRevision: revision, deletions: [] })).rejects.toThrow();
    expect(await readFile(absolutePath)).toEqual(raw);
  });

  it("rejects a prospective group order that has no matching group before creating the root", async () => {
    const plan = encodeContractWorkspace(fixtureWorkspace());
    const workspacePath = workspaceFilePath();
    const workspaceFile = parse(plan.files.get(workspacePath)!);
    workspaceFile.groupOrder = ["00000000-0000-4000-8000-000000000099"];
    plan.files.set(workspacePath, stringify(workspaceFile));
    const parent = await temporaryRoot();
    const root = join(parent, "not-created");

    await expect(commitWritePlan(root, plan, { expectedRevision: "empty", deletions: [] })).rejects.toThrow();
    expect(existsSync(root)).toBe(false);
  });

  it("rejects a prospective case index that disagrees with case files without changing disk", async () => {
    const workspace = fixtureWorkspace();
    const initial = encodeContractWorkspace(workspace);
    const root = await temporaryRoot();
    const saved = await save(root, initial);
    const plan = encodeContractWorkspace(workspace);
    const indexPath = apiCaseIndexFilePath({ groupId, projectId, collectionId, folderIds: [], apiId });
    const index = parse(plan.files.get(indexPath)!);
    index.cases = [];
    plan.files.set(indexPath, stringify(index));

    await expect(commitWritePlan(root, plan, { expectedRevision: saved.revision, deletions: [] })).rejects.toThrow();
    expect(await calculateWorkspaceRevision(root)).toBe(saved.revision);
    expect(parse(await readFile(join(root, indexPath), "utf8")).cases).toHaveLength(1);
  });

  it("reopens writable after deleting an API while empty directory residue remains", async () => {
    const root = await expectRemovalRoundTrip(
      `groups/${groupId}/projects/${projectId}/collections/${collectionId}/apis/${apiId}/`,
      (workspace) => { workspace.groups[0]!.projects[0]!.collections[0]!.apis = []; },
    );
    expect(existsSync(join(root, `groups/${groupId}/projects/${projectId}/collections/${collectionId}/apis/${apiId}`))).toBe(true);
  });

  it("reopens writable after deleting a group with empty descendants", async () => {
    const root = await expectRemovalRoundTrip(`groups/${groupId}/`, (workspace) => { workspace.groups = []; });
    expect(existsSync(join(root, `groups/${groupId}`))).toBe(true);
  });

  it("reopens writable after deleting a project with empty descendants", async () => {
    await expectRemovalRoundTrip(
      `groups/${groupId}/projects/${projectId}/`,
      (workspace) => { workspace.groups[0]!.projects = []; },
    );
  });

  it("reopens writable after deleting a collection with empty descendants", async () => {
    await expectRemovalRoundTrip(
      `groups/${groupId}/projects/${projectId}/collections/${collectionId}/`,
      (workspace) => { workspace.groups[0]!.projects[0]!.collections = []; },
    );
  });

  it("reopens writable after deleting a folder with empty descendants", async () => {
    const folderId = "00000000-0000-4000-8000-000000000021";
    await expectRemovalRoundTrip(
      `groups/${groupId}/projects/${projectId}/collections/${collectionId}/folders/${folderId}/`,
      (workspace) => { workspace.groups[0]!.projects[0]!.collections[0]!.folders = []; },
    );
  });

  it("does not hide unknown files inside a formal API directory", async () => {
    const plan = encodeContractWorkspace(fixtureWorkspace());
    const root = await temporaryRoot();
    await save(root, plan);
    const unknownPath = join(root, `groups/${groupId}/projects/${projectId}/collections/${collectionId}/apis/${apiId}/unexpected.txt`);
    await writeFile(unknownPath, "preserve this unknown file\n", "utf8");

    const loaded = await decodeContractWorkspace(root);
    expect(loaded.readOnly).toBe(true);
    expect(loaded.problems.length).toBeGreaterThan(0);
    expect(await readFile(unknownPath, "utf8")).toBe("preserve this unknown file\n");
  });

  it("keeps missing semantic model references as a writable draft", async () => {
    const workspace = fixtureWorkspace();
    const project = workspace.groups[0]!.projects[0]!;
    project.models = [ModelAssetSchema.parse(modelAssetFixture())];
    project.models[0]!.schema = { kind: "modelRef", modelId: "00000000-0000-4000-8000-000000000099" };
    const plan = encodeContractWorkspace(workspace);
    const root = await temporaryRoot();
    await save(root, plan);

    const loaded = await decodeContractWorkspace(root);
    expect(loaded.workspace).toEqual(workspace);
    expect(loaded.readOnly).toBe(false);
    expect(loaded.problems.some(({ file, message }) => file === modelId
      && message.includes("ASSET_REFERENCE_MISSING")
      && message.includes("models[0].schema.modelId")
      && message.includes("00000000-0000-4000-8000-000000000099"))).toBe(true);
  });

  it("round-trips non-lexicographic multi-level child and cross-kind asset order", async () => {
    const workspace = fixtureWorkspace();
    const originalGroup = workspace.groups[0]!;
    const orderedGroup = structuredClone(originalGroup);
    orderedGroup.id = "00000000-0000-4000-8000-000000000090";
    const orderedProject = orderedGroup.projects[0]!;
    orderedProject.id = "00000000-0000-4000-8000-000000000092";
    const firstProject = structuredClone(orderedProject);
    firstProject.id = "00000000-0000-4000-8000-000000000091";
    orderedGroup.projects = [orderedProject, firstProject];

    const collection = orderedProject.collections[0]!;
    collection.id = "00000000-0000-4000-8000-000000000044";
    const firstCollection = structuredClone(collection);
    firstCollection.id = "00000000-0000-4000-8000-000000000043";
    orderedProject.collections = [collection, firstCollection];
    const firstFolder = structuredClone(collection.folders[0]!);
    firstFolder.id = "00000000-0000-4000-8000-000000000046";
    collection.folders = [firstFolder, collection.folders[0]!];
    const nestedFolder = collection.folders[1]!.folders[0]!;
    const firstNestedFolder = structuredClone(nestedFolder);
    firstNestedFolder.id = "00000000-0000-4000-8000-000000000048";
    collection.folders[1]!.folders = [firstNestedFolder, nestedFolder];

    const api = collection.apis[0]!;
    const firstApi = structuredClone(api);
    firstApi.contract.id = "00000000-0000-4000-8000-000000000049";
    firstApi.cases = [
      { ...api.cases[0]!, id: "z-last", scope: "base" },
      { ...api.cases[0]!, id: "a-first", scope: "base" },
    ];
    collection.apis = [firstApi, api];
    const folderApi = structuredClone(api);
    folderApi.contract.id = "00000000-0000-4000-8000-000000000052";
    const secondFolderApi = structuredClone(api);
    secondFolderApi.contract.id = "00000000-0000-4000-8000-000000000002";
    secondFolderApi.cases = [];
    collection.folders[1]!.apis = [folderApi, secondFolderApi];

    const secondModel = structuredClone(orderedProject.models[0]!);
    secondModel.id = "00000000-0000-4000-8000-000000000053";
    orderedProject.models = [secondModel, orderedProject.models[0]!];
    orderedProject.components = [
      orderedProject.components[3]!,
      orderedProject.components[0]!,
      orderedProject.components[2]!,
      orderedProject.components[1]!,
    ];
    workspace.groups = [orderedGroup, originalGroup];

    const plan = encodeContractWorkspace(workspace);
    expect(parse(plan.files.get(groupMetadataFilePath(orderedGroup.id))!).projectOrder).toEqual([
      orderedProject.id,
      firstProject.id,
    ]);
    expect(parse(plan.files.get(projectMetadataFilePath(orderedGroup.id, orderedProject.id))!).collectionOrder).toEqual([
      collection.id,
      firstCollection.id,
    ]);
    expect(parse(plan.files.get(collectionMetadataFilePath({ groupId: orderedGroup.id, projectId: orderedProject.id, collectionId: collection.id }))!).folderOrder).toEqual([
      firstFolder.id,
      "00000000-0000-4000-8000-000000000021",
    ]);

    const root = await temporaryRoot();
    await save(root, plan);
    const loaded = await decodeContractWorkspace(root);
    expect(loaded.workspace).toEqual(workspace);
    expect(loaded.readOnly).toBe(false);
    expect(loaded.problems.some(({ message }) => message.includes("ASSET_ID_DUPLICATE"))).toBe(true);

    const emptyCaseApi = collection.folders[1]!.apis[1]!;
    const emptyIndex = await readFile(join(root, apiCaseIndexFilePath({
      groupId: orderedGroup.id,
      projectId: orderedProject.id,
      collectionId: collection.id,
      folderIds: [collection.folders[1]!.id],
      apiId: emptyCaseApi.contract.id,
    })), "utf8");
    expect(parse(emptyIndex)).toEqual({ formatVersion: 1, cases: [] });
  });

  it("treats empty child arrays symmetrically without inventing asset directories", async () => {
    const emptyWorkspace = fixtureWorkspace();
    emptyWorkspace.groups = [];
    const emptyWorkspaceRoot = await temporaryRoot();
    await save(emptyWorkspaceRoot, encodeContractWorkspace(emptyWorkspace));
    expect((await decodeContractWorkspace(emptyWorkspaceRoot)).workspace).toEqual(emptyWorkspace);
    expect(existsSync(join(emptyWorkspaceRoot, "groups"))).toBe(false);

    const workspace = fixtureWorkspace();
    const group = workspace.groups[0]!;
    const project = group.projects[0]!;
    const collection = project.collections[0]!;
    collection.folders = [];
    collection.apis[0]!.cases = [];
    project.models = [];
    project.components = [];
    const root = await temporaryRoot();
    await save(root, encodeContractWorkspace(workspace));
    const loaded = await decodeContractWorkspace(root);
    expect(loaded.workspace).toEqual(workspace);
    expect(loaded.readOnly).toBe(false);
    expect(existsSync(join(root, `groups/${groupId}/projects/${projectId}/models`))).toBe(false);
    expect(existsSync(join(root, `groups/${groupId}/projects/${projectId}/components`))).toBe(false);
    expect(existsSync(join(root, `groups/${groupId}/projects/${projectId}/collections/${collectionId}/folders`))).toBe(false);
    expect(parse(await readFile(join(root, apiCaseIndexFilePath({ groupId, projectId, collectionId, folderIds: [], apiId })), "utf8"))).toEqual({
      formatVersion: 1,
      cases: [],
    });
  });

  it("returns read-only on order/index mismatches without deleting or rewriting assets", async () => {
    const workspace = fixtureWorkspace();
    const plan = encodeContractWorkspace(workspace);
    const root = await temporaryRoot();
    await save(root, plan);
    const orderPath = workspaceFilePath();
    const originalOrderBytes = await readFile(join(root, orderPath), "utf8");
    const brokenOrder = parse(originalOrderBytes);
    brokenOrder.groupOrder = [groupId, groupId];
    await writeFile(join(root, orderPath), stringify(brokenOrder), "utf8");

    const orderState = await decodeContractWorkspace(root);
    expect(orderState.readOnly).toBe(true);
    expect(orderState.problems.some(({ file }) => file === "groups")).toBe(true);
    expect(existsSync(join(root, groupMetadataFilePath(groupId)))).toBe(true);
    expect(await readFile(join(root, groupMetadataFilePath(groupId)), "utf8")).toBe(plan.files.get(groupMetadataFilePath(groupId)));

    await writeFile(join(root, orderPath), originalOrderBytes, "utf8");
    const indexPath = apiCaseIndexFilePath({ groupId, projectId, collectionId, folderIds: [], apiId });
    const indexBytes = await readFile(join(root, indexPath), "utf8");
    const brokenIndex = parse(indexBytes);
    brokenIndex.cases = [];
    await writeFile(join(root, indexPath), stringify(brokenIndex), "utf8");
    const casePath = apiCaseFilePath({ groupId, projectId, collectionId, folderIds: [], apiId }, "case-create-user", "base");
    const caseBytes = await readFile(join(root, casePath), "utf8");

    const indexState = await decodeContractWorkspace(root);
    expect(indexState.readOnly).toBe(true);
    expect(indexState.problems.some(({ file }) => file === indexPath)).toBe(true);
    expect(await readFile(join(root, casePath), "utf8")).toBe(caseBytes);
    expect(await readFile(join(root, indexPath), "utf8")).toBe(stringify(brokenIndex));
  });
});

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ContractProjectSchema, ContractWorkspaceSchema, fileStorage, createProjectAssetContext, getSourceApiRevision, listContractWorkspaceDefinitionFiles, type ApiRequest, type ContractWorkspace } from "@apicc/core";
import { createSession } from "../../src/main/session.js";
import {
  countingStorage,
  findApi,
  IDS,
  makeTempRoot,
  makeWorkspace,
  persistWorkspace,
  projectOne,
  projectTwo,
  uuid,
} from "./helpers/contract-assets.js";

const projectLocator = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
const apiLocator = {
  ...projectLocator,
  collectionId: IDS.collectionOne,
  folderIds: [],
  apiId: IDS.sharedApi,
};

function observeActiveWorkspaceReference(session: { readonly workspace: ContractWorkspace | null }): ContractWorkspace {
  const originalClone = globalThis.structuredClone;
  let observed: ContractWorkspace | undefined;
  globalThis.structuredClone = ((value, options) => {
    if (typeof value === "object" && value !== null && "groups" in value && Array.isArray(value.groups)) {
      observed = value as unknown as ContractWorkspace;
    }
    return originalClone(value, options);
  }) as typeof globalThis.structuredClone;
  try {
    if (session.workspace === null) throw new Error("Session workspace is not open");
  } finally {
    globalThis.structuredClone = originalClone;
  }
  if (!observed) throw new Error("The Session workspace getter did not clone its active workspace");
  return observed;
}

async function definitionFileBytes(root: string, files: readonly string[]): Promise<Array<{ path: string; bytes: Buffer }>> {
  return Promise.all(files.map(async (file) => ({
    path: file,
    bytes: await readFile(join(root, ...file.split("/"))),
  })));
}

async function expectModuleImportRejectedWithoutWrite(preview: ReturnType<typeof projectOne>, reason: RegExp): Promise<void> {
  const temporary = await makeTempRoot();
  try {
    const workspace = makeWorkspace();
    await persistWorkspace(temporary.path, workspace);
    const before = await fileStorage.load(temporary.path);
    const counted = countingStorage();
    const session = createSession({ storage: counted.storage });
    await session.open(temporary.path);
    const previewBefore = structuredClone(preview);
    const activeBefore = observeActiveWorkspaceReference(session);
    const revisionBefore = session.revision;
    const files = listContractWorkspaceDefinitionFiles(before.workspace);
    const bytesBefore = await definitionFileBytes(temporary.path, files);

    await expect(session.importModuleToProject({ ...projectLocator, groupId: IDS.groupTwo, projectId: IDS.projectTwo }, "ambiguous source", { project: preview }))
      .rejects.toThrow(reason);

    expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(0);
    expect(session.revision).toBe(revisionBefore);
    expect(observeActiveWorkspaceReference(session)).toBe(activeBefore);
    expect(session.workspace).toEqual(before.workspace);
    expect(preview).toEqual(previewBefore);
    expect(await definitionFileBytes(temporary.path, files)).toEqual(bytesBefore);
    expect(await fileStorage.load(temporary.path)).toMatchObject({ workspace: before.workspace, revision: before.revision });
  } finally {
    await temporary.dispose();
  }
}

describe("desktop session file transactions", () => {
  it("saves a request draft in one revision-checked transaction without replacing cases", async () => {
    const temporary = await makeTempRoot();
    try {
      const workspace = makeWorkspace();
      await persistWorkspace(temporary.path, workspace);
      const session = createSession();
      await session.open(temporary.path);
      const before = session.locateApi(apiLocator)!;
      const expectedSourceApiRevision = getSourceApiRevision(before.api);
      const casesBefore = structuredClone(before.api.cases);
      const request: ApiRequest = { ...structuredClone(before.api.contract.request), path: "/draft-only" };

      const saved = await session.saveRequestDraft(apiLocator, request, expectedSourceApiRevision);

      expect(saved.request.path).toBe("/draft-only");
      expect(saved.sourceApiRevision).toBe(getSourceApiRevision(session.locateApi(apiLocator)!.api));
      expect(session.locateApi(apiLocator)?.api.contract.request.path).toBe("/draft-only");
      expect(session.locateApi(apiLocator)?.api.cases).toEqual(casesBefore);
      expect((await fileStorage.load(temporary.path)).workspace.groups[0]?.projects[0]?.collections[0]?.apis[0]?.contract.request.path).toBe("/draft-only");
    } finally {
      await temporary.dispose();
    }
  });

  it("saves only the selected case draft in one revision-checked transaction", async () => {
    const temporary = await makeTempRoot();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const counted = countingStorage();
      const session = createSession({ storage: counted.storage });
      await session.open(temporary.path);
      const before = session.locateApi(apiLocator)!;
      const selected = structuredClone(before.api.cases[0]!);
      const otherCases = structuredClone(before.api.cases.slice(1));
      const removed = otherCases[0]!;
      const locator = { ...apiLocator, caseId: selected.id, scope: selected.scope };
      const expectedSourceApiRevision = getSourceApiRevision(before.api);
      selected.name = "one-case draft";

      await expect(session.saveDraftCase(locator, selected, expectedSourceApiRevision, [], [], undefined,
        [{ path: "request.path", status: "redacted", needsInput: true }]))
        .rejects.toThrow(/complete|补齐|needs input/i);
      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(0);

      const saved = await session.saveDraftCase(locator, selected, expectedSourceApiRevision, [{ caseId: removed.id, scope: removed.scope }]);

      const after = session.locateApi(apiLocator)!.api;
      expect(saved.testCase.name).toBe("one-case draft");
      expect(saved.sourceApiRevision).toBe(getSourceApiRevision(after));
      expect(after.cases.find((testCase) => testCase.id === selected.id && testCase.scope === selected.scope)?.name).toBe("one-case draft");
      expect(after.cases).toEqual([selected]);
      expect(counted.calls.at(-1)?.deletions).toEqual([
        `groups/${IDS.groupOne}/projects/${IDS.projectOne}/collections/${IDS.collectionOne}/apis/${IDS.sharedApi}/cases/${Buffer.from(removed.id).toString("hex")}.677265656e.yaml`,
      ]);
      const reopened = createSession();
      await reopened.open(temporary.path);
      expect(reopened.locateApi(apiLocator)?.api.cases).toEqual([selected]);
    } finally {
      await temporary.dispose();
    }
  });

  it("rejects a request save when a case changed after the draft source revision", async () => {
    const temporary = await makeTempRoot();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const counted = countingStorage();
      const session = createSession({ storage: counted.storage });
      await session.open(temporary.path);
      const before = session.locateApi(apiLocator)!;
      const staleSourceApiRevision = getSourceApiRevision(before.api);
      const changedCase = structuredClone(before.api.cases[0]!);
      changedCase.name = "saved elsewhere";
      await session.saveCase({ ...apiLocator, caseId: changedCase.id, scope: changedCase.scope }, changedCase, staleSourceApiRevision);
      const diskAfterOtherSave = await fileStorage.load(temporary.path);
      counted.calls.length = 0;

      await expect(session.saveRequestDraft(apiLocator, { ...before.api.contract.request, path: "/stale" }, staleSourceApiRevision))
        .rejects.toThrow(/revision|conflict|stale/i);

      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(0);
      expect(session.locateApi(apiLocator)?.api.cases[0]?.name).toBe("saved elsewhere");
      expect(session.locateApi(apiLocator)?.api.contract.request.path).toBe(before.api.contract.request.path);
      expect(await fileStorage.load(temporary.path)).toMatchObject({ workspace: diskAfterOtherSave.workspace, revision: diskAfterOtherSave.revision });
    } finally {
      await temporary.dispose();
    }
  });

  it("rejects a stale legacy full-asset save after a case transaction without writing storage", async () => {
    const temporary = await makeTempRoot();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const counted = countingStorage();
      const session = createSession({ storage: counted.storage });
      await session.open(temporary.path);
      const staleAsset = structuredClone(session.locateApi(apiLocator)!.api);
      const staleRevision = getSourceApiRevision(staleAsset);
      const changedCase = structuredClone(staleAsset.cases[0]!);
      changedCase.name = "newer exact case";
      await session.saveCase({ ...apiLocator, caseId: changedCase.id, scope: changedCase.scope }, changedCase, staleRevision);
      counted.calls.length = 0;

      await expect(session.saveApi(apiLocator, staleAsset, [], undefined, staleRevision)).rejects.toThrow(/source revision conflict/i);

      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(0);
      expect(session.locateApi(apiLocator)?.api.cases[0]?.name).toBe("newer exact case");
      expect(session.locateApi(apiLocator)?.api.contract.request).toEqual(staleAsset.contract.request);
    } finally {
      await temporary.dispose();
    }
  });

  it("rejects a protocol change that conflicts with a saved case override and identifies that case", async () => {
    const temporary = await makeTempRoot();
    try {
      const workspace = makeWorkspace();
      const api = findApi(projectOne(workspace), IDS.sharedApi)!;
      api.cases[0]!.requestOverride = structuredClone(api.contract.request);
      await persistWorkspace(temporary.path, workspace);
      const counted = countingStorage();
      const session = createSession({ storage: counted.storage });
      await session.open(temporary.path);
      const source = session.locateApi(apiLocator)!;
      const expectedSourceApiRevision = getSourceApiRevision(source.api);
      const soapRequest: ApiRequest = {
        protocol: "soap", method: "POST", baseUrl: "https://api.example.test", path: "/items",
        pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, envelope: "<soap/>",
      };
      const diskBefore = await fileStorage.load(temporary.path);

      await expect(session.saveRequestDraft(apiLocator, soapRequest, expectedSourceApiRevision))
        .rejects.toThrow(new RegExp(`caseId.*${source.api.cases[0]!.id}|${source.api.cases[0]!.id}.*scope`));

      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(0);
      expect(session.locateApi(apiLocator)?.api.contract.request.protocol).toBe("http");
      expect(await fileStorage.load(temporary.path)).toMatchObject({ workspace: diskBefore.workspace, revision: diskBefore.revision });
    } finally {
      await temporary.dispose();
    }
  });

  it("keeps the active snapshot and disk unchanged when a storage write fails", async () => {
    const temporary = await makeTempRoot();
    try {
      const initial = makeWorkspace();
      const initialRevision = await persistWorkspace(temporary.path, initial);
      const calls: string[] = [];
      const session = createSession({
        storage: {
          load: (root) => fileStorage.load(root),
          async save(_root, _workspace, options) {
            calls.push(options.expectedRevision);
            throw new Error("simulated storage failure");
          },
        },
      });
      const opened = await session.open(temporary.path);
      const before = session.workspace;
      const activeBefore = observeActiveWorkspaceReference(session);
      const groupBefore = activeBefore.groups.find((group) => group.id === IDS.groupOne)!;
      const projectBefore = groupBefore.projects.find((project) => project.id === IDS.projectOne)!;
      const apiBefore = projectBefore.collections[0].apis[0];
      const watchedFiles = listContractWorkspaceDefinitionFiles(initial)
        .map((file) => join(temporary.path, ...file.split("/")));
      const bytesBefore = await Promise.all(watchedFiles.map((path) => readFile(path)));

      await expect(session.setProjectGlobals(projectLocator, {
        variables: { notCommitted: "value" }, query: [], headers: [], cookies: [], body: [],
      })).rejects.toThrow("simulated storage failure");

      expect(calls).toEqual([initialRevision]);
      expect(session.workspace).toEqual(before);
      expect(session.revision).toBe(opened.revision);
      const activeAfter = observeActiveWorkspaceReference(session);
      expect(activeAfter).toBe(activeBefore);
      expect(activeAfter.groups.find((group) => group.id === IDS.groupOne)).toBe(groupBefore);
      expect(groupBefore.projects.find((project) => project.id === IDS.projectOne)).toBe(projectBefore);
      expect(projectBefore.collections[0].apis[0]).toBe(apiBefore);
      expect(await Promise.all(watchedFiles.map((path) => readFile(path)))).toEqual(bytesBefore);
      expect(await fileStorage.load(temporary.path)).toMatchObject({ workspace: initial, revision: initialRevision });
    } finally {
      await temporary.dispose();
    }
  });

  it("rejects a stale revision without replacing the externally committed workspace", async () => {
    const temporary = await makeTempRoot();
    try {
      const original = makeWorkspace();
      const originalRevision = await persistWorkspace(temporary.path, original);
      const session = createSession();
      await session.open(temporary.path);

      const external = await fileStorage.load(temporary.path);
      external.workspace.name = "external writer";
      const externalCommit = await fileStorage.save(temporary.path, external.workspace, {
        expectedRevision: originalRevision,
        deletions: [],
      });
      const workspaceBytesAfterExternalCommit = await readFile(join(temporary.path, "apicc.workspace.yaml"));
      const apiBytesAfterExternalCommit = await readFile(join(temporary.path, "groups", IDS.groupOne, "projects", IDS.projectOne,
        "collections", IDS.collectionOne, "apis", IDS.sharedApi, "api.yaml"));
      const externalFiles = listContractWorkspaceDefinitionFiles(external.workspace);
      const allBytesAfterExternalCommit = await definitionFileBytes(temporary.path, externalFiles);
      const activeBefore = observeActiveWorkspaceReference(session);
      const groupBefore = activeBefore.groups.find((group) => group.id === IDS.groupOne)!;
      const projectBefore = groupBefore.projects.find((project) => project.id === IDS.projectOne)!;
      const apiBefore = projectBefore.collections[0].apis[0];

      await expect(session.setProjectGlobals(projectLocator, {
        variables: { stale: "must not land" }, query: [], headers: [], cookies: [], body: [],
      })).rejects.toThrow(/revision|conflict|stale/i);

      expect(session.revision).toBe(originalRevision);
      expect(session.workspace).toEqual(original);
      const activeAfter = observeActiveWorkspaceReference(session);
      expect(activeAfter).toBe(activeBefore);
      expect(activeAfter.groups.find((group) => group.id === IDS.groupOne)).toBe(groupBefore);
      expect(groupBefore.projects.find((project) => project.id === IDS.projectOne)).toBe(projectBefore);
      expect(projectBefore.collections[0].apis[0]).toBe(apiBefore);
      expect(await readFile(join(temporary.path, "apicc.workspace.yaml"))).toEqual(workspaceBytesAfterExternalCommit);
      expect(await readFile(join(temporary.path, "groups", IDS.groupOne, "projects", IDS.projectOne,
        "collections", IDS.collectionOne, "apis", IDS.sharedApi, "api.yaml"))).toEqual(apiBytesAfterExternalCommit);
      expect(await definitionFileBytes(temporary.path, externalFiles)).toEqual(allBytesAfterExternalCommit);
      expect(await fileStorage.load(temporary.path)).toMatchObject({
        workspace: { name: "external writer" },
        revision: externalCommit.revision,
      });
    } finally {
      await temporary.dispose();
    }
  });

  it("does not write or alter the loaded snapshot in read-only mode", async () => {
    const temporary = await makeTempRoot();
    try {
      const original = makeWorkspace();
      await persistWorkspace(temporary.path, original);
      const counted = countingStorage({
        async load(root) {
          const loaded = await fileStorage.load(root);
          return { ...loaded, readOnly: true };
        },
        save: (root, workspace, options) => fileStorage.save(root, workspace, options),
      });
      const session = createSession({ storage: counted.storage });
      const opened = await session.open(temporary.path);

      await expect(session.setProjectGlobals(projectLocator, {
        variables: { forbidden: "write" }, query: [], headers: [], cookies: [], body: [],
      })).rejects.toThrow(/read.only|只读/i);

      expect(opened.readOnly).toBe(true);
      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(0);
      expect(session.workspace).toEqual(original);
      expect(await fileStorage.load(temporary.path)).toMatchObject({ workspace: original });
    } finally {
      await temporary.dispose();
    }
  });

  it("treats a malformed API definition as read-only and performs zero writes", async () => {
    const temporary = await makeTempRoot();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const apiFile = join(temporary.path, "groups", IDS.groupOne, "projects", IDS.projectOne,
        "collections", IDS.collectionOne, "apis", IDS.sharedApi, "api.yaml");
      await writeFile(apiFile, `formatVersion: 2\nid: ${IDS.sharedApi}\n`, "utf8");
      const malformedBytes = await readFile(apiFile);
      const counted = countingStorage();
      const session = createSession({ storage: counted.storage });
      const opened = await session.open(temporary.path);

      await expect(session.setProjectGlobals(projectLocator, {
        variables: { forbidden: "malformed workspace" }, query: [], headers: [], cookies: [], body: [],
      })).rejects.toThrow(/read.only|只读/i);

      expect(opened.readOnly).toBe(true);
      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(0);
      expect(await readFile(apiFile)).toEqual(malformedBytes);
    } finally {
      await temporary.dispose();
    }
  });

  it("keeps asset semantic diagnostics writable", async () => {
    const temporary = await makeTempRoot();
    try {
      const workspace = makeWorkspace();
      findApi(projectOne(workspace), IDS.sharedApi)!.contract.request.query = [{
        kind: "componentRef", id: uuid(901), componentId: uuid(903), expectedKind: "parameter",
      }];
      await persistWorkspace(temporary.path, workspace);
      const session = createSession();
      const opened = await session.open(temporary.path);
      expect(opened.readOnly).toBe(false);
      expect(opened.problems.length).toBeGreaterThan(0);

      await session.renameWorkflow({ ...projectLocator, workflowId: IDS.workflow }, "still writable draft");
      expect(session.locateWorkflow({ ...projectLocator, workflowId: IDS.workflow })?.workflow.name)
        .toBe("still writable draft");
    } finally {
      await temporary.dispose();
    }
  });

  it("allows incomplete drafts but gates published APIs against only their design dependency closure", async () => {
    const temporary = await makeTempRoot();
    try {
      const workspace = makeWorkspace();
      const target = findApi(projectOne(workspace), IDS.sharedApi)!;
      const targetRequest = target.contract.request;
      if (targetRequest.protocol !== "http") throw new Error("Fixture API protocol changed");
      targetRequest.body = { kind: "json", content: "{}", schema: { kind: "scalar", type: "string" } };
      target.contract.responses = [{
        kind: "componentRef", id: uuid(903), componentId: uuid(904), expectedKind: "response",
      }];
      const unrelated = findApi(projectOne(workspace), IDS.secondApi)!;
      const unrelatedRequest = unrelated.contract.request;
      if (unrelatedRequest.protocol !== "http") throw new Error("Fixture API protocol changed");
      unrelatedRequest.body = { kind: "json", content: "{}", schema: { kind: "modelRef", modelId: uuid(905) } };
      await persistWorkspace(temporary.path, workspace);

      const counted = countingStorage();
      const session = createSession({ storage: counted.storage });
      await session.open(temporary.path);
      expect(session.readOnly).toBe(false);

      const draft = structuredClone(session.locateApi(apiLocator)!.api);
      draft.contract.metadata.status = "draft";
      await session.saveApi(apiLocator, draft);
      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(1);

      const revisionBeforePublish = session.revision;
      const activeBeforePublish = observeActiveWorkspaceReference(session);
      const files = listContractWorkspaceDefinitionFiles(session.workspace!);
      const bytesBeforePublish = await definitionFileBytes(temporary.path, files);
      const published = structuredClone(session.locateApi(apiLocator)!.api);
      published.contract.metadata.status = "published";

      await expect(session.saveApi(apiLocator, published)).rejects.toThrow(/API_PUBLISH_GATE_FAILED: ASSET_REFERENCE_MISSING .*contract\.responses\[0\]\.componentId/);

      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(1);
      expect(session.revision).toBe(revisionBeforePublish);
      expect(observeActiveWorkspaceReference(session)).toBe(activeBeforePublish);
      expect(await definitionFileBytes(temporary.path, files)).toEqual(bytesBeforePublish);
      expect(session.locateApi(apiLocator)?.api.contract.metadata.status).toBe("draft");

      published.contract.responses = [{
        kind: "componentRef", id: uuid(906), componentId: IDS.response, expectedKind: "response",
      }];
      await expect(session.saveApi(apiLocator, published)).resolves.toMatchObject({
        api: { contract: { metadata: { status: "published" } } },
      });
      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(2);
      expect(session.locateApi(apiLocator)?.api.contract.metadata.status).toBe("published");
    } finally {
      await temporary.dispose();
    }
  });

  it("keeps API-and-logical-case workflow checks scoped to the exact project and API pair", async () => {
    const temporary = await makeTempRoot();
    try {
      const workspace = makeWorkspace();
      projectOne(workspace).workflows[0].nodes[0] = {
        id: IDS.workflowNode, kind: "request", apiId: IDS.secondApi, caseId: IDS.sharedCase,
      };
      projectTwo(workspace).workflows = [{
        id: uuid(970), name: "other project caller", status: "draft",
        nodes: [{ id: uuid(971), kind: "request", apiId: IDS.sharedApi, caseId: IDS.sharedCase }], edges: [],
      }];
      await persistWorkspace(temporary.path, workspace);
      const session = createSession();
      await session.open(temporary.path);

      await session.deleteCase({ ...apiLocator, caseId: IDS.sharedCase, scope: "blue" });
      await session.deleteCase({ ...apiLocator, caseId: IDS.sharedCase, scope: "green" });

      expect(session.locateApi(apiLocator)?.api.cases).toHaveLength(0);
      expect(session.locateWorkflow({ ...projectLocator, workflowId: IDS.workflow })?.workflow.nodes[0].apiId)
        .toBe(IDS.secondApi);
      expect(session.workspace!.groups.find((group) => group.id === IDS.groupTwo)!.projects[0].workflows)
        .toHaveLength(1);
    } finally {
      await temporary.dispose();
    }
  });

  it("saves the complete ApiAsset and removes only its explicitly omitted case version", async () => {
    const temporary = await makeTempRoot();
    try {
      const initial = makeWorkspace();
      await persistWorkspace(temporary.path, initial);
      const counted = countingStorage();
      const session = createSession({ storage: counted.storage });
      await session.open(temporary.path);
      const input = structuredClone(session.locateApi(apiLocator)!.api);
      input.contract.request.path = "/saved-api";
      input.documentation = "# saved design";
      input.cases = input.cases.filter((testCase) => testCase.scope !== "blue");

      const saved = await session.saveApi(apiLocator, input);

      expect(saved.api.contract.request.path).toBe("/saved-api");
      expect(saved.api.documentation).toBe("# saved design");
      expect(saved.api.cases.map((testCase) => testCase.scope)).toEqual(["green"]);
      expect(saved.sourceApiRevision).toBe(getSourceApiRevision(saved.api));
      expect(counted.calls.at(-1)?.deletions).toEqual([
        `groups/${IDS.groupOne}/projects/${IDS.projectOne}/collections/${IDS.collectionOne}/apis/${IDS.sharedApi}/cases/${Buffer.from(IDS.sharedCase).toString("hex")}.626c7565.yaml`,
      ]);

      const reopened = createSession();
      await reopened.open(temporary.path);
      const expectedWorkspace = structuredClone(initial);
      const expectedApi = findApi(projectOne(expectedWorkspace), IDS.sharedApi)!;
      expectedApi.contract.request.path = "/saved-api";
      expectedApi.documentation = "# saved design";
      expectedApi.cases = expectedApi.cases.filter((testCase) => testCase.scope !== "blue");
      expect(reopened.workspace).toEqual(expectedWorkspace);
    } finally {
      await temporary.dispose();
    }
  });

  it("rejects an API with a surviving workflow caller and deletes only known API/folder files", async () => {
    const temporary = await makeTempRoot();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const counted = countingStorage();
      const session = createSession({ storage: counted.storage });
      await session.open(temporary.path);
      await expect(session.deleteNode({ kind: "api", locator: apiLocator })).rejects.toThrow(/workflow callers/i);
      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(0);

      const noCalls = makeWorkspace();
      projectOne(noCalls).workflows = [];
      const separate = await makeTempRoot();
      try {
        await persistWorkspace(separate.path, noCalls);
        const apiCounted = countingStorage();
        const deleting = createSession({ storage: apiCounted.storage });
        await deleting.open(separate.path);
        await deleting.deleteNode({ kind: "api", locator: apiLocator });
        const reloaded = await fileStorage.load(separate.path);
        expect(findApi(projectOne(reloaded.workspace), IDS.sharedApi)).toBeUndefined();
        const apiDeletes = apiCounted.calls.at(-1)?.deletions ?? [];
        expect(apiDeletes).toHaveLength(5);
        expect(apiDeletes).toEqual(expect.arrayContaining([
          `groups/${IDS.groupOne}/projects/${IDS.projectOne}/collections/${IDS.collectionOne}/apis/${IDS.sharedApi}/api.yaml`,
          `groups/${IDS.groupOne}/projects/${IDS.projectOne}/collections/${IDS.collectionOne}/apis/${IDS.sharedApi}/design.md`,
          `groups/${IDS.groupOne}/projects/${IDS.projectOne}/collections/${IDS.collectionOne}/apis/${IDS.sharedApi}/cases/index.yaml`,
        ]));

        const nestedBefore = await fileStorage.load(separate.path);
        const folderCounted = countingStorage();
        const nestedSession = createSession({ storage: folderCounted.storage });
        await nestedSession.open(separate.path);
        await nestedSession.deleteNode({ kind: "folder", locator: {
          workspaceId: IDS.workspace,
          groupId: IDS.groupOne,
          projectId: IDS.projectOne,
          collectionId: IDS.collectionOne,
          folderIds: [IDS.folderOne],
        } });
        const expectedDeepDesign = `groups/${IDS.groupOne}/projects/${IDS.projectOne}/collections/${IDS.collectionOne}/folders/${IDS.folderOne}/folders/${IDS.folderTwo}/apis/${IDS.deepApi}/design.md`;
        expect(listContractWorkspaceDefinitionFiles(nestedBefore.workspace)).toContain(expectedDeepDesign);
        const folderDeletes = folderCounted.calls.at(-1)?.deletions ?? [];
        expect(folderDeletes).toHaveLength(6);
        expect(folderDeletes).toEqual(expect.arrayContaining([
          `groups/${IDS.groupOne}/projects/${IDS.projectOne}/collections/${IDS.collectionOne}/folders/${IDS.folderOne}/folder.yaml`,
          `groups/${IDS.groupOne}/projects/${IDS.projectOne}/collections/${IDS.collectionOne}/folders/${IDS.folderOne}/folders/${IDS.folderTwo}/folder.yaml`,
          expectedDeepDesign,
        ]));
        expect(nestedSession.workspace!.groups.find((group) => group.id === IDS.groupOne)!.projects[0].collections[0].folders)
          .toHaveLength(0);
      } finally {
        await separate.dispose();
      }
    } finally {
      await temporary.dispose();
    }
  });

  it("returns stable Core reference diagnostics and refuses model or component deletion while referenced", async () => {
    const temporary = await makeTempRoot();
    try {
      const workspace = makeWorkspace();
      const api = findApi(projectOne(workspace), IDS.sharedApi)!;
      api.contract.request.query = [{
        kind: "componentRef", id: uuid(980), componentId: IDS.parameter, expectedKind: "parameter",
      }];
      if (api.contract.request.protocol !== "http") throw new Error("Fixture API protocol changed");
      api.contract.request.body = { kind: "json", content: "{}", schema: { kind: "modelRef", modelId: IDS.model } };
      await persistWorkspace(temporary.path, workspace);
      const session = createSession();
      await session.open(temporary.path);

      expect(session.referencesTo(projectLocator, IDS.parameter)).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "ASSET_REFERENCE", targetId: IDS.parameter, path: expect.stringContaining("query") }),
      ]));
      expect(session.referencesTo(projectLocator, IDS.model)).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "ASSET_REFERENCE", targetId: IDS.model, path: expect.stringContaining("body") }),
      ]));
      await expect(session.deleteNode({ kind: "component", locator: { ...projectLocator, componentKind: "parameter", componentId: IDS.parameter } }))
        .rejects.toThrow(/referenced/i);
      await expect(session.deleteNode({ kind: "model", locator: { ...projectLocator, modelId: IDS.model } }))
        .rejects.toThrow(/referenced/i);
      expect(session.listComponents(projectLocator).some((component) => component.id === IDS.parameter)).toBe(true);
      expect(session.listModels(projectLocator).some((model) => model.id === IDS.model)).toBe(true);
    } finally {
      await temporary.dispose();
    }
  });

  it("deletes only the explicitly targeted case file and preserves unknown files below its API", async () => {
    const temporary = await makeTempRoot();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const unknownDirectory = join(temporary.path, ".apicc", "user-data");
      const unknownPath = join(unknownDirectory, "custom.keep");
      const counted = countingStorage();
      const session = createSession({ storage: counted.storage });
      await session.open(temporary.path);
      await mkdir(unknownDirectory, { recursive: true });
      await writeFile(unknownPath, "preserve me", "utf8");

      await session.deleteCase({ ...apiLocator, caseId: IDS.sharedCase, scope: "blue" });

      const deleted = counted.calls.at(-1)?.deletions;
      expect(deleted).toEqual(expect.arrayContaining([
        `groups/${IDS.groupOne}/projects/${IDS.projectOne}/collections/${IDS.collectionOne}/apis/${IDS.sharedApi}/cases/${Buffer.from(IDS.sharedCase).toString("hex")}.626c7565.yaml`,
      ]));
      expect(deleted).toHaveLength(1);
      expect(await readFile(unknownPath, "utf8")).toBe("preserve me");
      expect(projectOne((await fileStorage.load(temporary.path)).workspace).collections[0].apis[0].cases)
        .toHaveLength(1);
    } finally {
      await temporary.dispose();
    }
  });

  it("serializes a pending write with root switching and rejects a queued old-workspace locator", async () => {
    const firstRoot = await makeTempRoot();
    const secondRoot = await makeTempRoot();
    try {
      await persistWorkspace(firstRoot.path, makeWorkspace());
      const secondWorkspace = makeWorkspace();
      secondWorkspace.id = uuid(902);
      secondWorkspace.name = "second workspace";
      await persistWorkspace(secondRoot.path, secondWorkspace);

      let announceSave!: () => void;
      const saveEntered = new Promise<void>((resolveSave) => { announceSave = resolveSave; });
      let releaseSave!: () => void;
      const saveGate = new Promise<void>((resolveSave) => { releaseSave = resolveSave; });
      let held = false;
      const session = createSession({
        storage: {
          load: (root) => fileStorage.load(root),
          async save(root, workspace, saveOptions) {
            const saved = await fileStorage.save(root, workspace, saveOptions);
            if (root === firstRoot.path && !held) {
              held = true;
              announceSave();
              await saveGate;
            }
            return saved;
          },
        },
      });
      await session.open(firstRoot.path);
      const oldWorkspaceWrite = session.setProjectGlobals(projectLocator, {
        variables: { beforeSwitch: "saved" }, query: [], headers: [], cookies: [], body: [],
      });
      await saveEntered;
      const secondOpen = session.open(secondRoot.path);
      releaseSave();
      await oldWorkspaceWrite;
      const openedSecond = await secondOpen;

      expect(session.root).toBe(secondRoot.path);
      expect(openedSecond.workspace.id).toBe(uuid(902));
      await expect(session.setProjectGlobals(projectLocator, {
        variables: { stale: "wrong root" }, query: [], headers: [], cookies: [], body: [],
      })).rejects.toThrow(/workspace mismatch/i);
    } finally {
      await firstRoot.dispose();
      await secondRoot.dispose();
    }
  });

  it("queues validate after a pending open and returns problems for the newly active root", async () => {
    const temporary = await makeTempRoot();
    try {
      const rootA = join(temporary.path, "root-a");
      const rootB = join(temporary.path, "root-b");
      const workspaceA = makeWorkspace();
      const workspaceB = makeWorkspace();
      workspaceB.id = uuid(1002);
      const events: string[] = [];
      let bLoads = 0;
      let announceBLoad!: () => void;
      const bLoadEntered = new Promise<void>((resolveBLoad) => { announceBLoad = resolveBLoad; });
      let releaseBLoad!: () => void;
      const bLoadGate = new Promise<void>((resolveBLoad) => { releaseBLoad = resolveBLoad; });
      const session = createSession({ storage: {
        async load(root) {
          if (root === rootA) {
            events.push("load:A");
            return { workspace: workspaceA, problems: [{ file: "A", message: "root A" }], readOnly: false, revision: "revision-A" };
          }
          bLoads += 1;
          if (bLoads === 1) {
            events.push("open:B:start");
            announceBLoad();
            await bLoadGate;
            events.push("open:B:end");
          } else events.push("validate:B");
          return { workspace: workspaceB, problems: [{ file: "B", message: "root B" }], readOnly: false, revision: "revision-B" };
        },
        async save() { return { revision: "revision-saved" }; },
      } });
      await session.open(rootA);
      events.length = 0;

      const opening = session.open(rootB);
      const validating = session.validate();
      await bLoadEntered;
      releaseBLoad();
      const [opened, problems] = await Promise.all([opening, validating]);

      expect(events).toEqual(["open:B:start", "open:B:end", "validate:B"]);
      expect(opened.workspace.id).toBe(workspaceB.id);
      expect(problems).toEqual([{ file: "B", message: "root B" }]);
      expect(session.root).toBe(rootB);
    } finally {
      await temporary.dispose();
    }
  });

  it("queues validate behind an in-flight write and observes its committed revision", async () => {
    const temporary = await makeTempRoot();
    try {
      const initial = makeWorkspace();
      const initialRevision = await persistWorkspace(temporary.path, initial);
      let storedWorkspace = structuredClone(initial);
      let storedRevision = initialRevision;
      const events: string[] = [];
      let announceSave!: () => void;
      const saveEntered = new Promise<void>((resolveSave) => { announceSave = resolveSave; });
      let releaseSave!: () => void;
      const saveGate = new Promise<void>((resolveSave) => { releaseSave = resolveSave; });
      const session = createSession({ storage: {
        async load() {
          events.push(`load:${storedRevision}`);
          return { workspace: structuredClone(storedWorkspace), problems: [{ file: storedRevision, message: "revision snapshot" }], readOnly: false, revision: storedRevision };
        },
        async save(_root, workspace, options) {
          events.push(`save:start:${options.expectedRevision}`);
          announceSave();
          await saveGate;
          storedWorkspace = structuredClone(workspace);
          storedRevision = "revision-after-write";
          events.push("save:finish");
          return { revision: storedRevision };
        },
      } });
      await session.open(temporary.path);
      events.length = 0;

      const writing = session.setProjectGlobals(projectLocator, {
        variables: { committed: "yes" }, query: [], headers: [], cookies: [], body: [],
      });
      const validating = session.validate();
      await saveEntered;
      releaseSave();
      const [, problems] = await Promise.all([writing, validating]);

      expect(events).toEqual([`save:start:${initialRevision}`, "save:finish", "load:revision-after-write"]);
      expect(problems).toEqual([{ file: "revision-after-write", message: "revision snapshot" }]);
      expect(session.revision).toBe("revision-after-write");
    } finally {
      await temporary.dispose();
    }
  });

  it("serializes simultaneous writes and uses the newly committed revision for the second command", async () => {
    const temporary = await makeTempRoot();
    try {
      const initial = makeWorkspace();
      const initialRevision = await persistWorkspace(temporary.path, initial);
      const counted = countingStorage();
      const session = createSession({ storage: counted.storage });
      await session.open(temporary.path);

      await Promise.all([
        session.setProjectGlobals(projectLocator, {
          variables: { concurrent: "globals" }, query: [], headers: [], cookies: [], body: [],
        }),
        session.setEnvironmentVariables({ ...projectLocator, environmentId: IDS.environment }, { concurrent: "environment" }),
      ]);

      const saves = counted.calls.filter((call) => call.kind === "save");
      expect(saves).toHaveLength(2);
      expect(saves[0].expectedRevision).toBe(initialRevision);
      expect(saves[1].expectedRevision).not.toBe(initialRevision);
      const reopened = createSession();
      await reopened.open(temporary.path);
      expect(reopened.getProjectGlobals(projectLocator).variables.concurrent).toBe("globals");
      expect(reopened.locateEnvironment({ ...projectLocator, environmentId: IDS.environment })?.environment.variables.concurrent)
        .toBe("environment");
      const expectedWorkspace = structuredClone(initial);
      projectOne(expectedWorkspace).variables = { concurrent: "globals" };
      projectOne(expectedWorkspace).environments[0].variables.concurrent = "environment";
      expect(reopened.workspace).toEqual(expectedWorkspace);
    } finally {
      await temporary.dispose();
    }
  });

  it("rejects an old-workspace locator queued behind open without saving into the new root", async () => {
    const firstRoot = await makeTempRoot();
    const secondRoot = await makeTempRoot();
    let releaseSaveGate: (() => void) | undefined;
    try {
      await persistWorkspace(firstRoot.path, makeWorkspace());
      const secondWorkspace = makeWorkspace();
      secondWorkspace.id = uuid(1102);
      const secondRevision = await persistWorkspace(secondRoot.path, secondWorkspace);
      const saveRoots: string[] = [];
      let announceSave!: () => void;
      const saveEntered = new Promise<void>((resolveSave) => { announceSave = resolveSave; });
      let releaseSave!: () => void;
      const saveGate = new Promise<void>((resolveSave) => { releaseSave = resolveSave; });
      releaseSaveGate = releaseSave;
      let held = false;
      const session = createSession({ storage: {
        load: (root) => fileStorage.load(root),
        async save(root, workspace, options) {
          saveRoots.push(root);
          const result = await fileStorage.save(root, workspace, options);
          if (root === firstRoot.path && !held) {
            held = true;
            announceSave();
            await saveGate;
          }
          return result;
        },
      } });
      await session.open(firstRoot.path);

      const firstWrite = session.setProjectGlobals(projectLocator, {
        variables: { firstRoot: "committed" }, query: [], headers: [], cookies: [], body: [],
      });
      await saveEntered;
      const openingSecondRoot = session.open(secondRoot.path);
      const queuedOldLocator = session.setProjectGlobals(projectLocator, {
        variables: { mustNotSave: "wrong root" }, query: [], headers: [], cookies: [], body: [],
      });
      releaseSave();
      await firstWrite;
      await openingSecondRoot;
      await expect(queuedOldLocator).rejects.toThrow(/workspace mismatch/i);

      expect(session.root).toBe(secondRoot.path);
      expect(session.revision).toBe(secondRevision);
      expect(saveRoots).toEqual([firstRoot.path]);
      expect(session.workspace).toEqual(secondWorkspace);
      expect(await fileStorage.load(secondRoot.path)).toMatchObject({ workspace: secondWorkspace, revision: secondRevision });
    } finally {
      releaseSaveGate?.();
      await firstRoot.dispose();
      await secondRoot.dispose();
    }
  });

  it("moves a project without changing non-secret identities, rotates every secret ref, and skips same-group writes", async () => {
    const temporary = await makeTempRoot();
    try {
      const workspace = makeWorkspace();
      const sourceBefore = structuredClone(projectOne(workspace));
      await persistWorkspace(temporary.path, workspace);
      const counted = countingStorage();
      const session = createSession({ storage: counted.storage });
      await session.open(temporary.path);
      const source = projectLocator;
      const sameGroup = { workspaceId: IDS.workspace, groupId: IDS.groupOne };
      const target = { workspaceId: IDS.workspace, groupId: IDS.groupTwo };

      await session.moveProject(source, sameGroup);
      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(0);
      expect(projectOne(session.workspace!).id).toBe(sourceBefore.id);

      await session.moveProject(source, target);
      const moved = session.workspace!.groups.find((group) => group.id === IDS.groupTwo)!.projects
        .find((project) => project.id === IDS.projectOne)!;
      const movedApi = findApi(moved, IDS.sharedApi)!;
      const movedAuth = moved.components.find((item) => item.id === IDS.auth);
      const movedUnusedAuth = moved.components.find((item) => item.id === IDS.unusedAuth);
      expect(moved.id).toBe(sourceBefore.id);
      expect(movedApi.contract.id).toBe(findApi(sourceBefore, IDS.sharedApi)!.contract.id);
      expect(movedApi.contract.request.auth).toMatchObject({ kind: "bearer", token: { policy: "credential-alias" } });
      expect(movedAuth).toMatchObject({ id: IDS.auth, kind: "auth", definition: { kind: "bearer", token: { policy: "credential-alias" } } });
      expect(movedUnusedAuth).toMatchObject({ id: IDS.unusedAuth, kind: "auth", definition: { kind: "apikey", value: { policy: "separate-alias" } } });
      if (movedApi.contract.request.auth.kind !== "bearer" || movedAuth?.kind !== "auth" || movedAuth.definition.kind !== "bearer"
        || movedUnusedAuth?.kind !== "auth" || movedUnusedAuth.definition.kind !== "apikey") throw new Error("Fixture auth definitions changed shape");
      expect(movedApi.contract.request.auth.token.id).not.toBe("shared-secret-ref");
      expect(movedAuth.definition.token.id).toBe(movedApi.contract.request.auth.token.id);
      expect(movedUnusedAuth.definition.value.id).not.toBe("unused-secret-ref");
      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(1);
      expect(counted.calls.at(-1)?.deletions).toEqual(expect.arrayContaining([
        `groups/${IDS.groupOne}/projects/${IDS.projectOne}/project.yaml`,
      ]));

      const reopened = createSession();
      await reopened.open(temporary.path);
      const reopenedMoved = reopened.workspace!.groups.find((group) => group.id === IDS.groupTwo)!.projects
        .find((project) => project.id === IDS.projectOne)!;
      expect(findApi(reopenedMoved, IDS.sharedApi)?.contract.id).toBe(movedApi.contract.id);
    } finally {
      await temporary.dispose();
    }
  });

  it("aborts a move when rotated secret refs collide with another project's known refs", async () => {
    const temporary = await makeTempRoot();
    try {
      const workspace = makeWorkspace();
      findApi(projectTwo(workspace), IDS.sharedApi)!.contract.request.auth = {
        kind: "bearer", token: { id: "collision-secret", policy: "external-alias" },
      };
      await persistWorkspace(temporary.path, workspace);
      const before = await fileStorage.load(temporary.path);
      const counted = countingStorage();
      const session = createSession({
        storage: counted.storage,
        newId: (kind) => kind === "secretRef" ? "collision-secret" : uuid(950),
      });
      await session.open(temporary.path);

      await expect(session.moveProject(projectLocator, { workspaceId: IDS.workspace, groupId: IDS.groupTwo }))
        .rejects.toThrow(/secret reference collision/i);

      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(0);
      expect(session.workspace).toEqual(before.workspace);
      expect(await fileStorage.load(temporary.path)).toMatchObject({ workspace: before.workspace, revision: before.revision });
    } finally {
      await temporary.dispose();
    }
  });

  it("rejects a cross-group move when the target already owns the same project identity", async () => {
    const temporary = await makeTempRoot();
    try {
      const workspace = makeWorkspace();
      projectTwo(workspace).id = IDS.projectOne;
      await persistWorkspace(temporary.path, workspace);
      const before = await fileStorage.load(temporary.path);
      const counted = countingStorage();
      const session = createSession({ storage: counted.storage });
      await session.open(temporary.path);

      await expect(session.moveProject(projectLocator, { workspaceId: IDS.workspace, groupId: IDS.groupTwo }))
        .rejects.toThrow(/target project identity collision/i);

      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(0);
      expect(session.workspace).toEqual(before.workspace);
      expect(await fileStorage.load(temporary.path)).toMatchObject({ workspace: before.workspace, revision: before.revision });
    } finally {
      await temporary.dispose();
    }
  });

  it("preserves both groups, nested identities, revision, and definition bytes for move factory, validation, and storage failures", async () => {
    const modes = ["factory", "candidate-schema", "storage-save"] as const;
    for (const mode of modes) {
      const temporary = await makeTempRoot();
      let schemaSpy: ReturnType<typeof vi.spyOn> | undefined;
      try {
        const workspace = makeWorkspace();
        await persistWorkspace(temporary.path, workspace);
        const before = await fileStorage.load(temporary.path);
        const files = listContractWorkspaceDefinitionFiles(before.workspace);
        const bytesBefore = await definitionFileBytes(temporary.path, files);
        const storageCalls: Array<{ root: string; expectedRevision: string }> = [];
        const storage = {
          load: (root: string) => fileStorage.load(root),
          async save(root: string, candidate: ContractWorkspace, options: { expectedRevision: string; deletions: readonly string[] }) {
            storageCalls.push({ root, expectedRevision: options.expectedRevision });
            if (mode === "storage-save") {
              return fileStorage.save(root, candidate, { ...options, expectedRevision: "deliberately-stale-revision" });
            }
            return fileStorage.save(root, candidate, options);
          },
        };
        let generatedId = 1800;
        const session = createSession({
          storage,
          newId(kind) {
            if (mode === "factory" && kind === "secretRef") throw new Error("simulated move ID factory failure");
            return uuid(generatedId++);
          },
        });
        await session.open(temporary.path);
        const activeBefore = observeActiveWorkspaceReference(session);
        const sourceGroupBefore = activeBefore.groups.find((group) => group.id === IDS.groupOne)!;
        const targetGroupBefore = activeBefore.groups.find((group) => group.id === IDS.groupTwo)!;
        const sourceProjectBefore = sourceGroupBefore.projects.find((project) => project.id === IDS.projectOne)!;
        const targetProjectBefore = targetGroupBefore.projects.find((project) => project.id === IDS.projectTwo)!;
        const sourceApiBefore = sourceProjectBefore.collections[0].apis[0];
        const revisionBefore = session.revision;

        if (mode === "candidate-schema") {
          schemaSpy = vi.spyOn(ContractWorkspaceSchema, "parse").mockImplementationOnce(() => {
            throw new Error("simulated candidate workspace schema failure");
          });
        }
        const message = mode === "factory"
          ? /move ID factory failure/
          : mode === "candidate-schema"
            ? /candidate workspace schema failure/
            : /revision|conflict|stale/i;
        await expect(session.moveProject(projectLocator, { workspaceId: IDS.workspace, groupId: IDS.groupTwo }))
          .rejects.toThrow(message);
        schemaSpy?.mockRestore();
        schemaSpy = undefined;

        expect(storageCalls).toHaveLength(mode === "storage-save" ? 1 : 0);
        expect(session.revision).toBe(revisionBefore);
        expect(session.workspace).toEqual(before.workspace);
        const activeAfter = observeActiveWorkspaceReference(session);
        expect(activeAfter).toBe(activeBefore);
        expect(activeAfter.groups.find((group) => group.id === IDS.groupOne)).toBe(sourceGroupBefore);
        expect(activeAfter.groups.find((group) => group.id === IDS.groupTwo)).toBe(targetGroupBefore);
        expect(sourceGroupBefore.projects.find((project) => project.id === IDS.projectOne)).toBe(sourceProjectBefore);
        expect(targetGroupBefore.projects.find((project) => project.id === IDS.projectTwo)).toBe(targetProjectBefore);
        expect(sourceProjectBefore.collections[0].apis[0]).toBe(sourceApiBefore);
        expect(await definitionFileBytes(temporary.path, files)).toEqual(bytesBefore);
        expect(await fileStorage.load(temporary.path)).toMatchObject({ workspace: before.workspace, revision: before.revision });
      } finally {
        schemaSpy?.mockRestore();
        await temporary.dispose();
      }
    }
  });

  it("imports a module preview whose project ID equals the active target and reopens the complete remapped closure", async () => {
    const temporary = await makeTempRoot();
    try {
      const workspace = makeWorkspace();
      await persistWorkspace(temporary.path, workspace);
      const session = createSession();
      await session.open(temporary.path);

      const preview = projectOne(makeWorkspace());
      preview.id = IDS.projectTwo;
      const previewApi = findApi(preview, IDS.sharedApi)!;
      previewApi.contract.request.headers = [{
        kind: "componentRef", id: uuid(1201), componentId: IDS.parameter, expectedKind: "parameter",
      }];
      previewApi.contract.request.auth = { kind: "componentRef", componentId: IDS.auth, expectedKind: "auth" };
      if (previewApi.contract.request.protocol !== "http") throw new Error("Preview request must use HTTP");
      previewApi.contract.request.body = { kind: "json", content: "{}", schema: { kind: "modelRef", modelId: IDS.model } };
      previewApi.contract.responses = [{
        kind: "componentRef", id: uuid(1202), componentId: IDS.response, expectedKind: "response",
      }];
      const previewParameter = preview.components.find((item) => item.id === IDS.parameter);
      if (!previewParameter || previewParameter.kind !== "parameter") throw new Error("Preview parameter missing");
      previewParameter.definition.schema = { kind: "modelRef", modelId: IDS.model };
      const previewResponse = preview.components.find((item) => item.id === IDS.response);
      if (!previewResponse || previewResponse.kind !== "response") throw new Error("Preview response missing");
      previewResponse.definition.content = {
        "application/json": {
          schema: { kind: "modelRef", modelId: IDS.model },
          examples: [{ kind: "componentRef", id: uuid(1203), componentId: IDS.example, expectedKind: "example" }],
        },
      };
      const previewBefore = structuredClone(preview);
      const originalTarget = structuredClone(projectTwo(workspace));
      const targetLocator = { workspaceId: IDS.workspace, groupId: IDS.groupTwo, projectId: IDS.projectTwo };

      const importedCollections = await session.importModuleToProject(targetLocator, "same-ID preview", { project: preview });

      expect(importedCollections).toHaveLength(preview.collections.length);
      expect(preview).toEqual(previewBefore);
      const reopened = createSession();
      const opened = await reopened.open(temporary.path);
      expect(opened.readOnly).toBe(false);
      const importedTarget = projectTwo(reopened.workspace!);
      expect(importedTarget.id).toBe(IDS.projectTwo);
      expect(importedTarget.collections[0]).toEqual(originalTarget.collections[0]);
      const importedApis = importedTarget.collections.slice(1).flatMap((collection) => {
        const assets = [...collection.apis];
        const visit = (folders: typeof collection.folders): void => {
          for (const folder of folders) {
            assets.push(...folder.apis);
            visit(folder.folders);
          }
        };
        visit(collection.folders);
        return assets;
      });
      const sourceAssetIds = new Set([IDS.sharedApi, IDS.deepApi, IDS.secondApi]);
      expect(importedApis).toHaveLength(3);
      expect(importedApis.every((api) => !sourceAssetIds.has(api.contract.id))).toBe(true);
      expect(importedTarget.models.map((model) => model.name)).toContain("Payload");
      expect(importedTarget.components.map((component) => component.kind)).toEqual(expect.arrayContaining([
        "parameter", "auth", "response", "example",
      ]));
      const sourceAuth = preview.components.find((component) => component.id === IDS.auth);
      const importedAuth = importedTarget.components.find((component) => component.name === "saved auth");
      const importedSharedApi = importedApis.find((api) => api.contract.metadata.name === "project one API");
      if (!sourceAuth || sourceAuth.kind !== "auth" || sourceAuth.definition.kind !== "bearer"
        || !importedAuth || importedAuth.kind !== "auth" || importedAuth.definition.kind !== "bearer"
        || !importedSharedApi) {
        throw new Error("The imported closure is missing its aliased auth reference");
      }
      expect(importedAuth.definition.token.policy).toBe(sourceAuth.definition.token.policy);
      expect(importedAuth.definition.token.id).not.toBe(sourceAuth.definition.token.id);
      expect(importedSharedApi.contract.request.auth).toEqual({
        kind: "componentRef", componentId: importedAuth.id, expectedKind: "auth",
      });
      expect(createProjectAssetContext({
        projectId: importedTarget.id, assets: importedApis, models: importedTarget.models, components: importedTarget.components,
      }).diagnostics).toEqual([]);
    } finally {
      await temporary.dispose();
    }
  });

  it("rejects a module asset identity collision before saving or changing its preview", async () => {
    const temporary = await makeTempRoot();
    try {
      const workspace = makeWorkspace();
      await persistWorkspace(temporary.path, workspace);
      const before = await fileStorage.load(temporary.path);
      let generated = 1300;
      const counted = countingStorage();
      const session = createSession({
        storage: counted.storage,
        newId(kind) {
          if (kind === "model") return IDS.projectTwo;
          return uuid(generated++);
        },
      });
      await session.open(temporary.path);
      const preview = projectOne(makeWorkspace());
      const api = findApi(preview, IDS.sharedApi)!;
      if (api.contract.request.protocol !== "http") throw new Error("Preview request must use HTTP");
      api.contract.request.body = { kind: "json", content: "{}", schema: { kind: "modelRef", modelId: IDS.model } };
      const previewBefore = structuredClone(preview);
      const activeBefore = observeActiveWorkspaceReference(session);
      const revisionBefore = session.revision;
      const files = listContractWorkspaceDefinitionFiles(before.workspace);
      const bytesBefore = await definitionFileBytes(temporary.path, files);

      await expect(session.importModuleToProject({ ...projectLocator, groupId: IDS.groupTwo, projectId: IDS.projectTwo }, "collision", { project: preview }))
        .rejects.toThrow(/identity collision/i);

      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(0);
      expect(session.revision).toBe(revisionBefore);
      expect(observeActiveWorkspaceReference(session)).toBe(activeBefore);
      expect(session.workspace).toEqual(before.workspace);
      expect(preview).toEqual(previewBefore);
      expect(await definitionFileBytes(temporary.path, files)).toEqual(bytesBefore);
      expect(await fileStorage.load(temporary.path)).toMatchObject({ workspace: before.workspace, revision: before.revision });
    } finally {
      await temporary.dispose();
    }
  });

  it("imports equal per-collection environment mappings regardless of preview order", async () => {
    const temporary = await makeTempRoot();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const session = createSession();
      await session.open(temporary.path);
      const preview = projectOne(makeWorkspace());
      preview.environments = [
        {
          id: uuid(1401), name: "dev", variables: { baseUrl: "https://dev-default.example.test" },
          baseUrls: {
            [IDS.collectionOne]: "https://shared-one.example.test",
            [IDS.secondCollection]: "https://shared-two.example.test",
          },
        },
        {
          id: uuid(1402), name: "qa", extends: "dev", variables: { baseUrl: "https://qa-default.example.test" },
          baseUrls: {},
        },
      ];
      const previewBefore = structuredClone(preview);
      const reversedPreview = structuredClone(preview);
      reversedPreview.environments.reverse();
      const targetLocator = { workspaceId: IDS.workspace, groupId: IDS.groupTwo, projectId: IDS.projectTwo };

      const normalOrder = await session.importModuleToProject(targetLocator, "normal order", { project: preview });
      const reverseOrder = await session.importModuleToProject(targetLocator, "reverse order", { project: reversedPreview });

      expect(normalOrder.map((collection) => collection.variables.baseUrl)).toEqual([
        "https://shared-one.example.test", "https://shared-two.example.test",
      ]);
      expect(reverseOrder.map((collection) => collection.variables.baseUrl)).toEqual(normalOrder.map((collection) => collection.variables.baseUrl));
      expect(preview).toEqual(previewBefore);
      const reopened = createSession();
      await reopened.open(temporary.path);
      const target = projectTwo(reopened.workspace!);
      const imported = target.collections.filter((collection) => collection.name === "normal order" || collection.name === "reverse order");
      expect(imported).toHaveLength(4);
      expect(imported.map((collection) => collection.variables.baseUrl)).toEqual([
        "https://shared-one.example.test", "https://shared-two.example.test",
        "https://shared-one.example.test", "https://shared-two.example.test",
      ]);
      expect(target.environments).toHaveLength(0);
      expect(target.workflows).toHaveLength(0);
    } finally {
      await temporary.dispose();
    }
  });

  it("uses Core environment inheritance for fallback and preserves original collection fallback", async () => {
    const temporary = await makeTempRoot();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const session = createSession();
      await session.open(temporary.path);
      const targetLocator = { workspaceId: IDS.workspace, groupId: IDS.groupTwo, projectId: IDS.projectTwo };
      const inherited = projectOne(makeWorkspace());
      inherited.environments = [
        { id: uuid(1501), name: "base", variables: { baseUrl: "https://inherited.example.test" }, baseUrls: {} },
        { id: uuid(1502), name: "child", extends: "base", variables: { region: "qa" }, baseUrls: {} },
      ];
      const inheritedResult = await session.importModuleToProject(targetLocator, "inherited fallback", { project: inherited });
      expect(inheritedResult.map((collection) => collection.variables.baseUrl)).toEqual([
        "https://inherited.example.test", "https://inherited.example.test",
      ]);

      const collectionFallback = projectOne(makeWorkspace());
      collectionFallback.environments = [
        { id: uuid(1511), name: "first", variables: {}, baseUrls: {} },
        { id: uuid(1512), name: "second", variables: {}, baseUrls: {} },
      ];
      collectionFallback.collections[0].variables.baseUrl = "https://collection-fallback.example.test";
      const preservedResult = await session.importModuleToProject(targetLocator, "collection fallback", { project: collectionFallback });
      expect(preservedResult[0].variables.baseUrl).toBe("https://collection-fallback.example.test");

      const noEnvironment = projectOne(makeWorkspace());
      noEnvironment.environments = [];
      noEnvironment.collections[0].variables.baseUrl = "https://no-environment.example.test";
      const noEnvironmentResult = await session.importModuleToProject(targetLocator, "no environment", { project: noEnvironment });
      expect(noEnvironmentResult[0].variables.baseUrl).toBe("https://no-environment.example.test");

      const reopened = createSession();
      await reopened.open(temporary.path);
      const target = projectTwo(reopened.workspace!);
      expect(target.collections.find((collection) => collection.name === "inherited fallback")?.variables.baseUrl)
        .toBe("https://inherited.example.test");
      expect(target.collections.find((collection) => collection.name === "collection fallback")?.variables.baseUrl)
        .toBe("https://collection-fallback.example.test");
      expect(target.collections.find((collection) => collection.name === "no environment")?.variables.baseUrl)
        .toBe("https://no-environment.example.test");
    } finally {
      await temporary.dispose();
    }
  });

  it("imports a module through an original environment name that is sanitized for storage", async () => {
    const temporary = await makeTempRoot();
    try {
      const workspace = makeWorkspace();
      const originalTarget = structuredClone(projectTwo(workspace));
      await persistWorkspace(temporary.path, workspace);
      const session = createSession({ storage: fileStorage });
      await session.open(temporary.path);
      const preview = projectOne(makeWorkspace());
      preview.collections[0].variables = { baseUrl: "https://collection-one-fallback.example.test", retained: "source-one" };
      preview.collections[1].variables = { baseUrl: "https://collection-two-fallback.example.test", retained: "source-two" };
      preview.environments = [
        {
          id: uuid(1801), name: "qa/source", variables: { baseUrl: "https://environment.example.test" },
          baseUrls: {
            [IDS.collectionOne]: "https://qa-one.example.test",
            [IDS.secondCollection]: "https://qa-two.example.test",
          },
        },
        { id: uuid(1802), name: "child", extends: "qa/source", variables: { region: "qa" }, baseUrls: {} },
      ];
      const previewBefore = structuredClone(preview);

      const imported = await session.importModuleToProject(
        { workspaceId: IDS.workspace, groupId: IDS.groupTwo, projectId: IDS.projectTwo },
        "sanitized source name",
        { project: preview },
      );

      expect(imported.map((collection) => collection.variables)).toEqual([
        { baseUrl: "https://qa-one.example.test", retained: "source-one" },
        { baseUrl: "https://qa-two.example.test", retained: "source-two" },
      ]);
      expect(preview).toEqual(previewBefore);
      const reopened = createSession({ storage: fileStorage });
      await reopened.open(temporary.path);
      const target = projectTwo(reopened.workspace!);
      expect(target.collections.filter((collection) => collection.name === "sanitized source name").map((collection) => collection.variables)).toEqual([
        { baseUrl: "https://qa-one.example.test", retained: "source-one" },
        { baseUrl: "https://qa-two.example.test", retained: "source-two" },
      ]);
      expect(target.collections[0]).toEqual(originalTarget.collections[0]);
      expect(target.environments).toHaveLength(0);
      expect(target.workflows).toHaveLength(0);
    } finally {
      await temporary.dispose();
    }
  });

  it("does not treat distinct original environment names as duplicates after sanitization", async () => {
    const temporary = await makeTempRoot();
    try {
      const workspace = makeWorkspace();
      const originalTarget = structuredClone(projectTwo(workspace));
      await persistWorkspace(temporary.path, workspace);
      const session = createSession({ storage: fileStorage });
      await session.open(temporary.path);
      const preview = projectOne(makeWorkspace());
      preview.collections[0].variables = { baseUrl: "https://collection-one-fallback.example.test", retained: "source-one" };
      preview.collections[1].variables = { baseUrl: "https://collection-two-fallback.example.test", retained: "source-two" };
      preview.environments = [
        {
          id: uuid(1811), name: "qa/source", variables: {},
          baseUrls: {
            [IDS.collectionOne]: "https://qa-one.example.test",
            [IDS.secondCollection]: "https://qa-two.example.test",
          },
        },
        { id: uuid(1812), name: "qa-source", extends: "qa/source", variables: {}, baseUrls: {} },
      ];
      const previewBefore = structuredClone(preview);

      const imported = await session.importModuleToProject(
        { workspaceId: IDS.workspace, groupId: IDS.groupTwo, projectId: IDS.projectTwo },
        "sanitized collision",
        { project: preview },
      );

      expect(imported.map((collection) => collection.variables)).toEqual([
        { baseUrl: "https://qa-one.example.test", retained: "source-one" },
        { baseUrl: "https://qa-two.example.test", retained: "source-two" },
      ]);
      expect(preview).toEqual(previewBefore);
      const reopened = createSession({ storage: fileStorage });
      await reopened.open(temporary.path);
      const target = projectTwo(reopened.workspace!);
      expect(target.collections.filter((collection) => collection.name === "sanitized collision").map((collection) => collection.variables)).toEqual([
        { baseUrl: "https://qa-one.example.test", retained: "source-one" },
        { baseUrl: "https://qa-two.example.test", retained: "source-two" },
      ]);
      expect(target.collections[0]).toEqual(originalTarget.collections[0]);
      expect(target.environments).toHaveLength(0);
      expect(target.workflows).toHaveLength(0);
    } finally {
      await temporary.dispose();
    }
  });

  it("rejects disagreement between environment fallbacks and collection-specific mappings before save", async () => {
    const preview = projectOne(makeWorkspace());
    preview.environments = [
      { id: uuid(1601), name: "fallback", variables: { baseUrl: "https://fallback.example.test" }, baseUrls: {} },
      { id: uuid(1602), name: "mapped", variables: {}, baseUrls: { [IDS.collectionOne]: "https://mapped.example.test" } },
    ];

    await expectModuleImportRejectedWithoutWrite(preview, /ambiguous|choose.*environment|source environment/i);

    const childOverride = projectOne(makeWorkspace());
    childOverride.environments = [
      {
        id: uuid(1603), name: "parent", variables: {},
        baseUrls: { [IDS.collectionOne]: "https://parent.example.test" },
      },
      {
        id: uuid(1604), name: "child", extends: "parent", variables: {},
        baseUrls: { [IDS.collectionOne]: "https://child.example.test" },
      },
    ];
    await expectModuleImportRejectedWithoutWrite(childOverride, /ambiguous|choose.*environment|source environment/i);
  });

  it("rejects an undefined-versus-defined environment result and unresolved inheritance before save", async () => {
    const differentValues = projectOne(makeWorkspace());
    differentValues.environments = [
      { id: uuid(1701), name: "empty", variables: {}, baseUrls: {} },
      { id: uuid(1702), name: "mapped", variables: {}, baseUrls: { [IDS.collectionOne]: "https://defined.example.test" } },
    ];
    await expectModuleImportRejectedWithoutWrite(differentValues, /ambiguous|choose.*environment|source environment/i);

    const sanitizedNameWithDifferentValues = projectOne(makeWorkspace());
    sanitizedNameWithDifferentValues.environments = [
      { id: uuid(1711), name: "qa/source", variables: {}, baseUrls: { [IDS.collectionOne]: "https://first.example.test" } },
      { id: uuid(1712), name: "other", variables: {}, baseUrls: { [IDS.collectionOne]: "https://second.example.test" } },
    ];
    await expectModuleImportRejectedWithoutWrite(sanitizedNameWithDifferentValues, /ambiguous|choose.*environment|source environment/i);

    const unresolvedParent = projectOne(makeWorkspace());
    unresolvedParent.environments[0].extends = "missing-parent";
    await expectModuleImportRejectedWithoutWrite(unresolvedParent, /environment|extends|inherit/i);

    const duplicateNames = projectOne(makeWorkspace());
    duplicateNames.environments.push({
      ...structuredClone(duplicateNames.environments[0]), id: uuid(1703),
    });
    await expectModuleImportRejectedWithoutWrite(duplicateNames, /ambiguous.*environment|environment.*ambiguous/i);

    const cyclicInheritance = projectOne(makeWorkspace());
    cyclicInheritance.environments = [
      { id: uuid(1704), name: "cycle-a", extends: "cycle-b", variables: {}, baseUrls: {} },
      { id: uuid(1705), name: "cycle-b", extends: "cycle-a", variables: {}, baseUrls: {} },
    ];
    await expectModuleImportRejectedWithoutWrite(cyclicInheritance, /cyclic.*environment|environment.*cyclic/i);
  });

  it("clones projects and imports only a remapped module dependency closure, then reopens without dangling refs", async () => {
    const temporary = await makeTempRoot();
    try {
      const workspace = makeWorkspace();
      await persistWorkspace(temporary.path, workspace);
      const session = createSession();
      await session.open(temporary.path);

      const source = projectOne(makeWorkspace());
      const sourceApi = findApi(source, IDS.sharedApi)!;
      sourceApi.contract.request.headers = [{
        kind: "componentRef", id: uuid(960), componentId: IDS.parameter, expectedKind: "parameter",
      }];
      sourceApi.contract.request.auth = { kind: "componentRef", componentId: IDS.auth, expectedKind: "auth" };
      sourceApi.contract.responses = [{
        kind: "componentRef", id: uuid(961), componentId: IDS.response, expectedKind: "response",
      }];
      const parameter = source.components.find((item) => item.id === IDS.parameter);
      if (!parameter || parameter.kind !== "parameter") throw new Error("Fixture parameter missing");
      parameter.definition.schema = { kind: "modelRef", modelId: IDS.model };
      const response = source.components.find((item) => item.id === IDS.response);
      if (!response || response.kind !== "response") throw new Error("Fixture response missing");
      response.definition.content = {
        "application/json": {
          schema: { kind: "modelRef", modelId: IDS.model },
          examples: [{ kind: "componentRef", id: uuid(962), componentId: IDS.example, expectedKind: "example" }],
        },
      };
      const preview = ContractProjectSchema.parse(source);
      const previewBefore = structuredClone(preview);

      const clonedProject = await session.cloneProject(projectLocator);
      expect(clonedProject.id).not.toBe(IDS.projectOne);
      expect(clonedProject.collections[0].apis[0].contract.id).not.toBe(IDS.sharedApi);
      const clonedSharedApi = findApi(clonedProject, clonedProject.collections[0].apis[0].contract.id)!;
      const clonedAuthComponent = clonedProject.components.find((item) => item.kind === "auth" && item.name === "saved auth");
      expect(clonedSharedApi.contract.request.auth).toMatchObject({ kind: "bearer", token: { policy: "credential-alias" } });
      if (clonedSharedApi.contract.request.auth.kind !== "bearer" || clonedAuthComponent?.kind !== "auth" || clonedAuthComponent.definition.kind !== "bearer") {
        throw new Error("Cloned auth definitions changed shape");
      }
      expect(clonedSharedApi.contract.request.auth.token.id).not.toBe("shared-secret-ref");
      expect(clonedAuthComponent.definition.token.id).toBe(clonedSharedApi.contract.request.auth.token.id);
      expect(findApi(projectOne(session.workspace!), IDS.sharedApi)?.contract.id).toBe(IDS.sharedApi);

      const importedWhole = await session.importProjectToGroup(
        { workspaceId: IDS.workspace, groupId: IDS.groupOne },
        "Imported preview",
        { project: preview },
      );
      expect(importedWhole.name).toBe("Imported preview");
      expect(importedWhole.id).not.toBe(preview.id);
      expect(importedWhole.environments[0].id).not.toBe(preview.environments[0].id);
      expect(importedWhole.collections[0].apis[0].contract.id).not.toBe(preview.collections[0].apis[0].contract.id);

      const importedCollections = await session.importModuleToProject({
        workspaceId: IDS.workspace, groupId: IDS.groupTwo, projectId: IDS.projectTwo,
      }, "Imported module", { project: preview });
      expect(importedCollections).toHaveLength(preview.collections.length);
      expect(importedCollections.every((collection) => collection.name === "Imported module")).toBe(true);
      expect(importedCollections[0].variables.baseUrl).toBe("https://dev.example.test");
      expect(importedCollections[1].variables.baseUrl).toBe("https://second.example.test");
      expect(preview).toEqual(previewBefore);

      const reopened = createSession();
      await reopened.open(temporary.path);
      const targetProject = projectTwo(reopened.workspace!);
      const moduleApis = targetProject.collections.slice(1).flatMap((collection) => [
        ...collection.apis,
        ...collection.folders.flatMap((folder) => folder.apis),
      ]);
      expect(targetProject.environments).toHaveLength(0);
      expect(targetProject.workflows).toHaveLength(0);
      expect(targetProject.models.map((model) => model.name)).toContain("Payload");
      expect(targetProject.models.map((model) => model.name)).not.toContain("Unused model");
      expect(targetProject.components.map((component) => component.name)).toEqual(expect.arrayContaining([
        "token header", "saved auth", "ok response", "ok example",
      ]));
      const sourceComponentIds = new Set([IDS.parameter, IDS.auth, IDS.response, IDS.example]);
      expect(targetProject.components.filter((component) => ["token header", "saved auth", "ok response", "ok example"].includes(component.name))
        .every((component) => !sourceComponentIds.has(component.id))).toBe(true);
      expect(targetProject.components.map((component) => component.name)).not.toContain("unused parameter");
      expect(targetProject.components.map((component) => component.name)).not.toContain("unused auth");
      expect(moduleApis.every((api) => api.contract.id !== IDS.sharedApi)).toBe(true);
      expect(createProjectAssetContext({ projectId: targetProject.id, assets: moduleApis, models: targetProject.models, components: targetProject.components }).diagnostics)
        .toEqual([]);
    } finally {
      await temporary.dispose();
    }
  });

  it("rejects an imported project identity collision without changing the preview or workspace", async () => {
    const temporary = await makeTempRoot();
    try {
      const workspace = makeWorkspace();
      await persistWorkspace(temporary.path, workspace);
      const preview = ContractProjectSchema.parse({ ...projectOne(makeWorkspace()), id: uuid(990) });
      const previewBefore = structuredClone(preview);
      const before = await fileStorage.load(temporary.path);
      let next = 1000;
      const counted = countingStorage();
      const session = createSession({
        storage: counted.storage,
        newId: (kind) => kind === "project" ? IDS.projectOne : uuid(next++),
      });
      await session.open(temporary.path);

      await expect(session.importProjectToGroup(
        { workspaceId: IDS.workspace, groupId: IDS.groupOne }, "collision", { project: preview },
      )).rejects.toThrow(/identity collision/i);

      expect(preview).toEqual(previewBefore);
      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(0);
      expect(session.workspace).toEqual(before.workspace);
      expect(await fileStorage.load(temporary.path)).toMatchObject({ workspace: before.workspace, revision: before.revision });
    } finally {
      await temporary.dispose();
    }
  });
});

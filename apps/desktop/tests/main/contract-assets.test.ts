import { describe, expect, it } from "vitest";
import { createDefaultRegistry, createProjectSnapshot, fileStorage, getSourceApiRevision, listContractWorkspaceDefinitionFiles, type ApiRequest, type StorageAdapter } from "@apicc/core";
import { createIpcDeps } from "../../src/main/ipc.js";
import { IpcChannel } from "../../src/shared/channels.js";
import { createTestingController } from "../../src/main/testing.js";
import { createCredentialHost } from "../../src/main/credentialHost.js";
import { createSession, type CollectionContainerOperations } from "../../src/main/session.js";
import { createMemoryApi } from "../../src/renderer/src/api/memory.js";
import {
  findApi,
  IDS,
  makeTempRoot,
  makeWorkspace,
  persistWorkspace,
  projectOne,
  projectTwo,
  uuid,
} from "./helpers/contract-assets.js";

describe("desktop contract workspace session", () => {
  it("enforces strict testing IPC and readonly saves at the real transaction boundary", async () => {
    const temporary = await makeTempRoot();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const session = createSession(); await session.open(temporary.path);
      const deps = createIpcDeps({ session, pickDirectory: async () => "", saveFile: async () => "" });
      const project = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
      const before = await deps.handle(IpcChannel.TestingList, null, { root: temporary.path, project });
      const dataset = { formatVersion: 1 as const, id: uuid(242), name: "ipc", columns: ["value"], rows: [{ value: false }] };
      const input = { context: before.context, locator: { ...project, datasetId: dataset.id }, asset: dataset, create: true };
      const saved = await deps.handle(IpcChannel.DatasetSave, null, JSON.parse(JSON.stringify(input)));
      expect(saved.datasets).toEqual([dataset]);
      await expect(Reflect.apply(deps.handle, undefined, [IpcChannel.DatasetSave, null, { ...input, filePath: "C:/unselected" }])).rejects.toThrow(/入参校验/);
      const readonly = createSession({ storage: { async load(root) { return { ...await fileStorage.load(root), readOnly: true }; }, async save() { throw new Error("Unexpected storage write"); } } });
      await readonly.open(temporary.path);
      const context = { ...saved.context, revision: readonly.revision! };
      await expect(readonly.saveDataset({ ...input, context, create: false })).rejects.toThrow(/只读/);
      await expect(readonly.saveSuite({ context, locator: { ...project, suiteId: uuid(243) }, create: true, asset: { formatVersion: 1, id: uuid(243), name: "readonly", tags: [], failFast: false, reporters: ["json"], selection: { kind: "explicit", entries: [] } } })).rejects.toThrow(/只读/);
      expect(projectOne((await session.open(temporary.path)).workspace).datasets).toEqual([dataset]);
    } finally { await temporary.dispose(); }
  });
  it("previews without credential/protocol access and cancels only the bound owner's active suite", async () => {
    const temporary = await makeTempRoot();
    try {
      const workspace = makeWorkspace(); const project = projectOne(workspace);
      project.workflows = [];
      const selected = findApi(project, IDS.sharedApi)!;
      selected.cases = [{ ...selected.cases[0]!, scope: "base" }]; selected.contract.request.auth = { kind: "none" };
      project.suites = [{ formatVersion: 1, id: uuid(238), name: "cancel", tags: [], reporters: ["json"], failFast: false, selection: { kind: "explicit", entries: [{ id: uuid(239), kind: "case", collectionId: IDS.collectionOne, folderIds: [], apiId: IDS.sharedApi, caseId: IDS.sharedCase }] } }];
      await persistWorkspace(temporary.path, workspace);
      const session = createSession(); await session.open(temporary.path);
      const registry = createDefaultRegistry(); let requests = 0; let credentialPreparations = 0;
      let entered!: () => void; const executing = new Promise<void>(resolve => { entered = resolve; });
      registry.registerProtocol({ name: "http", canHandle: request => request.protocol === "http", execute: async (_request, options) => {
        requests++; entered();
        return new Promise(resolve => options.signal!.addEventListener("abort", () => resolve({ status: 0, headers: {}, bodyText: "", timeMs: 0 }), { once: true }));
      } });
      const host = createCredentialHost(session, () => { throw new Error("No native credential reads allowed"); });
      const controller = createTestingController(session, async () => registry, { prepareRunForRequests: async (...args) => { credentialPreparations++; return host.prepareRunForRequests(...args); } });
      const owner = {}; const otherOwner = {};
      const view = await controller.listTestingAssets({ root: temporary.path, project: { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne } });
      const input = { context: view.context, locator: { ...view.context.project, suiteId: uuid(238) }, invocationId: uuid(240) };
      expect((await controller.previewSuite(input)).plannedExecutions).toBe(1);
      expect([credentialPreparations, requests]).toEqual([0, 0]);
      const pending = controller.runSuite(input, owner); await executing;
      expect(await controller.cancelSuite(input, otherOwner)).toBe(false);
      expect(await controller.cancelSuite({ ...input, context: { ...input.context, project: { ...input.context.project, projectId: IDS.projectTwo } } }, owner)).toBe(false);
      expect(await controller.cancelSuite(input, owner)).toBe(true);
      const output = await pending;
      expect(output.result.suite).toMatchObject({ verdict: "aborted", failed: 1 });
      expect([credentialPreparations, requests]).toEqual([1, 1]);
      expect(await controller.cancelSuite(input, owner)).toBe(false);
    } finally { await temporary.dispose(); }
  });
  it("imports raw JSON cells, shares suite preview/run data and rejects empty dataset execution", async () => {
    const temporary = await makeTempRoot();
    try {
      const workspace = makeWorkspace();
      projectOne(workspace).workflows = [];
      const selectedApi = findApi(projectOne(workspace), IDS.sharedApi)!;
      selectedApi.cases = [{ ...selectedApi.cases[0]!, scope: "base" }];
      selectedApi.contract.request.auth = { kind: "none" };
      await persistWorkspace(temporary.path, workspace);
      const api = createMemoryApi({ root: temporary.path });
      await api.wsOpen(temporary.path);
      const project = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
      let view = await api.listTestingAssets({ root: temporary.path, project });
      const parsed = await api.importDataset({ context: view.context, format: "json", content: '[{"value":{"nested":[0,false,null]}},{"value":""}]' });
      expect(parsed.rows).toEqual([{ value: { nested: [0, false, null] } }, { value: "" }]);
      expect(await api.importDataset({ context: view.context, format: "csv", content: '\uFEFFa,b\r\n"hello,\nworld",""\r\n' })).toEqual({ columns: ["a", "b"], rows: [{ a: "hello,\nworld", b: "" }] });
      const dataset = { formatVersion: 1 as const, id: uuid(232), name: "typed", ...parsed };
      view = await api.saveDataset({ context: view.context, locator: { ...project, datasetId: dataset.id }, asset: dataset, create: true });
      expect(JSON.parse(await api.exportDataset({ context: view.context, locator: { ...project, datasetId: dataset.id }, format: "json" }))).toEqual(parsed.rows);
      const suite = { formatVersion: 1 as const, id: uuid(233), name: "suite", tags: [], failFast: false, reporters: ["json" as const], datasetId: dataset.id, selection: { kind: "explicit" as const, entries: [{ id: uuid(234), kind: "case" as const, collectionId: IDS.collectionOne, folderIds: [], apiId: IDS.sharedApi, caseId: IDS.sharedCase }] } };
      view = await api.saveSuite({ context: view.context, locator: { ...project, suiteId: suite.id }, asset: suite, create: true });
      const input = { context: view.context, locator: { ...project, suiteId: suite.id }, invocationId: uuid(235) };
      const preview = await api.previewSuite(input);
      expect(preview.plannedExecutions).toBe(2);
      expect(preview.outerRows).toBe(2);
      expect(preview.plan.entries[0]!.cases[0]!.locator).toMatchObject({ apiId: IDS.sharedApi, scope: "base", folderIds: [] });
      const output = await api.runSuite(input);
      expect(output.result.total).toBe(2);
      expect(output.result.suite?.total).toBe(2);
      expect(output.result.suite?.definitionRevision).toBe(preview.plan.definitionRevision);
      expect(output.result.cases.every((item) => item.passed)).toBe(true);
      view = await api.saveDataset({ context: view.context, locator: { ...project, datasetId: dataset.id }, asset: { ...dataset, rows: [] } });
      await expect(api.previewSuite({ ...input, context: view.context })).rejects.toThrow(/为空|empty/);
      await expect(api.importDataset({ context: view.context, format: "csv", content: 'a,a\n1,2' })).rejects.toThrow(/重复|Duplicate/);
    } finally { await temporary.dispose(); }
  });
  it("round trips typed datasets and suites transactionally, rejects stale identities and guards dataset references", async () => {
    const temporary = await makeTempRoot();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const session = createSession();
      await session.open(temporary.path);
      const project = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
      const context = () => ({ root: temporary.path, project, revision: session.revision! });
      const dataset: import("@apicc/core").DatasetAsset = { formatVersion: 1, id: uuid(230), name: "typed", columns: ["value", "optional"], rows: [{ value: { nested: [0, false, null] } }, { value: "", optional: null }] };
      const first = context();
      await session.saveDataset({ context: first, locator: { ...project, datasetId: dataset.id }, asset: dataset, create: true });
      await expect(session.saveDataset({ context: first, locator: { ...project, datasetId: dataset.id }, asset: dataset })).rejects.toThrow(/context|revision|上下文/i);
      const suite = { formatVersion: 1 as const, id: uuid(231), name: "suite", tags: [], failFast: false, reporters: ["json" as const], datasetId: dataset.id, selection: { kind: "query" as const } };
      await session.saveSuite({ context: context(), locator: { ...project, suiteId: suite.id }, asset: suite, create: true });
      await expect(session.deleteTestingAsset({ context: context(), target: { kind: "dataset", locator: { ...project, datasetId: dataset.id } } })).rejects.toThrow(/referenced/i);
      await expect(session.saveDataset({ context: { ...context(), root: `${temporary.path}-other` }, locator: { ...project, datasetId: dataset.id }, asset: dataset })).rejects.toThrow(/context|root|上下文/i);
      await expect(session.saveDataset({ context: context(), locator: { ...project, projectId: IDS.projectTwo, datasetId: dataset.id }, asset: dataset })).rejects.toThrow(/project|locator/i);
      const reopened = await session.open(temporary.path);
      expect(projectOne(reopened.workspace).datasets).toEqual([dataset]);
      expect(projectOne(reopened.workspace).suites).toEqual([suite]);
      await session.deleteTestingAsset({ context: context(), target: { kind: "suite", locator: { ...project, suiteId: suite.id } } });
      await session.deleteTestingAsset({ context: context(), target: { kind: "dataset", locator: { ...project, datasetId: dataset.id } } });
      expect(projectOne((await session.open(temporary.path)).workspace).datasets).toEqual([]);
      expect(projectOne(session.workspace!).suites).toEqual([]);
    } finally { await temporary.dispose(); }
  });
  it.each(["method", "node"] as const)("deletes an unrelated workflow sharing a suite case raw ID through the %s entry point", async (entryPoint) => {
    const temporary = await makeTempRoot();
    try {
      const workspace = makeWorkspace();
      const project = projectOne(workspace);
      const api = findApi(project, IDS.sharedApi)!;
      api.cases = [{ ...api.cases[0]!, id: IDS.workflow }];
      project.workflows[0]!.nodes = [];
      project.suites = [{ formatVersion: 1, id: uuid(220), name: "case only", tags: [], failFast: false, reporters: ["html"], selection: { kind: "explicit", entries: [{ id: uuid(221), kind: "case", collectionId: IDS.collectionOne, folderIds: [], apiId: IDS.sharedApi, caseId: IDS.workflow }] } }];
      await persistWorkspace(temporary.path, workspace);
      const session = createSession();
      const before = await session.open(temporary.path);
      const locator = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne, workflowId: IDS.workflow };
      if (entryPoint === "method") await session.deleteWorkflow(locator);
      else await session.deleteNode({ kind: "workflow", locator });
      const after = await session.open(temporary.path);
      expect(after.revision).not.toBe(before.revision);
      expect(projectOne(after.workspace).workflows).toEqual([]);
      expect(projectOne(after.workspace).suites).toEqual(project.suites);
      expect(after.readOnly).toBe(false);
      expect(after.problems).toEqual([]);
    } finally { await temporary.dispose(); }
  });
  it("refuses suite-referenced case, workflow and assertion model removal without changing revision", async () => {
    const temporary = await makeTempRoot();
    try {
      const workspace = makeWorkspace();
      const project = projectOne(workspace);
      const api = findApi(project, IDS.sharedApi)!;
      project.workflows[0]!.nodes = [];
      api.cases[0]!.assertions = [{ id: "schema", target: "bodyJson", op: "schema", options: { schema: { kind: "modelRef", modelId: IDS.model } } }];
      project.suites = [{ formatVersion: 1, id: uuid(220), name: "saved suite", tags: [], failFast: false, reporters: ["html"], selection: { kind: "explicit", entries: [{ id: uuid(221), kind: "case", collectionId: IDS.collectionOne, folderIds: [], apiId: IDS.sharedApi, caseId: IDS.sharedCase }, { id: uuid(222), kind: "workflow", workflowId: IDS.workflow }] } }];
      await persistWorkspace(temporary.path, workspace);
      const session = createSession();
      const opened = await session.open(temporary.path);
      const locator = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
      await expect(session.deleteNode({ kind: "api", locator: { ...locator, collectionId: IDS.collectionOne, folderIds: [], apiId: IDS.sharedApi } })).rejects.toThrow(/suite/i);
      await expect(session.deleteNode({ kind: "model", locator: { ...locator, modelId: IDS.model } })).rejects.toThrow(/referenced/i);
      await expect(session.deleteWorkflow({ ...locator, workflowId: IDS.workflow })).rejects.toThrow(/suite/i);
      await expect(session.deleteNode({ kind: "workflow", locator: { ...locator, workflowId: IDS.workflow } })).rejects.toThrow(/suite/i);
      await session.saveWorkflow({ ...locator, workflowId: IDS.workflow }, project.workflows[0]!);
      expect((await session.open(temporary.path)).revision).toBe(opened.revision);
    } finally { await temporary.dispose(); }
  });
  it("reports the absolute root, problems, read-only state, and revision when opening", async () => {
    const temporary = await makeTempRoot();
    try {
      const workspace = makeWorkspace();
      const revision = await persistWorkspace(temporary.path, workspace);
      const session = createSession();
      const opened = await session.open(temporary.path);

      expect(opened.workspace.formatVersion).toBe(1);
      expect(opened.root).toBe(temporary.path);
      expect(opened.readOnly).toBe(false);
      expect(opened.revision).toBe(revision);
    } finally {
      await temporary.dispose();
    }
  });

  it("locates duplicate IDs only within the complete hierarchy and preserves every folder ancestor", async () => {
    const temporary = await makeTempRoot();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const session = createSession();
      await session.open(temporary.path);
      const firstLocator = {
        workspaceId: IDS.workspace,
        groupId: IDS.groupOne,
        projectId: IDS.projectOne,
        collectionId: IDS.collectionOne,
        folderIds: [],
        apiId: IDS.sharedApi,
      };
      const first = session.locateApi(firstLocator)!;
      const otherProject = session.locateApi({
        workspaceId: IDS.workspace,
        groupId: IDS.groupTwo,
        projectId: IDS.projectTwo,
        collectionId: IDS.collectionTwo,
        folderIds: [],
        apiId: IDS.sharedApi,
      })!;
      const deep = session.locateApi({
        workspaceId: IDS.workspace,
        groupId: IDS.groupOne,
        projectId: IDS.projectOne,
        collectionId: IDS.collectionOne,
        folderIds: [IDS.folderOne, IDS.folderTwo],
        apiId: IDS.deepApi,
      })!;

      expect(first.api.contract.metadata.name).toBe("project one API");
      expect(otherProject.api.contract.metadata.name).toBe("project two API");
      expect(deep.folderAncestors.map((folder) => folder.id)).toEqual([IDS.folderOne, IDS.folderTwo]);
      expect(deep.folder).toBe(deep.folderAncestors[1]);
      expect(deep.collection).toBe(deep.project.collections[0]);
      expect(() => session.locateApi({ ...firstLocator, workspaceId: IDS.groupTwo })).toThrow(/workspace/i);
      expect(session.locateApi({ ...firstLocator, apiId: IDS.deepApi })).toBeUndefined();
    } finally {
      await temporary.dispose();
    }
  });

  it("locates and writes the requested project when its ID is shared across groups", async () => {
    const temporary = await makeTempRoot();
    try {
      const workspace = makeWorkspace();
      const secondGroup = workspace.groups.find((group) => group.id === IDS.groupTwo)!;
      secondGroup.projects[0].id = IDS.projectOne;
      secondGroup.projects[0].name = "same ID in group two";
      await persistWorkspace(temporary.path, workspace);
      const session = createSession();
      await session.open(temporary.path);
      const firstLocator = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
      const secondLocator = { workspaceId: IDS.workspace, groupId: IDS.groupTwo, projectId: IDS.projectOne };
      const first = session.locateProject(firstLocator);
      const second = session.locateProject(secondLocator);
      expect(first?.project.name).toBe("project one");
      expect(second?.project.name).toBe("same ID in group two");
      expect(first?.group.id).toBe(IDS.groupOne);
      expect(second?.group.id).toBe(IDS.groupTwo);
      expect(first?.group.projects.find((project) => project.id === IDS.projectOne)).toBe(first?.project);
      expect(second?.group.projects.find((project) => project.id === IDS.projectOne)).toBe(second?.project);
      expect(first?.project).not.toBe(second?.project);
      if (!first) throw new Error("First project not located");
      first.project.name = "caller edit must not escape";
      expect(session.locateProject(firstLocator)?.project.name).toBe("project one");
      expect(() => session.locateProject({ ...firstLocator, workspaceId: uuid(999) })).toThrow(/workspace mismatch/i);
      expect(session.locateProject({ ...firstLocator, projectId: uuid(999) })).toBeUndefined();

      await session.setProjectGlobals(firstLocator, {
        variables: { onlyFirst: "changed" }, query: [], headers: [], cookies: [], body: [],
      });
      expect(session.getProjectGlobals(firstLocator).variables).toEqual({ onlyFirst: "changed" });
      expect(session.getProjectGlobals(secondLocator).variables).toEqual({});

      const reopened = createSession();
      await reopened.open(temporary.path);
      expect(reopened.locateProject(firstLocator)?.project.name).toBe("project one");
      expect(reopened.locateProject(secondLocator)?.project.name).toBe("same ID in group two");
      expect(reopened.getProjectGlobals(firstLocator).variables).toEqual({ onlyFirst: "changed" });
      expect(reopened.getProjectGlobals(secondLocator).variables).toEqual({});
    } finally {
      await temporary.dispose();
    }
  });

  it("rejects ambiguous same-level projects instead of selecting one", async () => {
    const workspace = makeWorkspace();
    const duplicate = structuredClone(projectOne(workspace));
    duplicate.name = "same-level duplicate";
    workspace.groups.find((group) => group.id === IDS.groupOne)!.projects.push(duplicate);
    const session = createSession({ storage: {
      async load() { return { workspace, problems: [], readOnly: false, revision: "ambiguous-revision" }; },
      async save() { return { revision: "unused" }; },
    } });
    await session.open("ambiguous-root");
    const locator = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
    expect(() => session.locateProject(locator)).toThrow(/Ambiguous project/i);
  });

  it("returns independent editable views without exposing active in-memory definitions", async () => {
    const temporary = await makeTempRoot();
    try {
      const workspace = makeWorkspace();
      await persistWorkspace(temporary.path, workspace);
      const session = createSession();
      await session.open(temporary.path);
      const view = session.workspace;
      if (!view) throw new Error("Opened workspace was not available");
      const locator = {
        workspaceId: IDS.workspace,
        groupId: IDS.groupOne,
        projectId: IDS.projectOne,
        collectionId: IDS.collectionOne,
        folderIds: [],
        apiId: IDS.sharedApi,
      };
      const located = session.locateApi(locator)!;

      view.groups[0].projects[0].name = "caller workspace mutation";
      located.api.contract.metadata.name = "caller API mutation";
      located.project.name = "caller project mutation";

      const active = session.workspace;
      if (!active) throw new Error("Workspace closed while checking isolation");
      expect(active.groups[0].projects[0].name).toBe("project one");
      expect(session.locateApi(locator)?.api.contract.metadata.name).toBe("project one API");
      expect(findApi(projectOne(workspace), IDS.sharedApi)?.contract.metadata.name).toBe("project one API");
      expect(findApi(projectTwo(workspace), IDS.sharedApi)?.contract.metadata.name).toBe("project two API");
    } finally {
      await temporary.dispose();
    }
  });

  it("creates a formal workspace with exactly one successful initial save", async () => {
    const temporary = await makeTempRoot();
    try {
      const baseStorage = await import("@apicc/core").then((core) => core.fileStorage);
      const calls: string[] = [];
      const session = createSession({
        storage: {
          async load(root) {
            calls.push(`load:${root}`);
            return baseStorage.load(root);
          },
          async save(root, workspace, options) {
            calls.push(`save:${options.expectedRevision}:${options.deletions.length}`);
            return baseStorage.save(root, workspace, options);
          },
        },
      });

      const created = await session.create(temporary.path, "single write");

      expect(calls.filter((call) => call.startsWith("save:"))).toHaveLength(1);
      expect(created.workspace.name).toBe("single write");
      expect(created.workspace.groups).toHaveLength(1);
      expect(created.workspace.groups[0].default).toBe(true);
      expect(created.readOnly).toBe(false);
      expect(created.revision).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await temporary.dispose();
    }
  });

  it("creates strict default API assets for HTTP, WebSocket, and SOAP and saves through the public session", async () => {
    const temporary = await makeTempRoot();
    try {
      const session = createSession();
      const opened = await session.create(temporary.path, "protocols");
      const groupId = opened.workspace.groups[0].id;
      const project = await session.createProject({ workspaceId: opened.workspace.id, groupId }, "project");
      const projectLocator = { workspaceId: opened.workspace.id, groupId, projectId: project.id };
      const collection = await session.createCollection(projectLocator, "module");
      const collectionLocator = { ...projectLocator, collectionId: collection.id };
      const folder = await session.createFolder(collectionLocator, "nested");
      const folderLocator = { ...collectionLocator, folderIds: [folder.id] };

      const http = await session.createApi(collectionLocator, { name: "HTTP" });
      const websocket = await session.createApi(folderLocator, {
        name: "WebSocket", protocol: "websocket", baseUrl: "wss://api.example.test", path: "/socket",
      });
      const soap = await session.createApi(collectionLocator, {
        name: "SOAP", protocol: "soap", baseUrl: "https://api.example.test", path: "/soap",
      });

      expect(http.contract).toMatchObject({
        metadata: { status: "draft", name: "HTTP" },
        request: { protocol: "http", method: "GET", auth: { kind: "none" }, body: { kind: "none" } },
      });
      expect(http.cases).toHaveLength(1);
      expect(websocket.contract.request).toMatchObject({ protocol: "websocket", baseUrl: "wss://api.example.test", auth: { kind: "none" } });
      expect(soap.contract.request).toMatchObject({ protocol: "soap", method: "POST", envelope: "", auth: { kind: "none" } });

      const reopened = createSession();
      const result = await reopened.open(temporary.path);
      expect(result.readOnly).toBe(false);
      expect(reopened.locateApi({ ...collectionLocator, folderIds: [], apiId: http.contract.id })?.api).toEqual(http);
      expect(reopened.locateApi({ ...collectionLocator, folderIds: [folder.id], apiId: websocket.contract.id })?.api).toEqual(websocket);
      expect(reopened.locateApi({ ...collectionLocator, folderIds: [], apiId: soap.contract.id })?.api).toEqual(soap);
    } finally {
      await temporary.dispose();
    }
  });

  it("saves a free request as one complete API mutation and leaves no partial asset after storage failure", async () => {
    const temporary = await makeTempRoot();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const writes: string[] = [];
      let failNextWrite = false;
      const storage: StorageAdapter = {
        load: (root) => import("@apicc/core").then((core) => core.fileStorage.load(root)),
        async save(root, workspace, options) {
          writes.push(root);
          if (failNextWrite) {
            failNextWrite = false;
            throw new Error("injected storage failure");
          }
          return import("@apicc/core").then((core) => core.fileStorage.save(root, workspace, options));
        },
      };
      const session = createSession({ storage });
      await session.open(temporary.path);
      const project = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
      const projectDefinition = session.locateProject(project)?.project;
      if (!projectDefinition) throw new Error("Project fixture is unavailable");
      const sourceProjectRevision = createProjectSnapshot(projectDefinition).definitionRevision;
      const targetParent = { ...project, collectionId: IDS.collectionOne };
      const request: ApiRequest = {
        protocol: "http", method: "GET", baseUrl: "https://free.example.test", path: "/items",
        pathParams: [],
        query: [
          { kind: "inline", id: uuid(801), name: "q", schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "", value: "a+b" },
          { kind: "inline", id: uuid(802), name: "q", schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "", value: "x y" },
        ],
        headers: [], cookies: [], auth: { kind: "none" }, body: { kind: "none" },
      };
      const input = { project, targetParent, name: "project one API", request, sourceProjectRevision, fields: [] };
      const before = await import("@apicc/core").then((core) => core.fileStorage.load(temporary.path));
      const beforeFiles = listContractWorkspaceDefinitionFiles(before.workspace);

      failNextWrite = true;
      await expect(session.createApiFromRequestDraft(input)).rejects.toThrow("injected storage failure");
      expect(writes).toHaveLength(1);
      expect(session.workspace).toEqual(before.workspace);
      expect(session.locateProject(project)?.project.collections[0]?.apis).toHaveLength(1);
      expect(listContractWorkspaceDefinitionFiles(session.workspace!)).toEqual(beforeFiles);
      expect(await import("@apicc/core").then((core) => core.fileStorage.load(temporary.path))).toMatchObject({
        workspace: before.workspace,
        revision: before.revision,
      });

      const saved = await session.createApiFromRequestDraft(input);
      expect(writes).toHaveLength(2);
      expect(saved.detail.api.contract.metadata.name).toBe("project one API");
      expect(saved.detail.api.contract.request).toEqual(request);
      expect(saved.locator.projectId).toBe(project.projectId);
      expect(saved.detail.locator).toEqual(saved.locator);
      expect(session.locateProject(project)?.project.collections[0]?.apis).toHaveLength(2);
      expect(saved.detail.api.contract.id).not.toBe(IDS.sharedApi);
    } finally {
      await temporary.dispose();
    }
  });

  it("rejects saving a free request from a stale project revision without a second write", async () => {
    const temporary = await makeTempRoot();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const core = await import("@apicc/core");
      let writes = 0;
      const session = createSession({ storage: {
        load: (root) => core.fileStorage.load(root),
        save: async (root, workspace, options) => {
          writes += 1;
          return core.fileStorage.save(root, workspace, options);
        },
      } });
      await session.open(temporary.path);
      const project = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
      const originalProject = session.locateProject(project)?.project;
      if (!originalProject) throw new Error("Project fixture is unavailable");
      const staleRevision = createProjectSnapshot(originalProject).definitionRevision;
      await session.createCollection(project, "Revision change");
      expect(writes).toBe(1);
      const input = {
        project,
        targetParent: { ...project, collectionId: IDS.collectionOne },
        name: "stale free request",
        request: structuredClone(projectOne(makeWorkspace()).collections[0]!.apis[0]!.contract.request),
        sourceProjectRevision: staleRevision,
        fields: [],
      };

      await expect(session.createApiFromRequestDraft(input)).rejects.toThrow(/project source revision conflict/i);
      expect(writes).toBe(1);
      expect(session.locateProject(project)?.project.collections[0]?.apis).toHaveLength(1);
    } finally {
      await temporary.dispose();
    }
  });

  it("creates, reads, saves, renames, and deletes models and each component kind in a project scope", async () => {
    const temporary = await makeTempRoot();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const session = createSession();
      await session.open(temporary.path);
      const locator = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
      const model = await session.createModel(locator, {
        name: "Created model", description: "before", schema: { kind: "scalar", type: "boolean" },
      });
      const modelLocator = { ...locator, modelId: model.id };
      const savedModel = await session.saveModel(modelLocator, { ...model, description: "after" });
      expect(savedModel.description).toBe("after");
      await session.renameNode({ kind: "model", locator: modelLocator }, "renamed model");
      expect(session.locateModel(modelLocator)?.model.name).toBe("renamed model");

      const parameter = await session.createComponent(locator, {
        kind: "parameter", name: "created parameter", description: "",
        definition: { location: "query", name: "q", schema: { kind: "scalar", type: "string" }, required: false, description: "" },
      });
      const auth = await session.createComponent(locator, {
        kind: "auth", name: "created auth", description: "", definition: { kind: "none" },
      });
      const response = await session.createComponent(locator, {
        kind: "response", name: "created response", description: "",
        definition: { status: "201", description: "", headers: {}, content: {} },
      });
      const example = await session.createComponent(locator, {
        kind: "example", name: "created example", description: "",
        definition: { name: "created", value: "value" },
      });
      const componentLocator = { ...locator, componentKind: "parameter" as const, componentId: parameter.id };
      const savedParameter = await session.saveComponent(componentLocator, { ...parameter, description: "saved parameter" });

      expect(savedParameter.description).toBe("saved parameter");
      expect(session.locateComponent(componentLocator)?.component.id).toBe(parameter.id);
      expect(session.listComponents(locator).map((component) => component.kind)).toEqual(expect.arrayContaining([
        "parameter", "auth", "response", "example",
      ]));
      await session.deleteNode({ kind: "component", locator: { ...locator, componentKind: "example", componentId: example.id } });
      await session.deleteNode({ kind: "component", locator: { ...locator, componentKind: "auth", componentId: auth.id } });
      await session.deleteNode({ kind: "component", locator: { ...locator, componentKind: "response", componentId: response.id } });
      await session.deleteNode({ kind: "component", locator: componentLocator });
      await session.deleteNode({ kind: "model", locator: modelLocator });

      const reopened = createSession();
      await reopened.open(temporary.path);
      expect(reopened.listModels(locator).some((item) => item.id === model.id)).toBe(false);
      expect(reopened.listComponents(locator).some((item) => item.id === parameter.id)).toBe(false);
    } finally {
      await temporary.dispose();
    }
  });

  it("reads and persists collection variables without granting variables to folders", async () => {
    const temporary = await makeTempRoot();
    try {
      const initial = makeWorkspace();
      const firstCollection = projectOne(initial).collections.find((item) => item.id === IDS.collectionOne)!;
      firstCollection.variables = { baseUrl: "https://before.example.test", retained: "before" };
      const expectedWorkspace = structuredClone(initial);
      const expectedCollection = projectOne(expectedWorkspace).collections.find((item) => item.id === IDS.collectionOne)!;
      expectedCollection.variables = { baseUrl: "https://after.example.test", retained: "before", added: "yes" };
      expectedCollection.preOperations = [{ id: uuid(601), type: "script", content: "updated collection operation" }];
      await persistWorkspace(temporary.path, initial);

      const session = createSession();
      await session.open(temporary.path);
      const collectionLocator = {
        workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne, collectionId: IDS.collectionOne,
      };
      const folderLocator = { ...collectionLocator, folderIds: [IDS.folderOne, IDS.folderTwo] };
      const collectionBefore = session.getContainer(collectionLocator);
      expect(collectionBefore.variables).toEqual({ baseUrl: "https://before.example.test", retained: "before" });
      expect(session.getContainer(folderLocator)).not.toHaveProperty("variables");

      const input = {
        variables: { baseUrl: "https://after.example.test", retained: "before", added: "yes" },
        preOperations: [{ id: uuid(601), type: "script" as const, content: "updated collection operation" }],
        postOperations: [],
      };
      const saved = await session.saveContainer(collectionLocator, input);
      expect(saved.variables).toEqual(input.variables);

      const beforeInvalidWrite = session.workspace;
      const revisionBeforeInvalidWrite = session.revision;
      await expect(session.saveContainer(collectionLocator, {
        ...input, variables: { invalid: 17 },
      } as unknown as CollectionContainerOperations)).rejects.toThrow(/must be a string/i);
      expect(session.workspace).toEqual(beforeInvalidWrite);
      expect(session.revision).toBe(revisionBeforeInvalidWrite);

      const reopened = createSession();
      await reopened.open(temporary.path);
      expect(reopened.workspace).toEqual(expectedWorkspace);
      expect(reopened.getContainer(collectionLocator).variables).toEqual(expectedCollection.variables);
      expect(reopened.getContainer(folderLocator)).not.toHaveProperty("variables");
    } finally {
      await temporary.dispose();
    }
  });

  it("edits and deletes only the exact API case version while preserving sibling scopes", async () => {
    const temporary = await makeTempRoot();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const session = createSession();
      await session.open(temporary.path);
      const apiLocator = {
        workspaceId: IDS.workspace,
        groupId: IDS.groupOne,
        projectId: IDS.projectOne,
        collectionId: IDS.collectionOne,
        folderIds: [],
        apiId: IDS.sharedApi,
      };
      const blueLocator = { ...apiLocator, caseId: IDS.sharedCase, scope: "blue" };
      const greenLocator = { ...apiLocator, caseId: IDS.sharedCase, scope: "green" };
      const edited = await session.saveCase(blueLocator, {
        id: IDS.sharedCase, name: "blue edited", scope: "blue", parameters: { q: "1" },
        preOperations: [], postOperations: [], assertions: [],
      }, getSourceApiRevision(session.locateApi(apiLocator)!.api));

      expect(edited.testCase.name).toBe("blue edited");
      expect(session.locateApi(apiLocator)?.api.cases.map((testCase) => testCase.scope)).toEqual(["blue", "green"]);
      await session.deleteCase(blueLocator);
      expect(session.locateApi(apiLocator)?.api.cases.map((testCase) => testCase.scope)).toEqual(["green"]);
      await expect(session.deleteCase(greenLocator)).rejects.toThrow(/workflow|引用/i);
      expect(session.locateApi(apiLocator)?.api.cases.map((testCase) => testCase.scope)).toEqual(["green"]);
    } finally {
      await temporary.dispose();
    }
  });

  it("persists environment, global, stress policy, container, and workflow commands by full locator", async () => {
    const temporary = await makeTempRoot();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const session = createSession();
      await session.open(temporary.path);
      const project = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
      const collection = { ...project, collectionId: IDS.collectionOne };
      const folder = { ...collection, folderIds: [IDS.folderOne, IDS.folderTwo] };
      const environment = await session.createEnvironment(project, { name: "qa", extends: "dev" });
      const environmentLocator = { ...project, environmentId: environment.id };
      await session.setEnvironmentVariables(environmentLocator, { token: "qa-token" });
      await session.setEnvironmentBaseUrls(environmentLocator, { [IDS.collectionOne]: "https://qa.example.test" });
      await session.setProjectGlobals(project, {
        variables: { global: "value" },
        query: [{ key: "q", value: "1", enabled: true }],
        headers: [], cookies: [], body: [],
      });
      await session.setStressPolicy(project, { trustedOrigins: ["https://qa.example.test"], deniedOrigins: [], maxConcurrency: 3 });
      await session.saveContainer(folder, {
        preOperations: [{ id: uuid(400), type: "script", content: "before" }],
        postOperations: [{ id: uuid(401), type: "script", content: "after" }],
      });

      const workflowLocator = { ...project, workflowId: IDS.workflow };
      await session.saveWorkflow(workflowLocator, {
        id: IDS.workflow, name: "saved flow", status: "enabled",
        nodes: [{ id: IDS.workflowNode, kind: "request", apiId: IDS.sharedApi, caseId: IDS.sharedCase }], edges: [],
      });
      expect((await session.locateWorkflow(workflowLocator))?.workflow.status).toBe("draft");
      const impact = session.workflowImpact({ ...collection, folderIds: [], apiId: IDS.sharedApi, caseId: IDS.sharedCase });
      expect(impact.map((entry) => entry.workflowId)).toEqual([IDS.workflow]);
      expect(session.workflowImpact({ ...collection, folderIds: [], apiId: IDS.deepApi, caseId: IDS.sharedCase })).toEqual([]);

      const published = await session.setWorkflowStatus(workflowLocator, "published");
      expect(published.workflow.status).toBe("published");
      const enabled = await session.setWorkflowStatus(workflowLocator, "enabled");
      expect(enabled.workflow.status).toBe("enabled");
      expect(enabled.errors).toEqual([]);

      const reopened = createSession();
      await reopened.open(temporary.path);
      expect(reopened.locateEnvironment(environmentLocator)?.environment.variables).toEqual({ token: "qa-token" });
      expect(reopened.getProjectGlobals(project).variables).toEqual({ global: "value" });
      expect(reopened.getContainer(folder).preOperations[0].content).toBe("before");
      expect(reopened.locateWorkflow(workflowLocator)?.workflow.status).toBe("enabled");
    } finally {
      await temporary.dispose();
    }
  });

  it("queries workflow impact at API or logical-case level inside the complete physical locator", async () => {
    const temporary = await makeTempRoot();
    try {
      const workspace = makeWorkspace();
      const projectFixture = projectOne(workspace);
      const apiFixture = findApi(projectFixture, IDS.sharedApi)!;
      apiFixture.cases.push({ id: "case-other", name: "other logical case", scope: "base", parameters: {}, preOperations: [], postOperations: [], assertions: [] });
      projectFixture.workflows[0]!.nodes.push(
        { id: "request-other-case", kind: "request", apiId: IDS.sharedApi, caseId: "case-other" },
        { id: "request-same-case-other-api", kind: "request", apiId: IDS.secondApi, caseId: IDS.sharedCase },
      );
      await persistWorkspace(temporary.path, workspace);
      const session = createSession();
      await session.open(temporary.path);
      const project = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
      const firstApi = { ...project, collectionId: IDS.collectionOne, folderIds: [], apiId: IDS.sharedApi };
      const apiImpact = session.workflowImpact(firstApi);
      const firstCaseImpact = session.workflowImpact({ ...firstApi, caseId: IDS.sharedCase });
      const secondCaseImpact = session.workflowImpact({ ...firstApi, caseId: "case-other" });

      expect(apiImpact.map((entry) => entry.nodeId)).toEqual([IDS.workflowNode, "request-other-case"]);
      expect(firstCaseImpact).toHaveLength(1);
      expect(firstCaseImpact[0]).toMatchObject({ workflowId: IDS.workflow, workflowName: "request flow", status: "draft", nodeId: IDS.workflowNode });
      expect(secondCaseImpact.map((entry) => entry.nodeId)).toEqual(["request-other-case"]);
      expect(firstCaseImpact[0]!.workflowName).toBe("request flow");
      firstCaseImpact[0]!.workflowName = "caller mutation";
      expect(session.workflowImpact(firstApi)[0]?.workflowName).toBe("request flow");
      expect(session.workflowImpact({ ...firstApi, collectionId: IDS.secondCollection, apiId: IDS.secondApi }).map((entry) => entry.nodeId)).toEqual(["request-same-case-other-api"]);
      expect(session.workflowImpact({
        workspaceId: IDS.workspace,
        groupId: IDS.groupTwo,
        projectId: IDS.projectTwo,
        collectionId: IDS.collectionTwo,
        folderIds: [],
        apiId: IDS.sharedApi,
      })).toEqual([]);
      expect(session.workflowImpact({ ...firstApi, apiId: IDS.deepApi, folderIds: [IDS.folderTwo] })).toEqual([]);
      expect(() => session.workflowImpact({ ...firstApi, scope: "blue" } as never)).toThrow(/scope|校验/i);
      expect(() => session.workflowImpact({ ...firstApi, workspaceId: IDS.groupTwo })).toThrow(/workspace/i);
    } finally {
      await temporary.dispose();
    }
  });
});

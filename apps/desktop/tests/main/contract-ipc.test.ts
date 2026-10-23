import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createProjectSnapshot, fileStorage, getSourceApiRevision, WorkflowSchema as CoreWorkflowSchema, type SecretStore } from "@apicc/core";
import type { Importer } from "@apicc/core";
import { parseIpcArgs } from "../../src/shared/ipc-contract.js";
import type { OnlineClient } from "../../src/main/online/client.js";
import type { TokenStore } from "../../src/main/online/tokenStore.js";
import { IpcChannel } from "../../src/shared/channels.js";
import type { DesignPreviewResult } from "../../src/shared/design.js";
import { createIpcDeps } from "../../src/main/ipc.js";
import { createDesktopDebugHistoryStore } from "../../src/main/debugHistory.js";
import { atomicWriteFile } from "../../src/main/atomicFile.js";
import { createSession } from "../../src/main/session.js";
import { countingStorage, findApi, IDS, makeApi, makeTempRoot, makeWorkspace, persistWorkspace, projectOne, uuid } from "./helpers/contract-assets.js";

function invokeRaw(deps: ReturnType<typeof createIpcDeps>, channel: string, ...args: unknown[]): Promise<unknown> {
  return Reflect.apply(deps.handle, undefined, [channel, null, ...args]) as Promise<unknown>;
}

function invokeFrom(deps: ReturnType<typeof createIpcDeps>, channel: string, event: unknown, ...args: unknown[]): Promise<unknown> {
  return Reflect.apply(deps.handle, undefined, [channel, event, ...args]) as Promise<unknown>;
}

function locators(groupId = IDS.groupOne, projectId = IDS.projectOne, collectionId = IDS.collectionOne) {
  const project = { workspaceId: IDS.workspace, groupId, projectId };
  const collection = { ...project, collectionId };
  return {
    project,
    collection,
    api: { ...collection, folderIds: [], apiId: IDS.sharedApi },
    otherApi: { ...collection, folderIds: [], apiId: IDS.secondApi },
  };
}

async function fileBytes(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.set(path.slice(root.length + 1).replaceAll("\\", "/"), (await readFile(path)).toString("base64"));
    }
  }
  await walk(root);
  return files;
}

describe("complete-locator IPC bridge", () => {
  it("accepts only full project scopes and saved stress report IDs for compare/export", () => {
    const scope = locators().project;
    expect(parseIpcArgs("stress:compare", [scope, { baseFile: "base.json", candidateFile: "next.json" }])).toEqual([scope, { baseFile: "base.json", candidateFile: "next.json" }]);
    expect(parseIpcArgs("stress:export", [scope, { file: "next.json", format: "html" }])).toEqual([scope, { file: "next.json", format: "html" }]);
    expect(() => parseIpcArgs("stress:compare", [scope, { baseFile: "../base.json", candidateFile: "next.json" }])).toThrow();
    expect(() => parseIpcArgs("stress:export", [{ projectId: scope.projectId }, { file: "next.json", format: "json" }])).toThrow();
    expect(() => parseIpcArgs("stress:export", [scope, { file: "next.json", format: "html", path: "C:/secret" }])).toThrow();
    expect(parseIpcArgs('stress-runs:list', [scope])).toEqual([scope]);
    expect(parseIpcArgs('stress-runs:get', [scope, 'next.json'])).toEqual([scope, 'next.json']);
    expect(() => parseIpcArgs('stress-runs:list', [{ projectId: scope.projectId }])).toThrow();
    expect(() => parseIpcArgs('stress-runs:get', [scope, '../next.json'])).toThrow();
  });
  it("uses strict Mock control DTOs and exposes no renderer file-read channel", () => {
    const locator = locators().project;
    const control = { locator, sourceProjectRevision: "source-revision" };
    const config = { formatVersion: 1, seed: "saved", enabledContractIds: [], rules: [] };
    expect(parseIpcArgs(IpcChannel.MockGet, [locator])).toEqual([locator]);
    expect(parseIpcArgs(IpcChannel.MockConfigSave, [{ ...control, config }])).toEqual([{ ...control, config }]);
    expect(parseIpcArgs(IpcChannel.MockStart, [{ ...control, port: 0 }])).toEqual([{ ...control, port: 0 }]);
    expect(parseIpcArgs(IpcChannel.MockStop, [control])).toEqual([control]);
    expect(parseIpcArgs(IpcChannel.MockReload, [control])).toEqual([control]);
    expect(parseIpcArgs(IpcChannel.MockProjectClose, [{ root: "C:/fixture", locator }])).toEqual([{ root: "C:/fixture", locator }]);
    expect(() => parseIpcArgs(IpcChannel.MockStart, [{ ...control, port: 65_536 }])).toThrow(/入参校验失败/);
    expect(() => parseIpcArgs(IpcChannel.MockConfigSave, [{ ...control, config, filePath: "C:/secret" }])).toThrow(/入参校验失败/);
    expect(() => parseIpcArgs(IpcChannel.MockProjectClose, [{ root: "C:/fixture", locator, generation: 1 }])).toThrow(/入参校验失败/);
    expect(Object.keys(IpcChannel).some((channel) => /read.?file|file.?read/i.test(channel))).toBe(false);
  });

  it("keeps the light workflow IPC schema in exact acceptance/default parity with Core", () => {
    const locator = { ...locators().project, workflowId: IDS.workflow };
    const validInputs: unknown[] = [
      { id: "minimal", name: "minimal workflow" },
      { id: "v2", name: "v2", executionVersion: 2, nodes: [{ id: "wait", kind: "delay", delayMs: 0 }], edges: [], inputs: {}, outputs: {} },
      {
        id: "all-optional-fields",
        name: "all optional fields",
        status: "published",
        nodes: [
          { id: "request-node", kind: "request", apiId: IDS.sharedApi, caseId: IDS.sharedCase, label: "request", position: { x: 12.5, y: -4 } },
          { id: "noop-node", kind: "noop", label: "pause", position: { x: 0, y: 1 } },
        ],
        edges: [{ id: "edge", from: "request-node", to: "noop-node", condition: "success" }],
      },
    ];
    for (const input of validInputs) {
      const core = CoreWorkflowSchema.parse(input);
      const ipc = parseIpcArgs(IpcChannel.WfSave, [locator, input]);
      expect(ipc[1]).toEqual(core);
    }
    expect(parseIpcArgs(IpcChannel.WfSave, [locator, validInputs[0]])[1]).toEqual({
      id: "minimal", name: "minimal workflow", status: "draft", nodes: [], edges: [],
    });

    const invalidInputs: unknown[] = [
      { id: "unknown-workflow-field", name: "invalid", extra: true },
      { id: "unknown-node-field", name: "invalid", nodes: [{ id: "node", kind: "noop", extra: true }] },
      { id: "unknown-edge-field", name: "invalid", edges: [{ id: "edge", from: "a", to: "b", extra: true }] },
      { id: "unknown-position-field", name: "invalid", nodes: [{ id: "node", kind: "noop", position: { x: 0, y: 0, extra: true } }] },
      { id: "bad-status", name: "invalid", status: "paused" },
      { id: "bad-kind", name: "invalid", nodes: [{ id: "node", kind: "delay" }] },
      { id: "bad-field-type", name: "invalid", nodes: [{ id: "node", kind: "request", apiId: 7 }] },
      { id: "bad-position-type", name: "invalid", nodes: [{ id: "node", kind: "noop", position: { x: "0", y: 0 } }] },
    ];
    for (const input of invalidInputs) {
      const coreAccepts = CoreWorkflowSchema.safeParse(input).success;
      let ipcAccepts = true;
      try {
        parseIpcArgs(IpcChannel.WfSave, [locator, input]);
      } catch {
        ipcAccepts = false;
      }
      expect(coreAccepts).toBe(false);
      expect(ipcAccepts).toBe(coreAccepts);
    }
  });

  it("reads the API selected by its full physical locator", async () => {
    const temporary = await makeTempRoot();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const session = createSession();
      await session.open(temporary.path);
      const deps = createIpcDeps({
        session,
        pickDirectory: async () => "",
        saveFile: async () => "",
      });
      const locator = {
        workspaceId: IDS.workspace,
        groupId: IDS.groupOne,
        projectId: IDS.projectOne,
        collectionId: IDS.collectionOne,
        folderIds: [],
        apiId: IDS.sharedApi,
      };

      const detail = await deps.handle(IpcChannel.ApiGet, null, locator);

      expect(detail).toMatchObject({
        locator,
        api: { contract: { id: IDS.sharedApi, metadata: { name: "project one API" } } },
        envs: [{ locator: { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne, environmentId: IDS.environment } }],
      });
      expect(detail.sourceApiRevision).toBe(getSourceApiRevision(detail.api));
      expect(detail.sourceProjectRevision).toEqual(expect.any(String));
      const draftRequest = { ...detail.api.contract.request, path: "/ipc-request-draft" };
      const savedDraft = await deps.handle(IpcChannel.ApiRequestDraftSave, null, locator, draftRequest, detail.sourceApiRevision, []);
      expect(savedDraft).toMatchObject({ request: draftRequest, sourceApiRevision: expect.any(String) });
      expect(session.locateApi(locator)?.api.contract.request.path).toBe("/ipc-request-draft");
      detail.api.contract.metadata.name = "mutated result view";
      expect(session.locateApi(locator)?.api.contract.metadata.name).toBe("project one API");
    } finally {
      await temporary.dispose();
    }
  });

  it("creates a free request asset through one validated IPC transaction", async () => {
    const temporary = await makeTempRoot();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const counted = countingStorage();
      const session = createSession({ storage: counted.storage });
      await session.open(temporary.path);
      counted.calls.length = 0;
      const deps = createIpcDeps({ session, pickDirectory: async () => "", saveFile: async () => "" });
      const project = locators().project;
      const definition = session.locateProject(project)?.project;
      if (!definition) throw new Error("Project fixture is unavailable");
      const request = structuredClone(definition.collections[0]!.apis[0]!.contract.request);
      const input = {
        project,
        targetParent: locators().collection,
        name: "project one API",
        request,
        sourceProjectRevision: createProjectSnapshot(definition).definitionRevision,
        fields: [],
      };

      const result = await invokeRaw(deps, IpcChannel.ApiCreateFromRequestDraft, input) as {
        locator: ReturnType<typeof locators>["api"];
        detail: { api: ReturnType<typeof makeApi>; locator: unknown };
      };

      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(1);
      expect(result.detail.locator).toEqual(result.locator);
      expect(result.detail.api.contract.metadata.name).toBe("project one API");
      expect(result.detail.api.contract.request).toEqual(request);
      expect(session.locateApi(result.locator)?.api).toEqual(result.detail.api);
      expect(() => parseIpcArgs(IpcChannel.ApiCreateFromRequestDraft, [{ ...input, unexpected: true }])).toThrow(/unexpected|校验/i);
    } finally {
      await temporary.dispose();
    }
  });

  it("rejects pending debug fields and known synthetic credential literals before any draft write", async () => {
    const temporary = await makeTempRoot("apicc-draft-guard-");
    try {
      const workspace = makeWorkspace();
      const asset = findApi(projectOne(workspace), IDS.sharedApi)!;
      asset.contract.request.auth = { kind: "bearer", token: { id: "synthetic-secret-ref", policy: "test-auto" } };
      await persistWorkspace(temporary.path, workspace);
      const counted = countingStorage();
      const session = createSession({ storage: counted.storage });
      await session.open(temporary.path);
      counted.calls.length = 0;
      let syntheticSecret = "synthetic-credential-literal-never-real";
      const secretStore: SecretStore = {
        put: async () => {},
        resolve: async (_scope, ref) => {
          if (ref.id !== "synthetic-secret-ref") throw new Error("unexpected ref");
          return syntheticSecret;
        },
        version: async () => "synthetic-version",
        remove: async () => {},
        status: async () => "available",
      };
      const deps = createIpcDeps({ session, credentials: { secretStore }, pickDirectory: async () => "", saveFile: async () => "" });
      const detail = await deps.handle(IpcChannel.ApiGet, null, locators().api) as { api: ReturnType<typeof makeApi>; sourceApiRevision: string };
      const request = structuredClone(detail.api.contract.request);
      if (request.protocol !== "http") throw new Error("Expected HTTP request");
      request.headers.push({ kind: "inline", id: uuid(999), name: "x-token", schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "", value: syntheticSecret });

      await expect(deps.handle(IpcChannel.ApiRequestDraftSave, null, locators().api, request, detail.sourceApiRevision, []))
        .rejects.toThrow(/credential literal|凭据字面值/i);
      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(0);

      await expect(deps.handle(IpcChannel.ApiRequestDraftSave, null, locators().api, { ...request, path: "/needs-input" }, detail.sourceApiRevision,
        [{ path: "request.headers[0].value", status: "redacted", needsInput: true }]))
        .rejects.toThrow(/complete|补齐|needs input/i);
      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(0);

      syntheticSecret = "abc";
      const shortLiteralRequest = structuredClone(detail.api.contract.request);
      if (shortLiteralRequest.protocol !== "http") throw new Error("Expected HTTP request");
      shortLiteralRequest.headers.push({ kind: "inline", id: uuid(998), name: "x-token", schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "", value: "Bearer abc" });
      await expect(deps.handle(IpcChannel.ApiRequestDraftSave, null, locators().api, shortLiteralRequest, detail.sourceApiRevision, []))
        .rejects.toThrow(/credential literal|凭据字面值/i);
      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(0);

      const selectedCase = session.locateApi(locators().api)!.api.cases[0]!;
      const unsafeCase = structuredClone(selectedCase);
      unsafeCase.parameters[`parameter-${syntheticSecret}-key`] = "ordinary safe value";
      await expect(deps.handle(IpcChannel.CaseDraftSave, null,
        { ...locators().api, caseId: selectedCase.id, scope: selectedCase.scope }, unsafeCase, detail.sourceApiRevision, [], []))
        .rejects.toThrow(/credential literal|凭据字面值/i);
      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(0);

      await expect(deps.handle(IpcChannel.CaseSave, null,
        { ...locators().api, caseId: selectedCase.id, scope: selectedCase.scope }, unsafeCase, detail.sourceApiRevision, []))
        .rejects.toThrow(/credential literal|凭据字面值/i);
      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(0);

      await expect(deps.handle(IpcChannel.CaseSave, null,
        { ...locators().api, caseId: selectedCase.id, scope: selectedCase.scope }, selectedCase, detail.sourceApiRevision,
        [{ path: "request.path", status: "redacted", needsInput: true }]))
        .rejects.toThrow(/complete|补齐|needs input/i);
      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(0);

      const validLegacyCase = structuredClone(selectedCase);
      validLegacyCase.name = "legacy case save";
      const legacySaved = await deps.handle(IpcChannel.CaseSave, null,
        { ...locators().api, caseId: selectedCase.id, scope: selectedCase.scope }, validLegacyCase, detail.sourceApiRevision, []) as { testCase: typeof selectedCase; sourceApiRevision: string };
      expect(legacySaved.testCase.name).toBe("legacy case save");
      expect(legacySaved.sourceApiRevision).not.toBe(detail.sourceApiRevision);
      counted.calls.length = 0;
      await expect(deps.handle(IpcChannel.CaseSave, null,
        { ...locators().api, caseId: selectedCase.id, scope: selectedCase.scope }, selectedCase, detail.sourceApiRevision, []))
        .rejects.toThrow(/revision|conflict|stale/i);
      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(0);

      const pendingCase = structuredClone(selectedCase);
      pendingCase.requestOverride = { ...detail.api.contract.request, path: "/needs-input" };
      await expect(deps.handle(IpcChannel.CaseDraftSave, null,
        { ...locators().api, caseId: selectedCase.id, scope: selectedCase.scope }, pendingCase, detail.sourceApiRevision, [],
        [{ path: "request.path", status: "redacted", needsInput: true }]))
        .rejects.toThrow(/complete|补齐|needs input/i);
      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(0);
      expect(session.locateApi(locators().api)?.api.cases[0]).toEqual(validLegacyCase);
      expect(session.locateApi(locators().api)?.api.contract.request.path).toBe("/items");
    } finally {
      await temporary.dispose();
    }
  });

  it("rejects known credential literals in legacy full-asset saves, including case overrides", async () => {
    const temporary = await makeTempRoot("apicc-full-asset-credential-guard-");
    try {
      const workspace = makeWorkspace();
      const asset = findApi(projectOne(workspace), IDS.sharedApi)!;
      asset.contract.request.auth = { kind: "bearer", token: { id: "synthetic-full-save-ref", policy: "test-auto" } };
      await persistWorkspace(temporary.path, workspace);
      const counted = countingStorage();
      const session = createSession({ storage: counted.storage });
      await session.open(temporary.path);
      counted.calls.length = 0;
      const secretStore: SecretStore = {
        put: async () => {},
        resolve: async (_scope, ref) => {
          if (ref.id !== "synthetic-full-save-ref") throw new Error("unexpected ref");
          return "synthetic-full-save-credential";
        },
        version: async () => "synthetic-version",
        remove: async () => {},
        status: async () => "available",
      };
      const deps = createIpcDeps({ session, credentials: { secretStore }, pickDirectory: async () => "", saveFile: async () => "" });
      const detail = await deps.handle(IpcChannel.ApiGet, null, locators().api) as { api: ReturnType<typeof makeApi>; sourceApiRevision: string };

      const unsafeDefault = structuredClone(detail.api);
      if (unsafeDefault.contract.request.protocol !== "http") throw new Error("Expected HTTP request");
      unsafeDefault.contract.request.headers.push({ kind: "inline", id: uuid(997), name: "x-token", schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "", value: "synthetic-full-save-credential" });
      await expect(deps.handle(IpcChannel.ApiSave, null, locators().api, unsafeDefault, detail.sourceApiRevision)).rejects.toThrow(/credential literal|凭据字面值/i);

      const unsafeCase = structuredClone(detail.api);
      const targetCase = unsafeCase.cases[0]!;
      targetCase.requestOverride = structuredClone(unsafeCase.contract.request);
      if (targetCase.requestOverride.protocol !== "http") throw new Error("Expected HTTP request");
      targetCase.requestOverride.headers.push({ kind: "inline", id: uuid(996), name: "x-token", schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "", value: "synthetic-full-save-credential" });
      await expect(deps.handle(IpcChannel.ApiSave, null, locators().api, unsafeCase, detail.sourceApiRevision)).rejects.toThrow(/credential literal|凭据字面值/i);

      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(0);
      expect(session.locateApi(locators().api)?.api.contract.request.headers).not.toContainEqual(expect.objectContaining({ value: "synthetic-full-save-credential" }));
      expect(session.locateApi(locators().api)?.api.cases[0]?.requestOverride).toBeUndefined();
    } finally {
      await temporary.dispose();
    }
  });

  it("rejects a draft save when the active root changes during credential lookup", async () => {
    const source = await makeTempRoot("apicc-draft-context-source-");
    const replacement = await makeTempRoot("apicc-draft-context-replacement-");
    try {
      const workspace = makeWorkspace();
      findApi(projectOne(workspace), IDS.sharedApi)!.contract.request.auth = {
        kind: "bearer", token: { id: "synthetic-context-ref", policy: "test-auto" },
      };
      await persistWorkspace(source.path, workspace);
      await persistWorkspace(replacement.path, workspace);

      const counted = countingStorage();
      const session = createSession({ storage: counted.storage });
      await session.open(source.path);
      let notifyResolveStarted!: () => void;
      const resolveStarted = new Promise<void>((resolve) => { notifyResolveStarted = resolve; });
      let unlockResolve!: (value: string) => void;
      const resolveGate = new Promise<string>((resolve) => { unlockResolve = resolve; });
      const secretStore: SecretStore = {
        put: async () => {},
        resolve: async () => { notifyResolveStarted(); return resolveGate; },
        version: async () => "synthetic-version",
        remove: async () => {},
        status: async () => "available",
      };
      const deps = createIpcDeps({ session, credentials: { secretStore }, pickDirectory: async () => "", saveFile: async () => "" });
      const detail = await deps.handle(IpcChannel.ApiGet, null, locators().api) as { api: ReturnType<typeof makeApi>; sourceApiRevision: string };
      const request = structuredClone(detail.api.contract.request);
      if (request.protocol !== "http") throw new Error("Expected HTTP request");
      request.path = "/must-not-write-to-replacement-root";
      counted.calls.length = 0;

      const saving = deps.handle(IpcChannel.ApiRequestDraftSave, null, locators().api, request, detail.sourceApiRevision, []);
      await resolveStarted;
      await session.open(replacement.path);
      unlockResolve("synthetic-context-secret");

      await expect(saving).rejects.toThrow(/context|workspace|工作区|上下文/i);
      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(0);
      expect(session.locateApi(locators().api)?.api.contract.request.path).toBe("/items");
    } finally {
      await source.dispose();
      await replacement.dispose();
    }
  });

  it("keeps history IPC lazy and accepts its storage root only from the host", async () => {
    const workspace = await makeTempRoot("apicc-history-ipc-workspace-");
    const privateHistory = await makeTempRoot("apicc-history-ipc-private-");
    try {
      await persistWorkspace(workspace.path, makeWorkspace());
      const session = createSession();
      await session.open(workspace.path);
      let factoryCalls = 0;
      const deps = createIpcDeps({
        session,
        pickDirectory: async () => "",
        saveFile: async () => "",
        debugHistory: () => {
          factoryCalls += 1;
          return createDesktopDebugHistoryStore({ privateRoot: privateHistory.path });
        },
      });

      await deps.handle(IpcChannel.ApiGet, null, locators().api);
      expect(factoryCalls).toBe(0);
      await expect(deps.handle(IpcChannel.DebugHistoryPreferencesGet, null)).resolves.toMatchObject({
        preferences: { enabled: true, retentionDays: 30, maxRecords: 1000 },
      });
      expect(factoryCalls).toBe(1);
      expect(() => parseIpcArgs(IpcChannel.DebugHistoryList, [{ root: privateHistory.path }])).toThrow(/入参校验失败/);
      await expect(deps.handle(IpcChannel.DebugHistoryPreferencesUpdate, null, {
        enabled: false,
        retentionDays: 30,
        maxRecords: 1000,
      })).resolves.toEqual({ enabled: false, retentionDays: 30, maxRecords: 1000 });
      expect(parseIpcArgs(IpcChannel.DebugHistoryList, [{}])[0]).toMatchObject({ limit: 50, offset: 0 });
      await expect(deps.handle(IpcChannel.DebugHistoryList, null, { limit: 50, offset: 0 })).resolves.toMatchObject({ items: [] });
    } finally {
      await workspace.dispose();
      await privateHistory.dispose();
    }
  });

  it("requires the caller project before restoring or replaying free-request history", async () => {
    const workspace = await makeTempRoot("apicc-free-history-context-workspace-");
    const replacement = await makeTempRoot("apicc-free-history-context-replacement-");
    const privateHistory = await makeTempRoot("apicc-free-history-context-private-");
    let serverHits = 0;
    const server = createServer((_request, response) => {
      serverHits += 1;
      response.end("ok");
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const workspaceValue = makeWorkspace();
      projectOne(workspaceValue).collections = [];
      await persistWorkspace(workspace.path, workspaceValue);
      await persistWorkspace(replacement.path, structuredClone(workspaceValue));
      const session = createSession();
      await session.open(workspace.path);
      const history = createDesktopDebugHistoryStore({ privateRoot: privateHistory.path });
      let announceRead: () => void = () => {};
      let delayedRead: Promise<void> | undefined;
      const historyWithDeferredRead = {
        ...history,
        get: async (historyId: string) => {
          const gate = delayedRead;
          if (gate) {
            delayedRead = undefined;
            announceRead();
            await gate;
          }
          return history.get(historyId);
        },
      };
      const deps = createIpcDeps({
        session,
        pickDirectory: async () => "",
        saveFile: async () => "",
        debugHistory: () => historyWithDeferredRead,
      });
      const event = { sender: {} };
      const request = {
        protocol: "http" as const,
        method: "GET" as const,
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        path: "/free-history",
        pathParams: [],
        query: [],
        headers: [],
        cookies: [],
        auth: { kind: "none" as const },
        body: { kind: "none" as const },
      };
      const project = locators().project;
      const started = await deps.handle(IpcChannel.DebugStart, event, {
        mode: "free",
        project,
        draftId: uuid(901),
        request,
        parameters: {},
        fields: [],
      }) as { runId: string };
      await deps.handle(IpcChannel.DebugWait, event, { runId: started.runId });
      const page = await deps.handle(IpcChannel.DebugHistoryList, null, { sourceKind: "free", limit: 50, offset: 0 }) as { items: Array<{ historyId: string }> };
      const historyId = page.items[0]!.historyId;
      expect(parseIpcArgs(IpcChannel.DebugHistoryRestore, [{ historyId, exchangeOrder: 1, project }])[0])
        .toEqual({ historyId, exchangeOrder: 1, project });
      expect(parseIpcArgs(IpcChannel.DebugHistoryReplay, [{ historyId, project }])[0]).toEqual({ historyId, project });

      const restored = await invokeRaw(deps, IpcChannel.DebugHistoryRestore, { historyId, exchangeOrder: 1, project }) as {
        invocation: { mode: string; project?: unknown };
        sourceChanged: boolean;
        sourceAvailable: boolean;
      };
      expect(restored).toMatchObject({
        invocation: { mode: "free", project },
        sourceChanged: false,
        sourceAvailable: true,
      });

      const replayed = await invokeFrom(deps, IpcChannel.DebugHistoryReplay, event, { historyId, project }) as { runId: string; sourceKind: string };
      expect(replayed).toMatchObject({ runId: expect.any(String), sourceKind: "free" });
      await deps.handle(IpcChannel.DebugWait, event, { runId: replayed.runId });
      expect(serverHits).toBe(2);

      const otherProject = locators(IDS.groupTwo, IDS.projectTwo).project;
      let mismatchedRestoreError: unknown;
      try {
        await invokeRaw(deps, IpcChannel.DebugHistoryRestore, { historyId, exchangeOrder: 1, project: otherProject });
      } catch (error) {
        mismatchedRestoreError = error;
      }
      expect(mismatchedRestoreError).toBeInstanceOf(Error);

      const expectReplayRefusal = async (input: unknown) => {
        let failure: unknown;
        try {
          const result = await invokeFrom(deps, IpcChannel.DebugHistoryReplay, event, input) as { runId?: string };
          if (result.runId) await deps.handle(IpcChannel.DebugWait, event, { runId: result.runId });
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(Error);
      };
      await expectReplayRefusal({ historyId, project: otherProject });
      let missingProjectRestoreError: unknown;
      try {
        await invokeRaw(deps, IpcChannel.DebugHistoryRestore, { historyId, exchangeOrder: 1 });
      } catch (error) {
        missingProjectRestoreError = error;
      }
      expect(missingProjectRestoreError).toBeInstanceOf(Error);
      await expectReplayRefusal(historyId);

      const hitsBeforeSwitch = serverHits;
      let unlockRead!: () => void;
      const readGate = new Promise<void>((resolve) => { unlockRead = resolve; });
      let readStarted!: () => void;
      const readStartedPromise = new Promise<void>((resolve) => { readStarted = resolve; });
      delayedRead = readGate;
      announceRead = readStarted;
      const switchedReplay = invokeFrom(deps, IpcChannel.DebugHistoryReplay, event, { historyId, project });
      await readStartedPromise;
      await session.open(replacement.path);
      unlockRead();
      let switchedReplayError: unknown;
      try {
        const result = await switchedReplay as { runId?: string };
        if (result.runId) await deps.handle(IpcChannel.DebugWait, event, { runId: result.runId });
      } catch (error) {
        switchedReplayError = error;
      }
      expect(switchedReplayError).toBeInstanceOf(Error);
      expect(serverHits).toBe(hitsBeforeSwitch);

      await session.open(workspace.path);
      await deps.handle(IpcChannel.NodeDelete, null, { kind: "project", locator: project });
      const unavailable = await invokeRaw(deps, IpcChannel.DebugHistoryRestore, { historyId, exchangeOrder: 1, project }) as {
        invocation: { mode: string; project?: unknown };
        sourceChanged: boolean;
        sourceAvailable: boolean;
      };
      expect(unavailable).toMatchObject({ invocation: { mode: "free", project }, sourceChanged: true, sourceAvailable: false });
      await expectReplayRefusal({ historyId, project });
      expect(serverHits).toBe(hitsBeforeSwitch);

      const noRootDeps = createIpcDeps({
        session: createSession(),
        pickDirectory: async () => "",
        saveFile: async () => "",
        debugHistory: () => historyWithDeferredRead,
      });
      const noRootRestore = await invokeRaw(noRootDeps, IpcChannel.DebugHistoryRestore, { historyId, exchangeOrder: 1, project }) as {
        invocation: { mode: string; project?: unknown };
        sourceChanged: boolean;
        sourceAvailable: boolean;
      };
      expect(noRootRestore).toMatchObject({ invocation: { mode: "free", project }, sourceChanged: true, sourceAvailable: false });
      let noRootReplayError: unknown;
      try {
        await invokeFrom(noRootDeps, IpcChannel.DebugHistoryReplay, event, { historyId, project });
      } catch (error) {
        noRootReplayError = error;
      }
      expect(noRootReplayError).toBeInstanceOf(Error);
      expect(serverHits).toBe(hitsBeforeSwitch);
    } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await workspace.dispose();
      await replacement.dispose();
      await privateHistory.dispose();
    }
  });

  it("returns the direct container-save result when another workspace open is queued immediately", async () => {
    const first = await makeTempRoot();
    const second = await makeTempRoot();
    try {
      const firstWorkspace = makeWorkspace();
      const secondWorkspace = makeWorkspace();
      secondWorkspace.id = "00000000-0000-4000-8000-000000000099";
      await persistWorkspace(first.path, firstWorkspace);
      await persistWorkspace(second.path, secondWorkspace);
      const secondBytesBefore = await fileBytes(second.path);

      const session = createSession();
      await session.open(first.path);
      const deps = createIpcDeps({ session, pickDirectory: async () => "", saveFile: async () => "" });
      const locator = {
        workspaceId: IDS.workspace,
        groupId: IDS.groupOne,
        projectId: IDS.projectOne,
        collectionId: IDS.collectionOne,
      };
      const operations = {
        preOperations: [{ id: "00000000-0000-4000-8000-000000000201", type: "script" as const, content: "pre" }],
        postOperations: [],
        variables: { token: "saved" },
      };

      const saving = deps.handle(IpcChannel.ContainerSave, null, { kind: "collection", locator, operations });
      const opening = deps.handle(IpcChannel.WsOpen, null, second.path);
      const [saveResult, openingResult] = await Promise.all([saving, opening]);

      expect(saveResult).toEqual({ kind: "collection", locator, operations });
      expect(openingResult.workspace).toEqual(secondWorkspace);
      expect(session.workspace).toEqual(secondWorkspace);
      expect(await fileBytes(second.path)).toEqual(secondBytesBefore);
      await session.open(second.path);
      expect(session.workspace).toEqual(secondWorkspace);
      expect(await fileBytes(second.path)).toEqual(secondBytesBefore);
      await session.open(first.path);
      expect(session.getContainer(locator)).toEqual(operations);
    } finally {
      await first.dispose();
      await second.dispose();
    }
  });

  it("creates every local node kind with full ancestry and reopens the persisted API", async () => {
    const temporary = await makeTempRoot();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const storage = countingStorage();
      let nextId = 100;
      const session = createSession({ storage: storage.storage, newId: () => uuid(++nextId) });
      await session.open(temporary.path);
      storage.calls.length = 0;
      const deps = createIpcDeps({ session, pickDirectory: async () => "", saveFile: async () => "" });

      const group = await deps.handle(IpcChannel.NodeCreate, null, { kind: "group", parent: { workspaceId: IDS.workspace }, name: "created group" }) as { kind: string; locator: { workspaceId: string; groupId: string }; key: string; source: string };
      const project = await deps.handle(IpcChannel.NodeCreate, null, { kind: "project", parent: group.locator, name: "created project" }) as { kind: string; locator: { workspaceId: string; groupId: string; projectId: string }; key: string; source: string };
      const collection = await deps.handle(IpcChannel.NodeCreate, null, { kind: "collection", parent: project.locator, name: "created collection" }) as { kind: string; locator: { workspaceId: string; groupId: string; projectId: string; collectionId: string }; key: string; source: string };
      const outerFolder = await deps.handle(IpcChannel.NodeCreate, null, { kind: "folder", parent: collection.locator, name: "outer" }) as { kind: string; locator: { workspaceId: string; groupId: string; projectId: string; collectionId: string; folderIds: string[] }; key: string; source: string };
      const innerFolder = await deps.handle(IpcChannel.NodeCreate, null, { kind: "folder", parent: outerFolder.locator, name: "inner" }) as typeof outerFolder;
      const api = await deps.handle(IpcChannel.NodeCreate, null, { kind: "api", parent: innerFolder.locator, api: { name: "created API", protocol: "http", method: "POST", path: "/created" } }) as { kind: string; locator: { workspaceId: string; groupId: string; projectId: string; collectionId: string; folderIds: string[]; apiId: string }; key: string; source: string; protocol: string; method: string };

      expect(group).toMatchObject({ kind: "group", source: "local", locator: { workspaceId: IDS.workspace }, key: expect.any(String) });
      expect(project).toMatchObject({ kind: "project", source: "local", locator: { groupId: group.locator.groupId }, key: expect.any(String) });
      expect(collection).toMatchObject({ kind: "collection", source: "local", locator: { projectId: project.locator.projectId }, key: expect.any(String) });
      expect(innerFolder.locator.folderIds).toEqual([outerFolder.locator.folderIds[0], innerFolder.locator.folderIds[1]]);
      expect(api).toMatchObject({ kind: "api", source: "local", protocol: "http", method: "POST", locator: { folderIds: innerFolder.locator.folderIds }, key: expect.any(String) });
      expect(storage.calls.filter((call) => call.kind === "save")).toHaveLength(6);

      await session.open(temporary.path);
      expect(session.locateApi(api.locator)?.api.contract).toMatchObject({
        id: api.locator.apiId,
        metadata: { name: "created API", status: "draft" },
        request: { protocol: "http", method: "POST", auth: { kind: "none" }, body: { kind: "none" } },
      });
      await expect(deps.handle(IpcChannel.ApiGet, null, api.locator)).resolves.toMatchObject({ locator: api.locator, api: { contract: { id: api.locator.apiId } } });
    } finally {
      await temporary.dispose();
    }
  });

  it("saves and renames the exact duplicate-id API and modifies only the selected physical case", async () => {
    const temporary = await makeTempRoot();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const storage = countingStorage();
      const session = createSession({ storage: storage.storage });
      await session.open(temporary.path);
      const deps = createIpcDeps({ session, pickDirectory: async () => "", saveFile: async () => "" });
      const first = locators(IDS.groupOne, IDS.projectOne);
      const second = locators(IDS.groupTwo, IDS.projectTwo, IDS.collectionTwo);
      const edited = structuredClone(session.locateApi(first.api)!.api);
      edited.contract.metadata.description = "edited at the first physical location";
      storage.calls.length = 0;

      const apiSaved = await deps.handle(IpcChannel.ApiSave, null, first.api, edited, getSourceApiRevision(session.locateApi(first.api)!.api)) as { api: typeof edited; sourceApiRevision: string };
      expect(apiSaved.api).toMatchObject({ contract: { id: IDS.sharedApi, metadata: { description: "edited at the first physical location" } } });
      const targetCase = { ...edited.cases.find((testCase) => testCase.scope === "blue")!, name: "blue edited" };
      await expect(deps.handle(IpcChannel.ApiGet, null, second.api)).resolves.toMatchObject({ locator: second.api, api: { contract: { metadata: { name: "project two API" } } } });
      await expect(deps.handle(IpcChannel.CaseSave, null, { ...first.api, caseId: targetCase.id, scope: targetCase.scope }, targetCase, apiSaved.sourceApiRevision, []))
        .resolves.toMatchObject({ testCase: { name: "blue edited", scope: "blue" }, sourceApiRevision: expect.any(String) });
      await expect(deps.handle(IpcChannel.ApiGet, null, second.api)).resolves.toMatchObject({ api: { contract: { metadata: { name: "project two API" } }, cases: [expect.objectContaining({ id: IDS.sharedCase, scope: "base" })] } });
      await deps.handle(IpcChannel.NodeRename, null, { kind: "api", locator: first.api }, "renamed first API");
      const green = edited.cases.find((testCase) => testCase.scope === "green")!;
      await deps.handle(IpcChannel.CaseDelete, null, { ...first.api, caseId: green.id, scope: green.scope });
      await deps.handle(IpcChannel.NodeDelete, null, { kind: "api", locator: second.api });
      expect(storage.calls.filter((call) => call.kind === "save")).toHaveLength(5);

      await session.open(temporary.path);
      const firstApi = session.locateApi(first.api)!.api;
      const secondApi = session.locateApi(second.api)?.api;
      expect(firstApi.contract.metadata).toMatchObject({ name: "renamed first API", description: "edited at the first physical location" });
      expect(firstApi.cases).toEqual([expect.objectContaining({ id: IDS.sharedCase, scope: "blue", name: "blue edited" })]);
      expect(secondApi).toBeUndefined();
      expect(session.locateApi(first.api)?.api.cases).toEqual([expect.objectContaining({ id: IDS.sharedCase, scope: "blue", name: "blue edited" })]);
      await expect(invokeRaw(deps, IpcChannel.ApiGet, IDS.sharedApi)).rejects.toThrow(/入参校验失败/);
      await expect(invokeRaw(deps, IpcChannel.ApiGet, { ...first.api, scope: "forged" })).rejects.toThrow(/入参校验失败/);
    } finally {
      await temporary.dispose();
    }
  });

  it("rejects malformed locators and folder variables before any storage write", async () => {
    const temporary = await makeTempRoot();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const storage = countingStorage();
      const session = createSession({ storage: storage.storage });
      await session.open(temporary.path);
      const deps = createIpcDeps({ session, pickDirectory: async () => "", saveFile: async () => "" });
      const valid = locators().api;
      const before = session.workspace;
      storage.calls.length = 0;

      await expect(invokeRaw(deps, IpcChannel.ApiGet, { ...valid, folderIds: [uuid(999)] })).rejects.toThrow(/未找到接口/);
      await expect(invokeRaw(deps, IpcChannel.ApiGet, { ...valid, unexpected: true })).rejects.toThrow(/入参校验失败/);
      await expect(invokeRaw(deps, IpcChannel.ApiGet, { ...valid, workspaceId: uuid(999) })).rejects.toThrow(/workspace|工作区/i);
      const { folderIds: _folderIds, ...missingFolders } = valid;
      await expect(invokeRaw(deps, IpcChannel.ApiGet, missingFolders)).rejects.toThrow(/入参校验失败/);
      await expect(invokeRaw(deps, IpcChannel.ContainerSave, {
        kind: "folder",
        locator: { ...valid, folderIds: [IDS.folderOne] },
        operations: { preOperations: [], postOperations: [], variables: {} },
      })).rejects.toThrow(/入参校验失败/);
      await expect(invokeRaw(deps, IpcChannel.NodeCreate, { kind: "api", parent: { ...locators().project }, api: { name: "wrong", unexpected: true } })).rejects.toThrow(/入参校验失败/);
      await expect(invokeRaw(deps, IpcChannel.NodeRename, { kind: "mystery", locator: valid }, "renamed")).rejects.toThrow(/入参校验失败/);
      expect(storage.calls.filter((call) => call.kind === "save")).toHaveLength(0);
      expect(session.workspace).toEqual(before);
    } finally {
      await temporary.dispose();
    }
  });

  it("round-trips environment, globals, stress policy and both container variants through fileStorage", async () => {
    const temporary = await makeTempRoot();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const storage = countingStorage();
      const session = createSession({ storage: storage.storage, newId: () => uuid(301) });
      await session.open(temporary.path);
      const deps = createIpcDeps({ session, pickDirectory: async () => "", saveFile: async () => "" });
      const { project, collection } = locators();
      const folder = { ...collection, folderIds: [IDS.folderOne, IDS.folderTwo] };
      storage.calls.length = 0;

      const environment = await deps.handle(IpcChannel.EnvCreate, null, {
        locator: project,
        name: "staging",
        extends: "dev",
        variables: { token: "staging-token", region: "west" },
        baseUrls: { [IDS.collectionOne]: "https://staging.example.test" },
      });
      const environmentLocator = { ...project, environmentId: environment.id };
      await deps.handle(IpcChannel.EnvVarsSave, null, environmentLocator, { token: "rotated-token", region: "east" });
      await deps.handle(IpcChannel.EnvBaseUrlsSave, null, environmentLocator, { [IDS.collectionOne]: "https://east.example.test" });

      const globals = {
        variables: { tenant: "north" },
        query: [{ key: "locale", value: "zh-CN", enabled: true }],
        headers: [{ key: "x-client", value: "apicc", enabled: false }],
        cookies: [{ key: "session", value: "credential-alias", enabled: true }],
        body: [{ key: "source", value: "desktop", enabled: true }],
      };
      await deps.handle(IpcChannel.GlobalsSave, null, project, globals);
      await deps.handle(IpcChannel.StressPolicySave, null, project, {
        trustedOrigins: ["https://api.example.test"],
        deniedOrigins: ["https://blocked.example.test"],
        maxConcurrency: 7,
        maxRps: 11,
      });
      const collectionOperations = {
        preOperations: [{ id: "collection-pre", type: "script" as const, content: "before()" }],
        postOperations: [{ id: "collection-post", type: "script" as const, content: "after()" }],
        variables: { token: "container-token" },
      };
      const folderOperations = {
        preOperations: [{ id: "folder-pre", type: "script" as const, content: "folderBefore()" }],
        postOperations: [],
      };
      await deps.handle(IpcChannel.ContainerSave, null, { kind: "collection", locator: collection, operations: collectionOperations });
      await deps.handle(IpcChannel.ContainerSave, null, { kind: "folder", locator: folder, operations: folderOperations });

      expect(await deps.handle(IpcChannel.ContainerGet, null, { kind: "collection", locator: collection })).toEqual({ kind: "collection", locator: collection, name: "collection one", operations: collectionOperations });
      expect(await deps.handle(IpcChannel.ContainerGet, null, { kind: "folder", locator: folder })).toEqual({ kind: "folder", locator: folder, name: "child", operations: folderOperations });
      expect(await deps.handle(IpcChannel.GlobalsGet, null, project)).toEqual(globals);
      expect(storage.calls.filter((call) => call.kind === "save")).toHaveLength(7);

      await session.open(temporary.path);
      expect(session.locateEnvironment(environmentLocator)).toMatchObject({ environment: { name: "staging", extends: "dev", variables: { token: "rotated-token", region: "east" }, baseUrls: { [IDS.collectionOne]: "https://east.example.test" } } });
      expect(await deps.handle(IpcChannel.GlobalsGet, null, project)).toEqual(globals);
      expect(session.workspace?.groups[0]?.projects[0]?.stressPolicy).toMatchObject({ trustedOrigins: ["https://api.example.test"], deniedOrigins: ["https://blocked.example.test"], maxConcurrency: 7, maxRps: 11 });
      expect(session.getContainer(collection)).toEqual(collectionOperations);
      expect(session.getContainer(folder)).toEqual(folderOperations);
    } finally {
      await temporary.dispose();
    }
  });

  it("creates, reads, lists, saves and deletes models and all four component kinds while protecting real references", async () => {
    const temporary = await makeTempRoot();
    try {
      const workspace = makeWorkspace();
      const project = projectOne(workspace);
      const api = findApi(project, IDS.sharedApi)!;
      if (api.contract.request.protocol !== "http") throw new Error("fixture protocol changed");
      api.contract.request.body = { kind: "json", content: "{}", schema: { kind: "modelRef", modelId: IDS.model } };
      api.contract.request.query = [{ kind: "componentRef", id: uuid(30), componentId: IDS.parameter, expectedKind: "parameter", enabled: true, value: "{{userId}}" }];
      api.contract.request.auth = { kind: "componentRef", componentId: IDS.auth, expectedKind: "auth" };
      api.contract.responses = [{ kind: "componentRef", id: uuid(31), componentId: IDS.response, expectedKind: "response" }];
      const parameter = project.components.find((component) => component.id === IDS.parameter && component.kind === "parameter");
      const response = project.components.find((component) => component.id === IDS.response && component.kind === "response");
      if (parameter?.kind !== "parameter" || response?.kind !== "response") throw new Error("fixture components changed");
      parameter.definition.schema = { kind: "modelRef", modelId: IDS.model };
      response.definition.content = { "application/json": { schema: { kind: "modelRef", modelId: IDS.model }, examples: [{ kind: "componentRef", id: uuid(32), componentId: IDS.example, expectedKind: "example" }] } };
      await persistWorkspace(temporary.path, workspace);

      const storage = countingStorage();
      let nextId = 400;
      const session = createSession({ storage: storage.storage, newId: () => uuid(++nextId) });
      await session.open(temporary.path);
      const deps = createIpcDeps({ session, pickDirectory: async () => "", saveFile: async () => "" });
      const projectLocator = locators().project;
      const modelLocator = { ...projectLocator, modelId: IDS.model };
      const parameterLocator = { ...projectLocator, componentKind: "parameter" as const, componentId: IDS.parameter };
      const authLocator = { ...projectLocator, componentKind: "auth" as const, componentId: IDS.auth };
      const responseLocator = { ...projectLocator, componentKind: "response" as const, componentId: IDS.response };
      const exampleLocator = { ...projectLocator, componentKind: "example" as const, componentId: IDS.example };
      const originalBytes = await fileBytes(temporary.path);

      expect(await deps.handle(IpcChannel.AssetReferences, null, projectLocator, IDS.model)).not.toHaveLength(0);
      expect(await deps.handle(IpcChannel.AssetReferences, null, projectLocator, IDS.parameter)).not.toHaveLength(0);
      expect(await deps.handle(IpcChannel.AssetReferences, null, projectLocator, IDS.auth)).not.toHaveLength(0);
      expect(await deps.handle(IpcChannel.AssetReferences, null, projectLocator, IDS.response)).not.toHaveLength(0);
      expect(await deps.handle(IpcChannel.AssetReferences, null, projectLocator, IDS.example)).not.toHaveLength(0);
      await expect(deps.handle(IpcChannel.NodeDelete, null, { kind: "api", locator: locators().api })).rejects.toThrow(/Cannot delete referenced API\/case/);
      await expect(deps.handle(IpcChannel.NodeDelete, null, { kind: "model", locator: modelLocator })).rejects.toThrow(/Asset is referenced/);
      await expect(deps.handle(IpcChannel.NodeDelete, null, { kind: "component", locator: parameterLocator })).rejects.toThrow(/Asset is referenced/);
      await expect(deps.handle(IpcChannel.NodeDelete, null, { kind: "component", locator: authLocator })).rejects.toThrow(/Asset is referenced/);
      await expect(deps.handle(IpcChannel.NodeDelete, null, { kind: "component", locator: responseLocator })).rejects.toThrow(/Asset is referenced/);
      await expect(deps.handle(IpcChannel.NodeDelete, null, { kind: "component", locator: exampleLocator })).rejects.toThrow(/Asset is referenced/);
      expect(storage.calls.filter((call) => call.kind === "save")).toHaveLength(0);
      expect(await fileBytes(temporary.path)).toEqual(originalBytes);

      const createdModel = await deps.handle(IpcChannel.ModelCreate, null, projectLocator, { name: "round-trip model", description: "created", schema: { kind: "scalar", type: "number" } });
      const newModelLocator = { ...projectLocator, modelId: createdModel.id };
      expect(await deps.handle(IpcChannel.ModelGet, null, newModelLocator)).toEqual(createdModel);
      expect(await deps.handle(IpcChannel.ModelList, null, projectLocator)).toContainEqual(createdModel);
      await deps.handle(IpcChannel.ModelSave, null, newModelLocator, { ...createdModel, description: "saved" });

      const parameterInput = { kind: "parameter" as const, name: "created parameter", description: "", definition: { location: "query" as const, name: "q", schema: { kind: "scalar" as const, type: "string" as const }, required: false, description: "" } };
      const authInput = { kind: "auth" as const, name: "created auth", description: "", definition: { kind: "bearer" as const, token: { id: "created-secret-ref", policy: "test-alias" } } };
      const responseInput = { kind: "response" as const, name: "created response", description: "", definition: { status: "201", description: "created", headers: {}, content: {} } };
      const exampleInput = { kind: "example" as const, name: "created example", description: "", definition: { name: "ok", value: { ok: true } } };
      const createdParameter = await deps.handle(IpcChannel.ComponentCreate, null, projectLocator, parameterInput);
      const createdAuth = await deps.handle(IpcChannel.ComponentCreate, null, projectLocator, authInput);
      const createdResponse = await deps.handle(IpcChannel.ComponentCreate, null, projectLocator, responseInput);
      const createdExample = await deps.handle(IpcChannel.ComponentCreate, null, projectLocator, exampleInput);
      const createdComponents = [createdParameter, createdAuth, createdResponse, createdExample];
      for (const component of createdComponents) {
        const locator = { ...projectLocator, componentKind: component.kind, componentId: component.id };
        expect(await deps.handle(IpcChannel.ComponentGet, null, locator)).toEqual(component);
        expect(await deps.handle(IpcChannel.ComponentList, null, projectLocator)).toContainEqual(component);
        await deps.handle(IpcChannel.ComponentSave, null, locator, { ...component, description: "saved" });
        await deps.handle(IpcChannel.NodeDelete, null, { kind: "component", locator });
      }
      await deps.handle(IpcChannel.NodeDelete, null, { kind: "model", locator: newModelLocator });
      expect(storage.calls.filter((call) => call.kind === "save")).toHaveLength(15);

      await session.open(temporary.path);
      expect(session.locateModel(newModelLocator)).toBeUndefined();
      expect(session.listModels(projectLocator)).toEqual(expect.arrayContaining([expect.objectContaining({ id: IDS.model })]));
      expect(session.listComponents(projectLocator).filter((component) => createdComponents.some((created) => created.id === component.id))).toHaveLength(0);
      expect(await deps.handle(IpcChannel.AssetReferences, null, projectLocator, IDS.model)).not.toHaveLength(0);
    } finally {
      await temporary.dispose();
    }
  });

  it("keeps writes pending through fileStorage, preserves bytes on revision conflict and refuses read-only writes", async () => {
    const temporary = await makeTempRoot();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      let release!: () => void;
      let markStarted!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      let delayedSaves = 0;
      const delayedStorage = {
        load: fileStorage.load,
        async save(root: string, workspace: Parameters<typeof fileStorage.save>[1], options: Parameters<typeof fileStorage.save>[2]) {
          delayedSaves += 1;
          markStarted();
          await gate;
          return fileStorage.save(root, workspace, options);
        },
      };
      const delayedSession = createSession({ storage: delayedStorage });
      await delayedSession.open(temporary.path);
      const delayedDeps = createIpcDeps({ session: delayedSession, pickDirectory: async () => "", saveFile: async () => "" });
      let settled = false;
      const pendingWrite = delayedDeps.handle(IpcChannel.NodeRename, null, { kind: "api", locator: locators().api }, "pending rename");
      void pendingWrite.then(() => { settled = true; }, () => { settled = true; });
      await started;
      expect(settled).toBe(false);
      expect(delayedSaves).toBe(1);
      release();
      await pendingWrite;
      expect(settled).toBe(true);
      expect(delayedSaves).toBe(1);

      const winner = createSession();
      const staleStorage = countingStorage();
      const stale = createSession({ storage: staleStorage.storage });
      await winner.open(temporary.path);
      await stale.open(temporary.path);
      const staleBefore = stale.workspace;
      const staleRevisionBefore = stale.revision;
      const winnerLocator = locators().api;
      const winnerApi = structuredClone(winner.locateApi(winnerLocator)!.api);
      winnerApi.contract.metadata.description = "winner revision";
      await winner.saveApi(winnerLocator, winnerApi);
      const committedBytes = await fileBytes(temporary.path);
      const staleApi = structuredClone(stale.locateApi(winnerLocator)!.api);
      staleApi.contract.metadata.description = "must not commit";
      const staleDeps = createIpcDeps({ session: stale, pickDirectory: async () => "", saveFile: async () => "" });
      await expect(staleDeps.handle(IpcChannel.ApiSave, null, winnerLocator, staleApi, getSourceApiRevision(stale.locateApi(winnerLocator)!.api))).rejects.toThrow(/revision|冲突|conflict/i);
      expect(staleStorage.calls.filter((call) => call.kind === "save")).toHaveLength(1);
      expect(stale.workspace).toEqual(staleBefore);
      expect(stale.revision).toBe(staleRevisionBefore);
      expect(await fileBytes(temporary.path)).toEqual(committedBytes);
      const reopened = createSession();
      await reopened.open(temporary.path);
      expect(reopened.locateApi(winnerLocator)?.api.contract.metadata.description).toBe("winner revision");

      let readOnlyWrites = 0;
      const readOnlyStorage = {
        async load(root: string) { return { ...await fileStorage.load(root), readOnly: true }; },
        async save() { readOnlyWrites += 1; throw new Error("read-only storage must not write"); },
      };
      const readOnly = createSession({ storage: readOnlyStorage });
      await readOnly.open(temporary.path);
      const readOnlyDeps = createIpcDeps({ session: readOnly, pickDirectory: async () => "", saveFile: async () => "" });
      const readOnlyBefore = readOnly.workspace;
      const readOnlyBytes = await fileBytes(temporary.path);
      await expect(readOnlyDeps.handle(IpcChannel.EnvVarsSave, null, { ...locators().project, environmentId: IDS.environment }, { token: "denied" })).rejects.toThrow(/只读/);
      expect(readOnlyWrites).toBe(0);
      expect(readOnly.workspace).toEqual(readOnlyBefore);
      expect(await fileBytes(temporary.path)).toEqual(readOnlyBytes);
    } finally {
      await temporary.dispose();
    }
  });

  it("exposes full workflow locators and keeps workflow impact scoped to the located project and case", async () => {
    const temporary = await makeTempRoot();
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const session = createSession();
      await session.open(temporary.path);
      const deps = createIpcDeps({ session, pickDirectory: async () => "", saveFile: async () => "" });
      const project = locators().project;
      const api = locators().api;
      const workflow = { ...project, workflowId: IDS.workflow };

      expect(await deps.handle(IpcChannel.WfList, null, project)).toEqual([expect.objectContaining({ id: IDS.workflow, locator: workflow, status: "draft" })]);
      expect(await deps.handle(IpcChannel.WfGet, null, workflow)).toEqual({ workflow: session.locateWorkflow(workflow)?.workflow, locator: workflow });
      expect(await deps.handle(IpcChannel.WfImpact, null, api)).toEqual([expect.objectContaining({ workflowId: IDS.workflow, status: "draft", nodeId: IDS.workflowNode })]);
      expect(await deps.handle(IpcChannel.WfImpact, null, { ...api, caseId: IDS.sharedCase })).toHaveLength(1);
      expect(await deps.handle(IpcChannel.WfImpact, null, { ...api, caseId: "not-referenced" })).toEqual([]);
      expect(await deps.handle(IpcChannel.WfImpact, null, { ...api, folderIds: [IDS.folderTwo] })).toEqual([]);
      await expect(invokeRaw(deps, IpcChannel.WfImpact, { ...api, caseId: IDS.sharedCase, scope: "blue" })).rejects.toThrow(/入参校验失败/);

      const created = await deps.handle(IpcChannel.WfCreate, null, { locator: project, name: "created workflow" });
      const createdLocator = { ...project, workflowId: created.id };
      expect(await deps.handle(IpcChannel.WfGet, null, createdLocator)).toEqual({ workflow: created, locator: createdLocator });
      const renamed = await deps.handle(IpcChannel.WfRename, null, createdLocator, "renamed workflow");
      expect(renamed.name).toBe("renamed workflow");
      const edited = { ...renamed, nodes: [{ id: "new-node", kind: "noop" as const, label: "saved node" }] };
      expect(await deps.handle(IpcChannel.WfSave, null, createdLocator, edited)).toEqual(edited);
      expect(await deps.handle(IpcChannel.WfSetStatus, null, createdLocator, "published")).toMatchObject({ workflow: { id: created.id, status: "published" }, errors: [] });
      await deps.handle(IpcChannel.WfDelete, null, createdLocator);

      const v2 = await deps.handle(IpcChannel.WfCreate, null, { locator: project, name: "v2 draft", executionVersion: 2 });
      expect(created.executionVersion).toBeUndefined(); // legacy callers still create v1
      expect(v2).toMatchObject({ executionVersion: 2, inputs: {}, outputs: {}, limits: { maxConcurrency: 4, timeoutMs: 300000 } });
      const v2Locator = { ...project, workflowId: v2.id };
      const v2Draft = CoreWorkflowSchema.parse({ ...v2, nodes: [{ id: "one", kind: "noop" }, { id: "two", kind: "noop" }], inputs: { count: { required: true, default: 0 } }, outputs: { count: { kind: "ref", source: "inputs", path: ["count"] } } });
      expect(await deps.handle(IpcChannel.WfSave, null, v2Locator, v2Draft)).toEqual(v2Draft);
      expect(() => parseIpcArgs(IpcChannel.WfCreate, [{ locator: project, name: "future", executionVersion: 3 }])).toThrow();

      await session.open(temporary.path);
      expect(session.locateWorkflow(v2Locator)?.workflow).toEqual(v2Draft);
      expect(session.locateWorkflow(createdLocator)).toBeUndefined();
      expect(session.locateWorkflow(workflow)?.workflow.status).toBe("draft");
      expect(await deps.handle(IpcChannel.WfImpact, null, { ...api, caseId: IDS.sharedCase })).toHaveLength(1);
    } finally {
      await temporary.dispose();
    }
  });

  it("previews imports, applies project/module assets, clones and moves only the selected complete project", async () => {
    const temporary = await makeTempRoot();
    try {
      const workspace = makeWorkspace();
      const duplicateProject = structuredClone(projectOne(workspace));
      workspace.groups.find((group) => group.id === IDS.groupTwo)!.projects.push(duplicateProject);
      await persistWorkspace(temporary.path, workspace);
      let importedProject = structuredClone(projectOne(makeWorkspace()));
      const sourceEnvironment = importedProject.environments[0]!;
      importedProject.environments = [
        { ...sourceEnvironment, name: "production / blue", baseUrls: { [IDS.collectionOne]: "https://production.example.test" } },
        { ...sourceEnvironment, id: uuid(902), name: "staging / blue", extends: "production / blue", baseUrls: { [IDS.collectionOne]: "https://staging.example.test" } },
      ];
      findApi(importedProject, IDS.sharedApi)!.cases.push({
        id: "staging-case",
        name: "staging smoke",
        scope: "staging / blue",
        parameters: {},
        preOperations: [],
        postOperations: [],
        assertions: [],
      });
      const importer: Importer = {
        name: "fixture-importer",
        detect: (fileName, content) => fileName.endsWith(".fixture") && content === "fixture content",
        parse: () => ({ project: structuredClone(importedProject), diagnostics: [], warnings: ["fixture warning"] }),
      };
      const session = createSession();
      await session.open(temporary.path);
      const deps = createIpcDeps({ session, importers: [importer], pickDirectory: async () => "", saveFile: async () => "" });
      const sourceProject = locators().project;
      const targetGroup = { workspaceId: IDS.workspace, groupId: IDS.groupTwo };
      const beforeConflictingMove = session.workspace;
      const bytesBeforeConflictingMove = await fileBytes(temporary.path);
      await expect(deps.handle(IpcChannel.ProjectMove, null, sourceProject, targetGroup)).rejects.toThrow(/Target project identity collision/);
      expect(session.workspace).toEqual(beforeConflictingMove);
      expect(await fileBytes(temporary.path)).toEqual(bytesBeforeConflictingMove);
      const preview = await deps.handle(IpcChannel.ImportPreview, null, { fileName: "api.fixture", content: "fixture content" });
      expect(preview).toMatchObject({ importerName: "fixture-importer", summary: { projectName: importedProject.name }, diagnostics: [expect.objectContaining({ message: "fixture warning" })] });
      expect(preview).not.toHaveProperty("project");
      const previewBefore = structuredClone(importedProject);
      let modulePreview = structuredClone(importedProject);
      const moduleApi = findApi(modulePreview, IDS.sharedApi)!;
      moduleApi.cases.push({
        id: "long-scope-case",
        name: "long scope smoke",
        scope: "." + " ".repeat(79) + "/",
        parameters: {},
        preOperations: [],
        postOperations: [],
        assertions: [],
      });
      const modulePreviewBefore = structuredClone(modulePreview);

      const fullProjectPlan = await deps.handle(IpcChannel.ImportPlan, null, { previewToken: preview.token, mode: "project", target: targetGroup, name: "Imported full project" });
      await deps.handle(IpcChannel.ImportApply, null, { planToken: fullProjectPlan.token, allowLossy: false });
      importedProject = modulePreview;
      const modulePreviewDto = await deps.handle(IpcChannel.ImportPreview, null, { fileName: "api.fixture", content: "fixture content" });
      expect(modulePreviewDto).not.toHaveProperty("project");
      const stagingOption = modulePreviewDto.summary.environments.find((option) => option.label === "staging / blue");
      if (!stagingOption) throw new Error("The source preview must expose its staging environment option");
      await deps.handle(IpcChannel.ImportApply, null, {
        planToken: (await deps.handle(IpcChannel.ImportPlan, null, {
          previewToken: modulePreviewDto.token,
          mode: "module",
          target: sourceProject,
          name: "Imported module",
          sourceEnvironmentOptionToken: stagingOption.optionToken,
        })).token,
        allowLossy: false,
      });
      expect(importedProject).toEqual(modulePreviewBefore);
      expect(modulePreview).toEqual(modulePreviewBefore);

      const beforeCyclicFullImport = session.workspace;
      const cyclicImportBytes = await fileBytes(temporary.path);
      const cyclicProject = structuredClone(importedProject);
      cyclicProject.environments[0]!.extends = cyclicProject.environments[1]!.name;
      importedProject = cyclicProject;
      const cyclicPreview = await deps.handle(IpcChannel.ImportPreview, null, { fileName: "api.fixture", content: "fixture content" });
      await expect(deps.handle(IpcChannel.ImportApply, null, {
        planToken: (await deps.handle(IpcChannel.ImportPlan, null, { previewToken: cyclicPreview.token, mode: "project", target: targetGroup, name: "Cyclic full project" })).token,
        allowLossy: false,
      })).rejects.toThrow(/Cyclic source environment inheritance/);
      expect(session.workspace).toEqual(beforeCyclicFullImport);
      expect(await fileBytes(temporary.path)).toEqual(cyclicImportBytes);

      await session.open(temporary.path);
      const importedFullProject = session.workspace!.groups.find((group) => group.id === IDS.groupTwo)!.projects.find((project) => project.name === "Imported full project")!;
      const [importedProduction, importedStaging] = importedFullProject.environments;
      expect(importedProduction!.name).not.toContain("/");
      expect(importedStaging!.name).not.toContain("/");
      expect(importedStaging!.extends).toBe(importedProduction!.name);
      const importedApi = importedFullProject.collections[0]!.apis[0]!;
      expect(importedApi.cases.find((testCase) => testCase.name === "staging smoke")!.scope)
        .toBe(importedStaging!.name);
      const importedModuleCollection = session.locateProject(sourceProject)!.project.collections.find((collection) => collection.name === "Imported module")!;
      expect(importedModuleCollection.variables.baseUrl).toBe("https://staging.example.test");
      expect(importedModuleCollection.apis[0]!.cases).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "blue", scope: "blue" }),
        expect.objectContaining({ name: "green", scope: "green" }),
        expect.objectContaining({ name: "staging smoke", scope: "staging - blue" }),
        expect.objectContaining({ name: "long scope smoke", scope: "未命名" }),
      ]));
      const scopeCollisionModule = structuredClone(importedProject);
      const scopeCollisionApi = findApi(scopeCollisionModule, IDS.sharedApi)!;
      const sourceScopedCase = scopeCollisionApi.cases.find((testCase) => testCase.name === "staging smoke")!;
      scopeCollisionApi.cases.push({ ...sourceScopedCase, scope: "staging - blue" });
      const scopeCollisionBefore = structuredClone(scopeCollisionModule);
      const beforeScopeCollision = session.workspace;
      const scopeCollisionBytes = await fileBytes(temporary.path);
      importedProject = scopeCollisionModule;
      const scopeCollisionPreview = await deps.handle(IpcChannel.ImportPreview, null, { fileName: "api.fixture", content: "fixture content" });
      await expect(deps.handle(IpcChannel.ImportApply, null, {
        planToken: (await deps.handle(IpcChannel.ImportPlan, null, { previewToken: scopeCollisionPreview.token, mode: "module", target: sourceProject, name: "scope collision module" })).token,
        allowLossy: false,
      })).rejects.toThrow(/case scopes collide after sanitization/i);
      expect(scopeCollisionModule).toEqual(scopeCollisionBefore);
      expect(session.workspace).toEqual(beforeScopeCollision);
      expect(await fileBytes(temporary.path)).toEqual(scopeCollisionBytes);
      const beforeAmbiguousModule = session.workspace;
      const ambiguousBytes = await fileBytes(temporary.path);
      const duplicateNameModule = structuredClone(modulePreviewBefore);
      duplicateNameModule.environments.push({ ...duplicateNameModule.environments[0]!, id: uuid(900), name: duplicateNameModule.environments[0]!.name, baseUrls: { [IDS.collectionOne]: "https://ambiguous.example.test" } });
      importedProject = duplicateNameModule;
      const duplicateNamePreview = await deps.handle(IpcChannel.ImportPreview, null, { fileName: "api.fixture", content: "fixture content" });
      await expect(deps.handle(IpcChannel.ImportApply, null, {
        planToken: (await deps.handle(IpcChannel.ImportPlan, null, { previewToken: duplicateNamePreview.token, mode: "module", target: sourceProject, name: "duplicate-name module" })).token,
        allowLossy: false,
      })).rejects.toThrow(`Ambiguous source environment name: ${duplicateNameModule.environments[0]!.name}`);
      expect(session.workspace).toEqual(beforeAmbiguousModule);
      expect(await fileBytes(temporary.path)).toEqual(ambiguousBytes);

      const distinctEnvironmentModule = structuredClone(modulePreviewBefore);
      distinctEnvironmentModule.environments.push({ ...distinctEnvironmentModule.environments[0]!, id: uuid(901), name: "preproduction", baseUrls: { [IDS.collectionOne]: "https://preproduction.example.test" } });
      importedProject = distinctEnvironmentModule;
      const distinctEnvironmentPreview = await deps.handle(IpcChannel.ImportPreview, null, { fileName: "api.fixture", content: "fixture content" });
      await expect(deps.handle(IpcChannel.ImportApply, null, {
        planToken: (await deps.handle(IpcChannel.ImportPlan, null, { previewToken: distinctEnvironmentPreview.token, mode: "module", target: sourceProject, name: "ambiguous-base-url module" })).token,
        allowLossy: false,
      })).rejects.toThrow(`Ambiguous source environment baseUrl for collection ${IDS.collectionOne}; choose a source environment`);
      expect(session.workspace).toEqual(beforeAmbiguousModule);
      expect(await fileBytes(temporary.path)).toEqual(ambiguousBytes);

      const cloned = await deps.handle(IpcChannel.ProjectClone, null, sourceProject);
      expect(cloned).toMatchObject({ name: "project one", collections: expect.any(Array) });
      expect(cloned.id).not.toBe(sourceProject.projectId);
      const cloneLocator = { ...sourceProject, projectId: cloned.id };
      expect(session.locateProject(cloneLocator)?.project).toEqual(cloned);

      const movingProject = locators(IDS.groupTwo, IDS.projectTwo, IDS.collectionTwo).project;
      await deps.handle(IpcChannel.ProjectMove, null, movingProject, { workspaceId: IDS.workspace, groupId: IDS.groupOne });
      await session.open(temporary.path);
      expect(session.locateProject(movingProject)).toBeUndefined();
      expect(session.locateProject({ ...movingProject, groupId: IDS.groupOne })?.project.id).toBe(IDS.projectTwo);
      expect(session.workspace?.groups[1]?.projects.some((item) => item.name === "Imported full project")).toBe(true);
      expect(session.locateProject(cloneLocator)?.project.id).toBe(cloned.id);
    } finally {
      await temporary.dispose();
    }
  });

  it("renders design export with the complete project's reference context and leaves authConfig session state untouched", async () => {
    const temporary = await makeTempRoot();
    try {
      const workspace = makeWorkspace();
      const project = projectOne(workspace);
      const api = findApi(project, IDS.sharedApi)!;
      if (api.contract.request.protocol !== "http") throw new Error("fixture protocol changed");
      api.contract.request.body = { kind: "json", content: "{}", schema: { kind: "modelRef", modelId: IDS.model } };
      api.contract.request.auth = { kind: "bearer", token: { id: "secret-value-should-not-export", policy: "fixture-reference-only" } };
      api.contract.metadata.description = "context-bearing design export";
      api.cases.push({
        id: uuid(777),
        name: "token=case-name-secret",
        scope: "base",
        parameters: { access_token: "case-parameter-secret" },
        preOperations: [{ id: "case-pre-op", type: "script", content: "case-script-secret" }],
        postOperations: [],
        assertions: [{ id: "case-assertion", target: "bodyJson", op: "eq", path: "private.path", expected: "case-expected-secret" }],
      });
      await persistWorkspace(temporary.path, workspace);
      const session = createSession();
      await session.open(temporary.path);
      let savedName = "";
      let savedContent = "";
      let savedFormat = "";
      let saveCalls = 0;
      let cancelNextSave = false;
      const tokenCalls: string[] = [];
      const createClientCalls: Array<{ baseUrl: string; onUnauthorized: () => void }> = [];
      let authConfigCalls = 0;
      let onlineMeCalls = 0;
      const tokenStore = {
        load: (baseUrl: string) => { tokenCalls.push(`load:${baseUrl}`); return null; },
        save: (baseUrl: string) => { tokenCalls.push(`save:${baseUrl}`); },
        clear: (baseUrl: string) => { tokenCalls.push(`clear:${baseUrl}`); },
      } as unknown as TokenStore;
      const deps = createIpcDeps({
        session,
        pickDirectory: async () => "",
        saveFile: async (name, content, format) => {
          saveCalls += 1;
          savedName = name;
          savedContent = content;
          savedFormat = format ?? "";
          if (cancelNextSave) {
            cancelNextSave = false;
            return "";
          }
          return "C:/exports/design.md";
        },
        online: {
          createClient: (baseUrl, hooks) => {
            createClientCalls.push({ baseUrl, onUnauthorized: hooks.onUnauthorized });
            return {
              async authConfig() { authConfigCalls += 1; return { allowRegistration: true }; },
              async login() { return { token: "resident-token", expiresAt: "2030-01-01T00:00:00.000Z", user: { id: "resident-user", username: "resident", displayName: "Resident" } }; },
              async getTree(workspaceId: string) { return { workspaceId, rootVersion: 1, files: [], projects: [] }; },
              async listGroups() { return []; },
              async me() { onlineMeCalls += 1; return { id: "resident-user", username: "resident", displayName: "Resident" }; },
            } as unknown as OnlineClient;
          },
          tokenStore,
        },
      });
      const apiLocator = locators().api;
      const exportInput = {
        sourceRoot: temporary.path,
        locator: apiLocator,
        format: "markdown" as const,
        scope: { kind: "project" as const },
      };
      const activeBefore = { root: session.root, workspace: session.workspace, revision: session.revision };

      await expect(deps.handle(IpcChannel.DesignExport, null, exportInput)).resolves.toBe("C:/exports/design.md");
      expect(savedName).toBe("project one.md");
      expect(savedFormat).toBe("markdown");
      expect(savedContent).toContain("context-bearing design export");
      expect(savedContent).toContain("Payload");
      expect(savedContent).toContain("| token=**** | base | 1 |");
      expect(savedContent).not.toContain("secret-value-should-not-export");
      expect(savedContent).not.toContain("case-parameter-secret");
      expect(savedContent).not.toContain("case-script-secret");
      expect(savedContent).not.toContain("case-expected-secret");
      expect(savedContent).not.toContain("private.path");
      await expect(deps.handle(IpcChannel.DesignExport, null, { ...exportInput, sourceRoot: "C:/stale-workspace" })).rejects.toThrow(/根目录已变化/);

      const htmlApiInput = { ...exportInput, format: "html" as const, scope: { kind: "apis" as const, contractIds: [apiLocator.apiId] } };
      await expect(deps.handle(IpcChannel.DesignExport, null, htmlApiInput)).resolves.toBe("C:/exports/design.md");
      expect(savedName).toBe("project one.html");
      expect(savedFormat).toBe("html");
      expect(savedContent).toContain("<!doctype html>");
      expect(savedContent).toContain("<td>token=****</td><td>base</td><td>1</td>");
      expect(savedContent).not.toContain("case-name-secret");
      expect(savedContent).not.toContain("case-parameter-secret");
      expect(savedContent).not.toContain("case-script-secret");
      expect(savedContent).not.toContain("case-expected-secret");
      expect(savedContent).not.toContain("private.path");
      const saveCallsAfterHtml = saveCalls;
      await expect(deps.handle(IpcChannel.DesignExport, null, { ...exportInput, scope: { kind: "tags", tags: ["no-such-tag"] } })).rejects.toThrow(/没有匹配/);
      expect(saveCalls).toBe(saveCallsAfterHtml);

      await deps.handle(IpcChannel.OnlineLogin, null, { baseUrl: "https://resident.example.test", username: "alice", password: "password8" });
      const residentView = await deps.handle(IpcChannel.OnlineWorkspaceOpen, null, { workspaceId: "resident-ws", name: "resident workspace", myRole: "EDITOR" });
      const residentMe = await deps.handle(IpcChannel.OnlineMe, null);
      const residentTreeBefore = await deps.handle(IpcChannel.OnlineTreeView, null, { workspaceId: "resident-ws" });
      const residentTokenCalls = [...tokenCalls];

      await expect(deps.handle(IpcChannel.OnlineAuthConfig, null, "https://contracts.example.test")).resolves.toEqual({ allowRegistration: true });
      expect(residentView.workspaceId).toBe("resident-ws");
      expect(createClientCalls.map((call) => call.baseUrl)).toEqual(["https://resident.example.test", "https://contracts.example.test"]);
      expect(createClientCalls[1]?.onUnauthorized).toBeTypeOf("function");
      expect(authConfigCalls).toBe(1);
      createClientCalls[1]!.onUnauthorized();
      expect(tokenCalls).toEqual(residentTokenCalls);
      await expect(deps.handle(IpcChannel.OnlineMe, null)).resolves.toEqual(residentMe);
      await expect(deps.handle(IpcChannel.OnlineTreeView, null, { workspaceId: "resident-ws" })).resolves.toEqual(residentTreeBefore);
      expect(onlineMeCalls).toBe(2);
      expect({ root: session.root, workspace: session.workspace, revision: session.revision }).toEqual(activeBefore);

      cancelNextSave = true;
      await expect(deps.handle(IpcChannel.DesignExport, null, exportInput)).resolves.toBe("");
      expect(savedContent).toContain("context-bearing design export");
      expect(savedContent).not.toContain("secret-value-should-not-export");

      const atomicTarget = join(temporary.path, "atomic-export.md");
      await writeFile(atomicTarget, "previous saved document", "utf8");
      await expect(atomicWriteFile(atomicTarget, "replacement document", async () => { throw new Error("replace denied"); })).rejects.toThrow("replace denied");
      await expect(readFile(atomicTarget, "utf8")).resolves.toBe("previous saved document");
      expect((await readdir(temporary.path)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);

      await expect(invokeRaw(deps, IpcChannel.OnlineAuthConfig)).rejects.toThrow(/入参校验失败/);
      await expect(invokeRaw(deps, IpcChannel.OnlineAuthConfig, "file:///tmp")).rejects.toThrow(/入参校验失败/);
      await expect(invokeRaw(deps, IpcChannel.OnlineAuthConfig, "https://contracts.example.test", "extra")).rejects.toThrow(/入参校验失败/);

      const offlineDeps = createIpcDeps({ session, pickDirectory: async () => "", saveFile: async () => "" });
      await expect(offlineDeps.handle(IpcChannel.OnlineAuthConfig, null, "https://contracts.example.test")).rejects.toThrow("在线功能未配置");
    } finally {
      await temporary.dispose();
    }
  });

  it("parses the complete run locator schemas and retains null, origin, and threshold input semantics", () => {
    const api = locators().api;
    const collection = locators().collection;
    const workflow = { ...locators().project, workflowId: IDS.workflow };
    const debug = { locator: api, caseId: IDS.sharedCase, envName: null };
    const runCollection = { locator: collection, envName: null };
    const runWorkflow = { locator: workflow, envName: null, strict: true };
    const stress = {
      locator: api,
      caseId: IDS.sharedCase,
      envName: null,
      concurrency: 2,
      maxIterations: null,
      durationMs: null,
      thresholds: { maxErrorRate: 0.1, minRps: 1 },
      confirmedTargetOrigins: ["https://api.example.test/"],
    };

    expect(parseIpcArgs(IpcChannel.DebugSend, [debug])).toEqual([debug]);
    expect(parseIpcArgs(IpcChannel.RunCollection, [runCollection])).toEqual([runCollection]);
    expect(parseIpcArgs(IpcChannel.WfRun, [runWorkflow])).toEqual([runWorkflow]);
    const invocation = { ...runWorkflow, invocationId: "10000000-0000-4000-8000-000000000001", inputs: { token: { nested: [1, null] } } };
    expect(parseIpcArgs(IpcChannel.WfRun, [invocation])).toEqual([invocation]);
    const ownInputs = JSON.parse('{"__proto__":{"x":1},"constructor":2}') as Record<string, unknown>;
    const ownParsed = parseIpcArgs(IpcChannel.WfRun, [{ ...invocation, inputs: ownInputs }])[0];
    expect(Object.keys(ownParsed.inputs!)).toEqual(["__proto__", "constructor"]);
    const cancel = { locator: runWorkflow.locator, invocationId: invocation.invocationId, root: "C:/workspace" };
    expect(parseIpcArgs(IpcChannel.WfCancel, [cancel])).toEqual([cancel]);
    expect(() => parseIpcArgs(IpcChannel.WfCancel, [{ ...cancel, extra: true }])).toThrow(/入参校验失败/);
    expect(parseIpcArgs(IpcChannel.StressRun, [stress])).toEqual([{ ...stress, confirmedTargetOrigins: ["https://api.example.test"] }]);
    expect(() => parseIpcArgs(IpcChannel.DebugSend, [{ apiId: api.apiId, caseId: IDS.sharedCase }])).toThrow(/入参校验失败/);
    expect(() => parseIpcArgs(IpcChannel.DebugSend, [{ ...debug, extra: true }])).toThrow(/入参校验失败/);
    expect(() => parseIpcArgs(IpcChannel.RunCollection, [{ collectionId: collection.collectionId }])).toThrow(/入参校验失败/);
    expect(() => parseIpcArgs(IpcChannel.WfRun, [{ workflowId: workflow.workflowId }])).toThrow(/入参校验失败/);
    expect(() => parseIpcArgs(IpcChannel.StressRun, [{ ...stress, locator: api.apiId }])).toThrow(/入参校验失败/);
    expect(() => parseIpcArgs(IpcChannel.StressRun, [{ ...stress, extra: true }])).toThrow(/入参校验失败/);
  });

  it("validates strict credential tuples and routes all three operations through the active Session", async () => {
    const validLocator = {
      workspaceId: "00000000-0000-0000-0000-000000000000",
      groupId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      projectId: IDS.projectOne,
    };
    const validRef = { id: "ref|秘密", policy: "test-auto" };
    const putInput = { locator: validLocator, ref: validRef, value: "" };
    expect(parseIpcArgs(IpcChannel.CredentialPut, [putInput])).toEqual([putInput]);
    expect(parseIpcArgs(IpcChannel.CredentialRemove, [{ locator: validLocator, ref: validRef }])).toEqual([{ locator: validLocator, ref: validRef }]);
    expect(parseIpcArgs(IpcChannel.CredentialStatus, [{ locator: validLocator, ref: validRef }])).toEqual([{ locator: validLocator, ref: validRef }]);
    for (const channel of [IpcChannel.CredentialPut, IpcChannel.CredentialRemove, IpcChannel.CredentialStatus]) {
      expect(() => parseIpcArgs(channel, [{ locator: { workspaceId: IDS.workspace, projectId: IDS.projectOne }, ref: validRef, value: "" }])).toThrow(/入参校验失败/);
      expect(() => parseIpcArgs(channel, [{ locator: locators().project, ref: { ...validRef, extra: true }, value: "" }])).toThrow(/入参校验失败/);
      expect(() => parseIpcArgs(channel, [{ locator: locators().project, ref: validRef, value: 1 }])).toThrow(/入参校验失败/);
      expect(() => parseIpcArgs(channel, [{ locator: locators().project, ref: validRef, value: "" }, "extra"])).toThrow(/入参校验失败/);
    }

    const temporary = await makeTempRoot("apicc-9b3b1-");
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const session = createSession();
      await session.open(temporary.path);
      const before = { workspace: session.workspace, revision: session.revision };
      const values = new Map<string, string>();
      const storeCalls: string[] = [];
      const secretStore: SecretStore = {
        async put(scope, ref, value) { storeCalls.push(`put:${scope.groupId}:${scope.projectId}:${ref.id}`); values.set(ref.id, value); },
        async resolve(_scope, ref) { return values.get(ref.id) ?? ""; },
        async version(_scope, ref) { return values.has(ref.id) ? "v1" : "missing"; },
        async remove(_scope, ref) { storeCalls.push(`remove:${ref.id}`); values.delete(ref.id); },
        async status(_scope, ref) { storeCalls.push(`status:${ref.id}`); return values.has(ref.id) ? "available" : "missing"; },
      };
      const deps = createIpcDeps({ session, pickDirectory: async () => "", saveFile: async () => "", credentials: { secretStore } });
      const input = { locator: locators().project, ref: { id: "ipc-new-ref", policy: "test-auto" } };

      await expect(deps.handle(IpcChannel.CredentialPut, null, { ...input, value: "ipc synthetic value" })).resolves.toEqual({ ok: true });
      await expect(deps.handle(IpcChannel.CredentialStatus, null, input)).resolves.toEqual({ ok: true, status: "available" });
      await expect(deps.handle(IpcChannel.CredentialRemove, null, input)).resolves.toEqual({ ok: true });
      expect(storeCalls).toEqual([`put:${IDS.groupOne}:${IDS.projectOne}:ipc-new-ref`, "status:ipc-new-ref", "remove:ipc-new-ref"]);
      await expect(invokeRaw(deps, IpcChannel.CredentialPut, { ...input, value: "", extra: true })).rejects.toThrow(/入参校验失败/);
      await expect(invokeRaw(deps, IpcChannel.CredentialStatus, { locator: { workspaceId: IDS.workspace, projectId: IDS.projectOne }, ref: input.ref })).rejects.toThrow(/入参校验失败/);
      expect(storeCalls).toHaveLength(3);
      expect(session.workspace).toEqual(before.workspace);
      expect(session.revision).toBe(before.revision);
    } finally {
      await temporary.dispose();
    }
  });

  it("executes effective desktop requests with file roots and isolated run/VU cookie sessions", async () => {
    const temporary = await makeTempRoot("apicc-desktop-consumers-");
    const payload = "synthetic-desktop-binary-payload";
    const requests: Array<{ path: string; authorization?: string; cookie?: string; body: string }> = [];
    let server: Server | undefined;
    try {
      server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        request.on("end", () => {
          const path = new URL(request.url ?? "/", `http://${request.headers.host}`).pathname;
          requests.push({ path, authorization: request.headers.authorization, cookie: request.headers.cookie, body: Buffer.concat(chunks).toString("utf8") });
          response.setHeader("content-type", "application/json");
          if (path === "/login") {
            response.setHeader("set-cookie", "desktop-run=ready; Path=/");
            response.end(JSON.stringify({ ok: true }));
          } else if (path === "/settings") {
            setTimeout(() => { if (!response.destroyed) response.end(JSON.stringify({ ok: true })); }, 250);
          } else {
            if (path === "/upload" && !request.headers.cookie) response.setHeader("set-cookie", "desktop-vu=ready; Path=/");
            response.end(JSON.stringify({ ok: true }));
          }
        });
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const workspace = makeWorkspace();
      const project = projectOne(workspace);
      const collection = project.collections.find((item) => item.id === IDS.collectionOne)!;
      const loginCaseId = "desktop-login-case";
      const uploadCaseId = IDS.sharedCase;
      const slowCaseId = "desktop-settings-case";
      const loginApi = makeApi(uuid(130), "desktop login", [{ id: loginCaseId, name: "login", scope: "base" }]);
      loginApi.contract.request.baseUrl = baseUrl;
      loginApi.contract.request.path = "/login";
      loginApi.contract.request.auth = { kind: "none" };
      const uploadApi = findApi(project, IDS.sharedApi)!;
      uploadApi.contract.request.baseUrl = baseUrl;
      uploadApi.contract.request.path = "/default-upload";
      uploadApi.contract.request.auth = { kind: "none" };
      uploadApi.cases = [{ id: uploadCaseId, name: "effective upload", scope: "base", parameters: {}, preOperations: [], postOperations: [], assertions: [] }];
      const uploadOverride = structuredClone(uploadApi.contract.request);
      uploadOverride.path = "/upload";
      uploadOverride.auth = { kind: "bearer", token: { id: "desktop-override-only-ref", policy: "test-auto" } };
      if (uploadOverride.protocol !== "http") throw new Error("Expected HTTP upload request");
      uploadOverride.body = { kind: "binary", file: { path: ".apicc/fixture.bin" }, contentType: "application/octet-stream" };
      uploadApi.cases[0]!.requestOverride = uploadOverride;
      uploadApi.cases[0]!.requestSettingsOverride = { headersTimeoutMs: 2_000 };

      const slowApiId = uuid(131);
      const slowApi = makeApi(slowApiId, "desktop settings", [{ id: slowCaseId, name: "selected settings", scope: "base" }]);
      slowApi.contract.request.baseUrl = baseUrl;
      slowApi.contract.request.path = "/default-settings";
      const slowOverride = structuredClone(slowApi.contract.request);
      slowOverride.path = "/settings";
      slowApi.cases[0]!.requestOverride = slowOverride;
      slowApi.cases[0]!.requestSettingsOverride = { headersTimeoutMs: 60 };
      collection.apis = [loginApi, uploadApi, slowApi];
      findApi(project, IDS.deepApi)!.cases = [];

      const workflow = project.workflows.find((item) => item.id === IDS.workflow)!;
      workflow.status = "enabled";
      workflow.nodes = [
        { id: "desktop-login-node", kind: "request", apiId: loginApi.contract.id, caseId: loginCaseId, label: "login", position: { x: 0, y: 0 } },
        { id: "desktop-upload-node", kind: "request", apiId: uploadApi.contract.id, caseId: uploadCaseId, label: "upload", position: { x: 1, y: 0 } },
        { id: "desktop-settings-node", kind: "request", apiId: slowApi.contract.id, caseId: slowCaseId, label: "settings", position: { x: 2, y: 0 } },
      ];
      workflow.edges = [
        { id: "desktop-login-upload", from: "desktop-login-node", to: "desktop-upload-node" },
        { id: "desktop-upload-settings", from: "desktop-upload-node", to: "desktop-settings-node" },
      ];
      await persistWorkspace(temporary.path, workspace);
      await mkdir(join(temporary.path, ".apicc"), { recursive: true });
      await writeFile(join(temporary.path, ".apicc", "fixture.bin"), payload);

      const session = createSession();
      await session.open(temporary.path);
      const secretStore: SecretStore = {
        async put() {},
        async resolve(_scope, ref) {
          if (ref.id !== "desktop-override-only-ref") throw new Error(`unexpected ref ${ref.id}`);
          return "synthetic-desktop-credential";
        },
        async version() { return "desktop-override-v1"; },
        async remove() {},
        async status() { return "available"; },
      };
      const deps = createIpcDeps({ session, credentials: { secretStore }, pickDirectory: async () => "", saveFile: async () => "" });
      const collectionLocator = locators().collection;
      const workflowLocator = { ...locators().project, workflowId: IDS.workflow };
      const uploadLocator = { ...locators().api };

      requests.length = 0;
      const collectionResult = await deps.handle(IpcChannel.RunCollection, null, { locator: collectionLocator, envName: null }) as { cases: Array<{ apiId: string; passed: boolean }> };
      const collectionUpload = requests.find((request) => request.path === "/upload");
      expect(collectionUpload).toMatchObject({ authorization: "Bearer synthetic-desktop-credential", cookie: "desktop-run=ready", body: payload });
      expect(collectionResult.cases.find((outcome) => outcome.apiId === slowApiId)?.passed).toBe(false);

      requests.length = 0;
      const workflowResult = await deps.handle(IpcChannel.WfRun, null, { locator: workflowLocator, envName: null, strict: true }) as {
        nodeResults: Array<{ nodeId: string; state: string }>;
      };
      const workflowUpload = requests.find((request) => request.path === "/upload");
      expect(workflowUpload).toMatchObject({ authorization: "Bearer synthetic-desktop-credential", cookie: "desktop-run=ready", body: payload });
      expect(workflowResult.nodeResults.find((node) => node.nodeId === "desktop-settings-node")?.state).toBe("failed");

      requests.length = 0;
      const stressResult = await deps.handle(IpcChannel.StressRun, null, {
        locator: uploadLocator, caseId: uploadCaseId, envName: null, concurrency: 1, maxIterations: 2, durationMs: null,
        thresholds: {}, connectionMode: "pooled", confirmedTargetOrigins: [baseUrl],
      }) as { ok: boolean; report?: { totalRequests: number; failed: number } };
      const stressUploads = requests.filter((request) => request.path === "/upload");
      expect(stressResult).toMatchObject({ ok: true, report: { totalRequests: 2, failed: 0 } });
      expect(stressUploads).toHaveLength(2);
      expect(stressUploads[0]).toMatchObject({ authorization: "Bearer synthetic-desktop-credential", body: payload });
      expect(stressUploads[0]?.cookie).toBeUndefined();
      expect(stressUploads[1]?.cookie).toContain("desktop-vu=ready");

      const settingsStress = await deps.handle(IpcChannel.StressRun, null, {
        locator: { ...uploadLocator, apiId: slowApiId }, caseId: slowCaseId, envName: null, concurrency: 1, maxIterations: 1, durationMs: null,
        thresholds: {}, connectionMode: "pooled", confirmedTargetOrigins: [baseUrl],
      }) as { ok: boolean; report?: { totalRequests: number; failed: number } };
      expect(settingsStress).toMatchObject({ ok: true, report: { totalRequests: 1, failed: 1 } });
    } finally {
      if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
      await temporary.dispose();
    }
  });

  it("previews a draft against its exact root and revision without saving or crossing project identity", async () => {
    const temporary = await makeTempRoot("apicc-design-preview-");
    try {
      await persistWorkspace(temporary.path, makeWorkspace());
      const counted = countingStorage();
      const session = createSession({ storage: counted.storage });
      await session.open(temporary.path);
      counted.calls.length = 0;
      const deps = createIpcDeps({ session, pickDirectory: async () => "", saveFile: async () => "" });
      const locator = locators().api;
      const located = session.locateApi(locator);
      if (!located) throw new Error("Project one API fixture is unavailable");
      const sourceProjectRevision = createProjectSnapshot(located.project).definitionRevision;
      const draft = structuredClone(located.api);
      draft.contract.metadata.name = "preview-only draft";
      draft.contract.request.path = "/preview-only";
      const input = { sourceRoot: temporary.path, locator, sourceProjectRevision, assetDraft: draft };

      const ready = await invokeRaw(deps, IpcChannel.DesignPreview, input) as DesignPreviewResult;
      expect(ready).toMatchObject({ status: "ready", source: "draft", sourceRoot: temporary.path, locator, sourceProjectRevision });
      if (ready.status !== "ready") throw new Error("Expected a successful draft preview");
      expect(ready.sourceApiRevision).toBe(getSourceApiRevision(draft));
      expect(ready.projection.sourceProjectRevision).toBe(sourceProjectRevision);
      expect(ready.projection.apis).toHaveLength(1);
      expect(ready.projection.apis[0]).toMatchObject({
        contractId: locator.apiId,
        metadata: { name: "preview-only draft" },
        request: { path: "/preview-only" },
      });
      expect(JSON.stringify(ready.projection)).not.toContain(temporary.path);
      expect(session.locateApi(locator)?.api.contract.metadata.name).toBe("project one API");
      expect(session.locateApi(locator)?.api.contract.request.path).toBe("/items");
      expect(session.locateApi(locators(IDS.groupTwo, IDS.projectTwo, IDS.collectionTwo).api)?.api.contract.metadata.name)
        .toBe("project two API");

      const wrongRoot = await invokeRaw(deps, IpcChannel.DesignPreview, {
        ...input,
        sourceRoot: `${temporary.path}-previous-root`,
      }) as DesignPreviewResult;
      expect(wrongRoot).toMatchObject({
        status: "conflict",
        code: "root-mismatch",
        diagnostics: [expect.objectContaining({ severity: "error", path: "sourceRoot" })],
      });

      const staleRevision = await invokeRaw(deps, IpcChannel.DesignPreview, {
        ...input,
        sourceProjectRevision: "stale-project-revision",
      }) as DesignPreviewResult;
      expect(staleRevision).toMatchObject({ status: "conflict", code: "project-revision-changed" });

      const wrongWorkspace = await invokeRaw(deps, IpcChannel.DesignPreview, {
        ...input,
        locator: { ...locator, workspaceId: uuid(900) },
      }) as DesignPreviewResult;
      expect(wrongWorkspace).toMatchObject({ status: "conflict", code: "locator-mismatch" });

      const invalidDraft = structuredClone(draft);
      invalidDraft.contract.metadata.status = "raw-secret-sentinel" as typeof invalidDraft.contract.metadata.status;
      const invalid = await invokeRaw(deps, IpcChannel.DesignPreview, { ...input, assetDraft: invalidDraft }) as DesignPreviewResult;
      expect(invalid).toMatchObject({
        status: "invalid",
        diagnostics: [expect.objectContaining({ code: "DOCUMENT_PREVIEW_INVALID_DRAFT", path: "contract.metadata.status" })],
      });
      expect(JSON.stringify(invalid)).not.toContain("raw-secret-sentinel");
      expect(counted.calls.filter((call) => call.kind === "save")).toHaveLength(0);
    } finally {
      await temporary.dispose();
    }
  });
});

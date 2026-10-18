// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ApiRequest, DebugInvocation, DebugResult } from "@apicc/core";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";
import { useDebugStore } from "../../../src/renderer/src/stores/debug.js";
import { createRequestTabsStore } from "../../../src/renderer/src/stores/requestTabs.js";
import type { ProjectLocator } from "../../../src/shared/locations.js";

async function seeded() {
  const api = createMemoryApi();
  api.seedWorkspace();
  const ws = useWorkspaceStore(api);
  await ws.open("/tmp/ws");
  const group = ws.tree!.children.find((node) => node.kind === "group" && node.children.some((child) =>
    child.kind === "project" && child.children.some((item) => item.kind === "collection" && item.children.some((apiItem) => apiItem.kind === "api"))));
  if (!group || group.kind !== "group") throw new Error("Memory workspace is missing the seeded project group");
  const project = group.children.find((node) => node.kind === "project" && node.children.some((item) => item.kind === "collection" && item.children.some((apiItem) => apiItem.kind === "api")));
  if (!project || project.kind !== "project") throw new Error("Memory group is missing the seeded project");
  const collectionNode = project.children.find((node) => node.kind === "collection");
  if (!collectionNode || collectionNode.kind !== "collection") throw new Error("Memory project is missing the seeded collection");
  const apiNode = collectionNode.children.find((node) => node.kind === "api");
  if (!apiNode || apiNode.kind !== "api") throw new Error("Memory collection is missing the seeded API");
  const context = () => ({ root: ws.root, readOnly: ws.readOnly });
  const editor = useEditorStore(api, context);
  await editor.load(apiNode.locator);
  const debug = useDebugStore(api, editor, context);
  return { api, ws, editor, debug, project, collectionNode, apiNode };
}

function fakeDebugResult(invocation: DebugInvocation, runId = "fake-run"): DebugResult {
  if (invocation.mode === "free") throw new Error("Asset debug-store fixture cannot represent a free result");
  const locator = invocation.mode === "request" ? invocation.locator : {
    workspaceId: invocation.case.workspaceId,
    groupId: invocation.case.groupId,
    projectId: invocation.case.projectId,
    collectionId: invocation.case.collectionId,
    folderIds: invocation.case.folderIds,
    apiId: invocation.case.apiId,
  };
  return {
    runId,
    source: { sourceKind: "asset", locator, sourceApiRevision: "source-api-revision" },
    sourceProjectRevision: "source-project-revision",
    executionSnapshotRevision: "execution-snapshot-revision",
    mode: invocation.mode,
    identityAvailable: true,
    startedAt: "2026-10-14T00:00:00.000Z",
    finishedAt: "2026-10-14T00:00:00.000Z",
    run: { collectionName: "fixture", startedAt: "2026-10-14T00:00:00.000Z", finishedAt: "2026-10-14T00:00:00.000Z", total: 1, passed: 1, failed: 0 },
    outcomes: [{ apiId: locator.apiId, apiName: "API", ...(invocation.mode === "case" ? { caseId: invocation.case.caseId } : {}), caseName: "debug", passed: true, durationMs: 1, assertions: [] }],
    exchanges: [],
    exchangeTotal: 0,
    omittedExchangeCount: 0,
    replay: invocation.mode === "request"
      ? { mode: "request", sourceKind: "asset", locator: invocation.locator, request: invocation.request, requestTemplate: invocation.request, parameters: invocation.parameters, fields: invocation.fields, identityAvailable: true, available: true }
      : { mode: "case", sourceKind: "asset", case: invocation.case, parameters: {}, fields: [], identityAvailable: true, available: true },
    console: [],
    warnings: [],
  };
}

function requestTabsFor(ws: Awaited<ReturnType<typeof useWorkspaceStore>>, project: ProjectLocator) {
  return createRequestTabsStore({
    getContext: () => ({ root: ws.root, project }),
    isDirty: () => false,
    isRunning: () => false,
    confirmClose: async () => true,
    cancelRun: async () => undefined,
    evict: () => undefined,
  });
}

describe("debug store", () => {
  it("从未保存的请求草稿发送，不先保存正式资源", async () => {
    const { api, editor, debug, project, apiNode } = await seeded();
    const environment = await api.envCreate({ locator: project.locator, name: "dev" });
    await editor.reloadEnvs();
    editor.api!.contract.request.baseUrl = "/sent";
    debug.selectEnv("dev");
    const submittedRequest = JSON.parse(JSON.stringify(editor.api!.contract.request)) as ApiRequest;
    const apiSave = vi.spyOn(api, "apiSave");
    const start = vi.spyOn(api, "debugStart").mockImplementation(async (_invocation) => ({ runId: "run-request-draft" }));
    vi.spyOn(api, "debugWait").mockImplementation(async ({ runId }) => fakeDebugResult({
      mode: "request", locator: apiNode.locator, request: submittedRequest, parameters: {}, fields: [], environmentId: environment.id,
    }, runId));
    await debug.send(editor);
    expect(apiSave).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      mode: "request", locator: apiNode.locator, request: submittedRequest, parameters: {}, fields: [], environmentId: environment.id,
    }));
    expect(editor.dirty).toBe(true);
    expect(debug.result?.runId).toBe("run-request-draft");
    expect(debug.sending).toBe(false);
  });

  it("发送失败时错误可见且状态复位", async () => {
    const { editor, debug } = await seeded();
    await debug.send(editor, () => Promise.reject(new Error("网络不可达")));
    expect(debug.error).toContain("网络不可达");
    expect(debug.sending).toBe(false);
  });

  it("case run明确使用已保存identity且不会隐式保存草稿", async () => {
    const { api, editor, debug, project } = await seeded();
    const testCase = editor.api!.cases[0]!;
    await api.envCreate({ locator: project.locator, name: "dev" });
    await editor.reloadEnvs();
    debug.selectEnv("dev");
    let captured: DebugInvocation | undefined;
    const runFn = async (invocation: DebugInvocation) => { captured = invocation; return fakeDebugResult(invocation); };
    await debug.runCase(editor, { caseId: testCase.id, scope: testCase.scope }, runFn);
    expect(captured).toMatchObject({ mode: "case", case: { caseId: testCase.id, scope: testCase.scope }, environmentId: editor.envs[0]?.id });

    editor.api!.cases[0]!.name = "unsaved";
    const apiSave = vi.spyOn(api, "apiSave");
    captured = undefined;
    await debug.runCase(editor, { caseId: testCase.id, scope: testCase.scope }, runFn);
    expect(captured).toBeUndefined();
    expect(apiSave).not.toHaveBeenCalled();
    expect(debug.error).toMatch(/显式保存/);
  });

  it("结果按完整接口身份驻留，并在切回时不重发", async () => {
    const { api, editor, debug, apiNode, collectionNode } = await seeded();
    const apiB = await api.nodeCreate({ kind: "api", parent: collectionNode.locator, api: { name: "接口B" } });
    if (apiB.kind !== "api") throw new Error("Memory API creation did not return an API node");
    const sent: string[] = [];
    const runFn = async (invocation: DebugInvocation) => {
      if (invocation.mode === "free") throw new Error("This store test only sends saved API requests");
      sent.push(invocation.locator.apiId);
      return fakeDebugResult(invocation, `run-${invocation.locator.apiId}`);
    };
    await debug.send(editor, runFn);
    expect(debug.result?.outcomes[0]?.apiId).toBe(apiNode.locator.apiId);
    await editor.load(apiB.locator);
    await debug.send(editor, runFn);
    expect(debug.result?.outcomes[0]?.apiId).toBe(apiB.locator.apiId);
    await editor.load(apiNode.locator);
    expect(debug.result?.outcomes[0]?.apiId).toBe(apiNode.locator.apiId);
    expect(sent).toEqual([apiNode.locator.apiId, apiB.locator.apiId]);
  });

  it("切换接口时丢弃迟到的旧结果", async () => {
    const { api, editor, debug, collectionNode } = await seeded();
    const apiB = await api.nodeCreate({ kind: "api", parent: collectionNode.locator, api: { name: "接口B" } });
    if (apiB.kind !== "api") throw new Error("Memory API creation did not return an API node");
    let finish!: (result: DebugResult) => void;
    const pending = debug.send(editor, (invocation) => new Promise((resolve) => { finish = (result = fakeDebugResult(invocation)) => resolve(result); }));
    await editor.load(apiB.locator);
    finish(fakeDebugResult({ mode: "request", locator: apiB.locator, request: editor.api!.contract.request, parameters: {}, fields: [] }, "late"));
    await pending;
    expect(debug.results).toEqual({});
    expect(debug.result).toBeNull();
  });

  it("不同请求签可并发发送，逆序完成也各自保留结果", async () => {
    const { api, ws, editor, apiNode, collectionNode } = await seeded();
    const created = await api.nodeCreate({ kind: "api", parent: collectionNode.locator, api: { name: "并发接口" } });
    if (created.kind !== "api") throw new Error("Memory API creation did not return an API node");
    await editor.load(created.locator);
    const project = { workspaceId: apiNode.locator.workspaceId, groupId: apiNode.locator.groupId, projectId: apiNode.locator.projectId };
    const requestTabs = createRequestTabsStore({
      getContext: () => ({ root: ws.root, project }),
      isDirty: () => false,
      isRunning: () => false,
      confirmClose: async () => true,
      cancelRun: async () => undefined,
      evict: () => undefined,
    });
    const debug = useDebugStore(api, editor, () => ({ root: ws.root, readOnly: ws.readOnly }), requestTabs);
    const tabAId = requestTabs.open({ kind: "asset", locator: apiNode.locator });
    const tabBId = requestTabs.open({ kind: "asset", locator: created.locator });
    const tabA = requestTabs.tabs[tabAId]!;
    const tabB = requestTabs.tabs[tabBId]!;
    const waits = new Map<string, (result: DebugResult) => void>();
    const invocations = new Map<string, DebugInvocation>();
    vi.spyOn(api, "debugStart").mockImplementation(async (invocation) => {
      const runId = invocation.mode === "request" ? invocation.locator.apiId : "unexpected-mode";
      invocations.set(runId, invocation);
      return { runId };
    });
    vi.spyOn(api, "debugWait").mockImplementation(async ({ runId }) => new Promise((resolve) => { waits.set(runId, resolve); }));

    const sendingA = debug.sendRequestTab(tabA, editor);
    const sendingB = debug.sendRequestTab(tabB, editor);
    await vi.waitFor(() => expect(waits.size).toBe(2));
    requestTabs.activate(tabAId);
    waits.get(created.locator.apiId)!(fakeDebugResult(invocations.get(created.locator.apiId)!, created.locator.apiId));
    waits.get(apiNode.locator.apiId)!(fakeDebugResult(invocations.get(apiNode.locator.apiId)!, apiNode.locator.apiId));
    await Promise.all([sendingA, sendingB]);

    expect(debug.requestTabs[tabAId]?.result?.runId).toBe(apiNode.locator.apiId);
    expect(debug.requestTabs[tabBId]?.result?.runId).toBe(created.locator.apiId);
    expect(debug.requestTabs[tabAId]?.sending).toBe(false);
    expect(debug.requestTabs[tabBId]?.sending).toBe(false);
  });

  it("array-style Core field paths repair the intended value and clear only that pending marker", async () => {
    const { api, editor, debug, apiNode } = await seeded();
    const request = JSON.parse(JSON.stringify(editor.api!.contract.request)) as ApiRequest;
    if (request.protocol !== "http") throw new Error("Expected HTTP request");
    request.headers.push({ kind: "inline", id: "header-1", name: "x-token", schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "", value: "[REDACTED]" });
    const invocation: Extract<DebugInvocation, { mode: "request" }> = {
      mode: "request", locator: apiNode.locator, request, parameters: {},
      fields: [{ path: "request.headers[0].value", status: "redacted", needsInput: true }, { path: "request.path", status: "missing", needsInput: true }],
    };
    expect(debug.applyRestore(invocation, true, editor)).toBe(true);
    debug.repairRestoredField("request.headers[0].value", "synthetic-header", editor);
    expect(editor.api!.contract.request).toMatchObject({ headers: [{ value: "synthetic-header" }] });
    expect(debug.restoredFields).toEqual([
      { path: "request.headers[0].value", status: "redacted", needsInput: false },
      { path: "request.path", status: "missing", needsInput: true },
    ]);
    expect(api).toBeDefined();
  });

  it("history replay stores and guards the historical source slot instead of the active editor slot", async () => {
    const { api, editor, debug, apiNode, collectionNode } = await seeded();
    const apiB = await api.nodeCreate({ kind: "api", parent: collectionNode.locator, api: { name: "接口B" } });
    if (apiB.kind !== "api") throw new Error("Memory API creation did not return an API node");
    await editor.load(apiB.locator);
    const replayResult = fakeDebugResult({ mode: "request", locator: apiNode.locator, request: apiNode.locator ? (await api.apiGet(apiNode.locator)).api.contract.request : editor.api!.contract.request, parameters: {}, fields: [] }, "historical-A");
    api.debugHistoryReplay = async () => ({ runId: "history-A", sourceKind: "asset", locator: apiNode.locator });
    api.debugWait = async () => replayResult;
    await debug.replay("history-id", editor, apiNode.locator);
    expect(Object.values(debug.results)).toEqual([replayResult]);
    expect(debug.result).toBeNull();
    await editor.load(apiNode.locator);
    expect(debug.result?.runId).toBe("historical-A");
  });

  it("discards a late history restore after the active API generation changes", async () => {
    const { api, ws, editor, debug, apiNode, collectionNode } = await seeded();
    const before = JSON.parse(JSON.stringify(editor.api!.contract.request)) as ApiRequest;
    const invocation: Extract<DebugInvocation, { mode: "request" }> = {
      mode: "request", locator: apiNode.locator, request: { ...before, path: "/historical" }, parameters: {}, fields: [],
    };
    let release!: (value: { invocation: typeof invocation; sourceChanged: boolean; sourceAvailable: boolean }) => void;
    api.debugHistoryRestore = async () => new Promise((resolve) => { release = resolve; });
    const restoring = debug.restoreHistory({ historyId: "00000000-0000-4000-8000-000000000001", exchangeOrder: 1 }, apiNode.locator, editor);
    await Promise.resolve();
    const second = await api.nodeCreate({ kind: "api", parent: collectionNode.locator, api: { name: "接口B" } });
    if (second.kind !== "api") throw new Error("Memory API creation did not return an API node");
    await editor.load(second.locator);
    release({ invocation, sourceChanged: false, sourceAvailable: true });
    await restoring;
    expect(editor.api!.contract.request.path).toBe((await api.apiGet(second.locator)).api.contract.request.path);
    expect(debug.restoredTargetKey).toBeNull();
    expect(ws.root).toBe("/tmp/ws");
  });

  it("discards a late free history restore after the active request generation changes", async () => {
    const { api, editor, debug, collectionNode, apiNode } = await seeded();
    const request = JSON.parse(JSON.stringify(editor.api!.contract.request)) as ApiRequest;
    const freeInvocation: Extract<DebugInvocation, { mode: "free" }> = {
      mode: "free",
      project: { workspaceId: apiNode.locator.workspaceId, groupId: apiNode.locator.groupId, projectId: apiNode.locator.projectId },
      draftId: "10000000-0000-4000-8000-000000000099",
      request: { ...request, path: "/late-free" },
      parameters: {},
      fields: [],
    };
    let release!: (value: { invocation: typeof freeInvocation; sourceChanged: boolean; sourceAvailable: boolean }) => void;
    api.debugHistoryRestore = async () => new Promise((resolve) => { release = resolve; });
    const restoring = debug.restoreHistory({ historyId: "00000000-0000-4000-8000-000000000001", exchangeOrder: 1 }, apiNode.locator, editor);
    await Promise.resolve();
    const second = await api.nodeCreate({ kind: "api", parent: collectionNode.locator, api: { name: "接口B" } });
    if (second.kind !== "api") throw new Error("Memory API creation did not return an API node");
    await editor.load(second.locator);
    debug.error = "当前请求的错误";
    debug.restoredSourceAvailable = false;
    release({ invocation: freeInvocation, sourceChanged: false, sourceAvailable: true });
    await restoring;

    expect(debug.error).toBe("当前请求的错误");
    expect(debug.restoredSourceAvailable).toBe(false);
    expect(debug.restoredPreview).toBeNull();
  });

  it("keeps a missing-source restore as a read-only preview without changing the active API", async () => {
    const { editor, debug, apiNode } = await seeded();
    const original = JSON.stringify(editor.api!.contract.request);
    const invocation: Extract<DebugInvocation, { mode: "request" }> = {
      mode: "request", locator: apiNode.locator, request: { ...editor.api!.contract.request, path: "/readonly-history" },
      parameters: {}, fields: [{ path: "request.headers[0].value", status: "redacted", needsInput: true }],
    };
    expect(debug.applyRestore(invocation, false, editor)).toBe(true);
    expect(JSON.stringify(editor.api!.contract.request)).toBe(original);
    expect(debug.restoredPreview).toMatchObject({ locator: apiNode.locator, request: { path: "/readonly-history" } });
    expect(debug.restoredTargetKey).toBeNull();
    expect(debug.restoredPreview?.fields[0]?.needsInput).toBe(true);
  });

  it("keeps a pending restore bound to API A across API B and a read-only preview", async () => {
    const { api, editor, debug, collectionNode, apiNode } = await seeded();
    const apiB = await api.nodeCreate({ kind: "api", parent: collectionNode.locator, api: { name: "接口B" } });
    if (apiB.kind !== "api") throw new Error("Memory API creation did not return an API node");
    const requestA = JSON.parse(JSON.stringify(editor.api!.contract.request)) as ApiRequest;
    const restoreA: Extract<DebugInvocation, { mode: "request" }> = {
      mode: "request", locator: apiNode.locator, request: { ...requestA, path: "/redacted-a" }, parameters: {},
      fields: [{ path: "request.path", status: "redacted", needsInput: true }],
    };
    expect(debug.applyRestore(restoreA, true, editor)).toBe(true);
    const apiSave = vi.spyOn(api, "apiSave");
    await editor.load(apiB.locator);
    const readonlyB: Extract<DebugInvocation, { mode: "request" }> = {
      mode: "request", locator: apiB.locator, request: { ...editor.api!.contract.request, path: "/readonly-b" }, parameters: {},
      fields: [{ path: "request.path", status: "redacted", needsInput: true }],
    };
    expect(debug.applyRestore(readonlyB, false, editor)).toBe(true);
    await editor.load(apiNode.locator);
    const send = vi.fn(async (invocation: DebugInvocation) => fakeDebugResult(invocation));
    await debug.send(editor, send);

    expect(send).not.toHaveBeenCalled();
    expect(debug.restoredFields).toEqual([{ path: "request.path", status: "redacted", needsInput: true }]);
    expect(editor.api!.contract.request.path).toBe("/redacted-a");
    expect(apiSave).not.toHaveBeenCalled();
  });

  it("formal history restore is the request-tab send/save owner until repaired, then sends the complete restored context", async () => {
    const { api, ws, editor, project, apiNode } = await seeded();
    const environment = await api.envCreate({ locator: project.locator, name: "restore-dev" });
    await editor.reloadEnvs();
    const tabs = requestTabsFor(ws, project.locator);
    const tabId = tabs.open({ kind: "asset", locator: apiNode.locator });
    const tab = tabs.tabs[tabId]!;
    const debug = useDebugStore(api, editor, () => ({ root: ws.root, readOnly: ws.readOnly }), tabs);
    const request: Extract<DebugInvocation, { mode: "request" }> = {
      mode: "request",
      locator: apiNode.locator,
      request: { ...editor.api!.contract.request, path: "/restored" },
      parameters: { token: "restored-parameter" },
      fields: [{ path: "request.path", status: "redacted", needsInput: true }],
      environmentId: environment.id,
      settings: { totalTimeoutMs: 4321 },
      parentHistoryId: "10000000-0000-4000-8000-000000000099",
    };
    const state = debug.requestTabState(tab);
    const run = vi.fn(async (invocation: DebugInvocation) => fakeDebugResult(invocation));
    const saveRequest = vi.spyOn(api, "apiRequestDraftSave");

    expect(debug.applyRestore(request, true, editor)).toBe(true);
    await debug.sendRequestTab(tab, editor, run);
    expect.soft(run).not.toHaveBeenCalled();
    const prematureSave = await editor.saveRequestDraft(state.fields).then(() => "saved", () => "rejected");
    expect.soft(prematureSave).toBe("rejected");
    expect.soft(saveRequest).not.toHaveBeenCalled();
    expect(state.fields).toEqual(request.fields);

    debug.repairRestoredField("request.path", "/completed", editor);
    await editor.saveRequestDraft(state.fields);
    await debug.sendRequestTab(tab, editor, run);

    expect(saveRequest).toHaveBeenCalledWith(apiNode.locator, expect.objectContaining({ path: "/completed" }), expect.any(String), [
      { path: "request.path", status: "redacted", needsInput: false },
    ]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      mode: "request", locator: apiNode.locator, request: expect.objectContaining({ path: "/completed" }),
      parameters: { token: "restored-parameter" }, fields: [{ path: "request.path", status: "redacted", needsInput: false }],
      environmentId: environment.id, settings: { totalTimeoutMs: 4321 }, parentHistoryId: request.parentHistoryId,
    }));
  });

  it("same free tab's later context load wins and an earlier reply cannot overwrite its edits", async () => {
    const { api, ws, editor, project } = await seeded();
    const detail = await api.debugProjectContext(project.locator);
    const originalContext = api.debugProjectContext;
    const replies: Array<(value: typeof detail) => void> = [];
    api.debugProjectContext = async () => new Promise((resolve) => { replies.push(resolve); });
    const tabs = requestTabsFor(ws, project.locator);
    const tabId = tabs.open({ kind: "free", project: project.locator, draftId: "10000000-0000-4000-8000-000000000031" });
    const tab = tabs.tabs[tabId]!;
    try {
      const firstLoad = editor.loadFreeRequestTab(tab, () => tabs.isCurrent(tabId, tab.generation, tab.root));
      const secondLoad = editor.loadFreeRequestTab(tab, () => tabs.isCurrent(tabId, tab.generation, tab.root));
      await vi.waitFor(() => expect(replies).toHaveLength(2));
      replies[1]!(detail);
      const newerSession = await secondLoad;
      if (!newerSession) throw new Error("The current free tab did not load its project context");
      const residentSession = editor.freeSessions[tabId];
      if (!residentSession) throw new Error("The loaded free session was not retained in the editor store");
      expect(residentSession.generation).toBe(newerSession.generation);
      residentSession.request.path = "/edited-after-load";
      replies[0]!(detail);
      await firstLoad;

      expect(editor.freeSessions[tabId]).toBe(residentSession);
      expect(editor.freeSessions[tabId]?.request.path).toBe("/edited-after-load");
      expect(editor.freeSessions[tabId]?.generation).toBe(residentSession.generation);
    } finally {
      for (const release of replies) release(detail);
      api.debugProjectContext = originalContext;
    }
  });

  it("existing case and history runs share the asset request-tab admission, result, options, and view state", async () => {
    const { api, ws, editor, project, apiNode } = await seeded();
    const environment = await api.envCreate({ locator: project.locator, name: "tab-dev" });
    await editor.reloadEnvs();
    const tabs = requestTabsFor(ws, project.locator);
    const tabAId = tabs.open({ kind: "asset", locator: apiNode.locator });
    const tabA = tabs.tabs[tabAId]!;
    const apiB = await api.nodeCreate({ kind: "api", parent: project.children.find((node) => node.kind === "collection")!.locator, api: { name: "并行状态接口" } });
    if (apiB.kind !== "api") throw new Error("Memory API creation did not return an API node");
    const tabBId = tabs.open({ kind: "asset", locator: apiB.locator });
    const tabB = tabs.tabs[tabBId]!;
    const debug = useDebugStore(api, editor, () => ({ root: ws.root, readOnly: ws.readOnly }), tabs);
    const stateA = debug.requestTabState(tabA);
    stateA.settings = { totalTimeoutMs: 5432 };
    stateA.selectedEnvironmentId = environment.id;
    stateA.requestPanel = "query";
    stateA.responsePanel = "headers";
    stateA.requestScrollTop = 81;
    stateA.responseScrollTop = 135;
    const stateB = debug.requestTabState(tabB);
    stateB.settings = { totalTimeoutMs: 9876 };
    stateB.requestPanel = "auth";
    stateB.responsePanel = "body";
    stateB.requestScrollTop = 17;
    stateB.responseScrollTop = 29;
    tabs.activate(tabBId);
    tabs.activate(tabAId);
    expect(debug.requestTabState(tabA)).toMatchObject({
      settings: { totalTimeoutMs: 5432 }, selectedEnvironmentId: environment.id,
      requestPanel: "query", responsePanel: "headers", requestScrollTop: 81, responseScrollTop: 135,
    });
    expect(debug.requestTabState(tabB)).toMatchObject({
      settings: { totalTimeoutMs: 9876 }, requestPanel: "auth", responsePanel: "body", requestScrollTop: 17, responseScrollTop: 29,
    });

    let finishCase!: (result: DebugResult) => void;
    let caseInvocation: DebugInvocation | undefined;
    const caseRun = debug.runCase(editor, { caseId: editor.api!.cases[0]!.id, scope: editor.api!.cases[0]!.scope },
      (invocation) => new Promise((resolve) => {
        caseInvocation = invocation;
        finishCase = resolve;
      }));
    await vi.waitFor(() => expect(stateA.sending).toBe(true));
    expect(caseInvocation).toMatchObject({ mode: "case", environmentId: environment.id, settings: { totalTimeoutMs: 5432 } });
    const competingSend = vi.fn(async (invocation: DebugInvocation) => fakeDebugResult(invocation, "must-not-overlap"));
    await debug.sendRequestTab(tabA, editor, competingSend);
    expect(competingSend).not.toHaveBeenCalled();
    finishCase(fakeDebugResult({ mode: "case", locator: apiNode.locator,
      case: { ...apiNode.locator, caseId: editor.api!.cases[0]!.id, scope: editor.api!.cases[0]!.scope } }, "case-on-tab-a"));
    await caseRun;
    expect(stateA.result?.runId).toBe("case-on-tab-a");
    expect(stateA.sending).toBe(false);

    api.debugHistoryReplay = async () => ({ runId: "history-on-tab-a", sourceKind: "asset", locator: apiNode.locator });
    api.debugWait = async () => fakeDebugResult({ mode: "request", locator: apiNode.locator, request: editor.api!.contract.request, parameters: {}, fields: [] }, "history-on-tab-a");
    await debug.replay("history-id", editor, apiNode.locator);
    expect(stateA.result?.runId).toBe("history-on-tab-a");
    expect(debug.results).toEqual({});
    expect(debug.sending).toBe(false);
  });

  it("discards deferred unavailable and free-history restores after the owning request tab changes", async () => {
    const { api, ws, editor, project, apiNode, collectionNode } = await seeded();
    const second = await api.nodeCreate({ kind: "api", parent: collectionNode.locator, api: { name: "接口B" } });
    if (second.kind !== "api") throw new Error("Memory API creation did not return an API node");
    await editor.load(second.locator);
    const tabs = requestTabsFor(ws, project.locator);
    const tabAId = tabs.open({ kind: "asset", locator: apiNode.locator });
    const tabBId = tabs.open({ kind: "asset", locator: second.locator });
    const debug = useDebugStore(api, editor, () => ({ root: ws.root, readOnly: ws.readOnly }), tabs);
    let releaseUnavailable!: (value: { invocation: Extract<DebugInvocation, { mode: "request" }>; sourceChanged: boolean; sourceAvailable: boolean }) => void;
    const unavailableInvocation: Extract<DebugInvocation, { mode: "request" }> = {
      mode: "request", locator: apiNode.locator,
      request: { ...editor.sessions[Object.keys(editor.sessions).find((key) => editor.sessions[key]?.locator.apiId === apiNode.locator.apiId)!]!.api.contract.request, path: "/missing-source" },
      parameters: {}, fields: [],
    };
    api.debugHistoryRestore = async () => new Promise((resolve) => { releaseUnavailable = resolve; });
    tabs.activate(tabAId);
    await editor.load(apiNode.locator);
    const unavailable = debug.restoreHistory({ historyId: "missing", exchangeOrder: 0 }, apiNode.locator, editor);
    await Promise.resolve();
    tabs.activate(tabBId);
    await editor.load(second.locator);
    debug.error = "B current error";
    releaseUnavailable({ invocation: unavailableInvocation, sourceChanged: false, sourceAvailable: false });
    await unavailable;
    expect.soft(debug.error).toBe("B current error");
    expect.soft(debug.restoredPreview).toBeNull();

    const freeAId = tabs.open({ kind: "free", project: project.locator, draftId: "10000000-0000-4000-8000-000000000021" });
    const freeA = tabs.tabs[freeAId]!;
    const freeBId = tabs.open({ kind: "free", project: project.locator, draftId: "10000000-0000-4000-8000-000000000022" });
    const freeB = tabs.tabs[freeBId]!;
    await editor.loadFreeRequestTab(freeA);
    await editor.loadFreeRequestTab(freeB);
    tabs.activate(freeAId);
    editor.activateFree(freeAId);
    const freeInvocation: Extract<DebugInvocation, { mode: "free" }> = {
      mode: "free", project: project.locator, draftId: freeA.source.kind === "free" ? freeA.source.draftId : "",
      request: { ...editor.freeSessions[freeAId]!.request, path: "/late-free" }, parameters: {}, fields: [],
    };
    let releaseFree!: (value: { invocation: typeof freeInvocation; sourceChanged: boolean; sourceAvailable: boolean }) => void;
    api.debugHistoryRestore = async () => new Promise((resolve) => { releaseFree = resolve; });
    const freeRestore = debug.restoreHistory({ historyId: "free", exchangeOrder: 0 }, apiNode.locator, editor);
    await Promise.resolve();
    tabs.activate(freeBId);
    editor.activateFree(freeBId);
    debug.error = "free B current error";
    debug.restoredSourceAvailable = false;
    releaseFree({ invocation: freeInvocation, sourceChanged: false, sourceAvailable: true });
    await freeRestore;
    expect.soft(debug.error).toBe("free B current error");
    expect.soft(debug.restoredSourceAvailable).toBe(false);
    expect.soft(debug.restoredPreview).toBeNull();

    tabs.activate(freeAId);
    editor.activateFree(freeAId);
    let rejectFreeRestore!: (error: Error) => void;
    api.debugHistoryRestore = async () => new Promise((_, reject) => { rejectFreeRestore = reject; });
    const rejectedFreeRestore = debug.restoreHistory({ historyId: "free-rejected", exchangeOrder: 0 }, apiNode.locator, editor);
    await Promise.resolve();
    tabs.activate(freeBId);
    editor.activateFree(freeBId);
    debug.error = "free B catch error";
    rejectFreeRestore(new Error("late free restore failure"));
    await rejectedFreeRestore;
    expect.soft(debug.error).toBe("free B catch error");
  });
});

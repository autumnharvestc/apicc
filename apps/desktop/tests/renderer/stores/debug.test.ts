// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ApiRequest, DebugInvocation, DebugResult } from "@apicc/core";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";
import { useDebugStore } from "../../../src/renderer/src/stores/debug.js";

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
  return {
    runId,
    sourceApiRevision: "source-api-revision",
    sourceProjectRevision: "source-project-revision",
    executionSnapshotRevision: "execution-snapshot-revision",
    mode: invocation.mode,
    locator: invocation.locator,
    identityAvailable: true,
    startedAt: "2026-10-14T00:00:00.000Z",
    finishedAt: "2026-10-14T00:00:00.000Z",
    run: { collectionName: "fixture", startedAt: "2026-10-14T00:00:00.000Z", finishedAt: "2026-10-14T00:00:00.000Z", total: 1, passed: 1, failed: 0 },
    outcomes: [{ apiId: invocation.locator.apiId, apiName: "API", ...(invocation.mode === "case" ? { caseId: invocation.case.caseId } : {}), caseName: "debug", passed: true, durationMs: 1, assertions: [] }],
    exchanges: [],
    exchangeTotal: 0,
    omittedExchangeCount: 0,
    replay: invocation.mode === "request"
      ? { mode: "request", locator: invocation.locator, request: invocation.request, requestTemplate: invocation.request, parameters: invocation.parameters, fields: invocation.fields, identityAvailable: true, available: true }
      : { mode: "case", case: invocation.case, parameters: {}, fields: [], identityAvailable: true, available: true },
    console: [],
    warnings: [],
  };
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
    api.debugHistoryReplay = async () => ({ runId: "history-A", locator: apiNode.locator });
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
});

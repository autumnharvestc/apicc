import { createServer, type Server } from "node:http";
import { lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import type { DebugResult, DebugResultV1 } from "../../src/debug/model.js";
import { createDebugHistoryOwnerKey, createDebugHistoryStore } from "../../src/debug/history.js";
import { createDebugReplayInvocation, restoreDebugHistoryExchange } from "../../src/debug/replay.js";
import { prepareDebugExecution } from "../../src/debug/service.js";
import { resolveRequestSettings } from "../../src/request/settings.js";
import { createContractExecutionProject, contractExecutionIds } from "../helpers/contractExecutionFixtures.js";

const locator = {
  workspaceId: "workspace-1",
  groupId: "group-1",
  projectId: "project-1",
  collectionId: "collection-1",
  folderIds: [],
  apiId: "api-1",
};
const freeProject = { workspaceId: "workspace-1", groupId: "group-1", projectId: "project-1" };
const freeDraftId = "d3b07384-d9a0-4e5a-b0a4-9c3d0a5f1337";

let server: Server;
let baseUrl = "";
let serverHits = 0;
const roots: string[] = [];

beforeAll(async () => {
  server = createServer((_request, response) => {
    serverHits += 1;
    response.end("must not be fetched by history queries");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "apicc-debug-history-"));
  roots.push(root);
  return root;
}

async function ownerKey(workspaceRoot: string): Promise<string> {
  return createDebugHistoryOwnerKey(workspaceRoot, { sourceKind: "asset", mode: "request", locator });
}

function completedResult(): DebugResult {
  const requestTemplate = {
    protocol: "http" as const,
    method: "GET" as const,
    baseUrl,
    path: "/recorded-request",
    pathParams: [],
    query: [],
    headers: [],
    cookies: [],
    auth: { kind: "none" as const },
    body: { kind: "none" as const },
  };
  const requestSource = { sourceKind: "asset" as const, locator, sourceApiRevision: "api-revision-1" };
  return {
    runId: "run-1",
    source: requestSource,
    sourceProjectRevision: "project-revision-1",
    executionSnapshotRevision: "execution-revision-1",
    mode: "request",
    identityAvailable: true,
    startedAt: "2026-10-13T00:00:00.000Z",
    finishedAt: "2026-10-13T00:00:01.000Z",
    run: {
      collectionId: locator.collectionId,
      identityAvailable: true,
      collectionName: "Collection",
      startedAt: "2026-10-13T00:00:00.000Z",
      finishedAt: "2026-10-13T00:00:01.000Z",
      total: 1,
      passed: 1,
      failed: 0,
    },
    outcomes: [{
      apiId: locator.apiId,
      apiName: "GET /recorded-request",
      caseId: "debug-request",
      caseName: "Debug request",
      identityAvailable: true,
      passed: true,
      durationMs: 4,
      assertions: [],
    }],
    exchanges: [{
      source: { sourceKind: "asset", case: { ...locator, caseId: "__debug_request__", scope: "base" } },
      rowIndex: 0,
      hopIndex: 0,
      order: 1,
      transportState: "responded",
      settings: resolveRequestSettings(),
      request: {
        url: `${baseUrl}/recorded-request`,
        method: "GET",
        query: [],
        headers: [],
        cookies: [],
        body: { kind: "none" },
      },
      response: {
        status: 200,
        headers: [],
        cookies: [],
        body: { kind: "text", text: "synthetic response payload", contentBytes: 26, truncated: false },
      },
      intent: { parameters: { id: "7" }, fields: [], available: true },
      startedAt: "2026-10-13T00:00:00.000Z",
      finishedAt: "2026-10-13T00:00:01.000Z",
      durationMs: 4,
    }],
    exchangeTotal: 1,
    omittedExchangeCount: 0,
    replay: {
      mode: "request",
      sourceKind: "asset",
      locator,
      requestTemplate,
      request: requestTemplate,
      parameters: { id: "7" },
      fields: [],
      available: true,
    },
    console: [],
    warnings: [],
  };
}

function freeResult(): DebugResult {
  const assetResult = completedResult();
  if (assetResult.replay.mode !== "request") throw new Error("Expected a request fixture.");
  const request = assetResult.replay.requestTemplate;
  const source = {
    sourceKind: "free" as const,
    project: freeProject,
    draftId: freeDraftId,
    draftRevision: "draft-revision-1",
  };
  return {
    ...assetResult,
    source,
    mode: "free",
    run: {
      collectionName: "Free request",
      startedAt: assetResult.run.startedAt,
      finishedAt: assetResult.run.finishedAt,
      total: 1,
      passed: 1,
      failed: 0,
    },
    outcomes: [{
      apiName: "Free request",
      caseName: "Free request",
      passed: true,
      durationMs: 4,
      assertions: [],
    }],
    exchanges: assetResult.exchanges.map((exchange) => ({
      ...exchange,
      source: { sourceKind: "free" as const, project: freeProject, draftId: freeDraftId },
    })),
    replay: {
      mode: "free",
      sourceKind: "free",
      project: freeProject,
      draftId: freeDraftId,
      request,
      requestTemplate: request,
      parameters: { id: "7" },
      fields: [],
      available: true,
    },
  };
}

function legacyV1Result(): DebugResultV1 {
  const current = completedResult();
  if (current.mode !== "request" || current.source.sourceKind !== "asset" || current.replay.mode !== "request") throw new Error("Expected an asset request fixture.");
  const { source, replay, exchanges, ...base } = current;
  const legacyExchanges = exchanges.map((exchange) => {
    const { source: exchangeSource, ...value } = exchange;
    if (exchangeSource.sourceKind !== "asset") throw new Error("Expected an asset exchange fixture.");
    return { ...value, case: exchangeSource.case };
  });
  return {
    ...base,
    mode: "request",
    sourceApiRevision: source.sourceApiRevision,
    locator: source.locator,
    exchanges: legacyExchanges,
    replay: {
      mode: "request",
      locator: replay.locator,
      request: replay.request,
      requestTemplate: replay.requestTemplate,
      parameters: replay.parameters,
      fields: replay.fields,
      ...(replay.settings === undefined ? {} : { settings: replay.settings }),
      ...(replay.identityAvailable === undefined ? {} : { identityAvailable: replay.identityAvailable }),
      available: replay.available,
    },
  };
}

describe("debug history", () => {
  it("writes free requests as project-owned v2 history and filters/restores them without a module identity", async () => {
    const root = await privateRoot();
    const owner = createDebugHistoryOwnerKey(root, { sourceKind: "free", project: freeProject, draftId: freeDraftId });
    const history = createDebugHistoryStore({ root });
    const saved = await history.append(freeResult(), { ownerKey: owner });
    if (!saved) throw new Error("Expected free request history to be written.");

    const freePage = await history.list({ sourceKind: "free", projectId: freeProject.projectId, limit: 50 });
    const apiPage = await history.list({ apiId: locator.apiId, limit: 50 });
    const replay = createDebugReplayInvocation(saved);
    const restored = restoreDebugHistoryExchange(saved, 1);

    expect(saved.formatVersion).toBe(2);
    expect(saved.result).toMatchObject({ mode: "free", source: { sourceKind: "free", project: freeProject, draftId: freeDraftId } });
    expect(JSON.stringify(saved.result)).not.toMatch(/collectionId|apiId|caseId/);
    expect(freePage.items).toHaveLength(1);
    expect(freePage.items[0]).toMatchObject({ sourceKind: "free", projectId: freeProject.projectId, groupId: freeProject.groupId, draftId: freeDraftId });
    expect(apiPage.items).toHaveLength(0);
    expect(replay).toMatchObject({ mode: "free", project: freeProject, draftId: freeDraftId, request: { path: "/recorded-request" } });
    expect(restored).toMatchObject({ mode: "free", project: freeProject, draftId: freeDraftId, parameters: { id: "7" } });
  });

  it("reopens completed results and lists body-free metadata without fetching recorded URLs", async () => {
    const root = await privateRoot();
    const saved = await createDebugHistoryStore({ root }).append(completedResult(), { ownerKey: await ownerKey(root) });
    if (!saved) throw new Error("Expected the default-enabled history append to save a record.");

    const reopened = createDebugHistoryStore({ root });
    const page = await reopened.list({ apiId: locator.apiId, limit: 50 });
    const loaded = await reopened.get(saved.historyId);

    expect(saved.result.runId).toBe("run-1");
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.historyId).toBe(saved.historyId);
    expect(JSON.stringify(page.items)).not.toContain("synthetic response payload");
    expect(loaded.record?.result.runId).toBe("run-1");
    expect(loaded.record?.result.exchanges[0]?.response?.body).toEqual({
      kind: "text",
      text: "synthetic response payload",
      contentBytes: 26,
      truncated: false,
    });
    expect(serverHits).toBe(0);
  });

  it("reads v1 records and valid legacy sidecars without rewriting either original file", async () => {
    const root = await privateRoot();
    const owner = await ownerKey(root);
    const historyId = "11b8fae4-ef54-44dd-940f-4d57ddce4c67";
    const createdAt = "2026-10-13T00:00:00.000Z";
    const record = { formatVersion: 1, historyId, createdAt, result: legacyV1Result() };
    const originalRecordBytes = JSON.stringify(record);
    const recordDirectory = join(root, "records", owner);
    const summaryDirectory = join(root, "summaries", owner);
    await mkdir(recordDirectory, { recursive: true });
    await mkdir(summaryDirectory, { recursive: true });
    const recordPath = join(recordDirectory, `${historyId}.json`);
    await writeFile(recordPath, originalRecordBytes, "utf8");
    const info = await lstat(recordPath, { bigint: true });
    const sidecarPath = join(summaryDirectory, `${historyId}.json`);
    const originalSidecarBytes = JSON.stringify({
      formatVersion: 1,
      ownerHash: owner,
      recordSize: Number(info.size),
      recordFingerprint: `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`,
      summary: {
        historyId,
        createdAt,
        runId: "run-1",
        mode: "request",
        result: "passed",
        workspaceId: locator.workspaceId,
        projectId: locator.projectId,
        collectionId: locator.collectionId,
        apiId: locator.apiId,
        collectionName: "Collection",
        apiName: "GET /recorded-request",
        method: "GET",
        total: 1,
        passed: 1,
        failed: 0,
        exchangeTotal: 1,
        searchText: "legacy request",
      },
    });
    await writeFile(sidecarPath, originalSidecarBytes, "utf8");

    const history = createDebugHistoryStore({ root });
    const page = await history.list({ apiId: locator.apiId, limit: 50 });
    const loaded = await history.get(historyId);

    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ sourceKind: "asset", projectId: locator.projectId, apiId: locator.apiId });
    expect(loaded.record?.formatVersion).toBe(1);
    expect(createDebugReplayInvocation(loaded.record!)).toMatchObject({ mode: "request", locator });
    expect(await readFile(recordPath, "utf8")).toBe(originalRecordBytes);
    expect(await readFile(sidecarPath, "utf8")).toBe(originalSidecarBytes);
  });

  it("replays only validated captured intent and restores the selected exchange's ordinary row values", async () => {
    const root = await privateRoot();
    const history = createDebugHistoryStore({ root });
    const saved = await history.append(completedResult(), { ownerKey: await ownerKey(root) });
    const replay = createDebugReplayInvocation(saved!);
    const restored = restoreDebugHistoryExchange(saved!, 1);

    expect(replay).toMatchObject({ mode: "request", locator, request: { path: "/recorded-request" }, parameters: { id: "7" } });
    expect(restored).toMatchObject({ mode: "request", locator, request: { path: "/recorded-request" }, parameters: { id: "7" } });
    const pendingFields = [{ path: "parameters.id", status: "redacted" as const, needsInput: true }];
    const pendingFieldRecord = {
      ...saved!,
      result: {
        ...saved!.result,
        replay: { ...saved!.result.replay, available: true, fields: pendingFields },
        exchanges: [{
          ...saved!.result.exchanges[0]!,
          intent: { parameters: { id: "[REDACTED]" }, fields: pendingFields, available: false },
        }],
      },
    };
    expect(() => createDebugReplayInvocation(pendingFieldRecord)).toThrow(/需要补齐|needs input/i);
    const pendingFreeRecord = {
      formatVersion: 2 as const,
      historyId: "b462d7d1-3bb3-43a5-b780-8cd3f2d1e5cf",
      createdAt: "2026-10-13T00:00:00.000Z",
      result: {
        ...freeResult(),
        replay: {
          ...freeResult().replay,
          fields: pendingFields,
          available: false,
        },
      },
    };
    expect(() => createDebugReplayInvocation(pendingFreeRecord)).toThrow(/需要补齐|needs input/i);
    const draft = restoreDebugHistoryExchange(pendingFieldRecord, 1);
    expect(draft).toMatchObject({
      mode: "request",
      parameters: { id: "[REDACTED]" },
      fields: pendingFields,
    });
    const project = createContractExecutionProject(baseUrl);
    const snapshot = createProjectSnapshot(project);
    const draftLocator = {
      ...locator,
      projectId: contractExecutionIds.project,
      collectionId: contractExecutionIds.collection,
      folderIds: [contractExecutionIds.outerFolder, contractExecutionIds.innerFolder],
      apiId: contractExecutionIds.contract,
    };
    if (draft.mode !== "request") throw new Error("Expected an asset request draft.");
    expect(() => prepareDebugExecution(snapshot, { ...draft, locator: draftLocator })).toThrow(/need user input/i);
    expect(serverHits).toBe(0);
  });

  it("replays v1/v2 case histories from current assets when captured fields need input", () => {
    const current = completedResult();
    if (current.source.sourceKind !== "asset" || current.replay.mode !== "request") throw new Error("Expected an asset request fixture.");
    const caseIdentity = { ...locator, caseId: "formal-case", scope: "base" as const };
    const caseResult: DebugResult = {
      ...current,
      mode: "case",
      exchanges: current.exchanges.map((exchange) => ({
        ...exchange,
        source: { sourceKind: "asset", case: caseIdentity },
      })),
      replay: {
        mode: "case",
        sourceKind: "asset",
        case: caseIdentity,
        requestTemplate: current.replay.requestTemplate,
        parameters: current.replay.parameters,
        fields: [],
        available: true,
      },
    };
    const { source, replay, exchanges, ...base } = caseResult;
    if (source.sourceKind !== "asset" || replay.mode !== "case") throw new Error("Expected an asset case fixture.");
    const legacyCaseResult: DebugResultV1 = {
      ...base,
      mode: "case",
      sourceApiRevision: source.sourceApiRevision,
      locator: source.locator,
      exchanges: exchanges.map((exchange) => {
        const { source: exchangeSource, ...legacyExchange } = exchange;
        if (exchangeSource.sourceKind !== "asset") throw new Error("Expected an asset exchange fixture.");
        return { ...legacyExchange, case: exchangeSource.case };
      }),
      replay: {
        mode: "case",
        case: replay.case,
        requestTemplate: replay.requestTemplate,
        parameters: replay.parameters,
        fields: replay.fields,
        ...(replay.settings === undefined ? {} : { settings: replay.settings }),
        ...(replay.identityAvailable === undefined ? {} : { identityAvailable: replay.identityAvailable }),
        available: replay.available,
      },
    };
    const records = [
      {
        formatVersion: 1 as const,
        historyId: "f6f426c0-2e6a-4e2f-afcf-3dd909bc4303",
        createdAt: "2026-10-13T00:00:00.000Z",
        result: legacyCaseResult,
      },
      {
        formatVersion: 2 as const,
        historyId: "f1892d20-e91c-41e3-9c92-cf1978e1be56",
        createdAt: "2026-10-13T00:00:00.000Z",
        result: caseResult,
      },
    ] as const;
    const unavailableCaptures = [
      { fields: [{ path: "parameters.id", status: "redacted" as const, needsInput: true }], available: true },
      { fields: [], available: false },
    ];

    for (const record of records) {
      for (const capture of unavailableCaptures) {
        const pendingRecord = record.formatVersion === 1
          ? { ...record, result: { ...record.result, replay: { ...record.result.replay, ...capture } } }
          : { ...record, result: { ...record.result, replay: { ...record.result.replay, ...capture } } };
        const invocation = createDebugReplayInvocation(pendingRecord);

        expect(invocation).toMatchObject({ mode: "case", case: caseIdentity, parentHistoryId: record.historyId });
        expect(invocation).not.toHaveProperty("fields");
        expect(invocation).not.toHaveProperty("parameters");
      }
    }
  });

  it("refuses to append when the bounded history scan cannot establish retained capacity", async () => {
    const root = await privateRoot();
    const completeHistory = createDebugHistoryStore({ root });
    const key = await ownerKey(root);
    await completeHistory.updatePreferences({ enabled: true, retentionDays: 30, maxRecords: 10_000 });
    const first = await completeHistory.append(completedResult(), { ownerKey: key });
    const second = await completeHistory.append(completedResult(), { ownerKey: key });
    const boundedHistory = createDebugHistoryStore({ root, scanLimit: 1 });
    await boundedHistory.updatePreferences({ enabled: true, retentionDays: 30, maxRecords: 1 });

    expect(await boundedHistory.cleanup()).toMatchObject({ deleted: 0, diagnostics: [{ code: "scan-limit" }] });
    await expect(boundedHistory.append(completedResult(), { ownerKey: key })).rejects.toMatchObject({
      diagnostic: { code: "scan-limit" },
    });
    const truncatedList = await boundedHistory.list();
    const possiblyHiddenRead = await boundedHistory.get(second!.historyId);
    const completeList = await completeHistory.list();
    expect(truncatedList.diagnostics.map(({ code }) => code)).toContain("scan-limit");
    if (!possiblyHiddenRead.record) expect(possiblyHiddenRead.diagnostics.map(({ code }) => code)).toContain("scan-limit");
    expect(new Set(completeList.items.map(({ historyId }) => historyId))).toEqual(new Set([first!.historyId, second!.historyId]));
  });

  it("invalidates a same-size summary when its record becomes a future version", async () => {
    const root = await privateRoot();
    const key = await ownerKey(root);
    const history = createDebugHistoryStore({ root });
    const saved = await history.append(completedResult(), { ownerKey: key });
    const recordPath = join(root, "records", key, `${saved!.historyId}.json`);
    const original = await readFile(recordPath, "utf8");
    const futureContents = original.replace('"formatVersion":2', '"formatVersion":3');

    expect(futureContents).not.toBe(original);
    expect(Buffer.byteLength(futureContents, "utf8")).toBe(Buffer.byteLength(original, "utf8"));
    await writeFile(recordPath, futureContents, "utf8");
    const changedAt = new Date(Date.now() + 5_000);
    await utimes(recordPath, changedAt, changedAt);

    const page = await history.list();
    expect(page.items.map(({ historyId }) => historyId)).not.toContain(saved!.historyId);
    expect(page.diagnostics.map(({ code }) => code)).toContain("future-version");
    expect(await readFile(recordPath, "utf8")).toBe(futureContents);
  });

  it("refuses to restore an exchange whose identity disagrees with the request descriptor", async () => {
    const root = await privateRoot();
    const history = createDebugHistoryStore({ root });
    const saved = await history.append(completedResult(), { ownerKey: await ownerKey(root) });
    const mismatchedExchange = {
      ...saved!,
      result: {
        ...saved!.result,
        exchanges: [{
          ...saved!.result.exchanges[0]!,
          source: { sourceKind: "asset" as const, case: { ...locator, apiId: "api-B", caseId: "__debug_request__", scope: "base" } },
          intent: { parameters: { row: "belongs-to-B" }, fields: [], available: true },
        }],
      },
    };
    expect(() => restoreDebugHistoryExchange(mismatchedExchange, 1)).toThrow(/身份|归属/);
    expect(() => restoreDebugHistoryExchange(saved!, 1)).not.toThrow();
  });

  it("refuses to restore when result mode disagrees with the replay descriptor", async () => {
    const root = await privateRoot();
    const history = createDebugHistoryStore({ root });
    const saved = await history.append(completedResult(), { ownerKey: await ownerKey(root) });
    const mismatchedMode = {
      ...saved!,
      result: { ...saved!.result, mode: "case" as const },
    };

    expect(() => restoreDebugHistoryExchange(mismatchedMode, 1)).toThrow(/模式/);
  });

  it("refuses to restore a case exchange owned by a different formal case", async () => {
    const root = await privateRoot();
    const history = createDebugHistoryStore({ root });
    const requestResult = completedResult();
    if (requestResult.mode !== "request" || requestResult.source.sourceKind !== "asset" || requestResult.replay.mode !== "request") throw new Error("Expected a request fixture.");
    const caseIdentity = { ...locator, caseId: "formal-case", scope: "base" };
    const caseResult: DebugResult = {
      ...requestResult,
      mode: "case",
      exchanges: [{ ...requestResult.exchanges[0]!, source: { sourceKind: "asset", case: caseIdentity } }],
      replay: {
        mode: "case",
        sourceKind: "asset",
        case: caseIdentity,
        requestTemplate: requestResult.replay.requestTemplate,
        parameters: { id: "7" },
        fields: [],
        available: true,
      },
    };
    const saved = await history.append(caseResult, { ownerKey: await ownerKey(root) });
    const mismatchedExchange = {
      ...saved!,
      result: {
        ...saved!.result,
        exchanges: [{
          ...saved!.result.exchanges[0]!,
          source: { sourceKind: "asset" as const, case: { ...caseIdentity, caseId: "other-case" } },
        }],
      },
    };

    expect(() => restoreDebugHistoryExchange(saved!, 1)).not.toThrow();
    expect(() => restoreDebugHistoryExchange(mismatchedExchange, 1)).toThrow(/身份|归属/);
  });

  it("keeps matching locators from separate canonical workspace roots in distinct owner partitions", async () => {
    const historyRoot = await privateRoot();
    const workspaceA = await privateRoot();
    const workspaceB = await privateRoot();
    const history = createDebugHistoryStore({ root: historyRoot });
    const ownerA = await ownerKey(workspaceA);
    const ownerB = await ownerKey(workspaceB);
    const record = await history.append(completedResult(), { ownerKey: ownerA });

    expect(ownerA).not.toBe(ownerB);
    expect((await history.getOwned(record!.historyId, ownerA)).record?.result.runId).toBe("run-1");
    expect((await history.getOwned(record!.historyId, ownerB)).record).toBeNull();
    expect(JSON.stringify(record)).not.toContain(ownerA);
    expect(JSON.stringify(await history.list())).not.toContain(ownerA);
  });

  it("preserves malformed/future records and reports diagnostics instead of rewriting them", async () => {
    const root = await privateRoot();
    const owner = await ownerKey(root);
    const history = createDebugHistoryStore({ root });
    const saved = await history.append(completedResult(), { ownerKey: owner });
    const recordPath = join(root, "records", owner, `${saved!.historyId}.json`);
    const futureContents = JSON.stringify({ formatVersion: 3, historyId: saved!.historyId });
    await writeFile(recordPath, futureContents, "utf8");

    const loaded = await history.get(saved!.historyId);
    expect(loaded.record).toBeNull();
    expect(loaded.diagnostics.map(({ code }) => code)).toContain("future-version");
    expect(await readFile(recordPath, "utf8")).toBe(futureContents);
  });

  it("surfaces injected storage write failures without creating a readable record", async () => {
    const root = await privateRoot();
    const owner = await ownerKey(root);
    const history = createDebugHistoryStore({
      root,
      writer: async () => { throw new Error("controlled synthetic write failure"); },
    });

    await expect(history.append(completedResult(), { ownerKey: owner })).rejects.toThrow("controlled synthetic write failure");
    expect((await createDebugHistoryStore({ root }).list()).items).toHaveLength(0);
  });

  it("uses strict private preferences, pauses append/retention when disabled, and keeps existing records viewable", async () => {
    const root = await privateRoot();
    const history = createDebugHistoryStore({ root });
    const key = await ownerKey(root);
    const saved = await history.append(completedResult(), { ownerKey: key });
    await history.updatePreferences({ enabled: false, retentionDays: 1, maxRecords: 1 });

    expect((await history.getPreferences()).preferences).toEqual({ enabled: false, retentionDays: 1, maxRecords: 1 });
    expect(await history.append(completedResult(), { ownerKey: key })).toBeUndefined();
    expect(await history.cleanup(new Date("2030-01-01T00:00:00.000Z"))).toEqual({ deleted: 0, diagnostics: [] });
    expect((await history.get(saved!.historyId)).record?.historyId).toBe(saved!.historyId);
  });

  it("retains only the configured count of valid records after append", async () => {
    const root = await privateRoot();
    const history = createDebugHistoryStore({ root });
    const key = await ownerKey(root);
    await history.updatePreferences({ enabled: true, retentionDays: 30, maxRecords: 1 });

    const first = await history.append(completedResult(), { ownerKey: key });
    const second = await history.append(completedResult(), { ownerKey: key });

    expect((await history.list()).items.map(({ historyId }) => historyId)).toEqual([second!.historyId]);
    expect((await history.get(first!.historyId)).record).toBeNull();
  });

  it("preserves invalid private config and resumes only after explicit valid update", async () => {
    const root = await privateRoot();
    const history = createDebugHistoryStore({ root });
    await writeFile(join(root, "config.json"), "{ not-json", "utf8");
    const original = await readFile(join(root, "config.json"), "utf8");

    const prefs = await history.getPreferences();
    expect(prefs.diagnostics.map(({ code }) => code)).toContain("invalid-config");
    expect((await history.cleanup()).diagnostics.map(({ code }) => code)).toContain("invalid-config");
    expect(await readFile(join(root, "config.json"), "utf8")).toBe(original);
    await expect(history.append(completedResult(), { ownerKey: await ownerKey(root) })).rejects.toThrow(/preferences are invalid/i);

    await history.updatePreferences({ enabled: true, retentionDays: 30, maxRecords: 1 });
    const saved = await history.append(completedResult(), { ownerKey: await ownerKey(root) });
    expect((await history.get(saved!.historyId)).record?.historyId).toBe(saved!.historyId);
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { createSession } from "../../../src/main/session.js";
import { createDesktopAiSources } from "../../../src/main/ai/sources.js";
import { IDS, makeWorkspace, persistWorkspace } from "../helpers/contract-assets.js";
import { createOnlineSession } from "../../../src/main/online/session.js";
import { createOnlineClient } from "../../../src/main/online/client.js";
import { createOnlineExecutionHost } from "../../../src/main/online/execution.js";
import { encodeContractProjectFiles, getSourceApiRevision, type ApiAsset } from "@apicc/core";
import { createHash } from "node:crypto";
import { createOnlineProjectAdapter } from "../../../src/renderer/src/stores/onlineProjectAdapter.js";
import { createOnlineExecutionStore } from "../../../src/renderer/src/stores/onlineExecution.js";
import { createMemoryApi } from "../../../src/renderer/src/api/memory.js";
import type { OnlineProjectView } from "../../../src/shared/online/execution.js";

it("captures a fixed local project from the actual session and detects generation changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "apicc-t9-capture-")), session = createSession();
  try {
    await persistWorkspace(root, makeWorkspace()); await session.open(root);
    const sources = createDesktopAiSources({ session });
    const input = { selection: { source: { kind: "local" as const, project: { workspaceId: IDS.workspace, groupId: IDS.groupTwo, projectId: IDS.projectTwo } }, editGeneration: 1, business: { purpose: "case-suggestion" as const, target: { collectionId: IDS.collectionTwo, folderIds: [], apiId: IDS.sharedApi } } }, bodySelection: [] };
    const captured = await sources.capture(input, new AbortController().signal);
    expect(captured.snapshot.project.collections[0]!.apis[0]!.contract.metadata.name).toBe("project two API");
    expect(captured.source.projectId).toBe(IDS.projectTwo);
    await session.open(root);
    await expect(captured.assertCurrent(new AbortController().signal)).rejects.toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("overlays only the matching API draft without changing the captured project or accepting stale revisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "apicc-t9-draft-")), session = createSession();
  try {
    await persistWorkspace(root, makeWorkspace()); await session.open(root);
    const project = { workspaceId: IDS.workspace, groupId: IDS.groupTwo, projectId: IDS.projectTwo }, locator = { ...project, collectionId: IDS.collectionTwo, folderIds: [], apiId: IDS.sharedApi };
    const api = session.locateApi(locator)!.api, contract = structuredClone(api.contract); contract.metadata.name = "unsaved-only";
    const request = { selection: { source: { kind: "local" as const, project }, editGeneration: 1, business: { purpose: "case-suggestion" as const, target: { collectionId: IDS.collectionTwo, folderIds: [], apiId: IDS.sharedApi } } }, bodySelection: [], currentDraft: { sourceApiRevision: getSourceApiRevision(api as ApiAsset), contract, documentation: "draft documentation" } };
    const sources = createDesktopAiSources({ session }), captured = await sources.capture(request, new AbortController().signal);
    expect(captured.currentDraft?.contract.metadata.name).toBe("unsaved-only"); expect(captured.snapshot.project.collections[0]!.apis[0]!.contract.metadata.name).toBe("project two API"); expect(session.locateApi(locator)!.api.contract.metadata.name).toBe("project two API");
    await expect(sources.capture({ ...request, currentDraft: { ...request.currentDraft, sourceApiRevision: "stale" } }, new AbortController().signal)).rejects.toThrow(/draft-source/);
    await expect(sources.capture({ ...request, currentDraft: { ...request.currentDraft, contract: { ...contract, id: IDS.deepApi } } }, new AbortController().signal)).rejects.toThrow(/draft-source/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("captures online assets through the current member client and rejects later version/account changes", async () => {
  const project = makeWorkspace().groups[0]!.projects[0]!;
  const files = [...encodeContractProjectFiles(project).files].map(([path, content]) => ({ path, content, version: "1", hash: createHash("sha256").update(content).digest("hex"), size: Buffer.byteLength(content) }));
  const context = { serverId: "https://control.test/api/v1", ownerId: "7", scope: { workspaceId: "11", groupId: "22", projectId: "33" } };
  let version = "1", assetRequests = 0, block = false;
  let entered!: () => void, release!: () => void, assetSignal: AbortSignal | undefined;
  const waiting = new Promise<void>(r => { entered = r; }), responseGate = new Promise<void>(r => { release = r; });
  const transport: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/auth/login")) return Response.json({ token: "member-token", expiresAt: "2027-01-01T00:00:00Z", user: { id: "7", username: "member", displayName: "Member", role: "USER", disabled: false } });
    if (String(url).endsWith("/auth/logout")) return Response.json({ ok: true });
    expect(String(url)).toBe("https://control.test/api/v1/workspaces/11/projects/33/assets");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer member-token");
    assetRequests++;
    if (block) { assetSignal = init?.signal ?? undefined; entered(); await responseGate; }
    return Response.json({ ...context.scope, format: "contract-files-v1", contractProjectId: project.id, version, manifestHash: "a".repeat(64), files });
  };
  const online = createOnlineSession({ createClient: (baseUrl, hooks) => createOnlineClient({ baseUrl, fetch: transport, onUnauthorized: hooks.onUnauthorized }), tokenStore: { save() {}, load() { return null; }, clear() {} } });
  await online.login({ baseUrl: "https://control.test", username: "member", password: "synthetic" }); online.openWorkspace({ workspaceId: "11", name: "Workspace", myRole: "EDITOR" });
  const execution = createOnlineExecutionHost({ session: online, fetch: transport });
  const sources = createDesktopAiSources({ session: createSession(), online, onlineExecution: execution });
  const input = { selection: { source: { kind: "online" as const, context }, editGeneration: 1, business: { purpose: "case-suggestion" as const, target: { collectionId: IDS.collectionOne, folderIds: [], apiId: IDS.sharedApi } } }, bodySelection: [] };
  try {
    const captured = await sources.capture(input, new AbortController().signal);
    expect(captured.source).toMatchObject({ kind: "online", projectVersion: "1", projectId: IDS.projectOne });
    version = "2"; await expect(captured.assertCurrent(new AbortController().signal)).rejects.toThrow();
    version = "1"; const next = await sources.capture(input, new AbortController().signal);
    online.logout(); const before = assetRequests;
    await expect(next.assertCurrent(new AbortController().signal)).rejects.toThrow(); expect(assetRequests).toBe(before);
    await online.login({ baseUrl: "https://control.test", username: "member", password: "synthetic" }); online.openWorkspace({ workspaceId: "11", name: "Workspace", myRole: "EDITOR" });
    block = true; const abort = new AbortController();
    const pending = sources.capture(input, abort.signal).catch(error => error);
    await waiting; abort.abort(); const transportAborted = assetSignal?.aborted;
    release(); expect(await pending).toBeInstanceOf(Error);
    expect(transportAborted).toBe(true);
  } finally { await execution.close(); }
});

// Catches comparing the online editor's manifest CAS token to a single API hash.
it('final gate actual online adapter draft revision is accepted by trusted capture while stale foreign and changed authority remain rejected', async () => {
  const project = makeWorkspace().groups[0]!.projects[0]!;
  const files = [...encodeContractProjectFiles(project).files].map(([path, content]) => ({ path, content, version: '1', hash: createHash('sha256').update(content).digest('hex'), size: Buffer.byteLength(content) }));
  const context = { serverId: 'https://control.test/api/v1', ownerId: '7', scope: { workspaceId: '11', groupId: '22', projectId: '33' } };
  let version = '1', assetRequests = 0;
  const transport: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/auth/login')) return Response.json({ token: 'member-token', expiresAt: '2027-01-01T00:00:00Z', user: { id: '7', username: 'member', displayName: 'Member', role: 'USER', disabled: false } });
    if (String(url).endsWith('/auth/logout')) return Response.json({ ok: true });
    expect(String(url)).toBe('https://control.test/api/v1/workspaces/11/projects/33/assets');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer member-token'); assetRequests++;
    return Response.json({ ...context.scope, format: 'contract-files-v1', contractProjectId: project.id, version, manifestHash: 'a'.repeat(64), files });
  };
  const online = createOnlineSession({ createClient: (baseUrl, hooks) => createOnlineClient({ baseUrl, fetch: transport, onUnauthorized: hooks.onUnauthorized }), tokenStore: { save() {}, load() { return null; }, clear() {} } });
  await online.login({ baseUrl: 'https://control.test', username: 'member', password: 'synthetic' }); online.openWorkspace({ workspaceId: '11', name: 'Workspace', myRole: 'EDITOR' });
  const execution = createOnlineExecutionHost({ session: online, fetch: transport }), sources = createDesktopAiSources({ session: createSession(), online, onlineExecution: execution });
  const view = await execution.handle({ operation: 'assets', context }) as OnlineProjectView;
  const ui = createOnlineExecutionStore({ onlineExecution: input => execution.handle(input) });
  ui.activate(context); ui.view = view; ui.project = structuredClone(view.project!); ui.saved = JSON.stringify(ui.project);
  const adapter = createOnlineProjectAdapter(ui, createMemoryApi(), () => false, () => false);
  try {
    const entry = adapter.apiEntries().find(item => item.asset.contract.id === IDS.sharedApi)!; await adapter.editor.load(entry.locator);
    const session = adapter.editor.sessions[adapter.editor.activeKey!]!;
    expect(session.sourceApiRevision).toBe('a'.repeat(64)); expect(session.sourceApiRevision).not.toBe(getSourceApiRevision(entry.asset));
    const selection = { source: { kind: 'online' as const, context }, editGeneration: session.generation,
      business: { purpose: 'case-suggestion' as const, target: { collectionId: entry.locator.collectionId, folderIds: [...entry.locator.folderIds], apiId: entry.locator.apiId } } };
    const input = { selection, bodySelection: [], currentDraft: { sourceApiRevision: session.sourceApiRevision,
      contract: JSON.parse(JSON.stringify(session.api.contract)), documentation: session.api.documentation } };
    // Independent authority precondition does not rely on the failing draft-revision comparison.
    const baseline = await sources.capture({ selection, bodySelection: [] }, new AbortController().signal);
    await baseline.assertCurrent(new AbortController().signal);
    const apiHashOutcome = await sources.capture({ ...input, currentDraft: { ...input.currentDraft, sourceApiRevision: getSourceApiRevision(entry.asset) } }, new AbortController().signal)
      .then(() => ({ accepted: true }), error => ({ error: String(error) }));
    expect.soft(apiHashOutcome, 'a single API hash is not the online adapter manifest CAS token').toEqual({ error: 'Error: ai-draft-source-changed' });
    await expect(adapter.bridge.apiSave(entry.locator, JSON.parse(JSON.stringify(session.api)), 'foreign-manifest')).rejects.toThrow('version_conflict');
    await expect(sources.capture({ ...input, currentDraft: { ...input.currentDraft, sourceApiRevision: 'stale-manifest' } }, new AbortController().signal)).rejects.toThrow('ai-draft-source-changed');
    await expect(sources.capture({ ...input, currentDraft: { ...input.currentDraft, contract: { ...input.currentDraft.contract, id: IDS.deepApi } } }, new AbortController().signal)).rejects.toThrow('ai-draft-source-changed');
    const beforeForeign = assetRequests;
    await expect(sources.capture({ ...input, selection: { ...selection, source: { kind: 'online', context: { ...context, ownerId: '8' } } } }, new AbortController().signal)).rejects.toThrow('online-session-changed');
    expect(assetRequests).toBe(beforeForeign);
    version = '2'; await expect(baseline.assertCurrent(new AbortController().signal)).rejects.toThrow('ai-source-changed'); version = '1';
    const current = await sources.capture({ selection, bodySelection: [] }, new AbortController().signal);
    online.logout(); const beforeLogout = assetRequests;
    await expect(current.assertCurrent(new AbortController().signal)).rejects.toThrow('online-session-changed'); expect(assetRequests).toBe(beforeLogout);
    await online.login({ baseUrl: 'https://control.test', username: 'member', password: 'synthetic' }); online.openWorkspace({ workspaceId: '11', name: 'Workspace', myRole: 'EDITOR' });
    const outcome = await sources.capture(input, new AbortController().signal).then(value => ({ value }), error => ({ error: String(error) }));
    expect(outcome, `the unchanged real adapter revision must reach a trusted draft capture: ${'error' in outcome ? outcome.error : 'captured'}`).toHaveProperty('value');
    if (!('value' in outcome)) return;
    expect(outcome.value.currentDraft?.contract).toEqual(input.currentDraft.contract); await outcome.value.assertCurrent(new AbortController().signal);
    expect(outcome.value.source).toMatchObject({ kind: 'online', projectVersion: '1', projectId: project.id });
  } finally { adapter.stop(); ui.setVisible(false); await execution.close(); }
});

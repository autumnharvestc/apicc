// @vitest-environment jsdom
// 注：pinia/vue 响应式需要 DOM 环境，渲染层 store 测试用文件级 pragma 指定 jsdom。
//
// T11 preserves native IDs, explicit selection/adoption and zero automatic save/run.
// All business fixtures now enter the trusted prepare/confirm/start flow.
import { describe, expect, it } from "vitest";
import { createMemoryApi, AI_FIXTURE_SUGGESTIONS } from "../../../src/renderer/src/api/memory.js";
import { useWorkspaceStore } from "../../../src/renderer/src/stores/workspace.js";
import { useEditorStore } from "../../../src/renderer/src/stores/editor.js";
import { createAiStore, AI_CONFIG_STORAGE_KEY } from "../../../src/renderer/src/stores/ai.js";
import type { LocalTreeNodeDTO } from "../../../src/shared/tree-dto.js";
import { createSafeAiSettingsFixture } from "../fixtures/aiSettings.js";
import type { AiPrepareInput, AiContextPreviewDto } from "../../../src/shared/ai/contract.js";
import { createAiBusinessFixture } from '../fixtures/aiBusiness.js';
import { flushPromises } from '@vue/test-utils';
import type { AiProgressDto, AiStartInput } from '../../../src/shared/ai/contract.js';

function firstApiNode(node: LocalTreeNodeDTO): Extract<LocalTreeNodeDTO, { kind: "api" }> | undefined {
  if (node.kind === "api") return node;
  if ("children" in node && node.children) {
    for (const child of node.children) {
      const match = firstApiNode(child);
      if (match) return match;
    }
  }
  return undefined;
}

function memStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
    clear: () => map.clear(),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

async function seeded() {
  const { api } = createAiBusinessFixture();
  api.seedWorkspace();
  const ws = useWorkspaceStore(api);
  await ws.open("/tmp/ws");
  const apiNode = ws.tree && firstApiNode(ws.tree);
  if (!apiNode) throw new Error("fixture must contain an API in its workspace tree");
  const editor = useEditorStore(api, () => ({ root: ws.root, readOnly: ws.readOnly }));
  await editor.load(apiNode.locator);
  const storage = memStorage();
  const getContext = () => ({ root: ws.root, readOnly: ws.readOnly });
  const ai = createAiStore({ api, editor, storage, getContext });
  return { api, ws, editor, ai, storage };
}

// Final B I3: the declared basis argument must reach the trusted prepare DTO.
it("final B I3 store prepares the explicitly selected observation for the saved case", async () => {
  const ctx = await seeded(), testCase = ctx.editor.api!.cases[0]!;
  const prepared: AiPrepareInput[] = [], original = ctx.api.aiPrepareAssistance;
  ctx.api.aiPrepareAssistance = async input => { prepared.push(input); return original(input); };
  const basis = { kind: "observation" as const, report: { kind: "current" as const, expectedReportDigest: "a".repeat(64) }, caseIndex: 2 };
  await ctx.ai.prepareAssertions({ caseId: testCase.id, scope: testCase.scope }, basis);
  expect(prepared).toHaveLength(1);
  expect(prepared[0]!.selection.business).toMatchObject({ purpose: "assertion-suggestion", target: { caseId: testCase.id, scope: testCase.scope }, basis });
  expect(prepared[0]!.bodySelection).toEqual([]);
});

/** Existing adoption tests use the saved host profile, never the retired aiSuggest route. */
async function withConfig(ctx: Awaited<ReturnType<typeof seeded>>) {
  await ctx.ai.init();
  return ctx;
}

describe("F7e T11 explicit outbound preparation", () => {
  // Catches using retired endpoint/model execution instead of preparing the exact current API.
  it("prepares the current API using the saved profile and waits for confirmation without changing the draft", async () => {
    const { api, ai, editor } = await seeded();
    await ai.init();
    const prepared: AiPrepareInput[] = [];
    const started: unknown[] = [];
    const legacy: unknown[] = [];
    const before = JSON.stringify(editor.api);
    const locator = editor.locator!;
    const session = editor.sessions[editor.activeKey!]!;
    const resolved = ai.resolveSettings("model-a", "case-suggestion");
    const preview: AiContextPreviewDto = {
      purpose: "case-suggestion", bytes: 1234,
      source: { bindingId: "trusted-preview-binding", kind: "local", projectId: locator.projectId,
        definitionRevision: session.sourceProjectRevision, editRevision: session.generation, unsaved: true,
        target: { collectionId: locator.collectionId, folderIds: [...locator.folderIds], apiId: locator.apiId } },
      evidence: [], included: ["contract"], omitted: [{ item: "scripts", reason: "default-omitted" }],
      redaction: { strategy: "heuristic", limitations: ["review-before-send"] }, limit: 5,
      destination: { baseUrl: "https://models.example.test/gateway/v1", modelProfileId: "model-a", modelId: "manual-model-A", protocol: "openai-chat-completions" },
      budgets: resolved.budgets, budgetSources: resolved.sources, capabilityStatus: resolved.capabilityStatus, warnings: [],
    };
    api.aiPrepareAssistance = async input => { prepared.push(JSON.parse(JSON.stringify(input)) as AiPrepareInput); return { previewId: "00000000-0000-4000-8000-000000000011", preview }; };
    api.aiStart = async input => { started.push(input); return { purpose: "case-suggestion", bindingId: preview.source.bindingId,
      source: preview.source, model: { profileId: "model-a", modelId: "manual-model-A", connectionId: "personal-primary" },
      generatedAt: "2026-10-31T01:02:03.004Z", timeZone: "UTC", label: "AI 辅助", cases: [], explanations: [] }; };
    api.aiSuggest = async input => { legacy.push(input); return []; };

    await ai.fetchSuggestions();

    expect(prepared.map(input => input.selection)).toEqual([{
      source: { kind: "local", project: { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId } },
      editGeneration: session.generation,
      business: { purpose: "case-suggestion", target: { collectionId: locator.collectionId, folderIds: locator.folderIds, apiId: locator.apiId } },
    }]);
    expect(prepared[0]?.bodySelection).toEqual([]);
    expect(prepared[0]?.currentDraft?.sourceApiRevision).toBe(session.sourceApiRevision);
    expect(prepared[0]?.currentDraft?.contract).toEqual(editor.api!.contract);
    expect(started).toEqual([]);
    expect(legacy).toEqual([]);
    expect(ai.selectedIds).toEqual([]);
    expect(JSON.stringify(editor.api)).toBe(before);
    expect(editor.dirty).toBe(false);
  });
});

describe('F7e T11 prepared source guards', () => {
  // Catches sending current project content from an editor that cannot adopt changes.
  it('T11 refuses preparation in a read-only project', async () => {
    const { api, ai, ws } = await seeded(); await ai.init();
    const prepared: AiPrepareInput[] = [];
    const prepare = api.aiPrepareAssistance;
    api.aiPrepareAssistance = async input => { prepared.push(input); return prepare(input); };
    ws.readOnly = true;
    await ai.fetchSuggestions();
    expect(prepared).toEqual([]);
    expect(ai.outboundPreview).toBeNull();
  });

  // Catches edit/config/permission changes during preparation leaving an actionable old preview.
  it.each(['draft', 'configuration', 'read-only'] as const)('T11 discards a late preview after %s changes', async change => {
    const { api, ai, editor, ws } = await seeded(); await ai.init();
    let entered!: () => void, release!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const prepare = api.aiPrepareAssistance;
    api.aiPrepareAssistance = async input => { const result = await prepare(input); entered(); await gate; return result; };
    const pending = ai.fetchSuggestions(); await enteredPromise;
    if (change === 'draft') editor.api!.contract.metadata.name = 'edited while preparing';
    else if (change === 'read-only') ws.readOnly = true;
    else await ai.writeSettings({ operation: 'preferences', expectedRevision: ai.settings!.revision,
      bindings: [{ purpose: 'case-suggestion', modelProfileId: 'model-b', budgets: {} }] });
    release(); await pending;
    expect(ai.outboundPreview).toBeNull();
    expect(ai.canAdopt).toBe(false);
  });

  // Catches old candidates being appended to a changed exact draft/configuration.
  it.each(['draft', 'configuration'] as const)('T11 refuses candidate adoption after captured %s changes', async change => {
    const { ai, editor } = await seeded(); await ai.init(); await ai.fetchSuggestions();
    ai.outboundPreview = null;
    ai.suggestions = structuredClone([...AI_FIXTURE_SUGGESTIONS]);
    ai.toggleSelect(AI_FIXTURE_SUGGESTIONS[0]!.id);
    const originalCases = JSON.stringify(editor.api!.cases);
    if (change === 'draft') editor.api!.contract.metadata.name = 'new draft after preview';
    else await ai.writeSettings({ operation: 'preferences', expectedRevision: ai.settings!.revision,
      bindings: [{ purpose: 'case-suggestion', modelProfileId: 'model-b', budgets: {} }] });
    expect(ai.adopt()).toBe(0);
    expect(JSON.stringify(editor.api!.cases)).toBe(originalCases);
  });
});

type T11OperationSurface = {
  confirmAssistance?: () => Promise<void>;
  cancelAssistance?: () => Promise<void>;
  dispose?: () => void;
  businessProgress?: AiProgressDto | null;
};

describe('F7e T11 confirmed operation lifecycle', () => {
  // Catches confirmed results auto-selecting, editing old expected values, saving, or running business requests.
  it('T11 starts only after explicit confirmation and appends only selected completed candidates without save or run', async () => {
    const { api, ai, editor } = await seeded(); await ai.init();
    const op = ai as typeof ai & T11OperationSurface;
    const oldCases = JSON.stringify(editor.api!.cases);
    const writesAndRuns: string[] = [];
    const saved = api.apiSave, caseSaved = api.caseDraftSave, run = api.runCollection, debug = api.debugSend;
    api.apiSave = async (...args) => { writesAndRuns.push('apiSave'); return saved(...args); };
    api.caseDraftSave = async (...args) => { writesAndRuns.push('caseDraftSave'); return caseSaved(...args); };
    api.runCollection = async (...args) => { writesAndRuns.push('runCollection'); return run(...args); };
    api.debugSend = async (...args) => { writesAndRuns.push('debugSend'); return debug(...args); };
    const started: AiStartInput[] = [], start = api.aiStart;
    api.aiStart = async input => { started.push(JSON.parse(JSON.stringify(input)) as AiStartInput); return start(input); };
    await ai.fetchSuggestions();
    expect(started).toEqual([]);
    await op.confirmAssistance?.();
    expect(started).toHaveLength(1);
    expect(started[0]).toMatchObject({ previewId: '00000000-0000-4000-8000-000000000011',
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/), selection: { business: { purpose: 'case-suggestion', target: { apiId: editor.locator!.apiId } } } });
    expect(ai.selectedIds).toEqual([]);
    expect(JSON.stringify(editor.api!.cases)).toBe(oldCases);
    expect(editor.dirty).toBe(false);
    ai.toggleSelect(AI_FIXTURE_SUGGESTIONS[1]!.id);
    expect(ai.adopt()).toBe(1);
    expect(editor.api!.cases.slice(0, -1)).toEqual(JSON.parse(oldCases));
    expect(editor.api!.cases.at(-1)?.id).toBe(AI_FIXTURE_SUGGESTIONS[1]!.id);
    expect(editor.dirty).toBe(true);
    expect(writesAndRuns).toEqual([]);
  });

  // Each first normal-entry assertion is currently blocked; later failures must be observed after real wiring.
  it.each(['draft', 'configuration', 'root', 'read-only', 'cancel', 'dispose'] as const)('T11 rejects a late completed result after %s changes', async change => {
    const { api, ai, editor, ws } = await seeded(); await ai.init(); await ai.fetchSuggestions();
    const op = ai as typeof ai & T11OperationSurface;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started: AiStartInput[] = [], cancelled: string[] = [], start = api.aiStart;
    api.aiStart = async input => { started.push(input); const result = await start(input); await gate; return result; };
    api.aiCancel = async input => { cancelled.push(input.operationId); return { cancelled: true }; };
    const pending = op.confirmAssistance?.(); await flushPromises();
    try {
      expect(started).toHaveLength(1);
      if (change === 'draft') editor.api!.contract.metadata.name = 'edited while receiving';
      else if (change === 'configuration') await ai.writeSettings({ operation: 'preferences', expectedRevision: ai.settings!.revision,
        bindings: [{ purpose: 'case-suggestion', modelProfileId: 'model-b', budgets: {} }] });
      else if (change === 'root') ws.root = '/tmp/another-isolated-root';
      else if (change === 'read-only') ws.readOnly = true;
      else if (change === 'cancel') await op.cancelAssistance?.();
      else op.dispose?.();
      release(); await pending;
      expect(ai.suggestions).toBeNull();
      expect(ai.canAdopt).toBe(false);
      if (change === 'cancel' || change === 'dispose') expect(cancelled).toEqual([started[0]!.operationId]);
    } finally { release(); await pending; }
  });

  // Catches timer/fake progress, unrelated operations, and listeners retaining completed operations.
  it('T11 accepts only matching real progress and detaches when the confirmed operation completes', async () => {
    const { api, ai } = await seeded(); await ai.init(); await ai.fetchSuggestions();
    const op = ai as typeof ai & T11OperationSurface;
    let listener: ((progress: AiProgressDto) => void) | undefined, unsubscribed = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    api.onAiProgress = receive => { listener = receive; return () => { unsubscribed++; }; };
    const started: AiStartInput[] = [], start = api.aiStart;
    api.aiStart = async input => { started.push(input); const result = await start(input); await gate; return result; };
    const pending = op.confirmAssistance?.(); await flushPromises();
    try {
      expect(started).toHaveLength(1);
      expect(op.businessProgress ?? null).toBeNull();
      listener?.({ operationId: started[0]!.operationId, phase: 'request', attempt: 1 });
      expect(op.businessProgress).toEqual({ operationId: started[0]!.operationId, phase: 'request', attempt: 1 });
      listener?.({ operationId: '00000000-0000-4000-8000-000000000099', phase: 'receiving', attempt: 9, receivedBytes: 999 });
      expect(op.businessProgress).toEqual({ operationId: started[0]!.operationId, phase: 'request', attempt: 1 });
      release(); await pending;
      expect(unsubscribed).toBe(1);
      const completedProgress = JSON.stringify(op.businessProgress);
      listener?.({ operationId: started[0]!.operationId, phase: 'retrying', attempt: 4 });
      expect(JSON.stringify(op.businessProgress)).toBe(completedProgress);
    } finally { release(); await pending; }
  });
});

describe('F7e T11 remaining source and result guards', () => {
  // Catches real online report source changes bypassing store identity when the visible report itself stays A.
  it.each(['version', 'account', 'address'] as const)('T11 B6 refuses a prepared online report after source %s changes without a manual isCurrent override', async change => {
    const { api, editor, ws } = await seeded();
    let source = { kind: 'online' as const, context: { serverId: 'https://member.example.test/api/v1', ownerId: '7', scope: { workspaceId: '11', groupId: '22', projectId: '33' } } }, version = 7;
    const ai = createAiStore({ api, editor, getContext: () => ({ root: ws.root, readOnly: false }), getSource: () => source, getSourceVersion: () => version });
    await ai.init();
    const started: AiStartInput[] = [], start = api.aiStart;
    api.aiStart = async input => { started.push(input); return start(input); };
    await ai.prepareReportAnalysis({ source, report: { kind: 'online', runId: 'owned-online-report', location: { kind: 'local' } }, displayed: { runId: 'owned-online-report', verdict: 'failed' } });
    expect(ai.outboundPreview?.preview.source).toMatchObject({ kind: 'online', projectId: '33' });
    if (change === 'version') version++; else source = { ...source, context: { ...source.context, ...(change === 'account' ? { ownerId: '8' } : { serverId: 'https://other.example.test/api/v1' }) } };
    await ai.confirmAssistance();
    expect(started).toEqual([]); expect(ai.businessResult).toBeNull();
  });

  // Catches accepting an unrelated validated native envelope at the result/adoption boundary.
  it.each(['binding', 'source-binding', 'target', 'purpose'] as const)('T11 rejects a completed result with a different %s', async change => {
    const { api, ai, editor } = await seeded(); await ai.init(); await ai.fetchSuggestions();
    const original = JSON.stringify(editor.api); const start = api.aiStart;
    api.aiStart = async input => {
      const result = structuredClone(await start(input));
      if (change === 'binding') result.bindingId = 'other-binding';
      else if (change === 'source-binding') result.source.bindingId = 'other-source';
      else if (change === 'target') result.source.target = { ...result.source.target!, apiId: '00000000-0000-4000-8000-000000000099' };
      else return { bindingId: result.bindingId, source: result.source, model: result.model, generatedAt: result.generatedAt,
        timeZone: result.timeZone, label: result.label, purpose: 'assertion-suggestion', assertions: [], evidence: [] };
      return result;
    };
    await ai.confirmAssistance();
    expect(ai.businessResult).toBeNull(); expect(ai.suggestions).toBeNull(); expect(JSON.stringify(editor.api)).toBe(original);
  });

  // Catches selecting a local source while the same App store is bound to an online member editor.
  it('T11 prepares the explicit online source without creating a second AI store', async () => {
    const { api, editor, ws } = await seeded();
    const source = { kind: 'online' as const, context: { serverId: 'https://member.example.test/api/v1', ownerId: '7', scope: { workspaceId: '11', groupId: '22', projectId: '33' } } };
    const ai = createAiStore({ api, editor, getContext: () => ({ root: ws.root, readOnly: false }), getSource: () => source, getSourceVersion: () => 'v7' } as Parameters<typeof createAiStore>[0]);
    const received: AiPrepareInput[] = [], prepare = api.aiPrepareAssistance;
    api.aiPrepareAssistance = async input => { received.push(input); return prepare(input); };
    await ai.init(); await ai.fetchSuggestions();
    expect(received[0]?.selection.source).toEqual(source);
  });

  // Catches account/address/version changes leaving results usable even when API names and ids match.
  it.each(['account', 'address', 'version'] as const)('T11 rejects a completed result after online %s changes', async change => {
    const { api, editor, ws } = await seeded();
    let source = { kind: 'online' as const, context: { serverId: 'https://member.example.test/api/v1', ownerId: '7', scope: { workspaceId: '11', groupId: '22', projectId: '33' } } }, version = '7';
    const ai = createAiStore({ api, editor, getContext: () => ({ root: ws.root, readOnly: false }), getSource: () => source, getSourceVersion: () => version } as Parameters<typeof createAiStore>[0]);
    await ai.init(); await ai.fetchSuggestions();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const start = api.aiStart;
    api.aiStart = async input => { const result = await start(input); await gate; return result; };
    const pending = ai.confirmAssistance(); await flushPromises();
    if (change === 'version') version = '8'; else source = { ...source, context: { ...source.context, ...(change === 'account' ? { ownerId: '8' } : { serverId: 'https://another.example.test/api/v1' }) } };
    release(); await pending;
    expect(ai.businessResult).toBeNull(); expect(ai.canAdopt).toBe(false);
  });
});

describe("F7e T10 safe settings authority", () => {
  // Catches selecting stale legacy localStorage as live endpoint/model instead of migration input.
  it("does not activate a legacy localStorage endpoint on initialization", async () => {
    const { api, networkActions } = createSafeAiSettingsFixture();
    const editor = useEditorStore(api, () => ({ root: "", readOnly: false }));
    const storage = memStorage();
    const legacy = '{"baseUrl":"https://stale.example.test/v1","model":"retired-model"}';
    storage.setItem(AI_CONFIG_STORAGE_KEY, legacy);
    const ai = createAiStore({ api, editor, storage });
    await ai.init();
    expect(ai.error).toBeNull();
    expect(ai.baseUrl).toBe("");
    expect(ai.model).toBe("");
    expect(storage.getItem(AI_CONFIG_STORAGE_KEY)).toBe(legacy);
    expect(networkActions).toEqual([]);
  });
  it("refuses sending a persistent secret when secure storage is unavailable", async () => {
    const { api, read } = createSafeAiSettingsFixture({ backend: "unavailable" });
    const editor = useEditorStore(api, () => ({ root: "", readOnly: false }));
    const ai = createAiStore({ api, editor, storage: memStorage() });
    await ai.init();
    const received: unknown[] = [];
    const write = api.aiSettingsWrite;
    api.aiSettingsWrite = async input => { received.push(input); return write(input); };
    expect(await ai.writeSettings({ operation: "credential", expectedRevision: read().revision,
      connectionId: "personal-primary", value: "must-not-send", mode: "persistent" })).toBe(false);
    expect(ai.settingsIssue?.code).toBe("secure-backend-unavailable");
    expect(received).toEqual([]);
    expect(read().connections[0]?.credentialState).toBe("unavailable");
  });
});


describe("F7e T10 fix1 bound-model validation", () => {
  // Catches validating B's purpose-level budget against the unrelated smaller model A before IPC.
  it("saves a legal 32768 purpose budget bound to B independently of model A's 8192 limit", async () => {
    const { api, read } = createSafeAiSettingsFixture();
    const editor = useEditorStore(api, () => ({ root: "", readOnly: false }));
    const ai = createAiStore({ api, editor, storage: memStorage() });
    await ai.init();
    const received: unknown[] = [];
    const write = api.aiSettingsWrite;
    api.aiSettingsWrite = async input => { received.push(input); return write(input); };
    const input = { operation: "preferences", expectedRevision: 1, bindings: [
      { purpose: "case-suggestion", modelProfileId: "model-b", budgets: { maxOutputTokens: 32768, totalOutputTokens: 98304 } },
    ] } as const;
    const saved = await ai.writeSettings({ ...input, bindings: [...input.bindings] });
    expect(received, JSON.stringify(ai.settingsIssue)).toEqual([{ ...input, projectOverrides: [] }]);
    expect(saved).toBe(true);
    expect(read().bindings).toEqual(input.bindings);
    expect(read().models.map(model => model.budgets.maxOutputTokens)).toEqual([8192, 32768]);
  });
  // Positive rejection control: fixing the false cross-model combination must not remove actual bound-model limits.
  it("still rejects a purpose budget above its actual bound model A capacity before IPC", async () => {
    const { api, read } = createSafeAiSettingsFixture();
    const editor = useEditorStore(api, () => ({ root: "", readOnly: false }));
    const ai = createAiStore({ api, editor, storage: memStorage() });
    await ai.init();
    const before = read();
    const received: unknown[] = [];
    const write = api.aiSettingsWrite;
    api.aiSettingsWrite = async input => { received.push(input); return write(input); };
    expect(await ai.writeSettings({ operation: "preferences", expectedRevision: 1, bindings: [
      { purpose: "case-suggestion", modelProfileId: "model-a", budgets: { maxOutputTokens: 8193, totalOutputTokens: 24579 } },
    ] })).toBe(false);
    expect(ai.settingsIssue).toMatchObject({ code: "budget-exceeded", field: "maxOutputTokens", source: "purpose", allowed: 8192 });
    expect(received).toEqual([]);
    expect(read()).toEqual(before);
  });
});

describe("ai store safe configuration contract (migrated existing coverage)", () => {
  it("initializes from safe settings and leaves corrupt legacy input untouched", async () => {
    const { api, editor, ai, storage } = await seeded();
    storage.setItem(AI_CONFIG_STORAGE_KEY, "not-json{");
    await ai.init();
    expect(ai.settings?.connections[0]?.baseUrl).toBe("https://models.example.test/gateway/v1");
    expect(ai.settings?.models.map(model => model.id)).toEqual(["model-a", "model-b"]);
    expect(ai.error).toBeNull();
    expect(storage.getItem(AI_CONFIG_STORAGE_KEY)).toBe("not-json{");
    const fresh = createAiStore({ api, editor, storage });
    await fresh.init();
    expect(fresh.baseUrl).toBe("");
    expect(fresh.model).toBe("");
    expect(fresh.settings?.revision).toBe(1);
  });

  it("writes connection metadata and a one-way credential without a second localStorage configuration", async () => {
    const { api, ai, storage } = await seeded();
    await ai.init();
    const sent: unknown[] = [];
    const write = api.aiSettingsWrite;
    api.aiSettingsWrite = async input => { sent.push(input); return write(input); };
    const { credentialState: _state, ...connection } = ai.settings!.connections[0]!;
    expect(await ai.writeSettings({ operation: "connection", expectedRevision: 1, connection: { ...connection, name: "新名称" } })).toBe(true);
    expect(await ai.writeSettings({ operation: "credential", expectedRevision: 2, connectionId: connection.id, value: "sk-9", mode: "persistent" })).toBe(true);
    expect(sent[0]).toMatchObject({ operation: "connection", connection: { name: "新名称" } });
    expect(sent[1]).toMatchObject({ operation: "credential", value: "sk-9" });
    expect(ai.settings?.connections[0]?.credentialState).toBe("available");
    expect(JSON.stringify(ai.$state)).not.toContain("sk-9");
    expect(storage.getItem(AI_CONFIG_STORAGE_KEY)).toBeNull();
    const { credentialState: _currentState, ...current } = ai.settings!.connections[0]!;
    sent.length = 0;
    expect(await ai.writeSettings({ operation: "connection", expectedRevision: ai.settings!.revision, connection: { ...current, name: "再改名" } })).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ operation: "connection" });
    expect(ai.settings?.connections[0]?.credentialState).toBe("available");
  });

  it("keeps authoritative settings and legacy input unchanged when the host rejects a save", async () => {
    const { api, ai, storage } = await seeded();
    await ai.init();
    const before = JSON.stringify(ai.settings);
    api.aiSettingsWrite = async () => { throw new Error("AI personal configuration: secure-backend-unavailable"); };
    const { credentialState: _state, ...connection } = ai.settings!.connections[0]!;
    expect(await ai.writeSettings({ operation: "connection", expectedRevision: 1, connection: { ...connection, name: "拒绝保存" } })).toBe(false);
    expect(ai.settingsIssue?.code).toBe("secure-backend-unavailable");
    expect(JSON.stringify(ai.settings)).toBe(before);
    expect(storage.getItem(AI_CONFIG_STORAGE_KEY)).toBeNull();
  });
});

describe("ai store explicit safe connection tests (migrated existing coverage)", () => {
  it("refuses a missing model locally and gives the UI a readable error code", async () => {
    const { api, ai } = await seeded();
    await api.aiSettingsWrite({ operation: "preferences", expectedRevision: 1, models: [], bindings: [] });
    await ai.init();
    const received: unknown[] = [];
    api.aiConnectionTest = async input => { received.push(input); return { ok: true }; };
    await ai.testConnection();
    expect(ai.testResult).toBe("failure");
    expect(ai.settingsIssue?.code).toBe("missing-model");
    expect(received).toEqual([]);
  });

  it("probes a saved model profile by UUID operation id without endpoint or key material", async () => {
    const { api, ai } = await seeded(); await ai.init();
    const received: unknown[] = [];
    const probe = api.aiConnectionTest;
    api.aiConnectionTest = async input => { received.push(input); return probe(input); };
    await ai.testConnection("model-a");
    expect(ai.testResult).toBe("success");
    expect(ai.error).toBeNull();
    expect(received).toEqual([{ operationId: expect.stringMatching(/^[0-9a-f-]{36}$/), modelProfileId: "model-a" }]);
  });

  it("records a real runtime failure code for localized presentation", async () => {
    const { api, ai } = await seeded(); await ai.init();
    api.aiConnectionTest = async () => { throw new Error("AI 请求失败（http）"); };
    await ai.testConnection("model-a");
    expect(ai.testResult).toBe("failure");
    expect(ai.settingsIssue?.code).toBe("http");
  });
});
describe("ai store：可信准备与显式确认（迁移既有业务覆盖）", () => {
  it("已配置 → 建议（core AiSuggestedCase 形状：带 id）、抽屉打开、默认未勾选", async () => {
    const ctx = await withConfig(await seeded());
    const sent: unknown[] = [];
    const original = ctx.api.aiStart.bind(ctx.api);
    ctx.api.aiStart = async (input) => { sent.push(input); return original(input); };
    await ctx.ai.fetchSuggestions();
    expect(ctx.ai.suggestions).toBeNull(); expect(sent).toEqual([]);
    await ctx.ai.confirmAssistance();
    expect(ctx.ai.suggestions).toHaveLength(2);
    expect(ctx.ai.suggestions!.map((s) => s.id)).toEqual(AI_FIXTURE_SUGGESTIONS.map((s) => s.id));
    expect(ctx.ai.drawerOpen).toBe(true);
    expect(ctx.ai.selectedIds).toEqual([]);
    expect(ctx.ai.error).toBeNull();
    expect(sent).toEqual([{ operationId: expect.stringMatching(/^[0-9a-f-]{36}$/), previewId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      selection: expect.objectContaining({ business: { purpose: 'case-suggestion', target: { collectionId: ctx.editor.locator!.collectionId, folderIds: ctx.editor.locator!.folderIds, apiId: ctx.editor.locator!.apiId } } }) }]);
  });

  it("请求期间切换接口：迟到的建议不会覆盖或采用到新接口", async () => {
    const ctx = await withConfig(await seeded());
    const requestedLocator = ctx.editor.locator!;
    const created = await ctx.api.nodeCreate({
      kind: "api",
      parent: {
        workspaceId: requestedLocator.workspaceId,
        groupId: requestedLocator.groupId,
        projectId: requestedLocator.projectId,
        collectionId: requestedLocator.collectionId,
        ...(requestedLocator.folderIds.length ? { folderIds: [...requestedLocator.folderIds] } : {}),
      },
      api: { name: "迟到结果目标接口", method: "GET", path: "/other", baseUrl: "http://127.0.0.1" },
    });
    if (created.kind !== "api") throw new Error("fixture must create an API node");
    let releaseApiSwitch!: () => void;
    let releaseRootSwitch!: () => void;
    const apiSwitchGate = new Promise<void>((resolve) => { releaseApiSwitch = resolve; });
    const rootSwitchGate = new Promise<void>((resolve) => { releaseRootSwitch = resolve; });
    const received: unknown[] = [];
    let callCount = 0;
    const originalStart = ctx.api.aiStart;
    ctx.api.aiStart = async (input) => {
      received.push(input);
      callCount += 1;
      await (callCount === 1 ? apiSwitchGate : rootSwitchGate);
      return originalStart(input);
    };

    await ctx.ai.fetchSuggestions();
    const pendingApiSwitch = ctx.ai.confirmAssistance();
    await ctx.editor.load(created.locator);
    releaseApiSwitch();
    await pendingApiSwitch;

    expect(received[0]).toMatchObject({ selection: { business: { target: { apiId: requestedLocator.apiId } } } });
    expect(ctx.editor.locator).toEqual(created.locator);
    expect(ctx.ai.suggestions).toBeNull();
    expect(ctx.ai.drawerOpen).toBe(false);
    expect(ctx.ai.suggestLoading).toBe(false);
    expect(ctx.ai.adopt()).toBe(0);

    await ctx.editor.load(requestedLocator);
    await ctx.ai.fetchSuggestions();
    const pendingRootSwitch = ctx.ai.confirmAssistance();
    const nextRoot = await ctx.api.wsOpen("/tmp/ws-root-switch");
    ctx.ws.apply(nextRoot);
    releaseRootSwitch();
    await pendingRootSwitch;
    expect(received[1]).toMatchObject({ selection: { business: { target: { apiId: requestedLocator.apiId } } } });
    expect(ctx.ws.root).toBe("/tmp/ws-root-switch");
    expect(ctx.ai.suggestions).toBeNull();
    expect(ctx.ai.drawerOpen).toBe(false);
    expect(ctx.ai.suggestLoading).toBe(false);
  });

  it("宿主拒绝缺少模型 → error 上屏、建议保持空、抽屉可读拒绝", async () => {
    const { ai, api } = await seeded();
    api.aiPrepareAssistance = async () => { throw new Error('missing-model'); };
    await ai.fetchSuggestions();
    expect(ai.error).toContain("missing-model");
    expect(ai.suggestions).toBeNull();
    expect(ai.drawerOpen).toBe(true);
  });
});

describe("ai store：勾选采用与丢弃（裁定③④，沿用任务 1 语义）", () => {
  it("adopt：勾选并入 editor.api.cases（沿用 core 本地 id），列表清空、抽屉关闭、**不触发保存**", async () => {
    const ctx = await withConfig(await seeded());
    await ctx.ai.fetchSuggestions();
    await ctx.ai.confirmAssistance();
    const before = ctx.editor.api!.cases.length;
    let saveCalls = 0;
    const original = ctx.api.apiSave.bind(ctx.api);
    ctx.api.apiSave = async (locator, asset, revision) => {
      saveCalls += 1;
      return original(locator, asset, revision);
    };
    ctx.ai.toggleSelect(ctx.ai.suggestions![0]!.id);
    const beforeReadOnlyAdopt = JSON.parse(JSON.stringify(ctx.editor.api!.cases)) as unknown;
    ctx.ws.readOnly = true;
    expect(ctx.ai.adopt()).toBe(0);
    expect(JSON.parse(JSON.stringify(ctx.editor.api!.cases))).toEqual(beforeReadOnlyAdopt);
    expect(ctx.editor.dirty).toBe(false);
    ctx.ws.readOnly = false;
    ctx.ai.toggleSelect(ctx.ai.suggestions![1]!.id);
    const count = ctx.ai.adopt();
    expect(count).toBe(2);
    expect(ctx.editor.api!.cases.length).toBe(before + 2);
    const adopted = ctx.editor.api!.cases.slice(before);
    expect(adopted.map((c) => c.name)).toEqual(AI_FIXTURE_SUGGESTIONS.map((s) => s.name));
    // id 沿用 core 本地生成的 ULID 契约（不再二次生成）
    expect(adopted.map((c) => c.id)).toEqual(AI_FIXTURE_SUGGESTIONS.map((s) => s.id));
    for (const c of adopted) {
      expect(c.assertions.length).toBeGreaterThan(0);
      for (const a of c.assertions) expect(a.id).toBeTruthy();
    }
    // 正式 AiSuggestedCase 的 pre/post operations 与断言完整进入新用例。
    expect(adopted.map((c) => c.preOperations)).toEqual(AI_FIXTURE_SUGGESTIONS.map((s) => s.preOperations));
    expect(adopted.map((c) => c.postOperations)).toEqual(AI_FIXTURE_SUGGESTIONS.map((s) => s.postOperations));
    // 列表清空 + 抽屉关闭
    expect(ctx.ai.suggestions).toBeNull();
    expect(ctx.ai.selectedIds).toEqual([]);
    expect(ctx.ai.drawerOpen).toBe(false);
    // 裁定③：采用本身不落盘——保存由用户显式触发（dirty 已点亮，等待既有保存链路）
    expect(saveCalls).toBe(0);
    expect(ctx.editor.dirty).toBe(true);
  });

  it("adopt：只采用勾选的子集；未勾选时 adopt 为空操作", async () => {
    const ctx = await withConfig(await seeded());
    await ctx.ai.fetchSuggestions();
    await ctx.ai.confirmAssistance();
    const before = ctx.editor.api!.cases.length;
    expect(ctx.ai.adopt()).toBe(0); // 未勾选
    expect(ctx.editor.api!.cases.length).toBe(before);
    ctx.ai.toggleSelect(ctx.ai.suggestions![1]!.id);
    expect(ctx.ai.selectedIds).toEqual([ctx.ai.suggestions![1]!.id]);
    const count = ctx.ai.adopt();
    expect(count).toBe(1);
    expect(ctx.editor.api!.cases.length).toBe(before + 1);
    expect(ctx.editor.api!.cases[before]!.name).toBe(AI_FIXTURE_SUGGESTIONS[1]!.name);
  });

  it("dismissSuggestions：关闭即丢弃（零落盘）——建议与勾选清空、抽屉关闭、editor 不动", async () => {
    const ctx = await withConfig(await seeded());
    await ctx.ai.fetchSuggestions();
    await ctx.ai.confirmAssistance();
    ctx.ai.toggleSelect(ctx.ai.suggestions![0]!.id);
    const casesBefore = JSON.parse(JSON.stringify(ctx.editor.api!.cases)) as unknown;
    ctx.ai.dismissSuggestions();
    expect(ctx.ai.suggestions).toBeNull();
    expect(ctx.ai.selectedIds).toEqual([]);
    expect(ctx.ai.drawerOpen).toBe(false);
    expect(ctx.editor.dirty).toBe(false);
    expect(JSON.parse(JSON.stringify(ctx.editor.api!.cases))).toEqual(casesBefore);
  });

  it("adopt：未加载接口（editor.api 为空）时为空操作", async () => {
    const api = createMemoryApi();
    api.seedWorkspace();
    const editor = useEditorStore(api, () => ({ root: "", readOnly: false }));
    const ai = createAiStore({ api, editor, storage: memStorage() });
    expect(ai.adopt()).toBe(0);
  });
});

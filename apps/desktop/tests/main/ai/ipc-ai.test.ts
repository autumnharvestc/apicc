// T9 migration of the original successful request/parser/locator/error coverage.
// Legacy methods are closed; successful calls use actual personal bindings and previews.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { TestCaseSchema } from "@apicc/core";
import { createIpcDeps } from "../../../src/main/ipc.js";
import { createSession } from "../../../src/main/session.js";
import { createAiKeyStore } from "../../../src/main/ai/config.js";
import { createDesktopAiPersonal } from "../../../src/main/ai/personal.js";
import type { AiPrepareInput, AiBusinessResultDto } from "../../../src/shared/ai/contract.js";
import type { ApiLocator } from "../../../src/shared/locations.js";
import { parseIpcArgs } from "../../../src/shared/ipc-contract.js";
import { IDS, makeWorkspace, persistWorkspace, uuid } from "../helpers/contract-assets.js";
const roots: string[] = [];
const directory = () => { const root = mkdtempSync(join(tmpdir(), "apicc-t9-ipc-migrated-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const storage = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "gnome_libsecret", encryptString: (v: string) => Buffer.from(Buffer.from(v).toString("base64")), decryptString: (v: Buffer) => Buffer.from(v.toString(), "base64").toString() };
const wireAssertion = { target: "status", op: "eq", expected: "200", path: null, headerName: null, cookieName: null, namespaces: null, match: null, optionsJson: null };
const valid = JSON.stringify({ cases: ["normal 200", "second 200"].map(name => ({ name, scope: "blue", parameters: [], preOperations: [], postOperations: [], assertions: [wireAssertion], reason: "contract", evidenceIds: [`contract:${IDS.sharedApi}`] })) });
const response = (content = valid, status = 200) => Response.json({ choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] }, { status });
function setup(content = valid, status = 200, transport?: typeof fetch) {
  const privateRoot = directory(), legacyRoot = directory(), workspaceRoot = directory(), session = createSession(), calls: { url: string; init: RequestInit }[] = [];
  const personal = createDesktopAiPersonal({ privateRoot, storage, platform: "win32" }), keyStore = createAiKeyStore({ dir: legacyRoot, storage });
  const deps = createIpcDeps({ session, pickDirectory: async () => workspaceRoot, saveFile: async () => "", ai: { personal, keyStore, fetch: transport ?? (async (url, init = {}) => { calls.push({ url: String(url), init }); return response(content, status); }) } });
  const owner = new EventEmitter(), event = { sender: owner };
  return { personal, keyStore, deps, owner, event, calls, privateRoot, legacyRoot, workspaceRoot, session };
}
it("final I7 actual IPC fixture legacy writer supports its Linux success intent", () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
    const f = setup(); let failure: unknown;
    try { f.keyStore.save("SYNTHETIC_LINUX_LEGACY_KEY"); } catch (error) { failure = error; }
    expect(failure).toBeUndefined();
    expect(f.keyStore.load()).toBe("SYNTHETIC_LINUX_LEGACY_KEY");
    expect(readFileSync(join(f.legacyRoot, "ai-key.json"), "utf8")).not.toContain("SYNTHETIC_LINUX_LEGACY_KEY");
  } finally { Object.defineProperty(process, "platform", descriptor); }
});
async function configure(f: ReturnType<typeof setup>, key = "sk-migrated-synthetic") {
  await f.deps.handle("ai:settings-write", f.event, { operation: "connection", expectedRevision: 1, connection: { id: "c", revision: 1, name: "Personal", owner: { kind: "personal" }, baseUrl: "https://ai.example.com/v1", auth: { kind: "bearer" }, headers: {}, protocols: ["openai-chat-completions"] } });
  await f.deps.handle("ai:settings-write", f.event, { operation: "credential", connectionId: "c", expectedRevision: 2, mode: "persistent", value: key });
  await f.deps.handle("ai:settings-write", f.event, { operation: "preferences", expectedRevision: 3, models: [{ id: "m", revision: 1, connectionId: "c", modelId: "model-x", protocol: "openai-chat-completions", structuredOutput: "json-object", streaming: false, supportedParameters: [], capabilities: { status: "unconfirmed", source: "manual" }, budgets: {}, purposeBudgets: {} }], bindings: [{ purpose: "case-suggestion", modelProfileId: "m", budgets: {} }] });
}
const locator: ApiLocator = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne, collectionId: IDS.collectionOne, folderIds: [], apiId: IDS.sharedApi };
function select(target = locator): AiPrepareInput["selection"] { const { workspaceId, groupId, projectId, ...api } = target; return { source: { kind: "local", project: { workspaceId, groupId, projectId } }, editGeneration: 1, business: { purpose: "case-suggestion", target: api } }; }
// Accepted schema-order deviation: these are post-implementation boundary checks,
// not historical RED, and do not authorize metadata/owner/cursor business logic.
const choicesUuid = "10000000-0000-4000-8000-000000000001";
it.each(["prepare-choices", "bodies-choices", "page-choices", "page-cursor"] as const)("final B accepted schema validates UUID at %s through the formal IPC parser", kind => {
  const channel = kind === "prepare-choices" ? "ai:prepare-assistance" : kind === "bodies-choices" ? "ai:inspect-choices" : "ai:read-choices-page";
  const input = (id: unknown) => kind === "prepare-choices" ? { selection: select(), bodySelection: [], choicesId: id }
    : kind === "bodies-choices" ? { operation: "bodies", choicesId: id, bodySelection: [] }
    : kind === "page-choices" ? { choicesId: id, section: "evidence" }
    : { choicesId: choicesUuid, section: "evidence", cursor: id };
  expect(parseIpcArgs(channel, [input(choicesUuid)])).toEqual([input(choicesUuid)]);
  for (const id of ["", "not-a-uuid", "10000000-0000-4000-8000-00000000000g", 1, null]) {
    expect(() => parseIpcArgs(channel, [input(id)])).toThrow(/入参校验失败/);
  }
});
it("final B accepted schema enforces integer page limit 1 through 50 on real owned choices", async () => {
  const f = setup(); await configure(f); await persistWorkspace(f.workspaceRoot, makeWorkspace()); await f.deps.handle('ws:open', {}, f.workspaceRoot);
  const choices = await f.deps.handle('ai:inspect-choices', f.event, { operation: 'capture', input: { selection: select() } });
  const input = { choicesId: choices.choicesId, section: "evidence" as const };
  expect(parseIpcArgs("ai:read-choices-page", [input])).toEqual([input]); // Default20 belongs to future runtime, not this schema.
  for (const limit of [1, 50]) {
    const valid = { ...input, limit };
    expect(parseIpcArgs("ai:read-choices-page", [valid])).toEqual([valid]);
    expect(await f.deps.handle("ai:read-choices-page", f.event, valid)).toMatchObject({ choicesId: choices.choicesId, section: 'evidence', total: 1, returned: 1 });
  }
  for (const limit of [0, 51, -1, 1.5, NaN, Infinity]) {
    await expect(f.deps.handle("ai:read-choices-page", f.event, { ...input, limit })).rejects.toThrow(/入参校验失败/);
  }
  expect(f.calls).toEqual([]);
});
it("final B accepted schema allows zero or 200 body selections and refuses 201 at actual owned IPC", async () => {
  const f = setup(); await configure(f); await persistWorkspace(f.workspaceRoot, makeWorkspace()); await f.deps.handle('ws:open', {}, f.workspaceRoot);
  const asset = f.session.locateApi(locator)!.api;
  if (asset.contract.request.protocol !== 'http') throw new Error('http fixture');
  asset.contract.request.body = { kind: 'json', content: '{}' }; await f.session.saveApi(locator, asset);
  const choices = await f.deps.handle('ai:inspect-choices', f.event, { operation: 'capture', input: { selection: select() } });
  const input = { operation: "bodies" as const, choicesId: choices.choicesId };
  for (const count of [0, 200]) {
    const valid = { ...input, bodySelection: Array.from({ length: count }, () => 'contract:request-body') };
    expect(parseIpcArgs("ai:inspect-choices", [valid])).toEqual([valid]);
    const updated = await f.deps.handle("ai:inspect-choices", f.event, valid);
    expect(updated.bodySelection).toEqual(valid.bodySelection); input.choicesId = updated.choicesId;
  }
  await expect(f.deps.handle("ai:inspect-choices", f.event, { ...input, bodySelection: Array.from({ length: 201 }, (_, index) => `cases[${index}].evidence.response.body`) })).rejects.toThrow(/入参校验失败/);
  expect(f.calls).toEqual([]);
});
it("final B I4 registered metadata IPC returns choices for a source already accepted by actual prepare", async () => {
  const f = setup(); await configure(f); await persistWorkspace(f.workspaceRoot, makeWorkspace()); await f.deps.handle("ws:open", {}, f.workspaceRoot);
  const input = { selection: select(), bodySelection: [] };
  const existing = await f.deps.handle("ai:prepare-assistance", f.event, input);
  expect(existing.preview.source.target).toMatchObject({ apiId: IDS.sharedApi });
  const outcome = await f.deps.handle("ai:inspect-choices", f.event, { operation: "capture", input: { selection: input.selection } }).then(value => ({ value }), error => ({ error }));
  expect(outcome).toMatchObject({ value: { source: { target: { apiId: IDS.sharedApi } }, bodySelection: [], bodies: { section: "bodies" } } });
  expect(f.calls).toEqual([]);
});
async function suggest(f: ReturnType<typeof setup>, target = locator) {
  const selection = select(target), prepared = await f.deps.handle("ai:prepare-assistance", f.event, { selection, bodySelection: [] });
  return f.deps.handle("ai:start", f.event, { selection, previewId: prepared.previewId, operationId: randomUUID() });
}
// Normal event delivery is the first wiring RED; owner/destroyed assertions remain blocked until it passes.
it('T11 sends actual runtime progress only to its live owner and skips a destroyed owner', async () => {
  const f = setup(); await configure(f); await persistWorkspace(f.workspaceRoot, makeWorkspace()); await f.deps.handle('ws:open', {}, f.workspaceRoot);
  const own: { channel: string; value: unknown }[] = [], other: unknown[] = [];
  let destroyed = false;
  Object.assign(f.owner, { send(channel: string, value: unknown) { own.push({ channel, value }); }, isDestroyed: () => destroyed });
  const unrelated = new EventEmitter();
  Object.assign(unrelated, { send(_channel: string, value: unknown) { other.push(value); }, isDestroyed: () => false });
  await f.deps.handle('ai:settings-read', { sender: unrelated });
  await suggest(f);
  expect(own.some(message => message.channel === 'ai:progress' && (message.value as { phase?: string }).phase === 'request')).toBe(true);
  expect(other).toEqual([]);
  for (const message of own) {
    expect(message.channel).toBe('ai:progress');
    expect(message.value).toMatchObject({ operationId: expect.stringMatching(/^[0-9a-f-]{36}$/), attempt: expect.any(Number) });
    expect(Object.keys(message.value as object).every(key => ['operationId', 'phase', 'attempt', 'receivedBytes'].includes(key))).toBe(true);
  }
  own.length = 0; destroyed = true;
  await suggest(f);
  expect(own).toEqual([]);
});
it("personal writes persist encrypted audience credentials, preserve them on metadata edits and never return key/ref", async () => {
  const f = setup(); await configure(f);
  const document = await f.personal.repository.read(), ref = document.connections[0]!.credentialRef!;
  const raw = readFileSync(join(f.privateRoot, "secrets", `${ref.slice("ai-desktop-secret:".length)}.json`), "utf8"); expect(raw).not.toContain("sk-migrated-synthetic");
  const { credentialRef: _privateRef, ...connection } = document.connections[0]!;
  await f.deps.handle("ai:settings-write", f.event, { operation: "connection", expectedRevision: 4, connection });
  const view = await f.deps.handle("ai:settings-read", f.event); expect(view.connections[0]!.credentialState).toBe("available"); expect(JSON.stringify(view)).not.toMatch(/credentialRef|sk-migrated|ai-desktop-secret/);
  expect((await f.personal.repository.read()).connections[0]!.credentialRef).toBe(ref); expect(f.calls).toHaveLength(0);
});
it("legal binding preserves referenced model/component prompt context, request shape and native unique case/assertion ids", async () => {
  const f = setup(); await configure(f); await persistWorkspace(f.workspaceRoot, makeWorkspace()); await f.deps.handle("ws:open", {}, f.workspaceRoot);
  const scope = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
  const model = await f.session.createModel(scope, { name: "AI_PROMPT_MODEL_SENTINEL", description: "referenced", schema: { kind: "object", properties: { promptSentinel: { kind: "scalar", type: "string" } }, required: ["promptSentinel"], additionalProperties: false } });
  const parameter = await f.session.createComponent(scope, { name: "AI_PROMPT_PARAMETER_SENTINEL", description: "referenced", kind: "parameter", definition: { location: "header", name: "AI_PROMPT_PARAMETER_SENTINEL", schema: { kind: "scalar", type: "string" }, required: true, description: "sentinel" } });
  const api = f.session.locateApi(locator)!.api; if (api.contract.request.protocol !== "http") throw new Error("http fixture");
  api.contract.request.body = { kind: "json", content: "{}", schema: { kind: "modelRef", modelId: model.id } }; api.contract.request.headers.push({ kind: "componentRef", id: uuid(9001), componentId: parameter.id, expectedKind: "parameter" }); await f.session.saveApi(locator, api);
  const result: AiBusinessResultDto = await suggest(f); if (result.purpose !== "case-suggestion") throw new Error("purpose");
  expect(result.cases.map(c => TestCaseSchema.parse(c))).toHaveLength(2); expect(new Set(result.cases.map(c => c.id)).size).toBe(2); expect(new Set(result.cases.flatMap(c => c.assertions.map(a => a.id))).size).toBe(2);
  expect(f.calls).toHaveLength(1); expect(f.calls[0]!.url).toBe("https://ai.example.com/v1/chat/completions"); expect(new Headers(f.calls[0]!.init.headers).get("authorization")).toBe("Bearer sk-migrated-synthetic");
  const payload = JSON.parse(String(f.calls[0]!.init.body)); expect(payload.model).toBe("model-x"); expect(payload.response_format).toEqual({ type: "json_object" }); expect(payload.messages[0].role).toBe("system");
  for (const text of ["AI_PROMPT_MODEL_SENTINEL", parameter.id, "AI_PROMPT_PARAMETER_SENTINEL"]) expect(payload.messages[1].content).toContain(text);
});
it("full locator selects the second project and missing API/config fail without provider requests", async () => {
  const f = setup(); await configure(f); await persistWorkspace(f.workspaceRoot, makeWorkspace()); await f.deps.handle("ws:open", {}, f.workspaceRoot);
  await suggest(f, { ...locator, groupId: IDS.groupTwo, projectId: IDS.projectTwo, collectionId: IDS.collectionTwo });
  expect(String(f.calls[0]!.init.body)).toContain("project two API"); expect(String(f.calls[0]!.init.body)).not.toContain("project one API");
  await expect(suggest(f, { ...locator, apiId: uuid(9999) })).rejects.toThrow(/target/); expect(f.calls).toHaveLength(1);
  const fresh = setup(); await persistWorkspace(fresh.workspaceRoot, makeWorkspace()); await fresh.deps.handle("ws:open", {}, fresh.workspaceRoot); await expect(suggest(fresh)).rejects.toThrow(); expect(fresh.calls).toHaveLength(0);
});
it.each([{ content: "{bad", status: 200, count: 2, error: /business-output-invalid/ }, { content: valid, status: 500, count: 1, error: /http/ }])("keeps parser/repair and normalized HTTP failures on the legal path: $status", async options => {
  const f = setup(options.content, options.status); await configure(f); await persistWorkspace(f.workspaceRoot, makeWorkspace()); await f.deps.handle("ws:open", {}, f.workspaceRoot);
  await expect(suggest(f)).rejects.toThrow(options.error); expect(f.calls).toHaveLength(options.count);
});
it("probe remains bound and minimal, while new malformed inputs and missing host give readable errors", async () => {
  const f = setup(); await configure(f); expect(await f.deps.handle("ai:connection-test", f.event, { modelProfileId: "m", operationId: randomUUID() })).toEqual({ ok: true });
  const body = JSON.parse(String(f.calls[0]!.init.body)); expect(body.messages).toHaveLength(1); expect(body.messages[0].content).toContain("JSON");
  await expect(f.deps.handle("ai:prepare-assistance", f.event, {} as never)).rejects.toThrow(/ai:prepare-assistance/);
  await expect(f.deps.handle("ai:connection-test", f.event, {} as never)).rejects.toThrow(/ai:connection-test/);
  const noHost = createIpcDeps({ session: createSession(), pickDirectory: async () => "", saveFile: async () => "" }); await expect(noHost.handle("ai:settings-read", f.event)).rejects.toThrow(/未配置/);
});
it.each(["ai:suggest", "ai:test-config"] as const)("T9 %s cannot send a legacy key to a renderer-selected address or expose it via old reads/writes", async channel => {
  const f = setup(); f.keyStore.save("sk-unconfirmed-legacy"); expect(await f.deps.handle("ai:get-config", f.event)).toEqual({ hasKey: false });
  await expect(f.deps.handle("ai:save-config", f.event, { baseUrl: "https://changed.example", model: "x", apiKey: "new" })).rejects.toThrow(/旧/);
  const input = channel === "ai:suggest" ? { locator, baseUrl: "https://changed.example", model: "x" } : { baseUrl: "https://changed.example", model: "x" }; await expect(f.deps.handle(channel, f.event, input as never)).rejects.toThrow(/旧/); expect(f.calls).toHaveLength(0); expect(f.keyStore.load()).toBe("sk-unconfirmed-legacy");
});
it("T9 does not deliver a provider result after actual roots change with identical locators", async () => {
  let entered!: () => void, release!: (response: Response) => void;
  const enteredPromise = new Promise<void>(r => { entered = r; }), gate = new Promise<Response>(r => { release = r; });
  const f = setup(valid, 200, async () => { entered(); return gate; }), rootB = directory();
  try {
    await configure(f); await persistWorkspace(f.workspaceRoot, makeWorkspace()); await persistWorkspace(rootB, makeWorkspace()); await f.deps.handle("ws:open", {}, f.workspaceRoot);
    const generation = f.session.captureDraftWriteContext().generation, pending = suggest(f).catch(e => e); await enteredPromise;
    await f.deps.handle("ws:open", {}, rootB); expect(f.session.locateApi(locator)).not.toBeNull(); expect(f.session.captureDraftWriteContext().generation).not.toBe(generation);
    release(response()); expect(await pending).toBeInstanceOf(Error);
  } finally { release(response("", 500)); }
});

import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopAiPersonal } from "../../../src/main/ai/personal.js";
import { createDesktopAiSources } from "../../../src/main/ai/sources.js";
import { createDesktopAiRuntime } from "../../../src/main/ai/runtime.js";
import { createSession } from "../../../src/main/session.js";
import { IDS, makeWorkspace, persistWorkspace } from "../helpers/contract-assets.js";
import { aiReportDigest } from "../../../src/shared/ai/reportDigest.js";
import type { AiPrepareInput } from "../../../src/shared/ai/contract.js";
import type { RunResult } from "@apicc/core";
import { createProjectSnapshot } from "@apicc/core";

const directories: string[] = [];
function directory() { const dir = mkdtempSync(join(tmpdir(), "apicc-t9-runtime-")); directories.push(dir); return dir; }
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const storage = { isEncryptionAvailable: () => true, encryptString: (v: string) => Buffer.from(Buffer.from(v).toString("base64")), decryptString: (v: Buffer) => Buffer.from(v.toString(), "base64").toString() };
const connection = { id: "c", revision: 1, name: "Personal", owner: { kind: "personal" as const }, baseUrl: "https://ai.example/v1", auth: { kind: "bearer" as const }, protocols: ["openai-chat-completions" as const], headers: {} };
export const selection = { source: { kind: "local" as const, project: { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne } }, editGeneration: 1, business: { purpose: "case-suggestion" as const, target: { collectionId: IDS.collectionOne, folderIds: [], apiId: IDS.sharedApi } } };
export const validOutput = JSON.stringify({ cases: [{ name: "suggested", scope: "base", parameters: [], assertions: [], preOperations: [], postOperations: [], reason: "contract", evidenceIds: [`contract:${IDS.sharedApi}`] }] });
export function response(text = validOutput) { return new Response(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }] }), { status: 200 }); }
export async function setup(transport?: typeof fetch, onProgress?: (event: import("@apicc/core").AiProgress & { operationId: string }, owner: object) => void) {
  const root = directory(), privateRoot = directory(), session = createSession();
  await persistWorkspace(root, makeWorkspace()); await session.open(root);
  const personal = createDesktopAiPersonal({ privateRoot, storage, platform: "win32" });
  await personal.host.saveConnection(connection, 1);
  await personal.host.setCredential("c", "sk-runtime-synthetic", "persistent", 2);
  const document = await personal.repository.read();
  document.models = [{ id: "m", revision: 1, connectionId: "c", modelId: "model-x", protocol: "openai-chat-completions", structuredOutput: "json-object", streaming: false, supportedParameters: [], capabilities: { status: "unconfirmed", source: "manual" }, budgets: {}, purposeBudgets: {} }];
  document.bindings = [{ purpose: "case-suggestion", modelProfileId: "m", budgets: {} }];
  await personal.repository.write(document, 3);
  const calls: { url: string; init: RequestInit }[] = [];
  const sources = createDesktopAiSources({ session });
  const runtime = createDesktopAiRuntime({ personal, sources, onProgress, fetch: transport ?? (async (url, init = {}) => { calls.push({ url: String(url), init }); return response(); }) });
  return { runtime, sources, personal, session, root, privateRoot, calls };
}
it("R7 gives a stable missing-model message when the case-suggestion purpose has no binding", async () => {
  const fixture = await setup();
  const document = await fixture.personal.repository.read();
  expect(document.models).toHaveLength(1);
  document.bindings = [];
  await fixture.personal.repository.write(document, document.revision);
  await expect(fixture.runtime.inspectChoices({ operation: "capture", input: { selection } }, {})).rejects.toThrow(/^missing-model$/);
  expect(fixture.calls).toEqual([]);
});

it("final B I4 valid owned report returns metadata before full count or input budget can block choice", async () => {
  const f = await setup(), owner = {};
  const document = await f.personal.repository.read(); document.bindings.push({ purpose: "report-analysis", modelProfileId: "m", budgets: { evidenceCount: 1, maxInputBytes: 4096 } });
  await f.personal.repository.write(document, document.revision);
  const project = selection.source.project, definitionRevision = createProjectSnapshot(f.session.locateProject(selection.source.project)!.project).definitionRevision;
  const report: RunResult = { collectionId: IDS.collectionOne, collectionName: "selected report", projectId: project.projectId,
    startedAt: "2026-11-01T00:00:00Z", finishedAt: "2026-11-01T00:00:01Z", total: 1, passed: 0, failed: 1,
    cases: [{ apiId: IDS.sharedApi, apiName: "saved API", caseId: IDS.sharedCase, caseName: "saved blue", locator: { ...selection.business.target, caseId: IDS.sharedCase, scope: "blue" },
      passed: false, durationMs: 2, assertions: [], error: "safe observation ".repeat(400), evidence: { identity: { projectId: project.projectId, definitionRevision }, state: "collected", truncated: false, scriptDiagnostics: "not-collected",
        response: { status: 503, headers: { text: "", truncated: false }, body: { text: "FINAL_B_UNSELECTED_BODY_PRIVATE", truncated: false } } } }] };
  await f.sources.rememberReport(owner, f.session.captureDraftWriteContext(), project, report, report);
  const input: AiPrepareInput = { selection: { source: selection.source, editGeneration: 0, business: { purpose: "report-analysis", report: { kind: "current", expectedReportDigest: await aiReportDigest(report) } } }, bodySelection: [] };
  const captured = await f.sources.capture(input, new AbortController().signal, owner);
  expect(captured.business).toMatchObject({ purpose: "report-analysis", report: { cases: [{ caseId: IDS.sharedCase }] } });
  await captured.assertCurrent(new AbortController().signal);
  await expect(f.runtime.prepare(input, owner)).rejects.toThrow(/^context-budget$/);
  const { bodySelection: _defaultOff, ...captureInput } = input;
  const outcome = await f.runtime.inspectChoices({ operation: "capture", input: captureInput }, owner).then(value => ({ value }), error => ({ error }));
  expect(outcome).toMatchObject({ value: { bodySelection: [], evidence: { section: "evidence", total: 7, selectable: 7, returned: 7, omitted: 0 },
    bodies: { section: "bodies", items: [{ location: "cases[0].evidence.response.body", available: true }] } } });
  expect(f.calls).toEqual([]);
});

// Guard tests are written now, but the controlled unavailable skeleton reaches
// only this success prerequisite. Each guard needs its own later reached RED.
async function choicesPrerequisite(f: Awaited<ReturnType<typeof setup>>, owner: object) {
  expect((await f.runtime.prepare({ selection, bodySelection: [] }, owner)).preview.source.target).toMatchObject({ apiId: IDS.sharedApi });
  const outcome = await f.runtime.inspectChoices({ operation: "capture", input: { selection } }, owner).then(value => ({ value }), error => ({ error }));
  expect(outcome).toHaveProperty("value");
  return "value" in outcome ? outcome.value : null;
}
async function ownedReportChoicesFixture(rows = 1) {
  const f = await setup(), owner = {}, project = selection.source.project;
  const definitionRevision = createProjectSnapshot(f.session.locateProject(project)!.project).definitionRevision;
  const document = await f.personal.repository.read(); document.bindings.push({ purpose: "report-analysis", modelProfileId: "m", budgets: {} }); await f.personal.repository.write(document, document.revision);
  const report: RunResult = { collectionId: IDS.collectionOne, collectionName: "saved choices report", projectId: project.projectId, startedAt: "2026-11-01T00:00:00Z", finishedAt: "2026-11-01T00:00:01Z", total: rows, passed: 0, failed: rows,
    cases: Array.from({ length: rows }, (_, index) => ({ apiId: IDS.sharedApi, apiName: "saved API", caseId: IDS.sharedCase, caseName: "saved blue", row: index, passed: false, durationMs: 1, assertions: [], locator: { ...selection.business.target, caseId: IDS.sharedCase, scope: "blue" },
      evidence: { identity: { projectId: project.projectId, definitionRevision, locator: { ...selection.business.target, caseId: IDS.sharedCase, scope: "blue" } }, state: "collected", scriptDiagnostics: "not-collected", truncated: false,
        response: { status: 503, headers: { text: "", truncated: false }, body: { text: "FINAL_B_PRIVATE_BODY_MUST_STAY_UNSELECTED", truncated: false } } } })) };
  await f.sources.rememberReport(owner, f.session.captureDraftWriteContext(), project, report, report);
  const input: AiPrepareInput = { selection: { source: selection.source, editGeneration: 0, business: { purpose: "report-analysis", report: { kind: "current", expectedReportDigest: await aiReportDigest(report) } } }, bodySelection: [] };
  const captured = await f.sources.capture(input, new AbortController().signal, owner);
  expect(captured.business).toMatchObject({ purpose: "report-analysis", report: { total: rows } }); await captured.assertCurrent(new AbortController().signal);
  const { bodySelection: _defaultOff, ...captureInput } = input;
  const outcome = await f.runtime.inspectChoices({ operation: "capture", input: captureInput }, owner).then(value => ({ value }), error => ({ error }));
  expect(outcome).toHaveProperty("value");
  return { ...f, owner, input, report, choices: "value" in outcome ? outcome.value : null };
}
it("final B frontier changing body selection rotates choices and keeps final evidence subset honest", async () => {
  const f = await ownedReportChoicesFixture(); if (!f.choices) return;
  const old = f.choices, location = "cases[0].evidence.response.body", before = JSON.stringify(f.report);
  expect(JSON.stringify(old)).not.toContain("FINAL_B_PRIVATE_BODY_MUST_STAY_UNSELECTED");
  const change = await f.runtime.inspectChoices({ operation: "bodies", choicesId: old.choicesId, bodySelection: [location] }, f.owner).then(value => ({ value }), error => ({ error }));
  expect(change).toHaveProperty('value');
  if (!('value' in change)) return;
  const changed = change.value;
  expect(changed.choicesId).not.toBe(old.choicesId); expect(changed.bodySelection).toEqual([location]);
  const stale = await f.runtime.prepare({ ...f.input, choicesId: old.choicesId }, f.owner).then(value => ({ value }), error => ({ error }));
  expect(stale).toHaveProperty("error");
  const summary = changed.evidence.items.find(item => item.kind === "logical-summary")!;
  const prepared = await f.runtime.prepare({ ...f.input, choicesId: changed.choicesId, bodySelection: [location], evidenceSelection: [summary.id] }, f.owner);
  expect(prepared.preview.evidence.map(item => item.id)).toEqual([summary.id]); expect(prepared.preview.included).not.toContain(location);
  expect(JSON.stringify(prepared)).not.toContain("FINAL_B_PRIVATE_BODY_MUST_STAY_UNSELECTED"); expect(JSON.stringify(f.report)).toBe(before); expect(f.calls).toEqual([]);
});
it("final B frontier bounded metadata catalogs and cursor pages preserve honest totals without values", async () => {
  const f = await ownedReportChoicesFixture(260); if (!f.choices) return;
  const choices = f.choices;
  expect.soft(choices.evidence).toMatchObject({ total: 1043, selectable: 1000, returned: 20, omitted: 43, complete: false });
  expect.soft(choices.bodies).toMatchObject({ total: 260, selectable: 200, returned: 20, omitted: 60, complete: false });
  const page = await f.runtime.readChoicesPage({ choicesId: choices.choicesId, section: "evidence", limit: 50 }, f.owner);
  expect(page.items).toHaveLength(50); expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBeLessThanOrEqual(65536);
  for (const item of page.items) for (const key of Object.keys(item)) expect(["id", "kind", "location", "state", "truncated"]).toContain(key);
  expect(JSON.stringify(page)).not.toContain("FINAL_B_PRIVATE_BODY_MUST_STAY_UNSELECTED");
  const cursor = page.nextCursor!;
  const next = await f.runtime.readChoicesPage({ choicesId: choices.choicesId, section: "evidence", cursor, limit: 50 }, f.owner);
  expect(next.items).toHaveLength(50); expect(next.items[0]).not.toEqual(page.items[0]);
  const reused = await f.runtime.readChoicesPage({ choicesId: choices.choicesId, section: "evidence", cursor, limit: 50 }, f.owner).then(value => ({ value }), error => ({ error }));
  expect(reused).toHaveProperty("error"); expect(f.report.cases).toHaveLength(260); expect(f.calls).toEqual([]);
});
it('final B layer2 owned metadata offers a real first page before cursor protections', async () => {
  const f = await setup(), owner = {}, choices = await choicesPrerequisite(f, owner); if (!choices) return;
  const outcome = await f.runtime.readChoicesPage({ choicesId: choices.choicesId, section: 'evidence', limit: 50 }, owner).then(value => ({ value }), error => ({ error }));
  expect(outcome).toMatchObject({ value: { choicesId: choices.choicesId, section: 'evidence', items: choices.evidence.items } });
});
it.each(['configuration', 'source'] as const)('final B layer3 body update rechecks captured %s authority', async kind => {
  const f = await ownedReportChoicesFixture(); if (!f.choices) return;
  if (kind === 'configuration') { const document = await f.personal.repository.read(); await f.personal.repository.write(document, document.revision); }
  else await f.session.open((await setup()).root);
  const outcome = await f.runtime.inspectChoices({ operation: 'bodies', choicesId: f.choices.choicesId, bodySelection: ['cases[0].evidence.response.body'] }, f.owner).then(value => ({ value }), error => ({ error }));
  expect(outcome).toHaveProperty('error'); expect(f.calls).toEqual([]);
});
it.each(['instruction', 'limit', 'edit-generation', 'body-selection'] as const)('final B layer3 final reprepare rejects changed fixed %s input', async kind => {
  const f = await ownedReportChoicesFixture(); if (!f.choices) return;
  const input = structuredClone(f.input);
  if (kind === 'instruction') input.instruction = 'different';
  if (kind === 'limit') input.limit = 1;
  if (kind === 'edit-generation') input.selection.editGeneration++;
  if (kind === 'body-selection') input.bodySelection = ['cases[0].evidence.response.body'];
  const summary = f.choices.evidence.items.find(item => item.kind === 'logical-summary')!;
  const outcome = await f.runtime.prepare({ ...input, choicesId: f.choices.choicesId, evidenceSelection: [summary.id] }, f.owner).then(value => ({ value }), error => ({ error }));
  expect(outcome).toHaveProperty('error'); expect(f.calls).toEqual([]);
});
it('final B layer3 closed catalog refuses out-of-catalog body and evidence without deleting report rows', async () => {
  const f = await ownedReportChoicesFixture(260); if (!f.choices) return;
  const reportId = f.choices.source.report!.reportId;
  const evidence = await f.runtime.prepare({ ...f.input, choicesId: f.choices.choicesId, evidenceSelection: [`${reportId}:e1040`] }, f.owner).then(value => ({ value }), error => ({ error }));
  expect.soft(evidence).toHaveProperty('error');
  const body = await f.runtime.inspectChoices({ operation: 'bodies', choicesId: f.choices.choicesId, bodySelection: ['cases[259].evidence.response.body'] }, f.owner).then(value => ({ value }), error => ({ error }));
  expect.soft(body).toHaveProperty('error'); expect(f.report.cases).toHaveLength(260); expect(f.calls).toEqual([]);
});
it.each(['page-id', 'body-id', 'forged-cursor', 'section', 'limit'] as const)('final B layer3 page and body reject mismatched %s', async kind => {
  const f = await ownedReportChoicesFixture(30); if (!f.choices) return;
  const page = await f.runtime.readChoicesPage({ choicesId: f.choices.choicesId, section: 'evidence', limit: 20 }, f.owner);
  expect(page.items).toHaveLength(20); expect(page.nextCursor).toBeTruthy();
  const outcome = kind === 'body-id'
    ? await f.runtime.inspectChoices({ operation: 'bodies', choicesId: randomUUID(), bodySelection: [] }, f.owner).then(value => ({ value }), error => ({ error }))
    : await f.runtime.readChoicesPage({ choicesId: kind === 'page-id' ? randomUUID() : f.choices.choicesId, section: kind === 'section' ? 'bodies' : 'evidence', limit: kind === 'limit' ? 1 : 20, cursor: kind === 'forged-cursor' ? randomUUID() : page.nextCursor }, f.owner).then(value => ({ value }), error => ({ error }));
  expect(outcome).toHaveProperty('error'); expect(f.calls).toEqual([]);
});
it.each(['page', 'bodies'] as const)('final B layer4 replacement during %s recheck cannot deliver the old choices', async kind => {
  const f = await setup(), owner = {}, original = f.sources.capture;
  let armed = false, enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  f.sources.capture = async (...args) => {
    const captured = await original(...args), check = captured.assertCurrent;
    captured.assertCurrent = async signal => { await check(signal); if (armed) { armed = false; enter(); await gate; } };
    return captured;
  };
  const choices = await choicesPrerequisite(f, owner); if (!choices) return;
  armed = true;
  const old = (kind === 'page' ? f.runtime.readChoicesPage({ choicesId: choices.choicesId, section: 'evidence' }, owner)
    : f.runtime.inspectChoices({ operation: 'bodies', choicesId: choices.choicesId, bodySelection: [] }, owner)).then(value => ({ value }), error => ({ error }));
  try {
    await entered;
    const current = await f.runtime.inspectChoices({ operation: 'capture', input: { selection } }, owner);
    release(); const outcome = await old;
    expect(outcome).toHaveProperty('error');
    expect((await f.runtime.readChoicesPage({ choicesId: current.choicesId, section: 'evidence' }, owner)).choicesId).toBe(current.choicesId);
  } finally { release(); await old; f.sources.capture = original; }
});
it('final B layer5 final prepare rechecks configuration after its async snapshot', async () => {
  const f = await setup(), owner = {}, choices = await choicesPrerequisite(f, owner); if (!choices) return;
  const snapshot = f.personal.host.snapshot;
  f.personal.host.snapshot = async () => { const result = await snapshot(); const doc = await f.personal.repository.read(); await f.personal.repository.write(doc, doc.revision); return result; };
  try {
    const outcome = await f.runtime.prepare({ selection, bodySelection: [], choicesId: choices.choicesId }, owner).then(value => ({ value }), error => ({ error }));
    expect(outcome).toHaveProperty('error'); expect(f.calls).toEqual([]);
  } finally { f.personal.host.snapshot = snapshot; }
});
it('final C R71 pending prepare cannot revive an included-body preview after bodies are explicitly removed', async () => {
  const f = await ownedReportChoicesFixture(); expect(f.choices).not.toBeNull(); if (!f.choices) return;
  const location = 'cases[0].evidence.response.body';
  const included = await f.runtime.inspectChoices({ operation: 'bodies', choicesId: f.choices.choicesId, bodySelection: [location] }, f.owner);
  const input = { ...f.input, choicesId: included.choicesId, bodySelection: [location] };
  const first = await f.runtime.prepare(input, f.owner);
  expect(first.preview.included).toContain(location);
  const snapshot = f.personal.host.snapshot;
  let enter!: () => void, release!: () => void, armed = true;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  f.personal.host.snapshot = async () => { const result = await snapshot(); if (armed) { armed = false; enter(); await gate; } return result; };
  const old = f.runtime.prepare(input, f.owner).then(value => ({ value }), error => ({ error }));
  try {
    await entered;
    const removed = await f.runtime.inspectChoices({ operation: 'bodies', choicesId: included.choicesId, bodySelection: [] }, f.owner);
    expect(removed.bodySelection).toEqual([]); expect(removed.choicesId).not.toBe(included.choicesId);
    expect((await f.runtime.readChoicesPage({ choicesId: removed.choicesId, section: 'evidence' }, f.owner)).choicesId).toBe(removed.choicesId);
    release(); const outcome = await old;
    expect.soft(outcome).toHaveProperty('error');
    // Exercise the real start gate without permitting a model call if it is broken.
    // A correctly rejected old prepare returns no ID, so the previous ID must also stay unusable.
    if (!('value' in outcome)) await expect(f.runtime.start({ previewId: first.previewId, selection: input.selection, operationId: randomUUID() }, f.owner)).rejects.toThrow(/preview/);
    expect(f.calls).toEqual([]);
  } finally { release(); await old; f.personal.host.snapshot = snapshot; }
});
it("final B frontier final subset reprepare retains the original captured binding and only selected evidence IDs", async () => {
  const f = await setup(), owner = {}, choices = await choicesPrerequisite(f, owner); if (!choices) return;
  const first = choices.evidence.items[0]!;
  const prepared = await f.runtime.prepare({ selection, choicesId: choices.choicesId, bodySelection: [], evidenceSelection: [first.id] }, owner);
  expect(prepared.preview.source.bindingId).toBe(choices.source.bindingId);
  expect(prepared.preview.evidence.map(item => item.id)).toEqual([first.id]); expect(f.calls).toEqual([]);
});
it("final B frontier page ownership and choices replacement invalidate old records without cross-owner data", async () => {
  const f = await setup(), owner = {}, choices = await choicesPrerequisite(f, owner); if (!choices) return;
  const own = await f.runtime.readChoicesPage({ choicesId: choices.choicesId, section: "evidence" }, owner);
  expect(own.items.length).toBeGreaterThan(0);
  const foreign = await f.runtime.readChoicesPage({ choicesId: choices.choicesId, section: "evidence" }, {}).then(value => ({ value }), error => ({ error }));
  expect(foreign).toHaveProperty("error");
  const replacement = await f.runtime.inspectChoices({ operation: "capture", input: { selection } }, owner);
  expect(replacement.choicesId).not.toBe(choices.choicesId);
  const old = await f.runtime.prepare({ selection, choicesId: choices.choicesId, bodySelection: [] }, owner).then(value => ({ value }), error => ({ error }));
  expect(old).toHaveProperty("error"); expect(f.calls).toEqual([]);
});
it.each(["configuration", "source", "owner-close"] as const)("final B frontier page and reprepare reject changed %s authority", async kind => {
  const f = await setup(), owner = {}, choices = await choicesPrerequisite(f, owner); if (!choices) return;
  expect((await f.runtime.readChoicesPage({ choicesId: choices.choicesId, section: "evidence" }, owner)).items.length).toBeGreaterThan(0);
  if (kind === "configuration") { const doc = await f.personal.repository.read(); await f.personal.repository.write(doc, doc.revision); }
  else if (kind === "source") await f.session.open((await setup()).root);
  else f.runtime.clearOwner(owner);
  const page = await f.runtime.readChoicesPage({ choicesId: choices.choicesId, section: "evidence" }, owner).then(value => ({ value }), error => ({ error }));
  const preview = await f.runtime.prepare({ selection, choicesId: choices.choicesId, bodySelection: [] }, owner).then(value => ({ value }), error => ({ error }));
  expect.soft(page).toHaveProperty("error"); expect.soft(preview).toHaveProperty("error"); expect(f.calls).toEqual([]);
});
it("final B frontier late inspection never replaces the newer owner choices", async () => {
  const f = await setup(), owner = {}, prerequisite = await choicesPrerequisite(f, owner); if (!prerequisite) return;
  const original = f.sources.capture; let enter!: () => void, release!: () => void, first = true;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  f.sources.capture = async (...args) => { const captured = await original(...args); if (first) { first = false; enter(); await gate; } return captured; };
  const late = f.runtime.inspectChoices({ operation: "capture", input: { selection } }, owner).then(value => ({ value }), error => ({ error }));
  try {
    await entered;
    const current = await f.runtime.inspectChoices({ operation: "capture", input: { selection } }, owner);
    release(); await late;
    expect((await f.runtime.readChoicesPage({ choicesId: current.choicesId, section: "evidence" }, owner)).choicesId).toBe(current.choicesId);
    expect(f.calls).toEqual([]);
  } finally { release(); await late; f.sources.capture = original; f.runtime.clearOwner(owner); }
});
async function enableDiscovery(personal: Awaited<ReturnType<typeof setup>>["personal"]) {
  const template = { formatVersion: 1 as const, id: "i1", revision: 1, name: "I1", baseUrl: "https://ai.example/v1", auth: { kind: "bearer" as const }, headers: {}, protocols: ["openai-chat-completions" as const], defaultProtocol: "openai-chat-completions" as const, modelDiscovery: true };
  await personal.catalog({ file: "i1.json", document: { formatVersion: 1, providers: [template] }, apply: true });
  const document = await personal.repository.read(); await personal.host.saveConnection({ ...document.connections[0]!, templateSource: { id: "i1", revision: 1 } }, document.revision);
}

describe("desktop AI runtime", () => {
  // I1: delaying only the real repository's async IO must not hide an already
  // issued operation from its owner's cancel channel or allow later transport.
  it.each([
    { method: "testConnection" as const, stage: "snapshot" },
    { method: "discover" as const, stage: "snapshot" },
    { method: "discover" as const, stage: "catalog" },
  ])("I1 cancels $method while $stage capture is pending, before any request", async ({ method, stage }) => {
    const f = await setup(async () => { f.calls.push({ url: "unexpected transport", init: {} }); return method === "discover" ? Response.json({ data: [{ id: "safe-model" }] }) : response('{"ok":true}'); });
    if (method === "discover") {
      const template = { formatVersion: 1 as const, id: "i1", revision: 1, name: "I1", baseUrl: "https://ai.example/v1", auth: { kind: "bearer" as const }, headers: {}, protocols: ["openai-chat-completions" as const], defaultProtocol: "openai-chat-completions" as const, modelDiscovery: true };
      await f.personal.catalog({ file: "i1.json", document: { formatVersion: 1, providers: [template] }, apply: true });
      const doc = await f.personal.repository.read(); await f.personal.host.saveConnection({ ...doc.connections[0]!, templateSource: { id: "i1", revision: 1 } }, doc.revision);
    }
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(r => { enter = r; }), gate = new Promise<void>(r => { release = r; });
    const originalRead = f.personal.repository.read, originalCatalogRead = f.personal.repository.readProviderFiles;
    const originalGet = f.personal.backend.get, originalResolve = f.personal.host.credentialResolver.resolve;
    let backendReads = 0, credentialResolutions = 0, capturedWork: Promise<unknown> | undefined;
    f.personal.backend.get = async (ref, audience) => { backendReads++; return originalGet.call(f.personal.backend, ref, audience); };
    f.personal.host.credentialResolver.resolve = async connection => { credentialResolutions++; return originalResolve(connection); };
    if (stage === "snapshot") f.personal.repository.read = () => { const work = (async () => { enter(); await gate; return originalRead(); })(); capturedWork = work; return work; };
    else f.personal.repository.readProviderFiles = () => { const work = (async () => { enter(); await gate; return originalCatalogRead(); })(); capturedWork = work; return work; };
    const owner = {}, operationId = randomUUID();
    const pending = (method === "testConnection" ? f.runtime.testConnection({ operationId, modelProfileId: "m" }, owner) : f.runtime.discover({ operationId, connectionId: "c" }, owner)).then(value => ({ value }), error => ({ error }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await entered; const readsBeforeCancel = backendReads, resolutionsBeforeCancel = credentialResolutions, cancellation = f.runtime.cancel(operationId, owner);
      const settledBeforeRelease = await Promise.race([pending.then(() => true), new Promise<boolean>(r => { timer = setTimeout(() => r(false), 200); })]);
      release(); const outcome = await pending; await capturedWork;
      expect({ cancelled: cancellation.cancelled, settledBeforeRelease, delivered: "value" in outcome, requests: f.calls.length, lateBackendReads: backendReads - readsBeforeCancel, lateCredentialResolutions: credentialResolutions - resolutionsBeforeCancel }).toEqual({ cancelled: true, settledBeforeRelease: true, delivered: false, requests: 0, lateBackendReads: 0, lateCredentialResolutions: 0 });
    } finally { if (timer) clearTimeout(timer); release(); await pending; await capturedWork; f.personal.repository.read = originalRead; f.personal.repository.readProviderFiles = originalCatalogRead; f.personal.backend.get = originalGet; f.personal.host.credentialResolver.resolve = originalResolve; f.runtime.clearOwner(owner); }
  });
  it.each(["testConnection", "discover"] as const)("I1 %s counts exhausted snapshot time against its actual configured deadline", async method => {
    let calls = 0; const f = await setup(async () => { calls++; return method === "discover" ? Response.json({ data: [{ id: "safe" }] }) : response('{"ok":true}'); });
    if (method === "discover") await enableDiscovery(f.personal);
    const document = await f.personal.repository.read(); document.application.protection.connectionTestTimeoutMs = 1000; document.application.protection.modelDiscoveryTimeoutMs = 1000; await f.personal.repository.write(document, document.revision);
    const original = f.personal.repository.read; let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(r => { enter = r; }), gate = new Promise<void>(r => { release = r; });
    f.personal.repository.read = async () => { const captured = await original(); enter(); await gate; return captured; };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const owner = {}, operationId = randomUUID();
    const pending = (method === "testConnection" ? f.runtime.testConnection({ operationId, modelProfileId: "m" }, owner) : f.runtime.discover({ operationId, connectionId: "c" }, owner)).then(value => ({ value }), error => ({ error }));
    try { await entered; await vi.advanceTimersByTimeAsync(1001); release(); const outcome = await pending; expect({ rejected: "error" in outcome, calls }).toEqual({ rejected: true, calls: 0 }); }
    finally { release(); await pending; vi.useRealTimers(); f.personal.repository.read = original; f.runtime.clearOwner(owner); }
  });

  it.each(["testConnection", "discover"] as const)("I1 %s permits slow capture inside a legal longer budget instead of an invented short default", async method => {
    let calls = 0; const f = await setup(async () => { calls++; return method === "discover" ? Response.json({ data: [{ id: "safe" }] }) : response('{"ok":true}'); });
    if (method === "discover") await enableDiscovery(f.personal);
    const document = await f.personal.repository.read(); document.application.protection.connectionTestTimeoutMs = 60000; document.application.protection.modelDiscoveryTimeoutMs = 60000; await f.personal.repository.write(document, document.revision);
    const original = f.personal.repository.read; let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(r => { enter = r; }), gate = new Promise<void>(r => { release = r; });
    f.personal.repository.read = async () => { const captured = await original(); enter(); await gate; return captured; };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const owner = {}, operationId = randomUUID();
    const pending = (method === "testConnection" ? f.runtime.testConnection({ operationId, modelProfileId: "m" }, owner) : f.runtime.discover({ operationId, connectionId: "c" }, owner)).then(value => ({ value }), error => ({ error }));
    try { await entered; await vi.advanceTimersByTimeAsync(45000); release(); expect(await pending).toHaveProperty("value"); expect(calls).toBe(1); }
    finally { release(); await pending; vi.useRealTimers(); f.personal.repository.read = original; f.runtime.clearOwner(owner); }
  });

  it.each([{ method: "testConnection" as const, ceiling: 180000 }, { method: "discover" as const, ceiling: 120000 }])("I1 $method terminates an unknown never-returning snapshot only at its existing schema deadline ceiling", async ({ method, ceiling }) => {
    const f = await setup(), original = f.personal.repository.read; let release!: () => void;
    const gate = new Promise<void>(r => { release = r; }); f.personal.repository.read = async () => { await gate; return original(); };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const owner = {}, operationId = randomUUID(); let settled = false;
    const pending = (method === "testConnection" ? f.runtime.testConnection({ operationId, modelProfileId: "m" }, owner) : f.runtime.discover({ operationId, connectionId: "c" }, owner)).then(value => ({ value }), error => ({ error })).then(value => { settled = true; return value; });
    try {
      await vi.advanceTimersByTimeAsync(ceiling - 1); expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1); expect(settled).toBe(true); expect(await pending).toHaveProperty("error"); expect(f.calls).toHaveLength(0);
    } finally { release(); await pending; vi.useRealTimers(); f.personal.repository.read = original; f.runtime.clearOwner(owner); }
  });

  it("I1 bounds unknown captures by the existing schema capacity and recycles cancelled reservations before late reads finish", async () => {
    const f = await setup(), owner = {}, original = f.personal.repository.read;
    let release!: () => void; const gate = new Promise<void>(r => { release = r; }); f.personal.repository.read = async () => { await gate; return original(); };
    const ids = Array.from({ length: 40 }, () => randomUUID());
    const pending = ids.map(operationId => f.runtime.testConnection({ operationId, modelProfileId: "m" }, owner).catch(error => error));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const extra = f.runtime.testConnection({ operationId: randomUUID(), modelProfileId: "m" }, {}).then(() => "delivered", error => error instanceof Error ? error.message : "other error");
    try {
      const outcome = await Promise.race([extra, new Promise<string>(r => { timer = setTimeout(() => r("still-reading"), 200); })]);
      const cancellations = ids.map(id => f.runtime.cancel(id, owner).cancelled);
      f.personal.repository.read = original; release(); await Promise.all(pending); await extra;
      expect(outcome).toMatch(/capacity/); expect(cancellations.every(Boolean)).toBe(true); expect(f.calls).toHaveLength(0);
      expect(await f.runtime.testConnection({ operationId: ids[0]!, modelProfileId: "m" }, owner)).toEqual({ ok: true }); expect(f.calls).toHaveLength(1);
    } finally { if (timer) clearTimeout(timer); release(); await Promise.all(pending); await extra; f.personal.repository.read = original; f.runtime.clearOwner(owner); }
  });

  it("I1 rejects duplicate IDs during capture and observes a cancelled read's late failure without erasing a reused ID", async () => {
    let transportEntered!: () => void, finishTransport!: (value: Response) => void;
    const sending = new Promise<void>(r => { transportEntered = r; }), transport = new Promise<Response>(r => { finishTransport = r; });
    const f = await setup(async () => { transportEntered(); return transport; }), owner = {}, id = randomUUID(), original = f.personal.repository.read;
    let entered!: () => void, fail!: (error: Error) => void;
    const reading = new Promise<void>(r => { entered = r; }), lateRead = new Promise<void>((_r, reject) => { fail = reject; });
    let firstRead = true; f.personal.repository.read = async () => { if (firstRead) { firstRead = false; entered(); await lateRead; } return original(); };
    const first = f.runtime.testConnection({ operationId: id, modelProfileId: "m" }, owner).catch(error => error);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await reading; const duplicate = f.runtime.testConnection({ operationId: id, modelProfileId: "m" }, owner).catch(error => error);
      const duplicateOutcome = await Promise.race([duplicate, new Promise<string>(r => { timer = setTimeout(() => r("not-rejected"), 200); })]);
      const cancelled = f.runtime.cancel(id, owner);
      if (!(duplicateOutcome instanceof Error) || !cancelled.cancelled) { fail(new Error("release failing baseline read")); finishTransport(response()); await first; await duplicate; }
      expect(duplicateOutcome).toBeInstanceOf(Error); expect(cancelled).toEqual({ cancelled: true }); await first;
      const next = f.runtime.testConnection({ operationId: id, modelProfileId: "m" }, owner).catch(error => error); await sending;
      fail(new Error("synthetic late readonly failure")); await Promise.resolve();
      expect(f.runtime.cancel(id, owner)).toEqual({ cancelled: true }); finishTransport(response()); expect(await next).toBeInstanceOf(Error);
    } finally { if (timer) clearTimeout(timer); fail(new Error("cleanup readonly failure")); finishTransport(response()); await first; f.personal.repository.read = original; f.runtime.clearOwner(owner); }
  });

  // Feature-wiring RED; no claims that an unimplemented guard was reached.
  it("previews without external traffic, then sends the captured legal binding and returns native cases", async () => {
    const { runtime, calls, root } = await setup(); const owner = {};
    const prepared = await runtime.prepare({ selection, bodySelection: [] }, owner);
    expect(calls).toHaveLength(0);
    expect(prepared.preview).toMatchObject({ purpose: "case-suggestion", destination: { baseUrl: "https://ai.example/v1", modelId: "model-x" }, source: { projectId: IDS.projectOne } });
    expect(JSON.stringify(prepared)).not.toContain(root);
    expect(prepared.preview).not.toHaveProperty("messages");
    const result = await runtime.start({ previewId: prepared.previewId, operationId: randomUUID(), selection }, owner);
    expect(result).toMatchObject({ purpose: "case-suggestion", cases: [{ name: "suggested" }], bindingId: prepared.preview.source.bindingId });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://ai.example/v1/chat/completions");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-runtime-synthetic");
    expect(String(calls[0]!.init.body)).toContain("project one API");
    expect(String(calls[0]!.init.body)).not.toContain("project two API");
  });

  it("binds previews to actual owner and complete target; source or config changes require another preview", async () => {
    const { runtime, calls, session, personal } = await setup(); const owner = {}, stranger = {};
    const prepared = await runtime.prepare({ selection, bodySelection: [] }, owner);
    await expect(runtime.start({ previewId: prepared.previewId, operationId: randomUUID(), selection }, stranger)).rejects.toThrow();
    await expect(runtime.start({ previewId: prepared.previewId, operationId: randomUUID(), selection: { ...selection, business: { ...selection.business, target: { ...selection.business.target, folderIds: [IDS.folderOne] } } } }, owner)).rejects.toThrow();
    expect(calls).toHaveLength(0);
    const next = await runtime.prepare({ selection, bodySelection: [] }, owner);
    await session.open((await setup()).root);
    await expect(runtime.start({ previewId: next.previewId, operationId: randomUUID(), selection }, owner)).rejects.toThrow();
    const current = await runtime.prepare({ selection, bodySelection: [] }, owner);
    const doc = await personal.repository.read(); await personal.repository.write(doc, doc.revision);
    await expect(runtime.start({ previewId: current.previewId, operationId: randomUUID(), selection }, owner)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("rejects late results after an actual root switch and cancels only the issuing owner", async () => {
    let entered!: () => void, release!: (value: Response) => void;
    const sending = new Promise<void>(r => { entered = r; });
    const pendingResponse = new Promise<Response>(r => { release = r; });
    const { runtime, session } = await setup(async () => { entered(); return pendingResponse; });
    const owner = {}, operationId = randomUUID();
    const preview = await runtime.prepare({ selection, bodySelection: [] }, owner);
    const pending = runtime.start({ previewId: preview.previewId, operationId, selection }, owner).then(value => ({ value }), error => ({ error }));
    await sending;
    expect(runtime.cancel(operationId, {})).toEqual({ cancelled: false });
    await session.open((await setup()).root);
    release(response());
    expect(await pending).toHaveProperty("error");
    const again = await runtime.prepare({ selection, bodySelection: [] }, owner);
    const nextId = randomUUID();
    const cancelled = runtime.start({ previewId: again.previewId, operationId: nextId, selection }, owner).catch(error => error);
    expect(runtime.cancel(nextId, owner)).toEqual({ cancelled: true });
    expect(await cancelled).toBeInstanceOf(Error);
  });

  it("sanitizes a genuine synthetic provider credential echo before returning candidates", async () => {
    const text = JSON.stringify({ cases: [{ name: "sk-runtime-synthetic", scope: "base", parameters: [], assertions: [], preOperations: [], postOperations: [], reason: "Bearer sk-runtime-synthetic", evidenceIds: [`contract:${IDS.sharedApi}`] }] });
    const { runtime } = await setup(async () => response(text)); const owner = {};
    const preview = await runtime.prepare({ selection, bodySelection: [] }, owner);
    const out = await runtime.start({ previewId: preview.previewId, operationId: randomUUID(), selection }, owner);
    expect(JSON.stringify(out)).not.toContain("sk-runtime-synthetic");
    expect(out).toMatchObject({ purpose: "case-suggestion", cases: [{ name: "[REDACTED]" }] });
  });

  it("cancels an actually queued operation and owner destruction interrupts a body read", async () => {
    let calls = 0, cancelled = false; const phases: string[] = [];
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('{"choices":[')); }, cancel() { cancelled = true; } });
    const { runtime } = await setup(async () => { calls++; return new Response(stream); }, event => phases.push(event.phase));
    const firstOwner = {}, secondOwner = {}, firstId = randomUUID(), secondId = randomUUID();
    try {
      const a = await runtime.prepare({ selection, bodySelection: [] }, firstOwner);
      const first = runtime.start({ previewId: a.previewId, operationId: firstId, selection }, firstOwner).catch(e => e);
      await vi.waitFor(() => expect(phases).toContain("receiving"));
      const b = await runtime.prepare({ selection, bodySelection: [] }, secondOwner);
      const second = runtime.start({ previewId: b.previewId, operationId: secondId, selection }, secondOwner).catch(e => e);
      await vi.waitFor(() => expect(phases).toContain("queued"));
      expect(runtime.cancel(secondId, secondOwner)).toEqual({ cancelled: true }); expect(await second).toBeInstanceOf(Error);
      runtime.clearOwner(firstOwner); expect(await first).toBeInstanceOf(Error);
      expect(calls).toBe(1); expect(cancelled).toBe(true);
      await expect(runtime.prepare({ selection, bodySelection: [] }, firstOwner)).rejects.toThrow(/owner/);
    } finally { runtime.clearOwner(firstOwner); runtime.clearOwner(secondOwner); }
  });

  it("freezes endpoint, auth and repair budget for the operation while later settings change", async () => {
    let announce!: () => void, release!: (response: Response) => void;
    const entered = new Promise<void>(r => { announce = r; }), pendingResponse = new Promise<Response>(r => { release = r; });
    const traffic: { url: string; auth: string | null }[] = [];
    const { runtime, personal } = await setup(async (url, init) => { traffic.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") }); if (traffic.length === 1) { announce(); return pendingResponse; } return response(); });
    const owner = {}, preview = await runtime.prepare({ selection, bodySelection: [] }, owner);
    const pending = runtime.start({ previewId: preview.previewId, operationId: randomUUID(), selection }, owner);
    await entered;
    const doc = await personal.repository.read(); await personal.host.saveConnection({ ...doc.connections[0]!, baseUrl: "https://new-address.example/v1" }, doc.revision);
    release(response("not valid JSON"));
    expect(await pending).toMatchObject({ purpose: "case-suggestion" });
    expect(traffic).toEqual([{ url: "https://ai.example/v1/chat/completions", auth: "Bearer sk-runtime-synthetic" }, { url: "https://ai.example/v1/chat/completions", auth: "Bearer sk-runtime-synthetic" }]);
  });

  it("cancels the actual repair request through the same operation and never delivers its late valid result", async () => {
    let entered!: () => void, release!: (value: Response) => void, calls = 0, repairSignal: AbortSignal | undefined;
    const repairing = new Promise<void>(r => { entered = r; }), gate = new Promise<Response>(r => { release = r; });
    const { runtime } = await setup(async (_url, init) => { if (++calls === 1) return response("invalid JSON"); repairSignal = init?.signal ?? undefined; entered(); return gate; });
    const owner = {}, id = randomUUID(), preview = await runtime.prepare({ selection, bodySelection: [] }, owner);
    const pending = runtime.start({ previewId: preview.previewId, operationId: id, selection }, owner).catch(e => e);
    try {
      await Promise.race([repairing, pending.then(value => { throw value; })]); expect(calls).toBe(2);
      expect(runtime.cancel(id, {})).toEqual({ cancelled: false }); expect(runtime.cancel(id, owner)).toEqual({ cancelled: true });
      expect(repairSignal?.aborted).toBe(true); release(response()); expect(await pending).toBeInstanceOf(Error); expect(calls).toBe(2);
    } finally { release(response()); runtime.clearOwner(owner); }
  });

  it("uses an explicit fixed probe without project content and honors its one-second protection deadline", async () => {
    let entered!: () => void; const sent = new Promise<void>(r => { entered = r; }); let body = "", signal: AbortSignal | undefined;
    const { runtime, personal } = await setup(async (_url, init) => { body = String(init?.body); signal = init?.signal ?? undefined; entered(); return new Promise<Response>(() => {}); });
    const doc = await personal.repository.read(); doc.application.protection.connectionTestTimeoutMs = 1000; await personal.repository.write(doc, doc.revision);
    vi.useFakeTimers();
    try {
      const pending = runtime.testConnection({ modelProfileId: "m", operationId: randomUUID() }, {}).catch(error => error);
      await Promise.race([sent, pending.then(error => { throw error; })]); expect(body).toContain("JSON"); expect(body).not.toContain("project one API");
      expect(JSON.parse(body).max_completion_tokens).toBe(16);
      await vi.advanceTimersByTimeAsync(1000); expect(await pending).toBeInstanceOf(Error); expect(signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("discovers only a captured template revision with modelDiscovery and returns safe unconfirmed model IDs", async () => {
    const traffic: string[] = [];
    const { runtime, personal } = await setup(async (url, init) => { traffic.push(String(url)); expect(init).toMatchObject({ method: "GET", redirect: "error" }); return Response.json({ data: [{ id: "hand-picked" }, { id: "sk-runtime-synthetic" }] }); });
    const owner = {};
    expect(await runtime.discover({ connectionId: "c", operationId: randomUUID() }, owner)).toMatchObject({ status: "unsupported" }); expect(traffic).toEqual([]);
    const template = { formatVersion: 1 as const, id: "custom", revision: 1, name: "Custom", baseUrl: "https://ai.example/v1", auth: { kind: "bearer" as const }, headers: {}, protocols: ["openai-chat-completions" as const], defaultProtocol: "openai-chat-completions" as const, modelDiscovery: true };
    await personal.catalog({ file: "custom.json", document: { formatVersion: 1, providers: [template] }, apply: true });
    let doc = await personal.repository.read(); await personal.host.saveConnection({ ...doc.connections[0]!, templateSource: { id: "custom", revision: 1 } }, doc.revision);
    expect(await runtime.discover({ connectionId: "c", operationId: randomUUID() }, owner)).toEqual({ status: "available", models: [{ id: "hand-picked" }] });
    expect(traffic).toEqual(["https://ai.example/v1/models"]);
    await personal.catalog({ file: "custom.json", document: { formatVersion: 1, providers: [{ ...template, revision: 2 }] }, apply: true, confirmConflicts: true });
    expect(await runtime.discover({ connectionId: "c", operationId: randomUUID() }, owner)).toMatchObject({ status: "unsupported" }); expect(traffic).toHaveLength(1);
    doc = await personal.repository.read(); expect(doc.models[0]!.modelId).toBe("model-x");
  });
});

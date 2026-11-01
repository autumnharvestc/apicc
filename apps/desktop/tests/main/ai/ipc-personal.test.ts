import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { TestCaseSchema, createProjectSnapshot } from "@apicc/core";
import { aiReportDigest } from "../../../src/shared/ai/reportDigest.js";
import { createIpcDeps } from "../../../src/main/ipc.js";
import { createSession } from "../../../src/main/session.js";
import { createDesktopAiPersonal } from "../../../src/main/ai/personal.js";
import { createAiKeyStore } from "../../../src/main/ai/config.js";
import { IDS, makeWorkspace, persistWorkspace } from "../helpers/contract-assets.js";
import type { AiSettingsView, AiPrepareInput, AiBusinessResultDto } from "../../../src/shared/ai/contract.js";
const dirs: string[] = [];
function directory() { const dir = mkdtempSync(join(tmpdir(), "apicc-t9-ipc-")); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const storage = { isEncryptionAvailable: () => true, encryptString: (v: string) => Buffer.from(Buffer.from(v).toString("base64")), decryptString: (v: Buffer) => Buffer.from(v.toString(), "base64").toString() };
const wireCase = (name: string) => ({ name, scope: "base", parameters: [], preOperations: [], postOperations: [], assertions: [], reason: "contract", evidenceIds: [`contract:${IDS.sharedApi}`] });
function setup(status = 200, invalid = false) {
  const keyRoot = directory(), session = createSession(), calls: { url: string; init: RequestInit }[] = [];
  const personal = createDesktopAiPersonal({ privateRoot: directory(), storage, platform: "win32" });
  const deps = createIpcDeps({ session, pickDirectory: async () => "", saveFile: async () => "", ai: { personal, keyStore: createAiKeyStore({ dir: keyRoot, storage }), fetch: async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return Response.json({ choices: [{ index: 0, message: { role: "assistant", content: invalid ? "bad output" : JSON.stringify({ cases: [wireCase("first"), wireCase("second")] }) }, finish_reason: "stop" }] }, { status });
  } } });
  // Raw IPC is intentionally exercised before feature channels are wired; missing
  // channel is recorded as feature wiring, never a reached security guard.
  const invoke = deps.handle as unknown as (channel: string, event: unknown, ...args: unknown[]) => Promise<unknown>;
  const owner = new EventEmitter();
  return { invoke, owner, calls, personal, deps, session };
}
async function configured(f: ReturnType<typeof setup>) {
  await f.invoke("ai:settings-write", { sender: f.owner }, { operation: "connection", expectedRevision: 1, connection: { id: "c", revision: 1, name: "Personal", owner: { kind: "personal" }, baseUrl: "https://bound.example/v1", auth: { kind: "bearer" }, headers: {}, protocols: ["openai-chat-completions"] } });
  await f.invoke("ai:settings-write", { sender: f.owner }, { operation: "credential", connectionId: "c", expectedRevision: 2, mode: "persistent", value: "sk-ipc-bound-synthetic" });
  await f.invoke("ai:settings-write", { sender: f.owner }, { operation: "preferences", expectedRevision: 3,
    models: [{ id: "m", revision: 1, connectionId: "c", modelId: "model-x", protocol: "openai-chat-completions", structuredOutput: "json-object", streaming: false, supportedParameters: [], capabilities: { status: "unconfirmed", source: "manual" }, budgets: {}, purposeBudgets: {} }],
    bindings: [{ purpose: "case-suggestion", modelProfileId: "m", budgets: {} }],
  });
}
const selection: AiPrepareInput["selection"] = { source: { kind: "local", project: { workspaceId: IDS.workspace, groupId: IDS.groupTwo, projectId: IDS.projectTwo } }, editGeneration: 1, business: { purpose: "case-suggestion", target: { collectionId: IDS.collectionTwo, folderIds: [], apiId: IDS.sharedApi } } };
it("reads and saves secret-free personal settings with no open project; old endpoints stay closed", async () => {
  const f = setup(); await configured(f);
  const view = await f.invoke("ai:settings-read", { sender: f.owner }) as AiSettingsView;
  expect(view).toMatchObject({ revision: 4, scope: "desktop-device-personal", connections: [{ id: "c", credentialState: "available" }] });
  expect(JSON.stringify(view)).not.toMatch(/credentialRef|sk-ipc-bound-synthetic|ai-desktop-secret/);
  expect(f.calls).toHaveLength(0);
  expect(await f.invoke("ai:get-config", { sender: f.owner })).toEqual({ hasKey: false });
  for (const channel of ["ai:save-config", "ai:test-config"]) await expect(f.invoke(channel, { sender: f.owner }, { baseUrl: "https://evil.example", model: "x" })).rejects.toThrow(/旧/);
});
it("uses the complete project locator, real bound request, and native validated case results through public IPC", async () => {
  const f = setup(); await configured(f); const root = directory(); await persistWorkspace(root, makeWorkspace()); await f.deps.handle("ws:open", {}, root);
  const prepared = await f.invoke("ai:prepare-assistance", { sender: f.owner }, { selection, bodySelection: [] }) as { previewId: string };
  expect(f.calls).toHaveLength(0);
  const output = await f.invoke("ai:start", { sender: f.owner }, { previewId: prepared.previewId, operationId: randomUUID(), selection }) as AiBusinessResultDto;
  if (output.purpose !== "case-suggestion") throw new Error("wrong purpose");
  expect(output.cases.map(value => TestCaseSchema.parse(value))).toHaveLength(2);
  expect(new Set(output.cases.map(c => c.id)).size).toBe(2);
  expect(f.calls[0]!.url).toBe("https://bound.example/v1/chat/completions");
  expect(new Headers(f.calls[0]!.init.headers).get("authorization")).toBe("Bearer sk-ipc-bound-synthetic");
  const payload = JSON.parse(String(f.calls[0]!.init.body)); expect(payload.model).toBe("model-x"); expect(payload.response_format).toEqual({ type: "json_object" });
  expect(JSON.stringify(payload.messages)).toContain("project two API"); expect(JSON.stringify(payload.messages)).not.toContain("project one API");
  await expect(f.invoke("ai:start", { sender: f.owner }, { previewId: prepared.previewId, operationId: randomUUID(), selection })).rejects.toThrow();
});
it("validates new inputs before writes and preserves real provider HTTP and repair failures", async () => {
  const malformed = setup();
  await expect(malformed.invoke("ai:settings-write", { sender: malformed.owner }, { operation: "connection", expectedRevision: 1, connection: { credentialRef: "renderer-ref" } })).rejects.toThrow(/ai:settings-write/);
  for (const options of [{ status: 500, invalid: false, expectedCalls: 1 }, { status: 200, invalid: true, expectedCalls: 2 }]) {
    const f = setup(options.status, options.invalid); await configured(f); const root = directory(); await persistWorkspace(root, makeWorkspace()); await f.deps.handle("ws:open", {}, root);
    const prepared = await f.invoke("ai:prepare-assistance", { sender: f.owner }, { selection, bodySelection: [] }) as { previewId: string };
    await expect(f.invoke("ai:start", { sender: f.owner }, { previewId: prepared.previewId, operationId: randomUUID(), selection })).rejects.toThrow(options.status === 500 ? /http/ : /business-output-invalid/);
    expect(f.calls).toHaveLength(options.expectedCalls);
  }
});
it("does not start a probe after its real sender closes during asynchronous settings capture", async () => {
  const f = setup(); await configured(f);
  const pending = f.invoke("ai:connection-test", { sender: f.owner }, { modelProfileId: "m", operationId: randomUUID() }).catch(error => error);
  f.owner.emit("destroyed");
  const outcome = await pending;
  expect(f.calls).toHaveLength(0); expect(outcome).toBeInstanceOf(Error);
});
it("registers only the owner's actual latest collection, suite and native workflow return, matched by displayed-result digest", async () => {
  const f = setup(); await configured(f);
  const document = await f.personal.repository.read(); document.bindings.push({ purpose: "report-analysis", modelProfileId: "m", budgets: {} }); await f.personal.repository.write(document, document.revision);
  const root = directory(), workspace = makeWorkspace(), project = workspace.groups[0]!.projects[0]!;
  project.collections[0]!.apis = []; project.collections[0]!.folders = [];
  const workflowId = "00000000-0000-4000-8000-000000009001", suiteId = "00000000-0000-4000-8000-000000009002";
  project.workflows = [{ id: workflowId, name: "no external execution", status: "enabled", nodes: [{ id: "noop", kind: "noop" }], edges: [] }];
  project.suites = [{ formatVersion: 1, id: suiteId, name: "noop workflow selection", tags: [], selection: { kind: "explicit", entries: [{ id: "00000000-0000-4000-8000-000000009003", kind: "workflow", workflowId }] }, failFast: false, reporters: ["json"] }];
  await persistWorkspace(root, workspace); await f.deps.handle("ws:open", {}, root);
  const source = { kind: "local" as const, project: { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne } };
  const prepareReport = (digest: string, owner = f.owner) => f.invoke("ai:prepare-assistance", { sender: owner }, { selection: { source, editGeneration: 1, business: { purpose: "report-analysis", report: { kind: "current", expectedReportDigest: digest } } }, bodySelection: [] }) as Promise<{ previewId: string; preview: import("../../../src/shared/ai/contract.js").AiContextPreviewDto }>;
  const collection = await f.invoke("run:collection", { sender: f.owner }, { locator: { ...source.project, collectionId: IDS.collectionOne } });
  const digestA = await aiReportDigest(collection), previewA = await prepareReport(digestA);
  expect(previewA.preview.source.report?.reportId).toMatch(/^[0-9a-f-]{36}$/);
  expect(previewA.preview.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "logical-summary", value: expect.objectContaining({ total: 0 }) })]));
  await expect(prepareReport(digestA, new EventEmitter())).rejects.toThrow();
  const suite = await f.invoke("testing:suite:run", { sender: f.owner }, { invocationId: randomUUID(), context: { root, revision: f.session.revision, project: source.project }, locator: { ...source.project, suiteId } });
  const digestB = await aiReportDigest(suite); expect(digestB).not.toBe(digestA);
  await expect(f.invoke("ai:start", { sender: f.owner }, { previewId: previewA.previewId, operationId: randomUUID(), selection: { source, editGeneration: 1, business: { purpose: "report-analysis", report: { kind: "current", expectedReportDigest: digestA } } } })).rejects.toThrow(/current-report-changed/);
  await expect(prepareReport(digestA)).rejects.toThrow();
  const previewB = await prepareReport(digestB); expect(previewB.preview.source.report?.reportId).not.toBe(previewA.preview.source.report?.reportId);
  const workflow = await f.invoke("wf:run", { sender: f.owner }, { locator: { ...source.project, workflowId }, invocationId: randomUUID(), root });
  expect(workflow).toMatchObject({ verdict: "passed", report: undefined });
  const previewC = await prepareReport(await aiReportDigest(workflow));
  expect(previewC.preview.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "request-summary", state: "legacy", value: null })]));
  expect(f.calls).toHaveLength(0);
  await expect(f.invoke("ai:prepare-assistance", { sender: f.owner }, { selection: { source, editGeneration: 1, business: { purpose: "report-analysis", report: { kind: "run", file: "old.json" } } }, bodySelection: [] })).rejects.toThrow(/归属|unattributable/);
});

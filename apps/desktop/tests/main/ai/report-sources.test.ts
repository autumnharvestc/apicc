import { afterEach, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, realpathSync, symlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createDebugHistoryStore, createDebugHistoryOwnerKey, createProjectSnapshot, prepareDebugExecution, failedDebugResult, prepareAiContext, encodeContractProjectFiles, createEvidenceBudget, type RunResult, type ApiRequest } from "@apicc/core";
import { createSession } from "../../../src/main/session.js";
import { createDesktopAiSources } from "../../../src/main/ai/sources.js";
import { writeStressRunScope } from "../../../src/main/runs.js";
import { aiReportDigest } from "../../../src/shared/ai/reportDigest.js";
import { createOnlineSession } from "../../../src/main/online/session.js";
import { createOnlineClient } from "../../../src/main/online/client.js";
import { createOnlineExecutionHost } from "../../../src/main/online/execution.js";
import { IDS, makeWorkspace, persistWorkspace } from "../helpers/contract-assets.js";
import { stressV2Report } from "../../helpers/stressV2.js";
import type { AiPrepareInput, AiReportRef } from "../../../src/shared/ai/contract.js";
const dirs: string[] = [];
function directory() { const root = mkdtempSync(join(tmpdir(), "apicc-t9-reports-")); dirs.push(root); return root; }
afterEach(() => { for (const root of dirs.splice(0)) rmSync(root, { recursive: true, force: true }); });
const project = { workspaceId: IDS.workspace, groupId: IDS.groupOne, projectId: IDS.projectOne };
const locator = { ...project, collectionId: IDS.collectionOne, folderIds: [], apiId: IDS.sharedApi };
const signal = () => new AbortController().signal;
const input = (report: AiReportRef, baseline?: AiReportRef): AiPrepareInput => ({ selection: { source: { kind: "local", project }, editGeneration: 1, business: { purpose: "report-analysis", report, baseline } }, bodySelection: [] });
async function local() { const root = directory(), session = createSession(); await persistWorkspace(root, makeWorkspace()); await session.open(root); return { root, session }; }
function view(c: Awaited<ReturnType<ReturnType<typeof createDesktopAiSources>["capture"]>>) { return prepareAiContext({ ...c.business, snapshot: c.snapshot, context: c.snapshot.context, source: c.source, bodySelection: [] }); }
it("native debug uses the real owned history partition, preserves host failure facts and refuses foreign or changed records", async () => {
  const f = await local(), history = createDebugHistoryStore({ root: directory() }), snapshot = createProjectSnapshot(f.session.locateProject(project)!.project);
  const owner = { sourceKind: "asset" as const, mode: "request" as const, locator };
  const plan = prepareDebugExecution(snapshot, { mode: "request", locator, request: structuredClone(snapshot.project.collections[0]!.apis[0]!.contract.request) as ApiRequest, parameters: {}, fields: [] });
  const native = { ...failedDebugResult(plan, "host-failure", "2026-10-31T00:00:00Z", new Error("transport unavailable"), { failureKind: "config", projectionReliable: true }), warnings: ["native warning"] };
  const record = (await history.append(native, { ownerKey: createDebugHistoryOwnerKey(realpathSync(f.root), owner) }))!;
  const sources = createDesktopAiSources({ session: f.session, readDebugHistory: history.getOwned });
  const ref = { kind: "debug" as const, historyId: record.historyId, owner };
  const captured = await sources.capture(input(ref), signal());
  expect(view(captured).evidence).toEqual(expect.arrayContaining([expect.objectContaining({ value: expect.objectContaining({ failureKind: "config", error: expect.stringContaining("transport unavailable") }) }), expect.objectContaining({ value: ["native warning"] })]));
  await expect(sources.capture(input({ ...ref, owner: { ...owner, locator: { ...locator, groupId: IDS.groupTwo } } }), signal())).rejects.toThrow();
  await history.delete(record.historyId); await expect(captured.assertCurrent(signal())).rejects.toThrow();
});
it("native stress requires full scope and real contained report plus sidecar, and detects changed bytes", async () => {
  const f = await local(), runs = join(f.root, ".apicc", "runs"); mkdirSync(runs, { recursive: true });
  const report = { ...stressV2Report(), projectId: project.projectId }; const file = "stress-candidate.json";
  writeFileSync(join(runs, file), JSON.stringify(report)); writeStressRunScope(f.root, file, project);
  const sources = createDesktopAiSources({ session: f.session }), captured = await sources.capture(input({ kind: "stress", file }), signal());
  expect(view(captured).source.report?.formatVersion).toBe(2);
  await expect(sources.capture({ ...input({ kind: "stress", file }), selection: { ...input({ kind: "stress", file }).selection, source: { kind: "local", project: { workspaceId: IDS.workspace, groupId: IDS.groupTwo, projectId: IDS.projectTwo } } } }, signal())).rejects.toThrow();
  writeFileSync(join(runs, file), JSON.stringify({ ...report, runId: "10000000-0000-4000-8000-000000000002" })); writeStressRunScope(f.root, file, project);
  await expect(captured.assertCurrent(signal())).rejects.toThrow();
  const outside = directory(); renameSync(runs, join(outside, "moved")); symlinkSync(join(outside, "moved"), runs, "junction");
  await expect(sources.capture(input({ kind: "stress", file }), signal())).rejects.toThrow();
});
it("stress comparison loads both owned reports and retains their separate opaque identities", async () => {
  const f = await local(), runs = join(f.root, ".apicc", "runs"); mkdirSync(runs, { recursive: true });
  for (const [index, file] of ["stress-base.json", "stress-next.json"].entries()) { writeFileSync(join(runs, file), JSON.stringify({ ...stressV2Report(), projectId: project.projectId, runId: `10000000-0000-4000-8000-00000000000${index + 1}` })); writeStressRunScope(f.root, file, project); }
  const sources = createDesktopAiSources({ session: f.session }), captured = await sources.capture(input({ kind: "stress", file: "stress-next.json" }, { kind: "stress", file: "stress-base.json" }), signal());
  expect(view(captured).source.comparison).toMatchObject({ baseline: { reportId: expect.any(String) }, candidate: { reportId: expect.any(String) } });
  expect(captured.business.purpose === "report-analysis" && captured.business.comparison?.baselineReportId).not.toBe(captured.business.purpose === "report-analysis" && captured.business.reportId);
  writeFileSync(join(runs, "stress-base.json.scope"), "{}"); await expect(captured.assertCurrent(signal())).rejects.toThrow();
});
it.each(["report", "scope"] as const)("bounds actual native stress %s reads with the existing Core report byte budget", async kind => {
  const f = await local(), runs = join(f.root, ".apicc", "runs"); mkdirSync(runs, { recursive: true });
  const file = "stress-large.json", path = join(runs, file); writeFileSync(path, JSON.stringify({ ...stressV2Report(), projectId: project.projectId }));
  if (kind === "report") appendFileSync(path, " ".repeat(createEvidenceBudget().reportBytes));
  writeStressRunScope(f.root, file, project);
  if (kind === "scope") appendFileSync(`${path}.scope`, " ".repeat(createEvidenceBudget().reportBytes));
  const sources = createDesktopAiSources({ session: f.session }); await expect(sources.capture(input({ kind: "stress", file }), signal())).rejects.toThrow(/归属|capacity|limit/);
});
it("observation consumes only the selected owner's native case evidence and rejects a different case or non-run report", async () => {
  const f = await local(), sources = createDesktopAiSources({ session: f.session }), owner = {};
  const target = { ...locator, caseId: IDS.sharedCase, scope: "blue" }, snapshot = createProjectSnapshot(f.session.locateProject(project)!.project);
  const run: RunResult = { collectionId: IDS.collectionOne, collectionName: "observed", projectId: project.projectId, definitionRevision: snapshot.definitionRevision, startedAt: "2026-10-31T00:00:00Z", finishedAt: "2026-10-31T00:00:01Z", total: 1, passed: 0, failed: 1, cases: [{ apiId: target.apiId, apiName: "api", caseId: target.caseId, caseName: "blue", locator: target, passed: false, durationMs: 2, assertions: [], evidence: { identity: { projectId: project.projectId, definitionRevision: snapshot.definitionRevision, locator: target }, state: "collected", scriptDiagnostics: "not-collected", truncated: false, response: { status: 503, headers: { text: "", truncated: false }, body: { text: "private unselected body", truncated: false } } } }] };
  await sources.rememberReport(owner, f.session.captureDraftWriteContext(), project, run, run);
  const ref = { kind: "current" as const, expectedReportDigest: await aiReportDigest(run) };
  const request: AiPrepareInput = { selection: { source: { kind: "local", project }, editGeneration: 1, business: { purpose: "assertion-suggestion", target, basis: { kind: "observation", report: ref, caseIndex: 0 } } }, bodySelection: [] };
  const captured = await sources.capture(request, signal(), owner); expect(view(captured).source.observation?.caseIndex).toBe(0); expect(JSON.stringify(view(captured))).not.toContain("private unselected body");
  await expect(sources.capture(request, signal(), {})).rejects.toThrow();
  const wrong = structuredClone(request); if (wrong.selection.business.purpose === "assertion-suggestion") wrong.selection.business.target.scope = "green";
  await expect(Promise.resolve().then(async () => view(await sources.capture(wrong, signal(), owner)))).rejects.toThrow(/evidence-target/);
  const runs = join(f.root, ".apicc", "runs"); mkdirSync(runs, { recursive: true }); writeFileSync(join(runs, "stress.json"), JSON.stringify({ ...stressV2Report(), projectId: project.projectId })); writeStressRunScope(f.root, "stress.json", project);
  const nonRun = structuredClone(request); if (nonRun.selection.business.purpose === "assertion-suggestion" && nonRun.selection.business.basis.kind === "observation") nonRun.selection.business.basis.report = { kind: "stress", file: "stress.json" };
  await expect(sources.capture(nonRun, signal(), owner)).rejects.toThrow(/observation-unavailable/);
  sources.clearOwner(owner); await sources.rememberReport(owner, f.session.captureDraftWriteContext(), project, run, run); await expect(sources.capture(request, signal(), owner)).rejects.toThrow();
});
it("online native report uses the same authorized member handle, checks scope/execution, cancels report reads and rejects account changes", async () => {
  const assetProject = makeWorkspace().groups[0]!.projects[0]!, context = { serverId: "https://control.test/api/v1", ownerId: "7", scope: { workspaceId: "11", groupId: "22", projectId: "33" } };
  const files = [...encodeContractProjectFiles(assetProject).files].map(([path, content]) => ({ path, content, version: "1", hash: createHash("sha256").update(content).digest("hex"), size: Buffer.byteLength(content) }));
  const run = { collectionId: IDS.collectionOne, collectionName: "online", projectId: project.projectId, startedAt: "2026-10-31T00:00:00Z", finishedAt: "2026-10-31T00:00:01Z", total: 0, passed: 0, failed: 0, cases: [] };
  let executionId = "100", badScope = false, block = false, noOutput = false, entered!: () => void, release!: () => void, reportSignal: AbortSignal | undefined;
  const waiting = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
  const transport: typeof fetch = async (url, init) => {
    const path = String(url);
    if (path.endsWith("/auth/login")) return Response.json({ token: "member-token", expiresAt: "2027-01-01T00:00:00Z", user: { id: "7", username: "member", displayName: "Member", role: "USER", disabled: false } });
    if (path.endsWith("/auth/logout")) return Response.json({ ok: true });
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer member-token");
    if (path.endsWith("/assets")) return Response.json({ ...context.scope, format: "contract-files-v1", contractProjectId: assetProject.id, version: "1", manifestHash: "a".repeat(64), files });
    if (path.endsWith("/jobs/99")) return Response.json({ jobId: "99", executionId: "100", agentId: "5", state: "ended", cancelState: "none", executionReleased: true, reportState: "archived", task: { protocolVersion: 1, jobId: "99", executionId: "100", scope: { ...context.scope, ...(badScope ? { groupId: "999" } : {}) }, submittedByUserId: "7", contractProjectId: assetProject.id, snapshotId: "66", manifestHash: "a".repeat(64), target: { kind: "suite", suiteId: "00000000-0000-4000-8000-000000009002", allowDraft: false }, policyVersion: "0", requiredCoreBuildId: "b".repeat(64), scriptPlanDigest: "c".repeat(64), executionProfile: "no-script", runtimeCompatibilityId: "recorded-runtime", dispatchKind: "dedicated-task", requiredCapabilities: ["task:suite"] } });
    expect(path).toBe("https://control.test/api/v1/jobs/99/report");
    if (block) { reportSignal = init?.signal ?? undefined; entered(); await gate; }
    return Response.json({ executionId, verdict: "passed", ...(noOutput ? {} : { output: { kind: "suite", result: run } }) });
  };
  const online = createOnlineSession({ createClient: (baseUrl, hooks) => createOnlineClient({ baseUrl, fetch: transport, onUnauthorized: hooks.onUnauthorized }), tokenStore: { save() {}, load() { return null; }, clear() {} } });
  await online.login({ baseUrl: "https://control.test", username: "member", password: "synthetic" }); online.openWorkspace({ workspaceId: "11", name: "Workspace", myRole: "EDITOR" });
  const host = createOnlineExecutionHost({ session: online, fetch: transport }), sources = createDesktopAiSources({ session: createSession(), online, onlineExecution: host });
  const request: AiPrepareInput = { selection: { source: { kind: "online", context }, editGeneration: 1, business: { purpose: "report-analysis", report: { kind: "online", runId: "99", location: { kind: "agent", agentId: "5" } } } }, bodySelection: [] };
  try {
    const captured = await sources.capture(request, signal()); expect(view(captured).source.report?.summary).toMatchObject({ total: 0 });
    executionId = "101"; await expect(captured.assertCurrent(signal())).rejects.toThrow(); executionId = "100";
    badScope = true; await expect(sources.capture(request, signal())).rejects.toThrow(); badScope = false;
    noOutput = true; await expect(sources.capture(request, signal())).rejects.toThrow(); noOutput = false;
    const abort = new AbortController(); block = true; const pending = sources.capture(request, abort.signal).catch(e => e); await waiting; abort.abort(); const aborted = reportSignal?.aborted; release(); expect(await pending).toBeInstanceOf(Error); expect(aborted).toBe(true);
    online.logout(); await expect(captured.assertCurrent(signal())).rejects.toThrow();
  } finally { release?.(); await host.close(); }
});

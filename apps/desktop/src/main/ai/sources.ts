import { createProjectSnapshot, aiPersonalProjectKey, findProjectApi, getSourceApiRevision, createDebugHistoryOwnerKey, compareStressReports, createEvidenceBudget, type AiBusinessRequest, type AiReadableReport, type AiSourceBinding, type ProjectSnapshot, type RunResult, type DebugHistoryReadResult } from "@apicc/core";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync, lstatSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readScopedStressRun } from "../runs.js";
import { aiReportDigest } from "../../shared/ai/reportDigest.js";
import type { AiPrepareInput, AiReportRef, AiSourceRef } from "../../shared/ai/contract.js";
import type { ProjectLocator } from "../../shared/locations.js";
import type { createSession, DraftWriteContext } from "../session.js";
import type { OnlineSession } from "../online/session.js";
import type { createOnlineExecutionHost } from "../online/execution.js";
import type { OnlineProjectView, OnlineLocalResult, OnlineReport } from "../../shared/online/execution.js";

export interface CapturedAiSource {
  snapshot: ProjectSnapshot; source: AiSourceBinding; projectKey: string; business: AiBusinessRequest;
  currentDraft?: { locator: import("@apicc/core").AiApiLocator; contract: import("@apicc/core").ApiContract; documentation?: string; editRevision: number };
  assertCurrent(signal: AbortSignal): Promise<void>;
}
export interface DesktopAiSourceOptions {
  session: ReturnType<typeof createSession>; online?: OnlineSession;
  onlineExecution?: ReturnType<typeof createOnlineExecutionHost>;
  readDebugHistory?: (historyId: string, ownerKey: string) => Promise<DebugHistoryReadResult>;
}
type CurrentReport = { context: DraftWriteContext; project: ProjectLocator; report: RunResult; digest: string; id: string };
type ReportCapture = { reportId: string; report: AiReadableReport; assertCurrent(signal: AbortSignal): Promise<void> };
export function createDesktopAiSources(options: DesktopAiSourceOptions) {
  const reports = new WeakMap<object, CurrentReport>(), pending = new WeakMap<object, object>(), closed = new WeakSet<object>();
  async function rememberReport(owner: object | undefined, context: DraftWriteContext, project: ProjectLocator, report: RunResult, publicValue: unknown): Promise<void> {
    if (!owner || closed.has(owner)) return;
    const marker = {}; pending.set(owner, marker); reports.delete(owner);
    try {
      options.session.assertDraftWriteContext(context);
      const digest = await aiReportDigest(publicValue);
      options.session.assertDraftWriteContext(context);
      if (closed.has(owner) || pending.get(owner) !== marker) return;
      reports.set(owner, { context: { ...context }, project: structuredClone(project), report: structuredClone(report), digest, id: randomUUID() });
    } catch { /* AI registration never changes completed execution or its verdict. */ }
  }
  function clearOwner(owner: object) { closed.add(owner); reports.delete(owner); pending.delete(owner); }
  async function loadReport(ref: AiReportRef, sourceRef: AiSourceRef, snapshot: ProjectSnapshot, signal: AbortSignal, owner?: object): Promise<ReportCapture> {
    signal.throwIfAborted();
    if (sourceRef.kind === "local" && ref.kind === "current") {
      const record = owner ? reports.get(owner) : undefined;
      if (!record || record.digest !== ref.expectedReportDigest || !isDeepStrictEqual(record.project, sourceRef.project)) throw new Error("ai-current-report-unavailable");
      const check = async (s: AbortSignal) => {
        s.throwIfAborted(); const current = options.session.captureDraftWriteContext();
        if (!owner || closed.has(owner) || reports.get(owner) !== record || current.root !== record.context.root || current.generation !== record.context.generation) throw new Error("ai-current-report-changed");
      };
      await check(signal); return { reportId: record.id, report: structuredClone(record.report), assertCurrent: check };
    }
    if (ref.kind === "run") throw new Error("ai-report-unattributable：旧报告没有完整归属证明，请选择本窗口刚完成的结果");
    const read = async (s: AbortSignal): Promise<AiReadableReport> => {
      s.throwIfAborted();
      if (sourceRef.kind === "local" && ref.kind === "debug") {
        const identity = ref.owner.sourceKind === "free" ? ref.owner.project : ref.owner.mode === "request" ? ref.owner.locator : ref.owner.case;
        if (identity.workspaceId !== sourceRef.project.workspaceId || identity.groupId !== sourceRef.project.groupId || identity.projectId !== sourceRef.project.projectId || !options.readDebugHistory) throw new Error("ai-debug-report-unowned");
        const result = await options.readDebugHistory(ref.historyId, createDebugHistoryOwnerKey(realpathSync(options.session.captureDraftWriteContext().root), ref.owner));
        s.throwIfAborted(); if (!result.record || result.record.formatVersion !== 2) throw new Error("ai-debug-report-unavailable");
        return result.record.result;
      }
      if (sourceRef.kind === "local" && ref.kind === "stress") {
        const root = realpathSync(options.session.captureDraftWriteContext().root), runs = join(root, ".apicc", "runs"), file = join(runs, ref.file);
        // A valid sidecar alone does not authorize following a symlink outside the workspace.
        for (const path of [file, `${file}.scope`]) {
          const child = relative(runs, path);
          if (!child || child.startsWith("..") || isAbsolute(child) || dirname(realpathSync(path)) !== runs || lstatSync(path).isSymbolicLink()) throw new Error("ai-report-path-unavailable");
        }
        return readScopedStressRun(root, sourceRef.project, ref.file, { maxBytes: createEvidenceBudget().reportBytes });
      }
      if (sourceRef.kind === "online" && ref.kind === "online" && options.online && options.onlineExecution) {
        const binding = options.online.captureExecution(sourceRef.context);
        const value = await options.onlineExecution.handle({ operation: "report", context: sourceRef.context, runId: ref.runId, location: ref.location }, { signal: s }) as OnlineLocalResult | OnlineReport;
        s.throwIfAborted(); binding.assertCurrent();
        const output = value.output;
        if (!output || output.kind === "stress-failure") throw new Error("ai-online-report-unavailable");
        if (output.kind === "workflow") { if (!output.result.report) throw new Error("ai-online-report-unavailable"); return output.result.report; }
        return output.result;
      }
      throw new Error("ai-report-source-mismatch");
    };
    const report = await read(signal), digest = await aiReportDigest(report), reportId = randomUUID();
    return { reportId, report: structuredClone(report), async assertCurrent(s) { if (await aiReportDigest(await read(s)) !== digest) throw new Error("ai-report-changed"); s.throwIfAborted(); } };
  }
  return { rememberReport, clearOwner, async capture(input: AiPrepareInput, signal: AbortSignal, owner?: object): Promise<CapturedAiSource> {
    signal.throwIfAborted();
    const selection = structuredClone(input.selection), sourceRef = selection.source;
    let snapshot: ProjectSnapshot, source: AiSourceBinding, projectKey: string, checkSource: (s: AbortSignal) => Promise<void>;
    let onlineDraftRevision: string | undefined;
    if (sourceRef.kind === "online") {
      if (!options.online || !options.onlineExecution) throw new Error("online-ai-source-unavailable");
      const binding = options.online.captureExecution(sourceRef.context), context = sourceRef.context;
      const view = await options.onlineExecution.handle({ operation: "assets", context }, { signal }) as OnlineProjectView;
      signal.throwIfAborted(); binding.assertCurrent(); if (!view.project) throw new Error("online-ai-project-unreadable");
      snapshot = createProjectSnapshot(view.project);
      onlineDraftRevision = view.assets.manifestHash;
      source = { kind: "online", bindingId: randomUUID(), projectId: snapshot.project.id, definitionRevision: snapshot.definitionRevision, editRevision: 0,
        serverIdentity: createHash("sha256").update(binding.serverId).digest("hex"), memberIdentity: createHash("sha256").update(`${binding.serverId}\n${binding.userId}`).digest("hex"),
        workspaceId: context.scope.workspaceId, groupId: context.scope.groupId, serverProjectId: context.scope.projectId, projectVersion: view.assets.version };
      projectKey = aiPersonalProjectKey({ kind: "online", serverUrl: binding.serverId, memberId: binding.userId, ...context.scope });
      checkSource = async s => {
        s.throwIfAborted(); binding.assertCurrent();
        const current = await options.onlineExecution!.handle({ operation: "assets", context }, { signal: s }) as OnlineProjectView;
        s.throwIfAborted(); binding.assertCurrent();
        if (!current.project || current.assets.version !== view.assets.version || createProjectSnapshot(current.project).definitionRevision !== snapshot.definitionRevision) throw new Error("ai-source-changed");
      };
    } else {
      const context = options.session.captureDraftWriteContext(), root = realpathSync(context.root), project = options.session.locateProject(sourceRef.project)?.project;
      if (!project) throw new Error("ai-project-unavailable"); snapshot = createProjectSnapshot(project);
      source = { kind: "local", bindingId: randomUUID(), projectId: snapshot.project.id, definitionRevision: snapshot.definitionRevision, editRevision: context.generation,
        rootIdentity: createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root).digest("hex") };
      projectKey = aiPersonalProjectKey({ kind: "local", root, ...sourceRef.project });
      checkSource = async s => { s.throwIfAborted(); const now = options.session.captureDraftWriteContext();
        if (now.root !== context.root || now.revision !== context.revision || now.generation !== context.generation || !options.session.locateProject(sourceRef.project)) throw new Error("ai-source-changed"); };
    }
    const selectedBusiness = selection.business, reportChecks: ReportCapture[] = [];
    let business: AiBusinessRequest;
    if (selectedBusiness.purpose === "report-analysis") {
      const report = await loadReport(selectedBusiness.report, sourceRef, snapshot, signal, owner); reportChecks.push(report);
      let comparison: Extract<AiBusinessRequest, { purpose: "report-analysis" }>["comparison"];
      if (selectedBusiness.baseline) {
        const baseline = await loadReport(selectedBusiness.baseline, sourceRef, snapshot, signal, owner); reportChecks.push(baseline);
        if (!("totalRequests" in report.report) || !("totalRequests" in baseline.report)) throw new Error("ai-comparison-unavailable");
        comparison = { baselineReportId: baseline.reportId, baseline: baseline.report, judgment: compareStressReports(baseline.report, report.report) };
      }
      business = { purpose: "report-analysis", reportId: report.reportId, report: report.report, comparison, evidenceSelection: input.evidenceSelection, instruction: input.instruction };
    } else if (selectedBusiness.purpose === "assertion-suggestion" && selectedBusiness.basis.kind === "observation") {
      const report = await loadReport(selectedBusiness.basis.report, sourceRef, snapshot, signal, owner); reportChecks.push(report);
      if (!("cases" in report.report)) throw new Error("ai-observation-unavailable");
      business = { purpose: "assertion-suggestion", target: selectedBusiness.target, basis: { kind: "observation", reportId: report.reportId, report: report.report, caseIndex: selectedBusiness.basis.caseIndex }, instruction: input.instruction, limit: input.limit };
    } else business = selectedBusiness.purpose === "case-suggestion" ? { ...selectedBusiness, instruction: input.instruction, limit: input.limit } : { purpose: selectedBusiness.purpose, target: selectedBusiness.target, basis: { kind: "contract" }, instruction: input.instruction, limit: input.limit };
    let currentDraft: CapturedAiSource["currentDraft"];
    if (business.purpose !== "report-analysis") {
      const selected = findProjectApi(snapshot.project, business.target.apiId);
      if (!selected || selected.collection.id !== business.target.collectionId || !isDeepStrictEqual(selected.folders.map(f => f.id), business.target.folderIds)) throw new Error("ai-target-unavailable");
      if (input.currentDraft) {
        const draftRevision = source.kind === "online" ? onlineDraftRevision : getSourceApiRevision(structuredClone(selected.api) as import("@apicc/core").ApiAsset);
        if (input.currentDraft.contract.id !== business.target.apiId || input.currentDraft.sourceApiRevision !== draftRevision) throw new Error("ai-draft-source-changed");
        currentDraft = { locator: business.target, contract: structuredClone(input.currentDraft.contract), documentation: input.currentDraft.documentation, editRevision: source.editRevision };
      }
    } else if (input.currentDraft) throw new Error("ai-report-does-not-overlay-draft");
    return { snapshot, source, projectKey, business, currentDraft, async assertCurrent(s) { await checkSource(s); for (const report of reportChecks) await report.assertCurrent(s); } };
  } };
}
export type DesktopAiSources = ReturnType<typeof createDesktopAiSources>;

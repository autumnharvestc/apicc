import { reactive, shallowReactive, ref } from "vue";
import { ClientConfigSchema, ProjectExecutionAgentsSchema, StressRunConfigSchema, type ProjectExecutionAgents, type TaskTarget, type AssetDelta } from "@apicc/execution/contract";
import type { ContractProject } from "@apicc/core";
import { findProjectApi } from "@apicc/core/workflow/references";
import type { ApiLocator } from "../../../shared/locations.js";
import { applyProjectSave, projectSaveDependencies, sameProjectSaveValue, type ProjectSaveConflict, type ProjectSaveIntent } from "@apicc/core/collaboration/project-save";
import type { PluginsListResult } from "../../../shared/plugins/contract.js";
import { OnlineProjectViewSchema, OnlineJobSchema, OnlineLocalResultSchema, OnlineReportSchema, OnlineMaterialsMetadataSchema, type OnlineExecutionContext, type ExecutionLocation, type OnlineExecutionPort, type OnlineProjectView, type OnlineJob, type OnlineLocalResult, type OnlineReport } from "../../../shared/online/execution.js";
import type { AttachmentWriteSchema } from "@apicc/execution/contract";
import { z } from "zod";
import { isFullOnlineJob, onlineJobScope } from '../../../shared/online/execution.js';
import { OnlineAssetEditResultSchema, type OnlineAssetEditResult, type OnlineAssetEditWrite, type OnlineAssetSaveRejection } from "../../../shared/online/execution.js";
import { projectChanges, projectSaveDetails, type OnlineProjectChange } from "./onlineProjectUpdates.js";
import { projectDirectoryReceipt } from "./onlineDirectoryReceipt.js";
import type { OnlineDirectoryResult, OnlineDirectoryWrite } from "../../../shared/online/execution.js";
import { defaultExecutionCacheStorage, readExecutionCachePreferences, OnlineExecutionCachePreferencesSchema, ONLINE_EXECUTION_CACHE_SETTINGS_KEY,
  type ExecutionCacheStorage, type OnlineExecutionCachePreferences } from './onlineExecutionCachePreferences.js';
type ResultSelection = { kind: 'local'; runId: string; environmentId?: string } | { kind: 'agent'; runId: string } | { kind: 'agent'; job: OnlineJob };
export type RunRecord = { context: OnlineExecutionContext; runId: string; submittedAt: string; target: {kind: TaskTarget['kind']; debugRequestLocator?: ApiLocator}; targetName?: string; location: ExecutionLocation; locationName?: string; environmentId?: string; environmentName?: string; pending: boolean; result?: OnlineLocalResult; job?: OnlineJob; error: string };
type CachedContext = { context: OnlineExecutionContext; lastUsed: number; payloadBytes?: number; debugKeys: Set<string>;
  pending: Set<string>; uncertain: Set<string>; jobs: Map<string, { jobId: string; executionId: string; agentId: string }>; jobCursor: number };
export interface OnlineExecutionCacheOptions { storage?: ExecutionCacheStorage | null; now?: () => number; preferences?: OnlineExecutionCachePreferences }
export type OnlineAssetSaveFeedback = { status: "saving" | OnlineAssetEditResult["status"]; target: string; conflict?: ProjectSaveConflict;
  reason?: OnlineAssetSaveRejection; disposition?: "written" | "converged" | "recovered";
  details?: { baseline?: unknown; submitted?: unknown; current?: unknown } };
type SaveRecord = { input: OnlineAssetEditWrite; feedback: OnlineAssetSaveFeedback;
  onSaved?: (view: OnlineProjectView) => void; result?: OnlineAssetEditResult };
type DirectoryFiles = OnlineProjectView["assets"]["files"];
type ProjectViewCache = { view: OnlineProjectView; latest: OnlineProjectView; project: ContractProject | null; saved: string; directoryFiles: DirectoryFiles };
export function createOnlineExecutionStore(api: OnlineExecutionPort & { pluginsList?(): Promise<PluginsListResult> }, options: OnlineExecutionCacheOptions = {}) {
  let generation = 0; let timer: ReturnType<typeof setTimeout> | undefined;
  const stressConfirmation = ref('');
  const selections = new Map<string, { location: ExecutionLocation; environmentId?: string; localOnlyRefIds: string[] }>();
  const debugSessions = new Map<string, string>();
  const runs = new Map<string, RunRecord>();
  const histories = new Map<string, RunRecord[]>();
  const contexts = new Map<string, CachedContext>();
  const projectViews = new Map<string, ProjectViewCache>();
  const assetSaves = new Map<string, Map<string, SaveRecord>>();
  let checking: { token: number; promise: Promise<boolean> } | undefined;
  let preview: OnlineProjectView | null = null;
  let memoSnapshot = "";
  let memoProject: ContractProject | null = null;
  const statusPageSize = 20;
  const storage = options.storage === undefined ? defaultExecutionCacheStorage() : options.storage;
  const initial = readExecutionCachePreferences(storage);
  const initialPreferences = options.preferences ? OnlineExecutionCachePreferencesSchema.parse(options.preferences) : initial.preferences;
  const now = options.now ?? (() => performance.now());
  const key = (context: OnlineExecutionContext | null) => context ? JSON.stringify([context.serverId, context.ownerId,
    context.scope.workspaceId, context.scope.groupId, context.scope.projectId]) : "null";
  const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const editableProject = (value: ContractProject | null): ContractProject | null => value ? reactive(plain(value) as object) as ContractProject : null;
  const stressIntent = (plan: import('@apicc/core').StressPlan) => JSON.stringify([store.context, store.view?.assets.version, store.location, plan, store.environmentId, store.stressWorkerCount, store.stressConfirmedOrigins]);
  const current = (token: number, context: OnlineExecutionContext) => generation === token && store.visible && key(context) === key(store.context);
  const sameScope = (view: OnlineProjectView, context: OnlineExecutionContext) => view.assets.workspaceId === context.scope.workspaceId
    && view.assets.groupId === context.scope.groupId && view.assets.projectId === context.scope.projectId;
  function savedProject() {
    if (memoSnapshot !== store.saved) {
      memoSnapshot = store.saved;
      memoProject = store.saved ? JSON.parse(store.saved) as ContractProject | null : null;
    }
    return memoProject;
  }
  function loseProjectAccess() {
    store.projectAccessLost = true;
    store.view = null; store.latestView = null; store.project = null; store.saved = "";
    store.projectedDirectoryFiles = [];
    store.closeUpdatePreview(); store.saveFeedback = null;
  }
  function acceptProjectView(context: OnlineExecutionContext, view: OnlineProjectView, preserveDraft: boolean) {
    if (key(context) !== key(store.context) || !store.visible || !sameScope(view, context)) return false;
    const previous = store.view?.assets.version;
    if (previous !== undefined) {
      const nextVersion = BigInt(view.assets.version);
      const currentVersion = BigInt(previous);
      if (nextVersion < currentVersion) return false;
      if (preserveDraft && nextVersion === currentVersion) return true;
    }
    const dirty = preserveDraft && store.dirty;
    store.view = view;
    store.projectedDirectoryFiles = [];
    store.projectAccessLost = false;
    if (!store.latestView || BigInt(view.assets.version) >= BigInt(store.latestView.assets.version)) store.latestView = view;
    store.directoryDraftConflict = dirty;
    if (!dirty) {
      store.project = editableProject(view.project);
    }
    store.saved = JSON.stringify(view.project);
    return true;
  }
  function observeProject(context: OnlineExecutionContext, view: OnlineProjectView) {
    if (!sameScope(view, context) || key(context) !== key(store.context) || !store.visible) return false;
    if (store.latestView && BigInt(view.assets.version) < BigInt(store.latestView.assets.version)) return true;
    if (store.view?.assets.contractProjectId && store.view.assets.contractProjectId !== view.assets.contractProjectId) {
      loseProjectAccess();
      store.projectReadIssue = "online-project-identity-changed";
      return false;
    }
    if (!view.project && view.assets.format === "contract-files-v1") {
      store.projectReadIssue = "online-project-content-unavailable";
      return false;
    }
    store.latestView = view;
    if (!store.view) return acceptProjectView(context, view, false);
    if (!preview && view.project && !view.problems.length && sameProjectSaveValue(savedProject(), view.project)) {
      store.view = view; store.projectedDirectoryFiles = [];
    }
    return true;
  }
  function saveRecords(context: OnlineExecutionContext) {
    const id = key(context);
    let records = assetSaves.get(id);
    if (!records) { records = new Map(); assetSaves.set(id, records); }
    return records;
  }
  function setFeedback(record: SaveRecord) {
    if (key(record.input.context) === key(store.context)) store.saveFeedback = record.feedback;
  }
  function acceptAssetEdit(record: SaveRecord, result: Extract<OnlineAssetEditResult, { status: "saved" }>): boolean {
    const context = record.input.context;
    const prior = savedProject();
    if (!prior || prior.id !== record.input.contractProjectId || result.view.project?.id !== prior.id || !sameScope(result.view, context)) return false;
    const projected = applyProjectSave(prior, record.input.change, { projection: true });
    if (projected.status === "ready" && projected.changed) {
      if (!store.dirty) store.project = editableProject(projected.project);
      else if (store.project) {
        const withDraft = applyProjectSave(plain(store.project), record.input.change, { projection: true });
        if (withDraft.status === "ready") store.project = editableProject(withDraft.project);
        else store.directoryDraftConflict = true;
      }
      store.saved = JSON.stringify(projected.project);
    }
    observeProject(context, result.view);
    return true;
  }
  function deliverSaves(context: OnlineExecutionContext) {
    const records = assetSaves.get(key(context));
    if (!records || !store.visible || !store.view) return;
    for (const [subject, record] of records) {
      if (record.result?.status === "saved") {
        if (acceptAssetEdit(record, record.result)) {
          records.delete(subject);
          record.onSaved?.(record.result.view);
        } else continue;
      }
      setFeedback(record);
    }
    if (!records.size) assetSaves.delete(key(context));
  }
  async function performAssetEdit(record: SaveRecord, verifyOnly: boolean): Promise<OnlineProjectView | null> {
    const { context } = record.input;
    record.feedback = { status: "saving", target: record.feedback.target };
    retain(context).payloadBytes = undefined;
    setFeedback(record);
    let result: OnlineAssetEditResult;
    try {
      result = OnlineAssetEditResultSchema.parse(await api.onlineExecution({ ...record.input, ...(verifyOnly ? { verifyOnly: true as const } : {}) }));
    } catch (error) {
      result = !verifyOnly && error instanceof Error && error.message.endsWith("online-session-changed")
        ? { status: "rejected", reason: "authorization" } : { status: "unknown" };
    }
    if (verifyOnly && result.status === "rejected") result = { status: "unknown", reason: result.reason };
    if (result.status === "saved" && (!sameScope(result.view, context) || result.view.project?.id !== record.input.contractProjectId
      || result.view.assets.contractProjectId !== record.input.contractProjectId || BigInt(result.view.assets.version) < BigInt(record.input.baseVersion))) {
      result = { status: "unknown" };
    }
    record.result = result;
    const feedback: OnlineAssetSaveFeedback = { status: result.status, target: record.feedback.target };
    if (result.status === "saved") feedback.disposition = result.disposition;
    if (result.status === "rejected" || result.status === "unknown") feedback.reason = result.reason;
    if (result.status === "conflict") {
      feedback.conflict = result.conflict;
      feedback.details = projectSaveDetails(record.input.change, result.conflict, result.view.project);
    }
    record.feedback = feedback;
    retain(context).payloadBytes = undefined;
    if (key(store.context) === key(context) && store.visible) {
      if ("reason" in result && (result.reason === "removed" || result.reason === "scope" || result.reason === "identity")) loseProjectAccess();
      if (result.status !== "saved" && "view" in result && result.view) observeProject(context, result.view);
      deliverSaves(context);
      setFeedback(record);
    }
    prune();
    return result.status === "saved" ? result.view : null;
  }
  const stop = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    stop();
    if (store.visible && store.context && (store.jobs.some(job => job.state !== "ended" || !job.executionReleased || isFullOnlineJob(job) && job.reportState === "pending") || contexts.get(key(store.context))?.jobs.size)) timer = setTimeout(() => { void store.refreshActive(); }, store.statusRefreshMs);
  };
  const store = shallowReactive({
    context: null as OnlineExecutionContext | null, location: { kind: "local" } as ExecutionLocation,
    environmentId: undefined as string | undefined, visible: false, jobs: [] as OnlineJob[], error: "", statusRefreshMs: 2000,
    connection: "unknown" as "unknown" | "connected" | "disconnected", view: null as OnlineProjectView | null,
    latestView: null as OnlineProjectView | null, appliedUpdate: 0,
    projectedDirectoryFiles: [] as DirectoryFiles,
    projectAccessLost: false,
    projectReadIssue: "" as "" | "online-project-content-unavailable" | "online-project-access-lost" | "online-project-identity-changed",
    updatePreview: null as { version: string; changes: OnlineProjectChange[] } | null,
    saveFeedback: null as OnlineAssetSaveFeedback | null,
    agents: null as ProjectExecutionAgents | null, project: null as ContractProject | null, saved: "", directoryDraftConflict: false, busy: false, running: false,
    localResult: null as OnlineLocalResult | null, report: null as OnlineReport | null, selectedJobId: "",
    resultSelection: null as ResultSelection | null, submissions: [] as RunRecord[],
    localPlugins: null as PluginsListResult | null, activeLocalRunId: "",
    cachePreferences: Object.freeze(initialPreferences), cachePreferenceDiagnostic: initial.diagnostic as string | null,
    cacheUsage: { currentContexts: 0, protectedContexts: 0, inactiveContexts: 0, inactivePayloadBytes: 0, overLimit: false },
    stressConfirmedOrigins: [] as string[], stressWorkerCount: 1,
    materialMetadata: null as z.infer<typeof OnlineMaterialsMetadataSchema> | null,
    localOnlyRefIds: [] as string[], materials: { credentials: [] as Array<{ refId: string; version: string }>, attachments: [] as Array<{ refId: string; version: string; hash: string }>, attachmentPaths: {} as Record<string, { refId: string; version: string; hash: string }> },
    get dirty(): boolean { return !!store.project && JSON.stringify(store.project) !== store.saved; },
    get directoryFiles(): DirectoryFiles {
      const projected = new Map(store.view?.assets.files.map(file => [file.path, file]));
      for (const file of store.projectedDirectoryFiles) projected.set(file.path, file);
      return [...projected.values()];
    },
    confirmedProject(): ContractProject | null { return savedProject(); },
    editorProject(fresh: boolean): { view: OnlineProjectView; project: ContractProject } | null {
      if (store.projectAccessLost) return null;
      const latest = store.latestView;
      if (fresh && latest?.project && latest.project.id === store.view?.assets.contractProjectId) return { view: latest, project: latest.project };
      const confirmed = savedProject();
      return store.view && confirmed ? { view: store.view, project: confirmed } : null;
    },
    get hasProjectUpdates(): boolean {
      const latest = store.latestView?.project;
      return !!latest && !!store.view && !sameProjectSaveValue(savedProject(), latest);
    },
    get activeStressLocalRunId(): string { const run = runs.get(key(store.context)); return store.activeLocalRunId && run?.target.kind === 'stress' && run.runId === store.activeLocalRunId ? run.runId : ''; },
    activate(context: OnlineExecutionContext | null) {
      if (key(context) === key(store.context)) return;
      prune();
      if (store.context) {
        if (store.view && store.latestView) projectViews.set(key(store.context), { view: store.view, latest: store.latestView,
          project: store.project, saved: store.saved, directoryFiles: store.projectedDirectoryFiles });
        selections.set(key(store.context), { location: plain(store.location), environmentId: store.environmentId, localOnlyRefIds: [...store.localOnlyRefIds] });
        const previous = retain(store.context); previous.lastUsed = now(); previous.payloadBytes = undefined;
      }
      generation++; stop(); store.context = context ? plain(context) : null; store.jobs = []; store.view = null; store.project = null; store.agents = null; store.saved = ""; store.directoryDraftConflict = false; store.error = ""; store.localResult = null; store.report = null; store.busy = false; store.running = false; store.connection = "unknown"; store.localOnlyRefIds = []; store.materials = { credentials: [], attachments: [], attachmentPaths: {} };
      store.latestView = null; store.projectedDirectoryFiles = []; store.updatePreview = null; store.saveFeedback = null;
      store.projectAccessLost = false; store.projectReadIssue = ""; preview = null;
      const cachedProject = projectViews.get(key(context));
      if (cachedProject) {
        projectViews.delete(key(context));
        store.view = cachedProject.view; store.latestView = cachedProject.latest; store.project = cachedProject.project; store.saved = cachedProject.saved;
        store.projectedDirectoryFiles = cachedProject.directoryFiles;
      }
      stressConfirmation.value = ''; store.stressConfirmedOrigins = []; store.stressWorkerCount = 1;
      store.materialMetadata = null; store.activeLocalRunId = ''; store.selectedJobId = ''; store.resultSelection = null;
      store.submissions = histories.get(key(context)) ?? [];
      if (context) retain(context).lastUsed = now();
      prune();
      const selection = selections.get(key(context)); store.location = selection?.location ?? { kind: "local" }; store.environmentId = selection?.environmentId;
      store.localOnlyRefIds = [...(selection?.localOnlyRefIds ?? [])];
      const run = runs.get(key(context)); if (run) { chooseRun(run); publishRun(run); }
    },
    selectLocation(location: ExecutionLocation) { if (JSON.stringify(location) !== JSON.stringify(store.location)) store.stressConfirmedOrigins = []; store.location = plain(location); },
    invalidateStressConfirmation() { stressConfirmation.value = ''; store.stressConfirmedOrigins = []; },
    confirmStressOrigins(plan: import('@apicc/core').StressPlan, origins: string[]) {
      store.invalidateStressConfirmation();
      const run = StressRunConfigSchema.parse({ workerCount: store.stressWorkerCount, confirmedTargetOrigins: origins });
      if (!run.confirmedTargetOrigins.length) throw new Error('stress-confirmation-required');
      store.stressConfirmedOrigins = [...run.confirmedTargetOrigins]; stressConfirmation.value = stressIntent(plan);
    },
    isStressConfirmed(plan: import('@apicc/core').StressPlan) { return !!stressConfirmation.value && stressConfirmation.value === stressIntent(plan); },
    newDebugSession() { debugSessions.delete(JSON.stringify([store.context, store.location])); },
    openUpdatePreview() {
      const before = savedProject(), latest = store.latestView?.project;
      if (!store.hasProjectUpdates || !before || !latest) return;
      preview = store.latestView;
      store.updatePreview = { version: preview!.assets.version, changes: projectChanges(before, latest) };
    },
    closeUpdatePreview() { preview = null; store.updatePreview = null; },
    applyUpdatePreview() {
      const context = store.context;
      if (!context || !preview?.project || !store.visible || !sameScope(preview, context)) return false;
      // A pinned preview may be older than a subsequent observation, but cannot replace a newer applied version.
      const applied = acceptProjectView(context, preview, true);
      if (applied) store.appliedUpdate++;
      store.closeUpdatePreview();
      return applied;
    },
    async checkForUpdates(): Promise<boolean> {
      const context = store.context && plain(store.context);
      if (!context || !store.visible) return false;
      const token = generation;
      if (checking?.token === token) return checking.promise;
      const promise = (async () => {
        try {
          const view = OnlineProjectViewSchema.parse(await api.onlineExecution({ operation: "assets", context }));
          if (!current(token, context)) return false;
          const accepted = observeProject(context, view);
          if (accepted) store.projectReadIssue = "";
          deliverSaves(context);
          return accepted;
        } catch (error) {
          if (current(token, context)) {
            const message = error instanceof Error ? error.message : String(error);
            if (/(?:^|: )(?:online-project-access-lost|forbidden|unauthorized|online-session-changed|online-project-scope-mismatch)$/.test(message)) {
              loseProjectAccess();
              store.projectReadIssue = "online-project-access-lost";
            } else if (!store.projectAccessLost) {
              store.projectReadIssue = "online-project-content-unavailable";
            }
          }
          return false;
        }
      })().finally(() => { if (checking?.token === token) checking = undefined; });
      checking = { token, promise };
      return promise;
    },
    async saveAssetEdit(change: ProjectSaveIntent, baseline: ContractProject, subject: string, target: string, onSaved?: (view: OnlineProjectView) => void, baseVersion?: string): Promise<OnlineProjectView | null> {
      const context = store.context && plain(store.context);
      if (!context || !store.visible || !store.view?.project || baseline.id !== store.project?.id) throw new Error("online-project-unavailable");
      const records = saveRecords(context);
      const pending = [...records].find(([owner, record]) => {
        if (record.feedback.status !== "saving" && record.feedback.status !== "unknown") return false;
        if (owner === subject) return true;
        const previous = record.input.change;
        if (previous.kind !== "case" || change.kind !== "case" || !sameProjectSaveValue(previous.target, change.target)) return false;
        const ids = new Set([change.submitted.id, ...change.deletes.map(row => row.caseId)]);
        return ids.has(previous.submitted.id) || previous.deletes.some(row => ids.has(row.caseId));
      })?.[1];
      if (pending) {
        setFeedback(pending);
        return null;
      }
      const fixed = plain(change);
      const input: OnlineAssetEditWrite = { context, operation: "saveAssetEdit", intentId: crypto.randomUUID(),
        baseVersion: baseVersion ?? store.view.assets.version, contractProjectId: baseline.id,
        change: fixed.kind === "workflow-create" ? fixed : { ...fixed, dependencies: projectSaveDependencies(baseline, fixed) } };
      const record: SaveRecord = { input, feedback: { status: "saving", target }, onSaved };
      records.set(subject, record);
      return performAssetEdit(record, false);
    },
    async verifyAssetSave() {
      const context = store.context;
      if (!context || !store.visible) return false;
      const record = [...(assetSaves.get(key(context))?.values() ?? [])].find(row => row.feedback === store.saveFeedback && row.feedback.status === "unknown");
      if (!record) return false;
      return performAssetEdit(record, true);
    },
    dismissSaveFeedback() {
      const context = store.context;
      if (!context || store.saveFeedback?.status === "unknown" || store.saveFeedback?.status === "saving") return;
      const records = assetSaves.get(key(context));
      if (records) for (const [subject, record] of records) if (record.feedback === store.saveFeedback) records.delete(subject);
      store.saveFeedback = null;
      retain(context).payloadBytes = undefined;
    },
    async load() {
      const context = store.context && plain(store.context); if (!context || !store.visible) return;
      const token = generation; store.busy = true;
      try {
        if (!await store.checkForUpdates()) return;
        if (!current(token, context)) return;
        const agents = ProjectExecutionAgentsSchema.parse(await api.onlineExecution({ operation: "agents", context }));
        if (!current(token, context)) return;
        store.agents = agents; store.connection = "connected"; store.error = "";
        if (api.pluginsList) { const summary = await api.pluginsList(); if (!current(token, context)) return; store.localPlugins = summary; }
        await store.reloadMaterials();
        await store.refresh();
      } catch (error) { if (current(token, context)) { store.error = String(error instanceof Error ? error.message : error); store.connection = "disconnected"; } }
      finally { if (current(token, context)) store.busy = false; }
    },
    async refresh() {
      const context = store.context && plain(store.context); if (!context || !store.visible) return;
      const token = generation;
      try {
        const jobs = await api.onlineExecution({ operation: "list", context, limit: statusPageSize });
        if (!current(token, context)) return;
        store.jobs = reactive(OnlineJobSchema.array().parse(jobs) as object) as OnlineJob[]; store.connection = "connected";
        for (const job of store.jobs) updateJob(job);
        prune();
      } catch (error) { if (current(token, context)) { store.error = error instanceof Error ? error.message : String(error); store.connection = "disconnected"; } }
      finally { if (current(token, context)) schedule(); }
    },
    async refreshActive() {
      const context = store.context && plain(store.context); if (!context || !store.visible) return;
      const token = generation;
      try {
        const cached = retain(context);
        const known = new Map([...cached.jobs]);
        for (const job of store.jobs.filter(job => job.state !== 'ended' || !job.executionReleased || isFullOnlineJob(job) && job.reportState === 'pending')) known.set(JSON.stringify([job.agentId, job.jobId, job.executionId]), job);
        const pendingJobs = [...known.values()], limit = Math.min(statusPageSize, pendingJobs.length);
        const cursor = cached.jobCursor; let statusError = '';
        for (let offset = 0; offset < limit; offset++) {
          const existing = pendingJobs[(cursor + offset) % pendingJobs.length]!;
          try {
            const raw = await api.onlineExecution({ operation: "status", context, runId: existing.jobId, location: { kind: "agent", agentId: existing.agentId } });
            if (!current(token, context)) return;
            updateJob(OnlineJobSchema.parse(raw));
          } catch (error) {
            if (!current(token, context)) return;
            statusError ||= error instanceof Error ? error.message : String(error);
          } finally {
            if (current(token, context)) cached.jobCursor = (cursor + offset + 1) % pendingJobs.length;
          }
        }
        if (!pendingJobs.length) cached.jobCursor = 0;
        store.connection = statusError ? 'disconnected' : 'connected'; store.error = statusError;
      } catch (error) { if (current(token, context)) { store.error = error instanceof Error ? error.message : String(error); store.connection = "disconnected"; } }
      finally { if (current(token, context)) schedule(); }
    },
    setVisible(visible: boolean) { if (visible === store.visible) return; store.visible = visible; generation++; stop(); if (visible) { const run = runs.get(key(store.context)); if (run) publishRun(run); schedule(); } },
    async reloadMaterials() { const context = store.context && plain(store.context); if (!context || !store.visible) return; const token = generation; const raw = await api.onlineExecution({ context, operation: 'materials' }); if (current(token, context)) store.materialMetadata = OnlineMaterialsMetadataSchema.parse(raw); },
    async uploadAttachment(attachment: z.infer<typeof AttachmentWriteSchema>) { const context = store.context && plain(store.context); if (!context) return; const token = generation; await api.onlineExecution({ context, operation: 'attachmentUpload', attachment }); if (current(token, context)) await store.reloadMaterials(); },
    bindAttachment(path: string, refId: string) {
      const attachment = store.materialMetadata?.attachments.find(item => item.refId === refId); if (!attachment) throw new Error('attachment-unavailable');
      const selected = { refId: attachment.refId, version: attachment.version, hash: attachment.hash };
      store.materials = { ...store.materials, attachments: [...store.materials.attachments.filter(item => item.refId !== refId), selected], attachmentPaths: { ...store.materials.attachmentPaths, [path]: selected } };
    },
    setRefreshMs(value: number) { ClientConfigSchema.shape.statusRefreshMs.max(2147483647).parse(value); store.statusRefreshMs = value; schedule(); },
    setCachePreferences(value: unknown) {
      const parsed = OnlineExecutionCachePreferencesSchema.safeParse(value);
      if (!parsed.success) throw new Error('online-cache-settings-invalid');
      try { if (!storage) throw new Error('Storage unavailable'); storage.setItem(ONLINE_EXECUTION_CACHE_SETTINGS_KEY, JSON.stringify(parsed.data)); }
      catch { store.cachePreferenceDiagnostic = 'online-cache-settings-save-failed'; throw new Error('online-cache-settings-save-failed'); }
      store.cachePreferences = Object.freeze(parsed.data); store.cachePreferenceDiagnostic = null; prune();
    },
    async save(delta: AssetDelta) {
      const context = store.context && plain(store.context); if (!context) return;
      if (store.directoryDraftConflict) throw new Error("online-directory-project-draft-conflict");
      const token = generation; const view = OnlineProjectViewSchema.parse(await api.onlineExecution({ operation: "save", context, delta: plain(delta) }));
      if (!current(token, context)) return;
      acceptProjectView(context, view, false);
    },
    async saveProject(project: ContractProject, mode: "whole-draft" | "api-buffer" = "whole-draft") {
      const context = store.context && plain(store.context); if (!context || !store.view) throw new Error("online-project-unavailable");
      if (mode === "whole-draft" && store.directoryDraftConflict) throw new Error("online-directory-project-draft-conflict");
      const token = generation; const view = OnlineProjectViewSchema.parse(await api.onlineExecution({ operation: "saveProject", context, project: plain(project), expectedVersion: store.view.assets.version }));
      if (!current(token, context)) throw new Error("online-session-changed");
      acceptProjectView(context, view, mode === "api-buffer");
    },
    acceptDirectoryView(context: OnlineExecutionContext, view: OnlineProjectView): boolean {
      return acceptProjectView(context, view, true);
    },
    receiveDirectoryWrite(input: OnlineDirectoryWrite, result: OnlineDirectoryResult): boolean {
      const { context } = input;
      if (!result.view || !store.view || key(store.context) !== key(context) || !sameScope(result.view, context) || !store.visible) return false;
      if (result.status !== "saved") { observeProject(context, result.view); return false; }
      if (!result.recovered && input.expectedVersion === store.view.assets.version
          && BigInt(result.view.assets.version) === BigInt(input.expectedVersion) + 1n) {
        return acceptProjectView(context, result.view, true);
      }
      const projected = projectDirectoryReceipt(savedProject(), input, result);
      if (!projected) { observeProject(context, result.view); return false; }
      if (!store.dirty) store.project = editableProject(projected.project);
      else store.directoryDraftConflict = true;
      store.saved = JSON.stringify(projected.project);
      const files = new Map(store.projectedDirectoryFiles.map(file => [file.path, file]));
      for (const file of projected.files) files.set(file.path, file);
      store.projectedDirectoryFiles = [...files.values()];
      observeProject(context, result.view);
      return true;
    },
    async run(target: TaskTarget) {
      const context = store.context && plain(store.context); if (!context || !store.view || !store.visible) throw new Error("online-project-unavailable");
      if (target.kind === 'stress' && store.location.kind === 'agent') {
        const agentId = store.location.agentId; const agent = store.agents?.agents.find(row => row.id === agentId);
        if (!agent || agent.availability !== 'available' || agent.configuration.status !== 'applied' || !agent.runtime?.capabilities.includes('task:stress') || !agent.runtime.capabilities.includes('stress:local-workers-v1')) throw new Error('stress-agent-unavailable');
      }
      if (target.kind !== "debug" && store.dirty) throw new Error("save-before-running");
      if (target.kind === 'stress' && !store.project?.stressPlans?.some(saved => JSON.stringify(saved.plan) === JSON.stringify(target.plan))) throw new Error('save-before-running');
      if (target.kind === 'stress' && target.plan.environmentId && store.environmentId && target.plan.environmentId !== store.environmentId) throw new Error('stress-environment-mismatch');
      if (target.kind === 'stress' && !store.isStressConfirmed(target.plan)) throw new Error('stress-confirmation-required');
      if (store.location.kind === "agent" && store.localOnlyRefIds.length) throw new Error("local-material-required");
      if (runs.get(key(context))?.pending) throw new Error('online-run-in-progress');
      const stress = target.kind === 'stress' ? StressRunConfigSchema.parse({ workerCount: store.stressWorkerCount, confirmedTargetOrigins: [...store.stressConfirmedOrigins] }) : undefined;
      if (stress) store.invalidateStressConfirmation();
      const runId = crypto.randomUUID(); const location = plain(store.location); const sessionKey = JSON.stringify([context, location]);
      const suite = target.kind === 'suite' ? store.project?.suites?.find(item => item.id === target.suiteId) : undefined;
      const invocation = target.kind === 'debug' ? target.invocation : null;
      const apiAsset = invocation && invocation.mode !== 'free' && store.project ? findProjectApi(store.project, invocation.locator.apiId)?.api : undefined;
      const targetName = invocation?.mode === 'case' ? apiAsset?.cases.find(item => item.id === invocation.case.caseId && item.scope === invocation.case.scope)?.name
        : invocation?.mode === 'request' ? apiAsset?.contract.metadata.name : target.kind === 'workflow' ? store.project?.workflows.find(item => item.id === target.workflowId)?.name
        : target.kind === 'stress' ? store.project?.stressPlans?.find(item => JSON.stringify(item.plan) === JSON.stringify(target.plan))?.name : suite?.name;
      const environmentId = target.kind === 'stress' ? target.plan.environmentId ?? store.environmentId : store.environmentId ?? suite?.environmentId;
      const locationName = location.kind === 'agent' ? store.agents?.agents.find(agent => agent.id === location.agentId)?.name : undefined;
      const environmentName = store.project?.environments.find(env => env.id === environmentId)?.name;
      const run: RunRecord = shallowReactive({ context, runId, submittedAt: new Date().toISOString(), target: { kind: target.kind, ...(invocation?.mode === 'request' ? {debugRequestLocator: plain(invocation.locator)} : {}) }, targetName, location, locationName, environmentId, environmentName, pending: true, error: '' });
      const cached = retain(context); cached.pending.add(runId); cached.payloadBytes = undefined;
      // Bound the desktop results to the same terminal history limit as the execution host.
      const history = [run, ...(histories.get(key(context)) ?? [])].slice(0, 100);
      histories.set(key(context), history); store.submissions = history;
      runs.set(key(context), run); chooseRun(run); store.error = ''; publishRun(run);
      try {
        const raw = await api.onlineExecution({ operation: "run", context, runId, location, target: plain(target), expectedVersion: store.view.assets.version, environmentId: store.environmentId, ...(target.kind === 'debug' && debugSessions.has(sessionKey) ? { debugSessionId: debugSessions.get(sessionKey) } : {}), runConfig: stress ? { stress } : {}, materials: { projectId: context.scope.projectId, ...plain(store.materials) }, localOnlyRefIds: [...store.localOnlyRefIds] });
        if (location.kind === 'local') { const result = OnlineLocalResultSchema.parse(raw); if (result.runId !== runId) throw new Error('fixed-input-mismatch'); run.result = result; if (result.debugSessionId) { debugSessions.set(sessionKey, result.debugSessionId); cached.debugKeys.add(sessionKey); } }
        else { run.job = OnlineJobSchema.parse(raw); observeJob(context, run.job); if (isFullOnlineJob(run.job) && run.job.task.debugSessionId) { debugSessions.set(sessionKey, run.job.task.debugSessionId); cached.debugKeys.add(sessionKey); } }
      } catch (error) { const failure = error instanceof z.ZodError && error.issues.some(issue => issue.path.includes('output')) ? new Error('invalid-core-output') : error; run.error = failure instanceof Error ? failure.message : String(failure);
        if (/version_conflict/.test(run.error) && key(context) === key(store.context)) void store.checkForUpdates();
        throw failure;
      }
      finally { run.pending = false; cached.pending.delete(runId); if (!run.result && !run.job) cached.uncertain.add(runId); cached.payloadBytes = undefined; publishRun(run); prune(); }
    },
    async cancelLocal() { if (!store.context || !store.activeLocalRunId) return; await api.onlineExecution({ operation: 'cancel', context: plain(store.context), location: { kind: 'local' }, runId: store.activeLocalRunId }); },
    async selectSubmission(runId: string) {
      const run = store.submissions.find(item => item.runId === runId);
      if (!run || !store.visible || store.projectAccessLost) throw new Error('run-record-unavailable');
      if (run.job) {
        const expected = run.job, context = plain(run.context), token = generation;
        store.report = null; store.localResult = null; store.selectedJobId = '';
        store.resultSelection = { kind: 'agent', runId };
        const selection = store.resultSelection;
        const raw = await api.onlineExecution({ operation: 'status', context, location: run.location, runId: expected.jobId });
        if (!current(token, context) || selection !== store.resultSelection) return;
        const job = OnlineJobSchema.parse(raw);
        if (job.jobId !== expected.jobId || job.executionId !== expected.executionId || job.agentId !== expected.agentId) throw new Error('fixed-input-mismatch');
        await store.inspect(job); return;
      }
      chooseRun(run); store.localResult = run.result ?? null; store.error = run.error;
    },
    async inspect(job: OnlineJob, intentCurrent: () => boolean = () => true) {
      const context = store.context && plain(store.context); if (!context) return;
      const scope = onlineJobScope(job);
      if (scope.workspaceId !== context.scope.workspaceId || scope.groupId !== context.scope.groupId || scope.projectId !== context.scope.projectId) throw new Error('fixed-input-mismatch');
      store.error = '';
      updateJob(job);
      const token = generation; store.selectedJobId = job.jobId; store.report = null; store.localResult = null;
      store.resultSelection = { kind: 'agent', job: plain(job) };
      if (!isFullOnlineJob(job) || job.reportState !== "archived") return;
      const raw = await api.onlineExecution({ operation: "report", context, runId: job.jobId, location: { kind: "agent", agentId: job.agentId } });
      if (!intentCurrent() || !current(token, context) || store.selectedJobId !== job.jobId) return;
      const parsed = OnlineReportSchema.safeParse(raw);
      if (!parsed.success) throw new Error(parsed.error.issues.some(issue => issue.path.includes('output')) ? 'invalid-core-output' : 'invalid-online-report');
      const report = parsed.data;
      const selected = store.resultSelection;
      if (current(token, context) && selected?.kind === 'agent' && 'job' in selected && isFullOnlineJob(selected.job) && selected.job.reportState === 'archived' && selected.job.jobId === job.jobId && selected.job.executionId === job.executionId) {
        if (report.executionId !== job.executionId) throw new Error('fixed-input-mismatch');
        store.report = report;
      }
    },
    async cancel(job: OnlineJob) {
      const context = store.context && plain(store.context); if (!context) return;
      const token = generation; const raw = await api.onlineExecution({ operation: "cancel", context, runId: job.jobId, location: { kind: "agent", agentId: job.agentId } });
      if (!current(token, context)) return;
      updateJob(OnlineJobSchema.parse(raw)); schedule();
    },
  });
  function updateJob(job: OnlineJob) {
    if (store.context) observeJob(store.context, job);
    const index = store.jobs.findIndex(row => row.jobId === job.jobId);
    if (index >= 0) store.jobs = store.jobs.map((existing, i) => i === index ? job : existing);
    const same = (previous: OnlineJob) => previous.jobId === job.jobId && previous.executionId === job.executionId;
    const run = store.submissions.find(value => value.job && same(value.job));
    if (run) run.job = job;
    const selected = store.resultSelection;
    if (selected?.kind === 'agent' && 'job' in selected && same(selected.job)) {
      store.resultSelection = { kind: 'agent', job };
      if (!isFullOnlineJob(job) || job.reportState !== 'archived') store.report = null;
    }
    prune();
  }
  function retain(context: OnlineExecutionContext): CachedContext {
    const id = key(context); let entry = contexts.get(id);
    if (!entry) { entry = { context: plain(context), lastUsed: now(), debugKeys: new Set(), pending: new Set(), uncertain: new Set(), jobs: new Map(), jobCursor: 0 }; contexts.set(id, entry); }
    return entry;
  }
  function observeJob(context: OnlineExecutionContext, job: OnlineJob) {
    const entry = retain(context); const id = JSON.stringify([job.agentId, job.jobId, job.executionId]);
    const released = job.state === 'ended' && job.executionReleased && isFullOnlineJob(job) && ['archived', 'expired'].includes(job.reportState);
    if (released) entry.jobs.delete(id); else entry.jobs.set(id, { jobId: job.jobId, executionId: job.executionId, agentId: job.agentId });
    entry.payloadBytes = undefined;
  }
  function protectedContext(entry: CachedContext) {
    const saves = assetSaves.get(key(entry.context));
    return entry.pending.size > 0 || entry.uncertain.size > 0 || entry.jobs.size > 0
      || !!saves && [...saves.values()].some(record => record.feedback.status === "saving" || record.feedback.status === "unknown");
  }
  function payloadBytes(id: string, entry: CachedContext) {
    return entry.payloadBytes ??= new TextEncoder().encode(JSON.stringify({ selection: selections.get(id), runs: histories.get(id),
      project: projectViews.get(id), saves: [...(assetSaves.get(id)?.values() ?? [])],
      debugSessions: [...entry.debugKeys].map(debugKey => debugSessions.get(debugKey)) })).byteLength;
  }
  function drop(id: string, entry: CachedContext) {
    selections.delete(id); runs.delete(id); histories.delete(id); projectViews.delete(id); assetSaves.delete(id);
    for (const debugKey of entry.debugKeys) debugSessions.delete(debugKey); contexts.delete(id);
  }
  function prune() {
    const active = key(store.context), instant = now(), preferences = store.cachePreferences;
    const inactive = [...contexts].filter(([id, entry]) => id !== active && !protectedContext(entry)).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (let index = inactive.length - 1; index >= 0; index--) {
      const [id, entry] = inactive[index]!;
      if (instant - entry.lastUsed >= preferences.inactiveTtlMinutes * 60_000) { drop(id, entry); inactive.splice(index, 1); }
    }
    let bytes = inactive.reduce((sum, [id, entry]) => sum + payloadBytes(id, entry), 0);
    while (inactive.length > preferences.maxInactiveContexts || bytes > preferences.maxInactivePayloadMiB * 1024 * 1024) {
      const [id, entry] = inactive.shift()!; bytes -= payloadBytes(id, entry); drop(id, entry);
    }
    const protectedEntries = [...contexts].filter(([id, entry]) => id !== active && protectedContext(entry));
    const protectedBytes = protectedEntries.reduce((sum, [id, entry]) => sum + payloadBytes(id, entry), 0);
    store.cacheUsage = { currentContexts: store.context ? 1 : 0, protectedContexts: protectedEntries.length, inactiveContexts: inactive.length,
      inactivePayloadBytes: bytes, overLimit: protectedEntries.length > preferences.maxInactiveContexts || protectedBytes > preferences.maxInactivePayloadMiB * 1024 * 1024 };
  }
  function chooseRun(run: RunRecord) {
    store.report = null; store.localResult = null; store.selectedJobId = '';
    store.resultSelection = run.location.kind === 'local' ? { kind: 'local', runId: run.runId, ...(run.environmentId ? { environmentId: run.environmentId } : {}) } : run.job ? { kind: 'agent', job: run.job } : { kind: 'agent', runId: run.runId };
  }
  function publishRun(run: RunRecord) {
    // Lifecycle ownership outlives page visibility; only this context's latest run can settle it.
    if (key(store.context) !== key(run.context) || runs.get(key(run.context)) !== run) return;
    store.running = run.pending; store.activeLocalRunId = run.pending && run.location.kind === 'local' ? run.runId : '';
    if (!store.visible) return;
    if (run.job) {
      store.jobs = [run.job, ...store.jobs.filter(job => job.jobId !== run.job!.jobId)].slice(0,statusPageSize);
      schedule();
    }
    const selected = store.resultSelection;
    const ownsSelection = selected && ('runId' in selected ? selected.runId === run.runId : run.job && selected.job.jobId === run.job.jobId && selected.job.executionId === run.job.executionId);
    if (!ownsSelection) return;
    if (run.result) store.localResult = run.result;
    if (run.job) { store.resultSelection = { kind: 'agent', job: run.job }; store.selectedJobId = run.job.jobId; }
    store.error = run.error;
  }
  return store;
}
export type OnlineExecutionStore = ReturnType<typeof createOnlineExecutionStore>;

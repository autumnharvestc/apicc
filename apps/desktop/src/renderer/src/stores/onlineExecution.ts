import { reactive, shallowReactive, ref } from "vue";
import { ClientConfigSchema, ProjectExecutionAgentsSchema, StressRunConfigSchema, type ProjectExecutionAgents, type TaskTarget, type AssetDelta } from "@apicc/execution/contract";
import type { ContractProject } from "@apicc/core";
import type { PluginsListResult } from "../../../shared/plugins/contract.js";
import { OnlineProjectViewSchema, OnlineJobSchema, OnlineLocalResultSchema, OnlineReportSchema, OnlineMaterialsMetadataSchema, type OnlineExecutionContext, type ExecutionLocation, type OnlineExecutionPort, type OnlineProjectView, type OnlineJob, type OnlineLocalResult, type OnlineReport } from "../../../shared/online/execution.js";
import type { AttachmentWriteSchema } from "@apicc/execution/contract";
import { z } from "zod";
import { isFullOnlineJob } from '../../../shared/online/execution.js';
import { defaultExecutionCacheStorage, readExecutionCachePreferences, OnlineExecutionCachePreferencesSchema, ONLINE_EXECUTION_CACHE_SETTINGS_KEY,
  type ExecutionCacheStorage, type OnlineExecutionCachePreferences } from './onlineExecutionCachePreferences.js';
type ResultSelection = { kind: 'local'; runId: string; environmentId?: string } | { kind: 'agent'; runId: string } | { kind: 'agent'; job: OnlineJob };
type RunRecord = { context: OnlineExecutionContext; runId: string; target: Pick<TaskTarget, 'kind'>; location: ExecutionLocation; environmentId?: string; pending: boolean; result?: OnlineLocalResult; job?: OnlineJob; error: string };
type CachedContext = { context: OnlineExecutionContext; lastUsed: number; payloadBytes?: number; debugKeys: Set<string>;
  pending: Set<string>; uncertain: Set<string>; jobs: Map<string, { jobId: string; executionId: string; agentId: string }>; jobCursor: number };
export interface OnlineExecutionCacheOptions { storage?: ExecutionCacheStorage | null; now?: () => number; preferences?: OnlineExecutionCachePreferences }
export function createOnlineExecutionStore(api: OnlineExecutionPort & { pluginsList?(): Promise<PluginsListResult> }, options: OnlineExecutionCacheOptions = {}) {
  let generation = 0; let timer: ReturnType<typeof setTimeout> | undefined;
  const stressConfirmation = ref('');
  const selections = new Map<string, { location: ExecutionLocation; environmentId?: string }>();
  const debugSessions = new Map<string, string>();
  const runs = new Map<string, RunRecord>();
  const contexts = new Map<string, CachedContext>();
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
  const stop = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    stop();
    if (store.visible && store.context && (store.jobs.some(job => job.state !== "ended" || !job.executionReleased || isFullOnlineJob(job) && job.reportState === "pending") || contexts.get(key(store.context))?.jobs.size)) timer = setTimeout(() => { void store.refreshActive(); }, store.statusRefreshMs);
  };
  const store = shallowReactive({
    context: null as OnlineExecutionContext | null, location: { kind: "local" } as ExecutionLocation,
    environmentId: undefined as string | undefined, visible: false, jobs: [] as OnlineJob[], error: "", statusRefreshMs: 2000,
    connection: "unknown" as "unknown" | "connected" | "disconnected", view: null as OnlineProjectView | null,
    agents: null as ProjectExecutionAgents | null, project: null as ContractProject | null, saved: "", busy: false, running: false,
    localResult: null as OnlineLocalResult | null, report: null as OnlineReport | null, selectedJobId: "",
    resultSelection: null as ResultSelection | null,
    localPlugins: null as PluginsListResult | null, activeLocalRunId: "",
    cachePreferences: Object.freeze(initialPreferences), cachePreferenceDiagnostic: initial.diagnostic as string | null,
    cacheUsage: { currentContexts: 0, protectedContexts: 0, inactiveContexts: 0, inactivePayloadBytes: 0, overLimit: false },
    stressConfirmedOrigins: [] as string[], stressWorkerCount: 1,
    materialMetadata: null as z.infer<typeof OnlineMaterialsMetadataSchema> | null,
    localOnlyRefIds: [] as string[], materials: { credentials: [] as Array<{ refId: string; version: string }>, attachments: [] as Array<{ refId: string; version: string; hash: string }>, attachmentPaths: {} as Record<string, { refId: string; version: string; hash: string }> },
    get dirty(): boolean { return !!store.project && JSON.stringify(store.project) !== store.saved; },
    get activeStressLocalRunId(): string { const run = runs.get(key(store.context)); return store.activeLocalRunId && run?.target.kind === 'stress' && run.runId === store.activeLocalRunId ? run.runId : ''; },
    activate(context: OnlineExecutionContext | null) {
      if (key(context) === key(store.context)) return;
      prune();
      if (store.context) {
        selections.set(key(store.context), { location: plain(store.location), environmentId: store.environmentId });
        const previous = retain(store.context); previous.lastUsed = now(); previous.payloadBytes = undefined;
      }
      generation++; stop(); store.context = context ? plain(context) : null; store.jobs = []; store.view = null; store.project = null; store.agents = null; store.saved = ""; store.error = ""; store.localResult = null; store.report = null; store.busy = false; store.running = false; store.connection = "unknown"; store.localOnlyRefIds = []; store.materials = { credentials: [], attachments: [], attachmentPaths: {} };
      stressConfirmation.value = ''; store.stressConfirmedOrigins = []; store.stressWorkerCount = 1;
      store.materialMetadata = null; store.activeLocalRunId = ''; store.selectedJobId = ''; store.resultSelection = null;
      if (context) retain(context).lastUsed = now();
      prune();
      const selection = selections.get(key(context)); store.location = selection?.location ?? { kind: "local" }; store.environmentId = selection?.environmentId;
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
    async load() {
      const context = store.context && plain(store.context); if (!context || !store.visible) return;
      const token = generation; store.busy = true;
      try {
        const view = OnlineProjectViewSchema.parse(await api.onlineExecution({ operation: "assets", context }));
        if (!current(token, context)) return;
        store.view = view; store.project = editableProject(view.project); store.saved = JSON.stringify(store.project);
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
        for (const job of store.jobs) observeJob(context, job);
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
      const token = generation; const view = OnlineProjectViewSchema.parse(await api.onlineExecution({ operation: "save", context, delta: plain(delta) }));
      if (!current(token, context)) return;
      store.view = view; store.project = editableProject(view.project); store.saved = JSON.stringify(store.project);
    },
    async saveProject(project: ContractProject) {
      const context = store.context && plain(store.context); if (!context || !store.view) throw new Error("online-project-unavailable");
      const token = generation; const view = OnlineProjectViewSchema.parse(await api.onlineExecution({ operation: "saveProject", context, project: plain(project), expectedVersion: store.view.assets.version }));
      if (!current(token, context)) throw new Error("online-session-changed");
      store.view = view; store.project = editableProject(view.project); store.saved = JSON.stringify(store.project);
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
      const run: RunRecord = { context, runId, target: { kind: target.kind }, location, environmentId: store.environmentId, pending: true, error: '' };
      const cached = retain(context); cached.pending.add(runId); cached.payloadBytes = undefined;
      runs.set(key(context), run); chooseRun(run); store.error = ''; publishRun(run);
      try {
        const raw = await api.onlineExecution({ operation: "run", context, runId, location, target: plain(target), expectedVersion: store.view.assets.version, environmentId: run.environmentId, ...(target.kind === 'debug' && debugSessions.has(sessionKey) ? { debugSessionId: debugSessions.get(sessionKey) } : {}), runConfig: stress ? { stress } : {}, materials: { projectId: context.scope.projectId, ...plain(store.materials) }, localOnlyRefIds: [...store.localOnlyRefIds] });
        if (location.kind === 'local') { const result = OnlineLocalResultSchema.parse(raw); if (result.runId !== runId) throw new Error('fixed-input-mismatch'); run.result = result; if (result.debugSessionId) { debugSessions.set(sessionKey, result.debugSessionId); cached.debugKeys.add(sessionKey); } }
        else { run.job = OnlineJobSchema.parse(raw); observeJob(context, run.job); if (isFullOnlineJob(run.job) && run.job.task.debugSessionId) { debugSessions.set(sessionKey, run.job.task.debugSessionId); cached.debugKeys.add(sessionKey); } }
      } catch (error) { const failure = error instanceof z.ZodError && error.issues.some(issue => issue.path.includes('output')) ? new Error('invalid-core-output') : error; run.error = failure instanceof Error ? failure.message : String(failure); throw failure; }
      finally { run.pending = false; cached.pending.delete(runId); if (!run.result && !run.job) cached.uncertain.add(runId); cached.payloadBytes = undefined; publishRun(run); prune(); }
    },
    async cancelLocal() { if (!store.context || !store.activeLocalRunId) return; await api.onlineExecution({ operation: 'cancel', context: plain(store.context), location: { kind: 'local' }, runId: store.activeLocalRunId }); },
    async inspect(job: OnlineJob, intentCurrent: () => boolean = () => true) {
      const context = store.context && plain(store.context); if (!context) return;
      observeJob(context, job); prune();
      const token = generation; store.selectedJobId = job.jobId; store.report = null; store.localResult = null;
      store.resultSelection = { kind: 'agent', job: plain(job) };
      if (!isFullOnlineJob(job) || job.reportState !== "archived") return;
      const raw = await api.onlineExecution({ operation: "report", context, runId: job.jobId, location: { kind: "agent", agentId: job.agentId } });
      if (!intentCurrent()) return;
      const parsed = OnlineReportSchema.safeParse(raw);
      if (!parsed.success) throw new Error(parsed.error.issues.some(issue => issue.path.includes('output')) ? 'invalid-core-output' : 'invalid-online-report');
      const report = parsed.data;
      const selected = store.resultSelection;
      if (current(token, context) && selected?.kind === 'agent' && 'job' in selected && selected.job.jobId === job.jobId && selected.job.executionId === job.executionId) {
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
    if (index >= 0) store.jobs[index] = job;
    const same = (previous: OnlineJob) => previous.jobId === job.jobId && previous.executionId === job.executionId;
    const run = runs.get(key(store.context));
    if (run?.job && same(run.job)) run.job = job;
    const selected = store.resultSelection;
    if (selected?.kind === 'agent' && 'job' in selected && same(selected.job)) {
      store.resultSelection = { kind: 'agent', job };
      if (!isFullOnlineJob(job)) store.report = null;
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
  function protectedContext(entry: CachedContext) { return entry.pending.size > 0 || entry.uncertain.size > 0 || entry.jobs.size > 0; }
  function payloadBytes(id: string, entry: CachedContext) {
    return entry.payloadBytes ??= new TextEncoder().encode(JSON.stringify({ selection: selections.get(id), run: runs.get(id),
      debugSessions: [...entry.debugKeys].map(debugKey => debugSessions.get(debugKey)) })).byteLength;
  }
  function drop(id: string, entry: CachedContext) {
    selections.delete(id); runs.delete(id); for (const debugKey of entry.debugKeys) debugSessions.delete(debugKey); contexts.delete(id);
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
    const selected = store.resultSelection;
    const ownsSelection = selected && ('runId' in selected ? selected.runId === run.runId : run.job && selected.job.jobId === run.job.jobId && selected.job.executionId === run.job.executionId);
    if (!ownsSelection) return;
    if (run.result) store.localResult = run.result;
    if (run.job) { store.jobs = [run.job, ...store.jobs.filter(job => job.jobId !== run.job!.jobId)]; store.resultSelection = { kind: 'agent', job: run.job }; store.selectedJobId = run.job.jobId; schedule(); }
    store.error = run.error;
  }
  return store;
}
export type OnlineExecutionStore = ReturnType<typeof createOnlineExecutionStore>;

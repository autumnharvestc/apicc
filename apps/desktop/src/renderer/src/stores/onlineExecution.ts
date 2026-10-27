import { reactive, shallowReactive } from "vue";
import { ClientConfigSchema, ProjectExecutionAgentsSchema, type ProjectExecutionAgents, type TaskTarget, type AssetDelta } from "@apicc/execution/contract";
import type { ContractProject } from "@apicc/core";
import type { PluginsListResult } from "../../../shared/plugins/contract.js";
import { OnlineProjectViewSchema, OnlineJobSchema, OnlineLocalResultSchema, OnlineReportSchema, OnlineMaterialsMetadataSchema, type OnlineExecutionContext, type ExecutionLocation, type OnlineExecutionPort, type OnlineProjectView, type OnlineJob, type OnlineLocalResult, type OnlineReport } from "../../../shared/online/execution.js";
import type { AttachmentWriteSchema } from "@apicc/execution/contract";
import { z } from "zod";
type ResultSelection = { kind: 'local'; runId: string; environmentId?: string } | { kind: 'agent'; runId: string } | { kind: 'agent'; job: OnlineJob };
type RunRecord = { context: OnlineExecutionContext; runId: string; location: ExecutionLocation; environmentId?: string; pending: boolean; result?: OnlineLocalResult; job?: OnlineJob; error: string };
export function createOnlineExecutionStore(api: OnlineExecutionPort & { pluginsList?(): Promise<PluginsListResult> }) {
  let generation = 0; let timer: ReturnType<typeof setTimeout> | undefined;
  const selections = new Map<string, { location: ExecutionLocation; environmentId?: string }>();
  const debugSessions = new Map<string, string>();
  const runs = new Map<string, RunRecord>();
  const key = (context: OnlineExecutionContext | null) => JSON.stringify(context);
  const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const editableProject = (value: ContractProject | null): ContractProject | null => value ? reactive(plain(value) as object) as ContractProject : null;
  const current = (token: number, context: OnlineExecutionContext) => generation === token && store.visible && key(context) === key(store.context);
  const stop = () => { if (timer) clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    stop();
    if (store.visible && store.context && store.jobs.some(job => job.state !== "ended" || !job.executionReleased || job.reportState === "pending")) timer = setTimeout(() => { void store.refreshActive(); }, store.statusRefreshMs);
  };
  const store = shallowReactive({
    context: null as OnlineExecutionContext | null, location: { kind: "local" } as ExecutionLocation,
    environmentId: undefined as string | undefined, visible: false, jobs: [] as OnlineJob[], error: "", statusRefreshMs: 2000,
    connection: "unknown" as "unknown" | "connected" | "disconnected", view: null as OnlineProjectView | null,
    agents: null as ProjectExecutionAgents | null, project: null as ContractProject | null, saved: "", busy: false, running: false,
    localResult: null as OnlineLocalResult | null, report: null as OnlineReport | null, selectedJobId: "",
    resultSelection: null as ResultSelection | null,
    localPlugins: null as PluginsListResult | null, activeLocalRunId: "",
    materialMetadata: null as z.infer<typeof OnlineMaterialsMetadataSchema> | null,
    localOnlyRefIds: [] as string[], materials: { credentials: [] as Array<{ refId: string; version: string }>, attachments: [] as Array<{ refId: string; version: string; hash: string }>, attachmentPaths: {} as Record<string, { refId: string; version: string; hash: string }> },
    get dirty(): boolean { return !!store.project && JSON.stringify(store.project) !== store.saved; },
    activate(context: OnlineExecutionContext | null) {
      if (key(context) === key(store.context)) return;
      if (store.context) selections.set(key(store.context), { location: plain(store.location), environmentId: store.environmentId });
      generation++; stop(); store.context = context ? plain(context) : null; store.jobs = []; store.view = null; store.project = null; store.agents = null; store.saved = ""; store.error = ""; store.localResult = null; store.report = null; store.busy = false; store.running = false; store.connection = "unknown"; store.localOnlyRefIds = []; store.materials = { credentials: [], attachments: [], attachmentPaths: {} };
      store.materialMetadata = null; store.activeLocalRunId = ''; store.selectedJobId = ''; store.resultSelection = null;
      const selection = selections.get(key(context)); store.location = selection?.location ?? { kind: "local" }; store.environmentId = selection?.environmentId;
      const run = runs.get(key(context)); if (run) { chooseRun(run); publishRun(run); }
    },
    selectLocation(location: ExecutionLocation) { store.location = plain(location); },
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
        const jobs = await api.onlineExecution({ operation: "list", context, limit: 20 });
        if (!current(token, context)) return;
        store.jobs = reactive(OnlineJobSchema.array().parse(jobs) as object) as OnlineJob[]; store.connection = "connected";
      } catch (error) { if (current(token, context)) { store.error = error instanceof Error ? error.message : String(error); store.connection = "disconnected"; } }
      finally { if (current(token, context)) schedule(); }
    },
    async refreshActive() {
      const context = store.context && plain(store.context); if (!context || !store.visible) return;
      const token = generation;
      try {
        for (const existing of [...store.jobs].filter(job => job.state !== "ended" || !job.executionReleased || job.reportState === "pending")) {
          const raw = await api.onlineExecution({ operation: "status", context, runId: existing.jobId, location: { kind: "agent", agentId: existing.agentId } });
          if (!current(token, context)) return;
          const job = OnlineJobSchema.parse(raw); const index = store.jobs.findIndex(row => row.jobId === job.jobId); if (index >= 0) store.jobs[index] = job;
        }
        store.connection = "connected";
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
      if (target.kind !== "debug" && store.dirty) throw new Error("save-before-running");
      if (store.location.kind === "agent" && store.localOnlyRefIds.length) throw new Error("local-material-required");
      if (runs.get(key(context))?.pending) throw new Error('online-run-in-progress');
      const runId = crypto.randomUUID(); const location = plain(store.location); const sessionKey = JSON.stringify([context, location]);
      const run: RunRecord = { context, runId, location, environmentId: store.environmentId, pending: true, error: '' };
      runs.set(key(context), run); chooseRun(run); store.error = ''; publishRun(run);
      try {
        const raw = await api.onlineExecution({ operation: "run", context, runId, location, target: plain(target), expectedVersion: store.view.assets.version, environmentId: run.environmentId, ...(target.kind === 'debug' && debugSessions.has(sessionKey) ? { debugSessionId: debugSessions.get(sessionKey) } : {}), runConfig: {}, materials: { projectId: context.scope.projectId, ...plain(store.materials) }, localOnlyRefIds: [...store.localOnlyRefIds] });
        if (location.kind === 'local') { const result = OnlineLocalResultSchema.parse(raw); if (result.runId !== runId) throw new Error('fixed-input-mismatch'); run.result = result; if (result.debugSessionId) debugSessions.set(sessionKey, result.debugSessionId); }
        else { run.job = OnlineJobSchema.parse(raw); if (run.job.task.debugSessionId) debugSessions.set(sessionKey, run.job.task.debugSessionId); }
      } catch (error) { const failure = error instanceof z.ZodError && error.issues.some(issue => issue.path.includes('output')) ? new Error('invalid-core-output') : error; run.error = failure instanceof Error ? failure.message : String(failure); throw failure; }
      finally { run.pending = false; publishRun(run); }
    },
    async cancelLocal() { if (!store.context || !store.activeLocalRunId) return; await api.onlineExecution({ operation: 'cancel', context: plain(store.context), location: { kind: 'local' }, runId: store.activeLocalRunId }); },
    async inspect(job: OnlineJob) {
      const context = store.context && plain(store.context); if (!context) return;
      const token = generation; store.selectedJobId = job.jobId; store.report = null; store.localResult = null;
      store.resultSelection = { kind: 'agent', job: plain(job) };
      if (job.reportState !== "archived") return;
      const parsed = OnlineReportSchema.safeParse(await api.onlineExecution({ operation: "report", context, runId: job.jobId, location: { kind: "agent", agentId: job.agentId } }));
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
      const updated = OnlineJobSchema.parse(raw); const index = store.jobs.findIndex(row => row.jobId === updated.jobId); if (index >= 0) store.jobs[index] = updated; schedule();
    },
  });
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

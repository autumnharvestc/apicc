import { createPinia, defineStore } from "pinia";
import type { StressThresholds } from "@apicc/core";
import type { SavedStressPlan, StressPlan, StressTarget, StressComparison, StressReportV2 } from "@apicc/core";
import { StressPlanSchema } from "@apicc/core/schema";
import type { ApiLocator, ProjectLocator } from "../../../shared/locations.js";
import { stressTargetIdentity, type ApiccApi, type DesktopStressReport, type StressRunInput, type StressProgressDTO, type StressRunSummaryDTO } from "../../../shared/types.js";
import { apiSessionKey, projectSessionKey } from "./localIdentity.js";

export interface PendingStressConfirmation {
  origin: string;
  locator: ApiLocator;
  projectLocator: ProjectLocator;
  root: string;
  sessionKey: string;
  generation: number;
  token: number;
}

export interface StressContext {
  root: string;
  locator: ApiLocator | null;
  projectLocator?: ProjectLocator | null;
}

/**
 * 压测表单状态：mode 决定 start 组装哪个终止条件；用例/环境由当前接口上下文驱动。
 */
export interface StressForm {
  caseId: string | null;
  envName: string | null;
  concurrency: number;
  mode: "iterations" | "duration";
  iterations: number;
  durationSeconds: number;
  thresholds: StressThresholds;
  connectionMode: "pooled" | "fresh";
}

export function createStressFormDefaults(): StressForm {
  return {
    caseId: null, envName: null, concurrency: 1, mode: "iterations", iterations: 10, durationSeconds: 10,
    thresholds: {}, connectionMode: "pooled",
  };
}

function copyApiLocator(locator: ApiLocator): ApiLocator {
  return {
    workspaceId: locator.workspaceId,
    groupId: locator.groupId,
    projectId: locator.projectId,
    collectionId: locator.collectionId,
    folderIds: [...locator.folderIds],
    apiId: locator.apiId,
  };
}

function projectOf(locator: ApiLocator): ProjectLocator {
  return { workspaceId: locator.workspaceId, groupId: locator.groupId, projectId: locator.projectId };
}

function sessionFor(context: StressContext, locator: ApiLocator): PendingStressConfirmation | null {
  if (!context.root || !context.locator) return null;
  const actualKey = apiSessionKey(context.root, context.locator);
  const submittedLocator = copyApiLocator(locator);
  const submittedKey = apiSessionKey(context.root, submittedLocator);
  if (actualKey !== submittedKey) return null;
  return {
    origin: "",
    locator: submittedLocator,
    projectLocator: projectOf(submittedLocator),
    root: context.root,
    sessionKey: submittedKey,
    generation: 0,
    token: 0,
  };
}

/** Store for the currently selected local API. Root + complete API locator fence every async result. */
export function createStressStore(deps: {
  api: ApiccApi;
  getContext: () => StressContext;
  trustOrigin?: (locator: ProjectLocator, origin: string) => Promise<void>;
}) {
  const { api } = deps;
  type PlanRun = { invocationId: string; root: string; hostRoot: string | null; scope: ProjectLocator; target: StressTarget; generation: number; runId: string | null; hostGeneration: number | null; cancelled: boolean; stopping: Promise<void> | null };
  let activePlan: PlanRun | null = null;
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const contextScope = () => { const c = deps.getContext(); return c.projectLocator === undefined ? c.locator ? projectOf(c.locator) : null : c.projectLocator; };
  const ownerKey = (root: string, scope: ProjectLocator) => projectSessionKey(root, scope);
  return defineStore("stress", {
    state: () => ({
      running: false,
      report: null as DesktopStressReport | null,
      file: null as string | null,
      error: null as string | null,
      form: createStressFormDefaults(),
      generation: 0,
      activeRoot: null as string | null,
      activeSessionKey: null as string | null,
      confirmedTargetOrigins: [] as string[],
      pendingTargetOrigin: null as string | null,
      pendingConfirmation: null as PendingStressConfirmation | null,
      attemptToken: 0,
      confirmationInFlight: false,
      planOwner: null as { root: string; scope: ProjectLocator } | null,
      plan: null as StressPlan | null,
      plans: [] as SavedStressPlan[],
      planName: "",
      savedPlanId: null as string | null,
      planReport: null as DesktopStressReport | StressReportV2 | null,
      planFile: null as string | null,
      planState: "idle" as "idle" | "preparing" | "warmup" | "running" | "draining" | "stopping" | "finished",
      progress: null as StressProgressDTO | null,
      history: [] as StressRunSummaryDTO[],
      baselineFile: null as string | null,
      comparison: null as StressComparison | null,
      comparisonError: null as string | null,
      planConfirmedOrigins: [] as string[],
      planPendingOrigin: null as string | null,
      planConfirmation: null as { plan: StressPlan; generation: number } | null,
      historyRequest: 0,
      comparisonRequest: 0,
      planReadRequest: 0,
      planSaveRequest: 0,
    }),
    actions: {
      planCurrent(owner?: { root: string; scope: ProjectLocator } | null, generation?: number): boolean {
        owner ??= this.planOwner; generation ??= this.generation;
        const scope = contextScope(), c = deps.getContext();
        return !!owner && generation === this.generation && !!scope && c.root === owner.root
          && !!this.planOwner && ownerKey(c.root, scope) === ownerKey(owner.root, owner.scope)
          && ownerKey(this.planOwner.root, this.planOwner.scope) === ownerKey(owner.root, owner.scope);
      },
      async openWorkbench(scope: ProjectLocator, target: StressTarget) {
        const root = deps.getContext().root;
        if (!root || !contextScope() || ownerKey(root, scope) !== ownerKey(root, contextScope()!)) return;
        const changed = !this.planOwner || ownerKey(root, scope) !== ownerKey(this.planOwner.root, this.planOwner.scope);
        if (changed) { this.clear(); this.planOwner = { root, scope: clone(scope) }; }
        if (!this.plan || JSON.stringify(stressTargetIdentity(this.plan.target)) !== JSON.stringify(stressTargetIdentity(target))) {
          if (!changed && this.plan) { if (activePlan) void this.stopPlan(); this.generation++; }
          this.plan = StressPlanSchema.parse({ formatVersion: 1, target: clone(target), load: { kind: "constant-vus", vus: 1 }, termination: { maxIterations: 10 } });
          this.savedPlanId = null; this.planName = "";
          this.planReport = null; this.planFile = null; this.comparison = null; this.comparisonError = null;
          this.denyPlanTarget();
        }
        await this.loadPlans();
      },
      async loadPlans() {
        const owner = this.planOwner, generation = this.generation;
        if (!this.planCurrent(owner, generation) || !owner) return;
        const values = await api.stressPlansList(clone(owner.scope));
        if (this.planCurrent(owner, generation)) this.plans = values;
      },
      async openPlan(id: string) {
        const owner = this.planOwner, generation = this.generation;
        if (this.running || !owner || !this.planCurrent(owner, generation)) return;
        const request = ++this.planReadRequest, capturedPlan = this.plan;
        const saved = await api.stressPlansGet(clone(owner.scope), id);
        if (!saved || this.running || activePlan || request !== this.planReadRequest || this.plan !== capturedPlan || !this.planCurrent(owner, generation)) return;
        this.plan = clone(saved.plan); this.planName = saved.name; this.savedPlanId = saved.id;
        this.planPendingOrigin = null; this.planConfirmation = null; this.planConfirmedOrigins = [];
      },
      async savePlan() {
        const owner = this.planOwner, generation = this.generation;
        if (this.running || !this.plan || !owner || !this.planCurrent(owner, generation)) return;
        const draft = this.plan, savedId = this.savedPlanId, request = ++this.planSaveRequest, readRequest = this.planReadRequest;
        const saved = await api.stressPlansSave(clone(owner.scope), { ...(this.savedPlanId ? { id: this.savedPlanId } : {}), name: this.planName, plan: StressPlanSchema.parse(clone(this.plan)) });
        if (!this.planCurrent(owner, generation)) return;
        if (this.plan === draft && this.savedPlanId === savedId && request === this.planSaveRequest && readRequest === this.planReadRequest) this.savedPlanId = saved.id;
        await this.loadPlans();
      },
      async removePlan(id: string) {
        const owner = this.planOwner, generation = this.generation;
        if (this.running || !owner || !this.planCurrent(owner, generation)) return;
        await api.stressPlansRemove(clone(owner.scope), id);
        if (!this.planCurrent(owner, generation)) return;
        if (this.savedPlanId === id) { this.savedPlanId = null; this.planName = ""; }
        await this.loadPlans();
      },
      async loadStressHistory() {
        const owner = this.planOwner, generation = this.generation, request = ++this.historyRequest;
        if (!owner || !this.planCurrent(owner, generation)) return;
        const rows = await api.stressRunsList(clone(owner.scope));
        if (this.planCurrent(owner, generation) && request === this.historyRequest) this.history = rows;
      },
      async openStressReport(file: string) {
        const owner = this.planOwner, generation = this.generation, request = ++this.historyRequest;
        if (!owner || !this.planCurrent(owner, generation)) return;
        const value = await api.stressRunsGet(clone(owner.scope), file);
        if (!this.planCurrent(owner, generation) || request !== this.historyRequest || value?.kind !== "stress") return;
        if (value.report.projectId && value.report.projectId !== owner.scope.projectId) throw new Error("历史记录不属于当前项目");
        this.planReport = value.report; this.planFile = file;
        await this.compareBaseline();
      },
      async selectBaseline(file: string | null) {
        this.baselineFile = file; await this.compareBaseline();
      },
      async compareBaseline() {
        const owner = this.planOwner, generation = this.generation, request = ++this.comparisonRequest;
        this.comparison = null; this.comparisonError = null;
        const baseFile = this.baselineFile, candidateFile = this.planFile;
        if (!owner || !baseFile || !candidateFile || !this.planCurrent(owner, generation)) return;
        try {
          const result = await api.stressCompare(clone(owner.scope), { baseFile, candidateFile });
          if (this.planCurrent(owner, generation) && request === this.comparisonRequest) this.comparison = result;
        } catch (e) { if (this.planCurrent(owner, generation) && request === this.comparisonRequest) this.comparisonError = e instanceof Error ? e.message : String(e); }
      },
      async exportReport(format: "html" | "json") {
        const owner = this.planOwner;
        if (!owner || !this.planFile || !this.planCurrent(owner)) return;
        return api.stressExport(clone(owner.scope), { file: this.planFile, ...(this.baselineFile ? { baselineFile: this.baselineFile } : {}), format });
      },
      async startPlan(retry = false) {
        const owner = this.planOwner, generation = this.generation;
        if (this.running || activePlan || !this.plan || !owner || !this.planCurrent(owner, generation)) return;
        const plan = StressPlanSchema.parse(clone(retry && this.planConfirmation ? this.planConfirmation.plan : this.plan));
        this.planReadRequest++;
        if (!retry) this.planConfirmedOrigins = [];
        this.planPendingOrigin = null; this.planConfirmation = null;
        const run: PlanRun = { invocationId: crypto.randomUUID(), root: owner.root, hostRoot: null, scope: clone(owner.scope), target: clone(plan.target), generation, runId: null, hostGeneration: null, cancelled: false, stopping: null };
        activePlan = run; this.running = true; this.planState = "preparing"; this.error = null; this.progress = null;
        const current = () => activePlan === run && this.planCurrent(owner, generation);
        const dispose = api.onStressProgress((value) => {
          if (activePlan !== run || value.invocationId !== run.invocationId || !value.target
            || value.sourceRoot !== run.root || ownerKey(run.root, value.projectLocator) !== ownerKey(run.root, run.scope)
            || JSON.stringify(value.target) !== JSON.stringify(stressTargetIdentity(run.target))) return;
          if (!run.runId) {
            if (value.state !== "preparing") return;
            run.runId = value.runId; run.hostGeneration = value.generation; run.hostRoot = value.root;
          }
          if (value.runId !== run.runId || value.generation !== run.hostGeneration || value.root !== run.hostRoot) return;
          if (run.cancelled) void this.stopPlan();
          if (!current()) return;
          this.progress = value;
          // The completion Promise also covers persistence and release of the host active slot.
          if (run.cancelled || this.planState === "stopping") this.planState = "stopping";
          else if (value.state !== "finished") this.planState = value.state === "stopping" ? "stopping" : value.phase === "warmup" ? "warmup" : value.phase === "drain" || value.phase === "vu-teardown" || value.phase === "teardown" ? "draining" : value.state === "running" ? "running" : "preparing";
        });
        try {
          const out = await api.stressRun({ kind: "plan", root: run.root, invocationId: run.invocationId, projectLocator: run.scope, plan, ...(this.planConfirmedOrigins.length ? { confirmedTargetOrigins: [...this.planConfirmedOrigins] } : {}) });
          if (!current()) return;
          if (!out.ok) {
            if (out.error.code === "target_confirmation_required" && out.error.targetOrigin && !run.cancelled) {
              this.planPendingOrigin = out.error.targetOrigin; this.planConfirmation = { plan, generation };
            } else { this.error = out.error.message; this.planConfirmedOrigins = []; }
            return;
          }
          if (run.runId && out.runId !== run.runId || out.report.projectId !== run.scope.projectId || out.report.runId !== out.runId
            || JSON.stringify(stressTargetIdentity(out.report.target)) !== JSON.stringify(stressTargetIdentity(run.target))) throw new Error("压测结果身份不匹配");
          this.planReport = out.report; this.planFile = out.file ?? null; this.planConfirmedOrigins = [];
          await this.compareBaseline();
        } catch (e) {
          if (current()) { this.error = e instanceof Error ? e.message : String(e); this.planConfirmedOrigins = []; throw e; }
        } finally {
          dispose();
          if (activePlan === run) { activePlan = null; this.running = false; this.planState = this.planCurrent(owner, generation) ? "finished" : "idle"; }
        }
      },
      async confirmPlanTarget(trust: boolean) {
        const pending = this.planConfirmation, owner = this.planOwner, origin = this.planPendingOrigin;
        if (!pending || !origin || !owner || this.confirmationInFlight || !this.planCurrent(owner, pending.generation)) return;
        this.confirmationInFlight = true;
        try {
          if (trust) { if (!deps.trustOrigin) throw new Error("缺少项目目标信任持久化能力"); await deps.trustOrigin(clone(owner.scope), origin); }
          if (!this.planCurrent(owner, pending.generation) || pending !== this.planConfirmation) return;
          this.planConfirmedOrigins.push(origin); await this.startPlan(true);
        } finally { this.confirmationInFlight = false; }
      },
      denyPlanTarget() { this.planPendingOrigin = null; this.planConfirmation = null; this.planConfirmedOrigins = []; },
      async stopPlan() {
        const run = activePlan; if (!run) return;
        run.cancelled = true; if (this.planCurrent(this.planOwner, run.generation)) this.planState = "stopping";
        if (!run.runId || !run.hostRoot || run.stopping) return run.stopping;
        run.stopping = api.stressStop({ runId: run.runId, root: run.hostRoot, projectLocator: clone(run.scope) }).then(() => undefined).catch(e => {
          if (activePlan === run && this.planCurrent(this.planOwner, run.generation)) this.error = e instanceof Error ? e.message : String(e);
        });
        return run.stopping;
      },
      resetAttemptContext() {
        this.confirmedTargetOrigins = [];
        this.pendingTargetOrigin = null;
        this.pendingConfirmation = null;
        this.confirmationInFlight = false;
      },
      invalidateAttempt() {
        this.generation += 1;
        this.attemptToken += 1;
        this.running = false;
        this.activeRoot = null;
        this.activeSessionKey = null;
        this.resetAttemptContext();
      },
      isCurrent(root: string, sessionKey: string, generation: number): boolean {
        if (generation !== this.generation || root !== this.activeRoot || sessionKey !== this.activeSessionKey) return false;
        const context = deps.getContext();
        return context.root === root && !!context.locator && apiSessionKey(root, context.locator) === sessionKey;
      },
      async runAttempt(snapshot: PendingStressConfirmation, token: number) {
        if (this.running) return;
        const caseId = this.form.caseId;
        if (!caseId) return;
        const { locator, projectLocator, root, sessionKey } = snapshot;
        const generation = this.generation;
        if (!this.isCurrent(root, sessionKey, generation)) return;
        this.running = true;
        this.error = null;
        try {
          const input: StressRunInput = {
            locator: copyApiLocator(locator),
            caseId,
            envName: this.form.envName ?? undefined,
            concurrency: this.form.concurrency,
            maxIterations: this.form.mode === "iterations" ? this.form.iterations : null,
            durationMs: this.form.mode === "duration" ? this.form.durationSeconds * 1000 : null,
            ...(Object.keys(this.form.thresholds).length > 0 ? { thresholds: { ...this.form.thresholds } } : {}),
            ...(this.form.connectionMode !== "pooled" ? { connectionMode: this.form.connectionMode } : {}),
            ...(this.confirmedTargetOrigins.length > 0 ? { confirmedTargetOrigins: [...this.confirmedTargetOrigins] } : {}),
          };
          const out = await api.stressRun(input);
          if (!this.isCurrent(root, sessionKey, generation)) return;
          if (!out.ok) {
            if (out.error.code === "target_confirmation_required" && out.error.targetOrigin) {
              this.pendingTargetOrigin = out.error.targetOrigin;
              this.pendingConfirmation = {
                origin: out.error.targetOrigin,
                locator: copyApiLocator(locator),
                projectLocator: { ...projectLocator },
                root,
                sessionKey,
                generation,
                token,
              };
              return;
            }
            const failure = Object.assign(new Error(out.error.message), out.error);
            this.error = failure.message;
            this.resetAttemptContext();
            throw failure;
          }
          this.report = out.report;
          this.file = out.file ?? null;
          this.resetAttemptContext();
        } catch (error) {
          if (!this.isCurrent(root, sessionKey, generation)) return;
          this.error = error instanceof Error ? error.message : String(error);
          this.resetAttemptContext();
          throw error;
        } finally {
          if (generation === this.generation && this.activeSessionKey === sessionKey) {
            this.running = false;
            if (!this.isCurrent(root, sessionKey, generation)) this.invalidateAttempt();
          }
        }
      },
      async start(locator: ApiLocator) {
        if (this.running) return;
        this.invalidateAttempt();
        const snapshot = sessionFor(deps.getContext(), locator);
        if (!snapshot) {
          this.error = "当前接口定位已切换，请重新选择接口";
          return;
        }
        this.activeRoot = snapshot.root;
        this.activeSessionKey = snapshot.sessionKey;
        const token = this.attemptToken;
        return this.runAttempt(snapshot, token);
      },
      async confirmTarget(locator: ApiLocator, trustProject: boolean) {
        const pending = this.pendingConfirmation;
        const active = sessionFor(deps.getContext(), locator);
        if (!pending || !active || pending.origin !== this.pendingTargetOrigin
          || pending.sessionKey !== active.sessionKey || pending.root !== active.root
          || pending.sessionKey !== this.activeSessionKey || pending.root !== this.activeRoot
          || pending.generation !== this.generation || pending.token !== this.attemptToken
          || this.confirmationInFlight) return;
        this.confirmationInFlight = true;
        try {
          if (trustProject) {
            if (!deps.trustOrigin) throw new Error("缺少项目目标信任持久化能力");
            await deps.trustOrigin({ ...pending.projectLocator }, pending.origin);
          }
          if (!this.isCurrent(pending.root, pending.sessionKey, pending.generation)
            || !this.pendingConfirmation || this.pendingConfirmation.token !== pending.token) return;
          if (!this.confirmedTargetOrigins.includes(pending.origin)) this.confirmedTargetOrigins.push(pending.origin);
          this.pendingTargetOrigin = null;
          this.pendingConfirmation = null;
          this.confirmationInFlight = false;
          return this.runAttempt(pending, pending.token);
        } catch (error) {
          if (!this.isCurrent(pending.root, pending.sessionKey, pending.generation)
            || pending.token !== this.attemptToken) return;
          this.error = error instanceof Error ? error.message : String(error);
          this.invalidateAttempt();
          throw error;
        } finally {
          if (pending.generation === this.generation && pending.token === this.attemptToken
            && pending.sessionKey === this.activeSessionKey) this.confirmationInFlight = false;
        }
      },
      denyTarget() {
        this.invalidateAttempt();
      },
      async stop(locator: ApiLocator) {
        const snapshot = sessionFor(deps.getContext(), locator);
        if (!snapshot || !this.running || snapshot.root !== this.activeRoot || snapshot.sessionKey !== this.activeSessionKey) return;
        const generation = this.generation;
        try {
          const out = await api.stressStop();
          if (!this.isCurrent(snapshot.root, snapshot.sessionKey, generation)) return;
          if ("kind" in out) throw new Error("计划压测由计划工作台管理");
          this.report = out.report;
          this.file = out.file ?? null;
          this.error = null;
        } catch (error) {
          if (!this.isCurrent(snapshot.root, snapshot.sessionKey, generation)) return;
          this.error = error instanceof Error ? error.message : String(error);
          this.invalidateAttempt();
          throw error;
        } finally {
          if (generation === this.generation && snapshot.sessionKey === this.activeSessionKey) this.invalidateAttempt();
        }
      },
      clear() {
        if (activePlan) void this.stopPlan();
        this.invalidateAttempt();
        if (activePlan) this.running = true;
        this.report = null;
        this.file = null;
        this.error = null;
        this.planOwner = null; this.plan = null; this.plans = []; this.savedPlanId = null; this.planName = "";
        this.planReport = null; this.planFile = null; this.progress = null; this.planState = activePlan ? "stopping" : "idle";
        this.history = []; this.baselineFile = null; this.comparison = null; this.comparisonError = null;
        this.planPendingOrigin = null; this.planConfirmation = null; this.planConfirmedOrigins = [];
      },
    },
  })(createPinia());
}

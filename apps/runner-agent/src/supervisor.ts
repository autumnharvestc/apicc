import { TaskDeliveryV1Schema, AgentCommandV1Schema, EntityIdSchema, OpaqueIdSchema, validateAgentConfig, MIN_FAULT_REPORT_BYTES, type AgentConfig, type AgentControlTransport, type AgentCommandV1, type TaskDeliveryV1, type ExecutionInputs, type ProjectRunMaterials, type PolicyConfig, type AgentMessageV1 } from "@apicc/execution/contract";
import type { BuildIdentity } from "@apicc/execution/buildIdentity";
import type { InvocationOutput } from "@apicc/execution/host";
import { reportingUnits } from "@apicc/core/report/units";
import { performance } from "node:perf_hooks";
import { TaskSlots } from "./slots.js";
import { selectDispatch } from "./dispatch.js";
import { withInvocation, validateRuntime, validatePermit, preparationReason, rejectPreparation, type InvocationDTO, type PreparedMetadata, type StartPermit } from "./invocationContext.js";
import { TaskWorker } from "./debugWorker.js";
import { DebugSessions } from "./debugSessions.js";
import type { HttpSession } from "@apicc/core";
import { ExecutionLedger, type ExecutionFact } from "./ledger.js";
import type { ArchiveReceipt } from "./outbox.js";
export interface SettledExecution { executionId: string; verdict: string; pid?: number; output?: InvocationOutput; reasonCode?: string; executionFact?: ExecutionFact }
export interface SupervisorOptions {
  dataDirectory?: string;
  serverId: string; agentId: string; sessionId: string; runtimeCompatibilityId: string;
  identity: BuildIdentity; config: AgentConfig; configVersion: string;
  transport: AgentControlTransport;
  loadInputs(task: TaskDeliveryV1["task"], signal: AbortSignal): Promise<ExecutionInputs>;
  loadMaterials(task: TaskDeliveryV1["task"], signal: AbortSignal): Promise<ProjectRunMaterials>;
  onSettled?(result: SettledExecution): void;
}
interface ActiveCall {
  delivery: TaskDeliveryV1; controller: AbortController; dto?: InvocationDTO; metadata?: PreparedMetadata;
  worker?: TaskWorker; permit?: StartPermit; running: boolean; cancelled: boolean; timedOut: boolean;
  deadline?: ReturnType<typeof setTimeout>; grace?: ReturnType<typeof setTimeout>;
  session?: { session: HttpSession; release(): void };
  admittedAt: number;
  terminal?: boolean;
  settled: Promise<void>; resolveSettled(): void;
}
/** Admission, process resources and persisted report retention have separate lifetimes. */
export class AgentSupervisor {
  private config: AgentConfig;
  private readonly slots: TaskSlots;
  private readonly queue: TaskDeliveryV1[] = [];
  private readonly seen = new Map<string, string>();
  private readonly calls = new Map<string, ActiveCall>();
  private readonly messages = new Map<string, AgentMessageV1>();
  private readonly results = new Map<string, SettledExecution>();
  private shared?: TaskWorker;
  private idle?: ReturnType<typeof setTimeout>;
  private closed = false;
  private version: string;
  private appliedVersion: string;
  private readonly sessions: DebugSessions;
  private readonly ledger: ExecutionLedger;
  private closing?: Promise<void>;
  private readonly controlAbort = new AbortController();
  private readonly messageRetry = new Map<string, { attempts: number; nextAt: number }>();
  private readonly sending = new Map<string, Promise<void>>();
  constructor(readonly options: SupervisorOptions) {
    this.config = validateAgentConfig(options.config); this.slots = new TaskSlots(this.config); this.version = options.configVersion; this.appliedVersion = options.configVersion; this.sessions = new DebugSessions(options.serverId, options.agentId, options.sessionId);
    this.ledger = new ExecutionLedger(options.dataDirectory, options.serverId, options.agentId, this.config);
    try { this.ledger.recover(); } catch (error) { this.ledger.close(); throw error; }
    for (const intent of this.ledger.intents) { this.seen.set(intent.executionId, intent.deliveryId); if (intent.result) { this.results.set(intent.executionId, intent.result); this.slots.restoreResult(intent.executionId, intent.resultBudget || MIN_FAULT_REPORT_BYTES, !intent.resultBudget); } }
    for (const message of this.ledger.messages) this.messages.set(message.messageId, message);
  }
  receive(raw: TaskDeliveryV1): boolean {
    const checked = TaskDeliveryV1Schema.safeParse(raw); if (!checked.success || this.closed) return false;
    const delivery = checked.data; const key = delivery.task.executionId;
    if (this.seen.has(key)) return true;
    if (!this.slots.canReserveResult() || !this.ledger.diskAvailable(this.slots.committedInput() + this.slots.committedResult())) return false;
    this.ledger.accept(delivery); this.seen.set(key, delivery.messageId); this.queue.push(delivery); this.pump(); return true;
  }
  rejectMalformedDelivery(raw: unknown): void {
    if (this.closed || !this.slots.canReserveResult()) return;
    if (!raw || typeof raw !== "object" || !("task" in raw) || !("messageId" in raw) || !raw.task || typeof raw.task !== "object" || !("jobId" in raw.task) || !("executionId" in raw.task)) return;
    const executionId = EntityIdSchema.safeParse(raw.task.executionId), jobId = EntityIdSchema.safeParse(raw.task.jobId), messageId = OpaqueIdSchema.safeParse(raw.messageId);
    if (!executionId.success || !jobId.success || !messageId.success || this.seen.has(executionId.data)) return;
    this.ledger.accept({ messageId: messageId.data, task: { executionId: executionId.data, jobId: jobId.data } } as TaskDeliveryV1);
    this.seen.set(executionId.data, messageId.data);
    const result = { executionId: executionId.data, verdict: "rejected", reasonCode: "invalid-task-definition" };
    const saved = this.ledger.settle(executionId.data, result); this.results.set(executionId.data, saved.result); this.slots.restoreResult(executionId.data, MIN_FAULT_REPORT_BYTES, true); this.options.onSettled?.(saved.result); void this.emit(saved.message);
  }
  private pump(): void {
    if (this.closed) return;
    while (this.queue.length) {
      const delivery = this.queue[0]!; if (!this.ledger.diskAvailable(this.slots.committedInput() + this.slots.committedResult()) || !this.slots.reserve(delivery.task.executionId)) break;
      this.queue.shift();
      const call = this.createCall(delivery);
      this.calls.set(delivery.task.executionId, call);
      this.armDeadline(call, this.config.transferTimeoutMs);
      void this.prepare(call);
    }
  }
  private createCall(delivery: TaskDeliveryV1): ActiveCall { let resolveSettled!: () => void; const settled = new Promise<void>(resolve => { resolveSettled = resolve; }); return { delivery, controller: new AbortController(), running: false, cancelled: false, timedOut: false, admittedAt: performance.now(), settled, resolveSettled }; }
  private armDeadline(call: ActiveCall, duration: number): void {
    clearTimeout(call.deadline); const deadline = call.admittedAt + duration;
    const tick = () => { const left = deadline - performance.now(); if (left <= 0) { call.timedOut = true; this.cancel(call); } else call.deadline = setTimeout(tick, Math.min(left, 2147483647)); };
    tick();
  }
  private async prepare(call: ActiveCall): Promise<void> {
    const task = call.delivery.task;
    try {
      validateRuntime(task, this.options.identity, this.options.runtimeCompatibilityId);
      await this.emit({ ...this.messageIdentity(call, "accepted"), kind: "accepted" });
      const [inputs, materials] = await Promise.all([this.options.loadInputs(task, call.controller.signal), this.options.loadMaterials(task, call.controller.signal)]);
      if (call.controller.signal.aborted) throw new Error("Preparation cancelled");
      const duration = inputs.runConfig.jobTimeoutMs ?? inputs.policy.defaultJobTimeoutMs;
      if (duration > inputs.policy.maxJobTimeoutMs) rejectPreparation("policy-mismatch");
      // Preparation/startup is charged to the same deadline; adjusting the known duration
      // retains time spent before the fixed input arrived.
      this.armDeadline(call, duration);
      const dto: InvocationDTO = { task, inputs, materials, serverId: this.options.serverId, minFreeDiskBytes: this.config.minFreeDiskBytes, runtimeCompatibilityId: this.options.runtimeCompatibilityId };
      call.session = await this.sessions.acquire(task, inputs, this.config);
      if (this.config.workerUnresponsiveAfterMs <= inputs.policy.maxScriptTimeoutMs + this.config.workerHeartbeatIntervalMs) rejectPreparation("policy-mismatch");
      const metadata = await withInvocation(dto, call.controller.signal, async value => value, call.session?.session, this.config.minFreeDiskBytes, bytes => { this.slots.resources(task.executionId, bytes, inputs.policy.reportBytes); this.ledger.reserve(task.executionId, inputs.policy.reportBytes); return this.slots.committedInputExcept(task.executionId); });
      dto.minFreeDiskBytes = this.config.minFreeDiskBytes + this.slots.committedInputExcept(task.executionId);
      const kind = selectDispatch(metadata.project, task, this.config);
      if (!this.slots.dispatch(task.executionId, kind)) rejectPreparation("shared-debug-capacity-exceeded");
      call.dto = dto; call.metadata = metadata;
      await this.emit({ ...this.messageIdentity(call, "start-request"), kind: "start-request", inputsDigest: inputs.inputsDigest, policyVersion: task.policyVersion, scriptPlanDigest: metadata.project.scriptPlanDigest, scriptRequirements: [...metadata.project.scriptRequirements], executionProfile: task.executionProfile, runtimeCompatibilityId: task.runtimeCompatibilityId, credentialVersions: { ...metadata.credentialVersions }, ...(task.scriptGrantVersion ? { scriptGrantVersion: task.scriptGrantVersion } : {}) });
    } catch (error) { await this.finish(call, { executionId: task.executionId, verdict: call.timedOut ? "timed-out" : call.cancelled ? "cancelled" : "rejected", reasonCode: preparationReason(error) }); }
  }
  command(raw: AgentCommandV1): false | void {
    const checked = AgentCommandV1Schema.safeParse(raw); if (!checked.success) return false;
    const command = checked.data;
    if (command.kind === 'start-rejected' && !this.ledger.intents.some(intent => intent.executionId === command.executionId && intent.jobId === command.jobId)) return false;
    this.ledger.command(command);
    if (command.kind === "apply-config") { this.applyConfig(command.config, command.configVersion); return; }
    const call = this.calls.get(command.executionId);
    if (!call || call.delivery.task.jobId !== command.jobId) {
      if (command.kind === "cancel") {
        const index = this.queue.findIndex(item => item.task.executionId === command.executionId && item.task.jobId === command.jobId);
        if (index >= 0) { const [delivery] = this.queue.splice(index, 1); const queued = this.createCall(delivery!); queued.cancelled = true; void this.finish(queued, { executionId: command.executionId, verdict: "cancelled" }); }
      }
      return;
    }
    if (command.kind === "cancel") { call.cancelled = true; this.cancel(call); return; }
    if (command.kind === "start-rejected") {
      if (call.running || call.permit) return;
      call.controller.abort(new Error('start-rejected'));
      void this.finish(call, { executionId: command.executionId, verdict: 'rejected', reasonCode: command.reasonCode });
      return;
    }
    if (call.running || call.permit || !call.dto || !call.metadata || call.controller.signal.aborted) return;
    try { validatePermit(call.dto, call.metadata, command); call.permit = command; }
    catch { void this.finish(call, { executionId: command.executionId, verdict: "rejected", reasonCode: "permit-mismatch" }); return; }
    void this.run(call);
  }
  private async sharedWorker(): Promise<TaskWorker> {
    clearTimeout(this.idle);
    while (this.shared?.retiring || this.shared && this.shared.heapMiB !== this.config.childMaxOldSpaceMiB) {
      const old = this.shared; await old.whenIdle(); await old.retire();
      if (this.shared === old) this.shared = undefined;
    }
    if (!this.shared) {
      const worker = new TaskWorker(this.config, true, this.options.identity, this.ledger.childLease); this.shared = worker;
      void worker.exited.then(() => { if (this.shared === worker) this.shared = undefined; if (!this.shared || this.shared.heapMiB === this.config.childMaxOldSpaceMiB) this.appliedVersion = this.version; });
    }
    return this.shared;
  }
  private async run(call: ActiveCall): Promise<void> {
    const task = call.delivery.task; call.running = true;
    try {
      const worker = task.dispatchKind === "shared-debug" ? await this.sharedWorker() : new TaskWorker(this.config, false, this.options.identity, this.ledger.childLease);
      call.worker = worker; await worker.ready;
      if (call.controller.signal.aborted) { if (!worker.shared) await worker.retire(); throw new Error("Invocation cancelled before execution"); }
      await this.emit({ ...this.messageIdentity(call, "started"), kind: "started", permitId: call.permit!.permitId, startedAt: new Date().toISOString() });
      call.controller.signal.throwIfAborted();
      this.ledger.mark(task.executionId, "uncertain");
      const result = await worker.run(call.dto!, call.permit!, call.session?.session, call.controller.signal, () => this.ledger.mark(task.executionId, "started"));
      if (!worker.shared) await worker.exited;
      const verdict = result.interrupted ? call.timedOut ? "timed-out" : "interrupted" : call.timedOut ? "timed-out" : call.cancelled ? "cancelled" : result.output ? outputPassed(result.output) ? "passed" : "failed" : "rejected";
      await this.finish(call, { executionId: task.executionId, verdict, pid: result.pid, output: result.output, ...(result.error ? { reasonCode: result.interrupted ? "worker-exited" : result.reasonCode ?? "worker-rejected" } : {}) });
    } catch { if (call.worker && !call.worker.shared) await call.worker.retire(); await this.finish(call, { executionId: task.executionId, verdict: call.timedOut ? "timed-out" : call.cancelled ? "cancelled" : "interrupted", pid: call.worker?.pid, reasonCode: "worker-unavailable" }); }
  }
  private cancel(call: ActiveCall): void {
    call.controller.abort(new Error(call.timedOut ? "Local job deadline" : "Invocation cancelled"));
    if (call.worker) {
      call.worker.cancel(call.delivery.task.executionId);
      call.grace ??= setTimeout(() => { call.worker?.terminate(); }, call.permit?.effectivePolicy.cancelGraceMs ?? call.dto!.inputs.policy.cancelGraceMs);
    } else if (!call.running && call.dto) void this.finish(call, { executionId: call.delivery.task.executionId, verdict: call.timedOut ? "timed-out" : "cancelled" });
  }
  private async finish(call: ActiveCall, result: SettledExecution): Promise<void> {
    if (call.terminal) return; call.terminal = true;
    if (this.calls.get(result.executionId) !== call && !call.cancelled) return;
    clearTimeout(call.deadline); clearTimeout(call.grace);
    this.calls.delete(result.executionId); this.slots.release(result.executionId);
    call.session?.release(); call.session = undefined;
    call.dto = undefined; call.metadata = undefined;
    try {
      const saved = this.ledger.settle(result.executionId, result);
      this.results.set(result.executionId, saved.result); const budget = this.ledger.intents.find(item => item.executionId === result.executionId)!.resultBudget; this.slots.restoreResult(result.executionId, budget || MIN_FAULT_REPORT_BYTES, !budget); this.options.onSettled?.(saved.result);
      await this.emit(saved.message);
    } finally { call.resolveSettled(); this.scheduleIdle(); this.pump(); }
  }
  private scheduleIdle(): void {
    clearTimeout(this.idle); const worker = this.shared;
    if (!worker || worker.inFlight || [...this.calls.values()].some(call => call.delivery.task.dispatchKind === "shared-debug")) return;
    if (worker.heapMiB !== this.config.childMaxOldSpaceMiB) { void worker.whenIdle().then(() => worker.retire()); return; }
    this.idle = setTimeout(() => { if (this.shared === worker && !worker.inFlight) void worker.retire(); }, this.config.sharedDebugIdleMs);
  }
  private messageIdentity(call: ActiveCall, kind: string) { return { messageId: `${kind}-${call.delivery.task.executionId}`, jobId: call.delivery.task.jobId, executionId: call.delivery.task.executionId }; }
  private async emit(message: AgentMessageV1): Promise<void> {
    this.ledger.enqueue(message); this.messages.set(message.messageId, message);
    await this.sendMessage(message, this.controlAbort.signal);
  }
  private async sendMessage(message: AgentMessageV1, signal: AbortSignal): Promise<void> {
    const active = this.sending.get(message.messageId); if (active) return active;
    const retry = this.messageRetry.get(message.messageId); if (signal.aborted || retry && retry.nextAt > performance.now()) return;
    const operation = (async () => {
      try {
        const result = await this.options.transport.send([message], signal);
        if (!result.acknowledged.includes(message.messageId)) throw new Error("Message remains unconfirmed");
        this.ledger.acknowledge([message.messageId]); this.messages.delete(message.messageId); this.messageRetry.delete(message.messageId);
      } catch {
        const attempts = (retry?.attempts ?? 0) + 1;
        this.messageRetry.set(message.messageId, { attempts, nextAt: performance.now() + Math.min(this.config.reconnectMaxMs, this.config.reconnectMinMs * 2 ** Math.min(attempts - 1, 30)) });
      }
    })();
    this.sending.set(message.messageId, operation);
    try { await operation; } finally { this.sending.delete(message.messageId); }
  }
  async flushMessages(signal: AbortSignal): Promise<void> { for (const message of [...this.messages.values()]) { if (signal.aborted) return; if (!this.sending.has(message.messageId)) await this.sendMessage(message, signal); } }
  pendingResults(): readonly SettledExecution[] { return [...this.results.values()]; }
  pendingReports() { return this.ledger.reports; }
  acknowledgeReport(executionId: string, receipt?: ArchiveReceipt): void { if (!receipt || !this.ledger.archive(executionId, receipt)) return; this.results.delete(executionId); this.slots.archiveResult(executionId); this.pump(); }
  applyConfig(config: AgentConfig, version: string): void { this.config = validateAgentConfig(config); this.ledger.configure(this.config); this.version = version; if (!this.shared || this.shared.heapMiB === config.childMaxOldSpaceMiB) this.appliedVersion = version; this.slots.configure(this.config); for (const worker of new Set([...this.calls.values()].flatMap(call => call.worker ? [call.worker] : []))) worker.configure(this.config); this.shared?.configure(this.config); this.scheduleIdle(); this.pump(); }
  get appliedConfigVersion(): string { return this.configurationState().appliedConfigVersion; }
  configurationState() { const pending = !!this.shared && this.shared.heapMiB !== this.config.childMaxOldSpaceMiB; return { configVersion: this.version, appliedConfigVersion: pending ? this.appliedVersion : this.version, pendingFields: pending ? ["childMaxOldSpaceMiB" as const] : [], restartRequiredFields: [] as (keyof AgentConfig)[], status: pending ? "pending" as const : "applied" as const }; }
  get currentConfig(): AgentConfig { return this.config; }
  capacity() { return this.closed || !this.ledger.diskAvailable(this.slots.committedInput() + this.slots.committedResult()) ? { availableSlots: 0, availableSharedDebugSlots: 0 } : this.slots.capacity(); }
  processState(): { sharedPid?: number; dedicatedPids: number[] } { return { sharedPid: this.shared?.pid, dedicatedPids: [...new Set([...this.calls.values()].flatMap(call => call.worker && !call.worker.shared && call.worker.pid ? [call.worker.pid] : []))] }; }
  close(): Promise<void> { return this.closing ??= this.shutdown(); }
  private async shutdown(): Promise<void> {
    this.closed = true; clearTimeout(this.idle); this.controlAbort.abort();
    for (const delivery of this.queue.splice(0)) { const call = this.createCall(delivery); call.cancelled = true; this.calls.set(delivery.task.executionId, call); await this.finish(call, { executionId: delivery.task.executionId, verdict: "cancelled" }); }
    const calls = [...this.calls.values()];
    for (const call of this.calls.values()) { call.cancelled = true; this.cancel(call); }
    await Promise.all(calls.map(call => call.settled));
    const workers = new Set(calls.flatMap(call => call.worker ? [call.worker] : [])); if (this.shared) workers.add(this.shared);
    await Promise.all([...workers].map(worker => worker.retire())); await this.sessions.close(); this.ledger.close();
  }
}
function outputPassed(output: InvocationOutput): boolean {
  if (output.kind === "debug") return !output.result.error && !output.result.failureKind && output.result.run.failed === 0;
  if (output.kind === "suite") return !output.result.reportFailure && (output.result.suite ? output.result.suite.verdict === "passed" : reportingUnits(output.result).summary.failed === 0);
  return output.kind === "workflow" && output.result.verdict === "passed";
}

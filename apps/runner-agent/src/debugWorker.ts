import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import type { AgentConfig } from "@apicc/execution/contract";
import type { BuildIdentity } from "@apicc/execution/buildIdentity";
import type { InvocationOutput } from "@apicc/execution/host";
import type { HttpSession, StressProgress } from "@apicc/core";
import { equal, type InvocationDTO, type StartPermit } from "./invocationContext.js";
import type { ChildLease, ExecutionProcess, ExecutionProcessIntent } from "./ledger.js";
import { readProcessIdentity,sameProcessIdentity, type NativeProcessIdentity } from "./processIdentity.js";
import { confirmStressProcessTreeExited } from "./stressProcessTree.js";

type WorkerReply = { generation: string; kind: string; executionId?: string; scope?: unknown; processId?: string; workerId?: string; runId?: string; epoch?: string; pid?: number; code?: number | null; signal?: string | null; progress?: StressProgress; output?: InvocationOutput; error?: string; reasonCode?: "result-capacity-exceeded"; identity?: BuildIdentity; nodeVersion?: string; v8Version?: string; requestId?: string; operation?: string; sessionHandle?: string; args?: unknown[] };
export interface StressProcessOwner { task: InvocationDTO["task"]; record(value: ExecutionProcess): void; recordIntent(value: ExecutionProcessIntent): void }
export interface WorkerResult { output?: InvocationOutput; error?: string; reasonCode?: "result-capacity-exceeded"; pid: number; interrupted?: boolean }
export class ProcessRecordFailure extends Error { constructor() { super("Execution process record could not be persisted"); } }
interface Pending { dto: InvocationDTO; session?: HttpSession; forks: Map<string, HttpSession>; started?(): void; progress?(value: StressProgress): void; disposeAbort(): void; resolve(value: WorkerResult): void }
/** One independent Node process. Only business DTOs and per-call material cross this channel. */
export class TaskWorker {
  readonly heapMiB: number;
  readonly generation = randomUUID();
  readonly child: ChildProcess;
  readonly ready: Promise<void>;
  readonly exited: Promise<void>;
  private readonly pending = new Map<string, Pending>();
  private lastBeat = performance.now();
  private stopping = false;
  private confirmedExit = false;
  private supervision?: ReturnType<typeof setInterval>;
  private startup?: ReturnType<typeof setTimeout>;
  private config: AgentConfig;
  private readonly idleWaiters: Array<() => void> = [];
  private readonly descendants = new Map<string, { record: ExecutionProcess; identity?: NativeProcessIdentity }>();
  private readonly registrations = new Set<Promise<void>>();
  private processEvents=Promise.resolve();
  private readonly spawnIntents = new Map<string, ExecutionProcessIntent>();
  private processRecordingFailure?: ProcessRecordFailure;
  constructor(config: AgentConfig, readonly shared: boolean, identity: BuildIdentity, lease?: ChildLease, private readonly stressOwner?: StressProcessOwner) {
    this.config = config; this.heapMiB = config.childMaxOldSpaceMiB;
    const inherited = Object.fromEntries(["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "LANG", "TZ"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]!]));
    const rootIntent: ExecutionProcessIntent | undefined = stressOwner && { id: `${this.generation}/coordinator`, runId: this.generation, workerId: "coordinator", role: "coordinator", scope: stressOwner.task.scope, epoch: lease?.epoch ?? this.generation, scriptPath: fileURLToPath(new URL("../dist/taskChild.js", import.meta.url)) };
    if (rootIntent) stressOwner!.recordIntent(rootIntent);
    this.child = fork(new URL("../dist/taskChild.js", import.meta.url), rootIntent ? [this.generation, "coordinator"] : [], { execPath: process.execPath, execArgv: [`--max-old-space-size=${config.childMaxOldSpaceMiB}`], detached: false, env: inherited, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced" });
    const rootRecord: ExecutionProcess | undefined = rootIntent && { id: rootIntent.id, name: "stress coordinator", role: "coordinator", pid: this.child.pid!, scope: rootIntent.scope, epoch: rootIntent.epoch, exited: false };
    let readyResolve!: () => void; let readyReject!: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    void this.ready.catch(() => undefined);
    this.exited = new Promise<void>(resolve => this.child.once("exit", async (code, signal) => {
      this.confirmedExit = true; this.stopping = true; clearTimeout(this.startup); clearInterval(this.supervision);
      // Native root exit is already a fact; resource release still awaits the complete subtree below.
      try { if (rootRecord) stressOwner!.record({ ...rootRecord, exited: true, code, signal }); }
      catch { this.processRecordingFailure ??= new ProcessRecordFailure(); readyReject(this.processRecordingFailure); }
      await Promise.allSettled([...this.registrations]);
      // Exit is a resource fact: an IPC result alone cannot release this subtree.
      await confirmStressProcessTreeExited(this.spawnIntents.values(), this.descendants, value => this.stressOwner!.record(value));
      readyReject(new Error("Execution worker exited before initialization"));
      const pendingCalls = [...this.pending.values()];
      await Promise.allSettled(pendingCalls.flatMap(pending => [...pending.forks.values()].map(fork => fork.close())));
      for (const pending of pendingCalls) { pending.disposeAbort(); pending.resolve({ pid: this.child.pid!, interrupted: true, error: "Execution worker exited" }); }
      this.pending.clear(); for (const waiter of this.idleWaiters.splice(0)) waiter(); resolve();
    }));
    this.child.on("error", error => { readyReject(error); this.terminate(); });
    this.child.on("message", (raw: WorkerReply) => {
      if (!raw || raw.generation !== this.generation || this.confirmedExit) return;
      if (raw.kind === "ready") {
        if (raw.identity?.coreBuildId !== identity.coreBuildId || raw.identity.scriptApiId !== identity.scriptApiId || raw.nodeVersion !== process.versions.node || raw.v8Version !== process.versions.v8) { readyReject(new Error("Child runtime identity mismatch")); this.terminate(); return; }
        clearTimeout(this.startup); this.lastBeat = performance.now(); readyResolve();
      } else if (raw.kind === "heartbeat") this.lastBeat = performance.now();
      else if (raw.kind === "session" && raw.executionId) void this.sessionRequest(raw);
      else if (raw.kind === "stress-process-intent" && raw.executionId) { try { this.registerSpawnIntent(raw, lease); } catch { this.terminate(); } }
      else if (raw.kind === "stress-process" && raw.executionId) {
        this.queueProcessEvent(()=>this.registerDescendant(raw,lease));
      }
      else if (raw.kind === "stress-process-exit" && raw.executionId) {
        this.queueProcessEvent(()=>this.recordDescendantExit(raw));
      }
      else if (raw.kind === "stress-progress" && raw.executionId) { const call = this.pending.get(raw.executionId); if (call?.dto.task.target.kind === "stress" && equal(raw.scope, call.dto.task.scope) && raw.progress) call.progress?.(raw.progress); }
      else if (raw.kind === "execution-started" && raw.executionId) { const call = this.pending.get(raw.executionId); if (call && equal(raw.scope, call.dto.task.scope)) { try { call.started?.(); } catch { this.terminate(); } } }
      else if (raw.kind === "done" && raw.executionId) {
        const call = this.pending.get(raw.executionId);
        if (!call || !equal(raw.scope, call.dto.task.scope)) return;
        void (async () => { for (const fork of call.forks.values()) await fork.close(); call.forks.clear(); if (this.pending.get(raw.executionId!) !== call) return; this.pending.delete(raw.executionId!); call.disposeAbort(); call.resolve({ output: raw.output, error: raw.error, ...(raw.reasonCode === "result-capacity-exceeded" ? { reasonCode: raw.reasonCode } : {}), pid: this.child.pid! }); if (!this.pending.size) for (const waiter of this.idleWaiters.splice(0)) waiter(); })();
      }
    });
    // From fork onward all cleanup/exit observers exist before a fallible durable write.
    // A failure rejects readiness but returns this owned handle so the caller can await actual exit.
    try { if (rootRecord) stressOwner!.record(rootRecord); }
    catch { this.processRecordingFailure = new ProcessRecordFailure(); readyReject(this.processRecordingFailure); this.terminate(); return; }
    this.startup = setTimeout(() => { readyReject(new Error("Execution worker startup deadline")); this.terminate(); }, config.workerStartupTimeoutMs);
    this.configure(config);
    this.send({ kind: "initialize", shared, generation: this.generation, heartbeatIntervalMs: config.workerHeartbeatIntervalMs, ...(lease ? { lease } : {}) });
  }
  throwIfProcessRecordingFailed(): void { if (this.processRecordingFailure) throw this.processRecordingFailure; }
  private queueProcessEvent(action:()=>Promise<void>):void {
    let event!:Promise<void>;event=this.processEvents.then(action).catch(()=>{this.terminate();}).finally(()=>this.registrations.delete(event));
    this.processEvents=event;this.registrations.add(event);
  }
  private async recordDescendantExit(raw:WorkerReply):Promise<void>{
    const entry=raw.processId&&this.descendants.get(raw.processId),owner=this.stressOwner;
    if(!entry||!owner||raw.pid!==entry.record.pid||!equal(raw.scope,entry.record.scope)||raw.epoch!==entry.record.epoch||entry.record.exited)return;
    entry.record.code=raw.code;entry.record.signal=raw.signal;
    let current:NativeProcessIdentity|undefined;
    try{current=await readProcessIdentity(entry.record.pid);}catch{entry.record.observationUncertain=true;owner.record(entry.record);return;}
    // Notification is only a trigger. Only absence or proof that the recorded birth was replaced confirms exit.
    if(!current||entry.identity&&!sameProcessIdentity(entry.identity,current)||entry.record.birth&&entry.record.birth!==current.birth){entry.record={...entry.record,exited:true};owner.record(entry.record);}
  }
  private registerSpawnIntent(raw: WorkerReply, lease?: ChildLease): void {
    const call = raw.executionId && this.pending.get(raw.executionId);
    if (!call || !this.stressOwner || call.dto.task.target.kind !== "stress" || !equal(raw.scope, call.dto.task.scope) || raw.epoch !== (lease?.epoch ?? this.generation) || !raw.runId || !/^[0-9a-f-]{36}$/.test(raw.runId) || !raw.workerId || !/^worker-[1-9]\d*$/.test(raw.workerId) || raw.processId !== `${raw.runId}/${raw.workerId}` || Number(raw.workerId.slice(7)) > call.dto.inputs.runConfig.stress!.workerCount || this.spawnIntents.has(raw.processId)) throw new Error("Invalid fixed worker spawn intent");
    const intent: ExecutionProcessIntent = { id: raw.processId, runId: raw.runId, workerId: raw.workerId, role: "worker", scope: call.dto.task.scope, epoch: raw.epoch, scriptPath: fileURLToPath(new URL("../dist/stressWorkerChild.js", import.meta.url)) };
    this.stressOwner.recordIntent(intent); this.spawnIntents.set(intent.id, intent);
    this.send({ kind: "stress-process-intent-registered", generation: this.generation, executionId: raw.executionId, scope: raw.scope, processId: raw.processId });
  }
  private async registerDescendant(raw: WorkerReply, lease?: ChildLease): Promise<void> {
    const call = raw.executionId && this.pending.get(raw.executionId), owner = this.stressOwner;
    if (!call || !owner || call.dto.task.target.kind !== "stress" || !equal(raw.scope, call.dto.task.scope) || raw.epoch !== (lease?.epoch ?? this.generation) || !Number.isSafeInteger(raw.pid) || raw.pid! <= 0 || !raw.workerId || !raw.runId || raw.processId !== `${raw.runId}/${raw.workerId}`) throw new Error("Invalid stress process registration");
    if (!this.spawnIntents.has(raw.processId) || this.descendants.has(raw.processId) || this.descendants.size >= call.dto.inputs.runConfig.stress!.workerCount) throw new Error("Unexpected stress process topology");
    const record: ExecutionProcess = { id: raw.processId, name: `stress worker ${raw.workerId}`, role: "worker", pid: raw.pid!, scope: call.dto.task.scope, epoch: raw.epoch, exited: false };
    const entry: { record: ExecutionProcess; identity?: NativeProcessIdentity } = { record }; this.descendants.set(record.id, entry);
    const actual = await readProcessIdentity(record.pid);
    if (!actual || actual.parentPid !== this.child.pid || actual.executable.toLowerCase() !== process.execPath.toLowerCase() || !actual.commandLine.includes("stressWorkerChild.js") || !actual.commandLine.includes(raw.runId) || !actual.commandLine.includes(raw.workerId)) throw new Error("Stress child OS identity unavailable");
    entry.identity = actual; record.birth = actual.birth; owner.record(record);
    if (this.confirmedExit) return;
    this.send({ kind: "stress-process-registered", generation: this.generation, executionId: raw.executionId, scope: raw.scope, processId: raw.processId });
  }
  configure(config: AgentConfig): void {
    this.config = config; clearInterval(this.supervision);
    this.supervision = setInterval(() => { if (performance.now() - this.lastBeat >= this.config.workerUnresponsiveAfterMs) this.terminate(); }, config.workerHeartbeatIntervalMs);
    this.send({ kind: "configure", generation: this.generation, heartbeatIntervalMs: config.workerHeartbeatIntervalMs });
  }
  get pid(): number | undefined { return this.confirmedExit ? undefined : this.child.pid; }
  get inFlight(): number { return this.pending.size; }
  get retiring(): boolean { return this.stopping; }
  whenIdle(): Promise<void> { return this.pending.size ? new Promise(resolve => this.idleWaiters.push(resolve)) : Promise.resolve(); }
  async run(dto: InvocationDTO, permit: StartPermit, session?: HttpSession, signal?: AbortSignal, started?: () => void, progress?: (value: StressProgress) => void): Promise<WorkerResult> {
    await this.ready;
    signal?.throwIfAborted();
    if (this.stopping || this.pending.has(dto.task.executionId)) throw new Error("Worker is retiring or execution is duplicate");
    if (this.shared && (dto.task.target.kind !== "debug" || dto.task.executionProfile !== "no-script")) throw new Error("Shared worker accepts only no-script debug");
    // No await between the final abort check, pending registration, listener and invoke.
    // Later aborts are ordered after invoke on this same IPC channel, for this call only.
    const abort = () => this.cancel(dto.task.executionId);
    const result = new Promise<WorkerResult>(resolve => this.pending.set(dto.task.executionId, { dto, session, started, progress, forks: new Map(), disposeAbort: () => signal?.removeEventListener("abort", abort), resolve }));
    signal?.addEventListener("abort", abort, { once: true });
    this.send({ kind: "invoke", generation: this.generation, executionId: dto.task.executionId, scope: dto.task.scope, dto, permit });
    return result;
  }
  cancel(executionId: string): void { const call = this.pending.get(executionId); if (call) this.send({ kind: "cancel", generation: this.generation, executionId, scope: call.dto.task.scope }); }
  private async sessionRequest(message: WorkerReply): Promise<void> {
    const call = message.executionId && this.pending.get(message.executionId);
    if (!call || !call.session || !equal(message.scope, call.dto.task.scope) || typeof message.requestId !== "string" || !Array.isArray(message.args)) return;
    const session = message.sessionHandle ? call.forks.get(message.sessionHandle) : call.session;
    let value: unknown; let failed = false;
    try {
      if (!session) throw new Error("Unknown session fork");
      switch (message.operation) {
        case "getCookieHeader": if (message.args.length !== 1 || typeof message.args[0] !== "string") throw new Error(); value = await session.getCookieHeader(message.args[0]); break;
        case "storeResponseCookies": {
          const [url, headers] = message.args;
          if (typeof url !== "string" || !Array.isArray(headers) || headers.some(row => !Array.isArray(row) || row.length !== 2 || row.some(value => typeof value !== "string"))) throw new Error();
          await session.storeResponseCookies(url, headers); break;
        }
        case "listCookies": value = await session.listCookies(); break;
        case "clearCookies": await session.clearCookies(); break;
        case "fork": { const id = randomUUID(); call.forks.set(id, await session.fork()); value = id; break; }
        case "close": if (!message.sessionHandle) throw new Error("Borrowed session cannot be closed"); await session.close(); call.forks.delete(message.sessionHandle); break;
        default: throw new Error("Unsupported session operation");
      }
    } catch { failed = true; }
    if (this.pending.get(message.executionId!) === call) this.send({ kind: "session-result", generation: this.generation, executionId: message.executionId, scope: message.scope, requestId: message.requestId, value, failed });
  }
  send(message: object): void { if (this.child.connected) this.child.send(message, error => { if (error && !this.stopping) this.terminate(); }); }
  terminate(): void { if (this.stopping) return; this.stopping = true; this.child.kill("SIGKILL"); }
  async retire(): Promise<void> {
    if (!this.stopping) { this.stopping = true; this.send({ kind: "shutdown", generation: this.generation }); }
    const force = setTimeout(() => this.child.kill("SIGKILL"), this.config.workerStartupTimeoutMs);
    try { await this.exited; } finally { clearTimeout(force); }
  }
}

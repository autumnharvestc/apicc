import { mkdirSync, statfsSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { AgentMessageV1Schema, StartRejectionReasonSchema, MIN_FAULT_REPORT_BYTES, ServerProjectScopeSchema, StressProcessObservationSchema, processObservationFitsBudget, validateAgentConfig, type AgentConfig, type AgentMessageV1, type TaskDeliveryV1,type StressProcessObservation } from "@apicc/execution/contract";
import type { SettledExecution } from "./supervisor.js";
import { LedgerCompactionSchema, type LedgerCompactionOptions } from "./config.js";

export type ExecutionFact = "not-started" | "started" | "uncertain";
export interface ChildLease { file: string; epoch: string }
export interface ExecutionProcess { id: string; name: string; role: "coordinator" | "worker"; pid: number; scope: TaskDeliveryV1["task"]["scope"]; epoch: string; birth?: string; exited: boolean; code?: number | null; signal?: string | null;observationUncertain?:boolean }
export interface ExecutionProcessIntent { id: string; runId: string; workerId: string; role: "coordinator" | "worker"; scope: TaskDeliveryV1["task"]["scope"]; epoch: string; scriptPath: string }
export interface PendingReport { executionId: string; jobId: string; text: string; hash: string; bytes: number }
interface Intent { executionId: string; jobId: string; deliveryId: string; fact: ExecutionFact; resultBudget: number; processBudget?:number;processObservation?:StressProcessObservation;processObservationPartial?:boolean;processIntents?: ExecutionProcessIntent[]; processes?: ExecutionProcess[]; settled?: boolean; archived?: boolean; report?: PendingReport }
interface State { version: 1; serverId: string; agentId: string; intents: Intent[]; messages: AgentMessageV1[]; commands: Array<{ messageId: string; kind: string; executionId?: string; jobId?: string }> }
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const verdicts = new Set(["passed", "failed", "cancelled", "timed-out", "interrupted", "rejected"]);
const stressCapacityReason = "stress-capacity-exceeded";
const reasonCodes = new Set(["runtime-mismatch", "script-admission-denied", "fixed-input-mismatch", "policy-mismatch", "input-capacity-exceeded", "result-capacity-exceeded", "shared-debug-capacity-exceeded", "debug-session-expired", "debug-session-scope-mismatch", "debug-session-capacity-exceeded", "preparation-rejected", "invalid-task-definition", "permit-mismatch", "worker-exited", "worker-rejected", "worker-unavailable", "result-persistence-failed", "agent-restarted-before-start", "agent-restarted-after-start", "execution-start-unconfirmed"]);
const processIdentity = { id: z.string().min(1), role: z.enum(["coordinator", "worker"]), scope: ServerProjectScopeSchema, epoch: z.string().min(1) };
const exitedProcessSchema = z.object({ ...processIdentity, name: z.string().min(1), pid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), birth: z.string().regex(/^[1-9]\d*$/).optional(), exited: z.literal(true), code: z.number().int().nullable().optional(), signal: z.string().min(1).nullable().optional(), observationUncertain: z.literal(false).optional() }).strict();
const spawnIntentSchema = z.object({ ...processIdentity, runId: z.string().uuid(), workerId: z.string().min(1), scriptPath: z.string().min(1) }).strict().refine(value => value.id === `${value.runId}/${value.workerId}` && (value.role === "coordinator" ? value.workerId === "coordinator" : /^worker-[1-9]\d*$/.test(value.workerId)));
interface CompactionPlan { indices: number[]; cursor: number }

function compactable(item: Intent, state: State, pending: ReadonlySet<string>): boolean {
  if (item.settled !== true || item.archived !== true || item.report !== undefined || typeof item.deliveryId !== "string" || !item.deliveryId || pending.has(`execution:${item.executionId}`) || pending.has(`job:${item.jobId}`)) return false;
  if (state.intents.some(other => other !== item && other.executionId === item.executionId)) return false;
  const processes = item.processes, intents = item.processIntents;
  // Empty arrays, missing registrations and unknown legacy shapes do not prove exit.
  if (!Array.isArray(processes) || !processes.length || !Array.isArray(intents) || intents.length !== processes.length) return false;
  if (processes.some(record => !exitedProcessSchema.safeParse(record).success) || intents.some(intent => !spawnIntentSchema.safeParse(intent).success)) return false;
  if (item.processBudget !== undefined && (!Number.isSafeInteger(item.processBudget) || item.processBudget < processes.length || item.processBudget > 1001)) return false;
  if (item.processObservationPartial !== undefined && typeof item.processObservationPartial !== "boolean") return false;
  if (item.processObservation !== undefined && (!StressProcessObservationSchema.safeParse(item.processObservation).success || item.processObservation.started !== processes.length || item.processObservation.exited !== processes.length || item.processBudget !== undefined && !processObservationFitsBudget(item.processObservation, item.processBudget))) return false;
  const byId = new Map(processes.map(record => [record.id, record]));
  if (byId.size !== processes.length || new Set(intents.map(intent => intent.id)).size !== intents.length) return false;
  return intents.every(intent => {
    const record = byId.get(intent.id);
    return record && record.role === intent.role && record.epoch === intent.epoch && record.scope.workspaceId === intent.scope.workspaceId && record.scope.groupId === intent.scope.groupId && record.scope.projectId === intent.scope.projectId;
  });
}
/** Only execution facts and already projected output enter this store. No executable inputs. */
export class ExecutionLedger {
  private state: State;
  private readonly file?: string;
  private database?: DatabaseSync;
  private owner?: DatabaseSync;
  readonly childLease?: ChildLease;
  private failed = false;
  private closed = false;
  private compactionCursor = 0;
  private readonly compaction: LedgerCompactionOptions;
  constructor(directory: string | undefined, serverId: string, agentId: string, private config: AgentConfig, compaction?: LedgerCompactionOptions) {
    this.config = validateAgentConfig(config);
    this.compaction = LedgerCompactionSchema.parse(compaction ?? {});
    this.state = { version: 1, serverId, agentId, intents: [], messages: [], commands: [] };
    if (!directory) return;
    mkdirSync(directory, { recursive: true, mode: 0o700 }); this.file = join(directory, "execution-ledger.sqlite");
    try {
      this.owner = new DatabaseSync(join(directory, "execution-owner.sqlite")); this.owner.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner (id INTEGER)");
      this.database = new DatabaseSync(this.file); this.database.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY CHECK(id=1), state TEXT NOT NULL)");
      const row = this.database.prepare("SELECT state FROM ledger WHERE id=1").get() as { state: string } | undefined;
      if (row) {
      const saved = JSON.parse(row.state) as State;
      if (saved.version !== 1 || saved.serverId !== serverId || saved.agentId !== agentId || !Array.isArray(saved.intents) || !Array.isArray(saved.messages) || !Array.isArray(saved.commands)) throw new Error("Ledger identity or format mismatch");
      saved.messages.forEach(value => AgentMessageV1Schema.parse(value));
      for (const item of saved.intents) {
        if (!/^\d+$/.test(item.executionId) || !/^\d+$/.test(item.jobId) || !["not-started", "started", "uncertain"].includes(item.fact) || !Number.isSafeInteger(item.resultBudget) || item.resultBudget < 0) throw new Error("Invalid execution intent");
        if (item.resultBudget > 0 && item.resultBudget < MIN_FAULT_REPORT_BYTES) throw new Error("Persisted fixed report budget is below the supported minimum");
        if (item.report && (item.report.executionId !== item.executionId || item.report.jobId !== item.jobId || hash(item.report.text) !== item.report.hash || Buffer.byteLength(item.report.text) !== item.report.bytes)) throw new Error("Corrupt pending report");
        if (item.report && item.report.bytes > (item.resultBudget || MIN_FAULT_REPORT_BYTES)) throw new Error("Persisted report exceeds its fixed budget");
      }
      this.state = saved;
      } else this.change(() => {});
      const file = join(directory, "execution-children.sqlite"), epoch = randomUUID(), lease = new DatabaseSync(file);
      try {
        // DELETE is essential: WAL readers do not block an EXCLUSIVE writer.
        lease.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS epoch (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)");
        lease.prepare("INSERT INTO epoch(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(epoch); lease.exec("COMMIT");
      } finally { lease.close(); }
      this.childLease = { file, epoch };
    } catch (error) { this.close(); throw error; }
  }
  configure(config: AgentConfig): void { this.config = validateAgentConfig(config); }
  get intents(): readonly Readonly<Intent & { result?: SettledExecution }>[] { return this.state.intents.map(item => ({ ...item, ...(item.report ? { result: JSON.parse(item.report.text) as SettledExecution } : {}) })); }
  get messages(): readonly AgentMessageV1[] { return this.state.messages; }
  get reports(): readonly PendingReport[] { return this.state.intents.flatMap(item => item.report ? [item.report] : []); }
  get healthy(): boolean { return !this.failed; }
  diskAvailable(promised = 0): boolean { if (!this.file || this.failed) return !this.failed; const disk = statfsSync(join(this.file, "..")); return disk.bavail * disk.bsize >= this.config.minFreeDiskBytes + promised; }
  private change(action: (state: State) => void, fault = false): void {
    const next = structuredClone(this.state); action(next);
    if (this.file) {
      const text = JSON.stringify(next);
      const promised = fault ? 0 : next.intents.reduce((sum, item) => sum + (item.settled ? 0 : item.resultBudget), 0);
      try {
        const disk = statfsSync(join(this.file, ".."));
        // Existing files are reflected in bavail; reserve rollback journal and DB growth too.
        const journal = existsSync(this.file) ? statSync(this.file).size : 0;
        if (disk.bavail * disk.bsize < this.config.minFreeDiskBytes + promised + journal + 2 * Buffer.byteLength(text) + 32768) throw new Error("Insufficient ledger disk capacity");
        this.database!.exec("BEGIN IMMEDIATE");
        try { this.database!.prepare("INSERT INTO ledger(id,state) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state").run(text); this.database!.exec("COMMIT"); }
        catch (error) { this.database!.exec("ROLLBACK"); throw error; }
      } catch (error) { this.failed = true; throw error; }
    }
    this.state = next;
  }
  private compactionPlan(state: State, preferred: readonly string[] = []): CompactionPlan {
    const plan: CompactionPlan = { indices: [], cursor: this.compactionCursor };
    if (!this.compaction.enabled || this.closed || this.failed || !state.intents.length) return plan;
    const pending = new Set(state.messages.flatMap(message => [`execution:${message.executionId}`, `job:${message.jobId}`]));
    const examined = new Set<number>(), limit = Math.min(this.compaction.batchSize, state.intents.length);
    const examine = (index: number) => {
      if (index < 0 || examined.has(index) || examined.size === limit) return;
      examined.add(index); if (compactable(state.intents[index]!, state, pending)) plan.indices.push(index);
    };
    for (const id of preferred) { if (examined.size === limit) break; examine(state.intents.findIndex(item => item.executionId === id)); }
    let traversed = 0;
    while (examined.size < limit && traversed++ < state.intents.length) {
      const index = plan.cursor % state.intents.length; plan.cursor = (index + 1) % state.intents.length; examine(index);
    }
    return plan;
  }
  private applyCompaction(state: State, plan: CompactionPlan): void {
    for (const index of plan.indices) { delete state.intents[index]!.processes; delete state.intents[index]!.processIntents; }
  }
  /** One progressive batch; State cloning, indexing and SQLite JSON rewriting still scale with total ledger bytes. */
  compact(): number {
    const plan = this.compactionPlan(this.state);
    if (plan.indices.length) this.change(state => this.applyCompaction(state, plan), true);
    this.compactionCursor = plan.cursor; return plan.indices.length;
  }
  accept(delivery: TaskDeliveryV1): void { if (this.state.intents.some(item => item.executionId === delivery.task.executionId)) return; this.change(state => state.intents.push({ executionId: delivery.task.executionId, jobId: delivery.task.jobId, deliveryId: delivery.messageId, fact: "not-started", resultBudget: 0 })); }
  reserve(executionId: string, resultBudget: number): void { if (!Number.isSafeInteger(resultBudget) || resultBudget < MIN_FAULT_REPORT_BYTES) throw new Error("Fixed report budget cannot hold a complete fault report"); this.change(state => { state.intents.find(item => item.executionId === executionId)!.resultBudget = resultBudget; }); }
  mark(executionId: string, fact: ExecutionFact): void { this.change(state => { const item = state.intents.find(item => item.executionId === executionId)!; if (!item.settled) item.fact = fact; }); }
  observeProcesses(executionId:string,budget:number):void {if(!Number.isSafeInteger(budget)||budget<1||budget>1001)throw Error('Invalid fixed process budget');this.change(state=>{const item=state.intents.find(item=>item.executionId===executionId)!;if(item.processes?.length||item.processBudget!==undefined)throw Error('Process observation must begin before spawn');item.processBudget=budget;});}
  processObservation(executionId:string):StressProcessObservation|undefined {const value=this.state.intents.find(item=>item.executionId===executionId)?.processObservation;return value?{...value}:undefined;}
  recordProcess(executionId: string, record: ExecutionProcess): void {
    this.change(state => { const intent = state.intents.find(item => item.executionId === executionId)!; if (intent.settled) throw new Error("Execution process registered after settlement");
      const records = intent.processes ??= []; const existing = records.find(item => item.id === record.id);const wasExited=existing?.exited;
      if (existing && (existing.pid !== record.pid || existing.epoch !== record.epoch || existing.birth && record.birth && existing.birth !== record.birth)) throw new Error("Execution process identity changed");
      if(record.observationUncertain&&intent.processObservation?.completeness!=='complete'||!existing&&record.role==='worker'&&records.some(item=>item.role==='coordinator'&&item.exited))intent.processObservationPartial=true;
      if (existing) Object.assign(existing, record); else records.push(structuredClone(record));
      if(intent.processBudget!==undefined){
        const previous=intent.processObservation,started=(previous?.started??0)+(existing?0:1),exited=(previous?.exited??0)+(record.exited&&(!existing||!wasExited)?1:0);
        const peak=Math.max(previous?.peak??0,records.filter(item=>!item.exited&&!item.observationUncertain).length);
        const covered=!intent.processObservationPartial&&records.length===intent.processBudget&&records.filter(item=>item.role==='coordinator').length===1&&records.filter(item=>item.role==='worker').length===intent.processBudget-1&&records.every(item=>item.role==='coordinator'||!!item.birth);
        intent.processObservation={completeness:covered?'complete':'partial',started,exited,peak};
      }
    });
  }
  recordProcessIntent(executionId: string, intent: ExecutionProcessIntent): void {
    this.change(state => { const entry = state.intents.find(item => item.executionId === executionId)!; if (entry.settled) throw new Error("Worker intent after settlement");
      const intents = entry.processIntents ??= []; if (intents.some(item => item.id === intent.id)) throw new Error("Duplicate worker spawn intent"); intents.push(structuredClone(intent));
    });
  }
  enqueue(message: AgentMessageV1): void { const previous = this.state.messages.find(item => item.messageId === message.messageId); if (previous) { if (JSON.stringify(previous) !== JSON.stringify(message)) throw new Error("Message identity content conflict"); return; } this.change(state => state.messages.push(AgentMessageV1Schema.parse(message))); }
  command(message: { messageId: string; kind: string; executionId?: string; jobId?: string }): void { const identity = { messageId: message.messageId, kind: message.kind, ...(message.executionId ? { executionId: message.executionId, jobId: message.jobId } : {}) }; if (!this.state.commands.some(item => item.messageId === identity.messageId)) this.change(state => state.commands.push(identity)); }
  acknowledge(ids: readonly string[]): void {
    const acknowledged = new Set(ids), removed = this.state.messages.filter(item => acknowledged.has(item.messageId));
    if (!removed.length) return;
    let plan!: CompactionPlan;
    this.change(state => {
      state.messages = state.messages.filter(item => !acknowledged.has(item.messageId));
      plan = this.compactionPlan(state, [...new Set(removed.map(item => item.executionId))]); this.applyCompaction(state, plan);
    }, true);
    this.compactionCursor = plan.cursor;
  }
  settle(executionId: string, raw: SettledExecution): { result: SettledExecution; message: AgentMessageV1 } {
    const current = this.state.intents.find(item => item.executionId === executionId)!;
    let result: SettledExecution = { executionId: current.executionId, verdict: verdicts.has(raw.verdict) ? raw.verdict : "interrupted", executionFact: current.fact, ...(raw.reasonCode ? { reasonCode: raw.reasonCode === stressCapacityReason || reasonCodes.has(raw.reasonCode) || StartRejectionReasonSchema.safeParse(raw.reasonCode).success ? raw.reasonCode : "preparation-rejected" } : {}), ...(raw.output ? { output: raw.output, ...(Number.isSafeInteger(raw.pid) && raw.pid! > 0 ? { pid: raw.pid } : {}) } : {}) };
    if(current.processObservation)result={...result,processObservation:{...current.processObservation}};
    let text = JSON.stringify(result);
    const limit = current.resultBudget || MIN_FAULT_REPORT_BYTES;
    if (limit < MIN_FAULT_REPORT_BYTES) throw new Error("Persisted fixed budget cannot hold a complete fault report");
    if (Buffer.byteLength(text) > limit) result = { executionId: current.executionId, verdict: result.verdict, executionFact: current.fact, reasonCode: "result-capacity-exceeded" };
    let report: PendingReport, message: AgentMessageV1;
    const commit = (fault: boolean) => {
      if(current.processObservation)result={...result,processObservation:{...current.processObservation}};
      text = JSON.stringify(result); report = { executionId, jobId: current.jobId, text, hash: hash(text), bytes: Buffer.byteLength(text) };
      if (report.bytes > limit) throw new Error("Complete fault report exceeds its fixed budget");
      const evidenceComplete = result.output?.kind === "stress-failure" ? false : result.output?.kind === "stress" ? Object.values(result.output.result.completeness).every(part => part.complete) : result.output !== undefined;
      message = { messageId: `completed-${executionId}`, jobId: current.jobId, executionId, kind: "completed", verdict: result.verdict as Extract<AgentMessageV1, { kind: "completed" }>["verdict"], finishedAt: new Date().toISOString(), executionReleased: true, evidenceComplete, reportHash: report.hash, reportBytes: report.bytes, ...(result.reasonCode ? { reasonCode: result.reasonCode } : {}),...(result.processObservation?{processObservation:result.processObservation}:{}) };
      this.change(state => { const item = state.intents.find(item => item.executionId === executionId)!; item.report = report; item.settled = true; state.messages.push(message); }, fault);
    };
    try { commit(!result.output); }
    catch (error) { if (!result.output) throw error; result = { executionId: current.executionId, verdict: result.verdict, executionFact: current.fact, reasonCode: "result-persistence-failed" }; commit(true); }
    return { result, message: message! };
  }
  recover(): void {
    for (const intent of [...this.state.intents]) if (!intent.settled) this.settle(intent.executionId, { executionId: intent.executionId, verdict: "interrupted", reasonCode: intent.fact === "not-started" ? "agent-restarted-before-start" : intent.fact === "started" ? "agent-restarted-after-start" : "execution-start-unconfirmed" });
  }
  archive(executionId: string, receipt: { archived: boolean; reportHash: string; reportBytes: number }): boolean {
    const item = this.state.intents.find(item => item.executionId === executionId), report = item?.report;
    if (!report || !receipt.archived || receipt.reportHash !== report.hash || receipt.reportBytes !== report.bytes) return false;
    let plan!: CompactionPlan;
    this.change(state => { const entry = state.intents.find(item => item.executionId === executionId)!; entry.archived = true; delete entry.report; plan = this.compactionPlan(state, [executionId]); this.applyCompaction(state, plan); }, true);
    this.compactionCursor = plan.cursor; return true;
  }
  close(): void { this.closed = true; this.database?.close(); this.database = undefined; this.owner?.close(); this.owner = undefined; }
}

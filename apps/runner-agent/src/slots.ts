import { MIN_FAULT_REPORT_BYTES, StressReservationSchema, type StressReservation, type AgentConfig, type DispatchKind } from "@apicc/execution/contract";
import { rejectPreparation } from "./invocationContext.js";

interface Reservation { inputBytes: number; resultBytes: number; kind?: DispatchKind; stress?: StressReservation }
/** Invocation admission is separate from process resources; preparation owns a slot too. */
export class TaskSlots {
  private readonly held = new Map<string, Reservation>();
  private readonly pendingResults = new Map<string, number>();
  private readonly pendingFaults = new Set<string>();
  private nextReportBytes = 1;
  constructor(private config: AgentConfig) {}
  configure(config: AgentConfig): void { this.config = config; }
  reserve(executionId: string, stress?: StressReservation): boolean {
    if (this.held.has(executionId) || !this.capacity().availableSlots) return false;
    if (stress && !this.stressAvailable(executionId, stress)) return false;
    this.held.set(executionId, { inputBytes: 0, resultBytes: 0, ...(stress ? { stress: { ...stress } } : {}) }); return true;
  }
  reserveStress(executionId: string, stress: StressReservation): boolean {
    const entry = this.held.get(executionId); if (!entry || !this.stressAvailable(executionId, stress)) return false;
    entry.stress = { ...stress }; return true;
  }
  private stressAvailable(executionId: string, raw: StressReservation): boolean {
    const checked = StressReservationSchema.safeParse(raw); if (!checked.success) return false;
    const limits: StressReservation = { jobs: this.config.maxConcurrentStressJobs, processes: this.config.maxStressProcesses, vus: this.config.maxStressVus, requestConcurrency: this.config.maxStressRequestConcurrency, maxRps: this.config.maxStressRps, metricMemoryBytes: this.config.maxStressMetricMemoryBytes };
    return (Object.keys(limits) as (keyof StressReservation)[]).every(key => {
      const held = [...this.held.entries()].reduce((sum, [id, entry]) => sum + (id === executionId ? 0 : entry.stress?.[key] ?? 0), 0);
      return checked.data[key] <= limits[key] - held;
    });
  }
  resources(executionId: string, inputBytes: number, resultBytes: number): void {
    const entry = this.held.get(executionId); if (!entry) throw new Error("Missing preparation reservation");
    const totals = [...this.held.values()].reduce((sum, item) => ({ input: sum.input + item.inputBytes, result: sum.result + item.resultBytes }), { input: 0, result: [...this.pendingResults.entries()].reduce((sum, [id, bytes]) => sum + (this.pendingFaults.has(id) ? 0 : bytes), 0) });
    if (!Number.isSafeInteger(inputBytes) || inputBytes < 0 || inputBytes > this.config.inputCacheBytes - totals.input + entry.inputBytes) rejectPreparation("input-capacity-exceeded");
    if (!Number.isSafeInteger(resultBytes) || resultBytes < 0 || resultBytes > this.config.pendingResultBytes - this.config.faultReserveBytes - totals.result + entry.resultBytes) rejectPreparation("result-capacity-exceeded");
    entry.inputBytes = inputBytes; entry.resultBytes = resultBytes;
    this.nextReportBytes = resultBytes;
  }
  dispatch(executionId: string, kind: DispatchKind): boolean {
    const entry = this.held.get(executionId); if (!entry) throw new Error("Missing admission reservation");
    if (kind === "shared-debug" && [...this.held.values()].filter(item => item.kind === kind).length >= this.config.sharedDebugMaxInFlight) return false;
    entry.kind = kind; return true;
  }
  release(executionId: string): boolean { const entry = this.held.get(executionId); if (entry?.resultBytes) this.pendingResults.set(executionId, entry.resultBytes); return this.held.delete(executionId); }
  archiveResult(executionId: string): void { this.pendingResults.delete(executionId); this.pendingFaults.delete(executionId); }
  restoreResult(executionId: string, bytes: number, fault = false): void { this.pendingResults.set(executionId, bytes); if (fault) this.pendingFaults.add(executionId); else this.pendingFaults.delete(executionId); if (!fault) this.nextReportBytes = Math.max(this.nextReportBytes, bytes); }
  committedResult(): number { return [...this.pendingResults.values()].reduce((sum, bytes) => sum + bytes, 0) + [...this.held.values()].reduce((sum, item) => sum + item.resultBytes, 0); }
  committedInput(): number { return [...this.held.values()].reduce((sum, item) => sum + item.inputBytes, 0); }
  private remainingFaultSlots(): number { const pending = [...this.pendingFaults].reduce((sum, id) => sum + this.pendingResults.get(id)!, 0); return Math.max(0, Math.floor((this.config.faultReserveBytes - pending) / MIN_FAULT_REPORT_BYTES) - this.held.size); }
  canReserveResult(): boolean { const committed = this.committedResult() - [...this.pendingFaults].reduce((sum, id) => sum + this.pendingResults.get(id)!, 0); return this.remainingFaultSlots() > 0 && (committed === 0 || committed + this.nextReportBytes <= this.config.pendingResultBytes - this.config.faultReserveBytes); }
  committedInputExcept(executionId: string): number { return [...this.held.entries()].reduce((sum, [id, entry]) => sum + (id === executionId ? 0 : entry.inputBytes), 0); }
  capacity() {
    const availableSlots = !this.canReserveResult() ? 0 : Math.min(this.remainingFaultSlots(), Math.max(0, this.config.maxConcurrentJobs - this.held.size));
    return { availableSlots, availableSharedDebugSlots: Math.min(availableSlots, Math.max(0, this.config.sharedDebugMaxInFlight - [...this.held.values()].filter(entry => entry.kind === "shared-debug").length)) };
  }
}

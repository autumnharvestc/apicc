import type { AgentConfig } from "@apicc/execution/contract";
import type { PendingReport } from "./ledger.js";
function wait(ms: number, signal: AbortSignal): Promise<void> { return new Promise(resolve => { if (signal.aborted) { resolve(); return; } const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }; const timer = setTimeout(done, Math.min(ms, 2147483647)); signal.addEventListener("abort", done, { once: true }); }); }
export interface ArchiveReceipt { archived: boolean; reportHash: string; reportBytes: number }
/** Independent data lane. It retries immutable persisted bytes, never a business invocation. */
export async function runResultOutbox(options: { config(): AgentConfig; reports(): readonly PendingReport[]; upload(report: PendingReport, signal: AbortSignal): Promise<ArchiveReceipt>; acknowledge(executionId: string, receipt: ArchiveReceipt): void }, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    for (const report of options.reports()) {
      for (let attempt = 0; attempt < options.config().transferMaxAttemptsPerCycle && !signal.aborted; attempt++) {
        try { const receipt = await options.upload(report, signal); if (!receipt.archived || receipt.reportHash !== report.hash || receipt.reportBytes !== report.bytes) throw new Error("Archive receipt mismatch"); options.acknowledge(report.executionId, receipt); break; }
        catch { if (attempt + 1 < options.config().transferMaxAttemptsPerCycle) await wait(Math.min(options.config().transferRetryMaxMs, options.config().transferRetryMinMs * 2 ** Math.min(attempt, 30)), signal); }
      }
    }
    await wait(options.config().transferRetryCycleMs, signal);
  }
}

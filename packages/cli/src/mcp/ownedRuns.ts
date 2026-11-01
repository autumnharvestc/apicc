import { assertAiReportOwnership, type AiReadableReport } from "@apicc/core";
import type { InvocationOutput } from "@apicc/execution/host";
import type { OnlineLocalResult, OnlineReport } from "@apicc/execution/client";
import type { McpExecutionLimits, McpRunHandle } from "./execution.js";
import type { McpSource, McpRun, McpRunFailure } from "./source.js";
import { registerOwnedRunReader } from "./executionCapabilities.js";
import { ownedReport } from "./reports.js";
import { boundedJson } from "./pagination.js";

// Only these known reasons cross the MCP failure boundary. Arbitrary .code/message never does.
const reasons = new Set(["FILE_SOURCE_CHANGED", "FILE_SOURCE_NOT_REPLAYABLE", "UPLOAD_LIMIT_EXCEEDED",
  "CREDENTIAL_VERSION_CONFLICT", "CREDENTIAL_MISSING", "CREDENTIAL_UNAVAILABLE", "forbidden", "unauthorized",
  "job-timeout", "local-preparation-failed", "local-execution-failed", "local-run-cancelled"]);
export function safeRunFailure(reason: unknown, fact: McpRunFailure["executionFact"]): McpRunFailure {
  return typeof reason === "string" && reasons.has(reason) ? { reasonCode: reason, executionFact: fact }
    : { reasonCode: "local-execution-failed", executionFact: "uncertain" };
}
/** A trusted adapter fact, not a structural error.code capability. */
export class McpLocalExecutionFailure extends Error {
  readonly code: string;
  constructor(readonly failure: McpRunFailure) { super(failure.reasonCode); this.code = failure.reasonCode; }
}
type Payload = InvocationOutput | OnlineLocalResult | McpRunFailure;
export interface OwnedLocalRun {
  ticketId: string; intentId: string; projectId: string; contractProjectId: string;
  handle: McpRunHandle; view: McpRun; protected: boolean; bytes: number;
  terminalOrder?: number;
  payload?: Payload; stop?: () => Promise<void>; settling?: Promise<void>;
}
function outputOf(payload: Payload): InvocationOutput | undefined {
  return "output" in payload ? payload.output : "kind" in payload ? payload : undefined;
}
function readableReport(output: InvocationOutput, projectId: string): AiReadableReport {
  if (output.kind === "debug") { assertAiReportOwnership(output.result, projectId); return output.result; }
  if (output.kind === "stress-failure") throw new Error("MCP report-unreadable");
  const native = output.kind === "workflow" ? output.result.report : output.result;
  const report = ownedReport(native, projectId);
  if (!report) throw new Error("MCP report-unreadable；报告未采集或归属不明，不会重跑");
  return report;
}
export function createOwnedLocalRuns(source: McpSource, limits: McpExecutionLimits = {}) {
  const records = new Map<string, OwnedLocalRun>(), tickets = new Map<string, OwnedLocalRun>();
  const intents = new Map<string, OwnedLocalRun>();
  const activeLimit = limits.activeLocalRuns ?? 1, terminalLimit = limits.terminalLocalRuns ?? 20;
  const byteLimit = limits.terminalLocalBytes ?? 32 * 1024 * 1024;
  const within = (value: number, minimum: number, maximum: number) => Number.isSafeInteger(value) && value >= minimum && value <= maximum;
  if (!within(activeLimit, 1, 4) || !within(terminalLimit, 1, 100) || !within(byteLimit, 1024 * 1024, 128 * 1024 * 1024)) throw new Error("mcp-invalid-local-run-limits");
  const receiptLimit = limits.journalReceiptBytes ?? 16 * 1024, recordLimit = limits.journalMaxRecords ?? 1000;
  const metadataLimit = limits.journalTotalBytes ?? 8 * 1024 * 1024;
  let metadataBytes = 0, revision = 0, terminalOrder = 0;
  const unregister = registerOwnedRunReader(source, {
    revision: () => revision,
    list: projectId => [...records.values()].filter(run => run.projectId === projectId).map(run => ({ ...run.view })),
    get: id => { const run = records.get(id); return run ? { ...run.view } : undefined; },
    async report(id, project, signal) {
      signal.throwIfAborted();
      const run = records.get(id);
      if (!run || run.projectId !== project.projectId || run.contractProjectId !== project.snapshot.project.id) throw new Error("MCP report-unowned");
      // Settling owns no caller signal: abandoning a read never cancels business or release.
      if (run.settling) {
        let abort!: () => void;
        try { await Promise.race([run.settling, new Promise<never>((_, reject) => {
          abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
        })]); } finally { signal.removeEventListener("abort", abort); }
      }
      signal.throwIfAborted();
      if (run.view.reportState === "expired") throw new Error("MCP report-expired；本地结果已释放，不会重跑");
      if (!run.payload) throw new Error("MCP report-not-archived；本机运行尚未收束");
      const version = `${source.identity.bindingId}:${id}:${revision}`;
      const output = outputOf(run.payload);
      if (output) return { reportId: id, revision: version, project, report: readableReport(output, run.contractProjectId) };
      return { reportId: id, revision: version, project, failure: run.payload as McpRunFailure };
    },
  });
  const assertUnconsumed = (projectId: string, intentId: string) => {
    const previous = intents.get(JSON.stringify([projectId, intentId]));
    if (previous) throw new Error(`mcp-local-intent-consumed；原运行 ${previous.handle.runId}，不会重新提交`);
  };
  function evict() {
    const terminal = [...records.values()].filter(run => !run.protected && run.payload !== undefined)
      .sort((left, right) => left.terminalOrder! - right.terminalOrder!);
    let bytes = terminal.reduce((sum, run) => sum + run.bytes, 0), count = terminal.length;
    for (const run of terminal) {
      if (bytes <= byteLimit && count <= terminalLimit) break;
      bytes -= run.bytes; count--; run.payload = undefined; run.bytes = 0; run.view.reportState = "expired"; revision++;
    }
  }
  return {
    get: (id: string) => records.get(id),
    ticket: (id: string) => tickets.get(id),
    assertUnconsumed,
    values: () => [...records.values()],
    begin(ticketId: string, intentId: string, projectId: string, contractProjectId: string, handle: McpRunHandle, definitionRevision: string): OwnedLocalRun {
      const key = JSON.stringify([projectId, intentId]);
      assertUnconsumed(projectId, intentId);
      if ([...records.values()].filter(run => run.protected).length >= activeLimit) throw new Error("mcp-local-active-capacity");
      const view: McpRun = { runId: handle.runId, projectId, state: handle.state, reportState: "pending", startedAt: new Date().toISOString(), definitionRevision };
      // Charge the immutable nonsecret intent receipt plus its fixed-size lifecycle summary reservation.
      const receipt = { bindingId: source.identity.bindingId, ticketId, intentId, projectId, contractProjectId, runId: handle.runId, location: handle.location,
        summary: { ...view, state: "preparing", reportState: "unavailable", finishedAt: view.startedAt } };
      const bytes = Buffer.byteLength(boundedJson(receipt, receiptLimit));
      if (tickets.size >= recordLimit || metadataBytes + bytes > metadataLimit) throw new Error("mcp-local-intent-metadata-capacity");
      const run: OwnedLocalRun = { ticketId, intentId, projectId, contractProjectId, handle, view, protected: true, bytes: 0 };
      records.set(handle.runId, run); tickets.set(ticketId, run); intents.set(key, run); metadataBytes += bytes; revision++;
      return run;
    },
    running(run: OwnedLocalRun, handle: McpRunHandle) { run.handle.state = handle.state; run.view.state = handle.state; revision++; },
    settle(run: OwnedLocalRun, value: Payload | OnlineReport, release?: () => Promise<void>, forget?: () => void): Promise<void> {
      const settling = (async () => {
        const payload: Payload = "output" in value || "kind" in value ? value as Payload
          : safeRunFailure(value.reasonCode, value.executionFact === "not-started" ? "not-started" : "uncertain");
        const uncertain = "executionFact" in payload && payload.executionFact === "uncertain";
        run.handle.state = "ended"; run.view.state = "ended"; run.view.finishedAt = new Date().toISOString();
        if (!uncertain && release) {
          try { await release(); } catch { run.payload = safeRunFailure(undefined, "uncertain"); run.view.reportState = "none"; revision++; return; }
        }
        run.protected = uncertain;
        if (!uncertain) { run.terminalOrder = ++terminalOrder; run.stop = undefined; forget?.(); }
        try { run.bytes = Buffer.byteLength(boundedJson({ payload, summary: run.view }, byteLimit)); run.payload = payload; run.view.reportState = outputOf(payload) ? "archived" : "none"; }
        catch { run.bytes = 0; run.payload = undefined; run.view.reportState = "expired"; }
        revision++; evict();
      })();
      run.settling = settling;
      void settling.then(() => { run.settling = undefined; }, () => { run.settling = undefined; });
      return settling;
    },
    close() { unregister(); records.clear(); tickets.clear(); intents.clear(); },
  };
}

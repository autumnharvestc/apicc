// Test-only numeric projection. Never persist IPC frames, business IDs, configuration or free text.
export const DIAGNOSTIC_BYTES = 256 * 1024;
const phases = new Set(["setup", "vu-setup", "warmup", "measurement", "drain", "vu-teardown", "teardown"]);
const reasons = new Set(["cancelled", "drain-timeout", "warmup-drain-timeout", "setup-failed", "vu-setup-failed", "teardown-failed", "vu-teardown-failed",
  "worker-missing", "worker-failed", "worker-incompatible", "snapshot-missing", "snapshot-duplicate", "snapshot-invalid", "metrics-budget-exhausted",
  "histogram-overflow", "timeline-unaligned", "phase-window-missing", "dropped", "no-data", "policy-limited", "resource-saturated", "execution-failed"]);
const types = new Set(["clock", "start", "create", "execute", "phase-at"]);
const number = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
const ordinal = (n) => number(n) && Number.isSafeInteger(n);
const runId = (s) => typeof s === "string" && /^(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|run-\d{1,6})$/i.test(s) ? s : "unknown";
const workerId = (s) => typeof s === "string" && /^worker-\d{1,6}$/.test(s) ? s : "unknown";

function traceProjection(row) {
  if (!row || !types.has(row.type) || !["send", "receive"].includes(row.direction) || !number(row.parentNowMs)) return null;
  const out = { type: row.type, direction: row.direction, parentNowMs: row.parentNowMs };
  for (const key of ["seq", "requestSeq", "worker", "vu", "iteration", "stage"]) if (ordinal(row[key])) out[key] = row[key];
  for (const key of ["atMs", "coordinatorNow", "workerNow", "uncertaintyMs", "runStart", "scheduledOffsetMs"]) if (number(row[key])) out[key] = row[key];
  if (["request", "response", "failure"].includes(row.kind)) out.kind = row.kind;
  if (phases.has(row.phase)) out.phase = row.phase;
  if (typeof row.uncertain === "boolean") out.uncertain = row.uncertain;
  if (["worker-failed", "plugin_runtime_mismatch"].includes(row.code)) out.code = row.code;
  return out;
}

export function projectDiagnostics(raw) {
  if (!raw || raw.formatVersion !== 2 || !Array.isArray(raw.runs) || !Array.isArray(raw.workers)) throw new Error("diagnostics-invalid");
  const output = { formatVersion: 2, timingBasis: "observed-parent-monotonic-ipc-not-internal-dispatch-bound", runs: [], workers: [], truncated: false, omitted: 0 };
  for (const run of raw.runs.slice(0, 8)) {
    if (!run || !run.completeness || !(number(run.timeline?.uncertaintyMs) || run.timeline?.uncertaintyMs === null)) throw new Error("diagnostics-invalid");
    const completeness = {};
    for (const part of ["execution", "metrics", "load"]) {
      const value = run.completeness[part];
      if (!value || typeof value.complete !== "boolean" || !Array.isArray(value.reasons)) throw new Error("diagnostics-invalid");
      completeness[part] = { complete: value.complete, reasons: [...new Set(value.reasons.filter((r) => reasons.has(r)))].slice(0, 32),
        unknownReasonCount: (ordinal(value.unknownReasonCount) ? value.unknownReasonCount : 0) + value.reasons.filter((r) => !reasons.has(r)).length };
    }
    const rows = Array.isArray(run.trace) ? run.trace : [];
    const trace = rows.slice(0, 256).map(traceProjection).filter(Boolean);
    const omitted = (ordinal(run.omitted) ? run.omitted : 0) + Math.max(0, rows.length - 256);
    output.runs.push({ runId: runId(run.runId), summaryState: run.timeline.uncertaintyMs === null ? "missing" : "observed", completeness, timeline: { aligned: run.timeline.aligned === true, uncertaintyMs: run.timeline.uncertaintyMs },
      phaseWindows: (Array.isArray(run.phaseWindows) ? run.phaseWindows : []).slice(0, 69).filter((w) => w && phases.has(w.phase) && number(w.startOffsetMs) && number(w.endOffsetMs))
        .map((w) => ({ phase: w.phase, startOffsetMs: w.startOffsetMs, endOffsetMs: w.endOffsetMs })),
      trace, truncated: run.truncated === true || omitted > 0, omitted,
      unobservedFrames: ordinal(run.unobservedFrames) ? run.unobservedFrames : 0 });
  }
  output.workers = raw.workers.slice(0, 16).map((w) => ({ runId: runId(w.runId), workerId: workerId(w.workerId),
    code: w.code === null || Number.isSafeInteger(w.code) ? w.code : null, signal: w.signal === null ? null : "signalled" }));
  output.omitted = Math.max(0, raw.runs.length - 8) + Math.max(0, raw.workers.length - 16);
  // Keep final causes/windows ahead of trace when the total byte ceiling is reached.
  while (Buffer.byteLength(JSON.stringify(output)) > DIAGNOSTIC_BYTES) {
    const run = [...output.runs].reverse().find((r) => r.trace.length);
    if (!run) throw new Error("diagnostics-invalid");
    run.trace.pop(); run.omitted++; run.truncated = true;
  }
  output.truncated = output.omitted > 0 || output.runs.some((r) => r.truncated);
  return output;
}

export function createDiagnosticRecorder() {
  const runs = new Map(), workers = [];
  const get = (id) => {
    if (!runs.has(id) && runs.size < 8) runs.set(id, { runId: id, trace: [], omitted: 0, unobservedFrames: 0, phaseWindows: [],
      completeness: { execution: { complete: false, reasons: [] }, metrics: { complete: false, reasons: [] }, load: { complete: false, reasons: [] } }, timeline: { aligned: false, uncertaintyMs: null } });
    return runs.get(id);
  };
  return {
    windows(id, windows) { const run = get(id); if (run) run.phaseWindows = (windows ?? []).slice(0, 69).map((w) => ({ phase: w.phase, startOffsetMs: w.startOffsetMs, endOffsetMs: w.endOffsetMs })); },
    summary(id, summary) { const run = get(id); if (run) { run.completeness = summary.completeness; run.timeline = { aligned: summary.timeline.aligned, uncertaintyMs: summary.timeline.uncertaintyMs }; } },
    exit(identity, exit) { if (workers.length < 16) workers.push({ runId: identity.runId, workerId: identity.workerId, code: exit.code, signal: exit.signal }); },
    snapshot() { return projectDiagnostics({ formatVersion: 2, runs: [...runs.values()], workers }); },
    tap(identity) {
      const run = get(identity.runId), pending = new Map(), ids = new Map();
      const chunks = { send: null, receive: null }; let serial = 0;
      const idNumber = (kind, value) => { if (typeof value !== "string") return undefined; const key = kind + value; if (!ids.has(key) && ids.size < 256) ids.set(key, ids.size + 1); return ids.get(key); };
      return (direction, raw, parentNowMs) => {
        // Observation failure is secondary; callers never see it and no message is mutated.
        try {
          if (!run || !raw || raw.kind !== "chunk") return;
          if (!ordinal(raw.index) || !ordinal(raw.total) || raw.total < 1 || raw.total > 4 || !number(raw.bytes) || raw.bytes > 65536 || typeof raw.data !== "string" || raw.data.length > 16384) {
            if (raw.index === 0) run.unobservedFrames++; chunks[direction] = null; return;
          }
          if (raw.index === 0) chunks[direction] = { transferId: raw.transferId, total: raw.total, next: 0, text: "" };
          const transfer = chunks[direction];
          if (!transfer || transfer.transferId !== raw.transferId || transfer.next !== raw.index || transfer.total !== raw.total) return;
          transfer.text += raw.data; transfer.next++;
          if (transfer.next !== transfer.total) return;
          chunks[direction] = null;
          const frame = JSON.parse(transfer.text);
          if (!["request", "response", "failure"].includes(frame.kind) || !/^\d{1,9}$/.test(frame.id)) return;
          let row;
          if (frame.kind === "request") {
            if (!types.has(frame.command?.type)) return;
            const c = frame.command;
            row = { type: c.type, requestSeq: Number(frame.id), vu: idNumber("vu", c.vuId), iteration: idNumber("iteration", c.iterationId), stage: idNumber("stage", c.stageId) };
            if (pending.size < 256) pending.set(direction + frame.id, row);
            row = { ...row, phase: c.phase, atMs: c.atMs, coordinatorNow: c.coordinatorNow, workerNow: c.workerNow,
              uncertaintyMs: c.uncertaintyMs, runStart: c.runStart, scheduledOffsetMs: c.scheduledOffsetMs };
          } else {
            const key = (direction === "send" ? "receive" : "send") + frame.id;
            const request = pending.get(key); pending.delete(key); if (!request) return;
            row = { ...request, workerNow: frame.value?.workerNow, atMs: frame.value?.atMs, phase: frame.value?.phase, uncertain: frame.value?.uncertain, code: frame.code };
          }
          serial++;
          if (run.trace.length >= 256) { run.omitted++; return; }
          const projected = traceProjection({ ...row, seq: serial, direction, kind: frame.kind, parentNowMs, worker: Number(identity.workerId.replace("worker-", "")) });
          if (projected) run.trace.push(projected);
        } catch { if (run) run.unobservedFrames++; }
      };
    },
  };
}

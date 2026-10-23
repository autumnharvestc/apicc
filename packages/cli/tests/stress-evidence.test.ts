import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { captureStressSubprocessEvidence } from "./helpers/stressSubprocessEvidence.js";
// @ts-expect-error shared native ESM test utility
import { createDiagnosticRecorder } from "./helpers/stressDiagnosticTrace.mjs";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "apicc-evidence-contract-")); roots.push(root);
  const runsDir = join(root, "runs"); mkdirSync(runsDir);
  return { root, runsDir, diagnosticFile: join(root, "diagnostic.json"), evidenceRoot: join(root, "evidence"),
    result: { code: 1, signal: null, stdout: "primary exit failure", stderr: "" } };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// Removing the fixed-code projection/bounds or allowing capture IO to throw must break these behaviors.
it("writes bounded whitelist evidence and exposes actual reasons/uncertainty in the primary failure message", () => {
  const input = fixture();
  const sentinel = "PRIVATE_AUTH_CONFIG_MARKER_SENTINEL";
  const recorder = createDiagnosticRecorder();
  recorder.summary("run-1", {
    completeness: { execution: { complete: true, reasons: [] }, metrics: { complete: false, reasons: ["timeline-unaligned", sentinel] }, load: { complete: true, reasons: [] } },
    timeline: { aligned: false, uncertaintyMs: 1.25 }, config: sentinel });
  recorder.windows("run-1", [{ phase: "measurement", stageId: sentinel, startOffsetMs: 10, endOffsetMs: 20 }]);
  const tap = recorder.tap({ runId: "run-1", workerId: "worker-1" });
  for (let i = 0; i < 300; i++) {
    const frame = JSON.stringify({ kind: "request", id: String(i + 1), command: { type: "phase-at", atMs: 19.5, config: sentinel } });
    tap("receive", { kind: "chunk", transferId: String(i), index: 0, total: 1, bytes: Buffer.byteLength(frame), data: frame }, 21 + i);
  }
  writeFileSync(input.diagnosticFile, JSON.stringify(recorder.snapshot()));
  const captured = captureStressSubprocessEvidence(input);
  expect(captured.summary ?? "").toContain("metrics=timeline-unaligned");
  expect(captured.summary).toContain("uncertaintyMs=1.25");
  expect(captured.summary).toContain("metrics.unknownReasonCount=1");
  expect(captured.summary).toContain("exit=1");
  expect(captured.summary).toContain(captured.directory);
  expect(Buffer.byteLength(captured.summary)).toBeLessThanOrEqual(16 * 1024);
  const bytes = readFileSync(join(captured.directory, "diagnostics.json"), "utf8");
  expect(bytes).not.toContain(sentinel);
  expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(256 * 1024);
  const saved = JSON.parse(bytes);
  expect(saved.runs[0].trace).toHaveLength(256);
  expect(saved.runs[0]).toMatchObject({ truncated: true, omitted: 44,
    phaseWindows: [{ phase: "measurement", startOffsetMs: 10, endOffsetMs: 20 }] });
});

it("labels missing/invalid diagnostics and never masks the primary exit failure when evidence IO fails", () => {
  const input = fixture();
  expect(captureStressSubprocessEvidence(input).summary ?? "").toContain("diagnostics-missing");
  writeFileSync(input.diagnosticFile, "{PRIVATE_MALFORMED_SENTINEL");
  expect(captureStressSubprocessEvidence(input).summary).toContain("diagnostics-invalid");
  const blocked = join(input.root, "blocked"); writeFileSync(blocked, "not a directory");
  const captured = captureStressSubprocessEvidence({ ...input, evidenceRoot: blocked });
  expect(captured.summary).toContain("exit=1");
  expect(captured.summary).toContain("capture-failed");
  expect(captured.summary).not.toContain("PRIVATE_MALFORMED_SENTINEL");
});

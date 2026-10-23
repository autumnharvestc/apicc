import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Test-only native ESM is shared with the real Node diagnostic entry.
// @ts-expect-error native mjs fixture intentionally has no production declaration output
import { DIAGNOSTIC_BYTES, projectDiagnostics } from "./stressDiagnosticTrace.mjs";

/** Capture is secondary: no diagnostic IO/parsing error may replace the original exit-code assertion. */
export function captureStressSubprocessEvidence(input: {
  evidenceRoot: string; root: string; runsDir: string; diagnosticFile: string;
  result: { code: number; signal: string | null; stdout: string; stderr: string };
}): { directory: string; report: Record<string, unknown> | null; summary: string } {
  let directory = input.evidenceRoot, report: Record<string, unknown> | null = null;
  let diagnosticState = "diagnostics-missing", reportState = "report-missing", captureState = "captured";
  let diagnostics: ReturnType<typeof projectDiagnostics> | null = null;
  try {
    if (existsSync(input.diagnosticFile)) {
      diagnosticState = "diagnostics-invalid";
      if (statSync(input.diagnosticFile).size <= DIAGNOSTIC_BYTES) {
        diagnostics = projectDiagnostics(JSON.parse(readFileSync(input.diagnosticFile, "utf8")));
        diagnosticState = "captured";
      }
    }
  } catch { diagnosticState = "diagnostics-invalid"; }
  try {
    mkdirSync(input.evidenceRoot, { recursive: true });
    directory = mkdtempSync(join(input.evidenceRoot, "normal-eight-"));
    // Local originals remain available; CI only uploads the selected JSON names.
    writeFileSync(join(directory, "stdout.log"), input.result.stdout);
    writeFileSync(join(directory, "stderr.log"), input.result.stderr);
    if (diagnostics) writeFileSync(join(directory, "diagnostics.json"), JSON.stringify(diagnostics));
    const files = existsSync(input.runsDir) ? readdirSync(input.runsDir).filter((f) => f.startsWith("stress-") && f.endsWith(".json")).sort() : [];
    if (files.length) {
      reportState = "report-invalid";
      const bytes = readFileSync(join(input.runsDir, files.at(-1)!), "utf8");
      // Existing public report stays verbatim for local assertions; not in the CI upload whitelist.
      writeFileSync(join(directory, "safe-report.json"), bytes);
      try { report = JSON.parse(bytes) as Record<string, unknown>; reportState = "captured"; } catch { /* fixed state only */ }
    }
    writeFileSync(join(directory, "capture.json"), JSON.stringify({ formatVersion: 2, reportState, diagnosticState,
      code: input.result.code, signalled: input.result.signal !== null }));
  } catch { captureState = "capture-failed"; }
  const parts = [`exit=${input.result.code}`, captureState, diagnosticState, `evidence=${directory.slice(0, 4096)}`];
  for (const run of diagnostics?.runs ?? []) {
    parts.push(`run=${run.runId}`);
    for (const part of ["execution", "metrics", "load"]) {
      const value = run.completeness[part];
      parts.push(`${part}=${value.reasons.join(",") || (value.complete ? "complete" : "unknown")}`);
      if (value.unknownReasonCount) parts.push(`${part}.unknownReasonCount=${value.unknownReasonCount}`);
    }
    parts.push(`summary=${run.summaryState}`, `uncertaintyMs=${run.timeline.uncertaintyMs ?? "unknown"}`, `trace=${run.trace.length}`, `omitted=${run.omitted}`, `unobservedFrames=${run.unobservedFrames}`);
  }
  if (!diagnostics?.runs.length) parts.push("uncertaintyMs=unknown");
  let summary = parts.join(" ");
  while (Buffer.byteLength(summary) > 16 * 1024) summary = summary.slice(0, -1);
  try { if (captureState === "captured") writeFileSync(join(directory, "summary.json"), JSON.stringify({ formatVersion: 2, summary })); } catch { /* primary failure wins */ }
  return { directory, report, summary };
}

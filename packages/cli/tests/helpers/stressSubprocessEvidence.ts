import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Called before assertions/afterAll; final public JSON is copied verbatim, never reconstructed. */
export function captureStressSubprocessEvidence(input: {
  evidenceRoot: string; root: string; runsDir: string; diagnosticFile: string;
  result: { code: number; signal: string | null; stdout: string; stderr: string };
}): { directory: string; report: Record<string, unknown> | null } {
  mkdirSync(input.evidenceRoot, { recursive: true });
  const directory = mkdtempSync(join(input.evidenceRoot, "normal-eight-"));
  writeFileSync(join(directory, "stdout.log"), input.result.stdout);
  writeFileSync(join(directory, "stderr.log"), input.result.stderr);
  const diagnosticBytes = existsSync(input.diagnosticFile) ? readFileSync(input.diagnosticFile, "utf8") : null;
  if (diagnosticBytes !== null) writeFileSync(join(directory, "diagnostics.json"), diagnosticBytes);
  const files = existsSync(input.runsDir) ? readdirSync(input.runsDir).filter((f) => f.startsWith("stress-") && f.endsWith(".json")).sort() : [];
  const reportFile = files.length ? join(input.runsDir, files.at(-1)!) : null;
  let report: Record<string, unknown> | null = null;
  let reportState = "report-missing";
  if (reportFile) {
    const bytes = readFileSync(reportFile, "utf8");
    writeFileSync(join(directory, "safe-report.json"), bytes);
    try { report = JSON.parse(bytes) as Record<string, unknown>; reportState = "captured"; }
    catch { reportState = "report-invalid"; }
  }
  writeFileSync(join(directory, "capture.json"), JSON.stringify({ formatVersion: 1, root: input.root, runsDir: input.runsDir,
    reportFile, reportState, diagnosticState: diagnosticBytes === null ? "diagnostics-missing" : "captured",
    code: input.result.code, signal: input.result.signal }, null, 2));
  return { directory, report };
}

import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync, opendirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { StressReportSchema, StressReportV2Schema, type RunResult, type ReadableStressReport } from "@apicc/core";
import { z } from "zod";
import type { McpReportDiagnostic } from "./source.js";

const nonempty = z.string().min(1).max(256);
const identity = z.object({ projectId: nonempty, definitionRevision: nonempty }).passthrough();
const count = z.number().int().nonnegative();
const runReport = z.object({ projectId: nonempty, definitionRevision: nonempty, executionIdentity: identity,
  collectionId: nonempty, collectionName: z.string(), startedAt: z.string().datetime(), finishedAt: z.string().datetime(), total: count, passed: count, failed: count,
  cases: z.array(z.object({ apiId: nonempty, apiName: z.string(), caseId: nonempty, caseName: z.string(), passed: z.boolean(), durationMs: z.number().nonnegative(),
    assertions: z.array(z.object({ pass: z.boolean(), message: z.string() }).passthrough()), evidence: StressReportSchema.shape.failureEvidence.unwrap().element.optional(),
  }).passthrough()),
}).passthrough();

/** Shared ownership/schema validation for local archives and member-client native reports. */
export function ownedReport(value: unknown, projectId: string): RunResult | ReadableStressReport | undefined {
  const run = runReport.safeParse(value); const stress = StressReportV2Schema.safeParse(value); const legacyStress = StressReportSchema.safeParse(value);
  const report = run.success ? run.data as RunResult : stress.success ? stress.data : legacyStress.success ? legacyStress.data : undefined;
  if (!report || report.projectId !== projectId || !report.definitionRevision) return undefined;
  if ("cases" in report && (report.executionIdentity?.projectId !== report.projectId || report.executionIdentity?.definitionRevision !== report.definitionRevision)) return undefined;
  return report;
}

/** Sole local report reader shared by CLI AI and MCP. Never accepts a caller path. */
export function readLocalReportArchive(root: string, projectId: string): { items: Array<{ reportId: string; report: RunResult | ReadableStressReport; revision: string }>; diagnostics: McpReportDiagnostic[]; revision: string } {
  const directory = join(realpathSync(root), ".apicc", "runs");
  if (!existsSync(directory)) return { items: [], diagnostics: [], revision: createHash("sha256").digest("hex") };
  const canonical = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
  if (canonical(realpathSync(directory)) !== canonical(directory)) throw new Error("AI 报告目录越过受控边界");
  const names: string[] = []; const handle = opendirSync(directory); let entries = 0;
  try {
    for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
      if (++entries > 1000) throw new Error("AI 报告目录枚举超过数量预算");
      if (!entry.name.endsWith(".json")) continue;
      if (names.length >= 100) throw new Error("AI 报告数量超过 100 份；请缩小受控归档集合");
      names.push(entry.name);
    }
  } finally { handle.closeSync(); }
  names.sort();
  let bytes = 0;
  const reports: Array<{ reportId: string; report: RunResult | ReadableStressReport; revision: string }> = [];
  const counts = { unreadable: 0, unattributable: 0 }; const digest = createHash("sha256");
  for (const name of names) {
    const path = join(directory, name); const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || canonical(realpathSync(path)) !== canonical(path)) throw new Error("AI 报告文件越过受控边界");
    bytes += stat.size;
    if (stat.size > 16 * 1024 * 1024 || bytes > 32 * 1024 * 1024) throw new Error("AI 报告大小超过只读预算");
    let value: unknown; const content = readFileSync(path, "utf8");
    const revision = createHash("sha256").update(content).digest("hex"); digest.update(`${name.length}:${name}:${revision}:`);
    try { value = JSON.parse(content); } catch { counts.unreadable++; continue; }
    const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const owner = typeof record.projectId === "string" ? record.projectId : "";
    const anyOwned = ownedReport(value, owner);
    if (anyOwned && owner !== projectId) continue;
    const report = anyOwned;
    if (!report) {
      const identity = record.executionIdentity as Record<string, unknown> | undefined;
      const attributable = Boolean(owner && typeof record.definitionRevision === "string" && record.definitionRevision && (!Array.isArray(record.cases) || (identity?.projectId === owner && identity?.definitionRevision === record.definitionRevision)));
      counts[attributable ? "unreadable" : "unattributable"]++; continue;
    }
    reports.push({ reportId: `report:${createHash("sha256").update(name).digest("hex")}`, report, revision });
  }
  return { items: reports, diagnostics: (Object.keys(counts) as Array<keyof typeof counts>).filter(code => counts[code] > 0).map(code => ({ code, count: counts[code], scope: "source" })), revision: digest.digest("hex") };
}

/** Legacy array contract, using the same bounded reader, not a second archive implementation. */
export function readLocalAiReports(root: string, projectId: string) { return readLocalReportArchive(root, projectId).items; }

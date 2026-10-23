import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { parseStressReport as parseCoreStressReport, isStressReportV2, reportingUnits, workflowToRunResult, type RunResult, type WorkflowRunResult, type ReadableStressReport } from "@apicc/core";
import { StressReportFileSchema, type StressRunSummaryDTO, type RunSummaryDTO, type StressReportDTO } from "../shared/types.js";
import { ProjectLocatorSchema, type ProjectLocator } from "../shared/locations.js";
import { atomicStressWrite } from "./stressPlans.js";

export type { RunSummaryDTO, StressRunSummaryDTO, StressReportDTO } from "../shared/types.js";
export type RunSummary = RunSummaryDTO | StressRunSummaryDTO;

/** runs:get 对 stress 文件的返回（M2-D3 任务 1）：kind 判别 + 完整压测报告。 */

/**
 * RunResult 最小形状校验（宽审查修复 3）：手工放入 .apicc/runs 的形状不对 JSON 此前
 * 只按 RunResult 断言，缺字段一路 undefined 流向摘要/详情。这里只约束摘要与列表必需的
 * 顶层字段；cases 内部结构不校验（避免过度约束，详情视图按需渲染）。
 */
const RunResultShapeSchema = z.object({
  collectionName: z.string(),
  startedAt: z.string(),
  total: z.number(),
  passed: z.number(),
  failed: z.number(),
  skipped: z.number().optional(),
  cases: z.array(z.unknown()),
});

/** 解析 + 最小形状校验；任一失败返回 null（非法 JSON 与形状不对同策略：跳过/不可读）。 */
function parseRunResult(raw: string): RunResult | null {
  const json = parseJson(raw);
  if (json && typeof json === "object" && "workflowId" in json && "nodeResults" in json && Array.isArray(json.nodeResults) && "workflowName" in json && typeof json.workflowName === "string" && "startedAt" in json && typeof json.startedAt === "string") {
    const old = json as WorkflowRunResult;
    return old.report && RunResultShapeSchema.safeParse(old.report).success ? old.report : workflowToRunResult(old);
  }
  return json !== null && RunResultShapeSchema.safeParse(json).success ? (json as RunResult) : null;
}

/** 压测报告校验（M2-D3 任务 1）：core StressReportSchema（strict）判别 kind: "stress"。 */
function parseStressReport(raw: string): ReadableStressReport | null {
  const json = parseJson(raw);
  try { return parseCoreStressReport(json); } catch { return null; }
}

function parseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 按内容判别单文件摘要（规格 §2 D11，修复 2B 账本「listRuns 对非运行 JSON 产出
 * undefined 摘要」缺口）：先按 RunResult 最小形状（命中 → kind collection），再按
 * StressReportSchema（命中 → kind stress），均失败 → null（跳过）。
 */
function summarize(runsDir: string, file: string): RunSummary | null {
  try {
    const raw = readFileSync(join(runsDir, file), "utf8");
    const r = parseRunResult(raw);
    if (r) {
      return { kind: r.suite ? "suite" : r.workflowId ? "workflow" : r.kind ?? "collection", projectId: r.projectId ?? r.suite?.projectId, file, collectionName: r.collectionName, startedAt: r.startedAt, total: r.total, passed: r.passed, failed: r.failed, skipped: r.skipped ?? 0, reportingUnits: r.reportingUnits ?? reportingUnits(r).summary,
        ...(r.reportingMode ? { reportingMode: r.reportingMode, logicalVerdict: r.suite?.verdict ?? r.workflow?.verdict } : {}) };
    }
    const s = parseStressReport(raw);
    if (s) {
      // 压测报告 startedAt 为 epoch ms，摘要统一为 ISO 字符串（与集合行同口径排序）。
      return summarizeStressReport(s, file);
    }
    return null;
  } catch {
    return null;
  }
}

function summarizeStressReport(s: ReadableStressReport, file: string): StressRunSummaryDTO {
  return { kind: "stress", projectId: s.projectId, file, startedAt: new Date(s.startedAt).toISOString(), totalRequests: s.totalRequests, ok: s.ok, failed: s.failed,
    rps: isStressReportV2(s) ? s.rps.availability === "available" ? s.rps.value : null : s.rps,
    ...(isStressReportV2(s) ? { formatVersion: 2 as const, verdict: s.verdict.status, target: s.target, completeness: s.completeness, rpsMetric: s.rps } : {}) };
}

/** Project workbench history is derived only from the same proof used by compare/export. */
export function listScopedStressRuns(root: string, scope: ProjectLocator): StressRunSummaryDTO[] {
  const actualRoot = realpathSync(root), parsedScope = ProjectLocatorSchema.parse(scope);
  let files: string[]; try { files = readdirSync(join(actualRoot, '.apicc', 'runs')); } catch { return []; }
  return files.filter(file => file.endsWith('.json')).flatMap(file => {
    try { return [summarizeStressReport(readScopedStressRun(actualRoot, parsedScope, file), file)]; } catch { return []; }
  }).sort((a,b) => a.startedAt < b.startedAt ? 1 : -1);
}

export function listRuns(runsDir: string): RunSummary[] {
  try {
    return readdirSync(runsDir)
      .filter((f) => f.endsWith(".json"))
      .map((file) => summarize(runsDir, file))
      .filter((x): x is RunSummary => x !== null)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  } catch {
    return [];
  }
}

export function readRun(runsDir: string, file: string): RunResult | StressReportDTO | null {
  if (!file.endsWith(".json") || file.includes("/") || file.includes("\\")) return null;
  try {
    const raw = readFileSync(join(runsDir, file), "utf8");
    const r = parseRunResult(raw);
    if (r) return r;
    const s = parseStressReport(raw);
    return s ? { kind: "stress", report: s } : null;
  } catch {
    return null;
  }
}

const scopeEvidenceSchema = z.object({ formatVersion: z.literal(1), root: z.string().min(1), scope: ProjectLocatorSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const contentHash = (content: string) => createHash("sha256").update(content).digest("hex");
/** Bind the actual final safe bytes, not an earlier in-memory representation. */
export function writeStressRunScope(root: string, file: string, scope: ProjectLocator): void {
  StressReportFileSchema.parse(file); const actualRoot = realpathSync(root);
  const reportPath = join(actualRoot, ".apicc", "runs", file), content = readFileSync(reportPath, "utf8");
  const report = parseCoreStressReport(JSON.parse(content)); const parsedScope = ProjectLocatorSchema.parse(scope);
  if (report.projectId && report.projectId !== parsedScope.projectId) throw new Error("Stress report project mismatch");
  const evidence = scopeEvidenceSchema.parse({ formatVersion: 1, root: actualRoot, scope: parsedScope, sha256: contentHash(content) });
  atomicStressWrite(`${reportPath}.scope`, JSON.stringify(evidence));
}
export function readScopedStressRun(root: string, scope: ProjectLocator, file: string): ReadableStressReport {
  StressReportFileSchema.parse(file); const parsedScope = ProjectLocatorSchema.parse(scope), actualRoot = realpathSync(root);
  const reportPath = join(actualRoot, ".apicc", "runs", file);
  try {
    const content = readFileSync(reportPath, "utf8"), evidence = scopeEvidenceSchema.parse(JSON.parse(readFileSync(`${reportPath}.scope`, "utf8")));
    if (evidence.root !== actualRoot || evidence.scope.workspaceId !== parsedScope.workspaceId || evidence.scope.groupId !== parsedScope.groupId || evidence.scope.projectId !== parsedScope.projectId || evidence.sha256 !== contentHash(content)) throw new Error("scope mismatch");
    const report = parseCoreStressReport(JSON.parse(content));
    if (report.projectId && report.projectId !== parsedScope.projectId) throw new Error("project mismatch");
    return report;
  } catch { throw new Error("压测报告归属未证明或内容已改变；请选择当前项目已保存的报告"); }
}

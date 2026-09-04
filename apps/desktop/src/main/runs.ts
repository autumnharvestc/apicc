import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { StressReportSchema, type RunResult, type StressReport } from "@apicc/core";

export interface RunSummaryDTO { kind: "collection"; file: string; collectionName: string; startedAt: string; total: number; passed: number; failed: number }
export interface StressRunSummaryDTO { kind: "stress"; file: string; startedAt: string; totalRequests: number; ok: number; failed: number; rps: number }
export type RunSummary = RunSummaryDTO | StressRunSummaryDTO;

/** runs:get 对 stress 文件的返回（M2-D3 任务 1）：kind 判别 + 完整压测报告。 */
export interface StressReportDTO { kind: "stress"; report: StressReport }

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
  cases: z.array(z.unknown()),
});

/** 解析 + 最小形状校验；任一失败返回 null（非法 JSON 与形状不对同策略：跳过/不可读）。 */
function parseRunResult(raw: string): RunResult | null {
  const json = parseJson(raw);
  return json !== null && RunResultShapeSchema.safeParse(json).success ? (json as RunResult) : null;
}

/** 压测报告校验（M2-D3 任务 1）：core StressReportSchema（strict）判别 kind: "stress"。 */
function parseStressReport(raw: string): StressReport | null {
  const json = parseJson(raw);
  const result = json === null ? null : StressReportSchema.safeParse(json);
  return result?.success ? result.data : null;
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
      return { kind: "collection", file, collectionName: r.collectionName, startedAt: r.startedAt, total: r.total, passed: r.passed, failed: r.failed };
    }
    const s = parseStressReport(raw);
    if (s) {
      // 压测报告 startedAt 为 epoch ms，摘要统一为 ISO 字符串（与集合行同口径排序）。
      return { kind: "stress", file, startedAt: new Date(s.startedAt).toISOString(), totalRequests: s.totalRequests, ok: s.ok, failed: s.failed, rps: s.rps };
    }
    return null;
  } catch {
    return null;
  }
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

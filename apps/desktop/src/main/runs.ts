import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { RunResult } from "@apicc/core";

export interface RunSummaryDTO { file: string; collectionName: string; startedAt: string; total: number; passed: number; failed: number }

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
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  return RunResultShapeSchema.safeParse(json).success ? (json as RunResult) : null;
}

export function listRuns(runsDir: string): RunSummaryDTO[] {
  try {
    return readdirSync(runsDir)
      .filter((f) => f.endsWith(".json"))
      .map((file) => {
        try {
          const r = parseRunResult(readFileSync(join(runsDir, file), "utf8"));
          if (!r) return null;
          return { file, collectionName: r.collectionName, startedAt: r.startedAt, total: r.total, passed: r.passed, failed: r.failed };
        } catch {
          return null;
        }
      })
      .filter((x): x is RunSummaryDTO => x !== null)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  } catch {
    return [];
  }
}

export function readRun(runsDir: string, file: string): RunResult | null {
  if (!file.endsWith(".json") || file.includes("/") || file.includes("\\")) return null;
  try {
    return parseRunResult(readFileSync(join(runsDir, file), "utf8"));
  } catch {
    return null;
  }
}

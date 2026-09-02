import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RunResult } from "@apicc/core";

export interface RunSummaryDTO { file: string; collectionName: string; startedAt: string; total: number; passed: number; failed: number }

export function listRuns(runsDir: string): RunSummaryDTO[] {
  try {
    return readdirSync(runsDir)
      .filter((f) => f.endsWith(".json"))
      .map((file) => {
        try {
          const r = JSON.parse(readFileSync(join(runsDir, file), "utf8")) as RunResult;
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
    return JSON.parse(readFileSync(join(runsDir, file), "utf8")) as RunResult;
  } catch {
    return null;
  }
}

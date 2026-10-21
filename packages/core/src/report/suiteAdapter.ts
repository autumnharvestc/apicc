import type { SuiteRunResult } from "../testing/suiteRunner.js";
import type { RunResult } from "./types.js";

/** Compatibility container uses suite identity; physical module identity stays on each case locator. */
export function suiteToRunResult(result: SuiteRunResult): RunResult {
  return { collectionId: result.suiteId, collectionName: result.suiteName, startedAt: result.startedAt, finishedAt: result.finishedAt,
    total: result.cases.length, passed: result.cases.filter((item) => item.passed).length, failed: result.cases.filter((item) => !item.passed).length,
    cases: result.cases, warnings: result.warnings,
    suite: { suiteRunId: result.suiteRunId, projectId: result.projectId, definitionRevision: result.definitionRevision, verdict: result.verdict,
      environmentId: result.environmentId, datasetId: result.datasetId, dataDigest: result.dataDigest,
      total: result.total, passed: result.passed, failed: result.failed, skipped: result.skipped, entries: result.entries.map(({ cases: _cases, ...entry }) => entry) } };
}

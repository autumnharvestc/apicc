import type { RunResult, SafeExecutionEvidence } from "./types.js";

export function reportEntryEvidence(result: RunResult, entry: NonNullable<NonNullable<RunResult["suite"]>["entries"]>[number] | NonNullable<RunResult["workflow"]>["entries"][number]): SafeExecutionEvidence {
  const base = result.executionIdentity ?? { projectId: result.projectId ?? result.suite?.projectId ?? "", definitionRevision: result.definitionRevision ?? result.suite?.definitionRevision ?? "" };
  const suite = result.suite;
  return { identity: { ...base, entryId: entry.entryId, workflowId: entry.workflowId,
    ...("caseLocator" in entry ? { locator: entry.caseLocator } : {}), suiteRunId: suite?.suiteRunId, suiteRow: entry.suiteRow, rowIndex: entry.suiteRow ?? 0,
    environmentId: suite?.environmentId ?? base.environmentId, datasetId: suite?.datasetId ?? base.datasetId, dataDigest: suite?.dataDigest ?? base.dataDigest },
    state: "not-collected", scriptDiagnostics: "not-collected", bodyUnavailable: true, truncated: false };
}

/** Output-only entry units never become HTTP cases or affect runner metrics. */
export function reportingUnits(result: RunResult) {
  if (result.reportingMode && result.workflowUnits) {
    const key = (entryId: string | undefined, row: number | undefined) => JSON.stringify([entryId, row]);
    const logical = new Set(result.workflowUnits.map((unit) => key(unit.entryId, unit.suiteRow)));
    const rows = result.reportingMode === "workflow-invocation-v2" ? [] : result.cases.filter((row) => !logical.has(key(row.entryId, row.suiteRow)));
    const failedRows = new Set(rows.filter((row) => !row.passed && !row.skipped).map((row) => key(row.entryId, row.suiteRow)));
    const diagnostics = (result.suite?.entries ?? []).filter((entry) => !logical.has(key(entry.entryId, entry.suiteRow)) && (entry.status === "failed" || entry.status === "aborted") && !failedRows.has(key(entry.entryId, entry.suiteRow)));
    return { rows, invocations: result.workflowUnits, diagnostics, summary: {
      total: rows.length + result.workflowUnits.length + diagnostics.length,
      passed: rows.filter((row) => row.passed && !row.skipped).length + result.workflowUnits.filter((unit) => unit.verdict === "passed").length,
      failed: rows.filter((row) => !row.passed && !row.skipped).length + result.workflowUnits.filter((unit) => unit.verdict === "failed" || unit.verdict === "aborted").length + diagnostics.length,
      skipped: rows.filter((row) => row.skipped).length + result.workflowUnits.filter((unit) => unit.verdict === "skipped").length, entryDiagnostics: diagnostics.length,
    } };
  }
  const failedRows = new Set(result.cases.filter((item) => !item.passed && !item.skipped).map((item) => JSON.stringify([item.entryId, item.suiteRow])));
  const diagnostics = (result.suite?.entries ?? result.workflow?.entries ?? []).filter((entry) => (entry.status === "failed" || entry.status === "aborted")
    && !failedRows.has(JSON.stringify([entry.entryId, entry.suiteRow])));
  return { rows: result.cases, invocations: [], diagnostics, summary: { total: result.total + diagnostics.length, passed: result.passed, failed: result.failed + diagnostics.length,
    skipped: result.skipped ?? 0, entryDiagnostics: diagnostics.length } };
}

export function caseReportingIdentity(item: RunResult["cases"][number]): string {
  const identity = [item.entryId, item.suiteRow, item.scope ?? item.locator?.scope].filter((value) => value !== undefined);
  return `${item.nodeId ? `${item.nodeId}:` : ""}${item.apiName}.${item.caseName}${item.row !== undefined ? `#${item.row}` : ""}${identity.length ? ` [${JSON.stringify([item.locator, ...identity])}]` : ""}`;
}

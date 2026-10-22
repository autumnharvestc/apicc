import type { RunResult, CaseOutcome } from "../report/types.js";
import type { WorkflowRunResult, NodeResult } from "./runner.js";

function nodeOutcome(node: NodeResult, outcome: CaseOutcome): CaseOutcome {
  return outcome.nodeId ? outcome : { ...outcome, nodeId: node.nodeId };
}

/** Containers retain aggregate aliases; exact identities select each real row once. */
export function workflowCaseRows(wfr: WorkflowRunResult): CaseOutcome[] {
  const seen = new Set<string>(); const objects = new Set<CaseOutcome>(); const rows: CaseOutcome[] = [];
  const visit = (flow: WorkflowRunResult) => {
    for (const node of flow.nodeResults) {
      for (const raw of node.outcomes ?? (node.outcome ? [node.outcome] : [])) {
        const item = nodeOutcome(node, raw);
        const key = item.nodeVisitId ? JSON.stringify([item.invocationId, item.invocationPath, item.nodeVisitId, item.attempt, item.locator, item.apiId, item.caseId, item.scope, item.row]) : undefined;
        if (key ? seen.has(key) : objects.has(raw)) continue;
        if (key) seen.add(key); objects.add(raw); rows.push(item);
      }
      for (const child of node.childInvocations ?? []) visit(child);
      for (const child of node.policyInvocations ?? []) visit(child.result);
    }
  };
  visit(wfr); return rows;
}

/**
 * WorkflowRunResult → RunResult（复用既有 Reporter 插件渲染）。
 * Raw workflow keeps node counts; reports keep actual rows and separate output-only diagnostics.
 */
export function workflowToRunResult(wfr: WorkflowRunResult): RunResult {
  const cases = workflowCaseRows(wfr).map((outcome) => ({ ...outcome, entryId: outcome.entryId ?? outcome.nodeId }));
  const skipped = cases.filter((c) => c.skipped).length;
  const passed = cases.filter((c) => !c.skipped && c.passed).length;
  const failed = cases.filter((c) => !c.skipped && !c.passed).length;
  return {
    ...(wfr.invocationId ? { reportingMode: "workflow-invocation-v2" as const,
      executionIdentity: { projectId: "", definitionRevision: "", workflowId: wfr.workflowId, invocationId: wfr.invocationId, parentInvocationId: wfr.parentInvocationId, invocationPath: wfr.invocationPath },
      workflowUnits: [{ entryId: wfr.workflowId, workflowId: wfr.workflowId, invocationId: wfr.invocationId, verdict: wfr.verdict ?? (wfr.failed ? "failed" : "passed"), error: wfr.nodeResults.find((node) => node.state === "failed")?.error }], requestFacts: wfr.requestFacts, trace: wfr.trace } : {}),
    kind: "workflow", workflowId: wfr.workflowId,
    workflow: { verdict: wfr.verdict, total: wfr.total, passed: wfr.passed, failed: wfr.failed, skipped: wfr.skipped,
      entries: wfr.nodeResults.map((node) => ({ entryId: node.nodeId, kind: "workflow", workflowId: wfr.workflowId, nodeKind: node.kind, label: node.label, state: node.state, skipReason: node.skipReason, failureKind: node.failureKind, status: node.state === "noop" ? "passed" : node.state, ...(node.error ? { error: node.error } : {}) })) },
    collectionId: wfr.workflowId,
    collectionName: wfr.workflowName,
    envName: undefined,
    startedAt: wfr.startedAt, finishedAt: wfr.finishedAt,
    total: cases.length, passed, failed, skipped,
    cases,
    warnings: wfr.warnings,
  };
}

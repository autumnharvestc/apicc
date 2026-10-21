import type { RunResult, CaseOutcome } from "../report/types.js";
import type { WorkflowRunResult, NodeResult } from "./runner.js";

function nodeOutcome(node: NodeResult, outcome: CaseOutcome): CaseOutcome {
  return outcome.nodeId ? outcome : { ...outcome, nodeId: node.nodeId };
}

/**
 * WorkflowRunResult → RunResult（复用既有 Reporter 插件渲染）。
 * Raw workflow keeps node counts; reports keep actual rows and separate output-only diagnostics.
 */
export function workflowToRunResult(wfr: WorkflowRunResult): RunResult {
  const cases = wfr.nodeResults.flatMap((node) => (node.outcomes ?? (node.outcome ? [node.outcome] : [])).map((outcome) => ({ ...nodeOutcome(node, outcome), entryId: node.nodeId })));
  const skipped = cases.filter((c) => c.skipped).length;
  const passed = cases.filter((c) => !c.skipped && c.passed).length;
  const failed = cases.filter((c) => !c.skipped && !c.passed).length;
  return {
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

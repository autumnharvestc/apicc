import type { RunResult, CaseOutcome } from "../report/types.js";
import type { WorkflowRunResult, NodeResult } from "./runner.js";

function nodeOutcome(node: NodeResult, outcome: CaseOutcome): CaseOutcome {
  return outcome.nodeId ? outcome : { ...outcome, nodeId: node.nodeId };
}

function syntheticOutcome(node: NodeResult): CaseOutcome {
  const skipped = node.state === "skipped";
  const passed = node.state === "noop" || node.state === "passed";
  const message = skipped
    ? `skipped（${node.skipReason ?? "上游条件不满足或引用缺失"}）`
    : passed ? "noop（空过占位节点）" : (node.error ?? "节点执行失败");
  return {
    apiId: node.nodeId, apiName: node.label ?? node.nodeId,
    caseId: node.nodeId, caseName: node.label ?? node.nodeId,
    nodeId: node.nodeId,
    passed: skipped ? false : passed,
    skipped: skipped || undefined,
    skipReason: skipped ? node.skipReason ?? message : undefined,
    durationMs: 0,
    assertions: skipped ? [] : [{ pass: passed, message }],
    error: skipped || !passed ? node.error ?? message : undefined,
    failureKind: node.failureKind,
  };
}

function toCaseOutcomes(node: NodeResult): CaseOutcome[] {
  const outcomes = node.outcomes?.length
    ? node.outcomes.map((outcome) => nodeOutcome(node, outcome))
    : node.outcome ? [nodeOutcome(node, node.outcome)] : [];
  if (outcomes.length === 0) return [syntheticOutcome(node)];

  // Conditions may fail after the HTTP row has already passed. Keep both facts:
  // the data row and a node-level diagnostic that makes the workflow verdict visible.
  if (node.state === "failed" && outcomes.every((outcome) => outcome.passed)) {
    outcomes.push({
      apiId: node.nodeId, apiName: node.label ?? node.nodeId,
      caseId: node.nodeId, caseName: `${node.label ?? node.nodeId}（节点诊断）`,
      nodeId: node.nodeId,
      passed: false, durationMs: 0, assertions: [],
      error: node.error ?? "节点执行失败", failureKind: node.failureKind,
    });
  }
  return outcomes;
}

/**
 * WorkflowRunResult → RunResult（复用既有 Reporter 插件渲染）。
 * raw workflow 使用节点级计数；适配后的报告使用展开数据行/合成诊断级计数。
 * skipped 保持可见，但不进入 failed。
 */
export function workflowToRunResult(wfr: WorkflowRunResult): RunResult {
  const cases = wfr.nodeResults.flatMap(toCaseOutcomes);
  const skipped = cases.filter((c) => c.skipped).length;
  const passed = cases.filter((c) => !c.skipped && c.passed).length;
  const failed = cases.filter((c) => !c.skipped && !c.passed).length;
  return {
    collectionId: wfr.workflowId,
    collectionName: wfr.workflowName,
    envName: undefined,
    startedAt: wfr.startedAt, finishedAt: wfr.finishedAt,
    total: cases.length, passed, failed, skipped,
    cases,
    warnings: wfr.warnings,
  };
}

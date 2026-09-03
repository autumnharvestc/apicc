import type { RunResult, CaseOutcome } from "../report/types.js";
import type { WorkflowRunResult, NodeResult } from "./runner.js";

function toCaseOutcome(node: NodeResult): CaseOutcome {
  if (node.outcome) return node.outcome;
  const message = node.state === "skipped" ? "skipped（上游条件不满足或引用缺失）" : "noop（空过占位节点）";
  return {
    apiId: node.nodeId, apiName: node.label ?? node.nodeId,
    caseId: node.nodeId, caseName: node.label ?? node.nodeId,
    passed: node.state === "noop", durationMs: 0,
    assertions: [{ pass: node.state === "noop", message }],
    error: node.error ?? message,
  };
}

/**
 * WorkflowRunResult → RunResult（复用既有 Reporter 插件渲染）。
 * skipped→passed:false 的映射决策（控制者裁定，保持）：skipped 在报告中计为失败以可见
 * （避免静默吞掉未执行节点），noop 为通过；WorkflowRunResult 自身的 passed/failed/skipped
 * 三计数仍由执行器口径给出，此处的 passed/failed 是报告口径（skipped 归入 failed）。
 * 口径裁定（M2-B 最终审查 I6）：「skipped 计为 failed（报告可见）与退出码 0（spec §7）」
 * 的双口径为 M2-B 既定裁定；CI 消费前须重新裁定（M2-C 前置）。
 */
export function workflowToRunResult(wfr: WorkflowRunResult): RunResult {
  const cases = wfr.nodeResults.map(toCaseOutcome);
  return {
    collectionId: wfr.workflowId,
    collectionName: wfr.workflowName,
    envName: undefined,
    startedAt: wfr.startedAt, finishedAt: wfr.finishedAt,
    total: cases.length,
    passed: cases.filter((c) => c.passed).length,
    failed: cases.filter((c) => !c.passed).length,
    cases,
    warnings: wfr.warnings,
  };
}

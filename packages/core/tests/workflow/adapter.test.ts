import { describe, expect, it } from "vitest";
import { workflowToRunResult } from "../../src/workflow/adapter.js";
import type { WorkflowRunResult } from "../../src/workflow/runner.js";

const sample: WorkflowRunResult = {
  workflowId: "wf", workflowName: "条件流", status: "enabled",
  nodeResults: [
    { nodeId: "n1", label: "one", kind: "request", state: "passed", outcome: { apiId: "a", apiName: "a", caseId: "t", caseName: "one-用例", passed: true, durationMs: 3, assertions: [] } },
    { nodeId: "n2", label: "占位", kind: "noop", state: "noop" },
    { nodeId: "n3", label: "skip", kind: "request", state: "skipped", skipReason: "condition-pruned" },
    { nodeId: "n4", label: "bad", kind: "request", state: "failed", outcome: { apiId: "a", apiName: "a", caseId: "t", caseName: "bad-用例", passed: false, durationMs: 1, assertions: [{ pass: false, message: "eq 失败" }] } },
  ],
  total: 4, passed: 2, failed: 1, skipped: 1,
  warnings: ["边 n2 → n3 条件不满足"], startedAt: "2026-09-02T00:00:00Z", finishedAt: "2026-09-02T00:00:01Z",
};

describe("workflowToRunResult", () => {
  it("映射为 RunResult：请求节点带 outcome，noop/skipped 生成合成用例", () => {
    const r = workflowToRunResult(sample);
    expect(r.collectionName).toBe("条件流");
    expect(r.total).toBe(4);
    expect(r.cases).toHaveLength(4);
    expect(r.cases[0]!.caseName).toBe("one-用例");
    expect(r.cases[1]!.caseName).toBe("占位");
    expect(r.cases[1]!.passed).toBe(true);
    expect(r.cases[2]!.passed).toBe(false);
    expect(r.cases[2]!.skipped).toBe(true);
    expect(r.skipped).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.cases[2]!.error).toContain("skipped");
    expect(r.cases[3]!.assertions.some((a) => !a.pass)).toBe(true);
    expect(r.warnings).toEqual(["边 n2 → n3 条件不满足"]);
  });

  it("展开节点 outcomes 为完整数据行并按三态计数", () => {
    const r = workflowToRunResult({
      ...sample,
      nodeResults: [{
        nodeId: "rows", label: "批量", kind: "request", state: "failed",
        outcomes: [
          { apiId: "a", apiName: "同一接口", caseId: "c", caseName: "行一", row: 1, passed: true, durationMs: 1, assertions: [] },
          { apiId: "a", apiName: "同一接口", caseId: "c", caseName: "行二", row: 2, passed: false, durationMs: 1, assertions: [{ pass: false, message: "断言失败" }] },
          { apiId: "a", apiName: "同一接口", caseId: "c", caseName: "行三", row: 3, passed: true, durationMs: 1, assertions: [] },
        ],
      }, {
        nodeId: "empty", label: "占位", kind: "noop", state: "noop",
      }, {
        nodeId: "pruned", label: "裁剪", kind: "request", state: "skipped", skipReason: "condition-pruned",
      }],
      total: 0, passed: 0, failed: 0, skipped: 0,
    });

    expect(r.cases).toHaveLength(5);
    expect(r.cases.slice(0, 3).map((c) => c.row)).toEqual([1, 2, 3]);
    expect(r.cases.slice(0, 3).every((c) => c.nodeId === "rows")).toBe(true);
    expect(r.total).toBe(r.passed + r.failed + (r.skipped ?? 0));
    expect(r.passed).toBe(3);
    expect(r.failed).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.cases[4]!.skipped).toBe(true);
    expect(r.cases[4]!.assertions).toEqual([]);
  });

  it("节点失败但实际请求行通过时追加节点级失败诊断", () => {
    const r = workflowToRunResult({
      ...sample,
      nodeResults: [{
        nodeId: "route", label: "路由", kind: "request", state: "failed",
        failureKind: "script", error: "条件脚本失败",
        outcomes: [{ apiId: "a", apiName: "请求", caseId: "c", caseName: "成功行", row: 7, passed: true, durationMs: 2, assertions: [] }],
      }],
      total: 0, passed: 0, failed: 0, skipped: 0,
    });

    expect(r.cases).toHaveLength(2);
    expect(r.cases[0]!.passed).toBe(true);
    expect(r.cases[1]!.passed).toBe(false);
    expect(r.cases[1]!.nodeId).toBe("route");
    expect(r.cases[1]!.failureKind).toBe("script");
    expect(r.cases[1]!.error).toBe("条件脚本失败");
    expect(r.failed).toBe(1);
  });

  it("保留旧版单 outcome 形状并给相同接口的节点附带 nodeId", () => {
    const r = workflowToRunResult({
      ...sample,
      nodeResults: [
        { nodeId: "left", kind: "request", state: "passed", outcome: { apiId: "a", apiName: "同一接口", caseId: "c", caseName: "同一用例", row: 4, passed: true, durationMs: 1, assertions: [] } },
        { nodeId: "right", kind: "request", state: "passed", outcome: { apiId: "a", apiName: "同一接口", caseId: "c", caseName: "同一用例", row: 4, passed: true, durationMs: 1, assertions: [] } },
      ],
      total: 0, passed: 0, failed: 0, skipped: 0,
    });

    expect(r.cases.map((c) => c.nodeId)).toEqual(["left", "right"]);
    expect(r.cases.map((c) => c.row)).toEqual([4, 4]);
  });
});

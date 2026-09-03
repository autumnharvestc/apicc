import { describe, expect, it } from "vitest";
import { workflowToRunResult } from "../../src/workflow/adapter.js";
import type { WorkflowRunResult } from "../../src/workflow/runner.js";

const sample: WorkflowRunResult = {
  workflowId: "wf", workflowName: "条件流", status: "enabled",
  nodeResults: [
    { nodeId: "n1", label: "one", kind: "request", state: "passed", outcome: { apiId: "a", apiName: "a", caseId: "t", caseName: "one-用例", passed: true, durationMs: 3, assertions: [] } },
    { nodeId: "n2", label: "占位", kind: "noop", state: "noop" },
    { nodeId: "n3", label: "skip", kind: "request", state: "skipped" },
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
    expect(r.cases[2]!.error).toContain("skipped");
    expect(r.cases[3]!.assertions.some((a) => !a.pass)).toBe(true);
    expect(r.warnings).toEqual(["边 n2 → n3 条件不满足"]);
  });
});

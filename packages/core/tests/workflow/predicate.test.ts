import { describe, expect, it } from "vitest";
import { evaluateWorkflowPredicate } from "../../src/workflow/predicate.js";
import type { WorkflowPredicate, WorkflowValue } from "../../src/workflow/model.js";

const literal = (value: Extract<WorkflowValue, { kind: "literal" }>["value"]): WorkflowValue => ({ kind: "literal", value });
const ref = (name: string): WorkflowValue => ({ kind: "ref", source: "vars", path: [name] });
const context = { inputs: {}, vars: { value: null, nested: { items: [3] } }, env: {}, previous: {}, error: {}, loop: {} };
describe("declarative workflow predicates", () => {
  it("distinguishes missing from null and only reads own JSON fields", () => {
    expect(evaluateWorkflowPredicate({ op: "exists", value: ref("value") }, context).kind).toBe("matched");
    expect(evaluateWorkflowPredicate({ op: "exists", value: ref("missing") }, context).kind).toBe("pruned");
    expect(evaluateWorkflowPredicate({ op: "notExists", value: ref("toString") }, context).kind).toBe("matched");
    expect(evaluateWorkflowPredicate({ op: "eq", left: ref("missing"), right: literal(null) }, context).kind).toBe("error");
    expect(evaluateWorkflowPredicate({ op: "eq", left: { kind: "ref", source: "vars", path: ["nested", "items", 0] }, right: literal(3) }, context).kind).toBe("matched");
  });
  it("compares JSON contents without coercion and requires same scalar type for ordering", () => {
    expect(evaluateWorkflowPredicate({ op: "eq", left: literal({ a: 1, b: [null] }), right: literal({ b: [null], a: 1 }) }, context).kind).toBe("matched");
    expect(evaluateWorkflowPredicate({ op: "neq", left: literal(1), right: literal("1") }, context).kind).toBe("matched");
    for (const [left, right] of [[1, "2"], [null, null], [true, false], [{}, {}]]) {
      expect(evaluateWorkflowPredicate({ op: "lt", left: literal(left!), right: literal(right!) }, context).kind).toBe("error");
    }
    expect(evaluateWorkflowPredicate({ op: "gte", left: literal("b"), right: literal("a") }, context).kind).toBe("matched");
  });
  it("short circuits valid ASTs but validates the entire structure and budgets first", () => {
    const yes: WorkflowPredicate = { op: "exists", value: ref("value") };
    const no: WorkflowPredicate = { op: "not", item: yes };
    const error: WorkflowPredicate = { op: "eq", left: ref("missing"), right: literal(null) };
    expect(evaluateWorkflowPredicate({ op: "or", items: [yes, error] }, context).kind).toBe("matched");
    expect(evaluateWorkflowPredicate({ op: "and", items: [no, error] }, context).kind).toBe("pruned");
    expect(evaluateWorkflowPredicate({ op: "or", items: [yes, { op: "and", items: [] }] }, context).kind).toBe("error");
    let deep: WorkflowPredicate = yes;
    for (let i = 0; i < 32; i++) deep = { op: "not", item: deep };
    expect(evaluateWorkflowPredicate(deep, context).kind).toBe("error");
    expect(evaluateWorkflowPredicate({ op: "or", items: Array.from({ length: 256 }, () => yes) }, context).kind).toBe("error");
    expect(evaluateWorkflowPredicate({ op: "exists", value: { kind: "ref", source: "vars", path: Array(65).fill("x") } }, context).kind).toBe("error");
  });
});

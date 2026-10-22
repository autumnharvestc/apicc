import { describe, expect, it } from "vitest";
import { WorkflowEdgeSchema, WorkflowSchema, WorkflowStatusSchema, WorkflowPredicateSchema, type WorkflowPredicate } from "../../src/workflow/model.js";

describe("工作流 schema", () => {
  it("preserves own dictionary names through v2 JSON round trips and rejects empty names", () => {
    const raw = JSON.parse('{"id":"names","name":"names","executionVersion":2,"inputs":{"__proto__":{"required":true}},"outputs":{"__proto__":{"kind":"literal","value":"token"}},"nodes":[{"id":"assign","kind":"assign","assignments":{"__proto__":{"kind":"literal","value":"token"}}},{"id":"call","kind":"subflow","workflowId":"child","inputs":{"__proto__":{"kind":"literal","value":"token"}},"outputs":{"__proto__":"result"}}]}');
    const parsed = WorkflowSchema.parse(raw);
    if (parsed.executionVersion !== 2) throw new Error("Expected v2");
    const assign = parsed.nodes[0]!; const call = parsed.nodes[1]!;
    if (assign.kind !== "assign" || call.kind !== "subflow") throw new Error("Expected assign and subflow");
    for (const dictionary of [parsed.inputs, parsed.outputs, assign.assignments, call.inputs, call.outputs]) expect(Object.keys(dictionary)).toEqual(["__proto__"]);
    expect(WorkflowSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(() => WorkflowSchema.parse({ ...raw, inputs: { "": { required: true } } })).toThrow();
  });
  it("bounds declarative predicate recursion, size and reference paths before recursive parsing", () => {
    const exists = { op: "exists" as const, value: { kind: "ref" as const, source: "inputs" as const, path: [] } };
    let predicate: WorkflowPredicate = exists;
    for (let index = 0; index < 31; index++) predicate = { op: "not", item: predicate };
    expect(WorkflowPredicateSchema.safeParse(predicate).success).toBe(true);
    expect(WorkflowPredicateSchema.safeParse({ op: "not", item: predicate }).success).toBe(false);
    expect(WorkflowPredicateSchema.safeParse({ op: "and", items: Array.from({ length: 256 }, () => exists) }).success).toBe(false);
    expect(WorkflowPredicateSchema.safeParse({ op: "or", items: [] }).success).toBe(false);
    expect(WorkflowPredicateSchema.safeParse({ ...exists, value: { ...exists.value, path: Array(65).fill("x") } }).success).toBe(false);
    const cycle: { op: "not"; item?: unknown } = { op: "not" }; cycle.item = cycle;
    expect(WorkflowPredicateSchema.safeParse(cycle).success).toBe(false);
  });
  it("round trips strict v2 control nodes and rejects version or policy reinterpretation", () => {
    const value = WorkflowSchema.parse({ id: "flow", name: "flow", executionVersion: 2,
      inputs: { token: { required: false, default: null } }, outputs: { token: { kind: "ref", source: "vars", path: ["token"] } },
      nodes: [{ id: "wait", kind: "delay", delayMs: 0 }], edges: [] });
    expect(value.executionVersion).toBe(2);
    expect(value.nodes[0]).toEqual({ id: "wait", kind: "delay", delayMs: 0 });
    expect(() => WorkflowSchema.parse({ ...value, executionVersion: 99 })).toThrow();
    expect(() => WorkflowSchema.parse({ ...value, executionVersion: 1 })).toThrow();
    expect(() => WorkflowSchema.parse({ ...value, nodes: [{ id: "wait", kind: "delay", delayMs: 0, policy: { retry: { maxAttempts: 2 } } }] })).toThrow();
    const literal = { kind: "literal", value: null };
    const predicate = { op: "eq", left: literal, right: literal };
    const nodes = [
      { id: "request", kind: "request", apiId: "api", caseId: "case", policy: { timeoutMs: 25, retry: { maxAttempts: 2, retryOn: ["transport"], delayMs: 4, backoff: "exponential", allowRepeatSideEffects: true }, onError: { workflowId: "handler", mode: "recover", timeoutMs: 10 }, finally: { workflowId: "cleanup", timeoutMs: 10 } } },
      { id: "assign", kind: "assign", assignments: { token: literal } }, { id: "assert", kind: "assert", predicate },
      { id: "condition", kind: "condition", predicate }, { id: "subflow", kind: "subflow", workflowId: "child", inputs: { token: literal }, outputs: { result: "token" } },
      { id: "loop", kind: "loop", workflowId: "child", while: predicate, until: predicate, maxIterations: 4 },
      { id: "parallel", kind: "parallel", join: "any-success", branches: [{ id: "one", workflowId: "child" }, { id: "two", workflowId: "child" }] },
    ];
    const configured = WorkflowSchema.parse({ ...value, nodes, edges: [{ id: "port", from: "condition", to: "assign", port: "true" }] });
    expect(WorkflowSchema.parse(JSON.parse(JSON.stringify(configured)))).toEqual(configured);
    expect(configured.nodes.map((node) => node.kind)).toEqual(["request", "assign", "assert", "condition", "subflow", "loop", "parallel"]);
  });
  it("接受合法工作流并填充默认值", () => {
    const wf = WorkflowSchema.parse({
      id: "w1", name: "下单流程",
      nodes: [
        { id: "n1", kind: "request", apiId: "a1", caseId: "c1", label: "登录" },
        { id: "n3", kind: "noop", label: "退款占位" },
      ],
      edges: [{ id: "e1", from: "n1", to: "n3" }],
    });
    expect(wf.status).toBe("draft");
    expect(wf.nodes[1]!.kind).toBe("noop");
    expect("condition" in wf.edges[0]! ? wf.edges[0]!.condition : undefined).toBeUndefined();
  });

  it("拒绝未知字段与非法状态/节点类型", () => {
    expect(() => WorkflowSchema.parse({ id: "w", name: "x", nonsense: 1 })).toThrow();
    expect(() => WorkflowStatusSchema.parse("archived")).toThrow();
    expect(() => WorkflowSchema.parse({ id: "w", name: "x", nodes: [{ id: "n", kind: "timer" }], edges: [] })).toThrow();
    // position 内层对象同样 strict：未知字段报错防静默丢失（R1 修复）
    expect(() =>
      WorkflowSchema.parse({ id: "w", name: "x", nodes: [{ id: "n", kind: "request", apiId: "a", caseId: "c", position: { x: 1, y: 2, z: 3 } }], edges: [] }),
    ).toThrow();
    // 边元素未知字段直接拒绝（R1 补 strict 拒绝路径直测）
    expect(() => WorkflowEdgeSchema.parse({ id: "e", from: "a", to: "b", nonsense: 1 })).toThrow();
  });

  it("position 字段（M2-B 预留）合法且可选", () => {
    const wf = WorkflowSchema.parse({
      id: "w", name: "x",
      nodes: [{ id: "n", kind: "request", apiId: "a", caseId: "c", position: { x: 10, y: -20 } }],
      edges: [],
    });
    expect(wf.nodes[0]!.position).toEqual({ x: 10, y: -20 });
  });
});

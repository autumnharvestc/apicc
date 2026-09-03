import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkflowRunner } from "../../src/workflow/runner.js";
import type { Workflow } from "../../src/workflow/model.js";
import type { Workspace, Project } from "../../src/domain/model.js";
import { createDefaultRegistry } from "../../src/index.js";

let server: Server;
let baseUrl = "";
beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

// 夹具须在 baseUrl 就绪后构造（模块顶层求值会把空串快照进 env.variables，对位 tests/runner/runner.test.ts 先例）。
let ws: Workspace;
let project: Project;
beforeAll(async () => {
  ws = { id: "w", name: "w", variables: {}, groups: [] };
  project = {
    id: "p", name: "p", variables: {},
    environments: [{ id: "e", name: "dev", variables: { baseUrl } }],
    collections: [], workflows: [],
  };
});
const apiOf = (id: string, url: string) => ({
  id, name: id, version: "1", deprecated: false, method: "GET" as const, url, headers: [], query: [],
  cases: [{
    id: `case-${id}`, name: `${id}-用例`, scope: "base", parameters: {},
    assertions: [{ id: `as-${id}`, target: "status" as const, op: "eq" as const, expected: "200" }],
  }],
});
const apis = [apiOf("a1", "{{baseUrl}}/one"), apiOf("a2", "{{baseUrl}}/two"), apiOf("a3", "{{baseUrl}}/three")];
const resolve = (apiId: string) => apis.find((a) => a.id === apiId);
const wf = (nodes: Workflow["nodes"], edges: Workflow["edges"]): Workflow =>
  ({ id: "wf", name: "条件流", status: "enabled", nodes, edges });

describe("WorkflowRunner", () => {
  it("线性两节点顺序执行且变量跨节点携带", async () => {
    const nodes = [
      { id: "n1", kind: "request" as const, apiId: "a1", caseId: "case-a1", label: "one" },
      { id: "n2", kind: "request" as const, apiId: "a2", caseId: "case-a2", label: "two" },
    ];
    const r = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "dev", failFast: false })
      .run(wf(nodes, [{ id: "e", from: "n1", to: "n2" }]), { project, workspace: ws });
    expect(r.nodeResults.map((n) => n.nodeId)).toEqual(["n1", "n2"]);
    expect(r.total).toBe(2);
    expect(r.passed).toBe(2);
  });

  it("条件边：条件为假时下游 skipped 且级联", async () => {
    const nodes = [
      { id: "n1", kind: "request" as const, apiId: "a1", caseId: "case-a1", label: "one" },
      { id: "n2", kind: "request" as const, apiId: "a2", caseId: "case-a2", label: "two" },
      { id: "n3", kind: "request" as const, apiId: "a3", caseId: "case-a3", label: "three" },
    ];
    const edges = [
      { id: "e1", from: "n1", to: "n2", condition: "prev.passed" },
      { id: "e2", from: "n2", to: "n3", condition: "false" },
    ];
    const r = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "dev", failFast: false })
      .run(wf(nodes, edges), { project, workspace: ws });
    expect(r.nodeResults.map((n) => n.state)).toEqual(["passed", "passed", "skipped"]);
    expect(r.skipped).toBe(1);
  });

  it("noop 节点直接通过；missing 引用 skipped 带告警", async () => {
    const nodes = [
      { id: "n1", kind: "noop" as const, label: "占位" },
      { id: "n2", kind: "request" as const, apiId: "ghost", caseId: "ghost-case", label: "缺失" },
    ];
    const r = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: undefined, failFast: false })
      .run(wf(nodes, [{ id: "e", from: "n1", to: "n2" }]), { project, workspace: ws });
    expect(r.nodeResults[0]!.state).toBe("noop");
    expect(r.nodeResults[1]!.state).toBe("skipped");
    expect(r.warnings.join("\n")).toContain("不存在");
  });

  it("多入节点：任一上游通过即执行（多入多出语义）", async () => {
    const nodes = [
      { id: "a", kind: "request" as const, apiId: "a1", caseId: "case-a1", label: "A" },
      { id: "b", kind: "request" as const, apiId: "a2", caseId: "case-a2", label: "B" },
      { id: "c", kind: "request" as const, apiId: "a3", caseId: "case-a3", label: "C" },
    ];
    const edges = [
      { id: "e1", from: "a", to: "c", condition: "true" },
      { id: "e2", from: "b", to: "c", condition: "true" },
    ];
    const r = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "dev", failFast: false })
      .run(wf(nodes, edges), { project, workspace: ws });
    // a、b 都是起始节点顺序执行；c 两个入边条件均真——执行一次
    expect(r.nodeResults.filter((n) => n.nodeId === "c")).toHaveLength(1);
    expect(r.total).toBe(3);
  });

  it("条件表达式求值异常按 false 并告警", async () => {
    const nodes = [
      { id: "n1", kind: "request" as const, apiId: "a1", caseId: "case-a1", label: "one" },
      { id: "n2", kind: "request" as const, apiId: "a2", caseId: "case-a2", label: "two" },
    ];
    const r = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "dev", failFast: false })
      .run(wf(nodes, [{ id: "e", from: "n1", to: "n2", condition: "prev.missing.deep" }]), { project, workspace: ws });
    expect(r.nodeResults[1]!.state).toBe("skipped");
    expect(r.warnings.some((w) => /条件求值失败/.test(w))).toBe(true);
  });

  it("环在执行前拒绝", async () => {
    const nodes = [
      { id: "a", kind: "request" as const, apiId: "a1", caseId: "case-a1" },
      { id: "b", kind: "request" as const, apiId: "a2", caseId: "case-a2" },
    ];
    await expect(new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: undefined, failFast: false })
      .run(wf(nodes, [{ id: "e1", from: "a", to: "b" }, { id: "e2", from: "b", to: "a" }]), { project, workspace: ws }))
      .rejects.toThrow(/环/);
  });

  it("envName 未找到显式报错（resolveEnv 对齐）", async () => {
    await expect(new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "ghost", failFast: false })
      .run(wf([{ id: "n", kind: "request" as const, apiId: "a1", caseId: "case-a1" }], []), { project, workspace: ws }))
      .rejects.toThrow(/未找到环境/);
  });
});

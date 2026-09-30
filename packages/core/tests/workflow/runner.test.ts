import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkflowRunner } from "../../src/workflow/runner.js";
import type { Workflow } from "../../src/workflow/model.js";
import type { Workspace, Project, ApiDefinition } from "../../src/domain/model.js";
import { createDefaultRegistry } from "../../src/index.js";

let server: Server;
let baseUrl = "";
const seenPaths: string[] = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    seenPaths.push(req.url ?? "");
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
  ws = { id: "w", name: "w", variables: {}, globals: { variables: {}, query: [], headers: [] }, groups: [] };
  project = {
    id: "p", name: "p", variables: {},
    environments: [{ id: "e", name: "dev", variables: { baseUrl }, baseUrls: {} }],
    collections: [], workflows: [],
  };
});
const apiOf = (id: string, url: string): ApiDefinition => ({
  id, name: id, version: "1", deprecated: false, method: "GET" as const, url, headers: [], query: [],
  cases: [{
    id: `case-${id}`, name: `${id}-用例`, scope: "base", parameters: {},
    assertions: [{ id: `as-${id}`, target: "status" as const, op: "eq" as const, expected: "200" }],
  }],
});
const apis = [apiOf("a1", "{{baseUrl}}/one"), apiOf("a2", "{{baseUrl}}/two"), apiOf("a3", "{{baseUrl}}/three")];
// 必失败接口（断言 500）：级联 skipped / failFast 用例的失败源。
const badApi: ApiDefinition = {
  id: "abad", name: "abad", version: "1", deprecated: false, method: "GET", url: "{{baseUrl}}/bad", headers: [], query: [],
  cases: [{ id: "case-abad", name: "abad-用例", scope: "base", parameters: {}, assertions: [{ id: "as-abad", target: "status", op: "eq", expected: "500" }] }],
};
// 第二个必失败接口（不同 apiId）：fan-in 双败用例的另一个失败源。
const badApi2: ApiDefinition = {
  id: "abad2", name: "abad2", version: "1", deprecated: false, method: "GET", url: "{{baseUrl}}/bad2", headers: [], query: [],
  cases: [{ id: "case-abad2", name: "abad2-用例", scope: "base", parameters: {}, assertions: [{ id: "as-abad2", target: "status", op: "eq", expected: "500" }] }],
};
const resolve = (apiId: string) => apis.find((a) => a.id === apiId);
/** 追加额外接口定义的 resolve（badApi/sitApi 等局部夹具用）。 */
const resolveWith = (extras: ApiDefinition[]) => (apiId: string) => [...extras, ...apis].find((a) => a.id === apiId);
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
    expect(r.nodeResults.find((n) => n.nodeId === "n3")?.skipReason).toBe("condition-pruned");
    expect(r.verdict).toBe("passed");
    expect(r.skipped).toBe(1);
  });

  it("strict 默认在发送请求前拒绝缺失引用，即使缺失节点被假条件遮住", async () => {
    seenPaths.length = 0;
    const nodes = [
      { id: "n1", kind: "request" as const, apiId: "a1", caseId: "case-a1" },
      { id: "missing", kind: "request" as const, apiId: "ghost", caseId: "ghost-case" },
      { id: "n3", kind: "request" as const, apiId: "a2", caseId: "case-a2" },
    ];
    const result = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "dev", failFast: false })
      .run(wf(nodes, [
        { id: "e1", from: "n1", to: "missing", condition: "false" },
        { id: "e2", from: "missing", to: "n3" },
      ]), { project, workspace: ws });
    expect(result.verdict).toBe("failed");
    expect(result.nodeResults.find((n) => n.nodeId === "missing")?.state).toBe("failed");
    expect(result.nodeResults.find((n) => n.nodeId === "missing")?.failureKind).toBe("config");
    expect(result.nodeResults.find((n) => n.nodeId === "n1")?.state).toBe("skipped");
    expect(seenPaths).toEqual([]);
  });

  it("条件求值错误使源节点失败且不会伪装成剪枝", async () => {
    const result = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "dev", failFast: false })
      .run(wf([
        { id: "n1", kind: "request" as const, apiId: "a1", caseId: "case-a1" },
        { id: "n2", kind: "request" as const, apiId: "a2", caseId: "case-a2" },
      ], [{ id: "bad-edge", from: "n1", to: "n2", condition: "prev.missing.deep" }]), { project, workspace: ws });
    const source = result.nodeResults.find((n) => n.nodeId === "n1");
    expect(result.verdict).toBe("failed");
    expect(source?.state).toBe("failed");
    expect(source?.failureKind).toBe("script");
    expect(source?.error).toContain("bad-edge");
    expect(result.nodeResults.find((n) => n.nodeId === "n2")?.skipReason).toBe("upstream-failed");
  });

  it("strict=false 缺引用仍是明确 skipped/reference-missing 且整体失败", async () => {
    const result = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "dev", failFast: false, strict: false })
      .run(wf([{ id: "missing", kind: "request" as const, apiId: "ghost", caseId: "ghost-case" }], []), { project, workspace: ws });
    expect(result.nodeResults[0]?.state).toBe("skipped");
    expect(result.nodeResults[0]?.skipReason).toBe("reference-missing");
    expect(result.verdict).toBe("failed");
    expect(result.warnings.some((warning) => /不存在/.test(warning))).toBe(true);
  });

  it("noop 节点直接通过；missing 引用 skipped 带告警", async () => {
    const nodes = [
      { id: "n1", kind: "noop" as const, label: "占位" },
      { id: "n2", kind: "request" as const, apiId: "ghost", caseId: "ghost-case", label: "缺失" },
    ];
    const r = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: undefined, failFast: false, strict: false })
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

  it("级联 skipped：首节点 failed 且边无条件，下游不执行", async () => {
    const nodes = [
      { id: "n1", kind: "request" as const, apiId: "abad", caseId: "case-abad", label: "坏" },
      { id: "n2", kind: "request" as const, apiId: "a2", caseId: "case-a2", label: "two" },
      { id: "n3", kind: "request" as const, apiId: "a3", caseId: "case-a3", label: "three" },
    ];
    const r = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve: resolveWith([badApi]), envName: "dev", failFast: false })
      .run(wf(nodes, [{ id: "e1", from: "n1", to: "n2" }, { id: "e2", from: "n2", to: "n3" }]), { project, workspace: ws });
    expect(r.nodeResults.map((n) => n.state)).toEqual(["failed", "skipped", "skipped"]);
    expect(r.skipped).toBe(2);
    expect(r.total).toBe(3);
  });

  it("级联多入区分性：任一上游通过即执行，失败上游不阻断", async () => {
    const nodes = [
      { id: "a", kind: "request" as const, apiId: "a1", caseId: "case-a1", label: "A" },
      { id: "b", kind: "request" as const, apiId: "abad", caseId: "case-abad", label: "B" },
      { id: "c", kind: "request" as const, apiId: "a3", caseId: "case-a3", label: "C" },
    ];
    const edges = [
      { id: "e1", from: "a", to: "c" },
      { id: "e2", from: "b", to: "c" },
    ];
    const r = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve: resolveWith([badApi]), envName: "dev", failFast: false })
      .run(wf(nodes, edges), { project, workspace: ws });
    const c = r.nodeResults.filter((n) => n.nodeId === "c");
    expect(c).toHaveLength(1);
    expect(c[0]!.state).toBe("passed");
    expect(r.nodeResults.find((n) => n.nodeId === "b")!.state).toBe("failed");
    expect(r.total).toBe(3);
  });

  it("failFast：首节点失败即中断，后续节点 skipped，部分结果照常返回", async () => {
    const nodes = [
      { id: "n1", kind: "request" as const, apiId: "abad", caseId: "case-abad", label: "坏" },
      { id: "n2", kind: "request" as const, apiId: "a2", caseId: "case-a2", label: "two" },
      { id: "n3", kind: "request" as const, apiId: "a3", caseId: "case-a3", label: "three" },
    ];
    const r = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve: resolveWith([badApi]), envName: "dev", failFast: true })
      .run(wf(nodes, [{ id: "e1", from: "n1", to: "n2" }, { id: "e2", from: "n2", to: "n3" }]), { project, workspace: ws });
    expect(r.nodeResults.map((n) => n.state)).toEqual(["failed", "skipped", "skipped"]);
    expect(r.total).toBe(3);
    expect(r.failed).toBe(1);
    expect(r.passed).toBe(0);
    expect(r.nodeResults.find((n) => n.nodeId === "n2")?.skipReason).toBe("upstream-failed");
    expect(r.nodeResults.find((n) => n.nodeId === "n3")?.skipReason).toBe("upstream-failed");
  });

  it("悬空边端点：执行前拒绝且不发请求", async () => {
    const nodes = [{ id: "n1", kind: "request" as const, apiId: "a1", caseId: "case-a1", label: "one" }];
    await expect(new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "dev", failFast: false })
      .run(wf(nodes, [{ id: "e-bad", from: "n1", to: "ghost" }]), { project, workspace: ws })).rejects.toThrow(/端点不存在/);
  });

  it("用例 scope 与所选环境不匹配：可读失败而非崩溃", async () => {
    const sitApi: ApiDefinition = {
      id: "asit", name: "asit", version: "1", deprecated: false, method: "GET", url: "{{baseUrl}}/sit", headers: [], query: [],
      cases: [{ id: "case-asit", name: "asit-用例", scope: "sit", parameters: {}, assertions: [{ id: "as-asit", target: "status", op: "eq", expected: "200" }] }],
    };
    const r = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve: resolveWith([sitApi]), envName: "dev", failFast: false })
      .run(wf([{ id: "n1", kind: "request" as const, apiId: "asit", caseId: "case-asit", label: "sit" }], []), { project, workspace: ws });
    expect(r.nodeResults[0]!.state).toBe("failed");
    expect(r.nodeResults[0]!.error).toContain("用例不适用于当前环境");
    expect(r.nodeResults[0]!.outcome?.passed).toBe(false);
  });

  it("fan-in 双败级联：a、b 均失败 → c skipped 且计数正确", async () => {
    const nodes = [
      { id: "a", kind: "request" as const, apiId: "abad", caseId: "case-abad", label: "A" },
      { id: "b", kind: "request" as const, apiId: "abad2", caseId: "case-abad2", label: "B" },
      { id: "c", kind: "request" as const, apiId: "a3", caseId: "case-a3", label: "C" },
    ];
    const r = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve: resolveWith([badApi, badApi2]), envName: "dev", failFast: false })
      .run(wf(nodes, [{ id: "e1", from: "a", to: "c" }, { id: "e2", from: "b", to: "c" }]), { project, workspace: ws });
    expect(r.nodeResults.find((n) => n.nodeId === "a")!.state).toBe("failed");
    expect(r.nodeResults.find((n) => n.nodeId === "b")!.state).toBe("failed");
    expect(r.nodeResults.find((n) => n.nodeId === "c")!.state).toBe("skipped");
    expect(r.skipped).toBe(1);
    expect(r.total).toBe(3);
  });

  it("fan-in 出队复核：上游未决时延后处理，全失败则级联 skipped", async () => {
    // 结构：a→c、x→b、b→c。a 先失败使 c 在 b 未决时入队；声明顺序保证 c 先于 b 出队——
    // 出队时 b 尚未终态，必须延后而非照常执行；b 失败后 c 应被级联 skipped。
    const nodes = [
      { id: "a", kind: "request" as const, apiId: "abad", caseId: "case-abad", label: "A" },
      { id: "x", kind: "request" as const, apiId: "a1", caseId: "case-a1", label: "X" },
      { id: "b", kind: "request" as const, apiId: "abad2", caseId: "case-abad2", label: "B" },
      { id: "c", kind: "request" as const, apiId: "a3", caseId: "case-a3", label: "C" },
    ];
    const r = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve: resolveWith([badApi, badApi2]), envName: "dev", failFast: false })
      .run(wf(nodes, [{ id: "e1", from: "a", to: "c" }, { id: "e2", from: "x", to: "b" }, { id: "e3", from: "b", to: "c" }]), { project, workspace: ws });
    const c = r.nodeResults.filter((n) => n.nodeId === "c");
    expect(c).toHaveLength(1);
    expect(c[0]!.state).toBe("skipped");
    expect(r.nodeResults.find((n) => n.nodeId === "b")!.state).toBe("failed");
    expect(r.skipped).toBe(1);
  });

  it("fan-in 出队复核不误伤：a 失败、b 通过 → c 仍执行一次且 passed", async () => {
    const nodes = [
      { id: "a", kind: "request" as const, apiId: "abad", caseId: "case-abad", label: "A" },
      { id: "b", kind: "request" as const, apiId: "a2", caseId: "case-a2", label: "B" },
      { id: "c", kind: "request" as const, apiId: "a3", caseId: "case-a3", label: "C" },
    ];
    const r = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve: resolveWith([badApi]), envName: "dev", failFast: false })
      .run(wf(nodes, [{ id: "e1", from: "a", to: "c" }, { id: "e2", from: "b", to: "c" }]), { project, workspace: ws });
    const c = r.nodeResults.filter((n) => n.nodeId === "c");
    expect(c).toHaveLength(1);
    expect(c[0]!.state).toBe("passed");
    expect(r.passed).toBe(2);
    expect(r.failed).toBe(1);
  });

  it("fan-in 剪枝区分性：条件剪枝的上游不算通过，另一上游失败 → c skipped", async () => {
    // a 通过但 a→c 条件为假（剪枝）；b 失败且 b→c 无条件——c 的两条入边均已定局且无一可达，
    // 不得因「a passed」误判就绪而执行。
    const nodes = [
      { id: "a", kind: "request" as const, apiId: "a1", caseId: "case-a1", label: "A" },
      { id: "b", kind: "request" as const, apiId: "abad", caseId: "case-abad", label: "B" },
      { id: "c", kind: "request" as const, apiId: "a3", caseId: "case-a3", label: "C" },
    ];
    const r = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve: resolveWith([badApi]), envName: "dev", failFast: false })
      .run(wf(nodes, [{ id: "e1", from: "a", to: "c", condition: "false" }, { id: "e2", from: "b", to: "c" }]), { project, workspace: ws });
    const c = r.nodeResults.filter((n) => n.nodeId === "c");
    expect(c).toHaveLength(1);
    expect(c[0]!.state).toBe("skipped");
    expect(r.skipped).toBe(1);
  });

  it("fan-in 剪枝不误伤：条件剪枝的上游之外，另一上游通过 → c 照常执行", async () => {
    const nodes = [
      { id: "a", kind: "request" as const, apiId: "a1", caseId: "case-a1", label: "A" },
      { id: "b", kind: "request" as const, apiId: "a2", caseId: "case-a2", label: "B" },
      { id: "c", kind: "request" as const, apiId: "a3", caseId: "case-a3", label: "C" },
    ];
    const r = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "dev", failFast: false })
      .run(wf(nodes, [{ id: "e1", from: "a", to: "c", condition: "false" }, { id: "e2", from: "b", to: "c" }]), { project, workspace: ws });
    const c = r.nodeResults.filter((n) => n.nodeId === "c");
    expect(c).toHaveLength(1);
    expect(c[0]!.state).toBe("passed");
    // a、b、c 本体均通过（剪枝只影响边，不影响 a 自身结论）。
    expect(r.passed).toBe(3);
    expect(r.skipped).toBe(0);
  });

  it("fan-in 剪枝上游不悬挂：x→b 条件为假剪掉 b，a 失败 → b、c 均级联 skipped 且不停滞", async () => {
    // b 的唯一入边被条件剪枝 → b 立即定局为 skipped（而非永远未决），c 随之级联；
    // 若 b 悬挂未决，c 将在队列中无限延后触发调度停滞。
    const nodes = [
      { id: "a", kind: "request" as const, apiId: "abad", caseId: "case-abad", label: "A" },
      { id: "x", kind: "request" as const, apiId: "a1", caseId: "case-a1", label: "X" },
      { id: "b", kind: "request" as const, apiId: "a2", caseId: "case-a2", label: "B" },
      { id: "c", kind: "request" as const, apiId: "a3", caseId: "case-a3", label: "C" },
    ];
    const r = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve: resolveWith([badApi]), envName: "dev", failFast: false })
      .run(wf(nodes, [
        { id: "e1", from: "a", to: "c" },
        { id: "e2", from: "x", to: "b", condition: "false" },
        { id: "e3", from: "b", to: "c" },
      ]), { project, workspace: ws });
    expect(r.nodeResults.find((n) => n.nodeId === "x")!.state).toBe("passed");
    expect(r.nodeResults.find((n) => n.nodeId === "a")!.state).toBe("failed");
    expect(r.nodeResults.find((n) => n.nodeId === "b")!.state).toBe("skipped");
    expect(r.nodeResults.find((n) => n.nodeId === "c")!.state).toBe("skipped");
    expect(r.skipped).toBe(2);
  });

  it("工作流层变量传递：a1 提取 token，a2/a3 断言可读（桥断开即红）", async () => {
    const tokenApi = (id: string, postScript?: string): ApiDefinition => ({
      id, name: id, version: "1", deprecated: false, method: "GET", url: `{{baseUrl}}/${id}`, headers: [], query: [],
      cases: [{
        id: `case-${id}`, name: `${id}-用例`, scope: "base", parameters: {},
        assertions: [{ id: `as-${id}`, target: "status", op: "eq", expected: "200" }],
        ...(postScript ? { postScript } : {}),
      }],
    });
    const assertToken = `if (pm.variables.get("token") !== "abc") throw new Error("token 未跨节点携带: " + pm.variables.get("token"));`;
    const locals = [
      tokenApi("s1", `pm.variables.set("token", "abc");`),
      tokenApi("s2", assertToken),
      tokenApi("s3", assertToken),
    ];
    const nodes = [
      { id: "n1", kind: "request" as const, apiId: "s1", caseId: "case-s1", label: "提取" },
      { id: "n2", kind: "request" as const, apiId: "s2", caseId: "case-s2", label: "校验二" },
      { id: "n3", kind: "request" as const, apiId: "s3", caseId: "case-s3", label: "校验三" },
    ];
    const r = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve: resolveWith(locals), envName: "dev", failFast: false })
      .run(wf(nodes, [{ id: "e1", from: "n1", to: "n2" }, { id: "e2", from: "n2", to: "n3" }]), { project, workspace: ws });
    expect(r.nodeResults.map((n) => n.state)).toEqual(["passed", "passed", "passed"]);
    expect(r.passed).toBe(3);
  });

  it("同一 runner 的并发 run 隔离 carried，且无提取 run 不继承旧 token", async () => {
    const seenSeeds = new Set<string>();
    const waiting: Array<() => void> = [];
    const barrier = createServer((req, res) => {
      const seed = String(req.headers["x-seed"] ?? "");
      if (req.url === "/first") {
        seenSeeds.add(seed);
        if (seenSeeds.size === 2) while (waiting.length > 0) waiting.shift()!();
        else waiting.push(() => res.end("ok"));
        if (seenSeeds.size === 2) res.end("ok");
        return;
      }
      res.end("ok");
    });
    await new Promise<void>((r) => barrier.listen(0, "127.0.0.1", r));
    const barrierBase = `http://127.0.0.1:${(barrier.address() as { port: number }).port}`;
    try {
      const first = apiOf("first", `${barrierBase}/first`);
      first.headers = [{ key: "x-seed", value: "{{seed}}", enabled: true }];
      first.cases[0]!.postScript = 'pm.variables.set("token", pm.variables.get("seed"));';
      const second = apiOf("second", `${barrierBase}/second`);
      second.cases[0]!.postScript = 'pm.assert(pm.variables.get("token") === pm.variables.get("seed"), "run isolation");';
      const cleanApi = apiOf("clean", `${barrierBase}/second`);
      cleanApi.cases[0]!.postScript = 'pm.assert(pm.variables.get("token") === undefined, "stale token");';
      const locals = [first, second, cleanApi];
      const runner = new WorkflowRunner({ registry: createDefaultRegistry(), resolve: resolveWith(locals), envName: "dev", failFast: false });
      const makeProject = (seed: string): Project => ({ ...project, id: `project-${seed}`, variables: { seed } });
      const makeFlow = (id: string): Workflow => ({
        id, name: id, status: "enabled",
        nodes: [
          { id: "first", kind: "request", apiId: "first", caseId: "case-first" },
          { id: "second", kind: "request", apiId: "second", caseId: "case-second" },
        ], edges: [{ id: `${id}-edge`, from: "first", to: "second" }],
      });
      const [a, b] = await Promise.all([
        runner.run(makeFlow("A"), { project: makeProject("A"), workspace: ws }),
        runner.run(makeFlow("B"), { project: makeProject("B"), workspace: ws }),
      ]);
      expect(a.nodeResults.map((n) => n.state)).toEqual(["passed", "passed"]);
      expect(b.nodeResults.map((n) => n.state)).toEqual(["passed", "passed"]);

      const clean = await runner.run({ id: "clean", name: "clean", status: "enabled", nodes: [{ id: "clean", kind: "request", apiId: "clean", caseId: "case-clean" }], edges: [] }, { project: makeProject("C"), workspace: ws });
      expect(clean.nodeResults[0]!.state).toBe("passed");
    } finally {
      await new Promise<void>((r) => barrier.close(() => r()));
    }
  });

  it("数据驱动节点保留全部零基数据行并由聚合结论决定节点状态", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-workflow-"));
    const sourcePath = join(dir, "rows.json");
    writeFileSync(sourcePath, JSON.stringify([{ expected: "200" }, { expected: "500" }, { expected: "200" }]));
    const dataApi: ApiDefinition = {
      ...apiOf("data", "{{baseUrl}}/rows"),
      cases: [{
        id: "case-data", name: "data", scope: "base", parameters: {},
        dataDriver: { sourcePath, format: "json" },
        assertions: [{ id: "status", target: "status", op: "eq", expected: "{{expected}}" }],
      }],
    };
    try {
      const result = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve: resolveWith([dataApi]), envName: "dev", failFast: false })
        .run(wf([{ id: "data", kind: "request", apiId: "data", caseId: "case-data" }], []), { project, workspace: ws });
      expect(result.nodeResults[0]?.state).toBe("failed");
      expect(result.nodeResults[0]?.outcomes?.map((o) => o.passed)).toEqual([true, false, true]);
      expect(result.nodeResults[0]?.outcomes?.map((o) => o.row)).toEqual([0, 1, 2]);
      expect(result.nodeResults[0]?.outcome?.passed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("数据驱动全行通过与首行失败（failFast=false）均保留完整执行行", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-workflow-"));
    const passPath = join(dir, "pass.json");
    const firstFailPath = join(dir, "first-fail.json");
    writeFileSync(passPath, JSON.stringify([{ expected: "200" }, { expected: "200" }]));
    writeFileSync(firstFailPath, JSON.stringify([{ expected: "500" }, { expected: "200" }]));
    const makeApi = (id: string, sourcePath: string): ApiDefinition => ({
      ...apiOf(id, `{{baseUrl}}/${id}`),
      cases: [{ id: `case-${id}`, name: id, scope: "base", parameters: {}, dataDriver: { sourcePath, format: "json" }, assertions: [{ id: "status", target: "status", op: "eq", expected: "{{expected}}" }] }],
    });
    try {
      const runner = new WorkflowRunner({ registry: createDefaultRegistry(), resolve: resolveWith([makeApi("all-pass", passPath), makeApi("first-fail", firstFailPath)]), envName: "dev", failFast: false });
      const allPass = await runner.run(wf([{ id: "pass", kind: "request", apiId: "all-pass", caseId: "case-all-pass" }], []), { project, workspace: ws });
      const firstFail = await runner.run(wf([{ id: "fail", kind: "request", apiId: "first-fail", caseId: "case-first-fail" }], []), { project, workspace: ws });
      expect(allPass.nodeResults[0]?.state).toBe("passed");
      expect(allPass.nodeResults[0]?.outcomes?.map((outcome) => outcome.passed)).toEqual([true, true]);
      expect(firstFail.nodeResults[0]?.state).toBe("failed");
      expect(firstFail.nodeResults[0]?.outcomes?.map((outcome) => outcome.passed)).toEqual([false, true]);
      expect(firstFail.nodeResults[0]?.outcomes?.map((outcome) => outcome.row)).toEqual([0, 1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("数据驱动 failFast 仅保留实际执行行且配置错误作为节点失败", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-workflow-"));
    const sourcePath = join(dir, "rows.json");
    writeFileSync(sourcePath, JSON.stringify([{ expected: "500" }, { expected: "200" }]));
    const dataApi: ApiDefinition = {
      ...apiOf("data-fast", "{{baseUrl}}/rows"),
      cases: [{ id: "case-data-fast", name: "data-fast", scope: "base", parameters: {}, dataDriver: { sourcePath, format: "json" }, assertions: [{ id: "status", target: "status", op: "eq", expected: "{{expected}}" }] }],
    };
    try {
      const fast = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve: resolveWith([dataApi]), envName: "dev", failFast: true })
        .run(wf([{ id: "data", kind: "request", apiId: "data-fast", caseId: "case-data-fast" }], []), { project, workspace: ws });
      expect(fast.nodeResults[0]?.state).toBe("failed");
      expect(fast.nodeResults[0]?.outcomes?.map((o) => o.row)).toEqual([0]);
      const bad = { ...dataApi, id: "bad-data", cases: [{ ...dataApi.cases[0]!, id: "case-bad", dataDriver: { sourcePath: join(dir, "missing.json"), format: "json" as const } }] };
      const config = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve: resolveWith([bad]), envName: "dev", failFast: false })
        .run(wf([{ id: "bad", kind: "request", apiId: "bad-data", caseId: "case-bad" }], []), { project, workspace: ws });
      expect(config.nodeResults[0]?.state).toBe("failed");
      expect(config.nodeResults[0]?.outcomes?.[0]?.failureKind).toBe("config");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("条件边的 prev.passed 使用数据行聚合结论而非首行结果", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-workflow-"));
    const sourcePath = join(dir, "rows.json");
    writeFileSync(sourcePath, JSON.stringify([{ expected: "200" }, { expected: "500" }]));
    const dataApi: ApiDefinition = {
      ...apiOf("aggregate", "{{baseUrl}}/aggregate"),
      cases: [{ id: "case-aggregate", name: "aggregate", scope: "base", parameters: {}, dataDriver: { sourcePath, format: "json" }, assertions: [{ id: "status", target: "status", op: "eq", expected: "{{expected}}" }] }],
    };
    try {
      const result = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve: resolveWith([dataApi]), envName: "dev", failFast: false })
        .run(wf([
          { id: "aggregate", kind: "request", apiId: "aggregate", caseId: "case-aggregate" },
          { id: "next", kind: "noop" },
        ], [{ id: "edge", from: "aggregate", to: "next", condition: "prev.passed" }]), { project, workspace: ws });
      expect(result.nodeResults.find((node) => node.nodeId === "aggregate")?.state).toBe("failed");
      expect(result.nodeResults.find((node) => node.nodeId === "next")?.state).toBe("skipped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("条件脚本只能看到深度只读快照，修改 outcomes 不影响节点结果", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-workflow-"));
    const sourcePath = join(dir, "rows.json");
    writeFileSync(sourcePath, JSON.stringify([{ expected: "200" }, { expected: "200" }]));
    const dataApi: ApiDefinition = {
      ...apiOf("snapshot", "{{baseUrl}}/snapshot"),
      cases: [{ id: "case-snapshot", name: "snapshot", scope: "base", parameters: {}, dataDriver: { sourcePath, format: "json" }, assertions: [{ id: "status", target: "status", op: "eq", expected: "{{expected}}" }] }],
    };
    try {
      const result = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve: resolveWith([dataApi]), envName: "dev", failFast: false })
        .run(wf([
          { id: "snapshot", kind: "request", apiId: "snapshot", caseId: "case-snapshot" },
          { id: "next", kind: "noop" },
        ], [{ id: "edge", from: "snapshot", to: "next", condition: "(prev.outcomes[0].assertions[0].pass = false, prev.outcomes.length = 0, true)" }]), { project, workspace: ws });
      const snapshotNode = result.nodeResults.find((node) => node.nodeId === "snapshot");
      expect(result.nodeResults.find((node) => node.nodeId === "next")?.state).toBe("noop");
      expect(snapshotNode?.outcomes?.map((outcome) => outcome.passed)).toEqual([true, true]);
      expect(snapshotNode?.outcomes?.map((outcome) => outcome.row)).toEqual([0, 1]);
      expect(snapshotNode?.outcomes?.[0]?.assertions[0]?.pass).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("项目 API 优先且保留模块/两层祖先操作，只执行目标 API", async () => {
    seenPaths.length = 0;
    const append = (id: string, value: string) => ({ id, type: "script" as const, content: `pm.variables.set("trace", (pm.variables.get("trace") ?? "") + "${value}");` });
    const target: ApiDefinition = {
      id: "same-id", name: "project-target", version: "1", deprecated: false, method: "GET",
      url: "{{baseUrl}}/{{moduleVar}}/{{trace}}", headers: [], query: [],
      cases: [{ id: "case-project-target", name: "target", scope: "base", parameters: {}, assertions: [{ id: "status", target: "status", op: "eq", expected: "200" }] }],
    };
    const other: ApiDefinition = { ...apiOf("other", `${baseUrl}/should-not-run`), cases: [{ id: "case-other", name: "other", scope: "base", parameters: {}, assertions: [] }] };
    const inner = {
      id: "inner", name: "inner", apis: [target], folders: [], preOperations: [append("inner-pre", "I")], postOperations: [append("inner-post", "i")],
    };
    const outer = {
      id: "outer", name: "outer", apis: [other], folders: [inner], preOperations: [append("outer-pre", "O")], postOperations: [append("outer-post", "o")],
    };
    const collection = {
      id: "module", name: "module", variables: { moduleVar: "module" }, apis: [], folders: [outer],
      preOperations: [append("module-pre", "M")], postOperations: [{ id: "module-post", type: "script" as const, content: 'pm.variables.set("after", (pm.variables.get("trace") ?? "") + "m");' }],
    };
    const projectWithModule: Project = {
      ...project,
      environments: [{ ...project.environments[0]!, baseUrls: { module: `${baseUrl}/module` } }],
      collections: [collection],
    };
    const external: ApiDefinition = { ...apiOf("same-id", `${baseUrl}/external`), cases: [{ id: "case-project-target", name: "external", scope: "base", parameters: {}, assertions: [{ id: "status", target: "status", op: "eq", expected: "200" }] }] };
    const runner = new WorkflowRunner({ registry: createDefaultRegistry(), resolve: () => external, envName: "dev", failFast: false });
    const result = await runner.run({
      id: "project-context", name: "project-context", status: "enabled",
      nodes: [{ id: "target", kind: "request", apiId: "same-id", caseId: "case-project-target" }, { id: "done", kind: "noop" }],
      edges: [{ id: "after", from: "target", to: "done", condition: "vars.after === 'MOIiom'" }],
    }, { project: projectWithModule, workspace: ws });
    expect(result.nodeResults.find((node) => node.nodeId === "target")?.state).toBe("passed");
    expect(result.nodeResults.find((node) => node.nodeId === "done")?.state).toBe("noop");
    expect(seenPaths).toEqual(["/module/module/MOI"]);
  });

  it("条件上下文 env 继承链：sit extends dev 时父环境变量在条件中可见", async () => {
    const chainProject: Project = {
      ...project,
      environments: [
        { id: "e-dev", name: "dev", variables: { baseUrl, tier: "base" }, baseUrls: {} },
        { id: "e-sit", name: "sit", extends: "dev", variables: {}, baseUrls: {} },
      ],
    };
    const nodes = [
      { id: "n1", kind: "request" as const, apiId: "a1", caseId: "case-a1", label: "one" },
      { id: "n2", kind: "request" as const, apiId: "a2", caseId: "case-a2", label: "two" },
    ];
    const r = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "sit", failFast: false })
      .run(wf(nodes, [{ id: "e1", from: "n1", to: "n2", condition: `env.tier === 'base'` }]), { project: chainProject, workspace: ws });
    // 父环境 dev 的 tier 经继承链对条件可见 → 条件为真 → 下游执行。
    expect(r.nodeResults.map((n) => n.state)).toEqual(["passed", "passed"]);
  });

  it("工作流引用保留同 caseId 的 base/dev/sit 版本并交给 CollectionRunner 覆盖", async () => {
    const scopedApi: ApiDefinition = {
      id: "scoped", name: "scoped", version: "1", deprecated: false, method: "GET", url: `${baseUrl}/{{which}}`, headers: [], query: [],
      cases: [
        { id: "same-case", name: "base", scope: "base", parameters: { which: "base" }, assertions: [{ id: "status", target: "status", op: "eq", expected: "200" }] },
        { id: "same-case", name: "dev", scope: "dev", parameters: { which: "dev" }, assertions: [{ id: "status", target: "status", op: "eq", expected: "200" }] },
        { id: "same-case", name: "sit", scope: "sit", parameters: { which: "sit" }, assertions: [{ id: "status", target: "status", op: "eq", expected: "200" }] },
      ],
    };
    const scopedProject: Project = {
      ...project,
      environments: [
        { id: "e-dev", name: "dev", variables: { baseUrl }, baseUrls: {} },
        { id: "e-sit", name: "sit", extends: "dev", variables: {}, baseUrls: {} },
      ],
    };
    const run = async (envName: string | undefined) => {
      seenPaths.length = 0;
      const result = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve: (id) => id === "scoped" ? scopedApi : undefined, envName, failFast: false })
        .run(wf([{ id: "scoped-node", kind: "request", apiId: "scoped", caseId: "same-case" }], []), { project: scopedProject, workspace: ws });
      return { result, path: seenPaths[0] };
    };
    expect((await run("sit")).path).toBe("/sit");
    expect((await run("dev")).path).toBe("/dev");
    expect((await run(undefined)).path).toBe("/base");
  });

  it("悬空 from 边：执行前拒绝", async () => {
    // 边的 from 端点不存在：该边永不求值，n1 因入度虚增不被入队 → 只能 skipped；
    // 运行结果 warnings 必须携带结构校验的端点错误，诊断可见。
    const nodes = [{ id: "n1", kind: "request" as const, apiId: "a1", caseId: "case-a1", label: "one" }];
    await expect(new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "dev", failFast: false })
      .run(wf(nodes, [{ id: "e2", from: "ghost", to: "n1" }]), { project, workspace: ws })).rejects.toThrow(/端点不存在/);
  });

  it("条件上下文 env：环境变量在条件中可读；无环境时空对象", async () => {
    const localProject: Project = {
      ...project,
      environments: [{ id: "e", name: "dev", variables: { baseUrl, deploy: "yes" }, baseUrls: {} }],
    };
    const nodes = [
      { id: "n1", kind: "request" as const, apiId: "a1", caseId: "case-a1", label: "one" },
      { id: "n2", kind: "request" as const, apiId: "a2", caseId: "case-a2", label: "two" },
    ];
    const r = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "dev", failFast: false })
      .run(wf(nodes, [{ id: "e1", from: "n1", to: "n2", condition: "env.deploy === 'yes'" }]), { project: localProject, workspace: ws });
    expect(r.nodeResults.map((n) => n.state)).toEqual(["passed", "passed"]);
    // 无环境时 env 为空对象：deploy 未定义 → 条件为真 → 同样流转。
    // 用 noop 节点避免请求节点在无环境下因 {{baseUrl}} 无法解析而自身失败（与本断言无关）。
    const noopNodes = [
      { id: "n1", kind: "noop" as const, label: "占位一" },
      { id: "n2", kind: "noop" as const, label: "占位二" },
    ];
    const r2 = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: undefined, failFast: false })
      .run(wf(noopNodes, [{ id: "e1", from: "n1", to: "n2", condition: "env.deploy === undefined" }]), { project: localProject, workspace: ws });
    expect(r2.nodeResults.map((n) => n.state)).toEqual(["noop", "noop"]);
  });
});

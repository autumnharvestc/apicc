import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkflowRunner } from "../../src/workflow/runner.js";
import type { Workflow } from "../../src/workflow/model.js";
import type { Workspace, Project, ApiDefinition } from "../../src/domain/model.js";
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
  ws = { id: "w", name: "w", variables: {}, globals: { variables: {}, query: [], headers: [] }, groups: [] };
  project = {
    id: "p", name: "p", variables: {},
    environments: [{ id: "e", name: "dev", variables: { baseUrl }, baseUrls: {} }],
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
  });

  it("悬空边端点：忽略该边并告警，不阻断运行", async () => {
    const nodes = [{ id: "n1", kind: "request" as const, apiId: "a1", caseId: "case-a1", label: "one" }];
    const r = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "dev", failFast: false })
      .run(wf(nodes, [{ id: "e-bad", from: "n1", to: "ghost" }]), { project, workspace: ws });
    expect(r.nodeResults.map((n) => n.state)).toEqual(["passed"]);
    expect(r.warnings.join("\n")).toContain("指向不存在的节点");
    expect(r.passed).toBe(1);
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

  it("悬空 from 边：下游静默 skipped 必须留有端点告警", async () => {
    // 边的 from 端点不存在：该边永不求值，n1 因入度虚增不被入队 → 只能 skipped；
    // 运行结果 warnings 必须携带结构校验的端点错误，诊断可见。
    const nodes = [{ id: "n1", kind: "request" as const, apiId: "a1", caseId: "case-a1", label: "one" }];
    const r = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "dev", failFast: false })
      .run(wf(nodes, [{ id: "e2", from: "ghost", to: "n1" }]), { project, workspace: ws });
    expect(r.nodeResults.map((n) => n.state)).toEqual(["skipped"]);
    expect(r.warnings.join("\n")).toContain("端点不存在");
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

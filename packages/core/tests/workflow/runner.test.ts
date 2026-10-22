import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WorkflowRunner as ProjectSnapshotWorkflowRunner, type WorkflowCaseObserver } from "../../src/workflow/runner.js";
import type { WorkflowV1 as Workflow } from "../../src/workflow/model.js";
import type { ApiAsset, RequestBody } from "../../src/contract/model.js";
import type { ContractCollection, ContractFolder, ContractProject } from "../../src/contract/workspace.js";
import type { Assertion, Environment, KeyValuePair, Operation } from "../../src/domain/common.js";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import { prepareTestData, testDataSelectionsForRequests } from "../../src/testing/data.js";
import { findProjectApi } from "../../src/workflow/references.js";
import { resolveExecutionEnvironment, selectEffectiveCases } from "../../src/domain/executionSelection.js";
import type { ProjectExecutionRun } from "../../src/runner/runner.js";
import { createDefaultRegistry, createPluginRegistry } from "../../src/index.js";
import { workflowToRunResult } from "../../src/workflow/adapter.js";
import { reportingUnits } from "../../src/report/units.js";
import { WorkflowSchema } from "../../src/workflow/model.js";
import { createWorkflowScope, WORKFLOW_DELETE } from "../../src/workflow/scope.js";
import { createWorkflowInvocation } from "../../src/workflow/trace.js";
import { createContractExecutionProject, contractExecutionIds as childIds } from "../helpers/contractExecutionFixtures.js";
import { compileWorkflowPlan, workflowPlanRequests } from "../../src/workflow/plan.js";
import { createHttpSession, type HttpSession } from "../../src/http/session.js";
import type { ProtocolClient } from "../../src/plugin/types.js";
import { createExecutionEvidenceCollector } from "../../src/report/evidence.js";

describe("v2 parallel execution", () => {
  const literal = (value: unknown) => ({ kind: "literal", value });
  const ref = (source: string, name: string) => ({ kind: "ref", source, path: [name] });
  const branch = (id: string, target = id, workflowId = "leaf") => ({ id, workflowId, inputs: { who: literal(id) }, outputs: { value: target } });
  function fixture(join: string, branches: unknown[] = [branch("left"), branch("right")], tail: unknown[] = [], extra: unknown[] = [], maxConcurrency = 2) {
    const asset = fixtureApiAsset(apiOf("parallel", "https://example.com/{{who}}"));
    asset.cases[0]!.extractors = [{ id: "value", name: "value", method: "value", selector: { target: "bodyJson", path: "$.value" }, required: true, sensitive: true }];
    const call = { id: "parallel", kind: "parallel", join, branches };
    const root = WorkflowSchema.parse({ id: "root", name: "root", executionVersion: 2, limits: { maxConcurrency }, nodes: [call, ...tail], edges: tail.map((node, i) => ({ id: `e${i}`, from: i ? (tail[i - 1] as { id: string }).id : call.id, to: (node as { id: string }).id })) });
    const leaf = WorkflowSchema.parse({ id: "leaf", name: "leaf", executionVersion: 2, inputs: { who: { required: true } }, outputs: { value: ref("vars", "value") },
      nodes: [{ id: "copy", kind: "assign", assignments: { who: ref("inputs", "who"), private: literal("private") } }, { id: "request", kind: "request", apiId: asset.contract.id, caseId: asset.cases[0]!.id }], edges: [{ id: "e", from: "copy", to: "request" }] });
    const run = v2Execution(root, [{ id: stableId("collection", "parallel"), name: "parallel", variables: {}, apis: [asset], folders: [], preOperations: [], postOperations: [] }]);
    return { ...run, snapshot: createProjectSnapshot({ ...run.snapshot.project, workflows: [root, leaf, ...extra.map((flow) => WorkflowSchema.parse(flow))] } as ContractProject) };
  }
  function registry(execute: ProtocolClient["execute"]) {
    const selected = createDefaultRegistry();
    selected.registerProtocol({ name: "http", canHandle: () => true, execute });
    return selected;
  }
  const response = (value: string) => ({ status: 200, headers: {}, rawHeaders: [], bodyText: JSON.stringify({ value }), timeMs: 0 });
  function barrier() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }

  it("AND overlaps leaves, publishes only explicit outputs including legal special targets, and owns fork cleanup", async () => {
    const gate = barrier(); const entered = barrier(); let active = 0;
    const cookies: Array<string | undefined> = []; const closes: number[] = [];
    function tracked(session: HttpSession): HttpSession {
      const index = closes.push(0) - 1;
      return { ...session, fork: async () => tracked(await session.fork()), close: async () => { closes[index]!++; await session.close(); } };
    }
    const parent = tracked(createHttpSession());
    await parent.storeResponseCookies("https://example.com/", [["set-cookie", "login=parent; Path=/"]]);
    const run = fixture("all", [branch("left", "__proto__"), branch("right")], [{ id: "check", kind: "assert", predicate: { op: "and", items: [
      { op: "eq", left: ref("vars", "__proto__"), right: literal("left") }, { op: "eq", left: ref("vars", "right"), right: literal("right") },
      { op: "notExists", value: ref("vars", "private") }, { op: "notExists", value: ref("vars", "value") },
    ] } }]);
    const running = new ProjectSnapshotWorkflowRunner({ registry: registry(async (request, opts) => {
      const who = new URL(request.url).pathname.slice(1);
      cookies.push(await opts.runtime!.session!.getCookieHeader(request.url));
      await opts.runtime!.session!.storeResponseCookies(request.url, [["set-cookie", `login=${who}; Path=/`]]);
      if (++active === 2) entered.release();
      await gate.promise; active--;
      return response(who);
    }) }).run(run, "root", { httpSession: parent });
    await entered.promise;
    expect(active).toBe(2); expect(cookies).toEqual(["login=parent", "login=parent"]);
    gate.release(); const result = await running;
    expect(result.verdict).toBe("passed"); expect(result.nodeResults[0]!.outcomes).toHaveLength(2);
    expect(await parent.getCookieHeader("https://example.com/")).toBe("login=parent");
    expect(closes).toEqual([0, 1, 1]); await parent.close(); expect(closes).toEqual([1, 1, 1]);
  });

  it("AND fails when one branch fails and OR waits past an early failure for its first success", async () => {
    const selected = registry(async (request) => { const who = new URL(request.url).pathname.slice(1); if (who === "bad") throw new Error("bad branch"); return response(who); });
    const runner = new ProjectSnapshotWorkflowRunner({ registry: selected });
    const and = await runner.run(fixture("all", [branch("bad"), branch("right")], [{ id: "later", kind: "noop" }]), "root");
    expect(and.verdict).toBe("failed"); expect(and.nodeResults[0]).toMatchObject({ state: "failed" }); expect(and.nodeResults[1]).toMatchObject({ state: "skipped" });
    const or = await runner.run(fixture("any-success", [branch("bad", "winner"), branch("right", "winner")], [{ id: "check", kind: "assert", predicate: { op: "eq", left: ref("vars", "winner"), right: literal("right") } }]), "root");
    expect(or.verdict).toBe("passed"); expect(or.nodeResults[0]!.outcomes?.some((outcome) => !outcome.passed)).toBe(true);
    const allBad = await runner.run(fixture("any-success", [branch("bad"), { ...branch("bad"), id: "bad2" }]), "root");
    expect(allBad.verdict).toBe("failed"); expect(allBad.nodeResults[0]).toMatchObject({ state: "failed" });
  });

  it("OR cancels the loser, waits for noncooperative completion and collects late sensitive markers before sealing", async () => {
    const entered = barrier(); const cancelled = barrier(); const late = barrier(); let active = 0;
    const evidence = createExecutionEvidenceCollector({ projectId: "parallel", definitionRevision: "test" }, []);
    let sealed = false;
    const running = new ProjectSnapshotWorkflowRunner({ registry: registry(async (request, opts) => {
      const who = new URL(request.url).pathname.slice(1);
      if (++active === 2) entered.release();
      await entered.promise;
      if (who === "slow") { opts.signal!.addEventListener("abort", cancelled.release, { once: true }); await late.promise; }
      active--; return response(who === "slow" ? "late-secret" : who);
    }) }).run(fixture("any-success", [branch("fast", "winner"), branch("slow", "winner")], [{ id: "check", kind: "assert", predicate: { op: "eq", left: ref("vars", "winner"), right: literal("fast") } }]), "root", {
      observeCaseExecution: (execution, identity) => evidence.observe(execution, identity),
    }).then((result) => { sealed = true; return result; });
    await cancelled.promise;
    expect(sealed).toBe(false); expect(active).toBe(1);
    late.release(); const result = await running;
    expect(result.verdict).toBe("passed"); expect(active).toBe(0);
    expect(evidence.markers()).toContain("late-secret");
    expect(result.nodeResults[0]!.outcomes).toHaveLength(2);
    const safe = evidence.projectWorkflow(result);
    expect(JSON.stringify(safe)).not.toContain("late-secret");
    expect(safe.nodeResults[0]!.outcomes).toEqual([]);
    expect(safe.report!.cases).toHaveLength(2);
    expect(safe.report!.cases.every((row) => row.evidence?.identity.nodeVisitId && row.evidence.identity.invocationPath?.at(-1)?.branchId)).toBe(true);
    expect(safe.nodeResults[0]!.branches?.find((branch) => branch.winner)?.branchId).toBe("fast");
  });

  it("keeps user cancellation separate from OR winner cancellation", async () => {
    const entered = barrier(); const controller = new AbortController(); let active = 0;
    const running = new ProjectSnapshotWorkflowRunner({ registry: registry(async (_request, opts) => {
      if (++active === 2) entered.release();
      await new Promise<void>((_resolve, reject) => opts.signal!.addEventListener("abort", () => reject(opts.signal!.reason), { once: true }));
      return response("unreachable");
    }) }).run(fixture("any-success"), "root", { signal: controller.signal });
    await entered.promise; controller.abort(new Error("user stop"));
    const result = await running;
    expect(result.verdict).toBe("aborted"); expect(result.nodeResults[0]).toMatchObject({ failureKind: "aborted", primaryError: { cause: "user-abort" } });
  });

  it("selects OR success before its slow session cleanup and still waits for cleanup and the loser", async () => {
    const entered = barrier(); const closing = barrier(); const cleanup = barrier(); const late = barrier();
    const parent = createHttpSession(); let forks = 0; let active = 0; let loserSignal: AbortSignal | undefined; let sealed = false;
    const session: HttpSession = { ...parent, fork: async () => {
      const child = await parent.fork(); const index = forks++;
      return { ...child, close: async () => { if (index === 0) { closing.release(); await cleanup.promise; } await child.close(); } };
    } };
    const running = new ProjectSnapshotWorkflowRunner({ registry: registry(async (request, opts) => {
      const who = new URL(request.url).pathname.slice(1);
      if (++active === 2) entered.release(); await entered.promise;
      if (who === "slow") { loserSignal = opts.signal; await late.promise; }
      return response(who);
    }) }).run(fixture("any-success", [branch("fast", "winner"), branch("slow", "winner")], [{ id: "check", kind: "assert", predicate: { op: "eq", left: ref("vars", "winner"), right: literal("fast") } }]), "root", { httpSession: session })
      .then((result) => { sealed = true; return result; });
    try {
      await closing.promise;
      expect(loserSignal?.aborted).toBe(true); expect(sealed).toBe(false);
    } finally { cleanup.release(); late.release(); await running; await parent.close(); }
    expect((await running).verdict).toBe("passed");
  });

  it("blocks OR publication when the losing branch session cleanup rejects", async () => {
    const entered = barrier(); const cancelled = barrier(); const closing = barrier(); const cleanup = barrier();
    const parent = createHttpSession(); const closes: number[] = []; let parentCloses = 0; let active = 0; let sealed = false;
    const session: HttpSession = { ...parent,
      close: async () => { parentCloses++; await parent.close(); },
      fork: async () => {
        const child = await parent.fork(); const index = closes.push(0) - 1;
        return { ...child, close: async () => {
          closes[index]!++;
          await child.close();
          if (index === 1) { closing.release(); await cleanup.promise; throw new Error("loser cleanup failed"); }
        } };
      },
    };
    const running = new ProjectSnapshotWorkflowRunner({ registry: registry(async (request, opts) => {
      const who = new URL(request.url).pathname.slice(1);
      if (who === "slow") opts.signal!.addEventListener("abort", cancelled.release, { once: true });
      if (++active === 2) entered.release(); await entered.promise;
      if (who === "slow") { await cancelled.promise; throw new Error("loser request failed"); }
      return response(who);
    }) }).run(fixture("any-success", [branch("fast", "winner"), branch("slow", "winner")], [{ id: "after", kind: "noop" }]), "root", { httpSession: session })
      .then((result) => { sealed = true; return result; });
    try {
      await closing.promise; expect(sealed).toBe(false); cleanup.release();
      const result = await running;
      expect(result.verdict).toBe("failed");
      expect(result.nodeResults[0]).toMatchObject({ state: "failed", failureKind: "config", error: expect.stringContaining("loser cleanup failed") });
      expect(result.nodeResults[1]).toMatchObject({ state: "skipped" });
      expect(result.warnings.some((warning) => warning.includes("slow") && warning.includes("loser cleanup failed"))).toBe(true);
      const outcomes = result.nodeResults[0]!.outcomes!;
      expect(outcomes).toHaveLength(2);
      expect(outcomes.map((outcome) => outcome.passed)).toEqual([true, false]);
      expect(outcomes[1]!.error).toContain("loser request failed");
      expect(closes).toEqual([1, 1]); expect(parentCloses).toBe(0);
    } finally { cleanup.release(); await running; await session.close(); }
    expect(parentCloses).toBe(1);
  });

  it("keeps nested fork cleanup failure fatal across ancestor OR joins and isolates the next root", async () => {
    const entered = barrier(); const cancelled = barrier(); const closing = barrier(); const cleanup = barrier(); const rejected = barrier();
    const parent = createHttpSession(); const closes = new Map<string, number>(); let active = 0; let sealed = false;
    function tracked(session: HttpSession, path: number[] = []): HttpSession {
      let forks = 0;
      return { ...session, fork: async () => tracked(await session.fork(), [...path, forks++]), close: async () => {
        const name = path.join("/"); closes.set(name, (closes.get(name) ?? 0) + 1); await session.close();
        if (name === "1/1") { closing.release(); await cleanup.promise; rejected.release(); throw new Error("nested loser cleanup failed"); }
      } };
    }
    const nested = { id: "nested", name: "nested", executionVersion: 2, outputs: { value: literal("nested") }, nodes: [{
      id: "inner", kind: "parallel", join: "any-success", branches: [branch("inner-fast", "inner"), branch("inner-slow", "inner")],
    }], edges: [] };
    const run = fixture("any-success", [branch("outer-fast", "winner"), { id: "nested", workflowId: "nested", inputs: {}, outputs: { value: "winner" } }], [{ id: "after", kind: "noop" }], [nested]);
    const runner = new ProjectSnapshotWorkflowRunner({ registry: registry(async (request, opts) => {
      const who = new URL(request.url).pathname.slice(1);
      if (who === "inner-slow") opts.signal!.addEventListener("abort", cancelled.release, { once: true });
      if (++active === 3) entered.release(); await entered.promise;
      if (who === "outer-fast") await rejected.promise;
      if (who === "inner-slow") { await cancelled.promise; throw new Error("nested loser request failed"); }
      return response(who);
    }) });
    // Three admitted leaves avoid making the barrier itself hold the root's last permit.
    const project = structuredClone(run.snapshot.project) as ContractProject;
    const root = project.workflows[0]!; if (root.executionVersion !== 2) throw new Error("Expected v2 fixture"); root.limits.maxConcurrency = 3;
    const running = runner.run({ ...run, snapshot: createProjectSnapshot(project) }, "root", { httpSession: tracked(parent) })
      .then((result) => { sealed = true; return result; });
    try {
      await closing.promise; expect(sealed).toBe(false); cleanup.release(); const result = await running;
      expect(result.verdict).toBe("failed");
      expect(result.nodeResults[0]).toMatchObject({ state: "failed", failureKind: "config", error: expect.stringContaining("nested loser cleanup failed") });
      expect(result.nodeResults[1]).toMatchObject({ state: "skipped" });
      expect(result.warnings.some((warning) => warning.includes("inner-slow") && warning.includes("nested loser cleanup failed"))).toBe(true);
      expect(result.nodeResults[0]!.outcomes).toHaveLength(3);
      expect(result.nodeResults[0]!.outcomes?.some((outcome) => outcome.error?.includes("nested loser request failed"))).toBe(true);
      expect([...closes.values()]).toEqual([1, 1, 1, 1]); expect(closes.has("")).toBe(false);
    } finally { cleanup.release(); await running; await parent.close(); }
    expect((await runner.run(fixture("any-success", [branch("outer-fast", "winner"), branch("outer-fast", "winner")].map((item, index) => ({ ...item, id: String(index) }))), "root")).verdict).toBe("passed");
  });

  it("holds one leaf permit across all prepared rows and original container operations", async () => {
    const source = fixture("all", [branch("left"), branch("right")], [], [], 1);
    const project = structuredClone(source.snapshot.project) as ContractProject;
    const collection = project.collections[0]!; const asset = collection.apis[0]!;
    const datasetId = stableId("dataset", "parallel-rows");
    project.datasets = [{ formatVersion: 1, id: datasetId, name: "rows", columns: ["row"], rows: [{ row: "one" }, { row: "two" }] }];
    asset.contract.request.path = "/{{who}}/{{row}}";
    asset.cases[0]!.dataDriver = { kind: "dataset", datasetId };
    collection.preOperations = [{ id: "pre", type: "script", content: 'pm.variables.set("container", "ready");' }];
    collection.postOperations = [{ id: "post", type: "script", content: 'pm.variables.set("container", "finished");' }];
    asset.cases[0]!.preOperations = [{ id: "check-container", type: "script", content: 'if(pm.variables.get("container") !== "ready") throw new Error("container pre missing");' }];
    const snapshot = createProjectSnapshot(project); const plan = compileWorkflowPlan(snapshot, "root", { allowDraft: true });
    const preparedTestData = await prepareTestData(snapshot, testDataSelectionsForRequests(snapshot, workflowPlanRequests(snapshot, plan)), { workspaceRoot: process.cwd() });
    const paths: string[] = [];
    const result = await new ProjectSnapshotWorkflowRunner({ registry: registry(async (request) => { const path = new URL(request.url).pathname; paths.push(path); return response(path); }) })
      .run({ ...source, snapshot, preparedTestData }, "root");
    expect(result.verdict).toBe("passed");
    expect(paths).toEqual(["/left/one", "/left/two", "/right/one", "/right/two"]);
    expect(result.nodeResults[0]!.outcomes).toHaveLength(4);
  });

  it("shares the root cap through nested parallel containers and legacy child requests", async () => {
    const gate = barrier(); const entered = barrier(); let active = 0; let peak = 0; let starts = 0;
    const source = fixture("all"); const asset = source.snapshot.project.collections[0]!.apis[0]!;
    const legacy = { id: "legacy", name: "legacy", nodes: [{ id: "request", kind: "request", apiId: asset.contract.id, caseId: asset.cases[0]!.id }], edges: [] };
    const nested = { id: "nested", name: "nested", executionVersion: 2, nodes: [{ id: "nested-p", kind: "parallel", join: "all", branches: [branch("v2", "v2"), branch("legacy", "legacy", "legacy")] }], edges: [] };
    const run = fixture("all", [0, 1].map((id) => ({ id: String(id), workflowId: "nested", inputs: {}, outputs: {} })), [], [legacy, nested]);
    const identities: Array<Parameters<WorkflowCaseObserver>[1]> = [];
    const running = new ProjectSnapshotWorkflowRunner({ registry: registry(async (request) => {
      starts++; active++; peak = Math.max(peak, active); if (active === 2) entered.release();
      await gate.promise; active--; return response(new URL(request.url).pathname);
    }) }).run(run, "root", { observeCaseExecution: (_value, identity) => { identities.push(identity); } });
    await entered.promise; expect(active).toBe(2); expect(starts).toBe(2);
    gate.release(); const result = await running;
    expect(result.verdict).toBe("passed"); expect(starts).toBe(4); expect(peak).toBe(2);
    expect(identities.every((identity) => identity.invocationPath?.length === 3)).toBe(true);
    expect(new Set(identities.map((identity) => identity.nodeVisitId)).size).toBe(4);
  });

  it("keeps root cancellation when a noncooperative legacy child finishes its last request", async () => {
    const source = fixture("all"); const asset = source.snapshot.project.collections[0]!.apis[0]!;
    const root = WorkflowSchema.parse({ id: "root", name: "root", executionVersion: 2, nodes: [{ id: "call", kind: "subflow", workflowId: "legacy", inputs: { who: literal("legacy") }, outputs: { value: "value" } }], edges: [] });
    const legacy = WorkflowSchema.parse({ id: "legacy", name: "legacy", nodes: [{ id: "request", kind: "request", apiId: asset.contract.id, caseId: asset.cases[0]!.id }], edges: [] });
    const snapshot = createProjectSnapshot({ ...source.snapshot.project, workflows: [root, legacy] } as ContractProject);
    const entered = barrier(); const late = barrier(); const controller = new AbortController();
    const running = new ProjectSnapshotWorkflowRunner({ registry: registry(async () => { entered.release(); await late.promise; return response("late"); }) })
      .run({ ...source, snapshot }, "root", { signal: controller.signal });
    await entered.promise; controller.abort(new Error("user stop")); late.release(); const result = await running;
    expect(result.verdict).toBe("aborted"); expect(result.nodeResults[0]).toMatchObject({ state: "failed", failureKind: "aborted", primaryError: { cause: "user-abort" } });
    expect(result.nodeResults[0]!.outcomes).toHaveLength(1);
  });
});

describe("v2 child and loop execution", () => {
  const literal = (value: unknown) => ({ kind: "literal", value });
  const ref = (source: string, name: string) => ({ kind: "ref", source, path: [name] });
  function execution(nodes: unknown[], child: unknown, edges = nodes.slice(1).map((_, i) => ({ id: `e${i}`, from: (nodes[i] as { id: string }).id, to: (nodes[i + 1] as { id: string }).id }))) {
    const project = createContractExecutionProject(baseUrl);
    const folder = project.collections[0]!.folders[0]!.folders[0]!;
    folder.preOperations = []; folder.postOperations = [];
    const asset = folder.apis[0]!;
    asset.contract.request = { protocol: "http", method: "GET", baseUrl, path: "/child/{{arg}}", pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, body: { kind: "none" } };
    asset.cases[0]!.preOperations = [{ id: "private", type: "script", content: 'if (pm.variables.get("private")) throw new Error("leaked child variable"); pm.variables.set("private", "set");' }];
    asset.cases[0]!.extractors = [{ id: "token", name: "token", method: "value", selector: { target: "bodyJson", path: "$.ok" }, required: true }];
    project.workflows = [WorkflowSchema.parse({ id: "root", name: "root", executionVersion: 2, nodes, edges }), WorkflowSchema.parse(child)];
    return { snapshot: createProjectSnapshot(project), credentialBindings: { versions: {}, resolve: () => { throw new Error("Unexpected credentials"); } } };
  }
  const request = { id: "request", kind: "request", apiId: childIds.contract, caseId: childIds.case };
  it("preserves legal special input and declared output names through child expression mappings", async () => {
    const run = execution([
      { id: "call", kind: "subflow", workflowId: "child", inputs: Object.fromEntries([["__proto__", literal("kept")]]), outputs: Object.fromEntries([["__proto__", "exported"]]) },
      { id: "check", kind: "assert", predicate: { op: "eq", left: ref("vars", "exported"), right: literal("kept") } },
    ], { id: "child", name: "child", executionVersion: 2, inputs: Object.fromEntries([["__proto__", { required: true }]]),
      outputs: Object.fromEntries([["__proto__", ref("inputs", "__proto__")]]), nodes: [{ id: "noop", kind: "noop" }], edges: [] });
    const result = await new ProjectSnapshotWorkflowRunner({ registry: createPluginRegistry() }).run(run, "root");
    expect(result.verdict).toBe("passed");
    expect(result.nodeResults.map((node) => node.state)).toEqual(["passed", "passed"]);
  });
  it("publishes legal special output targets for subflow and loop final mappings", async () => {
    const run = execution([
      { id: "call", kind: "subflow", workflowId: "child", inputs: { value: literal("child-kept") }, outputs: { value: "__proto__" } },
      { id: "child-check", kind: "assert", predicate: { op: "eq", left: ref("vars", "__proto__"), right: literal("child-kept") } },
      { id: "loop", kind: "loop", workflowId: "child", count: 2, inputs: { value: literal("loop-kept") }, outputs: { value: "__proto__" } },
      { id: "loop-check", kind: "assert", predicate: { op: "eq", left: ref("vars", "__proto__"), right: literal("loop-kept") } },
    ], { id: "child", name: "child", executionVersion: 2, inputs: { value: { required: true } }, outputs: { value: ref("inputs", "value") }, nodes: [{ id: "noop", kind: "noop" }], edges: [] });
    const result = await new ProjectSnapshotWorkflowRunner({ registry: createPluginRegistry() }).run(run, "root");
    expect(result.verdict).toBe("passed");
    expect(result.nodeResults.map((node) => node.state)).toEqual(["passed", "passed", "passed", "passed"]);
  });
  it("copies legacy child inputs, exports only its whitelist, and isolates repeated calls and identities", async () => {
    const child = { id: "child", name: "legacy", nodes: [request], edges: [] };
    const run = execution([
      { id: "first", kind: "subflow", workflowId: "child", inputs: { arg: literal("one") }, outputs: { token: "first" } },
      { id: "second", kind: "subflow", workflowId: "child", inputs: { arg: literal("two") }, outputs: { token: "second" } },
      { id: "check", kind: "assert", predicate: { op: "and", items: [{ op: "eq", left: ref("vars", "first"), right: literal(true) }, { op: "eq", left: ref("vars", "second"), right: literal(true) }, { op: "notExists", value: ref("vars", "private") }] } },
    ], child);
    const observed: Array<Parameters<WorkflowCaseObserver>[1]> = [];
    seenPaths.length = 0;
    childCookies.length = 0;
    const result = await new ProjectSnapshotWorkflowRunner({ registry: createDefaultRegistry() }).run(run, "root", { observeCaseExecution: (_, identity) => { observed.push(identity); } });
    expect(result.verdict).toBe("passed");
    expect(seenPaths).toEqual(["/child/one?global=global-value", "/child/two?global=global-value"]);
    expect(observed.map((v) => [v.invocationPath, v.attempt, v.rowIndex])).toEqual([
      [[{ workflowId: "root" }, { workflowId: "child", nodeId: "first" }], 1, 0],
      [[{ workflowId: "root" }, { workflowId: "child", nodeId: "second" }], 1, 0],
    ]);
    expect(new Set(observed.map((v) => v.nodeVisitId)).size).toBe(2);
    expect(childCookies).toEqual([undefined, "child=ready"]);
    expect(result.nodeResults.flatMap((n) => n.outcomes ?? [])).toHaveLength(2);
  });
  it("rejects missing legacy exports and failed v2 children without publishing outputs", async () => {
    const missing = execution([{ id: "call", kind: "subflow", workflowId: "child", inputs: { arg: literal("value") }, outputs: { token: "token", missing: "other" } }, { id: "later", kind: "noop" }], { id: "child", name: "legacy", nodes: [request], edges: [] });
    const runner = new ProjectSnapshotWorkflowRunner({ registry: createDefaultRegistry() });
    const result = await runner.run(missing, "root");
    expect(result.nodeResults[0]).toMatchObject({ state: "failed", error: expect.stringContaining("missing") });
    expect(result.nodeResults[1]).toMatchObject({ state: "skipped" });
    const failed = execution([{ id: "call", kind: "subflow", workflowId: "child", inputs: {}, outputs: { token: "token" } }], { id: "child", name: "failed", executionVersion: 2, nodes: [{ id: "bad", kind: "assert", predicate: { op: "eq", left: literal(1), right: literal(2) } }], edges: [], outputs: { token: literal("do not publish") } });
    expect((await runner.run(failed, "root")).verdict).toBe("failed");
  });
  it("pins one definition and prepared file across nested iterations and independent case rows", async () => {
    const source = execution([{ id: "loop", kind: "loop", workflowId: "child", count: 2, inputs: { arg: literal("data") }, outputs: {} }], { id: "child", name: "child", nodes: [request], edges: [] });
    const project = structuredClone(source.snapshot.project) as ContractProject;
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.contract.request.path = "/child/{{arg}}/{{value}}";
    asset.cases[0]!.preOperations = [];
    const dir = mkdtempSync(join(tmpdir(), "apicc-child-data-"));
    try {
      writeFileSync(join(dir, "rows.csv"), "value\none\ntwo\n");
      asset.cases[0]!.dataDriver = { sourcePath: "rows.csv", format: "csv" };
      const snapshot = createProjectSnapshot(project);
      const plan = compileWorkflowPlan(snapshot, "root", { allowDraft: true });
      const prepared = await prepareTestData(snapshot, testDataSelectionsForRequests(snapshot, workflowPlanRequests(snapshot, plan)), { workspaceRoot: dir });
      expect(prepared.sources).toHaveLength(1);
      writeFileSync(join(dir, "rows.csv"), "value\nchanged\n");
      let captures = 0;
      const run: ProjectExecutionRun = { get snapshot() { captures++; return snapshot; }, credentialBindings: source.credentialBindings, preparedTestData: prepared };
      const observed: Array<Parameters<WorkflowCaseObserver>[1]> = [];
      seenPaths.length = 0;
      const result = await new ProjectSnapshotWorkflowRunner({ registry: createDefaultRegistry() }).run(run, "root", { observeCaseExecution: (_, identity) => { observed.push(identity); } });
      expect(result.verdict).toBe("passed");
      expect(captures).toBe(1);
      expect(seenPaths).toEqual(["/child/data/one?global=global-value", "/child/data/two?global=global-value", "/child/data/one?global=global-value", "/child/data/two?global=global-value"]);
      expect(observed.map((v) => [v.invocationPath?.at(-1)?.iteration, v.rowIndex, v.attempt])).toEqual([[0, 0, 1], [0, 1, 1], [1, 0, 1], [1, 1, 1]]);
      expect(new Set(observed.map((v) => JSON.stringify([v.invocationPath, v.nodeVisitId, v.attempt, v.rowIndex]))).size).toBe(4);
      expect(plan.definitionRevision).toBe(snapshot.definitionRevision);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("preserves actual legacy child rows when the shared root budget expires between its nodes", async () => {
    const run = execution([{ id: "call", kind: "subflow", workflowId: "child", inputs: {}, outputs: {} }], { id: "child", name: "child", nodes: [request, { id: "later", kind: "noop" }], edges: [{ id: "edge", from: "request", to: "later" }] });
    let visits = 0;
    const result = await new ProjectSnapshotWorkflowRunner({ registry: createDefaultRegistry() }).runLegacy(run, "child", {}, {
      inputs: { arg: "budget" }, identity: createWorkflowInvocation("child"),
      consumeVisit: () => { if (++visits > 1) throw new Error("Workflow node visit limit exceeded"); }, exportValues: () => { throw new Error("Failed child must not export"); },
    });
    expect(result.verdict).toBe("failed");
    expect(result.nodeResults[0]!.outcomes).toHaveLength(1);
    expect(result.nodeResults[1]).toMatchObject({ state: "failed", failureKind: "config", error: expect.stringContaining("visit limit") });
  });
  it("runs zero count without requests, stops until immediately, and fails exhausted while", async () => {
    const body = { id: "child", name: "body", executionVersion: 2, inputs: { arg: { required: true } }, outputs: { next: literal("done") }, nodes: [{ id: "copy", kind: "assign", assignments: { arg: ref("inputs", "arg") } }, request], edges: [{ id: "edge", from: "copy", to: "request" }] };
    const runner = new ProjectSnapshotWorkflowRunner({ registry: createDefaultRegistry() });
    seenPaths.length = 0;
    const zero = execution([{ id: "zero", kind: "loop", workflowId: "child", count: 0, inputs: { arg: literal("zero") }, outputs: { next: "next" } }, { id: "check", kind: "assert", predicate: { op: "notExists", value: ref("vars", "next") } }], body);
    expect((await runner.run(zero, "root")).verdict).toBe("passed");
    expect(seenPaths).toEqual([]);
    const until = execution([{ id: "loop", kind: "loop", workflowId: "child", count: 4, inputs: { arg: literal("once") }, outputs: { next: "next" }, until: { op: "eq", left: ref("vars", "next"), right: literal("done") } }, { id: "check", kind: "assert", predicate: { op: "eq", left: ref("vars", "next"), right: literal("done") } }], body);
    expect((await runner.run(until, "root")).verdict).toBe("passed");
    expect(seenPaths).toEqual(["/child/once?global=global-value"]);
    const exhausted = execution([{ id: "loop", kind: "loop", workflowId: "child", maxIterations: 2, while: { op: "eq", left: literal(1), right: literal(1) }, inputs: { arg: ref("loop", "iteration") }, outputs: {} }], body);
    const observed: Array<Parameters<WorkflowCaseObserver>[1]> = [];
    const result = await runner.run(exhausted, "root", { observeCaseExecution: (_, identity) => { observed.push(identity); } });
    expect(result.nodeResults[0]).toMatchObject({ state: "failed", error: expect.stringContaining("maxIterations") });
    expect(seenPaths.slice(1)).toEqual(["/child/0?global=global-value", "/child/1?global=global-value"]);
    expect(observed.map((v) => v.invocationPath?.at(-1)?.iteration)).toEqual([0, 1]);
    expect(new Set(observed.map((v) => v.nodeVisitId)).size).toBe(2);
    const plan = compileWorkflowPlan(exhausted.snapshot, "root", { allowDraft: true });
    expect(workflowPlanRequests(exhausted.snapshot, plan)).toHaveLength(1);
  });
});

function v2Execution(raw: unknown, collections: ContractCollection[] = [], datasets: ContractProject["datasets"] = []): ProjectExecutionRun {
  const workflow = WorkflowSchema.parse(raw);
  return { snapshot: createProjectSnapshot({ id: stableId("project", "v2"), name: "v2", variables: {},
    globals: { query: [], headers: [], cookies: [], body: [] }, environments: [], collections, datasets, workflows: [workflow],
    stressPolicy: { trustedOrigins: [], deniedOrigins: [] }, models: [], components: [] }),
    credentialBindings: { resolve: () => { throw new Error("Unexpected credential access"); }, versions: {} } };
}

describe("v2 bounded node policy", () => {
  const literal = (value: unknown) => ({ kind: "literal", value });
  const ref = (source: string, name: string) => ({ kind: "ref", source, path: [name] });
  const assertion = (id: string, passed = false) => ({ id, kind: "assert", predicate: { op: "eq", left: literal(1), right: literal(passed ? 1 : 2) } });
  const response = (value = "ok") => ({ status: 200, headers: {}, rawHeaders: [], bodyText: JSON.stringify({ value }), timeMs: 0 });
  function registry(execute: ProtocolClient["execute"]) { const value = createDefaultRegistry(); value.registerProtocol({ name: "http", canHandle: () => true, execute }); return value; }
  function fixture(nodes: unknown[], extra: unknown[] = [], asset = fixtureApiAsset(apiOf("policy-leaf", "https://example.com/body")), datasets: ContractProject["datasets"] = []) {
    const root = { id: "root", name: "root", executionVersion: 2, nodes, edges: nodes.slice(1).map((node, i) => ({ id: `e${i}`, from: (nodes[i] as { id: string }).id, to: (node as { id: string }).id })) };
    const run = v2Execution(root, [{ id: stableId("collection", "policy"), name: "policy", variables: {}, apis: [asset], folders: [], preOperations: [], postOperations: [] }], datasets);
    return { ...run, snapshot: createProjectSnapshot({ ...run.snapshot.project, workflows: [WorkflowSchema.parse(root), ...extra.map((flow) => WorkflowSchema.parse(flow))] } as ContractProject) };
  }
  const handler = (id: string, nodes: unknown[]) => ({ id, name: id, executionVersion: 2, nodes, edges: nodes.slice(1).map((node, i) => ({ id: `h${i}`, from: (nodes[i] as { id: string }).id, to: (node as { id: string }).id })) });
  const request = (asset: ApiAsset, policy: unknown = {}) => ({ id: "request", kind: "request", apiId: asset.contract.id, caseId: asset.cases[0]!.id, policy });
  const retry = { maxAttempts: 2, retryOn: ["transport"] };

  it("retries the whole request with every prepared row and container operation in a private attempt", async () => {
    const asset = fixtureApiAsset(apiOf("policy-rows", "https://example.com/{{container}}/{{row}}"));
    const datasetId = stableId("dataset", "policy-rows");
    asset.cases[0]!.dataDriver = { kind: "dataset", datasetId };
    asset.cases[0]!.preOperations = [{ id: "private", type: "script", content: 'if(pm.variables.get("row") === "one" && pm.variables.get("attemptWrite")) throw new Error("failed attempt leaked"); pm.variables.set("attemptWrite", "private");' }];
    const source = fixture([request(asset, { retry }), { id: "check", kind: "assert", predicate: { op: "eq", left: ref("vars", "post"), right: literal("done") } }], [], asset,
      [{ formatVersion: 1, id: datasetId, name: "rows", columns: ["row"], rows: [{ row: "one" }, { row: "two" }] }]);
    const project = structuredClone(source.snapshot.project) as ContractProject;
    project.collections[0]!.preOperations = [{ id: "pre", type: "script", content: 'pm.variables.set("container", "pre");' }];
    project.collections[0]!.postOperations = [{ id: "post", type: "script", content: 'pm.variables.set("post", "done");' }];
    const snapshot = createProjectSnapshot(project); const plan = compileWorkflowPlan(snapshot, "root", { allowDraft: true });
    const preparedTestData = await prepareTestData(snapshot, testDataSelectionsForRequests(snapshot, workflowPlanRequests(snapshot, plan)), { workspaceRoot: process.cwd() });
    const paths: string[] = []; const identities: Array<[string | undefined, number | undefined, number]> = [];
    const result = await new ProjectSnapshotWorkflowRunner({ failFast: true, registry: registry(async (req) => { paths.push(new URL(req.url).pathname); if (paths.length === 1) throw new Error("first transport"); return response(); }) })
      .run({ ...source, snapshot, preparedTestData }, "root", { observeCaseExecution: (_value, identity) => { identities.push([identity.nodeVisitId, identity.attempt, identity.rowIndex]); } });
    expect(result.verdict).toBe("passed");
    expect(paths).toEqual(["/pre/one", "/pre/two", "/pre/one", "/pre/two"]);
    expect(identities.map((item) => item.slice(1))).toEqual([[1, 0], [1, 1], [2, 0], [2, 1]]);
    expect(new Set(identities.map((item) => item[0])).size).toBe(1);
    expect(result.nodeResults[0]!.outcomes?.map((item) => item.passed)).toEqual([false, true, true, true]);
  });

  it("rejects unconfirmed side effects before sending and does not retry script or config failures", async () => {
    const asset = fixtureApiAsset(apiOf("policy-post", "https://example.com/body"));
    if (asset.contract.request.protocol !== "http") throw new Error("Expected HTTP fixture");
    asset.contract.request.method = "POST";
    let sends = 0;
    const runner = new ProjectSnapshotWorkflowRunner({ registry: registry(async () => { sends++; return response(); }) });
    await expect(runner.run(fixture([request(asset, { retry })], [], asset), "root")).rejects.toThrow(/allowRepeatSideEffects/);
    expect(sends).toBe(0);
    asset.contract.request.method = "GET";
    asset.cases[0]!.preOperations = [{ id: "script", type: "script", content: 'throw new Error("script failure")' }];
    const script = await runner.run(fixture([request(asset, { retry })], [], asset), "root");
    expect(script.nodeResults[0]).toMatchObject({ state: "failed", failureKind: "script" });
    expect(script.nodeResults[0]!.outcomes).toHaveLength(1); expect(sends).toBe(0);
    expect(script.requestFacts).toEqual({ requestStarted: 0, requestCompleted: 0, httpExchanges: 0 });
    asset.cases[0]!.preOperations = []; asset.cases[0]!.assertions = [{ id: "invalid", target: "bodyJson", op: "eq", path: "$.[", expected: "x" }];
    const config = await runner.run(fixture([request(asset, { retry })], [], asset), "root");
    expect(config.nodeResults[0]).toMatchObject({ state: "failed", failureKind: "config" }); expect(sends).toBe(0);
  });

  it("runs recovery then finally before failFast and provides only a readonly error summary", async () => {
    const recover = handler("recover", [{ id: "check", kind: "assert", predicate: { op: "and", items: [
      { op: "eq", left: ref("error", "failureKind"), right: literal("assertion") }, { op: "notExists", value: ref("error", "stack") },
    ] } }]);
    const run = fixture([{ ...assertion("body"), policy: { onError: { workflowId: "recover", mode: "recover" }, finally: { workflowId: "cleanup" } } }, { id: "after", kind: "noop" }], [recover, handler("cleanup", [assertion("cleanup", true)])]);
    const result = await new ProjectSnapshotWorkflowRunner({ registry: createPluginRegistry(), failFast: true }).run(run, "root");
    expect(result.verdict).toBe("passed"); expect(result.nodeResults.map((item) => item.state)).toEqual(["passed", "noop"]);
    expect(result.nodeResults[0]).toMatchObject({ recoveredError: { failureKind: "assertion" }, policyEvents: expect.arrayContaining([{ type: "recovered" }]) });
  });

  it("makes finally failure primary after a successful body without invoking onError", async () => {
    const run = fixture([{ id: "body", kind: "noop", policy: { onError: { workflowId: "must-not-run", mode: "recover" }, finally: { workflowId: "cleanup" } } }], [handler("must-not-run", [assertion("unexpected")]), handler("cleanup", [assertion("cleanup")])]);
    const result = await new ProjectSnapshotWorkflowRunner({ registry: createPluginRegistry() }).run(run, "root");
    expect(result.verdict).toBe("failed"); expect(result.nodeResults[0]).toMatchObject({ state: "failed", primaryError: { code: "cleanup-failed" } });
    expect(result.nodeResults[0]!.policyEvents?.some((event) => event.type === "handler-start")).toBe(false);
  });

  it("makes finally failure primary after recovery while retaining the recovered original", async () => {
    const run = fixture([{ ...assertion("body"), policy: { onError: { workflowId: "recover", mode: "recover" }, finally: { workflowId: "cleanup" } } }], [handler("recover", [assertion("recover", true)]), handler("cleanup", [assertion("cleanup")])]);
    const result = await new ProjectSnapshotWorkflowRunner({ registry: createPluginRegistry() }).run(run, "root");
    expect(result.verdict).toBe("failed"); expect(result.nodeResults[0]).toMatchObject({ primaryError: { code: "cleanup-failed" }, recoveredError: { code: "node-failed", failureKind: "assertion" } });
    expect(result.nodeResults[0]!.policyEvents?.filter((event) => event.type === "handler-start")).toHaveLength(1);
  });

  it("retains the unhandled body error before ordered handler and finally errors", async () => {
    const run = fixture([{ ...assertion("body"), policy: { onError: { workflowId: "handler", mode: "recover" }, finally: { workflowId: "cleanup" } } }], [handler("handler", [assertion("handler")]), handler("cleanup", [assertion("cleanup")])]);
    const result = await new ProjectSnapshotWorkflowRunner({ registry: createPluginRegistry() }).run(run, "root");
    expect(result.nodeResults[0]).toMatchObject({ primaryError: { code: "node-failed" }, secondaryErrors: [{ code: "handler-failed" }, { code: "cleanup-failed" }] });
  });

  it("does not recover config faults and publishes final extractor invalidation before recovery", async () => {
    const asset = fixtureApiAsset(apiOf("invalidate", "https://example.com/body"));
    asset.cases[0]!.extractors = [{ id: "token", name: "token", method: "value", selector: { target: "bodyJson", path: "$.value" }, required: true }];
    const run = fixture([{ ...request(asset), id: "seed" }, request(asset, { retry, onError: { workflowId: "recover", mode: "recover" } }), { id: "check", kind: "assert", predicate: { op: "notExists", value: ref("vars", "token") } }], [handler("recover", [assertion("recover", true)])], asset);
    let sends = 0;
    const result = await new ProjectSnapshotWorkflowRunner({ registry: registry(async () => { if (++sends > 1) throw new Error("transport failed"); return response("old"); }) }).run(run, "root");
    expect(result.verdict).toBe("passed"); expect(sends).toBe(3); expect(result.nodeResults[1]!.outcomes?.every((item) => !item.passed)).toBe(true);
    const config = await new ProjectSnapshotWorkflowRunner({ registry: createPluginRegistry() }).run(fixture([{ id: "bad", kind: "assign", assignments: { missing: ref("vars", "missing") }, policy: { onError: { workflowId: "recover", mode: "recover" } } }], [handler("recover", [assertion("recover", true)])]), "root");
    expect(config.verdict).toBe("failed"); expect(config.nodeResults[0]!.recoveredError).toBeUndefined();
  });

  it("uses fixed and capped exponential backoff without holding a leaf permit", async () => {
    vi.useFakeTimers();
    try {
      for (const [backoff, starts] of [["fixed", [0, 20000, 40000, 60000]], ["exponential", [0, 20000, 50000, 80000]]] as const) {
        const asset = fixtureApiAsset(apiOf(`backoff-${backoff}`, "https://example.com/body")); const times: number[] = []; const start = Date.now();
        const running = new ProjectSnapshotWorkflowRunner({ registry: registry(async () => { times.push(Date.now() - start); throw new Error("retry"); }) }).run(fixture([request(asset, { retry: { maxAttempts: 4, retryOn: ["transport"], delayMs: 20000, backoff } })], [], asset), "root");
        void running.catch(() => {}); // Keep early preflight rejection handled until the assertion below awaits it.
        await vi.advanceTimersByTimeAsync(0); expect(times).toEqual([0]);
        await vi.advanceTimersByTimeAsync(starts[3]); const result = await running;
        expect(times).toEqual(starts); expect(result.verdict).toBe("failed"); expect(vi.getTimerCount()).toBe(0);
      }
    } finally { vi.useRealTimers(); }
  });

  it("drains a timed out noncooperative body before starting independent bounded recovery and cleanup", async () => {
    vi.useFakeTimers();
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      const asset = fixtureApiAsset(apiOf("timeout", "https://example.com/body")); const paths: string[] = []; let bodySignal: AbortSignal | undefined; let sealed = false;
      const recoverAsset = fixtureApiAsset(apiOf("timeout-recovery", "https://example.com/recover"));
      const source = fixture([request(asset, { timeoutMs: 10, retry, onError: { workflowId: "recover", mode: "recover", timeoutMs: 20 }, finally: { workflowId: "cleanup", timeoutMs: 20 } }), { id: "after", kind: "noop" }], [handler("recover", [request(recoverAsset)]), handler("cleanup", [assertion("cleanup", true)])], asset);
      const project = structuredClone(source.snapshot.project) as ContractProject; project.collections[0]!.apis.push(recoverAsset);
      const running = new ProjectSnapshotWorkflowRunner({ registry: registry(async (req, opts) => { paths.push(new URL(req.url).pathname); if (paths.length === 1) { bodySignal = opts.signal; await gate; } else expect(opts.signal?.aborted).toBe(false); return response(); }) }).run({ ...source, snapshot: createProjectSnapshot(project) }, "root").then((value) => { sealed = true; return value; });
      void running.catch(() => {});
      await vi.advanceTimersByTimeAsync(10); expect(bodySignal?.aborted).toBe(true); expect(paths).toEqual(["/body"]); expect(sealed).toBe(false);
      release(); await vi.advanceTimersByTimeAsync(0); const result = await running;
      expect(result.verdict).toBe("passed"); expect(paths).toEqual(["/body", "/recover"]);
      expect(result.nodeResults[0]).toMatchObject({ recoveredError: { code: "node-timeout", cause: "node-timeout" } }); expect(vi.getTimerCount()).toBe(0);
    } finally { release(); vi.useRealTimers(); }
  });

  it("ancestor cancellation skips new network handlers and cleanup and interrupts an active handler", async () => {
    const asset = fixtureApiAsset(apiOf("cancel-policy", "https://example.com/body")); const controller = new AbortController(); const paths: string[] = [];
    const network = handler("network", [request(asset)]);
    const run = fixture([request(asset, { retry, onError: { workflowId: "network", mode: "recover" }, finally: { workflowId: "network" } })], [network], asset);
    const result = await new ProjectSnapshotWorkflowRunner({ registry: registry(async (req) => { paths.push(new URL(req.url).pathname); controller.abort(new Error("user stop")); throw new Error("aborted"); }) }).run(run, "root", { signal: controller.signal });
    expect(paths).toEqual(["/body"]); expect(result.nodeResults[0]).toMatchObject({ failureKind: "aborted", policyEvents: expect.arrayContaining([{ type: "handler-skipped", cause: "user-abort" }, { type: "cleanup-skipped", cause: "user-abort" }]) });
    expect(result.verdict).toBe("aborted"); expect(workflowToRunResult(result).workflow?.verdict).toBe("aborted");
    const second = new AbortController(); let handlerSignal: AbortSignal | undefined;
    const active = await new ProjectSnapshotWorkflowRunner({ registry: registry(async (_req, opts) => { handlerSignal = opts.signal; second.abort(new Error("stop handler")); throw new Error("stop"); }) }).run(fixture([{ ...assertion("body"), policy: { onError: { workflowId: "network", mode: "recover" }, finally: { workflowId: "network" } } }], [network], asset), "root", { signal: second.signal });
    expect(handlerSignal?.aborted).toBe(true); expect(active.nodeResults[0]!.failureKind).toBe("aborted"); expect(active.verdict).toBe("aborted");
    expect(active.nodeResults[0]!.secondaryErrors?.map((failure) => failure.code)).toEqual(["node-failed", "user-abort"]);
  });

  it("propagates an unconsumed error after a successful handler and bounds cleanup independently", async () => {
    const propagated = await new ProjectSnapshotWorkflowRunner({ registry: createPluginRegistry() }).run(fixture([{ ...assertion("body"), policy: { onError: { workflowId: "observe", mode: "propagate" }, finally: { workflowId: "cleanup" } } }, { id: "after", kind: "noop" }], [handler("observe", [assertion("observe", true)]), handler("cleanup", [assertion("cleanup", true)])]), "root");
    expect(propagated.verdict).toBe("failed"); expect(propagated.nodeResults[0]).toMatchObject({ primaryError: { code: "node-failed" } });
    expect(propagated.nodeResults[0]!.recoveredError).toBeUndefined(); expect(propagated.nodeResults[1]!.state).toBe("skipped");
    vi.useFakeTimers();
    try {
      const running = new ProjectSnapshotWorkflowRunner({ registry: createPluginRegistry() }).run(fixture([{ id: "body", kind: "noop", policy: { finally: { workflowId: "cleanup", timeoutMs: 10 } } }], [handler("cleanup", [{ id: "wait", kind: "delay", delayMs: 10000 }])]), "root");
      await vi.advanceTimersByTimeAsync(10); const result = await running;
      expect(result.verdict).toBe("failed"); expect(result.nodeResults[0]).toMatchObject({ primaryError: { code: "cleanup-timeout", cause: "cleanup-timeout" } }); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("requeues retries after backoff while another branch uses the sole root permit", async () => {
    vi.useFakeTimers();
    try {
      const asset = fixtureApiAsset(apiOf("permit", "https://example.com/{{who}}")); const paths: string[] = [];
      const leaf = { ...handler("leaf", [{ id: "who", kind: "assign", assignments: { who: ref("inputs", "who") } }, request(asset, { retry: { ...retry, delayMs: 20 } })]), inputs: { who: { required: true } } };
      const source = fixture([{ id: "parallel", kind: "parallel", join: "all", branches: ["retry", "other"].map((who) => ({ id: who, workflowId: "leaf", inputs: { who: literal(who) }, outputs: {} })) }], [leaf], asset);
      const project = structuredClone(source.snapshot.project) as ContractProject;
      const root = project.workflows[0]!; if (root.executionVersion !== 2) throw new Error("Expected v2 fixture"); root.limits.maxConcurrency = 1;
      const running = new ProjectSnapshotWorkflowRunner({ registry: registry(async (req) => { const path = new URL(req.url).pathname; paths.push(path); if (paths.length === 1) throw new Error("retry once"); return response(); }) }).run({ ...source, snapshot: createProjectSnapshot(project) }, "root");
      await vi.advanceTimersByTimeAsync(0); expect(paths).toEqual(["/retry", "/other"]);
      await vi.advanceTimersByTimeAsync(19); expect(paths).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1); expect((await running).verdict).toBe("passed"); expect(paths).toEqual(["/retry", "/other", "/retry"]); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("bounds recovery by its default deadline and keeps a handler timeout secondary to the body fault", async () => {
    vi.useFakeTimers();
    try {
      let sealed = false;
      const running = new ProjectSnapshotWorkflowRunner({ registry: createPluginRegistry() }).run(fixture([{ ...assertion("body"), policy: { onError: { workflowId: "recover", mode: "recover" }, finally: { workflowId: "cleanup" } } }], [handler("recover", [{ id: "wait", kind: "delay", delayMs: 10000 }]), handler("cleanup", [assertion("cleanup", true)])]), "root").then((result) => { sealed = true; return result; });
      await vi.advanceTimersByTimeAsync(4999); expect(sealed).toBe(false);
      await vi.advanceTimersByTimeAsync(1); const result = await running;
      expect(result.nodeResults[0]).toMatchObject({ primaryError: { code: "node-failed" }, secondaryErrors: [{ code: "handler-timeout", cause: "handler-timeout" }] });
      expect(result.nodeResults[0]!.policyInvocations?.map((child) => [child.role, child.result.verdict])).toEqual([["onError", "failed"], ["finally", "passed"]]); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("includes retry backoff in the local body deadline and prevents handlers extending the root deadline", async () => {
    vi.useFakeTimers();
    try {
      const asset = fixtureApiAsset(apiOf("backoff-deadline", "https://example.com/body")); let sends = 0;
      const local = new ProjectSnapshotWorkflowRunner({ registry: registry(async () => { sends++; throw new Error("transport"); }) }).run(fixture([request(asset, { timeoutMs: 10, retry: { ...retry, delayMs: 100 }, onError: { workflowId: "recover", mode: "recover" } })], [handler("recover", [assertion("recover", true)])], asset), "root");
      await vi.advanceTimersByTimeAsync(10); const recovered = await local;
      expect(recovered.verdict).toBe("passed"); expect(sends).toBe(1); expect(recovered.nodeResults[0]!.recoveredError?.code).toBe("node-timeout");
      const source = fixture([{ ...assertion("body"), policy: { onError: { workflowId: "recover", mode: "recover", timeoutMs: 30000 }, finally: { workflowId: "cleanup" } } }], [handler("recover", [{ id: "wait", kind: "delay", delayMs: 1000 }]), handler("cleanup", [assertion("cleanup", true)])]);
      const project = structuredClone(source.snapshot.project) as ContractProject; const root = project.workflows[0]!;
      if (root.executionVersion !== 2) throw new Error("Expected v2 fixture"); root.limits.timeoutMs = 20;
      const parent = new ProjectSnapshotWorkflowRunner({ registry: createPluginRegistry() }).run({ ...source, snapshot: createProjectSnapshot(project) }, "root");
      await vi.advanceTimersByTimeAsync(20); const stopped = await parent;
      expect(stopped.verdict).toBe("failed"); expect(stopped.nodeResults[0]).toMatchObject({ failureKind: "transport", primaryError: { code: "root-timeout", cause: "root-timeout" }, policyEvents: expect.arrayContaining([{ type: "cleanup-skipped", cause: "root-timeout" }]) }); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("never recovers root-owned fork cleanup failure", async () => {
    const parent = createHttpSession(); let closes = 0;
    const session: HttpSession = { ...parent, fork: async () => { const child = await parent.fork(); return { ...child, close: async () => { closes++; await child.close(); throw new Error("host fork close"); } }; } };
    const run = fixture([{ id: "parallel", kind: "parallel", join: "all", branches: ["a", "b"].map((id) => ({ id, workflowId: "leaf", inputs: {}, outputs: {} })), policy: { onError: { workflowId: "recover", mode: "recover" } } }], [handler("leaf", [assertion("leaf", true)]), handler("recover", [assertion("recover", true)])]);
    try {
      const result = await new ProjectSnapshotWorkflowRunner({ registry: createPluginRegistry() }).run(run, "root", { httpSession: session });
      expect(result.verdict).toBe("failed"); expect(result.nodeResults[0]!.error).toContain("host fork close"); expect(result.nodeResults[0]!.recoveredError).toBeUndefined(); expect(closes).toBe(2);
    } finally { await parent.close(); }
  });

  it("keeps shared root visit exhaustion fatal across OR success and recovery while draining started work", async () => {
    const asset = fixtureApiAsset(apiOf("root-limit", "https://example.com/draining"));
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    let exhausted!: () => void; const heavyClosed = new Promise<void>((resolve) => { exhausted = resolve; });
    const cleanup = handler("cleanup", [request(asset)]);
    const policy = { onError: { workflowId: "cleanup", mode: "recover" }, finally: { workflowId: "cleanup" } };
    const heavy = handler("heavy", [{ id: "loop", kind: "loop", workflowId: "leaf", count: 10000, maxIterations: 10000, inputs: {}, outputs: {}, policy }]);
    const winner = { ...handler("winner", [{ id: "wait", kind: "delay", delayMs: 0 }]), outputs: { value: literal("late-winner") } };
    const source = fixture([{ id: "parallel", kind: "parallel", join: "any-success", branches: [
      { id: "heavy", workflowId: "heavy", inputs: {}, outputs: {} },
      { id: "winner", workflowId: "winner", inputs: {}, outputs: { value: "winner" } },
      { id: "draining", workflowId: "draining", inputs: {}, outputs: {} },
    ], policy: { onError: { workflowId: "cleanup", mode: "recover" } } }], [heavy, handler("leaf", [{ id: "noop", kind: "noop" }]), winner, handler("draining", [request(asset, policy)]), cleanup], asset);
    const parent = createHttpSession(); let forks = 0; let closes = 0; let sends = 0; let settled = false; let activeSignal: AbortSignal | undefined;
    const session: HttpSession = { ...parent, fork: async () => {
      const child = await parent.fork(); const index = forks++;
      return { ...child, close: async () => { closes++; await child.close(); if (index === 0) exhausted(); } };
    } };
    const runner = new ProjectSnapshotWorkflowRunner({ registry: registry(async (_request, options) => { sends++; activeSignal = options.signal; await gate; throw new Error("late request failure"); }) });
    const running = runner.run(source, "root", { httpSession: session }).then((result) => { settled = true; return result; });
    try {
      await heavyClosed; expect(settled).toBe(false); release();
      const result = await running;
      expect(result.verdict).toBe("failed");
      expect(result.nodeResults[0]).toMatchObject({ state: "failed", failureKind: "config", primaryError: { code: "visit-limit", cause: "limit" }, policyEvents: expect.arrayContaining([{ type: "handler-skipped", cause: "limit" }]) });
      expect(result.nodeResults[0]!.recoveredError).toBeUndefined();
      expect(activeSignal?.aborted).toBe(true); expect(activeSignal?.reason).toMatchObject({ code: "visit-limit", cause: "limit" });
      expect(sends).toBe(1); expect(closes).toBe(3);
      expect(result.nodeResults[0]!.outcomes).toHaveLength(1); expect(result.nodeResults[0]!.outcomes?.[0]?.passed).toBe(false);
      const heavyResult = result.nodeResults[0]!.childInvocations?.find((child) => child.workflowId === "heavy")?.nodeResults[0];
      expect(heavyResult).toMatchObject({ primaryError: { code: "visit-limit", cause: "limit", failureKind: "config" }, policyEvents: expect.arrayContaining([{ type: "handler-skipped", cause: "limit" }, { type: "cleanup-skipped", cause: "limit" }]) });
      expect(heavyResult?.policyInvocations).toBeUndefined();
      expect((await runner.run(fixture([{ id: "next-root", kind: "noop" }]), "root")).verdict).toBe("passed");
    } finally { release(); await running; await parent.close(); }
  });

  it("keeps OR loser policy skips and local child timeout diagnostics without starting new cleanup requests", async () => {
    const asset = fixtureApiAsset(apiOf("policy-or", "https://example.com/{{who}}"));
    let entered!: () => void; const barrier = new Promise<void>((resolve) => { entered = resolve; }); let active = 0; const paths: string[] = [];
    const leaf = { ...handler("leaf", [{ id: "who", kind: "assign", assignments: { who: ref("inputs", "who") } }, request(asset, { onError: { workflowId: "cleanup", mode: "recover" }, finally: { workflowId: "cleanup" } })]), inputs: { who: { required: true } } };
    const run = fixture([{ id: "parallel", kind: "parallel", join: "any-success", branches: ["fast", "slow"].map((who) => ({ id: who, workflowId: "leaf", inputs: { who: literal(who) }, outputs: {} })) }], [leaf, handler("cleanup", [assertion("cleanup", true)])], asset);
    const result = await new ProjectSnapshotWorkflowRunner({ registry: registry(async (req, opts) => { const path = new URL(req.url).pathname; paths.push(path); if (++active === 2) entered(); await barrier; if (path === "/slow") await new Promise<void>((_resolve, reject) => opts.signal!.addEventListener("abort", () => reject(opts.signal!.reason), { once: true })); return response(); }) }).run(run, "root");
    expect(result.verdict).toBe("passed"); expect(paths).toEqual(["/fast", "/slow"]);
    const slow = result.nodeResults[0]!.childInvocations?.find((child) => child.invocationPath?.at(-1)?.branchId === "slow");
    expect(slow?.nodeResults[1]).toMatchObject({ primaryError: { cause: "or-superseded" }, policyEvents: expect.arrayContaining([{ type: "handler-skipped", cause: "or-superseded" }, { type: "cleanup-skipped", cause: "or-superseded" }]) });
    vi.useFakeTimers();
    try {
      const source = fixture([{ id: "subflow", kind: "subflow", workflowId: "limited", inputs: {}, outputs: {} }], [{ ...handler("limited", [{ id: "wait", kind: "delay", delayMs: 100 }]), limits: { timeoutMs: 10 } }]);
      const running = new ProjectSnapshotWorkflowRunner({ registry: createPluginRegistry() }).run(source, "root");
      await vi.advanceTimersByTimeAsync(10); const timed = await running;
      expect(timed.nodeResults[0]).toMatchObject({ primaryError: { code: "invocation-timeout", cause: "invocation-timeout" } });
      expect(timed.nodeResults[0]!.childInvocations?.[0]?.nodeResults[0]!.primaryError?.code).toBe("invocation-timeout"); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

describe("v2 basic workflow nodes", () => {
  const value = (v: string | number | null) => ({ kind: "literal" as const, value: v });
  const variable = (name: string) => ({ kind: "ref" as const, source: "vars" as const, path: [name] });
  it("runs assign and mutually exclusive condition ports without a script engine", async () => {
    const run = v2Execution({ id: "v2", name: "v2", executionVersion: 2, nodes: [
      { id: "assign", kind: "assign", assignments: { count: value(2), nullable: value(null) } },
      { id: "condition", kind: "condition", predicate: { op: "eq", left: variable("count"), right: value(2) } },
      { id: "yes", kind: "assert", predicate: { op: "exists", value: variable("nullable") } },
      { id: "no", kind: "assert", predicate: { op: "eq", left: value(1), right: value(2) } },
      { id: "join", kind: "noop" },
    ], edges: [ { id: "a", from: "assign", to: "condition" }, { id: "t", from: "condition", to: "yes", port: "true" },
      { id: "f", from: "condition", to: "no", port: "false" }, { id: "y", from: "yes", to: "join" }, { id: "n", from: "no", to: "join" } ] });
    const runner = new ProjectSnapshotWorkflowRunner({ registry: createPluginRegistry() });
    const result = await runner.run(run, "v2");
    expect(result.verdict).toBe("passed");
    expect(result.nodeResults.find((n) => n.nodeId === "no")).toMatchObject({ state: "skipped", skipReason: "condition-pruned" });
    expect(result.nodeResults.filter((n) => n.nodeId === "join")).toHaveLength(1);
    expect(workflowToRunResult(result).cases).toEqual([]);
  });
  it("treats assert failure as a NON-HTTP diagnostic and supplies distinct run/node identities", async () => {
    const run = v2Execution({ id: "v2", name: "v2", executionVersion: 2, nodes: [
      { id: "bad", kind: "assert", predicate: { op: "eq", left: value(1), right: value(2) } },
      { id: "later", kind: "noop" },
    ], edges: [{ id: "a", from: "bad", to: "later" }] });
    const runner = new ProjectSnapshotWorkflowRunner({ registry: createPluginRegistry() });
    const first = await runner.run(run, "v2");
    const second = await runner.run(run, "v2");
    expect(first.nodeResults[0]).toMatchObject({ state: "failed", failureKind: "assertion", attempt: 1 });
    expect(first.nodeResults[1]).toMatchObject({ state: "skipped", skipReason: "upstream-failed" });
    const report = workflowToRunResult(first);
    expect(report.cases).toEqual([]);
    expect(report.reportingMode).toBe("workflow-invocation-v2");
    expect(reportingUnits(report).summary).toMatchObject({ total: 1, failed: 1, entryDiagnostics: 0 });
    expect(first.invocationId).toBeTruthy();
    expect(first.invocationId).not.toBe(second.invocationId);
    expect(first.nodeResults[0]!.invocationId).toBe(first.invocationId);
    expect(new Set(first.nodeResults.map((n) => n.nodeVisitId)).size).toBe(2);
  });
  it("cancels delay and never dispatches its successor", async () => {
    const run = v2Execution({ id: "v2", name: "v2", executionVersion: 2, nodes: [
      { id: "wait", kind: "delay", delayMs: 10000 }, { id: "later", kind: "noop" },
    ], edges: [{ id: "a", from: "wait", to: "later" }] });
    const controller = new AbortController();
    const promise = new ProjectSnapshotWorkflowRunner({ registry: createPluginRegistry() }).run(run, "v2", { signal: controller.signal });
    controller.abort();
    const result = await promise;
    expect(result.verdict).toBe("aborted");
    expect(result.nodeResults[0]).toMatchObject({ state: "failed", failureKind: "aborted" });
    expect(result.nodeResults[1]).toMatchObject({ state: "skipped", skipReason: "aborted" });
  });
  it("preflights a missing policy handler before an earlier request", async () => {
    const asset = fixtureApiAsset(apiOf("policy", `${baseUrl}/must-not-send`));
    const run = v2Execution({ id: "v2", name: "v2", executionVersion: 2, nodes: [
      { id: "request", kind: "request", apiId: asset.contract.id, caseId: asset.cases[0]!.id },
      { id: "policy", kind: "noop", policy: { onError: { workflowId: "missing-handler", mode: "recover" } } },
    ], edges: [{ id: "a", from: "request", to: "policy" }] }, [{ id: stableId("collection", "v2"), name: "v2", variables: {}, apis: [asset], folders: [], preOperations: [], postOperations: [] }]);
    const before = seenPaths.length;
    await expect(new ProjectSnapshotWorkflowRunner({ registry: createDefaultRegistry() }).run(run, "v2")).rejects.toThrow(/missing-handler/);
    expect(seenPaths.length).toBe(before);
  });
  it("stages assign against one prior frame snapshot and does not publish a partial invalid batch", async () => {
    const frame = createWorkflowScope({ vars: { first: "old", untouched: { list: [1] } } });
    const attempt = frame.fork();
    expect(() => attempt.stage({ vars: { first: "new", invalid: undefined as never } })).toThrow();
    attempt.commitOutputs(frame);
    expect(frame.context().vars).toEqual({ first: "old", untouched: { list: [1] } });
    const run = v2Execution({ id: "v2", name: "v2", executionVersion: 2, nodes: [
      { id: "seed", kind: "assign", assignments: { first: value("old") } },
      { id: "batch", kind: "assign", assignments: { first: value("new"), copied: variable("first") } },
      { id: "check", kind: "assert", predicate: { op: "eq", left: variable("copied"), right: value("old") } },
    ], edges: [{ id: "a", from: "seed", to: "batch" }, { id: "b", from: "batch", to: "check" }] });
    expect((await new ProjectSnapshotWorkflowRunner({ registry: createPluginRegistry() }).run(run, "v2")).verdict).toBe("passed");
  });
  it("isolates fork values and commits only extraction tombstones on failed attempts", () => {
    const original = { object: { list: [1] }, ordinary: "old" };
    const frame = createWorkflowScope({ vars: original });
    frame.stage({ extractions: { token: { value: "old-token", text: "old-token", sensitive: false }, unaffected: { value: "keep", text: "keep", sensitive: false } } });
    const failed = frame.fork();
    original.object.list.push(2);
    failed.stage({ vars: { ordinary: "leak", unaffected: "failed script" }, extractions: { token: { value: "failed-token", text: "failed-token", sensitive: false }, fresh: { value: true, text: "true", sensitive: false } } });
    failed.invalidateExtractions(["token", "fresh"]);
    failed.commitOutputs(frame, { failed: true });
    expect(frame.context().vars).toEqual({ object: { list: [1] }, ordinary: "old", unaffected: "keep" });
    const success = frame.fork();
    success.stage({ vars: { ordinary: WORKFLOW_DELETE }, extractions: { typed: { value: [null, 2], text: "[null,2]", sensitive: false } } });
    success.commitOutputs(frame);
    expect(frame.context().vars).toEqual({ object: { list: [1] }, unaffected: "keep", typed: [null, 2] });
    const parent = createWorkflowInvocation("root");
    const child = createWorkflowInvocation("child", parent, { nodeId: "call", branchId: "branch", iteration: 0 });
    expect(child.parentInvocationId).toBe(parent.invocationId);
    expect(child.invocationPath).toEqual([{ workflowId: "root" }, { workflowId: "child", nodeId: "call", branchId: "branch", iteration: 0 }]);
    expect(createWorkflowScope().context().vars).toEqual({});
  });
  it("allows explicit assign to replace a prior typed extraction and supplies previous logical summary", async () => {
    const api = apiOf("extract-v2", `${baseUrl}/extract-v2`);
    api.cases![0]!.preOperations = [{ id: "seed-flag", type: "script", content: 'pm.variables.set("flag", "script-before-extraction")' }];
    api.cases![0]!.extractors = [{ id: "flag", name: "flag", method: "value", selector: { target: "bodyJson", path: "$.ok" }, required: true }];
    const asset = fixtureApiAsset(api);
    const run = v2Execution({ id: "v2", name: "v2", executionVersion: 2, nodes: [
      { id: "request", kind: "request", apiId: asset.contract.id, caseId: asset.cases[0]!.id },
      { id: "typed", kind: "assert", predicate: { op: "eq", left: variable("flag"), right: { kind: "literal", value: true } } },
      { id: "assign", kind: "assign", assignments: { flag: value("assigned") } },
      { id: "check", kind: "assert", predicate: { op: "and", items: [
        { op: "eq", left: variable("flag"), right: value("assigned") },
        { op: "eq", left: { kind: "ref", source: "previous", path: ["nodeId"] }, right: value("assign") },
      ] } },
    ], edges: [{ id: "a", from: "request", to: "typed" }, { id: "b", from: "typed", to: "assign" }, { id: "c", from: "assign", to: "check" }] },
    [{ id: stableId("collection", "v2"), name: "v2", variables: {}, apis: [asset], folders: [], preOperations: [], postOperations: [] }]);
    const result = await new ProjectSnapshotWorkflowRunner({ registry: createDefaultRegistry() }).run(run, "v2");
    expect(result.nodeResults.map((node) => node.state)).toEqual(["passed", "passed", "passed", "passed"]);
    expect(result.nodeResults[0]!.outcomes).toHaveLength(1);
    expect(result.nodeResults[0]!.outcome).toMatchObject({ invocationId: result.invocationId, nodeVisitId: result.nodeResults[0]!.nodeVisitId, attempt: 1 });
  });
  it("retains condition-pruned provenance when the chosen path later fails", async () => {
    const run = v2Execution({ id: "v2", name: "v2", executionVersion: 2, nodes: [
      { id: "condition", kind: "condition", predicate: { op: "eq", left: value(1), right: value(1) } },
      { id: "fail", kind: "assert", predicate: { op: "eq", left: value(1), right: value(2) } }, { id: "pruned", kind: "noop" },
      { id: "join", kind: "noop" },
    ], edges: [{ id: "t", from: "condition", to: "fail", port: "true" }, { id: "f", from: "condition", to: "pruned", port: "false" },
      { id: "a", from: "fail", to: "join" }, { id: "b", from: "pruned", to: "join" }] });
    const result = await new ProjectSnapshotWorkflowRunner({ registry: createPluginRegistry() }).run(run, "v2");
    expect(result.nodeResults.find((node) => node.nodeId === "pruned")).toMatchObject({ state: "skipped", skipReason: "condition-pruned" });
    expect(result.nodeResults.find((node) => node.nodeId === "join")).toMatchObject({ state: "skipped", skipReason: "upstream-failed" });
  });
  it("runs the selected real ancestor path and prepared data rows, preserving a container post failure", async () => {
    const asset = fixtureApiAsset(apiOf("nested-v2", `${baseUrl}/nested-v2/{{mark}}/{{row}}`));
    const datasetId = stableId("dataset", "v2-rows");
    asset.cases[0]!.dataDriver = { kind: "dataset", datasetId };
    const append = (id: string, mark: string): Operation => ({ id, type: "script", content: `pm.variables.set("mark", (pm.variables.get("mark") ?? "") + "${mark}");` });
    const collection: ContractCollection = { id: stableId("collection", "v2-nested"), name: "nested", variables: {}, apis: [],
      preOperations: [append("module-pre", "M")], postOperations: [], folders: [{ id: stableId("folder", "outer-v2"), name: "outer", apis: [],
        preOperations: [append("outer-pre", "O")], postOperations: [], folders: [{ id: stableId("folder", "inner-v2"), name: "inner", apis: [asset], folders: [],
          preOperations: [append("inner-pre", "I")], postOperations: [] }] }] };
    const buildRun = (selected: ContractCollection) => v2Execution({ id: "v2", name: "v2", executionVersion: 2, nodes: [
      { id: "request", kind: "request", apiId: asset.contract.id, caseId: asset.cases[0]!.id },
      { id: "check", kind: "assert", predicate: { op: "eq", left: variable("mark"), right: value("MOI") } },
    ], edges: [{ id: "a", from: "request", to: "check" }] }, [selected], [{ formatVersion: 1, id: datasetId, name: "rows", columns: ["row"], rows: [{ row: "one" }, { row: "two" }] }]);
    const prepare = async (selected: ContractCollection) => {
      const run = buildRun(selected);
      const snapshotAsset = findProjectApi(run.snapshot.project, asset.contract.id)!.api;
      return { ...run, preparedTestData: await prepareTestData(run.snapshot, testDataSelectionsForRequests(run.snapshot, [{ asset: snapshotAsset, testCase: snapshotAsset.cases[0] }]), { workspaceRoot: process.cwd() }) };
    };
    const runner = new ProjectSnapshotWorkflowRunner({ registry: createDefaultRegistry() });
    seenPaths.length = 0;
    const observed: Array<[number, string | undefined, string | undefined]> = [];
    const success = await runner.run(await prepare(collection), "v2", { observeCaseExecution: (_value, identity) => { observed.push([identity.rowIndex, identity.invocationId, identity.nodeVisitId]); } });
    expect(success.verdict).toBe("passed");
    expect(seenPaths).toEqual(["/nested-v2/MOI/one", "/nested-v2/MOI/two"]);
    expect(observed).toEqual([[0, success.invocationId, success.nodeResults[0]!.nodeVisitId], [1, success.invocationId, success.nodeResults[0]!.nodeVisitId]]);
    const failed = await runner.run(await prepare({ ...collection, postOperations: [{ id: "post", type: "script", content: 'throw new Error("v2 post failure")' }] }), "v2");
    expect(failed.nodeResults[0]).toMatchObject({ state: "failed", failureKind: "script", error: expect.stringContaining("v2 post failure") });
    expect(failed.nodeResults[0]!.outcomes?.map((outcome) => [outcome.row, outcome.passed])).toEqual([[0, true], [1, true]]);
    expect(workflowToRunResult(failed).cases).toHaveLength(2);
    expect(reportingUnits(workflowToRunResult(failed)).summary).toMatchObject({ total: 1, failed: 1, entryDiagnostics: 0 });
    const preFailure = await runner.run(await prepare({ ...collection, preOperations: [{ id: "pre", type: "script", content: 'throw new Error("v2 pre failure")' }] }), "v2");
    expect(preFailure.nodeResults[0]).toMatchObject({ state: "failed", failureKind: "script", outcomes: [] });
    expect(workflowToRunResult(preFailure).cases).toEqual([]);
  });
});

let server: Server;
let baseUrl = "";
const seenPaths: string[] = [];
const childCookies: Array<string | undefined> = [];
beforeAll(async () => {
  server = createServer((req, res) => {
    seenPaths.push(req.url ?? "");
    if (req.url?.startsWith("/child/")) { childCookies.push(req.headers.cookie); res.setHeader("set-cookie", "child=ready; Path=/"); }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

// 夹具须在 baseUrl 就绪后构造（模块顶层求值会把空串快照进 env.variables，对位 tests/runner/runner.test.ts 先例）。
interface FixtureCase {
  id: string;
  name: string;
  scope?: string;
  parameters?: Record<string, string>;
  preScript?: string;
  postScript?: string;
  preOperations?: Operation[];
  postOperations?: Operation[];
  assertions?: Assertion[];
  extractors?: import("../../src/testing/model.js").ExtractionDefinition[];
  dataDriver?: { sourcePath: string; format: "csv" | "json" };
}
interface FixtureApi {
  id: string;
  name: string;
  version?: string;
  deprecated?: boolean;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  url: string;
  headers?: KeyValuePair[];
  query?: KeyValuePair[];
  body?: RequestBody;
  protocol?: "http" | "websocket" | "soap";
  message?: string;
  envelope?: string;
  soapAction?: string;
  cases?: FixtureCase[];
}
interface FixtureContainer {
  id: string;
  name: string;
  variables?: Record<string, string>;
  apis?: FixtureApi[];
  folders?: FixtureContainer[];
  preOperations?: Operation[];
  postOperations?: Operation[];
}
interface FixtureProject {
  id: string;
  name: string;
  variables: Record<string, string>;
  environments: Environment[];
  collections?: FixtureContainer[];
}
type FixtureApiResolver = (apiId: string) => FixtureApi | undefined;
// Old test fixture shapes are translated to a complete snapshot below; these aliases are test-local only.
type ApiDefinition = FixtureApi;
type Project = FixtureProject;

let project: FixtureProject;
const ws = { id: "workspace-fixture" };
beforeAll(async () => {
  project = {
    id: "p", name: "p", variables: {},
    environments: [{ id: "e", name: "dev", variables: { baseUrl }, baseUrls: {} }],
  };
});
const apiOf = (id: string, url: string): FixtureApi => ({
  id, name: id, version: "1", deprecated: false, method: "GET", url, headers: [], query: [],
  cases: [{
    id: `case-${id}`, name: `${id}-用例`, scope: "base", parameters: {},
    preOperations: [], postOperations: [],
    assertions: [{ id: `as-${id}`, target: "status" as const, op: "eq" as const, expected: "200" }],
  }],
});
const apis = [apiOf("a1", "{{baseUrl}}/one"), apiOf("a2", "{{baseUrl}}/two"), apiOf("a3", "{{baseUrl}}/three")];
// 必失败接口（断言 500）：级联 skipped / failFast 用例的失败源。
const badApi: FixtureApi = {
  id: "abad", name: "abad", version: "1", deprecated: false, method: "GET", url: "{{baseUrl}}/bad", headers: [], query: [],
  cases: [{ id: "case-abad", name: "abad-用例", scope: "base", parameters: {}, preOperations: [], postOperations: [], assertions: [{ id: "as-abad", target: "status", op: "eq", expected: "500" }] }],
};
// 第二个必失败接口（不同 apiId）：fan-in 双败用例的另一个失败源。
const badApi2: FixtureApi = {
  id: "abad2", name: "abad2", version: "1", deprecated: false, method: "GET", url: "{{baseUrl}}/bad2", headers: [], query: [],
  cases: [{ id: "case-abad2", name: "abad2-用例", scope: "base", parameters: {}, preOperations: [], postOperations: [], assertions: [{ id: "as-abad2", target: "status", op: "eq", expected: "500" }] }],
};
const resolve: FixtureApiResolver = (apiId) => apis.find((a) => a.id === apiId);
/** 追加额外接口定义的 resolve（badApi/sitApi 等局部夹具用）。 */
const resolveWith = (extras: FixtureApi[]): FixtureApiResolver => (apiId) => [...extras, ...apis].find((a) => a.id === apiId);
const wf = (nodes: Workflow["nodes"], edges: Workflow["edges"]): Workflow =>
  ({ id: "wf", name: "条件流", status: "enabled", nodes, edges });

function stableId(kind: string, value: string): string {
  const hex = createHash("sha256").update(`${kind}:${value}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function parameterBindings(values: readonly KeyValuePair[], apiId: string, location: string) {
  return values.map((item, index) => ({
    kind: "inline" as const,
    id: stableId(`parameter:${location}:${apiId}`, String(index)),
    name: item.key,
    schema: { kind: "scalar" as const, type: "string" as const },
    required: false,
    enabled: item.enabled,
    description: "",
    value: item.value,
  }));
}

function fixtureApiAsset(api: FixtureApi): ApiAsset {
  const contractId = stableId("api", api.id);
  const separator = api.url.indexOf("?");
  const urlWithoutQuery = separator < 0 ? api.url : api.url.slice(0, separator);
  const urlQuery = separator < 0 ? [] : api.url.slice(separator + 1).split("&").filter(Boolean).map((entry) => {
    const [key, ...parts] = entry.split("=");
    return { key: decodeURIComponent(key ?? ""), value: decodeURIComponent(parts.join("=")), enabled: true };
  });
  let baseUrl: string;
  let path: string;
  if (urlWithoutQuery.startsWith("{{baseUrl}}")) {
    baseUrl = "{{baseUrl}}";
    path = urlWithoutQuery.slice("{{baseUrl}}".length) || "/";
  } else {
    const match = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]+)([^?#]*)(?:\?([^#]*))?$/.exec(urlWithoutQuery);
    if (match) {
      baseUrl = match[1]!;
      path = match[2] || "/";
    } else {
      baseUrl = "{{baseUrl}}";
      path = urlWithoutQuery.startsWith("/") ? urlWithoutQuery : `/${urlWithoutQuery}`;
    }
  }
  const query = [...(api.query ?? []), ...urlQuery];
  const common = {
    baseUrl,
    path,
    pathParams: [],
    query: parameterBindings(query, contractId, "query"),
    headers: parameterBindings(api.headers ?? [], contractId, "header"),
    cookies: [],
    auth: { kind: "none" as const },
  };
  const protocol = api.protocol ?? "http";
  const request = protocol === "websocket"
    ? { protocol, ...common, ...(api.message === undefined ? {} : { message: api.message }) }
    : protocol === "soap"
      ? { protocol, method: "POST" as const, ...common, envelope: api.envelope ?? "<Envelope/>", ...(api.soapAction === undefined ? {} : { soapAction: api.soapAction }) }
      : { protocol, method: api.method, ...common, body: api.body ?? { kind: "none" as const } };
  return {
    contract: {
      formatVersion: 1,
      id: contractId,
      metadata: { name: api.name, description: "", tags: [], version: api.version ?? "1", status: api.deprecated ? "deprecated" : "draft" },
      request,
      responses: [],
    },
    cases: (api.cases ?? []).map((testCase) => ({
      id: stableId("case", testCase.id),
      name: testCase.name,
      scope: testCase.scope ?? "base",
      parameters: testCase.parameters ?? {},
      preOperations: testCase.preOperations ?? (testCase.preScript ? [{ id: stableId("operation", `${testCase.id}:pre`), type: "script" as const, content: testCase.preScript }] : []),
      postOperations: testCase.postOperations ?? (testCase.postScript ? [{ id: stableId("operation", `${testCase.id}:post`), type: "script" as const, content: testCase.postScript }] : []),
      assertions: testCase.assertions ?? [],
      ...(testCase.extractors === undefined ? {} : { extractors: testCase.extractors }),
      ...(testCase.dataDriver === undefined ? {} : { dataDriver: testCase.dataDriver }),
    })),
    documentation: "",
  };
}

function fixtureContainer(container: FixtureContainer, collectionId: string, path = ""): ContractCollection | ContractFolder {
  const currentPath = `${path}/${container.id}`;
  const apis = (container.apis ?? []).map(fixtureApiAsset);
  const folders = (container.folders ?? []).map((folder) => fixtureContainer(folder, collectionId, currentPath) as ContractFolder);
  const operations = {
    preOperations: container.preOperations ?? [],
    postOperations: container.postOperations ?? [],
  };
  if (path === "") {
    return {
      id: stableId("collection", container.id),
      name: container.name,
      variables: container.variables ?? {},
      ...operations,
      folders,
      apis,
    };
  }
  return { id: stableId(`folder:${collectionId}:${path}`, container.id), name: container.name, ...operations, folders, apis };
}

function executionFor(
  workflow: Workflow,
  sourceProject: FixtureProject,
  resolver: FixtureApiResolver | undefined,
): { execution: ProjectExecutionRun; workflowId: string } {
  const collections = (sourceProject.collections ?? []).map((container) => fixtureContainer(container, container.id) as ContractCollection);
  const knownApiIds = new Set<string>();
  const collectApiIds = (assets: readonly ApiAsset[]): void => { for (const asset of assets) knownApiIds.add(asset.contract.id); };
  const collectContainers = (container: ContractCollection | ContractFolder): void => {
    collectApiIds(container.apis);
    for (const folder of container.folders) collectContainers(folder);
  };
  for (const collection of collections) collectContainers(collection);
  const resolverApis = new Map<string, ApiAsset>();
  for (const node of workflow.nodes) {
    if (node.kind !== "request" || !node.apiId) continue;
    const candidate = resolver?.(node.apiId);
    if (candidate) {
      const asset = fixtureApiAsset(candidate);
      if (!knownApiIds.has(asset.contract.id)) resolverApis.set(asset.contract.id, asset);
    }
  }
  if (resolverApis.size > 0) {
    collections.push({
      id: stableId("collection", "resolver-fixtures"), name: "resolver-fixtures", variables: {},
      preOperations: [], postOperations: [], folders: [], apis: [...resolverApis.values()],
    });
  }
  const mappedWorkflow: Workflow = {
    ...workflow,
    id: stableId("workflow", workflow.id),
    nodes: workflow.nodes.map((node) => ({
      ...node,
      ...(node.apiId === undefined ? {} : { apiId: stableId("api", node.apiId) }),
      ...(node.caseId === undefined ? {} : { caseId: stableId("case", node.caseId) }),
    })),
  };
  const environments = sourceProject.environments.map((environment) => {
    const firstBaseUrl = Object.values(environment.baseUrls)[0];
    const firstCollection = collections[0];
    return {
      ...environment,
      id: stableId("environment", environment.id),
      baseUrls: firstBaseUrl === undefined || firstCollection === undefined ? {} : { [firstCollection.id]: firstBaseUrl },
    };
  });
  const projectDefinition: ContractProject = {
    id: stableId("project", sourceProject.id),
    name: sourceProject.name,
    variables: sourceProject.variables,
    globals: { query: [], headers: [], cookies: [], body: [] },
    environments,
    collections,
    workflows: [mappedWorkflow],
    stressPolicy: { trustedOrigins: [], deniedOrigins: [] },
    models: [],
    components: [],
  };
  const snapshot = createProjectSnapshot(projectDefinition);
  return {
    execution: {
      snapshot,
      credentialBindings: { resolve: (ref) => { throw new Error(`Unexpected credential reference ${ref.id}`); }, versions: {} },
    },
    workflowId: mappedWorkflow.id,
  };
}

interface WorkflowFixtureRunnerOptions {
  registry: ReturnType<typeof createDefaultRegistry>;
  resolve?: FixtureApiResolver;
  envName?: string;
  failFast?: boolean;
  strict?: boolean;
}
class WorkflowRunner {
  private readonly production: ProjectSnapshotWorkflowRunner;
  constructor(private readonly options: WorkflowFixtureRunnerOptions) {
    this.production = new ProjectSnapshotWorkflowRunner({
      registry: options.registry,
      ...(options.envName === undefined ? {} : { environmentId: options.envName }),
      ...(options.failFast === undefined ? {} : { failFast: options.failFast }),
      ...(options.strict === undefined ? {} : { strict: options.strict }),
    });
  }
  async run(workflow: Workflow, context: { project?: FixtureProject; workspace?: typeof ws; observeCaseExecution?: WorkflowCaseObserver } = {}) {
    const sourceProject = context.project ?? project;
    const { execution, workflowId } = executionFor(workflow, sourceProject, this.options.resolve);
    const environment = this.options.envName === undefined
      ? undefined
      : sourceProject.environments.find(({ name }) => name === this.options.envName)?.id ?? this.options.envName;
    const environmentId = environment === undefined ? undefined : stableId("environment", environment);
    const snapshot = execution.snapshot;
    const requests = snapshot.project.workflows[0]!.nodes.flatMap((node) => {
      if (node.kind !== "request") return [];
      const location = node.apiId ? findProjectApi(snapshot.project, node.apiId) : undefined;
      if (!location) return [];
      const testCase = selectEffectiveCases(location.api.cases, resolveExecutionEnvironment(snapshot.project, location.collection.id, environmentId).chain, node.caseId)[0];
      return testCase ? [{ asset: location.api, testCase }] : [];
    });
    const preparedTestData = await prepareTestData(snapshot, testDataSelectionsForRequests(snapshot, requests, environmentId), { workspaceRoot: tmpdir() });
    return this.production.run({ ...execution, preparedTestData }, workflowId, { ...(environmentId === undefined ? {} : { environmentId }), observeCaseExecution: context.observeCaseExecution });
  }
}

describe("WorkflowRunner", () => {
  it("keeps a stopped v1 root aborted after real drain without changing its late successful row", async () => {
    const asset = fixtureApiAsset(apiOf("v1-stop", "https://example.com/stop"));
    const workflowId = "v1-stop";
    const execution = v2Execution({ id: workflowId, name: "v1 stop", status: "enabled", nodes: [{ id: "request", kind: "request", apiId: asset.contract.id, caseId: asset.cases[0]!.id }], edges: [] },
      [{ id: stableId("collection", "v1-stop"), name: "stop", variables: {}, apis: [asset], folders: [], preOperations: [], postOperations: [] }]);
    const selected = createDefaultRegistry();
    const controller = new AbortController();
    let entered!: () => void; let release!: () => void; let active = 0; let sends = 0; let sealed = false;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    selected.registerProtocol({ name: "http", canHandle: () => true, execute: async () => {
      sends++; active++; entered(); await pending; active--;
      return { status: 200, headers: {}, bodyText: "", timeMs: 0 };
    } });
    const runner = new ProjectSnapshotWorkflowRunner({ registry: selected });
    const running = runner.run(execution, workflowId, { signal: controller.signal }).then((result) => { sealed = true; return result; });
    try {
      await started; controller.abort(); await Promise.resolve();
      expect(sealed).toBe(false); expect(active).toBe(1);
      release(); const result = await running;
      expect(active).toBe(0); expect(sends).toBe(1);
      expect(result.verdict).toBe("aborted"); expect(result.reportingMode).toBeUndefined(); expect(result.invocationId).toBeUndefined();
      expect(result.nodeResults[0]).toMatchObject({ state: "failed", failureKind: "aborted" });
      const report = workflowToRunResult(result);
      expect(report).toMatchObject({ total: 1, passed: 1, failed: 0, workflow: { verdict: "aborted" } });
      expect(report.cases).toHaveLength(1); expect(report.cases[0]).toMatchObject({ passed: true });
      expect(report.cases[0]!.failureKind).toBeUndefined();
      expect(reportingUnits(report).diagnostics).toMatchObject([{ entryId: "request", failureKind: "aborted" }]);
      const beforeStart = await runner.run(execution, workflowId, { signal: controller.signal });
      expect(beforeStart.verdict).toBe("aborted"); expect(workflowToRunResult(beforeStart).cases).toEqual([]); expect(sends).toBe(1);
    } finally { release(); await running; }
  });

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

  it("strict=false 缺引用为 failed/config，其他独立节点仍继续且整体失败", async () => {
    const result = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "dev", failFast: false, strict: false })
      .run(wf([
        { id: "missing", kind: "request" as const, apiId: "ghost", caseId: "ghost-case" },
        { id: "independent", kind: "request" as const, apiId: "a1", caseId: "case-a1" },
      ], []), { project, workspace: ws });
    expect(result.nodeResults.find((n) => n.nodeId === "missing")?.state).toBe("failed");
    expect(result.nodeResults.find((n) => n.nodeId === "missing")?.failureKind).toBe("config");
    expect(result.nodeResults.find((n) => n.nodeId === "independent")?.state).toBe("passed");
    expect(result.verdict).toBe("failed");
    expect(result.warnings.some((warning) => /不存在/.test(warning))).toBe(true);
  });

  it("strict=false/failFast=true：已触达缺失根节点阻断 HTTP 并标记独立节点 fail-fast", async () => {
    seenPaths.length = 0;
    const result = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "dev", strict: false, failFast: true })
      .run(wf([
        { id: "missing-root", kind: "request" as const, apiId: "ghost", caseId: "ghost-case" },
        { id: "independent", kind: "request" as const, apiId: "a1", caseId: "case-a1" },
      ], []), { project, workspace: ws });
    expect(result.nodeResults.find((n) => n.nodeId === "missing-root")).toMatchObject({ state: "failed", failureKind: "config" });
    expect(result.nodeResults.find((n) => n.nodeId === "independent")).toMatchObject({ state: "skipped", skipReason: "fail-fast" });
    expect(seenPaths).toHaveLength(0);
    expect(result.total).toBe(2);
    expect(new Set(result.nodeResults.map((node) => node.nodeId)).size).toBe(result.total);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.verdict).toBe("failed");
    const adapted = workflowToRunResult(result);
    expect(adapted.cases).toEqual([]);
    expect(adapted).toMatchObject({ total: 0, passed: 0, failed: 0, skipped: 0 });
    expect(adapted.workflow).toMatchObject({ total: 2, passed: 0, failed: 1, skipped: 1, verdict: "failed" });
    expect(adapted.workflow!.entries).toMatchObject([
      { entryId: "missing-root", status: "failed", failureKind: "config", error: expect.stringMatching(/不存在/) },
      { entryId: "independent", status: "skipped", skipReason: "fail-fast" },
    ]);
    expect(reportingUnits(adapted).summary).toEqual({ total: 1, passed: 0, failed: 1, skipped: 0, entryDiagnostics: 1 });
  });

  it("strict=false/failFast=true：活动边上的非根缺失节点同样阻断 HTTP", async () => {
    seenPaths.length = 0;
    const result = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "dev", strict: false, failFast: true })
      .run(wf([
        { id: "root", kind: "noop" as const },
        { id: "missing-child", kind: "request" as const, apiId: "ghost", caseId: "ghost-case" },
        { id: "downstream", kind: "request" as const, apiId: "a1", caseId: "case-a1" },
      ], [
        { id: "active", from: "root", to: "missing-child" },
        { id: "after-missing", from: "missing-child", to: "downstream" },
      ]), { project, workspace: ws });
    expect(result.nodeResults.find((n) => n.nodeId === "root")?.state).toBe("noop");
    expect(result.nodeResults.find((n) => n.nodeId === "missing-child")).toMatchObject({ state: "failed", failureKind: "config" });
    expect(result.nodeResults.find((n) => n.nodeId === "downstream")).toMatchObject({ state: "skipped", skipReason: "upstream-failed" });
    expect(seenPaths).toHaveLength(0);
  });

  it("strict=false/failFast=false：缺失根到两层下游传播 upstream-failed，独立请求执行一次", async () => {
    seenPaths.length = 0;
    const result = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "dev", strict: false, failFast: false })
      .run(wf([
        { id: "missing-root", kind: "request" as const, apiId: "ghost", caseId: "ghost-case" },
        { id: "child", kind: "noop" as const },
        { id: "grandchild", kind: "noop" as const },
        { id: "independent", kind: "request" as const, apiId: "a1", caseId: "case-a1" },
      ], [
        { id: "e1", from: "missing-root", to: "child" },
        { id: "e2", from: "child", to: "grandchild" },
      ]), { project, workspace: ws });
    expect(result.nodeResults.find((n) => n.nodeId === "missing-root")).toMatchObject({ state: "failed", failureKind: "config" });
    expect(result.nodeResults.find((n) => n.nodeId === "child")).toMatchObject({ state: "skipped", skipReason: "upstream-failed" });
    expect(result.nodeResults.find((n) => n.nodeId === "grandchild")).toMatchObject({ state: "skipped", skipReason: "upstream-failed" });
    expect(result.nodeResults.find((n) => n.nodeId === "independent")?.state).toBe("passed");
    expect(seenPaths).toEqual(["/one"]);
    expect(result.total).toBe(4);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.verdict).toBe("failed");
    expect(result.warnings.filter((warning) => /不存在/.test(warning))).toHaveLength(1);
    expect(new Set(result.nodeResults.map((node) => node.nodeId)).size).toBe(result.total);
    const adapted = workflowToRunResult(result);
    expect(adapted.cases.map((c) => c.nodeId)).toEqual(["independent"]);
    expect(adapted.workflow).toMatchObject({ total: 4, passed: 1, failed: 1, skipped: 2, verdict: "failed" });
    expect(adapted.workflow!.entries.find(entry => entry.entryId === "missing-root")).toMatchObject({ status: "failed", failureKind: "config", error: expect.stringMatching(/不存在/) });
    expect(adapted.workflow!.entries.filter(entry => entry.entryId === "child" || entry.entryId === "grandchild")).toMatchObject([
      { status: "skipped", skipReason: "upstream-failed" },
      { status: "skipped", skipReason: "upstream-failed" },
    ]);
    expect(adapted).toMatchObject({ total: 1, passed: 1, failed: 0, skipped: 0 });
    expect(reportingUnits(adapted).summary).toEqual({ total: 2, passed: 1, failed: 1, skipped: 0, entryDiagnostics: 1 });
  });

  it("strict=false/failFast=true：假边后的 API/用例缺失可报告但不阻断独立 HTTP", async () => {
    seenPaths.length = 0;
    const result = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "dev", strict: false, failFast: true })
      .run(wf([
        { id: "root", kind: "noop" as const },
        { id: "hidden-api", kind: "request" as const, apiId: "ghost", caseId: "ghost-case" },
        { id: "hidden-case", kind: "request" as const, apiId: "a1", caseId: "ghost-case" },
        { id: "independent", kind: "request" as const, apiId: "a2", caseId: "case-a2" },
      ], [
        { id: "hide-api", from: "root", to: "hidden-api", condition: "false" },
        { id: "hide-case", from: "root", to: "hidden-case", condition: "false" },
      ]), { project, workspace: ws });
    expect(result.nodeResults.filter((n) => n.nodeId === "hidden-api" || n.nodeId === "hidden-case")).toMatchObject([
      { state: "failed", failureKind: "config" },
      { state: "failed", failureKind: "config" },
    ]);
    expect(result.nodeResults.find((n) => n.nodeId === "independent")?.state).toBe("passed");
    expect(seenPaths).toEqual(["/two"]);
    expect(result.failed).toBe(2);
    expect(result.passed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.verdict).toBe("failed");
    expect(result.warnings.filter((warning) => /不存在/.test(warning))).toHaveLength(2);
    const adapted = workflowToRunResult(result);
    expect(adapted.cases.map(c => c.nodeId)).toEqual(["independent"]);
    expect(adapted).toMatchObject({ total: 1, passed: 1, failed: 0, skipped: 0 });
    expect(adapted.workflow).toMatchObject({ total: 4, passed: 2, failed: 2, skipped: 0, verdict: "failed" });
    expect(reportingUnits(adapted).diagnostics).toMatchObject([
      { entryId: "hidden-api", failureKind: "config", error: expect.stringMatching(/不存在/) },
      { entryId: "hidden-case", failureKind: "config", error: expect.stringMatching(/不存在/) },
    ]);
    expect(reportingUnits(adapted).summary).toEqual({ total: 3, passed: 1, failed: 2, skipped: 0, entryDiagnostics: 2 });
  });

  // Catch the dequeue path replacing a queued config failure after a later edge fails its source.
  it.each([
    ["API", "ghost"],
    ["case", "a1"],
  ])("先入队再被条件错误阻断的缺失 %s 保留 config 事实和独立诊断", async (_kind, apiId) => {
    seenPaths.length = 0;
    const result = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "dev", strict: false, failFast: false })
      .run(wf([
        { id: "grandchild", kind: "request", apiId: "a3", caseId: "case-a3" },
        { id: "child", kind: "noop" },
        { id: "missing", kind: "request", apiId, caseId: "ghost-case" },
        { id: "sink", kind: "noop" },
        { id: "root", kind: "noop" },
      ], [
        { id: "enqueue", from: "root", to: "missing" },
        { id: "error", from: "root", to: "sink", condition: "unknownSymbol" },
        { id: "child-edge", from: "missing", to: "child" },
        { id: "grandchild-edge", from: "child", to: "grandchild" },
      ]), { project, workspace: ws });
    expect(result.nodeResults.find((n) => n.nodeId === "root")).toMatchObject({ state: "failed", failureKind: "script" });
    const missing = result.nodeResults.find((n) => n.nodeId === "missing");
    expect(missing).toMatchObject({ state: "failed", failureKind: "config", outcomes: [], error: expect.stringMatching(/不存在/) });
    expect(missing?.skipReason).toBeUndefined();
    for (const nodeId of ["sink", "child", "grandchild"]) {
      expect(result.nodeResults.find((n) => n.nodeId === nodeId)).toMatchObject({ state: "skipped", skipReason: "upstream-failed" });
    }
    expect(seenPaths).toEqual([]);
    expect(result).toMatchObject({ total: 5, passed: 0, failed: 2, skipped: 3, verdict: "failed" });
    expect(new Set(result.nodeResults.map((n) => n.nodeId)).size).toBe(5);
    expect(result.warnings.filter((warning) => /不存在/.test(warning))).toHaveLength(1);
    expect(result.warnings.filter((warning) => /条件求值失败/.test(warning))).toHaveLength(1);
    expect(result.warnings).toHaveLength(2);
    const adapted = workflowToRunResult(result);
    expect(adapted).toMatchObject({ total: 0, passed: 0, failed: 0, skipped: 0, cases: [] });
    expect(adapted.workflow).toMatchObject({ total: 5, passed: 0, failed: 2, skipped: 3, verdict: "failed" });
    expect(adapted.workflow!.entries.filter(entry => entry.status === "skipped")).toHaveLength(3);
    expect(reportingUnits(adapted).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ entryId: "missing", failureKind: "config", error: expect.stringMatching(/不存在/) }),
      expect.objectContaining({ entryId: "root", failureKind: "script", error: expect.stringMatching(/条件求值失败/) }),
    ]));
    expect(reportingUnits(adapted).summary).toEqual({ total: 2, passed: 0, failed: 2, skipped: 0, entryDiagnostics: 2 });
    expect(new Set(adapted.workflow!.entries.map(entry => entry.entryId)).size).toBe(5);
  });

  // Catch late materialization leaving hidden config descendants unreachable, or stopping independent work.
  it.each([
    { kind: "API", apiId: "ghost", failFast: false },
    { kind: "case", apiId: "a1", failFast: false },
    { kind: "API", apiId: "ghost", failFast: true },
    { kind: "case", apiId: "a1", failFast: true },
  ])("假边隐藏缺失 $kind 的逆序两层下游有失败来源，failFast=$failFast", async ({ apiId, failFast }) => {
    seenPaths.length = 0;
    const result = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "dev", strict: false, failFast })
      .run(wf([
        { id: "grandchild", kind: "request", apiId: "a3", caseId: "case-a3" },
        { id: "child", kind: "noop" },
        { id: "missing", kind: "request", apiId, caseId: "ghost-case" },
        { id: "root", kind: "noop" },
        { id: "independent", kind: "request", apiId: "a2", caseId: "case-a2" },
      ], [
        { id: "hide", from: "root", to: "missing", condition: "false" },
        { id: "child-edge", from: "missing", to: "child" },
        { id: "also-pruned", from: "root", to: "child", condition: "false" },
        { id: "grandchild-edge", from: "child", to: "grandchild" },
      ]), { project, workspace: ws });
    expect(result.nodeResults.find((n) => n.nodeId === "missing")).toMatchObject({ state: "failed", failureKind: "config", outcomes: [], error: expect.stringMatching(/不存在/) });
    for (const nodeId of ["child", "grandchild"]) {
      expect(result.nodeResults.find((n) => n.nodeId === nodeId)).toMatchObject({ state: "skipped", skipReason: "upstream-failed" });
    }
    expect(result.nodeResults.find((n) => n.nodeId === "independent")?.state).toBe("passed");
    expect(seenPaths).toEqual(["/two"]);
    expect(result).toMatchObject({ total: 5, passed: 2, failed: 1, skipped: 2, verdict: "failed" });
    expect(new Set(result.nodeResults.map((n) => n.nodeId)).size).toBe(5);
    expect(result.warnings.filter((warning) => /不存在/.test(warning))).toHaveLength(1);
    expect(result.warnings.filter((warning) => /孤立节点/.test(warning))).toHaveLength(1);
    expect(result.warnings).toHaveLength(2);
    const adapted = workflowToRunResult(result);
    expect(adapted).toMatchObject({ total: 1, passed: 1, failed: 0, skipped: 0 });
    expect(adapted.cases.map(c => c.nodeId)).toEqual(["independent"]);
    expect(adapted.workflow).toMatchObject({ total: 5, passed: 2, failed: 1, skipped: 2, verdict: "failed" });
    expect(adapted.workflow!.entries.filter(entry => entry.status === "skipped")).toMatchObject([
      { entryId: "grandchild", skipReason: "upstream-failed" }, { entryId: "child", skipReason: "upstream-failed" },
    ]);
    expect(reportingUnits(adapted).diagnostics).toMatchObject([{ entryId: "missing", failureKind: "config", error: expect.stringMatching(/不存在/) }]);
    expect(reportingUnits(adapted).summary).toEqual({ total: 2, passed: 1, failed: 1, skipped: 0, entryDiagnostics: 1 });
    expect(new Set(adapted.workflow!.entries.map(entry => entry.entryId)).size).toBe(5);
  });

  // A hidden config diagnostic must not settle an unresolved valid alternate path.
  it("隐藏缺失节点的 OR 汇入仍等待有效替代路径并只执行一次", async () => {
    seenPaths.length = 0;
    const result = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "dev", strict: false, failFast: true })
      .run(wf([
        { id: "join", kind: "request", apiId: "a3", caseId: "case-a3" },
        { id: "missing", kind: "request", apiId: "ghost", caseId: "ghost-case" },
        { id: "alternate", kind: "request", apiId: "a2", caseId: "case-a2" },
        { id: "root", kind: "noop" },
      ], [
        { id: "hide", from: "root", to: "missing", condition: "false" },
        { id: "alternate-edge", from: "root", to: "alternate" },
        { id: "invalid-join", from: "missing", to: "join" },
        { id: "valid-join", from: "alternate", to: "join" },
      ]), { project, workspace: ws });
    expect(seenPaths).toEqual(["/two", "/three"]);
    expect(result.nodeResults.find((n) => n.nodeId === "missing")).toMatchObject({ state: "failed", failureKind: "config" });
    expect(result.nodeResults.filter((n) => n.nodeId === "join")).toMatchObject([{ state: "passed" }]);
    expect(result).toMatchObject({ total: 4, passed: 3, failed: 1, skipped: 0, verdict: "failed" });
    const adapted = workflowToRunResult(result);
    expect(adapted).toMatchObject({ total: 2, passed: 2, failed: 0, skipped: 0 });
    expect(adapted.cases.map(c => c.nodeId).sort()).toEqual(["alternate", "join"]);
    expect(adapted.workflow).toMatchObject({ total: 4, passed: 3, failed: 1, skipped: 0, verdict: "failed" });
    expect(new Set(adapted.workflow!.entries.map(entry => entry.entryId)).size).toBe(4);
    expect(reportingUnits(adapted).diagnostics).toMatchObject([{ entryId: "missing", failureKind: "config", error: expect.stringMatching(/不存在/) }]);
    expect(reportingUnits(adapted).summary).toEqual({ total: 3, passed: 2, failed: 1, skipped: 0, entryDiagnostics: 1 });
  });

  it("strict=false 隐藏在条件剪枝和上游失败后的缺失引用仍保持 failed/config", async () => {
    const result = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve: resolveWith([badApi]), envName: "dev", failFast: false, strict: false })
      .run(wf([
        { id: "root", kind: "noop" as const },
        { id: "pruned-missing", kind: "request" as const, apiId: "ghost", caseId: "ghost-case" },
        { id: "bad", kind: "request" as const, apiId: "abad", caseId: "case-abad" },
        { id: "blocked-missing-case", kind: "request" as const, apiId: "a1", caseId: "ghost-case" },
        { id: "independent", kind: "request" as const, apiId: "a2", caseId: "case-a2" },
      ], [
        { id: "prune", from: "root", to: "pruned-missing", condition: "false" },
        { id: "block", from: "bad", to: "blocked-missing-case" },
      ]), { project, workspace: ws });
    expect(result.nodeResults.find((n) => n.nodeId === "pruned-missing")).toMatchObject({ state: "failed", failureKind: "config" });
    expect(result.nodeResults.find((n) => n.nodeId === "blocked-missing-case")).toMatchObject({ state: "failed", failureKind: "config" });
    expect(result.nodeResults.find((n) => n.nodeId === "independent")?.state).toBe("passed");
    expect(result.verdict).toBe("failed");
    expect(result.failed).toBe(3);
    expect(result.warnings.filter((warning) => /不存在/.test(warning))).toHaveLength(2);
  });

  it("条件环境是每条边独立的冻结快照，写入不能改变后续边或项目环境", async () => {
    const result = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "dev", failFast: false })
      .run(wf([
        { id: "root", kind: "noop" as const },
        { id: "writer", kind: "noop" as const },
        { id: "reader", kind: "noop" as const },
      ], [
        { id: "write", from: "root", to: "writer", condition: "(env.baseUrl = 'changed', true)" },
        { id: "read", from: "root", to: "reader", condition: "env.baseUrl === '" + baseUrl + "'" },
      ]), { project, workspace: ws });
    expect(result.nodeResults.find((n) => n.nodeId === "writer")?.state).toBe("noop");
    expect(result.nodeResults.find((n) => n.nodeId === "reader")?.state).toBe("noop");
    expect(project.environments[0]!.variables.baseUrl).toBe(baseUrl);
  });

  it("无 javascript 引擎时条件源节点 failed/script，不伪装成剪枝成功", async () => {
    const result = await new WorkflowRunner({ registry: createPluginRegistry(), resolve, envName: "dev", failFast: false })
      .run(wf([
        { id: "n1", kind: "noop" as const },
        { id: "n2", kind: "noop" as const },
      ], [{ id: "edge", from: "n1", to: "n2", condition: "true" }]), { project, workspace: ws });
    expect(result.nodeResults.find((n) => n.nodeId === "n1")?.failureKind).toBe("script");
    expect(result.nodeResults.find((n) => n.nodeId === "n1")?.error).toContain("edge");
    expect(result.nodeResults.find((n) => n.nodeId === "n2")?.skipReason).toBe("upstream-failed");
    expect(result.verdict).toBe("failed");
  });

  it("noop 节点直接通过；非严格 missing 引用 failed/config 带告警", async () => {
    const nodes = [
      { id: "n1", kind: "noop" as const, label: "占位" },
      { id: "n2", kind: "request" as const, apiId: "ghost", caseId: "ghost-case", label: "缺失" },
    ];
    const r = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: undefined, failFast: false, strict: false })
      .run(wf(nodes, [{ id: "e", from: "n1", to: "n2" }]), { project, workspace: ws });
    expect(r.nodeResults[0]!.state).toBe("noop");
    expect(r.nodeResults[1]!.state).toBe("failed");
    expect(r.nodeResults[1]!.failureKind).toBe("config");
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

  it("条件表达式求值异常标记源节点失败并告警", async () => {
    const nodes = [
      { id: "n1", kind: "request" as const, apiId: "a1", caseId: "case-a1", label: "one" },
      { id: "n2", kind: "request" as const, apiId: "a2", caseId: "case-a2", label: "two" },
    ];
    const r = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "dev", failFast: false })
      .run(wf(nodes, [{ id: "e", from: "n1", to: "n2", condition: "prev.missing.deep" }]), { project, workspace: ws });
    expect(r.nodeResults[0]!.state).toBe("failed");
    expect(r.nodeResults[0]!.failureKind).toBe("script");
    expect(r.nodeResults[1]!.state).toBe("skipped");
    expect(r.nodeResults[1]!.skipReason).toBe("upstream-failed");
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
      .rejects.toThrow(/不存在环境/);
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

  it("乱序声明的两级 false 剪枝仍稳定传播 condition-pruned", async () => {
    const result = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve, envName: "dev", failFast: false })
      .run(wf([
        { id: "tail", kind: "noop" as const },
        { id: "mid", kind: "noop" as const },
        { id: "root", kind: "noop" as const },
      ], [
        { id: "e1", from: "root", to: "mid", condition: "false" },
        { id: "e2", from: "mid", to: "tail" },
      ]), { project, workspace: ws });
    expect(result.verdict).toBe("passed");
    expect(result.nodeResults.find((n) => n.nodeId === "mid")?.skipReason).toBe("condition-pruned");
    expect(result.nodeResults.find((n) => n.nodeId === "tail")?.skipReason).toBe("condition-pruned");
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

  it("failFast 遗留的独立根节点明确标记 fail-fast", async () => {
    const result = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve: resolveWith([badApi]), envName: "dev", failFast: true })
      .run(wf([
        { id: "bad", kind: "request" as const, apiId: "abad", caseId: "case-abad" },
        { id: "independent", kind: "request" as const, apiId: "a1", caseId: "case-a1" },
      ], []), { project, workspace: ws });
    expect(result.nodeResults.find((n) => n.nodeId === "bad")?.state).toBe("failed");
    expect(result.nodeResults.find((n) => n.nodeId === "independent")?.skipReason).toBe("fail-fast");
    expect(result.verdict).toBe("failed");
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
    expect(r.nodeResults[0]!.outcomes).toEqual([]);
    expect(r.nodeResults[0]!.failureKind).toBe("config");
    expect(reportingUnits(workflowToRunResult(r)).summary).toMatchObject({ total: 1, failed: 1, entryDiagnostics: 1 });
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
    expect(r.nodeResults.find((n) => n.nodeId === "c")!.skipReason).toBe("upstream-failed");
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
    expect(c[0]!.skipReason).toBe("upstream-failed");
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
    expect(c[0]!.skipReason).toBe("upstream-failed");
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
    expect(r.nodeResults.find((n) => n.nodeId === "b")!.skipReason).toBe("condition-pruned");
    expect(r.nodeResults.find((n) => n.nodeId === "c")!.state).toBe("skipped");
    expect(r.nodeResults.find((n) => n.nodeId === "c")!.skipReason).toBe("upstream-failed");
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
    const seenCarriedTokens: string[] = [];
    const seenCleanTokenMarkers: string[] = [];
    const waiting: Array<() => void> = [];
    const barrier = createServer((req, res) => {
      const seed = String(req.headers["x-seed"] ?? "");
      if (req.url === "/first") {
        res.setHeader("content-type", "application/json");
        seenSeeds.add(seed);
        if (seenSeeds.size === 2) while (waiting.length > 0) waiting.shift()!();
        else waiting.push(() => res.end(JSON.stringify({ token: seed })));
        if (seenSeeds.size === 2) res.end(JSON.stringify({ token: seed }));
        return;
      }
      if (req.url === "/second") seenCarriedTokens.push(String(req.headers["x-carried-token"] ?? ""));
      if (req.url === "/clean") seenCleanTokenMarkers.push(String(req.headers["x-clean-token"] ?? ""));
      res.end("ok");
    });
    await new Promise<void>((r) => barrier.listen(0, "127.0.0.1", r));
    const barrierBase = `http://127.0.0.1:${(barrier.address() as { port: number }).port}`;
    try {
      const first = apiOf("first", `${barrierBase}/first`);
      first.headers = [{ key: "x-seed", value: "{{seed}}", enabled: true }];
      first.cases![0]!.postOperations = [{
        id: "extract-token",
        type: "script",
        content: 'pm.variables.set("token", pm.variables.get("seed"));',
      }];
      first.cases![0]!.extractors = [{ id: "declarative-token", name: "extractedToken", method: "value", selector: { target: "bodyJson", path: "$.token" } }];
      first.cases![0]!.assertions!.push({ id: "extracted-current", target: "bodyJson", path: "$.token", op: "eq", expected: "{{extractedToken}}" });
      const second = apiOf("second", `${barrierBase}/second`);
      second.headers = [{ key: "x-carried-token", value: "{{token}}", enabled: true }];
      second.cases![0]!.postOperations = [{
        id: "assert-carried-token",
        type: "script",
        content: 'pm.assert(pm.variables.get("token") === pm.variables.get("seed"), "run isolation"); pm.assert(pm.variables.get("extractedToken") === pm.variables.get("seed"), "extraction isolation");',
      }];
      const cleanApi = apiOf("clean", `${barrierBase}/clean`);
      cleanApi.cases![0]!.preOperations = [{
        id: "observe-clean-token",
        type: "script",
        content: 'pm.request.headers["x-clean-token"] = pm.variables.get("token") === undefined ? "undefined" : "stale";',
      }];
      cleanApi.cases![0]!.postOperations = [{
        id: "assert-clean-token",
        type: "script",
        content: 'pm.assert(pm.variables.get("token") === undefined, "stale token"); pm.assert(pm.variables.get("extractedToken") === undefined, "stale extraction");',
      }];
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
      expect(seenCarriedTokens).toHaveLength(2);
      expect(seenCarriedTokens.sort()).toEqual(["A", "B"]);

      const clean = await runner.run({ id: "clean", name: "clean", status: "enabled", nodes: [{ id: "clean", kind: "request", apiId: "clean", caseId: "case-clean" }], edges: [] }, { project: makeProject("C"), workspace: ws });
      expect(clean.nodeResults[0]!.state).toBe("passed");
      expect(seenCleanTokenMarkers).toEqual(["undefined"]);
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
      const bad = { ...dataApi, id: "bad-data", cases: [{ ...dataApi.cases![0]!, id: "case-bad", dataDriver: { sourcePath: join(dir, "missing.json"), format: "json" as const } }] };
      const config = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve: resolveWith([bad]), envName: "dev", failFast: false })
        .run(wf([{ id: "bad", kind: "request", apiId: "bad-data", caseId: "case-bad" }], []), { project, workspace: ws });
      expect(config.nodeResults[0]?.state).toBe("failed");
      expect(config.nodeResults[0]?.outcomes).toEqual([]);
      expect(config.nodeResults[0]?.failureKind).toBe("config");
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

  it("容器后置脚本异常保留全部数据行并追加独立 script 失败诊断", async () => {
    const dir = mkdtempSync(join(tmpdir(), "apicc-workflow-container-"));
    const sourcePath = join(dir, "rows.json");
    writeFileSync(sourcePath, JSON.stringify([{ expected: "200" }, { expected: "200" }]));
    const dataApi: ApiDefinition = {
      ...apiOf("container-data", `${baseUrl}/container`),
      cases: [{ id: "case-container-data", name: "container-data", scope: "base", parameters: {}, dataDriver: { sourcePath, format: "json" }, assertions: [{ id: "status", target: "status", op: "eq", expected: "{{expected}}" }] }],
    };
    const projectWithContainer: Project = {
      ...project,
      collections: [{
        id: "container-module", name: "container-module", variables: {}, apis: [dataApi], folders: [],
        postOperations: [{ id: "explode", type: "script", content: 'throw new Error("post explode")' }],
      }],
    };
    try {
      seenPaths.length = 0;
      const observed: Array<[number | undefined, string, number]> = [];
      const result = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve: () => undefined, envName: "dev", failFast: false })
        .run(wf([{ id: "container", kind: "request", apiId: "container-data", caseId: "case-container-data" }], []), { project: projectWithContainer, workspace: ws,
          observeCaseExecution: async (execution, identity) => { observed.push([execution.outcome.row, identity.nodeId, identity.rowIndex]); } });
      const node = result.nodeResults[0]!;
      expect(seenPaths).toEqual(["/container", "/container"]);
      expect(observed).toEqual([[0, "container", 0], [1, "container", 1]]);
      expect(node.state).toBe("failed");
      expect(node.failureKind).toBe("script");
      expect(node.error).toContain("post explode");
      expect(node.outcomes?.map((outcome) => outcome.row)).toEqual([0, 1]);
      expect(node.outcomes?.every((outcome) => outcome.passed)).toBe(true);
      const report = workflowToRunResult(result);
      expect([report.total, report.passed, report.failed, report.workflow?.failed]).toEqual([2, 2, 0, 1]);
      expect(reportingUnits(report).summary).toMatchObject({ total: 3, failed: 1, entryDiagnostics: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("模块与祖先容器前后置脚本异常均保留真实执行诊断", async () => {
    const target: ApiDefinition = {
      ...apiOf("ancestor-target", `${baseUrl}/ancestor`),
      cases: [{ id: "case-ancestor-target", name: "ancestor-target", scope: "base", parameters: {}, assertions: [{ id: "status", target: "status", op: "eq", expected: "200" }] }],
    };
    const variants = [
      { name: "module-pre", pre: "module" as const, post: undefined },
      { name: "outer-pre", pre: "outer" as const, post: undefined },
      { name: "inner-pre", pre: "inner" as const, post: undefined },
      { name: "module-post", pre: undefined, post: "module" as const },
      { name: "outer-post", pre: undefined, post: "outer" as const },
      { name: "inner-post", pre: undefined, post: "inner" as const },
    ];
    for (const variant of variants) {
      seenPaths.length = 0;
      const throwing = (where: string) => [{ id: `${variant.name}-${where}`, type: "script" as const, content: `throw new Error("${variant.name}")` }];
      const inner = { id: "inner", name: "inner", apis: [target], folders: [], preOperations: variant.pre === "inner" ? throwing("pre") : [], postOperations: variant.post === "inner" ? throwing("post") : [] };
      const outer = { id: "outer", name: "outer", apis: [], folders: [inner], preOperations: variant.pre === "outer" ? throwing("pre") : [], postOperations: variant.post === "outer" ? throwing("post") : [] };
      const container: Project = {
        ...project,
        collections: [{
          id: "ancestor-module", name: "ancestor-module", variables: {}, apis: [], folders: [outer],
          preOperations: variant.pre === "module" ? throwing("pre") : [], postOperations: variant.post === "module" ? throwing("post") : [],
        }],
      };
      const result = await new WorkflowRunner({ registry: createDefaultRegistry(), resolve: () => undefined, envName: "dev", failFast: false })
        .run(wf([{ id: "ancestor", kind: "request", apiId: "ancestor-target", caseId: "case-ancestor-target" }], []), { project: container, workspace: ws });
      const node = result.nodeResults[0]!;
      expect(node.state, variant.name).toBe("failed");
      expect(node.failureKind, variant.name).toBe("script");
      expect(node.error, variant.name).toContain(variant.name);
      if (variant.pre) {
        expect(seenPaths, variant.name).toEqual([]);
        expect(node.outcomes, variant.name).toEqual([]);
      } else {
        expect(seenPaths, variant.name).toEqual(["/ancestor"]);
        expect(node.outcomes?.map((outcome) => outcome.passed), variant.name).toEqual([true]);
      }
      const report = workflowToRunResult(result);
      expect([report.total, report.passed, report.failed, report.workflow?.failed], variant.name).toEqual([variant.pre ? 0 : 1, variant.pre ? 0 : 1, 0, 1]);
      expect(reportingUnits(report).summary.entryDiagnostics, variant.name).toBe(1);
    }
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
      return { result, paths: [...seenPaths] };
    };
    for (const [envName, expectedPath] of [["sit", "/sit"], ["dev", "/dev"], [undefined, "/base"]] as const) {
      const { result, paths } = await run(envName);
      expect(paths, envName ?? "base").toEqual([expectedPath]);
      expect(result.nodeResults.find((node) => node.nodeId === "scoped-node")?.state, envName ?? "base").toBe("passed");
    }
  });

  it("悬空 from 边：执行前拒绝", async () => {
    // 悬空端点属于结构错误，执行前拒绝，不能静默跳过或发出请求。
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

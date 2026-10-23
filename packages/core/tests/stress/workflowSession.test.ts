import { describe, expect, it } from "vitest";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import { createDefaultRegistry } from "../../src/index.js";
import { WorkflowRunner } from "../../src/workflow/runner.js";
import { WorkflowSchema } from "../../src/workflow/model.js";
import type { CaseExecutionDeps } from "../../src/runner/caseExecutor.js";
import { createContractExecutionProject, contractExecutionIds as ids } from "../helpers/contractExecutionFixtures.js";
import { createStressCaseSession } from "../../src/stress/caseSession.js";
import { runStressSchedule } from "../../src/stress/loadScheduler.js";
import { compileStressPlan } from "../../src/stress/execution.js";
import { StressPlanSchema } from "../../src/stress/plan.js";
import { createStressAccumulator } from "../../src/stress/metrics.js";
import { createExecutionEvidenceCollector } from "../../src/report/evidence.js";
import { createStressRequestGate } from "../../src/stress/requestGate.js";
import { createHttpSession } from "../../src/http/session.js";
import type { StressClock } from "../../src/stress/execution.js";
import { createServer } from "node:http";
import { workflowReportScenarios } from "../helpers/contractExecutionFixtures.js";
import { bindPreparedStressExecution } from "../../src/stress/execution.js";
import { prepareTestData } from "../../src/testing/data.js";
import { prepareWorkflowExecution } from "../../src/workflow/prepared.js";
import { createStressWorkflowSession, createPreparedStressHost } from "../../src/stress/workflowSession.js";
import type { StressVuHostContext, StressMetricEvent } from "../../src/stress/execution.js";
import { createHttpClient } from "../../src/http/client.js";
import { runStressPlan } from "../../src/stress/plannedRunner.js";
import { workflowPlanRequests } from "../../src/workflow/plan.js";
import { testDataSelectionsForRequests } from "../../src/testing/data.js";

const clock: StressClock = { now: () => performance.now(), wallNow: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };

async function preparedFixture(baseUrl: string) {
  const project = createContractExecutionProject(baseUrl);
  const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
  asset.contract.request.auth = { kind: "none" }; asset.contract.request.path = "/retry";
  if (asset.contract.request.protocol === "http") asset.contract.request.method = "GET";
  asset.cases[0]!.assertions = [{ id: "status", target: "status", op: "eq", expected: "200" }];
  asset.cases[0]!.preOperations.push({ id: "input-header", type: "script", content: 'pm.request.headers["X-Vu"] = pm.variables.get("who") ?? "missing";' });
  const recover = structuredClone(asset); recover.contract.id = "10000000-0000-4000-8000-000000000021"; recover.contract.request.path = "/recover";
  project.collections[0]!.apis.push(recover);
  const scenarios = workflowReportScenarios(ids.contract, ids.case);
  const [retry, or, recovered, noop] = scenarios;
  const retryNode = retry!.nodes[0]!;
  if (retryNode.kind === "request" && "policy" in retryNode && retryNode.policy?.retry) retryNode.policy.retry.retryOn = ["http"];
  const recoveredNode = recovered!.nodes[0]!;
  if (recoveredNode.kind === "request") recoveredNode.apiId = recover.contract.id;
  const root = WorkflowSchema.parse({ id: "root", name: "combo", status: "enabled", executionVersion: 2, inputs: { who: { required: true } },
    outputs: { unused: { kind: "ref", source: "vars", path: ["not-exported-by-this-root"] } },
    nodes: [{ id: "copy", kind: "assign", assignments: { who: { kind: "ref", source: "inputs", path: ["who"] } } },
      { id: "retry", kind: "subflow", workflowId: retry!.id }, { id: "or", kind: "subflow", workflowId: or!.id }, { id: "recover", kind: "subflow", workflowId: recovered!.id }],
    edges: [{ id: "a", from: "copy", to: "retry" }, { id: "b", from: "retry", to: "or" }, { id: "c", from: "or", to: "recover" }] });
  // Each F5 child explicitly receives the input; this is never cross-root ambient state.
  for (const flow of [retry!, recovered!]) if (flow.executionVersion === 2) {
    flow.inputs = { who: { required: true } };
    flow.nodes.unshift({ id: "copy", kind: "assign", assignments: { who: { kind: "ref", source: "inputs", path: ["who"] } } });
    flow.edges.push({ id: "copy-request", from: "copy", to: "request" });
  }
  if (root.executionVersion === 2) for (const node of root.nodes) if (node.kind === "subflow" && node.id !== "or") node.inputs = { who: { kind: "ref", source: "vars", path: ["who"] } };
  project.workflows = [root, ...scenarios];
  const snapshot = createProjectSnapshot(project);
  const compiled = compileStressPlan(snapshot, StressPlanSchema.parse({ formatVersion: 1, target: { kind: "workflow", workflowId: "root", inputs: { who: "default" } },
    environmentId: ids.environment, load: { kind: "constant-vus", vus: 2 }, maxVus: 2, termination: { maxIterations: 4 },
    lifecycle: { setup: { workflowId: noop!.id }, vuSetup: { workflowId: noop!.id }, vuTeardown: { workflowId: noop!.id }, teardown: { workflowId: noop!.id } } }));
  const preparedTestData = await prepareTestData(snapshot, compiled.targets.flatMap((target) => [...target.dataSelections]), { workspaceRoot: process.cwd() });
  return bindPreparedStressExecution(compiled, { snapshot, credentialBindings: { versions: {}, resolve: () => { throw new Error("No credentials expected"); } }, preparedTestData });
}

describe("stress workflow host wiring", () => {
  // A lost final-request hook used to dispatch both legacy roots and v2 legacy children.
  it("blocks the actual final request in a v1 root and a v1 child of v2", async () => {
    const project = createContractExecutionProject("http://localhost:18080");
    project.workflows.push(WorkflowSchema.parse({ id: "parent", name: "parent", executionVersion: 2,
      nodes: [{ id: "child", kind: "subflow", workflowId: ids.workflow }], edges: [] }));
    const run = { snapshot: createProjectSnapshot(project), credentialBindings: { versions: {}, resolve: () => "secret" } };
    let sent = 0; const urls: string[] = [];
    const registry = createDefaultRegistry();
    registry.registerProtocol({ name: "http", canHandle: () => true, execute: async () => { sent++; return { status: 200, headers: {}, bodyText: "ok", timeMs: 1 }; } });
    const runner = new WorkflowRunner({ registry });
    const options = { environmentId: ids.environment, beforeSend: (request: Parameters<NonNullable<CaseExecutionDeps["beforeSend"]>>[0]) => {
      urls.push(request.url); throw new Error("denied-final-target");
    } };
    const legacy = await runner.run(run, ids.workflow, options);
    const child = await runner.run(run, "parent", options);
    expect([legacy.verdict, child.verdict]).toEqual(["failed", "failed"]);
    expect(sent).toBe(0);
    expect(urls).toEqual(["http://localhost:18080/nested/items", "http://localhost:18080/nested/items"]);
  });

  it("leaves a borrowed VU client and cookie session with their owner", async () => {
    const run = { snapshot: createProjectSnapshot(createContractExecutionProject("http://localhost:18080")), credentialBindings: { versions: {}, resolve: () => "secret" } };
    const registry = createDefaultRegistry(); let closes = 0;
    const client = { name: "http", canHandle: () => true, execute: async () => ({ status: 200, headers: {}, bodyText: "ok", timeMs: 1 }), close: async () => { closes++; } };
    const httpSession = createHttpSession();
    const session = createStressCaseSession({ run, collectionId: ids.collection, apiId: ids.contract, caseId: ids.case, environmentId: ids.environment }, {
      createManagedClient: () => client, managedClient: client, httpSession,
      resolveProtocol: (request) => registry.getProtocol(request), resolveAuth: (type) => registry.getAuth(type), resolveAssert: (op) => registry.getAssert(op), scriptEngine: registry.getScriptEngine("javascript")!,
    }, { workerId: 1 });
    await session.execute(); await session.close(); await session.close();
    expect(closes).toBe(0);
    await httpSession.storeResponseCookies("http://localhost/", [["set-cookie", "still=owned"]]);
    expect(await httpSession.getCookieHeader("http://localhost/")).toBe("still=owned");
    await client.close(); await httpSession.close();
  });

  it("waits for run owner cleanup before finished even when setup fails", async () => {
    const snapshot = createProjectSnapshot(createContractExecutionProject("http://localhost:18080"));
    const compiled = compileStressPlan(snapshot, StressPlanSchema.parse({ formatVersion: 1, target: { kind: "workflow", workflowId: ids.workflow }, load: { kind: "constant-vus", vus: 1 }, termination: { maxIterations: 1 } }));
    let closeEntered!: () => void; let release!: () => void; let finishes = 0;
    const entered = new Promise<void>((resolve) => { closeEntered = resolve; });
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const closing = runStressSchedule(compiled.schedule, {
      runId: "close-run", clock, signal: new AbortController().signal,
      gate: createStressRequestGate({ clock, maxConcurrency: 1, authorizeRequest() {} }),
      metrics: createStressAccumulator(compiled.metricPlan, "close-run"), evidence: createExecutionEvidenceCollector({ projectId: ids.project, definitionRevision: snapshot.definitionRevision }, []),
      execution: { lifecycle: { setup: { workflowId: ids.workflow } } },
      runLifecycle: async () => { throw new Error("setup failed"); },
      createVu: async () => { throw new Error("VU must not start"); },
      closeRun: async () => { closeEntered(); await barrier; },
      onProgress: (progress) => { if (progress.state === "finished") finishes++; },
    });
    // Setup always yields; this also makes the old missing close hook fail without a wait timeout.
    await Promise.race([entered, closing]);
    expect(finishes).toBe(0);
    release(); const result = await closing;
    expect(finishes).toBe(1); expect(result.completeness.execution.reasons).toContain("setup-failed");
  });

  it("keeps two VUs isolated across two prepared F5 retry/OR/recover iterations and retains real failures", async () => {
    const requests: Array<{ who: string; cookie: string; path: string }> = [];
    const server = createServer((request, response) => {
      const who = String(request.headers["x-vu"]); const path = new URL(request.url!, "http://local").pathname;
      const cookie = request.headers.cookie ?? "";
      requests.push({ who, cookie, path });
      if (path === "/recover" || (path === "/retry" && !cookie.includes("retry=ready"))) {
        response.writeHead(503, { "Set-Cookie": `retry=ready; Path=/` }); response.end("failed");
      } else { response.writeHead(200, { "Set-Cookie": `owner=${who}; Path=/` }); response.end("ok"); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing server address");
    const prepared = await preparedFixture(`http://127.0.0.1:${address.port}`);
    const events: StressMetricEvent[] = [];
    const evidence = createExecutionEvidenceCollector({ projectId: ids.project, definitionRevision: prepared.run.snapshot.definitionRevision }, [], { maxSamples: 20 });
    const gate = createStressRequestGate({ clock, maxConcurrency: 2, authorizeRequest() {} });
    const registry = createDefaultRegistry();
    const compiled = prepared.compiled.workflowPlans[0]!;
    const target = prepareWorkflowExecution(prepared.run, "root", { environmentId: ids.environment, compiledPlan: compiled });
    expect(target.plan).toBe(compiled); expect(target.run.snapshot).toBe(prepared.run.snapshot);
    const sessions = ["left", "right"].map((vuId) => {
      const host: StressVuHostContext = { runId: "run", vuId, signal: new AbortController().signal, clock, gate, lifecycle: undefined,
        observation: () => ({ phase: "measurement", atMs: clock.now() }), observe: (event) => { events.push(event); }, reportLifecycle: () => ({}) };
      return createStressWorkflowSession(target, { registry, evidence }, { host, initialInputs: { who: vuId } });
    });
    try {
      const results = [];
      for (let iteration = 0; iteration < 2; iteration++) results.push(...await Promise.all(sessions.map((session, index) => session.execute({
        runId: "run", vuId: index ? "right" : "left", iterationId: `${index}-${iteration}`, phase: "measurement", stageId: null, scheduledOffsetMs: 0, signal: new AbortController().signal,
      }))));
      expect(results.map((result) => result.state)).toEqual(["passed", "passed", "passed", "passed"]);
      expect(requests.filter((request) => request.path === "/retry").map((request) => [request.who, request.cookie.includes(`owner=${request.who}`)])).toEqual([
        ["left", false], ["right", false], ["left", false], ["right", false], ["left", true], ["right", true],
      ]);
      expect(events.filter((event) => event.kind === "case")).toHaveLength(10);
      expect(events.filter((event) => event.kind === "case" && !event.ok)).toHaveLength(6);
      expect(events.filter((event) => event.kind === "http").reduce((sum, event) => sum + (event.kind === "http" ? event.started : 0), 0)).toBe(10);
      expect(events.filter((event) => event.kind === "http").reduce((sum, event) => sum + (event.kind === "http" ? event.completed : 0), 0)).toBe(10);
      const caseRows = events.filter((event) => event.kind === "case");
      expect(caseRows.filter((row) => row.requestStarted && row.requestCompleted)).toHaveLength(10);
      expect(events.filter((event) => event.kind === "node" && event.nodeKey === JSON.stringify(["root", "recover"]))).toHaveLength(4);
      expect(events.filter((event) => event.kind === "node").every((event) => event.kind === "node" && event.durationMs >= 0)).toBe(true);
    } finally {
      await Promise.all(sessions.map((session) => session.close({ reason: "iteration-budget", signal: new AbortController().signal, allowNetworkCleanup: true })));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    const other = { ...prepared.run, snapshot: { ...prepared.run.snapshot } };
    expect(() => prepareWorkflowExecution(other, "root", { environmentId: ids.environment, compiledPlan: compiled })).toThrow(/快照|snapshot/);
    expect(() => prepareWorkflowExecution(prepared.run, "root", { environmentId: ids.environment, compiledPlan: { ...compiled } })).toThrow(/快照|snapshot/);
    await expect(new WorkflowRunner({ registry }).runPrepared({ ...target })).rejects.toThrow(/owner/);
  });

  it("shares case/lifecycle Cookie and client ownership, maps explicit outputs, and skips network teardown after user stop", async () => {
    const seen: Array<{ owner: string; path: string; cookie: string }> = [];
    const server = createServer((request, response) => {
      const path = new URL(request.url!, "http://local").pathname.slice(1);
      seen.push({ owner: String(request.headers["x-owner"]), path, cookie: request.headers.cookie ?? "" });
      response.writeHead(200, { "Set-Cookie": `last=${path}; Path=/` }); response.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing address");
    const project = createContractExecutionProject(`http://127.0.0.1:${address.port}`);
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.contract.request.auth = { kind: "none" }; asset.contract.request.path = "/{{who}}";
    const step = (id: string, value: string) => WorkflowSchema.parse({ id, name: id, status: "enabled", executionVersion: 2, inputs: { who: { required: true } },
      outputs: { selected: { kind: "literal", value }, ignored: { kind: "literal", value: "never-forward" } },
      nodes: [{ id: "copy", kind: "assign", assignments: { who: { kind: "ref", source: "inputs", path: ["who"] } } }, { id: "http", kind: "request", apiId: ids.contract, caseId: ids.case }], edges: [{ id: "edge", from: "copy", to: "http" }] });
    project.workflows = [step("setup", "setup-value"), step("vu", "main"), step("vu-end", "unused"), step("end", "unused")];
    const snapshot = createProjectSnapshot(project);
    const compiled = compileStressPlan(snapshot, StressPlanSchema.parse({ formatVersion: 1, target: { kind: "case", collectionId: ids.collection, apiId: ids.contract, caseId: ids.case },
      environmentId: ids.environment, load: { kind: "constant-vus", vus: 1 }, termination: { maxIterations: 2 },
      lifecycle: { setup: { workflowId: "setup", inputs: { who: "run-setup" }, outputs: { selected: "who" } }, vuSetup: { workflowId: "vu", inputs: { who: "vu-setup" }, outputs: { selected: "who" } },
        vuTeardown: { workflowId: "vu-end", inputs: { who: "vu-teardown" } }, teardown: { workflowId: "end", inputs: { who: "run-teardown" } } } }));
    const preparedTestData = await prepareTestData(snapshot, compiled.targets.flatMap((target) => [...target.dataSelections]), { workspaceRoot: process.cwd() });
    const prepared = bindPreparedStressExecution(compiled, { snapshot, preparedTestData, credentialBindings: { versions: {}, resolve() { throw new Error("unused"); } } });
    const registry = createDefaultRegistry();
    registry.registerProtocol({ name: "http", canHandle: () => true, execute: async () => { throw new Error("global registry client must never execute"); } });
    const closed: string[] = [];
    try {
      for (const cancel of [false, true]) {
        const signal = new AbortController(); const runId = cancel ? "cancelled" : "natural";
        const evidence = createExecutionEvidenceCollector({ projectId: ids.project, definitionRevision: snapshot.definitionRevision }, [], { maxSamples: 20 });
        const metrics = createStressAccumulator(compiled.metricPlan, runId);
        const host = createPreparedStressHost(prepared, { registry, evidence, createManagedClient(owner) {
          const client = createHttpClient();
          return { ...client, async execute(request, options) {
            request.headers["X-Owner"] = owner;
            const response = await client.execute(request, options);
            if (cancel && new URL(request.url).pathname === "/main") signal.abort(new Error("stop"));
            return response;
          }, async close() { closed.push(`${runId}:${owner}`); await client.close(); } };
        } });
        const result = await runStressPlan(prepared, { ...host, runId, clock, metrics, evidence, signal: signal.signal,
          gate: createStressRequestGate({ clock, maxConcurrency: 1, authorizeRequest() {} }) });
        if (!cancel) {
          expect(result.requests).toMatchObject({ started: 2, completed: 2, eligibleCompleted: 2 });
          expect(result.lifecycle.map((step) => step.state)).toEqual(["passed", "passed", "passed", "passed"]);
          expect(result.phases.filter((phase) => ["setup", "vu-setup", "vu-teardown", "teardown"].includes(phase.phase)).map((phase) => phase.httpExchanges.started)).toEqual([1, 1, 1, 1]);
          expect(seen).toEqual([
            { owner: "run", path: "run-setup", cookie: "" }, { owner: "1", path: "vu-setup", cookie: "" },
            { owner: "1", path: "main", cookie: "last=vu-setup" }, { owner: "1", path: "main", cookie: "last=main" },
            { owner: "1", path: "vu-teardown", cookie: "last=main" }, { owner: "run", path: "run-teardown", cookie: "last=run-setup" },
          ]);
        } else {
          expect(seen.slice(6).map((request) => request.path)).toEqual(["run-setup", "vu-setup", "main"]);
          expect(result.lifecycle.find((step) => step.role === "vuTeardown")?.state).toBe("skipped");
          expect(result.verdict.passed).toBe(false);
        }
        await host.closeRun?.();
      }
      expect(closed).toEqual(["natural:1", "natural:run", "cancelled:1", "cancelled:run"]);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });

  it("keeps each mixed node's prepared rows and reports monotonic node duration without recapture", async () => {
    const project = createContractExecutionProject("http://localhost:18080");
    const asset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
    asset.contract.request.auth = { kind: "none" };
    const second = structuredClone(asset); second.contract.id = "10000000-0000-4000-8000-000000000022";
    const dataA = "10000000-0000-4000-8000-000000000080", dataB = "10000000-0000-4000-8000-000000000081";
    project.datasets = [ { formatVersion: 1, id: dataA, name: "two", columns: ["row"], rows: [{ row: "a" }, { row: "b" }] },
      { formatVersion: 1, id: dataB, name: "three", columns: ["row"], rows: [{ row: "x" }, { row: "y" }, { row: "z" }] } ];
    asset.cases[0]!.dataDriver = { kind: "dataset", datasetId: dataA }; second.cases[0]!.dataDriver = { kind: "dataset", datasetId: dataB };
    project.collections[0]!.apis.push(second);
    project.workflows = [WorkflowSchema.parse({ id: "mixed", name: "mixed", executionVersion: 2,
      nodes: [{ id: "two", kind: "request", apiId: asset.contract.id, caseId: ids.case }, { id: "three", kind: "request", apiId: second.contract.id, caseId: ids.case }], edges: [{ id: "edge", from: "two", to: "three" }] })];
    const snapshot = createProjectSnapshot(project);
    const { compileWorkflowPlan } = await import("../../src/workflow/plan.js");
    const compiled = compileWorkflowPlan(snapshot, "mixed", { environmentId: ids.environment, allowDraft: true });
    const data = await prepareTestData(snapshot, testDataSelectionsForRequests(snapshot, workflowPlanRequests(snapshot, compiled)), { workspaceRoot: process.cwd() });
    const target = prepareWorkflowExecution({ snapshot, preparedTestData: data, credentialBindings: { versions: {}, resolve: () => "unused" } }, "mixed", { environmentId: ids.environment, compiledPlan: compiled });
    let monotonic = 0; const rows: Array<[string, number]> = []; const nodes: Array<[string, number]> = [];
    const registry = createDefaultRegistry();
    registry.registerProtocol({ name: "http", canHandle: () => true, async execute() { monotonic += 7; return { status: 200, headers: {}, bodyText: "", timeMs: 2 }; } });
    const result = await new WorkflowRunner({ registry }).runPrepared(target, { monotonicNow: () => monotonic,
      observeCaseExecution: (_execution, identity) => { rows.push([identity.nodeId, identity.rowIndex]); }, observeNodeExecution: (value) => { nodes.push([value.nodeId, value.durationMs]); } });
    expect(result.verdict).toBe("passed");
    expect(rows).toEqual([["two", 0], ["two", 1], ["three", 0], ["three", 1], ["three", 2]]);
    expect(nodes).toEqual([["two", 14], ["three", 21]]); expect(target.run.preparedTestData).toBe(data);
  });
});

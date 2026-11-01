import { afterAll, beforeAll, expect, it, onTestFinished } from "vitest";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { createProjectSnapshot, StressPlanSchema, prepareTestData, testDataSelectionsForRequests, WorkflowSchema } from "@apicc/core";
import { createContractExecutionProject, contractExecutionIds as ids } from "../../core/tests/helpers/contractExecutionFixtures.js";
import { prepareExecution, invokeExecution, createExecutionRegistry } from "../src/host/index.js";

let server: Server; let baseUrl = "";
const seen: { row: string; cookie?: string; vuId?: string }[] = [];
const unionPorts = new Map<number, string>();
let finishHeldVu: (() => void) | undefined; let fastVuRequests = 0;
beforeAll(async () => {
  server = createServer((request, response) => {
    const path = new URL(request.url!, baseUrl).pathname; const row = path.split("/").at(-1)!;
    const vuId = request.headers["x-test-vu"] as string | undefined;
    seen.push({ row, cookie: request.headers.cookie, ...(vuId ? { vuId } : {}) });
    if (path.startsWith("/isolation/")) {
      response.setHeader("content-type", "text/plain"); response.setHeader("set-cookie", `session=cookie-private-${vuId}-${row}; Path=/`);
      const end = () => response.end(`other cookie-private-${vuId === "1" ? "2" : "1"}-a`);
      if (path.startsWith("/isolation/asymmetric/")) {
        if (vuId === "2" && fastVuRequests < 3) { finishHeldVu = end; return; }
        if (vuId === "1" && ++fastVuRequests === 3) { finishHeldVu?.(); finishHeldVu = undefined; }
      }
      end(); return;
    }
    if (path === "/fail-vu-setup") {
      response.statusCode = 503; response.setHeader("content-type", "text/plain"); response.end("VU setup unavailable"); return;
    }
    if (path.startsWith("/union/")) {
      if (!unionPorts.has(request.socket.remotePort!)) unionPorts.set(request.socket.remotePort!, unionPorts.size === 0 ? "worker-private-one" : "worker-private-two");
      response.statusCode = 500; response.setHeader("content-type", "text/plain"); response.setHeader("set-cookie", `session=${unionPorts.get(request.socket.remotePort!)}; Path=/`);
      response.end("worker-private-one worker-private-two"); return;
    }
    response.setHeader("content-type", "text/plain"); response.setHeader("set-cookie", `session=cookie-private-${row}; Path=/`);
    const end = () => response.end(`other cookie-private-${row === "a" ? "b" : "a"}`);
    if (path.startsWith("/slow/") || path.startsWith("/paced/")) setTimeout(end, 150); else end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

function fixture(workerCount = 1, workflow = false, slow = false, isolation?: "natural" | "asymmetric") {
  const project = createContractExecutionProject(baseUrl); const collection = project.collections[0]!; const folder = collection.folders[0]!.folders[0]!; const api = folder.apis[0]!;
  folder.preOperations = []; folder.postOperations = []; api.cases[0]!.preOperations = [];
  api.contract.request.baseUrl = baseUrl; api.contract.request.path = slow ? "/slow/{{row}}" : isolation ? `/isolation/${isolation}/{{row}}` : "/data/{{row}}";
  api.cases[0]!.dataDriver = { kind: "dataset", datasetId: "10000000-0000-4000-8000-000000000080" };
  project.datasets = [{ formatVersion: 1, id: "10000000-0000-4000-8000-000000000080", name: "rows", columns: ["row"], rows: [{ row: "a" }, { row: "b" }] }];
  const target = workflow ? { kind: "workflow" as const, workflowId: ids.workflow } : { kind: "case" as const, collectionId: collection.id, apiId: api.contract.id, caseId: ids.case };
  const plan = StressPlanSchema.parse({ formatVersion: 1, target, load: { kind: "constant-vus", vus: 2 }, maxVus: 2, maxRequestConcurrency: 2,
    termination: { maxIterations: 4 }, ...(workflow ? { lifecycle: { setup: { workflowId: ids.workflow }, teardown: { workflowId: ids.workflow } } } : {}) });
  const prepared = prepareExecution({ snapshot: createProjectSnapshot(project), target: { kind: "stress", plan }, profile: "no-script", stressRun: { workerCount, confirmedTargetOrigins: [] }, ...(slow ? { requestSettings: { totalTimeoutMs: 15 } } : {}) });
  return { project, plan, prepared };
}
const credentialBindings = { versions: { [ids.credential]: "1" }, resolve: () => "credential-private" };
async function callWorkers(workerCount: number, workflow = false, slow = false, asymmetric = false, signal?: AbortSignal) {
  const traceVu = !workflow && !slow;
  const { project, plan, prepared } = fixture(workerCount, workflow, slow, traceVu ? asymmetric ? "asymmetric" : "natural" : undefined);
  const data = await prepareTestData(prepared.snapshot, testDataSelectionsForRequests(prepared.snapshot, prepared.selections, prepared.environmentId), { workspaceRoot: process.cwd() });
  const value = await invokeExecution(prepared, { credentialBindings, preparedTestData: data }, { signal, registryFactory(options) {
    const registry = createExecutionRegistry(options);
    // Observe the real host VU identity while retaining its managed HTTP transport.
    if (traceVu) registry.getSdkProtocol = () => ({ name: "test-vu-observer", sdkProtocol: true, canHandle: request => request.protocol === "http",
      execute(request, options) { return options.runtime!.pluginTransport!.execute({ ...request, headers: { ...request.headers, "x-test-vu": options.runtime!.pluginVuId! } }, options); } });
    return registry;
  }, stress: workerCount > 1 ? { workers: { count: workerCount, timeoutMs: 15000,
    configuration: { project, plan, data, token: "credential-private", credentialVersions: credentialBindings.versions, requestSettings: prepared.requestSettings, traceVu },
    argsFor: identity => [fileURLToPath(new URL("./fixtures/stress-worker.mjs", import.meta.url)), identity.runId, identity.workerId] } } : {} });
  return value;
}

function expectIsolatedVuRequests(requests: typeof seen) {
  expect(requests).toHaveLength(4);
  expect([...new Set(requests.map(request => request.vuId))].sort()).toEqual(["1", "2"]);
  // Each VU owns its cursor/Cookie state; the shared iteration budget need not
  // divide evenly. A valid 3:1 allocation is a,b,a for one VU and a for the other.
  for (const vuId of ["1", "2"]) {
    const actual = requests.filter(request => request.vuId === vuId).map(({ row, cookie }) => ({ row, cookie }));
    expect(actual).toEqual([
      { row: "a", cookie: undefined },
      { row: "b", cookie: `session=cookie-private-${vuId}-a` },
      { row: "a", cookie: `session=cookie-private-${vuId}-b` },
    ].slice(0, actual.length));
  }
}

it.each([1, 2])("runs real case/data/Cookie isolation with %i workers and reprojects the private marker union", async workerCount => {
  const before = seen.length; const value = await callWorkers(workerCount);
  expect(value).toMatchObject({ kind: "stress", result: { formatVersion: 2, iterations: { completed: 4 }, requests: { started: 4, completed: 4 }, verdict: { passed: true } } });
  const requests = seen.slice(before);
  expectIsolatedVuRequests(requests);
  expect(JSON.stringify(value)).not.toMatch(/credential-private|cookie-private-/);
});

it.each([1, 2])("keeps case/data/Cookie isolation with asymmetric VU completion in %i workers", async workerCount => {
  const before = seen.length; fastVuRequests = 0;
  const controller = new AbortController(); let running: ReturnType<typeof callWorkers> | undefined;
  const cleanup = async () => {
    controller.abort(); finishHeldVu?.(); finishHeldVu = undefined;
    await running?.catch(() => {}); fastVuRequests = 0;
  };
  // Vitest timeout does not enter an unresolved test body's finally immediately.
  onTestFinished(cleanup);
  try {
    const value = await (running = callWorkers(workerCount, false, false, true, controller.signal));
    expect(value).toMatchObject({ kind: "stress", result: { formatVersion: 2, iterations: { completed: 4 }, requests: { started: 4, completed: 4 }, verdict: { passed: true } } });
    const requests = seen.slice(before);
    expect(requests.filter(request => request.vuId === "1")).toHaveLength(3);
    expect(requests.filter(request => request.vuId === "2")).toHaveLength(1);
    expectIsolatedVuRequests(requests);
    expect(JSON.stringify(value)).not.toMatch(/credential-private|cookie-private-/);
  } finally { await cleanup(); }
});

it.each([1, 2])("applies the fixed request override to real workflow/lifecycle leaves with %i workers", async workerCount => {
  const before = seen.length; const value = await callWorkers(workerCount, true, true);
  expect(value).toMatchObject({ kind: "stress", result: { iterations: { started: 0 }, lifecycle: expect.arrayContaining([{ role: "setup", state: "failed", failureKind: "transport", durationMs: expect.any(Number), vuId: null }]), verdict: { passed: false } } });
  expect(seen.length - before).toBe(4); // Two dataset rows in setup, two in the always-run teardown.
});
it.each([1, 2])("applies the fixed request override inside %i real case workers", async workerCount => {
  const value = await callWorkers(workerCount, false, true);
  expect(value).toMatchObject({ kind: "stress", result: { requests: { started: 4 }, failures: { transport: 4 }, iterations: { failed: 4 }, verdict: { passed: false } } });
});

it("returns a safe not-started stress failure when fixed credentials are unavailable", async () => {
  const { prepared } = fixture(); const before = seen.length;
  const value = await invokeExecution(prepared, { credentialBindings: { versions: {}, resolve() { throw new Error("unavailable credential-private"); } } });
  expect(value).toMatchObject({ kind: "stress-failure", started: false, requests: { started: 0, completed: 0 } });
  expect(JSON.stringify(value)).not.toContain("credential-private"); expect(seen.length).toBe(before);
});
it("rejects missing fixed file data without consulting local paths or starting requests", async () => {
  const { project, plan } = fixture();
  project.collections[0]!.folders[0]!.folders[0]!.apis[0]!.cases[0]!.dataDriver = { sourcePath: "never-read-development-machine.csv", format: "csv" };
  const prepared = prepareExecution({ snapshot: createProjectSnapshot(project), target: { kind: "stress", plan }, profile: "no-script" });
  const before = seen.length; const value = await invokeExecution(prepared, { credentialBindings });
  expect(value).toMatchObject({ kind: "stress-failure", started: false, requests: { started: 0, completed: 0 } });
  expect(seen.length).toBe(before);
});

it("retains actual multi-worker request facts when final publication fails", async () => {
  const { project, plan, prepared } = fixture(2);
  const data = await prepareTestData(prepared.snapshot, testDataSelectionsForRequests(prepared.snapshot, prepared.selections), { workspaceRoot: process.cwd() });
  const value = await invokeExecution(prepared, { credentialBindings, preparedTestData: data }, { stress: { onProgress(event) { if (event.state === "finished") throw new Error("publication credential-private"); }, workers: {
    count: 2, timeoutMs: 15000, configuration: { project, plan, data, token: "credential-private", credentialVersions: credentialBindings.versions },
    argsFor: identity => [fileURLToPath(new URL("./fixtures/stress-worker.mjs", import.meta.url)), identity.runId, identity.workerId],
  } } });
  expect(value).toMatchObject({ kind: "stress-failure", started: true, requests: { started: 4, completed: 4 } });
  expect(JSON.stringify(value)).not.toContain("credential-private"); expect(value).not.toHaveProperty("result.reportingUnits");
});
it("marks a failed lifecycle as started when it sent requests before publication failed", async () => {
  const { prepared } = fixture(1, true, true); const before = seen.length;
  const value = await invokeExecution(prepared, { credentialBindings }, { stress: { onProgress(event) { if (event.state === "finished") throw new Error("publication credential-private"); } } });
  expect(value).toMatchObject({ kind: "stress-failure", started: true });
  expect(seen.length - before).toBe(4); expect(JSON.stringify(value)).not.toContain("credential-private");
});
it("retains started facts from a real remote VU setup before measurement begins", async () => {
  const { project, plan } = fixture(2); const before = seen.length;
  const api = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
  api.contract.request.path = "/fail-vu-setup"; delete api.cases[0]!.dataDriver;
  plan.lifecycle = { vuSetup: { workflowId: ids.workflow } };
  const prepared = prepareExecution({ snapshot: createProjectSnapshot(project), target: { kind: "stress", plan }, profile: "no-script", stressRun: { workerCount: 2, confirmedTargetOrigins: [] } });
  const data = await prepareTestData(prepared.snapshot, testDataSelectionsForRequests(prepared.snapshot, prepared.selections), { workspaceRoot: process.cwd() });
  const states: string[] = [];
  const value = await invokeExecution(prepared, { credentialBindings, preparedTestData: data }, { stress: {
    onProgress(event) { states.push(event.state); if (event.state === "finished") throw new Error("publication credential-private"); }, workers: {
      count: 2, timeoutMs: 15000, configuration: { project, plan, data, token: "credential-private", credentialVersions: credentialBindings.versions },
      argsFor: identity => [fileURLToPath(new URL("./fixtures/stress-worker.mjs", import.meta.url)), identity.runId, identity.workerId],
    },
  } });
  expect(seen.slice(before)).toEqual([{ row: "fail-vu-setup", cookie: undefined }]);
  expect(states).toContain("preparing"); expect(states).toContain("finished"); expect(states).not.toContain("running");
  expect(value).toMatchObject({ kind: "stress-failure", started: true, requests: { started: 0, completed: 0 }, error: "publication [REDACTED]" });
  expect(JSON.stringify(value)).not.toContain("credential-private");
});
it("reprojects each worker's failure body with markers learned only by the other process", async () => {
  unionPorts.clear(); const { project, plan } = fixture(2); plan.termination.maxIterations = 2;
  project.collections[0]!.folders[0]!.folders[0]!.apis[0]!.contract.request.path = "/union/{{row}}";
  const prepared = prepareExecution({ snapshot: createProjectSnapshot(project), target: { kind: "stress", plan }, profile: "no-script", stressRun: { workerCount: 2, confirmedTargetOrigins: [] } });
  const data = await prepareTestData(prepared.snapshot, testDataSelectionsForRequests(prepared.snapshot, prepared.selections), { workspaceRoot: process.cwd() });
  const value = await invokeExecution(prepared, { credentialBindings, preparedTestData: data }, { stress: { workers: { count: 2, timeoutMs: 15000,
    configuration: { project, plan, data, token: "credential-private", credentialVersions: credentialBindings.versions },
    argsFor: identity => [fileURLToPath(new URL("./fixtures/stress-worker.mjs", import.meta.url)), identity.runId, identity.workerId] } } });
  expect([...unionPorts.values()].sort()).toEqual(["worker-private-one", "worker-private-two"]);
  if (value.kind !== "stress") throw new Error("Expected a v2 stress report");
  expect(value.result.failureEvidence).toHaveLength(2);
  expect(value.result.failureEvidence!.map(sample => sample.response?.body.text)).toEqual(["[REDACTED] [REDACTED]", "[REDACTED] [REDACTED]"]);
  expect(JSON.stringify(value)).not.toMatch(/worker-private-one|worker-private-two|credential-private/);
});

it("refuses a multi-worker plan without its pinned child host before any request", async () => {
  const { prepared } = fixture(2); const before = seen.length;
  const value = await invokeExecution(prepared, { credentialBindings });
  expect(value).toMatchObject({ kind: "stress-failure", started: false, requests: { started: 0, completed: 0 } });
  expect(seen.length).toBe(before);
});

it.each([1, 2])("publishes nonzero cumulative request progress during a real %i worker run without doubling final counts", async workerCount => {
  const { project, plan } = fixture(workerCount);
  project.collections[0]!.folders[0]!.folders[0]!.apis[0]!.contract.request.path = "/paced/{{row}}";
  plan.termination.maxIterations = 12;
  const prepared = prepareExecution({ snapshot: createProjectSnapshot(project), target: { kind: "stress", plan }, profile: "no-script", stressRun: { workerCount, confirmedTargetOrigins: [] } });
  const data = await prepareTestData(prepared.snapshot, testDataSelectionsForRequests(prepared.snapshot, prepared.selections), { workspaceRoot: process.cwd() });
  const progress: { state: string; requests?: { completed: number } }[] = [];
  const value = await invokeExecution(prepared, { credentialBindings, preparedTestData: data }, { stress: { onProgress: event => { progress.push(event); }, ...(workerCount === 2 ? { workers: {
    count: 2, timeoutMs: 15000, configuration: { project, plan, data, token: "credential-private", credentialVersions: credentialBindings.versions },
    argsFor: (identity: { runId: string; workerId: string }) => [fileURLToPath(new URL("./fixtures/stress-worker.mjs", import.meta.url)), identity.runId, identity.workerId],
  } } : {}) } });
  expect(value).toMatchObject({ kind: "stress", result: { requests: { started: 12, completed: 12 }, iterations: { completed: 12 } } });
  expect(progress.some(event => event.state === "running" && (event.requests?.completed ?? 0) > 0 && event.requests!.completed < 12)).toBe(true);
});

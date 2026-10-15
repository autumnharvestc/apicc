import { createServer } from "node:http";
import { Transform } from "node:stream";
import * as undici from "undici";
import { describe, expect, it, vi } from "vitest";
import { createHttpClient, type ManagedProtocolClient } from "../../src/http/client.js";
import { createDefaultRegistry } from "../../src/index.js";
import { createEventBus } from "../../src/events/bus.js";
import { createContractExecutionProject, contractExecutionIds } from "../helpers/contractExecutionFixtures.js";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import type { ProjectExecutionRun } from "../../src/runner/runner.js";
import type { StressSample } from "../../src/stress/model.js";
import { createStressCaseSession } from "../../src/stress/caseSession.js";
import { StressRunner } from "../../src/stress/runner.js";

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof undici>();
  return { ...actual, request: vi.fn(actual.request) };
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

// All I/O, body decoding, executor and aggregation stay real. Gates let tests
// advance a monotonic clock at actual boundaries, without tight wall-clock limits.
async function withTimedHttp(
  mode: "pooled" | "fresh",
  test: (ctx: {
    client: ManagedProtocolClient; url: string; advance(ms: number): void;
    finish<T>(pending: Promise<T>): Promise<T>;
  }) => Promise<void>,
) {
  const server = createServer((_req, res) => { res.setHeader("content-type", "text/plain; charset=utf-8"); res.end("complete body"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/body`;
  const bodyRead = gate(), allowBody = gate(), yieldEntered = gate(), allowYield = gate(), closeEntered = gate(), allowClose = gate();
  let clock = 0;
  let bodyDone = false;
  let yielded = false;
  const originalImmediate = globalThis.setImmediate;
  // Undici implements this callback overload internally, although Agent's
  // public declaration exposes only close(): Promise<void>.
  const originalClose = undici.Agent.prototype.close;
  const closeWithCallback = originalClose as unknown as (this: undici.Agent, callback: (error: Error | null) => void) => void;
  const client = createHttpClient({ connectionMode: mode });
  const execute = client.execute.bind(client);
  const active: Promise<unknown>[] = [];
  const restore: Array<() => void> = [];
  client.execute = (...args) => {
    const pending = execute(...args);
    active.push(pending);
    return pending;
  };
  try {
    const originalRequest = (await vi.importActual<typeof undici>("undici")).request;
    const clockSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    restore.push(() => clockSpy.mockRestore());
    const requestSpy = vi.mocked(undici.request).mockImplementation(async (...args) => {
      const response = await originalRequest(...args);
      const rawHeaders = response.headers as unknown as string[];
      const metadataHeaderIndex = rawHeaders.length;
      rawHeaders[metadataHeaderIndex] = "x-timing-metadata";
      rawHeaders[metadataHeaderIndex + 1] = "converted";
      rawHeaders.length = metadataHeaderIndex + 2;
      const gatedBody = new Transform({
        transform(chunk, _encoding, callback) { callback(null, chunk); },
        flush(callback) {
          bodyRead.release();
          void allowBody.promise.then(() => {
            clock += 17;
            bodyDone = true;
            callback();
          }, callback);
        },
      });
      response.body.pipe(gatedBody);
      Object.defineProperty(response, "body", { configurable: true, value: gatedBody });
      return response;
    });
    restore.push(() => { requestSpy.mockReset(); requestSpy.mockImplementation(originalRequest); });
    const immediateSpy = vi.spyOn(globalThis, "setImmediate").mockImplementation(((callback, ...args) => {
      if (!bodyDone || yielded) return originalImmediate(callback, ...args);
      yielded = true;
      yieldEntered.release();
      return originalImmediate(() => {
        void allowYield.promise.then(() => { clock += 80; Reflect.apply(callback, undefined, args); });
      });
    }) as typeof setImmediate);
    restore.push(() => immediateSpy.mockRestore());
    const closeSpy = vi.spyOn(undici.Agent.prototype, "close").mockImplementation(function (this: undici.Agent) {
      return (async () => {
        if (mode === "fresh") {
          closeEntered.release();
          await allowClose.promise;
          clock += 40;
        }
        await new Promise<void>((resolve, reject) => closeWithCallback.call(this, (error) => error ? reject(error) : resolve()));
      })();
    });
    restore.push(() => closeSpy.mockRestore());
    await test({ client, url, advance(ms) { clock += ms; }, async finish(pending) {
      let returned = false;
      void pending.then(() => { returned = true; }, () => { returned = true; });
      const reachedBody = await Promise.race([bodyRead.promise.then(() => true), pending.then(() => false)]);
      expect(reachedBody, "HTTP body reading must be entered").toBe(true);
      expect(returned, "must await complete response body").toBe(false);
      allowBody.release();
      await yieldEntered.promise;
      expect(returned, "must retain post-body yield").toBe(false);
      allowYield.release();
      if (mode === "fresh") {
        await closeEntered.promise;
        await Promise.resolve();
        expect(returned, "fresh close must remain awaited").toBe(false);
        allowClose.release();
      }
      return pending;
    } });
  } finally {
    allowBody.release(); allowYield.release(); allowClose.release();
    await Promise.allSettled(active);
    for (const undo of restore.reverse()) undo();
    try { await client.close(); }
    finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

describe("HTTP network timing boundary", () => {
  // Catch inclusion of request preparation, post-body yield and response conversion.
  it.each(["pooled", "fresh"] as const)("%s captures network time at body completion and awaits yield/cleanup", async (mode) => {
    await withTimedHttp(mode, async ({ client, url, advance, finish }) => {
      const headers = { get "x-prepared"() { advance(50); return "ready"; } };
      const query = [{ key: "q", get value() { advance(30); return "query"; }, enabled: true }];
      const response = await finish(client.execute({ protocol: "http", method: "GET", url, headers, query, auth: { kind: "none" } }, {
        connectTimeoutMs: 1000, totalTimeoutMs: 2000,
        runtime: { observe(event) { if (event.type === "response") advance(10); } },
      }));
      expect(response).toMatchObject({ status: 200, bodyText: "complete body", timeMs: 17 });
      expect(response.headers["x-timing-metadata"]).toBe("converted");
    });
  });

  // Catch fixing only client timeMs while executor/stress samples still measure its await.
  it.each(["pooled", "fresh"] as const)("%s real session/stress report separates network latency from complete iteration", async (mode) => {
    await withTimedHttp(mode, async ({ client, url, advance, finish }) => {
      const registry = createDefaultRegistry();
      const engine = registry.getScriptEngine("javascript")!;
      const project = createContractExecutionProject(url);
      const timedAsset = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
      timedAsset.contract.request = {
        protocol: "http", method: "GET", baseUrl: "{{baseUrl}}", path: "/",
        pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, body: { kind: "none" },
      };
      const testCase = timedAsset.cases[0]!;
      testCase.name = "timed case";
      const preOperation = "pm.variables.set('prepared', 'yes');";
      const postOperation = "pm.assert(pm.response.time === 17, 'network timer');";
      testCase.preOperations = [{ id: "timed-pre", type: "script", content: preOperation }];
      testCase.postOperations = [{ id: "timed-post", type: "script", content: postOperation }];
      testCase.assertions = [{ id: "network", target: "responseTime", op: "eq", expected: "17" }];
      const snapshot = createProjectSnapshot(project);
      const execution: ProjectExecutionRun = {
        snapshot,
        credentialBindings: { resolve: (ref) => { throw new Error(`Unexpected credential ${ref.id}`); }, versions: {} },
      };
      const bus = createEventBus();
      let eventTime: number | undefined;
      bus.on("afterResponse", (payload) => { eventTime = payload.timeMs; });
      const samples: StressSample[] = [];
      const session = createStressCaseSession({
        run: execution,
        collectionId: contractExecutionIds.collection,
        apiId: contractExecutionIds.contract,
        caseId: contractExecutionIds.case,
        environmentId: contractExecutionIds.environment,
      }, {
        createManagedClient: () => client,
        resolveProtocol: (request) => registry.getProtocol(request),
        resolveAuth: (type) => registry.getAuth(type),
        resolveAssert: (op) => registry.getAssert(op),
        scriptEngine: { language: "javascript", run(code, ctx) {
          advance(code === preOperation ? 11 : 13);
          engine.run(code, ctx);
        } }, bus,
        timeouts: { connectTimeoutMs: 1000, totalTimeoutMs: 2000 },
        observeHttp(event) { if (event.type === "response") advance(10); },
      }, { workerId: 0, confirmedTargetOrigins: [new URL(url).origin] });
      try {
        const report = await finish(new StressRunner({ createWorker: () => session, onSample: (sample) => samples.push(sample) })
          .run({ concurrency: 1, maxIterations: 1, connectionMode: mode }));
        const iteration = mode === "pooled" ? 131 : 171;
        expect(eventTime).toBe(17);
        expect(samples).toHaveLength(1);
        expect(samples[0]).toMatchObject({ requestTimeMs: 17, timeMs: 17, scriptTimeMs: 24, iterationTimeMs: iteration, requestStarted: true, requestCompleted: true, ok: true });
        expect(samples[0]?.outcome).toMatchObject({ passed: true, durationMs: iteration });
        expect(report).toMatchObject({ totalRequests: 1, ok: 1, failed: 0, latency: { avg: 17, p95: 17, p99: 17 }, iterationLatency: { avg: iteration, p95: iteration } });
      } finally { await session.close(); }
    });
  });
});

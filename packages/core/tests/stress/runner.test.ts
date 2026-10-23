import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { StressRunner } from "../../src/stress/runner.js";
import { createStressAccumulator } from "../../src/stress/metrics.js";
import { runStressSchedule } from "../../src/stress/loadScheduler.js";
import { httpClient } from "../../src/http/client.js";
import type { CaseExecutionResult } from "../../src/runner/caseExecutor.js";
import type { ExecutableRequest, ExecutionResponse, ProtocolClient } from "../../src/plugin/types.js";

let server: Server;
let hit = 0;
let baseUrl = "";
beforeAll(async () => {
  server = createServer((_q, res) => {
    hit += 1;
    res.end("ok");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const makeRunner = (buildRequest: () => ExecutableRequest) =>
  new StressRunner({ createWorker: () => {
    let closed = false;
    return {
      async execute(signal?: AbortSignal): Promise<CaseExecutionResult> {
        const request = buildRequest();
        const started = performance.now();
        try {
          const response = await httpClient.execute(request, { connectTimeoutMs: 10_000, totalTimeoutMs: 30_000, signal });
          const passed = (response.status >= 200 && response.status < 300) || response.status === 101;
          return {
            request, response, requestTimeMs: performance.now() - started, scriptTimeMs: 0,
            iterationTimeMs: performance.now() - started,
            outcome: { apiId: "api", apiName: "api", caseId: "case", caseName: "case", passed, durationMs: performance.now() - started, assertions: [], failureKind: passed ? undefined : "http" },
            failureKind: passed ? undefined : "http",
          };
        } catch (error) {
          return {
            request, requestTimeMs: performance.now() - started, scriptTimeMs: 0, iterationTimeMs: performance.now() - started,
            outcome: { apiId: "api", apiName: "api", caseId: "case", caseName: "case", passed: false, durationMs: performance.now() - started, assertions: [], error: error instanceof Error ? error.message : String(error), failureKind: "transport" },
            failureKind: "transport",
          };
        }
      },
      async close() { if (!closed) closed = true; },
    };
  } });

const fakeClient = (
  respond: (req: ExecutableRequest) => ExecutionResponse | Promise<ExecutionResponse>,
): ProtocolClient => ({ name: "fake", canHandle: () => true, execute: async (req) => respond(req) });

const httpRequest = (url: string): ExecutableRequest => ({
  protocol: "http", method: "GET", url, headers: {}, query: [], auth: { kind: "none" },
});

describe("StressRunner", () => {
  it("preserves joint HTTP failure/status facts for mixed script400 and http500 locally and after worker merge", async () => {
    const facts = [{ status: 400, failureKind: "script" as const }, { status: 500, failureKind: "http" as const }];
    const local = await new StressRunner({ createWorker: () => { let cursor = 0; return { async execute() {
      const fact = facts[cursor++]!;
      return { request: httpRequest("http://127.0.0.1/"), response: { status: fact.status, headers: {}, bodyText: "", timeMs: 1 },
        requestTimeMs: 1, scriptTimeMs: 1, iterationTimeMs: 2, requestStarted: true, requestCompleted: true, failureKind: fact.failureKind,
        outcome: { apiId: "a", apiName: "a", caseId: "c", caseName: "c", passed: false, durationMs: 2, assertions: [], failureKind: fact.failureKind, error: "synthetic-failure" } };
    }, close: async () => {} }; } }).run({ concurrency: 1, maxIterations: 2 });
    const remote = await new StressRunner({ createWorker: () => { throw new Error("remote VU only"); }, async runSchedule(schedule, deps) {
      const observations = createStressAccumulator(schedule.metricPlan, deps.runId, { sourceId: "worker", scope: "observations" }); let cursor = 0;
      return runStressSchedule(schedule, { ...deps, createVu: async () => ({ async execute(context) {
        const fact = facts[cursor++]!;
        observations.observe({ kind: "case", ...context.observation!(), stageId: context.stageId, vuId: context.vuId, iterationId: context.iterationId,
          ok: false, status: fact.status, failureKind: fact.failureKind, requestStarted: true, requestCompleted: true, requestTimeMs: 1, scriptTimeMs: 1, iterationTimeMs: 2,
          locator: { collectionId: "c", folderIds: [], apiId: "a", caseId: "c", scope: "base" }, nodeKey: null });
        return { state: "failed", durationMs: 2 };
      }, close: async () => {} }), closeRun: async () => { deps.metrics.merge(observations.snapshot()); } });
    } }).run({ concurrency: 1, maxIterations: 2 });
    expect(local.errorKinds).toEqual({ script: 1, HTTP_500: 1 });
    expect(remote.errorKinds).toEqual({ script: 1, HTTP_500: 1 });
    for (const report of [local, remote]) {
      expect(report.statusDist).toEqual({ 400: 1, 500: 1 }); expect(report.failed).toBe(2);
      expect(report.failures).toMatchObject({ script: 1, http: 1 }); expect(report.eligibleFailureCounts).toMatchObject({ script: 1, http: 1 });
    }
  });
  it("C1 keeps at most 20 safe failure evidence samples while aggregating all 25 failures", async () => {
    let projectionStarted = false; let projectedBeforeStop = false;
    const report = await new StressRunner({ createGeneratorCollector: () => ({ recordSchedulerBacklog() {}, stop() { projectedBeforeStop = projectionStarted; return { availability: "unavailable", unavailableReason: "fixture" }; } }), createWorker: () => ({
      async execute() { return { request: httpRequest("https://example.test"), response: { status: 200, headers: {}, get bodyText() { projectionStarted = true; return "private-token"; }, timeMs: 1 }, requestTimeMs: 1, scriptTimeMs: 0, iterationTimeMs: 1,
        requestStarted: true, requestCompleted: true, failureKind: "extraction", outcome: { apiId: "a", apiName: "a", caseId: "c", caseName: "c", passed: false, durationMs: 1, assertions: [], failureKind: "extraction" },
        extractionOutcomes: [{ id: "x", name: "token", selector: { target: "bodyText", match: "first" }, status: "failed", pass: false, sensitive: true, published: false, code: "EXTRACTION", message: "private-token", value: "private-token" }] } as CaseExecutionResult; },
      async close() {},
    }) }).run({ concurrency: 1, maxIterations: 25 });
    expect(report.totalRequests).toBe(25); expect(report.failed).toBe(25);
    expect(report.failureEvidence).toHaveLength(20);
    expect(projectedBeforeStop).toBe(true); // Non-private local runs retain their original generator billing boundary.
    expect(JSON.stringify(report)).not.toContain("private-token");
  });
  it("迭代模式：恰好 N 次请求、样本数一致、无失败", async () => {
    hit = 0;
    const runner = makeRunner(() => httpRequest(`${baseUrl}/x`));
    const report = await runner.run({ concurrency: 4, maxIterations: 20 });
    expect(hit).toBe(20);
    expect(report.totalRequests).toBe(20);
    expect(report.failed).toBe(0);
    expect(report.concurrency).toBe(4);
  });

  it("报告记录实际 connectionMode 配置", async () => {
    const report = await makeRunner(() => httpRequest(`${baseUrl}/x`)).run({
      concurrency: 1, maxIterations: 1, connectionMode: "fresh",
    });
    expect(report.connectionMode).toBe("fresh");
  });

  it("时长模式：deadline 后停止且至少完成一次采样", async () => {
    hit = 0;
    const runner = makeRunner(() => httpRequest(`${baseUrl}/x`));
    const report = await runner.run({ concurrency: 2, durationMs: 300 });
    expect(report.totalRequests).toBeGreaterThanOrEqual(1);
    expect(report.durationMs).toBeLessThan(5_000);
  });

  it("没有可评估样本时 verdict 失败并写入稳定 noData violation", async () => {
    const runner = makeRunner(() => httpRequest(`${baseUrl}/x`));
    const controller = new AbortController();
    controller.abort();
    const report = await runner.run({ concurrency: 1, maxIterations: 1, signal: controller.signal });
    expect(report.totalRequests).toBe(0);
    expect(report.verdict?.passed).toBe(false);
    expect(report.verdict?.violations.some((violation) => violation.metric === "noData")).toBe(true);
  });

  it("都给时先到先停：迭代数先耗尽即停（远期 deadline 不拖尾）", async () => {
    hit = 0;
    const runner = makeRunner(() => httpRequest(`${baseUrl}/x`));
    const report = await runner.run({ concurrency: 2, maxIterations: 3, durationMs: 60_000 });
    expect(hit).toBe(3);
    expect(report.totalRequests).toBe(3);
  });

  it("对拒连目标的错误计入 failed 且有错误分类", async () => {
    const runner = makeRunner(() => httpRequest("http://127.0.0.1:1/"));
    const report = await runner.run({ concurrency: 2, maxIterations: 4 });
    expect(report.failed).toBe(4);
    expect(Object.keys(report.errorKinds).length).toBeGreaterThan(0);
  });

  it("都不给 maxIterations/durationMs 抛错；concurrency 非正整数抛错", async () => {
    const runner = makeRunner(() => httpRequest(`${baseUrl}/x`));
    await expect(runner.run({ concurrency: 1 })).rejects.toThrow("maxIterations");
    await expect(runner.run({ concurrency: 0, maxIterations: 1 })).rejects.toThrow("concurrency");
  });

  it.each([
    [Number.NaN, "durationMs"], [Number.POSITIVE_INFINITY, "durationMs"], [0, "durationMs"], [-1, "durationMs"],
  ])("在创建 collector/session 前拒绝非法 durationMs=%s", async (durationMs, field) => {
    const createWorker = vi.fn(() => ({ execute: async () => { throw new Error("must not execute"); }, close: async () => {} }));
    const runner = new StressRunner({ createWorker });
    await expect(runner.run({ concurrency: 1, durationMs })).rejects.toThrow(field);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it.each([1.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, Number.NaN, 0, -1])
    ("在创建 collector/session 前拒绝非法 maxIterations=%s", async (maxIterations) => {
      const createWorker = vi.fn(() => ({ execute: async () => { throw new Error("must not execute"); }, close: async () => {} }));
      const runner = new StressRunner({ createWorker });
      await expect(runner.run({ concurrency: 1, maxIterations })).rejects.toThrow("maxIterations");
      expect(createWorker).not.toHaveBeenCalled();
    });

  it("all-aborted 样本按 eligible completed attempts=0 判 noData，而不是 samples.length", async () => {
    const runner = new StressRunner({
      createWorker: () => ({
        execute: async () => ({
          request: httpRequest("http://fake/"),
          requestStarted: true, requestCompleted: true,
          requestTimeMs: 1, scriptTimeMs: 0, iterationTimeMs: 1,
          outcome: { apiId: "api", apiName: "api", caseId: "case", caseName: "case", passed: false, durationMs: 1, assertions: [], failureKind: "aborted" as const },
          failureKind: "aborted" as const,
        }),
        close: async () => {},
      }),
    });
    const report = await runner.run({ concurrency: 1, maxIterations: 1 });
    expect(report.totalRequests).toBe(1);
    expect(report.eligibleCompletedAttempts).toBe(0);
    expect(report.verdict?.passed).toBe(false);
    expect(report.verdict?.violations.filter((v) => v.metric === "noData")).toHaveLength(1);
  });

  it("混合 pre-I/O safety rejection 与成功请求时 correctness verdict 仍失败", async () => {
    let calls = 0;
    const runner = new StressRunner({
      createWorker: () => ({
        execute: async () => {
          calls += 1;
          const request = httpRequest("http://example.com/");
          if (calls === 1) {
            return {
              request, requestStarted: false, requestCompleted: false,
              requestTimeMs: 0, scriptTimeMs: 0, iterationTimeMs: 1,
              outcome: {
                apiId: "api", apiName: "api", caseId: "case", caseName: "case", passed: false, durationMs: 1,
                assertions: [], error: "target_confirmation_required", failureKind: "config" as const,
              },
              failureKind: "config" as const,
              safety: {
                origin: "https://example.com", confirmation: "rejected", policy: "target_confirmation_required",
                loopback: false, appliedPolicy: { trustedOrigins: [], deniedOrigins: [] },
              },
            };
          }
          return {
            request, requestStarted: true, requestCompleted: true,
            requestTimeMs: 10, scriptTimeMs: 0, iterationTimeMs: 10,
            outcome: { apiId: "api", apiName: "api", caseId: "case", caseName: "case", passed: true, durationMs: 10, assertions: [] },
          };
        },
        close: async () => {},
      }),
    });

    const report = await runner.run({ concurrency: 1, maxIterations: 2 });
    expect(report.totalRequests).toBe(2);
    expect(report.ok).toBe(1);
    expect(report.failures.config).toBe(1);
    expect(report.eligibleFailureCounts?.config).toBe(0);
    expect(report.verdict?.passed).toBe(false);
    expect(report.verdict?.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "businessFailures", actual: 1 }),
    ]));
  });

  it("非 2xx：ok=false 且不写 error（HTTP_ 分类由聚合派生，statusDist 保留状态）", async () => {
    const client = fakeClient(() => ({ status: 500, headers: {}, bodyText: "", timeMs: 1 }));
    const runner = new StressRunner({
      createWorker: () => ({
        execute: async () => {
          const request = httpRequest("http://fake/");
          const res = await client.execute(request, { connectTimeoutMs: 10_000, totalTimeoutMs: 30_000 });
          return { request, response: res, requestTimeMs: 1, scriptTimeMs: 0, iterationTimeMs: 1,
            outcome: { apiId: "api", apiName: "api", caseId: "case", caseName: "case", passed: false, durationMs: 1, assertions: [], failureKind: "http" as const }, failureKind: "http" as const };
        }, close: async () => {},
      }),
    });
    const report = await runner.run({ concurrency: 2, maxIterations: 2 });
    expect(report.ok).toBe(0);
    expect(report.failed).toBe(2);
    expect(report.statusDist).toEqual({ "500": 2 });
    expect(report.errorKinds).toEqual({ HTTP_500: 2 });
    expect(report.failures.http).toBe(2);
    expect(report.verdict?.passed).toBe(false);
    expect(report.verdict?.violations[0]?.metric).toBe("businessFailures");
  });

  it.each(["assertion", "extraction"] as const)("A3 HTTP 200 failure %s causes failed verdict", async (failureKind) => {
    const runner = new StressRunner({
      createWorker: () => ({
        execute: async () => ({
          request: httpRequest("http://fake/"),
          response: { status: 200, headers: {}, bodyText: "", timeMs: 1 }, requestTimeMs: 1, scriptTimeMs: 2, iterationTimeMs: 3,
          outcome: { apiId: "api", apiName: "api", caseId: "case", caseName: "case", passed: false, durationMs: 3, assertions: [{ pass: false, message: "expected" }], failureKind },
          failureKind,
        }),
        close: async () => {},
      }),
    });
    const report = await runner.run({ concurrency: 1, maxIterations: 1 });
    expect(report.ok).toBe(0);
    expect(report.failures[failureKind]).toBe(1);
    expect(report.statusDist).toEqual({ "200": 1 });
    expect(report.verdict?.passed).toBe(false);
  });

  it("signal aborted 后停止发起新采样（MVP 不中断进行中请求）", async () => {
    const controller = new AbortController();
    let calls = 0;
    let closed = 0;
    const client = fakeClient(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      controller.abort();
      return { status: 200, headers: {}, bodyText: "", timeMs: 1 };
    });
    const runner = new StressRunner({
      createWorker: () => ({ execute: async (signal) => {
        expect(signal).toBe(controller.signal);
        calls += 1;
        await new Promise((r) => setTimeout(r, 20));
        controller.abort();
        const request = httpRequest("http://fake/");
        return { request, response: { status: 200, headers: {}, bodyText: "", timeMs: 1 }, requestTimeMs: 1, scriptTimeMs: 0, iterationTimeMs: 1,
          outcome: { apiId: "api", apiName: "api", caseId: "case", caseName: "case", passed: true, durationMs: 1, assertions: [] }, };
      }, close: async () => { closed += 1; } }),
    });
    const report = await runner.run({ concurrency: 1, maxIterations: 100, signal: controller.signal });
    expect(calls).toBe(1);
    expect(report.totalRequests).toBe(1);
    expect(closed).toBe(1);
  });

  it("measurement window 排除慢 session setup 与 teardown", async () => {
    const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const runner = new StressRunner({
      createWorker: async () => {
        await pause(50);
        return {
          execute: async () => {
            await pause(10);
            return {
              request: httpRequest("http://fake/"),
              response: { status: 200, headers: {}, bodyText: "", timeMs: 1 }, requestTimeMs: 1, scriptTimeMs: 0, iterationTimeMs: 1,
              outcome: { apiId: "api", apiName: "api", caseId: "case", caseName: "case", passed: true, durationMs: 1, assertions: [] },
            };
          },
          close: async () => { await pause(50); },
        };
      },
    });
    const report = await runner.run({ concurrency: 1, maxIterations: 1, thresholds: { minRps: 10 } });
    expect(report.durationMs).toBeLessThan(40);
    expect(report.rps).toBeGreaterThanOrEqual(10);
    expect(report.verdict?.passed).toBe(true);
  });

  it("buildRequest 工厂每次采样调用（动态变量每请求变化）", async () => {
    const seen: string[] = [];
    const client = fakeClient((req) => {
      seen.push(req.url);
      return { status: 200, headers: {}, bodyText: "", timeMs: 1 };
    });
    let i = 0;
    const runner = new StressRunner({
      createWorker: () => ({ execute: async () => {
        const request = httpRequest(`req-${++i}`);
        seen.push(request.url);
        return { request, response: { status: 200, headers: {}, bodyText: "", timeMs: 1 }, requestTimeMs: 1, scriptTimeMs: 0, iterationTimeMs: 1,
          outcome: { apiId: "api", apiName: "api", caseId: "case", caseName: "case", passed: true, durationMs: 1, assertions: [] }, };
      }, close: async () => {} }),
    });
    await runner.run({ concurrency: 3, maxIterations: 6 });
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
  });

  it("每个 worker 只创建一次 session，并在成功、异常、中止路径各关闭一次", async () => {
    const closeCounts: number[] = [];
    let created = 0;
    const runner = new StressRunner({ createWorker: () => {
      const index = created++;
      closeCounts[index] = 0;
      let calls = 0;
      return {
        execute: async () => {
          calls += 1;
          if (index === 1) return { request: httpRequest("worker-failed"), requestTimeMs: 1, scriptTimeMs: 0, iterationTimeMs: 1,
            outcome: { apiId: "api", apiName: "api", caseId: "case", caseName: "case", passed: false, durationMs: 1, assertions: [], error: "worker failed", failureKind: "transport" as const }, failureKind: "transport" as const };
          const request = httpRequest(`worker-${index}-${calls}`);
          return { request, response: { status: 200, headers: {}, bodyText: "", timeMs: 1 }, requestTimeMs: 1, scriptTimeMs: 0, iterationTimeMs: 1,
            outcome: { apiId: "api", apiName: "api", caseId: "case", caseName: "case", passed: true, durationMs: 1, assertions: [] }, };
        }, close: async () => { closeCounts[index] += 1; },
      };
    } });
    const report = await runner.run({ concurrency: 3, maxIterations: 3 });
    expect(report.totalRequests).toBe(3);
    expect(created).toBe(3);
    expect(closeCounts).toEqual([1, 1, 1]);
  });

  it("factory reject 会停止施压，等待已创建 worker close 后再抛错", async () => {
    let calls = 0;
    let closed = 0;
    const runner = new StressRunner({ createWorker: (workerId) => {
      if (workerId === 1) return Promise.reject(new Error("factory failed"));
      return {
        execute: async () => {
          calls += 1;
          await new Promise((resolve) => setTimeout(resolve, 10));
          const request = httpRequest("worker");
          return { request, response: { status: 200, headers: {}, bodyText: "", timeMs: 1 }, requestTimeMs: 1, scriptTimeMs: 0, iterationTimeMs: 1,
            outcome: { apiId: "api", apiName: "api", caseId: "case", caseName: "case", passed: true, durationMs: 1, assertions: [] } };
        }, close: async () => { closed += 1; },
      };
    } });
    await expect(runner.run({ concurrency: 2, maxIterations: 100 })).rejects.toThrow("factory failed");
    expect(calls).toBeLessThan(100);
    expect(closed).toBe(1);
  });

  it("close reject 会停止其他 worker 的新迭代，并等待其他 worker close 后再抛错", async () => {
    let calls = 0;
    let closed = 0;
    const runner = new StressRunner({ createWorker: (workerId) => ({
      execute: async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, workerId === 0 ? 5 : 15));
        const request = httpRequest(`worker-${workerId}`);
        return { request, response: { status: 200, headers: {}, bodyText: "", timeMs: 1 }, requestTimeMs: 1, scriptTimeMs: 0, iterationTimeMs: 1,
          outcome: { apiId: "api", apiName: "api", caseId: "case", caseName: "case", passed: true, durationMs: 1, assertions: [] } };
      }, close: async () => { closed += 1; if (workerId === 0) throw new Error("close failed"); },
    }) });
    await expect(runner.run({ concurrency: 2, maxIterations: 100, durationMs: 50 })).rejects.toThrow("close failed");
    expect(calls).toBeLessThan(100);
    expect(closed).toBe(2);
  });

  it("falsy factory rejection 也会 stop 并以原值 reject", async () => {
    const runner = new StressRunner({ createWorker: (workerId) => workerId === 1
      ? Promise.reject(undefined)
      : { execute: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); throw new Error("should stop"); }, close: async () => {} } });
    await expect(runner.run({ concurrency: 2, maxIterations: 10 })).rejects.toBeUndefined();
  });

  it("worker 主体错误优先于 close 错误，且所有已建 session 仍 close", async () => {
    let closed = 0;
    const runner = new StressRunner({ createWorker: () => ({
      execute: async () => { throw new Error("body failed"); },
      close: async () => { closed += 1; throw new Error("close failed"); },
    }) });
    await expect(runner.run({ concurrency: 1, maxIterations: 1 })).rejects.toThrow("body failed");
    expect(closed).toBe(1);
  });

  it("跨 worker cleanup 先失败也不能覆盖稍后到达的主体错误", async () => {
    const events: string[] = [];
    const runner = new StressRunner({ createWorker: (workerId) => ({
      execute: async () => {
        if (workerId === 0) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return { request: httpRequest("a"), requestTimeMs: 1, scriptTimeMs: 0, iterationTimeMs: 1,
            outcome: { apiId: "a", apiName: "a", caseId: "a", caseName: "a", passed: true, durationMs: 1, assertions: [] } };
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error("body later");
      },
      close: async () => { events.push(`close-${workerId}`); if (workerId === 0) throw new Error("cleanup first"); },
    }) });
    await expect(runner.run({ concurrency: 2, maxIterations: 2 })).rejects.toThrow("body later");
    expect(events).toEqual(["close-0", "close-1"]);
  });
});

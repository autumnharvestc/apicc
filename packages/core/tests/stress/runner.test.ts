import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StressRunner } from "../../src/stress/runner.js";
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

describe("StressRunner", () => {
  it("迭代模式：恰好 N 次请求、样本数一致、无失败", async () => {
    hit = 0;
    const runner = makeRunner(() => ({ method: "GET", url: `${baseUrl}/x`, headers: {}, query: [] }));
    const report = await runner.run({ concurrency: 4, maxIterations: 20 });
    expect(hit).toBe(20);
    expect(report.totalRequests).toBe(20);
    expect(report.failed).toBe(0);
    expect(report.concurrency).toBe(4);
  });

  it("时长模式：deadline 后停止且至少完成一次采样", async () => {
    hit = 0;
    const runner = makeRunner(() => ({ method: "GET", url: `${baseUrl}/x`, headers: {}, query: [] }));
    const report = await runner.run({ concurrency: 2, durationMs: 300 });
    expect(report.totalRequests).toBeGreaterThanOrEqual(1);
    expect(report.durationMs).toBeLessThan(5_000);
  });

  it("都给时先到先停：迭代数先耗尽即停（远期 deadline 不拖尾）", async () => {
    hit = 0;
    const runner = makeRunner(() => ({ method: "GET", url: `${baseUrl}/x`, headers: {}, query: [] }));
    const report = await runner.run({ concurrency: 2, maxIterations: 3, durationMs: 60_000 });
    expect(hit).toBe(3);
    expect(report.totalRequests).toBe(3);
  });

  it("对拒连目标的错误计入 failed 且有错误分类", async () => {
    const runner = makeRunner(() => ({ method: "GET", url: "http://127.0.0.1:1/", headers: {}, query: [] }));
    const report = await runner.run({ concurrency: 2, maxIterations: 4 });
    expect(report.failed).toBe(4);
    expect(Object.keys(report.errorKinds).length).toBeGreaterThan(0);
  });

  it("都不给 maxIterations/durationMs 抛错；concurrency 非正整数抛错", async () => {
    const runner = makeRunner(() => ({ method: "GET", url: `${baseUrl}/x`, headers: {}, query: [] }));
    await expect(runner.run({ concurrency: 1 })).rejects.toThrow("maxIterations");
    await expect(runner.run({ concurrency: 0, maxIterations: 1 })).rejects.toThrow("concurrency");
  });

  it("非 2xx：ok=false 且不写 error（HTTP_ 分类由聚合派生，statusDist 保留状态）", async () => {
    const client = fakeClient(() => ({ status: 500, headers: {}, bodyText: "", timeMs: 1 }));
    const runner = new StressRunner({
      createWorker: () => ({
        execute: async () => {
          const request = { method: "GET" as const, url: "http://fake/", headers: {}, query: [] };
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

  it("HTTP 200 但断言失败归类 assertion 并导致 verdict 失败", async () => {
    const runner = new StressRunner({
      createWorker: () => ({
        execute: async () => ({
          request: { method: "GET" as const, url: "http://fake/", headers: {}, query: [] },
          response: { status: 200, headers: {}, bodyText: "", timeMs: 1 }, requestTimeMs: 1, scriptTimeMs: 2, iterationTimeMs: 3,
          outcome: { apiId: "api", apiName: "api", caseId: "case", caseName: "case", passed: false, durationMs: 3, assertions: [{ pass: false, message: "expected" }], failureKind: "assertion" as const },
          failureKind: "assertion" as const,
        }),
        close: async () => {},
      }),
    });
    const report = await runner.run({ concurrency: 1, maxIterations: 1 });
    expect(report.ok).toBe(0);
    expect(report.failures.assertion).toBe(1);
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
        const request = { method: "GET" as const, url: "http://fake/", headers: {}, query: [] };
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
              request: { method: "GET" as const, url: "http://fake/", headers: {}, query: [] },
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
        const request = { method: "GET" as const, url: `req-${++i}`, headers: {}, query: [] };
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
          if (index === 1) return { request: { method: "GET" as const, url: "worker-failed", headers: {}, query: [] }, requestTimeMs: 1, scriptTimeMs: 0, iterationTimeMs: 1,
            outcome: { apiId: "api", apiName: "api", caseId: "case", caseName: "case", passed: false, durationMs: 1, assertions: [], error: "worker failed", failureKind: "transport" as const }, failureKind: "transport" as const };
          const request = { method: "GET" as const, url: `worker-${index}-${calls}`, headers: {}, query: [] };
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
          const request = { method: "GET" as const, url: "worker", headers: {}, query: [] };
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
        const request = { method: "GET" as const, url: `worker-${workerId}`, headers: {}, query: [] };
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
          return { request: { method: "GET" as const, url: "a", headers: {}, query: [] }, requestTimeMs: 1, scriptTimeMs: 0, iterationTimeMs: 1,
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

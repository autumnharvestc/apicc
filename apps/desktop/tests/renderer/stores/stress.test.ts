import { describe, expect, it, vi } from "vitest";
import { createStressStore } from "../../../src/renderer/src/stores/stress.js";
import type { ApiccApi, StressRunOutput } from "../../../src/shared/types.js";

function apiStub(stressRun: ApiccApi["stressRun"], stressStop: ApiccApi["stressStop"] = vi.fn(async () => ({ ok: true, report, } as StressRunOutput))): ApiccApi {
  return { stressRun, stressStop, } as unknown as ApiccApi;
}

const report = { concurrency: 1, totalRequests: 1, ok: 1, failed: 0, durationMs: 1, rps: 1, latency: { min: 1, avg: 1, max: 1, p50: 1, p90: 1, p95: 1, p99: 1 }, statusDist: {}, errorKinds: {}, startedAt: 1, finishedAt: 2 };

describe("stress store credibility controls", () => {
  it("omits empty thresholds and carries fresh mode plus explicit origins", async () => {
    const calls: unknown[] = [];
    const api = apiStub(async (input) => { calls.push(input); return { ok: true, report, } as StressRunOutput; });
    const stress = createStressStore({ api, resolveProjectId: () => "project-a" });
    stress.form.caseId = "case";
    stress.form.connectionMode = "fresh";
    stress.form.thresholds.maxErrorRate = 0.1;
    await stress.start("api");
    expect(calls[0]).toMatchObject({ connectionMode: "fresh", thresholds: { maxErrorRate: 0.1 } });
    expect((calls[0] as { confirmedTargetOrigins?: string[] }).confirmedTargetOrigins).toBeUndefined();
  });

  it("holds exact target confirmation and retries only with that origin", async () => {
    const calls: unknown[] = [];
    const api = apiStub(async (input) => {
      calls.push(input);
      if (calls.length === 1) return { ok: false, error: { code: "target_confirmation_required", message: "confirm", targetOrigin: "https://example.com" } };
      return { ok: true, report, } as StressRunOutput;
    });
    const stress = createStressStore({ api, resolveProjectId: () => "project-a" });
    stress.form.caseId = "case";
    await stress.start("api");
    expect(stress.pendingTargetOrigin).toBe("https://example.com");
    await stress.confirmTarget("api", false);
    expect(calls[1]).toMatchObject({ confirmedTargetOrigins: ["https://example.com"] });
    expect(stress.confirmedTargetOrigins).toEqual([]);
  });

  it("顶层二次 start 不复用前一条确认链，拒绝也不泄漏 origin", async () => {
    const calls: unknown[] = [];
    const api = apiStub(async (input) => {
      calls.push(input);
      return calls.length === 1
        ? { ok: false, error: { code: "target_confirmation_required", message: "confirm", targetOrigin: "https://example.com" } }
        : { ok: true, report } as StressRunOutput;
    });
    const stress = createStressStore({ api, resolveProjectId: () => "project-a" });
    stress.form.caseId = "case";
    await stress.start("api");
    await stress.confirmTarget("api", false);
    await stress.start("api");
    expect(calls[2]).not.toHaveProperty("confirmedTargetOrigins");
    expect(stress.confirmedTargetOrigins).toEqual([]);
    stress.pendingTargetOrigin = "https://example.com";
    stress.pendingConfirmation = { origin: "https://example.com", apiId: "api", projectId: "project-a", generation: stress.generation, token: stress.attemptToken };
    stress.denyTarget();
    expect(stress.confirmedTargetOrigins).toEqual([]);
    expect(stress.pendingTargetOrigin).toBeNull();
  });

  it("信任项目使用实际 API 所属项目；持久化失败不重试、不加入 confirmed", async () => {
    const calls: unknown[] = [];
    let trustedProject = "";
    const api = apiStub(async (input) => {
      calls.push(input);
      return { ok: false, error: { code: "target_confirmation_required", message: "confirm", targetOrigin: "https://example.com" } };
    });
    const stress = createStressStore({
      api,
      resolveProjectId: () => "actual-project",
      trustOrigin: async (projectId) => { trustedProject = projectId; throw new Error("persist failed"); },
    });
    stress.form.caseId = "case";
    await stress.start("api");
    await expect(stress.confirmTarget("api", true)).rejects.toThrow("persist failed");
    expect(trustedProject).toBe("actual-project");
    expect(calls).toHaveLength(1);
    expect(stress.confirmedTargetOrigins).toEqual([]);
    expect(stress.pendingTargetOrigin).toBeNull();
  });

  it("确认持久化等待期间切换 API 会使旧 token 失效", async () => {
    const calls: unknown[] = [];
    let release!: () => void;
    const persist = new Promise<void>((resolve) => { release = resolve; });
    const api = apiStub(async (input) => {
      calls.push(input);
      return calls.length === 1
        ? { ok: false, error: { code: "target_confirmation_required", message: "confirm", targetOrigin: "https://example.com" } }
        : { ok: true, report } as StressRunOutput;
    });
    const stress = createStressStore({ api, resolveProjectId: () => "actual-project", trustOrigin: async () => persist });
    stress.form.caseId = "case";
    await stress.start("api");
    const retry = stress.confirmTarget("api", true);
    stress.clear();
    release();
    await retry;
    expect(calls).toHaveLength(1);
    expect(stress.confirmedTargetOrigins).toEqual([]);
  });
});

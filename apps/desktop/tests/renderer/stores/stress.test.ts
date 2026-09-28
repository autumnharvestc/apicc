import { describe, expect, it, vi } from "vitest";
import { createStressStore } from "../../../src/renderer/src/stores/stress.js";
import type { ApiccApi, StressRunOutput } from "../../../src/shared/types.js";

function apiStub(stressRun: ApiccApi["stressRun"]): ApiccApi {
  return { stressRun, stressStop: vi.fn(), } as unknown as ApiccApi;
}

const report = { concurrency: 1, totalRequests: 1, ok: 1, failed: 0, durationMs: 1, rps: 1, latency: { min: 1, avg: 1, max: 1, p50: 1, p90: 1, p95: 1, p99: 1 }, statusDist: {}, errorKinds: {}, startedAt: 1, finishedAt: 2 };

describe("stress store credibility controls", () => {
  it("omits empty thresholds and carries fresh mode plus explicit origins", async () => {
    const calls: unknown[] = [];
    const api = apiStub(async (input) => { calls.push(input); return { report, } as StressRunOutput; });
    const stress = createStressStore({ api });
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
      if (calls.length === 1) throw Object.assign(new Error("confirm"), { code: "target_confirmation_required", targetOrigin: "https://example.com" });
      return { report, } as StressRunOutput;
    });
    const stress = createStressStore({ api });
    stress.form.caseId = "case";
    await stress.start("api");
    expect(stress.pendingTargetOrigin).toBe("https://example.com");
    await stress.confirmTarget("api", false);
    expect(calls[1]).toMatchObject({ confirmedTargetOrigins: ["https://example.com"] });
  });
});

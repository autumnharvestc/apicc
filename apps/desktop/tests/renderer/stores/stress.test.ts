import { describe, expect, it, vi } from "vitest";
import { createStressStore } from "../../../src/renderer/src/stores/stress.js";
import type { ApiccApi, StressRunOutput } from "../../../src/shared/types.js";
import type { ApiLocator, ProjectLocator } from "../../../src/shared/locations.js";

const root = "C:/apicc-task10b-stress";
const apiLocator: ApiLocator = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  groupId: "00000000-0000-4000-8000-000000000002",
  projectId: "00000000-0000-4000-8000-000000000003",
  collectionId: "00000000-0000-4000-8000-000000000004",
  folderIds: ["00000000-0000-4000-8000-000000000005"],
  apiId: "00000000-0000-4000-8000-000000000006",
};
const otherApiLocator: ApiLocator = {
  ...apiLocator,
  groupId: "00000000-0000-4000-8000-000000000012",
  projectId: "00000000-0000-4000-8000-000000000013",
  collectionId: "00000000-0000-4000-8000-000000000014",
  folderIds: ["00000000-0000-4000-8000-000000000015"],
};
const projectLocator: ProjectLocator = {
  workspaceId: apiLocator.workspaceId,
  groupId: apiLocator.groupId,
  projectId: apiLocator.projectId,
};
const report = { concurrency: 1, totalRequests: 1, ok: 1, failed: 0, durationMs: 1, rps: 1, latency: { min: 1, avg: 1, max: 1, p50: 1, p90: 1, p95: 1, p99: 1 }, statusDist: {}, errorKinds: {}, startedAt: 1, finishedAt: 2 };

function apiStub(stressRun: ApiccApi["stressRun"], stressStop: ApiccApi["stressStop"] = vi.fn(async () => ({ ok: true, report } as StressRunOutput))): ApiccApi {
  return { stressRun, stressStop } as unknown as ApiccApi;
}

function setup(api: ApiccApi, locator: ApiLocator | null = apiLocator) {
  const context = { root, locator };
  const stress = createStressStore({
    api,
    getContext: () => context,
    trustOrigin: vi.fn(async () => {}),
  });
  stress.form.caseId = "case";
  return { stress, context };
}

describe("stress store local identity and credibility controls", () => {
  it("sends the complete active API locator and omits empty thresholds", async () => {
    const calls: unknown[] = [];
    const { stress } = setup(apiStub(async (input) => { calls.push(input); return { ok: true, report } as StressRunOutput; }));
    stress.form.connectionMode = "fresh";
    stress.form.thresholds.maxErrorRate = 0.1;
    await stress.start(apiLocator);
    expect(calls[0]).toMatchObject({ locator: apiLocator, caseId: "case", connectionMode: "fresh", thresholds: { maxErrorRate: 0.1 } });
    expect((calls[0] as { confirmedTargetOrigins?: string[] }).confirmedTargetOrigins).toBeUndefined();
  });

  it("holds exact target confirmation and retries only with that origin", async () => {
    const calls: unknown[] = [];
    const api = apiStub(async (input) => {
      calls.push(input);
      if (calls.length === 1) return { ok: false, error: { code: "target_confirmation_required", message: "confirm", targetOrigin: "https://example.com" } };
      return { ok: true, report } as StressRunOutput;
    });
    const { stress } = setup(api);
    await stress.start(apiLocator);
    expect(stress.pendingTargetOrigin).toBe("https://example.com");
    await stress.confirmTarget(apiLocator, false);
    expect(calls[1]).toMatchObject({ locator: apiLocator, confirmedTargetOrigins: ["https://example.com"] });
    expect(stress.confirmedTargetOrigins).toEqual([]);
  });

  it("accumulates exact confirmed origins through one retry chain, then clears them", async () => {
    const calls: unknown[] = [];
    const api = apiStub(async (input) => {
      calls.push(input);
      if (calls.length === 1) return { ok: false, error: { code: "target_confirmation_required", message: "confirm", targetOrigin: "https://one.example" } };
      if (calls.length === 2) return { ok: false, error: { code: "target_confirmation_required", message: "confirm", targetOrigin: "https://two.example" } };
      return { ok: true, report } as StressRunOutput;
    });
    const { stress } = setup(api);
    await stress.start(apiLocator);
    await stress.confirmTarget(apiLocator, false);
    expect(calls[1]).toMatchObject({ confirmedTargetOrigins: ["https://one.example"] });
    await stress.confirmTarget(apiLocator, false);
    expect(calls[2]).toMatchObject({ confirmedTargetOrigins: ["https://one.example", "https://two.example"] });
    expect(stress.confirmedTargetOrigins).toEqual([]);
    expect(stress.pendingTargetOrigin).toBeNull();
  });

  it("a fresh top-level start does not reuse the prior confirmation chain", async () => {
    const calls: unknown[] = [];
    const api = apiStub(async (input) => {
      calls.push(input);
      return calls.length === 1
        ? { ok: false, error: { code: "target_confirmation_required", message: "confirm", targetOrigin: "https://example.com" } }
        : { ok: true, report } as StressRunOutput;
    });
    const { stress } = setup(api);
    await stress.start(apiLocator);
    await stress.confirmTarget(apiLocator, false);
    await stress.start(apiLocator);
    expect(calls[2]).not.toHaveProperty("confirmedTargetOrigins");
    expect(stress.confirmedTargetOrigins).toEqual([]);
    stress.denyTarget();
    expect(stress.pendingTargetOrigin).toBeNull();
  });

  it("trust persists against the exact project locator; persistence failure does not retry", async () => {
    const calls: unknown[] = [];
    const trusted: ProjectLocator[] = [];
    const api = apiStub(async (input) => {
      calls.push(input);
      return { ok: false, error: { code: "target_confirmation_required", message: "confirm", targetOrigin: "https://example.com" } };
    });
    const withTrust = createStressStore({
      api,
      getContext: () => ({ root, locator: apiLocator }),
      trustOrigin: async (locator, origin) => { trusted.push(locator); expect(origin).toBe("https://example.com"); throw new Error("persist failed"); },
    });
    withTrust.form.caseId = "case";
    await withTrust.start(apiLocator);
    await expect(withTrust.confirmTarget(apiLocator, true)).rejects.toThrow("persist failed");
    expect(trusted).toEqual([projectLocator]);
    expect(calls).toHaveLength(1);
    expect(withTrust.confirmedTargetOrigins).toEqual([]);
    expect(withTrust.pendingTargetOrigin).toBeNull();
  });

  it("confirmation persistence in flight is invalidated by a root or API change", async () => {
    const calls: unknown[] = [];
    let release!: () => void;
    const persist = new Promise<void>((resolve) => { release = resolve; });
    const api = apiStub(async (input) => {
      calls.push(input);
      return calls.length === 1
        ? { ok: false, error: { code: "target_confirmation_required", message: "confirm", targetOrigin: "https://example.com" } }
        : { ok: true, report } as StressRunOutput;
    });
    const context = { root, locator: apiLocator as ApiLocator | null };
    const pending = createStressStore({ api, getContext: () => context, trustOrigin: async () => persist });
    pending.form.caseId = "case";
    await pending.start(apiLocator);
    const retry = pending.confirmTarget(apiLocator, true);
    context.root = "C:/different-root";
    release();
    await retry;
    expect(calls).toHaveLength(1);
    expect(pending.confirmedTargetOrigins).toEqual([]);
  });

  it("drops a late run report after clear and preserves a partial stop report for the active locator", async () => {
    let releaseFirst!: (value: StressRunOutput) => void;
    let releaseSecond!: (value: StressRunOutput) => void;
    const firstRun = new Promise<StressRunOutput>((resolve) => { releaseFirst = resolve; });
    const secondRun = new Promise<StressRunOutput>((resolve) => { releaseSecond = resolve; });
    let attempts = 0;
    const api = apiStub(() => (++attempts === 1 ? firstRun : secondRun), vi.fn(async () => ({ ok: true, report: { ...report, totalRequests: 4, ok: 2, failed: 1 } } as StressRunOutput)));
    const { stress } = setup(api);
    const running = stress.start(apiLocator);
    stress.clear();
    releaseFirst({ ok: true, report: { ...report, totalRequests: 99 } } as StressRunOutput);
    await running;
    expect(stress.report).toBeNull();

    const second = stress.start(apiLocator);
    await stress.stop(apiLocator);
    releaseSecond({ ok: true, report: { ...report, totalRequests: 99 } } as StressRunOutput);
    await second;
    expect(stress.report).toMatchObject({ totalRequests: 4, ok: 2, failed: 1 });
    expect(stress.running).toBe(false);
  });

  it("allows only one concurrent confirmation persistence and retry", async () => {
    const calls: unknown[] = [];
    let persistCalls = 0;
    let release!: () => void;
    const persist = new Promise<void>((resolve) => { release = resolve; });
    const api = apiStub(async (input) => {
      calls.push(input);
      return calls.length === 1
        ? { ok: false, error: { code: "target_confirmation_required", message: "confirm", targetOrigin: "https://example.com" } }
        : { ok: true, report } as StressRunOutput;
    });
    const stress = createStressStore({
      api,
      getContext: () => ({ root, locator: apiLocator }),
      trustOrigin: async () => { persistCalls += 1; await persist; },
    });
    stress.form.caseId = "case";
    await stress.start(apiLocator);
    const first = stress.confirmTarget(apiLocator, true);
    const second = stress.confirmTarget(apiLocator, true);
    release();
    await Promise.all([first, second]);
    expect(persistCalls).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ locator: apiLocator, confirmedTargetOrigins: ["https://example.com"] });
  });

  it("does not let an identical apiId from another full locator confirm or persist the target", async () => {
    const calls: unknown[] = [];
    const trustOrigin = vi.fn(async () => {});
    const api = apiStub(async (input) => {
      calls.push(input);
      return { ok: false, error: { code: "target_confirmation_required", message: "confirm", targetOrigin: "https://example.com" } };
    });
    const withTrust = createStressStore({ api, getContext: () => ({ root, locator: apiLocator }), trustOrigin });
    withTrust.form.caseId = "case";
    await withTrust.start(apiLocator);
    await withTrust.confirmTarget(otherApiLocator, true);
    expect(calls).toHaveLength(1);
    expect(trustOrigin).not.toHaveBeenCalled();
    expect(withTrust.pendingTargetOrigin).toBe("https://example.com");
  });
});

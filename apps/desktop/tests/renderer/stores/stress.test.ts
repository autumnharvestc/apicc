import { describe, expect, it, vi } from "vitest";
import { legacyStressRun } from "../../helpers/legacyStress.js";
import type { LegacyStressRunInput, StressRunError } from "../../../src/shared/types.js";
import { createStressStore } from "../../../src/renderer/src/stores/stress.js";
import type { ApiccApi, StressRunOutput } from "../../../src/shared/types.js";
import type { ApiLocator, ProjectLocator } from "../../../src/shared/locations.js";
import { contractAssetFixture } from "../helpers/contract-assets.js";
import { StressPlanSchema } from "@apicc/core/schema";
import { createStressRunInvoker, type StressProgressDTO, type StressRunResult } from "../../../src/shared/types.js";
import { stressV2Report } from "../../helpers/stressV2.js";

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

describe("project stress workbench", () => {
  it("keeps late save receipts with their draft and latest save request after new or opened plans", async () => {
    const f = await contractAssetFixture();
    const s = createStressStore({ api: f.api, getContext: () => ({ root: f.root, locator: null, projectLocator: f.projectLocator }) });
    await s.openWorkbench(f.projectLocator, { kind: 'workflow', workflowId: 'A' });
    const pending: Array<(value: import('@apicc/core').SavedStressPlan) => void> = [];
    f.api.stressPlansSave = async () => new Promise(resolve => { pending.push(resolve); });
    const saved = (id: string) => ({ formatVersion: 1 as const, id, name: id, updatedAt: 1, plan: StressPlanSchema.parse({ formatVersion: 1, target: { kind: 'workflow', workflowId: id }, load: { kind: 'constant-vus', vus: 1 }, termination: { maxIterations: 1 } }) });
    const savingA = s.savePlan();
    // Same replacement/ID reset as the workbench's New plan action, without changing project generation.
    s.plan = saved('B').plan; s.savedPlanId = null; s.planName = 'B';
    pending[0]!(saved('A')); await savingA;
    expect(s.savedPlanId).toBeNull(); expect(s.planName).toBe('B');
    const savingB = s.savePlan();
    f.api.stressPlansGet = async () => saved('opened');
    await s.openPlan('opened');
    pending[1]!(saved('B')); await savingB;
    expect(s.savedPlanId).toBe('opened'); expect(s.plan!.target).toEqual({ kind: 'workflow', workflowId: 'opened' });
    s.savedPlanId = null;
    const first = s.savePlan(), latest = s.savePlan();
    pending[3]!(saved('latest')); await latest; pending[2]!(saved('first')); await first;
    expect(s.savedPlanId).toBe('latest');
  });
  it("uses host-proven history instead of accepting same-ID other-group and unproved global records", async () => {
    const f = await contractAssetFixture();
    const row = (file: string) => ({ kind: 'stress' as const, file, projectId: f.projectLocator.projectId, startedAt: '2026-10-22', totalRequests: 1, ok: 1, failed: 0, rps: 1 });
    f.api.runsList = async () => ['current.json', 'other-group.json', 'unproved.json'].map(row);
    const report = stressV2Report(); report.projectId = f.projectLocator.projectId;
    f.api.runsGet = async () => ({ kind: 'stress', report });
    const api = Object.assign(f.api, {
      async stressRunsList(scope: ProjectLocator) { expect(scope).toEqual(f.projectLocator); return [row('current.json')]; },
      async stressRunsGet(scope: ProjectLocator, file: string) { expect(scope).toEqual(f.projectLocator); if (file !== 'current.json') throw new Error('归属未证明'); return { kind: 'stress' as const, report }; },
    });
    const s = createStressStore({ api, getContext: () => ({ root: f.root, locator: null, projectLocator: f.projectLocator }) });
    await s.openWorkbench(f.projectLocator, report.target); await s.loadStressHistory();
    expect(s.history.map(value => value.file)).toEqual(['current.json']);
    await s.openStressReport('current.json');
    await expect(s.openStressReport('other-group.json')).rejects.toThrow(/归属/);
    expect(s.planFile).toBe('current.json');
    expect((await api.runsList()).map(value => value.file)).toEqual(['current.json', 'other-group.json', 'unproved.json']);
  });
  it("keeps the latest plan selection and the captured running plan when plan reads return late", async () => {
    const f = await contractAssetFixture();
    const s = createStressStore({ api: f.api, getContext: () => ({ root: f.root, locator: null, projectLocator: f.projectLocator }) });
    await s.openWorkbench(f.projectLocator, { kind: 'workflow', workflowId: 'initial' });
    const reads: Array<(value: import('@apicc/core').SavedStressPlan) => void> = [];
    f.api.stressPlansGet = async () => new Promise(resolve => { reads.push(resolve); });
    const saved = (id: string) => ({ formatVersion: 1 as const, id, name: id, updatedAt: 1, plan: StressPlanSchema.parse({ formatVersion: 1, target: { kind: 'workflow', workflowId: id }, load: { kind: 'constant-vus', vus: 1 }, termination: { maxIterations: 1 } }) });
    const first = s.openPlan('first'), latest = s.openPlan('latest');
    reads[1]!(saved('latest')); await latest; reads[0]!(saved('first')); await first;
    expect(s.plan!.target).toEqual({ kind: 'workflow', workflowId: 'latest' });
    const lateRead = s.openPlan('late');
    let finish!: (value: StressRunResult) => void;
    f.api.stressRun = createStressRunInvoker(async () => new Promise(resolve => { finish = resolve; }));
    const running = s.startPlan();
    reads[2]!(saved('late')); await lateRead;
    expect(s.running).toBe(true); expect(s.planName).toBe('latest'); expect(s.savedPlanId).toBe('latest');
    expect(s.plan!.target).toEqual({ kind: 'workflow', workflowId: 'latest' });
    const report = stressV2Report(); report.projectId = f.projectLocator.projectId; report.target = saved('latest').plan.target; report.plan = saved('latest').plan;
    finish({ ok: true, kind: 'plan', runId: report.runId, report }); await running;
  });
  it("binds only matching invocation/target progress and holds stopping through cleanup, then fences ABA and project changes", async () => {
    const f = await contractAssetFixture();
    const context = { root: f.root, locator: null, projectLocator: f.projectLocator };
    const listeners = new Set<(value: StressProgressDTO) => void>();
    const pending: Array<{ input: import('../../../src/shared/types.js').StressPlanRunInput; finish: (out: StressRunResult) => void; promise: Promise<StressRunResult> }> = [];
    const stops: import('../../../src/shared/types.js').StressStopInput[] = [];
    f.api.onStressProgress = listener => { listeners.add(listener); return () => { listeners.delete(listener); }; };
    f.api.stressRun = createStressRunInvoker(async input => {
      if (!('kind' in input)) throw new Error('expected plan');
      let finish!: (out: StressRunResult) => void; const promise = new Promise<StressRunResult>(resolve => { finish = resolve; });
      pending.push({ input, finish, promise }); return promise;
    });
    f.api.stressStop = async input => { if (!input) throw new Error('stop must be scoped'); stops.push(input); const out = await pending.at(-1)!.promise; if (!out.ok) throw new Error(out.error.message); return out; };
    const s = createStressStore({ api: f.api, getContext: () => context });
    const target = { kind: 'workflow' as const, workflowId: 'workflow' };
    await s.openWorkbench(f.projectLocator, target);
    const first = s.startPlan();
    const event = (index: number, runId: string, state: StressProgressDTO['state'] = 'preparing'): StressProgressDTO => ({ invocationId: pending[index]!.input.invocationId, target, runId, sourceRoot: f.root, root: 'C:/canonical-workspace', projectLocator: f.projectLocator, generation: index + 1, state, phase: null, stageId: null, atMs: 0, activeVus: 0, startedIterations: 0, completedIterations: 0, droppedIterations: 0 });
    const send = (value: StressProgressDTO) => { for (const listener of listeners) listener(value); };
    const old = event(0, '10000000-0000-4000-8000-000000000001');
    send({ ...old, invocationId: undefined }); expect(s.progress).toBeNull();
    void s.stopPlan(); expect(s.planState).toBe('stopping'); expect(stops).toEqual([]);
    send(old); expect(stops).toEqual([{ runId: old.runId, root: 'C:/canonical-workspace', projectLocator: f.projectLocator }]);
    send({ ...old, state: 'finished' }); expect(s.running).toBe(true); expect(s.planState).toBe('stopping');
    const result = stressV2Report(); result.projectId = f.projectLocator.projectId;
    pending[0]!.finish({ ok: true, kind: 'plan', runId: old.runId, report: result }); await first;
    expect(s.running).toBe(false); expect(listeners.size).toBe(0);
    const second = s.startPlan(); send({ ...old, state: 'finished' }); expect(s.progress).toBeNull(); expect(s.running).toBe(true);
    const next = event(1, '10000000-0000-4000-8000-000000000002'); send({ ...next, target: { kind: 'workflow', workflowId: 'other' } }); expect(s.progress).toBeNull();
    send(next); expect(s.progress?.runId).toBe(next.runId);
    context.root = `${f.root}-other`; s.clear(); expect(s.running).toBe(true);
    const late = { ...result, runId: next.runId };
    pending[1]!.finish({ ok: true, kind: 'plan', runId: next.runId, report: late }); await second;
    expect(s.planReport).toBeNull(); expect(s.running).toBe(false); expect(listeners.size).toBe(0);
  });
  // Losing the persisted draft, or coupling workflow ownership to an open API, breaks reopen.
  it("saves and reopens a staged workflow plan without an open API", async () => {
    const f = await contractAssetFixture();
    const flow = await f.api.wfCreate({ locator: f.projectLocator, name: "scenario" });
    const context = { root: f.root, locator: null, projectLocator: f.projectLocator };
    const s = createStressStore({ api: f.api, getContext: () => context });
    const plan = StressPlanSchema.parse({ formatVersion: 1, target: { kind: "workflow", workflowId: flow.id }, maxVus: 3,
      load: { kind: "stages", executor: "vus", startTarget: 1, stages: [{ id: "rise", durationMs: 1000, target: 3 }, { id: "fall", durationMs: 2000, target: 1 }] } });
    await s.openWorkbench(f.projectLocator, plan.target);
    s.plan = plan; s.planName = "rise and fall";
    await s.savePlan();
    const reopened = createStressStore({ api: f.api, getContext: () => context });
    await reopened.openWorkbench(f.projectLocator, plan.target);
    expect(reopened.plans).toHaveLength(1);
    await reopened.openPlan(reopened.plans[0]!.id);
    expect(reopened.plan).toEqual(plan);
  });
});

function apiStub(stressRun: (input: LegacyStressRunInput) => Promise<StressRunOutput | StressRunError>, stressStop: ApiccApi["stressStop"] = vi.fn(async () => ({ ok: true, report } as StressRunOutput))): ApiccApi {
  return { stressRun: legacyStressRun(stressRun), stressStop } as unknown as ApiccApi;
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

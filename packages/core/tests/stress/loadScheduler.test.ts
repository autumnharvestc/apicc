import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runStressSchedule } from "../../src/stress/loadScheduler.js";
import { arrivalPolicyA } from "../../src/stress/arrivalPolicy.js";
import { createStressRequestGate } from "../../src/stress/requestGate.js";
import { createStressAccumulator } from "../../src/stress/metrics.js";
import { createExecutionEvidenceCollector } from "../../src/report/evidence.js";
import type { StressClock, StressExecutionDeps, StressIterationContext, StressProgress, StressVuSession } from "../../src/stress/execution.js";
import type { StressMetricPlan, StressSchedule } from "../../src/stress/plan.js";
import type { ExecutableRequest } from "../../src/plugin/types.js";
import { runStressPlan } from "../../src/stress/plannedRunner.js";
import { bindPreparedStressExecution, compileStressPlan } from "../../src/stress/execution.js";
import { StressPlanSchema } from "../../src/stress/plan.js";
import { ContractWorkspaceSchema } from "../../src/contract/workspace.js";
import { workspaceFixture } from "../helpers/contractFixtures.js";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import { prepareTestData } from "../../src/testing/data.js";

const metricPlan: StressMetricPlan = { stableNodeKeys: [], histogram: { minValueMs: .001, gamma: 1.01, bucketCount: 4608, exactLimit: 256 },
  timeline: { initialBucketWidthMs: 1000, maxBuckets: 120 }, node: { maxKeys: 512, otherKey: "other" }, error: { maxKeys: 128, otherKey: "other" },
  evidence: { maxSamples: 20, bodyBytes: 65536, valueBytes: 4096, caseBytes: 262144, reportBytes: 16777216 }, memory: { maxNumericBytes: 67108864 } };
const schedule = (extra: Partial<StressSchedule> = {}): StressSchedule => ({ load: { kind: "constant-arrival", rate: 20 }, durationMs: 1000, maxIterations: null,
  maxVus: 1, warmupMs: 0, thinkTimeMs: 0, pacingMs: 0, gracefulStopMs: 30000, metricPlan,
  requested: { maxRequestConcurrency: null, maxRps: null }, effective: { maxRequestConcurrency: 1, maxRps: null }, ...extra });
const clock: StressClock = { now: () => performance.now(), wallNow: () => Date.now(), sleep(ms, signal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
    const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
    signal?.addEventListener("abort", abort, { once: true });
  });
} };
const request: ExecutableRequest = { protocol: "http", method: "GET", url: "http://127.0.0.1/", headers: {}, query: [], auth: { kind: "none" } };
function deps(createVu: StressExecutionDeps["createVu"], signal = new AbortController().signal): StressExecutionDeps {
  return { runId: "run", createVu, clock, gate: createStressRequestGate({ clock, maxConcurrency: 1, authorizeRequest() {} }), signal,
    metrics: createStressAccumulator(metricPlan, "run"), evidence: createExecutionEvidenceCollector({ projectId: "p", definitionRevision: "r" }, []) };
}
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] }));
afterEach(() => vi.useRealTimers());

describe("unified load scheduling", () => {
  it("publishes bounded live counters through execution and real close without delaying completion", async () => {
    // Boundary-only notifications leave a live run at VU0/0; a detached heartbeat leaks after close.
    const events: StressProgress[] = []; let returned = false;
    const selected = deps(async () => ({
      async execute(ctx) { await clock.sleep(400, ctx.signal); return { state: "passed", durationMs: 400 }; },
      async close() { await clock.sleep(300); },
    }));
    const run = runStressSchedule(schedule({ load: { kind: "stages", executor: "vus", startTarget: 2,
      stages: [{ id: "first", durationMs: 500, target: 2 }, { id: "second", durationMs: 500, target: 2 }] }, maxVus: 2, durationMs: 1000 }), {
      ...selected, onProgress(value) { events.push(value); },
    }).then(result => { returned = true; return result; });
    await vi.advanceTimersByTimeAsync(250);
    expect(events.at(-1)).toMatchObject({ state: "running", phase: "measurement", stageId: "first", activeVus: 2, startedIterations: 2, completedIterations: 0, atMs: 250 });
    await vi.advanceTimersByTimeAsync(500);
    expect(events.at(-1)).toMatchObject({ stageId: "second", activeVus: 2, startedIterations: 4, completedIterations: 2, atMs: 750 });
    expect(events.filter(value => value.atMs > 0 && value.atMs < 1000).map(value => value.atMs)).toEqual([250, 500, 750]);
    await vi.advanceTimersByTimeAsync(500);
    expect(returned).toBe(false);
    expect(events.at(-1)).toMatchObject({ state: "stopping", phase: "vu-teardown", activeVus: 0, startedIterations: 6, completedIterations: 6, atMs: 1250 });
    expect(events.some(value => value.state === "finished")).toBe(false);
    await vi.advanceTimersByTimeAsync(550); const result = await run;
    expect(result.iterations).toMatchObject({ started: 6, completed: 6, dropped: 0 });
    expect(events.at(-1)).toMatchObject({ state: "finished", activeVus: 0, startedIterations: 6, completedIterations: 6, atMs: 1800 });
    expect(vi.getTimerCount()).toBe(0);
    const count = events.length; await vi.advanceTimersByTimeAsync(500); expect(events).toHaveLength(count);
  });
  it("carries worker clock uncertainty into the final numeric report", async () => {
    // Dropping the host's measured anchor uncertainty would publish a falsely aligned timeline.
    const selected = { ...deps(async () => ({ async execute() { return { state: "passed" as const, durationMs: 1 }; }, async close() {} })),
      timelineUncertaintyMs: () => 650 };
    const run = runStressSchedule(schedule({ load: { kind: "constant-vus", vus: 1 }, durationMs: null, maxIterations: 1 }), selected);
    await vi.advanceTimersByTimeAsync(0);
    const result = await run;
    expect(result.timeline).toMatchObject({ uncertaintyMs: 650, aligned: false });
    expect(result.completeness.metrics.reasons).toContain("timeline-unaligned");
  });
  it("passes run lifecycle observations and maps only explicit outputs into each owning VU", async () => {
    // Without a run lifecycle host, setup cannot report its real observations; copying all outputs leaks unrelated values.
    const calls: string[] = []; let initial: Readonly<Record<string, unknown>> | undefined; let effective: Readonly<Record<string, unknown>> | undefined;
    const selected = deps(async (_id, values, host) => {
      initial = values; expect(host!.lifecycle!.vuSetup!.inputs).toEqual({ only: "vu" });
      await clock.sleep(9);
      effective = host!.reportLifecycle("vuSetup", { state: "passed", durationMs: 3, outputs: { mapped: "vu", unused: "private-vu-output" } });
      return { async execute() { await clock.sleep(1); return { state: "passed", durationMs: 1 }; }, async close() { host!.reportLifecycle("vuTeardown", { state: "passed", durationMs: 4, outputs: {} }); } };
    });
    const run = runStressSchedule(schedule({ load: { kind: "constant-vus", vus: 1 }, durationMs: null, maxIterations: 1 }), { ...selected,
      execution: { targetInputs: { base: "target" }, lifecycle: { setup: { workflowId: "setup", inputs: { only: "setup" }, outputs: { mapped: "shared" } }, vuSetup: { workflowId: "vu", inputs: { only: "vu" }, outputs: { mapped: "shared" } }, vuTeardown: { workflowId: "vu-end" }, teardown: { workflowId: "end", inputs: { only: "end" } } } },
      async runLifecycle(role, values, _signal, host) {
        calls.push(role); expect(values).toEqual({ only: role === "setup" ? "setup" : "end" });
        host!.observe({ kind: "http", ...host!.observation(), stageId: null, started: 1, completed: 1, nodeKey: null });
        return { state: "passed", durationMs: role === "setup" ? 7 : 5, outputs: { mapped: "setup", unused: "private-run-output" } };
      },
    });
    await vi.advanceTimersByTimeAsync(20); const result = await run;
    expect(initial).toEqual({ base: "target", shared: "setup" }); expect(effective).toEqual({ base: "target", shared: "vu" });
    expect(calls).toEqual(["setup", "teardown"]);
    expect(result.lifecycle.map((step) => [step.role, step.vuId, step.durationMs])).toEqual([["setup", null, 7], ["vuSetup", "1", 3], ["vuTeardown", "1", 4], ["teardown", null, 5]]);
    expect(JSON.stringify(result)).not.toContain("private-");
    expect(result.phases.filter((p) => p.phase === "setup" || p.phase === "teardown").map((p) => p.httpExchanges.started)).toEqual([1, 1]);
  });
  it("stops on numeric side-channel failure without fabricating a failed business iteration", async () => {
    // Throwing a StressMetricsError back into the case callback would turn instrumentation loss into an assertion failure.
    let executions = 0, closes = 0;
    const run = runStressSchedule(schedule({ load: { kind: "constant-vus", vus: 1 }, durationMs: null, maxIterations: 10 }), deps(async () => ({ async execute(ctx) {
      executions++; ctx.observe!({ kind: "node", ...ctx.observation!(), stageId: null, nodeKey: "other", state: "passed", durationMs: Infinity });
      return { state: "passed", durationMs: 1 };
    }, async close() { closes++; } })));
    await vi.advanceTimersByTimeAsync(0); const result = await run;
    expect(executions).toBe(1); expect(closes).toBe(1); expect(result.iterations.failed).toBe(0);
    expect(result.completeness.metrics.reasons).toContain("snapshot-invalid");
    expect(result.verdict.passed).toBe(false);
  });
  it("takes initial inputs and thresholds from the bound plan rather than conflicting host configuration", async () => {
    // Forwarding deps.execution unchanged would inject values outside the compiled plan.
    const project = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
    const collection = project.collections[0]!, api = collection.apis[0]!;
    api.cases = [{ id: "case", name: "case", scope: "base", parameters: {}, preOperations: [], postOperations: [], assertions: [] }];
    const snapshot = createProjectSnapshot(project);
    const compiled = compileStressPlan(snapshot, StressPlanSchema.parse({ formatVersion: 1, target: { kind: "case", collectionId: collection.id, apiId: api.contract.id, caseId: "case" }, load: { kind: "constant-vus", vus: 1 }, termination: { maxIterations: 1 } }));
    const preparedTestData = await prepareTestData(snapshot, compiled.targets.flatMap((t) => [...t.dataSelections]), { workspaceRoot: process.cwd() });
    const prepared = bindPreparedStressExecution(compiled, { snapshot, credentialBindings: { versions: {}, resolve() { throw new Error("unused"); } }, preparedTestData });
    let initial: Readonly<Record<string, unknown>> | undefined;
    const selected = deps(async (_id, values) => { initial = values; return { async execute() { await clock.sleep(1); return { state: "passed", durationMs: 1 }; }, async close() {} }; });
    const resultPromise = runStressPlan(prepared, { ...selected, execution: { targetInputs: { injected: "outside-plan" }, thresholds: { minRps: 9999 } } });
    await vi.advanceTimersByTimeAsync(10); const result = await resultPromise;
    expect(initial).toEqual({});
    expect(result).toMatchObject({ formatVersion: 2, projectId: project.id, definitionRevision: snapshot.definitionRevision, iterations: { started: 1, completed: 1 } });
    expect(result.thresholds).toBeUndefined();
  });
  it("starts twenty half-step arrival slots in a second without retaining a queue", async () => {
    // Starting at n/rate instead of (n+.5)/rate is an observable off-by-half-slot bug.
    const starts: number[] = [];
    const run = runStressSchedule(schedule(), deps(async () => ({ async execute() { starts.push(clock.now()); return { state: "passed", durationMs: 0 }; }, async close() {} })));
    await vi.advanceTimersByTimeAsync(1000);
    const result = await run;
    expect(starts).toEqual([25,75,125,175,225,275,325,375,425,475,525,575,625,675,725,775,825,875,925,975]);
    expect(result.iterations).toMatchObject({ planned: 20, started: 20, completed: 20, dropped: 0 });
    expect(result.load.measurementDurationMs).toBe(1000);
  });
  it("admits a still-current arrival slot after a small wake delay and retains the actual start delay", async () => {
    // A's 125ms slot is valid until375ms; the old elapsed-1 expiry incorrectly drops it at130ms.
    const starts: number[] = [];
    const selected = deps(async () => ({ async execute() { starts.push(clock.now()); return { state: "passed", durationMs: 0 }; }, async close() {} }));
    const run = runStressSchedule(schedule({ load: { kind: "constant-arrival", rate: 4 } }), {
      ...selected, clock: { ...clock, sleep: (ms, signal) => clock.sleep(ms + 5, signal) },
    });
    await vi.advanceTimersByTimeAsync(124); expect(starts).toEqual([]);
    await vi.advanceTimersByTimeAsync(6); expect.soft(starts).toEqual([130]);
    await vi.advanceTimersByTimeAsync(1000); const result = await run;
    expect.soft(starts).toEqual([130, 380, 630, 880]);
    expect.soft(result.iterations).toMatchObject({ planned: 4, started: 4, completed: 4, dropped: 0,
      startDelay: { availability: "available", value: { min: 5, max: 5 } } });
  });
  it("consumes only the latest current arrival slot after a multi-slot wake delay without retrying it", async () => {
    const starts: { actual: number; scheduled: number }[] = [];
    const selected = deps(async () => ({ async execute(ctx) { starts.push({ actual: clock.now(), scheduled: ctx.scheduledOffsetMs }); return { state: "passed", durationMs: 0 }; }, async close() {} }));
    const run = runStressSchedule(schedule({ load: { kind: "constant-arrival", rate: 4 }, maxVus: 2 }), {
      ...selected, clock: { ...clock, sleep: (ms, signal) => clock.sleep(Math.max(ms, 900 - clock.now()), signal) },
    });
    await vi.advanceTimersByTimeAsync(1000); const result = await run;
    expect(starts).toEqual([{ actual: 900, scheduled: 875 }]);
    expect(result.iterations).toMatchObject({ planned: 4, started: 1, completed: 1, dropped: 3 });
    expect(result.completeness.load.reasons).toEqual(["dropped"]);
  });
  it("expires old stages by ownership and handles exact stage, zero-rate and final-window boundaries", async () => {
    const starts: { at: number; stage: string | null }[] = [], drops: { stage: string | null; count: number }[] = [];
    let sleeps = 0;
    const selected = deps(async () => ({ async execute(ctx) { starts.push({ at: clock.now(), stage: ctx.stageId }); return { state: "passed", durationMs: 0 }; }, async close() {} }));
    const run = runStressSchedule(schedule({ load: { kind: "stages", executor: "arrival", startTarget: 4, stages: [
      { id: "first", durationMs: 250, target: 4 }, { id: "second", durationMs: 250, target: 4 },
      { id: "fall", durationMs: 250, target: 0 }, { id: "zero", durationMs: 250, target: 0 },
    ] } }), {
      ...selected, arrivalPolicy: arrivalPolicyA,
      clock: { ...clock, sleep(ms, signal) { sleeps++; return clock.sleep(Math.max(ms, 500 - clock.now()), signal); } },
      metrics: { ...selected.metrics, observe(event) { if (event.kind === "iteration" && event.dropped) drops.push({ stage: event.stageId, count: event.dropped }); selected.metrics.observe(event); } },
    });
    await vi.advanceTimersByTimeAsync(1000); const result = await run;
    // At500ms both old-stage slots have expired. The next exact due at750 belongs to the new stage,
    // even though the integral then stays flat; it must not be lost or replayed on that plateau.
    expect(drops).toEqual([{ stage: "first", count: 1 }, { stage: "second", count: 1 }]);
    expect(starts).toEqual([{ at: 750, stage: "zero" }]); expect(sleeps).toBeLessThan(10);
    expect(result.iterations).toMatchObject({ planned: 3, started: 1, completed: 1, dropped: 2 });
    expect(arrivalPolicyA({ parts: [{ id: null, start: 0, end: 1000, from: .5, to: .5, area: 0 }], elapsedMs: 1000, durationMs: 1000, cursor: 0, budget: Infinity }))
      .toMatchObject({ cursor: 0, current: null, dropped: [] }); // A due exactly at the final boundary is not planned.
  });
  it("owns a decimal arrival half-step at the exact new-stage boundary", async () => {
    // Integral(.8 -> .2, 1000ms)=.5: a rounded inverse below1000 must not expire this hold slot.
    const starts: { at: number; scheduled: number; stage: string | null }[] = [];
    const run = runStressSchedule(schedule({ load: { kind: "stages", executor: "arrival", startTarget: .8, stages: [
      { id: "fall", durationMs: 1000, target: .2 }, { id: "hold", durationMs: 1000, target: .2 },
    ] }, durationMs: 2000 }), deps(async () => ({ async execute(ctx) {
      starts.push({ at: clock.now(), scheduled: ctx.scheduledOffsetMs, stage: ctx.stageId }); return { state: "passed", durationMs: 0 };
    }, async close() {} })));
    await vi.advanceTimersByTimeAsync(999); expect(starts).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect.soft(starts).toEqual([{ at: 1000, scheduled: 1000, stage: "hold" }]);
    await vi.advanceTimersByTimeAsync(1000); const result = await run;
    expect.soft(result.iterations).toMatchObject({ planned: 1, started: 1, completed: 1, dropped: 0 });
    expect.soft(result.completeness.load.reasons).not.toContain("dropped");
  });
  it("excludes a decimal arrival half-step exactly at the final window end", async () => {
    // The same .5 integral at the final1000ms is outside the pressure window, not a dropped slot.
    const starts: number[] = [];
    const run = runStressSchedule(schedule({ load: { kind: "stages", executor: "arrival", startTarget: .8,
      stages: [{ id: "fall", durationMs: 1000, target: .2 }] } }), deps(async () => ({
      async execute() { starts.push(clock.now()); return { state: "passed", durationMs: 0 }; }, async close() {},
    })));
    await vi.advanceTimersByTimeAsync(1000); const result = await run;
    expect(starts).toEqual([]);
    expect.soft(result.iterations).toMatchObject({ planned: 0, started: 0, completed: 0, dropped: 0 });
    expect.soft(result.completeness.load.reasons).not.toContain("dropped");
  });
  it("drops occupied slots and does not reenter or catch up on the busy VU", async () => {
    const starts: number[] = [];
    const run = runStressSchedule(schedule(), deps(async () => ({ async execute(ctx) { starts.push(clock.now()); await clock.sleep(180, ctx.signal); return { state: "passed", durationMs: 180 }; }, async close() {} })));
    await vi.advanceTimersByTimeAsync(1200);
    const result = await run;
    expect(starts).toEqual([25,225,425,625,825]);
    expect(result.iterations).toMatchObject({ planned: 20, started: 5, completed: 5, dropped: 15 });
    expect(result.completeness.load.reasons).toContain("dropped");
  });
  it("inverts linear rise and fall integrals while preserving the global iteration budget", async () => {
    const started: { time: number; stage: string | null }[] = [];
    const run = runStressSchedule(schedule({ load: { kind: "stages", executor: "arrival", startTarget: 0, stages: [{ id: "up", durationMs: 1000, target: 4 }, { id: "down", durationMs: 1000, target: 0 }] }, durationMs: 2000, maxIterations: 3 }),
      deps(async () => ({ async execute(ctx) { started.push({ time: clock.now(), stage: ctx.stageId }); return { state: "passed", durationMs: 0 }; }, async close() {} })));
    await vi.advanceTimersByTimeAsync(2000);
    const result = await run;
    expect(started.map((v) => v.stage)).toEqual(["up", "up", "down"]);
    // Integral roots 500,866.025...,1133.974... are admitted in A's bounded current-slot window.
    expect(started.map((v) => v.time)).toEqual([500,867,1134]);
    expect(result.iterations).toMatchObject({ planned: 3, started: 3, completed: 3 });
  });
  it("uses max(think, pacing-duration) and keeps warmup outside the formal budget", async () => {
    const starts: { time: number; phase: string }[] = [];
    const run = runStressSchedule(schedule({ load: { kind: "constant-vus", vus: 1 }, durationMs: null, maxIterations: 2, warmupMs: 80, thinkTimeMs: 30, pacingMs: 100 }),
      deps(async () => ({ async execute(ctx) { starts.push({ time: clock.now(), phase: ctx.phase }); await clock.sleep(80, ctx.signal); return { state: "passed", durationMs: 80 }; }, async close() {} })));
    await vi.advanceTimersByTimeAsync(1000);
    const result = await run;
    // Warmup ends at80; max(think30,pacing100-execution80)=30 also applies across the boundary.
    expect(starts).toEqual([{ time: 0, phase: "warmup" }, { time: 110, phase: "measurement" }, { time: 220, phase: "measurement" }]);
    expect(result.iterations).toMatchObject({ planned: 2, started: 2, completed: 2 });
    expect(result.phases.find((p) => p.phase === "measurement")?.startOffsetMs).toBe(80);
  });
  it("keeps the source stage and observes drain at completion while a down-ramp is in flight", async () => {
    let observed: { phase: string; stage: string | null; atMs: number } | undefined;
    let closed = false;
    const run = runStressSchedule(schedule({ load: { kind: "stages", executor: "vus", startTarget: 1, stages: [{ id: "fall", durationMs: 100, target: 0 }] }, durationMs: 100 }),
      deps(async () => ({ async execute(ctx) { await clock.sleep(150, ctx.signal); observed = { ...ctx.observation!(), stage: ctx.stageId }; return { state: "passed", durationMs: 150 }; }, async close() { closed = true; } })));
    await vi.advanceTimersByTimeAsync(100);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    const result = await run;
    expect(observed).toEqual({ phase: "drain", stage: "fall", atMs: 150 });
    expect(result.load).toMatchObject({ measurementDurationMs: 100, drainDurationMs: 50 });
  });
  it("aborts a timed-out drain, closes every VU and records incomplete execution", async () => {
    let closed = 0;
    const run = runStressSchedule(schedule({ load: { kind: "constant-vus", vus: 1 }, durationMs: 100, gracefulStopMs: 20 }),
      deps(async () => ({ async execute(ctx) { try { await clock.sleep(1000, ctx.signal); return { state: "passed", durationMs: 1000 }; } catch { return { state: "aborted", durationMs: 120 }; } }, async close(options) { expect(options.allowNetworkCleanup).toBe(false); closed++; } })));
    await vi.advanceTimersByTimeAsync(120);
    const result = await run;
    expect(result.iterations).toMatchObject({ started: 1, aborted: 1 });
    expect(result.completeness.execution.reasons).toContain("drain-timeout");
    expect(closed).toBe(1);
  });
  it("stops on cancellation, waits for real close and ignores wall-clock jumps", async () => {
    const controller = new AbortController(); const starts: number[] = []; let closeDone = false; let returned = false;
    const selected = deps(async () => ({ async execute(ctx) { starts.push(clock.now()); try { await clock.sleep(100, ctx.signal); } catch {} return { state: ctx.signal.aborted ? "aborted" : "passed", durationMs: clock.now() - starts.at(-1)! }; },
      async close(options) { expect(options.allowNetworkCleanup).toBe(false); await clock.sleep(50); closeDone = true; } }), controller.signal);
    const run = runStressSchedule(schedule({ load: { kind: "constant-vus", vus: 1 } }), selected).then((result) => { returned = true; return result; });
    await vi.advanceTimersByTimeAsync(30); vi.setSystemTime(Date.now() + 86400000); controller.abort();
    await vi.advanceTimersByTimeAsync(0); expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(50); const result = await run;
    expect(starts).toEqual([0]); expect(closeDone).toBe(true);
    expect(result.load.measurementDurationMs).toBe(30);
    expect(result.completeness.execution.reasons).toContain("cancelled");
  });
  it("F6 fix I-2 truncates a cancelled drain at the accepted stop while awaiting execution and close", async () => {
    // Returning launchEnd=100 or retaining the real drain end=200 would both misstate the stop at150.
    const controller = new AbortController(), wallStart = Date.now();
    let returned = false, closing = false, executions = 0;
    const finished: number[] = [];
    const selected = deps(async () => ({ async execute(ctx) {
      executions++;
      await clock.sleep(200); // Intentionally cooperative only at return: real completion still matters.
      expect(ctx.signal.aborted).toBe(true);
      return { state: "aborted", durationMs: 200 };
    }, async close(options) {
      closing = true; expect(options.allowNetworkCleanup).toBe(false); await clock.sleep(50);
    } }), controller.signal);
    const run = runStressSchedule(schedule({ load: { kind: "constant-vus", vus: 1 }, durationMs: 100 }), {
      ...selected, onProgress(progress) { if (progress.state === "finished") finished.push(progress.atMs); },
    }).then((result) => { returned = true; return result; });
    await vi.advanceTimersByTimeAsync(150); controller.abort();
    await vi.advanceTimersByTimeAsync(49); expect(returned).toBe(false); expect(closing).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(closing).toBe(true); expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(49); expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(1); const result = await run;
    expect(executions).toBe(1); expect(finished).toEqual([250]);
    expect(result).toMatchObject({ durationMs: 150, startedAt: wallStart, finishedAt: wallStart + 150 });
    expect(result.load).toMatchObject({ measurementDurationMs: 100, drainDurationMs: 50 });
    expect(result.phases.filter((p) => p.phase === "measurement" || p.phase === "drain").map((p) => [p.phase, p.startOffsetMs, p.endOffsetMs, p.durationMs]))
      .toEqual([["measurement", 0, 100, 100], ["drain", 100, 150, 50]]);
    expect(result.completeness.execution.reasons).toContain("cancelled");
  });
});

describe("actual request gate", () => {
  it("holds one protocol permit across redirects, spaces hop rate and releases idempotently", async () => {
    const gate = createStressRequestGate({ maxConcurrency: 1, maxRps: 2, clock, authorizeRequest() {} });
    const signal = new AbortController().signal; const release = await gate.enter(request, signal);
    let secondEntered = false;
    const second = gate.enter(request, signal).then((done) => { secondEntered = true; return done; });
    await gate.beforeRedirect(request, signal); // The second hop fits the same sliding window.
    expect(secondEntered).toBe(false);
    release(); release();
    await vi.advanceTimersByTimeAsync(999); expect(secondEntered).toBe(false);
    await vi.advanceTimersByTimeAsync(1); (await second)(); expect(secondEntered).toBe(true);
  });
  it("removes aborted waiters without consuming the next concurrency or rate permit", async () => {
    const gate = createStressRequestGate({ maxConcurrency: 1, clock, authorizeRequest() {} });
    const controller = new AbortController(); const release = await gate.enter(request, new AbortController().signal);
    const waiting = gate.enter(request, controller.signal).then(() => "entered", () => "aborted");
    controller.abort(); expect(await waiting).toBe("aborted"); release();
    const next = await gate.enter(request, new AbortController().signal); next();
  });
});

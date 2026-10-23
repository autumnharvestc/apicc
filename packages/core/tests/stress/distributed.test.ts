import { describe, expect, it } from "vitest";
import { computeReport } from "../../src/stress/aggregate.js";
import {
  DistributedStressCoordinator,
  planShards,
  ShardResultSchema,
  StressWorkerSpecSchema,
} from "../../src/stress/distributed.js";
import type {
  ShardFailure,
  ShardOutcome,
  ShardResult,
  StressWorkerSpec,
} from "../../src/stress/distributed.js";
import { CurrentStressReportSchema, StressGeneratorSchema, StressMeasurementWindowSchema, StressReportSchema, StressSampleSchema } from "../../src/stress/model.js";
import type { StressSample } from "../../src/stress/model.js";
import { StressRunner } from "../../src/stress/runner.js";
import type { CaseExecutionResult } from "../../src/runner/caseExecutor.js";
import { createExecutionEvidenceCollector, redactExecutionOutput } from "../../src/report/evidence.js";
import { createCredentialOutputSanitizer } from "../../src/credentials/output.js";
import { createLocalStressWorkerDeps } from "../../src/stress/distributed.js";
import { serveLocalStressWorker } from "../../src/stress/localWorker.js";
import { createStressWorkerPeer, mergeStressWorkerMarkers, type StressWorkerChannel } from "../../src/stress/workerProtocol.js";
import { runStressSchedule } from "../../src/stress/loadScheduler.js";
import { createStressAccumulator } from "../../src/stress/metrics.js";
import { createStressRequestGate } from "../../src/stress/requestGate.js";
import { legacyStressMetricPlan } from "../../src/stress/runner.js";
import type { StressClock, StressIterationContext } from "../../src/stress/execution.js";

function privateChannels(): [StressWorkerChannel, StressWorkerChannel] {
  const listeners = [new Set<(value: unknown) => void>(), new Set<(value: unknown) => void>()];
  const closes = [new Set<() => void>(), new Set<() => void>()];
  const exits: ((value: { code: number | null; signal: string | null }) => void)[] = [];
  const exited = [0, 1].map((i) => new Promise<{ code: number | null; signal: string | null }>((resolve) => { exits[i] = resolve; }));
  const make = (index: number): StressWorkerChannel => ({
    send(value: unknown) { const copy = structuredClone(value); queueMicrotask(() => listeners[1 - index]!.forEach((listener) => listener(copy))); },
    subscribe(listener: (value: unknown) => void) { listeners[index]!.add(listener); return () => listeners[index]!.delete(listener); },
    onClose(listener: () => void) { closes[index]!.add(listener); return () => closes[index]!.delete(listener); },
    waitForExit() { return exited[index]!; },
    async finish() { exits[1 - index]!({ code: 0, signal: null }); closes[1 - index]!.forEach((listener) => listener()); },
    async close() { exits[1 - index]!({ code: 1, signal: null }); closes[1 - index]!.forEach((listener) => listener()); },
  });
  return [make(0), make(1)];
}

describe("v3 remote VU coordinator", () => {
  async function phaseAtDiagnostic(nominal: number, boundary: number, measurementBegins = false) {
    // Real v3 peers/worker/phase-at/snapshot merge; the injected host has one known phase boundary.
    // Anchor send0/receive2/worker100 gives delta=-99 and uncertainty1ms, without sleeps or I/O.
    let reads = 0, workerNow = 100, current = 998;
    const clock: StressClock = { now: () => ++reads === 1 ? 0 : reads === 2 ? 2 : current, wallNow: () => 0,
      async sleep() { throw new Error("No clock wait expected in this finite diagnostic"); } };
    const workerClock: StressClock = { ...clock, now: () => workerNow };
    const metricPlan = legacyStressMetricPlan, runId = `phase-at-${boundary}`;
    const schedule = { load: { kind: "constant-vus" as const, vus: 1 }, durationMs: 1100, maxIterations: 1, maxVus: 1,
      warmupMs: 0, thinkTimeMs: 0, pacingMs: 0, gracefulStopMs: 30000, metricPlan,
      requested: { maxRequestConcurrency: 1, maxRps: null }, effective: { maxRequestConcurrency: 1, maxRps: null } };
    const accumulator = createStressAccumulator(metricPlan, runId);
    const responses: { atMs: number; value: unknown }[] = [];
    const snapshots: { sourceId: string; scope: string; sequence: number; reasons: readonly string[] }[] = [];
    const local = await createLocalStressWorkerDeps(schedule, { runId, clock, shards: 1, configuration: {}, signal: new AbortController().signal,
      evidence: createExecutionEvidenceCollector({ projectId: "p", definitionRevision: "r" }, [], { privateMarkers: true }),
      metrics: { ...accumulator, merge(snapshot) {
        snapshots.push({ sourceId: snapshot.sourceId, scope: snapshot.scope, sequence: snapshot.sequence, reasons: snapshot.incompleteReasons });
        accumulator.merge(snapshot);
      } }, gate: createStressRequestGate({ clock, maxConcurrency: 1, authorizeRequest() {} }),
      createVu: async () => { throw new Error("Remote only"); },
      async spawnWorker(identity) {
        const channels = privateChannels();
        const worker = serveLocalStressWorker(channels[1], identity, async () => ({ clock: workerClock, metricPlan,
          evidence: createExecutionEvidenceCollector({ projectId: "p", definitionRevision: "r" }, [], { privateMarkers: true }), host: {
            async createVu(_id, _inputs, host) { return { async execute(context) {
              current = 1000;
              workerNow = nominal + 99;
              host!.observe({ kind: "case", ...context.observation!(), vuId: context.vuId, iterationId: context.iterationId, stageId: context.stageId,
                ok: true, status: 200, requestStarted: true, requestCompleted: true, failureKind: null,
                requestTimeMs: 1, scriptTimeMs: 0, iterationTimeMs: 1,
                locator: { collectionId: "c", folderIds: [], apiId: "a", caseId: "x", scope: "base" }, nodeKey: null });
              return { state: "passed", durationMs: 1 };
            }, async close() {} }; },
          } }));
        const request = worker.request.bind(worker);
        worker.request = async command => {
          const value = await request(command);
          if (command.type === "phase-at") responses.push({ atMs: command.atMs, value });
          return value;
        };
        return channels[0];
      },
    });
    const phaseAt = (atMs: number) => ({ atMs, phase: measurementBegins
      ? atMs < boundary ? "vu-setup" as const : "measurement" as const
      : atMs < boundary ? "measurement" as const : "drain" as const });
    try {
      const vu = await local.deps.createVu("1", {}, { runId, vuId: "1", signal: local.deps.signal, clock,
        gate: local.deps.gate, observation: () => phaseAt(current), observationAt(atMs) {
          if (atMs < 0 || atMs > current) throw new Error("Host cannot resolve an unobserved time");
          return phaseAt(atMs);
        }, observe: accumulator.observe, lifecycle: undefined, reportLifecycle() { return {}; } });
      if (measurementBegins) current = 1000;
      const result = await vu.execute({ runId, vuId: "1", iterationId: "1", stageId: null, phase: "measurement", scheduledOffsetMs: 0, signal: local.deps.signal });
      expect(result).toEqual({ state: "passed", durationMs: 1 });
      accumulator.observe({ kind: "iteration", phase: "measurement", stageId: null, atMs: 1000,
        started: 1, passed: 1, failed: 0, aborted: 0, dropped: 0, durationMs: 1, startDelayMs: 0 });
      await vu.close({ reason: "duration", signal: local.deps.signal, allowNetworkCleanup: false });
      await local.deps.closeRun!();
      const summary = local.deps.metrics.finish({ startedAt: measurementBegins ? boundary : 0, finishedAt: 1100, measurementStartOffsetMs: measurementBegins ? boundary : 0, measurementEndOffsetMs: 1100,
        stopReason: "duration", plannedIterations: 1, lifecycle: [],
        load: { plannedDurationMs: 1100, measurementDurationMs: measurementBegins ? 1100 - boundary : Math.min(boundary, 1100), drainDurationMs: measurementBegins ? 0 : Math.max(0, 1100 - boundary),
          policyLimitedMs: 0, saturated: false, maxVus: 1, maxRequestConcurrency: 1 },
        completeness: { execution: { complete: true, reasons: [] }, metrics: { complete: true, reasons: [] }, load: { complete: true, reasons: [] } },
        phaseWindows: measurementBegins
          ? [{ phase: "vu-setup", stageId: null, startOffsetMs: 0, endOffsetMs: boundary }, { phase: "measurement", stageId: null, startOffsetMs: boundary, endOffsetMs: 1100 }]
          : [{ phase: "measurement", stageId: null, startOffsetMs: 0, endOffsetMs: Math.min(boundary, 1100) },
            ...(boundary < 1100 ? [{ phase: "drain" as const, stageId: null, startOffsetMs: boundary, endOffsetMs: 1100 }] : [])] });
      return { nominal, current: 1000, uncertainty: local.deps.timelineUncertaintyMs!(), boundary, responses, snapshots,
        requests: summary.requests, phases: summary.phases.map(p => ({ phase: p.phase, requests: p.requests })),
        completeness: summary.completeness, timeline: { aligned: summary.timeline.aligned, uncertaintyMs: summary.timeline.uncertaintyMs }, verdict: summary.verdict };
    } finally { await local.close(); }
  }
  it("phase-at intersects clock uncertainty with the causal execute dispatch boundary", async () => {
    // Measurement begins999.75; execute is sent1000; the worker event nominal999.5 ±1
    // cannot predate that command, even though its clock-only interval includes VU setup.
    const actual = await phaseAtDiagnostic(999.5, 999.75, true);
    expect(actual.uncertainty).toBe(1);
    expect.soft(actual.responses).toEqual([{ atMs: 999.5, value: { phase: "measurement", atMs: 1000, uncertain: false } }]);
    expect.soft(actual.snapshots).toEqual([{ sourceId: "worker-1", scope: "observations", sequence: 1, reasons: [] }]);
    expect.soft(actual.completeness.metrics).toEqual({ complete: true, reasons: [] });
    expect.soft(actual.timeline).toEqual({ aligned: true, uncertaintyMs: 1 });
    expect.soft(actual.verdict.status).toBe("passed");
    expect(actual.requests).toEqual({ started: 1, completed: 1, eligibleCompleted: 1, failed: 0 });
  });
  it("phase-at diagnosis accepts bounded nominal future within one observed phase", async () => {
    // A 0.5ms nominal lead inside known1ms mapping uncertainty is not by itself a lost phase.
    const actual = await phaseAtDiagnostic(1000.5, 2000);
    expect(actual.uncertainty).toBe(1);
    expect.soft(actual.responses).toEqual([{ atMs: 1000.5, value: { phase: "measurement", atMs: 1000, uncertain: false } }]);
    expect.soft(actual.snapshots).toEqual([{ sourceId: "worker-1", scope: "observations", sequence: 1, reasons: [] }]);
    expect.soft(actual.completeness.metrics).toEqual({ complete: true, reasons: [] });
    expect.soft(actual.timeline).toEqual({ aligned: true, uncertaintyMs: 1 });
    expect.soft(actual.verdict.status).toBe("passed");
    expect(actual.requests).toEqual({ started: 1, completed: 1, eligibleCompleted: 1, failed: 0 });
    // Clamp-first [999,1000] crosses999.25; the actual feasible [999.5,1000] is entirely drain.
    // Merely deleting the independent future predicate must not leave this false positive behind.
    const near = await phaseAtDiagnostic(1000.5, 999.25);
    expect.soft(near.responses).toEqual([{ atMs: 1000.5, value: { phase: "drain", atMs: 1000, uncertain: false } }]);
    expect.soft(near.snapshots).toEqual([{ sourceId: "worker-1", scope: "observations", sequence: 1, reasons: [] }]);
    expect.soft(near.completeness).toEqual({ execution: { complete: true, reasons: [] }, metrics: { complete: true, reasons: [] }, load: { complete: true, reasons: [] } });
    expect.soft(near.timeline).toEqual({ aligned: true, uncertaintyMs: 1 }); expect.soft(near.verdict.status).toBe("passed");
    expect(near.requests).toEqual({ started: 1, completed: 1, eligibleCompleted: 1, failed: 0 });
  });
  it("phase-at diagnosis preserves uncertainty across an actual phase boundary", async () => {
    // Nominal999.5 is not future; its ±1ms interval crosses the known1000ms measurement/drain edge.
    const actual = await phaseAtDiagnostic(999.5, 1000);
    expect(actual.uncertainty).toBe(1);
    expect(actual.responses).toEqual([{ atMs: 999.5, value: { phase: "measurement", atMs: 999.5, uncertain: true } }]);
    expect(actual.snapshots).toEqual([{ sourceId: "worker-1", scope: "observations", sequence: 1, reasons: ["timeline-unaligned"] }]);
    expect(actual.requests).toEqual({ started: 1, completed: 1, eligibleCompleted: 1, failed: 0 });
    expect(actual.completeness).toEqual({ execution: { complete: true, reasons: [] }, metrics: { complete: false, reasons: ["timeline-unaligned"] }, load: { complete: true, reasons: [] } });
    expect(actual.timeline).toEqual({ aligned: false, uncertaintyMs: 1 }); expect(actual.verdict.status).toBe("incomplete");
  });
  it.each(["duplicate-final", "missing-snapshot", "exit-with-lease"])("withholds rich output and conserves leases for %s", async (fault) => {
    const clock: StressClock = { now: () => performance.now(), wallNow: () => Date.now(), sleep: async () => {} }, metricPlan = legacyStressMetricPlan;
    const schedule = { load: { kind: "constant-vus" as const, vus: 1 }, durationMs: null, maxIterations: 1, maxVus: 1, warmupMs: 0, thinkTimeMs: 0, pacingMs: 0, gracefulStopMs: 30000, metricPlan,
      requested: { maxRequestConcurrency: 1, maxRps: null }, effective: { maxRequestConcurrency: 1, maxRps: null } };
    const gate = createStressRequestGate({ clock, maxConcurrency: 1, authorizeRequest() {} }); let leases = 0, acquired = 0, rootClosed = false;
    const local = await createLocalStressWorkerDeps(schedule, { runId: "fault", clock, shards: 1, configuration: {}, signal: new AbortController().signal,
      evidence: createExecutionEvidenceCollector({ projectId: "p", definitionRevision: "r" }, [], { privateMarkers: true }), metrics: createStressAccumulator(metricPlan, "fault"),
      gate: { ...gate, async enter(request, signal) { const release = await gate.enter(request, signal); leases++; acquired++; return () => { leases--; release(); }; } },
      createVu: async () => { throw new Error("remote only"); }, closeRun: async () => { rootClosed = true; },
      async spawnWorker(identity) {
        const pair = privateChannels(), wire = pair[1], pieces = new Map<string, string[]>(), send = wire.send.bind(wire);
        wire.send = (raw) => {
          const chunk = raw as { transferId: string; index: number; total: number; data: string };
          const parts = pieces.get(chunk.transferId) ?? []; parts.push(chunk.data); pieces.set(chunk.transferId, parts);
          if (chunk.index + 1 !== chunk.total) return;
          pieces.delete(chunk.transferId);
          const frame = JSON.parse(parts.join(""));
          if (frame.value?.type === "drained" && fault === "missing-snapshot") delete frame.value.snapshot;
          const text = JSON.stringify(frame), total = Math.ceil(text.length / 16384);
          const packets = Array.from({ length: total }, (_, i) => ({ ...raw as object, index: i, total, bytes: Buffer.byteLength(text), data: text.slice(i * 16384, (i + 1) * 16384) }));
          for (const packet of packets) void send(packet);
          if (frame.value?.type === "drained" && fault === "duplicate-final") for (const packet of packets) void send({ ...packet, transferId: `duplicate-${chunk.transferId}` });
        };
        serveLocalStressWorker(wire, identity, async () => ({ clock, metricPlan, evidence: createExecutionEvidenceCollector({ projectId: "p", definitionRevision: "r" }, [], { privateMarkers: true }), host: {
          async createVu(_id, _inputs, host) { return { async execute(context) {
            if (fault === "exit-with-lease") { await host!.gate.enter({ protocol: "http", method: "GET", url: "http://127.0.0.1/", headers: {}, query: [], auth: { kind: "none" } }, context.signal); await wire.close(); }
            return { state: "passed", durationMs: 1 };
          }, close: async () => {} }; },
        } })); return pair[0];
      },
    });
    try {
      await expect(runStressSchedule(schedule, local.deps)).rejects.toThrow("withheld");
      expect(local.richOutputComplete()).toBe(false); expect(rootClosed).toBe(true); expect(leases).toBe(0); expect(acquired).toBe(fault === "exit-with-lease" ? 1 : 0);
    } finally { await local.close(); }
  });
  it("stops consuming a marker source as soon as the private union budget is exhausted", () => {
    // An eager Set union consumes every participant's marker strings before noticing the byte ceiling.
    let consumed = 0; const union = new Set<string>(), value = "x".repeat(1024 * 1024);
    function* markers() { for (let i = 0; i < 20; i++) { consumed++; yield `${i}:${value}`; } }
    expect(() => mergeStressWorkerMarkers(union, markers())).toThrow();
    expect(consumed).toBeLessThan(20);
  });
  it("rejects a mixed-version participant before accepting any result", async () => {
    const [coordinator, worker] = privateChannels();
    const peer = createStressWorkerPeer(coordinator, { runId: "current", workerId: "worker-1" }, async () => ({}));
    const pending = peer.request({ type: "clock" });
    const data = JSON.stringify({ protocolVersion: 2, runId: "current", workerId: "worker-1", kind: "response", id: "1", ok: true, value: { workerNow: 1 } });
    worker.send({ protocolVersion: 3, runId: "current", workerId: "worker-1", kind: "chunk", transferId: "1", index: 0, total: 1, bytes: Buffer.byteLength(data), data });
    await expect(pending).rejects.toThrow("worker-failed"); expect(peer.failed).toBe(true); await peer.close();
  });
  it("conserves a single budget and gate across two workers and includes coordinator late markers before finish", async () => {
    // Independent shard loops would overspend five slots or hold two simultaneous request permits.
    const clock: StressClock = { now: () => performance.now(), wallNow: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
    const metricPlan = legacyStressMetricPlan;
    const schedule = { load: { kind: "constant-vus" as const, vus: 2 }, durationMs: null, maxIterations: 5, maxVus: 2, warmupMs: 0, thinkTimeMs: 0, pacingMs: 0, gracefulStopMs: 30000, metricPlan,
      requested: { maxRequestConcurrency: 1, maxRps: null }, effective: { maxRequestConcurrency: 1, maxRps: null } };
    const evidence = createExecutionEvidenceCollector({ projectId: "p", definitionRevision: "r" }, [], { maxSamples: 20, privateMarkers: true });
    const workerEvidence: ReturnType<typeof createExecutionEvidenceCollector>[] = [];
    const ids: string[] = []; let active = 0, peak = 0, rootClosed = false, finished = false;
    const accumulator = createStressAccumulator(metricPlan, "remote-budget");
    const local = await createLocalStressWorkerDeps(schedule, { runId: "remote-budget", clock, signal: new AbortController().signal, evidence,
      gate: createStressRequestGate({ clock, maxConcurrency: 1, authorizeRequest() {} }), metrics: { ...accumulator, merge(snapshot) { accumulator.merge(snapshot); Reflect.set(snapshot.observations.caseRows, "total", 999); } },
      createVu: async () => { throw new Error("local VU must not execute"); },
      async closeRun() { rootClosed = true; evidence.addMarkers(["late-root-secret"]); },
      onProgress(progress) { if (progress.state === "finished") { finished = true; expect(rootClosed).toBe(true); } },
      shards: 2, configuration: {}, async spawnWorker(identity) {
        const channels = privateChannels();
        const privateEvidence = createExecutionEvidenceCollector({ projectId: "p", definitionRevision: "r" }, [identity.workerId], { maxSamples: 20, privateMarkers: true }); workerEvidence.push(privateEvidence);
        serveLocalStressWorker(channels[1], identity, async () => ({ metricPlan, clock, evidence: privateEvidence, host: {
          async createVu(_id, _inputs, host) { return {
            async execute(context: StressIterationContext) {
              ids.push(context.iterationId);
              const release = await host!.gate.enter({ protocol: "http", method: "GET", url: "http://127.0.0.1/", headers: {}, query: [], auth: { kind: "none" } }, context.signal);
              active++; peak = Math.max(peak, active); const begin = clock.now(); await clock.sleep(2);
              host!.observe({ kind: "http", ...context.observation!(), vuId: context.vuId, iterationId: context.iterationId, stageId: context.stageId, nodeKey: null, started: 1, completed: 1 });
              active--; release(); return { state: "passed", durationMs: clock.now() - begin };
            }, async close() {},
          }; },
        } })); return channels[0];
      },
    });
    try {
      const summary = await runStressSchedule(schedule, local.deps);
      expect(summary.iterations).toMatchObject({ planned: 5, started: 5, completed: 5, dropped: 0 });
      expect(new Set(ids).size).toBe(5); expect(ids).toHaveLength(5); expect(peak).toBe(1);
      expect(summary.httpExchanges).toEqual({ started: 5, completed: 5 }); expect(finished).toBe(true);
      expect(local.distributed(summary).perShard.map((worker) => worker.totalRequests)).toEqual([0, 0]); // The merge-owned full snapshot is not retained for metadata.
      for (const collected of workerEvidence) expect(collected.boundary().redactText("late-root-secret")).not.toContain("late-root-secret");
    } finally { await local.close(); }
  });
});

/** 成功 shard 替身回传：固定样本批。 */
const shardResult = (
  shardId: string,
  timeMsList: number[],
  metrics?: Partial<ShardResult["generator"]>,
  window?: Partial<ShardResult["measurementWindow"]>,
): ShardResult => ({
  protocolVersion: 2,
  ok: true,
  shardId,
  samples: timeMsList.map((t) => ({ timeMs: t, requestTimeMs: t, scriptTimeMs: 0, iterationTimeMs: t, requestStarted: true, requestCompleted: true, status: 200, ok: true })),
  measurementWindow: {
    startWallMs: 1_000, endWallMs: 1_100, monotonicDurationMs: 100, eligibleCompletedAttempts: timeMsList.length,
    ...window,
  },
  generator: {
    cpuUserMs: 1, cpuSystemMs: 2, cpuPercent: 3, rssStartBytes: 10, rssPeakBytes: 20,
    eventLoopDelayP95Ms: 4, schedulerBacklogMax: 0, saturated: false, reasons: [],
    limits: { cpuPercent: 90, eventLoopDelayP95Ms: 100, schedulerBacklog: 0 },
    ...metrics,
  },
});

/** 失败 shard 替身回传。 */
const shardFailure = (shardId: string, error: string): ShardFailure => ({
  protocolVersion: 2,
  ok: false,
  shardId,
  error,
});

describe("planShards", () => {
  it("拒绝 shards 大于全局 concurrency，且不尝试伪造每 shard 并发", () => {
    expect(() => planShards({ concurrency: 2, maxIterations: 8 }, 3)).toThrow(/shards.*concurrency|concurrency.*shards/);
  });

  it("多 shard 请求 maxRps 时在 spawn 前稳定拒绝全局不可证明的组合", async () => {
    let spawned = 0;
    await expect(new DistributedStressCoordinator().run(
      { apiPath: "/api/pet", caseId: "c1", definitionRevision: "rev-1", credentialVersions: {}, networkIdentity: `sha256:${"0".repeat(64)}`, workspaceRoot: "/ws", concurrency: 4, maxIterations: 8, maxRps: 10 },
      { shards: 2, spawnWorker: async () => { spawned += 1; return shardFailure("shard-0", "unexpected"); } },
    )).rejects.toThrow(/shard.*maxRps|maxRps.*shard|全局/);
    expect(spawned).toBe(0);
  });
  it("多 shard 不再拆分 maxRps 配额", () => {
    expect(() => planShards({ concurrency: 3, maxIterations: 8, maxRps: 1 }, 3)).toThrow(/shard.*maxRps|maxRps.*shard|全局/);
  });

  it("single shard 保留 maxRps 上限，不拆分独立 limiter", () => {
    expect(planShards({ concurrency: 1, maxIterations: 2, maxRps: Number.MIN_VALUE }, 1)[0]?.maxRps)
      .toBe(Number.MIN_VALUE);
  });
  it("iterations 均分：12/3 → [4,4,4]", () => {
    const plans = planShards({ concurrency: 3, maxIterations: 12 }, 3);
    expect(plans.map((p) => p.maxIterations)).toEqual([4, 4, 4]);
  });

  it("iterations 余数给前 r 个：13/3 → [5,4,4]，总数守恒", () => {
    const plans = planShards({ concurrency: 3, maxIterations: 13 }, 3);
    expect(plans.map((p) => p.maxIterations)).toEqual([5, 4, 4]);
    expect(plans.reduce((sum, p) => sum + (p.maxIterations ?? 0), 0)).toBe(13);
  });

  it("并发 max(1,floor) + 余数给前 r：4/3 → [2,1,1]", () => {
    const plans = planShards({ concurrency: 4, maxIterations: 3 }, 3);
    expect(plans.map((p) => p.concurrency)).toEqual([2, 1, 1]);
  });

  it("并发每 shard 至少 1：2/4 → [1,1,1,1]", () => {
    const plans = planShards({ concurrency: 4, maxIterations: 4 }, 4);
    expect(plans.map((p) => p.concurrency)).toEqual([1, 1, 1, 1]);
  });

  it("duration 模式：各 shard durationMs 相同且 iterations 均为 undefined", () => {
    const plans = planShards({ concurrency: 3, durationMs: 5_000 }, 3);
    expect(plans.map((p) => p.durationMs)).toEqual([5_000, 5_000, 5_000]);
    for (const p of plans) expect(p.maxIterations).toBeUndefined();
  });

  it("非法入参：终止条件缺失抛错（与 StressRunner 同口径）；shards 非正整数抛错", () => {
    expect(() => planShards({ concurrency: 1 }, 2)).toThrow("maxIterations");
    expect(() => planShards({ concurrency: 1, maxIterations: 4 }, 0)).toThrow("shards");
  });

  it("iterations 少于 shards：fail-fast 抛中文错误（不产 0 迭代 shard）；duration 模式不受影响", () => {
    expect(() => planShards({ concurrency: 3, maxIterations: 2 }, 3)).toThrow(
      "shards 不能大于总迭代数（2）",
    );
    expect(() => planShards({ concurrency: 3, durationMs: 1_000 }, 3)).not.toThrow();
  });
});

describe("StressWorkerSpec contract revision descriptors", () => {
  it("requires the selected definition revision and credential version descriptors", () => {
    const base = {
      protocolVersion: 2,
      shardId: "shard-0",
      apiPath: "/api/pet",
      caseId: "case-1",
      concurrency: 1,
      maxIterations: 1,
      workspaceRoot: "C:/workspace",
    };

    expect(() => StressWorkerSpecSchema.parse(base)).toThrow();
    expect(StressWorkerSpecSchema.parse({
      ...base,
      definitionRevision: "sha256:project-revision",
      credentialVersions: { "ref-1": "version-3" },
      networkIdentity: `sha256:${"0".repeat(64)}`,
    })).toMatchObject({
      definitionRevision: "sha256:project-revision",
      credentialVersions: { "ref-1": "version-3" },
      networkIdentity: `sha256:${"0".repeat(64)}`,
    });
    expect(() => StressWorkerSpecSchema.parse({
      ...base,
      definitionRevision: "sha256:project-revision",
      credentialVersions: { "ref-1": "version-3" },
      credentialValues: { "ref-1": "must-not-cross-worker-boundary" },
    })).toThrow();
  });

  it("preserves every own string credential-version key through strict parsing and JSON round trips", () => {
    const versions = JSON.parse('{"__proto__":"v-proto","constructor":"v-constructor","toString":"v-toString"}') as Record<string, string>;
    const wire = JSON.stringify({
      protocolVersion: 2,
      shardId: "shard-0",
      apiPath: "groups/g/projects/p/collections/c/apis/a",
      caseId: "case-1",
      definitionRevision: "sha256:project-revision",
      credentialVersions: versions,
      networkIdentity: `sha256:${"0".repeat(64)}`,
      concurrency: 1,
      maxIterations: 1,
      workspaceRoot: "C:/workspace",
    });
    const parsed = StressWorkerSpecSchema.parse(JSON.parse(wire));
    const roundTripped = JSON.parse(JSON.stringify(parsed)) as { credentialVersions: Record<string, string> };

    expect(Object.keys(roundTripped.credentialVersions).sort()).toEqual(["__proto__", "constructor", "toString"]);
    expect(Object.hasOwn(roundTripped.credentialVersions, "__proto__")).toBe(true);
    expect(roundTripped.credentialVersions["__proto__"]).toBe("v-proto");
    expect(roundTripped.credentialVersions.constructor).toBe("v-constructor");
    expect(roundTripped.credentialVersions.toString).toBe("v-toString");
  });
});

describe("DistributedStressCoordinator", () => {
  it("C1 Fix2 private completion failure releases waiting peers and aborts owned transports without partial output", async () => {
    const signals: AbortSignal[] = [];
    await expect(new DistributedStressCoordinator().run({ apiPath: "/api", caseId: "c", definitionRevision: "r", credentialVersions: {}, networkIdentity: `sha256:${"0".repeat(64)}`, workspaceRoot: "/ws", concurrency: 2, maxIterations: 2 }, {
      shards: 2, shardTimeoutMs: 30,
      spawnWorker: async (spec, control) => {
        signals.push(control.signal);
        if (spec.shardId === "shard-1") return new Promise<ShardOutcome>(() => {});
        await control.finalizeEvidence(["private-marker"]);
        return shardResult(spec.shardId, [1]);
      },
    })).rejects.toThrow("completion incomplete");
    expect(signals).toHaveLength(2); expect(signals.every((signal) => signal.aborted)).toBe(true);
    await expect(new DistributedStressCoordinator().run({ apiPath: "/api", caseId: "c", definitionRevision: "r", credentialVersions: {}, networkIdentity: `sha256:${"0".repeat(64)}`, workspaceRoot: "/ws", concurrency: 1, maxIterations: 1 }, {
      shards: 1, spawnWorker: async (spec, control) => {
        await control.finalizeEvidence(["x".repeat(16 * 1024 * 1024)]);
        return shardResult(spec.shardId, [1]);
      },
    })).rejects.toThrow("completion incomplete");
    let partialHandshake = false;
    await expect(new DistributedStressCoordinator().run({ apiPath: "/api", caseId: "c", definitionRevision: "r", credentialVersions: {}, networkIdentity: `sha256:${"0".repeat(64)}`, workspaceRoot: "/ws", concurrency: 2, maxIterations: 2 }, {
      shards: 2, spawnWorker: async (spec, control) => {
        if (spec.shardId === "shard-0") { await control.finalizeEvidence([]); return shardResult(spec.shardId, [1]); }
        await new StressRunner({ finalizeEvidence: async (markers) => { partialHandshake = true; return control.finalizeEvidence(markers); },
          createWorker: () => ({ close: async () => {}, execute: async () => ({
            request: { protocol: "http", method: "GET", url: "https://example.test", headers: {}, query: [], auth: { kind: "none" } },
            outcome: { apiId: "a", apiName: "a", caseId: "c", caseName: "c", passed: true, durationMs: 1, assertions: [] },
            requestTimeMs: 1, scriptTimeMs: 0, iterationTimeMs: 1,
            extractionOutcomes: [{ id: "e", name: "secret", selector: { target: "bodyText", match: "first" }, status: "extracted", code: "OK", pass: true, sensitive: true, published: true, message: "capacity", value: "z".repeat(16 * 1024 * 1024) }],
          }) }),
        }).run({ concurrency: 1, maxIterations: 1 });
        return shardResult(spec.shardId, [1]);
      },
    })).rejects.toThrow("completion incomplete");
    expect(partialHandshake).toBe(false);
  });
  it("C1 Fix2 unions successful and unsampled worker markers before complete rich content is clipped", async () => {
    const cutoff = "cutoff-hidden-secret"; const nested = "nested-private-key";
    const encoded = "private/encoded value";
    // Preserve the real 64-KiB byte boundary, but avoid rewalking 64K ASCII code points
    // for every retained sample. The complete secret still starts six bytes before it.
    const bodyPrefix = "rich detail "; const paddingBytes = 65536 - 6 - Buffer.byteLength(bodyPrefix);
    const responseBody = bodyPrefix + "🙂".repeat(Math.floor(paddingBytes / 4)) + "x".repeat(paddingBytes % 4) + cutoff + ` ${nested} ${encodeURIComponent(encoded)}`;
    expect(Buffer.byteLength(responseBody.slice(0, responseBody.indexOf(cutoff)))).toBe(65536 - 6);
    const identity = { projectId: "project-passed", definitionRevision: "revision-passed" };
    const { report } = await new DistributedStressCoordinator().run({ apiPath: "/api", caseId: "case", definitionRevision: "r", credentialVersions: {}, networkIdentity: `sha256:${"0".repeat(64)}`, workspaceRoot: "/ws", concurrency: 2, maxIterations: 44 }, {
      shards: 2,
      spawnWorker: async (spec, control) => {
        let index = 0; const samples: ShardResult["samples"] = [];
        const result = await new StressRunner({ evidenceIdentity: identity,
          finalizeEvidence: async (markers) => { const union = await control.finalizeEvidence(markers); expect([...union]).toEqual([...union].sort()); return union; },
          onSample: (sample) => samples.push({ requestTimeMs: 1, scriptTimeMs: 0, iterationTimeMs: 1, requestStarted: true, requestCompleted: true, status: sample.status, ok: sample.ok, failureKind: sample.failureKind, error: sample.error, safety: sample.safety }),
          createWorker: () => ({ execute: async () => {
            const row = index++; const learns = spec.shardId === "shard-1";
            const passed = learns && row === 21;
            return { request: { protocol: "http", method: "GET", url: `https://example.test/${nested}`, query: [], headers: { business: encoded }, auth: { kind: "none" } },
              response: { status: 200, headers: {}, bodyText: responseBody, timeMs: 1 },
              outcome: { apiId: "api-passed", caseId: "case-passed", apiName: "public API", caseName: "public case", passed, row, durationMs: 1, assertions: [], error: passed ? undefined : nested, failureKind: passed ? undefined : "assertion" },
              assertionOutcomes: [{ id: "assertion-passed", op: "eq", selector: { target: "bodyText", match: "first", path: nested }, pass: false, code: "ASSERTION_FAILED", message: nested, actual: encoded, expected: "public expected" }],
              extractionOutcomes: learns && row >= 20 ? [{ id: "extract", name: "token", selector: { target: "bodyText", match: "first" }, pass: true, status: "extracted", code: "OK", message: "learned", sensitive: true, published: true, value: passed ? cutoff : { [nested]: [encoded, "passed"] } }] : [],
              safety: { origin: `https://${nested}.test`, confirmation: "confirmed", policy: "allowed", appliedPolicy: { trustedOrigins: [], deniedOrigins: [] } },
              requestTimeMs: 1, scriptTimeMs: 0, iterationTimeMs: 1, requestStarted: true, requestCompleted: true, failureKind: passed ? undefined : "assertion" } as CaseExecutionResult;
          }, close: async () => {} }),
        }).run({ concurrency: 1, maxIterations: 22 });
        return { protocolVersion: 2, ok: true, shardId: spec.shardId, samples, generator: result.generator!, measurementWindow: result.measurementWindow!, failureEvidence: result.failureEvidence };
      },
    });
    expect(report).toMatchObject({ totalRequests: 44, ok: 1, failed: 43, distributed: { dataComplete: true } });
    expect(report.failureEvidence).toHaveLength(20);
    expect(report.failureEvidence![0]!.identity).toMatchObject(identity);
    expect(report.failureEvidence![0]!.request?.protocol).toBe("http");
    const body = report.failureEvidence![0]!.response!.body;
    expect(body.text).toContain("rich detail"); expect(body.text).not.toContain("cutoff"); expect(body.truncated).toBe(true);
    expect(Buffer.byteLength(body.text)).toBe(65536);
    expect(report.failureEvidence![0]!.assertions![0]!.expected?.text).toBe("public expected");
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(nested); expect(serialized).not.toContain(encoded); expect(serialized).not.toContain(encodeURIComponent(encoded));
    expect(serialized).not.toContain("markers"); expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(16 * 1024 * 1024);
    // The final merged boundary shares its value/report budget across every business diagnostic channel.
    const longDiagnostic = "D".repeat(4068) + cutoff + "z".repeat(8192);
    const diagnostics = createExecutionEvidenceCollector(identity, [cutoff, nested, encoded]).projectStressReport({ ...report,
      generator: { availability: "unavailable", unavailableReason: longDiagnostic },
      distributed: { ...report.distributed!, perShard: report.distributed!.perShard.map((shard) => ({ ...shard, generator: { availability: "unavailable", unavailableReason: longDiagnostic } })), shardErrors: [{ shardId: "shard-0", error: longDiagnostic }] },
      safety: { ...report.safety!, unavailableReason: longDiagnostic, targetOrigins: [{ ...report.safety!.targetOrigins[0]!, origin: longDiagnostic, appliedPolicy: { trustedOrigins: Array(150_000).fill("https://public.test"), deniedOrigins: [longDiagnostic] } }] },
    }, true);
    const values = [diagnostics.generator!.unavailableReason!, diagnostics.distributed!.perShard[0]!.generator.unavailableReason!, diagnostics.distributed!.shardErrors![0]!.error,
      diagnostics.safety!.unavailableReason!, diagnostics.safety!.targetOrigins[0]!.origin, diagnostics.safety!.targetOrigins[0]!.appliedPolicy!.deniedOrigins![0]!];
    for (const value of values) { expect(Buffer.byteLength(value)).toBeLessThanOrEqual(4096); expect(value).toMatch(/truncated|omitted/); expect(value).not.toContain("cuto"); }
    const origins = diagnostics.safety!.targetOrigins[0]!.appliedPolicy!.trustedOrigins!;
    expect(origins.length).toBeLessThan(150_000); expect(origins.at(-1)).toContain("omitted");
    expect(diagnostics).toMatchObject({ totalRequests: 44, ok: 1, failed: 43 });
    expect(diagnostics.failureEvidence).toHaveLength(20); expect(Buffer.byteLength(JSON.stringify(diagnostics))).toBeLessThanOrEqual(16 * 1024 * 1024);
    const finalSink = redactExecutionOutput({ ...report, generator: { availability: "unavailable" as const, unavailableReason: longDiagnostic } }, createCredentialOutputSanitizer([cutoff, "D"]));
    expect(Buffer.byteLength(finalSink.generator!.unavailableReason!)).toBeLessThanOrEqual(4096);
    expect(finalSink.generator!.unavailableReason).toContain("truncated/omitted");
  });
  // 定位/份额基础规格：concurrency 3 → 两 shard 分得 [2,1]；iterations 8 → [4,4]。
  const specBase = {
    apiPath: "/api/pet",
    caseId: "c1",
    definitionRevision: "rev-1",
    credentialVersions: {},
    networkIdentity: `sha256:${"0".repeat(64)}`,
    workspaceRoot: "/ws",
    concurrency: 3,
    maxIterations: 8,
  };
  const coordinator = new DistributedStressCoordinator();

  it("2 shard 成功：总数合并、perShard 计数/rps、分位为合并样本精确值（非分位数的分位数）", async () => {
    const shardTimes: Record<string, number[]> = {
      "shard-0": [10, 20, 30, 40],
      "shard-1": [50, 60, 70, 80],
    };
    const seen: StressWorkerSpec[] = [];
    const { report, shardFailureCount } = await coordinator.run(specBase, {
      shards: 2,
      spawnWorker: async (spec) => {
        seen.push(spec);
        await new Promise((r) => setTimeout(r, 25)); // 留出协调窗口，rps 断言才有意义
        return shardResult(spec.shardId, shardTimes[spec.shardId] ?? []);
      },
    });

    expect(shardFailureCount).toBe(0);
    // 下发规格：协议版本锚点 + 定位透传 + D3 份额分配
    expect(seen.map((s) => s.shardId)).toEqual(["shard-0", "shard-1"]);
    expect(seen.map((s) => [s.maxIterations, s.concurrency])).toEqual([
      [4, 2],
      [4, 1],
    ]);
    expect(
      seen.every(
        (s) =>
          s.protocolVersion === 2 &&
          s.apiPath === "/api/pet" &&
          s.caseId === "c1" &&
          s.workspaceRoot === "/ws",
      ),
    ).toBe(true);

    expect(report.totalRequests).toBe(8);
    expect(report.concurrency).toBe(3); // 各成功 shard 分得并发之和
    expect(report.distributed?.shards).toBe(2);
    expect(report.distributed?.perShard).toEqual([
      expect.objectContaining({ shardId: "shard-0", totalRequests: 4, ok: 4, failed: 0, rps: expect.any(Number) }),
      expect.objectContaining({ shardId: "shard-1", totalRequests: 4, ok: 4, failed: 0, rps: expect.any(Number) }),
    ]);
    // perShard rps 口径 = shard 请求数 ÷ 协调窗口秒（与整体 rps 同窗）
    for (const s of report.distributed?.perShard ?? []) {
      expect(s.rps).toBeCloseTo(s.totalRequests / (report.durationMs / 1000), 5);
    }
    expect(report.rps).toBeCloseTo(8 / (report.durationMs / 1000), 5);
    expect(report.distributed?.shardErrors).toBeUndefined(); // 无失败时省略字段

    // 分位钉值：合并 [10..80] n=8 → p50=第4个=40、p90=第8个=80；
    // 若误走「分位数的分位数」（各 shard p50=25/55 再合成）则此断言必失败。
    expect(report.latency.p50).toBe(40);
    expect(report.latency.p90).toBe(80);
    expect(report.latency.min).toBe(10);
    expect(report.latency.max).toBe(80);
    // 与「合并样本直接 computeReport」逐字段一致
    const merged: StressSample[] = [...shardTimes["shard-0"], ...shardTimes["shard-1"]].map(
      (t) => ({ timeMs: t, status: 200, ok: true }),
    );
    const direct = computeReport(merged, {
      concurrency: report.concurrency,
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
    });
    expect(report.latency).toEqual(direct.latency);
    // 含 distributed 段的报告整体可被 schema 校验
    expect(() => StressReportSchema.parse(report)).not.toThrow();
  });

  it("顶层与 per-shard RPS 都使用 startWall + monotonicDuration，minRps 不被 raw endWall 覆盖", async () => {
    const { report } = await coordinator.run(
      { ...specBase, concurrency: 1, maxIterations: 1, minRps: 8 },
      {
        shards: 1,
        spawnWorker: async (spec) => shardResult(spec.shardId, [10], undefined, {
          startWallMs: 1_000, endWallMs: 1_100, monotonicDurationMs: 200,
        }),
      },
    );

    expect(report.distributed?.perShard[0]?.rps).toBe(5);
    expect(report.measurementWindow).toMatchObject({ startWallMs: 1_000, endWallMs: 1_200, monotonicDurationMs: 200 });
    expect(report.rps).toBe(5);
    expect(report.verdict?.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "rps", actual: 5, expected: 8 }),
    ]));
  });

  it("联合窗口按 worker 压力区间计算，分别覆盖重叠与非重叠 shard", async () => {
    const runWithWindows = async (windows: Array<[number, number, number]>) => coordinator.run(
      { ...specBase, concurrency: 2, maxIterations: 2 },
      {
        shards: 2,
        spawnWorker: async (spec) => {
          const [startWallMs, endWallMs, monotonicDurationMs] = windows[Number(spec.shardId.slice(-1))]!;
          return shardResult(spec.shardId, [10], undefined, { startWallMs, endWallMs, monotonicDurationMs });
        },
      },
    );

    const overlapping = await runWithWindows([[1_000, 1_100, 200], [1_100, 1_200, 200]]);
    expect(overlapping.report.measurementWindow).toMatchObject({ startWallMs: 1_000, endWallMs: 1_300, monotonicDurationMs: 300 });
    expect(overlapping.report.rps).toBeCloseTo(2 / 0.3, 8);

    const nonOverlapping = await runWithWindows([[2_000, 2_100, 200], [2_300, 2_400, 200]]);
    expect(nonOverlapping.report.measurementWindow).toMatchObject({ startWallMs: 2_000, endWallMs: 2_500, monotonicDurationMs: 500 });
    expect(nonOverlapping.report.rps).toBe(4);
  });

  it("墙钟倒退时使用 monotonic fallback，缺少窗口字段则严格拒绝", async () => {
    expect(StressMeasurementWindowSchema.safeParse({
      startWallMs: 2_000, endWallMs: 1_000, monotonicDurationMs: 200, eligibleCompletedAttempts: 1,
    }).success).toBe(true);
    expect(StressMeasurementWindowSchema.safeParse({
      endWallMs: 1_000, monotonicDurationMs: 200, eligibleCompletedAttempts: 1,
    }).success).toBe(false);

    const { report } = await coordinator.run(
      { ...specBase, concurrency: 1, maxIterations: 1 },
      {
        shards: 1,
        spawnWorker: async (spec) => shardResult(spec.shardId, [10], undefined, {
          startWallMs: 2_000, endWallMs: 1_000, monotonicDurationMs: 200,
        }),
      },
    );
    expect(report.rps).toBe(5);
    expect(report.measurementWindow).toMatchObject({ startWallMs: 2_000, endWallMs: 2_200, monotonicDurationMs: 200 });
  });

  it("跨 shard 合并 pre-I/O config/safety rejection 与成功样本时 verdict 仍失败", async () => {
    const rejected: ShardResult = {
      ...shardResult("shard-0", [0]),
      samples: [{
        requestTimeMs: 0, scriptTimeMs: 0, iterationTimeMs: 1, requestStarted: false, requestCompleted: false,
        status: 0, ok: false, failureKind: "config", error: "target_confirmation_required",
        safety: {
          origin: "https://example.com", confirmation: "rejected", policy: "target_confirmation_required",
          loopback: false, appliedPolicy: { trustedOrigins: [], deniedOrigins: [] },
        },
      }],
      measurementWindow: { startWallMs: 1_000, endWallMs: 1_100, monotonicDurationMs: 100, eligibleCompletedAttempts: 0 },
    };
    const { report } = await coordinator.run(
      { ...specBase, concurrency: 2, maxIterations: 2 },
      {
        shards: 2,
        spawnWorker: async (spec) => spec.shardId === "shard-0" ? rejected : shardResult(spec.shardId, [10]),
      },
    );

    expect(report.totalRequests).toBe(2);
    expect(report.ok).toBe(1);
    expect(report.failures.config).toBe(1);
    expect(report.eligibleFailureCounts?.config).toBe(0);
    expect(report.verdict?.passed).toBe(false);
    expect(report.verdict?.violations).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: "businessFailures", actual: 1 }),
    ]));
  });

  it("部分失败：成功样本入报告、shardErrors 恰 1 条、run 不抛、并发只计成功 shard", async () => {
    const { report, shardFailureCount } = await coordinator.run(
      { ...specBase, concurrency: 5 }, // 分得 [3,2]，成功 shard-0 → 报告并发 3
      {
        shards: 2,
        spawnWorker: async (spec) =>
          spec.shardId === "shard-0"
            ? shardResult("shard-0", [10, 20])
            : shardFailure(spec.shardId, "worker 进程崩溃"),
      },
    );

    expect(shardFailureCount).toBe(1);
    expect(report.totalRequests).toBe(2);
    expect(report.ok).toBe(2);
    expect(report.concurrency).toBe(3);
    expect(report.distributed?.perShard).toEqual([
      expect.objectContaining({ shardId: "shard-0", totalRequests: 2, ok: 2, failed: 0, rps: expect.any(Number) }),
    ]);
    expect(report.distributed?.shardErrors).toEqual([
      { shardId: "shard-1", error: "worker 进程崩溃" },
    ]);
  });

  it("全部 shard 失败：输出 strict failed report，generator/safety 明确不可用并保留诊断", async () => {
    const { report, shardFailureCount } = await coordinator.run(specBase, {
      shards: 2,
      spawnWorker: async (spec) => shardFailure(spec.shardId, `case ${spec.caseId} 不存在`),
    });
    expect(shardFailureCount).toBe(2);
    expect(report.distributed?.dataComplete).toBe(false);
    expect(report.distributed?.shardErrors).toHaveLength(2);
    expect(report.verdict?.passed).toBe(false);
    expect(report.verdict?.violations.map((v) => v.metric)).toContain("noData");
    expect(report.generator).toMatchObject({ availability: "unavailable" });
    expect(report.safety).toMatchObject({ availability: "unavailable", targetOrigins: [] });
    expect(() => CurrentStressReportSchema.parse(report)).not.toThrow();
  });

  it("iterations 少于 shards：coordinator.run 同样 fail-fast 抛中文错误（planShards 闸口）", async () => {
    await expect(
      coordinator.run({ ...specBase, maxIterations: 2 }, { shards: 3, spawnWorker: async () => shardResult("shard-0", []) }),
    ).rejects.toThrow("shards 不能大于总迭代数（2）");
  });

  it("对称失败：shard-0 失败、shard-1 成功——perShard/shardErrors 按 shard 下标序稳定输出（非完成序）", async () => {
    const { report, shardFailureCount } = await coordinator.run(specBase, {
      shards: 2,
      spawnWorker: async (spec) => {
        // shard-1 先完成、shard-0 后失败：证明结果顺序与完成时序无关
        await new Promise((r) => setTimeout(r, spec.shardId === "shard-0" ? 30 : 1));
        return spec.shardId === "shard-0"
          ? shardFailure("shard-0", "shard-0 启动失败")
          : shardResult("shard-1", [10, 20]);
      },
    });

    expect(shardFailureCount).toBe(1);
    expect(report.totalRequests).toBe(2);
    // 分得 [2,1]，仅成功 shard-1 分得 1
    expect(report.concurrency).toBe(1);
    expect(report.distributed?.perShard).toEqual([
      expect.objectContaining({ shardId: "shard-1", totalRequests: 2, ok: 2, failed: 0, rps: expect.any(Number) }),
    ]);
    expect(report.distributed?.shardErrors).toEqual([
      { shardId: "shard-0", error: "shard-0 启动失败" },
    ]);
  });

  it("超时：shardTimeoutMs 到期判 shard 失败（20ms 极短值 + 永不 resolve 替身，不真实长等）", async () => {
    const t0 = Date.now();
    await expect(coordinator.run(specBase, {
      shards: 2,
      shardTimeoutMs: 20,
      spawnWorker: () => new Promise<ShardOutcome>(() => undefined),
    })).resolves.toMatchObject({ shardFailureCount: 2, report: { verdict: { passed: false } } });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(5_000);
  });

  it("协议坏输出：载荷未通过 ShardOutcomeSchema → 判失败且 error 含「协议」", async () => {
    await expect(coordinator.run(specBase, {
      shards: 1,
      spawnWorker: async () => ({ junk: true }) as unknown as ShardOutcome,
    })).resolves.toMatchObject({ shardFailureCount: 1, report: { verdict: { passed: false } } });
  });

  it("v1 输出被明确拒绝，且失败使 dataComplete=false、verdict=false", async () => {
    await expect(coordinator.run(specBase, {
      shards: 1,
      spawnWorker: async () => ({ protocolVersion: 1, ok: false, shardId: "shard-0", error: "legacy" } as unknown as ShardOutcome),
    })).resolves.toMatchObject({ shardFailureCount: 1, report: { verdict: { passed: false } } });
  });

  it("跨 shard 合并 assertion failure 并聚合 generator 指标", async () => {
    const result = (id: string, user: number, rss: number): ShardResult => ({
      ...shardResult(id, [10]),
      samples: [{ requestTimeMs: 10, scriptTimeMs: 0, iterationTimeMs: 10, requestStarted: true, requestCompleted: true, status: 200, ok: false, failureKind: "assertion" }],
      generator: { ...shardResult(id, [10]).generator, cpuUserMs: user, rssPeakBytes: rss, reasons: ["cpu"], saturated: true },
    });
    const { report } = await coordinator.run({ ...specBase, maxIterations: 2 }, {
      shards: 2,
      spawnWorker: async (spec) => result(spec.shardId, spec.shardId === "shard-0" ? 3 : 5, spec.shardId === "shard-0" ? 20 : 30),
    });
    expect(report.failures.assertion).toBe(2);
    expect(report.verdict?.passed).toBe(false);
    expect(report.generator?.cpuUserMs).toBe(8);
    expect(report.generator?.rssPeakBytes).toBe(30);
    expect(report.generator?.reasons).toEqual(["cpu"]);
    expect(report.generator?.saturated).toBe(true);
  });

  it("顶层 CPU 采用各 shard 最大值而非求和，并按 90% limit 正确判断饱和", async () => {
    const result = (id: string, cpuPercent: number): ShardResult => ({
      ...shardResult(id, [10]),
      generator: { ...shardResult(id, [10]).generator, cpuPercent, saturated: false },
      measurementWindow: { startWallMs: 1_000, endWallMs: 1_100, monotonicDurationMs: 100, eligibleCompletedAttempts: 1 },
    });
    const { report } = await coordinator.run({ ...specBase, maxIterations: 2 }, {
      shards: 2,
      spawnWorker: async (spec) => result(spec.shardId, 60),
    });
    expect(report.generator?.cpuPercent).toBe(60);
    expect(report.generator?.limits?.cpuPercent).toBe(90);
    expect(report.generator?.saturated).toBe(false);
  });

  it("任一 shard generator 明确 partial 时顶层保留 partial 可用性", async () => {
    const result = (id: string): ShardResult => ({
      ...shardResult(id, [10]),
      generator: { ...shardResult(id, [10]).generator, availability: "partial", unavailableReason: "event-loop probe unavailable" },
    });
    const { report } = await coordinator.run({ ...specBase, maxIterations: 2 }, {
      shards: 2,
      spawnWorker: async (spec) => result(spec.shardId),
    });
    expect(report.generator?.availability).toBe("partial");
  });

  it("两个 worker 都回 shard-0：重复/错配路由作为 protocol error，不合并第二份样本", async () => {
    const { report, shardFailureCount } = await coordinator.run(specBase, {
      shards: 2,
      spawnWorker: async () => shardResult("shard-0", [99]),
    });
    expect(shardFailureCount).toBe(1);
    expect(report.totalRequests).toBe(1);
    expect(report.distributed?.perShard.map((item) => item.shardId)).toEqual(["shard-0"]);
    expect(report.distributed?.shardErrors?.[0]?.error).toMatch(/protocol|协议|shardId/i);
    expect(report.distributed?.dataComplete).toBe(false);
    expect(report.verdict?.passed).toBe(false);
  });

  it.each(["iterations", "duration"])("%s 模式成功协议但空样本：no_data 门禁失败且不产生通过报告", async (mode) => {
    const runSpec = mode === "iterations"
      ? { ...specBase, durationMs: undefined }
      : { ...specBase, maxIterations: undefined, durationMs: 10 };
    const { report, shardFailureCount } = await coordinator.run(runSpec, {
      shards: 2,
      spawnWorker: async (spec) => ({ ...shardResult(spec.shardId, []), samples: [] }),
    });
    expect(shardFailureCount).toBe(2);
    expect(report.totalRequests).toBe(0);
    expect(report.distributed?.dataComplete).toBe(false);
    expect(report.verdict?.passed).toBe(false);
    expect(report.distributed?.shardErrors?.every((error) => error.error.includes("NO_DATA"))).toBe(true);
    expect(report.verdict?.violations.some((violation) => violation.metric === "noData")).toBe(true);
  });
});

describe("StressReportSchema 旧报告兼容（D6）", () => {
  it("generator availability=unavailable 不允许用零值伪造指标，legacy 数值形状仍可读", () => {
    expect(StressGeneratorSchema.safeParse({ availability: "unavailable", unavailableReason: "worker failed" }).success).toBe(true);
    expect(StressGeneratorSchema.safeParse({ availability: "unavailable", cpuPercent: 0 }).success).toBe(false);
    expect(StressGeneratorSchema.safeParse({
      cpuUserMs: 0, cpuSystemMs: 0, cpuPercent: 0, rssStartBytes: 0, rssPeakBytes: 0,
      eventLoopDelayP95Ms: 0, schedulerBacklogMax: 0, saturated: false, reasons: [],
      limits: { cpuPercent: 90, eventLoopDelayP95Ms: 100, schedulerBacklog: 0 },
    }).success).toBe(true);
  });

  it("M2-C 形态（无 distributed）parse 成功且 distributed 为 undefined", () => {
    const legacy = {
      concurrency: 2,
      totalRequests: 4,
      ok: 3,
      failed: 1,
      durationMs: 20,
      rps: 200,
      latency: { min: 1, avg: 5, max: 9, p50: 5, p90: 9, p95: 9, p99: 9 },
      statusDist: { "200": 3, "404": 1 },
      errorKinds: { HTTP_404: 1 },
      startedAt: 1_000,
      finishedAt: 1_020,
    };
    const parsed = StressReportSchema.parse(legacy);
    expect(parsed.distributed).toBeUndefined();
  });

  it("当前报告契约要求 verdict/generator/safety，但旧报告仍可读", () => {
    const legacy = {
      concurrency: 2, totalRequests: 0, ok: 0, failed: 0, durationMs: 0, rps: 0,
      latency: { min: 0, avg: 0, max: 0, p50: 0, p90: 0, p95: 0, p99: 0 },
      statusDist: {}, errorKinds: {}, startedAt: 1_000, finishedAt: 1_000,
    };
    expect(CurrentStressReportSchema.safeParse(legacy).success).toBe(false);
    const current = {
      ...legacy,
      failures: { transport: 0, http: 0, script: 0, assertion: 0, extraction: 0, config: 0, aborted: 0 },
      eligibleFailureCounts: { transport: 0, http: 0, script: 0, assertion: 0, extraction: 0, config: 0, aborted: 0 },
      scriptLatency: legacy.latency, iterationLatency: legacy.latency,
      verdict: { passed: false, violations: [{ metric: "noData", actual: 0, expected: 1, message: "NO_DATA" }] },
      generator: {
        availability: "available",
        cpuUserMs: 0, cpuSystemMs: 0, cpuPercent: 0, rssStartBytes: 0, rssPeakBytes: 0,
        eventLoopDelayP95Ms: 0, schedulerBacklogMax: 0, saturated: false, reasons: [],
        limits: { cpuPercent: 90, eventLoopDelayP95Ms: 100, schedulerBacklog: 0 },
      },
      safety: {
        targetOrigins: [],
        run: { requestedConcurrency: 2, effectiveConcurrency: 2, requestedMaxRps: null, effectiveMaxRps: null, connectionMode: "pooled" },
      },
      eligibleCompletedAttempts: 0,
      measurementWindow: { startWallMs: 1_000, endWallMs: 1_000, monotonicDurationMs: 0, eligibleCompletedAttempts: 0 },
    };
    expect(CurrentStressReportSchema.safeParse(current).success).toBe(true);
    const { extraction: _extraction, ...oldCounts } = current.failures;
    const historical = { ...current, failures: oldCounts, eligibleFailureCounts: oldCounts };
    expect(StressReportSchema.parse(historical).failures?.extraction).toBe(0);
    expect(CurrentStressReportSchema.safeParse(historical).success).toBe(false);
  });
});

describe("StressSampleSchema v2 wire invariants", () => {
  const base = { requestTimeMs: 1, scriptTimeMs: 0, iterationTimeMs: 1, status: 200, ok: true };

  it("rejects successful assertion samples and invalid outcome fields", () => {
    expect(StressSampleSchema.safeParse({ ...base, failureKind: "assertion" }).success).toBe(false);
    expect(StressSampleSchema.safeParse({ ...base, outcome: { passed: "yes" } }).success).toBe(false);
  });

  it("rejects contradictory request start/completion and fabricated latency", () => {
    expect(StressSampleSchema.safeParse({ ...base, requestStarted: false, requestCompleted: true }).success).toBe(false);
    expect(StressSampleSchema.safeParse({ ...base, requestStarted: false, requestTimeMs: 1 }).success).toBe(false);
  });

  it("requires stable failureKind on failed samples", () => {
    expect(StressSampleSchema.safeParse({ ...base, ok: false }).success).toBe(false);
    expect(StressSampleSchema.safeParse({ ...base, ok: false, failureKind: "assertion" }).success).toBe(true);
  });
});

describe("ShardResultSchema v2 qualification contract", () => {
  it("requires both requestStarted and requestCompleted on every v2 wire sample", () => {
    const valid = shardResult("s0", [1]);
    const legacySample = { ...valid.samples[0]! };
    delete legacySample.requestStarted;
    delete legacySample.requestCompleted;
    const result = { ...valid, samples: [legacySample] };
    expect(ShardResultSchema.safeParse(result).success).toBe(false);
  });
});

import { z } from "zod";
import { JsonValueSchema, StringRecordSchema, type JsonValue } from "../contract/schemaNode.js";
import { createStressAccumulator } from "./metrics.js";
import { createGeneratorMetricsCollector, type GeneratorMetricsCollector } from "./generatorMetrics.js";
import type { StressAccumulator, StressClock, StressExecutionDeps, StressIterationContext, StressLifecycleResult, StressMetricEvent, StressRequestGate, StressVuSession } from "./execution.js";
import type { StressMetricPlan, StressPlan } from "./plan.js";
import { StressPhaseSchema, type StressCompletenessReason } from "./reportV2.js";
import { createStressWorkerPeer, STRESS_WORKER_PENDING_BYTES, stressWorkerRequest, sameStressClockDomain, StressClockDomainSchema, type StressClockDomainBinding, type StressWorkerChannel, type StressWorkerPeer } from "./workerProtocol.js";

export interface StressWorkerRuntime {
  readonly host: Pick<StressExecutionDeps, "createVu" | "closeRun">;
  readonly metricPlan: StressMetricPlan;
  readonly lifecycle?: StressPlan["lifecycle"];
  readonly evidence: StressExecutionDeps["evidence"];
  readonly clock: StressClock;
  readonly createGeneratorCollector?: () => GeneratorMetricsCollector;
}
const resultSchema = z.object({ state: z.enum(["passed", "failed", "aborted"]), durationMs: z.number().finite().nonnegative(), outputs: StringRecordSchema(JsonValueSchema), failureKind: z.enum(["transport", "http", "script", "assertion", "extraction", "config", "aborted"]).optional() }).strict();
export const StressWorkerLifecycleSchema = z.object({ role: z.enum(["vuSetup", "vuTeardown"]), result: resultSchema }).strict();
const phaseSchema = z.object({ phase: StressPhaseSchema, atMs: z.number().finite().nonnegative(), uncertain: z.boolean() }).strict();

/** Worker owns VUs and observations; no load curve, iteration allocator, or local request limiter. */
export function serveLocalStressWorker(channel: StressWorkerChannel, identity: { runId: string; workerId: string },
  prepare: (configuration: unknown, signal: AbortSignal) => Promise<StressWorkerRuntime>, clockDomain?: StressClockDomainBinding): StressWorkerPeer {
  let runtime: StressWorkerRuntime | undefined, metrics: StressAccumulator | undefined, started = false, drained = false, readyMarkers = false, unionDone = false;
  let delta = 0, runStart: number | undefined, requestSerial = 0, pendingBytes = 0;
  const abort = new AbortController(), reasons = new Set<StressCompletenessReason>();
  let generator: GeneratorMetricsCollector | undefined;
  const vus = new Map<string, { session?: StressVuSession; busy: boolean; closed: boolean; iterationId: string | null; stageId: string | null; phase: StressIterationContext["phase"]; records: z.infer<typeof StressWorkerLifecycleSchema>[] }>();
  const pending = new Set<Promise<void>>();
  const flush = async () => { while (pending.size) await Promise.all([...pending]); };
  const failMetrics = (reason: StressCompletenessReason) => { reasons.add(reason); abort.abort(); };
  const peer = createStressWorkerPeer(channel, identity, async (command): Promise<unknown> => {
    if (command.type === "stop") { abort.abort(); return { type: "stopping" }; }
    if (command.type === "prepare") {
      if (runtime || abort.signal.aborted) throw new Error("worker-incompatible"); runtime = await prepare(command.configuration, abort.signal);
      generator = runtime.createGeneratorCollector?.() ?? createGeneratorMetricsCollector();
      metrics = createStressAccumulator(runtime.metricPlan, identity.runId, { sourceId: identity.workerId, scope: "observations", reservedNumericBytes: STRESS_WORKER_PENDING_BYTES });
      return { type: "run-ready", workerNow: runtime.clock.now() };
    }
    if (!runtime || !metrics) throw new Error("worker-incompatible");
    if (command.type === "clock") {
      const domain = clockDomain?.(runtime.clock, channel);
      return { workerNow: runtime.clock.now(), ...(domain ? { clockDomain: StressClockDomainSchema.parse(domain) } : {}) };
    }
    if (command.type === "start") {
      if (started) throw new Error("worker-incompatible");
      if (command.clockDomain) {
        const own = clockDomain?.(runtime.clock, channel);
        if (!own || !sameStressClockDomain(StressClockDomainSchema.parse(own), command.clockDomain)) throw new Error("worker-incompatible");
        delta = 0;
      } else delta = command.coordinatorNow - command.workerNow;
      started = true; return { type: "started" };
    }
    if (!started) throw new Error("worker-incompatible");
    if (command.type === "create") {
      if (drained || abort.signal.aborted || vus.has(command.vuId)) throw new Error("worker-incompatible");
      if (runStart !== undefined && runStart !== command.runStart) throw new Error("worker-incompatible");
      runStart ??= command.runStart;
      const vu = { busy: false, closed: false, iterationId: null as string | null, stageId: null as string | null, phase: "vu-setup" as StressIterationContext["phase"], records: [] as z.infer<typeof StressWorkerLifecycleSchema>[] , session: undefined as StressVuSession | undefined };
      vus.set(command.vuId, vu);
      const observation = () => ({ phase: vu.phase, atMs: Math.max(0, runtime!.clock.now() + delta - runStart!) });
      const observe = (event: StressMetricEvent) => {
        const bytes = Buffer.byteLength(JSON.stringify(event));
        if (event.kind === "iteration" || pending.size >= 2048 || pendingBytes + bytes > STRESS_WORKER_PENDING_BYTES) { failMetrics("metrics-budget-exhausted"); return; }
        pendingBytes += bytes;
        let work!: Promise<void>;
        work = peer.request({ type: "phase-at", vuId: command.vuId, iterationId: vu.iterationId, stageId: vu.stageId, atMs: event.atMs }).then((value) => {
          const phase = phaseSchema.parse(value); if (phase.uncertain) reasons.add("timeline-unaligned");
          metrics!.observe({ ...event, phase: phase.phase, atMs: phase.atMs });
        }).catch(() => { failMetrics("snapshot-invalid"); }).finally(() => { pendingBytes -= bytes; pending.delete(work); });
        pending.add(work);
      };
      const gate: StressRequestGate = {
        recordTarget(target) {
          const work = peer.request({ type: "record-target", vuId: command.vuId, target }).then(() => {}).catch(() => { failMetrics("worker-failed"); }); pending.add(work); void work.finally(() => pending.delete(work));
        },
        async enter(request, signal) {
          if (signal.aborted) throw new Error("cancelled");
          const requestId = `${++requestSerial}`;
          const value = z.object({ leaseId: z.string().min(1) }).strict().parse(await peer.request({ type: "request-permit", vuId: command.vuId, iterationId: vu.iterationId, requestId, redirect: false, request: stressWorkerRequest(request) }));
          let released = false;
          return () => { if (released) return; released = true; const work = peer.request({ type: "release", vuId: command.vuId, requestId, leaseId: value.leaseId }).then(() => {}).catch(() => { failMetrics("worker-failed"); }); pending.add(work); void work.finally(() => pending.delete(work)); };
        },
        async beforeRedirect(request, signal) { if (signal.aborted) throw new Error("cancelled"); await peer.request({ type: "request-permit", vuId: command.vuId, iterationId: vu.iterationId, requestId: `${++requestSerial}`, redirect: true, request: stressWorkerRequest(request) }); },
      };
      let mapped = command.inputs;
      try {
        vu.session = await runtime.host.createVu(command.vuId, command.inputs, { runId: identity.runId, vuId: command.vuId, runStart, signal: abort.signal, clock: runtime.clock, gate, observation, observe, lifecycle: runtime.lifecycle,
          reportLifecycle(role, result) {
            if (vu.records.some((record) => record.role === role)) throw new Error("worker-incompatible");
            const outputs: Record<string, JsonValue> = {};
            if (role === "vuSetup") for (const source of Object.keys(runtime!.lifecycle?.vuSetup?.outputs ?? {})) {
              if (Object.hasOwn(result.outputs, source)) outputs[source] = result.outputs[source]!;
            }
            vu.records.push(StressWorkerLifecycleSchema.parse({ role, result: { ...result, outputs } }));
            if (role === "vuSetup" && result.state === "passed") {
              mapped = { ...command.inputs };
              for (const [source, destination] of Object.entries(runtime!.lifecycle?.vuSetup?.outputs ?? {})) {
                if (!Object.hasOwn(result.outputs, source)) throw new Error("setup-failed"); mapped[destination] = result.outputs[source]!;
              }
            }
            return mapped;
          },
        });
        await flush(); return { ok: true, records: vu.records.splice(0), mappedInputs: mapped };
      } catch { await flush(); vu.closed = true; return { ok: false, records: vu.records.splice(0), mappedInputs: mapped }; }
    }
    if (command.type === "execute") {
      const vu = vus.get(command.vuId); if (!vu?.session || vu.busy || vu.closed || drained || abort.signal.aborted) throw new Error("worker-incompatible");
      vu.busy = true; vu.iterationId = command.iterationId; vu.stageId = command.stageId; vu.phase = command.phase;
      try {
        const result = await vu.session.execute({ ...identity, ...command, runId: identity.runId, signal: abort.signal,
          observation: () => ({ phase: vu.phase, atMs: Math.max(0, runtime!.clock.now() + delta - runStart!) }) });
        await flush(); return result;
      } finally { vu.busy = false; vu.iterationId = null; vu.stageId = null; }
    }
    if (command.type === "close") {
      const vu = vus.get(command.vuId); if (!vu || vu.closed || vu.busy) throw new Error("worker-incompatible");
      vu.phase = "vu-teardown";
      try { await vu.session?.close({ reason: command.reason, allowNetworkCleanup: command.allowNetworkCleanup, signal: abort.signal }); }
      finally { vu.closed = true; await flush(); }
      return { records: vu.records.splice(0) };
    }
    if (command.type === "drain") {
      if (drained || [...vus.values()].some((vu) => vu.busy || !vu.closed)) throw new Error("worker-incompatible");
      await flush(); await runtime.host.closeRun?.(); drained = true;
      const snapshot = metrics.snapshot(); return { type: "drained", generator: generator!.stop(), snapshot: { ...snapshot, incompleteReasons: [...new Set([...snapshot.incompleteReasons, ...reasons])] } };
    }
    if (command.type === "marker-ready") { if (!drained || readyMarkers) throw new Error("worker-incompatible"); readyMarkers = true; return { type: "marker-ready", markers: runtime.evidence.markers() }; }
    if (command.type === "marker-union") {
      if (!readyMarkers || unionDone) throw new Error("worker-incompatible"); unionDone = true; runtime.evidence.addMarkers(command.markers);
      return { type: "evidence", samples: runtime.evidence.projectSamples() };
    }
    if (command.type === "shutdown") { if (!unionDone) throw new Error("worker-incompatible"); return { type: "shutdown" }; }
    throw new Error("worker-incompatible");
  }, () => { abort.abort(); generator?.stop(); });
  return peer;
}

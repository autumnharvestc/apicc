import type { StressExecutionDeps, StressFinishContext, StressIterationContext, StressLifecycleResult, StressMetricEvent, StressMetricsSummary, StressStopReason, StressVuSession } from "./execution.js";
import type { StressPhase, StressSchedule } from "./plan.js";
import type { StressCompleteness, StressCompletenessReason, StressLifecycleSummary } from "./reportV2.js";
import { JsonValueSchema, StringRecordSchema, type JsonValue } from "../contract/schemaNode.js";
import { StressMetricsError } from "./metrics.js";
import { arrivalPolicyA, areaAt, type ArrivalSegment as Segment } from "./arrivalPolicy.js";

interface Vu { id: string; session: StressVuSession; busy: boolean; readyAt: number; stage: string | null; reports: Set<string> }
function segments(schedule: StressSchedule): Segment[] {
  const load = schedule.load;
  if (load.kind !== "stages") return [{ id: null, start: 0, end: schedule.durationMs ?? Infinity, from: load.kind === "constant-vus" ? load.vus : load.rate, to: load.kind === "constant-vus" ? load.vus : load.rate, area: 0 }];
  let start = 0, from = load.startTarget, area = 0;
  return load.stages.map((s) => { const value = { id: s.id, start, end: start + s.durationMs, from, to: s.target, area }; area += (from + s.target) / 2 * s.durationMs / 1000; from = s.target; start += s.durationMs; return value; });
}

/** Single coordinator for local sessions and remote VU proxies. No per-slot task queue. */
export async function runStressSchedule(schedule: StressSchedule, deps: StressExecutionDeps): Promise<StressMetricsSummary> {
  const runStart = deps.clock.now(), runWall = deps.clock.wallNow(); let lastNow = runStart;
  const now = () => { const n = deps.clock.now(); if (Number.isFinite(n)) lastNow = Math.max(lastNow, n); return lastNow; };
  const offset = () => Math.max(0, now() - runStart);
  const controller = new AbortController(); let phase: StressPhase = "setup", stopReason: StressStopReason = "duration";
  const vus: Vu[] = [], active = new Set<Promise<void>>(), lifecycle: StressLifecycleSummary[] = [];
  const windows: NonNullable<StressFinishContext["phaseWindows"]>[number][] = [];
  const completeness: StressCompleteness = { execution: { complete: true, reasons: [] }, metrics: { complete: true, reasons: [] }, load: { complete: true, reasons: [] } };
  let measurementStart: number | null = null, launchEnd: number | null = null, measurementEnd: number | null = null;
  let acceptedAbortOffset: number | null = null;
  let planned = 0, started = 0, completed = 0, dropped = 0, iterationNumber = 0, fatal = false;
  let pendingVuSetupStart: number | null = null;
  let measurementDeadline = Infinity;
  const observedDrainStages = new Set<string | null>();
  const measurementCoverageEnds = new Map<string | null, number>();
  let policyWaitBase = 0, policyWaitEnd = 0;
  let wake: (() => void) | undefined;
  const changed = () => wake?.();
  const mark = (part: keyof StressCompleteness, reason: StressCompletenessReason) => { completeness[part].complete = false; if (!completeness[part].reasons.includes(reason)) completeness[part].reasons.push(reason); };
  const fail = (reason: StressCompletenessReason = "execution-failed") => { fatal = true; stopReason = "execution-failed"; mark("execution", reason); controller.abort(); changed(); };
  const observe = (event: StressMetricEvent) => {
    if (event.phase === "drain") observedDrainStages.add(event.stageId);
    try { deps.metrics.observe(event); }
    catch (error) { if (error instanceof StressMetricsError) { mark("metrics", error.code); fail(); } else throw error; }
  };
  const observation = () => { const atMs = offset(); return { phase: phase === "measurement" && (runStart + atMs >= measurementDeadline || acceptedAbortOffset !== null) ? "drain" as const : phase, atMs }; };
  const phaseHistory: { phase: StressPhase; atMs: number }[] = [{ phase: "setup", atMs: 0 }];
  const changePhase = (value: StressPhase) => { phase = value; phaseHistory.push({ phase: value, atMs: offset() }); };
  const observationAt = (atMs: number) => {
    if (!Number.isFinite(atMs) || atMs < 0 || atMs > offset()) throw new StressMetricsError("timeline-unaligned");
    let entry: typeof phaseHistory[number] | undefined;
    for (let i = phaseHistory.length - 1; i >= 0; i--) if (phaseHistory[i]!.atMs <= atMs) { entry = phaseHistory[i]; break; }
    if (!entry) throw new StressMetricsError("phase-window-missing");
    return { atMs, phase: entry.phase === "measurement" && (runStart + atMs >= measurementDeadline || acceptedAbortOffset !== null && atMs >= acceptedAbortOffset) ? "drain" as const : entry.phase };
  };
  let progressState: "preparing" | "ready" | "running" | "stopping" | "finished" = "preparing";
  const notify = (state: typeof progressState, terminal?: StressMetricsSummary) => {
    progressState = state;
    if (!deps.onProgress) return;
    const atMs = offset();
    const stageId = phase === "measurement" && measurementStart !== null && schedule.load.kind === "stages"
      ? (parts.find((part) => atMs - measurementStart! < part.end) ?? parts.at(-1))!.id : null;
    const numbers = deps.metrics.readProgress();
    const source = terminal?.completeness ?? completeness;
    const status: StressCompleteness = { execution: { complete: source.execution.complete, reasons: [...source.execution.reasons] },
      metrics: { complete: source.metrics.complete, reasons: [...source.metrics.reasons] }, load: { complete: source.load.complete, reasons: [...source.load.reasons] } };
    for (const reason of numbers.incompleteReasons) { status.metrics.complete = false; if (!status.metrics.reasons.includes(reason)) status.metrics.reasons.push(reason); }
    deps.onProgress?.({ runId: deps.runId, state, phase, stageId, atMs, activeVus: vus.filter((v) => v.busy).length, startedIterations: started, completedIterations: completed, droppedIterations: dropped,
      requests: terminal ? { ...terminal.requests } : numbers.requests, completeness: status });
  };
  const abort = () => { acceptedAbortOffset ??= offset(); stopReason = "root-abort"; mark("execution", "cancelled"); controller.abort(); changed(); };
  deps.signal.addEventListener("abort", abort, { once: true }); if (deps.signal.aborted) abort();
  const addWindow = (value: NonNullable<StressFinishContext["phaseWindows"]>[number]) => {
    const old = windows.find((w) => w.phase === value.phase && w.stageId === value.stageId);
    if (old) { const index = windows.indexOf(old); windows[index] = { ...old, startOffsetMs: Math.min(old.startOffsetMs, value.startOffsetMs), endOffsetMs: Math.max(old.endOffsetMs, value.endOffsetMs) }; }
    else windows.push(value);
  };
  const wait = async (until = Infinity) => {
    const timerController = new AbortController();
    let resolveChange!: () => void;
    const change = new Promise<void>((resolve) => { resolveChange = resolve; wake = resolve; });
    try {
      if (Number.isFinite(until)) await Promise.race([change, deps.clock.sleep(Math.min(2_147_000_000, Math.max(1, until - now())), timerController.signal)]);
      else await change;
    } finally { if (wake === resolveChange) wake = undefined; timerController.abort(); }
  };
  const mapOutputs = (inputs: Readonly<Record<string, JsonValue>>, mapping: Readonly<Record<string, string>> | undefined, result: StressLifecycleResult) => {
    const next = { ...inputs };
    for (const [source, destination] of Object.entries(mapping ?? {})) { if (!Object.hasOwn(result.outputs, source)) throw new Error("Lifecycle mapped output is missing"); next[destination] = structuredClone(result.outputs[source]!); }
    return next;
  };
  const runLifecycle = async (role: "setup" | "teardown"): Promise<StressLifecycleResult | undefined> => {
    const step = deps.execution?.lifecycle?.[role]; if (!step) return;
    changePhase(role); const begin = offset();
    let result: StressLifecycleResult;
    try { if (!deps.runLifecycle) throw new Error("Lifecycle host is missing"); result = await deps.runLifecycle(role, StringRecordSchema(JsonValueSchema).parse(step.inputs ?? {}), controller.signal,
      { runId: deps.runId, signal: controller.signal, gate: deps.gate, clock: deps.clock, observation, observationAt, observe: (event) => observe({ ...event, stageId: null }) }); }
    catch { result = { state: controller.signal.aborted ? "aborted" : "failed", durationMs: Math.max(0, offset() - begin), outputs: {}, failureKind: "config" }; }
    lifecycle.push({ role, vuId: null, state: result.state, durationMs: result.durationMs, ...(result.failureKind ? { failureKind: result.failureKind } : {}) });
    addWindow({ phase, stageId: null, startOffsetMs: begin, endOffsetMs: offset() });
    if (result.state !== "passed") { mark("execution", role === "setup" ? "setup-failed" : "teardown-failed"); if (role === "setup") { stopReason = "setup-failed"; fatal = true; } }
    return result;
  };
  const launch = (vu: Vu, scheduled: number, stageId: string | null, admissionSignal: AbortSignal) => {
    const began = now(), sourcePhase = phase; vu.busy = true; vu.stage = stageId;
    const iterationId = `${++iterationNumber}`;
    const ctx: StressIterationContext = { runId: deps.runId, vuId: vu.id, iterationId, stageId, phase: sourcePhase, scheduledOffsetMs: scheduled - runStart,
      signal: controller.signal, admissionSignal, observation,
      observe: (event) => observe({ ...event, stageId, vuId: vu.id, iterationId }) };
    if (sourcePhase === "measurement") started++;
    observe({ kind: "iteration", ...observation(), stageId, vuId: vu.id, iterationId, started: 1, passed: 0, failed: 0, aborted: 0, dropped: 0, durationMs: null, startDelayMs: Math.max(0, began - scheduled) });
    let task!: Promise<void>;
    task = (async () => {
      try {
        const result = await vu.session.execute(ctx);
        const state = result.state;
        observe({ kind: "iteration", ...observation(), stageId, vuId: vu.id, iterationId, started: 0, passed: state === "passed" ? 1 : 0, failed: state === "failed" ? 1 : 0, aborted: state === "aborted" ? 1 : 0, dropped: 0, durationMs: result.durationMs, startDelayMs: null });
        if (sourcePhase === "measurement" && state !== "aborted") completed++;
      } catch {
        observe({ kind: "iteration", ...observation(), stageId, vuId: vu.id, iterationId, started: 0, passed: 0, failed: 0, aborted: 1, dropped: 0, durationMs: Math.max(0, now() - began), startDelayMs: null });
        if (!controller.signal.aborted) fail();
      } finally {
        if (sourcePhase === "measurement" && observation().phase === "measurement") measurementCoverageEnds.set(stageId, Math.max(measurementCoverageEnds.get(stageId) ?? 0, offset()));
        vu.readyAt = now() + Math.max(schedule.thinkTimeMs, schedule.pacingMs - (now() - began), 0); vu.busy = false; active.delete(task); changed();
      }
    })();
    active.add(task);
  };
  const parts = segments(schedule), arrival = schedule.load.kind === "constant-arrival" || (schedule.load.kind === "stages" && schedule.load.executor === "arrival");
  const initial = parts[0]!.from;
  const arrivalPolicy = deps.arrivalPolicy ?? arrivalPolicyA;
  const runWindow = async (warmup: boolean) => {
    changePhase(warmup ? "warmup" : "measurement");
    const begin = now(), duration = warmup ? schedule.warmupMs : schedule.durationMs ?? Infinity, end = begin + duration;
    const loadParts = warmup ? [{ id: null, start: 0, end: duration, from: initial, to: initial, area: 0 }] : parts;
    const admissionController = new AbortController();
    const onAbort = () => admissionController.abort(); controller.signal.addEventListener("abort", onAbort, { once: true });
    let slot = 0, budget = warmup ? Infinity : schedule.maxIterations ?? Infinity;
    const dropArrival = (groups: readonly { stageId: string | null; count: number }[], stamp = observation()) => {
      for (const group of groups) {
        if (!warmup) { planned += group.count; dropped += group.count; mark("load", "dropped"); }
        observe({ kind: "iteration", ...stamp, stageId: warmup ? null : group.stageId, started: 0, passed: 0, failed: 0, aborted: 0, dropped: group.count, durationMs: null, startDelayMs: null });
      }
    };
    if (!warmup) { measurementStart = begin - runStart; measurementDeadline = end; policyWaitBase = deps.gate.audit?.().policyLimitedMs ?? 0; }
    // VU cooldown belongs to the session, including across warmup/measurement windows.
    notify("running");
    try {
      while (!controller.signal.aborted && !fatal) {
        const current = now(), elapsed = current - begin;
        if (current >= end || budget <= 0) { if (!warmup) stopReason = budget <= 0 ? "iteration-budget" : "duration"; break; }
        const segment = loadParts.find((s) => elapsed < s.end) ?? loadParts.at(-1)!;
        let next = end;
        if (arrival) {
          const decision = arrivalPolicy({ parts: loadParts, elapsedMs: elapsed, durationMs: duration, cursor: slot, budget });
          budget -= decision.cursor - slot; slot = decision.cursor; dropArrival(decision.dropped);
          if (decision.current) {
            const { dueMs, stageId } = decision.current;
            if (!warmup) planned++;
            const vu = vus.find((v) => !v.busy && v.readyAt <= current);
            if (vu) launch(vu, begin + dueMs, warmup ? null : stageId, admissionController.signal);
            else { if (!warmup) { dropped++; mark("load", "dropped"); mark("load", deps.gate.audit?.().policyWaiting ? "policy-limited" : "resource-saturated"); }
              observe({ kind: "iteration", ...observation(), stageId: warmup ? null : stageId, started: 0, passed: 0, failed: 0, aborted: 0, dropped: 1, durationMs: null, startDelayMs: null }); }
          }
          next = Math.min(end, begin + decision.nextWakeMs);
        } else {
          const fraction = segment.to === segment.from ? 0 : Math.max(0, Math.min(1, (elapsed - segment.start) / (segment.end - segment.start)));
          const target = Math.floor(segment.from + (segment.to - segment.from) * fraction);
          for (let i = 0; i < Math.min(target, vus.length) && budget > 0; i++) {
            const vu = vus[i]!;
            if (!vu.busy && vu.readyAt <= current) { if (!warmup) planned++; budget--; launch(vu, current, warmup ? null : segment.id, admissionController.signal); }
          }
          const ready = vus.slice(0, target).filter((v) => !v.busy).map((v) => v.readyAt);
          if (ready.length) next = Math.min(next, ...ready);
          if (segment.from !== segment.to) {
            const slope = (segment.to - segment.from) / (segment.end - segment.start);
            const crossing = slope > 0 ? segment.start + (target + 1 - segment.from) / slope : segment.start + (segment.from - target + 1) / -slope;
            next = Math.min(next, begin + Math.max(elapsed + .001, crossing));
          }
          next = Math.min(next, begin + segment.end);
        }
        if (budget <= 0) { if (!warmup) stopReason = "iteration-budget"; break; }
        await wait(next);
      }
    } finally { if (now() >= end || controller.signal.aborted) admissionController.abort(); controller.signal.removeEventListener("abort", onAbort); }
    const stoppedAt = Math.min(now(), end, acceptedAbortOffset === null ? Infinity : runStart + acceptedAbortOffset);
    if (arrival && budget > 0 && now() >= end) {
      const tail = arrivalPolicy({ parts: loadParts, elapsedMs: duration, durationMs: duration, cursor: slot, budget });
      dropArrival(tail.dropped, { phase: warmup ? "warmup" : "drain", atMs: stoppedAt - runStart });
    }
    if (warmup) addWindow({ phase: "warmup", stageId: null, startOffsetMs: begin - runStart, endOffsetMs: stoppedAt - runStart });
    else {
      launchEnd = stoppedAt - runStart;
      for (const s of loadParts) if (begin + s.start <= stoppedAt) addWindow({ phase: "measurement", stageId: s.id, startOffsetMs: begin + s.start - runStart,
        endOffsetMs: Math.max(Math.min(stoppedAt, begin + s.end) - runStart, measurementCoverageEnds.get(s.id) ?? 0) });
      changePhase("drain"); notify("stopping");
    }
    const drainStages = new Set([...vus.filter((v) => v.busy).map((v) => v.stage), ...(!warmup ? observedDrainStages : [])]);
    const drainUntil = stoppedAt + schedule.gracefulStopMs;
    while (active.size) {
      if (!controller.signal.aborted && now() >= drainUntil) { mark("execution", warmup ? "warmup-drain-timeout" : "drain-timeout"); stopReason = "drain-timeout"; fatal = true; controller.abort(); }
      await wait(controller.signal.aborted ? Infinity : drainUntil);
    }
    const drainedAt = now();
    admissionController.abort();
    if (warmup) addWindow({ phase: "warmup", stageId: null, startOffsetMs: begin - runStart, endOffsetMs: drainedAt - runStart });
    else { measurementEnd = Math.min(drainedAt - runStart, acceptedAbortOffset ?? Infinity); policyWaitEnd = deps.gate.audit?.().policyLimitedMs ?? 0;
      for (const stageId of drainStages) addWindow({ phase: "drain", stageId, startOffsetMs: stoppedAt - runStart, endOffsetMs: drainedAt - runStart }); }
  };
  // Progress owns one cancellable wait, independent of load/admission wakeups and root abort.
  // Boundary notifications (especially real finished) are not delayed by the regular 4Hz flow.
  const progressStop = new AbortController(); let progressFailure: { error: unknown } | undefined;
  const progressTask = deps.onProgress ? (async () => {
    let deadline = now() + 250;
    try {
      while (!progressStop.signal.aborted) {
        const before = now();
        await deps.clock.sleep(Math.max(1, deadline - before), progressStop.signal);
        if (progressStop.signal.aborted) return;
        const current = now();
        if (current >= deadline) { notify(controller.signal.aborted ? "stopping" : progressState); deadline = current + 250; }
        // A non-advancing injected clock must not become an unbounded microtask loop.
        else if (current <= before) return;
      }
    } catch (error) { if (!progressStop.signal.aborted) { progressFailure = { error }; fail(); } }
  })() : undefined;
  try {
    notify("preparing");
    const setup = !controller.signal.aborted ? await runLifecycle("setup") : undefined;
    let inputs = { ...(deps.execution?.targetInputs ?? {}) };
    if (setup?.state === "passed") inputs = mapOutputs(inputs, deps.execution?.lifecycle?.setup?.outputs, setup);
    if (!deps.execution?.lifecycle?.vuSetup) deps.execution?.validateTargetInputs?.(inputs);
    changePhase("vu-setup"); const vuSetupBegin = offset(); pendingVuSetupStart = vuSetupBegin;
    for (let n = 0; n < schedule.maxVus && !controller.signal.aborted && !fatal; n++) {
      const id = `${n + 1}`, reported = new Set<string>(); let vuInputs: Readonly<Record<string, JsonValue>> = inputs;
      const session = await deps.createVu(id, inputs, { runId: deps.runId, vuId: id, runStart, signal: controller.signal, gate: deps.gate, clock: deps.clock, lifecycle: deps.execution?.lifecycle,
        observation, observationAt, observe: (event) => observe({ ...event, stageId: null, vuId: id }),
        reportLifecycle(role, result) {
          if (reported.has(role)) throw new Error("VU lifecycle reported twice"); reported.add(role);
          lifecycle.push({ role, vuId: id, state: result.state, durationMs: result.durationMs, ...(result.failureKind ? { failureKind: result.failureKind } : {}) });
          if (result.state !== "passed") { mark("execution", role === "vuSetup" ? "vu-setup-failed" : "vu-teardown-failed"); if (role === "vuSetup") { fatal = true; stopReason = "setup-failed"; } }
          if (role === "vuSetup" && result.state === "passed") { vuInputs = mapOutputs(inputs, deps.execution?.lifecycle?.vuSetup?.outputs, result); deps.execution?.validateTargetInputs?.(vuInputs); }
          return vuInputs;
        },
      });
      vus.push({ id, session, busy: false, readyAt: now(), stage: null, reports: reported });
      if (deps.execution?.lifecycle?.vuSetup && !reported.has("vuSetup")) {
        lifecycle.push({ role: "vuSetup", vuId: id, state: "failed", durationMs: 0, failureKind: "config" });
        mark("execution", "vu-setup-failed"); fatal = true; stopReason = "setup-failed";
      }
    }
    addWindow({ phase: "vu-setup", stageId: null, startOffsetMs: vuSetupBegin, endOffsetMs: offset() }); pendingVuSetupStart = null; notify("ready");
    if (!controller.signal.aborted && !fatal && schedule.warmupMs > 0) await runWindow(true);
    if (!controller.signal.aborted && !fatal) await runWindow(false);
  } catch { if (!controller.signal.aborted) { stopReason = measurementStart === null ? "setup-failed" : "execution-failed"; fatal = true; mark("execution", stopReason); controller.abort(); } }
  finally {
    if (pendingVuSetupStart !== null) addWindow({ phase: "vu-setup", stageId: null, startOffsetMs: pendingVuSetupStart, endOffsetMs: offset() });
    // Never advertise finished while an uncooperative execution/close still owns resources.
    while (active.size) await wait();
    changePhase("vu-teardown"); const begin = offset();
    for (const vu of vus) { try { await vu.session.close({ reason: stopReason, signal: controller.signal, allowNetworkCleanup: !controller.signal.aborted && !deps.signal.aborted }); }
      catch { mark("execution", "vu-teardown-failed"); }
      if (deps.execution?.lifecycle?.vuTeardown && !vu.reports.has("vuTeardown")) {
        const skipped = controller.signal.aborted || deps.signal.aborted;
        lifecycle.push({ role: "vuTeardown", vuId: vu.id, state: skipped ? "skipped" : "failed", durationMs: 0, ...(skipped ? {} : { failureKind: "config" as const }) });
        if (!skipped) mark("execution", "vu-teardown-failed");
      }
    }
    addWindow({ phase, stageId: null, startOffsetMs: begin, endOffsetMs: offset() });
    try {
      if (!controller.signal.aborted && !deps.signal.aborted) await runLifecycle("teardown");
    } finally {
      try { await deps.closeRun?.(); } catch { mark("execution", "teardown-failed"); }
      deps.signal.removeEventListener("abort", abort);
      progressStop.abort(); await progressTask;
    }
  }
  if (progressFailure) throw progressFailure.error;
  const audit = deps.gate.audit?.(); if (audit?.incomplete) mark("metrics", "metrics-budget-exhausted");
  const measurementDurationMs = measurementStart === null || launchEnd === null ? 0 : launchEnd - measurementStart;
  const drainDurationMs = launchEnd === null || measurementEnd === null ? 0 : Math.max(0, measurementEnd - launchEnd);
  const cutoff = acceptedAbortOffset;
  const phaseWindows = cutoff === null ? windows : windows.filter((w) => (w.phase !== "measurement" && w.phase !== "drain") || w.startOffsetMs <= cutoff).map((w) =>
    w.phase === "measurement" || w.phase === "drain" ? { ...w, endOffsetMs: Math.min(w.endOffsetMs, cutoff) } : w);
  const result = deps.metrics.finish({ startedAt: measurementStart === null ? runWall : runWall + measurementStart, finishedAt: measurementEnd === null ? runWall + (cutoff ?? offset()) : runWall + measurementEnd,
    measurementStartOffsetMs: measurementStart, measurementEndOffsetMs: measurementEnd, stopReason, plannedIterations: planned, lifecycle, completeness, phaseWindows, thresholds: deps.execution?.thresholds, timelineUncertaintyMs: deps.timelineUncertaintyMs?.(),
    load: { plannedDurationMs: schedule.durationMs, measurementDurationMs, drainDurationMs, policyLimitedMs: Math.max(0, policyWaitEnd - policyWaitBase), saturated: completeness.load.reasons.includes("resource-saturated"), maxVus: schedule.maxVus,
      maxRequestConcurrency: schedule.effective.maxRequestConcurrency, requestedMaxRequestConcurrency: schedule.requested.maxRequestConcurrency, requestedMaxRps: schedule.requested.maxRps, effectiveMaxRps: schedule.effective.maxRps,
      ...(arrival ? { targetArrivalRate: { availability: "available" as const, value: schedule.durationMs ? areaAt(parts, schedule.durationMs) / (schedule.durationMs / 1000) : initial }, actualStartRate: measurementDurationMs > 0 ? { availability: "available" as const, value: started * 1000 / measurementDurationMs } : { availability: "unavailable" as const, reason: "no-data" as const } } : {}) } });
  notify("finished", result); return result;
}

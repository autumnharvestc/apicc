import type { StressClock, StressRequestGate, StressRequestGateOptions } from "./execution.js";
import type { StressSafetyTarget } from "./model.js";

const abortError = () => new DOMException("Aborted", "AbortError");
const checkSignal = (signal: AbortSignal) => { if (signal.aborted) throw abortError(); };
interface Waiter { readonly resolve: () => void; readonly reject: (error: unknown) => void; readonly signal: AbortSignal; readonly abort: () => void }

/** Opaque legacy callbacks use admission without inventing a URL or authorization decision. */
export function createStressAdmission(options: { maxConcurrency: number; maxRps?: number; clock: StressClock }) {
  if (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency < 1) throw new Error("Invalid request concurrency");
  if (options.maxRps !== undefined && (!Number.isFinite(options.maxRps) || options.maxRps <= 0)) throw new Error("Invalid request maxRps");
  let held = 0, waiters = 0, lastClock = -Infinity, limitedMs = 0;
  let policyWaiters = 0, policyWaitStart = 0;
  const queue: Waiter[] = [];
  // Round upward to milliseconds: at most 1001 buckets, conservatively sliding.
  const buckets: { at: number; count: number }[] = [];
  let count = 0, nextAt = -Infinity;
  const now = () => { const n = options.clock.now(); if (Number.isFinite(n)) lastClock = Math.max(lastClock, n); return lastClock === -Infinity ? 0 : lastClock; };
  const policyWait = () => { if (policyWaiters++ === 0) policyWaitStart = now(); let ended = false; return () => { if (!ended) { ended = true; if (--policyWaiters === 0) limitedMs += Math.max(0, now() - policyWaitStart); } }; };
  const reserve = () => { if (waiters >= 32000) throw new Error("Stress request waiter capacity exceeded"); waiters++; };
  const acquireConcurrency = (signal: AbortSignal): Promise<void> => {
    checkSignal(signal);
    if (held < options.maxConcurrency && queue.length === 0) { held++; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const endWait = policyWait();
      const waiter: Waiter = { signal, resolve: () => { signal.removeEventListener("abort", waiter.abort); endWait(); held++; resolve(); }, reject,
        abort: () => { const index = queue.indexOf(waiter); if (index >= 0) queue.splice(index, 1); endWait(); reject(abortError()); } };
      signal.addEventListener("abort", waiter.abort, { once: true }); queue.push(waiter);
    });
  };
  const release = () => { held--; const waiter = queue.shift(); waiter?.resolve(); };
  const rateQueue: Waiter[] = [];
  let rateTimer: AbortController | undefined, timerVersion = 0, rateFailed = false, rateError: unknown;
  const failRate = (error: unknown) => {
    rateFailed = true; rateError = error; timerVersion++; rateTimer?.abort(); rateTimer = undefined;
    for (const waiter of rateQueue.splice(0)) waiter.reject(error);
  };
  const processRate = () => {
    const version = ++timerVersion; rateTimer?.abort(); rateTimer = undefined;
    if (rateFailed) return;
    const rate = options.maxRps!, current = now();
    while (buckets.length && current >= buckets[0]!.at + 1000) count -= buckets.shift()!.count;
    while (rateQueue.length && (rate < 1 ? current >= nextAt : count < Math.floor(rate))) {
      if (rate < 1) nextAt = current + 1000 / rate;
      else { const at = Math.ceil(current), last = buckets.at(-1); if (last?.at === at) last.count++; else buckets.push({ at, count: 1 }); count++; }
      rateQueue.shift()!.resolve();
    }
    if (!rateQueue.length) return;
    const due = rate < 1 ? nextAt : buckets[0]!.at + 1000, timer = new AbortController(); rateTimer = timer;
    options.clock.sleep(Math.min(2_147_000_000, Math.max(1, due - current)), timer.signal).then(() => {
      if (version !== timerVersion) return; rateTimer = undefined; processRate();
    }, (error: unknown) => { if (timer.signal.aborted && error instanceof Error && error.name === "AbortError") return; failRate(error); });
  };
  const beforeHop = (signal: AbortSignal): Promise<void> => {
    checkSignal(signal); if (options.maxRps === undefined) return Promise.resolve();
    if (rateFailed) return Promise.reject(rateError);
    return new Promise<void>((resolve, reject) => {
      let endWait: (() => void) | undefined;
      const cleanup = () => { signal.removeEventListener("abort", waiter.abort); endWait?.(); };
      const waiter: Waiter = { signal, resolve: () => { cleanup(); resolve(); }, reject: (error) => { cleanup(); reject(error); },
        abort: () => { const index = rateQueue.indexOf(waiter); if (index >= 0) rateQueue.splice(index, 1); cleanup(); reject(abortError()); processRate(); } };
      signal.addEventListener("abort", waiter.abort, { once: true }); rateQueue.push(waiter); processRate();
      if (rateQueue.includes(waiter)) endWait = policyWait();
    });
  };
  return {
    async enter(signal: AbortSignal): Promise<() => void> {
      reserve(); let acquired = false;
      try { await acquireConcurrency(signal); acquired = true; await beforeHop(signal); checkSignal(signal); }
      catch (error) { if (acquired) release(); throw error; }
      finally { waiters--; }
      let released = false;
      return () => { if (!released) { released = true; release(); } };
    },
    async beforeHop(signal: AbortSignal) { reserve(); try { await beforeHop(signal); } finally { waiters--; } },
    policyLimitedMs: () => limitedMs + (policyWaiters ? Math.max(0, now() - policyWaitStart) : 0),
    policyWaiting: () => policyWaiters > 0,
  };
}

/** Origin evidence is bounded independently of the numeric metrics stream. */
export function createStressOriginAudit() {
  const origins = new Map<string, StressSafetyTarget | null>(), sizes = new Map<string, number>(); let bytes = 0, incomplete = false;
  const record = (origin: string, target: StressSafetyTarget | null) => {
    if (origins.has(origin) && !target) return;
    const size = Buffer.byteLength(JSON.stringify(target ?? origin));
    const oldSize = sizes.get(origin) ?? 0;
    const strings = target ? [origin, target.confirmation, target.policy, ...(target.appliedPolicy?.trustedOrigins ?? []), ...(target.appliedPolicy?.deniedOrigins ?? [])] : [origin];
    if ((!origins.has(origin) && origins.size >= 256) || strings.some((value) => Buffer.byteLength(value) > 4096) || size > 262144 || bytes - oldSize + size > 16777216) { incomplete = true; return; }
    bytes += size - oldSize; sizes.set(origin, size); origins.set(origin, target ? structuredClone(target) : null);
  };
  return { recordOrigin: (origin: string) => record(origin, null), recordTarget: (target: StressSafetyTarget) => record(target.origin, target),
    snapshot: () => ({ targetOrigins: [...origins.values()].filter((target): target is StressSafetyTarget => target !== null), incomplete }) };
}

export function createStressRequestGate(options: StressRequestGateOptions): StressRequestGate {
  return createStressRequestGateWithAdmission(options).gate;
}

/** Internal legacy wiring: both real hops and opaque callbacks spend one shared budget. */
export function createStressRequestGateWithAdmission(options: StressRequestGateOptions) {
  const admission = createStressAdmission(options), audit = createStressOriginAudit();
  let waiting = 0;
  const reserve = () => { if (waiting >= 32000) throw new Error("Stress request waiter capacity exceeded"); waiting++; };
  const authorize = async (request: Parameters<StressRequestGate["enter"]>[0], signal: AbortSignal) => {
    checkSignal(signal);
    try { audit.recordOrigin(new URL(request.url).origin); } catch { /* authorization retains its original URL/protocol semantics */ }
    await options.authorizeRequest(request); checkSignal(signal);
  };
  const gate: StressRequestGate = {
    async enter(request, signal) { reserve(); try { await authorize(request, signal); return await admission.enter(signal); } finally { waiting--; } },
    async beforeRedirect(request, signal) { reserve(); try { await authorize(request, signal); await admission.beforeHop(signal); } finally { waiting--; } },
    recordTarget: audit.recordTarget,
    audit: () => ({ ...audit.snapshot(), policyLimitedMs: admission.policyLimitedMs(), policyWaiting: admission.policyWaiting() }),
  };
  return { gate, admission };
}

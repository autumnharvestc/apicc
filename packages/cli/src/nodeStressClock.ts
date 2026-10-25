import { hrtime, platform } from "node:process";
import type { StressClock, StressClockDomain } from "@apicc/core";

const nativeNow = hrtime.bigint.bind(hrtime);
const dayNs = 86_400_000_000_000n;
// Adjacent process starts normally select the same system-clock day. A boundary mismatch
// is negotiated as an unknown domain, rather than silently changing either process's basis.
const basis = nativeNow() / dayNs * dayNs;
const maxExactNs = BigInt(Number.MAX_SAFE_INTEGER);
const conversionBoundMs = Number.EPSILON * Number.MAX_SAFE_INTEGER / 1_000_000;

export const localStressClock: StressClock = Object.freeze({
  now() {
    const elapsed = nativeNow() - basis;
    // Keep BigInt subtraction and exact integer conversion before the sole rounded division.
    // This range is over 104 days from the fixed basis; fail rather than understate its bound.
    if (elapsed < 0n || elapsed > maxExactNs) throw new Error("Native stress clock coordinate range exceeded");
    return Number(elapsed) / 1_000_000;
  },
  wallNow: () => Date.now(),
  sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
      const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, Math.min(2147000000, Math.max(1, ms)));
      signal?.addEventListener("abort", abort, { once: true });
    });
  },
});

/** Identity mapping of Node's system sampling coordinate, not physical-time accuracy.
 * The ns output granularity and Number conversion stay in the bound. Hardware resolution,
 * including Windows QPC's possible cross-thread ±1 tick, is not measured or promised here.
 */
export function nativeStressClockDomain(clock: StressClock): StressClockDomain | undefined {
  if (clock !== localStressClock || !["win32", "linux"].includes(platform)) return;
  return { id: `node-hrtime-${platform}-v1`, basis: String(basis), precision: "integer-ns-to-ms-v1",
    resolutionMs: .000001, uncertaintyMs: .000001 + conversionBoundMs };
}

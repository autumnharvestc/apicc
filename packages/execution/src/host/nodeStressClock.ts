import { hrtime, platform } from "node:process";
import type { StressClock, StressClockDomain } from "@apicc/core";

const nativeNow = hrtime.bigint.bind(hrtime);
const dayNs = 86_400_000_000_000n;
const basis = nativeNow() / dayNs * dayNs;
const maxExactNs = BigInt(Number.MAX_SAFE_INTEGER);
const conversionBoundMs = Number.EPSILON * Number.MAX_SAFE_INTEGER / 1_000_000;
export const localStressClock: StressClock = Object.freeze({
  now() {
    const elapsed = nativeNow() - basis;
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
/** System sampling coordinates only; hardware/physical accuracy is not promised. */
export function nativeStressClockDomain(clock: StressClock): StressClockDomain | undefined {
  if (clock !== localStressClock || !["win32", "linux"].includes(platform)) return;
  return { id: `node-hrtime-${platform}-v1`, basis: String(basis), precision: "integer-ns-to-ms-v1",
    resolutionMs: .000001, uncertaintyMs: .000001 + conversionBoundMs };
}

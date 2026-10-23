import type { StressHistogramSnapshot } from "./execution.js";
import type { StressStatistics } from "./model.js";
import type { StressLatencyMetric } from "./reportV2.js";

const MIN = 0.001, GAMMA = 1.01, BINS = 4608, EXACT = 256;
const LOG = Math.log(GAMMA), CEILING = MIN * GAMMA ** BINS;
export type StressLatencyValues = Extract<StressLatencyMetric, { availability: "available" }>["value"];
export const emptyLatency = (): StressLatencyValues => ({ min: 0, avg: 0, max: 0, p50: 0, p90: 0, p95: 0, p99: 0 });

/** Conservative report-wide precision. Under/overflow are the maximum count in
 * any one statistical series, not request counts or a union across series. */
export function summarizeStressHistogramStatistics(histograms: Iterable<StressHistogram>): StressStatistics {
  let exact = true, underflow = 0, overflow = 0;
  for (const h of histograms) { const s = h.statistics(); exact &&= s.exact; underflow = Math.max(underflow, s.underflow); overflow = Math.max(overflow, s.overflow); }
  return { method: exact ? "exact-nearest-rank" : "log-histogram", exact, relativeError: exact ? 0 : .01, minValueMs: MIN, gamma: GAMMA, bucketCount: BINS, exactLimit: EXACT, underflow, overflow };
}

/** Fixed log distribution. Only the first 256 numeric observations can remain exact. */
export class StressHistogram {
  private count = 0; private sum = 0; private min: number | null = null; private max: number | null = null;
  private zero = 0; private underflow = 0; private overflow = 0;
  private exact: number[] | null = []; private bins: Float64Array | null = null;
  get numericBytes(): number { return 8 * (8 + (this.exact?.length ?? 0) + (this.bins?.length ?? 0)); }
  private bin(value: number): void {
    if (value < MIN || value >= CEILING) return;
    let index = Math.min(BINS - 1, Math.max(0, Math.floor(Math.log(value / MIN) / LOG)));
    while (index < BINS - 1 && MIN * GAMMA ** (index + 1) < value) index++;
    this.bins![index]++;
  }
  private approximate(): void {
    if (this.exact === null) return;
    this.bins = new Float64Array(BINS);
    for (const value of this.exact) this.bin(value);
    this.exact = null;
  }
  add(value: number): void {
    if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(this.count + 1) || !Number.isFinite(this.sum + value)) throw new Error("Invalid stress histogram observation");
    this.count++; this.sum += value; this.min = this.min === null ? value : Math.min(this.min, value); this.max = this.max === null ? value : Math.max(this.max, value);
    if (value === 0) this.zero++; else if (value < MIN) this.underflow++; else if (value >= CEILING) this.overflow++;
    if (this.exact !== null && this.count <= EXACT) this.exact.push(value);
    else { this.approximate(); this.bin(value); }
  }
  snapshot(): StressHistogramSnapshot {
    return { count: this.count, sum: this.sum, min: this.min, max: this.max, zero: this.zero, underflow: this.underflow, overflow: this.overflow,
      exact: this.exact && [...this.exact], buckets: this.bins ? Array.from(this.bins) : [] };
  }
  static valid(s: StressHistogramSnapshot): boolean {
    if (!s || ![s.count, s.zero, s.underflow, s.overflow, ...s.buckets].every((n) => Number.isSafeInteger(n) && n >= 0) || !Number.isFinite(s.sum) || s.sum < 0) return false;
    if (s.count === 0) return s.sum === 0 && s.min === null && s.max === null && s.zero === 0 && s.underflow === 0 && s.overflow === 0 && s.exact?.length === 0 && s.buckets.length === 0;
    if (s.min === null || s.max === null || !Number.isFinite(s.min) || !Number.isFinite(s.max) || s.min < 0 || s.max < s.min) return false;
    if (s.exact !== null) {
      if (s.count > EXACT || s.exact.length !== s.count || s.buckets.length !== 0 || s.exact.some((n) => !Number.isFinite(n) || n < 0)) return false;
      const check = new StressHistogram(); s.exact.forEach((n) => check.add(n));
      const actual = check.snapshot();
      return actual.min === s.min && actual.max === s.max && Math.abs(actual.sum - s.sum) <= Math.max(1, s.sum) * 1e-12 && actual.zero === s.zero && actual.underflow === s.underflow && actual.overflow === s.overflow;
    }
    if (s.count <= EXACT || s.buckets.length !== BINS || s.zero + s.underflow + s.overflow + s.buckets.reduce((a, b) => a + b, 0) !== s.count) return false;
    const min = s.min, max = s.max, avg = s.sum / s.count;
    // Compare means rather than count*extrema, which can overflow for finite inputs.
    // Relative tolerance covers different legal grouping/summation orders without
    // an absolute 1ms floor that would hide corruption in sub-millisecond series.
    const below = (a: number, b: number, tolerance = 1e-12) => a < b && b - a > Math.max(Math.abs(a), Math.abs(b), Number.MIN_VALUE) * tolerance;
    // Both extrema were actually observed, so each contributes at least once.
    const minimumMean = min * (1 - 1 / s.count) + max / s.count;
    const maximumMean = max * (1 - 1 / s.count) + min / s.count;
    if (below(avg, minimumMean, 1e-9) || below(maximumMean, avg, 1e-9) || (min === 0) !== (s.zero > 0) || (max === 0 && s.zero !== s.count)
      || (s.underflow > 0 && min >= MIN) || (min > 0 && min < MIN && s.underflow === 0)
      || (max >= CEILING) !== (s.overflow > 0) || (min >= CEILING && s.overflow !== s.count)) return false;
    let lowerMean = s.underflow / s.count * min + s.overflow / s.count * Math.max(min, CEILING);
    let upperMean = s.underflow / s.count * Math.min(max, MIN) + s.overflow / s.count * max;
    let first = -1, last = -1;
    for (let i = 0; i < BINS; i++) {
      const n = s.buckets[i]; if (!n) continue;
      if (first === -1) first = i; last = i;
      const lower = Math.max(min, MIN * GAMMA ** i), upper = Math.min(max, MIN * GAMMA ** (i + 1));
      if (below(upper, lower)) return false;
      lowerMean += n / s.count * lower; upperMean += n / s.count * upper;
    }
    if (s.zero === 0 && s.underflow === 0 && min < CEILING && (first < 0 || below(min, MIN * GAMMA ** first) || below(MIN * GAMMA ** (first + 1), min))) return false;
    if (s.overflow === 0 && max >= MIN && (last < 0 || below(max, MIN * GAMMA ** last) || below(MIN * GAMMA ** (last + 1), max))) return false;
    return !below(avg, lowerMean, 1e-9) && !below(upperMean, avg, 1e-9);
  }
  merge(s: StressHistogramSnapshot): void {
    if (!StressHistogram.valid(s) || !Number.isSafeInteger(this.count + s.count) || !Number.isFinite(this.sum + s.sum)) throw new Error("Invalid stress histogram snapshot");
    if (s.count === 0) return;
    if (this.exact !== null && s.exact !== null && this.count + s.count <= EXACT) { s.exact.forEach((n) => this.add(n)); return; }
    this.approximate();
    if (s.exact !== null) s.exact.forEach((n) => this.bin(n)); else s.buckets.forEach((n, i) => { this.bins![i] += n; });
    this.count += s.count; this.sum += s.sum; this.min = this.min === null ? s.min : Math.min(this.min, s.min!); this.max = this.max === null ? s.max : Math.max(this.max, s.max!);
    this.zero += s.zero; this.underflow += s.underflow; this.overflow += s.overflow;
  }
  statistics(): StressStatistics {
    return { method: this.exact !== null ? "exact-nearest-rank" : "log-histogram", exact: this.exact !== null,
      relativeError: this.exact !== null ? 0 : 0.01, minValueMs: MIN, gamma: GAMMA, bucketCount: BINS, exactLimit: EXACT, underflow: this.underflow, overflow: this.overflow };
  }
  values(): StressLatencyValues {
    if (!this.count) return emptyLatency();
    const sorted = this.exact && [...this.exact].sort((a, b) => a - b);
    const quantile = (p: number): number => {
      const rank = Math.ceil(p * this.count);
      if (sorted) return sorted[rank - 1]!;
      let seen = this.zero;
      if (rank <= seen) return 0;
      seen += this.underflow;
      if (rank <= seen) return Math.min(MIN, this.max!);
      for (let i = 0; i < BINS; i++) { seen += this.bins![i]; if (rank <= seen) return Math.min(MIN * GAMMA ** (i + 1), this.max!); }
      return this.max!;
    };
    return { min: this.min!, avg: this.sum / this.count, max: this.max!, p50: quantile(.5), p90: quantile(.9), p95: quantile(.95), p99: quantile(.99) };
  }
  metric(): StressLatencyMetric {
    if (!this.count) return { availability: "unavailable", reason: "no-data" };
    if (this.overflow) return { availability: "unavailable", reason: "overflow" };
    return { availability: "available", value: this.values() };
  }
}

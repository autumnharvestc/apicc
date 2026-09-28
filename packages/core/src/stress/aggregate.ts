import { STRESS_FAILURE_KINDS, type StressFailureCounts, type StressMeasurementWindow, type StressReport, type StressSafetyRun, type StressSample, type StressThresholds } from "./model.js";
import { evaluateStressThresholds } from "./thresholds.js";

export interface ComputeReportOptions {
  concurrency: number;
  startedAt: number;
  finishedAt: number;
  thresholds?: StressThresholds;
  connectionMode?: "pooled" | "fresh";
  measurementWindow?: StressMeasurementWindow;
  safetyRun?: Partial<StressSafetyRun>;
}

/** nearest-rank 分位：sorted 为升序数组，取第 ceil(p/100*n) 个（1-based）；空数组返回 0。 */
function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function bump(dist: Record<string, number>, key: string): void {
  dist[key] = (dist[key] ?? 0) + 1;
}

function latency(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((total, value) => total + value, 0);
  return {
    min: sorted.length > 0 ? sorted[0]! : 0,
    avg: values.length > 0 ? sum / values.length : 0,
    max: sorted.length > 0 ? sorted[sorted.length - 1]! : 0,
    p50: quantile(sorted, 50), p90: quantile(sorted, 90), p95: quantile(sorted, 95), p99: quantile(sorted, 99),
  };
}

function freshFailureCounts(): StressFailureCounts {
  return Object.fromEntries(STRESS_FAILURE_KINDS.map((kind) => [kind, 0])) as StressFailureCounts;
}

function effectiveRequestTime(sample: StressSample): number {
  return sample.requestTimeMs ?? sample.timeMs ?? 0;
}

export function isEligibleCompletedAttempt(sample: StressSample): boolean {
  // Legacy reports omit both flags and represent completed request samples.
  // Once either v2 flag is present, both must explicitly qualify the attempt.
  const legacyCompleted = sample.requestStarted === undefined && sample.requestCompleted === undefined;
  return (legacyCompleted || (sample.requestStarted === true && sample.requestCompleted === true))
    && sample.failureKind !== "aborted";
}

function normalizeMeasurementWindow(opts: ComputeReportOptions, eligibleCompletedAttempts: number): StressMeasurementWindow {
  const supplied = opts.measurementWindow;
  if (supplied) return { ...supplied, eligibleCompletedAttempts };
  const durationMs = Math.max(0, opts.finishedAt - opts.startedAt);
  return {
    startWallMs: opts.startedAt,
    endWallMs: opts.finishedAt,
    monotonicDurationMs: durationMs,
    eligibleCompletedAttempts,
  };
}

export function measurementWindowDurationMs(window: StressMeasurementWindow): number {
  // The worker's monotonic clock is the pressure duration. Wall timestamps
  // remain available for cross-process ordering, and are only a compatibility
  // fallback for legacy/synthetic windows that have no monotonic duration.
  if (window.monotonicDurationMs > 0) return window.monotonicDurationMs;
  return window.endWallMs >= window.startWallMs ? window.endWallMs - window.startWallMs : 0;
}

/** 聚合采样为报告：计数/RPS/时长、nearest-rank 分位、状态分布与错误分类计数；空样本全 0。 */
export function computeReport(samples: StressSample[], opts: ComputeReportOptions): StressReport {
  const totalRequests = samples.length;
  let ok = 0;
  const statusDist: Record<string, number> = {};
  const errorKinds: Record<string, number> = {};
  const failures = freshFailureCounts();
  const eligibleFailureCounts = freshFailureCounts();
  const requestTimes: number[] = [];
  const scriptTimes: number[] = [];
  const iterationTimes: number[] = [];
  let completedAttempts = 0;

  for (const s of samples) {
    const requestTimeMs = effectiveRequestTime(s);
    const scriptTimeMs = s.scriptTimeMs ?? 0;
    const iterationTimeMs = s.iterationTimeMs ?? requestTimeMs + scriptTimeMs;
    if (isEligibleCompletedAttempt(s)) requestTimes.push(requestTimeMs);
    scriptTimes.push(scriptTimeMs);
    iterationTimes.push(iterationTimeMs);
    if (isEligibleCompletedAttempt(s)) completedAttempts += 1;
    if (s.ok) ok += 1;
    if (s.status !== 0 && isEligibleCompletedAttempt(s)) bump(statusDist, String(s.status));
    const failureKind = s.failureKind
      ?? (s.status >= 400 ? "http" : (!s.ok && s.error ? "transport" : undefined));
    if (failureKind) failures[failureKind] += 1;
    if (failureKind && isEligibleCompletedAttempt(s)) eligibleFailureCounts[failureKind] += 1;
    if (s.error) {
      // 网络错误：取 error 首个冒号前 token（如 ECONNREFUSED），空则记 unknown。
      if (s.failureKind === "http" && s.status !== 0) bump(errorKinds, `HTTP_${s.status}`);
      else if (s.failureKind) bump(errorKinds, s.failureKind);
      else {
        const token = s.error.split(":", 1)[0].trim() || "unknown";
        bump(errorKinds, token);
      }
    } else {
      if (s.status !== 101 && (s.status < 200 || s.status >= 300)) bump(errorKinds, `HTTP_${s.status}`); // 101=WS 握手成功（M5 D3），非错误
    }
  }

  const measurementWindow = normalizeMeasurementWindow(opts, completedAttempts);
  const durationMs = measurementWindowDurationMs(measurementWindow);
  const report: StressReport = {
    concurrency: opts.concurrency,
    totalRequests,
    ok,
    failed: totalRequests - ok,
    durationMs,
    // RPS is measured over the execution window, excluding pre-I/O failures and aborted attempts.
    rps: measurementWindow.monotonicDurationMs > 0
      ? completedAttempts / (measurementWindow.monotonicDurationMs / 1000)
      : durationMs > 0 ? completedAttempts / (durationMs / 1000) : 0,
    latency: {
      ...latency(requestTimes),
    },
    statusDist,
    errorKinds,
    startedAt: opts.startedAt,
    finishedAt: opts.finishedAt,
    eligibleCompletedAttempts: completedAttempts,
    eligibleFailureCounts,
    measurementWindow,
    failures,
    scriptLatency: latency(scriptTimes),
    iterationLatency: latency(iterationTimes),
    incomplete: failures.aborted > 0,
    thresholds: opts.thresholds,
    connectionMode: opts.connectionMode,
  };
  report.startedAt = measurementWindow.startWallMs;
  report.finishedAt = measurementWindow.endWallMs;
  report.verdict = evaluateStressThresholds(report, opts.thresholds);
  return report;
}

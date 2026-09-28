import { STRESS_FAILURE_KINDS, type StressFailureCounts, type StressReport, type StressSample, type StressThresholds } from "./model.js";
import { evaluateStressThresholds } from "./thresholds.js";

export interface ComputeReportOptions {
  concurrency: number;
  startedAt: number;
  finishedAt: number;
  thresholds?: StressThresholds;
  connectionMode?: "pooled" | "fresh";
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

function requestWasStarted(sample: StressSample): boolean {
  // Legacy reports have no flag and represent completed request samples.
  return sample.requestStarted ?? true;
}

function requestAttemptCompleted(sample: StressSample): boolean {
  return requestWasStarted(sample) && (sample.requestCompleted ?? true) && sample.failureKind !== "aborted";
}

/** 聚合采样为报告：计数/RPS/时长、nearest-rank 分位、状态分布与错误分类计数；空样本全 0。 */
export function computeReport(samples: StressSample[], opts: ComputeReportOptions): StressReport {
  const durationMs = Math.max(0, opts.finishedAt - opts.startedAt);
  const totalRequests = samples.length;
  let ok = 0;
  const statusDist: Record<string, number> = {};
  const errorKinds: Record<string, number> = {};
  const failures = freshFailureCounts();
  const requestTimes: number[] = [];
  const scriptTimes: number[] = [];
  const iterationTimes: number[] = [];
  let completedAttempts = 0;

  for (const s of samples) {
    const requestTimeMs = effectiveRequestTime(s);
    const scriptTimeMs = s.scriptTimeMs ?? 0;
    const iterationTimeMs = s.iterationTimeMs ?? requestTimeMs + scriptTimeMs;
    if (requestWasStarted(s)) requestTimes.push(requestTimeMs);
    scriptTimes.push(scriptTimeMs);
    iterationTimes.push(iterationTimeMs);
    if (requestAttemptCompleted(s)) completedAttempts += 1;
    if (s.ok) ok += 1;
    if (s.status !== 0 && (!s.error || s.failureKind === "http" || s.failureKind === "assertion")) bump(statusDist, String(s.status));
    const failureKind = s.failureKind
      ?? (s.status >= 400 ? "http" : (!s.ok && s.error ? "transport" : undefined));
    if (failureKind) failures[failureKind] += 1;
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

  const report: StressReport = {
    concurrency: opts.concurrency,
    totalRequests,
    ok,
    failed: totalRequests - ok,
    durationMs,
    // RPS is measured over the execution window, excluding pre-I/O failures and aborted attempts.
    rps: durationMs > 0 ? completedAttempts / (durationMs / 1000) : 0,
    latency: {
      ...latency(requestTimes),
    },
    statusDist,
    errorKinds,
    startedAt: opts.startedAt,
    finishedAt: opts.finishedAt,
    failures,
    scriptLatency: latency(scriptTimes),
    iterationLatency: latency(iterationTimes),
    incomplete: failures.aborted > 0,
    thresholds: opts.thresholds,
    connectionMode: opts.connectionMode,
  };
  report.verdict = evaluateStressThresholds(report, opts.thresholds);
  return report;
}

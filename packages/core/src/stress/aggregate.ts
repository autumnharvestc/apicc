import type { StressReport, StressSample } from "./model.js";

export interface ComputeReportOptions {
  concurrency: number;
  startedAt: number;
  finishedAt: number;
}

/** nearest-rank 分位：sorted 为升序数组，取第 ceil(p/100*n) 个（1-based）；空数组返回 0。 */
function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function bump(dist: Record<string, number>, key: string): void {
  dist[key] = (dist[key] ?? 0) + 1;
}

/** 聚合采样为报告：计数/RPS/时长、nearest-rank 分位、状态分布与错误分类计数；空样本全 0。 */
export function computeReport(samples: StressSample[], opts: ComputeReportOptions): StressReport {
  const durationMs = Math.max(0, opts.finishedAt - opts.startedAt);
  const totalRequests = samples.length;
  let ok = 0;
  let sum = 0;
  const statusDist: Record<string, number> = {};
  const errorKinds: Record<string, number> = {};

  for (const s of samples) {
    sum += s.timeMs;
    if (s.ok) ok += 1;
    if (s.error) {
      // 网络错误：取 error 首个冒号前 token（如 ECONNREFUSED），空则记 unknown。
      const token = s.error.split(":", 1)[0].trim() || "unknown";
      bump(errorKinds, token);
    } else {
      bump(statusDist, String(s.status));
      if (s.status < 200 || s.status >= 300) bump(errorKinds, `HTTP_${s.status}`);
    }
  }

  const sorted = samples.map((s) => s.timeMs).sort((a, b) => a - b);
  const avg = totalRequests === 0 ? 0 : sum / totalRequests;

  return {
    concurrency: opts.concurrency,
    totalRequests,
    ok,
    failed: totalRequests - ok,
    durationMs,
    rps: durationMs > 0 ? totalRequests / (durationMs / 1000) : 0,
    latency: {
      min: sorted.length > 0 ? sorted[0] : 0,
      avg,
      max: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
      p50: quantile(sorted, 50),
      p90: quantile(sorted, 90),
      p95: quantile(sorted, 95),
      p99: quantile(sorted, 99),
    },
    statusDist,
    errorKinds,
    startedAt: opts.startedAt,
    finishedAt: opts.finishedAt,
  };
}

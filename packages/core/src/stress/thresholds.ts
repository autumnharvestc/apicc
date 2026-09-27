import type { StressFailureCounts, StressReport, StressThresholds, StressVerdict, StressViolation } from "./model.js";

const completedCount = (report: StressReport): number =>
  Math.max(0, report.totalRequests - (report.failures?.aborted ?? 0));

const failureCounts = (report: StressReport): StressFailureCounts => report.failures ?? {
  transport: 0, http: 0, script: 0, assertion: 0, config: 0, aborted: 0,
};

/** Evaluate performance and business-result thresholds without mutating the report. */
export function evaluateStressThresholds(report: StressReport, thresholds: StressThresholds = {}): StressVerdict {
  const failures = failureCounts(report);
  const denominator = completedCount(report);
  const businessFailures = Math.max(0, report.failed - failures.aborted);
  const errorRate = denominator === 0 ? 0 : businessFailures / denominator;
  const assertionFailureRate = denominator === 0 ? 0 : failures.assertion / denominator;
  const violations: StressViolation[] = [];

  if (thresholds.maxErrorRate !== undefined && errorRate > thresholds.maxErrorRate) {
    violations.push({ metric: "errorRate", actual: errorRate, expected: thresholds.maxErrorRate, message: `error rate ${errorRate} exceeds ${thresholds.maxErrorRate}` });
  }
  if (thresholds.maxAssertionFailureRate !== undefined && assertionFailureRate > thresholds.maxAssertionFailureRate) {
    violations.push({ metric: "assertionFailureRate", actual: assertionFailureRate, expected: thresholds.maxAssertionFailureRate, message: `assertion failure rate ${assertionFailureRate} exceeds ${thresholds.maxAssertionFailureRate}` });
  }
  if (thresholds.maxP95Ms !== undefined && report.latency.p95 > thresholds.maxP95Ms) {
    violations.push({ metric: "p95", actual: report.latency.p95, expected: thresholds.maxP95Ms, message: `p95 ${report.latency.p95}ms exceeds ${thresholds.maxP95Ms}ms` });
  }
  if (thresholds.minRps !== undefined && report.rps < thresholds.minRps) {
    violations.push({ metric: "rps", actual: report.rps, expected: thresholds.minRps, message: `rps ${report.rps} is below ${thresholds.minRps}` });
  }
  if (businessFailures > 0 && Object.values(thresholds).every((value) => value === undefined)) {
    violations.push({ metric: "businessFailures", actual: businessFailures, expected: 0, message: `${businessFailures} business request(s) failed` });
  }

  return { passed: violations.length === 0, violations };
}

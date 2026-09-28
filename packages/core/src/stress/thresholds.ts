import type { StressFailureCounts, StressReport, StressThresholds, StressVerdict, StressViolation } from "./model.js";

const completedCount = (report: StressReport): number =>
  Math.max(0, report.eligibleCompletedAttempts ?? (report.totalRequests - (report.failures?.aborted ?? 0)));

const failureCounts = (report: StressReport): StressFailureCounts => report.failures ?? {
  transport: 0, http: 0, script: 0, assertion: 0, config: 0, aborted: 0,
};

const eligibleFailureCounts = (report: StressReport): StressFailureCounts => report.eligibleFailureCounts ?? failureCounts(report);

/** Evaluate performance and business-result thresholds without mutating the report. */
export function evaluateStressThresholds(report: StressReport, thresholds: StressThresholds = {}): StressVerdict {
  const failures = failureCounts(report);
  const eligibleFailures = eligibleFailureCounts(report);
  const denominator = completedCount(report);
  const eligibleBusinessFailures = eligibleFailures.transport + eligibleFailures.http + eligibleFailures.script + eligibleFailures.assertion + eligibleFailures.config;
  // A current report carries the exact eligible failure counts. Legacy
  // reports fall back to their historical failure/aborted approximation.
  const businessFailures = report.eligibleFailureCounts
    ? eligibleBusinessFailures
    : Math.max(0, report.failed - failures.aborted);
  const errorRate = denominator === 0 ? 0 : businessFailures / denominator;
  const assertionFailureRate = denominator === 0 ? 0 : (report.eligibleFailureCounts ? eligibleFailures.assertion : failures.assertion) / denominator;
  const violations: StressViolation[] = [];

  if (denominator === 0) {
    violations.push({ metric: "noData", actual: 0, expected: 1, message: "NO_DATA: 没有可评估的压测样本" });
  }

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
  // Performance thresholds are orthogonal to business correctness. A failure
  // is governed only when an applicable failure-rate threshold exists: the
  // global error rate governs every non-aborted failure, while assertion rate
  // governs assertion failures only. Any remaining failure keeps the verdict
  // failed even when p95/minRps happen to pass.
  const governedFailures = thresholds.maxErrorRate !== undefined
    ? businessFailures
    : thresholds.maxAssertionFailureRate !== undefined ? (report.eligibleFailureCounts ? eligibleFailures.assertion : failures.assertion) : 0;
  if (businessFailures > governedFailures) {
    violations.push({ metric: "businessFailures", actual: businessFailures, expected: 0, message: `${businessFailures} business request(s) failed` });
  }

  return { passed: violations.length === 0, violations };
}

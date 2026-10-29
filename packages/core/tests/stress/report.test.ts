import { describe, expect, it } from "vitest";
import { computeReport } from "../../src/stress/aggregate.js";
import { stressReportFixture as report } from '../helpers/stressReport.js';
import { StressReportV2Schema, parseStressReport } from "../../src/stress/reportV2.js";
import { compareStressReports } from "../../src/stress/compare.js";
import { renderStressHtml } from "../../src/stress/html.js";

describe("stress comparison and offline report", () => {
  it('T7 exports typed execution facts and an outer comparison warning without hiding Core deltas', () => {
    const base=report(),candidate=report();candidate.requests.failed=1;candidate.completeness.metrics={complete:false,reasons:['worker-missing']};candidate.verdict={status:'incomplete',passed:false,violations:[]};StressReportV2Schema.parse(candidate);
    const comparison=compareStressReports(base,candidate);
    expect(comparison.metrics.dropped.relative).toBeNull();expect(comparison.notices).toContain('environment-definition-not-compared');
    const html=renderStressHtml(candidate,comparison,{execution:{location:'local',executorId:'local',executorName:'Long <script>unsafe</script>',workerCount:1,processBudget:1,runtime:{coreBuildId:'a'.repeat(64),scriptApiId:'b'.repeat(64),nodeVersion:'22.19.0',v8Version:'12.4',runtimeCompatibilityId:'compatible'},limits:{maxVus:1,requestConcurrency:1,maxRps:null}},comparison:{directlyComparable:false,reasons:['location']}});
    const execution=html.match(/<section[^>]*data-section="execution"[\s\S]*?<\/section>/)?.[0];
    expect.soft(execution).toContain('执行进程预算');expect.soft(execution).toContain('Execution process budget');
    expect.soft(execution).toContain('未采集实际进程数');expect.soft(execution).toContain('No request RPS limit');
    expect.soft(execution).toContain('Long &lt;script&gt;unsafe&lt;/script&gt;');expect.soft(execution).not.toContain('<pre>');
    const compared=html.match(/<section[^>]*data-section="comparison"[\s\S]*?<\/section>/)?.[0];
    expect.soft(compared).toContain('执行位置不同');expect.soft(compared).toContain('Not directly comparable');
  });
  // Losing the delta calculation or rejecting an ordinary revision change must fail this test.
  it("computes absolute and relative differences while allowing revision changes", () => {
    const base = report(), next = structuredClone(base);
    next.definitionRevision = "rev2"; next.rps = { availability: "available", value: 1.5 };
    expect(compareStressReports(base, next)).toMatchObject({ metrics: { rps: { base: 1, candidate: 1.5, absolute: 0.5, relative: 0.5 } }, notices: expect.arrayContaining(["revision-changed"]) });
  });
  it("rejects other projects and marks target/environment/load/data/statistics differences", () => {
    const base = report(), next = structuredClone(base);
    expect(() => compareStressReports(base, { ...next, projectId: "other" })).toThrow(/project/i);
    next.target = { kind: "workflow", workflowId: "other" }; next.environmentId = "env"; next.plan.load = { kind: "constant-vus", vus: 2 };
    next.dataIdentity.digest = "changed"; next.connectionMode = "fresh"; next.statistics.exact = false;
    expect(compareStressReports(base, next)).toMatchObject({ directlyComparable: false,
      mismatches: expect.arrayContaining(["target", "environment", "load", "connection", "data", "statistics"]) });
  });
  it("never invents percentages or F6 metrics for zero or historical baselines", () => {
    const base = report(), next = report(); base.rps = { availability: "available", value: 0 };
    expect(compareStressReports(base, next)).toMatchObject({ metrics: { rps: { absolute: 1, relative: null } } });
    const old = computeReport([], { concurrency: 1, startedAt: 0, finishedAt: 1000 }); old.projectId = "project";
    expect(compareStressReports(parseStressReport(old), next)).toMatchObject({ directlyComparable: false, metrics: { iterationP95Ms: { base: null, absolute: null, relative: null } } });
    // Removing the eligibility guard must fail for each available historical proof of no samples.
    const { eligibleCompletedAttempts: _eligible, ...fromWindow } = old;
    const { measurementWindow: _window, ...fromTotal } = fromWindow;
    for (const empty of [old, fromWindow, fromTotal]) {
      expect(compareStressReports(next, parseStressReport(empty))).toMatchObject({ metrics: {
        rps: { base: 1, candidate: null, absolute: null, relative: null }, p95Ms: { candidate: null, absolute: null, relative: null },
      } });
    }
    const recordedZero = { ...computeReport([{ requestStarted: true, requestCompleted: true, requestTimeMs: 10, status: 200, ok: true }], { concurrency: 1, startedAt: 0, finishedAt: 1000 }), projectId: "project", rps: 0 };
    const { eligibleCompletedAttempts: _zeroEligible, measurementWindow: _zeroWindow, ...unknownQualificationZero } = recordedZero;
    for (const zero of [recordedZero, unknownQualificationZero]) {
      expect(compareStressReports(parseStressReport(zero), next)).toMatchObject({ metrics: { rps: { base: 0, candidate: 1, absolute: 1, relative: null } } });
    }
    next.rps = { availability: "unavailable", reason: "no-data" };
    expect(compareStressReports(base, next)).toMatchObject({ metrics: { rps: { candidate: null, absolute: null, relative: null } } });
  });
  it("exports honest incomplete conclusions and escaped readable content without remote resources", () => {
    const value = report(); value.verdict = { status: "incomplete", passed: false, violations: [] };
    value.completeness.load = { complete: false, reasons: ["dropped"] }; value.iterations.planned = 2; value.iterations.dropped = 1;
    value.nodes = [{ key: 'flow/node', workflowId: 'flow', nodeId: 'node-1', other: false, visits: 1, passed: 1, failed: 0, aborted: 0, skipped: 0, requests: value.requests, requestLatency: value.latency, nodeLatency: value.latency }];
    value.lifecycle = [{ role: 'setup', vuId: null, state: 'passed', durationMs: 0.0000001 }];
    value.timeline.buckets = [{ startOffsetMs: 0, endOffsetMs: 1000, rps: value.rps, caseRows: value.caseRows, requests: value.requests, httpExchanges: value.httpExchanges, latency: value.latency,
      sources: [{ phase: 'measurement', stageId: null, caseRows: value.caseRows, requests: value.requests, httpExchanges: value.httpExchanges }] }];
    const original = JSON.stringify(value);
    const html = renderStressHtml(value, compareStressReports(value, value));
    // Readable defaults, rather than raw metadata JSON, must explain this actual rendered report.
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('压测报告'); expect(html).toContain('逻辑迭代'); expect(html).toContain('协议请求');
    const configuration = html.match(/<section[^>]*data-section="configuration"[\s\S]*?<\/section>/)?.[0];
    expect(configuration).toContain('负载模型'); expect(configuration).toContain('工作流');
    expect(configuration).toContain('<table>'); expect(configuration).not.toContain('<pre>');
    expect(html).toMatch(/<details class="raw-data"><summary>/);
    expect(html).not.toMatch(/<details class="raw-data"[^>]*\bopen\b/);
    expect(html.match(/<section[^>]*data-section="nodes"[\s\S]*?<\/section>/)?.[0]).toContain('node-1');
    expect(html.match(/<section[^>]*data-section="lifecycle"[\s\S]*?<\/section>/)?.[0]).toContain('1e-7 ms');
    expect(html).toContain('仅1个时间桶'); expect(html).toContain('距运行开始的时间（秒）');
    expect(html).toContain('<circle'); expect(html).not.toContain('<rect'); expect(html).not.toContain('<polyline');
    expect(html).toContain('时间桶来源明细'); expect(JSON.stringify(value)).toBe(original);
    expect(html).toContain("incomplete"); expect(html).toContain("dropped");
    expect(html).toContain("flow&lt;script&gt;alert(1)&lt;/script&gt;"); expect(html).not.toContain("flow<script>");
    expect(html).toContain("Timeline"); expect(html).toContain("Phases"); expect(html).toContain("Nodes"); expect(html).toContain("Failure evidence");
    expect(html).not.toMatch(/<(?:script|link)[^>]*(?:src|href)=["']https?:/i);
    // Lack of the new integrity evidence must not be converted into a complete claim.
    const legacy = parseStressReport(computeReport([{ requestStarted: true, requestCompleted: true, requestTimeMs: 10, status: 200, ok: true }], { concurrency: 1, startedAt: 0, finishedAt: 1000 }));
    const legacyHtml = renderStressHtml(legacy), legacyFlagHtml = renderStressHtml({ ...legacy, incomplete: false });
    expect(legacyHtml).toContain("Integrity: not collected"); expect(legacyHtml).not.toContain("Integrity: complete");
    expect(legacyFlagHtml).toContain("Integrity: not collected"); expect(legacyFlagHtml).not.toContain("Integrity: complete");
    expect(legacyFlagHtml).toContain("Legacy incomplete flag: false"); expect(legacyFlagHtml).toContain('class="verdict" data-status="passed"');
    const arrival = report(); arrival.plan.load = { kind: 'constant-arrival', rate: 0.6 }; arrival.plan.termination = { durationMs: 1000 };
    arrival.load.plannedDurationMs = 1000;
    expect(renderStressHtml(arrival)).toContain('fewer than 20 planned slots');
    expect(renderStressHtml(arrival)).toContain('cannot verify 5%');
    arrival.plan.load = { kind: 'stages', executor: 'arrival', startTarget: 1, stages: [{ id: 'short', durationMs: 1000, target: 1 }] };
    expect(renderStressHtml(arrival)).toContain('fewer than 20 planned slots');
    arrival.iterations.planned = 20; arrival.completeness.load = { complete: false, reasons: ['dropped'] }; arrival.iterations.dropped = 1;
    expect(renderStressHtml(arrival)).toContain('incomplete, dropped or saturated');
    arrival.iterations.dropped = 0; arrival.completeness.load = { complete: true, reasons: [] };
    expect(renderStressHtml(arrival)).not.toContain('cannot verify 5%');
    expect(legacyHtml).not.toContain('planned slots');
    const unknownCodes = structuredClone(value);
    unknownCodes.errorKinds = Object.fromEntries([['constructor', 1], ['__proto__', 1]]);
    expect(() => renderStressHtml(unknownCodes)).not.toThrow();
    expect(renderStressHtml(unknownCodes)).toContain('<td>constructor</td>');
    expect(renderStressHtml(unknownCodes)).toContain('<td>__proto__</td>');
    // Two observed buckets separated by an unobserved interval must remain two real points.
    const sparse = structuredClone(value), firstBucket = sparse.timeline.buckets[0]!;
    sparse.timeline.buckets.push({ ...structuredClone(firstBucket), startOffsetMs: 10000, endOffsetMs: 11000 });
    const sparseHtml = renderStressHtml(sparse);
    expect.soft(sparseHtml.match(/<polyline /g) ?? []).toHaveLength(0);
    expect(sparseHtml.match(/<circle /g) ?? []).toHaveLength(4);
    sparse.timeline.buckets[1]!.startOffsetMs = 1000; sparse.timeline.buckets[1]!.endOffsetMs = 2000;
    expect(renderStressHtml(sparse).match(/<polyline /g) ?? []).toHaveLength(2);
    const statistics = html.match(/<section[^>]*data-section="statistics"[\s\S]*?<\/section>/)?.[0];
    for (const label of ['最小值（ms）', '平均值（ms）', '最大值（ms）']) expect.soft(statistics).toContain(`>${label}</span>`);
    for (const [availability, label] of [['available', '可用'], ['partial', '部分可用'], ['unavailable', '不可用']] as const) {
      const known = { ...value, safety: { targetOrigins: [], availability } };
      const host = renderStressHtml(known).match(/<section[^>]*data-section="host"[\s\S]*?<\/section>/)?.[0];
      expect.soft(host).toContain(`>${label}</span>`);
    }
    const previousTz = process.env.TZ;
    try {
      process.env.TZ = 'America/New_York';
      const timed = { ...value, startedAt: 0, finishedAt: 1782864000123 };
      const frozen = renderStressHtml(timed);
      expect.soft(frozen).toContain('1969-12-31 19:00:00.000 UTC-05:00');
      expect.soft(frozen).toContain('2026-06-30 20:00:00.123 UTC-04:00');
      expect.soft(frozen).toContain('title="0"'); expect.soft(frozen).toContain('title="1782864000123"');
      const outsideDate = renderStressHtml({ ...timed, startedAt: 1e20 });
      expect.soft(outsideDate).toContain('时间超出可读范围'); expect.soft(outsideDate).toContain('title="100000000000000000000"');
    } finally { if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz; }
    const fingerprint = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    const identified = { ...value, definitionRevision: fingerprint, target: { ...value.target, inputs: { definitionRevision: fingerprint } } };
    const identityBefore = JSON.stringify(identified);
    const identityConfig = renderStressHtml(identified).match(/<section[^>]*data-section="configuration"[\s\S]*?<\/section>/)?.[0];
    expect.soft(identityConfig).toContain('定义指纹'); expect.soft(identityConfig).toContain('Definition fingerprint');
    expect.soft(identityConfig).toContain('01234567…cdef');
    expect.soft(identityConfig).toContain(`<code class="fingerprint-full">${fingerprint}</code>`);
    expect.soft(identityConfig?.match(/<details class="fingerprint">/g) ?? []).toHaveLength(1);
    expect(identityConfig).toContain(`<td>${fingerprint}</td>`); // inputs.definitionRevision remains a full business value.
    expect(JSON.stringify(identified)).toBe(identityBefore);
  });
});

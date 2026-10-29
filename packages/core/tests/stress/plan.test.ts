import { describe, expect, it } from "vitest";
import { ContractWorkspaceSchema } from "../../src/contract/workspace.js";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import { workspaceFixture } from "../helpers/contractFixtures.js";
import { WorkflowSchema } from "../../src/workflow/model.js";
import { StressPlanSchema, SavedStressPlanSchema } from "../../src/stress/plan.js";
import { compileStressPlan, bindPreparedStressExecution } from "../../src/stress/execution.js";
import { prepareTestData } from "../../src/testing/data.js";
import { parseStressReport, StressReportV2Schema } from "../../src/stress/reportV2.js";
import { computeReport } from "../../src/stress/aggregate.js";
import { createExecutionEvidenceCollector } from "../../src/report/evidence.js";

function projectFixture() {
  const project = ContractWorkspaceSchema.parse(workspaceFixture()).groups[0]!.projects[0]!;
  const api = project.collections[0]!.apis[0]!;
  api.cases = [{ id: "case", name: "case", scope: "base", parameters: {}, preOperations: [], postOperations: [], assertions: [] }];
  project.workflows = [WorkflowSchema.parse({ id: "root", name: "root", status: "enabled", executionVersion: 2,
    nodes: [{ id: "request", kind: "request", apiId: api.contract.id, caseId: "case" }] })];
  return project;
}
function rawPlan() { const project = projectFixture(); return { formatVersion: 1, target: { kind: "case", collectionId: project.collections[0]!.id,
  apiId: project.collections[0]!.apis[0]!.contract.id, caseId: "case" }, load: { kind: "constant-vus", vus: 1 }, termination: { maxIterations: 1 } }; }

function recoveredWorkflowReport() {
  const legacy = computeReport([{ requestStarted: true, requestCompleted: true, requestTimeMs: 10, status: 500, ok: false, failureKind: "http" }], { concurrency: 1, startedAt: 0, finishedAt: 1000 });
  const target = { kind: "workflow", workflowId: "root" };
  const latency = { availability: "available", value: legacy.latency };
  const complete = { complete: true, reasons: [] };
  return { ...legacy, formatVersion: 2, runId: "run", projectId: "project", definitionRevision: "revision",
    plan: StressPlanSchema.parse({ ...rawPlan(), target }), target, environmentId: null, dataIdentity: { digest: null, datasetIds: [] },
    rps: { availability: "available", value: 1 }, latency, scriptLatency: latency, iterationLatency: latency,
    verdict: { passed: true, status: "passed", violations: [] },
    iterations: { planned: 1, started: 1, completed: 1, passed: 1, failed: 0, aborted: 0, dropped: 0, latency, startDelay: latency },
    caseRows: { total: 1, ok: 0, failed: 1, failures: legacy.failures }, requests: { started: 1, completed: 1, eligibleCompleted: 1, failed: 1 },
    httpExchanges: { started: 1, completed: 1 }, phases: [], timeline: { bucketWidthMs: 1000, aligned: true, uncertaintyMs: 0, buckets: [] }, nodes: [],
    load: { plannedDurationMs: null, measurementDurationMs: 1000, drainDurationMs: 0, policyLimitedMs: 0, saturated: false, maxVus: 1, maxRequestConcurrency: 1 },
    statistics: { method: "exact-nearest-rank", exact: true, relativeError: 0, minValueMs: 0.001, gamma: 1.01, bucketCount: 4608, exactLimit: 256, underflow: 0, overflow: 0 },
    lifecycle: [], completeness: { execution: complete, metrics: complete, load: complete } };
}

describe("stress plans", () => {
  it("uses the supplied numeric and report budgets in the real compiled plan", () => {
    const snapshot = createProjectSnapshot(projectFixture());
    const compiled = compileStressPlan(snapshot, StressPlanSchema.parse(rawPlan()), {
      numericMemoryBytes: 1048576,
      evidenceMaxSamples: 2,
      evidenceLimits: { bodyBytes: 1024, valueBytes: 256, caseBytes: 4096, reportBytes: 16384 },
    });
    expect(compiled.metricPlan.memory.maxNumericBytes).toBe(1048576);
    expect(compiled.metricPlan.evidence).toMatchObject({ maxSamples: 2, reportBytes: 16384 });
  });
  it("enforces host limits for explicit values and supplies omitted request limits", () => {
    const snapshot = createProjectSnapshot(projectFixture());
    const limits = { maxVus: 2, maxRequestConcurrency: 1, maxRps: 3 };
    expect(compileStressPlan(snapshot, StressPlanSchema.parse(rawPlan()), { limits }).schedule.effective).toEqual({ maxRequestConcurrency: 1, maxRps: 3 });
    for (const override of [{ maxVus: 3 }, { maxRequestConcurrency: 2 }, { maxRps: 4 }]) {
      expect(() => compileStressPlan(snapshot, StressPlanSchema.parse({ ...rawPlan(), ...override }), { limits })).toThrow(/limit|capacity/i);
    }
  });
  it("retains the existing EvidenceLimits range rather than treating default previews as hard ceilings", () => {
    let compiled: ReturnType<typeof compileStressPlan> | undefined;
    expect(() => { compiled = compileStressPlan(createProjectSnapshot(projectFixture()), StressPlanSchema.parse(rawPlan()), {
      evidenceLimits: { bodyBytes: 131072, valueBytes: 8192, caseBytes: 524288, reportBytes: 33554432 },
    }); }).not.toThrow();
    expect(compiled!.metricPlan.evidence).toMatchObject({ bodyBytes: 131072, valueBytes: 8192, caseBytes: 524288, reportBytes: 33554432 });
  });
  it.each([
    { numericMemoryBytes: 1048575 }, { numericMemoryBytes: 67108865 }, { numericMemoryBytes: 1048576.5 },
    { evidenceMaxSamples: 0 }, { evidenceMaxSamples: 21 },
    { evidenceLimits: { bodyBytes: 4097, valueBytes: 256, caseBytes: 4096, reportBytes: 16384 } },
    { evidenceLimits: { bodyBytes: 1024, valueBytes: 256, caseBytes: 4096, reportBytes: 4095 } },
    { limits: { maxVus: 1001, maxRequestConcurrency: 1, maxRps: 3 } },
    { limits: { maxVus: 1, maxRequestConcurrency: 1001, maxRps: 3 } },
    { limits: { maxVus: 1, maxRequestConcurrency: 1, maxRps: Infinity } },
  ])("rejects invalid host capacities and evidence hierarchy: %j", (options) => {
    expect(() => compileStressPlan(createProjectSnapshot(projectFixture()), StressPlanSchema.parse(rawPlan()), options)).toThrow();
  });
  it("strictly dispatches historical and v2 reports, requiring iteration and integrity data", () => {
    const legacy = computeReport([], { concurrency: 1, startedAt: 0, finishedAt: 0 });
    expect(parseStressReport(legacy)).not.toHaveProperty("iterations");
    expect(() => parseStressReport({ ...legacy, formatVersion: 99 })).toThrow();
    expect(StressReportV2Schema.safeParse(legacy).success).toBe(false);
    expect(() => parseStressReport({ ...legacy, formatVersion: 2 })).toThrow();
  });
  it("reads a complete explicit no-data v2 report without allowing a passing or fabricated metric", () => {
    const legacy = computeReport([], { concurrency: 1, startedAt: 0, finishedAt: 0 });
    const unavailable = { availability: "unavailable", reason: "no-data" };
    const complete = { complete: true, reasons: [] };
    const report = { ...legacy, formatVersion: 2, runId: "run", projectId: "project", definitionRevision: "revision", plan: StressPlanSchema.parse(rawPlan()),
      target: rawPlan().target, environmentId: null, dataIdentity: { digest: null, datasetIds: [] },
      rps: unavailable, latency: unavailable, scriptLatency: unavailable, iterationLatency: unavailable,
      verdict: { passed: false, status: "no-data", violations: [] },
      iterations: { planned: 0, started: 0, completed: 0, passed: 0, failed: 0, aborted: 0, dropped: 0, latency: unavailable, startDelay: unavailable },
      caseRows: { total: 0, ok: 0, failed: 0, failures: legacy.failures }, requests: { started: 0, completed: 0, eligibleCompleted: 0, failed: 0 },
      httpExchanges: { started: 0, completed: 0 }, phases: [], timeline: { bucketWidthMs: 1000, aligned: true, uncertaintyMs: 0, buckets: [] }, nodes: [],
      load: { plannedDurationMs: null, measurementDurationMs: 0, drainDurationMs: 0, policyLimitedMs: 0, saturated: false, maxVus: 1, maxRequestConcurrency: 1 },
      statistics: { method: "exact-nearest-rank", exact: true, relativeError: 0, minValueMs: 0.001, gamma: 1.01, bucketCount: 4608, exactLimit: 256, underflow: 0, overflow: 0 },
      lifecycle: [], completeness: { execution: complete, metrics: complete, load: complete } };
    expect(parseStressReport(report)).toMatchObject({ formatVersion: 2, requests: { eligibleCompleted: 0 }, rps: unavailable });
    expect(() => parseStressReport({ ...report, verdict: { passed: true, status: "passed", violations: [] } })).toThrow();
    expect(() => parseStressReport({ ...report, rps: { ...unavailable, value: 0 } })).toThrow();
    const { iterations: _iterations, ...missingIterations } = report;
    expect(() => parseStressReport(missingIterations)).toThrow();
    const { completeness: _completeness, ...missingCompleteness } = report;
    expect(() => parseStressReport(missingCompleteness)).toThrow();
    const latency = { availability: "available", value: { min: 10, avg: 10, max: 10, p50: 10, p90: 10, p95: 10, p99: 10 } };
    const recovered = { ...report, plan: StressPlanSchema.parse({ ...rawPlan(), target: { kind: "workflow", workflowId: "root" } }),
      target: { kind: "workflow", workflowId: "root" }, totalRequests: 1, failed: 1, durationMs: 1000,
      rps: { availability: "available", value: 1 }, latency, scriptLatency: latency, iterationLatency: latency,
      verdict: { passed: true, status: "passed", violations: [] }, iterations: { ...report.iterations, planned: 1, started: 1, completed: 1, passed: 1, latency, startDelay: latency },
      caseRows: { ...report.caseRows, total: 1, failed: 1 }, requests: { started: 1, completed: 1, eligibleCompleted: 1, failed: 1 }, httpExchanges: { started: 1, completed: 1 } };
    expect(parseStressReport(recovered)).toMatchObject({ verdict: { passed: true }, failed: 1, iterations: { passed: 1 } });
    expect(() => parseStressReport({ ...recovered, latency: { availability: "unavailable", reason: "budget-exhausted" } })).toThrow();
    expect(() => parseStressReport({ ...recovered, timeline: { ...report.timeline, aligned: false } })).toThrow();
  });
  it("rejects a failed measured case passing verdict using plan.target even if redundant target says workflow", () => {
    const recovered = recoveredWorkflowReport();
    expect(parseStressReport(recovered)).toMatchObject({ verdict: { passed: true }, caseRows: { failed: 1 } });
    const failedCase = { ...recovered, plan: StressPlanSchema.parse(rawPlan()), target: rawPlan().target };
    expect(StressReportV2Schema.safeParse(failedCase).success).toBe(false);
    expect(() => parseStressReport({ ...failedCase, target: recovered.target })).toThrow();
  });
  it("requires concluded started iterations for complete execution or an ordinary passing verdict", () => {
    const report = recoveredWorkflowReport();
    const unfinished = { ...report, iterations: { ...report.iterations, completed: 0, passed: 0 } };
    expect(StressReportV2Schema.safeParse(unfinished).success).toBe(false);
    expect(() => parseStressReport({ ...unfinished, verdict: { passed: false, status: "incomplete", violations: [] } })).toThrow();
    expect(parseStressReport({ ...unfinished, verdict: { passed: false, status: "incomplete", violations: [] },
      completeness: { ...report.completeness, execution: { complete: false, reasons: ["execution-failed"] } } })).toMatchObject({
      verdict: { status: "incomplete" }, completeness: { execution: { complete: false } } });
  });
  it("requires explicit unaligned and incomplete metrics facts for unaligned distributed reports", () => {
    const report = recoveredWorkflowReport();
    const unaligned = { ...report, distributed: { protocolVersion: 3, workers: 1, dataComplete: true, timeAligned: false } };
    expect(StressReportV2Schema.safeParse(unaligned).success).toBe(false);
    expect(() => parseStressReport({ ...unaligned, verdict: { passed: false, status: "incomplete", violations: [] } })).toThrow();
    expect(parseStressReport({ ...unaligned, verdict: { passed: false, status: "incomplete", violations: [] },
      timeline: { ...report.timeline, aligned: false }, completeness: { ...report.completeness, metrics: { complete: false, reasons: ["timeline-unaligned"] } } })).toMatchObject({
      distributed: { timeAligned: false }, timeline: { aligned: false }, completeness: { metrics: { complete: false, reasons: ["timeline-unaligned"] } } });
  });
  it("rejects lifecycle output collisions, undeclared mappings and policy excess before preparation", () => {
    const project = projectFixture(); project.stressPolicy.maxConcurrency = 1;
    const snapshot = createProjectSnapshot(project);
    expect(() => compileStressPlan(snapshot, StressPlanSchema.parse({ ...rawPlan(), maxRequestConcurrency: 2 }))).toThrow(/policy|concurrency/i);
    expect(() => compileStressPlan(snapshot, StressPlanSchema.parse({ ...rawPlan(), lifecycle: { setup: { workflowId: "root", outputs: { missing: "variable" } } } }))).toThrow(/output|mapping/i);
    expect(StressPlanSchema.safeParse({ ...rawPlan(), lifecycle: { teardown: { workflowId: "root", outputs: { missing: "variable" } } } }).success).toBe(false);
  });
  it("preflights the selected environment origin and records policy-normalized default request limits", () => {
    const project = projectFixture();
    project.stressPolicy = { trustedOrigins: [], deniedOrigins: ["https://denied.test"], maxConcurrency: 1, maxRps: 5 };
    const request = project.collections[0]!.apis[0]!.contract.request;
    if (request.protocol !== "http") throw new Error("fixture HTTP");
    request.baseUrl = "https://denied.test";
    project.environments[0]!.baseUrls[project.collections[0]!.id] = "https://selected.test";
    const compiled = compileStressPlan(createProjectSnapshot(project), StressPlanSchema.parse({ ...rawPlan(), environmentId: project.environments[0]!.id,
      maxVus: 2, load: { kind: "constant-vus", vus: 2 } }));
    expect(compiled.schedule.requested).toEqual({ maxRequestConcurrency: null, maxRps: null });
    expect(compiled.schedule.effective).toEqual({ maxRequestConcurrency: 1, maxRps: 5 });
  });
  it("preserves stress identity through the existing bounded safe evidence collector", () => {
    const collector = createExecutionEvidenceCollector({ projectId: "p", definitionRevision: "r" }, [], { maxSamples: 20 });
    collector.observe({ outcome: { apiId: "api", apiName: "api", caseId: "case", caseName: "case", passed: false, assertions: [], failureKind: "config", durationMs: 0 },
      request: { protocol: "http", method: "GET", url: "https://example.test", headers: {}, query: [], auth: { kind: "none" } },
      requestTimeMs: 0, scriptTimeMs: 0, iterationTimeMs: 0, requestStarted: false, requestCompleted: false, failureKind: "config" },
    { stressRunId: "run", vuId: "vu", iterationId: "iteration", stageId: null });
    expect(collector.projectSamples()[0]!.identity).toMatchObject({ stressRunId: "run", vuId: "vu", iterationId: "iteration", stageId: null });
  });
  it("normalizes defaults without saving runtime confirmations", () => {
    const plan = StressPlanSchema.parse(rawPlan());
    expect(plan).toMatchObject({ maxVus: 1, warmupMs: 0, thinkTimeMs: 0, pacingMs: 0, gracefulStopMs: 30000, connectionMode: "pooled" });
    expect(StressPlanSchema.safeParse({ ...rawPlan(), confirmedTargetOrigins: ["https://example.test"] }).success).toBe(false);
    expect(SavedStressPlanSchema.safeParse({ formatVersion: 1, id: "saved", name: "load", updatedAt: 123, plan, confirmed: true }).success).toBe(false);
  });
  it.each([
    { maxVus: 0 }, { maxVus: 1001 }, { load: { kind: "constant-vus", vus: 0 } },
    { load: { kind: "constant-arrival", rate: Number.NaN }, termination: { durationMs: 1000 } },
    { load: { kind: "constant-arrival", rate: 1 }, termination: { maxIterations: 1 } },
    { termination: {} }, { termination: { durationMs: 604800001 } }, { termination: { maxIterations: Number.MAX_SAFE_INTEGER + 1 } },
    { gracefulStopMs: 300001 }, { thinkTimeMs: 3600001 }, { maxRequestConcurrency: 0 },
    { load: { kind: "stages", executor: "vus", startTarget: 0, stages: [{ id: "a", durationMs: 1, target: 0 }] }, termination: {} },
    { load: { kind: "stages", executor: "vus", startTarget: 1, stages: [{ id: "a", durationMs: 1, target: 1 }, { id: "a", durationMs: 1, target: 1 }] }, termination: {} },
    { load: { kind: "stages", executor: "vus", startTarget: 1, stages: [{ id: "a", durationMs: 1, target: 1 }] }, termination: { durationMs: 2 } },
    { load: { kind: "constant-arrival", rate: Number.MAX_VALUE }, termination: { durationMs: 604800000 } },
  ])("rejects invalid bounds and ambiguous schedules: %j", (override) => {
    expect(StressPlanSchema.safeParse({ ...rawPlan(), ...override }).success).toBe(false);
  });
  it("uses summed stage duration and includes lifecycle workflow closures", () => {
    const project = projectFixture();
    project.workflows.push(WorkflowSchema.parse({ id: "setup", name: "setup", status: "enabled", executionVersion: 2,
      nodes: [{ id: "setup-request", kind: "request", apiId: project.collections[0]!.apis[0]!.contract.id, caseId: "case" }] }));
    const snapshot = createProjectSnapshot(project);
    const compiled = compileStressPlan(snapshot, StressPlanSchema.parse({ ...rawPlan(), target: { kind: "workflow", workflowId: "root" },
      lifecycle: { setup: { workflowId: "setup" } }, maxVus: 2,
      load: { kind: "stages", executor: "vus", startTarget: 0, stages: [{ id: "ramp", durationMs: 200, target: 2 }, { id: "down", durationMs: 100, target: 0 }] }, termination: {} }));
    expect(compiled.schedule.durationMs).toBe(300);
    expect(compiled.workflowPlans.map((plan) => plan.rootWorkflowId)).toEqual(["root", "setup"]);
    expect(compiled.metricPlan.stableNodeKeys.map((node) => [node.workflowId, node.nodeId])).toEqual([["root", "request"], ["setup", "setup-request"]]);
    expect(compiled).not.toHaveProperty("runId");
  });
  it("binds only the identical snapshot and prepared selections, keeping an immutable run wrapper", async () => {
    const project = projectFixture(); const snapshot = createProjectSnapshot(project);
    const compiled = compileStressPlan(snapshot, StressPlanSchema.parse(rawPlan()));
    const preparedTestData = await prepareTestData(snapshot, compiled.targets.flatMap((target) => target.dataSelections), { workspaceRoot: process.cwd() });
    const run = { snapshot, credentialBindings: { resolve: () => "", versions: {} }, preparedTestData };
    const bound = bindPreparedStressExecution(compiled, run);
    expect(bound.compiled).toBe(compiled); expect(bound.run.snapshot).toBe(snapshot);
    expect(Object.isFrozen(bound.run)).toBe(true);
    expect(() => bindPreparedStressExecution(compiled, { ...run, snapshot: createProjectSnapshot(project) })).toThrow(/snapshot/i);
    expect(() => bindPreparedStressExecution({ ...compiled }, run)).toThrow(/compiled|owner/i);
    expect(() => bindPreparedStressExecution(compiled, { ...run, preparedTestData: undefined })).toThrow(/data/i);
  });
  it("rejects cross-project references, unsupported protocols and recursive lifecycle calls", () => {
    const project = projectFixture();
    expect(() => compileStressPlan(createProjectSnapshot(project), StressPlanSchema.parse({ ...rawPlan(), target: { ...rawPlan().target, collectionId: "foreign" } }))).toThrow();
    project.collections[0]!.apis[0]!.contract.request = { protocol: "websocket", baseUrl: "wss://example.test", path: "/", pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" } };
    expect(() => compileStressPlan(createProjectSnapshot(project), StressPlanSchema.parse(rawPlan()))).toThrow(/HTTP/i);
    project.collections[0]!.apis[0]!.contract.request = projectFixture().collections[0]!.apis[0]!.contract.request;
    project.workflows.push(WorkflowSchema.parse({ id: "recursive", name: "recursive", status: "enabled", executionVersion: 2,
      nodes: [{ id: "self", kind: "subflow", workflowId: "recursive" }] }));
    expect(() => compileStressPlan(createProjectSnapshot(project), StressPlanSchema.parse({ ...rawPlan(), lifecycle: { setup: { workflowId: "recursive" } } }))).toThrow(/recursion|recursive/i);
  });
});

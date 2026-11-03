import { describe, expect, it } from "vitest";
import { z } from "zod";
import { projectPublication } from "../../src/collaboration/projection.js";
import { PublicationInputSchema, PublicArtifactDtoSchema, ReportViewDtoSchema } from "../../src/collaboration/shared.js";
import { parseStressReport, StressReportV2Schema } from "../../src/stress/reportV2.js";
import { DebugHistoryRecordSchema } from "../../src/debug/model.js";
import { computeReport } from "../../src/stress/aggregate.js";
import { archiveInput, debugHistory, executionEvidence, jsonWireSchema, policy, runReport, safeReport, stressReport } from "./fixtures.js";
import { safeDocument } from "./fixtures.js";
import { publicLabel } from '../../src/collaboration/presentation.js';

describe("report strict wire versus existing Core semantic validation", () => {
  it('addendum N02 derived top HTTP failure is not another occurrence of its existing failed outcome',async()=>{
    const body=DebugHistoryRecordSchema.options[1].parse(debugHistory());body.result.failureKind='http';
    expect(DebugHistoryRecordSchema.safeParse(body).success).toBe(true);expect(body.result.outcomes).toHaveLength(1);expect(body.result.outcomes[0]).toMatchObject({passed:false,failureKind:'http'});expect(body.result.run).toMatchObject({total:1,passed:0,failed:1});
    const dto=await projectPublication({...archiveInput(),report:{format:'debug',body}},policy);
    expect.soft(dto.report?.failures).toEqual([{category:'http',count:1}]);expect.soft(dto.report?.nodes).toHaveLength(1);expect.soft(dto.report?.verdict).toBe('failed');
    expect(dto.report?.counts).toEqual([{labelCode:'case.rows',total:1,passed:0,failed:1,skipped:0},{labelCode:'http.exchanges',total:1}]);
  });
  it.each(['script','aborted'] as const)('final I02 preserves top-level debug %s independently of passed request counts',async failureKind=>{
    const body=DebugHistoryRecordSchema.options[1].parse(debugHistory()),raw=body.result;
    raw.outcomes=[];raw.run={...raw.run,total:1,passed:1,failed:0};raw.failureKind=failureKind;raw.error='Post-script diagnostic PRIVATE-TOP-FAILURE';
    const input={...archiveInput(),privateMarkers:['PRIVATE-TOP-FAILURE'],report:{format:'debug' as const,body}};
    expect(PublicationInputSchema.safeParse(input).success).toBe(true);
    const dto=await projectPublication(input,policy);
    expect.soft(dto.kind).toBe('debug-history');expect.soft(dto.report?.verdict).toBe(failureKind==='aborted'?'aborted':'failed');
    expect.soft(dto.report?.counts[0]).toMatchObject({total:1,passed:1,failed:0});expect.soft(dto.report?.nodes).toEqual([]);
    expect.soft(dto.report?.failures).toContainEqual({category:failureKind,count:1});
    expect.soft(dto.summary).toContainEqual({labelCode:'report.failure',value:expect.stringContaining('Post-script diagnostic')});
    expect.soft(publicLabel('report.failure','zh-CN')).toBe('失败诊断');expect.soft(publicLabel('report.failure','en')).toBe('Failure diagnostic');
    expect(JSON.stringify(dto)).not.toContain('PRIVATE-TOP-FAILURE');
  });
  it.each(["report", "count", "failure", "node", "trace", "evidence", "stress", "phase", "timeline", "bucket", "stressNode", "lifecycle", "completeness", "comparison", "delta"])("rejects private unknown report field at %s", (at) => {
    const dto = safeReport(); const report = dto.report!; const stress = report.stress!;
    const targets: Record<string, object> = { report, count: report.counts[0]!, failure: report.failures[0]!, node: report.nodes[0]!, trace: report.trace[0]!, evidence: report.evidence[0]!,
      stress, phase: stress.phases[0]!, timeline: stress.timeline, bucket: stress.timeline.buckets[0]!, stressNode: stress.nodes[0]!, lifecycle: stress.lifecycle[0]!,
      completeness: stress.completeness, comparison: report.comparison!, delta: report.comparison!.metrics.rps };
    Object.assign(targets[at]!, { raw: { project: "PRIVATE" } });
    expect(PublicArtifactDtoSchema.safeParse(dto).success).toBe(false);
  });
  it("accepts a safe structured report and exports strict JSON wire without custom fallback", () => {
    const dto = safeReport();
    expect.soft(PublicArtifactDtoSchema.safeParse(dto).success).toBe(true);
    expect.soft(ReportViewDtoSchema.safeParse(dto.report).success).toBe(true);
    expect.soft(z.toJSONSchema(jsonWireSchema(ReportViewDtoSchema)).additionalProperties).toBe(false);
  });
  it.each(["document-with-report", "report-with-document"])("rejects a kind/view mismatch %s", (kind) => {
    const artifact = kind === "document-with-report" ? safeReport() : safeDocument(); artifact.kind = kind === "document-with-report" ? "document" : "report";
    expect(PublicArtifactDtoSchema.safeParse(artifact).success).toBe(false);
  });
  it.each(["negative-total", "fractional-total", "unsafe-total", "negative-request", "negative-duration"])("rejects nonphysical run counters %s", (kind) => {
    const input = archiveInput(); if (input.report.format !== "run") throw new Error("run fixture required");
    if (kind === "negative-total") input.report.body.total = -1;
    if (kind === "fractional-total") input.report.body.total = 0.5;
    if (kind === "unsafe-total") input.report.body.total = Number.MAX_SAFE_INTEGER + 1;
    if (kind === "negative-request") input.report.body.requestFacts!.requestStarted = -1;
    if (kind === "negative-duration") input.report.body.cases[0]!.durationMs = -1;
    expect(PublicationInputSchema.safeParse(input).success).toBe(false);
  });
  // Wire fixture classes for T4: structural-invalid / semantic-invalid / fully-valid.
  it.each(["archive", "run", "case", "assertion", "trace", "requestFacts", "workflowUnit"])("wire rejects structural-invalid %s fields", (at) => {
    const input = archiveInput(); if (input.report.format !== "run") throw new Error("run fixture required");
    const run = input.report.body;
    const targets: Record<string, object> = { archive: input, run, case: run.cases[0]!, assertion: run.cases[0]!.assertions[0]!, trace: run.trace!, requestFacts: run.requestFacts!, workflowUnit: run.workflowUnits![0]! };
    Object.assign(targets[at]!, { rawProject: "PRIVATE" });
    expect(PublicationInputSchema.safeParse(input).success).toBe(false);
  });
  it("wire accepts a fully valid stress source and Core accepts its semantics", () => {
    const body = stressReport(); expect(() => StressReportV2Schema.parse(body)).not.toThrow();
    const input = { ...archiveInput(), report: { format: "stress", body } };
    expect(PublicationInputSchema.safeParse(input).success).toBe(true);
  });
  it("wire rejects structural-invalid stress while Core also rejects it", () => {
    const body = { ...stressReport(), rawProject: "PRIVATE" };
    expect.soft(PublicationInputSchema.safeParse({ ...archiveInput(), report: { format: "stress", body } }).success).toBe(false);
    expect.soft(() => parseStressReport(body)).toThrow();
  });
  it("wire accepts structural-valid arithmetic-invalid data but Core publication rejects", async () => {
    const body = stressReport(); body.requests.completed = 3;
    const input = { ...archiveInput(), report: { format: "stress" as const, body } };
    expect.soft(PublicationInputSchema.safeParse(input).success).toBe(true);
    expect.soft(() => parseStressReport(body)).toThrow(); // existing semantics remain a green control
    await expect(projectPublication(input, policy)).rejects.toThrow("PUBLICATION_SOURCE_INVALID");
  });
  it("wire accepts structural-valid completeness-invalid data but Core publication rejects", async () => {
    const body = stressReport(); body.completeness.metrics = { complete: true, reasons: ["worker-missing"] };
    const input = { ...archiveInput(), report: { format: "stress" as const, body } };
    expect.soft(PublicationInputSchema.safeParse(input).success).toBe(true);
    expect.soft(() => parseStressReport(body)).toThrow();
    await expect(projectPublication(input, policy)).rejects.toThrow("PUBLICATION_SOURCE_INVALID");
  });
  it("rejects an unsupported new stress version rather than falling back to legacy", async () => {
    const body = { ...stressReport(), formatVersion: 99 };
    expect.soft(PublicationInputSchema.safeParse({ ...archiveInput(), report: { format: "stress", body } }).success).toBe(false);
    expect.soft(() => parseStressReport(body)).toThrow();
  });
});

describe("readable report populations and evidence projection", () => {
  // I1: known sensitive header values must survive as private markers after evidence is excluded.
  it.each(['run', 'debug', 'stress'] as const)('masks known %s header echoes without publishing evidence or needing external markers', async format => {
    const cookie = 'syntheticKnownCookieRound1', auth = 'syntheticKnownAuthRound1', input = archiveInput(); input.privateMarkers = []; input.redaction = 'unavailable'; input.title = `Public report ${cookie} ${auth}`;
    const evidence = executionEvidence(); evidence.request!.headers.text = JSON.stringify({ Cookie: `sid=${cookie}`, Authorization: `Bearer ${auth}` });
    if (format === 'run') { const body = runReport(); body.cases[0]!.evidence = evidence; body.cases[0]!.caseName = `Public case ${cookie}`; body.cases[0]!.error = `Public failure ${auth}`; input.report = { format, body }; }
    else if (format === 'debug') { const body = debugHistory(); body.result.outcomes[0]!.evidence = evidence; body.result.outcomes[0]!.caseName = `Public case ${cookie}`; body.result.outcomes[0]!.error = `Public failure ${auth}`; input.report = { format, body }; }
    else { const body = stressReport(); body.failureEvidence = [evidence]; input.report = { format, body }; }
    const dto = await projectPublication(input, { ...policy, includeEvidence: false }); expect(dto.report!.evidence).toEqual([]); expect(dto.report!.counts[0]!.total).toBeGreaterThan(0); expect(dto.title).toContain('Public report');
    expect.soft(JSON.stringify(dto)).not.toContain(cookie); expect.soft(JSON.stringify(dto)).not.toContain(auth);
  });
  // Break caught: treating a recovered logical pass as if no raw requests failed.
  it("preserves recovered logical pass alongside raw row failures and request populations", async () => {
    const dto = await projectPublication(archiveInput(), policy);
    expect.soft(dto.report).toMatchObject({ sourceCategory: "run", startedAt: "2026-11-01T00:00:00.000Z", finishedAt: "2026-11-01T00:00:01.000Z", verdict: "passed" });
    expect.soft(dto.report?.counts).toEqual(expect.arrayContaining([
      expect.objectContaining({ labelCode: "logical.units", total: 1, passed: 1, failed: 0 }),
      expect.objectContaining({ labelCode: "case.rows", total: 2, passed: 1, failed: 1 }),
      expect.objectContaining({ labelCode: "request.started", total: 2 }),
    ]));
    expect.soft(dto.report?.failures).toContainEqual({ category: "transport", count: 1 });
    expect.soft(dto.report?.nodes).toHaveLength(2);
    expect.soft(dto.report?.trace).toContainEqual(expect.objectContaining({ type: "recovered", nodeId: "node-1" }));
    expect.soft(JSON.stringify(dto)).not.toContain("private-node");
  });
  it("retains a readable failure reason on the projected node itself", async () => {
    const dto = await projectPublication(archiveInput(), policy);
    expect(dto.report?.nodes[0]?.message ?? "").toContain("保留失败原因");
  });
  it("excludes runtime request and response bodies by default without removing the report", async () => {
    const dto = await projectPublication(archiveInput(), policy);
    expect.soft(dto.report?.evidence).toEqual([]);
    expect.soft(JSON.stringify(dto)).not.toContain("保留请求");
    expect.soft(JSON.stringify(dto)).not.toContain("保留响应");
    expect.soft(dto.report?.counts.length).toBeGreaterThan(0);
  });
  it("applies default evidence omission to a member-uploaded safe report as well", async () => {
    const artifact = safeReport();
    const dto = await projectPublication({ sourceKind: "member-upload", artifact }, policy);
    expect.soft(dto.report?.evidence).toEqual([]);
    expect.soft(JSON.stringify(dto)).not.toContain("公开正文");
  });
  it("masks explicit evidence using trusted private markers and configured business fields", async () => {
    const dto = await projectPublication(archiveInput(), { ...policy, includeEvidence: true });
    const text = JSON.stringify(dto);
    for (const secret of ["KNOWN-RUN-MARKER", "AUTH-PRIVATE", "COOKIE-PRIVATE", "FIELD-PRIVATE", "POINTER-PRIVATE", "RESPONSE-PRIVATE"]) expect.soft(text).not.toContain(secret);
    expect.soft(dto.report?.evidence[0]?.requestBody ?? "").toContain("保留请求");
    expect.soft(dto.report?.evidence[0]?.status).toBe("masked");
    expect.soft(dto.limitations.some((item) => item.code === "masked")).toBe(true);
  });
  it("masks encoded forms of known trusted markers before output clipping", async () => {
    const input = archiveInput(); if (input.report.format !== "run") throw new Error("run fixture required");
    const marker = "私密 标记"; const encoded = encodeURIComponent(marker); const base64 = Buffer.from(marker).toString("base64");
    input.privateMarkers = [marker];
    input.report.body.cases[0]!.evidence!.request!.body.text = JSON.stringify({ public: "保留请求", encoded, base64 });
    const dto = await projectPublication(input, { ...policy, includeEvidence: true });
    expect.soft(JSON.stringify(dto)).not.toContain(encoded);
    expect.soft(JSON.stringify(dto)).not.toContain(base64);
    expect.soft(dto.report?.evidence[0]?.requestBody ?? "").toContain("保留请求");
  });
  it.each(["missing", "not-collected", "unsupported"] as const)("keeps %s evidence distinct and omits unsupported legacy bodies", async (state) => {
    const input = archiveInput(); if (input.report.format !== "run") throw new Error("run fixture required");
    if (state === "missing") input.report.body.cases.forEach((row) => { delete row.evidence; });
    if (state === "not-collected") input.report.body.cases.forEach((row) => { row.evidence = { identity: executionEvidence().identity, state: "not-collected", truncated: false, scriptDiagnostics: "not-collected" }; });
    if (state === "unsupported") input.redaction = "unavailable";
    const dto = await projectPublication(input, { ...policy, includeEvidence: true });
    expect.soft(dto.report?.evidence[0]?.status).toBe(state);
    expect.soft(dto.limitations.some((item) => item.code === state)).toBe(true);
    expect.soft(JSON.stringify(dto)).not.toContain("保留请求");
  });
  it("bounds Chinese evidence bytes and distinguishes truncation from masking", async () => {
    const input = archiveInput(); if (input.report.format !== "run") throw new Error("run fixture required");
    input.privateMarkers = [];
    input.report.body.cases.forEach((row) => { row.evidence = executionEvidence(); row.evidence.request!.body.text = "中".repeat(200); row.evidence.response!.body.text = "公开响应"; });
    const dto = await projectPublication(input, { ...policy, includeEvidence: true, maxFieldBytes: 256 });
    expect.soft(new TextEncoder().encode(dto.report?.evidence[0]?.requestBody ?? "").length).toBeLessThanOrEqual(256);
    expect.soft(dto.report?.evidence[0]?.status).toBe("truncated");
    expect.soft(dto.limitations.some((item) => item.code === "truncated")).toBe(true);
  });
  it("enforces aggregate evidence budget without dropping logical nodes or counts", async () => {
    const run = runReport();
    run.cases = Array.from({ length: 10 }, (_, index) => ({ ...run.cases[0]!, caseId: `case-${index}`, evidence: executionEvidence() }));
    run.cases.forEach((row) => { row.evidence!.request!.body.text = "中".repeat(300); row.evidence!.response!.body.text = "文".repeat(300); });
    const dto = await projectPublication(archiveInput(run), { ...policy, includeEvidence: true, maxFieldBytes: 1024, maxEvidenceBytes: 4096 });
    const bytes = (dto.report?.evidence ?? []).reduce((total, item) => total + new TextEncoder().encode(item.requestBody ?? "").length + new TextEncoder().encode(item.responseBody ?? "").length, 0);
    expect.soft(bytes).toBeLessThanOrEqual(4096);
    expect.soft(dto.report?.evidence.some((item) => item.status === "truncated")).toBe(true);
    expect.soft(dto.report?.nodes).toHaveLength(10);
  });
  it("retains stress phases, real timeline, lifecycle, comparison and separate raw/logical populations", async () => {
    const body = stressReport(); StressReportV2Schema.parse(body);
    const baseline = structuredClone(body); baseline.rps = { availability: "available", value: 0.5 };
    const dto = await projectPublication({ ...archiveInput(), report: { format: "stress", body, baseline } }, policy);
    expect.soft(dto.report?.verdict).toBe("passed");
    expect.soft(dto.report?.stress?.caseRows.failed).toBe(1);
    expect.soft(dto.report?.stress?.iterations.passed).toBe(1);
    expect.soft(dto.report?.stress?.phases[0]).toMatchObject({ phase: "measurement", durationMs: 1000 });
    expect.soft(dto.report?.stress?.timeline.buckets).toHaveLength(1);
    expect.soft(dto.report?.stress?.lifecycle[0]).toMatchObject({ role: "setup", durationMs: 5 });
    expect.soft(dto.report?.comparison?.metrics.rps).toMatchObject({ base: 0.5, candidate: 1, absolute: 0.5, relative: 1 });
    for (const id of ["private-flow", "private-node", "private-stage", "private-vu", "private-key"]) expect.soft(JSON.stringify(dto)).not.toContain(id);
  });
  it("keeps supported old stress summary and marks unsupported richer evidence", async () => {
    const body = parseStressReport(computeReport([], { concurrency: 1, startedAt: 0, finishedAt: 1000 }));
    const dto = await projectPublication({ ...archiveInput(), report: { format: "stress", body }, redaction: "unavailable" }, { ...policy, includeEvidence: true });
    expect.soft(dto.report?.sourceCategory).toBe("stress");
    expect.soft(dto.report?.counts).toContainEqual(expect.objectContaining({ labelCode: "case.rows", total: 0 }));
    expect.soft(dto.limitations.some((item) => item.code === "unsupported")).toBe(true);
    expect.soft(dto.report?.stress).toBeUndefined();
  });
  it("projects a supported single debug record and never reads neighboring private history", async () => {
    const body = debugHistory(); DebugHistoryRecordSchema.parse(body);
    let reads = 0;
    Object.defineProperty(body, "unselectedHistory", { enumerable: false, get() { reads += 1; throw new Error("private neighbor was read"); } });
    const dto = await projectPublication({ ...archiveInput(), report: { format: "debug", body } }, policy);
    expect.soft(reads).toBe(0);
    expect.soft(dto.kind).toBe("debug-history");
    expect.soft(dto.report?.counts).toContainEqual(expect.objectContaining({ labelCode: "case.rows", total: 1, failed: 1 }));
    expect.soft(JSON.stringify(dto)).not.toContain("private-debug-run");
    expect.soft(dto.report?.nodes[0]?.name).toContain("调试");
  });
});

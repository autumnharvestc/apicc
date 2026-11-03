import { encodeContractProjectFiles } from "../../src/storage/contractFiles.js";
import { createMockConfiguredProject } from "../helpers/mockFixtures.js";
import { contractExecutionIds } from "../helpers/contractExecutionFixtures.js";
import type { DocumentPublicationInput, ProjectionPolicy, PublicArtifactDto } from "../../src/collaboration/types.js";
import { z } from "zod";
import type { ArchivePublicationInput, ReportViewDto } from "../../src/collaboration/types.js";
import type { RunResult, SafeExecutionEvidence } from "../../src/report/types.js";
import { stressReportFixture } from "../helpers/stressReport.js";
import type { DebugHistoryRecord } from "../../src/debug/model.js";

/** Same explicit JSON-wire substitution rule used by execution's Java generator. */
export function jsonWireSchema(root: z.ZodType): z.ZodType {
  const converted = new WeakMap<z.ZodType, z.ZodType>();
  const convert = (schema: z.ZodType): z.ZodType => {
    const cached = converted.get(schema); if (cached) return cached;
    const explicit = schema.meta()?.apiccJsonWireSchema;
    if (explicit !== undefined) {
      if (!(explicit instanceof z.ZodType)) throw new Error("Invalid explicit JSON wire boundary");
      const result = convert(explicit); converted.set(schema, result); return result;
    }
    const def = schema._zod.def;
    if (("checks" in def ? def.checks ?? [] : []).some((check) => ["custom", "overwrite"].includes(check._zod.def.check))) throw new Error("Unrepresented custom refinement");
    if (["custom", "transform", "pipe", "unknown", "any"].includes(def.type)) throw new Error(`Unrepresented ${def.type}`);
    if (schema instanceof z.ZodLazy) { const result = z.lazy(() => convert(schema.unwrap() as z.ZodType)); converted.set(schema, result); return result; }
    const mapped = { ...def };
    for (const [key, value] of Object.entries(def)) {
      if (key === "checks") continue;
      const mapSchema = (entry: unknown): unknown => entry instanceof z.ZodType ? convert(entry) : entry;
      Object.assign(mapped, { [key]: value instanceof z.ZodType ? convert(value) : Array.isArray(value) ? value.map(mapSchema)
        : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, mapSchema(entry)])) : value });
    }
    const result = schema.clone(mapped); converted.set(schema, result); return result;
  };
  return convert(root);
}

export const title = "接口协作文档——中文长名称与特殊字符 <img onerror=alert(1)>";
export const ids = { ...contractExecutionIds,
  model: "20000000-0000-4000-8000-000000000001", childModel: "20000000-0000-4000-8000-000000000002",
  unrelatedModel: "20000000-0000-4000-8000-000000000003", unselectedApi: "20000000-0000-4000-8000-000000000004",
};
export const policy: ProjectionPolicy = { revision: 1, includeEvidence: false, maxFieldBytes: 8192, maxEvidenceBytes: 1_048_576,
  maxArtifactBytes: 8_388_608, extraSensitiveHeaders: ["X-Private"], extraSensitiveQuery: ["access"],
  extraSensitiveFields: ["privateField"], extraSensitivePointers: ["/nested/secret"] };
export function documentProject() {
  const project = createMockConfiguredProject();
  const api = project.collections[0]!.folders[0]!.folders[0]!.apis[0]!;
  api.contract.metadata.name = "选定接口";
  api.documentation = "C:\\Users\\private\\secret.txt /home/private/secret.txt Bearer KNOWN-PRIVATE";
  const request = api.contract.request;
  if (request.protocol !== "http") throw new Error("HTTP fixture required");
  request.headers = ["Authorization", "Cookie", "X-Private"].map((name, index) => ({ kind: "inline", id: `20000000-0000-4000-8000-00000000001${index}`,
    name, schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "", value: index === 0 ? "Bearer KNOWN-PRIVATE" : `private-${index}` }));
  request.query.push({ kind: "inline", id: "20000000-0000-4000-8000-000000000019", name: "access", schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "", value: "QUERY-PRIVATE" });
  request.body = { kind: "json", content: '{"public":"保留正文","privateField":"FIELD-PRIVATE","nested":{"secret":"POINTER-PRIVATE"}}', schema: { kind: "modelRef", modelId: ids.model } };
  project.models = [
    { formatVersion: 1, id: ids.model, name: "必要模型", description: "", schema: { kind: "modelRef", modelId: ids.childModel } },
    { formatVersion: 1, id: ids.childModel, name: "传递依赖", description: "", schema: { kind: "scalar", type: "string" } },
    { formatVersion: 1, id: ids.unrelatedModel, name: "不得公开的无关模型", description: "", schema: { kind: "scalar", type: "string" } },
  ];
  const extra = structuredClone(api);
  extra.contract.id = ids.unselectedApi;
  extra.contract.metadata.name = "不得公开的其他接口";
  // Isolate unrelated root API; chosen folder must not pull it into publication.
  project.collections[0]!.apis.push(extra);
  return project;
}
export function documentInput(project = documentProject()): DocumentPublicationInput {
  return { sourceKind: "saved-contract", title, source: { revision: "fixed-r1", digest: "digest-r1" },
    files: [...encodeContractProjectFiles(project).files].map(([path, content]) => ({ path, content })),
    scope: { kind: "folders", folders: [{ collectionId: ids.collection, folderIds: [ids.outerFolder, ids.innerFolder] }] } };
}
export function safeDocument(): PublicArtifactDto {
  return { formatVersion: 1, kind: "document", title, source: { trust: "member-claim", revision: "r1", digest: "d1" },
    summary: [{ labelCode: "document.apiCount", value: 1 }], limitations: [], document: {
      models: [{ id: "00000000-0000-4000-8000-000000000001", name: "模型", description: "", schema: { kind: "scalar", type: "string" } }],
      components: [{ id: "component-1", kind: "example", name: "示例", description: "", example: { name: "示例", value: { public: true } } }], apis: [{
      id: "api-1", name: "安全接口", description: "", tags: [], version: "1", status: "draft", collection: "模块", folders: [],
      request: { protocol: "http", method: "GET", path: "/items", parameters: [{ id: "param-1", location: "query", name: "q", schema: { kind: "scalar", type: "string" }, required: false, enabled: true, description: "" }], body: { kind: "json", content: "{}", fields: [{ name: "name", value: "公开值", enabled: true }] } },
      responses: [{ id: "response-1", status: "200", description: "成功", headers: [{ name: "X-Public", value: "yes" }], content: [{ mediaType: "application/json", examples: [{ id: "example-1", name: "公开示例", value: { public: true } }] }] }], documentation: "", caseSummaries: [{ name: "用例", scope: "base", assertionCount: 0 }], modelIds: [], componentIds: [],
    }] } };
}

export function executionEvidence(): SafeExecutionEvidence {
  return { identity: { projectId: "private-project", definitionRevision: "private-revision", nodeId: "private-node" }, state: "collected", scriptDiagnostics: "existing-assertions-only", truncated: false,
    request: { protocol: "http", method: "POST", url: { text: "https://private.invalid/?access=QUERY-PRIVATE", truncated: false }, headers: { text: "Authorization: Bearer AUTH-PRIVATE", truncated: false },
      body: { text: '{"public":"保留请求","memo":"KNOWN-RUN-MARKER","privateField":"FIELD-PRIVATE","nested":{"secret":"POINTER-PRIVATE"}}', truncated: false } },
    response: { status: 500, headers: { text: "Set-Cookie: secret=COOKIE-PRIVATE", truncated: false }, body: { text: '{"public":"保留响应","privateField":"RESPONSE-PRIVATE"}', truncated: false } } };
}
export function runReport(): RunResult {
  return { kind: "workflow", reportingMode: "workflow-invocation-v2", workflowUnits: [{ entryId: "entry", workflowId: "private-flow", verdict: "passed" }],
    requestFacts: { requestStarted: 2, requestCompleted: 2, httpExchanges: 2 }, collectionId: "private-collection", collectionName: title,
    startedAt: "2026-11-01T00:00:00.000Z", finishedAt: "2026-11-01T00:00:01.000Z", total: 2, passed: 1, failed: 1, skipped: 0,
    cases: [false, true].map((passed, index) => ({ entryId: "entry", apiId: "private-api", apiName: "请求", caseId: `private-case-${index}`, caseName: `用例${index + 1}`,
      nodeId: "private-node", passed, durationMs: 10, assertions: [{ pass: passed, message: passed ? "ok" : "保留失败原因" }],
      ...(passed ? {} : { failureKind: "transport" as const, error: "保留失败原因 C:\\Users\\private\\key.txt" }), evidence: executionEvidence() })),
    trace: { totalEvents: 2, truncated: false, events: [{ type: "node-failure", nodeId: "private-node", failureKind: "transport", message: "保留失败原因" }, { type: "recovered", nodeId: "private-node" }] } };
}
export function archiveInput(body = runReport()): ArchivePublicationInput {
  return { sourceKind: "server-archive", title, source: { revision: "fixed-run-r1", digest: "fixed-run-digest" },
    report: { format: "run", body }, redaction: "verified", privateMarkers: ["KNOWN-RUN-MARKER"] };
}
export function stressReport() {
  const report = stressReportFixture();
  report.totalRequests = 2; report.ok = 1; report.failed = 1;
  report.caseRows = { total: 2, ok: 1, failed: 1, failures: { ...report.caseRows.failures, transport: 1 } };
  report.requests = { started: 2, completed: 2, eligibleCompleted: 2, failed: 1 }; report.httpExchanges = { started: 2, completed: 2 };
  report.phases = [{ phase: "measurement", stageId: "private-stage", startOffsetMs: 0, endOffsetMs: 1000, durationMs: 1000,
    rps: report.rps, latency: report.latency, caseRows: report.caseRows, requests: report.requests, httpExchanges: report.httpExchanges }];
  report.timeline.buckets = [{ startOffsetMs: 0, endOffsetMs: 1000, rps: report.rps, latency: report.latency,
    caseRows: report.caseRows, requests: report.requests, httpExchanges: report.httpExchanges,
    sources: [{ phase: "measurement", stageId: "private-stage", caseRows: report.caseRows, requests: report.requests, httpExchanges: report.httpExchanges }] }];
  report.nodes = [{ key: "private-key", workflowId: "private-flow", nodeId: "private-node", other: false, visits: 1, passed: 1, failed: 0, aborted: 0, skipped: 0,
    requests: report.requests, requestLatency: report.latency, nodeLatency: report.latency }];
  report.lifecycle = [{ role: "setup", vuId: "private-vu", state: "passed", durationMs: 5 }];
  return report;
}
export function debugHistory(): DebugHistoryRecord {
  const startedAt = "2026-11-01T00:00:00.000Z"; const finishedAt = "2026-11-01T00:00:01.000Z";
  return { formatVersion: 2, historyId: "40000000-0000-4000-8000-000000000001", createdAt: startedAt, result: {
    runId: "private-debug-run", source: { sourceKind: "unavailable" }, sourceProjectRevision: "r1", executionSnapshotRevision: "r1", mode: "request", startedAt, finishedAt,
    run: { collectionName: title, startedAt, finishedAt, total: 1, passed: 0, failed: 1 },
    outcomes: [{ apiName: "调试请求", caseName: "调试单项", passed: false, durationMs: 15, assertions: [{ pass: false, message: "保留调试失败" }], failureKind: "http", evidence: executionEvidence() }],
    exchanges: [], exchangeTotal: 1, omittedExchangeCount: 1,
    replay: { mode: "request", sourceKind: "asset", parameters: {}, fields: [], available: false }, console: [], warnings: [],
  } };
}
export function safeReport(): PublicArtifactDto {
  const dto = safeDocument(); delete dto.document; dto.kind = "report";
  const source = stressReport();
  const { iterations, requests, httpExchanges, caseRows, phases, timeline, nodes, lifecycle, load, statistics, completeness, rps, latency, scriptLatency, iterationLatency } = source;
  const report: ReportViewDto = { sourceCategory: "stress", startedAt: "2026-11-01T00:00:00.000Z", finishedAt: "2026-11-01T00:00:01.000Z", verdict: "passed",
    counts: [{ labelCode: "case.rows", total: 2, passed: 1, failed: 1 }], failures: [{ category: "transport", count: 1 }],
    nodes: [{ id: "node-1", name: "节点1", state: "passed", durationMs: 10 }], trace: [{ nodeId: "node-1", type: "recovered" }],
    evidence: [{ nodeId: "node-1", status: "available", responseBody: "公开正文" }],
    stress: { iterations, requests, httpExchanges, caseRows, phases, timeline, nodes, lifecycle, load, statistics, completeness, rps, latency, scriptLatency, iterationLatency },
    comparison: { directlyComparable: true, mismatches: [], notices: [], metrics: Object.fromEntries(["rps", "p95Ms", "errorRate", "iterationsCompleted", "iterationP95Ms", "dropped"].map((key) => [key, { base: 1, candidate: 1, absolute: 0, relative: 0 }])) as NonNullable<ReportViewDto["comparison"]>["metrics"] },
  };
  dto.report = report; return dto;
}

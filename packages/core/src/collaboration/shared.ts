import { z } from "zod";
import { JsonValueSchema, SchemaNodeSchema } from "../contract/schemaNode.js";
import { EvidenceIdentitySchema, SafeExecutionEvidenceSchema, StressReportWireSchema } from "../stress/model.js";
import { StressReportV2WireSchema, StressCompletenessWireSchema, StressPhaseSummaryWireSchema } from "../stress/reportV2.js";
import { StressComparisonSchema } from "../stress/compare.js";
import { DebugHistoryRecordSchema, DebugResultSchema } from "../debug/model.js";
import { WorkflowStatusSchema } from '../workflow/model.js';
import { HttpMethodSchema } from "../domain/primitives.js";
import { MockConditionSchema, MockRuleSchema } from "../mock/config.js";
import { StringRecordSchema } from "../contract/schemaNode.js";

const pointerPattern = /^(?:\/(?:[^~]|~[01])*)?$/;
const headerPattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// JSON Schema maxLength counts Unicode code points. The runtime check deliberately
// does the same, rather than Zod's JS UTF-16 code-unit .max implementation.
const sensitiveName = z.string().refine((value) => [...value].length <= 256, "Sensitive rule exceeds 256 Unicode code points")
  .meta({ apiccJsonWireSchema: z.string().max(256) });
const sensitivePointer = z.string().refine((value) => [...value].length <= 256, "Sensitive pointer exceeds 256 Unicode code points").regex(pointerPattern)
  .meta({ apiccJsonWireSchema: z.string().max(256).regex(pointerPattern) });
const sensitivePolicyShape = { extraSensitiveHeaders: z.array(z.string().max(256).regex(headerPattern)).max(200),
  extraSensitiveQuery: z.array(sensitiveName).max(200), extraSensitiveFields: z.array(sensitiveName).max(200), extraSensitivePointers: z.array(sensitivePointer).max(200) };
export const ContractFilesWireSchema = z.array(z.object({ path: z.string(), content: z.string() }).strict());

const ParameterSchema = z.object({ id: z.string(), location: z.enum(["path", "query", "header", "cookie"]), name: z.string(),
  schema: SchemaNodeSchema, required: z.boolean(), enabled: z.boolean(), description: z.string(), value: z.string().optional() }).strict();
const ExampleSchema = z.object({ id: z.string(), name: z.string(), value: JsonValueSchema }).strict();
const ResponseSchema = z.object({ id: z.string(), status: z.string(), description: z.string(),
  headers: z.array(z.object({ name: z.string(), value: z.string() }).strict()),
  content: z.array(z.object({ mediaType: z.string(), schema: SchemaNodeSchema.optional(), examples: z.array(ExampleSchema) }).strict()) }).strict();
const BodySchema = z.object({ kind: z.enum(["none", "json", "xml", "text", "graphql", "urlencoded", "multipart", "binary"]),
  content: z.string().optional(), schema: SchemaNodeSchema.optional(),
  fields: z.array(z.object({ name: z.string(), value: z.string(), enabled: z.boolean() }).strict()).optional() }).strict();
const componentIdentity = { id: z.string(), name: z.string(), description: z.string() };
const ComponentSchema = z.discriminatedUnion("kind", [
  z.object({ ...componentIdentity, kind: z.literal("parameter"), parameter: ParameterSchema.omit({ id: true, enabled: true, value: true }) }).strict(),
  z.object({ ...componentIdentity, kind: z.literal("response"), response: ResponseSchema.omit({ id: true }) }).strict(),
  z.object({ ...componentIdentity, kind: z.literal("example"), example: ExampleSchema.omit({ id: true }) }).strict(),
  z.object({ ...componentIdentity, kind: z.literal("auth"), scheme: z.enum(["none", "bearer", "basic", "apikey", "unresolved"]) }).strict(),
]);
export const DocumentViewDtoSchema = z.object({
  apis: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), tags: z.array(z.string()), version: z.string(),
    status: z.enum(["draft", "published", "deprecated"]), collection: z.string(), folders: z.array(z.string()),
    request: z.object({ protocol: z.enum(["http", "websocket", "soap"]), method: z.string().optional(), path: z.string(),
      parameters: z.array(ParameterSchema), body: BodySchema.optional() }).strict(),
    responses: z.array(ResponseSchema), documentation: z.string(),
    caseSummaries: z.array(z.object({ name: z.string(), scope: z.string(), assertionCount: z.number() }).strict()),
    modelIds: z.array(z.string()), componentIds: z.array(z.string()),
  }).strict()),
  models: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), schema: SchemaNodeSchema }).strict()),
  components: z.array(ComponentSchema),
}).strict();
export const PublicationSourceSchema = z.object({ trust: z.enum(["server-archive", "member-claim", "saved-contract"]), revision: z.string(), digest: z.string() }).strict();
export const LimitationSchema = z.object({ code: z.string(), path: z.string().optional() }).strict();
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const publicStress = StressReportV2WireSchema.pick({ iterations: true, requests: true, httpExchanges: true, caseRows: true,
  timeline: true, nodes: true, lifecycle: true, load: true, statistics: true, rps: true, latency: true, scriptLatency: true, iterationLatency: true })
  .extend({ phases: z.array(StressPhaseSummaryWireSchema), completeness: StressCompletenessWireSchema });
export const ReportViewDtoSchema = z.object({ sourceCategory: z.enum(["run", "stress", "debug"]), startedAt: z.string(), finishedAt: z.string(), verdict: z.string(),
  counts: z.array(z.object({ labelCode: z.string(), total: count, passed: count.optional(), failed: count.optional(), skipped: count.optional() }).strict()),
  failures: z.array(z.object({ category: z.string(), count }).strict()),
  nodes: z.array(z.object({ id: z.string(), name: z.string(), state: z.string(), durationMs: z.number().nonnegative().optional(), failureKind: z.string().optional(), message: z.string().optional() }).strict()),
  trace: z.array(z.object({ nodeId: z.string().optional(), type: z.string(), state: z.string().optional(), message: z.string().optional(), delayMs: z.number().optional(), attempt: z.number().optional() }).strict()),
  evidence: z.array(z.object({ nodeId: z.string(), status: z.enum(["available", "missing", "not-collected", "masked", "truncated", "unsupported"]), requestBody: z.string().optional(), responseBody: z.string().optional() }).strict()),
  stress: publicStress.optional(), comparison: StressComparisonSchema.optional(),
}).strict();
const caseLocator = z.object({ collectionId: z.string(), folderIds: z.array(z.string()), apiId: z.string(), caseId: z.string(), scope: z.string() }).strict();
const invocationPath = z.array(z.object({ workflowId: z.string(), nodeId: z.string().optional(), branchId: z.string().optional(), iteration: z.number().optional(), handler: z.enum(["onError", "finally"]).optional() }).strict());
const invocationFields = { invocationId: z.string().optional(), parentInvocationId: z.string().optional(), invocationPath: invocationPath.optional(), nodeVisitId: z.string().optional(), attempt: z.number().optional() };
const caseOutcome = z.object({ ...invocationFields, evidence: SafeExecutionEvidenceSchema.optional(), entryId: z.string().optional(), suiteRow: z.number().optional(),
  apiId: z.string(), apiName: z.string(), caseId: z.string(), caseName: z.string(), row: z.number().optional(), locator: caseLocator.optional(), scope: z.string().optional(),
  nodeId: z.string().optional(), passed: z.boolean(), skipped: z.boolean().optional(), skipReason: z.string().optional(), durationMs: z.number().nonnegative(),
  assertions: z.array(z.object({ pass: z.boolean(), message: z.string(), kind: z.enum(["config", "assertion"]).optional(), code: z.string().optional(), differencePath: z.string().optional(), schemaPath: z.string().optional() }).strict()),
  error: z.string().optional(), failureKind: z.string().optional(),
}).strict();
const traceEvent = z.object({ ...invocationFields, entryId: z.string().optional(), suiteRow: z.number().optional(), type: z.string(), nodeId: z.string().optional(), branchId: z.string().optional(), iteration: z.number().optional(),
  state: z.string().optional(), cause: z.string().optional(), code: z.string().optional(), failureKind: z.string().optional(),
  childInvocation: z.object({ invocationId: z.string(), parentInvocationId: z.string().optional(), invocationPath }).strict().optional(), delayMs: z.number().optional(), message: z.string().optional(),
}).strict();
const summaryCounts = { total: count, passed: count, failed: count, skipped: count };
const workflowUnit = z.object({ entryId: z.string(), suiteRow: z.number().optional(), workflowId: z.string(), invocationId: z.string().optional(), verdict: z.enum(["passed", "failed", "aborted", "skipped"]), error: z.string().optional() }).strict();
export const RunReportInputWireSchema = z.object({ reportingMode: z.enum(["workflow-invocation-v2", "mixed-suite-v2"]).optional(), workflowUnits: z.array(workflowUnit).optional(),
  requestFacts: z.object({ requestStarted: count, requestCompleted: count, httpExchanges: count }).strict().optional(),
  trace: z.object({ events: z.array(traceEvent), totalEvents: count, truncated: z.boolean() }).strict().optional(),
  executionIdentity: EvidenceIdentitySchema.optional(),
  evidenceOmitted: z.boolean().optional(), reportFailure: z.boolean().optional(), kind: z.enum(["collection", "workflow", "suite"]).optional(), projectId: z.string().optional(), definitionRevision: z.string().optional(), workflowId: z.string().optional(),
  workflow: z.object({ verdict: z.enum(["passed", "failed", "aborted"]).optional(), ...summaryCounts, entries: z.array(z.object({ entryId: z.string(), kind: z.literal("workflow"), workflowId: z.string(), suiteRow: z.number().optional(), nodeKind: z.string().optional(), label: z.string().optional(), state: z.string().optional(), skipReason: z.string().optional(), failureKind: z.string().optional(), status: z.enum(["passed", "failed", "skipped"]), error: z.string().optional() }).strict()) }).strict().optional(),
  reportingUnits: z.object({ ...summaryCounts, entryDiagnostics: count }).strict().optional(),
  suite: z.object({ suiteRunId: z.string(), projectId: z.string(), definitionRevision: z.string(), environmentId: z.string().optional(), datasetId: z.string().optional(), dataDigest: z.string().optional(), verdict: z.enum(["passed", "failed", "aborted"]), ...summaryCounts,
    entries: z.array(z.object({ entryId: z.string(), kind: z.enum(["case", "workflow"]), workflowId: z.string().optional(), caseLocator: caseLocator.optional(), suiteRow: z.number().optional(), status: z.enum(["passed", "failed", "skipped", "aborted"]), skipReason: z.enum(["fail-fast", "aborted"]).optional(), error: z.string().optional() }).strict()).optional(),
  }).strict().optional(),
  collectionId: z.string(), collectionName: z.string(), envName: z.string().optional(), startedAt: z.string(), finishedAt: z.string(),
  total: count, passed: count, failed: count, skipped: count.optional(), cases: z.array(caseOutcome), warnings: z.array(z.string()).optional(),
}).strict();
// Exact existing Core workflow output shape, not an execution-host dependency or
// a new report algorithm. Recursive children retain their real output identities.
const workflowIdentity = { invocationId: z.string().optional(), parentInvocationId: z.string().optional(), invocationPath: invocationPath.optional() };
const failureCause = z.enum(["failure", "user-abort", "root-timeout", "ancestor-cancel", "or-superseded", "node-timeout", "handler-timeout", "cleanup-timeout", "invocation-timeout", "limit"]);
const workflowFailure = z.object({ code: z.string(), cause: failureCause, message: z.string(), failureKind: z.enum(["transport", "http", "script", "assertion", "extraction", "config", "aborted"]) }).strict();
const fullInvocation = z.object({ invocationId: z.string(), parentInvocationId: z.string().optional(), invocationPath }).strict();
const workflowPolicyEvent = z.union([
  z.object({ type: z.enum(["attempt-start", "attempt-end"]), attempt: count, state: z.enum(["passed", "failed"]).optional() }).strict(),
  z.object({ type: z.literal("retry-wait"), attempt: count, delayMs: z.number().nonnegative() }).strict(),
  z.object({ type: z.enum(["handler-start", "cleanup-start"]), invocation: fullInvocation }).strict(),
  z.object({ type: z.enum(["handler-end", "cleanup-end"]), state: z.enum(["passed", "failed"]) }).strict(),
  z.object({ type: z.enum(["handler-skipped", "cleanup-skipped"]), cause: failureCause }).strict(),
  z.object({ type: z.literal("recovered") }).strict(),
]);
export const WorkflowReportInputWireSchema: z.ZodType = z.lazy(() => z.object({
  ...workflowIdentity, reportingMode: z.literal("workflow-invocation-v2").optional(),
  requestFacts: RunReportInputWireSchema.shape.requestFacts, trace: RunReportInputWireSchema.shape.trace, report: RunReportInputWireSchema.optional(),
  workflowId: z.string(), workflowName: z.string(), status: WorkflowStatusSchema,
  nodeResults: z.array(z.object({ ...invocationFields, nodeId: z.string(), label: z.string().optional(),
    kind: z.enum(["request", "noop", "assign", "delay", "assert", "condition", "subflow", "loop", "parallel"]), state: z.enum(["passed", "failed", "skipped", "noop"]),
    outcomes: z.array(caseOutcome).optional(), outcome: caseOutcome.optional(), error: z.string().optional(),
    skipReason: z.enum(["condition-pruned", "upstream-failed", "fail-fast", "reference-missing", "reference-invalid", "unreachable", "aborted"]).optional(), failureKind: workflowFailure.shape.failureKind.optional(),
    primaryError: workflowFailure.optional(), secondaryErrors: z.array(workflowFailure).optional(), recoveredError: workflowFailure.optional(),
    attempts: z.array(z.object({ attempt: count, state: z.enum(["passed", "failed"]), error: workflowFailure.optional() }).strict()).optional(), policyEvents: z.array(workflowPolicyEvent).optional(),
    policyInvocations: z.array(z.object({ role: z.enum(["onError", "finally"]), result: WorkflowReportInputWireSchema }).strict()).optional(), childInvocations: z.array(WorkflowReportInputWireSchema).optional(),
    branches: z.array(fullInvocation.extend({ branchId: z.string(), state: z.enum(["passed", "failed", "cancelled"]), winner: z.boolean(), cause: failureCause.optional(), cleanupFailed: z.boolean().optional() })).optional(),
  }).strict()), ...summaryCounts, verdict: z.enum(["passed", "failed", "aborted"]).optional(), warnings: z.array(z.string()), startedAt: z.string(), finishedAt: z.string(),
}).strict());
const archivedExecution = { executionId: z.string(), verdict: z.enum(["passed", "failed", "cancelled", "timed-out", "interrupted", "rejected"]),
  executionFact: z.enum(["not-started", "started", "uncertain"]), pid: z.number().int().positive().optional(), reasonCode: z.string().optional(),
  // Structural observation only; no process-topology inference or new budget.
  processObservation: z.object({ completeness: z.enum(["complete", "partial"]), started: count, exited: count, peak: count }).strict().optional() };
export const ArchivedRunExecutionWireSchema = z.object({ ...archivedExecution, output: z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("suite"), result: RunReportInputWireSchema }).strict(),
  z.object({ kind: z.literal("failure"), targetKind: z.enum(["debug", "suite", "workflow"]), result: RunReportInputWireSchema, error: z.string() }).strict(),
  z.object({ kind: z.literal("debug"), result: DebugResultSchema }).strict(),
  z.object({ kind: z.literal("workflow"), result: WorkflowReportInputWireSchema }).strict(),
]) }).strict();
export const ArchivedStressExecutionWireSchema = z.object({ ...archivedExecution,
  output: z.object({ kind: z.literal("stress"), result: StressReportV2WireSchema }).strict() }).strict();
export const ArchiveReportWireSchema = z.discriminatedUnion("format", [
  z.object({ format: z.literal("run"), body: z.union([RunReportInputWireSchema, ArchivedRunExecutionWireSchema]) }).strict(),
  z.object({ format: z.literal("stress"), body: z.union([StressReportV2WireSchema, StressReportWireSchema, ArchivedStressExecutionWireSchema]), baseline: z.union([StressReportV2WireSchema, StressReportWireSchema]).optional() }).strict(),
  z.object({ format: z.literal("debug"), body: DebugHistoryRecordSchema }).strict(),
]);
export const ArchivePublicationInputWireSchema = z.object({ sourceKind: z.literal("server-archive"), title: z.string(), source: z.object({ revision: z.string(), digest: z.string() }).strict(),
  report: ArchiveReportWireSchema, redaction: z.enum(["verified", "unavailable"]), privateMarkers: z.array(z.string()),
}).strict();
const CompiledMockRuleSchema = z.object({ id: z.string(), contractId: z.string(), responseBindingId: z.string(),
  conditions: z.array(MockConditionSchema), status: MockRuleSchema.shape.status.unwrap(), mediaType: MockRuleSchema.shape.mediaType,
  headers: StringRecordSchema(z.string()), body: z.array(z.number().int().min(0).max(255)), delayMs: MockRuleSchema.shape.delayMs,
  excludedResponseHeaders: z.array(z.string()).optional(),
}).strict();
export const CompiledMockPlanSchema = z.object({ sourceProjectRevision: z.string(), routes: z.array(z.object({ contractId: z.string(), method: HttpMethodSchema,
  pathTemplate: z.string(), segments: z.array(z.discriminatedUnion("kind", [z.object({ kind: z.literal("literal"), value: z.string() }).strict(), z.object({ kind: z.literal("parameter"), name: z.string() }).strict()])),
  rules: z.array(CompiledMockRuleSchema),
}).strict()) }).strict();
export const SharedMockPolicySchema = z.object({ maxResponseBytes: z.number().int().min(1024).max(8_388_608), maxDelayMs: z.number().int().min(0).max(30_000),
  requestDeadlineMs: z.number().int().min(1000).max(120_000), ...sensitivePolicyShape,
}).strict();
export const MockDiagnosticSchema = z.object({ severity: z.enum(["warning", "error"]), code: z.string(), path: z.string(), message: z.string(), lossy: z.boolean(), ownerId: z.string().optional() }).strict();
export const AssetMutationInputWireSchema = z.object({ beforeFiles: ContractFilesWireSchema, afterFiles: ContractFilesWireSchema,
  initialContractProjectId: z.string().uuid().optional() }).strict();
export const AssetMutationResultSchema = z.object({ scriptChanged: z.boolean(), locations: z.array(z.string()) }).strict();
export const CompileMockInputWireSchema = z.object({ files: ContractFilesWireSchema, maxResponseBytes: SharedMockPolicySchema.shape.maxResponseBytes.optional() }).strict();
export const CompileMockResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), plan: CompiledMockPlanSchema }).strict(),
  z.object({ ok: z.literal(false), diagnostics: z.array(MockDiagnosticSchema) }).strict(),
]);
const WireBytesSchema = z.array(z.number().int().min(0).max(255));
export const MockEvaluationInputWireSchema = z.object({ method: z.string(), target: z.string(), headers: StringRecordSchema(z.string()), body: WireBytesSchema }).strict();
export const MockEvaluationResultWireSchema = z.object({ status: MockRuleSchema.shape.status.unwrap(), mediaType: z.string(), headers: StringRecordSchema(z.string()), body: WireBytesSchema,
  delayMs: MockRuleSchema.shape.delayMs, ruleId: z.string().optional(), routeTemplate: z.string().optional(), reason: z.string(), contractId: z.string().optional(), responseBindingId: z.string().optional(),
}).strict();
const artifactShape = { formatVersion: z.literal(1), title: z.string(),
  summary: z.array(z.object({ labelCode: z.string(), value: z.union([z.string(), z.number(), z.boolean(), z.null()]), unit: z.string().optional() }).strict()),
  limitations: z.array(LimitationSchema) };
function artifactSchema<Source extends z.ZodType>(source: Source) {
  return z.discriminatedUnion("kind", [
    z.object({ ...artifactShape, source, kind: z.literal("document"), document: DocumentViewDtoSchema }).strict(),
    z.object({ ...artifactShape, source, kind: z.literal("report"), report: ReportViewDtoSchema }).strict(),
    z.object({ ...artifactShape, source, kind: z.literal("debug-history"), report: ReportViewDtoSchema }).strict(),
  ]);
}
export const PublicArtifactDtoSchema = artifactSchema(PublicationSourceSchema);
const memberArtifact = artifactSchema(PublicationSourceSchema.extend({ trust: z.literal("member-claim") }));
export const PublicationScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project") }).strict(),
  z.object({ kind: z.literal("collections"), collectionIds: z.array(z.string()) }).strict(),
  z.object({ kind: z.literal("apis"), contractIds: z.array(z.string()) }).strict(),
  z.object({ kind: z.literal("tags"), tags: z.array(z.string()) }).strict(),
  z.object({ kind: z.literal("folders"), folders: z.array(z.object({ collectionId: z.string(), folderIds: z.array(z.string()) }).strict()) }).strict(),
]);
export const DocumentPublicationInputSchema = z.object({ sourceKind: z.literal("saved-contract"), title: z.string(),
  source: PublicationSourceSchema.omit({ trust: true }), files: ContractFilesWireSchema, scope: PublicationScopeSchema }).strict();
export const MemberPublicationInputSchema = z.object({ sourceKind: z.literal("member-upload"), artifact: memberArtifact }).strict();
export const PublicationInputSchema = z.discriminatedUnion("sourceKind", [DocumentPublicationInputSchema, MemberPublicationInputSchema, ArchivePublicationInputWireSchema]);
export const ProjectionPolicySchema = z.object({ revision: z.number().int().min(1), includeEvidence: z.boolean(),
  maxFieldBytes: z.number().int().min(256).max(65536), maxEvidenceBytes: z.number().int().min(4096).max(8_388_608),
  maxArtifactBytes: z.number().int().min(65536).max(33_554_432),
  ...sensitivePolicyShape,
}).strict();
export type * from "./types.js";
export type AssetMutationInputWire = z.infer<typeof AssetMutationInputWireSchema>;
export type AssetMutationResult = z.infer<typeof AssetMutationResultSchema>;
export type CompileMockInputWire = z.infer<typeof CompileMockInputWireSchema>;
export type CompileMockResultWire = z.infer<typeof CompileMockResultSchema>;
export type MockEvaluationInputWire = z.infer<typeof MockEvaluationInputWireSchema>;
export type MockEvaluationResultWire = z.infer<typeof MockEvaluationResultWireSchema>;

import { z } from "zod";
import { ContractProjectSchema, JsonValueSchema, DebugResultSchema, DebugOutcomeSchema, SecretRefSchema, StressReportV2Schema } from "@apicc/core/schema";
import { CredentialMutationResultSchema, CredentialStatusResultSchema } from "../credentials.js";
import { EntityIdSchema, ServerProjectScopeSchema, TaskTargetSchema, RunConfigSchema, FixedMaterialSelectionSchema, AssetDeltaSchema, FixedNetworkInputSchema, ProjectAssetsSchema, TaskEnvelopeV1Schema, ProjectExecutionAgentsSchema, StressExecutionMetadataSchema, RuntimeRegistrationSchema, ConfigVersionSchema, CredentialMetadataSchema, AttachmentMetadataSchema, AttachmentWriteSchema } from "@apicc/execution/contract";
import type { InvocationOutput } from "@apicc/execution/host";
import {StressProcessObservationSchema,StressCapacityWaitSchema,processObservationFitsBudget} from '@apicc/execution/contract';

export const OnlineExecutionContextSchema = z.object({ serverId: z.string().url(), ownerId: EntityIdSchema, scope: ServerProjectScopeSchema }).strict();
export type OnlineExecutionContext = z.infer<typeof OnlineExecutionContextSchema>;
export const ExecutionLocationSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("local") }).strict(), z.object({ kind: z.literal("agent"), agentId: EntityIdSchema }).strict()]);
export type ExecutionLocation = z.infer<typeof ExecutionLocationSchema>;
const base = { context: OnlineExecutionContextSchema };
export const OnlineExecutionInputSchema = z.discriminatedUnion("operation", [
  z.object({ ...base, operation: z.literal("assets") }).strict(),
  z.object({ ...base, operation: z.literal("save"), delta: AssetDeltaSchema }).strict(),
  z.object({ ...base, operation: z.literal("saveProject"), project: ContractProjectSchema, expectedVersion: ConfigVersionSchema }).strict(),
  z.object({ ...base, operation: z.literal("publish"), project: ContractProjectSchema }).strict(),
  z.object({ ...base, operation: z.literal("publishNew"), name: z.string().min(1).max(128), project: ContractProjectSchema }).strict(),
  z.object({ ...base, operation: z.literal("agents") }).strict(),
  z.object({ ...base, operation: z.literal("datasetImport"), content: z.string().max(10 * 1024 * 1024), format: z.enum(["csv", "json"]) }).strict(),
  z.object({ ...base, operation: z.literal("datasetExport"), datasetId: z.string().uuid(), format: z.enum(["csv", "json"]) }).strict(),
  z.object({ ...base, operation: z.literal("materials") }).strict(),
  z.object({ ...base, operation: z.literal("attachmentUpload"), attachment: AttachmentWriteSchema }).strict(),
  z.object({ ...base, operation: z.literal("credential"), action: z.enum(["status", "put", "remove"]), ref: SecretRefSchema, storage: z.enum(["project", "local"]), contractProjectId: z.string().uuid(), value: z.string().optional() }).strict(),
  z.object({ ...base, operation: z.literal("run"), runId: z.string().uuid(), location: ExecutionLocationSchema, target: TaskTargetSchema, expectedVersion: ConfigVersionSchema, environmentId: z.string().uuid().optional(), debugSessionId: z.string().min(1).optional(), runConfig: RunConfigSchema, materials: FixedMaterialSelectionSchema, localOnlyRefIds: z.array(z.string()), network: FixedNetworkInputSchema.optional() }).strict(),
  z.object({ ...base, operation: z.literal("list"), limit: z.number().int().min(1).max(100), beforeJobId: EntityIdSchema.optional() }).strict(),
  z.object({ ...base, operation: z.enum(["status", "cancel", "report"]), location: ExecutionLocationSchema, runId: z.string().min(1) }).strict(),
]);
export type OnlineExecutionInput = z.infer<typeof OnlineExecutionInputSchema>;
export const OnlineProjectViewSchema = z.object({ assets: ProjectAssetsSchema, project: ContractProjectSchema.nullable(), problems: z.array(z.string()) }).strict();
export type OnlineProjectView = z.infer<typeof OnlineProjectViewSchema>;
export const OnlineJobSchema = z.object({ jobId: EntityIdSchema, executionId: EntityIdSchema, agentId: EntityIdSchema,
  state: z.enum(["queued", "preparing", "running", "ended"]), cancelState: z.enum(["none", "requested", "confirmed"]),
  executionReleased: z.boolean(), reportState: z.enum(["none", "pending", "archived", "expired"]), task: TaskEnvelopeV1Schema,
  reportKind: z.enum(['stress', 'stress-failure', 'stress-fault']).optional(),
  stressMetadata: StressExecutionMetadataSchema.optional(), capacityWaitReason: z.string().min(1).max(512).optional(),capacityWait:StressCapacityWaitSchema.optional(),
  canCancel: z.boolean().optional(), scriptTimeoutMs: z.number().int().positive().safe().optional(),
  summary: z.record(z.string(), JsonValueSchema).optional(), progress: z.record(z.string(), JsonValueSchema).optional(),
}).strict();
export type OnlineJob = z.infer<typeof OnlineJobSchema>;
// Validate the structures consumed by the viewers, without reproducing Core execution logic.
// Unknown JSON metadata remains intact for compatible historical results.
const count = z.number().int().nonnegative().safe();
const pathSegment = z.object({ workflowId: z.string(), nodeId: z.string().optional(), branchId: z.string().optional(), iteration: count.optional(), handler: z.enum(['onError', 'finally']).optional() }).passthrough();
const identity = { invocationId: z.string().optional(), parentInvocationId: z.string().optional(), invocationPath: z.array(pathSegment).optional(), nodeVisitId: z.string().optional(), attempt: count.optional() };
const outcome = z.object({ ...identity, apiId: z.string(), apiName: z.string(), caseId: z.string(), caseName: z.string(), passed: z.boolean(), skipped: z.boolean().optional(), durationMs: z.number().finite().nonnegative(), assertions: z.array(z.object({ pass: z.boolean(), message: z.string() }).passthrough()), error: z.string().optional(), evidence: DebugOutcomeSchema.shape.evidence }).passthrough();
const totals = { total: count, passed: count, failed: count, skipped: count.optional() };
const requestFacts = z.object({ requestStarted: count, requestCompleted: count, httpExchanges: count }).passthrough();
const failure = z.object({ code: z.string(), cause: z.string(), message: z.string() }).passthrough();
const trace = z.object({ events: z.array(z.object({ ...identity, type: z.string(), state: z.string().optional(), cause: z.string().optional(), code: z.string().optional(), message: z.string().optional(), iteration: count.optional(), attempt: count.optional(), childInvocation: z.object(identity).passthrough().optional() }).passthrough()), totalEvents: count, truncated: z.boolean() }).passthrough();
const entry = z.object({ entryId: z.string(), status: z.enum(['passed', 'failed', 'skipped', 'aborted']), error: z.string().optional() }).passthrough();
const runResult = z.object({ ...totals, collectionId: z.string(), collectionName: z.string(), startedAt: z.string(), finishedAt: z.string(), cases: z.array(outcome), warnings: z.array(z.string()).optional(), requestFacts: requestFacts.optional(), reportFailure: z.boolean().optional(),
  workflowUnits: z.array(z.object({ entryId: z.string(), workflowId: z.string(), verdict: z.enum(['passed', 'failed', 'skipped', 'aborted']), error: z.string().optional() }).passthrough()).optional(),
  reportingUnits: z.object({ ...totals, skipped: count, entryDiagnostics: count }).passthrough().optional(),
  suite: z.object({ ...totals, verdict: z.enum(['passed', 'failed', 'aborted']), entries: z.array(entry).optional() }).passthrough().optional(),
  workflow: z.object({ ...totals, verdict: z.enum(['passed', 'failed', 'aborted']).optional(), entries: z.array(entry) }).passthrough().optional(),
}).passthrough();
const workflowResult: z.ZodType = z.lazy(() => z.object({ ...identity, ...totals, workflowId: z.string(), workflowName: z.string(), status: z.string(), startedAt: z.string(), finishedAt: z.string(), verdict: z.enum(['passed', 'failed', 'aborted']).optional(), warnings: z.array(z.string()), requestFacts: requestFacts.optional(), trace: trace.optional(), report: runResult.optional(),
  nodeResults: z.array(z.object({ ...identity, nodeId: z.string(), kind: z.string(), state: z.enum(['passed', 'failed', 'skipped', 'noop']), label: z.string().optional(), error: z.string().optional(), outcomes: z.array(outcome).optional(), outcome: outcome.optional(), primaryError: failure.optional(), recoveredError: failure.optional(), secondaryErrors: z.array(failure).optional(),
    attempts: z.array(z.object({ attempt: count, state: z.enum(['passed', 'failed']), error: failure.optional() }).passthrough()).optional(),
    branches: z.array(z.object({ ...identity, branchId: z.string(), state: z.string(), winner: z.boolean() }).passthrough()).optional(),
    policyEvents: z.array(z.object({ type: z.string(), cause: z.string().optional() }).passthrough()).optional(),
    childInvocations: z.array(workflowResult).optional(), policyInvocations: z.array(z.object({ role: z.enum(['onError', 'finally']), result: workflowResult }).passthrough()).optional(),
  }).passthrough()),
}).passthrough());
export const InvocationOutputSchema = z.custom<InvocationOutput>(value => {
  if (!JsonValueSchema.safeParse(value).success) return false;
  if (value && typeof value === 'object' && 'kind' in value) {
    if (value.kind === 'stress') return 'result' in value && StressReportV2Schema.safeParse(value.result).success;
    if (value.kind === 'stress-failure') return z.object({ kind: z.literal('stress-failure'), error: z.string(), started: z.boolean(), requests: z.object({ started: count, completed: count }).strict() }).strict().safeParse(value).success;
  }
  if (!value || typeof value !== "object" || !("kind" in value) || !("result" in value) || !value.result || typeof value.result !== "object") return false;
  const result = value.result as Record<string, unknown>;
  if (value.kind === "debug") return DebugResultSchema.safeParse(result).success;
  if (value.kind === "workflow") return workflowResult.safeParse(result).success;
  return (value.kind === "suite" || value.kind === "failure" && 'error' in value && typeof value.error === 'string' && 'targetKind' in value && ['debug', 'suite', 'workflow'].includes(String(value.targetKind))) && runResult.safeParse(result).success;
}, { message: 'invalid-core-output' });
export const OnlineReportSchema = z.object({ executionId: z.string().min(1), verdict: z.string(), executionFact: z.enum(["not-started", "started", "uncertain"]).optional(), reasonCode: z.string().optional(), pid: z.number().int().positive().optional(), output: InvocationOutputSchema.optional(),processObservation:StressProcessObservationSchema.optional() }).strict();
export type OnlineReport = z.infer<typeof OnlineReportSchema>;
export const OnlineLocalStressSchema = z.object({ workerCount: z.number().int().positive().max(1000), processBudget: z.number().int().positive().max(1001), runtime: RuntimeRegistrationSchema.pick({ coreBuildId: true, scriptApiId: true, nodeVersion: true, v8Version: true, runtimeCompatibilityId: true }),processObservation:StressProcessObservationSchema.optional() }).strict().refine(value => value.processBudget === (value.workerCount === 1 ? 1 : value.workerCount + 1), 'local stress process budget disagrees with worker count').refine(value=>!value.processObservation||processObservationFitsBudget(value.processObservation,value.processBudget),'observed local process topology exceeds the fixed budget');
export const OnlineLocalResultSchema = z.object({ location: z.object({ kind: z.literal("local") }).strict(), runId: z.string().uuid(), snapshotId: EntityIdSchema, manifestHash: z.string(), runtimeCompatibilityId: z.string(), scriptTimeoutMs: z.number().int().positive(), debugSessionId: z.string().optional(), localStress: OnlineLocalStressSchema.optional(), output: InvocationOutputSchema }).strict().superRefine((value, ctx) => {
  if (value.localStress && (!['stress', 'stress-failure'].includes(value.output.kind) || value.localStress.runtime.runtimeCompatibilityId !== value.runtimeCompatibilityId)) ctx.addIssue({ code: 'custom', path: ['localStress'], message: 'local stress metadata does not match the result identity' });
});
export type OnlineLocalResult = z.infer<typeof OnlineLocalResultSchema>;
export const OnlineMaterialsMetadataSchema = z.object({ credentials: z.array(CredentialMetadataSchema), attachments: z.array(AttachmentMetadataSchema) }).strict();
export const OnlineDatasetContentSchema = z.object({ columns: z.array(z.string()), rows: z.array(z.record(z.string(), JsonValueSchema)) }).strict();
export const OnlinePublishResultSchema = z.object({ scope: ServerProjectScopeSchema, view: OnlineProjectViewSchema }).strict();
export const OnlineExecutionResultSchema = z.union([OnlineProjectViewSchema, ProjectExecutionAgentsSchema, OnlineJobSchema, z.array(OnlineJobSchema), OnlineLocalResultSchema, OnlineReportSchema, OnlineMaterialsMetadataSchema, AttachmentMetadataSchema, CredentialMutationResultSchema, CredentialStatusResultSchema, OnlinePublishResultSchema, OnlineDatasetContentSchema, z.string()]);
export type OnlineExecutionResult = z.infer<typeof OnlineExecutionResultSchema>;
export interface OnlineExecutionPort { onlineExecution(input: OnlineExecutionInput): Promise<unknown> }

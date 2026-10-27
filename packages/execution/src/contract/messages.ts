import { z } from "zod";
import { AgentConfigSchema, PolicyConfigSchema, PositiveIntegerSchema, ConfigVersionSchema } from "./config.js";
import { EntityIdSchema, OpaqueIdSchema, HashSchema, TaskEnvelopeV1Schema, ScriptDispatchShape, ScriptRequirementSchema, checkScriptGrant } from "./task.js";

const nonNegative = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const JobMessageIdentityShape = { messageId: OpaqueIdSchema, jobId: EntityIdSchema, executionId: EntityIdSchema };
const credentialVersions = z.record(OpaqueIdSchema, OpaqueIdSchema);
export const JobPhaseSchema = z.enum(["preparing", "running", "finalizing", "uploading"]);
export const StartRejectionReasonSchema = z.enum(["submitter_unavailable", "forbidden", "project_forbidden", "agent_unavailable", "agent_not_associated", "script_mode_denied", "script_grant_missing", "script_grant_changed", "credential_version_conflict", "credential_missing", "policy_changed", "agent_capacity", "shared_capacity", "resource_capacity", "debug_session_expired"]);
export const AgentCommandV1Schema = z.discriminatedUnion("kind", [
  z.object({ ...JobMessageIdentityShape, kind: z.literal("cancel"), reason: z.string().min(1) }).strict(),
  z.object({ ...JobMessageIdentityShape, kind: z.literal("start-rejected"), reasonCode: StartRejectionReasonSchema }).strict(),
  z.object({ ...JobMessageIdentityShape, kind: z.literal("start-permit"), permitId: EntityIdSchema, policyVersion: ConfigVersionSchema, effectivePolicy: PolicyConfigSchema, ...ScriptDispatchShape, credentialVersions }).strict().superRefine(checkScriptGrant),
  z.object({ messageId: OpaqueIdSchema, kind: z.literal("apply-config"), configVersion: ConfigVersionSchema, config: AgentConfigSchema }).strict(),
]);
export const AgentMessageV1Schema = z.discriminatedUnion("kind", [
  z.object({ ...JobMessageIdentityShape, kind: z.literal("accepted") }).strict(),
  z.object({ ...JobMessageIdentityShape, kind: z.literal("start-request"), inputsDigest: HashSchema, policyVersion: ConfigVersionSchema, ...ScriptDispatchShape, scriptRequirements: z.array(ScriptRequirementSchema), credentialVersions }).strict().superRefine((m, ctx) => {
    checkScriptGrant(m, ctx);
    if (m.executionProfile === "no-script" && m.scriptRequirements.length) ctx.addIssue({ code: "custom", path: ["scriptRequirements"], message: "no-script profile has script requirements" });
  }),
  z.object({ ...JobMessageIdentityShape, kind: z.literal("started"), permitId: EntityIdSchema, startedAt: z.string().datetime() }).strict(),
  z.object({ ...JobMessageIdentityShape, kind: z.literal("progress"), sequence: PositiveIntegerSchema, phase: JobPhaseSchema, observedAt: z.string().datetime(), completedRequests: nonNegative, failedRequests: nonNegative }).strict().refine(m => m.failedRequests <= m.completedRequests, "failed requests exceed completed requests"),
  z.object({ ...JobMessageIdentityShape, kind: z.literal("completed"), verdict: z.enum(["passed", "failed", "cancelled", "timed-out", "interrupted", "rejected"]), finishedAt: z.string().datetime(), executionReleased: z.literal(true), evidenceComplete: z.boolean(), reportHash: HashSchema.optional(), reportBytes: nonNegative.optional(), reasonCode: OpaqueIdSchema.optional() }).strict().refine(m => (m.reportHash === undefined) === (m.reportBytes === undefined), "report hash and bytes must be supplied together"),
  z.object({ ...JobMessageIdentityShape, kind: z.literal("cancel-confirmed"), finishedAt: z.string().datetime(), executionReleased: z.literal(true), evidenceComplete: z.boolean() }).strict(),
]);
export const TaskDeliveryV1Schema = z.object({ messageId: OpaqueIdSchema, task: TaskEnvelopeV1Schema }).strict();
export const ControlBatchV1Schema = z.object({ deliveries: z.array(TaskDeliveryV1Schema), commands: z.array(AgentCommandV1Schema) }).strict();
export const ControlExchangeSchema = z.object({ sessionId: OpaqueIdSchema, appliedConfigVersion: ConfigVersionSchema, availableSlots: nonNegative, availableSharedDebugSlots: nonNegative, acknowledgements: z.array(OpaqueIdSchema) }).strict().refine(v => v.availableSharedDebugSlots <= v.availableSlots, "shared slots are a subset of total slots");
export const MessageAcknowledgementSchema = z.object({ acknowledged: z.array(OpaqueIdSchema) }).strict();
export type JobMessageIdentity = z.infer<z.ZodObject<typeof JobMessageIdentityShape>>;
export type AgentCommandV1 = z.infer<typeof AgentCommandV1Schema>;
export type AgentMessageV1 = z.infer<typeof AgentMessageV1Schema>;
export type TaskDeliveryV1 = z.infer<typeof TaskDeliveryV1Schema>;
export type ControlBatchV1 = z.infer<typeof ControlBatchV1Schema>;
export type ControlExchange = z.infer<typeof ControlExchangeSchema>;
export interface AgentControlTransport {
  exchange(input: ControlExchange, signal: AbortSignal): Promise<ControlBatchV1>;
  send(messages: readonly AgentMessageV1[], signal: AbortSignal): Promise<{ acknowledged: string[] }>;
}

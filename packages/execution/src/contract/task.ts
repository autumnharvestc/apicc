import { z } from "zod";
import { DebugInvocationSchema, JsonValueSchema } from "@apicc/core/schema";
import { ConfigVersionSchema } from "./config.js";

export const EntityIdSchema = z.string().regex(/^[1-9]\d*$/).refine(v => /^[1-9]\d*$/.test(v) && BigInt(v) <= 9223372036854775807n, "ID exceeds BIGINT");
export const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const OpaqueIdSchema = z.string().min(1).max(512);
export const ServerProjectScopeSchema = z.object({ workspaceId: EntityIdSchema, groupId: EntityIdSchema, projectId: EntityIdSchema }).strict();
export const ExecutionProfileSchema = z.enum(["no-script", "trusted-core-script"]);
export const DispatchKindSchema = z.enum(["shared-debug", "dedicated-task"]);
export const TaskTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("debug"), invocation: DebugInvocationSchema }).strict(),
  z.object({ kind: z.literal("suite"), suiteId: z.string().uuid(), datasetId: z.string().uuid().optional(), allowDraft: z.boolean() }).strict(),
  z.object({ kind: z.literal("workflow"), workflowId: z.string().uuid(), inputs: z.record(z.string(), JsonValueSchema).optional() }).strict(),
]);
export const ExecutionLocationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }).strict(),
  z.object({ kind: z.literal("agent"), agentId: EntityIdSchema }).strict(),
]);
export const ProjectRelativePathSchema = z.string().min(1).refine(p => !p.includes("\\") && !p.includes(":") && !p.startsWith("/") && p.split("/").every(segment => segment !== "" && segment !== "." && segment !== "..") && !/[\u0000-\u001f]/.test(p), "expected project-relative path");
export const ScriptRequirementSchema = z.object({
  scriptId: OpaqueIdSchema, contentHash: HashSchema,
  source: z.object({ filePath: ProjectRelativePathSchema, fileHash: HashSchema }).strict(),
  kind: z.enum(["pre", "post", "condition"]),
}).strict();
export const ScriptDispatchShape = {
  scriptPlanDigest: HashSchema, scriptGrantVersion: ConfigVersionSchema.optional(),
  executionProfile: ExecutionProfileSchema, runtimeCompatibilityId: OpaqueIdSchema,
};
export function checkScriptGrant(value: { executionProfile: string; scriptGrantVersion?: string }, ctx: z.RefinementCtx) {
  if (value.executionProfile === "trusted-core-script" && value.scriptGrantVersion === undefined) ctx.addIssue({ code: "custom", path: ["scriptGrantVersion"], message: "trusted scripts require a grant version" });
}
export const TaskEnvelopeV1Schema = z.object({
  protocolVersion: z.literal(1), jobId: EntityIdSchema, executionId: EntityIdSchema,
  scope: ServerProjectScopeSchema, submittedByUserId: EntityIdSchema, contractProjectId: z.string().uuid(),
  snapshotId: EntityIdSchema, manifestHash: HashSchema, target: TaskTargetSchema,
  debugSessionId: OpaqueIdSchema.optional(), environmentId: z.string().uuid().optional(),
  policyVersion: ConfigVersionSchema, requiredCoreBuildId: HashSchema,
  ...ScriptDispatchShape, dispatchKind: DispatchKindSchema,
  requiredCapabilities: z.array(OpaqueIdSchema).refine(c => new Set(c).size === c.length, "duplicate capability"),
}).strict().superRefine((task, ctx) => {
  checkScriptGrant(task, ctx);
  if (task.dispatchKind === "shared-debug" && (task.target.kind !== "debug" || task.executionProfile !== "no-script")) ctx.addIssue({ code: "custom", path: ["dispatchKind"], message: "shared dispatch requires no-script debug" });
  if (task.debugSessionId && task.target.kind !== "debug") ctx.addIssue({ code: "custom", path: ["debugSessionId"], message: "debug session is only valid for debug targets" });
});
export const DebugSessionHandleSchema = z.object({
  debugSessionId: OpaqueIdSchema, serverId: OpaqueIdSchema, scope: ServerProjectScopeSchema,
  submittedByUserId: EntityIdSchema, agentId: EntityIdSchema, expiresAt: z.string().datetime(),
}).strict();
export type DispatchBinding = { serverId: string; scope: ServerProjectScope; submittedByUserId: string; agentId: string; nowMs: number; debugSession?: DebugSessionHandle };
/** Values in binding must come from authoritative backend/session lookup, not a client assertion. */
export function validateDispatchBinding(input: unknown, binding: DispatchBinding): void {
  const task = TaskEnvelopeV1Schema.parse(input);
  const sameScope = (a: ServerProjectScope, b: ServerProjectScope) => a.workspaceId === b.workspaceId && a.groupId === b.groupId && a.projectId === b.projectId;
  if (task.submittedByUserId !== binding.submittedByUserId || !sameScope(task.scope, binding.scope)) throw new Error("dispatch subject or scope mismatch");
  if (!task.debugSessionId) return;
  const handle = DebugSessionHandleSchema.parse(binding.debugSession);
  if (!Number.isFinite(binding.nowMs) || handle.debugSessionId !== task.debugSessionId || handle.serverId !== binding.serverId || handle.agentId !== binding.agentId || handle.submittedByUserId !== task.submittedByUserId || !sameScope(handle.scope, task.scope) || Date.parse(handle.expiresAt) <= binding.nowMs) throw new Error("debug session binding mismatch or expired");
}
export type ServerProjectScope = z.infer<typeof ServerProjectScopeSchema>;
export type TaskTarget = z.infer<typeof TaskTargetSchema>;
export type ExecutionLocation = z.infer<typeof ExecutionLocationSchema>;
export type ExecutionProfile = z.infer<typeof ExecutionProfileSchema>;
export type DispatchKind = z.infer<typeof DispatchKindSchema>;
export type ScriptRequirement = z.infer<typeof ScriptRequirementSchema>;
export type TaskEnvelopeV1 = z.infer<typeof TaskEnvelopeV1Schema>;
export type DebugSessionHandle = z.infer<typeof DebugSessionHandleSchema>;

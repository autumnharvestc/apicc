import { z } from "zod";
import { HashSchema, OpaqueIdSchema } from "./task.js";
import { ConfigApplicationStateSchema, ConfigVersionSchema, AgentConfigSchema, PolicyConfigSchema } from "./config.js";
import { EntityIdSchema } from "./task.js";
import { ExecutionLocationSchema } from "./task.js";
import { StressReservationSchema,StressProcessObservationSchema,StressContentionHintSchema,StressCapacitySchema,processObservationFitsBudget } from "./stress.js";
export const RuntimeRegistrationSchema = z.object({ protocolVersion: z.literal(1), sessionId: OpaqueIdSchema,
  coreBuildId: HashSchema, scriptApiId: HashSchema, nodeVersion: OpaqueIdSchema, v8Version: OpaqueIdSchema,
  runtimeCompatibilityId: OpaqueIdSchema, capabilities: z.array(OpaqueIdSchema), configuration: ConfigApplicationStateSchema,
}).strict();
export const RuntimeRegistrationResultSchema = z.object({ registered: z.boolean(), sessionId: OpaqueIdSchema, serverId: OpaqueIdSchema,
  configuration: z.object({ configVersion: ConfigVersionSchema, config: AgentConfigSchema }).strict(),
}).strict();
export type RuntimeRegistration = z.infer<typeof RuntimeRegistrationSchema>;
export const StressExecutionMetadataSchema = z.object({
  location: ExecutionLocationSchema, executor: z.object({ id: OpaqueIdSchema, name: z.string().max(512) }).strict(),
  workerCount: z.number().int().positive().max(1000), processes: z.number().int().positive().max(1001),
  resources: z.object({ requested: StressReservationSchema, effective: StressReservationSchema }).strict(),
  runtime: RuntimeRegistrationSchema.pick({ coreBuildId: true, scriptApiId: true, nodeVersion: true, v8Version: true, runtimeCompatibilityId: true }),
  status: z.object({ preparation: z.enum(["pending", "preparing", "ready", "failed"]), execution: z.enum(["pending", "running", "finished", "failed", "cancelled", "timed-out", "interrupted"]), upload: z.enum(["pending", "uploading", "complete", "failed"]) }).strict(),
  contentionHints: z.array(z.union([z.string().min(1).max(512),StressContentionHintSchema])).max(32),processObservation:StressProcessObservationSchema.optional(),
}).strict().superRefine((metadata, ctx) => {
  if (metadata.processes !== (metadata.workerCount === 1 ? 1 : metadata.workerCount + 1) || metadata.resources.effective.processes !== metadata.processes) ctx.addIssue({ code: "custom", path: ["processes"], message: "stress process count must match worker topology and effective resources" });
  if (metadata.location.kind === "agent" && metadata.executor.id !== metadata.location.agentId) ctx.addIssue({ code: "custom", path: ["executor", "id"], message: "executor identity must match selected agent" });
  if(metadata.processObservation&&!processObservationFitsBudget(metadata.processObservation,metadata.processes))ctx.addIssue({code:'custom',path:['processObservation'],message:'observed processes exceed the fixed budget or falsely claim complete topology'});
});
export type StressExecutionMetadata = z.infer<typeof StressExecutionMetadataSchema>;
export const ProjectStressConfigurationSchema = z.object({
  agent: z.object({
    maxConcurrentStressJobs: AgentConfigSchema.shape.maxConcurrentStressJobs.removeDefault(),
    maxStressProcesses: AgentConfigSchema.shape.maxStressProcesses.removeDefault(),
    maxStressVus: AgentConfigSchema.shape.maxStressVus.removeDefault(),
    maxStressRequestConcurrency: AgentConfigSchema.shape.maxStressRequestConcurrency.removeDefault(),
    maxStressRps: AgentConfigSchema.shape.maxStressRps.removeDefault(),
    maxStressMetricMemoryBytes: AgentConfigSchema.shape.maxStressMetricMemoryBytes.removeDefault(),
  }).strict(),
  sources: z.object({
    "agent.maxStressRequestConcurrency": z.enum(["default", "deployment", "agent"]),
    "agent.maxStressRps": z.enum(["default", "deployment", "agent"]),
    "policy.maxStressRequestConcurrency": z.enum(["default", "deployment", "workspace", "project"]),
    "policy.maxStressRps": z.enum(["default", "deployment", "workspace", "project"]),
  }).strict(),
}).strict();
/** Member-facing project projection; no token, global deployment, or unrelated project configuration. */
export const ProjectExecutionAgentsSchema = z.object({
  defaultAgentId: EntityIdSchema.nullable(), canManageScripts: z.boolean(), policy: PolicyConfigSchema, policyVersion: ConfigVersionSchema,
  agents: z.array(z.object({ id: EntityIdSchema, name: z.string(), acceptingJobs: z.boolean(),
    availability: z.enum(["available", "runtime-missing", "disconnected", "stale", "not-accepting", "revoked"]),
    lastSeenAt: z.string().datetime().nullable(), runtime: RuntimeRegistrationSchema.optional(), configuration: ConfigApplicationStateSchema,
    policy: PolicyConfigSchema, policyVersion: ConfigVersionSchema, scriptsAllowed: z.boolean(),
    stressConfiguration: ProjectStressConfigurationSchema,stressCapacity:StressCapacitySchema.optional(),
    scriptGrant: z.object({ version: ConfigVersionSchema, scope: z.enum(["script-version", "project"]), scripts: z.array(z.object({ scriptId: OpaqueIdSchema, contentHash: HashSchema }).strict()) }).strict(),
  }).strict()),
}).strict();
export type ProjectExecutionAgents = z.infer<typeof ProjectExecutionAgentsSchema>;
/** Initial controlled compatibility entry. Expanding this list requires runtime equivalence evidence. */
export const CONTROLLED_RUNTIME = Object.freeze({ nodeVersion: "22.19.0", v8Version: "12.4.254.21-node.29", scriptApiId: "afaf628a48532cff1e1e9264f328830ea1678b877853e324bab040039d0721d0" });
/** Electron 44.1.0 main and Linux Node 22.19.0 passed the same real Core fixture (T11). */
export const CONTROLLED_RUNTIMES = Object.freeze([
  CONTROLLED_RUNTIME,
  Object.freeze({ nodeVersion: "24.19.0", v8Version: "15.2.124.18-electron.0", scriptApiId: CONTROLLED_RUNTIME.scriptApiId }),
]);
export function runtimeCompatibilityIdForRuntime(nodeVersion: string, v8Version: string, scriptApiId: string): string {
  if (!CONTROLLED_RUNTIMES.some(runtime => runtime.nodeVersion === nodeVersion && runtime.v8Version === v8Version && runtime.scriptApiId === scriptApiId)) throw new Error("Unknown execution runtime compatibility combination");
  return `node-${nodeVersion}-v8-${v8Version}-script-${scriptApiId}`;
}

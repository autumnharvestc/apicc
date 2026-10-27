import { z } from "zod";
import { HashSchema, OpaqueIdSchema } from "./task.js";
import { ConfigApplicationStateSchema, ConfigVersionSchema, AgentConfigSchema, PolicyConfigSchema } from "./config.js";
import { EntityIdSchema } from "./task.js";
export const RuntimeRegistrationSchema = z.object({ protocolVersion: z.literal(1), sessionId: OpaqueIdSchema,
  coreBuildId: HashSchema, scriptApiId: HashSchema, nodeVersion: OpaqueIdSchema, v8Version: OpaqueIdSchema,
  runtimeCompatibilityId: OpaqueIdSchema, capabilities: z.array(OpaqueIdSchema), configuration: ConfigApplicationStateSchema,
}).strict();
export const RuntimeRegistrationResultSchema = z.object({ registered: z.boolean(), sessionId: OpaqueIdSchema, serverId: OpaqueIdSchema,
  configuration: z.object({ configVersion: ConfigVersionSchema, config: AgentConfigSchema }).strict(),
}).strict();
export type RuntimeRegistration = z.infer<typeof RuntimeRegistrationSchema>;
/** Member-facing project projection; no token, global deployment, or unrelated project configuration. */
export const ProjectExecutionAgentsSchema = z.object({
  defaultAgentId: EntityIdSchema.nullable(), canManageScripts: z.boolean(), policy: PolicyConfigSchema, policyVersion: ConfigVersionSchema,
  agents: z.array(z.object({ id: EntityIdSchema, name: z.string(), acceptingJobs: z.boolean(),
    availability: z.enum(["available", "runtime-missing", "disconnected", "stale", "not-accepting", "revoked"]),
    lastSeenAt: z.string().datetime().nullable(), runtime: RuntimeRegistrationSchema.optional(), configuration: ConfigApplicationStateSchema,
    policy: PolicyConfigSchema, policyVersion: ConfigVersionSchema, scriptsAllowed: z.boolean(),
    scriptGrant: z.object({ version: ConfigVersionSchema, scope: z.enum(["script-version", "project"]), scripts: z.array(z.object({ scriptId: OpaqueIdSchema, contentHash: HashSchema }).strict()) }).strict(),
  }).strict()),
}).strict();
export type ProjectExecutionAgents = z.infer<typeof ProjectExecutionAgentsSchema>;
/** Initial controlled compatibility entry. Expanding this list requires runtime equivalence evidence. */
export const CONTROLLED_RUNTIME = Object.freeze({ nodeVersion: "22.19.0", v8Version: "12.4.254.21-node.29", scriptApiId: "4c7c797e04a8eb8769ea8d65e6248a40853e7cf1793d0e37d3e862146edac572" });
/** Electron 44.1.0 main and Linux Node 22.19.0 passed the same real Core fixture (T11). */
export const CONTROLLED_RUNTIMES = Object.freeze([
  CONTROLLED_RUNTIME,
  Object.freeze({ nodeVersion: "24.19.0", v8Version: "15.2.124.18-electron.0", scriptApiId: CONTROLLED_RUNTIME.scriptApiId }),
]);
export function runtimeCompatibilityIdForRuntime(nodeVersion: string, v8Version: string, scriptApiId: string): string {
  if (!CONTROLLED_RUNTIMES.some(runtime => runtime.nodeVersion === nodeVersion && runtime.v8Version === v8Version && runtime.scriptApiId === scriptApiId)) throw new Error("Unknown execution runtime compatibility combination");
  return `node-${nodeVersion}-v8-${v8Version}-script-${scriptApiId}`;
}

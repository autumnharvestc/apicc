import { z } from "zod";
import { RequestSettingsOverrideSchema } from "@apicc/core/schema";

export const PositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const MIN_FAULT_REPORT_BYTES = 1024;
export const ConfigVersionSchema = z.string().regex(/^(0|[1-9]\d*)$/).refine(v => /^(0|[1-9]\d*)$/.test(v) && BigInt(v) <= 9223372036854775807n, "version exceeds BIGINT");
const timer = PositiveIntegerSchema.max(2147483647);
export const DeploymentConfigSchema = z.object({
  maxAgentConcurrentJobs: PositiveIntegerSchema,
  agentMemoryLimitBytes: PositiveIntegerSchema.nullable(),
  agentCpuLimit: z.number().finite().positive().nullable(),
  auditRetentionDays: PositiveIntegerSchema,
  cleanupIntervalMs: PositiveIntegerSchema,
  cleanupBatchSize: PositiveIntegerSchema.max(1000).default(100),
  enrollmentTtlMs: PositiveIntegerSchema,
}).strict();
export const defaultDeploymentConfig = Object.freeze(DeploymentConfigSchema.parse({
  maxAgentConcurrentJobs: 32, agentMemoryLimitBytes: null, agentCpuLimit: null,
  auditRetentionDays: 90, cleanupIntervalMs: 3600000, cleanupBatchSize: 100, enrollmentTtlMs: 86400000,
}));
const AgentConfigObject = z.object({
  maxConcurrentJobs: PositiveIntegerSchema, sharedDebugMaxInFlight: PositiveIntegerSchema,
  sharedDebugIdleMs: PositiveIntegerSchema, debugSessionIdleMs: PositiveIntegerSchema,
  maxDebugSessions: PositiveIntegerSchema, workerStartupTimeoutMs: timer,
  workerHeartbeatIntervalMs: timer, workerUnresponsiveAfterMs: timer,
  scriptMode: z.enum(["deny", "trusted-core"]), childMaxOldSpaceMiB: PositiveIntegerSchema,
  longPollWaitMs: timer, controlRequestTimeoutMs: timer, pollTimeoutMarginMs: timer,
  heartbeatIntervalMs: timer, offlineAfterMs: PositiveIntegerSchema,
  reconnectMinMs: timer, reconnectMaxMs: timer, reconnectJitterRatio: z.number().finite().min(0).max(1),
  transferTimeoutMs: timer, transferRetryMinMs: timer, transferRetryMaxMs: timer,
  transferMaxAttemptsPerCycle: PositiveIntegerSchema, transferRetryCycleMs: PositiveIntegerSchema,
  inputCacheBytes: PositiveIntegerSchema, pendingResultBytes: PositiveIntegerSchema,
  faultReserveBytes: PositiveIntegerSchema, minFreeDiskBytes: PositiveIntegerSchema,
}).strict();
export const AgentConfigPatchSchema = AgentConfigObject.partial().strict();
export const AgentConfigSchema = AgentConfigObject.superRefine((c, ctx) => {
  const issue = (field: keyof typeof c, message: string) => ctx.addIssue({ code: "custom", path: [field], message });
  if (c.longPollWaitMs + c.pollTimeoutMarginMs > c.controlRequestTimeoutMs) issue("controlRequestTimeoutMs", "control timeout must cover poll wait + margin");
  if (c.heartbeatIntervalMs >= c.offlineAfterMs) issue("offlineAfterMs", "offline deadline must exceed heartbeat interval");
  if (c.workerHeartbeatIntervalMs >= c.workerUnresponsiveAfterMs) issue("workerUnresponsiveAfterMs", "worker supervision deadline must exceed heartbeat interval");
  if (c.reconnectMinMs > c.reconnectMaxMs) issue("reconnectMaxMs", "reconnect maximum must cover minimum");
  if (c.transferRetryMinMs > c.transferRetryMaxMs) issue("transferRetryMaxMs", "transfer retry maximum must cover minimum");
  if (c.pendingResultBytes <= c.faultReserveBytes) issue("pendingResultBytes", "pending result budget must exceed fault reserve");
  if (c.faultReserveBytes / c.maxConcurrentJobs < MIN_FAULT_REPORT_BYTES) issue("faultReserveBytes", "fault reserve must hold a complete fault report for every concurrent job");
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;
export const defaultAgentConfig: Readonly<AgentConfig> = Object.freeze(AgentConfigSchema.parse({
  maxConcurrentJobs: 1, sharedDebugMaxInFlight: 4, sharedDebugIdleMs: 60000,
  debugSessionIdleMs: 1800000, maxDebugSessions: 64,
  workerStartupTimeoutMs: 15000, workerHeartbeatIntervalMs: 1000, workerUnresponsiveAfterMs: 15000,
  scriptMode: "deny", childMaxOldSpaceMiB: 256,
  longPollWaitMs: 30000, controlRequestTimeoutMs: 45000, pollTimeoutMarginMs: 5000,
  heartbeatIntervalMs: 10000, offlineAfterMs: 30000,
  reconnectMinMs: 1000, reconnectMaxMs: 30000, reconnectJitterRatio: 0.2,
  transferTimeoutMs: 120000, transferRetryMinMs: 1000, transferRetryMaxMs: 30000,
  transferMaxAttemptsPerCycle: 5, transferRetryCycleMs: 60000,
  inputCacheBytes: 1073741824, pendingResultBytes: 268435456,
  faultReserveBytes: 1048576, minFreeDiskBytes: 536870912,
}));
export function validateAgentConfig(value: unknown): AgentConfig { return AgentConfigSchema.parse(value); }
const PolicyConfigObject = z.object({
  maxQueuedJobs: PositiveIntegerSchema, queueTimeoutMs: PositiveIntegerSchema.nullable(),
  defaultJobTimeoutMs: PositiveIntegerSchema, maxJobTimeoutMs: PositiveIntegerSchema,
  cancelGraceMs: timer, scriptTimeoutMs: timer, maxScriptTimeoutMs: timer,
  snapshotBytes: PositiveIntegerSchema, singleAttachmentBytes: PositiveIntegerSchema,
  totalInputBytes: PositiveIntegerSchema, maxAssetChangeFiles: PositiveIntegerSchema,
  bodyPreviewBytes: PositiveIntegerSchema, valuePreviewBytes: PositiveIntegerSchema,
  caseEvidenceBytes: PositiveIntegerSchema, reportBytes: PositiveIntegerSchema.min(MIN_FAULT_REPORT_BYTES),
  workflowMetadataBytes: PositiveIntegerSchema, resultRetentionDays: PositiveIntegerSchema,
}).strict();
export const PolicyConfigPatchSchema = PolicyConfigObject.partial().strict();
export const PolicyConfigSchema = PolicyConfigObject.superRefine((c, ctx) => {
  const le = (small: keyof typeof c, big: keyof typeof c) => {
    if (c[small]! > c[big]!) ctx.addIssue({ code: "custom", path: [small], message: `${small} exceeds ${big}` });
  };
  le("defaultJobTimeoutMs", "maxJobTimeoutMs"); le("cancelGraceMs", "defaultJobTimeoutMs");
  le("scriptTimeoutMs", "maxScriptTimeoutMs"); le("snapshotBytes", "totalInputBytes");
  le("singleAttachmentBytes", "totalInputBytes"); le("bodyPreviewBytes", "caseEvidenceBytes");
  le("valuePreviewBytes", "caseEvidenceBytes"); le("caseEvidenceBytes", "reportBytes");
  le("workflowMetadataBytes", "reportBytes");
});
export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;
export const defaultPolicyConfig: Readonly<PolicyConfig> = Object.freeze(PolicyConfigSchema.parse({
  maxQueuedJobs: 1000, queueTimeoutMs: null,
  defaultJobTimeoutMs: 1800000, maxJobTimeoutMs: 86400000, cancelGraceMs: 5000,
  scriptTimeoutMs: 3000, maxScriptTimeoutMs: 10000,
  snapshotBytes: 67108864, singleAttachmentBytes: 67108864, totalInputBytes: 536870912,
  maxAssetChangeFiles: 2000, bodyPreviewBytes: 65536, valuePreviewBytes: 4096,
  caseEvidenceBytes: 262144, reportBytes: 16777216, workflowMetadataBytes: 4194304,
  resultRetentionDays: 30,
}));
export const ClientConfigSchema = z.object({ statusRefreshMs: timer }).strict();
export const defaultClientConfig = Object.freeze(ClientConfigSchema.parse({ statusRefreshMs: 2000 }));
export const RunConfigSchema = z.object({
  jobTimeoutMs: PositiveIntegerSchema.optional(), scriptTimeoutMs: timer.optional(),
  requestSettings: RequestSettingsOverrideSchema.optional(),
}).strict();
export const EffectiveConfigInputSchema = z.object({
  deployment: DeploymentConfigSchema.partial().strict().optional(), agent: AgentConfigPatchSchema.optional(),
  policy: PolicyConfigPatchSchema.optional(),
  agentPolicy: z.object({ maxQueuedJobs: PositiveIntegerSchema.optional() }).strict().optional(),
  workspace: PolicyConfigPatchSchema.optional(), project: PolicyConfigPatchSchema.optional(),
  run: RunConfigSchema.optional(), client: ClientConfigSchema.partial().strict().optional(),
  policyVersion: ConfigVersionSchema.optional(),
}).strict();
export type EffectiveConfigInput = z.input<typeof EffectiveConfigInputSchema>;
export type ConfigSource = "default" | "deployment" | "agent" | "workspace" | "project" | "run" | "client";
const ceilings = new Set<keyof PolicyConfig>(["maxQueuedJobs", "maxJobTimeoutMs", "maxScriptTimeoutMs", "snapshotBytes", "singleAttachmentBytes", "totalInputBytes", "maxAssetChangeFiles", "bodyPreviewBytes", "valuePreviewBytes", "caseEvidenceBytes", "reportBytes", "workflowMetadataBytes"]);
/** Backend calculation; the caller must authorize the scope of every explicit layer. */
export function resolveEffectiveConfig(value: unknown = {}) {
  const input = EffectiveConfigInputSchema.parse(value);
  const deployment = DeploymentConfigSchema.parse({ ...defaultDeploymentConfig, ...input.deployment });
  const agent = validateAgentConfig({ ...defaultAgentConfig, ...input.agent });
  if (agent.maxConcurrentJobs > deployment.maxAgentConcurrentJobs) throw new Error("agent concurrency exceeds deployment maximum");
  let policy: PolicyConfig = PolicyConfigSchema.parse({ ...defaultPolicyConfig, ...input.policy });
  const sources: Record<string, ConfigSource> = {};
  const restrictions: { field: string; reason: string; effectiveValue: number }[] = [];
  for (const key of Object.keys(policy)) sources[`policy.${key}`] = input.policy && key in input.policy ? "deployment" : "default";
  for (const [section, settings, explicit] of [["deployment", deployment, input.deployment], ["agent", agent, input.agent], ["client", defaultClientConfig, input.client]] as const) {
    for (const key of Object.keys(settings)) sources[`${section}.${key}`] = explicit && key in explicit ? section : "default";
  }
  for (const level of ["workspace", "project"] as const) {
    const patch = { ...input[level] };
    if (level === "project" && patch.maxQueuedJobs === undefined) {
      if (policy.maxQueuedJobs > 50) patch.maxQueuedJobs = 50;
      else if (policy.maxQueuedJobs < 50) restrictions.push({
        field: "policy.maxQueuedJobs", reason: `${sources["policy.maxQueuedJobs"]}.maxQueuedJobs`, effectiveValue: policy.maxQueuedJobs,
      });
    }
    for (const key of Object.keys(patch) as (keyof PolicyConfig)[]) {
      const next = patch[key];
      if (ceilings.has(key) && typeof next === "number" && next > policy[key]!) throw new Error(`${level}.${key} exceeds inherited maximum`);
      sources[`policy.${key}`] = input[level] && key in input[level] ? level : "default";
    }
    const merged = { ...policy, ...patch };
    for (const [key, max] of [["defaultJobTimeoutMs", "maxJobTimeoutMs"], ["scriptTimeoutMs", "maxScriptTimeoutMs"]] as const) {
      if (merged[key] > merged[max] && !(key in patch)) {
        merged[key] = merged[max];
        restrictions.push({ field: `policy.${key}`, reason: max, effectiveValue: merged[max] });
      }
    }
    policy = PolicyConfigSchema.parse(merged);
  }
  const globalQueueLimit = input.policy?.maxQueuedJobs ?? 1000;
  const agentQueueLimit = input.agentPolicy?.maxQueuedJobs ?? Math.min(100, globalQueueLimit);
  if (agentQueueLimit > globalQueueLimit) throw new Error("agent queue limit exceeds global queue limit");
  if (input.project?.maxQueuedJobs !== undefined && input.project.maxQueuedJobs > agentQueueLimit) throw new Error("project queue limit exceeds agent queue limit");
  if (policy.maxQueuedJobs > agentQueueLimit) {
    policy.maxQueuedJobs = agentQueueLimit;
    sources["policy.maxQueuedJobs"] = "agent";
    restrictions.push({ field: "policy.maxQueuedJobs", reason: "agent.maxQueuedJobs", effectiveValue: agentQueueLimit });
  }
  if (agent.sharedDebugMaxInFlight > agent.maxConcurrentJobs) restrictions.push({ field: "agent.sharedDebugMaxInFlight", reason: "agent.maxConcurrentJobs", effectiveValue: agent.maxConcurrentJobs });
  const run = input.run ?? {};
  const jobTimeoutMs = run.jobTimeoutMs ?? policy.defaultJobTimeoutMs;
  if (jobTimeoutMs > policy.maxJobTimeoutMs) throw new Error("run job timeout exceeds policy maximum");
  if (policy.cancelGraceMs > jobTimeoutMs) throw new Error("cancel grace exceeds job timeout budget");
  if (run.scriptTimeoutMs !== undefined) {
    if (run.scriptTimeoutMs > policy.maxScriptTimeoutMs) throw new Error("run script timeout exceeds policy maximum");
    policy = { ...policy, scriptTimeoutMs: run.scriptTimeoutMs };
    sources["policy.scriptTimeoutMs"] = "run";
  }
  sources.jobTimeoutMs = run.jobTimeoutMs === undefined ? sources["policy.defaultJobTimeoutMs"] : "run";
  if (agent.workerUnresponsiveAfterMs <= policy.maxScriptTimeoutMs + agent.workerHeartbeatIntervalMs) throw new Error("worker supervision timeout must exceed max script timeout + heartbeat");
  if (agent.inputCacheBytes < policy.totalInputBytes) throw new Error("input cache cannot hold one task input budget");
  if (agent.pendingResultBytes <= agent.faultReserveBytes + policy.reportBytes) throw new Error("pending result budget must exceed fault reserve + one report");
  return {
    deployment, agent, policy, client: ClientConfigSchema.parse({ ...defaultClientConfig, ...input.client }),
    jobTimeoutMs, requestSettings: run.requestSettings,
    sharedDebugMaxInFlight: Math.min(agent.sharedDebugMaxInFlight, agent.maxConcurrentJobs),
    queueLimits: { global: globalQueueLimit, agent: agentQueueLimit, project: policy.maxQueuedJobs },
    policyVersion: input.policyVersion ?? "0", explicit: input, sources, restrictions,
  };
}
export function nextConfigVersion(current: string, expected: string): string {
  ConfigVersionSchema.parse(current); ConfigVersionSchema.parse(expected);
  if (current !== expected) throw new Error("configuration version conflict");
  return ConfigVersionSchema.parse(String(BigInt(current) + 1n));
}
export const ConfigUpdateSchema = z.object({ expectedVersion: ConfigVersionSchema, config: AgentConfigSchema }).strict();
const AgentFieldSchema = z.enum(Object.keys(AgentConfigObject.shape) as [keyof AgentConfig, ...(keyof AgentConfig)[]]);
export const ConfigApplicationStateSchema = z.object({
  configVersion: ConfigVersionSchema, appliedConfigVersion: ConfigVersionSchema,
  pendingFields: z.array(AgentFieldSchema), restartRequiredFields: z.array(AgentFieldSchema),
  status: z.enum(["applied", "pending", "restart-required"]),
}).strict().superRefine((s, ctx) => {
  if (ConfigVersionSchema.safeParse(s.appliedConfigVersion).success && ConfigVersionSchema.safeParse(s.configVersion).success && BigInt(s.appliedConfigVersion) > BigInt(s.configVersion)) ctx.addIssue({ code: "custom", message: "applied version exceeds saved version" });
  if (s.status === "applied" && (s.configVersion !== s.appliedConfigVersion || s.pendingFields.length || s.restartRequiredFields.length)) ctx.addIssue({ code: "custom", message: "saved configuration has unapplied fields" });
  if (s.status === "restart-required" && !s.restartRequiredFields.length) ctx.addIssue({ code: "custom", message: "restart-required needs affected fields" });
});
export type DeploymentConfig = z.infer<typeof DeploymentConfigSchema>;
export type ConfigApplicationState = z.infer<typeof ConfigApplicationStateSchema>;

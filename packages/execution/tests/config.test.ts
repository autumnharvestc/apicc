import { describe, expect, it } from "vitest";
import { AgentConfigSchema, PolicyConfigSchema, ConfigApplicationStateSchema, defaultAgentConfig, resolveEffectiveConfig, validateAgentConfig, nextConfigVersion } from "../src/contract/index.js";

describe("effective configuration", () => {
  it("inherits usable defaults including all budgets and independent supervision", () => {
    const c = resolveEffectiveConfig();
    expect(c.agent).toMatchObject({ maxConcurrentJobs: 1, sharedDebugMaxInFlight: 4, sharedDebugIdleMs: 60000, debugSessionIdleMs: 1800000, maxDebugSessions: 64, workerStartupTimeoutMs: 15000, workerHeartbeatIntervalMs: 1000, workerUnresponsiveAfterMs: 15000, scriptMode: "deny", childMaxOldSpaceMiB: 256, longPollWaitMs: 30000, controlRequestTimeoutMs: 45000, pollTimeoutMarginMs: 5000, heartbeatIntervalMs: 10000, offlineAfterMs: 30000, reconnectMinMs: 1000, reconnectMaxMs: 30000, reconnectJitterRatio: 0.2, transferTimeoutMs: 120000, transferRetryMinMs: 1000, transferRetryMaxMs: 30000, transferMaxAttemptsPerCycle: 5, transferRetryCycleMs: 60000, inputCacheBytes: 1073741824, pendingResultBytes: 268435456, faultReserveBytes: 1048576, minFreeDiskBytes: 536870912 });
    expect(c.policy).toMatchObject({ maxQueuedJobs: 50, queueTimeoutMs: null, defaultJobTimeoutMs: 1800000, maxJobTimeoutMs: 86400000, cancelGraceMs: 5000, scriptTimeoutMs: 3000, maxScriptTimeoutMs: 10000, snapshotBytes: 67108864, singleAttachmentBytes: 67108864, totalInputBytes: 536870912, maxAssetChangeFiles: 2000, bodyPreviewBytes: 65536, valuePreviewBytes: 4096, caseEvidenceBytes: 262144, reportBytes: 16777216, workflowMetadataBytes: 4194304, resultRetentionDays: 30 });
    expect(c.deployment).toMatchObject({ maxAgentConcurrentJobs: 32, agentMemoryLimitBytes: null, agentCpuLimit: null, auditRetentionDays: 90, cleanupIntervalMs: 3600000, enrollmentTtlMs: 86400000 });
    expect(c.queueLimits).toEqual({ global: 1000, agent: 100, project: 50 });
    expect(c.client.statusRefreshMs).toBe(2000);
  });
  it("allows multi-task agent capacity within deployment and intersects shared slots", () => {
    const c = resolveEffectiveConfig({ deployment: { maxAgentConcurrentJobs: 4 }, agent: { maxConcurrentJobs: 2 } });
    expect(c.agent.maxConcurrentJobs).toBe(2);
    expect(c.sharedDebugMaxInFlight).toBe(2);
  });
  it("rejects control timeout shorter than poll plus margin", () => {
    expect(() => validateAgentConfig({ ...defaultAgentConfig, longPollWaitMs: 45000, controlRequestTimeoutMs: 30000 })).toThrow(/timeout/i);
  });
  it.each([
    { heartbeatIntervalMs: 30000 }, { reconnectMinMs: 31000 }, { reconnectJitterRatio: 1.1 },
    { transferRetryMinMs: 31000 }, { maxConcurrentJobs: 0 }, { maxDebugSessions: Number.MAX_SAFE_INTEGER + 1 },
    { workerUnresponsiveAfterMs: 1000 }, { scriptMode: "unsafe" }, { sharedDebugIdleMs: Infinity },
  ])("rejects invalid agent settings %j", (patch) => expect(AgentConfigSchema.safeParse({ ...defaultAgentConfig, ...patch }).success).toBe(false));
  it("rejects lower-level capacity escalation and infrastructure override", () => {
    expect(() => resolveEffectiveConfig({ deployment: { maxAgentConcurrentJobs: 2 }, agent: { maxConcurrentJobs: 3 } })).toThrow();
    expect(() => resolveEffectiveConfig({ workspace: { maxJobTimeoutMs: 100000 }, project: { maxJobTimeoutMs: 200000 } })).toThrow();
    expect(() => resolveEffectiveConfig({ project: { agent: { maxConcurrentJobs: 10 } } })).toThrow();
    expect(() => resolveEffectiveConfig({ run: { maxJobTimeoutMs: 100000000 } })).toThrow();
  });
  it("inherits defaults, caps inherited values, and reports origin and restriction", () => {
    const c = resolveEffectiveConfig({ workspace: { maxJobTimeoutMs: 120000, defaultJobTimeoutMs: 90000 }, project: { maxJobTimeoutMs: 60000 }, run: { jobTimeoutMs: 55000, scriptTimeoutMs: 2000 } });
    expect(c.policy.defaultJobTimeoutMs).toBe(60000);
    expect(c.jobTimeoutMs).toBe(55000);
    expect(c.policy.scriptTimeoutMs).toBe(2000);
    expect(c.sources["policy.maxJobTimeoutMs"]).toBe("project");
    expect(c.explicit.project).toEqual({ maxJobTimeoutMs: 60000 });
    expect(c.restrictions).toContainEqual(expect.objectContaining({ field: "policy.defaultJobTimeoutMs", reason: "maxJobTimeoutMs", effectiveValue: 60000 }));
  });
  it("accepts legal overrides and rejects incompatible budget and timing combinations", () => {
    const minimalEvidence = { bodyPreviewBytes: 1, valuePreviewBytes: 1, caseEvidenceBytes: 1, workflowMetadataBytes: 1 };
    expect.soft(() => resolveEffectiveConfig({ project: { ...minimalEvidence, reportBytes: 1023 } })).toThrow();
    expect.soft(() => validateAgentConfig({ ...defaultAgentConfig, maxConcurrentJobs: 2, faultReserveBytes: 2047 })).toThrow();
    expect(resolveEffectiveConfig({ agent: { maxConcurrentJobs: 2, faultReserveBytes: 2048 }, project: { ...minimalEvidence, reportBytes: 1024 } }).policy.reportBytes).toBe(1024);
    expect(resolveEffectiveConfig({ client: { statusRefreshMs: 5000 }, project: { queueTimeoutMs: 1000, resultRetentionDays: 10 }, run: { jobTimeoutMs: 60000 } }).client.statusRefreshMs).toBe(5000);
    for (const input of [
      { agent: { inputCacheBytes: 1000 } }, { agent: { pendingResultBytes: 17000000 } },
      { project: { maxScriptTimeoutMs: 15000 } }, { project: { reportBytes: 1000 } },
      { run: { scriptTimeoutMs: 10001 } }, { run: { jobTimeoutMs: 4000 } },
    ]) expect(() => resolveEffectiveConfig(input)).toThrow();
    expect(PolicyConfigSchema.safeParse({ ...resolveEffectiveConfig().policy, maxScriptTimeoutMs: 2147483648 }).success).toBe(false);
  });
  it("validates version conflicts and partial application without pretending saved is applied", () => {
    expect(nextConfigVersion("7", "7")).toBe("8");
    expect(() => nextConfigVersion("8", "7")).toThrow(/conflict/i);
    const state = { configVersion: "8", appliedConfigVersion: "7", pendingFields: ["childMaxOldSpaceMiB"], restartRequiredFields: [], status: "pending" };
    expect(ConfigApplicationStateSchema.safeParse(state).success).toBe(true);
    expect(ConfigApplicationStateSchema.safeParse({ ...state, status: "applied" }).success).toBe(false);
    expect(ConfigApplicationStateSchema.safeParse({ ...state, appliedConfigVersion: "invalid" }).success).toBe(false);
  });
  it("reports agent queue and shared capacity restrictions rather than hiding the limiting layer", () => {
    const c = resolveEffectiveConfig({ agentPolicy: { maxQueuedJobs: 20 } });
    expect(c.policy.maxQueuedJobs).toBe(20);
    expect(c.sources["policy.maxQueuedJobs"]).toBe("agent");
    expect(c.restrictions).toContainEqual({ field: "policy.maxQueuedJobs", reason: "agent.maxQueuedJobs", effectiveValue: 20 });
    expect(c.restrictions).toContainEqual({ field: "agent.sharedDebugMaxInFlight", reason: "agent.maxConcurrentJobs", effectiveValue: 1 });
  });
  it.each([
    { input: { workspace: { maxQueuedJobs: 20 } }, source: "workspace" },
    { input: { policy: { maxQueuedJobs: 20 } }, source: "deployment" },
  ])("preserves the $source queue ceiling when the project default is restricted", ({ input, source }) => {
    const c = resolveEffectiveConfig(input);
    expect(c.policy.maxQueuedJobs).toBe(20);
    expect(c.sources["policy.maxQueuedJobs"]).toBe(source);
    expect(c.restrictions).toContainEqual({ field: "policy.maxQueuedJobs", reason: `${source}.maxQueuedJobs`, effectiveValue: 20 });
  });
});

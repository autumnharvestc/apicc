import { describe, expect, it } from "vitest";
import { AgentConfigSchema, PolicyConfigSchema, RunConfigSchema, ConfigApplicationStateSchema, defaultAgentConfig, resolveEffectiveConfig, resolveStressExecutionConfig, validateAgentConfig, nextConfigVersion } from "../src/contract/index.js";

const stressPlan = { formatVersion: 1, target: { kind: "workflow", workflowId: "flow" }, load: { kind: "constant-vus", vus: 4 }, maxVus: 4, termination: { maxIterations: 8 } };

describe("effective configuration", () => {
  it("preserves explicit plan limits and finite inherited defaults with their provenance", () => {
    const c = resolveEffectiveConfig({ workspace: { maxStressRequestConcurrency: 40, maxStressRps: 50 }, project: { maxStressRps: 30 } });
    const inherited = resolveStressExecutionConfig(stressPlan, { confirmedTargetOrigins: ["https://example.test", "http://example.test:8080"] }, c);
    expect(inherited.effective).toEqual({ maxRequestConcurrency: 40, maxRps: 30 });
    expect(inherited.sources).toEqual({ maxRequestConcurrency: "policy.maxStressRequestConcurrency:workspace", maxRps: "policy.maxStressRps:project" });
    const explicit = resolveStressExecutionConfig({ ...stressPlan, maxRequestConcurrency: 20, maxRps: 25 }, {}, c);
    expect(explicit.requested).toEqual({ maxRequestConcurrency: 20, maxRps: 25 });
    expect(explicit.effective).toEqual({ maxRequestConcurrency: 20, maxRps: 25 });
    expect(explicit.sources).toEqual({ maxRequestConcurrency: "plan", maxRps: "plan" });
    expect(() => resolveStressExecutionConfig(stressPlan, { workerCount: Number.MAX_SAFE_INTEGER }, resolveEffectiveConfig({ agent: { maxStressProcesses: Number.MAX_SAFE_INTEGER }, policy: { maxStressWorkers: Number.MAX_SAFE_INTEGER } }))).toThrow();
  });
  it("keeps independent node process and task worker ceilings and reports the node intersection", () => {
    const c = resolveEffectiveConfig({ agent: { maxStressProcesses: 3 }, policy: { maxStressWorkers: 4 } });
    expect(resolveStressExecutionConfig(stressPlan, { workerCount: 2 }, c).effectiveWorkerLimit).toBe(2);
    expect(resolveStressExecutionConfig(stressPlan, undefined, c).reservation.processes).toBe(1);
  });
  it("includes aggregate metric memory in the effective worker intersection", () => {
    const c = resolveEffectiveConfig({ agent: { maxStressMetricMemoryBytes: 67108864 } });
    expect(resolveStressExecutionConfig(stressPlan, undefined, c).effectiveWorkerLimit).toBe(1);
  });
  it.each([
    { name: "paused stress jobs", agent: { maxConcurrentStressJobs: 0 }, plan: {}, run: {} },
    { name: "node process capacity", agent: { maxStressProcesses: 3 }, plan: {}, run: { workerCount: 4 } },
    { name: "worker policy", policy: { maxStressWorkers: 2 }, plan: {}, run: { workerCount: 3 } },
    { name: "plan VU worker capacity", plan: {}, run: { workerCount: 5 } },
    { name: "node VUs", agent: { maxStressVus: 3 }, plan: {}, run: {} },
    { name: "policy VUs", policy: { maxStressVus: 3 }, plan: {}, run: {} },
    { name: "node request concurrency", agent: { maxStressRequestConcurrency: 3 }, plan: { maxRequestConcurrency: 4 }, run: {} },
    { name: "policy request concurrency", policy: { maxStressRequestConcurrency: 3 }, plan: { maxRequestConcurrency: 4 }, run: {} },
    { name: "node RPS", agent: { maxStressRps: 3 }, plan: { maxRps: 4 }, run: {} },
    { name: "policy RPS", policy: { maxStressRps: 3 }, plan: { maxRps: 4 }, run: {} },
    { name: "aggregate numeric memory", agent: { maxStressMetricMemoryBytes: 67108864 }, plan: {}, run: { workerCount: 2 } },
  ])("rejects explicit excess for $name", input => {
    const c = resolveEffectiveConfig({ agent: input.agent, policy: input.policy });
    expect(() => resolveStressExecutionConfig({ ...stressPlan, ...input.plan }, input.run, c)).toThrow();
  });
  it.each([[undefined, 1, 67108864], [2, 3, 201326592], [4, 5, 335544320]] as const)("reserves the hand-counted worker/process vector for %s workers", (workerCount, processes, memory) => {
    const c = resolveEffectiveConfig({ agent: { maxConcurrentJobs: 2 } });
    expect(() => resolveStressExecutionConfig(stressPlan, workerCount === undefined ? undefined : { workerCount }, c)).not.toThrow();
    const resolved = resolveStressExecutionConfig(stressPlan, workerCount === undefined ? undefined : { workerCount }, c);
    expect(resolved.reservation).toEqual({ jobs: 1, processes, vus: 4, requestConcurrency: 100, maxRps: 1000, metricMemoryBytes: memory });
    expect(resolved.stage).toBe("admission-limits");
    expect(resolved.requested).toEqual({ maxRequestConcurrency: null, maxRps: null });
    expect(resolved.sources).toEqual({ maxRequestConcurrency: "agent.maxStressRequestConcurrency:default", maxRps: "policy.maxStressRps:default" });
    expect(c.agent.maxConcurrentStressJobs).toBe(1);
  });
  it("carries dedicated stress run settings with per-run confirmation defaults", () => {
    expect(RunConfigSchema.safeParse({ stress: {} }).success).toBe(true);
    expect(RunConfigSchema.parse({ stress: {} })).toEqual({ stress: { workerCount: 1, confirmedTargetOrigins: [] } });
  });
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid stress worker count %s", workerCount => {
    expect(RunConfigSchema.safeParse({ stress: { workerCount } }).success).toBe(false);
  });
  it.each(["https://example.test/path", "http://user:pass@example.test", "javascript:alert(1)", "https://example.test/", "https://example.test?x=1", "https://EXAMPLE.test", "https://example.test:443"]) ("rejects noncanonical confirmed origin %s", origin => {
    expect(RunConfigSchema.safeParse({ stress: { confirmedTargetOrigins: [origin] } }).success).toBe(false);
  });
  it("rejects unknown stress run settings", () => {
    expect(RunConfigSchema.safeParse({ stress: { execute: "arbitrary" } }).success).toBe(false);
  });
  it.each([
    ["maxConcurrentStressJobs", -1], ["maxConcurrentStressJobs", 1.5], ["maxConcurrentStressJobs", 3],
    ["maxStressProcesses", 0], ["maxStressProcesses", 1.5], ["maxStressProcesses", Number.MAX_SAFE_INTEGER + 1],
    ["maxStressVus", 0], ["maxStressVus", 1001], ["maxStressVus", 1.5],
    ["maxStressRequestConcurrency", 0], ["maxStressRequestConcurrency", 1001], ["maxStressRequestConcurrency", 1.5],
    ["maxStressRps", 0], ["maxStressMetricMemoryBytes", 0], ["maxStressMetricMemoryBytes", 1.5], ["maxStressMetricMemoryBytes", Number.MAX_SAFE_INTEGER + 1],
    ["stressProgressIntervalMs", 249], ["stressProgressIntervalMs", 60001], ["stressProgressIntervalMs", 1000.5],
  ])("rejects invalid stress node field %s=%s", (key, value) => {
    expect(AgentConfigSchema.safeParse({ ...defaultAgentConfig, maxConcurrentJobs: 2, [key]: value }).success).toBe(false);
  });
  it.each([
    ["maxStressWorkers", 0], ["maxStressWorkers", 1.5], ["maxStressWorkers", Number.MAX_SAFE_INTEGER + 1],
    ["maxStressVus", 0], ["maxStressVus", 1001], ["maxStressVus", 1.5],
    ["maxStressRequestConcurrency", 0], ["maxStressRequestConcurrency", 1001], ["maxStressRequestConcurrency", 1.5],
    ["maxStressRps", 0], ["stressMetricMemoryBytes", 1048575], ["stressMetricMemoryBytes", 67108865], ["stressMetricMemoryBytes", 1048576.5],
    ["stressEvidenceMaxSamples", 0], ["stressEvidenceMaxSamples", 21], ["stressEvidenceMaxSamples", 1.5],
  ])("rejects invalid per-task stress policy %s=%s", (key, value) => {
    expect(PolicyConfigSchema.safeParse({ ...resolveEffectiveConfig().policy, [key]: value }).success).toBe(false);
  });
  it.each([["maxStressWorkers", 2], ["maxStressVus", 2], ["maxStressRequestConcurrency", 2], ["maxStressRps", 2], ["stressMetricMemoryBytes", 1048576], ["stressEvidenceMaxSamples", 2]] as const) ("prevents inherited stress limit %s escalation", (key, limit) => {
    expect(() => resolveEffectiveConfig({ workspace: { [key]: limit }, project: { [key]: limit + 1 } })).toThrow();
  });
  it("fills stress defaults into legacy saved configuration and tracks their source", () => {
    const c = resolveEffectiveConfig({ agent: { maxConcurrentJobs: 2 } });
    expect.soft(c.agent).toMatchObject({ maxConcurrentJobs: 2, maxConcurrentStressJobs: 1, maxStressProcesses: 5, maxStressVus: 100, maxStressRequestConcurrency: 100, maxStressRps: 1000, maxStressMetricMemoryBytes: 335544320, stressProgressIntervalMs: 1000 });
    expect.soft(c.policy).toMatchObject({ maxStressWorkers: 4, maxStressVus: 1000, maxStressRequestConcurrency: 1000, maxStressRps: 1000, stressMetricMemoryBytes: 67108864, stressEvidenceMaxSamples: 20 });
    expect.soft(c.sources["agent.maxConcurrentStressJobs"]).toBe("default");
    expect.soft(c.sources["policy.maxStressWorkers"]).toBe("default");
  });
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

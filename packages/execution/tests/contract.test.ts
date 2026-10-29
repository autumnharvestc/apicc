import { describe, expect, it } from "vitest";
import { DebugInvocationSchema, StressPlanSchema } from "@apicc/core/schema";
import { TaskEnvelopeV1Schema, TaskTargetSchema, AssetVersionSchema, AgentMessageV1Schema, AgentCommandV1Schema, ControlBatchV1Schema, DebugSessionHandleSchema, StressReservationSchema, StressExecutionMetadataSchema, validateDispatchBinding, resolveEffectiveConfig, runtimeCompatibilityIdForRuntime } from "../src/contract/index.js";
import { fingerprintSources } from "../src/buildIdentity.js";
import { createAgentControlTransport } from "../src/client/index.js";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SubmitJobSchema, ExecutionInputsSchema, executionInputsDigestText, ProjectExecutionAgentsSchema, resolveStressExecutionConfig } from "../src/contract/index.js";
import { createProjectSnapshot } from "@apicc/core";
import { createContractExecutionProject } from "../../core/tests/helpers/contractExecutionFixtures.js";
import { prepareExecution, executionCapabilities } from "../src/host/index.js";

const uuid = "10000000-0000-4000-8000-000000000001";
const hash = "a".repeat(64);
const scope = { workspaceId: "1", groupId: "2", projectId: "3" };
const invocation = { mode: "request", locator: { workspaceId: uuid, groupId: uuid, projectId: uuid, collectionId: uuid, folderIds: [], apiId: uuid }, request: { protocol: "http", method: "GET", baseUrl: "https://example.test", path: "/", pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, body: { kind: "none" } }, parameters: {}, fields: [] };
const task = { protocolVersion: 1, jobId: "10", executionId: "11", scope, submittedByUserId: "4", contractProjectId: uuid, snapshotId: "12", manifestHash: hash, target: { kind: "debug", invocation }, policyVersion: "1", requiredCoreBuildId: hash, executionProfile: "no-script", dispatchKind: "shared-debug", scriptPlanDigest: hash, requiredCapabilities: ["protocol:http"], runtimeCompatibilityId: "controlled-node22-v1" };
const id = { messageId: "100", jobId: "10", executionId: "11" };
const start = { ...id, kind: "start-request", inputsDigest: hash, policyVersion: "1", scriptPlanDigest: hash, scriptRequirements: [], executionProfile: "no-script", runtimeCompatibilityId: "controlled-node22-v1", credentialVersions: {} };
const reservation = { jobs: 1, processes: 3, vus: 4, requestConcurrency: 100, maxRps: 1000, metricMemoryBytes: 201326592 };
const stressBinding = { stage: "compiled-limits", admissionLimits: { maxVus: 100, maxRequestConcurrency: 100, maxRps: 1000 }, requested: { maxRequestConcurrency: null, maxRps: null }, sources: { maxRequestConcurrency: "agent.maxStressRequestConcurrency:default", maxRps: "policy.maxStressRps:default" }, evidenceMaxSamples: 20, numericMemoryBytes: 67108864,
  reservation: { jobs: 1, processes: 1, vus: 2, requestConcurrency: 2, maxRps: 1000, metricMemoryBytes: 67108864 } };
const complete = { execution: { complete: true, reasons: [] }, metrics: { complete: true, reasons: [] }, load: { complete: true, reasons: [] } };
const stressProgress = { ...id, kind: "stress-progress", sequence: 1, observedAt: "2026-10-26T00:00:00Z", runId: "run", state: "running", phase: "measurement", stageId: null, atMs: 100, activeVus: 2, startedIterations: 4, completedIterations: 2, droppedIterations: 0, requests: { started: 8, completed: 6, eligibleCompleted: 6, failed: 1 }, completeness: complete };
const stressMetadata = { location: { kind: "agent", agentId: "5" }, executor: { id: "5", name: "Load agent" }, workerCount: 2, processes: 3, resources: { requested: reservation, effective: reservation }, runtime: { coreBuildId: hash, scriptApiId: hash, nodeVersion: "22.19.0", v8Version: "12.4.254.21-node.29", runtimeCompatibilityId: "controlled-node22-v1" }, status: { preparation: "ready", execution: "running", upload: "pending" }, contentionHints: [] };
const plan = { formatVersion: 1, target: { kind: "workflow", workflowId: "flow" }, load: { kind: "constant-vus", vus: 2 }, maxVus: 2, termination: { maxIterations: 4 } };
const submit = { intentId: "intent", agentId: "5", snapshotId: "12", target: { kind: "stress", plan }, runConfig: { stress: {} }, materials: { projectId: "3", credentials: [], attachments: [] }, preparation: { stressBinding, scope, manifestHash: hash, scriptPlanDigest: hash, scriptRequirements: [], executionProfile: "no-script", dispatchKind: "dedicated-task", requiredCoreBuildId: hash, requiredCapabilities: ["task:stress"], runtimeCompatibilityId: "controlled-node22-v1" } };

it("admits the real Electron main combination after the shared semantic probe and rejects unknown combinations", () => {
  const scriptApi = "afaf628a48532cff1e1e9264f328830ea1678b877853e324bab040039d0721d0";
  expect(runtimeCompatibilityIdForRuntime("24.19.0", "15.2.124.18-electron.0", scriptApi)).toBe(`node-24.19.0-v8-15.2.124.18-electron.0-script-${scriptApi}`);
  expect(() => runtimeCompatibilityIdForRuntime("24.19.1", "15.2.124.18-electron.0", scriptApi)).toThrow(/Unknown/);
  expect(() => runtimeCompatibilityIdForRuntime("24.19.0", "15.2.124.18-electron.1", scriptApi)).toThrow(/Unknown/);
});

describe("task and message contract", () => {
  it("accepts scoped stress capacity and authority sources without unrelated node settings", () => {
    const effective = resolveEffectiveConfig();
    const agent = { maxConcurrentStressJobs: 1, maxStressProcesses: 5, maxStressVus: 100, maxStressRequestConcurrency: 100, maxStressRps: 1.5, maxStressMetricMemoryBytes: 335544320 };
    const sources = { "agent.maxStressRequestConcurrency": "default", "agent.maxStressRps": "agent", "policy.maxStressRequestConcurrency": "default", "policy.maxStressRps": "project" };
    const row = { id: "5", name: "Load agent", acceptingJobs: true, availability: "runtime-missing", lastSeenAt: null, configuration: { configVersion: "1", appliedConfigVersion: "1", status: "applied", pendingFields: [], restartRequiredFields: [] }, policy: effective.policy, policyVersion: "1", scriptsAllowed: false, scriptGrant: { version: "0", scope: "script-version", scripts: [] }, stressConfiguration: { agent, sources } };
    const projection = { defaultAgentId: "5", canManageScripts: false, policy: effective.policy, policyVersion: "1", agents: [row] };
    expect.soft(ProjectExecutionAgentsSchema.safeParse(projection).success).toBe(true);
    const projected = ProjectExecutionAgentsSchema.parse(projection).agents[0]!;
    const admission = resolveStressExecutionConfig(plan, {}, { ...projected.stressConfiguration, policy: projected.policy });
    expect(admission.effective.maxRps).toBe(1.5);
    expect(admission.sources.maxRps).toBe("agent.maxStressRps:agent");
    expect.soft(ProjectExecutionAgentsSchema.safeParse({ ...projection, agents: [{ ...row, stressConfiguration: { agent: { ...agent, inputCacheBytes: 1024 }, sources } }] }).success).toBe(false);
    expect.soft(ProjectExecutionAgentsSchema.safeParse({ ...projection, agents: [{ ...row, stressConfiguration: { agent, sources: { ...sources, "policy.maxStressRps": "client" } } }] }).success).toBe(false);
  });
  it("fixes stress executor identity in the digest and requires it with a compiled binding", () => {
    const fixed = { executionId: "11", snapshot: { snapshotId: "12", createdByUserId: "4", assets: { ...scope, format: "contract-files-v1", contractProjectId: uuid, version: "1", manifestHash: hash, files: [] } }, policy: resolveEffectiveConfig().policy, runConfig: { stress: {} }, materials: submit.materials, inputsDigest: hash, stressBinding };
    expect.soft(ExecutionInputsSchema.safeParse({ ...fixed, stressExecutor: { id: "5", name: "Load agent" } }).success).toBe(true);
    expect(executionInputsDigestText({ ...fixed, stressExecutor: { id: "5", name: "Load agent" } })).not.toBe(executionInputsDigestText({ ...fixed, stressExecutor: { id: "5", name: "Renamed agent" } }));
    expect.soft(ExecutionInputsSchema.safeParse(fixed).success).toBe(false);
    expect.soft(ExecutionInputsSchema.safeParse({ ...fixed, stressExecutor: { id: "5", name: "x".repeat(513) } }).success).toBe(false);
    const ordinary = { ...fixed, stressBinding: undefined, runConfig: {} };
    expect.soft(ExecutionInputsSchema.safeParse({ ...ordinary, stressExecutor: { id: "5", name: "Load agent" } }).success).toBe(false);
  });
  it("fails generation when the public compiled binding loses its represented JSON boundary", () => {
    const generator = new URL("../scripts/generate-java-input-schema.mjs", import.meta.url).href;
    const script = `import { registerHooks } from 'node:module';
      registerHooks({ load(url, context, nextLoad) {
        if (url.endsWith('/dist/contract/stress.js')) return { format: 'module', shortCircuit: true, source: 'import { z } from "zod"; export * from ' + JSON.stringify(url + '?actual') + '; export const StressCompiledBindingSchema = z.unknown();' };
        return nextLoad(url, context);
      }});
      process.argv.push('--check'); await import(${JSON.stringify(generator)});`;
    expect(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", stdio: "pipe" })).toThrow(/Unrepresented unknown/);
  });
  it("requires a compiled reservation for stress submission and rejects contradictory resource declarations", () => {
    expect.soft(SubmitJobSchema.safeParse({ ...submit, preparation: { ...submit.preparation, stressBinding: undefined } }).success).toBe(false);
    for (const binding of [
      { ...stressBinding, reservation: { ...stressBinding.reservation, vus: 1 } },
      { ...stressBinding, reservation: { ...stressBinding.reservation, processes: 3 } },
      { ...stressBinding, reservation: { ...stressBinding.reservation, metricMemoryBytes: 1048576 } },
      { ...stressBinding, reservation: { ...stressBinding.reservation, requestConcurrency: 101 } },
      { ...stressBinding, requested: { maxRequestConcurrency: 9, maxRps: null } },
    ]) expect.soft(SubmitJobSchema.safeParse({ ...submit, preparation: { ...submit.preparation, stressBinding: binding } }).success).toBe(false);
    expect.soft(SubmitJobSchema.safeParse({ ...submit, target: { kind: "workflow", workflowId: uuid }, runConfig: {} }).success).toBe(false);
  });
  it("binds the same compiled reservation through preparation, fixed inputs and start declaration", () => {
    const fixed = { executionId: "11", snapshot: { snapshotId: "12", createdByUserId: "4", assets: { ...scope, format: "contract-files-v1", contractProjectId: uuid, version: "1", manifestHash: hash, files: [] } }, policy: resolveEffectiveConfig().policy, runConfig: { stress: {} }, materials: submit.materials, inputsDigest: hash, stressBinding, stressExecutor: { id: "5", name: "Load agent" } };
    expect.soft(SubmitJobSchema.safeParse({ ...submit, preparation: { ...submit.preparation, stressBinding } }).success).toBe(true);
    expect.soft(ExecutionInputsSchema.safeParse(fixed).success).toBe(true);
    expect.soft(AgentMessageV1Schema.safeParse({ ...start, stressBinding }).success).toBe(true);
    expect(executionInputsDigestText(fixed)).not.toBe(executionInputsDigestText({ ...fixed, stressBinding: { ...stressBinding, reservation: { ...stressBinding.reservation, requestConcurrency: 1 } } }));
    expect(executionInputsDigestText(fixed)).not.toBe(executionInputsDigestText({ ...fixed, stressBinding: { ...stressBinding, evidenceMaxSamples: 2 } }));
  });
  it("rejects missing or inconsistent fixed stress topology", () => {
    const fixed = { executionId: "11", snapshot: { snapshotId: "12", createdByUserId: "4", assets: { ...scope, format: "contract-files-v1", contractProjectId: uuid, version: "1", manifestHash: hash, files: [] } }, policy: resolveEffectiveConfig().policy, runConfig: { stress: { workerCount: 1 } }, materials: submit.materials, inputsDigest: hash };
    expect.soft(ExecutionInputsSchema.safeParse(fixed).success).toBe(false);
    expect.soft(ExecutionInputsSchema.safeParse({ ...fixed, stressBinding: { ...stressBinding, reservation: { ...stressBinding.reservation, processes: 3, metricMemoryBytes: 201326592 } } }).success).toBe(false);
  });
  it("carries the same stress settings in fixed inputs and includes them in the digest", () => {
    const fixed = { executionId: "11", snapshot: { snapshotId: "12", createdByUserId: "4", assets: { ...scope, format: "contract-files-v1", contractProjectId: uuid, version: "1", manifestHash: hash, files: [] } }, policy: resolveEffectiveConfig().policy, runConfig: { stress: { workerCount: 1, confirmedTargetOrigins: ["https://example.test"] } }, stressBinding, stressExecutor: { id: "5", name: "Load agent" }, materials: submit.materials, inputsDigest: hash };
    expect(ExecutionInputsSchema.parse(fixed).runConfig.stress).toEqual({ workerCount: 1, confirmedTargetOrigins: ["https://example.test"] });
    expect(executionInputsDigestText(fixed)).not.toBe(executionInputsDigestText({ ...fixed, runConfig: { stress: { workerCount: 1, confirmedTargetOrigins: [] } } }));
  });
  it("keeps stress out of shared debug and rejects unknown typed stress fields", () => {
    const stressTask = { ...task, target: { kind: "stress", plan }, dispatchKind: "dedicated-task" };
    expect(TaskEnvelopeV1Schema.safeParse(stressTask).success).toBe(true);
    expect(TaskEnvelopeV1Schema.safeParse({ ...stressTask, dispatchKind: "shared-debug" }).success).toBe(false);
    expect(TaskEnvelopeV1Schema.safeParse({ ...stressTask, debugSessionId: "session" }).success).toBe(false);
    expect(SubmitJobSchema.safeParse({ ...submit, debugSessionId: "session" }).success).toBe(false);
    expect(AgentMessageV1Schema.safeParse({ ...stressProgress, sequence: 0 }).success).toBe(false);
    expect(AgentMessageV1Schema.safeParse({ ...stressProgress, arbitrary: true }).success).toBe(false);
    expect(StressReservationSchema.safeParse({ ...reservation, jobs: 2 }).success).toBe(false);
    expect(StressReservationSchema.safeParse({ ...reservation, metricMemoryBytes: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
    expect(StressExecutionMetadataSchema.safeParse({ ...stressMetadata, arbitrary: true }).success).toBe(false);
  });
  it("rejects an unresolved stress workflow before execution", () => {
    const snapshot = createProjectSnapshot(createContractExecutionProject("https://example.test"));
    expect(() => prepareExecution({ snapshot, profile: "no-script", target: { kind: "stress", plan: StressPlanSchema.parse(plan) } })).toThrow(/flow|workflow/i);
  });
  it.each([
    { name: "non-stress target run config", patch: { target: { kind: "workflow", workflowId: uuid } } },
    { name: "outer environment", patch: { environmentId: uuid, target: { kind: "stress", plan: { ...plan, environmentId: "20000000-0000-4000-8000-000000000002" } } } },
    { name: "workers above plan VUs", patch: { runConfig: { stress: { workerCount: 3 } } } },
  ])("rejects submitted stress mismatch: $name", ({ patch }) => {
    expect(SubmitJobSchema.safeParse(submit).success).toBe(true);
    expect(SubmitJobSchema.safeParse({ ...submit, ...patch }).success).toBe(false);
  });
  it.each([
    { requests: { started: 1, completed: 2, eligibleCompleted: 1, failed: 0 } },
    { requests: { started: 2, completed: 1, eligibleCompleted: 2, failed: 0 } },
    { requests: { started: 2, completed: 2, eligibleCompleted: 1, failed: 2 } },
    { startedIterations: 1, completedIterations: 2 },
  ])("rejects impossible cumulative stress counts %j", patch => expect(AgentMessageV1Schema.safeParse({ ...stressProgress, ...patch }).success).toBe(false));
  it.each([{ processes: 2 }, { resources: { requested: reservation, effective: { ...reservation, processes: 1 } } }, { executor: { id: "6", name: "Other agent" } }])("rejects inconsistent stress metadata %j", patch => expect(StressExecutionMetadataSchema.safeParse({ ...stressMetadata, ...patch }).success).toBe(false));
  it("accepts the typed stress resource reservation", () => expect(StressReservationSchema.safeParse(reservation).success).toBe(true));
  it("accepts typed external stress execution metadata", () => expect(StressExecutionMetadataSchema.safeParse(stressMetadata).success).toBe(true));
  it("accepts cumulative stress progress without equating iterations to requests", () => expect(AgentMessageV1Schema.safeParse(stressProgress).success).toBe(true));
  it("accepts the existing Core stress plan as a dedicated target", () => {
    const plan = { formatVersion: 1, target: { kind: "workflow", workflowId: "flow" }, load: { kind: "constant-vus", vus: 2 }, maxVus: 2, termination: { maxIterations: 4 } };
    expect(TaskTargetSchema.safeParse({ kind: "stress", plan }).success).toBe(true);
  });
  it("rejects mismatched outer and stress plan environments", () => {
    const plan = { formatVersion: 1, target: { kind: "workflow", workflowId: "flow" }, load: { kind: "constant-vus", vus: 2 }, maxVus: 2, termination: { maxIterations: 4 }, environmentId: uuid };
    const stress = { ...task, target: { kind: "stress", plan }, dispatchKind: "dedicated-task" };
    expect(TaskEnvelopeV1Schema.safeParse({ ...stress, environmentId: uuid }).success).toBe(true);
    expect(TaskEnvelopeV1Schema.safeParse({ ...stress, environmentId: "20000000-0000-4000-8000-000000000002" }).success).toBe(false);
  });
  it("returns an ordinary validation failure for malformed asset versions", () => {
    for (const value of ["abc", "1.5"]) {
      expect(() => AssetVersionSchema.safeParse(value)).not.toThrow();
      expect(AssetVersionSchema.safeParse(value).success).toBe(false);
    }
    expect(AssetVersionSchema.safeParse("0").success).toBe(true);
    expect(AssetVersionSchema.safeParse("9223372036854775807").success).toBe(true);
    expect(AssetVersionSchema.safeParse("9223372036854775808").success).toBe(false);
  });
  it("uses a valid Core fixture, preserving exact business validation", () => {
    expect(DebugInvocationSchema.safeParse(invocation).success).toBe(true);
    expect(TaskEnvelopeV1Schema.safeParse(task).success).toBe(true);
    expect(TaskTargetSchema.safeParse({ kind: "debug", invocation: { ...invocation, request: { protocol: "unknown" } } }).success).toBe(false);
    expect(TaskTargetSchema.safeParse({ kind: "suite", suiteId: "numeric-not-core-uuid", allowDraft: false }).success).toBe(false);
    expect(TaskTargetSchema.safeParse({ kind: "workflow", workflowId: uuid, inputs: { value: Infinity } }).success).toBe(false);
  });
  it("rejects malformed identities, profiles and shared dispatch", () => {
    for (const patch of [
      { submittedByUserId: "someone" }, { scope: { ...scope, projectId: uuid } }, { protocolVersion: 2 },
      { manifestHash: "not-a-hash" }, { scriptPlanDigest: "" }, { runtimeCompatibilityId: "" },
      { executionProfile: "trusted-core-script", scriptGrantVersion: "1" },
      { target: { kind: "suite", suiteId: uuid, allowDraft: false } },
      { unexpected: true },
    ]) expect(TaskEnvelopeV1Schema.safeParse({ ...task, ...patch }).success).toBe(false);
    expect(TaskEnvelopeV1Schema.safeParse({ ...task, executionProfile: "trusted-core-script", dispatchKind: "dedicated-task" }).success).toBe(false);
    expect(TaskEnvelopeV1Schema.safeParse({ ...task, executionProfile: "trusted-core-script", dispatchKind: "dedicated-task", scriptGrantVersion: "2" }).success).toBe(true);
    expect(TaskEnvelopeV1Schema.safeParse({ ...task, target: { kind: "suite", suiteId: uuid, allowDraft: false }, dispatchKind: "dedicated-task", debugSessionId: "session" }).success).toBe(false);
  });
  it("binds server subject and debug handle to server, scope, owner, agent and lifetime", () => {
    const handle = { debugSessionId: "session", serverId: "server", scope, submittedByUserId: "4", agentId: "5", expiresAt: "2026-10-26T01:00:00.000Z" };
    expect(DebugSessionHandleSchema.safeParse(handle).success).toBe(true);
    const binding = { serverId: "server", scope, submittedByUserId: "4", agentId: "5", nowMs: Date.parse("2026-10-26T00:00:00Z"), debugSession: handle };
    expect(() => validateDispatchBinding({ ...task, debugSessionId: "session" }, binding)).not.toThrow();
    for (const patch of [{ submittedByUserId: "9" }, { serverId: "other" }, { agentId: "6" }, { scope: { ...scope, projectId: "9" } }, { nowMs: Date.parse("2026-10-26T02:00:00Z") }, { debugSession: undefined }]) {
      expect(() => validateDispatchBinding({ ...task, debugSessionId: "session" }, { ...binding, ...patch })).toThrow();
    }
  });
  it("narrows progress and completion and requires cleanup before release", () => {
    expect(AgentMessageV1Schema.safeParse(start).success).toBe(true);
    expect(AgentMessageV1Schema.safeParse({ ...start, executionProfile: "trusted-core-script" }).success).toBe(false);
    expect(AgentMessageV1Schema.safeParse({ ...start, scriptRequirements: [{ scriptId: "operation:key", contentHash: hash, source: { filePath: "../escape", fileHash: hash }, kind: "pre" }] }).success).toBe(false);
    expect(AgentMessageV1Schema.safeParse({ ...id, kind: "progress", sequence: 1, phase: "anything", observedAt: "2026-10-26T00:00:00Z", completedRequests: 0, failedRequests: 0 }).success).toBe(false);
    expect(AgentMessageV1Schema.safeParse({ ...id, kind: "completed", verdict: "passed", finishedAt: "2026-10-26T00:00:00Z", executionReleased: false, evidenceComplete: true }).success).toBe(false);
    expect(AgentMessageV1Schema.safeParse({ ...id, kind: "completed", verdict: "passed", finishedAt: "2026-10-26T00:00:00Z", executionReleased: true, evidenceComplete: true, reportHash: hash, reportBytes: 25 }).success).toBe(true);
  });
  it("accepts typed config/policy commands and rejects arbitrary dictionaries", () => {
    expect(AgentCommandV1Schema.safeParse({ messageId: "1", kind: "apply-config", configVersion: "2", config: resolveEffectiveConfig().agent }).success).toBe(true);
    expect(AgentCommandV1Schema.safeParse({ messageId: "1", kind: "apply-config", configVersion: "2", config: { arbitrary: true } }).success).toBe(false);
    const permit = { ...id, kind: "start-permit", permitId: "50", policyVersion: "1", effectivePolicy: resolveEffectiveConfig().policy, scriptPlanDigest: hash, executionProfile: "no-script", runtimeCompatibilityId: "controlled-node22-v1", credentialVersions: {} };
    expect(AgentCommandV1Schema.safeParse(permit).success).toBe(true);
    expect(AgentCommandV1Schema.safeParse({ ...permit, effectivePolicy: { execute: "arbitrary" } }).success).toBe(false);
    expect(ControlBatchV1Schema.safeParse({ deliveries: [{ messageId: "1", task }], commands: [permit] }).success).toBe(true);
  });
});

describe("implementation build fingerprint", () => {
  it.each([
    ["z.string().refine(value => value.length > 0)", /Unrepresented custom refinement/],
    ["z.string().transform(value => value.length)", /Unrepresented pipe\/custom check/],
    ["z.unknown()", /Unrepresented unknown\/custom check/],
    ["z.any()", /Unrepresented any\/custom check/],
    ["z.string().meta({ apiccJsonWireSchema: {} })", /Invalid JSON wire metadata/],
    ["z.string().refine(value => value.length > 0).meta({ apiccJsonWireSchema: z.string().min(1) })", /Java input boundary drift/],
  ])("keeps Java schema generation closed for boundary %s", (schema, failure) => {
    const generator = new URL("../scripts/generate-java-input-schema.mjs", import.meta.url).href;
    const fixture = `import { z } from "zod"; export const TaskTargetSchema = ${schema};`;
    const script = `import { registerHooks } from "node:module";
      registerHooks({ load(url, context, nextLoad) {
        if (url.endsWith("/dist/contract/task.js")) return { format: "module", source: ${JSON.stringify(fixture)}, shortCircuit: true };
        return nextLoad(url, context);
      }});
      process.argv.push("--check"); await import(${JSON.stringify(generator)});`;
    expect(() => execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", stdio: "pipe" })).toThrow(failure);
  });
  it("advertises paired stress capabilities for the upgraded host", () => {
    expect.soft(executionCapabilities("no-script")).toContain("task:stress");
    expect.soft(executionCapabilities("no-script")).toContain("stress:local-workers-v1");
  });
  it("collects the explicit source manifest independently of current working directory", () => {
    const script = fileURLToPath(new URL("../scripts/build-identity.mjs", import.meta.url));
    const run = (cwd: URL) => JSON.parse(execFileSync(process.execPath, [script, "--print"], { cwd, encoding: "utf8" }));
    const atRoot = run(new URL("../../../", import.meta.url));
    expect(atRoot).toEqual(run(new URL("../", import.meta.url)));
    expect(atRoot.coreBuildId).toMatch(/^[a-f0-9]{64}$/);
    expect(atRoot.scriptApiId).toMatch(/^[a-f0-9]{64}$/);
    expect(atRoot.sourceFiles).toContain("packages/core/src/sandbox/jsEngine.ts");
    expect(atRoot.sourceFiles).toContain("packages/execution/src/buildIdentity.ts");
    expect(atRoot.sourceFiles).toContain("packages/execution/build-identity-sources.json");
    expect(atRoot.capabilities).toContain("protocol:websocket");
    expect.soft(atRoot.capabilities).toContain("task:stress");
    expect.soft(atRoot.capabilities).toContain("stress:local-workers-v1");
    expect(atRoot.sourceFiles.some((p: string) => /(^|\/)(dist|tests|local)\//.test(p))).toBe(false);
  });
  it("is sorted, byte sensitive, path sensitive and independent of machine paths", () => {
    const a = { path: "packages/core/src/a.ts", bytes: new TextEncoder().encode("a") };
    const b = { path: "packages/execution/src/host.ts", bytes: new TextEncoder().encode("b") };
    expect(fingerprintSources([a, b])).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprintSources([b, a])).toBe(fingerprintSources([a, b]));
    expect(fingerprintSources([a, { ...b, bytes: new TextEncoder().encode("c") }])).not.toBe(fingerprintSources([a, b]));
    expect(fingerprintSources([a, { ...b, path: "packages/execution/src/other.ts" }])).not.toBe(fingerprintSources([a, b]));
    expect(() => fingerprintSources([{ ...a, path: "C:/absolute/a.ts" }])).toThrow();
  });
});

describe("injected HTTPS control client", () => {
  it("sends scoped control JSON with auth and validates typed responses", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      // The production runner endpoint accepts a root message array, not a wrapper object.
      if (!Array.isArray(JSON.parse(String(init?.body)))) return new Response(JSON.stringify({ code: "validation_failed" }), { status: 400 });
      return new Response(JSON.stringify({ acknowledged: ["100"] }), { status: 200 });
    };
    const transport = createAgentControlTransport({ baseUrl: "https://control.test/api/v1", fetch: fetcher, token: () => "private-agent-token" });
    const result = await transport.send([{ ...id, kind: "accepted" }], new AbortController().signal);
    expect(result.acknowledged).toEqual(["100"]);
    expect(calls[0].url).toBe("https://control.test/api/v1/runner/messages");
    expect(new Headers(calls[0].init?.headers).get("authorization")).toBe("Bearer private-agent-token");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual([{ ...id, kind: "accepted" }]);
  });
  it("rejects plaintext, protocol-invalid responses, HTTP errors and excessive shared slots", async () => {
    expect(() => createAgentControlTransport({ baseUrl: "http://control.test", fetch, token: () => "token" })).toThrow();
    const transport = createAgentControlTransport({ baseUrl: "https://control.test/api/v1", fetch: async () => new Response(JSON.stringify({ deliveries: [], commands: [], arbitrary: true })), token: () => "token" });
    await expect(transport.exchange({ sessionId: "session", appliedConfigVersion: "1", availableSlots: 1, availableSharedDebugSlots: 2, acknowledgements: [] }, new AbortController().signal)).rejects.toThrow();
    await expect(transport.exchange({ sessionId: "session", appliedConfigVersion: "1", availableSlots: 1, availableSharedDebugSlots: 1, acknowledgements: [] }, new AbortController().signal)).rejects.toThrow();
    const denied = createAgentControlTransport({ baseUrl: "https://control.test/api/v1", fetch: async () => new Response("sensitive remote details", { status: 403 }), token: () => "token" });
    await expect(denied.send([], new AbortController().signal)).rejects.toThrow(/403/);
  });
});

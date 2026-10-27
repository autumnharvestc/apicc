import { describe, expect, it } from "vitest";
import { DebugInvocationSchema } from "@apicc/core/schema";
import { TaskEnvelopeV1Schema, TaskTargetSchema, AssetVersionSchema, AgentMessageV1Schema, AgentCommandV1Schema, ControlBatchV1Schema, DebugSessionHandleSchema, validateDispatchBinding, resolveEffectiveConfig, runtimeCompatibilityIdForRuntime } from "../src/contract/index.js";
import { fingerprintSources } from "../src/buildIdentity.js";
import { createAgentControlTransport } from "../src/client/index.js";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const uuid = "10000000-0000-4000-8000-000000000001";
const hash = "a".repeat(64);
const scope = { workspaceId: "1", groupId: "2", projectId: "3" };
const invocation = { mode: "request", locator: { workspaceId: uuid, groupId: uuid, projectId: uuid, collectionId: uuid, folderIds: [], apiId: uuid }, request: { protocol: "http", method: "GET", baseUrl: "https://example.test", path: "/", pathParams: [], query: [], headers: [], cookies: [], auth: { kind: "none" }, body: { kind: "none" } }, parameters: {}, fields: [] };
const task = { protocolVersion: 1, jobId: "10", executionId: "11", scope, submittedByUserId: "4", contractProjectId: uuid, snapshotId: "12", manifestHash: hash, target: { kind: "debug", invocation }, policyVersion: "1", requiredCoreBuildId: hash, executionProfile: "no-script", dispatchKind: "shared-debug", scriptPlanDigest: hash, requiredCapabilities: ["protocol:http"], runtimeCompatibilityId: "controlled-node22-v1" };
const id = { messageId: "100", jobId: "10", executionId: "11" };
const start = { ...id, kind: "start-request", inputsDigest: hash, policyVersion: "1", scriptPlanDigest: hash, scriptRequirements: [], executionProfile: "no-script", runtimeCompatibilityId: "controlled-node22-v1", credentialVersions: {} };

it("admits the real Electron main combination after the shared semantic probe and rejects unknown combinations", () => {
  const scriptApi = "4c7c797e04a8eb8769ea8d65e6248a40853e7cf1793d0e37d3e862146edac572";
  expect(runtimeCompatibilityIdForRuntime("24.19.0", "15.2.124.18-electron.0", scriptApi)).toBe(`node-24.19.0-v8-15.2.124.18-electron.0-script-${scriptApi}`);
  expect(() => runtimeCompatibilityIdForRuntime("24.19.1", "15.2.124.18-electron.0", scriptApi)).toThrow(/Unknown/);
  expect(() => runtimeCompatibilityIdForRuntime("24.19.0", "15.2.124.18-electron.1", scriptApi)).toThrow(/Unknown/);
});

describe("task and message contract", () => {
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

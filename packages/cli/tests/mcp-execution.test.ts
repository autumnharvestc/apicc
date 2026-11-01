import { expect, it, vi } from "vitest";
import { CredentialError, prepareTestData, testDataSelectionsForRequests, type SecretStore } from "@apicc/core";
import { join } from "node:path";
import { createMcpExecutionHost } from "../src/mcp/execution.js";
import { executionFixture, localCaseExecutionFixture, outcome, signal } from "./mcp-execution.fixture.js";
import { oid } from "./mcp-online.fixture.js";

const missingSecretStore: SecretStore = {
  async version(_scope, ref) { throw new CredentialError("CREDENTIAL_MISSING", ref.id); },
  async resolve(_scope, ref) { throw new CredentialError("CREDENTIAL_MISSING", ref.id); },
  async status() { return "missing"; },
  async put() { throw new Error("unexpected fixture secret write"); },
  async remove() { throw new Error("unexpected fixture secret removal"); },
};
const fixtureDefaultHost = (f: Awaited<ReturnType<typeof localCaseExecutionFixture>>) => createMcpExecutionHost({
  source: f.source, privateRoot: f.privateRoot, secretStore: missingSecretStore, networkPrivateRoot: join(f.privateRoot, "network"),
});

// Catch a missing default adapter, dispatch during prepare, waiting for completion, or duplicate dispatch.
it("default_material_saved_case_uses_the_default_core_adapter_once_before_completion", async () => {
  const f = await localCaseExecutionFixture();
  const host = fixtureDefaultHost(f);
  try {
    const prepared = await outcome(() => host.prepare(f.input, signal()));
    expect(prepared.error).toBeNull();
    expect(prepared.value).toMatchObject({ location: { kind: "local" }, environmentId: null, executionProfile: "no-script", targetKind: "debug" });
    expect(f.requests).toEqual([]);
    const ticket = prepared.value!;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const started = await Promise.race([
      host.start({ ticketId: ticket.ticketId, intentId: "default-material-once" }, signal()),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("default-start-waited-for-completion")), 1000); }),
    ]).finally(() => clearTimeout(timeout));
    expect(started).toMatchObject({ runId: ticket.runId, location: { kind: "local" }, state: "running" });
    await vi.waitFor(() => expect(f.requests).toEqual([{ method: "GET", url: "/saved-case" }]));
    expect(await host.start({ ticketId: ticket.ticketId, intentId: "default-material-once" }, signal())).toMatchObject({ runId: ticket.runId });
    expect(f.requests).toHaveLength(1);
  } finally { f.release(); await host.close(); await f.close(); }
});

// Catch silently preferring the invocation environment when the explicit input selects another one.
it("default_material_rejects_conflicting_debug_environment_selections_before_a_ticket", async () => {
  const f = await localCaseExecutionFixture({ configureProject(project) {
    project.environments = [{ id: oid(10), name: "first", variables: {}, baseUrls: {} }, { id: oid(11), name: "second", variables: {}, baseUrls: {} }];
  } });
  const host = fixtureDefaultHost(f);
  if (f.input.target.kind !== "debug") throw new Error("saved debug fixture required");
  const input = { ...f.input, environmentId: oid(11), target: { ...f.input.target, invocation: { ...f.input.target.invocation, environmentId: oid(10) } } };
  try {
    const prepared = await outcome(() => host.prepare(input, signal()));
    expect(prepared.error).toMatch(/environment|环境/i);
    expect(prepared.value).toBeUndefined();
    expect(f.requests).toEqual([]);
  } finally { await host.close(); await f.close(); }
});

// Catch reducing a saved locator to project/collection IDs and accepting a different owning group.
it("default_material_rejects_a_saved_case_outside_the_actual_full_source_scope", async () => {
  const f = await localCaseExecutionFixture();
  const host = fixtureDefaultHost(f);
  if (f.input.target.kind !== "debug") throw new Error("saved debug fixture required");
  const invocation = f.input.target.invocation;
  const input = { ...f.input, target: { ...f.input.target, invocation: { ...invocation, locator: { ...invocation.locator, groupId: oid(20) }, case: { ...invocation.case, groupId: oid(20) } } } };
  try {
    const prepared = await outcome(() => host.prepare(input, signal()));
    expect(prepared.error).toMatch(/scope|归属|定位/i);
    expect(prepared.value).toBeUndefined();
    expect(f.requests).toEqual([]);
  } finally { await host.close(); await f.close(); }
});

// R56 replaces the intermediate unsupported-job restriction with the shared effective-policy boundary.
it("default_material_rejects_job_deadline_below_shared_cleanup_grace", async () => {
  const f = await localCaseExecutionFixture();
  const host = fixtureDefaultHost(f);
  try {
    const prepared = await outcome(() => host.prepare({ ...f.input, runConfig: { jobTimeoutMs: 4999 } }, signal()));
    expect(prepared.error).toMatch(/run.?config|jobTimeout|unsupported|配置|支持/i);
    expect(prepared.value).toBeUndefined();
    expect(f.requests).toEqual([]);
  } finally { await host.close(); await f.close(); }
});

// Core's real missing-file result is diagnostics, not a rejected promise; a ticket must not hide it.
it("default_material_rejects_real_missing_driver_diagnostics_before_a_ticket", async () => {
  const f = await localCaseExecutionFixture({ configureProject(project) { project.collections[0]!.apis[0]!.cases[0]!.dataDriver = { sourcePath: "missing-driver.csv", format: "csv" }; } });
  const host = fixtureDefaultHost(f);
  try {
    const project = await f.source.readProject(f.input.projectId, signal());
    const exact = await f.localHost.prepare(project.snapshot, f.input.target, undefined, {}, { signal: signal(), workspaceRoot: f.workspaceRoot,
      scope: { workspaceId: oid(1), groupId: oid(2), projectId: oid(3) }, runConfig: {}, profile: "no-script" });
    const data = await prepareTestData(exact.snapshot, testDataSelectionsForRequests(exact.snapshot, exact.selections, exact.environmentId), { workspaceRoot: f.workspaceRoot });
    expect(data.sources).toHaveLength(1);
    expect(data.sources[0]!.diagnostics.length).toBeGreaterThan(0);
    expect(data.sources[0]!.diagnostics.some(item => item.code !== "legacy-empty-fallback")).toBe(true);
    const prepared = await outcome(() => host.prepare(f.input, signal()));
    expect(prepared.error).toMatch(/material|test.?data|driver|file|材料|数据|文件/i);
    expect(prepared.value).toBeUndefined();
    expect(f.requests).toEqual([]);
  } finally { await host.close(); await f.close(); }
});

// Catch issuing a ticket for selected secret references before fixed credential material is available.
it("default_material_boundary_missing_fixed_credential_material_is_rejected_before_a_ticket", async () => {
  const f = await localCaseExecutionFixture({ configureProject(project) {
    project.collections[0]!.apis[0]!.contract.request.auth = { kind: "bearer", token: { id: oid(40), policy: "test-auto" } };
  } });
  const host = fixtureDefaultHost(f);
  try {
    const prepared = await outcome(() => host.prepare(f.input, signal()));
    expect(f.requests).toEqual([]);
    expect(prepared.value).toBeUndefined();
    expect(prepared.error).toMatch(/credential|material|凭据|材料/i);
  } finally { await host.close(); await f.close(); }
});

// Missing saved files must still fail during prepare; legal absolute files are covered by R53 real uploads.
it("default_material_boundary_missing_binary_attachment_is_rejected_before_a_ticket", async () => {
  const f = await localCaseExecutionFixture({ configureProject(project, { driverPath }) {
    const request = project.collections[0]!.apis[0]!.contract.request;
    if (request.protocol !== "http") throw new Error("HTTP saved case required");
    request.method = "POST";
    request.body = { kind: "binary", file: { path: `${driverPath}.missing` }, contentType: "application/octet-stream" };
  } });
  const host = fixtureDefaultHost(f);
  try {
    f.writeDriver("owned actual upload bytes");
    const prepared = await outcome(() => host.prepare(f.input, signal()));
    expect(f.requests).toEqual([]);
    expect(prepared.value).toBeUndefined();
    expect(prepared.error).toMatch(/attachment|material|file|附件|材料|文件/i);
  } finally { await host.close(); await f.close(); }
});

// Catch loading changed CSV at start, or incorrectly rejecting the legitimate legacy-empty diagnostic.
it.each([
  { name: "fixed_rows", content: "value\ncaptured-before\n", path: "/{{value}}", expected: "/captured-before" },
  { name: "legacy_empty_fallback", content: "value\n", path: "/legacy-empty", expected: "/legacy-empty" },
])("default_material_capture: $name", async ({ content, path, expected }) => {
  const f = await localCaseExecutionFixture({ configureProject(project, { driverPath }) {
    const api = project.collections[0]!.apis[0]!;
    api.contract.request.path = path;
    api.cases[0]!.dataDriver = { sourcePath: driverPath, format: "csv" };
  } });
  const host = fixtureDefaultHost(f);
  try {
    f.writeDriver(content);
    const prepared = await outcome(() => host.prepare(f.input, signal()));
    expect(prepared.error).toBeNull();
    expect(f.requests).toEqual([]);
    f.writeDriver("value\nchanged-after-prepare\n");
    const ticket = prepared.value!;
    const started = await host.start({ ticketId: ticket.ticketId, intentId: "default-fixed-driver" }, signal());
    expect(started.runId).toBe(ticket.runId);
    await vi.waitFor(() => expect(f.requests).toEqual([{ method: "GET", url: expected }]));
    expect(JSON.stringify(prepared.value)).not.toContain("captured-before");
  } finally { f.release(); await host.close(); await f.close(); }
});

// Fixture proof only: the adapter executes an actual owned Core plan against the gated loopback target.
it("local_basic_fixture_reaches_the_real_core_and_one_saved_case_request", async () => {
  const f = await localCaseExecutionFixture();
  try {
    const project = await f.source.readProject(f.input.projectId, signal());
    const prepared = await f.localHost.prepare(project.snapshot, f.input.target, undefined, {}, { signal: signal(), workspaceRoot: f.workspaceRoot,
      scope: { workspaceId: oid(1), groupId: oid(2), projectId: oid(3) }, runConfig: {}, profile: "no-script" });
    expect(f.requests).toEqual([]);
    const output = f.localHost.start(prepared, "00000000-0000-4000-8000-000000000099", signal());
    await vi.waitFor(() => expect(f.requests).toEqual([{ method: "GET", url: "/saved-case" }]));
    expect(f.invocations[0]?.prepared).toBe(prepared);
    f.release();
    expect(await output).toMatchObject({ kind: "debug" });
    expect(f.requests).toHaveLength(1);
  } finally { await f.close(); }
});

// Catch missing local preparation, invoking during prepare, awaiting completion in start, or replaying intent.
it("local_basic_saved_case_prepares_without_requests_and_starts_once_before_completion", async () => {
  const f = await localCaseExecutionFixture();
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, localHost: f.localHost });
  try {
    const prepared = await outcome(() => host.prepare(f.input, signal()));
    expect(prepared.error).toBeNull();
    expect(prepared.value).toMatchObject({ location: { kind: "local" }, targetKind: "debug", environmentId: null, executionProfile: "no-script" });
    expect(f.requests).toEqual([]);
    const ticket = prepared.value!;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const started = await Promise.race([
      outcome(() => host.start({ ticketId: ticket.ticketId, intentId: "local-basic-once" }, signal())),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("start-blocked-on-case-completion")), 1000); }),
    ]).finally(() => clearTimeout(timeout));
    expect(started.error).toBeNull();
    expect(started.value).toMatchObject({ runId: ticket.runId, location: { kind: "local" }, state: "running" });
    expect(ticket.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
    await vi.waitFor(() => expect(f.requests).toEqual([{ method: "GET", url: "/saved-case" }]));
    expect(f.invocations[0]?.settled).toBe(false);
    const repeated = await host.start({ ticketId: ticket.ticketId, intentId: "local-basic-once" }, signal());
    expect(repeated.runId).toBe(ticket.runId);
    expect(f.invocations).toHaveLength(1);
    expect(f.invocations[0]?.prepared).toBe(f.preparations[0]);
    expect(f.invocations[0]?.runId).toBe(ticket.runId);
    expect(f.requests).toHaveLength(1);
    f.release();
    expect(await f.invocations[0]!.output).toMatchObject({ kind: "debug" });
    expect(f.requests).toHaveLength(1);
  } finally { f.release(); await host.close(); await f.close(); }
});

// Catch starting the real member continuation during preparation or returning no usable ticket.
it("prepare_sends_zero_business_requests", async () => {
  const f = await executionFixture();
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  try {
    const result = await outcome(() => host.prepare(f.input, signal()));
    expect(result.error).toBeNull();
    expect(result.value).toMatchObject({ location: { kind: "agent", agentId: "5" }, environmentId: null, targetKind: "debug" });
    expect(result.value?.ticketId).toEqual(expect.any(String));
    expect(f.counts).toEqual({ submissions: 0, verifications: 0, business: 0 });
  } finally { await host.close(); await f.close(); }
});

// Catch opening another profile/member client instead of consuming the source-owned capability.
it("prepare_consumes_the_same_opened_member_and_fixed_project_scope", async () => {
  const f = await executionFixture();
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  try {
    const result = await outcome(() => host.prepare(f.input, signal()));
    expect(result.error).toBeNull();
    expect(f.profileReads()).toBe(1);
    expect(f.controlRequests.filter(request => request.url.endsWith("/projects/3/execution-snapshots"))).toHaveLength(1);
    expect(f.controlRequests.every(request => request.authorization === "Bearer ONLINE_SYNTHETIC_MEMBER")).toBe(true);
    expect(result.value).toMatchObject({ snapshotId: "66", assetVersion: "1", environmentId: null, executionProfile: "no-script" });
    expect(JSON.stringify(result.value)).not.toContain("ONLINE_DEFAULT_BODY");
    expect(JSON.stringify(result.value)).not.toContain("ONLINE_SYNTHETIC_MEMBER");
  } finally { await host.close(); await f.close(); }
});

// A structurally identical object is not the source object registered by its actual factory.
it("rejects_a_structural_source_copy_without_its_owned_capability", async () => {
  const f = await executionFixture();
  const host = createMcpExecutionHost({ source: { ...f.source }, privateRoot: f.privateRoot });
  try {
    const result = await outcome(() => host.prepare(f.input, signal()));
    expect(result.error).toBe("mcp-execution-source-unavailable");
    expect(f.controlRequests.filter(request => request.url.endsWith("/execution-snapshots"))).toHaveLength(0);
  } finally { await host.close(); await f.close(); }
});

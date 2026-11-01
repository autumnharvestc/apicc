import { expect, it, vi } from "vitest";
import { createMcpExecutionHost } from "../src/mcp/execution.js";
import { executionFixture, localCaseExecutionFixture, onlineLocalCaseExecutionFixture, observeActualPreparation, outcome, signal } from "./mcp-execution.fixture.js";
import { executionCapabilityFor } from "../src/mcp/executionCapabilities.js";

// An owned local continuation has no remote job to reconcile and must not be dispatched twice.
it("online_local_remaining_same_ticket_returns_owned_run_without_remote_intent_lookup", async () => {
  const f = await onlineLocalCaseExecutionFixture();
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  try {
    const ticket = await host.prepare(f.input, signal());
    const run = await host.start({ ticketId: ticket.ticketId, intentId: "online-local-replay" }, signal());
    await vi.waitFor(() => expect(f.target.requests).toHaveLength(1));
    const lookups = f.controlRequests.filter(request => request.url.includes("/jobs/by-intent?")).length;
    const repeated = await outcome(() => host.start({ ticketId: ticket.ticketId, intentId: "online-local-replay" }, signal()));
    expect.soft(repeated.error).toBeNull();
    expect.soft(repeated.value?.runId).toBe(run.runId);
    expect.soft(f.controlRequests.filter(request => request.url.includes("/jobs/by-intent?"))).toHaveLength(lookups);
    expect(f.target.requests).toHaveLength(1);
    expect(f.counts.submissions).toBe(0);
  } finally { f.target.release(); await host.close(); await f.close(); }
});

// A real member start can already own Core work before its MCP-facing return is released.
it("online_local_remaining_close_settles_started_core_while_member_return_is_gated", async () => {
  const f = await onlineLocalCaseExecutionFixture();
  const capability = executionCapabilityFor(f.source);
  if (capability.kind !== "online") throw new Error("online fixture required");
  const actualStart = capability.member.start.bind(capability.member);
  let release!: () => void, entered!: () => void, actualRunId: string | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  const observation = vi.spyOn(capability.member, "start").mockImplementation(async (...args) => {
    const started = await actualStart(...args); actualRunId = started.runId; entered(); await gate; return started;
  });
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  let starting: ReturnType<typeof outcome> | undefined;
  try {
    const ticket = await host.prepare(f.input, signal());
    starting = outcome(() => host.start({ ticketId: ticket.ticketId, intentId: "gated-online-local-start" }, signal()));
    await arrived;
    await vi.waitFor(() => expect(f.target.requests).toHaveLength(1));
    await host.close();
    const status = await capability.member.status(capability.contextFor("3"), { kind: "local" }, actualRunId!, signal());
    expect.soft(status.state).toBe("ended");
    const disconnected = await outcome(async () => { await vi.waitFor(() => expect(f.target.closedBeforeReply).toContain("/saved-case")); });
    expect.soft(disconnected.error).toBeNull();
    release();
    expect.soft((await starting).error).toBe("mcp-execution-host-closed");
    expect(f.target.requests).toHaveLength(1);
    expect(f.counts.submissions).toBe(0);
  } finally { release(); f.target.release(); await starting; observation.mockRestore(); await host.close(); await f.close(); }
});

// Login replacement revokes new work, but must not prevent exact owner cleanup or stop another owner.
it("online_local_remaining_relogin_owner_cleanup_is_exact_and_preserves_other_owner", async () => {
  const f = await onlineLocalCaseExecutionFixture();
  const capability = executionCapabilityFor(f.source);
  if (capability.kind !== "online") throw new Error("online fixture required");
  const first = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  const other = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  let firstReport: Promise<unknown> | undefined, otherReport: Promise<unknown> | undefined;
  try {
    const a = await first.prepare(f.input, signal()), b = await other.prepare(f.otherInput, signal());
    const firstRun = await first.start({ ticketId: a.ticketId, intentId: "first-local-owner" }, signal());
    const otherRun = await other.start({ ticketId: b.ticketId, intentId: "other-local-owner" }, signal());
    const agent = await other.prepare(f.agentInput, signal());
    await other.start({ ticketId: agent.ticketId, intentId: "other-agent-owner" }, signal());
    await vi.waitFor(() => expect(f.target.requests.map(request => request.url).sort()).toEqual(["/other-owned-case", "/saved-case"]));
    let firstSettled = false, otherSettled = false;
    firstReport = outcome(() => capability.member.report(capability.contextFor("3"), { kind: "local" }, firstRun.runId, signal())).then(value => { firstSettled = true; return value; });
    otherReport = outcome(() => capability.member.report(capability.contextFor("3"), { kind: "local" }, otherRun.runId, signal())).then(value => { otherSettled = true; return value; });
    await f.relogin();
    const closed = await outcome(() => first.close());
    expect.soft(closed.error).toBeNull();
    const settled = await outcome(async () => { await vi.waitFor(() => expect(firstSettled).toBe(true)); });
    expect.soft(settled.error).toBeNull();
    expect.soft(f.target.closedBeforeReply).toContain("/saved-case");
    expect(f.target.closedBeforeReply).not.toContain("/other-owned-case");
    expect(otherSettled).toBe(false);
    expect(f.cancellations).toEqual([]);
    expect(f.counts.submissions).toBe(1);
    expect(f.target.requests).toHaveLength(2);
  } finally {
    f.target.release(); await outcome(() => first.close()); await outcome(() => other.close());
    await f.close(); await firstReport; await otherReport;
  }
});

// The authority read is real; returning from it after owner exit must not dispatch a new run.
it("supported_lifecycle_start_cannot_dispatch_after_close_during_authenticate", async () => {
  const f = await localCaseExecutionFixture();
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, localHost: f.localHost });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  let starting: ReturnType<typeof outcome> | undefined;
  const capability = executionCapabilityFor(f.source);
  const authenticate = capability.authenticate.bind(capability);
  let restoreObservation: (() => void) | undefined;
  try {
    const ticket = await host.prepare(f.input, signal());
    const observation = vi.spyOn(capability, "authenticate").mockImplementation(async requestSignal => { await authenticate(requestSignal); entered(); await gate; });
    restoreObservation = () => { observation.mockRestore(); };
    starting = outcome(() => host.start({ ticketId: ticket.ticketId, intentId: "close-while-authenticating" }, signal()));
    await arrived;
    await host.close();
    release();
    const result = await starting;
    expect.soft(result.error).toBe("mcp-execution-host-closed");
    if (f.invocations.length) await vi.waitFor(() => expect(f.requests.length > 0 || f.invocations[0]?.settled).toBe(true));
    expect.soft(f.invocations).toHaveLength(0);
    expect(f.requests).toHaveLength(0);
  } finally { release(); f.release(); await starting; restoreObservation?.(); await host.close(); await f.close(); }
});

// An abandoned cancellation command must not become a business cancellation side effect.
it("supported_lifecycle_preaborted_cancel_call_does_not_abort_local_business", async () => {
  const f = await localCaseExecutionFixture();
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, localHost: f.localHost });
  try {
    const ticket = await host.prepare(f.input, signal());
    const run = await host.start({ ticketId: ticket.ticketId, intentId: "preaborted-cancel" }, signal());
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    const call = new AbortController(); call.abort(new Error("lifecycle-cancel-call-aborted"));
    const result = await outcome(() => host.cancel(run.runId, call.signal));
    expect.soft(result.error).toBe("lifecycle-cancel-call-aborted");
    expect.soft(f.invocations[0]?.signal.aborted).toBe(false);
    expect.soft(f.invocations[0]?.settled).toBe(false);
    f.release();
    await f.invocations[0]!.output;
    expect(f.requests).toHaveLength(1);
  } finally { f.release(); await host.close(); await f.close(); }
});

// Reject stale unused input, but never erase or restart an already consumed intent after an edit.
it.each([false, true])("supported_lifecycle_definition_change_after_start_%s", async alreadyStarted => {
  const f = await localCaseExecutionFixture();
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, localHost: f.localHost });
  try {
    const ticket = await host.prepare(f.input, signal());
    if (alreadyStarted) {
      await host.start({ ticketId: ticket.ticketId, intentId: "definition-edit" }, signal());
      await vi.waitFor(() => expect(f.requests).toEqual([{ method: "GET", url: "/saved-case" }]));
    }
    await f.changeDefinition();
    expect((await f.source.readProject(f.input.projectId, signal())).snapshot.definitionRevision).not.toBe(ticket.definitionRevision);
    const result = await outcome(() => host.start({ ticketId: ticket.ticketId, intentId: "definition-edit" }, signal()));
    if (alreadyStarted) {
      expect(result.error).toBeNull();
      expect(result.value?.runId).toBe(ticket.runId);
      expect(f.invocations).toHaveLength(1);
      expect(f.requests).toEqual([{ method: "GET", url: "/saved-case" }]);
    } else {
      expect.soft(result.error).toBe("mcp-ticket-definition-changed");
      if (f.invocations.length) await vi.waitFor(() => expect(f.requests.length > 0 || f.invocations[0]?.settled).toBe(true));
      expect.soft(f.invocations).toHaveLength(0);
      expect(f.requests).toHaveLength(0);
    }
  } finally { f.release(); await host.close(); await f.close(); }
});

// This is the actual source-owned member's local Core run, not the injected offline adapter.
it("supported_lifecycle_online_source_local_close_cancels_and_settles_real_member_run", async () => {
  const target = await localCaseExecutionFixture();
  const f = await executionFixture("online", { configureProject(project) {
    const request = project.collections[0]!.apis[0]!.contract.request;
    request.baseUrl = target.baseUrl; request.path = "/saved-case"; request.auth = { kind: "none" };
    if (request.protocol === "http") request.body = { kind: "none" };
  } });
  const capability = executionCapabilityFor(f.source);
  if (capability.kind !== "online") throw new Error("online fixture required");
  const cleanup = vi.spyOn(capability.member, "stopOwnedLocalRun");
  const preparation = vi.spyOn(capability.member, "prepare");
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  let runId: string | undefined;
  try {
    const ticket = await host.prepare({ ...f.input, location: { kind: "local" } }, signal());
    const exactPrepared = await preparation.mock.results[0]!.value;
    const run = await host.start({ ticketId: ticket.ticketId, intentId: "online-source-local-owner-close" }, signal());
    runId = run.runId;
    await vi.waitFor(() => expect(target.requests).toEqual([{ method: "GET", url: "/saved-case" }]));
    await host.close();
    expect.soft(cleanup.mock.calls).toHaveLength(1);
    expect(cleanup.mock.calls[0]?.[0]).toBe(exactPrepared);
    const status = await capability.member.status(capability.contextFor("3"), { kind: "local" }, runId, signal());
    expect.soft(status.state).toBe("ended");
    if (status.state === "ended") expect(await capability.member.report(capability.contextFor("3"), { kind: "local" }, runId, signal())).toMatchObject({ verdict: "cancelled" });
    await vi.waitFor(() => expect(target.earlyConnectionCloses()).toBe(1));
    expect(f.counts.submissions).toBe(0);
    expect(target.requests).toHaveLength(1);
  } finally {
    target.release();
    if (runId) await capability.member.cancel(capability.contextFor("3"), { kind: "local" }, runId, signal());
    cleanup.mockRestore(); preparation.mockRestore(); await host.close(); await f.close(); await target.close();
  }
});

// Abort alone is insufficient: both stop paths must wait for the real invoke's registry finally.
it.each(["cancel", "close"] as const)("owned_lifecycle_local_%s_aborts_and_waits_for_real_core_cleanup", async action => {
  let releaseCleanup!: () => void;
  const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve; });
  let cleanupEntered = false;
  const f = await localCaseExecutionFixture({ beforeRegistryClose: async () => { cleanupEntered = true; await cleanupGate; } });
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, localHost: f.localHost });
  let stopping: Promise<unknown> | undefined, secondClose: Promise<unknown> | undefined;
  try {
    const ticket = await host.prepare(f.input, signal());
    const run = await host.start({ ticketId: ticket.ticketId, intentId: `owned-${action}` }, signal());
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    const invocation = f.invocations[0]!;
    let returned = false, secondReturned = false;
    stopping = outcome(() => action === "cancel" ? host.cancel(run.runId, signal()) : host.close()).then(result => { returned = true; return result; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect.soft(invocation.signal.aborted).toBe(true);
    expect.soft(returned).toBe(false);
    if (action === "close") {
      secondClose = outcome(() => host.close()).then(result => { secondReturned = true; return result; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect.soft(secondReturned).toBe(false);
    }
    await vi.waitFor(() => expect(cleanupEntered).toBe(true));
    expect(invocation.settled).toBe(false);
    expect(returned).toBe(false);
    if (action === "close") expect(secondReturned).toBe(false);
    releaseCleanup();
    expect(await stopping).toMatchObject({ error: null });
    if (secondClose) expect(await secondClose).toMatchObject({ error: null });
    expect(invocation.settled).toBe(true);
    expect(f.requests).toHaveLength(1);
    if (action === "close") expect((await outcome(() => host.prepare(f.input, signal()))).error).toBe("mcp-execution-host-closed");
  } finally {
    releaseCleanup(); f.release();
    await stopping; await secondClose;
    await host.close(); await f.close();
  }
});

// A completed start call is not the owner lifetime of the still gated business request.
it("owned_lifecycle_aborting_completed_start_call_does_not_cancel_local_run", async () => {
  const f = await localCaseExecutionFixture();
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, localHost: f.localHost });
  try {
    const ticket = await host.prepare(f.input, signal());
    const call = new AbortController();
    await host.start({ ticketId: ticket.ticketId, intentId: "completed-start-signal" }, call.signal);
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    call.abort(new Error("completed-tool-call-disconnected"));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(f.invocations[0]?.signal.aborted).toBe(false);
    expect(f.invocations[0]?.settled).toBe(false);
    f.release();
    expect(await f.invocations[0]!.output).toMatchObject({ kind: "debug" });
    expect(f.requests).toHaveLength(1);
  } finally { f.release(); await host.close(); await f.close(); }
});

// Closing this MCP owner must not cancel an already accepted remote job or resubmit its intent.
it("owned_lifecycle_online_accepted_agent_survives_close_and_remains_reconcilable", async () => {
  const f = await executionFixture();
  const first = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  const second = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  try {
    const ticket = await first.prepare(f.input, signal());
    const run = await first.start({ ticketId: ticket.ticketId, intentId: "accepted-owner-exit" }, signal());
    const lookups = f.controlRequests.filter(request => request.url.includes("/jobs/by-intent?")).length;
    await first.close(); await first.close();
    expect(f.cancellations).toEqual([]);
    const recovered = await second.start({ ticketId: ticket.ticketId, intentId: "accepted-owner-exit" }, signal());
    expect(recovered).toMatchObject({ runId: run.runId, location: { kind: "agent", agentId: "5" }, bindingStatus: "fixed-input-binding-unverified" });
    expect(f.controlRequests.filter(request => request.url.endsWith("/cancel"))).toHaveLength(0);
    expect(f.controlRequests.filter(request => request.url.includes("/jobs/by-intent?"))).toHaveLength(lookups + 1);
    expect(f.counts).toEqual({ submissions: 1, verifications: 0, business: 0 });
  } finally { await first.close(); await second.close(); await f.close(); }
});

// Explicit remote cancel must use the already owned member, original scope/location/run, and one POST.
it("owned_lifecycle_explicit_online_cancel_uses_original_owned_member_and_agent_job", async () => {
  const f = await executionFixture();
  const capability = executionCapabilityFor(f.source);
  if (capability.kind !== "online") throw new Error("online fixture required");
  const cancel = vi.spyOn(capability.member, "cancel");
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  try {
    const ticket = await host.prepare(f.input, signal());
    const run = await host.start({ ticketId: ticket.ticketId, intentId: "explicit-agent-cancel" }, signal());
    const result = await outcome(() => host.cancel(run.runId, signal()));
    expect.soft(result.error).toBeNull();
    expect.soft(cancel.mock.calls).toHaveLength(1);
    expect.soft(cancel.mock.calls[0]?.slice(0, 3)).toEqual([{ serverId: "https://service.example/api/v1", ownerId: "7", scope: { workspaceId: "1", groupId: "2", projectId: "3" } }, { kind: "agent", agentId: "5" }, "99"]);
    expect.soft(f.cancellations).toEqual([{ url: "https://service.example/api/v1/jobs/99/cancel", method: "POST", body: {} }]);
    expect.soft(f.controlRequests.filter(request => request.url.endsWith("/jobs/99") && request.method === "GET")).toHaveLength(1);
    expect(f.counts).toEqual({ submissions: 1, verifications: 0, business: 0 });
  } finally { cancel.mockRestore(); await host.close(); await f.close(); }
});

// Catch routing a local source to an agent or reporting a generic error as the intended boundary.
it("local_source_rejects_agent", async () => {
  const f = await executionFixture("local");
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  try {
    const result = await outcome(() => host.prepare(f.input, signal()));
    expect(result.error).toBe("local-source-agent-not-supported");
    expect(result.value).toBeUndefined();
    expect(f.counts).toEqual({ submissions: 0, verifications: 0, business: 0 });
  } finally { await host.close(); await f.close(); }
});

// Closing during async preparation must revoke the host's pending read, without closing the source.
it("host_close_aborts_an_inflight_preparation_before_it_can_issue_a_ticket", async () => {
  let entered!: () => void, release!: () => void;
  const arrived = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await executionFixture("online", { beforeSnapshot: async () => { entered(); await gate; } });
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  try {
    const preparing = outcome(() => host.prepare(f.input, signal()));
    await arrived; await host.close(); release();
    const result = await preparing;
    expect(result.error).toBe("mcp-execution-host-closed");
    expect(result.value).toBeUndefined();
    expect(f.materialSignals).toHaveLength(0);
  } finally { release(); await host.close(); await f.close(); }
});

// Expiry is a resource lifecycle event even if the client never calls start or prepare again.
it("unused_ticket_expiry_disposes_resources_without_another_tool_call", async () => {
  const f = await executionFixture();
  const actual = observeActualPreparation(f.source);
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, limits: { ticketTtlMs: 30000 } });
  try {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await host.prepare(f.input, signal());
    const exactPrepared = await actual.prepared();
    await vi.advanceTimersByTimeAsync(30001);
    expect((await outcome(() => actual.member.start(exactPrepared, "discard-proof", signal()))).error).toBe("prepared-member-run-discarded");
    expect(f.counts.submissions).toBe(0);
  } finally { await host.close(); vi.useRealTimers(); await f.close(); }
});

// Closing a host must reject later calls independently of whether it had any pending preparation.
it("closed_execution_host_cannot_prepare_again", async () => {
  const f = await executionFixture();
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  try {
    await host.close();
    expect((await outcome(() => host.prepare(f.input, signal()))).error).toBe("mcp-execution-host-closed");
    expect(await f.source.projects(signal())).toMatchObject([{ projectId: "3" }]);
  } finally { await host.close(); await f.close(); }
});

// Invalid startup limits must fail before opening any preparation resources.
it.each([{ ticketTtlMs: 29999 }, { ticketTtlMs: 900001 }, { maxTickets: 0 }, { maxTickets: 33 }])("rejects_invalid_ticket_startup_limits %j", async limits => {
  const f = await executionFixture();
  try {
    expect((await outcome(async () => createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, limits }))).error).toBe("mcp-invalid-ticket-limits");
  } finally { await f.close(); }
});

// Expiry must dispose the original unused member continuation and prevent a business submission.
it("expired_unused_ticket_discards_its_owned_preparation", async () => {
  const f = await executionFixture();
  const actual = observeActualPreparation(f.source);
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, limits: { ticketTtlMs: 30000 } });
  try {
    const ticket = await host.prepare(f.input, signal());
    const exactPrepared = await actual.prepared();
    expect(f.materialSignals.length).toBeGreaterThan(0);
    const now = Date.now(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now + 30001);
    const result = await outcome(() => host.start({ ticketId: ticket.ticketId, intentId: "expired-unused" }, signal()));
    expect(result.error).toBe("mcp-ticket-expired");
    expect((await outcome(() => actual.member.start(exactPrepared, "discard-proof", signal()))).error).toBe("prepared-member-run-discarded");
    expect(f.counts.submissions).toBe(0);
  } finally { vi.useRealTimers(); await host.close(); await f.close(); }
});

// An already consumed intent remains reconcilable after its old ticket's preparation TTL.
it("consumed_intent_reconciles_before_expired_ticket_rejection", async () => {
  const f = await executionFixture();
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, limits: { ticketTtlMs: 30000 } });
  try {
    const ticket = await host.prepare(f.input, signal());
    await host.start({ ticketId: ticket.ticketId, intentId: "consumed-before-expiry" }, signal());
    const now = Date.now(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now + 30001);
    const result = await outcome(() => host.start({ ticketId: ticket.ticketId, intentId: "consumed-before-expiry" }, signal()));
    expect(result.error).toBeNull();
    expect(result.value?.runId).toBe("99");
    expect(f.counts.submissions).toBe(1);
  } finally { vi.useRealTimers(); await host.close(); await f.close(); }
});

// Preparations awaiting async member IO must reserve the same bounded ticket capacity as ready ones.
it("ticket_capacity_is_reserved_before_parallel_preparations", async () => {
  const f = await executionFixture();
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, limits: { maxTickets: 1 } });
  try {
    const results = await Promise.all([outcome(() => host.prepare(f.input, signal())), outcome(() => host.prepare(f.input, signal()))]);
    expect(results.filter(result => result.value)).toHaveLength(1);
    expect(results.filter(result => result.error === "mcp-ticket-capacity")).toHaveLength(1);
    expect(f.controlRequests.filter(request => request.url.endsWith("/execution-snapshots"))).toHaveLength(1);
  } finally { await host.close(); await f.close(); }
});

// Host close owns unused preparations, while the borrowed readonly source remains separately usable.
it("host_close_discards_unused_preparations_and_revokes_only_its_execution_surface", async () => {
  const f = await executionFixture();
  const actual = observeActualPreparation(f.source);
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  try {
    await host.prepare(f.input, signal());
    const exactPrepared = await actual.prepared();
    await host.close();
    expect((await outcome(() => actual.member.start(exactPrepared, "discard-proof", signal()))).error).toBe("prepared-member-run-discarded");
    expect((await outcome(() => host.prepare(f.input, signal()))).error).toBe("mcp-execution-host-closed");
    expect(await f.source.projects(signal())).toMatchObject([{ projectId: "3" }]);
    expect(f.controlRequests.filter(request => request.url.endsWith("/cancel"))).toHaveLength(0);
  } finally { await host.close(); await f.close(); }
});

// Authority withdrawal must discard unused resources; it must never release a stale continuation.
it("withdrawn_source_authority_discards_unused_preparation_without_submit", async () => {
  const f = await executionFixture();
  const actual = observeActualPreparation(f.source);
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  try {
    const ticket = await host.prepare(f.input, signal());
    const exactPrepared = await actual.prepared();
    f.meStatus(403);
    const result = await outcome(() => host.start({ ticketId: ticket.ticketId, intentId: "withdrawn-authority" }, signal()));
    expect(result.error).not.toBeNull();
    expect((await outcome(() => actual.member.start(exactPrepared, "discard-proof", signal()))).error).toBe("prepared-member-run-discarded");
    expect(f.counts.submissions).toBe(0);
  } finally { await host.close(); await f.close(); }
});

// Closing the registered source must also revoke an execution host already constructed from it.
it("source_close_revokes_its_execution_preparation_capability", async () => {
  const f = await executionFixture();
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  try {
    await f.source.close();
    const result = await outcome(() => host.prepare(f.input, signal()));
    expect(result.error).toMatch(/source closed/);
    expect(f.controlRequests.filter(request => request.url.endsWith("/execution-snapshots"))).toHaveLength(0);
  } finally { await host.close(); await f.close(); }
});

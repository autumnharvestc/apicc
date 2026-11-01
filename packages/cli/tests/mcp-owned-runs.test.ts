import { basename, dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it, vi } from "vitest";
import { boundedJson } from "../src/mcp/pagination.js";
import { createMcpExecutionHost } from "../src/mcp/execution.js";
import { createMcpLocalExecutionHost } from "../src/mcp/localExecution.js";
import { executionCapabilityFor } from "../src/mcp/executionCapabilities.js";
import { createScopedMcpServer } from "../src/mcp/server.js";
import { executionFixture, localCaseExecutionFixture, onlineLocalCaseExecutionFixture, outcome, signal } from "./mcp-execution.fixture.js";

// Each path keeps the real Core promise. Reading/paging is only through the original source API.
it.each(["local", "online"] as const)("r55_owned_reads_%s_share_live_run_report_and_pagination", async kind => {
  const local = kind === "local" ? await localCaseExecutionFixture() : undefined;
  const online = kind === "online" ? await onlineLocalCaseExecutionFixture() : undefined;
  const f = local ?? online!, target = local ?? online!.target;
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, limits: { activeLocalRuns: 2 }, ...(local ? { localHost: local.localHost } : {}) });
  try {
    const first = await host.prepare(f.input, signal()), a = await host.start({ ticketId: first.ticketId, intentId: "owned-read-a" }, signal());
    const second = await host.prepare(online?.otherInput ?? f.input, signal()), b = await host.start({ ticketId: second.ticketId, intentId: "owned-read-b" }, signal());
    await vi.waitFor(() => expect(target.requests).toHaveLength(2));
    const read = await outcome(() => f.source.getRun(a.runId, signal()));
    expect.soft(read.error).toBeNull(); expect.soft(read.value).toMatchObject({ runId: a.runId, projectId: f.input.projectId, state: "running" });
    const page = await f.source.listRuns(f.input.projectId, { limit: 1 }, signal());
    expect.soft(page.items).toHaveLength(1); expect.soft(page.nextCursor).toBeTruthy();
    if (page.nextCursor) {
      const next = await f.source.listRuns(f.input.projectId, { limit: 1, cursor: page.nextCursor }, signal());
      expect.soft(new Set([...page.items, ...next.items].map(run => run.runId))).toEqual(new Set([a.runId, b.runId]));
    }
    const completion = local ? Promise.all(local.invocations.map(run => run.output)) : (() => {
      const capability = executionCapabilityFor(f.source);
      if (capability.kind !== "online") throw new Error("actual online member required");
      return Promise.all([a, b].map(run => capability.member.report(capability.contextFor(f.input.projectId), run.location, run.runId, signal())));
    })();
    target.release(); await completion;
    const report = await outcome(() => f.source.getReport(a.runId, {}, signal()));
    expect.soft(report.error).toBeNull(); expect.soft(report.value?.report).toMatchObject({ mode: "case", exchangeTotal: 1 });
    expect.soft((await outcome(() => f.source.getRun(a.runId, signal()))).value).toMatchObject({ runId: a.runId, state: "ended" });
    expect(target.requests).toHaveLength(2);
  } finally { target.release(); await host.close(); await f.close(); }
});

it("r55_agent_returned_job_id_is_an_exact_read_alias_and_not_a_second_listed_job", async () => {
  const f = await executionFixture(); const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  try {
    const ticket = await host.prepare(f.input, signal()), run = await host.start({ ticketId: ticket.ticketId, intentId: "agent-read-alias" }, signal());
    expect(run.runId).toBe("99");
    const read = await outcome(() => f.source.getRun(run.runId, signal()));
    expect.soft(read.error).toBeNull(); expect.soft(read.value).toMatchObject({ projectId: f.input.projectId, state: "queued" });
    expect.soft((await outcome(() => f.source.getReport(run.runId, {}, signal()))).error ?? "").toMatch(/report-not-archived/);
    const page = await f.source.listRuns(f.input.projectId, { limit: 10 }, signal());
    expect(page.items).toHaveLength(1); expect(page.items[0]!.runId).toMatch(/^report:/);
    expect.soft(read.value?.runId).toBe(page.items[0]!.runId);
    await host.cancel(run.runId, signal());
    expect(f.cancellations.map(item => item.url)).toEqual(["https://service.example/api/v1/jobs/99/cancel"]);
    expect(f.counts.submissions).toBe(1);
  } finally { await host.close(); await f.close(); }
});

it("r55_known_preinvoke_attachment_failure_is_readable_without_a_fabricated_native_report_or_retry", async () => {
  const privatePaths = { windowsPath: String.raw`C:\CI85_WINDOWS_PRIVATE\material.bin`, posixPath: "/CI85_POSIX_PRIVATE/material.bin" };
  const f = await localCaseExecutionFixture({ configureProject(project, { driverPath }) {
    project.variables = { ...privatePaths };
    const request = project.collections[0]!.apis[0]!.contract.request;
    if (request.protocol !== "http") throw new Error("actual HTTP fixture required");
    request.body = { kind: "binary", file: { path: driverPath }, contentType: "application/octet-stream" };
  } });
  f.writeDriver("fixed-file-before-start");
  const adapter = createMcpLocalExecutionHost({ networkPrivateRoot: join(f.privateRoot, "network") });
  const started = vi.spyOn(adapter, "start"), host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, localHost: adapter });
  const server = createScopedMcpServer(f.source);
  const client = new Client({ name: "preinvoke-failure-boundary", version: "1" }), [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(a), server.connect(b)]);
    const ticket = await host.prepare(f.input, signal()); f.writeDriver("changed-file-with-different-length-after-prepare");
    const run = await host.start({ ticketId: ticket.ticketId, intentId: "known-preinvoke" }, signal());
    expect((await outcome(() => started.mock.results[0]!.value)).error).toMatch(/FILE_SOURCE_CHANGED|changed/i);
    const report = await outcome(() => f.source.getReport(run.runId, {}, signal()));
    expect.soft(report.error).toBeNull(); expect.soft(report.value).toMatchObject({ failure: { reasonCode: "FILE_SOURCE_CHANGED", executionFact: "not-started" } });
    expect.soft(await f.source.getRun(run.runId, signal())).toMatchObject({ state: "ended", reportState: "none" });
    expect.soft(report.value ?? {}).not.toHaveProperty("report"); expect.soft(report.value ?? {}).not.toHaveProperty("requestFacts");
    // Internal source reads retain the private snapshot for ownership/context;
    // only the actual MCP tool response is the externally exposed safety boundary.
    expect.soft(report.value?.project.snapshot.project.variables).toEqual(privatePaths);
    expect.soft(report.value?.project.snapshot.project.collections[0]!.apis[0]!.contract.request).toMatchObject({ body: { kind: "binary", file: { path: f.materialPath } } });
    const exposed = await client.callTool({ name: "get-report", arguments: { runId: run.runId } });
    expect.soft(exposed.isError).not.toBe(true);
    expect.soft(exposed.structuredContent).toMatchObject({
      data: { reportId: run.runId, reportRevision: report.value?.revision, failure: { reasonCode: "FILE_SOURCE_CHANGED", executionFact: "not-started" } },
      completeness: { complete: false, evidenceComplete: false },
      limitations: expect.arrayContaining(["no-native-report", "request-facts-not-collected", "execution-will-not-be-resubmitted"]),
    });
    expect.soft(Object.keys((exposed.structuredContent as { data: Record<string, unknown> }).data).sort()).toEqual(["failure", "reportId", "reportRevision"]);
    expect.soft(JSON.stringify(exposed.content)).toMatch(/执行未开始/);
    // Path-independent ASCII directory markers also catch paths inside encoded
    // text, where JSON escaping otherwise hides native Windows backslashes.
    for (const marker of [basename(dirname(f.materialPath)), "CI85_WINDOWS_PRIVATE", "CI85_POSIX_PRIVATE"]) {
      expect.soft(JSON.stringify(exposed)).not.toContain(marker);
    }
    expect(await host.start({ ticketId: ticket.ticketId, intentId: "known-preinvoke" }, signal())).toMatchObject({ runId: run.runId });
    expect(started).toHaveBeenCalledTimes(1); expect(f.requests).toEqual([]);
  } finally { await host.close(); await client.close(); await server.close(); await f.close(); }
});

it("r55_unknown_adapter_failure_is_generic_uncertain_and_still_protects_its_slot", async () => {
  const f = await localCaseExecutionFixture(); f.release();
  const invoke = f.localHost.start, marker = "PRIVATE_CODE_AND_PATH_C_secret_body";
  f.localHost.start = async (...args) => { await invoke(...args); throw Object.assign(new Error(`C:/private/${marker}`), { code: marker }); };
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, localHost: f.localHost, limits: { activeLocalRuns: 1 } });
  try {
    const ticket = await host.prepare(f.input, signal()), run = await host.start({ ticketId: ticket.ticketId, intentId: "unknown-adapter" }, signal());
    await f.invocations[0]!.output;
    const report = await outcome(() => f.source.getReport(run.runId, {}, signal()));
    expect.soft(report.error).toBeNull(); expect.soft(report.value).toMatchObject({ failure: { reasonCode: "local-execution-failed", executionFact: "uncertain" } });
    expect(JSON.stringify(report.value) ?? "").not.toContain(marker);
    const next = await host.prepare(f.input, signal()), result = await outcome(() => host.start({ ticketId: next.ticketId, intentId: "after-uncertain" }, signal()));
    expect.soft(result.error ?? "").toMatch(/capacity|limit|容量|额度/);
    expect.soft(f.invocations).toHaveLength(1); expect(f.requests).toHaveLength(1);
  } finally { await host.close(); await f.close(); }
});

it("r55_active_capacity_rejects_a_second_run_without_dispatching_or_stopping_the_first", async () => {
  const f = await localCaseExecutionFixture(), host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, localHost: f.localHost, limits: { activeLocalRuns: 1 } });
  try {
    const a = await host.prepare(f.input, signal()); await host.start({ ticketId: a.ticketId, intentId: "active-a" }, signal());
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    const b = await host.prepare(f.input, signal()), result = await outcome(() => host.start({ ticketId: b.ticketId, intentId: "active-b" }, signal()));
    expect.soft(result.error ?? "").toMatch(/capacity|limit|容量|额度/); expect.soft(f.invocations).toHaveLength(1);
    expect(f.invocations[0]!.signal.aborted).toBe(false);
  } finally { f.release(); await host.close(); await f.close(); }
});

it("r55_consuming_a_ticket_returns_the_single_unused_slot", async () => {
  const f = await localCaseExecutionFixture(), host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, localHost: f.localHost, limits: { maxTickets: 1, activeLocalRuns: 1 } });
  try {
    const first = await host.prepare(f.input, signal()); await host.start({ ticketId: first.ticketId, intentId: "ticket-slot-a" }, signal());
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    const next = await outcome(() => host.prepare(f.input, signal()));
    expect(next.error).toBeNull(); expect(next.value?.ticketId).not.toBe(first.ticketId); expect(f.invocations).toHaveLength(1);
  } finally { f.release(); await host.close(); await f.close(); }
});

it("r55_terminal_count_eviction_keeps_original_intent_and_refuses_a_changed_ticket_reuse", async () => {
  const f = await localCaseExecutionFixture(); f.release();
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, localHost: f.localHost, limits: { terminalLocalRuns: 1 } });
  try {
    const first = await host.prepare(f.input, signal()), a = await host.start({ ticketId: first.ticketId, intentId: "retained-intent" }, signal()); await f.invocations[0]!.output;
    const second = await host.prepare(f.input, signal()); await host.start({ ticketId: second.ticketId, intentId: "new-terminal" }, signal()); await f.invocations[1]!.output;
    expect.soft((await outcome(() => f.source.getReport(a.runId, {}, signal()))).error ?? "").toMatch(/report-expired/);
    expect.soft((await outcome(() => f.source.getRun(a.runId, signal()))).value).toMatchObject({ runId: a.runId, state: "ended", reportState: "expired" });
    expect(await host.start({ ticketId: first.ticketId, intentId: "retained-intent" }, signal())).toMatchObject({ runId: a.runId });
    await f.changeDefinition(); const changed = await host.prepare(f.input, signal());
    const result = await outcome(() => host.start({ ticketId: changed.ticketId, intentId: "retained-intent" }, signal()));
    expect.soft(result.error ?? "").toMatch(/consum|已消费/); expect.soft(result.error ?? "").toContain(a.runId);
    expect.soft(f.invocations).toHaveLength(2); expect(f.requests).toHaveLength(2);
  } finally { await host.close(); await f.close(); }
});

it.each(["total", "oversized"] as const)("r55_terminal_bytes_%s_counts_complete_real_native_output", async mode => {
  const budget = 1024 * 1024, bodySize = mode === "total" ? 700 * 1024 : 2 * budget;
  const f = await localCaseExecutionFixture({ responseBody: JSON.stringify({ payload: "x".repeat(bodySize) }) }); f.release();
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, localHost: f.localHost, limits: { terminalLocalBytes: budget, terminalLocalRuns: 20 } });
  try {
    const first = await host.prepare(f.input, signal()), a = await host.start({ ticketId: first.ticketId, intentId: "byte-owned-a" }, signal());
    const payload = await f.invocations[0]!.output, bytes = Buffer.byteLength(boundedJson(payload, 16 * budget));
    if (mode === "total") {
      expect(bytes).toBeLessThan(budget); expect(bytes * 2).toBeGreaterThan(budget);
      const next = await host.prepare(f.input, signal()); await host.start({ ticketId: next.ticketId, intentId: "byte-owned-b" }, signal()); await f.invocations[1]!.output;
    } else expect(bytes).toBeGreaterThan(budget);
    expect.soft((await outcome(() => f.source.getReport(a.runId, {}, signal()))).error ?? "").toMatch(/report-expired/);
    expect.soft((await outcome(() => f.source.getRun(a.runId, signal()))).value).toMatchObject({ runId: a.runId, reportState: "expired" });
    expect(await host.start({ ticketId: first.ticketId, intentId: "byte-owned-a" }, signal())).toMatchObject({ runId: a.runId });
    expect(f.invocations).toHaveLength(mode === "total" ? 2 : 1);
  } finally { await host.close(); await f.close(); }
});

it("r55_local_intent_metadata_capacity_preserves_old_replay_and_refuses_new_business", async () => {
  const f = await localCaseExecutionFixture(); f.release();
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, localHost: f.localHost, limits: { journalMaxRecords: 1 } });
  try {
    const a = await host.prepare(f.input, signal()), run = await host.start({ ticketId: a.ticketId, intentId: "only-metadata-slot" }, signal()); await f.invocations[0]!.output;
    const b = await host.prepare(f.input, signal()), result = await outcome(() => host.start({ ticketId: b.ticketId, intentId: "new-metadata-slot" }, signal()));
    expect.soft(result.error ?? "").toMatch(/capacity|quota|limit|容量|额度/); expect.soft(f.invocations).toHaveLength(1);
    expect(await host.start({ ticketId: a.ticketId, intentId: "only-metadata-slot" }, signal())).toMatchObject({ runId: run.runId });
  } finally { await host.close(); await f.close(); }
});

it("r55_overlong_intent_is_rejected_before_retention_or_real_invoke", async () => {
  const f = await localCaseExecutionFixture(), host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, localHost: f.localHost });
  try {
    const ticket = await host.prepare(f.input, signal()), result = await outcome(() => host.start({ ticketId: ticket.ticketId, intentId: "x".repeat(513) }, signal()));
    expect.soft(result.error).not.toBeNull(); expect(f.invocations).toHaveLength(0); expect(f.requests).toEqual([]);
  } finally { f.release(); await host.close(); await f.close(); }
});

it("r55_terminal_eviction_uses_real_finish_order_not_start_order", async () => {
  const releases: Array<() => void> = [];
  const gates = [0, 1].map(() => new Promise<void>(resolve => { releases.push(resolve); }));
  const f = await localCaseExecutionFixture({ responseGate: index => gates[index]! }); f.release();
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, localHost: f.localHost, limits: { activeLocalRuns: 2, terminalLocalRuns: 1 } });
  try {
    const a = await host.prepare(f.input, signal()), first = await host.start({ ticketId: a.ticketId, intentId: "finish-order-a" }, signal());
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    const b = await host.prepare(f.input, signal()), second = await host.start({ ticketId: b.ticketId, intentId: "finish-order-b" }, signal());
    await vi.waitFor(() => expect(f.requests).toHaveLength(2));
    releases[1]!(); await f.invocations[1]!.output;
    expect(f.invocations[0]!.settled).toBe(false);
    releases[0]!(); await f.invocations[0]!.output;
    const retained = await outcome(() => f.source.getReport(first.runId, {}, signal()));
    expect.soft(retained.error).toBeNull(); expect.soft(retained.value?.report).toMatchObject({ mode: "case" });
    expect.soft((await outcome(() => f.source.getReport(second.runId, {}, signal()))).error ?? "").toMatch(/report-expired/);
    expect(f.requests).toHaveLength(2);
  } finally { for (const release of releases) release(); await host.close(); await f.close(); }
});

it("r55_online_local_consumed_intent_refuses_a_new_ticket_without_remote_lookup_or_submit", async () => {
  const f = await onlineLocalCaseExecutionFixture();
  const capability = executionCapabilityFor(f.source);
  if (capability.kind !== "online") throw new Error("actual source member required");
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  try {
    const first = await host.prepare(f.input, signal()), run = await host.start({ ticketId: first.ticketId, intentId: "online-local-consumed" }, signal());
    await vi.waitFor(() => expect(f.target.requests).toHaveLength(1));
    const native = capability.member.report(capability.contextFor(f.input.projectId), run.location, run.runId, signal());
    f.target.release(); await native;
    expect(await f.source.getReport(run.runId, {}, signal())).toMatchObject({ report: { mode: "case" } });
    const next = await host.prepare(f.input, signal());
    const lookups = () => f.controlRequests.filter(request => request.url.includes("/jobs/by-intent?")).length;
    const before = lookups();
    const refused = await outcome(() => host.start({ ticketId: next.ticketId, intentId: "online-local-consumed" }, signal()));
    expect.soft(refused.error ?? "").toMatch(/consum|已消费/); expect.soft(refused.error ?? "").toContain(run.runId);
    expect.soft(lookups() - before).toBe(0);
    expect(await f.source.getRun(run.runId, signal())).toMatchObject({ runId: run.runId, state: "ended" });
    expect(f.counts.submissions).toBe(0); expect(f.target.requests).toHaveLength(1);
  } finally { f.target.release(); await host.close(); await f.close(); }
});

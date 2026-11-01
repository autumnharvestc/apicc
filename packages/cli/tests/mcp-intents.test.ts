import { expect, it } from "vitest";
import { readFile, readdir, writeFile, mkdir, symlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createMcpExecutionHost } from "../src/mcp/execution.js";
import { executionFixture, outcome, signal } from "./mcp-execution.fixture.js";

// Catch releasing the same prepared continuation twice or replacing its original job handle.
it("same_ticket_intent_returns_prior_run", async () => {
  const f = await executionFixture();
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  try {
    const result = await outcome(async () => {
      const ticket = await host.prepare(f.input, signal());
      const first = await host.start({ ticketId: ticket.ticketId, intentId: "same-ticket-intent" }, signal());
      const repeated = await host.start({ ticketId: ticket.ticketId, intentId: "same-ticket-intent" }, signal());
      return { first, repeated };
    });
    expect(result.error).toBeNull();
    expect(result.value?.first).toMatchObject({ runId: "99", location: { kind: "agent", agentId: "5" } });
    expect(result.value?.repeated.runId).toBe("99");
    expect(f.counts.submissions).toBe(1);
    expect(f.counts.business).toBe(0);
  } finally { await host.close(); await f.close(); }
});

// A1: an actual Windows atomic replacement failure must leave the original receipt and stop admission.
it.runIf(process.platform === "win32")("audit_atomic_receipt_replace_failure_preserves_evidence_and_blocks_submit", async () => {
  const f = await executionFixture();
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  let protectedPath: string | undefined;
  try {
    const original = await host.prepare(f.input, signal());
    await host.start({ ticketId: original.ticketId, intentId: "audit-template" }, signal());
    const directory = join(f.privateRoot, "intent-receipts-v1");
    const template = JSON.parse(await readFile(join(directory, `${original.ticketId}.json`), "utf8"));
    const fresh = await host.prepare(f.input, signal());
    const { knownRunId: _run, knownExecutionId: _execution, ...binding } = template;
    const before = JSON.stringify({ ...binding, ticketId: fresh.ticketId, intentId: "audit-readonly-admission", state: "rejected" });
    protectedPath = join(directory, `${fresh.ticketId}.json`);
    await writeFile(protectedPath, before, "utf8");
    await chmod(protectedPath, 0o444);
    const result = await outcome(() => host.start({ ticketId: fresh.ticketId, intentId: "audit-readonly-admission" }, signal()));
    expect(result.error).toBe("mcp-intent-journal-unavailable");
    expect(await readFile(protectedPath, "utf8")).toBe(before);
    expect((await readdir(directory)).filter(file => file.endsWith(".tmp"))).toEqual([]);
    expect(f.counts.submissions).toBe(1);
    expect(f.counts.verifications).toBe(0);
    expect(result.error).not.toContain(f.privateRoot);
  } finally {
    if (protectedPath) await chmod(protectedPath, 0o600);
    await host.close(); await f.close();
  }
});

// R49: a bounded denial must retain its safe reason while permanently revoking this source.
it.each([{ status: 401, code: "unauthorized" }, { status: 403, code: "forbidden" }])("r49_audit_explicit_submit_denial_preserves_safe_reason_and_revokes_source %j", async denial => {
  const f = await executionFixture("online", { rejectSubmit: denial });
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  try {
    const ticket = await host.prepare(f.input, signal());
    const result = await outcome(() => host.start({ ticketId: ticket.ticketId, intentId: "audit-authority-denied" }, signal()));
    expect.soft(result.error).toContain(denial.code);
    expect.soft(result.error).toContain("勿重新提交");
    expect(result.error).toContain("execution-outcome-uncertain");
    expect(result.error).not.toContain("SYNTHETIC_PRIVATE_SERVER_ERROR_BODY");
    expect(f.counts).toEqual({ submissions: 1, verifications: 0, business: 0 });
    const receipt = JSON.parse(await readFile(join(f.privateRoot, "intent-receipts-v1", `${ticket.ticketId}.json`), "utf8"));
    expect(receipt).toMatchObject({ intentId: "audit-authority-denied", state: "uncertain" });
    expect(JSON.stringify(receipt)).not.toContain("SYNTHETIC_PRIVATE_SERVER_ERROR_BODY");
    const previousRequests = f.controlRequests.length;
    const stale = await outcome(() => f.source.projects(signal()));
    expect(stale.error).toMatch(/profile changed|已失效|重新登录/);
    expect(f.controlRequests).toHaveLength(previousRequests);
    expect(f.counts.submissions).toBe(1);
  } finally { await host.close(); await f.close(); }
});

// R49: a non-allowlisted reason must use the shared member HTTP fallback, never raw server text.
it("r49_audit_invalid_denial_code_uses_safe_fallback", async () => {
  const f = await executionFixture("online", { rejectSubmit: { status: 403, code: "forbidden PRIVATE_REASON\nunsafe" } });
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  try {
    const ticket = await host.prepare(f.input, signal());
    const result = await outcome(() => host.start({ ticketId: ticket.ticketId, intentId: "r49-unsafe-reason" }, signal()));
    expect.soft(result.error).toContain("execution-request-failed");
    expect(result.error).toContain("execution-outcome-uncertain");
    expect(result.error).not.toMatch(/PRIVATE_REASON|SYNTHETIC_PRIVATE_SERVER_ERROR_BODY/);
    expect((await outcome(() => f.source.projects(signal()))).error).toMatch(/profile changed|已失效|重新登录/);
    expect(f.counts.submissions).toBe(1);
  } finally { await host.close(); await f.close(); }
});

// R49 companion: a successful snapshot response must still reject an identity replaced during its IO.
it("r49_audit_200_snapshot_rejects_identity_changed_by_real_relogin", async () => {
  let renew!: () => Promise<unknown>;
  const f = await executionFixture("online", { beforeSnapshot: async () => { await renew(); } });
  renew = f.relogin;
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  try {
    const result = await outcome(() => host.prepare(f.input, signal()));
    expect(result.error).toMatch(/profile changed|已失效|重新登录/);
    expect(result.value).toBeUndefined();
    expect(f.controlRequests.filter(request => request.url.endsWith("/execution-snapshots"))).toHaveLength(1);
    expect(f.controlRequests.filter(request => request.url.endsWith("/auth/login"))).toHaveLength(1);
    expect(f.counts).toEqual({ submissions: 0, verifications: 0, business: 0 });
    expect((await outcome(() => f.source.projects(signal()))).error).toMatch(/profile changed|已失效|重新登录/);
  } finally { await host.close(); await f.close(); }
});

// Admission must count JSON-escaped bytes before writing or calling the shared member client.
it("journal_receipt_byte_limit_refuses_the_first_submit", async () => {
  const f = await executionFixture();
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, limits: { journalReceiptBytes: 4096 } });
  try {
    const ticket = await host.prepare(f.input, signal());
    const result = await outcome(() => host.start({ ticketId: ticket.ticketId, intentId: "\ud800".repeat(512) }, signal()));
    expect(result.error).toBe("mcp-intent-journal-capacity");
    expect(f.counts.submissions).toBe(0);
    expect((await readdir(join(f.privateRoot, "intent-receipts-v1"))).filter(file => file.endsWith(".json"))).toHaveLength(0);
  } finally { await host.close(); await f.close(); }
});

// Existing oversized aggregate metadata blocks new writes but still permits a bounded original lookup.
it("journal_total_byte_limit_preserves_original_reconciliation", async () => {
  const f = await executionFixture();
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, limits: { journalReceiptBytes: 1048576, journalTotalBytes: 1048576 } });
  try {
    const ticket = await host.prepare(f.input, signal());
    await host.start({ ticketId: ticket.ticketId, intentId: "total-original" }, signal());
    const directory = join(f.privateRoot, "intent-receipts-v1");
    const originalPath = join(directory, `${ticket.ticketId}.json`);
    const receipt = JSON.parse(await readFile(originalPath, "utf8"));
    receipt.materialVersions = Object.fromEntries(Array.from({ length: 5000 }, (_, index) => [`material-${index}-${"x".repeat(100)}`, "1"]));
    await writeFile(originalPath, JSON.stringify(receipt));
    const otherId = randomUUID();
    await writeFile(join(directory, `${otherId}.json`), JSON.stringify({ ...receipt, ticketId: otherId, intentId: "other-owned-intent" }));
    const fresh = await host.prepare(f.input, signal());
    const result = await outcome(() => host.start({ ticketId: fresh.ticketId, intentId: "total-new" }, signal()));
    expect(result.error).toBe("mcp-intent-journal-capacity");
    expect((await host.start({ ticketId: ticket.ticketId, intentId: "total-original" }, signal())).runId).toBe("99");
    expect(f.counts.submissions).toBe(1);
  } finally { await host.close(); await f.close(); }
});

// Distinct execution hosts sharing a journal must reserve capacity atomically before either can submit.
it("shared_journal_count_reservation_cannot_race_between_hosts", async () => {
  const f = await executionFixture();
  const first = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, limits: { journalMaxRecords: 1 } });
  const second = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, limits: { journalMaxRecords: 1 } });
  try {
    const a = await first.prepare(f.input, signal()), b = await second.prepare(f.input, signal());
    const results = await Promise.all([
      outcome(() => first.start({ ticketId: a.ticketId, intentId: "shared-quota-a" }, signal())),
      outcome(() => second.start({ ticketId: b.ticketId, intentId: "shared-quota-b" }, signal())),
    ]);
    expect(results.filter(result => result.value)).toHaveLength(1);
    expect(results.filter(result => result.error === "mcp-intent-journal-capacity")).toHaveLength(1);
    expect(f.counts.submissions).toBe(1);
  } finally { await first.close(); await second.close(); await f.close(); }
});

// A second fresh preparation cannot retry an undiscovered outcome from an earlier owned receipt.
it("new_ticket_cannot_resubmit_an_undiscovered_uncertain_original_intent", async () => {
  const f = await executionFixture("online", { loseSubmitResponse: true });
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  try {
    const first = await host.prepare(f.input, signal());
    await outcome(() => host.start({ ticketId: first.ticketId, intentId: "uncertain-original" }, signal()));
    f.setIntentVisible(false);
    const fresh = await host.prepare(f.input, signal());
    const result = await outcome(() => host.start({ ticketId: fresh.ticketId, intentId: "uncertain-original" }, signal()));
    expect(result.error).toBe("execution-outcome-uncertain");
    expect(f.counts.submissions).toBe(1);
  } finally { await host.close(); await f.close(); }
});

// Reject a configured journal quota outside its operator bounds before it can affect admission.
it.each([
  { journalReceiptBytes: 4095 }, { journalReceiptBytes: 1048577 },
  { journalMaxRecords: 0 }, { journalMaxRecords: 10001 },
  { journalTotalBytes: 1048575 }, { journalTotalBytes: 134217729 },
  { journalReceiptBytes: 1048576, journalTotalBytes: 1048575 },
])("rejects_invalid_operator_journal_quota %j", async limits => {
  const f = await executionFixture();
  try {
    const result = await outcome(async () => createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, limits }));
    expect(result.error).toBe("mcp-invalid-journal-limits");
    expect(f.counts.submissions).toBe(0);
  } finally { await f.close(); }
});

// An unsafe old file cannot be read without a bound, and its existence cannot authorize a new attempt.
it("oversized_old_receipt_is_preserved_without_reconciling_or_submitting", async () => {
  const f = await executionFixture();
  const first = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  try {
    const ticket = await first.prepare(f.input, signal());
    await first.start({ ticketId: ticket.ticketId, intentId: "oversized-original" }, signal());
    const path = join(f.privateRoot, "intent-receipts-v1", `${ticket.ticketId}.json`);
    await writeFile(path, " ".repeat(5000), "utf8");
    const second = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, limits: { journalReceiptBytes: 4096 } });
    try {
      const result = await outcome(() => second.start({ ticketId: ticket.ticketId, intentId: "oversized-original" }, signal()));
      expect(result.error).toBe("mcp-intent-receipt-unreadable");
      expect((await readFile(path)).byteLength).toBe(5000);
      expect(f.counts.submissions).toBe(1);
    } finally { await second.close(); }
  } finally { await first.close(); await f.close(); }
});

// Following a replaced namespace would write recovery data outside the host's captured directory.
it("journal_rejects_a_namespace_replaced_by_a_junction", async () => {
  const f = await executionFixture();
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  try {
    const ticket = await host.prepare(f.input, signal());
    const redirected = join(f.privateRoot, "unowned-directory");
    await mkdir(redirected);
    await symlink(redirected, join(f.privateRoot, "intent-receipts-v1"), "junction");
    const result = await outcome(() => host.start({ ticketId: ticket.ticketId, intentId: "redirected-receipt" }, signal()));
    expect(result.error).toBe("mcp-intent-journal-unavailable");
    expect(await readdir(redirected)).toEqual([]);
    expect(f.counts.submissions).toBe(0);
  } finally { await host.close(); await f.close(); }
});

// Binding a used ticket to a different intent must not replace its original recovery evidence.
it("different_intent_cannot_overwrite_the_original_ticket_receipt", async () => {
  const f = await executionFixture();
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  try {
    const ticket = await host.prepare(f.input, signal());
    await host.start({ ticketId: ticket.ticketId, intentId: "original-intent" }, signal());
    const changed = await outcome(() => host.start({ ticketId: ticket.ticketId, intentId: "different-intent" }, signal()));
    expect(changed.error).toBe("intent_conflict");
    const receipt = JSON.parse(await readFile(join(f.privateRoot, "intent-receipts-v1", `${ticket.ticketId}.json`), "utf8"));
    expect(receipt).toMatchObject({ intentId: "original-intent", state: "accepted", knownRunId: "99" });
    expect(f.counts.submissions).toBe(1);
  } finally { await host.close(); await f.close(); }
});

// Two overlapping starts must share the same host operation, including its receipt and result.
it("concurrent_same_ticket_start_returns_one_shared_submission_result", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const submitting = new Promise<void>(resolve => { entered = resolve; });
  const f = await executionFixture("online", { beforeSubmit: async () => { entered(); await gate; } });
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  try {
    const ticket = await host.prepare(f.input, signal());
    const first = outcome(() => host.start({ ticketId: ticket.ticketId, intentId: "concurrent-intent" }, signal()));
    await submitting;
    const second = outcome(() => host.start({ ticketId: ticket.ticketId, intentId: "concurrent-intent" }, signal()));
    await new Promise(resolve => setTimeout(resolve, 30));
    release();
    const results = await Promise.all([first, second]);
    expect(results.map(result => result.error)).toEqual([null, null]);
    expect(results.map(result => result.value?.runId)).toEqual(["99", "99"]);
    expect(f.counts.submissions).toBe(1);
  } finally { release(); await host.close(); await f.close(); }
});

// An old receipt can find an already accepted job after source reopen and changed assets, never reprepare.
it("reopened_host_reconciles_original_intent_before_changed_assets", async () => {
  const f = await executionFixture("online", { loseSubmitResponse: true });
  const first = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  let reopened: Awaited<ReturnType<typeof f.reopen>> | undefined;
  try {
    const ticket = await first.prepare(f.input, signal());
    expect((await outcome(() => first.start({ ticketId: ticket.ticketId, intentId: "lost-response-intent" }, signal()))).error).not.toBeNull();
    await first.close(); await f.source.close();
    f.assets.version = "2";
    reopened = await f.reopen();
    const second = createMcpExecutionHost({ source: reopened, privateRoot: f.privateRoot });
    const snapshots = f.controlRequests.filter(request => request.url.endsWith("/execution-snapshots")).length;
    try {
      const result = await outcome(() => second.start({ ticketId: ticket.ticketId, intentId: "lost-response-intent" }, signal()));
      expect(result.error).toBeNull();
      expect(result.value).toMatchObject({ runId: "99", bindingStatus: "fixed-input-binding-unverified" });
      expect(f.controlRequests.filter(request => request.url.endsWith("/execution-snapshots"))).toHaveLength(snapshots);
      expect(f.counts).toEqual({ submissions: 1, verifications: 0, business: 0 });
    } finally { await second.close(); }
  } finally { await reopened?.close(); await first.close(); await f.close(); }
});

// Journal count exhaustion must block a second submit while keeping the first receipt available.
it("journal_count_limit_refuses_new_submit_and_preserves_existing_receipt", async () => {
  const f = await executionFixture();
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, limits: { journalMaxRecords: 1 } });
  try {
    const first = await host.prepare(f.input, signal());
    await host.start({ ticketId: first.ticketId, intentId: "quota-first" }, signal());
    const second = await host.prepare(f.input, signal());
    const result = await outcome(() => host.start({ ticketId: second.ticketId, intentId: "quota-second" }, signal()));
    expect(result.error).toBe("mcp-intent-journal-capacity");
    expect(f.counts.submissions).toBe(1);
    expect((await readdir(join(f.privateRoot, "intent-receipts-v1"))).filter(file => file.endsWith(".json"))).toHaveLength(1);
    expect((await host.start({ ticketId: first.ticketId, intentId: "quota-first" }, signal())).runId).toBe("99");
  } finally { await host.close(); await f.close(); }
});

// Corrupt recovery data is unavailable evidence, not permission to treat an original attempt as new.
it("corrupt_old_receipt_is_preserved_and_explicitly_not_reconcilable", async () => {
  const f = await executionFixture();
  const first = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  try {
    const ticket = await first.prepare(f.input, signal());
    await first.start({ ticketId: ticket.ticketId, intentId: "corrupt-original" }, signal());
    const path = join(f.privateRoot, "intent-receipts-v1", `${ticket.ticketId}.json`);
    await writeFile(path, "{broken", "utf8");
    const second = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
    try {
      const result = await outcome(() => second.start({ ticketId: ticket.ticketId, intentId: "corrupt-original" }, signal()));
      expect(result.error).toBe("mcp-intent-receipt-unreadable");
      expect(await readFile(path, "utf8")).toBe("{broken");
      expect(f.counts.submissions).toBe(1);
    } finally { await second.close(); }
  } finally { await first.close(); await f.close(); }
});

// A3: accepting extra business fields or a different embedded ticket would recover unowned evidence.
it.each(["extra-business-field", "different-ticket-id"] as const)("audit_remaining_receipt_rejects_valid_json_with_%s", async mutation => {
  const f = await executionFixture();
  const first = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  const second = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  try {
    const ticket = await first.prepare(f.input, signal());
    await first.start({ ticketId: ticket.ticketId, intentId: "audit-schema-original" }, signal());
    await first.close();
    const path = join(f.privateRoot, "intent-receipts-v1", `${ticket.ticketId}.json`);
    const receipt = JSON.parse(await readFile(path, "utf8"));
    if (mutation === "extra-business-field") receipt.inputs = { body: "AUDIT_UNEXPECTED_BUSINESS_BODY" };
    else receipt.ticketId = "00000000-0000-4000-8000-000000000088";
    const altered = JSON.stringify(receipt);
    await writeFile(path, altered, "utf8");
    const requests = f.controlRequests.length;
    const result = await outcome(() => second.start({ ticketId: ticket.ticketId, intentId: "audit-schema-original" }, signal()));
    expect(result.error).toBe("mcp-intent-receipt-unreadable");
    expect(result.value).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe(altered);
    const recoveryRequests = f.controlRequests.slice(requests);
    expect(recoveryRequests.some(request => request.url.includes("/jobs") || request.url.endsWith("/execution-snapshots"))).toBe(false);
    expect(f.counts).toEqual({ submissions: 1, verifications: 0, business: 0 });
  } finally { await second.close(); await first.close(); await f.close(); }
});

// A4: silently removing an unknown/stale item would erase evidence and allow a new submit.
it.each(["unknown-evidence.txt", ".receipt-00000000-0000-4000-8000-000000000088.tmp"])("audit_remaining_namespace_preserves_%s_and_refuses_new_submit", async name => {
  const f = await executionFixture();
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  try {
    const original = await host.prepare(f.input, signal());
    await host.start({ ticketId: original.ticketId, intentId: "audit-namespace-original" }, signal());
    const directory = join(f.privateRoot, "intent-receipts-v1");
    const originalPath = join(directory, `${original.ticketId}.json`);
    const originalBytes = await readFile(originalPath, "utf8");
    const unknownPath = join(directory, name);
    await writeFile(unknownPath, "AUDIT_PRESERVE_UNKNOWN_EVIDENCE", "utf8");
    const fresh = await host.prepare(f.input, signal());
    const result = await outcome(() => host.start({ ticketId: fresh.ticketId, intentId: "audit-namespace-new" }, signal()));
    expect(result.error).toBe("mcp-intent-journal-unavailable");
    expect(result.value).toBeUndefined();
    expect(await readFile(unknownPath, "utf8")).toBe("AUDIT_PRESERVE_UNKNOWN_EVIDENCE");
    expect(await readFile(originalPath, "utf8")).toBe(originalBytes);
    expect(await readdir(directory)).toEqual(expect.arrayContaining([name, `${original.ticketId}.json`]));
    expect(f.counts).toEqual({ submissions: 1, verifications: 0, business: 0 });
    expect((await host.start({ ticketId: original.ticketId, intentId: "audit-namespace-original" }, signal())).runId).toBe("99");
    expect(f.counts).toEqual({ submissions: 1, verifications: 1, business: 0 });
  } finally { await host.close(); await f.close(); }
});

// A5: accepting a receipt from a prior login or ignoring its known job would return an unrelated run.
it.each([
  { changed: "profile-generation", reason: "mcp-receipt-source-changed", lookups: 0 },
  { changed: "known-job", reason: "mcp-receipt-binding-mismatch", lookups: 1 },
] as const)("audit_remaining_old_receipt_rejects_$changed", async scenario => {
  const f = await executionFixture();
  const first = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  let reopened: Awaited<ReturnType<typeof f.reopen>> | undefined;
  let second: ReturnType<typeof createMcpExecutionHost> | undefined;
  try {
    const ticket = await first.prepare(f.input, signal());
    await first.start({ ticketId: ticket.ticketId, intentId: "audit-source-binding-original" }, signal());
    await first.close();
    const path = join(f.privateRoot, "intent-receipts-v1", `${ticket.ticketId}.json`);
    if (scenario.changed === "profile-generation") {
      await f.relogin();
      reopened = await f.reopen();
    } else {
      const receipt = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, JSON.stringify({ ...receipt, knownRunId: "unrelated-job" }), "utf8");
    }
    const evidence = await readFile(path, "utf8");
    second = createMcpExecutionHost({ source: reopened ?? f.source, privateRoot: f.privateRoot });
    const before = f.controlRequests.length;
    const result = await outcome(() => second!.start({ ticketId: ticket.ticketId, intentId: "audit-source-binding-original" }, signal()));
    expect(result.error).toBe(scenario.reason);
    expect(result.value).toBeUndefined();
    expect(await readFile(path, "utf8")).toBe(evidence);
    const recoveryRequests = f.controlRequests.slice(before);
    expect(recoveryRequests.filter(request => request.url.includes("/jobs/by-intent?"))).toHaveLength(scenario.lookups);
    expect(recoveryRequests.some(request => request.url.endsWith("/execution-snapshots") || request.url.endsWith("/jobs"))).toBe(false);
    if (scenario.changed === "profile-generation") expect(f.controlRequests.filter(request => request.url.endsWith("/auth/login"))).toHaveLength(1);
    expect(f.counts).toEqual({ submissions: 1, verifications: 0, business: 0 });
  } finally { await second?.close(); await reopened?.close(); await first.close(); await f.close(); }
});

// The real submission must observe a durable pre-submit receipt, without body or credential data.
it("persists_private_binding_receipt_before_the_first_job_submit", async () => {
  let privateRoot = "";
  let observed: Record<string, unknown> | undefined;
  const f = await executionFixture("online", { beforeSubmit: async () => {
    const directory = join(privateRoot, "intent-receipts-v1");
    const files = (await readdir(directory)).filter(file => file.endsWith(".json"));
    expect(files).toHaveLength(1);
    observed = JSON.parse(await readFile(join(directory, files[0]!), "utf8"));
    expect(observed).toMatchObject({ intentId: "receipt-before-submit", state: "submitting", projectId: "3", memberId: "7", snapshotId: "66", location: { kind: "agent", agentId: "5" } });
    expect(JSON.stringify(observed)).not.toMatch(/ONLINE_DEFAULT_BODY|ONLINE_SYNTHETIC_MEMBER|parameters|inputs|request|prompt/);
  } });
  privateRoot = f.privateRoot;
  const host = createMcpExecutionHost({ source: f.source, privateRoot });
  try {
    const result = await outcome(async () => {
      const prepared = await host.prepare(f.input, signal());
      return host.start({ ticketId: prepared.ticketId, intentId: "receipt-before-submit" }, signal());
    });
    expect(result.error).toBeNull();
    expect(observed).toBeDefined();
    expect(result.value?.runId).toBe("99");
    expect(f.counts.submissions).toBe(1);
  } finally { await host.close(); await f.close(); }
});

// A caller-created ticket ID must not reach member.start or create a new intent receipt.
it("start_requires_an_owned_ticket_before_submitting", async () => {
  const f = await executionFixture();
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  try {
    const result = await outcome(() => host.start({ ticketId: "00000000-0000-4000-8000-000000000077", intentId: "unknown-ticket" }, signal()));
    expect(result.error).toBe("mcp-ticket-unavailable");
    expect(f.counts.submissions).toBe(0);
  } finally { await host.close(); await f.close(); }
});

// Catch returning a prior job for a new ticket without the member/server's fixed-input verification.
it("different_input_same_intent_conflicts", async () => {
  const f = await executionFixture();
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
  try {
    const result = await outcome(async () => {
      const original = await host.prepare(f.input, signal());
      await host.start({ ticketId: original.ticketId, intentId: "changed-budget-intent" }, signal());
      const changed = await host.prepare({ ...f.input, runConfig: { jobTimeoutMs: 60000 } }, signal());
      return outcome(() => host.start({ ticketId: changed.ticketId, intentId: "changed-budget-intent" }, signal()));
    });
    expect(result.error).toBeNull();
    expect(result.value?.error).toContain("intent_conflict");
    expect(f.counts).toEqual({ submissions: 1, verifications: 1, business: 0 });
  } finally { await host.close(); await f.close(); }
});

import fsp, { type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CredentialError, type SecretStore } from "@apicc/core";
import { describe, expect, it, vi } from "vitest";
import { createMcpExecutionHost } from "../src/mcp/execution.js";
import { createScopedMcpServer } from "../src/mcp/server.js";
import { executionFixture, localCaseExecutionFixture, outcome, signal } from "./mcp-execution.fixture.js";

describe.sequential("T8 review important fixes", () => {
  // I1: retaining only A's receipt must not make a successfully verified B unusable on replay/reopen.
  it("review_i1_verified_second_ticket_replays_and_reopens_original_job_without_reprepare_or_submit", async () => {
    const f = await executionFixture();
    const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot });
    let reopened: Awaited<ReturnType<typeof f.reopen>> | undefined, recovery: ReturnType<typeof createMcpExecutionHost> | undefined;
    try {
      const a = await host.prepare(f.input, signal());
      const first = await host.start({ ticketId: a.ticketId, intentId: "review-shared-intent" }, signal());
      expect(first).toMatchObject({ runId: "99", location: { kind: "agent", agentId: "5" } });
      const aPath = join(f.privateRoot, "intent-receipts-v1", `${a.ticketId}.json`), aReceipt = await fsp.readFile(aPath, "utf8");
      const b = await host.prepare(f.input, signal());
      const reused = await host.start({ ticketId: b.ticketId, intentId: "review-shared-intent" }, signal());
      expect(reused.runId).toBe("99"); expect(f.counts.verifications).toBe(1);
      const snapshots = f.controlRequests.filter(request => request.url.endsWith("/execution-snapshots")).length;
      expect(snapshots).toBe(2);
      const repeated = await outcome(() => host.start({ ticketId: b.ticketId, intentId: "review-shared-intent" }, signal()));
      expect.soft(repeated.error).toBeNull(); expect.soft(repeated.value?.runId).toBe("99");
      await host.close(); reopened = await f.reopen();
      recovery = createMcpExecutionHost({ source: reopened, privateRoot: f.privateRoot });
      const recovered = await outcome(() => recovery!.start({ ticketId: b.ticketId, intentId: "review-shared-intent" }, signal()));
      expect.soft(recovered.error).toBeNull(); expect.soft(recovered.value).toMatchObject({ runId: "99", location: { kind: "agent", agentId: "5" } });
      expect(f.controlRequests.filter(request => request.url.endsWith("/execution-snapshots"))).toHaveLength(snapshots);
      expect(f.controlRequests.filter(request => request.url.includes("/projects/3/jobs?"))).toHaveLength(0);
      expect(f.controlRequests.filter(request => request.method === "POST" && request.url.endsWith("/jobs"))).toHaveLength(1);
      expect(f.counts.submissions).toBe(1); expect(f.counts.business).toBe(0);
      expect(await fsp.readFile(aPath, "utf8")).toBe(aReceipt);
    } finally { await recovery?.close(); await reopened?.close(); await host.close(); await f.close(); }
  });

  // I1: associating B is a new bounded metadata record, not a bypass around a full journal.
  it("review_i1_second_ticket_association_obeys_existing_record_quota_while_original_remains_queryable", async () => {
    const f = await executionFixture();
    const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, limits: { journalMaxRecords: 1 } });
    try {
      const a = await host.prepare(f.input, signal());
      await host.start({ ticketId: a.ticketId, intentId: "review-quota-intent" }, signal());
      const b = await host.prepare(f.input, signal());
      const rejected = await outcome(() => host.start({ ticketId: b.ticketId, intentId: "review-quota-intent" }, signal()));
      expect.soft(rejected.error ?? "no-error").toMatch(/journal.*capacity/);
      expect.soft(f.counts.verifications).toBe(0);
      expect((await host.start({ ticketId: a.ticketId, intentId: "review-quota-intent" }, signal())).runId).toBe("99");
      expect((await fsp.readdir(join(f.privateRoot, "intent-receipts-v1"))).filter(name => name.endsWith(".json"))).toEqual([`${a.ticketId}.json`]);
      expect(f.counts.submissions).toBe(1); expect(f.counts.business).toBe(0);
    } finally { await host.close(); await f.close(); }
  });

  // I2: one cancelled call is not evidence that the source or other fixed preparations were revoked.
  it.each(["prepare", "start"] as const)("review_i2_cancelled_%s_call_preserves_other_unused_tickets_and_actual_attachment_handles", async method => {
    const f = await localCaseExecutionFixture({ configureProject(project, { driverPath }) {
      const request = project.collections[0]!.apis[0]!.contract.request;
      if (request.protocol !== "http") throw new Error("HTTP fixture required");
      request.method = "POST"; request.body = { kind: "binary", file: { path: driverPath }, contentType: "application/octet-stream" };
    } });
    f.writeDriver("fixed owned material survives an unrelated cancelled call");
    const handles: FileHandle[] = [], actualOpen = fsp.open;
    const observed = vi.spyOn(fsp, "open").mockImplementation(async (...args: Parameters<typeof actualOpen>) => {
      const handle = await actualOpen(...args); if (String(args[0]) === f.materialPath) handles.push(handle); return handle;
    });
    syncBuiltinESMExports();
    const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, networkPrivateRoot: join(f.privateRoot, "network") });
    try {
      const a = await host.prepare(f.input, signal()), b = await host.prepare(f.input, signal());
      expect(handles).toHaveLength(2);
      const call = new AbortController(); call.abort(new Error("review-current-call-cancelled"));
      const cancelled = await outcome(async () => {
        if (method === "prepare") await host.prepare(f.input, call.signal);
        else await host.start({ ticketId: a.ticketId, intentId: "review-abandoned-start" }, call.signal);
      });
      expect(cancelled.error).toBe("review-current-call-cancelled");
      expect((await f.source.projects(signal())).map(project => project.projectId)).toContain(f.input.projectId);
      for (const handle of handles) expect.soft((await outcome(() => handle.stat())).error).toBeNull();
      f.release();
      for (const [index, ticket] of [a, b].entries()) {
        const started = await outcome(() => host.start({ ticketId: ticket.ticketId, intentId: `review-preserved-${index}` }, signal()));
        expect.soft(started.error).toBeNull();
        if (started.value) {
          await vi.waitFor(async () => expect((await f.source.getRun(started.value!.runId, signal())).state).toBe("ended"));
          expect((await f.source.getReport(started.value.runId, {}, signal())).report).toBeTruthy();
        }
      }
      expect(f.requests).toHaveLength(2);
      expect(f.requestBodies.map(body => body.toString())).toEqual([
        "fixed owned material survives an unrelated cancelled call", "fixed owned material survives an unrelated cancelled call",
      ]);
    } finally {
      f.release();
      try { await host.close(); await Promise.allSettled(handles.map(handle => handle.close())); }
      finally { observed.mockRestore(); syncBuiltinESMExports(); await f.close(); }
    }
  });

  // I3: a genuine CredentialError is a known prepare refusal, not an uncertain started execution.
  it("review_i3_sdk_missing_credential_is_known_prepare_refusal_with_operator_remedy_and_no_ticket_or_secret", async () => {
    const privateRef = "REVIEW_SYNTHETIC_PRIVATE_REF";
    const f = await localCaseExecutionFixture({ configureProject(project) {
      project.collections[0]!.apis[0]!.contract.request.auth = { kind: "bearer", token: { id: privateRef, policy: "test-auto" } };
    } });
    let versions = 0, resolves = 0;
    const secretStore: SecretStore = {
      async version(_scope, ref) { versions++; throw new CredentialError("CREDENTIAL_MISSING", ref.id); },
      async resolve() { resolves++; throw new Error("REVIEW_SYNTHETIC_PRIVATE_SECRET"); },
      async status() { return "missing"; }, async put() { throw new Error("unexpected put"); }, async remove() { throw new Error("unexpected remove"); },
    };
    const server = createScopedMcpServer(f.source, { allowRun: true, privateRoot: f.privateRoot, secretStore, networkPrivateRoot: join(f.privateRoot, "network") });
    const client = new Client({ name: "review-known-material-refusal", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([client.connect(a), server.connect(b)]);
      const result = await client.callTool({ name: "prepare-run", arguments: { ...f.input } });
      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.content), serialized = JSON.stringify(result);
      expect.soft(text).toMatch(/缺.*凭据|凭据.*缺|缺.*材料|CREDENTIAL_MISSING/);
      expect.soft(text).toMatch(/准备未完成|准备未能完成|准备.*拒绝/);
      expect.soft(text).toMatch(/操作人|凭据管理|补齐|配置.*凭据/);
      expect.soft(text).not.toMatch(/查询.*(?:票据|运行)|结果尚未确认|结果不确定/);
      expect(result.structuredContent).not.toHaveProperty("data.ticketId");
      expect(versions).toBe(1); expect(resolves).toBe(0); expect(f.requests).toHaveLength(0);
      for (const privateValue of [privateRef, "REVIEW_SYNTHETIC_PRIVATE_SECRET", f.privateRoot, f.materialPath]) expect(serialized).not.toContain(privateValue);
    } finally { await client.close(); await server.close(); await f.close(); }
  });
});

import fsp, { type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createMcpExecutionHost } from "../src/mcp/execution.js";
import { executionCapabilityFor } from "../src/mcp/executionCapabilities.js";
import { localCaseExecutionFixture, outcome, signal } from "./mcp-execution.fixture.js";

const clock = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
describe.sequential("R56 local job deadline", () => {
  it("deadline_authentication_time_is_included_before_a_ticket_can_be_published", async () => {
    const f = await localCaseExecutionFixture();
    const capability = executionCapabilityFor(f.source), authenticate = capability.authenticate.bind(capability);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const arrived = new Promise<void>(resolve => { entered = resolve; });
    const observation = vi.spyOn(capability, "authenticate").mockImplementation(async s => { await authenticate(s); entered(); await gate; });
    const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, localHost: f.localHost });
    let preparing: ReturnType<typeof outcome> | undefined;
    try {
      clock();
      preparing = outcome(() => host.prepare({ ...f.input, runConfig: { jobTimeoutMs: 5000 } }, signal()));
      await arrived; await vi.advanceTimersByTimeAsync(5001); release();
      const result = await preparing;
      expect(result.error ?? "no-error").toMatch(/job[-_ ]?timeout/i);
      expect(f.preparations).toHaveLength(0);
      expect(f.requests).toHaveLength(0);
    } finally { release(); vi.useRealTimers(); await preparing; observation.mockRestore(); await host.close(); await f.close(); }
  });

  it("deadline_active_core_is_aborted_and_settled_but_completed_prepare_call_signal_is_not_its_lifetime", async () => {
    const f = await localCaseExecutionFixture();
    const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, localHost: f.localHost });
    try {
      clock();
      const prepareCall = new AbortController();
      const ticket = await host.prepare({ ...f.input, runConfig: { jobTimeoutMs: 5000 } }, prepareCall.signal);
      expect.soft(ticket.budgets?.jobTimeoutMs).toBe(5000);
      // This injected adapter does not apply policy report/evidence limits to Core.
      expect.soft(ticket.budgets ?? {}).not.toHaveProperty("reportBytes");
      prepareCall.abort();
      const run = await host.start({ ticketId: ticket.ticketId, intentId: "deadline-owned-core" }, signal());
      await vi.waitFor(() => expect(f.requests).toHaveLength(1));
      expect(f.invocations[0]!.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(5001);
      expect.soft(f.invocations[0]!.signal.aborted).toBe(true);
      await vi.waitFor(() => expect(f.invocations[0]!.settled).toBe(true));
      expect((await f.source.getRun(run.runId, signal())).state).toBe("ended");
      expect(f.requests).toHaveLength(1);
    } finally { vi.useRealTimers(); f.release(); await host.close(); await f.close(); }
  });

  it.each(["deadline", "close"] as const)("deadline_unused_default_material_is_released_on_%s_without_target_or_lost_timeout_reason", async disposal => {
    const f = await localCaseExecutionFixture({ configureProject(project, { driverPath }) {
      const request = project.collections[0]!.apis[0]!.contract.request;
      if (request.protocol !== "http") throw new Error("http fixture required");
      request.body = { kind: "binary", file: { path: driverPath }, contentType: "application/octet-stream" };
    } });
    f.writeDriver("owned deadline attachment");
    const handles: FileHandle[] = [], open = fsp.open;
    const observed = vi.spyOn(fsp, "open").mockImplementation(async (...args: Parameters<typeof open>) => {
      const handle = await open(...args); if (String(args[0]) === f.materialPath) handles.push(handle); return handle;
    });
    syncBuiltinESMExports();
    const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, networkPrivateRoot: join(f.privateRoot, "network") });
    try {
      clock();
      const ticket = await host.prepare({ ...f.input, runConfig: { jobTimeoutMs: 5000 } }, signal());
      expect(handles).toHaveLength(1);
      expect((await handles[0]!.stat()).isFile()).toBe(true);
      if (disposal === "close") await host.close();
      else {
        await vi.advanceTimersByTimeAsync(5001);
        const start = await outcome(() => host.start({ ticketId: ticket.ticketId, intentId: "unused-expired-budget" }, signal()));
        expect(start.error).toMatch(/job[-_ ]?timeout/i);
      }
      await expect(handles[0]!.stat()).rejects.toMatchObject({ code: "EBADF" });
      expect(vi.getTimerCount()).toBe(0);
      expect(f.requests).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      try { await host.close(); await Promise.allSettled(handles.map(handle => handle.close())); }
      finally { observed.mockRestore(); syncBuiltinESMExports(); await f.close(); }
    }
  });

  it("deadline_reuses_effective_policy_cancel_grace_boundary_before_preparation", async () => {
    const f = await localCaseExecutionFixture();
    const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, localHost: f.localHost });
    try {
      const result = await outcome(() => host.prepare({ ...f.input, runConfig: { jobTimeoutMs: 4999 } }, signal()));
      expect(result.error ?? "no-error").toMatch(/cancelGrace|jobTimeout|预算|期限/);
      expect(f.preparations).toHaveLength(0); expect(f.requests).toHaveLength(0);
    } finally { await host.close(); await f.close(); }
  });
});

import { expect, it, vi } from "vitest";
import { defaultAgentConfig, type ControlExchange } from "@apicc/execution/contract";
import { createLongPollingTransport } from "../src/transport/longPolling.js";
import { runAgentControl } from "../src/transport/control.js";
import { ExecutionHttpError } from '@apicc/execution/client';
import type { AgentSupervisor } from "../src/supervisor.js";
const exchange: ControlExchange = { sessionId: "host-1", appliedConfigVersion: "1", availableSlots: 0, availableSharedDebugSlots: 0, acknowledgements: [] };

it('preserves only safe structured HTTP codes without converting an unconfirmed start error into an acknowledgement', async () => {
  const transport = createLongPollingTransport({ baseUrl: 'https://control.test/api/v1', token: () => 'synthetic-only', config: () => ({ ...defaultAgentConfig }), fetch: async () => Response.json({ code: 'script_grant_missing', message: 'private exception text must not cross this boundary' }, { status: 403 }) });
  const error = await transport.send([{ kind: 'accepted', messageId: 'accepted-unconfirmed', jobId: '1', executionId: '2' }], new AbortController().signal).catch(error => error);
  expect(error).toBeInstanceOf(ExecutionHttpError); expect(error.status).toBe(403); expect(error.code).toBe('script_grant_missing'); expect(String(error)).not.toContain('private exception');
});

it("uses the actual runner paths and direct message array, and isolates malformed entries while full", async () => {
  const requests: Array<{ url: string; body: unknown }> = [];
  const transport = createLongPollingTransport({ baseUrl: "https://control.test/api/v1", token: () => "host-only-control", config: () => ({ ...defaultAgentConfig }), fetch: async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init!.body as string) });
    if (String(url).endsWith("/messages")) return Response.json({ acknowledged: ["accepted-1"] });
    return Response.json({ deliveries: [{ messageId: "bad", task: {} }], commands: [{ kind: "cancel", messageId: "cancel-1", jobId: "1", executionId: "2", reason: "stop" }, { kind: "unknown", messageId: "bad-command" }] });
  } });
  const result = await transport.exchange(exchange, new AbortController().signal);
  expect(result.commands).toEqual([{ kind: "cancel", messageId: "cancel-1", jobId: "1", executionId: "2", reason: "stop" }]);
  expect(result.deliveries).toEqual([]);
  const ack = await transport.send([{ kind: "accepted", messageId: "accepted-1", jobId: "1", executionId: "2" }], new AbortController().signal);
  expect(ack.acknowledged).toEqual(["accepted-1"]);
  expect(requests).toEqual([{ url: "https://control.test/api/v1/runner/poll", body: exchange }, { url: "https://control.test/api/v1/runner/messages", body: [{ kind: "accepted", messageId: "accepted-1", jobId: "1", executionId: "2" }] }]);
});

it("keeps heartbeat independent of a blocked long poll and applies the configured request deadline", async () => {
  const paths: string[] = []; let config = { ...defaultAgentConfig, longPollWaitMs: 15, pollTimeoutMarginMs: 5, controlRequestTimeoutMs: 50 };
  const transport = createLongPollingTransport({ baseUrl: "https://control.test/api/v1", token: () => "private-control", config: () => config, fetch: async (url, init) => {
    const path = new URL(String(url)).pathname; paths.push(path);
    if (path.endsWith("/heartbeat")) return Response.json({ deliveries: [], commands: [{ kind: "cancel", messageId: "cancel-2", jobId: "1", executionId: "2", reason: "full" }] });
    return await new Promise<Response>((_resolve, reject) => { init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true }); });
  } });
  const poll = transport.exchange(exchange, new AbortController().signal).then(() => "unexpected", error => error);
  const beat = await transport.heartbeat(exchange, new AbortController().signal);
  expect(beat.commands).toHaveLength(1);
  expect(await poll).toBeInstanceOf(Error);
  expect(paths).toEqual(["/api/v1/runner/poll", "/api/v1/runner/heartbeat"]);
  config = { ...config, controlRequestTimeoutMs: 80 };
});

it("continuously consumes full-slot cancellation and configuration while its long poll is blocked", async () => {
  const received: string[] = []; let polls = 0; let beats = 0; const controller = new AbortController();
  const supervisor = { capacity: () => ({ availableSlots: 0, availableSharedDebugSlots: 0 }), appliedConfigVersion: "1", currentConfig: { ...defaultAgentConfig, heartbeatIntervalMs: 15 }, command: (command: { kind: string }) => received.push(command.kind), receive: () => {}, flushMessages: async () => {} } as unknown as AgentSupervisor;
  const running = runAgentControl({ supervisor, sessionId: "host-1", transport: { send: async () => ({ acknowledged: [] }), exchange: async (_input, signal) => { polls++; return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })); } }, heartbeat: async input => {
    expect(input.availableSlots).toBe(0); beats++;
    return { deliveries: [], commands: beats === 1 ? [{ kind: "cancel", messageId: "cancel", jobId: "1", executionId: "2", reason: "stop" }] : [{ kind: "apply-config", messageId: "config", configVersion: "2", config: { ...defaultAgentConfig } }] };
  } }, controller.signal);
  try { await vi.waitFor(() => expect(received).toContain("apply-config"), { timeout: 500, interval: 10 }); expect(received).toContain("cancel"); expect(polls).toBe(1); expect(beats).toBeGreaterThanOrEqual(2); }
  finally { controller.abort(new Error("Stop test control")); await running; }
});

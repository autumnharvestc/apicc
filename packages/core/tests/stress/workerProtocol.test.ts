import { describe, expect, it } from "vitest";
import { createStressWorkerPeer, type StressWorkerChannel } from "../../src/stress/workerProtocol.js";
import { serveLocalStressWorker } from "../../src/stress/localWorker.js";
import { legacyStressMetricPlan } from "../../src/stress/runner.js";
import { createExecutionEvidenceCollector } from "../../src/report/evidence.js";

function channels(): [StressWorkerChannel, StressWorkerChannel] {
  const listeners = [new Set<(v: unknown) => void>(), new Set<(v: unknown) => void>()], closes = [new Set<() => void>(), new Set<() => void>()];
  const make = (i: number): StressWorkerChannel => ({
    send(value) { queueMicrotask(() => listeners[1 - i]!.forEach((f) => f(structuredClone(value)))); },
    subscribe(f) { listeners[i]!.add(f); return () => { listeners[i]!.delete(f); }; },
    onClose(f) { closes[i]!.add(f); return () => { closes[i]!.delete(f); }; },
    async close() { closes[1 - i]!.forEach((f) => f()); },
  }); return [make(0), make(1)];
}
const identity = { runId: "run", workerId: "worker" };
describe("v3 bounded framing and lifecycle privacy", () => {
  it("finishes the earlier two-chunk request before the following small RPC", async () => {
    const [a, b] = channels(), received: string[] = [];
    const left = createStressWorkerPeer(a, identity, async () => ({}));
    const right = createStressWorkerPeer(b, identity, async (command) => {
      received.push(command.type); return command.type === "prepare" ? { length: String(command.configuration).length } : { workerNow: 7 };
    }, () => { void b.close(); });
    try {
      const large = left.request({ type: "prepare", configuration: "x".repeat(16384) });
      const small = left.request({ type: "clock" });
      await expect(Promise.all([large, small])).resolves.toEqual([{ length: 16384 }, { workerNow: 7 }]);
      expect(received).toEqual(["prepare", "clock"]); expect(left.failed).toBe(false); expect(right.failed).toBe(false);
    } finally { await left.close(); await right.close(); }
  });
  it("transfers allowed ASCII above 32MiB with multibyte text and rejects declared bytes above 64MiB", async () => {
    const [a, b] = channels();
    const left = createStressWorkerPeer(a, identity, async () => ({}));
    const right = createStressWorkerPeer(b, identity, async (command) => command.type === "prepare" ? { length: String(command.configuration).length } : {}, () => { void b.close(); });
    const value = "x".repeat(32 * 1024 * 1024 + 1) + "🙂";
    try {
      await expect(left.request({ type: "prepare", configuration: value })).resolves.toEqual({ length: 33554435 });
      b.send({ ...identity, protocolVersion: 3, kind: "chunk", transferId: "over", index: 0, total: 1, bytes: 67108865, data: "{}" });
      await Promise.resolve(); expect(left.failed).toBe(true);
    } finally { await left.close(); await right.close(); }
  });
  it.each([
    { protocolVersion: 3, runId: "run", workerId: "worker", accepted: true },
    { protocolVersion: 2, runId: "run", workerId: "worker", accepted: false },
    { protocolVersion: 3, runId: "wrong", workerId: "worker", accepted: false },
    { protocolVersion: 3, runId: "run", workerId: "wrong", accepted: false },
  ])("checks identity inside legal v3 framing: $protocolVersion/$runId/$workerId", async ({ accepted, ...envelope }) => {
    const [a, b] = channels(), peer = createStressWorkerPeer(a, identity, async () => ({}));
    const pending = peer.request({ type: "clock" });
    const data = JSON.stringify({ ...envelope, kind: "response", id: "1", ok: true, value: { workerNow: 7 } });
    b.send({ ...identity, protocolVersion: 3, kind: "chunk", transferId: "1", index: 0, total: 1, bytes: Buffer.byteLength(data), data });
    if (accepted) await expect(pending).resolves.toEqual({ workerNow: 7 }); else await expect(pending).rejects.toThrow("worker-failed");
    await peer.close();
  });
  it("sends only explicitly mapped setup values and no teardown values", async () => {
    const [a, b] = channels(), clock = { now: () => 1, wallNow: () => 1, sleep: async () => {} };
    const worker = serveLocalStressWorker(b, identity, async () => ({ metricPlan: legacyStressMetricPlan, clock,
      lifecycle: { vuSetup: { workflowId: "setup", outputs: { needed: "input" } }, vuTeardown: { workflowId: "close" } },
      evidence: createExecutionEvidenceCollector({ projectId: "p", definitionRevision: "r" }, []), host: {
        async createVu(_id, _inputs, host) {
          host!.reportLifecycle("vuSetup", { state: "passed", durationMs: 2, outputs: { needed: "mapped", unused: "private-unmapped" } });
          return { execute: async () => ({ state: "passed", durationMs: 1 }), async close() { host!.reportLifecycle("vuTeardown", { state: "failed", durationMs: 3, failureKind: "assertion", outputs: { unused: "private-teardown" } }); } };
        },
      } }));
    const peer = createStressWorkerPeer(a, identity, async () => ({}));
    try {
      await peer.request({ type: "prepare", configuration: {} }); await peer.request({ type: "start", coordinatorNow: 1, workerNow: 1, uncertaintyMs: 0 });
      await expect(peer.request({ type: "create", vuId: "1", inputs: {}, runStart: 1 })).resolves.toEqual({ ok: true, mappedInputs: { input: "mapped" }, records: [{ role: "vuSetup", result: { state: "passed", durationMs: 2, outputs: { needed: "mapped" } } }] });
      // A second VU cannot redefine the coordinate origin already retained by the first VU.
      await expect(peer.request({ type: "create", vuId: "2", inputs: {}, runStart: 2 })).rejects.toThrow("worker-failed");
      await expect(peer.request({ type: "close", vuId: "1", reason: "iteration-budget", allowNetworkCleanup: true })).resolves.toEqual({ records: [{ role: "vuTeardown", result: { state: "failed", durationMs: 3, failureKind: "assertion", outputs: {} } }] });
    } finally { await peer.close(); await worker.close(); }
  });
});

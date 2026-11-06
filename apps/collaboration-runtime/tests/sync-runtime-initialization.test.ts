import { expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startCollaborationRuntime } from "../src/server.js";
import type { RuntimeSourceOptions, SyncReadPayload } from "../src/sourceHost.js";
import { envelope, ownedChildBarrier, rpc, secret, until } from "./sync-runtime-fixture.js";
import { inputFor } from "../../../packages/execution/tests/sourceHost/fixtures.js";

// Only this file's fresh physical root is gated. Every operation first performs
// the real fs call; no result, directory entry or source operation is mocked.
const window = vi.hoisted(() => ({ enabled: false, root: "", markers: "", stats: 0, scans: 0,
  statsGate: undefined as Promise<void> | undefined, scansGate: undefined as Promise<void> | undefined,
  bothStats: undefined as (() => void) | undefined, firstScan: undefined as (() => void) | undefined }));
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const same = (left: unknown, right: string) => String(left).replaceAll("\\", "/").toLowerCase() === right.replaceAll("\\", "/").toLowerCase();
  return { ...actual,
    stat: async (...args: unknown[]) => {
      const result = await Reflect.apply(actual.stat, actual, args);
      if (window.enabled && same(args[0], window.root) && (args[1] as { bigint?: boolean })?.bigint) {
        if (++window.stats === 2) window.bothStats?.(); await window.statsGate;
      }
      return result;
    },
    readdir: async (...args: unknown[]) => {
      const result = await Reflect.apply(actual.readdir, actual, args);
      if (window.enabled && same(args[0], window.markers)) {
        if (++window.scans === 1) window.firstScan?.(); await window.scansGate;
      }
      return result;
    },
  };
});
function gate() { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; }
type Runtime = Awaited<ReturnType<typeof startCollaborationRuntime>>;
async function concurrentProviders(root: string, sources: [RuntimeSourceOptions, RuntimeSourceOptions]): Promise<[Runtime, Runtime]> {
  const stats = gate(), scans = gate(), bothStats = gate(), firstScan = gate();
  Object.assign(window, { enabled: true, root, markers: join(root, ".apicc-sync-owners"), stats: 0, scans: 0,
    statsGate: stats.promise, scansGate: scans.promise, bothStats: bothStats.release, firstScan: firstScan.release });
  const opening = sources.map(source => startCollaborationRuntime({ secret, port: 0, source }));
  try {
    await bothStats.promise; stats.release(); await firstScan.promise; scans.release();
    return await Promise.all(opening) as [Runtime, Runtime];
  } catch (error) {
    // No later successful startup may escape a failed Promise.all and poison a retry.
    const outcomes = await Promise.allSettled(opening);
    await Promise.all(outcomes.filter(result => result.status === "fulfilled").map(result => result.value.close()));
    throw error;
  } finally { window.enabled = false; stats.release(); scans.release(); }
}
async function observation(value: object) {
  if (process.env.APICC_F7G_INIT_RACE_EVIDENCE) await appendFile(process.env.APICC_F7G_INIT_RACE_EVIDENCE, JSON.stringify(value) + "\n");
}

it("concurrent providers share physical-root ownership during real blocked source I/O", async () => {
  expect(process.versions.node).toBe("22.19.0");
  const root = await mkdtemp(join(tmpdir(), "apicc-sync-init-race-")), received = gate(), socketClosed = gate();
  await mkdir(join(root, ".apicc-sync-owners"));
  const upstream = createServer((req, res) => { if (req.url === "/quick") { res.end("hello"); return; }
    req.socket.once("close", socketClosed.release); res.writeHead(200); res.write("owned-blocked-source"); received.release(); });
  await new Promise<void>(done => upstream.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(upstream.address() as import("node:net").AddressInfo).port}`;
  const barrier = ownedChildBarrier(root), controller = new AbortController(); let a: Runtime | undefined, b: Runtime | undefined, pending: Promise<unknown> | undefined;
  try {
    const source: RuntimeSourceOptions = { privateRoot: root, allowedOrigins: [origin], allowedCidrs: ["127.0.0.1/32"], maxConcurrency: 1, maxProjectConcurrency: 1 };
    [a, b] = await concurrentProviders(root, [{ ...source, createPrivateRead: barrier.createPrivateRead }, source]);
    const payload: SyncReadPayload = { input: { ...inputFor(origin + "/blocked"), deadlineAtMs: Date.now() + 30000 },
      context: { workspaceId: "71", projectId: "72", sourceRevision: "1", authorizationGeneration: "1", invocationId: randomUUID(), projectConcurrency: 1, hostConcurrency: 1 },
      material: { leaseId: randomUUID(), identity: "a".repeat(64) }, network: { kind: "direct", revision: "1" } };
    pending = fetch(a.url + "/rpc", { method: "POST", headers: { "X-Apicc-Collaboration-Key": secret }, body: JSON.stringify(envelope("sync-read", payload)), signal: controller.signal }).catch(() => undefined);
    await received.promise;
    expect(barrier.alive()).toBe(true); expect(a.sourceCapacity()).toEqual({ held: 1, retained: 0 });
    await observation({ phase: "blocked", physicalRootStats: window.stats, realMarkerScans: window.scans, childAlive: barrier.alive(), a: a.sourceCapacity(), b: b.sourceCapacity() });
    expect.soft(b.sourceCapacity()).toEqual({ held: 1, retained: 0 });
    for (const kind of ["same-source", "host-cap"] as const) {
      const next = structuredClone(payload); if (next.input.source.kind !== "url") throw Error("URL fixture");
      next.input.source.url = origin + "/quick"; next.context.invocationId = randomUUID();
      if (kind === "host-cap") { next.context.projectId = "73"; next.input.source.id = "00000000-0000-4000-8000-000000000099"; }
      const response = await rpc(b.url, "sync-read", next); const body = await response.json();
      await observation({ phase: kind, status: response.status, code: body.code ?? "success" });
      expect.soft(response.status).toBe(429); expect.soft(body.code).toBe("SYNC_BUSY");
    }
  } finally {
    controller.abort(); await pending;
    if (a) expect(await until(barrier.aborted)).toBe(true);
    await barrier.allowOwnedChildExit(); await barrier.close();
    if (a) { await socketClosed.promise; expect(await until(() => a!.sourceCapacity().held === 0 && b!.sourceCapacity().held === 0)).toBe(true); }
    await observation({ phase: "collected", childAlive: barrier.alive(), collected: barrier.collected(), a: a?.sourceCapacity(), b: b?.sourceCapacity() });
    await Promise.all([a?.close(), b?.close()]);
    if (a && b) {
      // Both references closed: a later provider must not inherit the old bounded ledger.
      const reopened = await startCollaborationRuntime({ secret, port: 0, source: { privateRoot: root, allowedOrigins: [origin], allowedCidrs: ["127.0.0.1/32"], maxTrackedSources: 1 } });
      try {
        const input = inputFor(origin + "/quick"); input.source.id = "00000000-0000-4000-8000-000000000077";
        const response = await rpc(reopened.url, "sync-read", { input, context: { workspaceId: "71", projectId: "72", sourceRevision: "1", authorizationGeneration: "1", invocationId: randomUUID(), projectConcurrency: 1, hostConcurrency: 1 }, material: { leaseId: randomUUID(), identity: "a".repeat(64) }, network: { kind: "direct", revision: "1" } });
        expect(response.status).toBe(200); expect((await response.json()).payload.rawText).toBe("hello");
      } finally { await reopened.close(); }
    }
    upstream.closeAllConnections(); await new Promise<void>((done, reject) => upstream.close(error => error ? reject(error) : done()));
    await rm(root, { recursive: true, force: true });
  }
});

it("a failed concurrent marker scan can be retried after the owned test marker is removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "apicc-sync-init-failure-")), marker = join(root, ".apicc-sync-owners", "owned-test-marker.json");
  await mkdir(join(root, ".apicc-sync-owners")); await writeFile(marker, '{"formatVersion":1,"status":"uncollected"}');
  const source: RuntimeSourceOptions = { privateRoot: root, allowedOrigins: [], allowedCidrs: [] };
  let recovered: Runtime | undefined;
  try {
    await expect(concurrentProviders(root, [source, source])).rejects.toThrow("SYNC_PROCESS_UNCOLLECTED");
    await rm(marker); recovered = await startCollaborationRuntime({ secret, port: 0, source });
    expect(recovered.sourceCapacity()).toEqual({ held: 0, retained: 0 });
  } finally { await recovered?.close(); await rm(root, { recursive: true, force: true }); }
});

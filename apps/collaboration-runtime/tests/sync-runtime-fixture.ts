import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createPrivateReadOwner } from "../src/sourceHost.js";
import { withGitSource } from "../../../packages/execution/tests/sourceHost/git-fixture.mjs";
import { readFile } from "node:fs/promises";
import { SourceReadInputSchema } from "@apicc/core/sync";
export const gitTools = process.platform === "win32" ? { gitPath: "D:/env/Git/cmd/git.exe", sshPath: "C:/Windows/System32/OpenSSH/ssh.exe" } : { gitPath: "/usr/bin/git", sshPath: "/usr/bin/ssh" };
import { startCollaborationRuntime } from "../src/server.js";
import { digestJson } from "../src/protocol.js";
import type { RuntimeSourceOptions, SyncReadPayload } from "../src/sourceHost.js";
import { withSourceServer } from "../../../packages/execution/tests/sourceHost/fixtures.js";
import { prepareNetworkRun } from "@apicc/core";
import { createServer } from "node:http";
import { channel } from "node:diagnostics_channel";
import { inputFor } from "../../../packages/execution/tests/sourceHost/fixtures.js";

export const secret = "synthetic-secret-0123456789abcdef";
export function envelope(operation: string, payload: unknown, remaining = 30000) {
  return { protocolVersion: 1, operation, requestId: randomUUID(), inputDigest: digestJson(payload), deadlineEpochMs: Date.now() + remaining, outputBudgetBytes: 32 * 1048576, payload };
}
export function rpc(url: string, operation: string, payload: unknown, remaining = 30000) {
  return fetch(url + "/rpc", { method: "POST", headers: { "X-Apicc-Collaboration-Key": secret }, body: JSON.stringify(envelope(operation, payload, remaining)) });
}
export async function withSyncUrlRuntime(callback: (fixture: Awaited<ReturnType<typeof urlFixture>>) => Promise<void>, changes: Partial<RuntimeSourceOptions> | ((root: string) => Partial<RuntimeSourceOptions>) = {}, expectedUncollectedClose = false) {
  await withSourceServer(async source => {
    const fixture = await urlFixture(source, changes);
    try { await callback(fixture); } finally { try { await fixture.runtime.close(); } catch (error) { if (!expectedUncollectedClose || (error as Error).message !== "SYNC_PROCESS_UNCOLLECTED") throw error; } await rm(fixture.privateRoot, { recursive: true, force: true }); }
  });
}
async function urlFixture(source: Parameters<Parameters<typeof withSourceServer>[0]>[0], changes: Partial<RuntimeSourceOptions> | ((root: string) => Partial<RuntimeSourceOptions>)) {
  const privateRoot = await mkdtemp(join(tmpdir(), "apicc-sync-runtime-"));
  const capturedSignals: AbortSignal[] = [];
  const prepared = await prepareNetworkRun({ scope: { canonicalRoot: privateRoot, project: { workspaceId: "71", groupId: "0", projectId: "72" } }, store: { load: async () => ({ revision: "1", configuration: { formatVersion: 1, profiles: [], environmentSelections: [] } }), save: async () => { throw Error("fixed snapshot"); } }, secretStore: {} as never, selection: { kind: "direct" } });
  const runtime = await startCollaborationRuntime({ secret, port: 0, source: { privateRoot, allowedOrigins: [source.url, source.secureUrl], allowedCidrs: ["127.0.0.1/32"], captureNetwork: async (_source, signal) => { capturedSignals.push(signal); return { prepared, policyIdentity: "owned-current-policy", materialIdentity: "a".repeat(64), approveDestination: (url, address) => url.origin === source.url && address.address === "127.0.0.1" }; }, ...(typeof changes === "function" ? changes(privateRoot) : changes) } });
  const payload = (path = "/ok"): SyncReadPayload => ({
    input: source.input(source.url + path),
    context: { workspaceId: "71", projectId: "72", sourceRevision: "1", authorizationGeneration: "1", invocationId: randomUUID(), projectConcurrency: 1, hostConcurrency: 4 },
    material: { leaseId: randomUUID(), identity: "a".repeat(64) }, network: { kind: "direct", revision: "1" },
  });
  return { source, runtime, privateRoot, payload, capturedSignals };
}

export async function until(predicate: () => boolean | Promise<boolean>, milliseconds = 2000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { if (await predicate()) return true; await new Promise(done => setTimeout(done, 10)); }
  return false;
}

/** T8 owned upstream never ends naturally; only cancellation or fixture cleanup closes it. */
export async function withSyncBlockedRuntime(callback: (fixture: {
  runtime: Awaited<ReturnType<typeof startCollaborationRuntime>>; payload(path?: string, projectId?: string): SyncReadPayload;
  received: Promise<void>; rpcClosed: Promise<void>; capturedSignals: AbortSignal[];
  sourceSocketClosed(): boolean; releaseUpstream(): Promise<void>;
}) => Promise<void>, configure?: (privateRoot: string) => Partial<RuntimeSourceOptions>) {
  const privateRoot = await mkdtemp(join(tmpdir(), "apicc-sync-blocked-"));
  let received!: () => void, rpcClosed!: () => void, closed = false;
  const receivedPromise = new Promise<void>(done => { received = done; }), rpcClosedPromise = new Promise<void>(done => { rpcClosed = done; });
  const source = createServer((req, res) => { if (req.url === "/quick") { res.end("hello"); return; } req.socket.once("close", () => { closed = true; }); res.writeHead(200); res.write("owned-content-still-streaming"); received(); });
  await new Promise<void>(done => source.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(source.address() as import("node:net").AddressInfo).port}`, capturedSignals: AbortSignal[] = [];
  const prepared = await prepareNetworkRun({ scope: { canonicalRoot: privateRoot, project: { workspaceId: "71", groupId: "0", projectId: "72" } }, store: { load: async () => ({ revision: "1", configuration: { formatVersion: 1, profiles: [], environmentSelections: [] } }), save: async () => { throw Error("fixed snapshot"); } }, secretStore: {} as never, selection: { kind: "direct" } });
  const runtime = await startCollaborationRuntime({ secret, port: 0, source: { privateRoot, allowedOrigins: [url], allowedCidrs: ["127.0.0.1/32"], captureNetwork: async (_source, signal) => { capturedSignals.push(signal); return { prepared, policyIdentity: "owned-policy", materialIdentity: "a".repeat(64), approveDestination: (target, address) => target.origin === url && address.address === "127.0.0.1" }; }, ...configure?.(privateRoot) } });
  const started = channel("http.server.request.start");
  const observe = (value: unknown) => { const message = value as { response: import("node:http").ServerResponse; socket: import("node:net").Socket }; if (message.socket.localPort === Number(new URL(runtime.url).port)) message.response.once("close", rpcClosed); };
  started.subscribe(observe);
  let sourceStopped: Promise<void> | undefined;
  const releaseUpstream = () => sourceStopped ??= new Promise<void>((done, reject) => { source.close(error => error ? reject(error) : done()); source.closeAllConnections(); });
  const payload = (path = "/blocked", projectId = "72"): SyncReadPayload => ({ input: { ...inputFor(url + path), deadlineAtMs: Date.now() + 30000 }, context: { workspaceId: "71", projectId, sourceRevision: "1", authorizationGeneration: "1", invocationId: randomUUID(), projectConcurrency: 1, hostConcurrency: 4 }, material: { leaseId: randomUUID(), identity: "a".repeat(64) }, network: { kind: "direct", revision: "1" } });
  try { await callback({ runtime, payload, received: receivedPromise, rpcClosed: rpcClosedPromise, capturedSignals, sourceSocketClosed: () => closed, releaseUpstream }); }
  finally { started.unsubscribe(observe); await releaseUpstream(); await runtime.close(); await rm(privateRoot, { recursive: true, force: true }); }
}

/** A genuine owned child: abort is observed while it remains alive; exit is separately controlled. */
export function ownedChildBarrier(privateRoot: string) {
  let child: ReturnType<typeof spawn> | undefined, collected = false, aborted = false;
  let allowExit = false; let closed: Promise<void> | undefined; let directory = "";
  const createPrivateRead = async (signal: AbortSignal) => {
    const owner = await createPrivateReadOwner(privateRoot); directory = owner.directory;
    child = spawn(process.execPath, ["-e", "process.on('message',m=>{if(m==='abort')process.send('aborted');if(m==='exit')process.exit(0)});process.send('ready');"], { cwd: directory, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    closed = new Promise<void>((done, reject) => { child!.once("error", reject); child!.once("close", () => done()); });
    await new Promise<void>(done => child!.on("message", message => { if (message === "ready") done(); if (message === "aborted") aborted = true; }));
    const cancel = () => { if (child?.connected) child.send("abort"); };
    signal.addEventListener("abort", cancel, { once: true }); if (signal.aborted) cancel();
    if (allowExit) child.send("exit");
    return { ...owner, collect: async () => { await closed; signal.removeEventListener("abort", cancel); await owner.collect(); collected = true; } };
  };
  return { createPrivateRead, aborted: () => aborted, collected: () => collected, directory: () => directory,
    alive: () => { if (!child?.pid) return false; try { process.kill(child.pid, 0); return true; } catch { return false; } },
    allowOwnedChildExit: async () => { allowExit = true; if (child?.connected) child.send("exit"); },
    close: async () => { allowExit = true; if (child?.connected) child.send("exit"); await closed; } };
}

/** Real synthetic TLS Git/SSH service; runtime still uses its production SourceHost provider. */
export async function withSyncRuntime(callback: (fixture: {
  runtime: Awaited<ReturnType<typeof startCollaborationRuntime>>; git: Parameters<Parameters<typeof withGitSource>[0]>[0];
  payload(kind: "git-https" | "git-ssh"): SyncReadPayload; privateRoot: string;
  startBlockedGitRead(remaining?: number): Promise<{ client: import("node:http").ClientRequest; settled: Promise<void>; rpcClosed: Promise<void>; status(): number | undefined }>;
  disconnect(pending: { client: import("node:http").ClientRequest; rpcClosed: Promise<void> }): Promise<void>;
  capacity(): { held: number; retained: number }; allowOwnedChildExit(): Promise<void>;
  waitCollected(pending: { settled: Promise<void> }): Promise<void>; childAlive(): boolean; abortObserved(): boolean;
}) => Promise<void>) {
  await withGitSource(async git => {
    const privateRoot = await mkdtemp(join(git.directory, "runtime-"));
    const httpsUrl = `https://${git.hostname}:${git.httpsPort}/repo-sha1.git`, sshUrl = `ssh://ownedgit@${git.hostname}:${git.sshPort}/fixture/repo-sha1.git`;
    const barrier = ownedChildBarrier(privateRoot); let useBarrier = false;
    const runtime = await startCollaborationRuntime({ secret, port: 0, source: { privateRoot, tools: gitTools, allowedOrigins: [new URL(httpsUrl).origin, `ssh://${git.hostname}:${git.sshPort}`], allowedCidrs: [git.address + "/32"], maxRedirects: 0,
      createPrivateRead: signal => useBarrier ? barrier.createPrivateRead(signal) : createPrivateReadOwner(privateRoot) } });
    const privateKeyPem = await readFile(git.privateKeyPath, "utf8"), knownHostsText = (await readFile(git.knownHostsPath, "utf8")).replaceAll("owned.git.test", git.hostname);
    const payload = (kind: "git-https" | "git-ssh"): SyncReadPayload => ({
      input: SourceReadInputSchema.parse({ formatVersion: 1, source: { formatVersion: 1, id: "00000000-0000-4000-8000-000000000001", revision: "1", moduleId: "00000000-0000-4000-8000-000000000002", kind, repositoryUrl: kind === "git-https" ? httpsUrl : sshUrl, ref: "refs/heads/main", filePath: "openapi.yaml", ...(kind === "git-https" ? { authRef: "owned-http" } : { privateKeyRef: "owned-key", knownHostsRef: "owned-hosts", passphraseRef: "owned-passphrase" }) }, deadlineAtMs: Date.now() + 30000, budget: { connectTimeoutMs: 1000, maxAttempts: 1, maxSourceBytes: 65536, gitDiskThresholdBytes: 33554432 } }),
      context: { workspaceId: "71", projectId: "72", sourceRevision: "1", authorizationGeneration: "1", invocationId: randomUUID(), projectConcurrency: 1, hostConcurrency: 4 },
      material: { leaseId: randomUUID(), identity: "a".repeat(64), ...(kind === "git-https" ? { httpHeaders: [{ name: "Authorization", value: "Basic b3duZWQ6c3ludGhldGlj" }], tls: { caPem: git.caPem } } : { ssh: { privateKeyPem, knownHostsText, passphrase: git.passphrase } }) }, network: { kind: "direct", revision: "1" },
    });
    const startBlockedGitRead = async (remaining = 30000) => {
      useBarrier = true; await git.pauseUploads(); const before = (await git.uploads()).length;
      let closed!: () => void, status: number | undefined;
      const rpcClosed = new Promise<void>(done => { closed = done; });
      const started = channel("http.server.request.start");
      const observe = (value: unknown) => { const message = value as { response: import("node:http").ServerResponse; socket: import("node:net").Socket }; if (message.socket.localPort === Number(new URL(runtime.url).port)) message.response.once("close", closed); };
      started.subscribe(observe);
      const { request } = await import("node:http"); const client = request(runtime.url + "/rpc", { method: "POST", headers: { "X-Apicc-Collaboration-Key": secret } });
      const settled = new Promise<void>(done => { client.on("response", response => { status = response.statusCode; response.resume(); response.on("end", done); }); client.on("error", () => done()); client.on("close", () => done()); });
      client.end(JSON.stringify(envelope("sync-read", payload("git-https"), remaining)));
      try { if (!await until(async () => (await git.uploads()).length > before, 15000)) throw Error("Actual owned Git upload did not start"); }
      finally { started.unsubscribe(observe); }
      return { client, settled, rpcClosed, status: () => status };
    };
    const allowOwnedChildExit = async () => { await barrier.allowOwnedChildExit(); await git.resumeUploads(); };
    try { await callback({ runtime, git, payload, privateRoot, startBlockedGitRead,
      disconnect: async pending => { pending.client.destroy(); await pending.rpcClosed; }, capacity: runtime.sourceCapacity, allowOwnedChildExit,
      waitCollected: async pending => { await pending.settled; if (!await until(() => barrier.collected() && runtime.sourceCapacity().held === 0, 5000)) throw Error("Actual owned child/material not collected"); }, childAlive: barrier.alive, abortObserved: barrier.aborted }); }
    finally { await allowOwnedChildExit(); await barrier.close(); await runtime.close(); await rm(privateRoot, { recursive: true, force: true }); }
  });
}

import { it, expect, beforeAll, afterAll } from "vitest";
import { request } from "node:https";
import { request as httpRequest, type RequestOptions } from "node:http";
import { createServer, type Socket } from "node:net";
import { createServer as createTLSServer } from "node:tls";
import { writeFile, access, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { GitSourceFixture } from "./git-fixture.mjs";
import { createGitHttpAdapter, type GitHttpAdapterOptions } from "../../src/source-host/gitCredentials.js";
import { installGitApplication, holdGitSource, observeOwnedPeerReset } from "./git-application.js";
import { gitReaderFixture, prepareGitFixtureNetwork } from "./git-reader-fixture.js";

const fixedCommit = "f9fbd710b4a0772621ad5c76fb5393938a67b8e2";
const fixedBlob = "f77ca262872d149b637048a2aa365bc8794cd8db";
const rawText = "openapi: 3.0.3\ninfo:\n  title: Owned fixture\n  version: 1.0.0\npaths: {}\n";
const token = "1".repeat(64);
let application: Awaited<ReturnType<typeof installGitApplication>>;
let heldSource: Awaited<ReturnType<typeof holdGitSource>>;
beforeAll(async () => { application = await installGitApplication(); heldSource = await holdGitSource(); expect(await directAdvertisement(heldSource.fixture)).toContain(fixedCommit); }, 30000);
afterAll(async () => { await heldSource?.close(); await application?.close(); });
const tools = process.platform === "win32" ? { gitPath: "D:/env/Git/cmd/git.exe", sshPath: "C:/Windows/System32/OpenSSH/ssh.exe" } : { gitPath: "/usr/bin/git", sshPath: "/usr/bin/ssh" };
const adapterOptions = (f: GitSourceFixture, changes: Partial<GitHttpAdapterOptions> = {}): GitHttpAdapterOptions => ({ repositoryUrl: new URL(f.httpsUrl), address: { address: f.address, family: 4 }, targetTLS: { ca: f.caPem, rejectUnauthorized: true, servername: "owned.git.test" }, headers: { authorization: "Basic b3duZWQ6c3ludGhldGlj" }, token, signal: new AbortController().signal, connectTimeoutMs: 1000, deadlineAtMs: Date.now() + 15000, ...changes });
async function directAdvertisement(f: GitSourceFixture, format: "sha1" | "sha256" = "sha1"): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: f.address, port: f.httpsPort, servername: "owned.git.test", ca: f.caPem, path: `/repo-${format}.git/info/refs?service=git-upload-pack`, headers: { authorization: "Basic b3duZWQ6c3ludGhldGlj" }, agent: false }, res => { const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => res.statusCode === 200 ? resolve(Buffer.concat(chunks).toString()) : reject(Error(`Owned TLS prerequisite ${res.statusCode}`))); res.on("error", reject); }); req.on("error", reject); req.end();
  });
}
function localRequest(url: string, options: { method?: string; headers?: RequestOptions["headers"]; body?: string; chunked?: boolean; timeoutMs?: number } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { agent: false, method: options.method, headers: { "x-apicc-source-token": token, ...(options.body ? options.chunked ? { "transfer-encoding": "chunked" } : { "content-length": Buffer.byteLength(options.body) } : {}), ...options.headers } }, res => { res.resume(); res.on("end", () => { clearTimeout(timer); resolve(res.statusCode ?? 0); }); });
    const timer = setTimeout(() => { req.destroy(); resolve(0); }, options.timeoutMs ?? 1500);
    req.on("error", error => { clearTimeout(timer); reject(error); }); req.end(options.body);
  });
}

it.each(["sha1", "sha256"] as const)("B2a reads a real fixed Git %s commit and raw blob through the private HTTP-to-strict-HTTPS adapter", async format => {
  const f = heldSource.fixture;
  const wanted = expectedObjects[format]; expect(await directAdvertisement(f, format)).toContain(wanted.commitOid);
  let adapter: Awaited<ReturnType<typeof createGitHttpAdapter>> | undefined;
  await expect(createGitHttpAdapter(adapterOptions(f, { repositoryUrl: new URL(f.httpsUrl.replace("repo-sha1", `repo-${format}`)) })).then(value => { adapter = value; return value.repositoryUrl; })).resolves.toMatch(/^http:\/\/127\.0\.0\.1:/);
  try {
    const repository = join(f.directory, `product-owned-object-${format}.git`); const config = join(f.directory, "private-git-config");
    await writeFile(config, `[http]\n proxy =\n followRedirects = false\n extraHeader = X-Apicc-Source-Token: ${token}\n[credential]\n helper =\n[protocol]\n allow = never\n[protocol "http"]\n allow = always\n`);
    const run = async (args: string[], cwd = f.directory) => { const result = await application.processApi.runOwnedProcess({ toolPath: tools.gitPath, args: ["-c", `include.path=${config}`, ...args], cwd, env: application.toolApi.sourceToolEnvironment(tools, f.directory), maxOutputBytes: 512 * 1024, signal: new AbortController().signal }); expect(result.exitCode).toBe(0); expect(result.collected).toBe(true); return result.stdout.toString(); };
    await run(["init", "--bare", `--object-format=${format}`, repository]);
    expect(await run(["ls-remote", adapter!.repositoryUrl, "refs/heads/main"])).toContain(wanted.commitOid);
    await run(["fetch", "--no-tags", "--no-recurse-submodules", adapter!.repositoryUrl, wanted.commitOid], repository);
    expect((await run(["rev-parse", "FETCH_HEAD"], repository)).trim()).toBe(wanted.commitOid);
    expect((await run(["rev-parse", `${wanted.commitOid}:openapi.yaml`], repository)).trim()).toBe(wanted.blobOid);
    expect(await run(["cat-file", "blob", wanted.blobOid], repository)).toBe(rawText);
    expect(f.crlRequests).toHaveLength(0);
    await adapter!.close();
    await expect(localRequest(adapter!.repositoryUrl + "/info/refs?service=git-upload-pack")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  } finally { await adapter!.close(); }
}, 30000);

it("B2b bounds an actual stalled TLS handshake using the captured connection budget", async () => {
  let helloBytes = 0;
  const sockets = new Set<Socket>(); const blackhole = createServer(socket => { sockets.add(socket); observeOwnedPeerReset(socket); socket.on("data", chunk => { helloBytes += chunk.length; }); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => blackhole.listen(0, "127.0.0.1", resolve));
  const port = (blackhole.address() as import("node:net").AddressInfo).port;
  let adapter: Awaited<ReturnType<typeof createGitHttpAdapter>> | undefined;
  try {
    await expect(createGitHttpAdapter({ repositoryUrl: new URL(`https://owned.git.test:${port}/repo.git`), address: { address: "127.0.0.1", family: 4 }, targetTLS: { rejectUnauthorized: true, servername: "owned.git.test" }, headers: {}, token, signal: new AbortController().signal, connectTimeoutMs: 1000, deadlineAtMs: Date.now() + 10000 }).then(value => { adapter = value; return value; })).resolves.toBeDefined();
    const status = await localRequest(adapter!.repositoryUrl + "/info/refs?service=git-upload-pack"); expect(helloBytes).toBeGreaterThan(0);
    expect(status).toBe(504);
    expect(adapter!.failureCode).toBe("SYNC_CONNECT_TIMEOUT");
    await adapter!.close();
    for (let i = 0; i < 50 && sockets.size; i++) await new Promise(r => setTimeout(r, 10));
    expect(sockets.size).toBe(0);
  } finally { await adapter?.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => blackhole.close(() => resolve())); }
}, 5000);

it.each([
  { kind: "missing token", status: 403 }, { kind: "wrong token", status: 403 }, { kind: "duplicate token", status: 403 }, { kind: "wrong local authority", status: 403 },
  { kind: "arbitrary path", status: 403 }, { kind: "write endpoint", status: 403 }, { kind: "wrong method", status: 403 },
  { kind: "wrong RPC content type", status: 415 }, { kind: "oversized headers", status: 431 }, { kind: "oversized RPC body", status: 413 }, { kind: "oversized chunked RPC body", status: 413 },
])("B2b refuses $kind before any upstream request", async ({ kind, status }) => {
  const f = heldSource.fixture; const adapter = await createGitHttpAdapter(adapterOptions(f, { maxHeaderBytes: 1024, maxRequestBytes: 4096 }));
  try {
    expect(await localRequest(adapter.repositoryUrl + "/info/refs?service=git-upload-pack")).toBe(200);
    const before = (await f.requests()).length; let path = "/info/refs?service=git-upload-pack";
    const options: Parameters<typeof localRequest>[1] = {};
    if (kind === "missing token") options.headers = { "x-apicc-source-token": "" };
    if (kind === "wrong token") options.headers = { "x-apicc-source-token": "2".repeat(64) };
    if (kind === "duplicate token") options.headers = { "x-apicc-source-token": [token, token] };
    if (kind === "wrong local authority") options.headers = { host: "other.invalid" };
    if (kind === "arbitrary path") path = "/HEAD";
    if (kind === "write endpoint") { path = "/git-receive-pack"; options.method = "POST"; options.body = "0000"; options.headers = { "content-type": "application/x-git-receive-pack-request" }; }
    if (kind === "wrong method") options.method = "DELETE";
    if (kind === "wrong RPC content type") { path = "/git-upload-pack"; options.method = "POST"; options.body = "0000"; options.headers = { "content-type": "text/plain" }; }
    if (kind === "oversized headers") options.headers = { "x-oversized": "x".repeat(1400) };
    if (kind === "oversized RPC body" || kind === "oversized chunked RPC body") { path = "/git-upload-pack"; options.method = "POST"; options.body = "x".repeat(5000); options.chunked = kind.includes("chunked"); options.headers = { "content-type": "application/x-git-upload-pack-request" }; }
    const actual = await localRequest(adapter.repositoryUrl + path, options);
    expect({ status: actual, upstreamRequests: (await f.requests()).length - before }).toEqual({ status, upstreamRequests: 0 });
  } finally { await adapter.close(); }
});

it("B2b keeps the internal token and caller Authorization out of the real upstream", async () => {
  const f = heldSource.fixture; const adapter = await createGitHttpAdapter(adapterOptions(f));
  try {
    expect(await localRequest(adapter.repositoryUrl + "/info/refs?service=git-upload-pack", { headers: { authorization: "Bearer caller-only-synthetic-secret" } })).toBe(200);
    const request = (await f.requests()).at(-1)!;
    expect({ auth: request.authorization, internalToken: request.internalToken }).toEqual({ auth: "Basic b3duZWQ6c3ludGhldGlj", internalToken: undefined });
  } finally { await adapter.close(); }
});

async function startPausedRpc(adapterUrl: string) {
  let close!: () => void; const closed = new Promise<void>(resolve => { close = resolve; });
  const req = httpRequest(adapterUrl + "/git-upload-pack", { agent: false, method: "POST", headers: { "x-apicc-source-token": token, "content-type": "application/x-git-upload-pack-request", "content-length": 4 } });
  req.on("error", () => undefined); req.on("close", close); req.on("response", response => response.resume()); req.end("0000");
  return { req, closed };
}
async function waitForSourceRequest(f: GitSourceFixture, before: number) { for (let i = 0; i < 30; i++) { if ((await f.requests()).length > before) return; await new Promise(r => setTimeout(r, 10)); } throw Error("Owned paused HTTPS request did not start"); }

it("B2b bounds concurrent HTTP requests", async () => {
  const f = heldSource.fixture; const adapter = await createGitHttpAdapter(adapterOptions(f)); await f.pauseUploads(); let first: Awaited<ReturnType<typeof startPausedRpc>> | undefined;
  try {
    const before = (await f.requests()).length; first = await startPausedRpc(adapter.repositoryUrl); await waitForSourceRequest(f, before);
    const active = (await f.requests()).length; const status = await localRequest(adapter.repositoryUrl + "/info/refs?service=git-upload-pack");
    expect({ status, additionalUpstream: (await f.requests()).length - active }).toEqual({ status: 503, additionalUpstream: 0 });
  } finally { first?.req.destroy(); await adapter.close(); await f.resumeUploads(); }
});

it.each(["cancel", "deadline"])("B2b closes actual request/socket/listener on %s", async reason => {
  const f = heldSource.fixture; const controller = new AbortController();
  const adapter = await createGitHttpAdapter(adapterOptions(f, { signal: controller.signal, deadlineAtMs: Date.now() + (reason === "deadline" ? 500 : 15000) })); await f.pauseUploads(); let active: Awaited<ReturnType<typeof startPausedRpc>> | undefined;
  try {
    const before = (await f.requests()).length; active = await startPausedRpc(adapter.repositoryUrl); await waitForSourceRequest(f, before);
    if (reason === "cancel") controller.abort();
    const closed = await Promise.race([active.closed.then(() => true), new Promise<boolean>(r => setTimeout(() => r(false), 800))]);
    expect({ closed, upstreamSockets: await f.activeHttpSockets() }).toEqual({ closed: true, upstreamSockets: 0 });
    await expect(localRequest(adapter.repositoryUrl + "/info/refs?service=git-upload-pack")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  } finally { active?.req.destroy(); await adapter.close(); await f.resumeUploads(); }
});

it.each([{ maxHeaderBytes: 1024.5 }, { maxConcurrentRequests: 5 }, { maxRequestBytes: 0 }])("B2b refuses invalid trusted adapter limits %j", async changes => {
  let adapter: Awaited<ReturnType<typeof createGitHttpAdapter>> | undefined;
  try { await expect(createGitHttpAdapter(adapterOptions(heldSource.fixture, changes)).then(value => { adapter = value; return value; })).rejects.toMatchObject({ code: "SYNC_HOST_CONFIG_INVALID" }); }
  finally { await adapter?.close(); }
});

it.each(["CA", "hostname"])("B2b verifies the real target %s before sending HTTP", async mismatch => {
  const f = heldSource.fixture; const before = (await f.requests()).length;
  const adapter = await createGitHttpAdapter(adapterOptions(f, { ...(mismatch === "hostname" ? { repositoryUrl: new URL(f.httpsUrl.replace("owned.git.test", "wrong.git.test")) } : {}), targetTLS: { rejectUnauthorized: true, ...(mismatch === "CA" ? {} : { ca: f.caPem }), servername: mismatch === "hostname" ? "wrong.git.test" : "owned.git.test" } }));
  try {
    expect(await localRequest(adapter.repositoryUrl + "/info/refs?service=git-upload-pack")).toBe(502);
    expect({ code: adapter.failureCode, upstreamRequests: (await f.requests()).length - before }).toEqual({ code: "SYNC_TLS_FAILED", upstreamRequests: 0 });
  } finally { await adapter.close(); }
});

it("B2b refuses real upstream redirects", async () => {
  const adapter = await createGitHttpAdapter(adapterOptions(heldSource.fixture, { repositoryUrl: new URL(heldSource.fixture.httpsUrl.replace("repo-sha1.git", "redirect.git")) }));
  try { expect(await localRequest(adapter.repositoryUrl + "/info/refs?service=git-upload-pack")).toBe(502); expect(adapter.failureCode).toBe("SYNC_REDIRECT_INVALID"); }
  finally { await adapter.close(); }
});

it("B2b starts the connection budget again on a second independent TLS connection", async () => {
  const f = heldSource.fixture; let connections = 0; const sockets = new Set<Socket>();
  const tls = createTLSServer({ key: await f.exec(["cat", "/fixture/server.key"]), cert: await f.exec(["cat", "/fixture/server.pem"]) }, socket => { socket.once("data", () => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nowned")); });
  const tcp = createServer(socket => { connections++; sockets.add(socket); observeOwnedPeerReset(socket); socket.once("close", () => sockets.delete(socket)); if (connections === 1) tls.emit("connection", socket); else socket.on("data", () => undefined); });
  await new Promise<void>(resolve => tcp.listen(0, "127.0.0.1", resolve)); const port = (tcp.address() as import("node:net").AddressInfo).port;
  const adapter = await createGitHttpAdapter(adapterOptions(f, { repositoryUrl: new URL(`https://owned.git.test:${port}/repo.git`) }));
  try {
    expect(await localRequest(adapter.repositoryUrl + "/info/refs?service=git-upload-pack")).toBe(200);
    const second = await localRequest(adapter.repositoryUrl + "/info/refs?service=git-upload-pack"); expect(connections).toBe(2);
    expect(second).toBe(504); expect(adapter.failureCode).toBe("SYNC_CONNECT_TIMEOUT");
  } finally { await adapter.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => tcp.close(() => resolve())); }
}, 5000);

const expectedObjects = {
  sha1: { kind: "git", objectFormat: "sha1", commitOid: "f9fbd710b4a0772621ad5c76fb5393938a67b8e2", blobOid: "f77ca262872d149b637048a2aa365bc8794cd8db", rawSha256: "6dc57b202bb79a3f2c1d12dcb9a52e8cfd13f8fc3ba1cc76f5e372779ad48cce" },
  sha256: { kind: "git", objectFormat: "sha256", commitOid: "5676e6ffaca4b6d841a76fa19e918e3e718f7e3ee241c6c1f5de618a2c662eb2", blobOid: "25c556ea9234296a727d63dc4eb6f56cf4b4c2f90274dec965897933d8d3b4b0", rawSha256: "6dc57b202bb79a3f2c1d12dcb9a52e8cfd13f8fc3ba1cc76f5e372779ad48cce" },
};
it.each(["sha1", "sha256"] as const)("B3 public HTTPS reads complete %s object identities and raw bytes", async format => {
  const f = heldSource.fixture; const r = await gitReaderFixture(f, application);
  await expect(r.read(r.input("git-https", { repositoryUrl: f.httpsUrl.replace("repo-sha1", `repo-${format}`) }))).resolves.toEqual({ formatVersion: 1, status: "read", upstream: expectedObjects[format], rawText, diagnostics: [] });
  expect(r.released()).toBe(1); expect(r.releases).toEqual([{ exists: false, retained: 0 }]); expect(f.crlRequests).toHaveLength(0);
}, 30000);
it.each(["sha1", "sha256"] as const)("B3 public HTTPS peels an annotated tag to its complete %s commit", async format => {
  const f = heldSource.fixture; const r = await gitReaderFixture(f, application);
  await expect(r.read(r.input("git-https", { repositoryUrl: f.httpsUrl.replace("repo-sha1", `repo-${format}`), ref: "refs/tags/owned-tag" }))).resolves.toMatchObject({ status: "read", upstream: expectedObjects[format], rawText });
}, 30000);
it("B3 keeps the returned identity fixed when the branch moves before read completion", async () => {
  const f = heldSource.fixture; const r = await gitReaderFixture(f, application);
  try {
    const first = await r.read(r.input(), { onContent: async () => { await f.moveBranch(); } }).catch(error => error);
    expect(first).toMatchObject({ upstream: expectedObjects.sha1, rawText });
    const second = await r.read(r.input()); expect(second).toMatchObject({ upstream: { commitOid: f.repositories.sha1.movedCommitOid, blobOid: f.repositories.sha1.movedBlobOid }, rawText: f.repositories.sha1.movedRawText });
    expect(first.upstream).toEqual(expectedObjects.sha1);
  } finally { await f.resetBranch(); }
}, 30000);
it.each([
  { filePath: "link.yaml", code: "SYNC_GIT_OBJECT_INVALID" }, { filePath: "submodule", code: "SYNC_GIT_OBJECT_INVALID" },
  { filePath: "pointer.yaml", code: "SYNC_GIT_LFS_UNSUPPORTED" }, { filePath: "missing.yaml", code: "SYNC_GIT_PATH_NOT_FOUND" },
  { filePath: "large.yaml", code: "SYNC_SOURCE_TOO_LARGE" }, { ref: "refs/tags/owned-blob", code: "SYNC_GIT_OBJECT_INVALID" },
])("B3 refuses unsafe or unsupported Git content %j", async ({ code, ...changes }) => {
  const r = await gitReaderFixture(heldSource.fixture, application);
  await expect(r.read(r.input("git-https", changes))).rejects.toMatchObject({ code });
  expect(r.contentsDelivered()).toBe(0); expect(r.releases).toEqual([{ exists: false, retained: 0 }]);
}, 30000);
it.each(["missing auth", "wrong auth", "missing CA", "owned header"])("B3 refuses HTTPS %s with bounded secret-free diagnostics", async scenario => {
  const f = heldSource.fixture; const r = await gitReaderFixture(f, application);
  const changes = scenario === "missing auth" ? { httpHeaders: [] } : scenario === "wrong auth" ? { httpHeaders: [{ name: "Authorization", value: "Basic wrong-owned-secret" }] } : scenario === "missing CA" ? { tls: undefined } : { httpHeaders: [{ name: "Authorization", value: "Basic b3duZWQ6c3ludGhldGlj" }, { name: "X-Apicc-Source-Token", value: "owned-collision-secret" }] };
  const error = await r.read(r.input(), {}, changes).catch(value => value);
  expect(error).toMatchObject({ code: scenario === "missing auth" ? "SYNC_MATERIAL_MISSING" : scenario === "wrong auth" ? "SYNC_GIT_AUTH_FAILED" : scenario === "missing CA" ? "SYNC_TLS_FAILED" : "SYNC_MATERIAL_INVALID" });
  expect(String(error)).not.toMatch(/wrong-owned-secret|owned-collision-secret|Authorization|[A-Z]:\\/); expect(r.released()).toBe(1);
}, 30000);

// Removing the local httpsRequest construction catch must turn this finite public failure into child exit 1.
it("I1 public HTTPS normalizes synchronous malformed client TLS construction and collects before release", async () => {
  const f = heldSource.fixture; const r = await gitReaderFixture(f, application);
  const owner = await r.options.git!.createPrivateRead(new AbortController().signal);
  const descriptor = { entry: join(application.directory, "index.js"), root: f.directory, directory: owner.directory, tools, address: f.address, input: r.input(), lease: { leaseId: "owned-malformed-tls", httpHeaders: [{ name: "Authorization", value: "Basic b3duZWQ6c3ludGhldGlj" }], tls: { caPem: f.caPem, certPem: "owned-invalid-client-certificate-secret", keyPem: "owned-invalid-client-key-secret" } } };
  try {
    const result = await new Promise<{ exit: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL("./git-tls-failure-child.mjs", import.meta.url))], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = ""; let stderr = "";
      const timer = setTimeout(() => { child.kill(); reject(Error("Isolated public TLS read exceeded its bounded test lifetime")); }, 35000);
      child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
      child.once("error", reject); child.once("close", exit => { clearTimeout(timer); resolve({ exit, stdout, stderr }); });
      child.stdin.end(JSON.stringify(descriptor));
    });
    expect(result.exit, JSON.stringify(result)).toBe(0); expect(result.stderr).toBe("");
    const [started, outcome] = result.stdout.trim().split("\n").map(line => JSON.parse(line));
    expect(started).toEqual({ stage: "public-read", node: "22.19.0" });
    expect(outcome).toEqual({ failure: { code: "SYNC_TLS_FAILED", message: "SourceHostError: SYNC_TLS_FAILED" }, released: 1, retained: 0, delivered: 0, directoryExists: false, events: ["collected", "released-absent"] });
    expect(result.stdout + result.stderr).not.toContain("owned-invalid-client"); expect(result.stdout + result.stderr).not.toContain("b3duZWQ6c3ludGhldGlj");
    expect(result.stdout + result.stderr).not.toContain(owner.directory);
    expect(await access(owner.directory).then(() => true, () => false)).toBe(false);
  } finally { await owner.collect(); }
}, 45000);
it.each(["denied", "proxy"])("B3 refuses %s captured routing before reading objects", async scenario => {
  const r = await gitReaderFixture(heldSource.fixture, application);
  const context = await r.options.captureNetwork(r.input().source, new AbortController().signal);
  const captured = scenario === "denied" ? { ...context, approveDestination: () => false } : { ...context, prepared: await prepareGitFixtureNetwork(heldSource.fixture, true) };
  if (scenario === "proxy") expect(captured.prepared.resolveForOrigin(new URL(heldSource.fixture.httpsUrl)).route).toEqual({ kind: "proxy", url: "http://127.0.0.1:1" });
  await expect(r.read(r.input(), { captureNetwork: async () => captured })).rejects.toMatchObject({ code: scenario === "denied" ? "SYNC_NETWORK_DENIED" : "SYNC_PROXY_UNSUPPORTED" });
  expect(r.contentsDelivered()).toBe(0); expect(r.released()).toBe(1);
}, 30000);
it("B3 uses the private disk sampling threshold without claiming a hard quota", async () => {
  const r = await gitReaderFixture(heldSource.fixture, application);
  const git = { ...r.options.git!, createPrivateRead: async (signal: AbortSignal) => { const owner = await r.options.git!.createPrivateRead(signal); await writeFile(join(owner.directory, "owned-large-material"), Buffer.alloc(33554433)); return owner; } };
  await expect(r.read(r.input(), { git })).rejects.toMatchObject({ code: "SYNC_GIT_DISK_LIMIT" }); expect(r.releases).toEqual([{ exists: false, retained: 0 }]);
}, 30000);
it("B3 retains public Git occupancy and lease when private collection cannot be proven", async () => {
  const r = await gitReaderFixture(heldSource.fixture, application);
  const git = { ...r.options.git!, createPrivateRead: async (signal: AbortSignal) => ({ ...await r.options.git!.createPrivateRead(signal), collect: async () => { throw Error("owned collector failed"); } }) };
  try { await expect(r.read(r.input(), { git })).rejects.toMatchObject({ code: "SYNC_PROCESS_UNCOLLECTED" }); expect(r.retained()).toBe(1); expect(r.released()).toBe(0); expect(await access(r.directories.at(-1)!).then(() => true, () => false)).toBe(true); }
  finally { for (const directory of r.directories) await rm(directory, { recursive: true, force: true }); }
}, 30000);

it.each(["cancel", "deadline"])("B3 collects an actual active HTTPS read on %s before releasing material", async reason => {
  const f = heldSource.fixture; const r = await gitReaderFixture(f, application); const controller = new AbortController(); const input = r.input();
  if (reason === "deadline") input.deadlineAtMs = Date.now() + 5000;
  await f.pauseUploads(); const before = (await f.uploads()).length; let settled = false; let started = false;
  const pending = r.read(input, {}, {}, controller.signal).then(value => ({ value, error: undefined }), error => ({ value: undefined, error })); pending.then(() => { settled = true; });
  try {
    while (!settled && Date.now() < input.deadlineAtMs) { if ((await f.uploads()).length > before) { started = true; if (reason === "cancel") controller.abort(); break; } await new Promise(resolve => setTimeout(resolve, 25)); }
    if (!started && !settled) controller.abort();
    const outcome = await pending;
    expect({ started, code: outcome.error?.code, released: r.released(), retained: r.retained() }).toEqual({ started: true, code: reason === "cancel" ? "SYNC_CANCELLED" : "SYNC_DEADLINE", released: 1, retained: 0 });
    expect(r.releases).toEqual([{ exists: false, retained: 0 }]);
    for (let i = 0; i < 30 && await f.activeHttpSockets(); i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(await f.activeHttpSockets()).toBe(0);
  } finally { controller.abort(); await f.resumeUploads(); await pending; }
}, 45000);

it.each(["path", "budget"])("B3 rejects invalid public %s input before capture and releases once", async scenario => {
  const r = await gitReaderFixture(heldSource.fixture, application); const input = r.input();
  if (scenario === "budget") input.budget.maxSourceBytes = 1;
  else if (input.source.kind !== "url") input.source.filePath = "../escape.yaml";
  await expect(r.read(input)).rejects.toMatchObject({ code: "SYNC_INPUT_INVALID" }); expect(r.captures()).toBe(0); expect(r.released()).toBe(1);
});

// Post-implementation correctness only: the missing original UTF-8 RED is recorded in the report.
it("B3 supplement rejects a real invalid UTF-8 blob without delivering replacement text", async () => {
  const r = await gitReaderFixture(heldSource.fixture, application);
  await expect(r.read(r.input("git-https", { ref: "refs/heads/invalid-utf8", filePath: "invalid-utf8.yaml" }))).rejects.toMatchObject({ code: "SYNC_ENCODING_INVALID" });
  expect(r.contentsDelivered()).toBe(0); expect(r.releases).toEqual([{ exists: false, retained: 0 }]);
}, 30000);

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFile, appendFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Socket } from "node:net";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { createServer as createTcpServer } from "node:net";
import { prepareNetworkRun, type PreparedNetworkRun } from "@apicc/core";
import { SourceReadInputSchema } from "@apicc/core/sync";
import { createSourceHost, type SourceHostOptions, type SourceReadInput, type SourceMaterialLease, type SourceCacheEntry } from "../../src/source-host/index.js";

const cert = (name: string) => readFile(new URL(`../../../core/tests/http/fixtures/network/${name}`, import.meta.url), "utf8");
export const sourceId = "00000000-0000-4000-8000-000000000001";
export const moduleId = "00000000-0000-4000-8000-000000000002";
export function inputFor(url: string): SourceReadInput {
  return SourceReadInputSchema.parse({ formatVersion: 1, source: { formatVersion: 1, id: sourceId, revision: "1", moduleId, kind: "url", url }, deadlineAtMs: Date.now() + 5000, budget: { connectTimeoutMs: 1000, maxAttempts: 1, maxSourceBytes: 65536, gitDiskThresholdBytes: 33554432 } });
}
export interface Observation { path: string; headers: IncomingMessage["headers"]; clientIdentity: boolean }
export async function withSourceServer(callback: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>): Promise<void> {
  const f = await fixture();
  try { await callback(f); } finally { await f.close(); }
}
async function fixture() {
  const sockets = new Set<Socket>(); const requests: Observation[] = []; const targets: Observation[] = [];
  const cache = new Map<string, SourceCacheEntry>();
  let released = 0; let attempts = 0; let bytesSent = 0;
  let changingRedirects = 0;
  let disconnectAttempts = 0;
  const reads: { requestCount: number; bytesAtReturn: number; socketsAtReturn: number; result: string; durationMs: number }[] = [];
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    requests.push({ path: req.url!, headers: req.headers, clientIdentity: Boolean("getPeerCertificate" in req.socket && (req.socket as import("node:tls").TLSSocket).getPeerCertificate()?.subject) });
    const path = req.url!;
    if (path === "/redirect") { res.writeHead(302, { location: targetUrl + "/target" }); res.end(); }
    else if (path === "/secure-redirect") { res.writeHead(302, { location: secureTargetUrl + "/target" }); res.end(); }
    else if (path === "/changing-redirect") { res.writeHead(302, { location: ++changingRedirects === 1 ? "/cache" : "/not-modified" }); res.end(); }
    else if (path === "/same") { res.writeHead(302, { location: "/ok" }); res.end(); }
    else if (/^\/chain\/\d+$/.test(path)) { const remaining = Number(path.split("/")[2]); if (remaining) { res.writeHead(302, { location: `/chain/${remaining - 1}` }); res.end(); } else res.end("hello"); }
    else if (path.startsWith("/invalid-target/")) { const part = path.split("/")[2]; const target = new URL(url + "/ok"); if (part === "username") target.username = "synthetic"; else if (part === "password") target.password = "synthetic"; else target.hash = "fragment"; res.writeHead(302, { location: target.href }); res.end(); }
    else if (path === "/loop") { res.writeHead(302, { location: "/loop" }); res.end(); }
    else if (path === "/bad-redirect") { res.writeHead(302, { location: "file:///owned" }); res.end(); }
    else if (path === "/no-location") { res.writeHead(302); res.end(); }
    else if (path === "/downgrade") { res.writeHead(302, { location: url + "/ok" }); res.end(); }
    else if (path === "/not-modified" || (path === "/cache" && req.headers["if-none-match"] === '"v1"')) { res.writeHead(304); res.end(); }
    else if (path === "/status") { res.writeHead(403); res.end("secret-body"); }
    else if (path === "/retry" && ++attempts === 1) { res.writeHead(503); res.end("temporary"); }
    else if (path === "/retry-deadline") { setTimeout(() => { if (!res.destroyed) { res.writeHead(503); res.end("temporary"); } }, 120); }
    else if (path === "/disconnect-retry" && ++disconnectAttempts === 1) { res.writeHead(200, { "content-length": 100, "content-encoding": "gzip" }); res.write(gzipSync(Buffer.from("hello")).subarray(0, 10)); setTimeout(() => res.destroy(), 10); }
    else if (path === "/truncated") { res.writeHead(200, { "content-length": 100 }); res.write("part"); setTimeout(() => res.destroy(), 10); }
    else if (path === "/slow") { res.writeHead(200); res.write("x"); const timer = setInterval(() => { bytesSent++; res.write("x"); }, 10); const end = setTimeout(() => res.end(), 500); res.on("close", () => { clearInterval(timer); clearTimeout(end); }); }
    else if (path === "/large") { const body = Buffer.alloc(70000, 120); bytesSent += body.length; res.end(body); }
    else if (path === "/gzip") { const body = gzipSync(Buffer.alloc(70000, 120)); bytesSent += body.length; res.writeHead(200, { "content-encoding": "gzip" }); res.end(body); }
    else if (path === "/gzip-ok" || path === "/deflate-ok" || path === "/br-ok") { const encoding = path.slice(1, -3); const body = ({ gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync }[encoding]!)(Buffer.from("hello")); bytesSent += body.length; res.writeHead(200, { "content-encoding": encoding }); res.end(body); }
    else if (path === "/gzip-wire") { const body = Buffer.concat([gzipSync(Buffer.from("hello")), Buffer.alloc(70000)]); bytesSent += body.length; res.writeHead(200, { "content-encoding": "gzip" }); res.end(body); }
    else if (path.startsWith("/compressed-invalid/")) {
      const kind = path.split("/")[2]!; const encoding = kind.split("-")[0]!;
      let body = encoding === "br" ? Buffer.from([255, 255, 255, 255]) : (encoding === "gzip" ? gzipSync : deflateSync)(Buffer.from("hello"));
      if (kind.endsWith("-checksum")) { body = Buffer.from(body); body[body.length - 8] = body[body.length - 8]! ^ 1; }
      else if (kind.endsWith("-truncated")) body = body.subarray(0, body.length - 4);
      else if (encoding !== "br") { body = Buffer.from(body); body[0] = 0; }
      res.writeHead(200, { "content-encoding": encoding, "content-length": body.length }); res.end(body);
    }
    else if (path === "/last-modified") { if (req.headers["if-modified-since"] === "Wed, 04 Nov 2026 00:00:00 GMT") { res.writeHead(304); res.end(); } else { res.writeHead(200, { "last-modified": "Wed, 04 Nov 2026 00:00:00 GMT" }); res.end("hello"); } }
    else if (path === "/encoding") { res.writeHead(200, { "content-encoding": "strange" }); res.end("x"); }
    else if (path === "/invalid-utf8") { res.end(Buffer.from([0xff])); }
    else { res.writeHead(200, { etag: '"v1"', "last-modified": "Wed, 04 Nov 2026 00:00:00 GMT" }); bytesSent += 5; res.end("hello"); }
  };
  const servers: Server[] = [];
  const listen = async (server: Server) => { servers.push(server); server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); }); await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); return (server.address() as import("node:net").AddressInfo).port; };
  const targetPort = await listen(createServer((req, res) => { targets.push({ path: req.url!, headers: req.headers, clientIdentity: false }); res.end("hello"); }));
  const targetUrl = `http://127.0.0.1:${targetPort}`;
  const port = await listen(createServer(handle)); const url = `http://127.0.0.1:${port}`;
  const ca = await cert("synthetic-target-ca.pem");
  const secureTargetPort = await listen(createHttpsServer({ key: await cert("synthetic-target-server.key"), cert: await cert("synthetic-target-server.pem"), ca, requestCert: true, rejectUnauthorized: false }, (req, res) => { const subject = (req.socket as import("node:tls").TLSSocket).getPeerCertificate()?.subject; targets.push({ path: req.url!, headers: req.headers, clientIdentity: Boolean(subject) }); res.end("hello"); }));
  const secureTargetUrl = `https://127.0.0.1:${secureTargetPort}`;
  // Optional client identity observation; the client still verifies this server.
  const securePort = await listen(createHttpsServer({ key: await cert("synthetic-target-server.key"), cert: await cert("synthetic-target-server.pem"), ca, requestCert: true, rejectUnauthorized: false }, handle));
  const secureUrl = `https://127.0.0.1:${securePort}`;
  const blackhole = createTcpServer(socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("data", () => undefined); });
  await new Promise<void>(r => blackhole.listen(0, "127.0.0.1", r));
  const blackholeUrl = `https://127.0.0.1:${(blackhole.address() as import("node:net").AddressInfo).port}`;
  const prepared = await prepareNetworkRun({ scope: { canonicalRoot: process.cwd(), project: { workspaceId: "owned", groupId: "owned", projectId: "owned" } }, store: { load: async () => ({ revision: "1", configuration: { formatVersion: 1, profiles: [], environmentSelections: [] } }), save: async () => "1" }, secretStore: {} as never, selection: { kind: "direct" } });
  const preparedTLS = await prepareNetworkRun({ scope: { canonicalRoot: process.cwd(), project: { workspaceId: "owned", groupId: "owned", projectId: "owned" } }, store: { load: async () => ({ revision: "1", configuration: { formatVersion: 1, profiles: [{ id: "owned-tls", kind: "direct", name: "Owned TLS", targetTlsBindings: [secureUrl, secureTargetUrl].map(origin => ({ origin, tls: { caCertificatePaths: [fileURLToPath(new URL("../../../core/tests/http/fixtures/network/synthetic-target-ca.pem", import.meta.url))] } })) }], environmentSelections: [] } }), save: async () => "1" }, secretStore: {} as never, selection: { kind: "profile", profileId: "owned-tls" } });
  const options: SourceHostOptions = {
    captureNetwork: async () => ({ prepared, policyIdentity: "allow-owned-v1", materialIdentity: "material-v1", approveDestination: u => u.origin !== targetUrl }),
    cache: { get: async key => cache.get(key), put: async entry => { cache.set(entry.binding, entry); } },
  };
  const read = async (input: SourceReadInput | string, overrides: Partial<SourceHostOptions> = {}, leaseOverrides: Partial<SourceMaterialLease> = {}, signal?: AbortSignal) => {
    const start = performance.now(); const count = requests.length; let result = "";
    try { const value = await createSourceHost({ ...options, ...overrides }).readSource(typeof input === "string" ? inputFor(input) : input, { leaseId: "synthetic-lease", ...leaseOverrides, release: async () => { released++; await leaseOverrides.release?.(); } }, signal); result = value.status; return value; }
    catch (error) { result = (error as { code?: string }).code ?? "unknown"; throw error; }
    finally { reads.push({ requestCount: requests.length - count, bytesAtReturn: bytesSent, socketsAtReturn: sockets.size, result, durationMs: Math.round(performance.now() - start) }); }
  };
  return { url, targetUrl, secureUrl, secureTargetUrl, blackholeUrl, ca, clientCert: await cert("synthetic-client.pem"), clientKey: await cert("synthetic-client.key"), prepared, preparedTLS, options, cache, requests, sockets, read, input: inputFor, redirectSource: inputFor(url + "/redirect"), redirectTargetRequests: () => targets, released: () => released, bytesSent: () => bytesSent, close: async () => {
    const evidenceDir = new URL("../../../../local/f7g/t4/", import.meta.url); await mkdir(evidenceDir, { recursive: true });
    await appendFile(new URL("observations.jsonl", evidenceDir), JSON.stringify({ reads, sourceRequests: requests.length, redirectTargetRequests: targets.length, bytesSent, releases: released, remainingSocketsBeforeFixtureCleanup: sockets.size }) + "\n");
    for (const s of servers) s.closeAllConnections(); for (const socket of sockets) socket.destroy(); await Promise.all([...servers, blackhole].map(s => new Promise<void>(r => s.close(() => r()))));
  } };
}
export function withPrepared(prepared: PreparedNetworkRun, change: Partial<PreparedNetworkRun>): PreparedNetworkRun { return { ...prepared, ...change }; }

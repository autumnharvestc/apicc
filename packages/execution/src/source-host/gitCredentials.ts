import type { SourceAddress } from "./types.js";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import type { ConnectionOptions } from "node:tls";
import { request as httpsRequest } from "node:https";
import type { ClientRequest } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { SourceHostError } from "./limits.js";

export interface GitHttpAdapterOptions {
  readonly repositoryUrl: URL;
  readonly address: SourceAddress;
  readonly targetTLS: ConnectionOptions;
  readonly headers: Readonly<Record<string, string>>;
  readonly token: string;
  readonly signal: AbortSignal;
  readonly connectTimeoutMs: number;
  readonly deadlineAtMs: number;
  /** Trusted inbound header cap, integer 1024–16384 bytes, default 8192. */
  readonly maxHeaderBytes?: number;
  /** Trusted per-read active request cap, integer 1–4, default 1. */
  readonly maxConcurrentRequests?: number;
  /** Trusted upload-pack RPC input cap, integer 4096–1048576 bytes, default 65536. */
  readonly maxRequestBytes?: number;
}
export interface GitHttpAdapter {
  readonly repositoryUrl: string;
  readonly failureCode: string | undefined;
  readonly failureStatus?: number;
  close(): Promise<void>;
}
/** Internal fixed-target transport; public SourceHost routing is not connected here. */
export async function createGitHttpAdapter(options: GitHttpAdapterOptions): Promise<GitHttpAdapter> {
  const limit = (value: number | undefined, fallback: number, min: number, max: number) => { const chosen = value === undefined ? fallback : value; if (!Number.isInteger(chosen) || chosen < min || chosen > max) throw new SourceHostError("SYNC_HOST_CONFIG_INVALID"); return chosen; };
  const maxHeaderBytes = limit(options.maxHeaderBytes, 8192, 1024, 16384);
  const maxConcurrentRequests = limit(options.maxConcurrentRequests, 1, 1, 4);
  const maxRequestBytes = limit(options.maxRequestBytes, 65536, 4096, 1048576);
  const basePath = options.repositoryUrl.pathname.replace(/\/$/, "");
  const secret = Buffer.from(options.token); let authority = ""; let activeRequests = 0;
  const sockets = new Set<Socket>(); const requests = new Set<ClientRequest>(); let failureCode: string | undefined; let failureStatus: number | undefined; let closing: Promise<void> | undefined;
  const own = (socket: Socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); if (closing) socket.destroy(); };
  const server = createServer({ maxHeaderSize: maxHeaderBytes }, (incoming, outgoing) => {
    const deny = (status: number) => { outgoing.writeHead(status, { connection: "close" }); outgoing.end(); incoming.resume(); };
    const supplied = incoming.headers["x-apicc-source-token"];
    const token = typeof supplied === "string" ? Buffer.from(supplied) : Buffer.alloc(0);
    const metadata = incoming.method === "GET" && incoming.url === basePath + "/info/refs?service=git-upload-pack";
    const rpc = incoming.method === "POST" && incoming.url === basePath + "/git-upload-pack";
    if (incoming.headers.host !== authority || token.length !== secret.length || !timingSafeEqual(token, secret) || (!metadata && !rpc)) { deny(403); return; }
    if (rpc && incoming.headers["content-type"] !== "application/x-git-upload-pack-request") { deny(415); return; }
    if (activeRequests >= maxConcurrentRequests) { deny(503); return; }
    activeRequests++; let released = false; const release = () => { if (!released) { released = true; activeRequests--; } };
    outgoing.once("finish", release); outgoing.once("close", release);
    let bytes = 0; let rejected = false; const chunks: Buffer[] = [];
    const declaredBytes = Number(incoming.headers["content-length"] ?? 0);
    if (declaredBytes > maxRequestBytes) { deny(413); return; }
    incoming.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > maxRequestBytes) { if (!rejected) { rejected = true; deny(413); } } else if (!rejected) chunks.push(chunk); });
    incoming.on("end", () => {
      if (rejected || outgoing.destroyed) return;
      const target = new URL(options.repositoryUrl.href); target.pathname = basePath + (metadata ? "/info/refs" : "/git-upload-pack"); if (metadata) target.searchParams.set("service", "git-upload-pack");
      const headers = Object.fromEntries(Object.entries({ ...options.headers, "content-type": rpc ? "application/x-git-upload-pack-request" : undefined, "content-length": String(bytes), "git-protocol": incoming.headers["git-protocol"], host: target.host }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      const requestOptions: import("node:https").RequestOptions & { autoSelectFamily: boolean } = { ...options.targetTLS, agent: false, autoSelectFamily: false, method: incoming.method, headers, lookup: (_hostname, _lookupOptions, callback) => callback(null, options.address.address, options.address.family) };
      const fail = (error: NodeJS.ErrnoException) => { failureCode ??= /CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(error.code ?? "") ? "SYNC_TLS_FAILED" : "SYNC_READ_FAILED"; if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); };
      let upstream: ClientRequest;
      try { upstream = httpsRequest(target, requestOptions, response => {
        if (response.statusCode && response.statusCode >= 400) failureStatus = response.statusCode;
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400) { failureCode ??= "SYNC_REDIRECT_INVALID"; outgoing.writeHead(502); outgoing.end(); response.destroy(); return; }
        outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing); response.on("error", () => outgoing.destroy());
      }); } catch (error) { fail(error as NodeJS.ErrnoException); return; }
      const connecting = setTimeout(() => { failureCode ??= "SYNC_CONNECT_TIMEOUT"; if (!outgoing.headersSent) outgoing.writeHead(504); outgoing.end(); upstream.destroy(); }, options.connectTimeoutMs);
      requests.add(upstream); upstream.once("close", () => { clearTimeout(connecting); requests.delete(upstream); });
      upstream.on("socket", socket => { own(socket); socket.once("secureConnect", () => clearTimeout(connecting)); });
      upstream.on("error", fail);
      incoming.on("aborted", () => upstream.destroy()); outgoing.on("close", () => upstream.destroy()); upstream.end(Buffer.concat(chunks, bytes));
    });
  });
  server.on("connection", own);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  authority = `127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  let deadline: ReturnType<typeof setTimeout>;
  const abort = () => { failureCode ??= "SYNC_INTERRUPTED"; void adapter.close(); };
  const adapter: GitHttpAdapter = {
    repositoryUrl: `http://${authority}${basePath}`,
    get failureCode() { return failureCode; },
    get failureStatus() { return failureStatus; },
    close() {
      closing ??= (async () => {
        clearTimeout(deadline); options.signal.removeEventListener("abort", abort);
        const closed = new Promise<void>(resolve => server.close(() => resolve()));
        const collectedRequests = [...requests].map(request => new Promise<void>(resolve => { request.once("close", () => resolve()); request.destroy(); }));
        for (const socket of sockets) socket.destroy();
        await Promise.all([closed, ...collectedRequests]);
        while (sockets.size) await Promise.all([...sockets].map(socket => new Promise<void>(resolve => { socket.once("close", () => resolve()); socket.destroy(); })));
      })();
      return closing;
    },
  };
  deadline = setTimeout(() => { failureCode ??= "SYNC_DEADLINE"; void adapter.close(); }, Math.max(1, options.deadlineAtMs - Date.now()));
  options.signal.addEventListener("abort", abort, { once: true }); if (options.signal.aborted) abort();
  return adapter;
}

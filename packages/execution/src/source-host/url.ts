import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { createHash } from "node:crypto";
import type { Socket } from "node:net";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";
import { SourceReadInputSchema } from "@apicc/core/sync";
import type { SourceHost, SourceHostOptions, SourceAddress, SourceCacheEntry } from "./types.js";
import { SourceHostError, readLifetime } from "./limits.js";
import { approvedAddress, connectionTLS } from "./network.js";
import { sourceHeaders } from "./materials.js";
import type { ConnectionOptions } from "node:tls";

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const redirects = new Set([301, 302, 303, 307, 308]);
const transientStatuses = new Set([408, 429, 500, 502, 503, 504]);
interface Response { status: number; headers: IncomingHttpHeaders; body: Buffer }

async function handoff(options: SourceHostOptions, entry: SourceCacheEntry, signal: AbortSignal): Promise<void> {
  try {
    await options.onContent?.(Object.freeze({ rawText: entry.rawText, upstream: Object.freeze({ ...entry.upstream }), bindingIdentity: entry.binding }), signal);
  } catch { throw new SourceHostError("SYNC_CONTENT_HANDOFF_FAILED"); }
}

/** No pooled socket escapes a read; settle only after the owned socket closes. */
function readResponse(url: URL, address: SourceAddress, headers: Record<string, string>, tls: ConnectionOptions, limit: number, connectTimeoutMs: number, signal: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    let socket: Socket | undefined; let socketClosed = false; let requestClosed = false;
    let result: Response | undefined; let failure: unknown;
    let decoder: ReturnType<typeof createGunzip> | undefined;
    const settle = () => {
      if (!requestClosed || (socket && !socketClosed) || (!result && !failure)) return;
      clearTimeout(connectTimer); signal.removeEventListener("abort", abort); decoder?.destroy();
      if (failure) reject(failure); else resolve(result!);
    };
    const fail = (error: unknown) => { failure ??= error; decoder?.destroy(); req.destroy(); settle(); };
    const abort = () => fail(new SourceHostError("SYNC_INTERRUPTED"));
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const requestOptions: import("node:https").RequestOptions & { autoSelectFamily: boolean } = {
      ...tls, agent: false, headers: { "accept-encoding": "gzip, deflate, br", ...headers }, autoSelectFamily: false,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
    };
    const req = send(url, requestOptions, res => {
      clearTimeout(connectTimer);
      const status = res.statusCode ?? 0;
      // Redirect, 304 and error bodies are never specification text.
      if (status !== 200) { result = { status, headers: res.headers, body: Buffer.alloc(0) }; res.destroy(); req.destroy(); return; }
      const encoding = (res.headers["content-encoding"] ?? "identity").trim().toLowerCase();
      if (encoding === "gzip") decoder = createGunzip();
      else if (encoding === "deflate") decoder = createInflate();
      else if (encoding === "br") decoder = createBrotliDecompress();
      else if (encoding !== "identity") { fail(new SourceHostError("SYNC_ENCODING_UNSUPPORTED")); return; }
      let wireBytes = 0; let decodedBytes = 0; let wireEnded = false; let decodedEnded = false; const chunks: Buffer[] = [];
      const finish = () => {
        if (!wireEnded || !decodedEnded || failure) return;
        result = { status, headers: res.headers, body: Buffer.concat(chunks, decodedBytes) }; req.destroy(); settle();
      };
      res.on("data", (chunk: Buffer) => { wireBytes += chunk.length; if (wireBytes > limit) fail(new SourceHostError("SYNC_SOURCE_TOO_LARGE")); });
      res.on("end", () => { wireEnded = true; finish(); });
      res.on("aborted", () => fail(new SourceHostError("SYNC_READ_FAILED", true)));
      res.on("error", () => fail(new SourceHostError("SYNC_READ_FAILED", true)));
      const stream = decoder ? res.pipe(decoder) : res;
      stream.on("data", (chunk: Buffer) => { decodedBytes += chunk.length; if (decodedBytes > limit) fail(new SourceHostError("SYNC_SOURCE_TOO_LARGE")); else chunks.push(chunk); });
      decoder?.on("error", () => fail(new SourceHostError("SYNC_READ_FAILED")));
      stream.on("end", () => { decodedEnded = true; finish(); });
    });
    const connectTimer = setTimeout(() => fail(new SourceHostError("SYNC_CONNECT_TIMEOUT", true)), connectTimeoutMs);
    req.on("socket", owned => {
      socket = owned;
      owned.once("close", () => { socketClosed = true; settle(); });
      owned.once(url.protocol === "https:" ? "secureConnect" : "connect", () => clearTimeout(connectTimer));
    });
    req.on("error", (error: NodeJS.ErrnoException) => {
      const code = error.code ?? "";
      failure ??= new SourceHostError(/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code) ? "SYNC_TLS_FAILED" : "SYNC_READ_FAILED", /^(ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT)$/.test(code));
      req.destroy(); settle();
    });
    req.on("close", () => { requestClosed = true; settle(); });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort(); else req.end();
  });
}

export function createSourceHost(options: SourceHostOptions): SourceHost {
  const maxRedirects = options.maxRedirects === undefined ? 5 : options.maxRedirects;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 20) throw new SourceHostError("SYNC_HOST_CONFIG_INVALID");
  return { async readSource(rawInput, lease, signal) {
    let lifetime: ReturnType<typeof readLifetime> | undefined;
    try {
      const parsed = SourceReadInputSchema.safeParse(rawInput);
      if (!parsed.success || parsed.data.source.kind !== "url") throw new SourceHostError("SYNC_INPUT_INVALID");
      const input = parsed.data; const source = input.source;
      if (source.kind !== "url") throw new SourceHostError("SYNC_INPUT_INVALID");
      lifetime = readLifetime(input.deadlineAtMs, signal); lifetime.check();
      const headers = sourceHeaders(input, lease);
      const context = await options.captureNetwork(source, lifetime.signal); lifetime.check();
      const binding = sha256(JSON.stringify(["apicc-source-cache-v1", source, context.materialIdentity, headers, lease.tls ?? null, context.prepared.identity, context.policyIdentity]));
      const found = await options.cache?.get(binding); lifetime.check();
      const cached = found && found.binding === binding && Buffer.byteLength(found.rawText) <= input.budget.maxSourceBytes && sha256(found.rawText) === found.upstream.rawSha256
        && found.contentIdentity === sha256(JSON.stringify([found.upstream, found.rawText])) ? found : undefined;
      let lastError: unknown;
      for (let attempt = 0; attempt < input.budget.maxAttempts; attempt++) {
        let url = new URL(source.url);
        try {
          for (let hop = 0; ; hop++) {
            lifetime.check();
            const resolution = context.prepared.resolveForOrigin(url);
            if (resolution.route.kind !== "direct") throw new SourceHostError("SYNC_PROXY_UNSUPPORTED");
            const sameOrigin = url.origin === new URL(source.url).origin;
            const tls = connectionTLS(resolution, sameOrigin ? lease.tls : undefined);
            const address = await approvedAddress(url, context, options, lifetime.signal); lifetime.check();
            const requestHeaders = { ...(sameOrigin ? headers : {}) };
            if (cached && cached.upstream.finalUrl === url.href) {
              if (cached.etag) requestHeaders["if-none-match"] = cached.etag;
              else if (cached.lastModified) requestHeaders["if-modified-since"] = cached.lastModified;
            }
            const response = await readResponse(url, address, requestHeaders, tls, input.budget.maxSourceBytes, input.budget.connectTimeoutMs, lifetime.signal); lifetime.check();
            if (redirects.has(response.status)) {
              if (hop >= maxRedirects) throw new SourceHostError("SYNC_REDIRECT_LIMIT");
              let target: URL;
              try { if (!response.headers.location) throw new Error(); target = new URL(response.headers.location, url); } catch { throw new SourceHostError("SYNC_REDIRECT_INVALID"); }
              if (!/^https?:$/.test(target.protocol) || target.username || target.password || target.hash || (url.protocol === "https:" && target.protocol !== "https:")) throw new SourceHostError("SYNC_REDIRECT_INVALID");
              url = target; continue;
            }
            if (response.status === 304) {
              if (!cached || cached.upstream.finalUrl !== url.href) throw new SourceHostError("SYNC_CACHE_MISS");
              await handoff(options, cached, lifetime.signal); lifetime.check();
              return { formatVersion: 1, status: "not-modified", upstream: cached.upstream, diagnostics: [] };
            }
            if (response.status !== 200) throw new SourceHostError("SYNC_HTTP_STATUS", transientStatuses.has(response.status));
            let rawText: string;
            try { rawText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(response.body); } catch { throw new SourceHostError("SYNC_ENCODING_INVALID"); }
            const upstream = { kind: "url" as const, finalUrl: url.href, rawSha256: sha256(response.body) };
            const entry: SourceCacheEntry = { binding, upstream, rawText, contentIdentity: sha256(JSON.stringify([upstream, rawText])), ...(response.headers.etag ? { etag: response.headers.etag } : {}), ...(response.headers["last-modified"] ? { lastModified: response.headers["last-modified"] } : {}) };
            await options.cache?.put(entry); lifetime.check();
            await handoff(options, entry, lifetime.signal); lifetime.check();
            return { formatVersion: 1, status: "read", upstream, rawText, diagnostics: [] };
          }
        } catch (error) {
          lifetime.check(); lastError = error;
          if (!(error instanceof SourceHostError && error.retryable) || attempt + 1 >= input.budget.maxAttempts) throw error;
        }
      }
      throw lastError;
    } catch (error) {
      lifetime?.check();
      if (error instanceof SourceHostError) throw error;
      throw new SourceHostError("SYNC_NETWORK_FAILED");
    } finally {
      try {
        try { await lease.release(); } catch { throw new SourceHostError("SYNC_MATERIAL_RELEASE_FAILED"); }
        lifetime?.check();
      } finally { lifetime?.dispose(); }
    }
  } };
}

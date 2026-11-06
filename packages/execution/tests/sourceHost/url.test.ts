import { describe, it, expect } from "vitest";
import { withSourceServer } from "./fixtures.js";
import { createSourceHost, type SourceHostOptions, type SourceValidatedContent } from "../../src/source-host/index.js";
import { SourceReadInputSchema } from "@apicc/core/sync";
import { createHash } from "node:crypto";

describe("URL source host", () => {
  // These checks catch treating deterministic decoder failures as transient socket failures.
  it.each(["gzip-format", "deflate-format", "br-format", "gzip-checksum", "gzip-truncated"])("does not retry complete HTTP with invalid compressed content %s", async kind => {
    await withSourceServer(async f => {
      const encoding = kind.split("-")[0];
      expect(await f.read(f.url + `/${encoding}-ok`)).toMatchObject({ rawText: "hello" });
      const input = f.input(f.url + `/compressed-invalid/${kind}`); input.budget.maxAttempts = 3;
      const error = await f.read(input).catch(e => e);
      expect(error).toMatchObject({ code: "SYNC_READ_FAILED" });
      expect(f.requests.filter(r => r.path.startsWith("/compressed-invalid/"))).toHaveLength(1);
      expect(error.retryable).toBe(false); expect(f.released()).toBe(2);
    });
  });
  // A host cap changes observed requests, including whether the forbidden next hop is reached.
  it.each([
    { label: "default", maxRedirects: undefined, allowed: 5, requests: 6 },
    { label: "zero", maxRedirects: 0, allowed: 0, requests: 1 },
    { label: "nondefault", maxRedirects: 2, allowed: 2, requests: 3 },
    { label: "upper bound", maxRedirects: 20, allowed: 20, requests: 21 },
  ])("enforces the $label redirect budget on real valid chains", async ({ maxRedirects, allowed, requests }) => {
    await withSourceServer(async f => {
      const options: Partial<SourceHostOptions> & { maxRedirects?: number } = maxRedirects === undefined ? {} : { maxRedirects };
      expect(await f.read(f.url + `/chain/${allowed}`, options)).toMatchObject({ rawText: "hello" });
      expect(f.requests).toHaveLength(requests);
      const start = f.requests.length;
      await expect(f.read(f.url + `/chain/${allowed + 1}`, options)).rejects.toMatchObject({ code: "SYNC_REDIRECT_LIMIT" });
      expect(f.requests.slice(start)).toHaveLength(requests);
      expect(f.requests.slice(start).map(r => r.path)).not.toContain("/chain/0");
    });
  });
  it.each([-1, 0.5, 21, NaN, Infinity, -Infinity, null, "2"])("rejects invalid maxRedirects %s at factory configuration", async maxRedirects => {
    await withSourceServer(async f => {
      let captures = 0;
      const options = { ...f.options, maxRedirects, captureNetwork: async (...args: Parameters<SourceHostOptions["captureNetwork"]>) => { captures++; return f.options.captureNetwork(...args); } };
      expect(() => createSourceHost(options as SourceHostOptions)).toThrowError(expect.objectContaining({ code: "SYNC_HOST_CONFIG_INVALID" }));
      expect(captures).toBe(0); expect(f.requests).toHaveLength(0); expect(f.released()).toBe(0);
    });
  });
  it("retries a real compressed response disconnect and then reads a complete body", async () => {
    await withSourceServer(async f => { const input = f.input(f.url + "/disconnect-retry"); input.budget.maxAttempts = 3; expect(await f.read(input)).toMatchObject({ rawText: "hello" }); expect(f.requests).toHaveLength(2); expect(f.released()).toBe(1); });
  });
  it("shares one total deadline across actual transient response retries", async () => {
    await withSourceServer(async f => {
      const input = f.input(f.url + "/retry-deadline"); input.budget.maxAttempts = 3; input.deadlineAtMs = Date.now() + 200;
      await expect(f.read(input)).rejects.toMatchObject({ code: "SYNC_DEADLINE" });
      // A late first response can exhaust the absolute deadline before a second request.
      expect(f.requests.length).toBeGreaterThanOrEqual(1); expect(f.requests.length).toBeLessThanOrEqual(2);
      expect(f.released()).toBe(1);
    });
  });
  it.each(["username", "password", "hash"])("refuses redirect %s before contacting its target", async part => {
    await withSourceServer(async f => { await expect(f.read(f.url + `/invalid-target/${part}`)).rejects.toMatchObject({ code: "SYNC_REDIRECT_INVALID" }); expect(f.requests.map(r => r.path)).toEqual([`/invalid-target/${part}`]); });
  });
  it("refuses a schema-valid Git source without trusted Git configuration before capturing network", async () => {
    await withSourceServer(async f => {
      const base = f.input(f.url + "/ok"); const { url: _url, ...source } = base.source as Extract<typeof base.source, { kind: "url" }>;
      const input = SourceReadInputSchema.parse({ ...base, source: { ...source, kind: "git-https", repositoryUrl: f.secureUrl + "/owned.git", ref: "main", filePath: "openapi.yaml" } });
      let captures = 0; await expect(f.read(input, { captureNetwork: async (...args) => { captures++; return f.options.captureNetwork(...args); } })).rejects.toMatchObject({ code: "SYNC_GIT_UNAVAILABLE" });
      expect(captures).toBe(0); expect(f.requests).toHaveLength(0); expect(f.released()).toBe(1);
    });
  });
  it("reuses full content with only a Last-Modified validator", async () => {
    await withSourceServer(async f => {
      const content: SourceValidatedContent[] = []; const options = { onContent: async (value: SourceValidatedContent) => { content.push(value); } };
      expect(await f.read(f.url + "/last-modified", options)).toMatchObject({ status: "read", rawText: "hello" });
      expect(await f.read(f.url + "/last-modified", options)).toMatchObject({ status: "not-modified" });
      expect(f.requests).toHaveLength(2); expect(f.requests[1]?.headers["if-modified-since"]).toBe("Wed, 04 Nov 2026 00:00:00 GMT"); expect(f.requests[1]?.headers["if-none-match"]).toBeUndefined(); expect(content.map(c => c.rawText)).toEqual(["hello", "hello"]);
    });
  });
  it("hands independent immutable full-content snapshots to the owner on 200 and 304", async () => {
    await withSourceServer(async f => {
      const content: SourceValidatedContent[] = [];
      const options = { onContent: async (value: SourceValidatedContent) => {
        expect(() => Object.assign(value, { rawText: "tampered" })).toThrow(TypeError);
        expect(() => Object.assign(value.upstream, { finalUrl: "http://invalid.example/" })).toThrow(TypeError);
        content.push(value);
      } };
      const first = await f.read(f.url + "/cache", options); const second = await f.read(f.url + "/cache", options);
      expect(second.status).toBe("not-modified"); expect(content).toHaveLength(2); expect(content[0]).not.toBe(content[1]); expect(content[0]?.upstream).not.toBe(content[1]?.upstream);
      expect(content[0]?.upstream).not.toBe(first.upstream); expect(content[1]?.upstream).not.toBe(second.upstream);
      expect(content.map(c => c.rawText)).toEqual(["hello", "hello"]); expect([...f.cache.values()][0]?.rawText).toBe("hello"); expect(f.requests).toHaveLength(2);
    });
  });
  it.each(["deadline", "cancel"])("keeps the read lifetime active until material release completes for %s", async reason => {
    await withSourceServer(async f => {
      const input = f.input(f.url + "/ok"); const c = new AbortController(); input.deadlineAtMs = Date.now() + 140;
      const release = async () => { if (reason === "cancel") c.abort(); else await new Promise(r => setTimeout(r, Math.max(0, input.deadlineAtMs - Date.now()) + 20)); };
      await expect(f.read(input, {}, { release }, c.signal)).rejects.toMatchObject({ code: reason === "cancel" ? "SYNC_CANCELLED" : "SYNC_DEADLINE" }); expect(f.released()).toBe(1); expect(f.requests).toHaveLength(1);
    });
  });
  it("rechecks the wall-clock deadline after synchronous private handoff work", async () => {
    await withSourceServer(async f => { const input = f.input(f.url + "/ok"); input.deadlineAtMs = Date.now() + 140; await expect(f.read(input, { onContent: async () => { while (Date.now() <= input.deadlineAtMs + 10) { /* owned synchronous storage boundary */ } } })).rejects.toMatchObject({ code: "SYNC_DEADLINE" }); expect(f.released()).toBe(1); });
  });
  it.each(["gzip", "deflate", "br"])("reads actual %s decompression with an exact raw digest", async encoding => { await withSourceServer(async f => { expect(await f.read(f.url + `/${encoding}-ok`)).toMatchObject({ rawText: "hello", upstream: { rawSha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" } }); }); });
  it("also bounds compressed wire bytes when decoded text is small", async () => { await withSourceServer(async f => { await expect(f.read(f.url + "/gzip-wire")).rejects.toMatchObject({ code: "SYNC_SOURCE_TOO_LARGE" }); expect(f.bytesSent()).toBeGreaterThan(65536); }); });
  it.each(["binding", "budget"])("rejects a cache entry with invalid %s before a conditional request", async change => {
    await withSourceServer(async f => {
      await f.read(f.url + "/cache"); let entry = [...f.cache.values()][0]!;
      const input = f.input(f.url + "/cache"); if (change === "binding") input.source.revision = "2";
      else { const rawText = "x".repeat(70000); const upstream = { ...entry.upstream, rawSha256: createHash("sha256").update(rawText).digest("hex") }; entry = { ...entry, upstream, rawText, contentIdentity: createHash("sha256").update(JSON.stringify([upstream, rawText])).digest("hex") }; }
      expect(await f.read(input, { cache: { get: async () => entry, put: async () => undefined } })).toMatchObject({ status: "read", rawText: "hello" }); expect(f.requests[1]?.headers["if-none-match"]).toBeUndefined();
    });
  });
  it("refuses an ungrounded 304 after the redirect final URL changes", async () => {
    await withSourceServer(async f => { await f.read(f.url + "/changing-redirect"); await expect(f.read(f.url + "/changing-redirect")).rejects.toMatchObject({ code: "SYNC_CACHE_MISS" }); expect(f.requests).toHaveLength(4); expect(f.requests[3]?.headers["if-none-match"]).toBeUndefined(); });
  });
  it("hands full validated content to the private owner for 200 and 304 across new leases", async () => {
    await withSourceServer(async f => {
      const content: SourceValidatedContent[] = []; const onContent = async (value: SourceValidatedContent) => { content.push(value); };
      await f.read(f.url + "/cache", { onContent }, { leaseId: "lease-one" });
      expect(await f.read(f.url + "/cache", { onContent }, { leaseId: "lease-two" })).toMatchObject({ status: "not-modified" });
      expect(content.map(c => c.rawText)).toEqual(["hello", "hello"]); expect(content[1]?.upstream).toEqual(content[0]?.upstream); expect(content[1]?.bindingIdentity).toBe(content[0]?.bindingIdentity);
    });
  });
  it("fails the check and sanitizes private content handoff errors", async () => {
    await withSourceServer(async f => { const error = await f.read(f.url + "/ok", { onContent: async () => { throw new Error("synthetic-handoff-secret/path"); } }).catch(e => e); expect(error).toMatchObject({ code: "SYNC_CONTENT_HANDOFF_FAILED" }); expect(String(error)).not.toContain("synthetic-handoff-secret"); expect(f.released()).toBe(1); expect(f.requests).toHaveLength(1); });
  });
  it("reads exact owned content with a fixed digest and releases the lease", async () => {
    await withSourceServer(async f => {
      expect(await f.read(f.url + "/ok")).toMatchObject({ status: "read", rawText: "hello", upstream: { finalUrl: f.url + "/ok", rawSha256: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" } });
      expect(f.released()).toBe(1); expect(f.requests).toHaveLength(1);
    });
  });
  it.each(["budget", "url"])("rejects invalid wire %s before transport", async kind => {
    await withSourceServer(async f => { const input = f.input(f.url + "/ok"); if (kind === "budget") input.budget.maxSourceBytes = 1; else if (input.source.kind === "url") input.source.url = f.url + "/ok#fragment"; await expect(f.read(input)).rejects.toMatchObject({ code: "SYNC_INPUT_INVALID" }); expect(f.requests).toHaveLength(0); expect(f.released()).toBe(1); });
  });
  it.each(["cancel", "deadline"])("rejects a pre-existing %s before networking", async reason => {
    await withSourceServer(async f => { const input = f.input(f.url + "/ok"); const c = new AbortController(); if (reason === "cancel") c.abort(); else input.deadlineAtMs = Date.now() - 1; await expect(f.read(input, {}, {}, c.signal)).rejects.toMatchObject({ code: reason === "cancel" ? "SYNC_CANCELLED" : "SYNC_DEADLINE" }); expect(f.requests).toHaveLength(0); });
  });
  it.each(["/bad-redirect", "/no-location"])("rejects unsupported redirect %s", async path => { await withSourceServer(async f => { await expect(f.read(f.url + path)).rejects.toMatchObject({ code: "SYNC_REDIRECT_INVALID" }); expect(f.requests).toHaveLength(1); }); });
  it("rejects HTTPS downgrade even when both destinations are approved", async () => { await withSourceServer(async f => { await expect(f.read(f.secureUrl + "/downgrade", {}, { tls: { caPem: f.ca } })).rejects.toMatchObject({ code: "SYNC_REDIRECT_INVALID" }); expect(f.requests).toHaveLength(1); }); });
  it.each([["/large", "SYNC_SOURCE_TOO_LARGE"], ["/gzip", "SYNC_SOURCE_TOO_LARGE"], ["/truncated", "SYNC_READ_FAILED"], ["/encoding", "SYNC_ENCODING_UNSUPPORTED"], ["/invalid-utf8", "SYNC_ENCODING_INVALID"], ["/status", "SYNC_HTTP_STATUS"], ["/not-modified", "SYNC_CACHE_MISS"], ["/loop", "SYNC_REDIRECT_LIMIT"]])("rejects %s with %s", async (path, code) => {
    await withSourceServer(async f => { await expect(f.read(f.url + path)).rejects.toMatchObject({ code }); expect(f.requests.length).toBeGreaterThan(0); expect(f.released()).toBe(1); });
  });
  it("retains credentials only on a same-origin redirect", async () => {
    await withSourceServer(async f => { const result = await f.read(f.url + "/same", {}, { httpHeaders: [{ name: "Authorization", value: "synthetic-token" }] }); expect(result).toMatchObject({ rawText: "hello", upstream: { finalUrl: f.url + "/ok" } }); expect(f.requests.map(r => r.headers.authorization)).toEqual(["synthetic-token", "synthetic-token"]); });
  });
  it("does not forward credentials to a denied redirect origin", async () => {
    await withSourceServer(async f => { await expect(f.read(f.redirectSource, {}, { httpHeaders: [{ name: "Authorization", value: "synthetic-token" }] })).rejects.toMatchObject({ code: "SYNC_NETWORK_DENIED" }); expect(f.requests).toHaveLength(1); expect(f.redirectTargetRequests()).toHaveLength(0); });
  });
  it("strips all source headers on an approved cross-origin redirect", async () => {
    await withSourceServer(async f => {
      const captureNetwork = async () => ({ ...await f.options.captureNetwork(f.redirectSource.source, new AbortController().signal), approveDestination: () => true });
      expect(await f.read(f.redirectSource, { captureNetwork }, { httpHeaders: [{ name: "Authorization", value: "synthetic-token" }, { name: "X-Private", value: "synthetic-private" }] })).toMatchObject({ rawText: "hello", upstream: { finalUrl: f.targetUrl + "/target" } });
      expect(f.redirectTargetRequests()[0]?.headers.authorization).toBeUndefined(); expect(f.redirectTargetRequests()[0]?.headers["x-private"]).toBeUndefined();
    });
  });
  it("reuses 304 only after a fully bound full-content read", async () => {
    await withSourceServer(async f => { const first = await f.read(f.url + "/cache"); const second = await f.read(f.url + "/cache"); expect(second).toEqual({ formatVersion: 1, status: "not-modified", upstream: first.upstream, diagnostics: [] }); expect(f.requests[1]?.headers["if-none-match"]).toBe('"v1"'); expect([...f.cache.values()][0]?.rawText).toBe("hello"); });
  });
  it.each(["source", "material", "network", "policy", "content", "upstream", "headers", "tls"])("does not reuse 304 after %s binding changes", async change => {
    await withSourceServer(async f => {
      await f.read(f.url + "/cache");
      const input = f.input(f.url + "/cache");
      if (change === "source") input.source.revision = "2";
      if (change === "content" || change === "upstream") { const entry = [...f.cache.values()][0]; if (entry) f.cache.set(entry.binding, { ...entry, ...(change === "content" ? { rawText: "tampered" } : { upstream: { ...entry.upstream, finalUrl: f.targetUrl + "/target" } }) }); }
      const captureNetwork = async () => { const c = await f.options.captureNetwork(input.source, new AbortController().signal); return { ...c, ...(change === "material" ? { materialIdentity: "material-v2" } : {}), ...(change === "network" ? { prepared: { ...c.prepared, identity: "network-v2" } } : {}), ...(change === "policy" ? { policyIdentity: "policy-v2" } : {}) }; };
      const lease = change === "headers" ? { httpHeaders: [{ name: "Authorization", value: "changed" }] } : change === "tls" ? { tls: { caPem: f.ca } } : {};
      const result = await f.read(input, { captureNetwork }, lease); expect(result.status).toBe("read"); expect(f.requests[1]?.headers["if-none-match"]).toBeUndefined();
    });
  });
  it("retries only a transient read response within the shared attempt budget", async () => {
    await withSourceServer(async f => { const input = f.input(f.url + "/retry"); input.budget.maxAttempts = 2; expect(await f.read(input)).toMatchObject({ rawText: "hello" }); expect(f.requests).toHaveLength(2); });
  });
  it("does not retry a permanent HTTP failure", async () => {
    await withSourceServer(async f => { const input = f.input(f.url + "/status"); input.budget.maxAttempts = 3; await expect(f.read(input)).rejects.toMatchObject({ code: "SYNC_HTTP_STATUS" }); expect(f.requests).toHaveLength(1); });
  });
  it.each(["cancel", "deadline"])("collects owned connections before %s releases material", async reason => {
    await withSourceServer(async f => {
      const controller = new AbortController(); const input = f.input(f.url + "/slow"); if (reason === "deadline") input.deadlineAtMs = Date.now() + 120;
      let releaseHadActive = false;
      const result = f.read(input, {}, { release: async () => { await new Promise(r => setTimeout(r, 20)); releaseHadActive = f.sockets.size > 0; } }, controller.signal);
      if (reason === "cancel") setTimeout(() => controller.abort(), 100);
      await expect(result).rejects.toMatchObject({ code: reason === "cancel" ? "SYNC_CANCELLED" : "SYNC_DEADLINE" });
      expect(releaseHadActive).toBe(false); const bytes = f.bytesSent(); await new Promise(r => setTimeout(r, 35)); expect(f.bytesSent()).toBe(bytes); expect(f.requests).toHaveLength(1);
    });
  }, 2000);
});

import { describe, expect, it } from "vitest";
import { withSourceServer } from "./fixtures.js";
import { createPrivateKey } from "node:crypto";

describe("source destination and material boundaries", () => {
  it("does not inherit source lease CA trust at a different HTTPS origin", async () => {
    await withSourceServer(async f => {
      const captureNetwork = async () => ({ ...await f.options.captureNetwork(f.input(f.secureUrl).source, new AbortController().signal), approveDestination: () => true });
      expect(await f.read(f.secureUrl + "/ok", { captureNetwork }, { tls: { caPem: f.ca } })).toMatchObject({ rawText: "hello" });
      await expect(f.read(f.secureUrl + "/secure-redirect", { captureNetwork }, { tls: { caPem: f.ca } })).rejects.toMatchObject({ code: "SYNC_TLS_FAILED" });
      expect(f.requests).toHaveLength(2); expect(f.redirectTargetRequests()).toHaveLength(0);
    });
  });
  it("rejects an IP with the wrong DNS family before any request", async () => {
    await withSourceServer(async f => { await expect(f.read(f.url.replace("127.0.0.1", "owned.invalid") + "/ok", { resolveAddresses: async () => [{ address: "127.0.0.1", family: 6 }] })).rejects.toMatchObject({ code: "SYNC_NETWORK_DENIED" }); expect(f.requests).toHaveLength(0); });
  });
  it("does not fall back from the first approved address to a later reachable address", async () => {
    await withSourceServer(async f => {
      expect(await f.read(f.url + "/ok")).toMatchObject({ rawText: "hello" }); let lookups = 0;
      const input = f.input(f.url.replace("127.0.0.1", "owned.invalid") + "/ok");
      await expect(f.read(input, { resolveAddresses: async () => { lookups++; return [{ address: "127.0.0.2", family: 4 }, { address: "127.0.0.1", family: 4 }]; } })).rejects.toMatchObject({ code: "SYNC_READ_FAILED" });
      expect(lookups).toBe(1); expect(f.requests).toHaveLength(1);
    });
  });
  it("keeps a prepared encrypted client identity when the lease only adds CA trust", async () => {
    await withSourceServer(async f => {
      const encrypted = createPrivateKey(f.clientKey).export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "synthetic-passphrase" }).toString();
      const captureNetwork = async () => { const c = await f.options.captureNetwork(f.input(f.secureUrl).source, new AbortController().signal); return { ...c, prepared: { ...f.preparedTLS, resolveForOrigin: (u: URL) => ({ ...f.preparedTLS.resolveForOrigin(u), targetTLS: { ...f.preparedTLS.resolveForOrigin(u).targetTLS, clientCertificates: [f.clientCert], clientPrivateKey: encrypted, clientKeyPassphrase: "synthetic-passphrase" } }) } }; };
      expect(await f.read(f.secureUrl + "/ok", { captureNetwork }, { tls: { caPem: f.ca } })).toMatchObject({ rawText: "hello" }); expect(f.requests[0]?.clientIdentity).toBe(true);
    });
  });
  it("bounds a stalled TLS handshake by connect timeout and collects its socket", async () => {
    await withSourceServer(async f => { const input = f.input(f.blackholeUrl); input.deadlineAtMs = Date.now() + 1400; await expect(f.read(input)).rejects.toMatchObject({ code: "SYNC_CONNECT_TIMEOUT" }); await new Promise(r => setTimeout(r, 20)); expect(f.sockets.size).toBe(0); expect(f.released()).toBe(1); });
  });
  it("never transfers the source mTLS identity to another approved HTTPS origin", async () => {
    await withSourceServer(async f => {
      const captureNetwork = async () => ({ ...await f.options.captureNetwork(f.input(f.secureUrl).source, new AbortController().signal), prepared: f.preparedTLS });
      expect(await f.read(f.secureUrl + "/secure-redirect", { captureNetwork }, { tls: { caPem: f.ca, certPem: f.clientCert, keyPem: f.clientKey } })).toMatchObject({ rawText: "hello", upstream: { finalUrl: f.secureTargetUrl + "/target" } });
      expect(f.requests[0]?.clientIdentity).toBe(true); expect(f.redirectTargetRequests()).toHaveLength(1); expect(f.redirectTargetRequests()[0]?.clientIdentity).toBe(false);
    });
  });
  it.each([{ name: "bad header", value: "x" }, { name: "X-Private", value: "x\r\ny" }])("refuses malformed material header $name", async header => {
    await withSourceServer(async f => { await expect(f.read(f.url + "/ok", {}, { httpHeaders: [header] })).rejects.toMatchObject({ code: "SYNC_MATERIAL_INVALID" }); expect(f.requests).toHaveLength(0); });
  });
  it("refuses ambiguous duplicate authentication material", async () => {
    await withSourceServer(async f => { await expect(f.read(f.url + "/ok", {}, { httpHeaders: [{ name: "Authorization", value: "one" }, { name: "authorization", value: "two" }] })).rejects.toMatchObject({ code: "SYNC_MATERIAL_INVALID" }); expect(f.requests).toHaveLength(0); });
  });
  it.each(["certificate", "key"])("rejects incomplete lease TLS %s without mixing another identity", async part => {
    await withSourceServer(async f => { await expect(f.read(f.secureUrl + "/ok", {}, { tls: { caPem: f.ca, ...(part === "certificate" ? { certPem: f.clientCert } : { keyPem: f.clientKey }) } })).rejects.toMatchObject({ code: "SYNC_MATERIAL_INVALID" }); expect(f.requests).toHaveLength(0); });
  });
  it("sanitizes release failures after the actual connection finishes", async () => {
    await withSourceServer(async f => { const error = await f.read(f.url + "/ok", {}, { release: async () => { throw new Error("synthetic-private-release-path"); } }).catch(e => e); expect(error).toMatchObject({ code: "SYNC_MATERIAL_RELEASE_FAILED" }); expect(String(error)).not.toContain("synthetic-private-release-path"); expect(f.requests).toHaveLength(1); });
  });
  it.each([{ answers: [] }, { answers: [{ address: "not-an-ip", family: 4 as const }] }])("rejects unusable DNS answers $answers", async ({ answers }) => {
    await withSourceServer(async f => { await expect(f.read(f.url.replace("127.0.0.1", "owned.invalid") + "/ok", { resolveAddresses: async () => answers })).rejects.toMatchObject({ code: "SYNC_NETWORK_DENIED" }); expect(f.requests).toHaveLength(0); });
  });
  it("applies total deadline to network preparation and awaits its cancellation", async () => {
    await withSourceServer(async f => { const input = f.input(f.url); input.deadlineAtMs = Date.now() + 80; let ended = false; const captureNetwork = async (_source: typeof input.source, signal: AbortSignal) => { await new Promise<void>(r => { const t = setTimeout(r, 200); signal.addEventListener("abort", () => { clearTimeout(t); ended = true; r(); }, { once: true }); }); return f.options.captureNetwork(input.source, signal); }; await expect(f.read(input, { captureNetwork })).rejects.toMatchObject({ code: "SYNC_DEADLINE" }); expect(ended).toBe(true); expect(f.requests).toHaveLength(0); });
  });
  it("refuses a prepared TLS profile with verification disabled", async () => {
    await withSourceServer(async f => { const captureNetwork = async () => { const c = await f.options.captureNetwork(f.input(f.secureUrl).source, new AbortController().signal); return { ...c, prepared: { ...c.prepared, resolveForOrigin: (u: URL) => ({ ...c.prepared.resolveForOrigin(u), targetTLS: { verify: false, caMode: "append-runtime-defaults" as const, caCertificates: [f.ca], clientCertificates: [] } }) } }; }; await expect(f.read(f.secureUrl + "/ok", { captureNetwork })).rejects.toMatchObject({ code: "SYNC_TLS_POLICY_INVALID" }); expect(f.requests).toHaveLength(0); });
  });
  it("rejects an unapproved actual private destination before connecting", async () => {
    await withSourceServer(async f => { const captureNetwork = async () => ({ ...await f.options.captureNetwork(f.input(f.url).source, new AbortController().signal), approveDestination: () => false }); await expect(f.read(f.url + "/ok", { captureNetwork })).rejects.toMatchObject({ code: "SYNC_NETWORK_DENIED" }); expect(f.requests).toHaveLength(0); });
  });
  it("pins one approved DNS resolution without a second lookup", async () => {
    await withSourceServer(async f => { let lookups = 0; const url = f.url.replace("127.0.0.1", "owned.invalid"); const resolveAddresses = async () => { lookups++; return [{ address: lookups === 1 ? "127.0.0.1" : "127.0.0.2", family: 4 as const }]; }; expect(await f.read(url + "/ok", { resolveAddresses })).toMatchObject({ rawText: "hello" }); expect(lookups).toBe(1); expect(f.requests[0]?.headers.host).toBe(new URL(url).host); });
  });
  it("rejects a mixed DNS answer rather than choosing an allowed address", async () => {
    await withSourceServer(async f => { const captureNetwork = async () => ({ ...await f.options.captureNetwork(f.input(f.url).source, new AbortController().signal), approveDestination: (_u: URL, a: { address: string }) => a.address === "127.0.0.1" }); await expect(f.read(f.url.replace("127.0.0.1", "owned.invalid") + "/ok", { captureNetwork, resolveAddresses: async () => [{ address: "127.0.0.1", family: 4 }, { address: "127.0.0.2", family: 4 }] })).rejects.toMatchObject({ code: "SYNC_NETWORK_DENIED" }); expect(f.requests).toHaveLength(0); });
  });
  it("rejects a proxy route without silently connecting directly", async () => {
    await withSourceServer(async f => { const captureNetwork = async () => { const c = await f.options.captureNetwork(f.input(f.url).source, new AbortController().signal); return { ...c, prepared: { ...c.prepared, resolveForOrigin: (u: URL) => ({ ...c.prepared.resolveForOrigin(u), route: { kind: "proxy" as const, url: f.targetUrl } }) } }; }; await expect(f.read(f.url + "/ok", { captureNetwork })).rejects.toMatchObject({ code: "SYNC_PROXY_UNSUPPORTED" }); expect(f.requests).toHaveLength(0); expect(f.redirectTargetRequests()).toHaveLength(0); });
  });
  it("trusts an injected per-process CA and checks the real HTTPS certificate", async () => {
    await withSourceServer(async f => { expect(await f.read(f.secureUrl + "/ok", {}, { tls: { caPem: f.ca } })).toMatchObject({ rawText: "hello" }); await expect(f.read(f.secureUrl + "/ok")).rejects.toMatchObject({ code: "SYNC_TLS_FAILED" }); });
  });
  it("uses prepared origin-specific TLS without treating an auth reference as a value", async () => {
    await withSourceServer(async f => { const input = f.input(f.secureUrl + "/ok"); if (input.source.kind === "url") input.source.authRef = "synthetic-reference"; const captureNetwork = async () => { const c = await f.options.captureNetwork(input.source, new AbortController().signal); return { ...c, prepared: { ...c.prepared, resolveForOrigin: (u: URL) => ({ ...c.prepared.resolveForOrigin(u), targetTLS: { verify: true, caMode: "append-runtime-defaults" as const, caCertificates: [f.ca], clientCertificates: [] } }) } }; }; await expect(f.read(input, { captureNetwork })).rejects.toMatchObject({ code: "SYNC_MATERIAL_MISSING" }); expect(f.requests).toHaveLength(0); expect(await f.read(input, { captureNetwork }, { httpHeaders: [{ name: "Authorization", value: "synthetic-value" }] })).toMatchObject({ rawText: "hello" }); expect(f.requests[0]?.headers.authorization).toBe("synthetic-value"); });
  });
  it.each(["Host", "Connection", "Proxy-Authorization", "Proxy-Connection", "Keep-Alive", "TE", "Trailer", "Upgrade", "Content-Length", "Transfer-Encoding", "Accept-Encoding", "If-None-Match", "If-Modified-Since"])("refuses transport-owned %s from source material", async name => {
    await withSourceServer(async f => { await expect(f.read(f.url + "/ok", {}, { httpHeaders: [{ name, value: "synthetic-value" }] })).rejects.toMatchObject({ code: "SYNC_MATERIAL_INVALID" }); expect(f.requests).toHaveLength(0); });
  });
  it("sanitizes preparation errors and still releases the material", async () => {
    await withSourceServer(async f => { const error = await f.read(f.url, { captureNetwork: async () => { throw new Error("synthetic-private-secret/native/path"); } }).catch(e => e); expect(error).toMatchObject({ code: "SYNC_NETWORK_FAILED" }); expect(String(error)).not.toContain("synthetic-private-secret"); expect(f.released()).toBe(1); });
  });
});

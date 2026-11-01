import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { createServer, request as forwardRequest } from "node:http";
import { expect, it, vi } from "vitest";
import { CredentialError, createFileNetworkProfileStore, type CredentialScope, type SecretStore, type NetworkConfiguration } from "@apicc/core";
import { createMcpExecutionHost } from "../src/mcp/execution.js";
import { createMcpLocalExecutionHost } from "../src/mcp/localExecution.js";
import { localCaseExecutionFixture, outcome, signal } from "./mcp-execution.fixture.js";
import { oid } from "./mcp-online.fixture.js";

const scope = { workspaceId: oid(1), groupId: oid(2), projectId: oid(3) };
const ref = { id: oid(40), policy: "test-auto" };
const syntheticSecret = "R52_SYNTHETIC_PRIVATE_BEARER";
const certificate = (name: string) => readFileSync(new URL(`../../core/tests/http/fixtures/network/${name}`, import.meta.url));
const tls = () => ({ cert: certificate("synthetic-target-server.pem"), key: certificate("synthetic-target-server.key") });

function syntheticStore() {
  let current = "v1";
  const calls: Array<{ operation: string; scope: CredentialScope; refId: string; expectedVersion?: string }> = [];
  function observe(operation: string, actual: CredentialScope, refId: string, expectedVersion?: string) {
    calls.push({ operation, scope: { ...actual }, refId, ...(expectedVersion === undefined ? {} : { expectedVersion }) });
    if (actual.workspaceId !== scope.workspaceId || actual.groupId !== scope.groupId || actual.projectId !== scope.projectId || refId !== ref.id) throw new CredentialError("CREDENTIAL_UNAVAILABLE", refId);
  }
  const store: SecretStore = {
    async version(actual, reference) { observe("version", actual, reference.id); return current; },
    async resolve(actual, reference, expectedVersion) {
      observe("resolve", actual, reference.id, expectedVersion);
      if (expectedVersion !== current) throw new CredentialError("CREDENTIAL_VERSION_CONFLICT", reference.id);
      return syntheticSecret;
    },
    async status(actual, reference) { observe("status", actual, reference.id); return "available"; },
    async put() { throw new Error("unexpected synthetic secret write"); },
    async remove() { throw new Error("unexpected synthetic secret removal"); },
  };
  return { store, calls, changeVersion() { current = "v2"; } };
}

async function configuredNetwork(f: Awaited<ReturnType<typeof localCaseExecutionFixture>>, configuration: NetworkConfiguration) {
  const networkPrivateRoot = join(f.privateRoot, "network");
  const store = createFileNetworkProfileStore({ privateRoot: networkPrivateRoot });
  const networkScope = { canonicalRoot: realpathSync(f.workspaceRoot), project: scope };
  const loaded = await store.load(networkScope);
  const revision = await store.save(networkScope, configuration, loaded.revision);
  return { networkPrivateRoot, store, networkScope, revision };
}

const caConfiguration = (origin: string, path: string): NetworkConfiguration => ({
  formatVersion: 1, profiles: [{ id: "fixed-ca", name: "Synthetic fixed CA", kind: "direct", targetTlsBindings: [{ origin, tls: { caCertificatePaths: [path] } }] }],
  projectSelection: { kind: "profile", profileId: "fixed-ca" }, environmentSelections: [],
});

// Catch resolving during prepare, losing full scope/version metadata, or never forwarding operator material options.
it("fixed_material_credential_prepares_versions_only_then_resolves_the_bound_version_for_real_http", async () => {
  const f = await localCaseExecutionFixture({ configureProject(project) { project.collections[0]!.apis[0]!.contract.request.auth = { kind: "bearer", token: ref }; } });
  const secrets = syntheticStore();
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, secretStore: secrets.store, credentialPrivateRoot: join(f.privateRoot, "credentials"), networkPrivateRoot: join(f.privateRoot, "network") });
  try {
    const prepared = await outcome(() => host.prepare(f.input, signal()));
    expect(secrets.calls.filter(call => call.operation === "resolve")).toEqual([]);
    expect(f.requests).toEqual([]);
    expect(prepared.error).toBeNull();
    expect(prepared.value?.materialVersions).toEqual({ [ref.id]: "v1" });
    expect(prepared.value?.dataDigest).toEqual(expect.any(String));
    expect(secrets.calls.filter(call => call.operation === "version")).toContainEqual({ operation: "version", scope, refId: ref.id });
    expect(JSON.stringify(prepared.value)).not.toContain(syntheticSecret);
    const ticket = prepared.value!;
    await host.start({ ticketId: ticket.ticketId, intentId: "fixed-credential-v1" }, signal());
    await vi.waitFor(() => expect(f.requests).toEqual([{ method: "GET", url: "/saved-case" }]));
    expect(f.authorizations).toEqual([`Bearer ${syntheticSecret}`]);
    expect(secrets.calls.filter(call => call.operation === "resolve")).toEqual([{ operation: "resolve", scope, refId: ref.id, expectedVersion: "v1" }]);
  } finally { f.release(); await host.close(); await f.close(); }
});

// Observe the actual default factory start completion: MCP start itself only admits an owned background operation.
it("fixed_material_changed_secret_version_rejects_before_real_core_dispatch_without_resolving_new_values", async () => {
  const f = await localCaseExecutionFixture({ configureProject(project) { project.collections[0]!.apis[0]!.contract.request.auth = { kind: "bearer", token: ref }; } });
  const secrets = syntheticStore();
  const adapter = createMcpLocalExecutionHost({ secretStore: secrets.store, networkPrivateRoot: join(f.privateRoot, "network") });
  try {
    const project = await f.source.readProject(f.input.projectId, signal());
    const prepared = await outcome(async () => await adapter.prepare(project.snapshot, f.input.target, undefined, {}, {
      signal: signal(), workspaceRoot: realpathSync(f.workspaceRoot), scope: { workspaceId: project.workspaceId, groupId: project.groupId, projectId: project.snapshot.project.id }, runConfig: {}, profile: "no-script",
    }));
    expect(secrets.calls.filter(call => call.operation === "resolve")).toEqual([]);
    expect(prepared.error).toBeNull();
    secrets.changeVersion();
    const started = await outcome(() => adapter.start(prepared.value!, "00000000-0000-4000-8000-000000000099", signal()));
    expect(f.requests).toEqual([]);
    expect(secrets.calls.filter(call => call.operation === "resolve")).toEqual([]);
    expect(started.error).toMatch(/CREDENTIAL_VERSION_CONFLICT|credential.*version|凭据.*版本/i);
  } finally { await f.close(); }
});

// Catch silently using direct routing or rereading a changed project network selection at start.
it("fixed_material_saved_proxy_configuration_is_not_silently_direct_or_reloaded_at_start", async () => {
  const f = await localCaseExecutionFixture();
  const proxyRequests: string[] = [];
  const proxy = createServer((request, response) => {
    proxyRequests.push(request.url!);
    const url = new URL(request.url!);
    if (url.origin !== f.baseUrl) { response.writeHead(400).end(); return; }
    const headers = { ...request.headers }; delete headers["proxy-authorization"];
    const upstream = forwardRequest(`${f.baseUrl}${url.pathname}${url.search}`, { method: request.method, headers }, result => { response.writeHead(result.statusCode!, result.headers); result.pipe(response); });
    upstream.on("error", () => response.destroy()); request.pipe(upstream);
  });
  await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const net = await configuredNetwork(f, { formatVersion: 1, profiles: [{ id: "fixed-proxy", name: "Synthetic proxy", kind: "proxy", proxyUrl, targetTlsBindings: [] }], projectSelection: { kind: "profile", profileId: "fixed-proxy" }, environmentSelections: [] });
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, networkPrivateRoot: net.networkPrivateRoot, secretStore: syntheticStore().store });
  try {
    const ticket = await host.prepare(f.input, signal());
    expect.soft(ticket.networkRevision).toBe(net.revision);
    expect.soft(ticket.networkSelection).toEqual({ kind: "profile", profileId: "fixed-proxy" });
    expect(f.requests).toEqual([]); expect(proxyRequests).toEqual([]);
    await net.store.save(net.networkScope, { formatVersion: 1, profiles: [], projectSelection: { kind: "direct" }, environmentSelections: [] }, net.revision);
    await host.start({ ticketId: ticket.ticketId, intentId: "fixed-proxy-once" }, signal());
    await vi.waitFor(() => expect(f.requests).toEqual([{ method: "GET", url: "/saved-case" }]));
    expect(proxyRequests).toEqual([`${f.baseUrl}/saved-case`]);
  } finally {
    f.release(); await host.close(); await f.close(); proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
  }
});

// Use the real default adapter and call-through completion; changing the original CA must not affect start.
it("fixed_material_public_ca_is_captured_before_change_and_owned_cancel_closes_the_real_tls_run", async () => {
  const f = await localCaseExecutionFixture({ tls: tls() });
  f.writeDriver(certificate("synthetic-target-ca.pem").toString());
  const net = await configuredNetwork(f, caConfiguration(f.baseUrl, f.materialPath));
  const adapter = createMcpLocalExecutionHost({ secretStore: syntheticStore().store, networkPrivateRoot: net.networkPrivateRoot });
  const observed = vi.spyOn(adapter, "start");
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, localHost: adapter });
  try {
    const ticket = await host.prepare(f.input, signal());
    expect(f.requests).toEqual([]);
    f.writeDriver(certificate("synthetic-client.key").toString());
    const handle = await host.start({ ticketId: ticket.ticketId, intentId: "fixed-ca-once" }, signal());
    await vi.waitFor(() => expect(f.requests.length === 1 || handle.state === "ended").toBe(true));
    expect.soft(f.requests).toEqual([{ method: "GET", url: "/saved-case" }]);
    const actualCompletion = observed.mock.results[0]!.value;
    await host.cancel(handle.runId, signal());
    expect(await actualCompletion).toMatchObject({ kind: "debug", result: { failureKind: "aborted" } });
    await vi.waitFor(() => expect(f.closedBeforeReply).toEqual(["/saved-case"]));
    await host.close(); await host.close();
    expect(f.requests).toHaveLength(1);
  } finally { f.release(); await host.close(); await f.close(); }
});

// A selected CA file must be parsed during prepare; neither arbitrary text nor certificate+private-key is public cert material.
it.each(["invalid", "private_key"])("fixed_material_certificate_%s_is_rejected_before_ticket_or_business", async kind => {
  const f = await localCaseExecutionFixture();
  f.writeDriver(kind === "invalid" ? "not a certificate" : certificate("synthetic-target-ca.pem").toString() + certificate("synthetic-client.key").toString());
  const net = await configuredNetwork(f, caConfiguration("https://127.0.0.1", f.materialPath));
  const host = createMcpExecutionHost({ source: f.source, privateRoot: f.privateRoot, networkPrivateRoot: net.networkPrivateRoot, secretStore: syntheticStore().store });
  try {
    const prepared = await outcome(() => host.prepare(f.input, signal()));
    expect(f.requests).toEqual([]);
    expect.soft(prepared.value).toBeUndefined();
    expect(prepared.error).toEqual(expect.stringMatching(/NETWORK_CERTIFICATE_INVALID|certificate.*invalid|证书/i));
  } finally { await host.close(); await f.close(); }
});

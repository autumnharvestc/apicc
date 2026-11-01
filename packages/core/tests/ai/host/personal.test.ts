import { mkdir, mkdtemp, readdir, readFile, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDefaultAiConfigDocument, type AiConfigDocument, type AiConnection, type AiProviderTemplate } from "../../../src/ai/config.js";
import { createAiConfigRepository, type AiConfigRepository } from "../../../src/ai/host/repository.js";
import { aiPersonalProjectKey, createAiPersonalConfigHost, type AiPersonalProjectLocation } from "../../../src/ai/host/personal.js";
import type { AiSecretBackend } from "../../../src/ai/host/secrets.js";
import { builtinAiProviderCatalog, loadAiProviderCatalog } from "../../../src/ai/catalog.js";
const roots: string[] = [];
// IO fault tests replace only a single read/readdir; all setup and publication still use real disk.
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile), readdir: vi.fn(actual.readdir) };
});
afterEach(async () => { vi.unstubAllGlobals(); vi.mocked(readFile).mockReset(); vi.mocked(readdir).mockReset(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function backend(availability: "available" | "unavailable" = "available"): AiSecretBackend {
  const secrets = new Map<string, { audience: string; value: string }>();
  let nextRef = 0;
  return { availability,
    async put(value, audience) { if (availability !== "available") throw new Error("unavailable"); const ref = `secret-${++nextRef}`; secrets.set(ref, { audience, value }); return ref; },
    async get(ref, audience) { const secret = secrets.get(ref); return availability === "available" && secret?.audience === audience ? secret.value : undefined; },
    async remove(ref, audience) { if (secrets.get(ref)?.audience === audience) secrets.delete(ref); },
  };
}
function connection(): AiConnection { return { id: "personal-a", revision: 1, name: "A", owner: { kind: "personal" }, baseUrl: "https://example.test/gateway/v1", auth: { kind: "bearer" }, protocols: ["openai-chat-completions"], headers: {} }; }
async function fixture(availability: "available" | "unavailable" = "available") {
  const privateRoot = await mkdtemp(join(tmpdir(), "apicc-ai-t4-")); roots.push(privateRoot);
  const repository = createAiConfigRepository({ privateRoot });
  const document = createDefaultAiConfigDocument(); document.connections = [connection()];
  await repository.write(document, 1);
  const secretBackend = backend(availability);
  return { privateRoot, repository, secretBackend, host: createAiPersonalConfigHost({ repository, secretBackend, catalog: [] }) };
}
// Gate only the return after the real repository has already atomically published the document.
function publicationGate(repository: AiConfigRepository) {
  let published!: (document: AiConfigDocument) => void;
  let release!: () => void;
  const committed = new Promise<AiConfigDocument>(resolve => { published = resolve; });
  const returning = new Promise<void>(resolve => { release = resolve; });
  return { committed, release, repository: { ...repository, async write(next: AiConfigDocument, expectedRevision: number) {
    const saved = await repository.write(next, expectedRevision);
    published(saved);
    await returning;
    return saved;
  } } };
}
// Catches secret/header leakage into the renderer snapshot or config file.
it("exposes only credential state while the resolver returns audience-bound bearer headers", async () => {
  const { host, privateRoot } = await fixture();
  await host.setCredential("personal-a", "synthetic-key", "persistent", 2);
  const snapshot = await host.snapshot();
  expect(snapshot.credentials).toEqual([{ connectionId: "personal-a", state: "available" }]);
  expect(JSON.stringify(snapshot)).not.toContain("synthetic-key");
  expect(await readFile(join(privateRoot, "config.v1.json"), "utf8")).not.toContain("synthetic-key");
  expect(await host.credentialResolver.resolve(snapshot.document.connections[0]!)).toEqual({ audience: '[1,"personal-a","https://example.test/gateway/v1","bearer",""]', headers: { Authorization: "Bearer synthetic-key" } });
});
// Catches persisting credentialRef without advancing the connection's own version.
it("advances both connection and document revisions when binding a credential reference", async () => {
  const { host } = await fixture();
  const saved = await host.setCredential("personal-a", "synthetic-key", "persistent", 2);
  expect(saved.revision).toBe(3);
  expect(saved.connections[0]).toMatchObject({ revision: 2, credentialRef: "secret-1" });
});
// Catches treating a display rename as a credential audience change.
it("preserves a credential reference when only the display name changes", async () => {
  const { host } = await fixture();
  const saved = await host.setCredential("personal-a", "synthetic-key", "persistent", 2);
  const renamed = await host.saveConnection({ ...saved.connections[0]!, name: "Renamed" }, saved.revision);
  expect(saved.connections[0]!.revision).toBe(2);
  expect(renamed.connections[0]).toMatchObject({ name: "Renamed", credentialRef: saved.connections[0]!.credentialRef, revision: 3 });
  expect((await host.credentialResolver.resolve(renamed.connections[0]!)).headers).toEqual({ Authorization: "Bearer synthetic-key" });
});
// Catches key reuse across any of the security audience fields.
it.each([
  { name: "gateway root", change: { baseUrl: "https://example.test/other/v1" } },
  { name: "auth kind", change: { auth: { kind: "api-key", header: "X-Token" } } },
  { name: "connection identity", change: { id: "personal-b" } },
])("does not resolve an old credential after changing $name", async ({ change }) => {
  const { host } = await fixture();
  const saved = await host.setCredential("personal-a", "synthetic-key", "persistent", 2);
  const changed = { ...saved.connections[0]!, ...change } as AiConnection;
  const updated = await host.saveConnection(changed, saved.revision);
  const current = updated.connections.find(c => c.id === changed.id)!;
  expect(current.credentialRef).toBeUndefined();
  await expect(host.credentialResolver.resolve({ ...changed, credentialRef: saved.connections[0]!.credentialRef })).rejects.toMatchObject({ code: "credential-missing" });
});
// Catches implicit plaintext fallback and accidental disk writes on rejected persistence.
it("unavailable_secure_backend_never_creates_plaintext_file", async () => {
  const { host, privateRoot, repository } = await fixture("unavailable");
  const before = await repository.read();
  await expect(host.setCredential("personal-a", "synthetic-key", "persistent", 2)).rejects.toMatchObject({ code: "secure-backend-unavailable" });
  expect(await repository.read()).toEqual(before);
  expect(await readdir(privateRoot)).toEqual(["config.v1.json"]);
  expect(await readFile(join(privateRoot, "config.v1.json"), "utf8")).not.toContain("synthetic-key");
});
// Catches falling back to disk or losing an explicitly selected temporary secret.
it("supports explicitly session-only credentials without persisting a reference or value", async () => {
  const { host, privateRoot, repository } = await fixture("unavailable");
  const before = await repository.read();
  const after = await host.setCredential("personal-a", "temporary-key", "session-only", 2);
  expect(after).toEqual(before);
  expect((await host.snapshot()).credentials).toEqual([{ connectionId: "personal-a", state: "session-only" }]);
  expect((await host.credentialResolver.resolve(after.connections[0]!)).headers).toEqual({ Authorization: "Bearer temporary-key" });
  expect(await readFile(join(privateRoot, "config.v1.json"), "utf8")).not.toContain("temporary-key");
  const restarted = createAiPersonalConfigHost({ repository, secretBackend: backend("unavailable"), catalog: [] });
  expect((await restarted.snapshot()).credentials).toEqual([{ connectionId: "personal-a", state: "missing" }]);
});
// Catches serializing backend errors or conflating absent credentials with failed secure storage.
it("reports an unavailable backend as state without leaking its exception", async () => {
  const { repository } = await fixture();
  const document = await repository.read(); document.connections[0]!.credentialRef = "opaque-ref";
  await repository.write(document, 2);
  const secretBackend: AiSecretBackend = { availability: "available", async get() { throw new Error("synthetic-secret-in-error"); }, async put() { throw new Error("synthetic-secret-in-error"); }, async remove() {} };
  const host = createAiPersonalConfigHost({ repository, secretBackend, catalog: [] });
  const snapshot = await host.snapshot();
  expect(snapshot.credentials).toEqual([{ connectionId: "personal-a", state: "unavailable" }]);
  expect(JSON.stringify(snapshot)).not.toContain("synthetic-secret-in-error");
});
// Catches allowing caller-controlled refs to authorize a different stored secret.
it("discards injected credential references when adding a connection", async () => {
  const { host } = await fixture();
  const saved = await host.saveConnection({ ...connection(), id: "new-id", credentialRef: "foreign-ref" }, 2);
  expect(saved.connections.find(c => c.id === "new-id")).toMatchObject({ revision: 1 });
  expect(saved.connections.find(c => c.id === "new-id")!.credentialRef).toBeUndefined();
});
// Catches returning a secret for a stale caller snapshot after the authoritative URL changes.
it("rejects a stale caller connection after the saved audience changes", async () => {
  const { host } = await fixture();
  const saved = await host.setCredential("personal-a", "synthetic-key", "persistent", 2);
  await host.saveConnection({ ...saved.connections[0]!, baseUrl: "https://other.test/v1" }, saved.revision);
  await expect(host.credentialResolver.resolve(saved.connections[0]!)).rejects.toMatchObject({ code: "credential-audience-mismatch" });
});
// Catches treating API key header casing as a new audience, or returning bearer auth for API key connections.
it("keeps the reference across API key header casing changes and returns only its declared header", async () => {
  const { host } = await fixture();
  const configured = await host.saveConnection({ ...connection(), auth: { kind: "api-key", header: "X-Token" } }, 2);
  const keyed = await host.setCredential("personal-a", "synthetic-key", "persistent", configured.revision);
  const renamed = await host.saveConnection({ ...keyed.connections[0]!, auth: { kind: "api-key", header: "x-token" } }, keyed.revision);
  expect(renamed.connections[0]!.credentialRef).toBe(keyed.connections[0]!.credentialRef);
  expect(await host.credentialResolver.resolve(renamed.connections[0]!)).toEqual({ audience: '[1,"personal-a","https://example.test/gateway/v1","api-key","x-token"]', headers: { "x-token": "synthetic-key" } });
});
// Catches a save implicitly invoking model discovery or a connection test.
it("saves a connection without contacting the network", async () => {
  const { host } = await fixture();
  const network = vi.fn(async () => { throw new Error("network must not be used"); });
  vi.stubGlobal("fetch", network);
  const saved = await host.saveConnection({ ...connection(), name: "Offline edit" }, 2);
  expect(saved.connections[0]!.name).toBe("Offline edit");
  expect(network).not.toHaveBeenCalled();
});
// Catches resolving a credential for a connection absent from this personal repository.
it("rejects a resolver connection that does not belong to the saved document", async () => {
  const { host } = await fixture();
  await expect(host.credentialResolver.resolve({ ...connection(), id: "foreign" })).rejects.toMatchObject({ code: "credential-audience-mismatch" });
});
// Catches attempting secret lookup or generating an Authorization header for explicit local no-auth.
it("returns no secret headers for an explicit local no-auth connection", async () => {
  const { host } = await fixture();
  const saved = await host.saveConnection({ ...connection(), baseUrl: "http://localhost:12345/v1", insecureLocalTest: true, auth: { kind: "none" } }, 2);
  expect(await host.credentialResolver.resolve(saved.connections[0]!)).toEqual({ audience: '[1,"personal-a","http://localhost:12345/v1","none",""]', headers: {} });
});
// Catches storing an unused secret on a no-auth connection.
it("rejects binding a credential to a no-auth connection", async () => {
  const { host } = await fixture();
  const saved = await host.saveConnection({ ...connection(), baseUrl: "http://localhost:12345/v1", insecureLocalTest: true, auth: { kind: "none" } }, 2);
  await expect(host.setCredential("personal-a", "synthetic-key", "persistent", saved.revision)).rejects.toMatchObject({ code: "credential-not-required" });
});
// Catches treating an unknown runtime persistence mode as implicit persistent approval.
it("rejects an unsupported secret persistence mode", async () => {
  const { host, repository } = await fixture();
  await expect(host.setCredential("personal-a", "synthetic-key", "plaintext" as any, 2)).rejects.toMatchObject({ code: "invalid-secret-mode" });
  expect((await repository.read()).revision).toBe(2);
});
// Catches raw schema errors escaping the Node host boundary during configuration edits.
it("returns a sanitized configuration error for invalid connection fields", async () => {
  const { host } = await fixture();
  await expect(host.saveConnection({ ...connection(), apiKey: "synthetic-secret" } as any, 2)).rejects.toMatchObject({ code: "invalid-configuration" });
});
// Catches accepting empty/control-character values before they reach secure storage or HTTP headers.
it.each(["", "bad\r\nX-Injected: yes"])("rejects invalid credential values %j without saving configuration", async value => {
  const { host, repository } = await fixture();
  await expect(host.setCredential("personal-a", value, "persistent", 2)).rejects.toMatchObject({ code: "invalid-credential" });
  expect((await repository.read()).revision).toBe(2);
});
// Catches a stale request mutating session-only state outside repository CAS.
it("rejects a stale session-only credential operation", async () => {
  const { host } = await fixture("unavailable");
  await expect(host.setCredential("personal-a", "synthetic-key", "session-only", 1)).rejects.toMatchObject({ code: "revision-conflict" });
  expect((await host.snapshot()).credentials).toEqual([{ connectionId: "personal-a", state: "missing" }]);
});
// Catches an uncaught TypeError when a host asks to bind an unknown connection.
it("rejects credential binding for a missing connection", async () => {
  const { host } = await fixture();
  await expect(host.setCredential("missing", "synthetic-key", "persistent", 2)).rejects.toMatchObject({ code: "connection-missing" });
});
// Catches leaking secure-backend exception text into host errors.
it("sanitizes credential persistence failures without changing the document", async () => {
  const { host, repository, secretBackend } = await fixture();
  secretBackend.put = async () => { throw new Error("synthetic-sensitive-backend-detail"); };
  await expect(host.setCredential("personal-a", "synthetic-key", "persistent", 2)).rejects.toMatchObject({ code: "secure-backend-unavailable", message: expect.not.stringContaining("synthetic-sensitive") });
  expect((await repository.read()).revision).toBe(2);
});
// Catches reactivating a previously invalidated temporary secret after URL edits are reverted.
it("does not revive a session credential when a changed audience is later restored", async () => {
  const { host } = await fixture("unavailable");
  await host.setCredential("personal-a", "temporary-key", "session-only", 2);
  const changed = await host.saveConnection({ ...connection(), baseUrl: "https://other.test/v1" }, 2);
  const restored = await host.saveConnection({ ...changed.connections[0]!, baseUrl: "https://example.test/gateway/v1" }, changed.revision);
  await expect(host.credentialResolver.resolve(restored.connections[0]!)).rejects.toMatchObject({ code: "credential-missing" });
});
// I1: catches another host reviving a session after an observed intermediate audience mismatch.
it("invalidates a session after another host changes and restores an observed address", async () => {
  const { host, repository, secretBackend } = await fixture("unavailable");
  const other = createAiPersonalConfigHost({ repository, secretBackend, catalog: [] });
  await host.setCredential("personal-a", "temporary-key", "session-only", 2);
  const changed = await other.saveConnection({ ...connection(), baseUrl: "https://other.test/v1" }, 2);
  expect((await host.snapshot()).credentials).toEqual([{ connectionId: "personal-a", state: "missing" }]);
  const restored = await other.saveConnection({ ...changed.connections[0]!, baseUrl: "https://example.test/gateway/v1" }, changed.revision);
  await expect(host.credentialResolver.resolve(restored.connections[0]!)).rejects.toMatchObject({ code: "credential-missing" });
});
// I1: catches URL ABA even when the session host never observes the intermediate state.
it("invalidates a session after another host changes and restores an unobserved address", async () => {
  const { host, repository, secretBackend } = await fixture("unavailable");
  const other = createAiPersonalConfigHost({ repository, secretBackend, catalog: [] });
  await host.setCredential("personal-a", "temporary-key", "session-only", 2);
  const changed = await other.saveConnection({ ...connection(), baseUrl: "https://other.test/v1" }, 2);
  const restored = await other.saveConnection({ ...changed.connections[0]!, baseUrl: "https://example.test/gateway/v1" }, changed.revision);
  await expect(host.credentialResolver.resolve(restored.connections[0]!)).rejects.toMatchObject({ code: "credential-missing" });
});
// I1: catches auth ABA despite the final API root and auth returning to the original audience.
it("invalidates a session after another host changes and restores unobserved auth", async () => {
  const { host, repository, secretBackend } = await fixture("unavailable");
  const other = createAiPersonalConfigHost({ repository, secretBackend, catalog: [] });
  await host.setCredential("personal-a", "temporary-key", "session-only", 2);
  const changed = await other.saveConnection({ ...connection(), auth: { kind: "api-key", header: "X-Token" } }, 2);
  const restored = await other.saveConnection({ ...changed.connections[0]!, auth: { kind: "bearer" } }, changed.revision);
  await expect(host.credentialResolver.resolve(restored.connections[0]!)).rejects.toMatchObject({ code: "credential-missing" });
});
// I1/R20: catches carrying an already-stale authorization forward during a same-host rename.
it("does not revive a stale session by renaming after another host performs address ABA", async () => {
  const { host, repository, secretBackend } = await fixture("unavailable");
  const other = createAiPersonalConfigHost({ repository, secretBackend, catalog: [] });
  await host.setCredential("personal-a", "temporary-key", "session-only", 2);
  const changed = await other.saveConnection({ ...connection(), baseUrl: "https://other.test/v1" }, 2);
  const restored = await other.saveConnection({ ...changed.connections[0]!, baseUrl: "https://example.test/gateway/v1" }, changed.revision);
  const renamed = await host.saveConnection({ ...restored.connections[0]!, name: "Rename cannot reauthorize" }, restored.revision);
  await expect(host.credentialResolver.resolve(renamed.connections[0]!)).rejects.toMatchObject({ code: "credential-missing" });
});
// R20: catches preserving RAM authorization across an unknown edit by another host.
it("conservatively invalidates a session when another host renames the connection", async () => {
  const { host, repository, secretBackend } = await fixture("unavailable");
  const other = createAiPersonalConfigHost({ repository, secretBackend, catalog: [] });
  await host.setCredential("personal-a", "temporary-key", "session-only", 2);
  const renamed = await other.saveConnection({ ...connection(), name: "Other host edit" }, 2);
  await expect(host.credentialResolver.resolve(renamed.connections[0]!)).rejects.toMatchObject({ code: "credential-missing" });
});
// Retained behavior: a known current session survives a same-host audience-preserving rename.
it("preserves a current session across its own host rename", async () => {
  const { host } = await fixture("unavailable");
  await host.setCredential("personal-a", "temporary-key", "session-only", 2);
  const renamed = await host.saveConnection({ ...connection(), name: "Same host edit" }, 2);
  expect((await host.credentialResolver.resolve(renamed.connections[0]!)).headers).toEqual({ Authorization: "Bearer temporary-key" });
});
// Retained behavior: explicit re-entry binds a new session to the latest authoritative generation.
it("allows explicit session rebinding after another host changes and restores the address", async () => {
  const { host, repository, secretBackend } = await fixture("unavailable");
  const other = createAiPersonalConfigHost({ repository, secretBackend, catalog: [] });
  await host.setCredential("personal-a", "old-temporary-key", "session-only", 2);
  const changed = await other.saveConnection({ ...connection(), baseUrl: "https://other.test/v1" }, 2);
  const restored = await other.saveConnection({ ...changed.connections[0]!, baseUrl: "https://example.test/gateway/v1" }, changed.revision);
  await host.setCredential("personal-a", "new-temporary-key", "session-only", restored.revision);
  expect((await host.credentialResolver.resolve(restored.connections[0]!)).headers).toEqual({ Authorization: "Bearer new-temporary-key" });
});
// N1: catches a rename's stale carry overwriting a later successfully bound current-generation session.
it("keeps a later explicit session rebind when an earlier rename returns after publication", async () => {
  const { repository, secretBackend } = await fixture();
  const gate = publicationGate(repository);
  const host = createAiPersonalConfigHost({ repository: gate.repository, secretBackend, catalog: [] });
  await host.setCredential("personal-a", "old-session-key", "session-only", 2);
  const earlier = host.saveConnection({ ...connection(), name: "Renamed" }, 2);
  try {
    const committed = await gate.committed;
    await host.setCredential("personal-a", "new-session-key", "session-only", committed.revision);
    expect((await host.credentialResolver.resolve(committed.connections[0]!)).headers).toEqual({ Authorization: "Bearer new-session-key" });
    gate.release(); await earlier;
    expect((await host.credentialResolver.resolve(committed.connections[0]!)).headers).toEqual({ Authorization: "Bearer new-session-key" });
  } finally { gate.release(); await earlier; }
});
// N1-related deletion: catches a committed address edit deleting a later explicit binding for its new audience.
it("keeps a later explicit session rebind when an earlier audience change returns after publication", async () => {
  const { repository, secretBackend } = await fixture();
  const gate = publicationGate(repository);
  const host = createAiPersonalConfigHost({ repository: gate.repository, secretBackend, catalog: [] });
  await host.setCredential("personal-a", "old-session-key", "session-only", 2);
  const earlier = host.saveConnection({ ...connection(), baseUrl: "https://new-audience.test/v1" }, 2);
  try {
    const committed = await gate.committed;
    await host.setCredential("personal-a", "new-session-key", "session-only", committed.revision);
    expect((await host.credentialResolver.resolve(committed.connections[0]!)).headers).toEqual({ Authorization: "Bearer new-session-key" });
    gate.release(); await earlier;
    expect((await host.credentialResolver.resolve(committed.connections[0]!)).headers).toEqual({ Authorization: "Bearer new-session-key" });
  } finally { gate.release(); await earlier; }
});
// Root-confirmed existing analogue: catches an older persistent setter deleting a newer RAM selection.
it("keeps a later explicit session rebind when an earlier persistent setter returns after publication", async () => {
  const { repository, secretBackend } = await fixture();
  const gate = publicationGate(repository);
  const host = createAiPersonalConfigHost({ repository: gate.repository, secretBackend, catalog: [] });
  await host.setCredential("personal-a", "old-session-key", "session-only", 2);
  const earlier = host.setCredential("personal-a", "earlier-persistent-key", "persistent", 2);
  try {
    const committed = await gate.committed;
    await host.setCredential("personal-a", "new-session-key", "session-only", committed.revision);
    expect((await host.credentialResolver.resolve(committed.connections[0]!)).headers).toEqual({ Authorization: "Bearer new-session-key" });
    gate.release(); await earlier;
    expect((await host.credentialResolver.resolve(committed.connections[0]!)).headers).toEqual({ Authorization: "Bearer new-session-key" });
  } finally { gate.release(); await earlier; }
});
// Catches an old temporary override masking a newly persisted credential.
it("uses a newly persisted credential after a session-only credential", async () => {
  const { host } = await fixture();
  await host.setCredential("personal-a", "temporary-key", "session-only", 2);
  const saved = await host.setCredential("personal-a", "persistent-key", "persistent", 2);
  expect((await host.credentialResolver.resolve(saved.connections[0]!)).headers).toEqual({ Authorization: "Bearer persistent-key" });
});
// Catches leaving an unreachable old secret in storage after successful replacement.
it("removes the previous secure reference only after the replacement is saved", async () => {
  const { host, secretBackend } = await fixture();
  const first = await host.setCredential("personal-a", "old-key", "persistent", 2);
  await host.setCredential("personal-a", "new-key", "persistent", first.revision);
  expect(await secretBackend.get(first.connections[0]!.credentialRef!, '[1,"personal-a","https://example.test/gateway/v1","bearer",""]')).toBeUndefined();
});
// Catches retaining an unreachable secure reference after an address/auth audience edit commits.
it("removes the old secure reference after saving a changed audience", async () => {
  const { host, secretBackend } = await fixture();
  const first = await host.setCredential("personal-a", "old-key", "persistent", 2);
  await host.saveConnection({ ...first.connections[0]!, baseUrl: "https://other.test/v1" }, first.revision);
  expect(await secretBackend.get(first.connections[0]!.credentialRef!, '[1,"personal-a","https://example.test/gateway/v1","bearer",""]')).toBeUndefined();
});
// Catches an orphan new key after another writer wins between backend put and repository CAS.
it("removes a newly allocated secret when the configuration CAS fails", async () => {
  const { host, repository, secretBackend } = await fixture();
  const put = secretBackend.put.bind(secretBackend);
  secretBackend.put = async (...args) => {
    const ref = await put(...args);
    await repository.write(await repository.read(), 2);
    return ref;
  };
  await expect(host.setCredential("personal-a", "new-key", "persistent", 2)).rejects.toMatchObject({ code: "revision-conflict" });
  expect(await secretBackend.get("secret-1", '[1,"personal-a","https://example.test/gateway/v1","bearer",""]')).toBeUndefined();
  expect((await repository.read()).connections[0]!.credentialRef).toBeUndefined();
});
// Catches silently passing unsafe values from a corrupt secure store into protocol headers.
it("refuses control characters returned from the secure backend", async () => {
  const { host, secretBackend } = await fixture();
  const saved = await host.setCredential("personal-a", "synthetic-key", "persistent", 2);
  secretBackend.get = async () => "bad\r\nX-Injected: yes";
  await expect(host.credentialResolver.resolve(saved.connections[0]!)).rejects.toMatchObject({ code: "invalid-credential" });
});
function provider(baseUrl = "https://example.test/v1"): AiProviderTemplate {
  return { formatVersion: 1, id: "synthetic-provider", revision: 1, name: "Synthetic", baseUrl, protocols: ["openai-chat-completions"], defaultProtocol: "openai-chat-completions", auth: { kind: "bearer" }, headers: {}, modelDiscovery: false };
}
// Catches hidden application of an import, missing conflicts, and silent replacement before confirmation.
it("previews template differences without writing and requires explicit conflict confirmation", async () => {
  const { repository, privateRoot } = await fixture();
  const host = createAiPersonalConfigHost({ repository, secretBackend: backend(), catalog: [provider()] });
  const file = { file: "custom.json", document: { formatVersion: 1, providers: [provider("https://new.test/v1")] } };
  const preview = await host.previewCatalogImport(file);
  expect(preview.diff).toEqual({ added: [], updated: ["synthetic-provider"], removed: [] });
  expect(preview.conflicts).toEqual(["synthetic-provider"]);
  expect(await readdir(privateRoot)).toEqual(["config.v1.json"]);
  await expect(host.applyCatalogImport(file)).rejects.toMatchObject({ code: "catalog-conflict" });
  expect(await readdir(privateRoot)).toEqual(["config.v1.json"]);
  const applied = await host.applyCatalogImport(file, { confirmConflicts: true });
  expect(applied.catalog[0]!.baseUrl).toBe("https://new.test/v1");
  expect(JSON.parse(await readFile(join(privateRoot, "providers.d", "custom.json"), "utf8"))).toEqual(file.document);
});
// Catches invalid override files replacing the last valid catalog or hiding the real relative filename.
it("keeps the last valid catalog and names bad JSON files and fields on reload", async () => {
  const { repository, privateRoot } = await fixture();
  const host = createAiPersonalConfigHost({ repository, secretBackend: backend(), catalog: [provider()] });
  const directory = join(privateRoot, "providers.d"); await mkdir(directory);
  await writeFile(join(directory, "valid.json"), JSON.stringify({ formatVersion: 1, providers: [provider("https://override.test/v1")] }));
  const first = await host.reloadCatalog();
  expect(first.catalog[0]!.baseUrl).toBe("https://override.test/v1");
  await writeFile(join(directory, "broken.json"), "{broken");
  const broken = await host.reloadCatalog();
  expect(broken.catalog).toEqual(first.catalog);
  expect(broken.errors).toContainEqual(expect.objectContaining({ file: "providers.d/broken.json", field: expect.any(String) }));
  await unlink(join(directory, "broken.json"));
  await writeFile(join(directory, "valid.json"), JSON.stringify({ formatVersion: 1, providers: [{ ...provider(), defaultProtocol: "execute-js" }] }));
  const invalid = await host.reloadCatalog();
  expect(invalid.catalog).toEqual(first.catalog);
  expect(invalid.errors).toContainEqual(expect.objectContaining({ file: "providers.d/valid.json", field: "providers.0.defaultProtocol" }));
});
// I2: catches raw per-file EACCES/ENOENT escaping instead of last-valid catalog + safe diagnostics.
it.each([
  { name: "permission denied", code: "EACCES" },
  { name: "file disappears after directory enumeration", code: "ENOENT" },
])("keeps the last valid catalog when a template read fails: $name", async ({ code }) => {
  const { repository, privateRoot } = await fixture();
  const host = createAiPersonalConfigHost({ repository, secretBackend: backend(), catalog: [provider()] });
  const directory = join(privateRoot, "providers.d"); await mkdir(directory);
  const file = join(directory, "valid.json");
  await writeFile(file, JSON.stringify({ formatVersion: 1, providers: [provider("https://override.test/v1")] }));
  const valid = await host.reloadCatalog();
  vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error("raw-sensitive-IO-detail"), { code, path: file }));
  const failed = await host.reloadCatalog();
  expect(failed.catalog).toEqual(valid.catalog);
  expect(failed.errors).toEqual([{ file: "providers.d/valid.json", field: "read", message: expect.any(String) }]);
  expect(failed.diff).toEqual({ added: [], updated: [], removed: [] });
  expect(JSON.stringify(failed)).not.toContain("raw-sensitive-IO-detail");
  expect(JSON.stringify(failed)).not.toContain(privateRoot);
  expect(JSON.stringify(failed)).not.toContain(code);
});
// I2: catches a directory read failure being thrown or silently treated as an empty catalog.
it("keeps the last valid catalog with a safe directory diagnostic when enumeration fails", async () => {
  const { repository, privateRoot } = await fixture();
  const host = createAiPersonalConfigHost({ repository, secretBackend: backend(), catalog: [provider()] });
  const directory = join(privateRoot, "providers.d"); await mkdir(directory);
  await writeFile(join(directory, "valid.json"), JSON.stringify({ formatVersion: 1, providers: [provider("https://override.test/v1")] }));
  const valid = await host.reloadCatalog();
  vi.mocked(readdir).mockRejectedValueOnce(Object.assign(new Error("raw-directory-IO-detail"), { code: "EACCES", path: directory }));
  const failed = await host.reloadCatalog();
  expect(failed.catalog).toEqual(valid.catalog);
  expect(failed.errors).toEqual([{ file: "providers.d", field: "read", message: expect.any(String) }]);
  expect(failed.diff).toEqual({ added: [], updated: [], removed: [] });
  expect(JSON.stringify(failed)).not.toContain("raw-directory-IO-detail");
  expect(JSON.stringify(failed)).not.toContain(privateRoot);
});
// I2: catches a proposed replacement masking an unreadable current file during preview.
it("does not preview an import as valid when its current template file is unreadable", async () => {
  const { repository, privateRoot } = await fixture();
  const host = createAiPersonalConfigHost({ repository, secretBackend: backend(), catalog: [provider()] });
  const directory = join(privateRoot, "providers.d"); await mkdir(directory);
  await writeFile(join(directory, "valid.json"), JSON.stringify({ formatVersion: 1, providers: [provider("https://override.test/v1")] }));
  const valid = await host.reloadCatalog();
  vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error("raw-file-read-detail"), { code: "EACCES" }));
  const preview = await host.previewCatalogImport({ file: "valid.json", document: { formatVersion: 1, providers: [provider("https://proposed.test/v1")] } });
  expect(preview.catalog).toEqual(valid.catalog);
  expect(preview.errors).toContainEqual(expect.objectContaining({ file: "providers.d/valid.json", field: "read" }));
  expect(preview.diff).toEqual({ added: [], updated: [], removed: [] });
  expect(await readdir(directory)).toEqual(["valid.json"]);
});
// I2: catches writing a replacement as if an unreadable current template were a valid merge base.
it("refuses to apply an import when the current template file cannot be read", async () => {
  const { repository, privateRoot } = await fixture();
  const host = createAiPersonalConfigHost({ repository, secretBackend: backend(), catalog: [provider()] });
  const directory = join(privateRoot, "providers.d"); await mkdir(directory);
  const file = join(directory, "valid.json");
  const original = JSON.stringify({ formatVersion: 1, providers: [provider("https://override.test/v1")] });
  await writeFile(file, original); await host.reloadCatalog();
  vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error("raw-file-read-detail"), { code: "EACCES" }));
  await expect(host.applyCatalogImport({ file: "valid.json", document: { formatVersion: 1, providers: [provider("https://proposed.test/v1")] } }, { confirmConflicts: true })).rejects.toMatchObject({ code: "invalid-catalog" });
  expect(await readFile(file, "utf8")).toBe(original);
  expect(await readdir(directory)).toEqual(["valid.json"]);
});
// Catches public result mutation corrupting the host's last-valid catalog fallback.
it("keeps its last valid catalog independent of returned objects", async () => {
  const { repository, privateRoot } = await fixture();
  const host = createAiPersonalConfigHost({ repository, secretBackend: backend(), catalog: [provider()] });
  const valid = await host.reloadCatalog(); valid.catalog[0]!.baseUrl = "https://caller-mutated.test/v1";
  await mkdir(join(privateRoot, "providers.d"));
  await writeFile(join(privateRoot, "providers.d", "broken.json"), "{broken");
  expect((await host.reloadCatalog()).catalog[0]!.baseUrl).toBe("https://example.test/v1");
});
// Catches retaining the input catalog as a live mutable backing store.
it("copies the supplied catalog at host construction", async () => {
  const { repository } = await fixture();
  const catalog = [provider()];
  const host = createAiPersonalConfigHost({ repository, secretBackend: backend(), catalog });
  catalog[0]!.baseUrl = "https://caller-mutated.test/v1";
  expect((await host.reloadCatalog()).catalog[0]!.baseUrl).toBe("https://example.test/v1");
});
// Catches live template references drifting or deleting saved connection endpoints.
it("leaves copied connections unchanged when a template is updated or removed", async () => {
  const { repository, host, privateRoot } = await fixture();
  const before = await repository.read();
  await host.applyCatalogImport({ file: "new.json", document: { formatVersion: 1, providers: [provider("https://different.test/v1")] } });
  expect((await host.reloadCatalog()).catalog).toHaveLength(1);
  await unlink(join(privateRoot, "providers.d", "new.json"));
  expect((await host.reloadCatalog()).catalog).toEqual([]);
  expect(await repository.read()).toEqual(before);
});
// Catches treating directories or unrelated files as executable/importable catalog data.
it("reads only direct JSON template files and validates the T1 builtin catalog", async () => {
  const { repository, privateRoot } = await fixture();
  const catalog = loadAiProviderCatalog(builtinAiProviderCatalog, []).catalog;
  const host = createAiPersonalConfigHost({ repository, secretBackend: backend(), catalog });
  await mkdir(join(privateRoot, "providers.d", "ignored.json"), { recursive: true });
  await writeFile(join(privateRoot, "providers.d", "ignored.js"), "throw new Error('never execute')");
  expect(await repository.readProviderFiles()).toEqual([]);
  expect((await host.reloadCatalog()).catalog.map(p => p.id)).toEqual(["openai", "anthropic"]);
});
// Catches path traversal or non-schema imports writing outside the provider allowlist.
it.each([
  { file: "../escape.json", document: { formatVersion: 1, providers: [provider()] } },
  { file: "safe.json", document: { formatVersion: 1, providers: [{ ...provider(), script: "arbitrary" }] } },
])("rejects invalid template import $file without disk mutation", async file => {
  const { host, privateRoot } = await fixture();
  await expect(host.applyCatalogImport(file)).rejects.toMatchObject({ code: "invalid-catalog" });
  expect(await readdir(privateRoot)).toEqual(["config.v1.json"]);
});
const localLocation: AiPersonalProjectLocation = { kind: "local", root: join(tmpdir(), "apicc-ai-project-key", "workspace"), workspaceId: "w", groupId: "g", projectId: "p" };
const onlineLocation: AiPersonalProjectLocation = { kind: "online", serverUrl: "https://server.test/api", memberId: "member-a", workspaceId: "w", groupId: "g", projectId: "p" };
// Catches using random editor bindings/revisions in the stable preference identity.
it("normalizes a full local location and ignores edit revision or binding identity", () => {
  const key = aiPersonalProjectKey(localLocation);
  expect(aiPersonalProjectKey({ ...localLocation, root: `${localLocation.root}/../other/../workspace/`, revision: 999, bindingId: "random-binding" } as any)).toBe(key);
  expect(key.length).toBeLessThanOrEqual(256);
});
// Windows-specific path syntax/case behavior is not a universal absolute-root fixture.
it.skipIf(process.platform !== "win32")("normalizes Windows drive case and path separators", () => {
  const windows = { ...localLocation, root: "C:/synthetic/workspace" };
  expect(aiPersonalProjectKey({ ...windows, root: "c:\\synthetic\\other\\..\\workspace\\" })).toBe(aiPersonalProjectKey(windows));
});
// Catches pref collisions between roots/projects, online users, or complete server project locations.
it.each([
  { name: "local root", left: localLocation, right: { ...localLocation, root: join(tmpdir(), "apicc-ai-project-key", "other-workspace") } },
  { name: "local workspace", left: localLocation, right: { ...localLocation, workspaceId: "w2" } },
  { name: "local group", left: localLocation, right: { ...localLocation, groupId: "g2" } },
  { name: "local project", left: localLocation, right: { ...localLocation, projectId: "p2" } },
  { name: "server root path", left: onlineLocation, right: { ...onlineLocation, serverUrl: "https://server.test/other-api" } },
  { name: "member", left: onlineLocation, right: { ...onlineLocation, memberId: "member-b" } },
  { name: "online workspace", left: onlineLocation, right: { ...onlineLocation, workspaceId: "w2" } },
  { name: "online group", left: onlineLocation, right: { ...onlineLocation, groupId: "g2" } },
  { name: "online project", left: onlineLocation, right: { ...onlineLocation, projectId: "p2" } },
  { name: "source kind", left: localLocation, right: onlineLocation },
])("separates personal project preference identity by $name", ({ left, right }) => {
  expect(aiPersonalProjectKey(left)).not.toBe(aiPersonalProjectKey(right as AiPersonalProjectLocation));
});
// Catches redundant preference rows for equivalent canonical online roots.
it("canonicalizes online server roots without including definition/edit revision", () => {
  expect(aiPersonalProjectKey({ ...onlineLocation, serverUrl: "HTTPS://SERVER.test:443/api///", definitionRevision: 8 } as any)).toBe(aiPersonalProjectKey(onlineLocation));
});
// Catches a relative or incomplete host location colliding with another user's preferences.
it.each([
  { ...localLocation, root: "relative" },
  { ...onlineLocation, memberId: "" },
  { ...onlineLocation, serverUrl: "https://user:password@server.test/api" },
])("rejects incomplete/unsafe preference locations: %j", location => {
  expect(() => aiPersonalProjectKey(location as AiPersonalProjectLocation)).toThrowError(expect.objectContaining({ code: "invalid-project-location" }));
});

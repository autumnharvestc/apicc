import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const certificateBase64 = "MIICxDCCAaygAwIBAgIIB536LGynieQwDQYJKoZIhvcNAQELBQAwIjEgMB4GA1UEAxMXQVBJQ0MgU3ludGhldGljIFRlc3QgQ0EwHhcNMjYxMDE1MDIyNjE3WhcNMjYxMTE1MDIyNjE3WjAiMSAwHgYDVQQDExdBUElDQyBTeW50aGV0aWMgVGVzdCBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAMtgd6uYNRsvOHTSed9v0LDm+/IoZxfLWtrB8NYx50mH6HaL13PNSR7S1wnEiVgXJP4eWAmef5js7McpS02vVOsfVzuvKaEEM0x6dv6H43oG26aPvdNTwz9p74W/4U1I2YotpvIfEWekMQh0Y9UVh6ZzB/fV9q3BLbLEZg2jTAhQf9DLPtddnqS1reFBqo2pqc1Z6cxxOgSKGqWeXPx2pG/72/Wx/HlgDc+/cUIC3bk8SabhG32jYVCQHUPlzO4nClFzC3TS/5Zly2WOxGEz0yBoizNIeHCyynDoQbNCUI45sVtmj2JMvyFL+4ARWFYmHE7EF2PAPUMyvumwF2mZBNkCAwEAATANBgkqhkiG9w0BAQsFAAOCAQEAD5fXp+sAHeb98A1VGiL9tTIDno41kKntSSyiVXWM+mUo2gueKIjYQOjfVlcCzI9j95AILE8gQxOKXEblVOskrkUNtNkpQXlpiFN14RrdcgDnRzSiVs+vV7Pn+ZArnPekw3PPtS/XI7OIR2xwUxZSLsE/7xxryWxGIS71Ky69s/kSS6vaZVsf48HsqXggdQ93bVJ5DCVcaHr9GoJBENZmgSHZrWyV8RiRRd44cOBJiXTR2Dds115/i5um0JQ0VmyGnzsTCls2jwnKFSItLxMY1BKuUwmOIegjphFknsfaJd6QbbRfKM6nN4M4fZgDkrmxNH8Ab2kkeuRw4ZdhnoTClQ==";
const privateKeyBase64 = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDLYHermDUbLzh00nnfb9Cw5vvyKGcXy1rawfDWMedJh+h2i9dzzUke0tcJxIlYFyT+HlgJnn+Y7OzHKUtNr1TrH1c7rymhBDNMenb+h+N6Btumj73TU8M/ae+Fv+FNSNmKLabyHxFnpDEIdGPVFYemcwf31fatwS2yxGYNo0wIUH/Qyz7XXZ6kta3hQaqNqanNWenMcToEihqlnlz8dqRv+9v1sfx5YA3Pv3FCAt25PEmm4Rt9o2FQkB1D5czuJwpRcwt00v+WZctljsRhM9MgaIszSHhwsspw6EGzQlCOObFbZo9iTL8hS/uAEVhWJhxOxBdjwD1DMr7psBdpmQTZAgMBAAECggEAe2gK1YWjW954XHLG3uzDbkSKxrL7c3XCqJEcKWzYkka0qRJL5wm+/8QiFdw7Fsfce5JAC34woMPLHUKSXg4w8gbvcNjl4r1gv1xkTih4wLfemqAIKG5gQF9wpvD6rmGxFuaCsdJmRkRcOGwfk9HfoQGV6S3c5CwfJaWE42ueHEBd2eFdUOXiWA6sl+ijMGBr8MfI9z+u+ucL3BsnOref1Cmvt5PJxuv8lKPQa2N7G1PWjO6gwxH20utvaUnMdTZ4doQ5evpB+9L3Zsz4LdnQUTKxHDex746swaBX7nFpbQx0VwI0QOwTrIQstH+0gXpK6/UECzfIoUYH2pSOq/SOfQKBgQDMDrnaucJzsh/2FLLu2Vm96i9f2UIcObYE1cspVGVHdoNDQZUkWC5qfTmzowK/t3BZpRXNflksnAOjYAlP9wuO/Q+yYeCCZxpABfv1NAMGvivyrverYHNQ1xVv6uK0vPHy0uuKOUWKWb2K3r/JCmsqcYNZ1QcvGy3zubPEQyzEowKBgQD/JWJfoISOxjYG3FPzqLOSZf2jkiqxPUsfXTSMJ1ToiM4bR7OyxK6gDfQ/FZYU/UPWM1ep1iZKsKioSXM5S1EVG9Lj99p9gY9p3HivoKQI8pj4zZhNJG6YcOSsahZw3rdRBZik0oGMB5C/5az905UDMUGXF4pGZNlNF5xSHeXsUwKBgBN7YHEqhQ8otXZ4GXFGXRQNtMIw6ufo9qDVjJUAkr7U6MlWDJgwtxXBqO2mpY+KQva8FS3OX1Mr/gjuFVWGH5tiO8prH9UzZMUyDREnCxbstyNvYwQArGHOdyR9R3G8DFmDm6tRtnr0AG2uwJ7AGOUvezvrY8kyjhuT4j7drvuDAoGAMff9WyMRsvCItjFCU87vVDWbRgSjTdDmPH9Bgk1VqLDaRKd3PwSb+oahFhXBLd0oAvRNL9rb5vbQIR05brgcahjn5XOuG7RbBO2DyUmZtpLkeJ2zPTBsZHh/oHCqcnJ7zmddLLJ5YpY8uAhgJ9nfLh/ga5nVn9GyaRG9sKtgUzcCgYEAl1/2k6W+nfVox/K98pRNNLsLdSEfYEmOEbKVwxTh4iQUO4Q9WJraK+ExjVNsQoo5o9TPkvWTnyvYEMq65A6Z7d6//3HGvG8BsZb+yNkAOnRQrYWO14FZ84zU8eJ57B3rmVrTBjp9Q8HY+Fjwd9lSm2xkd/fLgBVhee4jPJuuUE4=";
const certificatePem = `-----BEGIN CERTIFICATE-----\n${certificateBase64.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${privateKeyBase64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;

interface Scope {
  canonicalRoot: string;
  project: { workspaceId: string; groupId: string; projectId: string };
  environmentId?: string;
}

interface Configuration {
  formatVersion: 1;
  profiles: Record<string, unknown>[];
  projectSelection?: Record<string, unknown>;
  environmentSelections: Record<string, unknown>[];
}

interface ProfileStore {
  load(scope: Scope): Promise<{ revision: string; configuration: Configuration }>;
  save(scope: Scope, next: Configuration, expectedRevision: string): Promise<string>;
}

interface SecretRef { id: string; policy: string }
interface SecretStoreStub {
  put(scope: Scope["project"], ref: SecretRef, value: string): Promise<void>;
  resolve(scope: Scope["project"], ref: SecretRef, expectedVersion?: string): Promise<string>;
  version(scope: Scope["project"], ref: SecretRef): Promise<string>;
  remove(scope: Scope["project"], ref: SecretRef): Promise<void>;
  status(scope: Scope["project"], ref: SecretRef): Promise<"available" | "missing" | "unavailable">;
}

interface PreparedTLS {
  verify: boolean;
  caMode: "append-runtime-defaults";
  caCertificates: readonly string[];
  clientCertificates: readonly string[];
  clientPrivateKey?: string;
  clientKeyPassphrase?: string;
}

interface PreparedResolution {
  origin: string;
  route: { kind: "direct" } | { kind: "proxy"; url: string; username?: string; password?: string };
  targetTLS: PreparedTLS;
  proxyTLS?: PreparedTLS;
}

interface PreparedRun {
  readonly revision: string;
  readonly identity: string;
  readonly credentialVersions: Readonly<Record<string, string>>;
  readonly requiresHttpAdapter: boolean;
  readonly outputMarkers: readonly string[];
  resolveForOrigin(origin: URL): PreparedResolution;
}

interface CoreApi {
  NetworkProfileSchema: { safeParse(value: unknown): { success: boolean } };
  createFileNetworkProfileStore(options: { privateRoot: string }): ProfileStore;
  createNetworkProfileHost(options: {
    workspaceRoot: string;
    project: Scope["project"];
    environmentId?: string;
    privateRoot: string;
    secretStore: SecretStoreStub;
  }): Promise<{ scope: Scope; store: ProfileStore; prepare(options?: { selection?: { kind: "direct" } | { kind: "profile"; profileId: string }; signal?: AbortSignal }): Promise<PreparedRun> }>;
  prepareNetworkRun(options: {
    scope: Scope;
    store: ProfileStore;
    secretStore: SecretStoreStub;
    selection?: { kind: "direct" } | { kind: "profile"; profileId: string };
    signal?: AbortSignal;
  }): Promise<PreparedRun>;
  NetworkProfileError: new (...args: never[]) => Error & { code: string; profileId?: string; field?: string };
}

const scopes: Record<string, Scope> = {
  first: { canonicalRoot: "C:/synthetic/workspace-one", project: { workspaceId: "workspace-one", groupId: "group-one", projectId: "same-project" }, environmentId: "dev" },
  otherGroup: { canonicalRoot: "C:/synthetic/workspace-one", project: { workspaceId: "workspace-one", groupId: "group-two", projectId: "same-project" }, environmentId: "dev" },
  otherRoot: { canonicalRoot: "C:/synthetic/workspace-two", project: { workspaceId: "workspace-one", groupId: "group-one", projectId: "same-project" }, environmentId: "dev" },
};

const workDirs: string[] = [];

async function createWorkDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "apicc-network-profiles-"));
  workDirs.push(root);
  return root;
}

async function findNetworkConfigurationFile(root: string): Promise<string> {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && entry.name === "network-profile.json") return path;
    }
  }
  throw new Error("Expected the owned network configuration fixture to exist.");
}

async function coreApi(): Promise<CoreApi> {
  const loaded = await import("../../src/index.js").catch(() => null);
  expect(loaded, "Core entry should load while Task 1 network exports are being added").not.toBeNull();
  return loaded as unknown as CoreApi;
}

function memoryStore(configuration: Configuration, revision = "memory-revision-one"): ProfileStore {
  return {
    async load() { return { revision, configuration }; },
    async save() { throw new Error("Unexpected memory store write."); },
  };
}

function secretStore(
  values: Record<string, string>,
  readRefs: string[],
  versions: Record<string, string> = {},
): SecretStoreStub {
  return {
    async put() { throw new Error("Unexpected secret write."); },
    async resolve(_scope, ref) {
      readRefs.push(ref.id);
      const value = values[ref.id];
      if (value === undefined) throw new Error("Unexpected synthetic SecretRef.");
      return value;
    },
    async version(_scope, ref) { return versions[ref.id] ?? "synthetic-version-one"; },
    async remove() { throw new Error("Unexpected secret removal."); },
    async status() { return "available"; },
  };
}

function directProfile(id = "direct-one", extras: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: id, kind: "direct", targetTlsBindings: [], ...extras };
}

function proxyProfile(id = "proxy-one", extras: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: id, kind: "proxy", proxyUrl: "http://proxy.synthetic:8080", targetTlsBindings: [], ...extras };
}

function configuration(profiles: Record<string, unknown>[], extras: Partial<Configuration> = {}): Configuration {
  return { formatVersion: 1, profiles, environmentSelections: [], ...extras };
}

afterEach(async () => {
  const roots = workDirs.splice(0);
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("network profile model, private store, and preparation port", () => {
  it("captures a canonical workspace root in the host without creating private storage before use", async () => {
    const core = await coreApi();
    const workRoot = await createWorkDir();
    const privateRoot = join(workRoot, "host-private-root");
    const host = await core.createNetworkProfileHost({
      workspaceRoot: workRoot,
      project: scopes.first.project,
      environmentId: "dev",
      privateRoot,
      secretStore: secretStore({}, []),
    });
    expect(host.scope).toEqual({
      canonicalRoot: workRoot,
      project: scopes.first.project,
      environmentId: "dev",
    });
    const prepared = await host.prepare();
    expect(prepared.resolveForOrigin(new URL("https://service.synthetic")).route).toEqual({ kind: "direct" });
    expect(prepared.credentialVersions).toEqual({});
    await expect(access(privateRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects inactive direct-profile fields and persists revisions by canonical root and full project identity", async () => {
    const core = await coreApi();
    expect(core.NetworkProfileSchema, "Task 1 profile model export is missing").toBeDefined();
    expect(core.NetworkProfileSchema.safeParse({
      ...directProfile(),
      proxyUrl: "http://inactive-proxy.synthetic:8080",
      passwordRef: { id: "inactive-secret", policy: "test-auto" },
    }).success).toBe(false);

    const workRoot = await createWorkDir();
    const store = core.createFileNetworkProfileStore({ privateRoot: join(workRoot, "private-network") });
    const initial = await store.load(scopes.first);
    expect(initial.configuration).toEqual({ formatVersion: 1, profiles: [], environmentSelections: [] });

    const next = configuration([directProfile("selected-direct")], {
      projectSelection: { kind: "profile", profileId: "selected-direct" },
      environmentSelections: [{ environmentId: "dev", selection: { kind: "direct" } }],
    });
    const savedRevision = await store.save(scopes.first, next, initial.revision);
    const reopened = await core.createFileNetworkProfileStore({ privateRoot: join(workRoot, "private-network") }).load(scopes.first);
    expect(reopened.configuration).toEqual(next);
    expect(reopened.revision).toBe(savedRevision);

    await expect(store.save(scopes.first, configuration([]), initial.revision)).rejects.toMatchObject({ code: "NETWORK_REVISION_CONFLICT" });
    expect((await store.load(scopes.first)).configuration).toEqual(next);
    expect((await store.load({ ...scopes.first, environmentId: "prod" })).revision).toBe(savedRevision);
    expect((await store.load(scopes.otherGroup)).configuration).toEqual({ formatVersion: 1, profiles: [], environmentSelections: [] });
    expect((await store.load(scopes.otherRoot)).configuration).toEqual({ formatVersion: 1, profiles: [], environmentSelections: [] });
  });

  it("rejects unknown stored formats without replacing the original configuration", async () => {
    const core = await coreApi();
    const workRoot = await createWorkDir();
    const privateRoot = join(workRoot, "private-network");
    const store = core.createFileNetworkProfileStore({ privateRoot });
    const initial = await store.load(scopes.first);
    await store.save(scopes.first, configuration([directProfile()]), initial.revision);

    const configPath = await findNetworkConfigurationFile(privateRoot);
    const unsupported = '{"formatVersion":2,"profiles":[],"environmentSelections":[]}';
    await writeFile(configPath, unsupported, "utf8");

    await expect(store.load(scopes.first)).rejects.toMatchObject({ code: "NETWORK_CONFIGURATION_UNSUPPORTED" });
    expect(await readFile(configPath, "utf8")).toBe(unsupported);
  });

  it("applies explicit, environment, then project selection and reads secrets only from the selected profile", async () => {
    const core = await coreApi();
    const selectedPassword = { id: "project-proxy-password", policy: "test-auto" };
    const unusedPassword = { id: "unused-proxy-password", policy: "test-auto" };
    const config = configuration([
      proxyProfile("project-proxy", { username: "synthetic-user", passwordRef: selectedPassword }),
      directProfile("unused-direct", {
        targetTlsBindings: [{ origin: "https://unused.synthetic", tls: { caCertificatePaths: ["C:/missing/unused.pem"] } }],
      }),
      proxyProfile("unused-proxy", { username: "unused-user", passwordRef: unusedPassword }),
    ], {
      projectSelection: { kind: "profile", profileId: "project-proxy" },
      environmentSelections: [{ environmentId: "dev", selection: { kind: "direct" } }],
    });
    const readRefs: string[] = [];
    const store = memoryStore(config);
    const secrets = secretStore({ "project-proxy-password": "synthetic-proxy-password", "unused-proxy-password": "unused" }, readRefs);

    const environmentDirect = await core.prepareNetworkRun({ scope: scopes.first, store, secretStore: secrets });
    expect(environmentDirect.resolveForOrigin(new URL("https://service.synthetic/path")).route).toEqual({ kind: "direct" });
    expect(readRefs).toEqual([]);

    const inheritedProject = await core.prepareNetworkRun({
      scope: { ...scopes.first, environmentId: "staging" }, store, secretStore: secrets,
    });
    expect(inheritedProject.resolveForOrigin(new URL("https://service.synthetic/path")).route).toEqual({
      kind: "proxy", url: "http://proxy.synthetic:8080", username: "synthetic-user", password: "synthetic-proxy-password",
    });
    expect(readRefs).toEqual(["project-proxy-password"]);

    const explicitDirect = await core.prepareNetworkRun({
      scope: scopes.first, store, secretStore: secrets, selection: { kind: "direct" },
    });
    expect(explicitDirect.resolveForOrigin(new URL("https://service.synthetic")).route).toEqual({ kind: "direct" });
    expect(readRefs).toEqual(["project-proxy-password"]);
  });

  it("keeps selected credential versions fixed when a ref rotates under the same config revision", async () => {
    const core = await coreApi();
    const passwordRef = { id: "rotating-proxy-password", policy: "test-auto" };
    const versions = { "rotating-proxy-password": "credential-version-one" };
    const config = configuration([
      proxyProfile("versioned-proxy", { username: "synthetic-user", passwordRef }),
    ], { projectSelection: { kind: "profile", profileId: "versioned-proxy" } });
    const store = memoryStore(config, "same-config-revision");
    const readRefs: string[] = [];
    const secrets = secretStore({ "rotating-proxy-password": "same-synthetic-secret-value" }, readRefs, versions);

    const first = await core.prepareNetworkRun({ scope: scopes.first, store, secretStore: secrets });
    expect(first.credentialVersions).toEqual({ "rotating-proxy-password": "credential-version-one" });
    versions["rotating-proxy-password"] = "credential-version-two";
    const second = await core.prepareNetworkRun({ scope: scopes.first, store, secretStore: secrets });

    expect(second.revision).toBe(first.revision);
    expect(second.credentialVersions).toEqual({ "rotating-proxy-password": "credential-version-two" });
    expect(first.credentialVersions["rotating-proxy-password"]).toBe("credential-version-one");
    expect(Object.isFrozen(first.credentialVersions)).toBe(true);
    expect(first.resolveForOrigin(new URL("https://service.synthetic")).route).toMatchObject({ password: "same-synthetic-secret-value" });
    expect(second.resolveForOrigin(new URL("https://service.synthetic")).route).toMatchObject({ password: "same-synthetic-secret-value" });
    expect(readRefs).toEqual(["rotating-proxy-password", "rotating-proxy-password"]);
  });

  it("captures only selected certificate and secret material and keeps target TLS separate from proxy TLS", async () => {
    const core = await coreApi();
    const workRoot = await createWorkDir();
    const targetCaPath = join(workRoot, "target-ca.pem");
    const clientCertificatePath = join(workRoot, "client-certificate.pem");
    const proxyCaPath = join(workRoot, "proxy-ca.pem");
    await Promise.all([
      writeFile(targetCaPath, certificatePem, "utf8"),
      writeFile(clientCertificatePath, certificatePem, "utf8"),
      writeFile(proxyCaPath, certificatePem, "utf8"),
    ]);

    const selectedProfile = proxyProfile("selected-proxy", {
      proxyUrl: "https://proxy.synthetic:8443",
      username: "synthetic-user",
      passwordRef: { id: "selected-proxy-password", policy: "test-auto" },
      proxyTLS: { caCertificatePaths: [proxyCaPath] },
      targetTlsBindings: [{
        origin: "https://service.synthetic",
        tls: {
          verify: false,
          caCertificatePaths: [targetCaPath],
          clientCertificatePaths: [clientCertificatePath],
          clientPrivateKeyRef: { id: "selected-client-key", policy: "test-auto" },
        },
      }],
    });
    const unusedProfile = proxyProfile("unused-proxy", {
      username: "unused-user",
      passwordRef: { id: "unused-password", policy: "test-auto" },
      targetTlsBindings: [{ origin: "https://unused.synthetic", tls: { caCertificatePaths: [join(workRoot, "missing.pem")] } }],
    });
    const readRefs: string[] = [];
    const prepared = await core.prepareNetworkRun({
      scope: scopes.first,
      store: memoryStore(configuration([selectedProfile, unusedProfile])),
      secretStore: secretStore({
        "selected-proxy-password": "synthetic-proxy-password",
        "selected-client-key": privateKeyPem,
        "unused-password": "unused",
      }, readRefs),
      selection: { kind: "profile", profileId: "selected-proxy" },
    });
    const resolution = prepared.resolveForOrigin(new URL("https://service.synthetic/api"));
    expect(() => JSON.stringify(resolution)).toThrow();
    expect(() => structuredClone(resolution)).toThrow();
    expect(prepared.revision).toBe("memory-revision-one");
    expect(resolution.origin).toBe("https://service.synthetic");
    expect(resolution.route.kind).toBe("proxy");
    expect(resolution.targetTLS).toMatchObject({ verify: false, caMode: "append-runtime-defaults", caCertificates: [certificatePem], clientCertificates: [certificatePem], clientPrivateKey: privateKeyPem });
    expect(resolution.proxyTLS).toMatchObject({ verify: true, caMode: "append-runtime-defaults", caCertificates: [certificatePem], clientCertificates: [] });
    expect(readRefs.sort()).toEqual(["selected-client-key", "selected-proxy-password"]);
    await writeFile(targetCaPath, "replaced after prepare", "utf8");
    expect(prepared.resolveForOrigin(new URL("https://service.synthetic/other")).targetTLS.caCertificates).toEqual([certificatePem]);
    expect(() => JSON.stringify(prepared)).toThrow();
  });

  it("binds the non-secret worker identity to certificate bytes at each target origin", async () => {
    const core = await coreApi();
    const workRoot = await createWorkDir();
    const firstPath = join(workRoot, "first-ca.pem");
    const secondPath = join(workRoot, "second-ca.pem");
    const firstContents = certificatePem;
    const secondContents = `${certificatePem}\n`;
    await Promise.all([
      writeFile(firstPath, firstContents, "utf8"),
      writeFile(secondPath, secondContents, "utf8"),
    ]);
    const profile = directProfile("two-target-cas", {
      targetTlsBindings: [
        { origin: "https://service.synthetic", tls: { caCertificatePaths: [firstPath] } },
        { origin: "https://other.synthetic", tls: { caCertificatePaths: [secondPath] } },
      ],
    });
    const store = memoryStore(configuration([profile], { projectSelection: { kind: "profile", profileId: profile.id as string } }), "unchanged-config-revision");
    const options = { scope: scopes.first, store, secretStore: secretStore({}, []) };
    const first = await core.prepareNetworkRun(options);

    await Promise.all([
      writeFile(firstPath, secondContents, "utf8"),
      writeFile(secondPath, firstContents, "utf8"),
    ]);
    const second = await core.prepareNetworkRun(options);

    expect(second.revision).toBe(first.revision);
    expect(first.requiresHttpAdapter).toBe(true);
    expect(second.identity).not.toBe(first.identity);
    expect(first.identity).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(first.identity).not.toContain(firstContents);
    expect(first.outputMarkers).toContain(firstContents);
  });

  it("rejects missing, malformed, and per-file oversized selected PEM before returning a run", async () => {
    const core = await coreApi();
    const workRoot = await createWorkDir();
    const missingPath = join(workRoot, "missing.pem");
    const malformedPath = join(workRoot, "malformed.pem");
    const oversizedPath = join(workRoot, "oversized.pem");
    await writeFile(malformedPath, "-----BEGIN CERTIFICATE-----\nnot-base64\n-----END CERTIFICATE-----\n", "utf8");
    await writeFile(oversizedPath, Buffer.alloc(1024 * 1024 + 1, 0x20));

    for (const [path, code] of [
      [missingPath, "NETWORK_CERTIFICATE_MISSING"],
      [malformedPath, "NETWORK_CERTIFICATE_INVALID"],
      [oversizedPath, "NETWORK_CERTIFICATE_TOO_LARGE"],
    ] as const) {
      const config = configuration([directProfile("invalid-cert-profile", {
        targetTlsBindings: [{ origin: "https://service.synthetic", tls: { caCertificatePaths: [path] } }],
      })]);
      await expect(core.prepareNetworkRun({
        scope: scopes.first, store: memoryStore(config), secretStore: secretStore({}, []),
        selection: { kind: "profile", profileId: "invalid-cert-profile" },
      })).rejects.toMatchObject({ code, profileId: "invalid-cert-profile", field: "targetTlsBindings" });
    }
  });

  it("counts actual public certificate reads against the 4 MiB preparation budget", async () => {
    const core = await coreApi();
    const workRoot = await createWorkDir();
    const fileContents = `${certificatePem}${" ".repeat(900 * 1024 - Buffer.byteLength(certificatePem))}`;
    const paths: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const path = join(workRoot, `ca-${index}.pem`);
      paths.push(path);
      await writeFile(path, fileContents, "utf8");
    }
    const profile = directProfile("budget-profile", {
      targetTlsBindings: paths.map((path, index) => ({
        origin: `https://service-${index}.synthetic`,
        tls: { caCertificatePaths: [path] },
      })),
    });
    await expect(core.prepareNetworkRun({
      scope: scopes.first, store: memoryStore(configuration([profile])), secretStore: secretStore({}, []),
      selection: { kind: "profile", profileId: "budget-profile" },
    })).rejects.toMatchObject({ code: "NETWORK_CERTIFICATE_BUDGET_EXCEEDED", profileId: "budget-profile" });
  });
});

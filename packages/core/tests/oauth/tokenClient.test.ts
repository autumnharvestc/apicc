import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOAuthProfileHost } from "../../src/oauth/host.js";
import { createFileOAuthProfileStore } from "../../src/oauth/privateStore.js";
import { createOAuthPkceChallenge, exchangeOAuthToken } from "../../src/oauth/tokenClient.js";
import type { OAuthProfile, OAuthProfileRecord, OAuthScope } from "../../src/oauth/model.js";
import type { SecretStore } from "../../src/credentials/types.js";

const CLIENT_ID = "synthetic-client: id+";
const CLIENT_SECRET = "synthetic-secret: value+";
const ACCESS_TOKEN = "synthetic-access-token-marker";

interface CapturedRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

const captured: CapturedRequest[] = [];
let responseStatus = 200;
let responseHeaders: Record<string, string> = {};
let beforeTokenResponse: (() => Promise<void>) | undefined;
let responseBody: unknown = {
  access_token: ACCESS_TOKEN,
  token_type: "bEaReR",
  expires_in: 3600,
  scope: "read write",
};

const tokenServer: Server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  captured.push({
    method: request.method ?? "",
    url: request.url ?? "",
    headers: request.headers,
    body: Buffer.concat(chunks).toString("utf8"),
  });
  await beforeTokenResponse?.();
  response.writeHead(responseStatus, { ...responseHeaders, "content-type": "application/json" });
  response.end(JSON.stringify(responseBody));
});

let tokenEndpoint = "";

const profile = (overrides: Partial<OAuthProfile> = {}): OAuthProfile => ({
  profileId: "synthetic-profile",
  scope: "read write ",
  environmentId: "synthetic-environment",
  flow: "client_credentials",
  tokenEndpoint,
  clientId: CLIENT_ID,
  clientAuthentication: "client_secret_basic",
  bearerRef: { id: "synthetic-access-ref", policy: "test-auto" },
  clientSecretRef: { id: "synthetic-client-secret-ref", policy: "test-auto" },
  ...overrides,
});

const directNetwork = {
  revision: "synthetic-network-revision",
  identity: "synthetic-network-identity",
  credentialVersions: Object.freeze({}),
  requiresHttpAdapter: false,
  outputMarkers: Object.freeze([]),
  resolveForOrigin(origin: URL) {
    return {
      origin: origin.origin,
      route: { kind: "direct" as const },
      targetTLS: {
        verify: true,
        caMode: "append-runtime-defaults" as const,
        caCertificates: [],
        clientCertificates: [],
      },
    };
  },
};

const credentialScope = {
  workspaceId: "33333333-3333-4333-8333-333333333333",
  groupId: "44444444-4444-4444-8444-444444444444",
  projectId: "55555555-5555-4555-8555-555555555555",
};

function testSecretStore(options: { failPutRefId?: string; failPutAfter?: number } = {}) {
  const values = new Map<string, string>();
  const versions = new Map<string, string>();
  const resolveExpectedVersions: Array<string | undefined> = [];
  const removed: string[] = [];
  const writesPerRef = new Map<string, number>();
  const versionFailures = new Set<string>();
  const versionFailureAfterPut = new Set<string>();
  let resolveHook: (() => Promise<void>) | undefined;
  let nextVersion = 0;
  const store: SecretStore = {
    async put(_scope, ref, value) {
      const writeCount = (writesPerRef.get(ref.id) ?? 0) + 1;
      writesPerRef.set(ref.id, writeCount);
      if (ref.id === options.failPutRefId && writeCount > (options.failPutAfter ?? 0)) throw new Error("synthetic secret write failure");
      values.set(ref.id, value);
      versions.set(ref.id, `synthetic-version-${++nextVersion}`);
      if (versionFailureAfterPut.delete(ref.id)) versionFailures.add(ref.id);
    },
    async resolve(_scope, ref, expectedVersion) {
      resolveExpectedVersions.push(expectedVersion);
      if (expectedVersion !== versions.get(ref.id) || !values.has(ref.id)) throw new Error("synthetic secret unavailable");
      const value = values.get(ref.id)!;
      await resolveHook?.();
      return value;
    },
    async version(_scope, ref) {
      if (versionFailures.has(ref.id)) throw new Error("synthetic secret version unavailable");
      const version = versions.get(ref.id);
      if (version === undefined) throw new Error("synthetic secret missing");
      return version;
    },
    async remove(_scope, ref) {
      removed.push(ref.id);
      values.delete(ref.id);
      versions.delete(ref.id);
    },
    async status(_scope, ref) {
      return values.has(ref.id) ? "available" : "missing";
    },
  };
  return {
    store,
    values,
    versions,
    resolveExpectedVersions,
    removed,
    setVersionFailure(refId: string, fail = true) {
      if (fail) versionFailures.add(refId);
      else versionFailures.delete(refId);
    },
    failVersionAfterPut(refId: string) {
      versionFailureAfterPut.add(refId);
    },
    setResolveHook(hook: (() => Promise<void>) | undefined) {
      resolveHook = hook;
    },
  };
}

async function filesBelow(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const paths: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) paths.push(...await filesBelow(path));
    else paths.push(path);
  }
  return paths;
}

async function withOwnedRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "apicc-oauth-task1-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function encodedFormComponent(value: string): string {
  return new URLSearchParams([["value", value]]).toString().slice("value=".length);
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback fixture did not bind a TCP port.");
  return address.port;
}

beforeAll(async () => {
  const port = await listen(tokenServer);
  tokenEndpoint = `http://127.0.0.1:${port}/token`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => tokenServer.close((error) => error ? reject(error) : resolve()));
});

beforeEach(() => {
  captured.length = 0;
  responseStatus = 200;
  responseHeaders = {};
  beforeTokenResponse = undefined;
  responseBody = {
    access_token: ACCESS_TOKEN,
    token_type: "bEaReR",
    expires_in: 3600,
    scope: "read write",
  };
});

describe("exchangeOAuthToken", () => {
  it("posts a client-credentials grant with RFC form-encoded Basic credentials and returns a private Bearer token set", async () => {
    const result = await exchangeOAuthToken({
      profile: profile(),
      grant: { type: "client_credentials" },
      secrets: { clientSecret: CLIENT_SECRET },
      network: directNetwork,
    });

    expect(result).toEqual({
      accessToken: ACCESS_TOKEN,
      tokenType: "Bearer",
      expiresIn: 3600,
      scope: "read write",
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.method).toBe("POST");
    expect(captured[0]?.url).toBe("/token");
    expect(captured[0]?.headers["content-type"]).toMatch(/^application\/x-www-form-urlencoded\b/i);
    expect(captured[0]?.headers.authorization).toBe(`Basic ${Buffer.from(`${encodedFormComponent(CLIENT_ID)}:${encodedFormComponent(CLIENT_SECRET)}`).toString("base64")}`);
    expect(new URLSearchParams(captured[0]?.body).get("grant_type")).toBe("client_credentials");
    expect(new URLSearchParams(captured[0]?.body).get("scope")).toBe("read write ");
    expect(captured[0]?.body).not.toContain(CLIENT_SECRET);
    expect(captured[0]?.headers.cookie).toBeUndefined();
  });

  it("rejects a non-Bearer token type without exposing the response body", async () => {
    responseBody = { access_token: ACCESS_TOKEN, token_type: "MAC", marker: "synthetic-upstream-error-marker" };

    await expect(exchangeOAuthToken({
      profile: profile(),
      grant: { type: "client_credentials" },
      secrets: { clientSecret: CLIENT_SECRET },
      network: directNetwork,
    })).rejects.toMatchObject({ code: "OAUTH_TOKEN_TYPE_UNSUPPORTED" });
  });

  it("rejects a response without an access token", async () => {
    responseBody = { token_type: "Bearer", expires_in: 3600 };

    await expect(exchangeOAuthToken({
      profile: profile(),
      grant: { type: "client_credentials" },
      secrets: { clientSecret: CLIENT_SECRET },
      network: directNetwork,
    })).rejects.toMatchObject({ code: "OAUTH_ACCESS_TOKEN_MISSING" });
  });

  it("rejects remote plain-HTTP token endpoints before sending a request", async () => {
    await expect(exchangeOAuthToken({
      profile: profile({ tokenEndpoint: "http://example.invalid/token" }),
      grant: { type: "client_credentials" },
      secrets: { clientSecret: CLIENT_SECRET },
      network: directNetwork,
    })).rejects.toMatchObject({ code: "OAUTH_PROFILE_INVALID" });
    expect(captured).toHaveLength(0);
  });

  it("projects cancellation as a stable error without sending a request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(exchangeOAuthToken({
      profile: profile(),
      grant: { type: "client_credentials" },
      secrets: { clientSecret: CLIENT_SECRET },
      network: directNetwork,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "OAUTH_REQUEST_ABORTED" });
    expect(captured).toHaveLength(0);
  });

  it("exchanges an authorization code with its PKCE verifier and exact redirect URI", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const redirectUri = "http://127.0.0.1:49152/callback?state=a+b";
    const result = await exchangeOAuthToken({
      profile: profile({
        flow: "authorization_code",
        authorizationEndpoint: "https://auth.example.test/authorize",
        clientAuthentication: "none",
        clientSecretRef: undefined,
      }),
      grant: { type: "authorization_code", code: "synthetic-code", verifier, redirectUri },
      secrets: {},
      network: directNetwork,
    });

    expect(result.accessToken).toBe(ACCESS_TOKEN);
    expect(createOAuthPkceChallenge(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(new URLSearchParams(captured[0]?.body).get("grant_type")).toBe("authorization_code");
    expect(new URLSearchParams(captured[0]?.body).get("code")).toBe("synthetic-code");
    expect(new URLSearchParams(captured[0]?.body).get("code_verifier")).toBe(verifier);
    expect(new URLSearchParams(captured[0]?.body).get("redirect_uri")).toBe(redirectUri);
    expect(new URLSearchParams(captured[0]?.body).get("client_id")).toBe(CLIENT_ID);
    expect(captured[0]?.headers.authorization).toBeUndefined();
  });

  it("exchanges refresh tokens with client_secret_post and retains the rotated token privately", async () => {
    responseBody = {
      access_token: ACCESS_TOKEN,
      refresh_token: "synthetic-rotated-refresh-token",
      token_type: "Bearer",
      expires_in: "60",
    };
    const result = await exchangeOAuthToken({
      profile: profile({
        flow: "refresh_token",
        refreshTokenRef: { id: "synthetic-refresh-ref", policy: "test-auto" },
        clientAuthentication: "client_secret_post",
      }),
      grant: { type: "refresh_token" },
      secrets: { clientSecret: CLIENT_SECRET, refreshToken: "synthetic-refresh-token" },
      network: directNetwork,
    });

    expect(result).toEqual({
      accessToken: ACCESS_TOKEN,
      refreshToken: "synthetic-rotated-refresh-token",
      tokenType: "Bearer",
      expiresIn: 60,
    });
    const form = new URLSearchParams(captured[0]?.body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("synthetic-refresh-token");
    expect(form.has("scope")).toBe(false);
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("client_secret")).toBe(CLIENT_SECRET);
    expect(captured[0]?.headers.authorization).toBeUndefined();
  });

  it("does not follow redirects from the token endpoint", async () => {
    responseStatus = 302;
    responseHeaders = { location: "/redirected-token" };

    await expect(exchangeOAuthToken({
      profile: profile(),
      grant: { type: "client_credentials" },
      secrets: { clientSecret: CLIENT_SECRET },
      network: directNetwork,
    })).rejects.toMatchObject({ code: "OAUTH_TOKEN_ENDPOINT_REJECTED" });
    expect(captured).toHaveLength(1);
  });
});

describe("OAuth profile storage and host", () => {
  it("keeps configuration identity stable across other owners and rejects a stale capture before resolving secrets", async () => {
    await withOwnedRoot(async (root) => {
      const workspaceRoot = join(root, "workspace");
      await mkdir(workspaceRoot);
      const secrets = testSecretStore();
      const host = await createOAuthProfileHost({
        workspaceRoot,
        project: credentialScope,
        environmentId: "synthetic-environment",
        privateRoot: join(root, "private"),
        secretStore: secrets.store,
      });
      const candidate = profile();
      expect(await host.saveProfile(candidate, { clientSecret: CLIENT_SECRET })).toEqual({ status: "success" });
      const capturedIdentity = (await host.listProfiles())[0]?.configurationFingerprint;
      expect(capturedIdentity).toMatch(/^sha256:[a-f0-9]{64}$/);

      const otherScope: OAuthScope = {
        canonicalRoot: join(root, "workspace-other"),
        project: credentialScope,
        environmentId: "synthetic-other-environment",
      };
      const { revision } = await host.store.load(otherScope);
      const otherProfile = profile({
        profileId: "synthetic-other-profile",
        environmentId: otherScope.environmentId,
        bearerRef: { id: "synthetic-other-access-ref", policy: "test-auto" },
      });
      await host.store.save(otherScope, [{
        canonicalRoot: otherScope.canonicalRoot,
        profile: otherProfile,
        state: { status: "unconfigured" },
        credentialVersions: {},
      }], revision);

      expect((await host.listProfiles())[0]?.configurationFingerprint).toBe(capturedIdentity);
      captured.length = 0;
      expect(await host.exchange("synthetic-profile", { type: "client_credentials" }, {
        network: directNetwork,
        expectedConfigurationFingerprint: capturedIdentity,
      })).toMatchObject({ status: "success" });
      expect(captured).toHaveLength(1);

      expect(await host.saveProfile({ ...candidate, clientId: "synthetic-new-client-id" })).toEqual({ status: "success" });
      expect((await host.listProfiles())[0]?.configurationFingerprint).not.toBe(capturedIdentity);
      captured.length = 0;
      const resolvedBeforeStaleCall = secrets.resolveExpectedVersions.length;
      expect(await host.exchange("synthetic-profile", { type: "client_credentials" }, {
        network: directNetwork,
        expectedConfigurationFingerprint: capturedIdentity,
      })).toEqual({ status: "failed", errorCode: "OAUTH_PROFILE_CONFIGURATION_CHANGED" });
      expect(secrets.resolveExpectedVersions).toHaveLength(resolvedBeforeStaleCall);
      expect(captured).toHaveLength(0);

      const currentFingerprint = (await host.listProfiles())[0]?.configurationFingerprint;
      let recordBeforeResolveDrift: OAuthProfileRecord | undefined;
      secrets.setResolveHook(async () => {
        secrets.setResolveHook(undefined);
        // Model document drift between secret resolution and the preflight read without
        // re-entering the managed host API, which correctly waits on this exchange's ref lock.
        const duringResolve = await host.store.load(host.scope);
        const selectedRecord = duringResolve.profiles.find((record) => record.profile.profileId === "synthetic-profile");
        if (selectedRecord === undefined) throw new Error("selected profile disappeared during the exchange fixture");
        recordBeforeResolveDrift = selectedRecord;
        await host.store.save(host.scope, duringResolve.profiles.map((record) => record.profile.profileId === "synthetic-profile"
          ? { ...record, profile: { ...record.profile, clientId: "synthetic-newer-client-id" } }
          : record), duringResolve.revision);
      });
      expect(await host.exchange("synthetic-profile", { type: "client_credentials" }, {
        network: directNetwork,
        expectedConfigurationFingerprint: currentFingerprint,
      })).toEqual({ status: "failed", errorCode: "OAUTH_PROFILE_CONFIGURATION_CHANGED" });
      expect(captured).toHaveLength(0);
      const afterDrift = await host.store.load(host.scope);
      const changedRecord = afterDrift.profiles.find((record) => record.profile.profileId === "synthetic-profile");
      expect(changedRecord?.profile.clientId).toBe("synthetic-newer-client-id");
      expect(changedRecord?.state).toEqual(recordBeforeResolveDrift?.state);
      expect(changedRecord?.credentialVersions).toEqual(recordBeforeResolveDrift?.credentialVersions);
      expect((await host.store.load(otherScope)).profiles.map((record) => record.profile.profileId)).toContain("synthetic-other-profile");
    });
  });

  it("rejects OAuth refs outside the supported test-auto SecretStore policy before exchange", async () => {
    await withOwnedRoot(async (root) => {
      const workspaceRoot = join(root, "workspace");
      await mkdir(workspaceRoot);
      const secrets = testSecretStore();
      const host = await createOAuthProfileHost({
        workspaceRoot,
        project: credentialScope,
        environmentId: "synthetic-environment",
        privateRoot: join(root, "private"),
        secretStore: secrets.store,
      });
      const unsupported = profile({
        bearerRef: { id: "synthetic-access-ref", policy: "future-policy" },
      });

      expect(await host.saveProfile(unsupported)).toEqual({ status: "failed", errorCode: "OAUTH_PROFILE_INVALID" });
      expect(captured).toHaveLength(0);
      expect(secrets.values.size).toBe(0);
    });
  });

  it("captures versions for newly rebound client-secret and refresh-token refs", async () => {
    await withOwnedRoot(async (root) => {
      const workspaceRoot = join(root, "workspace");
      await mkdir(workspaceRoot);
      const secrets = testSecretStore();
      const host = await createOAuthProfileHost({
        workspaceRoot,
        project: credentialScope,
        environmentId: "synthetic-environment",
        privateRoot: join(root, "private"),
        secretStore: secrets.store,
      });
      const initial = profile({
        flow: "authorization_code",
        authorizationEndpoint: "https://auth.example.test/authorize",
        clientAuthentication: "client_secret_post",
        refreshTokenRef: { id: "synthetic-refresh-ref-a", policy: "test-auto" },
      });
      expect(await host.saveProfile(initial, {
        clientSecret: "synthetic-client-secret-a",
        refreshToken: "synthetic-refresh-token-a",
      })).toEqual({ status: "success" });

      await secrets.store.put(credentialScope, { id: "synthetic-client-secret-ref-b", policy: "test-auto" }, "synthetic-client-secret-b");
      await secrets.store.put(credentialScope, { id: "synthetic-refresh-ref-b", policy: "test-auto" }, "synthetic-refresh-token-b");
      const rebound = {
        ...initial,
        clientSecretRef: { id: "synthetic-client-secret-ref-b", policy: "test-auto" as const },
        refreshTokenRef: { id: "synthetic-refresh-ref-b", policy: "test-auto" as const },
      };
      expect(await host.saveProfile(rebound)).toEqual({ status: "success" });

      const stored = await host.store.load(host.scope);
      expect(stored.profiles[0]?.credentialVersions).toMatchObject({
        clientSecret: secrets.versions.get("synthetic-client-secret-ref-b"),
        refreshToken: secrets.versions.get("synthetic-refresh-ref-b"),
      });
      expect(await host.exchange("synthetic-profile", { type: "refresh_token" }, { network: directNetwork })).toMatchObject({ status: "success" });
      expect(secrets.resolveExpectedVersions.slice(-2)).toEqual([
        secrets.versions.get("synthetic-client-secret-ref-b"),
        secrets.versions.get("synthetic-refresh-ref-b"),
      ]);
    });
  });

  it("reopens private profiles, isolates root/environment views, and rejects Bearer ref reuse within one credential scope", async () => {
    await withOwnedRoot(async (root) => {
      const privateRoot = join(root, "private");
      const store = createFileOAuthProfileStore({ privateRoot });
      const scopeA: OAuthScope = {
        canonicalRoot: join(root, "workspace-a"),
        project: credentialScope,
        environmentId: "synthetic-environment-a",
      };
      const scopeB: OAuthScope = {
        canonicalRoot: join(root, "workspace-b"),
        project: credentialScope,
        environmentId: "synthetic-environment-b",
      };
      const profileA = profile({ profileId: "profile-a", environmentId: scopeA.environmentId });
      const recordA: OAuthProfileRecord = {
        canonicalRoot: scopeA.canonicalRoot,
        profile: profileA as OAuthProfileRecord["profile"],
        state: { status: "unconfigured" },
        credentialVersions: {},
      };
      const firstRevision = await store.save(scopeA, [recordA], "missing");
      const collidingProfile = profile({ profileId: "profile-b", environmentId: scopeB.environmentId });
      const recordB: OAuthProfileRecord = {
        canonicalRoot: scopeB.canonicalRoot,
        profile: collidingProfile as OAuthProfileRecord["profile"],
        state: { status: "unconfigured" },
        credentialVersions: {},
      };
      await expect(store.save(scopeB, [recordB], firstRevision)).rejects.toMatchObject({ code: "OAUTH_BEARER_REF_IN_USE" });

      const uniqueProfileB = profile({
        profileId: "profile-b",
        environmentId: scopeB.environmentId,
        bearerRef: { id: "synthetic-access-ref-b", policy: "test-auto" },
      });
      const secondRevision = await store.save(scopeB, [{ ...recordB, profile: uniqueProfileB as OAuthProfileRecord["profile"] }], firstRevision);
      expect((await store.load(scopeA)).profiles.map((record) => record.profile.profileId)).toEqual(["profile-a"]);
      expect((await store.load(scopeB)).profiles.map((record) => record.profile.profileId)).toEqual(["profile-b"]);

      const reopened = createFileOAuthProfileStore({ privateRoot });
      expect((await reopened.load(scopeA)).profiles[0]?.profile.profileId).toBe("profile-a");
      await expect(reopened.save(scopeB, [], firstRevision)).rejects.toMatchObject({ code: "OAUTH_PROFILE_REVISION_CONFLICT" });
      expect(secondRevision).not.toBe(firstRevision);
    });
  });

  it("preserves a damaged or future-version profile document without overwriting it", async () => {
    await withOwnedRoot(async (root) => {
      const privateRoot = join(root, "private");
      const scope: OAuthScope = { canonicalRoot: root, project: credentialScope, environmentId: "synthetic-environment" };
      const store = createFileOAuthProfileStore({ privateRoot });
      const record: OAuthProfileRecord = {
        canonicalRoot: root,
        profile: profile() as OAuthProfileRecord["profile"],
        state: { status: "unconfigured" },
        credentialVersions: {},
      };
      await store.save(scope, [record], "missing");
      const profileFile = (await filesBelow(privateRoot)).find((path) => basename(path) === "oauth-profile.json");
      expect(profileFile).toBeDefined();
      const original = await readFile(profileFile!, "utf8");

      const futureContents = JSON.stringify({ formatVersion: 2, profiles: [] });
      await writeFile(profileFile!, futureContents, "utf8");
      await expect(store.load(scope)).rejects.toMatchObject({ code: "OAUTH_PROFILE_VERSION_UNSUPPORTED" });
      await expect(store.save(scope, [], "missing")).rejects.toMatchObject({ code: "OAUTH_PROFILE_VERSION_UNSUPPORTED" });
      expect(await readFile(profileFile!, "utf8")).toBe(futureContents);

      const damagedContents = "{malformed";
      await writeFile(profileFile!, damagedContents, "utf8");
      await expect(store.load(scope)).rejects.toMatchObject({ code: "OAUTH_PROFILE_STORAGE_FAILED" });
      await expect(store.save(scope, [], "missing")).rejects.toMatchObject({ code: "OAUTH_PROFILE_STORAGE_FAILED" });
      expect(await readFile(profileFile!, "utf8")).toBe(damagedContents);
      expect(original).toContain('"formatVersion":1');
    });
  });

  it("stores the client secret by ref, locks the profile revision, and exposes no token material in public state", async () => {
    responseBody = { access_token: ACCESS_TOKEN, token_type: "Bearer", expires_in: 30 };
    await withOwnedRoot(async (root) => {
      const workspaceRoot = join(root, "workspace");
      await mkdir(workspaceRoot);
      const secrets = testSecretStore();
      const host = await createOAuthProfileHost({
        workspaceRoot,
        project: credentialScope,
        environmentId: "synthetic-environment",
        privateRoot: join(root, "private"),
        secretStore: secrets.store,
      });
      const candidate = profile();
      expect(await host.saveProfile(candidate as OAuthProfileRecord["profile"], { clientSecret: CLIENT_SECRET })).toEqual({ status: "success" });
      const result = await host.exchange("synthetic-profile", { type: "client_credentials" }, { network: directNetwork });
      expect(captured).toHaveLength(1);
      expect(result.status).toBe("success");
      expect(result).not.toHaveProperty("accessToken");
      expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
      expect(secrets.values.get("synthetic-client-secret-ref")).toBe(CLIENT_SECRET);
      expect(secrets.values.get("synthetic-access-ref")).toBe(ACCESS_TOKEN);
      expect(secrets.resolveExpectedVersions).toContain(secrets.versions.get("synthetic-client-secret-ref"));
      const profileFiles = (await filesBelow(join(root, "private"))).filter((path) => basename(path) === "oauth-profile.json");
      const storedText = await readFile(profileFiles[0]!, "utf8");
      expect(storedText).not.toContain(CLIENT_SECRET);
      expect(storedText).not.toContain(ACCESS_TOKEN);
      expect((await host.listProfiles())[0]?.status).toBe("connected");
    });
  });

  it("hides stale expiry and refuses exchange after the selected Bearer ref changes version", async () => {
    await withOwnedRoot(async (root) => {
      const workspaceRoot = join(root, "workspace");
      await mkdir(workspaceRoot);
      const secrets = testSecretStore();
      const host = await createOAuthProfileHost({
        workspaceRoot,
        project: credentialScope,
        environmentId: "synthetic-environment",
        privateRoot: join(root, "private"),
        secretStore: secrets.store,
      });
      expect(await host.saveProfile(profile(), { clientSecret: CLIENT_SECRET })).toEqual({ status: "success" });
      expect(await host.exchange("synthetic-profile", { type: "client_credentials" }, { network: directNetwork })).toMatchObject({ status: "success" });
      expect((await host.listProfiles())[0]).toHaveProperty("expiresAt");

      secrets.values.set("synthetic-access-ref", "synthetic-manually-replaced-access-token");
      secrets.versions.set("synthetic-access-ref", "synthetic-manual-version");
      const summary = (await host.listProfiles())[0];
      expect(summary).toMatchObject({ status: "failed", errorCode: "OAUTH_SECRET_VERSION_CONFLICT" });
      expect(summary).not.toHaveProperty("expiresAt");

      captured.length = 0;
      expect(await host.exchange("synthetic-profile", { type: "client_credentials" }, { network: directNetwork })).toEqual({
        status: "failed",
        errorCode: "OAUTH_SECRET_VERSION_CONFLICT",
      });
      expect(captured).toHaveLength(0);
    });
  });

  it("does not retain the old Bearer version or expiry when a saved token version cannot be confirmed", async () => {
    await withOwnedRoot(async (root) => {
      const workspaceRoot = join(root, "workspace");
      await mkdir(workspaceRoot);
      const secrets = testSecretStore();
      const host = await createOAuthProfileHost({
        workspaceRoot,
        project: credentialScope,
        environmentId: "synthetic-environment",
        privateRoot: join(root, "private"),
        secretStore: secrets.store,
      });
      expect(await host.saveProfile(profile(), { clientSecret: CLIENT_SECRET })).toEqual({ status: "success" });
      expect(await host.exchange("synthetic-profile", { type: "client_credentials" }, { network: directNetwork })).toMatchObject({ status: "success" });

      responseBody = { access_token: "synthetic-second-access-marker", token_type: "Bearer", expires_in: 120 };
      secrets.failVersionAfterPut("synthetic-access-ref");
      expect(await host.exchange("synthetic-profile", { type: "client_credentials" }, { network: directNetwork })).toEqual({
        status: "partial_success",
        errorCode: "OAUTH_ACCESS_TOKEN_SAVE_FAILED",
      });

      const summary = (await host.listProfiles())[0];
      expect(summary).toMatchObject({ status: "failed", errorCode: "OAUTH_SECRET_UNAVAILABLE" });
      expect(summary).not.toHaveProperty("expiresAt");
      const profileFile = (await filesBelow(join(root, "private"))).find((path) => basename(path) === "oauth-profile.json");
      const stored = JSON.parse(await readFile(profileFile!, "utf8")) as { profiles: Array<{ credentialVersions: { accessToken?: string }; state: { expiresAt?: number } }> };
      expect(stored.profiles[0]?.credentialVersions.accessToken).toBeUndefined();
      expect(stored.profiles[0]?.state.expiresAt).toBeUndefined();
      expect(secrets.values.get("synthetic-access-ref")).toBe("synthetic-second-access-marker");
    });
  });

  it("reports access-token success as partial when refresh rotation storage fails and does not unlink secrets", async () => {
    responseBody = {
      access_token: ACCESS_TOKEN,
      refresh_token: "synthetic-rotated-refresh-marker",
      token_type: "Bearer",
      expires_in: 60,
    };
    await withOwnedRoot(async (root) => {
      const workspaceRoot = join(root, "workspace");
      await mkdir(workspaceRoot);
      const refreshRefId = "synthetic-refresh-ref";
      const secrets = testSecretStore({ failPutRefId: refreshRefId });
      const host = await createOAuthProfileHost({
        workspaceRoot,
        project: credentialScope,
        environmentId: "synthetic-environment",
        privateRoot: join(root, "private"),
        secretStore: secrets.store,
      });
      const candidate = profile({
        flow: "authorization_code",
        authorizationEndpoint: "https://auth.example.test/authorize",
        clientAuthentication: "none",
        clientSecretRef: undefined,
        refreshTokenRef: { id: refreshRefId, policy: "test-auto" },
      });
      expect(await host.saveProfile(candidate as OAuthProfileRecord["profile"])).toEqual({ status: "success" });
      const result = await host.exchange("synthetic-profile", {
        type: "authorization_code",
        code: "synthetic-code",
        verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        redirectUri: "http://127.0.0.1/callback",
      }, { network: directNetwork });

      expect(captured).toHaveLength(1);
      expect(result).toMatchObject({ status: "partial_success", errorCode: "OAUTH_REFRESH_TOKEN_SAVE_FAILED" });
      expect(Object.keys(result).sort()).toEqual(["errorCode", "expiresAt", "status"]);
      expect(secrets.values.get("synthetic-access-ref")).toBe(ACCESS_TOKEN);
      expect(secrets.values.has(refreshRefId)).toBe(false);
      expect((await host.listProfiles())[0]?.status).toBe("partial_success");
      expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
      expect(JSON.stringify(result)).not.toContain("synthetic-rotated-refresh-marker");
      expect(await host.unlinkProfile("synthetic-profile")).toEqual({ status: "success" });
      expect(secrets.removed).toEqual([]);
      expect(secrets.values.get("synthetic-access-ref")).toBe(ACCESS_TOKEN);
    });
  });

  it("requires reauthorization when saving a rotated refresh token fails", async () => {
    responseBody = {
      access_token: ACCESS_TOKEN,
      refresh_token: "synthetic-rotated-refresh-marker",
      token_type: "Bearer",
      expires_in: 60,
    };
    await withOwnedRoot(async (root) => {
      const workspaceRoot = join(root, "workspace");
      await mkdir(workspaceRoot);
      const refreshRefId = "synthetic-refresh-ref";
      const secrets = testSecretStore({ failPutRefId: refreshRefId, failPutAfter: 1 });
      const host = await createOAuthProfileHost({
        workspaceRoot,
        project: credentialScope,
        environmentId: "synthetic-environment",
        privateRoot: join(root, "private"),
        secretStore: secrets.store,
      });
      const candidate = profile({
        flow: "authorization_code",
        authorizationEndpoint: "https://auth.example.test/authorize",
        clientAuthentication: "none",
        clientSecretRef: undefined,
        refreshTokenRef: { id: refreshRefId, policy: "test-auto" },
      });
      expect(await host.saveProfile(candidate as OAuthProfileRecord["profile"], { refreshToken: "synthetic-original-refresh-token" })).toEqual({ status: "success" });
      const result = await host.exchange("synthetic-profile", { type: "refresh_token" }, { network: directNetwork });

      expect(result).toMatchObject({ status: "reauthorization_required", errorCode: "OAUTH_REFRESH_TOKEN_SAVE_FAILED" });
      expect(captured).toHaveLength(1);
      expect(secrets.values.get("synthetic-access-ref")).toBe(ACCESS_TOKEN);
      expect(secrets.values.get(refreshRefId)).toBe("synthetic-original-refresh-token");
      expect((await host.listProfiles())[0]?.status).toBe("reauthorization_required");
    });
  });

  it("requires reauthorization if another owner changes the shared document after refresh rotation", async () => {
    responseBody = {
      access_token: ACCESS_TOKEN,
      refresh_token: "synthetic-rotated-refresh-token",
      token_type: "Bearer",
      expires_in: 60,
    };
    await withOwnedRoot(async (root) => {
      const workspaceRoot = join(root, "workspace");
      await mkdir(workspaceRoot);
      const refreshRefId = "synthetic-refresh-ref";
      const secrets = testSecretStore();
      const host = await createOAuthProfileHost({
        workspaceRoot,
        project: credentialScope,
        environmentId: "synthetic-environment",
        privateRoot: join(root, "private"),
        secretStore: secrets.store,
      });
      const store = host.store;
      const candidate = profile({
        flow: "refresh_token",
        refreshTokenRef: { id: refreshRefId, policy: "test-auto" },
      });
      expect(await host.saveProfile(candidate, { clientSecret: CLIENT_SECRET, refreshToken: "synthetic-original-refresh-token" })).toEqual({ status: "success" });

      const otherScope: OAuthScope = {
        canonicalRoot: join(root, "workspace-other"),
        project: credentialScope,
        environmentId: "synthetic-other-environment",
      };
      beforeTokenResponse = async () => {
        const { revision } = await store.load(otherScope);
        const otherProfile = profile({
          profileId: "synthetic-other-profile",
          environmentId: otherScope.environmentId,
          flow: "authorization_code",
          authorizationEndpoint: "https://auth.example.test/authorize",
          clientAuthentication: "none",
          clientSecretRef: undefined,
          bearerRef: { id: "synthetic-other-access-ref", policy: "test-auto" },
          refreshTokenRef: undefined,
        });
        await store.save(otherScope, [{
          canonicalRoot: otherScope.canonicalRoot,
          profile: otherProfile,
          state: { status: "unconfigured" },
          credentialVersions: {},
        }], revision);
      };

      const result = await host.exchange("synthetic-profile", { type: "refresh_token" }, { network: directNetwork });
      expect(result).toEqual({ status: "reauthorization_required", errorCode: "OAUTH_PROFILE_REVISION_CONFLICT" });
      expect((await host.listProfiles())[0]).toMatchObject({
        status: "reauthorization_required",
        errorCode: "OAUTH_PROFILE_REVISION_CONFLICT",
      });
      expect((await store.load(otherScope)).profiles).toHaveLength(1);
      expect(secrets.values.get(refreshRefId)).toBe("synthetic-original-refresh-token");
      expect(secrets.values.has("synthetic-access-ref")).toBe(false);
    });
  });

  it("requires reauthorization when access persistence fails after a refresh rotation response", async () => {
    responseBody = {
      access_token: ACCESS_TOKEN,
      refresh_token: "synthetic-rotated-refresh-token",
      token_type: "Bearer",
      expires_in: 60,
    };
    await withOwnedRoot(async (root) => {
      const workspaceRoot = join(root, "workspace");
      await mkdir(workspaceRoot);
      const refreshRefId = "synthetic-refresh-ref";
      const secrets = testSecretStore({ failPutRefId: "synthetic-access-ref" });
      const host = await createOAuthProfileHost({
        workspaceRoot,
        project: credentialScope,
        environmentId: "synthetic-environment",
        privateRoot: join(root, "private"),
        secretStore: secrets.store,
      });
      const candidate = profile({
        flow: "refresh_token",
        refreshTokenRef: { id: refreshRefId, policy: "test-auto" },
      });
      expect(await host.saveProfile(candidate, { clientSecret: CLIENT_SECRET, refreshToken: "synthetic-original-refresh-token" })).toEqual({ status: "success" });

      const result = await host.exchange("synthetic-profile", { type: "refresh_token" }, { network: directNetwork });
      expect(result).toEqual({ status: "reauthorization_required", errorCode: "OAUTH_ACCESS_TOKEN_SAVE_FAILED" });
      expect((await host.listProfiles())[0]).toMatchObject({
        status: "reauthorization_required",
        errorCode: "OAUTH_ACCESS_TOKEN_SAVE_FAILED",
      });
      expect(secrets.values.has("synthetic-access-ref")).toBe(false);
      expect(secrets.values.get(refreshRefId)).toBe("synthetic-original-refresh-token");
    });
  });
});

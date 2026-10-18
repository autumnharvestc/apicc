import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createOAuthProfileHost } from "../../src/oauth/host.js";
import { createOAuthProfileCoordinator } from "../../src/oauth/coordinator.js";
import { OAuthError, type OAuthProfile, type OAuthProfileRecord } from "../../src/oauth/model.js";
import type { SecretStore } from "../../src/credentials/types.js";

const PROJECT = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  groupId: "00000000-0000-4000-8000-000000000002",
  projectId: "00000000-0000-4000-8000-000000000003",
};
const BEARER = { id: "synthetic-oauth-bearer", policy: "test-auto" as const };
const CLIENT_SECRET = { id: "synthetic-oauth-client-secret", policy: "test-auto" as const };
const NOW = 1_800_000_000_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function makeSecretStore() {
  let value: string | undefined;
  let version = "missing";
  let sequence = 0;
  const store: SecretStore = {
    async put(_scope, _ref, next) { value = next; version = `version-${++sequence}`; },
    async resolve() { if (value === undefined) throw new Error("missing"); return value; },
    async version() { if (value === undefined) throw new Error("missing"); return version; },
    async remove() { value = undefined; version = "missing"; },
    async status() { return value === undefined ? "missing" : "available"; },
  };
  return { store, get version() { return version; }, get value() { return value; } };
}

function profile(flow: OAuthProfile["flow"], refreshTokenRef?: OAuthProfile["refreshTokenRef"]): OAuthProfile {
  return {
    profileId: "profile-primary",
    environmentId: "env-development",
    flow,
    tokenEndpoint: "https://issuer.example.test/oauth/token",
    clientId: "synthetic-client",
    clientAuthentication: flow === "client_credentials" ? "client_secret_post" : "none",
    bearerRef: BEARER,
    ...(flow === "client_credentials" ? { clientSecretRef: CLIENT_SECRET } : {}),
    ...(refreshTokenRef === undefined ? {} : { refreshTokenRef }),
    ...(flow === "authorization_code" ? { authorizationEndpoint: "https://issuer.example.test/oauth/authorize" } : {}),
  };
}

async function setup(recordProfile: OAuthProfile, state: OAuthProfileRecord["state"], initialBearer?: string) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "apicc-oauth-coordinator-"));
  const privateRoot = join(workspaceRoot, "private");
  await mkdir(privateRoot, { recursive: true });
  const secret = makeSecretStore();
  if (initialBearer !== undefined) await secret.store.put(PROJECT, BEARER, initialBearer);
  if (recordProfile.clientSecretRef !== undefined) {
    await secret.store.put(PROJECT, recordProfile.clientSecretRef, "synthetic-client-secret");
  }
  const host = await createOAuthProfileHost({ workspaceRoot, project: PROJECT, environmentId: "env-development", privateRoot, secretStore: secret.store });
  const record: OAuthProfileRecord = {
    canonicalRoot: host.scope.canonicalRoot,
    profile: recordProfile,
    state,
    credentialVersions: initialBearer === undefined ? {} : { accessToken: await secret.store.version(PROJECT, BEARER) },
  };
  await host.store.save(host.scope, [record], "missing");
  return { workspaceRoot, privateRoot, secret, host, cleanup: () => rm(workspaceRoot, { recursive: true, force: true }) };
}

describe("OAuth bearer preparation coordinator", () => {
  it("returns a revision and summaries from one captured profile document", async () => {
    const fixture = await setup(profile("client_credentials"), { status: "unconfigured" });
    const initial = await fixture.host.store.load(fixture.host.scope);
    const originalLoad = fixture.host.store.load.bind(fixture.host.store);
    let interleave = true;
    fixture.host.store.load = async (scope) => {
      const loaded = await originalLoad(scope);
      if (interleave) {
        interleave = false;
        const saved = await fixture.host.saveProfile({
          ...profile("client_credentials"),
          profileId: "profile-secondary",
          bearerRef: { id: "synthetic-secondary-oauth-bearer", policy: "test-auto" },
        }, { expectedRevision: loaded.revision });
        expect(saved).toEqual({ status: "success" });
      }
      return loaded;
    };
    try {
      const snapshot = await fixture.host.listProfilesSnapshot();
      const current = await originalLoad(fixture.host.scope);
      expect(snapshot.revision).toBe(initial.revision);
      expect(snapshot.profiles.map((item) => item.profile.profileId)).toEqual(["profile-primary"]);
      expect(current.revision).not.toBe(snapshot.revision);
      expect(current.profiles).toHaveLength(2);
    } finally {
      fixture.host.store.load = originalLoad;
      await fixture.cleanup();
    }
  });

  it("shares a deferred explicit exchange and returns the same safe result to both callers", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let tokenPosts = 0;
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume request */ }
      tokenPosts += 1;
      entered.resolve();
      await release.promise;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ access_token: "synthetic-explicit-access", token_type: "Bearer", expires_in: 300 }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const tokenEndpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/token`;
    const fixture = await setup(profile("client_credentials"), { status: "unconfigured" });
    try {
      expect(await fixture.host.saveProfile({
        ...profile("client_credentials"),
        tokenEndpoint,
      }, { clientSecret: "synthetic-client-secret" })).toEqual({ status: "success" });
      const selected = (await fixture.host.listProfiles())[0]!;
      const coordinator = createOAuthProfileCoordinator({
        workspaceRoot: fixture.workspaceRoot,
        project: PROJECT,
        environmentId: "env-development",
        privateRoot: fixture.privateRoot,
        secretStore: fixture.secret.store,
      });
      const input = {
        profileId: selected.profile.profileId,
        grant: { type: "client_credentials" as const },
        expectedConfigurationFingerprint: selected.configurationFingerprint,
      };
      const first = coordinator.exchangeOAuthProfile(input);
      await entered.promise;
      const second = coordinator.exchangeOAuthProfile(input);
      await Promise.resolve();
      expect(tokenPosts).toBe(1);
      release.resolve();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult).toEqual(secondResult);
      expect(firstResult).toMatchObject({ status: "success", expiresAt: expect.any(Number) });
      expect(tokenPosts).toBe(1);
    } finally {
      release.resolve();
      await fixture.cleanup();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("shares one in-flight client-credential acquisition and leaves one captured bearer version", async () => {
    const fixture = await setup(profile("client_credentials"), { status: "unconfigured" });
    const entered = deferred<void>();
    const release = deferred<void>();
    let exchanges = 0;
    let exchangeSignal: AbortSignal | undefined;
    try {
      const coordinator = createOAuthProfileCoordinator({
        workspaceRoot: fixture.workspaceRoot,
        project: PROJECT,
        environmentId: "env-development",
        privateRoot: fixture.privateRoot,
        secretStore: fixture.secret.store,
        now: () => NOW,
        exchange: async ({ grant, signal }) => {
          expect(grant.type).toBe("client_credentials");
          exchanges += 1;
          exchangeSignal = signal;
          entered.resolve();
          await release.promise;
          await fixture.secret.store.put(PROJECT, BEARER, "synthetic-access-token");
          const loaded = await fixture.host.store.load(fixture.host.scope);
          const previous = loaded.profiles[0]!;
          await fixture.host.store.save(fixture.host.scope, [{
            ...previous,
            state: { status: "connected", expiresAt: NOW + 120_000 },
            credentialVersions: { accessToken: await fixture.secret.store.version(PROJECT, BEARER) },
          }], loaded.revision);
          return { status: "success", expiresAt: NOW + 120_000 };
        },
      });
      const input = { scope: PROJECT, environmentId: "env-development", refs: [BEARER] };
      const firstCaller = new AbortController();
      const secondCaller = new AbortController();
      const first = coordinator.prepareOAuthBearerRefs({ ...input, signal: firstCaller.signal });
      await entered.promise;
      const second = coordinator.prepareOAuthBearerRefs({ ...input, signal: secondCaller.signal });
      await Promise.resolve();
      expect(exchanges).toBe(1);
      firstCaller.abort();
      await expect(first).rejects.toMatchObject({ code: "OAUTH_REQUEST_ABORTED" } satisfies Partial<OAuthError>);
      expect(exchangeSignal?.aborted).toBe(false);
      release.resolve();
      await second;
      await coordinator.prepareOAuthBearerRefs(input);
      expect(exchanges).toBe(1);
      expect(fixture.secret.value).toBe("synthetic-access-token");
      expect(fixture.secret.version).toBe("version-2");
    } finally {
      release.resolve();
      await fixture.cleanup();
    }
  });

  it("requires interactive authorization for an expired authorization-code profile without refresh", async () => {
    const fixture = await setup(profile("authorization_code"), {
      status: "connected",
      expiresAt: NOW - 1,
    }, "synthetic-expired-token");
    let exchanges = 0;
    try {
      const coordinator = createOAuthProfileCoordinator({
        workspaceRoot: fixture.workspaceRoot,
        project: PROJECT,
        environmentId: "env-development",
        privateRoot: fixture.privateRoot,
        secretStore: fixture.secret.store,
        now: () => NOW,
        exchange: async () => { exchanges += 1; return { status: "success" }; },
      });
      await expect(coordinator.prepareOAuthBearerRefs({
        scope: PROJECT,
        environmentId: "env-development",
        refs: [BEARER],
      })).rejects.toMatchObject({ code: "OAUTH_AUTHORIZATION_REQUIRED" } satisfies Partial<OAuthError>);
      expect(exchanges).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  });
});

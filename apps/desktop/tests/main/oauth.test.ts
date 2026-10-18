import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOAuthProfileHost, createNetworkProfileHost, type SecretStore } from "@apicc/core";
import { afterEach, describe, expect, it } from "vitest";
import { createOAuthAuthorizationSessionManager } from "../../src/main/oauth.js";

const PROJECT = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  groupId: "00000000-0000-4000-8000-000000000002",
  projectId: "00000000-0000-4000-8000-000000000003",
};
const ENVIRONMENT = "synthetic-environment";

function memorySecrets() {
  const values = new Map<string, string>();
  const versions = new Map<string, number>();
  let nextVersion = 0;
  const store: SecretStore = {
    async put(_scope, ref, value) {
      values.set(ref.id, value);
      versions.set(ref.id, ++nextVersion);
    },
    async resolve(_scope, ref, expectedVersion) {
      if (expectedVersion !== undefined && expectedVersion !== String(versions.get(ref.id))) throw new Error("version mismatch");
      const value = values.get(ref.id);
      if (value === undefined) throw new Error("missing secret");
      return value;
    },
    async version(_scope, ref) {
      const version = versions.get(ref.id);
      if (version === undefined) throw new Error("missing secret");
      return String(version);
    },
    async remove(_scope, ref) { values.delete(ref.id); versions.delete(ref.id); },
    async status(_scope, ref) { return values.has(ref.id) ? "available" : "missing"; },
  };
  return { store, values };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected TCP listener");
  return address.port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function fixture(tokenEndpoint: string, authorizationEndpoint: string) {
  const directory = await mkdtemp(join(tmpdir(), "apicc-desktop-oauth-"));
  const workspaceRoot = join(directory, "workspace");
  const oauthPrivateRoot = join(directory, "oauth-private");
  const networkPrivateRoot = join(directory, "network-private");
  await Promise.all([mkdir(workspaceRoot), mkdir(oauthPrivateRoot), mkdir(networkPrivateRoot)]);
  const secrets = memorySecrets();
  const host = await createOAuthProfileHost({
    workspaceRoot,
    project: PROJECT,
    environmentId: ENVIRONMENT,
    privateRoot: oauthPrivateRoot,
    secretStore: secrets.store,
  });
  await host.saveProfile({
    profileId: "synthetic-profile",
    environmentId: ENVIRONMENT,
    flow: "authorization_code",
    authorizationEndpoint,
    tokenEndpoint,
    clientId: "synthetic-client-id",
    clientAuthentication: "none",
    bearerRef: { id: "synthetic-access-ref", policy: "test-auto" },
  });
  const networkHost = await createNetworkProfileHost({
    workspaceRoot,
    project: PROJECT,
    environmentId: ENVIRONMENT,
    privateRoot: networkPrivateRoot,
    secretStore: secrets.store,
  });
  const network = await networkHost.prepare();
  return { directory, host, network, secrets };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
});

describe("desktop OAuth authorization callback", () => {
  it("binds one owner session and exchanges a local authorization code with its S256 verifier", async () => {
    let authorizeUrl: URL | undefined;
    let receivedForm: URLSearchParams | undefined;
    const tokenServer = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      receivedForm = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ access_token: "synthetic-access-token", token_type: "Bearer", expires_in: 300 }));
    });
    servers.push(tokenServer);
    const tokenPort = await listen(tokenServer);
    const authorizationServer = createServer((request, response) => {
      authorizeUrl = new URL(request.url ?? "/", `http://${request.headers.host}`);
      const redirect = new URL(authorizeUrl.searchParams.get("redirect_uri")!);
      redirect.searchParams.set("code", "synthetic-authorization-code");
      redirect.searchParams.set("state", authorizeUrl.searchParams.get("state")!);
      response.writeHead(302, { location: redirect.toString() });
      response.end();
    });
    servers.push(authorizationServer);
    const authorizationPort = await listen(authorizationServer);
    const data = await fixture(`http://127.0.0.1:${tokenPort}/token`, `http://127.0.0.1:${authorizationPort}/authorize`);
    const owner = {};
    const manager = createOAuthAuthorizationSessionManager({
      openExternal: async (url) => {
        const result = await fetch(url);
        await result.text();
      },
    });
    try {
      const session = await manager.begin(owner, data.host, "synthetic-profile", { network: data.network });
      expect(session.status).toBe("pending");
      const completed = await manager.wait(owner, session.sessionId);
      expect(completed?.status).toBe("success");
      expect(completed?.sessionExpiresAt).toBeGreaterThan(Date.now());
      expect(completed?.operationResult).toMatchObject({ status: "success", expiresAt: expect.any(Number) });
      expect(completed?.operationResult?.expiresAt).toBeGreaterThan(Date.now());
      expect(authorizeUrl?.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorizeUrl?.searchParams.get("response_type")).toBe("code");
      expect(receivedForm?.get("grant_type")).toBe("authorization_code");
      expect(receivedForm?.get("code")).toBe("synthetic-authorization-code");
      const verifier = receivedForm?.get("code_verifier");
      expect(verifier).toBeTruthy();
      const challenge = createHash("sha256").update(verifier!, "utf8").digest("base64url");
      expect(authorizeUrl?.searchParams.get("code_challenge")).toBe(challenge);
      expect(data.secrets.values.get("synthetic-access-ref")).toBe("synthetic-access-token");
      expect(manager.status({}, session.sessionId)).toBeUndefined();
    } finally {
      manager.closeOwner(owner);
      await rm(data.directory, { recursive: true, force: true });
    }
  });

  it("keeps the cancelled public result unchanged when its exchange completes late", async () => {
    const tokenEntered = deferred<void>();
    const releaseTokenResponse = deferred<void>();
    const exchangeFinished = deferred<void>();
    const tokenServer = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume request */ }
      tokenEntered.resolve();
      await releaseTokenResponse.promise;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ access_token: "synthetic-late-access-token", token_type: "Bearer", expires_in: 300 }));
    });
    servers.push(tokenServer);
    const tokenPort = await listen(tokenServer);
    const authorizationServer = createServer((request, response) => {
      const authorizeUrl = new URL(request.url ?? "/", `http://${request.headers.host}`);
      const callback = new URL(authorizeUrl.searchParams.get("redirect_uri")!);
      callback.searchParams.set("code", "synthetic-late-authorization-code");
      callback.searchParams.set("state", authorizeUrl.searchParams.get("state")!);
      response.writeHead(302, { location: callback.toString() });
      response.end();
    });
    servers.push(authorizationServer);
    const authorizationPort = await listen(authorizationServer);
    const data = await fixture(`http://127.0.0.1:${tokenPort}/token`, `http://127.0.0.1:${authorizationPort}/authorize`);
    const owner = {};
    const originalExchange = data.host.exchange.bind(data.host);
    const trackedHost = {
      ...data.host,
      async exchange(...args: Parameters<typeof data.host.exchange>) {
        try { return await originalExchange(...args); }
        finally { exchangeFinished.resolve(); }
      },
    };
    const manager = createOAuthAuthorizationSessionManager({
      openExternal: async (url) => { const result = await fetch(url); await result.text(); },
    });
    try {
      const session = await manager.begin(owner, trackedHost, "synthetic-profile", { network: data.network });
      await tokenEntered.promise;
      const cancelled = manager.cancel(owner, session.sessionId);
      expect(cancelled).toMatchObject({ status: "cancelled" });
      await expect(manager.wait(owner, session.sessionId)).resolves.toEqual(cancelled);
      releaseTokenResponse.resolve();
      await exchangeFinished.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(manager.status(owner, session.sessionId)).toEqual(cancelled);
    } finally {
      releaseTokenResponse.resolve();
      manager.closeOwner(owner);
      await rm(data.directory, { recursive: true, force: true });
    }
  });

  it("rejects a foreign owner and a bad state, then cancels and releases the loopback listener", async () => {
    let opened = "";
    const authorizationServer = createServer((_request, response) => { response.writeHead(204); response.end(); });
    servers.push(authorizationServer);
    const issuerPort = await listen(authorizationServer);
    const data = await fixture(`http://127.0.0.1:${issuerPort}/token`, `http://127.0.0.1:${issuerPort}/authorize`);
    const owner = {};
    const otherOwner = {};
    const manager = createOAuthAuthorizationSessionManager({ openExternal: async (url) => { opened = url; } });
    try {
      const session = await manager.begin(owner, data.host, "synthetic-profile", { network: data.network });
      const authorizeUrl = new URL(opened);
      const callback = new URL(authorizeUrl.searchParams.get("redirect_uri")!);
      callback.searchParams.set("code", "forged-code");
      callback.searchParams.set("state", "wrong-state");
      const rejected = await fetch(callback);
      expect(rejected.status).toBe(400);
      expect(manager.status(otherOwner, session.sessionId)).toBeUndefined();
      expect(manager.cancel(otherOwner, session.sessionId)).toBeUndefined();
      expect(manager.cancel(owner, session.sessionId)?.status).toBe("cancelled");
      expect(manager.status(owner, session.sessionId)?.status).toBe("cancelled");
      await expect(manager.wait(owner, session.sessionId)).resolves.toMatchObject({ status: "cancelled" });
      await expect(fetch(callback)).rejects.toBeTruthy();

      const expiringManager = createOAuthAuthorizationSessionManager({ openExternal: async (url) => { opened = url; }, lifetimeMs: 10 });
      const expiring = await expiringManager.begin(owner, data.host, "synthetic-profile", { network: data.network });
      await expect(expiringManager.wait(owner, expiring.sessionId)).resolves.toMatchObject({
        status: "failed",
        errorCode: "OAUTH_REQUEST_TIMEOUT",
        operationResult: { status: "failed", errorCode: "OAUTH_REQUEST_TIMEOUT" },
      });
      const timeoutCallback = new URL(new URL(opened).searchParams.get("redirect_uri")!);
      await expect(fetch(timeoutCallback)).rejects.toBeTruthy();

      const destroyedOwner = {};
      const destroyed = await expiringManager.begin(destroyedOwner, data.host, "synthetic-profile", { network: data.network });
      const destroyedCallback = new URL(new URL(opened).searchParams.get("redirect_uri")!);
      expiringManager.closeOwner(destroyedOwner);
      expect(expiringManager.status(destroyedOwner, destroyed.sessionId)).toBeUndefined();
      await expect(fetch(destroyedCallback)).rejects.toBeTruthy();
      expiringManager.closeOwner(owner);
    } finally {
      manager.closeOwner(owner);
      await rm(data.directory, { recursive: true, force: true });
    }
  });
});

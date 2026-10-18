import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";

import { createOAuthPkceChallenge, OAuthError, type OAuthErrorCode, type OAuthProfileHost, type OAuthPublicResult } from "@apicc/core";
import type { PreparedNetworkRun } from "@apicc/core";

const CALLBACK_PATH = "/oauth/callback";
const CALLBACK_LIFETIME_MS = 5 * 60_000;
const MAX_CALLBACK_URL_LENGTH = 16_384;

export type OAuthAuthorizationSessionStatus = "pending" | "success" | "failed" | "cancelled";

export interface OAuthAuthorizationSessionView {
  sessionId: string;
  profileId: string;
  status: OAuthAuthorizationSessionStatus;
  sessionExpiresAt: number;
  errorCode?: string;
  operationResult?: OAuthPublicResult;
}

export interface OAuthAuthorizationBeginOptions {
  listenPort?: number;
  listenHost?: "127.0.0.1" | "::1";
  network?: PreparedNetworkRun;
}

export interface OAuthAuthorizationSessionManagerOptions {
  openExternal(url: string): Promise<void>;
  /** Test-only clock/timer seam; production remains the reviewed five-minute lifetime. */
  lifetimeMs?: number;
}

interface Session {
  id: string;
  owner: object;
  profileKey: string;
  profileId: string;
  host: OAuthProfileHost;
  fingerprint: string;
  verifier: string;
  state: string;
  redirectUri: string;
  listenHost: "127.0.0.1" | "::1";
  network?: PreparedNetworkRun;
  server: Server;
  timer: ReturnType<typeof setTimeout>;
  sessionExpiresAt: number;
  status: OAuthAuthorizationSessionStatus;
  errorCode?: string;
  result?: OAuthPublicResult;
  exchangeController?: AbortController;
  terminalWaiters: Set<() => void>;
  callbackReceived: boolean;
}

function profileKey(host: OAuthProfileHost, profileId: string): string {
  return JSON.stringify([
    host.scope.canonicalRoot,
    host.scope.project.workspaceId,
    host.scope.project.groupId,
    host.scope.project.projectId,
    host.scope.environmentId ?? null,
    profileId,
  ]);
}

function publicView(session: Session): OAuthAuthorizationSessionView {
  return {
    sessionId: session.id,
    profileId: session.profileId,
    status: session.status,
    sessionExpiresAt: session.sessionExpiresAt,
    ...(session.errorCode === undefined ? {} : { errorCode: session.errorCode }),
    ...(session.result === undefined ? {} : { operationResult: session.result }),
  };
}

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::ffff:127.0.0.1" || address === "::1";
}

function formatHost(host: "127.0.0.1" | "::1"): string {
  return host.includes(":") ? `[${host}]` : host;
}

function safeStateEquals(actual: string, expected: string): boolean {
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function serverListen(server: Server, port: number, host: "127.0.0.1" | "::1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new OAuthError("OAUTH_PROFILE_INVALID"));
        return;
      }
      resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export function createOAuthAuthorizationSessionManager(options: OAuthAuthorizationSessionManagerOptions) {
  const sessions = new Map<string, Session>();
  const activeProfiles = new Map<string, Session>();
  const ownerSessions = new WeakMap<object, Set<string>>();
  const lifetimeMs = options.lifetimeMs ?? CALLBACK_LIFETIME_MS;

  const closeListener = (server: Server): void => {
    if (server.listening) server.close();
  };

  const finish = (
    session: Session,
    status: Exclude<OAuthAuthorizationSessionStatus, "pending">,
    errorCode?: OAuthErrorCode,
    result?: OAuthPublicResult,
  ): void => {
    if (session.status !== "pending") return;
    session.status = status;
    session.errorCode = errorCode;
    if (result !== undefined) session.result = result;
    else if (errorCode !== undefined && session.result === undefined) {
      session.result = { status: "failed", errorCode };
    }
    clearTimeout(session.timer);
    closeListener(session.server);
    session.exchangeController = undefined;
    activeProfiles.delete(session.profileKey);
    for (const resolve of session.terminalWaiters) resolve();
    session.terminalWaiters.clear();
  };

  const handleCallback = (session: Session, request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): void => {
    const address = session.server.address();
    const expectedHost = address && typeof address !== "string" ? `${formatHost(session.listenHost)}:${address.port}` : "";
    const rawUrl = request.url ?? "";
    let parsed: URL | undefined;
    if (rawUrl.length <= MAX_CALLBACK_URL_LENGTH) {
      try { parsed = new URL(rawUrl, `http://${expectedHost}`); } catch { parsed = undefined; }
    }
    const query = parsed?.searchParams;
    const stateValues = query?.getAll("state") ?? [];
    const codeValues = query?.getAll("code") ?? [];
    const errorValues = query?.getAll("error") ?? [];
    const valid = session.status === "pending"
      && !session.callbackReceived
      && request.method === "GET"
      && isLoopback(request.socket.remoteAddress)
      && request.headers.host === expectedHost
      && parsed?.origin === `http://${expectedHost}`
      && parsed?.pathname === CALLBACK_PATH
      && stateValues.length === 1
      && safeStateEquals(stateValues[0] ?? "", session.state)
      && ((codeValues.length === 1 && codeValues[0]!.length > 0 && errorValues.length === 0)
        || (errorValues.length === 1 && errorValues[0]!.length > 0 && codeValues.length === 0));
    if (!valid) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      response.end("OAuth callback rejected. Return to APICC.");
      return;
    }

    // Claim the callback synchronously before responding or starting asynchronous token exchange.
    // A second request cannot reuse this state/code while the first exchange is still in flight.
    session.callbackReceived = true;

    response.writeHead(errorValues.length === 1 ? 400 : 200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    response.end(errorValues.length === 1 ? "Authorization was not completed. Return to APICC." : "Authorization received. Return to APICC.");
    if (errorValues.length === 1) {
      finish(session, "failed", "OAUTH_TOKEN_ENDPOINT_REJECTED");
      return;
    }

    const controller = new AbortController();
    session.exchangeController = controller;
    void session.host.exchange(session.profileId, {
      type: "authorization_code",
      code: codeValues[0]!,
      verifier: session.verifier,
      redirectUri: session.redirectUri,
    }, {
      ...(session.network === undefined ? {} : { network: session.network }),
      signal: controller.signal,
      expectedConfigurationFingerprint: session.fingerprint,
    }).then((result) => {
      if (result.status === "success") finish(session, "success", undefined, result);
      else finish(session, "failed", result.errorCode ?? "OAUTH_TOKEN_REQUEST_FAILED", result);
    }, (error: unknown) => {
      const code = error instanceof OAuthError ? error.code : "OAUTH_TOKEN_REQUEST_FAILED";
      finish(session, "failed", code, { status: "failed", errorCode: code });
    });
  };

  const cancel = (session: Session, reason: "cancelled" | "failed", errorCode?: OAuthErrorCode): void => {
    if (session.status !== "pending") return;
    session.exchangeController?.abort();
    finish(session, reason, errorCode);
  };

  return Object.freeze({
    async begin(
      owner: object,
      host: OAuthProfileHost,
      profileId: string,
      beginOptions: OAuthAuthorizationBeginOptions = {},
    ): Promise<OAuthAuthorizationSessionView> {
      if (typeof owner !== "object" || owner === null) throw new OAuthError("OAUTH_PROFILE_INVALID");
      const current = (await host.listProfiles()).find((item) => item.profile.profileId === profileId);
      if (current === undefined) throw new OAuthError("OAUTH_PROFILE_NOT_FOUND");
      if (current.profile.flow !== "authorization_code" || current.profile.authorizationEndpoint === undefined) {
        throw new OAuthError("OAUTH_PROFILE_INVALID");
      }
      const port = beginOptions.listenPort ?? 0;
      if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) throw new OAuthError("OAUTH_PROFILE_INVALID");
      const listenHost = beginOptions.listenHost ?? "127.0.0.1";
      if (listenHost !== "127.0.0.1" && listenHost !== "::1") throw new OAuthError("OAUTH_PROFILE_INVALID");

      const key = profileKey(host, profileId);
      const active = activeProfiles.get(key);
      if (active !== undefined) {
        if (active.owner === owner && active.status === "pending") return publicView(active);
        throw new OAuthError("OAUTH_COORDINATION_BUSY");
      }

      const verifier = randomBytes(32).toString("base64url");
      const state = randomBytes(32).toString("base64url");
      const server = createServer((request, response) => handleCallback(session, request, response));
      let session!: Session;
      const sessionId = randomUUID();
      const ownerSessionsForOwner = ownerSessions.get(owner) ?? new Set<string>();
      ownerSessions.set(owner, ownerSessionsForOwner);
      session = {
        id: sessionId,
        owner,
        profileKey: key,
        profileId,
        host,
        fingerprint: current.configurationFingerprint,
        verifier,
        state,
        redirectUri: "",
        listenHost,
        ...(beginOptions.network === undefined ? {} : { network: beginOptions.network }),
        server,
        timer: setTimeout(() => cancel(session, "failed", "OAUTH_REQUEST_TIMEOUT"), lifetimeMs),
        sessionExpiresAt: Date.now() + lifetimeMs,
        status: "pending",
        terminalWaiters: new Set(),
        callbackReceived: false,
      };
      sessions.set(sessionId, session);
      ownerSessionsForOwner.add(sessionId);
      activeProfiles.set(key, session);

      try {
        const boundPort = await serverListen(server, port, listenHost);
        const redirectUri = `http://${formatHost(listenHost)}:${boundPort}${CALLBACK_PATH}`;
        session.redirectUri = redirectUri;
        const authorizeUrl = new URL(current.profile.authorizationEndpoint);
        authorizeUrl.searchParams.set("response_type", "code");
        authorizeUrl.searchParams.set("client_id", current.profile.clientId);
        authorizeUrl.searchParams.set("redirect_uri", redirectUri);
        if (current.profile.scope !== undefined) authorizeUrl.searchParams.set("scope", current.profile.scope);
        authorizeUrl.searchParams.set("state", state);
        authorizeUrl.searchParams.set("code_challenge", createOAuthPkceChallenge(verifier));
        authorizeUrl.searchParams.set("code_challenge_method", "S256");
        await options.openExternal(authorizeUrl.toString());
        return publicView(session);
      } catch {
        cancel(session, "failed", "OAUTH_TOKEN_REQUEST_FAILED");
        throw new OAuthError("OAUTH_TOKEN_REQUEST_FAILED");
      }
    },

    status(owner: object, sessionId: string): OAuthAuthorizationSessionView | undefined {
      const session = sessions.get(sessionId);
      if (session === undefined || session.owner !== owner) return undefined;
      return publicView(session);
    },

    async wait(owner: object, sessionId: string): Promise<OAuthAuthorizationSessionView | undefined> {
      const session = sessions.get(sessionId);
      if (session === undefined || session.owner !== owner) return undefined;
      if (session.status !== "pending") return publicView(session);
      await new Promise<void>((resolve) => { session.terminalWaiters.add(resolve); });
      return publicView(session);
    },

    cancel(owner: object, sessionId: string): OAuthAuthorizationSessionView | undefined {
      const session = sessions.get(sessionId);
      if (session === undefined || session.owner !== owner) return undefined;
      cancel(session, "cancelled");
      return publicView(session);
    },

    closeOwner(owner: object): void {
      const owned = ownerSessions.get(owner);
      if (owned === undefined) return;
      for (const sessionId of owned) {
        const session = sessions.get(sessionId);
        if (session?.status === "pending") cancel(session, "cancelled");
        sessions.delete(sessionId);
      }
      ownerSessions.delete(owner);
    },
  });
}

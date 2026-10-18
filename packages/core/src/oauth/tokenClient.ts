import { createHash } from "node:crypto";

import { createHttpClient } from "../http/client.js";
import type { PreparedNetworkRun } from "../network/prepare.js";
import type { ExecutableRequest } from "../plugin/types.js";
import { OAuthError, OAuthProfileSchema, type OAuthProfile } from "./model.js";

export type OAuthTokenGrant =
  | { type: "client_credentials" }
  | { type: "authorization_code"; code: string; verifier: string; redirectUri: string }
  | { type: "refresh_token" };

/** Secrets selected by the host for one exchange; this is not a SecretStore enumeration API. */
export interface OAuthTokenSecrets {
  clientSecret?: string;
  refreshToken?: string;
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  tokenType: "Bearer";
  expiresIn?: number;
  scope?: string;
}

export interface ExchangeOAuthTokenOptions {
  profile: OAuthProfile;
  grant: OAuthTokenGrant;
  secrets: OAuthTokenSecrets;
  network?: PreparedNetworkRun;
  signal?: AbortSignal;
}

export function createOAuthPkceChallenge(verifier: string): string {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) throw new OAuthError("OAUTH_PKCE_VERIFIER_INVALID");
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function formEncodeComponent(value: string): string {
  return new URLSearchParams([["value", value]]).toString().slice("value=".length);
}

function validateGrant(profile: OAuthProfile, grant: OAuthTokenGrant, secrets: OAuthTokenSecrets): void {
  if ((grant.type === "client_credentials" && profile.flow !== "client_credentials")
    || (grant.type === "authorization_code" && profile.flow !== "authorization_code")
    || (grant.type === "refresh_token" && profile.flow === "client_credentials")) {
    throw new OAuthError("OAUTH_PROFILE_INVALID");
  }
  if (profile.clientAuthentication !== "none" && (typeof secrets.clientSecret !== "string" || secrets.clientSecret.length === 0)) {
    throw new OAuthError("OAUTH_CLIENT_SECRET_MISSING");
  }
  if (grant.type === "refresh_token" && (typeof secrets.refreshToken !== "string" || secrets.refreshToken.length === 0)) {
    throw new OAuthError("OAUTH_REFRESH_TOKEN_MISSING");
  }
  if (grant.type === "authorization_code") {
    if (grant.code.length === 0 || grant.redirectUri.length === 0 || grant.code.length > 8192 || grant.redirectUri.length > 4096) {
      throw new OAuthError("OAUTH_PROFILE_INVALID");
    }
    createOAuthPkceChallenge(grant.verifier);
  }
}

function buildTokenRequest(options: ExchangeOAuthTokenOptions): ExecutableRequest {
  const { profile, grant, secrets } = options;
  const params = new URLSearchParams();
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  };

  params.set("grant_type", grant.type);
  if (grant.type !== "refresh_token" && profile.scope !== undefined) params.set("scope", profile.scope);

  if (grant.type === "authorization_code") {
    params.set("code", grant.code);
    params.set("redirect_uri", grant.redirectUri);
    params.set("code_verifier", grant.verifier);
  } else if (grant.type === "refresh_token") {
    params.set("refresh_token", secrets.refreshToken!);
  }

  if (profile.clientAuthentication === "client_secret_basic") {
    const encodedId = formEncodeComponent(profile.clientId);
    const encodedSecret = formEncodeComponent(secrets.clientSecret!);
    headers.authorization = `Basic ${Buffer.from(`${encodedId}:${encodedSecret}`, "utf8").toString("base64")}`;
  } else {
    params.set("client_id", profile.clientId);
    if (profile.clientAuthentication === "client_secret_post") params.set("client_secret", secrets.clientSecret!);
  }

  return {
    protocol: "http",
    method: "POST",
    url: profile.tokenEndpoint,
    headers,
    query: [],
    auth: { kind: "none" },
    cookieHeaderMode: "none",
    body: { kind: "raw", content: params.toString() },
  };
}

function errorCode(error: unknown, signal?: AbortSignal): "OAUTH_REQUEST_ABORTED" | "OAUTH_REQUEST_TIMEOUT" | "OAUTH_TOKEN_REQUEST_FAILED" {
  const details = error as { name?: unknown; code?: unknown; kind?: unknown };
  if (signal?.aborted || details?.name === "AbortError" || details?.code === "REQUEST_ABORTED") return "OAUTH_REQUEST_ABORTED";
  if (details?.kind === "timeout" || details?.code === "REQUEST_TIMEOUT" || details?.code === "UND_ERR_CONNECT_TIMEOUT") {
    return "OAUTH_REQUEST_TIMEOUT";
  }
  return "OAUTH_TOKEN_REQUEST_FAILED";
}

function parseTokenResponse(bodyText: string): OAuthTokenSet {
  let value: unknown;
  try {
    value = JSON.parse(bodyText);
  } catch {
    throw new OAuthError("OAUTH_TOKEN_RESPONSE_INVALID");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OAuthError("OAUTH_TOKEN_RESPONSE_INVALID");
  }

  const response = value as Record<string, unknown>;
  if (typeof response.access_token !== "string" || response.access_token.trim().length === 0) {
    throw new OAuthError("OAUTH_ACCESS_TOKEN_MISSING");
  }
  if (typeof response.token_type !== "string" || response.token_type.toLowerCase() !== "bearer") {
    throw new OAuthError("OAUTH_TOKEN_TYPE_UNSUPPORTED");
  }

  let expiresIn: number | undefined;
  if (response.expires_in !== undefined) {
    if (typeof response.expires_in === "number" && Number.isFinite(response.expires_in) && response.expires_in >= 0) {
      expiresIn = response.expires_in;
    } else if (typeof response.expires_in === "string" && /^\d+$/.test(response.expires_in)) {
      const parsed = Number(response.expires_in);
      if (Number.isSafeInteger(parsed)) expiresIn = parsed;
      else throw new OAuthError("OAUTH_TOKEN_RESPONSE_INVALID");
    } else {
      throw new OAuthError("OAUTH_TOKEN_RESPONSE_INVALID");
    }
  }
  if (response.refresh_token !== undefined && typeof response.refresh_token !== "string") {
    throw new OAuthError("OAUTH_TOKEN_RESPONSE_INVALID");
  }
  if (response.scope !== undefined && typeof response.scope !== "string") {
    throw new OAuthError("OAUTH_TOKEN_RESPONSE_INVALID");
  }

  return {
    accessToken: response.access_token,
    ...(typeof response.refresh_token === "string" ? { refreshToken: response.refresh_token } : {}),
    tokenType: "Bearer",
    ...(expiresIn === undefined ? {} : { expiresIn }),
    ...(typeof response.scope === "string" ? { scope: response.scope } : {}),
  };
}

/** Exchanges a single OAuth grant through the reviewed host HTTP runtime. */
export async function exchangeOAuthToken(options: ExchangeOAuthTokenOptions): Promise<OAuthTokenSet> {
  const profileResult = OAuthProfileSchema.safeParse(options?.profile);
  if (!profileResult.success) throw new OAuthError("OAUTH_PROFILE_INVALID");
  if (!isSafeTokenEndpoint(profileResult.data.tokenEndpoint)) throw new OAuthError("OAUTH_TOKEN_ENDPOINT_INVALID");
  validateGrant(profileResult.data, options.grant, options.secrets);

  const client = createHttpClient({ connectionMode: "fresh" });
  try {
    let response;
    try {
      response = await client.execute(buildTokenRequest({ ...options, profile: profileResult.data }), {
        connectTimeoutMs: 30_000,
        totalTimeoutMs: 30_000,
        headersTimeoutMs: 30_000,
        bodyTimeoutMs: 30_000,
        followRedirects: false,
        maxRedirects: 0,
        responseLimitBytes: 1024 * 1024,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        runtime: options.network === undefined ? {} : { network: options.network },
      });
    } catch (error) {
      throw new OAuthError(errorCode(error, options.signal));
    }
    if (response.status < 200 || response.status >= 300 || response.textAvailable === false) {
      throw new OAuthError("OAUTH_TOKEN_ENDPOINT_REJECTED");
    }
    return parseTokenResponse(response.bodyText);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function isSafeTokenEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
    return (url.protocol === "https:" || (url.protocol === "http:" && loopback))
      && url.username.length === 0 && url.password.length === 0 && url.hash.length === 0;
  } catch {
    return false;
  }
}

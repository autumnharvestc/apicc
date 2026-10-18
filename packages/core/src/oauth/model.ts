import { z } from "zod";

import { SecretRefSchema, type SecretRef } from "../contract/request.js";
import { NetworkScopeSchema, type NetworkScope } from "../network/profiles.js";

const nonEmptyId = z.string().min(1).max(256);

export type OAuthScope = NetworkScope;
export const OAuthScopeSchema = NetworkScopeSchema;

export type OAuthFlow = "client_credentials" | "authorization_code" | "refresh_token";
export type OAuthClientAuthentication = "none" | "client_secret_basic" | "client_secret_post";

export interface OAuthProfile {
  profileId: string;
  scope?: string;
  environmentId?: string;
  flow: OAuthFlow;
  authorizationEndpoint?: string;
  tokenEndpoint: string;
  clientId: string;
  clientAuthentication: OAuthClientAuthentication;
  bearerRef: SecretRef;
  clientSecretRef?: SecretRef;
  refreshTokenRef?: SecretRef;
}

export type OAuthProfileStatus = "unconfigured" | "connected" | "partial_success" | "reauthorization_required" | "failed";
export type OAuthOperationStatus = "success" | "partial_success" | "reauthorization_required" | "failed";

export type OAuthErrorCode =
  | "OAUTH_PROFILE_INVALID"
  | "OAUTH_PROFILE_VERSION_UNSUPPORTED"
  | "OAUTH_PROFILE_STORAGE_FAILED"
  | "OAUTH_PROFILE_REVISION_CONFLICT"
  | "OAUTH_PROFILE_CONFIGURATION_CHANGED"
  | "OAUTH_PROFILE_NOT_FOUND"
  | "OAUTH_BEARER_REF_IN_USE"
  | "OAUTH_COORDINATION_BUSY"
  | "OAUTH_AUTHORIZATION_REQUIRED"
  | "OAUTH_SECRET_REF_INVALID"
  | "OAUTH_SECRET_MISSING"
  | "OAUTH_SECRET_UNAVAILABLE"
  | "OAUTH_SECRET_VERSION_CONFLICT"
  | "OAUTH_SECRET_SAVE_FAILED"
  | "OAUTH_TOKEN_ENDPOINT_INVALID"
  | "OAUTH_TOKEN_REQUEST_FAILED"
  | "OAUTH_REQUEST_TIMEOUT"
  | "OAUTH_REQUEST_ABORTED"
  | "OAUTH_TOKEN_ENDPOINT_REJECTED"
  | "OAUTH_TOKEN_RESPONSE_INVALID"
  | "OAUTH_ACCESS_TOKEN_MISSING"
  | "OAUTH_TOKEN_TYPE_UNSUPPORTED"
  | "OAUTH_CLIENT_SECRET_MISSING"
  | "OAUTH_REFRESH_TOKEN_MISSING"
  | "OAUTH_PKCE_VERIFIER_INVALID"
  | "OAUTH_REFRESH_REF_MISSING"
  | "OAUTH_ACCESS_TOKEN_SAVE_FAILED"
  | "OAUTH_REFRESH_TOKEN_SAVE_FAILED"
  | "OAUTH_METADATA_SAVE_FAILED";

export class OAuthError extends Error {
  constructor(readonly code: OAuthErrorCode) {
    super(code);
    this.name = "OAuthError";
  }
}

export interface OAuthProfileSummary {
  profile: OAuthProfile;
  configurationFingerprint: string;
  status: OAuthProfileStatus;
  expiresAt?: number;
  grantedScope?: string;
  errorCode?: OAuthErrorCode;
}

export interface OAuthPublicResult {
  status: OAuthOperationStatus;
  expiresAt?: number;
  errorCode?: OAuthErrorCode;
}

export interface OAuthProfileState {
  status: OAuthProfileStatus;
  expiresAt?: number;
  grantedScope?: string;
  errorCode?: OAuthErrorCode;
}

export interface OAuthCredentialVersions {
  accessToken?: string;
  clientSecret?: string;
  refreshToken?: string;
}

/** Private on-disk record; credential versions are not returned to renderer-facing callers. */
export interface OAuthProfileRecord {
  canonicalRoot: string;
  profile: OAuthProfile;
  configurationFingerprint?: string;
  state: OAuthProfileState;
  credentialVersions: OAuthCredentialVersions;
}

export interface OAuthProfileDocument {
  formatVersion: 1;
  profiles: OAuthProfileRecord[];
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function isAllowedEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname)))
      && url.username.length === 0
      && url.password.length === 0
      && url.hash.length === 0;
  } catch {
    return false;
  }
}

const endpoint = z.string().min(1).max(4096).refine(isAllowedEndpoint, "OAuth endpoints require HTTPS or explicit loopback HTTP.");
const secretRef = SecretRefSchema.refine((ref) => ref.policy === "test-auto", "OAuth credentials require the supported test-auto SecretStore policy.");

export const OAuthProfileSchema: z.ZodType<OAuthProfile> = z.object({
  profileId: nonEmptyId,
  scope: z.string().max(4096).optional(),
  environmentId: nonEmptyId.optional(),
  flow: z.enum(["client_credentials", "authorization_code", "refresh_token"]),
  authorizationEndpoint: endpoint.optional(),
  tokenEndpoint: endpoint,
  clientId: z.string().min(1).max(4096),
  clientAuthentication: z.enum(["none", "client_secret_basic", "client_secret_post"]),
  bearerRef: secretRef,
  clientSecretRef: secretRef.optional(),
  refreshTokenRef: secretRef.optional(),
}).strict().superRefine((profile, context) => {
  if (profile.flow === "authorization_code" && profile.authorizationEndpoint === undefined) {
    context.addIssue({ code: "custom", path: ["authorizationEndpoint"], message: "Authorization-code profiles require an authorization endpoint." });
  }
  if (profile.flow !== "authorization_code" && profile.authorizationEndpoint !== undefined) {
    context.addIssue({ code: "custom", path: ["authorizationEndpoint"], message: "Only authorization-code profiles have an authorization endpoint." });
  }
  if (profile.flow === "client_credentials" && profile.clientAuthentication === "none") {
    context.addIssue({ code: "custom", path: ["clientAuthentication"], message: "Client-credentials profiles require client-secret authentication." });
  }
  if ((profile.clientAuthentication === "none") !== (profile.clientSecretRef === undefined)) {
    context.addIssue({ code: "custom", path: ["clientSecretRef"], message: "Client-secret reference and authentication method must agree." });
  }
  if (profile.flow === "refresh_token" && profile.refreshTokenRef === undefined) {
    context.addIssue({ code: "custom", path: ["refreshTokenRef"], message: "Refresh-token profiles require a refresh-token reference." });
  }

  const refs = [profile.bearerRef, profile.clientSecretRef, profile.refreshTokenRef].filter((ref): ref is SecretRef => ref !== undefined);
  const ids = new Set<string>();
  for (const ref of refs) {
    if (ids.has(ref.id)) {
      context.addIssue({ code: "custom", path: ["bearerRef"], message: "OAuth credential references must be distinct." });
      break;
    }
    ids.add(ref.id);
  }
});

export const OAuthErrorCodeSchema: z.ZodType<OAuthErrorCode> = z.enum([
  "OAUTH_PROFILE_INVALID",
  "OAUTH_PROFILE_VERSION_UNSUPPORTED",
  "OAUTH_PROFILE_STORAGE_FAILED",
  "OAUTH_PROFILE_REVISION_CONFLICT",
  "OAUTH_PROFILE_CONFIGURATION_CHANGED",
  "OAUTH_PROFILE_NOT_FOUND",
  "OAUTH_BEARER_REF_IN_USE",
  "OAUTH_COORDINATION_BUSY",
  "OAUTH_AUTHORIZATION_REQUIRED",
  "OAUTH_SECRET_REF_INVALID",
  "OAUTH_SECRET_MISSING",
  "OAUTH_SECRET_UNAVAILABLE",
  "OAUTH_SECRET_VERSION_CONFLICT",
  "OAUTH_SECRET_SAVE_FAILED",
  "OAUTH_TOKEN_ENDPOINT_INVALID",
  "OAUTH_TOKEN_REQUEST_FAILED",
  "OAUTH_REQUEST_TIMEOUT",
  "OAUTH_REQUEST_ABORTED",
  "OAUTH_TOKEN_ENDPOINT_REJECTED",
  "OAUTH_TOKEN_RESPONSE_INVALID",
  "OAUTH_ACCESS_TOKEN_MISSING",
  "OAUTH_TOKEN_TYPE_UNSUPPORTED",
  "OAUTH_CLIENT_SECRET_MISSING",
  "OAUTH_REFRESH_TOKEN_MISSING",
  "OAUTH_PKCE_VERIFIER_INVALID",
  "OAUTH_REFRESH_REF_MISSING",
  "OAUTH_ACCESS_TOKEN_SAVE_FAILED",
  "OAUTH_REFRESH_TOKEN_SAVE_FAILED",
  "OAUTH_METADATA_SAVE_FAILED",
]);

export const OAuthProfileStatusSchema: z.ZodType<OAuthProfileStatus> = z.enum([
  "unconfigured", "connected", "partial_success", "reauthorization_required", "failed",
]);

export const OAuthOperationStatusSchema: z.ZodType<OAuthOperationStatus> = z.enum([
  "success", "partial_success", "reauthorization_required", "failed",
]);

export const OAuthProfileSummarySchema: z.ZodType<OAuthProfileSummary> = z.object({
  profile: OAuthProfileSchema,
  configurationFingerprint: z.string().min(1),
  status: OAuthProfileStatusSchema,
  expiresAt: z.number().finite().nonnegative().optional(),
  grantedScope: z.string().optional(),
  errorCode: OAuthErrorCodeSchema.optional(),
}).strict();

export const OAuthPublicResultSchema: z.ZodType<OAuthPublicResult> = z.object({
  status: OAuthOperationStatusSchema,
  expiresAt: z.number().finite().nonnegative().optional(),
  errorCode: OAuthErrorCodeSchema.optional(),
}).strict();

const oauthProfileStateSchema: z.ZodType<OAuthProfileState> = z.object({
  status: OAuthProfileStatusSchema,
  expiresAt: z.number().finite().nonnegative().optional(),
  grantedScope: z.string().optional(),
  errorCode: OAuthErrorCodeSchema.optional(),
}).strict();

const credentialVersionsSchema: z.ZodType<OAuthCredentialVersions> = z.object({
  accessToken: z.string().min(1).optional(),
  clientSecret: z.string().min(1).optional(),
  refreshToken: z.string().min(1).optional(),
}).strict();

function isCanonicalRoot(value: string): boolean {
  return value.startsWith("/") || value.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(value);
}

export const OAuthProfileRecordSchema: z.ZodType<OAuthProfileRecord> = z.object({
  canonicalRoot: z.string().min(1).refine(isCanonicalRoot, "OAuth profile ownership requires an absolute canonical root."),
  profile: OAuthProfileSchema,
  configurationFingerprint: z.string().min(1).optional(),
  state: oauthProfileStateSchema,
  credentialVersions: credentialVersionsSchema,
}).strict();

export const OAuthProfileDocumentSchema: z.ZodType<OAuthProfileDocument> = z.object({
  formatVersion: z.literal(1),
  profiles: z.array(OAuthProfileRecordSchema),
}).strict().superRefine((document, context) => {
  const profileIds = new Set<string>();
  const bearerRefs = new Set<string>();
  for (const [index, record] of document.profiles.entries()) {
    const profile = record.profile;
    const owner = JSON.stringify([record.canonicalRoot, profile.environmentId ?? null, profile.profileId]);
    if (profileIds.has(owner)) {
      context.addIssue({ code: "custom", path: ["profiles", index, "profile", "profileId"], message: "OAuth profile IDs must be unique within an owner and environment." });
    }
    profileIds.add(owner);
    if (bearerRefs.has(profile.bearerRef.id)) {
      context.addIssue({ code: "custom", path: ["profiles", index, "profile", "bearerRef"], message: "A Bearer reference can belong to only one OAuth profile in a credential scope." });
    }
    bearerRefs.add(profile.bearerRef.id);
  }
});

import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { CredentialError, type SecretStore } from "../credentials/types.js";
import type { CredentialScope } from "../credentials/types.js";
import type { PreparedNetworkRun } from "../network/prepare.js";
import { createFileOAuthProfileStore, withOAuthBearerRefLock, type OAuthProfileStore } from "./privateStore.js";
import {
  OAuthError,
  OAuthProfileSchema,
  OAuthScopeSchema,
  type OAuthCredentialVersions,
  type OAuthErrorCode,
  type OAuthProfile,
  type OAuthProfileRecord,
  type OAuthProfileState,
  type OAuthProfileSummary,
  type OAuthPublicResult,
  type OAuthScope,
} from "./model.js";
import { exchangeOAuthToken, type OAuthTokenGrant } from "./tokenClient.js";

export interface OAuthProfileHostOptions {
  workspaceRoot: string;
  project: OAuthScope["project"];
  environmentId?: string;
  privateRoot?: string;
  secretStore: SecretStore;
}

export interface OAuthProfileSaveOptions {
  clientSecret?: string;
  refreshToken?: string;
  expectedRevision?: string;
}

export interface OAuthProfileExchangeOptions {
  network?: PreparedNetworkRun;
  signal?: AbortSignal;
  expectedConfigurationFingerprint?: string;
}

export interface OAuthProfileSnapshot {
  revision: string;
  profiles: OAuthProfileSummary[];
}

export interface OAuthProfileHost {
  readonly scope: OAuthScope;
  readonly store: OAuthProfileStore;
  listProfilesSnapshot(): Promise<OAuthProfileSnapshot>;
  listProfiles(): Promise<OAuthProfileSummary[]>;
  withBearerRefLock<T>(
    refId: string,
    options: OAuthProfileExchangeOptions,
    operation: (binding?: OAuthLockedBearer) => Promise<T>,
  ): Promise<T>;
  saveProfile(profile: OAuthProfile, options?: OAuthProfileSaveOptions): Promise<OAuthPublicResult>;
  exchange(profileId: string, grant: OAuthTokenGrant, options?: OAuthProfileExchangeOptions): Promise<OAuthPublicResult>;
  unlinkProfile(profileId: string, expectedRevision?: string): Promise<OAuthPublicResult>;
}

export interface OAuthLockedBearer {
  summary: OAuthProfileSummary;
  exchange(grant: OAuthTokenGrant): Promise<OAuthPublicResult>;
}

const COORDINATOR_LOCKED_EXCHANGE = Symbol("coordinator-locked-oauth-exchange");
const PROFILE_LOCKED_REFS = Symbol("profile-locked-oauth-refs");
type InternalExchangeOptions = OAuthProfileExchangeOptions & { [COORDINATOR_LOCKED_EXCHANGE]?: true };
type InternalSaveOptions = OAuthProfileSaveOptions & { [PROFILE_LOCKED_REFS]?: ReadonlySet<string> };

function mapSecretError(error: unknown, fallback: OAuthErrorCode): OAuthErrorCode {
  if (error instanceof OAuthError) return error.code;
  if (error instanceof CredentialError) {
    switch (error.code) {
      case "CREDENTIAL_MISSING": return "OAUTH_SECRET_MISSING";
      case "CREDENTIAL_UNAVAILABLE": return "OAUTH_SECRET_UNAVAILABLE";
      case "CREDENTIAL_VERSION_CONFLICT": return "OAUTH_SECRET_VERSION_CONFLICT";
      case "CREDENTIAL_SAVE_FAILED": return "OAUTH_SECRET_SAVE_FAILED";
      default: return fallback;
    }
  }
  return fallback;
}

function publicFailure(errorCode: OAuthErrorCode): OAuthPublicResult {
  return { status: "failed", errorCode };
}

function profileConfigurationFingerprint(scope: OAuthScope, profile: OAuthProfile): string {
  const configuration = {
    owner: {
      canonicalRoot: scope.canonicalRoot,
      project: {
        workspaceId: scope.project.workspaceId,
        groupId: scope.project.groupId,
        projectId: scope.project.projectId,
      },
      environmentId: scope.environmentId ?? null,
    },
    profile: {
      profileId: profile.profileId,
      scope: profile.scope ?? null,
      environmentId: profile.environmentId ?? null,
      flow: profile.flow,
      authorizationEndpoint: profile.authorizationEndpoint ?? null,
      tokenEndpoint: profile.tokenEndpoint,
      clientId: profile.clientId,
      clientAuthentication: profile.clientAuthentication,
      bearerRef: [profile.bearerRef.id, profile.bearerRef.policy],
      clientSecretRef: profile.clientSecretRef === undefined ? null : [profile.clientSecretRef.id, profile.clientSecretRef.policy],
      refreshTokenRef: profile.refreshTokenRef === undefined ? null : [profile.refreshTokenRef.id, profile.refreshTokenRef.policy],
    },
  };
  const digest = createHash("sha256").update(JSON.stringify(configuration), "utf8").digest("hex");
  return `sha256:${digest}`;
}

function summary(record: OAuthProfileRecord, configurationFingerprint: string, accessTokenError?: OAuthErrorCode): OAuthProfileSummary {
  return {
    profile: record.profile,
    configurationFingerprint,
    status: accessTokenError === undefined ? record.state.status : "failed",
    ...(accessTokenError !== undefined || record.state.expiresAt === undefined ? {} : { expiresAt: record.state.expiresAt }),
    ...(accessTokenError !== undefined || record.state.grantedScope === undefined ? {} : { grantedScope: record.state.grantedScope }),
    ...(accessTokenError === undefined
      ? (record.state.errorCode === undefined ? {} : { errorCode: record.state.errorCode })
      : { errorCode: accessTokenError }),
  };
}

function operationExpiry(expiresIn: number | undefined, now: number): number | undefined {
  if (expiresIn === undefined) return undefined;
  const expiry = now + expiresIn * 1000;
  return Number.isSafeInteger(expiry) && expiry >= now ? expiry : undefined;
}

async function currentSecret(
  secretStore: SecretStore,
  scope: OAuthScope,
  ref: NonNullable<OAuthProfile["clientSecretRef"]>,
  expectedVersion: string | undefined,
): Promise<{ value: string; version: string }> {
  let status: Awaited<ReturnType<SecretStore["status"]>>;
  try {
    status = await secretStore.status(scope.project, ref);
  } catch (error) {
    throw new OAuthError(mapSecretError(error, "OAUTH_SECRET_UNAVAILABLE"));
  }
  if (status === "missing") throw new OAuthError("OAUTH_SECRET_MISSING");
  if (status === "unavailable") throw new OAuthError("OAUTH_SECRET_UNAVAILABLE");

  let version: string;
  try {
    version = await secretStore.version(scope.project, ref);
  } catch (error) {
    throw new OAuthError(mapSecretError(error, "OAUTH_SECRET_UNAVAILABLE"));
  }
  if (expectedVersion !== undefined && version !== expectedVersion) throw new OAuthError("OAUTH_SECRET_VERSION_CONFLICT");
  try {
    return { value: await secretStore.resolve(scope.project, ref, version), version };
  } catch (error) {
    throw new OAuthError(mapSecretError(error, "OAUTH_SECRET_UNAVAILABLE"));
  }
}

async function captureExistingSecret(
  secretStore: SecretStore,
  scope: OAuthScope,
  ref: NonNullable<OAuthProfile["clientSecretRef"]>,
  expectedVersion: string | undefined,
): Promise<string | undefined> {
  try {
    const status = await secretStore.status(scope.project, ref);
    if (status === "missing") return undefined;
    if (status === "unavailable") throw new OAuthError("OAUTH_SECRET_UNAVAILABLE");
    const version = await secretStore.version(scope.project, ref);
    if (expectedVersion !== undefined && version !== expectedVersion) throw new OAuthError("OAUTH_SECRET_VERSION_CONFLICT");
    return version;
  } catch (error) {
    throw new OAuthError(mapSecretError(error, "OAUTH_SECRET_UNAVAILABLE"));
  }
}

async function accessTokenMetadataError(
  secretStore: SecretStore,
  scope: OAuthScope,
  record: OAuthProfileRecord,
): Promise<OAuthErrorCode | undefined> {
  const expectedVersion = record.credentialVersions.accessToken;
  const claimsAccessMetadata = expectedVersion !== undefined
    || record.state.status === "connected"
    || record.state.expiresAt !== undefined
    || (record.state.status === "partial_success" && record.state.errorCode === "OAUTH_ACCESS_TOKEN_SAVE_FAILED");
  if (!claimsAccessMetadata) return undefined;

  let status: Awaited<ReturnType<SecretStore["status"]>>;
  try {
    status = await secretStore.status(scope.project, record.profile.bearerRef);
  } catch (error) {
    return mapSecretError(error, "OAUTH_SECRET_UNAVAILABLE");
  }
  if (status === "missing") return "OAUTH_SECRET_MISSING";
  if (status === "unavailable") return "OAUTH_SECRET_UNAVAILABLE";

  let actualVersion: string;
  try {
    actualVersion = await secretStore.version(scope.project, record.profile.bearerRef);
  } catch (error) {
    return mapSecretError(error, "OAUTH_SECRET_UNAVAILABLE");
  }
  if (expectedVersion === undefined || actualVersion !== expectedVersion) return "OAUTH_SECRET_VERSION_CONFLICT";
  return undefined;
}

function upsertRecord(records: readonly OAuthProfileRecord[], next: OAuthProfileRecord): OAuthProfileRecord[] {
  const index = records.findIndex((record) => record.profile.profileId === next.profile.profileId);
  if (index < 0) return [...records, next];
  return records.map((record, recordIndex) => recordIndex === index ? next : record);
}

function sameSecretRef(left: OAuthProfile["bearerRef"] | undefined, right: OAuthProfile["bearerRef"] | undefined): boolean {
  return left?.id === right?.id && left?.policy === right?.policy;
}

export function defaultOAuthPrivateRoot(): string {
  return join(homedir(), ".apicc", "private", "oauth", "v1");
}

/** Captures a canonical workspace owner; all secret reads and writes use only the selected SecretRefs. */
export async function createOAuthProfileHost(options: OAuthProfileHostOptions): Promise<OAuthProfileHost> {
  if (typeof options?.workspaceRoot !== "string" || !isAbsolute(options.workspaceRoot)) {
    throw new OAuthError("OAUTH_PROFILE_INVALID");
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(options.workspaceRoot);
    if (!(await stat(canonicalRoot)).isDirectory()) throw new Error("root");
  } catch {
    throw new OAuthError("OAUTH_PROFILE_INVALID");
  }

  const candidate = {
    canonicalRoot,
    project: options.project,
    ...(options.environmentId === undefined ? {} : { environmentId: options.environmentId }),
  };
  const parsedScope = OAuthScopeSchema.safeParse(candidate);
  if (!parsedScope.success) throw new OAuthError("OAUTH_PROFILE_INVALID");
  const scope: OAuthScope = Object.freeze({ ...parsedScope.data, project: Object.freeze({ ...parsedScope.data.project }) });
  const privateRoot = options.privateRoot ?? defaultOAuthPrivateRoot();
  const store = createFileOAuthProfileStore({ privateRoot });
  const secretStore = options.secretStore;
  const withProfileRefsLocked = async <T>(refIds: readonly string[], operation: () => Promise<T>): Promise<T> => {
    const ordered = [...new Set(refIds)].sort();
    const acquire = async (index: number): Promise<T> => {
      if (index >= ordered.length) return operation();
      return withOAuthBearerRefLock(privateRoot, scope.project, ordered[index]!, () => acquire(index + 1));
    };
    return acquire(0);
  };

  const listProfilesSnapshot = async (): Promise<OAuthProfileSnapshot> => {
    const { revision, profiles } = await store.load(scope);
    return {
      revision,
      profiles: await Promise.all(profiles.map(async (record) => summary(
        record,
        profileConfigurationFingerprint(scope, record.profile),
        await accessTokenMetadataError(secretStore, scope, record),
      ))),
    };
  };

  const host: OAuthProfileHost = {
    scope,
    store,
    listProfilesSnapshot,

    async listProfiles() {
      return (await listProfilesSnapshot()).profiles;
    },

    async withBearerRefLock<T>(
      refId: string,
      exchangeOptions: OAuthProfileExchangeOptions,
      operation: (binding?: OAuthLockedBearer) => Promise<T>,
    ) {
      return withOAuthBearerRefLock(privateRoot, scope.project, refId, async () => {
        const registration = await store.findBearerRegistration(scope.project, refId);
        if (registration === undefined) return operation(undefined);
        if (registration.canonicalRoot !== scope.canonicalRoot
          || registration.environmentId !== scope.environmentId) {
          throw new OAuthError("OAUTH_BEARER_REF_IN_USE");
        }
        const loaded = await store.load(scope);
        const selected = loaded.profiles.find((record) => record.profile.profileId === registration.profileId
          && record.profile.bearerRef.id === refId);
        if (selected === undefined) throw new OAuthError("OAUTH_PROFILE_REVISION_CONFLICT");
        const fingerprint = profileConfigurationFingerprint(scope, selected.profile);
        if (exchangeOptions.expectedConfigurationFingerprint !== undefined
          && exchangeOptions.expectedConfigurationFingerprint !== fingerprint) {
          throw new OAuthError("OAUTH_PROFILE_CONFIGURATION_CHANGED");
        }
        const accessError = await accessTokenMetadataError(secretStore, scope, selected);
        const selectedSummary = summary(selected, fingerprint, accessError);
        return operation({
          summary: selectedSummary,
          exchange: (grant: OAuthTokenGrant) => host.exchange(selected.profile.profileId, grant, {
            ...exchangeOptions,
            expectedConfigurationFingerprint: fingerprint,
            [COORDINATOR_LOCKED_EXCHANGE]: true,
          } as InternalExchangeOptions),
        });
      }, exchangeOptions.signal);
    },

    async saveProfile(profileValue: OAuthProfile, saveOptions: OAuthProfileSaveOptions = {}): Promise<OAuthPublicResult> {
      const parsed = OAuthProfileSchema.safeParse(profileValue);
      if (!parsed.success || parsed.data.environmentId !== scope.environmentId) return publicFailure("OAUTH_PROFILE_INVALID");
      const profile = parsed.data;

      const internalSaveOptions = saveOptions as InternalSaveOptions;
      if (internalSaveOptions[PROFILE_LOCKED_REFS] === undefined) {
        let initial: Awaited<ReturnType<OAuthProfileStore["load"]>>;
        try {
          initial = await store.load(scope);
        } catch (error) {
          return publicFailure(mapSecretError(error, "OAUTH_PROFILE_STORAGE_FAILED"));
        }
        const previous = initial.profiles.find((record) => record.profile.profileId === profile.profileId);
        const lockIds = [profile.bearerRef.id, ...(previous === undefined ? [] : [previous.profile.bearerRef.id])];
        try {
          return await withProfileRefsLocked(lockIds, () => host.saveProfile(profile, {
            ...saveOptions,
            [PROFILE_LOCKED_REFS]: new Set(lockIds),
          } as InternalSaveOptions));
        } catch (error) {
          return publicFailure(mapSecretError(error, "OAUTH_PROFILE_STORAGE_FAILED"));
        }
      }

      let loaded: Awaited<ReturnType<OAuthProfileStore["load"]>>;
      try {
        loaded = await store.load(scope);
      } catch (error) {
        return publicFailure(mapSecretError(error, "OAUTH_PROFILE_STORAGE_FAILED"));
      }
      if (saveOptions.expectedRevision !== undefined && saveOptions.expectedRevision !== loaded.revision) {
        return publicFailure("OAUTH_PROFILE_REVISION_CONFLICT");
      }

      const previous = loaded.profiles.find((record) => record.profile.profileId === profile.profileId);
      const lockedRefs = internalSaveOptions[PROFILE_LOCKED_REFS]!;
      if (!lockedRefs.has(profile.bearerRef.id)
        || (previous !== undefined && !lockedRefs.has(previous.profile.bearerRef.id))) {
        return publicFailure("OAUTH_PROFILE_REVISION_CONFLICT");
      }
      const unchanged = previous !== undefined && JSON.stringify(previous.profile) === JSON.stringify(profile);
      const versions: OAuthCredentialVersions = {
        ...(sameSecretRef(previous?.profile.bearerRef, profile.bearerRef) && previous?.credentialVersions.accessToken !== undefined
          ? { accessToken: previous.credentialVersions.accessToken } : {}),
        ...(sameSecretRef(previous?.profile.clientSecretRef, profile.clientSecretRef) && previous?.credentialVersions.clientSecret !== undefined
          ? { clientSecret: previous.credentialVersions.clientSecret } : {}),
        ...(sameSecretRef(previous?.profile.refreshTokenRef, profile.refreshTokenRef) && previous?.credentialVersions.refreshToken !== undefined
          ? { refreshToken: previous.credentialVersions.refreshToken } : {}),
      };
      let state: OAuthProfileState = unchanged && previous ? { ...previous.state } : { status: "unconfigured" };

      try {
        if (profile.clientSecretRef !== undefined) {
          if (saveOptions.clientSecret !== undefined) {
            if (saveOptions.clientSecret.length === 0) throw new OAuthError("OAUTH_SECRET_MISSING");
            await secretStore.put(scope.project, profile.clientSecretRef, saveOptions.clientSecret);
            versions.clientSecret = await secretStore.version(scope.project, profile.clientSecretRef);
          } else {
            const capturedVersion = await captureExistingSecret(secretStore, scope, profile.clientSecretRef, versions.clientSecret);
            if (capturedVersion === undefined) throw new OAuthError("OAUTH_SECRET_MISSING");
            versions.clientSecret = capturedVersion;
          }
        } else {
          delete versions.clientSecret;
        }

        if (profile.refreshTokenRef !== undefined) {
          if (saveOptions.refreshToken !== undefined) {
            if (saveOptions.refreshToken.length === 0) throw new OAuthError("OAUTH_SECRET_MISSING");
            await secretStore.put(scope.project, profile.refreshTokenRef, saveOptions.refreshToken);
            versions.refreshToken = await secretStore.version(scope.project, profile.refreshTokenRef);
          } else if (versions.refreshToken !== undefined) {
            const capturedVersion = await captureExistingSecret(secretStore, scope, profile.refreshTokenRef, versions.refreshToken);
            if (capturedVersion === undefined && profile.flow === "refresh_token") throw new OAuthError("OAUTH_SECRET_MISSING");
            if (capturedVersion !== undefined) versions.refreshToken = capturedVersion;
          } else {
            const capturedVersion = await captureExistingSecret(secretStore, scope, profile.refreshTokenRef, undefined);
            if (capturedVersion === undefined && profile.flow === "refresh_token") throw new OAuthError("OAUTH_SECRET_MISSING");
            if (capturedVersion !== undefined) versions.refreshToken = capturedVersion;
          }
        } else {
          delete versions.refreshToken;
        }

        if (!unchanged && sameSecretRef(previous?.profile.bearerRef, profile.bearerRef)) {
          state = { status: "unconfigured" };
        }
        const record: OAuthProfileRecord = {
          canonicalRoot: scope.canonicalRoot,
          profile,
          configurationFingerprint: profileConfigurationFingerprint(scope, profile),
          state,
          credentialVersions: versions,
        };
        await store.save(scope, upsertRecord(loaded.profiles, record), loaded.revision);
        return { status: "success" };
      } catch (error) {
        return publicFailure(mapSecretError(error, "OAUTH_PROFILE_STORAGE_FAILED"));
      }
    },

    async exchange(profileId: string, grant: OAuthTokenGrant, exchangeOptions: OAuthProfileExchangeOptions = {}): Promise<OAuthPublicResult> {
      const internalOptions = exchangeOptions as InternalExchangeOptions;
      if (internalOptions[COORDINATOR_LOCKED_EXCHANGE] !== true) {
        let initial: Awaited<ReturnType<OAuthProfileStore["load"]>>;
        try {
          initial = await store.load(scope);
        } catch (error) {
          return publicFailure(mapSecretError(error, "OAUTH_PROFILE_STORAGE_FAILED"));
        }
        const selected = initial.profiles.find((record) => record.profile.profileId === profileId);
        if (selected === undefined) return publicFailure("OAUTH_PROFILE_NOT_FOUND");
        const capturedFingerprint = profileConfigurationFingerprint(scope, selected.profile);
        try {
          return await withOAuthBearerRefLock(privateRoot, scope.project, selected.profile.bearerRef.id, async () => {
            const latest = await store.load(scope);
            const current = latest.profiles.find((record) => record.profile.profileId === profileId);
            if (current === undefined
              || profileConfigurationFingerprint(scope, current.profile) !== capturedFingerprint) {
              return publicFailure("OAUTH_PROFILE_CONFIGURATION_CHANGED");
            }
            return host.exchange(profileId, grant, {
              ...exchangeOptions,
              expectedConfigurationFingerprint: exchangeOptions.expectedConfigurationFingerprint ?? capturedFingerprint,
              [COORDINATOR_LOCKED_EXCHANGE]: true,
            } as InternalExchangeOptions);
          }, exchangeOptions.signal);
        } catch (error) {
          return publicFailure(mapSecretError(error, "OAUTH_PROFILE_STORAGE_FAILED"));
        }
      }

      let loaded: Awaited<ReturnType<OAuthProfileStore["load"]>>;
      try {
        loaded = await store.load(scope);
      } catch (error) {
        return publicFailure(mapSecretError(error, "OAUTH_PROFILE_STORAGE_FAILED"));
      }
      const selected = loaded.profiles.find((record) => record.profile.profileId === profileId);
      if (!selected) return publicFailure("OAUTH_PROFILE_NOT_FOUND");
      const capturedConfigurationFingerprint = profileConfigurationFingerprint(scope, selected.profile);
      if (
        exchangeOptions.expectedConfigurationFingerprint !== undefined
        && exchangeOptions.expectedConfigurationFingerprint !== capturedConfigurationFingerprint
      ) {
        return publicFailure("OAUTH_PROFILE_CONFIGURATION_CHANGED");
      }

      const accessError = await accessTokenMetadataError(secretStore, scope, selected);
      if (accessError !== undefined) return publicFailure(accessError);

      const secrets: { clientSecret?: string; refreshToken?: string } = {};
      try {
        if (selected.profile.clientSecretRef !== undefined) {
          const value = await currentSecret(secretStore, scope, selected.profile.clientSecretRef, selected.credentialVersions.clientSecret);
          secrets.clientSecret = value.value;
        }
        if (grant.type === "refresh_token") {
          if (selected.profile.refreshTokenRef === undefined) throw new OAuthError("OAUTH_PROFILE_INVALID");
          const value = await currentSecret(secretStore, scope, selected.profile.refreshTokenRef, selected.credentialVersions.refreshToken);
          secrets.refreshToken = value.value;
        }
      } catch (error) {
        return publicFailure(mapSecretError(error, "OAUTH_SECRET_UNAVAILABLE"));
      }

      let preflight;
      try {
        preflight = await store.load(scope);
      } catch (error) {
        return publicFailure(mapSecretError(error, "OAUTH_PROFILE_STORAGE_FAILED"));
      }
      const preflightRecord = preflight.profiles.find((record) => record.profile.profileId === profileId);
      if (
        !preflightRecord
        || profileConfigurationFingerprint(scope, preflightRecord.profile) !== capturedConfigurationFingerprint
      ) {
        return publicFailure("OAUTH_PROFILE_CONFIGURATION_CHANGED");
      }
      if (
        JSON.stringify(preflightRecord.credentialVersions) !== JSON.stringify(selected.credentialVersions)
        || JSON.stringify(preflightRecord.state) !== JSON.stringify(selected.state)
      ) {
        return publicFailure("OAUTH_PROFILE_REVISION_CONFLICT");
      }
      loaded = preflight;

      let tokenSet;
      try {
        tokenSet = await exchangeOAuthToken({
          profile: selected.profile,
          grant,
          secrets,
          ...(exchangeOptions.network === undefined ? {} : { network: exchangeOptions.network }),
          ...(exchangeOptions.signal === undefined ? {} : { signal: exchangeOptions.signal }),
        });
      } catch (error) {
        return publicFailure(mapSecretError(error, "OAUTH_TOKEN_REQUEST_FAILED"));
      }

      const refreshWasRotated = grant.type === "refresh_token" && tokenSet.refreshToken !== undefined;
      const reauthorizationFailure = async (
        failureCode: OAuthErrorCode,
        metadata?: Pick<OAuthProfileRecord, "state" | "credentialVersions">,
      ): Promise<OAuthPublicResult> => {
        if (!refreshWasRotated) return publicFailure(failureCode);
        try {
          const latest = await store.load(scope);
          const latestRecord = latest.profiles.find((record) => record.profile.profileId === profileId);
          if (
            latestRecord
            && JSON.stringify(latestRecord.profile) === JSON.stringify(selected.profile)
            && JSON.stringify(latestRecord.credentialVersions) === JSON.stringify(selected.credentialVersions)
            && JSON.stringify(latestRecord.state) === JSON.stringify(selected.state)
          ) {
            const updated: OAuthProfileRecord = {
              ...latestRecord,
              credentialVersions: metadata?.credentialVersions ?? latestRecord.credentialVersions,
              state: {
                ...(metadata?.state ?? latestRecord.state),
                status: "reauthorization_required",
                errorCode: failureCode,
              },
            };
            await store.save(scope, upsertRecord(latest.profiles, updated), latest.revision);
          }
        } catch {
          // The result still prevents retrying an unpersisted rotated token; persistence was not safe/available.
        }
        return {
          status: "reauthorization_required",
          ...(metadata?.state.expiresAt === undefined ? {} : { expiresAt: metadata.state.expiresAt }),
          errorCode: failureCode,
        };
      };

      let current;
      try {
        current = await store.load(scope);
      } catch {
        return reauthorizationFailure("OAUTH_METADATA_SAVE_FAILED");
      }
      if (current.revision !== loaded.revision) return reauthorizationFailure("OAUTH_PROFILE_REVISION_CONFLICT");
      const currentRecord = current.profiles.find((record) => record.profile.profileId === profileId);
      if (!currentRecord) return reauthorizationFailure("OAUTH_PROFILE_REVISION_CONFLICT");

      let accessTokenSaved = false;
      const versions: OAuthCredentialVersions = { ...currentRecord.credentialVersions };
      let expiresAt: number | undefined;
      let status: OAuthPublicResult["status"] = "success";
      let errorCode: OAuthErrorCode | undefined;

      try {
        await secretStore.put(scope.project, currentRecord.profile.bearerRef, tokenSet.accessToken);
        accessTokenSaved = true;
      } catch {
        return reauthorizationFailure("OAUTH_ACCESS_TOKEN_SAVE_FAILED");
      }
      if (accessTokenSaved) {
        try {
          versions.accessToken = await secretStore.version(scope.project, currentRecord.profile.bearerRef);
          expiresAt = operationExpiry(tokenSet.expiresIn, Date.now());
        } catch {
          delete versions.accessToken;
          status = "partial_success";
          errorCode = "OAUTH_ACCESS_TOKEN_SAVE_FAILED";
        }
      }

      if (accessTokenSaved && tokenSet.refreshToken !== undefined) {
        if (currentRecord.profile.refreshTokenRef === undefined) {
          status = refreshWasRotated ? "reauthorization_required" : "partial_success";
          errorCode = "OAUTH_REFRESH_REF_MISSING";
        } else {
          try {
            await secretStore.put(scope.project, currentRecord.profile.refreshTokenRef, tokenSet.refreshToken);
            versions.refreshToken = await secretStore.version(scope.project, currentRecord.profile.refreshTokenRef);
          } catch {
            status = refreshWasRotated ? "reauthorization_required" : "partial_success";
            errorCode = "OAUTH_REFRESH_TOKEN_SAVE_FAILED";
          }
        }
      }

      const state: OAuthProfileState = {
        status: status === "success" ? "connected" : status,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(tokenSet.scope === undefined ? {} : { grantedScope: tokenSet.scope }),
        ...(errorCode === undefined ? {} : { errorCode }),
      };
      const updated: OAuthProfileRecord = { ...currentRecord, state, credentialVersions: versions };
      try {
        await store.save(scope, upsertRecord(current.profiles, updated), current.revision);
      } catch {
        if (refreshWasRotated) return reauthorizationFailure("OAUTH_METADATA_SAVE_FAILED", updated);
        return {
          status: "partial_success",
          ...(expiresAt === undefined ? {} : { expiresAt }),
          errorCode: "OAUTH_METADATA_SAVE_FAILED",
        };
      }

      return {
        status,
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(errorCode === undefined ? {} : { errorCode }),
      };
    },

    async unlinkProfile(profileId: string, expectedRevision?: string): Promise<OAuthPublicResult> {
      let initial: Awaited<ReturnType<OAuthProfileStore["load"]>>;
      try {
        initial = await store.load(scope);
      } catch (error) {
        return publicFailure(mapSecretError(error, "OAUTH_PROFILE_STORAGE_FAILED"));
      }
      try {
        const initialRecord = initial.profiles.find((record) => record.profile.profileId === profileId);
        if (initialRecord === undefined) return publicFailure("OAUTH_PROFILE_NOT_FOUND");
        return await withOAuthBearerRefLock(privateRoot, scope.project, initialRecord.profile.bearerRef.id, async () => {
          const registration = await store.findBearerRegistration(scope.project, initialRecord.profile.bearerRef.id);
          if (registration === undefined
            || registration.canonicalRoot !== scope.canonicalRoot
            || registration.environmentId !== scope.environmentId
            || registration.profileId !== profileId) {
            return publicFailure("OAUTH_PROFILE_REVISION_CONFLICT");
          }
          const loaded = await store.load(scope);
          if (expectedRevision !== undefined && expectedRevision !== loaded.revision) {
            return publicFailure("OAUTH_PROFILE_REVISION_CONFLICT");
          }
          const currentRecord = loaded.profiles.find((record) => record.profile.profileId === profileId);
          if (currentRecord === undefined
            || profileConfigurationFingerprint(scope, currentRecord.profile)
              !== profileConfigurationFingerprint(scope, initialRecord.profile)) {
            return publicFailure("OAUTH_PROFILE_REVISION_CONFLICT");
          }
          await store.save(scope, loaded.profiles.filter((record) => record.profile.profileId !== profileId), loaded.revision);
          return { status: "success" };
        });
      } catch (error) {
        return publicFailure(mapSecretError(error, "OAUTH_PROFILE_STORAGE_FAILED"));
      }
    },
  };
  return Object.freeze(host);
}

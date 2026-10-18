import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  OAuthError,
  OAuthProfileDocumentSchema,
  OAuthProfileRecordSchema,
  OAuthScopeSchema,
  type OAuthProfileDocument,
  type OAuthProfileRecord,
  type OAuthScope,
} from "./model.js";
import type { CredentialScope } from "../credentials/types.js";

const MISSING_REVISION = "missing";
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 20;

interface SQLiteDatabase {
  exec(sql: string): void;
  close(): void;
}

export interface OAuthProfileStore {
  /** Returns only records owned by this canonical root and environment. */
  load(scope: OAuthScope): Promise<{ revision: string; profiles: OAuthProfileRecord[] }>;
  /** Looks across every workspace root and environment in the SecretStore credential scope. */
  findBearerRegistration(scope: CredentialScope, refId: string): Promise<OAuthBearerRegistration | undefined>;
  /** Replaces this root/environment slice while retaining every other owner in the credential scope. */
  save(scope: OAuthScope, profiles: readonly OAuthProfileRecord[], expectedRevision: string): Promise<string>;
}

export interface OAuthBearerRegistration {
  profileId: string;
  canonicalRoot: string;
  environmentId?: string;
}

export interface FileOAuthProfileStoreOptions {
  privateRoot: string;
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function revisionOf(serialized: string): string {
  return `sha256:${hash(serialized)}`;
}

function validatedScope(scope: OAuthScope): OAuthScope {
  const parsed = OAuthScopeSchema.safeParse(scope);
  if (!parsed.success) throw new OAuthError("OAUTH_PROFILE_INVALID");
  return parsed.data;
}

function profilePathForProject(privateRoot: string, project: CredentialScope): string {
  // SecretStore's address omits canonicalRoot and environment, so the ownership registry is keyed by that exact credential scope.
  const credentialScope = JSON.stringify([
    project.workspaceId,
    project.groupId,
    project.projectId,
  ]);
  const owner = hash(credentialScope);
  return join(privateRoot, owner.slice(0, 2), owner, "oauth-profile.json");
}

function profilePath(privateRoot: string, scopeValue: OAuthScope): string {
  return profilePathForProject(privateRoot, validatedScope(scopeValue).project);
}

function emptyDocument(): OAuthProfileDocument {
  return { formatVersion: 1, profiles: [] };
}

function parseDocument(serialized: string): OAuthProfileDocument {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new OAuthError("OAUTH_PROFILE_STORAGE_FAILED");
  }
  if (typeof value === "object" && value !== null && "formatVersion" in value && value.formatVersion !== 1) {
    throw new OAuthError("OAUTH_PROFILE_VERSION_UNSUPPORTED");
  }
  const parsed = OAuthProfileDocumentSchema.safeParse(value);
  if (!parsed.success) throw new OAuthError("OAUTH_PROFILE_STORAGE_FAILED");
  return parsed.data;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function sameEnvironment(left: OAuthProfileRecord, right: OAuthScope): boolean {
  return left.canonicalRoot === right.canonicalRoot
    && left.profile.environmentId === right.environmentId;
}

async function readDocument(path: string): Promise<{ revision: string; document: OAuthProfileDocument }> {
  let serialized: string;
  try {
    serialized = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return { revision: MISSING_REVISION, document: emptyDocument() };
    throw new OAuthError("OAUTH_PROFILE_STORAGE_FAILED");
  }
  return { revision: revisionOf(serialized), document: parseDocument(serialized) };
}

function isSQLiteBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("errcode" in error)) return false;
  return error.errcode === 5 || error.errcode === 6;
}

async function beginWriteLock(databasePath: string, signal?: AbortSignal): Promise<SQLiteDatabase> {
  const { DatabaseSync } = await import("node:sqlite");
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    if (signal?.aborted) throw new OAuthError("OAUTH_REQUEST_ABORTED");
    let database: SQLiteDatabase | undefined;
    try {
      database = new DatabaseSync(databasePath);
      database.exec("PRAGMA busy_timeout = 0");
      database.exec("BEGIN IMMEDIATE");
      return database;
    } catch (error) {
      try { database?.close(); } catch {}
      if (!isSQLiteBusy(error) || Date.now() >= deadline) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_MS));
    }
  }
}

function validateIncoming(scope: OAuthScope, profiles: readonly OAuthProfileRecord[]): OAuthProfileRecord[] {
  const result: OAuthProfileRecord[] = [];
  for (const value of profiles) {
    const parsed = OAuthProfileRecordSchema.safeParse(value);
    if (!parsed.success || !sameEnvironment(parsed.data, scope)) throw new OAuthError("OAUTH_PROFILE_INVALID");
    result.push(parsed.data);
  }
  return result;
}

function validateUniqueBearerRefs(profiles: readonly OAuthProfileRecord[]): void {
  const references = new Set<string>();
  for (const record of profiles) {
    const id = record.profile.bearerRef.id;
    if (references.has(id)) throw new OAuthError("OAUTH_BEARER_REF_IN_USE");
    references.add(id);
  }
}

export function createFileOAuthProfileStore(options: FileOAuthProfileStoreOptions): OAuthProfileStore {
  if (typeof options?.privateRoot !== "string" || options.privateRoot.trim().length === 0 || !isAbsolute(options.privateRoot)) {
    throw new OAuthError("OAUTH_PROFILE_STORAGE_FAILED");
  }
  const privateRoot = resolve(options.privateRoot);

  return {
    async load(scopeValue) {
      const scope = validatedScope(scopeValue);
      const path = profilePath(privateRoot, scope);
      const current = await readDocument(path);
      return {
        revision: current.revision,
        profiles: current.document.profiles.filter((record) => sameEnvironment(record, scope)),
      };
    },

    async findBearerRegistration(scope, refId) {
      if (!scope || typeof scope.workspaceId !== "string" || typeof scope.groupId !== "string"
        || typeof scope.projectId !== "string" || typeof refId !== "string" || refId.length === 0) {
        throw new OAuthError("OAUTH_PROFILE_INVALID");
      }
      const current = await readDocument(profilePathForProject(privateRoot, scope));
      const record = current.document.profiles.find((candidate) => candidate.profile.bearerRef.id === refId);
      return record === undefined ? undefined : {
        profileId: record.profile.profileId,
        canonicalRoot: record.canonicalRoot,
        ...(record.profile.environmentId === undefined ? {} : { environmentId: record.profile.environmentId }),
      };
    },

    async save(scopeValue, incoming, expectedRevision) {
      const scope = validatedScope(scopeValue);
      const records = validateIncoming(scope, incoming);
      if (typeof expectedRevision !== "string" || expectedRevision.length === 0) {
        throw new OAuthError("OAUTH_PROFILE_REVISION_CONFLICT");
      }

      const path = profilePath(privateRoot, scope);
      const directory = dirname(path);
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
      } catch {
        throw new OAuthError("OAUTH_PROFILE_STORAGE_FAILED");
      }

      let database: SQLiteDatabase;
      try {
        database = await beginWriteLock(`${path}.lock.sqlite`);
      } catch {
        throw new OAuthError("OAUTH_PROFILE_STORAGE_FAILED");
      }

      try {
        const current = await readDocument(path);
        if (current.revision !== expectedRevision) throw new OAuthError("OAUTH_PROFILE_REVISION_CONFLICT");

        const retained = current.document.profiles.filter((record) => !sameEnvironment(record, scope));
        const profiles = [...retained, ...records];
        validateUniqueBearerRefs(profiles);
        const nextDocument = OAuthProfileDocumentSchema.safeParse({ formatVersion: 1, profiles });
        if (!nextDocument.success) throw new OAuthError("OAUTH_PROFILE_INVALID");

        const serialized = JSON.stringify(nextDocument.data);
        const temporaryPath = join(directory, `.oauth-profile-${randomUUID()}.tmp`);
        let handle;
        try {
          handle = await open(temporaryPath, "wx", 0o600);
          await handle.writeFile(serialized, "utf8");
          await handle.sync();
          await handle.close();
          await rename(temporaryPath, path);
        } catch {
          await handle?.close().catch(() => undefined);
          await rm(temporaryPath, { force: true }).catch(() => undefined);
          throw new OAuthError("OAUTH_PROFILE_STORAGE_FAILED");
        }
        return revisionOf(serialized);
      } finally {
        try { database.exec("ROLLBACK"); } catch {}
        try { database.close(); } catch {}
      }
    },
  };
}

/** Serializes OAuth token writes and ordinary credential edits for the same SecretStore address. */
export async function withOAuthBearerRefLock<T>(
  privateRoot: string,
  scope: CredentialScope,
  refId: string,
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (typeof privateRoot !== "string" || privateRoot.trim().length === 0 || !isAbsolute(privateRoot)
    || typeof scope?.workspaceId !== "string" || typeof scope.groupId !== "string"
    || typeof scope.projectId !== "string" || typeof refId !== "string" || refId.length === 0) {
    throw new OAuthError("OAUTH_PROFILE_INVALID");
  }
  if (signal?.aborted) throw new OAuthError("OAUTH_REQUEST_ABORTED");
  const resolvedRoot = resolve(privateRoot);
  const key = hash(JSON.stringify([scope.workspaceId, scope.groupId, scope.projectId, refId]));
  const lockPath = join(resolvedRoot, "oauth-coordination", "v1", key.slice(0, 2), `${key}.sqlite`);
  try {
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  } catch {
    throw new OAuthError("OAUTH_PROFILE_STORAGE_FAILED");
  }
  let database: SQLiteDatabase;
  try {
    database = await beginWriteLock(lockPath, signal);
  } catch (error) {
    if (signal?.aborted) throw new OAuthError("OAUTH_REQUEST_ABORTED");
    if (error instanceof OAuthError) throw error;
    throw new OAuthError("OAUTH_COORDINATION_BUSY");
  }
  try {
    if (signal?.aborted) throw new OAuthError("OAUTH_REQUEST_ABORTED");
    return await operation();
  } finally {
    try { database.exec("ROLLBACK"); } catch {}
    try { database.close(); } catch {}
  }
}

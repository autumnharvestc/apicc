import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  emptyNetworkConfiguration,
  NetworkConfigurationSchema,
  NetworkProfileError,
  NetworkScopeSchema,
  type NetworkConfiguration,
  type NetworkScope,
} from "./profiles.js";

const MISSING_REVISION = "missing";
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 20;

interface SQLiteDatabase {
  exec(sql: string): void;
  close(): void;
}

export interface NetworkProfileStore {
  load(scope: NetworkScope): Promise<{ revision: string; configuration: NetworkConfiguration }>;
  save(scope: NetworkScope, next: NetworkConfiguration, expectedRevision: string): Promise<string>;
}

export interface FileNetworkProfileStoreOptions {
  privateRoot: string;
}

function isSQLiteBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("errcode" in error)) return false;
  return error.errcode === 5 || error.errcode === 6;
}

async function beginWriteLock(databasePath: string): Promise<SQLiteDatabase> {
  const { DatabaseSync } = await import("node:sqlite");
  const deadline = Date.now() + LOCK_WAIT_MS;

  while (true) {
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

function revisionOf(serialized: string): string {
  return `sha256:${createHash("sha256").update(serialized, "utf8").digest("hex")}`;
}

function validatedScope(value: NetworkScope): NetworkScope {
  const parsed = NetworkScopeSchema.safeParse(value);
  if (!parsed.success) throw new NetworkProfileError("NETWORK_CONFIGURATION_INVALID", undefined, "scope");
  return parsed.data;
}

function configPath(privateRoot: string, scopeValue: NetworkScope): string {
  const scope = validatedScope(scopeValue);
  const identity = JSON.stringify([
    scope.canonicalRoot,
    scope.project.workspaceId,
    scope.project.groupId,
    scope.project.projectId,
  ]);
  const owner = createHash("sha256").update(identity, "utf8").digest("hex");
  return join(privateRoot, owner.slice(0, 2), owner, "network-profile.json");
}

function parseConfiguration(serialized: string): NetworkConfiguration {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new NetworkProfileError("NETWORK_CONFIGURATION_INVALID", undefined, "configuration");
  }
  if (typeof value === "object" && value !== null
    && "formatVersion" in value && value.formatVersion !== 1) {
    throw new NetworkProfileError("NETWORK_CONFIGURATION_UNSUPPORTED", undefined, "formatVersion");
  }
  const parsed = NetworkConfigurationSchema.safeParse(value);
  if (!parsed.success) throw new NetworkProfileError("NETWORK_CONFIGURATION_INVALID", undefined, "configuration");
  return parsed.data;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function createFileNetworkProfileStore(options: FileNetworkProfileStoreOptions): NetworkProfileStore {
  if (typeof options?.privateRoot !== "string" || options.privateRoot.trim().length === 0 || !isAbsolute(options.privateRoot)) {
    throw new NetworkProfileError("NETWORK_STORAGE_FAILED", undefined, "privateRoot");
  }
  const privateRoot = resolve(options.privateRoot);

  async function read(scope: NetworkScope): Promise<{ revision: string; configuration: NetworkConfiguration }> {
    const path = configPath(privateRoot, scope);
    let serialized: string;
    try {
      serialized = await readFile(path, "utf8");
    } catch (error) {
      if (isMissing(error)) return { revision: MISSING_REVISION, configuration: emptyNetworkConfiguration() };
      throw new NetworkProfileError("NETWORK_STORAGE_FAILED", undefined, "configuration");
    }
    return { revision: revisionOf(serialized), configuration: parseConfiguration(serialized) };
  }

  return {
    load(scope) {
      return read(scope);
    },

    async save(scopeValue, nextValue, expectedRevision) {
      const scope = validatedScope(scopeValue);
      const parsedConfig = NetworkConfigurationSchema.safeParse(nextValue);
      if (!parsedConfig.success) throw new NetworkProfileError("NETWORK_CONFIGURATION_INVALID", undefined, "configuration");
      if (typeof expectedRevision !== "string" || expectedRevision.length === 0) {
        throw new NetworkProfileError("NETWORK_REVISION_CONFLICT", undefined, "expectedRevision");
      }

      const path = configPath(privateRoot, scope);
      const directory = dirname(path);
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
      } catch {
        throw new NetworkProfileError("NETWORK_STORAGE_FAILED", undefined, "configuration");
      }

      let database: SQLiteDatabase;
      try {
        database = await beginWriteLock(`${path}.lock.sqlite`);
      } catch {
        throw new NetworkProfileError("NETWORK_STORAGE_FAILED", undefined, "writeLock");
      }

      try {
        const current = await read(scope);
        if (current.revision !== expectedRevision) {
          throw new NetworkProfileError("NETWORK_REVISION_CONFLICT", undefined, "expectedRevision");
        }

        const serialized = JSON.stringify(parsedConfig.data);
        const temporaryPath = join(directory, `.network-profile-${randomUUID()}.tmp`);
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
          throw new NetworkProfileError("NETWORK_STORAGE_FAILED", undefined, "configuration");
        }
        return revisionOf(serialized);
      } finally {
        try { database.exec("ROLLBACK"); } catch {}
        try { database.close(); } catch {}
      }
    },
  };
}

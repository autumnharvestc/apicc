import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { credentialIndexPath, isCredentialGeneration } from "./address.js";
import { CredentialError, type CredentialScope } from "./types.js";

export { credentialIndexPath } from "./address.js";

export interface PrivateIndexPointer {
  formatVersion: 1;
  refId: string;
  generation: string;
  policy: string;
  version: string;
}

const INDEX_FORMAT_VERSION = 1;
const LOCK_WAIT_MS = 5_000;
const LOCK_RETRY_MS = 20;

interface SQLiteDatabase {
  exec(sql: string): void;
  close(): void;
}

function isSQLiteBusy(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("errcode" in error)) return false;
  return error.errcode === 5 || error.errcode === 6;
}

async function beginLockTransaction(databasePath: string): Promise<SQLiteDatabase> {
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

export async function readPrivateIndex(
  privateRoot: string,
  scope: CredentialScope,
  refId: string,
): Promise<PrivateIndexPointer | null> {
  const filePath = credentialIndexPath(privateRoot, scope, refId);
  let serialized: string;
  try {
    serialized = await readFile(filePath, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new CredentialError("CREDENTIAL_FORMAT_UNSUPPORTED", refId);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new CredentialError("CREDENTIAL_FORMAT_UNSUPPORTED", refId);
  }
  const record = parsed as Partial<PrivateIndexPointer>;
  if (record.formatVersion !== INDEX_FORMAT_VERSION
    || record.refId !== refId
    || typeof record.generation !== "string"
    || !isCredentialGeneration(record.generation)
    || typeof record.version !== "string"
    || record.version !== record.generation
    || typeof record.policy !== "string") {
    throw new CredentialError("CREDENTIAL_FORMAT_UNSUPPORTED", refId);
  }
  return record as PrivateIndexPointer;
}

export async function writePrivateIndexAtomically(
  privateRoot: string,
  scope: CredentialScope,
  pointer: PrivateIndexPointer,
): Promise<void> {
  const filePath = credentialIndexPath(privateRoot, scope, pointer.refId);
  if (pointer.formatVersion !== INDEX_FORMAT_VERSION
    || !isCredentialGeneration(pointer.generation)
    || pointer.version !== pointer.generation
    || typeof pointer.policy !== "string") {
    throw new CredentialError("CREDENTIAL_FORMAT_UNSUPPORTED", pointer.refId);
  }

  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directory, `.apicc-${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(pointer), "utf8");
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function withCredentialLock<T>(
  privateRoot: string,
  scope: CredentialScope,
  refId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const filePath = credentialIndexPath(privateRoot, scope, refId);
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const databasePath = `${filePath}.lock.sqlite`;
  const database = await beginLockTransaction(databasePath);
  try {
    return await operation();
  } finally {
    try { database.exec("ROLLBACK"); } catch {}
    try { database.close(); } catch {}
  }
}

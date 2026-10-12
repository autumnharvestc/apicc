import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { LoadProblem } from "../plugin/types.js";
import {
  validateManagedWorkspaceFilePath,
  validateSerializedWorkspaceFile,
  type WorkspaceWritePlan,
} from "./contractFiles.js";
import { validateRelativeFilePath, writerLockFilePath, writeJournalDirectoryPath } from "./paths.js";

export type WriteFaultStage =
  | "after-staging"
  | "after-replace"
  | "after-delete"
  | "before-revision-calculation"
  | "before-committed-marker"
  | "before-rollback-restore"
  | "before-recovery-restore";

export type WriteFaultInjector = (stage: WriteFaultStage, relativePath?: string) => void | Promise<void>;
export type LoadFaultInjector = (stage: "before-recovery-restore", relativePath?: string) => void | Promise<void>;

export interface SaveOptions {
  expectedRevision: string;
  deletions: readonly string[];
  faultInjector?: WriteFaultInjector;
}

interface JournalFileRecord {
  path: string;
  action: "replace" | "delete";
  existed: boolean;
}

interface WriteJournalManifest {
  version: 1;
  operationId: string;
  files: JournalFileRecord[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JournalRecordSchema = z.object({
  path: z.string(),
  action: z.enum(["replace", "delete"]),
  existed: z.boolean(),
}).strict();
const JournalManifestSchema = z.object({
  version: z.literal(1),
  operationId: z.string().regex(UUID_PATTERN),
  files: z.array(JournalRecordSchema),
}).strict();

function safeAbsolute(root: string, relativePath: string): string {
  const safePath = validateRelativeFilePath(relativePath);
  const base = resolve(root);
  const target = resolve(base, ...safePath.split("/"));
  const tail = relative(base, target);
  if (!tail || tail === ".." || tail.startsWith(`..${sep}`) || isAbsolute(tail)) {
    throw new TypeError("Storage path escapes workspace root");
  }
  return target;
}

function assertAbsoluteRoot(root: string): string {
  if (!isAbsolute(root)) throw new TypeError("Workspace root must be an absolute path");
  const resolved = resolve(root);
  if (parsePath(resolved).root === resolved) throw new TypeError("Workspace root must name a directory below the filesystem root");
  return resolved;
}

async function maybeLstat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function ensureDirectory(path: string): Promise<void> {
  const stats = await maybeLstat(path);
  if (stats) {
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new TypeError("Storage directory is not a regular directory");
    return;
  }
  await mkdir(path);
}

async function ensureSafeParents(root: string, relativePath: string, create: boolean): Promise<void> {
  const safePath = validateRelativeFilePath(relativePath);
  const segments = safePath.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    const stats = await maybeLstat(current);
    if (!stats) {
      if (create) await mkdir(current);
      continue;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new TypeError("Storage path contains a non-directory or symbolic link");
  }
}

async function ensureRegularTarget(root: string, relativePath: string): Promise<boolean> {
  const absolute = safeAbsolute(root, relativePath);
  await ensureSafeParents(root, relativePath, false);
  const stats = await maybeLstat(absolute);
  if (!stats) return false;
  if (!stats.isFile() || stats.isSymbolicLink()) throw new TypeError("Storage target is not a regular file");
  return true;
}

async function listWorkspaceFiles(root: string): Promise<Array<{ path: string; absolute: string }>> {
  const rootStats = await maybeLstat(root);
  if (!rootStats) return [];
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new TypeError("Workspace root is not a regular directory");
  const files: Array<{ path: string; absolute: string }> = [];

  async function visit(directory: string, relativeBase: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!relativeBase && entry.name.toLowerCase() === ".apicc") continue;
      const childPath = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new TypeError("Workspace contains a symbolic link");
      if (entry.isDirectory()) {
        await visit(absolute, childPath);
      } else if (entry.isFile()) {
        files.push({ path: validateRelativeFilePath(childPath), absolute });
      } else {
        throw new TypeError("Workspace contains a non-regular filesystem entry");
      }
    }
  }

  await visit(root, "");
  return files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export async function calculateWorkspaceRevision(root: string): Promise<string> {
  const base = assertAbsoluteRoot(root);
  const files = await listWorkspaceFiles(base);
  if (files.length === 0) return "empty";
  const hash = createHash("sha256");
  for (const file of files) {
    const content = await readFile(file.absolute);
    const pathBytes = Buffer.from(file.path, "utf8");
    const prefix = Buffer.allocUnsafe(8);
    prefix.writeUInt32BE(pathBytes.length, 0);
    prefix.writeUInt32BE(content.length, 4);
    hash.update(prefix);
    hash.update(pathBytes);
    hash.update(content);
  }
  return hash.digest("hex");
}

async function hasLock(root: string): Promise<boolean> {
  await ensureSafeParents(root, writerLockFilePath(), false);
  return Boolean(await maybeLstat(safeAbsolute(root, writerLockFilePath())));
}

async function acquireLock(root: string, operationId: string): Promise<{ release: () => Promise<void> }> {
  const lockPath = safeAbsolute(root, writerLockFilePath());
  await ensureDirectory(dirname(lockPath));
  const handle = await open(lockPath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify({ owner: `${process.pid}@${hostname()}`, operationId })}\n`, "utf8");
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
    throw error;
  }
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await unlink(lockPath);
    },
  };
}

function operationRelative(operationId: string, child: string): string {
  if (!UUID_PATTERN.test(operationId)) throw new TypeError("Journal operation id must be a UUID");
  return validateRelativeFilePath(`${writeJournalDirectoryPath()}/${operationId}/${child}`);
}

function manifestPath(operationId: string): string {
  return operationRelative(operationId, "manifest.yaml");
}

function markerPath(operationId: string): string {
  return operationRelative(operationId, "committed");
}

function stagedPath(operationId: string, relativePath: string): string {
  return operationRelative(operationId, `new/${validateRelativeFilePath(relativePath)}`);
}

function backupPath(operationId: string, relativePath: string): string {
  return operationRelative(operationId, `backups/${validateRelativeFilePath(relativePath)}`);
}

async function writeStagedFile(root: string, relativePath: string, content: string): Promise<void> {
  const absolute = safeAbsolute(root, relativePath);
  await ensureSafeParents(root, relativePath, true);
  await writeFile(absolute, content, { flag: "wx" });
}

async function validateBackupSource(root: string, operationId: string, record: JournalFileRecord): Promise<void> {
  const relativePath = backupPath(operationId, record.path);
  await ensureSafeParents(root, relativePath, false);
  const backup = safeAbsolute(root, relativePath);
  const stats = await lstat(backup);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new TypeError("Journal backup is not a regular file");
}

async function preflightBackups(root: string, operationId: string, records: readonly JournalFileRecord[]): Promise<void> {
  for (const record of records) {
    if (record.existed) await validateBackupSource(root, operationId, record);
  }
}

async function readManifest(root: string, operationId: string): Promise<WriteJournalManifest | undefined> {
  const path = manifestPath(operationId);
  try {
    const absolute = safeAbsolute(root, path);
    const stats = await lstat(absolute);
    if (!stats.isFile() || stats.isSymbolicLink()) return undefined;
    const parsed = JournalManifestSchema.safeParse(parse(await readFile(absolute, "utf8")));
    if (!parsed.success || parsed.data.operationId !== operationId) return undefined;
    const paths = new Set<string>();
    for (const record of parsed.data.files) {
      const safePath = validateManagedWorkspaceFilePath(record.path);
      if (paths.has(safePath)) return undefined;
      paths.add(safePath);
    }
    return parsed.data;
  } catch {
    return undefined;
  }
}

async function restoreTarget(root: string, operationId: string, record: JournalFileRecord): Promise<void> {
  const target = safeAbsolute(root, record.path);
  await ensureSafeParents(root, record.path, true);
  const exists = await ensureRegularTarget(root, record.path);
  if (!record.existed) {
    if (exists) await unlink(target);
    return;
  }

  await validateBackupSource(root, operationId, record);
  const backup = safeAbsolute(root, backupPath(operationId, record.path));
  const directory = dirname(target);
  let temporary: string | undefined;
  for (let attempt = 0; attempt < 3 && !temporary; attempt += 1) {
    const candidate = join(directory, `.apicc-restore-${operationId}-${randomUUID()}`);
    try {
      await copyFile(backup, candidate, 1);
      temporary = candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  if (!temporary) throw new Error("Could not prepare workspace recovery file");
  try {
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function manifestFor(operationId: string, records: JournalFileRecord[]): WriteJournalManifest {
  return { version: 1, operationId, files: records };
}

async function validMarker(root: string, operationId: string): Promise<boolean> {
  try {
    const path = safeAbsolute(root, markerPath(operationId));
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) return false;
    return (await readFile(path, "utf8")) === `${operationId}\n`;
  } catch {
    return false;
  }
}

async function journalDirectories(root: string): Promise<string[] | undefined> {
  const relativePath = writeJournalDirectoryPath();
  const absolute = safeAbsolute(root, relativePath);
  try {
    await ensureSafeParents(root, relativePath, false);
    const stats = await lstat(absolute);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return undefined;
    return (await readdir(absolute, { withFileTypes: true }))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return undefined;
  }
}

export async function recoverPendingWriteJournal(
  root: string,
  faultInjector?: LoadFaultInjector,
): Promise<LoadProblem[]> {
  const base = assertAbsoluteRoot(root);
  const problems: LoadProblem[] = [];
  let directories = await journalDirectories(base);
  if (directories === undefined) {
    return [{ file: writeJournalDirectoryPath(), message: "Write journal directory is not readable or is unsafe." }];
  }
  if (directories.length === 0) return problems;
  if (await hasLock(base)) {
    return [{ file: writerLockFilePath(), message: "Another writer owns the workspace lock." }];
  }

  const recoveryId = randomUUID();
  let lock: Awaited<ReturnType<typeof acquireLock>> | undefined;
  try {
    lock = await acquireLock(base, recoveryId);
  } catch {
    return [{ file: writerLockFilePath(), message: "Workspace recovery could not acquire the writer lock." }];
  }
  try {
    directories = await journalDirectories(base);
    if (!directories) {
      problems.push({ file: writeJournalDirectoryPath(), message: "Write journal directory is not readable or is unsafe." });
      return problems;
    }
    for (const operationId of directories) {
      if (!UUID_PATTERN.test(operationId)) {
        problems.push({ file: writeJournalDirectoryPath(), message: "Write journal contains an unrecognized operation directory." });
        continue;
      }
      const operationPath = operationRelative(operationId, "manifest.yaml").slice(0, -"/manifest.yaml".length);
      const operationAbsolute = safeAbsolute(base, operationPath);
      const opStats = await maybeLstat(operationAbsolute);
      if (!opStats || !opStats.isDirectory() || opStats.isSymbolicLink()) {
        problems.push({ file: operationPath, message: "Write journal entry is not a regular directory." });
        continue;
      }
      const manifest = await readManifest(base, operationId);
      if (!manifest) {
        problems.push({ file: operationPath, message: "Write journal manifest is missing or invalid." });
        continue;
      }
      if (await validMarker(base, operationId)) {
        try {
          await rm(operationAbsolute, { recursive: true, force: false });
        } catch {
          problems.push({ file: operationPath, message: "Completed write journal could not be cleaned." });
        }
        continue;
      }

      try {
        await preflightBackups(base, operationId, manifest.files);
        for (const record of [...manifest.files].reverse()) {
          await faultInjector?.("before-recovery-restore", record.path);
          await restoreTarget(base, operationId, record);
        }
        await rm(operationAbsolute, { recursive: true, force: false });
      } catch {
        problems.push({ file: operationPath, message: "Interrupted write could not be recovered; original files and journal were retained." });
      }
    }
  } finally {
    await lock.release().catch(() => undefined);
  }
  return problems;
}

function assertPlan(plan: WorkspaceWritePlan, deletions: readonly string[]): Array<{ path: string; action: "replace" | "delete"; content?: string }> {
  if (!plan || !(plan.files instanceof Map)) throw new TypeError("Write plan must contain a file map");
  const replacements = new Map<string, string>();
  const foldedPaths = new Set<string>();
  for (const [untrustedPath, content] of plan.files) {
    const path = validateManagedWorkspaceFilePath(untrustedPath);
    const folded = path.toLowerCase();
    if (foldedPaths.has(folded)) throw new TypeError("Write plan contains duplicate filesystem paths");
    foldedPaths.add(folded);
    if (typeof content !== "string") throw new TypeError("Write plan file content must be text");
    validateSerializedWorkspaceFile(path, content);
    replacements.set(path, content);
  }
  const deletePaths = new Set<string>();
  for (const untrustedPath of deletions) {
    const path = validateManagedWorkspaceFilePath(untrustedPath);
    const folded = path.toLowerCase();
    if (foldedPaths.has(folded) || deletePaths.has(folded)) throw new TypeError("Write plan contains duplicate or conflicting paths");
    foldedPaths.add(folded);
    deletePaths.add(folded);
  }
  const actions: Array<{ path: string; action: "replace" | "delete"; content?: string }> = [];
  for (const [path, content] of replacements) actions.push({ path, action: "replace", content });
  for (const path of deletions) actions.push({ path: validateRelativeFilePath(path), action: "delete" });
  return actions.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

async function checkWritableRoot(root: string): Promise<void> {
  const revision = await calculateWorkspaceRevision(root);
  if (revision === "empty") {
    const recoveryProblems = await recoverPendingWriteJournal(root);
    if (recoveryProblems.length > 0) throw new Error("Workspace has unresolved load or recovery problems and is read-only");
    return;
  }
  const { decodeContractWorkspace } = await import("./contractFiles.js");
  const state = await decodeContractWorkspace(root);
  if (state.readOnly) throw new Error("Workspace has unresolved load or recovery problems and is read-only");
}

export async function commitWritePlan(
  root: string,
  plan: WorkspaceWritePlan,
  options: SaveOptions,
): Promise<{ revision: string }> {
  const base = assertAbsoluteRoot(root);
  const actions = assertPlan(plan, options.deletions);
  await checkWritableRoot(base);
  const beforeLockRevision = await calculateWorkspaceRevision(base);
  if (beforeLockRevision !== options.expectedRevision) throw new Error("Workspace revision conflict");

  const prospectiveFiles = new Map<string, string>();
  for (const file of await listWorkspaceFiles(base)) {
    prospectiveFiles.set(file.path, await readFile(file.absolute, "utf8"));
  }
  for (const action of actions) {
    if (action.action === "delete") prospectiveFiles.delete(action.path);
    else prospectiveFiles.set(action.path, action.content!);
  }
  const { validateProspectiveContractFiles } = await import("./contractFiles.js");
  const prospective = await validateProspectiveContractFiles(prospectiveFiles);
  if (prospective.readOnly) throw new Error("Write plan does not produce a structurally valid workspace");

  await mkdir(base, { recursive: true });
  const rootStats = await lstat(base);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new TypeError("Workspace root is not a regular directory");
  const lock = await acquireLock(base, randomUUID());
  const operationId = randomUUID();
  const operationPath = operationRelative(operationId, "manifest.yaml").slice(0, -"/manifest.yaml".length);
  const operationAbsolute = safeAbsolute(base, operationPath);
  let journalCreated = false;
  let manifestWritten = false;
  const applied: JournalFileRecord[] = [];
  const stagedRecords: JournalFileRecord[] = [];

  try {
    const currentRevision = await calculateWorkspaceRevision(base);
    if (currentRevision !== options.expectedRevision) throw new Error("Workspace revision conflict");
    for (const action of actions) await ensureRegularTarget(base, action.path);

    const journalRoot = safeAbsolute(base, writeJournalDirectoryPath());
    await ensureDirectory(dirname(journalRoot));
    await ensureDirectory(journalRoot);
    await mkdir(operationAbsolute);
    journalCreated = true;

    for (const action of actions) {
      const existed = await ensureRegularTarget(base, action.path);
      const record: JournalFileRecord = { path: action.path, action: action.action, existed };
      stagedRecords.push(record);
      if (existed) {
        const oldBytes = await readFile(safeAbsolute(base, action.path));
        await writeStagedFile(base, backupPath(operationId, action.path), oldBytes.toString("base64"));
        // Restore the exact original bytes, including non-UTF-8 files.
        await writeFile(safeAbsolute(base, backupPath(operationId, action.path)), oldBytes, { flag: "w" });
      }
      if (action.action === "replace") {
        await writeStagedFile(base, stagedPath(operationId, action.path), action.content!);
      }
    }
    const manifest = manifestFor(operationId, stagedRecords);
    await writeStagedFile(base, manifestPath(operationId), stringify(manifest));
    manifestWritten = true;
    await options.faultInjector?.("after-staging");

    for (const record of stagedRecords) {
      const target = safeAbsolute(base, record.path);
      if (record.action === "replace") {
        await ensureSafeParents(base, record.path, true);
        await rename(safeAbsolute(base, stagedPath(operationId, record.path)), target);
        applied.push(record);
        await options.faultInjector?.("after-replace", record.path);
      } else {
        const existedNow = await ensureRegularTarget(base, record.path);
        if (existedNow) await unlink(target);
        applied.push(record);
        await options.faultInjector?.("after-delete", record.path);
      }
    }

    await options.faultInjector?.("before-revision-calculation");
    const revision = await calculateWorkspaceRevision(base);
    await options.faultInjector?.("before-committed-marker");
    await writeStagedFile(base, markerPath(operationId), `${operationId}\n`);
    await rm(operationAbsolute, { recursive: true, force: false }).catch(() => undefined);
    return { revision };
  } catch (error) {
    if (journalCreated && manifestWritten && applied.length > 0) {
      try {
        for (const record of [...applied].reverse()) {
          await options.faultInjector?.("before-rollback-restore", record.path);
          await restoreTarget(base, operationId, record);
        }
      } catch {
        throw new Error("Workspace write failed and rollback failed; recovery is required.");
      }
    }
    if (journalCreated) await rm(operationAbsolute, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof Error && error.message === "Workspace revision conflict") throw error;
    throw new Error("Workspace write failed; no success was recorded.");
  } finally {
    await lock.release().catch(() => undefined);
  }
}

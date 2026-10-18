import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  DebugCaseIdentitySchema,
  DebugHistoryDiagnosticSchema,
  DebugHistoryListFilterSchema,
  DebugHistoryPageSchema,
  DebugHistoryPreferencesSchema,
  DebugHistoryRecordSchema,
  DebugHistoryReadResultSchema,
  DebugHistorySummarySchema,
  DebugIdentitySchema,
  DebugHistoryOwnerIdentitySchema,
  DebugResultSchema,
  type DebugHistoryDiagnostic,
  type DebugHistoryListFilter,
  type DebugHistoryPage,
  type DebugHistoryPreferences,
  type DebugHistoryRecord,
  type DebugHistoryReadResult,
  type DebugHistorySummary,
  type DebugHistoryOwnerIdentity,
  type DebugResult,
} from "./model.js";

const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_SUMMARY_BYTES = 64 * 1024;
const MAX_HISTORY_RECORDS = 10_000;
const HASH_DIRECTORY_PATTERN = /^[a-f0-9]{64}$/;
const UUID_FILE_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/i;

const DEFAULT_PREFERENCES: DebugHistoryPreferences = DebugHistoryPreferencesSchema.parse({
  enabled: true,
  retentionDays: 30,
  maxRecords: 1_000,
});

const SidecarSchema = z.object({
  formatVersion: z.literal(1),
  ownerHash: z.string().regex(HASH_DIRECTORY_PATTERN),
  recordSize: z.number().finite().int().nonnegative(),
  recordFingerprint: z.string().min(1).max(256),
  summary: DebugHistorySummarySchema,
}).strict();
const LegacySidecarSchema = z.object({
  formatVersion: z.literal(1),
  ownerHash: z.string().regex(HASH_DIRECTORY_PATTERN),
  recordSize: z.number().finite().int().nonnegative(),
  recordFingerprint: z.string().min(1).max(256),
  summary: DebugHistorySummarySchema.omit({ sourceKind: true, groupId: true, draftId: true })
    .extend({ mode: z.enum(["request", "case"]) }),
}).strict();

export type DebugHistoryWriter = (path: string, contents: string) => Promise<void>;
export type { DebugHistoryOwnerIdentity } from "./model.js";

export interface DebugHistoryStoreOptions {
  /** Private application data directory; never accept this value from renderer IPC. */
  root: string;
  /** Narrow filesystem seam used to prove write failures without changing ACLs. */
  writer?: DebugHistoryWriter;
  /** Controlled scan ceiling for bounded-capacity tests; production callers should leave it unset. */
  scanLimit?: number;
}

/** Produces the private record partition for a validated source identity and canonical workspace root. */
export function createDebugHistoryOwnerKey(canonicalWorkspaceRoot: string, identityValue: DebugHistoryOwnerIdentity): string {
  if (canonicalWorkspaceRoot.trim().length === 0) throw new TypeError("A canonical workspace root is required.");
  const canonicalRoot = resolve(canonicalWorkspaceRoot);
  const identity = DebugHistoryOwnerIdentitySchema.parse(identityValue);
  // Asset keys deliberately keep the v1 canonical payload so existing records remain owner-addressable.
  const keyIdentity = identity.sourceKind === "asset"
    ? identity.mode === "request" ? identity.locator : identity.case
    : identity;
  return createHash("sha256").update(`${canonicalRoot}\0${stableCanonical(keyIdentity)}`, "utf8").digest("hex");
}

export class DebugHistoryStoreError extends Error {
  readonly diagnostic: DebugHistoryDiagnostic;

  constructor(message: string, diagnostic: DebugHistoryDiagnostic) {
    super(message);
    this.name = "DebugHistoryStoreError";
    this.diagnostic = diagnostic;
  }
}

/** Shared path rule for desktop and future CLI hosts; callers supply their OS app-data directory. */
export function defaultDebugHistoryRoot(appDataDirectory: string): string {
  if (appDataDirectory.trim().length === 0) throw new TypeError("An application data directory is required.");
  return resolve(appDataDirectory, "apicc", "debug-history");
}

export function createDebugHistoryStore(options: DebugHistoryStoreOptions) {
  if (options.root.trim().length === 0) throw new TypeError("A private debug history root is required.");
  const configuredRoot = resolve(options.root);
  // One lookahead lets retention account for the record that crosses the 10,000-row cap.
  const scanLimit = options.scanLimit ?? MAX_HISTORY_RECORDS + 1;
  if (!Number.isSafeInteger(scanLimit) || scanLimit < 1 || scanLimit > MAX_HISTORY_RECORDS + 1) {
    throw new RangeError("Debug history scan limit must be between 1 and 10,001.");
  }
  const writer = options.writer ?? (async (path: string, contents: string) => {
    await writeFile(path, contents, { encoding: "utf8", flag: "wx" });
  });

  async function append(
    resultValue: DebugResult,
    appendOptions: { ownerKey: string; parentHistoryId?: string },
  ): Promise<Extract<DebugHistoryRecord, { formatVersion: 2 }> | undefined> {
    const preferences = await readPreferencesState();
    if (!preferences.valid) throw configurationError(preferences.diagnostics[0]!);
    if (!preferences.preferences.enabled) return undefined;

    const ownerKey = parseOwnerKey(appendOptions.ownerKey);

    const root = await canonicalRoot(true);
    if (root === null) throw new DebugHistoryStoreError("Debug history private root is not a directory.", diagnostic("storage-failure"));
    const capacityDiagnostics: DebugHistoryDiagnostic[] = [];
    await enumerateRecordFiles(root, capacityDiagnostics, scanLimit);
    const incompleteExistingCapacity = capacityDiagnostics.find(isIncompleteCapacityDiagnostic);
    if (incompleteExistingCapacity) {
      throw new DebugHistoryStoreError("Debug history append was rejected because existing capacity could not be completely scanned.", incompleteExistingCapacity);
    }
    const historyId = randomUUID();
    const createdAt = new Date();
    const result = fitResultForHistory(DebugResultSchema.parse(resultValue), historyId, createdAt, appendOptions.parentHistoryId);
    const record = DebugHistoryRecordSchema.parse({
      formatVersion: 2,
      historyId,
      createdAt: createdAt.toISOString(),
      ...(appendOptions.parentHistoryId === undefined ? {} : { parentHistoryId: appendOptions.parentHistoryId }),
      result,
    });
    if (record.formatVersion !== 2) throw new TypeError("Debug history writer returned a non-v2 record.");
    const recordDirectory = await ensureOwnedDirectory(root, join(root, "records", ownerKey));
    const summaryDirectory = await ensureOwnedDirectory(root, join(root, "summaries", ownerKey));
    const recordPath = safeChild(recordDirectory, `${record.historyId}.json`);
    const serialized = JSON.stringify(record);
    const recordSize = Buffer.byteLength(serialized, "utf8");
    if (recordSize > MAX_RECORD_BYTES) {
      throw new DebugHistoryStoreError("Debug history record exceeds the 4 MiB storage limit.", diagnostic("oversized-record", record.historyId));
    }
    await writeAtomic(root, recordPath, serialized);
    const recordInfo = await safeFileInfo(root, recordPath);
    if (!recordInfo) throw new DebugHistoryStoreError("Debug history record could not be safely reopened after writing.", diagnostic("storage-failure", record.historyId));
    const summary = createSummary(record);
    const summaryPath = safeChild(summaryDirectory, `${record.historyId}.json`);
    const sidecar = SidecarSchema.parse({ formatVersion: 1, ownerHash: ownerKey, recordSize, recordFingerprint: recordInfo.fingerprint, summary });
    await writeAtomic(root, summaryPath, JSON.stringify(sidecar));

    const cleanupResult = await cleanupWithPreferences(root, preferences.preferences, new Date());
    const incompleteCapacity = cleanupResult.diagnostics.find(isIncompleteCapacityDiagnostic);
    if (incompleteCapacity) {
      await unlinkOwnedFile(root, recordPath);
      await unlinkOwnedFile(root, summaryPath);
      if (await safeFileInfo(root, recordPath)) {
        throw new DebugHistoryStoreError("Debug history append was rejected because retained capacity could not be established.", diagnostic("storage-failure", record.historyId));
      }
      throw new DebugHistoryStoreError("Debug history append was rejected because the bounded capacity scan was incomplete.", incompleteCapacity);
    }
    if (cleanupResult.diagnostics.some((item) => item.code === "storage-failure")) {
      throw new DebugHistoryStoreError("Debug history was written, but retention cleanup failed.", cleanupResult.diagnostics[0]!);
    }
    return record;
  }

  async function list(filterValue: DebugHistoryListFilter = {}): Promise<DebugHistoryPage> {
    const filter = DebugHistoryListFilterSchema.parse(filterValue);
    const root = await canonicalRoot(false);
    if (root === null) return { items: [], diagnostics: [] };

    const diagnostics: DebugHistoryDiagnostic[] = [];
    const entries = await enumerateRecordFiles(root, diagnostics, scanLimit);
    const summaries: DebugHistorySummary[] = [];
    for (const entry of entries) {
      const fileInfo = await safeFileInfo(root, entry.path);
      if (!fileInfo) continue;
      const summary = await readSummaryOrRebuild(root, entry, fileInfo, diagnostics);
      if (summary) summaries.push(summary);
    }
    summaries.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.historyId.localeCompare(left.historyId));
    const matching = summaries.filter((summary) => matchesFilter(summary, filter));
    const items = matching.slice(filter.offset, filter.offset + filter.limit);
    return DebugHistoryPageSchema.parse({
      items,
      ...(filter.offset + items.length < matching.length ? { nextOffset: filter.offset + items.length } : {}),
      diagnostics,
    });
  }

  async function get(historyIdValue: string): Promise<DebugHistoryReadResult> {
    const historyId = parseHistoryId(historyIdValue);
    const root = await canonicalRoot(false);
    if (root === null) return { record: null, diagnostics: [] };
    const diagnostics: DebugHistoryDiagnostic[] = [];
    const entries = await enumerateRecordFiles(root, diagnostics, scanLimit);
    const matches = entries.filter((entry) => entry.historyId === historyId);
    if (matches.length === 0) return DebugHistoryReadResultSchema.parse({ record: null, diagnostics });
    if (matches.length > 1) {
      diagnostics.push(diagnostic("corrupt-record", historyId));
      return DebugHistoryReadResultSchema.parse({ record: null, diagnostics });
    }
    const entry = matches[0]!;
    const read = await readRecordFile(root, entry.path, entry.ownerHash, historyId);
    if (!read.record && read.diagnostic) diagnostics.push(read.diagnostic);
    return DebugHistoryReadResultSchema.parse({ record: read.record ?? null, diagnostics });
  }

  async function getOwned(historyIdValue: string, ownerKeyValue: string): Promise<DebugHistoryReadResult> {
    const historyId = parseHistoryId(historyIdValue);
    const ownerKey = parseOwnerKey(ownerKeyValue);
    const root = await canonicalRoot(false);
    if (root === null) return { record: null, diagnostics: [] };
    const path = safeChild(root, join("records", ownerKey, `${historyId}.json`));
    const read = await readRecordFile(root, path, ownerKey, historyId);
    return DebugHistoryReadResultSchema.parse({ record: read.record ?? null, diagnostics: read.diagnostic ? [read.diagnostic] : [] });
  }

  async function remove(historyIdValue: string): Promise<boolean> {
    const historyId = parseHistoryId(historyIdValue);
    const root = await canonicalRoot(false);
    if (root === null) return false;
    const diagnostics: DebugHistoryDiagnostic[] = [];
    const entries = await enumerateRecordFiles(root, diagnostics, scanLimit);
    const matches = entries.filter((entry) => entry.historyId === historyId);
    if (matches.length !== 1) return false;
    const entry = matches[0]!;
    if (!await unlinkOwnedFile(root, entry.path)) return false;
    await unlinkOwnedFile(root, sidecarPath(root, entry.ownerHash, historyId));
    return true;
  }

  async function cleanup(now = new Date()): Promise<{ deleted: number; diagnostics: DebugHistoryDiagnostic[] }> {
    const state = await readPreferencesState();
    if (!state.valid) return { deleted: 0, diagnostics: state.diagnostics };
    if (!state.preferences.enabled) return { deleted: 0, diagnostics: [] };
    const root = await canonicalRoot(false);
    if (root === null) return { deleted: 0, diagnostics: [] };
    return cleanupWithPreferences(root, state.preferences, now);
  }

  async function getPreferences(): Promise<{ preferences: DebugHistoryPreferences; diagnostics: DebugHistoryDiagnostic[] }> {
    const state = await readPreferencesState();
    return { preferences: state.preferences, diagnostics: state.diagnostics };
  }

  async function updatePreferences(value: unknown): Promise<DebugHistoryPreferences> {
    const preferences = DebugHistoryPreferencesSchema.parse(value);
    const root = await canonicalRoot(true);
    if (root === null) throw new DebugHistoryStoreError("Debug history private root is not a directory.", diagnostic("storage-failure"));
    await writeAtomic(root, safeChild(root, "config.json"), JSON.stringify(preferences));
    return preferences;
  }

  async function readPreferencesState(): Promise<{
    preferences: DebugHistoryPreferences;
    valid: boolean;
    diagnostics: DebugHistoryDiagnostic[];
  }> {
    const root = await canonicalRoot(false);
    if (root === null) return { preferences: DEFAULT_PREFERENCES, valid: true, diagnostics: [] };
    const configPath = safeChild(root, "config.json");
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(configPath);
    } catch (error) {
      if (isMissing(error)) return { preferences: DEFAULT_PREFERENCES, valid: true, diagnostics: [] };
      return invalidConfiguration();
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SUMMARY_BYTES) return invalidConfiguration();
    try {
      const actualPath = await realpath(configPath);
      if (!isWithinRoot(root, actualPath)) return invalidConfiguration();
      const contents = await readFile(actualPath, "utf8");
      const parsed = DebugHistoryPreferencesSchema.safeParse(JSON.parse(contents) as unknown);
      if (!parsed.success) return invalidConfiguration();
      return { preferences: parsed.data, valid: true, diagnostics: [] };
    } catch {
      return invalidConfiguration();
    }
  }

  function invalidConfiguration() {
    return {
      preferences: DEFAULT_PREFERENCES,
      valid: false,
      diagnostics: [diagnostic("invalid-config")],
    };
  }

  function configurationError(issue: DebugHistoryDiagnostic): DebugHistoryStoreError {
    return new DebugHistoryStoreError("Debug history preferences are invalid; append and retention are paused.", issue);
  }

  return { append, list, get, getOwned, delete: remove, cleanup, getPreferences, updatePreferences };

  async function canonicalRoot(create: boolean): Promise<string | null> {
    if (create) await mkdir(configuredRoot, { recursive: true });
    try {
      const root = await realpath(configuredRoot);
      const info = await lstat(root);
      return info.isDirectory() ? root : null;
    } catch (error) {
      if (isMissing(error) && !create) return null;
      throw error;
    }
  }

  async function cleanupWithPreferences(
    root: string,
    preferences: DebugHistoryPreferences,
    now: Date,
  ): Promise<{ deleted: number; diagnostics: DebugHistoryDiagnostic[] }> {
    if (!preferences.enabled) return { deleted: 0, diagnostics: [] };
    const diagnostics: DebugHistoryDiagnostic[] = [];
    const entries = await enumerateRecordFiles(root, diagnostics, scanLimit);
    if (diagnostics.some(isIncompleteCapacityDiagnostic)) return { deleted: 0, diagnostics };
    const valid: Array<{ entry: RecordFile; historyId: string; createdAt: string }> = [];
    for (const entry of entries) {
      const read = await readRecordFile(root, entry.path, entry.ownerHash, entry.historyId);
      if (read.record) valid.push({ entry, historyId: read.record.historyId, createdAt: read.record.createdAt });
      else if (read.diagnostic) diagnostics.push(read.diagnostic);
    }
    if (diagnostics.some(isIncompleteCapacityDiagnostic)) return { deleted: 0, diagnostics };
    const cutoff = now.getTime() - preferences.retentionDays * 24 * 60 * 60 * 1000;
    const ordered = valid.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    const removeSet = new Set<string>();
    for (const item of ordered) {
      if (Date.parse(item.createdAt) < cutoff) removeSet.add(item.historyId);
    }
    const retained = ordered.filter((item) => !removeSet.has(item.historyId));
    for (const item of retained.slice(preferences.maxRecords)) removeSet.add(item.historyId);
    let deleted = 0;
    for (const item of valid) {
      if (!removeSet.has(item.historyId)) continue;
      const recordRemoved = await unlinkOwnedFile(root, item.entry.path);
      if (!recordRemoved) {
        diagnostics.push(diagnostic("storage-failure", item.historyId));
        continue;
      }
      await unlinkOwnedFile(root, sidecarPath(root, item.entry.ownerHash, item.historyId));
      deleted += 1;
    }
    return { deleted, diagnostics };
  }

  async function readSummaryOrRebuild(
    root: string,
    entry: RecordFile,
    recordInfo: SafeFileInfo,
    diagnostics: DebugHistoryDiagnostic[],
  ): Promise<DebugHistorySummary | undefined> {
    const path = sidecarPath(root, entry.ownerHash, entry.historyId);
    const sidecar = await readSidecar(root, path);
    if (sidecar && sidecar.ownerHash === entry.ownerHash && sidecar.recordSize === recordInfo.size
      && sidecar.recordFingerprint === recordInfo.fingerprint
      && sidecar.summary.historyId === entry.historyId) {
      const currentSummary = DebugHistorySummarySchema.safeParse(sidecar.summary);
      return currentSummary.success ? currentSummary.data : migrateLegacySummary(sidecar.summary);
    }

    const read = await readRecordFile(root, entry.path, entry.ownerHash, entry.historyId);
    if (!read.record) {
      if (read.diagnostic) diagnostics.push(read.diagnostic);
      return undefined;
    }
    const summary = createSummary(read.record);
    diagnostics.push(diagnostic("summary-rebuilt", entry.historyId));
    try {
      const summaryDirectory = await ensureOwnedDirectory(root, dirname(path));
      const rebuilt = SidecarSchema.parse({
        formatVersion: 1,
        ownerHash: entry.ownerHash,
        recordSize: recordInfo.size,
        recordFingerprint: recordInfo.fingerprint,
        summary,
      });
      await writeAtomic(root, safeChild(summaryDirectory, `${entry.historyId}.json`), JSON.stringify(rebuilt));
    } catch {
      // The record remains readable; a missing summary is rebuilt again on the next listing.
    }
    return summary;
  }

  async function readSidecar(root: string, path: string): Promise<z.infer<typeof SidecarSchema> | z.infer<typeof LegacySidecarSchema> | undefined> {
    try {
      const info = await safeFileInfo(root, path);
      if (!info || info.size > MAX_SUMMARY_BYTES) return undefined;
      const contents = await readFile(info.path, "utf8");
      const value = JSON.parse(contents) as unknown;
      const parsed = SidecarSchema.safeParse(value);
      if (parsed.success) return parsed.data;
      const legacy = LegacySidecarSchema.safeParse(value);
      return legacy.success ? legacy.data : undefined;
    } catch {
      return undefined;
    }
  }

  async function enumerateRecordFiles(root: string, diagnostics: DebugHistoryDiagnostic[], maxEntries: number): Promise<RecordFile[]> {
    const recordsRoot = safeChild(root, "records");
    let owners: import("node:fs").Dirent[];
    try {
      const info = await lstat(recordsRoot);
      if (!info.isDirectory() || info.isSymbolicLink() || !isWithinRoot(root, await realpath(recordsRoot))) return [];
      owners = await readdir(recordsRoot, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return [];
      diagnostics.push(diagnostic("unreadable-record"));
      return [];
    }
    const entries: RecordFile[] = [];
    let hitLimit = false;
    for (const owner of owners) {
      if (!owner.isDirectory() || owner.isSymbolicLink() || !HASH_DIRECTORY_PATTERN.test(owner.name)) continue;
      const ownerDirectory = safeChild(recordsRoot, owner.name);
      try {
        if (!isWithinRoot(root, await realpath(ownerDirectory))) continue;
        const files = await readdir(ownerDirectory, { withFileTypes: true });
        for (const file of files) {
          if (!file.isFile() || file.isSymbolicLink()) continue;
          const match = UUID_FILE_PATTERN.exec(file.name);
          if (!match) continue;
          if (entries.length >= maxEntries) {
            hitLimit = true;
            break;
          }
          const historyId = match[1]!.toLowerCase();
          entries.push({ ownerHash: owner.name, historyId, path: safeChild(ownerDirectory, file.name) });
        }
      } catch {
        diagnostics.push(diagnostic("unreadable-record"));
      }
      if (hitLimit) break;
    }
    if (hitLimit) diagnostics.push(diagnostic("scan-limit"));
    return entries;
  }

  async function readRecordFile(
    root: string,
    path: string,
    expectedOwnerHash?: string,
    expectedHistoryId?: string,
  ): Promise<{ record?: DebugHistoryRecord; diagnostic?: DebugHistoryDiagnostic }> {
    const info = await safeFileInfo(root, path);
    const pathMatch = UUID_FILE_PATTERN.exec(basename(path));
    const historyId = expectedHistoryId ?? pathMatch?.[1]?.toLowerCase();
    if (!info || !historyId) return { diagnostic: diagnostic("unreadable-record", historyId) };
    if (info.size > MAX_RECORD_BYTES) return { diagnostic: diagnostic("oversized-record", historyId) };
    try {
      const contents = await readFile(info.path, "utf8");
      if (Buffer.byteLength(contents, "utf8") > MAX_RECORD_BYTES) return { diagnostic: diagnostic("oversized-record", historyId) };
      let value: unknown;
      try {
        value = JSON.parse(contents) as unknown;
      } catch {
        return { diagnostic: diagnostic("corrupt-record", historyId) };
      }
      if (typeof value === "object" && value !== null && "formatVersion" in value
        && typeof value.formatVersion === "number" && value.formatVersion > 2) {
        return { diagnostic: diagnostic("future-version", historyId) };
      }
      const parsed = DebugHistoryRecordSchema.safeParse(value);
      if (!parsed.success || parsed.data.historyId !== historyId) return { diagnostic: diagnostic("corrupt-record", historyId) };
      if (expectedOwnerHash && (!HASH_DIRECTORY_PATTERN.test(expectedOwnerHash)
        || resolve(dirname(path)) !== resolve(root, "records", expectedOwnerHash))) {
        return { diagnostic: diagnostic("corrupt-record", historyId) };
      }
      return { record: parsed.data };
    } catch {
      return { diagnostic: diagnostic("unreadable-record", historyId) };
    }
  }

  async function safeFileInfo(root: string, path: string): Promise<SafeFileInfo | undefined> {
    try {
      const info = await lstat(path, { bigint: true });
      if (!info.isFile() || info.isSymbolicLink()) return undefined;
      const actualPath = await realpath(path);
      if (!isWithinRoot(root, actualPath)) return undefined;
      if (info.size > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
      const size = Number(info.size);
      return {
        path: actualPath,
        size,
        fingerprint: `${info.dev}:${info.ino}:${size}:${info.mtimeNs}:${info.ctimeNs}`,
      };
    } catch {
      return undefined;
    }
  }

  async function ensureOwnedDirectory(root: string, path: string): Promise<string> {
    const resolvedTarget = resolve(path);
    const target = resolvedTarget === root ? root : safeChild(root, relative(root, resolvedTarget));
    await mkdir(target, { recursive: true });
    const actualPath = await realpath(target);
    if (actualPath !== root && !isWithinRoot(root, actualPath)) throw new Error("History directory is outside its private root.");
    const info = await lstat(actualPath);
    if (!info.isDirectory()) throw new Error("History storage path is not a directory.");
    return actualPath;
  }

  async function writeAtomic(root: string, path: string, contents: string): Promise<void> {
    if (!isWithinRoot(root, resolve(path))) throw new Error("History write path is outside its private root.");
    const directory = await ensureOwnedDirectory(root, dirname(path));
    const target = safeChild(directory, basename(path));
    const temp = safeChild(directory, `.${basename(path)}.${randomUUID()}.tmp`);
    try {
      await writer(temp, contents);
      const tempInfo = await safeFileInfo(root, temp);
      if (!tempInfo) throw new Error("Temporary history file is not a private regular file.");
      await rename(tempInfo.path, target);
    } catch (error) {
      await unlinkOwnedFile(root, temp);
      throw error;
    }
  }

  async function unlinkOwnedFile(root: string, path: string): Promise<boolean> {
    const info = await safeFileInfo(root, path);
    if (!info) return false;
    try {
      await unlink(info.path);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      return false;
    }
  }
}

interface RecordFile {
  ownerHash: string;
  historyId: string;
  path: string;
}

interface SafeFileInfo {
  path: string;
  size: number;
  fingerprint: string;
}

function fitResultForHistory(result: DebugResult, historyId: string, createdAt: Date, parentHistoryId?: string): DebugResult {
  const makeRecord = (candidate: DebugResult): DebugHistoryRecord => DebugHistoryRecordSchema.parse({
    formatVersion: 2,
    historyId,
    createdAt: createdAt.toISOString(),
    ...(parentHistoryId === undefined ? {} : { parentHistoryId }),
    result: candidate,
  });
  const withinLimit = (candidate: DebugResult): boolean => Buffer.byteLength(JSON.stringify(makeRecord(candidate)), "utf8") <= MAX_RECORD_BYTES;
  if (withinLimit(result)) return result;

  const shrunk: DebugResult = {
    ...result,
    exchanges: result.exchanges.map((exchange) => ({
      ...exchange,
      ...(exchange.request === undefined ? {} : { request: { ...exchange.request, body: { kind: "metadata", omittedReason: "budget" } } }),
      ...(exchange.response === undefined ? {} : {
        response: {
          ...exchange.response,
          body: {
            kind: "metadata",
            ...(exchange.response.body.kind === "text" || exchange.response.body.kind === "binary"
              ? exchange.response.body.contentBytes === undefined ? {} : { contentBytes: exchange.response.body.contentBytes }
              : {}),
            omittedReason: "budget",
          },
        },
      }),
      ...(exchange.intent === undefined ? {} : {
        intent: {
          ...exchange.intent,
          fields: mergeNeedsInput(exchange.intent.fields, [{ path: "request.body", status: "truncated", needsInput: true }]),
          available: false,
        },
      }),
    })),
    replay: {
      ...result.replay,
      fields: mergeNeedsInput(result.replay.fields, [{ path: "request.body", status: "truncated", needsInput: true }]),
      available: false,
    },
    warnings: [...result.warnings, "History body summaries were reduced to fit the 4 MiB record limit; replay intent is incomplete."],
  };
  if (withinLimit(shrunk)) return DebugResultSchema.parse(shrunk);

  const replay = shrunk.replay.mode === "request"
    ? { ...shrunk.replay, requestTemplate: undefined, request: undefined, parameters: {}, available: false,
      fields: mergeNeedsInput(shrunk.replay.fields, [{ path: "request", status: "truncated", needsInput: true }]) }
    : { ...shrunk.replay, requestTemplate: undefined, parameters: {}, available: false,
      fields: mergeNeedsInput(shrunk.replay.fields, [{ path: "request", status: "truncated", needsInput: true }]) };
  const noExecutableIntent = DebugResultSchema.parse({
    ...shrunk,
    replay,
    exchanges: shrunk.exchanges.map((exchange) => exchange.intent === undefined ? exchange : {
      ...exchange,
      intent: { parameters: {}, fields: mergeNeedsInput(exchange.intent.fields, [{ path: "parameters", status: "truncated", needsInput: true }]), available: false },
    }),
  });
  if (withinLimit(noExecutableIntent)) return noExecutableIntent;
  throw new DebugHistoryStoreError("Debug history result remains over 4 MiB after display summaries and executable intent were safely omitted.", diagnostic("oversized-record", historyId));
}

function mergeNeedsInput(fields: readonly DebugResult["replay"]["fields"][number][], added: DebugResult["replay"]["fields"][number][]) {
  const merged = new Map(fields.map((field) => [field.path, field]));
  for (const field of added) merged.set(field.path, field);
  return [...merged.values()];
}

function migrateLegacySummary(summary: z.infer<typeof LegacySidecarSchema>["summary"] | DebugHistorySummary): DebugHistorySummary {
  if ("sourceKind" in summary) return DebugHistorySummarySchema.parse(summary);
  const hasAssetIdentity = Boolean(summary.workspaceId && summary.projectId && summary.collectionId && summary.apiId);
  return DebugHistorySummarySchema.parse({
    ...summary,
    sourceKind: hasAssetIdentity ? "asset" : "unavailable",
  });
}

function createSummary(record: DebugHistoryRecord): DebugHistorySummary {
  const { result } = record;
  const identity = recordIdentity(record);
  const firstOutcome = result.outcomes[0];
  const firstRequest = result.exchanges.find((exchange) => exchange.request !== undefined)?.request;
  const resultStatus = result.failureKind === "aborted" || result.outcomes.some((outcome) => outcome.failureKind === "aborted")
    ? "aborted"
    : result.failureKind !== undefined || result.run.failed > 0 || result.outcomes.some((outcome) => !outcome.passed && !outcome.skipped)
      ? "failed"
      : "passed";
  const text = [
    result.run.collectionName,
    firstOutcome?.apiName,
    firstOutcome?.caseName,
    identity?.sourceKind === "asset" ? identity.apiId : undefined,
    identity?.projectId,
    result.mode === "case" && result.replay.mode === "case" ? result.replay.case?.caseId : undefined,
    firstRequest?.method,
    firstRequest?.url,
    result.error,
    ...result.warnings,
  ].filter((value): value is string => typeof value === "string").join(" ").slice(0, 16_384);
  return DebugHistorySummarySchema.parse({
    historyId: record.historyId,
    createdAt: record.createdAt,
    ...(record.parentHistoryId === undefined ? {} : { parentHistoryId: record.parentHistoryId }),
    runId: result.runId,
    mode: result.mode,
    sourceKind: identity?.sourceKind ?? (record.formatVersion === 2 ? record.result.source.sourceKind : "unavailable"),
    result: resultStatus,
    ...(identity === undefined ? {} : {
      workspaceId: identity.workspaceId,
      groupId: identity.groupId,
      projectId: identity.projectId,
      ...(identity.sourceKind === "free" ? { draftId: identity.draftId } : {
        collectionId: identity.collectionId,
        apiId: identity.apiId,
      }),
    }),
    ...(result.mode === "case" && result.replay.mode === "case" && result.replay.case?.caseId ? { caseId: result.replay.case.caseId } : {}),
    ...(result.run.collectionName.length === 0 ? {} : { collectionName: result.run.collectionName }),
    ...(firstOutcome === undefined ? {} : { apiName: firstOutcome.apiName }),
    ...(firstRequest === undefined ? {} : { method: firstRequest.method }),
    total: result.run.total,
    passed: result.run.passed,
    failed: result.run.failed,
    exchangeTotal: result.exchangeTotal,
    searchText: text,
  });
}

function matchesFilter(summary: DebugHistorySummary, filter: z.output<typeof DebugHistoryListFilterSchema>): boolean {
  if (filter.sourceKind !== undefined && summary.sourceKind !== filter.sourceKind) return false;
  if (filter.projectId !== undefined && summary.projectId !== filter.projectId) return false;
  if (filter.apiId !== undefined && summary.apiId !== filter.apiId) return false;
  if (filter.result !== undefined && summary.result !== filter.result) return false;
  if (filter.method !== undefined && summary.method?.toLowerCase() !== filter.method.toLowerCase()) return false;
  if (filter.from !== undefined && Date.parse(summary.createdAt) < Date.parse(filter.from)) return false;
  if (filter.to !== undefined && Date.parse(summary.createdAt) > Date.parse(filter.to)) return false;
  if (filter.text !== undefined && !summary.searchText.toLowerCase().includes(filter.text.toLowerCase())) return false;
  return true;
}

type HistoryIdentity =
  | ({ sourceKind: "asset" } & z.infer<typeof DebugCaseIdentitySchema>)
  | { sourceKind: "free"; workspaceId: string; groupId: string; projectId: string; draftId: string };

function recordIdentity(record: DebugHistoryRecord): HistoryIdentity | undefined {
  if (record.formatVersion === 1) {
    const { result } = record;
    if (result.identityAvailable === false || result.replay.identityAvailable === false) return undefined;
    if (result.mode === "case" && result.replay.mode === "case" && result.replay.case !== undefined) {
      const parsed = DebugCaseIdentitySchema.safeParse(result.replay.case);
      return parsed.success ? { sourceKind: "asset", ...parsed.data } : undefined;
    }
    if (result.replay.mode === "request" && result.replay.locator !== undefined) {
      const parsed = DebugIdentitySchema.safeParse(result.replay.locator);
      return parsed.success ? { sourceKind: "asset", ...parsed.data, caseId: "", scope: "" } : undefined;
    }
    if (result.locator !== undefined) {
      const parsed = DebugIdentitySchema.safeParse(result.locator);
      return parsed.success ? { sourceKind: "asset", ...parsed.data, caseId: "", scope: "" } : undefined;
    }
    return undefined;
  }

  const { result } = record;
  if (result.identityAvailable === false || result.replay.identityAvailable === false) return undefined;
  if (result.source.sourceKind === "free") {
    if (result.replay.mode !== "free" || result.replay.project === undefined || result.replay.draftId === undefined) return undefined;
    return { sourceKind: "free", ...result.replay.project, draftId: result.replay.draftId };
  }
  if (result.source.sourceKind !== "asset") return undefined;
  if (result.mode === "case" && result.replay.mode === "case" && result.replay.case !== undefined) {
    const parsed = DebugCaseIdentitySchema.safeParse(result.replay.case);
    return parsed.success ? { sourceKind: "asset", ...parsed.data } : undefined;
  }
  if (result.replay.mode === "request" && result.replay.locator !== undefined) {
    const parsed = DebugIdentitySchema.safeParse(result.replay.locator);
    return parsed.success ? { sourceKind: "asset", ...parsed.data, caseId: "", scope: "" } : undefined;
  }
  return undefined;
}

function stableCanonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableCanonical).join(",")}]`;
  if (typeof value !== "object") throw new TypeError("History identity must be JSON-compatible.");
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableCanonical(object[key])}`).join(",")}}`;
}

function parseOwnerKey(value: string): string {
  if (!HASH_DIRECTORY_PATTERN.test(value)) throw new TypeError("Debug history owner key must be an opaque SHA-256 key.");
  return value;
}

function sidecarPath(root: string, ownerHash: string, historyId: string): string {
  return safeChild(root, join("summaries", ownerHash, `${historyId}.json`));
}

function safeChild(root: string, child: string): string {
  const path = resolve(root, child);
  if (!isWithinRoot(root, path)) throw new TypeError("History paths must remain inside the private root.");
  return path;
}

function isWithinRoot(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function parseHistoryId(value: string): string {
  const parsed = z.string().uuid().safeParse(value);
  if (!parsed.success) throw new TypeError("Debug history ID must be a UUID.");
  return parsed.data.toLowerCase();
}

function isIncompleteCapacityDiagnostic(item: DebugHistoryDiagnostic): boolean {
  return item.code === "scan-limit" || item.code === "unreadable-record";
}

function diagnostic(code: DebugHistoryDiagnostic["code"], historyId?: string): DebugHistoryDiagnostic {
  const message = code === "invalid-config"
    ? "调试历史配置无效；追加和清理已暂停，重新保存有效配置后恢复。"
    : code === "future-version"
      ? "调试历史记录来自未来版本；原文件已保留。"
      : code === "oversized-record"
        ? "调试历史记录超过4 MiB；原文件已保留。"
        : code === "corrupt-record"
          ? "调试历史记录损坏；原文件已保留。"
          : code === "summary-rebuilt"
            ? "调试历史摘要已从记录重建。"
            : code === "scan-limit"
              ? "调试历史扫描达到当前安全上限。"
              : code === "storage-failure"
                ? "调试历史清理遇到文件系统错误；相关记录已保留。"
                : "调试历史文件不可读取；原文件已保留。";
  return DebugHistoryDiagnosticSchema.parse({ code, ...(historyId === undefined ? {} : { historyId }), message });
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import type { ProjectFileLocation } from "../storage/paths.js";
import { projectDirectoryPath } from "../storage/paths.js";
import { validateManagedWorkspaceFilePath } from "../storage/contractFiles.js";
import { SyncContentRefSchema, SyncFileSchema, type SyncFile } from "./types.js";
import { syncContentReferences, SyncWorkspaceStateSchema, type SyncContentRef, type SyncWorkspaceState } from "./state.js";

export interface SyncStorageLimits { maxStateBytes: number; maxContentBytes: number; maxTotalContentBytes: number }
/** Trusted storage ceilings in bytes; hosts may impose smaller limits. */
export const defaultSyncStorageLimits: Readonly<SyncStorageLimits> = Object.freeze({ maxStateBytes: 8 * 1024 * 1024, maxContentBytes: 64 * 1024 * 1024, maxTotalContentBytes: 256 * 1024 * 1024 });
export const syncStateFilePath = (location: ProjectFileLocation) => `${projectDirectoryPath(location.groupId, location.projectId)}/synchronization.yaml`;
export const syncContentFilePath = (location: ProjectFileLocation, reference: SyncContentRef) => `${projectDirectoryPath(location.groupId, location.projectId)}/synchronization/content/${SyncContentRefSchema.parse(reference).digest}.json`;
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
function assertText(text: string, maximum: number): void {
  if (bytes(text) > maximum) throw new Error("SYNC_STORAGE_BYTES_EXCEEDED");
  if (Buffer.from(text, "utf8").toString("utf8") !== text) throw new Error("SYNC_STORAGE_INVALID_UNICODE");
}
export function encodeSyncState(state: SyncWorkspaceState, limits = defaultSyncStorageLimits): string {
  const text = stringify(state, { aliasDuplicateObjects: false });
  decodeSyncState(text, state.projectId, limits);
  return text;
}
export function decodeSyncState(text: string, projectId: string, limits = defaultSyncStorageLimits): SyncWorkspaceState {
  assertText(text, limits.maxStateBytes);
  const state = SyncWorkspaceStateSchema.parse(parse(text, { maxAliasCount: 0 }));
  if (state.projectId !== projectId) throw new Error("SYNC_STATE_PROJECT_MISMATCH");
  const ids = new Set<string>();
  for (const s of state.sources) {
    if (ids.has(s.source.id) || s.mapping.sourceId !== s.source.id) throw new Error("SYNC_STATE_SOURCE_MISMATCH");
    ids.add(s.source.id);
  }
  const unique = new Map<string, SyncContentRef>();
  for (const reference of syncContentReferences(state)) {
    const existing = unique.get(reference.digest);
    if (existing && existing.bytes !== reference.bytes) throw new Error("SYNC_CONTENT_REFERENCE_MISMATCH");
    unique.set(reference.digest, reference);
  }
  if ([...unique.values()].some(r => r.bytes > limits.maxContentBytes)
    || [...unique.values()].reduce((sum, r) => sum + r.bytes, 0) > limits.maxTotalContentBytes) throw new Error("SYNC_STORAGE_BYTES_EXCEEDED");
  return state;
}
function parseFiles(input: unknown): SyncFile[] {
  const files = SyncFileSchema.array().parse(input), seen = new Set<string>();
  for (const f of files) {
    assertText(f.content, Infinity);
    if (seen.has(f.path) || f.path === "synchronization.yaml" || f.path.startsWith("synchronization/")) throw new Error("SYNC_INVALID_FILES");
    validateManagedWorkspaceFilePath(`groups/00000000-0000-4000-8000-000000000000/projects/00000000-0000-4000-8000-000000000000/${f.path}`);
    seen.add(f.path);
  }
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export function encodeSyncContent(files: SyncFile[], limits = defaultSyncStorageLimits): { reference: SyncContentRef; text: string } {
  const text = JSON.stringify(parseFiles(files)); assertText(text, limits.maxContentBytes);
  return { reference: { digest: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text), contentType: "application/vnd.apicc.sync-files+json" }, text };
}
export async function readSyncContent(root: string, location: ProjectFileLocation, reference: SyncContentRef, limits = defaultSyncStorageLimits): Promise<SyncFile[]> {
  const ref = SyncContentRefSchema.parse(reference);
  if (ref.bytes > limits.maxContentBytes) throw new Error("SYNC_STORAGE_BYTES_EXCEEDED");
  const path = syncContentFilePath(location, ref);
  await assertRegularPath(root, path);
  const stat = await lstat(join(root, path));
  if (stat.size !== ref.bytes) throw new Error("SYNC_CONTENT_BYTES_MISMATCH");
  const content = await readFile(join(root, path));
  if (createHash("sha256").update(content).digest("hex") !== ref.digest) throw new Error("SYNC_CONTENT_DIGEST_MISMATCH");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  const files = parseFiles(JSON.parse(text));
  if (encodeSyncContent(files, limits).text !== text) throw new Error("SYNC_CONTENT_NONCANONICAL");
  return files;
}

async function assertRegularPath(root: string, path: string): Promise<void> {
  let current = root; const parts = path.split("/");
  for (const [index, part] of parts.entries()) {
    current = join(current, part); const stat = await lstat(current);
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) throw new Error("SYNC_STORAGE_UNSAFE_PATH");
  }
}

export async function loadSyncState(root: string, location: ProjectFileLocation, limits = defaultSyncStorageLimits): Promise<SyncWorkspaceState | null> {
  const path = syncStateFilePath(location);
  try { await lstat(join(root, path)); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  await assertRegularPath(root, path);
  if ((await lstat(join(root, path))).size > limits.maxStateBytes) throw new Error("SYNC_STORAGE_BYTES_EXCEEDED");
  return decodeSyncState(await readFile(join(root, path), "utf8"), location.projectId, limits);
}

/** Enumerate metadata without expanding any selected history payload. */
export async function listSyncManagedFiles(root: string, location: ProjectFileLocation): Promise<string[]> {
  const state = await loadSyncState(root, location);
  if (!state) return [];
  const base = `${projectDirectoryPath(location.groupId, location.projectId)}/synchronization/content`;
  let entries;
  try { entries = await readdir(join(root, base), { withFileTypes: true }); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return [syncStateFilePath(location)]; throw e; }
  const paths = [syncStateFilePath(location)];
  for (const entry of entries) {
    const path = `${base}/${entry.name}`; validateManagedWorkspaceFilePath(path);
    await assertRegularPath(root, path); paths.push(path);
  }
  return paths;
}

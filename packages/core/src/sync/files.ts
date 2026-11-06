import { createHash } from "node:crypto";
import { createProjectSnapshot } from "../assets/snapshot.js";
import { decodeContractProjectFiles, encodeContractProjectFiles } from "../storage/contractFiles.js";
import { validateRelativeFilePath } from "../storage/paths.js";
import type { ContractProject } from "../contract/workspace.js";
import type { SyncFile } from "./types.js";

export const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).filter(k=>(value as Record<string, unknown>)[k] !== undefined).sort(order).map(k=>`${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
}
export const hash = (value: unknown) => createHash("sha256").update(canonical(value), "utf8").digest("hex");
export function sortedFiles(files: SyncFile[]): SyncFile[] {
  const seen = new Set<string>();
  for (const f of files) {
    if (validateRelativeFilePath(f.path) !== f.path || seen.has(f.path) || f.path.includes("\\")) throw new Error("SYNC_INVALID_FILES");
    seen.add(f.path);
  }
  return [...files].sort((a,b)=>order(a.path,b.path));
}
export function manifestDigest(files: SyncFile[]): string {
  return createHash("sha256").update(JSON.stringify(["apicc-sync-manifest-v1", sortedFiles(files).map(f=>[f.path,f.content])]), "utf8").digest("hex");
}
/** Content-addressed payload is distinct from the versioned manifest digest. */
export function contentReference(files: SyncFile[]) {
  const text = JSON.stringify(sortedFiles(files).map(({path,content})=>({path,content})));
  return { digest: createHash("sha256").update(text,"utf8").digest("hex"), bytes: Buffer.byteLength(text,"utf8"), contentType: "application/vnd.apicc.sync-files+json" as const };
}
export function assertBytes(value: unknown, maximum: number, code: string): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maximum) throw new Error(code);
}
export async function readSyncProject(files: SyncFile[]): Promise<ContractProject> {
  const result = await decodeContractProjectFiles(new Map(sortedFiles(files).map(f=>[f.path,f.content])));
  if (result.project && createProjectSnapshot(result.project).context.diagnostics.length) throw new Error("SYNC_PROTECTED_REFERENCE");
  if (!result.project || result.problems.length || result.readOnly) throw new Error("SYNC_INVALID_FILES");
  return result.project;
}
export function encodeSyncProject(project: ContractProject): SyncFile[] {
  return sortedFiles([...encodeContractProjectFiles(project).files].map(([path,content])=>({path,content})));
}
export function digestProject(project: ContractProject, files = encodeSyncProject(project)) {
  return { definitionRevision: createProjectSnapshot(project).definitionRevision, manifestDigest: manifestDigest(files) };
}
export function fileWrites(before: SyncFile[], after: SyncFile[]) {
  const old = new Map(before.map(f=>[f.path,f.content])); const next = new Set(after.map(f=>f.path));
  return { writes: sortedFiles(after).filter(f=>old.get(f.path) !== f.content), deletions: before.filter(f=>!next.has(f.path)).map(f=>f.path).sort(order) };
}

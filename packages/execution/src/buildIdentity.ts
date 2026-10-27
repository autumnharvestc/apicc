import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const BUILD_IDENTITY_ALGORITHM = "apicc-execution-source-sha256-v1";
export interface BuildIdentity {
  algorithm: typeof BUILD_IDENTITY_ALGORITHM;
  coreBuildId: string;
  scriptApiId: string;
  capabilities: readonly string[];
  sourceFiles: readonly string[];
}
/** Length framing makes boundaries unambiguous; paths are relative to the repository. */
export function fingerprintSources(entries: readonly { path: string; bytes: Uint8Array }[]): string {
  const hash = createHash("sha256").update(BUILD_IDENTITY_ALGORITHM + "\0");
  const seen = new Set<string>();
  for (const entry of [...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
    if (!entry.path || /[:\\\u0000]/.test(entry.path) || entry.path.startsWith("/") || entry.path.split("/").some(p => !p || p === "." || p === "..") || seen.has(entry.path)) throw new Error("build source paths must be unique repository-relative paths");
    seen.add(entry.path);
    hash.update(`${Buffer.byteLength(entry.path)}:`).update(entry.path).update(`${entry.bytes.byteLength}:`).update(entry.bytes);
  }
  return hash.digest("hex");
}
/** Explicit Node-only artifact read; contract imports never reach this module. */
export async function readBuildIdentity(url = new URL("./build-identity.json", import.meta.url)): Promise<BuildIdentity> {
  const raw = JSON.parse(await readFile(url, "utf8"));
  if (raw.algorithm !== BUILD_IDENTITY_ALGORITHM || !/^[a-f0-9]{64}$/.test(raw.coreBuildId) || !/^[a-f0-9]{64}$/.test(raw.scriptApiId) || !Array.isArray(raw.capabilities) || !raw.capabilities.every((v: unknown) => typeof v === "string") || !Array.isArray(raw.sourceFiles) || !raw.sourceFiles.every((v: unknown) => typeof v === "string")) throw new Error("invalid generated build identity");
  return raw;
}

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/** Bind the actual installed Core JS build, not a protocol/version constant.
 * Only a fixed package resolution is used; no request-selected paths/modules.
 */
export async function coreBuildIdentity(): Promise<string> {
  const root = dirname(dirname(fileURLToPath(import.meta.resolve("@apicc/core/collaboration"))));
  const files: string[] = [];
  async function collect(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collect(path); else if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
    }
  }
  await collect(root);
  const hash = createHash("sha256");
  for (const path of files.sort()) { const name = relative(root, path).replaceAll("\\", "/"); const content = await readFile(path); hash.update(name); hash.update("\0"); hash.update(String(content.length)); hash.update("\0"); hash.update(content); }
  return hash.digest("hex");
}

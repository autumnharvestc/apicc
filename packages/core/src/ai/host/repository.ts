import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AiConfigDocumentSchema, createDefaultAiConfigDocument, type AiConfigDocument } from "../config.js";
import { AiProviderCatalogSchema } from "../catalog.js";

/** Fixed messages keep configuration and backend values out of error surfaces. */
export class AiConfigHostError extends Error {
  constructor(readonly code: string) { super(`AI personal configuration: ${code}`); this.name = "AiConfigHostError"; }
}
export interface AiProviderFile { file: string; document: unknown; readError?: "file-unreadable" | "directory-unreadable" }
export interface AiConfigRepository {
  read(): Promise<AiConfigDocument>;
  write(next: AiConfigDocument, expectedRevision: number): Promise<AiConfigDocument>;
  readProviderFiles(): Promise<AiProviderFile[]>;
  writeProviderFile(file: AiProviderFile): Promise<void>;
}
async function atomicWrite(directory: string, path: string, serialized: string): Promise<void> {
  const temporary = join(directory, `.config-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(serialized, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
  } catch { throw new AiConfigHostError("storage-failed"); }
  finally { await rm(temporary, { force: true }); }
}
export function createAiConfigRepository(options: { privateRoot: string }): AiConfigRepository {
  if (!options.privateRoot || !isAbsolute(options.privateRoot)) throw new AiConfigHostError("invalid-private-root");
  const privateRoot = resolve(options.privateRoot);
  const path = join(privateRoot, "config.v1.json");
  const lock = join(privateRoot, ".config.lock");
  function parse(value: unknown): AiConfigDocument {
    const result = AiConfigDocumentSchema.safeParse(value);
    if (!result.success) throw new AiConfigHostError("invalid-configuration");
    return result.data;
  }
  async function read(): Promise<AiConfigDocument> {
    let serialized: string;
    try { serialized = await readFile(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return createDefaultAiConfigDocument();
      throw new AiConfigHostError("storage-failed");
    }
    let value: unknown;
    try { value = JSON.parse(serialized); } catch { throw new AiConfigHostError("invalid-configuration"); }
    return parse(value);
  }
  return {
    read,
    async readProviderFiles() {
      const directory = join(privateRoot, "providers.d");
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        return [{ file: "", document: undefined, readError: "directory-unreadable" }];
      }
      return Promise.all(entries.filter(entry => entry.isFile() && entry.name.endsWith(".json")).sort((a, b) => a.name.localeCompare(b.name)).map(async entry => {
        let serialized: string;
        try { serialized = await readFile(join(directory, entry.name), "utf8"); }
        catch { return { file: entry.name, document: undefined, readError: "file-unreadable" as const }; }
        let document: unknown;
        try { document = JSON.parse(serialized); } catch { document = undefined; }
        return { file: entry.name, document };
      }));
    },
    async writeProviderFile(file) {
      const parsed = AiProviderCatalogSchema.safeParse(file.document);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(file.file) || !parsed.success) throw new AiConfigHostError("invalid-catalog");
      const directory = join(privateRoot, "providers.d");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await atomicWrite(directory, join(directory, file.file), JSON.stringify(parsed.data));
    },
    async write(next, expectedRevision) {
      const validated = parse(next);
      await mkdir(privateRoot, { recursive: true, mode: 0o700 });
      const deadline = Date.now() + 5000;
      while (true) {
        try { await mkdir(lock, { mode: 0o700 }); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw new AiConfigHostError("storage-locked");
          await delay(20);
        }
      }
      try {
        const current = await read();
        if (current.revision !== expectedRevision) throw new AiConfigHostError("revision-conflict");
        const saved = parse({ ...validated, revision: current.revision + 1 });
        await atomicWrite(privateRoot, path, JSON.stringify(saved));
        return saved;
      } finally {
        await rm(lock, { recursive: true });
      }
    },
  };
}

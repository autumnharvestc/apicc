import { randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export type AtomicReplace = (temporaryPath: string, targetPath: string) => Promise<void>;

/** Write beside the destination, then replace it in one rename so failures keep the old file intact. */
export async function atomicWriteFile(
  targetPath: string,
  content: string,
  replace: AtomicReplace = rename,
): Promise<void> {
  const target = resolve(targetPath);
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await replace(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

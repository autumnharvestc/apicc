import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, mkdirSync, writeFileSync, renameSync, unlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { SavedStressPlanSchema, type SavedStressPlan } from "@apicc/core";
import { StressPlanSaveInputSchema } from "../shared/types.js";
import { ProjectLocatorSchema, type ProjectLocator } from "../shared/locations.js";
export function stressScopeKey(root: string, scope: ProjectLocator): string {
  const parsed = ProjectLocatorSchema.parse(scope);
  return createHash("sha256").update(JSON.stringify([realpathSync(root), parsed.workspaceId, parsed.groupId, parsed.projectId])).digest("hex");
}
/** Atomic same-directory replace. A failed replace never deletes the old destination. */
export function atomicStressWrite(path: string, content: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" }); renameSync(temporary, path); }
  finally { try { unlinkSync(temporary); } catch { /* absent after success, or best-effort abandoned temp cleanup */ } }
}
export function createStressPlanRepository(root: string) {
  const directory = (scope: ProjectLocator) => join(root, ".apicc", "stress-plans", stressScopeKey(root, scope));
  const path = (scope: ProjectLocator, id: string) => join(directory(scope), `${z.string().uuid().parse(id)}.json`);
  function get(scope: ProjectLocator, id: string): SavedStressPlan | null {
    const file = path(scope, id);
    try { const saved = SavedStressPlanSchema.parse(JSON.parse(readFileSync(file, "utf8"))); return saved.id === id ? saved : null; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError || error instanceof z.ZodError) return null; throw error; }
  }
  return { get,
    list(scope: ProjectLocator): SavedStressPlan[] {
      const dir = directory(scope); let files: string[];
      try { files = readdirSync(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
      return files.filter((f) => f.endsWith(".json") && z.string().uuid().safeParse(f.slice(0, -5)).success).flatMap((f) => { const result = get(scope, f.slice(0, -5)); return result ? [result] : []; }).sort((a, b) => b.updatedAt - a.updatedAt);
    },
    save(scope: ProjectLocator, value: z.input<typeof StressPlanSaveInputSchema>): SavedStressPlan {
      const input = StressPlanSaveInputSchema.parse(value); const id = input.id ?? randomUUID();
      if (input.id && !get(scope, id)) throw new Error("Stress plan does not exist in this project");
      const saved = SavedStressPlanSchema.parse({ formatVersion: 1, id, name: input.name, updatedAt: Date.now(), plan: input.plan });
      mkdirSync(directory(scope), { recursive: true }); atomicStressWrite(path(scope, id), JSON.stringify(saved, null, 2)); return saved;
    },
    remove(scope: ProjectLocator, id: string): SavedStressPlan | null { const saved = get(scope, id); if (saved) unlinkSync(path(scope, id)); return saved; },
  };
}

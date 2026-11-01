import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { createDefaultAiConfigDocument } from "../../../src/ai/config.js";
import { createAiConfigRepository } from "../../../src/ai/host/repository.js";
const roots: string[] = [];
// Only the failure test replaces the final OS rename; all directory/file writes remain real.
vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
async function root() { const path = await mkdtemp(join(tmpdir(), "apicc-ai-t4-")); roots.push(path); return path; }
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
// Catches dropped fields, memory-only persistence, and caller-controlled document revision.
it("roundtrips a non-sensitive document through a fresh repository with a new revision", async () => {
  const privateRoot = await root();
  const next = createDefaultAiConfigDocument();
  next.application.purposeDefaults["case-suggestion"] = { candidateCount: 7 };
  const saved = await createAiConfigRepository({ privateRoot }).write(next, 1);
  expect(saved).toEqual({ ...next, revision: 2 });
  expect(await createAiConfigRepository({ privateRoot }).read()).toEqual(saved);
  expect(await readdir(privateRoot)).toEqual(["config.v1.json"]);
  expect(JSON.parse(await readFile(join(privateRoot, "config.v1.json"), "utf8"))).toEqual(saved);
});
// Catches an overwrite by a stale writer, including independent repository instances.
it("rejects an expectedRevision conflict and preserves the winning document", async () => {
  const privateRoot = await root();
  const b = createAiConfigRepository({ privateRoot });
  const saved = { ...createDefaultAiConfigDocument(), revision: 2 };
  await writeFile(join(privateRoot, "config.v1.json"), JSON.stringify(saved));
  await expect(b.write(createDefaultAiConfigDocument(), 1)).rejects.toMatchObject({ code: "revision-conflict" });
  expect(await b.read()).toEqual(saved);
});
// Catches racing independent instances both publishing a revision from the same base.
it("allows exactly one concurrent writer for an expected revision", async () => {
  const privateRoot = await root();
  const next = createDefaultAiConfigDocument();
  const results = await Promise.allSettled([
    createAiConfigRepository({ privateRoot }).write(next, 1),
    createAiConfigRepository({ privateRoot }).write(next, 1),
  ]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(r => r.status === "rejected")).toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: "revision-conflict" }) })]);
  expect((await createAiConfigRepository({ privateRoot }).read()).revision).toBe(2);
  expect(await readdir(privateRoot)).toEqual(["config.v1.json"]);
});
// Catches schema bypass or replacing a valid on-disk document with malformed input.
it("rejects a bad document without overwriting the good document or leaving temporary files", async () => {
  const privateRoot = await root();
  const saved = createDefaultAiConfigDocument();
  const path = join(privateRoot, "config.v1.json");
  await writeFile(path, JSON.stringify(saved));
  const repository = createAiConfigRepository({ privateRoot });
  await expect(repository.write({ ...saved, apiKey: "synthetic-secret" } as any, 1)).rejects.toMatchObject({ code: "invalid-configuration" });
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual(saved);
  expect(await readdir(privateRoot)).toEqual(["config.v1.json"]);
});
// Catches silently treating a corrupt existing config as an empty config and overwriting it.
it("reports corrupted persisted JSON and refuses to overwrite it", async () => {
  const privateRoot = await root();
  const path = join(privateRoot, "config.v1.json");
  await writeFile(path, "{broken");
  const repository = createAiConfigRepository({ privateRoot });
  await expect(repository.read()).rejects.toMatchObject({ code: "invalid-configuration" });
  expect(await readFile(path, "utf8")).toBe("{broken");
});
// Catches overwriting corrupt persisted state when write is called without a preceding read.
it("refuses to write over corrupted persisted JSON", async () => {
  const privateRoot = await root();
  const path = join(privateRoot, "config.v1.json");
  await writeFile(path, "{broken");
  const repository = createAiConfigRepository({ privateRoot });
  await expect(repository.write(createDefaultAiConfigDocument(), 1)).rejects.toMatchObject({ code: "invalid-configuration" });
  expect(await readFile(path, "utf8")).toBe("{broken");
});
// Catches creating files merely by reading or sharing a mutable factory object between callers.
it("reads fresh defaults without creating a file and returns independent documents", async () => {
  const privateRoot = await root();
  const repository = createAiConfigRepository({ privateRoot });
  const initial = await repository.read();
  expect(initial).toEqual(createDefaultAiConfigDocument());
  initial.connections.push({} as any);
  expect((await repository.read()).connections).toEqual([]);
  expect(await readdir(privateRoot)).toEqual([]);
});
// Catches implicit CWD storage when a host forgets to pass its private absolute root.
it.each(["", "relative/private-ai"])("rejects a nonabsolute privateRoot %j before touching disk", privateRoot => {
  expect(() => createAiConfigRepository({ privateRoot })).toThrowError(expect.objectContaining({ code: "invalid-private-root" }));
});
// Catches a failed final publication replacing good bytes, leaking errors, or leaving lock/temp files.
it("preserves the good document and releases temporary files when final atomic rename fails", async () => {
  const privateRoot = await root();
  const repository = createAiConfigRepository({ privateRoot });
  const saved = await repository.write(createDefaultAiConfigDocument(), 1);
  vi.mocked(rename).mockRejectedValueOnce(new Error("synthetic private IO detail"));
  await expect(repository.write({ ...saved, revision: 900 }, 2)).rejects.toMatchObject({ code: "storage-failed" });
  expect(await repository.read()).toEqual(saved);
  expect(await readdir(privateRoot)).toEqual(["config.v1.json"]);
  expect((await repository.write(saved, 2)).revision).toBe(3);
});
// Catches bypassing host validation by calling the exported repository directly.
it.each([
  { file: "../escape.json", document: { formatVersion: 1, providers: [] } },
  { file: "safe.json", document: { formatVersion: 1, providers: [{ script: "never" }] } },
])("refuses unsafe provider files through the repository: $file", async file => {
  const privateRoot = await root();
  await expect(createAiConfigRepository({ privateRoot }).writeProviderFile(file)).rejects.toMatchObject({ code: "invalid-catalog" });
  expect(await readdir(privateRoot)).toEqual([]);
});
// Built public entry regression: catches a lock implemented only by an in-process Map.
// Run core build before this artifact/process integration check.
it("enforces revision CAS between two independent Node processes using the public entry", async () => {
  const privateRoot = await root();
  const moduleUrl = new URL("../../../dist/index.js", import.meta.url).href;
  const program = `
    const core = await import(process.argv[2]);
    const repository = core.createAiConfigRepository({privateRoot:process.argv[1]});
    process.stdout.write('READY\\n');
    process.stdin.once('data', async () => {
      process.stdin.pause();
      try { const saved=await repository.write(core.createDefaultAiConfigDocument(),1); process.stdout.write(JSON.stringify({revision:saved.revision})+'\\n'); }
      catch(error) { process.stdout.write(JSON.stringify({code:error.code})+'\\n'); }
    });
  `;
  function launch() {
    const child = spawn(process.execPath, ["--input-type=module", "-e", program, privateRoot, moduleUrl], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "", error = "";
    let markReady!: () => void;
    const ready = new Promise<void>(resolveReady => { markReady = resolveReady; });
    child.stdout.on("data", data => { output += data; if (output.includes("READY\n")) markReady(); });
    child.stderr.on("data", data => { error += data; });
    const completed = new Promise<unknown>((resolveDone, rejectDone) => {
      child.on("error", rejectDone);
      child.on("close", code => {
        if (code !== 0) { rejectDone(new Error(`child failed: ${error}`)); return; }
        try { resolveDone(JSON.parse(output.trim().split("\n").at(-1)!)); } catch (failure) { rejectDone(failure); }
      });
    });
    return { child, ready: Promise.race([ready, completed.then(() => { throw new Error("child exited before ready"); })]), completed };
  }
  const a = launch(), b = launch();
  try {
    await Promise.all([a.ready, b.ready]);
    a.child.stdin.end("go\n"); b.child.stdin.end("go\n");
    expect(await Promise.all([a.completed, b.completed])).toEqual(expect.arrayContaining([{ revision: 2 }, { code: "revision-conflict" }]));
    expect(await readdir(privateRoot)).toEqual(["config.v1.json"]);
  } finally { a.child.kill(); b.child.kill(); }
});

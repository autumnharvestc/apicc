import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { ContractWorkspaceSchema } from "../../src/contract/workspace.js";
import { createProjectSnapshot } from "../../src/assets/snapshot.js";
import { encodeContractWorkspace, decodeContractWorkspace, validateManagedWorkspaceFilePath, validateSerializedWorkspaceFile } from "../../src/storage/contractFiles.js";
import { fileStorage } from "../../src/storage/fileStorage.js";
import { projectDirectoryPath, synchronizationContentFilePath } from "../../src/storage/paths.js";
import { calculateWorkspaceRevision, commitWritePlan } from "../../src/storage/writeJournal.js";
import { decodeSyncState, defaultSyncStorageLimits, encodeSyncContent, encodeSyncState, listSyncManagedFiles, loadSyncState, readSyncContent } from "../../src/sync/storage.js";
import type { SyncWorkspaceState } from "../../src/sync/state.js";
import { SyncIdentityMapSchema } from "../../src/sync/types.js";
import { workspaceFixture } from "../helpers/contractFixtures.js";
import { syncWireFixture } from "./wireFixtures.js";

const roots: string[] = [];
const workspace = () => ContractWorkspaceSchema.parse(workspaceFixture());
const location = { groupId: workspace().groups[0]!.id, projectId: workspace().groups[0]!.projects[0]!.id };
const base = projectDirectoryPath(location.groupId, location.projectId);
const statePath = `${base}/synchronization.yaml`;
function state(): SyncWorkspaceState {
  const f = syncWireFixture();
  return { formatVersion: 1, projectId: location.projectId, sources: [{ source: f.source, mapping: SyncIdentityMapSchema.parse(f.normalizeInput.mapping), baselineRevision: "0", baselineContent: null }], candidates: [], history: [], operations: [] };
}
async function root() { const value = await mkdtemp(join(tmpdir(), "apicc-sync-storage-")); roots.push(value); return value; }
async function seed() { const r = await root(); const saved = await fileStorage.save(r, workspace(), { expectedRevision: "empty", deletions: [] }); return { root: r, revision: saved.revision }; }
afterEach(async () => { for (const r of roots.splice(0)) { if (!resolve(r).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe cleanup"); await rm(r, { recursive: true, force: true }); } });

describe("strict independent synchronization persistence", () => {
  it("accepts exact content bytes at the serialized journal entry and rejects mismatched digests", () => {
    const content = encodeSyncContent([{ path: "project.yaml", content: "fixture" }]);
    const path = `${base}/synchronization/content/${content.reference.digest}.json`;
    expect(() => validateSerializedWorkspaceFile(path, content.text)).not.toThrow();
    expect(() => validateSerializedWorkspaceFile(path, content.text.replace("fixture", "changed"))).toThrow("SYNC_CONTENT_DIGEST_MISMATCH");
  });
  it("rejects over-budget serialized content before journal staging", () => {
    const text = "x".repeat(defaultSyncStorageLimits.maxContentBytes + 1);
    const digest = createHash("sha256").update(text).digest("hex");
    expect(() => validateSerializedWorkspaceFile(`${base}/synchronization/content/${digest}.json`, text)).toThrow("SYNC_CONTENT_DIGEST_MISMATCH");
  });
  it.each(["raw-object", "noncanonical"])("rejects new serialized %s content even with a matching hash", kind => {
    const text = kind === "raw-object" ? JSON.stringify({ rawText: "private source" }) : JSON.stringify([{ path: "project.yaml", content: "fixture" }], null, 2);
    const digest = createHash("sha256").update(text).digest("hex");
    expect(() => validateSerializedWorkspaceFile(`${base}/synchronization/content/${digest}.json`, text)).toThrow();
  });
  it("rejects conflicting byte metadata for the same content digest before deduplication", () => {
    const value = state(), original = value.sources[0]!;
    original.baselineContent = { digest: "a".repeat(64), bytes: 101, contentType: "application/vnd.apicc.sync-files+json" };
    const sourceId = "00000000-0000-4000-8000-000000000998";
    value.sources.push({ ...structuredClone(original), source: { ...original.source, id: sourceId }, mapping: { ...original.mapping, sourceId }, baselineContent: { ...original.baselineContent, bytes: 1 } });
    expect(() => decodeSyncState(JSON.stringify(value), location.projectId)).toThrow("SYNC_CONTENT_REFERENCE_MISMATCH");
  });
  it("encodes legal shared metadata without emitting forbidden YAML aliases", () => {
    const value = state(), original = value.sources[0]!, sourceId = "00000000-0000-4000-8000-000000000998";
    value.sources.push({ ...original, source: { ...original.source, id: sourceId }, mapping: { ...original.mapping, sourceId } });
    expect(() => encodeSyncState(value)).not.toThrow();
  });
  it("establishes a legal project, a callable encoder and the pinned runner", async () => {
    const f = await seed();
    expect((await fileStorage.load(f.root)).readOnly).toBe(false);
    expect(process.version).toBe("v22.19.0");
    expect(decodeSyncState(encodeSyncState(state()), location.projectId).projectId).toBe(location.projectId);
  });
  it("accepts the exact sidecar and content paths in the real managed registry", () => {
    expect(validateManagedWorkspaceFilePath(statePath)).toBe(statePath);
    expect(validateManagedWorkspaceFilePath(`${base}/synchronization/content/${"a".repeat(64)}.json`)).toContain("synchronization/content/");
  });
  it.each(["version", "unknown", "project", "duplicate-source", "source-mapping", "content-type", "reference-bytes", "state-budget", "aggregate-budget"])("rejects %s at the state boundary", kind => {
    const value = state() as any; let limits = defaultSyncStorageLimits;
    if (kind === "version") value.formatVersion = 2;
    if (kind === "unknown") value.privateRaw = "secret";
    if (kind === "project") value.projectId = "00000000-0000-4000-8000-000000000999";
    if (kind === "duplicate-source") value.sources.push(structuredClone(value.sources[0]));
    if (kind === "source-mapping") value.sources[0].mapping.sourceId = "00000000-0000-4000-8000-000000000999";
    if (kind === "content-type") value.sources[0].baselineContent = { digest: "a".repeat(64), bytes: 2, contentType: "text/plain" };
    if (kind === "reference-bytes") value.sources[0].baselineContent = { digest: "a".repeat(64), bytes: -1, contentType: "application/vnd.apicc.sync-files+json" };
    if (kind === "state-budget") limits = { ...limits, maxStateBytes: 10 };
    if (kind === "aggregate-budget") { value.sources[0].baselineContent = { digest: "a".repeat(64), bytes: 101, contentType: "application/vnd.apicc.sync-files+json" }; limits = { ...limits, maxTotalContentBytes: 100 }; }
    expect(() => decodeSyncState(stringify(value), location.projectId, limits)).toThrow();
  });
  it.each(["unknown", "duplicate", "escape", "private-path", "bytes", "unicode"])("rejects %s before storing normalized content", kind => {
    let files: any[] = [{ path: "project.yaml", content: "name: fixture" }]; let limits = defaultSyncStorageLimits;
    if (kind === "unknown") files[0].raw = "private";
    if (kind === "duplicate") files.push({ ...files[0] });
    if (kind === "escape") files[0].path = "../outside";
    if (kind === "private-path") files[0].path = "synchronization.yaml";
    if (kind === "bytes") limits = { ...limits, maxContentBytes: 10 };
    if (kind === "unicode") files[0].content = "\ud800";
    expect(() => encodeSyncContent(files, limits)).toThrow();
  });
  it.each(["digest", "bytes", "strict-files"])("checks selected content %s lazily", async kind => {
    const f = await seed(); const content = encodeSyncContent([{ path: "project.yaml", content: "fixture" }]);
    let text = content.text; const reference = { ...content.reference };
    if (kind === "digest") text = text.replace("fixture", "changed");
    if (kind === "bytes") reference.bytes += 1;
    if (kind === "strict-files") { text = JSON.stringify([{ path: "../escape", content: "fixture" }]); reference.digest = createHash("sha256").update(text).digest("hex"); reference.bytes = Buffer.byteLength(text); }
    const directory = join(f.root, base, "synchronization/content"); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${reference.digest}.json`), text);
    await expect(readSyncContent(f.root, location, reference)).rejects.toThrow();
  });
  it.each(["escaping-digest", "type", "negative-bytes", "oversize-ref"])("rejects a direct invalid %s reference before reading", async kind => {
    const f = await seed(); const reference: any = { digest: "a".repeat(64), bytes: 2, contentType: "application/vnd.apicc.sync-files+json" };
    if (kind === "escaping-digest") reference.digest = "../outside";
    if (kind === "type") reference.contentType = "text/plain";
    if (kind === "negative-bytes") reference.bytes = -1;
    if (kind === "oversize-ref") reference.bytes = defaultSyncStorageLimits.maxContentBytes + 1;
    const error = await readSyncContent(f.root, location, reference).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as NodeJS.ErrnoException).code).not.toBe("ENOENT");
  });
  // These cases were added after the first implementation patch. They are correctness
  // evidence for the explicitly reported order gap, never implementation-before RED.
  it.each(["utf8", "canonical-json"])("rejects selected %s bytes with a correct hash", async kind => {
    const f = await seed();
    const data = kind === "utf8" ? Buffer.from([0xff, 0xfe]) : Buffer.from(JSON.stringify([{ path: "project.yaml", content: "fixture" }], null, 2));
    const reference = { digest: createHash("sha256").update(data).digest("hex"), bytes: data.length, contentType: "application/vnd.apicc.sync-files+json" as const };
    await mkdir(join(f.root, base, "synchronization/content"), { recursive: true });
    await writeFile(join(f.root, base, "synchronization/content", `${reference.digest}.json`), data);
    await expect(readSyncContent(f.root, location, reference)).rejects.toThrow(kind === "utf8" ? /encoded data/ : "SYNC_CONTENT_NONCANONICAL");
  });
  it.each(["parent-file", "parent-junction", "final-directory"])("rejects a selected %s before consuming content", async kind => {
    const f = await seed(), external = await root(); const content = encodeSyncContent([{ path: "project.yaml", content: "fixture" }]);
    await mkdir(join(f.root, base, "synchronization"));
    const directory = join(f.root, base, "synchronization/content");
    if (kind === "parent-file") await writeFile(directory, "not a directory");
    if (kind === "parent-junction") { await writeFile(join(external, `${content.reference.digest}.json`), content.text); await symlink(external, directory, "junction"); }
    if (kind === "final-directory") await mkdir(join(directory, `${content.reference.digest}.json`), { recursive: true });
    await expect(readSyncContent(f.root, location, content.reference)).rejects.toThrow("SYNC_STORAGE_UNSAFE_PATH");
  });
  it("rejects direct encoder malformed state, YAML aliases, raw invalid Unicode and a per-ref byte excess", () => {
    expect(() => encodeSyncState({ ...state(), formatVersion: 2 } as any)).toThrow();
    const valueWithAlias = state(); const sourceId = valueWithAlias.sources[0]!.source.id;
    const aliasText = stringify(valueWithAlias).replace(`id: ${sourceId}`, `id: &sid ${sourceId}`).replace(`sourceId: ${sourceId}`, "sourceId: *sid");
    expect(() => decodeSyncState(aliasText, location.projectId)).toThrow(/alias/i);
    expect(() => decodeSyncState(`${stringify(state())}# \ud800`, location.projectId)).toThrow("SYNC_STORAGE_INVALID_UNICODE");
    const value = state(); value.sources[0]!.baselineContent = { digest: "a".repeat(64), bytes: 101, contentType: "application/vnd.apicc.sync-files+json" };
    expect(() => decodeSyncState(stringify(value), location.projectId, { ...defaultSyncStorageLimits, maxContentBytes: 100 })).toThrow("SYNC_STORAGE_BYTES_EXCEEDED");
    expect(() => synchronizationContentFilePath(location, "../escape")).toThrow();
  });
  it("loads only an existing bounded state and lists no payloads for an absent content directory", async () => {
    const f = await seed(); expect(await loadSyncState(f.root, location)).toBeNull(); expect(await listSyncManagedFiles(f.root, location)).toEqual([]);
    await writeFile(join(f.root, statePath), encodeSyncState(state()));
    expect((await loadSyncState(f.root, location))?.projectId).toBe(location.projectId);
    expect(await listSyncManagedFiles(f.root, location)).toEqual([statePath]);
    await expect(loadSyncState(f.root, location, { ...defaultSyncStorageLimits, maxStateBytes: 10 })).rejects.toThrow("SYNC_STORAGE_BYTES_EXCEEDED");
  });
  it("loads valid sidecars separately, preserves them on ordinary save, and advances only storage CAS", async () => {
    const f = await seed(); const business = createProjectSnapshot(workspace().groups[0]!.projects[0]!).definitionRevision;
    const saved = await commitWritePlan(f.root, { files: new Map([[statePath, encodeSyncState(state())]]) }, { expectedRevision: f.revision, deletions: [] });
    const loaded = await fileStorage.load(f.root); expect(loaded.readOnly).toBe(false); expect(loaded.problems).toEqual([]);
    expect(createProjectSnapshot(loaded.workspace.groups[0]!.projects[0]!).definitionRevision).toBe(business);
    expect(saved.revision).not.toBe(f.revision);
    const text = await readFile(join(f.root, statePath), "utf8");
    await fileStorage.save(f.root, loaded.workspace, { expectedRevision: saved.revision, deletions: [] });
    expect(await readFile(join(f.root, statePath), "utf8")).toBe(text);
    expect([...encodeContractWorkspace(loaded.workspace).files.keys()].some(p => p.includes("synchronization"))).toBe(false);
  });
  it("marks malformed sync state read-only and refuses an ordinary overwrite", async () => {
    const f = await seed(); await writeFile(join(f.root, statePath), stringify({ ...state(), formatVersion: 99 }));
    const loaded = await decodeContractWorkspace(f.root); expect(loaded.readOnly).toBe(true);
    expect(loaded.problems.some(p => p.file === statePath)).toBe(true);
    await expect(fileStorage.save(f.root, workspace(), { expectedRevision: await calculateWorkspaceRevision(f.root), deletions: [] })).rejects.toThrow();
  });
  it("removes the deleted project's sidecar in the same ordinary save", async () => {
    const f = await seed(); await writeFile(join(f.root, statePath), encodeSyncState(state()));
    const next = workspace(); next.groups[0]!.projects = [];
    const oldFiles = [...encodeContractWorkspace(workspace()).files.keys()].filter(p => p.startsWith(`${base}/`));
    await fileStorage.save(f.root, next, { expectedRevision: await calculateWorkspaceRevision(f.root), deletions: oldFiles });
    await expect(readFile(join(f.root, statePath))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fileStorage.load(f.root)).readOnly).toBe(false);
  });
  it("validates referenced file availability without deserializing historical contents", async () => {
    const f = await seed(); const text = "this is deliberately not JSON";
    const reference = { digest: createHash("sha256").update(text).digest("hex"), bytes: Buffer.byteLength(text), contentType: "application/vnd.apicc.sync-files+json" as const };
    const value = state(); value.sources[0]!.baselineContent = reference;
    await writeFile(join(f.root, statePath), encodeSyncState(value));
    const missing = await fileStorage.load(f.root);
    expect(missing.problems.some(p => p.message.includes("SYNC_CONTENT_MISSING"))).toBe(true);
    await mkdir(join(f.root, base, "synchronization/content"), { recursive: true }); await writeFile(join(f.root, base, "synchronization/content", `${reference.digest}.json`), text);
    expect((await fileStorage.load(f.root)).readOnly).toBe(false);
    await expect(readSyncContent(f.root, location, reference)).rejects.toThrow();
  });
  it.each(["orphan", "reference-size"])("diagnoses %s sync content at the real loader boundary", async kind => {
    const f = await seed(); const content = encodeSyncContent([{ path: "project.yaml", content: "fixture" }]);
    await mkdir(join(f.root, base, "synchronization/content"), { recursive: true });
    await writeFile(join(f.root, base, "synchronization/content", `${content.reference.digest}.json`), content.text);
    if (kind === "reference-size") { const value = state(); value.sources[0]!.baselineContent = { ...content.reference, bytes: content.reference.bytes + 1 }; await writeFile(join(f.root, statePath), encodeSyncState(value)); }
    const loaded = await fileStorage.load(f.root);
    expect(loaded.problems.some(p => p.file === statePath && p.message.includes(kind === "orphan" ? "SYNC_STATE_MISSING" : "SYNC_CONTENT_BYTES_MISMATCH"))).toBe(true);
  });
  it.each(["name", "type"])("rejects a real managed-list invalid content %s", async kind => {
    const f = await seed(); await writeFile(join(f.root, statePath), encodeSyncState(state()));
    await mkdir(join(f.root, base, "synchronization/content"), { recursive: true });
    if (kind === "name") await writeFile(join(f.root, base, "synchronization/content/private-key.pem"), "owned fixture");
    else await mkdir(join(f.root, base, "synchronization/content", `${"a".repeat(64)}.json`));
    await expect(listSyncManagedFiles(f.root, location)).rejects.toThrow();
  });
  it("rolls back assets and sidecar together after a real mid-write fault", async () => {
    const f = await seed(); const changed = workspace(); changed.name = "Changed";
    const plan = encodeContractWorkspace(changed); plan.files.set(statePath, encodeSyncState(state()));
    let injected = false;
    await expect(commitWritePlan(f.root, plan, { expectedRevision: f.revision, deletions: [], faultInjector(stage, path) { if (stage === "after-replace" && path === statePath) { injected = true; throw new Error("synthetic write fault"); } } })).rejects.toThrow("Workspace write failed; no success was recorded.");
    expect(injected).toBe(true); const loaded = await fileStorage.load(f.root); expect(loaded.workspace.name).toBe(workspace().name); expect(loaded.revision).toBe(f.revision);
  });
});
